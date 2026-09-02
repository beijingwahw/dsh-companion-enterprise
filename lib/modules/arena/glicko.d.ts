/**
 * 模块 G 创新扩展：Glicko-2 时变置信评级（Glicko-2 Rating System）。
 *
 * Elo（G5）解决了「排名随证据累积而收敛」；但 Elo 有两个已被
 * 评级科学解答的结构性缺陷：
 * 1. 点估计无置信度——1500 分打了 5 场和打了 500 场在榜上无法区分；
 * 2. 久未参赛的选手评级「冻结」——模型三个月没被评测，其 1500 分
 *    的可信度早已衰减，Elo 却照旧使用。
 *
 * Glicko-2（Mark Glickman，2001；国际象棋界 Lichess/FICS 的现役
 * 评级系统）给每个选手补上两个状态量：
 * - RD（rating deviation）：评级的标准差——每场对战收缩（证据变多），
 *   闲置时按 c·√t 增长（证据变陈旧），封顶 350（回到先验）；
 * - σ（volatility）：选手表现波动的大小，由 Illinois 迭代法从近况
 *   估计——状态忽好忽坏的模型评级变化更陡。
 *
 * 排名口径因此升级为「保守分 = rating − 1.96×RD」：小样本模型的
 * 95% 置信下界远低于点估计，自动排后；久未评测的模型 RD 自动放大，
 * 排名自动回落——榜单自己会表达「我不确定」。
 *
 * 实现：Glickman 论文附录的标准算法（尺度变换 μ/φ = (r−1500)/
 * 173.7178、g/E 函数、v/Δ、Illinois 法解 σ'），逐场对战按单场
 * 评级期处理（事件驱动更新的标准实践）；RD 闲置增长惰性应用于
 * 读取时（不写库，报告一致）。
 */
import type { Domain } from '../../core/storage-adapter.js';
/** 初始分。 */
export declare const GLICKO_INITIAL_RATING = 1500;
/** 初始 RD（最大不确定度）。 */
export declare const GLICKO_INITIAL_RD = 350;
/** 对战记录（'arena-glicko-matches' 表）。 */
export interface GlickoMatch {
    readonly id: string;
    readonly ts: number;
    /** A 方模型。 */
    readonly a: string;
    /** B 方模型。 */
    readonly b: string;
    /** A 视角胜负：win/loss/draw。 */
    readonly outcome: 'win' | 'loss' | 'draw';
    readonly source: 'manual' | 'leaderboard';
}
/** 持久化评级记录（'arena-glicko-ratings' 表，键为模型名）。 */
export interface GlickoRatingRecord {
    readonly model: string;
    rating: number;
    rd: number;
    volatility: number;
    wins: number;
    losses: number;
    draws: number;
    /** 最近一次对战时间（闲置 RD 增长的起点）。 */
    lastPlayedAt: number;
}
/** 排行榜条目。 */
export interface GlickoRow {
    readonly model: string;
    readonly rating: number;
    /** 当前 RD（含闲置增长，惰性计算）。 */
    readonly rd: number;
    /** 95% 置信区间。 */
    readonly ci95: readonly [number, number];
    /** 保守分 = rating − 1.96×RD（排名依据）。 */
    readonly conservative: number;
    readonly games: number;
    readonly winRate: number;
    /** 距最近对战的闲置天数。 */
    readonly inactiveDays: number;
    readonly volatility: number;
    readonly rank: number;
}
/** 评级报告。 */
export interface GlickoReport {
    readonly matches: readonly GlickoMatch[];
    readonly standings: readonly GlickoRow[];
    readonly summary: string;
}
/**
 * 单场对战的 Glicko-2 更新（A 视角；B 对称调用）。
 * @param ratingA A 的评级三元组（rating/rd/volatility）。
 * @param ratingB B 的评级三元组。
 * @param score A 的得分（1/0.5/0）。
 * @returns A 的新评级三元组。
 */
export declare function glickoUpdate(ratingA: {
    rating: number;
    rd: number;
    volatility: number;
}, ratingB: {
    rating: number;
    rd: number;
    volatility: number;
}, score: number): {
    rating: number;
    rd: number;
    volatility: number;
};
/** RD 闲置增长：rd' = min(√(rd² + c²·t), 350)，t = 闲置的评级期数。 */
export declare function rdAfterInactivity(rd: number, inactiveDays: number): number;
/** Glicko-2 对战与评级仓库。 */
export declare class GlickoStore {
    private readonly matchTable;
    private readonly ratingTable;
    private counter;
    constructor(domain: Domain);
    /** 当前评级（无记录给初始空态）。 */
    private ratingOf;
    /** 记录一场对战并更新双方评级（含 B 视角对称更新）。 */
    recordMatch(a: string, b: string, outcome: 'win' | 'loss' | 'draw', source: GlickoMatch['source'], now?: number): Promise<void>;
    /** 完整报告：对战记录 + 保守分排名（RD 含闲置增长）。 */
    report(now?: number): GlickoReport;
    /** 清空全部对战与评级。 */
    reset(): Promise<void>;
}
