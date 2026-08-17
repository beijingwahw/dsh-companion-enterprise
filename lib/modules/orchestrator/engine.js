import { isPeakTime } from '../../core/time.js';
import { nextCronFire, parseCron } from './cron.js';
/** 生成短 id。 */
export function shortId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
/** 校验流水线定义（步骤 id 唯一、依赖存在、无循环）。 */
export function validatePipeline(pipeline) {
    if (pipeline.steps.length === 0)
        return '流水线至少需要一个步骤';
    const ids = new Set();
    for (const step of pipeline.steps) {
        if (!step.id || !step.name)
            return '每个步骤必须有 id 和名称';
        if (ids.has(step.id))
            return `步骤 id 重复：${step.id}`;
        ids.add(step.id);
    }
    for (const step of pipeline.steps) {
        for (const dep of step.dependsOn) {
            if (!ids.has(dep))
                return `步骤 ${step.name} 依赖了不存在的步骤：${dep}`;
            if (dep === step.id)
                return `步骤 ${step.name} 不能依赖自身`;
        }
    }
    // 循环检测（拓扑排序）。
    const indegree = new Map();
    const adjacency = new Map();
    for (const step of pipeline.steps) {
        indegree.set(step.id, step.dependsOn.length);
        adjacency.set(step.id, []);
    }
    for (const step of pipeline.steps) {
        for (const dep of step.dependsOn)
            adjacency.get(dep)?.push(step.id);
    }
    const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    let visited = 0;
    while (queue.length > 0) {
        const id = queue.shift();
        visited += 1;
        for (const next of adjacency.get(id) ?? []) {
            const d = (indegree.get(next) ?? 0) - 1;
            indegree.set(next, d);
            if (d === 0)
                queue.push(next);
        }
    }
    if (visited < pipeline.steps.length)
        return '步骤依赖存在循环';
    return undefined;
}
/** 生成 YAML 配置（H1：流程图 → YAML）。 */
export function pipelineToYaml(pipeline) {
    const lines = [
        `# 流水线：${pipeline.name}`,
        `id: ${pipeline.id}`,
        `name: ${JSON.stringify(pipeline.name)}`,
        'steps:',
    ];
    for (const step of pipeline.steps) {
        lines.push(`  - id: ${step.id}`);
        lines.push(`    name: ${JSON.stringify(step.name)}`);
        lines.push(`    model: ${step.model}`);
        lines.push(`    prompt: ${JSON.stringify(step.prompt)}`);
        lines.push(`    inputFrom: ${step.inputFrom}`);
        if (step.inputFrom === 'literal')
            lines.push(`    input: ${JSON.stringify(step.input)}`);
        if (step.condition)
            lines.push(`    condition: ${JSON.stringify(step.condition)}`);
        if (step.timeoutMs > 0)
            lines.push(`    timeoutMs: ${step.timeoutMs}`);
        if (step.maxRetries > 0) {
            lines.push(`    retry:`);
            lines.push(`      maxRetries: ${step.maxRetries}`);
            lines.push(`      intervalMs: ${step.retryIntervalMs}`);
        }
        if (step.dependsOn.length > 0) {
            lines.push(`    dependsOn: [${step.dependsOn.join(', ')}]`);
        }
    }
    return lines.join('\n');
}
/** 流水线执行引擎。 */
export class PipelineEngine {
    ctx;
    runs;
    call;
    defaultTimeoutMs;
    /** runId → 中止控制器。 */
    aborts = new Map();
    /** runId → 暂停请求标记。 */
    pauseRequests = new Set();
    disposed = false;
    constructor(ctx, runs, call, defaultTimeoutMs) {
        this.ctx = ctx;
        this.runs = runs;
        this.call = call;
        this.defaultTimeoutMs = defaultTimeoutMs;
    }
    /** 释放：中止全部执行中的流水线。 */
    dispose() {
        this.disposed = true;
        for (const controller of this.aborts.values())
            controller.abort();
        this.aborts.clear();
        this.pauseRequests.clear();
    }
    /**
     * 启动执行并立即返回执行记录（后台异步推进，进度经 runs 仓库轮询）。
     * resumeRun 非空时为断点恢复：已完成步骤直接复用输出，不重跑。
     */
    start(pipeline, resumeRun) {
        const run = resumeRun ?? {
            id: shortId('run'),
            pipelineId: pipeline.id,
            status: 'running',
            startedAt: Date.now(),
            endedAt: 0,
            steps: Object.fromEntries(pipeline.steps.map((step) => [
                step.id,
                {
                    stepId: step.id,
                    status: 'pending',
                    attempts: 0,
                    output: '',
                    error: '',
                    startedAt: 0,
                    endedAt: 0,
                    latencyMs: 0,
                    tokens: 0,
                },
            ])),
            message: '',
        };
        // 断点恢复：running 状态的中断步骤回到 pending 重跑；
        // done/skipped 步骤保留输出（H2：从最后成功的步骤继续）。
        for (const record of Object.values(run.steps)) {
            if (record.status === 'running') {
                record.status = 'pending';
                record.startedAt = 0;
            }
        }
        run.status = 'running';
        run.message = '';
        void this.runs.put(run).catch(() => undefined);
        const controller = new AbortController();
        this.aborts.set(run.id, controller);
        void (async () => {
            try {
                await this.runLoop(pipeline, run, controller.signal);
            }
            catch (error) {
                run.status = 'failed';
                run.endedAt = Date.now();
                run.message = error instanceof Error ? error.message : String(error);
            }
            finally {
                this.aborts.delete(run.id);
                this.pauseRequests.delete(run.id);
                await this.runs.put(run).catch(() => undefined);
                this.notifyFinished(pipeline, run);
            }
        })();
        return run;
    }
    /** 执行结束通知（best-effort）。 */
    notifyFinished(pipeline, run) {
        try {
            if (run.status === 'done') {
                this.ctx.companion.notice('success', `流水线「${pipeline.name}」执行完成`);
            }
            else if (run.status === 'failed') {
                this.ctx.companion.notice('error', `流水线「${pipeline.name}」执行失败：${run.message}`);
            }
        }
        catch {
            // 通知失败静默。
        }
    }
    /** 请求暂停（当前步骤完成后生效）。 */
    requestPause(runId) {
        if (!this.aborts.has(runId))
            return false;
        this.pauseRequests.add(runId);
        return true;
    }
    /** 取消执行。 */
    cancel(runId) {
        const controller = this.aborts.get(runId);
        if (!controller)
            return false;
        controller.abort();
        return true;
    }
    /** 主循环：按依赖就绪状态调度步骤（就绪步骤并行执行）。 */
    async runLoop(pipeline, run, signal) {
        for (;;) {
            if (signal.aborted) {
                run.status = 'cancelled';
                run.endedAt = Date.now();
                run.message = '已取消';
                return;
            }
            if (this.pauseRequests.has(run.id)) {
                run.status = 'paused';
                run.endedAt = Date.now();
                run.message = '已暂停（可从断点恢复）';
                this.ctx.companion.notice('info', `流水线「${pipeline.name}」已暂停，可从断点恢复`);
                return;
            }
            // 找出就绪步骤：依赖全部 done/skipped 且自身 pending。
            const ready = [];
            let hasRunning = false;
            let hasFailure = false;
            for (const step of pipeline.steps) {
                const record = run.steps[step.id];
                if (!record)
                    continue;
                if (record.status === 'running')
                    hasRunning = true;
                if (record.status === 'failed')
                    hasFailure = true;
                if (record.status !== 'pending')
                    continue;
                const depsReady = step.dependsOn.every((dep) => {
                    const depRecord = run.steps[dep];
                    return depRecord && (depRecord.status === 'done' || depRecord.status === 'skipped');
                });
                if (depsReady)
                    ready.push(step);
            }
            if (hasFailure) {
                run.status = 'failed';
                run.endedAt = Date.now();
                run.message = '存在失败步骤（可修复后从断点恢复）';
                return;
            }
            if (ready.length === 0 && !hasRunning) {
                // 无就绪步骤也无运行中步骤：全部完成。
                run.status = 'done';
                run.endedAt = Date.now();
                return;
            }
            if (ready.length === 0) {
                // 等待运行中的步骤完成。
                await sleep(200);
                continue;
            }
            // 并行执行就绪步骤（各自独立持久化中间结果）。
            await Promise.all(ready.map((step) => this.runStep(pipeline, run, step, signal)));
        }
    }
    /** 执行单个步骤（含条件分支、超时、重试）。 */
    async runStep(pipeline, run, step, signal) {
        const record = run.steps[step.id];
        if (!record)
            return;
        // 条件分支：依赖输出拼接不包含条件子串 → 跳过。
        if (step.condition) {
            const upstream = step.dependsOn
                .map((dep) => run.steps[dep]?.output ?? '')
                .join('\n');
            if (!upstream.includes(step.condition)) {
                record.status = 'skipped';
                record.endedAt = Date.now();
                await this.runs.put(run);
                return;
            }
        }
        // 组装输入：prev=上游输出拼接；literal=固定输入。
        const input = step.inputFrom === 'literal'
            ? step.input
            : step.dependsOn.map((dep) => run.steps[dep]?.output ?? '').join('\n');
        const prompt = step.prompt
            ? `${step.prompt}\n\n${input}`.trim()
            : input;
        record.status = 'running';
        record.startedAt = Date.now();
        await this.runs.put(run);
        const timeoutMs = step.timeoutMs > 0 ? step.timeoutMs : this.defaultTimeoutMs;
        const maxAttempts = Math.max(1, step.maxRetries + 1);
        let lastError = '';
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (signal.aborted) {
                record.status = 'pending';
                record.startedAt = 0;
                await this.runs.put(run);
                return;
            }
            record.attempts = attempt;
            try {
                const result = await withTimeout(this.call({ prompt, model: step.model, timeoutMs, source: 'orchestrator' }), timeoutMs, `步骤「${step.name}」执行超时（${Math.round(timeoutMs / 1000)}s）`);
                record.status = 'done';
                record.output = result.content;
                record.error = '';
                record.endedAt = Date.now();
                record.latencyMs = record.endedAt - record.startedAt;
                record.tokens = result.tokens;
                await this.runs.put(run);
                return;
            }
            catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
                // 最后一次尝试失败前等待重试间隔。
                if (attempt < maxAttempts && step.retryIntervalMs > 0) {
                    await sleep(step.retryIntervalMs);
                }
            }
        }
        record.status = 'failed';
        record.error = lastError;
        record.endedAt = Date.now();
        record.latencyMs = record.endedAt - record.startedAt;
        await this.runs.put(run);
        // 超时自动暂停并通知（H2 需求）。
        if (/超时/.test(lastError)) {
            this.requestPause(run.id);
            this.ctx.companion.notice('warning', `流水线「${pipeline.name}」步骤「${step.name}」超时，已自动暂停`);
        }
    }
}
/** 队列工作器（H3）。 */
export class QueueWorker {
    ctx;
    tasks;
    call;
    defaultTimeoutMs;
    draining = false;
    timer;
    disposed = false;
    /** taskId → 中止控制器。 */
    aborts = new Map();
    constructor(ctx, tasks, call, defaultTimeoutMs) {
        this.ctx = ctx;
        this.tasks = tasks;
        this.call = call;
        this.defaultTimeoutMs = defaultTimeoutMs;
    }
    /** 启动周期扫描（每 3 秒检查一次待执行任务）。 */
    start() {
        const tick = () => {
            if (this.disposed)
                return;
            void this.drain().catch(() => undefined);
            this.timer = setTimeout(tick, 3_000);
            this.timer.unref?.();
        };
        tick();
    }
    dispose() {
        this.disposed = true;
        if (this.timer)
            clearTimeout(this.timer);
        for (const controller of this.aborts.values())
            controller.abort();
        this.aborts.clear();
    }
    /** 取消单个任务。 */
    cancel(taskId) {
        const controller = this.aborts.get(taskId);
        if (controller) {
            controller.abort();
            return true;
        }
        return false;
    }
    /** 取出下一个待执行任务：优先级 high>medium>low，同级按截止时间早者优先，再按创建时间。 */
    nextQueued() {
        const priorityRank = { high: 0, medium: 1, low: 2 };
        // 单次线性扫描选最优（O(n)），避免每次出队都对全队列排序（O(n log n)）。
        let best;
        for (const task of this.tasks.list()) {
            if (task.status !== 'queued')
                continue;
            if (!best) {
                best = task;
                continue;
            }
            const p = (priorityRank[task.priority] ?? 3) - (priorityRank[best.priority] ?? 3);
            if (p < 0) {
                best = task;
                continue;
            }
            if (p > 0)
                continue;
            const da = task.deadline || Number.MAX_SAFE_INTEGER;
            const db = best.deadline || Number.MAX_SAFE_INTEGER;
            if (da < db || (da === db && task.createdAt < best.createdAt))
                best = task;
        }
        return best;
    }
    /** 逐个执行排队任务（单并发，避免刷爆配额）。 */
    async drain() {
        if (this.draining)
            return;
        this.draining = true;
        try {
            for (;;) {
                if (this.disposed)
                    return;
                const task = this.nextQueued();
                if (!task)
                    return;
                // 截止时间已过：直接标记失败。
                if (task.deadline > 0 && Date.now() > task.deadline) {
                    task.status = 'failed';
                    task.error = '已超过截止时间，未执行';
                    task.finishedAt = Date.now();
                    await this.tasks.put(task);
                    continue;
                }
                await this.executeTask(task);
            }
        }
        finally {
            this.draining = false;
        }
    }
    /** 执行单个队列任务（含失败策略）。 */
    async executeTask(task) {
        task.status = 'running';
        await this.tasks.put(task);
        const controller = new AbortController();
        this.aborts.set(task.id, controller);
        try {
            const result = await this.call({
                prompt: task.prompt,
                model: task.model,
                timeoutMs: this.defaultTimeoutMs,
                source: 'orchestrator-queue',
            });
            task.status = 'done';
            task.output = result.content;
            task.error = '';
            task.finishedAt = Date.now();
            task.attempts += 1;
            await this.tasks.put(task);
        }
        catch (error) {
            this.aborts.delete(task.id);
            task.attempts += 1;
            const message = error instanceof Error ? error.message : String(error);
            if (controller.signal.aborted) {
                task.status = 'cancelled';
                task.error = '已取消';
                task.finishedAt = Date.now();
                await this.tasks.put(task);
                return;
            }
            if (task.failurePolicy === 'retry' && task.attempts < 3) {
                // 重试策略：回到队列（最多 3 次尝试）。
                task.status = 'queued';
                task.error = message;
                await this.tasks.put(task);
                return;
            }
            task.status = 'failed';
            task.error = message;
            task.finishedAt = Date.now();
            await this.tasks.put(task);
            if (task.failurePolicy === 'notify') {
                this.ctx.companion.notice('error', `队列任务「${task.name}」执行失败：${message}`);
            }
        }
        finally {
            this.aborts.delete(task.id);
        }
    }
}
/** 定时调度器（H4）：分钟级扫描 + 峰谷感知。 */
export class CronTicker {
    ctx;
    jobs;
    jobRuns;
    call;
    defaultTimeoutMs;
    timer;
    disposed = false;
    /** 防止同一分钟内重复触发。 */
    lastTickMinute = 0;
    constructor(ctx, jobs, jobRuns, call, defaultTimeoutMs) {
        this.ctx = ctx;
        this.jobs = jobs;
        this.jobRuns = jobRuns;
        this.call = call;
        this.defaultTimeoutMs = defaultTimeoutMs;
    }
    /** 启动分钟级扫描；同时重算全部任务的下次触发时刻。 */
    start() {
        for (const job of this.jobs.list()) {
            if (job.enabled) {
                this.reschedule(job);
                void this.jobs.put(job).catch(() => undefined);
            }
        }
        this.timer = setInterval(() => void this.tick().catch(() => undefined), 30_000);
        this.timer.unref?.();
    }
    dispose() {
        this.disposed = true;
        if (this.timer)
            clearInterval(this.timer);
    }
    /** 重算下次触发时刻。 */
    reschedule(job) {
        try {
            const cron = parseCron(job.cron);
            job.nextRunAt = nextCronFire(cron, Date.now()) ?? 0;
        }
        catch {
            job.nextRunAt = 0;
        }
    }
    /** 扫描到期任务。 */
    async tick() {
        if (this.disposed)
            return;
        const now = Date.now();
        const minuteKey = Math.floor(now / 60_000);
        if (minuteKey === this.lastTickMinute)
            return;
        this.lastTickMinute = minuteKey;
        for (const job of this.jobs.list()) {
            if (!job.enabled || job.nextRunAt <= 0 || now < job.nextRunAt)
                continue;
            // 峰谷感知：仅空闲时段执行（高峰时刻顺延到下一分钟重试）。
            if (job.offPeakOnly && isPeakTime(now))
                continue;
            // 先重排下次触发，再执行本次（执行耗时不影响调度）。
            this.reschedule(job);
            job.lastRunAt = now;
            await this.jobs.put(job).catch(() => undefined);
            void this.executeJob(job).catch(() => undefined);
        }
    }
    /** 执行定时任务并归档。 */
    async executeJob(job) {
        const startedAt = Date.now();
        let ok = false;
        let output = '';
        let error = '';
        try {
            const result = await this.call({
                prompt: job.prompt,
                model: job.model,
                timeoutMs: this.defaultTimeoutMs,
                source: 'orchestrator-cron',
            });
            ok = true;
            output = result.content;
        }
        catch (err) {
            error = err instanceof Error ? err.message : String(err);
            this.ctx.companion.notice('warning', `定时任务「${job.name}」执行失败：${error}`);
        }
        await this.jobRuns
            .put({
            id: shortId('cronrun'),
            jobId: job.id,
            ts: startedAt,
            ok,
            output: output.slice(0, 4_000),
            error,
            latencyMs: Date.now() - startedAt,
        })
            .catch(() => undefined);
    }
}
/** Promise 超时包装。 */
async function withTimeout(promise, timeoutMs, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
}
/** 延时。 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
