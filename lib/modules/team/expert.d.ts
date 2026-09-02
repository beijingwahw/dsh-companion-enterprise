/**
 * 模块 I 创新扩展：专家路由（知识足迹画像 + 余弦匹配）。
 *
 * 团队里最难回答的问题往往不是技术问题，而是「这个问题该问谁」。
 * IM 群里 @错人的代价是一轮轮的踢皮球；企业知识管理研究（expertise
 * retrieval / community question answering）给出的成熟解法是：
 * 让人的「产出」自动累积成可检索的画像——谁写过什么，谁就是
 * 什么方面的专家。
 *
 * 方法论（向量空间模型，Salton 1975 起 IR 的基石）：
 * 1. 知识足迹语料：每位专家的画像语料 = 自报领域（×3 权重，最强的
 *    声明信号）+ 发起的 Prompt 评审请求标题与正文摘录（×2）+ 评审
 *    评论与裁定意见（×1）——全部来自 I3 协作评审的真实署名产出，
 *    不需要任何人额外填表；
 * 2. TF-IDF 质心：语料分词（拉丁词 + CJK 二元组）后按 TF-IDF 加权，
 *    L2 归一化为单位向量——「知识足迹」就是这位专家在组织术语空间
 *    中的位置；IDF 跨专家计算：只有一个人懂的术语权重最高，
 *    人人都提的术语近乎零信息——画像因此自动「差异化」；
 * 3. 余弦路由：问题向量（同一词表、同一 IDF）与各足迹做余弦相似度，
 *    top-1 即推荐专家；输出命中的高权重术语作为「为什么是他」的
 *    可解释证据；
 * 4. 覆盖率与知识盲区检测：问题术语在全部足迹中的覆盖比例——
 *    大量术语无人覆盖时明确报告「团队知识盲区」（该建专家或
 *    该补文档），而不是硬推一个不相关的人；
 * 5. 裁决分级：confident（余弦 ≥ 0.25 且覆盖 ≥ 50%）/ tentative
 *    （有信号但不足）/ gap（无人可答）——路由结果带着可信度出门。
 */
import type { Domain } from '../../core/storage-adapter.js';
import type { ReviewComment, ReviewDecision, ReviewRequest } from './types.js';
/** 团队专家记录（'team-experts' 表，键为专家 id）。 */
export interface ExpertRecord {
    readonly kind: 'expert';
    readonly id: string;
    /** 成员署名（须与评审 author 一致才能吃到评审产出足迹）。 */
    readonly name: string;
    /** 自报领域关键词（画像语料的种子）。 */
    readonly domains: readonly string[];
    readonly bio: string;
    readonly createdAt: number;
    updatedAt: number;
}
/** 专家仓库。 */
export declare class ExpertStore {
    private readonly table;
    constructor(domain: Domain);
    /** 保存（新增或更新；同名视为同一专家，更新其领域与简介）。 */
    save(input: {
        name: string;
        domains: readonly string[];
        bio: string;
    }): Promise<ExpertRecord>;
    list(): ExpertRecord[];
    get(id: string): ExpertRecord | undefined;
    byName(name: string): ExpertRecord | undefined;
    delete(id: string): Promise<void>;
}
/** 单位向量画像（术语 → TF-IDF 权重，已 L2 归一化）。 */
export interface ExpertProfile {
    readonly expert: ExpertRecord;
    /** 画像语料的术语总数（足迹规模）。 */
    readonly corpusSize: number;
    /** 足迹来源拆解（领域/评审/评论各贡献的语料量）。 */
    readonly sources: {
        domain: number;
        reviews: number;
        comments: number;
    };
    /** TF-IDF 单位向量（术语 → 权重）。 */
    readonly vector: ReadonlyMap<string, number>;
}
/** 全体专家的画像集合（含共享 IDF 词表）。 */
export interface ProfileIndex {
    readonly profiles: readonly ExpertProfile[];
    /** 术语 → IDF。 */
    readonly idf: ReadonlyMap<string, number>;
}
/**
 * 构建全体专家的知识足迹索引：
 * 语料聚合 → 跨专家 IDF → TF-IDF 加权 → L2 归一化。
 */
export declare function buildProfileIndex(experts: readonly ExpertRecord[], reviews: readonly ReviewRequest[], comments: readonly ReviewComment[], decisions: readonly ReviewDecision[]): ProfileIndex;
/** 画像视图（面板展示用：顶部术语 + 足迹规模）。 */
export interface ProfileView {
    readonly id: string;
    readonly name: string;
    readonly domains: readonly string[];
    readonly bio: string;
    readonly corpusSize: number;
    readonly sources: {
        domain: number;
        reviews: number;
        comments: number;
    };
    /** TF-IDF 权重最高的术语（知识足迹的关键词云）。 */
    readonly topTerms: readonly {
        readonly term: string;
        readonly weight: number;
    }[];
}
/** 画像集合的报告视图。 */
export declare function profileViews(index: ProfileIndex): ProfileView[];
/** 单位候选专家的匹配结果。 */
export interface ExpertMatch {
    readonly id: string;
    readonly name: string;
    readonly domains: readonly string[];
    /** 问题向量与足迹向量的余弦相似度。 */
    readonly similarity: number;
    /** 问题术语在该足迹中的覆盖率（0-1）。 */
    readonly coverage: number;
    /** 命中的高权重术语（为什么是他）。 */
    readonly matchedTerms: readonly {
        readonly term: string;
        readonly weight: number;
    }[];
}
/** 路由报告。 */
export interface RoutingReport {
    readonly question: string;
    /** 路由是否可用（至少注册过一位专家）。 */
    readonly available: boolean;
    /** 按相似度降序的全部候选。 */
    readonly candidates: readonly ExpertMatch[];
    /** 推荐专家（无充分信号为 null）。 */
    readonly recommended: ExpertMatch | null;
    /** 裁决：confident / tentative / gap。 */
    readonly verdict: 'confident' | 'tentative' | 'gap';
    /** 裁决说明（中文，可展示）。 */
    readonly message: string;
    /** 知识盲区：全体足迹都未覆盖的问题术语。 */
    readonly uncoveredTerms: readonly string[];
}
/**
 * 专家路由：问题 → TF-IDF 向量 → 与各足迹余弦匹配。
 * 输出排序候选、推荐、覆盖率与知识盲区术语。
 */
export declare function routeQuestion(index: ProfileIndex, question: string): RoutingReport;
