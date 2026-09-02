/** 风险分半衰期（毫秒，24 小时）。 */
export const RISK_HALF_LIFE_MS = 24 * 3_600_000;
/** 画像滚动保留的最近事件数。 */
export const EVENT_LIMIT = 20;
/** watch 阈值。 */
export const WATCH_THRESHOLD = 40;
/** quarantined 阈值。 */
export const QUARANTINE_THRESHOLD = 70;
/** 衰减：按经过时间折算历史分。 */
function decay(score, elapsedMs) {
    if (score <= 0 || elapsedMs <= 0)
        return score;
    return score * Math.pow(0.5, elapsedMs / RISK_HALF_LIFE_MS);
}
/** 由当前分值判定等级。 */
export function levelOf(score) {
    if (score >= QUARANTINE_THRESHOLD)
        return 'quarantined';
    if (score >= WATCH_THRESHOLD)
        return 'watch';
    return 'normal';
}
/** 降到下一等级需要经过的小时数（衰减推演）。 */
function hoursToDowngrade(score) {
    const target = levelOf(score) === 'quarantined' ? WATCH_THRESHOLD : levelOf(score) === 'watch' ? 0 : null;
    if (target === null || score <= target)
        return null;
    // score * 0.5^(h/24) = target → h = 24 * log2(score/target)
    return Math.round((24 * Math.log2(score / target)) * 10) / 10;
}
/**
 * 哨兵画像仓库（sentinel-profiles 表，key = source）。
 */
export class SentinelStore {
    table;
    constructor(domain) {
        this.table = domain.table('sentinel-profiles');
    }
    /** 记录一次注入命中事件（指数衰减累积 + 滚动事件）。 */
    async record(source, event) {
        const now = event.ts;
        const prev = this.table.get(source);
        const prevScore = prev ? decay(prev.score, now - prev.lastSeenAt) : 0;
        const next = {
            source,
            score: prevScore + event.risk,
            firstSeenAt: prev?.firstSeenAt ?? now,
            lastSeenAt: now,
            totalEvents: (prev?.totalEvents ?? 0) + 1,
            maliciousCount: (prev?.maliciousCount ?? 0) + (event.verdict === 'malicious' ? 1 : 0),
            events: [event, ...(prev?.events ?? [])].slice(0, EVENT_LIMIT),
        };
        await this.table.put(source, next);
        return this.toReport(next);
    }
    /** 读取画像（含实时衰减后的等级）。 */
    get(source) {
        const profile = this.table.get(source);
        if (!profile)
            return undefined;
        // 实时衰减：查询时的等效分。
        const score = decay(profile.score, Date.now() - profile.lastSeenAt);
        return this.toReport({ ...profile, score });
    }
    /** 全部画像（新→旧）。 */
    list() {
        return this.table
            .entries()
            .map(([, value]) => value)
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
            .map((profile) => {
            const score = decay(profile.score, Date.now() - profile.lastSeenAt);
            return this.toReport({ ...profile, score });
        });
    }
    /** 重置指定画像或全部画像（误报平反）。 */
    async reset(source) {
        if (source !== undefined) {
            await this.table.delete(source);
            return;
        }
        for (const [key] of this.table.entries()) {
            await this.table.delete(key);
        }
    }
    /** 画像 → 报表（等级 + 展示分 + 降级倒计时）。 */
    toReport(profile) {
        return {
            ...profile,
            level: levelOf(profile.score),
            displayScore: Math.min(100, Math.round(profile.score)),
            hoursToDowngrade: hoursToDowngrade(profile.score),
        };
    }
}
/**
 * 哨兵防御决策：给定画像等级与本次扫描判定，决定是否强制拦截。
 *
 * 规则（在 injection 设置的严格模式之外叠加）：
 * - quarantined：任何非 clean 输入一票否决（403）；
 * - watch：suspicious 及以上拦截；
 * - normal：维持既有策略（仅严格模式 malicious 拦截）。
 */
export function sentinelShouldBlock(level, verdict) {
    if (verdict === 'clean')
        return false;
    if (level === 'quarantined')
        return true;
    if (level === 'watch')
        return verdict === 'suspicious' || verdict === 'malicious';
    return false;
}
