/**
 * 模块 H：断点续跑与任务编排 —— 执行引擎。
 *
 * - PipelineEngine：按依赖关系（串行/并行/条件分支）执行流水线步骤，
 *   每步完成即持久化中间结果（H2）；失败步骤按错误类别差异化自动重试
 *   （non-retryable 立即放弃 / rate-limit 长退避 / 瞬态短退避，
 *   指数退避 + 全抖动）；断路器熔断期间自动扣住该模型的步骤，
 *   冷却后半开探针自愈；主模型失败可降级 fallbackModel 补跑（自愈执行）；
 *   跨层调度：上游完成即刻释放下游（不等整层），信号量限制并发防配额风暴；
 *   超时自动暂停并通知；resume 从最后成功步骤继续（已完成步骤直接复用输出）；
 * - QueueWorker：批量任务队列（H3），按优先级 + 截止时间排序逐个执行，
 *   断路器熔断的模型自动让位给其他模型的排队任务；
 * - CronTicker：分钟级扫描定时任务（H4），峰谷感知（offPeakOnly 时
 *   仅空闲时段触发），熔断模型顺延到下个扫描周期，执行结果归档。
 *
 * 所有定时器随 Cordis fiber 卸载清理；执行中的调用经 AbortController 可取消。
 */
import type { Context } from '@deepseek-ai/cordis'
import { isPeakTime } from '../../core/time.js'
import { nextCronFire, parseCron } from './cron.js'
import { backoffDelay, CircuitBreaker, classifyError, stepModelPeek } from './selfheal.js'
import type { PipelineRunStore, QueueTaskStore, ScheduledJobStore, ScheduledRunStore } from './store.js'
import type {
  Pipeline,
  PipelineRun,
  PipelineStep,
  QueueTask,
  ScheduledJob,
  StepRun,
} from './types.js'

/** 引擎依赖的调用接口（由 index.ts 注入，解耦 DeepSeek 调用细节）。 */
export interface EngineCall {
  (params: { prompt: string; model: string; timeoutMs: number; source: string }): Promise<{
    content: string
    tokens: number
  }>
}

/** 生成短 id。 */
export function shortId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 校验流水线定义（步骤 id 唯一、依赖存在、无循环）。 */
export function validatePipeline(pipeline: Pipeline): string | undefined {
  if (pipeline.steps.length === 0) return '流水线至少需要一个步骤'
  const ids = new Set<string>()
  for (const step of pipeline.steps) {
    if (!step.id || !step.name) return '每个步骤必须有 id 和名称'
    if (ids.has(step.id)) return `步骤 id 重复：${step.id}`
    ids.add(step.id)
  }
  for (const step of pipeline.steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) return `步骤 ${step.name} 依赖了不存在的步骤：${dep}`
      if (dep === step.id) return `步骤 ${step.name} 不能依赖自身`
    }
  }
  // 循环检测（拓扑排序）。
  const indegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()
  for (const step of pipeline.steps) {
    indegree.set(step.id, step.dependsOn.length)
    adjacency.set(step.id, [])
  }
  for (const step of pipeline.steps) {
    for (const dep of step.dependsOn) adjacency.get(dep)?.push(step.id)
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift() as string
    visited += 1
    for (const next of adjacency.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1
      indegree.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  if (visited < pipeline.steps.length) return '步骤依赖存在循环'
  return undefined
}

/** 生成 YAML 配置（H1：流程图 → YAML）。 */
export function pipelineToYaml(pipeline: Pipeline): string {
  const lines: string[] = [
    `# 流水线：${pipeline.name}`,
    `id: ${pipeline.id}`,
    `name: ${JSON.stringify(pipeline.name)}`,
    'steps:',
  ]
  for (const step of pipeline.steps) {
    lines.push(`  - id: ${step.id}`)
    lines.push(`    name: ${JSON.stringify(step.name)}`)
    lines.push(`    model: ${step.model}`)
    lines.push(`    prompt: ${JSON.stringify(step.prompt)}`)
    lines.push(`    inputFrom: ${step.inputFrom}`)
    if (step.inputFrom === 'literal') lines.push(`    input: ${JSON.stringify(step.input)}`)
    if (step.condition) lines.push(`    condition: ${JSON.stringify(step.condition)}`)
    if (step.timeoutMs > 0) lines.push(`    timeoutMs: ${step.timeoutMs}`)
    if (step.maxRetries > 0) {
      lines.push(`    retry:`)
      lines.push(`      maxRetries: ${step.maxRetries}`)
      lines.push(`      intervalMs: ${step.retryIntervalMs}`)
    }
    if (step.fallbackModel) lines.push(`    fallbackModel: ${step.fallbackModel}`)
    if (step.dependsOn.length > 0) {
      lines.push(`    dependsOn: [${step.dependsOn.join(', ')}]`)
    }
  }
  return lines.join('\n')
}

/** 同一执行内并行步骤上限（信号量，防配额风暴）。 */
const MAX_PARALLEL_STEPS = 4

/** 全部剩余步骤被断路器扣住时的最长等待：超过后失败收场（可断点恢复）。 */
const MAX_CIRCUIT_WAIT_MS = 10 * 60_000

/** 流水线执行引擎。 */
export class PipelineEngine {
  /** runId → 中止控制器。 */
  private readonly aborts = new Map<string, AbortController>()
  /** runId → 暂停请求标记。 */
  private readonly pauseRequests = new Set<string>()
  /** runId → 首次因断路器完全停滞的时间（超时上限用）。 */
  private readonly blockedSince = new Map<string, number>()
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly runs: PipelineRunStore,
    private readonly call: EngineCall,
    private readonly defaultTimeoutMs: number,
    /** 模型断路器（与队列/定时调度共享同一实例）。 */
    readonly breaker: CircuitBreaker = new CircuitBreaker(),
  ) {}

  /** 释放：中止全部执行中的流水线。 */
  dispose(): void {
    this.disposed = true
    for (const controller of this.aborts.values()) controller.abort()
    this.aborts.clear()
    this.pauseRequests.clear()
  }

  /**
   * 启动执行并立即返回执行记录（后台异步推进，进度经 runs 仓库轮询）。
   * resumeRun 非空时为断点恢复：已完成步骤直接复用输出，不重跑。
   */
  start(pipeline: Pipeline, resumeRun?: PipelineRun): PipelineRun {
    const run: PipelineRun = resumeRun ?? {
      id: shortId('run'),
      pipelineId: pipeline.id,
      status: 'running',
      startedAt: Date.now(),
      endedAt: 0,
      steps: Object.fromEntries(
        pipeline.steps.map((step) => [
          step.id,
          {
            stepId: step.id,
            status: 'pending',
            attempts: 0,
            output: '',
            error: '',
            startedAt: 0,
            endedAt: 0,
            latencyMs: 0,
            tokens: 0,
            usedFallback: false,
          } satisfies StepRun,
        ]),
      ),
      message: '',
    }
    // 断点恢复：running 状态的中断步骤回到 pending 重跑；
    // done/skipped 步骤保留输出（H2：从最后成功的步骤继续）。
    for (const record of Object.values(run.steps)) {
      if (record.status === 'running') {
        record.status = 'pending'
        record.startedAt = 0
      }
    }
    run.status = 'running'
    run.message = ''
    void this.runs.put(run).catch(() => undefined)

    const controller = new AbortController()
    this.aborts.set(run.id, controller)
    void (async () => {
      try {
        await this.runLoop(pipeline, run, controller.signal)
      } catch (error) {
        run.status = 'failed'
        run.endedAt = Date.now()
        run.message = error instanceof Error ? error.message : String(error)
      } finally {
        this.aborts.delete(run.id)
        this.pauseRequests.delete(run.id)
        this.blockedSince.delete(run.id)
        await this.runs.put(run).catch(() => undefined)
        this.notifyFinished(pipeline, run)
      }
    })()
    return run
  }

  /** 执行结束通知（best-effort）。 */
  private notifyFinished(pipeline: Pipeline, run: PipelineRun): void {
    try {
      if (run.status === 'done') {
        this.ctx.companion.notice('success', `流水线「${pipeline.name}」执行完成`)
      } else if (run.status === 'failed') {
        this.ctx.companion.notice('error', `流水线「${pipeline.name}」执行失败：${run.message}`)
      }
    } catch {
      // 通知失败静默。
    }
  }

  /** 请求暂停（当前步骤完成后生效）。 */
  requestPause(runId: string): boolean {
    if (!this.aborts.has(runId)) return false
    this.pauseRequests.add(runId)
    return true
  }

  /** 取消执行。 */
  cancel(runId: string): boolean {
    const controller = this.aborts.get(runId)
    if (!controller) return false
    controller.abort()
    return true
  }

  /**
   * 主循环：跨层数据流调度。
   * 就绪步骤（依赖完成且模型未被熔断）立刻启动（不等待同层其他步骤），
   * 信号量限制并发；被断路器扣住的步骤等待冷却后半开探针自愈。
   */
  private async runLoop(pipeline: Pipeline, run: PipelineRun, signal: AbortSignal): Promise<void> {
    /** 运行中的 detached 步骤数（信号量计数）。 */
    let inflight = 0
    /** 已启动过的步骤（防“启动→状态翻转”异步窗口内重复启动）。 */
    const launched = new Set<string>()

    for (;;) {
      if (signal.aborted) {
        run.status = 'cancelled'
        run.endedAt = Date.now()
        run.message = '已取消'
        return
      }
      if (this.pauseRequests.has(run.id)) {
        run.status = 'paused'
        run.endedAt = Date.now()
        run.message = '已暂停（可从断点恢复）'
        this.ctx.companion.notice('info', `流水线「${pipeline.name}」已暂停，可从断点恢复`)
        return
      }

      // 统计步骤状态并挑选本轮可启动的步骤。
      const ready: PipelineStep[] = []
      let inflightSteps = false
      let hasFailure = false
      let pendingCount = 0
      let blockedCount = 0
      for (const step of pipeline.steps) {
        const record = run.steps[step.id]
        if (!record) continue
        if (record.status === 'running') inflightSteps = true
        if (record.status === 'failed') hasFailure = true
        if (record.status !== 'pending') continue
        if (launched.has(step.id)) continue
        pendingCount += 1
        const depsReady = step.dependsOn.every((dep) => {
          const depRecord = run.steps[dep]
          return depRecord && (depRecord.status === 'done' || depRecord.status === 'skipped')
        })
        if (!depsReady) continue
        // 断路器：主模型与降级模型都被熔断 → 扣住等待冷却。
        if (!stepModelPeek(this.breaker, step)) {
          blockedCount += 1
          continue
        }
        // 信号量：并发已满 → 剩余就绪步骤下轮再取。
        if (inflight + ready.length >= MAX_PARALLEL_STEPS) continue
        ready.push(step)
      }

      if (hasFailure) {
        run.status = 'failed'
        run.endedAt = Date.now()
        run.message = '存在失败步骤（可修复后从断点恢复）'
        return
      }
      if (pendingCount === 0 && !inflightSteps && inflight === 0) {
        // 无待办也无运行中步骤：全部完成。
        run.status = 'done'
        run.endedAt = Date.now()
        return
      }

      // 启动就绪步骤（detached：完成即刻释放下游，不阻塞本轮循环）。
      for (const step of ready) {
        launched.add(step.id)
        inflight += 1
        void this.runStep(pipeline, run, step, signal)
          .catch(() => undefined)
          .finally(() => {
            inflight -= 1
          })
      }

      // 全部剩余步骤被断路器扣住：等待冷却（半开探针），超上限则失败收场。
      if (blockedCount > 0 && !inflightSteps && inflight === 0 && ready.length === 0) {
        if (!this.blockedSince.has(run.id)) this.blockedSince.set(run.id, Date.now())
        const waited = Date.now() - (this.blockedSince.get(run.id) ?? Date.now())
        if (waited > MAX_CIRCUIT_WAIT_MS) {
          run.status = 'failed'
          run.endedAt = Date.now()
          run.message = `模型断路器持续熔断超过 ${Math.round(MAX_CIRCUIT_WAIT_MS / 60_000)} 分钟，已停止等待（可从断点恢复）`
          return
        }
      } else {
        this.blockedSince.delete(run.id)
      }

      await sleep(200)
    }
  }

  /**
   * 执行单个步骤（含条件分支、超时、差异化重试、自愈降级）。
   *
   * 重试策略按错误类别区分：
   * - non-retryable（鉴权/预算/参数/安全策略）：立即放弃主模型，不烧配额；
   * - rate-limit：长退避（指数退避 + 全抖动，防重试风暴）；
   * - timeout / transient：标准退避。
   * 主模型耗尽后若配置了 fallbackModel 且其未被熔断，自动降级补跑一次。
   */
  private async runStep(
    pipeline: Pipeline,
    run: PipelineRun,
    step: PipelineStep,
    signal: AbortSignal,
  ): Promise<void> {
    const record = run.steps[step.id]
    if (!record) return

    // 条件分支：依赖输出拼接不包含条件子串 → 跳过。
    if (step.condition) {
      const upstream = step.dependsOn
        .map((dep) => run.steps[dep]?.output ?? '')
        .join('\n')
      if (!upstream.includes(step.condition)) {
        record.status = 'skipped'
        record.endedAt = Date.now()
        await this.runs.put(run)
        return
      }
    }

    // 组装输入：prev=上游输出拼接；literal=固定输入。
    const input =
      step.inputFrom === 'literal'
        ? step.input
        : step.dependsOn.map((dep) => run.steps[dep]?.output ?? '').join('\n')
    const prompt = step.prompt
      ? `${step.prompt}\n\n${input}`.trim()
      : input

    // 断路器准入：主模型被熔断时若降级模型可用则直接走降级；均被熔断则
    // 回到 pending 等待冷却（调度循环会持续重试）。
    const primaryAdmitted = this.breaker.admit(step.model)
    const fallbackModel =
      step.fallbackModel && step.fallbackModel !== step.model ? step.fallbackModel : ''
    if (!primaryAdmitted && !fallbackModel) {
      record.status = 'pending'
      record.startedAt = 0
      await this.runs.put(run)
      return
    }

    record.status = 'running'
    record.startedAt = Date.now()
    await this.runs.put(run)

    const timeoutMs = step.timeoutMs > 0 ? step.timeoutMs : this.defaultTimeoutMs
    const maxAttempts = Math.max(1, step.maxRetries + 1)
    let lastError = ''

    // ---- 主模型尝试（差异化重试） ----
    if (primaryAdmitted) {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (signal.aborted || run.status !== 'running') {
          record.status = 'pending'
          record.startedAt = 0
          await this.runs.put(run)
          return
        }
        record.attempts = attempt
        try {
          const result = await withTimeout(
            this.call({ prompt, model: step.model, timeoutMs, source: 'orchestrator' }),
            timeoutMs,
            `步骤「${step.name}」执行超时（${Math.round(timeoutMs / 1000)}s）`,
          )
          this.breaker.recordSuccess(step.model)
          record.status = 'done'
          record.output = result.content
          record.error = ''
          record.endedAt = Date.now()
          record.latencyMs = record.endedAt - record.startedAt
          record.tokens = result.tokens
          await this.runs.put(run)
          return
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          const errorClass = classifyError(lastError)
          this.breaker.recordFailure(step.model)
          if (errorClass === 'non-retryable') break
          // 限流类退避基数放大（重试风暴治理），其余用步骤配置的间隔。
          const baseMs =
            errorClass === 'rate-limit'
              ? Math.max(step.retryIntervalMs * 2, 10_000)
              : step.retryIntervalMs
          if (attempt < maxAttempts) await sleep(backoffDelay(attempt, baseMs, 30_000))
        }
      }
    }

    // ---- 自愈降级：fallback 模型补跑一次 ----
    if (fallbackModel && this.breaker.admit(fallbackModel)) {
      record.usedFallback = true
      record.attempts += 1
      try {
        const result = await withTimeout(
          this.call({ prompt, model: fallbackModel, timeoutMs, source: 'orchestrator' }),
          timeoutMs,
          `步骤「${step.name}」降级模型执行超时（${Math.round(timeoutMs / 1000)}s）`,
        )
        this.breaker.recordSuccess(fallbackModel)
        record.status = 'done'
        record.output = result.content
        record.error = primaryAdmitted
          ? `主模型 ${step.model} 失败（${lastError}），已由降级模型 ${fallbackModel} 完成`
          : `主模型 ${step.model} 被熔断，已由降级模型 ${fallbackModel} 完成`
        record.endedAt = Date.now()
        record.latencyMs = record.endedAt - record.startedAt
        record.tokens = result.tokens
        await this.runs.put(run)
        this.ctx.companion.notice(
          'info',
          `流水线「${pipeline.name}」步骤「${step.name}」已自愈降级至 ${fallbackModel}`,
        )
        return
      } catch (error) {
        const fallbackError = error instanceof Error ? error.message : String(error)
        this.breaker.recordFailure(fallbackModel)
        lastError = `主模型 ${step.model}：${lastError}；降级模型 ${fallbackModel}：${fallbackError}`
      }
    } else if (fallbackModel && lastError === '') {
      // 主模型被熔断、降级模型也暂不可用 → 等待下一轮。
      record.status = 'pending'
      record.startedAt = 0
      record.usedFallback = false
      record.attempts = 0
      await this.runs.put(run)
      return
    }

    record.status = 'failed'
    record.error = lastError || `主模型 ${step.model} 被断路器熔断且无降级模型`
    record.endedAt = Date.now()
    record.latencyMs = record.endedAt - record.startedAt
    await this.runs.put(run)
    // 超时自动暂停并通知（H2 需求）。
    if (/超时|timeout/i.test(lastError)) {
      this.requestPause(run.id)
      this.ctx.companion.notice('warning', `流水线「${pipeline.name}」步骤「${step.name}」超时，已自动暂停`)
    }
  }
}

/** 队列工作器（H3）。 */
export class QueueWorker {
  private draining = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  /** taskId → 中止控制器。 */
  private readonly aborts = new Map<string, AbortController>()

  constructor(
    private readonly ctx: Context,
    private readonly tasks: QueueTaskStore,
    private readonly call: EngineCall,
    private readonly defaultTimeoutMs: number,
    /** 模型断路器（与流水线/定时调度共享同一实例）。 */
    private readonly breaker: CircuitBreaker = new CircuitBreaker(),
  ) {}

  /** 启动周期扫描（每 3 秒检查一次待执行任务）。 */
  start(): void {
    const tick = (): void => {
      if (this.disposed) return
      void this.drain().catch(() => undefined)
      this.timer = setTimeout(tick, 3_000)
      this.timer.unref?.()
    }
    tick()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    for (const controller of this.aborts.values()) controller.abort()
    this.aborts.clear()
  }

  /** 取消单个任务。 */
  cancel(taskId: string): boolean {
    const controller = this.aborts.get(taskId)
    if (controller) {
      controller.abort()
      return true
    }
    return false
  }

  /**
   * 取出下一个待执行任务：优先级 high>medium>low，同级按截止时间早者优先，再按创建时间。
   * 断路器熔断的模型自动跳过（其任务让位给其他模型的排队任务，冷却后自动回来）。
   */
  private nextQueued(): QueueTask | undefined {
    const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 }
    // 单次线性扫描选最优（O(n)），避免每次出队都对全队列排序（O(n log n)）。
    let best: QueueTask | undefined
    for (const task of this.tasks.list()) {
      if (task.status !== 'queued') continue
      // 断路器纯查询（peek）：熔断中的模型本周期跳过。
      if (!this.breaker.peek(task.model)) continue
      if (!best) {
        best = task
        continue
      }
      const p = (priorityRank[task.priority] ?? 3) - (priorityRank[best.priority] ?? 3)
      if (p < 0) {
        best = task
        continue
      }
      if (p > 0) continue
      const da = task.deadline || Number.MAX_SAFE_INTEGER
      const db = best.deadline || Number.MAX_SAFE_INTEGER
      if (da < db || (da === db && task.createdAt < best.createdAt)) best = task
    }
    return best
  }

  /** 逐个执行排队任务（单并发，避免刷爆配额）。 */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (;;) {
        if (this.disposed) return
        const task = this.nextQueued()
        if (!task) return
        // 截止时间已过：直接标记失败。
        if (task.deadline > 0 && Date.now() > task.deadline) {
          task.status = 'failed'
          task.error = '已超过截止时间，未执行'
          task.finishedAt = Date.now()
          await this.tasks.put(task)
          continue
        }
        await this.executeTask(task)
      }
    } finally {
      this.draining = false
    }
  }

  /** 执行单个队列任务（含断路器准入、失败策略）。 */
  private async executeTask(task: QueueTask): Promise<void> {
    // 断路器准入（带副作用）：抢不到名额说明被探针/熔断拦下，回到队尾等下轮。
    if (!this.breaker.admit(task.model)) {
      task.status = 'queued'
      await this.tasks.put(task)
      return
    }
    task.status = 'running'
    await this.tasks.put(task)
    const controller = new AbortController()
    this.aborts.set(task.id, controller)
    try {
      const result = await this.call({
        prompt: task.prompt,
        model: task.model,
        timeoutMs: this.defaultTimeoutMs,
        source: 'orchestrator-queue',
      })
      this.breaker.recordSuccess(task.model)
      task.status = 'done'
      task.output = result.content
      task.error = ''
      task.finishedAt = Date.now()
      task.attempts += 1
      await this.tasks.put(task)
    } catch (error) {
      this.aborts.delete(task.id)
      task.attempts += 1
      const message = error instanceof Error ? error.message : String(error)
      this.breaker.recordFailure(task.model)
      if (controller.signal.aborted) {
        task.status = 'cancelled'
        task.error = '已取消'
        task.finishedAt = Date.now()
        await this.tasks.put(task)
        return
      }
      // 不可重试错误（鉴权/预算/参数）：不再回到队列，直接失败收场。
      if (task.failurePolicy === 'retry' && task.attempts < 3 && classifyError(message) !== 'non-retryable') {
        // 重试策略：回到队列（最多 3 次尝试；断路器熔断时下轮自动跳过）。
        task.status = 'queued'
        task.error = message
        await this.tasks.put(task)
        return
      }
      task.status = 'failed'
      task.error = message
      task.finishedAt = Date.now()
      await this.tasks.put(task)
      if (task.failurePolicy === 'notify') {
        this.ctx.companion.notice('error', `队列任务「${task.name}」执行失败：${message}`)
      }
    } finally {
      this.aborts.delete(task.id)
    }
  }
}

/** 定时调度器（H4）：分钟级扫描 + 峰谷感知。 */
export class CronTicker {
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false
  /** 防止同一分钟内重复触发。 */
  private lastTickMinute = 0

  constructor(
    private readonly ctx: Context,
    private readonly jobs: ScheduledJobStore,
    private readonly jobRuns: ScheduledRunStore,
    private readonly call: EngineCall,
    private readonly defaultTimeoutMs: number,
    /** 模型断路器（与流水线/队列共享同一实例）。 */
    private readonly breaker: CircuitBreaker = new CircuitBreaker(),
  ) {}

  /** 启动分钟级扫描；同时重算全部任务的下次触发时刻。 */
  start(): void {
    for (const job of this.jobs.list()) {
      if (job.enabled) {
        this.reschedule(job)
        void this.jobs.put(job).catch(() => undefined)
      }
    }
    this.timer = setInterval(() => void this.tick().catch(() => undefined), 30_000)
    this.timer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
  }

  /** 重算下次触发时刻。 */
  reschedule(job: ScheduledJob): void {
    try {
      const cron = parseCron(job.cron)
      job.nextRunAt = nextCronFire(cron, Date.now()) ?? 0
    } catch {
      job.nextRunAt = 0
    }
  }

  /** 扫描到期任务。 */
  private async tick(): Promise<void> {
    if (this.disposed) return
    const now = Date.now()
    const minuteKey = Math.floor(now / 60_000)
    if (minuteKey === this.lastTickMinute) return
    this.lastTickMinute = minuteKey

    for (const job of this.jobs.list()) {
      if (!job.enabled || job.nextRunAt <= 0 || now < job.nextRunAt) continue
      // 峰谷感知：仅空闲时段执行（高峰时刻顺延到下一分钟重试）。
      if (job.offPeakOnly && isPeakTime(now)) continue
      // 断路器：模型熔断期间顺延（不重排 nextRunAt，下个周期自动重试）。
      if (!this.breaker.peek(job.model)) continue
      // 先重排下次触发，再执行本次（执行耗时不影响调度）。
      this.reschedule(job)
      job.lastRunAt = now
      await this.jobs.put(job).catch(() => undefined)
      void this.executeJob(job).catch(() => undefined)
    }
  }

  /** 执行定时任务并归档。 */
  private async executeJob(job: ScheduledJob): Promise<void> {
    const startedAt = Date.now()
    let ok = false
    let output = ''
    let error = ''
    // 断路器准入：抢不到探针名额则本次跳过（下个触发周期再来）。
    if (!this.breaker.admit(job.model)) return
    try {
      const result = await this.call({
        prompt: job.prompt,
        model: job.model,
        timeoutMs: this.defaultTimeoutMs,
        source: 'orchestrator-cron',
      })
      this.breaker.recordSuccess(job.model)
      ok = true
      output = result.content
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      this.breaker.recordFailure(job.model)
      this.ctx.companion.notice('warning', `定时任务「${job.name}」执行失败：${error}`)
    }
    await this.jobRuns
      .put({
        id: shortId('cronrun'),
        jobId: job.id,
        ts: startedAt,
        ok,
        output: output.slice(0, 4_000),
        error,
        latencyMs: Date.now() - startedAt,
      })
      .catch(() => undefined)
  }
}

/** Promise 超时包装。 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** 延时。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
