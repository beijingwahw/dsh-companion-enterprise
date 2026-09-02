/**
 * 模块 E 创新扩展：失败前兆挖掘（Failure Precursor Mining）。
 *
 * 异常检测（analyzer.ts）在失败「发生时」标注；SPC（spc.ts）在指标
 * 「漂移后」告警——两者都是事后。前兆挖掘回答的是事前问题：
 * 「这条正在执行的轨迹，是否正走在一条已知的失败之路上？」
 *
 * 方法论（序列模式挖掘，APM 故障预测的经典范式）：
 * 1. 事件编码：轨迹节点序列 → 符号序列（`tool:write:error` 等），
 *    剥离具体参数只留「行为签名」，使跨轨迹的模式可比较；
 * 2. n-gram 统计：在失败轨迹与成功轨迹两个语料上分别统计
 *    2~4 阶 n-gram 频次；
 * 3. 提升度筛选：lift = P(n-gram | 失败) / P(n-gram | 成功)——
 *    只在失败轨迹中高频、成功轨迹中罕见的序列才是有效前兆，
 *    而非普遍执行的常规动作（如「读文件→写文件」）；
 * 4. 实时预警：进行中轨迹的尾部 n-gram 与前兆库匹配，
 *    给出风险分与「再走几步可能踩坑」的提前量。
 *
 * 纯函数模块：数据来自既有 TraceStore（派生 + 摄入轨迹）。
 */
import type { Trace, TraceNode } from './types.js'

/** 挖掘的 n-gram 阶数范围。 */
const NGRAM_MIN = 2
const NGRAM_MAX = 4

/** 前兆入库最小失败支持度（至少出现在这么比例的失败轨迹中）。 */
const MIN_FAIL_SUPPORT = 0.2

/** 前兆入库最小提升度。 */
const MIN_LIFT = 2

/** 返回的前兆数量上限。 */
const TOP_PRECURSORS = 20

/** 预警风险分权重：前兆覆盖度 × 提升度归一。 */
const ALERT_BASE_SCORE = 40

/** 单条失败前兆模式。 */
export interface PrecursorPattern {
  /** 事件签名序列（如 ['tool:read:ok', 'model:chat:retry']）。 */
  readonly signature: readonly string[]
  /** P(模式 | 失败轨迹)。 */
  readonly failSupport: number
  /** P(模式 | 成功轨迹)。 */
  readonly okSupport: number
  /** 提升度 = failSupport / max(okSupport, ε)。 */
  readonly lift: number
  /** 该模式之后最常见的下一步失败事件（预警提示用）。 */
  readonly typicalNext: string | null
}

/** 挖掘报告。 */
export interface PrecursorReport {
  /** 参与挖掘的轨迹总数（成功/失败）。 */
  readonly traces: { readonly ok: number; readonly failed: number }
  /** 失败轨迹占比。 */
  readonly failureRate: number
  /** 前兆库（按 lift 降序，≤ TOP_PRECURSORS 条）。 */
  readonly patterns: readonly PrecursorPattern[]
}

/** 实时预警结果。 */
export interface PrecursorAlert {
  /** 命中的前兆模式（当前轨迹尾部是其后缀或完整出现）。 */
  readonly pattern: PrecursorPattern
  /** 已匹配到的前缀长度（1=刚开始匹配）。 */
  readonly matchedLength: number
  /** 模式总长。 */
  readonly patternLength: number
  /** 风险分 0~100：越接近模式终点、提升度越高分越高。 */
  readonly risk: number
  /** 预测的下一步事件。 */
  readonly predictedNext: string | null
}

/** 对进行中轨迹的预警结果。 */
export interface LiveCheckResult {
  /** 当前轨迹的事件签名序列。 */
  readonly signature: readonly string[]
  /** 命中的预警（按风险降序）。 */
  readonly alerts: readonly PrecursorAlert[]
  /** 综合风险分（各预警取衰减最大值）。 */
  readonly risk: number
  /** 综合建议。 */
  readonly advice: string
}

/** 节点 → 事件签名（`kind:name:status`；剥参数留行为指纹）。 */
export function nodeSignature(node: TraceNode): string {
  return `${node.kind}:${node.name}:${node.status}`
}

/** 轨迹失败判定：存在 error 节点，或尾节点为 error/retry。 */
export function isFailedTrace(trace: Trace): boolean {
  return trace.nodes.some((n) => n.status === 'error')
}

/**
 * 挖掘失败前兆库。
 * @param traces 历史轨迹集合（派生 + 摄入均可）。
 */
export function minePrecursors(traces: readonly Trace[]): PrecursorReport {
  const okTraces: string[][] = []
  const failedTraces: string[][] = []
  for (const trace of traces) {
    if (trace.nodes.length < NGRAM_MIN) continue
    const seq = trace.nodes.map(nodeSignature)
    if (isFailedTrace(trace)) failedTraces.push(seq)
    else okTraces.push(seq)
  }
  const total = okTraces.length + failedTraces.length
  if (failedTraces.length === 0 || total === 0) {
    return { traces: { ok: okTraces.length, failed: failedTraces.length }, failureRate: 0, patterns: [] }
  }
  // n-gram 频次表：signature.join(' → ') → 出现该 n-gram 的轨迹数。
  const failCounts = countNgrams(failedTraces)
  const okCounts = countNgrams(okTraces)
  const patterns: PrecursorPattern[] = []
  for (const [key, failHit] of failCounts) {
    const signature = key.split(' → ')
    const failSupport = failHit / failedTraces.length
    const okHit = okCounts.get(key) ?? 0
    const okSupport = okTraces.length > 0 ? okHit / okTraces.length : 0
    // 提升度：对成功支持度做拉普拉斯平滑，避免除零放大噪声。
    const lift = failSupport / (okSupport + 0.02)
    if (failSupport < MIN_FAIL_SUPPORT || lift < MIN_LIFT) continue
    // 后继统计：失败语料中该 n-gram 之后最常出现的事件。
    const typicalNext = typicalNextEvent(failedTraces, signature)
    patterns.push({ signature, failSupport, okSupport, lift, typicalNext })
  }
  patterns.sort((a, b) => b.lift * b.failSupport - a.lift * a.failSupport)
  return {
    traces: { ok: okTraces.length, failed: failedTraces.length },
    failureRate: Math.round((failedTraces.length / total) * 100) / 100,
    patterns: patterns.slice(0, TOP_PRECURSORS),
  }
}

/**
 * 对一条（进行中的）轨迹做前兆预警。
 * @param patternLibrary 前兆库（来自 minePrecursors）。
 * @param nodes 进行中轨迹的已发生节点。
 */
export function checkPrecursors(
  patternLibrary: readonly PrecursorPattern[],
  nodes: readonly TraceNode[],
): LiveCheckResult {
  const signature = nodes.map(nodeSignature)
  const alerts: PrecursorAlert[] = []
  for (const pattern of patternLibrary) {
    const len = pattern.signature.length
    // 检查模式是否正在轨迹尾部「逐步成形」：
    // 取模式的每个前缀，看轨迹尾部是否恰以该前缀结尾。
    for (let matched = len; matched >= 1; matched -= 1) {
      const prefix = pattern.signature.slice(0, matched)
      if (endsWith(signature, prefix)) {
        // 完整出现（matched=len）：模式已完整走出，属于「已入坑边缘」；
        // 部分匹配：正走在模式中段，还能提前掉头。
        const progress = matched / len
        const risk = Math.min(
          100,
          Math.round(ALERT_BASE_SCORE * progress + Math.min(40, pattern.lift * 8)),
        )
        alerts.push({
          pattern,
          matchedLength: matched,
          patternLength: len,
          risk,
          predictedNext: matched < len ? pattern.signature[matched] : pattern.typicalNext,
        })
        break
      }
    }
  }
  alerts.sort((a, b) => b.risk - a.risk)
  // 综合风险：取最大单预警分（多预警并发时不线性叠加，避免虚高）。
  const risk = alerts.length > 0 ? alerts[0].risk : 0
  const advice =
    alerts.length === 0
      ? '当前轨迹未命中任何已知失败前兆，可继续执行。'
      : `当前轨迹正在复现已知失败模式「${alerts[0].pattern.signature.join(' → ')}」` +
        `（提升度 ${alerts[0].pattern.lift.toFixed(1)}×）` +
        (alerts[0].predictedNext
          ? `，若继续执行预计出现「${alerts[0].predictedNext}」，建议检查该环节后再生成的下一步。`
          : '，模式已完整走出，建议立即人工复核。')
  return { signature, alerts: alerts.slice(0, 5), risk, advice }
}

// --------------------------------------------------------------------
// 辅助
// --------------------------------------------------------------------

/** 统计各 n-gram 出现于多少条轨迹（按轨迹去重，非出现次数）。 */
function countNgrams(seqs: readonly string[][]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const seq of seqs) {
    const seen = new Set<string>()
    for (let n = NGRAM_MIN; n <= NGRAM_MAX; n += 1) {
      for (let i = 0; i + n <= seq.length; i += 1) {
        seen.add(seq.slice(i, i + n).join(' → '))
      }
    }
    for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** 失败语料中，紧跟指定模式之后最常出现的事件。 */
function typicalNextEvent(seqs: readonly string[][], pattern: readonly string[]): string | null {
  const key = pattern.join(' → ')
  const nextCounts = new Map<string, number>()
  const len = pattern.length
  for (const seq of seqs) {
    for (let i = 0; i + len < seq.length; i += 1) {
      if (seq.slice(i, i + len).join(' → ') === key) {
        const next = seq[i + len]
        nextCounts.set(next, (nextCounts.get(next) ?? 0) + 1)
      }
    }
  }
  let best: string | null = null
  let bestCount = 0
  for (const [event, count] of nextCounts) {
    if (count > bestCount) {
      best = event
      bestCount = count
    }
  }
  return best
}

/** 序列是否以指定后缀结尾。 */
function endsWith(seq: readonly string[], suffix: readonly string[]): boolean {
  if (suffix.length > seq.length) return false
  const offset = seq.length - suffix.length
  for (let i = 0; i < suffix.length; i += 1) {
    if (seq[offset + i] !== suffix[i]) return false
  }
  return true
}
