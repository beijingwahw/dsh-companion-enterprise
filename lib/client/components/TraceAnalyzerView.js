import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 执行轨迹分析器视图页（模块 E 客户端 UI，挂载于 conversation.view）：
 * - E1 时间轴：选择会话派生轨迹，横向条形时间轴展示每个节点
 *   （步骤名/耗时/Token 拆分/模型/缓存命中），支持按耗时或 Token 排序定位瓶颈；
 * - E2 异常标注：异常节点红色高亮，hover（title）显示原因与建议；
 * - E3 轨迹对比：选择两个会话对比差异，可导出 HTML 对比报告；
 * - E4 统计面板：汇总指标 + 近 14 天趋势（纯 div 条形图）+ 基准线对比；
 * - E5 SPC 控制图：EWMA + Western Electric 规则监控指标漂移（纯 SVG 绘制，
 *   支持指标/λ/限宽参数与三档判级横幅，GET /trace/spc）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Pill, Select, Spinner, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { deriveTrace, diffTraces, downloadBlob, fetchTraceSessions, fetchTraceSpc, fetchTraceStats, } from '../api.js';
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
// ---------------------------------------------------------------------
// E5 SPC 控制图（模块 E 创新扩展）
// ---------------------------------------------------------------------
/** SPC 查询区间（天）：视图无既有日期区间状态，固定近 28 天。 */
const SPC_RANGE_DAYS = 28;
/** SPC 控制图高度（SVG viewBox 高度，px）。 */
const SPC_CHART_HEIGHT = 220;
/** SPC 控制图四边留白（px）：左侧留给 y 轴刻度、底部留给日期标签。 */
const SPC_CHART_PAD = { top: 14, right: 16, bottom: 30, left: 56 };
/** SPC 指标下拉选项（value 对应 SpcMetric，label 为中文说明）。 */
const SPC_METRIC_OPTIONS = [
    { value: 'duration-per-trace', label: '单轮耗时' },
    { value: 'tokens-per-trace', label: '单轮 Token' },
    { value: 'anomaly-rate', label: '异常率' },
    { value: 'cache-hit-rate', label: '缓存命中率' },
    { value: 'tool-success-rate', label: '工具成功率' },
];
/** SPC 判级元数据：三档 verdict（受控/轻微异常/失控）的展示文案与样式类。 */
const SPC_VERDICT_META = {
    stable: { text: '受控', banner: styles.spcBannerStable, badge: styles.spcOkBadge },
    warning: { text: '轻微异常', banner: styles.spcBannerWarning, badge: styles.spcWarnBadge },
    'out-of-control': { text: '失控', banner: styles.spcBannerOoc, badge: styles.spcBadBadge },
};
/** 计算近 N 天的 [from, to] 日期区间（YYYY-MM-DD，本地时区近似）。 */
function rangeOfDays(days) {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { from: fmt(from), to: fmt(to) };
}
/** SPC 查询区间（模块级常量：各次分析复用同一近 28 天区间）。 */
const SPC_RANGE = rangeOfDays(SPC_RANGE_DAYS);
/** SPC 指标值格式化：比率类显示百分比，耗时显示毫秒，Token 取整。 */
function formatSpcValue(metric, value) {
    if (metric === 'duration-per-trace')
        return `${Math.round(value)}ms`;
    if (metric === 'tokens-per-trace')
        return `${Math.round(value).toLocaleString('zh-CN')}`;
    return `${(value * 100).toFixed(2)}%`;
}
/**
 * SPC 控制图（纯 SVG 绘制，不依赖图表库）：
 * - value（细线）/ EWMA（粗线，主序列）/ ucl、lcl（虚线，随每日限宽收敛可呈折线）；
 * - 中心线画水平点线；越限点标圆点（劣化侧红、改善侧橙）；
 * - y 轴取全部序列 min/max 加 10% padding；悬停 title 显示日期/值/EWMA/上下限。
 */
function SpcChart(props) {
    const { points, center, metric } = props;
    const n = points.length;
    // 画布几何：宽度随点数自适应（每点至少 44px），高度固定 220。
    const plotWidth = Math.max(560, n * 44);
    const width = SPC_CHART_PAD.left + plotWidth + SPC_CHART_PAD.right;
    const height = SPC_CHART_HEIGHT;
    const plotTop = SPC_CHART_PAD.top;
    const plotBottom = height - SPC_CHART_PAD.bottom;
    const plotHeight = plotBottom - plotTop;
    // y 轴范围：全部序列（value/EWMA/ucl/lcl）的 min/max 加 10% padding；
    // 全平序列（span=0）时按量级取 10% 作最小 padding，避免除零。
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const point of points) {
        for (const value of [point.value, point.ewma, point.ucl, point.lcl]) {
            if (value < lo)
                lo = value;
            if (value > hi)
                hi = value;
        }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        lo = 0;
        hi = 1;
    }
    const span = hi - lo;
    const pad = span > 0 ? span * 0.1 : Math.max(Math.abs(hi) * 0.1, 1);
    lo -= pad;
    hi += pad;
    const yOf = (value) => plotTop + (1 - (value - lo) / (hi - lo)) * plotHeight;
    const xOf = (index) => SPC_CHART_PAD.left + (n <= 1 ? plotWidth / 2 : (index / (n - 1)) * plotWidth);
    /** 序列取值函数 → SVG 折线 path（M/L）。 */
    const pathOf = (select) => points
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(1)} ${yOf(select(point)).toFixed(1)}`)
        .join(' ');
    // 悬停命中区：每日一列（列宽 = 步长，最小 8px，首尾列向边缘拉伸）。
    const hitWidth = Math.max(8, plotWidth / Math.max(1, n));
    const hitX = (index) => Math.min(Math.max(SPC_CHART_PAD.left, xOf(index) - hitWidth / 2), SPC_CHART_PAD.left + plotWidth - hitWidth);
    // x 轴日期标签抽稀：最多约 14 个，避免重叠。
    const labelStep = n <= 14 ? 1 : Math.ceil(n / 14);
    // y 轴参考网格（上/中/下）与对应刻度值。
    const gridYs = [plotTop, plotTop + plotHeight / 2, plotBottom];
    const gridValues = [hi, (hi + lo) / 2, lo];
    return (_jsxs("svg", { className: styles.spcChart, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "SPC \u63A7\u5236\u56FE", children: [gridYs.map((y, index) => (_jsx("line", { x1: SPC_CHART_PAD.left, y1: y, x2: SPC_CHART_PAD.left + plotWidth, y2: y, className: styles.spcGrid }, `grid-${index}`))), gridYs.map((y, index) => (_jsx("text", { x: SPC_CHART_PAD.left - 6, y: y + 3, textAnchor: "end", className: styles.spcAxisText, children: formatSpcValue(metric, gridValues[index]) }, `ytick-${index}`))), _jsx("path", { d: pathOf((point) => point.ucl), className: styles.spcLineLimit }), _jsx("path", { d: pathOf((point) => point.lcl), className: styles.spcLineLimit }), _jsx("line", { x1: SPC_CHART_PAD.left, y1: yOf(center), x2: SPC_CHART_PAD.left + plotWidth, y2: yOf(center), className: styles.spcLineCenter }), _jsx("path", { d: pathOf((point) => point.value), className: styles.spcLineValue }), _jsx("path", { d: pathOf((point) => point.ewma), className: styles.spcLineEwma }), points.map((point, index) => point.violation ? (_jsx("circle", { cx: xOf(index), cy: yOf(point.ewma), r: 4, className: point.badSide ? styles.spcDotBad : styles.spcDotWarn }, `violation-${point.day}`)) : null), points.map((point, index) => index % labelStep === 0 ? (_jsx("text", { x: xOf(index), y: height - 8, textAnchor: "middle", className: styles.spcAxisText, children: point.day.slice(5) }, `xlabel-${point.day}`)) : null), points.map((point, index) => (_jsx("rect", { x: hitX(index), y: plotTop, width: hitWidth, height: plotHeight, className: styles.spcHover, children: _jsxs("title", { children: [`${point.day}：值 ${formatSpcValue(metric, point.value)} / EWMA ${formatSpcValue(metric, point.ewma)} / 上限 ${formatSpcValue(metric, point.ucl)} / 下限 ${formatSpcValue(metric, point.lcl)}`, point.violation ? `（越限${point.badSide ? '，劣化侧' : '，改善侧'}）` : ''] }) }, `hit-${point.day}`)))] }));
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
    // SPC 控制图（E5 创新扩展）
    const [spcMetric, setSpcMetric] = useState('duration-per-trace');
    const [spcLambdaInput, setSpcLambdaInput] = useState('0.3');
    const [spcLimitInput, setSpcLimitInput] = useState('3');
    const [spc, setSpc] = useState();
    const [spcLoading, setSpcLoading] = useState(false);
    const [spcError, setSpcError] = useState('');
    // 卸载守卫 + 请求序号：防止过期响应覆盖新结果、卸载后 setState。
    const mountedRef = useRef(true);
    const analyzeSeq = useRef(0);
    const diffSeq = useRef(0);
    const spcSeq = useRef(0);
    /** 挂载预载守卫：SPC 首次分析只执行一次。 */
    const spcInitRef = useRef(false);
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
    /** 执行 SPC 控制图分析（E5）：校验 λ 与限宽后请求 /trace/spc；序号守卫丢弃过期响应。 */
    const runSpc = useCallback(async () => {
        const lambda = Number(spcLambdaInput);
        const limitWidth = Number(spcLimitInput);
        if (!Number.isFinite(lambda) || lambda < 0.05 || lambda > 0.95) {
            Toast.push('λ 需为 0.05~0.95 之间的数值', 'warning');
            return;
        }
        if (!Number.isFinite(limitWidth) || limitWidth < 1 || limitWidth > 5) {
            Toast.push('控制限宽度需为 1~5 之间的数值', 'warning');
            return;
        }
        const seq = ++spcSeq.current;
        setSpcLoading(true);
        setSpcError('');
        try {
            const response = await fetchTraceSpc({
                from: SPC_RANGE.from,
                to: SPC_RANGE.to,
                metric: spcMetric,
                lambda,
                limitWidth,
            });
            if (mountedRef.current && seq === spcSeq.current)
                setSpc(response);
        }
        catch (err) {
            if (mountedRef.current && seq === spcSeq.current) {
                setSpcError(err instanceof Error ? err.message : 'SPC 分析失败');
            }
        }
        finally {
            if (mountedRef.current && seq === spcSeq.current)
                setSpcLoading(false);
        }
    }, [spcMetric, spcLambdaInput, spcLimitInput]);
    // 挂载时按缺省参数预载一次 SPC 控制图（ref 守卫确保只执行一次）。
    useEffect(() => {
        if (spcInitRef.current)
            return;
        spcInitRef.current = true;
        void runSpc();
    }, [runSpc]);
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
                                                        : '-' })] }, index))) })] }))] })] })), stats && stats.days.length > 0 && (_jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "\u8FD1 14 \u5929\u8D8B\u52BF" }), _jsx("div", { className: styles.trend, children: stats.days.map((day) => (_jsxs("div", { className: styles.trendCol, title: `${day.day}：${day.traceCount} 条轨迹，总耗时 ${formatDuration(day.totalDurationMs)}，异常 ${day.anomalyCount} 项`, children: [_jsx("div", { className: styles.trendBar, style: { height: `${Math.max(4, (day.totalDurationMs / maxDayDuration) * 100)}%` } }), _jsx("span", { className: styles.trendLabel, children: day.day.slice(5) })] }, day.day))) }), stats.baseline && (_jsxs("p", { className: styles.baseline, children: ["\u5386\u53F2\u57FA\u51C6\uFF1A\u5E73\u5747\u8017\u65F6 ", formatDuration(stats.baseline.avgDurationMs), " \u00B7 \u5E73\u5747 Token", ' ', Math.round(stats.baseline.avgTokens), " \u00B7 \u5E73\u5747\u5F02\u5E38 ", stats.baseline.avgAnomalies, " \u9879/\u8F68\u8FF9"] }))] })), _jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "SPC \u63A7\u5236\u56FE" }), _jsxs("div", { className: styles.toolbar, children: [_jsx(Select, { value: spcMetric, onChange: (event) => setSpcMetric(event.target.value), children: SPC_METRIC_OPTIONS.map((option) => (_jsx("option", { value: option.value, children: option.label }, option.value))) }), _jsxs("label", { className: styles.spcField, children: ["\u03BB\uFF080.05~0.95\uFF09", _jsx(Input, { className: styles.spcInput, type: "number", value: spcLambdaInput, onChange: (event) => setSpcLambdaInput(event.target.value), placeholder: "0.3" })] }), _jsxs("label", { className: styles.spcField, children: ["\u9650\u5BBD\uFF081~5\u03C3\uFF09", _jsx(Input, { className: styles.spcInput, type: "number", value: spcLimitInput, onChange: (event) => setSpcLimitInput(event.target.value), placeholder: "3" })] }), _jsx(Button, { variant: "primary", size: "sm", disabled: spcLoading, onClick: () => void runSpc(), children: spcLoading ? '分析中…' : '分析' })] }), _jsxs("p", { className: styles.spcHint, children: ["\u03BB \u8D8A\u5C0F\u5BF9\u7F13\u6162\u6F02\u79FB\u8D8A\u7075\u654F\uFF1B\u63A7\u5236\u9650\u57FA\u4E8E\u5168\u91CF\u5386\u53F2\u4F30\u8BA1\uFF0C\u56FE\u8868\u4EC5\u663E\u793A\u67E5\u8BE2\u533A\u95F4\uFF08\u8FD1 ", SPC_RANGE_DAYS, " \u5929\uFF09\u3002"] }), spcError.length > 0 && _jsx("div", { className: styles.error, children: spcError }), spcLoading ? (_jsx(Spinner, { label: "SPC \u5206\u6790\u4E2D\u2026" })) : spc ? (spc.sampleDays < 5 ? (_jsx("p", { className: styles.empty, children: "\u6709\u6548\u6837\u672C\u4E0D\u8DB3 5 \u5929\uFF0C\u7EE7\u7EED\u79EF\u7D2F\u540E\u53EF\u7528" })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: `${styles.spcBanner} ${SPC_VERDICT_META[spc.verdict].banner}`, children: [_jsx(Pill, { className: SPC_VERDICT_META[spc.verdict].badge, children: SPC_VERDICT_META[spc.verdict].text }), _jsx("span", { className: styles.spcDetail, children: spc.drift.detail }), _jsxs("span", { className: styles.spcRate, children: ["EWMA \u659C\u7387 ", spc.driftRatePerDay > 0 ? '+' : '', spc.driftRatePerDay.toFixed(4), "/\u5929", spc.driftRatePerDay > 0 ? '（恶化）' : spc.driftRatePerDay < 0 ? '（改善）' : ''] })] }), _jsxs("p", { className: styles.spcStats, children: ["\u4E2D\u5FC3\u7EBF ", formatSpcValue(spc.metric, spc.center), " \u00B7 \u03C3 ", formatSpcValue(spc.metric, spc.sigma), " \u00B7 \u6837\u672C", ' ', spc.sampleDays, " \u5929"] }), spc.points.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u67E5\u8BE2\u533A\u95F4\u5185\u6682\u65E0\u6570\u636E" })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: styles.spcChartWrap, children: _jsx(SpcChart, { points: spc.points, center: spc.center, metric: spc.metric }) }), _jsxs("div", { className: styles.spcLegend, children: [_jsxs("span", { children: [_jsx("i", { className: `${styles.spcLegendDot} ${styles.spcLegendValue}` }), "\u539F\u59CB\u503C"] }), _jsxs("span", { children: [_jsx("i", { className: `${styles.spcLegendDot} ${styles.spcLegendEwma}` }), "EWMA"] }), _jsxs("span", { children: [_jsx("i", { className: `${styles.spcLegendDot} ${styles.spcLegendLimit}` }), "\u4E0A/\u4E0B\u63A7\u5236\u9650"] }), _jsxs("span", { children: [_jsx("i", { className: `${styles.spcLegendDot} ${styles.spcLegendCenter}` }), "\u4E2D\u5FC3\u7EBF"] }), _jsxs("span", { children: [_jsx("i", { className: `${styles.spcLegendDot} ${styles.spcLegendViolation}` }), "\u8D8A\u9650\u70B9\uFF08\u7EA2=\u52A3\u5316\u4FA7\uFF0C\u6A59=\u6539\u5584\u4FA7\uFF09"] })] })] }))] }))) : null] })] }));
}
