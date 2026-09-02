/**
 * 模块 F 创新扩展：Prompt 静态分析器（Prompt Lint：矛盾指令检测 + 复杂度度量）。
 *
 * Prompt 是新代码：它有版本、有变更、有生产事故——但一直没有 ESLint。
 * 变异测试与 A/B 寻优（bandit.ts）都在「改了之后」测量效果；静态分析
 * 管的是「改之前」：一次提交里就肉眼可见的缺陷。四类检查：
 *
 * 1. 矛盾指令检测（LLM 生产事故的真实来源）：
 *    - 语言冲突：「必须用中文回复」+「answer in English」；
 *    - 篇幅冲突：「保持简洁」+「尽可能详细地展开」；
 *    - 行动冲突：同一动作对象上「必须执行 X」与「禁止执行 X」——
 *      通过指令极性（肯定/否定）分组后，对指令宾语做最长公共子串
 *      匹配（≥5 字符重合即判定同一对象），捕捉「同一件事的正反指令」；
 * 2. 占位符完整性：{var}/{{var}}/<var>/$VAR 引用与声明的变量表
 *    对账——未定义引用（渲染时留洞）与已声明未使用（腐化模板）；
 * 3. 模糊量词检测：一些/适当/尽量/大概——不可执行指令的信号，
 *    密度过高说明约束没有收敛；
 * 4. 复杂度度量（Halstead 1977 的思路：从文本统计量推维护性）：
 *    指令密度、硬约束数、句长分布、嵌套深度、token 预算与截断风险。
 *
 * 输出：findings（error/warning/info 三级，含规则名与摘录）+
 * metrics + 健康分（100 − 15×error − 5×warning − 1×info）。
 * 纯函数模块，无副作用。
 */
// ---------------------------------------------------------------------------
// 词表与模式
// ---------------------------------------------------------------------------
/** 肯定极性指令标记（要求做）。 */
const POSITIVE_MARKERS = ['必须', '一定要', '务必', '应当', '应该', '需要', '请', '须', '要执行', 'must', 'should', 'always', 'do '];
/** 否定极性指令标记（禁止做）。 */
const NEGATIVE_MARKERS = ['禁止', '不得', '不要', '切勿', '绝不', '不能', '不可以', '避免', 'never', 'do not', "don't", 'must not', 'forbidden'];
/** 语言指令：中文系。 */
const LANG_ZH = /(用|使用|回复|回答|输出|采用)(中文|汉语|普通话)|in Chinese|中文回答/;
/** 语言指令：英文系。 */
const LANG_EN = /(用|使用|回复|回答|输出|采用)(英文|英语)|in English|英文回答/;
/** 篇幅指令：收缩系。 */
const LENGTH_SHORT = /简洁|简短|一句话|尽量少|言简意赅|不超过\s*\d+\s*(字|句|行)|brief|concise|short/;
/** 篇幅指令：展开系。 */
const LENGTH_LONG = /详细|充分|展开|举例|深入| exhaustive|detailed|elaborate|thorough/;
/** 模糊量词。 */
const VAGUE_TERMS = ['一些', '若干', '适当', '酌情', '尽量', '大概', '可能的话', '相关', '之类', '等等', '之类的', '某种程度上', 'appropriate', 'some ', 'as needed'];
/** 占位符形态：{var} / {{var}} / <var> / $VAR / {var:default}。 */
const PLACEHOLDER_PATTERNS = [
    /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g,
    /\{\s*([A-Za-z_][\w.-]*)\s*(?::[^}]*)?\}/g,
    /<([A-Za-z_][\w.-]*)>/g,
    /\$([A-Z][A-Z0-9_]*)/g,
];
/** 指令句切分（句末标点、换行、分号）。 */
const SENTENCE_SPLIT = /[。！？!?\n；;]+/;
/** 中文停用片段（公共子串匹配时忽略）。 */
const STOP_CHUNKS = new Set(['的时候', '情况下', '请注意', '的时候请', '请务必', '一定要注意']);
/** 摘录截断。 */
function excerptOf(text) {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}
/** 文本归一化（去空白与标点，小写）。 */
function normalize(text) {
    return text
        .toLowerCase()
        .replace(/[\s，。、；：？！,.;:?!"'`（）()\[\]【】<>《》\-—_~·…]/g, '');
}
/** 最长公共子串长度（动态规划；短文本专用）。 */
function longestCommonSubstring(a, b) {
    if (a.length === 0 || b.length === 0)
        return 0;
    let best = 0;
    let prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i += 1) {
        const current = new Array(b.length + 1).fill(0);
        for (let j = 1; j <= b.length; j += 1) {
            if (a[i - 1] === b[j - 1]) {
                current[j] = prev[j - 1] + 1;
                if (current[j] > best)
                    best = current[j];
            }
        }
        prev = current;
    }
    return best;
}
/** 指令标记提取：返回句子首个命中的标记与极性。 */
function directiveOf(sentence) {
    for (const marker of NEGATIVE_MARKERS) {
        const index = sentence.indexOf(marker);
        if (index >= 0)
            return { polarity: 'negative', marker, tail: sentence.slice(index + marker.length) };
    }
    for (const marker of POSITIVE_MARKERS) {
        const index = sentence.toLowerCase().indexOf(marker.toLowerCase());
        if (index >= 0)
            return { polarity: 'positive', marker, tail: sentence.slice(index + marker.length) };
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
/**
 * Prompt 静态分析（纯函数）。
 * @param text Prompt 全文。
 * @param options 变量表与 token 预算。
 */
export function lintPrompt(text, options = {}) {
    const findings = [];
    const sentences = text
        .split(SENTENCE_SPLIT)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    // ------------------------------------------------------------------
    // 1. 矛盾指令检测
    // ------------------------------------------------------------------
    if (LANG_ZH.test(text) && LANG_EN.test(text)) {
        findings.push({
            severity: 'error',
            rule: 'contradiction/language',
            message: '语言指令冲突：同时要求用中文与用英文回复——模型只能猜，输出语言将不可预期。',
            excerpt: excerptOf(text),
        });
    }
    if (LENGTH_SHORT.test(text) && LENGTH_LONG.test(text)) {
        findings.push({
            severity: 'error',
            rule: 'contradiction/length',
            message: '篇幅指令冲突：同时要求简洁与详细——建议改为可执行的边界（如「≤3 条要点，每条 ≤40 字」）。',
            excerpt: excerptOf(text),
        });
    }
    // 指令句收集 + 极性分组。
    const directives = [];
    for (const sentence of sentences) {
        const directive = directiveOf(sentence);
        if (directive) {
            directives.push({ sentence, polarity: directive.polarity, tail: directive.tail });
        }
    }
    // 行动冲突：正负指令的宾语（标记之后的文本）公共子串 ≥5。
    const positives = directives.filter((d) => d.polarity === 'positive');
    const negatives = directives.filter((d) => d.polarity === 'negative');
    const conflictSeen = new Set();
    for (const positive of positives) {
        for (const negative of negatives) {
            if (positive.sentence === negative.sentence)
                continue;
            const tailA = normalize(positive.tail);
            const tailB = normalize(negative.tail);
            if (tailA.length < 2 || tailB.length < 2)
                continue;
            if (STOP_CHUNKS.has(positive.tail.trim()) || STOP_CHUNKS.has(negative.tail.trim()))
                continue;
            const overlap = longestCommonSubstring(tailA, tailB);
            if (overlap >= 5) {
                const key = [positive.sentence, negative.sentence].sort().join('‖');
                if (conflictSeen.has(key))
                    continue;
                conflictSeen.add(key);
                findings.push({
                    severity: 'error',
                    rule: 'contradiction/action',
                    message: `疑似对同一对象下正反指令（宾语重合 ${overlap} 字符）：「${excerptOf(positive.sentence)}」 vs 「${excerptOf(negative.sentence)}」——请显式消解。`,
                    excerpt: excerptOf(`${positive.sentence} ⟷ ${negative.sentence}`),
                });
            }
        }
    }
    // ------------------------------------------------------------------
    // 2. 占位符完整性
    // ------------------------------------------------------------------
    const referenced = new Set();
    for (const pattern of PLACEHOLDER_PATTERNS) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let match;
        while ((match = regex.exec(text)) !== null) {
            if (match[1])
                referenced.add(match[1]);
        }
    }
    if (options.variables !== undefined) {
        const declared = new Set(options.variables);
        for (const name of referenced) {
            if (!declared.has(name)) {
                findings.push({
                    severity: 'error',
                    rule: 'placeholder/undefined',
                    message: `占位符 {${name}} 未在变量表中声明——运行时渲染将留下未替换的洞。`,
                    excerpt: excerptOf(text),
                });
            }
        }
        for (const name of declared) {
            if (!referenced.has(name)) {
                findings.push({
                    severity: 'info',
                    rule: 'placeholder/unused',
                    message: `已声明变量 ${name} 未在模板中引用——腐化变量表。`,
                    excerpt: excerptOf(text),
                });
            }
        }
    }
    else if (referenced.size > 0) {
        findings.push({
            severity: 'info',
            rule: 'placeholder/unverified',
            message: `发现 ${referenced.size} 个占位符（${[...referenced].slice(0, 5).join('、')}${referenced.size > 5 ? '…' : ''}）但未提供变量表，未做对账。`,
            excerpt: excerptOf(text),
        });
    }
    // ------------------------------------------------------------------
    // 3. 模糊量词
    // ------------------------------------------------------------------
    const lower = text.toLowerCase();
    let vagueCount = 0;
    for (const term of VAGUE_TERMS) {
        let index = lower.indexOf(term);
        while (index >= 0) {
            vagueCount += 1;
            index = lower.indexOf(term, index + term.length);
        }
    }
    const vagueDensity = sentences.length > 0 ? vagueCount / sentences.length : 0;
    if (vagueCount >= 3 || vagueDensity > 0.25) {
        findings.push({
            severity: 'warning',
            rule: 'vagueness/quantifier',
            message: `模糊量词出现 ${vagueCount} 次（指令句占比 ${(vagueDensity * 100).toFixed(0)}%）——「一些/适当/尽量」不可执行，请换成可验收的边界。`,
            excerpt: excerptOf(text),
        });
    }
    // ------------------------------------------------------------------
    // 4. 复杂度度量与预算
    // ------------------------------------------------------------------
    const chars = text.length;
    const estimatedTokens = Math.ceil(chars / 3.5);
    const maxSentenceChars = sentences.reduce((max, s) => Math.max(max, s.length), 0);
    const nestingDepth = text
        .split('\n')
        .reduce((max, line) => Math.max(max, Math.floor((line.match(/^\s*/)?.[0].length ?? 0) / 2)), 0);
    let hardConstraints = 0;
    for (const marker of [...POSITIVE_MARKERS.slice(0, 5), ...NEGATIVE_MARKERS]) {
        let index = text.indexOf(marker);
        while (index >= 0) {
            hardConstraints += 1;
            index = text.indexOf(marker, index + marker.length);
        }
    }
    if (maxSentenceChars > 120) {
        findings.push({
            severity: 'warning',
            rule: 'style/sentence-length',
            message: `最长句 ${maxSentenceChars} 字符——超长指令句容易被模型丢细节，建议拆分。`,
            excerpt: excerptOf(sentences.find((s) => s.length === maxSentenceChars) ?? text),
        });
    }
    if (options.budgetTokens !== undefined && estimatedTokens > options.budgetTokens) {
        findings.push({
            severity: 'warning',
            rule: 'budget/tokens',
            message: `估算 ${estimatedTokens} tokens 超出预算 ${options.budgetTokens}——注入路径上存在物理截断风险。`,
            excerpt: excerptOf(text),
        });
    }
    // ------------------------------------------------------------------
    // 汇总
    // ------------------------------------------------------------------
    const errors = findings.filter((f) => f.severity === 'error').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const infos = findings.filter((f) => f.severity === 'info').length;
    const score = Math.max(0, Math.min(100, 100 - 15 * errors - 5 * warnings - infos));
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';
    const metrics = {
        chars,
        estimatedTokens,
        sentences: sentences.length,
        directives: directives.length,
        directiveDensity: sentences.length > 0 ? Math.round((directives.length / sentences.length) * 100) / 100 : 0,
        hardConstraints,
        maxSentenceChars,
        nestingDepth,
        vagueTerms: vagueCount,
    };
    return {
        score,
        grade,
        findings,
        metrics,
        summary: `健康分 ${score}（${grade}）：${errors} 个错误、${warnings} 个警告、${infos} 个提示；` +
            `${sentences.length} 句 / ${directives.length} 条指令（密度 ${(metrics.directiveDensity * 100).toFixed(0)}%），` +
            `硬约束 ${hardConstraints} 处、模糊量词 ${vagueCount} 处、估算 ${estimatedTokens} tokens。`,
    };
}
