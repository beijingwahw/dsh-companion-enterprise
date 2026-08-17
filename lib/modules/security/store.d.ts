/**
 * 模块 J：安全与审计 —— 存储。
 *
 * 全部落在 companion 域：
 * - 'named-keys'：命名 Key 元数据（J1；明文只在保险库，此处仅元数据）；
 * - 'audit-log'：审计日志（J2；Prompt 摘要已脱敏，滚动保留上限）；
 * - 'dlp-rules' / 'dlp-settings'：DLP 自定义规则与设置（J3）；
 * - 'dlp-blocks-daily'：拦截次数日聚合（J4 报表）；
 * - 'audit-alerts'：异常调用告警（J4）。
 */
import type { Domain } from '../../core/storage-adapter.js';
import type { AuditAlert, AuditEntry, DlpRule, DlpSettings, NamedKeyMeta } from './types.js';
/** 审计日志滚动保留上限（条）。 */
export declare const AUDIT_LOG_LIMIT = 5000;
/** 命名 Key 元数据仓库（J1）。 */
export declare class NamedKeyStore {
    private readonly table;
    constructor(domain: Domain);
    list(): NamedKeyMeta[];
    get(name: string): NamedKeyMeta | undefined;
    put(meta: NamedKeyMeta): Promise<void>;
    delete(name: string): Promise<void>;
}
/** 审计日志仓库（J2；滚动保留 AUDIT_LOG_LIMIT 条）。 */
export declare class AuditLogStore {
    private readonly table;
    private counter;
    constructor(domain: Domain);
    /** 追加一条日志（超出上限时删除最旧记录）。 */
    append(entry: AuditEntry): Promise<void>;
    /** 滚动清理：仅保留最新 AUDIT_LOG_LIMIT 条。 */
    trim(): Promise<void>;
    /** 全部日志（新→旧）。 */
    list(): AuditEntry[];
    /** 按条件筛选。 */
    filter(options: {
        from?: number;
        to?: number;
        model?: string;
        status?: string;
        limit?: number;
    }): AuditEntry[];
    /** 区间 [fromDay, toDay] 内的日志。 */
    range(fromDay: string, toDay: string): AuditEntry[];
}
/** 生成审计条目 id。 */
export declare function auditId(): string;
/** DLP 规则仓库（J3：内置 + 自定义合并）。 */
export declare class DlpRuleStore {
    private readonly table;
    /** 内置规则启用状态覆盖表（id → enabled）。 */
    private readonly builtinOverrides;
    constructor(domain: Domain);
    /** 全部规则：内置（应用启用覆盖）+ 自定义。 */
    list(): DlpRule[];
    /** 切换内置规则启用状态。 */
    toggleBuiltin(id: string, enabled: boolean): Promise<void>;
    put(rule: DlpRule): Promise<void>;
    delete(id: string): Promise<void>;
}
/** DLP 设置仓库（J3）。 */
export declare class DlpSettingsStore {
    private readonly table;
    constructor(domain: Domain);
    get(): DlpSettings;
    update(patch: Partial<DlpSettings>): Promise<DlpSettings>;
}
/** DLP 拦截日聚合（J4 报表）。 */
export interface DlpDailyBlock {
    readonly day: string;
    total: number;
    byRule: Record<string, number>;
}
/** DLP 拦截统计仓库。 */
export declare class DlpBlockStore {
    private readonly table;
    constructor(domain: Domain);
    /** 记录一次拦截（按规则名计数）。 */
    recordBlock(ts: number, ruleNames: readonly string[]): Promise<void>;
    range(fromDay: string, toDay: string): DlpDailyBlock[];
}
/** 异常告警仓库（J4）。 */
export declare class AuditAlertStore {
    private readonly table;
    private counter;
    constructor(domain: Domain);
    push(alert: AuditAlert): Promise<void>;
    range(fromDay: string, toDay: string): AuditAlert[];
}
