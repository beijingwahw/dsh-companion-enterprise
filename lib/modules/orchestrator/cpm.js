/** 零样本先验（与 monte.ts 对齐）。 */
const PRIOR_MOST_LIKELY_MS = 30_000;
/** 步骤工期提取：历史成功延迟中位数；无样本用超时窗/先验。 */
function stepDuration(stepId, timeoutMs, runs) {
    const samples = [];
    for (const run of runs) {
        const record = run.steps[stepId];
        if (record && record.latencyMs > 0 && (record.status === 'done' || record.status === 'skipped')) {
            samples.push(record.latencyMs);
        }
    }
    if (samples.length > 0) {
        const sorted = [...samples].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
        return { durationMs: median, estimated: false, sampleCount: samples.length };
    }
    const prior = timeoutMs > 0 ? Math.round(timeoutMs / 2) : PRIOR_MOST_LIKELY_MS;
    return { durationMs: prior, estimated: true, sampleCount: 0 };
}
/**
 * 关键路径法分析（纯函数）。
 * 前向传播求 ES/EF，回向传播求 LS/LF，松弛 0 的链即关键路径。
 * 依赖图非法（环/悬空依赖）时返回 valid=false 与错误清单。
 */
export function analyzeCriticalPath(pipeline, runs, options = {}) {
    const steps = pipeline.steps;
    const errors = [];
    const byId = new Map(steps.map((step) => [step.id, step]));
    const stepIds = new Set(steps.map((step) => step.id));
    // 依赖合法性。
    for (const step of steps) {
        for (const dep of step.dependsOn) {
            if (!stepIds.has(dep))
                errors.push(`步骤 ${step.id} 依赖不存在的 ${dep}`);
        }
    }
    // Kahn 拓扑排序 + 环检测。
    const indegree = new Map();
    const successors = new Map();
    for (const step of steps) {
        indegree.set(step.id, step.dependsOn.length);
        for (const dep of step.dependsOn) {
            const list = successors.get(dep) ?? [];
            list.push(step.id);
            successors.set(dep, list);
        }
    }
    const queue = steps.filter((s) => s.dependsOn.length === 0).map((s) => s.id);
    const topo = [];
    while (queue.length > 0) {
        const id = queue.shift();
        topo.push(id);
        for (const next of successors.get(id) ?? []) {
            const remain = (indegree.get(next) ?? 0) - 1;
            indegree.set(next, remain);
            if (remain === 0)
                queue.push(next);
        }
    }
    if (topo.length !== steps.length && errors.length === 0) {
        errors.push('依赖图存在环（拓扑排序未覆盖全部步骤）');
    }
    if (errors.length > 0) {
        return {
            pipelineId: pipeline.id,
            pipelineName: pipeline.name,
            valid: false,
            errors,
            criticalPath: [],
            makespanMs: 0,
            steps: [],
            concurrency: null,
            bottleneckStepId: null,
            advice: '依赖图非法，无法做关键路径分析：' + errors.join('；'),
        };
    }
    // 工期表。
    const durations = new Map();
    for (const step of steps) {
        const override = options.durationOverrides?.[step.id];
        durations.set(step.id, override !== undefined && override > 0
            ? { durationMs: Math.round(override), estimated: true, sampleCount: 0 }
            : stepDuration(step.id, step.timeoutMs, runs));
    }
    // 前向传播：ES = max(依赖 EF)；EF = ES + duration。
    const es = new Map();
    const ef = new Map();
    for (const id of topo) {
        const deps = byId.get(id)?.dependsOn ?? [];
        let start = 0;
        for (const dep of deps)
            start = Math.max(start, ef.get(dep) ?? 0);
        const duration = durations.get(id)?.durationMs ?? 0;
        es.set(id, start);
        ef.set(id, start + duration);
    }
    const makespan = steps.reduce((max, step) => Math.max(max, ef.get(step.id) ?? 0), 0);
    // 回向传播：LF = min(下游 LS)；终步 LF = makespan。
    const ls = new Map();
    const lf = new Map();
    for (let i = topo.length - 1; i >= 0; i -= 1) {
        const id = topo[i];
        const nextList = successors.get(id) ?? [];
        let finish = makespan;
        for (const next of nextList)
            finish = Math.min(finish, ls.get(next) ?? makespan);
        const duration = durations.get(id)?.durationMs ?? 0;
        lf.set(id, finish);
        ls.set(id, finish - duration);
    }
    const slackOf = (id) => (ls.get(id) ?? 0) - (es.get(id) ?? 0);
    const critical = (id) => slackOf(id) === 0;
    // 关键路径回溯：从关键终步（EF = makespan 且松弛 0）沿关键依赖回走。
    const criticalTerminals = steps
        .filter((step) => critical(step.id) && (ef.get(step.id) ?? 0) === makespan)
        .map((step) => step.id);
    const path = [];
    if (criticalTerminals.length > 0) {
        let cursor = criticalTerminals[0];
        while (cursor !== undefined) {
            path.unshift(cursor);
            const current = cursor;
            const deps = byId.get(current)?.dependsOn ?? [];
            // 关键依赖 = 依赖的 EF 恰为本步 ES 且依赖自身关键。
            cursor = deps.find((dep) => critical(dep) && (ef.get(dep) ?? 0) === (es.get(current) ?? 0));
        }
    }
    // 并发峰值：扫描 [ES, EF] 窗口的起点事件。
    const events = steps.flatMap((step) => [
        { at: es.get(step.id) ?? 0, stepId: step.id, delta: 1 },
        { at: ef.get(step.id) ?? 0, stepId: step.id, delta: -1 },
    ]);
    events.sort((a, b) => a.at - b.at || b.delta - a.delta);
    let running = 0;
    let peak = 0;
    let peakAt = 0;
    const runningSet = new Set();
    let peakSteps = [];
    for (const event of events) {
        if (event.delta > 0)
            runningSet.add(event.stepId);
        else
            runningSet.delete(event.stepId);
        running += event.delta;
        if (running > peak) {
            peak = running;
            peakAt = event.at;
            peakSteps = [...runningSet];
        }
    }
    const totalDuration = steps.reduce((sum, step) => sum + (durations.get(step.id)?.durationMs ?? 0), 0);
    const cpmSteps = steps.map((step) => ({
        stepId: step.id,
        name: step.name,
        durationMs: durations.get(step.id)?.durationMs ?? 0,
        estimated: durations.get(step.id)?.estimated ?? true,
        sampleCount: durations.get(step.id)?.sampleCount ?? 0,
        esMs: es.get(step.id) ?? 0,
        efMs: ef.get(step.id) ?? 0,
        lsMs: ls.get(step.id) ?? 0,
        lfMs: lf.get(step.id) ?? 0,
        slackMs: slackOf(step.id),
        critical: critical(step.id),
        dependsOn: step.dependsOn,
    }));
    const criticalSteps = cpmSteps.filter((step) => step.critical);
    const bottleneck = criticalSteps.length > 0
        ? criticalSteps.reduce((worst, step) => (step.durationMs > worst.durationMs ? step : worst), criticalSteps[0])
            .stepId
        : null;
    const bottleneckName = bottleneck !== null ? byId.get(bottleneck)?.name ?? bottleneck : '';
    const slackSteps = cpmSteps.filter((step) => !step.critical && step.slackMs > 0);
    const advice = [
        `总工期 ${Math.round(makespan / 1000)}s 由 ${path.length} 步关键路径决定（${path.join(' → ')}）。`,
        bottleneck !== null
            ? `瓶颈：关键步骤「${bottleneckName}」工期最长，压缩它的收益 1:1 传导到总工期。`
            : '',
        slackSteps.length > 0
            ? `${slackSteps.length} 个非关键步骤合计松弛 ${Math.round(slackSteps.reduce((s, x) => s + x.slackMs, 0) / 1000)}s，可安全延后腾挪资源。`
            : '',
        `理想并行可省 ${Math.round((totalDuration - makespan) / 1000)}s，代价是 ${peak} 路并发（峰值为 ${Math.round(peakAt / 1000)}s 处：${peakSteps.join('、')}）。`,
    ]
        .filter((line) => line.length > 0)
        .join(' ');
    return {
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        valid: true,
        errors: [],
        criticalPath: path,
        makespanMs: makespan,
        steps: cpmSteps,
        concurrency: {
            peak,
            peakAtMs: peakAt,
            peakSteps,
            parallelismSavedMs: totalDuration - makespan,
        },
        bottleneckStepId: bottleneck,
        advice,
    };
}
