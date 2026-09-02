/**
 * 模块 I：协作与知识管理（Team & Knowledge）—— 数据模型。
 *
 * I1 团队配置同步：TeamConfigSnapshot（导出 JSON 文档，经 Git 仓库共享）+
 *    ConfigDiffEntry/SectionReport（本地优先 / 远程优先 / 手动合并三种策略）；
 * I2 执行经验库：ExperienceCard（任务完成后自动提取的执行卡片，
 *    含问题与解决方案的人工补充笔记）；
 * I3 Prompt 协作评审：ReviewRequest/ReviewComment/ReviewDecision
 *    （类 Code Review 流程：提交 → 评论批注 → 审核 → 合并主版本，全程可追溯）。
 */
/** 配置合并策略：local=本地优先；remote=远程优先；manual=手动合并。 */
export type MergeStrategy = 'local' | 'remote' | 'manual';
/** 团队偏好（每人一份，落 'team-prefs' 表）。 */
export interface TeamPreferences {
    /** 成员署名（评审作者/评论者标识）。 */
    readonly memberName: string;
    /** 导入时的缺省合并策略。 */
    readonly defaultStrategy: MergeStrategy;
}
/** 快照可携带的配置分区名。 */
export type ConfigSection = 'costSettings' | 'pricingOverrides' | 'handoffTemplates' | 'promptTemplates' | 'pipelines' | 'scheduledJobs' | 'dlpRules';
/** 交接摘要模板条目（快照内形状，与 'templates' 表记录对应）。 */
export interface SharedHandoffTemplate {
    readonly name: string;
    readonly content: string;
}
/** Prompt 模板条目（快照内形状，仅用户模板；与 'prompt-templates' 表记录对应）。 */
export interface SharedPromptTemplate {
    readonly name: string;
    readonly category: string;
    readonly content: string;
}
/** 流水线记录（快照内形状，与编排模块 'pipelines' 表存储形状结构兼容）。 */
export interface SharedPipelineRecord {
    readonly id: string;
    readonly name: string;
    readonly steps: readonly unknown[];
    readonly createdAt: number;
    readonly updatedAt: number;
}
/** 定时任务记录（快照内形状，与编排模块 'scheduled-jobs' 表存储形状结构兼容）。 */
export interface SharedJobRecord {
    readonly id: string;
    readonly name: string;
    readonly cron: string;
    readonly scheduleText: string;
    readonly prompt: string;
    readonly model: string;
    readonly offPeakOnly: boolean;
    readonly enabled: boolean;
    readonly createdAt: number;
    readonly lastRunAt: number;
    readonly nextRunAt: number;
}
/** 自定义 DLP 规则条目（快照内形状，与安全模块 'dlp-rules' 表记录对应）。 */
export interface SharedDlpRule {
    readonly id: string;
    readonly name: string;
    readonly pattern: string;
    readonly enabled: boolean;
}
/**
 * 团队配置快照（I1 导出 JSON 文档）：提交到团队 Git 仓库共享，
 * 成员 pull 后经导入端点按合并策略同步到本地。
 */
export interface TeamConfigSnapshot {
    /** 文档类型标识（导入校验用）。 */
    readonly kind: 'dsh-companion-team-config';
    /** 文档版本号。 */
    readonly version: number;
    readonly exportedAt: number;
    readonly exportedBy: string;
    readonly sections: {
        /** 成本模块设置（模型路由规则、预算等；仅成本模块启用时可写入）。 */
        readonly costSettings?: Readonly<Record<string, unknown>>;
        /** 用户自定义单价覆盖（模型 id → 单价）。 */
        readonly pricingOverrides?: Readonly<Record<string, unknown>>;
        readonly handoffTemplates?: readonly SharedHandoffTemplate[];
        readonly promptTemplates?: readonly SharedPromptTemplate[];
        readonly pipelines?: readonly SharedPipelineRecord[];
        readonly scheduledJobs?: readonly SharedJobRecord[];
        readonly dlpRules?: readonly SharedDlpRule[];
    };
}
/** 单条配置差异（手动合并的决策单元）。 */
export interface ConfigDiffEntry {
    readonly section: ConfigSection;
    /** 条目身份键（模板名 / 流水线 id / 模型 id；costSettings 为 '(settings)'）。 */
    readonly key: string;
    /** add=仅远程存在；update=两侧不同；same=两侧一致；local-only=仅本地存在。 */
    readonly action: 'add' | 'update' | 'same' | 'local-only';
    readonly local?: unknown;
    readonly remote?: unknown;
}
/** 单个分区的导入结果汇报。 */
export interface SectionReport {
    readonly section: ConfigSection;
    readonly added: number;
    readonly updated: number;
    readonly same: number;
    readonly skipped: number;
    /** 跳过/失败原因（如成本模块未启用）。 */
    readonly message?: string;
}
/** 执行卡片来源（'session' = 经验自动蒸馏晋升）。 */
export type ExperienceSource = 'pipeline' | 'queue' | 'cron' | 'manual' | 'session';
/** 问题与解决方案笔记（用户手动补充）。 */
export interface ExperienceNote {
    readonly problem: string;
    readonly solution: string;
    readonly ts: number;
}
/** 执行卡片（I2 核心实体）。 */
export interface ExperienceCard {
    readonly id: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly source: ExperienceSource;
    /** 来源对象 id（流水线/任务/定时任务 id；manual 为空）。 */
    readonly sourceId: string;
    /** 来源执行 id（去重依据）。 */
    readonly runId: string;
    /** 任务描述。 */
    readonly title: string;
    /** 使用的模型（多模型时逗号分隔）。 */
    readonly model: string;
    /** Prompt 摘要（截断脱敏后的前段）。 */
    readonly promptSummary: string;
    readonly durationMs: number;
    readonly tokens: number;
    readonly ok: boolean;
    readonly error: string;
    readonly tags: readonly string[];
    readonly notes: readonly ExperienceNote[];
}
/** 评审状态：open=待审核；approved=已通过（待合并）；rejected=已拒绝；merged=已合并主版本。 */
export type ReviewStatus = 'open' | 'approved' | 'rejected' | 'merged';
/** Prompt 变更评审请求。 */
export interface ReviewRequest {
    readonly id: string;
    readonly title: string;
    /** 基线内容（当前主版本）。 */
    readonly baseContent: string;
    /** 提议内容（变更后的 Prompt）。 */
    readonly proposedContent: string;
    readonly author: string;
    readonly note: string;
    status: ReviewStatus;
    readonly createdAt: number;
    updatedAt: number;
    /** 合并后生成的 Prompt 主版本号（status='merged' 时有值）。 */
    mergedVersion: number;
}
/** 评论批注锚点：side 指定基线/提议侧，line 为行号（0=整体评论）。 */
export interface ReviewAnchor {
    readonly side: 'base' | 'proposed';
    readonly line: number;
}
/** 评审评论（批注）。 */
export interface ReviewComment {
    readonly id: string;
    readonly reviewId: string;
    readonly author: string;
    readonly content: string;
    readonly anchor: ReviewAnchor;
    readonly createdAt: number;
}
/** 审核决定（approve/reject）。 */
export interface ReviewDecision {
    readonly reviewId: string;
    readonly reviewer: string;
    readonly verdict: 'approve' | 'reject';
    readonly comment: string;
    readonly ts: number;
}
