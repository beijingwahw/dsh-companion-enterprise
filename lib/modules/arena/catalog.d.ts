/** 任务类型。 */
export type TaskType = 'code' | 'translation' | 'summarization' | 'reasoning' | 'general';
/** 模型目录条目。 */
export interface ArenaModelInfo {
    readonly id: string;
    readonly label: string;
    /** deepseek=官方 API；external=需另配 Key 的外部厂商。 */
    readonly provider: 'deepseek' | 'external';
    /** 外部厂商的 API 基址（provider=external 时）。 */
    readonly baseUrl?: string;
    /** 各任务类型的准确率先验（0-1，来自公开评测的经验值）。 */
    readonly accuracyPrior: Readonly<Record<TaskType, number>>;
    /** 典型延迟档位：fast / balanced / slow。 */
    readonly latencyTier: 'fast' | 'balanced' | 'slow';
    /** true=用户自定义模型（可删除，准确率先验取保守中值）。 */
    readonly custom?: boolean;
}
/** 用户自定义模型记录（落盘于 arena-custom-models 表）。 */
export interface CustomModelRecord {
    /** 模型 id（同时作为 API 调用的 model 参数）。 */
    readonly id: string;
    /** 展示名称。 */
    readonly label: string;
    /** OpenAI 兼容 API 基址（如 https://api.example.com/v1）。 */
    readonly baseUrl: string;
    readonly latencyTier: 'fast' | 'balanced' | 'slow';
    readonly createdAt: number;
}
/** 将自定义模型记录转换为目录条目。 */
export declare function customModelToInfo(record: CustomModelRecord): ArenaModelInfo;
/**
 * 竞技场允许直连的 API 域名白名单（与 manifest.json allowedOrigins 对齐）。
 * 覆盖全部国产与海外主流厂商的 OpenAI 兼容端点及常见中转/聚合网关；
 * 自定义模型与 Key 覆盖的 baseUrl 必须落在本白名单内。
 */
export declare const ARENA_ALLOWED_ORIGINS: readonly string[];
/** 校验 baseUrl 的 origin 是否在白名单内。 */
export declare function isAllowedArenaOrigin(baseUrl: string): boolean;
/**
 * 为给定模型 id 集合生成竞技场条目（最新模型自动导入的核心）：
 * 属于已知厂商且有 OpenAI 兼容端点、又未被精选目录覆盖的 id，
 * 自动生成条目。静态目录与实时定价表上新模型共用本函数。
 */
export declare function deriveModelsFromIds(modelIds: Iterable<string>, exclude: ReadonlySet<string>): ArenaModelInfo[];
/** 完整内置目录：精选模型 + 全国产派生模型。 */
export declare const ARENA_MODEL_CATALOG: readonly ArenaModelInfo[];
/** 推荐请求。 */
export interface RecommendRequest {
    readonly taskType: TaskType;
    /** 单次调用预算上限（元）；0=不限。 */
    readonly budgetPerCallCny: number;
    /** 延迟要求：fast=尽量快 / balanced=均衡 / any=不限。 */
    readonly latencyRequirement: 'fast' | 'balanced' | 'any';
}
/** 推荐结果条目。 */
export interface Recommendation {
    readonly model: ArenaModelInfo;
    readonly score: number;
    readonly reason: string;
}
/**
 * 模型推荐引擎（G3）：
 * 得分 = 准确率先验 × 0.6 + 延迟匹配 × 0.25 + 成本优势 × 0.15；
 * 全模型峰谷感知：成本估算经动态计价引擎按时段取价；推荐理由按模型
 * 是否公布峰谷分时价区分文案（peakPricingModels 传入有峰谷价的模型 id 集合）。
 * models 传入完整候选列表（内置目录 + 用户自定义模型）。
 */
export declare function recommendModels(models: readonly ArenaModelInfo[], request: RecommendRequest, costPerCall: Readonly<Record<string, number>>, now?: number, peakPricingModels?: ReadonlySet<string>): Recommendation[];
/** 任务类型中文标签。 */
export declare function taskTypeLabel(taskType: TaskType): string;
