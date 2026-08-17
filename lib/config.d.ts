/**
 * 插件根配置：十个功能模块可独立启停，互不影响。
 * 配置经 schemastery 校验后传入 apply；cordis.patch.yml 可覆盖任一字段。
 */
import Schema from '@deepseek-ai/schemastery';
export interface Config {
    /** 模块 A：对话智能导出。 */
    enableExport: boolean;
    /** 模块 B：上下文交接摘要。 */
    enableHandoff: boolean;
    /** 模块 C：API 成本优化（开发者模式）。 */
    enableCost: boolean;
    /** 模块 D：全局对话检索。 */
    enableSearch: boolean;
    /** 模块 E：执行轨迹分析器（开发者）。 */
    enableTrace: boolean;
    /** 模块 F：Prompt 工程工作台（开发者）。 */
    enablePrompt: boolean;
    /** 模块 G：多模型竞技场（开发者）。 */
    enableArena: boolean;
    /** 模块 H：断点续跑与任务编排（开发者）。 */
    enableOrchestrator: boolean;
    /** 模块 I：协作与知识管理。 */
    enableTeam: boolean;
    /** 模块 J：安全与审计（企业开发者）。 */
    enableSecurity: boolean;
    /** DeepSeek 官方 API 基址（manifest.json 已放行该域名）。 */
    apiBaseUrl: string;
    /** 单次 API 调用超时（毫秒）。 */
    apiTimeoutMs: number;
    /** 单次定价页抓取的墙上时钟预算（毫秒）；供动态计价引擎使用。 */
    pricingTimeoutMs: number;
    /** 官方定价页刷新间隔（分钟）；下限 5 分钟，避免高频抓取官方页。 */
    pricingRefreshIntervalMin: number;
}
export declare const Config: Schema<Config>;
