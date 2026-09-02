/**
 * 模块 A 创新扩展：差分隐私统计导出（Differential Privacy Export）。
 *
 * Merkle 导出让「交付的每一份都没被篡改」；k-匿名让「发布的每行
 * 记录都无法指认个人」。但团队经常需要的不是发布明细，而是发布
 * 统计——「我们上个月处理了 X 个会话、命中 Y 次敏感扫描」。
 * 统计也会泄露个体：差分隐私（Cynthia Dwork, 2006；2017 年
 * Gödel 奖；2020 年美国人口普查、Apple/Google 的工业标准）给出了
 * 目前唯一有数学证明的口径：
 *
 *   发布结果 M 满足 ε-差分隐私 ⟺ 任一单个个体的数据在/不在数据集
 *   中，M 的任何输出概率之比 ≤ e^ε——攻击者无法从发布结果反推
 *   任何个体的存在。
 *
 * 实现两件套：
 * 1. Laplace 机制：对每个统计量加 Laplace(0, b) 噪声，b = 敏感度/ε
 *    （计数的敏感度 = 1：一个人在/不在最多改变计数 1）。计数类
 *    结果做取整与非负后处理（后处理免疫：DP 结果再加工不损失保证）；
 * 2. ε 预算账本（privacy accountant）：顺序组合定理——多次释放的
 *    总隐私损失 ≤ Σε_i。每次释放记账，预算耗尽即拒绝释放：
 *    「还能再发布几次」从此是可计算的数字，而不是侥幸。
 *
 * 随机源刻意不设种子：同一指标重复释放必须产生独立噪声并各自
 * 消耗预算——可复现的噪声等于零隐私（组合攻击正等着它）。
 */
import type { Domain } from '../../core/storage-adapter.js';
/** 缺省总预算 ε（相当于十几次 0.25ε 级发布的年吞吐）。 */
export declare const DEFAULT_EPSILON_BUDGET = 3;
/** 单次释放缺省 ε。 */
export declare const DEFAULT_RELEASE_EPSILON = 0.25;
/** 待释放的单个统计量。 */
export interface DpMetricInput {
    /** 统计名（如 "sessions.total"）。 */
    readonly key: string;
    /** 真值（只进不出的本地量）。 */
    readonly value: number;
    /** 敏感度（缺省：计数类 1）。 */
    readonly sensitivity?: number;
    /** count=整数计数（取整、非负后处理）；sum=求和（保留小数）。 */
    readonly kind?: 'count' | 'sum';
}
/** 已释放的统计量（不含真值）。 */
export interface DpReleasedMetric {
    readonly key: string;
    /** 加噪后的发布值（count 已取整非负）。 */
    readonly released: number;
    /** 噪声尺度 b = 敏感度/ε。 */
    readonly scale: number;
    readonly sensitivity: number;
}
/** 单次释放的账本条目。 */
export interface DpReleaseRecord {
    readonly id: string;
    readonly ts: number;
    readonly epsilon: number;
    readonly metrics: readonly string[];
}
/** 预算账本（'export-dp-budget' 表 BUDGET_KEY 记录）。 */
export interface DpLedgerRecord {
    readonly kind: 'ledger';
    readonly budgetEpsilon: number;
    readonly spentEpsilon: number;
    readonly releases: readonly DpReleaseRecord[];
    readonly updatedAt: number;
}
/** 释放结果（未被拒绝时）。 */
export interface DpReleaseSuccess {
    readonly refused: false;
    readonly releaseId: string;
    /** 本次消耗的 ε。 */
    readonly epsilon: number;
    readonly metrics: readonly DpReleasedMetric[];
    readonly spentEpsilon: number;
    readonly budgetEpsilon: number;
    readonly remainingEpsilon: number;
    readonly note: string;
}
/** 预算耗尽的拒绝结果。 */
export interface DpReleaseRefusal {
    readonly refused: true;
    readonly reason: string;
    readonly requestedEpsilon: number;
    readonly spentEpsilon: number;
    readonly budgetEpsilon: number;
    readonly remainingEpsilon: number;
}
export type DpReleaseOutcome = DpReleaseSuccess | DpReleaseRefusal;
/**
 * Laplace(0, scale) 抽样：逆 CDF 变换。
 * scale ≤ 0 时返回 0（敏感度为 0 的统计无需加噪）。
 */
export declare function laplaceNoise(scale: number, rng?: () => number): number;
/**
 * 单值 DP 释放：噪声尺度 b = 敏感度/ε；
 * count 类做取整与非负后处理（后处理免疫）。
 */
export declare function dpReleaseValue(value: number, sensitivity: number, epsilon: number, kind?: 'count' | 'sum', rng?: () => number): {
    released: number;
    noise: number;
    scale: number;
};
/** 差分隐私释放仓库（'export-dp-budget' 表）。 */
export declare class DpBudgetStore {
    private readonly now;
    private readonly table;
    constructor(domain: Domain, now?: () => number);
    /** 当前账本（无记录给初始空态）。 */
    private ledger;
    /** 预算面板。 */
    state(): {
        budgetEpsilon: number;
        spentEpsilon: number;
        remainingEpsilon: number;
        releaseCount: number;
        lastReleaseAt: number | null;
        releases: readonly DpReleaseRecord[];
    };
    /**
     * DP 释放：校验预算 → 逐指标 Laplace 加噪 → 账本记账。
     * 预算不足时返回拒绝（不产生任何释放、不消耗预算）。
     */
    release(metrics: readonly DpMetricInput[], epsilon?: number, rng?: () => number): Promise<DpReleaseOutcome>;
    /** 重置账本（可选新预算 ε；清空已消耗）。 */
    reset(budgetEpsilon?: number): Promise<void>;
}
