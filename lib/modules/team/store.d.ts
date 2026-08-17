/**
 * 模块 I：协作与知识管理 —— 存储。
 *
 * 全部落在 companion 域：
 * - 'team-prefs'：成员署名与缺省合并策略（I1）；
 * - 'team-snapshots'：最近导入的配置快照归档（I1，滚动保留上限）；
 * - 'experience-cards'：执行卡片（I2；关键词/标签/模型检索与相似推荐）；
 * - 'review-requests' / 'review-comments' / 'review-decisions'：
 *   Prompt 评审请求、评论批注与审核决定（I3，变更记录完整可追溯）。
 */
import type { Domain } from '../../core/storage-adapter.js';
import type { ExperienceCard, ReviewComment, ReviewDecision, ReviewRequest, TeamConfigSnapshot, TeamPreferences } from './types.js';
/** 最近导入快照归档上限（条）。 */
export declare const SNAPSHOT_ARCHIVE_LIMIT = 10;
/** 执行卡片上限（条；超出滚动删除最旧）。 */
export declare const EXPERIENCE_CARD_LIMIT = 500;
/** 缺省团队偏好。 */
export declare const DEFAULT_TEAM_PREFS: TeamPreferences;
/** 生成模块内唯一 id。 */
export declare function teamId(prefix: string): string;
/** 团队偏好仓库（I1）。 */
export declare class TeamPrefsStore {
    private readonly table;
    constructor(domain: Domain);
    /** 读取偏好（缺省值兜底）。 */
    get(): TeamPreferences;
    put(prefs: TeamPreferences): Promise<void>;
}
/** 配置快照归档仓库（I1：最近导入记录）。 */
export declare class SnapshotArchiveStore {
    private readonly table;
    constructor(domain: Domain);
    /** 全部归档（新→旧）。 */
    list(): TeamConfigSnapshot[];
    get(key: string): TeamConfigSnapshot | undefined;
    /** 归档一份快照（键含时间戳，超出上限时删除最旧）。 */
    put(snapshot: TeamConfigSnapshot): Promise<string>;
}
/** 执行卡片仓库（I2）。 */
export declare class ExperienceCardStore {
    private readonly table;
    constructor(domain: Domain);
    /** 全部卡片（新→旧）。 */
    list(): ExperienceCard[];
    get(id: string): ExperienceCard | undefined;
    /** 按来源执行 id 查找（自动提取去重用）。 */
    byRunId(runId: string): ExperienceCard | undefined;
    put(card: ExperienceCard): Promise<void>;
    delete(id: string): Promise<void>;
    /** 滚动清理：仅保留最新 EXPERIENCE_CARD_LIMIT 张。 */
    private trim;
    /**
     * 检索：关键词（标题/Prompt 摘要/笔记/错误全文）、标签（任一命中）、
     * 模型（精确匹配）三条件 AND；缺省条件不参与过滤。
     */
    search(options: {
        query?: string;
        tags?: readonly string[];
        model?: string;
        limit?: number;
    }): ExperienceCard[];
    /**
     * 相似推荐：对输入文本分词后与卡片文本求交集得分，
     * 得分 > 0 的卡片按得分（再按创建时间）降序返回。
     */
    recommend(text: string, limit?: number): Array<{
        card: ExperienceCard;
        score: number;
    }>;
}
/** 评审请求仓库（I3）。 */
export declare class ReviewRequestStore {
    private readonly table;
    constructor(domain: Domain);
    /** 全部请求（新→旧）。 */
    list(): ReviewRequest[];
    get(id: string): ReviewRequest | undefined;
    put(request: ReviewRequest): Promise<void>;
    delete(id: string): Promise<void>;
}
/** 评审评论仓库（I3）。 */
export declare class ReviewCommentStore {
    private readonly table;
    constructor(domain: Domain);
    /** 某评审的全部评论（旧→新）。 */
    forReview(reviewId: string): ReviewComment[];
    get(id: string): ReviewComment | undefined;
    put(comment: ReviewComment): Promise<void>;
    delete(id: string): Promise<void>;
}
/** 审核决定仓库（I3）。 */
export declare class ReviewDecisionStore {
    private readonly table;
    constructor(domain: Domain);
    /** 某评审的全部决定（旧→新）。 */
    forReview(reviewId: string): ReviewDecision[];
    put(decision: ReviewDecision): Promise<void>;
}
/**
 * 分词：ASCII 词按非字母数字切分（小写化），
 * CJK 连续段按二元组切分（适配中文无空格场景）；
 * 过滤停用词与单字符 ASCII 词。
 */
export declare function tokenize(text: string): string[];
