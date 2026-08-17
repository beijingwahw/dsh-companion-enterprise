/**
 * 模块 E：执行轨迹分析器 —— 存储与统计。
 *
 * - TraceStore：外部摄入的轨迹持久化在 companion 域 'traces' 表；
 *   派生轨迹不重复落盘（可随时从会话日志重新派生）。
 * - TraceStatsStore：每次分析完成后按北京时间日聚合关键指标到
 *   'trace-stats-daily' 表，支撑 E4 趋势图与基准线对比。
 */
import type { Domain } from '../../core/storage-adapter.js';
import type { Trace, TraceStats } from './types.js';
/** 每日轨迹统计聚合。 */
export interface TraceDailyStats {
    readonly day: string;
    traceCount: number;
    totalDurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    /** 缓存命中数累计（命中率 = cacheHits / modelCalls）。 */
    cacheHits: number;
    modelCalls: number;
    toolCalls: number;
    toolSuccess: number;
    agentDispatches: number;
    anomalyCount: number;
}
/** 轨迹持久化仓库（'traces' 表：traceId → Trace）。 */
export declare class TraceStore {
    private readonly table;
    constructor(domain: Domain);
    list(): Trace[];
    get(id: string): Trace | undefined;
    put(trace: Trace): Promise<void>;
    delete(id: string): Promise<void>;
}
/** 轨迹指标日聚合仓库（'trace-stats-daily' 表）。 */
export declare class TraceStatsStore {
    private readonly table;
    /** 去重键（`${day}:${dedupeKey}`）：同一来源当日重复分析不重复计入趋势。 */
    private readonly recorded;
    constructor(domain: Domain);
    /** 并入一次轨迹分析的指标；提供 dedupeKey 时同一来源当日仅计入一次。 */
    record(ts: number, stats: TraceStats, anomalyCount: number, dedupeKey?: string): Promise<void>;
    /** 读取 [fromDay, toDay] 闭区间日聚合（升序）。 */
    range(fromDay: string, toDay: string): TraceDailyStats[];
    /** 历史平均指标（基准线）：全部日聚合的均值。 */
    baseline(): {
        avgDurationMs: number;
        avgTokens: number;
        avgAnomalies: number;
    } | undefined;
}
