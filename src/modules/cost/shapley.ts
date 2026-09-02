/**
 * 模块 C 创新扩展：Shapley 阶梯折扣公平分账（Shapley Value Cost Allocation）。
 *
 * 企业分摊的真实难题：厂商给「联合用量」定阶梯折扣——各部门单独采购
 * 都够不到折扣档，合起来下单却能越档省钱。这笔联合结余该记谁的账？
 * 按用量比例分会惩罚「贡献最大的深度使用者」（他们的用量把联盟推过
 * 了档位线，却只按比例拿回）；平均分则鼓励搭便车。合作博弈论给出了
 * 数学上唯一的公平解——Shapley 值（Lloyd Shapley，2012 年诺贝尔经济
 * 学奖；公共事业成本分摊的机场博弈谱系，Littlechild & Owen 1973）：
 * 每个部门分得「在所有可能的加入顺序下，给联盟带来的边际结余平均值」。
 *
 * 博弈定义（真正的超可加协同，而非逐笔可分）：
 * - 玩家 i 携带用量 c_i；联盟 S 的合计用量 T(S)=Σc_i 决定折扣档
 *   d(T)（阶梯非降），联盟结余 v(S) = T(S)×d(T(S))；
 * - 越档增益 = v(N) − Σv({i})：只有联合才拿得到的部分——
 *   正是「谁把联盟推过档位线」的争议焦点，也是 Shapley 的用武之地。
 *
 * 为什么它是「唯一公平」：Shapley 值是同时满足四条公理的唯一分配——
 * 有效性（分完总额）、对称性（贡献等价者等分）、虚拟者（零边际贡献
 * 分 0）、可加性（多个博弈叠加分配自动正确）。
 *
 * 复杂度：精确解需枚举 n! 加入顺序——玩家 ≤ 8 精确枚举；更多时退化
 * 为种子化蒙特卡洛抽样（无偏估计），报告如实标注方法与样本量。
 * 纯函数模块，博弈由调用方显式定义（各部门用量 + 阶梯折扣表）。
 */

/** 参与分摊的玩家（部门/成本中心）。 */
export interface ShapleyPlayer {
  /** 玩家 id（如 "dept:platform"）。 */
  readonly id: string
  /** 展示名（缺省同 id）。 */
  readonly label?: string
  /** 本期用量（元，≥0）——联盟折扣档位的驱动量。 */
  readonly usageCny: number
}

/** 一档阶梯折扣：合计用量 ≥ minCny 时整单适用 discount 折扣率。 */
export interface DiscountTier {
  /** 档位门槛（元，升序唯一）。 */
  readonly minCny: number
  /** 折扣率（0-1，如 0.12 = 12% off）。 */
  readonly discount: number
}

/** 分配请求。 */
export interface ShapleyInput {
  readonly players: readonly ShapleyPlayer[]
  /** 阶梯折扣表（须按 minCny 升序；空表 = 无折扣）。 */
  readonly tiers: readonly DiscountTier[]
}

/** 单玩家分配结果。 */
export interface ShapleyAllocation {
  readonly id: string
  readonly label: string
  /** 本期用量（元）。 */
  readonly usageCny: number
  /** 单干时的结余（单独用量能拿到的折扣；通常为 0）。 */
  readonly standaloneSavingsCny: number
  /** Shapley 分得的结余（含单干部分 + 联合增益的公平份额）。 */
  readonly shapleySavingsCny: number
  /** 分账后的有效成本 = 用量 − Shapley 结余。 */
  readonly effectiveCny: number
  /** 占联合结余总额的比例（0-1）。 */
  readonly shareOfSavings: number
  /** 相比按用量比例分的差额（正 = Shapley 更照顾该玩家）。 */
  readonly vsProportionalCny: number
}

/** 分配报告。 */
export interface ShapleyReport {
  readonly players: number
  /** 计算方法：exact（≤8 玩家全排列枚举）/ mcmc（蒙特卡洛抽样）。 */
  readonly method: 'exact' | 'mcmc'
  /** 参与核算的排列数。 */
  readonly permutations: number
  /** 全员合计用量（元）与所在折扣档率。 */
  readonly grandTotalCny: number
  readonly grandDiscount: number
  /** 联盟结余总额 = 大联盟结余 v(N)（元）。 */
  readonly totalSavingsCny: number
  /** 越档增益 = v(N) − Σ 单干结余（只有联合才拿得到的部分）。 */
  readonly synergyGainCny: number
  /** Σ Shapley 结余 − v(N) 的浮点残差（应 < 1e-6）。 */
  readonly residualCny: number
  readonly allocations: readonly ShapleyAllocation[]
  /** 一句话结论。 */
  readonly summary: string
}

/** 精确枚举的玩家数上限（8! = 40320 个排列）。 */
const EXACT_MAX_PLAYERS = 8

/** 蒙特卡洛抽样排列数。 */
const MCMC_PERMUTATIONS = 4000

/** 位掩码玩家数上限。 */
const MAX_PLAYERS = 24

/** 金额舍入（厘）。 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** mulberry32 种子化 PRNG（同一输入 → 同一输出，结果可复算）。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher-Yates 洗牌（原位）。 */
function shuffle(order: number[], rng: () => number): void {
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = order[i]
    order[i] = order[j]
    order[j] = tmp
  }
}

/**
 * 阶梯折扣率：合计用量命中的最高的档（升序表线性扫描）。
 * 无匹配档返回 0（无折扣）。
 */
export function tierDiscount(totalCny: number, tiers: readonly DiscountTier[]): number {
  let rate = 0
  for (const tier of tiers) {
    if (totalCny >= tier.minCny) rate = tier.discount
    else break
  }
  return rate
}

/**
 * Shapley 分配主入口。
 * @throws Error 玩家数超限/重复、用量或档位非法时。
 */
export function shapleyAllocate(input: ShapleyInput): ShapleyReport {
  const players = input.players
  if (players.length === 0) throw new Error('shapley: 至少需要一个玩家')
  if (players.length > MAX_PLAYERS) {
    throw new Error(`shapley: 玩家数不能超过 ${MAX_PLAYERS}`)
  }
  const ids = players.map((p) => p.id)
  if (new Set(ids).size !== ids.length) throw new Error('shapley: 玩家 id 不能重复')
  const usages = players.map((p) => {
    if (!Number.isFinite(p.usageCny) || p.usageCny < 0) {
      throw new Error(`shapley: 玩家 ${p.id} 用量必须是非负有限数`)
    }
    return p.usageCny
  })
  // 档位校验：升序、门槛 ≥0、折扣 ∈ [0,1)。
  const tiers = [...input.tiers].sort((a, b) => a.minCny - b.minCny)
  for (let i = 0; i < tiers.length; i += 1) {
    const tier = tiers[i]
    if (!Number.isFinite(tier.minCny) || tier.minCny < 0) {
      throw new Error(`shapley: 档位 ${i} 门槛非法`)
    }
    if (!Number.isFinite(tier.discount) || tier.discount < 0 || tier.discount >= 1) {
      throw new Error(`shapley: 档位 ${i} 折扣率必须 ∈ [0,1)`)
    }
    if (i > 0 && tier.minCny <= tiers[i - 1].minCny) {
      throw new Error('shapley: 档位门槛必须严格递增')
    }
  }

  const n = players.length
  /** 联盟结余 v(S) = T × d(T)。 */
  const valueOf = (total: number): number => total * tierDiscount(total, tiers)

  // 边际核算：按给定顺序逐个加入，记录每玩家的边际结余。
  const accumulate = (order: readonly number[], sums: Float64Array): void => {
    let total = 0
    let value = 0
    for (const index of order) {
      const nextTotal = total + usages[index]
      const nextValue = valueOf(nextTotal)
      sums[index] += nextValue - value
      total = nextTotal
      value = nextValue
    }
  }

  const sums = new Float64Array(n)
  let permutations: number
  let method: 'exact' | 'mcmc'
  if (n <= EXACT_MAX_PLAYERS) {
    // 精确枚举（Heap 算法）全部 n! 排列。
    method = 'exact'
    permutations = 1
    for (let k = 2; k <= n; k += 1) permutations *= k
    const order = players.map((_, index) => index)
    const heap = (size: number): void => {
      if (size === 1) {
        accumulate(order, sums)
        return
      }
      for (let i = 0; i < size; i += 1) {
        heap(size - 1)
        const swapIndex = size % 2 === 0 ? i : 0
        const tmp = order[swapIndex]
        order[swapIndex] = order[size - 1]
        order[size - 1] = tmp
      }
    }
    heap(n)
    for (let i = 0; i < n; i += 1) sums[i] /= permutations
  } else {
    // 种子化蒙特卡洛抽样（无偏估计，同输入可复算）。
    method = 'mcmc'
    permutations = MCMC_PERMUTATIONS
    const rng = mulberry32(0x5ba_e11a)
    const order = players.map((_, index) => index)
    for (let p = 0; p < MCMC_PERMUTATIONS; p += 1) {
      shuffle(order, rng)
      accumulate(order, sums)
    }
    for (let i = 0; i < n; i += 1) sums[i] /= MCMC_PERMUTATIONS
  }

  const grandTotal = usages.reduce((a, b) => a + b, 0)
  const grandDiscount = tierDiscount(grandTotal, tiers)
  const totalSavings = valueOf(grandTotal)
  const standalone = usages.map((c) => valueOf(c))
  const synergyGain = totalSavings - standalone.reduce((a, b) => a + b, 0)
  const proportional =
    totalSavings > 0 && grandTotal > 0
      ? usages.map((c) => (c / grandTotal) * totalSavings)
      : usages.map(() => 0)

  const allocations: ShapleyAllocation[] = players.map((player, index) => ({
    id: player.id,
    label: player.label ?? player.id,
    usageCny: round3(usages[index]),
    standaloneSavingsCny: round3(standalone[index]),
    shapleySavingsCny: round3(sums[index]),
    effectiveCny: round3(usages[index] - sums[index]),
    shareOfSavings:
      totalSavings > 1e-9 ? Math.round((sums[index] / totalSavings) * 1000) / 1000 : 0,
    vsProportionalCny: round3(sums[index] - proportional[index]),
  }))
  allocations.sort((a, b) => b.shapleySavingsCny - a.shapleySavingsCny)

  const residual = Math.abs(allocations.reduce((a, x) => a + x.shapleySavingsCny, 0) - totalSavings)
  const top = allocations[0]
  return {
    players: n,
    method,
    permutations,
    grandTotalCny: round3(grandTotal),
    grandDiscount,
    totalSavingsCny: round3(totalSavings),
    synergyGainCny: round3(synergyGain),
    residualCny: Math.round(residual * 1e6) / 1e6,
    allocations,
    summary:
      `合计 ¥${round3(grandTotal).toFixed(2)} 命中 ${(grandDiscount * 100).toFixed(0)}% 折扣档，` +
      `联合结余 ¥${round3(totalSavings).toFixed(2)}（其中越档增益 ¥${round3(synergyGain).toFixed(2)}）；` +
      `${method === 'exact' ? `精确枚举 ${permutations} 个排列` : `蒙特卡洛抽样 ${permutations} 个排列`}，` +
      `最大受益者 ${top ? `${top.label}（¥${top.shapleySavingsCny.toFixed(2)}）` : '无'}。`,
  }
}
