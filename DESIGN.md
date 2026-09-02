# DeepSeek Companion — 架构与契约（开发规范）

本文件是插件内部开发的唯一契约来源。所有模块必须遵守这里的约定；
与 DeepSeek Harness 官方文档的对齐点见 `src/types/*.d.ts` 头部注释。

## 1. 通用约定

- ESM（`"type": "module"`）；本地相对导入一律带 `.js` 后缀（NodeNext）。
- `strict: true`；不使用 `any`，确需宽松处用 `unknown` + 收窄。
- 每个文件、每个导出符号写简洁中文 JSDoc（说明契约，不复述代码）。
- 注册即 effect：所有命令/路由/提示词注册都返回 disposer，交给 Cordis 生命周期管理。
- 品牌 id 一律经 `src/core/ids.ts` 铸造（`SessionId(x)` 等），禁止裸 string 跨边界。
- 模块间不直接 import 彼此文件；跨模块协作只经过 `ctx.companion` / `ctx.companionCost` 服务。

## 2. 核心服务 API（已实现，勿改动签名）

### `ctx.companion`（CompanionCore，src/core/service.ts）

```ts
interface CompanionCore {
  readonly config: Config                    // 根配置（apiBaseUrl/apiTimeoutMs/模块开关）
  readonly http: CompanionRouter             // 私有 HTTP 路由（前缀 /companion）
  readonly ready: Promise<CompanionStore>    // { domain, vault, usage }
  getApiKey(): Promise<string | undefined>   // 保险库优先，其次 credentials seam
  setApiKey(value: string): Promise<void>
  clearApiKey(): Promise<void>
  callDeepSeek(params: CallParams): Promise<ChatResult>  // 直连 + 记账 + companion/usage 事件
  readonly prices: PriceService              // 动态计价引擎（官方定价页抓取/峰谷分时/多厂商目录）
  setPricingOverrides(table: PriceTable): void  // 用户自定义单价（模型 id → 单价，最长前缀匹配）
  notice(kind: 'info'|'success'|'warning'|'error', message: string): void
}
interface CallParams {
  messages: readonly ChatMessage[]; model?: string; temperature?: number
  maxTokens?: number; signal?: AbortSignal; source: string
}
```

### 核心工具（按需导入）

| 模块 | 导出 |
|---|---|
| `core/deepseek.js` | `chatCompletion`, `DeepSeekApiError`, `ChatMessage`, `ChatResult`, `TokenUsage` |
| `core/transcript.js` | `transcriptFromLog`, `formatTranscript`, `transcriptToMarkdown`, `transcriptToJson`, `extractContentText` |
| `core/privacy.js` | `redactText(text) → { text, stats }`, `hasRedactions` |
| `core/zip.js` | `buildZip(entries)`, `sanitizeFileName` |
| `core/pdf.js` | `isLatin1Safe`, `buildSimplePdf(title, lines)`, `buildPrintHtml(title, bodyHtml)`, `escapeHtml` |
| `core/time.js` | `isPeakTime`, `nextOffPeakStart`, `DEFAULT_PEAK_WINDOWS`, `beijingDayKey`, `beijingMonthKey`, `formatBeijingTime`, `PeakWindow` |
| `core/pricing.js` | `round4`, `tokenUsageToUsageLike`（官方 usage → 计价引擎用量形状） |
| `core/price/types.js` | `ModelPrice`, `PriceTable`, `ScheduledPricing`, `PriceSheet`, `UsageLike` |
| `core/price/catalog.js` | `CATALOG_TABLE`（多厂商刊例价快照）, `VENDORS`, `VENDOR_IDS`, `VendorId`, `vendorOf`, `vendorInfoOf`, `prefixesOf` |
| `core/price/scrapers.js` | `parseVendorSheet`, `parseErnieSheet`, `parseZhipuBundleSheet`, `parseDoubaoSheet`, `parseKimiSheet` |
| `core/price/service.js` | `PriceService`, `BUILTIN_SHEET`, `OFFICIAL_PRICING_URL`, `DEFAULT_PEAK_WINDOWS`, `resolvePrice`, `isPeakTimeAt`, `costOf`, `parsePriceSheet`, `sanitizePriceSheet`, `fetchText` |
| `core/usage.js` | `UsageStore`, `DailyUsage`（含 cacheHitTokens）, `UsageTotal` |
| `core/http.js` | `createRouter`, `sendJson`, `readJsonBody`, `HttpError`, `HttpHandler`, `toSafeHttpError`, `userFacingMessage`, `clampIntParam`, `clampNumberParam` |
| `core/text.js` | `charShingles`（字符 3-gram 集合）, `jaccardSets`, `jaccardText`（文本 Jaccard 便捷入口） |
| `core/stats.js` | `percentileOf`, `medianOf`, `meanOf`（描述统计唯一权威实现） |
| `core/vault.js` | `SecretVault` |
| `core/ids.js` | `SessionId`, `CredentialRef`, `ScopeKey`（类型 + 构造器） |

### Harness 服务（类型见 src/types/harness.d.ts）

`ctx.sessionQuery`（listSessions/readSession/searchSessions/filterSessions）、
`ctx.commands.register(CommandDefinition)`、`ctx.settings.register(ns, schema, opts)`、
`ctx.credentials`、`ctx.systemPrompt.section/context`、`ctx.webServer`、`ctx.userQuestions`。

## 3. 模块插件形态

每个模块是独立的 Cordis 函数插件（文件 `src/modules/<id>/index.ts`）：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'companion-<id>'
export const inject = ['companion', ...其他 harness 服务]

export function apply(ctx: Context): void {
  // 注册命令 / HTTP 端点 / 事件监听（全部经 effect，自动回卷）
}
```

模块只允许 inject：`companion` + 自己用到的 harness 服务。
`ctx.companion.ready` 是 Promise：在异步处理函数内 `const { vault, usage, domain } = await ctx.companion.ready`。

## 4. 私有 HTTP API（全部 JSON，前缀 /companion）

错误响应：非 2xx + `{ "error": string }`。字节内容一律 base64。

错误语义约定：参数/历法校验失败一律 `400`；系统性故障（存储域损坏等）`500`，不与"未找到"混用。

### 模块 A（export）
- `GET  /export/sessions` → `{ sessions: SessionRecord[] }`
- `POST /export/run` `{ sessionId, format: 'markdown'|'pdf'|'json'|'png'|'html', timestamps?=true, redact?=false }`
  → `{ kind: 'file', fileName, mimeType, contentBase64 }`
  或 `{ kind: 'raster', target: 'png'|'pdf', fileName, html }`（客户端 canvas 光栅化：
  PNG 长图，或含非 Latin-1 字符的 PDF——免打印多页 PDF，无 window.print() 对话框）
  或（无光栅能力时的降级路径）`{ kind: 'print', fileName, html }`。
  HTTP 端点一律以 `raster: true` 调用服务函数（浏览器具备 canvas）；
  `format: 'png'` 仅光栅路径可用，命令面板（无 canvas）→ `400` 可读文案。
  `format: 'html'` → 交互式自包含 HTML 档案（kind:'file'，见第 8 节"交互式 HTML 导出"）。
- `POST /export/batch` `{ sessionIds: string[], format, timestamps?, redact? }`
  → `{ kind: 'file', fileName, mimeType: 'application/zip', contentBase64 }`
  `sessionIds` 先去重，去重后超过 `MAX_BATCH_SESSIONS`（100）→ `400`；
  `format: 'png'` → `400`（光栅化需客户端逐张执行，不支持批量）；
  批量强制 `raster: false`：非 Latin-1 PDF 以 `.html` 入包；
  单会话读取失败跳过（404 文案含会话 id），系统性错误上抛 `500`。
- `POST /export/merkle/build` `{ sessionIds: string[], format: 'markdown'|'json'|'html', timestamps?=true, redact?=false }`
  → `{ kind: 'file', fileName, mimeType: 'application/zip', contentBase64, root, rootSha256, entryCount, entries, verifyHint }`
  Merkle 可验证批量导出（见第 8 节"Merkle 可验证导出"）：逐会话叶哈希
  （文件名+内容双重承诺）→ Merkle 根 → ZIP + 登记表成对交付；根哈希可发布到外部锚点；
  `format: 'pdf'|'png'` → `400`（Merkle 导出仅支持文本格式）；单会话读取失败跳过，
  全部失败 → `404`；重名文件自动去重（a.md → a-2.md）。
- `POST /export/merkle/proof` `{ root, fileName }` → `{ root, fileName, index, leafHash, proof, verifyHint }`
  生成批次内指定文件的包含证明（兄弟路径，交第三方独立复算）；
  `root` 未登记 → `404`；文件不在登记表 → `404`。
- `POST /export/merkle/verify` `{ root, fileName, contentBase64, proof? }`
  → `{ contentMatch, proofValid, registered, verified, root, fileName, leafHash, detail }`
  核验包含：登记匹配 / 内容哈希一致 / 证明复算三关全过才 `verified: true`；
  `detail` 给出不一致时的差异定位（中文）。
- `GET  /export/merkle/roots` → `{ bundles: [{ root, createdAt, format, entryCount }] }`
  已发布批次清单（根哈希登记簿，新→旧）。

### 模块 B（handoff）
- `POST /handoff/generate` `{ sessionId, template? }` → `{ summary, model }`
  `template` 可选：指定且存在时以该模板为摘要指令文本（支持 `{conversation_content}` 占位符，
  缺占位符则模板后追加"对话内容："段）；未指定/不存在回退固定契约 Prompt。
  转录按 `TRANSCRIPT_CHAR_BUDGET`（60000）截断（保首尾、中段附提示行）。
- `POST /handoff/structured` `{ sessionId, arm?: 'pending'|'none' }`
  → `{ handoff, autoRestoredCount, depthWarning, depthWarnThreshold, rendered, armed }`
  结构化分级交接（见第 8 节"结构化分级交接"）：四级信息分层（anchors/active/reference/archived）、
  锚定强制继承守门、世系链落库；`arm: 'pending'` 时把渲染文本经世代门闩武装给下一个新对话。
- `GET  /handoff/lineage` → `{ handoffs: [...] }`（世系链总览，按创建时间降序）。
- `GET  /handoff/lineage/trace?handoffId=` → `{ handoffId, depth, chain, truncated }`
  沿 parent 链向上溯源到根，含各代锚定约束与处置记录
  （回答"这条约束是第几代定的、中间废弃过什么"）；不存在 → `404`。
- `GET  /handoff/templates` → `{ templates: [{ name, content, updatedAt }] }`
- `POST /handoff/templates` `{ name, content }` → `{ ok: true }`
- `DELETE /handoff/templates` `{ name }` → `{ ok: true }`
- `POST /handoff/import` `{ summary, sessionId? }` → `{ ok: true, sessionId: string | null }`
  （无 sessionId = 武装给"下一个新对话"；pending 武装携带世代快照与 24h 有效期，见第 8 节）
- `GET  /handoff/armed` → `{ armed: [{ sessionId: string | null, summary, armedAt }], receipts: [{ sessionId, injectedAt }] }`
  `receipts` 为 pending 摘要的投递回执（按注入时间降序，滚动保留最近 20 条）。
- `DELETE /handoff/armed` `{ sessionId? }` → `{ ok: true }`
- `GET  /handoff/readiness?handoffId=` → `{ handoffId, depth, score, grade, blocking, dimensions, gaps, summary, renderedChars, charBudget }`
  交接就绪度门（见第 8 节"交接就绪度门"）：六维检查单评估（锚定覆盖/行动清晰/
  开放问题显式化/参考完备/体积预算/世系健康），`grade ∈ A/B/C/D`，
  `blocking: true`（存在 critical 缺口）不建议投递；缺省评估最近一次结构化交接，
  无可评估对象 → `404`。

### 模块 C（cost）
- `GET    /cost/state` → `{ devMode, apiKeyConfigured, peakScheduling, modelRouting, budget: { dailyCny, dailySpentCny, dailyRatio, monthlyCny, spentCny, ratio, paused, reservedCny }, rules, pricing }`
  `budget` 为日/月双档：`dailyCny`/`monthlyCny` 为 0 表示该档不限；`paused` 为任一档用尽。
  `reservedCny` 为在途预授权合计（调用期权协议，见第 8 节）。
- `POST   /cost/api-key` `{ apiKey }` → `{ ok: true }`；`DELETE /cost/api-key` → `{ ok: true }`
- `POST   /cost/settings`（稀疏补丁：devMode?/peakScheduling?/modelRouting?/adaptiveRouting?/dailyBudgetCny?/monthlyBudgetCny?/rules?/pricing?）→ `{ ok: true }`
  `rules` 校验：数量 ≤ `MAX_CUSTOM_RULES`（20）、pattern ≤ `MAX_RULE_PATTERN_LENGTH`（200）字符、
  pattern 必须可编译为正则，违反任一 → `400`。
  `pricing`（用户自定义单价覆盖，模型 id → ModelPrice）不属于设置 schema：
  持久化到 `cost-extra` 表并经 `ctx.companion.setPricingOverrides` 应用到计价引擎。
- `GET    /cost/report?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ days: DailyUsage[], total: UsageTotal }`
  `from`/`to` 历法非法（如 `2024-13-40`）→ `400`。
- `POST   /cost/test-call` → `{ ok: true, model, latencyMs }` | 错误
- `GET    /cost/pricing` → `{ source, sourceUrl?, fetchedAt?, lastChangedAt?, scheduled, overrides, vendors }`
  动态计价引擎面板数据：定价来源（live=官方页实时抓取 / builtin=内置快照）、
  峰谷分时计划、用户自定义单价覆盖、按厂商分组的全部已知定价。
- `POST   /cost/pricing/refresh` → 同 `GET /cost/pricing`（手动触发官方定价页刷新：
  DeepSeek + 全部国产厂商）。
- `GET    /cost/adaptive` → `{ enabled, arms }`
  自适应路由面板（见第 8 节"自适应路由"）：`enabled = modelRouting && adaptiveRouting`；
  `arms` 为 simple/complex 两类任务各自的赌臂统计（均值奖励/UCB/失败率/平均成本）；
  网关未就绪 → `503`。
- `POST   /cost/adaptive/reset?cls=simple|complex` → `{ ok: true }`
  清空学习状态（缺省全清，`cls` 非法 → `400`）。
- `POST   /cost/cache/lookup` `{ prompt, threshold?=0.85 }`
  → `{ hit, similarity, savedTokens, savedCny, entry: { entryId, prompt, response, model, hits, createdAt, lastHitAt } | null }`
  语义缓存查询（见第 8 节"语义缓存"）：MinHash-LSH 近重复匹配，命中直接复用历史响应；
  `threshold ∈ [0.5, 1]`（语义相似度阈值，越高越保守）。
- `POST   /cost/cache/store` `{ prompt, response, model?, inputTokens?, outputTokens?, costCny? }`
  → `{ entryId, replaced }`
  缓存回填：miss 后真实执行调用，把响应与用量写回缓存供后续近重复请求复用；
  归一化后完全相同的既有条目被替换（LRU/TTL 纪律见第 8 节）。
- `GET    /cost/cache/stats` → `{ entries, capacity, lookups, hits, hitRate, savedTokens, savedCny, ttlDays, recent }`
  缓存面板：容量/命中率/节省 token 与费用账本/最近条目（≤20 条，不含响应正文）。
- `DELETE /cost/cache` → `{ ok: true }`（清空条目与统计）。

### 模块 D（search）
- `GET  /search?query=&from=&to=&tags=a,b&limit=50` → `{ hits: [{ session, snippet?, tags }] }`
  `limit` 封顶 `MAX_SEARCH_LIMIT`（200）；`from`/`to` 历法非法 → `400`；
  有 `tags` 时向引擎取 `min(limit*10, 1000)` 候选再本地全命中过滤，避免引擎提前截断漏命中。
- `GET  /search/semantic?query=&limit=` → `{ hits: [{ session, score, sources? }] }`
  语义邻域检索（见第 8 节"语义邻域检索"）：字符 shingle 邻域 + PRF 查询扩展 +
  多源 RRF 融合，无向量库即可语义召回；`query` 必填（空 → `400`）。
- `GET  /search/similar?sessionId=&limit=` → `{ hits: [{ session, score }] }`
  相似会话（more-like-this）：以指定会话内容为查询找最像的历史会话；
  `sessionId` 必填；会话不存在 → `404`。
- `GET  /tags?sessionId=` → `{ tags: string[] }`（缺省返回 `{ tags: Record<string, string[]> }`）
- `POST /tags` `{ sessionId, add?, remove? }` → `{ tags: string[] }`
- `POST /search/rerank` `{ query, from?, to?, tags?, limit?, clickWeight?=0.6 }`
  → `{ query, learned, reordered, entries: [{ session, snippet?, tags, originalRank, newRank, clickScore, finalScore, reason }], clickWeight }`
  点击反馈学习重排序（见第 8 节"点击反馈学习重排序"）：检索 → 点击模型重排 →
  展示即记录曝光（下次学习的燃料）；`clickWeight ∈ [0,1]`，
  `limit ∈ [1, MAX_SEMANTIC_LIMIT]`，`query` 空 → `400`。
- `POST /search/click` `{ query, sessionId, position }` → `{ ok: true, clickSignal? }`
  记录一次结果点击（`position` 从 1 起，非正整数 → `400`）；
  `clickSignal` 为该（query, session）的即时相关度评分。
- `GET  /search/clicks/stats`
  → `{ eventCount, knownSessions, globalRate, distinctQueries, vocabularySize, topSessions }`
  点击模型面板：事件量/全局点击率/查询与词表规模/最强会话信号（降序前 10）。

### 模块 E（trace）
- `GET  /trace/sessions` → `{ sessions: SessionRecord[] }`
- `GET  /trace/derive?sessionId=` → `{ trace, anomalies, stats, slowest?, costliest? }`
  从会话日志派生轨迹：工具节点配对（已闭合节点不重复回填）、重试合并、
  异常标注（retry-loop / token-explosion / cache-miss / infinite-loop）。
- `POST /trace/ingest` `{ id?, trace }` → 同上（摄入 Harness 原生轨迹 JSON）。
- `GET  /trace/get?id=` → 同上（读取已摄入轨迹）。
- `POST /trace/diff` `{ old: { id?|sessionId? }, new: { id?|sessionId? }, format?='json'|'html' }`
  → `{ format: 'json', entries }` 或 `{ format: 'html', fileName, html }`（自包含对比报告）。
- `GET  /trace/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ days: TraceDailyStats[], baseline? }`
  日聚合趋势 + 历史基准线（偏离过大由客户端告警）。
- `GET  /trace/spc?from=&to=&metric=duration-per-trace&lambda=0.3&limitWidth=3`
  → `{ metric, label, lambda, limitWidth, center, sigma, sampleDays, points, drift, verdict, driftRatePerDay }`
  SPC 统计过程控制（见第 8 节"SPC 控制图"）：EWMA 控制图 + Western Electric 规则漂移检测；
  Phase I 参数估计用全量历史（更稳健），图表只展示查询区间；
  `verdict ∈ stable / warning / out-of-control`；
  `metric ∈ duration-per-trace / tokens-per-trace / anomaly-rate / cache-hit-rate / tool-success-rate`，
  `lambda ∈ [0.05, 0.95]`，`limitWidth ∈ [1, 5]`，违反 → `400`。
- `GET  /trace/localize`
  → `{ traces: { ok, failed }, failureRate, components: [{ component, kind, name, failedCount, passedCount, suspiciousness, avgDurationInFailedMs, avgDurationInPassedMs, retryRateInFailed, advice }], verdict?, note }`
  频谱根因定位（见第 8 节"频谱根因定位"）：SBFL Ochiai 可疑度 + 失败/成功差分画像；
  数据源为已保存轨迹 + 全部会话派生轨迹；组件可疑度排行降序 ≤20 条，
  证据不足时 `verdict: null`（`note` 给出原因）。

### 模块 F（prompt）
- `GET    /prompt/versions` → `{ versions: PromptVersion[] }`
- `POST   /prompt/versions` `{ content, note?, tags? }` → `{ version }`（自动递增版本号）
- `POST   /prompt/rollback` `{ version, note? }` → `{ version }`（回滚生成新版本）
- `POST   /prompt/tags` `{ version, add?, remove? }` → `{ version }`
- `POST   /prompt/ab-test` `{ promptA, promptB, cases?, model? }` → `{ model, a, b, ratings }`
  批量用例逐条跑两侧，汇总成功率/平均输出长度/平均延迟/总 Token。
- `POST   /prompt/rate` `{ winner: 'A'|'B'|'tie', promptA?, promptB? }` → `{ ok: true, ratings }`
- `GET    /prompt/ratings` → `{ ratings }`（A/B 评级汇总）
- `GET    /prompt/templates` → `{ templates: PromptTemplate[] }`（内置 + 用户，同名用户覆盖内置）
- `POST   /prompt/templates` `{ name, category?, content }` → `{ ok: true }`
- `DELETE /prompt/templates` `{ name }` → `{ ok: true }`
- `POST   /prompt/render` `{ template, variables? }` → `{ rendered }`（`{{var}}` 插值）
- `POST   /prompt/codegen` `{ prompt, language: 'python'|'nodejs'|'curl', model? }` → `{ code }`
- `POST   /prompt/validate` `{ prompt, schema, cases?, model? }`
  → `{ model, total, compliant, complianceRate, runs }`（JSON Schema 批量校验，逐条标注违规字段）。
- `POST   /prompt/optimize` `{ prompt, cases, model?, candidates?=2, save?=true }`
  → `{ model, baseline: { passRate, passes, failures }, candidates, winnerIndex?, significance?, savedVersion? }`
  自动 Prompt 优化（见第 8 节"Prompt 自动优化"）：元提示生成候选变体 → 批量评测 →
  配对符号检验（McNemar 精确法）判定显著性，仅显著胜者晋升版本库；
  `cases` ≥ 2（配对检验需要样本量），`candidates ∈ [1, MAX_CANDIDATES（3）]`，违反 → `400`。
- `POST   /prompt/bandit` `{ name?, variants: string[], cases: BanditCase[], model? }`
  → `{ experiment, analysis }`
  Thompson Sampling 变体寻优（见第 8 节"Thompson Sampling 变体寻优"）：
  创建多臂实验；`variants` 2~`MAX_BANDIT_ARMS`（8）个且互不相同，
  `cases` 1~`MAX_BANDIT_CASES`（10）条（`{ input, expected? }`），违反 → `400`。
- `GET    /prompt/bandit` → `{ experiments: [{ id, name, model, armCount, caseCount, totalPulls, updatedAt }] }`
- `GET    /prompt/bandit/get?id=` → `{ experiment, analysis }`
  后验分析：各臂 P(best)/期望损失/95% CI/经验通过率 + 停止裁决；
  实验 id 不存在 → `404`。
- `POST   /prompt/bandit/pull` `{ id, rounds?=5 }` → `{ experiment, rounds, analysis }`
  执行 N 轮 Thompson 采样（后验选臂 → 轮转用例 → Beta 更新 → 遗憾记账），
  `rounds ≤ MAX_PULL_ROUNDS`（20）；实验不存在 → `404`。
- `DELETE /prompt/bandit` `{ id }` → `{ ok: true }`（删除实验）。

### 模块 G（arena）
- `GET    /arena/models` → `{ models: ArenaModelInfo[] }`（含外部厂商 Key 配置状态，不回明文）
- `POST   /arena/keys` `{ modelId, apiKey, baseUrl? }` → `{ ok: true }`（AES-256-GCM 加密落盘）
- `DELETE /arena/keys` `{ modelId }` → `{ ok: true }`
- `POST   /arena/compare` `{ prompt, models }` → `{ prompt, results }`
  最多 `MAX_COMPARE_MODELS`（5）个模型并行；DeepSeek 走核心服务记账，外部走 OpenAI 兼容协议直连。
- `POST   /arena/leaderboard` `{ models, cases, format?='json'|'markdown'|'html' }`
  → `{ format: 'json', rows }` 或 `{ format, fileName, content }`；
  用例封顶 `MAX_LEADERBOARD_CASES`（30）；综合得分 = 成功率/延迟分位/Token/成本/合规率加权。
- `GET    /arena/recommend?taskType=&budgetPerCallCny=&latency=`
  → `{ taskType, taskTypeLabel, recommendations }`（峰谷定价感知，附推荐理由与单次成本估算）。
- `POST   /arena/canary/run` `{ models: string[] }` → `{ reports: DriftReport[] }`
  模型漂移监控（见第 8 节"金丝雀漂移监控"）：对指定模型运行确定性探针组并比对基线；
  首次运行建立基线，后续运行累积历史并输出漂移判定；
  单次最多 `MAX_COMPARE_MODELS`（5）个模型。
- `GET    /arena/canary/report?model=` → 单模型：`{ model, baselineTs, historyRuns, probes, report }`
  缺省：`{ models: [{ model, baselineTs, historyRuns, verdict }] }`（全部受监控模型概览，
  不发起任何调用）；无记录 → `404`。
- `POST   /arena/canary/reset` `{ model }` → `{ ok: true, hint }`
  重置基线（确认厂商更新后重新锚定）；无记录 → `404`。
- `GET    /arena/frontier`
  → `{ generatedAt, modelCount, frontier, models, valueChampion, budgetChampion, advice, unpriced?, unpricedNote? }`
  能力-成本-延迟帕累托前沿（见第 8 节"帕累托前沿分析"）：Elo 评级 × 计价引擎典型成本 ×
  金丝雀实测延迟（无实测按档位先验并标注 `latencyEstimated`）三维支配分析；
  仅统计有 Elo 场次的模型；无价目模型剔除并在 `unpriced` 披露。

### 模块 H（orchestrator）
- `GET/POST /orchestrator/pipelines`、`DELETE /orchestrator/pipelines` `{ id }`
  步骤数封顶 `MAX_PIPELINE_STEPS`（20）；`POST` 携带 `id` 为更新。
- `GET  /orchestrator/pipelines/yaml?id=` → `{ id, yaml }`（自动生成 YAML 配置）。
- `POST /orchestrator/runs` `{ pipelineId }` → `202 { runId, status }`
  后台异步执行，立即返回；进度经 `GET /orchestrator/runs/get` 轮询。
- `POST /orchestrator/runs/resume` `{ runId }` → 断点续跑（仅 paused/failed/cancelled 可恢复，
  已完成步骤的中间结果直接复用不重跑）。
- `POST /orchestrator/runs/pause` / `/cancel` `{ runId }` → `{ ok: true }`
- `GET  /orchestrator/runs?pipelineId=` → `{ runs: [{ id, pipelineId, status, startedAt, endedAt, message, progress: { done, total } }] }`
- `GET  /orchestrator/runs/get?id=` → `{ run }`（含各步骤中间结果）；`DELETE /orchestrator/runs` `{ id }`
- `GET  /orchestrator/queue` → `{ tasks, counts }`；`GET /orchestrator/queue/counts` → `{ counts }`
- `POST /orchestrator/queue` `{ name, prompt, model?, priority?, deadline?, failurePolicy? }` → `{ task }`
  未完成任务封顶 `MAX_QUEUE_TASKS`（50）。
- `POST /orchestrator/queue/cancel|pause|resume` `{ id }`；
  `POST /orchestrator/queue/batch` `{ action: 'pause'|'resume'|'cancel' }` → `{ ok: true, changed }`；
  `DELETE /orchestrator/queue` `{ id }`（运行中任务需先取消）。
- `GET/POST /orchestrator/jobs`、`DELETE /orchestrator/jobs` `{ id }`
  定时任务封顶 `MAX_JOBS`（20）；`schedule` 接受标准 5 字段 Cron 或中文自然语言
  （「每天凌晨 2 点」「每隔 30 分钟」等），保存时统一转为 Cron；`offPeakOnly: true` 仅空闲时段执行。
- `POST /orchestrator/jobs/toggle` `{ id, enabled }` → `{ job }`
- `GET  /orchestrator/jobs/runs?jobId=` → `{ runs: ScheduledRun[] }`（历史归档）
- `POST /orchestrator/parse-schedule` `{ text }` → `{ cron, nextRunAt }`（解析预检）。
- `GET  /orchestrator/circuits` → `{ circuits, legend }`
  模型断路器全景（见第 8 节"自愈执行"）：closed=正常放行 / open=连续失败熔断中
  （冷却 60s，期间流水线/队列/定时任务自动避让该模型）/ half-open=冷却结束放行探针验证恢复。
- `POST /orchestrator/monte` `{ pipelineId, iterations?=2000, parallelism? }`
  → `{ pipelineId, pipelineName, valid, errors, iterations, parallelism, steps, total, bottleneckStepId, bottleneckCriticality, advice }`
  蒙特卡洛工期模拟（见第 8 节"蒙特卡洛工期模拟"）：从历史运行提取每步 a/m/b
  三点估算，PERT 抽样输出总工期分位数（P50/P80/P90/P95/P99）与各步关键性指数；
  `iterations ∈ [200, 20000]`（越界钳制）；流水线不存在 → `404`；
  依赖图非法时 `valid: false` + `errors`（`total: null`）。

### 模块 I（team）
- `GET    /team/prefs` → `{ prefs: TeamPreferences }`
- `POST   /team/prefs`（稀疏补丁：memberName?/defaultStrategy?）→ `{ prefs }`
- `GET    /team/config/export` → `{ snapshot: TeamConfigSnapshot }`
  快照分区：pricingOverrides / handoffTemplates / promptTemplates / pipelines /
  scheduledJobs / dlpRules（costSettings 仅导入侧识别，导出不携带）。
- `POST   /team/config/diff` `{ snapshot }` → `{ diffs: ConfigDiffEntry[] }`
  以条目身份键（模板名 / 流水线 id / 模型 id）比较两侧，内容用 JSON 序列化比较；
  快照未携带的分区按空远程列表处理（本地条目记为 local-only）。
- `POST   /team/config/import` `{ snapshot, strategy: 'local'|'remote'|'manual' }` → `{ reports: SectionReport[] }`
  local=仅写入 add；remote=写入 add + update；manual=只计数不写入；
  costSettings 分区一律跳过（需经成本模块界面配置）；pricingOverrides 导入后落
  `cost-extra` 表并经 `ctx.companion.setPricingOverrides` 同步动态计价引擎；
  非 manual 策略归档本次导入快照（滚动保留 `SNAPSHOT_ARCHIVE_LIMIT`（10）条）。
- `GET    /team/snapshots` → `{ snapshots: TeamConfigSnapshot[] }`（新→旧）
- `DELETE /team/snapshots` `{ key }` → `{ ok: true }`（key 为归档键或导出时间戳）。
- `GET    /team/experience?query=&tags=a,b&model=&limit=` → `{ cards: ExperienceCard[] }`
  关键词（标题/摘要/笔记/错误全文）/标签（任一命中）/模型（精确）三条件 AND；
  `limit` 封顶 `EXPERIENCE_CARD_LIMIT`（500）。
- `POST   /team/experience` `{ title, model?, tags?, promptSummary?, source?='manual', sourceId?, runId?, durationMs?, tokens?, ok?, error? }` → `{ card }`
- `POST   /team/experience/notes` `{ id, problem, solution }` → `{ card }`（追加笔记）
- `DELETE /team/experience` `{ id }` → `{ ok: true }`
- `POST   /team/experience/recommend` `{ text, limit?=5 }` → `{ results: [{ card, score }] }`
  分词（ASCII 词 + CJK 二元组）交集得分，得分 > 0 按得分降序。
- `POST   /team/experience/distill` `{ sessionId }` → `{ sessionId, outcome }`
  经验自动蒸馏单会话（见第 8 节"经验自动蒸馏"）：信号挖矿 → 元提示蒸馏 → 语义去重落库；
  `outcome` 含挖到的信号数、蒸馏卡、去重合并结果与证据链。
- `POST   /team/experience/distill/scan` `{ limit?=30, maxDistill?=5, minSignal? }`
  → `{ scanned, candidates, distilled, errors }`
  批量挖矿：本地信号打分筛出高信号会话（模型调用只花在刀刃上），
  已蒸馏会话自动跳过；高信号候选按得分降序顺序蒸馏（防限流），单会话失败跳过。
- `GET    /team/experience/distilled` → `{ cards: [...] }`
  蒸馏卡列表（按置信度降序：复发次数 + 信号强度加权）。
- `POST   /team/experience/distilled/promote` `{ id }`
  → `{ card, distilledCard }`（晋升为正式经验卡——人工把关闭环；已晋升 → `400`）
- `DELETE /team/experience/distilled` `{ id }` → `{ ok: true }`
- `GET    /team/reviews` → `{ reviews: ReviewRequest[] }`
- `POST   /team/reviews` `{ title, baseContent?, proposedContent, note? }` → `{ review }`
  作者取团队偏好 memberName（未配置回退「匿名成员」）。
- `GET    /team/reviews/get?id=` → `{ review, comments, decisions }`
- `POST   /team/reviews/comment` `{ reviewId, content, anchor? }` → `{ comment }`
  anchor 缺省为提议侧整体评论（`{ side: 'proposed', line: 0 }`）。
- `POST   /team/reviews/decide` `{ reviewId, verdict: 'approve'|'reject', comment? }` → `{ decision }`
  同步更新评审状态为 approved/rejected。
- `POST   /team/reviews/merge` `{ reviewId }` → `{ ok: true, mergedVersion }`
  仅 approved 可合并；提议内容写入 `prompt-versions` 表成为新主版本。
- `DELETE /team/reviews` `{ id }` → `{ ok: true }`（级联删除评论与审核决定）。
- `POST   /team/experts` `{ name, domains: string[], bio? }` → `{ expert }`
  注册/更新专家（同名视为同一专家）；`domains` 至少 1 个领域关键词，违反 → `400`。
- `GET    /team/experts` → `{ experts: [{ id, name, domains, bio, createdAt, updatedAt }] }`（按姓名排序）
- `DELETE /team/experts` `{ id }` → `{ ok: true }`
- `GET    /team/experts/profiles`
  → `{ profiles: [{ id, name, domains, bio, corpusSize, sources: { domain, reviews, comments }, topTerms }] }`
  知识足迹画像面板（见第 8 节"专家路由"）：自报领域 × 评审产出 × 评审评论三源
  TF-IDF 加权聚合的顶部术语。
- `POST   /team/experts/route` `{ question }` → RoutingReport
  专家路由（见第 8 节"专家路由"）：问题 → TF-IDF 向量 → 与各专家足迹余弦匹配，
  输出排序候选（`similarity`/`coverage`/`matchedTerms`）、推荐专家
  （`recommended`）、三档裁决（`verdict ∈ confident / tentative / gap`）与
  知识盲区术语（`uncoveredTerms`）；`question` 空 → `400`。

### 模块 J（security）
- `GET    /security/keys` → `{ keys: [{ name, note, createdAt, lastUsedAt, scope, configured, rotationDue }], rotationDays, activeConfigured }`
  安全红线：不回传 Key 明文。
- `POST   /security/keys` `{ name, apiKey, note?, scope? }` → `{ key }`（加密落盘，同名覆盖）
- `POST   /security/keys/activate` `{ name }` → `{ ok: true }`（切换激活 Key）
- `DELETE /security/keys` `{ name }` → `{ ok: true }`
- `POST   /security/keys/leak-check` `{ content }` → `{ leaked, safe }`（泄露检测）
- `GET    /security/keys/rotation` → `{ due: [{ name, ageDays }], thresholdDays }`（30 天轮换提醒）
- `GET    /security/audit?from=&to=&model=&status=&limit=` → `{ entries: AuditEntry[] }`
  Prompt 摘要（前 100 字）落盘前已经 DLP 规则脱敏。
- `GET    /security/audit/export?format=csv|json&from=&to=` → `{ format, fileName, content }`
- `GET    /security/dlp/state` → `{ settings, rules }`
- `POST   /security/dlp/settings` `{ enabled?, strict? }` → `{ settings }`
  严格模式下 beforeCall 钩子检测到敏感内容直接抛 403 拦截调用。
- `POST   /security/dlp/rules` `{ name, pattern, enabled? }` → `{ rules }`
  自定义规则封顶 `MAX_CUSTOM_RULES`（20）；内置规则不可修改/删除，仅可切换启用。
- `POST   /security/dlp/rules/toggle` `{ id, enabled }`；`DELETE /security/dlp/rules` `{ id }`
- `POST   /security/dlp/scan` `{ text }` → `{ findings, clean, settings }`（发送前预检）
- `GET    /security/injection/state`
  → `{ settings, detectors }`（六类检测器：instruction-override / role-jailbreak /
  system-exfil / tool-hijack / delimiter-confusion / encoding-evasion）
- `POST   /security/injection/settings` `{ enabled?, strict? }` → `{ settings }`
  严格模式下 beforeCall 钩子检测到 malicious 判定直接抛 403 拦截调用（见第 8 节）。
- `POST   /security/injection/scan` `{ text }`
  → `{ findings: [{ id, category, severity, sample, count }], risk, verdict, settings }`
  提示注入检测（见第 8 节"提示注入检测"）：`risk` 为 0~100 风险评分，
  `verdict` 三档判定 clean / suspicious / malicious；命中片段已掩码。
- `POST /security/taint/scan` `{ sessionId }`
  → `{ sessionId, scannedAt, sources, flows, stats: { sourceCount, taintedEventCount, outboundFlows, storageFlows, modelFlows }, riskLevel }`
  敏感数据污点追踪（见第 8 节"敏感数据污点追踪"）：DLP 规则识别敏感源 →
  追踪会话事件传播链 → 汇点信道分级（outbound/storage/model/internal）；
  每源一条污点流（含完整 hops 链与 `severity`），`riskLevel ∈ high/medium/low/none`；
  报告全程只含掩码值（安全红线：原始敏感值不外发）；会话不存在 → `404`。
- `GET    /security/report?from=YYYY-MM-DD&to=YYYY-MM-DD`
  → `{ from, to, totalCalls, totalCostCny, totalTokens, modelShare, blocks, blockTotal, alerts }`
- `GET    /security/report/export?from=&to=` → `{ format: 'html', fileName, content }`
  自包含 HTML，客户端经打印管线另存 PDF 提交审计。

集成点：`ctx.companion.addCallHook({ beforeCall, afterCall })`（core/service.ts）——
beforeCall 抛错即拦截调用（DLP 严格模式）；afterCall best-effort 记录审计与异常告警
（单次 Token > 100k、60 秒内调用 > 30 次）。

## 5. 命令面板（ctx.commands）

| 命令 | 模块 | 说明 |
|---|---|---|
| `companion-export` | A | 导出当前/指定会话（input: 会话 id 与格式） |
| `companion-export-batch` | A | 批量导出为 ZIP |
| `handoff` | B | 生成交接摘要 |
| `handoff-structured` | B | 生成结构化分级交接（锚定约束强制继承 + 世系链）并武装给下一个新对话 |
| `handoff-import` | B | 导入摘要武装到新对话 |
| `usage` | C | 输出本月用量文本报告 |
| `search` | D | 检索历史对话 |
| `tag` | D | 为会话增删标签 |
| `trace` | E | 分析会话执行轨迹（耗时/Token/异常） |
| `prompt` | F | 查看 Prompt 版本历史 |
| `tasks` | H | 查看任务队列与定时任务概览 |

命令 handler 与 HTTP 端点复用同一套模块内服务函数，不重复实现逻辑。

## 6. 客户端（src/client/）

- 入口 `src/client/index.tsx`：`export const name` + `export function apply(ctx: ClientContext)`。
- UI 只经 slots 组合（官方纪律），所有注册组件经 `SlotErrorBoundary` 包裹（渲染错误降级为提示文案，不波及宿主）：
  - `'conversation.session.header.actions'`：导出按钮、交接摘要按钮、对话内搜索按钮；
  - `'conversation.input.dock'`：导入历史摘要入口；
  - `'conversation.view'`：全局检索视图页、成本报表视图页、轨迹分析视图页、
    Prompt 工作台视图页、多模型竞技场视图页、任务编排视图页、安全与审计视图页、
    协作与知识管理视图页。
- 组件从 `@deepseek-ai/dsh-client-ui-primitives` 取（Button/Input/Select/Checkbox/Modal/Textarea/Spinner/Toast/Pill）。
- 样式：CSS Modules（`*.module.css`），颜色只用 `--dsw-alias-*` 语义令牌；不写全局样式。
  例外：`convsearch/styles.ts` 以稳定 id 注入一段全局样式（浮动搜索栏 + `::highlight()` 绘制规则，
  纯 DOM 组件无法走 CSS Modules）；`raster.ts` 不注入任何样式。
- 数据：同源 `fetch('/companion/...')`（见第 4 节），封装支持 `{ signal?, timeoutMs? }`（默认 30s 超时，
  网络失败归一化为友好错误）；下载 = base64 → Blob → objectURL → `<a download>`；
  `kind: 'print'` 响应 = 新窗口写入 html 并触发打印（仅降级路径）；
  `kind: 'raster'` 响应 = 交 `raster.ts` 客户端光栅化（`target: 'png'` → PNG 长图，
  `target: 'pdf'` → 免打印多页 PDF），全程无 window.print() 对话框。
- `raster.ts`（移植自 dsh-conv-export，流式重构）：打印 HTML → 离屏舞台（剥离 script，存活期内
  为克隆源）→ 分片光栅（foreignObject 窗口 translateY 位移，片高 = A4 页高 × 2）→ 2x canvas；
  图片先内联为 data: URL。PNG 走流式编码器（片级自适应行过滤 + CompressionStream('deflate')
  增量压缩 + Blob 直下）；PDF 按页切片、JPEG 编码、零依赖组装，页界与片界对齐。
  导出带分片进度回调与取消信号；无 CompressionStream 环境退回单 canvas 截断路径（16000px）。
  仅依赖浏览器内置能力，可单测。
- `convsearch/`（移植自 dsh-conv-search）：纯 DOM 浮动查找栏，不与宿主 React 版本耦合；
  控制器随 `ctx.effect` install/uninstall（卸载清除全部高亮与按键捕获）；
  高亮经 CSS Custom Highlight API 覆盖层绘制（不触碰 React 转录 DOM）；
  MutationObserver 监视对话滚动视口，流式输出/加载更早消息时按命中锚点（文本节点 + 偏移）重同步。
  作用域纪律：只扫 `[data-conversation-scroll]`，排除 `[data-composer-seat]` 与搜索栏自身。
- 所有异步操作必须有加载态（Spinner/按钮 disabled）与成功/失败 Toast；effect 内异步需 cancelled/abort 守卫；
  轮询用"完成后再排下一次"的链式 setTimeout。
- 跨组件同步：武装摘要变更后派发 `window` 自定义事件 `companion:armed-changed`，dock 监听刷新。

## 7. 安全红线

- 网络请求只允许 `config.apiBaseUrl`（默认 https://api.deepseek.com）。
- API Key 只经 `ctx.companion.setApiKey`（AES-256-GCM 落盘）或 credentials seam；
  任何响应、日志、事件中不得出现 Key 明文（`/cost/state` 只回 `apiKeyConfigured` 布尔）。
- 不引入任何追踪/遥测代码；所有数据仅写入 companion 存储域。

## 8. 行为契约与已知局限

成本模块（模块 C）行为契约：

- **动态计价引擎**：启动时先从 `cost-extra` 表恢复上次持久化的官方价格快照与用户覆盖，
  随后立即刷新官方定价页（DeepSeek + 全部国产厂商）；抓取失败静默降级——保留上一份有效表
  （实时计价不中断，只丢失重启后"沿用上次官方价"的能力）；官方价格内容变化时持久化新快照。
  单价解析优先级：用户覆盖（最长前缀匹配）→ DeepSeek 实时/分时表 → 厂商实时表 → 内置刊例价目录。
  费用一律按调用时刻解析（峰谷分时感知）；缓存命中的输入按 `inputCacheHit` 折扣价计。
- **日/月双档预算闸门**：调用前检查先日后月，任一档用尽即拦截非必要调用
  （`INSUFFICIENT_BALANCE`）；必要调用放行但持续告警。80% 告警不拦截，100% 告警并暂停。
  告警按「档位 + 周期键」进程内去重（`companion/budget-alert` 事件携带 `tier`/`period`），
  跨日/跨月自动重新告警；已花费短 TTL 内存缓存，跨日/跨月失效。
- **调用期权协议（预授权-结算两阶段提交）**：网关 invoke 时按估算金额 reserve 锁定额度，
  调用成功 settle(actual) 入账并释放差额、失败 release 全额释放。可用额度恒为
  `budget − spent − Σ在途预留`，不变式收紧为「最终支出 ≤ 预算 + Σ在途(实际−估算)⁺」。
  估算经 P95 估值器（模型 × 输入长度分桶滚动样本，冷启动用上界）；预留 TTL = apiTimeoutMs +
  30s，惰性清扫回收孤儿预留（无空闲定时器）；settle 同步推进 spent 缓存，15s TTL 缓存由此
  退化为全量扫描兜底。预授权投影口径（spent + 在途 + 估算）触发告警时文案标注「含在途调用预授权」。
  旧 TOCTOU 局限（并发集体过闸，超支 ≈ 并发数 × 单次全额）收敛为估算误差量级。
- **预算闸门覆盖延迟队列**：drain 执行每个排队任务前复检预算；暂停期间排队任务以
  `INSUFFICIENT_BALANCE` 被逐个 reject，延迟队列不是闸门旁路。预授权在任务真正执行
  （invoke）时锁定：排队期间不占额度，执行时的额度竞争由预留协议收敛。
- **调度器**：定时器按需一次性精确唤醒（队列空时无定时器）；队列容量上限 100，
  满时拒绝入队；执行前检查调用方 `signal`，已中止直接 reject 不发真实请求。
  高峰窗口优先取计价引擎对官方定价页的实时解析（`peakWindows`），空表/异常回退内置缺省窗口，
  调度永远有确定的窗口可用。
- **节省额口径**：`savedCny` 仅当 modelRouting 开启且实际路由到更便宜模型时计入；
  `deferredCalls` 仅当调度器真实延迟时计入（网关不预判）。
- **告警与记账健壮性**：告警写盘失败不阻塞调用、不永久吞告警；API 调用成功后的记账失败降级为
  warning notice，不反转成功结果。
- **自适应路由（滑动窗口 UCB1 赌博机）**：`modelRouting` 与 `adaptiveRouting` 同时开启时，
  网关把"选哪个模型"建模为多臂赌博机——每个候选模型是一个臂，奖励 =
  成功率（0.55）+ 相对成本优势（0.3）+ 时延得分（0.15）。选择策略 = 窗口均值 +
  UCB1 探索项（置信上界），在利用已知最优与探索可能更优之间无 regrets 平衡；
  冷启动期每臂至少 `MIN_PULLS`（2）次探索性尝试。观测按环形窗口（最近 `WINDOW`（50）次）
  滚动，价格调整/模型版本更新等非平稳漂移被自然遗忘，无需人工重置。按任务难度
  （simple/complex，与关键词启发式同源）维护两套独立赌臂状态，互不污染；
  自定义规则命中（source='custom-rule'）不进学习。状态持久化 `cost-bandit` 表，
  观测写入 best-effort。`adaptiveRouting` 关闭或重启后无状态时回退静态路由，
  行为与旧版完全一致。
- **语义缓存（MinHash-LSH 近重复复用 + 节省账本）**：同一问题的近重复变体
  （改几个字、换种问法）反复触发真实计费调用。入库：文本归一化 → 字符 shingle →
  `SIGNATURE_SIZE`（64）维 MinHash 签名 → LSH 分桶（`LSH_BANDS`（16）× `LSH_ROWS`（4））
  建立近邻索引，查询 O(1) 召回候选而非两两比对；命中判定 = 估计 Jaccard ≥
  `threshold`（缺省 `DEFAULT_SIMILARITY_THRESHOLD`（0.85），可调 [0.5, 1]）。
  命中直接复用历史响应并按该条目入库时的 token 与费用计入节省账本；miss 由
  调用方真实执行后回填（归一化后完全相同的回填替换既有条目）。缓存纪律：
  容量 `CACHE_CAPACITY`（500）LRU（按最近命中时间逐出）+ TTL `CACHE_TTL_DAYS`（7）。
  已知局限：MinHash 是近似——阈值附近的请求存在误判边界；识别的是"近重复文本"，
  语义等价的大幅改写召回弱于嵌入模型；缓存复用不适合对时效敏感的请求。
- **Shapley 成本公平分账（合作博弈论边际贡献 + 精确/蒙特卡洛双引擎）**：多部门共用
  一个企业账户吃阶梯折扣后，"结余按用量比例分"会系统性亏待把联盟抬进折扣档的小部门。
  `POST /cost/attribution {players, tiers}` 把分账建模为合作博弈：联盟特征函数
  v(S) = S 的合计用量按厂商阶梯折扣表算出的结余，某玩家的公平份额 = 其在全部
  加入次序下的平均边际贡献（Shapley 值——2012 年诺贝尔经济学奖工作，满足效率、
  对称性、哑玩家、可加性四大公理）。计算引擎：≤ `EXACT_MAX_PLAYERS`（8）玩家
  全排列精确枚举（8! = 40320），更多玩家用 `MCMC_PERMUTATIONS`（4000）次种子化
  蒙特卡洛抽样（可复现）；玩家数上限 24。输出每人 `shapleySavingsCny`、
  `shareOfSavings`、`vsProportionalCny`（与按比例分的差额——分账争议的直接证据）、
  联盟级 `synergyGainCny`（v(N) − Σ 单干结余：只有联合才拿得到的增益）与
  `residualCny`（Σ 分账 − v(N) 浮点残差，应 < 1e-6，账目自校验）。
  局限：折扣表为外部输入的真实性不由本引擎背书；纯加法折扣模型，不含满减/返点。

交接模块（模块 B）行为契约：

- **世代门闩（generation latch）**：pending 武装（武装给"下一个新对话"）在 arm 时刻快照
  全部已知会话 ID（`knownSessions`）并携带 24h 有效期（`expiresAt`）。系统提示词装配回调
  只向「快照之外」且带具体会话作用域的装配投递摘要——旧会话无论怎么重建都在快照内，
  天然免疫误投递；无作用域的全局装配不消费摘要。超时未投递自动作废（防僵尸注入）。
  投递成功写入回执（`handoff-receipts` 表，按会话覆盖、滚动保留 20 条），
  `GET /handoff/armed` 附带回执供 dock 展示「已注入会话 X」。
  旧格式记录（无快照字段）回退 v0.1 近似：注入下一次系统提示词装配；
  快照失败（会话引擎异常）同样退化为无快照武装，不阻塞武装操作。
- **结构化分级交接（四级分层 + 锚定强制继承 + 世系链）**：交接文档结构化为四个信息层级——
  anchors（锚定：不可丢失的硬约束/已定决策/关键前提，注入时配"不得违反"强指令）、
  active（进行中工作/下一步/开放问题）、reference（关键路径/命令/ID/链接）、
  archived（已完成事项单行清单，渲染上限 `ARCHIVED_RENDER_CHAR_CAP`（600）字符防膨胀）。
  生成第 N+1 代交接时，第 N 代全部锚定项作为输入交给模型逐条显式处置
  （inherited / evolved / dropped——dropped 必须附理由）；生成后程序化守门校验：
  凡模型未处置、或声称继承却在新文档中找不到对应项的锚定，一律自动补回（autoRestored）——
  锚定约束的静默丢失在结构上不可能。每次结构化交接分配全局唯一 handoffId 并记录
  parentHandoffId，形成可溯源传承链；深度超过 `LINEAGE_DEPTH_WARN_THRESHOLD`（3）时
  注入文本携带"上下文已传承 N 代，建议回读源头会话"告警。世系表滚动保留
  `LINEAGE_KEEP_LIMIT`（200）条。`/handoff/structured` 的 `arm: 'pending'` 复用世代门闩。
- **交接就绪度门（六维检查单 + 缺口检测）**：交接质量此前只能靠接手人"读了才知道"。
  就绪度门把"能不能放心投递"结构化为六维加权评估——锚定覆盖（25：有无硬约束、
  约束是否过短而不可执行，< `MIN_ANCHOR_CHARS`（8）字符记缺口）、行动清晰（20：
  下一步是否具体，含命令/路径/ID 等可执行要素）、参考完备（20：关键路径与命令
  是否齐备）、开放问题显式化（15：进行中项里残留"待定/TODO/TBD"等未决措辞即记缺口）、
  世系健康（10：传承深度告警）、体积预算（10：注入渲染字符量对
  `INJECTION_CHAR_BUDGET`（4000）的占用）。输出 0-100 加权总分、A/B/C/D 分级
  （A ≥ 85 可放心投递 / B ≥ 70 小缺口 / C ≥ 50 需补课 / D < 50 不可投递）与
  按严重度排序的缺口清单（每条带修复建议）；存在 critical 缺口（如零锚定）时
  `blocking: true`，不建议投递。纯函数评估既有结构化交接记录，不发起模型调用。
- **交接验收测试（Specification by Example 自动出卷 + 关键词评分）**：交接质量
  此前的闭环缺口是"写完没人证明读懂了"。验收测试把接手者对结构化交接的理解
  变成可度量的考试：`GET /handoff/acceptance`（缺省取最近一次结构化交接）从
  四个信息层级自动出卷——anchor（硬约束：这条约束是什么）、reference（参考
  定位：关键路径/命令在哪）、open（开放问题：还有哪些未决）、action（起步
  行动：第一步做什么），每题附带评分口径（期望答案的关键词集合，词元化与
  点击模型同源：拉丁词 + CJK 二元组）。`POST /handoff/acceptance/grade` 提交
  `{questionId, answer}[]`——卷面在评分端按存储的交接确定性重建（题号稳定、
  试卷不落盘），逐题按关键词覆盖率打分，总分 = 过题率，裁决 ≥ 0.8 passed /
  ≥ 0.6 borderline / failed；`missingKeywords`（缺什么补什么）与
  `weakestKind`（最薄弱层级）把"没读懂"定位到可修复的具体条目。
  局限：关键词覆盖是浅层理解证据，答对关键词不等于能上手；同义改写可能被误判漏点。

导出模块（模块 A）行为契约：

- **光栅路径归属**：PNG 长图与含非 Latin-1 字符的 PDF 由客户端 canvas 光栅化（kind:'raster'），
  服务端只产出打印 HTML；命令面板等无 canvas 环境：PNG → 400 可读文案，PDF → kind:'print' 降级。
- **批量纪律**：批量打包在服务端完成，强制 raster=false；PNG 不支持批量（400）；
  非 Latin-1 PDF 以 `.html` 入包，不阻塞其余会话。
- **分片光栅（tiled rasterization）**：整篇对话按片高（A4 页高 × 2）逐片光栅化，
  片内经 foreignObject 窗口（translateY 位移）渲染到独立 2x canvas；页界与片界对齐
  （页永不跨片），PDF 页数无上限，峰值内存恒为单片量级。导出带分片进度回调与取消信号。
- **流式 PNG 编码**：逐片取像素 → 逐行 PNG 过滤（片级自适应选过滤器，
  跨片行连续性经原始行携带）→ `CompressionStream('deflate')`（zlib，恰为 PNG 规范格式）
  增量压缩 → Blob 直下；PNG 规范无高度上限，产品理智上限 200,000 CSS px（≈176 页 A4）。
  无 CompressionStream 的环境退回旧单 canvas 截断路径（16000px）。
- **光栅引擎限制**：foreignObject 内脚本不执行（服务端打印页的自动打印 script 已在离屏舞台剥离）；
  外部图片先内联为 data: URL，不可达图片直接移除。
- **交互式 HTML 导出（format:'html'）**：单文件交互档案——数据与渲染器全部内嵌，零外部依赖
  （无 CDN、无字体加载、无 JS 框架）。能力：即时全文搜索（防抖 120ms + 命中高亮 +
  无命中轮次自动隐藏）、角色筛选（全部/仅用户/仅助手）、长轮折叠（超 800 字截断 + 展开全部）、
  时间戳开关、统计栏（轮次/双方字数/时间跨度/当前显示数）、"/" 快捷键聚焦搜索框。
  安全设计：会话数据以 JSON 嵌入非执行的 `<script type="application/json">` 块，
  `<`/`>`/`&`/U+2028/U+2029 一律转义为 `\uXXXX`（防 `</script>` 闭合注入，且是
  JSON.parse 可正确解码的合法转义）；渲染全部走 DOM textContent/createElement，
  永不 innerHTML 用户内容；搜索高亮经文本节点切分 + `<mark>` 实现，天然免疫注入。
  打印时自动展开全部分页。支持批量（ZIP 内以 `.html` 入包）。
- **Merkle 可验证导出（叶双重承诺 + 包含证明）**：批量导出的完整性争议
  （"你给我的 ZIP 少了一份/换了一份"）从口头承诺变成密码学证明。每个文件
  生成叶哈希 = SHA-256(fileName + '\n' + SHA-256(content))——同时承诺文件名与内容，
  防同名调包；全部叶按序两两配对哈希（奇数复制末叶）自底向上成 Merkle 树，
  根哈希即整批承诺（32 字节，可发布到任何外部锚点：邮件签名、工单、区块链）。
  事后争议只需单份文件：`merkle/proof` 出具兄弟路径证明，`merkle/verify` 走三关
  核验——登记（文件名在批次登记表）/ 内容（SHA-256 与登记一致）/ 证明
  （叶 + 兄弟路径逐层复算等于根），三关全过才 `verified`；`detail` 给出不一致时
  的差异定位（"文件自导出后被改动" vs "从未导出" vs "证明路径不匹配"）。
  第三方凭根哈希 + 文件 + 证明即可独立复算，无需整包、无需信任导出方。
  批次记录按根哈希索引落 `export-merkle` 表。
- **差分隐私统计导出（Laplace 机制 + ε 预算账本）**：Merkle 证明"没被改"，但
  发布的统计数字本身可能泄露个体（"某部门本月调用量 = 3"直接点名三个人）。
  DP 端点组把 Dwork（2006）的差分隐私落到工程：`POST /export/dp/release` 对每个
  统计量加 Laplace(0, 敏感度/ε) 噪声后发布，count 类做取整与非负后处理
  （后处理免疫，不损失保证）。ε 是可消耗资源：预算账本（总预算缺省
  `DEFAULT_EPSILON_BUDGET`（3），单次 ε ∈ [0.01, 2] 缺省 `DEFAULT_RELEASE_EPSILON`
  （0.25））按组合定理累计消耗，耗尽即拒绝（`refused: true`，本次不产生任何
  释放、不消耗预算——"省着花"是 DP 的第一纪律）；`GET /export/dp/state` 出
  账本面板，`POST /export/dp/reset` 重置（可顺带调整总预算）。账本持久化
  `export-dp-budget` 表，单次释放 ≤ 50 个指标。
  局限：逐指标独立敏感度（计数类 = 1），不覆盖直方图/联查的联合敏感度；
  噪声让小数字失真（count = 3 加噪后可能变成 5），小群体统计本就不该单独发布。

检索模块（模块 D）行为契约：

- **语义邻域检索（shingle 邻域 + PRF 查询扩展 + RRF 融合）**：在无向量库的前提下提升
  语义召回。流程：初始检索取 `ENGINE_CANDIDATES`（30）候选 → 取 top 命中构建字符
  shingle 邻域（每会话索引最近 `MAX_INDEXED_SESSIONS`（200）条、每条截断
  `PER_SESSION_CHAR_CAP`（20000）字符）→ 伪相关反馈（PRF）从邻域文档扩展查询词
  （封顶 `MAX_EXPANSION_TERMS`（5），停用词占比超 `STOPWORD_RATIO`（0.6）的文档
  不参与扩展）→ 原始词面命中、扩展词命中、shingle Jaccard 三路候选经倒数排名融合
  （RRF，K=60）合成最终排序。`/search/similar` 以指定会话内容为查询复用同一管线。
  局限：语义理解是浅层的（字符 shingle + 词面共现），无嵌入模型的深层同义召回能力；
  邻域索引覆盖最近 200 条会话，更早会话仅参与词面召回。
- **点击反馈学习重排序（IPW 去位置偏 + 词元泛化）**：搜索排序的真相在用户点击里，
  但原始点击被位置偏置污染（排前面的天然被点多）。学习管线：每次重排展示即记录
  曝光（impression 携带位次序列），点击携带位次；学习时逆倾向加权（IPW）——
  高位点击按 1/log₂(rank+1) 打折，把"因为排前被点"与"因为相关被点"区分开；
  双通道打分：精确查询通道（证据最直接）优先，词元通道（查询分词的 TF-IDF 泛化）
  兜底——没见过的查询也能借词元证据泛化。重排公式
  `final = w·clickScore + (1−w)·1/log₂(rank+1)`（w 缺省
  `DEFAULT_CLICK_WEIGHT`（0.6））：点击证据缺位时 w 项全为 0，自动退化为引擎原序
  （稳定排序保序），学习是纯增益不劣化。小样本经贝叶斯平滑（α = 2）防过拟合；
  事件滚动保留 `EVENT_KEEP_LIMIT`（5000）条。
- **MMR 多样性重排（Carbonell-Goldstein 边际相关性 + 冗余审计）**：检索的隐藏
  失败模式是"前十条全是同一话题的近似复述"——都与查询最相关。`POST
  /search/diversify` 用 MMR（SIGIR 1998，搜索多样性的事实标准）做贪心重排：
  `MMR = argmax [λ·sim(query,d) − (1−λ)·max sim(d,已选集合)]`——每一步在
  "与查询相关"和"与已选不冗余"之间做边际权衡，λ 缺省 `DEFAULT_MMR_LAMBDA`
  （0.7）偏向相关性，λ=1 退化为纯相关性排序、λ→0 退化为纯多样性。向量化
  与点击模型同源（拉丁词 + CJK 二元组，L2 归一化 TF 余弦）；查询与候选零词元
  重合时相关度退化为位次置信度，MMM 在词面无重合场景仍按原序工作。附带冗余
  审计：重排前后集合的平均两两相似度（`avgPairwiseSimBefore/After`——多样性
  收益可度量）与被淘汰的近似重复对（两两余弦 ≥ `DUPLICATE_THRESHOLD`（0.8），
  标注 `redundantWith`——"省下 4 条重复"是可陈述的收益）。
  局限：词面余弦识别不了深层同义复述；λ 是经验参数，不同查询的最优值不同。

轨迹模块（模块 E）行为契约：

- **SPC 控制图（EWMA + Western Electric 规则）**：把统计过程控制引入轨迹指标监控，
  解决"基准线对比"对缓慢漂移与波动放大不敏感的问题。Phase I 用全量历史做参数估计
  （过程均值中心线 + 移动极差 MR̄/d₂ 估计 σ，对自相关序列比样本方差更稳健，
  全零时退回样本标准差）；逐日递推 EWMA 统计量并比对自适应控制限（`limitWidth` σ，
  限宽随递推阶段收敛）。判级吸收 Western Electric 规则：劣化侧越限 →
  out-of-control；改善侧越限 / 连续同侧偏移 / 单调趋势 / 周漂移超 1σ → warning；
  其余 stable。`lambda` 越小对缓慢漂移越灵敏、对突发越迟钝，反之亦然（缺省 0.3）。
  图表只展示查询区间，但参数估计永远基于全量历史（防止用户选个安静区间把控制限"调没"）；
  有效样本 < 5 天时无法建立控制图，返回 stable + 提示继续积累。
- **频谱根因定位（SBFL Ochiai 可疑度 + 差分画像）**：前兆挖掘回答「失败之前会发生
  什么」，但不指认元凶；根因定位回答「这批失败和成功相比，哪个步骤出了问题」。
  频谱采集：组件 = 行为签名（kind:name，如 tool:http_request），每条轨迹的
  成败与组件覆盖组成 0/1 矩阵；Ochiai 可疑度
  `sus(n) = failed(n) / √(totalFailed × (failed(n) + passed(n)))`——同时满足
  「失败轨迹几乎都经过它」（高召回）与「成功轨迹几乎不经过它」（高区分度）的
  组件得分逼近 1，√totalFailed 项天然压制只出现在个别失败中的偶发组件。
  差分画像附上可疑组件在失败/成功轨迹中的平均耗时与重试率对比，把统计可疑度
  翻译成可行动的工程线索；裁定门槛：可疑度 ≥ `VERDICT_MIN_SUSPICION`（0.6）且
  失败支持度 ≥ `VERDICT_MIN_FAILED_COUNT`（2）才输出结论——小样本宁可不指认，
  也不冤枉常规步骤。返回排行 ≤ `TOP_COMPONENTS`（20）条。
- **孤立森林轨迹异常检测（iForest 无监督评分 + z 分数证据）**：SPC 与 SBFL 都
  是单维/条件化判断——"每项指标都只偏一点、组合起来前所未见"的轨迹会漏网。
  `GET /trace/anomalies` 用 Isolation Forest（Liu-Ting-Zhou, ICDM 2008）从全局
  分布找异常：每条轨迹提取 7 维特征（节点数 / 总耗时对数 / 总 token 对数 /
  重试率 / 错误率 / 工具占比 / 缓存未命中率）→ 100 棵 iTrees 随机切分
  （子样本 ψ = 256，高度上限 ⌈log₂ψ⌉）→ 异常分 `s(x) = 2^(−E[h(x)]/c(ψ))`：
  异常点稀少且与众不同，平均在更浅处被孤立，分数 → 1；阈值
  `ANOMALY_THRESHOLD`（0.55）以上判异常。黑盒翻译：每条异常附带各特征 z 分数，
  `drivers`（|z| ≥ 2 的特征降序）直接说"重试率 z = +4.2、缓存未命中 z = +3.1"。
  数据源 = 已保存轨迹 + 全部会话派生轨迹（与前兆挖掘同源）；< 8 条轨迹不输出
  结论（`note` 说明）；随机过程种子化（`seed` 参数，评分可复现）。
  局限：无监督——检测的是"与历史分布不同"，不等于"必然故障"；特征 7 维固定，
  新异常形态（如 token 爆炸之外的注入攻击）需扩特征。

Prompt 模块（模块 F）行为契约：

- **自动 Prompt 优化（元提示变异 + 配对显著性检验）**：管线为 元提示生成候选变体
  （以基线 Prompt + 失败用例为输入，要求产出可执行的改写而非空话）→ 基线与全部候选
  在同一批用例上评测 → 最优候选与基线做配对符号检验（McNemar 精确法：只看
  基线败候选胜 b 与基线胜候选败 c 的不一致对，双侧精确二项 p 值）→ 仅当
  p ≤ 0.1 且胜出时才晋升（`save: true` 时写入版本库，备注标注通过率与检验细节）。
  小样本下不显著即不晋升——把 Prompt 优化从手工工艺变成有统计纪律的工程方法，
  防止 3 条用例上的过拟合被当成"优化成功"。
- **Thompson Sampling 变体寻优（Beta 后验采样 + 序贯停止）**：A/B 测评
  （`/prompt/ab-test`）与自动优化（`/prompt/optimize`）都是固定样本量设计——
  每个变体跑完全部用例才下结论。变体寻优把它改为多臂老虎机的序贯决策：
  每臂维护 Beta(α, β) 后验（初始均匀 Beta(1,1)，一次观测一个加法更新），
  每轮从各臂后验抽样（Thompson 采样）选最大者执行——最优臂自动获得最多采样
  预算，明显劣势的臂自动饿死，探索与利用无需人工调节。用例 round-robin 轮转
  （均匀暴露用例难度，防止某臂恰好吃到全部难题）；通过判定与 ab-test 同源
  （expected 子串包含，缺省模型评审员）。后验分析：P(best)（联合后验蒙特卡洛
  `POSTERIOR_MC_DRAWS`（4000）次抽样）/ 期望损失（现在部署本臂相对事后最优的
  期望通过率损失）/ 95% 置信区间；停止裁决：P(best) ≥ `P_BEST_THRESHOLD`（0.9）
  且期望损失 ≤ `EXPECTED_LOSS_EPSILON`（0.01），或每臂采样 ≥
  `MIN_PULLS_PER_ARM`（5）仍未分胜负（宣布无显著差异）。实验规模：
  2~`MAX_BANDIT_ARMS`（8）臂、1~`MAX_BANDIT_CASES`（10）用例、单次 pull
  ≤ `MAX_PULL_ROUNDS`（20）轮；随时可停（后验即结论），状态持久化
  `prompt-bandit` 表。
- **Prompt 静态分析（矛盾指令检测 + 复杂度度量 + 健康分）**：A/B、自动优化、
  变体寻优都是"跑起来才知道好不好"——每次试错都烧 token。`POST /prompt/lint`
  是零模型调用的静态检查器（编译器思路）：规则族覆盖 contradiction/（中英
  语言混杂、同一对象收到相反极性指令、行动冲突）、placeholder/（`{{var}}`
  形态占位符未在 `variables` 声明、已声明未使用）、vagueness/（"尽量""适当"
  "一些"等模糊量词——模型只能猜的约束）、style/（超长句、列表嵌套过深）、
  budget/（估算 token 超出 `budgetTokens`，截断风险）。复杂度度量输出
  `estimatedTokens`（≈3.5 字符/token）、指令密度、硬约束词频、嵌套深度——
  Prompt 的"圈复杂度"；健康分 0-100 折算 A（≥90）/ B（≥75）/ C（≥60）/ D
  （<60）分级，每条 finding 带 severity（error = 会导致事故）与原文摘录。
  局限：语言启发式规则，跨句语义矛盾只能靠"同对象极性冲突"近似；正则词表
  对非常规表述有漏报。

竞技场模块（模块 G）行为契约：

- **金丝雀漂移监控（探针组 + 分布距离）**：LLM 厂商静默更新模型导致排行榜失效。
  每个受监控模型运行确定性探针组（固定温度/固定探针），首次成功运行建立基线，
  后续运行累积历史（封顶 `HISTORY_CAP`（30）条）并从三个维度比对基线：
  成功率（两比例 z 检验）、时延分布（双样本 KS 统计量）、输出风格（shingle Jaccard
  相似度），任一维度 drifted → drifted、任一 warning → warning、否则 stable。
  `canary/report` 不发起任何调用；确认厂商更新后 `canary/reset` 重置基线重新锚定。
  局限：探针是确定性的轻量样本，检测的是行为级漂移（成功率/时延/风格指纹），
  不能定位权重级变化原因。
- **帕累托前沿分析（三维支配 + 双冠军裁定）**：单指标排行（Elo/成本/延迟）
  都在误导选型——真实的选型是三维权衡。前沿分析把每个有 Elo 场次的模型投到
  「能力（Elo）× 成本（计价引擎典型调用价）× 延迟（金丝雀实测均值，无实测按
  档位先验并标注 latencyEstimated）」三维空间，支配关系 = 三维全部不劣且至少
  一维严格优；帕累托前沿 = 不被任何模型支配的集合，被支配模型标注
  `dominatedBy`（支配它的最优替代——"别用它，用 X 更便宜还更强"）。
  双冠军裁定：`valueChampion`（前沿上单位成本能力 Elo/元 最高，性价比之选）与
  `budgetChampion`（与最高分差距 ≤ `PERCEPTION_ELO_GAP`（100，感知阈值：分差
  百名内用户感知不到）中成本最低，预算之选）。诚实纪律：只统计有真实场次的
  模型（0 场的 1500 初始分无意义）；无价目模型无法诚实落在成本轴上，剔除并在
  `unpriced` 披露——防止"免费"模型虚假支配一切。
- **Glicko-2 时变置信评级（评级偏差 RD + 波动率 σ + 保守分排名）**：Elo 的两个
  结构性缺陷——分数不携带置信度（打 1 场和打 100 场的 1500 分是两回事）、
  休战不衰减（半年没参赛的旧分照样压榜）。Glicko-2（Mark Glickman，1995/2012；
  Lichess、国际棋联 FIDE 评级改革方案的标准配置）同时解决两者：每个模型的
  评级是三元组 (rating, RD, σ)——RD（评级偏差）衡量"这个分数有多不确定"，
  σ（波动率）衡量"这个模型的表现有多不稳定"。`POST /arena/glicko/match`
  记录对战后按 Glickman 论文做含时间项的评级更新（τ=0.5）；三重诚实纪律：
  ① 排名按保守分 `rating − 1.96×RD`（95% 置信下界——高 RD 的新模型排名被
  压制，直到真实战绩把 RD 收窄），每行附 95% 置信区间；② 闲置即遗忘：RD
  按距最近对战的闲置天数惰性增长（每 30 天按 c=34.6 增长，封顶 350 回到
  初始不确定），长期休战的模型分数自动"软化"；③ 场次全量披露（games/
  胜率/inactiveDays）——置信区间宽的排名不做强结论。战绩与评级分别持久化
  `arena-glicko-matches` / `arena-glicko-ratings` 表，`POST /arena/glicko/reset`
  清盘重赛。局限：对战图稀疏时（模型间无交手）相对误差放大，评级收敛慢；
  平局语义依赖评测器的 score 标定。

编排模块（模块 H）行为契约：

- **自愈执行（错误分类 + 指数退避全抖动 + 三态断路器 + 模型降级）**：步骤执行失败时先
  分类——non-retryable（鉴权/预算/参数/安全策略：立即放弃不烧配额）、rate-limit
  （长退避，`max(retryIntervalMs*2, 10s)`）、timeout / transient（标准退避）；
  退避为指数 + 全抖动（防重试风暴同步共振）。每个模型挂独立三态断路器：
  连续失败 5 次进入 open（冷却 60s，期间流水线/队列/定时任务全部自动避让该模型），
  冷却结束 half-open 放行单个探针调用验证恢复（探针失败立即重新熔断、成功完全恢复）。
  主模型重试耗尽后若步骤配置了 fallbackModel 且其未被熔断，自动降级补跑一次。
  `/orchestrator/circuits` 输出断路器全景（含 legend）。
- **蒙特卡洛工期模拟（PERT 三点估算 + 分位数置信区间）**："这条流水线要跑多久"
  的单点估算既不诚实也不可辩护。模拟管线：每步从历史成功运行延迟提取
  a/m/b 三点估算（乐观/最可能/悲观分位；零样本回退先验 m = 30s 并标
  `estimated: true`，建议先跑几轮校准）→ 按依赖图拓扑序做 PERT 三角分布
  抽样仿真（`iterations ∈ [200, 20000]`，缺省 2000；`parallelism` 指定时按
  k 工人排队仿真）→ 输出总工期分位数（P50/P80/P90/P95/P99）+ 均值/标准差
  + 每步关键性指数（该步出现在模拟关键路径上的频率）。关键性指数直接回答
  "优化哪一步对总工期最有效"（瓶颈 = `bottleneckStepId`）；P90 承诺
  （"九成把握在此之内完成"）取代拍脑袋的均值承诺。依赖图非法时
  `valid: false` + `errors`，不做模拟。
- **关键路径法 CPM（前向/回向双传播 + 松弛分析 + 并发峰值画像）**：蒙特卡洛
  回答"多久"，CPM（Kelley & Walker，1959，为 DuPont 化工厂建设发明——
  现代项目管理的方法论起点，PMI 体系的基石）回答"为什么是这个工期、
  哪里能腾挪"。`POST /orchestrator/cpm` 对流水线 DAG 做确定性分析：
  步骤工期取历史成功运行的中位延迟（PERT 点估计的稳健替代，零样本退化为
  超时窗/先验并标 `estimated`）→ 前向传播求每步最早开始/结束（ES/EF），
  回向传播求最晚开始/结束（LS/LF），松弛 slack = LS − ES；slack=0 的
  步骤链即关键路径——链上任何一步延误一毫秒，交付就延误一毫秒；
  非关键步骤的 slack 是资源腾挪的安全余量。同时输出并发峰值画像：
  理想无界并行下 [ES, EF] 窗口扫描的并发峰值/峰值时刻/同时在跑的步骤，
  以及并行化收益 = Σ 单步工期 − 关键路径长度——"省下的时间要用并发度换"
  的资源争用代价一并交代。瓶颈步骤（关键路径上工期最长）是优化清单的
  第一行；依赖图非法（环/悬空依赖）时 `valid: false` + `errors`。
  局限：工期是确定性中位数（无分布信息，要分布看蒙特卡洛）；资源争用
  只统计并发峰值，不建排队模型。

团队模块（模块 I）行为契约：

- **经验自动蒸馏（四段式管线）**：① 信号挖矿（本地启发式，零模型成本）：扫描会话尾部
  `MINING_TURN_CAP`（300）轮，识别"错误→修复"结构对（错误信号词后 `RECOVERY_WINDOW`（12）轮
  内出现强修复信号），按错误严重度/修复距离/修复明确性/用户确认加权打分，低信号会话
  （< `DEFAULT_MIN_SIGNAL`（0.45））直接跳过——模型调用只花在高价值轨迹上；
  ② 元提示蒸馏：最高分信号的上下文窗口（`CONTEXT_CHAR_BUDGET`（6000）字符）交给模型
  产出结构化经验卡（一句话教训 + 问题模式 + 解决方案模式 + 标签），教训必须具体可执行；
  ③ 语义去重合并：新卡与既有卡 token Jaccard > `DEDUP_JACCARD_THRESHOLD`（0.55）时
  不新建而是合并（occurrences +1、lastSeenAt 更新、来源会话累积）——复发度是经验价值的
  黄金标准；④ 证据链回溯：每张卡保留来源会话与错误/修复轮次原文摘录（含 seq 定位，
  每卡 `EVIDENCE_CAP`（4）条），蒸馏幻觉可回读原始轨迹核实。蒸馏卡滚动保留
  `DISTILLED_CARD_LIMIT`（200）张；晋升（promote）为正式经验卡需人工确认——
  蒸馏管线负责发现，晋升按钮负责把关，推荐/检索基础设施复用。蒸馏扫描（scan）
  顺序执行防限流，单会话失败跳过不影响其余。
- **专家路由（知识足迹画像 + 余弦匹配 + 盲区检测）**："这个问题该问谁"此前
  只能靠吼一嗓子。画像：每位专家的知识足迹 = 自报领域（权重
  `DOMAIN_WEIGHT`（3））× Prompt 评审产出（`REVIEW_WEIGHT`（2），署名与评审
  author 一致才吃到）× 评审评论（`COMMENT_WEIGHT`（1））三源 TF-IDF 加权语料
  → L2 归一化单位向量（跨专家共享 IDF，稀有术语天然高权重）。
  路由：问题分词 → TF×IDF 向量 → 与各足迹算余弦相似度 + 术语覆盖率，
  输出排序候选（每个带 `matchedTerms`——"为什么是他"的可解释证据）。
  三档裁决：cosine ≥ `CONFIDENT_COSINE`（0.25）且 coverage ≥
  `CONFIDENT_COVERAGE`（0.5）→ confident（出推荐）；有信号但不足 → tentative
  （列候选不出推荐）；全体足迹覆盖不了 → gap——`uncoveredTerms` 即团队知识
  盲区（该补文档还是该招人，一眼可见）。专家目录持久化 `team-experts` 表。
- **Bus Factor 知识单点风险分析（领域覆盖矩阵 + PageRank 协作中心性）**：专家路由
  回答"该问谁"，Bus Factor 回答更冷酷的问题——"谁走了项目就瘫"。`GET /team/busfactor`
  双引擎扫描：① 领域覆盖矩阵——每个自报领域的在岗人数即该领域的 bus factor，
  覆盖 ≤1 记 atRisk（单点：一个人休假/离职即知识断档）、=2 记 fragile，
  整体 bus factor = 最小领域覆盖（木桶原理：项目风险由最薄弱领域决定，
  ≥3 视为健康）；② 协作网络中心性——评审（请求作者 × 评审人）与评论
  （评论者 × 请求作者）构成无向加权协作图，在其上跑 PageRank（Brin & Page，
  1998；阻尼 0.85，幂迭代收敛阈值 1e-6）——中心性高的成员是协作枢纽
  （归一化 ≥0.5），枢纽流失会撕裂知识传播路径；同时披露孤立专家
  （零协作参与——知识孤岛，画像再好也传不出去）与全图边数。纯函数
  分析既有专家目录与评审记录，不发起模型调用。局限：领域覆盖依赖
  专家自报（自报偏差无法检测）；PageRank 只看协作拓扑，不含文档沉淀
  与代码提交等异步知识传播。

安全模块（模块 J）行为契约：

- **提示注入检测（六类检测器 + 风险评分三档判定）**：beforeCall 钩子对每次出站
  messages 做正则模式识别，覆盖六类攻击语义——instruction-override（指令覆写）、
  role-jailbreak（角色越狱）、system-exfil（系统提示词窃取）、tool-hijack（工具劫持）、
  delimiter-confusion（分隔符混淆）、encoding-evasion（编码逃逸），中英双语、
  大小写不敏感。命中按严重度加权累计风险分（0~100），三档判定：clean（放行）/
  suspicious（告警放行）/ malicious。任何非 clean 判定都记入拦截统计并告警；
  严格模式（strict）下 malicious 判定直接抛 403 拦截调用（suspicious 仍只告警——
  可用性优先，渐进收紧）。命中片段落盘前掩码展示。已知局限：正则模式识别存在
  误报（正常讨论注入攻击的技术文章可能命中）与漏报（未覆盖的攻击语义变体）；
  它是纵深防御的一层，不是完整边界。
- **敏感数据污点追踪（源 → 传播链 → 汇点）**：DLP 扫描（发送前预检）只回答
  "这条消息有没有敏感值"；污点追踪回答审计的真问题——"用户输进来的身份证号，
  最后到底流向了哪里"。管线：DLP 规则（含身份证/手机/银行卡等，含内置 + 用户
  自定义）识别敏感源（首次出现的用户消息，掩码值入报告）→ 正向传播分析：
  敏感值在后续事件（assistant 消息 / 工具调用 / 工具结果 / 模型调用）中出现
  即被污点波及，形成传播链（hops，截尾 ≤ `MAX_HOPS`（50），源 ≤
  `MAX_SOURCES`（50））→ 汇点信道分级：outbound（http/webhook 等出站工具，
  最高危）> storage（写盘/导出/提交）> model（发给模型，provider 侧风险）>
  internal（仅在本会话流转）。每源一条污点流，`severity` 按链上最远信道判定；
  整体 `riskLevel` 取最坏流。安全红线：报告全程只含掩码值，原始敏感值不外发。
  已知局限：文本匹配式传播分析——敏感值被模型改写/换格式（如分段转述）后
  即跟丢，不追踪语义级泄露。
- **k-匿名泛化引擎（准标识符泛化格 + 贪心泛化 + 兜底抑制）**：DLP 与污点追踪
  管"单条消息"，第三类风险在批量发布——逐字段脱敏后剩下的"无害字段"组合
  起来还能认出具体的人。Latanya Sweeney 的经典研究（2002）：87% 的美国人口
  可被 {邮编, 性别, 出生日期} 三元组唯一标识——单独无害的准标识符（QI）
  组合起来就是指纹。`POST /security/kanonymize {records, k}` 让发布数据中
  任何 QI 组合至少对应 k 条记录（想认出一个人，至少要同时怀疑 k 个人）：
  每个准标识符（年龄/邮编/出生日期/城市/性别）定义一条泛化格——年龄 →
  5 岁段 → 10 岁段 → 20 岁段 → 掩蔽，邮编 → 前 4 位 → 前 2 位 → 掩蔽，
  出生日期 → 年份 → 年代 → 掩蔽……贪心迭代：只要仍有 QI 组 < k，就在
  "泛化后违规记录数下降最多"的维度上升一级（信息损失最小化启发式）；
  泛化到顶仍孤立的记录整行抑制（移除）——宁可少发布一行，也不留可被
  唯一标识的个体。审计报告随数据一并交付：各维度泛化层级、等价类
  分布（≤200 组）、抑制率、最大再识别风险（= 1/最小组大小，达成时
  ≤ 1/k）、k 达成状态。输入上限 5000 条、k ≥ 2；纯函数，不落盘、
  不发起调用。局限：贪心单维泛化不保证全局最优（Incognito/Samarati
  多维搜索的轻量替代）；k-匿名对同质性攻击（组内 k 条敏感值全同）与
  背景知识攻击不设防——需要更强的 l-多样性/差分隐私时，统计数据发布
  走导出模块的 DP 通道。

核心服务行为契约：

- **共享原语唯一权威实现（DRY 治理，Hunt & Thomas 1999）**：跨模块重复的
  基础算法一律收敛到 core 层唯一权威实现，模块内不再各自拷贝——字符
  3-gram shingle 与 Jaccard 相似度（金丝雀风格指纹与语义邻域检索曾各有一份
  逐字相同的实现）收敛到 `core/text.js`；描述统计（percentile/median/mean，
  蒙特卡洛工期分位、竞技场排行榜分位、漂移监控中位数曾三处重复）收敛到
  `core/stats.js`；错误收敛通道 `toSafeHttpError` 与数值参数钳制
  `clampIntParam`/`clampNumberParam`（导出/搜索两份错误拷贝、team/handoff/
  trace 三份钳制拷贝）收敛到 `core/http.js`。语义不同的近似实现
  （如 team 的停用词分词 vs search 的检索分词）保留各自版本，不强行
  统一——去重的边界是"行为完全一致"，不是"看起来像"。
- **厂商目录类型精确化（Make Illegal States Unrepresentable）**：`VENDORS`
  的键类型从 `Record<string, VendorInfo>` 精确为 `Record<VendorId, VendorInfo>`
  （字面量联合），`VENDORS.deepseek` 的存在性由类型系统背书（原先依赖
  非空断言）；任意字符串查找厂商一律走 `vendorInfoOf(id)`
  （hasOwn 收窄，未知返回 undefined），未知厂商无法再静默落到
  `undefined` 后被非空断言掩盖成运行时崩溃。
- `ready` 失败后可重试（存储域恢复后下次访问重新 open），并挂兜底 catch 杜绝未处理 rejection。
- HTTP 请求体读取有 30s 超时（408）；错误响应路径对已发送头的连接直接结束/销毁，不产生未处理 rejection。
- 峰谷窗口支持跨午夜（`start > end`）；脱敏覆盖带分隔符的手机号/银行卡，身份证正则含生日段合法性校验。
