/** 流水线定义仓库。 */
export class PipelineStore {
    table;
    constructor(domain) {
        this.table = domain.table('pipelines');
    }
    list() {
        return this.table
            .entries()
            .map(([, value]) => value)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }
    get(id) {
        return this.table.get(id);
    }
    async put(pipeline) {
        await this.table.put(pipeline.id, pipeline);
    }
    async delete(id) {
        await this.table.delete(id);
    }
}
/** 流水线执行仓库（H2：中间结果持久化，断点恢复的数据基础）。 */
export class PipelineRunStore {
    table;
    constructor(domain) {
        this.table = domain.table('pipeline-runs');
    }
    list() {
        return this.table
            .entries()
            .map(([, value]) => value)
            .sort((a, b) => b.startedAt - a.startedAt);
    }
    /** 某流水线的执行记录（新→旧）。 */
    forPipeline(pipelineId) {
        return this.list().filter((run) => run.pipelineId === pipelineId);
    }
    get(id) {
        return this.table.get(id);
    }
    async put(run) {
        await this.table.put(run.id, run);
    }
    async delete(id) {
        await this.table.delete(id);
    }
}
/** 批量队列任务仓库（H3）。 */
export class QueueTaskStore {
    table;
    constructor(domain) {
        this.table = domain.table('queue-tasks');
    }
    list() {
        return this.table
            .entries()
            .map(([, value]) => value)
            .sort((a, b) => a.createdAt - b.createdAt);
    }
    get(id) {
        return this.table.get(id);
    }
    async put(task) {
        await this.table.put(task.id, task);
    }
    async delete(id) {
        await this.table.delete(id);
    }
    /** 队列统计：各状态数量。 */
    counts() {
        const result = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, paused: 0 };
        for (const task of this.list()) {
            result[task.status] = (result[task.status] ?? 0) + 1;
        }
        return result;
    }
}
/** 定时任务仓库（H4）。 */
export class ScheduledJobStore {
    table;
    constructor(domain) {
        this.table = domain.table('scheduled-jobs');
    }
    list() {
        return this.table
            .entries()
            .map(([, value]) => value)
            .sort((a, b) => b.createdAt - a.createdAt);
    }
    get(id) {
        return this.table.get(id);
    }
    async put(job) {
        await this.table.put(job.id, job);
    }
    async delete(id) {
        await this.table.delete(id);
    }
}
/** 定时执行归档仓库（H4）。 */
export class ScheduledRunStore {
    table;
    constructor(domain) {
        this.table = domain.table('scheduled-runs');
    }
    /** 某任务的执行记录（新→旧），最多保留 limit 条。 */
    forJob(jobId, limit = 50) {
        return this.table
            .entries()
            .map(([, value]) => value)
            .filter((run) => run.jobId === jobId)
            .sort((a, b) => b.ts - a.ts)
            .slice(0, limit);
    }
    async put(run) {
        await this.table.put(run.id, run);
    }
    async delete(id) {
        await this.table.delete(id);
    }
}
