/**
 * 模块 H 创新扩展：蒙特卡洛工期模拟（Monte Carlo Schedule Simulation）。
 *
 * DAG 规划器（dag.ts）是确定性 CPM：每步一个固定耗时均值，输出一条
 * 关键路径与一个总工期。但 LLM 调用的耗时天然高方差（同一 Prompt 快
 * 时 2 秒慢时 40 秒），「均值总工期」对交付承诺毫无防御力——工程
 * 项目管理领域六十年前就给出了正解（PERT / 蒙特卡洛排程）：
 * 单点估算 → 分布估算，工期承诺 → 置信区间。
 *
 * 方法论：
 * 1. PERT 三点估算：从历史运行提取每步的乐观 a / 最可能 m / 悲观 b
 *    （≥3 样本取 min/中位数/max；少样本按区间放大；零样本按超时或
 *    全局先验保守估计并标记 estimated）；
 *    分析矩：均值 = (a+4m+b)/6，标准差 = (b−a)/6（PERT 经典公式）；
 * 2. 蒙特卡洛抽样：每次迭代按三角分布抽全部步骤耗时，沿依赖图
 *    推演（无界并行 = 最长路径；可限并行度 = 事件驱动的 k 工人
 *    排队仿真，贴近 API 限流下的真实行为），累计总工期分布；
 * 3. 置信区间：输出 P50/P80/P90/P95/P99——「对外承诺工期按 P90
 *    规划，90% 的运行会在该时间内完成」是可辩护的 SLA 语言；
 * 4. 随机关键性指数（criticality index，随机排程的标准度量）：
 *    统计每步出现在模拟关键路径上的频率——确定性 CPM 说「瓶颈是
 *    X」，蒙特卡洛说「X 有 85% 的概率决定你的工期」，后者才敢
 *    指导优化预算的投向。
 *
 * 纯函数模块：图校验复用 planDag，历史样本来自 PipelineRunStore。
 */
import { percentileOf } from '../../core/stats.js'
import { planDag } from './dag.js'
import type { Pipeline, PipelineRun } from './types.js'

/** 默认模拟迭代次数。 */
export const DEFAULT_ITERATIONS = 2_000

/** 迭代次数上下限。 */
const MIN_ITERATIONS = 200
const MAX_ITERATIONS = 20_000

/** 零样本且无超时配置时的全局先验（毫秒，与 dag.ts 的 DEFAULT_STEP_MS 对齐）。 */
const PRIOR_MOST_LIKELY_MS = 30_000

/** 单步三点估算。 */
export interface MonteStepEstimate {
  readonly stepId: string
  readonly name: string
  /** 历史样本数（该步在全部运行中的成功延迟记录数）。 */
  readonly sampleCount: number
  readonly optimisticMs: number
  readonly mostLikelyMs: number
  readonly pessimisticMs: number
  /** PERT 均值 (a+4m+b)/6。 */
  readonly pertMeanMs: number
  /** PERT 标准差 (b−a)/6。 */
  readonly pertSdMs: number
  /** true = 无历史样本（先验估计，建议先跑几轮校准）。 */
  readonly estimated: boolean
  /** 关键性指数：出现在模拟关键路径上的频率（0-1）。 */
  readonly criticality: number
}

/** 总工期分布摘要。 */
export interface MonteTotal {
  readonly p50Ms: number
  readonly p80Ms: number
  readonly p90Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
  readonly meanMs: number
  readonly sdMs: number
  readonly minMs: number
  readonly maxMs: number
}

/** 蒙特卡洛模拟报告。 */
export interface MonteReport {
  readonly pipelineId: string
  readonly pipelineName: string
  /** 依赖图是否合法（复用 DAG 规划器校验）。 */
  readonly valid: boolean
  readonly errors: readonly string[]
  readonly iterations: number
  /** 并行度上限（null = 无界并行）。 */
  readonly parallelism: number | null
  readonly steps: readonly MonteStepEstimate[]
  readonly total: MonteTotal | null
  /** 关键性最高的步骤 id（瓶颈）。 */
  readonly bottleneckStepId: string | null
  readonly bottleneckCriticality: number
  readonly advice: string
}

/** 模拟选项。 */
export interface SimulateOptions {
  /** 迭代次数（缺省 2000，钳制 [200, 20000]）。 */
  readonly iterations?: number
  /** 并行度上限（缺省 null = 无界并行；>0 时按 k 工人排队仿真）。 */
  readonly parallelism?: number | null
}

/** 三角分布抽样（u∈[0,1)）。 */
function sampleTriangular(a: number, m: number, b: number, u: number): number {
  if (b <= a) return a
  const cutoff = (m - a) / (b - a)
  if (u < cutoff) return a + Math.sqrt(u * (b - a) * (m - a))
  return b - Math.sqrt((1 - u) * (b - a) * (b - m))
}

/** 三点估算（历史样本 → a/m/b）。 */
function threePoint(
  samples: readonly number[],
  timeoutMs: number,
): { a: number; m: number; b: number; estimated: boolean } {
  if (samples.length >= 3) {
    const sorted = [...samples].sort((x, y) => x - y)
    const mid = Math.floor(sorted.length / 2)
    const median =
      sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    return { a: sorted[0], m: median, b: sorted[sorted.length - 1], estimated: false }
  }
  if (samples.length === 1) {
    const s = samples[0]
    return { a: Math.round(s * 0.5), m: s, b: Math.round(s * 2), estimated: true }
  }
  if (samples.length === 2) {
    const a = Math.min(samples[0], samples[1])
    const b = Math.max(samples[0], samples[1])
    return { a, m: Math.round((a + b) / 2), b, estimated: true }
  }
  // 零样本：超时窗内先验，否则全局先验（对称放大区间）。
  const m = timeoutMs > 0 ? Math.round(timeoutMs / 2) : PRIOR_MOST_LIKELY_MS
  return { a: Math.max(500, Math.round(m * 0.2)), m, b: Math.round(m * 1.8), estimated: true }
}

/** 按分位数取值（sorted 升序数组）。共享实现见 core/stats.ts。 */
const percentile = percentileOf

/**
 * 蒙特卡洛工期模拟（纯函数）。
 * @param pipeline 目标流水线。
 * @param runs 该流水线的历史运行（含每步延迟）。
 * @param options 迭代次数与并行度。
 */
export function simulatePipeline(
  pipeline: Pipeline,
  runs: readonly PipelineRun[],
  options: SimulateOptions = {},
): MonteReport {
  const iterations = Math.min(
    MAX_ITERATIONS,
    Math.max(MIN_ITERATIONS, Math.floor(options.iterations ?? DEFAULT_ITERATIONS)),
  )
  const parallelismRaw = options.parallelism
  const parallelism =
    typeof parallelismRaw === 'number' && parallelismRaw > 0 ? Math.floor(parallelismRaw) : null

  // 图校验复用 DAG 规划器（Kahn 环检测 + 悬空依赖）。
  const plan = planDag(pipeline, runs)
  if (!plan.valid) {
    return {
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      valid: false,
      errors: plan.errors,
      iterations,
      parallelism,
      steps: [],
      total: null,
      bottleneckStepId: null,
      bottleneckCriticality: 0,
      advice: '依赖图不合法，请先修正后再模拟',
    }
  }

  const steps = pipeline.steps
  const byId = new Map(steps.map((step) => [step.id, step]))
  const dependents = new Map<string, string[]>()
  for (const step of steps) dependents.set(step.id, [])
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      dependents.get(dep)?.push(step.id)
    }
  }
  // 拓扑序（plan.nodes 已是拓扑序）。
  const topo = plan.nodes.map((node) => node.stepId)

  // 三点估算。
  const estimates = new Map<string, ReturnType<typeof threePoint>>()
  for (const step of steps) {
    const samples: number[] = []
    for (const run of runs) {
      const record = run.steps[step.id]
      if (record && record.latencyMs > 0) samples.push(record.latencyMs)
    }
    estimates.set(step.id, threePoint(samples, step.timeoutMs))
  }

  // 模拟。
  const totals: number[] = []
  const criticality = new Map<string, number>()
  for (const id of topo) criticality.set(id, 0)
  for (let iter = 0; iter < iterations; iter += 1) {
    const durations = new Map<string, number>()
    for (const id of topo) {
      const est = estimates.get(id)
      if (!est) continue
      durations.set(
        id,
        Math.max(0, Math.round(sampleTriangular(est.a, est.m, est.b, Math.random()))),
      )
    }
    // 无界并行：finish(v) = max(finish(deps)) + dur(v)。
    const finish = new Map<string, number>()
    for (const id of topo) {
      const deps = byId.get(id)?.dependsOn ?? []
      const start = deps.length === 0 ? 0 : Math.max(...deps.map((d) => finish.get(d) ?? 0))
      finish.set(id, start + (durations.get(id) ?? 0))
    }
    // 有界并行：k 工人事件驱动排队仿真（覆盖 totals）。
    let total: number
    if (parallelism === null) {
      total = topo.length === 0 ? 0 : Math.max(...topo.map((id) => finish.get(id) ?? 0))
    } else {
      total = simulateBounded(topo, byId, dependents, durations, parallelism)
    }
    totals.push(total)
    // 关键性（结构性）：从最晚完成的节点回溯最长依赖链。
    let cursor = topo[0]
    for (const id of topo) {
      if ((finish.get(id) ?? 0) > (finish.get(cursor) ?? 0)) cursor = id
    }
    const path = new Set<string>()
    for (let guard = 0; guard < topo.length + 1; guard += 1) {
      path.add(cursor)
      const deps = byId.get(cursor)?.dependsOn ?? []
      let next: string | null = null
      for (const dep of deps) {
        if (finish.get(dep) === (finish.get(cursor) ?? 0) - (durations.get(cursor) ?? 0)) {
          next = dep
          break
        }
      }
      if (next === null) break
      cursor = next
    }
    for (const id of path) criticality.set(id, (criticality.get(id) ?? 0) + 1)
  }

  // 汇总分布。
  totals.sort((a, b) => a - b)
  const mean = totals.reduce((s, v) => s + v, 0) / Math.max(1, totals.length)
  const variance =
    totals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / Math.max(1, totals.length - 1)
  const total: MonteTotal = {
    p50Ms: percentile(totals, 50),
    p80Ms: percentile(totals, 80),
    p90Ms: percentile(totals, 90),
    p95Ms: percentile(totals, 95),
    p99Ms: percentile(totals, 99),
    meanMs: Math.round(mean),
    sdMs: Math.round(Math.sqrt(Math.max(0, variance))),
    minMs: totals[0] ?? 0,
    maxMs: totals[totals.length - 1] ?? 0,
  }

  // 步骤行（含关键性指数）。
  const stepRows: MonteStepEstimate[] = steps.map((step) => {
    const est = estimates.get(step.id)
    const a = est?.a ?? PRIOR_MOST_LIKELY_MS
    const m = est?.m ?? PRIOR_MOST_LIKELY_MS
    const b = est?.b ?? PRIOR_MOST_LIKELY_MS
    let sampleCount = 0
    for (const run of runs) {
      const record = run.steps[step.id]
      if (record && record.latencyMs > 0) sampleCount += 1
    }
    return {
      stepId: step.id,
      name: step.name,
      sampleCount,
      optimisticMs: a,
      mostLikelyMs: m,
      pessimisticMs: b,
      pertMeanMs: Math.round((a + 4 * m + b) / 6),
      pertSdMs: Math.round((b - a) / 6),
      estimated: sampleCount === 0,
      criticality: Math.round(((criticality.get(step.id) ?? 0) / iterations) * 1000) / 1000,
    }
  })
  stepRows.sort((x, y) => y.criticality - x.criticality || y.pertMeanMs - x.pertMeanMs)
  const bottleneck = stepRows[0] ?? undefined

  const advice =
    stepRows.length === 0
      ? '流水线没有步骤可模拟'
      : `总工期 P50 ${Math.round(total.p50Ms / 1000)}s / P90 ${Math.round(total.p90Ms / 1000)}s：` +
        `对外承诺工期建议按 P90 规划（${Math.round((total.p90Ms / 1000))}s 内完成的把握为 90%）` +
        (bottleneck && bottleneck.criticality > 0.5
          ? `；瓶颈「${bottleneck.name}」有 ${Math.round(bottleneck.criticality * 100)}% 的概率决定总工期，优化收益最大`
          : '') +
        (stepRows.some((row) => row.estimated)
          ? '；存在零样本步骤（先验估计），先完整跑几轮可显著提高模拟可信度'
          : '')

  return {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    valid: true,
    errors: [],
    iterations,
    parallelism,
    steps: stepRows,
    total,
    bottleneckStepId: bottleneck?.stepId ?? null,
    bottleneckCriticality: bottleneck?.criticality ?? 0,
    advice,
  }
}

/** k 工人事件驱动排队仿真：返回总完工时间（毫秒）。 */
function simulateBounded(
  topo: readonly string[],
  byId: ReadonlyMap<string, { readonly dependsOn: readonly string[] }>,
  dependents: ReadonlyMap<string, readonly string[]>,
  durations: ReadonlyMap<string, number>,
  workers: number,
): number {
  const inDegree = new Map<string, number>()
  for (const id of topo) inDegree.set(id, 0)
  for (const id of topo) {
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1)
    }
  }
  const ready: string[] = topo.filter((id) => (inDegree.get(id) ?? 0) === 0)
  const running: Array<{ stepId: string; endAt: number }> = []
  let clock = 0
  let completed = 0
  const done = new Set<string>()
  while (completed < topo.length) {
    // 工人取任务（FIFO，拓扑序即优先级）。
    while (running.length < workers && ready.length > 0) {
      const id = ready.shift() as string
      running.push({ stepId: id, endAt: clock + (durations.get(id) ?? 0) })
    }
    if (running.length === 0) break // 无可执行任务（理论不可达，防御）。
    // 推进到最早完成的事件。
    let nextIndex = 0
    for (let i = 1; i < running.length; i += 1) {
      if (running[i].endAt < running[nextIndex].endAt) nextIndex = i
    }
    const finished = running.splice(nextIndex, 1)[0]
    clock = finished.endAt
    done.add(finished.stepId)
    completed += 1
    for (const next of dependents.get(finished.stepId) ?? []) {
      const deg = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, deg)
      if (deg === 0) ready.push(next)
    }
  }
  return clock
}
