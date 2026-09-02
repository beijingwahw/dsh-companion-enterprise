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
export function percentileOf(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

/**
 * 中位数：偶数长度取中间两值的均值（四舍五入），奇数长度取中间值。
 * 输入无需有序（内部排序）；空数组返回 0。
 */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

/** 算术均值；空数组返回 0。 */
export function meanOf(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}
