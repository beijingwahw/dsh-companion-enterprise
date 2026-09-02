/**
 * 模块 H 创新扩展：DAG 规划器与关键路径分析（Critical Path Method）。
 *
 * 流水线的 dependsOn 只是一份依赖清单——「哪些步骤能并行」「总工期
 * 由谁决定」「延迟哪个步骤会整体延期」都藏在图结构里。规划器把
 * 工程项目管理的 CPM（关键路径法）引入 LLM 流水线：
 *
 * 1. 图校验：Kahn 拓扑排序检出循环依赖，逐项核对悬空依赖
 *    （指向不存在的步骤）——配置错误在执行前暴露；
 * 2. 拓扑分层：level(v) = max(level(上游)) + 1——同层步骤无依赖，
 *    是天然的并行批（parallel wave），最大层宽即理论并行度上限；
 * 3. 工期估算：每步取历史运行延迟均值（无历史时按超时一半保守估计），
 *    CPM 正向推最早开始、逆向推最晚开始，浮动时间为零的节点链
 *    即关键路径——它决定流水线总工期，其余步骤晚点做完也无妨；
 * 4. 可行动建议：识别关键路径瓶颈（「优化 X 或给它降级模型收益最大」）、
 *    指出被串行浪费的可并行层、标记单点依赖（下游全等它）。
 */
import type { Pipeline, PipelineRun } from './types.js';
/** 单步 DAG 节点。 */
export interface DagNode {
    readonly stepId: string;
    readonly name: string;
    /** 拓扑层（0 起）：同层步骤互不依赖，可并行执行。 */
    readonly level: number;
    /** 上游依赖。 */
    readonly dependsOn: readonly string[];
    /** 下游依赖本步骤的步骤。 */
    readonly dependents: readonly string[];
    /** 估算耗时（毫秒，历史均值或保守估计）。 */
    readonly estimatedMs: number;
    /** 估算依据：'history'（有历史均值）| 'timeout'（超时一半）| 'default'。 */
    readonly estimateBasis: 'history' | 'timeout' | 'default';
    /** CPM 最早开始时间（相对流水线起点，毫秒）。 */
    readonly earliestStartMs: number;
    /** CPM 最晚开始时间（不推迟总工期，毫秒）。 */
    readonly latestStartMs: number;
    /** 总浮动时间（毫秒）。 */
    readonly slackMs: number;
    /** 是否在关键路径上。 */
    readonly critical: boolean;
}
/** DAG 规划报告。 */
export interface DagPlan {
    readonly pipelineId: string;
    readonly pipelineName: string;
    /** 图是否合法（无环、无悬空依赖）。 */
    readonly valid: boolean;
    /** 校验错误（中文，供直接展示）。 */
    readonly errors: readonly string[];
    /** 全部节点（拓扑序）。 */
    readonly nodes: readonly DagNode[];
    /** 拓扑分层（每层内步骤可并行）。 */
    readonly levels: ReadonlyArray<readonly string[]>;
    /** 理论最大并行度（最宽层）。 */
    readonly maxParallelism: number;
    /** 关键路径（步骤 id 序列，起点→终点）。 */
    readonly criticalPath: readonly string[];
    /** 理论最短总工期（毫秒）。 */
    readonly totalDurationMs: number;
    /** 优化建议（中文，可行动）。 */
    readonly suggestions: readonly string[];
}
/** 构建某流水线的 DAG 规划（含校验、分层、CPM 与建议）。 */
export declare function planDag(pipeline: Pipeline, runs: readonly PipelineRun[]): DagPlan;
