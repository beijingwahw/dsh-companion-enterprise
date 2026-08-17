/**
 * 模块 I：协作与知识管理（team）插件入口。
 *
 * HTTP 端点（经 ctx.companion.http 挂载，/companion 前缀由路由器处理）：
 * I1 团队配置同步：GET/POST /team/prefs、GET /team/config/export、
 *     POST /team/config/diff、POST /team/config/import（local/remote/manual 三种合并策略）、
 *     GET/DELETE /team/snapshots（最近导入快照归档）；
 * I2 执行经验库：GET/POST/DELETE /team/experience、POST /team/experience/notes、
 *     POST /team/experience/recommend；
 * I3 Prompt 协作评审：GET/POST/DELETE /team/reviews、GET /team/reviews/get、
 *     POST /team/reviews/comment、POST /team/reviews/decide、POST /team/reviews/merge。
 *
 * costSettings 分区导入时一律跳过（需经成本模块界面配置）；
 * pricingOverrides 导入后落 'cost-extra' 表并同步动态计价引擎。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 插件名。 */
export declare const name = "companion-team";
/** 依赖服务：仅 companion 根服务。 */
export declare const inject: string[];
/** 插件入口。 */
export declare function apply(ctx: Context): void;
