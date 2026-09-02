/** Elo 初始分。 */
export const ELO_INITIAL = 1500;
/** K 因子阶梯（场次 → K）。 */
const K_TIERS = [
    { minGames: 30, k: 16 },
    { minGames: 10, k: 24 },
    { minGames: 0, k: 32 },
];
/** Wilson 置信 z 值（95%）。 */
const WILSON_Z = 1.96;
/** 评级历史每模型保留快照数。 */
const HISTORY_LIMIT = 50;
/** K 因子：按该模型已赛场次取阶梯值。 */
function kFactor(games) {
    for (const tier of K_TIERS) {
        if (games >= tier.minGames)
            return tier.k;
    }
    return K_TIERS[K_TIERS.length - 1].k;
}
/** 期望胜率。 */
function expectedScore(ratingA, ratingB) {
    return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}
/**
 * Wilson 评分区间下界（胜率的保守估计）。
 * z=1.96（95% 置信）；零场次返回 0。
 */
export function wilsonLowerBound(wins, games) {
    if (games === 0)
        return 0;
    const p = wins / games;
    const z2 = WILSON_Z * WILSON_Z;
    const denominator = 1 + z2 / games;
    const center = p + z2 / (2 * games);
    const margin = WILSON_Z * Math.sqrt((p * (1 - p) + z2 / (4 * games)) / games);
    return Math.max(0, (center - margin) / denominator);
}
/**
 * 对战仓库 + 评级引擎（arena-elo-matches / arena-elo-ratings 两张表）。
 */
export class EloStore {
    matchTable;
    ratingTable;
    matchCounter = 0;
    constructor(domain) {
        this.matchTable = domain.table('arena-elo-matches');
        this.ratingTable = domain.table('arena-elo-ratings');
    }
    /**
     * 记录一场对战并更新双方评级。
     * @param a 模型 A。
     * @param b 模型 B。
     * @param outcome A 的视角：'win' | 'loss' | 'draw'。
     * @param source 对战来源。
     */
    async recordMatch(a, b, outcome, source) {
        if (a === b)
            throw new Error('elo: 不能与自己对战');
        const ts = Date.now();
        this.matchCounter += 1;
        const match = {
            id: `m-${ts}-${this.matchCounter}`,
            ts,
            winner: outcome === 'win' ? a : outcome === 'loss' ? b : null,
            loser: outcome === 'win' ? b : outcome === 'loss' ? a : null,
            draw: outcome === 'draw' ? [a, b] : null,
            source,
        };
        await this.matchTable.put(match.id, match);
        // 评级更新（读改写）。
        const ratingA = this.ratingOf(a);
        const ratingB = this.ratingOf(b);
        const gamesA = ratingA.wins + ratingA.losses + ratingA.draws;
        const gamesB = ratingB.wins + ratingB.losses + ratingB.draws;
        const kA = kFactor(gamesA);
        const kB = kFactor(gamesB);
        const scoreA = outcome === 'win' ? 1 : outcome === 'draw' ? 0.5 : 0;
        const scoreB = 1 - scoreA;
        const expectedA = expectedScore(ratingA.rating, ratingB.rating);
        const expectedB = 1 - expectedA;
        const deltaA = Math.round(kA * (scoreA - expectedA));
        const deltaB = Math.round(kB * (scoreB - expectedB));
        await this.ratingTable.put(a, {
            model: a,
            rating: ratingA.rating + deltaA,
            wins: ratingA.wins + (outcome === 'win' ? 1 : 0),
            losses: ratingA.losses + (outcome === 'loss' ? 1 : 0),
            draws: ratingA.draws + (outcome === 'draw' ? 1 : 0),
            lastDelta: deltaA,
            history: [...ratingA.history, ratingA.rating + deltaA].slice(-HISTORY_LIMIT),
        });
        await this.ratingTable.put(b, {
            model: b,
            rating: ratingB.rating + deltaB,
            // B 的视角：A 胜即 B 负，A 负即 B 胜，平局各计半场。
            wins: ratingB.wins + (outcome === 'loss' ? 1 : 0),
            losses: ratingB.losses + (outcome === 'win' ? 1 : 0),
            draws: ratingB.draws + (outcome === 'draw' ? 1 : 0),
            lastDelta: deltaB,
            history: [...ratingB.history, ratingB.rating + deltaB].slice(-HISTORY_LIMIT),
        });
    }
    /** 指定模型的当前评级（无记录时给初始空态）。 */
    ratingOf(model) {
        return this.ratingTable.get(model) ?? emptyRating(model);
    }
    /** 完整报告：对战记录 + Wilson 下界排名 + 评级演化。 */
    report() {
        const matches = this.matchTable
            .entries()
            .map(([, value]) => value)
            .sort((x, y) => y.ts - x.ts)
            .slice(0, 100);
        const records = this.ratingTable.entries().map(([, value]) => value);
        const baseRows = records.map((record) => {
            const games = record.wins + record.losses + record.draws;
            const wins = record.wins + record.draws * 0.5;
            return {
                model: record.model,
                rating: Math.round(record.rating),
                games,
                wins: record.wins,
                losses: record.losses,
                draws: record.draws,
                winRate: games > 0 ? Math.round((wins / games) * 100) / 100 : 0,
                wilsonLower: Math.round(wilsonLowerBound(wins, games) * 1000) / 1000,
                lastDelta: record.lastDelta,
            };
        });
        // 保守排名：Wilson 下界降序；下界相同按点估计。
        baseRows.sort((x, y) => y.wilsonLower - x.wilsonLower || y.rating - x.rating);
        const rows = baseRows.map((row, index) => ({ ...row, rank: index + 1 }));
        const history = {};
        for (const record of records)
            history[record.model] = record.history;
        return { matches, standings: rows, history };
    }
    /** 清空全部对战与评级。 */
    async reset() {
        for (const [key] of this.matchTable.entries())
            await this.matchTable.delete(key);
        for (const [key] of this.ratingTable.entries())
            await this.ratingTable.delete(key);
    }
}
/** 初始空评级。 */
function emptyRating(model) {
    return { model, rating: ELO_INITIAL, wins: 0, losses: 0, draws: 0, lastDelta: 0, history: [] };
}
