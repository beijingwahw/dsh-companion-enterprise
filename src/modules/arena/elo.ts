/**
 * 模块 G 创新扩展：Elo 动态评级与置信排名（Arena Rating System）。
 *
 * 「一次评测跑个排行榜」是快照式对比——样本一小，排名就抖动；
 * 下次重跑，结果可能完全不同。LMSYS Chatbot Arena 证明了对 LLM
 * 排名的正确姿势：把模型对比建模为「对战」，用 Elo 评级累积
 * 所有历史证据，让排名随时间收敛而非随单次评测翻转。
 *
 * 本实现：
 * 1. 对战记录持久化（arena-elo-matches 表）：人类偏好投票
 *    （A/B 谁更好）或评测得分差自动判定胜负；
 * 2. Elo 计分：初始 1500，期望胜率 E = 1/(1+10^(ΔR/400))，
 *    K 因子随场次衰减（32→24→16）——新模型快速定位，
 *    成熟模型评级稳定；
 * 3. Wilson 下界排名：胜率的 95% 置信下界排序——只打过 3 场
 *    全胜的模型（下界 0.4）排在打了 50 场胜率 70% 的模型
 *    （下界 0.56）之后——小样本不再冒进，排名可信；
 * 4. 评级历史：每次对战后记录快照，可回放评级演化。
 */
import type { Domain } from '../../core/storage-adapter.js'

/** Elo 初始分。 */
export const ELO_INITIAL = 1500

/** K 因子阶梯（场次 → K）。 */
const K_TIERS: ReadonlyArray<{ readonly minGames: number; readonly k: number }> = [
  { minGames: 30, k: 16 },
  { minGames: 10, k: 24 },
  { minGames: 0, k: 32 },
]

/** Wilson 置信 z 值（95%）。 */
const WILSON_Z = 1.96

/** 评级历史每模型保留快照数。 */
const HISTORY_LIMIT = 50

/** 对战记录。 */
export interface EloMatch {
  /** 对局 id（时间戳 + 序号）。 */
  readonly id: string
  readonly ts: number
  /** 胜方模型（平局时为 null）。 */
  readonly winner: string | null
  /** 负方模型（平局时为 null）。 */
  readonly loser: string | null
  /** 平局双方（仅平局时）。 */
  readonly draw: readonly [string, string] | null
  /** 对战来源：manual=人工偏好投票；leaderboard=评测得分判定。 */
  readonly source: 'manual' | 'leaderboard'
}

/** 单模型评级行（排行榜条目）。 */
export interface EloRow {
  readonly model: string
  /** 当前 Elo 点估计。 */
  readonly rating: number
  /** 累计场次。 */
  readonly games: number
  readonly wins: number
  readonly losses: number
  readonly draws: number
  /** 胜率（胜 + 0.5×平）。 */
  readonly winRate: number
  /** 胜率 95% Wilson 下界（保守排名依据）。 */
  readonly wilsonLower: number
  /** 按下界排序的名次（1 起）。 */
  readonly rank: number
  /** 评级最近变化（最近一场，无场次时 null）。 */
  readonly lastDelta: number | null
}

/** 评级报告。 */
export interface EloReport {
  /** 全部对战记录（新→旧，≤100 条）。 */
  readonly matches: readonly EloMatch[]
  /** 评级表（按 Wilson 下界降序）。 */
  readonly standings: readonly EloRow[]
  /** 评级演化（每模型 ≤ HISTORY_LIMIT 个快照，升序）。 */
  readonly history: Readonly<Record<string, readonly number[]>>
}

/** K 因子：按该模型已赛场次取阶梯值。 */
function kFactor(games: number): number {
  for (const tier of K_TIERS) {
    if (games >= tier.minGames) return tier.k
  }
  return K_TIERS[K_TIERS.length - 1].k
}

/** 期望胜率。 */
function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400))
}

/**
 * Wilson 评分区间下界（胜率的保守估计）。
 * z=1.96（95% 置信）；零场次返回 0。
 */
export function wilsonLowerBound(wins: number, games: number): number {
  if (games === 0) return 0
  const p = wins / games
  const z2 = WILSON_Z * WILSON_Z
  const denominator = 1 + z2 / games
  const center = p + z2 / (2 * games)
  const margin = WILSON_Z * Math.sqrt((p * (1 - p) + z2 / (4 * games)) / games)
  return Math.max(0, (center - margin) / denominator)
}

/**
 * 对战仓库 + 评级引擎（arena-elo-matches / arena-elo-ratings 两张表）。
 */
export class EloStore {
  private readonly matchTable
  private readonly ratingTable
  private matchCounter = 0

  constructor(domain: Domain) {
    this.matchTable = domain.table<EloMatch>('arena-elo-matches')
    this.ratingTable = domain.table<EloRatingRecord>('arena-elo-ratings')
  }

  /**
   * 记录一场对战并更新双方评级。
   * @param a 模型 A。
   * @param b 模型 B。
   * @param outcome A 的视角：'win' | 'loss' | 'draw'。
   * @param source 对战来源。
   */
  async recordMatch(
    a: string,
    b: string,
    outcome: 'win' | 'loss' | 'draw',
    source: EloMatch['source'],
  ): Promise<void> {
    if (a === b) throw new Error('elo: 不能与自己对战')
    const ts = Date.now()
    this.matchCounter += 1
    const match: EloMatch = {
      id: `m-${ts}-${this.matchCounter}`,
      ts,
      winner: outcome === 'win' ? a : outcome === 'loss' ? b : null,
      loser: outcome === 'win' ? b : outcome === 'loss' ? a : null,
      draw: outcome === 'draw' ? [a, b] : null,
      source,
    }
    await this.matchTable.put(match.id, match)
    // 评级更新（读改写）。
    const ratingA = this.ratingOf(a)
    const ratingB = this.ratingOf(b)
    const gamesA = ratingA.wins + ratingA.losses + ratingA.draws
    const gamesB = ratingB.wins + ratingB.losses + ratingB.draws
    const kA = kFactor(gamesA)
    const kB = kFactor(gamesB)
    const scoreA = outcome === 'win' ? 1 : outcome === 'draw' ? 0.5 : 0
    const scoreB = 1 - scoreA
    const expectedA = expectedScore(ratingA.rating, ratingB.rating)
    const expectedB = 1 - expectedA
    const deltaA = Math.round(kA * (scoreA - expectedA))
    const deltaB = Math.round(kB * (scoreB - expectedB))
    await this.ratingTable.put(a, {
      model: a,
      rating: ratingA.rating + deltaA,
      wins: ratingA.wins + (outcome === 'win' ? 1 : 0),
      losses: ratingA.losses + (outcome === 'loss' ? 1 : 0),
      draws: ratingA.draws + (outcome === 'draw' ? 1 : 0),
      lastDelta: deltaA,
      history: [...ratingA.history, ratingA.rating + deltaA].slice(-HISTORY_LIMIT),
    })
    await this.ratingTable.put(b, {
      model: b,
      rating: ratingB.rating + deltaB,
      // B 的视角：A 胜即 B 负，A 负即 B 胜，平局各计半场。
      wins: ratingB.wins + (outcome === 'loss' ? 1 : 0),
      losses: ratingB.losses + (outcome === 'win' ? 1 : 0),
      draws: ratingB.draws + (outcome === 'draw' ? 1 : 0),
      lastDelta: deltaB,
      history: [...ratingB.history, ratingB.rating + deltaB].slice(-HISTORY_LIMIT),
    })
  }

  /** 指定模型的当前评级（无记录时给初始空态）。 */
  private ratingOf(model: string): EloRatingRecord {
    return this.ratingTable.get(model) ?? emptyRating(model)
  }

  /** 完整报告：对战记录 + Wilson 下界排名 + 评级演化。 */
  report(): EloReport {
    const matches = this.matchTable
      .entries()
      .map(([, value]) => value)
      .sort((x, y) => y.ts - x.ts)
      .slice(0, 100)
    const records = this.ratingTable.entries().map(([, value]) => value)
    const baseRows = records.map((record) => {
      const games = record.wins + record.losses + record.draws
      const wins = record.wins + record.draws * 0.5
      return {
        model: record.model,
        rating: Math.round(record.rating),
        games,
        wins: record.wins,
        losses: record.losses,
        draws: record.draws,
        winRate: games > 0 ? Math.round((wins / games) * 100) / 100 : 0,
        wilsonLower: Math.round(wilsonLowerBound(wins, games) * 1000) / 1000,
        lastDelta: record.lastDelta,
      }
    })
    // 保守排名：Wilson 下界降序；下界相同按点估计。
    baseRows.sort((x, y) => y.wilsonLower - x.wilsonLower || y.rating - x.rating)
    const rows: EloRow[] = baseRows.map((row, index) => ({ ...row, rank: index + 1 }))
    const history: Record<string, readonly number[]> = {}
    for (const record of records) history[record.model] = record.history
    return { matches, standings: rows, history }
  }

  /** 清空全部对战与评级。 */
  async reset(): Promise<void> {
    for (const [key] of this.matchTable.entries()) await this.matchTable.delete(key)
    for (const [key] of this.ratingTable.entries()) await this.ratingTable.delete(key)
  }
}

/** 持久化的单模型评级记录。 */
interface EloRatingRecord {
  readonly model: string
  rating: number
  wins: number
  losses: number
  draws: number
  /** 最近一场的评级变化。 */
  lastDelta: number
  /** 评级快照序列（每次对战后追加）。 */
  history: number[]
}

/** 初始空评级。 */
function emptyRating(model: string): EloRatingRecord {
  return { model, rating: ELO_INITIAL, wins: 0, losses: 0, draws: 0, lastDelta: 0, history: [] }
}
