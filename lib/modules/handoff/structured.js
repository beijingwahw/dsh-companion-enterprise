// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
/** 世系深度告警阈值：超过该代数的注入文本携带"回读源头"告警。 */
export const LINEAGE_DEPTH_WARN_THRESHOLD = 3;
/** 结构化交接记录滚动保留条数上限（世系表按时间升序修剪）。 */
const LINEAGE_KEEP_LIMIT = 200;
/** 归档项注入渲染的字符上限（防归档膨胀挤占锚定预算）。 */
const ARCHIVED_RENDER_CHAR_CAP = 600;
// ---------------------------------------------------------------------------
// 哈希与归一化
// ---------------------------------------------------------------------------
/** FNV-1a 32 位哈希（十六进制；用于跨代锚定比对，非密码学用途）。 */
export function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}
/** 文本归一化：小写、去全部空白与常见标点（跨代表述比对的宽容基础）。 */
export function normalizeText(text) {
    return text
        .toLowerCase()
        .replace(/[\s，。、；：？！,.;:?!"'`（）()\[\]【】<>《》\-—_~·…]/g, '');
}
/**
 * 锚定项相似判定：归一化后相等，或（长度足够时）一方包含另一方。
 * 模型逐代改写措辞时哈希必然变化，靠包含关系识别"同一约束的新表述"。
 */
export function anchorSimilar(a, b) {
    const na = normalizeText(a);
    const nb = normalizeText(b);
    if (na === nb)
        return true;
    if (na.length >= 8 && nb.length >= 8) {
        return na.includes(nb) || nb.includes(na);
    }
    return false;
}
// ---------------------------------------------------------------------------
// 提示词构造
// ---------------------------------------------------------------------------
/** 生成结构化交接的元提示（要求模型输出严格 JSON）。 */
export function buildStructuredHandoffPrompt(conversation, parent) {
    const parentSection = parent === null
        ? '本次是初代交接（无前代约束）。'
        : [
            '本次是第 ' + (parent.depth + 1) + ' 代交接。以下是前代交接的全部锚定约束，',
            '你必须在输出 JSON 的 parentAnchorDispositions 数组中对每一条给出显式处置：',
            '- inherited：约束仍然成立，且已写入本次 anchors（措辞可优化，语义须保留）；',
            '- evolved：约束已变化，本次 anchors 中有其新表述；',
            '- dropped：约束已失效，必须给 reason。',
            '',
            '前代锚定约束：',
            ...parent.tiers.anchors.map((a, i) => `${i + 1}. ${a.text}`),
        ].join('\n');
    return [
        '请分析以下对话，生成结构化交接文档。只输出一个 JSON 对象，不要输出任何其他文字、解释或 markdown 代码栅栏。',
        '',
        '信息分级标准：',
        '- anchors（锚定约束）：不可丢失的硬约束、已确定的决策、关键前提。丢失代价最高，宁多勿漏。每条是一个完整的可执行陈述。',
        '- active（活动项）：正在进行的工作（in_progress）、明确的下一步（next）、开放问题（open_question）。',
        '- reference（参考）：关键文件路径（path）、命令（command）、重要 ID（id）、外部链接（link）。',
        '- archived（归档）：已完成的事项，每条一句话即可，不要展开细节。',
        '',
        '输出 JSON 的格式（字段名必须完全一致）：',
        '{',
        '  "anchors": [{"text": "..."}],',
        '  "active": [{"kind": "in_progress|next|open_question", "text": "..."}],',
        '  "reference": [{"kind": "path|command|id|link|other", "text": "..."}],',
        '  "archived": [{"text": "..."}],',
        '  "parentAnchorDispositions": [{"anchorText": "前代约束原文", "action": "inherited|evolved|dropped", "reason": "dropped/evolved 必填"}]',
        '}',
        '',
        '规则：',
        '1. anchors 数量控制在 3-8 条，只收录真正"违反了就会走回头路/产出错误"的约束；',
        '2. parentAnchorDispositions 必须覆盖前代全部锚定约束，一条不落；',
        '3. inherited/evolved 的约束必须同时在 anchors 数组中出现；',
        '4. 所有文本用中文（代码标识符/路径保留原文）。',
        '',
        parentSection,
        '',
        '对话内容：',
        conversation,
    ].join('\n');
}
/**
 * 容错解析模型输出：剥可能的 markdown 代码栅栏、截取首个 `{` 到末个 `}`、
 * JSON.parse 失败时抛出带原因的错误（调用方转 502）。
 */
export function parseStructuredHandoff(raw) {
    const trimmed = raw.trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
        throw new Error('模型输出中未找到 JSON 对象');
    }
    let parsed;
    try {
        parsed = JSON.parse(trimmed.slice(start, end + 1));
    }
    catch (error) {
        throw new Error(`模型输出 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('模型输出不是 JSON 对象');
    }
    return parsed;
}
/** 收窄字符串数组字段（unknown[] → string[]，剔除非字符串项）。 */
function stringItems(value, textKey = 'text') {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        if (typeof item === 'string') {
            if (item.trim())
                out.push(item.trim());
        }
        else if (typeof item === 'object' && item !== null) {
            const text = item[textKey];
            if (typeof text === 'string' && text.trim())
                out.push(text.trim());
        }
    }
    return out;
}
/**
 * 锚定继承守门：对父代每个锚定项执行强制继承校验。
 *
 * 判定顺序（保真优先——存疑一律补回）：
 * 1. 模型处置为 dropped 且给了理由 → 允许废弃（记录在案，可审计）；
 * 2. 其余情形（inherited/evolved/完全遗漏）在新 anchors 中找相似项：
 *    找到 → 标记继承/演进（origin 指向父代交接）；
 *    找不到 → 自动补回父代原文（autoRestored=true，reason 说明守门来源）。
 */
export function enforceAnchorInheritance(parent, newAnchorTexts, modelDispositions) {
    const anchors = newAnchorTexts.map((text) => ({
        hash: fnv1a(text),
        text,
        origin: null,
        autoRestored: false,
    }));
    const dispositions = [];
    let autoRestoredCount = 0;
    if (parent === null)
        return { anchors, dispositions, autoRestoredCount };
    for (const parentAnchor of parent.tiers.anchors) {
        // 模型是否处置了这一条（按文本相似匹配处置记录）。
        const claimed = modelDispositions.find((d) => anchorSimilar(d.anchorText, parentAnchor.text));
        const claimedAction = claimed?.action;
        if (claimedAction === 'dropped' && claimed?.reason) {
            dispositions.push({
                anchorHash: parentAnchor.hash,
                anchorText: parentAnchor.text,
                action: 'dropped',
                reason: claimed.reason,
            });
            continue;
        }
        // 在新 anchors 中找相似项（模型是否真的把它写进去了）。
        const matchedIndex = anchors.findIndex((a) => anchorSimilar(a.text, parentAnchor.text));
        if (matchedIndex !== -1) {
            anchors[matchedIndex] = {
                ...anchors[matchedIndex],
                origin: parent.handoffId,
                autoRestored: false,
            };
            dispositions.push({
                anchorHash: parentAnchor.hash,
                anchorText: parentAnchor.text,
                action: claimedAction === 'evolved' ? 'evolved' : 'inherited',
                reason: claimed?.reason,
            });
            continue;
        }
        // 未继承也未显式废弃：守门自动补回——静默丢失在结构上不可能。
        anchors.push({
            hash: parentAnchor.hash,
            text: parentAnchor.text,
            origin: parent.handoffId,
            autoRestored: true,
        });
        dispositions.push({
            anchorHash: parentAnchor.hash,
            anchorText: parentAnchor.text,
            action: 'inherited',
            reason: claimed
                ? `模型声称 ${claimedAction} 但新文档中无对应锚定，守门已补回原文`
                : '模型未处置该锚定项，守门已补回原文',
        });
        autoRestoredCount += 1;
    }
    return { anchors, dispositions, autoRestoredCount };
}
// ---------------------------------------------------------------------------
// 文档组装
// ---------------------------------------------------------------------------
/** 生成新的交接 handoffId（hd_ 前缀 + base36 时间戳 + 随机后缀）。 */
export function newHandoffId() {
    return `hd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
const ACTIVE_KINDS = new Set(['in_progress', 'next', 'open_question']);
const REFERENCE_KINDS = new Set(['path', 'command', 'id', 'link', 'other']);
/**
 * 从模型输出组装完整的 StructuredHandoff（解析 → 收窄 → 守门 → 世系组装）。
 * 任何一级失败都抛 Error（HTTP 层转错误响应），绝不静默降级为半成品。
 */
export function assembleStructuredHandoff(rawModelOutput, parent, sourceSessionId) {
    const raw = parseStructuredHandoff(rawModelOutput);
    const anchorTexts = stringItems(raw.anchors);
    const modelDispositions = Array.isArray(raw.parentAnchorDispositions)
        ? raw.parentAnchorDispositions.flatMap((item) => {
            if (typeof item !== 'object' || item === null)
                return [];
            const rec = item;
            if (typeof rec.anchorText !== 'string')
                return [];
            const action = typeof rec.action === 'string' ? rec.action : '';
            const reason = typeof rec.reason === 'string' ? rec.reason : undefined;
            return [{ anchorText: rec.anchorText.trim(), action, reason }];
        })
        : [];
    const { anchors, dispositions, autoRestoredCount } = enforceAnchorInheritance(parent, anchorTexts, modelDispositions);
    const active = (Array.isArray(raw.active) ? raw.active : []).flatMap((item) => {
        if (typeof item !== 'object' || item === null)
            return [];
        const rec = item;
        if (typeof rec.text !== 'string' || !rec.text.trim())
            return [];
        const kind = typeof rec.kind === 'string' && ACTIVE_KINDS.has(rec.kind) ? rec.kind : 'in_progress';
        return [{ kind: kind, text: rec.text.trim() }];
    });
    const reference = (Array.isArray(raw.reference) ? raw.reference : []).flatMap((item) => {
        if (typeof item !== 'object' || item === null)
            return [];
        const rec = item;
        if (typeof rec.text !== 'string' || !rec.text.trim())
            return [];
        const kind = typeof rec.kind === 'string' && REFERENCE_KINDS.has(rec.kind) ? rec.kind : 'other';
        return [{ kind: kind, text: rec.text.trim() }];
    });
    const archived = stringItems(raw.archived).map((text) => ({ text }));
    const handoff = {
        handoffId: newHandoffId(),
        parentHandoffId: parent?.handoffId ?? null,
        sourceSessionId,
        createdAt: Date.now(),
        depth: (parent?.depth ?? -1) + 1,
        lineage: parent ? [...parent.lineage, parent.handoffId] : [],
        tiers: { anchors, active, reference, archived },
        dispositions,
        deliveredTo: [],
    };
    return { handoff, autoRestoredCount };
}
// ---------------------------------------------------------------------------
// 注入渲染
// ---------------------------------------------------------------------------
/** 注入文本中的世系标记行（装配回调据此回写投递轨迹）。 */
export const LINEAGE_MARKER_PATTERN = /【世系\s+(hd_[a-z0-9]+)】/;
const ACTIVE_LABEL = {
    in_progress: '进行中',
    next: '下一步',
    open_question: '开放问题',
};
const REFERENCE_LABEL = {
    path: '路径',
    command: '命令',
    id: 'ID',
    link: '链接',
    other: '参考',
};
/**
 * 渲染为系统提示词注入文本：分层呈现，TIER 1 配强指令与世袭标注，
 * TIER 4 压缩为单行清单；深度超阈值时附"回读源头"告警。
 * 首行携带世系标记（LINEAGE_MARKer_PATTERN 可解析），供投递回写。
 */
export function renderStructuredForInjection(handoff) {
    const lines = [];
    const deep = handoff.depth + 1 > LINEAGE_DEPTH_WARN_THRESHOLD;
    lines.push('【结构化交接摘要】', `【世系 ${handoff.handoffId}】第 ${handoff.depth + 1} 代交接（源自会话 ${handoff.sourceSessionId}${handoff.parentHandoffId ? `，前代 ${handoff.parentHandoffId}` : ''}）`);
    if (deep) {
        lines.push(`⚠ 注意：本上下文已传承 ${handoff.depth + 1} 代，逐代转述可能造成信息损耗；`, '涉及关键决策时建议回读源头会话原文核实。');
    }
    lines.push('');
    // TIER 1：锚定约束（完整注入 + 强指令）。
    if (handoff.tiers.anchors.length > 0) {
        lines.push('■ 锚定约束（以下各条不得违反；标〔世袭〕者为历代强制继承）');
        handoff.tiers.anchors.forEach((a, i) => {
            const tag = a.origin !== null ? (a.autoRestored ? '〔世袭·守门补回〕' : '〔世袭〕') : '';
            lines.push(`${i + 1}. ${tag}${a.text}`);
        });
        lines.push('');
    }
    // TIER 2：活动项（按进行中/下一步/开放问题分组）。
    if (handoff.tiers.active.length > 0) {
        lines.push('■ 进行中与下一步');
        for (const item of handoff.tiers.active) {
            lines.push(`- ${ACTIVE_LABEL[item.kind]}：${item.text}`);
        }
        lines.push('');
    }
    // TIER 3：参考项。
    if (handoff.tiers.reference.length > 0) {
        lines.push('■ 关键参考');
        for (const item of handoff.tiers.reference) {
            lines.push(`- ${REFERENCE_LABEL[item.kind]}：${item.text}`);
        }
        lines.push('');
    }
    // TIER 4：归档（压缩为单行清单，设字符上限）。
    if (handoff.tiers.archived.length > 0) {
        lines.push('■ 已完成（防重复劳动，无需展开）');
        let text = handoff.tiers.archived.map((a) => a.text).join('；');
        if (text.length > ARCHIVED_RENDER_CHAR_CAP)
            text = `${text.slice(0, ARCHIVED_RENDER_CHAR_CAP)}…`;
        lines.push(`- ${text}`);
        lines.push('');
    }
    return lines.join('\n').trimEnd();
}
/** 世系链存储：handoff-structured 表，键为 handoffId。 */
export class LineageStore {
    table;
    constructor(domain) {
        this.table = domain.table('handoff-structured');
    }
    /** 保存交接记录并滚动修剪（按创建时间保留最近 LINEAGE_KEEP_LIMIT 条）。 */
    async save(handoff) {
        await this.table.put(handoff.handoffId, handoff);
        const entries = this.table.entries();
        if (entries.length <= LINEAGE_KEEP_LIMIT)
            return;
        const stale = entries
            .sort((a, b) => a[1].createdAt - b[1].createdAt)
            .slice(0, entries.length - LINEAGE_KEEP_LIMIT);
        for (const [key] of stale)
            await this.table.delete(key);
    }
    /** 按 id 读取（不存在返回 undefined）。 */
    get(handoffId) {
        return this.table.get(handoffId);
    }
    /** 记录投递：把目标会话追加到 deliveredTo（去重）。 */
    async markDelivered(handoffId, sessionId) {
        await this.table.update(handoffId, (prev) => {
            if (prev === undefined)
                return undefined;
            if (prev.deliveredTo.includes(sessionId))
                return prev;
            return { ...prev, deliveredTo: [...prev.deliveredTo, sessionId] };
        });
    }
    /** 全部记录的摘要视图（按创建时间降序）。 */
    listSummaries() {
        return this.table
            .entries()
            .map(([, h]) => ({
            handoffId: h.handoffId,
            parentHandoffId: h.parentHandoffId,
            sourceSessionId: h.sourceSessionId,
            createdAt: h.createdAt,
            depth: h.depth,
            anchorCount: h.tiers.anchors.length,
            activeCount: h.tiers.active.length,
            archivedCount: h.tiers.archived.length,
            autoRestoredCount: h.tiers.anchors.filter((a) => a.autoRestored).length,
            droppedCount: h.dispositions.filter((d) => d.action === 'dropped').length,
            deliveredTo: h.deliveredTo,
        }))
            .sort((a, b) => b.createdAt - a.createdAt);
    }
    /** 查找注入到指定会话的最近一次交接（作为该会话生成交接时的父代）。 */
    findLatestDeliveredTo(sessionId) {
        const delivered = this.table
            .entries()
            .map(([, h]) => h)
            .filter((h) => h.deliveredTo.includes(sessionId))
            .sort((a, b) => b.createdAt - a.createdAt);
        return delivered[0];
    }
    /**
     * 从指定交接向上溯源到根（含自身，按世代从新到旧）。
     * 祖先记录已被修剪掉时链在此截断（返回已收集部分 + truncated 标记）。
     */
    trace(handoffId) {
        const chain = [];
        let current = this.table.get(handoffId);
        let truncated = false;
        while (current !== undefined) {
            chain.push(current);
            if (current.parentHandoffId === null)
                break;
            const parent = this.table.get(current.parentHandoffId);
            if (parent === undefined) {
                truncated = true;
                break;
            }
            current = parent;
        }
        return { chain, truncated };
    }
}
