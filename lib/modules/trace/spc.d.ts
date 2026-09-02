/**
 * 模块 E 创新扩展：SPC 统计过程控制（EWMA 控制图 + 漂移检测）。
 *
 * 传统"基准线对比"只回答"当前值偏离历史均值多少"，对两类劣化天然迟钝：
 * 1. 缓慢漂移：每天恶化 1%，连续一个月后翻倍，但任一天的值都"仍在历史范围内"；
 * 2. 波动放大：均值没变但过程失控（忽快忽慢），单点比较完全看不到。
 *
 * SPC（统计过程控制）把执行轨迹的质量指标当作工业生产过程来监控，是
 * 制造业六西格玛验证过百年的方法论，这里移植到 Agent 执行质量上：
 *
 * - EWMA 控制图：z_t = λ·x_t + (1-λ)·z_{t-1}，指数加权对近期样本更敏感，
 *   能在指标尚未越出历史范围时就发现过程均值已经偏移（小漂移灵敏度高，
 *   λ=0.3 时对 1σ 漂移的检出速度远快于经典 Shewhart 图）；
 * - 自适应控制限：限宽 σ·sqrt(λ/(2-λ)·(1-(1-λ)^2t))，随观测数收敛，
 *   起步阶段自动放宽，避免小样本误报；
 * - σ 用移动极差估计（MR̄/d₂，d₂=1.128）：对非正态、自相关的轨迹指标
 *   比样本标准差更稳健；
 * - Western Electric 加严规则：除了 EWMA 越限，连续同侧（run）与单调
 *   趋势（trend）也判定失控，比单点越限更早发现慢性劣化。
 */
import type { TraceDailyStats } from './store.js';
/** 可监控指标（从日聚合派生）。 */
export type SpcMetric = 'duration-per-trace' | 'tokens-per-trace' | 'anomaly-rate' | 'cache-hit-rate' | 'tool-success-rate';
/** 全部合法指标（供端点校验与文档生成）。 */
export declare const SPC_METRICS: readonly SpcMetric[];
/** 指标元数据：展示名与"好方向"（决定越限哪一侧算劣化）。 */
export declare const SPC_METRIC_META: Readonly<Record<SpcMetric, {
    label: string;
    higherIsBetter: boolean;
}>>;
/** EWMA 平滑系数（λ 越大对近期越敏感；0.2~0.3 是小漂移检测的经典取值）。 */
export declare const DEFAULT_LAMBDA = 0.3;
/** 控制限宽度（L 倍 σ；3 对应经典 3σ 准则）。 */
export declare const DEFAULT_LIMIT_WIDTH = 3;
/** 单日 EWMA 图点。 */
export interface SpcPoint {
    readonly day: string;
    /** 原始指标值。 */
    readonly value: number;
    /** EWMA 统计量。 */
    readonly ewma: number;
    /** 当日上控制限（随 t 收敛）。 */
    readonly ucl: number;
    /** 当日下控制限。 */
    readonly lcl: number;
    /** 是否越限（任意一侧）。 */
    readonly violation: boolean;
    /** 是否落在劣化侧（结合指标的"好方向"）。 */
    readonly badSide: boolean;
}
/** 漂移检测结果。 */
export interface SpcDrift {
    /** shift=EWMA 越限；trend=单调趋势；run=连续同侧；mixed=多种并发；none=受控。 */
    readonly kind: 'shift' | 'trend' | 'run' | 'mixed' | 'none';
    /** 人类可读说明（含触发位置与量级）。 */
    readonly detail: string;
}
/** SPC 分析结果。 */
export interface SpcResult {
    readonly metric: SpcMetric;
    readonly label: string;
    readonly lambda: number;
    readonly limitWidth: number;
    /** 中心线（Phase I 过程均值）。 */
    readonly center: number;
    /** 过程标准差估计（MR̄/d₂）。 */
    readonly sigma: number;
    /** 参与分析的天数。 */
    readonly sampleDays: number;
    readonly points: readonly SpcPoint[];
    readonly drift: SpcDrift;
    /** stable=受控；warning=轻微异常（越限但非劣化侧 / 短趋势）；out-of-control=确认失控。 */
    readonly verdict: 'stable' | 'warning' | 'out-of-control';
    /** EWMA 序列最小二乘斜率（单位/天）：正负表示漂移方向。 */
    readonly driftRatePerDay: number;
}
/**
 * 对日聚合序列执行 EWMA 控制图分析。
 *
 * @param rows 日聚合（升序，含区间外数据也可——Phase I 估计会用全部入参）；
 * @param metric 监控指标；
 * @param lambda EWMA 平滑系数（默认 0.3）；
 * @param limitWidth 控制限宽度（默认 3σ）。
 */
export declare function analyzeSpc(rows: readonly TraceDailyStats[], metric: SpcMetric, lambda?: number, limitWidth?: number): SpcResult;
