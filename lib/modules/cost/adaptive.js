/** 观测滑动窗口容量：每个臂只统计最近 WINDOW 次调用的奖励。 */
export const WINDOW = 50;
/** 冷启动探索次数：每个臂至少被尝试该次数后才转入 UCB 利用。 */
export const MIN_PULLS = 2;
/** UCB1 探索系数（越大越倾向探索）。 */
export const UCB_C = 1.2;
/** 奖励合成权重。 */
const W_OK = 0.55;
const W_COST = 0.3;
const W_LATENCY = 0.15;
/**
 * 合成一次观测的奖励 ∈ [0, 1]：
 * 成功记 1；成本得分 = 最低价 / 本模型价（越便宜越接近 1）；
 * 时延得分 = 1 − latency/apiTimeout（越快越接近 1）。
 */
export function computeReward(observation, apiTimeoutMs) {
    const okScore = observation.ok ? 1 : 0;
    const costScore = observation.modelPrice > 0
        ? Math.min(1, observation.cheapestPrice / observation.modelPrice)
        : 1;
    const latencyScore = Math.max(0, 1 - observation.latencyMs / Math.max(1, apiTimeoutMs));
    return W_OK * okScore + W_COST * costScore + W_LATENCY * latencyScore;
}
/** 空臂构造。 */
function newArm(model) {
    return { model, pulls: 0, rewards: [], latencySum: 0, costSum: 0, failures: 0 };
}
/** 窗口均值。 */
function meanReward(arm) {
    if (arm.rewards.length === 0)
        return 0;
    let sum = 0;
    for (const reward of arm.rewards)
        sum += reward;
    return sum / arm.rewards.length;
}
/** UCB1 置信上界（窗口均值 + 探索项）。 */
function ucbOf(arm, totalPulls) {
    if (arm.pulls === 0)
        return Number.POSITIVE_INFINITY;
    return meanReward(arm) + UCB_C * Math.sqrt(Math.log(Math.max(1, totalPulls)) / arm.pulls);
}
/**
 * 自适应路由器：内存状态 + cost-bandit 表持久化。
 * 表读写失败静默降级（退化为本次会话内学习，重启后重新积累）。
 */
export class AdaptiveRouter {
    ctx;
    states = new Map();
    domains = new Map();
    restored = false;
    constructor(ctx) {
        this.ctx = ctx;
    }
    /**
     * 选择模型：未探索的臂优先（冷启动），否则取 UCB1 最大者。
     * @param cls 任务难度类别。
     * @param candidates 候选模型列表（去重后使用）。
     */
    async select(cls, candidates) {
        await this.ensureRestored();
        const state = this.stateOf(cls);
        const unique = [...new Set(candidates.map((model) => model.trim()).filter(Boolean))];
        if (unique.length === 0)
            throw new Error('adaptive routing: no candidate models');
        // 同步候选集：新增缺失臂、剔除已不在候选集内的陈旧臂。
        state.arms = state.arms.filter((arm) => unique.includes(arm.model));
        for (const model of unique) {
            if (!state.arms.some((arm) => arm.model === model))
                state.arms.push(newArm(model));
        }
        // 冷启动：每个臂至少 MIN_PULLS 次探索（最少拉臂者优先，平手取序列首个）。
        const cold = state.arms.filter((arm) => arm.pulls < MIN_PULLS);
        if (cold.length > 0) {
            cold.sort((a, b) => a.pulls - b.pulls);
            return { model: cold[0].model, mode: 'explore' };
        }
        let best = state.arms[0];
        let bestUcb = -Number.POSITIVE_INFINITY;
        for (const arm of state.arms) {
            const ucb = ucbOf(arm, state.totalPulls);
            if (ucb > bestUcb) {
                bestUcb = ucb;
                best = arm;
            }
        }
        return { model: best.model, mode: 'exploit' };
    }
    /**
     * 记录一次观测（best-effort：持久化失败不影响调用主流程）。
     */
    async observe(cls, model, reward, latencyMs, costCny) {
        await this.ensureRestored();
        const state = this.stateOf(cls);
        const arm = state.arms.find((entry) => entry.model === model);
        if (!arm)
            return;
        arm.pulls += 1;
        arm.rewards.push(Math.max(0, Math.min(1, reward)));
        if (arm.rewards.length > WINDOW)
            arm.rewards.shift();
        arm.latencySum += Math.max(0, latencyMs);
        arm.costSum += Math.max(0, costCny);
        if (reward < W_OK)
            arm.failures += 1;
        arm.lastUsedAt = Date.now();
        state.totalPulls += 1;
        await this.persist(cls);
    }
    /** 全部类别的面板报表。 */
    async report() {
        await this.ensureRestored();
        const build = (cls) => {
            const state = this.stateOf(cls);
            return [...state.arms]
                .map((arm) => ({
                model: arm.model,
                pulls: arm.pulls,
                meanReward: round3(meanReward(arm)),
                avgLatencyMs: Math.round(arm.latencySum / Math.max(1, arm.pulls)),
                avgCostCny: round4(arm.costSum / Math.max(1, arm.pulls)),
                failureRate: round3(arm.failures / Math.max(1, arm.pulls)),
                ucb: arm.pulls === 0 ? Number.POSITIVE_INFINITY : round3(ucbOf(arm, state.totalPulls)),
                lastUsedAt: arm.lastUsedAt,
            }))
                .sort((a, b) => b.meanReward - a.meanReward);
        };
        return { simple: build('simple'), complex: build('complex') };
    }
    /** 清空指定类别（缺省全部）的学习状态。 */
    async reset(cls) {
        await this.ensureRestored();
        const targets = cls ? [cls] : ['simple', 'complex'];
        for (const target of targets) {
            this.states.set(target, { arms: [], totalPulls: 0 });
            await this.persist(target);
        }
    }
    /** 取（或构造）类别状态。 */
    stateOf(cls) {
        let state = this.states.get(cls);
        if (!state) {
            state = { arms: [], totalPulls: 0 };
            this.states.set(cls, state);
        }
        return state;
    }
    /** 一次性从 cost-bandit 表恢复两类状态。 */
    async ensureRestored() {
        if (this.restored)
            return;
        this.restored = true;
        try {
            const { domain } = await this.ctx.companion.ready;
            const table = domain.table('cost-bandit');
            for (const cls of ['simple', 'complex']) {
                const stored = table.get(cls);
                if (stored && Array.isArray(stored.arms))
                    this.states.set(cls, stored);
            }
        }
        catch {
            // 存储域未就绪：保持空状态，后续观测照常（仅丢失重启延续）。
        }
    }
    /** 持久化单类别状态（失败静默）。 */
    async persist(cls) {
        try {
            const { domain } = await this.ctx.companion.ready;
            await domain.table('cost-bandit').put(cls, this.stateOf(cls));
        }
        catch {
            // best-effort：写盘失败不影响内存学习。
        }
    }
}
/** 保留三位小数。 */
function round3(value) {
    return Math.round(value * 1000) / 1000;
}
/** 保留四位小数。 */
function round4(value) {
    return Math.round(value * 10000) / 10000;
}
