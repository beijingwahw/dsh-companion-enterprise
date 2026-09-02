import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 交接摘要对话框（模块 B 客户端 UI）：
 * - 两种模式：「自由文本」POST /handoff/generate 生成可编辑摘要；
 *   「结构化分级」POST /handoff/structured 生成四级分层交接文档
 *   （锚定/进行中/参考/归档 + 锚定强制继承守门 + 世系链溯源）；
 * - 结果置于可编辑 Textarea，可复制到剪贴板、保存为模板、作为新对话起点武装；
 * - 模板列表支持载入与删除；加载与错误态齐全。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Modal, Spinner, Textarea, Toast, } from '@deepseek-ai/dsh-client-ui-primitives';
import { deleteHandoffTemplate, fetchHandoffLineage, fetchHandoffTemplates, generateHandoff, importHandoff, saveHandoffTemplate, traceHandoffLineage, } from '../api.js';
import { generateStructuredHandoff } from '../api.js';
import styles from './HandoffDialog.module.css';
/** 毫秒时间戳 → 本地可读日期时间。 */
function formatTime(ts) {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
/** 交接摘要对话框：生成/编辑摘要 + 模板管理 + 武装到新对话。 */
export function HandoffDialog(props) {
    /** 当前会话 id（const 局部量，便于在回调中保持类型收窄）。 */
    const sessionId = props.sessionId;
    const [mode, setMode] = useState('text');
    const [summary, setSummary] = useState('');
    const [model, setModel] = useState('');
    const [generating, setGenerating] = useState(false);
    const [generateError, setGenerateError] = useState('');
    const [templates, setTemplates] = useState([]);
    const [templatesLoading, setTemplatesLoading] = useState(false);
    const [templatesError, setTemplatesError] = useState('');
    const [templateName, setTemplateName] = useState('');
    const [savingTemplate, setSavingTemplate] = useState(false);
    const [importing, setImporting] = useState(false);
    const [deletingName, setDeletingName] = useState(null);
    /** 脏标记：用户一旦手动编辑过摘要，后续（慢）生成结果返回时不再覆盖内容。 */
    const dirtyRef = useRef(false);
    /** 手动重试的 AbortController：卸载时中止在途请求，避免对已卸载组件 setState。 */
    const manualAbortRef = useRef(null);
    useEffect(() => () => {
        manualAbortRef.current?.abort();
    }, []);
    /** 调用服务端为指定会话生成交接摘要。
     *
     * - signal 被中止或 isCancelled 为真（卸载 / sessionId 变化）时静默返回，不再更新任何状态；
     * - 用户已手动编辑过内容（dirtyRef）时，返回的摘要不再覆盖编辑区。
     */
    const generate = useCallback(async (targetSessionId, signal, isCancelled) => {
        /** 统一取消判定：外部 cancelled 守卫或中止信号任一生效即视为已取消。 */
        const cancelled = () => (signal?.aborted ?? false) || (isCancelled?.() ?? false);
        setGenerating(true);
        setGenerateError('');
        try {
            const result = await generateHandoff({ sessionId: targetSessionId }, { signal });
            if (cancelled())
                return;
            if (!dirtyRef.current) {
                setSummary(result.summary);
            }
            setModel(result.model);
        }
        catch (error) {
            if (cancelled())
                return;
            setGenerateError(error instanceof Error ? error.message : '交接摘要生成失败');
        }
        finally {
            if (!cancelled())
                setGenerating(false);
        }
    }, []);
    /** 手动重试生成（错误行的「重试」按钮）：与自动路径同样受 AbortController 保护。 */
    const handleRetry = useCallback(() => {
        if (!sessionId)
            return;
        manualAbortRef.current?.abort();
        const controller = new AbortController();
        manualAbortRef.current = controller;
        void generate(sessionId, controller.signal, () => controller.signal.aborted);
    }, [sessionId, generate]);
    /** 拉取模板列表。 */
    const loadTemplates = useCallback(async () => {
        setTemplatesLoading(true);
        setTemplatesError('');
        try {
            const response = await fetchHandoffTemplates();
            setTemplates(response.templates);
        }
        catch (error) {
            setTemplatesError(error instanceof Error ? error.message : '模板列表加载失败');
        }
        finally {
            setTemplatesLoading(false);
        }
    }, []);
    // 打开对话框：刷新模板列表；有 sessionId 时自动生成交接摘要。
    // 摘要生成可能较慢：以 AbortController + cancelled 守卫，卸载 / sessionId 变化时取消在途请求，
    // 避免过期响应覆盖新会话的状态；每次重新打开（或切换会话）时重置脏标记。
    useEffect(() => {
        if (!props.open)
            return;
        const controller = new AbortController();
        let cancelled = false;
        void loadTemplates();
        if (sessionId) {
            dirtyRef.current = false;
            void generate(sessionId, controller.signal, () => cancelled);
        }
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [props.open, sessionId, loadTemplates, generate]);
    /** 复制当前摘要到剪贴板。 */
    const handleCopy = useCallback(async () => {
        if (!summary.trim()) {
            Toast.push('没有可复制的内容', 'warning');
            return;
        }
        try {
            await navigator.clipboard.writeText(summary);
            Toast.push('已复制到剪贴板', 'success');
        }
        catch {
            Toast.push('复制失败：浏览器未授权剪贴板访问', 'error');
        }
    }, [summary]);
    /** 以输入的名称保存当前摘要为模板。 */
    const handleSaveTemplate = useCallback(async () => {
        const name = templateName.trim();
        if (!name) {
            Toast.push('请输入模板名称', 'warning');
            return;
        }
        if (!summary.trim()) {
            Toast.push('摘要内容为空，无法保存模板', 'warning');
            return;
        }
        setSavingTemplate(true);
        try {
            await saveHandoffTemplate({ name, content: summary });
            Toast.push(`模板「${name}」已保存`, 'success');
            setTemplateName('');
            await loadTemplates();
        }
        catch (error) {
            Toast.push(error instanceof Error ? error.message : '模板保存失败', 'error');
        }
        finally {
            setSavingTemplate(false);
        }
    }, [templateName, summary, loadTemplates]);
    /** 将当前摘要作为新对话起点：不带 sessionId 导入 = 武装给下一个新对话。
     *
     * 武装成功后派发 `companion:armed-changed` 自定义事件，供 dock（ImportSummaryDock）刷新武装状态。
     */
    const handleImport = useCallback(async () => {
        if (!summary.trim()) {
            Toast.push('摘要内容为空，无法武装到新对话', 'warning');
            return;
        }
        setImporting(true);
        try {
            await importHandoff({ summary });
            window.dispatchEvent(new CustomEvent('companion:armed-changed'));
            Toast.push('已武装给下一个新对话，新建对话时将自动注入该摘要', 'success');
            props.onClose();
        }
        catch (error) {
            Toast.push(error instanceof Error ? error.message : '武装摘要失败', 'error');
        }
        finally {
            setImporting(false);
        }
    }, [summary, props.onClose]);
    /** 载入模板内容到编辑区（视为用户主动设置的内容，同样置脏以防在途生成覆盖）。 */
    const handleLoadTemplate = useCallback((template) => {
        dirtyRef.current = true;
        setSummary(template.content);
        Toast.push(`已载入模板「${template.name}」，可继续编辑`, 'info');
    }, []);
    /** 删除模板。 */
    const handleDeleteTemplate = useCallback(async (name) => {
        setDeletingName(name);
        try {
            await deleteHandoffTemplate(name);
            Toast.push(`模板「${name}」已删除`, 'success');
            await loadTemplates();
        }
        catch (error) {
            Toast.push(error instanceof Error ? error.message : '模板删除失败', 'error');
        }
        finally {
            setDeletingName(null);
        }
    }, [loadTemplates]);
    return (_jsx(Modal, { open: props.open, title: "\u4EA4\u63A5\u6458\u8981", onClose: props.onClose, footer: _jsx("div", { className: styles.footer, children: _jsx(Button, { variant: "ghost", onClick: props.onClose, children: "\u5173\u95ED" }) }), children: _jsxs("div", { className: styles.body, children: [_jsxs("div", { className: styles.modeSwitch, children: [_jsx(Button, { size: "sm", variant: mode === 'text' ? 'primary' : 'secondary', onClick: () => setMode('text'), children: "\u81EA\u7531\u6587\u672C\u6458\u8981" }), _jsx(Button, { size: "sm", variant: mode === 'structured' ? 'primary' : 'secondary', onClick: () => setMode('structured'), children: "\u7ED3\u6784\u5316\u5206\u7EA7\u4EA4\u63A5" })] }), mode === 'structured' ? (_jsx(StructuredHandoffPanel, { sessionId: sessionId, onArmed: props.onClose })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: styles.status, children: [generating ? _jsx(Spinner, { label: "\u6B63\u5728\u751F\u6210\u5F53\u524D\u4F1A\u8BDD\u7684\u4EA4\u63A5\u6458\u8981\u2026" }) : null, !generating && generateError ? (_jsxs("div", { className: styles.error, children: [_jsx("span", { children: generateError }), sessionId ? (_jsx(Button, { variant: "ghost", size: "sm", onClick: handleRetry, children: "\u91CD\u8BD5" })) : null] })) : null] }), _jsx(Textarea, { className: styles.summaryInput, rows: 10, value: summary, disabled: generating, onChange: (event) => {
                                // 用户手动输入即置脏：后续（慢）生成结果返回时不再覆盖已编辑内容
                                dirtyRef.current = true;
                                setSummary(event.target.value);
                            }, placeholder: "\u751F\u6210\u7684\u4EA4\u63A5\u6458\u8981\u5C06\u663E\u793A\u5728\u8FD9\u91CC\uFF1B\u4E5F\u53EF\u4EE5\u76F4\u63A5\u7C98\u8D34\u6216\u7F16\u8F91\u5185\u5BB9\u2026" }), model ? _jsxs("div", { className: styles.modelInfo, children: ["\u751F\u6210\u6A21\u578B\uFF1A", model] }) : null, _jsxs("div", { className: styles.actions, children: [_jsx(Button, { variant: "secondary", onClick: () => void handleCopy(), children: "\u590D\u5236\u5230\u526A\u8D34\u677F" }), _jsx(Button, { variant: "primary", onClick: () => void handleImport(), disabled: importing, children: importing ? _jsx(Spinner, { label: "\u6B66\u88C5\u4E2D\u2026" }) : '作为新对话起点' })] })] })), _jsxs("div", { className: styles.section, children: [_jsx("div", { className: styles.sectionTitle, children: "\u4FDD\u5B58\u4E3A\u6A21\u677F" }), _jsxs("div", { className: styles.templateNameRow, children: [_jsx(Input, { className: styles.templateNameInput, value: templateName, onChange: (event) => setTemplateName(event.target.value), onKeyDown: (event) => {
                                        // Enter 快捷提交：与“保存为模板”按钮等价
                                        if (event.key === 'Enter' && !savingTemplate)
                                            void handleSaveTemplate();
                                    }, placeholder: "\u6A21\u677F\u540D\u79F0\uFF0C\u5982\uFF1A\u524D\u7AEF\u9879\u76EE\u4EA4\u63A5" }), _jsx(Button, { variant: "secondary", onClick: () => void handleSaveTemplate(), disabled: savingTemplate, children: savingTemplate ? _jsx(Spinner, { label: "\u4FDD\u5B58\u4E2D\u2026" }) : '保存为模板' })] })] }), _jsxs("div", { className: styles.section, children: [_jsx("div", { className: styles.sectionTitle, children: "\u6211\u7684\u6A21\u677F" }), templatesLoading ? _jsx(Spinner, { label: "\u52A0\u8F7D\u6A21\u677F\u5217\u8868\u2026" }) : null, !templatesLoading && templatesError ? (_jsxs("div", { className: styles.error, children: [_jsx("span", { children: templatesError }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => void loadTemplates(), children: "\u91CD\u8BD5" })] })) : null, !templatesLoading && !templatesError && templates.length === 0 ? (_jsx("div", { className: styles.empty, children: "\u6682\u65E0\u6A21\u677F\uFF0C\u4FDD\u5B58\u6458\u8981\u540E\u53EF\u5728\u6B64\u590D\u7528" })) : null, !templatesLoading && !templatesError
                            ? templates.map((template) => (_jsxs("div", { className: styles.templateItem, children: [_jsxs("div", { className: styles.templateMeta, children: [_jsx("span", { className: styles.templateName, children: template.name }), _jsxs("span", { className: styles.templateTime, children: ["\u66F4\u65B0\u4E8E ", formatTime(template.updatedAt)] })] }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => handleLoadTemplate(template), children: "\u8F7D\u5165" }), _jsx(Button, { variant: "danger", size: "sm", onClick: () => void handleDeleteTemplate(template.name), disabled: deletingName === template.name, children: deletingName === template.name ? _jsx(Spinner, { label: "\u5220\u9664\u4E2D\u2026" }) : '删除' })] }, template.name)))
                            : null] })] }) }));
}
// ---------------------------------------------------------------------------
// 结构化分级交接面板（创新扩展）
// ---------------------------------------------------------------------------
/** 活动项 kind → 中文标签。 */
const ACTIVE_KIND_LABELS = {
    in_progress: '进行中',
    next: '下一步',
    open_question: '开放问题',
};
/** 参考项 kind → 中文标签。 */
const REFERENCE_KIND_LABELS = {
    path: '路径',
    command: '命令',
    id: '标识',
    link: '链接',
    other: '其他',
};
/** 锚定处置 action → 中文标签。 */
const DISPOSITION_LABELS = {
    inherited: '继承',
    evolved: '演进',
    dropped: '废弃',
};
/**
 * 结构化分级交接面板：
 * - 生成四级分层交接文档（锚定/进行中/参考/归档）；
 * - 展示锚定强制继承守门结果（自动补回的约束高亮）与世系深度告警；
 * - 底部世系链总览：点击任一代可沿 parent 链溯源到根（各代锚定与处置记录）。
 */
function StructuredHandoffPanel(props) {
    const [result, setResult] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [arming, setArming] = useState(false);
    /** 生成结构化交接（cancelled 守卫 + AbortController，卸载/会话变化时静默中止）。 */
    const generate = useCallback(async (signal, isCancelled) => {
        if (!props.sessionId)
            return;
        const cancelled = () => (signal?.aborted ?? false) || (isCancelled?.() ?? false);
        setLoading(true);
        setError('');
        try {
            const response = await generateStructuredHandoff({ sessionId: props.sessionId }, { signal });
            if (cancelled())
                return;
            setResult(response);
        }
        catch (err) {
            if (cancelled())
                return;
            setError(err instanceof Error ? err.message : '结构化交接生成失败');
        }
        finally {
            if (!cancelled())
                setLoading(false);
        }
    }, [props.sessionId]);
    // 挂载（含会话变化）：自动生成一次结构化交接。
    useEffect(() => {
        if (!props.sessionId)
            return;
        const controller = new AbortController();
        let cancelled = false;
        void generate(controller.signal, () => cancelled);
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [props.sessionId, generate]);
    /** 复制渲染后的交接文本。 */
    const handleCopy = useCallback(async () => {
        if (!result)
            return;
        try {
            await navigator.clipboard.writeText(result.rendered);
            Toast.push('已复制结构化交接文本', 'success');
        }
        catch {
            Toast.push('复制失败：浏览器未授权剪贴板访问', 'error');
        }
    }, [result]);
    /** 把渲染文本武装给下一个新对话（复用既有武装管线与世代门闩）。 */
    const handleArm = useCallback(async () => {
        if (!result)
            return;
        setArming(true);
        try {
            await importHandoff({ summary: result.rendered });
            window.dispatchEvent(new CustomEvent('companion:armed-changed'));
            Toast.push('已武装给下一个新对话，新建对话时将自动注入', 'success');
            props.onArmed();
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '武装结构化交接失败', 'error');
        }
        finally {
            setArming(false);
        }
    }, [result, props.onArmed]);
    if (!props.sessionId) {
        return _jsx("div", { className: styles.empty, children: "\u7ED3\u6784\u5316\u4EA4\u63A5\u9700\u5728\u4F1A\u8BDD\u5185\u4F7F\u7528\uFF1A\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD\u518D\u751F\u6210\u3002" });
    }
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: styles.status, children: [loading ? _jsx(Spinner, { label: "\u6B63\u5728\u751F\u6210\u7ED3\u6784\u5316\u5206\u7EA7\u4EA4\u63A5\uFF08\u56DB\u7EA7\u5206\u5C42 + \u951A\u5B9A\u7EE7\u627F\u5B88\u95E8\uFF09\u2026" }) : null, !loading && error ? (_jsxs("div", { className: styles.error, children: [_jsx("span", { children: error }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => void generate(), children: "\u91CD\u8BD5" })] })) : null] }), result ? (_jsxs(_Fragment, { children: [result.depthWarning ? (_jsxs("div", { className: styles.warnBanner, children: ["\u4E0A\u4E0B\u6587\u5DF2\u4F20\u627F ", result.handoff.depth, " \u4EE3\uFF08\u544A\u8B66\u9608\u503C ", result.depthWarnThreshold, "\uFF09\uFF0C\u4FE1\u606F\u635F\u8017\u98CE\u9669\u5347\u9AD8\uFF0C\u5EFA\u8BAE\u56DE\u8BFB\u6E90\u5934\u4F1A\u8BDD\u3002"] })) : null, result.autoRestoredCount > 0 ? (_jsxs("div", { className: styles.gateBanner, children: ["\u5B88\u95E8\u81EA\u52A8\u8865\u56DE ", result.autoRestoredCount, " \u6761\u951A\u5B9A\u7EA6\u675F\uFF1A\u6A21\u578B\u751F\u6210\u65F6\u9759\u9ED8\u4E22\u5931\uFF0C\u5DF2\u88AB\u5F3A\u5236\u7EE7\u627F\uFF08\u9759\u9ED8\u4E22\u5931\u5728\u7ED3\u6784\u4E0A\u4E0D\u53EF\u80FD\uFF09\u3002"] })) : null, _jsxs("div", { className: styles.tier, children: [_jsxs("div", { className: styles.tierTitle, children: ["\u951A\u5B9A\u7EA6\u675F\uFF08", result.handoff.tiers.anchors.length, "\uFF09"] }), _jsx("div", { className: styles.tierHint, children: "\u4E0D\u53EF\u4E22\u5931\u7684\u786C\u7EA6\u675F/\u5DF2\u5B9A\u51B3\u7B56/\u5173\u952E\u524D\u63D0\uFF0C\u6CE8\u5165\u65F6\u914D\u5F3A\u6307\u4EE4\u3002" }), result.handoff.tiers.anchors.length === 0 ? (_jsx("div", { className: styles.empty, children: "\u672C\u4EE3\u65E0\u951A\u5B9A\u9879" })) : (result.handoff.tiers.anchors.map((anchor) => (_jsxs("div", { className: `${styles.tierItem} ${anchor.autoRestored ? styles.tierItemRestored : ''}`, children: [_jsx("span", { className: styles.tierText, children: anchor.text }), _jsxs("span", { className: styles.tierBadges, children: [anchor.autoRestored ? _jsx("span", { className: styles.badgeRestored, children: "\u5B88\u95E8\u8865\u56DE" }) : null, anchor.origin !== null ? (_jsxs("span", { className: styles.badgeOrigin, children: ["\u7EE7\u627F\u81EA ", anchor.origin.slice(0, 8)] })) : (_jsx("span", { className: styles.badgeNew, children: "\u672C\u4EE3\u65B0\u589E" }))] })] }, anchor.hash))))] }), result.handoff.tiers.active.length > 0 ? (_jsxs("div", { className: styles.tier, children: [_jsxs("div", { className: styles.tierTitle, children: ["\u8FDB\u884C\u4E2D\uFF08", result.handoff.tiers.active.length, "\uFF09"] }), result.handoff.tiers.active.map((item, index) => (_jsxs("div", { className: styles.tierItem, children: [_jsx("span", { className: styles.badgeKind, children: ACTIVE_KIND_LABELS[item.kind] ?? item.kind }), _jsx("span", { className: styles.tierText, children: item.text })] }, `${index}-${item.text}`)))] })) : null, result.handoff.tiers.reference.length > 0 ? (_jsxs("div", { className: styles.tier, children: [_jsxs("div", { className: styles.tierTitle, children: ["\u53C2\u8003\uFF08", result.handoff.tiers.reference.length, "\uFF09"] }), result.handoff.tiers.reference.map((item, index) => (_jsxs("div", { className: styles.tierItem, children: [_jsx("span", { className: styles.badgeKind, children: REFERENCE_KIND_LABELS[item.kind] ?? item.kind }), _jsx("span", { className: styles.tierMono, children: item.text })] }, `${index}-${item.text}`)))] })) : null, result.handoff.tiers.archived.length > 0 ? (_jsxs("div", { className: styles.tier, children: [_jsxs("div", { className: styles.tierTitle, children: ["\u5F52\u6863\uFF08", result.handoff.tiers.archived.length, "\uFF09"] }), result.handoff.tiers.archived.map((item, index) => (_jsx("div", { className: styles.tierArchived, children: item.text }, `${index}-${item.text}`)))] })) : null, result.handoff.dispositions.length > 0 ? (_jsxs("div", { className: styles.tier, children: [_jsxs("div", { className: styles.tierTitle, children: ["\u7236\u4EE3\u951A\u5B9A\u5904\u7F6E\uFF08", result.handoff.dispositions.length, "\uFF09"] }), result.handoff.dispositions.map((disp, index) => (_jsxs("div", { className: styles.dispositionItem, children: [_jsx("span", { className: `${styles.badgeDisposition} ${disp.action === 'dropped' ? styles.badgeDropped : disp.action === 'evolved' ? styles.badgeEvolved : styles.badgeInherited}`, children: DISPOSITION_LABELS[disp.action] ?? disp.action }), _jsx("span", { className: styles.tierText, children: disp.anchorText }), disp.reason ? _jsxs("span", { className: styles.dispositionReason, children: ["\u7406\u7531\uFF1A", disp.reason] }) : null] }, `${index}-${disp.anchorHash}`)))] })) : null, _jsxs("div", { className: styles.actions, children: [_jsx(Button, { variant: "secondary", onClick: () => void handleCopy(), children: "\u590D\u5236\u4EA4\u63A5\u6587\u672C" }), _jsx(Button, { variant: "primary", onClick: () => void handleArm(), disabled: arming, children: arming ? _jsx(Spinner, { label: "\u6B66\u88C5\u4E2D\u2026" }) : '武装给下一个新对话' })] })] })) : null, _jsx(LineageSection, {})] }));
}
/** 世系链总览与溯源分区：列出各代交接摘要，点击展开沿 parent 链到根的完整链条。 */
function LineageSection(_props) {
    const [expanded, setExpanded] = useState(false);
    const [trace, setTrace] = useState(null);
    const [traceError, setTraceError] = useState('');
    /** 展开世系链总览（懒加载一次）。 */
    const handleExpand = useCallback(() => {
        setExpanded((prev) => !prev);
    }, []);
    /** 溯源指定交接的世系链（沿 parent 链到根）。 */
    const handleTrace = useCallback(async (handoffId) => {
        setTraceError('');
        try {
            setTrace(await traceHandoffLineage(handoffId));
        }
        catch (error) {
            setTrace(null);
            setTraceError(error instanceof Error ? error.message : '世系溯源失败');
        }
    }, []);
    return (_jsxs("div", { className: styles.section, children: [_jsxs("button", { type: "button", className: styles.lineageToggle, onClick: handleExpand, children: ["\u4E16\u7CFB\u94FE\u603B\u89C8", expanded ? '（收起）' : '（展开）'] }), expanded ? _jsx(LineageList, { onTrace: handleTrace }) : null, traceError ? _jsx("div", { className: styles.error, children: traceError }) : null, trace ? (_jsxs("div", { className: styles.traceChain, children: [_jsxs("div", { className: styles.tierTitle, children: ["\u4E16\u7CFB\u6EAF\u6E90\uFF1A\u5171 ", trace.depth + 1, " \u4EE3", trace.truncated ? '（过深已截断）' : ''] }), trace.chain.map((entry) => (_jsxs("div", { className: styles.traceEntry, children: [_jsxs("div", { className: styles.traceMeta, children: ["\u7B2C ", entry.depth, " \u4EE3 \u00B7 ", formatTime(entry.createdAt), " \u00B7 ", entry.anchors.length, " \u6761\u951A\u5B9A"] }), entry.anchors.map((anchor) => (_jsxs("div", { className: styles.traceAnchor, children: [anchor.text, anchor.autoRestored ? _jsx("span", { className: styles.badgeRestored, children: "\u5B88\u95E8\u8865\u56DE" }) : null] }, anchor.hash))), entry.dispositions
                                .filter((disp) => disp.action === 'dropped')
                                .map((disp, index) => (_jsxs("div", { className: styles.traceDropped, children: ["\u5E9F\u5F03\uFF1A", disp.anchorText, disp.reason ? `（${disp.reason}）` : ''] }, `${index}-${disp.anchorHash}`)))] }, entry.handoffId)))] })) : null] }));
}
/** 世系链总览列表（按创建时间降序，点击行溯源）。 */
function LineageList(props) {
    const [rows, setRows] = useState(null);
    const [error, setError] = useState('');
    useEffect(() => {
        let cancelled = false;
        fetchHandoffLineage()
            .then((response) => {
            if (!cancelled)
                setRows(response.handoffs);
        })
            .catch((err) => {
            if (!cancelled)
                setError(err instanceof Error ? err.message : '世系链加载失败');
        });
        return () => {
            cancelled = true;
        };
    }, []);
    if (error)
        return _jsx("div", { className: styles.error, children: error });
    if (rows === null)
        return _jsx(Spinner, { label: "\u52A0\u8F7D\u4E16\u7CFB\u94FE\u2026" });
    if (rows.length === 0)
        return _jsx("div", { className: styles.empty, children: "\u6682\u65E0\u7ED3\u6784\u5316\u4EA4\u63A5\u8BB0\u5F55" });
    return (_jsx("div", { className: styles.lineageList, children: rows.map((row) => (_jsxs("button", { type: "button", className: styles.lineageRow, onClick: () => props.onTrace(row.handoffId), children: [_jsxs("span", { className: styles.lineageDepth, children: ["\u7B2C ", row.depth, " \u4EE3"] }), _jsx("span", { className: styles.lineageTitle, children: formatTime(row.createdAt) }), _jsxs("span", { className: styles.lineageCounts, children: ["\u951A\u5B9A ", row.anchorCount, row.autoRestoredCount > 0 ? ` · 补回 ${row.autoRestoredCount}` : '', row.droppedCount > 0 ? ` · 废弃 ${row.droppedCount}` : ''] })] }, row.handoffId))) }));
}
