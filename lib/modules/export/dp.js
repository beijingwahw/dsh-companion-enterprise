/** 隐私预算记录键（'export-dp-budget' 表唯一键）。 */
const BUDGET_KEY = '__ledger__';
/** 缺省总预算 ε（相当于十几次 0.25ε 级发布的年吞吐）。 */
export const DEFAULT_EPSILON_BUDGET = 3;
/** 单次释放缺省 ε。 */
export const DEFAULT_RELEASE_EPSILON = 0.25;
/** ε 合法范围。 */
const MIN_EPSILON = 0.01;
const MAX_EPSILON = 2;
/** 单次释放指标条数上限。 */
const MAX_METRICS = 50;
// ---------------------------------------------------------------------------
// Laplace 机制（纯函数）
// ---------------------------------------------------------------------------
/**
 * Laplace(0, scale) 抽样：逆 CDF 变换。
 * scale ≤ 0 时返回 0（敏感度为 0 的统计无需加噪）。
 */
export function laplaceNoise(scale, rng = Math.random) {
    if (scale <= 0)
        return 0;
    const u = rng() - 0.5;
    return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}
/**
 * 单值 DP 释放：噪声尺度 b = 敏感度/ε；
 * count 类做取整与非负后处理（后处理免疫）。
 */
export function dpReleaseValue(value, sensitivity, epsilon, kind = 'count', rng = Math.random) {
    const scale = sensitivity / epsilon;
    const noise = laplaceNoise(scale, rng);
    const noisy = value + noise;
    const released = kind === 'count' ? Math.max(0, Math.round(noisy)) : Math.round(noisy * 10_000) / 10_000;
    return { released, noise, scale: Math.round(scale * 1e6) / 1e6 };
}
// ---------------------------------------------------------------------------
// 预算账本仓库
// ---------------------------------------------------------------------------
/** 差分隐私释放仓库（'export-dp-budget' 表）。 */
export class DpBudgetStore {
    now;
    table;
    constructor(domain, now = Date.now) {
        this.now = now;
        this.table = domain.table('export-dp-budget');
    }
    /** 当前账本（无记录给初始空态）。 */
    ledger() {
        return (this.table.get(BUDGET_KEY) ?? {
            kind: 'ledger',
            budgetEpsilon: DEFAULT_EPSILON_BUDGET,
            spentEpsilon: 0,
            releases: [],
            updatedAt: this.now(),
        });
    }
    /** 预算面板。 */
    state() {
        const record = this.ledger();
        return {
            budgetEpsilon: record.budgetEpsilon,
            spentEpsilon: Math.round(record.spentEpsilon * 1e6) / 1e6,
            remainingEpsilon: Math.round((record.budgetEpsilon - record.spentEpsilon) * 1e6) / 1e6,
            releaseCount: record.releases.length,
            lastReleaseAt: record.releases.length > 0 ? record.releases[record.releases.length - 1].ts : null,
            releases: record.releases.slice(-20).reverse(),
        };
    }
    /**
     * DP 释放：校验预算 → 逐指标 Laplace 加噪 → 账本记账。
     * 预算不足时返回拒绝（不产生任何释放、不消耗预算）。
     */
    async release(metrics, epsilon = DEFAULT_RELEASE_EPSILON, rng = Math.random) {
        if (metrics.length === 0) {
            return {
                refused: true,
                reason: '指标列表为空',
                requestedEpsilon: epsilon,
                spentEpsilon: 0,
                budgetEpsilon: this.ledger().budgetEpsilon,
                remainingEpsilon: this.ledger().budgetEpsilon,
            };
        }
        if (metrics.length > MAX_METRICS) {
            throw new Error(`单次释放不能超过 ${MAX_METRICS} 个指标`);
        }
        if (!Number.isFinite(epsilon) || epsilon < MIN_EPSILON || epsilon > MAX_EPSILON) {
            throw new Error(`ε 必须在 [${MIN_EPSILON}, ${MAX_EPSILON}] 内`);
        }
        for (const metric of metrics) {
            if (!Number.isFinite(metric.value))
                throw new Error(`指标 ${metric.key} 的值非法`);
            if (metric.sensitivity !== undefined && (!Number.isFinite(metric.sensitivity) || metric.sensitivity < 0)) {
                throw new Error(`指标 ${metric.key} 的敏感度非法`);
            }
        }
        const record = this.ledger();
        const remaining = record.budgetEpsilon - record.spentEpsilon;
        if (epsilon > remaining + 1e-9) {
            return {
                refused: true,
                reason: `隐私预算不足：剩余 ε=${remaining.toFixed(3)}，本次请求 ε=${epsilon.toFixed(3)}（顺序组合下总损失不可超预算——宁可拒绝，不可透支）`,
                requestedEpsilon: epsilon,
                spentEpsilon: Math.round(record.spentEpsilon * 1e6) / 1e6,
                budgetEpsilon: record.budgetEpsilon,
                remainingEpsilon: Math.round(remaining * 1e6) / 1e6,
            };
        }
        const released = metrics.map((metric) => {
            const sensitivity = metric.sensitivity ?? 1;
            const kind = metric.kind ?? 'count';
            const result = dpReleaseValue(metric.value, sensitivity, epsilon, kind, rng);
            return {
                key: metric.key,
                released: result.released,
                scale: result.scale,
                sensitivity,
            };
        });
        const ts = this.now();
        const releaseId = `dp_${ts.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
        const next = {
            kind: 'ledger',
            budgetEpsilon: record.budgetEpsilon,
            spentEpsilon: Math.round((record.spentEpsilon + epsilon) * 1e6) / 1e6,
            releases: [...record.releases, { id: releaseId, ts, epsilon, metrics: released.map((m) => m.key) }].slice(-200),
            updatedAt: ts,
        };
        await this.table.put(BUDGET_KEY, next);
        return {
            refused: false,
            releaseId,
            epsilon,
            metrics: released,
            spentEpsilon: next.spentEpsilon,
            budgetEpsilon: next.budgetEpsilon,
            remainingEpsilon: Math.round((next.budgetEpsilon - next.spentEpsilon) * 1e6) / 1e6,
            note: `本批 ${released.length} 个指标已按 ε=${epsilon} 加噪发布（Laplace 机制，顺序组合记账）；发布值可直接外发，真值不出域。`,
        };
    }
    /** 重置账本（可选新预算 ε；清空已消耗）。 */
    async reset(budgetEpsilon) {
        const next = budgetEpsilon !== undefined && Number.isFinite(budgetEpsilon) && budgetEpsilon >= MIN_EPSILON
            ? budgetEpsilon
            : this.ledger().budgetEpsilon;
        await this.table.put(BUDGET_KEY, {
            kind: 'ledger',
            budgetEpsilon: next,
            spentEpsilon: 0,
            releases: [],
            updatedAt: this.now(),
        });
    }
}
