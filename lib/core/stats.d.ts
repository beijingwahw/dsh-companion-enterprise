/**
 * 共享描述统计原语：分位数、中位数、均值。
 *
 * percentile 曾在蒙特卡洛工期模拟与模型竞技场排行榜中各自实现
 * （索引钳制顺序不同但数学等价），medianOf/meanOf 曾在金丝雀漂移
 * 监控与关键路径分析中重复出现——描述统计是最容易「随手再写一遍」
 * 的代码，也是最容易写错边界（空数组、偶数长度、极端分位）的地方。
 * 本模块提供唯一权威实现（DRY，Hunt & Thomas 1999），边界行为：
 * 空数组返回 0，分位索引统一钳制到 [0, n-1]。
 *
 * 纯函数模块：无状态、无副作用、无 I/O。
 */
/**
 * 按分位数取值（输入需已升序排序）。
 * 索引 = ceil(p/100 × n) − 1，钳制到 [0, n−1]；空数组返回 0。
 * 这是「最近邻经验分位」口径：P50 恰为中位、P100 为最大值。
 */
export declare function percentileOf(sorted: readonly number[], p: number): number;
/**
 * 中位数：偶数长度取中间两值的均值（四舍五入），奇数长度取中间值。
 * 输入无需有序（内部排序）；空数组返回 0。
 */
export declare function medianOf(values: readonly number[]): number;
/** 算术均值；空数组返回 0。 */
export declare function meanOf(values: readonly number[]): number;
