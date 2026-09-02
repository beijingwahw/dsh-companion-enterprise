import { HttpError, sendJson, toSafeHttpError } from '../../core/http.js';
import { SessionId } from '../../core/ids.js';
import { formatBeijingTime } from '../../core/time.js';
import { semanticSearch, SessionIndex, similarSessions } from './neighborhood.js';
import { buildMemoryGraph, collectGraphSessions, entityNeighborhood, graphReport, } from './graph.js';
import { searchSessions } from './service.js';
import { ClickFeedbackStore, clickModelStats, clickScore, DEFAULT_CLICK_WEIGHT, learnClickModel, rerankHits, } from './rerank.js';
import { diversifyHits } from './diversify.js';
import { TagStore } from './tags.js';
/** 插件名。 */
export const name = 'companion-search';
/** 依赖服务：companion 根服务、会话查询、命令面板。 */
export const inject = ['companion', 'sessionQuery', 'commands'];
/** 北京时间偏移（UTC+8，毫秒）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
/** 一日毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** 记忆图谱缓存 TTL（毫秒）。 */
const GRAPH_TTL_MS = 60_000;
/** YYYY-MM-DD 日期模式。 */
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 插件入口：异步初始化后立即执行函数包裹，注册动作经 ctx.effect。 */
export function apply(ctx) {
    void (async () => {
        // 存储域异步打开；失败时模块保持静默（不注册任何端点/命令）。
        const store = await ctx.companion.ready.catch(() => undefined);
        if (!store)
            return;
        const tagStore = new TagStore(store.domain);
        const clickStore = new ClickFeedbackStore(store.domain);
        // 语义邻域索引（内存缓存 + TTL 重建，见 neighborhood.ts）。
        const neighborhoodIndex = new SessionIndex(ctx.sessionQuery);
        // 组织记忆图谱缓存（TTL 内复用，避免每次查询全量重扫会话）。
        let graphCache;
        const ensureGraph = async () => {
            if (graphCache && Date.now() - graphCache.at < GRAPH_TTL_MS)
                return graphCache.graph;
            const corpus = await collectGraphSessions(ctx.sessionQuery);
            const graph = buildMemoryGraph(corpus);
            graphCache = { at: Date.now(), graph };
            return graph;
        };
        try {
            ctx.effect(() => {
                const disposers = [
                    // 全局检索：query/from/to/tags/limit。
                    ctx.companion.http.add('GET', '/search', async (_req, res, hctx) => {
                        try {
                            const params = parseSearchParams(hctx.query);
                            const hits = await searchSessions({ sessionQuery: ctx.sessionQuery, tagStore }, params);
                            sendJson(res, 200, { hits });
                        }
                        catch (error) {
                            throw toSafeHttpError(error, '检索会话失败');
                        }
                    }),
                    // 语义邻域检索：PRF 查询扩展 + 多源 RRF 融合（创新扩展）。
                    ctx.companion.http.add('GET', '/search/semantic', async (_req, res, hctx) => {
                        try {
                            const query = hctx.query.get('query')?.trim() ?? '';
                            if (query.length === 0)
                                throw new HttpError('query 必填', 400);
                            const limit = parseLimitParam(hctx.query.get('limit'));
                            const result = await semanticSearch({ sessionQuery: ctx.sessionQuery, tagStore }, neighborhoodIndex, query, limit);
                            sendJson(res, 200, result);
                        }
                        catch (error) {
                            throw toSafeHttpError(error, '语义检索失败');
                        }
                    }),
                    // 相似会话（more-like-this）：找出与指定会话内容最像的历史会话。
                    ctx.companion.http.add('GET', '/search/similar', async (_req, res, hctx) => {
                        try {
                            const sessionId = hctx.query.get('sessionId')?.trim() ?? '';
                            if (sessionId.length === 0)
                                throw new HttpError('sessionId 必填', 400);
                            const limit = parseLimitParam(hctx.query.get('limit'));
                            const result = await similarSessions({ sessionQuery: ctx.sessionQuery, tagStore }, neighborhoodIndex, sessionId, limit);
                            sendJson(res, 200, result);
                        }
                        catch (error) {
                            throw toSafeHttpError(error, '查找相似会话失败');
                        }
                    }),
                    // 组织记忆图谱：整体报告（PageRank 枢纽，创新扩展）。
                    ctx.companion.http.add('GET', '/search/graph', async (_req, res) => {
                        try {
                            const graph = await ensureGraph();
                            sendJson(res, 200, graphReport(graph));
                        }
                        catch (error) {
                            throw toSafeHttpError(error, '构建记忆图谱失败');
                        }
                    }),
                    // 组织记忆图谱：实体邻域查询（关联实体 + 关联会话）。
                    ctx.companion.http.add('GET', '/search/graph/entity', async (_req, res, hctx) => {
                        try {
                            const name = hctx.query.get('name')?.trim() ?? '';
                            if (name.length === 0)
                                throw new HttpError('name 必填', 400);
                            const graph = await ensureGraph();
                            const neighborhood = entityNeighborhood(graph, name);
                            if (!neighborhood)
                                throw new HttpError(`实体「${name}」不在图谱中`, 404);
                            sendJson(res, 200, neighborhood);
                        }
                        catch (error) {
                            throw toSafeHttpError(error, '查询实体邻域失败');
                        }
                    }),
                    // 点击反馈学习重排序（创新扩展）：检索 → 点击模型重排 →
                    // 展示即记录曝光（下次学习的燃料）。
                    ctx.companion.http.add('POST', '/search/rerank', async (_req, res, hctx) => {
                        try {
                            const body = parseRerankBody(hctx.body);
                            const hits = await searchSessions({ sessionQuery: ctx.sessionQuery, tagStore }, {
                                query: body.query,
                                ...(body.from !== undefined ? { from: body.from } : {}),
                                ...(body.to !== undefined ? { to: body.to } : {}),
                                ...(body.tags !== undefined && body.tags.length > 0 ? { tags: body.tags } : {}),
                                limit: body.limit,
                            });
                            const model = learnClickModel(clickStore.events());
                            const report = rerankHits(hits, model, body.query, body.clickWeight);
                            // 展示即曝光：记录本次位次序列，供去偏学习。
                            await clickStore.recordImpression(body.query, report.entries.map((entry) => entry.session.id));
                            sendJson(res, 200, report);
                        }
                        catch (error) {
                            throw toSafeHttpError(error, '点击反馈重排失败');
                        }
                    }),
                    // MMR 多样性重排（创新扩展）：检索结果去冗余，λ 权衡相关性与多样性。
                    // POST /search/diversify {query, from?, to?, tags?, limit?, lambda?}。
                    ctx.companion.http.add('POST', '/search/diversify', async (_req, res, hctx) => {
                        try {
                            const body = parseRerankBody(hctx.body);
                            const lambdaRaw = typeof hctx.body === 'object' && hctx.body !== null && !Array.isArray(hctx.body)
                                ? Number(hctx.body.lambda)
                                : Number.NaN;
                            const lambda = Number.isFinite(lambdaRaw) && lambdaRaw >= 0 && lambdaRaw <= 1 ? lambdaRaw : undefined;
                            const hits = await searchSessions({ sessionQuery: ctx.sessionQuery, tagStore }, {
                                query: body.query,
                                ...(body.from !== undefined ? { from: body.from } : {}),
                                ...(body.to !== undefined ? { to: body.to } : {}),
                                ...(body.tags !== undefined && body.tags.length > 0 ? { tags: body.tags } : {}),
                                limit: body.limit,
                            });
                            sendJson(res, 200, diversifyHits(hits, body.query, {
                                ...(lambda !== undefined ? { lambda } : {}),
                                limit: body.limit,
                            }));
                        }
                        catch (error) {
                            throw toSafeHttpError(error, 'MMR 多样性重排失败');
                        }
                    }),
                    // 记录一次点击（query + 会话 + 位次；位次从 1 起）。
                    ctx.companion.http.add('POST', '/search/click', async (_req, res, hctx) => {
                        try {
                            const body = parseClickBody(hctx.body);
                            await clickStore.recordClick(body.query, body.sessionId, body.position);
                            const model = learnClickModel(clickStore.events());
                            sendJson(res, 200, {
                                ok: true,
                                ...(model.eventCount > 0
                                    ? { clickSignal: clickScore(model, body.query, body.sessionId) }
                                    : {}),
                            });
                        }
                        catch (error) {
                            throw toSafeHttpError(error, '记录点击失败');
                        }
                    }),
                    // 点击模型面板：事件量/全局率/词表/最强会话信号。
                    ctx.companion.http.add('GET', '/search/clicks/stats', (_req, res) => {
                        const model = learnClickModel(clickStore.events());
                        sendJson(res, 200, clickModelStats(model));
                    }),
                    // 标签读取：带 sessionId 返回单会话标签，缺省返回全量映射。
                    ctx.companion.http.add('GET', '/tags', (_req, res, hctx) => {
                        const sessionId = hctx.query.get('sessionId');
                        if (sessionId && sessionId.trim().length > 0) {
                            sendJson(res, 200, { tags: tagStore.getForSession(SessionId(sessionId.trim())) });
                            return;
                        }
                        sendJson(res, 200, { tags: tagStore.getAll() });
                    }),
                    // 标签写入：add/remove 原子增删。
                    ctx.companion.http.add('POST', '/tags', async (_req, res, hctx) => {
                        try {
                            const { sessionId, add, remove } = parseTagsBody(hctx.body);
                            const tags = await tagStore.mutate(sessionId, { add, remove });
                            sendJson(res, 200, { tags });
                        }
                        catch (error) {
                            throw toSafeHttpError(error, '更新标签失败');
                        }
                    }),
                    // 命令：检索历史对话。
                    ctx.commands.register({
                        name: 'search',
                        description: '检索历史对话',
                        input: { hint: '<检索词>' },
                        handler: async (invocation) => {
                            const query = (invocation.rawInput ?? '').trim();
                            if (query.length === 0)
                                return { kind: 'error', text: '请输入检索词' };
                            try {
                                const hits = await searchSessions({ sessionQuery: ctx.sessionQuery, tagStore }, { query });
                                if (hits.length === 0)
                                    return { kind: 'success', text: `未找到与“${query}”匹配的对话` };
                                const lines = [`共找到 ${hits.length} 个对话：`];
                                let index = 1;
                                for (const hit of hits) {
                                    lines.push(`${index}. ${hit.session.title || '未命名对话'}`);
                                    lines.push(`   ID: ${hit.session.id}`);
                                    lines.push(`   时间: ${formatBeijingTime(hit.session.createdAt)}`);
                                    if (hit.snippet)
                                        lines.push(`   摘要: ${hit.snippet}`);
                                    if (hit.tags.length > 0)
                                        lines.push(`   标签: ${hit.tags.join('、')}`);
                                    index += 1;
                                }
                                return { kind: 'success', text: lines.join('\n') };
                            }
                            catch {
                                return { kind: 'error', text: '检索失败，请稍后重试' };
                            }
                        },
                    }),
                    // 命令：为会话增删标签。
                    ctx.commands.register({
                        name: 'tag',
                        description: '为会话增删标签',
                        input: { hint: '<会话ID> +标签1 -标签2' },
                        handler: async (invocation) => {
                            const tokens = (invocation.rawInput ?? '')
                                .split(/\s+/)
                                .map((token) => token.trim())
                                .filter((token) => token.length > 0);
                            if (tokens.length < 2) {
                                return { kind: 'error', text: '用法：tag <会话ID> +标签1 -标签2（+ 添加，- 移除）' };
                            }
                            const sessionId = SessionId(tokens[0]);
                            const add = [];
                            const remove = [];
                            for (const token of tokens.slice(1)) {
                                if (token.startsWith('+')) {
                                    const tag = token.slice(1).trim();
                                    if (tag.length > 0)
                                        add.push(tag);
                                }
                                else if (token.startsWith('-')) {
                                    const tag = token.slice(1).trim();
                                    if (tag.length > 0)
                                        remove.push(tag);
                                }
                                else {
                                    return { kind: 'error', text: `无法解析标签参数“${token}”，请使用 +标签/-标签 形式` };
                                }
                            }
                            try {
                                const tags = await tagStore.mutate(sessionId, { add, remove });
                                const text = tags.length > 0
                                    ? `会话 ${sessionId} 的标签已更新：${tags.join('、')}`
                                    : `会话 ${sessionId} 的标签已清空`;
                                return { kind: 'success', text };
                            }
                            catch {
                                return { kind: 'error', text: '更新标签失败，请稍后重试' };
                            }
                        },
                    }),
                ];
                return () => {
                    for (const dispose of [...disposers].reverse())
                        dispose();
                };
            }, 'companion-search.register');
        }
        catch {
            // 等待存储域期间插件已被卸载（INACTIVE_EFFECT），放弃注册。
        }
    })();
}
/**
 * 解析时间参数：兼容毫秒时间戳与 YYYY-MM-DD。
 * 日期按北京时间解释：from 取当日零点，to 取当日 23:59:59.999（闭区间）。
 * 日期解析后回验历法合法性（getUTCMonth/getUTCDate 与输入一致），
 * 拒绝 2024-13-40 这类会被 Date 静默规范化的非法日期。
 */
function parseTimeParam(value, edge) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed))
        return Number(trimmed);
    const matched = DAY_PATTERN.exec(trimmed);
    if (matched) {
        const year = Number(matched[1]);
        const month = Number(matched[2]);
        const day = Number(matched[3]);
        const probe = new Date(Date.UTC(year, month - 1, day));
        if (probe.getUTCFullYear() !== year ||
            probe.getUTCMonth() !== month - 1 ||
            probe.getUTCDate() !== day) {
            throw new HttpError(`时间参数不是合法日期：${value}`);
        }
        const utcMidnight = Date.UTC(year, month - 1, day);
        const dayStart = utcMidnight - BEIJING_OFFSET_MS;
        return edge === 'start' ? dayStart : dayStart + DAY_MS - 1;
    }
    throw new HttpError(`时间参数必须是毫秒时间戳或 YYYY-MM-DD：${value}`);
}
/** 解析 GET /search 的查询参数。 */
function parseSearchParams(query) {
    const params = {};
    const queryText = query.get('query');
    if (queryText && queryText.trim().length > 0)
        params.query = queryText.trim();
    const from = query.get('from');
    if (from !== null && from.length > 0)
        params.from = parseTimeParam(from, 'start');
    const to = query.get('to');
    if (to !== null && to.length > 0)
        params.to = parseTimeParam(to, 'end');
    const tags = query.get('tags');
    if (tags !== null && tags.length > 0) {
        params.tags = tags
            .split(',')
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0);
    }
    const limit = query.get('limit');
    if (limit !== null && limit.length > 0) {
        const parsed = Number(limit);
        if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new HttpError('limit 必须是正整数');
        }
        params.limit = parsed;
    }
    return params;
}
/** 语义检索/相似会话的缺省返回条数。 */
const DEFAULT_SEMANTIC_LIMIT = 10;
/** 语义检索/相似会话的返回条数上限。 */
const MAX_SEMANTIC_LIMIT = 50;
/**
 * 解析语义检索/相似会话端点的 limit 参数：
 * 缺省取 DEFAULT_SEMANTIC_LIMIT；必须是 1..MAX 的整数，否则 400。
 */
function parseLimitParam(value) {
    if (value === null || value.trim().length === 0)
        return DEFAULT_SEMANTIC_LIMIT;
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_SEMANTIC_LIMIT) {
        throw new HttpError(`limit 必须是 1-${MAX_SEMANTIC_LIMIT} 的整数`);
    }
    return parsed;
}
/** 解析 POST /tags 请求体。 */
function parseTagsBody(body) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError('请求体必须是 JSON 对象');
    }
    const record = body;
    if (typeof record.sessionId !== 'string' || record.sessionId.trim().length === 0) {
        throw new HttpError('sessionId 必填');
    }
    return {
        sessionId: SessionId(record.sessionId.trim()),
        add: parseTagList(record.add, 'add'),
        remove: parseTagList(record.remove, 'remove'),
    };
}
/** 解析 POST /search/rerank 请求体。 */
function parseRerankBody(body) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError('请求体必须是 JSON 对象');
    }
    const record = body;
    const query = typeof record.query === 'string' ? record.query.trim() : '';
    if (query.length === 0)
        throw new HttpError('query 必填');
    const from = record.from !== undefined ? parseTimeParam(String(record.from), 'start') : undefined;
    const to = record.to !== undefined ? parseTimeParam(String(record.to), 'end') : undefined;
    const tags = typeof record.tags === 'string' && record.tags.trim().length > 0
        ? record.tags
            .split(',')
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0)
        : undefined;
    const limitRaw = record.limit;
    const limit = limitRaw === undefined
        ? DEFAULT_SEMANTIC_LIMIT
        : (() => {
            const parsed = Number(limitRaw);
            if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_SEMANTIC_LIMIT) {
                throw new HttpError(`limit 必须是 1-${MAX_SEMANTIC_LIMIT} 的整数`);
            }
            return parsed;
        })();
    const weightRaw = record.clickWeight;
    const clickWeight = weightRaw === undefined
        ? DEFAULT_CLICK_WEIGHT
        : (() => {
            const parsed = Number(weightRaw);
            if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
                throw new HttpError('clickWeight 必须在 0-1 之间');
            }
            return parsed;
        })();
    return { query, from, to, tags, limit, clickWeight };
}
/** 解析 POST /search/click 请求体。 */
function parseClickBody(body) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError('请求体必须是 JSON 对象');
    }
    const record = body;
    const query = typeof record.query === 'string' ? record.query.trim() : '';
    if (query.length === 0)
        throw new HttpError('query 必填');
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
    if (sessionId.length === 0)
        throw new HttpError('sessionId 必填');
    const position = Number(record.position);
    if (!Number.isInteger(position) || position < 1) {
        throw new HttpError('position 必须是从 1 起的正整数（点击位次）');
    }
    return { query, sessionId, position };
}
/** 解析可选的标签字符串数组。 */
function parseTagList(value, field) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new HttpError(`${field} 必须是字符串数组`);
    const tags = [];
    for (const item of value) {
        if (typeof item !== 'string')
            throw new HttpError(`${field} 必须全部为字符串`);
        tags.push(item);
    }
    return tags;
}
// toSafeHttpError 已上移 core/http.ts（全插件唯一权威实现）。
