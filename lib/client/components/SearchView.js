import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 全局对话检索视图页（模块 D 客户端 UI，挂载于 conversation.view）：
 * - 顶部全局搜索框（防抖 300ms）+ 检索模式切换（关键词 / 语义）+ 日期范围（两个
 *   type=date 输入，仅关键词模式生效）+ 标签筛选（GET /tags 全量标签，Pill 可点击，
 *   仅关键词模式生效）；
 * - 关键词模式：GET /search 词面检索（既有流程）；
 * - 语义模式（创新扩展）：GET /search/semantic —— 字符 shingle 邻域 + PRF 查询扩展
 *   + RRF 融合；结果区顶部展示扩展词行（term + weight，按 weight 降序）与扫描会话数，
 *   每条命中附带 RRF 分、邻域相似度与扩展词命中标签；
 * - 语义模式下每个命中可“找相似”（GET /search/similar）：以折叠区展示相似会话的
 *   相似度、共有词与标签；
 * - 点击结果派发 `companion:open-session` 自定义事件请求主平台跳转（集成缝，见下注）；
 * - “加载更多”通过递增 limit 实现分页。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Pill, Spinner, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { fetchAllTags, fetchSimilarSessions, searchSessions, searchSessionsSemantic } from '../api.js';
import styles from './SearchView.module.css';
/** 每次“加载更多”递增的条数。 */
const PAGE_SIZE = 50;
/** 搜索输入防抖时长（毫秒）。 */
const DEBOUNCE_MS = 300;
/** “找相似”固定拉取的相似会话条数。 */
const SIMILAR_LIMIT = 10;
/** 毫秒时间戳 → 本地可读日期时间。 */
function formatTime(ts) {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
/** 0-1 比例 → 整数百分比文案（如 0.873 → “87%”）。 */
function formatPercent(value) {
    return `${Math.round(value * 100)}%`;
}
/** 语义检索结果摘要：PRF 扩展词行（term + weight 降序）+ 扫描会话数小字。 */
function SemanticSummary(props) {
    // 扩展词按 weight 降序展示（weight 保留 3 位小数）
    const terms = [...props.result.expansionTerms].sort((a, b) => b.weight - a.weight);
    return (_jsxs("div", { className: styles.semanticPanel, children: [_jsxs("div", { className: styles.semanticExpansion, children: [_jsx("span", { className: styles.semanticExpansionLabel, children: "PRF \u67E5\u8BE2\u6269\u5C55\u8BCD\uFF08\u6765\u81EA\u90BB\u57DF\u6587\u6863\uFF09" }), terms.length === 0 ? (_jsx("span", { className: styles.muted, children: "\u672C\u6B21\u672A\u4EA7\u751F\u6269\u5C55\u8BCD" })) : (terms.map((item) => (_jsxs("span", { className: styles.semanticExpansionItem, children: [_jsx(Pill, { className: styles.semanticExpansionTerm, children: item.term }), _jsx("span", { className: styles.semanticExpansionWeight, children: item.weight.toFixed(3) })] }, item.term))))] }), _jsxs("span", { className: styles.semanticScanned, children: ["\u672C\u6B21\u626B\u63CF ", props.result.scannedSessions, " \u4E2A\u4F1A\u8BDD"] })] }));
}
/** 单条命中的“找相似”结果折叠区：相似度百分比 + 共有词 Pill + 标签。 */
function SimilarSessionsBox(props) {
    return (_jsxs("div", { className: styles.similarBox, children: [_jsxs("div", { className: styles.similarHead, children: [_jsx("span", { className: styles.similarTitle, children: "\u76F8\u4F3C\u4F1A\u8BDD" }), props.scanned > 0 ? _jsxs("span", { className: styles.semanticScanned, children: ["\u626B\u63CF ", props.scanned, " \u4E2A\u4F1A\u8BDD"] }) : null, _jsx(Button, { size: "sm", variant: "ghost", onClick: props.onClose, children: "\u6536\u8D77" })] }), props.error ? _jsx("span", { className: styles.error, children: props.error }) : null, props.loading ? (_jsx(Spinner, { label: "\u67E5\u627E\u76F8\u4F3C\u4F1A\u8BDD\u2026" })) : !props.error && props.hits.length === 0 ? (_jsx("span", { className: styles.muted, children: "\u6CA1\u6709\u627E\u5230\u76F8\u4F3C\u4F1A\u8BDD" })) : (props.hits.map((item) => (_jsxs(Button, { variant: "ghost", className: styles.similarItem, onClick: () => props.onOpen(item.session.id), children: [_jsxs("span", { className: styles.resultHead, children: [_jsx("span", { className: styles.resultTitle, children: item.session.title ?? `会话 ${item.session.id}` }), _jsxs(Pill, { className: styles.semanticSimPill, children: ["\u76F8\u4F3C\u5EA6 ", formatPercent(item.similarity)] })] }), item.sharedTerms.length > 0 ? (_jsxs("span", { className: styles.semanticMatched, children: [_jsx("span", { className: styles.semanticMatchedLabel, children: "\u5171\u6709\u8BCD" }), item.sharedTerms.map((term) => (_jsx(Pill, { className: styles.semanticMatchedTerm, children: term }, term)))] })) : null, item.tags.length > 0 ? (_jsx("span", { className: styles.resultTags, children: item.tags.map((tag) => (_jsx(Pill, { className: styles.resultTag, children: tag }, tag))) })) : null] }, item.session.id))))] }));
}
/** 全局对话检索视图页。 */
export function SearchView(_props) {
    const [mode, setMode] = useState('keyword');
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [allTags, setAllTags] = useState([]);
    const [tagsError, setTagsError] = useState('');
    const [selectedTags, setSelectedTags] = useState(new Set());
    const [hits, setHits] = useState([]);
    const [semanticResult, setSemanticResult] = useState(null);
    const [limit, setLimit] = useState(PAGE_SIZE);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    // “找相似”状态：similarFor 为当前展开相似折叠区的命中会话 id
    const [similarFor, setSimilarFor] = useState(null);
    const [similarLoading, setSimilarLoading] = useState(false);
    const [similarHits, setSimilarHits] = useState([]);
    const [similarScanned, setSimilarScanned] = useState(0);
    const [similarError, setSimilarError] = useState('');
    /** 日期区间本地校验：YYYY-MM-DD 格式可直接按字典序比较，from 晚于 to 时不发请求。 */
    const rangeInvalid = from.length > 0 && to.length > 0 && from > to;
    /** 当前模式的命中条数（空态与“加载更多”的显隐判断共用）。 */
    const activeCount = mode === 'semantic' ? semanticResult?.hits.length ?? 0 : hits.length;
    // 搜索框防抖：停止输入 300ms 后才触发检索
    useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [query]);
    // 挂载时拉取全量标签（GET /tags 缺省 sessionId 返回 标签 → 会话列表 映射）
    useEffect(() => {
        let cancelled = false;
        fetchAllTags()
            .then((response) => {
            if (!cancelled)
                setAllTags(Object.keys(response.tags));
        })
            .catch((err) => {
            if (!cancelled)
                setTagsError(err instanceof Error ? err.message : '标签加载失败');
        });
        return () => {
            cancelled = true;
        };
    }, []);
    // 检索模式 / 条件或 limit 变化时重新请求（selectedTags 每次切换都是新 Set，引用变化即触发）
    useEffect(() => {
        // 日期区间仅关键词模式生效：from 晚于 to 时仅本地提示，不发起请求
        if (mode === 'keyword' && rangeInvalid) {
            setHits([]);
            setError('起始日期不能晚于结束日期，请调整日期区间');
            setLoading(false);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError('');
        // 语义模式：复用同一搜索框与防抖查询；接口必须携带 query，空查询不发请求
        if (mode === 'semantic') {
            const trimmed = debouncedQuery.trim();
            if (trimmed.length === 0) {
                setSemanticResult(null);
                setLoading(false);
                return;
            }
            searchSessionsSemantic({ query: trimmed, limit })
                .then((response) => {
                if (!cancelled)
                    setSemanticResult(response);
            })
                .catch((err) => {
                if (!cancelled)
                    setError(err instanceof Error ? err.message : '语义检索失败');
            })
                .finally(() => {
                if (!cancelled)
                    setLoading(false);
            });
            return () => {
                cancelled = true;
            };
        }
        // 关键词模式：清空语义态，走既有 GET /search 词面检索流程
        setSemanticResult(null);
        searchSessions({
            query: debouncedQuery.trim() || undefined,
            from: from || undefined,
            to: to || undefined,
            tags: [...selectedTags],
            limit,
        })
            .then((response) => {
            if (!cancelled)
                setHits(response.hits);
        })
            .catch((err) => {
            if (!cancelled)
                setError(err instanceof Error ? err.message : '检索失败');
        })
            .finally(() => {
            if (!cancelled)
                setLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, [mode, debouncedQuery, from, to, selectedTags, limit, rangeInvalid]);
    /** 点击结果项：请求主平台跳转到该会话。
     *
     * 集成缝说明：主平台客户端监听 `companion:open-session` 自定义事件完成会话切换；
     * 插件不直接依赖平台内部导航 API，事件即两者之间唯一的导航契约（见 DESIGN.md 第 6 节）。
     */
    const openSession = useCallback((sessionId) => {
        window.dispatchEvent(new CustomEvent('companion:open-session', { detail: { sessionId } }));
        Toast.push('已发送跳转请求', 'info');
    }, []);
    /** 切换标签筛选（点击 Pill）。 */
    const toggleTag = useCallback((tag) => {
        setSelectedTags((prev) => {
            const next = new Set(prev);
            if (next.has(tag))
                next.delete(tag);
            else
                next.add(tag);
            return next;
        });
        setLimit(PAGE_SIZE);
    }, []);
    /** 更新查询词并重置分页。 */
    const handleQueryChange = useCallback((value) => {
        setQuery(value);
        setLimit(PAGE_SIZE);
    }, []);
    /** 更新起始日期并重置分页。 */
    const handleFromChange = useCallback((value) => {
        setFrom(value);
        setLimit(PAGE_SIZE);
    }, []);
    /** 更新结束日期并重置分页。 */
    const handleToChange = useCallback((value) => {
        setTo(value);
        setLimit(PAGE_SIZE);
    }, []);
    /** 切换检索模式：重置分页并收起“找相似”折叠区（查询词保留）。 */
    const handleModeChange = useCallback((next) => {
        setMode(next);
        setLimit(PAGE_SIZE);
        setSimilarFor(null);
        setSimilarHits([]);
        setSimilarScanned(0);
        setSimilarError('');
    }, []);
    /** 展开/收起某命中的“找相似”折叠区；展开时调 GET /search/similar 拉取。 */
    const toggleSimilar = useCallback((sessionId) => {
        if (similarFor === sessionId) {
            setSimilarFor(null);
            return;
        }
        setSimilarFor(sessionId);
        setSimilarHits([]);
        setSimilarScanned(0);
        setSimilarError('');
        setSimilarLoading(true);
        fetchSimilarSessions({ sessionId, limit: SIMILAR_LIMIT })
            .then((response) => {
            setSimilarHits(response.hits);
            setSimilarScanned(response.scannedSessions);
        })
            .catch((err) => {
            setSimilarError(err instanceof Error ? err.message : '相似会话查询失败');
        })
            .finally(() => setSimilarLoading(false));
    }, [similarFor]);
    return (_jsxs("div", { className: styles.view, children: [_jsxs("header", { className: styles.toolbar, children: [_jsxs("div", { className: styles.modeSwitch, role: "group", "aria-label": "\u68C0\u7D22\u6A21\u5F0F", children: [_jsx(Button, { size: "sm", variant: mode === 'keyword' ? 'primary' : 'secondary', onClick: () => handleModeChange('keyword'), children: "\u5173\u952E\u8BCD" }), _jsx(Button, { size: "sm", variant: mode === 'semantic' ? 'primary' : 'secondary', onClick: () => handleModeChange('semantic'), children: "\u8BED\u4E49" })] }), _jsx(Input, { className: styles.searchInput, type: "search", value: query, onChange: (event) => handleQueryChange(event.target.value), placeholder: mode === 'semantic' ? '语义检索历史对话（shingle 邻域 + PRF 扩展）…' : '全局检索历史对话…' }), mode === 'keyword' ? (_jsxs(_Fragment, { children: [_jsxs("label", { className: styles.dateField, children: [_jsx("span", { children: "\u4ECE" }), _jsx(Input, { type: "date", value: from, onChange: (event) => handleFromChange(event.target.value) })] }), _jsxs("label", { className: styles.dateField, children: [_jsx("span", { children: "\u81F3" }), _jsx(Input, { type: "date", value: to, onChange: (event) => handleToChange(event.target.value) })] }), rangeInvalid ? _jsx("span", { className: styles.error, children: "\u8D77\u59CB\u65E5\u671F\u4E0D\u80FD\u665A\u4E8E\u7ED3\u675F\u65E5\u671F" }) : null] })) : null] }), mode === 'semantic' ? (_jsx("p", { className: styles.semanticHint, children: "\u8BED\u4E49\u68C0\u7D22\u57FA\u4E8E\u5B57\u7B26 shingle \u90BB\u57DF + PRF \u67E5\u8BE2\u6269\u5C55 + RRF \u878D\u5408\uFF0C\u65E0\u9700\u5411\u91CF\u5E93\uFF1B\u90BB\u57DF\u7D22\u5F15\u8986\u76D6\u6700\u8FD1 200 \u4E2A\u4F1A\u8BDD" })) : null, mode === 'keyword' ? (_jsxs("div", { className: styles.tagRow, children: [tagsError ? _jsx("span", { className: styles.error, children: tagsError }) : null, !tagsError && allTags.length === 0 ? _jsx("span", { className: styles.muted, children: "\u6682\u65E0\u6807\u7B7E" }) : null, allTags.map((tag) => (_jsx("span", { role: "button", tabIndex: 0, "aria-pressed": selectedTags.has(tag), onClick: () => toggleTag(tag), onKeyDown: (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                toggleTag(tag);
                            }
                        }, children: _jsx(Pill, { className: selectedTags.has(tag) ? styles.tagActive : styles.tag, children: tag }) }, tag)))] })) : null, _jsxs("div", { className: styles.results, children: [mode === 'semantic' && semanticResult !== null ? _jsx(SemanticSummary, { result: semanticResult }) : null, loading && activeCount === 0 ? _jsx(Spinner, { label: "\u68C0\u7D22\u4E2D\u2026" }) : null, error ? _jsx("div", { className: styles.error, children: error }) : null, !loading && !error && activeCount === 0 ? (_jsx("div", { className: styles.empty, children: mode === 'semantic'
                            ? debouncedQuery.trim().length === 0
                                ? '输入关键词开始语义检索'
                                : '没有语义相关的对话，试试换个说法或关键词'
                            : '没有匹配的对话，试试调整关键词、日期或标签' })) : null, mode === 'keyword'
                        ? hits.map((hit) => (_jsxs(Button, { variant: "ghost", className: styles.resultItem, onClick: () => openSession(hit.session.id), children: [_jsxs("span", { className: styles.resultHead, children: [_jsx("span", { className: styles.resultTitle, children: hit.session.title ?? `会话 ${hit.session.id}` }), _jsx("span", { className: styles.resultTime, children: formatTime(hit.session.updatedAt ?? hit.session.createdAt) })] }), hit.snippet ? _jsx("span", { className: styles.resultSnippet, children: hit.snippet }) : null, hit.tags.length > 0 ? (_jsx("span", { className: styles.resultTags, children: hit.tags.map((tag) => (_jsx(Pill, { className: styles.resultTag, children: tag }, tag))) })) : null] }, hit.session.id)))
                        : (semanticResult?.hits ?? []).map((hit) => (_jsxs("div", { className: styles.semanticItem, children: [_jsxs(Button, { variant: "ghost", className: styles.resultItem, onClick: () => openSession(hit.session.id), children: [_jsxs("span", { className: styles.resultHead, children: [_jsx("span", { className: styles.resultTitle, children: hit.session.title ?? `会话 ${hit.session.id}` }), _jsxs("span", { className: styles.resultTime, children: [_jsxs("span", { className: styles.semanticBadges, children: [_jsxs("span", { className: styles.semanticScore, children: ["RRF ", hit.score.toFixed(3)] }), hit.neighborhoodSimilarity > 0 ? (_jsxs(Pill, { className: styles.semanticSimPill, children: ["\u90BB\u57DF ", formatPercent(hit.neighborhoodSimilarity)] })) : null] }), formatTime(hit.session.updatedAt ?? hit.session.createdAt)] })] }), hit.snippet ? _jsx("span", { className: styles.resultSnippet, children: hit.snippet }) : null, hit.tags.length > 0 ? (_jsx("span", { className: styles.resultTags, children: hit.tags.map((tag) => (_jsx(Pill, { className: styles.resultTag, children: tag }, tag))) })) : null, hit.matchedExpansionTerms.length > 0 ? (_jsxs("span", { className: styles.semanticMatched, children: [_jsx("span", { className: styles.semanticMatchedLabel, children: "\u6269\u5C55\u8BCD\u547D\u4E2D" }), hit.matchedExpansionTerms.map((term) => (_jsx(Pill, { className: styles.semanticMatchedTerm, children: term }, term)))] })) : null] }), _jsx("div", { className: styles.semanticItemBar, children: _jsx(Button, { size: "sm", variant: "secondary", disabled: similarLoading && similarFor === hit.session.id, onClick: () => toggleSimilar(hit.session.id), children: similarLoading && similarFor === hit.session.id ? (_jsx(Spinner, { label: "\u67E5\u627E\u4E2D\u2026" })) : similarFor === hit.session.id ? ('收起相似') : ('找相似') }) }), similarFor === hit.session.id ? (_jsx(SimilarSessionsBox, { loading: similarLoading, hits: similarHits, scanned: similarScanned, error: similarError, onClose: () => setSimilarFor(null), onOpen: openSession })) : null] }, hit.session.id))), loading && activeCount > 0 ? _jsx(Spinner, { label: "\u52A0\u8F7D\u66F4\u591A\u2026" }) : null, !loading && !error && activeCount >= limit ? (_jsx("div", { className: styles.more, children: _jsx(Button, { variant: "secondary", onClick: () => setLimit((prev) => prev + PAGE_SIZE), children: "\u52A0\u8F7D\u66F4\u591A" }) })) : null] })] }));
}
