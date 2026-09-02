/**
 * 模块 E 创新扩展：孤立森林轨迹异常检测（Isolation Forest Anomaly Detection）。
 *
 * SPC 控制图回答「指标是否越出历史控制限」——但控制限是对单一指标的
 * 逐维判断：一个「每项指标都只偏了一点点、但组合起来前所未见」的轨迹
 * 会从所有单维雷达下漏过。Isolation Forest（Liu, Ting & Zhou,
 * ICDM 2008——无监督异常检测被引最高的算法之一）换了一个反直觉的
 * 视角：不建模「正常是什么」，而是利用「异常点稀少且与众不同，
 * 因此更容易被随机切分孤立」——
 *
 * 1. 特征向量化：每条轨迹 → 7 维特征（节点数 / 总耗时对数 / 总 token
 *    对数 / 重试率 / 错误率 / 工具占比 / 缓存未命中率）；
 * 2. iTrees：每棵树从 ψ 条子样本出发，随机选特征 + 随机选切分点
 *    递归二分，直到叶子单点或高度上限——异常点平均在更浅处就被
 *    孤立（路径短）；
 * 3. 异常分：s(x) = 2^(−E[h(x)]/c(ψ))——平均路径越短分越高，
 *    0.5 为分水岭，→1 强异常，→0 稳定正常；
 * 4. 可解释证据：伴随输出各特征的 z 分数——「孤立森林说它异常，
 *    重试率 z=+4.2、缓存未命中 z=+3.1」把黑盒评分翻译成工程线索。
 *
 * 纯函数模块：数据来自既有 Trace 集合（保存轨迹 + 会话派生轨迹）。
 */

import type { Trace } from './types.js'

/** 子样本大小 ψ（iForest 原文推荐 256；小样本用全部）。 */
const SUBSAMPLE_SIZE = 256

/** 树数量 t（原文推荐 100）。 */
const TREE_COUNT = 100

/** 树高上限 ceil(log2(ψ))。 */
function maxTreeHeight(sampleSize: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(2, sampleSize))))
}

/** 特征名（固定顺序）。 */
export const TRACE_FEATURES = [
  'nodeCount',
  'logDuration',
  'logTokens',
  'retryRate',
  'errorRate',
  'toolRatio',
  'cacheMissRate',
] as const

/** 轨迹特征名类型。 */
export type TraceFeature = (typeof TRACE_FEATURES)[number]

/** 特征中文标签（报告展示）。 */
const FEATURE_LABELS: Readonly<Record<TraceFeature, string>> = {
  nodeCount: '节点数',
  logDuration: '总耗时（对数）',
  logTokens: 'Token 量（对数）',
  retryRate: '重试率',
  errorRate: '错误率',
  toolRatio: '工具调用占比',
  cacheMissRate: '缓存未命中率',
}

/** 单轨迹特征向量（与 TRACE_FEATURES 同序）。 */
export interface TraceFeatures {
  readonly traceId: string
  readonly sessionId?: string
  readonly startedAt: number
  /** 特征值（7 维，与 TRACE_FEATURES 同序）。 */
  readonly values: readonly number[]
}

/** 单条异常轨迹。 */
export interface TraceAnomalyEntry {
  readonly traceId: string
  readonly sessionId?: string
  readonly startedAt: number
  /** 异常分 s(x) ∈ (0,1]，> 0.5 偏异常。 */
  readonly score: number
  /** 是否判为异常（score ≥ 阈值）。 */
  readonly anomalous: boolean
  /** 各特征 z 分数（与 TRACE_FEATURES 同序；解释证据）。 */
  readonly zScores: readonly { readonly feature: TraceFeature; readonly label: string; readonly z: number }[]
  /** 驱动异常的特征（|z| ≥ 2 的特征，降序）。 */
  readonly drivers: readonly { readonly feature: TraceFeature; readonly label: string; readonly z: number }[]
  /** 一句话证据描述。 */
  readonly evidence: string
}

/** 异常检测报告。 */
export interface AnomalyReport {
  /** 参与检测的轨迹数。 */
  readonly traces: number
  /** 检测方法参数。 */
  readonly trees: number
  readonly subsampleSize: number
  /** 异常判定阈值。 */
  readonly threshold: number
  /** 异常轨迹条数。 */
  readonly anomalousCount: number
  /** 按异常分降序的轨迹（≤ limit 条）。 */
  readonly entries: readonly TraceAnomalyEntry[]
  /** 数据不足说明（轨迹 < 8 条时不输出结论）。 */
  readonly note: string
  readonly summary: string
}

/** 异常判定阈值（iForest 常用 0.5-0.6；兼顾召回取 0.55）。 */
const ANOMALY_THRESHOLD = 0.55

/** 结论输出所需最少轨迹数。 */
const MIN_TRACES = 8

/** 输出条数上限。 */
const DEFAULT_LIMIT = 20

// ---------------------------------------------------------------------------
// 特征提取
// ---------------------------------------------------------------------------

/** ln(1+x)（零值安全）。 */
function log1p(x: number): number {
  return Math.log(1 + Math.max(0, x))
}

/** 从轨迹提取特征向量（与 TRACE_FEATURES 同序）。 */
export function extractFeatures(trace: Trace): TraceFeatures {
  const nodes = trace.nodes
  const nodeCount = nodes.length
  let durationMs = 0
  let tokens = 0
  let retries = 0
  let errors = 0
  let toolCalls = 0
  let cacheMisses = 0
  let cacheable = 0
  for (const node of nodes) {
    durationMs += node.durationMs
    tokens += node.inputTokens + node.outputTokens
    if (node.status === 'retry') retries += 1
    if (node.status === 'error') errors += 1
    if (node.kind === 'tool') toolCalls += 1
    if (node.kind === 'model' || node.kind === 'tool') {
      cacheable += 1
      if (!node.cacheHit) cacheMisses += 1
    }
  }
  return {
    traceId: trace.id,
    sessionId: trace.sessionId,
    startedAt: trace.startedAt,
    values: [
      nodeCount,
      log1p(durationMs),
      log1p(tokens),
      nodeCount > 0 ? retries / nodeCount : 0,
      nodeCount > 0 ? errors / nodeCount : 0,
      nodeCount > 0 ? toolCalls / nodeCount : 0,
      cacheable > 0 ? cacheMisses / cacheable : 0,
    ],
  }
}

// ---------------------------------------------------------------------------
// 孤立森林
// ---------------------------------------------------------------------------

/** 孤立树节点：内部切分节点或叶子。 */
interface IsolationNode {
  /** 切分特征下标（叶子为 −1）。 */
  readonly featureIndex: number
  /** 切分阈值（叶子无意义）。 */
  readonly split: number
  readonly left?: IsolationNode
  readonly right?: IsolationNode
  /** 叶子大小（孤立森林 c(n) 调整用）。 */
  readonly size: number
}

/** mulberry32 种子化 PRNG（结果可复算）。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 构建一棵孤立树（递归，高度受限）。 */
function buildTree(
  points: readonly (readonly number[])[],
  height: number,
  heightLimit: number,
  rng: () => number,
): IsolationNode {
  if (height >= heightLimit || points.length <= 1) {
    return { featureIndex: -1, split: 0, size: points.length }
  }
  const dimensions = points[0].length
  // 随机选一个在该维度上有方差的特征。
  const order = [...Array(dimensions).keys()]
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = order[i]
    order[i] = order[j]
    order[j] = tmp
  }
  let chosen = -1
  let min = 0
  let max = 0
  for (const dim of order) {
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (const point of points) {
      if (point[dim] < lo) lo = point[dim]
      if (point[dim] > hi) hi = point[dim]
    }
    if (hi > lo) {
      chosen = dim
      min = lo
      max = hi
      break
    }
  }
  if (chosen < 0) {
    // 全部点相同：无法再分。
    return { featureIndex: -1, split: 0, size: points.length }
  }
  const split = min + rng() * (max - min)
  const left: number[][] = []
  const right: number[][] = []
  for (const point of points) {
    if (point[chosen] < split) left.push([...point])
    else right.push([...point])
  }
  if (left.length === 0 || right.length === 0) {
    // 极端阈值退化为叶（防死循环）。
    return { featureIndex: -1, split: 0, size: points.length }
  }
  return {
    featureIndex: chosen,
    split,
    left: buildTree(left, height + 1, heightLimit, rng),
    right: buildTree(right, height + 1, heightLimit, rng),
    size: points.length,
  }
}

/** 单点在一棵树上的路径长度（叶子大小 >1 时补 c(size)）。 */
function pathLength(point: readonly number[], node: IsolationNode, depth: number): number {
  if (node.featureIndex < 0 || !node.left || !node.right) {
    return depth + harmonicAdjustment(node.size)
  }
  return point[node.featureIndex] < node.split
    ? pathLength(point, node.left, depth + 1)
    : pathLength(point, node.right, depth + 1)
}

/** c(n) = 2·H(n−1) − 2(n−1)/n（平均搜索路径长度，H 为调和数）。 */
function harmonicAdjustment(size: number): number {
  if (size <= 1) return 0
  let harmonic = 0
  for (let i = 1; i <= size - 1; i += 1) harmonic += 1 / i
  return 2 * harmonic - (2 * (size - 1)) / size
}

/** 评分数组：s(x) = 2^(−E[h]/c(ψ))。 */
function anomalyScores(points: readonly (readonly number[])[], trees: readonly IsolationNode[], subsampleSize: number): number[] {
  const cPsi = harmonicAdjustment(subsampleSize) || 1
  return points.map((point) => {
    let total = 0
    for (const tree of trees) total += pathLength(point, tree, 0)
    const average = total / trees.length
    return Math.pow(2, -average / cPsi)
  })
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 孤立森林异常检测：轨迹集合 → 异常分排行 + 驱动特征。
 * 轨迹 < MIN_TRACES 条时不输出结论（样本不足）。
 */
export function detectTraceAnomalies(
  traces: readonly Trace[],
  limit: number = DEFAULT_LIMIT,
  seed: number = 0x1f0_e57,
): AnomalyReport {
  const features = traces.map(extractFeatures).filter((f) => f.values.length === TRACE_FEATURES.length)
  const count = features.length
  const trees = TREE_COUNT
  const subsampleSize = Math.min(SUBSAMPLE_SIZE, count)
  if (count < MIN_TRACES) {
    return {
      traces: count,
      trees,
      subsampleSize,
      threshold: ANOMALY_THRESHOLD,
      anomalousCount: 0,
      entries: [],
      note: `轨迹数 ${count} < ${MIN_TRACES}，孤立森林需要更多样本才能区分「异常」与「稀少」`,
      summary: '样本不足，无异常结论。',
    }
  }

  // 各特征均值/标准差（z 分数用；孤树本身无需标准化，但证据需要）。
  const dimensions = TRACE_FEATURES.length
  const means = new Array<number>(dimensions).fill(0)
  const stds = new Array<number>(dimensions).fill(0)
  for (const feature of features) {
    feature.values.forEach((value, index) => {
      means[index] += value / count
    })
  }
  for (const feature of features) {
    feature.values.forEach((value, index) => {
      stds[index] += ((value - means[index]) ** 2) / count
    })
  }
  for (let i = 0; i < dimensions; i += 1) stds[i] = Math.sqrt(stds[i])

  // 建林：每棵树从 ψ 子样本出发。
  const rng = mulberry32(seed)
  const points = features.map((f) => f.values)
  const forest: IsolationNode[] = []
  const heightLimit = maxTreeHeight(subsampleSize)
  for (let t = 0; t < TREE_COUNT; t += 1) {
    const subsample: number[][] = []
    for (let i = 0; i < subsampleSize; i += 1) {
      subsample.push([...points[Math.floor(rng() * count)]])
    }
    forest.push(buildTree(subsample, 0, heightLimit, rng))
  }
  const scores = anomalyScores(points, forest, subsampleSize)

  const entries: TraceAnomalyEntry[] = features.map((feature, index) => {
    const zScores = TRACE_FEATURES.map((name, dim) => ({
      feature: name,
      label: FEATURE_LABELS[name],
      z: stds[dim] > 1e-9 ? Math.round(((feature.values[dim] - means[dim]) / stds[dim]) * 100) / 100 : 0,
    }))
    const drivers = zScores.filter((z) => Math.abs(z.z) >= 2).sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    const score = Math.round(scores[index] * 1000) / 1000
    return {
      traceId: feature.traceId,
      sessionId: feature.sessionId,
      startedAt: feature.startedAt,
      score,
      anomalous: score >= ANOMALY_THRESHOLD,
      zScores,
      drivers,
      evidence:
        drivers.length > 0
          ? `异常分 ${score.toFixed(3)}；驱动特征：${drivers
              .slice(0, 3)
              .map((d) => `${d.label} z=${d.z > 0 ? '+' : ''}${d.z}`)
              .join('、')}`
          : `异常分 ${score.toFixed(3)}；无单维越限（多维组合异常）`,
    }
  })
  entries.sort((a, b) => b.score - a.score)
  const anomalousCount = entries.filter((e) => e.anomalous).length
  const top = entries[0]
  return {
    traces: count,
    trees,
    subsampleSize,
    threshold: ANOMALY_THRESHOLD,
    anomalousCount,
    entries: entries.slice(0, Math.max(1, limit)),
    note: '',
    summary:
      `${count} 条轨迹 × ${TREE_COUNT} 棵孤立树（ψ=${subsampleSize}），` +
      `判异常 ${anomalousCount} 条（阈值 ${ANOMALY_THRESHOLD}）；` +
      (top ? `最异常：${top.traceId}（s=${top.score.toFixed(3)}，${top.drivers.map((d) => d.label).slice(0, 2).join('/') || '多维组合'}）` : ''),
  }
}
