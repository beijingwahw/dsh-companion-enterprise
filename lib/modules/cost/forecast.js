/** Holt 平滑系数：水平（对最新观测的敏感度）。 */
export const HOLT_ALPHA = 0.35;
/** Holt 平滑系数：趋势。 */
export const HOLT_BETA = 0.15;
/** CUSUM 允许漂移量（k，以基准 σ 为单位）：小于 k 的位移不报警。 */
export const CUSUM_K_SIGMA = 0.5;
/** CUSUM 报警阈值（h，以基准 σ 为单位）：累积偏移超过即判定突变。 */
export const CUSUM_H_SIGMA = 5;
/** 预测外推天数。 */
export const FORECAST_HORIZON = 7;
/**
 * Holt 双参数指数平滑拟合。
 * 返回各期一步预测值、最终水平与趋势（供外推）。
 */
export function fitHolt(series) {
    if (series.length === 0)
        return { fitted: [], level: 0, trend: 0 };
    if (series.length === 1)
        return { fitted: [series[0]], level: series[0], trend: 0 };
    let level = series[0];
    let trend = series[1] - series[0];
    const fitted = [series[0]];
    for (let i = 1; i < series.length; i += 1) {
        // 一步预测（上一期水平 + 趋势），随后用观测修正。
        const prediction = level + trend;
        fitted.push(prediction);
        const prevLevel = level;
        level = HOLT_ALPHA * series[i] + (1 - HOLT_ALPHA) * prediction;
        trend = HOLT_BETA * (level - prevLevel) + (1 - HOLT_BETA) * trend;
    }
    return { fitted, level, trend };
}
/** 由最终水平/趋势外推 n 天（负值截断为 0）。 */
export function extrapolate(level, trend, n) {
    const out = [];
    for (let i = 1; i <= n; i += 1) {
        out.push(Math.max(0, level + trend * i));
    }
    return out;
}
/**
 * CUSUM 双侧突变检测（对日成本序列）。
 *
 * 以首段（最多 7 天）均值为基准 μ0、移动极差估计 σ；
 * 上/下累积和越过 ±h·σ 即判定变点，并在检出后重置基准，
 * 允许检出多个独立突变。
 */
export function detectChangePoints(days) {
    if (days.length < 5)
        return [];
    const values = days.map((d) => d.costCny);
    // 基准段：首段 min(7, n-1) 天。
    const baseLen = Math.min(7, values.length - 1);
    const baseValues = values.slice(0, baseLen);
    let mu = mean(baseValues);
    let sigma = movingRangeSigma(baseValues);
    // σ 为 0（如全 0）时检测无意义。
    if (sigma <= 0)
        return [];
    const k = CUSUM_K_SIGMA * sigma;
    const h = CUSUM_H_SIGMA * sigma;
    let cusumHigh = 0;
    let cusumLow = 0;
    const points = [];
    for (let i = baseLen; i < values.length; i += 1) {
        cusumHigh = Math.max(0, cusumHigh + (values[i] - mu - k));
        cusumLow = Math.min(0, cusumLow + (values[i] - mu + k));
        if (cusumHigh > h || cusumLow < -h) {
            const afterStart = Math.max(0, i - 2);
            const afterMean = mean(values.slice(afterStart, i + 1));
            points.push({
                day: days[i].day,
                direction: cusumHigh > h ? 'surge' : 'drop',
                beforeMean: round4(mu),
                afterMean: round4(afterMean),
            });
            // 重置：以突变后近期窗口为新基准，继续检测后续突变。
            const rebase = values.slice(Math.max(0, i - 2), i + 1);
            mu = mean(rebase);
            sigma = Math.max(movingRangeSigma(rebase), sigma * 0.5);
            cusumHigh = 0;
            cusumLow = 0;
        }
    }
    return points;
}
/** 预算 ETA：按预测日均计算耗尽倒计时。 */
export function budgetEta(budgetCny, spentCny, dailyRateCny, todayDayKey) {
    if (budgetCny <= 0) {
        return { budgetCny, spentCny, dailyRateCny, daysLeft: null, exhaustDay: null };
    }
    if (dailyRateCny <= 0) {
        // 无消耗趋势：不耗尽（或已超支）。
        return {
            budgetCny,
            spentCny,
            dailyRateCny,
            daysLeft: spentCny >= budgetCny ? 0 : null,
            exhaustDay: spentCny >= budgetCny ? todayDayKey : null,
        };
    }
    const remaining = budgetCny - spentCny;
    const daysLeft = remaining <= 0 ? 0 : Math.max(0, remaining / dailyRateCny);
    const exhaustTs = dayKeyToTs(todayDayKey) + Math.ceil(daysLeft) * 86_400_000;
    return {
        budgetCny,
        spentCny: round4(spentCny),
        dailyRateCny: round4(dailyRateCny),
        daysLeft: Math.round(daysLeft * 10) / 10,
        exhaustDay: tsToDayKey(exhaustTs),
    };
}
/**
 * 生成完整预测哨兵报告。
 * @param days 日聚合（升序，来自 usage.range）。
 * @param dailyBudgetCny 日预算（0 = 不限）。
 * @param monthlyBudgetCny 月预算（0 = 不限）。
 * @param monthToDateCny 本月至今成本（月 ETA 的已用基数）。
 * @param todayDayKey 北京时间今日日期键。
 */
export function buildForecastReport(days, dailyBudgetCny, monthlyBudgetCny, monthToDateCny, todayDayKey) {
    const history = days.map((d) => ({ day: d.day, costCny: d.costCny }));
    const series = history.map((d) => d.costCny);
    const { level, trend } = fitHolt(series);
    const future = extrapolate(level, trend, FORECAST_HORIZON);
    const forecast = future.map((cost, i) => ({
        day: tsToDayKey(dayKeyToTs(todayDayKey) + (i + 1) * 86_400_000),
        costCny: round4(cost),
    }));
    // 预测日均：外推均值与近期实际均值（7 天）取加权——外推捕捉趋势，
    // 近期实际提供下限锚定，避免趋势外推过度乐观/悲观。
    const recent = series.slice(-7);
    const projectedDaily = mean(future);
    const recentDaily = recent.length > 0 ? mean(recent) : projectedDaily;
    const dailyRate = Math.max(projectedDaily * 0.6 + recentDaily * 0.4, 0);
    const todaySpent = history.length > 0 && history[history.length - 1].day === todayDayKey
        ? history[history.length - 1].costCny
        : 0;
    return {
        historyDays: history.length,
        history,
        forecast,
        forecastTotalCny: round4(future.reduce((sum, c) => sum + c, 0)),
        dailyEta: dailyBudgetCny > 0 ? budgetEta(dailyBudgetCny, todaySpent, dailyRate, todayDayKey) : null,
        monthlyEta: monthlyBudgetCny > 0
            ? budgetEta(monthlyBudgetCny, monthToDateCny, dailyRate, todayDayKey)
            : null,
        changePoints: detectChangePoints(history),
    };
}
// --------------------------------------------------------------------
// 数值辅助
// --------------------------------------------------------------------
/** 算术均值（空序列返回 0）。 */
function mean(values) {
    if (values.length === 0)
        return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}
/** 移动极差估计 σ（个体控制图标准方法：MR 均值 / 1.128）。 */
function movingRangeSigma(values) {
    if (values.length < 2)
        return 0;
    let sum = 0;
    for (let i = 1; i < values.length; i += 1) {
        sum += Math.abs(values[i] - values[i - 1]);
    }
    return sum / (values.length - 1) / 1.128;
}
/** 四舍五入到 4 位小数（对齐记账精度）。 */
function round4(value) {
    return Math.round(value * 10_000) / 10_000;
}
/** 北京时间日期键 → UTC 时间戳（当日 00:00 CST）。 */
function dayKeyToTs(dayKey) {
    const [y, m, d] = dayKey.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 16);
}
/** UTC 时间戳 → 北京时间日期键。 */
function tsToDayKey(ts) {
    const probe = new Date(ts + 8 * 3_600_000);
    const y = probe.getUTCFullYear();
    const m = String(probe.getUTCMonth() + 1).padStart(2, '0');
    const d = String(probe.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
