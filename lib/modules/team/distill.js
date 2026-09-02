import { teamId, tokenize } from './store.js';
// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
/** 信号挖矿最多回看轮次（长会话取尾部，控制本地计算量）。 */
export const MINING_TURN_CAP = 300;
/** 错误→修复的最大跨距（轮次）：超过视为无因果。 */
const RECOVERY_WINDOW = 12;
/** 信号得分低于该值的会话不值得蒸馏（批量扫描的缺省门槛）。 */
export const DEFAULT_MIN_SIGNAL = 0.45;
/** 语义去重 Jaccard 阈值：超过即合并而非新建。 */
export const DEDUP_JACCARD_THRESHOLD = 0.55;
/** 蒸馏卡滚动保留上限。 */
export const DISTILLED_CARD_LIMIT = 200;
/** 单轮摘录进入证据/提示词的字符上限。 */
const EXCERPT_CHAR_CAP = 400;
/** 蒸馏上下文窗口总字符预算。 */
const CONTEXT_CHAR_BUDGET = 6000;
/** 证据摘录每卡上限（错误+修复各留证据）。 */
const EVIDENCE_CAP = 4;
// ---------------------------------------------------------------------------
// 信号挖矿：错误→修复结构对检测
// ---------------------------------------------------------------------------
/** 错误信号词（轮次文本命中即视为错误候选轮）。 */
const ERROR_WORD = /error|exception|traceback|fail(?:ed|ure)?|crash|panic|denied|refused|invalid|超时|失败|错误|报错|异常|崩溃|无法|不能用|不工作|没反应/i;
/** 错误严重度计数词（重复出现加权）。 */
const ERROR_SEVERITY_WORD = /error|exception|traceback|fail(?:ed|ure)?|crash|panic|timeout|超时|失败|报错|异常|崩溃/gi;
/** 强修复信号词（明确的修复/成功表述）。 */
const STRONG_RECOVERY_WORD = /fix(?:ed|es)?|resolv(?:e|ed)|solved|success(?:ful)?|works?|passed|解决|修复|修好|搞定|成功|通过|正常了|能跑了|跑通了/i;
/** 用户确认词（错误与修复之间用户表达的正面确认）。 */
const USER_CONFIRM_WORD = /可以|好的|对的|没问题|完美|好使|生效|thanks|thank you|ok|great/i;
/** 截断单轮文本到摘录上限。 */
function excerptOf(text) {
    return text.length > EXCERPT_CHAR_CAP ? `${text.slice(0, EXCERPT_CHAR_CAP)}…` : text;
}
/**
 * 信号挖矿主入口：识别转录中全部不重叠的错误→修复结构对，
 * 按得分降序返回。得分构成：
 * - 严重度（0.35）：错误轮中错误词重复出现，越多越严重（3 次封顶）；
 * - 因果距离（0.25）：修复距错误越近越可能因果相关；
 * - 修复明确度（0.25）：明确"解决/修复/fixed"强于仅"不再报错"；
 * - 用户确认（0.15）：中间有用户正面确认，最强的人工验证信号。
 */
export function mineSignals(turns) {
    const candidates = [];
    for (let i = 0; i < turns.length; i += 1) {
        if (!ERROR_WORD.test(turns[i].text))
            continue;
        const severity = Math.min((turns[i].text.match(ERROR_SEVERITY_WORD) ?? []).length / 3, 1);
        for (let j = i + 1; j <= Math.min(i + RECOVERY_WINDOW, turns.length - 1); j += 1) {
            const recoveryText = turns[j].text;
            const strongRecovery = STRONG_RECOVERY_WORD.test(recoveryText);
            // 弱修复：修复轮本身不含错误词也算（错误停了），但明确度低。
            const stillError = ERROR_WORD.test(recoveryText);
            if (!strongRecovery && stillError)
                continue;
            const distance = 1 - (j - i) / (RECOVERY_WINDOW + 1);
            const explicitness = strongRecovery ? 1 : 0.4;
            let userConfirm = 0;
            for (let k = i + 1; k < j; k += 1) {
                if (turns[k].role === 'user' && USER_CONFIRM_WORD.test(turns[k].text)) {
                    userConfirm = 1;
                    break;
                }
            }
            const score = Math.min(0.35 * severity + 0.25 * distance + 0.25 * explicitness + 0.15 * userConfirm, 1);
            candidates.push({ errorIndex: i, recoveryIndex: j, score });
        }
    }
    // 2. 按得分降序贪心选择不重叠信号（一个轮次只归属一个结构对）。
    candidates.sort((a, b) => b.score - a.score);
    const usedTurns = new Set();
    const signals = [];
    for (const candidate of candidates) {
        if (usedTurns.has(candidate.errorIndex) || usedTurns.has(candidate.recoveryIndex))
            continue;
        usedTurns.add(candidate.errorIndex);
        usedTurns.add(candidate.recoveryIndex);
        const context = [];
        let budget = CONTEXT_CHAR_BUDGET;
        for (let k = candidate.errorIndex; k <= candidate.recoveryIndex && budget > 0; k += 1) {
            const text = excerptOf(turns[k].text);
            budget -= text.length;
            context.push({ ...turns[k], text });
        }
        signals.push({
            errorIndex: candidate.errorIndex,
            recoveryIndex: candidate.recoveryIndex,
            score: Math.round(candidate.score * 100) / 100,
            errorSeq: turns[candidate.errorIndex].seq,
            recoverySeq: turns[candidate.recoveryIndex].seq,
            errorExcerpt: excerptOf(turns[candidate.errorIndex].text),
            recoveryExcerpt: excerptOf(turns[candidate.recoveryIndex].text),
            context,
        });
    }
    return signals;
}
// ---------------------------------------------------------------------------
// 元提示蒸馏
// ---------------------------------------------------------------------------
/** 蒸馏元提示：从错误-修复上下文产出结构化经验卡。 */
export function buildDistillPrompt(signal) {
    const transcript = signal.context
        .map((turn) => `${turn.role === 'user' ? '用户' : '助手'}：${turn.text}`)
        .join('\n\n');
    return [
        '请从以下"错误与修复"上下文中蒸馏一张可复用的执行经验卡。只输出一个 JSON 对象，不要输出任何其他文字、解释或 markdown 代码栅栏。',
        '',
        '输出 JSON 的格式（字段名必须完全一致）：',
        '{',
        '  "title": "简短标题（≤30字，概括这是什么坑）",',
        '  "lesson": "一句话教训（以后遇到类似情况该怎么做，≤80字，必须具体可执行）",',
        '  "problem": "问题的典型表现与触发条件",',
        '  "solution": "解决方案的关键步骤",',
        '  "tags": ["标签1", "标签2"]',
        '}',
        '',
        '规则：',
        '1. 教训必须具体可执行（如"X 场景下先检查 Y 再做 Z"），拒绝"要仔细检查"式空话；',
        '2. 只蒸馏上下文中真实发生的事，不得推测未出现的信息；',
        '3. 标签 2-4 个，用中文或常见英文技术词（如"依赖冲突"、"超时"、"TypeScript"）；',
        '4. 所有文本用中文（代码标识符/路径保留原文）。',
        '',
        '上下文（错误发生 → 修复确认）：',
        transcript,
    ].join('\n');
}
/**
 * 容错解析模型输出：剥可能的代码栅栏、截取首个 `{` 到末个 `}`、
 * JSON.parse 后逐字段收窄（title/lesson/problem/solution 必须非空，
 * tags 剔除非字符串项并封顶 5 个）。解析失败抛 Error（调用方转 502）。
 */
export function parseDistilledCard(raw) {
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
    const record = parsed;
    const text = (key) => {
        const value = record[key];
        if (typeof value !== 'string' || !value.trim())
            throw new Error(`模型输出缺少合法的 ${key}`);
        return value.trim();
    };
    const tags = Array.isArray(record.tags)
        ? record.tags.filter((tag) => typeof tag === 'string' && tag.trim().length > 0)
            .map((tag) => tag.trim())
            .slice(0, 5)
        : [];
    return {
        title: text('title'),
        lesson: text('lesson'),
        problem: text('problem'),
        solution: text('solution'),
        tags,
    };
}
// ---------------------------------------------------------------------------
// 语义相似度
// ---------------------------------------------------------------------------
/** token 集合 Jaccard 相似度（0-1）。 */
export function jaccardTokens(a, b) {
    const ta = new Set(tokenize(a));
    const tb = new Set(tokenize(b));
    if (ta.size === 0 || tb.size === 0)
        return 0;
    let inter = 0;
    for (const token of ta) {
        if (tb.has(token))
            inter += 1;
    }
    return inter / (ta.size + tb.size - inter);
}
/** 卡片全文（去重比对文本）。 */
function cardTextOf(parts) {
    return `${parts.title} ${parts.lesson} ${parts.problem} ${parts.solution} ${parts.tags.join(' ')}`;
}
/**
 * 置信度：复发度为主（出现 3 次即满格——跨会话复发是经验真实性的
 * 最强证据），信号强度为辅。0-1。
 */
export function confidenceOf(card) {
    const recurrence = Math.min(card.occurrences / 3, 1);
    return Math.round((0.6 * recurrence + 0.4 * card.signalScore) * 100) / 100;
}
/** 蒸馏卡仓库：'distilled-cards' 表，键为卡片 id。 */
export class DistilledCardStore {
    table;
    constructor(domain) {
        this.table = domain.table('distilled-cards');
    }
    /** 全部卡片（按置信度降序，同置信度按复发时间降序）。 */
    list() {
        return this.table
            .entries()
            .map(([, card]) => card)
            .sort((a, b) => confidenceOf(b) - confidenceOf(a) || b.lastSeenAt - a.lastSeenAt);
    }
    get(id) {
        return this.table.get(id);
    }
    async delete(id) {
        await this.table.delete(id);
    }
    /** 会话是否已有蒸馏记录（批量扫描跳过依据）。 */
    hasSession(sessionId) {
        return this.list().some((card) => card.sourceSessions.includes(sessionId));
    }
    /**
     * 语义去重写入：与既有卡 Jaccard 超阈值 → 合并（occurrences +1、
     * lastSeenAt 更新、来源会话累积；蒸馏内容保留首版，防逐次改写漂移）；
     * 否则新建。返回写入结果与是否走了合并。
     */
    async dedupPut(content, signal, sessionId) {
        const text = cardTextOf(content);
        for (const existing of this.list()) {
            if (jaccardTokens(text, cardTextOf(existing)) >= DEDUP_JACCARD_THRESHOLD) {
                const merged = {
                    ...existing,
                    occurrences: existing.occurrences + 1,
                    lastSeenAt: Date.now(),
                    sourceSessions: existing.sourceSessions.includes(sessionId)
                        ? existing.sourceSessions
                        : [...existing.sourceSessions, sessionId],
                };
                await this.table.put(merged.id, merged);
                return { card: merged, merged: true };
            }
        }
        const now = Date.now();
        const card = {
            id: teamId('dist'),
            sessionId,
            sourceSessions: [sessionId],
            createdAt: now,
            lastSeenAt: now,
            occurrences: 1,
            signalScore: signal.score,
            title: content.title,
            lesson: content.lesson,
            problem: content.problem,
            solution: content.solution,
            tags: content.tags,
            evidence: [
                { seq: signal.errorSeq, kind: 'error', excerpt: signal.errorExcerpt },
                { seq: signal.recoverySeq, kind: 'recovery', excerpt: signal.recoveryExcerpt },
            ].slice(0, EVIDENCE_CAP),
            promoted: false,
        };
        await this.table.put(card.id, card);
        await this.trim();
        return { card, merged: false };
    }
    /** 标记已晋升。 */
    async markPromoted(id) {
        let updated;
        await this.table.update(id, (prev) => {
            if (prev === undefined)
                return undefined;
            updated = { ...prev, promoted: true };
            return updated;
        });
        return updated;
    }
    /** 滚动修剪：按 lastSeenAt 保留最近 DISTILLED_CARD_LIMIT 张。 */
    async trim() {
        const all = this.table
            .entries()
            .map(([, card]) => card)
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
        for (const card of all.slice(DISTILLED_CARD_LIMIT)) {
            await this.table.delete(card.id);
        }
    }
}
