import { extractJsonFromOutput } from './schema.js';
// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
/** 变体（臂）数上限。 */
export const MAX_BANDIT_ARMS = 8;
/** 用例数上限。 */
export const MAX_BANDIT_CASES = 10;
/** 单次 pull 请求最多轮数。 */
export const MAX_PULL_ROUNDS = 20;
/** 后验联合抽样的蒙特卡洛次数（P(best)/期望损失估计用）。 */
const POSTERIOR_MC_DRAWS = 4_000;
/** 停止判据：期望损失阈值（每例通过率损失低于 1% 即可定版）。 */
export const EXPECTED_LOSS_EPSILON = 0.01;
/** 停止判据：P(best) 阈值（90% 概率是最优臂即可定版）。 */
export const P_BEST_THRESHOLD = 0.9;
/** 定版前的最少探索轮数（每臂至少抽过这么多才允许裁决）。 */
const MIN_PULLS_PER_ARM = 5;
// ---------------------------------------------------------------------------
// 随机数与分布原语（纯函数，可注入 rng 便于测试）
// ---------------------------------------------------------------------------
/**
 * Gamma(shape, 1) 抽样（Marsaglia-Tsang 压缩法，shape ≥ 1）。
 * shape < 1 时用 boost 技巧：Gamma(shape) = Gamma(shape+1) · U^(1/shape)。
 */
export function sampleGamma(shape, rng = Math.random) {
    if (shape <= 0)
        return 0;
    const boosted = shape < 1;
    const a = boosted ? shape + 1 : shape;
    const d = a - 1 / 3;
    const c = 1 / Math.sqrt(9 * a);
    for (let guard = 0; guard < 256; guard += 1) {
        let x;
        let v;
        do {
            const u = rng();
            // Box-Muller 一半正态。
            x = Math.sqrt(-2 * Math.log(Math.max(u, Number.MIN_VALUE))) * Math.cos(2 * Math.PI * rng());
            v = 1 + c * x;
        } while (v <= 0);
        v = v * v * v;
        const u = rng();
        if (u < 1 - 0.0331 * x * x * x * x)
            return boosted ? (d * v) * Math.pow(rng(), 1 / shape) : d * v;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
            return boosted ? (d * v) * Math.pow(rng(), 1 / shape) : d * v;
        }
    }
    return a; // 兜底：极端 rng 拒绝采样失败时返回均值（概率 ~0）。
}
/** Beta(α, β) 抽样：两个独立 Gamma 的归一化（Cheng-Stirastōnă 简化式）。 */
export function sampleBeta(alpha, beta, rng = Math.random) {
    if (alpha <= 0 || beta <= 0)
        return 0;
    const x = sampleGamma(alpha, rng);
    const y = sampleGamma(beta, rng);
    const sum = x + y;
    return sum > 0 ? x / sum : alpha / (alpha + beta);
}
/**
 * Beta 分位数（网格数值 CDF 反演，步长 1/2000）。
 * 精度对 CI 展示绰绰有余，且完全避开不完全 Beta 函数的解析实现。
 */
export function betaQuantile(alpha, beta, p) {
    if (p <= 0)
        return 0;
    if (p >= 1)
        return 1;
    const grid = 2_000;
    // 非归一化 pdf 权重 + 前缀和。
    const weights = new Array(grid + 1);
    const logNorm = logBetaFn(alpha, beta);
    for (let i = 0; i <= grid; i += 1) {
        const x = i / grid;
        weights[i] = Math.exp((alpha - 1) * Math.log(Math.max(x, 1e-12)) + (beta - 1) * Math.log(Math.max(1 - x, 1e-12)) - logNorm);
    }
    let cumulative = 0;
    for (let i = 0; i <= grid; i += 1)
        cumulative += weights[i];
    const target = cumulative * p;
    let acc = 0;
    for (let i = 0; i <= grid; i += 1) {
        acc += weights[i];
        if (acc >= target)
            return i / grid;
    }
    return 1;
}
/** log Beta 函数（Lanczos 近似 log-Γ 之差）。 */
function logBetaFn(alpha, beta) {
    return logGamma(alpha) + logGamma(beta) - logGamma(alpha + beta);
}
/** log-Γ（Lanczos 近似，g=7，系数标准）。 */
function logGamma(z) {
    const g = [
        0.99999999999980993, 676.5203681218851, -1259.1392167224028,
        771.32342877765313, -176.61502916214059, 12.507343278686905,
        -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (z < 0.5) {
        return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    }
    const x = z - 1;
    let a = g[0];
    const t = x + 7.5;
    for (let i = 1; i < g.length; i += 1)
        a += g[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
// ---------------------------------------------------------------------------
// 核心算法：Thompson 采样与后验分析（纯函数）
// ---------------------------------------------------------------------------
/**
 * Thompson 采样选臂：对每臂后验各抽一个 Beta 样本，取最大者。
 * 返回臂下标（空臂表返回 -1）。
 */
export function thompsonPick(arms, rng = Math.random) {
    let bestIndex = -1;
    let bestSample = -Infinity;
    for (let i = 0; i < arms.length; i += 1) {
        const arm = arms[i];
        const sample = sampleBeta(arm.alpha, arm.beta, rng);
        if (sample > bestSample) {
            bestSample = sample;
            bestIndex = i;
        }
    }
    return bestIndex;
}
/** 后验均值。 */
function posteriorMean(arm) {
    return arm.alpha / (arm.alpha + arm.beta);
}
/**
 * 后验分析：每臂的经验率/后验均值/95% CI + 联合蒙特卡洛估计
 * P(best) 与期望损失，并给出停止裁决。
 */
export function posteriorAnalysis(arms, rng = Math.random) {
    if (arms.length === 0) {
        return {
            arms: [],
            bestIndex: null,
            readyToStop: false,
            verdict: '实验没有可比较的变体',
            winnerIndex: null,
        };
    }
    // 联合后验抽样：一次循环同时累计 P(best) 与期望损失。
    const pBestCount = new Array(arms.length).fill(0);
    const lossAcc = new Array(arms.length).fill(0);
    for (let draw = 0; draw < POSTERIOR_MC_DRAWS; draw += 1) {
        const samples = arms.map((arm) => sampleBeta(arm.alpha, arm.beta, rng));
        let maxIndex = 0;
        let maxValue = samples[0];
        for (let i = 1; i < samples.length; i += 1) {
            if (samples[i] > maxValue) {
                maxValue = samples[i];
                maxIndex = i;
            }
        }
        pBestCount[maxIndex] += 1;
        for (let i = 0; i < samples.length; i += 1) {
            lossAcc[i] += maxValue - samples[i];
        }
    }
    const armReports = arms.map((arm, index) => ({
        index,
        excerpt: arm.content.slice(0, 80),
        pulls: arm.pulls,
        successes: arm.successes,
        empiricalRate: arm.pulls > 0 ? arm.successes / arm.pulls : 0,
        posteriorMean: round4(posteriorMean(arm)),
        ci95: [round4(betaQuantile(arm.alpha, arm.beta, 0.025)), round4(betaQuantile(arm.alpha, arm.beta, 0.975))],
        pBest: round4(pBestCount[index] / POSTERIOR_MC_DRAWS),
        expectedLoss: round4(lossAcc[index] / POSTERIOR_MC_DRAWS),
        regret: round4(arm.regret),
    }));
    // 最优臂：P(best) 最大（并列取期望损失小者）。
    let bestIndex = 0;
    for (let i = 1; i < armReports.length; i += 1) {
        const a = armReports[i];
        const b = armReports[bestIndex];
        if (a.pBest > b.pBest || (a.pBest === b.pBest && a.expectedLoss < b.expectedLoss))
            bestIndex = i;
    }
    // 停止判据：最优臂 P(best) ≥ 0.9 或期望损失 < ε，且每臂至少 MIN_PULLS_PER_ARM 次。
    const explored = arms.every((arm) => arm.pulls >= MIN_PULLS_PER_ARM);
    const champion = armReports[bestIndex];
    const readyToStop = explored && (champion.pBest >= P_BEST_THRESHOLD || champion.expectedLoss < EXPECTED_LOSS_EPSILON);
    const verdict = !explored
        ? `仍在探索期（每臂至少 ${MIN_PULLS_PER_ARM} 次采样后才可裁决），继续 pull`
        : readyToStop
            ? `可以定版：变体 ${champion.index + 1} 有 ${Math.round(champion.pBest * 100)}% 的概率是最优` +
                `（期望损失 ${(champion.expectedLoss * 100).toFixed(2)}%/例，部署它平均不会后悔）`
            : `尚无足够把握：最优变体 ${champion.index + 1} 的 P(best)=${Math.round(champion.pBest * 100)}%、` +
                `期望损失 ${(champion.expectedLoss * 100).toFixed(2)}%/例（阈值为 ${EXPECTED_LOSS_EPSILON * 100}%），继续采样`;
    return {
        arms: armReports,
        bestIndex,
        readyToStop,
        verdict,
        winnerIndex: readyToStop ? bestIndex : null,
    };
}
/** 保留 4 位小数。 */
function round4(value) {
    return Math.round(value * 10_000) / 10_000;
}
// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------
/** Thompson Sampling 实验仓库。 */
export class BanditStore {
    table;
    constructor(domain) {
        this.table = domain.table('prompt-bandit');
    }
    /** 创建实验（2~MAX_BANDIT_ARMS 个变体）。 */
    async create(input) {
        const id = `bandit_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const now = Date.now();
        const experiment = {
            kind: 'experiment',
            id,
            name: input.name,
            model: input.model,
            cases: input.cases,
            arms: input.variants.map((content) => ({
                content,
                alpha: 1,
                beta: 1,
                pulls: 0,
                successes: 0,
                regret: 0,
                lastPullAt: 0,
            })),
            nextCaseIndex: 0,
            createdAt: now,
            updatedAt: now,
        };
        await this.table.put(id, experiment);
        return experiment;
    }
    get(id) {
        return this.table.get(id);
    }
    list() {
        return this.table
            .entries()
            .map(([, value]) => value)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }
    async save(experiment) {
        await this.table.put(experiment.id, experiment);
    }
    async delete(id) {
        await this.table.delete(id);
    }
}
/**
 * 执行 N 轮 Thompson 采样：每轮选臂（后验抽样）→ 轮转选例 →
 * 调用模型判定通过与否 → Beta 后验加法更新 → 累计遗憾。
 */
export async function runBanditPulls(ctx, store, experimentId, rounds) {
    const experiment = store.get(experimentId);
    if (!experiment)
        throw new Error(`实验不存在：${experimentId}`);
    if (experiment.cases.length === 0)
        throw new Error('实验没有用例，无法采样');
    const arms = experiment.arms.map((arm) => ({ ...arm }));
    const logs = [];
    let nextCaseIndex = experiment.nextCaseIndex;
    for (let round = 1; round <= rounds; round += 1) {
        // 1. Thompson 选臂。
        const armIndex = thompsonPick(arms);
        if (armIndex < 0)
            break;
        const arm = arms[armIndex];
        const caseIndex = nextCaseIndex % experiment.cases.length;
        nextCaseIndex = (nextCaseIndex + 1) % experiment.cases.length;
        const testCase = experiment.cases[caseIndex];
        // 遗憾记账：本轮最优后验均值 − 执行臂后验均值。
        const bestMean = Math.max(...arms.map(posteriorMean));
        const regretDelta = Math.max(0, bestMean - posteriorMean(arm));
        const startedAt = Date.now();
        let passed = false;
        let error;
        try {
            passed = await runAndJudge(ctx, arm.content, testCase, experiment.model);
        }
        catch (err) {
            error = err instanceof Error ? err.message : String(err);
        }
        // 2. Beta 共轭更新：一次观测一个加法。
        arm.pulls += 1;
        if (passed) {
            arm.alpha += 1;
            arm.successes += 1;
        }
        else {
            arm.beta += 1;
        }
        arm.regret += regretDelta;
        arm.lastPullAt = Date.now();
        logs.push({
            round,
            armIndex,
            caseIndex,
            passed,
            armPosteriorMean: round4(posteriorMean(arm)),
            latencyMs: Date.now() - startedAt,
            ...(error !== undefined ? { error } : {}),
        });
    }
    const updated = {
        ...experiment,
        arms,
        nextCaseIndex,
        updatedAt: Date.now(),
    };
    await store.save(updated);
    return { experiment: updated, rounds: logs, analysis: posteriorAnalysis(arms) };
}
/** 运行「变体 + 用例」并判定通过（与 F5 同约定：expected 包含匹配 / 模型评审员）。 */
async function runAndJudge(ctx, prompt, testCase, model) {
    const userContent = testCase.input ? `${prompt}\n\n${testCase.input}` : prompt;
    const result = await ctx.companion.callDeepSeek({
        messages: [{ role: 'user', content: userContent }],
        model,
        source: 'prompt-bandit',
    });
    const output = result.content;
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
            source: 'prompt-bandit-judge',
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
