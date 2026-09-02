/**
 * 模块 F 创新扩展：Prompt Token 预算编译器（Budget Compiler）。
 *
 * 长上下文的隐性代价是「每 token 都计费、每 token 都稀释注意力」。
 * 手工裁 Prompt 是逐字符的苦役——编译器思想是把它变成一次编译：
 * Prompt 是源代码，组件是 AST 节点，token 预算是寄存器约束，
 * 编译目标是在预算内最大化「指令保真度」。
 *
 * 流水线：
 * 1. 词法分段：按空行/标题切段，每段按关键词归类为六类组件——
 *    role（角色设定）/instruction（任务指令）/constraint（约束）/
 *    format（输出格式）/example（few-shot 示例）/context（背景）；
 * 2. 保真度评分：不同组件对任务成败的边际贡献不同——角色与指令
 *    是语义骨架（不可裁），示例与背景是增强材料（可裁可压）；
 * 3. 预算分配（贪心 pass）：
 *    a. 全部组件入队，超出预算时按「单位 token 保真度」从低到高淘汰；
 *    b. example 支持「截半」软化裁剪（保留首个示例）；
 *    c. context 支持「首尾保留、中段删除」的滑窗压缩（LLM 对首尾
 *       位置注意力最强，呼应 lost-in-the-middle）；
 * 4. 编译报告：每个组件的去向决策 + 前后 token 对比 + 保真度损耗，
 *    裁剪不再黑箱。
 */
/** 组件类别中文标签。 */
export const COMPONENT_KIND_LABELS = {
    role: '角色设定',
    instruction: '任务指令',
    constraint: '约束条件',
    format: '输出格式',
    example: '示例',
    context: '背景信息',
};
/** 各组件类别的保真度权重（裁剪时的边际损失）。 */
const KIND_WEIGHT = {
    role: 1.0,
    instruction: 0.95,
    constraint: 0.85,
    format: 0.8,
    example: 0.5,
    context: 0.4,
};
/** 裁剪顺序（单位 token 保真度从低到高）：背景先删、示例再截。 */
const DROP_ORDER = ['context', 'example', 'format', 'constraint'];
/** 组件归类关键词（中文 + 英文常见形态）。 */
const KIND_PATTERNS = [
    { kind: 'format', regex: /^(输出|返回|响应|响应格式|输出格式|格式要求|answer|output|response|format|返回如下|json|xml|markdown|表格|列表格式)/i },
    { kind: 'example', regex: /^(示例|样例|例子|例如|范例|few-shot|example|如：|比如)/i },
    { kind: 'constraint', regex: /^(约束|限制|注意|必须|不要|禁止|避免|要求|规则|限制条件|constraint|must not|do not|never|always|注意：)/i },
    { kind: 'role', regex: /^(你是|你现在是|你将扮演|扮演|作为一名|你是一名|act as|you are|as a|role:)/i },
    { kind: 'instruction', regex: /^(请|帮我|需要|任务|要求你|你的任务|请执行|生成|编写|分析|总结|翻译|重构|task:|please|write|analyze|summarize|translate|refactor)/i },
];
/** 段落归类：关键词优先，未命中归 context。 */
function classifySegment(text) {
    const firstLine = text.trim().split('\n')[0].trim();
    for (const { kind, regex } of KIND_PATTERNS) {
        if (regex.test(firstLine))
            return kind;
    }
    return 'context';
}
/**
 * Token 估算（混合中英）：CJK 字符 ≈ 0.6 token/字，
Latin 字符 ≈ 0.25 token/字符（对齐主流分词器经验值）。
 */
export function estimateTokens(text) {
    let cjk = 0;
    let latin = 0;
    for (const ch of text) {
        if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch))
            cjk += 1;
        else if (/\S/.test(ch))
            latin += 1;
    }
    return Math.ceil(cjk * 0.6 + latin * 0.25);
}
/** 文本拆段（按空行；单个超长段按句号再切）。 */
function splitSegments(prompt) {
    const segments = prompt
        .split(/\n\s*\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    // 超长段（> 500 字符）按句读再切，粒度对齐组件级裁剪。
    const refined = [];
    for (const segment of segments) {
        if (segment.length <= 500) {
            refined.push(segment);
            continue;
        }
        const sentences = segment.split(/(?<=[。！？.!?])\s*/);
        let buffer = '';
        for (const sentence of sentences) {
            if ((buffer + sentence).length > 400 && buffer.length > 0) {
                refined.push(buffer.trim());
                buffer = sentence;
            }
            else {
                buffer += sentence;
            }
        }
        if (buffer.trim().length > 0)
            refined.push(buffer.trim());
    }
    return refined;
}
/** 首尾滑窗压缩：保留开头 keepRatio 比例 + 结尾 1/4。 */
function windowCompress(text) {
    if (text.length <= 200)
        return text;
    const headLen = Math.max(80, Math.floor(text.length * 0.45));
    const tailLen = Math.max(40, Math.floor(text.length * 0.2));
    return `${text.slice(0, headLen)}\n……（中段已压缩）……\n${text.slice(-tailLen)}`;
}
/** 示例截半：保留首个完整示例，丢弃其余。 */
function halveExample(text) {
    const blocks = text.split(/\n(?=示例|样例|例子|例如|example|如：|比如)/i);
    if (blocks.length <= 1) {
        // 无显式分隔：按行截取前一半。
        const lines = text.split('\n');
        return lines.slice(0, Math.max(1, Math.ceil(lines.length / 2))).join('\n');
    }
    return blocks[0].trim();
}
/**
 * 编译：在 token 预算内对 Prompt 做保真度最大化的组件级裁剪。
 * @param prompt 原始 Prompt。
 * @param budgetTokens token 预算（> 0）。
 */
export function compilePrompt(prompt, budgetTokens) {
    const tokensBefore = estimateTokens(prompt);
    const components = splitSegments(prompt).map((text) => ({
        kind: classifySegment(text),
        text,
        tokens: estimateTokens(text),
    }));
    // 预算绰绰有余：原文直通（no-op 编译）。
    if (tokensBefore <= budgetTokens) {
        return {
            compiled: prompt,
            tokensBefore,
            tokensAfter: tokensBefore,
            fidelityLoss: 0,
            components: components.map((c) => ({
                kind: c.kind,
                kindLabel: COMPONENT_KIND_LABELS[c.kind],
                before: c.text.slice(0, 80),
                after: c.text.slice(0, 80),
                tokensBefore: c.tokens,
                tokensAfter: c.tokens,
                decision: 'kept',
            })),
            withinBudget: true,
            note: '原始 Prompt 已在预算内，无需裁剪（直通编译）。',
        };
    }
    // 工作副本：kind → 编译后文本。
    const work = new Map();
    components.forEach((c, i) => work.set(i, { text: c.text, tokens: c.tokens, decision: 'kept' }));
    let total = tokensBefore;
    const report = [];
    const record = (i) => {
        const c = components[i];
        const w = work.get(i);
        report.push({
            kind: c.kind,
            kindLabel: COMPONENT_KIND_LABELS[c.kind],
            before: c.text.slice(0, 80),
            after: w.decision === 'dropped' ? '' : w.text.slice(0, 80),
            tokensBefore: c.tokens,
            tokensAfter: w.decision === 'dropped' ? 0 : w.tokens,
            decision: w.decision,
        });
    };
    // Pass 1（软裁剪）：example 截半 → context 滑窗压缩。
    for (let i = 0; i < components.length && total > budgetTokens; i += 1) {
        const c = components[i];
        const w = work.get(i);
        if (c.kind === 'example' && w.decision === 'kept') {
            const halved = halveExample(c.text);
            total += estimateTokens(halved) - w.tokens;
            work.set(i, { text: halved, tokens: estimateTokens(halved), decision: 'halved' });
        }
        else if (c.kind === 'context' && w.decision === 'kept') {
            const compressed = windowCompress(c.text);
            total += estimateTokens(compressed) - w.tokens;
            work.set(i, { text: compressed, tokens: estimateTokens(compressed), decision: 'compressed' });
        }
    }
    // Pass 2（硬裁剪）：按保真度从低到高整组件删除。
    for (const kind of DROP_ORDER) {
        for (let i = components.length - 1; i >= 0 && total > budgetTokens; i -= 1) {
            const c = components[i];
            const w = work.get(i);
            if (c.kind !== kind || w.decision === 'dropped')
                continue;
            total -= w.tokens;
            work.set(i, { text: '', tokens: 0, decision: 'dropped' });
        }
    }
    // 组装编译产物（保持原组件顺序）。
    const kept = [];
    components.forEach((_c, i) => {
        const w = work.get(i);
        if (w.decision !== 'dropped' && w.text.length > 0)
            kept.push(w.text);
        record(i);
    });
    const compiled = kept.join('\n\n');
    const tokensAfter = estimateTokens(compiled);
    // 保真度损耗：被裁 token 的加权限值占比。
    let lossWeight = 0;
    components.forEach((c, i) => {
        const w = work.get(i);
        const lostRatio = c.tokens > 0 ? (c.tokens - w.tokens) / c.tokens : 0;
        lossWeight += KIND_WEIGHT[c.kind] * lostRatio * c.tokens;
    });
    const fidelityLoss = tokensBefore > 0 ? Math.round((lossWeight / tokensBefore) * 100) / 100 : 0;
    const droppedKinds = [...new Set(report.filter((r) => r.decision === 'dropped').map((r) => r.kindLabel))];
    return {
        compiled,
        tokensBefore,
        tokensAfter,
        fidelityLoss,
        components: report,
        withinBudget: tokensAfter <= budgetTokens,
        note: tokensAfter <= budgetTokens
            ? droppedKinds.length > 0
                ? `已在预算内完成编译：删除了 ${droppedKinds.join('、')} 等组件，保真度损耗约 ${(fidelityLoss * 100).toFixed(0)}%。`
                : `已通过软裁剪（截半/压缩）满足预算，未删除任何完整组件。`
            : '预算过小：即使删除全部可裁组件仍超预算，建议提高预算或精简任务。',
    };
}
