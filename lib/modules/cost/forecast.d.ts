/**
 * 成本预测哨兵（Budget Sentinel）：从「记账」升级为「预知」。
 *
 * 传统成本报表是后视镜——看到超支时已经超支。预测哨兵把成本治理
 * 推进到事前：
 * 1. Holt 双参数指数平滑（水平 + 趋势）：对每日成本序列拟合局部
 *    线性趋势并外推未来 7 天——比移动平均更能捕捉「逐日增长」的
 *    用量惯性（如项目进入攻坚期）；
 * 2. 预算耗尽 ETA：按预测日均成本估算日/月预算的耗尽时间，
 *    「照此速度 X 天后超支」让预算从告警变成倒计时；
 * 3. CUSUM 突变检测：对日成本计算上下双侧累积和，均值发生持续
 *    位移（重试风暴、循环调用、提示词膨胀）时及时定位变点——
 *    这是 SPC 领域对「缓慢累积漂移」最敏感的检测器。
 *
 * 纯函数模块：数据来自 UsageStore 日聚合，无独立存储状态。
 */
import type { DailyUsage } from '../../core/usage.js';
/** Holt 平滑系数：水平（对最新观测的敏感度）。 */
export declare const HOLT_ALPHA = 0.35;
/** Holt 平滑系数：趋势。 */
export declare const HOLT_BETA = 0.15;
/** CUSUM 允许漂移量（k，以基准 σ 为单位）：小于 k 的位移不报警。 */
export declare const CUSUM_K_SIGMA = 0.5;
/** CUSUM 报警阈值（h，以基准 σ 为单位）：累积偏移超过即判定突变。 */
export declare const CUSUM_H_SIGMA = 5;
/** 预测外推天数。 */
export declare const FORECAST_HORIZON = 7;
/** 单日预测点。 */
export interface ForecastPoint {
    /** 北京时间日期键 YYYY-MM-DD。 */
    readonly day: string;
    /** 预测成本（元，四舍五入到 4 位）。 */
    readonly costCny: number;
}
/** CUSUM 突变检测结果。 */
export interface ChangePoint {
    /** 突变日（北京时间日期键）。 */
    readonly day: string;
    /** 突变方向：激增 / 骤降。 */
    readonly direction: 'surge' | 'drop';
    /** 突变前均值与突变后近期均值的估计（元）。 */
    readonly beforeMean: number;
    readonly afterMean: number;
}
/** 预算耗尽预估。 */
export interface BudgetEta {
    /** 预算总额（元）。 */
    readonly budgetCny: number;
    /** 已用（元）。 */
    readonly spentCny: number;
    /** 预测日均成本（元/天）。 */
    readonly dailyRateCny: number;
    /** 预计剩余天数（日均 > 0 时存在；预算无限或已超支时为 null）。 */
    readonly daysLeft: number | null;
    /** 预计耗尽日（北京时间日期键）。 */
    readonly exhaustDay: string | null;
}
/** 预测哨兵整体报告（/cost/forecast 响应体）。 */
export interface ForecastReport {
    /** 参与拟合的历史天数。 */
    readonly historyDays: number;
    /** 历史实际日成本序列（元，升序）。 */
    readonly history: ReadonlyArray<{
        readonly day: string;
        readonly costCny: number;
    }>;
    /** 未来 7 天预测点。 */
    readonly forecast: readonly ForecastPoint[];
    /** 预测 7 天总成本（元）。 */
    readonly forecastTotalCny: number;
    /** 日预算 ETA（未配置日预算时为 null）。 */
    readonly dailyEta: BudgetEta | null;
    /** 月预算 ETA（未配置月预算时为 null）。 */
    readonly monthlyEta: BudgetEta | null;
    /** CUSUM 检出的成本突变点（按日期升序）。 */
    readonly changePoints: readonly ChangePoint[];
}
/**
 * Holt 双参数指数平滑拟合。
 * 返回各期一步预测值、最终水平与趋势（供外推）。
 */
export declare function fitHolt(series: readonly number[]): {
    fitted: number[];
    level: number;
    trend: number;
};
/** 由最终水平/趋势外推 n 天（负值截断为 0）。 */
export declare function extrapolate(level: number, trend: number, n: number): number[];
/**
 * CUSUM 双侧突变检测（对日成本序列）。
 *
 * 以首段（最多 7 天）均值为基准 μ0、移动极差估计 σ；
 * 上/下累积和越过 ±h·σ 即判定变点，并在检出后重置基准，
 * 允许检出多个独立突变。
 */
export declare function detectChangePoints(days: ReadonlyArray<{
    readonly day: string;
    readonly costCny: number;
}>): ChangePoint[];
/** 预算 ETA：按预测日均计算耗尽倒计时。 */
export declare function budgetEta(budgetCny: number, spentCny: number, dailyRateCny: number, todayDayKey: string): BudgetEta;
/**
 * 生成完整预测哨兵报告。
 * @param days 日聚合（升序，来自 usage.range）。
 * @param dailyBudgetCny 日预算（0 = 不限）。
 * @param monthlyBudgetCny 月预算（0 = 不限）。
 * @param monthToDateCny 本月至今成本（月 ETA 的已用基数）。
 * @param todayDayKey 北京时间今日日期键。
 */
export declare function buildForecastReport(days: readonly DailyUsage[], dailyBudgetCny: number, monthlyBudgetCny: number, monthToDateCny: number, todayDayKey: string): ForecastReport;
