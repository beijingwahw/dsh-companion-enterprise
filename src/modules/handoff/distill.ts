/**
 * 模块 B 创新扩展：渐进式上下文蒸馏（Progressive Context Distillation）。
 *
 * 现实痛点：把长会话交给模型生成交接摘要，本质是"全量重写"——
 * 一次模型调用吃下整段历史，慢、贵、且把"近期对话"和"远古对话"
 * 以同样的信息密度对待。而人类记忆不是这样工作的：最近发生的事
 * 记得原文细节，久远的事只留下事实碎片（"当时决定用方案 A"、
 * "预算上限是 500 元"）。认知科学称之为记忆的时间梯度压缩。
 *
 * 方案：零模型调用、纯本地确定性的两区蒸馏——
 *
 * 1. 近端原文区（verbatim zone）：最近 K 轮对话逐字保留。最近的
 *    轮次几乎必然是当前任务的活跃上下文，任何压缩都是损耗；
 * 2. 远端事实区（distill zone）：更早的轮次不再保留叙事，只做
 *    句级事实抽取——约束（"不要/必须/禁止"）、决策（"决定/采用/
 *    结论"）、行动（"需要/下一步/待办"）、参考（路径/命令/链接/
 *    标识）、数值（预算/耗时/版本）。每类设上限，近者优先
 *    （新事实覆盖同类旧事实的坑位）；
 * 3. 预算驱动装配：给定总字符预算，先装配事实区，剩余预算从最新
 *    轮次向前逐轮装填原文——预算不足时近端优先、远端让位，
 *    压缩比随预算自动伸缩；
 * 4. 可观测性：蒸馏报告带压缩比、各区轮数与事实数，注入效果
 *    可量化、可对比（相比模型摘要的"黑盒压缩"）。
 *
 * 定位：与 /handoff/generate（模型全文摘要）、/handoff/structured
 * （四级分层 + 世系）互补的第三条路径——免费、即时、确定性，
 * 适合"等不起一次模型调用"的快速交接场景。
 */
import type { TranscriptTurn } from '../../core/transcript.js'

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/** 近端原文区缺省轮数。 */
export const DEFAULT_RECENT_TURNS = 6

/** 单轮原文渲染的字符上限（防单轮爆预算；截头留尾）。 */
const PER_TURN_CHAR_CAP = 1_200

/** 总字符预算缺省值。 */
export const DEFAULT_CHAR_BUDGET = 8_000

/** 每类事实保留上限（近者优先）。 */
const FACTS_PER_KIND_CAP = 8

/** 参与事实抽取的句子长度区间（过短无信息，过长是代码块）。 */
const SENTENCE_MIN_CHARS = 6
const SENTENCE_MAX_CHARS = 160

/** 事实类别。 */
export type FactKind = 'constraint' | 'decision' | 'action' | 'reference' | 'metric'

/** 事实类别标签（渲染用）。 */
const FACT_KIND_LABELS: Readonly<Record<FactKind, string>> = {
  constraint: '约束',
  decision: '决策',
  action: '行动',
  reference: '参考',
  metric: '数值',
}

/** 抽取规则：类别 → 触发模式（顺序即优先级，一句只归一类）。 */
const FACT_RULES: ReadonlyArray<{ readonly kind: FactKind; readonly pattern: RegExp }> = [
  { kind: 'constraint', pattern: /不要|不能|不得|必须|禁止|避免|务必|不允许|切勿|别用|切忌/ },
  { kind: 'decision', pattern: /决定|选定|选择[了用]?|采用|方案[是为确]|结论[是为]|确认(使用|采用|走)|最终|敲定/ },
  { kind: 'action', pattern: /需要|待办|接下来|下一步|TODO|要做的|尚未|还需|之后要|再去/ },
  { kind: 'metric', pattern: /\d+(?:\.\d+)?\s*(?:%|元|块|ms|秒|分钟|小时|天|次|条|个|倍|[kKmM]token|token)|v?\d+\.\d+\.\d+/ },
]

/** 参考类实体：路径 / 命令 / 链接 / 标识。 */
const REFERENCE_PATTERN =
  /(?:[\w.-]+\/){1,}[\w.-]+\.\w{1,8}|https?:\/\/\S+|\b(?:npm|npx|pnpm|yarn|git|docker|kubectl|cargo|go|pytest|jest|vitest|tsc)\s+\S+|\b(?:ERR_[A-Z0-9_]+|CVE-\d{4}-\d+|#\d+)\b/

// ---------------------------------------------------------------------------
// 句子切分与归一化
// ---------------------------------------------------------------------------

/** 句子切分：中文句读 + 换行（英文句点不切，保护路径/版本号/缩写）。 */
function splitSentences(text: string): string[] {
  return text
    .split(/[\n。！？；!?;]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

/** 归一化：小写、去空白与标点（去重比对的宽容基础）。 */
function normalizeFact(text: string): string {
  return text.toLowerCase().replace(/[\s，。、；：？！,.;:?!"'`（）()\[\]【】<>《》\-—_~·…]/g, '')
}

/** 同类事实去重：归一化相等或一方包含另一方视为同一事实。 */
function factDuplicate(existing: readonly string[], candidate: string): boolean {
  const normalized = normalizeFact(candidate)
  if (normalized.length === 0) return true
  for (const item of existing) {
    const other = normalizeFact(item)
    if (other === normalized) return true
    if (other.length >= 10 && normalized.length >= 10) {
      if (other.includes(normalized) || normalized.includes(other)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// 事实抽取
// ---------------------------------------------------------------------------

/** 蒸馏出的事实。 */
export interface DistilledFact {
  readonly kind: FactKind
  /** 来源角色（用户/助手）。 */
  readonly role: 'user' | 'assistant' | 'system' | 'tool'
  readonly text: string
}

/** 句子归类：按规则优先级返回类别，非事实句返回 undefined。 */
function classifySentence(sentence: string): FactKind | undefined {
  for (const rule of FACT_RULES) {
    if (rule.pattern.test(sentence)) return rule.kind
  }
  if (REFERENCE_PATTERN.test(sentence)) return 'reference'
  return undefined
}

/**
 * 从远端轮次抽取事实（近者优先覆盖：从最新句子向前扫，
 * 同类上限内先到先得——最新的约束/决策总是能占住坑位）。
 */
export function extractFacts(turns: readonly TranscriptTurn[]): DistilledFact[] {
  const buckets = new Map<FactKind, DistilledFact[]>()
  // 时间正序输出：先近端倒扫收集，最后整体反转。
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex]
    if (turn.role !== 'user' && turn.role !== 'assistant') continue
    const sentences = splitSentences(turn.text)
    for (let sentenceIndex = sentences.length - 1; sentenceIndex >= 0; sentenceIndex -= 1) {
      const sentence = sentences[sentenceIndex]
      if (sentence.length < SENTENCE_MIN_CHARS || sentence.length > SENTENCE_MAX_CHARS) continue
      const kind = classifySentence(sentence)
      if (kind === undefined) continue
      const bucket = buckets.get(kind) ?? []
      if (bucket.length >= FACTS_PER_KIND_CAP) continue
      if (factDuplicate(bucket.map((fact) => fact.text), sentence)) continue
      bucket.push({ kind, role: turn.role, text: sentence })
      buckets.set(kind, bucket)
    }
  }
  // 反转为时间正序（阅读时"先因后果"）。
  const ordered: DistilledFact[] = []
  for (const kind of ['constraint', 'decision', 'action', 'reference', 'metric'] as const) {
    const bucket = buckets.get(kind)
    if (bucket) ordered.push(...bucket.reverse())
  }
  return ordered
}

// ---------------------------------------------------------------------------
// 渲染与预算装配
// ---------------------------------------------------------------------------

/** 蒸馏统计（可观测性）。 */
export interface DistillStats {
  readonly totalTurns: number
  /** 近端原文区实际保留轮数（预算允许时 = 请求轮数）。 */
  readonly verbatimTurns: number
  /** 远端蒸馏区轮数。 */
  readonly distilledTurns: number
  readonly factCount: number
  /** 原始对话总字符数。 */
  readonly originalChars: number
  /** 蒸馏产物字符数。 */
  readonly renderedChars: number
  /** 压缩比（rendered/original，向下取 4 位小数）。 */
  readonly compressionRatio: number
}

/** 蒸馏结果。 */
export interface DistilledContext {
  /** 装配完成的注入文本。 */
  readonly rendered: string
  readonly facts: readonly DistilledFact[]
  readonly stats: DistillStats
}

/** 蒸馏选项。 */
export interface DistillOptions {
  /** 近端原文区轮数（缺省 6；实际保留数受预算约束）。 */
  readonly recentTurns?: number
  /** 总字符预算（缺省 8000）。 */
  readonly charBudget?: number
}

/** 单轮原文渲染：超长时截头留尾（头部意图 + 尾部结果）。 */
function renderTurn(turn: TranscriptTurn): string {
  const speaker = turn.role === 'user' ? '用户' : turn.role === 'assistant' ? '助手' : turn.role
  const body =
    turn.text.length <= PER_TURN_CHAR_CAP
      ? turn.text
      : `${turn.text.slice(0, Math.floor(PER_TURN_CHAR_CAP * 0.6))}……【中略】……${turn.text.slice(-Math.floor(PER_TURN_CHAR_CAP * 0.35))}`
  return `### ${speaker}\n${body}`
}

/**
 * 渐进式蒸馏主入口：远端事实抽取 + 近端原文 + 预算装配。
 * 空会话返回空产物（调用方负责前置校验）。
 */
export function distillContext(
  turns: readonly TranscriptTurn[],
  options: DistillOptions = {},
): DistilledContext {
  const requestedRecent = Math.max(1, Math.floor(options.recentTurns ?? DEFAULT_RECENT_TURNS))
  const budget = Math.max(1_000, Math.floor(options.charBudget ?? DEFAULT_CHAR_BUDGET))
  if (turns.length === 0) {
    return {
      rendered: '',
      facts: [],
      stats: {
        totalTurns: 0,
        verbatimTurns: 0,
        distilledTurns: 0,
        factCount: 0,
        originalChars: 0,
        renderedChars: 0,
        compressionRatio: 0,
      },
    }
  }

  // 分区：远端（蒸馏）与近端（原文候选）。
  const splitIndex = Math.max(0, turns.length - requestedRecent)
  const farTurns = turns.slice(0, splitIndex)
  const nearTurns = turns.slice(splitIndex)
  const facts = extractFacts(farTurns)

  // 事实区渲染。
  const factLines: string[] = []
  if (facts.length > 0) {
    factLines.push('■ 远端事实（早期对话的压缩记忆，按类别归档）')
    for (const fact of facts) {
      factLines.push(`- 〔${FACT_KIND_LABELS[fact.kind]}〕${fact.role === 'user' ? '用户' : '助手'}：${fact.text}`)
    }
    factLines.push('')
  }

  // 近端原文区：从最新轮次向前装填，直到预算耗尽（至少保 1 轮）。
  const renderedTurns: string[] = []
  let used = factLines.join('\n').length
  let verbatimCount = 0
  for (let i = nearTurns.length - 1; i >= 0; i -= 1) {
    const rendered = renderTurn(nearTurns[i])
    const isLast = renderedTurns.length === 0
    // 至少装入最新一轮（预算不足时挤占事实区之后的全部剩余）。
    if (!isLast && used + rendered.length + 20 > budget) break
    renderedTurns.unshift(rendered)
    verbatimCount += 1
    used += rendered.length + 20
  }

  const header = [
    '【渐进式上下文蒸馏】',
    `早期 ${farTurns.length} 轮已压缩为 ${facts.length} 条事实，最近 ${verbatimCount} 轮保留原文。`,
    '',
  ]
  const nearSection =
    renderedTurns.length > 0 ? ['■ 近端原文（最近轮次逐字保留）', ...renderedTurns] : []
  const rendered = [...header, ...factLines, ...nearSection].join('\n').trimEnd()

  const originalChars = turns.reduce((sum, turn) => sum + turn.text.length, 0)
  const round4 = (value: number): number => Math.round(value * 10_000) / 10_000
  return {
    rendered,
    facts,
    stats: {
      totalTurns: turns.length,
      verbatimTurns: verbatimCount,
      distilledTurns: farTurns.length,
      factCount: facts.length,
      originalChars,
      renderedChars: rendered.length,
      compressionRatio: originalChars === 0 ? 0 : round4(rendered.length / originalChars),
    },
  }
}
