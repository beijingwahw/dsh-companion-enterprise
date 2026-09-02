/** PageRank 阻尼系数。 */
const DAMPING = 0.85;
/** 幂迭代最大轮数。 */
const MAX_ITERATIONS = 30;
/** 收敛阈值。 */
const TOLERANCE = 1e-6;
/** 健康覆盖人数（≥ 该值视为健康）。 */
const HEALTHY_COVERAGE = 3;
/** 无向加权图上的 PageRank 幂迭代。 */
function pagerank(nodes, adjacency) {
    const count = nodes.length;
    const scores = new Map();
    for (const node of nodes)
        scores.set(node, 1 / count);
    if (count === 0)
        return scores;
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
        const next = new Map();
        let dangling = 0;
        for (const node of nodes) {
            const neighbors = adjacency.get(node);
            if (!neighbors || neighbors.size === 0) {
                dangling += scores.get(node) ?? 0;
                continue;
            }
            const total = [...neighbors.values()].reduce((a, b) => a + b, 0);
            for (const [neighbor, weight] of neighbors) {
                next.set(neighbor, (next.get(neighbor) ?? 0) + ((scores.get(node) ?? 0) * weight) / total);
            }
        }
        for (const node of nodes) {
            const base = (1 - DAMPING) / count + (DAMPING * (dangling / count));
            next.set(node, (next.get(node) ?? 0) * DAMPING + base);
        }
        let delta = 0;
        for (const node of nodes)
            delta += Math.abs((next.get(node) ?? 0) - (scores.get(node) ?? 0));
        for (const [node, value] of next)
            scores.set(node, value);
        if (delta < TOLERANCE)
            break;
    }
    return scores;
}
/**
 * Bus Factor 与协作中心性分析（纯函数）。
 * @param experts 全部专家记录。
 * @param reviews 全部评审请求。
 * @param comments 全部评审评论。
 */
export function analyzeBusFactor(experts, reviews, comments) {
    // ------------------------------------------------------------------
    // 1. 领域覆盖矩阵。
    // ------------------------------------------------------------------
    const domainMembers = new Map();
    for (const expert of experts) {
        for (const domain of expert.domains) {
            const key = domain.trim();
            if (key.length === 0)
                continue;
            let set = domainMembers.get(key);
            if (!set) {
                set = new Set();
                domainMembers.set(key, set);
            }
            set.add(expert.name);
        }
    }
    const domains = [...domainMembers.entries()]
        .map(([domain, members]) => ({
        domain,
        members: [...members].sort((a, b) => a.localeCompare(b, 'zh-CN')),
        coverage: members.size,
        atRisk: members.size <= 1,
    }))
        .sort((a, b) => a.coverage - b.coverage || a.domain.localeCompare(b.domain, 'zh-CN'));
    const busFactor = domains.length > 0 ? domains[0].coverage : null;
    const atRiskCount = domains.filter((d) => d.coverage <= 1).length;
    const fragileCount = domains.filter((d) => d.coverage === 2).length;
    // ------------------------------------------------------------------
    // 2. 协作图（作者 ↔ 评论者无向加权边）。
    // ------------------------------------------------------------------
    const participants = new Set();
    for (const expert of experts)
        participants.add(expert.name);
    const commentsByReview = new Map();
    for (const comment of comments) {
        const list = commentsByReview.get(comment.reviewId) ?? [];
        list.push(comment);
        commentsByReview.set(comment.reviewId, list);
    }
    const adjacency = new Map();
    const participationCount = new Map();
    const bumpEdge = (a, b) => {
        if (a === b)
            return;
        let neighbors = adjacency.get(a);
        if (!neighbors) {
            neighbors = new Map();
            adjacency.set(a, neighbors);
        }
        neighbors.set(b, (neighbors.get(b) ?? 0) + 1);
        let other = adjacency.get(b);
        if (!other) {
            other = new Map();
            adjacency.set(b, other);
        }
        other.set(a, (other.get(a) ?? 0) + 1);
    };
    for (const review of reviews) {
        participants.add(review.author);
        participationCount.set(review.author, (participationCount.get(review.author) ?? 0) + 1);
        for (const comment of commentsByReview.get(review.id) ?? []) {
            participants.add(comment.author);
            participationCount.set(comment.author, (participationCount.get(comment.author) ?? 0) + 1);
            bumpEdge(review.author, comment.author);
        }
    }
    let edges = 0;
    for (const [node, neighbors] of adjacency) {
        for (const [neighbor] of neighbors) {
            if (node < neighbor)
                edges += 1;
        }
    }
    // ------------------------------------------------------------------
    // 3. PageRank 中心性。
    // ------------------------------------------------------------------
    const nodes = [...participants];
    const scores = pagerank(nodes, adjacency);
    const maxScore = Math.max(0, ...scores.values());
    const centrality = nodes
        .map((name) => {
        const score = scores.get(name) ?? 0;
        const neighbors = adjacency.get(name);
        const degree = neighbors ? [...neighbors.values()].reduce((a, b) => a + b, 0) : 0;
        return {
            name,
            score: Math.round(score * 1e6) / 1e6,
            normalized: maxScore > 0 ? Math.round((score / maxScore) * 100) / 100 : 0,
            degree,
            participations: participationCount.get(name) ?? 0,
        };
    })
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-CN'));
    const hubs = centrality.filter((row) => row.normalized >= 0.5);
    // ------------------------------------------------------------------
    // 4. 孤立专家：声明了领域但零协作连接。
    // ------------------------------------------------------------------
    const isolatedExperts = experts
        .filter((expert) => (adjacency.get(expert.name)?.size ?? 0) === 0)
        .map((expert) => ({
        name: expert.name,
        domains: expert.domains,
        note: '未参与任何评审协作——知识没有传播渠道',
    }));
    const riskList = domains.filter((d) => d.atRisk).slice(0, 3).map((d) => d.domain);
    const hubList = hubs.slice(0, 3).map((h) => `${h.name}（度 ${h.degree}）`);
    return {
        domains,
        busFactor,
        atRiskCount,
        fragileCount,
        isolatedExperts,
        centrality,
        hubs,
        edges,
        summary: `${domains.length} 个领域、整体 bus factor ${busFactor ?? '—'}；` +
            `${atRiskCount} 个单点领域${riskList.length > 0 ? `（${riskList.join('、')}）` : ''}，` +
            `${fragileCount} 个脆弱领域（仅 2 人覆盖，< ${HEALTHY_COVERAGE} 为健康线）；` +
            `协作图 ${nodes.length} 人 ${edges} 条边，枢纽 ${hubList.length > 0 ? hubList.join('、') : '无'}；` +
            `${isolatedExperts.length} 位孤立专家。`,
    };
}
