import { tokenize } from './store.js';
// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
/** 自报领域语料的权重（最强声明信号）。 */
const DOMAIN_WEIGHT = 3;
/** 评审请求语料的权重。 */
const REVIEW_WEIGHT = 2;
/** 评论/裁定语料的权重。 */
const COMMENT_WEIGHT = 1;
/** confident 裁决的余弦阈值。 */
const CONFIDENT_COSINE = 0.25;
/** confident 裁决的问题术语覆盖率阈值。 */
const CONFIDENT_COVERAGE = 0.5;
/** 画像报告展示的顶部术语数。 */
const PROFILE_TOP_TERMS = 12;
/** 专家仓库。 */
export class ExpertStore {
    table;
    constructor(domain) {
        this.table = domain.table('team-experts');
    }
    /** 保存（新增或更新；同名视为同一专家，更新其领域与简介）。 */
    async save(input) {
        const existing = this.byName(input.name);
        const now = Date.now();
        const record = {
            kind: 'expert',
            id: existing?.id ?? `expert_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            name: input.name,
            domains: input.domains,
            bio: input.bio,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        await this.table.put(record.id, record);
        return record;
    }
    list() {
        return this.table
            .entries()
            .map(([, value]) => value)
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }
    get(id) {
        return this.table.get(id);
    }
    byName(name) {
        return this.list().find((expert) => expert.name === name);
    }
    async delete(id) {
        await this.table.delete(id);
    }
}
/** 计数累加器。 */
function bumpCounts(map, tokens, weight) {
    for (const token of tokens)
        map.set(token, (map.get(token) ?? 0) + weight);
}
/**
 * 构建全体专家的知识足迹索引：
 * 语料聚合 → 跨专家 IDF → TF-IDF 加权 → L2 归一化。
 */
export function buildProfileIndex(experts, reviews, comments, decisions) {
    // 1. 每位专家的语料计数（按来源加权）。
    const counts = new Map();
    const corpusSizes = new Map();
    const sources = new Map();
    const ensure = (id) => {
        let m = counts.get(id);
        if (!m) {
            m = new Map();
            counts.set(id, m);
            corpusSizes.set(id, 0);
            sources.set(id, { domain: 0, reviews: 0, comments: 0 });
        }
        return m;
    };
    /** 确保 sources 条目存在并返回可变引用（消除调用点非空断言）。 */
    const ensureSource = (id) => {
        let s = sources.get(id);
        if (!s) {
            s = { domain: 0, reviews: 0, comments: 0 };
            sources.set(id, s);
        }
        return s;
    };
    const add = (id, text, weight) => {
        const tokens = tokenize(text);
        bumpCounts(ensure(id), tokens, weight);
        corpusSizes.set(id, (corpusSizes.get(id) ?? 0) + tokens.length * weight);
    };
    for (const expert of experts) {
        // 先建条目再统计：无领域且无 bio 的专家此前会让 sources.get 返回
        // undefined 并被非空断言掩盖成运行时崩溃（防御缺口修复）。
        const source = ensureSource(expert.id);
        if (expert.domains.length > 0)
            add(expert.id, expert.domains.join(' '), DOMAIN_WEIGHT);
        if (expert.bio)
            add(expert.id, expert.bio, COMMENT_WEIGHT);
        source.domain += expert.domains.join(' ').length;
    }
    for (const review of reviews) {
        const expert = experts.find((e) => e.name === review.author);
        if (!expert)
            continue;
        add(expert.id, `${review.title} ${review.proposedContent.slice(0, 500)} ${review.note}`, REVIEW_WEIGHT);
        ensureSource(expert.id).reviews += 1;
    }
    for (const comment of comments) {
        const expert = experts.find((e) => e.name === comment.author);
        if (!expert)
            continue;
        add(expert.id, comment.content, COMMENT_WEIGHT);
        ensureSource(expert.id).comments += 1;
    }
    for (const decision of decisions) {
        const expert = experts.find((e) => e.name === decision.reviewer);
        if (!expert)
            continue;
        add(expert.id, decision.comment, COMMENT_WEIGHT);
        ensureSource(expert.id).comments += 1;
    }
    // 2. 跨专家 IDF：log((N+1)/(df+1)) + 1（平滑，避免零 IDF）。
    const expertCount = experts.length;
    const df = new Map();
    for (const expert of experts) {
        const seen = new Set(counts.get(expert.id)?.keys() ?? []);
        for (const term of seen)
            df.set(term, (df.get(term) ?? 0) + 1);
    }
    const idf = new Map();
    for (const [term, count] of df) {
        idf.set(term, Math.log((expertCount + 1) / (count + 1)) + 1);
    }
    // 3. TF-IDF 加权 + L2 归一化 → 足迹单位向量。
    const profiles = experts.map((expert) => {
        const raw = counts.get(expert.id) ?? new Map();
        const vector = new Map();
        let norm = 0;
        for (const [term, tf] of raw) {
            const weight = tf * (idf.get(term) ?? 1);
            vector.set(term, weight);
            norm += weight * weight;
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (const [term, weight] of vector)
                vector.set(term, weight / norm);
        }
        return {
            expert,
            corpusSize: corpusSizes.get(expert.id) ?? 0,
            sources: sources.get(expert.id) ?? { domain: 0, reviews: 0, comments: 0 },
            vector,
        };
    });
    return { profiles, idf };
}
/** 画像集合的报告视图。 */
export function profileViews(index) {
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
    }));
}
/**
 * 专家路由：问题 → TF-IDF 向量 → 与各足迹余弦匹配。
 * 输出排序候选、推荐、覆盖率与知识盲区术语。
 */
export function routeQuestion(index, question) {
    const tokens = tokenize(question);
    const uniqueTokens = [...new Set(tokens)];
    const available = index.profiles.length > 0;
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
        };
    }
    // 问题向量：TF × 共享 IDF，L2 归一化。
    const tf = new Map();
    for (const token of tokens)
        tf.set(token, (tf.get(token) ?? 0) + 1);
    let qNorm = 0;
    const qWeights = new Map();
    for (const [term, count] of tf) {
        const weight = count * (index.idf.get(term) ?? 1);
        qWeights.set(term, weight);
        qNorm += weight * weight;
    }
    qNorm = Math.sqrt(qNorm);
    const candidates = index.profiles.map((profile) => {
        let dot = 0;
        const matched = [];
        let covered = 0;
        for (const [term, qWeight] of qWeights) {
            const pWeight = profile.vector.get(term);
            if (pWeight === undefined)
                continue;
            covered += 1;
            dot += (qWeight / qNorm) * pWeight;
            matched.push({ term, weight: Math.round(pWeight * 1000) / 1000 });
        }
        matched.sort((a, b) => b.weight - a.weight);
        return {
            id: profile.expert.id,
            name: profile.expert.name,
            domains: profile.expert.domains,
            similarity: Math.round(dot * 10_000) / 10_000,
            coverage: Math.round((covered / uniqueTokens.length) * 100) / 100,
            matchedTerms: matched.slice(0, 8),
        };
    });
    candidates.sort((a, b) => b.similarity - a.similarity || b.coverage - a.coverage);
    // 知识盲区：任何足迹都未覆盖的术语。
    const allTerms = new Set();
    for (const profile of index.profiles) {
        for (const term of profile.vector.keys())
            allTerms.add(term);
    }
    const uncoveredTerms = uniqueTokens.filter((term) => !allTerms.has(term));
    const top = candidates[0];
    const confident = top.similarity >= CONFIDENT_COSINE && top.coverage >= CONFIDENT_COVERAGE;
    const verdict = confident
        ? 'confident'
        : top.similarity > 0
            ? 'tentative'
            : 'gap';
    const message = verdict === 'confident'
        ? `推荐找「${top.name}」（余弦相似度 ${top.similarity}，术语覆盖 ${Math.round(top.coverage * 100)}%` +
            `${top.matchedTerms.length > 0 ? `，命中术语：${top.matchedTerms.slice(0, 3).map((m) => m.term).join('、')}` : ''}）`
        : verdict === 'tentative'
            ? `信号较弱：最接近的是「${top.name}」（相似度 ${top.similarity}，覆盖 ${Math.round(top.coverage * 100)}%），建议补充更多评审产出或自报领域后再路由`
            : '团队知识盲区：没有任何专家的足迹覆盖该问题，建议培养对应领域专家或沉淀文档';
    return {
        question,
        available,
        candidates,
        recommended: verdict === 'confident' ? top : null,
        verdict,
        message,
        uncoveredTerms,
    };
}
