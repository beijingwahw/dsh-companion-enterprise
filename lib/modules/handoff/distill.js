// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
/** 近端原文区缺省轮数。 */
export const DEFAULT_RECENT_TURNS = 6;
/** 单轮原文渲染的字符上限（防单轮爆预算；截头留尾）。 */
const PER_TURN_CHAR_CAP = 1_200;
/** 总字符预算缺省值。 */
export const DEFAULT_CHAR_BUDGET = 8_000;
/** 每类事实保留上限（近者优先）。 */
const FACTS_PER_KIND_CAP = 8;
/** 参与事实抽取的句子长度区间（过短无信息，过长是代码块）。 */
const SENTENCE_MIN_CHARS = 6;
const SENTENCE_MAX_CHARS = 160;
/** 事实类别标签（渲染用）。 */
const FACT_KIND_LABELS = {
    constraint: '约束',
    decision: '决策',
    action: '行动',
    reference: '参考',
    metric: '数值',
};
/** 抽取规则：类别 → 触发模式（顺序即优先级，一句只归一类）。 */
const FACT_RULES = [
    { kind: 'constraint', pattern: /不要|不能|不得|必须|禁止|避免|务必|不允许|切勿|别用|切忌/ },
    { kind: 'decision', pattern: /决定|选定|选择[了用]?|采用|方案[是为确]|结论[是为]|确认(使用|采用|走)|最终|敲定/ },
    { kind: 'action', pattern: /需要|待办|接下来|下一步|TODO|要做的|尚未|还需|之后要|再去/ },
    { kind: 'metric', pattern: /\d+(?:\.\d+)?\s*(?:%|元|块|ms|秒|分钟|小时|天|次|条|个|倍|[kKmM]token|token)|v?\d+\.\d+\.\d+/ },
];
/** 参考类实体：路径 / 命令 / 链接 / 标识。 */
const REFERENCE_PATTERN = /(?:[\w.-]+\/){1,}[\w.-]+\.\w{1,8}|https?:\/\/\S+|\b(?:npm|npx|pnpm|yarn|git|docker|kubectl|cargo|go|pytest|jest|vitest|tsc)\s+\S+|\b(?:ERR_[A-Z0-9_]+|CVE-\d{4}-\d+|#\d+)\b/;
// ---------------------------------------------------------------------------
// 句子切分与归一化
// ---------------------------------------------------------------------------
/** 句子切分：中文句读 + 换行（英文句点不切，保护路径/版本号/缩写）。 */
function splitSentences(text) {
    return text
        .split(/[\n。！？；!?;]+/)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence.length > 0);
}
/** 归一化：小写、去空白与标点（去重比对的宽容基础）。 */
function normalizeFact(text) {
    return text.toLowerCase().replace(/[\s，。、；：？！,.;:?!"'`（）()\[\]【】<>《》\-—_~·…]/g, '');
}
/** 同类事实去重：归一化相等或一方包含另一方视为同一事实。 */
function factDuplicate(existing, candidate) {
    const normalized = normalizeFact(candidate);
    if (normalized.length === 0)
        return true;
    for (const item of existing) {
        const other = normalizeFact(item);
        if (other === normalized)
            return true;
        if (other.length >= 10 && normalized.length >= 10) {
            if (other.includes(normalized) || normalized.includes(other))
                return true;
        }
    }
    return false;
}
/** 句子归类：按规则优先级返回类别，非事实句返回 undefined。 */
function classifySentence(sentence) {
    for (const rule of FACT_RULES) {
        if (rule.pattern.test(sentence))
            return rule.kind;
    }
    if (REFERENCE_PATTERN.test(sentence))
        return 'reference';
    return undefined;
}
/**
 * 从远端轮次抽取事实（近者优先覆盖：从最新句子向前扫，
 * 同类上限内先到先得——最新的约束/决策总是能占住坑位）。
 */
export function extractFacts(turns) {
    const buckets = new Map();
    // 时间正序输出：先近端倒扫收集，最后整体反转。
    for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
        const turn = turns[turnIndex];
        if (turn.role !== 'user' && turn.role !== 'assistant')
            continue;
        const sentences = splitSentences(turn.text);
        for (let sentenceIndex = sentences.length - 1; sentenceIndex >= 0; sentenceIndex -= 1) {
            const sentence = sentences[sentenceIndex];
            if (sentence.length < SENTENCE_MIN_CHARS || sentence.length > SENTENCE_MAX_CHARS)
                continue;
            const kind = classifySentence(sentence);
            if (kind === undefined)
                continue;
            const bucket = buckets.get(kind) ?? [];
            if (bucket.length >= FACTS_PER_KIND_CAP)
                continue;
            if (factDuplicate(bucket.map((fact) => fact.text), sentence))
                continue;
            bucket.push({ kind, role: turn.role, text: sentence });
            buckets.set(kind, bucket);
        }
    }
    // 反转为时间正序（阅读时"先因后果"）。
    const ordered = [];
    for (const kind of ['constraint', 'decision', 'action', 'reference', 'metric']) {
        const bucket = buckets.get(kind);
        if (bucket)
            ordered.push(...bucket.reverse());
    }
    return ordered;
}
/** 单轮原文渲染：超长时截头留尾（头部意图 + 尾部结果）。 */
function renderTurn(turn) {
    const speaker = turn.role === 'user' ? '用户' : turn.role === 'assistant' ? '助手' : turn.role;
    const body = turn.text.length <= PER_TURN_CHAR_CAP
        ? turn.text
        : `${turn.text.slice(0, Math.floor(PER_TURN_CHAR_CAP * 0.6))}……【中略】……${turn.text.slice(-Math.floor(PER_TURN_CHAR_CAP * 0.35))}`;
    return `### ${speaker}\n${body}`;
}
/**
 * 渐进式蒸馏主入口：远端事实抽取 + 近端原文 + 预算装配。
 * 空会话返回空产物（调用方负责前置校验）。
 */
export function distillContext(turns, options = {}) {
    const requestedRecent = Math.max(1, Math.floor(options.recentTurns ?? DEFAULT_RECENT_TURNS));
    const budget = Math.max(1_000, Math.floor(options.charBudget ?? DEFAULT_CHAR_BUDGET));
    if (turns.length === 0) {
        return {
            rendered: '',
            facts: [],
            stats: {
                totalTurns: 0,
                verbatimTurns: 0,
                distilledTurns: 0,
                factCount: 0,
                originalChars: 0,
                renderedChars: 0,
                compressionRatio: 0,
            },
        };
    }
    // 分区：远端（蒸馏）与近端（原文候选）。
    const splitIndex = Math.max(0, turns.length - requestedRecent);
    const farTurns = turns.slice(0, splitIndex);
    const nearTurns = turns.slice(splitIndex);
    const facts = extractFacts(farTurns);
    // 事实区渲染。
    const factLines = [];
    if (facts.length > 0) {
        factLines.push('■ 远端事实（早期对话的压缩记忆，按类别归档）');
        for (const fact of facts) {
            factLines.push(`- 〔${FACT_KIND_LABELS[fact.kind]}〕${fact.role === 'user' ? '用户' : '助手'}：${fact.text}`);
        }
        factLines.push('');
    }
    // 近端原文区：从最新轮次向前装填，直到预算耗尽（至少保 1 轮）。
    const renderedTurns = [];
    let used = factLines.join('\n').length;
    let verbatimCount = 0;
    for (let i = nearTurns.length - 1; i >= 0; i -= 1) {
        const rendered = renderTurn(nearTurns[i]);
        const isLast = renderedTurns.length === 0;
        // 至少装入最新一轮（预算不足时挤占事实区之后的全部剩余）。
        if (!isLast && used + rendered.length + 20 > budget)
            break;
        renderedTurns.unshift(rendered);
        verbatimCount += 1;
        used += rendered.length + 20;
    }
    const header = [
        '【渐进式上下文蒸馏】',
        `早期 ${farTurns.length} 轮已压缩为 ${facts.length} 条事实，最近 ${verbatimCount} 轮保留原文。`,
        '',
    ];
    const nearSection = renderedTurns.length > 0 ? ['■ 近端原文（最近轮次逐字保留）', ...renderedTurns] : [];
    const rendered = [...header, ...factLines, ...nearSection].join('\n').trimEnd();
    const originalChars = turns.reduce((sum, turn) => sum + turn.text.length, 0);
    const round4 = (value) => Math.round(value * 10_000) / 10_000;
    return {
        rendered,
        facts,
        stats: {
            totalTurns: turns.length,
            verbatimTurns: verbatimCount,
            distilledTurns: farTurns.length,
            factCount: facts.length,
            originalChars,
            renderedChars: rendered.length,
            compressionRatio: originalChars === 0 ? 0 : round4(rendered.length / originalChars),
        },
    };
}
