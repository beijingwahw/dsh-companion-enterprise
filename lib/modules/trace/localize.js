import { isFailedTrace } from './precursors.js';
/** 结论裁定：可疑度下限。 */
const VERDICT_MIN_SUSPICION = 0.6;
/** 结论裁定：失败支持度下限（至少出现在这么多条失败轨迹中）。 */
const VERDICT_MIN_FAILED_COUNT = 2;
/** 返回组件数上限。 */
const TOP_COMPONENTS = 20;
/** 组件键：行为签名（kind:name，剥离状态与参数）。 */
export function componentKey(node) {
    return `${node.kind}:${node.name}`;
}
/** 单组件可疑度 → 工程线索文案。 */
function buildAdvice(stats, suspicion) {
    const lines = [];
    if (suspicion >= 0.5 && stats.passedCount === 0 && stats.failedCount >= 2) {
        lines.push('仅在失败轨迹中出现，且失败轨迹几乎都经过它——优先排查');
    }
    if (stats.durationSamplesInFailed > 0 && stats.durationSamplesInPassed > 0) {
        const failedAvg = stats.durationInFailed / stats.durationSamplesInFailed;
        const passedAvg = stats.durationInPassed / stats.durationSamplesInPassed;
        if (passedAvg > 0 && failedAvg >= passedAvg * 2) {
            lines.push(`失败运行中平均慢 ${(failedAvg / passedAvg).toFixed(1)} 倍`);
        }
    }
    if (stats.failedCount > 0 && stats.retriesInFailed / stats.failedCount >= 0.3) {
        lines.push(`失败运行中重试率 ${Math.round((stats.retriesInFailed / stats.failedCount) * 100)}%`);
    }
    if (lines.length === 0)
        lines.push('可疑度有限，保持观察');
    return lines.join('；');
}
/**
 * 频谱根因定位（纯函数）。
 * @param traces 历史轨迹集合（成功与失败对照语料）。
 */
export function localizeFaults(traces) {
    const okTraces = [];
    const failedTraces = [];
    for (const trace of traces) {
        if (trace.nodes.length === 0)
            continue;
        if (isFailedTrace(trace))
            failedTraces.push(trace);
        else
            okTraces.push(trace);
    }
    const totalFailed = failedTraces.length;
    const totalOk = okTraces.length;
    const total = totalFailed + totalOk;
    const failureRate = total > 0 ? totalFailed / total : 0;
    if (totalFailed === 0 || total === 0) {
        return {
            traces: { ok: totalOk, failed: totalFailed },
            failureRate,
            components: [],
            verdict: null,
            note: total === 0
                ? '没有可分析的轨迹'
                : '语料中没有失败轨迹——根因定位需要成功与失败两组对照样本',
        };
    }
    // 频谱采集：组件 → 成功/失败覆盖计数 + 差分画像累计。
    const stats = new Map();
    const bump = (trace, failed) => {
        const seen = new Set();
        for (const node of trace.nodes) {
            const key = componentKey(node);
            let entry = stats.get(key);
            if (!entry) {
                entry = {
                    kind: node.kind,
                    name: node.name,
                    failedCount: 0,
                    passedCount: 0,
                    durationInFailed: 0,
                    durationInPassed: 0,
                    durationSamplesInFailed: 0,
                    durationSamplesInPassed: 0,
                    retriesInFailed: 0,
                };
                stats.set(key, entry);
            }
            // 同一轨迹内同名组件只计一次覆盖（频谱是集合语义）。
            if (!seen.has(key)) {
                seen.add(key);
                if (failed)
                    entry.failedCount += 1;
                else
                    entry.passedCount += 1;
                if (node.attempts > 1 || node.status === 'retry') {
                    if (failed)
                        entry.retriesInFailed += 1;
                }
            }
            // 耗时与重试按节点累计（均值用样本数除）。
            if (failed) {
                entry.durationInFailed += node.durationMs;
                entry.durationSamplesInFailed += 1;
            }
            else {
                entry.durationInPassed += node.durationMs;
                entry.durationSamplesInPassed += 1;
            }
        }
    };
    for (const trace of failedTraces)
        bump(trace, true);
    for (const trace of okTraces)
        bump(trace, false);
    // Ochiai 可疑度。
    const components = [];
    for (const entry of stats.values()) {
        if (entry.failedCount === 0)
            continue;
        const suspiciousness = entry.failedCount / Math.sqrt(totalFailed * (entry.failedCount + entry.passedCount));
        components.push({
            component: `${entry.kind}:${entry.name}`,
            kind: entry.kind,
            name: entry.name,
            failedCount: entry.failedCount,
            passedCount: entry.passedCount,
            suspiciousness: Math.round(suspiciousness * 1000) / 1000,
            avgDurationInFailedMs: entry.durationSamplesInFailed > 0
                ? Math.round(entry.durationInFailed / entry.durationSamplesInFailed)
                : 0,
            avgDurationInPassedMs: entry.durationSamplesInPassed > 0
                ? Math.round(entry.durationInPassed / entry.durationSamplesInPassed)
                : 0,
            retryRateInFailed: entry.failedCount > 0
                ? Math.round((entry.retriesInFailed / entry.failedCount) * 1000) / 1000
                : 0,
            advice: buildAdvice(entry, suspiciousness),
        });
    }
    components.sort((a, b) => b.suspiciousness - a.suspiciousness || b.failedCount - a.failedCount);
    const top = components.slice(0, TOP_COMPONENTS);
    // 根因裁定：双达标才指认（防小样本冤案）。
    const prime = top.find((c) => c.suspiciousness >= VERDICT_MIN_SUSPICION && c.failedCount >= VERDICT_MIN_FAILED_COUNT);
    const verdict = prime
        ? `「${prime.component}」高度可疑：${prime.failedCount}/${totalFailed} 条失败轨迹覆盖` +
            (prime.passedCount === 0
                ? '，且成功轨迹零覆盖'
                : `（成功轨迹仅 ${prime.passedCount} 条覆盖）`) +
            `；${prime.advice}`
        : null;
    const note = prime
        ? '按可疑度降序排列；建议优先复核结论指认的组件'
        : '可疑度均未达裁定阈值（样本不足或失败原因分散），排行仅作参考';
    return {
        traces: { ok: totalOk, failed: totalFailed },
        failureRate: Math.round(failureRate * 1000) / 1000,
        components: top,
        verdict,
        note,
    };
}
