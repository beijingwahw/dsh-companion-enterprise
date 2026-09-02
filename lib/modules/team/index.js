import { HttpError, clampIntParam, sendJson } from '../../core/http.js';
import { SessionId } from '../../core/ids.js';
import { transcriptFromLog } from '../../core/transcript.js';
import { buildDistillPrompt, confidenceOf, DEFAULT_MIN_SIGNAL, DistilledCardStore, MINING_TURN_CAP, mineSignals, parseDistilledCard, } from './distill.js';
import { buildProfileIndex, ExpertStore, profileViews, routeQuestion } from './expert.js';
import { analyzeBusFactor } from './busfactor.js';
import { assessCard, EffectivenessStore, effectivenessWeight, } from './effectiveness.js';
import { EXPERIENCE_CARD_LIMIT, ExperienceCardStore, ReviewCommentStore, ReviewDecisionStore, ReviewRequestStore, SnapshotArchiveStore, TeamPrefsStore, teamId, } from './store.js';
/** 插件名。 */
export const name = 'companion-team';
/** 依赖服务：companion 根服务 + 会话查询（经验蒸馏读轨迹）。 */
export const inject = ['companion', 'sessionQuery'];
/** 'cost-extra' 表中 pricing 覆盖的键（与成本模块同源）。 */
const COST_EXTRA_PRICING_KEY = 'pricing';
/** 插件入口。 */
export function apply(ctx) {
    void (async () => {
        const store = await ctx.companion.ready.catch(() => undefined);
        if (!store)
            return;
        const { domain } = store;
        const prefs = new TeamPrefsStore(domain);
        const snapshots = new SnapshotArchiveStore(domain);
        const cards = new ExperienceCardStore(domain);
        const distilled = new DistilledCardStore(domain);
        const effectiveness = new EffectivenessStore(domain);
        const reviews = new ReviewRequestStore(domain);
        const comments = new ReviewCommentStore(domain);
        const decisions = new ReviewDecisionStore(domain);
        const experts = new ExpertStore(domain);
        /** 构建全体专家的知识足迹索引（注册领域 + 评审产出加权语料）。 */
        const buildExpertIndex = () => {
            const allReviews = reviews.list();
            const allComments = allReviews.flatMap((review) => comments.forReview(review.id));
            const allDecisions = allReviews.flatMap((review) => decisions.forReview(review.id));
            return buildProfileIndex(experts.list(), allReviews, allComments, allDecisions);
        };
        /** 当前成员署名（未配置时的兜底标识）。 */
        const memberName = () => prefs.get().memberName || '匿名成员';
        /** 读取评审请求，不存在即 404。 */
        const requireReview = (id) => {
            const review = reviews.get(id);
            if (!review)
                throw new HttpError(`评审不存在：${id}`, 404);
            return review;
        };
        /** 调用模型（成本策略层优先，缺省直连核心服务）。 */
        async function callModel(messages) {
            const costGateway = ctx.get('companionCost');
            if (costGateway) {
                const result = await costGateway.call({
                    messages,
                    taskHint: '经验蒸馏',
                    source: 'team',
                    priority: 'high',
                });
                return result.content;
            }
            const result = await ctx.companion.callDeepSeek({
                messages,
                model: 'deepseek-chat',
                source: 'team',
            });
            return result.content;
        }
        /**
         * 蒸馏单个会话：读轨迹 → 信号挖矿（本地启发式）→ 最高分信号的
         * 错误-修复上下文交模型蒸馏 → JSON 解析收窄 → 语义去重落库。
         * 无信号（未检测到错误→修复结构）不消耗模型调用，直接返回。
         */
        async function distillSession(sessionId) {
            let snapshot;
            try {
                snapshot = await ctx.sessionQuery.readSession(SessionId(sessionId));
            }
            catch (error) {
                throw new HttpError(`读取会话失败：${error instanceof Error ? error.message : String(error)}`, 404);
            }
            const turns = transcriptFromLog(snapshot).slice(-MINING_TURN_CAP);
            const signals = mineSignals(turns);
            if (signals.length === 0)
                return { status: 'no-signal', signalCount: 0 };
            const top = signals[0];
            const messages = [{ role: 'user', content: buildDistillPrompt(top) }];
            let content;
            try {
                content = await callModel(messages);
            }
            catch (error) {
                throw new HttpError(`模型调用失败：${error instanceof Error ? error.message : String(error)}`, 502);
            }
            let outcome;
            try {
                const parsed = parseDistilledCard(content);
                const { card, merged } = await distilled.dedupPut(parsed, top, sessionId);
                outcome = {
                    status: merged ? 'merged' : 'created',
                    card,
                    confidence: confidenceOf(card),
                    signalScore: top.score,
                    signalCount: signals.length,
                };
            }
            catch (error) {
                throw new HttpError(`蒸馏结果解析失败：${error instanceof Error ? error.message : String(error)}`, 502);
            }
            return outcome;
        }
        try {
            ctx.effect(() => {
                const disposers = [
                    // ---- I1 团队配置同步 ----
                    ctx.companion.http.add('GET', '/team/prefs', (_req, res) => {
                        sendJson(res, 200, { prefs: prefs.get() });
                    }),
                    ctx.companion.http.add('POST', '/team/prefs', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const current = prefs.get();
                        // 稀疏补丁：只更新出现的字段。
                        const next = {
                            memberName: requireOptionalString(body.memberName, 'memberName') ?? current.memberName,
                            defaultStrategy: body.defaultStrategy === undefined
                                ? current.defaultStrategy
                                : parseStrategy(body.defaultStrategy, 'defaultStrategy'),
                        };
                        await prefs.put(next);
                        sendJson(res, 200, { prefs: next });
                    }),
                    ctx.companion.http.add('GET', '/team/config/export', (_req, res) => {
                        sendJson(res, 200, { snapshot: collectSnapshot(domain, prefs.get().memberName) });
                    }),
                    ctx.companion.http.add('POST', '/team/config/diff', (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        sendJson(res, 200, { diffs: computeDiffs(domain, parseSnapshot(body.snapshot)) });
                    }),
                    ctx.companion.http.add('POST', '/team/config/import', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const snapshot = parseSnapshot(body.snapshot);
                        const strategy = parseStrategy(body.strategy, 'strategy');
                        const reports = await importSnapshot(domain, snapshot, strategy, (table) => ctx.companion.setPricingOverrides(table));
                        if (strategy !== 'manual') {
                            // 归档本次导入的快照（滚动保留上限由仓库内部处理）。
                            await snapshots.put(snapshot);
                            const added = reports.reduce((sum, report) => sum + report.added, 0);
                            const updated = reports.reduce((sum, report) => sum + report.updated, 0);
                            ctx.companion.notice('success', `团队配置导入完成：新增 ${added} 项，更新 ${updated} 项`);
                        }
                        sendJson(res, 200, { reports });
                    }),
                    ctx.companion.http.add('GET', '/team/snapshots', (_req, res) => {
                        sendJson(res, 200, { snapshots: snapshots.list() });
                    }),
                    ctx.companion.http.add('DELETE', '/team/snapshots', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const key = requireString(body.key, 'key');
                        const table = domain.table('team-snapshots');
                        if (/^\d+$/.test(key)) {
                            // 客户端以导出时间戳为键：按时间戳定位归档条目删除。
                            const exportedAt = Number(key);
                            for (const [entryKey, entry] of table.entries()) {
                                if (entry.exportedAt === exportedAt) {
                                    await table.delete(entryKey);
                                    break;
                                }
                            }
                        }
                        else {
                            await table.delete(key);
                        }
                        sendJson(res, 200, { ok: true });
                    }),
                    // ---- I2 执行经验库 ----
                    ctx.companion.http.add('GET', '/team/experience', (_req, res, hctx) => {
                        const tagsParam = hctx.query.get('tags');
                        const tags = tagsParam
                            ? tagsParam.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0)
                            : undefined;
                        sendJson(res, 200, {
                            cards: cards.search({
                                query: hctx.query.get('query') ?? undefined,
                                tags,
                                model: hctx.query.get('model') ?? undefined,
                                limit: parseLimit(hctx.query.get('limit'), 200),
                            }),
                        });
                    }),
                    ctx.companion.http.add('POST', '/team/experience', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const now = Date.now();
                        const card = {
                            id: teamId('exp'),
                            createdAt: now,
                            updatedAt: now,
                            source: parseExperienceSource(body.source),
                            sourceId: requireOptionalString(body.sourceId, 'sourceId') ?? '',
                            runId: requireOptionalString(body.runId, 'runId') ?? '',
                            title: requireString(body.title, 'title'),
                            model: requireOptionalString(body.model, 'model') ?? '',
                            promptSummary: requireOptionalString(body.promptSummary, 'promptSummary') ?? '',
                            durationMs: optionalNumber(body.durationMs) ?? 0,
                            tokens: optionalNumber(body.tokens) ?? 0,
                            ok: body.ok === undefined ? true : body.ok === true,
                            error: requireOptionalString(body.error, 'error') ?? '',
                            tags: parseStringArray(body.tags, 'tags'),
                            notes: [],
                        };
                        await cards.put(card);
                        sendJson(res, 200, { card });
                    }),
                    ctx.companion.http.add('POST', '/team/experience/notes', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const id = requireString(body.id, 'id');
                        const card = cards.get(id);
                        if (!card)
                            throw new HttpError(`执行卡片不存在：${id}`, 404);
                        const updated = {
                            ...card,
                            notes: [
                                ...card.notes,
                                {
                                    problem: requireString(body.problem, 'problem'),
                                    solution: requireString(body.solution, 'solution'),
                                    ts: Date.now(),
                                },
                            ],
                            updatedAt: Date.now(),
                        };
                        await cards.put(updated);
                        sendJson(res, 200, { card: updated });
                    }),
                    ctx.companion.http.add('DELETE', '/team/experience', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        await cards.delete(requireString(body.id, 'id'));
                        sendJson(res, 200, { ok: true });
                    }),
                    /**
                     * 相似推荐：文本匹配分 × 有效性系数重排（创新扩展）——
                     * 多取 3 候选避免截断，注入反馈画像（proven 浮现 / harmful 沉底）
                     * 参与排序后再截取 limit，并把有效性画像随结果返回。
                     */
                    ctx.companion.http.add('POST', '/team/experience/recommend', (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const rawLimit = optionalNumber(body.limit);
                        const limit = rawLimit === undefined ? 5 : Math.max(1, Math.floor(rawLimit));
                        const candidates = cards.recommend(requireString(body.text, 'text'), limit * 3);
                        const ranked = candidates
                            .map(({ card, score }) => {
                            const assessment = assessCard(card, effectiveness.eventsOf(card.id));
                            return {
                                card,
                                score: Math.round(score * effectivenessWeight(assessment.status) * 100) / 100,
                                textScore: score,
                                effectiveness: assessment,
                            };
                        })
                            .sort((a, b) => b.score - a.score)
                            .slice(0, limit);
                        sendJson(res, 200, { results: ranked });
                    }),
                    // ---- I2 创新扩展：经验有效性追踪（注入反馈 + 半衰期淘汰） ----
                    // 回填一次注入反馈：执行结束后告诉经验库"这条经验帮到/害到我了"。
                    ctx.companion.http.add('POST', '/team/experience/feedback', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const cardId = requireString(body.cardId, 'cardId');
                        const card = cards.get(cardId);
                        if (!card)
                            throw new HttpError(`执行卡片不存在：${cardId}`, 404);
                        const outcomeRaw = body.outcome;
                        if (outcomeRaw !== 'helped' && outcomeRaw !== 'neutral' && outcomeRaw !== 'hurt') {
                            throw new HttpError("outcome 必须是 'helped'、'neutral' 或 'hurt'", 400);
                        }
                        const note = requireOptionalString(body.note, 'note');
                        await effectiveness.record(cardId, outcomeRaw, note);
                        sendJson(res, 200, {
                            effectiveness: assessCard(card, effectiveness.eventsOf(cardId)),
                        });
                    }),
                    // 全库有效性报告：状态画像 + 组织性遗忘候选。
                    ctx.companion.http.add('GET', '/team/effectiveness', (_req, res) => {
                        sendJson(res, 200, { report: effectiveness.buildReport(cards.list()) });
                    }),
                    /**
                     * 组织性遗忘：按有效性画像清理经验库。
                     * mode=harmful 清理有害卡；stale 清理久未使用卡；both 两者皆清
                     * （stale 额外要求评分 < 0.5，避免误杀高价值未复用经验）。
                     */
                    ctx.companion.http.add('POST', '/team/effectiveness/sweep', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const modeRaw = body.mode === undefined ? 'both' : body.mode;
                        if (modeRaw !== 'harmful' && modeRaw !== 'stale' && modeRaw !== 'both') {
                            throw new HttpError("mode 必须是 'harmful'、'stale' 或 'both'", 400);
                        }
                        const report = effectiveness.buildReport(cards.list());
                        const shouldRetire = (status, score) => {
                            if (status === 'harmful')
                                return modeRaw !== 'stale';
                            return modeRaw !== 'harmful' && status === 'stale' && score < 0.5;
                        };
                        const deleted = [];
                        for (const item of report.cards) {
                            if (shouldRetire(item.status, item.score)) {
                                await cards.delete(item.cardId);
                                deleted.push(item.cardId);
                            }
                        }
                        sendJson(res, 200, { deleted, remaining: cards.list().length });
                    }),
                    // ---- I2 创新扩展：经验自动蒸馏 ----
                    // 蒸馏单个会话：信号挖矿 → 元提示蒸馏 → 语义去重落库。
                    ctx.companion.http.add('POST', '/team/experience/distill', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const sessionId = requireString(body.sessionId, 'sessionId');
                        sendJson(res, 200, await distillSession(sessionId));
                    }),
                    /**
                     * 批量挖矿：扫描最近会话，本地信号打分后仅对高信号会话发起蒸馏
                     * （模型调用只花在刀刃上）。已蒸馏过的会话自动跳过。
                     * 参数：limit 扫描会话数（缺省 30）、maxDistill 单批蒸馏上限
                     * （缺省 5，按信号得分降序取）、minSignal 蒸馏门槛（缺省 0.45）。
                     */
                    ctx.companion.http.add('POST', '/team/experience/distill/scan', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const limit = clampIntParam(body.limit, 1, 100, 30);
                        const maxDistill = clampIntParam(body.maxDistill, 1, 10, 5);
                        const minSignalRaw = optionalNumber(body.minSignal);
                        const minSignal = minSignalRaw === undefined ? DEFAULT_MIN_SIGNAL : Math.min(Math.max(minSignalRaw, 0), 1);
                        // 候选：未蒸馏过的最近会话（按更新时间降序）。
                        const sessions = [...(await ctx.sessionQuery.listSessions())]
                            .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
                            .slice(0, limit);
                        const candidates = [];
                        for (const session of sessions) {
                            const id = String(session.id);
                            if (distilled.hasSession(id))
                                continue;
                            try {
                                const snapshot = await ctx.sessionQuery.readSession(SessionId(id));
                                const signals = mineSignals(transcriptFromLog(snapshot).slice(-MINING_TURN_CAP));
                                if (signals.length === 0)
                                    continue;
                                if (signals[0].score >= minSignal) {
                                    candidates.push({
                                        sessionId: id,
                                        title: session.title ?? '未命名对话',
                                        score: signals[0].score,
                                    });
                                }
                            }
                            catch {
                                // 单会话读取失败：跳过，不影响其余扫描。
                            }
                        }
                        // 高信号候选按得分降序蒸馏（顺序执行防限流）。
                        candidates.sort((a, b) => b.score - a.score);
                        const distilledResults = [];
                        const errors = [];
                        for (const candidate of candidates.slice(0, maxDistill)) {
                            try {
                                distilledResults.push({
                                    sessionId: candidate.sessionId,
                                    outcome: await distillSession(candidate.sessionId),
                                });
                            }
                            catch (error) {
                                errors.push({
                                    sessionId: candidate.sessionId,
                                    error: error instanceof Error ? error.message : String(error),
                                });
                            }
                        }
                        sendJson(res, 200, {
                            scanned: sessions.length,
                            candidates,
                            distilled: distilledResults,
                            errors,
                        });
                    }),
                    // 蒸馏卡列表（按置信度降序；复发次数 + 信号强度加权）。
                    ctx.companion.http.add('GET', '/team/experience/distilled', (_req, res) => {
                        sendJson(res, 200, {
                            cards: distilled.list().map((card) => ({ ...card, confidence: confidenceOf(card) })),
                        });
                    }),
                    /**
                     * 晋升：把蒸馏卡确认为正式执行经验卡（人工把关闭环——
                     * 蒸馏管线负责发现，晋升按钮负责把关，推荐/检索基础设施复用）。
                     */
                    ctx.companion.http.add('POST', '/team/experience/distilled/promote', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const id = requireString(body.id, 'id');
                        const card = distilled.get(id);
                        if (!card)
                            throw new HttpError(`蒸馏卡不存在：${id}`, 404);
                        if (card.promoted)
                            throw new HttpError('该蒸馏卡已晋升', 400);
                        const now = Date.now();
                        const formal = {
                            id: teamId('exp'),
                            createdAt: now,
                            updatedAt: now,
                            source: 'session',
                            sourceId: card.sessionId,
                            runId: card.id,
                            title: card.title,
                            model: '',
                            promptSummary: card.lesson,
                            durationMs: 0,
                            tokens: 0,
                            ok: true,
                            error: card.problem,
                            tags: [...card.tags],
                            notes: [{ problem: card.problem, solution: card.solution, ts: now }],
                        };
                        await cards.put(formal);
                        const promoted = (await distilled.markPromoted(id)) ?? card;
                        sendJson(res, 200, { card: formal, distilledCard: promoted });
                    }),
                    ctx.companion.http.add('DELETE', '/team/experience/distilled', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        await distilled.delete(requireString(body.id, 'id'));
                        sendJson(res, 200, { ok: true });
                    }),
                    // ---- I3 Prompt 协作评审 ----
                    ctx.companion.http.add('GET', '/team/reviews', (_req, res) => {
                        sendJson(res, 200, { reviews: reviews.list() });
                    }),
                    ctx.companion.http.add('POST', '/team/reviews', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const now = Date.now();
                        const review = {
                            id: teamId('review'),
                            title: requireString(body.title, 'title'),
                            baseContent: requireOptionalString(body.baseContent, 'baseContent') ?? '',
                            proposedContent: requireString(body.proposedContent, 'proposedContent'),
                            author: memberName(),
                            note: requireOptionalString(body.note, 'note') ?? '',
                            status: 'open',
                            createdAt: now,
                            updatedAt: now,
                            mergedVersion: 0,
                        };
                        await reviews.put(review);
                        sendJson(res, 200, { review });
                    }),
                    ctx.companion.http.add('GET', '/team/reviews/get', (_req, res, hctx) => {
                        const id = requireString(hctx.query.get('id'), 'id');
                        const review = requireReview(id);
                        sendJson(res, 200, { review, comments: comments.forReview(id), decisions: decisions.forReview(id) });
                    }),
                    ctx.companion.http.add('POST', '/team/reviews/comment', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const reviewId = requireString(body.reviewId, 'reviewId');
                        requireReview(reviewId);
                        const comment = {
                            id: teamId('comment'),
                            reviewId,
                            author: memberName(),
                            content: requireString(body.content, 'content'),
                            anchor: parseAnchor(body.anchor),
                            createdAt: Date.now(),
                        };
                        await comments.put(comment);
                        sendJson(res, 200, { comment });
                    }),
                    ctx.companion.http.add('POST', '/team/reviews/decide', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const reviewId = requireString(body.reviewId, 'reviewId');
                        const review = requireReview(reviewId);
                        const verdict = body.verdict;
                        if (verdict !== 'approve' && verdict !== 'reject') {
                            throw new HttpError("verdict 必须是 'approve' 或 'reject'", 400);
                        }
                        const decision = {
                            reviewId,
                            reviewer: memberName(),
                            verdict,
                            comment: requireOptionalString(body.comment, 'comment') ?? '',
                            ts: Date.now(),
                        };
                        await decisions.put(decision);
                        const status = verdict === 'approve' ? 'approved' : 'rejected';
                        await reviews.put({ ...review, status, updatedAt: Date.now() });
                        sendJson(res, 200, { decision });
                    }),
                    ctx.companion.http.add('POST', '/team/reviews/merge', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const review = requireReview(requireString(body.reviewId, 'reviewId'));
                        if (review.status !== 'approved')
                            throw new HttpError('仅通过审核的评审可合并主版本', 400);
                        // 直接操作 'prompt-versions' 表：提议内容成为新的主版本。
                        const versionsTable = domain.table('prompt-versions');
                        let latest = 0;
                        for (const [, record] of versionsTable.entries()) {
                            if (Number.isInteger(record.version) && record.version > latest)
                                latest = record.version;
                        }
                        const mergedVersion = latest + 1;
                        await versionsTable.put(String(mergedVersion), {
                            version: mergedVersion,
                            content: review.proposedContent,
                            note: `团队评审合并：${review.title}`,
                            tags: ['团队评审'],
                            createdAt: Date.now(),
                        });
                        await reviews.put({ ...review, status: 'merged', mergedVersion, updatedAt: Date.now() });
                        sendJson(res, 200, { ok: true, mergedVersion });
                    }),
                    ctx.companion.http.add('DELETE', '/team/reviews', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const id = requireString(body.id, 'id');
                        await reviews.delete(id);
                        // 级联清理评论与决定，避免留下孤儿记录。
                        for (const comment of comments.forReview(id))
                            await comments.delete(comment.id);
                        const decisionTable = domain.table('review-decisions');
                        for (const [key, decision] of decisionTable.entries()) {
                            if (decision.reviewId === id)
                                await decisionTable.delete(key);
                        }
                        sendJson(res, 200, { ok: true });
                    }),
                    // --------------------------------------------------------------
                    // 专家路由：知识足迹画像 + 余弦匹配（创新扩展）
                    // --------------------------------------------------------------
                    // 注册/更新专家（同名更新；署名与评审 author 一致可吃到评审产出足迹）。
                    ctx.companion.http.add('POST', '/team/experts', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const name = requireString(body.name, 'name');
                        const domains = parseStringArray(body.domains, 'domains');
                        if (domains.length === 0)
                            throw new HttpError('domains 至少需要 1 个领域关键词', 400);
                        const bio = typeof body.bio === 'string' ? body.bio.trim() : '';
                        const expert = await experts.save({ name, domains, bio });
                        sendJson(res, 200, { expert });
                    }),
                    // 专家目录。
                    ctx.companion.http.add('GET', '/team/experts', (_req, res) => {
                        sendJson(res, 200, { experts: experts.list() });
                    }),
                    // 删除专家。
                    ctx.companion.http.add('DELETE', '/team/experts', async (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const id = requireString(body.id, 'id');
                        await experts.delete(id);
                        sendJson(res, 200, { ok: true });
                    }),
                    // 知识足迹画像面板：TF-IDF 顶部术语 + 足迹来源拆解。
                    ctx.companion.http.add('GET', '/team/experts/profiles', (_req, res) => {
                        const index = buildExpertIndex();
                        sendJson(res, 200, { profiles: profileViews(index) });
                    }),
                    // 专家路由：问题 → 余弦匹配 → 推荐专家 + 知识盲区检测。
                    ctx.companion.http.add('POST', '/team/experts/route', (_req, res, hctx) => {
                        const body = readObject(hctx.body);
                        const question = requireString(body.question, 'question');
                        const index = buildExpertIndex();
                        sendJson(res, 200, routeQuestion(index, question));
                    }),
                    // Bus Factor + 协作中心性（创新扩展）：领域覆盖单点风险 +
                    // PageRank 协作枢纽 + 孤立专家检测。
                    ctx.companion.http.add('GET', '/team/busfactor', (_req, res) => {
                        const allReviews = reviews.list();
                        const allComments = allReviews.flatMap((review) => comments.forReview(review.id));
                        sendJson(res, 200, analyzeBusFactor(experts.list(), allReviews, allComments));
                    }),
                ];
                return () => {
                    for (const dispose of [...disposers].reverse())
                        dispose();
                };
            }, 'companion-team.register');
        }
        catch {
            // 等待存储域期间插件已被卸载，放弃注册。
        }
    })();
}
/** 构造一个列表型分区绑定（收窄/写出时的类型转换集中在此）。 */
function defineBinding(section, keyOf, readLocal, readRemote, writeItem) {
    return {
        section,
        keyOf: (item) => keyOf(item),
        readLocal,
        readRemote,
        writeItem: (item) => writeItem(item),
    };
}
/** 构造五个列表型分区的绑定（本地读取统一投影为快照内形状，保证 diff 两侧可比）。 */
function buildSectionBindings(domain) {
    const templates = domain.table('templates');
    const promptTemplates = domain.table('prompt-templates');
    const pipelines = domain.table('pipelines');
    const jobs = domain.table('scheduled-jobs');
    const dlpRules = domain.table('dlp-rules');
    return [
        defineBinding('handoffTemplates', (item) => item.name, () => templates.entries().map(([name, r]) => ({ name, content: r.content })), (sections) => sections.handoffTemplates, (item) => templates.put(item.name, { content: item.content, updatedAt: Date.now() })),
        defineBinding('promptTemplates', (item) => item.name, () => promptTemplates.entries().map(([, r]) => r).filter((r) => !r.builtin)
            .map((r) => ({ name: r.name, category: r.category, content: r.content })), (sections) => sections.promptTemplates, (item) => promptTemplates.put(item.name, { ...item, builtin: false, updatedAt: Date.now() })),
        defineBinding('pipelines', (item) => item.id, () => pipelines.entries().map(([, record]) => record), (sections) => sections.pipelines, (item) => pipelines.put(item.id, item)),
        defineBinding('scheduledJobs', (item) => item.id, () => jobs.entries().map(([, record]) => record), (sections) => sections.scheduledJobs, (item) => jobs.put(item.id, item)),
        defineBinding('dlpRules', (item) => item.id, () => dlpRules.entries().map(([, r]) => r).filter((r) => !r.builtin)
            .map((r) => ({ id: r.id, name: r.name, pattern: r.pattern, enabled: r.enabled })), (sections) => sections.dlpRules, (item) => dlpRules.put(item.id, { ...item, builtin: false })),
    ];
}
/** 收集本地各表配置，组装导出快照（I1）。 */
function collectSnapshot(domain, exportedBy) {
    const locals = new Map();
    for (const binding of buildSectionBindings(domain))
        locals.set(binding.section, binding.readLocal());
    const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN');
    const pricingOverrides = readLocalPricing(domain);
    return {
        kind: 'dsh-companion-team-config',
        version: 1,
        exportedAt: Date.now(),
        exportedBy,
        sections: {
            pricingOverrides: Object.keys(pricingOverrides).length > 0 ? pricingOverrides : undefined,
            handoffTemplates: [...locals.get('handoffTemplates')].sort(byName),
            promptTemplates: [...locals.get('promptTemplates')].sort(byName),
            pipelines: locals.get('pipelines'),
            scheduledJobs: locals.get('scheduledJobs'),
            dlpRules: locals.get('dlpRules'),
        },
    };
}
/** 校验并规范化团队配置快照（diff 与导入共用入口）。 */
function parseSnapshot(raw) {
    const record = requireObject(raw, 'snapshot');
    if (record.kind !== 'dsh-companion-team-config') {
        throw new HttpError("snapshot.kind 必须是 'dsh-companion-team-config'", 400);
    }
    const sections = requireObject(record.sections, 'snapshot.sections');
    return {
        kind: 'dsh-companion-team-config',
        version: optionalNumber(record.version) ?? 1,
        exportedAt: optionalNumber(record.exportedAt) ?? 0,
        exportedBy: typeof record.exportedBy === 'string' ? record.exportedBy : '',
        sections: {
            costSettings: isPlainObject(sections.costSettings) ? sections.costSettings : undefined,
            pricingOverrides: sections.pricingOverrides === undefined
                ? undefined
                : requireObject(sections.pricingOverrides, 'snapshot.sections.pricingOverrides'),
            handoffTemplates: parseSectionArray(sections.handoffTemplates, 'snapshot.sections.handoffTemplates', parseHandoffTemplate),
            promptTemplates: parseSectionArray(sections.promptTemplates, 'snapshot.sections.promptTemplates', parsePromptTemplate),
            pipelines: parseSectionArray(sections.pipelines, 'snapshot.sections.pipelines', parsePipeline),
            scheduledJobs: parseSectionArray(sections.scheduledJobs, 'snapshot.sections.scheduledJobs', parseScheduledJob),
            dlpRules: parseSectionArray(sections.dlpRules, 'snapshot.sections.dlpRules', parseDlpRule),
        },
    };
}
/** 五个列表型分区的 diff（快照未携带的分区按空远程列表处理，本地条目记为 local-only）。 */
function listSectionDiffs(domain, snapshot) {
    return buildSectionBindings(domain).map((binding) => ({
        binding,
        diffs: diffPairs(binding.section, keyedPairs(binding.readLocal(), binding.keyOf), keyedPairs(binding.readRemote(snapshot.sections) ?? [], binding.keyOf)),
    }));
}
/** 计算远程快照与本地配置的差异（costSettings 不产生 diff）。 */
function computeDiffs(domain, snapshot) {
    const diffs = listSectionDiffs(domain, snapshot).flatMap((entry) => entry.diffs);
    const remotePricing = parsePriceTable(snapshot.sections.pricingOverrides, 'snapshot.sections.pricingOverrides');
    diffs.push(...diffPairs('pricingOverrides', Object.entries(readLocalPricing(domain)), Object.entries(remotePricing)));
    return diffs;
}
/** 按合并策略应用快照导入，返回各分区报告（I1）。 */
async function importSnapshot(domain, snapshot, strategy, setPricingOverrides) {
    const reports = [];
    // costSettings 分区：导入时一律跳过。
    if (snapshot.sections.costSettings !== undefined) {
        reports.push({
            section: 'costSettings',
            added: 0,
            updated: 0,
            same: 0,
            skipped: 1,
            message: '成本模块设置需经成本模块界面配置',
        });
    }
    // 五个列表型分区：快照未携带的分区跳过，携带的按策略写入。
    for (const { binding, diffs } of listSectionDiffs(domain, snapshot)) {
        if (binding.readRemote(snapshot.sections) === undefined)
            continue;
        reports.push(await applyDiffs(binding.section, diffs, strategy, (entry) => binding.writeItem(entry.remote)));
    }
    // pricingOverrides → 'cost-extra' 表 + 动态计价引擎。
    if (snapshot.sections.pricingOverrides !== undefined) {
        const local = readLocalPricing(domain);
        const remote = parsePriceTable(snapshot.sections.pricingOverrides, 'snapshot.sections.pricingOverrides');
        const merged = { ...local };
        const diffs = diffPairs('pricingOverrides', Object.entries(local), Object.entries(remote));
        const report = await applyDiffs('pricingOverrides', diffs, strategy, async (entry) => {
            merged[entry.key] = entry.remote;
        });
        if (strategy !== 'manual' && (report.added > 0 || report.updated > 0)) {
            await domain.table('cost-extra').put(COST_EXTRA_PRICING_KEY, merged);
            setPricingOverrides(merged);
        }
        reports.push(report);
    }
    // 手动合并模式：未执行写入，报告统一标注。
    return strategy === 'manual'
        ? reports.map((report) => ({ ...report, message: report.message ?? '手动合并模式，未执行写入' }))
        : reports;
}
/** 条目 → [身份键, 条目] 对（diff 预处理）。 */
function keyedPairs(items, keyOf) {
    return items.map((item) => [keyOf(item), item]);
}
/**
 * 分区 diff：以身份键比较两侧，内容用 JSON.stringify 比较。
 * add=仅远程存在；update=两侧不同；same=两侧一致；local-only=仅本地存在。
 */
function diffPairs(section, localPairs, remotePairs) {
    const entries = [];
    const localMap = new Map(localPairs.map(([key, value]) => [key, value]));
    const seen = new Set();
    for (const [key, remoteItem] of remotePairs) {
        seen.add(key);
        const localItem = localMap.get(key);
        if (localItem === undefined) {
            entries.push({ section, key, action: 'add', remote: remoteItem });
        }
        else if (JSON.stringify(localItem) === JSON.stringify(remoteItem)) {
            entries.push({ section, key, action: 'same', local: localItem, remote: remoteItem });
        }
        else {
            entries.push({ section, key, action: 'update', local: localItem, remote: remoteItem });
        }
    }
    for (const [key, localItem] of localMap) {
        if (!seen.has(key))
            entries.push({ section, key, action: 'local-only', local: localItem });
    }
    return entries;
}
/**
 * 按策略应用单个分区的 diff 并生成导入报告。
 * local：仅写入 add；remote：写入 add + update；manual：只计数不写入。
 */
async function applyDiffs(section, diffs, strategy, write) {
    let added = 0;
    let updated = 0;
    let same = 0;
    let skipped = 0;
    for (const entry of diffs) {
        if (entry.action === 'same') {
            same += 1;
        }
        else if (entry.action === 'local-only' || (entry.action === 'update' && strategy === 'local')) {
            // local-only 条目与 local 策略下的冲突条目：保留本地现状，计入跳过。
            skipped += 1;
        }
        else {
            if (entry.action === 'update')
                updated += 1;
            else
                added += 1;
            if (strategy !== 'manual')
                await write(entry);
        }
    }
    return { section, added, updated, same, skipped };
}
/** 读取本地用户自定义单价覆盖（'cost-extra' 表键 'pricing'）。 */
function readLocalPricing(domain) {
    return domain.table('cost-extra').get(COST_EXTRA_PRICING_KEY) ?? {};
}
// --------------------------------------------------------------------
// 快照分区条目解析（unknown → 具体形状；非法即 400）
// --------------------------------------------------------------------
/** 解析快照可选分区数组（缺省保持 undefined，表示快照未携带该分区）。 */
function parseSectionArray(raw, field, parseItem) {
    if (raw === undefined)
        return undefined;
    if (!Array.isArray(raw))
        throw new HttpError(`${field} 必须是数组`, 400);
    return raw.map((item, index) => parseItem(item, `${field}[${index}]`));
}
/** 解析交接摘要模板条目。 */
function parseHandoffTemplate(raw, field) {
    const record = requireObject(raw, field);
    return {
        name: requireString(record.name, `${field}.name`),
        content: typeof record.content === 'string' ? record.content : '',
    };
}
/** 解析 Prompt 模板条目。 */
function parsePromptTemplate(raw, field) {
    const record = requireObject(raw, field);
    return {
        name: requireString(record.name, `${field}.name`),
        category: typeof record.category === 'string' && record.category.trim() ? record.category.trim() : '自定义',
        content: typeof record.content === 'string' ? record.content : '',
    };
}
/** 解析流水线记录。 */
function parsePipeline(raw, field) {
    const record = requireObject(raw, field);
    return {
        id: requireString(record.id, `${field}.id`),
        name: requireString(record.name, `${field}.name`),
        steps: Array.isArray(record.steps) ? record.steps : [],
        createdAt: optionalNumber(record.createdAt) ?? Date.now(),
        updatedAt: optionalNumber(record.updatedAt) ?? Date.now(),
    };
}
/** 解析定时任务记录。 */
function parseScheduledJob(raw, field) {
    const record = requireObject(raw, field);
    const cron = requireString(record.cron, `${field}.cron`);
    return {
        id: requireString(record.id, `${field}.id`),
        name: requireString(record.name, `${field}.name`),
        cron,
        scheduleText: typeof record.scheduleText === 'string' && record.scheduleText.trim() ? record.scheduleText.trim() : cron,
        prompt: typeof record.prompt === 'string' ? record.prompt : '',
        model: typeof record.model === 'string' && record.model.trim() ? record.model.trim() : 'deepseek-chat',
        offPeakOnly: record.offPeakOnly === true,
        enabled: record.enabled !== false,
        createdAt: optionalNumber(record.createdAt) ?? Date.now(),
        lastRunAt: optionalNumber(record.lastRunAt) ?? 0,
        nextRunAt: optionalNumber(record.nextRunAt) ?? 0,
    };
}
/** 解析自定义 DLP 规则条目。 */
function parseDlpRule(raw, field) {
    const record = requireObject(raw, field);
    return {
        id: requireString(record.id, `${field}.id`),
        name: requireString(record.name, `${field}.name`),
        pattern: requireString(record.pattern, `${field}.pattern`),
        enabled: record.enabled !== false,
    };
}
/** 解析单价覆盖表（模型 id → 单价）。 */
function parsePriceTable(raw, field) {
    if (raw === undefined)
        return {};
    const table = {};
    for (const [model, value] of Object.entries(raw))
        table[model] = parseModelPrice(value, `${field}.${model}`);
    return table;
}
/** 解析单模型单价（元/百万 tokens；inputCacheHit 缺省 0）。 */
function parseModelPrice(raw, field) {
    const record = requireObject(raw, field);
    const inputMiss = record.inputMiss;
    const output = record.output;
    if (typeof inputMiss !== 'number' || typeof output !== 'number' || inputMiss < 0 || output < 0) {
        throw new HttpError(`${field} 缺少合法的 inputMiss/output`, 400);
    }
    const inputCacheHit = record.inputCacheHit;
    if (inputCacheHit !== undefined && (typeof inputCacheHit !== 'number' || inputCacheHit < 0)) {
        throw new HttpError(`${field}.inputCacheHit 必须是非负数字`, 400);
    }
    return { inputCacheHit: typeof inputCacheHit === 'number' ? inputCacheHit : 0, inputMiss, output };
}
// --------------------------------------------------------------------
// 请求体收窄辅助（unknown → 具体形状；strict 下不用 any）
// --------------------------------------------------------------------
/** 将请求体收窄为 JSON 对象，否则 400。 */
function readObject(body) {
    if (!isPlainObject(body))
        throw new HttpError('请求体必须是 JSON 对象', 400);
    return body;
}
/** 读取必填非空字符串字段（自动去除首尾空白）。 */
function requireString(value, field) {
    if (typeof value !== 'string' || !value.trim())
        throw new HttpError(`${field} 必须是非空字符串`, 400);
    return value.trim();
}
/** 读取可选字符串字段（缺省返回 undefined；提供时必须是字符串）。 */
function requireOptionalString(value, field) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string')
        throw new HttpError(`${field} 必须是字符串`, 400);
    return value.trim();
}
/** 将值收窄为普通对象，否则 400。 */
function requireObject(value, field) {
    if (!isPlainObject(value))
        throw new HttpError(`${field} 必须是对象`, 400);
    return value;
}
/** 判断是否为普通对象（非 null、非数组）。 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** 读取可选有限数字（非法或缺省返回 undefined）。 */
function optionalNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** 解析合并策略（local/remote/manual），非法即 400。 */
function parseStrategy(value, field) {
    if (value === 'local' || value === 'remote' || value === 'manual')
        return value;
    throw new HttpError(`${field} 必须是 'local'、'remote' 或 'manual'`, 400);
}
/** 解析执行卡片来源（缺省 manual；'session' = 经验自动蒸馏晋升），非法即 400。 */
function parseExperienceSource(value) {
    if (value === undefined)
        return 'manual';
    if (value === 'pipeline' || value === 'queue' || value === 'cron' ||
        value === 'manual' || value === 'session')
        return value;
    throw new HttpError("source 必须是 'pipeline'、'queue'、'cron'、'manual' 或 'session'", 400);
}
// clampInt 已上移 core/http.ts（clampIntParam，全插件唯一权威实现）。
/** 解析评论批注锚点（缺省为提议侧整体评论）。 */
function parseAnchor(value) {
    if (value === undefined || value === null)
        return { side: 'proposed', line: 0 };
    const record = requireObject(value, 'anchor');
    const side = record.side;
    if (side !== undefined && side !== 'base' && side !== 'proposed') {
        throw new HttpError("anchor.side 必须是 'base' 或 'proposed'", 400);
    }
    const line = record.line === undefined ? 0 : Number(record.line);
    if (!Number.isInteger(line) || line < 0)
        throw new HttpError('anchor.line 必须是非负整数', 400);
    return { side: side ?? 'proposed', line };
}
/** 解析字符串数组（缺省返回空数组；条目去空白、过滤空串）。 */
function parseStringArray(value, field) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new HttpError(`${field} 必须是字符串数组`, 400);
    const result = [];
    for (const item of value) {
        if (typeof item !== 'string')
            throw new HttpError(`${field} 必须全部为字符串`, 400);
        if (item.trim())
            result.push(item.trim());
    }
    return result;
}
/** 解析查询参数中的 limit（非法回退缺省值，上限为卡片总数上限）。 */
function parseLimit(raw, fallback) {
    if (raw === null || raw === '')
        return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0)
        return fallback;
    return Math.min(Math.floor(value), EXPERIENCE_CARD_LIMIT);
}
