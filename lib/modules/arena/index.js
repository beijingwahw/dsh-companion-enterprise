import { HttpError, sendJson } from '../../core/http.js';
import { round4, tokenUsageToUsageLike } from '../../core/pricing.js';
import { percentileOf } from '../../core/stats.js';
import { ARENA_MODEL_CATALOG, customModelToInfo, deriveModelsFromIds, isAllowedArenaOrigin, recommendModels, taskTypeLabel, } from './catalog.js';
import { CustomModelStore } from './store.js';
import { EloStore } from './elo.js';
import { GlickoStore } from './glicko.js';
import { analyzeFrontier, LATENCY_TIER_PRIOR_MS } from './frontier.js';
import { analyzeDrift, CANARY_PROBES, CanaryStore, HISTORY_CAP, } from './drift.js';
/** 插件名。 */
export const name = 'companion-arena';
/** 依赖服务：companion 根服务。 */
export const inject = ['companion'];
/** G1 并行对比的模型数上限。 */
const MAX_COMPARE_MODELS = 5;
/** G2 批量评测的用例数上限。 */
const MAX_LEADERBOARD_CASES = 30;
/** 推荐引擎估算单次成本用的典型用量（计价引擎 UsageLike 形状）。 */
const TYPICAL_USAGE = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 };
/** 外部厂商 Key 在保险库中的秘密名前缀。 */
const ARENA_KEY_SECRET_PREFIX = 'arena-key:';
/** 插件入口。 */
export function apply(ctx) {
    /** 最近一次评测结果缓存（供导出复用，避免重跑评测）。 */
    let lastLeaderboard;
    /**
     * 完整模型列表：内置目录 + 实时定价表新模型 + 用户自定义模型。
     * 实时定价表来自动态计价引擎对各厂商官方定价页的抓取，厂商上新
     * 模型后无需改代码即可自动出现在竞技场（最新模型自动导入）。
     */
    async function listAllModels() {
        const { domain } = await ctx.companion.ready;
        const custom = new CustomModelStore(domain).list().map(customModelToInfo);
        const knownIds = new Set(ARENA_MODEL_CATALOG.map((model) => model.id));
        // 实时定价表中的全部模型 id（含官方页新上架的模型）。
        const liveIds = [];
        for (const vendor of ctx.companion.prices.vendorPricing(Date.now())) {
            liveIds.push(...Object.keys(vendor.models));
        }
        const liveDerived = deriveModelsFromIds(liveIds, knownIds);
        return [...ARENA_MODEL_CATALOG, ...liveDerived, ...custom];
    }
    // ------------------------------------------------------------------
    // GET /arena/models：模型目录（内置 + 自定义）+ Key 配置状态
    // ------------------------------------------------------------------
    ctx.effect(() => ctx.companion.http.add('GET', '/arena/models', async (_req, res) => {
        const { vault } = await ctx.companion.ready;
        const models = await listAllModels();
        const now = Date.now();
        sendJson(res, 200, {
            models: models.map((model) => ({
                id: model.id,
                label: model.label,
                provider: model.provider,
                latencyTier: model.latencyTier,
                accuracyPrior: model.accuracyPrior,
                custom: model.custom ?? false,
                keyConfigured: model.provider === 'deepseek'
                    ? undefined
                    : vault.hasSecret(`${ARENA_KEY_SECRET_PREFIX}${model.id}`),
                // 全模型峰谷感知：当前是否高峰 + 该模型厂商是否有峰谷分时价。
                peakStatus: ctx.companion.prices.peakStatusOf(model.id, now),
            })),
        });
    }), 'companion.arena-http-models');
    // ------------------------------------------------------------------
    // POST /arena/custom-models：添加/更新用户自定义模型
    // ------------------------------------------------------------------
    ctx.effect(() => ctx.companion.http.add('POST', '/arena/custom-models', async (_req, res, { body }) => {
        const record = readObject(body);
        const modelId = requireString(record.modelId, 'modelId');
        const label = requireString(record.label, 'label');
        const baseUrl = requireString(record.baseUrl, 'baseUrl');
        if (!/^https?:\/\//i.test(baseUrl)) {
            throw new HttpError('baseUrl 必须是 http(s):// 开头的完整地址', 400);
        }
        if (!isAllowedArenaOrigin(baseUrl)) {
            throw new HttpError('baseUrl 域名不在 manifest.json 网络权限白名单内，无法直连', 400);
        }
        const latencyTier = record.latencyTier === 'fast' || record.latencyTier === 'slow'
            ? record.latencyTier
            : 'balanced';
        if (ARENA_MODEL_CATALOG.some((model) => model.id === modelId)) {
            throw new HttpError(`模型 id ${modelId} 与内置目录冲突，请换一个 id`, 400);
        }
        const { domain } = await ctx.companion.ready;
        const store = new CustomModelStore(domain);
        const existing = store.get(modelId);
        await store.save({
            id: modelId,
            label,
            baseUrl: baseUrl.replace(/\/+$/, ''),
            latencyTier,
            createdAt: existing?.createdAt ?? Date.now(),
        });
        sendJson(res, 200, { ok: true });
    }), 'companion.arena-http-add-custom-model');
    // ------------------------------------------------------------------
    // DELETE /arena/custom-models：删除用户自定义模型（连同其 Key）
    // ------------------------------------------------------------------
    ctx.effect(() => ctx.companion.http.add('DELETE', '/arena/custom-models', async (_req, res, { body }) => {
        const record = readObject(body);
        const modelId = requireString(record.modelId, 'modelId');
        const { domain, vault } = await ctx.companion.ready;
        const store = new CustomModelStore(domain);
        if (!store.get(modelId)) {
            throw new HttpError(`自定义模型 ${modelId} 不存在`, 404);
        }
        await store.delete(modelId);
        await vault.deleteSecret(`${ARENA_KEY_SECRET_PREFIX}${modelId}`);
        await vault.deleteSecret(`${ARENA_KEY_SECRET_PREFIX}${modelId}:base-url`);
        sendJson(res, 200, { ok: true });
    }), 'companion.arena-http-delete-custom-model');
    // ------------------------------------------------------------------
    // POST /arena/keys：保存外部厂商 Key（加密落盘，支持内置与自定义模型）
    // ------------------------------------------------------------------
    ctx.effect(() => ctx.companion.http.add('POST', '/arena/keys', async (_req, res, { body }) => {
        const record = readObject(body);
        const modelId = requireString(record.modelId, 'modelId');
        const apiKey = requireString(record.apiKey, 'apiKey');
        const model = (await listAllModels()).find((m) => m.id === modelId);
        if (!model || model.provider !== 'external') {
            throw new HttpError(`模型 ${modelId} 不是外部厂商模型`, 400);
        }
        const { vault } = await ctx.companion.ready;
        await vault.setSecret(`${ARENA_KEY_SECRET_PREFIX}${modelId}`, apiKey);
        if (typeof record.baseUrl === 'string' && record.baseUrl.trim()) {
            const overrideUrl = record.baseUrl.trim();
            if (!isAllowedArenaOrigin(overrideUrl)) {
                throw new HttpError('baseUrl 域名不在 manifest.json 网络权限白名单内，无法直连', 400);
            }
            await vault.setSecret(`${ARENA_KEY_SECRET_PREFIX}${modelId}:base-url`, overrideUrl);
        }
        sendJson(res, 200, { ok: true });
    }), 'companion.arena-http-set-keys');
    // ------------------------------------------------------------------
    // DELETE /arena/keys：删除外部厂商 Key（自定义模型同时删除模型本身）
    // ------------------------------------------------------------------
    ctx.effect(() => ctx.companion.http.add('DELETE', '/arena/keys', async (_req, res, { body }) => {
        const record = readObject(body);
        const modelId = requireString(record.modelId, 'modelId');
        const { domain, vault } = await ctx.companion.ready;
        await vault.deleteSecret(`${ARENA_KEY_SECRET_PREFIX}${modelId}`);
        await vault.deleteSecret(`${ARENA_KEY_SECRET_PREFIX}${modelId}:base-url`);
        // 自定义模型的 Key 面板“删除”即整体移除（模型记录 + Key）。
        const store = new CustomModelStore(domain);
        if (store.get(modelId)) {
            await store.delete(modelId);
        }
        sendJson(res, 200, { ok: true });
    }), 'companion.arena-http-clear-keys');
    // ------------------------------------------------------------------
    // POST /arena/compare：G1 同 Prompt 多模型并行对比
    // ------------------------------------------------------------------
    ctx.effect(() => ctx.companion.http.add('POST', '/arena/compare', async (_req, res, { body }) => {
        const record = readObject(body);
        const prompt = requireString(record.prompt, 'prompt');
        const modelIds = parseStringArray(record.models, 'models');
        if (modelIds.length === 0)
            throw new HttpError('models 不能为空', 400);
        if (modelIds.length > MAX_COMPARE_MODELS) {
            throw new HttpError(`最多同时对比 ${MAX_COMPARE_MODELS} 个模型`, 400);
        }
        const results = await Promise.all(modelIds.map((modelId) => runOneModel(ctx, modelId, prompt)));
        sendJson(res, 200, { prompt, results });
    }), 'companion.arena-http-compare');
    // ------------------------------------------------------------------
    // POST /arena/leaderboard：G2 批量评测排行榜
    // ------------------------------------------------------------------
    ctx.effect(() => ctx.companion.http.add('POST', '/arena/leaderboard', async (_req, res, { body }) => {
        const record = readObject(body);
        // 导出走缓存（useCache）：直接基于最近一次评测结果生成报告，不重跑评测。
        // 该分支无需 models/cases，必须先于其校验执行。
        if (record.useCache === true && (record.format === 'markdown' || record.format === 'html')) {
            if (!lastLeaderboard)
                throw new HttpError('暂无评测结果可导出，请先运行评测', 400);
            sendJson(res, 200, {
                format: record.format,
                fileName: `arena-leaderboard-${Date.now()}.${record.format === 'html' ? 'html' : 'md'}`,
                content: record.format === 'html'
                    ? buildLeaderboardHtml(lastLeaderboard.rows, lastLeaderboard.caseCount)
                    : buildLeaderboardMarkdown(lastLeaderboard.rows, lastLeaderboard.caseCount),
            });
            return;
        }
        const modelIds = parseStringArray(record.models, 'models');
        if (modelIds.length === 0)
            throw new HttpError('models 不能为空', 400);
        if (modelIds.length > MAX_COMPARE_MODELS) {
            throw new HttpError(`最多同时评测 ${MAX_COMPARE_MODELS} 个模型`, 400);
        }
        const cases = parseTestCases(record.cases);
        if (cases.length === 0)
            throw new HttpError('cases 不能为空', 400);
        if (cases.length > MAX_LEADERBOARD_CASES) {
            throw new HttpError(`测试用例不能超过 ${MAX_LEADERBOARD_CASES} 条`, 400);
        }
        const rows = [];
        for (const modelId of modelIds) {
            const runs = [];
            for (const testCase of cases) {
                runs.push(await runOneModel(ctx, modelId, testCase.input));
            }
            rows.push(buildLeaderboardRow(modelId, cases, runs));
        }
        rows.sort((a, b) => b.compositeScore - a.compositeScore);
        // 缓存最近一次评测结果，供导出复用。
        lastLeaderboard = { rows, caseCount: cases.length };
        // Elo 联动：相邻名次两两对战自动记分（得分差 < 5% 视为平局），
        // 单次评测的快照由此沉淀为跨评测累积的动态评级。
        {
            const { domain } = await ctx.companion.ready;
            const elo = new EloStore(domain);
            for (let i = 0; i + 1 < rows.length; i += 1) {
                const top = rows[i];
                const bottom = rows[i + 1];
                const gap = top.compositeScore - bottom.compositeScore;
                const outcome = gap > 5 ? 'win' : gap < -5 ? 'loss' : 'draw';
                await elo.recordMatch(top.model, bottom.model, outcome, 'leaderboard').catch(() => undefined);
            }
        }
        if (record.format === 'markdown' || record.format === 'html') {
            sendJson(res, 200, {
                format: record.format,
                fileName: `arena-leaderboard-${Date.now()}.${record.format === 'html' ? 'html' : 'md'}`,
                content: record.format === 'html'
                    ? buildLeaderboardHtml(rows, cases.length)
                    : buildLeaderboardMarkdown(rows, cases.length),
            });
            return;
        }
        sendJson(res, 200, { format: 'json', rows });
    }), 'companion.arena-http-leaderboard');
    // ------------------------------------------------------------------
    // GET /arena/recommend：G3 模型推荐引擎
    // ------------------------------------------------------------------
    ctx.effect(() => ctx.companion.http.add('GET', '/arena/recommend', async (_req, res, { query }) => {
        const taskType = parseTaskType(query.get('taskType'));
        const budgetRaw = query.get('budgetPerCallCny');
        const budgetPerCallCny = budgetRaw === null ? 0 : Number(budgetRaw);
        if (!Number.isFinite(budgetPerCallCny) || budgetPerCallCny < 0) {
            throw new HttpError('budgetPerCallCny 必须是非负数字', 400);
        }
        const latency = query.get('latency');
        const latencyRequirement = latency === 'fast' || latency === 'balanced' ? latency : 'any';
        // 以典型用量估算各模型单次成本（动态计价引擎，全模型峰谷感知）。
        const models = await listAllModels();
        const now = Date.now();
        const costPerCall = {};
        // 收集公布了峰谷分时价的模型 id（推荐理由按模型区分峰谷文案）。
        const peakPricingModels = new Set();
        for (const model of models) {
            const cost = ctx.companion.prices.costOfCall(model.id, TYPICAL_USAGE, now);
            costPerCall[model.id] = round4(cost);
            if (ctx.companion.prices.peakStatusOf(model.id, now).hasPeakPricing) {
                peakPricingModels.add(model.id);
            }
        }
        const recommendations = recommendModels(models, { taskType, budgetPerCallCny, latencyRequirement }, costPerCall, now, peakPricingModels);
        sendJson(res, 200, {
            taskType,
            taskTypeLabel: taskTypeLabel(taskType),
            recommendations: recommendations.map((rec) => ({
                model: rec.model.id,
                label: rec.model.label,
                score: round4(rec.score),
                reason: rec.reason,
                estimatedCostCny: costPerCall[rec.model.id] ?? 0,
            })),
        });
    }), 'companion.arena-http-recommend');
    // ------------------------------------------------------------------
    // G4 金丝雀探针漂移监控（创新扩展）
    // ------------------------------------------------------------------
    // POST /arena/canary/run：对指定模型运行确定性探针组并比对基线。
    ctx.effect(() => ctx.companion.http.add('POST', '/arena/canary/run', async (_req, res, { body }) => {
        const record = readObject(body);
        const modelIds = parseStringArray(record.models, 'models');
        if (modelIds.length === 0)
            throw new HttpError('models 不能为空', 400);
        if (modelIds.length > MAX_COMPARE_MODELS) {
            throw new HttpError(`单次最多监控 ${MAX_COMPARE_MODELS} 个模型`, 400);
        }
        const { domain } = await ctx.companion.ready;
        const store = new CanaryStore(domain);
        const reports = [];
        for (const modelId of modelIds) {
            const run = await runCanaryProbes(ctx, modelId);
            const existing = store.get(modelId);
            const next = existing?.baseline
                ? {
                    model: modelId,
                    baseline: existing.baseline,
                    history: [...existing.history, run].slice(-HISTORY_CAP),
                }
                : { model: modelId, baseline: run, history: [] };
            await store.save(next);
            reports.push(analyzeDrift(next));
        }
        sendJson(res, 200, { reports });
    }), 'companion.arena-http-canary-run');
    // GET /arena/canary/report：查看已存探针记录的漂移报告（不发起调用）。
    ctx.effect(() => ctx.companion.http.add('GET', '/arena/canary/report', async (_req, res, { query }) => {
        const model = query.get('model');
        const { domain } = await ctx.companion.ready;
        const store = new CanaryStore(domain);
        if (model) {
            const record = store.get(model);
            if (!record)
                throw new HttpError(`模型 ${model} 尚无金丝雀记录，请先运行探针`, 404);
            sendJson(res, 200, {
                model: record.model,
                baselineTs: record.baseline?.ts ?? 0,
                historyRuns: record.history.length,
                probes: CANARY_PROBES.map((probe) => probe.description),
                report: analyzeDrift(record),
            });
            return;
        }
        // 不带 model：返回全部受监控模型的状态概览。
        const all = store.list().map((record) => ({
            model: record.model,
            baselineTs: record.baseline?.ts ?? 0,
            historyRuns: record.history.length,
            verdict: analyzeDrift(record).verdict,
        }));
        sendJson(res, 200, { models: all });
    }), 'companion.arena-http-canary-report');
    // POST /arena/canary/reset：重置基线（确认厂商更新后重新锚定）。
    ctx.effect(() => ctx.companion.http.add('POST', '/arena/canary/reset', async (_req, res, { body }) => {
        const record = readObject(body);
        const modelId = requireString(record.model, 'model');
        const { domain } = await ctx.companion.ready;
        const store = new CanaryStore(domain);
        if (!store.get(modelId)) {
            throw new HttpError(`模型 ${modelId} 尚无金丝雀记录`, 404);
        }
        await store.delete(modelId);
        sendJson(res, 200, { ok: true, hint: '基线已清除，下次运行探针将重新建立基线' });
    }), 'companion.arena-http-canary-reset');
    // ------------------------------------------------------------------
    // G5 Elo 动态评级（创新扩展）
    // ------------------------------------------------------------------
    // POST /arena/elo/match：提交一次偏好对战（A/B 谁更好，含平局）。
    ctx.effect(() => ctx.companion.http.add('POST', '/arena/elo/match', async (_req, res, { body }) => {
        const record = readObject(body);
        const a = requireString(record.a, 'a');
        const b = requireString(record.b, 'b');
        if (a === b)
            throw new HttpError('a 与 b 不能是同一个模型', 400);
        const outcomeRaw = record.outcome;
        if (outcomeRaw !== 'win' && outcomeRaw !== 'loss' && outcomeRaw !== 'draw') {
            throw new HttpError('outcome 必须是 win / loss / draw（a 的视角）', 400);
        }
        const { domain } = await ctx.companion.ready;
        const elo = new EloStore(domain);
        await elo.recordMatch(a, b, outcomeRaw, 'manual');
        sendJson(res, 200, elo.report().standings);
    }), 'companion.arena-http-elo-match');
    // GET /arena/elo：评级表（Wilson 下界保守排名）+ 对战记录 + 评级演化。
    ctx.effect(() => ctx.companion.http.add('GET', '/arena/elo', async (_req, res) => {
        const { domain } = await ctx.companion.ready;
        sendJson(res, 200, new EloStore(domain).report());
    }), 'companion.arena-http-elo');
    // POST /arena/elo/reset：清空全部对战与评级。
    ctx.effect(() => ctx.companion.http.add('POST', '/arena/elo/reset', async (_req, res) => {
        const { domain } = await ctx.companion.ready;
        await new EloStore(domain).reset();
        sendJson(res, 200, { ok: true });
    }), 'companion.arena-http-elo-reset');
    // ------------------------------------------------------------------
    // G6 Glicko-2 时变置信评级（创新扩展）
    // ------------------------------------------------------------------
    // POST /arena/glicko/match：提交一次偏好对战（评级 + RD + 波动率联合更新）。
    ctx.effect(() => ctx.companion.http.add('POST', '/arena/glicko/match', async (_req, res, { body }) => {
        const record = readObject(body);
        const a = requireString(record.a, 'a');
        const b = requireString(record.b, 'b');
        if (a === b)
            throw new HttpError('a 与 b 不能是同一个模型', 400);
        const outcomeRaw = record.outcome;
        if (outcomeRaw !== 'win' && outcomeRaw !== 'loss' && outcomeRaw !== 'draw') {
            throw new HttpError('outcome 必须是 win / loss / draw（a 的视角）', 400);
        }
        const { domain } = await ctx.companion.ready;
        const glicko = new GlickoStore(domain);
        await glicko.recordMatch(a, b, outcomeRaw, 'manual');
        sendJson(res, 200, glicko.report().standings);
    }), 'companion.arena-http-glicko-match');
    // GET /arena/glicko：评级表（保守分 = rating − 1.96×RD 排名 + 95% CI）。
    ctx.effect(() => ctx.companion.http.add('GET', '/arena/glicko', async (_req, res) => {
        const { domain } = await ctx.companion.ready;
        sendJson(res, 200, new GlickoStore(domain).report());
    }), 'companion.arena-http-glicko');
    // POST /arena/glicko/reset：清空全部对战与评级。
    ctx.effect(() => ctx.companion.http.add('POST', '/arena/glicko/reset', async (_req, res) => {
        const { domain } = await ctx.companion.ready;
        await new GlickoStore(domain).reset();
        sendJson(res, 200, { ok: true });
    }), 'companion.arena-http-glicko-reset');
    // ------------------------------------------------------------------
    // GET /arena/frontier：能力-成本-延迟帕累托前沿（创新扩展）。
    // 数据源：Elo 评级（有场次模型）× 计价引擎典型成本 × 金丝雀实测延迟。
    // ------------------------------------------------------------------
    ctx.effect(() => ctx.companion.http.add('GET', '/arena/frontier', async (_req, res) => {
        const { domain } = await ctx.companion.ready;
        const models = await listAllModels();
        const standings = new EloStore(domain).report().standings;
        const canary = new CanaryStore(domain);
        const now = Date.now();
        const inputs = [];
        const unpriced = [];
        for (const row of standings) {
            // 只分析有真实场次的模型（0 场的 1500 初始分无意义）。
            if (row.games <= 0)
                continue;
            // 无价目模型无法诚实落在成本轴上，剔除并披露。
            if (ctx.companion.prices.resolve(row.model, now) === undefined) {
                unpriced.push(row.model);
                continue;
            }
            const costCny = ctx.companion.prices.costOfCall(row.model, TYPICAL_USAGE, now);
            // 延迟：金丝雀实测均值优先，否则按档位先验估计。
            const record = canary.get(row.model);
            const runs = record
                ? [...(record.baseline ? [record.baseline] : []), ...record.history]
                : [];
            const latencies = runs.flatMap((run) => run.results.map((probe) => probe.latencyMs));
            const measured = latencies.length > 0
                ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
                : undefined;
            const info = models.find((m) => m.id === row.model);
            const tier = info?.latencyTier ?? 'balanced';
            inputs.push({
                model: row.model,
                rating: row.rating,
                games: row.games,
                costCny,
                latencyMs: measured ?? LATENCY_TIER_PRIOR_MS[tier],
                latencyEstimated: measured === undefined,
            });
        }
        const report = analyzeFrontier(inputs);
        sendJson(res, 200, {
            ...report,
            ...(unpriced.length > 0
                ? { unpriced, unpricedNote: '以下有评级但无价目的模型未参与前沿分析' }
                : {}),
        });
    }), 'companion.arena-http-frontier');
}
/** 对单个模型顺序执行全部金丝雀探针（顺序防限流；输出留作风格指纹）。 */
async function runCanaryProbes(ctx, modelId) {
    const results = [];
    const outputs = [];
    for (const probe of CANARY_PROBES) {
        const run = await runOneModel(ctx, modelId, probe.prompt);
        outputs.push(run.output);
        results.push({
            probeId: probe.id,
            ok: run.ok && probe.check(run.output),
            latencyMs: run.latencyMs,
            outputChars: run.output.length,
        });
    }
    return { ts: Date.now(), results, outputs };
}
/** 运行单个模型（DeepSeek 走核心服务记账，外部厂商走兼容协议直连）。 */
async function runOneModel(ctx, modelId, prompt) {
    const startedAt = Date.now();
    const { domain } = await ctx.companion.ready;
    const model = ARENA_MODEL_CATALOG.find((m) => m.id === modelId) ??
        (() => {
            const record = new CustomModelStore(domain).get(modelId);
            return record ? customModelToInfo(record) : undefined;
        })() ??
        // 实时定价表派生的新模型（厂商上新，未进静态目录）。
        deriveModelsFromIds([modelId], new Set())[0];
    if (!model) {
        return failureResult(modelId, startedAt, `未知模型：${modelId}`);
    }
    try {
        if (model.provider === 'deepseek') {
            const result = await ctx.companion.callDeepSeek({
                messages: [{ role: 'user', content: prompt }],
                model: model.id,
                source: 'arena',
            });
            const costCny = round4(ctx.companion.prices.costOfCall(result.model || model.id, tokenUsageToUsageLike(result.usage), Date.now()));
            return {
                model: model.id,
                ok: true,
                output: result.content,
                latencyMs: result.latencyMs,
                promptTokens: result.usage.promptTokens,
                completionTokens: result.usage.completionTokens,
                costCny,
            };
        }
        return await runExternalModel(ctx, model, prompt, startedAt);
    }
    catch (error) {
        return failureResult(modelId, startedAt, error instanceof Error ? error.message : String(error));
    }
}
/** 外部厂商：OpenAI 兼容 chat/completions 直连（Key 从保险库解析）。 */
async function runExternalModel(ctx, model, prompt, startedAt) {
    const { vault } = await ctx.companion.ready;
    const apiKey = await vault.getSecret(`${ARENA_KEY_SECRET_PREFIX}${model.id}`);
    if (!apiKey) {
        return failureResult(model.id, startedAt, `尚未配置 ${model.label} 的 API Key`);
    }
    const baseUrl = (await vault.getSecret(`${ARENA_KEY_SECRET_PREFIX}${model.id}:base-url`)) ??
        model.baseUrl ??
        '';
    // 最终防线：实际发起请求前再次确认目标域名在 manifest 白名单内。
    if (!isAllowedArenaOrigin(baseUrl)) {
        return failureResult(model.id, startedAt, '目标域名不在网络权限白名单内，已拒绝调用');
    }
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: model.id,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
        }),
        signal: AbortSignal.timeout(ctx.companion.config.apiTimeoutMs),
    });
    if (!response.ok) {
        return failureResult(model.id, startedAt, `HTTP ${response.status}`);
    }
    const json = (await response.json());
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
        return failureResult(model.id, startedAt, '响应缺少 choices[0].message.content');
    }
    const promptTokens = toNonNegative(json.usage?.prompt_tokens);
    const completionTokens = toNonNegative(json.usage?.completion_tokens);
    // 外部厂商费用经动态计价引擎估算（目录未收录时成本为 0）。
    const costCny = round4(ctx.companion.prices.costOfCall(model.id, { inputTokens: promptTokens, outputTokens: completionTokens }, Date.now()));
    return {
        model: model.id,
        ok: true,
        output: content,
        latencyMs: Date.now() - startedAt,
        promptTokens,
        completionTokens,
        costCny,
    };
}
/** 失败结果构造。 */
function failureResult(model, startedAt, error) {
    return {
        model,
        ok: false,
        output: '',
        latencyMs: Date.now() - startedAt,
        promptTokens: 0,
        completionTokens: 0,
        costCny: 0,
        error,
    };
}
/** 解析测试集：JSON 数组或 JSONL 字符串。 */
function parseTestCases(raw) {
    let items;
    if (typeof raw === 'string') {
        // JSONL：每行一个 JSON 对象。
        const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
        items = [];
        for (const line of lines) {
            try {
                items.push(JSON.parse(line));
            }
            catch {
                throw new HttpError(`JSONL 解析失败：${line.slice(0, 60)}…`, 400);
            }
        }
    }
    else if (Array.isArray(raw)) {
        items = raw;
    }
    else {
        throw new HttpError('cases 必须是 JSON 数组或 JSONL 字符串', 400);
    }
    return items.map((item, index) => {
        if (typeof item === 'string')
            return { input: item };
        if (typeof item !== 'object' || item === null) {
            throw new HttpError(`cases[${index}] 必须是字符串或对象`, 400);
        }
        const record = item;
        if (typeof record.input !== 'string' || !record.input.trim()) {
            throw new HttpError(`cases[${index}].input 必须是非空字符串`, 400);
        }
        const testCase = { input: record.input };
        if (typeof record.expected === 'string') {
            return {
                ...testCase,
                expected: record.expected,
                judge: record.judge === 'exact' ? 'exact' : 'contains',
            };
        }
        return testCase;
    });
}
/** 汇总单模型的评测行。 */
function buildLeaderboardRow(modelId, cases, runs) {
    const okRuns = runs.filter((run) => run.ok);
    const latencies = okRuns.map((run) => run.latencyMs).sort((a, b) => a - b);
    // 准确率：仅统计提供了 expected 的用例。
    const judged = cases
        .map((testCase, index) => ({ testCase, run: runs[index] }))
        .filter(({ testCase, run }) => testCase.expected !== undefined && run.ok);
    const accuracy = judged.length > 0
        ? judged.filter(({ testCase, run }) => judgeOutput(run.output, testCase.expected ?? '', testCase.judge)).length /
            judged.length
        : null;
    // 结构化合规率：输出为合法 JSON 的比例（仅当全部期望输出都是 JSON 时统计）。
    const expectsJson = judged.length > 0 && judged.every(({ testCase }) => looksLikeJson(testCase.expected ?? ''));
    const complianceRate = expectsJson && okRuns.length > 0
        ? okRuns.filter((run) => looksLikeJson(run.output)).length / okRuns.length
        : null;
    const avgTokens = okRuns.length > 0
        ? Math.round(okRuns.reduce((sum, run) => sum + run.promptTokens + run.completionTokens, 0) / okRuns.length)
        : 0;
    const totalCost = okRuns.reduce((sum, run) => sum + run.costCny, 0);
    // 综合得分：准确率 0.4 + 成功率 0.2 + 延迟 0.2 + 成本 0.2（各自归一）。
    const maxCost = Math.max(1e-9, ...runs.map((run) => run.costCny));
    const maxLatency = Math.max(1, ...latencies);
    const compositeScore = round4((accuracy ?? 0.5) * 0.4 +
        (okRuns.length / Math.max(1, runs.length)) * 0.2 +
        (latencies.length > 0 ? 1 - percentile(latencies, 50) / maxLatency : 0.5) * 0.2 +
        (1 - totalCost / Math.max(1e-9, maxCost * runs.length)) * 0.2);
    return {
        model: modelId,
        successRate: runs.length > 0 ? okRuns.length / runs.length : 0,
        accuracy,
        p50Ms: percentile(latencies, 50),
        p95Ms: percentile(latencies, 95),
        p99Ms: percentile(latencies, 99),
        avgTokens,
        costPerTaskCny: round4(runs.length > 0 ? totalCost / runs.length : 0),
        complianceRate,
        compositeScore,
    };
}
/** 自动评分：exact=完全一致（去首尾空白），contains=包含子串。 */
function judgeOutput(output, expected, judge) {
    if (judge === 'exact')
        return output.trim() === expected.trim();
    return output.includes(expected);
}
/** 文本是否形似 JSON（对象或数组）。 */
function looksLikeJson(text) {
    const trimmed = text.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('[')))
        return false;
    try {
        JSON.parse(trimmed);
        return true;
    }
    catch {
        return false;
    }
}
/** 百分位数（输入需已升序排序）。共享实现见 core/stats.ts。 */
const percentile = percentileOf;
/** 排行榜 Markdown 报告。 */
function buildLeaderboardMarkdown(rows, caseCount) {
    const lines = [
        '# 多模型评测排行榜',
        '',
        `- 测试用例数：${caseCount}`,
        `- 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        '',
        '| 排名 | 模型 | 综合得分 | 成功率 | 准确率 | P50/P95/P99 | 平均Token | 单任务成本 | 合规率 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    rows.forEach((row, index) => {
        lines.push(`| ${index + 1} | ${row.model} | ${row.compositeScore.toFixed(3)} | ${(row.successRate * 100).toFixed(0)}% | ${row.accuracy === null ? 'N/A' : `${(row.accuracy * 100).toFixed(0)}%`} | ${row.p50Ms}/${row.p95Ms}/${row.p99Ms}ms | ${row.avgTokens} | ¥${row.costPerTaskCny.toFixed(4)} | ${row.complianceRate === null ? 'N/A' : `${(row.complianceRate * 100).toFixed(0)}%`} |`);
    });
    return lines.join('\n');
}
/** 排行榜 HTML 报告（自包含）。 */
function buildLeaderboardHtml(rows, caseCount) {
    const bodyRows = rows
        .map((row, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(row.model)}</td><td>${row.compositeScore.toFixed(3)}</td><td>${(row.successRate * 100).toFixed(0)}%</td><td>${row.accuracy === null ? 'N/A' : `${(row.accuracy * 100).toFixed(0)}%`}</td><td>${row.p50Ms}/${row.p95Ms}/${row.p99Ms}ms</td><td>${row.avgTokens}</td><td>¥${row.costPerTaskCny.toFixed(4)}</td><td>${row.complianceRate === null ? 'N/A' : `${(row.complianceRate * 100).toFixed(0)}%`}</td></tr>`)
        .join('\n');
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>多模型评测排行榜</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:24px;color:#1f2328}
h1{font-size:20px}
table{border-collapse:collapse;width:100%;margin-top:16px}
th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;font-size:13px}
th{background:#f6f8fa}
.meta{color:#57606a;font-size:13px}
</style>
</head>
<body>
<h1>多模型评测排行榜</h1>
<p class="meta">测试用例数：${caseCount} · 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}</p>
<table>
<thead><tr><th>排名</th><th>模型</th><th>综合得分</th><th>成功率</th><th>准确率</th><th>P50/P95/P99</th><th>平均Token</th><th>单任务成本</th><th>合规率</th></tr></thead>
<tbody>
${bodyRows}
</tbody>
</table>
</body>
</html>`;
}
/** HTML 转义。 */
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
/** 解析任务类型参数。 */
function parseTaskType(value) {
    if (value === 'code' || value === 'translation' || value === 'summarization' || value === 'reasoning' || value === 'general') {
        return value;
    }
    return 'general';
}
/** 非负数字收窄。 */
function toNonNegative(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}
/** 将请求体收窄为 JSON 对象。 */
function readObject(body) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError('请求体必须是 JSON 对象', 400);
    }
    return body;
}
/** 读取必填非空字符串字段。 */
function requireString(value, field) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new HttpError(`${field} 必须是非空字符串`, 400);
    }
    return value.trim();
}
/** 解析字符串数组。 */
function parseStringArray(value, field) {
    if (!Array.isArray(value))
        throw new HttpError(`${field} 必须是字符串数组`, 400);
    const result = [];
    for (const item of value) {
        if (typeof item !== 'string' || !item.trim()) {
            throw new HttpError(`${field} 必须全部为非空字符串`, 400);
        }
        result.push(item.trim());
    }
    return result;
}
