/**
 * 模块 D 创新扩展：点击反馈学习重排序（Click-Feedback Learning to Rank）。
 *
 * 检索引擎打分的上限是「文本相似」，而用户真正想找什么只有点击知道。
 * Web 搜索二十年的一条铁律：点击日志是最后的裁判（Joachims 2002 起
 * 的点击模型谱系）。本模块把这条方法论搬进会话检索：
 *
 * 1. 展示即曝光：每次 /search/rerank 返回结果时记录一条展示事件
 *    （query + 按位次排列的会话清单）——没有曝光计数，点击率无从谈起；
 * 2. 逆倾向加权（IPW）去位置偏：用户几乎总点前几条，不是因为更相关，
 *    而是因为更靠前（position bias）。按级联检验假设，位次 r 的被检
 *    验概率 π_r ≈ 1/log₂(r+2)：
 *    - 曝光按 π_r 折算为「期望检验数」（有效曝光）；
 *    - 点击按 1/π_r 加权为「无偏点击证据」（低位次点击更难得，证据更强）；
 *    二者之比即 Horvitz-Thompson 无偏相关度估计；
 * 3. 贝叶斯平滑：rate = (有效点击 + α·全局率) / (有效曝光 + α)——
 *    冷启动会话不会因一次幸运点击登顶，全局先验兜底；
 * 4. 术语泛化：新查询未必与历史查询字面相同。把查询分解为词元
 *    （拉丁词 + CJK 二元组），在词元层累积同一套无偏统计——
 *    查「部署流水线」能吃到历史查「部署」攒下的点击证据；
 * 5. 融合重排：final = w·点击相关度 + (1−w)·引擎位次置信
 *    （1/log₂(rank+1)，DCG 折扣）——点击信号修正引擎，而非取代引擎；
 * 6. 可解释输出：每条结果附带原始位次/新位次/证据说明
 *    （「查询「部署」下 3 次有效点击 / 5.1 次有效曝光」），
 *    重排不再是黑箱。
 */
import type { Domain } from '../../core/storage-adapter.js'
import type { SessionRecord } from '../../types/harness.js'
import type { SearchHit } from './service.js'

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/** 点击事件滚动保留上限（超出删最旧）。 */
const EVENT_KEEP_LIMIT = 5_000

/** 平滑伪计数 α（有效曝光维度）。 */
const SMOOTHING_ALPHA = 2

/** 点击信号默认融合权重。 */
export const DEFAULT_CLICK_WEIGHT = 0.6

// ---------------------------------------------------------------------------
// 数据模型与存储
// ---------------------------------------------------------------------------

/** 点击/展示事件（'search-clicks' 表，键为事件 id）。 */
export interface ClickEventRecord {
  readonly kind: 'click' | 'impression'
  readonly ts: number
  /** 归一化后的查询文本。 */
  readonly query: string
  /** click：被点击的会话 id。 */
  readonly sessionId: string
  /** click：点击位次（1 起）。 */
  readonly position: number
  /** impression：本次展示的会话 id 序列（按位次）。 */
  readonly shown: readonly string[]
}

/** 点击反馈事件仓库。 */
export class ClickFeedbackStore {
  private readonly table
  private counter = 0

  constructor(domain: Domain) {
    this.table = domain.table<ClickEventRecord>('search-clicks')
  }

  /** 记录一次展示（rerank 返回结果时调用）。 */
  async recordImpression(query: string, shown: readonly string[]): Promise<void> {
    if (shown.length === 0) return
    await this.put({
      kind: 'impression',
      ts: Date.now(),
      query: normalizeQuery(query),
      sessionId: '',
      position: 0,
      shown,
    })
  }

  /** 记录一次点击（位次从 1 起）。 */
  async recordClick(query: string, sessionId: string, position: number): Promise<void> {
    await this.put({
      kind: 'click',
      ts: Date.now(),
      query: normalizeQuery(query),
      sessionId,
      position,
      shown: [],
    })
  }

  private async put(record: ClickEventRecord): Promise<void> {
    this.counter += 1
    await this.table.put(`${record.ts.toString(36)}-${this.counter.toString(36)}`, record)
    await this.trim()
  }

  /** 全部事件（时间升序）。 */
  events(): ClickEventRecord[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => a.ts - b.ts)
  }

  /** 滚动修剪（保留最近 EVENT_KEEP_LIMIT 条）。 */
  async trim(): Promise<void> {
    const entries = this.table.entries()
    if (entries.length <= EVENT_KEEP_LIMIT) return
    const stale = entries
      .sort((a, b) => a[1].ts - b[1].ts)
      .slice(0, entries.length - EVENT_KEEP_LIMIT)
    for (const [key] of stale) await this.table.delete(key)
  }

  async clear(): Promise<void> {
    for (const key of this.table.keys()) await this.table.delete(key)
  }
}

// ---------------------------------------------------------------------------
// 词元化与查询归一化（纯函数）
// ---------------------------------------------------------------------------

/** 查询归一化：小写 + 压空白。 */
export function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * 词元化：拉丁字母数字词 + CJK 二元组（unigram 噪声太大，二元组是
 * 中文检索的工业惯例）。短于 2 的拉丁词丢弃。
 */
export function tokenizeQuery(query: string): string[] {
  const text = normalizeQuery(query)
  const tokens: string[] = []
  const latin = text.match(/[a-z0-9][a-z0-9_-]*/g) ?? []
  for (const word of latin) {
    if (word.length >= 2) tokens.push(word)
  }
  const cjkRuns = text.match(/[\u4e00-\u9fa5]+/g) ?? []
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2))
  }
  return [...new Set(tokens)]
}

// ---------------------------------------------------------------------------
// 点击模型：学习与打分（纯函数）
// ---------------------------------------------------------------------------

/** （查询或词元 × 会话）聚合统计。 */
interface SessionStats {
  /** 有效曝光（Σ 检验倾向 π_r）。 */
  effectiveImpressions: number
  /** 有效点击（Σ 1/π_r，无偏证据）。 */
  effectiveClicks: number
  clicks: number
  lastClickedAt: number
}

/** 去位置偏点击模型。 */
export interface ClickModel {
  readonly eventCount: number
  /** 全局无偏点击率（有效点击 / 有效曝光）。 */
  readonly globalRate: number
  /** 精确查询 → 会话统计。 */
  readonly queryStats: ReadonlyMap<string, ReadonlyMap<string, SessionStats>>
  /** 词元 → 会话统计（泛化到未见查询）。 */
  readonly termStats: ReadonlyMap<string, ReadonlyMap<string, SessionStats>>
  /** 学到过证据的会话总数。 */
  readonly knownSessions: number
}

/** 位次 r（1 起）的检验倾向 π_r = 1/log₂(r+2)。 */
function examinationPropensity(rank: number): number {
  return 1 / Math.log2(rank + 2)
}

/** 累计一条事件到统计映射。 */
function bump(
  target: Map<string, Map<string, SessionStats>>,
  key: string,
  sessionId: string,
  patch: Partial<Pick<SessionStats, 'effectiveImpressions' | 'effectiveClicks' | 'clicks' | 'lastClickedAt'>>,
): void {
  let bySession = target.get(key)
  if (!bySession) {
    bySession = new Map()
    target.set(key, bySession)
  }
  const prev: SessionStats = bySession.get(sessionId) ?? {
    effectiveImpressions: 0,
    effectiveClicks: 0,
    clicks: 0,
    lastClickedAt: 0,
  }
  bySession.set(sessionId, {
    effectiveImpressions: prev.effectiveImpressions + (patch.effectiveImpressions ?? 0),
    effectiveClicks: prev.effectiveClicks + (patch.effectiveClicks ?? 0),
    clicks: prev.clicks + (patch.clicks ?? 0),
    lastClickedAt: Math.max(prev.lastClickedAt, patch.lastClickedAt ?? 0),
  })
}

/**
 * 从事件流学习点击模型（IPW 去偏 + 查询/词元双通道聚合）。
 */
export function learnClickModel(events: readonly ClickEventRecord[]): ClickModel {
  const queryStats = new Map<string, Map<string, SessionStats>>()
  const termStats = new Map<string, Map<string, SessionStats>>()
  let globalEffectiveClicks = 0
  let globalEffectiveImpressions = 0
  const knownSessions = new Set<string>()

  for (const event of events) {
    if (event.kind === 'impression') {
      for (let rank = 0; rank < event.shown.length; rank += 1) {
        const sessionId = event.shown[rank]
        const pi = examinationPropensity(rank + 1)
        bump(queryStats, event.query, sessionId, { effectiveImpressions: pi })
        globalEffectiveImpressions += pi
        for (const term of tokenizeQuery(event.query)) {
          bump(termStats, term, sessionId, { effectiveImpressions: pi })
        }
      }
      continue
    }
    // 点击：无偏证据 = 1/π_r。
    const credit = 1 / examinationPropensity(event.position)
    bump(queryStats, event.query, event.sessionId, {
      effectiveClicks: credit,
      clicks: 1,
      lastClickedAt: event.ts,
    })
    globalEffectiveClicks += credit
    knownSessions.add(event.sessionId)
    for (const term of tokenizeQuery(event.query)) {
      bump(termStats, term, event.sessionId, {
        effectiveClicks: credit,
        clicks: 1,
        lastClickedAt: event.ts,
      })
    }
  }

  return {
    eventCount: events.length,
    globalRate: globalEffectiveImpressions > 0 ? globalEffectiveClicks / globalEffectiveImpressions : 0,
    queryStats,
    termStats,
    knownSessions: knownSessions.size,
  }
}

/** 会话级点击相关度打分结果。 */
export interface ClickScoreResult {
  /** 平滑后的无偏点击相关度 ∈ [0, 1]。 */
  readonly score: number
  /** 证据说明（可展示）。 */
  readonly reason: string
  /** 证据来源：'query'（精确查询）| 'term'（词元泛化）| 'none'。 */
  readonly evidence: 'query' | 'term' | 'none'
}

/**
 * 为（query, session）计算点击相关度：
 * 精确查询通道优先（证据最直接），否则词元通道取最强信号，
 * 均无证据返回 0（退化为纯引擎位次）。
 */
export function clickScore(model: ClickModel, query: string, sessionId: string): ClickScoreResult {
  const normalized = normalizeQuery(query)
  const direct = model.queryStats.get(normalized)?.get(sessionId)
  if (direct && direct.effectiveImpressions > 0) {
    const score = smoothedRate(direct.effectiveClicks, direct.effectiveImpressions, model.globalRate)
    return {
      score,
      evidence: 'query',
      reason: `查询「${normalized}」下 ${round2(direct.effectiveClicks)} 次有效点击 / ` +
        `${round2(direct.effectiveImpressions)} 次有效曝光（IPW 去位置偏）`,
    }
  }
  let best: { term: string; score: number; clicks: number; impressions: number } | undefined
  for (const term of tokenizeQuery(normalized)) {
    const stats = model.termStats.get(term)?.get(sessionId)
    if (!stats || stats.effectiveImpressions <= 0) continue
    const score = smoothedRate(stats.effectiveClicks, stats.effectiveImpressions, model.globalRate)
    if (!best || score > best.score) {
      best = { term, score, clicks: stats.effectiveClicks, impressions: stats.effectiveImpressions }
    }
  }
  if (best) {
    return {
      score: best.score,
      evidence: 'term',
      reason: `词元「${best.term}」泛化信号：${round2(best.clicks)} 次有效点击 / ` +
        `${round2(best.impressions)} 次有效曝光`,
    }
  }
  return { score: 0, evidence: 'none', reason: '暂无点击证据，保持引擎原序' }
}

/** 贝叶斯平滑率：(有效点击 + α·先验) / (有效曝光 + α)。 */
function smoothedRate(effectiveClicks: number, effectiveImpressions: number, prior: number): number {
  return Math.min(
    1,
    Math.max(0, (effectiveClicks + SMOOTHING_ALPHA * prior) / (effectiveImpressions + SMOOTHING_ALPHA)),
  )
}

/** 保留 2 位小数。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// ---------------------------------------------------------------------------
// 重排序（纯函数）
// ---------------------------------------------------------------------------

/** 单条重排结果。 */
export interface RerankEntry {
  readonly session: SessionRecord
  readonly snippet?: string
  readonly tags: readonly string[]
  readonly originalRank: number
  readonly newRank: number
  readonly clickScore: number
  /** 融合分（点击 w + 位次 1−w）。 */
  readonly finalScore: number
  readonly reason: string
}

/** 重排报告。 */
export interface RerankReport {
  readonly query: string
  /** 点击模型是否有任何可泛化的证据。 */
  readonly learned: boolean
  /** 是否发生了顺序变化。 */
  readonly reordered: boolean
  readonly entries: readonly RerankEntry[]
  readonly clickWeight: number
}

/**
 * 点击反馈重排：final = w·clickScore + (1−w)·1/log₂(rank+1)。
 * 点击证据缺位时自动退化为引擎原序（w 项全为 0 时按原序稳定输出）。
 */
export function rerankHits(
  hits: readonly SearchHit[],
  model: ClickModel,
  query: string,
  weight: number = DEFAULT_CLICK_WEIGHT,
): RerankReport {
  const scored = hits.map((hit, index) => {
    const originalRank = index + 1
    const rankConfidence = 1 / Math.log2(originalRank + 1)
    const click = clickScore(model, query, hit.session.id)
    return {
      hit,
      originalRank,
      clickScore: click.score,
      reason: click.reason,
      evidence: click.evidence,
      finalScore: weight * click.score + (1 - weight) * rankConfidence,
    }
  })
  // 稳定排序：分相同时保持引擎原序（scored 顺序即原序）。
  scored.sort((a, b) => b.finalScore - a.finalScore)
  const entries: RerankEntry[] = scored.map((item, index) => ({
    session: item.hit.session,
    ...(item.hit.snippet !== undefined ? { snippet: item.hit.snippet } : {}),
    tags: item.hit.tags,
    originalRank: item.originalRank,
    newRank: index + 1,
    clickScore: Math.round(item.clickScore * 1000) / 1000,
    finalScore: Math.round(item.finalScore * 1000) / 1000,
    reason: item.reason,
  }))
  const reordered = entries.some((entry) => entry.originalRank !== entry.newRank)
  return {
    query: normalizeQuery(query),
    learned: model.eventCount > 0,
    reordered,
    entries,
    clickWeight: weight,
  }
}

// ---------------------------------------------------------------------------
// 模型面板
// ---------------------------------------------------------------------------

/** 点击模型统计面板。 */
export interface ClickModelStats {
  readonly eventCount: number
  readonly knownSessions: number
  readonly globalRate: number
  readonly distinctQueries: number
  readonly vocabularySize: number
  /** 全局最强的会话信号（跨词元聚合的有效点击，降序前 10）。 */
  readonly topSessions: readonly {
    readonly sessionId: string
    readonly effectiveClicks: number
    readonly clicks: number
    readonly lastClickedAt: number
  }[]
}

/** 汇总模型面板（top 会话跨词元聚合）。 */
export function clickModelStats(model: ClickModel): ClickModelStats {
  const perSession = new Map<string, { effectiveClicks: number; clicks: number; lastClickedAt: number }>()
  for (const [, bySession] of model.termStats) {
    for (const [sessionId, stats] of bySession) {
      const prev = perSession.get(sessionId) ?? { effectiveClicks: 0, clicks: 0, lastClickedAt: 0 }
      perSession.set(sessionId, {
        effectiveClicks: prev.effectiveClicks + stats.effectiveClicks,
        clicks: prev.clicks + stats.clicks,
        lastClickedAt: Math.max(prev.lastClickedAt, stats.lastClickedAt),
      })
    }
  }
  const topSessions = [...perSession.entries()]
    .map(([sessionId, stats]) => ({ sessionId, ...stats }))
    .sort((a, b) => b.effectiveClicks - a.effectiveClicks)
    .slice(0, 10)
    .map((row) => ({
      sessionId: row.sessionId,
      effectiveClicks: round2(row.effectiveClicks),
      clicks: row.clicks,
      lastClickedAt: row.lastClickedAt,
    }))
  return {
    eventCount: model.eventCount,
    knownSessions: model.knownSessions,
    globalRate: Math.round(model.globalRate * 1000) / 1000,
    distinctQueries: model.queryStats.size,
    vocabularySize: model.termStats.size,
    topSessions,
  }
}
