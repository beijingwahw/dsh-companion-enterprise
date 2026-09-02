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
import type { SearchHit } from './service.js';
/** MMR λ 缺省（0.7 = 相关性略优先的均衡点）。 */
export declare const DEFAULT_MMR_LAMBDA = 0.7;
/** 单条入选结果。 */
export interface MmrEntry {
    readonly sessionId: string;
    readonly title: string;
    /** 原始名次（1 起，检索引擎排序）。 */
    readonly originalRank: number;
    /** 与查询的余弦相关度（0-1；无词元重合时用位次置信度兜底）。 */
    readonly relevance: number;
    /** 与已选集合的最大相似度（第一条为 0）。 */
    readonly maxRedundancy: number;
    /** MMR 边际分（λ·rel − (1−λ)·redundancy）。 */
    readonly mmrScore: number;
    readonly tags: readonly string[];
}
/** 被淘汰的冗余条目。 */
export interface RedundantDrop {
    readonly sessionId: string;
    readonly title: string;
    readonly originalRank: number;
    /** 与之冗余的已选会话 id。 */
    readonly redundantWith: string;
    readonly similarity: number;
}
/** MMR 报告。 */
export interface MmrReport {
    readonly lambda: number;
    /** 候选总数与入选数。 */
    readonly candidates: number;
    readonly selectedCount: number;
    readonly selected: readonly MmrEntry[];
    readonly dropped: readonly RedundantDrop[];
    /** 多样化前后集合的平均两两相似度。 */
    readonly avgPairwiseSimBefore: number;
    readonly avgPairwiseSimAfter: number;
    readonly summary: string;
}
/** MMR 选项。 */
export interface MmrOptions {
    /** 相关性-多样性权衡（0-1，缺省 0.7）。 */
    readonly lambda?: number;
    /** 入选条数（缺省 10，≤候选数）。 */
    readonly limit?: number;
}
/**
 * MMR 多样性重排（纯函数）。
 * 候选不足 2 条时原样返回（无多样性可言）。
 */
export declare function diversifyHits(hits: readonly SearchHit[], query: string, options?: MmrOptions): MmrReport;
