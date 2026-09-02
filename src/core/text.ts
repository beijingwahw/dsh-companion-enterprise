/**
 * 共享文本度量原语：字符 n-gram shingle 与 Jaccard 相似度。
 *
 * 同一套「文本 → 3-gram 集合 → Jaccard 相似度」管线曾在金丝雀漂移监控
 * （风格指纹比对）与语义邻域检索（近重复会话识别）中各自独立实现——
 * 语义逐字相同的两份代码一旦其中一份修复 bug，另一份必然带着旧 bug
 * 继续跑（DRY 原则，Hunt & Thomas《The Pragmatic Programmer》1999）。
 * 本模块是唯一权威实现：字符 3-gram 是近重复检测的工业最小配置
 * （Broder 1997 的 shingling 技术， AltaVista 搜索引擎去重的基石）；
 * Jaccard 相似度（Paul Jaccard, 1912，植物群落相似度研究的起点）
 * 至今仍是集合相似度的默认标准。
 *
 * 纯函数模块：无状态、无副作用、无 I/O。
 */

/**
 * 文本 → 字符 3-gram shingle 集合（小写、去空白）。
 * 对中文/代码/中英混写统一处理；短于 3 字符的文本返回空集。
 */
export function charShingles(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, '')
  const set = new Set<string>()
  for (let i = 0; i + 3 <= normalized.length; i += 1) {
    set.add(normalized.slice(i, i + 3))
  }
  return set
}

/**
 * Jaccard 相似度：|A∩B| / |A∪B|。
 * 双空集约定为 1（两段空文本视为完全相同），单边空集为 0。
 * 小集合优先遍历，交集计数成本 O(|small|)。
 */
export function jaccardSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let inter = 0
  for (const item of small) {
    if (large.has(item)) inter += 1
  }
  return inter / (a.size + b.size - inter)
}

/** 两段文本的 shingle-Jaccard 相似度（charShingles + jaccardSets 的组合便捷入口）。 */
export function jaccardText(a: string, b: string): number {
  return jaccardSets(charShingles(a), charShingles(b))
}
