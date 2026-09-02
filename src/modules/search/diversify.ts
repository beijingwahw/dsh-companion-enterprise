/**
 * 模块 D 创新扩展：MMR 多样性检索重排（Maximal Marginal Relevance）。
 *
 * 检索的隐藏失败模式：前十条结果全是同一话题的近似复述——因为它们
 * 都与查询最相关。用户翻完十条只获得「一个视角 × 十次重复」。
 * Carbonell & Goldstein（SIGIR 1998）的 MMR 是搜索结果多样性的事实
 * 标准算法（现代搜索/推荐摘要的标配思想）：
 *
 *   MMR = argmax_{d∉S} [ λ·sim(query, d) − (1−λ)·max_{s∈S} sim(d, s) ]
 *
 * 每一步在「与查询相关」与「与已选结果不冗余」之间做边际权衡——
 * λ=1 退化为纯相关性排序，λ→0 退化为纯多样性。贪心选择天然给出
 * 「第一条最相关、第二条换个角度、第三条再换」的浏览体验。
 *
 * 向量化复用本模块的词元化（拉丁词 + CJK 二元组，点击模型同源）；
 * 相似度用 L2 归一化 TF 向量的余弦。附带输出冗余审计：
 * 多样化前后集合的平均两两相似度、被淘汰的近似重复对——
 * 「省下 4 条重复」是可度量的收益。
 */
import type { SearchHit } from './service.js'
import { tokenizeQuery } from './rerank.js'

/** MMR λ 缺省（0.7 = 相关性略优先的均衡点）。 */
export const DEFAULT_MMR_LAMBDA = 0.7

/** 近似重复判定（两两余弦 ≥ 该值视为冗余对）。 */
const DUPLICATE_THRESHOLD = 0.8

/** 单条入选结果。 */
export interface MmrEntry {
  readonly sessionId: string
  readonly title: string
  /** 原始名次（1 起，检索引擎排序）。 */
  readonly originalRank: number
  /** 与查询的余弦相关度（0-1；无词元重合时用位次置信度兜底）。 */
  readonly relevance: number
  /** 与已选集合的最大相似度（第一条为 0）。 */
  readonly maxRedundancy: number
  /** MMR 边际分（λ·rel − (1−λ)·redundancy）。 */
  readonly mmrScore: number
  readonly tags: readonly string[]
}

/** 被淘汰的冗余条目。 */
export interface RedundantDrop {
  readonly sessionId: string
  readonly title: string
  readonly originalRank: number
  /** 与之冗余的已选会话 id。 */
  readonly redundantWith: string
  readonly similarity: number
}

/** MMR 报告。 */
export interface MmrReport {
  readonly lambda: number
  /** 候选总数与入选数。 */
  readonly candidates: number
  readonly selectedCount: number
  readonly selected: readonly MmrEntry[]
  readonly dropped: readonly RedundantDrop[]
  /** 多样化前后集合的平均两两相似度。 */
  readonly avgPairwiseSimBefore: number
  readonly avgPairwiseSimAfter: number
  readonly summary: string
}

/** MMR 选项。 */
export interface MmrOptions {
  /** 相关性-多样性权衡（0-1，缺省 0.7）。 */
  readonly lambda?: number
  /** 入选条数（缺省 10，≤候选数）。 */
  readonly limit?: number
}

/** L2 归一化 TF 向量（词元 → 权重）。 */
function unitVector(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  let norm = 0
  for (const count of counts.values()) norm += count * count
  norm = Math.sqrt(norm)
  if (norm === 0) return counts
  for (const [token, count] of counts) counts.set(token, count / norm)
  return counts
}

/** 单位向量余弦。 */
function cosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let dot = 0
  for (const [token, weight] of small) {
    const other = large.get(token)
    if (other !== undefined) dot += weight * other
  }
  return Math.round(dot * 1000) / 1000
}

/** 检索结果的可向量语料：标题 + 摘要 + 标签。 */
function hitText(hit: SearchHit): string {
  return [hit.session.title ?? '', hit.snippet ?? '', hit.tags.join(' ')].join(' ')
}

/**
 * MMR 多样性重排（纯函数）。
 * 候选不足 2 条时原样返回（无多样性可言）。
 */
export function diversifyHits(
  hits: readonly SearchHit[],
  query: string,
  options: MmrOptions = {},
): MmrReport {
  const lambda =
    typeof options.lambda === 'number' && Number.isFinite(options.lambda)
      ? Math.min(1, Math.max(0, options.lambda))
      : DEFAULT_MMR_LAMBDA
  const limit = Math.max(1, Math.min(options.limit ?? 10, hits.length))

  const queryVector = unitVector(tokenizeQuery(query))
  const vectors = hits.map((hit) => unitVector(tokenizeQuery(hitText(hit))))

  // 相关度：与查询的余弦；零向量（无词元重合）退化为位次置信度，
  // 保证 MMR 在词面检索无重合时仍按原序工作。
  const relevance = hits.map((hit, index) => {
    const sim = cosine(queryVector, vectors[index])
    return sim > 0 ? sim : 1 / Math.log2(index + 2)
  })

  // 多样化前的基准：原始 top-limit 集合的平均两两相似度。
  const avgPairwise = (indices: readonly number[]): number => {
    if (indices.length < 2) return 0
    let total = 0
    let pairs = 0
    for (let i = 0; i < indices.length; i += 1) {
      for (let j = i + 1; j < indices.length; j += 1) {
        total += cosine(vectors[indices[i]], vectors[indices[j]])
        pairs += 1
      }
    }
    return Math.round((total / pairs) * 1000) / 1000
  }
  const beforeIndices = hits.slice(0, limit).map((_, index) => index)
  const avgPairwiseSimBefore = avgPairwise(beforeIndices)

  // 贪心 MMR。
  const candidates = hits.map((_, index) => index)
  const selected: number[] = []
  while (selected.length < limit && candidates.length > 0) {
    let bestIndex = -1
    let bestScore = Number.NEGATIVE_INFINITY
    let bestRedundancy = 0
    for (const candidate of candidates) {
      let redundancy = 0
      for (const chosen of selected) {
        redundancy = Math.max(redundancy, cosine(vectors[candidate], vectors[chosen]))
      }
      const score = lambda * relevance[candidate] - (1 - lambda) * redundancy
      if (score > bestScore) {
        bestScore = score
        bestIndex = candidate
        bestRedundancy = redundancy
      }
    }
    if (bestIndex < 0) break
    selected.push(bestIndex)
    candidates.splice(candidates.indexOf(bestIndex), 1)
  }

  const entries: MmrEntry[] = selected.map((index, position) => ({
    sessionId: hits[index].session.id,
    title: hits[index].session.title ?? '(无标题)',
    originalRank: index + 1,
    relevance: relevance[index],
    maxRedundancy: position === 0 ? 0 : maxRedundancyOf(index, selected, position, vectors),
    mmrScore: Math.round(bestScoreOf(index, relevance, selected, position, vectors, lambda) * 1000) / 1000,
    tags: hits[index].tags,
  }))

  // 淘汰审计：与已选条目相似度 ≥ 阈值的落选者。
  const dropped: RedundantDrop[] = []
  for (const candidate of candidates) {
    let bestMatch: { id: string; similarity: number } | undefined
    for (const chosen of selected) {
      const similarity = cosine(vectors[candidate], vectors[chosen])
      if (similarity >= DUPLICATE_THRESHOLD && (!bestMatch || similarity > bestMatch.similarity)) {
        bestMatch = { id: hits[chosen].session.id, similarity }
      }
    }
    if (bestMatch) {
      dropped.push({
        sessionId: hits[candidate].session.id,
        title: hits[candidate].session.title ?? '(无标题)',
        originalRank: candidate + 1,
        redundantWith: bestMatch.id,
        similarity: bestMatch.similarity,
      })
    }
  }

  const avgPairwiseSimAfter = avgPairwise(selected)
  return {
    lambda,
    candidates: hits.length,
    selectedCount: selected.length,
    selected: entries,
    dropped,
    avgPairwiseSimBefore,
    avgPairwiseSimAfter,
    summary:
      `${hits.length} 条候选选出 ${selected.length} 条（λ=${lambda}）：` +
      `平均两两冗余 ${avgPairwiseSimBefore.toFixed(3)} → ${avgPairwiseSimAfter.toFixed(3)}` +
      (dropped.length > 0 ? `，淘汰 ${dropped.length} 条近似重复（相似度 ≥ ${DUPLICATE_THRESHOLD}）` : '') +
      '。第一条保相关，后续逐条换角度。',
  }
}

/** 指定候选对已选前缀（不含自身）的最大相似度。 */
function maxRedundancyOf(
  index: number,
  selected: readonly number[],
  position: number,
  vectors: readonly ReadonlyMap<string, number>[],
): number {
  let redundancy = 0
  for (let i = 0; i < position; i += 1) {
    redundancy = Math.max(redundancy, cosine(vectors[index], vectors[selected[i]]))
  }
  return redundancy
}

/** 指定候选的 MMR 边际分（重算，供展示）。 */
function bestScoreOf(
  index: number,
  relevance: readonly number[],
  selected: readonly number[],
  position: number,
  vectors: readonly ReadonlyMap<string, number>[],
  lambda: number,
): number {
  const redundancy = maxRedundancyOf(index, selected, position, vectors)
  return lambda * relevance[index] - (1 - lambda) * redundancy
}
