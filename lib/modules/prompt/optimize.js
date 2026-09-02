import { extractJsonFromOutput } from './schema.js';
/** 优化用例数上限。 */
export const MAX_OPTIMIZE_CASES = 10;
/** 候选变体数上限。 */
export const MAX_CANDIDATES = 3;
/** 显著性阈值（双侧 p 值；小样本下放宽到 0.1）。 */
const P_THRESHOLD = 0.1;
/**
 * 运行一次「Prompt + 用例输入」并判定通过与否。
 * @returns 通过布尔；调用异常按不通过计（含失败原因见 caller 汇总）。
 */
async function runAndJudge(ctx, prompt, testCase, model) {
    const userContent = testCase.input ? `${prompt}\n\n${testCase.input}` : prompt;
    let output;
    try {
        const result = await ctx.companion.callDeepSeek({
            messages: [{ role: 'user', content: userContent }],
            model,
            source: 'prompt-optimize',
        });
        output = result.content;
    }
    catch {
        return false;
    }
    if (testCase.expected !== undefined && testCase.expected.length > 0) {
        return output.toLowerCase().includes(testCase.expected.toLowerCase());
    }
    return judgeWithModel(ctx, prompt, testCase, output, model);
}
/** 模型评审员裁决（jsonMode 严格 JSON：{"pass": boolean, "reason": string}）。 */
async function judgeWithModel(ctx, prompt, testCase, output, model) {
    const judgePrompt = [
        '你是严格的评审员。判断以下 AI 输出是否合格完成了任务，只依据输出本身评判。',
        '',
        '【任务指令】',
        prompt,
        '',
        '【用例输入】',
        testCase.input || '（无）',
        '',
        '【AI 输出】',
        output.slice(0, 4000),
        '',
        '请以 JSON 输出：{"pass": boolean, "reason": "一句话理由"}',
    ].join('\n');
    try {
        const result = await ctx.companion.callDeepSeek({
            messages: [{ role: 'user', content: judgePrompt }],
            model,
            jsonMode: true,
            maxTokens: 256,
            temperature: 0,
            source: 'prompt-optimize-judge',
        });
        const parsed = extractJsonFromOutput(result.content);
        if (typeof parsed === 'object' && parsed !== null && 'pass' in parsed) {
            return parsed.pass === true;
        }
        return false;
    }
    catch {
        return false;
    }
}
/**
 * 元提示变异：让模型基于原始 Prompt 与失败用例生成 K 个改进候选。
 * 返回去重后的候选列表（可能少于 K）。
 */
async function generateCandidates(ctx, params, failures) {
    const failureLines = failures
        .slice(0, 5)
        .map((index) => `- 用例「${params.cases[index].input.slice(0, 80)}」未通过`)
        .join('\n');
    const metaPrompt = [
        '你是世界级的 Prompt 工程师。请改进下面的 Prompt，生成恰好 ' +
            params.candidates +
            ' 个互不相同的改进版本。',
        '',
        '【原始 Prompt】',
        params.prompt,
        '',
        failureLines ? `【当前失败的用例（重点改进方向）】\n${failureLines}` : '',
        '',
        '改进方向参考：指令清晰度、结构化分步、明确的输出格式约束、few-shot 示例、',
        '边界条件处理、角色设定强化。保持原意不变，只提升可靠性与准确性。',
        '',
        '以 JSON 输出：{"candidates": ["改进版本1", "改进版本2", ...]}',
    ]
        .filter((line) => line !== '')
        .join('\n');
    try {
        const result = await ctx.companion.callDeepSeek({
            messages: [{ role: 'user', content: metaPrompt }],
            model: params.model,
            jsonMode: true,
            temperature: 0.7,
            source: 'prompt-optimize-meta',
        });
        const parsed = extractJsonFromOutput(result.content);
        if (typeof parsed === 'object' && parsed !== null && 'candidates' in parsed) {
            const list = parsed.candidates;
            if (!Array.isArray(list))
                return [];
            const seen = new Set([params.prompt]);
            const candidates = [];
            for (const item of list) {
                if (typeof item !== 'string')
                    continue;
                const trimmed = item.trim();
                if (trimmed.length === 0 || seen.has(trimmed))
                    continue;
                seen.add(trimmed);
                candidates.push(trimmed);
                if (candidates.length >= params.candidates)
                    break;
            }
            return candidates;
        }
        return [];
    }
    catch {
        return [];
    }
}
/**
 * 配对符号检验（McNemar 精确法）：
 * b = 基线败 & 候选胜，c = 基线胜 & 候选败，n = b + c（一致对不提供信息）。
 * 双侧精确二项 p 值 = 2·P(X ≤ min(b,c))，X ~ Binomial(n, 0.5)，封顶 1。
 */
export function pairedSignTest(b, c) {
    const n = b + c;
    if (n === 0)
        return { pValue: 1 };
    const tail = Math.min(b, c);
    let cumulative = 0;
    for (let k = 0; k <= tail; k += 1) {
        cumulative += binomialCoefficient(n, k);
    }
    const pValue = Math.min(1, (2 * cumulative) / 2 ** n);
    return { pValue };
}
/** 二项系数（对数安全：小样本 n ≤ 20 直接乘法累积）。 */
function binomialCoefficient(n, k) {
    if (k < 0 || k > n)
        return 0;
    const kk = Math.min(k, n - k);
    let result = 1;
    for (let i = 0; i < kk; i += 1) {
        result = (result * (n - i)) / (i + 1);
    }
    return result;
}
/**
 * 执行完整优化循环（元提示生成 → 全候选评测 → 显著性检验 → 晋升保存）。
 * 任何模型调用失败都收敛为「该用例不通过」，不中断整个循环。
 */
export async function optimizePrompt(ctx, versions, params) {
    // 1. 基线评测。
    const baselinePasses = [];
    for (const testCase of params.cases) {
        baselinePasses.push(await runAndJudge(ctx, params.prompt, testCase, params.model));
    }
    const baselineOk = baselinePasses.filter(Boolean).length;
    const failures = baselinePasses
        .map((pass, index) => (pass ? -1 : index))
        .filter((index) => index >= 0);
    // 2. 元提示生成候选（全部用例通过时不生成：无需改进）。
    const candidateContents = baselineOk === params.cases.length ? [] : await generateCandidates(ctx, params, failures);
    // 3. 全候选评测（逐用例配对）。
    const candidates = [];
    for (const content of candidateContents) {
        const passes = [];
        let wins = 0;
        let losses = 0;
        for (let index = 0; index < params.cases.length; index += 1) {
            const pass = await runAndJudge(ctx, content, params.cases[index], params.model);
            passes.push(pass);
            if (pass && !baselinePasses[index])
                wins += 1;
            if (!pass && baselinePasses[index])
                losses += 1;
        }
        candidates.push({
            content,
            passes,
            passRate: passes.filter(Boolean).length / params.cases.length,
            wins,
            losses,
        });
    }
    // 4. 显著性检验：净胜（wins > losses）的候选中取 p 值最小者。
    let winnerIndex;
    let bestP = Number.POSITIVE_INFINITY;
    let significance;
    for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (candidate.wins <= candidate.losses)
            continue;
        const { pValue } = pairedSignTest(candidate.wins, candidate.losses);
        if (pValue < bestP) {
            bestP = pValue;
            winnerIndex = index;
            significance = {
                b: candidate.wins,
                c: candidate.losses,
                pValue: Math.round(pValue * 10000) / 10000,
                significant: pValue <= P_THRESHOLD,
            };
        }
    }
    // 5. 晋升保存：仅统计显著的净胜者才写入版本历史。
    let savedVersion;
    if (winnerIndex !== undefined && significance?.significant && params.save) {
        const winner = candidates[winnerIndex];
        savedVersion = await versions.save(winner.content, `自动优化：基线 ${Math.round((baselineOk / params.cases.length) * 100)}% → ` +
            `${Math.round(winner.passRate * 100)}%（p=${significance.pValue}，配对胜 ${winner.wins} 负 ${winner.losses}）`, ['自动优化']);
    }
    return {
        model: params.model,
        baseline: {
            passRate: params.cases.length > 0 ? baselineOk / params.cases.length : 0,
            passes: baselinePasses,
            failures,
        },
        candidates,
        winnerIndex,
        significance,
        savedVersion,
    };
}
