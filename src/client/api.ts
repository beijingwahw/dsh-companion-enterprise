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
const API_PREFIX = '/companion'

/** API 层统一抛出的错误：携带 HTTP 状态码与服务端错误文案。 */
export class CompanionApiError extends Error {
  /** HTTP 状态码。 */
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'CompanionApiError'
    this.status = status
  }
}

/** 通用成功响应（服务端契约 `{ ok: true }`）。 */
export interface OkResponse {
  readonly ok: true
}

/** 会话头信息（客户端视角；跨 JSON 边界，id 为普通字符串）。 */
export interface SessionRecord {
  readonly id: string
  readonly title?: string
  readonly createdAt: number
  readonly updatedAt?: number
}

/** 查询参数表：值为 undefined 或空串的条目不会发出。 */
export type QueryParams = Readonly<Record<string, string | number | undefined>>

/** 可选的请求控制参数：外部取消信号 + 超时时长。 */
export interface RequestOptions {
  /** 外部取消信号；与内部超时共用同一个 AbortController 联动。 */
  readonly signal?: AbortSignal
  /** 超时时长（毫秒），缺省 {@link DEFAULT_TIMEOUT_MS}。 */
  readonly timeoutMs?: number
}

/** 缺省请求超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30_000

/** fetch 网络层不可达时的统一错误文案。 */
const NETWORK_UNREACHABLE_MESSAGE = '无法连接 Companion 服务，请确认 Harness 已启动且插件已加载'

/**
 * 带超时与外部取消联动的 fetch 封装：
 * - 内部持有 AbortController，超时（setTimeout）与外部 signal 都中止同一控制器；
 * - 外部 signal 先中止时透传其中止原因；请求结束后清理定时器与事件监听；
 * - fetch 网络层失败（TypeError）统一包装为 CompanionApiError(0, …)，
 *   中止（AbortError 等）与其他错误原样抛出。
 */
async function fetchWithGuard(url: string, init: RequestInit, options?: RequestOptions): Promise<Response> {
  const controller = new AbortController()
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = window.setTimeout(
    () => controller.abort(new DOMException('请求超时', 'TimeoutError')),
    timeoutMs,
  )
  const externalSignal = options?.signal
  const onExternalAbort = (): void => {
    controller.abort(externalSignal?.reason)
  }
  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort()
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (error instanceof TypeError) {
      throw new CompanionApiError(0, NETWORK_UNREACHABLE_MESSAGE)
    }
    throw error
  } finally {
    window.clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

/** 收窄服务端错误体：契约规定非 2xx 一律携带 `{ error: string }`。 */
function extractErrorMessage(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    const error = (payload as Record<string, unknown>).error
    if (typeof error === 'string' && error.length > 0) return error
  }
  return `请求失败（HTTP ${status}）`
}

/** 统一响应解析：非 2xx 读取 `{ error }` 并抛错；成功则解析 JSON。 */
async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  let payload: unknown
  try {
    payload = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    throw new CompanionApiError(response.status, `服务端响应不是合法 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    throw new CompanionApiError(response.status, extractErrorMessage(payload, response.status))
  }
  return payload as T
}

function buildQuery(params?: QueryParams): string {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text.length > 0 ? `?${text}` : ''
}

/** 类型化 GET 封装。options 可选：外部取消信号与超时（缺省 30s）。 */
export async function companionGet<T>(path: string, params?: QueryParams, options?: RequestOptions): Promise<T> {
  const response = await fetchWithGuard(`${API_PREFIX}${path}${buildQuery(params)}`, {}, options)
  return parseResponse<T>(response)
}

/** 类型化 POST 封装（JSON 请求体）。options 可选：外部取消信号与超时（缺省 30s）。 */
export async function companionPost<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  const response = await fetchWithGuard(
    `${API_PREFIX}${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    options,
  )
  return parseResponse<T>(response)
}

/** 类型化 DELETE 封装（契约允许 DELETE 携带 JSON 请求体）。options 可选：外部取消信号与超时（缺省 30s）。 */
export async function companionDelete<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  const hasBody = body !== undefined
  const response = await fetchWithGuard(
    `${API_PREFIX}${path}`,
    {
      method: 'DELETE',
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(body) : undefined,
    },
    options,
  )
  return parseResponse<T>(response)
}

// ---------------------------------------------------------------------------
// 模块 A：对话智能导出（/export/*）
// ---------------------------------------------------------------------------

/** 导出格式（与服务端契约一致的字符串联合；png=长图，客户端光栅化；html=交互式自包含档案）。 */
export type ExportFormat = 'markdown' | 'pdf' | 'json' | 'png' | 'html'

/** `GET /export/sessions` 响应。 */
export interface ExportSessionsResponse {
  readonly sessions: readonly SessionRecord[]
}

/** `POST /export/run` 请求体。 */
export interface ExportRunRequest {
  readonly sessionId: string
  readonly format: ExportFormat
  /** 缺省为 true。 */
  readonly timestamps?: boolean
  /** 缺省为 false。 */
  readonly redact?: boolean
}

/** 导出结果为文件：base64 内容 + 文件名 + MIME。 */
export interface ExportFileResult {
  readonly kind: 'file'
  readonly fileName: string
  readonly mimeType: string
  readonly contentBase64: string
}

/** 导出结果为打印页（无光栅能力时的降级路径）：新窗口写入 html 并触发打印。 */
export interface ExportPrintResult {
  readonly kind: 'print'
  readonly fileName: string
  readonly html: string
}

/**
 * 导出结果为光栅载荷：客户端以 canvas 将 html 光栅化为成品
 * （PNG 长图或免打印多页 PDF），全程无 window.print() 对话框。
 */
export interface ExportRasterResult {
  readonly kind: 'raster'
  /** 目标成品：png=长图，pdf=免打印多页 PDF。 */
  readonly target: 'png' | 'pdf'
  readonly fileName: string
  readonly html: string
}

/** `POST /export/run` 响应。 */
export type ExportRunResponse = ExportFileResult | ExportPrintResult | ExportRasterResult

/** `POST /export/batch` 请求体。 */
export interface ExportBatchRequest {
  readonly sessionIds: readonly string[]
  readonly format: ExportFormat
  readonly timestamps?: boolean
  readonly redact?: boolean
}

/** `POST /export/batch` 响应（ZIP 压缩包）。 */
export interface ExportBatchResponse {
  readonly kind: 'file'
  readonly fileName: string
  readonly mimeType: 'application/zip'
  readonly contentBase64: string
}

/** 列出可导出的会话。 */
export function fetchExportSessions(options?: RequestOptions): Promise<ExportSessionsResponse> {
  return companionGet<ExportSessionsResponse>('/export/sessions', undefined, options)
}

/** 导出单个会话。 */
export function runExport(request: ExportRunRequest, options?: RequestOptions): Promise<ExportRunResponse> {
  return companionPost<ExportRunResponse>('/export/run', request, options)
}

/** 批量导出多个会话为 ZIP。 */
export function runExportBatch(request: ExportBatchRequest, options?: RequestOptions): Promise<ExportBatchResponse> {
  return companionPost<ExportBatchResponse>('/export/batch', request, options)
}

// ---------------------------------------------------------------------------
// 模块 A 创新扩展：合规签名导出（HMAC 签名链，/export/custody/*）
// ---------------------------------------------------------------------------

/** 公证记录（签名链上的一条）。 */
export interface CustodyRecord {
  readonly seq: number
  readonly recordId: string
  readonly sessionId: string
  readonly fileName: string
  readonly format: string
  readonly contentHash: string
  readonly prevRecordHash: string
  readonly recordHash: string
  readonly signature: string
  readonly signedAt: number
  readonly redacted: boolean
}

/** 伴随清单（.custody.json 公证书）。 */
export interface CustodyManifest {
  readonly kind: 'dsh-companion-custody'
  readonly version: number
  readonly record: CustodyRecord
  readonly verifyHint: string
}

/** `POST /export/custody/sign` 响应（导出文件 + 公证书成对交付）。 */
export interface CustodySignResponse {
  readonly fileName: string
  readonly mimeType: string
  readonly contentBase64: string
  readonly manifest: CustodyManifest
  readonly manifestFileName: string
}

/** `POST /export/custody/verify` 响应（逐项核验结果）。 */
export interface CustodyVerifyResponse {
  readonly intact: boolean
  readonly checks: {
    readonly contentIntact: boolean
    readonly recordIntact: boolean
    readonly signatureValid: boolean
    readonly chainLinked: boolean
    readonly prevRecordFound: boolean
  }
  readonly recordId: string
  readonly reason: string
}

/** `GET /export/custody/chain` 响应（公证登记簿 + 全链核验）。 */
export interface CustodyChainResponse {
  readonly records: readonly CustodyRecord[]
  readonly chain: {
    readonly length: number
    readonly intact: boolean
    readonly brokenAtSeq: number
    readonly reason: string
  }
}

/** 合规签名导出：签署文本格式导出内容，返回文件与公证书。 */
export function signCustodyExport(
  request: { sessionId: string; format: 'markdown' | 'json' | 'html'; timestamps?: boolean; redact?: boolean },
  options?: RequestOptions,
): Promise<CustodySignResponse> {
  return companionPost<CustodySignResponse>('/export/custody/sign', request, options)
}

/** 核验已签署文档：文件内容 + 公证书逐项验证（防篡改）。 */
export function verifyCustodyDocument(
  request: { contentBase64: string; manifest: unknown },
  options?: RequestOptions,
): Promise<CustodyVerifyResponse> {
  return companionPost<CustodyVerifyResponse>('/export/custody/verify', request, options)
}

/** 公证登记簿：全部签署记录 + 全链核验（含断裂点定位）。 */
export function fetchCustodyChain(options?: RequestOptions): Promise<CustodyChainResponse> {
  return companionGet<CustodyChainResponse>('/export/custody/chain', undefined, options)
}

// ---------------------------------------------------------------------------
// 模块 A 创新扩展：Merkle 可验证导出（/export/merkle/*）
// ---------------------------------------------------------------------------

/** Merkle 登记表条目：文件名与内容哈希的双重承诺。 */
export interface MerkleEntry {
  /** 条目文件名（ZIP 内名称）。 */
  readonly fileName: string
  readonly sessionId: string
  /** 内容 SHA-256（hex）。 */
  readonly contentHash: string
  /** 叶哈希 = SHA-256(fileName + '\n' + contentHash)（hex）。 */
  readonly leafHash: string
}

/** Merkle 兄弟节点（包含证明的一步）。 */
export interface MerkleSibling {
  readonly hash: string
  /** true = 兄弟在右侧（决定哈希拼接顺序）。 */
  readonly right: boolean
}

/** `POST /export/merkle/build` 响应：ZIP 载荷 + 根哈希批次承诺。 */
export interface MerkleBuildResponse {
  readonly kind: 'file'
  readonly fileName: string
  readonly mimeType: 'application/zip'
  readonly contentBase64: string
  /** 批次承诺：可发布到任何外部锚点的 32 字节根哈希。 */
  readonly root: string
  readonly rootSha256: string
  readonly entryCount: number
  readonly entries: readonly MerkleEntry[]
  readonly verifyHint: string
}

/** `POST /export/merkle/proof` 响应：第三方可独立复算的包含证明。 */
export interface MerkleInclusionProof {
  readonly root: string
  readonly fileName: string
  /** 叶在批次中的位次（0 起）。 */
  readonly index: number
  readonly leafHash: string
  /** 兄弟路径（叶 → 根）。 */
  readonly proof: readonly MerkleSibling[]
  /** 复算说明（给审计人员）。 */
  readonly verifyHint: string
}

/** `POST /export/merkle/verify` 响应：登记/内容/证明三关核验。 */
export interface MerkleVerifyResponse {
  /** 内容哈希与登记表一致。 */
  readonly contentMatch: boolean
  /** 叶 + 证明 → 根 复算成功。 */
  readonly proofValid: boolean
  /** 文件名在批次登记表中。 */
  readonly registered: boolean
  readonly verified: boolean
  readonly root: string
  readonly fileName: string
  readonly leafHash: string
  /** 不一致时的差异定位（中文）。 */
  readonly detail: string
}

/** 已发布批次摘要（根哈希登记簿行）。 */
export interface MerkleBundleSummary {
  readonly root: string
  readonly createdAt: number
  readonly format: string
  readonly entryCount: number
}

/** Merkle 可验证批量导出：逐会话叶哈希 → Merkle 根 → ZIP + 登记表成对交付。 */
export function buildMerkleExport(
  request: {
    sessionIds: readonly string[]
    format: 'markdown' | 'json' | 'html'
    timestamps?: boolean
    redact?: boolean
  },
  options?: RequestOptions,
): Promise<MerkleBuildResponse> {
  return companionPost<MerkleBuildResponse>('/export/merkle/build', request, options)
}

/** 获取批次内指定文件的包含证明（交给第三方复算）。 */
export function fetchMerkleProof(
  request: { root: string; fileName: string },
  options?: RequestOptions,
): Promise<MerkleInclusionProof> {
  return companionPost<MerkleInclusionProof>('/export/merkle/proof', request, options)
}

/** 核验一份文件确属某根哈希承诺的批次（登记/内容/证明三关）。 */
export function verifyMerkleInclusion(
  request: {
    root: string
    fileName: string
    contentBase64: string
    proof?: readonly MerkleSibling[]
  },
  options?: RequestOptions,
): Promise<MerkleVerifyResponse> {
  return companionPost<MerkleVerifyResponse>('/export/merkle/verify', request, options)
}

/** 已发布批次清单（根哈希登记簿）。 */
export function fetchMerkleRoots(
  options?: RequestOptions,
): Promise<{ bundles: readonly MerkleBundleSummary[] }> {
  return companionGet<{ bundles: readonly MerkleBundleSummary[] }>(
    '/export/merkle/roots',
    undefined,
    options,
  )
}

// ---------------------------------------------------------------------------
// 模块 B：上下文交接摘要（/handoff/*）
// ---------------------------------------------------------------------------

/** `POST /handoff/generate` 响应。 */
export interface HandoffGenerateResponse {
  readonly summary: string
  readonly model: string
}

/** 交接摘要模板条目。 */
export interface HandoffTemplate {
  readonly name: string
  readonly content: string
  readonly updatedAt: number
}

/** `GET /handoff/templates` 响应。 */
export interface HandoffTemplatesResponse {
  readonly templates: readonly HandoffTemplate[]
}

/** `POST /handoff/import` 请求体；省略 sessionId = 武装给“下一个新对话”。 */
export interface HandoffImportRequest {
  readonly summary: string
  readonly sessionId?: string
}

/** `POST /handoff/import` 响应；sessionId 为 null 表示武装给了下一个新对话。 */
export interface HandoffImportResponse {
  readonly ok: true
  readonly sessionId: string | null
}

/** 已武装的交接摘要条目。 */
export interface ArmedHandoff {
  /** null = 武装给下一个新对话。 */
  readonly sessionId: string | null
  readonly summary: string
  readonly armedAt: number
}

/** `GET /handoff/armed` 响应。 */
export interface ArmedHandoffsResponse {
  readonly armed: readonly ArmedHandoff[]
  /** pending 摘要的投递回执（世代门闩可观测性）。 */
  readonly receipts?: readonly HandoffReceipt[]
}

/** pending 摘要的投递回执。 */
export interface HandoffReceipt {
  readonly sessionId: string
  readonly injectedAt: number
}

/** `DELETE /handoff/armed` 请求体（缺省 sessionId 时移除全局武装）。 */
export interface DismissArmedRequest {
  readonly sessionId?: string
}

/** 为指定会话生成交接摘要。 */
export function generateHandoff(
  request: { sessionId: string },
  options?: RequestOptions,
): Promise<HandoffGenerateResponse> {
  return companionPost<HandoffGenerateResponse>('/handoff/generate', request, options)
}

/** 列出全部交接摘要模板。 */
export function fetchHandoffTemplates(options?: RequestOptions): Promise<HandoffTemplatesResponse> {
  return companionGet<HandoffTemplatesResponse>('/handoff/templates', undefined, options)
}

/** 保存（覆盖）一个模板。 */
export function saveHandoffTemplate(request: { name: string; content: string }): Promise<OkResponse> {
  return companionPost<OkResponse>('/handoff/templates', request)
}

/** 删除一个模板。 */
export function deleteHandoffTemplate(name: string): Promise<OkResponse> {
  return companionDelete<OkResponse>('/handoff/templates', { name })
}

/** 导入摘要：带 sessionId 注入指定会话，不带则武装给下一个新对话。 */
export function importHandoff(request: HandoffImportRequest): Promise<HandoffImportResponse> {
  return companionPost<HandoffImportResponse>('/handoff/import', request)
}

/** 查询当前已武装的交接摘要。 */
export function fetchArmedHandoffs(options?: RequestOptions): Promise<ArmedHandoffsResponse> {
  return companionGet<ArmedHandoffsResponse>('/handoff/armed', undefined, options)
}

/** 移除已武装的交接摘要。 */
export function dismissArmedHandoff(request: DismissArmedRequest): Promise<OkResponse> {
  return companionDelete<OkResponse>('/handoff/armed', request)
}

// ---------------------------------------------------------------------------
// 模块 B 创新扩展：结构化分级交接 + 世系链（/handoff/structured、/handoff/lineage）
// ---------------------------------------------------------------------------

/** 锚定项（TIER 1）：不可丢失的硬约束/决策/前提。 */
export interface HandoffAnchorItem {
  readonly hash: string
  readonly text: string
  /** 本代新增（null）或继承来源交接 id。 */
  readonly origin: string | null
  /** 是否为守门校验自动补回的项。 */
  readonly autoRestored: boolean
}

/** 活动项（TIER 2）。 */
export interface HandoffActiveItem {
  readonly kind: 'in_progress' | 'next' | 'open_question'
  readonly text: string
}

/** 参考项（TIER 3）。 */
export interface HandoffReferenceItem {
  readonly kind: 'path' | 'command' | 'id' | 'link' | 'other'
  readonly text: string
}

/** 父代锚定项的处置记录（显式继承/演进/废弃）。 */
export interface HandoffAnchorDisposition {
  readonly anchorHash: string
  readonly anchorText: string
  readonly action: 'inherited' | 'evolved' | 'dropped'
  readonly reason?: string
}

/** 完整结构化交接文档（四级信息分层）。 */
export interface StructuredHandoff {
  readonly handoffId: string
  readonly parentHandoffId: string | null
  readonly sourceSessionId: string
  readonly createdAt: number
  /** 世系深度（初代 = 0）。 */
  readonly depth: number
  readonly lineage: readonly string[]
  readonly tiers: {
    readonly anchors: readonly HandoffAnchorItem[]
    readonly active: readonly HandoffActiveItem[]
    readonly reference: readonly HandoffReferenceItem[]
    readonly archived: ReadonlyArray<{ readonly text: string }>
  }
  readonly dispositions: readonly HandoffAnchorDisposition[]
  readonly deliveredTo: readonly string[]
}

/** `POST /handoff/structured` 响应。 */
export interface StructuredHandoffResponse {
  readonly handoff: StructuredHandoff
  /** 守门自动补回的锚定数（模型静默丢失的约束）。 */
  readonly autoRestoredCount: number
  /** 世系深度是否超过告警阈值。 */
  readonly depthWarning: boolean
  readonly depthWarnThreshold: number
  /** 渲染后的交接文本（注入/武装用）。 */
  readonly rendered: string
  readonly armed: boolean
}

/** 世系链总览条目。 */
export interface LineageSummary {
  readonly handoffId: string
  readonly parentHandoffId: string | null
  readonly sourceSessionId: string
  readonly createdAt: number
  readonly depth: number
  readonly anchorCount: number
  readonly activeCount: number
  readonly archivedCount: number
  readonly autoRestoredCount: number
  readonly droppedCount: number
  readonly deliveredTo: readonly string[]
}

/** 世系溯源链条目（沿 parent 链向上到根）。 */
export interface LineageChainEntry {
  readonly handoffId: string
  readonly parentHandoffId: string | null
  readonly sourceSessionId: string
  readonly createdAt: number
  readonly depth: number
  readonly anchors: readonly HandoffAnchorItem[]
  readonly dispositions: readonly HandoffAnchorDisposition[]
}

/** `GET /handoff/lineage/trace` 响应。 */
export interface LineageTraceResponse {
  readonly handoffId: string
  readonly depth: number
  readonly chain: readonly LineageChainEntry[]
  readonly truncated: boolean
}

/** 生成结构化分级交接（四级分层 + 锚定强制继承 + 世系链）。arm='pending' 时武装给下一个新对话。 */
export function generateStructuredHandoff(
  request: { sessionId: string; arm?: 'pending' | 'none' },
  options?: RequestOptions,
): Promise<StructuredHandoffResponse> {
  return companionPost<StructuredHandoffResponse>('/handoff/structured', request, options)
}

/** 世系链总览（按创建时间降序）。 */
export function fetchHandoffLineage(options?: RequestOptions): Promise<{ handoffs: readonly LineageSummary[] }> {
  return companionGet<{ handoffs: readonly LineageSummary[] }>('/handoff/lineage', undefined, options)
}

/** 世系溯源：沿 parent 链向上追到根（含各代锚定约束与处置记录）。 */
export function traceHandoffLineage(
  handoffId: string,
  options?: RequestOptions,
): Promise<LineageTraceResponse> {
  return companionGet<LineageTraceResponse>('/handoff/lineage/trace', { handoffId }, options)
}

// ---------------------------------------------------------------------------
// 模块 B 创新扩展：渐进式上下文蒸馏（近端原文 + 远端事实压缩，/handoff/distill）
// ---------------------------------------------------------------------------

/** 蒸馏出的事实（远端对话的压缩记忆）。 */
export interface DistilledFact {
  readonly kind: 'constraint' | 'decision' | 'action' | 'reference' | 'metric'
  readonly role: string
  readonly text: string
}

/** `POST /handoff/distill` 响应。 */
export interface HandoffDistillResponse {
  /** 装配完成的注入文本。 */
  readonly rendered: string
  readonly facts: readonly DistilledFact[]
  readonly stats: {
    readonly totalTurns: number
    readonly verbatimTurns: number
    readonly distilledTurns: number
    readonly factCount: number
    readonly originalChars: number
    readonly renderedChars: number
    readonly compressionRatio: number
  }
  readonly armed: boolean
}

/** 渐进式蒸馏：零模型调用、确定性；可选武装给下一个新对话。 */
export function distillSessionContext(
  request: { sessionId: string; recentTurns?: number; charBudget?: number; arm?: 'pending' | 'none' },
  options?: RequestOptions,
): Promise<HandoffDistillResponse> {
  return companionPost<HandoffDistillResponse>('/handoff/distill', request, options)
}

// ---------------------------------------------------------------------------
// 模块 B 创新扩展：交接就绪度门（六维检查单，/handoff/readiness）
// ---------------------------------------------------------------------------

/** 缺口严重级别。 */
export type ReadinessGapSeverity = 'critical' | 'warning' | 'info'

/** 单条交接缺口。 */
export interface ReadinessGap {
  readonly severity: ReadinessGapSeverity
  /** 所属维度（锚定覆盖/行动清晰/…）。 */
  readonly dimension: string
  /** 问题描述（中文，可直接展示）。 */
  readonly message: string
  /** 修复建议。 */
  readonly suggestion: string
}

/** 就绪度分维得分。 */
export interface ReadinessDimension {
  readonly key: string
  readonly label: string
  /** 0-100。 */
  readonly score: number
  readonly weight: number
  /** 本维度的缺口（与总 gaps 中的条目同源）。 */
  readonly gaps: readonly ReadinessGap[]
}

/** `GET /handoff/readiness` 响应。 */
export interface ReadinessReport {
  readonly handoffId: string
  readonly depth: number
  /** 0-100 总分（分维加权）。 */
  readonly score: number
  /** A（≥85 可放心投递）/ B（≥70 小缺口）/ C（≥50 需补课）/ D（<50 不可投递）。 */
  readonly grade: 'A' | 'B' | 'C' | 'D'
  /** 是否存在 critical 缺口（存在则不建议投递）。 */
  readonly blocking: boolean
  readonly dimensions: readonly ReadinessDimension[]
  /** 全部缺口（critical 在前）。 */
  readonly gaps: readonly ReadinessGap[]
  /** 一句话总评。 */
  readonly summary: string
  /** 注入渲染的字符量与预算。 */
  readonly renderedChars: number
  readonly charBudget: number
}

/** 交接投递前的就绪度评估（缺省评估最近一次结构化交接）。 */
export function fetchHandoffReadiness(
  handoffId?: string,
  options?: RequestOptions,
): Promise<ReadinessReport> {
  return companionGet<ReadinessReport>('/handoff/readiness', { handoffId }, options)
}

// ---------------------------------------------------------------------------
// 模块 C：API 成本优化（/cost/*）
// ---------------------------------------------------------------------------

/**
 * 模型单价（元 / 百万 tokens）：动态计价引擎形状
 * （吸收自 dsh-usage-ledger），用户可按模型 id 覆盖（最长前缀匹配）。
 */
export interface ModelPrice {
  /** 命中前缀缓存的输入单价。 */
  readonly inputCacheHit: number
  /** 未命中缓存的输入单价。 */
  readonly inputMiss: number
  /** 输出单价。 */
  readonly output: number
}

/** 单厂商定价面板数据。 */
export interface VendorPricing {
  readonly id: string
  readonly label: string
  readonly pricingUrl: string
  /** 是否阶梯计价（展示的是最低档）。 */
  readonly tiered: boolean
  /** live=官方定价页实时抓取；builtin=内置快照；override=用户自定义。 */
  readonly source: 'live' | 'builtin' | 'override'
  readonly fetchedAt?: number
  readonly models: Readonly<Record<string, ModelPrice>>
  /** 全模型峰谷感知：该厂商的峰谷分时计划（官方未公布峰谷价时缺省）。 */
  readonly scheduled?: Readonly<{
    readonly effective: string
    readonly peakWindows?: ReadonlyArray<readonly [number, number]>
    readonly offPeak: Readonly<Record<string, ModelPrice>>
    readonly peak: Readonly<Record<string, ModelPrice>>
  }>
}

/** 动态计价引擎面板数据（`GET /cost/pricing` 与 /cost/state.pricing）。 */
export interface CostPricingView {
  /** DeepSeek 价格表来源：live=官方页实时抓取；builtin=内置快照。 */
  readonly source: 'live' | 'builtin'
  readonly sourceUrl?: string
  readonly fetchedAt?: number
  /** 官方价格最近一次内容变更时间（undefined=从未）。 */
  readonly lastChangedAt?: number
  /** 峰谷分时计划（null=暂无）。 */
  readonly scheduled: Readonly<{
    readonly effective: string
    readonly peakWindows?: ReadonlyArray<readonly [number, number]>
    readonly offPeak: Readonly<Record<string, ModelPrice>>
    readonly peak: Readonly<Record<string, ModelPrice>>
  }> | null
  /** 用户自定义单价覆盖。 */
  readonly overrides: Readonly<Record<string, ModelPrice>>
  /** 按厂商分组的全部已知定价。 */
  readonly vendors: readonly VendorPricing[]
}

/** 模型路由规则（细节由服务端成本模块维护，客户端只读透传，不展开字段）。 */
export type CostRoutingRule = Readonly<Record<string, unknown>>

/** 日/月双档预算状态。 */
export interface CostBudgetState {
  /** 日预算（元）；0 表示不限。 */
  readonly dailyCny: number
  /** 今日已花费（元，北京时间日）。 */
  readonly dailySpentCny: number
  /** 日用量/日预算比值（日预算为 0 时取 0）。 */
  readonly dailyRatio: number
  readonly monthlyCny: number
  readonly spentCny: number
  /** 已用 / 预算（0~1，可能大于 1）。 */
  readonly ratio: number
  /** 任一档预算用尽后是否已暂停 API 调用。 */
  readonly paused: boolean
}

/** `GET /cost/state` 响应。 */
export interface CostState {
  readonly devMode: boolean
  readonly apiKeyConfigured: boolean
  readonly peakScheduling: boolean
  readonly modelRouting: boolean
  readonly adaptiveRouting: boolean
  readonly budget: CostBudgetState
  readonly rules: readonly CostRoutingRule[]
  readonly pricing: CostPricingView
}

/** `POST /cost/settings` 稀疏补丁：只携带需要变更的字段。 */
export interface CostSettingsPatch {
  readonly devMode?: boolean
  readonly peakScheduling?: boolean
  readonly modelRouting?: boolean
  readonly adaptiveRouting?: boolean
  readonly dailyBudgetCny?: number
  readonly monthlyBudgetCny?: number
  readonly rules?: readonly CostRoutingRule[]
  readonly pricing?: Readonly<Record<string, ModelPrice>>
}

/** 按模型切片的当日用量。 */
export interface ModelUsageSlice {
  readonly calls: number
  readonly promptTokens: number
  readonly completionTokens: number
  /** 命中缓存的输入 tokens（旧行可能缺省）。 */
  readonly cacheHitTokens?: number
  readonly costCny: number
}

/** 北京时间日粒度用量聚合。 */
export interface DailyUsage {
  /** 日期键 YYYY-MM-DD。 */
  readonly day: string
  readonly calls: number
  readonly promptTokens: number
  readonly completionTokens: number
  /** 命中缓存的输入 tokens（旧行可能缺省）。 */
  readonly cacheHitTokens?: number
  readonly costCny: number
  /** 通过模型路由/峰谷调度节省的估算金额。 */
  readonly savedCny: number
  /** 被峰谷调度延迟执行的调用数。 */
  readonly deferredCalls: number
  readonly byModel: Readonly<Record<string, ModelUsageSlice>>
}

/** 区间用量汇总。 */
export interface UsageTotal {
  readonly calls: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly cacheHitTokens: number
  readonly costCny: number
  readonly savedCny: number
  readonly deferredCalls: number
}

/** `GET /cost/report` 响应。 */
export interface CostReportResponse {
  readonly days: readonly DailyUsage[]
  readonly total: UsageTotal
}

/** `POST /cost/test-call` 响应。 */
export interface CostTestCallResponse {
  readonly ok: true
  readonly model: string
  readonly latencyMs: number
}

/** 读取成本状态（保险库不回传 Key 明文，只有 apiKeyConfigured 布尔）。 */
export function fetchCostState(options?: RequestOptions): Promise<CostState> {
  return companionGet<CostState>('/cost/state', undefined, options)
}

/** 保存 API Key（服务端 AES-256-GCM 加密落盘）。 */
export function saveCostApiKey(apiKey: string): Promise<OkResponse> {
  return companionPost<OkResponse>('/cost/api-key', { apiKey })
}

/** 删除已保存的 API Key。 */
export function removeCostApiKey(): Promise<OkResponse> {
  return companionDelete<OkResponse>('/cost/api-key')
}

/** 更新成本设置（稀疏补丁）。 */
export function updateCostSettings(patch: CostSettingsPatch): Promise<OkResponse> {
  return companionPost<OkResponse>('/cost/settings', patch)
}

/** 读取 [from, to]（YYYY-MM-DD，北京时间）区间的成本报表。 */
export function fetchCostReport(
  range: { from: string; to: string },
  options?: RequestOptions,
): Promise<CostReportResponse> {
  return companionGet<CostReportResponse>('/cost/report', { from: range.from, to: range.to }, options)
}

/** 用当前 Key 发起一次最小测试调用，验证连通性。 */
export function testCostCall(): Promise<CostTestCallResponse> {
  return companionPost<CostTestCallResponse>('/cost/test-call')
}

/** 读取动态计价引擎面板数据（各厂商官方定价、峰谷计划、用户覆盖）。 */
export function fetchCostPricing(options?: RequestOptions): Promise<CostPricingView> {
  return companionGet<CostPricingView>('/cost/pricing', undefined, options)
}

/** 手动触发官方定价页刷新（DeepSeek + 全部国产厂商），返回刷新后的面板数据。 */
export function refreshCostPricing(options?: RequestOptions): Promise<CostPricingView> {
  return companionPost<CostPricingView>('/cost/pricing/refresh', undefined, options)
}

// ---------------------------------------------------------------------------
// 模块 C 创新扩展：自适应路由（滑动窗口 UCB1 赌博机，/cost/adaptive）
// ---------------------------------------------------------------------------

/** 单臂报表（/cost/adaptive 面板数据；ucb=Infinity 表示尚未拉臂，JSON 序列化为 null）。 */
export interface AdaptiveArmReport {
  readonly model: string
  readonly pulls: number
  /** 窗口均值奖励（成功率 0.55 + 相对成本优势 0.3 + 时延得分 0.15 加权）。 */
  readonly meanReward: number
  readonly avgLatencyMs: number
  readonly avgCostCny: number
  readonly failureRate: number
  /** UCB1 置信上界（含探索项）。 */
  readonly ucb: number | null
  readonly lastUsedAt?: number
}

/** `GET /cost/adaptive` 响应。 */
export interface CostAdaptiveResponse {
  /** enabled = modelRouting && adaptiveRouting。 */
  readonly enabled: boolean
  /** simple/complex 两类任务各自的赌臂统计（按均值奖励降序）。 */
  readonly arms: Readonly<Record<'simple' | 'complex', readonly AdaptiveArmReport[]>>
}

/** 读取自适应路由赌臂统计。 */
export function fetchCostAdaptive(options?: RequestOptions): Promise<CostAdaptiveResponse> {
  return companionGet<CostAdaptiveResponse>('/cost/adaptive', undefined, options)
}

/** 清空学习状态（cls 缺省全清；'simple'|'complex' 只清单一类别）。 */
export function resetCostAdaptive(cls?: 'simple' | 'complex'): Promise<OkResponse> {
  return companionPost<OkResponse>(cls === undefined ? '/cost/adaptive/reset' : `/cost/adaptive/reset?cls=${cls}`)
}

// ---------------------------------------------------------------------------
// 模块 C 创新扩展：成本预测哨兵（Holt 指数平滑 + 预算 ETA + CUSUM，/cost/forecast）
// ---------------------------------------------------------------------------

/** 预算耗尽 ETA。 */
export interface ForecastBudgetEta {
  readonly budgetCny: number
  readonly spentCny: number
  readonly dailyRateCny: number
  readonly daysLeft: number | null
}

/** `GET /cost/forecast` 响应。 */
export interface CostForecastResponse {
  readonly historyDays: number
  readonly history: ReadonlyArray<{ readonly day: string; readonly costCny: number }>
  readonly forecast: ReadonlyArray<{ readonly day: string; readonly costCny: number }>
  readonly forecastTotalCny: number
  readonly dailyEta: ForecastBudgetEta | null
  readonly monthlyEta: ForecastBudgetEta | null
  readonly changePoints: ReadonlyArray<{
    readonly day: string
    readonly direction: 'surge' | 'drop'
    readonly beforeMean: number
    readonly afterMean: number
  }>
}

/** 成本预测：历史拟合 + 未来 7 天外推 + 预算 ETA + 突变检测。 */
export function fetchCostForecast(days?: number, options?: RequestOptions): Promise<CostForecastResponse> {
  return companionGet<CostForecastResponse>('/cost/forecast', { days }, options)
}

// ---------------------------------------------------------------------------
// 模块 C 创新扩展：语义缓存（MinHash 近重复复用，/cost/cache/*）
// ---------------------------------------------------------------------------

/** 命中条目：近重复请求可直接复用的历史响应。 */
export interface SemanticCacheHitEntry {
  readonly entryId: string
  readonly prompt: string
  readonly response: string
  readonly model: string
  readonly hits: number
  readonly createdAt: number
  readonly lastHitAt: number
}

/** `POST /cost/cache/lookup` 响应。 */
export interface SemanticCacheLookupResponse {
  readonly hit: boolean
  /** 最佳候选的估计 Jaccard 相似度（无候选为 0）。 */
  readonly similarity: number
  /** 本次命中节省的 token（miss 为 0）。 */
  readonly savedTokens: number
  /** 本次命中节省的费用（元；miss 为 0）。 */
  readonly savedCny: number
  readonly entry: SemanticCacheHitEntry | null
}

/** `POST /cost/cache/store` 响应。 */
export interface SemanticCacheStoreResponse {
  readonly entryId: string
  /** 是否替换了归一化后完全相同的既有条目。 */
  readonly replaced: boolean
}

/** 缓存面板最近条目（不含响应正文）。 */
export interface SemanticCacheRecentEntry {
  readonly entryId: string
  readonly prompt: string
  readonly model: string
  readonly hits: number
  readonly savedTokens: number
  readonly lastHitAt: number
}

/** `GET /cost/cache/stats` 响应：容量/命中率/节省账本。 */
export interface SemanticCacheStatsResponse {
  readonly entries: number
  readonly capacity: number
  readonly lookups: number
  readonly hits: number
  readonly hitRate: number
  readonly savedTokens: number
  readonly savedCny: number
  readonly ttlDays: number
  /** 最近条目（按命中时间降序，≤20 条）。 */
  readonly recent: readonly SemanticCacheRecentEntry[]
}

/** 近重复请求查询（threshold ∈ [0.5, 1]，缺省 0.85）。 */
export function lookupSemanticCache(
  request: { prompt: string; threshold?: number },
  options?: RequestOptions,
): Promise<SemanticCacheLookupResponse> {
  return companionPost<SemanticCacheLookupResponse>('/cost/cache/lookup', request, options)
}

/** 缓存回填：miss 后真实执行调用，将 prompt/响应/用量写回缓存供复用。 */
export function storeSemanticCache(
  request: {
    prompt: string
    response: string
    model?: string
    inputTokens?: number
    outputTokens?: number
    costCny?: number
  },
  options?: RequestOptions,
): Promise<SemanticCacheStoreResponse> {
  return companionPost<SemanticCacheStoreResponse>('/cost/cache/store', request, options)
}

/** 缓存面板：容量/命中率/累计节省与最近条目。 */
export function fetchSemanticCacheStats(
  options?: RequestOptions,
): Promise<SemanticCacheStatsResponse> {
  return companionGet<SemanticCacheStatsResponse>('/cost/cache/stats', undefined, options)
}

/** 清空语义缓存（重置条目与统计）。 */
export function clearSemanticCache(options?: RequestOptions): Promise<OkResponse> {
  return companionDelete<OkResponse>('/cost/cache', undefined, options)
}

// ---------------------------------------------------------------------------
// 模块 D：全局对话检索（/search、/tags）
// ---------------------------------------------------------------------------

/** `GET /search` 请求参数。 */
export interface SearchRequest {
  readonly query?: string
  /** YYYY-MM-DD。 */
  readonly from?: string
  /** YYYY-MM-DD。 */
  readonly to?: string
  readonly tags?: readonly string[]
  readonly limit?: number
}

/** 单条检索命中。 */
export interface SearchHit {
  readonly session: SessionRecord
  readonly snippet?: string
  readonly tags: readonly string[]
}

/** `GET /search` 响应。 */
export interface SearchResponse {
  readonly hits: readonly SearchHit[]
}

/** `GET /tags?sessionId=` 响应（单个会话的标签）。 */
export interface SessionTagsResponse {
  readonly tags: readonly string[]
}

/** `GET /tags`（缺省 sessionId）响应：标签 → 会话 id 列表的全量映射。 */
export interface AllTagsResponse {
  readonly tags: Readonly<Record<string, readonly string[]>>
}

/** `POST /tags` 请求体。 */
export interface UpdateTagsRequest {
  readonly sessionId: string
  readonly add?: readonly string[]
  readonly remove?: readonly string[]
}

/** 跨会话全文检索。 */
export function searchSessions(request: SearchRequest): Promise<SearchResponse> {
  return companionGet<SearchResponse>('/search', {
    query: request.query,
    from: request.from,
    to: request.to,
    tags: request.tags && request.tags.length > 0 ? request.tags.join(',') : undefined,
    limit: request.limit,
  })
}

/** 读取单个会话的标签。 */
export function fetchSessionTags(sessionId: string): Promise<SessionTagsResponse> {
  return companionGet<SessionTagsResponse>('/tags', { sessionId })
}

/** 读取全量标签映射（标签 → 会话 id 列表）。 */
export function fetchAllTags(): Promise<AllTagsResponse> {
  return companionGet<AllTagsResponse>('/tags')
}

/** 为会话增删标签。 */
export function updateSessionTags(request: UpdateTagsRequest): Promise<SessionTagsResponse> {
  return companionPost<SessionTagsResponse>('/tags', request)
}

// ---------------------------------------------------------------------------
// 模块 D 创新扩展：语义邻域检索 + 相似会话（/search/semantic、/search/similar）
// ---------------------------------------------------------------------------

/** 语义检索命中（RRF 融合排序）。 */
export interface SemanticSearchHit {
  readonly session: SessionRecord
  readonly snippet?: string
  readonly tags: readonly string[]
  /** RRF 融合分。 */
  readonly score: number
  /** 与查询的 shingle 邻域相似度（0-1；不在邻域时为 0）。 */
  readonly neighborhoodSimilarity: number
  /** 该会话因哪些扩展词在引擎检索中命中。 */
  readonly matchedExpansionTerms: readonly string[]
}

/** PRF 扩展词项（可解释性：为什么扩展出这个词）。 */
export interface SemanticExpansionTerm {
  readonly term: string
  /** TF·IDF 权重（邻域内频次 × 全语料稀有度）。 */
  readonly weight: number
}

/** 语义邻域文档（与查询的 shingle 近邻）。 */
export interface SemanticNeighborhoodItem {
  readonly sessionId: string
  readonly title: string
  /** 混合相似度（0-1）。 */
  readonly similarity: number
}

/** `GET /search/semantic` 响应。 */
export interface SemanticSearchResponse {
  readonly query: string
  readonly hits: readonly SemanticSearchHit[]
  readonly expansionTerms: readonly SemanticExpansionTerm[]
  readonly neighborhood: readonly SemanticNeighborhoodItem[]
  /** 本次索引扫描的会话数。 */
  readonly scannedSessions: number
}

/** 相似会话命中（more-like-this）。 */
export interface SimilarSessionHit {
  readonly session: SessionRecord
  readonly tags: readonly string[]
  /** 混合相似度（0-1）。 */
  readonly similarity: number
  /** 双方共有的区分性词项（解释"为什么相似"）。 */
  readonly sharedTerms: readonly string[]
}

/** `GET /search/similar` 响应。 */
export interface SimilarSessionsResponse {
  readonly sessionId: string
  readonly hits: readonly SimilarSessionHit[]
  readonly scannedSessions: number
}

/** 语义邻域检索：shingle 邻域 + PRF 查询扩展 + 多源 RRF 融合。 */
export function searchSessionsSemantic(
  params: { query: string; limit?: number },
  options?: RequestOptions,
): Promise<SemanticSearchResponse> {
  return companionGet<SemanticSearchResponse>('/search/semantic', params, options)
}

/** 相似会话（more-like-this）：与指定会话内容最像的历史会话。 */
export function fetchSimilarSessions(
  params: { sessionId: string; limit?: number },
  options?: RequestOptions,
): Promise<SimilarSessionsResponse> {
  return companionGet<SimilarSessionsResponse>('/search/similar', params, options)
}

// ---------------------------------------------------------------------------
// 模块 D 创新扩展：组织记忆图谱（实体抽取 + 共现 + PageRank，/search/graph*）
// ---------------------------------------------------------------------------

/** 图谱实体节点。 */
export interface GraphEntity {
  readonly name: string
  readonly kind: 'path' | 'command' | 'model' | 'url' | 'error-code' | 'acronym'
  readonly sessionCount: number
  readonly centrality: number
  readonly degree: number
}

/** `GET /search/graph` 响应。 */
export interface MemoryGraphResponse {
  readonly sessionCount: number
  readonly entityCount: number
  readonly edgeCount: number
  readonly hubs: readonly GraphEntity[]
}

/** `GET /search/graph/entity` 响应。 */
export interface EntityNeighborhoodResponse {
  readonly entity: GraphEntity
  readonly neighbors: ReadonlyArray<{ readonly name: string; readonly kind: string; readonly weight: number }>
  readonly sessions: ReadonlyArray<{ readonly id: string; readonly title: string | null; readonly createdAt: number }>
}

/** 记忆图谱整体报告（PageRank 枢纽排序）。 */
export function fetchMemoryGraph(options?: RequestOptions): Promise<MemoryGraphResponse> {
  return companionGet<MemoryGraphResponse>('/search/graph', undefined, options)
}

/** 实体邻域查询：关联实体（边权降序）+ 关联会话。 */
export function fetchEntityNeighborhood(name: string, options?: RequestOptions): Promise<EntityNeighborhoodResponse> {
  return companionGet<EntityNeighborhoodResponse>('/search/graph/entity', { name }, options)
}

// ---------------------------------------------------------------------------
// 模块 D 创新扩展：点击反馈学习重排序（IPW 去位置偏，/search/rerank 等）
// ---------------------------------------------------------------------------

/** 单条重排结果。 */
export interface RerankEntry {
  readonly session: SessionRecord
  readonly snippet?: string
  readonly tags: readonly string[]
  readonly originalRank: number
  readonly newRank: number
  readonly clickScore: number
  /** 融合分（点击 w + 位次 1−w）。 */
  readonly finalScore: number
  readonly reason: string
}

/** `POST /search/rerank` 响应。 */
export interface RerankResponse {
  readonly query: string
  /** 点击模型是否有任何可泛化的证据。 */
  readonly learned: boolean
  /** 是否发生了顺序变化。 */
  readonly reordered: boolean
  readonly entries: readonly RerankEntry[]
  readonly clickWeight: number
}

/** 点击相关度打分结果。 */
export interface ClickScoreResult {
  /** 平滑后的无偏点击相关度 ∈ [0, 1]。 */
  readonly score: number
  /** 证据说明（可展示）。 */
  readonly reason: string
  /** 证据来源：'query'（精确查询）| 'term'（词元泛化）| 'none'。 */
  readonly evidence: 'query' | 'term' | 'none'
}

/** `GET /search/clicks/stats` 响应：点击模型面板。 */
export interface ClickModelStatsResponse {
  readonly eventCount: number
  readonly knownSessions: number
  readonly globalRate: number
  readonly distinctQueries: number
  readonly vocabularySize: number
  /** 全局最强的会话信号（跨词元聚合的有效点击，降序前 10）。 */
  readonly topSessions: readonly {
    readonly sessionId: string
    readonly effectiveClicks: number
    readonly clicks: number
    readonly lastClickedAt: number
  }[]
}

/** 点击反馈重排检索（展示即记录曝光，供下次去偏学习）。 */
export function rerankSearch(
  request: {
    query: string
    from?: string | number
    to?: string | number
    tags?: readonly string[]
    limit?: number
    /** 点击信号融合权重 0-1（缺省 0.6）。 */
    clickWeight?: number
  },
  options?: RequestOptions,
): Promise<RerankResponse> {
  return companionPost<RerankResponse>('/search/rerank', request, options)
}

/** 记录一次结果点击（位次从 1 起）。 */
export function recordSearchClick(
  request: { query: string; sessionId: string; position: number },
  options?: RequestOptions,
): Promise<{ ok: true; clickSignal?: ClickScoreResult }> {
  return companionPost<{ ok: true; clickSignal?: ClickScoreResult }>(
    '/search/click',
    request,
    options,
  )
}

/** 点击模型面板：事件量/全局率/最强会话信号。 */
export function fetchClickModelStats(
  options?: RequestOptions,
): Promise<ClickModelStatsResponse> {
  return companionGet<ClickModelStatsResponse>('/search/clicks/stats', undefined, options)
}

// ---------------------------------------------------------------------------
// 模块 E：执行轨迹分析器（/trace/*）
// ---------------------------------------------------------------------------

/** 轨迹节点（客户端视角）。 */
export interface TraceNode {
  readonly id: string
  readonly name: string
  readonly kind: 'step' | 'tool' | 'agent' | 'model'
  readonly startMs: number
  readonly endMs: number
  readonly durationMs: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly model?: string
  readonly cacheHit: boolean
  readonly status: 'ok' | 'error' | 'retry'
  readonly attempts: number
  readonly parentId?: string
}

/** 一条完整执行轨迹。 */
export interface Trace {
  readonly id: string
  readonly sessionId?: string
  readonly startedAt: number
  readonly endedAt: number
  readonly nodes: readonly TraceNode[]
}

/** 轨迹异常标注。 */
export interface TraceAnomaly {
  readonly kind: 'retry-loop' | 'token-explosion' | 'cache-miss' | 'infinite-loop'
  readonly nodeIds: readonly string[]
  readonly reason: string
  readonly suggestion: string
  readonly severity: 1 | 2 | 3
}

/** 轨迹汇总指标。 */
export interface TraceStats {
  readonly totalDurationMs: number
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly cacheHitRate: number
  readonly toolSuccessRate: number
  readonly agentDispatches: number
  readonly nodeCount: number
}

/** 轨迹对比差异条目。 */
export interface TraceDiffEntry {
  readonly name: string
  readonly change: 'added' | 'removed' | 'changed' | 'same'
  readonly oldDurationMs?: number
  readonly newDurationMs?: number
  readonly durationDeltaMs?: number
  readonly oldTokens?: number
  readonly newTokens?: number
  readonly tokenDelta?: number
}

/** 轨迹日聚合统计。 */
export interface TraceDailyStats {
  readonly day: string
  readonly traceCount: number
  readonly totalDurationMs: number
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly cacheHits: number
  readonly modelCalls: number
  readonly toolCalls: number
  readonly toolSuccess: number
  readonly agentDispatches: number
  readonly anomalyCount: number
}

/** `GET /trace/derive` 与 `GET /trace/get` 响应。 */
export interface TraceAnalysisResponse {
  readonly trace: Trace
  readonly anomalies: readonly TraceAnomaly[]
  readonly stats: TraceStats
  readonly slowest?: readonly TraceNode[]
  readonly costliest?: readonly TraceNode[]
}

/** `GET /trace/stats` 响应。 */
export interface TraceStatsResponse {
  readonly days: readonly TraceDailyStats[]
  readonly baseline?: {
    readonly avgDurationMs: number
    readonly avgTokens: number
    readonly avgAnomalies: number
  }
}

/** `POST /trace/diff` 响应（json 形态）。 */
export interface TraceDiffJsonResponse {
  readonly format: 'json'
  readonly entries: readonly TraceDiffEntry[]
}

/** `POST /trace/diff` 响应（html 形态）。 */
export interface TraceDiffHtmlResponse {
  readonly format: 'html'
  readonly fileName: string
  readonly html: string
}

/** 从会话日志派生并分析轨迹。 */
export function deriveTrace(sessionId: string, options?: RequestOptions): Promise<TraceAnalysisResponse> {
  return companionGet<TraceAnalysisResponse>('/trace/derive', { sessionId }, options)
}

/** 列出可分析的会话。 */
export function fetchTraceSessions(options?: RequestOptions): Promise<ExportSessionsResponse> {
  return companionGet<ExportSessionsResponse>('/trace/sessions', undefined, options)
}

/** 对比两条轨迹（format 缺省返回 json；'html' 返回自包含对比报告）。 */
export function diffTraces(
  request: {
    old: { id?: string; sessionId?: string }
    new: { id?: string; sessionId?: string }
    format?: 'json' | 'html'
  },
  options?: RequestOptions,
): Promise<TraceDiffJsonResponse | TraceDiffHtmlResponse> {
  return companionPost<TraceDiffJsonResponse | TraceDiffHtmlResponse>('/trace/diff', request, options)
}

/** 读取轨迹日聚合趋势与历史基准线。 */
export function fetchTraceStats(
  range: { from: string; to: string },
  options?: RequestOptions,
): Promise<TraceStatsResponse> {
  return companionGet<TraceStatsResponse>('/trace/stats', { from: range.from, to: range.to }, options)
}

/** 摄入 Harness 原生轨迹 JSON。 */
export function ingestTrace(
  request: { id?: string; trace: unknown },
  options?: RequestOptions,
): Promise<TraceAnalysisResponse> {
  return companionPost<TraceAnalysisResponse>('/trace/ingest', request, options)
}

// ---------------------------------------------------------------------------
// 模块 E 创新扩展：SPC 统计过程控制（/trace/spc）
// ---------------------------------------------------------------------------

/** SPC 可监控指标。 */
export type SpcMetric =
  | 'duration-per-trace'
  | 'tokens-per-trace'
  | 'anomaly-rate'
  | 'cache-hit-rate'
  | 'tool-success-rate'

/** 单日 EWMA 控制图点。 */
export interface SpcPoint {
  readonly day: string
  /** 原始指标值。 */
  readonly value: number
  /** EWMA 统计量。 */
  readonly ewma: number
  /** 当日上控制限（随 t 收敛）。 */
  readonly ucl: number
  /** 当日下控制限。 */
  readonly lcl: number
  /** 是否越限（任意一侧）。 */
  readonly violation: boolean
  /** 是否落在劣化侧。 */
  readonly badSide: boolean
}

/** `GET /trace/spc` 响应。 */
export interface SpcResponse {
  readonly metric: SpcMetric
  readonly label: string
  readonly lambda: number
  readonly limitWidth: number
  /** 中心线（Phase I 过程均值）。 */
  readonly center: number
  /** 过程标准差估计（MR̄/d₂）。 */
  readonly sigma: number
  /** 参与分析的天数。 */
  readonly sampleDays: number
  /** 查询区间内的控制图点。 */
  readonly points: readonly SpcPoint[]
  readonly drift: {
    readonly kind: 'shift' | 'trend' | 'run' | 'mixed' | 'none'
    readonly detail: string
  }
  /** stable=受控；warning=轻微异常；out-of-control=确认失控。 */
  readonly verdict: 'stable' | 'warning' | 'out-of-control'
  /** EWMA 序列最小二乘斜率（单位/天）。 */
  readonly driftRatePerDay: number
}

/** 读取 SPC 控制图（EWMA + Western Electric 规则）。参数缺省 metric=duration-per-trace、lambda=0.3、limitWidth=3。 */
export function fetchTraceSpc(
  params: { from: string; to: string; metric?: SpcMetric; lambda?: number; limitWidth?: number },
  options?: RequestOptions,
): Promise<SpcResponse> {
  return companionGet<SpcResponse>('/trace/spc', params, options)
}

// ---------------------------------------------------------------------------
// 模块 E 创新扩展：失败前兆挖掘（n-gram 序列模式 + 实时预警，/trace/precursors*）
// ---------------------------------------------------------------------------

/** 单条失败前兆模式。 */
export interface PrecursorPattern {
  readonly signature: readonly string[]
  readonly failSupport: number
  readonly okSupport: number
  readonly lift: number
  readonly typicalNext: string | null
}

/** `GET /trace/precursors` 响应。 */
export interface PrecursorsResponse {
  readonly traces: { readonly ok: number; readonly failed: number }
  readonly failureRate: number
  readonly patterns: readonly PrecursorPattern[]
}

/** `POST /trace/precursors/check` 响应（实时预警）。 */
export interface PrecursorCheckResponse {
  readonly traceId: string
  readonly sessionId: string | null
  readonly signature: readonly string[]
  readonly alerts: ReadonlyArray<{
    readonly pattern: PrecursorPattern
    readonly matchedLength: number
    readonly patternLength: number
    readonly risk: number
    readonly predictedNext: string | null
  }>
  readonly risk: number
  readonly advice: string
}

/** 挖掘失败前兆库（n-gram 模式 + 提升度排序）。 */
export function fetchTracePrecursors(options?: RequestOptions): Promise<PrecursorsResponse> {
  return companionGet<PrecursorsResponse>('/trace/precursors', undefined, options)
}

/** 对进行中轨迹做实时预警（traceId 或 sessionId 二选一）。 */
export function checkTracePrecursors(
  request: { traceId?: string; sessionId?: string },
  options?: RequestOptions,
): Promise<PrecursorCheckResponse> {
  return companionPost<PrecursorCheckResponse>('/trace/precursors/check', request, options)
}

// ---------------------------------------------------------------------------
// 模块 E 创新扩展：频谱根因定位（SBFL Ochiai 可疑度，/trace/localize）
// ---------------------------------------------------------------------------

/** 单组件可疑度画像。 */
export interface ComponentSuspicion {
  /** 行为签名（kind:name）。 */
  readonly component: string
  readonly kind: 'step' | 'tool' | 'agent' | 'model'
  readonly name: string
  /** 覆盖该组件的失败轨迹数。 */
  readonly failedCount: number
  /** 覆盖该组件的成功轨迹数。 */
  readonly passedCount: number
  /** Ochiai 可疑度（0-1）。 */
  readonly suspiciousness: number
  /** 失败轨迹中该组件的平均耗时（毫秒）。 */
  readonly avgDurationInFailedMs: number
  /** 成功轨迹中该组件的平均耗时（毫秒；无样本为 0）。 */
  readonly avgDurationInPassedMs: number
  /** 失败轨迹中该组件的重试率（0-1）。 */
  readonly retryRateInFailed: number
  /** 人类可读的工程线索。 */
  readonly advice: string
}

/** `GET /trace/localize` 响应。 */
export interface FaultLocalizationResponse {
  /** 参与定位的轨迹总数（成功/失败）。 */
  readonly traces: { readonly ok: number; readonly failed: number }
  readonly failureRate: number
  /** 组件可疑度排行（降序，≤20 条）。 */
  readonly components: readonly ComponentSuspicion[]
  /** 根因结论（证据不足时为 null）。 */
  readonly verdict: string | null
  /** 数据不足说明（verdict 为 null 时给出原因）。 */
  readonly note: string
}

/** 频谱根因定位：对比失败/成功轨迹的组件覆盖，量化各组件可疑度。 */
export function localizeFaults(options?: RequestOptions): Promise<FaultLocalizationResponse> {
  return companionGet<FaultLocalizationResponse>('/trace/localize', undefined, options)
}

// ---------------------------------------------------------------------------
// 模块 F：Prompt 工程工作台（/prompt/*）
// ---------------------------------------------------------------------------

/** Prompt 版本记录。 */
export interface PromptVersion {
  readonly version: number
  readonly content: string
  readonly note: string
  readonly tags: readonly string[]
  readonly createdAt: number
}

/** Prompt 模板。 */
export interface PromptTemplate {
  readonly name: string
  readonly category: string
  readonly content: string
  readonly builtin: boolean
  readonly updatedAt: number
  readonly variables: readonly string[]
}

/** A/B 单条运行结果。 */
export interface AbTestRunResult {
  readonly caseIndex: number
  readonly input: string
  readonly ok: boolean
  readonly output: string
  readonly latencyMs: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly error?: string
}

/** A/B 汇总指标。 */
export interface AbTestSummary {
  readonly successRate: number
  readonly avgOutputLength: number
  readonly avgLatencyMs: number
  readonly totalTokens: number
}

/** 胜率统计。 */
export interface PromptRatings {
  readonly total: number
  readonly winsA: number
  readonly winsB: number
  readonly ties: number
}

/** `POST /prompt/ab-test` 响应。 */
export interface AbTestResponse {
  readonly model: string
  readonly a: {
    readonly prompt: string
    readonly results: readonly AbTestRunResult[]
    readonly summary: AbTestSummary
  }
  readonly b: {
    readonly prompt: string
    readonly results: readonly AbTestRunResult[]
    readonly summary: AbTestSummary
  }
  readonly ratings: PromptRatings
}

/** F4 单条校验运行。 */
export interface ValidateRun {
  readonly caseIndex: number
  readonly input: string
  readonly ok: boolean
  readonly output: string
  readonly violations: readonly { readonly path: string; readonly message: string }[]
  readonly latencyMs: number
  readonly tokens: number
  readonly error?: string
}

/** `POST /prompt/validate` 响应。 */
export interface ValidateResponse {
  readonly model: string
  readonly total: number
  readonly compliant: number
  readonly complianceRate: number
  readonly runs: readonly ValidateRun[]
}

/** 读取 Prompt 版本历史。 */
export function fetchPromptVersions(options?: RequestOptions): Promise<{ versions: readonly PromptVersion[] }> {
  return companionGet<{ versions: readonly PromptVersion[] }>('/prompt/versions', undefined, options)
}

/** 保存新 Prompt 版本。 */
export function savePromptVersion(request: {
  content: string
  note?: string
  tags?: readonly string[]
}): Promise<{ version: PromptVersion }> {
  return companionPost<{ version: PromptVersion }>('/prompt/versions', request)
}

/** 回滚到指定版本。 */
export function rollbackPromptVersion(request: { version: number; note?: string }): Promise<{ version: PromptVersion }> {
  return companionPost<{ version: PromptVersion }>('/prompt/rollback', request)
}

/** 为版本增删标签。 */
export function updatePromptTags(request: {
  version: number
  add?: readonly string[]
  remove?: readonly string[]
}): Promise<{ version: PromptVersion }> {
  return companionPost<{ version: PromptVersion }>('/prompt/tags', request)
}

/** 运行 A/B 测试。 */
export function runAbTest(
  request: { promptA: string; promptB: string; cases?: readonly string[]; model?: string },
  options?: RequestOptions,
): Promise<AbTestResponse> {
  return companionPost<AbTestResponse>('/prompt/ab-test', request, options)
}

/** 提交人工评分。 */
export function rateAbTest(request: {
  winner: 'A' | 'B' | 'tie'
  promptA?: string
  promptB?: string
}): Promise<{ ok: true; ratings: PromptRatings }> {
  return companionPost<{ ok: true; ratings: PromptRatings }>('/prompt/rate', request)
}

/** 读取模板库。 */
export function fetchPromptTemplates(options?: RequestOptions): Promise<{ templates: readonly PromptTemplate[] }> {
  return companionGet<{ templates: readonly PromptTemplate[] }>('/prompt/templates', undefined, options)
}

/** 保存模板。 */
export function savePromptTemplate(request: { name: string; category?: string; content: string }): Promise<OkResponse> {
  return companionPost<OkResponse>('/prompt/templates', request)
}

/** 删除模板。 */
export function deletePromptTemplate(name: string): Promise<OkResponse> {
  return companionDelete<OkResponse>('/prompt/templates', { name })
}

/** 变量插值渲染。 */
export function renderPromptTemplate(request: {
  template: string
  variables?: Readonly<Record<string, string>>
}): Promise<{ rendered: string }> {
  return companionPost<{ rendered: string }>('/prompt/render', request)
}

/** 生成 API 调用代码。 */
export function generateApiCode(request: {
  prompt: string
  language: 'python' | 'nodejs' | 'curl'
  model?: string
}): Promise<{ code: string }> {
  return companionPost<{ code: string }>('/prompt/codegen', request)
}

/** 结构化输出批量校验。 */
export function validateStructuredOutput(
  request: { prompt: string; schema: string; cases?: readonly string[]; model?: string },
  options?: RequestOptions,
): Promise<ValidateResponse> {
  return companionPost<ValidateResponse>('/prompt/validate', request, options)
}

// ---------------------------------------------------------------------------
// 模块 F 创新扩展：自动 Prompt 优化（/prompt/optimize、/prompt/ratings）
// ---------------------------------------------------------------------------

/** 单条优化用例：expected 缺省时由模型评审员裁决，否则输出包含参考答案即通过。 */
export interface OptimizeCase {
  readonly input: string
  readonly expected?: string
}

/** 候选变体评测结果。 */
export interface OptimizeCandidateEval {
  readonly content: string
  /** 每条用例是否通过（与 cases 同序）。 */
  readonly passes: readonly boolean[]
  readonly passRate: number
  /** 基线败 & 本候选胜的用例数。 */
  readonly wins: number
  /** 基线胜 & 本候选败的用例数。 */
  readonly losses: number
}

/** `POST /prompt/optimize` 响应。 */
export interface PromptOptimizeResponse {
  readonly model: string
  readonly baseline: {
    readonly passRate: number
    readonly passes: readonly boolean[]
    /** 失败用例序号（元提示的改进线索）。 */
    readonly failures: readonly number[]
  }
  readonly candidates: readonly OptimizeCandidateEval[]
  /** 胜出候选下标（无显著胜者时缺省）。 */
  readonly winnerIndex?: number
  /** 配对符号检验（McNemar 精确法）。 */
  readonly significance?: {
    /** 基线败 & 候选胜。 */
    readonly b: number
    /** 基线胜 & 候选败。 */
    readonly c: number
    /** 双侧精确二项 p 值。 */
    readonly pValue: number
    readonly significant: boolean
  }
  /** 晋升保存的新版本（save=false 或不显著时缺省）。 */
  readonly savedVersion?: PromptVersion
}

/** 自动优化 Prompt：元提示生成候选 → 批量评测 → 配对显著性检验，显著胜者晋升版本库。 */
export function optimizePrompt(
  request: { prompt: string; cases: readonly OptimizeCase[]; model?: string; candidates?: number; save?: boolean },
  options?: RequestOptions,
): Promise<PromptOptimizeResponse> {
  return companionPost<PromptOptimizeResponse>('/prompt/optimize', request, options)
}

/** 读取 A/B 人工评级汇总。 */
export function fetchPromptRatings(options?: RequestOptions): Promise<{ ratings: PromptRatings }> {
  return companionGet<{ ratings: PromptRatings }>('/prompt/ratings', undefined, options)
}

// ---------------------------------------------------------------------------
// 模块 F 创新扩展：Prompt 预算编译器（组件拆解 + 保真裁剪，/prompt/compile）
// ---------------------------------------------------------------------------

/** `POST /prompt/compile` 响应。 */
export interface PromptCompileResponse {
  /** 编译产物（预算内的最优装配）。 */
  readonly compiled: string
  readonly tokensBefore: number
  readonly tokensAfter: number
  /** 保真度损失估计（0=无损；1=全部裁剪）。 */
  readonly fidelityLoss: number
  readonly components: ReadonlyArray<{
    readonly kind: string
    readonly kindLabel: string
    readonly before: string
    readonly after: string
    readonly tokensBefore: number
    readonly tokensAfter: number
    readonly decision: string
  }>
  readonly withinBudget: boolean
  readonly note: string
}

/** Prompt 预算编译：在 Token 预算内组件级裁剪，最大化保真度。 */
export function compilePrompt(
  request: { prompt: string; budgetTokens: number },
  options?: RequestOptions,
): Promise<PromptCompileResponse> {
  return companionPost<PromptCompileResponse>('/prompt/compile', request, options)
}

// ---------------------------------------------------------------------------
// 模块 F 创新扩展：Thompson Sampling 变体寻优（/prompt/bandit*）
// ---------------------------------------------------------------------------

/** 评测用例（输出含 expected 即通过；缺省走模型评审员）。 */
export interface BanditCase {
  /** 用例输入（拼接到变体 Prompt 之后）。 */
  readonly input: string
  /** 参考答案：输出包含该串即通过。 */
  readonly expected?: string
}

/** 单臂后验报告。 */
export interface BanditArmPosterior {
  readonly index: number
  /** 变体正文（截断 80 字符展示）。 */
  readonly excerpt: string
  readonly pulls: number
  readonly successes: number
  /** 经验通过率。 */
  readonly empiricalRate: number
  /** 后验均值 α/(α+β)。 */
  readonly posteriorMean: number
  /** 95% 置信区间。 */
  readonly ci95: readonly [number, number]
  /** P(best)：联合后验抽样中为最优臂的频率。 */
  readonly pBest: number
  /** 期望损失：现在部署本臂，相对事后最优的期望通过率损失。 */
  readonly expectedLoss: number
  /** 累计遗憾。 */
  readonly regret: number
}

/** 后验分析报告（含停止裁决）。 */
export interface BanditAnalysis {
  readonly arms: readonly BanditArmPosterior[]
  /** 当前后验下最优臂下标。 */
  readonly bestIndex: number | null
  /** 是否可停止实验并定版。 */
  readonly readyToStop: boolean
  /** 裁决说明（中文，可展示）。 */
  readonly verdict: string
  /** 建议部署的臂（未定版为 null）。 */
  readonly winnerIndex: number | null
}

/** 实验详情（含各臂 Beta 后验状态）。 */
export interface BanditExperiment {
  readonly id: string
  readonly name: string
  readonly model: string
  readonly cases: readonly BanditCase[]
  readonly arms: readonly {
    /** 变体 Prompt 全文。 */
    readonly content: string
    /** Beta 后验 α（成功数 + 1）。 */
    readonly alpha: number
    /** Beta 后验 β（失败数 + 1）。 */
    readonly beta: number
    readonly pulls: number
    readonly successes: number
    readonly regret: number
    readonly lastPullAt: number
  }[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** 实验列表行。 */
export interface BanditExperimentSummary {
  readonly id: string
  readonly name: string
  readonly model: string
  readonly armCount: number
  readonly caseCount: number
  readonly totalPulls: number
  readonly updatedAt: number
}

/** 单轮采样执行记录。 */
export interface BanditPullRound {
  readonly round: number
  /** Thompson 选中的臂下标。 */
  readonly armIndex: number
  /** 本轮用例下标。 */
  readonly caseIndex: number
  readonly passed: boolean
  /** 该臂更新后的后验均值。 */
  readonly armPosteriorMean: number
  readonly latencyMs: number
  readonly error?: string
}

/** `POST /prompt/bandit/pull` 响应。 */
export interface BanditPullResponse {
  readonly experiment: BanditExperiment
  readonly rounds: readonly BanditPullRound[]
  readonly analysis: BanditAnalysis
}

/** 创建变体寻优实验（≥2 个互不相同变体 + 用例集）。 */
export function createBanditExperiment(
  request: {
    name?: string
    variants: readonly string[]
    cases: readonly BanditCase[]
    model?: string
  },
  options?: RequestOptions,
): Promise<{ experiment: BanditExperiment; analysis: BanditAnalysis }> {
  return companionPost<{ experiment: BanditExperiment; analysis: BanditAnalysis }>(
    '/prompt/bandit',
    request,
    options,
  )
}

/** 实验列表。 */
export function fetchBanditExperiments(
  options?: RequestOptions,
): Promise<{ experiments: readonly BanditExperimentSummary[] }> {
  return companionGet<{ experiments: readonly BanditExperimentSummary[] }>(
    '/prompt/bandit',
    undefined,
    options,
  )
}

/** 读取实验详情 + 后验分析（P(best)/期望损失/95% CI/停止裁决）。 */
export function fetchBanditExperiment(
  id: string,
  options?: RequestOptions,
): Promise<{ experiment: BanditExperiment; analysis: BanditAnalysis }> {
  return companionGet<{ experiment: BanditExperiment; analysis: BanditAnalysis }>(
    '/prompt/bandit/get',
    { id },
    options,
  )
}

/** 执行 N 轮 Thompson 采样（后验选臂 → 轮转用例 → Beta 更新）。 */
export function pullBandit(
  request: { id: string; rounds?: number },
  options?: RequestOptions,
): Promise<BanditPullResponse> {
  return companionPost<BanditPullResponse>('/prompt/bandit/pull', request, options)
}

/** 删除实验。 */
export function deleteBanditExperiment(id: string, options?: RequestOptions): Promise<OkResponse> {
  return companionDelete<OkResponse>('/prompt/bandit', { id }, options)
}

// ---------------------------------------------------------------------------
// 模块 G：多模型竞技场（/arena/*）
// ---------------------------------------------------------------------------

/** 竞技场模型目录条目。 */
export interface ArenaModelInfo {
  readonly id: string
  readonly label: string
  readonly provider: 'deepseek' | 'external'
  readonly latencyTier: 'fast' | 'balanced' | 'slow'
  readonly accuracyPrior: Readonly<Record<string, number>>
  /** true=用户自定义模型（可删除）。 */
  readonly custom?: boolean
  /** 外部厂商 Key 是否已配置（deepseek 模型为 undefined）。 */
  readonly keyConfigured?: boolean
  /** 全模型峰谷感知：当前是否高峰 + 该模型厂商是否公布峰谷分时价。 */
  readonly peakStatus?: Readonly<{
    readonly isPeak: boolean
    readonly hasPeakPricing: boolean
  }>
}

/** G1 单模型运行结果。 */
export interface ArenaRunResult {
  readonly model: string
  readonly ok: boolean
  readonly output: string
  readonly latencyMs: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly costCny: number
  readonly error?: string
}

/** G2 排行榜行。 */
export interface ArenaLeaderboardRow {
  readonly model: string
  readonly successRate: number
  readonly accuracy: number | null
  readonly p50Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
  readonly avgTokens: number
  readonly costPerTaskCny: number
  readonly complianceRate: number | null
  readonly compositeScore: number
}

/** G3 推荐条目。 */
export interface ArenaRecommendation {
  readonly model: string
  readonly label: string
  readonly score: number
  readonly reason: string
  readonly estimatedCostCny: number
}

/** 读取模型目录。 */
export function fetchArenaModels(options?: RequestOptions): Promise<{ models: readonly ArenaModelInfo[] }> {
  return companionGet<{ models: readonly ArenaModelInfo[] }>('/arena/models', undefined, options)
}

/** 保存外部厂商 API Key（服务端加密落盘）。 */
export function saveArenaKey(request: { modelId: string; apiKey: string; baseUrl?: string }): Promise<OkResponse> {
  return companionPost<OkResponse>('/arena/keys', request)
}

/** 删除外部厂商 API Key。 */
export function removeArenaKey(modelId: string): Promise<OkResponse> {
  return companionDelete<OkResponse>('/arena/keys', { modelId })
}

/** 添加/更新用户自定义模型（OpenAI 兼容）。 */
export function addArenaCustomModel(request: {
  modelId: string
  label: string
  baseUrl: string
  latencyTier?: 'fast' | 'balanced' | 'slow'
}): Promise<OkResponse> {
  return companionPost<OkResponse>('/arena/custom-models', request)
}

/** 删除用户自定义模型（连同其 Key）。 */
export function removeArenaCustomModel(modelId: string): Promise<OkResponse> {
  return companionDelete<OkResponse>('/arena/custom-models', { modelId })
}

/** G1 同 Prompt 多模型并行对比。 */
export function runArenaCompare(
  request: { prompt: string; models: readonly string[] },
  options?: RequestOptions,
): Promise<{ prompt: string; results: readonly ArenaRunResult[] }> {
  return companionPost<{ prompt: string; results: readonly ArenaRunResult[] }>('/arena/compare', request, options)
}

/** G2 批量评测排行榜（format 缺省返回 json；useCache=true 时导出复用最近评测结果，不重跑）。 */
export function runArenaLeaderboard(
  request: {
    models?: readonly string[]
    cases?: readonly unknown[] | string
    format?: 'markdown' | 'html'
    useCache?: boolean
  },
  options?: RequestOptions,
): Promise<
  | { format: 'json'; rows: readonly ArenaLeaderboardRow[] }
  | { format: 'markdown' | 'html'; fileName: string; content: string }
> {
  return companionPost('/arena/leaderboard', request, options)
}

/** G3 模型推荐。 */
export function fetchArenaRecommendation(
  params: { taskType?: string; budgetPerCallCny?: number; latency?: string },
  options?: RequestOptions,
): Promise<{
  taskType: string
  taskTypeLabel: string
  recommendations: readonly ArenaRecommendation[]
}> {
  return companionGet('/arena/recommend', params, options)
}

// ---------------------------------------------------------------------------
// 模块 G 创新扩展：金丝雀漂移监控（/arena/canary/*）
// ---------------------------------------------------------------------------

/** 单维度漂移信号。 */
export interface DriftDimension {
  /** latency=延迟分布；pass-rate=能力通过率；length=输出长度；style=风格指纹。 */
  readonly name: 'latency' | 'pass-rate' | 'length' | 'style'
  /** 统计量（各维度含义不同，见 detail）。 */
  readonly statistic: number
  /** 判定阈值（drifted 阈值）。 */
  readonly threshold: number
  readonly level: 'stable' | 'warning' | 'drifted'
  readonly detail: string
}

/** 漂移报告。 */
export interface DriftReport {
  readonly model: string
  readonly baselineTs: number
  readonly runsCompared: number
  readonly dimensions: readonly DriftDimension[]
  /** 任一维度 drifted → drifted；任一 warning → warning；否则 stable。 */
  readonly verdict: 'stable' | 'warning' | 'drifted'
  readonly summary: string
}

/** `POST /arena/canary/run` 响应。 */
export interface CanaryRunResponse {
  readonly reports: readonly DriftReport[]
}

/** `GET /arena/canary/report?model=` 单模型响应。 */
export interface CanaryModelReport {
  readonly model: string
  readonly baselineTs: number
  readonly historyRuns: number
  /** 探针组描述清单。 */
  readonly probes: readonly string[]
  readonly report: DriftReport
}

/** `GET /arena/canary/report`（缺省）全部受监控模型概览。 */
export interface CanaryOverviewResponse {
  readonly models: ReadonlyArray<{
    readonly model: string
    readonly baselineTs: number
    readonly historyRuns: number
    readonly verdict: DriftReport['verdict']
  }>
}

/** 对指定模型运行确定性探针组并比对基线（单次最多 5 个模型）。 */
export function runCanaryProbes(
  request: { models: readonly string[] },
  options?: RequestOptions,
): Promise<CanaryRunResponse> {
  return companionPost<CanaryRunResponse>('/arena/canary/run', request, options)
}

/** 查看漂移报告（不发起任何调用）：带 model 为单模型详情，缺省为全部模型概览。 */
export function fetchCanaryReport(model: string, options?: RequestOptions): Promise<CanaryModelReport> {
  return companionGet<CanaryModelReport>('/arena/canary/report', { model }, options)
}

export function fetchCanaryOverview(options?: RequestOptions): Promise<CanaryOverviewResponse> {
  return companionGet<CanaryOverviewResponse>('/arena/canary/report', undefined, options)
}

/** 重置基线（确认厂商更新后重新锚定）。 */
export function resetCanaryBaseline(
  request: { model: string },
  options?: RequestOptions,
): Promise<{ ok: true; hint: string }> {
  return companionPost<{ ok: true; hint: string }>('/arena/canary/reset', request, options)
}

// ---------------------------------------------------------------------------
// 模块 G 创新扩展：能力-成本-延迟帕累托前沿（/arena/frontier）
// ---------------------------------------------------------------------------

/** 前沿分析单模型行。 */
export interface FrontierModelRow {
  readonly model: string
  /** Elo 评级（仅有场次模型参与分析）。 */
  readonly rating: number
  /** 累计场次（样本量参考）。 */
  readonly games: number
  /** 典型调用的成本（元）。 */
  readonly costCny: number
  /** 平均延迟（毫秒；金丝雀实测，或档位先验估计）。 */
  readonly latencyMs: number
  /** true = 延迟为档位先验估计（无实测数据）。 */
  readonly latencyEstimated: boolean
  /** 是否在帕累托前沿上。 */
  readonly onFrontier: boolean
  /** 支配该模型的最优替代（前沿模型为 null）。 */
  readonly dominatedBy: string | null
  /** 单位成本能力（Elo/元）。 */
  readonly eloPerCny: number
}

/** `GET /arena/frontier` 响应。 */
export interface FrontierResponse {
  readonly generatedAt: number
  /** 参与分析的模型数（仅含有 Elo 场次的模型）。 */
  readonly modelCount: number
  /** 帕累托前沿（rating 降序）。 */
  readonly frontier: readonly FrontierModelRow[]
  /** 全部模型（含被支配者，rating 降序）。 */
  readonly models: readonly FrontierModelRow[]
  /** 性价比冠军（前沿上 Elo/元 最高；空集为 null）。 */
  readonly valueChampion: FrontierModelRow | null
  /** 预算冠军（与最高分差距 ≤100 中成本最低；空集为 null）。 */
  readonly budgetChampion: FrontierModelRow | null
  readonly advice: string
  /** 有评级但无价目、未参与分析的模型。 */
  readonly unpriced?: readonly string[]
  readonly unpricedNote?: string
}

/** 能力-成本-延迟三维帕累托前沿分析（Elo × 计价 × 金丝雀延迟）。 */
export function fetchArenaFrontier(options?: RequestOptions): Promise<FrontierResponse> {
  return companionGet<FrontierResponse>('/arena/frontier', undefined, options)
}

// ---------------------------------------------------------------------------
// 模块 H：断点续跑与任务编排（/orchestrator/*）
// ---------------------------------------------------------------------------

/** 流水线步骤定义（H1）。 */
export interface OrchestratorStep {
  readonly id: string
  readonly name: string
  readonly model: string
  readonly prompt: string
  readonly inputFrom: 'prev' | 'literal'
  readonly input: string
  readonly condition: string
  readonly timeoutMs: number
  readonly maxRetries: number
  readonly retryIntervalMs: number
  readonly dependsOn: readonly string[]
}

/** 流水线定义（H1）。 */
export interface OrchestratorPipeline {
  readonly id: string
  readonly name: string
  readonly steps: readonly OrchestratorStep[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** 单步运行记录（H2）。 */
export interface OrchestratorStepRun {
  readonly stepId: string
  readonly status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  readonly attempts: number
  readonly output: string
  readonly error: string
  readonly startedAt: number
  readonly endedAt: number
  readonly latencyMs: number
  readonly tokens: number
}

/** 一次流水线执行（H2 断点续跑单元）。 */
export interface OrchestratorRun {
  readonly id: string
  readonly pipelineId: string
  readonly status: 'running' | 'done' | 'failed' | 'paused' | 'cancelled'
  readonly startedAt: number
  readonly endedAt: number
  readonly steps: Readonly<Record<string, OrchestratorStepRun>>
  readonly message: string
}

/** 执行列表摘要（GET /orchestrator/runs）。 */
export interface OrchestratorRunSummary {
  readonly id: string
  readonly pipelineId: string
  readonly status: OrchestratorRun['status']
  readonly startedAt: number
  readonly endedAt: number
  readonly message: string
  readonly progress: { readonly done: number; readonly total: number }
}

/** 队列任务（H3）。 */
export interface OrchestratorQueueTask {
  readonly id: string
  readonly name: string
  readonly prompt: string
  readonly model: string
  readonly priority: 'high' | 'medium' | 'low'
  readonly deadline: number
  readonly failurePolicy: 'skip' | 'retry' | 'notify'
  readonly status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'paused'
  readonly createdAt: number
  readonly finishedAt: number
  readonly output: string
  readonly error: string
  readonly attempts: number
}

/** 队列状态计数。 */
export type OrchestratorQueueCounts = Readonly<Record<string, number>>

/** 定时任务（H4）。 */
export interface OrchestratorJob {
  readonly id: string
  readonly name: string
  readonly cron: string
  readonly scheduleText: string
  readonly prompt: string
  readonly model: string
  readonly offPeakOnly: boolean
  readonly enabled: boolean
  readonly createdAt: number
  readonly lastRunAt: number
  readonly nextRunAt: number
}

/** 定时任务执行归档（H4）。 */
export interface OrchestratorJobRun {
  readonly id: string
  readonly jobId: string
  readonly ts: number
  readonly ok: boolean
  readonly output: string
  readonly error: string
  readonly latencyMs: number
}

/** 列出全部流水线。 */
export function fetchPipelines(options?: RequestOptions): Promise<{ pipelines: readonly OrchestratorPipeline[] }> {
  return companionGet<{ pipelines: readonly OrchestratorPipeline[] }>('/orchestrator/pipelines', undefined, options)
}

/** 创建或更新流水线（携带 id 为更新）。 */
export function savePipeline(
  request: { id?: string; name: string; steps: readonly Partial<OrchestratorStep>[] },
  options?: RequestOptions,
): Promise<{ pipeline: OrchestratorPipeline }> {
  return companionPost<{ pipeline: OrchestratorPipeline }>('/orchestrator/pipelines', request, options)
}

/** 删除流水线。 */
export function deletePipeline(id: string): Promise<OkResponse> {
  return companionDelete<OkResponse>('/orchestrator/pipelines', { id })
}

/** 读取流水线自动生成的 YAML 配置。 */
export function fetchPipelineYaml(id: string, options?: RequestOptions): Promise<{ id: string; yaml: string }> {
  return companionGet<{ id: string; yaml: string }>('/orchestrator/pipelines/yaml', { id }, options)
}

/** 启动一次执行（后台异步，立即返回 runId）。 */
export function startPipelineRun(
  pipelineId: string,
  options?: RequestOptions,
): Promise<{ runId: string; status: OrchestratorRun['status'] }> {
  return companionPost('/orchestrator/runs', { pipelineId }, options)
}

/** 断点续跑：从最后成功步骤继续。 */
export function resumePipelineRun(
  runId: string,
  options?: RequestOptions,
): Promise<{ runId: string; status: OrchestratorRun['status'] }> {
  return companionPost('/orchestrator/runs/resume', { runId }, options)
}

/** 暂停执行。 */
export function pausePipelineRun(runId: string): Promise<OkResponse> {
  return companionPost<OkResponse>('/orchestrator/runs/pause', { runId })
}

/** 取消执行。 */
export function cancelPipelineRun(runId: string): Promise<OkResponse> {
  return companionPost<OkResponse>('/orchestrator/runs/cancel', { runId })
}

/** 列出执行记录（可按流水线过滤）。 */
export function fetchPipelineRuns(
  pipelineId?: string,
  options?: RequestOptions,
): Promise<{ runs: readonly OrchestratorRunSummary[] }> {
  return companionGet<{ runs: readonly OrchestratorRunSummary[] }>('/orchestrator/runs', { pipelineId }, options)
}

/** 读取单次执行详情（含各步骤中间结果）。 */
export function fetchPipelineRun(id: string, options?: RequestOptions): Promise<{ run: OrchestratorRun }> {
  return companionGet<{ run: OrchestratorRun }>('/orchestrator/runs/get', { id }, options)
}

/** 删除执行记录。 */
export function deletePipelineRun(id: string): Promise<OkResponse> {
  return companionDelete<OkResponse>('/orchestrator/runs', { id })
}

/** 读取批量队列（任务列表 + 计数）。 */
export function fetchQueue(options?: RequestOptions): Promise<{
  tasks: readonly OrchestratorQueueTask[]
  counts: OrchestratorQueueCounts
}> {
  return companionGet('/orchestrator/queue', undefined, options)
}

/** 提交批量任务。 */
export function submitQueueTask(
  request: {
    name: string
    prompt: string
    model?: string
    priority?: 'high' | 'medium' | 'low'
    deadline?: number
    failurePolicy?: 'skip' | 'retry' | 'notify'
  },
  options?: RequestOptions,
): Promise<{ task: OrchestratorQueueTask }> {
  return companionPost('/orchestrator/queue', request, options)
}

/** 取消队列任务。 */
export function cancelQueueTask(id: string): Promise<OkResponse> {
  return companionPost<OkResponse>('/orchestrator/queue/cancel', { id })
}

/** 暂停排队中的任务。 */
export function pauseQueueTask(id: string): Promise<OkResponse> {
  return companionPost<OkResponse>('/orchestrator/queue/pause', { id })
}

/** 恢复已暂停的任务。 */
export function resumeQueueTask(id: string): Promise<OkResponse> {
  return companionPost<OkResponse>('/orchestrator/queue/resume', { id })
}

/** 批量操作队列（pause/resume/cancel 全部可操作任务）。 */
export function batchQueue(action: 'pause' | 'resume' | 'cancel'): Promise<{ ok: true; changed: number }> {
  return companionPost('/orchestrator/queue/batch', { action })
}

/** 删除队列任务记录。 */
export function deleteQueueTask(id: string): Promise<OkResponse> {
  return companionDelete<OkResponse>('/orchestrator/queue', { id })
}

/** 列出定时任务。 */
export function fetchJobs(options?: RequestOptions): Promise<{ jobs: readonly OrchestratorJob[] }> {
  return companionGet<{ jobs: readonly OrchestratorJob[] }>('/orchestrator/jobs', undefined, options)
}

/** 自然语言/Cron 解析预检。 */
export function parseSchedule(
  text: string,
  options?: RequestOptions,
): Promise<{ cron: string; nextRunAt: number }> {
  return companionPost('/orchestrator/parse-schedule', { text }, options)
}

/** 创建或更新定时任务（携带 id 为更新）。 */
export function saveJob(
  request: {
    id?: string
    name: string
    prompt: string
    schedule: string
    model?: string
    offPeakOnly?: boolean
    enabled?: boolean
  },
  options?: RequestOptions,
): Promise<{ job: OrchestratorJob }> {
  return companionPost('/orchestrator/jobs', request, options)
}

/** 启用/停用定时任务。 */
export function toggleJob(id: string, enabled: boolean): Promise<{ job: OrchestratorJob }> {
  return companionPost('/orchestrator/jobs/toggle', { id, enabled })
}

/** 删除定时任务。 */
export function deleteJob(id: string): Promise<OkResponse> {
  return companionDelete<OkResponse>('/orchestrator/jobs', { id })
}

/** 读取定时任务历史执行记录。 */
export function fetchJobRuns(jobId: string, options?: RequestOptions): Promise<{ runs: readonly OrchestratorJobRun[] }> {
  return companionGet<{ runs: readonly OrchestratorJobRun[] }>('/orchestrator/jobs/runs', { jobId }, options)
}

// ---------------------------------------------------------------------------
// 模块 H 创新扩展：模型断路器（/orchestrator/circuits）
// ---------------------------------------------------------------------------

/** 单个模型的断路器快照。 */
export interface CircuitSnapshotRow {
  readonly model: string
  /** closed=正常放行；open=熔断中；half-open=冷却结束验证恢复。 */
  readonly state: 'closed' | 'open' | 'half-open'
  /** 连续失败次数。 */
  readonly failures: number
  /** 进入 open 的时间戳（closed 时为 0）。 */
  readonly openedAt: number
  /** half-open 探针放行时间戳。 */
  readonly probeAt: number
}

/** `GET /orchestrator/circuits` 响应。 */
export interface CircuitsResponse {
  readonly circuits: readonly CircuitSnapshotRow[]
  /** 状态图例（state → 说明文案）。 */
  readonly legend: Readonly<Record<string, string>>
}

/** 读取模型断路器全景。 */
export function fetchCircuits(options?: RequestOptions): Promise<CircuitsResponse> {
  return companionGet<CircuitsResponse>('/orchestrator/circuits', undefined, options)
}

// ---------------------------------------------------------------------------
// 模块 H 创新扩展：蒙特卡洛工期模拟（PERT 三点估算，/orchestrator/monte）
// ---------------------------------------------------------------------------

/** 单步三点估算。 */
export interface MonteStepEstimate {
  readonly stepId: string
  readonly name: string
  /** 历史样本数（该步在全部运行中的成功延迟记录数）。 */
  readonly sampleCount: number
  readonly optimisticMs: number
  readonly mostLikelyMs: number
  readonly pessimisticMs: number
  /** PERT 均值 (a+4m+b)/6。 */
  readonly pertMeanMs: number
  /** PERT 标准差 (b−a)/6。 */
  readonly pertSdMs: number
  /** true = 无历史样本（先验估计，建议先跑几轮校准）。 */
  readonly estimated: boolean
  /** 关键性指数：出现在模拟关键路径上的频率（0-1）。 */
  readonly criticality: number
}

/** 总工期分位数摘要。 */
export interface MonteTotalSummary {
  readonly p50Ms: number
  readonly p80Ms: number
  readonly p90Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
  readonly meanMs: number
  readonly sdMs: number
  readonly minMs: number
  readonly maxMs: number
}

/** `POST /orchestrator/monte` 响应。 */
export interface MonteCarloResponse {
  readonly pipelineId: string
  readonly pipelineName: string
  /** 依赖图是否合法（复用 DAG 规划器校验）。 */
  readonly valid: boolean
  readonly errors: readonly string[]
  readonly iterations: number
  /** 并行度上限（null = 无界并行）。 */
  readonly parallelism: number | null
  readonly steps: readonly MonteStepEstimate[]
  readonly total: MonteTotalSummary | null
  /** 关键性最高的步骤 id（瓶颈）。 */
  readonly bottleneckStepId: string | null
  readonly bottleneckCriticality: number
  readonly advice: string
}

/** 蒙特卡洛工期模拟（iterations 缺省 2000；parallelism 限定并行工人上限）。 */
export function simulatePipelineDuration(
  request: { pipelineId: string; iterations?: number; parallelism?: number },
  options?: RequestOptions,
): Promise<MonteCarloResponse> {
  return companionPost<MonteCarloResponse>('/orchestrator/monte', request, options)
}

// ---------------------------------------------------------------------------
// 模块 J：安全与审计（/security/*）
// ---------------------------------------------------------------------------

/** Key 权限范围（J1）。 */
export interface SecurityKeyScope {
  readonly access: 'full' | 'read'
  readonly models: readonly string[]
  readonly dailyBudgetCny: number
}

/** 命名 Key 展示视图（安全红线：不含明文，仅掩码元数据）。 */
export interface SecurityKeyView {
  readonly name: string
  readonly note: string
  readonly createdAt: number
  readonly lastUsedAt: number
  readonly scope: SecurityKeyScope
  readonly configured: boolean
  readonly rotationDue: boolean
}

/** 审计日志条目（J2；Prompt 摘要已脱敏）。 */
export interface AuditEntry {
  readonly id: string
  readonly ts: number
  readonly model: string
  readonly promptSummary: string
  readonly promptTokens: number
  readonly completionTokens: number
  readonly costCny: number
  readonly status: string
  readonly source: string
}

/** DLP 规则（J3）。 */
export interface DlpRule {
  readonly id: string
  readonly name: string
  readonly pattern: string
  readonly builtin: boolean
  readonly enabled: boolean
}

/** DLP 命中。 */
export interface DlpFinding {
  readonly ruleId: string
  readonly ruleName: string
  readonly sample: string
  readonly count: number
}

/** DLP 设置（J3）。 */
export interface DlpSettings {
  readonly enabled: boolean
  readonly strict: boolean
}

/** 合规报表（J4）。 */
export interface ComplianceReport {
  readonly from: string
  readonly to: string
  readonly totalCalls: number
  readonly totalCostCny: number
  readonly totalTokens: number
  readonly modelShare: Readonly<Record<string, number>>
  readonly blocks: Readonly<Record<string, number>>
  readonly blockTotal: number
  readonly alerts: readonly { readonly ts: number; readonly kind: string; readonly detail: string }[]
}

/** 读取命名 Key 列表（不回传明文）。 */
export function fetchSecurityKeys(options?: RequestOptions): Promise<{
  keys: readonly SecurityKeyView[]
  rotationDays: number
  activeConfigured: boolean
}> {
  return companionGet('/security/keys', undefined, options)
}

/** 保存命名 Key（服务端加密落盘）。 */
export function saveSecurityKey(
  request: { name: string; apiKey: string; note?: string; scope?: Partial<SecurityKeyScope> },
  options?: RequestOptions,
): Promise<{ key: SecurityKeyView }> {
  return companionPost('/security/keys', request, options)
}

/** 切换激活 Key。 */
export function activateSecurityKey(name: string): Promise<OkResponse> {
  return companionPost<OkResponse>('/security/keys/activate', { name })
}

/** 删除命名 Key。 */
export function deleteSecurityKey(name: string): Promise<OkResponse> {
  return companionDelete<OkResponse>('/security/keys', { name })
}

/** Key 泄露检测（粘贴疑似泄露内容进行检查）。 */
export function checkKeyLeak(content: string, options?: RequestOptions): Promise<{
  leaked: readonly string[]
  safe: boolean
}> {
  return companionPost('/security/keys/leak-check', { content }, options)
}

/** 读取 Key 轮换到期提醒。 */
export function fetchKeyRotation(options?: RequestOptions): Promise<{
  due: readonly { readonly name: string; readonly ageDays: number }[]
  thresholdDays: number
}> {
  return companionGet('/security/keys/rotation', undefined, options)
}

/** 查询审计日志（支持时间/模型/状态筛选）。 */
export function fetchAuditLog(
  params: { from?: number; to?: number; model?: string; status?: string; limit?: number },
  options?: RequestOptions,
): Promise<{ entries: readonly AuditEntry[] }> {
  return companionGet<{ entries: readonly AuditEntry[] }>('/security/audit', params, options)
}

/** 导出审计日志（CSV/JSON）。 */
export function exportAuditLog(
  params: { format: 'csv' | 'json'; from?: number; to?: number },
  options?: RequestOptions,
): Promise<{ format: 'csv' | 'json'; fileName: string; content: string }> {
  return companionGet('/security/audit/export', params, options)
}

/** 读取 DLP 状态（设置 + 规则）。 */
export function fetchDlpState(options?: RequestOptions): Promise<{
  settings: DlpSettings
  rules: readonly DlpRule[]
}> {
  return companionGet('/security/dlp/state', undefined, options)
}

/** 更新 DLP 设置。 */
export function updateDlpSettings(patch: { enabled?: boolean; strict?: boolean }): Promise<{ settings: DlpSettings }> {
  return companionPost('/security/dlp/settings', patch)
}

/** 新增自定义 DLP 规则。 */
export function addDlpRule(
  request: { name: string; pattern: string; enabled?: boolean },
  options?: RequestOptions,
): Promise<{ rules: readonly DlpRule[] }> {
  return companionPost('/security/dlp/rules', request, options)
}

/** 启用/停用 DLP 规则。 */
export function toggleDlpRule(id: string, enabled: boolean): Promise<{ rules: readonly DlpRule[] }> {
  return companionPost('/security/dlp/rules/toggle', { id, enabled })
}

/** 删除自定义 DLP 规则。 */
export function deleteDlpRule(id: string): Promise<{ rules: readonly DlpRule[] }> {
  return companionDelete('/security/dlp/rules', { id })
}

/** DLP 发送前预检扫描。 */
export function scanDlp(text: string, options?: RequestOptions): Promise<{
  findings: readonly DlpFinding[]
  clean: boolean
  settings: DlpSettings
}> {
  return companionPost('/security/dlp/scan', { text }, options)
}

// ---------------------------------------------------------------------------
// 模块 J 创新扩展：提示注入检测（/security/injection/*）
// ---------------------------------------------------------------------------

/** 注入检测设置。 */
export interface InjectionSettings {
  /** 总开关：关闭时不扫描不拦截。 */
  readonly enabled: boolean
  /** 严格模式：malicious 判定直接拦截调用（否则仅警告）。 */
  readonly strict: boolean
}

/** 注入命中（片段已掩码）。 */
export interface InjectionFinding {
  /** 检测器 id（如 'instruction-override'）。 */
  readonly id: string
  /** 攻击类别（中文展示名）。 */
  readonly category: string
  /** 严重度权重。 */
  readonly severity: number
  /** 命中片段（已掩码）。 */
  readonly sample: string
  readonly count: number
}

/** `POST /security/injection/scan` 响应。 */
export interface InjectionScanResponse {
  readonly findings: readonly InjectionFinding[]
  /** 风险评分 0~100。 */
  readonly risk: number
  /** 三档判定。 */
  readonly verdict: 'clean' | 'suspicious' | 'malicious'
  readonly settings: InjectionSettings
}

/** `GET /security/injection/state` 响应。 */
export interface InjectionStateResponse {
  readonly settings: InjectionSettings
  /** 六类检测器 id 清单。 */
  readonly detectors: readonly string[]
}

/** 读取注入检测状态（设置 + 检测器清单）。 */
export function fetchInjectionState(options?: RequestOptions): Promise<InjectionStateResponse> {
  return companionGet<InjectionStateResponse>('/security/injection/state', undefined, options)
}

/** 更新注入检测设置（稀疏补丁）。 */
export function updateInjectionSettings(
  patch: { enabled?: boolean; strict?: boolean },
  options?: RequestOptions,
): Promise<{ settings: InjectionSettings }> {
  return companionPost<{ settings: InjectionSettings }>('/security/injection/settings', patch, options)
}

/** 提示注入扫描（发送前预检）。 */
export function scanInjection(text: string, options?: RequestOptions): Promise<InjectionScanResponse> {
  return companionPost<InjectionScanResponse>('/security/injection/scan', { text }, options)
}

/** 读取合规报表。 */
export function fetchComplianceReport(
  range: { from: string; to: string },
  options?: RequestOptions,
): Promise<ComplianceReport> {
  return companionGet<ComplianceReport>('/security/report', { from: range.from, to: range.to }, options)
}

/** 导出合规报表（自包含 HTML，经浏览器打印可另存 PDF）。 */
export function exportComplianceReport(
  range: { from: string; to: string },
  options?: RequestOptions,
): Promise<{ format: 'html'; fileName: string; content: string }> {
  return companionGet('/security/report/export', { from: range.from, to: range.to }, options)
}

// ---------------------------------------------------------------------------
// 模块 J 创新扩展：敏感数据污点追踪（/security/taint/scan）
// ---------------------------------------------------------------------------

/** 污点源（敏感值首次进入会话的位置；掩码展示）。 */
export interface TaintSource {
  readonly ruleId: string
  readonly ruleName: string
  /** 掩码值（安全红线：报告不携带明文）。 */
  readonly masked: string
  /** 首次出现的用户消息 seq。 */
  readonly seq: number
  readonly time: number
}

/** 传播链上的一跳。 */
export interface TaintHop {
  readonly seq: number
  readonly time: number
  /** 事件类别（user/assistant/tool-call/tool-result/model-call/…）。 */
  readonly kind: string
  /** 展示标签（如「工具调用：http_request」）。 */
  readonly label: string
}

/** 汇点信道分级。 */
export type TaintSinkChannel = 'outbound' | 'storage' | 'model' | 'internal'

/** 单条污点流：源 → 传播链 → 汇点。 */
export interface TaintFlow {
  readonly source: TaintSource
  /** 传播链（按 seq 升序；截尾保留上限）。 */
  readonly hops: readonly TaintHop[]
  /** 链上最远的非 internal 信道（无则 internal）。 */
  readonly sink: TaintSinkChannel
  readonly sinkLabel: string
  readonly severity: 'high' | 'medium' | 'low'
  /** 传播链是否被截断展示。 */
  readonly truncated: boolean
}

/** `POST /security/taint/scan` 响应（全程只含掩码值）。 */
export interface TaintScanResponse {
  readonly sessionId: string
  readonly scannedAt: number
  readonly sources: readonly TaintSource[]
  /** 按严重度降序的污点流（每源一条）。 */
  readonly flows: readonly TaintFlow[]
  readonly stats: {
    readonly sourceCount: number
    /** 被污点波及的事件总数（去重）。 */
    readonly taintedEventCount: number
    readonly outboundFlows: number
    readonly storageFlows: number
    readonly modelFlows: number
  }
  readonly riskLevel: 'high' | 'medium' | 'low' | 'none'
}

/** 敏感数据污点追踪：源 → 传播链 → 外发汇点的完整泄露路径。 */
export function scanTaint(sessionId: string, options?: RequestOptions): Promise<TaintScanResponse> {
  return companionPost<TaintScanResponse>('/security/taint/scan', { sessionId }, options)
}

// ---------------------------------------------------------------------------
// 模块 I：协作与知识管理（/team/*）
// ---------------------------------------------------------------------------

/** 配置合并策略（I1）。 */
export type MergeStrategy = 'local' | 'remote' | 'manual'

/** 团队偏好（I1）。 */
export interface TeamPrefs {
  /** 成员署名（评审作者/评论者标识）。 */
  readonly memberName: string
  /** 导入时的缺省合并策略。 */
  readonly defaultStrategy: MergeStrategy
}

/** 快照可携带的配置分区名（I1）。 */
export type ConfigSection =
  | 'costSettings'
  | 'pricingOverrides'
  | 'handoffTemplates'
  | 'promptTemplates'
  | 'pipelines'
  | 'scheduledJobs'
  | 'dlpRules'

/** 团队配置快照（I1 导出 JSON 文档）。 */
export interface TeamConfigSnapshot {
  readonly kind: 'dsh-companion-team-config'
  readonly version: number
  readonly exportedAt: number
  readonly exportedBy: string
  readonly sections: Readonly<Record<string, unknown>>
}

/** 单条配置差异（I1）。 */
export interface ConfigDiffEntry {
  readonly section: ConfigSection
  readonly key: string
  /** add=仅远程存在；update=两侧不同；same=两侧一致；local-only=仅本地存在。 */
  readonly action: 'add' | 'update' | 'same' | 'local-only'
  readonly local?: unknown
  readonly remote?: unknown
}

/** 单个分区的导入结果汇报（I1）。 */
export interface SectionReport {
  readonly section: ConfigSection
  readonly added: number
  readonly updated: number
  readonly same: number
  readonly skipped: number
  readonly message?: string
}

/** 执行卡片来源（I2）。 */
export type ExperienceSource = 'pipeline' | 'queue' | 'cron' | 'manual'

/** 问题与解决方案笔记（I2）。 */
export interface ExperienceNote {
  readonly problem: string
  readonly solution: string
  readonly ts: number
}

/** 执行卡片（I2 核心实体）。 */
export interface ExperienceCard {
  readonly id: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly source: ExperienceSource
  readonly sourceId: string
  readonly runId: string
  readonly title: string
  readonly model: string
  readonly promptSummary: string
  readonly durationMs: number
  readonly tokens: number
  readonly ok: boolean
  readonly error: string
  readonly tags: readonly string[]
  readonly notes: readonly ExperienceNote[]
}

/** 评审状态（I3）。 */
export type ReviewStatus = 'open' | 'approved' | 'rejected' | 'merged'

/** Prompt 变更评审请求（I3）。 */
export interface ReviewRequest {
  readonly id: string
  readonly title: string
  readonly baseContent: string
  readonly proposedContent: string
  readonly author: string
  readonly note: string
  readonly status: ReviewStatus
  readonly createdAt: number
  readonly updatedAt: number
  /** 合并后生成的 Prompt 主版本号（status='merged' 时有值）。 */
  readonly mergedVersion: number
}

/** 评论批注锚点（I3）。 */
export interface ReviewAnchor {
  readonly side: 'base' | 'proposed'
  readonly line: number
}

/** 评审评论（I3）。 */
export interface ReviewComment {
  readonly id: string
  readonly reviewId: string
  readonly author: string
  readonly content: string
  readonly anchor: ReviewAnchor
  readonly createdAt: number
}

/** 审核决定（I3）。 */
export interface ReviewDecision {
  readonly reviewId: string
  readonly reviewer: string
  readonly verdict: 'approve' | 'reject'
  readonly comment: string
  readonly ts: number
}

/** 读取团队偏好。 */
export function fetchTeamPrefs(options?: RequestOptions): Promise<{ prefs: TeamPrefs }> {
  return companionGet<{ prefs: TeamPrefs }>('/team/prefs', undefined, options)
}

/** 保存团队偏好（稀疏补丁）。 */
export function saveTeamPrefs(
  patch: { memberName?: string; defaultStrategy?: MergeStrategy },
  options?: RequestOptions,
): Promise<{ prefs: TeamPrefs }> {
  return companionPost<{ prefs: TeamPrefs }>('/team/prefs', patch, options)
}

/** 导出团队配置快照。 */
export function exportTeamConfig(options?: RequestOptions): Promise<{ snapshot: TeamConfigSnapshot }> {
  return companionGet<{ snapshot: TeamConfigSnapshot }>('/team/config/export', undefined, options)
}

/** 计算远程快照与本地配置的差异。 */
export function diffTeamConfig(
  snapshot: unknown,
  options?: RequestOptions,
): Promise<{ diffs: readonly ConfigDiffEntry[] }> {
  return companionPost<{ diffs: readonly ConfigDiffEntry[] }>('/team/config/diff', { snapshot }, options)
}

/** 按合并策略导入团队配置快照。 */
export function importTeamConfig(
  request: { snapshot: unknown; strategy: MergeStrategy },
  options?: RequestOptions,
): Promise<{ reports: readonly SectionReport[] }> {
  return companionPost<{ reports: readonly SectionReport[] }>('/team/config/import', request, options)
}

/** 读取最近导入的配置快照归档。 */
export function fetchTeamSnapshots(options?: RequestOptions): Promise<{ snapshots: readonly TeamConfigSnapshot[] }> {
  return companionGet<{ snapshots: readonly TeamConfigSnapshot[] }>('/team/snapshots', undefined, options)
}

/** 删除归档快照（以导出时间戳为键）。 */
export function deleteTeamSnapshot(key: string): Promise<OkResponse> {
  return companionDelete<OkResponse>('/team/snapshots', { key })
}

/** 检索执行卡片（关键词/标签/模型三条件 AND）。 */
export function fetchExperienceCards(
  params: { query?: string; tags?: string; model?: string; limit?: number },
  options?: RequestOptions,
): Promise<{ cards: readonly ExperienceCard[] }> {
  return companionGet<{ cards: readonly ExperienceCard[] }>('/team/experience', params, options)
}

/** 手动创建执行卡片。 */
export function createExperienceCard(
  request: {
    title: string
    model?: string
    tags?: readonly string[]
    promptSummary?: string
    source?: ExperienceSource
  },
  options?: RequestOptions,
): Promise<{ card: ExperienceCard }> {
  return companionPost<{ card: ExperienceCard }>('/team/experience', request, options)
}

/** 为执行卡片补充问题与解决方案笔记。 */
export function addExperienceNote(
  request: { id: string; problem: string; solution: string },
  options?: RequestOptions,
): Promise<{ card: ExperienceCard }> {
  return companionPost<{ card: ExperienceCard }>('/team/experience/notes', request, options)
}

/** 删除执行卡片。 */
export function deleteExperienceCard(id: string): Promise<OkResponse> {
  return companionDelete<OkResponse>('/team/experience', { id })
}

/** 相似推荐执行卡片。 */
export function recommendExperience(
  request: { text: string; limit?: number },
  options?: RequestOptions,
): Promise<{ results: ReadonlyArray<{ card: ExperienceCard; score: number }> }> {
  return companionPost('/team/experience/recommend', request, options)
}

// ---------------------------------------------------------------------------
// 模块 I 创新扩展：经验自动蒸馏（/team/experience/distill*）
// ---------------------------------------------------------------------------

/** 证据链条目：来源轮次定位 + 原文摘录。 */
export interface DistillEvidenceEntry {
  /** 会话日志事件 seq（回读定位）。 */
  readonly seq: number
  readonly kind: 'error' | 'recovery'
  readonly excerpt: string
}

/** 蒸馏经验卡。 */
export interface DistilledCard {
  readonly id: string
  /** 首次蒸馏来源会话。 */
  readonly sessionId: string
  /** 全部来源会话（合并时累积）。 */
  readonly sourceSessions: readonly string[]
  readonly createdAt: number
  /** 最近一次复发时间。 */
  readonly lastSeenAt: number
  /** 出现次数（复发度：跨会话反复出现 = 高置信知识）。 */
  readonly occurrences: number
  /** 首次挖矿信号得分（0-1）。 */
  readonly signalScore: number
  readonly title: string
  readonly lesson: string
  readonly problem: string
  readonly solution: string
  readonly tags: readonly string[]
  /** 证据链：错误/修复轮次摘录。 */
  readonly evidence: readonly DistillEvidenceEntry[]
  /** 是否已晋升为正式执行卡。 */
  readonly promoted: boolean
}

/** 蒸馏卡列表条目（附置信度）。 */
export interface DistilledCardWithConfidence extends DistilledCard {
  readonly confidence: number
}

/** 单会话蒸馏产物。 */
export interface DistillOutcome {
  readonly status: 'created' | 'merged' | 'no-signal'
  readonly card?: DistilledCard
  readonly confidence?: number
  readonly signalScore?: number
  readonly signalCount: number
}

/** `POST /team/experience/distill/scan` 响应。 */
export interface DistillScanResponse {
  readonly scanned: number
  /** 高信号候选会话（本地信号打分，未蒸馏）。 */
  readonly candidates: ReadonlyArray<{ readonly sessionId: string; readonly title: string; readonly score: number }>
  /** 已蒸馏结果（按信号得分降序顺序执行）。 */
  readonly distilled: ReadonlyArray<{ readonly sessionId: string; readonly outcome: DistillOutcome }>
  readonly errors: ReadonlyArray<{ readonly sessionId: string; readonly error: string }>
}

/** 蒸馏单个会话：信号挖矿 → 元提示蒸馏 → 语义去重落库。 */
export function distillSessionExperience(
  request: { sessionId: string },
  options?: RequestOptions,
): Promise<DistillOutcome> {
  return companionPost<DistillOutcome>('/team/experience/distill', request, options)
}

/** 批量挖矿：本地信号打分筛选高信号会话后仅蒸馏高价值轨迹。 */
export function scanDistillExperience(
  request: { limit?: number; maxDistill?: number; minSignal?: number },
  options?: RequestOptions,
): Promise<DistillScanResponse> {
  return companionPost<DistillScanResponse>('/team/experience/distill/scan', request, options)
}

/** 蒸馏卡列表（按置信度降序）。 */
export function fetchDistilledCards(
  options?: RequestOptions,
): Promise<{ cards: readonly DistilledCardWithConfidence[] }> {
  return companionGet<{ cards: readonly DistilledCardWithConfidence[] }>('/team/experience/distilled', undefined, options)
}

/** 晋升蒸馏卡为正式执行经验卡（人工把关闭环）。 */
export function promoteDistilledCard(
  request: { id: string },
  options?: RequestOptions,
): Promise<{ card: ExperienceCard; distilledCard: DistilledCard }> {
  return companionPost<{ card: ExperienceCard; distilledCard: DistilledCard }>(
    '/team/experience/distilled/promote',
    request,
    options,
  )
}

/** 删除蒸馏卡。 */
export function deleteDistilledCard(id: string): Promise<OkResponse> {
  return companionDelete<OkResponse>('/team/experience/distilled', { id })
}

/** 列出全部 Prompt 评审请求。 */
export function fetchReviews(options?: RequestOptions): Promise<{ reviews: readonly ReviewRequest[] }> {
  return companionGet<{ reviews: readonly ReviewRequest[] }>('/team/reviews', undefined, options)
}

/** 创建 Prompt 评审请求。 */
export function createReview(
  request: { title: string; baseContent?: string; proposedContent: string; note?: string },
  options?: RequestOptions,
): Promise<{ review: ReviewRequest }> {
  return companionPost<{ review: ReviewRequest }>('/team/reviews', request, options)
}

/** 读取评审详情（请求 + 评论 + 审核决定）。 */
export function fetchReviewDetail(
  id: string,
  options?: RequestOptions,
): Promise<{ review: ReviewRequest; comments: readonly ReviewComment[]; decisions: readonly ReviewDecision[] }> {
  return companionGet('/team/reviews/get', { id }, options)
}

/** 添加评审评论批注。 */
export function addReviewComment(
  request: { reviewId: string; content: string; anchor?: ReviewAnchor },
  options?: RequestOptions,
): Promise<{ comment: ReviewComment }> {
  return companionPost<{ comment: ReviewComment }>('/team/reviews/comment', request, options)
}

/** 提交审核决定（通过/拒绝）。 */
export function decideReview(
  request: { reviewId: string; verdict: 'approve' | 'reject'; comment?: string },
  options?: RequestOptions,
): Promise<{ decision: ReviewDecision }> {
  return companionPost<{ decision: ReviewDecision }>('/team/reviews/decide', request, options)
}

/** 合并已通过评审进 Prompt 主版本。 */
export function mergeReview(reviewId: string, options?: RequestOptions): Promise<{ ok: true; mergedVersion: number }> {
  return companionPost<{ ok: true; mergedVersion: number }>('/team/reviews/merge', { reviewId }, options)
}

/** 删除评审（级联清理评论与决定）。 */
export function deleteReview(id: string): Promise<OkResponse> {
  return companionDelete<OkResponse>('/team/reviews', { id })
}

// ---------------------------------------------------------------------------
// 模块 I 创新扩展：专家路由（知识足迹画像 + 余弦匹配，/team/experts*）
// ---------------------------------------------------------------------------

/** 团队专家记录。 */
export interface ExpertRecord {
  readonly id: string
  /** 成员署名（须与评审 author 一致才能吃到评审产出足迹）。 */
  readonly name: string
  /** 自报领域关键词（画像语料的种子）。 */
  readonly domains: readonly string[]
  readonly bio: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** 知识足迹画像视图（TF-IDF 顶部术语 + 足迹规模）。 */
export interface ExpertProfileView {
  readonly id: string
  readonly name: string
  readonly domains: readonly string[]
  readonly bio: string
  /** 画像语料的术语总数（足迹规模）。 */
  readonly corpusSize: number
  /** 足迹来源拆解（领域/评审/评论各贡献的语料量）。 */
  readonly sources: { domain: number; reviews: number; comments: number }
  /** TF-IDF 权重最高的术语（知识足迹关键词云）。 */
  readonly topTerms: readonly { readonly term: string; readonly weight: number }[]
}

/** 单位候选专家的匹配结果。 */
export interface ExpertMatch {
  readonly id: string
  readonly name: string
  readonly domains: readonly string[]
  /** 问题向量与足迹向量的余弦相似度。 */
  readonly similarity: number
  /** 问题术语在该足迹中的覆盖率（0-1）。 */
  readonly coverage: number
  /** 命中的高权重术语（为什么是他）。 */
  readonly matchedTerms: readonly { readonly term: string; readonly weight: number }[]
}

/** `POST /team/experts/route` 响应。 */
export interface ExpertRoutingResponse {
  readonly question: string
  /** 路由是否可用（至少注册过一位专家）。 */
  readonly available: boolean
  /** 按相似度降序的全部候选。 */
  readonly candidates: readonly ExpertMatch[]
  /** 推荐专家（无充分信号为 null）。 */
  readonly recommended: ExpertMatch | null
  /** 裁决：confident / tentative / gap。 */
  readonly verdict: 'confident' | 'tentative' | 'gap'
  /** 裁决说明（中文，可展示）。 */
  readonly message: string
  /** 知识盲区：全体足迹都未覆盖的问题术语。 */
  readonly uncoveredTerms: readonly string[]
}

/** 注册/更新专家（同名视为同一专家，更新其领域与简介）。 */
export function saveExpert(
  request: { name: string; domains: readonly string[]; bio?: string },
  options?: RequestOptions,
): Promise<{ expert: ExpertRecord }> {
  return companionPost<{ expert: ExpertRecord }>('/team/experts', request, options)
}

/** 专家目录。 */
export function fetchExperts(
  options?: RequestOptions,
): Promise<{ experts: readonly ExpertRecord[] }> {
  return companionGet<{ experts: readonly ExpertRecord[] }>('/team/experts', undefined, options)
}

/** 删除专家。 */
export function deleteExpert(id: string, options?: RequestOptions): Promise<OkResponse> {
  return companionDelete<OkResponse>('/team/experts', { id }, options)
}

/** 知识足迹画像面板（全部专家的 TF-IDF 顶部术语）。 */
export function fetchExpertProfiles(
  options?: RequestOptions,
): Promise<{ profiles: readonly ExpertProfileView[] }> {
  return companionGet<{ profiles: readonly ExpertProfileView[] }>(
    '/team/experts/profiles',
    undefined,
    options,
  )
}

/** 专家路由：问题 → 余弦匹配 → 推荐专家 + 知识盲区检测。 */
export function routeToExpert(
  question: string,
  options?: RequestOptions,
): Promise<ExpertRoutingResponse> {
  return companionPost<ExpertRoutingResponse>('/team/experts/route', { question }, options)
}

// ---------------------------------------------------------------------------
// 模块 C 创新扩展：Shapley 成本公平分账（POST /cost/attribution）
// ---------------------------------------------------------------------------

/** Shapley 分账条目。 */
export interface ShapleyAllocation {
  readonly id: string
  readonly label: string
  /** 本期用量（元）。 */
  readonly usageCny: number
  /** 单干时的结余（单独用量能拿到的折扣；通常为 0）。 */
  readonly standaloneSavingsCny: number
  /** Shapley 分得的结余（含单干部分 + 联合增益的公平份额）。 */
  readonly shapleySavingsCny: number
  /** 分账后的有效成本 = 用量 − Shapley 结余。 */
  readonly effectiveCny: number
  /** 占联合结余总额的比例（0-1）。 */
  readonly shareOfSavings: number
  /** 相比按用量比例分的差额（正 = Shapley 更照顾该玩家）。 */
  readonly vsProportionalCny: number
}

/** `POST /cost/attribution` 响应。 */
export interface ShapleyReport {
  readonly players: number
  /** 计算方法：exact（≤8 玩家全排列枚举）/ mcmc（蒙特卡洛抽样）。 */
  readonly method: 'exact' | 'mcmc'
  readonly permutations: number
  readonly grandTotalCny: number
  readonly grandDiscount: number
  /** 联盟结余总额 = 大联盟结余 v(N)（元）。 */
  readonly totalSavingsCny: number
  /** 越档增益 = v(N) − Σ 单干结余（只有联合才拿得到的部分）。 */
  readonly synergyGainCny: number
  /** Σ Shapley 结余 − v(N) 的浮点残差（应 < 1e-6）。 */
  readonly residualCny: number
  readonly allocations: readonly ShapleyAllocation[]
  readonly summary: string
}

/** Shapley 成本分账：各部门用量 + 厂商阶梯折扣表 → 边际贡献公平分账。 */
export function attributeCost(
  request: {
    players: readonly { id: string; label?: string; usageCny: number }[]
    tiers: readonly { minCny: number; discount: number }[]
  },
  options?: RequestOptions,
): Promise<ShapleyReport> {
  return companionPost<ShapleyReport>('/cost/attribution', request, options)
}

// ---------------------------------------------------------------------------
// 模块 J 创新扩展：k-匿名泛化引擎（POST /security/kanonymize）
// ---------------------------------------------------------------------------

/** 单维度泛化决策。 */
export interface FieldGeneralization {
  readonly field: string
  /** 应用的层级（0 = 未泛化）。 */
  readonly level: number
  readonly label: string
  readonly fullyMasked: boolean
}

/** 等价类（同 QI 组）概况。 */
export interface EquivalenceClass {
  readonly qi: Readonly<Record<string, string>>
  readonly size: number
}

/** `POST /security/kanonymize` 响应。 */
export interface KanymityResult {
  readonly records: readonly {
    readonly qi: Readonly<Record<string, string>>
    readonly payload: Readonly<Record<string, unknown>>
  }[]
  readonly report: {
    readonly inputCount: number
    readonly publishedCount: number
    readonly k: number
    readonly satisfied: boolean
    readonly suppressedCount: number
    readonly suppressionRate: number
    readonly generalizations: readonly FieldGeneralization[]
    readonly equivalenceClasses: readonly EquivalenceClass[]
    readonly classCount: number
    readonly averageClassSize: number
    readonly reidentificationRisk: number
    readonly summary: string
  }
}

/** k-匿名化：批量数据发布前的再识别风险评估与泛化发布。 */
export function kanonymize(
  request: {
    records: Readonly<Record<string, unknown>>[]
    k: number
  },
  options?: RequestOptions,
): Promise<KanymityResult> {
  return companionPost<KanymityResult>('/security/kanonymize', request, options)
}

// ---------------------------------------------------------------------------
// 模块 E 创新扩展：孤立森林轨迹异常检测（GET /trace/anomalies）
// ---------------------------------------------------------------------------

/** `GET /trace/anomalies` 响应。 */
export interface TraceAnomalyReport {
  readonly traces: number
  readonly trees: number
  readonly subsampleSize: number
  readonly threshold: number
  readonly anomalousCount: number
  readonly entries: readonly {
    readonly traceId: string
    readonly sessionId?: string
    readonly startedAt: number
    /** 异常分 s(x) ∈ (0,1]，> 0.5 偏异常。 */
    readonly score: number
    readonly anomalous: boolean
    readonly zScores: readonly { readonly feature: string; readonly label: string; readonly z: number }[]
    readonly drivers: readonly { readonly feature: string; readonly label: string; readonly z: number }[]
    readonly evidence: string
  }[]
  readonly note: string
  readonly summary: string
}

/** 孤立森林轨迹异常检测：7 维特征 + 全局异常评分。 */
export function fetchTraceAnomalies(
  params?: { limit?: number; seed?: number },
  options?: RequestOptions,
): Promise<TraceAnomalyReport> {
  return companionGet<TraceAnomalyReport>('/trace/anomalies', params, options)
}

// ---------------------------------------------------------------------------
// 模块 G 创新扩展：Glicko-2 时变置信评级（/arena/glicko*）
// ---------------------------------------------------------------------------

/** Glicko-2 对战记录。 */
export interface GlickoMatch {
  readonly id: string
  readonly ts: number
  readonly a: string
  readonly b: string
  readonly outcome: 'win' | 'loss' | 'draw'
  readonly source: 'manual' | 'leaderboard'
}

/** Glicko-2 排行榜条目。 */
export interface GlickoRow {
  readonly model: string
  readonly rating: number
  /** 当前 RD（含闲置增长，惰性计算）。 */
  readonly rd: number
  readonly ci95: readonly [number, number]
  /** 保守分 = rating − 1.96×RD（排名依据）。 */
  readonly conservative: number
  readonly games: number
  readonly winRate: number
  readonly inactiveDays: number
  readonly volatility: number
  readonly rank: number
}

/** `GET /arena/glicko` 响应。 */
export interface GlickoReport {
  readonly matches: readonly GlickoMatch[]
  readonly standings: readonly GlickoRow[]
  readonly summary: string
}

/** 提交一次偏好对战（评级 + RD + 波动率联合更新），返回新排行。 */
export function recordGlickoMatch(
  request: { a: string; b: string; outcome: 'win' | 'loss' | 'draw' },
  options?: RequestOptions,
): Promise<readonly GlickoRow[]> {
  return companionPost<readonly GlickoRow[]>('/arena/glicko/match', request, options)
}

/** Glicko-2 评级表（保守分排名 + 95% CI + 闲置 RD 增长）。 */
export function fetchGlickoStandings(options?: RequestOptions): Promise<GlickoReport> {
  return companionGet<GlickoReport>('/arena/glicko', undefined, options)
}

/** 清空全部 Glicko-2 对战与评级。 */
export function resetGlicko(options?: RequestOptions): Promise<OkResponse> {
  return companionPost<OkResponse>('/arena/glicko/reset', undefined, options)
}

// ---------------------------------------------------------------------------
// 模块 H 创新扩展：关键路径分析（POST /orchestrator/cpm）
// ---------------------------------------------------------------------------

/** CPM 步骤行。 */
export interface CpmStep {
  readonly stepId: string
  readonly name: string
  readonly durationMs: number
  readonly estimated: boolean
  readonly sampleCount: number
  /** 最早开始/最早结束（毫秒，相对流水线起点）。 */
  readonly esMs: number
  readonly efMs: number
  /** 最晚开始/最晚结束（不延误总工期的前提下）。 */
  readonly lsMs: number
  readonly lfMs: number
  /** 松弛 = LS − ES（0 = 关键步骤）。 */
  readonly slackMs: number
  readonly critical: boolean
  readonly dependsOn: readonly string[]
}

/** 并发画像。 */
export interface ConcurrencyProfile {
  readonly peak: number
  readonly peakAtMs: number
  readonly peakSteps: readonly string[]
  readonly parallelismSavedMs: number
}

/** `POST /orchestrator/cpm` 响应。 */
export interface CpmReport {
  readonly pipelineId: string
  readonly pipelineName: string
  readonly valid: boolean
  readonly errors: readonly string[]
  readonly criticalPath: readonly string[]
  readonly makespanMs: number
  readonly steps: readonly CpmStep[]
  readonly concurrency: ConcurrencyProfile | null
  readonly bottleneckStepId: string | null
  readonly advice: string
}

/** 关键路径分析：确定性 CPM + 并发画像 + 瓶颈识别。 */
export function analyzeCriticalPath(
  request: { pipelineId: string; durationOverrides?: Readonly<Record<string, number>> },
  options?: RequestOptions,
): Promise<CpmReport> {
  return companionPost<CpmReport>('/orchestrator/cpm', request, options)
}

// ---------------------------------------------------------------------------
// 模块 F 创新扩展：Prompt 静态分析（POST /prompt/lint）
// ---------------------------------------------------------------------------

/** lint 发现。 */
export interface LintFinding {
  readonly severity: 'error' | 'warning' | 'info'
  readonly rule: string
  readonly message: string
  readonly excerpt: string
}

/** Prompt 复杂度度量。 */
export interface PromptMetrics {
  readonly chars: number
  readonly estimatedTokens: number
  readonly sentences: number
  readonly directives: number
  readonly directiveDensity: number
  readonly hardConstraints: number
  readonly maxSentenceChars: number
  readonly nestingDepth: number
  readonly vagueTerms: number
}

/** `POST /prompt/lint` 响应。 */
export interface PromptLintReport {
  /** 健康分（0-100）。 */
  readonly score: number
  /** A（≥90）/ B（≥75）/ C（≥60）/ D（<60）。 */
  readonly grade: 'A' | 'B' | 'C' | 'D'
  readonly findings: readonly LintFinding[]
  readonly metrics: PromptMetrics
  readonly summary: string
}

/** Prompt 静态分析：矛盾指令/占位符/模糊量词检测 + 复杂度度量（零模型调用）。 */
export function lintPrompt(
  request: { text: string; variables?: readonly string[]; budgetTokens?: number },
  options?: RequestOptions,
): Promise<PromptLintReport> {
  return companionPost<PromptLintReport>('/prompt/lint', request, options)
}

// ---------------------------------------------------------------------------
// 模块 D 创新扩展：MMR 多样性重排（POST /search/diversify）
// ---------------------------------------------------------------------------

/** MMR 入选条目。 */
export interface MmrEntry {
  readonly sessionId: string
  readonly title: string
  readonly originalRank: number
  readonly relevance: number
  readonly maxRedundancy: number
  readonly mmrScore: number
  readonly tags: readonly string[]
}

/** 被淘汰的冗余条目。 */
export interface RedundantDrop {
  readonly sessionId: string
  readonly title: string
  readonly originalRank: number
  readonly redundantWith: string
  readonly similarity: number
}

/** `POST /search/diversify` 响应。 */
export interface MmrReport {
  readonly lambda: number
  readonly candidates: number
  readonly selectedCount: number
  readonly selected: readonly MmrEntry[]
  readonly dropped: readonly RedundantDrop[]
  readonly avgPairwiseSimBefore: number
  readonly avgPairwiseSimAfter: number
  readonly summary: string
}

/** MMR 多样性重排：λ 权衡相关性与冗余，附去重审计。 */
export function diversifySearch(
  request: {
    query: string
    from?: string
    to?: string
    tags?: string
    limit?: number
    lambda?: number
  },
  options?: RequestOptions,
): Promise<MmrReport> {
  return companionPost<MmrReport>('/search/diversify', request, options)
}

// ---------------------------------------------------------------------------
// 模块 I 创新扩展：Bus Factor + 协作中心性（GET /team/busfactor）
// ---------------------------------------------------------------------------

/** `GET /team/busfactor` 响应。 */
export interface BusFactorReport {
  readonly domains: readonly {
    readonly domain: string
    readonly members: readonly string[]
    readonly coverage: number
    readonly atRisk: boolean
  }[]
  /** 整体 bus factor = 最小领域覆盖（无领域数据为 null）。 */
  readonly busFactor: number | null
  readonly atRiskCount: number
  readonly fragileCount: number
  readonly isolatedExperts: readonly {
    readonly name: string
    readonly domains: readonly string[]
    readonly note: string
  }[]
  readonly centrality: readonly {
    readonly name: string
    readonly score: number
    readonly normalized: number
    readonly degree: number
    readonly participations: number
  }[]
  readonly hubs: readonly {
    readonly name: string
    readonly score: number
    readonly normalized: number
    readonly degree: number
    readonly participations: number
  }[]
  readonly edges: number
  readonly summary: string
}

/** Bus Factor 分析：领域覆盖单点风险 + PageRank 协作枢纽。 */
export function fetchBusFactor(options?: RequestOptions): Promise<BusFactorReport> {
  return companionGet<BusFactorReport>('/team/busfactor', undefined, options)
}

// ---------------------------------------------------------------------------
// 模块 B 创新扩展：交接验收测试（/handoff/acceptance*）
// ---------------------------------------------------------------------------

/** 单道验收题。 */
export interface AcceptanceQuestion {
  readonly id: string
  readonly kind: 'anchor' | 'reference' | 'open' | 'action'
  readonly kindLabel: string
  readonly question: string
  readonly expectedAnswer: string
  readonly keywords: readonly string[]
  readonly source: { readonly tier: 'anchors' | 'reference' | 'active'; readonly index: number }
}

/** `GET /handoff/acceptance` 响应。 */
export interface AcceptanceSuite {
  readonly handoffId: string
  readonly depth: number
  readonly totalQuestions: number
  readonly byKind: Readonly<Record<'anchor' | 'reference' | 'open' | 'action', number>>
  readonly questions: readonly AcceptanceQuestion[]
  readonly summary: string
}

/** `POST /handoff/acceptance/grade` 响应。 */
export interface AcceptanceGrade {
  readonly handoffId: string
  readonly totalQuestions: number
  readonly answered: number
  readonly passed: number
  /** 总分（过题率 0-1）。 */
  readonly score: number
  readonly verdict: 'passed' | 'borderline' | 'failed'
  readonly perQuestion: readonly {
    readonly id: string
    readonly kind: 'anchor' | 'reference' | 'open' | 'action'
    readonly kindLabel: string
    readonly question: string
    readonly score: number
    readonly passed: boolean
    readonly missingKeywords: readonly string[]
    readonly unanswered: boolean
  }[]
  readonly weakestKind: 'anchor' | 'reference' | 'open' | 'action' | null
  readonly summary: string
}

/** 生成交接验收卷（缺省 handoffId 用最近一次结构化交接）。 */
export function fetchAcceptanceSuite(handoffId?: string, options?: RequestOptions): Promise<AcceptanceSuite> {
  return companionGet<AcceptanceSuite>('/handoff/acceptance', handoffId ? { handoffId } : undefined, options)
}

/** 验收评分：提交 {questionId, answer} 数组（卷面按存储的交接确定性重建）。 */
export function gradeAcceptance(
  request: { handoffId: string; answers: readonly { questionId: string; answer: string }[] },
  options?: RequestOptions,
): Promise<AcceptanceGrade> {
  return companionPost<AcceptanceGrade>('/handoff/acceptance/grade', request, options)
}

// ---------------------------------------------------------------------------
// 模块 A 创新扩展：差分隐私统计导出（/export/dp*）
// ---------------------------------------------------------------------------

/** `GET /export/dp/state` 响应。 */
export interface DpBudgetState {
  readonly budgetEpsilon: number
  readonly spentEpsilon: number
  readonly remainingEpsilon: number
  readonly releaseCount: number
  readonly lastReleaseAt: number | null
  readonly releases: readonly { readonly id: string; readonly ts: number; readonly epsilon: number; readonly metrics: readonly string[] }[]
}

/** `POST /export/dp/release` 响应（成功分支）。 */
export interface DpReleaseSuccess {
  readonly refused: false
  readonly releaseId: string
  readonly epsilon: number
  readonly metrics: readonly {
    readonly key: string
    readonly released: number
    readonly scale: number
    readonly sensitivity: number
  }[]
  readonly spentEpsilon: number
  readonly budgetEpsilon: number
  readonly remainingEpsilon: number
  readonly note: string
}

/** `POST /export/dp/release` 响应（预算耗尽拒绝分支）。 */
export interface DpReleaseRefusal {
  readonly refused: true
  readonly reason: string
  readonly requestedEpsilon: number
  readonly spentEpsilon: number
  readonly budgetEpsilon: number
  readonly remainingEpsilon: number
}

/** DP 预算账本面板。 */
export function fetchDpBudgetState(options?: RequestOptions): Promise<DpBudgetState> {
  return companionGet<DpBudgetState>('/export/dp/state', undefined, options)
}

/** 差分隐私释放：Laplace 加噪 + ε 预算记账（耗尽即拒）。 */
export function releaseDpMetrics(
  request: {
    metrics: readonly { key: string; value: number; sensitivity?: number; kind?: 'count' | 'sum' }[]
    epsilon?: number
  },
  options?: RequestOptions,
): Promise<DpReleaseSuccess | DpReleaseRefusal> {
  return companionPost<DpReleaseSuccess | DpReleaseRefusal>('/export/dp/release', request, options)
}

/** 重置 DP 预算账本（可选同时调整总预算 ε）。 */
export function resetDpBudget(
  budgetEpsilon?: number,
  options?: RequestOptions,
): Promise<OkResponse & DpBudgetState> {
  return companionPost<OkResponse & DpBudgetState>(
    '/export/dp/reset',
    budgetEpsilon !== undefined ? { budgetEpsilon } : undefined,
    options,
  )
}

// ---------------------------------------------------------------------------
// 浏览器工具：base64 解码、下载、打印
// ---------------------------------------------------------------------------

/** 将 base64 字符串解码为 Blob（二进制安全，不经 atob→字符串 的 Latin-1 陷阱）。 */
export function base64ToBlob(b64: string, mime: string): Blob {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mime })
}

/** 通过 objectURL + `<a download>` 触发浏览器下载。 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 延迟释放，确保下载已启动
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 在新窗口写入完整 HTML 并触发浏览器打印（用于 PDF 含非 Latin-1 内容的降级路径）。 */
export function openPrintHtml(html: string): void {
  const win = window.open('', '_blank')
  if (!win) {
    throw new CompanionApiError(0, '浏览器拦截了弹出窗口，请允许弹窗后重试打印导出')
  }
  win.document.open()
  win.document.write(html)
  win.document.close()
  win.focus()
  // 留出少量渲染时间再唤起打印对话框；若窗口在此期间被关闭则跳过打印
  window.setTimeout(() => {
    if (!win.closed) win.print()
  }, 250)
}
