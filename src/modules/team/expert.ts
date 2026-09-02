/**
 * 模块 I 创新扩展：专家路由（知识足迹画像 + 余弦匹配）。
 *
 * 团队里最难回答的问题往往不是技术问题，而是「这个问题该问谁」。
 * IM 群里 @错人的代价是一轮轮的踢皮球；企业知识管理研究（expertise
 * retrieval / community question answering）给出的成熟解法是：
 * 让人的「产出」自动累积成可检索的画像——谁写过什么，谁就是
 * 什么方面的专家。
 *
 * 方法论（向量空间模型，Salton 1975 起 IR 的基石）：
 * 1. 知识足迹语料：每位专家的画像语料 = 自报领域（×3 权重，最强的
 *    声明信号）+ 发起的 Prompt 评审请求标题与正文摘录（×2）+ 评审
 *    评论与裁定意见（×1）——全部来自 I3 协作评审的真实署名产出，
 *    不需要任何人额外填表；
 * 2. TF-IDF 质心：语料分词（拉丁词 + CJK 二元组）后按 TF-IDF 加权，
 *    L2 归一化为单位向量——「知识足迹」就是这位专家在组织术语空间
 *    中的位置；IDF 跨专家计算：只有一个人懂的术语权重最高，
 *    人人都提的术语近乎零信息——画像因此自动「差异化」；
 * 3. 余弦路由：问题向量（同一词表、同一 IDF）与各足迹做余弦相似度，
 *    top-1 即推荐专家；输出命中的高权重术语作为「为什么是他」的
 *    可解释证据；
 * 4. 覆盖率与知识盲区检测：问题术语在全部足迹中的覆盖比例——
 *    大量术语无人覆盖时明确报告「团队知识盲区」（该建专家或
 *    该补文档），而不是硬推一个不相关的人；
 * 5. 裁决分级：confident（余弦 ≥ 0.25 且覆盖 ≥ 50%）/ tentative
 *    （有信号但不足）/ gap（无人可答）——路由结果带着可信度出门。
 */
import type { Domain } from '../../core/storage-adapter.js'
import { tokenize } from './store.js'
import type { ReviewComment, ReviewDecision, ReviewRequest } from './types.js'

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/** 自报领域语料的权重（最强声明信号）。 */
const DOMAIN_WEIGHT = 3

/** 评审请求语料的权重。 */
const REVIEW_WEIGHT = 2

/** 评论/裁定语料的权重。 */
const COMMENT_WEIGHT = 1

/** confident 裁决的余弦阈值。 */
const CONFIDENT_COSINE = 0.25

/** confident 裁决的问题术语覆盖率阈值。 */
const CONFIDENT_COVERAGE = 0.5

/** 画像报告展示的顶部术语数。 */
const PROFILE_TOP_TERMS = 12

// ---------------------------------------------------------------------------
// 数据模型与存储
// ---------------------------------------------------------------------------

/** 团队专家记录（'team-experts' 表，键为专家 id）。 */
export interface ExpertRecord {
  readonly kind: 'expert'
  readonly id: string
  /** 成员署名（须与评审 author 一致才能吃到评审产出足迹）。 */
  readonly name: string
  /** 自报领域关键词（画像语料的种子）。 */
  readonly domains: readonly string[]
  readonly bio: string
  readonly createdAt: number
  updatedAt: number
}

/** 专家仓库。 */
export class ExpertStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<ExpertRecord>('team-experts')
  }

  /** 保存（新增或更新；同名视为同一专家，更新其领域与简介）。 */
  async save(input: { name: string; domains: readonly string[]; bio: string }): Promise<ExpertRecord> {
    const existing = this.byName(input.name)
    const now = Date.now()
    const record: ExpertRecord = {
      kind: 'expert',
      id: existing?.id ?? `expert_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      name: input.name,
      domains: input.domains,
      bio: input.bio,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await this.table.put(record.id, record)
    return record
  }

  list(): ExpertRecord[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  get(id: string): ExpertRecord | undefined {
    return this.table.get(id)
  }

  byName(name: string): ExpertRecord | undefined {
    return this.list().find((expert) => expert.name === name)
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(id)
  }
}

// ---------------------------------------------------------------------------
// 知识足迹画像（TF-IDF 质心）
// ---------------------------------------------------------------------------

/** 单位向量画像（术语 → TF-IDF 权重，已 L2 归一化）。 */
export interface ExpertProfile {
  readonly expert: ExpertRecord
  /** 画像语料的术语总数（足迹规模）。 */
  readonly corpusSize: number
  /** 足迹来源拆解（领域/评审/评论各贡献的语料量）。 */
  readonly sources: { domain: number; reviews: number; comments: number }
  /** TF-IDF 单位向量（术语 → 权重）。 */
  readonly vector: ReadonlyMap<string, number>
}

/** 全体专家的画像集合（含共享 IDF 词表）。 */
export interface ProfileIndex {
  readonly profiles: readonly ExpertProfile[]
  /** 术语 → IDF。 */
  readonly idf: ReadonlyMap<string, number>
}

/** 计数累加器。 */
function bumpCounts(map: Map<string, number>, tokens: readonly string[], weight: number): void {
  for (const token of tokens) map.set(token, (map.get(token) ?? 0) + weight)
}

/**
 * 构建全体专家的知识足迹索引：
 * 语料聚合 → 跨专家 IDF → TF-IDF 加权 → L2 归一化。
 */
export function buildProfileIndex(
  experts: readonly ExpertRecord[],
  reviews: readonly ReviewRequest[],
  comments: readonly ReviewComment[],
  decisions: readonly ReviewDecision[],
): ProfileIndex {
  // 1. 每位专家的语料计数（按来源加权）。
  const counts = new Map<string, Map<string, number>>()
  const corpusSizes = new Map<string, number>()
  const sources = new Map<string, { domain: number; reviews: number; comments: number }>()
  const ensure = (id: string): Map<string, number> => {
    let m = counts.get(id)
    if (!m) {
      m = new Map()
      counts.set(id, m)
      corpusSizes.set(id, 0)
      sources.set(id, { domain: 0, reviews: 0, comments: 0 })
    }
    return m
  }
  /** 确保 sources 条目存在并返回可变引用（消除调用点非空断言）。 */
  const ensureSource = (id: string): { domain: number; reviews: number; comments: number } => {
    let s = sources.get(id)
    if (!s) {
      s = { domain: 0, reviews: 0, comments: 0 }
      sources.set(id, s)
    }
    return s
  }
  const add = (id: string, text: string, weight: number): void => {
    const tokens = tokenize(text)
    bumpCounts(ensure(id), tokens, weight)
    corpusSizes.set(id, (corpusSizes.get(id) ?? 0) + tokens.length * weight)
  }

  for (const expert of experts) {
    // 先建条目再统计：无领域且无 bio 的专家此前会让 sources.get 返回
    // undefined 并被非空断言掩盖成运行时崩溃（防御缺口修复）。
    const source = ensureSource(expert.id)
    if (expert.domains.length > 0) add(expert.id, expert.domains.join(' '), DOMAIN_WEIGHT)
    if (expert.bio) add(expert.id, expert.bio, COMMENT_WEIGHT)
    source.domain += expert.domains.join(' ').length
  }
  for (const review of reviews) {
    const expert = experts.find((e) => e.name === review.author)
    if (!expert) continue
    add(expert.id, `${review.title} ${review.proposedContent.slice(0, 500)} ${review.note}`, REVIEW_WEIGHT)
    ensureSource(expert.id).reviews += 1
  }
  for (const comment of comments) {
    const expert = experts.find((e) => e.name === comment.author)
    if (!expert) continue
    add(expert.id, comment.content, COMMENT_WEIGHT)
    ensureSource(expert.id).comments += 1
  }
  for (const decision of decisions) {
    const expert = experts.find((e) => e.name === decision.reviewer)
    if (!expert) continue
    add(expert.id, decision.comment, COMMENT_WEIGHT)
    ensureSource(expert.id).comments += 1
  }

  // 2. 跨专家 IDF：log((N+1)/(df+1)) + 1（平滑，避免零 IDF）。
  const expertCount = experts.length
  const df = new Map<string, number>()
  for (const expert of experts) {
    const seen = new Set(counts.get(expert.id)?.keys() ?? [])
    for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const idf = new Map<string, number>()
  for (const [term, count] of df) {
    idf.set(term, Math.log((expertCount + 1) / (count + 1)) + 1)
  }

  // 3. TF-IDF 加权 + L2 归一化 → 足迹单位向量。
  const profiles: ExpertProfile[] = experts.map((expert) => {
    const raw = counts.get(expert.id) ?? new Map<string, number>()
    const vector = new Map<string, number>()
    let norm = 0
    for (const [term, tf] of raw) {
      const weight = tf * (idf.get(term) ?? 1)
      vector.set(term, weight)
      norm += weight * weight
    }
    norm = Math.sqrt(norm)
    if (norm > 0) {
      for (const [term, weight] of vector) vector.set(term, weight / norm)
    }
    return {
      expert,
      corpusSize: corpusSizes.get(expert.id) ?? 0,
      sources: sources.get(expert.id) ?? { domain: 0, reviews: 0, comments: 0 },
      vector,
    }
  })

  return { profiles, idf }
}

/** 画像视图（面板展示用：顶部术语 + 足迹规模）。 */
export interface ProfileView {
  readonly id: string
  readonly name: string
  readonly domains: readonly string[]
  readonly bio: string
  readonly corpusSize: number
  readonly sources: { domain: number; reviews: number; comments: number }
  /** TF-IDF 权重最高的术语（知识足迹的关键词云）。 */
  readonly topTerms: readonly { readonly term: string; readonly weight: number }[]
}

/** 画像集合的报告视图。 */
export function profileViews(index: ProfileIndex): ProfileView[] {
  return index.profiles.map((profile) => ({
    id: profile.expert.id,
    name: profile.expert.name,
    domains: profile.expert.domains,
    bio: profile.expert.bio,
    corpusSize: profile.corpusSize,
    sources: profile.sources,
    topTerms: [...profile.vector.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, PROFILE_TOP_TERMS)
      .map(([term, weight]) => ({ term, weight: Math.round(weight * 1000) / 1000 })),
  }))
}

// ---------------------------------------------------------------------------
// 余弦路由
// ---------------------------------------------------------------------------

/** 单位候选专家的匹配结果。 */
export interface ExpertMatch {
  readonly id: string
  readonly name: string
  readonly domains: readonly string[]
  /** 问题向量与足迹向量的余弦相似度。 */
  readonly similarity: number
  /** 问题术语在该足迹中的覆盖率（0-1）。 */
  readonly coverage: number
  /** 命中的高权重术语（为什么是他）。 */
  readonly matchedTerms: readonly { readonly term: string; readonly weight: number }[]
}

/** 路由报告。 */
export interface RoutingReport {
  readonly question: string
  /** 路由是否可用（至少注册过一位专家）。 */
  readonly available: boolean
  /** 按相似度降序的全部候选。 */
  readonly candidates: readonly ExpertMatch[]
  /** 推荐专家（无充分信号为 null）。 */
  readonly recommended: ExpertMatch | null
  /** 裁决：confident / tentative / gap。 */
  readonly verdict: 'confident' | 'tentative' | 'gap'
  /** 裁决说明（中文，可展示）。 */
  readonly message: string
  /** 知识盲区：全体足迹都未覆盖的问题术语。 */
  readonly uncoveredTerms: readonly string[]
}

/**
 * 专家路由：问题 → TF-IDF 向量 → 与各足迹余弦匹配。
 * 输出排序候选、推荐、覆盖率与知识盲区术语。
 */
export function routeQuestion(index: ProfileIndex, question: string): RoutingReport {
  const tokens = tokenize(question)
  const uniqueTokens = [...new Set(tokens)]
  const available = index.profiles.length > 0

  if (!available || uniqueTokens.length === 0) {
    return {
      question,
      available,
      candidates: [],
      recommended: null,
      verdict: 'gap',
      message: !available
        ? '尚未注册任何专家，请先通过 POST /team/experts 建立团队专家目录'
        : '问题没有可识别的术语',
      uncoveredTerms: uniqueTokens,
    }
  }

  // 问题向量：TF × 共享 IDF，L2 归一化。
  const tf = new Map<string, number>()
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
  let qNorm = 0
  const qWeights = new Map<string, number>()
  for (const [term, count] of tf) {
    const weight = count * (index.idf.get(term) ?? 1)
    qWeights.set(term, weight)
    qNorm += weight * weight
  }
  qNorm = Math.sqrt(qNorm)

  const candidates: ExpertMatch[] = index.profiles.map((profile) => {
    let dot = 0
    const matched: Array<{ term: string; weight: number }> = []
    let covered = 0
    for (const [term, qWeight] of qWeights) {
      const pWeight = profile.vector.get(term)
      if (pWeight === undefined) continue
      covered += 1
      dot += (qWeight / qNorm) * pWeight
      matched.push({ term, weight: Math.round(pWeight * 1000) / 1000 })
    }
    matched.sort((a, b) => b.weight - a.weight)
    return {
      id: profile.expert.id,
      name: profile.expert.name,
      domains: profile.expert.domains,
      similarity: Math.round(dot * 10_000) / 10_000,
      coverage: Math.round((covered / uniqueTokens.length) * 100) / 100,
      matchedTerms: matched.slice(0, 8),
    }
  })
  candidates.sort((a, b) => b.similarity - a.similarity || b.coverage - a.coverage)

  // 知识盲区：任何足迹都未覆盖的术语。
  const allTerms = new Set<string>()
  for (const profile of index.profiles) {
    for (const term of profile.vector.keys()) allTerms.add(term)
  }
  const uncoveredTerms = uniqueTokens.filter((term) => !allTerms.has(term))

  const top = candidates[0]
  const confident = top.similarity >= CONFIDENT_COSINE && top.coverage >= CONFIDENT_COVERAGE
  const verdict: RoutingReport['verdict'] = confident
    ? 'confident'
    : top.similarity > 0
      ? 'tentative'
      : 'gap'
  const message =
    verdict === 'confident'
      ? `推荐找「${top.name}」（余弦相似度 ${top.similarity}，术语覆盖 ${Math.round(top.coverage * 100)}%` +
        `${top.matchedTerms.length > 0 ? `，命中术语：${top.matchedTerms.slice(0, 3).map((m) => m.term).join('、')}` : ''}）`
      : verdict === 'tentative'
        ? `信号较弱：最接近的是「${top.name}」（相似度 ${top.similarity}，覆盖 ${Math.round(top.coverage * 100)}%），建议补充更多评审产出或自报领域后再路由`
        : '团队知识盲区：没有任何专家的足迹覆盖该问题，建议培养对应领域专家或沉淀文档'

  return {
    question,
    available,
    candidates,
    recommended: verdict === 'confident' ? top : null,
    verdict,
    message,
    uncoveredTerms,
  }
}
