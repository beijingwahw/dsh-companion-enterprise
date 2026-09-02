/**
 * 模块 H 创新扩展：关键路径法与资源争用分析（Critical Path Method, CPM）。
 *
 * DAG 规划回答「依赖是否合法、能分几层」；蒙特卡洛回答「工期的不确定
 * 分布」。但项目经理的三个经典追问需要 1959 年 Kelley & Walker 为
 * DuPont 发明的关键路径法（现代项目管理的方法论起点，PMI 体系的
 * 基石）来回答：
 * 1. 总工期由哪条依赖链决定？——关键路径：松弛（slack）为 0 的步骤
 *    链，链上任何一步延误一毫秒，交付就延误一毫秒；
 * 2. 哪些步骤有富余？——slack = 最晚开始 − 最早开始：非关键步骤的
 *    可推迟余量，是资源腾挪的安全空间；
 * 3. 并行能省多少？——Σ 单步工期 − 关键路径长度 = 并行化收益
 *    （理想无界并行下）；同时用 [ES, EF] 窗口扫描并发峰值，
 *    提示「省下的时间要用并发度换」的资源争用代价。
 *
 * 步骤工期取历史成功运行的中位延迟（PERT 点估计的稳健替代）；
 * 无样本时退化为超时窗/全局先验并标注 estimated。
 * 纯函数模块：输入流水线与历史运行，输出完整 CPM 报告。
 */
import type { Pipeline, PipelineRun } from './types.js'

/** 零样本先验（与 monte.ts 对齐）。 */
const PRIOR_MOST_LIKELY_MS = 30_000

/** 单步 CPM 分析。 */
export interface CpmStep {
  readonly stepId: string
  readonly name: string
  /** 采用的工期（毫秒，历史中位/先验）。 */
  readonly durationMs: number
  /** 工期来源是否为先验估计（无历史样本）。 */
  readonly estimated: boolean
  /** 历史样本数。 */
  readonly sampleCount: number
  /** 最早开始/最早结束（毫秒，相对流水线起点）。 */
  readonly esMs: number
  readonly efMs: number
  /** 最晚开始/最晚结束（不延误总工期的前提下）。 */
  readonly lsMs: number
  readonly lfMs: number
  /** 松弛 = LS − ES（0 = 关键步骤）。 */
  readonly slackMs: number
  /** 是否在关键路径上。 */
  readonly critical: boolean
  readonly dependsOn: readonly string[]
}

/** 并发峰值画像。 */
export interface ConcurrencyProfile {
  /** 全程并发执行步数的峰值（理想无界并行）。 */
  readonly peak: number
  /** 峰值出现的时刻（毫秒，相对起点）。 */
  readonly peakAtMs: number
  /** 峰值时刻同时在跑的步骤 id。 */
  readonly peakSteps: readonly string[]
  /** 并行化收益 = Σ 工期 − 总工期（毫秒）。 */
  readonly parallelismSavedMs: number
}

/** CPM 报告。 */
export interface CpmReport {
  readonly pipelineId: string
  readonly pipelineName: string
  readonly valid: boolean
  readonly errors: readonly string[]
  /** 关键路径步骤 id（起点 → 终点）。 */
  readonly criticalPath: readonly string[]
  /** 关键路径总长（= 总工期，毫秒）。 */
  readonly makespanMs: number
  readonly steps: readonly CpmStep[]
  readonly concurrency: ConcurrencyProfile | null
  /** 瓶颈步骤（关键路径上工期最长的步骤）。 */
  readonly bottleneckStepId: string | null
  readonly advice: string
}

/** 选项。 */
export interface CpmOptions {
  /** 覆盖单步工期（stepId → ms；优先于历史）。 */
  readonly durationOverrides?: Readonly<Record<string, number>>
}

/** 步骤工期提取：历史成功延迟中位数；无样本用超时窗/先验。 */
function stepDuration(
  stepId: string,
  timeoutMs: number,
  runs: readonly PipelineRun[],
): { durationMs: number; estimated: boolean; sampleCount: number } {
  const samples: number[] = []
  for (const run of runs) {
    const record = run.steps[stepId]
    if (record && record.latencyMs > 0 && (record.status === 'done' || record.status === 'skipped')) {
      samples.push(record.latencyMs)
    }
  }
  if (samples.length > 0) {
    const sorted = [...samples].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const median =
      sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    return { durationMs: median, estimated: false, sampleCount: samples.length }
  }
  const prior = timeoutMs > 0 ? Math.round(timeoutMs / 2) : PRIOR_MOST_LIKELY_MS
  return { durationMs: prior, estimated: true, sampleCount: 0 }
}

/**
 * 关键路径法分析（纯函数）。
 * 前向传播求 ES/EF，回向传播求 LS/LF，松弛 0 的链即关键路径。
 * 依赖图非法（环/悬空依赖）时返回 valid=false 与错误清单。
 */
export function analyzeCriticalPath(
  pipeline: Pipeline,
  runs: readonly PipelineRun[],
  options: CpmOptions = {},
): CpmReport {
  const steps = pipeline.steps
  const errors: string[] = []
  const byId = new Map(steps.map((step) => [step.id, step] as const))
  const stepIds = new Set(steps.map((step) => step.id))

  // 依赖合法性。
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!stepIds.has(dep)) errors.push(`步骤 ${step.id} 依赖不存在的 ${dep}`)
    }
  }
  // Kahn 拓扑排序 + 环检测。
  const indegree = new Map<string, number>()
  const successors = new Map<string, string[]>()
  for (const step of steps) {
    indegree.set(step.id, step.dependsOn.length)
    for (const dep of step.dependsOn) {
      const list = successors.get(dep) ?? []
      list.push(step.id)
      successors.set(dep, list)
    }
  }
  const queue: string[] = steps.filter((s) => s.dependsOn.length === 0).map((s) => s.id)
  const topo: string[] = []
  while (queue.length > 0) {
    const id = queue.shift() as string
    topo.push(id)
    for (const next of successors.get(id) ?? []) {
      const remain = (indegree.get(next) ?? 0) - 1
      indegree.set(next, remain)
      if (remain === 0) queue.push(next)
    }
  }
  if (topo.length !== steps.length && errors.length === 0) {
    errors.push('依赖图存在环（拓扑排序未覆盖全部步骤）')
  }
  if (errors.length > 0) {
    return {
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      valid: false,
      errors,
      criticalPath: [],
      makespanMs: 0,
      steps: [],
      concurrency: null,
      bottleneckStepId: null,
      advice: '依赖图非法，无法做关键路径分析：' + errors.join('；'),
    }
  }

  // 工期表。
  const durations = new Map<string, { durationMs: number; estimated: boolean; sampleCount: number }>()
  for (const step of steps) {
    const override = options.durationOverrides?.[step.id]
    durations.set(
      step.id,
      override !== undefined && override > 0
        ? { durationMs: Math.round(override), estimated: true, sampleCount: 0 }
        : stepDuration(step.id, step.timeoutMs, runs),
    )
  }

  // 前向传播：ES = max(依赖 EF)；EF = ES + duration。
  const es = new Map<string, number>()
  const ef = new Map<string, number>()
  for (const id of topo) {
    const deps = byId.get(id)?.dependsOn ?? []
    let start = 0
    for (const dep of deps) start = Math.max(start, ef.get(dep) ?? 0)
    const duration = durations.get(id)?.durationMs ?? 0
    es.set(id, start)
    ef.set(id, start + duration)
  }
  const makespan = steps.reduce((max, step) => Math.max(max, ef.get(step.id) ?? 0), 0)

  // 回向传播：LF = min(下游 LS)；终步 LF = makespan。
  const ls = new Map<string, number>()
  const lf = new Map<string, number>()
  for (let i = topo.length - 1; i >= 0; i -= 1) {
    const id = topo[i]
    const nextList = successors.get(id) ?? []
    let finish = makespan
    for (const next of nextList) finish = Math.min(finish, ls.get(next) ?? makespan)
    const duration = durations.get(id)?.durationMs ?? 0
    lf.set(id, finish)
    ls.set(id, finish - duration)
  }

  const slackOf = (id: string): number => (ls.get(id) ?? 0) - (es.get(id) ?? 0)
  const critical = (id: string): boolean => slackOf(id) === 0

  // 关键路径回溯：从关键终步（EF = makespan 且松弛 0）沿关键依赖回走。
  const criticalTerminals = steps
    .filter((step) => critical(step.id) && (ef.get(step.id) ?? 0) === makespan)
    .map((step) => step.id)
  const path: string[] = []
  if (criticalTerminals.length > 0) {
    let cursor: string | undefined = criticalTerminals[0]
    while (cursor !== undefined) {
      path.unshift(cursor)
      const current: string = cursor
      const deps: readonly string[] = byId.get(current)?.dependsOn ?? []
      // 关键依赖 = 依赖的 EF 恰为本步 ES 且依赖自身关键。
      cursor = deps.find((dep) => critical(dep) && (ef.get(dep) ?? 0) === (es.get(current) ?? 0))
    }
  }

  // 并发峰值：扫描 [ES, EF] 窗口的起点事件。
  const events = steps.flatMap((step) => [
    { at: es.get(step.id) ?? 0, stepId: step.id, delta: 1 },
    { at: ef.get(step.id) ?? 0, stepId: step.id, delta: -1 },
  ])
  events.sort((a, b) => a.at - b.at || b.delta - a.delta)
  let running = 0
  let peak = 0
  let peakAt = 0
  const runningSet = new Set<string>()
  let peakSteps: string[] = []
  for (const event of events) {
    if (event.delta > 0) runningSet.add(event.stepId)
    else runningSet.delete(event.stepId)
    running += event.delta
    if (running > peak) {
      peak = running
      peakAt = event.at
      peakSteps = [...runningSet]
    }
  }
  const totalDuration = steps.reduce((sum, step) => sum + (durations.get(step.id)?.durationMs ?? 0), 0)

  const cpmSteps: CpmStep[] = steps.map((step) => ({
    stepId: step.id,
    name: step.name,
    durationMs: durations.get(step.id)?.durationMs ?? 0,
    estimated: durations.get(step.id)?.estimated ?? true,
    sampleCount: durations.get(step.id)?.sampleCount ?? 0,
    esMs: es.get(step.id) ?? 0,
    efMs: ef.get(step.id) ?? 0,
    lsMs: ls.get(step.id) ?? 0,
    lfMs: lf.get(step.id) ?? 0,
    slackMs: slackOf(step.id),
    critical: critical(step.id),
    dependsOn: step.dependsOn,
  }))

  const criticalSteps = cpmSteps.filter((step) => step.critical)
  const bottleneck =
    criticalSteps.length > 0
      ? criticalSteps.reduce((worst, step) => (step.durationMs > worst.durationMs ? step : worst), criticalSteps[0])
          .stepId
      : null
  const bottleneckName = bottleneck !== null ? byId.get(bottleneck)?.name ?? bottleneck : ''
  const slackSteps = cpmSteps.filter((step) => !step.critical && step.slackMs > 0)
  const advice = [
    `总工期 ${Math.round(makespan / 1000)}s 由 ${path.length} 步关键路径决定（${path.join(' → ')}）。`,
    bottleneck !== null
      ? `瓶颈：关键步骤「${bottleneckName}」工期最长，压缩它的收益 1:1 传导到总工期。`
      : '',
    slackSteps.length > 0
      ? `${slackSteps.length} 个非关键步骤合计松弛 ${Math.round(slackSteps.reduce((s, x) => s + x.slackMs, 0) / 1000)}s，可安全延后腾挪资源。`
      : '',
    `理想并行可省 ${Math.round((totalDuration - makespan) / 1000)}s，代价是 ${peak} 路并发（峰值为 ${Math.round(peakAt / 1000)}s 处：${peakSteps.join('、')}）。`,
  ]
    .filter((line) => line.length > 0)
    .join(' ')

  return {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    valid: true,
    errors: [],
    criticalPath: path,
    makespanMs: makespan,
    steps: cpmSteps,
    concurrency: {
      peak,
      peakAtMs: peakAt,
      peakSteps,
      parallelismSavedMs: totalDuration - makespan,
    },
    bottleneckStepId: bottleneck,
    advice,
  }
}
