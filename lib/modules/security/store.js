import { beijingDayKey } from '../../core/time.js';
import { BUILTIN_DLP_RULES } from './dlp.js';
/** 审计日志滚动保留上限（条）。 */
export const AUDIT_LOG_LIMIT = 5_000;
/** 命名 Key 元数据仓库（J1）。 */
export class NamedKeyStore {
    table;
    constructor(domain) {
        this.table = domain.table('named-keys');
    }
    list() {
        return this.table
            .entries()
            .map(([, value]) => value)
            .sort((a, b) => a.createdAt - b.createdAt);
    }
    get(name) {
        return this.table.get(name);
    }
    async put(meta) {
        await this.table.put(meta.name, meta);
    }
    async delete(name) {
        await this.table.delete(name);
    }
}
/** 审计日志仓库（J2；滚动保留 AUDIT_LOG_LIMIT 条）。 */
export class AuditLogStore {
    table;
    counter = 0;
    constructor(domain) {
        this.table = domain.table('audit-log');
    }
    /** 追加一条日志（超出上限时删除最旧记录）。 */
    async append(entry) {
        await this.table.put(entry.id, entry);
        this.counter += 1;
        // 每 100 条触发一次滚动清理，摊薄开销。
        if (this.counter % 100 === 0)
            await this.trim();
    }
    /** 滚动清理：仅保留最新 AUDIT_LOG_LIMIT 条。 */
    async trim() {
        const all = this.list();
        if (all.length <= AUDIT_LOG_LIMIT)
            return;
        const overflow = all.slice(AUDIT_LOG_LIMIT);
        for (const entry of overflow) {
            await this.table.delete(entry.id);
        }
    }
    /** 全部日志（新→旧）。 */
    list() {
        return this.table
            .entries()
            .map(([, value]) => value)
            .sort((a, b) => b.ts - a.ts);
    }
    /** 按条件筛选。 */
    filter(options) {
        return this.list()
            .filter((entry) => {
            if (options.from !== undefined && entry.ts < options.from)
                return false;
            if (options.to !== undefined && entry.ts > options.to)
                return false;
            if (options.model && entry.model !== options.model)
                return false;
            if (options.status && entry.status !== options.status)
                return false;
            return true;
        })
            .slice(0, options.limit ?? 500);
    }
    /** 区间 [fromDay, toDay] 内的日志。 */
    range(fromDay, toDay) {
        return this.list().filter((entry) => {
            const day = beijingDayKey(entry.ts);
            return day >= fromDay && day <= toDay;
        });
    }
}
/** 生成审计条目 id。 */
export function auditId() {
    return `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
/** DLP 规则仓库（J3：内置 + 自定义合并）。 */
export class DlpRuleStore {
    table;
    /** 内置规则启用状态覆盖表（id → enabled）。 */
    builtinOverrides;
    constructor(domain) {
        this.table = domain.table('dlp-rules');
        this.builtinOverrides = domain.table('dlp-builtin-overrides');
    }
    /** 全部规则：内置（应用启用覆盖）+ 自定义。 */
    list() {
        const builtin = BUILTIN_DLP_RULES.map((rule) => ({
            ...rule,
            enabled: this.builtinOverrides.get(rule.id)?.enabled ?? true,
        }));
        const custom = this.table.entries().map(([, value]) => value);
        return [...builtin, ...custom];
    }
    /** 切换内置规则启用状态。 */
    async toggleBuiltin(id, enabled) {
        await this.builtinOverrides.put(id, { enabled });
    }
    async put(rule) {
        await this.table.put(rule.id, rule);
    }
    async delete(id) {
        await this.table.delete(id);
    }
}
/** DLP 设置仓库（J3）。 */
export class DlpSettingsStore {
    table;
    constructor(domain) {
        this.table = domain.table('dlp-settings');
    }
    get() {
        return this.table.get('main') ?? { enabled: true, strict: false };
    }
    async update(patch) {
        const current = this.get();
        const next = { ...current, ...patch };
        await this.table.put('main', next);
        return next;
    }
}
/** DLP 拦截统计仓库。 */
export class DlpBlockStore {
    table;
    constructor(domain) {
        this.table = domain.table('dlp-blocks-daily');
    }
    /** 记录一次拦截（按规则名计数）。 */
    async recordBlock(ts, ruleNames) {
        const day = beijingDayKey(ts);
        await this.table.update(day, (prev) => {
            const base = prev ?? { day, total: 0, byRule: {} };
            const byRule = { ...base.byRule };
            for (const name of ruleNames)
                byRule[name] = (byRule[name] ?? 0) + 1;
            return { day, total: base.total + 1, byRule };
        });
    }
    range(fromDay, toDay) {
        return this.table
            .entries()
            .map(([, value]) => value)
            .filter((row) => row.day >= fromDay && row.day <= toDay)
            .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    }
}
/** 异常告警仓库（J4）。 */
export class AuditAlertStore {
    table;
    counter = 0;
    constructor(domain) {
        this.table = domain.table('audit-alerts');
    }
    async push(alert) {
        this.counter += 1;
        await this.table.put(`${alert.ts}-${this.counter}`, alert);
    }
    range(fromDay, toDay) {
        return this.table
            .entries()
            .map(([, value]) => value)
            .filter((alert) => {
            const day = beijingDayKey(alert.ts);
            return day >= fromDay && day <= toDay;
        })
            .sort((a, b) => b.ts - a.ts);
    }
}
