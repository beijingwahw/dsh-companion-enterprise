/**
 * 模块 E 创新扩展：频谱根因定位（Spectrum-Based Fault Localization）。
 *
 * 前兆挖掘回答「失败之前会发生什么序列」；但序列命中只说明「相关」，
 * 不指认「元凶」。当失败已经发生，工程师的真实问题是：这批失败轨迹
 * 和成功轨迹相比，到底是哪个步骤出了问题？
 *
 * 方法论（SBFL，软件工程顶会二十年的经典谱系：Tarantula → Ochiai）：
 * 1. 频谱采集：把每条轨迹的成功/失败与「组件覆盖」组成 0/1 矩阵——
 *    组件 = 行为签名（kind:name，如 tool:http_request），一条轨迹
 *    覆盖某组件 = 含有该签名的节点；
 * 2. Ochiai 可疑度：sus(n) = failed(n) / √(totalFailed × (failed(n) +
 *    passed(n)))——同时满足「失败轨迹几乎都经过它」（高召回）与
 *    「成功轨迹几乎不经过它」（高区分度）的组件得分逼近 1；
 * 3. 差分画像：对可疑组件附上失败/成功轨迹中的耗时与重试率差分
 *    ——「同一工具在失败运行中平均慢 8 倍、重试率 60%」这种证据
 *    把统计可疑度翻译成可行动的工程线索；
 * 4. 根因裁定：failed 支持度与可疑度双达标才输出结论——
 *    小样本下宁可不指认，也不冤枉一个常规步骤（Ochiai 的
 *    √totalFailed 项天然压制只在个别失败中出现的偶发组件）。
 *
 * 纯函数模块：数据来自既有 TraceStore 与派生轨迹。
 */
import type { Trace, TraceNode, TraceNodeKind } from './types.js'
import { isFailedTrace } from './precursors.js'

/** 结论裁定：可疑度下限。 */
const VERDICT_MIN_SUSPICION = 0.6

/** 结论裁定：失败支持度下限（至少出现在这么多条失败轨迹中）。 */
const VERDICT_MIN_FAILED_COUNT = 2

/** 返回组件数上限。 */
const TOP_COMPONENTS = 20

/** 单组件画像。 */
export interface ComponentSuspicion {
  /** 行为签名（kind:name）。 */
  readonly component: string
  readonly kind: TraceNodeKind
  readonly name: string
  /** 覆盖该组件的失败轨迹数。 */
  readonly failedCount: number
  /** 覆盖该组件的成功轨迹数。 */
  readonly passedCount: number
  /** Ochiai 可疑度（0-1）。 */
  readonly suspiciousness: number
  /** 失败轨迹中该组件的平均耗时（毫秒）。 */
  readonly avgDurationInFailedMs: number
  /** 成功轨迹中该组件的平均耗时（毫秒；无样本为 0）。 */
  readonly avgDurationInPassedMs: number
  /** 失败轨迹中该组件的重试率（0-1）。 */
  readonly retryRateInFailed: number
  /** 人类可读的工程线索。 */
  readonly advice: string
}

/** 根因定位报告。 */
export interface LocalizationReport {
  /** 参与定位的轨迹总数（成功/失败）。 */
  readonly traces: { readonly ok: number; readonly failed: number }
  readonly failureRate: number
  /** 组件可疑度排行（降序，≤ TOP_COMPONENTS 条）。 */
  readonly components: readonly ComponentSuspicion[]
  /** 根因结论（证据不足时为 null）。 */
  readonly verdict: string | null
  /** 数据不足说明（verdict 为 null 时给出原因）。 */
  readonly note: string
}

/** 组件键：行为签名（kind:name，剥离状态与参数）。 */
export function componentKey(node: Pick<TraceNode, 'kind' | 'name'>): string {
  return `${node.kind}:${node.name}`
}

/** 组件累计器。 */
interface ComponentStats {
  kind: TraceNodeKind
  name: string
  failedCount: number
  passedCount: number
  durationInFailed: number
  durationInPassed: number
  durationSamplesInFailed: number
  durationSamplesInPassed: number
  retriesInFailed: number
}

/** 单组件可疑度 → 工程线索文案。 */
function buildAdvice(stats: ComponentStats, suspicion: number): string {
  const lines: string[] = []
  if (suspicion >= 0.5 && stats.passedCount === 0 && stats.failedCount >= 2) {
    lines.push('仅在失败轨迹中出现，且失败轨迹几乎都经过它——优先排查')
  }
  if (stats.durationSamplesInFailed > 0 && stats.durationSamplesInPassed > 0) {
    const failedAvg = stats.durationInFailed / stats.durationSamplesInFailed
    const passedAvg = stats.durationInPassed / stats.durationSamplesInPassed
    if (passedAvg > 0 && failedAvg >= passedAvg * 2) {
      lines.push(`失败运行中平均慢 ${(failedAvg / passedAvg).toFixed(1)} 倍`)
    }
  }
  if (stats.failedCount > 0 && stats.retriesInFailed / stats.failedCount >= 0.3) {
    lines.push(`失败运行中重试率 ${Math.round((stats.retriesInFailed / stats.failedCount) * 100)}%`)
  }
  if (lines.length === 0) lines.push('可疑度有限，保持观察')
  return lines.join('；')
}

/**
 * 频谱根因定位（纯函数）。
 * @param traces 历史轨迹集合（成功与失败对照语料）。
 */
export function localizeFaults(traces: readonly Trace[]): LocalizationReport {
  const okTraces: Trace[] = []
  const failedTraces: Trace[] = []
  for (const trace of traces) {
    if (trace.nodes.length === 0) continue
    if (isFailedTrace(trace)) failedTraces.push(trace)
    else okTraces.push(trace)
  }
  const totalFailed = failedTraces.length
  const totalOk = okTraces.length
  const total = totalFailed + totalOk
  const failureRate = total > 0 ? totalFailed / total : 0

  if (totalFailed === 0 || total === 0) {
    return {
      traces: { ok: totalOk, failed: totalFailed },
      failureRate,
      components: [],
      verdict: null,
      note:
        total === 0
          ? '没有可分析的轨迹'
          : '语料中没有失败轨迹——根因定位需要成功与失败两组对照样本',
    }
  }

  // 频谱采集：组件 → 成功/失败覆盖计数 + 差分画像累计。
  const stats = new Map<string, ComponentStats>()
  const bump = (trace: Trace, failed: boolean): void => {
    const seen = new Set<string>()
    for (const node of trace.nodes) {
      const key = componentKey(node)
      let entry = stats.get(key)
      if (!entry) {
        entry = {
          kind: node.kind,
          name: node.name,
          failedCount: 0,
          passedCount: 0,
          durationInFailed: 0,
          durationInPassed: 0,
          durationSamplesInFailed: 0,
          durationSamplesInPassed: 0,
          retriesInFailed: 0,
        }
        stats.set(key, entry)
      }
      // 同一轨迹内同名组件只计一次覆盖（频谱是集合语义）。
      if (!seen.has(key)) {
        seen.add(key)
        if (failed) entry.failedCount += 1
        else entry.passedCount += 1
        if (node.attempts > 1 || node.status === 'retry') {
          if (failed) entry.retriesInFailed += 1
        }
      }
      // 耗时与重试按节点累计（均值用样本数除）。
      if (failed) {
        entry.durationInFailed += node.durationMs
        entry.durationSamplesInFailed += 1
      } else {
        entry.durationInPassed += node.durationMs
        entry.durationSamplesInPassed += 1
      }
    }
  }
  for (const trace of failedTraces) bump(trace, true)
  for (const trace of okTraces) bump(trace, false)

  // Ochiai 可疑度。
  const components: ComponentSuspicion[] = []
  for (const entry of stats.values()) {
    if (entry.failedCount === 0) continue
    const suspiciousness =
      entry.failedCount / Math.sqrt(totalFailed * (entry.failedCount + entry.passedCount))
    components.push({
      component: `${entry.kind}:${entry.name}`,
      kind: entry.kind,
      name: entry.name,
      failedCount: entry.failedCount,
      passedCount: entry.passedCount,
      suspiciousness: Math.round(suspiciousness * 1000) / 1000,
      avgDurationInFailedMs:
        entry.durationSamplesInFailed > 0
          ? Math.round(entry.durationInFailed / entry.durationSamplesInFailed)
          : 0,
      avgDurationInPassedMs:
        entry.durationSamplesInPassed > 0
          ? Math.round(entry.durationInPassed / entry.durationSamplesInPassed)
          : 0,
      retryRateInFailed:
        entry.failedCount > 0
          ? Math.round((entry.retriesInFailed / entry.failedCount) * 1000) / 1000
          : 0,
      advice: buildAdvice(entry, suspiciousness),
    })
  }
  components.sort((a, b) => b.suspiciousness - a.suspiciousness || b.failedCount - a.failedCount)
  const top = components.slice(0, TOP_COMPONENTS)

  // 根因裁定：双达标才指认（防小样本冤案）。
  const prime = top.find(
    (c) => c.suspiciousness >= VERDICT_MIN_SUSPICION && c.failedCount >= VERDICT_MIN_FAILED_COUNT,
  )
  const verdict = prime
    ? `「${prime.component}」高度可疑：${prime.failedCount}/${totalFailed} 条失败轨迹覆盖` +
      (prime.passedCount === 0
        ? '，且成功轨迹零覆盖'
        : `（成功轨迹仅 ${prime.passedCount} 条覆盖）`) +
      `；${prime.advice}`
    : null
  const note = prime
    ? '按可疑度降序排列；建议优先复核结论指认的组件'
    : '可疑度均未达裁定阈值（样本不足或失败原因分散），排行仅作参考'

  return {
    traces: { ok: totalOk, failed: totalFailed },
    failureRate: Math.round(failureRate * 1000) / 1000,
    components: top,
    verdict,
    note,
  }
}
