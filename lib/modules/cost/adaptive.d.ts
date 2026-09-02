/**
 * 自适应模型路由：滑动窗口 UCB1 多臂赌博机（模块 C 的学习层）。
 *
 * 传统路由（关键词启发式 + 静态规则）一旦写下就不再进化；
 * 自适应路由把「选哪个模型」建模为多臂赌博机问题：
 * - 每个候选模型是一个臂（arm），每次调用是一次拉臂（pull）；
 * - 奖励 = 成功率（0.55）+ 相对成本优势（0.3）+ 时延得分（0.15）；
 * - 选择策略 = 窗口均值 + UCB1 探索项（置信上界），
 *   在「利用已知最优」与「探索可能更优」之间取得无 regrets 的平衡；
 * - 观测按环形窗口（最近 WINDOW 次）滚动，价格调整、模型版本更新等
 *   非平稳漂移会被自然遗忘，无需人工重置。
 *
 * 按任务难度类别（simple/complex）维护两套独立赌臂状态——
 * 简单任务的最优模型与复杂任务的最优模型分开学习，互不污染。
 * 状态持久化在 cost-bandit 表（按类别一行），观测写入 best-effort。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 观测滑动窗口容量：每个臂只统计最近 WINDOW 次调用的奖励。 */
export declare const WINDOW = 50;
/** 冷启动探索次数：每个臂至少被尝试该次数后才转入 UCB 利用。 */
export declare const MIN_PULLS = 2;
/** UCB1 探索系数（越大越倾向探索）。 */
export declare const UCB_C = 1.2;
/** 任务难度类别（与 ModelRouter 关键词启发式同源）。 */
export type TaskClass = 'simple' | 'complex';
/** 单个赌臂的滚动统计。 */
export interface BanditArm {
    model: string;
    /** 总拉臂次数（含窗口外）。 */
    pulls: number;
    /** 环形窗口内的近期奖励序列（旧观测被覆盖）。 */
    rewards: number[];
    latencySum: number;
    costSum: number;
    failures: number;
    lastUsedAt?: number;
}
/** 一类任务的赌博机整体状态。 */
export interface BanditState {
    arms: BanditArm[];
    totalPulls: number;
}
/** 选择结果。 */
export interface BanditDecision {
    model: string;
    /** 本决策来自冷启动探索还是 UCB 利用。 */
    mode: 'explore' | 'exploit';
}
/** 单臂报表（/cost/adaptive 面板数据）。 */
export interface ArmReport {
    model: string;
    pulls: number;
    meanReward: number;
    avgLatencyMs: number;
    avgCostCny: number;
    failureRate: number;
    ucb: number;
    lastUsedAt?: number;
}
/** 一次调用的观测输入（奖励在入口处一次性合成）。 */
export interface Observation {
    ok: boolean;
    latencyMs: number;
    costCny: number;
    /** 候选集中最低代理单价（元/百万 tokens）；用于相对成本得分。 */
    cheapestPrice: number;
    /** 本模型代理单价（元/百万 tokens）。 */
    modelPrice: number;
}
/**
 * 合成一次观测的奖励 ∈ [0, 1]：
 * 成功记 1；成本得分 = 最低价 / 本模型价（越便宜越接近 1）；
 * 时延得分 = 1 − latency/apiTimeout（越快越接近 1）。
 */
export declare function computeReward(observation: Observation, apiTimeoutMs: number): number;
/**
 * 自适应路由器：内存状态 + cost-bandit 表持久化。
 * 表读写失败静默降级（退化为本次会话内学习，重启后重新积累）。
 */
export declare class AdaptiveRouter {
    private readonly ctx;
    private readonly states;
    private readonly domains;
    private restored;
    constructor(ctx: Context);
    /**
     * 选择模型：未探索的臂优先（冷启动），否则取 UCB1 最大者。
     * @param cls 任务难度类别。
     * @param candidates 候选模型列表（去重后使用）。
     */
    select(cls: TaskClass, candidates: readonly string[]): Promise<BanditDecision>;
    /**
     * 记录一次观测（best-effort：持久化失败不影响调用主流程）。
     */
    observe(cls: TaskClass, model: string, reward: number, latencyMs: number, costCny: number): Promise<void>;
    /** 全部类别的面板报表。 */
    report(): Promise<Record<TaskClass, ArmReport[]>>;
    /** 清空指定类别（缺省全部）的学习状态。 */
    reset(cls?: TaskClass): Promise<void>;
    /** 取（或构造）类别状态。 */
    private stateOf;
    /** 一次性从 cost-bandit 表恢复两类状态。 */
    private ensureRestored;
    /** 持久化单类别状态（失败静默）。 */
    private persist;
}
