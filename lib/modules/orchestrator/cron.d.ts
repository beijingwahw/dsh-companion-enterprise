/** Cron 单字段解析结果：允许的值集合。 */
interface CronField {
    readonly values: ReadonlySet<number>;
}
/** 解析后的 Cron 表达式。 */
export interface ParsedCron {
    readonly minute: CronField;
    readonly hour: CronField;
    readonly dayOfMonth: CronField;
    readonly month: CronField;
    readonly dayOfWeek: CronField;
    /** 日字段与周字段是否同时被显式指定（两者同时指定时按 OR 组合）。 */
    readonly dayOrWeek: boolean;
}
/** 解析 5 字段 Cron 表达式；非法时抛错。 */
export declare function parseCron(expression: string): ParsedCron;
/**
 * 计算下一次触发时刻（严格晚于 fromMs，分钟精度）。
 *
 * 字段跳跃算法：不逐分钟扫描，而是在月/日/时/分各层级直接跳到下一个候选
 * 时刻。迭代次数约为“天数 × 小常数”，对“每年仅触发一次”这类稀疏表达式
 * 也能在毫秒内给出结果（旧的逐分钟扫描最坏需迭代上百万次）。
 * 上限扫描 4 年；无解返回 undefined。
 */
export declare function nextCronFire(cron: ParsedCron, fromMs: number): number | undefined;
/**
 * 自然语言 → Cron 表达式（中文常见表达）；无法识别时抛错。
 * 支持：每天/每周X/每月X号 + 时刻；每隔 N 分钟/小时。
 */
export declare function naturalLanguageToCron(text: string): string;
export {};
