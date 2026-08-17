import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 执行轨迹分析器视图页（模块 E 客户端 UI，挂载于 conversation.view）：
 * - E1 时间轴：选择会话派生轨迹，横向条形时间轴展示每个节点
 *   （步骤名/耗时/Token 拆分/模型/缓存命中），支持按耗时或 Token 排序定位瓶颈；
 * - E2 异常标注：异常节点红色高亮，hover（title）显示原因与建议；
 * - E3 轨迹对比：选择两个会话对比差异，可导出 HTML 对比报告；
 * - E4 统计面板：汇总指标 + 近 14 天趋势（纯 div 条形图）+ 基准线对比。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Select, Spinner, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { deriveTrace, diffTraces, downloadBlob, fetchTraceSessions, fetchTraceStats, } from '../api.js';
import styles from './TraceAnalyzerView.module.css';
/** 毫秒 → 可读时长。 */
function formatDuration(ms) {
    if (ms < 1000)
        return `${ms}ms`;
    if (ms < 60_000)
        return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
/** 节点类别中文标签。 */
function kindLabel(kind) {
    switch (kind) {
        case 'tool':
            return '工具';
        case 'agent':
            return '子Agent';
        case 'model':
            return '模型';
        default:
            return '步骤';
    }
}
/** 执行轨迹分析器视图页。 */
export function TraceAnalyzerView(props) {
    const [sessions, setSessions] = useState([]);
    const [selectedSession, setSelectedSession] = useState(props.sessionId ?? '');
    const [analysis, setAnalysis] = useState();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [sortMode, setSortMode] = useState('time');
    // 对比（E3）
    const [compareSession, setCompareSession] = useState('');
    const [diffEntries, setDiffEntries] = useState();
    const [diffLoading, setDiffLoading] = useState(false);
    // 统计面板（E4）
    const [stats, setStats] = useState();
    // 卸载守卫 + 请求序号：防止过期响应覆盖新结果、卸载后 setState。
    const mountedRef = useRef(true);
    const analyzeSeq = useRef(0);
    const diffSeq = useRef(0);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    // 加载可分析会话列表
    useEffect(() => {
        let cancelled = false;
        fetchTraceSessions()
            .then((response) => {
            if (!cancelled)
                setSessions(response.sessions);
        })
            .catch((err) => {
            if (!cancelled)
                setError(err instanceof Error ? err.message : '会话列表加载失败');
        });
        return () => {
            cancelled = true;
        };
    }, []);
    // 加载近 14 天统计趋势
    useEffect(() => {
        let cancelled = false;
        const to = new Date();
        const from = new Date(to.getTime() - 13 * 86_400_000);
        const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        fetchTraceStats({ from: fmt(from), to: fmt(to) })
            .then((response) => {
            if (!cancelled)
                setStats(response);
        })
            .catch(() => {
            // 趋势加载失败不阻塞主功能。
        });
        return () => {
            cancelled = true;
        };
    }, []);
    /** 分析选中会话（E1/E2）。请求序号守卫：过期响应直接丢弃。 */
    const analyze = useCallback(() => {
        if (!selectedSession)
            return;
        const seq = ++analyzeSeq.current;
        setLoading(true);
        setError('');
        setAnalysis(undefined);
        setDiffEntries(undefined);
        deriveTrace(selectedSession)
            .then((response) => {
            if (!mountedRef.current || seq !== analyzeSeq.current)
                return;
            setAnalysis(response);
        })
            .catch((err) => {
            if (!mountedRef.current || seq !== analyzeSeq.current)
                return;
            setError(err instanceof Error ? err.message : '轨迹分析失败');
        })
            .finally(() => {
            if (mountedRef.current && seq === analyzeSeq.current)
                setLoading(false);
        });
    }, [selectedSession]);
    /** 与对比会话做差异分析（E3）。请求序号守卫：过期响应直接丢弃。 */
    const runDiff = useCallback(async () => {
        if (!selectedSession || !compareSession)
            return;
        const seq = ++diffSeq.current;
        setDiffLoading(true);
        setError('');
        try {
            const response = await diffTraces({
                old: { sessionId: selectedSession },
                new: { sessionId: compareSession },
            });
            if (mountedRef.current && seq === diffSeq.current && response.format === 'json') {
                setDiffEntries(response.entries);
            }
        }
        catch (err) {
            if (mountedRef.current && seq === diffSeq.current) {
                setError(err instanceof Error ? err.message : '轨迹对比失败');
            }
        }
        finally {
            if (mountedRef.current && seq === diffSeq.current)
                setDiffLoading(false);
        }
    }, [selectedSession, compareSession]);
    /** 导出 HTML 对比报告。 */
    const exportDiffHtml = useCallback(async () => {
        if (!selectedSession || !compareSession)
            return;
        setDiffLoading(true);
        try {
            const response = await diffTraces({
                old: { sessionId: selectedSession },
                new: { sessionId: compareSession },
                format: 'html',
            });
            if (response.format === 'html') {
                downloadBlob(new Blob([response.html], { type: 'text/html' }), response.fileName);
                Toast.push('对比报告已导出', 'success');
            }
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '导出对比报告失败', 'error');
        }
        finally {
            setDiffLoading(false);
        }
    }, [selectedSession, compareSession]);
    // 时间轴节点排序：time=按开始时间，duration=按耗时降序，tokens=按 Token 降序
    const timelineNodes = (() => {
        if (!analysis)
            return [];
        const nodes = [...analysis.trace.nodes];
        if (sortMode === 'duration')
            nodes.sort((a, b) => b.durationMs - a.durationMs);
        else if (sortMode === 'tokens') {
            nodes.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
        }
        return nodes;
    })();
    const traceSpan = analysis ? Math.max(1, analysis.trace.endedAt - analysis.trace.startedAt) : 1;
    const anomalyNodeIds = new Set(analysis?.anomalies.flatMap((anomaly) => anomaly.nodeIds) ?? []);
    const anomalyByNode = new Map();
    for (const anomaly of analysis?.anomalies ?? []) {
        for (const nodeId of anomaly.nodeIds) {
            anomalyByNode.set(nodeId, `[${anomaly.kind}] ${anomaly.reason}\n建议：${anomaly.suggestion}`);
        }
    }
    const maxDayDuration = Math.max(1, ...(stats?.days.map((day) => day.totalDurationMs) ?? [1]));
    return (_jsxs("div", { className: styles.root, children: [_jsx("h2", { className: styles.title, children: "\u6267\u884C\u8F68\u8FF9\u5206\u6790\u5668" }), _jsxs("div", { className: styles.toolbar, children: [_jsxs(Select, { value: selectedSession, onChange: (event) => setSelectedSession(event.target.value), children: [_jsx("option", { value: "", children: "\u9009\u62E9\u8981\u5206\u6790\u7684\u4F1A\u8BDD\u2026" }), sessions.map((session) => (_jsx("option", { value: session.id, children: session.title || '未命名对话' }, session.id)))] }), _jsx(Button, { variant: "primary", size: "sm", disabled: !selectedSession || loading, onClick: analyze, children: loading ? '分析中…' : '分析轨迹' })] }), error.length > 0 && _jsx("div", { className: styles.error, children: error }), loading && _jsx(Spinner, { label: "\u6B63\u5728\u6D3E\u751F\u5E76\u5206\u6790\u6267\u884C\u8F68\u8FF9\u2026" }), analysis && (_jsxs(_Fragment, { children: [_jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "\u6C47\u603B\u6307\u6807" }), _jsxs("div", { className: styles.statGrid, children: [_jsxs("div", { className: styles.statCard, children: [_jsx("span", { className: styles.statValue, children: formatDuration(analysis.stats.totalDurationMs) }), _jsx("span", { className: styles.statLabel, children: "\u603B\u8017\u65F6" })] }), _jsxs("div", { className: styles.statCard, children: [_jsxs("span", { className: styles.statValue, children: [analysis.stats.totalInputTokens, " / ", analysis.stats.totalOutputTokens] }), _jsx("span", { className: styles.statLabel, children: "\u8F93\u5165 / \u8F93\u51FA Token" })] }), _jsxs("div", { className: styles.statCard, children: [_jsxs("span", { className: styles.statValue, children: [(analysis.stats.cacheHitRate * 100).toFixed(0), "%"] }), _jsx("span", { className: styles.statLabel, children: "\u7F13\u5B58\u547D\u4E2D\u7387" })] }), _jsxs("div", { className: styles.statCard, children: [_jsxs("span", { className: styles.statValue, children: [(analysis.stats.toolSuccessRate * 100).toFixed(0), "%"] }), _jsx("span", { className: styles.statLabel, children: "\u5DE5\u5177\u6210\u529F\u7387" })] }), _jsxs("div", { className: styles.statCard, children: [_jsx("span", { className: styles.statValue, children: analysis.stats.agentDispatches }), _jsx("span", { className: styles.statLabel, children: "\u5B50 Agent \u6D3E\u53D1" })] })] })] }), analysis.anomalies.length > 0 && (_jsxs("section", { className: styles.section, children: [_jsxs("h3", { children: ["\u5F02\u5E38\u6807\u6CE8\uFF08", analysis.anomalies.length, "\uFF09"] }), _jsx("ul", { className: styles.anomalyList, children: analysis.anomalies.map((anomaly, index) => (_jsxs("li", { className: styles.anomalyItem, title: anomaly.suggestion, children: [_jsx("strong", { children: anomaly.kind }), "\uFF1A", anomaly.reason] }, index))) })] })), _jsxs("section", { className: styles.section, children: [_jsxs("div", { className: styles.sectionHeader, children: [_jsxs("h3", { children: ["\u65F6\u95F4\u8F74\uFF08", timelineNodes.length, " \u4E2A\u8282\u70B9\uFF09"] }), _jsxs("div", { className: styles.sortBar, children: [_jsx(Button, { size: "sm", variant: sortMode === 'time' ? 'primary' : 'secondary', onClick: () => setSortMode('time'), children: "\u6309\u65F6\u95F4" }), _jsx(Button, { size: "sm", variant: sortMode === 'duration' ? 'primary' : 'secondary', onClick: () => setSortMode('duration'), children: "\u6700\u6162\u4F18\u5148" }), _jsx(Button, { size: "sm", variant: sortMode === 'tokens' ? 'primary' : 'secondary', onClick: () => setSortMode('tokens'), children: "\u6700\u8D35\u4F18\u5148" })] })] }), timelineNodes.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u8BE5\u4F1A\u8BDD\u6CA1\u6709\u53EF\u89E3\u6790\u7684\u6267\u884C\u6B65\u9AA4\uFF08\u4EC5\u666E\u901A\u5BF9\u8BDD\u6D88\u606F\uFF09\u3002" })) : (_jsx("div", { className: styles.timeline, children: timelineNodes.map((node) => {
                                    const left = sortMode === 'time' ? ((node.startMs - analysis.trace.startedAt) / traceSpan) * 100 : 0;
                                    const width = Math.max(1, (node.durationMs / traceSpan) * 100);
                                    const anomalyTip = anomalyByNode.get(node.id);
                                    const classNames = [
                                        styles.timelineBar,
                                        styles[`kind_${node.kind}`],
                                        anomalyNodeIds.has(node.id) ? styles.anomaly : '',
                                        node.status === 'error' ? styles.statusError : '',
                                    ]
                                        .filter(Boolean)
                                        .join(' ');
                                    return (_jsxs("div", { className: styles.timelineRow, children: [_jsx("span", { className: styles.timelineName, title: node.name, children: node.name }), _jsx("div", { className: styles.timelineTrack, children: _jsx("div", { className: classNames, style: sortMode === 'time'
                                                        ? { left: `${left}%`, width: `${width}%` }
                                                        : { left: '0%', width: `${width}%` }, title: `${kindLabel(node.kind)} · ${formatDuration(node.durationMs)} · 输入 ${node.inputTokens} / 输出 ${node.outputTokens} tokens${node.model ? ` · ${node.model}` : ''}${node.cacheHit ? ' · 缓存命中' : ''}${anomalyTip ? `\n⚠ ${anomalyTip}` : ''}` }) }), _jsxs("span", { className: styles.timelineMeta, children: [formatDuration(node.durationMs), " \u00B7 ", node.inputTokens, "+", node.outputTokens, "t", node.cacheHit ? ' · 缓存' : ''] })] }, node.id));
                                }) }))] }), _jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "\u8F68\u8FF9\u5BF9\u6BD4" }), _jsxs("div", { className: styles.toolbar, children: [_jsxs(Select, { value: compareSession, onChange: (event) => setCompareSession(event.target.value), children: [_jsx("option", { value: "", children: "\u9009\u62E9\u8981\u5BF9\u6BD4\u7684\u4F1A\u8BDD\uFF08\u65B0\uFF09\u2026" }), sessions
                                                .filter((session) => session.id !== selectedSession)
                                                .map((session) => (_jsx("option", { value: session.id, children: session.title || '未命名对话' }, session.id)))] }), _jsx(Button, { size: "sm", variant: "secondary", disabled: !compareSession || diffLoading, onClick: runDiff, children: "\u5BF9\u6BD4" }), _jsx(Button, { size: "sm", variant: "secondary", disabled: !compareSession || diffLoading, onClick: exportDiffHtml, children: "\u5BFC\u51FA HTML \u62A5\u544A" })] }), diffEntries && (_jsxs("table", { className: styles.diffTable, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u6B65\u9AA4" }), _jsx("th", { children: "\u53D8\u5316" }), _jsx("th", { children: "\u8017\u65F6" }), _jsx("th", { children: "Token" })] }) }), _jsx("tbody", { children: diffEntries.map((entry, index) => (_jsxs("tr", { children: [_jsx("td", { children: entry.name }), _jsx("td", { className: styles[`diff_${entry.change}`], children: entry.change === 'added' ? '新增' : entry.change === 'removed' ? '移除' : entry.change === 'changed' ? '变化' : '不变' }), _jsx("td", { children: entry.oldDurationMs !== undefined && entry.newDurationMs !== undefined
                                                        ? `${formatDuration(entry.oldDurationMs)} → ${formatDuration(entry.newDurationMs)}（${(entry.durationDeltaMs ?? 0) >= 0 ? '+' : ''}${entry.durationDeltaMs ?? 0}ms）`
                                                        : entry.oldDurationMs !== undefined
                                                            ? formatDuration(entry.oldDurationMs)
                                                            : entry.newDurationMs !== undefined
                                                                ? formatDuration(entry.newDurationMs)
                                                                : '-' }), _jsx("td", { children: entry.tokenDelta !== undefined
                                                        ? `${entry.oldTokens ?? '-'} → ${entry.newTokens ?? '-'}（${entry.tokenDelta >= 0 ? '+' : ''}${entry.tokenDelta}）`
                                                        : '-' })] }, index))) })] }))] })] })), stats && stats.days.length > 0 && (_jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "\u8FD1 14 \u5929\u8D8B\u52BF" }), _jsx("div", { className: styles.trend, children: stats.days.map((day) => (_jsxs("div", { className: styles.trendCol, title: `${day.day}：${day.traceCount} 条轨迹，总耗时 ${formatDuration(day.totalDurationMs)}，异常 ${day.anomalyCount} 项`, children: [_jsx("div", { className: styles.trendBar, style: { height: `${Math.max(4, (day.totalDurationMs / maxDayDuration) * 100)}%` } }), _jsx("span", { className: styles.trendLabel, children: day.day.slice(5) })] }, day.day))) }), stats.baseline && (_jsxs("p", { className: styles.baseline, children: ["\u5386\u53F2\u57FA\u51C6\uFF1A\u5E73\u5747\u8017\u65F6 ", formatDuration(stats.baseline.avgDurationMs), " \u00B7 \u5E73\u5747 Token", ' ', Math.round(stats.baseline.avgTokens), " \u00B7 \u5E73\u5747\u5F02\u5E38 ", stats.baseline.avgAnomalies, " \u9879/\u8F68\u8FF9"] }))] }))] }));
}
