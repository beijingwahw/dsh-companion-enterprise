/**
 * 模块 H：断点续跑与任务编排 —— 存储。
 *
 * 全部落在 companion 域：
 * - 'pipelines'：流水线定义（H1）；
 * - 'pipeline-runs'：执行记录，含每步中间结果（H2 断点续跑）；
 * - 'queue-tasks'：批量队列任务（H3）；
 * - 'scheduled-jobs' / 'scheduled-runs'：定时任务与归档（H4）。
 */
import type { Domain } from '../../core/storage-adapter.js';
import type { Pipeline, PipelineRun, QueueTask, ScheduledJob, ScheduledRun } from './types.js';
/** 流水线定义仓库。 */
export declare class PipelineStore {
    private readonly table;
    constructor(domain: Domain);
    list(): Pipeline[];
    get(id: string): Pipeline | undefined;
    put(pipeline: Pipeline): Promise<void>;
    delete(id: string): Promise<void>;
}
/** 流水线执行仓库（H2：中间结果持久化，断点恢复的数据基础）。 */
export declare class PipelineRunStore {
    private readonly table;
    constructor(domain: Domain);
    list(): PipelineRun[];
    /** 某流水线的执行记录（新→旧）。 */
    forPipeline(pipelineId: string): PipelineRun[];
    get(id: string): PipelineRun | undefined;
    put(run: PipelineRun): Promise<void>;
    delete(id: string): Promise<void>;
}
/** 批量队列任务仓库（H3）。 */
export declare class QueueTaskStore {
    private readonly table;
    constructor(domain: Domain);
    list(): QueueTask[];
    get(id: string): QueueTask | undefined;
    put(task: QueueTask): Promise<void>;
    delete(id: string): Promise<void>;
    /** 队列统计：各状态数量。 */
    counts(): Record<string, number>;
}
/** 定时任务仓库（H4）。 */
export declare class ScheduledJobStore {
    private readonly table;
    constructor(domain: Domain);
    list(): ScheduledJob[];
    get(id: string): ScheduledJob | undefined;
    put(job: ScheduledJob): Promise<void>;
    delete(id: string): Promise<void>;
}
/** 定时执行归档仓库（H4）。 */
export declare class ScheduledRunStore {
    private readonly table;
    constructor(domain: Domain);
    /** 某任务的执行记录（新→旧），最多保留 limit 条。 */
    forJob(jobId: string, limit?: number): ScheduledRun[];
    put(run: ScheduledRun): Promise<void>;
    delete(id: string): Promise<void>;
}
