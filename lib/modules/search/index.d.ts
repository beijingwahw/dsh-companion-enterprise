/**
 * 模块 D：全局对话检索插件。
 *
 * 经 ctx.companion.http 注册 GET /search、GET /tags、POST /tags，
 * GET /search/semantic（语义邻域检索：PRF 查询扩展 + RRF 融合）、
 * GET /search/similar（相似会话 more-like-this）、
 * GET /search/graph 与 GET /search/graph/entity（组织记忆图谱：
 * 实体抽取 + 共现构图 + PageRank 枢纽），
 * POST /search/rerank（点击反馈学习重排序：IPW 去位置偏 + 词元泛化，
 * 展示即记录曝光）、POST /search/click（记录点击）、
 * GET /search/clicks/stats（点击模型面板），
 * POST /search/diversify（MMR 多样性重排：λ 权衡相关性与冗余 + 去重审计），
 * 经 ctx.commands 注册 `search`、`similar` 与 `tag` 命令；检索逻辑复用
 * ./service.js 与 ./neighborhood.js，标签数据落在 companion 存储域
 * 'tags' 表（./tags.js），点击事件落在 'search-clicks' 表（./rerank.js）。
 *
 * apply 是同步函数，而存储域打开是异步的：内部用 void async IIFE
 * 先 await ctx.companion.ready 取 domain 建 TagStore，再把全部注册
 * 动作放进 ctx.effect，保证随插件卸载回卷。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 插件名。 */
export declare const name = "companion-search";
/** 依赖服务：companion 根服务、会话查询、命令面板。 */
export declare const inject: string[];
/** 插件入口：异步初始化后立即执行函数包裹，注册动作经 ctx.effect。 */
export declare function apply(ctx: Context): void;
