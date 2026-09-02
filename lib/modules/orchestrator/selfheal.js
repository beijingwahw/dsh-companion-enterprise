/**
 * 错误分类：从错误消息识别错误类别。
 * 分类决定重试策略——不可重试的错误立即失败，是对配额的最大节约。
 */
export function classifyError(message) {
    const text = message.toLowerCase();
    // 鉴权/权限：重试必然同样失败。
    if (/(^|\D)(401|403)(\D|$)/.test(text) || /unauthorized|forbidden|api.?key|鉴权|认证失败|无权/.test(text)) {
        return 'non-retryable';
    }
    // 预算/配额/欠费：换模型或充值才能解决。
    if (/(^|\D)402(\D|$)/.test(text) || /余额|配额|欠费|insufficient|quota|budget|预算/.test(text)) {
        return 'non-retryable';
    }
    // 参数/模型不存在：请求本身有错。
    if (/(^|\D)400(\D|$)/.test(text) || /bad.?request|参数错误|invalid.?request|model.*not.*(exist|found|available)|unknown.?model|模型不存在/.test(text)) {
        return 'non-retryable';
    }
    // 内容安全策略。
    if (/content.?(policy|filter)|敏感|违规|安全策略/.test(text)) {
        return 'non-retryable';
    }
    // 限流：需要长退避。
    if (/(^|\D)429(\D|$)/.test(text) || /rate.?limit|too.?many.?requests|限流|请求过于频繁/.test(text)) {
        return 'rate-limit';
    }
    // 超时。
    if (/超时|timeout|timed?.?out|aborted?/.test(text)) {
        return 'timeout';
    }
    // 网络/5xx/未知：按瞬态处理（可重试）。
    return 'transient';
}
/**
 * 指数退避 + 全抖动（full jitter）：delay ~ U(0, min(cap, base·2^(attempt-1)))。
 * 抖动把并发重试的到达时刻随机打散，是治理重试风暴的关键。
 */
export function backoffDelay(attempt, baseMs, capMs) {
    const ceiling = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
    return Math.max(250, Math.floor(Math.random() * ceiling));
}
/**
 * 每模型断路器。
 *
 * - closed：正常放行；连续失败达阈值 → open；
 * - open：拒绝放行；冷却期满后转为 half-open；
 * - half-open：只放行一个探针调用，成功 → 删除条目（回到 closed），
 *   失败 → 重新 open（冷却重新计时）。
 */
export class CircuitBreaker {
    failureThreshold;
    cooldownMs;
    entries = new Map();
    constructor(failureThreshold = 5, cooldownMs = 60_000) {
        this.failureThreshold = failureThreshold;
        this.cooldownMs = cooldownMs;
    }
    entryOf(model) {
        let entry = this.entries.get(model);
        if (!entry) {
            entry = { failures: 0, state: 'closed', openedAt: 0, probing: false };
            this.entries.set(model, entry);
        }
        return entry;
    }
    /**
     * 纯查询：当前是否"可以"通过（无副作用）。
     * 调度器筛选可用任务/步骤时使用；真正发起调用前必须再调 admit()。
     */
    peek(model) {
        const entry = this.entries.get(model);
        if (!entry)
            return true;
        if (entry.state === 'closed')
            return true;
        if (entry.state === 'open')
            return Date.now() - entry.openedAt >= this.cooldownMs;
        // half-open：探针未在途才可放行。
        return !entry.probing;
    }
    /**
     * 带副作用准入：真正发起调用前抢占通行资格。
     * - closed：直接放行；
     * - open 且冷却期满：转入 half-open 并以探针身份放行（每模型同时仅一个）；
     * - open 未满冷却 / half-open 探针在途：拒绝。
     */
    admit(model) {
        const entry = this.entryOf(model);
        if (entry.state === 'closed')
            return true;
        if (entry.state === 'open') {
            if (Date.now() - entry.openedAt < this.cooldownMs)
                return false;
            entry.state = 'half-open';
            entry.probing = true;
            return true;
        }
        if (entry.probing)
            return false;
        entry.probing = true;
        return true;
    }
    /** 调用成功：完全恢复（删除条目回到 closed）。 */
    recordSuccess(model) {
        this.entries.delete(model);
    }
    /** 调用失败：按当前状态推进（半开探针失败 → 重新熔断）。 */
    recordFailure(model) {
        const entry = this.entryOf(model);
        if (entry.state === 'half-open') {
            entry.state = 'open';
            entry.openedAt = Date.now();
            entry.probing = false;
            return;
        }
        entry.failures += 1;
        if (entry.failures >= this.failureThreshold) {
            entry.state = 'open';
            entry.openedAt = Date.now();
            entry.probing = false;
        }
    }
    /** 当前状态。 */
    state(model) {
        return this.entries.get(model)?.state ?? 'closed';
    }
    /** 全部模型的断路器快照（监控端点用）。 */
    snapshot() {
        const rows = [];
        for (const [model, entry] of this.entries) {
            rows.push({
                model,
                state: entry.state,
                failures: entry.failures,
                openedAt: entry.openedAt,
                probeAt: entry.openedAt + this.cooldownMs,
            });
        }
        return rows.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
    }
}
/** 步骤的可执行模型准入：主模型与降级模型都被熔断时才扣住步骤。 */
export function stepModelPeek(breaker, step) {
    if (breaker.peek(step.model))
        return true;
    return step.fallbackModel !== '' && breaker.peek(step.fallbackModel);
}
