/**
 * 浏览器端 API 层：DESIGN.md 第 4 节私有 HTTP API 的类型化 fetch 封装。
 *
 * 契约要点：
 * - 全部端点为同源 `/companion` 前缀下的 JSON 接口；
 * - 非 2xx 响应统一携带 `{ "error": string }`，在此统一解析为 CompanionApiError；
 * - 字节内容以 base64 传输，客户端解码为 Blob 后触发下载；
 * - 不导入 node:* 或宿主代码，本模块仅依赖浏览器内置能力。
 */
/** API 层统一抛出的错误：携带 HTTP 状态码与服务端错误文案。 */
export declare class CompanionApiError extends Error {
    /** HTTP 状态码。 */
    readonly status: number;
    constructor(status: number, message: string);
}
/** 通用成功响应（服务端契约 `{ ok: true }`）。 */
export interface OkResponse {
    readonly ok: true;
}
/** 会话头信息（客户端视角；跨 JSON 边界，id 为普通字符串）。 */
export interface SessionRecord {
    readonly id: string;
    readonly title?: string;
    readonly createdAt: number;
    readonly updatedAt?: number;
}
/** 查询参数表：值为 undefined 或空串的条目不会发出。 */
export type QueryParams = Readonly<Record<string, string | number | undefined>>;
/** 可选的请求控制参数：外部取消信号 + 超时时长。 */
export interface RequestOptions {
    /** 外部取消信号；与内部超时共用同一个 AbortController 联动。 */
    readonly signal?: AbortSignal;
    /** 超时时长（毫秒），缺省 {@link DEFAULT_TIMEOUT_MS}。 */
    readonly timeoutMs?: number;
}
/** 类型化 GET 封装。options 可选：外部取消信号与超时（缺省 30s）。 */
export declare function companionGet<T>(path: string, params?: QueryParams, options?: RequestOptions): Promise<T>;
/** 类型化 POST 封装（JSON 请求体）。options 可选：外部取消信号与超时（缺省 30s）。 */
export declare function companionPost<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
/** 类型化 DELETE 封装（契约允许 DELETE 携带 JSON 请求体）。options 可选：外部取消信号与超时（缺省 30s）。 */
export declare function companionDelete<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
/** 导出格式（与服务端契约一致的字符串联合；png=长图，客户端光栅化）。 */
export type ExportFormat = 'markdown' | 'pdf' | 'json' | 'png';
/** `GET /export/sessions` 响应。 */
export interface ExportSessionsResponse {
    readonly sessions: readonly SessionRecord[];
}
/** `POST /export/run` 请求体。 */
export interface ExportRunRequest {
    readonly sessionId: string;
    readonly format: ExportFormat;
    /** 缺省为 true。 */
    readonly timestamps?: boolean;
    /** 缺省为 false。 */
    readonly redact?: boolean;
}
/** 导出结果为文件：base64 内容 + 文件名 + MIME。 */
export interface ExportFileResult {
    readonly kind: 'file';
    readonly fileName: string;
    readonly mimeType: string;
    readonly contentBase64: string;
}
/** 导出结果为打印页（无光栅能力时的降级路径）：新窗口写入 html 并触发打印。 */
export interface ExportPrintResult {
    readonly kind: 'print';
    readonly fileName: string;
    readonly html: string;
}
/**
 * 导出结果为光栅载荷：客户端以 canvas 将 html 光栅化为成品
 * （PNG 长图或免打印多页 PDF），全程无 window.print() 对话框。
 */
export interface ExportRasterResult {
    readonly kind: 'raster';
    /** 目标成品：png=长图，pdf=免打印多页 PDF。 */
    readonly target: 'png' | 'pdf';
    readonly fileName: string;
    readonly html: string;
}
/** `POST /export/run` 响应。 */
export type ExportRunResponse = ExportFileResult | ExportPrintResult | ExportRasterResult;
/** `POST /export/batch` 请求体。 */
export interface ExportBatchRequest {
    readonly sessionIds: readonly string[];
    readonly format: ExportFormat;
    readonly timestamps?: boolean;
    readonly redact?: boolean;
}
/** `POST /export/batch` 响应（ZIP 压缩包）。 */
export interface ExportBatchResponse {
    readonly kind: 'file';
    readonly fileName: string;
    readonly mimeType: 'application/zip';
    readonly contentBase64: string;
}
/** 列出可导出的会话。 */
export declare function fetchExportSessions(options?: RequestOptions): Promise<ExportSessionsResponse>;
/** 导出单个会话。 */
export declare function runExport(request: ExportRunRequest, options?: RequestOptions): Promise<ExportRunResponse>;
/** 批量导出多个会话为 ZIP。 */
export declare function runExportBatch(request: ExportBatchRequest, options?: RequestOptions): Promise<ExportBatchResponse>;
/** `POST /handoff/generate` 响应。 */
export interface HandoffGenerateResponse {
    readonly summary: string;
    readonly model: string;
}
/** 交接摘要模板条目。 */
export interface HandoffTemplate {
    readonly name: string;
    readonly content: string;
    readonly updatedAt: number;
}
/** `GET /handoff/templates` 响应。 */
export interface HandoffTemplatesResponse {
    readonly templates: readonly HandoffTemplate[];
}
/** `POST /handoff/import` 请求体；省略 sessionId = 武装给“下一个新对话”。 */
export interface HandoffImportRequest {
    readonly summary: string;
    readonly sessionId?: string;
}
/** `POST /handoff/import` 响应；sessionId 为 null 表示武装给了下一个新对话。 */
export interface HandoffImportResponse {
    readonly ok: true;
    readonly sessionId: string | null;
}
/** 已武装的交接摘要条目。 */
export interface ArmedHandoff {
    /** null = 武装给下一个新对话。 */
    readonly sessionId: string | null;
    readonly summary: string;
    readonly armedAt: number;
}
/** `GET /handoff/armed` 响应。 */
export interface ArmedHandoffsResponse {
    readonly armed: readonly ArmedHandoff[];
    /** pending 摘要的投递回执（世代门闩可观测性）。 */
    readonly receipts?: readonly HandoffReceipt[];
}
/** pending 摘要的投递回执。 */
export interface HandoffReceipt {
    readonly sessionId: string;
    readonly injectedAt: number;
}
/** `DELETE /handoff/armed` 请求体（缺省 sessionId 时移除全局武装）。 */
export interface DismissArmedRequest {
    readonly sessionId?: string;
}
/** 为指定会话生成交接摘要。 */
export declare function generateHandoff(request: {
    sessionId: string;
}, options?: RequestOptions): Promise<HandoffGenerateResponse>;
/** 列出全部交接摘要模板。 */
export declare function fetchHandoffTemplates(options?: RequestOptions): Promise<HandoffTemplatesResponse>;
/** 保存（覆盖）一个模板。 */
export declare function saveHandoffTemplate(request: {
    name: string;
    content: string;
}): Promise<OkResponse>;
/** 删除一个模板。 */
export declare function deleteHandoffTemplate(name: string): Promise<OkResponse>;
/** 导入摘要：带 sessionId 注入指定会话，不带则武装给下一个新对话。 */
export declare function importHandoff(request: HandoffImportRequest): Promise<HandoffImportResponse>;
/** 查询当前已武装的交接摘要。 */
export declare function fetchArmedHandoffs(options?: RequestOptions): Promise<ArmedHandoffsResponse>;
/** 移除已武装的交接摘要。 */
export declare function dismissArmedHandoff(request: DismissArmedRequest): Promise<OkResponse>;
/**
 * 模型单价（元 / 百万 tokens）：动态计价引擎形状
 * （吸收自 dsh-usage-ledger），用户可按模型 id 覆盖（最长前缀匹配）。
 */
export interface ModelPrice {
    /** 命中前缀缓存的输入单价。 */
    readonly inputCacheHit: number;
    /** 未命中缓存的输入单价。 */
    readonly inputMiss: number;
    /** 输出单价。 */
    readonly output: number;
}
/** 单厂商定价面板数据。 */
export interface VendorPricing {
    readonly id: string;
    readonly label: string;
    readonly pricingUrl: string;
    /** 是否阶梯计价（展示的是最低档）。 */
    readonly tiered: boolean;
    /** live=官方定价页实时抓取；builtin=内置快照；override=用户自定义。 */
    readonly source: 'live' | 'builtin' | 'override';
    readonly fetchedAt?: number;
    readonly models: Readonly<Record<string, ModelPrice>>;
    /** 全模型峰谷感知：该厂商的峰谷分时计划（官方未公布峰谷价时缺省）。 */
    readonly scheduled?: Readonly<{
        readonly effective: string;
        readonly peakWindows?: ReadonlyArray<readonly [number, number]>;
        readonly offPeak: Readonly<Record<string, ModelPrice>>;
        readonly peak: Readonly<Record<string, ModelPrice>>;
    }>;
}
/** 动态计价引擎面板数据（`GET /cost/pricing` 与 /cost/state.pricing）。 */
export interface CostPricingView {
    /** DeepSeek 价格表来源：live=官方页实时抓取；builtin=内置快照。 */
    readonly source: 'live' | 'builtin';
    readonly sourceUrl?: string;
    readonly fetchedAt?: number;
    /** 官方价格最近一次内容变更时间（undefined=从未）。 */
    readonly lastChangedAt?: number;
    /** 峰谷分时计划（null=暂无）。 */
    readonly scheduled: Readonly<{
        readonly effective: string;
        readonly peakWindows?: ReadonlyArray<readonly [number, number]>;
        readonly offPeak: Readonly<Record<string, ModelPrice>>;
        readonly peak: Readonly<Record<string, ModelPrice>>;
    }> | null;
    /** 用户自定义单价覆盖。 */
    readonly overrides: Readonly<Record<string, ModelPrice>>;
    /** 按厂商分组的全部已知定价。 */
    readonly vendors: readonly VendorPricing[];
}
/** 模型路由规则（细节由服务端成本模块维护，客户端只读透传，不展开字段）。 */
export type CostRoutingRule = Readonly<Record<string, unknown>>;
/** 日/月双档预算状态。 */
export interface CostBudgetState {
    /** 日预算（元）；0 表示不限。 */
    readonly dailyCny: number;
    /** 今日已花费（元，北京时间日）。 */
    readonly dailySpentCny: number;
    /** 日用量/日预算比值（日预算为 0 时取 0）。 */
    readonly dailyRatio: number;
    readonly monthlyCny: number;
    readonly spentCny: number;
    /** 已用 / 预算（0~1，可能大于 1）。 */
    readonly ratio: number;
    /** 任一档预算用尽后是否已暂停 API 调用。 */
    readonly paused: boolean;
}
/** `GET /cost/state` 响应。 */
export interface CostState {
    readonly devMode: boolean;
    readonly apiKeyConfigured: boolean;
    readonly peakScheduling: boolean;
    readonly modelRouting: boolean;
    readonly budget: CostBudgetState;
    readonly rules: readonly CostRoutingRule[];
    readonly pricing: CostPricingView;
}
/** `POST /cost/settings` 稀疏补丁：只携带需要变更的字段。 */
export interface CostSettingsPatch {
    readonly devMode?: boolean;
    readonly peakScheduling?: boolean;
    readonly modelRouting?: boolean;
    readonly dailyBudgetCny?: number;
    readonly monthlyBudgetCny?: number;
    readonly rules?: readonly CostRoutingRule[];
    readonly pricing?: Readonly<Record<string, ModelPrice>>;
}
/** 按模型切片的当日用量。 */
export interface ModelUsageSlice {
    readonly calls: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    /** 命中缓存的输入 tokens（旧行可能缺省）。 */
    readonly cacheHitTokens?: number;
    readonly costCny: number;
}
/** 北京时间日粒度用量聚合。 */
export interface DailyUsage {
    /** 日期键 YYYY-MM-DD。 */
    readonly day: string;
    readonly calls: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    /** 命中缓存的输入 tokens（旧行可能缺省）。 */
    readonly cacheHitTokens?: number;
    readonly costCny: number;
    /** 通过模型路由/峰谷调度节省的估算金额。 */
    readonly savedCny: number;
    /** 被峰谷调度延迟执行的调用数。 */
    readonly deferredCalls: number;
    readonly byModel: Readonly<Record<string, ModelUsageSlice>>;
}
/** 区间用量汇总。 */
export interface UsageTotal {
    readonly calls: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cacheHitTokens: number;
    readonly costCny: number;
    readonly savedCny: number;
    readonly deferredCalls: number;
}
/** `GET /cost/report` 响应。 */
export interface CostReportResponse {
    readonly days: readonly DailyUsage[];
    readonly total: UsageTotal;
}
/** `POST /cost/test-call` 响应。 */
export interface CostTestCallResponse {
    readonly ok: true;
    readonly model: string;
    readonly latencyMs: number;
}
/** 读取成本状态（保险库不回传 Key 明文，只有 apiKeyConfigured 布尔）。 */
export declare function fetchCostState(options?: RequestOptions): Promise<CostState>;
/** 保存 API Key（服务端 AES-256-GCM 加密落盘）。 */
export declare function saveCostApiKey(apiKey: string): Promise<OkResponse>;
/** 删除已保存的 API Key。 */
export declare function removeCostApiKey(): Promise<OkResponse>;
/** 更新成本设置（稀疏补丁）。 */
export declare function updateCostSettings(patch: CostSettingsPatch): Promise<OkResponse>;
/** 读取 [from, to]（YYYY-MM-DD，北京时间）区间的成本报表。 */
export declare function fetchCostReport(range: {
    from: string;
    to: string;
}, options?: RequestOptions): Promise<CostReportResponse>;
/** 用当前 Key 发起一次最小测试调用，验证连通性。 */
export declare function testCostCall(): Promise<CostTestCallResponse>;
/** 读取动态计价引擎面板数据（各厂商官方定价、峰谷计划、用户覆盖）。 */
export declare function fetchCostPricing(options?: RequestOptions): Promise<CostPricingView>;
/** 手动触发官方定价页刷新（DeepSeek + 全部国产厂商），返回刷新后的面板数据。 */
export declare function refreshCostPricing(options?: RequestOptions): Promise<CostPricingView>;
/** `GET /search` 请求参数。 */
export interface SearchRequest {
    readonly query?: string;
    /** YYYY-MM-DD。 */
    readonly from?: string;
    /** YYYY-MM-DD。 */
    readonly to?: string;
    readonly tags?: readonly string[];
    readonly limit?: number;
}
/** 单条检索命中。 */
export interface SearchHit {
    readonly session: SessionRecord;
    readonly snippet?: string;
    readonly tags: readonly string[];
}
/** `GET /search` 响应。 */
export interface SearchResponse {
    readonly hits: readonly SearchHit[];
}
/** `GET /tags?sessionId=` 响应（单个会话的标签）。 */
export interface SessionTagsResponse {
    readonly tags: readonly string[];
}
/** `GET /tags`（缺省 sessionId）响应：标签 → 会话 id 列表的全量映射。 */
export interface AllTagsResponse {
    readonly tags: Readonly<Record<string, readonly string[]>>;
}
/** `POST /tags` 请求体。 */
export interface UpdateTagsRequest {
    readonly sessionId: string;
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
}
/** 跨会话全文检索。 */
export declare function searchSessions(request: SearchRequest): Promise<SearchResponse>;
/** 读取单个会话的标签。 */
export declare function fetchSessionTags(sessionId: string): Promise<SessionTagsResponse>;
/** 读取全量标签映射（标签 → 会话 id 列表）。 */
export declare function fetchAllTags(): Promise<AllTagsResponse>;
/** 为会话增删标签。 */
export declare function updateSessionTags(request: UpdateTagsRequest): Promise<SessionTagsResponse>;
/** 轨迹节点（客户端视角）。 */
export interface TraceNode {
    readonly id: string;
    readonly name: string;
    readonly kind: 'step' | 'tool' | 'agent' | 'model';
    readonly startMs: number;
    readonly endMs: number;
    readonly durationMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly model?: string;
    readonly cacheHit: boolean;
    readonly status: 'ok' | 'error' | 'retry';
    readonly attempts: number;
    readonly parentId?: string;
}
/** 一条完整执行轨迹。 */
export interface Trace {
    readonly id: string;
    readonly sessionId?: string;
    readonly startedAt: number;
    readonly endedAt: number;
    readonly nodes: readonly TraceNode[];
}
/** 轨迹异常标注。 */
export interface TraceAnomaly {
    readonly kind: 'retry-loop' | 'token-explosion' | 'cache-miss' | 'infinite-loop';
    readonly nodeIds: readonly string[];
    readonly reason: string;
    readonly suggestion: string;
    readonly severity: 1 | 2 | 3;
}
/** 轨迹汇总指标。 */
export interface TraceStats {
    readonly totalDurationMs: number;
    readonly totalInputTokens: number;
    readonly totalOutputTokens: number;
    readonly cacheHitRate: number;
    readonly toolSuccessRate: number;
    readonly agentDispatches: number;
    readonly nodeCount: number;
}
/** 轨迹对比差异条目。 */
export interface TraceDiffEntry {
    readonly name: string;
    readonly change: 'added' | 'removed' | 'changed' | 'same';
    readonly oldDurationMs?: number;
    readonly newDurationMs?: number;
    readonly durationDeltaMs?: number;
    readonly oldTokens?: number;
    readonly newTokens?: number;
    readonly tokenDelta?: number;
}
/** 轨迹日聚合统计。 */
export interface TraceDailyStats {
    readonly day: string;
    readonly traceCount: number;
    readonly totalDurationMs: number;
    readonly totalInputTokens: number;
    readonly totalOutputTokens: number;
    readonly cacheHits: number;
    readonly modelCalls: number;
    readonly toolCalls: number;
    readonly toolSuccess: number;
    readonly agentDispatches: number;
    readonly anomalyCount: number;
}
/** `GET /trace/derive` 与 `GET /trace/get` 响应。 */
export interface TraceAnalysisResponse {
    readonly trace: Trace;
    readonly anomalies: readonly TraceAnomaly[];
    readonly stats: TraceStats;
    readonly slowest?: readonly TraceNode[];
    readonly costliest?: readonly TraceNode[];
}
/** `GET /trace/stats` 响应。 */
export interface TraceStatsResponse {
    readonly days: readonly TraceDailyStats[];
    readonly baseline?: {
        readonly avgDurationMs: number;
        readonly avgTokens: number;
        readonly avgAnomalies: number;
    };
}
/** `POST /trace/diff` 响应（json 形态）。 */
export interface TraceDiffJsonResponse {
    readonly format: 'json';
    readonly entries: readonly TraceDiffEntry[];
}
/** `POST /trace/diff` 响应（html 形态）。 */
export interface TraceDiffHtmlResponse {
    readonly format: 'html';
    readonly fileName: string;
    readonly html: string;
}
/** 从会话日志派生并分析轨迹。 */
export declare function deriveTrace(sessionId: string, options?: RequestOptions): Promise<TraceAnalysisResponse>;
/** 列出可分析的会话。 */
export declare function fetchTraceSessions(options?: RequestOptions): Promise<ExportSessionsResponse>;
/** 对比两条轨迹（format 缺省返回 json；'html' 返回自包含对比报告）。 */
export declare function diffTraces(request: {
    old: {
        id?: string;
        sessionId?: string;
    };
    new: {
        id?: string;
        sessionId?: string;
    };
    format?: 'json' | 'html';
}, options?: RequestOptions): Promise<TraceDiffJsonResponse | TraceDiffHtmlResponse>;
/** 读取轨迹日聚合趋势与历史基准线。 */
export declare function fetchTraceStats(range: {
    from: string;
    to: string;
}, options?: RequestOptions): Promise<TraceStatsResponse>;
/** 摄入 Harness 原生轨迹 JSON。 */
export declare function ingestTrace(request: {
    id?: string;
    trace: unknown;
}, options?: RequestOptions): Promise<TraceAnalysisResponse>;
/** Prompt 版本记录。 */
export interface PromptVersion {
    readonly version: number;
    readonly content: string;
    readonly note: string;
    readonly tags: readonly string[];
    readonly createdAt: number;
}
/** Prompt 模板。 */
export interface PromptTemplate {
    readonly name: string;
    readonly category: string;
    readonly content: string;
    readonly builtin: boolean;
    readonly updatedAt: number;
    readonly variables: readonly string[];
}
/** A/B 单条运行结果。 */
export interface AbTestRunResult {
    readonly caseIndex: number;
    readonly input: string;
    readonly ok: boolean;
    readonly output: string;
    readonly latencyMs: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly error?: string;
}
/** A/B 汇总指标。 */
export interface AbTestSummary {
    readonly successRate: number;
    readonly avgOutputLength: number;
    readonly avgLatencyMs: number;
    readonly totalTokens: number;
}
/** 胜率统计。 */
export interface PromptRatings {
    readonly total: number;
    readonly winsA: number;
    readonly winsB: number;
    readonly ties: number;
}
/** `POST /prompt/ab-test` 响应。 */
export interface AbTestResponse {
    readonly model: string;
    readonly a: {
        readonly prompt: string;
        readonly results: readonly AbTestRunResult[];
        readonly summary: AbTestSummary;
    };
    readonly b: {
        readonly prompt: string;
        readonly results: readonly AbTestRunResult[];
        readonly summary: AbTestSummary;
    };
    readonly ratings: PromptRatings;
}
/** F4 单条校验运行。 */
export interface ValidateRun {
    readonly caseIndex: number;
    readonly input: string;
    readonly ok: boolean;
    readonly output: string;
    readonly violations: readonly {
        readonly path: string;
        readonly message: string;
    }[];
    readonly latencyMs: number;
    readonly tokens: number;
    readonly error?: string;
}
/** `POST /prompt/validate` 响应。 */
export interface ValidateResponse {
    readonly model: string;
    readonly total: number;
    readonly compliant: number;
    readonly complianceRate: number;
    readonly runs: readonly ValidateRun[];
}
/** 读取 Prompt 版本历史。 */
export declare function fetchPromptVersions(options?: RequestOptions): Promise<{
    versions: readonly PromptVersion[];
}>;
/** 保存新 Prompt 版本。 */
export declare function savePromptVersion(request: {
    content: string;
    note?: string;
    tags?: readonly string[];
}): Promise<{
    version: PromptVersion;
}>;
/** 回滚到指定版本。 */
export declare function rollbackPromptVersion(request: {
    version: number;
    note?: string;
}): Promise<{
    version: PromptVersion;
}>;
/** 为版本增删标签。 */
export declare function updatePromptTags(request: {
    version: number;
    add?: readonly string[];
    remove?: readonly string[];
}): Promise<{
    version: PromptVersion;
}>;
/** 运行 A/B 测试。 */
export declare function runAbTest(request: {
    promptA: string;
    promptB: string;
    cases?: readonly string[];
    model?: string;
}, options?: RequestOptions): Promise<AbTestResponse>;
/** 提交人工评分。 */
export declare function rateAbTest(request: {
    winner: 'A' | 'B' | 'tie';
    promptA?: string;
    promptB?: string;
}): Promise<{
    ok: true;
    ratings: PromptRatings;
}>;
/** 读取模板库。 */
export declare function fetchPromptTemplates(options?: RequestOptions): Promise<{
    templates: readonly PromptTemplate[];
}>;
/** 保存模板。 */
export declare function savePromptTemplate(request: {
    name: string;
    category?: string;
    content: string;
}): Promise<OkResponse>;
/** 删除模板。 */
export declare function deletePromptTemplate(name: string): Promise<OkResponse>;
/** 变量插值渲染。 */
export declare function renderPromptTemplate(request: {
    template: string;
    variables?: Readonly<Record<string, string>>;
}): Promise<{
    rendered: string;
}>;
/** 生成 API 调用代码。 */
export declare function generateApiCode(request: {
    prompt: string;
    language: 'python' | 'nodejs' | 'curl';
    model?: string;
}): Promise<{
    code: string;
}>;
/** 结构化输出批量校验。 */
export declare function validateStructuredOutput(request: {
    prompt: string;
    schema: string;
    cases?: readonly string[];
    model?: string;
}, options?: RequestOptions): Promise<ValidateResponse>;
/** 竞技场模型目录条目。 */
export interface ArenaModelInfo {
    readonly id: string;
    readonly label: string;
    readonly provider: 'deepseek' | 'external';
    readonly latencyTier: 'fast' | 'balanced' | 'slow';
    readonly accuracyPrior: Readonly<Record<string, number>>;
    /** true=用户自定义模型（可删除）。 */
    readonly custom?: boolean;
    /** 外部厂商 Key 是否已配置（deepseek 模型为 undefined）。 */
    readonly keyConfigured?: boolean;
    /** 全模型峰谷感知：当前是否高峰 + 该模型厂商是否公布峰谷分时价。 */
    readonly peakStatus?: Readonly<{
        readonly isPeak: boolean;
        readonly hasPeakPricing: boolean;
    }>;
}
/** G1 单模型运行结果。 */
export interface ArenaRunResult {
    readonly model: string;
    readonly ok: boolean;
    readonly output: string;
    readonly latencyMs: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly costCny: number;
    readonly error?: string;
}
/** G2 排行榜行。 */
export interface ArenaLeaderboardRow {
    readonly model: string;
    readonly successRate: number;
    readonly accuracy: number | null;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
    readonly avgTokens: number;
    readonly costPerTaskCny: number;
    readonly complianceRate: number | null;
    readonly compositeScore: number;
}
/** G3 推荐条目。 */
export interface ArenaRecommendation {
    readonly model: string;
    readonly label: string;
    readonly score: number;
    readonly reason: string;
    readonly estimatedCostCny: number;
}
/** 读取模型目录。 */
export declare function fetchArenaModels(options?: RequestOptions): Promise<{
    models: readonly ArenaModelInfo[];
}>;
/** 保存外部厂商 API Key（服务端加密落盘）。 */
export declare function saveArenaKey(request: {
    modelId: string;
    apiKey: string;
    baseUrl?: string;
}): Promise<OkResponse>;
/** 删除外部厂商 API Key。 */
export declare function removeArenaKey(modelId: string): Promise<OkResponse>;
/** 添加/更新用户自定义模型（OpenAI 兼容）。 */
export declare function addArenaCustomModel(request: {
    modelId: string;
    label: string;
    baseUrl: string;
    latencyTier?: 'fast' | 'balanced' | 'slow';
}): Promise<OkResponse>;
/** 删除用户自定义模型（连同其 Key）。 */
export declare function removeArenaCustomModel(modelId: string): Promise<OkResponse>;
/** G1 同 Prompt 多模型并行对比。 */
export declare function runArenaCompare(request: {
    prompt: string;
    models: readonly string[];
}, options?: RequestOptions): Promise<{
    prompt: string;
    results: readonly ArenaRunResult[];
}>;
/** G2 批量评测排行榜（format 缺省返回 json；useCache=true 时导出复用最近评测结果，不重跑）。 */
export declare function runArenaLeaderboard(request: {
    models?: readonly string[];
    cases?: readonly unknown[] | string;
    format?: 'markdown' | 'html';
    useCache?: boolean;
}, options?: RequestOptions): Promise<{
    format: 'json';
    rows: readonly ArenaLeaderboardRow[];
} | {
    format: 'markdown' | 'html';
    fileName: string;
    content: string;
}>;
/** G3 模型推荐。 */
export declare function fetchArenaRecommendation(params: {
    taskType?: string;
    budgetPerCallCny?: number;
    latency?: string;
}, options?: RequestOptions): Promise<{
    taskType: string;
    taskTypeLabel: string;
    recommendations: readonly ArenaRecommendation[];
}>;
/** 流水线步骤定义（H1）。 */
export interface OrchestratorStep {
    readonly id: string;
    readonly name: string;
    readonly model: string;
    readonly prompt: string;
    readonly inputFrom: 'prev' | 'literal';
    readonly input: string;
    readonly condition: string;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly retryIntervalMs: number;
    readonly dependsOn: readonly string[];
}
/** 流水线定义（H1）。 */
export interface OrchestratorPipeline {
    readonly id: string;
    readonly name: string;
    readonly steps: readonly OrchestratorStep[];
    readonly createdAt: number;
    readonly updatedAt: number;
}
/** 单步运行记录（H2）。 */
export interface OrchestratorStepRun {
    readonly stepId: string;
    readonly status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
    readonly attempts: number;
    readonly output: string;
    readonly error: string;
    readonly startedAt: number;
    readonly endedAt: number;
    readonly latencyMs: number;
    readonly tokens: number;
}
/** 一次流水线执行（H2 断点续跑单元）。 */
export interface OrchestratorRun {
    readonly id: string;
    readonly pipelineId: string;
    readonly status: 'running' | 'done' | 'failed' | 'paused' | 'cancelled';
    readonly startedAt: number;
    readonly endedAt: number;
    readonly steps: Readonly<Record<string, OrchestratorStepRun>>;
    readonly message: string;
}
/** 执行列表摘要（GET /orchestrator/runs）。 */
export interface OrchestratorRunSummary {
    readonly id: string;
    readonly pipelineId: string;
    readonly status: OrchestratorRun['status'];
    readonly startedAt: number;
    readonly endedAt: number;
    readonly message: string;
    readonly progress: {
        readonly done: number;
        readonly total: number;
    };
}
/** 队列任务（H3）。 */
export interface OrchestratorQueueTask {
    readonly id: string;
    readonly name: string;
    readonly prompt: string;
    readonly model: string;
    readonly priority: 'high' | 'medium' | 'low';
    readonly deadline: number;
    readonly failurePolicy: 'skip' | 'retry' | 'notify';
    readonly status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'paused';
    readonly createdAt: number;
    readonly finishedAt: number;
    readonly output: string;
    readonly error: string;
    readonly attempts: number;
}
/** 队列状态计数。 */
export type OrchestratorQueueCounts = Readonly<Record<string, number>>;
/** 定时任务（H4）。 */
export interface OrchestratorJob {
    readonly id: string;
    readonly name: string;
    readonly cron: string;
    readonly scheduleText: string;
    readonly prompt: string;
    readonly model: string;
    readonly offPeakOnly: boolean;
    readonly enabled: boolean;
    readonly createdAt: number;
    readonly lastRunAt: number;
    readonly nextRunAt: number;
}
/** 定时任务执行归档（H4）。 */
export interface OrchestratorJobRun {
    readonly id: string;
    readonly jobId: string;
    readonly ts: number;
    readonly ok: boolean;
    readonly output: string;
    readonly error: string;
    readonly latencyMs: number;
}
/** 列出全部流水线。 */
export declare function fetchPipelines(options?: RequestOptions): Promise<{
    pipelines: readonly OrchestratorPipeline[];
}>;
/** 创建或更新流水线（携带 id 为更新）。 */
export declare function savePipeline(request: {
    id?: string;
    name: string;
    steps: readonly Partial<OrchestratorStep>[];
}, options?: RequestOptions): Promise<{
    pipeline: OrchestratorPipeline;
}>;
/** 删除流水线。 */
export declare function deletePipeline(id: string): Promise<OkResponse>;
/** 读取流水线自动生成的 YAML 配置。 */
export declare function fetchPipelineYaml(id: string, options?: RequestOptions): Promise<{
    id: string;
    yaml: string;
}>;
/** 启动一次执行（后台异步，立即返回 runId）。 */
export declare function startPipelineRun(pipelineId: string, options?: RequestOptions): Promise<{
    runId: string;
    status: OrchestratorRun['status'];
}>;
/** 断点续跑：从最后成功步骤继续。 */
export declare function resumePipelineRun(runId: string, options?: RequestOptions): Promise<{
    runId: string;
    status: OrchestratorRun['status'];
}>;
/** 暂停执行。 */
export declare function pausePipelineRun(runId: string): Promise<OkResponse>;
/** 取消执行。 */
export declare function cancelPipelineRun(runId: string): Promise<OkResponse>;
/** 列出执行记录（可按流水线过滤）。 */
export declare function fetchPipelineRuns(pipelineId?: string, options?: RequestOptions): Promise<{
    runs: readonly OrchestratorRunSummary[];
}>;
/** 读取单次执行详情（含各步骤中间结果）。 */
export declare function fetchPipelineRun(id: string, options?: RequestOptions): Promise<{
    run: OrchestratorRun;
}>;
/** 删除执行记录。 */
export declare function deletePipelineRun(id: string): Promise<OkResponse>;
/** 读取批量队列（任务列表 + 计数）。 */
export declare function fetchQueue(options?: RequestOptions): Promise<{
    tasks: readonly OrchestratorQueueTask[];
    counts: OrchestratorQueueCounts;
}>;
/** 提交批量任务。 */
export declare function submitQueueTask(request: {
    name: string;
    prompt: string;
    model?: string;
    priority?: 'high' | 'medium' | 'low';
    deadline?: number;
    failurePolicy?: 'skip' | 'retry' | 'notify';
}, options?: RequestOptions): Promise<{
    task: OrchestratorQueueTask;
}>;
/** 取消队列任务。 */
export declare function cancelQueueTask(id: string): Promise<OkResponse>;
/** 暂停排队中的任务。 */
export declare function pauseQueueTask(id: string): Promise<OkResponse>;
/** 恢复已暂停的任务。 */
export declare function resumeQueueTask(id: string): Promise<OkResponse>;
/** 批量操作队列（pause/resume/cancel 全部可操作任务）。 */
export declare function batchQueue(action: 'pause' | 'resume' | 'cancel'): Promise<{
    ok: true;
    changed: number;
}>;
/** 删除队列任务记录。 */
export declare function deleteQueueTask(id: string): Promise<OkResponse>;
/** 列出定时任务。 */
export declare function fetchJobs(options?: RequestOptions): Promise<{
    jobs: readonly OrchestratorJob[];
}>;
/** 自然语言/Cron 解析预检。 */
export declare function parseSchedule(text: string, options?: RequestOptions): Promise<{
    cron: string;
    nextRunAt: number;
}>;
/** 创建或更新定时任务（携带 id 为更新）。 */
export declare function saveJob(request: {
    id?: string;
    name: string;
    prompt: string;
    schedule: string;
    model?: string;
    offPeakOnly?: boolean;
    enabled?: boolean;
}, options?: RequestOptions): Promise<{
    job: OrchestratorJob;
}>;
/** 启用/停用定时任务。 */
export declare function toggleJob(id: string, enabled: boolean): Promise<{
    job: OrchestratorJob;
}>;
/** 删除定时任务。 */
export declare function deleteJob(id: string): Promise<OkResponse>;
/** 读取定时任务历史执行记录。 */
export declare function fetchJobRuns(jobId: string, options?: RequestOptions): Promise<{
    runs: readonly OrchestratorJobRun[];
}>;
/** Key 权限范围（J1）。 */
export interface SecurityKeyScope {
    readonly access: 'full' | 'read';
    readonly models: readonly string[];
    readonly dailyBudgetCny: number;
}
/** 命名 Key 展示视图（安全红线：不含明文，仅掩码元数据）。 */
export interface SecurityKeyView {
    readonly name: string;
    readonly note: string;
    readonly createdAt: number;
    readonly lastUsedAt: number;
    readonly scope: SecurityKeyScope;
    readonly configured: boolean;
    readonly rotationDue: boolean;
}
/** 审计日志条目（J2；Prompt 摘要已脱敏）。 */
export interface AuditEntry {
    readonly id: string;
    readonly ts: number;
    readonly model: string;
    readonly promptSummary: string;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly costCny: number;
    readonly status: string;
    readonly source: string;
}
/** DLP 规则（J3）。 */
export interface DlpRule {
    readonly id: string;
    readonly name: string;
    readonly pattern: string;
    readonly builtin: boolean;
    readonly enabled: boolean;
}
/** DLP 命中。 */
export interface DlpFinding {
    readonly ruleId: string;
    readonly ruleName: string;
    readonly sample: string;
    readonly count: number;
}
/** DLP 设置（J3）。 */
export interface DlpSettings {
    readonly enabled: boolean;
    readonly strict: boolean;
}
/** 合规报表（J4）。 */
export interface ComplianceReport {
    readonly from: string;
    readonly to: string;
    readonly totalCalls: number;
    readonly totalCostCny: number;
    readonly totalTokens: number;
    readonly modelShare: Readonly<Record<string, number>>;
    readonly blocks: Readonly<Record<string, number>>;
    readonly blockTotal: number;
    readonly alerts: readonly {
        readonly ts: number;
        readonly kind: string;
        readonly detail: string;
    }[];
}
/** 读取命名 Key 列表（不回传明文）。 */
export declare function fetchSecurityKeys(options?: RequestOptions): Promise<{
    keys: readonly SecurityKeyView[];
    rotationDays: number;
    activeConfigured: boolean;
}>;
/** 保存命名 Key（服务端加密落盘）。 */
export declare function saveSecurityKey(request: {
    name: string;
    apiKey: string;
    note?: string;
    scope?: Partial<SecurityKeyScope>;
}, options?: RequestOptions): Promise<{
    key: SecurityKeyView;
}>;
/** 切换激活 Key。 */
export declare function activateSecurityKey(name: string): Promise<OkResponse>;
/** 删除命名 Key。 */
export declare function deleteSecurityKey(name: string): Promise<OkResponse>;
/** Key 泄露检测（粘贴疑似泄露内容进行检查）。 */
export declare function checkKeyLeak(content: string, options?: RequestOptions): Promise<{
    leaked: readonly string[];
    safe: boolean;
}>;
/** 读取 Key 轮换到期提醒。 */
export declare function fetchKeyRotation(options?: RequestOptions): Promise<{
    due: readonly {
        readonly name: string;
        readonly ageDays: number;
    }[];
    thresholdDays: number;
}>;
/** 查询审计日志（支持时间/模型/状态筛选）。 */
export declare function fetchAuditLog(params: {
    from?: number;
    to?: number;
    model?: string;
    status?: string;
    limit?: number;
}, options?: RequestOptions): Promise<{
    entries: readonly AuditEntry[];
}>;
/** 导出审计日志（CSV/JSON）。 */
export declare function exportAuditLog(params: {
    format: 'csv' | 'json';
    from?: number;
    to?: number;
}, options?: RequestOptions): Promise<{
    format: 'csv' | 'json';
    fileName: string;
    content: string;
}>;
/** 读取 DLP 状态（设置 + 规则）。 */
export declare function fetchDlpState(options?: RequestOptions): Promise<{
    settings: DlpSettings;
    rules: readonly DlpRule[];
}>;
/** 更新 DLP 设置。 */
export declare function updateDlpSettings(patch: {
    enabled?: boolean;
    strict?: boolean;
}): Promise<{
    settings: DlpSettings;
}>;
/** 新增自定义 DLP 规则。 */
export declare function addDlpRule(request: {
    name: string;
    pattern: string;
    enabled?: boolean;
}, options?: RequestOptions): Promise<{
    rules: readonly DlpRule[];
}>;
/** 启用/停用 DLP 规则。 */
export declare function toggleDlpRule(id: string, enabled: boolean): Promise<{
    rules: readonly DlpRule[];
}>;
/** 删除自定义 DLP 规则。 */
export declare function deleteDlpRule(id: string): Promise<{
    rules: readonly DlpRule[];
}>;
/** DLP 发送前预检扫描。 */
export declare function scanDlp(text: string, options?: RequestOptions): Promise<{
    findings: readonly DlpFinding[];
    clean: boolean;
    settings: DlpSettings;
}>;
/** 读取合规报表。 */
export declare function fetchComplianceReport(range: {
    from: string;
    to: string;
}, options?: RequestOptions): Promise<ComplianceReport>;
/** 导出合规报表（自包含 HTML，经浏览器打印可另存 PDF）。 */
export declare function exportComplianceReport(range: {
    from: string;
    to: string;
}, options?: RequestOptions): Promise<{
    format: 'html';
    fileName: string;
    content: string;
}>;
/** 配置合并策略（I1）。 */
export type MergeStrategy = 'local' | 'remote' | 'manual';
/** 团队偏好（I1）。 */
export interface TeamPrefs {
    /** 成员署名（评审作者/评论者标识）。 */
    readonly memberName: string;
    /** 导入时的缺省合并策略。 */
    readonly defaultStrategy: MergeStrategy;
}
/** 快照可携带的配置分区名（I1）。 */
export type ConfigSection = 'costSettings' | 'pricingOverrides' | 'handoffTemplates' | 'promptTemplates' | 'pipelines' | 'scheduledJobs' | 'dlpRules';
/** 团队配置快照（I1 导出 JSON 文档）。 */
export interface TeamConfigSnapshot {
    readonly kind: 'dsh-companion-team-config';
    readonly version: number;
    readonly exportedAt: number;
    readonly exportedBy: string;
    readonly sections: Readonly<Record<string, unknown>>;
}
/** 单条配置差异（I1）。 */
export interface ConfigDiffEntry {
    readonly section: ConfigSection;
    readonly key: string;
    /** add=仅远程存在；update=两侧不同；same=两侧一致；local-only=仅本地存在。 */
    readonly action: 'add' | 'update' | 'same' | 'local-only';
    readonly local?: unknown;
    readonly remote?: unknown;
}
/** 单个分区的导入结果汇报（I1）。 */
export interface SectionReport {
    readonly section: ConfigSection;
    readonly added: number;
    readonly updated: number;
    readonly same: number;
    readonly skipped: number;
    readonly message?: string;
}
/** 执行卡片来源（I2）。 */
export type ExperienceSource = 'pipeline' | 'queue' | 'cron' | 'manual';
/** 问题与解决方案笔记（I2）。 */
export interface ExperienceNote {
    readonly problem: string;
    readonly solution: string;
    readonly ts: number;
}
/** 执行卡片（I2 核心实体）。 */
export interface ExperienceCard {
    readonly id: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly source: ExperienceSource;
    readonly sourceId: string;
    readonly runId: string;
    readonly title: string;
    readonly model: string;
    readonly promptSummary: string;
    readonly durationMs: number;
    readonly tokens: number;
    readonly ok: boolean;
    readonly error: string;
    readonly tags: readonly string[];
    readonly notes: readonly ExperienceNote[];
}
/** 评审状态（I3）。 */
export type ReviewStatus = 'open' | 'approved' | 'rejected' | 'merged';
/** Prompt 变更评审请求（I3）。 */
export interface ReviewRequest {
    readonly id: string;
    readonly title: string;
    readonly baseContent: string;
    readonly proposedContent: string;
    readonly author: string;
    readonly note: string;
    readonly status: ReviewStatus;
    readonly createdAt: number;
    readonly updatedAt: number;
    /** 合并后生成的 Prompt 主版本号（status='merged' 时有值）。 */
    readonly mergedVersion: number;
}
/** 评论批注锚点（I3）。 */
export interface ReviewAnchor {
    readonly side: 'base' | 'proposed';
    readonly line: number;
}
/** 评审评论（I3）。 */
export interface ReviewComment {
    readonly id: string;
    readonly reviewId: string;
    readonly author: string;
    readonly content: string;
    readonly anchor: ReviewAnchor;
    readonly createdAt: number;
}
/** 审核决定（I3）。 */
export interface ReviewDecision {
    readonly reviewId: string;
    readonly reviewer: string;
    readonly verdict: 'approve' | 'reject';
    readonly comment: string;
    readonly ts: number;
}
/** 读取团队偏好。 */
export declare function fetchTeamPrefs(options?: RequestOptions): Promise<{
    prefs: TeamPrefs;
}>;
/** 保存团队偏好（稀疏补丁）。 */
export declare function saveTeamPrefs(patch: {
    memberName?: string;
    defaultStrategy?: MergeStrategy;
}, options?: RequestOptions): Promise<{
    prefs: TeamPrefs;
}>;
/** 导出团队配置快照。 */
export declare function exportTeamConfig(options?: RequestOptions): Promise<{
    snapshot: TeamConfigSnapshot;
}>;
/** 计算远程快照与本地配置的差异。 */
export declare function diffTeamConfig(snapshot: unknown, options?: RequestOptions): Promise<{
    diffs: readonly ConfigDiffEntry[];
}>;
/** 按合并策略导入团队配置快照。 */
export declare function importTeamConfig(request: {
    snapshot: unknown;
    strategy: MergeStrategy;
}, options?: RequestOptions): Promise<{
    reports: readonly SectionReport[];
}>;
/** 读取最近导入的配置快照归档。 */
export declare function fetchTeamSnapshots(options?: RequestOptions): Promise<{
    snapshots: readonly TeamConfigSnapshot[];
}>;
/** 删除归档快照（以导出时间戳为键）。 */
export declare function deleteTeamSnapshot(key: string): Promise<OkResponse>;
/** 检索执行卡片（关键词/标签/模型三条件 AND）。 */
export declare function fetchExperienceCards(params: {
    query?: string;
    tags?: string;
    model?: string;
    limit?: number;
}, options?: RequestOptions): Promise<{
    cards: readonly ExperienceCard[];
}>;
/** 手动创建执行卡片。 */
export declare function createExperienceCard(request: {
    title: string;
    model?: string;
    tags?: readonly string[];
    promptSummary?: string;
    source?: ExperienceSource;
}, options?: RequestOptions): Promise<{
    card: ExperienceCard;
}>;
/** 为执行卡片补充问题与解决方案笔记。 */
export declare function addExperienceNote(request: {
    id: string;
    problem: string;
    solution: string;
}, options?: RequestOptions): Promise<{
    card: ExperienceCard;
}>;
/** 删除执行卡片。 */
export declare function deleteExperienceCard(id: string): Promise<OkResponse>;
/** 相似推荐执行卡片。 */
export declare function recommendExperience(request: {
    text: string;
    limit?: number;
}, options?: RequestOptions): Promise<{
    results: ReadonlyArray<{
        card: ExperienceCard;
        score: number;
    }>;
}>;
/** 列出全部 Prompt 评审请求。 */
export declare function fetchReviews(options?: RequestOptions): Promise<{
    reviews: readonly ReviewRequest[];
}>;
/** 创建 Prompt 评审请求。 */
export declare function createReview(request: {
    title: string;
    baseContent?: string;
    proposedContent: string;
    note?: string;
}, options?: RequestOptions): Promise<{
    review: ReviewRequest;
}>;
/** 读取评审详情（请求 + 评论 + 审核决定）。 */
export declare function fetchReviewDetail(id: string, options?: RequestOptions): Promise<{
    review: ReviewRequest;
    comments: readonly ReviewComment[];
    decisions: readonly ReviewDecision[];
}>;
/** 添加评审评论批注。 */
export declare function addReviewComment(request: {
    reviewId: string;
    content: string;
    anchor?: ReviewAnchor;
}, options?: RequestOptions): Promise<{
    comment: ReviewComment;
}>;
/** 提交审核决定（通过/拒绝）。 */
export declare function decideReview(request: {
    reviewId: string;
    verdict: 'approve' | 'reject';
    comment?: string;
}, options?: RequestOptions): Promise<{
    decision: ReviewDecision;
}>;
/** 合并已通过评审进 Prompt 主版本。 */
export declare function mergeReview(reviewId: string, options?: RequestOptions): Promise<{
    ok: true;
    mergedVersion: number;
}>;
/** 删除评审（级联清理评论与决定）。 */
export declare function deleteReview(id: string): Promise<OkResponse>;
/** 将 base64 字符串解码为 Blob（二进制安全，不经 atob→字符串 的 Latin-1 陷阱）。 */
export declare function base64ToBlob(b64: string, mime: string): Blob;
/** 通过 objectURL + `<a download>` 触发浏览器下载。 */
export declare function downloadBlob(blob: Blob, fileName: string): void;
/** 在新窗口写入完整 HTML 并触发浏览器打印（用于 PDF 含非 Latin-1 内容的降级路径）。 */
export declare function openPrintHtml(html: string): void;
