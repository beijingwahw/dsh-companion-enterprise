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
// --------------------------------------------------------------------
// 参数
// --------------------------------------------------------------------
/** MinHash 签名维度。 */
export const SIGNATURE_SIZE = 64;
/** LSH 分带：带数 × 每带行数 = 签名维度。 */
const LSH_BANDS = 16;
const LSH_ROWS = 4;
/** 命中判定阈值（估计 Jaccard ≥ 该值判近重复）。 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
/** 条目容量上限（LRU 逐出）。 */
export const CACHE_CAPACITY = 500;
/** 条目 TTL（天）。 */
export const CACHE_TTL_DAYS = 7;
/** 统计记录键（与 entryId 键空间隔离）。 */
const STATS_KEY = '__stats__';
/** 一天毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000;
// --------------------------------------------------------------------
// 纯函数：shingle → MinHash → LSH
// --------------------------------------------------------------------
/** 文本归一化：小写 + 压空白（保留 CJK 字符）。 */
export function normalizeText(text) {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
/**
 * 3-gram 词片集合：语义指纹的最小单元。
 * 少于 3 个词时退化为整句单片（短文本不做无意义的切分）。
 */
export function shingles(text) {
    const tokens = normalizeText(text).split(' ').filter((t) => t.length > 0);
    if (tokens.length < 3) {
        return tokens.length === 0 ? [] : [tokens.join(' ')];
    }
    const result = [];
    for (let i = 0; i + 2 < tokens.length; i += 1) {
        result.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
    }
    return result;
}
/** FNV-1a 32 位字符串哈希（确定性，跨进程稳定）。 */
function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
/** mulberry32 确定性 PRNG（固定种子 → 哈希族跨进程一致）。 */
function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** 线性同余哈希族参数（A_i 奇数保证与 2^32 互素）。 */
const HASH_FAMILY = (() => {
    const rand = mulberry32(0x5eed_ca5c);
    const family = [];
    for (let i = 0; i < SIGNATURE_SIZE; i += 1) {
        const a = (Math.floor(rand() * 0xffff_fffe) | 1) >>> 0;
        const b = Math.floor(rand() * 0xffff_ffff) >>> 0;
        family.push({ a, b });
    }
    return family;
})();
/**
 * MinHash 签名：第 i 维 = min over shingles 的 h_i(shingle)。
 * 空文本返回全 0 签名（不参与命中，但形状稳定）。
 */
export function minHashSignature(text) {
    const grams = shingles(text);
    if (grams.length === 0)
        return new Array(SIGNATURE_SIZE).fill(0);
    const hashed = grams.map(fnv1a);
    const signature = [];
    for (const { a, b } of HASH_FAMILY) {
        let min = 0xffff_ffff;
        for (const x of hashed) {
            const value = (Math.imul(x, a) + b) >>> 0;
            if (value < min)
                min = value;
        }
        signature.push(min);
    }
    return signature;
}
/** 估计 Jaccard 相似度：签名相同位置比例（无偏估计）。 */
export function estimateJaccard(a, b) {
    if (a.length === 0 || a.length !== b.length)
        return 0;
    let equal = 0;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] === b[i])
            equal += 1;
    }
    return equal / a.length;
}
/** 单条带键（带内签名行拼接哈希）。 */
function bandKey(signature, band) {
    let text = '';
    for (let r = 0; r < LSH_ROWS; r += 1) {
        text += `${signature[band * LSH_ROWS + r].toString(36)},`;
    }
    return `${band}:${fnv1a(text).toString(36)}`;
}
/** 全部带键（LSH 桶索引的键集合）。 */
function bandKeys(signature) {
    const keys = [];
    for (let band = 0; band < LSH_BANDS; band += 1) {
        keys.push(bandKey(signature, band));
    }
    return keys;
}
/** 字符数 → token 估算（中英混排近似 3.5 字符/token）。 */
function estimateTokens(text) {
    return Math.max(1, Math.ceil(text.length / 3.5));
}
// --------------------------------------------------------------------
// 存储
// --------------------------------------------------------------------
/** 语义缓存仓库（'semantic-cache' 表 + 内存 LSH 桶索引）。 */
export class SemanticCacheStore {
    now;
    table;
    /** LSH 桶索引：bandKey → entryId 集合（启动时由条目重建）。 */
    buckets = new Map();
    constructor(domain, now = Date.now) {
        this.now = now;
        this.table = domain.table('semantic-cache');
        for (const [key, record] of this.table.entries()) {
            if (record.kind === 'entry')
                this.indexAdd(key, record);
        }
    }
    indexAdd(entryId, entry) {
        for (const key of bandKeys(entry.signature)) {
            let set = this.buckets.get(key);
            if (!set) {
                set = new Set();
                this.buckets.set(key, set);
            }
            set.add(entryId);
        }
    }
    indexRemove(entryId, signature) {
        for (const key of bandKeys(signature)) {
            this.buckets.get(key)?.delete(entryId);
        }
    }
    statsRecord() {
        const record = this.table.get(STATS_KEY);
        if (record?.kind === 'stats')
            return record;
        return {
            kind: 'stats',
            lookups: 0,
            hits: 0,
            savedTokens: 0,
            savedCny: 0,
            updatedAt: this.now(),
        };
    }
    async bumpStats(patch) {
        const prev = this.statsRecord();
        const next = {
            kind: 'stats',
            lookups: prev.lookups + (patch.lookups ?? 0),
            hits: prev.hits + (patch.hits ?? 0),
            savedTokens: prev.savedTokens + (patch.savedTokens ?? 0),
            savedCny: Math.round((prev.savedCny + (patch.savedCny ?? 0)) * 10_000) / 10_000,
            updatedAt: this.now(),
        };
        await this.table.put(STATS_KEY, next);
        return next;
    }
    /** 条目是否仍在 TTL 内。 */
    fresh(entry, now) {
        return now - entry.createdAt < CACHE_TTL_DAYS * DAY_MS;
    }
    /**
     * 近重复查找：LSH 桶收集候选 → 估计 Jaccard 取最优 → 阈值判定。
     * 命中即回填命中计数与节省账本。
     */
    async lookup(prompt, threshold = DEFAULT_SIMILARITY_THRESHOLD) {
        const now = this.now();
        const signature = minHashSignature(prompt);
        const candidates = new Set();
        for (const key of bandKeys(signature)) {
            for (const entryId of this.buckets.get(key) ?? [])
                candidates.add(entryId);
        }
        let best;
        let bestSimilarity = 0;
        for (const entryId of candidates) {
            const record = this.table.get(entryId);
            if (record?.kind !== 'entry' || !this.fresh(record, now))
                continue;
            const similarity = estimateJaccard(signature, record.signature);
            if (similarity > bestSimilarity) {
                bestSimilarity = similarity;
                best = record;
            }
        }
        if (!best || bestSimilarity < threshold) {
            await this.bumpStats({ lookups: 1 });
            return { hit: false, similarity: bestSimilarity, savedTokens: 0, savedCny: 0 };
        }
        const savedTokens = best.inputTokens + best.outputTokens;
        const savedCny = best.costCny;
        const updated = {
            ...best,
            lastHitAt: now,
            hits: best.hits + 1,
        };
        await this.table.put(best.entryId, updated);
        await this.bumpStats({ lookups: 1, hits: 1, savedTokens, savedCny });
        return { hit: true, similarity: bestSimilarity, entry: updated, savedTokens, savedCny };
    }
    /**
     * 写入条目：归一化后与既有条目完全相同 → 原位替换（replaced）；
     * 容量满 → 逐出最久未命中条目。
     */
    async store(input) {
        const now = this.now();
        const signature = minHashSignature(input.prompt);
        // 精确去重：归一化 prompt 相同的既有条目原位替换。
        for (const [key, record] of this.table.entries()) {
            if (record.kind !== 'entry')
                continue;
            if (normalizeText(record.prompt) === normalizeText(input.prompt)) {
                this.indexRemove(key, record.signature);
                const replacement = {
                    kind: 'entry',
                    entryId: key,
                    prompt: input.prompt,
                    response: input.response,
                    model: input.model ?? 'deepseek-chat',
                    signature,
                    inputTokens: input.inputTokens ?? estimateTokens(input.prompt),
                    outputTokens: input.outputTokens ?? estimateTokens(input.response),
                    costCny: input.costCny ?? 0,
                    createdAt: now,
                    lastHitAt: now,
                    hits: 0,
                };
                await this.table.put(key, replacement);
                this.indexAdd(key, replacement);
                return { entryId: key, replaced: true };
            }
        }
        // 容量逐出：LRU（lastHitAt 最小者出库）。
        const entries = [];
        for (const record of this.table.entries().map(([, v]) => v)) {
            if (record.kind === 'entry')
                entries.push(record);
        }
        if (entries.length >= CACHE_CAPACITY) {
            let lru = entries[0];
            for (const entry of entries) {
                if (entry.lastHitAt < lru.lastHitAt)
                    lru = entry;
            }
            this.indexRemove(lru.entryId, lru.signature);
            await this.table.delete(lru.entryId);
        }
        const entryId = `sc_${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
        const entry = {
            kind: 'entry',
            entryId,
            prompt: input.prompt,
            response: input.response,
            model: input.model ?? 'deepseek-chat',
            signature,
            inputTokens: input.inputTokens ?? estimateTokens(input.prompt),
            outputTokens: input.outputTokens ?? estimateTokens(input.response),
            costCny: input.costCny ?? 0,
            createdAt: now,
            lastHitAt: now,
            hits: 0,
        };
        await this.table.put(entryId, entry);
        this.indexAdd(entryId, entry);
        return { entryId, replaced: false };
    }
    /** 面板报告：容量/命中率/节省账本/最近条目。 */
    report() {
        const now = this.now();
        const stats = this.statsRecord();
        const entries = [];
        for (const record of this.table.entries().map(([, v]) => v)) {
            if (record.kind === 'entry' && this.fresh(record, now))
                entries.push(record);
        }
        entries.sort((a, b) => b.lastHitAt - a.lastHitAt);
        return {
            entries: entries.length,
            capacity: CACHE_CAPACITY,
            lookups: stats.lookups,
            hits: stats.hits,
            hitRate: stats.lookups > 0 ? Math.round((stats.hits / stats.lookups) * 1000) / 1000 : 0,
            savedTokens: stats.savedTokens,
            savedCny: stats.savedCny,
            ttlDays: CACHE_TTL_DAYS,
            recent: entries.slice(0, 20).map((entry) => ({
                entryId: entry.entryId,
                // 摘要展示（截断，避免面板载荷爆炸）。
                prompt: entry.prompt.slice(0, 80),
                model: entry.model,
                hits: entry.hits,
                savedTokens: entry.hits * (entry.inputTokens + entry.outputTokens),
                lastHitAt: entry.lastHitAt,
            })),
        };
    }
    /** 清空缓存（条目与统计一并重置）。 */
    async clear() {
        for (const key of this.table.keys()) {
            await this.table.delete(key);
        }
        this.buckets.clear();
    }
}
