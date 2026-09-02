/** 无历史运行时的保守耗时估计（毫秒）。 */
const DEFAULT_STEP_MS = 30_000;
/** 一步历史延迟（毫秒）。 */
function estimateStepMs(step, runs) {
    const samples = [];
    for (const run of runs) {
        const record = run.steps[step.id];
        if (record && record.latencyMs > 0)
            samples.push(record.latencyMs);
    }
    if (samples.length > 0) {
        return { ms: Math.round(samples.reduce((s, v) => s + v, 0) / samples.length), basis: 'history' };
    }
    if (step.timeoutMs > 0)
        return { ms: Math.round(step.timeoutMs / 2), basis: 'timeout' };
    return { ms: DEFAULT_STEP_MS, basis: 'default' };
}
/** 构建某流水线的 DAG 规划（含校验、分层、CPM 与建议）。 */
export function planDag(pipeline, runs) {
    const steps = pipeline.steps;
    const byId = new Map(steps.map((step) => [step.id, step]));
    const errors = [];
    // 1. 悬空依赖校验。
    for (const step of steps) {
        for (const dep of step.dependsOn) {
            if (!byId.has(dep))
                errors.push(`步骤「${step.name}」依赖了不存在的步骤 id：${dep}`);
        }
    }
    // 2. Kahn 拓扑排序（环检测 + 拓扑序）。
    const inDegree = new Map();
    const dependents = new Map();
    for (const step of steps) {
        inDegree.set(step.id, 0);
        dependents.set(step.id, []);
    }
    for (const step of steps) {
        for (const dep of step.dependsOn) {
            if (!byId.has(dep))
                continue;
            inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
            dependents.get(dep)?.push(step.id);
        }
    }
    const queue = steps.filter((s) => (inDegree.get(s.id) ?? 0) === 0).map((s) => s.id);
    const topo = [];
    const levelMap = new Map();
    for (const id of queue)
        levelMap.set(id, 0);
    while (queue.length > 0) {
        const id = queue.shift();
        topo.push(id);
        for (const next of dependents.get(id) ?? []) {
            const deg = (inDegree.get(next) ?? 0) - 1;
            inDegree.set(next, deg);
            if (deg === 0) {
                queue.push(next);
                // 层 = 最深上游层 + 1。
                const depLevel = Math.max(...((byId.get(next)?.dependsOn ?? []).map((d) => levelMap.get(d) ?? 0)));
                levelMap.set(next, depLevel + 1);
            }
        }
    }
    if (topo.length < steps.length) {
        const cyclic = steps.filter((s) => !topo.includes(s.id)).map((s) => s.name);
        errors.push(`检测到循环依赖，涉及步骤：${cyclic.join('、')}`);
        return {
            pipelineId: pipeline.id,
            pipelineName: pipeline.name,
            valid: false,
            errors,
            nodes: [],
            levels: [],
            maxParallelism: 0,
            criticalPath: [],
            totalDurationMs: 0,
            suggestions: ['请修正依赖关系后再分析'],
        };
    }
    // 3. 耗时估算。
    const estimate = new Map();
    for (const step of steps)
        estimate.set(step.id, estimateStepMs(step, runs));
    // 4. CPM 正向（拓扑序推 earliestStart/earliestFinish）。
    const earliest = new Map();
    for (const id of topo) {
        const deps = byId.get(id)?.dependsOn ?? [];
        const start = deps.length === 0 ? 0 : Math.max(...deps.map((d) => earliest.get(d) ?? 0));
        earliest.set(id, start);
    }
    const finishOf = (id) => (earliest.get(id) ?? 0) + (estimate.get(id)?.ms ?? 0);
    const total = topo.length === 0 ? 0 : Math.max(...topo.map(finishOf));
    // 5. CPM 逆向（最晚开始 / 浮动）。
    const latest = new Map();
    for (let i = topo.length - 1; i >= 0; i -= 1) {
        const id = topo[i];
        const downstream = dependents.get(id) ?? [];
        if (downstream.length === 0) {
            latest.set(id, total - (estimate.get(id)?.ms ?? 0));
        }
        else {
            const minChildStart = Math.min(...downstream.map((d) => latest.get(d) ?? 0));
            latest.set(id, minChildStart - (estimate.get(id)?.ms ?? 0));
        }
    }
    // 6. 组装节点。
    const maxLevel = topo.length === 0 ? -1 : Math.max(...[...levelMap.values()]);
    const levels = Array.from({ length: maxLevel + 1 }, () => []);
    const nodes = topo.map((id) => {
        const step = byId.get(id);
        const est = estimate.get(id) ?? { ms: DEFAULT_STEP_MS, basis: 'default' };
        const slack = (latest.get(id) ?? 0) - (earliest.get(id) ?? 0);
        levels[levelMap.get(id) ?? 0].push(id);
        return {
            stepId: id,
            name: step.name,
            level: levelMap.get(id) ?? 0,
            dependsOn: step.dependsOn,
            dependents: dependents.get(id) ?? [],
            estimatedMs: est.ms,
            estimateBasis: est.basis,
            earliestStartMs: earliest.get(id) ?? 0,
            latestStartMs: latest.get(id) ?? 0,
            slackMs: slack,
            critical: slack === 0,
        };
    });
    // 7. 关键路径：从 critical 终点回溯（终点 = 无下游且 critical）。
    const criticalSet = new Set(nodes.filter((n) => n.critical).map((n) => n.stepId));
    const endNodes = nodes.filter((n) => n.dependents.length === 0 && n.critical);
    const criticalPath = [];
    if (endNodes.length > 0) {
        let cursor = endNodes[0];
        criticalPath.unshift(cursor.stepId);
        while (cursor.dependsOn.some((d) => criticalSet.has(d))) {
            const prevCritical = cursor.dependsOn.filter((d) => criticalSet.has(d));
            cursor = nodes.find((n) => n.stepId === prevCritical[prevCritical.length - 1]);
            criticalPath.unshift(cursor.stepId);
        }
    }
    // 8. 可行动建议。
    const suggestions = [];
    const bottleneck = criticalPath
        .map((id) => nodes.find((n) => n.stepId === id))
        .sort((a, b) => b.estimatedMs - a.estimatedMs)[0];
    if (bottleneck && steps.length > 1) {
        suggestions.push(`关键路径瓶颈是「${bottleneck.name}」（约 ${(bottleneck.estimatedMs / 1000).toFixed(1)}s）：` +
            `优化它的 Prompt 长度、换更快模型或配置 fallbackModel，对总工期收益最大。`);
    }
    const maxParallelism = levels.reduce((m, layer) => Math.max(m, layer.length), 0);
    if (maxParallelism > 1) {
        suggestions.push(`流水线存在 ${levels.filter((l) => l.length > 1).length} 个可并行层（最大并行度 ${maxParallelism}）：` +
            `确保执行器按层并发调度，理论总工期可比全串行缩短 ${Math.max(0, Math.round(((steps.reduce((s, step) => s + (estimate.get(step.id)?.ms ?? 0), 0) - total) /
                Math.max(1, steps.reduce((s, step) => s + (estimate.get(step.id)?.ms ?? 0), 0))) *
                100))}%。`);
    }
    const singlePoints = nodes.filter((n) => n.dependents.length >= 3);
    for (const point of singlePoints.slice(0, 3)) {
        suggestions.push(`「${point.name}」是单点依赖（${point.dependents.length} 个下游在等它）：` +
            `它的失败会阻塞整层，建议提高其 maxRetries 或配置降级模型。`);
    }
    if (suggestions.length === 0 && steps.length > 0) {
        suggestions.push('流水线为纯串行链：考虑拆分无数据依赖的步骤为并行层以缩短工期。');
    }
    return {
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        valid: errors.length === 0,
        errors,
        nodes,
        levels,
        maxParallelism,
        criticalPath,
        totalDurationMs: total,
        suggestions,
    };
}
