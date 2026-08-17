import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 安全与审计视图页（模块 J 客户端 UI，挂载于 conversation.view）：
 * - J1 API Key 安全管理：多 Key 配置/激活/删除、权限范围、轮换提醒、泄露检测；
 * - J2 操作审计日志：时间/模型/状态筛选、CSV/JSON 导出（脱敏后落盘）；
 * - J3 数据防泄漏（DLP）：总开关/严格模式、内置+自定义规则、发送前预检扫描；
 * - J4 合规报表：调用/费用/模型占比/拦截/告警汇总，导出自包含 HTML（可打印为 PDF）。
 *
 * 安全红线：任何界面不回传 Key 明文，仅展示掩码元数据。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input, Select, Textarea, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { activateSecurityKey, addDlpRule, checkKeyLeak, deleteDlpRule, deleteSecurityKey, exportAuditLog, exportComplianceReport, fetchAuditLog, fetchComplianceReport, fetchDlpState, fetchSecurityKeys, saveSecurityKey, scanDlp, toggleDlpRule, updateDlpSettings, } from '../api.js';
import { downloadBlob, openPrintHtml } from '../api.js';
import styles from './SecurityAuditView.module.css';
/** 安全与审计视图页。 */
export function SecurityAuditView(_props) {
    const [tab, setTab] = useState('keys');
    return (_jsxs("div", { className: styles.root, children: [_jsx("h2", { className: styles.title, children: "\u5B89\u5168\u4E0E\u5BA1\u8BA1" }), _jsxs("div", { className: styles.tabs, children: [_jsx(Button, { size: "sm", variant: tab === 'keys' ? 'primary' : 'secondary', onClick: () => setTab('keys'), children: "API Key \u7BA1\u7406" }), _jsx(Button, { size: "sm", variant: tab === 'audit' ? 'primary' : 'secondary', onClick: () => setTab('audit'), children: "\u5BA1\u8BA1\u65E5\u5FD7" }), _jsx(Button, { size: "sm", variant: tab === 'dlp' ? 'primary' : 'secondary', onClick: () => setTab('dlp'), children: "\u6570\u636E\u9632\u6CC4\u6F0F" }), _jsx(Button, { size: "sm", variant: tab === 'report' ? 'primary' : 'secondary', onClick: () => setTab('report'), children: "\u5408\u89C4\u62A5\u8868" })] }), tab === 'keys' && _jsx(KeysPanel, {}), tab === 'audit' && _jsx(AuditPanel, {}), tab === 'dlp' && _jsx(DlpPanel, {}), tab === 'report' && _jsx(ReportPanel, {})] }));
}
/** 错误提示统一转 Toast。 */
function reportError(error, fallback) {
    Toast.push(error instanceof Error ? error.message : fallback, 'error');
}
/** 时间戳格式化（0 显示为 -）。 */
function formatTime(ts) {
    if (!ts)
        return '-';
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
/** 北京时间日键（YYYY-MM-DD）。 */
function beijingDay(ts) {
    const shifted = new Date(ts + 8 * 3600_000);
    return shifted.toISOString().slice(0, 10);
}
// ---------------------------------------------------------------------------
// J1：API Key 安全管理
// ---------------------------------------------------------------------------
/** Key 管理面板。 */
function KeysPanel() {
    const [keys, setKeys] = useState([]);
    const [rotationDays, setRotationDays] = useState(30);
    const [form, setForm] = useState({
        name: '',
        apiKey: '',
        note: '',
        access: 'full',
        models: '',
        dailyBudgetCny: '0',
    });
    const [leakInput, setLeakInput] = useState('');
    const reload = useCallback(() => {
        fetchSecurityKeys()
            .then((response) => {
            setKeys(response.keys);
            setRotationDays(response.rotationDays);
        })
            .catch((error) => reportError(error, '加载 Key 列表失败'));
    }, []);
    useEffect(() => {
        reload();
    }, [reload]);
    const submit = () => {
        if (!form.name.trim() || !form.apiKey.trim()) {
            Toast.push('Key 名称与明文必填', 'warning');
            return;
        }
        saveSecurityKey({
            name: form.name.trim(),
            apiKey: form.apiKey.trim(),
            note: form.note.trim(),
            scope: {
                access: form.access === 'read' ? 'read' : 'full',
                models: form.models
                    .split(',')
                    .map((m) => m.trim())
                    .filter((m) => m.length > 0),
                dailyBudgetCny: Number(form.dailyBudgetCny) || 0,
            },
        })
            .then(() => {
            Toast.push('Key 已加密保存', 'success');
            setForm({ name: '', apiKey: '', note: '', access: 'full', models: '', dailyBudgetCny: '0' });
            reload();
        })
            .catch((error) => reportError(error, '保存 Key 失败'));
    };
    const runLeakCheck = () => {
        if (!leakInput.trim())
            return;
        checkKeyLeak(leakInput)
            .then((response) => {
            if (response.safe) {
                Toast.push('未检测到已知 API Key 泄露', 'success');
            }
            else {
                Toast.push(`检测到泄露：${response.leaked.join('、')}`, 'error');
            }
        })
            .catch((error) => reportError(error, '泄露检测失败'));
    };
    return (_jsxs(_Fragment, { children: [_jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "\u65B0\u589E API Key\uFF08\u52A0\u5BC6\u843D\u76D8\uFF0C\u4E0D\u56DE\u4F20\u660E\u6587\uFF09" }), _jsxs("div", { className: styles.formGrid, children: [_jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u540D\u79F0\uFF08\u5982\u9879\u76EE\u540D\uFF09" }), _jsx(Input, { value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "API Key \u660E\u6587" }), _jsx(Input, { type: "password", value: form.apiKey, onChange: (event) => setForm({ ...form, apiKey: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6743\u9650\u8303\u56F4" }), _jsxs(Select, { value: form.access, onChange: (event) => setForm({ ...form, access: event.target.value }), children: [_jsx("option", { value: "full", children: "\u4E0D\u9650" }), _jsx("option", { value: "read", children: "\u53EA\u8BFB" })] })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u9650\u5B9A\u6A21\u578B\u524D\u7F00\uFF08\u9017\u53F7\u5206\u9694\uFF0C\u7A7A=\u4E0D\u9650\uFF09" }), _jsx(Input, { value: form.models, placeholder: "deepseek-v4-flash", onChange: (event) => setForm({ ...form, models: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u65E5\u9884\u7B97\u4E0A\u9650\uFF08\u5143\uFF0C0=\u4E0D\u9650\uFF09" }), _jsx(Input, { type: "number", value: form.dailyBudgetCny, onChange: (event) => setForm({ ...form, dailyBudgetCny: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u5907\u6CE8" }), _jsx(Input, { value: form.note, onChange: (event) => setForm({ ...form, note: event.target.value }) })] })] }), _jsx("div", { children: _jsx(Button, { size: "sm", variant: "primary", onClick: submit, children: "\u4FDD\u5B58 Key" }) }), _jsxs("p", { className: styles.hint, children: ["\u8F6E\u6362\u63D0\u9192\u9608\u503C\uFF1A\u4F7F\u7528\u8D85\u8FC7 ", rotationDays, " \u5929\u4F1A\u6807\u8BB0\u4E3A\u5F85\u8F6E\u6362\u3002"] })] }), _jsxs("section", { className: styles.section, children: [_jsxs("div", { className: styles.sectionHeader, children: [_jsx("h3", { children: "\u5DF2\u914D\u7F6E Key" }), _jsx(Button, { size: "sm", variant: "secondary", onClick: reload, children: "\u5237\u65B0" })] }), keys.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u6682\u65E0\u547D\u540D Key\u3002" })) : (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u540D\u79F0" }), _jsx("th", { children: "\u6743\u9650" }), _jsx("th", { children: "\u521B\u5EFA\u65F6\u95F4" }), _jsx("th", { children: "\u6700\u8FD1\u4F7F\u7528" }), _jsx("th", { children: "\u72B6\u6001" }), _jsx("th", { children: "\u64CD\u4F5C" })] }) }), _jsx("tbody", { children: keys.map((key) => (_jsxs("tr", { children: [_jsxs("td", { children: [key.name, key.note ? `（${key.note}）` : ''] }), _jsxs("td", { children: [key.scope.access === 'read' ? '只读' : '不限', key.scope.models.length > 0 ? ` · ${key.scope.models.join('/')}` : '', key.scope.dailyBudgetCny > 0 ? ` · ¥${key.scope.dailyBudgetCny}/天` : ''] }), _jsx("td", { children: formatTime(key.createdAt) }), _jsx("td", { children: formatTime(key.lastUsedAt) }), _jsx("td", { children: key.rotationDue ? _jsx("span", { className: `${styles.pill} ${styles.pillWarning}`, children: "\u5F85\u8F6E\u6362" }) : _jsx("span", { className: styles.pill, children: "\u6B63\u5E38" }) }), _jsx("td", { children: _jsxs("div", { className: styles.rowActions, children: [_jsx(Button, { size: "sm", variant: "primary", onClick: () => activateSecurityKey(key.name).then(() => Toast.push(`已激活 ${key.name}`, 'success')).catch((error) => reportError(error, '激活失败')), children: "\u6FC0\u6D3B" }), _jsx(Button, { size: "sm", variant: "danger", onClick: () => deleteSecurityKey(key.name).then(() => { Toast.push('已删除', 'success'); reload(); }).catch((error) => reportError(error, '删除失败')), children: "\u5220\u9664" })] }) })] }, key.name))) })] }))] }), _jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "Key \u6CC4\u9732\u68C0\u6D4B" }), _jsx("p", { className: styles.hint, children: "\u7C98\u8D34\u7591\u4F3C\u6CC4\u9732\u7684\u4EE3\u7801/\u63D0\u4EA4\u5185\u5BB9\uFF0C\u68C0\u67E5\u662F\u5426\u5305\u542B\u5DF2\u914D\u7F6E\u7684 API Key\u3002" }), _jsx(Textarea, { rows: 4, value: leakInput, onChange: (event) => setLeakInput(event.target.value) }), _jsx("div", { children: _jsx(Button, { size: "sm", variant: "secondary", onClick: runLeakCheck, children: "\u68C0\u6D4B" }) })] })] }));
}
// ---------------------------------------------------------------------------
// J2：操作审计日志
// ---------------------------------------------------------------------------
/** 审计日志面板。 */
function AuditPanel() {
    const [entries, setEntries] = useState([]);
    const [filter, setFilter] = useState({ model: '', status: '', limit: '200' });
    const reload = useCallback(() => {
        fetchAuditLog({
            model: filter.model.trim() || undefined,
            status: filter.status.trim() || undefined,
            limit: Number(filter.limit) || 200,
        })
            .then((response) => setEntries(response.entries))
            .catch((error) => reportError(error, '加载审计日志失败'));
    }, [filter]);
    // 仅挂载时自动加载一次；筛选条件变化不触发请求，由「查询」按钮显式触发，
    // 避免每敲一个字符就发一次请求。
    const initialLoaded = useRef(false);
    useEffect(() => {
        if (initialLoaded.current)
            return;
        initialLoaded.current = true;
        reload();
    }, [reload]);
    const doExport = (format) => {
        exportAuditLog({ format })
            .then((response) => {
            const blob = new Blob([response.content], { type: format === 'csv' ? 'text/csv' : 'application/json' });
            downloadBlob(blob, response.fileName);
        })
            .catch((error) => reportError(error, '导出失败'));
    };
    return (_jsxs("section", { className: styles.section, children: [_jsxs("div", { className: styles.sectionHeader, children: [_jsx("h3", { children: "\u64CD\u4F5C\u5BA1\u8BA1\u65E5\u5FD7\uFF08Prompt \u6458\u8981\u5DF2\u8131\u654F\uFF09" }), _jsxs("div", { className: styles.rowActions, children: [_jsx(Button, { size: "sm", variant: "secondary", onClick: () => doExport('csv'), children: "\u5BFC\u51FA CSV" }), _jsx(Button, { size: "sm", variant: "secondary", onClick: () => doExport('json'), children: "\u5BFC\u51FA JSON" })] })] }), _jsxs("div", { className: styles.formGrid, children: [_jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6A21\u578B\u7B5B\u9009" }), _jsx(Input, { value: filter.model, onChange: (event) => setFilter({ ...filter, model: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u72B6\u6001\u7B5B\u9009\uFF08ok / TIMEOUT / AUTH_FAILED\u2026\uFF09" }), _jsx(Input, { value: filter.status, onChange: (event) => setFilter({ ...filter, status: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6761\u6570\u4E0A\u9650" }), _jsx(Input, { type: "number", value: filter.limit, onChange: (event) => setFilter({ ...filter, limit: event.target.value }) })] }), _jsx("div", { className: styles.field, children: _jsx(Button, { size: "sm", variant: "primary", onClick: reload, children: "\u67E5\u8BE2" }) })] }), entries.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u6682\u65E0\u5BA1\u8BA1\u8BB0\u5F55\u3002" })) : (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u65F6\u95F4" }), _jsx("th", { children: "\u6A21\u578B" }), _jsx("th", { children: "Prompt \u6458\u8981" }), _jsx("th", { children: "Token" }), _jsx("th", { children: "\u8D39\u7528" }), _jsx("th", { children: "\u72B6\u6001" }), _jsx("th", { children: "\u6765\u6E90" })] }) }), _jsx("tbody", { children: entries.map((entry) => (_jsxs("tr", { children: [_jsx("td", { children: formatTime(entry.ts) }), _jsx("td", { children: entry.model }), _jsx("td", { children: entry.promptSummary }), _jsxs("td", { children: [entry.promptTokens, "/", entry.completionTokens] }), _jsxs("td", { children: ["\u00A5", entry.costCny.toFixed(4)] }), _jsx("td", { children: entry.status === 'ok' ? (_jsx("span", { className: `${styles.pill} ${styles.pillSuccess}`, children: "ok" })) : (_jsx("span", { className: `${styles.pill} ${styles.pillDanger}`, children: entry.status })) }), _jsx("td", { children: entry.source })] }, entry.id))) })] }))] }));
}
// ---------------------------------------------------------------------------
// J3：数据防泄漏（DLP）
// ---------------------------------------------------------------------------
/** DLP 面板。 */
function DlpPanel() {
    const [settings, setSettings] = useState(null);
    const [rules, setRules] = useState([]);
    const [newRule, setNewRule] = useState({ name: '', pattern: '' });
    const [scanText, setScanText] = useState('');
    const [findings, setFindings] = useState(null);
    const reload = useCallback(() => {
        fetchDlpState()
            .then((response) => {
            setSettings(response.settings);
            setRules(response.rules);
        })
            .catch((error) => reportError(error, '加载 DLP 状态失败'));
    }, []);
    useEffect(() => {
        reload();
    }, [reload]);
    const toggleSetting = (patch) => {
        updateDlpSettings(patch)
            .then((response) => setSettings(response.settings))
            .catch((error) => reportError(error, '更新设置失败'));
    };
    const submitRule = () => {
        if (!newRule.name.trim() || !newRule.pattern.trim()) {
            Toast.push('规则名称与正则必填', 'warning');
            return;
        }
        addDlpRule({ name: newRule.name.trim(), pattern: newRule.pattern.trim() })
            .then((response) => {
            setRules(response.rules);
            setNewRule({ name: '', pattern: '' });
            Toast.push('规则已添加', 'success');
        })
            .catch((error) => reportError(error, '添加规则失败'));
    };
    const runScan = () => {
        if (!scanText.trim())
            return;
        scanDlp(scanText)
            .then((response) => {
            setFindings(response.findings);
            if (response.clean)
                Toast.push('未检测到敏感内容', 'success');
            else
                Toast.push(`检测到 ${response.findings.length} 类敏感内容`, 'warning');
        })
            .catch((error) => reportError(error, '扫描失败'));
    };
    return (_jsxs(_Fragment, { children: [_jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "DLP \u8BBE\u7F6E" }), settings === null ? (_jsx("p", { className: styles.empty, children: "\u52A0\u8F7D\u4E2D\u2026" })) : (_jsxs("div", { className: styles.rowActions, children: [_jsx(Checkbox, { checked: settings.enabled, label: "\u542F\u7528\u53D1\u9001\u524D\u654F\u611F\u5185\u5BB9\u626B\u63CF", onChange: (checked) => toggleSetting({ enabled: checked }) }), _jsx(Checkbox, { checked: settings.strict, label: "\u4E25\u683C\u6A21\u5F0F\uFF1A\u68C0\u6D4B\u5230\u654F\u611F\u5185\u5BB9\u76F4\u63A5\u62E6\u622A\uFF08\u5426\u5219\u4EC5\u8B66\u544A\uFF09", onChange: (checked) => toggleSetting({ strict: checked }) })] }))] }), _jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "\u68C0\u6D4B\u89C4\u5219\uFF08\u5185\u7F6E + \u81EA\u5B9A\u4E49\uFF09" }), rules.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u6682\u65E0\u89C4\u5219\u3002" })) : (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u540D\u79F0" }), _jsx("th", { children: "\u7C7B\u578B" }), _jsx("th", { children: "\u6B63\u5219" }), _jsx("th", { children: "\u542F\u7528" }), _jsx("th", { children: "\u64CD\u4F5C" })] }) }), _jsx("tbody", { children: rules.map((rule) => (_jsxs("tr", { children: [_jsx("td", { children: rule.name }), _jsx("td", { children: rule.builtin ? '内置' : '自定义' }), _jsx("td", { children: _jsx("code", { children: rule.pattern }) }), _jsx("td", { children: _jsx(Checkbox, { checked: rule.enabled, onChange: (checked) => toggleDlpRule(rule.id, checked)
                                                    .then((response) => setRules(response.rules))
                                                    .catch((error) => reportError(error, '切换失败')) }) }), _jsx("td", { children: !rule.builtin && (_jsx(Button, { size: "sm", variant: "danger", onClick: () => deleteDlpRule(rule.id)
                                                    .then((response) => setRules(response.rules))
                                                    .catch((error) => reportError(error, '删除失败')), children: "\u5220\u9664" })) })] }, rule.id))) })] })), _jsxs("div", { className: styles.formGrid, children: [_jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u81EA\u5B9A\u4E49\u89C4\u5219\u540D\u79F0" }), _jsx(Input, { value: newRule.name, onChange: (event) => setNewRule({ ...newRule, name: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6B63\u5219\u8868\u8FBE\u5F0F" }), _jsx(Input, { value: newRule.pattern, placeholder: "\u5982\u5185\u90E8\u5DE5\u53F7 \\\\bEMP\\\\d{6}\\\\b", onChange: (event) => setNewRule({ ...newRule, pattern: event.target.value }) })] })] }), _jsx("div", { children: _jsx(Button, { size: "sm", variant: "primary", onClick: submitRule, children: "\u6DFB\u52A0\u81EA\u5B9A\u4E49\u89C4\u5219" }) })] }), _jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "\u53D1\u9001\u524D\u9884\u68C0\u626B\u63CF" }), _jsx(Textarea, { rows: 4, value: scanText, onChange: (event) => setScanText(event.target.value) }), _jsx("div", { children: _jsx(Button, { size: "sm", variant: "secondary", onClick: runScan, children: "\u626B\u63CF" }) }), findings !== null &&
                        (findings.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u5185\u5BB9\u5E72\u51C0\uFF0C\u53EF\u5B89\u5168\u53D1\u9001\u3002" })) : (_jsx("ul", { className: styles.findingList, children: findings.map((finding) => (_jsxs("li", { className: styles.findingItem, children: [finding.ruleName, " \u00D7 ", finding.count, "\uFF08\u793A\u4F8B\uFF1A", finding.sample, "\uFF09"] }, finding.ruleId))) })))] })] }));
}
// ---------------------------------------------------------------------------
// J4：合规报表
// ---------------------------------------------------------------------------
/** 合规报表面板。 */
function ReportPanel() {
    const today = Date.now();
    const [from, setFrom] = useState(beijingDay(today - 6 * 24 * 3600_000));
    const [to, setTo] = useState(beijingDay(today));
    const [report, setReport] = useState(null);
    const load = useCallback(() => {
        fetchComplianceReport({ from, to })
            .then((response) => setReport(response))
            .catch((error) => reportError(error, '加载合规报表失败'));
    }, [from, to]);
    useEffect(() => {
        load();
    }, [load]);
    const doExport = () => {
        exportComplianceReport({ from, to })
            .then((response) => {
            // 自包含 HTML：新窗口打印，可另存为 PDF 提交安全团队。
            openPrintHtml(response.content);
        })
            .catch((error) => reportError(error, '导出报表失败'));
    };
    return (_jsxs("section", { className: styles.section, children: [_jsxs("div", { className: styles.sectionHeader, children: [_jsx("h3", { children: "\u5408\u89C4\u62A5\u8868" }), _jsxs("div", { className: styles.rowActions, children: [_jsx(Input, { type: "date", value: from, onChange: (event) => setFrom(event.target.value) }), _jsx(Input, { type: "date", value: to, onChange: (event) => setTo(event.target.value) }), _jsx(Button, { size: "sm", variant: "primary", onClick: load, children: "\u67E5\u8BE2" }), _jsx(Button, { size: "sm", variant: "secondary", onClick: doExport, children: "\u5BFC\u51FA\uFF08\u6253\u5370\u4E3A PDF\uFF09" })] })] }), report === null ? (_jsx("p", { className: styles.empty, children: "\u52A0\u8F7D\u4E2D\u2026" })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: styles.statGrid, children: [_jsxs("div", { className: styles.statCard, children: [_jsx("span", { className: styles.statValue, children: report.totalCalls }), _jsx("span", { className: styles.statLabel, children: "API \u8C03\u7528\u603B\u91CF" })] }), _jsxs("div", { className: styles.statCard, children: [_jsxs("span", { className: styles.statValue, children: ["\u00A5", report.totalCostCny.toFixed(4)] }), _jsx("span", { className: styles.statLabel, children: "\u603B\u8D39\u7528" })] }), _jsxs("div", { className: styles.statCard, children: [_jsx("span", { className: styles.statValue, children: report.totalTokens }), _jsx("span", { className: styles.statLabel, children: "\u603B Token \u6D88\u8017" })] }), _jsxs("div", { className: styles.statCard, children: [_jsx("span", { className: styles.statValue, children: report.blockTotal }), _jsx("span", { className: styles.statLabel, children: "\u654F\u611F\u5185\u5BB9\u62E6\u622A\u6B21\u6570" })] })] }), _jsx("h3", { children: "\u5404\u6A21\u578B\u4F7F\u7528\u5360\u6BD4" }), Object.keys(report.modelShare).length === 0 ? (_jsx("p", { className: styles.empty, children: "\u65E0\u6570\u636E\u3002" })) : (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u6A21\u578B" }), _jsx("th", { children: "\u5360\u6BD4" })] }) }), _jsx("tbody", { children: Object.entries(report.modelShare).map(([model, share]) => (_jsxs("tr", { children: [_jsx("td", { children: model }), _jsxs("td", { children: [(share * 100).toFixed(1), "%"] })] }, model))) })] })), _jsx("h3", { children: "\u654F\u611F\u5185\u5BB9\u62E6\u622A\u7EDF\u8BA1" }), Object.keys(report.blocks).length === 0 ? (_jsx("p", { className: styles.empty, children: "\u65E0\u62E6\u622A\u8BB0\u5F55\u3002" })) : (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u89C4\u5219" }), _jsx("th", { children: "\u6B21\u6570" })] }) }), _jsx("tbody", { children: Object.entries(report.blocks).map(([ruleName, count]) => (_jsxs("tr", { children: [_jsx("td", { children: ruleName }), _jsx("td", { children: count })] }, ruleName))) })] })), _jsx("h3", { children: "\u5F02\u5E38\u8C03\u7528\u544A\u8B66\u8BB0\u5F55" }), report.alerts.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u65E0\u544A\u8B66\u3002" })) : (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u65F6\u95F4" }), _jsx("th", { children: "\u7C7B\u578B" }), _jsx("th", { children: "\u8BE6\u60C5" })] }) }), _jsx("tbody", { children: report.alerts.map((alert) => (_jsxs("tr", { children: [_jsx("td", { children: formatTime(alert.ts) }), _jsx("td", { children: _jsx("span", { className: `${styles.pill} ${styles.pillDanger}`, children: alert.kind }) }), _jsx("td", { children: alert.detail })] }, `${alert.ts}-${alert.kind}`))) })] }))] }))] }));
}
