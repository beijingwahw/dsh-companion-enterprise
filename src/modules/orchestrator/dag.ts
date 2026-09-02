/**
 * 模块 H 创新扩展：DAG 规划器与关键路径分析（Critical Path Method）。
 *
 * 流水线的 dependsOn 只是一份依赖清单——「哪些步骤能并行」「总工期
 * 由谁决定」「延迟哪个步骤会整体延期」都藏在图结构里。规划器把
 * 工程项目管理的 CPM（关键路径法）引入 LLM 流水线：
 *
 * 1. 图校验：Kahn 拓扑排序检出循环依赖，逐项核对悬空依赖
 *    （指向不存在的步骤）——配置错误在执行前暴露；
 * 2. 拓扑分层：level(v) = max(level(上游)) + 1——同层步骤无依赖，
 *    是天然的并行批（parallel wave），最大层宽即理论并行度上限；
 * 3. 工期估算：每步取历史运行延迟均值（无历史时按超时一半保守估计），
 *    CPM 正向推最早开始、逆向推最晚开始，浮动时间为零的节点链
 *    即关键路径——它决定流水线总工期，其余步骤晚点做完也无妨；
 * 4. 可行动建议：识别关键路径瓶颈（「优化 X 或给它降级模型收益最大」）、
 *    指出被串行浪费的可并行层、标记单点依赖（下游全等它）。
 */
import type { Pipeline, PipelineStep, PipelineRun } from './types.js'

/** 无历史运行时的保守耗时估计（毫秒）。 */
const DEFAULT_STEP_MS = 30_000

/** 单步 DAG 节点。 */
export interface DagNode {
  readonly stepId: string
  readonly name: string
  /** 拓扑层（0 起）：同层步骤互不依赖，可并行执行。 */
  readonly level: number
  /** 上游依赖。 */
  readonly dependsOn: readonly string[]
  /** 下游依赖本步骤的步骤。 */
  readonly dependents: readonly string[]
  /** 估算耗时（毫秒，历史均值或保守估计）。 */
  readonly estimatedMs: number
  /** 估算依据：'history'（有历史均值）| 'timeout'（超时一半）| 'default'。 */
  readonly estimateBasis: 'history' | 'timeout' | 'default'
  /** CPM 最早开始时间（相对流水线起点，毫秒）。 */
  readonly earliestStartMs: number
  /** CPM 最晚开始时间（不推迟总工期，毫秒）。 */
  readonly latestStartMs: number
  /** 总浮动时间（毫秒）。 */
  readonly slackMs: number
  /** 是否在关键路径上。 */
  readonly critical: boolean
}

/** DAG 规划报告。 */
export interface DagPlan {
  readonly pipelineId: string
  readonly pipelineName: string
  /** 图是否合法（无环、无悬空依赖）。 */
  readonly valid: boolean
  /** 校验错误（中文，供直接展示）。 */
  readonly errors: readonly string[]
  /** 全部节点（拓扑序）。 */
  readonly nodes: readonly DagNode[]
  /** 拓扑分层（每层内步骤可并行）。 */
  readonly levels: ReadonlyArray<readonly string[]>
  /** 理论最大并行度（最宽层）。 */
  readonly maxParallelism: number
  /** 关键路径（步骤 id 序列，起点→终点）。 */
  readonly criticalPath: readonly string[]
  /** 理论最短总工期（毫秒）。 */
  readonly totalDurationMs: number
  /** 优化建议（中文，可行动）。 */
  readonly suggestions: readonly string[]
}

/** 一步历史延迟（毫秒）。 */
function estimateStepMs(step: PipelineStep, runs: readonly PipelineRun[]): {
  ms: number
  basis: 'history' | 'timeout' | 'default'
} {
  const samples: number[] = []
  for (const run of runs) {
    const record = run.steps[step.id]
    if (record && record.latencyMs > 0) samples.push(record.latencyMs)
  }
  if (samples.length > 0) {
    return { ms: Math.round(samples.reduce((s, v) => s + v, 0) / samples.length), basis: 'history' }
  }
  if (step.timeoutMs > 0) return { ms: Math.round(step.timeoutMs / 2), basis: 'timeout' }
  return { ms: DEFAULT_STEP_MS, basis: 'default' }
}

/** 构建某流水线的 DAG 规划（含校验、分层、CPM 与建议）。 */
export function planDag(pipeline: Pipeline, runs: readonly PipelineRun[]): DagPlan {
  const steps = pipeline.steps
  const byId = new Map(steps.map((step) => [step.id, step]))
  const errors: string[] = []
  // 1. 悬空依赖校验。
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!byId.has(dep)) errors.push(`步骤「${step.name}」依赖了不存在的步骤 id：${dep}`)
    }
  }
  // 2. Kahn 拓扑排序（环检测 + 拓扑序）。
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const step of steps) {
    inDegree.set(step.id, 0)
    dependents.set(step.id, [])
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!byId.has(dep)) continue
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1)
      dependents.get(dep)?.push(step.id)
    }
  }
  const queue: string[] = steps.filter((s) => (inDegree.get(s.id) ?? 0) === 0).map((s) => s.id)
  const topo: string[] = []
  const levelMap = new Map<string, number>()
  for (const id of queue) levelMap.set(id, 0)
  while (queue.length > 0) {
    const id = queue.shift() as string
    topo.push(id)
    for (const next of dependents.get(id) ?? []) {
      const deg = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, deg)
      if (deg === 0) {
        queue.push(next)
        // 层 = 最深上游层 + 1。
        const depLevel = Math.max(
          ...((byId.get(next)?.dependsOn ?? []).map((d) => levelMap.get(d) ?? 0)),
        )
        levelMap.set(next, depLevel + 1)
      }
    }
  }
  if (topo.length < steps.length) {
    const cyclic = steps.filter((s) => !topo.includes(s.id)).map((s) => s.name)
    errors.push(`检测到循环依赖，涉及步骤：${cyclic.join('、')}`)
    return {
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      valid: false,
      errors,
      nodes: [],
      levels: [],
      maxParallelism: 0,
      criticalPath: [],
      totalDurationMs: 0,
      suggestions: ['请修正依赖关系后再分析'],
    }
  }
  // 3. 耗时估算。
  const estimate = new Map<string, { ms: number; basis: 'history' | 'timeout' | 'default' }>()
  for (const step of steps) estimate.set(step.id, estimateStepMs(step, runs))
  // 4. CPM 正向（拓扑序推 earliestStart/earliestFinish）。
  const earliest = new Map<string, number>()
  for (const id of topo) {
    const deps = byId.get(id)?.dependsOn ?? []
    const start = deps.length === 0 ? 0 : Math.max(...deps.map((d) => earliest.get(d) ?? 0))
    earliest.set(id, start)
  }
  const finishOf = (id: string): number => (earliest.get(id) ?? 0) + (estimate.get(id)?.ms ?? 0)
  const total = topo.length === 0 ? 0 : Math.max(...topo.map(finishOf))
  // 5. CPM 逆向（最晚开始 / 浮动）。
  const latest = new Map<string, number>()
  for (let i = topo.length - 1; i >= 0; i -= 1) {
    const id = topo[i]
    const downstream = dependents.get(id) ?? []
    if (downstream.length === 0) {
      latest.set(id, total - (estimate.get(id)?.ms ?? 0))
    } else {
      const minChildStart = Math.min(...downstream.map((d) => latest.get(d) ?? 0))
      latest.set(id, minChildStart - (estimate.get(id)?.ms ?? 0))
    }
  }
  // 6. 组装节点。
  const maxLevel = topo.length === 0 ? -1 : Math.max(...[...levelMap.values()])
  const levels: string[][] = Array.from({ length: maxLevel + 1 }, () => [])
  const nodes: DagNode[] = topo.map((id) => {
    const step = byId.get(id) as PipelineStep
    const est = estimate.get(id) ?? { ms: DEFAULT_STEP_MS, basis: 'default' as const }
    const slack = (latest.get(id) ?? 0) - (earliest.get(id) ?? 0)
    levels[levelMap.get(id) ?? 0].push(id)
    return {
      stepId: id,
      name: step.name,
      level: levelMap.get(id) ?? 0,
      dependsOn: step.dependsOn,
      dependents: dependents.get(id) ?? [],
      estimatedMs: est.ms,
      estimateBasis: est.basis,
      earliestStartMs: earliest.get(id) ?? 0,
      latestStartMs: latest.get(id) ?? 0,
      slackMs: slack,
      critical: slack === 0,
    }
  })
  // 7. 关键路径：从 critical 终点回溯（终点 = 无下游且 critical）。
  const criticalSet = new Set(nodes.filter((n) => n.critical).map((n) => n.stepId))
  const endNodes = nodes.filter((n) => n.dependents.length === 0 && n.critical)
  const criticalPath: string[] = []
  if (endNodes.length > 0) {
    let cursor = endNodes[0]
    criticalPath.unshift(cursor.stepId)
    while (cursor.dependsOn.some((d) => criticalSet.has(d))) {
      const prevCritical = cursor.dependsOn.filter((d) => criticalSet.has(d))
      cursor = nodes.find((n) => n.stepId === prevCritical[prevCritical.length - 1]) as DagNode
      criticalPath.unshift(cursor.stepId)
    }
  }
  // 8. 可行动建议。
  const suggestions: string[] = []
  const bottleneck = criticalPath
    .map((id) => nodes.find((n) => n.stepId === id) as DagNode)
    .sort((a, b) => b.estimatedMs - a.estimatedMs)[0]
  if (bottleneck && steps.length > 1) {
    suggestions.push(
      `关键路径瓶颈是「${bottleneck.name}」（约 ${(bottleneck.estimatedMs / 1000).toFixed(1)}s）：` +
        `优化它的 Prompt 长度、换更快模型或配置 fallbackModel，对总工期收益最大。`,
    )
  }
  const maxParallelism = levels.reduce((m, layer) => Math.max(m, layer.length), 0)
  if (maxParallelism > 1) {
    suggestions.push(
      `流水线存在 ${levels.filter((l) => l.length > 1).length} 个可并行层（最大并行度 ${maxParallelism}）：` +
        `确保执行器按层并发调度，理论总工期可比全串行缩短 ${Math.max(
          0,
          Math.round(
            ((steps.reduce((s, step) => s + (estimate.get(step.id)?.ms ?? 0), 0) - total) /
              Math.max(1, steps.reduce((s, step) => s + (estimate.get(step.id)?.ms ?? 0), 0))) *
              100,
          ),
        )}%。`,
    )
  }
  const singlePoints = nodes.filter((n) => n.dependents.length >= 3)
  for (const point of singlePoints.slice(0, 3)) {
    suggestions.push(
      `「${point.name}」是单点依赖（${point.dependents.length} 个下游在等它）：` +
        `它的失败会阻塞整层，建议提高其 maxRetries 或配置降级模型。`,
    )
  }
  if (suggestions.length === 0 && steps.length > 0) {
    suggestions.push('流水线为纯串行链：考虑拆分无数据依赖的步骤为并行层以缩短工期。')
  }
  return {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    valid: errors.length === 0,
    errors,
    nodes,
    levels,
    maxParallelism,
    criticalPath,
    totalDurationMs: total,
    suggestions,
  }
}
