/**
 * 模块 G：多模型竞技场（arena）插件入口。
 *
 * HTTP 端点（经 ctx.companion.http 挂载）：
 * - GET    /arena/models        模型目录（内置 + 自定义，含 Key 配置状态）；
 * - POST   /arena/keys          保存外部厂商 API Key（AES-256-GCM 加密落盘）；
 * - DELETE /arena/keys          删除外部厂商 API Key（自定义模型级联删除）；
 * - POST   /arena/custom-models 添加/更新用户自定义模型（OpenAI 兼容）；
 * - DELETE /arena/custom-models 删除用户自定义模型（连同其 Key）；
 * - POST   /arena/compare       G1 同 Prompt 多模型并行对比（最多 5 个模型）；
 * - POST   /arena/leaderboard   G2 批量评测排行榜（JSON/JSONL 测试集，
 *                               准确率/延迟分位/Token/成本/合规率，报告 MD/HTML）；
 * - GET    /arena/recommend     G3 模型推荐引擎（任务类型+预算+延迟+峰谷感知）。
 *
 * 外部厂商调用走 OpenAI 兼容 chat/completions 协议；baseUrl 可随 Key 一并
 * 配置（指向任意兼容网关）。安全红线：任何响应不回传 Key 明文。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 插件名。 */
export declare const name = "companion-arena";
/** 依赖服务：companion 根服务。 */
export declare const inject: string[];
/** 插件入口。 */
export declare function apply(ctx: Context): void;
