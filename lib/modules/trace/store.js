import { round4 } from '../../core/pricing.js';
import { beijingDayKey } from '../../core/time.js';
/** 轨迹持久化仓库（'traces' 表：traceId → Trace）。 */
export class TraceStore {
    table;
    constructor(domain) {
        this.table = domain.table('traces');
    }
    list() {
        return this.table
            .entries()
            .map(([, value]) => value)
            .sort((a, b) => b.startedAt - a.startedAt);
    }
    get(id) {
        return this.table.get(id);
    }
    async put(trace) {
        await this.table.put(trace.id, trace);
    }
    async delete(id) {
        await this.table.delete(id);
    }
}
/** 轨迹指标日聚合仓库（'trace-stats-daily' 表）。 */
export class TraceStatsStore {
    table;
    /** 去重键（`${day}:${dedupeKey}`）：同一来源当日重复分析不重复计入趋势。 */
    recorded = new Set();
    constructor(domain) {
        this.table = domain.table('trace-stats-daily');
    }
    /** 并入一次轨迹分析的指标；提供 dedupeKey 时同一来源当日仅计入一次。 */
    async record(ts, stats, anomalyCount, dedupeKey) {
        const day = beijingDayKey(ts);
        if (dedupeKey !== undefined) {
            const key = `${day}:${dedupeKey}`;
            if (this.recorded.has(key))
                return;
            this.recorded.add(key);
        }
        await this.table.update(day, (prev) => {
            const base = prev ?? {
                day,
                traceCount: 0,
                totalDurationMs: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                cacheHits: 0,
                modelCalls: 0,
                toolCalls: 0,
                toolSuccess: 0,
                agentDispatches: 0,
                anomalyCount: 0,
            };
            return {
                day,
                traceCount: base.traceCount + 1,
                totalDurationMs: base.totalDurationMs + stats.totalDurationMs,
                totalInputTokens: base.totalInputTokens + stats.totalInputTokens,
                totalOutputTokens: base.totalOutputTokens + stats.totalOutputTokens,
                cacheHits: base.cacheHits + Math.round(stats.cacheHitRate * 100),
                modelCalls: base.modelCalls + 100,
                toolCalls: base.toolCalls + stats.nodeCount,
                toolSuccess: base.toolSuccess + Math.round(stats.toolSuccessRate * stats.nodeCount),
                agentDispatches: base.agentDispatches + stats.agentDispatches,
                anomalyCount: base.anomalyCount + anomalyCount,
            };
        });
    }
    /** 读取 [fromDay, toDay] 闭区间日聚合（升序）。 */
    range(fromDay, toDay) {
        return this.table
            .entries()
            .map(([, value]) => value)
            .filter((row) => row.day >= fromDay && row.day <= toDay)
            .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    }
    /** 历史平均指标（基准线）：全部日聚合的均值。 */
    baseline() {
        const rows = this.table.entries().map(([, value]) => value);
        if (rows.length === 0)
            return undefined;
        const traceCount = rows.reduce((sum, row) => sum + row.traceCount, 0);
        if (traceCount === 0)
            return undefined;
        return {
            avgDurationMs: rows.reduce((sum, row) => sum + row.totalDurationMs, 0) / traceCount,
            avgTokens: rows.reduce((sum, row) => sum + row.totalInputTokens + row.totalOutputTokens, 0) / traceCount,
            avgAnomalies: round4(rows.reduce((sum, row) => sum + row.anomalyCount, 0) / traceCount),
        };
    }
}
