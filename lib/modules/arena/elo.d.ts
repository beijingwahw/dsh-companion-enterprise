/**
 * 模块 G 创新扩展：Elo 动态评级与置信排名（Arena Rating System）。
 *
 * 「一次评测跑个排行榜」是快照式对比——样本一小，排名就抖动；
 * 下次重跑，结果可能完全不同。LMSYS Chatbot Arena 证明了对 LLM
 * 排名的正确姿势：把模型对比建模为「对战」，用 Elo 评级累积
 * 所有历史证据，让排名随时间收敛而非随单次评测翻转。
 *
 * 本实现：
 * 1. 对战记录持久化（arena-elo-matches 表）：人类偏好投票
 *    （A/B 谁更好）或评测得分差自动判定胜负；
 * 2. Elo 计分：初始 1500，期望胜率 E = 1/(1+10^(ΔR/400))，
 *    K 因子随场次衰减（32→24→16）——新模型快速定位，
 *    成熟模型评级稳定；
 * 3. Wilson 下界排名：胜率的 95% 置信下界排序——只打过 3 场
 *    全胜的模型（下界 0.4）排在打了 50 场胜率 70% 的模型
 *    （下界 0.56）之后——小样本不再冒进，排名可信；
 * 4. 评级历史：每次对战后记录快照，可回放评级演化。
 */
import type { Domain } from '../../core/storage-adapter.js';
/** Elo 初始分。 */
export declare const ELO_INITIAL = 1500;
/** 对战记录。 */
export interface EloMatch {
    /** 对局 id（时间戳 + 序号）。 */
    readonly id: string;
    readonly ts: number;
    /** 胜方模型（平局时为 null）。 */
    readonly winner: string | null;
    /** 负方模型（平局时为 null）。 */
    readonly loser: string | null;
    /** 平局双方（仅平局时）。 */
    readonly draw: readonly [string, string] | null;
    /** 对战来源：manual=人工偏好投票；leaderboard=评测得分判定。 */
    readonly source: 'manual' | 'leaderboard';
}
/** 单模型评级行（排行榜条目）。 */
export interface EloRow {
    readonly model: string;
    /** 当前 Elo 点估计。 */
    readonly rating: number;
    /** 累计场次。 */
    readonly games: number;
    readonly wins: number;
    readonly losses: number;
    readonly draws: number;
    /** 胜率（胜 + 0.5×平）。 */
    readonly winRate: number;
    /** 胜率 95% Wilson 下界（保守排名依据）。 */
    readonly wilsonLower: number;
    /** 按下界排序的名次（1 起）。 */
    readonly rank: number;
    /** 评级最近变化（最近一场，无场次时 null）。 */
    readonly lastDelta: number | null;
}
/** 评级报告。 */
export interface EloReport {
    /** 全部对战记录（新→旧，≤100 条）。 */
    readonly matches: readonly EloMatch[];
    /** 评级表（按 Wilson 下界降序）。 */
    readonly standings: readonly EloRow[];
    /** 评级演化（每模型 ≤ HISTORY_LIMIT 个快照，升序）。 */
    readonly history: Readonly<Record<string, readonly number[]>>;
}
/**
 * Wilson 评分区间下界（胜率的保守估计）。
 * z=1.96（95% 置信）；零场次返回 0。
 */
export declare function wilsonLowerBound(wins: number, games: number): number;
/**
 * 对战仓库 + 评级引擎（arena-elo-matches / arena-elo-ratings 两张表）。
 */
export declare class EloStore {
    private readonly matchTable;
    private readonly ratingTable;
    private matchCounter;
    constructor(domain: Domain);
    /**
     * 记录一场对战并更新双方评级。
     * @param a 模型 A。
     * @param b 模型 B。
     * @param outcome A 的视角：'win' | 'loss' | 'draw'。
     * @param source 对战来源。
     */
    recordMatch(a: string, b: string, outcome: 'win' | 'loss' | 'draw', source: EloMatch['source']): Promise<void>;
    /** 指定模型的当前评级（无记录时给初始空态）。 */
    private ratingOf;
    /** 完整报告：对战记录 + Wilson 下界排名 + 评级演化。 */
    report(): EloReport;
    /** 清空全部对战与评级。 */
    reset(): Promise<void>;
}
