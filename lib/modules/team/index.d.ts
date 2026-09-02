/**
 * 模块 I：协作与知识管理（team）插件入口。
 *
 * HTTP 端点（经 ctx.companion.http 挂载，/companion 前缀由路由器处理）：
 * I1 团队配置同步：GET/POST /team/prefs、GET /team/config/export、
 *     POST /team/config/diff、POST /team/config/import（local/remote/manual 三种合并策略）、
 *     GET/DELETE /team/snapshots（最近导入快照归档）；
 * I2 执行经验库：GET/POST/DELETE /team/experience、POST /team/experience/notes、
 *     POST /team/experience/recommend（有效性加权排序）、POST /team/experience/
 *     feedback（注入反馈回填）、GET /team/effectiveness（有效性报告）、
 *     POST /team/effectiveness/sweep（组织性遗忘）；
 * I3 Prompt 协作评审：GET/POST/DELETE /team/reviews、GET /team/reviews/get、
 *     POST /team/reviews/comment、POST /team/reviews/decide、POST /team/reviews/merge；
 * I4 专家路由：GET/POST/DELETE /team/experts、GET /team/experts/profiles（知识足迹
 *     画像）、POST /team/experts/route（余弦匹配推荐 + 知识盲区）；
 * I5 Bus Factor：GET /team/busfactor（领域覆盖单点风险 + PageRank 协作枢纽
 *     + 孤立专家检测）。
 *
 * costSettings 分区导入时一律跳过（需经成本模块界面配置）；
 * pricingOverrides 导入后落 'cost-extra' 表并同步动态计价引擎。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 插件名。 */
export declare const name = "companion-team";
/** 依赖服务：companion 根服务 + 会话查询（经验蒸馏读轨迹）。 */
export declare const inject: string[];
/** 插件入口。 */
export declare function apply(ctx: Context): void;
