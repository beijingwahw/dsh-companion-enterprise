/**
 * 模块 J 创新扩展：敏感数据污点追踪（Taint Tracking for DLP）。
 *
 * 既有 DLP 是「点防御」：扫描单条 Prompt、命中即拦截/脱敏。但数据泄露
 * 很少发生在引入点——手机号先出现在用户的第 3 轮消息里（那一刻只是
 * 存在，并未外泄），随后被助手复述、写进文件、最终进入一个 http 工具
 * 调用的参数——真正的泄露发生在「传播链的终点」。信息流安全领域的
 * 经典结论：只看单点永远抓不住泄露，必须追踪数据从 source 到 sink
 * 的完整路径（Denning 格模型 → 浏览器 JS 污点分析一脉相承）。
 *
 * 方法论（三段式 taint analysis）：
 * 1. Source：在用户消息中检测敏感值（复用 DLP 规则引擎的原始命中），
 *    登记为污点源，以「归一化形态」（去空白/连字符、小写）为追踪键；
 * 2. Propagation：顺序扫描后续事件（助手消息/工具调用/工具结果/
 *    模型调用），归一化事件文本后包含追踪键即记一跳——污点随数据
 *    流动而扩散；
 * 3. Sink：对携带污点的事件分级定性信道——
 *    - outbound（外发工具：http/webhook/send/upload…）→ 高危，泄露成立；
 *    - storage（落盘工具：write/save/export…）→ 中危，数据离开会话边界；
 *    - model（进入 LLM API 请求）→ 低危，云端合规暴露；
 *    - internal（仅在会话内传播）→ 信息级。
 *
 * 安全红线：报告全程只出现掩码值（maskSample），原始敏感值仅存在于
 * 追踪过程内部，绝不进入任何响应或日志。
 */
import { findRawMatches, maskSample } from './dlp.js';
// --------------------------------------------------------------------
// 参数
// --------------------------------------------------------------------
/** 追踪的污点源上限（超出部分并入统计但不建链）。 */
const MAX_SOURCES = 50;
/** 单条传播链展示上限。 */
const MAX_HOPS = 50;
/** 外发信道工具名特征。 */
const OUTBOUND_TOOL_RE = /http|fetch|request|webhook|curl|wget|post|send|mail|smtp|upload|submit|push|notify|browser|nav|share/i;
/** 落盘信道工具名特征。 */
const STORAGE_TOOL_RE = /write|save|file|fs\b|log|export|commit|store|dump/i;
// --------------------------------------------------------------------
// 纯函数
// --------------------------------------------------------------------
/** 追踪键归一化：去空白/连字符 + 小写（分组书写的号码与 JSON 转写对齐）。 */
function trackingKey(value) {
    return value.replace(/[\s\-+]/g, '').toLowerCase();
}
/** 事件文本归一化（与 trackingKey 同构，使包含判定可靠）。 */
function normalizeForSearch(text) {
    return text.replace(/[\s\-+]/g, '').toLowerCase();
}
/** 提取事件的可检索文本（载荷任意形状 → 字符串化）。 */
function eventText(data) {
    if (typeof data === 'string')
        return data;
    if (data === undefined || data === null)
        return '';
    try {
        return JSON.stringify(data) ?? '';
    }
    catch {
        return String(data);
    }
}
/** 将原始日志事件流规整为污点分析视图（只保留可传播污点的事件类别）。 */
function eventViews(snapshot) {
    const views = [];
    for (const event of snapshot.events) {
        const data = event.data ?? {};
        const record = (data && typeof data === 'object' ? data : {});
        let view;
        switch (event.type) {
            case 'user/message': {
                const content = record.content ?? event.data;
                view = {
                    seq: event.seq,
                    time: event.time,
                    kind: 'user',
                    label: '用户消息',
                    text: typeof content === 'string' ? content : eventText(content),
                    isModelCall: false,
                };
                break;
            }
            case 'assistant/message': {
                const message = record.message;
                const content = message?.content ?? record.content;
                view = {
                    seq: event.seq,
                    time: event.time,
                    kind: 'assistant',
                    label: '助手消息',
                    text: typeof content === 'string' ? content : eventText(content),
                    isModelCall: false,
                };
                break;
            }
            case 'tool/call':
            case 'tool/start': {
                const name = typeof record.name === 'string' ? record.name : '工具调用';
                view = {
                    seq: event.seq,
                    time: event.time,
                    kind: 'tool-call',
                    label: `工具调用：${name}`,
                    text: eventText(event.data),
                    toolName: name,
                    isModelCall: false,
                };
                break;
            }
            case 'tool/result': {
                view = {
                    seq: event.seq,
                    time: event.time,
                    kind: 'tool-result',
                    label: '工具结果',
                    text: eventText(event.data),
                    isModelCall: false,
                };
                break;
            }
            case 'model/call':
            case 'llm/request': {
                const model = typeof record.model === 'string' ? record.model : '模型';
                view = {
                    seq: event.seq,
                    time: event.time,
                    kind: 'model-call',
                    label: `模型调用：${model}`,
                    text: eventText(event.data),
                    isModelCall: true,
                };
                break;
            }
            case 'model/completion':
            case 'llm/response': {
                view = {
                    seq: event.seq,
                    time: event.time,
                    kind: 'model-completion',
                    label: '模型响应',
                    text: eventText(event.data),
                    isModelCall: false,
                };
                break;
            }
            case 'agent/dispatch': {
                const agent = typeof record.agent === 'string' ? record.agent : '子 Agent';
                view = {
                    seq: event.seq,
                    time: event.time,
                    kind: 'agent-dispatch',
                    label: `子 Agent：${agent}`,
                    text: eventText(event.data),
                    isModelCall: false,
                };
                break;
            }
            default:
                break;
        }
        if (view)
            views.push(view);
    }
    return views;
}
/** 工具调用信道分级。 */
function toolChannel(toolName) {
    if (OUTBOUND_TOOL_RE.test(toolName))
        return 'outbound';
    if (STORAGE_TOOL_RE.test(toolName))
        return 'storage';
    return 'internal';
}
function severityOf(channel) {
    if (channel === 'outbound')
        return 'high';
    if (channel === 'storage')
        return 'medium';
    return 'low';
}
/**
 * 污点追踪主函数（纯函数：快照 + 规则集 → 报告）。
 * @param snapshot 会话日志快照（sessionQuery.readSession 的返回）。
 * @param rules DLP 规则集（内置 + 自定义；禁用规则不参与）。
 */
export function trackTaint(snapshot, rules) {
    const views = eventViews(snapshot);
    // 1. Source：仅用户消息可成为污点源（不可信输入引入点）。
    const sourceKeys = new Map();
    for (const view of views) {
        if (view.kind !== 'user')
            continue;
        for (const match of findRawMatches(view.text, rules)) {
            const key = trackingKey(match.value);
            if (key.length < 4 || sourceKeys.has(key) || sourceKeys.size >= MAX_SOURCES)
                continue;
            sourceKeys.set(key, {
                ruleId: match.ruleId,
                ruleName: match.ruleName,
                masked: maskSample(match.value),
                seq: view.seq,
                time: view.time,
            });
        }
    }
    const sources = [...sourceKeys.values()];
    // 2/3. Propagation + Sink：源 seq 之后每个事件的归一化文本做包含判定。
    const taintedEvents = new Set();
    const flows = [];
    for (const [key, source] of sourceKeys) {
        const hops = [];
        let sink = 'internal';
        let sinkLabel = '仅会话内传播';
        let truncated = false;
        for (const view of views) {
            if (view.seq <= source.seq)
                continue;
            if (!normalizeForSearch(view.text).includes(key))
                continue;
            taintedEvents.add(view.seq);
            if (hops.length < MAX_HOPS) {
                hops.push({ seq: view.seq, time: view.time, kind: view.kind, label: view.label });
            }
            else {
                truncated = true;
            }
            // 汇点升级只进不退：outbound > storage > model > internal。
            const channel = view.isModelCall
                ? 'model'
                : view.kind === 'tool-call'
                    ? toolChannel(view.toolName ?? '')
                    : 'internal';
            if (channel !== 'internal' &&
                (sink === 'internal' ||
                    (sink === 'model' && channel !== 'model') ||
                    (sink === 'storage' && channel === 'outbound'))) {
                sink = channel;
                sinkLabel = view.label;
            }
        }
        flows.push({
            source,
            hops,
            sink,
            sinkLabel,
            severity: severityOf(sink),
            truncated,
        });
    }
    flows.sort((a, b) => {
        const rank = { high: 0, medium: 1, low: 2 };
        return rank[a.severity] - rank[b.severity] || a.source.seq - b.source.seq;
    });
    const outboundFlows = flows.filter((f) => f.sink === 'outbound').length;
    const storageFlows = flows.filter((f) => f.sink === 'storage').length;
    const modelFlows = flows.filter((f) => f.sink === 'model').length;
    const riskLevel = outboundFlows > 0
        ? 'high'
        : storageFlows > 0
            ? 'medium'
            : flows.length > 0
                ? 'low'
                : 'none';
    const advice = riskLevel === 'high'
        ? '敏感值已进入外发工具参数，存在实际泄露路径：复核该工具调用，必要时开启 DLP 严格模式拦截'
        : riskLevel === 'medium'
            ? '敏感值已写入落盘工具（文件/日志/导出），数据离开会话边界：检查产物去向与访问权限'
            : riskLevel === 'low'
                ? '敏感值仅在会话内传播或进入模型请求：无外发路径，保持常规 DLP 监控即可'
                : '未检测到敏感值污点源';
    return {
        sessionId: snapshot.session.id,
        scannedAt: Date.now(),
        sources,
        flows,
        stats: {
            sourceCount: sources.length,
            taintedEventCount: taintedEvents.size,
            outboundFlows,
            storageFlows,
            modelFlows,
        },
        riskLevel,
        advice,
    };
}
