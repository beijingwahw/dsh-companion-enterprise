/**
 * 模块 F：Prompt 工程工作台（prompt）插件入口。
 *
 * HTTP 端点（经 ctx.companion.http 挂载）：
 * F1 版本管理：GET/POST /prompt/versions、POST /prompt/rollback、POST /prompt/tags；
 * F2 A/B 测试：POST /prompt/ab-test（批量跑两个版本并对比指标）、
 *    POST /prompt/rate、GET /prompt/ratings；
 * F3 模板库：GET/POST/DELETE /prompt/templates、POST /prompt/render（变量插值）、
 *    POST /prompt/codegen（一键生成 Python/Node.js/curl 调用代码）；
 * F4 结构化校验：POST /prompt/validate（批量发送并按 JSON Schema 校验合规率）。
 *
 * 命令 `prompt`：查看当前 Prompt 版本历史。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 插件名。 */
export declare const name = "companion-prompt";
/** 依赖服务：companion 根服务、命令面板。 */
export declare const inject: string[];
/** 插件入口。 */
export declare function apply(ctx: Context): void;
