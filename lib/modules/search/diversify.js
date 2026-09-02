import { tokenizeQuery } from './rerank.js';
/** MMR λ 缺省（0.7 = 相关性略优先的均衡点）。 */
export const DEFAULT_MMR_LAMBDA = 0.7;
/** 近似重复判定（两两余弦 ≥ 该值视为冗余对）。 */
const DUPLICATE_THRESHOLD = 0.8;
/** L2 归一化 TF 向量（词元 → 权重）。 */
function unitVector(tokens) {
    const counts = new Map();
    for (const token of tokens)
        counts.set(token, (counts.get(token) ?? 0) + 1);
    let norm = 0;
    for (const count of counts.values())
        norm += count * count;
    norm = Math.sqrt(norm);
    if (norm === 0)
        return counts;
    for (const [token, count] of counts)
        counts.set(token, count / norm);
    return counts;
}
/** 单位向量余弦。 */
function cosine(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let dot = 0;
    for (const [token, weight] of small) {
        const other = large.get(token);
        if (other !== undefined)
            dot += weight * other;
    }
    return Math.round(dot * 1000) / 1000;
}
/** 检索结果的可向量语料：标题 + 摘要 + 标签。 */
function hitText(hit) {
    return [hit.session.title ?? '', hit.snippet ?? '', hit.tags.join(' ')].join(' ');
}
/**
 * MMR 多样性重排（纯函数）。
 * 候选不足 2 条时原样返回（无多样性可言）。
 */
export function diversifyHits(hits, query, options = {}) {
    const lambda = typeof options.lambda === 'number' && Number.isFinite(options.lambda)
        ? Math.min(1, Math.max(0, options.lambda))
        : DEFAULT_MMR_LAMBDA;
    const limit = Math.max(1, Math.min(options.limit ?? 10, hits.length));
    const queryVector = unitVector(tokenizeQuery(query));
    const vectors = hits.map((hit) => unitVector(tokenizeQuery(hitText(hit))));
    // 相关度：与查询的余弦；零向量（无词元重合）退化为位次置信度，
    // 保证 MMR 在词面检索无重合时仍按原序工作。
    const relevance = hits.map((hit, index) => {
        const sim = cosine(queryVector, vectors[index]);
        return sim > 0 ? sim : 1 / Math.log2(index + 2);
    });
    // 多样化前的基准：原始 top-limit 集合的平均两两相似度。
    const avgPairwise = (indices) => {
        if (indices.length < 2)
            return 0;
        let total = 0;
        let pairs = 0;
        for (let i = 0; i < indices.length; i += 1) {
            for (let j = i + 1; j < indices.length; j += 1) {
                total += cosine(vectors[indices[i]], vectors[indices[j]]);
                pairs += 1;
            }
        }
        return Math.round((total / pairs) * 1000) / 1000;
    };
    const beforeIndices = hits.slice(0, limit).map((_, index) => index);
    const avgPairwiseSimBefore = avgPairwise(beforeIndices);
    // 贪心 MMR。
    const candidates = hits.map((_, index) => index);
    const selected = [];
    while (selected.length < limit && candidates.length > 0) {
        let bestIndex = -1;
        let bestScore = Number.NEGATIVE_INFINITY;
        let bestRedundancy = 0;
        for (const candidate of candidates) {
            let redundancy = 0;
            for (const chosen of selected) {
                redundancy = Math.max(redundancy, cosine(vectors[candidate], vectors[chosen]));
            }
            const score = lambda * relevance[candidate] - (1 - lambda) * redundancy;
            if (score > bestScore) {
                bestScore = score;
                bestIndex = candidate;
                bestRedundancy = redundancy;
            }
        }
        if (bestIndex < 0)
            break;
        selected.push(bestIndex);
        candidates.splice(candidates.indexOf(bestIndex), 1);
    }
    const entries = selected.map((index, position) => ({
        sessionId: hits[index].session.id,
        title: hits[index].session.title ?? '(无标题)',
        originalRank: index + 1,
        relevance: relevance[index],
        maxRedundancy: position === 0 ? 0 : maxRedundancyOf(index, selected, position, vectors),
        mmrScore: Math.round(bestScoreOf(index, relevance, selected, position, vectors, lambda) * 1000) / 1000,
        tags: hits[index].tags,
    }));
    // 淘汰审计：与已选条目相似度 ≥ 阈值的落选者。
    const dropped = [];
    for (const candidate of candidates) {
        let bestMatch;
        for (const chosen of selected) {
            const similarity = cosine(vectors[candidate], vectors[chosen]);
            if (similarity >= DUPLICATE_THRESHOLD && (!bestMatch || similarity > bestMatch.similarity)) {
                bestMatch = { id: hits[chosen].session.id, similarity };
            }
        }
        if (bestMatch) {
            dropped.push({
                sessionId: hits[candidate].session.id,
                title: hits[candidate].session.title ?? '(无标题)',
                originalRank: candidate + 1,
                redundantWith: bestMatch.id,
                similarity: bestMatch.similarity,
            });
        }
    }
    const avgPairwiseSimAfter = avgPairwise(selected);
    return {
        lambda,
        candidates: hits.length,
        selectedCount: selected.length,
        selected: entries,
        dropped,
        avgPairwiseSimBefore,
        avgPairwiseSimAfter,
        summary: `${hits.length} 条候选选出 ${selected.length} 条（λ=${lambda}）：` +
            `平均两两冗余 ${avgPairwiseSimBefore.toFixed(3)} → ${avgPairwiseSimAfter.toFixed(3)}` +
            (dropped.length > 0 ? `，淘汰 ${dropped.length} 条近似重复（相似度 ≥ ${DUPLICATE_THRESHOLD}）` : '') +
            '。第一条保相关，后续逐条换角度。',
    };
}
/** 指定候选对已选前缀（不含自身）的最大相似度。 */
function maxRedundancyOf(index, selected, position, vectors) {
    let redundancy = 0;
    for (let i = 0; i < position; i += 1) {
        redundancy = Math.max(redundancy, cosine(vectors[index], vectors[selected[i]]));
    }
    return redundancy;
}
/** 指定候选的 MMR 边际分（重算，供展示）。 */
function bestScoreOf(index, relevance, selected, position, vectors, lambda) {
    const redundancy = maxRedundancyOf(index, selected, position, vectors);
    return lambda * relevance[index] - (1 - lambda) * redundancy;
}
