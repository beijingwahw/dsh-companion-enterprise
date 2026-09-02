/**
 * 模块 F5：Prompt 自动优化（元提示变异 + 配对显著性检验）。
 *
 * 传统 A/B 测试依赖人工构思变体、人工判断优劣；自动优化把整个循环
 * 交给机器：基线评测 → 元提示生成候选变体（聚焦失败用例）→ 全候选
 * 评测 → 与基线做配对符号检验（exact binomial / McNemar 精确法）→
 * 仅当统计显著更优时才晋升为新版本。
 *
 * 世界性意义：把「Prompt 是手工艺」变成「Prompt 是可优化的工程对象」——
 * 显著性门槛杜绝了小样本下的过拟合晋升（连赢两次就宣布胜利），
 * 配对设计消除了用例难度差异带来的方差。
 *
 * 判定方式：用例带 expected → 输出包含参考答案即通过（零成本）；
 * 否则用模型评审员（jsonMode 严格 JSON 裁决）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { PromptVersion, PromptVersionStore } from './store.js';
/** 单条优化用例。 */
export interface OptimizeCase {
    /** 用例输入（拼接到 Prompt 之后）。 */
    readonly input: string;
    /** 参考答案：输出包含该串即通过；缺省走模型评审员。 */
    readonly expected?: string;
}
/** 优化请求参数（HTTP 入口已收窄）。 */
export interface OptimizeParams {
    readonly prompt: string;
    readonly cases: readonly OptimizeCase[];
    readonly model: string;
    /** 候选变体数（1~MAX_CANDIDATES）。 */
    readonly candidates: number;
    /** 显著更优时是否自动保存为新版本。 */
    readonly save: boolean;
}
/** 候选评测结果。 */
export interface CandidateEval {
    readonly content: string;
    /** 每条用例是否通过（与 cases 同序）。 */
    readonly passes: readonly boolean[];
    readonly passRate: number;
    /** 相对基线：基线失败而本候选通过的用例数。 */
    readonly wins: number;
    /** 相对基线：基线通过而本候选失败的用例数。 */
    readonly losses: number;
}
/** 优化结果。 */
export interface OptimizeResult {
    readonly model: string;
    readonly baseline: {
        readonly passRate: number;
        readonly passes: readonly boolean[];
        /** 失败用例序号（元提示的改进线索）。 */
        readonly failures: readonly number[];
    };
    readonly candidates: readonly CandidateEval[];
    /** 胜出候选下标（无显著胜者时缺省）。 */
    readonly winnerIndex?: number;
    /** 配对符号检验详情。 */
    readonly significance?: {
        /** 基线败 & 候选胜。 */
        readonly b: number;
        /** 基线胜 & 候选败。 */
        readonly c: number;
        /** 双侧精确二项 p 值。 */
        readonly pValue: number;
        readonly significant: boolean;
    };
    /** 晋升保存的新版本（save=false 或不显著时缺省）。 */
    readonly savedVersion?: PromptVersion;
}
/** 优化用例数上限。 */
export declare const MAX_OPTIMIZE_CASES = 10;
/** 候选变体数上限。 */
export declare const MAX_CANDIDATES = 3;
/**
 * 配对符号检验（McNemar 精确法）：
 * b = 基线败 & 候选胜，c = 基线胜 & 候选败，n = b + c（一致对不提供信息）。
 * 双侧精确二项 p 值 = 2·P(X ≤ min(b,c))，X ~ Binomial(n, 0.5)，封顶 1。
 */
export declare function pairedSignTest(b: number, c: number): {
    pValue: number;
};
/**
 * 执行完整优化循环（元提示生成 → 全候选评测 → 显著性检验 → 晋升保存）。
 * 任何模型调用失败都收敛为「该用例不通过」，不中断整个循环。
 */
export declare function optimizePrompt(ctx: Context, versions: PromptVersionStore, params: OptimizeParams): Promise<OptimizeResult>;
