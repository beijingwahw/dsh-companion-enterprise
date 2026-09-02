import { jaccardSets } from '../../core/text.js';
import type { SessionQueryEngine, SessionRecord } from '../../types/harness.js';
import type { TagStore } from './tags.js';
/** 文本 → 字符 3-gram 集合（小写、去空白；对中文/代码/混写统一处理）。共享实现见 core/text.ts。 */
export declare function shinglesOf(text: string): Set<string>;
/**
 * 文本 → 词项频率表。
 * 拉丁部分取整词（auth、token、oom）；中文按二元词组（bigram）——
 * bigram 与子串型全文索引天然契合，且自带"部分命中"能力。
 */
export declare function termsOf(text: string): Map<string, number>;
/** Jaccard 相似度（两集合交集/并集；双空集约定 1）。共享实现见 core/text.ts。 */
export declare const jaccard: typeof jaccardSets;
/** 包含度：|A∩B| / |A|（A 在 B 中的覆盖比例；短查询 vs 长文档的关键度量）。 */
export declare function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number;
/** 索引条目。 */
export interface SessionIndexEntry {
    readonly record: SessionRecord;
    readonly shingles: ReadonlySet<string>;
    readonly terms: ReadonlyMap<string, number>;
    readonly textChars: number;
}
/** 全语料会话索引（内存缓存 + TTL 重建）。 */
export declare class SessionIndex {
    private readonly sessionQuery;
    private readonly ttlMs;
    private entries;
    /** 词项 → 出现该词项的会话数（文档频率）。 */
    private df;
    private builtAt;
    private building;
    constructor(sessionQuery: SessionQueryEngine, ttlMs?: number);
    /** 确保索引可用（过期则后台重建；重建完成前用旧索引服务）。 */
    ensure(): Promise<void>;
    private rebuild;
    /** 全部条目。 */
    list(): SessionIndexEntry[];
    get(sessionId: string): SessionIndexEntry | undefined;
    /** 词项的文档频率。 */
    dfOf(term: string): number;
    /** 已索引会话数。 */
    get size(): number;
}
/** 邻域会话（与查询的相似度证据）。 */
export interface NeighborhoodItem {
    readonly sessionId: string;
    readonly title: string;
    /** 混合相似度（0-1）。 */
    readonly similarity: number;
}
/** 扩展词项（PRF 产物）。 */
export interface ExpansionTerm {
    readonly term: string;
    /** TF·IDF 权重（邻域内频次 × 全语料稀有度）。 */
    readonly weight: number;
}
/** PRF 结果。 */
export interface PrfResult {
    readonly neighborhood: readonly NeighborhoodItem[];
    readonly expansionTerms: readonly ExpansionTerm[];
}
/**
 * 伪相关反馈：shingle 相似度取邻域 → 邻域内 TF·IDF 提取扩展词。
 * 邻域/扩展词同时作为证据返回（可解释性：用户能看到"为什么扩展出这个词"）。
 */
export declare function pseudoRelevanceFeedback(index: SessionIndex, queryText: string, opts?: {
    neighborhoodSize?: number;
    maxTerms?: number;
}): PrfResult;
/**
 * 倒数排名融合：score(d) = Σ_lists 1/(k + rank)。
 * 只消费排名不消费分数——不同来源（FTS/相似度）量纲不可比，排名融合
 * 免去标定，是分布式检索的标准做法。
 */
export declare function reciprocalRankFuse(rankedLists: readonly (readonly string[])[], k?: number): Map<string, number>;
/** 语义检索命中。 */
export interface SemanticHit {
    readonly session: SessionRecord;
    readonly snippet?: string;
    readonly tags: string[];
    /** RRF 融合分。 */
    readonly score: number;
    /** 与查询的 shingle 邻域相似度（0-1；不在邻域时为 0）。 */
    readonly neighborhoodSimilarity: number;
    /** 该会话因哪些扩展词在引擎检索中命中。 */
    readonly matchedExpansionTerms: string[];
}
/** 语义检索结果。 */
export interface SemanticSearchResult {
    readonly query: string;
    readonly hits: readonly SemanticHit[];
    readonly expansionTerms: readonly ExpansionTerm[];
    readonly neighborhood: readonly NeighborhoodItem[];
    /** 本次索引扫描的会话数。 */
    readonly scannedSessions: number;
}
/**
 * 语义检索全流程：原始查询 + 扩展词分别过引擎 → 与邻域排名一起 RRF 融合。
 * 各来源互为补充：引擎召回词面命中，邻域召回语义近邻，融合排序去偏。
 */
export declare function semanticSearch(deps: {
    sessionQuery: SessionQueryEngine;
    tagStore: TagStore;
}, index: SessionIndex, query: string, limit: number): Promise<SemanticSearchResult>;
/** 相似会话命中。 */
export interface SimilarSessionHit {
    readonly session: SessionRecord;
    readonly tags: string[];
    /** 混合相似度（0-1）。 */
    readonly similarity: number;
    /** 双方共有的区分性词项（解释"为什么相似"）。 */
    readonly sharedTerms: readonly string[];
}
/** 相似会话结果。 */
export interface SimilarSessionsResult {
    readonly sessionId: string;
    readonly hits: readonly SimilarSessionHit[];
    readonly scannedSessions: number;
}
/**
 * 查找与指定会话最相似的历史会话（more-like-this）。
 * 目标会话即使不在索引中（超出最近 N 条）也会即时读取参与比对。
 */
export declare function similarSessions(deps: {
    sessionQuery: SessionQueryEngine;
    tagStore: TagStore;
}, index: SessionIndex, sessionId: string, limit: number): Promise<SimilarSessionsResult>;
