/**
 * 模块 G 创新扩展：模型漂移监控（金丝雀探针 + 分布距离）。
 *
 * 现实痛点：LLM 厂商静默更新模型（价格页没变、名字没变、行为变了）。
 * 一次性排行榜会在模型变化后悄悄失效，用户却毫无感知，直到某天生产
 * 输出劣化才追查——这是 MLOps 里经典的"训练-服务偏移"问题在 LLM 时代
 * 的翻版（模型即服务，服务即黑盒）。
 *
 * 方案（借鉴 SRE 金丝雀发布 + 统计过程控制的成熟实践）：
 * 1. 金丝雀探针组：一组确定性小探针（算术/结构化 JSON/信息抽取/代码/
 *    指令遵循/原文复述），输出被约束得极窄，天然低方差，适合做指纹；
 * 2. 首次运行建立基线（延迟分布/通过率/输出长度/风格指纹），此后每次
 *    运行与基线做分布距离比对：
 *    - 延迟：双样本 Kolmogorov–Smirnov 统计量（对分布形状敏感，
 *      均值不变但方差放大也能检出）；
 *    - 通过率：两比例 z 检验（合并方差，检出能力劣化）；
 *    - 输出长度：均值比 + KS（检出啰嗦度变化，常见于换底座）；
 *    - 风格指纹：字符 3-gram shingle 集合的 Jaccard 相似度
 *      （检出"同一个名字下换了模型"这类最隐蔽的漂移）；
 * 3. 三档判定 stable / warning / drifted，每个维度给出统计量与解释，
 *    确认模型确实更新后可重置基线（与金丝雀发布的"提升基线"同构）。
 */
import type { Domain } from '../../core/storage-adapter.js'
import { round4 } from '../../core/pricing.js'
import { meanOf, medianOf } from '../../core/stats.js'
import { jaccardText } from '../../core/text.js'

// ---------------------------------------------------------------------------
// 金丝雀探针组
// ---------------------------------------------------------------------------

/** 单个金丝雀探针。 */
export interface CanaryProbe {
  readonly id: string
  readonly description: string
  readonly prompt: string
  /** 通过判定（输出为空/失败调用一律不通过）。 */
  readonly check: (output: string) => boolean
}

/** 内置探针组：六类基础能力，输出被约束得极窄以保证指纹稳定。 */
export const CANARY_PROBES: readonly CanaryProbe[] = [
  {
    id: 'arithmetic',
    description: '算术：17×23',
    prompt: '计算 17×23，只输出最终数字，不要任何其他内容。',
    check: (output) => /391/.test(output.replace(/[\s,，]/g, '')),
  },
  {
    id: 'json-shape',
    description: '结构化输出：JSON 对象',
    prompt: '输出一个 JSON 对象，恰好包含字段 "a"（值为 1）和 "b"（值为 2），不要输出 JSON 以外的任何内容。',
    check: (output) => {
      const trimmed = output.trim().replace(/^```(?:json)?|```$/g, '').trim()
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (typeof parsed !== 'object' || parsed === null) return false
        const record = parsed as Record<string, unknown>
        return record.a === 1 && record.b === 2
      } catch {
        return false
      }
    },
  },
  {
    id: 'extraction',
    description: '信息抽取：人名',
    prompt: '从句子「张三于2024年1月1日在北京入职」中提取人名，只输出人名本身。',
    check: (output) => output.includes('张三'),
  },
  {
    id: 'code-gen',
    description: '代码生成：add 函数',
    prompt: '写一个 Python 函数 add(a, b) 返回两数之和。只输出函数定义，不要解释。',
    check: (output) => /def\s+add\s*\(/.test(output) && /return/.test(output),
  },
  {
    id: 'instruction-following',
    description: '指令遵循：超短回答',
    prompt: '用不超过10个字回答：天空通常是什么颜色？',
    check: (output) => output.includes('蓝') && output.length <= 20,
  },
  {
    id: 'verbatim-copy',
    description: '原文复述：canary token',
    prompt: '请原样复述以下标记，不要添加任何其他内容：DRIFT-CANARY-X7Q',
    check: (output) => output.includes('DRIFT-CANARY-X7Q'),
  },
]

// ---------------------------------------------------------------------------
// 存储模型
// ---------------------------------------------------------------------------

/** 单探针执行结果。 */
export interface ProbeResult {
  readonly probeId: string
  readonly ok: boolean
  readonly latencyMs: number
  readonly outputChars: number
}

/** 一次完整探针运行（全部探针）。 */
export interface ProbeRun {
  readonly ts: number
  readonly results: readonly ProbeResult[]
  /** 各探针原始输出（短文本，作风格指纹比对）。 */
  readonly outputs: readonly string[]
}

/** 每个模型的金丝雀记录。 */
export interface CanaryRecord {
  readonly model: string
  /** 基线运行（首次成功运行；模型确认更新后可重置）。 */
  readonly baseline?: ProbeRun
  /** 基线之后的运行（新→旧？否：旧→新，封顶 HISTORY_CAP 条）。 */
  readonly history: readonly ProbeRun[]
}

/** 历史运行封顶（防无限膨胀；足够支撑分布比对）。 */
export const HISTORY_CAP = 30

/** 金丝雀记录仓库（'arena-canary' 表：model → CanaryRecord）。 */
export class CanaryStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<CanaryRecord>('arena-canary')
  }

  get(model: string): CanaryRecord | undefined {
    return this.table.get(model)
  }

  /** 全部受监控模型的记录（按模型名排序）。 */
  list(): CanaryRecord[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
  }

  async save(record: CanaryRecord): Promise<void> {
    await this.table.put(record.model, record)
  }

  async delete(model: string): Promise<void> {
    await this.table.delete(model)
  }
}

// ---------------------------------------------------------------------------
// 统计原语
// ---------------------------------------------------------------------------

/** 双样本 Kolmogorov–Smirnov 统计量（0-1：两样本经验分布最大间距）。 */
export function ksStatistic(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const sorted = [...a, ...b].sort((x, y) => x - y)
  let maxGap = 0
  for (const value of sorted) {
    const cdfA = a.filter((x) => x <= value).length / a.length
    const cdfB = b.filter((x) => x <= value).length / b.length
    maxGap = Math.max(maxGap, Math.abs(cdfA - cdfB))
  }
  return maxGap
}

/** 两比例 z 检验（合并方差；返回 z 值，正=近期劣化）。 */
export function twoProportionZ(
  baselinePasses: number,
  baselineTotal: number,
  recentPasses: number,
  recentTotal: number,
): number {
  if (baselineTotal === 0 || recentTotal === 0) return 0
  const p1 = baselinePasses / baselineTotal
  const p2 = recentPasses / recentTotal
  const pooled = (baselinePasses + recentPasses) / (baselineTotal + recentTotal)
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / baselineTotal + 1 / recentTotal))
  return se === 0 ? 0 : (p1 - p2) / se
}

/** Jaccard 相似度（两文本 shingle 集合交集/并集；空集约定 1）。共享实现见 core/text.ts。 */
export function shingleJaccard(a: string, b: string): number {
  return jaccardText(a, b)
}

// ---------------------------------------------------------------------------
// 漂移分析
// ---------------------------------------------------------------------------

/** 单维度漂移信号。 */
export interface DriftDimension {
  /** latency=延迟分布；pass-rate=能力通过率；length=输出长度；style=风格指纹。 */
  readonly name: 'latency' | 'pass-rate' | 'length' | 'style'
  /** 统计量（各维度含义不同，见 detail）。 */
  readonly statistic: number
  /** 判定阈值（drifted 阈值）。 */
  readonly threshold: number
  /** stable / warning / drifted。 */
  readonly level: 'stable' | 'warning' | 'drifted'
  /** 人类可读解释。 */
  readonly detail: string
}

/** 漂移报告。 */
export interface DriftReport {
  readonly model: string
  readonly baselineTs: number
  readonly runsCompared: number
  readonly dimensions: readonly DriftDimension[]
  /** 任一维度 drifted → drifted；任一 warning → warning；否则 stable。 */
  readonly verdict: 'stable' | 'warning' | 'drifted'
  readonly summary: string
}

/** 阈值表（KS/z/长度比/Jaccard 的 drifted 与 warning 双档）。 */
const THRESHOLDS = {
  latency: { drifted: 0.5, warning: 0.35 },
  passRate: { drifted: 2.58, warning: 1.96 },
  lengthRatio: { drifted: 1.5, warning: 1.33 },
  style: { drifted: 0.25, warning: 0.4 },
} as const

/**
 * 对金丝雀记录执行漂移分析（基线 vs 基线后全部历史运行）。
 * 无基线或历史不足时返回 stable 的占位报告（不具统计意义）。
 */
export function analyzeDrift(record: CanaryRecord): DriftReport {
  const baseline = record.baseline
  if (!baseline) {
    return {
      model: record.model,
      baselineTs: 0,
      runsCompared: 0,
      dimensions: [],
      verdict: 'stable',
      summary: '尚无基线：请先运行一次金丝雀探针建立基线',
    }
  }
  const history = record.history.filter((run) => run.ts !== baseline.ts)
  if (history.length === 0) {
    return {
      model: record.model,
      baselineTs: baseline.ts,
      runsCompared: 0,
      dimensions: [],
      verdict: 'stable',
      summary: '基线已建立，尚无后续运行可比对；再运行一次即可开始漂移监控',
    }
  }

  // 汇聚样本（跨探针、跨运行）：延迟与输出长度是全体样本；
  // 通过率是全体探针×运行的计数；风格指纹是全体输出拼接。
  const baselineLatencies: number[] = []
  const recentLatencies: number[] = []
  const baselineLengths: number[] = []
  const recentLengths: number[] = []
  let baselinePasses = 0
  let baselineTotal = 0
  let recentPasses = 0
  let recentTotal = 0
  for (const result of baseline.results) {
    baselineLatencies.push(result.latencyMs)
    baselineLengths.push(result.outputChars)
    baselineTotal += 1
    if (result.ok) baselinePasses += 1
  }
  for (const run of history) {
    for (const result of run.results) {
      recentLatencies.push(result.latencyMs)
      recentLengths.push(result.outputChars)
      recentTotal += 1
      if (result.ok) recentPasses += 1
    }
  }
  const baselineText = baseline.outputs.join('\n')
  const recentText = history.flatMap((run) => [...run.outputs]).join('\n')

  const dimensions: DriftDimension[] = []

  // 1. 延迟分布：KS 统计量（均值不变但方差放大也可检出）。
  const latencyKs = ksStatistic(baselineLatencies, recentLatencies)
  dimensions.push({
    name: 'latency',
    statistic: round4(latencyKs),
    threshold: THRESHOLDS.latency.drifted,
    level: levelOf(latencyKs > THRESHOLDS.latency.drifted, latencyKs > THRESHOLDS.latency.warning),
    detail: `延迟分布 KS 距离 ${round4(latencyKs)}（基线中位 ${medianOf(baselineLatencies)}ms → 近期中位 ${medianOf(recentLatencies)}ms）`,
  })

  // 2. 能力通过率：两比例 z 检验（z>0 = 近期更差）。
  const z = twoProportionZ(baselinePasses, baselineTotal, recentPasses, recentTotal)
  const baselineRate = baselineTotal > 0 ? baselinePasses / baselineTotal : 0
  const recentRate = recentTotal > 0 ? recentPasses / recentTotal : 0
  dimensions.push({
    name: 'pass-rate',
    statistic: round4(z),
    threshold: THRESHOLDS.passRate.drifted,
    level: levelOf(z > THRESHOLDS.passRate.drifted, z > THRESHOLDS.passRate.warning),
    detail: `通过率 ${pct(baselineRate)} → ${pct(recentRate)}（z=${round4(z)}，正=劣化）`,
  })

  // 3. 输出长度：均值比（>1=近期更长；换底座常见啰嗦度变化）。
  const baselineMeanLen = meanOf(baselineLengths)
  const recentMeanLen = meanOf(recentLengths)
  const lengthRatio = baselineMeanLen > 0 ? recentMeanLen / baselineMeanLen : 1
  const lengthDrift = lengthRatio > THRESHOLDS.lengthRatio.drifted || lengthRatio < 1 / THRESHOLDS.lengthRatio.drifted
  const lengthWarn = lengthRatio > THRESHOLDS.lengthRatio.warning || lengthRatio < 1 / THRESHOLDS.lengthRatio.warning
  dimensions.push({
    name: 'length',
    statistic: round4(lengthRatio),
    threshold: THRESHOLDS.lengthRatio.drifted,
    level: levelOf(lengthDrift, lengthWarn),
    detail: `平均输出长度 ${Math.round(baselineMeanLen)} → ${Math.round(recentMeanLen)} 字符（比值 ${round4(lengthRatio)}）`,
  })

  // 4. 风格指纹：shingle Jaccard（低=同名模型被替换的强信号）。
  const jaccard = shingleJaccard(baselineText, recentText)
  dimensions.push({
    name: 'style',
    statistic: round4(jaccard),
    threshold: THRESHOLDS.style.drifted,
    level: levelOf(jaccard < THRESHOLDS.style.drifted, jaccard < THRESHOLDS.style.warning),
    detail: `风格指纹 Jaccard 相似度 ${round4(jaccard)}（基线 vs 近期探针输出的 3-gram 重合度）`,
  })

  const verdict: DriftReport['verdict'] = dimensions.some((d) => d.level === 'drifted')
    ? 'drifted'
    : dimensions.some((d) => d.level === 'warning')
      ? 'warning'
      : 'stable'
  const summary =
    verdict === 'drifted'
      ? `检测到模型漂移：${dimensions.filter((d) => d.level === 'drifted').map((d) => d.detail).join('；')}。建议排查厂商是否静默更新；确认后可重置基线`
      : verdict === 'warning'
        ? `出现早期漂移信号：${dimensions.filter((d) => d.level === 'warning').map((d) => d.detail).join('；')}。建议加密探针频次观察`
        : '模型行为与基线一致，未检测到漂移'

  return {
    model: record.model,
    baselineTs: baseline.ts,
    runsCompared: history.length,
    dimensions,
    verdict,
    summary,
  }
}

/** 三档判定。 */
function levelOf(drifted: boolean, warning: boolean): DriftDimension['level'] {
  return drifted ? 'drifted' : warning ? 'warning' : 'stable'
}

/** 中位数与均值的共享实现见 core/stats.ts。 */

/** 百分比文案。 */
function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`
}
