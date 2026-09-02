import type { Pipeline, PipelineRun } from './types.js';
/** 默认模拟迭代次数。 */
export declare const DEFAULT_ITERATIONS = 2000;
/** 单步三点估算。 */
export interface MonteStepEstimate {
    readonly stepId: string;
    readonly name: string;
    /** 历史样本数（该步在全部运行中的成功延迟记录数）。 */
    readonly sampleCount: number;
    readonly optimisticMs: number;
    readonly mostLikelyMs: number;
    readonly pessimisticMs: number;
    /** PERT 均值 (a+4m+b)/6。 */
    readonly pertMeanMs: number;
    /** PERT 标准差 (b−a)/6。 */
    readonly pertSdMs: number;
    /** true = 无历史样本（先验估计，建议先跑几轮校准）。 */
    readonly estimated: boolean;
    /** 关键性指数：出现在模拟关键路径上的频率（0-1）。 */
    readonly criticality: number;
}
/** 总工期分布摘要。 */
export interface MonteTotal {
    readonly p50Ms: number;
    readonly p80Ms: number;
    readonly p90Ms: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
    readonly meanMs: number;
    readonly sdMs: number;
    readonly minMs: number;
    readonly maxMs: number;
}
/** 蒙特卡洛模拟报告。 */
export interface MonteReport {
    readonly pipelineId: string;
    readonly pipelineName: string;
    /** 依赖图是否合法（复用 DAG 规划器校验）。 */
    readonly valid: boolean;
    readonly errors: readonly string[];
    readonly iterations: number;
    /** 并行度上限（null = 无界并行）。 */
    readonly parallelism: number | null;
    readonly steps: readonly MonteStepEstimate[];
    readonly total: MonteTotal | null;
    /** 关键性最高的步骤 id（瓶颈）。 */
    readonly bottleneckStepId: string | null;
    readonly bottleneckCriticality: number;
    readonly advice: string;
}
/** 模拟选项。 */
export interface SimulateOptions {
    /** 迭代次数（缺省 2000，钳制 [200, 20000]）。 */
    readonly iterations?: number;
    /** 并行度上限（缺省 null = 无界并行；>0 时按 k 工人排队仿真）。 */
    readonly parallelism?: number | null;
}
/**
 * 蒙特卡洛工期模拟（纯函数）。
 * @param pipeline 目标流水线。
 * @param runs 该流水线的历史运行（含每步延迟）。
 * @param options 迭代次数与并行度。
 */
export declare function simulatePipeline(pipeline: Pipeline, runs: readonly PipelineRun[], options?: SimulateOptions): MonteReport;
