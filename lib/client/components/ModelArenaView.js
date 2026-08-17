import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 多模型竞技场视图页（模块 G 客户端 UI，挂载于 conversation.view）：
 * - G1 并行对比：输入 Prompt 勾选模型（最多 5 个），表格并排展示输出/耗时/Token/费用；
 * - G2 批量评测排行榜：导入 JSON/JSONL 测试集，跑完整评测并导出 MD/HTML 报告；
 * - G3 模型推荐：任务类型 + 预算 + 延迟要求 → 推荐排序与理由；
 * - 外部厂商 Key 管理（加密保存，不回传明文）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, Input, Select, Spinner, Textarea, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { addArenaCustomModel, downloadBlob, fetchArenaModels, fetchArenaRecommendation, removeArenaCustomModel, removeArenaKey, runArenaCompare, runArenaLeaderboard, saveArenaKey, } from '../api.js';
import styles from './ModelArenaView.module.css';
/**
 * 全模型峰谷感知徽标：
 * - 高峰时段且有峰谷分时价的模型 → 标注"高峰价"；
 * - 空闲时段且有峰谷分时价的模型 → 标注"空闲价"；
 * - 无峰谷分时价的模型 → 不显示徽标（全天统一价，价格不被篡改）。
 */
function peakBadge(model) {
    const status = model.peakStatus;
    if (status === undefined || !status.hasPeakPricing)
        return '';
    return status.isPeak ? '（高峰价）' : '（空闲价）';
}
/** 多模型竞技场视图页。 */
export function ModelArenaView(_props) {
    const [tab, setTab] = useState('compare');
    const [models, setModels] = useState([]);
    const reloadModels = useCallback(() => {
        fetchArenaModels()
            .then((response) => setModels(response.models))
            .catch((err) => Toast.push(err instanceof Error ? err.message : '加载模型目录失败', 'error'));
    }, []);
    useEffect(() => {
        reloadModels();
    }, [reloadModels]);
    return (_jsxs("div", { className: styles.root, children: [_jsx("h2", { className: styles.title, children: "\u591A\u6A21\u578B\u7ADE\u6280\u573A" }), _jsxs("div", { className: styles.tabs, children: [_jsx(Button, { size: "sm", variant: tab === 'compare' ? 'primary' : 'secondary', onClick: () => setTab('compare'), children: "\u5E76\u884C\u5BF9\u6BD4" }), _jsx(Button, { size: "sm", variant: tab === 'leaderboard' ? 'primary' : 'secondary', onClick: () => setTab('leaderboard'), children: "\u8BC4\u6D4B\u6392\u884C\u699C" }), _jsx(Button, { size: "sm", variant: tab === 'recommend' ? 'primary' : 'secondary', onClick: () => setTab('recommend'), children: "\u6A21\u578B\u63A8\u8350" }), _jsx(Button, { size: "sm", variant: tab === 'keys' ? 'primary' : 'secondary', onClick: () => setTab('keys'), children: "\u6A21\u578B\u4E0E Key \u7BA1\u7406" })] }), tab === 'compare' && _jsx(ComparePanel, { models: models }), tab === 'leaderboard' && _jsx(LeaderboardPanel, { models: models }), tab === 'recommend' && _jsx(RecommendPanel, {}), tab === 'keys' && _jsx(KeysPanel, { models: models, onChanged: reloadModels })] }));
}
/** 模型多选（最多 5 个）。 */
function useModelSelection(models) {
    const [selected, setSelected] = useState(new Set());
    const toggle = useCallback((id) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            }
            else {
                if (next.size >= 5) {
                    Toast.push('最多同时选择 5 个模型', 'warning');
                    return prev;
                }
                next.add(id);
            }
            return next;
        });
    }, []);
    void models;
    return { selected, toggle };
}
/** G1：并行对比面板。 */
function ComparePanel(props) {
    const { models } = props;
    const { selected, toggle } = useModelSelection(models);
    const [prompt, setPrompt] = useState('');
    const [results, setResults] = useState([]);
    const [busy, setBusy] = useState(false);
    const run = useCallback(async () => {
        if (!prompt.trim() || selected.size === 0)
            return;
        setBusy(true);
        setResults([]);
        try {
            const response = await runArenaCompare({ prompt, models: [...selected] }, { timeoutMs: 300_000 });
            setResults(response.results);
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '对比失败', 'error');
        }
        finally {
            setBusy(false);
        }
    }, [prompt, selected]);
    return (_jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "\u6A21\u578B\u9009\u62E9\uFF08\u6700\u591A 5 \u4E2A\uFF09" }), _jsx("div", { className: styles.modelGrid, children: models.map((model) => (_jsx("label", { className: styles.modelOption, children: _jsx(Checkbox, { checked: selected.has(model.id), label: `${model.label}${peakBadge(model)}${model.provider === 'external' && !model.keyConfigured ? '（未配置 Key）' : ''}`, onChange: () => toggle(model.id) }) }, model.id))) }), _jsx("h3", { children: "Prompt" }), _jsx(Textarea, { value: prompt, rows: 4, placeholder: "\u8F93\u5165\u8981\u5BF9\u6BD4\u7684 Prompt\u2026", onChange: (event) => setPrompt(event.target.value) }), _jsx("div", { className: styles.row, children: _jsx(Button, { variant: "primary", size: "sm", disabled: busy || !prompt.trim() || selected.size === 0, onClick: run, children: busy ? '对比中…' : '并行对比' }) }), busy && _jsx(Spinner, { label: "\u6B63\u5728\u5E76\u884C\u8C03\u7528\u591A\u4E2A\u6A21\u578B\u2026" }), results.length > 0 && (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u6A21\u578B" }), _jsx("th", { children: "\u8017\u65F6" }), _jsx("th", { children: "Token\uFF08\u8F93\u5165/\u8F93\u51FA\uFF09" }), _jsx("th", { children: "\u8D39\u7528" }), _jsx("th", { children: "\u8F93\u51FA" })] }) }), _jsx("tbody", { children: results.map((result) => (_jsxs("tr", { children: [_jsx("td", { children: result.model }), _jsx("td", { children: result.ok ? `${result.latencyMs}ms` : '失败' }), _jsx("td", { children: result.ok ? `${result.promptTokens}/${result.completionTokens}` : '-' }), _jsx("td", { children: result.ok ? `¥${result.costCny.toFixed(4)}` : '-' }), _jsx("td", { children: _jsx("pre", { className: styles.outputCell, children: result.ok ? result.output : result.error }) })] }, result.model))) })] }))] }));
}
/** G2：评测排行榜面板。 */
function LeaderboardPanel(props) {
    const { models } = props;
    const { selected, toggle } = useModelSelection(models);
    const [casesText, setCasesText] = useState('');
    const [rows, setRows] = useState([]);
    const [busy, setBusy] = useState(false);
    /** 运行评测（format 缺省返回 json 并渲染表格）。 */
    const run = useCallback(async () => {
        if (selected.size === 0 || !casesText.trim())
            return;
        setBusy(true);
        try {
            const response = await runArenaLeaderboard({ models: [...selected], cases: casesText }, { timeoutMs: 600_000 });
            if (response.format === 'json') {
                setRows(response.rows);
            }
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '评测失败', 'error');
        }
        finally {
            setBusy(false);
        }
    }, [selected, casesText]);
    /** 导出报告：复用服务端缓存的最近评测结果，不重跑评测。 */
    const exportReport = useCallback(async (format) => {
        setBusy(true);
        try {
            const response = await runArenaLeaderboard({ format, useCache: true }, { timeoutMs: 60_000 });
            if (response.format === 'markdown' || response.format === 'html') {
                const mime = response.format === 'html' ? 'text/html' : 'text/markdown';
                downloadBlob(new Blob([response.content], { type: mime }), response.fileName);
                Toast.push('评测报告已导出', 'success');
            }
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '导出失败', 'error');
        }
        finally {
            setBusy(false);
        }
    }, []);
    return (_jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "\u6A21\u578B\u9009\u62E9\uFF08\u6700\u591A 5 \u4E2A\uFF09" }), _jsx("div", { className: styles.modelGrid, children: models.map((model) => (_jsx("label", { className: styles.modelOption, children: _jsx(Checkbox, { checked: selected.has(model.id), label: `${model.label}${peakBadge(model)}`, onChange: () => toggle(model.id) }) }, model.id))) }), _jsx("h3", { children: "\u6D4B\u8BD5\u96C6\uFF08JSONL\uFF1A\u6BCF\u884C\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u5B57\u6BB5 input / expected / judge\uFF09" }), _jsx(Textarea, { value: casesText, rows: 6, placeholder: '{"input": "1+1=?", "expected": "2", "judge": "contains"}\n{"input": "翻译 hello"}', onChange: (event) => setCasesText(event.target.value) }), _jsxs("div", { className: styles.row, children: [_jsx(Button, { variant: "primary", size: "sm", disabled: busy || selected.size === 0 || !casesText.trim(), onClick: () => void run(), children: busy ? '评测中…' : '运行评测' }), _jsx(Button, { size: "sm", variant: "secondary", disabled: busy || rows.length === 0, onClick: () => void exportReport('markdown'), children: "\u5BFC\u51FA Markdown" }), _jsx(Button, { size: "sm", variant: "secondary", disabled: busy || rows.length === 0, onClick: () => void exportReport('html'), children: "\u5BFC\u51FA HTML" })] }), busy && _jsx(Spinner, { label: "\u6B63\u5728\u8DD1\u5B8C\u6574\u8BC4\u6D4B\uFF08\u53EF\u80FD\u8017\u65F6\u8F83\u957F\uFF09\u2026" }), rows.length > 0 && (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u6392\u540D" }), _jsx("th", { children: "\u6A21\u578B" }), _jsx("th", { children: "\u7EFC\u5408\u5F97\u5206" }), _jsx("th", { children: "\u6210\u529F\u7387" }), _jsx("th", { children: "\u51C6\u786E\u7387" }), _jsx("th", { children: "P50/P95/P99" }), _jsx("th", { children: "\u5E73\u5747Token" }), _jsx("th", { children: "\u5355\u4EFB\u52A1\u6210\u672C" }), _jsx("th", { children: "\u5408\u89C4\u7387" })] }) }), _jsx("tbody", { children: rows.map((row, index) => (_jsxs("tr", { children: [_jsx("td", { children: index + 1 }), _jsx("td", { children: row.model }), _jsx("td", { children: row.compositeScore.toFixed(3) }), _jsxs("td", { children: [(row.successRate * 100).toFixed(0), "%"] }), _jsx("td", { children: row.accuracy === null ? 'N/A' : `${(row.accuracy * 100).toFixed(0)}%` }), _jsx("td", { children: `${row.p50Ms}/${row.p95Ms}/${row.p99Ms}ms` }), _jsx("td", { children: row.avgTokens }), _jsx("td", { children: `¥${row.costPerTaskCny.toFixed(4)}` }), _jsx("td", { children: row.complianceRate === null ? 'N/A' : `${(row.complianceRate * 100).toFixed(0)}%` })] }, row.model))) })] }))] }));
}
/** G3：模型推荐面板。 */
function RecommendPanel() {
    const [taskType, setTaskType] = useState('code');
    const [budget, setBudget] = useState('');
    const [latency, setLatency] = useState('any');
    const [recommendations, setRecommendations] = useState([]);
    const [busy, setBusy] = useState(false);
    const run = useCallback(async () => {
        // 预算输入校验：非空时必须是合法非负数字，避免 NaN 经 JSON 变 null 发给服务端。
        let budgetPerCallCny;
        if (budget.trim() !== '') {
            const parsed = Number(budget);
            if (!Number.isFinite(parsed) || parsed < 0) {
                Toast.push('单次预算必须是非负数字', 'warning');
                return;
            }
            budgetPerCallCny = parsed;
        }
        setBusy(true);
        try {
            const response = await fetchArenaRecommendation({
                taskType,
                budgetPerCallCny,
                latency,
            });
            setRecommendations(response.recommendations);
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '推荐失败', 'error');
        }
        finally {
            setBusy(false);
        }
    }, [taskType, budget, latency]);
    return (_jsxs("section", { className: styles.section, children: [_jsxs("div", { className: styles.row, children: [_jsxs(Select, { value: taskType, onChange: (event) => setTaskType(event.target.value), children: [_jsx("option", { value: "code", children: "\u4EE3\u7801\u751F\u6210" }), _jsx("option", { value: "translation", children: "\u7FFB\u8BD1" }), _jsx("option", { value: "summarization", children: "\u6458\u8981" }), _jsx("option", { value: "reasoning", children: "\u63A8\u7406" }), _jsx("option", { value: "general", children: "\u901A\u7528" })] }), _jsx(Input, { value: budget, type: "number", placeholder: "\u5355\u6B21\u9884\u7B97\u4E0A\u9650\uFF08\u5143\uFF0C\u53EF\u7559\u7A7A\uFF09", onChange: (event) => setBudget(event.target.value) }), _jsxs(Select, { value: latency, onChange: (event) => setLatency(event.target.value), children: [_jsx("option", { value: "any", children: "\u5EF6\u8FDF\u4E0D\u9650" }), _jsx("option", { value: "fast", children: "\u5C3D\u91CF\u5FEB" }), _jsx("option", { value: "balanced", children: "\u5747\u8861" })] }), _jsx(Button, { variant: "primary", size: "sm", disabled: busy, onClick: run, children: "\u83B7\u53D6\u63A8\u8350" })] }), busy && _jsx(Spinner, { label: "\u6B63\u5728\u8BA1\u7B97\u63A8\u8350\u2026" }), recommendations.length > 0 && (_jsx("ol", { className: styles.recList, children: recommendations.map((rec, index) => (_jsxs("li", { className: styles.recItem, children: [_jsxs("div", { className: styles.recHeader, children: [_jsxs("strong", { children: ["#", index + 1, " ", rec.label] }), _jsxs("span", { className: styles.recScore, children: ["\u5F97\u5206 ", rec.score.toFixed(3)] }), rec.estimatedCostCny > 0 && _jsxs("span", { className: styles.recCost, children: ["\u4F30\u7B97 \u00A5", rec.estimatedCostCny.toFixed(4), "/\u6B21"] })] }), _jsx("p", { className: styles.recReason, children: rec.reason })] }, rec.model))) }))] }));
}
/** 外部厂商 Key 与自定义模型管理面板。 */
function KeysPanel(props) {
    const { models, onChanged } = props;
    const [editing, setEditing] = useState();
    const [apiKey, setApiKey] = useState('');
    const [baseUrl, setBaseUrl] = useState('');
    const [adding, setAdding] = useState(false);
    const [customId, setCustomId] = useState('');
    const [customLabel, setCustomLabel] = useState('');
    const [customBaseUrl, setCustomBaseUrl] = useState('');
    const [customLatency, setCustomLatency] = useState('balanced');
    const save = useCallback(async () => {
        if (!editing || !apiKey.trim())
            return;
        try {
            await saveArenaKey({ modelId: editing, apiKey, baseUrl: baseUrl || undefined });
            Toast.push('Key 已加密保存', 'success');
            setEditing(undefined);
            setApiKey('');
            setBaseUrl('');
            onChanged();
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '保存失败', 'error');
        }
    }, [editing, apiKey, baseUrl, onChanged]);
    const remove = useCallback(async (modelId) => {
        try {
            await removeArenaKey(modelId);
            Toast.push('Key 已删除', 'success');
            onChanged();
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '删除失败', 'error');
        }
    }, [onChanged]);
    /** 添加自定义模型（前端先做基础校验，服务端再做冲突与格式校验）。 */
    const addCustom = useCallback(async () => {
        if (!customId.trim() || !customLabel.trim() || !customBaseUrl.trim())
            return;
        if (!/^https?:\/\//i.test(customBaseUrl.trim())) {
            Toast.push('API 基址必须以 http:// 或 https:// 开头', 'warning');
            return;
        }
        try {
            await addArenaCustomModel({
                modelId: customId.trim(),
                label: customLabel.trim(),
                baseUrl: customBaseUrl.trim(),
                latencyTier: customLatency,
            });
            Toast.push('自定义模型已添加，请为其配置 API Key', 'success');
            setAdding(false);
            setCustomId('');
            setCustomLabel('');
            setCustomBaseUrl('');
            setCustomLatency('balanced');
            onChanged();
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '添加失败', 'error');
        }
    }, [customId, customLabel, customBaseUrl, customLatency, onChanged]);
    const removeCustom = useCallback(async (modelId) => {
        try {
            await removeArenaCustomModel(modelId);
            Toast.push('自定义模型已删除', 'success');
            onChanged();
        }
        catch (err) {
            Toast.push(err instanceof Error ? err.message : '删除失败', 'error');
        }
    }, [onChanged]);
    return (_jsxs("section", { className: styles.section, children: [_jsx("p", { className: styles.hint, children: "\u5916\u90E8\u5382\u5546 Key \u4EE5 AES-256-GCM \u52A0\u5BC6\u4FDD\u5B58\u5728\u672C\u5730\u4FDD\u9669\u5E93\uFF0C\u4EFB\u4F55\u63A5\u53E3\u4E0D\u56DE\u4F20\u660E\u6587\u3002\u81EA\u5B9A\u4E49\u6A21\u578B\u8D70 OpenAI \u517C\u5BB9 chat/completions \u534F\u8BAE\uFF0C\u6A21\u578B id \u82E5\u4E0E\u4EF7\u683C\u76EE\u5F55\u4E00\u81F4\u53EF\u81EA\u52A8\u4F30\u7B97\u6210\u672C\u3002\u5382\u5546\u5B98\u65B9\u5B9A\u4EF7\u9875\u5B9E\u65F6\u6293\u53D6\u7684\u65B0\u6A21\u578B \u4F1A\u81EA\u52A8\u51FA\u73B0\u5728\u76EE\u5F55\u4E2D\uFF0C\u65E0\u9700\u624B\u5DE5\u7EF4\u62A4\u3002" }), _jsx("div", { className: styles.row, children: _jsx(Button, { size: "sm", variant: "primary", onClick: () => setAdding((prev) => !prev), children: adding ? '收起' : '添加自定义模型' }) }), adding && (_jsxs("div", { className: styles.keyForm, children: [_jsx(Input, { value: customId, placeholder: "\u6A21\u578B id\uFF08API \u8C03\u7528\u7684 model \u53C2\u6570\uFF0C\u5982 glm-5.2\uFF09", onChange: (event) => setCustomId(event.target.value) }), _jsx(Input, { value: customLabel, placeholder: "\u5C55\u793A\u540D\u79F0\uFF08\u5982 \u667A\u8C31 GLM-5.2\uFF09", onChange: (event) => setCustomLabel(event.target.value) }), _jsx(Input, { value: customBaseUrl, placeholder: "API \u57FA\u5740\uFF08\u5982 https://open.bigmodel.cn/api/paas/v4\uFF09", onChange: (event) => setCustomBaseUrl(event.target.value) }), _jsxs("div", { className: styles.row, children: [_jsxs(Select, { value: customLatency, onChange: (event) => setCustomLatency(event.target.value), children: [_jsx("option", { value: "fast", children: "\u5EF6\u8FDF\u6863\u4F4D\uFF1A\u5FEB" }), _jsx("option", { value: "balanced", children: "\u5EF6\u8FDF\u6863\u4F4D\uFF1A\u5747\u8861" }), _jsx("option", { value: "slow", children: "\u5EF6\u8FDF\u6863\u4F4D\uFF1A\u6162" })] }), _jsx(Button, { size: "sm", variant: "primary", disabled: !customId.trim() || !customLabel.trim() || !customBaseUrl.trim(), onClick: addCustom, children: "\u4FDD\u5B58\u6A21\u578B" })] })] })), models
                .filter((model) => model.provider === 'external')
                .map((model) => (_jsxs("div", { className: styles.keyRow, children: [_jsxs("div", { className: styles.keyInfo, children: [_jsx("strong", { children: model.label }), model.custom && _jsx("span", { className: styles.keyMissing, children: "\u81EA\u5B9A\u4E49" }), _jsx("span", { className: model.keyConfigured ? styles.keyOk : styles.keyMissing, children: model.keyConfigured ? '已配置' : '未配置' })] }), editing === model.id ? (_jsxs("div", { className: styles.keyForm, children: [_jsx(Input, { value: apiKey, type: "password", placeholder: "API Key", onChange: (event) => setApiKey(event.target.value) }), _jsx(Input, { value: baseUrl, placeholder: `API 基址（缺省 ${model.id} 官方）`, onChange: (event) => setBaseUrl(event.target.value) }), _jsxs("div", { className: styles.row, children: [_jsx(Button, { size: "sm", variant: "primary", disabled: !apiKey.trim(), onClick: save, children: "\u4FDD\u5B58" }), _jsx(Button, { size: "sm", variant: "ghost", onClick: () => setEditing(undefined), children: "\u53D6\u6D88" })] })] })) : (_jsxs("div", { className: styles.row, children: [_jsx(Button, { size: "sm", variant: "secondary", onClick: () => setEditing(model.id), children: model.keyConfigured ? '更换 Key' : '配置 Key' }), model.custom && (_jsx(Button, { size: "sm", variant: "danger", onClick: () => removeCustom(model.id), children: "\u5220\u9664\u6A21\u578B" })), model.keyConfigured && !model.custom && (_jsx(Button, { size: "sm", variant: "danger", onClick: () => remove(model.id), children: "\u5220\u9664" }))] }))] }, model.id)))] }));
}
