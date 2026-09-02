/**
 * 模块 J6：攻击者画像与渐进防御（Adaptive Threat Sentinel）。
 *
 * 一次性检测（injection.ts）只看当前这条输入——攻击者完全可以
 * 「试探性慢攻」：每次只投递低风险载荷（单次 suspicious），永远
 * 摸不到严格模式的 malicious 拦截线。入侵检测系统（IDS）的经典
 * 应对是「会话画像」：把离散事件聚合为行为轨迹。
 *
 * 哨兵机制：
 * - 每个攻击源（调用方 source / 扫描会话）维护一个画像；
 * - 风险分指数衰减累积（半衰期 24h）：连续投递会快速堆分，
 *   隔几天再来一次旧账已翻篇——攻击频率本身成为信号；
 * - 三级防御：normal（<40 常规告警）→ watch（40~70 高危告警，
 *   suspicious 也拦截）→ quarantined（≥70 全链路强制拦截 +
 *   非清洁输入一票否决）；
 * - 事件滚动保留最近 20 条，画像可通过 reset 平反（误报可回滚）。
 */
import type { Domain } from '../../core/storage-adapter.js';
/** 风险分半衰期（毫秒，24 小时）。 */
export declare const RISK_HALF_LIFE_MS: number;
/** 画像滚动保留的最近事件数。 */
export declare const EVENT_LIMIT = 20;
/** watch 阈值。 */
export declare const WATCH_THRESHOLD = 40;
/** quarantined 阈值。 */
export declare const QUARANTINE_THRESHOLD = 70;
/** 画像等级。 */
export type SentinelLevel = 'normal' | 'watch' | 'quarantined';
/** 单次攻击事件记录。 */
export interface SentinelEvent {
    readonly ts: number;
    /** 当时注入判定的风险分。 */
    readonly risk: number;
    /** 判定档位。 */
    readonly verdict: 'suspicious' | 'malicious';
    /** 命中类别（如「指令覆写×2、角色越狱」）。 */
    readonly categories: string;
}
/** 攻击源画像。 */
export interface ThreatProfile {
    /** 攻击源标识（调用 source / 会话 id）。 */
    readonly source: string;
    /** 衰减后的当前风险分（0~∞，展示时封顶 100）。 */
    score: number;
    /** 首次记录时间。 */
    readonly firstSeenAt: number;
    /** 最近记录时间。 */
    lastSeenAt: number;
    /** 累计事件数（含已滚动淘汰的）。 */
    totalEvents: number;
    /** 恶意判定（malicious）累计次数。 */
    maliciousCount: number;
    /** 最近事件（新→旧，≤ EVENT_LIMIT 条）。 */
    events: SentinelEvent[];
}
/** 画像报表条目（含实时等级与衰减分）。 */
export interface ThreatProfileReport extends ThreatProfile {
    readonly level: SentinelLevel;
    /** 展示分（0~100 封顶）。 */
    readonly displayScore: number;
    /** 距离下一次自然衰减到下一等级的小时数（已隔离时为 null）。 */
    readonly hoursToDowngrade: number | null;
}
/** 由当前分值判定等级。 */
export declare function levelOf(score: number): SentinelLevel;
/**
 * 哨兵画像仓库（sentinel-profiles 表，key = source）。
 */
export declare class SentinelStore {
    private readonly table;
    constructor(domain: Domain);
    /** 记录一次注入命中事件（指数衰减累积 + 滚动事件）。 */
    record(source: string, event: SentinelEvent): Promise<ThreatProfileReport>;
    /** 读取画像（含实时衰减后的等级）。 */
    get(source: string): ThreatProfileReport | undefined;
    /** 全部画像（新→旧）。 */
    list(): ThreatProfileReport[];
    /** 重置指定画像或全部画像（误报平反）。 */
    reset(source?: string): Promise<void>;
    /** 画像 → 报表（等级 + 展示分 + 降级倒计时）。 */
    private toReport;
}
/**
 * 哨兵防御决策：给定画像等级与本次扫描判定，决定是否强制拦截。
 *
 * 规则（在 injection 设置的严格模式之外叠加）：
 * - quarantined：任何非 clean 输入一票否决（403）；
 * - watch：suspicious 及以上拦截；
 * - normal：维持既有策略（仅严格模式 malicious 拦截）。
 */
export declare function sentinelShouldBlock(level: SentinelLevel, verdict: 'clean' | 'suspicious' | 'malicious'): boolean;
