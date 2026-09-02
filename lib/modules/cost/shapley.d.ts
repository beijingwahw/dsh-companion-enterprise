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
    readonly id: string;
    /** 展示名（缺省同 id）。 */
    readonly label?: string;
    /** 本期用量（元，≥0）——联盟折扣档位的驱动量。 */
    readonly usageCny: number;
}
/** 一档阶梯折扣：合计用量 ≥ minCny 时整单适用 discount 折扣率。 */
export interface DiscountTier {
    /** 档位门槛（元，升序唯一）。 */
    readonly minCny: number;
    /** 折扣率（0-1，如 0.12 = 12% off）。 */
    readonly discount: number;
}
/** 分配请求。 */
export interface ShapleyInput {
    readonly players: readonly ShapleyPlayer[];
    /** 阶梯折扣表（须按 minCny 升序；空表 = 无折扣）。 */
    readonly tiers: readonly DiscountTier[];
}
/** 单玩家分配结果。 */
export interface ShapleyAllocation {
    readonly id: string;
    readonly label: string;
    /** 本期用量（元）。 */
    readonly usageCny: number;
    /** 单干时的结余（单独用量能拿到的折扣；通常为 0）。 */
    readonly standaloneSavingsCny: number;
    /** Shapley 分得的结余（含单干部分 + 联合增益的公平份额）。 */
    readonly shapleySavingsCny: number;
    /** 分账后的有效成本 = 用量 − Shapley 结余。 */
    readonly effectiveCny: number;
    /** 占联合结余总额的比例（0-1）。 */
    readonly shareOfSavings: number;
    /** 相比按用量比例分的差额（正 = Shapley 更照顾该玩家）。 */
    readonly vsProportionalCny: number;
}
/** 分配报告。 */
export interface ShapleyReport {
    readonly players: number;
    /** 计算方法：exact（≤8 玩家全排列枚举）/ mcmc（蒙特卡洛抽样）。 */
    readonly method: 'exact' | 'mcmc';
    /** 参与核算的排列数。 */
    readonly permutations: number;
    /** 全员合计用量（元）与所在折扣档率。 */
    readonly grandTotalCny: number;
    readonly grandDiscount: number;
    /** 联盟结余总额 = 大联盟结余 v(N)（元）。 */
    readonly totalSavingsCny: number;
    /** 越档增益 = v(N) − Σ 单干结余（只有联合才拿得到的部分）。 */
    readonly synergyGainCny: number;
    /** Σ Shapley 结余 − v(N) 的浮点残差（应 < 1e-6）。 */
    readonly residualCny: number;
    readonly allocations: readonly ShapleyAllocation[];
    /** 一句话结论。 */
    readonly summary: string;
}
/**
 * 阶梯折扣率：合计用量命中的最高的档（升序表线性扫描）。
 * 无匹配档返回 0（无折扣）。
 */
export declare function tierDiscount(totalCny: number, tiers: readonly DiscountTier[]): number;
/**
 * Shapley 分配主入口。
 * @throws Error 玩家数超限/重复、用量或档位非法时。
 */
export declare function shapleyAllocate(input: ShapleyInput): ShapleyReport;
