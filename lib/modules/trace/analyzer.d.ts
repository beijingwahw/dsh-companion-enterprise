/**
 * 模块 E：执行轨迹分析器 —— 解析与分析引擎。
 *
 * - deriveTraceFromLog：从会话事件日志派生轨迹（tool/step/agent/model 事件）；
 * - ingestRawTrace：摄入 Harness 原生导出的轨迹 JSON（宽松形状，逐项收窄）；
 * - detectAnomalies：异常模式识别（重试循环/Token 爆炸/缓存未命中/死循环）；
 * - diffTraces：按节点名对齐两条轨迹并输出差异；
 * - computeStats：汇总指标。
 */
import type { SessionLogSnapshot } from '../../types/harness.js';
import type { Trace, TraceAnomaly, TraceDiffEntry, TraceNode, TraceStats } from './types.js';
/** 从会话事件日志派生轨迹。 */
export declare function deriveTraceFromLog(snapshot: SessionLogSnapshot): Trace;
/**
 * 摄入 Harness 原生导出的轨迹 JSON（宽松形状）。
 * 接受 { steps: [...] } 或裸数组；每项至少需要 name，其余字段缺省安全值。
 */
export declare function ingestRawTrace(raw: unknown, traceId: string): Trace;
/** 异常检测阈值。 */
export interface AnomalyThresholds {
    /** 单步骤输出 Token 超过该值视为 Token 爆炸。 */
    readonly tokenExplosion: number;
    /** 同一工具连续失败达到该次数视为重试循环。 */
    readonly retryLoopAttempts: number;
    /** 相似操作重复达到该次数视为死循环。 */
    readonly infiniteLoopRepeats: number;
}
export declare const DEFAULT_ANOMALY_THRESHOLDS: AnomalyThresholds;
/** 异常自动标注（E2）。 */
export declare function detectAnomalies(trace: Trace, thresholds?: AnomalyThresholds): TraceAnomaly[];
/** 轨迹对比（E3）：按节点名对齐，输出差异条目。 */
export declare function diffTraces(oldTrace: Trace, newTrace: Trace): TraceDiffEntry[];
/** 汇总指标（E4）。单次遍历聚合全部指标。 */
export declare function computeStats(trace: Trace): TraceStats;
/** 按耗时降序取前 N（定位最慢步骤）。 */
export declare function slowestNodes(trace: Trace, limit?: number): TraceNode[];
/** 按 Token 消耗降序取前 N（定位最贵步骤）。 */
export declare function costliestNodes(trace: Trace, limit?: number): TraceNode[];
