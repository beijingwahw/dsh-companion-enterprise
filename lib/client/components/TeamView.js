import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 协作与知识管理视图页（模块 I 客户端 UI，挂载于 conversation.view）：
 * - I1 团队配置同步：成员署名与缺省合并策略、导出配置快照（JSON 下载）、
 *   导入配置快照（文件选择 → diff 预览 → 按策略导入 → 分区汇报）、快照归档管理；
 * - I2 执行经验库：关键词/标签/模型检索、手动创建卡片、
 *   卡片详情（笔记列表与笔记补充）、卡片删除；
 * - I3 Prompt 协作评审：评审列表与创建、评审详情（基线/提议对比、
 *   评论批注、通过/拒绝、合并主版本）与删除。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Modal, Pill, Select, Spinner, Textarea, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { addExperienceNote, addReviewComment, createExperienceCard, createReview, decideReview, deleteExperienceCard, deleteReview, deleteTeamSnapshot, diffTeamConfig, downloadBlob, exportTeamConfig, fetchExperienceCards, fetchReviewDetail, fetchReviews, fetchTeamPrefs, fetchTeamSnapshots, importTeamConfig, mergeReview, saveTeamPrefs, } from '../api.js';
import styles from './TeamView.module.css';
/** 协作与知识管理视图页。 */
export function TeamView(_props) {
    const [tab, setTab] = useState('sync');
    return (_jsxs("div", { className: styles.root, children: [_jsx("h2", { className: styles.title, children: "\u534F\u4F5C\u4E0E\u77E5\u8BC6\u7BA1\u7406" }), _jsxs("div", { className: styles.tabs, children: [_jsx(Button, { size: "sm", variant: tab === 'sync' ? 'primary' : 'secondary', onClick: () => setTab('sync'), children: "\u914D\u7F6E\u540C\u6B65" }), _jsx(Button, { size: "sm", variant: tab === 'experience' ? 'primary' : 'secondary', onClick: () => setTab('experience'), children: "\u7ECF\u9A8C\u5E93" }), _jsx(Button, { size: "sm", variant: tab === 'review' ? 'primary' : 'secondary', onClick: () => setTab('review'), children: "\u8BC4\u5BA1" })] }), tab === 'sync' && _jsx(SyncPanel, {}), tab === 'experience' && _jsx(ExperiencePanel, {}), tab === 'review' && _jsx(ReviewPanel, {})] }));
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
/** 时长格式化。 */
function formatDuration(ms) {
    if (!ms || ms <= 0)
        return '-';
    if (ms < 1000)
        return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}
/** JSON 预览（超长截断）。 */
function previewJson(value) {
    if (value === undefined)
        return '-';
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}
/** 配置分区中文名。 */
const SECTION_LABELS = {
    costSettings: '成本设置',
    pricingOverrides: '单价覆盖',
    handoffTemplates: '交接模板',
    promptTemplates: 'Prompt 模板',
    pipelines: '流水线',
    scheduledJobs: '定时任务',
    dlpRules: 'DLP 规则',
};
/** 合并策略中文名。 */
const STRATEGY_LABELS = {
    local: '本地优先',
    remote: '远程优先',
    manual: '手动合并',
};
/** diff 动作中文名。 */
const ACTION_LABELS = {
    add: '新增',
    update: '更新',
    same: '一致',
    'local-only': '仅本地',
};
/** 经验卡片来源中文名。 */
const SOURCE_LABELS = {
    pipeline: '流水线',
    queue: '批量队列',
    cron: '定时任务',
    manual: '手动',
};
// ---------------------------------------------------------------------------
// I1：团队配置同步
// ---------------------------------------------------------------------------
/** 配置同步面板。 */
function SyncPanel() {
    const fileRef = useRef(null);
    const [prefs, setPrefs] = useState(null);
    const [memberName, setMemberName] = useState('');
    const [defaultStrategy, setDefaultStrategy] = useState('manual');
    const [savingPrefs, setSavingPrefs] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [snapshots, setSnapshots] = useState([]);
    const [pendingSnapshot, setPendingSnapshot] = useState(null);
    const [diffs, setDiffs] = useState(null);
    const [diffing, setDiffing] = useState(false);
    const [importStrategy, setImportStrategy] = useState('manual');
    const [importing, setImporting] = useState(false);
    const [reports, setReports] = useState(null);
    const [viewing, setViewing] = useState(null);
    const [deletingKey, setDeletingKey] = useState(null);
    const reload = useCallback(() => {
        Promise.all([fetchTeamPrefs(), fetchTeamSnapshots()])
            .then(([prefsRes, snapsRes]) => {
            setPrefs(prefsRes.prefs);
            setMemberName(prefsRes.prefs.memberName);
            setDefaultStrategy(prefsRes.prefs.defaultStrategy);
            setImportStrategy(prefsRes.prefs.defaultStrategy);
            setSnapshots(snapsRes.snapshots);
        })
            .catch((error) => reportError(error, '加载团队配置失败'));
    }, []);
    useEffect(() => {
        reload();
    }, [reload]);
    /** 保存团队偏好。 */
    const savePrefs = () => {
        setSavingPrefs(true);
        saveTeamPrefs({ memberName: memberName.trim(), defaultStrategy })
            .then((response) => {
            setPrefs(response.prefs);
            setMemberName(response.prefs.memberName);
            setDefaultStrategy(response.prefs.defaultStrategy);
            Toast.push('团队偏好已保存', 'success');
        })
            .catch((error) => reportError(error, '保存团队偏好失败'))
            .finally(() => setSavingPrefs(false));
    };
    /** 导出配置快照为 JSON 文件。 */
    const doExport = () => {
        setExporting(true);
        exportTeamConfig()
            .then((response) => {
            const blob = new Blob([JSON.stringify(response.snapshot, null, 2)], { type: 'application/json' });
            const day = new Date().toISOString().slice(0, 10);
            downloadBlob(blob, `team-config-${day}.json`);
            Toast.push('配置快照已导出', 'success');
        })
            .catch((error) => reportError(error, '导出配置快照失败'))
            .finally(() => setExporting(false));
    };
    /** 选择 JSON 文件：解析后请求 diff 预览。 */
    const onPickFile = (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file)
            return;
        setDiffing(true);
        setReports(null);
        file
            .text()
            .then((text) => {
            let snapshot;
            try {
                snapshot = JSON.parse(text);
            }
            catch {
                throw new Error('所选文件不是合法 JSON');
            }
            return diffTeamConfig(snapshot).then((response) => {
                setPendingSnapshot(snapshot);
                setDiffs(response.diffs);
                Toast.push(`快照解析成功，共 ${response.diffs.length} 条差异`, 'info');
            });
        })
            .catch((error) => {
            setPendingSnapshot(null);
            setDiffs(null);
            reportError(error, '解析配置快照失败');
        })
            .finally(() => setDiffing(false));
    };
    /** 按所选策略执行导入。 */
    const runImport = () => {
        if (pendingSnapshot === null)
            return;
        setImporting(true);
        importTeamConfig({ snapshot: pendingSnapshot, strategy: importStrategy })
            .then((response) => {
            setReports(response.reports);
            setPendingSnapshot(null);
            setDiffs(null);
            Toast.push('配置导入完成', 'success');
            reload();
        })
            .catch((error) => reportError(error, '导入配置失败'))
            .finally(() => setImporting(false));
    };
    /** 取消本次导入（清空 diff 预览）。 */
    const cancelImport = () => {
        setPendingSnapshot(null);
        setDiffs(null);
    };
    /** 删除归档快照（以导出时间戳为键）。 */
    const removeSnapshot = (snapshot) => {
        const key = String(snapshot.exportedAt);
        setDeletingKey(key);
        deleteTeamSnapshot(key)
            .then(() => {
            Toast.push('快照已删除', 'success');
            reload();
        })
            .catch((error) => reportError(error, '删除快照失败'))
            .finally(() => setDeletingKey(null));
    };
    /** 快照携带的分区摘要。 */
    const snapshotSections = (snapshot) => {
        const names = Object.entries(snapshot.sections ?? {})
            .filter(([, value]) => value !== undefined)
            .map(([key]) => SECTION_LABELS[key] ?? key);
        return names.length > 0 ? names.join('、') : '-';
    };
    return (_jsxs(_Fragment, { children: [_jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "\u56E2\u961F\u504F\u597D" }), prefs === null ? (_jsx(Spinner, { label: "\u52A0\u8F7D\u56E2\u961F\u504F\u597D\u2026" })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: styles.formGrid, children: [_jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6210\u5458\u7F72\u540D\uFF08\u8BC4\u5BA1\u4F5C\u8005/\u8BC4\u8BBA\u8005\u6807\u8BC6\uFF09" }), _jsx(Input, { value: memberName, placeholder: "\u5982\uFF1A\u5F20\u4E09", onChange: (event) => setMemberName(event.target.value) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u7F3A\u7701\u5408\u5E76\u7B56\u7565" }), _jsxs(Select, { value: defaultStrategy, onChange: (event) => setDefaultStrategy(event.target.value), children: [_jsx("option", { value: "local", children: "\u672C\u5730\u4F18\u5148" }), _jsx("option", { value: "remote", children: "\u8FDC\u7A0B\u4F18\u5148" }), _jsx("option", { value: "manual", children: "\u624B\u52A8\u5408\u5E76" })] })] })] }), _jsx("div", { children: _jsx(Button, { size: "sm", variant: "primary", disabled: savingPrefs, onClick: savePrefs, children: savingPrefs ? _jsx(Spinner, { label: "\u4FDD\u5B58\u4E2D\u2026" }) : '保存偏好' }) })] }))] }), _jsxs("section", { className: styles.section, children: [_jsxs("div", { className: styles.sectionHeader, children: [_jsx("h3", { children: "\u914D\u7F6E\u5FEB\u7167\u5BFC\u51FA / \u5BFC\u5165" }), _jsxs("div", { className: styles.rowActions, children: [_jsx(Button, { size: "sm", variant: "secondary", disabled: exporting, onClick: doExport, children: exporting ? _jsx(Spinner, { label: "\u5BFC\u51FA\u4E2D\u2026" }) : '导出配置快照' }), _jsx(Button, { size: "sm", variant: "secondary", disabled: diffing, onClick: () => fileRef.current?.click(), children: diffing ? _jsx(Spinner, { label: "\u89E3\u6790\u4E2D\u2026" }) : '导入配置快照' })] })] }), _jsx("input", { ref: fileRef, type: "file", accept: ".json", className: styles.hiddenInput, onChange: onPickFile }), _jsx("p", { className: styles.hint, children: "\u5BFC\u51FA\u7684 JSON \u63D0\u4EA4\u5230\u56E2\u961F Git \u4ED3\u5E93\u5171\u4EAB\uFF1B\u6210\u5458 pull \u540E\u5728\u6B64\u5BFC\u5165\uFF0C\u51B2\u7A81\u6309\u6240\u9009\u7B56\u7565\u5408\u5E76\u3002" }), diffs !== null && (_jsxs(_Fragment, { children: [_jsxs("h4", { className: styles.subTitle, children: ["\u5DEE\u5F02\u9884\u89C8\uFF08\u5171 ", diffs.length, " \u6761\uFF09"] }), diffs.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u5FEB\u7167\u4E0E\u672C\u5730\u914D\u7F6E\u65E0\u5DEE\u5F02\u3002" })) : (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u5206\u533A" }), _jsx("th", { children: "\u6761\u76EE" }), _jsx("th", { children: "\u52A8\u4F5C" }), _jsx("th", { children: "\u672C\u5730\u503C" }), _jsx("th", { children: "\u8FDC\u7A0B\u503C" })] }) }), _jsx("tbody", { children: diffs.map((diff, index) => (_jsxs("tr", { children: [_jsx("td", { children: SECTION_LABELS[diff.section] ?? diff.section }), _jsx("td", { className: styles.cellCode, children: diff.key }), _jsx("td", { children: _jsx(Pill, { className: diff.action === 'add'
                                                            ? styles.pillSuccess
                                                            : diff.action === 'update'
                                                                ? styles.pillWarning
                                                                : styles.pillInfo, children: ACTION_LABELS[diff.action] }) }), _jsx("td", { className: styles.cellCode, children: previewJson(diff.local) }), _jsx("td", { className: styles.cellCode, children: previewJson(diff.remote) })] }, `${diff.section}-${diff.key}-${index}`))) })] })), _jsxs("div", { className: styles.rowActions, children: [_jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u5408\u5E76\u7B56\u7565" }), _jsxs(Select, { value: importStrategy, onChange: (event) => setImportStrategy(event.target.value), children: [_jsx("option", { value: "local", children: "\u672C\u5730\u4F18\u5148\uFF08\u51B2\u7A81\u4FDD\u7559\u672C\u5730\uFF09" }), _jsx("option", { value: "remote", children: "\u8FDC\u7A0B\u4F18\u5148\uFF08\u51B2\u7A81\u8986\u76D6\u672C\u5730\uFF09" }), _jsx("option", { value: "manual", children: "\u624B\u52A8\u5408\u5E76\uFF08\u51B2\u7A81\u6761\u76EE\u8DF3\u8FC7\uFF09" })] })] }), _jsx(Button, { size: "sm", variant: "primary", disabled: importing, onClick: runImport, children: importing ? _jsx(Spinner, { label: "\u5BFC\u5165\u4E2D\u2026" }) : '执行导入' }), _jsx(Button, { size: "sm", variant: "ghost", disabled: importing, onClick: cancelImport, children: "\u53D6\u6D88" })] })] })), reports !== null && (_jsxs(_Fragment, { children: [_jsx("h4", { className: styles.subTitle, children: "\u5BFC\u5165\u7ED3\u679C\u6C47\u62A5" }), _jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u5206\u533A" }), _jsx("th", { children: "\u65B0\u589E" }), _jsx("th", { children: "\u66F4\u65B0" }), _jsx("th", { children: "\u4E00\u81F4" }), _jsx("th", { children: "\u8DF3\u8FC7" }), _jsx("th", { children: "\u5907\u6CE8" })] }) }), _jsx("tbody", { children: reports.map((report) => (_jsxs("tr", { children: [_jsx("td", { children: SECTION_LABELS[report.section] ?? report.section }), _jsx("td", { children: report.added }), _jsx("td", { children: report.updated }), _jsx("td", { children: report.same }), _jsx("td", { children: report.skipped }), _jsx("td", { children: report.message ?? '-' })] }, report.section))) })] })] }))] }), _jsxs("section", { className: styles.section, children: [_jsxs("div", { className: styles.sectionHeader, children: [_jsx("h3", { children: "\u5FEB\u7167\u5F52\u6863\uFF08\u6700\u8FD1\u5BFC\u5165\uFF09" }), _jsx(Button, { size: "sm", variant: "secondary", onClick: reload, children: "\u5237\u65B0" })] }), snapshots.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u6682\u65E0\u5F52\u6863\u5FEB\u7167\u3002" })) : (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u5BFC\u51FA\u8005" }), _jsx("th", { children: "\u5BFC\u51FA\u65F6\u95F4" }), _jsx("th", { children: "\u643A\u5E26\u5206\u533A" }), _jsx("th", { children: "\u64CD\u4F5C" })] }) }), _jsx("tbody", { children: snapshots.map((snapshot) => (_jsxs("tr", { children: [_jsx("td", { children: snapshot.exportedBy || '-' }), _jsx("td", { children: formatTime(snapshot.exportedAt) }), _jsx("td", { children: snapshotSections(snapshot) }), _jsx("td", { children: _jsxs("div", { className: styles.rowActions, children: [_jsx(Button, { size: "sm", variant: "ghost", onClick: () => setViewing(snapshot), children: "\u67E5\u770B" }), _jsx(Button, { size: "sm", variant: "danger", disabled: deletingKey === String(snapshot.exportedAt), onClick: () => removeSnapshot(snapshot), children: deletingKey === String(snapshot.exportedAt) ? _jsx(Spinner, { label: "\u5220\u9664\u4E2D\u2026" }) : '删除' })] }) })] }, snapshot.exportedAt))) })] }))] }), _jsx(Modal, { open: viewing !== null, title: "\u5FEB\u7167\u5185\u5BB9", onClose: () => setViewing(null), footer: _jsx("div", { className: styles.footer, children: _jsx(Button, { variant: "ghost", onClick: () => setViewing(null), children: "\u5173\u95ED" }) }), children: _jsx("pre", { className: styles.output, children: viewing === null ? '' : JSON.stringify(viewing, null, 2) }) })] }));
}
// ---------------------------------------------------------------------------
// I2：执行经验库
// ---------------------------------------------------------------------------
/** 经验库面板。 */
function ExperiencePanel() {
    const [cards, setCards] = useState([]);
    const [loading, setLoading] = useState(false);
    const [filter, setFilter] = useState({ query: '', tags: '', model: '' });
    const [expandedId, setExpandedId] = useState(null);
    const [createOpen, setCreateOpen] = useState(false);
    const [form, setForm] = useState({ title: '', model: '', tags: '', promptSummary: '' });
    const [creating, setCreating] = useState(false);
    const [noteDraft, setNoteDraft] = useState({ problem: '', solution: '' });
    const [addingNote, setAddingNote] = useState(false);
    const [deletingId, setDeletingId] = useState(null);
    const reload = useCallback(() => {
        setLoading(true);
        fetchExperienceCards({
            query: filter.query.trim() || undefined,
            tags: filter.tags.trim() || undefined,
            model: filter.model.trim() || undefined,
        })
            .then((response) => setCards(response.cards))
            .catch((error) => reportError(error, '加载经验卡片失败'))
            .finally(() => setLoading(false));
    }, [filter]);
    // 仅挂载时自动加载一次；筛选条件变化由「搜索」按钮显式触发。
    const initialLoaded = useRef(false);
    useEffect(() => {
        if (initialLoaded.current)
            return;
        initialLoaded.current = true;
        reload();
    }, [reload]);
    /** 切换卡片展开态（同时清空笔记草稿）。 */
    const toggleExpand = (id) => {
        setExpandedId((prev) => (prev === id ? null : id));
        setNoteDraft({ problem: '', solution: '' });
    };
    /** 手动创建经验卡片。 */
    const submitCreate = () => {
        if (!form.title.trim()) {
            Toast.push('请填写卡片标题', 'warning');
            return;
        }
        setCreating(true);
        createExperienceCard({
            title: form.title.trim(),
            model: form.model.trim(),
            tags: form.tags
                .split(',')
                .map((tag) => tag.trim())
                .filter((tag) => tag.length > 0),
            promptSummary: form.promptSummary.trim(),
        })
            .then(() => {
            Toast.push('经验卡片已创建', 'success');
            setCreateOpen(false);
            setForm({ title: '', model: '', tags: '', promptSummary: '' });
            reload();
        })
            .catch((error) => reportError(error, '创建经验卡片失败'))
            .finally(() => setCreating(false));
    };
    /** 为展开的卡片补充笔记。 */
    const submitNote = (card) => {
        if (!noteDraft.problem.trim() || !noteDraft.solution.trim()) {
            Toast.push('问题与解决方案均需填写', 'warning');
            return;
        }
        setAddingNote(true);
        addExperienceNote({ id: card.id, problem: noteDraft.problem.trim(), solution: noteDraft.solution.trim() })
            .then((response) => {
            setCards((prev) => prev.map((item) => (item.id === response.card.id ? response.card : item)));
            setNoteDraft({ problem: '', solution: '' });
            Toast.push('笔记已添加', 'success');
        })
            .catch((error) => reportError(error, '添加笔记失败'))
            .finally(() => setAddingNote(false));
    };
    /** 删除卡片。 */
    const removeCard = (id) => {
        setDeletingId(id);
        deleteExperienceCard(id)
            .then(() => {
            Toast.push('卡片已删除', 'success');
            reload();
        })
            .catch((error) => reportError(error, '删除卡片失败'))
            .finally(() => setDeletingId(null));
    };
    return (_jsxs(_Fragment, { children: [_jsxs("section", { className: styles.section, children: [_jsxs("div", { className: styles.sectionHeader, children: [_jsx("h3", { children: "\u6267\u884C\u7ECF\u9A8C\u5E93" }), _jsx(Button, { size: "sm", variant: "primary", onClick: () => setCreateOpen(true), children: "\u624B\u52A8\u521B\u5EFA\u5361\u7247" })] }), _jsxs("div", { className: styles.formGrid, children: [_jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u5173\u952E\u8BCD" }), _jsx(Input, { value: filter.query, placeholder: "\u6807\u9898 / \u6458\u8981 / \u7B14\u8BB0\u5168\u6587", onChange: (event) => setFilter({ ...filter, query: event.target.value }), onKeyDown: (event) => {
                                            if (event.key === 'Enter')
                                                reload();
                                        } })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6807\u7B7E\uFF08\u9017\u53F7\u5206\u9694\uFF0C\u4EFB\u4E00\u547D\u4E2D\uFF09" }), _jsx(Input, { value: filter.tags, placeholder: "\u5BFC\u51FA, \u5B57\u4F53", onChange: (event) => setFilter({ ...filter, tags: event.target.value }), onKeyDown: (event) => {
                                            if (event.key === 'Enter')
                                                reload();
                                        } })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6A21\u578B\uFF08\u7CBE\u786E\u5339\u914D\uFF09" }), _jsx(Input, { value: filter.model, placeholder: "deepseek-chat", onChange: (event) => setFilter({ ...filter, model: event.target.value }), onKeyDown: (event) => {
                                            if (event.key === 'Enter')
                                                reload();
                                        } })] }), _jsx("div", { className: styles.field, children: _jsx(Button, { size: "sm", variant: "secondary", disabled: loading, onClick: reload, children: loading ? _jsx(Spinner, { label: "\u641C\u7D22\u4E2D\u2026" }) : '搜索' }) })] })] }), _jsx("section", { className: styles.section, children: loading && cards.length === 0 ? (_jsx(Spinner, { label: "\u52A0\u8F7D\u7ECF\u9A8C\u5361\u7247\u2026" })) : cards.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u6682\u65E0\u7ECF\u9A8C\u5361\u7247\u3002" })) : (_jsx("div", { className: styles.cardList, children: cards.map((card) => (_jsxs("div", { className: styles.card, children: [_jsxs("div", { className: styles.cardHead, children: [_jsx("span", { className: styles.cardTitle, children: card.title }), _jsxs("div", { className: styles.rowActions, children: [_jsx(Pill, { className: styles.pillInfo, children: SOURCE_LABELS[card.source] ?? card.source }), _jsx(Pill, { className: styles.pillInfo, children: card.model || '未知模型' }), card.ok ? (_jsx(Pill, { className: styles.pillSuccess, children: "\u6210\u529F" })) : (_jsx(Pill, { className: styles.pillDanger, children: "\u5931\u8D25" })), _jsx(Button, { size: "sm", variant: "ghost", onClick: () => toggleExpand(card.id), children: expandedId === card.id ? '收起' : '展开' }), _jsx(Button, { size: "sm", variant: "danger", disabled: deletingId === card.id, onClick: () => removeCard(card.id), children: deletingId === card.id ? _jsx(Spinner, { label: "\u5220\u9664\u4E2D\u2026" }) : '删除' })] })] }), _jsxs("div", { className: styles.cardMeta, children: [formatTime(card.createdAt), " \u00B7 \u8017\u65F6 ", formatDuration(card.durationMs), " \u00B7 ", card.tokens, " tokens", card.tags.length > 0 ? ` · ${card.tags.join(' / ')}` : ''] }), expandedId === card.id && (_jsxs("div", { className: styles.cardBody, children: [card.promptSummary ? _jsx("pre", { className: styles.output, children: card.promptSummary }) : null, !card.ok && card.error ? _jsxs("p", { className: styles.errorText, children: ["\u9519\u8BEF\uFF1A", card.error] }) : null, _jsxs("h4", { className: styles.subTitle, children: ["\u95EE\u9898\u4E0E\u89E3\u51B3\u65B9\u6848\u7B14\u8BB0\uFF08", card.notes.length, "\uFF09"] }), card.notes.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u6682\u65E0\u7B14\u8BB0\u3002" })) : (_jsx("div", { className: styles.noteList, children: card.notes.map((note, index) => (_jsxs("div", { className: styles.noteItem, children: [_jsxs("span", { children: ["\u95EE\u9898\uFF1A", note.problem] }), _jsxs("span", { children: ["\u89E3\u51B3\uFF1A", note.solution] }), _jsx("span", { className: styles.commentMeta, children: formatTime(note.ts) })] }, `${card.id}-${index}`))) })), _jsx(Textarea, { rows: 2, placeholder: "\u8865\u5145\u95EE\u9898\u63CF\u8FF0", value: noteDraft.problem, onChange: (event) => setNoteDraft({ ...noteDraft, problem: event.target.value }) }), _jsx(Textarea, { rows: 2, placeholder: "\u8865\u5145\u89E3\u51B3\u65B9\u6848", value: noteDraft.solution, onChange: (event) => setNoteDraft({ ...noteDraft, solution: event.target.value }) }), _jsx("div", { children: _jsx(Button, { size: "sm", variant: "secondary", disabled: addingNote, onClick: () => submitNote(card), children: addingNote ? _jsx(Spinner, { label: "\u6DFB\u52A0\u4E2D\u2026" }) : '添加笔记' }) })] }))] }, card.id))) })) }), _jsx(Modal, { open: createOpen, title: "\u624B\u52A8\u521B\u5EFA\u7ECF\u9A8C\u5361\u7247", onClose: () => setCreateOpen(false), footer: _jsxs("div", { className: styles.footer, children: [_jsx(Button, { variant: "ghost", onClick: () => setCreateOpen(false), children: "\u53D6\u6D88" }), _jsx(Button, { variant: "primary", disabled: creating, onClick: submitCreate, children: creating ? _jsx(Spinner, { label: "\u521B\u5EFA\u4E2D\u2026" }) : '创建' })] }), children: _jsxs("div", { className: styles.modalBody, children: [_jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6807\u9898\uFF08\u5FC5\u586B\uFF09" }), _jsx(Input, { value: form.title, placeholder: "\u5982\uFF1APDF \u5BFC\u51FA\u5B57\u4F53\u7F3A\u5931\u7684\u4FEE\u590D", onChange: (event) => setForm({ ...form, title: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6A21\u578B" }), _jsx(Input, { value: form.model, placeholder: "deepseek-chat", onChange: (event) => setForm({ ...form, model: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6807\u7B7E\uFF08\u9017\u53F7\u5206\u9694\uFF09" }), _jsx(Input, { value: form.tags, placeholder: "\u5BFC\u51FA, \u5B57\u4F53", onChange: (event) => setForm({ ...form, tags: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6267\u884C\u6458\u8981" }), _jsx(Textarea, { rows: 4, placeholder: "\u4EFB\u52A1 Prompt / \u6267\u884C\u8FC7\u7A0B\u6458\u8981", value: form.promptSummary, onChange: (event) => setForm({ ...form, promptSummary: event.target.value }) })] })] }) })] }));
}
// ---------------------------------------------------------------------------
// I3：Prompt 协作评审
// ---------------------------------------------------------------------------
/** 评审状态徽标。 */
function ReviewStatusPill(props) {
    const map = {
        open: { label: '待审核', cls: styles.pillWarning },
        approved: { label: '已通过', cls: styles.pillSuccess },
        rejected: { label: '已拒绝', cls: styles.pillDanger },
        merged: { label: '已合并', cls: styles.pillInfo },
    };
    const entry = map[props.status];
    return _jsx(Pill, { className: entry.cls, children: entry.label });
}
/** 评论锚点描述。 */
function anchorLabel(anchor) {
    if (!anchor || anchor.line === 0)
        return '整体评论';
    return `${anchor.side === 'base' ? '基线' : '提议'}侧第 ${anchor.line} 行`;
}
/** 评审面板。 */
function ReviewPanel() {
    const [reviews, setReviews] = useState([]);
    const [loading, setLoading] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [form, setForm] = useState({ title: '', baseContent: '', proposedContent: '', note: '' });
    const [creating, setCreating] = useState(false);
    const [detailId, setDetailId] = useState(null);
    const [detail, setDetail] = useState(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [comment, setComment] = useState('');
    const [addingComment, setAddingComment] = useState(false);
    const [decisionComment, setDecisionComment] = useState('');
    const [deciding, setDeciding] = useState(null);
    const [merging, setMerging] = useState(false);
    const [deletingId, setDeletingId] = useState(null);
    const reload = useCallback(() => {
        setLoading(true);
        fetchReviews()
            .then((response) => setReviews(response.reviews))
            .catch((error) => reportError(error, '加载评审列表失败'))
            .finally(() => setLoading(false));
    }, []);
    useEffect(() => {
        reload();
    }, [reload]);
    /** 打开评审详情。 */
    const openDetail = useCallback((id) => {
        setDetailId(id);
        setDetail(null);
        setDetailLoading(true);
        fetchReviewDetail(id)
            .then((response) => setDetail(response))
            .catch((error) => {
            reportError(error, '加载评审详情失败');
            setDetailId(null);
        })
            .finally(() => setDetailLoading(false));
    }, []);
    /** 创建评审。 */
    const submitCreate = () => {
        if (!form.title.trim() || !form.proposedContent.trim()) {
            Toast.push('标题与提议内容必填', 'warning');
            return;
        }
        setCreating(true);
        createReview({
            title: form.title.trim(),
            baseContent: form.baseContent,
            proposedContent: form.proposedContent,
            note: form.note.trim() || undefined,
        })
            .then(() => {
            Toast.push('评审已创建', 'success');
            setCreateOpen(false);
            setForm({ title: '', baseContent: '', proposedContent: '', note: '' });
            reload();
        })
            .catch((error) => reportError(error, '创建评审失败'))
            .finally(() => setCreating(false));
    };
    /** 添加评论批注。 */
    const submitComment = () => {
        if (!detail || !comment.trim())
            return;
        setAddingComment(true);
        addReviewComment({ reviewId: detail.review.id, content: comment.trim() })
            .then(() => {
            setComment('');
            Toast.push('评论已添加', 'success');
            openDetail(detail.review.id);
        })
            .catch((error) => reportError(error, '添加评论失败'))
            .finally(() => setAddingComment(false));
    };
    /** 审核决定（通过/拒绝）。 */
    const decide = (verdict) => {
        if (!detail)
            return;
        setDeciding(verdict);
        decideReview({ reviewId: detail.review.id, verdict, comment: decisionComment.trim() || undefined })
            .then(() => {
            Toast.push(verdict === 'approve' ? '已通过评审' : '已拒绝评审', 'success');
            setDecisionComment('');
            openDetail(detail.review.id);
            reload();
        })
            .catch((error) => reportError(error, '提交审核决定失败'))
            .finally(() => setDeciding(null));
    };
    /** 合并进主版本。 */
    const doMerge = () => {
        if (!detail)
            return;
        setMerging(true);
        mergeReview(detail.review.id)
            .then((response) => {
            Toast.push(`已合并为主版本 v${response.mergedVersion}`, 'success');
            openDetail(detail.review.id);
            reload();
        })
            .catch((error) => reportError(error, '合并失败'))
            .finally(() => setMerging(false));
    };
    /** 删除评审。 */
    const removeReview = (id) => {
        setDeletingId(id);
        deleteReview(id)
            .then(() => {
            Toast.push('评审已删除', 'success');
            reload();
        })
            .catch((error) => reportError(error, '删除评审失败'))
            .finally(() => setDeletingId(null));
    };
    return (_jsxs(_Fragment, { children: [_jsxs("section", { className: styles.section, children: [_jsxs("div", { className: styles.sectionHeader, children: [_jsx("h3", { children: "Prompt \u534F\u4F5C\u8BC4\u5BA1" }), _jsxs("div", { className: styles.rowActions, children: [_jsx(Button, { size: "sm", variant: "secondary", disabled: loading, onClick: reload, children: "\u5237\u65B0" }), _jsx(Button, { size: "sm", variant: "primary", onClick: () => setCreateOpen(true), children: "\u521B\u5EFA\u8BC4\u5BA1" })] })] }), loading && reviews.length === 0 ? (_jsx(Spinner, { label: "\u52A0\u8F7D\u8BC4\u5BA1\u5217\u8868\u2026" })) : reviews.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u6682\u65E0\u8BC4\u5BA1\u8BF7\u6C42\u3002" })) : (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u6807\u9898" }), _jsx("th", { children: "\u4F5C\u8005" }), _jsx("th", { children: "\u72B6\u6001" }), _jsx("th", { children: "\u521B\u5EFA\u65F6\u95F4" }), _jsx("th", { children: "\u66F4\u65B0\u65F6\u95F4" }), _jsx("th", { children: "\u64CD\u4F5C" })] }) }), _jsx("tbody", { children: reviews.map((review) => (_jsxs("tr", { children: [_jsx("td", { children: review.title }), _jsx("td", { children: review.author || '-' }), _jsx("td", { children: _jsx(ReviewStatusPill, { status: review.status }) }), _jsx("td", { children: formatTime(review.createdAt) }), _jsx("td", { children: formatTime(review.updatedAt) }), _jsx("td", { children: _jsxs("div", { className: styles.rowActions, children: [_jsx(Button, { size: "sm", variant: "ghost", onClick: () => openDetail(review.id), children: "\u67E5\u770B" }), _jsx(Button, { size: "sm", variant: "danger", disabled: deletingId === review.id, onClick: () => removeReview(review.id), children: deletingId === review.id ? _jsx(Spinner, { label: "\u5220\u9664\u4E2D\u2026" }) : '删除' })] }) })] }, review.id))) })] }))] }), _jsx(Modal, { open: createOpen, title: "\u521B\u5EFA\u8BC4\u5BA1", onClose: () => setCreateOpen(false), footer: _jsxs("div", { className: styles.footer, children: [_jsx(Button, { variant: "ghost", onClick: () => setCreateOpen(false), children: "\u53D6\u6D88" }), _jsx(Button, { variant: "primary", disabled: creating, onClick: submitCreate, children: creating ? _jsx(Spinner, { label: "\u521B\u5EFA\u4E2D\u2026" }) : '提交评审' })] }), children: _jsxs("div", { className: styles.modalBody, children: [_jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6807\u9898\uFF08\u5FC5\u586B\uFF09" }), _jsx(Input, { value: form.title, placeholder: "\u5982\uFF1A\u4F18\u5316\u5BFC\u51FA\u6458\u8981\u7684\u7AE0\u8282\u7ED3\u6784", onChange: (event) => setForm({ ...form, title: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u57FA\u7EBF\u5185\u5BB9\uFF08\u5F53\u524D\u4E3B\u7248\u672C\uFF0C\u53EF\u4E3A\u7A7A\uFF09" }), _jsx(Textarea, { rows: 6, value: form.baseContent, onChange: (event) => setForm({ ...form, baseContent: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u63D0\u8BAE\u5185\u5BB9\uFF08\u5FC5\u586B\uFF09" }), _jsx(Textarea, { rows: 6, value: form.proposedContent, onChange: (event) => setForm({ ...form, proposedContent: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u5907\u6CE8" }), _jsx(Input, { value: form.note, placeholder: "\u53D8\u66F4\u52A8\u673A\u8BF4\u660E", onChange: (event) => setForm({ ...form, note: event.target.value }) })] })] }) }), _jsx(Modal, { open: detailId !== null, title: detail ? `评审：${detail.review.title}` : '评审详情', onClose: () => setDetailId(null), footer: _jsx("div", { className: styles.footer, children: _jsx(Button, { variant: "ghost", onClick: () => setDetailId(null), children: "\u5173\u95ED" }) }), children: detailLoading || detail === null ? (_jsx(Spinner, { label: "\u52A0\u8F7D\u8BC4\u5BA1\u8BE6\u60C5\u2026" })) : (_jsxs("div", { className: styles.modalBody, children: [_jsxs("div", { className: styles.cardMeta, children: ["\u4F5C\u8005\uFF1A", detail.review.author || '-', " \u00B7 \u521B\u5EFA\u4E8E ", formatTime(detail.review.createdAt), " \u00B7 \u66F4\u65B0\u4E8E", ' ', formatTime(detail.review.updatedAt), detail.review.mergedVersion > 0 ? ` · 合并主版本 v${detail.review.mergedVersion}` : ''] }), _jsx("div", { className: styles.rowActions, children: _jsx(ReviewStatusPill, { status: detail.review.status }) }), detail.review.note ? _jsxs("p", { className: styles.hint, children: ["\u5907\u6CE8\uFF1A", detail.review.note] }) : null, _jsxs("div", { className: styles.compareGrid, children: [_jsxs("div", { className: styles.compareCol, children: [_jsx("span", { className: styles.compareLabel, children: "\u57FA\u7EBF\u5185\u5BB9" }), _jsx("pre", { className: styles.output, children: detail.review.baseContent || '（空）' })] }), _jsxs("div", { className: styles.compareCol, children: [_jsx("span", { className: styles.compareLabel, children: "\u63D0\u8BAE\u5185\u5BB9" }), _jsx("pre", { className: styles.output, children: detail.review.proposedContent || '（空）' })] })] }), _jsxs("h4", { className: styles.subTitle, children: ["\u8BC4\u8BBA\u6279\u6CE8\uFF08", detail.comments.length, "\uFF09"] }), detail.comments.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u6682\u65E0\u8BC4\u8BBA\u3002" })) : (_jsx("div", { className: styles.commentList, children: detail.comments.map((item) => (_jsxs("div", { className: styles.commentItem, children: [_jsx("span", { children: item.content }), _jsxs("span", { className: styles.commentMeta, children: [item.author || '-', " \u00B7 ", anchorLabel(item.anchor), " \u00B7 ", formatTime(item.createdAt)] })] }, item.id))) })), _jsx(Textarea, { rows: 2, placeholder: "\u6DFB\u52A0\u8BC4\u8BBA\u6279\u6CE8", value: comment, onChange: (event) => setComment(event.target.value) }), _jsx("div", { children: _jsx(Button, { size: "sm", variant: "secondary", disabled: addingComment || !comment.trim(), onClick: submitComment, children: addingComment ? _jsx(Spinner, { label: "\u63D0\u4EA4\u4E2D\u2026" }) : '添加评论' }) }), _jsxs("h4", { className: styles.subTitle, children: ["\u5BA1\u6838\u8BB0\u5F55\uFF08", detail.decisions.length, "\uFF09"] }), detail.decisions.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u6682\u65E0\u5BA1\u6838\u51B3\u5B9A\u3002" })) : (_jsx("div", { className: styles.commentList, children: detail.decisions.map((decision, index) => (_jsxs("div", { className: styles.commentItem, children: [_jsxs("span", { children: [decision.reviewer || '-', ' ', decision.verdict === 'approve' ? (_jsx(Pill, { className: styles.pillSuccess, children: "\u901A\u8FC7" })) : (_jsx(Pill, { className: styles.pillDanger, children: "\u62D2\u7EDD" })), decision.comment ? `：${decision.comment}` : ''] }), _jsx("span", { className: styles.commentMeta, children: formatTime(decision.ts) })] }, `${decision.reviewer}-${decision.ts}-${index}`))) })), detail.review.status !== 'merged' && (_jsxs("div", { className: styles.decideBox, children: [_jsx(Input, { value: decisionComment, placeholder: "\u5BA1\u6838\u610F\u89C1\uFF08\u53EF\u9009\uFF09", onChange: (event) => setDecisionComment(event.target.value) }), _jsxs("div", { className: styles.rowActions, children: [_jsx(Button, { size: "sm", variant: "primary", disabled: deciding !== null, onClick: () => decide('approve'), children: deciding === 'approve' ? _jsx(Spinner, { label: "\u63D0\u4EA4\u4E2D\u2026" }) : '通过' }), _jsx(Button, { size: "sm", variant: "danger", disabled: deciding !== null, onClick: () => decide('reject'), children: deciding === 'reject' ? _jsx(Spinner, { label: "\u63D0\u4EA4\u4E2D\u2026" }) : '拒绝' }), _jsx(Button, { size: "sm", variant: "secondary", disabled: merging || detail.review.status !== 'approved', title: detail.review.status === 'approved' ? '合并进主版本' : '通过审核后方可合并', onClick: doMerge, children: merging ? _jsx(Spinner, { label: "\u5408\u5E76\u4E2D\u2026" }) : '合并主版本' })] }), detail.review.status !== 'approved' ? (_jsx("p", { className: styles.hint, children: "\u901A\u8FC7\u5BA1\u6838\u540E\u65B9\u53EF\u5408\u5E76\u4E3B\u7248\u672C\u3002" })) : null] }))] })) })] }));
}
