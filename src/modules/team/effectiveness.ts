/**
 * 模块 I 创新扩展：经验有效性追踪（Experience Effectiveness Tracking）。
 *
 * 现实痛点：经验库会"腐烂"。半年前关于某依赖版本的教训，在依赖升级
 * 后可能已经失效甚至有害；而静态的经验卡片永远不会知道自己过时了——
 * 知识管理领域称之为「知识衰减」（knowledge decay）：未被验证复用的
 * 组织记忆，其可信度随时间单调下降。
 *
 * 方案：给每张执行卡片装上"心跳"，构成闭环反馈系统：
 *
 * 1. 注入反馈闭环：卡片被注入真实执行（推荐/检索命中）后，记录一次
 *    使用事件；执行结束回填结果 helped / neutral / hurt——经验从
 *    "写完即冻结"变成"每次使用都在重新校准"的活资产；
 * 2. 半衰期淘汰：反馈不是简单计数，而是指数时间衰减——
 *    w = 2^(-age/halfLife)。最近三个月被验证 helpful 的证据权重，
 *    远大于一年前的同款证据；久未使用的卡片 freshness 同样指数衰减，
 *    低于阈值即标记 stale（候选归档）；
 * 3. 贝叶斯收缩评分：score = (α + Σw_helped) / (α+β + Σw_helped +
 *    Σw_hurt + 0.5·Σw_neutral)，Beta 先验保证小样本不极端——
 *    一条 lucky 反馈不会把卡片捧成 proven，一条偶发差评也不会立刻
 *    判死；
 * 4. 有效性加权推荐：推荐排序由「纯文本匹配分」升级为
 *    「文本分 × 有效性系数」——proven 卡片加权浮现，harmful 卡片
 *    沉底抑制，让组织记忆的排序反映真实世界里的有效性；
 * 5. 组织性遗忘（organizational forgetting）：sweep 端点按
 *    harmful / stale 清理经验库——记忆系统的另一半是遗忘，
 *    库越精炼，注入的信噪比越高。
 */
import type { Domain } from '../../core/storage-adapter.js'
import type { ExperienceCard } from './types.js'

/** 注入反馈结果：helped=有帮助；neutral=无感；hurt=有害/误导。 */
export type FeedbackOutcome = 'helped' | 'neutral' | 'hurt'

/** 单条注入反馈事件。 */
export interface FeedbackEvent {
  readonly cardId: string
  readonly ts: number
  readonly outcome: FeedbackOutcome
  /** 可选备注（如"方案已过时，新版 API 已改"）。 */
  readonly note?: string
}

/** 单卡反馈事件序列（'experience-feedback' 表记录形状）。 */
export interface FeedbackRecord {
  readonly cardId: string
  /** 事件序列（旧→新，截尾保留上限）。 */
  readonly events: readonly FeedbackEvent[]
}

/** 卡片有效性生命周期状态。 */
export type EffectivenessStatus = 'proven' | 'active' | 'unproven' | 'stale' | 'harmful'

/** 单卡有效性画像。 */
export interface CardEffectiveness {
  readonly cardId: string
  readonly title: string
  /** 累计注入次数（事件总数）。 */
  readonly injectedCount: number
  /** 衰减后的 helped / hurt 证据权重。 */
  readonly helpedWeight: number
  readonly hurtWeight: number
  /** 贝叶斯收缩后的有效性评分（0-1）。 */
  readonly score: number
  /** 新鲜度（0-1；随最近使用/更新时间指数衰减）。 */
  readonly freshness: number
  readonly status: EffectivenessStatus
  /** 最近一次注入反馈时间（毫秒；从未注入为 0）。 */
  readonly lastUsedAt: number
  /** 人类可读的处置建议。 */
  readonly advice: string
}

/** 有效性总报告。 */
export interface EffectivenessReport {
  readonly generatedAt: number
  /** 经验库卡片总数。 */
  readonly cardCount: number
  /** 至少有一条反馈的卡片数。 */
  readonly withFeedback: number
  /** 各状态计数。 */
  readonly statusCounts: Readonly<Record<EffectivenessStatus, number>>
  /** 全库画像（按有效性评分降序）。 */
  readonly cards: readonly CardEffectiveness[]
  /** 建议归档（组织性遗忘候选）。 */
  readonly retireCandidates: readonly CardEffectiveness[]
}

// --------------------------------------------------------------------
// 参数（领域直觉缺省值，均可被报告函数调用方覆盖）
// --------------------------------------------------------------------

/** 反馈证据半衰期（天）：45 天前的反馈权重减半。 */
export const FEEDBACK_HALF_LIFE_DAYS = 45

/** 新鲜度半衰期（天）：90 天未使用，freshness 减半。 */
export const FRESHNESS_HALF_LIFE_DAYS = 90

/** Beta 先验（α=1, β=1）：无反馈时评分收敛于 0.5（不偏不倚）。 */
const PRIOR_ALPHA = 1
const PRIOR_BETA = 1

/** neutral 证据计入分母的折算系数（既不助益也不抹黑）。 */
const NEUTRAL_DISCOUNT = 0.5

/** proven 判定：评分下限 + helped 证据下限（双双达标才转正）。 */
const PROVEN_MIN_SCORE = 0.7
const PROVEN_MIN_HELPED_WEIGHT = 2

/** harmful 判定：评分上限 + hurt 证据下限。 */
const HARMFUL_MAX_SCORE = 0.35
const HARMFUL_MIN_HURT_WEIGHT = 1.5

/** stale 判定：freshness 低于该阈值。 */
const STALE_FRESHNESS = 0.25

/** 单卡事件保留上限（截旧留新）。 */
const EVENTS_PER_CARD_CAP = 100

/** 一天毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000

// --------------------------------------------------------------------
// 纯函数：衰减与评分
// --------------------------------------------------------------------

/** 指数半衰期衰减权重（0-1；age 为毫秒）。 */
function decayWeight(ageMs: number, halfLifeDays: number): number {
  if (ageMs <= 0) return 1
  return Math.pow(2, -ageMs / (halfLifeDays * DAY_MS))
}

/** 汇总单卡反馈序列为有效性画像（纯函数，便于测试与复算）。 */
export function assessCard(
  card: Pick<ExperienceCard, 'id' | 'title' | 'updatedAt'>,
  events: readonly FeedbackEvent[],
  now: number = Date.now(),
): CardEffectiveness {
  let helpedWeight = 0
  let hurtWeight = 0
  let neutralWeight = 0
  let lastUsedAt = 0
  for (const event of events) {
    const weight = decayWeight(now - event.ts, FEEDBACK_HALF_LIFE_DAYS)
    if (event.outcome === 'helped') helpedWeight += weight
    else if (event.outcome === 'hurt') hurtWeight += weight
    else neutralWeight += weight
    if (event.ts > lastUsedAt) lastUsedAt = event.ts
  }
  // 贝叶斯收缩：先验 + 加权证据。
  const denominator =
    PRIOR_ALPHA + PRIOR_BETA + helpedWeight + hurtWeight + neutralWeight * NEUTRAL_DISCOUNT
  const score = (PRIOR_ALPHA + helpedWeight) / denominator
  // 新鲜度锚点：最近一次注入反馈，否则退回卡片最近更新时间。
  const anchor = lastUsedAt > 0 ? lastUsedAt : card.updatedAt
  const freshness = decayWeight(Math.max(0, now - anchor), FRESHNESS_HALF_LIFE_DAYS)

  const r4 = (value: number): number => Math.round(value * 10_000) / 10_000
  const base = {
    cardId: card.id,
    title: card.title,
    injectedCount: events.length,
    helpedWeight: r4(helpedWeight),
    hurtWeight: r4(hurtWeight),
    score: r4(score),
    freshness: r4(freshness),
    lastUsedAt,
  }

  if (events.length === 0) {
    return { ...base, status: 'unproven', advice: '尚无注入反馈，推荐时保持中性权重' }
  }
  if (score <= HARMFUL_MAX_SCORE && hurtWeight >= HARMFUL_MIN_HURT_WEIGHT) {
    return {
      ...base,
      status: 'harmful',
      advice: '近期负面反馈占优，建议复核内容或直接归档（sweep harmful）',
    }
  }
  if (score >= PROVEN_MIN_SCORE && helpedWeight >= PROVEN_MIN_HELPED_WEIGHT) {
    return { ...base, status: 'proven', advice: '多次被验证有效，推荐排序加权浮现' }
  }
  if (freshness <= STALE_FRESHNESS) {
    return {
      ...base,
      status: 'stale',
      advice: '久未使用，知识可能已过时；确认后可归档（sweep stale）',
    }
  }
  return { ...base, status: 'active', advice: '反馈正常，保持现状追踪' }
}

/** 推荐排序的有效性系数（proven 浮现、harmful 沉底）。 */
export function effectivenessWeight(status: EffectivenessStatus): number {
  switch (status) {
    case 'proven':
      return 1.5
    case 'harmful':
      return 0.3
    case 'stale':
      return 0.7
    case 'unproven':
      return 0.9
    default:
      return 1
  }
}

// --------------------------------------------------------------------
// 存储
// --------------------------------------------------------------------

/** 注入反馈仓库（'experience-feedback' 表）。 */
export class EffectivenessStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<FeedbackRecord>('experience-feedback')
  }

  /** 记录一次注入反馈（追加事件，截尾保留上限）。 */
  async record(cardId: string, outcome: FeedbackOutcome, note?: string): Promise<FeedbackRecord> {
    const previous = this.table.get(cardId)
    const event: FeedbackEvent = {
      cardId,
      ts: Date.now(),
      outcome,
      ...(note !== undefined && note.length > 0 ? { note } : {}),
    }
    const events = [...(previous?.events ?? []), event].slice(-EVENTS_PER_CARD_CAP)
    const next: FeedbackRecord = { cardId, events }
    await this.table.put(cardId, next)
    return next
  }

  /** 单卡事件序列（旧→新；无记录返回空数组）。 */
  eventsOf(cardId: string): readonly FeedbackEvent[] {
    return this.table.get(cardId)?.events ?? []
  }

  /** 全库有效性报告。 */
  buildReport(cards: readonly ExperienceCard[], now: number = Date.now()): EffectivenessReport {
    const assessed = cards.map((card) => assessCard(card, this.eventsOf(card.id), now))
    assessed.sort((a, b) => b.score - a.score || b.injectedCount - a.injectedCount)
    const statusCounts: Record<EffectivenessStatus, number> = {
      proven: 0,
      active: 0,
      unproven: 0,
      stale: 0,
      harmful: 0,
    }
    for (const item of assessed) statusCounts[item.status] += 1
    // 组织性遗忘候选：harmful，或（stale 且评分平庸）。
    const retireCandidates = assessed.filter(
      (item) => item.status === 'harmful' || (item.status === 'stale' && item.score < 0.5),
    )
    return {
      generatedAt: now,
      cardCount: cards.length,
      withFeedback: assessed.filter((item) => item.injectedCount > 0).length,
      statusCounts,
      cards: assessed,
      retireCandidates,
    }
  }
}
