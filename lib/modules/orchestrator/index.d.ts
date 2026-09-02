/**
 * 模块 H：断点续跑与任务编排（orchestrator）插件入口。
 *
 * HTTP 端点（经 ctx.companion.http 挂载）：
 * H1 流水线：GET/POST /orchestrator/pipelines、DELETE /orchestrator/pipelines、
 *    GET /orchestrator/pipelines/yaml（自动生成 YAML 配置）；
 * H2 执行与断点续跑：POST /orchestrator/runs（启动）、POST /orchestrator/runs/resume
 *    （从最后成功步骤继续）、POST /orchestrator/runs/pause、/cancel、
 *    GET /orchestrator/runs、GET /orchestrator/runs/get、DELETE /orchestrator/runs；
 * H3 批量队列：GET/POST /orchestrator/queue、POST /orchestrator/queue/cancel、
 *    /pause、/resume、DELETE /orchestrator/queue、GET /orchestrator/queue/counts；
 * H4 定时调度：GET/POST /orchestrator/jobs、DELETE /orchestrator/jobs、
 *    GET /orchestrator/jobs/runs、POST /orchestrator/parse-schedule（自然语言 → Cron）；
 * 自愈执行：GET /orchestrator/circuits（模型断路器全景：closed/open/half-open）；
 * DAG 规划：POST /orchestrator/dag（拓扑分层 + 关键路径 + 优化建议）；
 * 蒙特卡洛模拟：POST /orchestrator/monte（PERT 三点估算 + P50/P90 工期置信区间
 *    + 步骤关键性指数，iterations/parallelism 可选）；
 * 关键路径分析：POST /orchestrator/cpm（CPM ES/EF/LS/LF/松弛 + 并发峰值画像
 *    + 并行化收益 + 瓶颈步骤，durationOverrides 可选）。
 *
 * 命令 `tasks`：查看队列与定时任务概览。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 插件名。 */
export declare const name = "companion-orchestrator";
/** 依赖服务：companion 根服务、命令面板。 */
export declare const inject: string[];
/** 插件入口。 */
export declare function apply(ctx: Context): void;
