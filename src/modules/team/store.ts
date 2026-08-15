/**
 * 模块 I：协作与知识管理 —— 存储。
 *
 * 全部落在 companion 域：
 * - 'team-prefs'：成员署名与缺省合并策略（I1）；
 * - 'team-snapshots'：最近导入的配置快照归档（I1，滚动保留上限）；
 * - 'experience-cards'：执行卡片（I2；关键词/标签/模型检索与相似推荐）；
 * - 'review-requests' / 'review-comments' / 'review-decisions'：
 *   Prompt 评审请求、评论批注与审核决定（I3，变更记录完整可追溯）。
 */
import type { Domain } from '../../core/storage-adapter.js'
import type {
  ExperienceCard,
  ReviewComment,
  ReviewDecision,
  ReviewRequest,
  TeamConfigSnapshot,
  TeamPreferences,
} from './types.js'

/** 最近导入快照归档上限（条）。 */
export const SNAPSHOT_ARCHIVE_LIMIT = 10

/** 执行卡片上限（条；超出滚动删除最旧）。 */
export const EXPERIENCE_CARD_LIMIT = 500

/** 缺省团队偏好。 */
export const DEFAULT_TEAM_PREFS: TeamPreferences = {
  memberName: '',
  defaultStrategy: 'manual',
}

/** 生成模块内唯一 id。 */
export function teamId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 团队偏好仓库（I1）。 */
export class TeamPrefsStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<TeamPreferences>('team-prefs')
  }

  /** 读取偏好（缺省值兜底）。 */
  get(): TeamPreferences {
    return this.table.get('prefs') ?? DEFAULT_TEAM_PREFS
  }

  async put(prefs: TeamPreferences): Promise<void> {
    await this.table.put('prefs', prefs)
  }
}

/** 配置快照归档仓库（I1：最近导入记录）。 */
export class SnapshotArchiveStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<TeamConfigSnapshot>('team-snapshots')
  }

  /** 全部归档（新→旧）。 */
  list(): TeamConfigSnapshot[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => b.exportedAt - a.exportedAt)
  }

  get(key: string): TeamConfigSnapshot | undefined {
    return this.table.get(key)
  }

  /** 归档一份快照（键含时间戳，超出上限时删除最旧）。 */
  async put(snapshot: TeamConfigSnapshot): Promise<string> {
    const key = `snap-${snapshot.exportedAt.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    await this.table.put(key, snapshot)
    const all = this.list()
    for (const entry of all.slice(SNAPSHOT_ARCHIVE_LIMIT)) {
      for (const [k, value] of this.table.entries()) {
        if (value === entry) await this.table.delete(k)
      }
    }
    return key
  }
}

/** 执行卡片仓库（I2）。 */
export class ExperienceCardStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<ExperienceCard>('experience-cards')
  }

  /** 全部卡片（新→旧）。 */
  list(): ExperienceCard[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): ExperienceCard | undefined {
    return this.table.get(id)
  }

  /** 按来源执行 id 查找（自动提取去重用）。 */
  byRunId(runId: string): ExperienceCard | undefined {
    return this.list().find((card) => card.runId === runId)
  }

  async put(card: ExperienceCard): Promise<void> {
    await this.table.put(card.id, card)
    await this.trim()
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(id)
  }

  /** 滚动清理：仅保留最新 EXPERIENCE_CARD_LIMIT 张。 */
  private async trim(): Promise<void> {
    const all = this.list()
    if (all.length <= EXPERIENCE_CARD_LIMIT) return
    for (const card of all.slice(EXPERIENCE_CARD_LIMIT)) {
      await this.table.delete(card.id)
    }
  }

  /**
   * 检索：关键词（标题/Prompt 摘要/笔记/错误全文）、标签（任一命中）、
   * 模型（精确匹配）三条件 AND；缺省条件不参与过滤。
   */
  search(options: {
    query?: string
    tags?: readonly string[]
    model?: string
    limit?: number
  }): ExperienceCard[] {
    const query = (options.query ?? '').trim().toLowerCase()
    const tags = options.tags ?? []
    const model = (options.model ?? '').trim()
    return this.list()
      .filter((card) => {
        if (model && card.model !== model) return false
        if (tags.length > 0 && !tags.some((tag) => card.tags.includes(tag))) return false
        if (query && !cardSearchText(card).toLowerCase().includes(query)) return false
        return true
      })
      .slice(0, options.limit ?? 200)
  }

  /**
   * 相似推荐：对输入文本分词后与卡片文本求交集得分，
   * 得分 > 0 的卡片按得分（再按创建时间）降序返回。
   */
  recommend(text: string, limit: number = 5): Array<{ card: ExperienceCard; score: number }> {
    const queryTokens = tokenize(text)
    if (queryTokens.length === 0) return []
    const scored: Array<{ card: ExperienceCard; score: number }> = []
    for (const card of this.list()) {
      const cardTokens = new Set(tokenize(cardSearchText(card)))
      let score = 0
      for (const token of queryTokens) {
        if (cardTokens.has(token)) score += 1
      }
      if (score > 0) scored.push({ card, score })
    }
    scored.sort((a, b) => b.score - a.score || b.card.createdAt - a.card.createdAt)
    return scored.slice(0, limit)
  }
}

/** 评审请求仓库（I3）。 */
export class ReviewRequestStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<ReviewRequest>('review-requests')
  }

  /** 全部请求（新→旧）。 */
  list(): ReviewRequest[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): ReviewRequest | undefined {
    return this.table.get(id)
  }

  async put(request: ReviewRequest): Promise<void> {
    await this.table.put(request.id, request)
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(id)
  }
}

/** 评审评论仓库（I3）。 */
export class ReviewCommentStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<ReviewComment>('review-comments')
  }

  /** 某评审的全部评论（旧→新）。 */
  forReview(reviewId: string): ReviewComment[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .filter((comment) => comment.reviewId === reviewId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): ReviewComment | undefined {
    return this.table.get(id)
  }

  async put(comment: ReviewComment): Promise<void> {
    await this.table.put(comment.id, comment)
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(id)
  }
}

/** 审核决定仓库（I3）。 */
export class ReviewDecisionStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<ReviewDecision>('review-decisions')
  }

  /** 某评审的全部决定（旧→新）。 */
  forReview(reviewId: string): ReviewDecision[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .filter((decision) => decision.reviewId === reviewId)
      .sort((a, b) => a.ts - b.ts)
  }

  async put(decision: ReviewDecision): Promise<void> {
    await this.table.put(`${decision.reviewId}:${decision.reviewer}:${decision.ts}`, decision)
  }
}

// --------------------------------------------------------------------
// 检索辅助：分词与卡片全文
// --------------------------------------------------------------------

/** 卡片可检索全文（标题 + Prompt 摘要 + 标签 + 笔记 + 错误信息）。 */
function cardSearchText(card: ExperienceCard): string {
  const notes = card.notes.map((note) => `${note.problem} ${note.solution}`).join(' ')
  return `${card.title} ${card.promptSummary} ${card.tags.join(' ')} ${notes} ${card.error}`
}

/** 常见无意义词（分词后过滤）。 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are',
  '的', '了', '和', '与', '及', '请', '把', '将', '进行', '一个',
])

/**
 * 分词：ASCII 词按非字母数字切分（小写化），
 * CJK 连续段按二元组切分（适配中文无空格场景）；
 * 过滤停用词与单字符 ASCII 词。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const asciiWords = text.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  for (const word of asciiWords) {
    if (word.length >= 2 && !STOP_WORDS.has(word)) tokens.push(word)
  }
  const cjkRuns = text.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of cjkRuns) {
    if (run.length === 1) {
      if (!STOP_WORDS.has(run)) tokens.push(run)
      continue
    }
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bigram = run.slice(i, i + 2)
      if (!STOP_WORDS.has(bigram)) tokens.push(bigram)
    }
  }
  return tokens
}
