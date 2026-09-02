/**
 * 模块 E 创新扩展：失败前兆挖掘（Failure Precursor Mining）。
 *
 * 异常检测（analyzer.ts）在失败「发生时」标注；SPC（spc.ts）在指标
 * 「漂移后」告警——两者都是事后。前兆挖掘回答的是事前问题：
 * 「这条正在执行的轨迹，是否正走在一条已知的失败之路上？」
 *
 * 方法论（序列模式挖掘，APM 故障预测的经典范式）：
 * 1. 事件编码：轨迹节点序列 → 符号序列（`tool:write:error` 等），
 *    剥离具体参数只留「行为签名」，使跨轨迹的模式可比较；
 * 2. n-gram 统计：在失败轨迹与成功轨迹两个语料上分别统计
 *    2~4 阶 n-gram 频次；
 * 3. 提升度筛选：lift = P(n-gram | 失败) / P(n-gram | 成功)——
 *    只在失败轨迹中高频、成功轨迹中罕见的序列才是有效前兆，
 *    而非普遍执行的常规动作（如「读文件→写文件」）；
 * 4. 实时预警：进行中轨迹的尾部 n-gram 与前兆库匹配，
 *    给出风险分与「再走几步可能踩坑」的提前量。
 *
 * 纯函数模块：数据来自既有 TraceStore（派生 + 摄入轨迹）。
 */
import type { Trace, TraceNode } from './types.js';
/** 单条失败前兆模式。 */
export interface PrecursorPattern {
    /** 事件签名序列（如 ['tool:read:ok', 'model:chat:retry']）。 */
    readonly signature: readonly string[];
    /** P(模式 | 失败轨迹)。 */
    readonly failSupport: number;
    /** P(模式 | 成功轨迹)。 */
    readonly okSupport: number;
    /** 提升度 = failSupport / max(okSupport, ε)。 */
    readonly lift: number;
    /** 该模式之后最常见的下一步失败事件（预警提示用）。 */
    readonly typicalNext: string | null;
}
/** 挖掘报告。 */
export interface PrecursorReport {
    /** 参与挖掘的轨迹总数（成功/失败）。 */
    readonly traces: {
        readonly ok: number;
        readonly failed: number;
    };
    /** 失败轨迹占比。 */
    readonly failureRate: number;
    /** 前兆库（按 lift 降序，≤ TOP_PRECURSORS 条）。 */
    readonly patterns: readonly PrecursorPattern[];
}
/** 实时预警结果。 */
export interface PrecursorAlert {
    /** 命中的前兆模式（当前轨迹尾部是其后缀或完整出现）。 */
    readonly pattern: PrecursorPattern;
    /** 已匹配到的前缀长度（1=刚开始匹配）。 */
    readonly matchedLength: number;
    /** 模式总长。 */
    readonly patternLength: number;
    /** 风险分 0~100：越接近模式终点、提升度越高分越高。 */
    readonly risk: number;
    /** 预测的下一步事件。 */
    readonly predictedNext: string | null;
}
/** 对进行中轨迹的预警结果。 */
export interface LiveCheckResult {
    /** 当前轨迹的事件签名序列。 */
    readonly signature: readonly string[];
    /** 命中的预警（按风险降序）。 */
    readonly alerts: readonly PrecursorAlert[];
    /** 综合风险分（各预警取衰减最大值）。 */
    readonly risk: number;
    /** 综合建议。 */
    readonly advice: string;
}
/** 节点 → 事件签名（`kind:name:status`；剥参数留行为指纹）。 */
export declare function nodeSignature(node: TraceNode): string;
/** 轨迹失败判定：存在 error 节点，或尾节点为 error/retry。 */
export declare function isFailedTrace(trace: Trace): boolean;
/**
 * 挖掘失败前兆库。
 * @param traces 历史轨迹集合（派生 + 摄入均可）。
 */
export declare function minePrecursors(traces: readonly Trace[]): PrecursorReport;
/**
 * 对一条（进行中的）轨迹做前兆预警。
 * @param patternLibrary 前兆库（来自 minePrecursors）。
 * @param nodes 进行中轨迹的已发生节点。
 */
export declare function checkPrecursors(patternLibrary: readonly PrecursorPattern[], nodes: readonly TraceNode[]): LiveCheckResult;
