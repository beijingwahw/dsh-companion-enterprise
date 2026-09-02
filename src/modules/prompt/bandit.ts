/**
 * 模块 F 创新扩展：Thompson Sampling 变体自动寻优（Prompt Bandit）。
 *
 * F2 的 A/B 测试与 F5 的自动优化都是「固定样本量」设计：基线和候选
 * 各跑同样的次数，哪怕候选连输五轮也要跑满——被浪费的每一次调用
 * 都是真金白银。多臂老虎机六十年前就回答了这个问题：探索与利用
 * 的贝叶斯最优解是概率匹配（probability matching），而 Thompson
 * Sampling 是其最优雅的实现——2020 年以来 Google/Netflix/DoorDash
 * 的线上实验系统几乎清一色采用。
 *
 * 方法论：
 * 1. Beta-Bernoulli 后验：每个变体（臂）的通过率 θ ~ Beta(α, β)，
 *    α=成功数+1、β=失败数+1（均匀先验）。Beta 是 Bernoulli 似然的
 *    共轭先验——一次观测，一个加法，后验即更新，零解析成本；
 * 2. Thompson 采样：每轮对每臂的后验各抽一个样本，选样本值最大的
 *    臂执行。好臂后验集中在高通过率区，被抽中的概率自然高（利用）；
 *    差臂后验宽，偶尔也抽到高值（探索）——不确定性本身就是探索
 *    预算，无需任何手工调参；
 * 3. 停止判据不用 p 值，用贝叶斯决策量（VWO SmartStats 同款）：
 *    - P(best)：各臂联合后验抽样中该臂为最优的频率；
 *    - expected loss：若现在部署该臂，相对「事后最优选择」的
 *      期望通过率损失 E[max θ_j − θ_i]——它是钱的语言：
 *      「部署 A 平均每例损失 0.3% 通过率」；
 *    expected loss < ε 即可停：不是「谁赢了多少」，而是
 *    「继续试错的期望收益已经低于试错成本」；
 * 4. 累计遗憾（regret）跟踪：每轮记录「最优后验均值 − 实际执行臂
 *    的后验均值」，对照 O(log T) 理论界——把学术保证变成面板数字。
 *
 * 判定复用 F5 约定：用例带 expected → 输出包含参考答案即通过（零
 * 成本）；否则模型评审员（jsonMode 严格 JSON 裁决）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '../../core/storage-adapter.js'
import { extractJsonFromOutput } from './schema.js'

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/** 变体（臂）数上限。 */
export const MAX_BANDIT_ARMS = 8

/** 用例数上限。 */
export const MAX_BANDIT_CASES = 10

/** 单次 pull 请求最多轮数。 */
export const MAX_PULL_ROUNDS = 20

/** 后验联合抽样的蒙特卡洛次数（P(best)/期望损失估计用）。 */
const POSTERIOR_MC_DRAWS = 4_000

/** 停止判据：期望损失阈值（每例通过率损失低于 1% 即可定版）。 */
export const EXPECTED_LOSS_EPSILON = 0.01

/** 停止判据：P(best) 阈值（90% 概率是最优臂即可定版）。 */
export const P_BEST_THRESHOLD = 0.9

/** 定版前的最少探索轮数（每臂至少抽过这么多才允许裁决）。 */
const MIN_PULLS_PER_ARM = 5

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

/** 单条评测用例（与 F5 OptimizeCase 同构）。 */
export interface BanditCase {
  /** 用例输入（拼接到变体 Prompt 之后）。 */
  readonly input: string
  /** 参考答案：输出包含该串即通过；缺省走模型评审员。 */
  readonly expected?: string
}

/** 单个变体（臂）的完整状态。 */
export interface BanditArm {
  /** 变体 Prompt 全文。 */
  readonly content: string
  /** Beta 后验 α（成功数 + 1）。 */
  alpha: number
  /** Beta 后验 β（失败数 + 1）。 */
  beta: number
  /** 累计执行次数。 */
  pulls: number
  /** 累计通过次数。 */
  successes: number
  /** 累计遗憾（每轮：最优后验均值 − 本臂后验均值）。 */
  regret: number
  lastPullAt: number
}

/** 老虎机实验记录（'prompt-bandit' 表，键为实验 id）。 */
export interface BanditExperiment {
  readonly kind: 'experiment'
  readonly id: string
  readonly name: string
  readonly model: string
  readonly cases: readonly BanditCase[]
  readonly arms: readonly BanditArm[]
  /** 下一次轮转的用例下标（round-robin 均匀暴露用例难度）。 */
  nextCaseIndex: number
  readonly createdAt: number
  updatedAt: number
}

/** 单臂后验报告。 */
export interface ArmPosterior {
  readonly index: number
  /** 变体正文（截断 80 字符展示）。 */
  readonly excerpt: string
  readonly pulls: number
  readonly successes: number
  /** 经验通过率。 */
  readonly empiricalRate: number
  /** 后验均值 α/(α+β)。 */
  readonly posteriorMean: number
  /** 95% 置信区间（网格数值分位）。 */
  readonly ci95: readonly [number, number]
  /** P(best)：联合后验抽样中为最优臂的频率。 */
  readonly pBest: number
  /** 期望损失：现在部署本臂，相对事后最优的期望通过率损失。 */
  readonly expectedLoss: number
  /** 累计遗憾（后验均值差累计，展示用）。 */
  readonly regret: number
}

/** 后验分析报告。 */
export interface BanditAnalysis {
  readonly arms: readonly ArmPosterior[]
  /** 当前后验下最优臂下标。 */
  readonly bestIndex: number | null
  /** 是否可停止实验并定版。 */
  readonly readyToStop: boolean
  /** 裁决说明（中文，可展示）。 */
  readonly verdict: string
  /** 建议部署的臂（未定版为 null）。 */
  readonly winnerIndex: number | null
}

// ---------------------------------------------------------------------------
// 随机数与分布原语（纯函数，可注入 rng 便于测试）
// ---------------------------------------------------------------------------

/**
 * Gamma(shape, 1) 抽样（Marsaglia-Tsang 压缩法，shape ≥ 1）。
 * shape < 1 时用 boost 技巧：Gamma(shape) = Gamma(shape+1) · U^(1/shape)。
 */
export function sampleGamma(shape: number, rng: () => number = Math.random): number {
  if (shape <= 0) return 0
  const boosted = shape < 1
  const a = boosted ? shape + 1 : shape
  const d = a - 1 / 3
  const c = 1 / Math.sqrt(9 * a)
  for (let guard = 0; guard < 256; guard += 1) {
    let x: number
    let v: number
    do {
      const u = rng()
      // Box-Muller 一半正态。
      x = Math.sqrt(-2 * Math.log(Math.max(u, Number.MIN_VALUE))) * Math.cos(2 * Math.PI * rng())
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = rng()
    if (u < 1 - 0.0331 * x * x * x * x) return boosted ? (d * v) * Math.pow(rng(), 1 / shape) : d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return boosted ? (d * v) * Math.pow(rng(), 1 / shape) : d * v
    }
  }
  return a // 兜底：极端 rng 拒绝采样失败时返回均值（概率 ~0）。
}

/** Beta(α, β) 抽样：两个独立 Gamma 的归一化（Cheng-Stirastōnă 简化式）。 */
export function sampleBeta(alpha: number, beta: number, rng: () => number = Math.random): number {
  if (alpha <= 0 || beta <= 0) return 0
  const x = sampleGamma(alpha, rng)
  const y = sampleGamma(beta, rng)
  const sum = x + y
  return sum > 0 ? x / sum : alpha / (alpha + beta)
}

/**
 * Beta 分位数（网格数值 CDF 反演，步长 1/2000）。
 * 精度对 CI 展示绰绰有余，且完全避开不完全 Beta 函数的解析实现。
 */
export function betaQuantile(alpha: number, beta: number, p: number): number {
  if (p <= 0) return 0
  if (p >= 1) return 1
  const grid = 2_000
  // 非归一化 pdf 权重 + 前缀和。
  const weights: number[] = new Array<number>(grid + 1)
  const logNorm = logBetaFn(alpha, beta)
  for (let i = 0; i <= grid; i += 1) {
    const x = i / grid
    weights[i] = Math.exp((alpha - 1) * Math.log(Math.max(x, 1e-12)) + (beta - 1) * Math.log(Math.max(1 - x, 1e-12)) - logNorm)
  }
  let cumulative = 0
  for (let i = 0; i <= grid; i += 1) cumulative += weights[i]
  const target = cumulative * p
  let acc = 0
  for (let i = 0; i <= grid; i += 1) {
    acc += weights[i]
    if (acc >= target) return i / grid
  }
  return 1
}

/** log Beta 函数（Lanczos 近似 log-Γ 之差）。 */
function logBetaFn(alpha: number, beta: number): number {
  return logGamma(alpha) + logGamma(beta) - logGamma(alpha + beta)
}

/** log-Γ（Lanczos 近似，g=7，系数标准）。 */
function logGamma(z: number): number {
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
  }
  const x = z - 1
  let a = g[0]
  const t = x + 7.5
  for (let i = 1; i < g.length; i += 1) a += g[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

// ---------------------------------------------------------------------------
// 核心算法：Thompson 采样与后验分析（纯函数）
// ---------------------------------------------------------------------------

/**
 * Thompson 采样选臂：对每臂后验各抽一个 Beta 样本，取最大者。
 * 返回臂下标（空臂表返回 -1）。
 */
export function thompsonPick(arms: readonly BanditArm[], rng: () => number = Math.random): number {
  let bestIndex = -1
  let bestSample = -Infinity
  for (let i = 0; i < arms.length; i += 1) {
    const arm = arms[i]
    const sample = sampleBeta(arm.alpha, arm.beta, rng)
    if (sample > bestSample) {
      bestSample = sample
      bestIndex = i
    }
  }
  return bestIndex
}

/** 后验均值。 */
function posteriorMean(arm: BanditArm): number {
  return arm.alpha / (arm.alpha + arm.beta)
}

/**
 * 后验分析：每臂的经验率/后验均值/95% CI + 联合蒙特卡洛估计
 * P(best) 与期望损失，并给出停止裁决。
 */
export function posteriorAnalysis(
  arms: readonly BanditArm[],
  rng: () => number = Math.random,
): BanditAnalysis {
  if (arms.length === 0) {
    return {
      arms: [],
      bestIndex: null,
      readyToStop: false,
      verdict: '实验没有可比较的变体',
      winnerIndex: null,
    }
  }

  // 联合后验抽样：一次循环同时累计 P(best) 与期望损失。
  const pBestCount = new Array<number>(arms.length).fill(0)
  const lossAcc = new Array<number>(arms.length).fill(0)
  for (let draw = 0; draw < POSTERIOR_MC_DRAWS; draw += 1) {
    const samples = arms.map((arm) => sampleBeta(arm.alpha, arm.beta, rng))
    let maxIndex = 0
    let maxValue = samples[0]
    for (let i = 1; i < samples.length; i += 1) {
      if (samples[i] > maxValue) {
        maxValue = samples[i]
        maxIndex = i
      }
    }
    pBestCount[maxIndex] += 1
    for (let i = 0; i < samples.length; i += 1) {
      lossAcc[i] += maxValue - samples[i]
    }
  }

  const armReports: ArmPosterior[] = arms.map((arm, index) => ({
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
  }))

  // 最优臂：P(best) 最大（并列取期望损失小者）。
  let bestIndex = 0
  for (let i = 1; i < armReports.length; i += 1) {
    const a = armReports[i]
    const b = armReports[bestIndex]
    if (a.pBest > b.pBest || (a.pBest === b.pBest && a.expectedLoss < b.expectedLoss)) bestIndex = i
  }

  // 停止判据：最优臂 P(best) ≥ 0.9 或期望损失 < ε，且每臂至少 MIN_PULLS_PER_ARM 次。
  const explored = arms.every((arm) => arm.pulls >= MIN_PULLS_PER_ARM)
  const champion = armReports[bestIndex]
  const readyToStop =
    explored && (champion.pBest >= P_BEST_THRESHOLD || champion.expectedLoss < EXPECTED_LOSS_EPSILON)

  const verdict = !explored
    ? `仍在探索期（每臂至少 ${MIN_PULLS_PER_ARM} 次采样后才可裁决），继续 pull`
    : readyToStop
      ? `可以定版：变体 ${champion.index + 1} 有 ${Math.round(champion.pBest * 100)}% 的概率是最优` +
        `（期望损失 ${(champion.expectedLoss * 100).toFixed(2)}%/例，部署它平均不会后悔）`
      : `尚无足够把握：最优变体 ${champion.index + 1} 的 P(best)=${Math.round(champion.pBest * 100)}%、` +
        `期望损失 ${(champion.expectedLoss * 100).toFixed(2)}%/例（阈值为 ${EXPECTED_LOSS_EPSILON * 100}%），继续采样`

  return {
    arms: armReports,
    bestIndex,
    readyToStop,
    verdict,
    winnerIndex: readyToStop ? bestIndex : null,
  }
}

/** 保留 4 位小数。 */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

/** Thompson Sampling 实验仓库。 */
export class BanditStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<BanditExperiment>('prompt-bandit')
  }

  /** 创建实验（2~MAX_BANDIT_ARMS 个变体）。 */
  async create(input: {
    name: string
    model: string
    variants: readonly string[]
    cases: readonly BanditCase[]
  }): Promise<BanditExperiment> {
    const id = `bandit_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const now = Date.now()
    const experiment: BanditExperiment = {
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
    }
    await this.table.put(id, experiment)
    return experiment
  }

  get(id: string): BanditExperiment | undefined {
    return this.table.get(id)
  }

  list(): BanditExperiment[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async save(experiment: BanditExperiment): Promise<void> {
    await this.table.put(experiment.id, experiment)
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(id)
  }
}

// ---------------------------------------------------------------------------
// 采样执行循环（需要 ctx 发起模型调用）
// ---------------------------------------------------------------------------

/** 单轮 pull 的执行记录。 */
export interface PullRoundLog {
  readonly round: number
  /** Thompson 选中的臂下标。 */
  readonly armIndex: number
  /** 本轮用例下标。 */
  readonly caseIndex: number
  readonly passed: boolean
  /** 该臂更新后的后验均值。 */
  readonly armPosteriorMean: number
  readonly latencyMs: number
  readonly error?: string
}

/** 一次 pull 请求的完整结果。 */
export interface PullResult {
  readonly experiment: BanditExperiment
  readonly rounds: readonly PullRoundLog[]
  readonly analysis: BanditAnalysis
}

/**
 * 执行 N 轮 Thompson 采样：每轮选臂（后验抽样）→ 轮转选例 →
 * 调用模型判定通过与否 → Beta 后验加法更新 → 累计遗憾。
 */
export async function runBanditPulls(
  ctx: Context,
  store: BanditStore,
  experimentId: string,
  rounds: number,
): Promise<PullResult> {
  const experiment = store.get(experimentId)
  if (!experiment) throw new Error(`实验不存在：${experimentId}`)
  if (experiment.cases.length === 0) throw new Error('实验没有用例，无法采样')

  const arms: BanditArm[] = experiment.arms.map((arm) => ({ ...arm }))
  const logs: PullRoundLog[] = []
  let nextCaseIndex = experiment.nextCaseIndex

  for (let round = 1; round <= rounds; round += 1) {
    // 1. Thompson 选臂。
    const armIndex = thompsonPick(arms)
    if (armIndex < 0) break
    const arm = arms[armIndex]
    const caseIndex = nextCaseIndex % experiment.cases.length
    nextCaseIndex = (nextCaseIndex + 1) % experiment.cases.length
    const testCase = experiment.cases[caseIndex]

    // 遗憾记账：本轮最优后验均值 − 执行臂后验均值。
    const bestMean = Math.max(...arms.map(posteriorMean))
    const regretDelta = Math.max(0, bestMean - posteriorMean(arm))

    const startedAt = Date.now()
    let passed = false
    let error: string | undefined
    try {
      passed = await runAndJudge(ctx, arm.content, testCase, experiment.model)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    // 2. Beta 共轭更新：一次观测一个加法。
    arm.pulls += 1
    if (passed) {
      arm.alpha += 1
      arm.successes += 1
    } else {
      arm.beta += 1
    }
    arm.regret += regretDelta
    arm.lastPullAt = Date.now()

    logs.push({
      round,
      armIndex,
      caseIndex,
      passed,
      armPosteriorMean: round4(posteriorMean(arm)),
      latencyMs: Date.now() - startedAt,
      ...(error !== undefined ? { error } : {}),
    })
  }

  const updated: BanditExperiment = {
    ...experiment,
    arms,
    nextCaseIndex,
    updatedAt: Date.now(),
  }
  await store.save(updated)
  return { experiment: updated, rounds: logs, analysis: posteriorAnalysis(arms) }
}

/** 运行「变体 + 用例」并判定通过（与 F5 同约定：expected 包含匹配 / 模型评审员）。 */
async function runAndJudge(
  ctx: Context,
  prompt: string,
  testCase: BanditCase,
  model: string,
): Promise<boolean> {
  const userContent = testCase.input ? `${prompt}\n\n${testCase.input}` : prompt
  const result = await ctx.companion.callDeepSeek({
    messages: [{ role: 'user', content: userContent }],
    model,
    source: 'prompt-bandit',
  })
  const output = result.content
  if (testCase.expected !== undefined && testCase.expected.length > 0) {
    return output.toLowerCase().includes(testCase.expected.toLowerCase())
  }
  return judgeWithModel(ctx, prompt, testCase, output, model)
}

/** 模型评审员裁决（jsonMode 严格 JSON：{"pass": boolean, "reason": string}）。 */
async function judgeWithModel(
  ctx: Context,
  prompt: string,
  testCase: BanditCase,
  output: string,
  model: string,
): Promise<boolean> {
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
  ].join('\n')
  try {
    const result = await ctx.companion.callDeepSeek({
      messages: [{ role: 'user', content: judgePrompt }],
      model,
      jsonMode: true,
      maxTokens: 256,
      temperature: 0,
      source: 'prompt-bandit-judge',
    })
    const parsed = extractJsonFromOutput(result.content)
    if (typeof parsed === 'object' && parsed !== null && 'pass' in parsed) {
      return (parsed as { pass: unknown }).pass === true
    }
    return false
  } catch {
    return false
  }
}
