/**
 * 浏览器端 API 层：DESIGN.md 第 4 节私有 HTTP API 的类型化 fetch 封装。
 *
 * 契约要点：
 * - 全部端点为同源 `/companion` 前缀下的 JSON 接口；
 * - 非 2xx 响应统一携带 `{ "error": string }`，在此统一解析为 CompanionApiError；
 * - 字节内容以 base64 传输，客户端解码为 Blob 后触发下载；
 * - 不导入 node:* 或宿主代码，本模块仅依赖浏览器内置能力。
 */
// ---------------------------------------------------------------------------
// 通用：错误、基础类型与 fetch 封装
// ---------------------------------------------------------------------------
/** 私有 API 统一前缀（同源请求，见 DESIGN.md 第 4 节）。 */
const API_PREFIX = '/companion';
/** API 层统一抛出的错误：携带 HTTP 状态码与服务端错误文案。 */
export class CompanionApiError extends Error {
    /** HTTP 状态码。 */
    status;
    constructor(status, message) {
        super(message);
        this.name = 'CompanionApiError';
        this.status = status;
    }
}
/** 缺省请求超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30_000;
/** fetch 网络层不可达时的统一错误文案。 */
const NETWORK_UNREACHABLE_MESSAGE = '无法连接 Companion 服务，请确认 Harness 已启动且插件已加载';
/**
 * 带超时与外部取消联动的 fetch 封装：
 * - 内部持有 AbortController，超时（setTimeout）与外部 signal 都中止同一控制器；
 * - 外部 signal 先中止时透传其中止原因；请求结束后清理定时器与事件监听；
 * - fetch 网络层失败（TypeError）统一包装为 CompanionApiError(0, …)，
 *   中止（AbortError 等）与其他错误原样抛出。
 */
async function fetchWithGuard(url, init, options) {
    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = window.setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
    const externalSignal = options?.signal;
    const onExternalAbort = () => {
        controller.abort(externalSignal?.reason);
    };
    if (externalSignal) {
        if (externalSignal.aborted) {
            onExternalAbort();
        }
        else {
            externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
    }
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    }
    catch (error) {
        if (error instanceof TypeError) {
            throw new CompanionApiError(0, NETWORK_UNREACHABLE_MESSAGE);
        }
        throw error;
    }
    finally {
        window.clearTimeout(timer);
        externalSignal?.removeEventListener('abort', onExternalAbort);
    }
}
/** 收窄服务端错误体：契约规定非 2xx 一律携带 `{ error: string }`。 */
function extractErrorMessage(payload, status) {
    if (typeof payload === 'object' && payload !== null) {
        const error = payload.error;
        if (typeof error === 'string' && error.length > 0)
            return error;
    }
    return `请求失败（HTTP ${status}）`;
}
/** 统一响应解析：非 2xx 读取 `{ error }` 并抛错；成功则解析 JSON。 */
async function parseResponse(response) {
    const text = await response.text();
    let payload;
    try {
        payload = text.length > 0 ? JSON.parse(text) : {};
    }
    catch {
        throw new CompanionApiError(response.status, `服务端响应不是合法 JSON（HTTP ${response.status}）`);
    }
    if (!response.ok) {
        throw new CompanionApiError(response.status, extractErrorMessage(payload, response.status));
    }
    return payload;
}
function buildQuery(params) {
    if (!params)
        return '';
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === '')
            continue;
        search.set(key, String(value));
    }
    const text = search.toString();
    return text.length > 0 ? `?${text}` : '';
}
/** 类型化 GET 封装。options 可选：外部取消信号与超时（缺省 30s）。 */
export async function companionGet(path, params, options) {
    const response = await fetchWithGuard(`${API_PREFIX}${path}${buildQuery(params)}`, {}, options);
    return parseResponse(response);
}
/** 类型化 POST 封装（JSON 请求体）。options 可选：外部取消信号与超时（缺省 30s）。 */
export async function companionPost(path, body, options) {
    const response = await fetchWithGuard(`${API_PREFIX}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    }, options);
    return parseResponse(response);
}
/** 类型化 DELETE 封装（契约允许 DELETE 携带 JSON 请求体）。options 可选：外部取消信号与超时（缺省 30s）。 */
export async function companionDelete(path, body, options) {
    const hasBody = body !== undefined;
    const response = await fetchWithGuard(`${API_PREFIX}${path}`, {
        method: 'DELETE',
        headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
        body: hasBody ? JSON.stringify(body) : undefined,
    }, options);
    return parseResponse(response);
}
/** 列出可导出的会话。 */
export function fetchExportSessions(options) {
    return companionGet('/export/sessions', undefined, options);
}
/** 导出单个会话。 */
export function runExport(request, options) {
    return companionPost('/export/run', request, options);
}
/** 批量导出多个会话为 ZIP。 */
export function runExportBatch(request, options) {
    return companionPost('/export/batch', request, options);
}
/** 合规签名导出：签署文本格式导出内容，返回文件与公证书。 */
export function signCustodyExport(request, options) {
    return companionPost('/export/custody/sign', request, options);
}
/** 核验已签署文档：文件内容 + 公证书逐项验证（防篡改）。 */
export function verifyCustodyDocument(request, options) {
    return companionPost('/export/custody/verify', request, options);
}
/** 公证登记簿：全部签署记录 + 全链核验（含断裂点定位）。 */
export function fetchCustodyChain(options) {
    return companionGet('/export/custody/chain', undefined, options);
}
/** Merkle 可验证批量导出：逐会话叶哈希 → Merkle 根 → ZIP + 登记表成对交付。 */
export function buildMerkleExport(request, options) {
    return companionPost('/export/merkle/build', request, options);
}
/** 获取批次内指定文件的包含证明（交给第三方复算）。 */
export function fetchMerkleProof(request, options) {
    return companionPost('/export/merkle/proof', request, options);
}
/** 核验一份文件确属某根哈希承诺的批次（登记/内容/证明三关）。 */
export function verifyMerkleInclusion(request, options) {
    return companionPost('/export/merkle/verify', request, options);
}
/** 已发布批次清单（根哈希登记簿）。 */
export function fetchMerkleRoots(options) {
    return companionGet('/export/merkle/roots', undefined, options);
}
/** 为指定会话生成交接摘要。 */
export function generateHandoff(request, options) {
    return companionPost('/handoff/generate', request, options);
}
/** 列出全部交接摘要模板。 */
export function fetchHandoffTemplates(options) {
    return companionGet('/handoff/templates', undefined, options);
}
/** 保存（覆盖）一个模板。 */
export function saveHandoffTemplate(request) {
    return companionPost('/handoff/templates', request);
}
/** 删除一个模板。 */
export function deleteHandoffTemplate(name) {
    return companionDelete('/handoff/templates', { name });
}
/** 导入摘要：带 sessionId 注入指定会话，不带则武装给下一个新对话。 */
export function importHandoff(request) {
    return companionPost('/handoff/import', request);
}
/** 查询当前已武装的交接摘要。 */
export function fetchArmedHandoffs(options) {
    return companionGet('/handoff/armed', undefined, options);
}
/** 移除已武装的交接摘要。 */
export function dismissArmedHandoff(request) {
    return companionDelete('/handoff/armed', request);
}
/** 生成结构化分级交接（四级分层 + 锚定强制继承 + 世系链）。arm='pending' 时武装给下一个新对话。 */
export function generateStructuredHandoff(request, options) {
    return companionPost('/handoff/structured', request, options);
}
/** 世系链总览（按创建时间降序）。 */
export function fetchHandoffLineage(options) {
    return companionGet('/handoff/lineage', undefined, options);
}
/** 世系溯源：沿 parent 链向上追到根（含各代锚定约束与处置记录）。 */
export function traceHandoffLineage(handoffId, options) {
    return companionGet('/handoff/lineage/trace', { handoffId }, options);
}
/** 渐进式蒸馏：零模型调用、确定性；可选武装给下一个新对话。 */
export function distillSessionContext(request, options) {
    return companionPost('/handoff/distill', request, options);
}
/** 交接投递前的就绪度评估（缺省评估最近一次结构化交接）。 */
export function fetchHandoffReadiness(handoffId, options) {
    return companionGet('/handoff/readiness', { handoffId }, options);
}
/** 读取成本状态（保险库不回传 Key 明文，只有 apiKeyConfigured 布尔）。 */
export function fetchCostState(options) {
    return companionGet('/cost/state', undefined, options);
}
/** 保存 API Key（服务端 AES-256-GCM 加密落盘）。 */
export function saveCostApiKey(apiKey) {
    return companionPost('/cost/api-key', { apiKey });
}
/** 删除已保存的 API Key。 */
export function removeCostApiKey() {
    return companionDelete('/cost/api-key');
}
/** 更新成本设置（稀疏补丁）。 */
export function updateCostSettings(patch) {
    return companionPost('/cost/settings', patch);
}
/** 读取 [from, to]（YYYY-MM-DD，北京时间）区间的成本报表。 */
export function fetchCostReport(range, options) {
    return companionGet('/cost/report', { from: range.from, to: range.to }, options);
}
/** 用当前 Key 发起一次最小测试调用，验证连通性。 */
export function testCostCall() {
    return companionPost('/cost/test-call');
}
/** 读取动态计价引擎面板数据（各厂商官方定价、峰谷计划、用户覆盖）。 */
export function fetchCostPricing(options) {
    return companionGet('/cost/pricing', undefined, options);
}
/** 手动触发官方定价页刷新（DeepSeek + 全部国产厂商），返回刷新后的面板数据。 */
export function refreshCostPricing(options) {
    return companionPost('/cost/pricing/refresh', undefined, options);
}
/** 读取自适应路由赌臂统计。 */
export function fetchCostAdaptive(options) {
    return companionGet('/cost/adaptive', undefined, options);
}
/** 清空学习状态（cls 缺省全清；'simple'|'complex' 只清单一类别）。 */
export function resetCostAdaptive(cls) {
    return companionPost(cls === undefined ? '/cost/adaptive/reset' : `/cost/adaptive/reset?cls=${cls}`);
}
/** 成本预测：历史拟合 + 未来 7 天外推 + 预算 ETA + 突变检测。 */
export function fetchCostForecast(days, options) {
    return companionGet('/cost/forecast', { days }, options);
}
/** 近重复请求查询（threshold ∈ [0.5, 1]，缺省 0.85）。 */
export function lookupSemanticCache(request, options) {
    return companionPost('/cost/cache/lookup', request, options);
}
/** 缓存回填：miss 后真实执行调用，将 prompt/响应/用量写回缓存供复用。 */
export function storeSemanticCache(request, options) {
    return companionPost('/cost/cache/store', request, options);
}
/** 缓存面板：容量/命中率/累计节省与最近条目。 */
export function fetchSemanticCacheStats(options) {
    return companionGet('/cost/cache/stats', undefined, options);
}
/** 清空语义缓存（重置条目与统计）。 */
export function clearSemanticCache(options) {
    return companionDelete('/cost/cache', undefined, options);
}
/** 跨会话全文检索。 */
export function searchSessions(request) {
    return companionGet('/search', {
        query: request.query,
        from: request.from,
        to: request.to,
        tags: request.tags && request.tags.length > 0 ? request.tags.join(',') : undefined,
        limit: request.limit,
    });
}
/** 读取单个会话的标签。 */
export function fetchSessionTags(sessionId) {
    return companionGet('/tags', { sessionId });
}
/** 读取全量标签映射（标签 → 会话 id 列表）。 */
export function fetchAllTags() {
    return companionGet('/tags');
}
/** 为会话增删标签。 */
export function updateSessionTags(request) {
    return companionPost('/tags', request);
}
/** 语义邻域检索：shingle 邻域 + PRF 查询扩展 + 多源 RRF 融合。 */
export function searchSessionsSemantic(params, options) {
    return companionGet('/search/semantic', params, options);
}
/** 相似会话（more-like-this）：与指定会话内容最像的历史会话。 */
export function fetchSimilarSessions(params, options) {
    return companionGet('/search/similar', params, options);
}
/** 记忆图谱整体报告（PageRank 枢纽排序）。 */
export function fetchMemoryGraph(options) {
    return companionGet('/search/graph', undefined, options);
}
/** 实体邻域查询：关联实体（边权降序）+ 关联会话。 */
export function fetchEntityNeighborhood(name, options) {
    return companionGet('/search/graph/entity', { name }, options);
}
/** 点击反馈重排检索（展示即记录曝光，供下次去偏学习）。 */
export function rerankSearch(request, options) {
    return companionPost('/search/rerank', request, options);
}
/** 记录一次结果点击（位次从 1 起）。 */
export function recordSearchClick(request, options) {
    return companionPost('/search/click', request, options);
}
/** 点击模型面板：事件量/全局率/最强会话信号。 */
export function fetchClickModelStats(options) {
    return companionGet('/search/clicks/stats', undefined, options);
}
/** 从会话日志派生并分析轨迹。 */
export function deriveTrace(sessionId, options) {
    return companionGet('/trace/derive', { sessionId }, options);
}
/** 列出可分析的会话。 */
export function fetchTraceSessions(options) {
    return companionGet('/trace/sessions', undefined, options);
}
/** 对比两条轨迹（format 缺省返回 json；'html' 返回自包含对比报告）。 */
export function diffTraces(request, options) {
    return companionPost('/trace/diff', request, options);
}
/** 读取轨迹日聚合趋势与历史基准线。 */
export function fetchTraceStats(range, options) {
    return companionGet('/trace/stats', { from: range.from, to: range.to }, options);
}
/** 摄入 Harness 原生轨迹 JSON。 */
export function ingestTrace(request, options) {
    return companionPost('/trace/ingest', request, options);
}
/** 读取 SPC 控制图（EWMA + Western Electric 规则）。参数缺省 metric=duration-per-trace、lambda=0.3、limitWidth=3。 */
export function fetchTraceSpc(params, options) {
    return companionGet('/trace/spc', params, options);
}
/** 挖掘失败前兆库（n-gram 模式 + 提升度排序）。 */
export function fetchTracePrecursors(options) {
    return companionGet('/trace/precursors', undefined, options);
}
/** 对进行中轨迹做实时预警（traceId 或 sessionId 二选一）。 */
export function checkTracePrecursors(request, options) {
    return companionPost('/trace/precursors/check', request, options);
}
/** 频谱根因定位：对比失败/成功轨迹的组件覆盖，量化各组件可疑度。 */
export function localizeFaults(options) {
    return companionGet('/trace/localize', undefined, options);
}
/** 读取 Prompt 版本历史。 */
export function fetchPromptVersions(options) {
    return companionGet('/prompt/versions', undefined, options);
}
/** 保存新 Prompt 版本。 */
export function savePromptVersion(request) {
    return companionPost('/prompt/versions', request);
}
/** 回滚到指定版本。 */
export function rollbackPromptVersion(request) {
    return companionPost('/prompt/rollback', request);
}
/** 为版本增删标签。 */
export function updatePromptTags(request) {
    return companionPost('/prompt/tags', request);
}
/** 运行 A/B 测试。 */
export function runAbTest(request, options) {
    return companionPost('/prompt/ab-test', request, options);
}
/** 提交人工评分。 */
export function rateAbTest(request) {
    return companionPost('/prompt/rate', request);
}
/** 读取模板库。 */
export function fetchPromptTemplates(options) {
    return companionGet('/prompt/templates', undefined, options);
}
/** 保存模板。 */
export function savePromptTemplate(request) {
    return companionPost('/prompt/templates', request);
}
/** 删除模板。 */
export function deletePromptTemplate(name) {
    return companionDelete('/prompt/templates', { name });
}
/** 变量插值渲染。 */
export function renderPromptTemplate(request) {
    return companionPost('/prompt/render', request);
}
/** 生成 API 调用代码。 */
export function generateApiCode(request) {
    return companionPost('/prompt/codegen', request);
}
/** 结构化输出批量校验。 */
export function validateStructuredOutput(request, options) {
    return companionPost('/prompt/validate', request, options);
}
/** 自动优化 Prompt：元提示生成候选 → 批量评测 → 配对显著性检验，显著胜者晋升版本库。 */
export function optimizePrompt(request, options) {
    return companionPost('/prompt/optimize', request, options);
}
/** 读取 A/B 人工评级汇总。 */
export function fetchPromptRatings(options) {
    return companionGet('/prompt/ratings', undefined, options);
}
/** Prompt 预算编译：在 Token 预算内组件级裁剪，最大化保真度。 */
export function compilePrompt(request, options) {
    return companionPost('/prompt/compile', request, options);
}
/** 创建变体寻优实验（≥2 个互不相同变体 + 用例集）。 */
export function createBanditExperiment(request, options) {
    return companionPost('/prompt/bandit', request, options);
}
/** 实验列表。 */
export function fetchBanditExperiments(options) {
    return companionGet('/prompt/bandit', undefined, options);
}
/** 读取实验详情 + 后验分析（P(best)/期望损失/95% CI/停止裁决）。 */
export function fetchBanditExperiment(id, options) {
    return companionGet('/prompt/bandit/get', { id }, options);
}
/** 执行 N 轮 Thompson 采样（后验选臂 → 轮转用例 → Beta 更新）。 */
export function pullBandit(request, options) {
    return companionPost('/prompt/bandit/pull', request, options);
}
/** 删除实验。 */
export function deleteBanditExperiment(id, options) {
    return companionDelete('/prompt/bandit', { id }, options);
}
/** 读取模型目录。 */
export function fetchArenaModels(options) {
    return companionGet('/arena/models', undefined, options);
}
/** 保存外部厂商 API Key（服务端加密落盘）。 */
export function saveArenaKey(request) {
    return companionPost('/arena/keys', request);
}
/** 删除外部厂商 API Key。 */
export function removeArenaKey(modelId) {
    return companionDelete('/arena/keys', { modelId });
}
/** 添加/更新用户自定义模型（OpenAI 兼容）。 */
export function addArenaCustomModel(request) {
    return companionPost('/arena/custom-models', request);
}
/** 删除用户自定义模型（连同其 Key）。 */
export function removeArenaCustomModel(modelId) {
    return companionDelete('/arena/custom-models', { modelId });
}
/** G1 同 Prompt 多模型并行对比。 */
export function runArenaCompare(request, options) {
    return companionPost('/arena/compare', request, options);
}
/** G2 批量评测排行榜（format 缺省返回 json；useCache=true 时导出复用最近评测结果，不重跑）。 */
export function runArenaLeaderboard(request, options) {
    return companionPost('/arena/leaderboard', request, options);
}
/** G3 模型推荐。 */
export function fetchArenaRecommendation(params, options) {
    return companionGet('/arena/recommend', params, options);
}
/** 对指定模型运行确定性探针组并比对基线（单次最多 5 个模型）。 */
export function runCanaryProbes(request, options) {
    return companionPost('/arena/canary/run', request, options);
}
/** 查看漂移报告（不发起任何调用）：带 model 为单模型详情，缺省为全部模型概览。 */
export function fetchCanaryReport(model, options) {
    return companionGet('/arena/canary/report', { model }, options);
}
export function fetchCanaryOverview(options) {
    return companionGet('/arena/canary/report', undefined, options);
}
/** 重置基线（确认厂商更新后重新锚定）。 */
export function resetCanaryBaseline(request, options) {
    return companionPost('/arena/canary/reset', request, options);
}
/** 能力-成本-延迟三维帕累托前沿分析（Elo × 计价 × 金丝雀延迟）。 */
export function fetchArenaFrontier(options) {
    return companionGet('/arena/frontier', undefined, options);
}
/** 列出全部流水线。 */
export function fetchPipelines(options) {
    return companionGet('/orchestrator/pipelines', undefined, options);
}
/** 创建或更新流水线（携带 id 为更新）。 */
export function savePipeline(request, options) {
    return companionPost('/orchestrator/pipelines', request, options);
}
/** 删除流水线。 */
export function deletePipeline(id) {
    return companionDelete('/orchestrator/pipelines', { id });
}
/** 读取流水线自动生成的 YAML 配置。 */
export function fetchPipelineYaml(id, options) {
    return companionGet('/orchestrator/pipelines/yaml', { id }, options);
}
/** 启动一次执行（后台异步，立即返回 runId）。 */
export function startPipelineRun(pipelineId, options) {
    return companionPost('/orchestrator/runs', { pipelineId }, options);
}
/** 断点续跑：从最后成功步骤继续。 */
export function resumePipelineRun(runId, options) {
    return companionPost('/orchestrator/runs/resume', { runId }, options);
}
/** 暂停执行。 */
export function pausePipelineRun(runId) {
    return companionPost('/orchestrator/runs/pause', { runId });
}
/** 取消执行。 */
export function cancelPipelineRun(runId) {
    return companionPost('/orchestrator/runs/cancel', { runId });
}
/** 列出执行记录（可按流水线过滤）。 */
export function fetchPipelineRuns(pipelineId, options) {
    return companionGet('/orchestrator/runs', { pipelineId }, options);
}
/** 读取单次执行详情（含各步骤中间结果）。 */
export function fetchPipelineRun(id, options) {
    return companionGet('/orchestrator/runs/get', { id }, options);
}
/** 删除执行记录。 */
export function deletePipelineRun(id) {
    return companionDelete('/orchestrator/runs', { id });
}
/** 读取批量队列（任务列表 + 计数）。 */
export function fetchQueue(options) {
    return companionGet('/orchestrator/queue', undefined, options);
}
/** 提交批量任务。 */
export function submitQueueTask(request, options) {
    return companionPost('/orchestrator/queue', request, options);
}
/** 取消队列任务。 */
export function cancelQueueTask(id) {
    return companionPost('/orchestrator/queue/cancel', { id });
}
/** 暂停排队中的任务。 */
export function pauseQueueTask(id) {
    return companionPost('/orchestrator/queue/pause', { id });
}
/** 恢复已暂停的任务。 */
export function resumeQueueTask(id) {
    return companionPost('/orchestrator/queue/resume', { id });
}
/** 批量操作队列（pause/resume/cancel 全部可操作任务）。 */
export function batchQueue(action) {
    return companionPost('/orchestrator/queue/batch', { action });
}
/** 删除队列任务记录。 */
export function deleteQueueTask(id) {
    return companionDelete('/orchestrator/queue', { id });
}
/** 列出定时任务。 */
export function fetchJobs(options) {
    return companionGet('/orchestrator/jobs', undefined, options);
}
/** 自然语言/Cron 解析预检。 */
export function parseSchedule(text, options) {
    return companionPost('/orchestrator/parse-schedule', { text }, options);
}
/** 创建或更新定时任务（携带 id 为更新）。 */
export function saveJob(request, options) {
    return companionPost('/orchestrator/jobs', request, options);
}
/** 启用/停用定时任务。 */
export function toggleJob(id, enabled) {
    return companionPost('/orchestrator/jobs/toggle', { id, enabled });
}
/** 删除定时任务。 */
export function deleteJob(id) {
    return companionDelete('/orchestrator/jobs', { id });
}
/** 读取定时任务历史执行记录。 */
export function fetchJobRuns(jobId, options) {
    return companionGet('/orchestrator/jobs/runs', { jobId }, options);
}
/** 读取模型断路器全景。 */
export function fetchCircuits(options) {
    return companionGet('/orchestrator/circuits', undefined, options);
}
/** 蒙特卡洛工期模拟（iterations 缺省 2000；parallelism 限定并行工人上限）。 */
export function simulatePipelineDuration(request, options) {
    return companionPost('/orchestrator/monte', request, options);
}
/** 读取命名 Key 列表（不回传明文）。 */
export function fetchSecurityKeys(options) {
    return companionGet('/security/keys', undefined, options);
}
/** 保存命名 Key（服务端加密落盘）。 */
export function saveSecurityKey(request, options) {
    return companionPost('/security/keys', request, options);
}
/** 切换激活 Key。 */
export function activateSecurityKey(name) {
    return companionPost('/security/keys/activate', { name });
}
/** 删除命名 Key。 */
export function deleteSecurityKey(name) {
    return companionDelete('/security/keys', { name });
}
/** Key 泄露检测（粘贴疑似泄露内容进行检查）。 */
export function checkKeyLeak(content, options) {
    return companionPost('/security/keys/leak-check', { content }, options);
}
/** 读取 Key 轮换到期提醒。 */
export function fetchKeyRotation(options) {
    return companionGet('/security/keys/rotation', undefined, options);
}
/** 查询审计日志（支持时间/模型/状态筛选）。 */
export function fetchAuditLog(params, options) {
    return companionGet('/security/audit', params, options);
}
/** 导出审计日志（CSV/JSON）。 */
export function exportAuditLog(params, options) {
    return companionGet('/security/audit/export', params, options);
}
/** 读取 DLP 状态（设置 + 规则）。 */
export function fetchDlpState(options) {
    return companionGet('/security/dlp/state', undefined, options);
}
/** 更新 DLP 设置。 */
export function updateDlpSettings(patch) {
    return companionPost('/security/dlp/settings', patch);
}
/** 新增自定义 DLP 规则。 */
export function addDlpRule(request, options) {
    return companionPost('/security/dlp/rules', request, options);
}
/** 启用/停用 DLP 规则。 */
export function toggleDlpRule(id, enabled) {
    return companionPost('/security/dlp/rules/toggle', { id, enabled });
}
/** 删除自定义 DLP 规则。 */
export function deleteDlpRule(id) {
    return companionDelete('/security/dlp/rules', { id });
}
/** DLP 发送前预检扫描。 */
export function scanDlp(text, options) {
    return companionPost('/security/dlp/scan', { text }, options);
}
/** 读取注入检测状态（设置 + 检测器清单）。 */
export function fetchInjectionState(options) {
    return companionGet('/security/injection/state', undefined, options);
}
/** 更新注入检测设置（稀疏补丁）。 */
export function updateInjectionSettings(patch, options) {
    return companionPost('/security/injection/settings', patch, options);
}
/** 提示注入扫描（发送前预检）。 */
export function scanInjection(text, options) {
    return companionPost('/security/injection/scan', { text }, options);
}
/** 读取合规报表。 */
export function fetchComplianceReport(range, options) {
    return companionGet('/security/report', { from: range.from, to: range.to }, options);
}
/** 导出合规报表（自包含 HTML，经浏览器打印可另存 PDF）。 */
export function exportComplianceReport(range, options) {
    return companionGet('/security/report/export', { from: range.from, to: range.to }, options);
}
/** 敏感数据污点追踪：源 → 传播链 → 外发汇点的完整泄露路径。 */
export function scanTaint(sessionId, options) {
    return companionPost('/security/taint/scan', { sessionId }, options);
}
/** 读取团队偏好。 */
export function fetchTeamPrefs(options) {
    return companionGet('/team/prefs', undefined, options);
}
/** 保存团队偏好（稀疏补丁）。 */
export function saveTeamPrefs(patch, options) {
    return companionPost('/team/prefs', patch, options);
}
/** 导出团队配置快照。 */
export function exportTeamConfig(options) {
    return companionGet('/team/config/export', undefined, options);
}
/** 计算远程快照与本地配置的差异。 */
export function diffTeamConfig(snapshot, options) {
    return companionPost('/team/config/diff', { snapshot }, options);
}
/** 按合并策略导入团队配置快照。 */
export function importTeamConfig(request, options) {
    return companionPost('/team/config/import', request, options);
}
/** 读取最近导入的配置快照归档。 */
export function fetchTeamSnapshots(options) {
    return companionGet('/team/snapshots', undefined, options);
}
/** 删除归档快照（以导出时间戳为键）。 */
export function deleteTeamSnapshot(key) {
    return companionDelete('/team/snapshots', { key });
}
/** 检索执行卡片（关键词/标签/模型三条件 AND）。 */
export function fetchExperienceCards(params, options) {
    return companionGet('/team/experience', params, options);
}
/** 手动创建执行卡片。 */
export function createExperienceCard(request, options) {
    return companionPost('/team/experience', request, options);
}
/** 为执行卡片补充问题与解决方案笔记。 */
export function addExperienceNote(request, options) {
    return companionPost('/team/experience/notes', request, options);
}
/** 删除执行卡片。 */
export function deleteExperienceCard(id) {
    return companionDelete('/team/experience', { id });
}
/** 相似推荐执行卡片。 */
export function recommendExperience(request, options) {
    return companionPost('/team/experience/recommend', request, options);
}
/** 蒸馏单个会话：信号挖矿 → 元提示蒸馏 → 语义去重落库。 */
export function distillSessionExperience(request, options) {
    return companionPost('/team/experience/distill', request, options);
}
/** 批量挖矿：本地信号打分筛选高信号会话后仅蒸馏高价值轨迹。 */
export function scanDistillExperience(request, options) {
    return companionPost('/team/experience/distill/scan', request, options);
}
/** 蒸馏卡列表（按置信度降序）。 */
export function fetchDistilledCards(options) {
    return companionGet('/team/experience/distilled', undefined, options);
}
/** 晋升蒸馏卡为正式执行经验卡（人工把关闭环）。 */
export function promoteDistilledCard(request, options) {
    return companionPost('/team/experience/distilled/promote', request, options);
}
/** 删除蒸馏卡。 */
export function deleteDistilledCard(id) {
    return companionDelete('/team/experience/distilled', { id });
}
/** 列出全部 Prompt 评审请求。 */
export function fetchReviews(options) {
    return companionGet('/team/reviews', undefined, options);
}
/** 创建 Prompt 评审请求。 */
export function createReview(request, options) {
    return companionPost('/team/reviews', request, options);
}
/** 读取评审详情（请求 + 评论 + 审核决定）。 */
export function fetchReviewDetail(id, options) {
    return companionGet('/team/reviews/get', { id }, options);
}
/** 添加评审评论批注。 */
export function addReviewComment(request, options) {
    return companionPost('/team/reviews/comment', request, options);
}
/** 提交审核决定（通过/拒绝）。 */
export function decideReview(request, options) {
    return companionPost('/team/reviews/decide', request, options);
}
/** 合并已通过评审进 Prompt 主版本。 */
export function mergeReview(reviewId, options) {
    return companionPost('/team/reviews/merge', { reviewId }, options);
}
/** 删除评审（级联清理评论与决定）。 */
export function deleteReview(id) {
    return companionDelete('/team/reviews', { id });
}
/** 注册/更新专家（同名视为同一专家，更新其领域与简介）。 */
export function saveExpert(request, options) {
    return companionPost('/team/experts', request, options);
}
/** 专家目录。 */
export function fetchExperts(options) {
    return companionGet('/team/experts', undefined, options);
}
/** 删除专家。 */
export function deleteExpert(id, options) {
    return companionDelete('/team/experts', { id }, options);
}
/** 知识足迹画像面板（全部专家的 TF-IDF 顶部术语）。 */
export function fetchExpertProfiles(options) {
    return companionGet('/team/experts/profiles', undefined, options);
}
/** 专家路由：问题 → 余弦匹配 → 推荐专家 + 知识盲区检测。 */
export function routeToExpert(question, options) {
    return companionPost('/team/experts/route', { question }, options);
}
/** Shapley 成本分账：各部门用量 + 厂商阶梯折扣表 → 边际贡献公平分账。 */
export function attributeCost(request, options) {
    return companionPost('/cost/attribution', request, options);
}
/** k-匿名化：批量数据发布前的再识别风险评估与泛化发布。 */
export function kanonymize(request, options) {
    return companionPost('/security/kanonymize', request, options);
}
/** 孤立森林轨迹异常检测：7 维特征 + 全局异常评分。 */
export function fetchTraceAnomalies(params, options) {
    return companionGet('/trace/anomalies', params, options);
}
/** 提交一次偏好对战（评级 + RD + 波动率联合更新），返回新排行。 */
export function recordGlickoMatch(request, options) {
    return companionPost('/arena/glicko/match', request, options);
}
/** Glicko-2 评级表（保守分排名 + 95% CI + 闲置 RD 增长）。 */
export function fetchGlickoStandings(options) {
    return companionGet('/arena/glicko', undefined, options);
}
/** 清空全部 Glicko-2 对战与评级。 */
export function resetGlicko(options) {
    return companionPost('/arena/glicko/reset', undefined, options);
}
/** 关键路径分析：确定性 CPM + 并发画像 + 瓶颈识别。 */
export function analyzeCriticalPath(request, options) {
    return companionPost('/orchestrator/cpm', request, options);
}
/** Prompt 静态分析：矛盾指令/占位符/模糊量词检测 + 复杂度度量（零模型调用）。 */
export function lintPrompt(request, options) {
    return companionPost('/prompt/lint', request, options);
}
/** MMR 多样性重排：λ 权衡相关性与冗余，附去重审计。 */
export function diversifySearch(request, options) {
    return companionPost('/search/diversify', request, options);
}
/** Bus Factor 分析：领域覆盖单点风险 + PageRank 协作枢纽。 */
export function fetchBusFactor(options) {
    return companionGet('/team/busfactor', undefined, options);
}
/** 生成交接验收卷（缺省 handoffId 用最近一次结构化交接）。 */
export function fetchAcceptanceSuite(handoffId, options) {
    return companionGet('/handoff/acceptance', handoffId ? { handoffId } : undefined, options);
}
/** 验收评分：提交 {questionId, answer} 数组（卷面按存储的交接确定性重建）。 */
export function gradeAcceptance(request, options) {
    return companionPost('/handoff/acceptance/grade', request, options);
}
/** DP 预算账本面板。 */
export function fetchDpBudgetState(options) {
    return companionGet('/export/dp/state', undefined, options);
}
/** 差分隐私释放：Laplace 加噪 + ε 预算记账（耗尽即拒）。 */
export function releaseDpMetrics(request, options) {
    return companionPost('/export/dp/release', request, options);
}
/** 重置 DP 预算账本（可选同时调整总预算 ε）。 */
export function resetDpBudget(budgetEpsilon, options) {
    return companionPost('/export/dp/reset', budgetEpsilon !== undefined ? { budgetEpsilon } : undefined, options);
}
// ---------------------------------------------------------------------------
// 浏览器工具：base64 解码、下载、打印
// ---------------------------------------------------------------------------
/** 将 base64 字符串解码为 Blob（二进制安全，不经 atob→字符串 的 Latin-1 陷阱）。 */
export function base64ToBlob(b64, mime) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
}
/** 通过 objectURL + `<a download>` 触发浏览器下载。 */
export function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // 延迟释放，确保下载已启动
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
/** 在新窗口写入完整 HTML 并触发浏览器打印（用于 PDF 含非 Latin-1 内容的降级路径）。 */
export function openPrintHtml(html) {
    const win = window.open('', '_blank');
    if (!win) {
        throw new CompanionApiError(0, '浏览器拦截了弹出窗口，请允许弹窗后重试打印导出');
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    // 留出少量渲染时间再唤起打印对话框；若窗口在此期间被关闭则跳过打印
    window.setTimeout(() => {
        if (!win.closed)
            win.print();
    }, 250);
}
