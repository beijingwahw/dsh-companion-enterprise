/**
 * 模块 D 创新扩展：语义邻域检索（无向量库的轻量语义层）。
 *
 * 现实痛点：Harness 全文检索是"词面匹配"——查"登录鉴权"找不到标题是
 * "auth 失败"的会话，查"内存泄漏"找不到"OOM 排查"。上向量库又太重
 * （本地插件没有嵌入服务与向量索引，还要管模型下载与更新）。
 *
 * 方案：把信息检索领域的三大经典技术用纯本地统计实现，零外部依赖：
 *
 * 1. 字符 shingle 邻域：会话文本（标题+转录）压成字符 3-gram 集合，
 *    Jaccard/包含度度量相似。字符级 shingle 对中文天然友好（无需分词），
 *    对拼写变体/中英混写/驼峰拆写都有韧性；
 * 2. 伪相关反馈（Pseudo-Relevance Feedback, PRF）：先按 shingle 相似度
 *    取 top-N 会话当作"假设相关"的邻域，再从邻域里提取区分性词项
 *    （邻域内高频 × 全语料低频，即 TF·IDF 思想）扩展查询——
 *    "登录鉴权"的邻域里大概率高频出现 "auth"/"token"/"401"，
 *    它们被自动并入检索；
 * 3. 倒数排名融合（Reciprocal Rank Fusion, RRF）：原始查询、每个扩展
 *    词、邻域相似度各自产生一张排名表，RRF 以 Σ 1/(k+rank) 融合，
 *    无需分数标定（不同来源的分数量纲不可比，排名融合是标准解法）。
 *
 * 另提供"相似会话"（more-like-this）：给定一个会话，找出内容最像的
 * 历史会话——排查问题时"我之前是不是遇到过类似的"是高频刚需。
 */
import { SessionId } from '../../core/ids.js';
import { transcriptFromLog } from '../../core/transcript.js';
import { charShingles, jaccardSets } from '../../core/text.js';
/** 索引的会话数上限（按创建时间取最近 N 个，防大库内存膨胀）。 */
const MAX_INDEXED_SESSIONS = 200;
/** 单会话进入索引的文本字符上限（截取前缀，控制 shingle 集合规模）。 */
const PER_SESSION_CHAR_CAP = 20_000;
/** 伪相关反馈的邻域大小。 */
const NEIGHBORHOOD_SIZE = 5;
/** 查询扩展词数上限。 */
const MAX_EXPANSION_TERMS = 5;
/** RRF 常数（标准取值 60，源于 Cormack et al. 的实证）。 */
const RRF_K = 60;
/** 引擎检索每次取的候选量。 */
const ENGINE_CANDIDATES = 30;
/** 高频词项过滤：出现在超过该比例会话中的词项不参与扩展（停用词治理）。 */
const STOPWORD_RATIO = 0.6;
/** 拉丁词项（代码标识符/英文单词）。 */
const LATIN_TERM = /[a-z][a-z0-9_\-]{1,30}/g;
/** CJK 连续段。 */
const CJK_RUN = /[\u4e00-\u9fff]+/g;
// ---------------------------------------------------------------------------
// 文本 → shingle / 词项
// ---------------------------------------------------------------------------
/** 文本 → 字符 3-gram 集合（小写、去空白；对中文/代码/混写统一处理）。共享实现见 core/text.ts。 */
export function shinglesOf(text) {
    return charShingles(text);
}
/**
 * 文本 → 词项频率表。
 * 拉丁部分取整词（auth、token、oom）；中文按二元词组（bigram）——
 * bigram 与子串型全文索引天然契合，且自带"部分命中"能力。
 */
export function termsOf(text) {
    const tf = new Map();
    const lower = text.toLowerCase();
    for (const match of lower.matchAll(LATIN_TERM)) {
        tf.set(match[0], (tf.get(match[0]) ?? 0) + 1);
    }
    for (const run of lower.matchAll(CJK_RUN)) {
        const chars = [...run[0]];
        for (let i = 0; i + 2 <= chars.length; i += 1) {
            const bigram = chars[i] + chars[i + 1];
            tf.set(bigram, (tf.get(bigram) ?? 0) + 1);
        }
    }
    return tf;
}
// ---------------------------------------------------------------------------
// 相似度度量
// ---------------------------------------------------------------------------
/** Jaccard 相似度（两集合交集/并集；双空集约定 1）。共享实现见 core/text.ts。 */
export const jaccard = jaccardSets;
/** 包含度：|A∩B| / |A|（A 在 B 中的覆盖比例；短查询 vs 长文档的关键度量）。 */
export function containment(a, b) {
    if (a.size === 0)
        return 0;
    let inter = 0;
    for (const item of a) {
        if (b.has(item))
            inter += 1;
    }
    return inter / a.size;
}
/** 全语料会话索引（内存缓存 + TTL 重建）。 */
export class SessionIndex {
    sessionQuery;
    ttlMs;
    entries = new Map();
    /** 词项 → 出现该词项的会话数（文档频率）。 */
    df = new Map();
    builtAt = 0;
    building;
    constructor(sessionQuery, ttlMs = 60_000) {
        this.sessionQuery = sessionQuery;
        this.ttlMs = ttlMs;
    }
    /** 确保索引可用（过期则后台重建；重建完成前用旧索引服务）。 */
    async ensure() {
        if (this.entries.size > 0 && Date.now() - this.builtAt < this.ttlMs)
            return;
        if (this.building)
            return this.building;
        this.building = this.rebuild().finally(() => {
            this.building = undefined;
        });
        return this.building;
    }
    async rebuild() {
        const sessions = [...(await this.sessionQuery.listSessions())]
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, MAX_INDEXED_SESSIONS);
        const entries = new Map();
        const df = new Map();
        for (const session of sessions) {
            try {
                const snapshot = await this.sessionQuery.readSession(SessionId(session.id));
                const turns = transcriptFromLog(snapshot);
                const rawText = `${session.title ?? ''}\n${turns.map((turn) => turn.text).join('\n')}`;
                const text = rawText.slice(0, PER_SESSION_CHAR_CAP);
                const terms = termsOf(text);
                for (const term of terms.keys())
                    df.set(term, (df.get(term) ?? 0) + 1);
                entries.set(session.id, {
                    record: session,
                    shingles: shinglesOf(text),
                    terms,
                    textChars: text.length,
                });
            }
            catch {
                // 单会话读取失败（损坏/权限）：跳过，不影响其余索引。
            }
        }
        this.entries = entries;
        this.df = df;
        this.builtAt = Date.now();
    }
    /** 全部条目。 */
    list() {
        return [...this.entries.values()];
    }
    get(sessionId) {
        return this.entries.get(sessionId);
    }
    /** 词项的文档频率。 */
    dfOf(term) {
        return this.df.get(term) ?? 0;
    }
    /** 已索引会话数。 */
    get size() {
        return this.entries.size;
    }
}
/**
 * 伪相关反馈：shingle 相似度取邻域 → 邻域内 TF·IDF 提取扩展词。
 * 邻域/扩展词同时作为证据返回（可解释性：用户能看到"为什么扩展出这个词"）。
 */
export function pseudoRelevanceFeedback(index, queryText, opts = {}) {
    const neighborhoodSize = opts.neighborhoodSize ?? NEIGHBORHOOD_SIZE;
    const maxTerms = opts.maxTerms ?? MAX_EXPANSION_TERMS;
    const queryShingles = shinglesOf(queryText);
    const queryTerms = new Set(termsOf(queryText).keys());
    // 1. 邻域：混合相似度 = 0.7·包含度（查短文档长）+ 0.3·Jaccard。
    const scored = index
        .list()
        .map((entry) => ({
        entry,
        similarity: 0.7 * containment(queryShingles, entry.shingles) + 0.3 * jaccard(queryShingles, entry.shingles),
    }))
        .filter((item) => item.similarity > 0)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, neighborhoodSize);
    // 2. 扩展词：邻域内 TF 累加 × log(1 + N/df)；排除已在查询中的词、
    //    停用级高频词；优先取频次 ≥2 的词（邻域共识），不足再放宽到 ≥1。
    const total = Math.max(1, index.size);
    const stopwordFloor = total * STOPWORD_RATIO;
    const candidates = new Map();
    for (const { entry } of scored) {
        for (const [term, tf] of entry.terms) {
            if (queryTerms.has(term))
                continue;
            if (term.length < 2)
                continue;
            const df = index.dfOf(term);
            if (df > stopwordFloor)
                continue;
            candidates.set(term, (candidates.get(term) ?? 0) + tf);
        }
    }
    const weightOf = (term, tf) => tf * Math.log(1 + total / Math.max(1, index.dfOf(term)));
    const pickTop = (minTf) => [...candidates.entries()]
        .filter(([, tf]) => tf >= minTf)
        .map(([term, tf]) => ({ term, weight: Math.round(weightOf(term, tf) * 100) / 100 }))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, maxTerms);
    const expansionTerms = pickTop(2).length > 0 ? pickTop(2) : pickTop(1);
    return {
        neighborhood: scored.map((item) => ({
            sessionId: item.entry.record.id,
            title: item.entry.record.title ?? '未命名对话',
            similarity: Math.round(item.similarity * 1000) / 1000,
        })),
        expansionTerms,
    };
}
// ---------------------------------------------------------------------------
// RRF 融合
// ---------------------------------------------------------------------------
/**
 * 倒数排名融合：score(d) = Σ_lists 1/(k + rank)。
 * 只消费排名不消费分数——不同来源（FTS/相似度）量纲不可比，排名融合
 * 免去标定，是分布式检索的标准做法。
 */
export function reciprocalRankFuse(rankedLists, k = RRF_K) {
    const scores = new Map();
    for (const list of rankedLists) {
        list.forEach((id, position) => {
            const rank = position + 1;
            scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
        });
    }
    return scores;
}
/**
 * 语义检索全流程：原始查询 + 扩展词分别过引擎 → 与邻域排名一起 RRF 融合。
 * 各来源互为补充：引擎召回词面命中，邻域召回语义近邻，融合排序去偏。
 */
export async function semanticSearch(deps, index, query, limit) {
    await index.ensure();
    const prf = pseudoRelevanceFeedback(index, query);
    // 各来源的排名表（sessionId 有序列表）。
    const rankedLists = [];
    const snippetOf = new Map();
    const matchedTermsOf = new Map();
    // 1. 原始查询过引擎。
    try {
        const page = await deps.sessionQuery.searchSessions({ query, limit: ENGINE_CANDIDATES });
        rankedLists.push(page.hits.map((hit) => hit.session.id));
        for (const hit of page.hits) {
            if (hit.snippet)
                snippetOf.set(hit.session.id, hit.snippet);
        }
    }
    catch {
        // 引擎检索失败：退化为纯邻域排序。
    }
    // 2. 每个扩展词过引擎（词项召回补全；同时记录每个会话因哪个词命中）。
    for (const { term } of prf.expansionTerms) {
        try {
            const page = await deps.sessionQuery.searchSessions({ query: term, limit: ENGINE_CANDIDATES });
            rankedLists.push(page.hits.map((hit) => hit.session.id));
            for (const hit of page.hits) {
                if (hit.snippet && !snippetOf.has(hit.session.id))
                    snippetOf.set(hit.session.id, hit.snippet);
                const list = matchedTermsOf.get(hit.session.id) ?? [];
                list.push(term);
                matchedTermsOf.set(hit.session.id, list);
            }
        }
        catch {
            // 单扩展词失败不影响整体。
        }
    }
    // 3. 邻域相似度排名（纯本地）。
    rankedLists.push(prf.neighborhood.map((item) => item.sessionId));
    // RRF 融合 + 组装命中。
    const fused = reciprocalRankFuse(rankedLists);
    const similarityOf = new Map(prf.neighborhood.map((item) => [item.sessionId, item.similarity]));
    const hits = [...fused.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([sessionId, score]) => {
        const entry = index.get(sessionId);
        return {
            session: entry?.record ?? { id: sessionId, createdAt: 0 },
            snippet: snippetOf.get(sessionId),
            tags: deps.tagStore.getForSession(SessionId(sessionId)),
            score: Math.round(score * 10000) / 10000,
            neighborhoodSimilarity: similarityOf.get(sessionId) ?? 0,
            matchedExpansionTerms: matchedTermsOf.get(sessionId) ?? [],
        };
    });
    return {
        query,
        hits,
        expansionTerms: prf.expansionTerms,
        neighborhood: prf.neighborhood,
        scannedSessions: index.size,
    };
}
/**
 * 查找与指定会话最相似的历史会话（more-like-this）。
 * 目标会话即使不在索引中（超出最近 N 条）也会即时读取参与比对。
 */
export async function similarSessions(deps, index, sessionId, limit) {
    await index.ensure();
    let target = index.get(sessionId);
    if (!target) {
        // 目标不在索引内：即时读取构建临时条目。
        const snapshot = await deps.sessionQuery.readSession(SessionId(sessionId));
        const turns = transcriptFromLog(snapshot);
        const text = `${snapshot.session.title ?? ''}\n${turns.map((turn) => turn.text).join('\n')}`.slice(0, PER_SESSION_CHAR_CAP);
        target = {
            record: snapshot.session,
            shingles: shinglesOf(text),
            terms: termsOf(text),
            textChars: text.length,
        };
    }
    const total = Math.max(1, index.size);
    const hits = [];
    for (const entry of index.list()) {
        if (entry.record.id === sessionId)
            continue;
        const similarity = 0.6 * jaccard(target.shingles, entry.shingles) + 0.4 * containment(target.shingles, entry.shingles);
        if (similarity <= 0)
            continue;
        // 共有区分性词项：按 IDF 升序（越稀有越靠前）取前 5，解释"为什么相似"。
        const shared = [...target.terms.keys()]
            .filter((term) => entry.terms.has(term) && index.dfOf(term) < total * STOPWORD_RATIO)
            .sort((a, b) => index.dfOf(a) - index.dfOf(b))
            .slice(0, 5);
        hits.push({
            session: entry.record,
            tags: deps.tagStore.getForSession(entry.record.id),
            similarity: Math.round(similarity * 1000) / 1000,
            sharedTerms: shared,
        });
    }
    hits.sort((a, b) => b.similarity - a.similarity);
    return { sessionId, hits: hits.slice(0, limit), scannedSessions: index.size };
}
