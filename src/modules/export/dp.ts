/**
 * 模块 A 创新扩展：差分隐私统计导出（Differential Privacy Export）。
 *
 * Merkle 导出让「交付的每一份都没被篡改」；k-匿名让「发布的每行
 * 记录都无法指认个人」。但团队经常需要的不是发布明细，而是发布
 * 统计——「我们上个月处理了 X 个会话、命中 Y 次敏感扫描」。
 * 统计也会泄露个体：差分隐私（Cynthia Dwork, 2006；2017 年
 * Gödel 奖；2020 年美国人口普查、Apple/Google 的工业标准）给出了
 * 目前唯一有数学证明的口径：
 *
 *   发布结果 M 满足 ε-差分隐私 ⟺ 任一单个个体的数据在/不在数据集
 *   中，M 的任何输出概率之比 ≤ e^ε——攻击者无法从发布结果反推
 *   任何个体的存在。
 *
 * 实现两件套：
 * 1. Laplace 机制：对每个统计量加 Laplace(0, b) 噪声，b = 敏感度/ε
 *    （计数的敏感度 = 1：一个人在/不在最多改变计数 1）。计数类
 *    结果做取整与非负后处理（后处理免疫：DP 结果再加工不损失保证）；
 * 2. ε 预算账本（privacy accountant）：顺序组合定理——多次释放的
 *    总隐私损失 ≤ Σε_i。每次释放记账，预算耗尽即拒绝释放：
 *    「还能再发布几次」从此是可计算的数字，而不是侥幸。
 *
 * 随机源刻意不设种子：同一指标重复释放必须产生独立噪声并各自
 * 消耗预算——可复现的噪声等于零隐私（组合攻击正等着它）。
 */
import type { Domain } from '../../core/storage-adapter.js'

/** 隐私预算记录键（'export-dp-budget' 表唯一键）。 */
const BUDGET_KEY = '__ledger__'

/** 缺省总预算 ε（相当于十几次 0.25ε 级发布的年吞吐）。 */
export const DEFAULT_EPSILON_BUDGET = 3

/** 单次释放缺省 ε。 */
export const DEFAULT_RELEASE_EPSILON = 0.25

/** ε 合法范围。 */
const MIN_EPSILON = 0.01
const MAX_EPSILON = 2

/** 单次释放指标条数上限。 */
const MAX_METRICS = 50

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

/** 待释放的单个统计量。 */
export interface DpMetricInput {
  /** 统计名（如 "sessions.total"）。 */
  readonly key: string
  /** 真值（只进不出的本地量）。 */
  readonly value: number
  /** 敏感度（缺省：计数类 1）。 */
  readonly sensitivity?: number
  /** count=整数计数（取整、非负后处理）；sum=求和（保留小数）。 */
  readonly kind?: 'count' | 'sum'
}

/** 已释放的统计量（不含真值）。 */
export interface DpReleasedMetric {
  readonly key: string
  /** 加噪后的发布值（count 已取整非负）。 */
  readonly released: number
  /** 噪声尺度 b = 敏感度/ε。 */
  readonly scale: number
  readonly sensitivity: number
}

/** 单次释放的账本条目。 */
export interface DpReleaseRecord {
  readonly id: string
  readonly ts: number
  readonly epsilon: number
  readonly metrics: readonly string[]
}

/** 预算账本（'export-dp-budget' 表 BUDGET_KEY 记录）。 */
export interface DpLedgerRecord {
  readonly kind: 'ledger'
  readonly budgetEpsilon: number
  readonly spentEpsilon: number
  readonly releases: readonly DpReleaseRecord[]
  readonly updatedAt: number
}

/** 释放结果（未被拒绝时）。 */
export interface DpReleaseSuccess {
  readonly refused: false
  readonly releaseId: string
  /** 本次消耗的 ε。 */
  readonly epsilon: number
  readonly metrics: readonly DpReleasedMetric[]
  readonly spentEpsilon: number
  readonly budgetEpsilon: number
  readonly remainingEpsilon: number
  readonly note: string
}

/** 预算耗尽的拒绝结果。 */
export interface DpReleaseRefusal {
  readonly refused: true
  readonly reason: string
  readonly requestedEpsilon: number
  readonly spentEpsilon: number
  readonly budgetEpsilon: number
  readonly remainingEpsilon: number
}

export type DpReleaseOutcome = DpReleaseSuccess | DpReleaseRefusal

// ---------------------------------------------------------------------------
// Laplace 机制（纯函数）
// ---------------------------------------------------------------------------

/**
 * Laplace(0, scale) 抽样：逆 CDF 变换。
 * scale ≤ 0 时返回 0（敏感度为 0 的统计无需加噪）。
 */
export function laplaceNoise(scale: number, rng: () => number = Math.random): number {
  if (scale <= 0) return 0
  const u = rng() - 0.5
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u))
}

/**
 * 单值 DP 释放：噪声尺度 b = 敏感度/ε；
 * count 类做取整与非负后处理（后处理免疫）。
 */
export function dpReleaseValue(
  value: number,
  sensitivity: number,
  epsilon: number,
  kind: 'count' | 'sum' = 'count',
  rng: () => number = Math.random,
): { released: number; noise: number; scale: number } {
  const scale = sensitivity / epsilon
  const noise = laplaceNoise(scale, rng)
  const noisy = value + noise
  const released = kind === 'count' ? Math.max(0, Math.round(noisy)) : Math.round(noisy * 10_000) / 10_000
  return { released, noise, scale: Math.round(scale * 1e6) / 1e6 }
}

// ---------------------------------------------------------------------------
// 预算账本仓库
// ---------------------------------------------------------------------------

/** 差分隐私释放仓库（'export-dp-budget' 表）。 */
export class DpBudgetStore {
  private readonly table

  constructor(
    domain: Domain,
    private readonly now: () => number = Date.now,
  ) {
    this.table = domain.table<DpLedgerRecord>('export-dp-budget')
  }

  /** 当前账本（无记录给初始空态）。 */
  private ledger(): DpLedgerRecord {
    return (
      this.table.get(BUDGET_KEY) ?? {
        kind: 'ledger',
        budgetEpsilon: DEFAULT_EPSILON_BUDGET,
        spentEpsilon: 0,
        releases: [],
        updatedAt: this.now(),
      }
    )
  }

  /** 预算面板。 */
  state(): {
    budgetEpsilon: number
    spentEpsilon: number
    remainingEpsilon: number
    releaseCount: number
    lastReleaseAt: number | null
    releases: readonly DpReleaseRecord[]
  } {
    const record = this.ledger()
    return {
      budgetEpsilon: record.budgetEpsilon,
      spentEpsilon: Math.round(record.spentEpsilon * 1e6) / 1e6,
      remainingEpsilon: Math.round((record.budgetEpsilon - record.spentEpsilon) * 1e6) / 1e6,
      releaseCount: record.releases.length,
      lastReleaseAt: record.releases.length > 0 ? record.releases[record.releases.length - 1].ts : null,
      releases: record.releases.slice(-20).reverse(),
    }
  }

  /**
   * DP 释放：校验预算 → 逐指标 Laplace 加噪 → 账本记账。
   * 预算不足时返回拒绝（不产生任何释放、不消耗预算）。
   */
  async release(
    metrics: readonly DpMetricInput[],
    epsilon: number = DEFAULT_RELEASE_EPSILON,
    rng: () => number = Math.random,
  ): Promise<DpReleaseOutcome> {
    if (metrics.length === 0) {
      return {
        refused: true,
        reason: '指标列表为空',
        requestedEpsilon: epsilon,
        spentEpsilon: 0,
        budgetEpsilon: this.ledger().budgetEpsilon,
        remainingEpsilon: this.ledger().budgetEpsilon,
      }
    }
    if (metrics.length > MAX_METRICS) {
      throw new Error(`单次释放不能超过 ${MAX_METRICS} 个指标`)
    }
    if (!Number.isFinite(epsilon) || epsilon < MIN_EPSILON || epsilon > MAX_EPSILON) {
      throw new Error(`ε 必须在 [${MIN_EPSILON}, ${MAX_EPSILON}] 内`)
    }
    for (const metric of metrics) {
      if (!Number.isFinite(metric.value)) throw new Error(`指标 ${metric.key} 的值非法`)
      if (metric.sensitivity !== undefined && (!Number.isFinite(metric.sensitivity) || metric.sensitivity < 0)) {
        throw new Error(`指标 ${metric.key} 的敏感度非法`)
      }
    }

    const record = this.ledger()
    const remaining = record.budgetEpsilon - record.spentEpsilon
    if (epsilon > remaining + 1e-9) {
      return {
        refused: true,
        reason: `隐私预算不足：剩余 ε=${remaining.toFixed(3)}，本次请求 ε=${epsilon.toFixed(3)}（顺序组合下总损失不可超预算——宁可拒绝，不可透支）`,
        requestedEpsilon: epsilon,
        spentEpsilon: Math.round(record.spentEpsilon * 1e6) / 1e6,
        budgetEpsilon: record.budgetEpsilon,
        remainingEpsilon: Math.round(remaining * 1e6) / 1e6,
      }
    }

    const released: DpReleasedMetric[] = metrics.map((metric) => {
      const sensitivity = metric.sensitivity ?? 1
      const kind = metric.kind ?? 'count'
      const result = dpReleaseValue(metric.value, sensitivity, epsilon, kind, rng)
      return {
        key: metric.key,
        released: result.released,
        scale: result.scale,
        sensitivity,
      }
    })

    const ts = this.now()
    const releaseId = `dp_${ts.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
    const next: DpLedgerRecord = {
      kind: 'ledger',
      budgetEpsilon: record.budgetEpsilon,
      spentEpsilon: Math.round((record.spentEpsilon + epsilon) * 1e6) / 1e6,
      releases: [...record.releases, { id: releaseId, ts, epsilon, metrics: released.map((m) => m.key) }].slice(-200),
      updatedAt: ts,
    }
    await this.table.put(BUDGET_KEY, next)
    return {
      refused: false,
      releaseId,
      epsilon,
      metrics: released,
      spentEpsilon: next.spentEpsilon,
      budgetEpsilon: next.budgetEpsilon,
      remainingEpsilon: Math.round((next.budgetEpsilon - next.spentEpsilon) * 1e6) / 1e6,
      note: `本批 ${released.length} 个指标已按 ε=${epsilon} 加噪发布（Laplace 机制，顺序组合记账）；发布值可直接外发，真值不出域。`,
    }
  }

  /** 重置账本（可选新预算 ε；清空已消耗）。 */
  async reset(budgetEpsilon?: number): Promise<void> {
    const next =
      budgetEpsilon !== undefined && Number.isFinite(budgetEpsilon) && budgetEpsilon >= MIN_EPSILON
        ? budgetEpsilon
        : this.ledger().budgetEpsilon
    await this.table.put(BUDGET_KEY, {
      kind: 'ledger',
      budgetEpsilon: next,
      spentEpsilon: 0,
      releases: [],
      updatedAt: this.now(),
    })
  }
}
