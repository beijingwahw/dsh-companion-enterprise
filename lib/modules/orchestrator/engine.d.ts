/**
 * 模块 H：断点续跑与任务编排 —— 执行引擎。
 *
 * - PipelineEngine：按依赖关系（串行/并行/条件分支）执行流水线步骤，
 *   每步完成即持久化中间结果（H2）；失败步骤按错误类别差异化自动重试
 *   （non-retryable 立即放弃 / rate-limit 长退避 / 瞬态短退避，
 *   指数退避 + 全抖动）；断路器熔断期间自动扣住该模型的步骤，
 *   冷却后半开探针自愈；主模型失败可降级 fallbackModel 补跑（自愈执行）；
 *   跨层调度：上游完成即刻释放下游（不等整层），信号量限制并发防配额风暴；
 *   超时自动暂停并通知；resume 从最后成功步骤继续（已完成步骤直接复用输出）；
 * - QueueWorker：批量任务队列（H3），按优先级 + 截止时间排序逐个执行，
 *   断路器熔断的模型自动让位给其他模型的排队任务；
 * - CronTicker：分钟级扫描定时任务（H4），峰谷感知（offPeakOnly 时
 *   仅空闲时段触发），熔断模型顺延到下个扫描周期，执行结果归档。
 *
 * 所有定时器随 Cordis fiber 卸载清理；执行中的调用经 AbortController 可取消。
 */
import type { Context } from '@deepseek-ai/cordis';
import { CircuitBreaker } from './selfheal.js';
import type { PipelineRunStore, QueueTaskStore, ScheduledJobStore, ScheduledRunStore } from './store.js';
import type { Pipeline, PipelineRun, ScheduledJob } from './types.js';
/** 引擎依赖的调用接口（由 index.ts 注入，解耦 DeepSeek 调用细节）。 */
export interface EngineCall {
    (params: {
        prompt: string;
        model: string;
        timeoutMs: number;
        source: string;
    }): Promise<{
        content: string;
        tokens: number;
    }>;
}
/** 生成短 id。 */
export declare function shortId(prefix: string): string;
/** 校验流水线定义（步骤 id 唯一、依赖存在、无循环）。 */
export declare function validatePipeline(pipeline: Pipeline): string | undefined;
/** 生成 YAML 配置（H1：流程图 → YAML）。 */
export declare function pipelineToYaml(pipeline: Pipeline): string;
/** 流水线执行引擎。 */
export declare class PipelineEngine {
    private readonly ctx;
    private readonly runs;
    private readonly call;
    private readonly defaultTimeoutMs;
    /** 模型断路器（与队列/定时调度共享同一实例）。 */
    readonly breaker: CircuitBreaker;
    /** runId → 中止控制器。 */
    private readonly aborts;
    /** runId → 暂停请求标记。 */
    private readonly pauseRequests;
    /** runId → 首次因断路器完全停滞的时间（超时上限用）。 */
    private readonly blockedSince;
    private disposed;
    constructor(ctx: Context, runs: PipelineRunStore, call: EngineCall, defaultTimeoutMs: number, 
    /** 模型断路器（与队列/定时调度共享同一实例）。 */
    breaker?: CircuitBreaker);
    /** 释放：中止全部执行中的流水线。 */
    dispose(): void;
    /**
     * 启动执行并立即返回执行记录（后台异步推进，进度经 runs 仓库轮询）。
     * resumeRun 非空时为断点恢复：已完成步骤直接复用输出，不重跑。
     */
    start(pipeline: Pipeline, resumeRun?: PipelineRun): PipelineRun;
    /** 执行结束通知（best-effort）。 */
    private notifyFinished;
    /** 请求暂停（当前步骤完成后生效）。 */
    requestPause(runId: string): boolean;
    /** 取消执行。 */
    cancel(runId: string): boolean;
    /**
     * 主循环：跨层数据流调度。
     * 就绪步骤（依赖完成且模型未被熔断）立刻启动（不等待同层其他步骤），
     * 信号量限制并发；被断路器扣住的步骤等待冷却后半开探针自愈。
     */
    private runLoop;
    /**
     * 执行单个步骤（含条件分支、超时、差异化重试、自愈降级）。
     *
     * 重试策略按错误类别区分：
     * - non-retryable（鉴权/预算/参数/安全策略）：立即放弃主模型，不烧配额；
     * - rate-limit：长退避（指数退避 + 全抖动，防重试风暴）；
     * - timeout / transient：标准退避。
     * 主模型耗尽后若配置了 fallbackModel 且其未被熔断，自动降级补跑一次。
     */
    private runStep;
}
/** 队列工作器（H3）。 */
export declare class QueueWorker {
    private readonly ctx;
    private readonly tasks;
    private readonly call;
    private readonly defaultTimeoutMs;
    /** 模型断路器（与流水线/定时调度共享同一实例）。 */
    private readonly breaker;
    private draining;
    private timer;
    private disposed;
    /** taskId → 中止控制器。 */
    private readonly aborts;
    constructor(ctx: Context, tasks: QueueTaskStore, call: EngineCall, defaultTimeoutMs: number, 
    /** 模型断路器（与流水线/定时调度共享同一实例）。 */
    breaker?: CircuitBreaker);
    /** 启动周期扫描（每 3 秒检查一次待执行任务）。 */
    start(): void;
    dispose(): void;
    /** 取消单个任务。 */
    cancel(taskId: string): boolean;
    /**
     * 取出下一个待执行任务：优先级 high>medium>low，同级按截止时间早者优先，再按创建时间。
     * 断路器熔断的模型自动跳过（其任务让位给其他模型的排队任务，冷却后自动回来）。
     */
    private nextQueued;
    /** 逐个执行排队任务（单并发，避免刷爆配额）。 */
    private drain;
    /** 执行单个队列任务（含断路器准入、失败策略）。 */
    private executeTask;
}
/** 定时调度器（H4）：分钟级扫描 + 峰谷感知。 */
export declare class CronTicker {
    private readonly ctx;
    private readonly jobs;
    private readonly jobRuns;
    private readonly call;
    private readonly defaultTimeoutMs;
    /** 模型断路器（与流水线/队列共享同一实例）。 */
    private readonly breaker;
    private timer;
    private disposed;
    /** 防止同一分钟内重复触发。 */
    private lastTickMinute;
    constructor(ctx: Context, jobs: ScheduledJobStore, jobRuns: ScheduledRunStore, call: EngineCall, defaultTimeoutMs: number, 
    /** 模型断路器（与流水线/队列共享同一实例）。 */
    breaker?: CircuitBreaker);
    /** 启动分钟级扫描；同时重算全部任务的下次触发时刻。 */
    start(): void;
    dispose(): void;
    /** 重算下次触发时刻。 */
    reschedule(job: ScheduledJob): void;
    /** 扫描到期任务。 */
    private tick;
    /** 执行定时任务并归档。 */
    private executeJob;
}
