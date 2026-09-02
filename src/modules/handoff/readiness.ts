/**
 * 模块 B 创新扩展：交接就绪度评分与缺口检测（Handoff Readiness Gate）。
 *
 * 结构化交接（structured.ts）解决了「交接里有什么」；但一份交接
 * 拿到新会话里到底「够不够用」，此前只能靠感觉。航空业的答案是不能
 * 靠感觉——起飞前过检查单（pre-flight checklist），逐项打勾，任何
 * critical 项不过就不得起飞。本模块把同样的纪律引入上下文交接：
 * 交接文档在投递之前先过「就绪度门」。
 *
 * 六维检查单（权重合计 100）：
 * 1. 锚定覆盖（25）：硬约束的数量与质量——0 条锚定是最严重的缺口
 *    （新会话无从知道哪些线不能踩）；过短/无具体细节的锚定打折；
 * 2. 行动清晰（20）：是否有显式「下一步」；进行中事项是否含
 *    未决措辞（待定/TODO/不确定）——下一步不明，接班第一脚就踩空；
 * 3. 开放问题显式化（15）：悬而未决的问题是否被显式列为开放问题，
 *    而不是藏在字里行间——显式的未知是资产，隐式的未知是地雷；
 * 4. 参考完整性（20）：活动项里提到的路径/命令/ID 是否在参考区
 *    登记（悬空引用检测）——「去改那个配置文件」但没说文件在哪，
 *    是交接事故的高发源头；
 * 5. 世系健康（10）：深度超阈值（逐代转述损耗）、无理由废弃锚定、
 *    守门自动补回（模型已遗忘的信号）——历史债要显式还，不能滚；
 * 6. 体积预算（10）：注入渲染文本是否超出预算（超限即注入截断，
 *    排在后面的参考项会整段丢失——就绪度在交付管道上被物理截胡）。
 *
 * 输出：0-100 总分 + 分级（A/B/C/D）+ 分维得分 + 缺口清单
 * （critical/warning/info 三级，每条附修复建议）。
 * 纯函数实现，评估任何 StructuredHandoff，无需存储。
 */
import { renderStructuredForInjection, type StructuredHandoff } from './structured.js'

// ---------------------------------------------------------------------------
// 参数与阈值
// ---------------------------------------------------------------------------

/** 注入文本字符预算（超出将在注入时被截断，参考项整段丢失风险）。 */
export const INJECTION_CHAR_BUDGET = 4_000

/** 分维权重（合计 100）。 */
const WEIGHTS = {
  anchorCoverage: 25,
  actionClarity: 20,
  openQuestions: 15,
  referenceIntegrity: 20,
  lineageHealth: 10,
  sizeBudget: 10,
} as const

/** 锚定项的最低有效长度（过短的约束几乎不可执行）。 */
const MIN_ANCHOR_CHARS = 8

/** 未决措辞检测模式（进行中/下一步项中出现即记缺口）。 */
const UNRESOLVED_PATTERN = /(待定|待确认|待讨论|TODO|TBD|不确定|再看看|待补充|未知)/

/** 文件路径检测模式（Unix 风格绝对/相对路径或 Windows 盘符路径）。 */
const PATH_PATTERN = /((?:[~/]|\.{1,2}\/)[\w./-]+|[A-Za-z]:[\\/][\w\\/.-]+)/

/** 命令检测模式（常见命令起始词）。 */
const COMMAND_PATTERN = /\b(npm|npx|yarn|pnpm|git|docker|kubectl|python|node|curl|bash|sh|make)\s+\S/

/** 标识符检测模式（模型 id / 会话 id / 工单号等「字母_数字」复合词）。 */
const ID_PATTERN = /\b[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+){2,}\b/

// ---------------------------------------------------------------------------
// 报告模型
// ---------------------------------------------------------------------------

/** 缺口严重级别。 */
export type GapSeverity = 'critical' | 'warning' | 'info'

/** 单条缺口。 */
export interface ReadinessGap {
  readonly severity: GapSeverity
  /** 所属维度键（锚定覆盖/行动清晰/…）。 */
  readonly dimension: string
  /** 问题描述（中文，可直接展示）。 */
  readonly message: string
  /** 修复建议。 */
  readonly suggestion: string
}

/** 分维得分。 */
export interface DimensionScore {
  readonly key: keyof typeof WEIGHTS
  readonly label: string
  /** 0-100。 */
  readonly score: number
  readonly weight: number
  /** 本维度的缺口（与总 gaps 中的条目同源）。 */
  readonly gaps: readonly ReadinessGap[]
}

/** 就绪度报告。 */
export interface ReadinessReport {
  readonly handoffId: string
  readonly depth: number
  /** 0-100 总分（分维加权）。 */
  readonly score: number
  /** A（≥85 可放心投递）/ B（≥70 小缺口）/ C（≥50 需补课）/ D（<50 不可投递）。 */
  readonly grade: 'A' | 'B' | 'C' | 'D'
  /** 是否存在 critical 缺口（存在则不建议投递）。 */
  readonly blocking: boolean
  readonly dimensions: readonly DimensionScore[]
  /** 全部缺口（critical 在前）。 */
  readonly gaps: readonly ReadinessGap[]
  /** 一句话总评。 */
  readonly summary: string
  /** 注入渲染的字符量与预算。 */
  readonly renderedChars: number
  readonly charBudget: number
}

// ---------------------------------------------------------------------------
// 评估主函数
// ---------------------------------------------------------------------------

/** 就绪度门：评估一份结构化交接（纯函数）。 */
export function assessReadiness(handoff: StructuredHandoff): ReadinessReport {
  const gapLists: ReadinessGap[][] = []
  const dimension = (
    key: keyof typeof WEIGHTS,
    label: string,
    score: number,
    gaps: ReadinessGap[],
  ): DimensionScore => {
    gapLists.push(gaps)
    return { key, label, score: clampScore(score), weight: WEIGHTS[key], gaps }
  }

  const anchors = handoff.tiers.anchors
  const active = handoff.tiers.active
  const reference = handoff.tiers.reference

  // ---- 1. 锚定覆盖 ----
  const anchorGaps: ReadinessGap[] = []
  let anchorScore: number
  if (anchors.length === 0) {
    anchorScore = 0
    anchorGaps.push({
      severity: 'critical',
      dimension: '锚定覆盖',
      message: '没有任何锚定约束：新会话无从知道哪些红线不能踩、哪些决策已定',
      suggestion: '回到源会话补充硬约束（技术选型、预算上限、合规要求、已否决方案），重新生成交接',
    })
  } else {
    anchorScore = 100
    const thin = anchors.filter((a) => a.text.trim().length < MIN_ANCHOR_CHARS)
    if (thin.length > 0) {
      anchorScore -= Math.round((thin.length / anchors.length) * 40)
      anchorGaps.push({
        severity: 'warning',
        dimension: '锚定覆盖',
        message: `${thin.length} 条锚定约束过短（少于 ${MIN_ANCHOR_CHARS} 字），可执行性存疑`,
        suggestion: '把短约束改写为可判定的完整语句（谁/做什么/边界在哪）',
      })
    }
    if (anchors.length > 12) {
      anchorScore = Math.max(60, anchorScore - 15)
      anchorGaps.push({
        severity: 'info',
        dimension: '锚定覆盖',
        message: `锚定约束多达 ${anchors.length} 条，新会话可能顾此失彼`,
        suggestion: '将已长期稳定的约束合并同类项，或把彻底过时的显式废弃',
      })
    }
  }

  // ---- 2. 行动清晰 ----
  const actionGaps: ReadinessGap[] = []
  let actionScore = 100
  const nextItems = active.filter((item) => item.kind === 'next')
  if (nextItems.length === 0) {
    actionScore -= 50
    actionGaps.push({
      severity: 'critical',
      dimension: '行动清晰',
      message: '没有显式的「下一步」：接班者不知道第一件事做什么',
      suggestion: '在活动项中补充 1-3 条下一步（kind=next），按优先级排列',
    })
  }
  const unresolved = active.filter((item) => UNRESOLVED_PATTERN.test(item.text))
  if (unresolved.length > 0) {
    actionScore -= Math.min(40, unresolved.length * 15)
    actionGaps.push({
      severity: 'warning',
      dimension: '行动清晰',
      message: `${unresolved.length} 条活动项含未决措辞（待定/TODO/不确定）：接班即撞上悬而未决的分叉`,
      suggestion: '未决事项要么拍板后改写为确定表述，要么显式移入开放问题区并注明卡在谁手里',
    })
  }
  const inProgress = active.filter((item) => item.kind === 'in_progress')
  if (inProgress.length > 6) {
    actionScore -= 15
    actionGaps.push({
      severity: 'info',
      dimension: '行动清晰',
      message: `进行中事项多达 ${inProgress.length} 条，注意交接注意力稀释`,
      suggestion: '已完成的部分移入归档区，进行中区只保留真正活跃的事项',
    })
  }

  // ---- 3. 开放问题显式化 ----
  const questionGaps: ReadinessGap[] = []
  let questionScore = 100
  const openQuestions = active.filter((item) => item.kind === 'open_question')
  if (openQuestions.length === 0) {
    // 没有开放问题不一定是好事：配合未决措辞检测，若活动项也无未决信号，
    // 视为「可能已把未知当已知」。
    if (unresolved.length === 0) {
      questionScore = 70
      questionGaps.push({
        severity: 'info',
        dimension: '开放问题',
        message: '未显式列出任何开放问题——确认真的没有悬而未决的事项，还是没想起来',
        suggestion: '快速回顾源会话尾部的争论与搁置点，有则补为开放问题',
      })
    }
  } else if (openQuestions.length > 5) {
    questionScore -= 20
    questionGaps.push({
      severity: 'warning',
      dimension: '开放问题',
      message: `开放问题多达 ${openQuestions.length} 条，接班负荷大`,
      suggestion: '为开放问题排序，标注哪些阻塞下一步、哪些可以并行探索',
    })
  }

  // ---- 4. 参考完整性（悬空引用检测） ----
  const referenceGaps: ReadinessGap[] = []
  let referenceScore = 100
  const referenceText = reference.map((item) => item.text).join('\n').toLowerCase()
  const activeText = active.map((item) => item.text).join('\n')
  const danglingPaths = collectMatches(activeText, PATH_PATTERN).filter(
    (path) => !referenceText.includes(path.toLowerCase()),
  )
  const danglingCommands = collectMatches(activeText, COMMAND_PATTERN).filter(
    (command) => !referenceText.includes(command.toLowerCase()),
  )
  const danglingIds = collectMatches(activeText, ID_PATTERN).filter(
    (id) => !referenceText.includes(id.toLowerCase()),
  )
  const danglingTotal = danglingPaths.length + danglingCommands.length + danglingIds.length
  if (danglingTotal > 0) {
    referenceScore -= Math.min(70, danglingTotal * 20)
    const detail = [
      danglingPaths.length > 0 ? `路径：${danglingPaths.slice(0, 3).join('、')}` : '',
      danglingCommands.length > 0 ? `命令：${danglingCommands.slice(0, 3).join('、')}` : '',
      danglingIds.length > 0 ? `标识符：${danglingIds.slice(0, 3).join('、')}` : '',
    ]
      .filter((line) => line.length > 0)
      .join('；')
    referenceGaps.push({
      severity: danglingTotal >= 3 ? 'critical' : 'warning',
      dimension: '参考完整性',
      message: `活动项引用了 ${danglingTotal} 处路径/命令/ID，但参考区未登记（${detail}）`,
      suggestion: '把活动项提到的每个路径、命令、会话/模型 ID 补入参考区（TIER 3）',
    })
  }
  if (reference.length === 0 && active.length > 0) {
    referenceScore -= 20
    referenceGaps.push({
      severity: 'info',
      dimension: '参考完整性',
      message: '参考区为空但存在活动项：多数实操交接至少需要一两个路径或命令',
      suggestion: '检查活动项是否隐式依赖了未写出的环境信息',
    })
  }

  // ---- 5. 世系健康 ----
  const lineageGaps: ReadinessGap[] = []
  let lineageScore = 100
  if (handoff.depth + 1 > 3) {
    lineageScore -= 30
    lineageGaps.push({
      severity: 'warning',
      dimension: '世系健康',
      message: `本交接已传承 ${handoff.depth + 1} 代，逐代转述的信息损耗风险高`,
      suggestion: '关键决策回读源头会话原文核实，或重新从源会话生成初代交接',
    })
  }
  const droppedWithoutReason = handoff.dispositions.filter(
    (d) => d.action === 'dropped' && !(d.reason ?? '').trim(),
  )
  if (droppedWithoutReason.length > 0) {
    lineageScore -= Math.min(30, droppedWithoutReason.length * 15)
    lineageGaps.push({
      severity: 'warning',
      dimension: '世系健康',
      message: `${droppedWithoutReason.length} 条上代锚定约束被废弃且没有写理由`,
      suggestion: '补写废弃理由（约束失效的上下文），否则后人可能重新踩坑后再次否决',
    })
  }
  const autoRestored = anchors.filter((a) => a.autoRestored).length
  if (autoRestored > 0) {
    lineageScore -= Math.min(25, autoRestored * 10)
    lineageGaps.push({
      severity: 'info',
      dimension: '世系健康',
      message: `${autoRestored} 条锚定约束靠守门机制自动补回（模型本次输出中遗漏）`,
      suggestion: '锚定约束较多时可精简合并，降低模型的遗忘概率',
    })
  }

  // ---- 6. 体积预算 ----
  const sizeGaps: ReadinessGap[] = []
  const rendered = renderStructuredForInjection(handoff)
  let sizeScore = 100
  if (rendered.length > INJECTION_CHAR_BUDGET) {
    sizeScore = Math.max(0, 100 - Math.ceil((rendered.length / INJECTION_CHAR_BUDGET - 1) * 200))
    sizeGaps.push({
      severity: 'critical',
      dimension: '体积预算',
      message: `注入渲染 ${rendered.length} 字符，超出预算 ${INJECTION_CHAR_BUDGET}（注入时尾部内容将被截断）`,
      suggestion: '压缩归档区与参考区（合并同类项、删除已失效参考），或拆分为多次交接',
    })
  } else if (rendered.length > INJECTION_CHAR_BUDGET * 0.8) {
    sizeScore = 70
    sizeGaps.push({
      severity: 'info',
      dimension: '体积预算',
      message: `注入渲染 ${rendered.length} 字符，接近预算 ${INJECTION_CHAR_BUDGET}（余量不足 20%）`,
      suggestion: '为后续代际增长留出余量：现在就精简归档与参考区',
    })
  }

  // ---- 汇总 ----
  const dimensions: DimensionScore[] = [
    dimension('anchorCoverage', '锚定覆盖', anchorScore, anchorGaps),
    dimension('actionClarity', '行动清晰', actionScore, actionGaps),
    dimension('openQuestions', '开放问题', questionScore, questionGaps),
    dimension('referenceIntegrity', '参考完整性', referenceScore, referenceGaps),
    dimension('lineageHealth', '世系健康', lineageScore, lineageGaps),
    dimension('sizeBudget', '体积预算', sizeScore, sizeGaps),
  ]
  const score = Math.round(
    dimensions.reduce((sum, dim) => sum + (dim.score * dim.weight) / 100, 0),
  )
  const grade: ReadinessReport['grade'] =
    score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D'
  const gaps = gapLists
    .flat()
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
  const blocking = gaps.some((gap) => gap.severity === 'critical')

  const summary =
    `就绪度 ${score}/100（${grade}）：` +
    (blocking
      ? `存在 ${gaps.filter((g) => g.severity === 'critical').length} 个致命缺口，不建议直接投递`
      : grade === 'A'
        ? '各维度齐备，可放心投递给新会话'
        : '可以投递，但建议先按缺口清单补课')

  return {
    handoffId: handoff.handoffId,
    depth: handoff.depth,
    score,
    grade,
    blocking,
    dimensions,
    gaps,
    summary,
    renderedChars: rendered.length,
    charBudget: INJECTION_CHAR_BUDGET,
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 收集正则的全部不重复命中（原文匹配，保留大小写）。 */
function collectMatches(text: string, pattern: RegExp): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
    const value = match[0]
    if (!seen.has(value)) {
      seen.add(value)
      result.push(value)
    }
  }
  return result
}

/** 分数钳制到 [0, 100]。 */
function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)))
}

/** 缺口严重度排序权重。 */
function severityRank(severity: GapSeverity): number {
  return severity === 'critical' ? 2 : severity === 'warning' ? 1 : 0
}
