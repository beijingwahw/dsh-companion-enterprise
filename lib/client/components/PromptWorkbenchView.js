import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Prompt 工程工作台视图页（模块 F 客户端 UI，挂载于 conversation.view）：
 * - F1 版本管理：保存/回滚/打标签，历史列表；
 * - F2 A/B 测试：左右分栏对比两版本输出，批量测试集，自动指标对比，人工评分；
 * - F3 模板库：内置 + 自定义模板，变量插值表单，一键生成 API 调用代码；
 * - F4 结构化校验：定义 JSON Schema，批量校验合规率，高亮违规字段。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Select, Spinner, Textarea, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { fetchPromptTemplates, fetchPromptVersions, generateApiCode, rateAbTest, renderPromptTemplate, rollbackPromptVersion, runAbTest, savePromptTemplate, savePromptVersion, updatePromptTags, validateStructuredOutput, } from '../api.js';
import styles from './PromptWorkbenchView.module.css';
/** Prompt 工程工作台视图页。 */
export function PromptWorkbenchView(_props) {
    const [tab, setTab] = useState('versions');
    return (_jsxs("div", { className: styles.root, children: [_jsx("h2", { className: styles.title, children: "Prompt \u5DE5\u7A0B\u5DE5\u4F5C\u53F0" }), _jsxs("div", { className: styles.tabs, children: [_jsx(Button, { size: "sm", variant: tab === 'versions' ? 'primary' : 'secondary', onClick: () => setTab('versions'), children: "\u7248\u672C\u7BA1\u7406" }), _jsx(Button, { size: "sm", variant: tab === 'ab' ? 'primary' : 'secondary', onClick: () => setTab('ab'), children: "A/B \u6D4B\u8BD5" }), _jsx(Button, { size: "sm", variant: tab === 'templates' ? 'primary' : 'secondary', onClick: () => setTab('templates'), children: "\u6A21\u677F\u5E93" }), _jsx(Button, { size: "sm", variant: tab === 'validate' ? 'primary' : 'secondary', onClick: () => setTab('validate'), children: "\u7ED3\u6784\u5316\u6821\u9A8C" })] }), tab === 'versions' && _jsx(VersionsPanel, {}), tab === 'ab' && _jsx(AbTestPanel, {}), tab === 'templates' && _jsx(TemplatesPanel, {}), tab === 'validate' && _jsx(ValidatePanel, {})] }));
}
/** F1：版本管理面板。 */
function VersionsPanel() {
    const [versions, setVersions] = useState([]);
    const [content, setContent] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const reload = useCallback(() => {
        fetchPromptVersions()
            .then((response) => setVersions(response.versions))
            .catch((err) => Toast.push(err instanceof Error ? err.message : '加载版本失败', 'error'));
    }, []);
    useEffect(() => {
        reload();
    }, [reload]);
    const save = useCallback(async () => {
        if (!content.trim())
            return;
        setBusy(true);
        try {
            await savePromptVersion({ content, note });
            setContent('');
            setNote('');
            reload();
            Toast.push('已保存新版本', 'success');
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '保存失败', 'error');
        }
        finally {
            setBusy(false);
        }
    }, [content, note, reload]);
    const rollback = useCallback(async (version) => {
        setBusy(true);
        try {
            await rollbackPromptVersion({ version });
            reload();
            Toast.push(`已回滚：v${version} 的内容已存为新版本`, 'success');
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '回滚失败', 'error');
        }
        finally {
            setBusy(false);
        }
    }, [reload]);
    const toggleTag = useCallback(async (version, tag, has) => {
        try {
            await updatePromptTags({ version, add: has ? [] : [tag], remove: has ? [tag] : [] });
            reload();
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '更新标签失败', 'error');
        }
    }, [reload]);
    const presetTags = ['稳定版', '实验版', '生产版'];
    return (_jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "\u4FDD\u5B58\u65B0\u7248\u672C" }), _jsx(Textarea, { value: content, rows: 6, placeholder: "\u7C98\u8D34\u6216\u7F16\u8F91 Prompt \u5185\u5BB9\u2026", onChange: (event) => setContent(event.target.value) }), _jsxs("div", { className: styles.row, children: [_jsx(Input, { value: note, placeholder: "\u5907\u6CE8\uFF08\u5982\uFF1A\u52A0\u4E86 few-shot \u793A\u4F8B\uFF09", onChange: (event) => setNote(event.target.value) }), _jsx(Button, { variant: "primary", size: "sm", disabled: busy || !content.trim(), onClick: save, children: "\u4FDD\u5B58\u7248\u672C" })] }), _jsxs("h3", { children: ["\u7248\u672C\u5386\u53F2\uFF08", versions.length, "\uFF09"] }), versions.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u5C1A\u672A\u4FDD\u5B58\u4EFB\u4F55\u7248\u672C\u3002" })) : (_jsx("ul", { className: styles.versionList, children: [...versions].reverse().map((version) => (_jsxs("li", { className: styles.versionItem, children: [_jsxs("div", { className: styles.versionHeader, children: [_jsxs("strong", { children: ["v", version.version] }), _jsx("span", { className: styles.versionNote, children: version.note || '无备注' }), _jsx("span", { className: styles.versionTime, children: new Date(version.createdAt).toLocaleString('zh-CN', { hour12: false }) })] }), _jsxs("pre", { className: styles.versionContent, children: [version.content.slice(0, 300), version.content.length > 300 ? '…' : ''] }), _jsxs("div", { className: styles.row, children: [presetTags.map((tag) => {
                                    const has = version.tags.includes(tag);
                                    return (_jsx(Button, { size: "sm", variant: has ? 'primary' : 'ghost', onClick: () => toggleTag(version.version, tag, has), children: has ? `✓ ${tag}` : tag }, tag));
                                }), _jsx(Button, { size: "sm", variant: "secondary", disabled: busy, onClick: () => rollback(version.version), children: "\u56DE\u6EDA\u5230\u6B64\u7248\u672C" })] })] }, version.version))) }))] }));
}
/** F2：A/B 测试面板。 */
function AbTestPanel() {
    const [promptA, setPromptA] = useState('');
    const [promptB, setPromptB] = useState('');
    const [casesText, setCasesText] = useState('');
    const [result, setResult] = useState();
    const [ratings, setRatings] = useState();
    const [busy, setBusy] = useState(false);
    // 长请求可取消：AbortController 在卸载时中止，避免对已卸载组件 setState。
    const abortRef = useRef(null);
    useEffect(() => () => {
        abortRef.current?.abort();
    }, []);
    const run = useCallback(async () => {
        if (!promptA.trim() || !promptB.trim())
            return;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        setResult(undefined);
        try {
            const cases = casesText
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
            const response = await runAbTest({ promptA, promptB, cases }, { timeoutMs: 300_000, signal: controller.signal });
            if (!controller.signal.aborted) {
                setResult(response);
                setRatings(response.ratings);
            }
        }
        catch (err) {
            if (!controller.signal.aborted) {
                Toast.push(err instanceof Error ? err.message : 'A/B 测试失败', 'error');
            }
        }
        finally {
            if (!controller.signal.aborted)
                setBusy(false);
        }
    }, [promptA, promptB, casesText]);
    /** 取消进行中的 A/B 测试。 */
    const cancel = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        setBusy(false);
    }, []);
    const rate = useCallback(async (winner) => {
        try {
            const response = await rateAbTest({ winner, promptA, promptB });
            setRatings(response.ratings);
            Toast.push('评分已记录', 'success');
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '评分失败', 'error');
        }
    }, [promptA, promptB]);
    return (_jsxs("section", { className: styles.section, children: [_jsxs("div", { className: styles.split, children: [_jsxs("div", { className: styles.splitCol, children: [_jsx("h3", { children: "\u7248\u672C A" }), _jsx(Textarea, { value: promptA, rows: 5, placeholder: "Prompt \u7248\u672C A\u2026", onChange: (event) => setPromptA(event.target.value) })] }), _jsxs("div", { className: styles.splitCol, children: [_jsx("h3", { children: "\u7248\u672C B" }), _jsx(Textarea, { value: promptB, rows: 5, placeholder: "Prompt \u7248\u672C B\u2026", onChange: (event) => setPromptB(event.target.value) })] })] }), _jsx("h3", { children: "\u6D4B\u8BD5\u96C6\uFF08\u6BCF\u884C\u4E00\u6761\uFF0C\u53EF\u7559\u7A7A\uFF09" }), _jsx(Textarea, { value: casesText, rows: 3, placeholder: '用例 1\n用例 2', onChange: (event) => setCasesText(event.target.value) }), _jsxs("div", { className: styles.row, children: [_jsx(Button, { variant: "primary", size: "sm", disabled: busy || !promptA.trim() || !promptB.trim(), onClick: run, children: busy ? '测试中…' : '运行 A/B 测试' }), busy && (_jsx(Button, { variant: "ghost", size: "sm", onClick: cancel, children: "\u53D6\u6D88" })), result && (_jsxs(_Fragment, { children: [_jsx(Button, { size: "sm", variant: "secondary", onClick: () => rate('A'), children: "A \u66F4\u597D" }), _jsx(Button, { size: "sm", variant: "secondary", onClick: () => rate('B'), children: "B \u66F4\u597D" }), _jsx(Button, { size: "sm", variant: "ghost", onClick: () => rate('tie'), children: "\u5E73\u5C40" })] }))] }), busy && _jsx(Spinner, { label: "\u6B63\u5728\u6279\u91CF\u8C03\u7528\u6A21\u578B\u2026" }), ratings && ratings.total > 0 && (_jsxs("p", { className: styles.ratings, children: ["\u5386\u53F2\u8BC4\u5206\uFF1A\u5171 ", ratings.total, " \u6B21 \u00B7 A \u80DC ", ratings.winsA, " \u00B7 B \u80DC ", ratings.winsB, " \u00B7 \u5E73\u5C40 ", ratings.ties, ratings.winsA + ratings.winsB > 0 &&
                        ` · A 胜率 ${((ratings.winsA / (ratings.winsA + ratings.winsB)) * 100).toFixed(0)}%`] })), result && (_jsxs("div", { className: styles.split, children: [_jsxs("div", { className: styles.splitCol, children: [_jsxs("h3", { children: ["A \u8F93\u51FA\uFF08", result.a.summary.totalTokens, " tokens \u00B7 \u5E73\u5747 ", result.a.summary.avgLatencyMs, "ms\uFF09"] }), result.a.results.map((run) => (_jsx("pre", { className: run.ok ? styles.outputOk : styles.outputFail, children: run.ok ? run.output : `错误：${run.error}` }, run.caseIndex)))] }), _jsxs("div", { className: styles.splitCol, children: [_jsxs("h3", { children: ["B \u8F93\u51FA\uFF08", result.b.summary.totalTokens, " tokens \u00B7 \u5E73\u5747 ", result.b.summary.avgLatencyMs, "ms\uFF09"] }), result.b.results.map((run) => (_jsx("pre", { className: run.ok ? styles.outputOk : styles.outputFail, children: run.ok ? run.output : `错误：${run.error}` }, run.caseIndex)))] })] }))] }));
}
/** F3：模板库面板。 */
function TemplatesPanel() {
    const [templates, setTemplates] = useState([]);
    const [selected, setSelected] = useState();
    const [variables, setVariables] = useState({});
    const [rendered, setRendered] = useState('');
    const [codeLanguage, setCodeLanguage] = useState('python');
    const [code, setCode] = useState('');
    const reload = useCallback(() => {
        fetchPromptTemplates()
            .then((response) => setTemplates(response.templates))
            .catch((err) => Toast.push(err instanceof Error ? err.message : '加载模板失败', 'error'));
    }, []);
    useEffect(() => {
        reload();
    }, [reload]);
    const selectTemplate = useCallback((template) => {
        setSelected(template);
        setVariables({});
        setRendered('');
        setCode('');
    }, []);
    const render = useCallback(async () => {
        if (!selected)
            return;
        try {
            const response = await renderPromptTemplate({ template: selected.content, variables });
            setRendered(response.rendered);
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '渲染失败', 'error');
        }
    }, [selected, variables]);
    const genCode = useCallback(async () => {
        const source = rendered || selected?.content || '';
        if (!source)
            return;
        try {
            const response = await generateApiCode({ prompt: source, language: codeLanguage });
            setCode(response.code);
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '生成代码失败', 'error');
        }
    }, [rendered, selected, codeLanguage]);
    const saveAsTemplate = useCallback(async () => {
        const name = window.prompt('模板名称：');
        if (!name)
            return;
        const source = rendered || selected?.content || '';
        if (!source)
            return;
        try {
            await savePromptTemplate({ name, content: source });
            reload();
            Toast.push('模板已保存', 'success');
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '保存模板失败', 'error');
        }
    }, [rendered, selected, reload]);
    return (_jsx("section", { className: styles.section, children: _jsxs("div", { className: styles.split, children: [_jsxs("div", { className: styles.splitCol, children: [_jsx("h3", { children: "\u6A21\u677F\u5217\u8868" }), _jsx("ul", { className: styles.templateList, children: templates.map((template) => (_jsx("li", { children: _jsxs("button", { type: "button", className: selected?.name === template.name ? styles.templateActive : styles.templateItem, onClick: () => selectTemplate(template), children: [template.name, _jsxs("span", { className: styles.templateCategory, children: [template.category, template.builtin ? ' · 内置' : ''] })] }) }, template.name))) })] }), _jsx("div", { className: styles.splitCol, children: selected ? (_jsxs(_Fragment, { children: [_jsxs("h3", { children: [selected.name, selected.variables.length > 0 && `（变量：${selected.variables.join('、')}）`] }), _jsx("pre", { className: styles.versionContent, children: selected.content }), selected.variables.map((name) => (_jsxs("div", { className: styles.row, children: [_jsx("label", { className: styles.varLabel, children: `{{${name}}}` }), _jsx(Input, { value: variables[name] ?? '', placeholder: `输入 ${name} 的值`, onChange: (event) => setVariables((prev) => ({ ...prev, [name]: event.target.value })) })] }, name))), _jsxs("div", { className: styles.row, children: [_jsx(Button, { size: "sm", variant: "primary", onClick: render, children: "\u6E32\u67D3" }), _jsxs(Select, { value: codeLanguage, onChange: (event) => setCodeLanguage(event.target.value), children: [_jsx("option", { value: "python", children: "Python" }), _jsx("option", { value: "nodejs", children: "Node.js" }), _jsx("option", { value: "curl", children: "curl" })] }), _jsx(Button, { size: "sm", variant: "secondary", onClick: genCode, children: "\u751F\u6210\u8C03\u7528\u4EE3\u7801" }), _jsx(Button, { size: "sm", variant: "ghost", onClick: saveAsTemplate, children: "\u53E6\u5B58\u4E3A\u6A21\u677F" })] }), rendered && _jsx("pre", { className: styles.versionContent, children: rendered }), code && _jsx("pre", { className: styles.codeBlock, children: code })] })) : (_jsx("p", { className: styles.empty, children: "\u4ECE\u5DE6\u4FA7\u9009\u62E9\u4E00\u4E2A\u6A21\u677F\u3002" })) })] }) }));
}
/** F4：结构化输出校验面板。 */
function ValidatePanel() {
    const [prompt, setPrompt] = useState('');
    const [schemaText, setSchemaText] = useState('{\n  "type": "object",\n  "required": [],\n  "properties": {}\n}');
    const [casesText, setCasesText] = useState('');
    const [result, setResult] = useState();
    const [busy, setBusy] = useState(false);
    const run = useCallback(async () => {
        if (!prompt.trim())
            return;
        setBusy(true);
        setResult(undefined);
        try {
            const cases = casesText
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
            const response = await validateStructuredOutput({ prompt, schema: schemaText, cases }, { timeoutMs: 300_000 });
            setResult(response);
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '校验失败', 'error');
        }
        finally {
            setBusy(false);
        }
    }, [prompt, schemaText, casesText]);
    return (_jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "Prompt\uFF08\u8981\u6C42\u6A21\u578B\u8F93\u51FA JSON\uFF09" }), _jsx(Textarea, { value: prompt, rows: 4, placeholder: "\u4F8B\u5982\uFF1A\u63D0\u53D6\u4EE5\u4E0B\u6587\u672C\u4E2D\u7684\u4EBA\u540D\u4E0E\u5E74\u9F84\uFF0C\u8F93\u51FA JSON\u2026", onChange: (event) => setPrompt(event.target.value) }), _jsx("h3", { children: "\u671F\u671B\u7684 JSON Schema" }), _jsx(Textarea, { value: schemaText, rows: 6, onChange: (event) => setSchemaText(event.target.value) }), _jsx("h3", { children: "\u6D4B\u8BD5\u96C6\uFF08\u6BCF\u884C\u4E00\u6761\uFF0C\u53EF\u7559\u7A7A\uFF09" }), _jsx(Textarea, { value: casesText, rows: 3, onChange: (event) => setCasesText(event.target.value) }), _jsx("div", { className: styles.row, children: _jsx(Button, { variant: "primary", size: "sm", disabled: busy || !prompt.trim(), onClick: run, children: busy ? '校验中…' : '批量校验' }) }), busy && _jsx(Spinner, { label: "\u6B63\u5728\u6279\u91CF\u8C03\u7528\u5E76\u6821\u9A8C\u2026" }), result && (_jsxs(_Fragment, { children: [_jsxs("p", { className: result.complianceRate === 1 ? styles.complianceFull : styles.compliancePartial, children: ["\u5408\u89C4\u7387\uFF1A", (result.complianceRate * 100).toFixed(0), "%\uFF08", result.compliant, "/", result.total, "\uFF09", result.complianceRate === 1 ? ' · 已达 100%，可上线' : ' · 请修复不合规项后再上线'] }), _jsx("ul", { className: styles.versionList, children: result.runs.map((run) => (_jsxs("li", { className: run.ok ? styles.runOk : styles.runFail, children: [_jsxs("div", { className: styles.versionHeader, children: [_jsxs("strong", { children: ["\u7528\u4F8B ", run.caseIndex + 1] }), _jsx("span", { children: run.ok ? '合规' : run.error ? `调用失败：${run.error}` : `违规 ${run.violations.length} 项` })] }), !run.ok && run.violations.length > 0 && (_jsx("ul", { className: styles.violationList, children: run.violations.map((violation, index) => (_jsxs("li", { children: [_jsx("code", { children: violation.path || '(根)' }), "\uFF1A", violation.message] }, index))) })), _jsx("pre", { className: styles.versionContent, children: run.output.slice(0, 500) || '(无输出)' })] }, run.caseIndex))) })] }))] }));
}
