/**
 * 模块 I 创新扩展：Bus Factor 与协作网络中心性（知识单点风险检测）。
 *
 * 专家路由回答「这个问题该问谁」；管理者还有一个更冷酷的问题：
 * 「这个人休假/离职，哪些领域就没人懂了？」——Bus Factor（工程
 * 管理的世界级黑话，源自「一辆大巴撞掉核心成员就瘫痪」）衡量的
 * 正是组织知识的单点故障。本模块给出两张互补的图：
 *
 * 1. 领域覆盖矩阵：专家自报领域 → 领域 → 成员集合。每个领域的
 *    覆盖人数 = 该领域的 bus factor：1 = 单点（红色警报），
 *    2 = 脆弱，≥3 = 健康。整体 bus factor = 全部领域的最小值。
 *    同时检测「孤立专家」——声明了领域却从未出现在任何评审协作中，
 *    知识锁在他一个人脑子里，连传播渠道都没有；
 * 2. 协作图 PageRank（Brin & Page 1998）：每次评审把作者与评论者
 *    连一条无向边，全部评审叠成加权协作图；PageRank 幂迭代找出的
 *    高中心性成员即「协作枢纽」——大量评审经他中转。枢纽是效率
 *    也是瓶颈：他是所有评审流量的必经点，也就是最大的单点。
 *
 * 纯函数模块：输入专家、评审请求、评审评论三张表的全部记录。
 */
import type { ExpertRecord } from './expert.js'
import type { ReviewComment, ReviewRequest } from './types.js'

/** PageRank 阻尼系数。 */
const DAMPING = 0.85

/** 幂迭代最大轮数。 */
const MAX_ITERATIONS = 30

/** 收敛阈值。 */
const TOLERANCE = 1e-6

/** 健康覆盖人数（≥ 该值视为健康）。 */
const HEALTHY_COVERAGE = 3

/** 单领域覆盖条目。 */
export interface DomainCoverage {
  /** 领域关键词。 */
  readonly domain: string
  /** 声明该领域的成员。 */
  readonly members: readonly string[]
  /** 覆盖人数 = 该领域 bus factor。 */
  readonly coverage: number
  /** 是否单点（coverage ≤ 1）。 */
  readonly atRisk: boolean
}

/** 协作图中心性条目。 */
export interface CentralityRow {
  readonly name: string
  /** PageRank 分数（归一化前）。 */
  readonly score: number
  /** 相对最高分的归一化值（0-1）。 */
  readonly normalized: number
  /** 协作连接数（加权度）。 */
  readonly degree: number
  /** 参与评审次数（作者或评论者）。 */
  readonly participations: number
}

/** 孤立专家。 */
export interface IsolatedExpert {
  readonly name: string
  readonly domains: readonly string[]
  /** 未参与任何评审协作。 */
  readonly note: string
}

/** Bus Factor 报告。 */
export interface BusFactorReport {
  /** 领域覆盖（按覆盖人数升序）。 */
  readonly domains: readonly DomainCoverage[]
  /** 整体 bus factor = 最小领域覆盖（无领域数据为 null）。 */
  readonly busFactor: number | null
  /** 单点领域数（coverage ≤ 1）。 */
  readonly atRiskCount: number
  /** 脆弱领域数（coverage = 2）。 */
  readonly fragileCount: number
  readonly isolatedExperts: readonly IsolatedExpert[]
  /** PageRank 中心性（降序，全部成员）。 */
  readonly centrality: readonly CentralityRow[]
  /** 协作枢纽（归一化 ≥ 0.5 的成员）。 */
  readonly hubs: readonly CentralityRow[]
  /** 协作图边数（去重后）。 */
  readonly edges: number
  readonly summary: string
}

/** 无向加权图上的 PageRank 幂迭代。 */
function pagerank(nodes: readonly string[], adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>): Map<string, number> {
  const count = nodes.length
  const scores = new Map<string, number>()
  for (const node of nodes) scores.set(node, 1 / count)
  if (count === 0) return scores
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const next = new Map<string, number>()
    let dangling = 0
    for (const node of nodes) {
      const neighbors = adjacency.get(node)
      if (!neighbors || neighbors.size === 0) {
        dangling += scores.get(node) ?? 0
        continue
      }
      const total = [...neighbors.values()].reduce((a, b) => a + b, 0)
      for (const [neighbor, weight] of neighbors) {
        next.set(neighbor, (next.get(neighbor) ?? 0) + ((scores.get(node) ?? 0) * weight) / total)
      }
    }
    for (const node of nodes) {
      const base = (1 - DAMPING) / count + (DAMPING * (dangling / count))
      next.set(node, (next.get(node) ?? 0) * DAMPING + base)
    }
    let delta = 0
    for (const node of nodes) delta += Math.abs((next.get(node) ?? 0) - (scores.get(node) ?? 0))
    for (const [node, value] of next) scores.set(node, value)
    if (delta < TOLERANCE) break
  }
  return scores
}

/**
 * Bus Factor 与协作中心性分析（纯函数）。
 * @param experts 全部专家记录。
 * @param reviews 全部评审请求。
 * @param comments 全部评审评论。
 */
export function analyzeBusFactor(
  experts: readonly ExpertRecord[],
  reviews: readonly ReviewRequest[],
  comments: readonly ReviewComment[],
): BusFactorReport {
  // ------------------------------------------------------------------
  // 1. 领域覆盖矩阵。
  // ------------------------------------------------------------------
  const domainMembers = new Map<string, Set<string>>()
  for (const expert of experts) {
    for (const domain of expert.domains) {
      const key = domain.trim()
      if (key.length === 0) continue
      let set = domainMembers.get(key)
      if (!set) {
        set = new Set()
        domainMembers.set(key, set)
      }
      set.add(expert.name)
    }
  }
  const domains: DomainCoverage[] = [...domainMembers.entries()]
    .map(([domain, members]) => ({
      domain,
      members: [...members].sort((a, b) => a.localeCompare(b, 'zh-CN')),
      coverage: members.size,
      atRisk: members.size <= 1,
    }))
    .sort((a, b) => a.coverage - b.coverage || a.domain.localeCompare(b.domain, 'zh-CN'))
  const busFactor = domains.length > 0 ? domains[0].coverage : null
  const atRiskCount = domains.filter((d) => d.coverage <= 1).length
  const fragileCount = domains.filter((d) => d.coverage === 2).length

  // ------------------------------------------------------------------
  // 2. 协作图（作者 ↔ 评论者无向加权边）。
  // ------------------------------------------------------------------
  const participants = new Set<string>()
  for (const expert of experts) participants.add(expert.name)
  const commentsByReview = new Map<string, ReviewComment[]>()
  for (const comment of comments) {
    const list = commentsByReview.get(comment.reviewId) ?? []
    list.push(comment)
    commentsByReview.set(comment.reviewId, list)
  }
  const adjacency = new Map<string, Map<string, number>>()
  const participationCount = new Map<string, number>()
  const bumpEdge = (a: string, b: string): void => {
    if (a === b) return
    let neighbors = adjacency.get(a)
    if (!neighbors) {
      neighbors = new Map()
      adjacency.set(a, neighbors)
    }
    neighbors.set(b, (neighbors.get(b) ?? 0) + 1)
    let other = adjacency.get(b)
    if (!other) {
      other = new Map()
      adjacency.set(b, other)
    }
    other.set(a, (other.get(a) ?? 0) + 1)
  }
  for (const review of reviews) {
    participants.add(review.author)
    participationCount.set(review.author, (participationCount.get(review.author) ?? 0) + 1)
    for (const comment of commentsByReview.get(review.id) ?? []) {
      participants.add(comment.author)
      participationCount.set(comment.author, (participationCount.get(comment.author) ?? 0) + 1)
      bumpEdge(review.author, comment.author)
    }
  }
  let edges = 0
  for (const [node, neighbors] of adjacency) {
    for (const [neighbor] of neighbors) {
      if (node < neighbor) edges += 1
    }
  }

  // ------------------------------------------------------------------
  // 3. PageRank 中心性。
  // ------------------------------------------------------------------
  const nodes = [...participants]
  const scores = pagerank(nodes, adjacency)
  const maxScore = Math.max(0, ...scores.values())
  const centrality: CentralityRow[] = nodes
    .map((name) => {
      const score = scores.get(name) ?? 0
      const neighbors = adjacency.get(name)
      const degree = neighbors ? [...neighbors.values()].reduce((a, b) => a + b, 0) : 0
      return {
        name,
        score: Math.round(score * 1e6) / 1e6,
        normalized: maxScore > 0 ? Math.round((score / maxScore) * 100) / 100 : 0,
        degree,
        participations: participationCount.get(name) ?? 0,
      }
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-CN'))
  const hubs = centrality.filter((row) => row.normalized >= 0.5)

  // ------------------------------------------------------------------
  // 4. 孤立专家：声明了领域但零协作连接。
  // ------------------------------------------------------------------
  const isolatedExperts: IsolatedExpert[] = experts
    .filter((expert) => (adjacency.get(expert.name)?.size ?? 0) === 0)
    .map((expert) => ({
      name: expert.name,
      domains: expert.domains,
      note: '未参与任何评审协作——知识没有传播渠道',
    }))

  const riskList = domains.filter((d) => d.atRisk).slice(0, 3).map((d) => d.domain)
  const hubList = hubs.slice(0, 3).map((h) => `${h.name}（度 ${h.degree}）`)
  return {
    domains,
    busFactor,
    atRiskCount,
    fragileCount,
    isolatedExperts,
    centrality,
    hubs,
    edges,
    summary:
      `${domains.length} 个领域、整体 bus factor ${busFactor ?? '—'}；` +
      `${atRiskCount} 个单点领域${riskList.length > 0 ? `（${riskList.join('、')}）` : ''}，` +
      `${fragileCount} 个脆弱领域（仅 2 人覆盖，< ${HEALTHY_COVERAGE} 为健康线）；` +
      `协作图 ${nodes.length} 人 ${edges} 条边，枢纽 ${hubList.length > 0 ? hubList.join('、') : '无'}；` +
      `${isolatedExperts.length} 位孤立专家。`,
  }
}
