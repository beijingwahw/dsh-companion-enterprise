/**
 * 模块 E：执行轨迹分析器（trace）插件入口。
 *
 * HTTP 端点（经 ctx.companion.http 挂载）：
 * - GET    /trace/sessions        可分析的会话列表；
 * - GET    /trace/derive          从会话日志派生轨迹（含异常标注与汇总指标）；
 * - POST   /trace/ingest          摄入 Harness 原生轨迹 JSON 并持久化；
 * - GET    /trace/list            已保存轨迹列表；
 * - GET    /trace/get             读取单条轨迹（含异常与指标）；
 * - DELETE /trace                 删除已保存轨迹；
 * - POST   /trace/diff            两条轨迹对比（E3），可返回 HTML 对比报告；
 * - GET    /trace/stats           日聚合趋势 + 历史基准线（E4）。
 *
 * 命令 `trace`：分析指定会话（或最近会话）并输出文本报告。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 插件名。 */
export declare const name = "companion-trace";
/** 依赖服务：companion 根服务、会话查询、命令面板。 */
export declare const inject: string[];
/** 插件入口。 */
export declare function apply(ctx: Context): void;
