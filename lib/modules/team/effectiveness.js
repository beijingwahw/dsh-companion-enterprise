// --------------------------------------------------------------------
// 参数（领域直觉缺省值，均可被报告函数调用方覆盖）
// --------------------------------------------------------------------
/** 反馈证据半衰期（天）：45 天前的反馈权重减半。 */
export const FEEDBACK_HALF_LIFE_DAYS = 45;
/** 新鲜度半衰期（天）：90 天未使用，freshness 减半。 */
export const FRESHNESS_HALF_LIFE_DAYS = 90;
/** Beta 先验（α=1, β=1）：无反馈时评分收敛于 0.5（不偏不倚）。 */
const PRIOR_ALPHA = 1;
const PRIOR_BETA = 1;
/** neutral 证据计入分母的折算系数（既不助益也不抹黑）。 */
const NEUTRAL_DISCOUNT = 0.5;
/** proven 判定：评分下限 + helped 证据下限（双双达标才转正）。 */
const PROVEN_MIN_SCORE = 0.7;
const PROVEN_MIN_HELPED_WEIGHT = 2;
/** harmful 判定：评分上限 + hurt 证据下限。 */
const HARMFUL_MAX_SCORE = 0.35;
const HARMFUL_MIN_HURT_WEIGHT = 1.5;
/** stale 判定：freshness 低于该阈值。 */
const STALE_FRESHNESS = 0.25;
/** 单卡事件保留上限（截旧留新）。 */
const EVENTS_PER_CARD_CAP = 100;
/** 一天毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000;
// --------------------------------------------------------------------
// 纯函数：衰减与评分
// --------------------------------------------------------------------
/** 指数半衰期衰减权重（0-1；age 为毫秒）。 */
function decayWeight(ageMs, halfLifeDays) {
    if (ageMs <= 0)
        return 1;
    return Math.pow(2, -ageMs / (halfLifeDays * DAY_MS));
}
/** 汇总单卡反馈序列为有效性画像（纯函数，便于测试与复算）。 */
export function assessCard(card, events, now = Date.now()) {
    let helpedWeight = 0;
    let hurtWeight = 0;
    let neutralWeight = 0;
    let lastUsedAt = 0;
    for (const event of events) {
        const weight = decayWeight(now - event.ts, FEEDBACK_HALF_LIFE_DAYS);
        if (event.outcome === 'helped')
            helpedWeight += weight;
        else if (event.outcome === 'hurt')
            hurtWeight += weight;
        else
            neutralWeight += weight;
        if (event.ts > lastUsedAt)
            lastUsedAt = event.ts;
    }
    // 贝叶斯收缩：先验 + 加权证据。
    const denominator = PRIOR_ALPHA + PRIOR_BETA + helpedWeight + hurtWeight + neutralWeight * NEUTRAL_DISCOUNT;
    const score = (PRIOR_ALPHA + helpedWeight) / denominator;
    // 新鲜度锚点：最近一次注入反馈，否则退回卡片最近更新时间。
    const anchor = lastUsedAt > 0 ? lastUsedAt : card.updatedAt;
    const freshness = decayWeight(Math.max(0, now - anchor), FRESHNESS_HALF_LIFE_DAYS);
    const r4 = (value) => Math.round(value * 10_000) / 10_000;
    const base = {
        cardId: card.id,
        title: card.title,
        injectedCount: events.length,
        helpedWeight: r4(helpedWeight),
        hurtWeight: r4(hurtWeight),
        score: r4(score),
        freshness: r4(freshness),
        lastUsedAt,
    };
    if (events.length === 0) {
        return { ...base, status: 'unproven', advice: '尚无注入反馈，推荐时保持中性权重' };
    }
    if (score <= HARMFUL_MAX_SCORE && hurtWeight >= HARMFUL_MIN_HURT_WEIGHT) {
        return {
            ...base,
            status: 'harmful',
            advice: '近期负面反馈占优，建议复核内容或直接归档（sweep harmful）',
        };
    }
    if (score >= PROVEN_MIN_SCORE && helpedWeight >= PROVEN_MIN_HELPED_WEIGHT) {
        return { ...base, status: 'proven', advice: '多次被验证有效，推荐排序加权浮现' };
    }
    if (freshness <= STALE_FRESHNESS) {
        return {
            ...base,
            status: 'stale',
            advice: '久未使用，知识可能已过时；确认后可归档（sweep stale）',
        };
    }
    return { ...base, status: 'active', advice: '反馈正常，保持现状追踪' };
}
/** 推荐排序的有效性系数（proven 浮现、harmful 沉底）。 */
export function effectivenessWeight(status) {
    switch (status) {
        case 'proven':
            return 1.5;
        case 'harmful':
            return 0.3;
        case 'stale':
            return 0.7;
        case 'unproven':
            return 0.9;
        default:
            return 1;
    }
}
// --------------------------------------------------------------------
// 存储
// --------------------------------------------------------------------
/** 注入反馈仓库（'experience-feedback' 表）。 */
export class EffectivenessStore {
    table;
    constructor(domain) {
        this.table = domain.table('experience-feedback');
    }
    /** 记录一次注入反馈（追加事件，截尾保留上限）。 */
    async record(cardId, outcome, note) {
        const previous = this.table.get(cardId);
        const event = {
            cardId,
            ts: Date.now(),
            outcome,
            ...(note !== undefined && note.length > 0 ? { note } : {}),
        };
        const events = [...(previous?.events ?? []), event].slice(-EVENTS_PER_CARD_CAP);
        const next = { cardId, events };
        await this.table.put(cardId, next);
        return next;
    }
    /** 单卡事件序列（旧→新；无记录返回空数组）。 */
    eventsOf(cardId) {
        return this.table.get(cardId)?.events ?? [];
    }
    /** 全库有效性报告。 */
    buildReport(cards, now = Date.now()) {
        const assessed = cards.map((card) => assessCard(card, this.eventsOf(card.id), now));
        assessed.sort((a, b) => b.score - a.score || b.injectedCount - a.injectedCount);
        const statusCounts = {
            proven: 0,
            active: 0,
            unproven: 0,
            stale: 0,
            harmful: 0,
        };
        for (const item of assessed)
            statusCounts[item.status] += 1;
        // 组织性遗忘候选：harmful，或（stale 且评分平庸）。
        const retireCandidates = assessed.filter((item) => item.status === 'harmful' || (item.status === 'stale' && item.score < 0.5));
        return {
            generatedAt: now,
            cardCount: cards.length,
            withFeedback: assessed.filter((item) => item.injectedCount > 0).length,
            statusCounts,
            cards: assessed,
            retireCandidates,
        };
    }
}
