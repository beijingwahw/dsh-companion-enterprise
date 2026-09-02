/**
 * 模块 F 创新扩展：Thompson Sampling 变体自动寻优（Prompt Bandit）。
 *
 * F2 的 A/B 测试与 F5 的自动优化都是「固定样本量」设计：基线和候选
 * 各跑同样的次数，哪怕候选连输五轮也要跑满——被浪费的每一次调用
 * 都是真金白银。多臂老虎机六十年前就回答了这个问题：探索与利用
 * 的贝叶斯最优解是概率匹配（probability matching），而 Thompson
 * Sampling 是其最优雅的实现——2020 年以来 Google/Netflix/DoorDash
 * 的线上实验系统几乎清一色采用。
 *
 * 方法论：
 * 1. Beta-Bernoulli 后验：每个变体（臂）的通过率 θ ~ Beta(α, β)，
 *    α=成功数+1、β=失败数+1（均匀先验）。Beta 是 Bernoulli 似然的
 *    共轭先验——一次观测，一个加法，后验即更新，零解析成本；
 * 2. Thompson 采样：每轮对每臂的后验各抽一个样本，选样本值最大的
 *    臂执行。好臂后验集中在高通过率区，被抽中的概率自然高（利用）；
 *    差臂后验宽，偶尔也抽到高值（探索）——不确定性本身就是探索
 *    预算，无需任何手工调参；
 * 3. 停止判据不用 p 值，用贝叶斯决策量（VWO SmartStats 同款）：
 *    - P(best)：各臂联合后验抽样中该臂为最优的频率；
 *    - expected loss：若现在部署该臂，相对「事后最优选择」的
 *      期望通过率损失 E[max θ_j − θ_i]——它是钱的语言：
 *      「部署 A 平均每例损失 0.3% 通过率」；
 *    expected loss < ε 即可停：不是「谁赢了多少」，而是
 *    「继续试错的期望收益已经低于试错成本」；
 * 4. 累计遗憾（regret）跟踪：每轮记录「最优后验均值 − 实际执行臂
 *    的后验均值」，对照 O(log T) 理论界——把学术保证变成面板数字。
 *
 * 判定复用 F5 约定：用例带 expected → 输出包含参考答案即通过（零
 * 成本）；否则模型评审员（jsonMode 严格 JSON 裁决）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Domain } from '../../core/storage-adapter.js';
/** 变体（臂）数上限。 */
export declare const MAX_BANDIT_ARMS = 8;
/** 用例数上限。 */
export declare const MAX_BANDIT_CASES = 10;
/** 单次 pull 请求最多轮数。 */
export declare const MAX_PULL_ROUNDS = 20;
/** 停止判据：期望损失阈值（每例通过率损失低于 1% 即可定版）。 */
export declare const EXPECTED_LOSS_EPSILON = 0.01;
/** 停止判据：P(best) 阈值（90% 概率是最优臂即可定版）。 */
export declare const P_BEST_THRESHOLD = 0.9;
/** 单条评测用例（与 F5 OptimizeCase 同构）。 */
export interface BanditCase {
    /** 用例输入（拼接到变体 Prompt 之后）。 */
    readonly input: string;
    /** 参考答案：输出包含该串即通过；缺省走模型评审员。 */
    readonly expected?: string;
}
/** 单个变体（臂）的完整状态。 */
export interface BanditArm {
    /** 变体 Prompt 全文。 */
    readonly content: string;
    /** Beta 后验 α（成功数 + 1）。 */
    alpha: number;
    /** Beta 后验 β（失败数 + 1）。 */
    beta: number;
    /** 累计执行次数。 */
    pulls: number;
    /** 累计通过次数。 */
    successes: number;
    /** 累计遗憾（每轮：最优后验均值 − 本臂后验均值）。 */
    regret: number;
    lastPullAt: number;
}
/** 老虎机实验记录（'prompt-bandit' 表，键为实验 id）。 */
export interface BanditExperiment {
    readonly kind: 'experiment';
    readonly id: string;
    readonly name: string;
    readonly model: string;
    readonly cases: readonly BanditCase[];
    readonly arms: readonly BanditArm[];
    /** 下一次轮转的用例下标（round-robin 均匀暴露用例难度）。 */
    nextCaseIndex: number;
    readonly createdAt: number;
    updatedAt: number;
}
/** 单臂后验报告。 */
export interface ArmPosterior {
    readonly index: number;
    /** 变体正文（截断 80 字符展示）。 */
    readonly excerpt: string;
    readonly pulls: number;
    readonly successes: number;
    /** 经验通过率。 */
    readonly empiricalRate: number;
    /** 后验均值 α/(α+β)。 */
    readonly posteriorMean: number;
    /** 95% 置信区间（网格数值分位）。 */
    readonly ci95: readonly [number, number];
    /** P(best)：联合后验抽样中为最优臂的频率。 */
    readonly pBest: number;
    /** 期望损失：现在部署本臂，相对事后最优的期望通过率损失。 */
    readonly expectedLoss: number;
    /** 累计遗憾（后验均值差累计，展示用）。 */
    readonly regret: number;
}
/** 后验分析报告。 */
export interface BanditAnalysis {
    readonly arms: readonly ArmPosterior[];
    /** 当前后验下最优臂下标。 */
    readonly bestIndex: number | null;
    /** 是否可停止实验并定版。 */
    readonly readyToStop: boolean;
    /** 裁决说明（中文，可展示）。 */
    readonly verdict: string;
    /** 建议部署的臂（未定版为 null）。 */
    readonly winnerIndex: number | null;
}
/**
 * Gamma(shape, 1) 抽样（Marsaglia-Tsang 压缩法，shape ≥ 1）。
 * shape < 1 时用 boost 技巧：Gamma(shape) = Gamma(shape+1) · U^(1/shape)。
 */
export declare function sampleGamma(shape: number, rng?: () => number): number;
/** Beta(α, β) 抽样：两个独立 Gamma 的归一化（Cheng-Stirastōnă 简化式）。 */
export declare function sampleBeta(alpha: number, beta: number, rng?: () => number): number;
/**
 * Beta 分位数（网格数值 CDF 反演，步长 1/2000）。
 * 精度对 CI 展示绰绰有余，且完全避开不完全 Beta 函数的解析实现。
 */
export declare function betaQuantile(alpha: number, beta: number, p: number): number;
/**
 * Thompson 采样选臂：对每臂后验各抽一个 Beta 样本，取最大者。
 * 返回臂下标（空臂表返回 -1）。
 */
export declare function thompsonPick(arms: readonly BanditArm[], rng?: () => number): number;
/**
 * 后验分析：每臂的经验率/后验均值/95% CI + 联合蒙特卡洛估计
 * P(best) 与期望损失，并给出停止裁决。
 */
export declare function posteriorAnalysis(arms: readonly BanditArm[], rng?: () => number): BanditAnalysis;
/** Thompson Sampling 实验仓库。 */
export declare class BanditStore {
    private readonly table;
    constructor(domain: Domain);
    /** 创建实验（2~MAX_BANDIT_ARMS 个变体）。 */
    create(input: {
        name: string;
        model: string;
        variants: readonly string[];
        cases: readonly BanditCase[];
    }): Promise<BanditExperiment>;
    get(id: string): BanditExperiment | undefined;
    list(): BanditExperiment[];
    save(experiment: BanditExperiment): Promise<void>;
    delete(id: string): Promise<void>;
}
/** 单轮 pull 的执行记录。 */
export interface PullRoundLog {
    readonly round: number;
    /** Thompson 选中的臂下标。 */
    readonly armIndex: number;
    /** 本轮用例下标。 */
    readonly caseIndex: number;
    readonly passed: boolean;
    /** 该臂更新后的后验均值。 */
    readonly armPosteriorMean: number;
    readonly latencyMs: number;
    readonly error?: string;
}
/** 一次 pull 请求的完整结果。 */
export interface PullResult {
    readonly experiment: BanditExperiment;
    readonly rounds: readonly PullRoundLog[];
    readonly analysis: BanditAnalysis;
}
/**
 * 执行 N 轮 Thompson 采样：每轮选臂（后验抽样）→ 轮转选例 →
 * 调用模型判定通过与否 → Beta 后验加法更新 → 累计遗憾。
 */
export declare function runBanditPulls(ctx: Context, store: BanditStore, experimentId: string, rounds: number): Promise<PullResult>;
