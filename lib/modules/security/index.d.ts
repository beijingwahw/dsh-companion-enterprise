/**
 * 模块 J：安全与审计（security）插件入口。
 *
 * 集成点：经 ctx.companion.addCallHook 注入调用钩子——
 * - beforeCall：DLP 扫描（严格模式直接拦截）+ 激活 Key 权限范围校验；
 * - afterCall：审计日志落盘（Prompt 摘要脱敏）+ 异常调用告警检测。
 *
 * HTTP 端点（经 ctx.companion.http 挂载）：
 * J1：GET/POST /security/keys、POST /security/keys/activate、
 *     DELETE /security/keys、POST /security/keys/leak-check（泄露检测）、
 *     GET /security/keys/rotation（轮换提醒）；
 * J2：GET /security/audit（筛选）、GET /security/audit/export（CSV/JSON）；
 * J3：GET /security/dlp/state、POST /security/dlp/settings、
 *     GET/POST/DELETE /security/dlp/rules、POST /security/dlp/scan（发送前预检）；
 * J4：GET /security/report（合规报表）、GET /security/report/export（HTML）。
 *
 * 安全红线：任何响应不回传 Key 明文（只回掩码尾 4 位）。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 插件名。 */
export declare const name = "companion-security";
/** 依赖服务：companion 根服务。 */
export declare const inject: string[];
/** 插件入口。 */
export declare function apply(ctx: Context): void;
