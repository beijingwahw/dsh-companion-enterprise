import { round4 } from '../../core/pricing.js';
/** 全部合法指标（供端点校验与文档生成）。 */
export const SPC_METRICS = [
    'duration-per-trace',
    'tokens-per-trace',
    'anomaly-rate',
    'cache-hit-rate',
    'tool-success-rate',
];
/** 指标元数据：展示名与"好方向"（决定越限哪一侧算劣化）。 */
export const SPC_METRIC_META = {
    'duration-per-trace': { label: '单轨迹耗时（ms）', higherIsBetter: false },
    'tokens-per-trace': { label: '单轨迹 Token', higherIsBetter: false },
    'anomaly-rate': { label: '异常率', higherIsBetter: false },
    'cache-hit-rate': { label: '缓存命中率', higherIsBetter: true },
    'tool-success-rate': { label: '工具成功率', higherIsBetter: true },
};
/** EWMA 平滑系数（λ 越大对近期越敏感；0.2~0.3 是小漂移检测的经典取值）。 */
export const DEFAULT_LAMBDA = 0.3;
/** 控制限宽度（L 倍 σ；3 对应经典 3σ 准则）。 */
export const DEFAULT_LIMIT_WIDTH = 3;
/** 趋势判定所需的最长单调段长度（Western Electric：6 点连续升/降）。 */
const TREND_RUN_LENGTH = 6;
/** 连续同侧判定长度（Western Electric：8 点同侧中心线）。 */
const SIDE_RUN_LENGTH = 8;
/** d₂ 常数（n=2 移动极差 → σ 换算）。 */
const D2_N2 = 1.128;
/** 从日聚合提取指标值；无轨迹的天返回 undefined（不参与序列）。 */
function extractValue(metric, row) {
    if (row.traceCount <= 0)
        return undefined;
    switch (metric) {
        case 'duration-per-trace':
            return row.totalDurationMs / row.traceCount;
        case 'tokens-per-trace':
            return (row.totalInputTokens + row.totalOutputTokens) / row.traceCount;
        case 'anomaly-rate':
            return row.anomalyCount / row.traceCount;
        case 'cache-hit-rate':
            return row.modelCalls > 0 ? row.cacheHits / row.modelCalls : undefined;
        case 'tool-success-rate':
            return row.toolCalls > 0 ? row.toolSuccess / row.toolCalls : undefined;
    }
}
/** 计算样本标准差（至少 2 个点；用于 σ 的兜底）。 */
function sampleStdDev(values) {
    if (values.length < 2)
        return 0;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (values.length - 1);
    return Math.sqrt(variance);
}
/** EWMA 方差收敛系数：sqrt(λ/(2-λ) · (1-(1-λ)^2t))。 */
function ewmaLimitFactor(lambda, t) {
    return Math.sqrt((lambda / (2 - lambda)) * (1 - Math.pow(1 - lambda, 2 * t)));
}
/** 最小二乘斜率（x 为 0..n-1）。 */
function slope(values) {
    const n = values.length;
    if (n < 2)
        return 0;
    const meanX = (n - 1) / 2;
    const meanY = values.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
        num += (i - meanX) * (values[i] - meanY);
        den += (i - meanX) * (i - meanX);
    }
    return den === 0 ? 0 : num / den;
}
/**
 * 对日聚合序列执行 EWMA 控制图分析。
 *
 * @param rows 日聚合（升序，含区间外数据也可——Phase I 估计会用全部入参）；
 * @param metric 监控指标；
 * @param lambda EWMA 平滑系数（默认 0.3）；
 * @param limitWidth 控制限宽度（默认 3σ）。
 */
export function analyzeSpc(rows, metric, lambda = DEFAULT_LAMBDA, limitWidth = DEFAULT_LIMIT_WIDTH) {
    const meta = SPC_METRIC_META[metric];
    const series = rows
        .map((row) => ({ day: row.day, value: extractValue(metric, row) }))
        .filter((item) => item.value !== undefined);
    // 样本不足：中心线/控制限没有统计意义，直接返回受控空结果。
    if (series.length < 5) {
        return {
            metric,
            label: meta.label,
            lambda,
            limitWidth,
            center: 0,
            sigma: 0,
            sampleDays: series.length,
            points: series.map((item) => ({
                day: item.day,
                value: round4(item.value),
                ewma: round4(item.value),
                ucl: 0,
                lcl: 0,
                violation: false,
                badSide: false,
            })),
            drift: {
                kind: 'none',
                detail: `有效样本仅 ${series.length} 天（<5），暂无法建立控制图，继续积累轨迹数据`,
            },
            verdict: 'stable',
            driftRatePerDay: 0,
        };
    }
    // Phase I：过程参数估计。
    const values = series.map((item) => item.value);
    const center = values.reduce((s, v) => s + v, 0) / values.length;
    // σ 优先用移动极差（对自相关序列更稳健），全零时退回样本标准差。
    let mrSum = 0;
    for (let i = 1; i < values.length; i += 1)
        mrSum += Math.abs(values[i] - values[i - 1]);
    const mrBar = mrSum / (values.length - 1);
    const sigma = mrBar > 0 ? mrBar / D2_N2 : sampleStdDev(values);
    // EWMA 递推 + 自适应控制限。
    const points = [];
    let ewma = center;
    for (let t = 0; t < values.length; t += 1) {
        ewma = lambda * values[t] + (1 - lambda) * ewma;
        const halfWidth = limitWidth * sigma * ewmaLimitFactor(lambda, t + 1);
        const ucl = center + halfWidth;
        const lcl = center - halfWidth;
        const violation = ewma > ucl || ewma < lcl;
        const badSide = meta.higherIsBetter ? ewma < lcl : ewma > ucl;
        points.push({
            day: series[t].day,
            value: round4(values[t]),
            ewma: round4(ewma),
            ucl: round4(ucl),
            lcl: round4(lcl),
            violation,
            badSide,
        });
    }
    // Western Electric 加严规则：连续同侧与单调趋势。
    const runDrift = detectRun(points, center);
    const trendDrift = detectTrend(values);
    // 汇总漂移判定。
    const violationPoints = points.filter((p) => p.violation);
    const badViolations = points.filter((p) => p.badSide);
    const drifts = [];
    if (badViolations.length > 0) {
        const last = badViolations[badViolations.length - 1];
        drifts.push({
            kind: 'shift',
            detail: `EWMA 越出控制限且位于劣化侧：${badViolations.length} 天（最近 ${last.day}，EWMA ${last.ewma} 超出中心线 ${round4(center)} 的控制范围）`,
        });
    }
    else if (violationPoints.length > 0) {
        const last = violationPoints[violationPoints.length - 1];
        drifts.push({
            kind: 'shift',
            detail: `EWMA 越出控制限 ${violationPoints.length} 天（最近 ${last.day}），但位于改善侧，属良性波动`,
        });
    }
    if (runDrift)
        drifts.push(runDrift);
    if (trendDrift)
        drifts.push(trendDrift);
    const drift = mergeDrifts(drifts, meta.label, center);
    const driftRatePerDay = slope(points.map((p) => p.ewma));
    const driftIsBad = meta.higherIsBetter ? driftRatePerDay < 0 : driftRatePerDay > 0;
    // 判级：劣化侧越限 → out-of-control；其余异常（良性越限/趋势/同侧）→ warning。
    let verdict = 'stable';
    if (badViolations.length > 0)
        verdict = 'out-of-control';
    else if (drift.kind !== 'none')
        verdict = 'warning';
    else if (driftIsBad && Math.abs(driftRatePerDay) * 7 > Math.max(sigma, 1e-9)) {
        // 未触发规则但斜率方向不良且量级可观（周漂移超过 1σ）→ 提示级。
        verdict = 'warning';
    }
    return {
        metric,
        label: meta.label,
        lambda,
        limitWidth,
        center: round4(center),
        sigma: round4(sigma),
        sampleDays: series.length,
        points,
        drift,
        verdict,
        driftRatePerDay: round4(driftRatePerDay),
    };
}
/** Western Electric 连续同侧规则：8+ 天 EWMA 在中心线同一侧。 */
function detectRun(points, center) {
    let bestSide = 0;
    let bestLen = 0;
    let bestEndDay = '';
    let side = 0;
    let len = 0;
    for (const point of points) {
        const s = point.ewma > center ? 1 : point.ewma < center ? -1 : 0;
        if (s !== 0 && s === side)
            len += 1;
        else {
            side = s;
            len = s === 0 ? 0 : 1;
        }
        if (len >= SIDE_RUN_LENGTH && len >= bestLen) {
            bestLen = len;
            bestSide = side;
            bestEndDay = point.day;
        }
    }
    if (bestLen < SIDE_RUN_LENGTH)
        return undefined;
    const where = bestSide > 0 ? '上方' : '下方';
    return {
        kind: 'run',
        detail: `EWMA 连续 ${bestLen} 天位于中心线${where}（截至 ${bestEndDay}），过程均值大概率已偏移`,
    };
}
/** Western Electric 趋势规则：6+ 天单调升/降（原始值）。 */
function detectTrend(values) {
    let bestLen = 0;
    let bestDir = 0;
    let bestEnd = -1;
    let dir = 0;
    let len = 0;
    for (let i = 0; i < values.length; i += 1) {
        if (i > 0 && values[i] !== values[i - 1]) {
            const d = values[i] > values[i - 1] ? 1 : -1;
            if (d === dir)
                len += 1;
            else {
                dir = d;
                len = 2;
            }
        }
        else if (i > 0) {
            // 相等打断单调性。
            dir = 0;
            len = 0;
        }
        if (len >= TREND_RUN_LENGTH && len >= bestLen) {
            bestLen = len;
            bestDir = dir;
            bestEnd = i;
        }
    }
    if (bestLen < TREND_RUN_LENGTH)
        return undefined;
    const where = bestDir > 0 ? '上升' : '下降';
    return {
        kind: 'trend',
        detail: `指标连续 ${bestLen} 天单调${where}（截至第 ${bestEnd + 1} 天），存在系统性漂移趋势`,
    };
}
/** 合并多种漂移信号为一条结论。 */
function mergeDrifts(drifts, label, center) {
    if (drifts.length === 0) {
        return { kind: 'none', detail: `过程受控：${label} 稳定在 ${round4(center)} 附近，未检测到漂移信号` };
    }
    if (drifts.length === 1)
        return drifts[0];
    return {
        kind: 'mixed',
        detail: drifts.map((d) => d.detail).join('；'),
    };
}
