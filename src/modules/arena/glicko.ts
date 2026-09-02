/**
 * 模块 G 创新扩展：Glicko-2 时变置信评级（Glicko-2 Rating System）。
 *
 * Elo（G5）解决了「排名随证据累积而收敛」；但 Elo 有两个已被
 * 评级科学解答的结构性缺陷：
 * 1. 点估计无置信度——1500 分打了 5 场和打了 500 场在榜上无法区分；
 * 2. 久未参赛的选手评级「冻结」——模型三个月没被评测，其 1500 分
 *    的可信度早已衰减，Elo 却照旧使用。
 *
 * Glicko-2（Mark Glickman，2001；国际象棋界 Lichess/FICS 的现役
 * 评级系统）给每个选手补上两个状态量：
 * - RD（rating deviation）：评级的标准差——每场对战收缩（证据变多），
 *   闲置时按 c·√t 增长（证据变陈旧），封顶 350（回到先验）；
 * - σ（volatility）：选手表现波动的大小，由 Illinois 迭代法从近况
 *   估计——状态忽好忽坏的模型评级变化更陡。
 *
 * 排名口径因此升级为「保守分 = rating − 1.96×RD」：小样本模型的
 * 95% 置信下界远低于点估计，自动排后；久未评测的模型 RD 自动放大，
 * 排名自动回落——榜单自己会表达「我不确定」。
 *
 * 实现：Glickman 论文附录的标准算法（尺度变换 μ/φ = (r−1500)/
 * 173.7178、g/E 函数、v/Δ、Illinois 法解 σ'），逐场对战按单场
 * 评级期处理（事件驱动更新的标准实践）；RD 闲置增长惰性应用于
 * 读取时（不写库，报告一致）。
 */
import type { Domain } from '../../core/storage-adapter.js'

/** Glicko-2 常量：系统 τ（波动收敛速度，Glickman 推荐 0.3-1.2）。 */
const TAU = 0.5

/** Illinois 迭代收敛阈值。 */
const EPSILON = 1e-6

/** Elo/Glicko 尺度换算常数。 */
const SCALE = 173.7178

/** 初始分。 */
export const GLICKO_INITIAL_RATING = 1500

/** 初始 RD（最大不确定度）。 */
export const GLICKO_INITIAL_RD = 350

/** 初始波动。 */
const INITIAL_VOLATILITY = 0.06

/** RD 闲置增长常数 c（每 30 天一个评级期，RD² + c²t）。 */
const RD_GROWTH_C = 34.6

/** 评级期长度（天）。 */
const PERIOD_DAYS = 30

/** RD 上限。 */
const RD_CAP = 350

/** 保守分 z 值（95% 单侧）。 */
const CONSERVATIVE_Z = 1.96

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

/** 对战记录（'arena-glicko-matches' 表）。 */
export interface GlickoMatch {
  readonly id: string
  readonly ts: number
  /** A 方模型。 */
  readonly a: string
  /** B 方模型。 */
  readonly b: string
  /** A 视角胜负：win/loss/draw。 */
  readonly outcome: 'win' | 'loss' | 'draw'
  readonly source: 'manual' | 'leaderboard'
}

/** 持久化评级记录（'arena-glicko-ratings' 表，键为模型名）。 */
export interface GlickoRatingRecord {
  readonly model: string
  rating: number
  rd: number
  volatility: number
  wins: number
  losses: number
  draws: number
  /** 最近一次对战时间（闲置 RD 增长的起点）。 */
  lastPlayedAt: number
}

/** 排行榜条目。 */
export interface GlickoRow {
  readonly model: string
  readonly rating: number
  /** 当前 RD（含闲置增长，惰性计算）。 */
  readonly rd: number
  /** 95% 置信区间。 */
  readonly ci95: readonly [number, number]
  /** 保守分 = rating − 1.96×RD（排名依据）。 */
  readonly conservative: number
  readonly games: number
  readonly winRate: number
  /** 距最近对战的闲置天数。 */
  readonly inactiveDays: number
  readonly volatility: number
  readonly rank: number
}

/** 评级报告。 */
export interface GlickoReport {
  readonly matches: readonly GlickoMatch[]
  readonly standings: readonly GlickoRow[]
  readonly summary: string
}

// ---------------------------------------------------------------------------
// Glicko-2 数学核心（纯函数）
// ---------------------------------------------------------------------------

/** g(φ) = 1/√(1+3φ²/π²)。 */
function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI))
}

/** E(μ, μ_j, φ_j) = 1/(1+exp(−g(φ_j)(μ−μ_j)))。 */
function expectedGlicko(mu: number, muOpponent: number, phiOpponent: number): number {
  return 1 / (1 + Math.exp(-g(phiOpponent) * (mu - muOpponent)))
}

/**
 * 单场对战的 Glicko-2 更新（A 视角；B 对称调用）。
 * @param ratingA A 的评级三元组（rating/rd/volatility）。
 * @param ratingB B 的评级三元组。
 * @param score A 的得分（1/0.5/0）。
 * @returns A 的新评级三元组。
 */
export function glickoUpdate(
  ratingA: { rating: number; rd: number; volatility: number },
  ratingB: { rating: number; rd: number; volatility: number },
  score: number,
): { rating: number; rd: number; volatility: number } {
  // 1. 尺度变换。
  const mu = (ratingA.rating - GLICKO_INITIAL_RATING) / SCALE
  const phi = ratingA.rd / SCALE
  const muJ = (ratingB.rating - GLICKO_INITIAL_RATING) / SCALE
  const phiJ = ratingB.rd / SCALE
  const sigma = ratingA.volatility

  // 2. v 与 Δ（单对手）。
  const e = expectedGlicko(mu, muJ, phiJ)
  const gJ = g(phiJ)
  const v = 1 / (gJ * gJ * e * (1 - e))
  const delta = v * gJ * (score - e)

  // 3. Illinois 迭代解 σ'。
  const a = Math.log(sigma * sigma)
  const f = (x: number): number => {
    const ex = Math.exp(x)
    return (
      (ex * (delta * delta - phi * phi - v - ex)) / (2 * Math.pow(phi * phi + v + ex, 2)) -
      (x - a) / (TAU * TAU)
    )
  }
  let bigA = a
  let bigB: number
  if (delta * delta > phi * phi + v) {
    bigB = Math.log(delta * delta - phi * phi - v)
  } else {
    let k = 1
    while (f(a - k * TAU) < 0) k += 1
    bigB = a - k * TAU
  }
  let fA = f(bigA)
  let fB = f(bigB)
  while (Math.abs(bigB - bigA) > EPSILON) {
    const bigC = bigA + ((bigA - bigB) * fA) / (fB - fA)
    const fC = f(bigC)
    if (fC * fB <= 0) {
      bigA = bigB
      fA = fB
    } else {
      fA = fA / 2
    }
    bigB = bigC
    fB = fC
  }
  const sigmaPrime = Math.exp(bigA / 2)

  // 4. 新评级。
  const phiStar = 1 / Math.sqrt(1 / (phi * phi) + 1 / v)
  const phiPrime = Math.sqrt(phiStar * phiStar + sigmaPrime * sigmaPrime)
  const muPrime = mu + phiStar * phiStar * gJ * (score - e)

  // 5. 换回 Elo 尺度。
  return {
    rating: Math.round(SCALE * muPrime + GLICKO_INITIAL_RATING),
    rd: Math.min(RD_CAP, Math.round(SCALE * phiPrime)),
    volatility: Math.round(sigmaPrime * 1e6) / 1e6,
  }
}

/** RD 闲置增长：rd' = min(√(rd² + c²·t), 350)，t = 闲置的评级期数。 */
export function rdAfterInactivity(rd: number, inactiveDays: number): number {
  const periods = Math.max(0, inactiveDays) / PERIOD_DAYS
  if (periods === 0) return Math.min(RD_CAP, rd)
  return Math.min(RD_CAP, Math.round(Math.sqrt(rd * rd + RD_GROWTH_C * RD_GROWTH_C * periods)))
}

// ---------------------------------------------------------------------------
// 仓库
// ---------------------------------------------------------------------------

/** Glicko-2 对战与评级仓库。 */
export class GlickoStore {
  private readonly matchTable
  private readonly ratingTable
  private counter = 0

  constructor(domain: Domain) {
    this.matchTable = domain.table<GlickoMatch>('arena-glicko-matches')
    this.ratingTable = domain.table<GlickoRatingRecord>('arena-glicko-ratings')
  }

  /** 当前评级（无记录给初始空态）。 */
  private ratingOf(model: string): GlickoRatingRecord {
    return (
      this.ratingTable.get(model) ?? {
        model,
        rating: GLICKO_INITIAL_RATING,
        rd: GLICKO_INITIAL_RD,
        volatility: INITIAL_VOLATILITY,
        wins: 0,
        losses: 0,
        draws: 0,
        lastPlayedAt: 0,
      }
    )
  }

  /** 记录一场对战并更新双方评级（含 B 视角对称更新）。 */
  async recordMatch(
    a: string,
    b: string,
    outcome: 'win' | 'loss' | 'draw',
    source: GlickoMatch['source'],
    now: number = Date.now(),
  ): Promise<void> {
    if (a === b) throw new Error('glicko: 不能与自己对战')
    const ts = now
    this.counter += 1
    await this.matchTable.put(`gm-${ts}-${this.counter}`, { id: `gm-${ts}-${this.counter}`, ts, a, b, outcome, source })

    const ratingA = this.ratingOf(a)
    const ratingB = this.ratingOf(b)
    const scoreA = outcome === 'win' ? 1 : outcome === 'draw' ? 0.5 : 0
    // 先算 A 的新评级（以 B 旧评级为对手），再对称算 B。
    const nextA = glickoUpdate(ratingA, ratingB, scoreA)
    const nextB = glickoUpdate(ratingB, ratingA, 1 - scoreA)
    await this.ratingTable.put(a, {
      model: a,
      ...nextA,
      wins: ratingA.wins + (outcome === 'win' ? 1 : 0),
      losses: ratingA.losses + (outcome === 'loss' ? 1 : 0),
      draws: ratingA.draws + (outcome === 'draw' ? 1 : 0),
      lastPlayedAt: ts,
    })
    await this.ratingTable.put(b, {
      model: b,
      ...nextB,
      wins: ratingB.wins + (outcome === 'loss' ? 1 : 0),
      losses: ratingB.losses + (outcome === 'win' ? 1 : 0),
      draws: ratingB.draws + (outcome === 'draw' ? 1 : 0),
      lastPlayedAt: ts,
    })
  }

  /** 完整报告：对战记录 + 保守分排名（RD 含闲置增长）。 */
  report(now: number = Date.now()): GlickoReport {
    const matches = this.matchTable
      .entries()
      .map(([, value]) => value)
      .sort((x, y) => y.ts - x.ts)
      .slice(0, 100)
    const dayMs = 86_400_000
    const rows = this.ratingTable
      .entries()
      .map(([, record]) => {
        const games = record.wins + record.losses + record.draws
        const inactiveDays = record.lastPlayedAt > 0 ? Math.floor((now - record.lastPlayedAt) / dayMs) : -1
        const rd = rdAfterInactivity(record.rd, inactiveDays)
        const conservative = Math.round(record.rating - CONSERVATIVE_Z * rd)
        return {
          model: record.model,
          rating: record.rating,
          rd,
          ci95: [
            Math.round(record.rating - CONSERVATIVE_Z * rd),
            Math.round(record.rating + CONSERVATIVE_Z * rd),
          ] as const,
          conservative,
          games,
          winRate: games > 0 ? Math.round(((record.wins + record.draws * 0.5) / games) * 100) / 100 : 0,
          inactiveDays,
          volatility: record.volatility,
        }
      })
    rows.sort((x, y) => y.conservative - x.conservative || y.rating - x.rating)
    const standings = rows.map((row, index) => ({ ...row, rank: index + 1 }))
    const leader = standings[0]
    return {
      matches,
      standings,
      summary:
        `${standings.length} 个模型在榜；榜首 ${leader ? `${leader.model}（保守分 ${leader.conservative}，RD ±${leader.rd}）` : '无'}；` +
        `排名按 95% 置信下界（rating − 1.96×RD）——小样本与久未评测的模型自动让位。`,
    }
  }

  /** 清空全部对战与评级。 */
  async reset(): Promise<void> {
    for (const [key] of this.matchTable.entries()) await this.matchTable.delete(key)
    for (const [key] of this.ratingTable.entries()) await this.ratingTable.delete(key)
  }
}
