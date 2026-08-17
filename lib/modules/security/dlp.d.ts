/**
 * 模块 J3：数据防泄漏（DLP）扫描器与脱敏工具。
 *
 * - 内置规则：硬编码密钥/密码、数据库连接串、手机号、邮箱、身份证号、
 *   常见 API Key 形态；用户可追加自定义正则规则；
 * - scan：返回命中（片段掩码展示）；redact：将命中替换为占位符；
 * - 脱敏用于审计日志落盘（J2）与报表，确保敏感内容不以明文留存。
 */
import type { DlpFinding, DlpRule } from './types.js';
/** 内置 DLP 规则（不可删除，可禁用）。 */
export declare const BUILTIN_DLP_RULES: readonly Omit<DlpRule, 'enabled'>[];
/** 掩码：保留前 2 与后 2 字符，中间以 *** 代替；过短则全部掩码。 */
export declare function maskSample(text: string): string;
/** 扫描文本，返回全部命中（片段已掩码）。 */
export declare function scanText(text: string, rules: readonly DlpRule[]): DlpFinding[];
/** 脱敏：将命中片段替换为 [已脱敏:规则名]。 */
export declare function redactText(text: string, rules: readonly DlpRule[]): string;
/** 校验自定义正则是否可编译。 */
export declare function validatePattern(pattern: string): string | undefined;
