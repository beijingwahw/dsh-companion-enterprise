/**
 * 模块 C 创新扩展：语义缓存（Semantic Response Cache）。
 *
 * 预测哨兵回答「钱什么时候花完」，自适应路由回答「这次调用交给哪个
 * 模型」——但最便宜的一次调用，是根本不发生的调用。企业里大量请求
 * 是近重复的：相似的环境排查、相似的代码审查、相似的格式转换，
 * 字面不同而语义雷同。GPTCache 等语义缓存系统证明：对这类请求
 * 复用历史响应，可在不损失可用性的前提下砍掉可观比例的推理成本。
 *
 * 方法论（MinHash-LSH 近重复检测，搜索引擎去重的工业标准）：
 * 1. Shingling：请求文本归一化后切 3-gram 词片（shingle），
 *    集合近似 = 文档语义指纹；
 * 2. MinHash：64 个随机哈希函数对 shingle 集合压缩成固定长度签名，
 *    两签名相同位置的比例 = Jaccard 相似度的无偏估计——
 *    O(1) 比较替代 O(n) 集合交并；
 * 3. LSH 分带（16 带 × 4 行）：签名切成 16 段，任一段完全相同即
 *    成为候选——把两两比较从 O(N²) 降为桶内比较，近重复必然撞桶；
 * 4. 命中判定：候选中估计 Jaccard ≥ 阈值（默认 0.85）即判近重复，
 *    直接复用响应，节省额 = 原调用输入+输出 token 与费用；
 * 5. LRU + TTL 淘汰：容量上限内按最近命中时间逐出，过期条目
 *    先于一切判定被剪除——缓存本身也要「保鲜」。
 *
 * 纯函数（shingles/minHashSignature/estimateJaccard）与存储
 * （SemanticCacheStore）分离，便于单测与复算。
 */
/** 缓存条目（'semantic-cache' 表 kind:'entry' 记录）。 */
export interface SemanticCacheEntry {
    readonly kind: 'entry';
    readonly entryId: string;
    /** 原始请求文本（命中后原样返回给调用方比对）。 */
    readonly prompt: string;
    /** 缓存的响应文本。 */
    readonly response: string;
    /** 生成响应用的模型（缺省 deepseek-chat）。 */
    readonly model: string;
    /** MinHash 签名（64 维；与 LSH 索引一起在内存重建）。 */
    readonly signature: readonly number[];
    /** 入库时调用的输入 token（缺省按字符估算）。 */
    readonly inputTokens: number;
    /** 入库时调用的输出 token。 */
    readonly outputTokens: number;
    /** 入库时调用的实际费用（元；后续每次命中 ≈ 再省一次该费用）。 */
    readonly costCny: number;
    readonly createdAt: number;
    /** 最近一次命中时间（LRU 逐出依据；从未命中 = createdAt）。 */
    readonly lastHitAt: number;
    /** 累计命中次数。 */
    readonly hits: number;
}
/** 缓存运行统计（'semantic-cache' 表 kind:'stats' 记录）。 */
export interface SemanticCacheStats {
    readonly kind: 'stats';
    /** 累计 lookup 次数（含未命中）。 */
    readonly lookups: number;
    /** 累计命中次数（含 TTL 过期前）。 */
    readonly hits: number;
    /** 累计节省 token（输入+输出）。 */
    readonly savedTokens: number;
    /** 累计节省费用（元）。 */
    readonly savedCny: number;
    readonly updatedAt: number;
}
/** 表记录联合（条目与统计共存于同一张表，键空间分离）。 */
export type SemanticCacheRecord = SemanticCacheEntry | SemanticCacheStats;
/** lookup 结果。 */
export interface SemanticLookupResult {
    readonly hit: boolean;
    /** 最佳候选的估计 Jaccard 相似度（无候选为 0）。 */
    readonly similarity: number;
    /** 命中条目（miss 时缺省）。 */
    readonly entry?: SemanticCacheEntry;
    /** 本次命中节省的 token（miss 为 0）。 */
    readonly savedTokens: number;
    /** 本次命中节省的费用（元；miss 为 0）。 */
    readonly savedCny: number;
}
/** store 结果。 */
export interface SemanticStoreResult {
    readonly entryId: string;
    /** 是否替换了归一化后完全相同的既有条目。 */
    readonly replaced: boolean;
}
/** 面板报告。 */
export interface SemanticCacheReport {
    readonly entries: number;
    readonly capacity: number;
    readonly lookups: number;
    readonly hits: number;
    readonly hitRate: number;
    readonly savedTokens: number;
    readonly savedCny: number;
    readonly ttlDays: number;
    /** 最近条目（按命中时间降序，≤20 条，不含响应正文）。 */
    readonly recent: readonly {
        readonly entryId: string;
        readonly prompt: string;
        readonly model: string;
        readonly hits: number;
        readonly savedTokens: number;
        readonly lastHitAt: number;
    }[];
}
/** MinHash 签名维度。 */
export declare const SIGNATURE_SIZE = 64;
/** 命中判定阈值（估计 Jaccard ≥ 该值判近重复）。 */
export declare const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
/** 条目容量上限（LRU 逐出）。 */
export declare const CACHE_CAPACITY = 500;
/** 条目 TTL（天）。 */
export declare const CACHE_TTL_DAYS = 7;
/** 文本归一化：小写 + 压空白（保留 CJK 字符）。 */
export declare function normalizeText(text: string): string;
/**
 * 3-gram 词片集合：语义指纹的最小单元。
 * 少于 3 个词时退化为整句单片（短文本不做无意义的切分）。
 */
export declare function shingles(text: string): string[];
/**
 * MinHash 签名：第 i 维 = min over shingles 的 h_i(shingle)。
 * 空文本返回全 0 签名（不参与命中，但形状稳定）。
 */
export declare function minHashSignature(text: string): number[];
/** 估计 Jaccard 相似度：签名相同位置比例（无偏估计）。 */
export declare function estimateJaccard(a: readonly number[], b: readonly number[]): number;
/** 语义缓存仓库（'semantic-cache' 表 + 内存 LSH 桶索引）。 */
export declare class SemanticCacheStore {
    private readonly now;
    private readonly table;
    /** LSH 桶索引：bandKey → entryId 集合（启动时由条目重建）。 */
    private readonly buckets;
    constructor(domain: import('../../core/storage-adapter.js').Domain, now?: () => number);
    private indexAdd;
    private indexRemove;
    private statsRecord;
    private bumpStats;
    /** 条目是否仍在 TTL 内。 */
    private fresh;
    /**
     * 近重复查找：LSH 桶收集候选 → 估计 Jaccard 取最优 → 阈值判定。
     * 命中即回填命中计数与节省账本。
     */
    lookup(prompt: string, threshold?: number): Promise<SemanticLookupResult>;
    /**
     * 写入条目：归一化后与既有条目完全相同 → 原位替换（replaced）；
     * 容量满 → 逐出最久未命中条目。
     */
    store(input: {
        prompt: string;
        response: string;
        model?: string;
        inputTokens?: number;
        outputTokens?: number;
        costCny?: number;
    }): Promise<SemanticStoreResult>;
    /** 面板报告：容量/命中率/节省账本/最近条目。 */
    report(): SemanticCacheReport;
    /** 清空缓存（条目与统计一并重置）。 */
    clear(): Promise<void>;
}
