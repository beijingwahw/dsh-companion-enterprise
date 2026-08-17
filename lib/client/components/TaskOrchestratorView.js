import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 任务编排视图页（模块 H 客户端 UI，挂载于 conversation.view）：
 * - H1 可视化流水线：步骤列表编辑（模型/Prompt/输入来源/条件/超时/重试/依赖），
 *   自动生成 YAML 配置；
 * - H2 断点续跑：启动/暂停/取消/恢复执行，进度条 + 每步中间结果展示；
 * - H3 批量任务队列：优先级/截止时间/失败策略，批量暂停/恢复/取消；
 * - H4 定时调度：Cron 与自然语言双输入，峰谷空闲时段选项，历史执行归档。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input, Select, Spinner, Textarea, Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { batchQueue, cancelPipelineRun, cancelQueueTask, deleteJob, deletePipeline, deletePipelineRun, deleteQueueTask, fetchJobRuns, fetchJobs, fetchPipelineRun, fetchPipelineRuns, fetchPipelineYaml, fetchPipelines, fetchQueue, pausePipelineRun, pauseQueueTask, parseSchedule, resumePipelineRun, resumeQueueTask, saveJob, savePipeline, startPipelineRun, submitQueueTask, toggleJob, } from '../api.js';
import styles from './TaskOrchestratorView.module.css';
/** 任务编排视图页。 */
export function TaskOrchestratorView(_props) {
    const [tab, setTab] = useState('pipelines');
    return (_jsxs("div", { className: styles.root, children: [_jsx("h2", { className: styles.title, children: "\u4EFB\u52A1\u7F16\u6392" }), _jsxs("div", { className: styles.tabs, children: [_jsx(Button, { size: "sm", variant: tab === 'pipelines' ? 'primary' : 'secondary', onClick: () => setTab('pipelines'), children: "\u6D41\u6C34\u7EBF" }), _jsx(Button, { size: "sm", variant: tab === 'queue' ? 'primary' : 'secondary', onClick: () => setTab('queue'), children: "\u6279\u91CF\u961F\u5217" }), _jsx(Button, { size: "sm", variant: tab === 'jobs' ? 'primary' : 'secondary', onClick: () => setTab('jobs'), children: "\u5B9A\u65F6\u8C03\u5EA6" })] }), tab === 'pipelines' && _jsx(PipelinePanel, {}), tab === 'queue' && _jsx(QueuePanel, {}), tab === 'jobs' && _jsx(JobPanel, {})] }));
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
/** 步骤 id 单调计数器：保证删除中间步骤后再添加也不会产生重复 id。 */
let stepIdCounter = 0;
/** 新建空白步骤草稿（index 仅用于显示名称，id 全局唯一）。 */
function blankStep(index) {
    stepIdCounter += 1;
    return {
        id: `step-${stepIdCounter}`,
        name: `步骤 ${index}`,
        model: 'deepseek-chat',
        prompt: '',
        inputFrom: 'prev',
        input: '',
        condition: '',
        timeoutMs: '0',
        maxRetries: '0',
        dependsOn: '',
    };
}
/** 流水线面板：定义管理 + 执行监控。 */
function PipelinePanel() {
    const [pipelines, setPipelines] = useState([]);
    const [runs, setRuns] = useState([]);
    const [editing, setEditing] = useState(null);
    const [activeRunId, setActiveRunId] = useState(null);
    const [activeRun, setActiveRun] = useState(null);
    const [yaml, setYaml] = useState(null);
    const pollTimer = useRef(null);
    const reload = useCallback(() => {
        fetchPipelines()
            .then((response) => setPipelines(response.pipelines))
            .catch((error) => reportError(error, '加载流水线失败'));
        fetchPipelineRuns()
            .then((response) => setRuns(response.runs))
            .catch(() => undefined);
    }, []);
    useEffect(() => {
        reload();
    }, [reload]);
    // 运行中的执行：链式 setTimeout 轮询详情（上次响应返回后再排下一次，
    // 避免慢响应下 setInterval 造成请求堆积）。
    useEffect(() => {
        if (!activeRunId)
            return;
        let cancelled = false;
        const tick = () => {
            fetchPipelineRun(activeRunId)
                .then((response) => {
                if (cancelled)
                    return;
                setActiveRun(response.run);
                if (response.run.status !== 'running') {
                    reload();
                    return;
                }
                pollTimer.current = window.setTimeout(tick, 2000);
            })
                .catch(() => {
                if (!cancelled)
                    pollTimer.current = window.setTimeout(tick, 2000);
            });
        };
        tick();
        return () => {
            cancelled = true;
            if (pollTimer.current !== null) {
                window.clearTimeout(pollTimer.current);
                pollTimer.current = null;
            }
        };
    }, [activeRunId, reload]);
    const startEditing = (pipeline) => {
        if (pipeline) {
            setEditing({
                id: pipeline.id,
                name: pipeline.name,
                steps: pipeline.steps.map((step) => ({
                    id: step.id,
                    name: step.name,
                    model: step.model,
                    prompt: step.prompt,
                    inputFrom: step.inputFrom,
                    input: step.input,
                    condition: step.condition,
                    timeoutMs: String(step.timeoutMs),
                    maxRetries: String(step.maxRetries),
                    dependsOn: step.dependsOn.join(','),
                })),
            });
        }
        else {
            setEditing({ name: '', steps: [blankStep(1)] });
        }
        setYaml(null);
    };
    const submitEditing = () => {
        if (!editing)
            return;
        if (!editing.name.trim()) {
            Toast.push('请填写流水线名称', 'warning');
            return;
        }
        const steps = editing.steps.map((draft) => ({
            id: draft.id.trim(),
            name: draft.name.trim(),
            model: draft.model.trim(),
            prompt: draft.prompt,
            inputFrom: draft.inputFrom,
            input: draft.input,
            condition: draft.condition.trim(),
            timeoutMs: Number(draft.timeoutMs) || 0,
            maxRetries: Number(draft.maxRetries) || 0,
            dependsOn: draft.dependsOn
                .split(',')
                .map((dep) => dep.trim())
                .filter((dep) => dep.length > 0),
        }));
        savePipeline({ id: editing.id, name: editing.name.trim(), steps })
            .then(() => {
            Toast.push('流水线已保存', 'success');
            setEditing(null);
            reload();
        })
            .catch((error) => reportError(error, '保存流水线失败'));
    };
    const startRun = (pipelineId) => {
        startPipelineRun(pipelineId)
            .then((response) => {
            setActiveRunId(response.runId);
            setActiveRun(null);
            reload();
        })
            .catch((error) => reportError(error, '启动执行失败'));
    };
    const showYaml = (pipelineId) => {
        fetchPipelineYaml(pipelineId)
            .then((response) => setYaml(response.yaml))
            .catch((error) => reportError(error, '读取 YAML 失败'));
    };
    return (_jsxs(_Fragment, { children: [_jsxs("section", { className: styles.section, children: [_jsxs("div", { className: styles.sectionHeader, children: [_jsx("h3", { children: "\u6D41\u6C34\u7EBF\u5B9A\u4E49\uFF08H1\uFF09" }), _jsx(Button, { size: "sm", variant: "primary", onClick: () => startEditing(), children: "\u65B0\u5EFA\u6D41\u6C34\u7EBF" })] }), pipelines.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u6682\u65E0\u6D41\u6C34\u7EBF\uFF0C\u70B9\u51FB\u53F3\u4E0A\u89D2\u65B0\u5EFA\u3002" })) : (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u540D\u79F0" }), _jsx("th", { children: "\u6B65\u9AA4" }), _jsx("th", { children: "\u66F4\u65B0\u65F6\u95F4" }), _jsx("th", { children: "\u64CD\u4F5C" })] }) }), _jsx("tbody", { children: pipelines.map((pipeline) => (_jsxs("tr", { children: [_jsx("td", { children: pipeline.name }), _jsx("td", { children: pipeline.steps.length }), _jsx("td", { children: formatTime(pipeline.updatedAt) }), _jsx("td", { children: _jsxs("div", { className: styles.rowActions, children: [_jsx(Button, { size: "sm", variant: "primary", onClick: () => startRun(pipeline.id), children: "\u8FD0\u884C" }), _jsx(Button, { size: "sm", variant: "secondary", onClick: () => startEditing(pipeline), children: "\u7F16\u8F91" }), _jsx(Button, { size: "sm", variant: "secondary", onClick: () => showYaml(pipeline.id), children: "YAML" }), _jsx(Button, { size: "sm", variant: "danger", onClick: () => {
                                                            deletePipeline(pipeline.id)
                                                                .then(() => {
                                                                Toast.push('已删除', 'success');
                                                                reload();
                                                            })
                                                                .catch((error) => reportError(error, '删除失败'));
                                                        }, children: "\u5220\u9664" })] }) })] }, pipeline.id))) })] })), yaml !== null && _jsx("pre", { className: styles.output, children: yaml })] }), editing !== null && (_jsxs("section", { className: styles.section, children: [_jsx("h3", { children: editing.id ? '编辑流水线' : '新建流水线' }), _jsxs("div", { className: styles.field, children: [_jsx("span", { children: "\u6D41\u6C34\u7EBF\u540D\u79F0" }), _jsx(Input, { value: editing.name, placeholder: "\u5982\uFF1A\u6BCF\u65E5\u6570\u636E\u62A5\u544A", onChange: (event) => setEditing({ ...editing, name: event.target.value }) })] }), _jsx("div", { className: styles.stepList, children: editing.steps.map((step, index) => (_jsxs("div", { className: styles.stepCard, children: [_jsxs("div", { className: styles.stepHead, children: [_jsxs("span", { className: styles.stepName, children: ["#", index + 1] }), _jsx(Button, { size: "sm", variant: "danger", disabled: editing.steps.length <= 1, onClick: () => setEditing({ ...editing, steps: editing.steps.filter((_, i) => i !== index) }), children: "\u79FB\u9664\u6B65\u9AA4" })] }), _jsxs("div", { className: styles.formGrid, children: [_jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6B65\u9AA4\u540D\u79F0" }), _jsx(Input, { value: step.name, onChange: (event) => {
                                                        const steps = [...editing.steps];
                                                        steps[index] = { ...step, name: event.target.value };
                                                        setEditing({ ...editing, steps });
                                                    } })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6A21\u578B" }), _jsx(Input, { value: step.model, onChange: (event) => {
                                                        const steps = [...editing.steps];
                                                        steps[index] = { ...step, model: event.target.value };
                                                        setEditing({ ...editing, steps });
                                                    } })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u8F93\u5165\u6765\u6E90" }), _jsxs(Select, { value: step.inputFrom, onChange: (event) => {
                                                        const steps = [...editing.steps];
                                                        steps[index] = { ...step, inputFrom: event.target.value === 'literal' ? 'literal' : 'prev' };
                                                        setEditing({ ...editing, steps });
                                                    }, children: [_jsx("option", { value: "prev", children: "\u4E0A\u6E38\u8F93\u51FA" }), _jsx("option", { value: "literal", children: "\u56FA\u5B9A\u8F93\u5165" })] })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u4F9D\u8D56\u6B65\u9AA4 id\uFF08\u9017\u53F7\u5206\u9694\uFF0C\u7A7A=\u53EF\u5E76\u884C\uFF09" }), _jsx(Input, { value: step.dependsOn, placeholder: "step-1,step-2", onChange: (event) => {
                                                        const steps = [...editing.steps];
                                                        steps[index] = { ...step, dependsOn: event.target.value };
                                                        setEditing({ ...editing, steps });
                                                    } })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF0C0=\u9ED8\u8BA4\uFF09" }), _jsx(Input, { type: "number", value: step.timeoutMs, onChange: (event) => {
                                                        const steps = [...editing.steps];
                                                        steps[index] = { ...step, timeoutMs: event.target.value };
                                                        setEditing({ ...editing, steps });
                                                    } })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u5931\u8D25\u91CD\u8BD5\u6B21\u6570" }), _jsx(Input, { type: "number", value: step.maxRetries, onChange: (event) => {
                                                        const steps = [...editing.steps];
                                                        steps[index] = { ...step, maxRetries: event.target.value };
                                                        setEditing({ ...editing, steps });
                                                    } })] }), _jsxs("label", { className: `${styles.field} ${styles.fieldFull}`, children: [_jsx("span", { children: "Prompt \u6A21\u677F" }), _jsx(Textarea, { rows: 3, value: step.prompt, onChange: (event) => {
                                                        const steps = [...editing.steps];
                                                        steps[index] = { ...step, prompt: event.target.value };
                                                        setEditing({ ...editing, steps });
                                                    } })] }), step.inputFrom === 'literal' && (_jsxs("label", { className: `${styles.field} ${styles.fieldFull}`, children: [_jsx("span", { children: "\u56FA\u5B9A\u8F93\u5165" }), _jsx(Textarea, { rows: 2, value: step.input, onChange: (event) => {
                                                        const steps = [...editing.steps];
                                                        steps[index] = { ...step, input: event.target.value };
                                                        setEditing({ ...editing, steps });
                                                    } })] })), _jsxs("label", { className: `${styles.field} ${styles.fieldFull}`, children: [_jsx("span", { children: "\u6761\u4EF6\u5206\u652F\uFF08\u4E0A\u6E38\u8F93\u51FA\u5305\u542B\u8BE5\u5B50\u4E32\u624D\u6267\u884C\uFF0C\u7A7A=\u65E0\u6761\u4EF6\uFF09" }), _jsx(Input, { value: step.condition, onChange: (event) => {
                                                        const steps = [...editing.steps];
                                                        steps[index] = { ...step, condition: event.target.value };
                                                        setEditing({ ...editing, steps });
                                                    } })] })] })] }, step.id))) }), _jsxs("div", { className: styles.rowActions, children: [_jsx(Button, { size: "sm", variant: "secondary", onClick: () => setEditing({ ...editing, steps: [...editing.steps, blankStep(editing.steps.length + 1)] }), children: "\u6DFB\u52A0\u6B65\u9AA4" }), _jsx(Button, { size: "sm", variant: "primary", onClick: submitEditing, children: "\u4FDD\u5B58" }), _jsx(Button, { size: "sm", variant: "ghost", onClick: () => setEditing(null), children: "\u53D6\u6D88" })] })] })), _jsxs("section", { className: styles.section, children: [_jsxs("div", { className: styles.sectionHeader, children: [_jsx("h3", { children: "\u6267\u884C\u8BB0\u5F55\uFF08H2 \u65AD\u70B9\u7EED\u8DD1\uFF09" }), _jsx(Button, { size: "sm", variant: "secondary", onClick: reload, children: "\u5237\u65B0" })] }), runs.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u6682\u65E0\u6267\u884C\u8BB0\u5F55\u3002" })) : (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u72B6\u6001" }), _jsx("th", { children: "\u8FDB\u5EA6" }), _jsx("th", { children: "\u5F00\u59CB\u65F6\u95F4" }), _jsx("th", { children: "\u4FE1\u606F" }), _jsx("th", { children: "\u64CD\u4F5C" })] }) }), _jsx("tbody", { children: runs.map((run) => (_jsxs("tr", { children: [_jsx("td", { children: _jsx(RunStatusPill, { status: run.status }) }), _jsx("td", { children: _jsx(ProgressBar, { done: run.progress.done, total: run.progress.total }) }), _jsx("td", { children: formatTime(run.startedAt) }), _jsx("td", { children: run.message || '-' }), _jsx("td", { children: _jsxs("div", { className: styles.rowActions, children: [_jsx(Button, { size: "sm", variant: "secondary", onClick: () => setActiveRunId(run.id), children: "\u8BE6\u60C5" }), (run.status === 'paused' || run.status === 'failed' || run.status === 'cancelled') && (_jsx(Button, { size: "sm", variant: "primary", onClick: () => {
                                                            resumePipelineRun(run.id)
                                                                .then(() => {
                                                                setActiveRunId(run.id);
                                                                Toast.push('已从断点恢复', 'success');
                                                            })
                                                                .catch((error) => reportError(error, '恢复失败'));
                                                        }, children: "\u65AD\u70B9\u7EED\u8DD1" })), run.status === 'running' && (_jsxs(_Fragment, { children: [_jsx(Button, { size: "sm", variant: "secondary", onClick: () => pausePipelineRun(run.id).catch((error) => reportError(error, '暂停失败')), children: "\u6682\u505C" }), _jsx(Button, { size: "sm", variant: "danger", onClick: () => cancelPipelineRun(run.id).catch((error) => reportError(error, '取消失败')), children: "\u53D6\u6D88" })] })), run.status !== 'running' && (_jsx(Button, { size: "sm", variant: "ghost", onClick: () => {
                                                            deletePipelineRun(run.id)
                                                                .then(reload)
                                                                .catch((error) => reportError(error, '删除失败'));
                                                        }, children: "\u5220\u9664" }))] }) })] }, run.id))) })] })), activeRunId !== null && (_jsx(RunDetail, { run: activeRun, onClose: () => {
                            setActiveRunId(null);
                            setActiveRun(null);
                        } }))] })] }));
}
/** 执行状态徽标。 */
function RunStatusPill(props) {
    const labels = {
        running: '运行中',
        done: '已完成',
        failed: '失败',
        paused: '已暂停',
        cancelled: '已取消',
    };
    const cls = props.status === 'running'
        ? `${styles.status} ${styles.statusRunning}`
        : props.status === 'done'
            ? `${styles.status} ${styles.statusDone}`
            : props.status === 'failed'
                ? `${styles.status} ${styles.statusFailed}`
                : props.status === 'paused'
                    ? `${styles.status} ${styles.statusPaused}`
                    : styles.status;
    return _jsx("span", { className: cls, children: labels[props.status] });
}
/** 进度条（done/total）。 */
function ProgressBar(props) {
    const percent = props.total > 0 ? Math.round((props.done / props.total) * 100) : 0;
    return (_jsxs("div", { className: styles.progress, children: [_jsx("div", { className: styles.progressTrack, children: _jsx("div", { className: styles.progressFill, style: { width: `${percent}%` } }) }), _jsxs("span", { children: [props.done, "/", props.total] })] }));
}
/** 单次执行详情：每步状态与中间结果。 */
function RunDetail(props) {
    if (!props.run) {
        return (_jsx("div", { className: styles.section, children: _jsx(Spinner, { label: "\u52A0\u8F7D\u6267\u884C\u8BE6\u60C5\u2026" }) }));
    }
    const run = props.run;
    const stepRuns = Object.values(run.steps).sort((a, b) => a.startedAt - b.startedAt || a.stepId.localeCompare(b.stepId));
    return (_jsxs("div", { className: styles.section, children: [_jsxs("div", { className: styles.sectionHeader, children: [_jsxs("h3", { children: ["\u6267\u884C\u8BE6\u60C5 ", run.id, " ", _jsx(RunStatusPill, { status: run.status })] }), _jsx(Button, { size: "sm", variant: "ghost", onClick: props.onClose, children: "\u6536\u8D77" })] }), run.message ? _jsx("p", { className: styles.hint, children: run.message }) : null, _jsx("div", { className: styles.stepList, children: stepRuns.map((step) => (_jsxs("div", { className: styles.stepCard, children: [_jsxs("div", { className: styles.stepHead, children: [_jsx("span", { className: styles.stepName, children: step.stepId }), _jsxs("span", { className: styles.stepMeta, children: [step.status, " \u00B7 \u5C1D\u8BD5 ", step.attempts, " \u6B21 \u00B7 ", step.latencyMs, "ms \u00B7 ", step.tokens, " tokens"] })] }), step.error ? _jsxs("p", { className: styles.hint, children: ["\u9519\u8BEF\uFF1A", step.error] }) : null, step.output ? _jsx("pre", { className: styles.output, children: step.output }) : null] }, step.stepId))) })] }));
}
// ---------------------------------------------------------------------------
// H3：批量任务队列
// ---------------------------------------------------------------------------
/** 队列面板。 */
function QueuePanel() {
    const [tasks, setTasks] = useState([]);
    const [counts, setCounts] = useState({});
    const [form, setForm] = useState({
        name: '',
        prompt: '',
        model: 'deepseek-chat',
        priority: 'medium',
        failurePolicy: 'skip',
    });
    const [submitting, setSubmitting] = useState(false);
    const reload = useCallback(() => {
        fetchQueue()
            .then((response) => {
            setTasks(response.tasks);
            setCounts(response.counts);
        })
            .catch((error) => reportError(error, '加载队列失败'));
    }, []);
    // 链式 setTimeout 轮询（上次响应返回后再排下一次，避免慢响应下请求堆积）。
    useEffect(() => {
        let cancelled = false;
        let timer = null;
        const tick = () => {
            fetchQueue()
                .then((response) => {
                if (cancelled)
                    return;
                setTasks(response.tasks);
                setCounts(response.counts);
            })
                .catch((error) => {
                if (!cancelled)
                    reportError(error, '加载队列失败');
            })
                .finally(() => {
                if (!cancelled)
                    timer = window.setTimeout(tick, 5000);
            });
        };
        tick();
        return () => {
            cancelled = true;
            if (timer !== null)
                window.clearTimeout(timer);
        };
    }, []);
    const submit = () => {
        if (!form.name.trim() || !form.prompt.trim()) {
            Toast.push('任务名称与 Prompt 必填', 'warning');
            return;
        }
        setSubmitting(true);
        submitQueueTask({
            name: form.name.trim(),
            prompt: form.prompt,
            model: form.model.trim(),
            priority: form.priority,
            failurePolicy: form.failurePolicy,
        })
            .then(() => {
            Toast.push('任务已入队', 'success');
            // 函数式更新：只清 name/prompt，保留提交期间用户改动的其他字段。
            setForm((prev) => ({ ...prev, name: '', prompt: '' }));
            reload();
        })
            .catch((error) => reportError(error, '提交任务失败'))
            .finally(() => setSubmitting(false));
    };
    const batch = (action) => {
        batchQueue(action)
            .then((response) => {
            Toast.push(`已影响 ${response.changed} 个任务`, 'success');
            reload();
        })
            .catch((error) => reportError(error, '批量操作失败'));
    };
    return (_jsxs(_Fragment, { children: [_jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "\u961F\u5217\u72B6\u6001" }), _jsxs("div", { className: styles.counts, children: [_jsxs("div", { className: styles.countCard, children: [_jsx("span", { className: styles.countValue, children: counts.running ?? 0 }), _jsx("span", { children: "\u8FD0\u884C\u4E2D" })] }), _jsxs("div", { className: styles.countCard, children: [_jsx("span", { className: styles.countValue, children: counts.queued ?? 0 }), _jsx("span", { children: "\u6392\u961F\u4E2D" })] }), _jsxs("div", { className: styles.countCard, children: [_jsx("span", { className: styles.countValue, children: counts.done ?? 0 }), _jsx("span", { children: "\u5DF2\u5B8C\u6210" })] }), _jsxs("div", { className: styles.countCard, children: [_jsx("span", { className: styles.countValue, children: counts.failed ?? 0 }), _jsx("span", { children: "\u5931\u8D25" })] })] }), _jsxs("div", { className: styles.rowActions, children: [_jsx(Button, { size: "sm", variant: "secondary", onClick: () => batch('pause'), children: "\u6279\u91CF\u6682\u505C" }), _jsx(Button, { size: "sm", variant: "secondary", onClick: () => batch('resume'), children: "\u6279\u91CF\u6062\u590D" }), _jsx(Button, { size: "sm", variant: "danger", onClick: () => batch('cancel'), children: "\u6279\u91CF\u53D6\u6D88" }), _jsx(Button, { size: "sm", variant: "ghost", onClick: reload, children: "\u5237\u65B0" })] })] }), _jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "\u63D0\u4EA4\u65B0\u4EFB\u52A1" }), _jsxs("div", { className: styles.formGrid, children: [_jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u4EFB\u52A1\u540D\u79F0" }), _jsx(Input, { value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6A21\u578B" }), _jsx(Input, { value: form.model, onChange: (event) => setForm({ ...form, model: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u4F18\u5148\u7EA7" }), _jsxs(Select, { value: form.priority, onChange: (event) => setForm({ ...form, priority: event.target.value }), children: [_jsx("option", { value: "high", children: "\u9AD8" }), _jsx("option", { value: "medium", children: "\u4E2D" }), _jsx("option", { value: "low", children: "\u4F4E" })] })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u5931\u8D25\u7B56\u7565" }), _jsxs(Select, { value: form.failurePolicy, onChange: (event) => setForm({ ...form, failurePolicy: event.target.value }), children: [_jsx("option", { value: "skip", children: "\u8DF3\u8FC7" }), _jsx("option", { value: "retry", children: "\u91CD\u8BD5" }), _jsx("option", { value: "notify", children: "\u901A\u77E5" })] })] }), _jsxs("label", { className: `${styles.field} ${styles.fieldFull}`, children: [_jsx("span", { children: "Prompt" }), _jsx(Textarea, { rows: 3, value: form.prompt, onChange: (event) => setForm({ ...form, prompt: event.target.value }) })] })] }), _jsx("div", { children: _jsx(Button, { size: "sm", variant: "primary", disabled: submitting, onClick: submit, children: submitting ? '提交中…' : '提交任务' }) })] }), _jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "\u4EFB\u52A1\u5217\u8868" }), tasks.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u961F\u5217\u4E3A\u7A7A\u3002" })) : (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u540D\u79F0" }), _jsx("th", { children: "\u4F18\u5148\u7EA7" }), _jsx("th", { children: "\u72B6\u6001" }), _jsx("th", { children: "\u5C1D\u8BD5" }), _jsx("th", { children: "\u8F93\u51FA/\u9519\u8BEF" }), _jsx("th", { children: "\u64CD\u4F5C" })] }) }), _jsx("tbody", { children: tasks.map((task) => (_jsxs("tr", { children: [_jsx("td", { children: task.name }), _jsx("td", { children: task.priority }), _jsx("td", { children: task.status }), _jsx("td", { children: task.attempts }), _jsx("td", { children: task.error || task.output.slice(0, 80) || '-' }), _jsx("td", { children: _jsxs("div", { className: styles.rowActions, children: [task.status === 'queued' && (_jsx(Button, { size: "sm", variant: "secondary", onClick: () => pauseQueueTask(task.id).then(reload).catch((error) => reportError(error, '暂停失败')), children: "\u6682\u505C" })), task.status === 'paused' && (_jsx(Button, { size: "sm", variant: "secondary", onClick: () => resumeQueueTask(task.id).then(reload).catch((error) => reportError(error, '恢复失败')), children: "\u6062\u590D" })), (task.status === 'queued' || task.status === 'running' || task.status === 'paused') && (_jsx(Button, { size: "sm", variant: "danger", onClick: () => cancelQueueTask(task.id).then(reload).catch((error) => reportError(error, '取消失败')), children: "\u53D6\u6D88" })), task.status !== 'running' && (_jsx(Button, { size: "sm", variant: "ghost", onClick: () => deleteQueueTask(task.id).then(reload).catch((error) => reportError(error, '删除失败')), children: "\u5220\u9664" }))] }) })] }, task.id))) })] }))] })] }));
}
// ---------------------------------------------------------------------------
// H4：定时任务调度
// ---------------------------------------------------------------------------
/** 定时调度面板。 */
function JobPanel() {
    const [jobs, setJobs] = useState([]);
    const [form, setForm] = useState({ name: '', prompt: '', schedule: '', model: 'deepseek-chat', offPeakOnly: false });
    const [preview, setPreview] = useState(null);
    const [historyJobId, setHistoryJobId] = useState(null);
    const [history, setHistory] = useState([]);
    const reload = useCallback(() => {
        fetchJobs()
            .then((response) => setJobs(response.jobs))
            .catch((error) => reportError(error, '加载定时任务失败'));
    }, []);
    useEffect(() => {
        reload();
    }, [reload]);
    const doPreview = () => {
        if (!form.schedule.trim())
            return;
        parseSchedule(form.schedule.trim())
            .then((response) => setPreview(response))
            .catch((error) => {
            setPreview(null);
            reportError(error, '无法解析定时表达式');
        });
    };
    const submit = () => {
        if (!form.name.trim() || !form.prompt.trim() || !form.schedule.trim()) {
            Toast.push('名称、Prompt 与调度表达式必填', 'warning');
            return;
        }
        saveJob({
            name: form.name.trim(),
            prompt: form.prompt,
            schedule: form.schedule.trim(),
            model: form.model.trim(),
            offPeakOnly: form.offPeakOnly,
        })
            .then(() => {
            Toast.push('定时任务已保存', 'success');
            setForm({ name: '', prompt: '', schedule: '', model: 'deepseek-chat', offPeakOnly: false });
            setPreview(null);
            reload();
        })
            .catch((error) => reportError(error, '保存定时任务失败'));
    };
    const showHistory = (jobId) => {
        setHistoryJobId(jobId);
        fetchJobRuns(jobId)
            .then((response) => setHistory(response.runs))
            .catch((error) => reportError(error, '加载执行历史失败'));
    };
    return (_jsxs(_Fragment, { children: [_jsxs("section", { className: styles.section, children: [_jsx("h3", { children: "\u65B0\u5EFA\u5B9A\u65F6\u4EFB\u52A1\uFF08Cron \u6216\u81EA\u7136\u8BED\u8A00\uFF09" }), _jsxs("div", { className: styles.formGrid, children: [_jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u4EFB\u52A1\u540D\u79F0" }), _jsx(Input, { value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u8C03\u5EA6\u8868\u8FBE\u5F0F\uFF08\u5982\u300C\u6BCF\u5929\u51CC\u6668 2 \u70B9\u300D\u6216 0 2 * * *\uFF09" }), _jsx(Input, { value: form.schedule, onChange: (event) => setForm({ ...form, schedule: event.target.value }) })] }), _jsxs("label", { className: styles.field, children: [_jsx("span", { children: "\u6A21\u578B" }), _jsx(Input, { value: form.model, onChange: (event) => setForm({ ...form, model: event.target.value }) })] }), _jsx("div", { className: styles.field, children: _jsx(Checkbox, { checked: form.offPeakOnly, label: "\u4EC5\u5728\u7A7A\u95F2\uFF08\u8C37\u65F6\uFF09\u65F6\u6BB5\u6267\u884C\uFF0C\u4EAB\u53D7\u66F4\u4F4E\u4EF7\u683C", onChange: (checked) => setForm({ ...form, offPeakOnly: checked }) }) }), _jsxs("label", { className: `${styles.field} ${styles.fieldFull}`, children: [_jsx("span", { children: "Prompt" }), _jsx(Textarea, { rows: 3, value: form.prompt, onChange: (event) => setForm({ ...form, prompt: event.target.value }) })] })] }), _jsxs("div", { className: styles.rowActions, children: [_jsx(Button, { size: "sm", variant: "secondary", onClick: doPreview, children: "\u89E3\u6790\u9884\u89C8" }), _jsx(Button, { size: "sm", variant: "primary", onClick: submit, children: "\u4FDD\u5B58\u4EFB\u52A1" })] }), preview !== null && (_jsxs("p", { className: styles.hint, children: ["Cron\uFF1A", preview.cron, " \u00B7 \u4E0B\u6B21\u6267\u884C\uFF1A", formatTime(preview.nextRunAt)] }))] }), _jsxs("section", { className: styles.section, children: [_jsxs("div", { className: styles.sectionHeader, children: [_jsx("h3", { children: "\u5B9A\u65F6\u4EFB\u52A1\u5217\u8868" }), _jsx(Button, { size: "sm", variant: "secondary", onClick: reload, children: "\u5237\u65B0" })] }), jobs.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u6682\u65E0\u5B9A\u65F6\u4EFB\u52A1\u3002" })) : (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u540D\u79F0" }), _jsx("th", { children: "\u8C03\u5EA6" }), _jsx("th", { children: "\u72B6\u6001" }), _jsx("th", { children: "\u4E0B\u6B21\u6267\u884C" }), _jsx("th", { children: "\u6700\u8FD1\u6267\u884C" }), _jsx("th", { children: "\u64CD\u4F5C" })] }) }), _jsx("tbody", { children: jobs.map((job) => (_jsxs("tr", { children: [_jsxs("td", { children: [job.name, job.offPeakOnly ? '（空闲时段）' : ''] }), _jsx("td", { children: job.scheduleText }), _jsx("td", { children: job.enabled ? '启用' : '停用' }), _jsx("td", { children: job.enabled ? formatTime(job.nextRunAt) : '-' }), _jsx("td", { children: formatTime(job.lastRunAt) }), _jsx("td", { children: _jsxs("div", { className: styles.rowActions, children: [_jsx(Button, { size: "sm", variant: "secondary", onClick: () => {
                                                            toggleJob(job.id, !job.enabled)
                                                                .then(reload)
                                                                .catch((error) => reportError(error, '切换状态失败'));
                                                        }, children: job.enabled ? '停用' : '启用' }), _jsx(Button, { size: "sm", variant: "secondary", onClick: () => showHistory(job.id), children: "\u5386\u53F2" }), _jsx(Button, { size: "sm", variant: "danger", onClick: () => {
                                                            deleteJob(job.id)
                                                                .then(() => {
                                                                Toast.push('已删除', 'success');
                                                                reload();
                                                            })
                                                                .catch((error) => reportError(error, '删除失败'));
                                                        }, children: "\u5220\u9664" })] }) })] }, job.id))) })] })), historyJobId !== null && (_jsxs("div", { className: styles.section, children: [_jsxs("div", { className: styles.sectionHeader, children: [_jsxs("h3", { children: ["\u6267\u884C\u5386\u53F2\uFF08", historyJobId, "\uFF09"] }), _jsx(Button, { size: "sm", variant: "ghost", onClick: () => setHistoryJobId(null), children: "\u6536\u8D77" })] }), history.length === 0 ? (_jsx("p", { className: styles.empty, children: "\u6682\u65E0\u6267\u884C\u8BB0\u5F55\u3002" })) : (_jsxs("table", { className: styles.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u65F6\u95F4" }), _jsx("th", { children: "\u7ED3\u679C" }), _jsx("th", { children: "\u8017\u65F6" }), _jsx("th", { children: "\u8F93\u51FA/\u9519\u8BEF" })] }) }), _jsx("tbody", { children: history.map((run) => (_jsxs("tr", { children: [_jsx("td", { children: formatTime(run.ts) }), _jsx("td", { children: run.ok ? '成功' : '失败' }), _jsxs("td", { children: [run.latencyMs, "ms"] }), _jsx("td", { children: run.error || run.output.slice(0, 120) || '-' })] }, run.id))) })] }))] }))] })] }));
}
