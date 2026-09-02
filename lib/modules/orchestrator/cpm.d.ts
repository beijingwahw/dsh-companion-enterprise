/**
 * 模块 H 创新扩展：关键路径法与资源争用分析（Critical Path Method, CPM）。
 *
 * DAG 规划回答「依赖是否合法、能分几层」；蒙特卡洛回答「工期的不确定
 * 分布」。但项目经理的三个经典追问需要 1959 年 Kelley & Walker 为
 * DuPont 发明的关键路径法（现代项目管理的方法论起点，PMI 体系的
 * 基石）来回答：
 * 1. 总工期由哪条依赖链决定？——关键路径：松弛（slack）为 0 的步骤
 *    链，链上任何一步延误一毫秒，交付就延误一毫秒；
 * 2. 哪些步骤有富余？——slack = 最晚开始 − 最早开始：非关键步骤的
 *    可推迟余量，是资源腾挪的安全空间；
 * 3. 并行能省多少？——Σ 单步工期 − 关键路径长度 = 并行化收益
 *    （理想无界并行下）；同时用 [ES, EF] 窗口扫描并发峰值，
 *    提示「省下的时间要用并发度换」的资源争用代价。
 *
 * 步骤工期取历史成功运行的中位延迟（PERT 点估计的稳健替代）；
 * 无样本时退化为超时窗/全局先验并标注 estimated。
 * 纯函数模块：输入流水线与历史运行，输出完整 CPM 报告。
 */
import type { Pipeline, PipelineRun } from './types.js';
/** 单步 CPM 分析。 */
export interface CpmStep {
    readonly stepId: string;
    readonly name: string;
    /** 采用的工期（毫秒，历史中位/先验）。 */
    readonly durationMs: number;
    /** 工期来源是否为先验估计（无历史样本）。 */
    readonly estimated: boolean;
    /** 历史样本数。 */
    readonly sampleCount: number;
    /** 最早开始/最早结束（毫秒，相对流水线起点）。 */
    readonly esMs: number;
    readonly efMs: number;
    /** 最晚开始/最晚结束（不延误总工期的前提下）。 */
    readonly lsMs: number;
    readonly lfMs: number;
    /** 松弛 = LS − ES（0 = 关键步骤）。 */
    readonly slackMs: number;
    /** 是否在关键路径上。 */
    readonly critical: boolean;
    readonly dependsOn: readonly string[];
}
/** 并发峰值画像。 */
export interface ConcurrencyProfile {
    /** 全程并发执行步数的峰值（理想无界并行）。 */
    readonly peak: number;
    /** 峰值出现的时刻（毫秒，相对起点）。 */
    readonly peakAtMs: number;
    /** 峰值时刻同时在跑的步骤 id。 */
    readonly peakSteps: readonly string[];
    /** 并行化收益 = Σ 工期 − 总工期（毫秒）。 */
    readonly parallelismSavedMs: number;
}
/** CPM 报告。 */
export interface CpmReport {
    readonly pipelineId: string;
    readonly pipelineName: string;
    readonly valid: boolean;
    readonly errors: readonly string[];
    /** 关键路径步骤 id（起点 → 终点）。 */
    readonly criticalPath: readonly string[];
    /** 关键路径总长（= 总工期，毫秒）。 */
    readonly makespanMs: number;
    readonly steps: readonly CpmStep[];
    readonly concurrency: ConcurrencyProfile | null;
    /** 瓶颈步骤（关键路径上工期最长的步骤）。 */
    readonly bottleneckStepId: string | null;
    readonly advice: string;
}
/** 选项。 */
export interface CpmOptions {
    /** 覆盖单步工期（stepId → ms；优先于历史）。 */
    readonly durationOverrides?: Readonly<Record<string, number>>;
}
/**
 * 关键路径法分析（纯函数）。
 * 前向传播求 ES/EF，回向传播求 LS/LF，松弛 0 的链即关键路径。
 * 依赖图非法（环/悬空依赖）时返回 valid=false 与错误清单。
 */
export declare function analyzeCriticalPath(pipeline: Pipeline, runs: readonly PipelineRun[], options?: CpmOptions): CpmReport;
