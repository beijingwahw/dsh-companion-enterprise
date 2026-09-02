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
import type { ExpertRecord } from './expert.js';
import type { ReviewComment, ReviewRequest } from './types.js';
/** 单领域覆盖条目。 */
export interface DomainCoverage {
    /** 领域关键词。 */
    readonly domain: string;
    /** 声明该领域的成员。 */
    readonly members: readonly string[];
    /** 覆盖人数 = 该领域 bus factor。 */
    readonly coverage: number;
    /** 是否单点（coverage ≤ 1）。 */
    readonly atRisk: boolean;
}
/** 协作图中心性条目。 */
export interface CentralityRow {
    readonly name: string;
    /** PageRank 分数（归一化前）。 */
    readonly score: number;
    /** 相对最高分的归一化值（0-1）。 */
    readonly normalized: number;
    /** 协作连接数（加权度）。 */
    readonly degree: number;
    /** 参与评审次数（作者或评论者）。 */
    readonly participations: number;
}
/** 孤立专家。 */
export interface IsolatedExpert {
    readonly name: string;
    readonly domains: readonly string[];
    /** 未参与任何评审协作。 */
    readonly note: string;
}
/** Bus Factor 报告。 */
export interface BusFactorReport {
    /** 领域覆盖（按覆盖人数升序）。 */
    readonly domains: readonly DomainCoverage[];
    /** 整体 bus factor = 最小领域覆盖（无领域数据为 null）。 */
    readonly busFactor: number | null;
    /** 单点领域数（coverage ≤ 1）。 */
    readonly atRiskCount: number;
    /** 脆弱领域数（coverage = 2）。 */
    readonly fragileCount: number;
    readonly isolatedExperts: readonly IsolatedExpert[];
    /** PageRank 中心性（降序，全部成员）。 */
    readonly centrality: readonly CentralityRow[];
    /** 协作枢纽（归一化 ≥ 0.5 的成员）。 */
    readonly hubs: readonly CentralityRow[];
    /** 协作图边数（去重后）。 */
    readonly edges: number;
    readonly summary: string;
}
/**
 * Bus Factor 与协作中心性分析（纯函数）。
 * @param experts 全部专家记录。
 * @param reviews 全部评审请求。
 * @param comments 全部评审评论。
 */
export declare function analyzeBusFactor(experts: readonly ExpertRecord[], reviews: readonly ReviewRequest[], comments: readonly ReviewComment[]): BusFactorReport;
