/**
 * 执行轨迹分析器视图页（模块 E 客户端 UI，挂载于 conversation.view）：
 * - E1 时间轴：选择会话派生轨迹，横向条形时间轴展示每个节点
 *   （步骤名/耗时/Token 拆分/模型/缓存命中），支持按耗时或 Token 排序定位瓶颈；
 * - E2 异常标注：异常节点红色高亮，hover（title）显示原因与建议；
 * - E3 轨迹对比：选择两个会话对比差异，可导出 HTML 对比报告；
 * - E4 统计面板：汇总指标 + 近 14 天趋势（纯 div 条形图）+ 基准线对比；
 * - E5 SPC 控制图：EWMA + Western Electric 规则监控指标漂移（纯 SVG 绘制，
 *   支持指标/λ/限宽参数与三档判级横幅，GET /trace/spc）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Input, Pill, Select, Spinner, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  deriveTrace,
  diffTraces,
  downloadBlob,
  fetchTraceSessions,
  fetchTraceSpc,
  fetchTraceStats,
} from '../api.js'
import type {
  SessionRecord,
  SpcMetric,
  SpcPoint,
  SpcResponse,
  TraceAnalysisResponse,
  TraceDiffEntry,
  TraceNode,
  TraceStatsResponse,
} from '../api.js'
import styles from './TraceAnalyzerView.module.css'

/** 组件 props：sessionId 由 slot 注入（缺省时不预选会话）。 */
export interface TraceAnalyzerViewProps {
  readonly sessionId?: string
}

/** 时间轴排序方式。 */
type SortMode = 'time' | 'duration' | 'tokens'

/** 毫秒 → 可读时长。 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** 节点类别中文标签。 */
function kindLabel(kind: TraceNode['kind']): string {
  switch (kind) {
    case 'tool':
      return '工具'
    case 'agent':
      return '子Agent'
    case 'model':
      return '模型'
    default:
      return '步骤'
  }
}

// ---------------------------------------------------------------------
// E5 SPC 控制图（模块 E 创新扩展）
// ---------------------------------------------------------------------

/** SPC 查询区间（天）：视图无既有日期区间状态，固定近 28 天。 */
const SPC_RANGE_DAYS = 28

/** SPC 控制图高度（SVG viewBox 高度，px）。 */
const SPC_CHART_HEIGHT = 220

/** SPC 控制图四边留白（px）：左侧留给 y 轴刻度、底部留给日期标签。 */
const SPC_CHART_PAD = { top: 14, right: 16, bottom: 30, left: 56 }

/** SPC 指标下拉选项（value 对应 SpcMetric，label 为中文说明）。 */
const SPC_METRIC_OPTIONS: ReadonlyArray<{ readonly value: SpcMetric; readonly label: string }> = [
  { value: 'duration-per-trace', label: '单轮耗时' },
  { value: 'tokens-per-trace', label: '单轮 Token' },
  { value: 'anomaly-rate', label: '异常率' },
  { value: 'cache-hit-rate', label: '缓存命中率' },
  { value: 'tool-success-rate', label: '工具成功率' },
]

/** SPC 判级元数据：三档 verdict（受控/轻微异常/失控）的展示文案与样式类。 */
const SPC_VERDICT_META: Readonly<
  Record<SpcResponse['verdict'], { readonly text: string; readonly banner: string; readonly badge: string }>
> = {
  stable: { text: '受控', banner: styles.spcBannerStable, badge: styles.spcOkBadge },
  warning: { text: '轻微异常', banner: styles.spcBannerWarning, badge: styles.spcWarnBadge },
  'out-of-control': { text: '失控', banner: styles.spcBannerOoc, badge: styles.spcBadBadge },
}

/** 计算近 N 天的 [from, to] 日期区间（YYYY-MM-DD，本地时区近似）。 */
function rangeOfDays(days: number): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to.getTime() - (days - 1) * 86_400_000)
  const fmt = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: fmt(from), to: fmt(to) }
}

/** SPC 查询区间（模块级常量：各次分析复用同一近 28 天区间）。 */
const SPC_RANGE = rangeOfDays(SPC_RANGE_DAYS)

/** SPC 指标值格式化：比率类显示百分比，耗时显示毫秒，Token 取整。 */
function formatSpcValue(metric: SpcMetric, value: number): string {
  if (metric === 'duration-per-trace') return `${Math.round(value)}ms`
  if (metric === 'tokens-per-trace') return `${Math.round(value).toLocaleString('zh-CN')}`
  return `${(value * 100).toFixed(2)}%`
}

/** SPC 控制图 props。 */
interface SpcChartProps {
  /** 查询区间内的控制图点（按日升序）。 */
  readonly points: readonly SpcPoint[]
  /** 中心线（Phase I 过程均值）。 */
  readonly center: number
  /** 监控指标（决定坐标轴与悬停文案的值格式化方式）。 */
  readonly metric: SpcMetric
}

/**
 * SPC 控制图（纯 SVG 绘制，不依赖图表库）：
 * - value（细线）/ EWMA（粗线，主序列）/ ucl、lcl（虚线，随每日限宽收敛可呈折线）；
 * - 中心线画水平点线；越限点标圆点（劣化侧红、改善侧橙）；
 * - y 轴取全部序列 min/max 加 10% padding；悬停 title 显示日期/值/EWMA/上下限。
 */
function SpcChart(props: SpcChartProps): ReactElement {
  const { points, center, metric } = props
  const n = points.length

  // 画布几何：宽度随点数自适应（每点至少 44px），高度固定 220。
  const plotWidth = Math.max(560, n * 44)
  const width = SPC_CHART_PAD.left + plotWidth + SPC_CHART_PAD.right
  const height = SPC_CHART_HEIGHT
  const plotTop = SPC_CHART_PAD.top
  const plotBottom = height - SPC_CHART_PAD.bottom
  const plotHeight = plotBottom - plotTop

  // y 轴范围：全部序列（value/EWMA/ucl/lcl）的 min/max 加 10% padding；
  // 全平序列（span=0）时按量级取 10% 作最小 padding，避免除零。
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const point of points) {
    for (const value of [point.value, point.ewma, point.ucl, point.lcl]) {
      if (value < lo) lo = value
      if (value > hi) hi = value
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0
    hi = 1
  }
  const span = hi - lo
  const pad = span > 0 ? span * 0.1 : Math.max(Math.abs(hi) * 0.1, 1)
  lo -= pad
  hi += pad
  const yOf = (value: number): number => plotTop + (1 - (value - lo) / (hi - lo)) * plotHeight
  const xOf = (index: number): number =>
    SPC_CHART_PAD.left + (n <= 1 ? plotWidth / 2 : (index / (n - 1)) * plotWidth)

  /** 序列取值函数 → SVG 折线 path（M/L）。 */
  const pathOf = (select: (point: SpcPoint) => number): string =>
    points
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(1)} ${yOf(select(point)).toFixed(1)}`)
      .join(' ')

  // 悬停命中区：每日一列（列宽 = 步长，最小 8px，首尾列向边缘拉伸）。
  const hitWidth = Math.max(8, plotWidth / Math.max(1, n))
  const hitX = (index: number): number =>
    Math.min(Math.max(SPC_CHART_PAD.left, xOf(index) - hitWidth / 2), SPC_CHART_PAD.left + plotWidth - hitWidth)

  // x 轴日期标签抽稀：最多约 14 个，避免重叠。
  const labelStep = n <= 14 ? 1 : Math.ceil(n / 14)

  // y 轴参考网格（上/中/下）与对应刻度值。
  const gridYs = [plotTop, plotTop + plotHeight / 2, plotBottom]
  const gridValues = [hi, (hi + lo) / 2, lo]

  return (
    <svg className={styles.spcChart} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="SPC 控制图">
      {/* 网格线 + y 轴刻度 */}
      {gridYs.map((y, index) => (
        <line
          key={`grid-${index}`}
          x1={SPC_CHART_PAD.left}
          y1={y}
          x2={SPC_CHART_PAD.left + plotWidth}
          y2={y}
          className={styles.spcGrid}
        />
      ))}
      {gridYs.map((y, index) => (
        <text key={`ytick-${index}`} x={SPC_CHART_PAD.left - 6} y={y + 3} textAnchor="end" className={styles.spcAxisText}>
          {formatSpcValue(metric, gridValues[index])}
        </text>
      ))}
      {/* 上/下控制限（虚线；每日限宽不同故为折线） */}
      <path d={pathOf((point) => point.ucl)} className={styles.spcLineLimit} />
      <path d={pathOf((point) => point.lcl)} className={styles.spcLineLimit} />
      {/* 中心线（水平点线） */}
      <line
        x1={SPC_CHART_PAD.left}
        y1={yOf(center)}
        x2={SPC_CHART_PAD.left + plotWidth}
        y2={yOf(center)}
        className={styles.spcLineCenter}
      />
      {/* 原始值（细线折线） */}
      <path d={pathOf((point) => point.value)} className={styles.spcLineValue} />
      {/* EWMA（主序列，粗折线） */}
      <path d={pathOf((point) => point.ewma)} className={styles.spcLineEwma} />
      {/* 越限点：劣化侧红色实心、改善侧橙色 */}
      {points.map((point, index) =>
        point.violation ? (
          <circle
            key={`violation-${point.day}`}
            cx={xOf(index)}
            cy={yOf(point.ewma)}
            r={4}
            className={point.badSide ? styles.spcDotBad : styles.spcDotWarn}
          />
        ) : null,
      )}
      {/* x 轴日期标签（MM-DD） */}
      {points.map((point, index) =>
        index % labelStep === 0 ? (
          <text key={`xlabel-${point.day}`} x={xOf(index)} y={height - 8} textAnchor="middle" className={styles.spcAxisText}>
            {point.day.slice(5)}
          </text>
        ) : null,
      )}
      {/* 悬停命中区（覆盖全高，title 显示日期/值/EWMA/上下限） */}
      {points.map((point, index) => (
        <rect key={`hit-${point.day}`} x={hitX(index)} y={plotTop} width={hitWidth} height={plotHeight} className={styles.spcHover}>
          <title>
            {`${point.day}：值 ${formatSpcValue(metric, point.value)} / EWMA ${formatSpcValue(metric, point.ewma)} / 上限 ${formatSpcValue(metric, point.ucl)} / 下限 ${formatSpcValue(metric, point.lcl)}`}
            {point.violation ? `（越限${point.badSide ? '，劣化侧' : '，改善侧'}）` : ''}
          </title>
        </rect>
      ))}
    </svg>
  )
}

/** 执行轨迹分析器视图页。 */
export function TraceAnalyzerView(props: TraceAnalyzerViewProps): ReactElement {
  const [sessions, setSessions] = useState<readonly SessionRecord[]>([])
  const [selectedSession, setSelectedSession] = useState(props.sessionId ?? '')
  const [analysis, setAnalysis] = useState<TraceAnalysisResponse | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('time')

  // 对比（E3）
  const [compareSession, setCompareSession] = useState('')
  const [diffEntries, setDiffEntries] = useState<readonly TraceDiffEntry[] | undefined>()
  const [diffLoading, setDiffLoading] = useState(false)

  // 统计面板（E4）
  const [stats, setStats] = useState<TraceStatsResponse | undefined>()

  // SPC 控制图（E5 创新扩展）
  const [spcMetric, setSpcMetric] = useState<SpcMetric>('duration-per-trace')
  const [spcLambdaInput, setSpcLambdaInput] = useState('0.3')
  const [spcLimitInput, setSpcLimitInput] = useState('3')
  const [spc, setSpc] = useState<SpcResponse | undefined>()
  const [spcLoading, setSpcLoading] = useState(false)
  const [spcError, setSpcError] = useState('')

  // 卸载守卫 + 请求序号：防止过期响应覆盖新结果、卸载后 setState。
  const mountedRef = useRef(true)
  const analyzeSeq = useRef(0)
  const diffSeq = useRef(0)
  const spcSeq = useRef(0)
  /** 挂载预载守卫：SPC 首次分析只执行一次。 */
  const spcInitRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // 加载可分析会话列表
  useEffect(() => {
    let cancelled = false
    fetchTraceSessions()
      .then((response) => {
        if (!cancelled) setSessions(response.sessions)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '会话列表加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 加载近 14 天统计趋势
  useEffect(() => {
    let cancelled = false
    const to = new Date()
    const from = new Date(to.getTime() - 13 * 86_400_000)
    const fmt = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    fetchTraceStats({ from: fmt(from), to: fmt(to) })
      .then((response) => {
        if (!cancelled) setStats(response)
      })
      .catch(() => {
        // 趋势加载失败不阻塞主功能。
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** 分析选中会话（E1/E2）。请求序号守卫：过期响应直接丢弃。 */
  const analyze = useCallback(() => {
    if (!selectedSession) return
    const seq = ++analyzeSeq.current
    setLoading(true)
    setError('')
    setAnalysis(undefined)
    setDiffEntries(undefined)
    deriveTrace(selectedSession)
      .then((response) => {
        if (!mountedRef.current || seq !== analyzeSeq.current) return
        setAnalysis(response)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || seq !== analyzeSeq.current) return
        setError(err instanceof Error ? err.message : '轨迹分析失败')
      })
      .finally(() => {
        if (mountedRef.current && seq === analyzeSeq.current) setLoading(false)
      })
  }, [selectedSession])

  /** 与对比会话做差异分析（E3）。请求序号守卫：过期响应直接丢弃。 */
  const runDiff = useCallback(async () => {
    if (!selectedSession || !compareSession) return
    const seq = ++diffSeq.current
    setDiffLoading(true)
    setError('')
    try {
      const response = await diffTraces({
        old: { sessionId: selectedSession },
        new: { sessionId: compareSession },
      })
      if (mountedRef.current && seq === diffSeq.current && response.format === 'json') {
        setDiffEntries(response.entries)
      }
    } catch (err) {
      if (mountedRef.current && seq === diffSeq.current) {
        setError(err instanceof Error ? err.message : '轨迹对比失败')
      }
    } finally {
      if (mountedRef.current && seq === diffSeq.current) setDiffLoading(false)
    }
  }, [selectedSession, compareSession])

  /** 导出 HTML 对比报告。 */
  const exportDiffHtml = useCallback(async () => {
    if (!selectedSession || !compareSession) return
    setDiffLoading(true)
    try {
      const response = await diffTraces({
        old: { sessionId: selectedSession },
        new: { sessionId: compareSession },
        format: 'html',
      })
      if (response.format === 'html') {
        downloadBlob(new Blob([response.html], { type: 'text/html' }), response.fileName)
        Toast.push('对比报告已导出', 'success')
      }
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '导出对比报告失败', 'error')
    } finally {
      setDiffLoading(false)
    }
  }, [selectedSession, compareSession])

  /** 执行 SPC 控制图分析（E5）：校验 λ 与限宽后请求 /trace/spc；序号守卫丢弃过期响应。 */
  const runSpc = useCallback(async (): Promise<void> => {
    const lambda = Number(spcLambdaInput)
    const limitWidth = Number(spcLimitInput)
    if (!Number.isFinite(lambda) || lambda < 0.05 || lambda > 0.95) {
      Toast.push('λ 需为 0.05~0.95 之间的数值', 'warning')
      return
    }
    if (!Number.isFinite(limitWidth) || limitWidth < 1 || limitWidth > 5) {
      Toast.push('控制限宽度需为 1~5 之间的数值', 'warning')
      return
    }
    const seq = ++spcSeq.current
    setSpcLoading(true)
    setSpcError('')
    try {
      const response = await fetchTraceSpc({
        from: SPC_RANGE.from,
        to: SPC_RANGE.to,
        metric: spcMetric,
        lambda,
        limitWidth,
      })
      if (mountedRef.current && seq === spcSeq.current) setSpc(response)
    } catch (err) {
      if (mountedRef.current && seq === spcSeq.current) {
        setSpcError(err instanceof Error ? err.message : 'SPC 分析失败')
      }
    } finally {
      if (mountedRef.current && seq === spcSeq.current) setSpcLoading(false)
    }
  }, [spcMetric, spcLambdaInput, spcLimitInput])

  // 挂载时按缺省参数预载一次 SPC 控制图（ref 守卫确保只执行一次）。
  useEffect(() => {
    if (spcInitRef.current) return
    spcInitRef.current = true
    void runSpc()
  }, [runSpc])

  // 时间轴节点排序：time=按开始时间，duration=按耗时降序，tokens=按 Token 降序
  const timelineNodes: readonly TraceNode[] = (() => {
    if (!analysis) return []
    const nodes = [...analysis.trace.nodes]
    if (sortMode === 'duration') nodes.sort((a, b) => b.durationMs - a.durationMs)
    else if (sortMode === 'tokens') {
      nodes.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
    }
    return nodes
  })()

  const traceSpan = analysis ? Math.max(1, analysis.trace.endedAt - analysis.trace.startedAt) : 1
  const anomalyNodeIds = new Set(analysis?.anomalies.flatMap((anomaly) => anomaly.nodeIds) ?? [])
  const anomalyByNode = new Map<string, string>()
  for (const anomaly of analysis?.anomalies ?? []) {
    for (const nodeId of anomaly.nodeIds) {
      anomalyByNode.set(nodeId, `[${anomaly.kind}] ${anomaly.reason}\n建议：${anomaly.suggestion}`)
    }
  }

  const maxDayDuration = Math.max(1, ...(stats?.days.map((day) => day.totalDurationMs) ?? [1]))

  return (
    <div className={styles.root}>
      <h2 className={styles.title}>执行轨迹分析器</h2>

      <div className={styles.toolbar}>
        <Select value={selectedSession} onChange={(event) => setSelectedSession(event.target.value)}>
          <option value="">选择要分析的会话…</option>
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.title || '未命名对话'}
            </option>
          ))}
        </Select>
        <Button variant="primary" size="sm" disabled={!selectedSession || loading} onClick={analyze}>
          {loading ? '分析中…' : '分析轨迹'}
        </Button>
      </div>

      {error.length > 0 && <div className={styles.error}>{error}</div>}
      {loading && <Spinner label="正在派生并分析执行轨迹…" />}

      {analysis && (
        <>
          {/* E4 汇总指标 */}
          <section className={styles.section}>
            <h3>汇总指标</h3>
            <div className={styles.statGrid}>
              <div className={styles.statCard}>
                <span className={styles.statValue}>{formatDuration(analysis.stats.totalDurationMs)}</span>
                <span className={styles.statLabel}>总耗时</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>
                  {analysis.stats.totalInputTokens} / {analysis.stats.totalOutputTokens}
                </span>
                <span className={styles.statLabel}>输入 / 输出 Token</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>{(analysis.stats.cacheHitRate * 100).toFixed(0)}%</span>
                <span className={styles.statLabel}>缓存命中率</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>{(analysis.stats.toolSuccessRate * 100).toFixed(0)}%</span>
                <span className={styles.statLabel}>工具成功率</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>{analysis.stats.agentDispatches}</span>
                <span className={styles.statLabel}>子 Agent 派发</span>
              </div>
            </div>
          </section>

          {/* E2 异常标注列表 */}
          {analysis.anomalies.length > 0 && (
            <section className={styles.section}>
              <h3>异常标注（{analysis.anomalies.length}）</h3>
              <ul className={styles.anomalyList}>
                {analysis.anomalies.map((anomaly, index) => (
                  <li key={index} className={styles.anomalyItem} title={anomaly.suggestion}>
                    <strong>{anomaly.kind}</strong>：{anomaly.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* E1 时间轴 */}
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h3>时间轴（{timelineNodes.length} 个节点）</h3>
              <div className={styles.sortBar}>
                <Button size="sm" variant={sortMode === 'time' ? 'primary' : 'secondary'} onClick={() => setSortMode('time')}>
                  按时间
                </Button>
                <Button size="sm" variant={sortMode === 'duration' ? 'primary' : 'secondary'} onClick={() => setSortMode('duration')}>
                  最慢优先
                </Button>
                <Button size="sm" variant={sortMode === 'tokens' ? 'primary' : 'secondary'} onClick={() => setSortMode('tokens')}>
                  最贵优先
                </Button>
              </div>
            </div>
            {timelineNodes.length === 0 ? (
              <p className={styles.empty}>该会话没有可解析的执行步骤（仅普通对话消息）。</p>
            ) : (
              <div className={styles.timeline}>
                {timelineNodes.map((node) => {
                  const left = sortMode === 'time' ? ((node.startMs - analysis.trace.startedAt) / traceSpan) * 100 : 0
                  const width = Math.max(1, (node.durationMs / traceSpan) * 100)
                  const anomalyTip = anomalyByNode.get(node.id)
                  const classNames = [
                    styles.timelineBar,
                    styles[`kind_${node.kind}`],
                    anomalyNodeIds.has(node.id) ? styles.anomaly : '',
                    node.status === 'error' ? styles.statusError : '',
                  ]
                    .filter(Boolean)
                    .join(' ')
                  return (
                    <div key={node.id} className={styles.timelineRow}>
                      <span className={styles.timelineName} title={node.name}>
                        {node.name}
                      </span>
                      <div className={styles.timelineTrack}>
                        <div
                          className={classNames}
                          style={
                            sortMode === 'time'
                              ? { left: `${left}%`, width: `${width}%` }
                              : { left: '0%', width: `${width}%` }
                          }
                          title={`${kindLabel(node.kind)} · ${formatDuration(node.durationMs)} · 输入 ${node.inputTokens} / 输出 ${node.outputTokens} tokens${node.model ? ` · ${node.model}` : ''}${node.cacheHit ? ' · 缓存命中' : ''}${anomalyTip ? `\n⚠ ${anomalyTip}` : ''}`}
                        />
                      </div>
                      <span className={styles.timelineMeta}>
                        {formatDuration(node.durationMs)} · {node.inputTokens}+{node.outputTokens}t
                        {node.cacheHit ? ' · 缓存' : ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* E3 轨迹对比 */}
          <section className={styles.section}>
            <h3>轨迹对比</h3>
            <div className={styles.toolbar}>
              <Select value={compareSession} onChange={(event) => setCompareSession(event.target.value)}>
                <option value="">选择要对比的会话（新）…</option>
                {sessions
                  .filter((session) => session.id !== selectedSession)
                  .map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.title || '未命名对话'}
                    </option>
                  ))}
              </Select>
              <Button size="sm" variant="secondary" disabled={!compareSession || diffLoading} onClick={runDiff}>
                对比
              </Button>
              <Button size="sm" variant="secondary" disabled={!compareSession || diffLoading} onClick={exportDiffHtml}>
                导出 HTML 报告
              </Button>
            </div>
            {diffEntries && (
              <table className={styles.diffTable}>
                <thead>
                  <tr>
                    <th>步骤</th>
                    <th>变化</th>
                    <th>耗时</th>
                    <th>Token</th>
                  </tr>
                </thead>
                <tbody>
                  {diffEntries.map((entry, index) => (
                    <tr key={index}>
                      <td>{entry.name}</td>
                      <td className={styles[`diff_${entry.change}`]}>
                        {entry.change === 'added' ? '新增' : entry.change === 'removed' ? '移除' : entry.change === 'changed' ? '变化' : '不变'}
                      </td>
                      <td>
                        {entry.oldDurationMs !== undefined && entry.newDurationMs !== undefined
                          ? `${formatDuration(entry.oldDurationMs)} → ${formatDuration(entry.newDurationMs)}（${(entry.durationDeltaMs ?? 0) >= 0 ? '+' : ''}${entry.durationDeltaMs ?? 0}ms）`
                          : entry.oldDurationMs !== undefined
                            ? formatDuration(entry.oldDurationMs)
                            : entry.newDurationMs !== undefined
                              ? formatDuration(entry.newDurationMs)
                              : '-'}
                      </td>
                      <td>
                        {entry.tokenDelta !== undefined
                          ? `${entry.oldTokens ?? '-'} → ${entry.newTokens ?? '-'}（${entry.tokenDelta >= 0 ? '+' : ''}${entry.tokenDelta}）`
                          : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {/* E4 趋势图 */}
      {stats && stats.days.length > 0 && (
        <section className={styles.section}>
          <h3>近 14 天趋势</h3>
          <div className={styles.trend}>
            {stats.days.map((day) => (
              <div key={day.day} className={styles.trendCol} title={`${day.day}：${day.traceCount} 条轨迹，总耗时 ${formatDuration(day.totalDurationMs)}，异常 ${day.anomalyCount} 项`}>
                <div
                  className={styles.trendBar}
                  style={{ height: `${Math.max(4, (day.totalDurationMs / maxDayDuration) * 100)}%` }}
                />
                <span className={styles.trendLabel}>{day.day.slice(5)}</span>
              </div>
            ))}
          </div>
          {stats.baseline && (
            <p className={styles.baseline}>
              历史基准：平均耗时 {formatDuration(stats.baseline.avgDurationMs)} · 平均 Token{' '}
              {Math.round(stats.baseline.avgTokens)} · 平均异常 {stats.baseline.avgAnomalies} 项/轨迹
            </p>
          )}
        </section>
      )}

      {/* E5 SPC 控制图：EWMA + Western Electric 规则的漂移检测 */}
      <section className={styles.section}>
        <h3>SPC 控制图</h3>
        <div className={styles.toolbar}>
          <Select value={spcMetric} onChange={(event) => setSpcMetric(event.target.value as SpcMetric)}>
            {SPC_METRIC_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <label className={styles.spcField}>
            λ（0.05~0.95）
            <Input
              className={styles.spcInput}
              type="number"
              value={spcLambdaInput}
              onChange={(event) => setSpcLambdaInput(event.target.value)}
              placeholder="0.3"
            />
          </label>
          <label className={styles.spcField}>
            限宽（1~5σ）
            <Input
              className={styles.spcInput}
              type="number"
              value={spcLimitInput}
              onChange={(event) => setSpcLimitInput(event.target.value)}
              placeholder="3"
            />
          </label>
          <Button variant="primary" size="sm" disabled={spcLoading} onClick={() => void runSpc()}>
            {spcLoading ? '分析中…' : '分析'}
          </Button>
        </div>
        <p className={styles.spcHint}>
          λ 越小对缓慢漂移越灵敏；控制限基于全量历史估计，图表仅显示查询区间（近 {SPC_RANGE_DAYS} 天）。
        </p>
        {spcError.length > 0 && <div className={styles.error}>{spcError}</div>}
        {spcLoading ? (
          <Spinner label="SPC 分析中…" />
        ) : spc ? (
          spc.sampleDays < 5 ? (
            <p className={styles.empty}>有效样本不足 5 天，继续积累后可用</p>
          ) : (
            <>
              {/* 判级横幅：受控/轻微异常/失控 + 漂移说明 + EWMA 斜率 */}
              <div className={`${styles.spcBanner} ${SPC_VERDICT_META[spc.verdict].banner}`}>
                <Pill className={SPC_VERDICT_META[spc.verdict].badge}>{SPC_VERDICT_META[spc.verdict].text}</Pill>
                <span className={styles.spcDetail}>{spc.drift.detail}</span>
                <span className={styles.spcRate}>
                  EWMA 斜率 {spc.driftRatePerDay > 0 ? '+' : ''}
                  {spc.driftRatePerDay.toFixed(4)}/天
                  {spc.driftRatePerDay > 0 ? '（恶化）' : spc.driftRatePerDay < 0 ? '（改善）' : ''}
                </span>
              </div>
              {/* 中心线 / σ / 样本天数 */}
              <p className={styles.spcStats}>
                中心线 {formatSpcValue(spc.metric, spc.center)} · σ {formatSpcValue(spc.metric, spc.sigma)} · 样本{' '}
                {spc.sampleDays} 天
              </p>
              {spc.points.length === 0 ? (
                <p className={styles.empty}>查询区间内暂无数据</p>
              ) : (
                <>
                  <div className={styles.spcChartWrap}>
                    <SpcChart points={spc.points} center={spc.center} metric={spc.metric} />
                  </div>
                  <div className={styles.spcLegend}>
                    <span>
                      <i className={`${styles.spcLegendDot} ${styles.spcLegendValue}`} />
                      原始值
                    </span>
                    <span>
                      <i className={`${styles.spcLegendDot} ${styles.spcLegendEwma}`} />
                      EWMA
                    </span>
                    <span>
                      <i className={`${styles.spcLegendDot} ${styles.spcLegendLimit}`} />
                      上/下控制限
                    </span>
                    <span>
                      <i className={`${styles.spcLegendDot} ${styles.spcLegendCenter}`} />
                      中心线
                    </span>
                    <span>
                      <i className={`${styles.spcLegendDot} ${styles.spcLegendViolation}`} />
                      越限点（红=劣化侧，橙=改善侧）
                    </span>
                  </div>
                </>
              )}
            </>
          )
        ) : null}
      </section>
    </div>
  )
}
