/**
 * 多模型竞技场视图页（模块 G 客户端 UI，挂载于 conversation.view）：
 * - G1 并行对比：输入 Prompt 勾选模型（最多 5 个），表格并排展示输出/耗时/Token/费用；
 * - G2 批量评测排行榜：导入 JSON/JSONL 测试集，跑完整评测并导出 MD/HTML 报告；
 * - G3 模型推荐：任务类型 + 预算 + 延迟要求 → 推荐排序与理由；
 * - 金丝雀漂移监控：确定性探针比对基线，延迟/通过率/长度/风格四维度漂移检测与基线重置；
 * - 外部厂商 Key 管理（加密保存，不回传明文）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Checkbox, Input, Pill, Select, Spinner, Textarea, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  addArenaCustomModel,
  downloadBlob,
  fetchArenaModels,
  fetchArenaRecommendation,
  fetchCanaryOverview,
  fetchCanaryReport,
  removeArenaCustomModel,
  removeArenaKey,
  resetCanaryBaseline,
  runArenaCompare,
  runArenaLeaderboard,
  runCanaryProbes,
  saveArenaKey,
} from '../api.js'
import type {
  ArenaLeaderboardRow,
  ArenaModelInfo,
  ArenaRecommendation,
  ArenaRunResult,
  CanaryModelReport,
  CanaryOverviewResponse,
  DriftDimension,
  DriftReport,
} from '../api.js'
import styles from './ModelArenaView.module.css'

/** 组件 props。 */
export interface ModelArenaViewProps {
  readonly sessionId?: string
}

/**
 * 全模型峰谷感知徽标：
 * - 高峰时段且有峰谷分时价的模型 → 标注"高峰价"；
 * - 空闲时段且有峰谷分时价的模型 → 标注"空闲价"；
 * - 无峰谷分时价的模型 → 不显示徽标（全天统一价，价格不被篡改）。
 */
function peakBadge(model: ArenaModelInfo): string {
  const status = model.peakStatus
  if (status === undefined || !status.hasPeakPricing) return ''
  return status.isPeak ? '（高峰价）' : '（空闲价）'
}

/** 漂移判定级别（报告级 verdict 与维度级 level 共用）。 */
type DriftLevel = DriftReport['verdict']

/** 漂移概览行（全部受监控模型摘要）。 */
type CanaryOverviewRow = CanaryOverviewResponse['models'][number]

/** 漂移级别 → 中文标签与 Pill 配色类（stable=绿 / warning=黄 / drifted=红）。 */
const DRIFT_LEVEL_META: Readonly<Record<DriftLevel, { label: string; cls: string }>> = {
  stable: { label: '稳定', cls: styles.driftPillStable },
  warning: { label: '预警', cls: styles.driftPillWarning },
  drifted: { label: '漂移', cls: styles.driftPillDrifted },
}

/** 漂移维度 → 中文名。 */
const DRIFT_DIMENSION_LABELS: Readonly<Record<DriftDimension['name'], string>> = {
  latency: '延迟分布',
  'pass-rate': '通过率',
  length: '输出长度',
  style: '风格指纹',
}

/** 格式化毫秒时间戳（本地时区、24 小时制）。 */
function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** 子面板页签。 */
type Tab = 'compare' | 'leaderboard' | 'recommend' | 'drift' | 'keys'

/** 多模型竞技场视图页。 */
export function ModelArenaView(_props: ModelArenaViewProps): ReactElement {
  const [tab, setTab] = useState<Tab>('compare')
  const [models, setModels] = useState<readonly ArenaModelInfo[]>([])

  const reloadModels = useCallback(() => {
    fetchArenaModels()
      .then((response) => setModels(response.models))
      .catch((err: unknown) => Toast.push(err instanceof Error ? err.message : '加载模型目录失败', 'error'))
  }, [])

  useEffect(() => {
    reloadModels()
  }, [reloadModels])

  return (
    <div className={styles.root}>
      <h2 className={styles.title}>多模型竞技场</h2>
      <div className={styles.tabs}>
        <Button size="sm" variant={tab === 'compare' ? 'primary' : 'secondary'} onClick={() => setTab('compare')}>
          并行对比
        </Button>
        <Button size="sm" variant={tab === 'leaderboard' ? 'primary' : 'secondary'} onClick={() => setTab('leaderboard')}>
          评测排行榜
        </Button>
        <Button size="sm" variant={tab === 'recommend' ? 'primary' : 'secondary'} onClick={() => setTab('recommend')}>
          模型推荐
        </Button>
        <Button size="sm" variant={tab === 'drift' ? 'primary' : 'secondary'} onClick={() => setTab('drift')}>
          漂移监控
        </Button>
        <Button size="sm" variant={tab === 'keys' ? 'primary' : 'secondary'} onClick={() => setTab('keys')}>
          模型与 Key 管理
        </Button>
      </div>
      {tab === 'compare' && <ComparePanel models={models} />}
      {tab === 'leaderboard' && <LeaderboardPanel models={models} />}
      {tab === 'recommend' && <RecommendPanel />}
      {tab === 'drift' && <DriftPanel models={models} />}
      {tab === 'keys' && <KeysPanel models={models} onChanged={reloadModels} />}
    </div>
  )
}

/** 模型多选（最多 5 个）。 */
function useModelSelection(models: readonly ArenaModelInfo[]): {
  selected: ReadonlySet<string>
  toggle: (id: string) => void
} {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const toggle = useCallback(
    (id: string) => {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(id)) {
          next.delete(id)
        } else {
          if (next.size >= 5) {
            Toast.push('最多同时选择 5 个模型', 'warning')
            return prev
          }
          next.add(id)
        }
        return next
      })
    },
    [],
  )
  void models
  return { selected, toggle }
}

/** G1：并行对比面板。 */
function ComparePanel(props: { models: readonly ArenaModelInfo[] }): ReactElement {
  const { models } = props
  const { selected, toggle } = useModelSelection(models)
  const [prompt, setPrompt] = useState('')
  const [results, setResults] = useState<readonly ArenaRunResult[]>([])
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    if (!prompt.trim() || selected.size === 0) return
    setBusy(true)
    setResults([])
    try {
      const response = await runArenaCompare({ prompt, models: [...selected] }, { timeoutMs: 300_000 })
      setResults(response.results)
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '对比失败', 'error')
    } finally {
      setBusy(false)
    }
  }, [prompt, selected])

  return (
    <section className={styles.section}>
      <h3>模型选择（最多 5 个）</h3>
      <div className={styles.modelGrid}>
        {models.map((model) => (
          <label key={model.id} className={styles.modelOption}>
            <Checkbox
              checked={selected.has(model.id)}
              label={`${model.label}${peakBadge(model)}${model.provider === 'external' && !model.keyConfigured ? '（未配置 Key）' : ''}`}
              onChange={() => toggle(model.id)}
            />
          </label>
        ))}
      </div>
      <h3>Prompt</h3>
      <Textarea value={prompt} rows={4} placeholder="输入要对比的 Prompt…" onChange={(event) => setPrompt(event.target.value)} />
      <div className={styles.row}>
        <Button variant="primary" size="sm" disabled={busy || !prompt.trim() || selected.size === 0} onClick={run}>
          {busy ? '对比中…' : '并行对比'}
        </Button>
      </div>
      {busy && <Spinner label="正在并行调用多个模型…" />}

      {results.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>模型</th>
              <th>耗时</th>
              <th>Token（输入/输出）</th>
              <th>费用</th>
              <th>输出</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => (
              <tr key={result.model}>
                <td>{result.model}</td>
                <td>{result.ok ? `${result.latencyMs}ms` : '失败'}</td>
                <td>{result.ok ? `${result.promptTokens}/${result.completionTokens}` : '-'}</td>
                <td>{result.ok ? `¥${result.costCny.toFixed(4)}` : '-'}</td>
                <td>
                  <pre className={styles.outputCell}>{result.ok ? result.output : result.error}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** G2：评测排行榜面板。 */
function LeaderboardPanel(props: { models: readonly ArenaModelInfo[] }): ReactElement {
  const { models } = props
  const { selected, toggle } = useModelSelection(models)
  const [casesText, setCasesText] = useState('')
  const [rows, setRows] = useState<readonly ArenaLeaderboardRow[]>([])
  const [busy, setBusy] = useState(false)

  /** 运行评测（format 缺省返回 json 并渲染表格）。 */
  const run = useCallback(async () => {
    if (selected.size === 0 || !casesText.trim()) return
    setBusy(true)
    try {
      const response = await runArenaLeaderboard(
        { models: [...selected], cases: casesText },
        { timeoutMs: 600_000 },
      )
      if (response.format === 'json') {
        setRows(response.rows)
      }
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '评测失败', 'error')
    } finally {
      setBusy(false)
    }
  }, [selected, casesText])

  /** 导出报告：复用服务端缓存的最近评测结果，不重跑评测。 */
  const exportReport = useCallback(
    async (format: 'markdown' | 'html') => {
      setBusy(true)
      try {
        const response = await runArenaLeaderboard({ format, useCache: true }, { timeoutMs: 60_000 })
        if (response.format === 'markdown' || response.format === 'html') {
          const mime = response.format === 'html' ? 'text/html' : 'text/markdown'
          downloadBlob(new Blob([response.content], { type: mime }), response.fileName)
          Toast.push('评测报告已导出', 'success')
        }
      } catch (err) {
        Toast.push(err instanceof Error ? err.message : '导出失败', 'error')
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  return (
    <section className={styles.section}>
      <h3>模型选择（最多 5 个）</h3>
      <div className={styles.modelGrid}>
        {models.map((model) => (
          <label key={model.id} className={styles.modelOption}>
            <Checkbox
              checked={selected.has(model.id)}
              label={`${model.label}${peakBadge(model)}`}
              onChange={() => toggle(model.id)}
            />
          </label>
        ))}
      </div>
      <h3>测试集（JSONL：每行一个 JSON 对象，字段 input / expected / judge）</h3>
      <Textarea
        value={casesText}
        rows={6}
        placeholder={'{"input": "1+1=?", "expected": "2", "judge": "contains"}\n{"input": "翻译 hello"}'}
        onChange={(event) => setCasesText(event.target.value)}
      />
      <div className={styles.row}>
        <Button variant="primary" size="sm" disabled={busy || selected.size === 0 || !casesText.trim()} onClick={() => void run()}>
          {busy ? '评测中…' : '运行评测'}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy || rows.length === 0} onClick={() => void exportReport('markdown')}>
          导出 Markdown
        </Button>
        <Button size="sm" variant="secondary" disabled={busy || rows.length === 0} onClick={() => void exportReport('html')}>
          导出 HTML
        </Button>
      </div>
      {busy && <Spinner label="正在跑完整评测（可能耗时较长）…" />}

      {rows.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>排名</th>
              <th>模型</th>
              <th>综合得分</th>
              <th>成功率</th>
              <th>准确率</th>
              <th>P50/P95/P99</th>
              <th>平均Token</th>
              <th>单任务成本</th>
              <th>合规率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.model}>
                <td>{index + 1}</td>
                <td>{row.model}</td>
                <td>{row.compositeScore.toFixed(3)}</td>
                <td>{(row.successRate * 100).toFixed(0)}%</td>
                <td>{row.accuracy === null ? 'N/A' : `${(row.accuracy * 100).toFixed(0)}%`}</td>
                <td>{`${row.p50Ms}/${row.p95Ms}/${row.p99Ms}ms`}</td>
                <td>{row.avgTokens}</td>
                <td>{`¥${row.costPerTaskCny.toFixed(4)}`}</td>
                <td>{row.complianceRate === null ? 'N/A' : `${(row.complianceRate * 100).toFixed(0)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** G3：模型推荐面板。 */
function RecommendPanel(): ReactElement {
  const [taskType, setTaskType] = useState('code')
  const [budget, setBudget] = useState('')
  const [latency, setLatency] = useState('any')
  const [recommendations, setRecommendations] = useState<readonly ArenaRecommendation[]>([])
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    // 预算输入校验：非空时必须是合法非负数字，避免 NaN 经 JSON 变 null 发给服务端。
    let budgetPerCallCny: number | undefined
    if (budget.trim() !== '') {
      const parsed = Number(budget)
      if (!Number.isFinite(parsed) || parsed < 0) {
        Toast.push('单次预算必须是非负数字', 'warning')
        return
      }
      budgetPerCallCny = parsed
    }
    setBusy(true)
    try {
      const response = await fetchArenaRecommendation({
        taskType,
        budgetPerCallCny,
        latency,
      })
      setRecommendations(response.recommendations)
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '推荐失败', 'error')
    } finally {
      setBusy(false)
    }
  }, [taskType, budget, latency])

  return (
    <section className={styles.section}>
      <div className={styles.row}>
        <Select value={taskType} onChange={(event) => setTaskType(event.target.value)}>
          <option value="code">代码生成</option>
          <option value="translation">翻译</option>
          <option value="summarization">摘要</option>
          <option value="reasoning">推理</option>
          <option value="general">通用</option>
        </Select>
        <Input value={budget} type="number" placeholder="单次预算上限（元，可留空）" onChange={(event) => setBudget(event.target.value)} />
        <Select value={latency} onChange={(event) => setLatency(event.target.value)}>
          <option value="any">延迟不限</option>
          <option value="fast">尽量快</option>
          <option value="balanced">均衡</option>
        </Select>
        <Button variant="primary" size="sm" disabled={busy} onClick={run}>
          获取推荐
        </Button>
      </div>
      {busy && <Spinner label="正在计算推荐…" />}
      {recommendations.length > 0 && (
        <ol className={styles.recList}>
          {recommendations.map((rec, index) => (
            <li key={rec.model} className={styles.recItem}>
              <div className={styles.recHeader}>
                <strong>
                  #{index + 1} {rec.label}
                </strong>
                <span className={styles.recScore}>得分 {rec.score.toFixed(3)}</span>
                {rec.estimatedCostCny > 0 && <span className={styles.recCost}>估算 ¥{rec.estimatedCostCny.toFixed(4)}/次</span>}
              </div>
              <p className={styles.recReason}>{rec.reason}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** 外部厂商 Key 与自定义模型管理面板。 */
function KeysPanel(props: { models: readonly ArenaModelInfo[]; onChanged: () => void }): ReactElement {
  const { models, onChanged } = props
  const [editing, setEditing] = useState<string | undefined>()
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [customId, setCustomId] = useState('')
  const [customLabel, setCustomLabel] = useState('')
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [customLatency, setCustomLatency] = useState('balanced')

  const save = useCallback(async () => {
    if (!editing || !apiKey.trim()) return
    try {
      await saveArenaKey({ modelId: editing, apiKey, baseUrl: baseUrl || undefined })
      Toast.push('Key 已加密保存', 'success')
      setEditing(undefined)
      setApiKey('')
      setBaseUrl('')
      onChanged()
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '保存失败', 'error')
    }
  }, [editing, apiKey, baseUrl, onChanged])

  const remove = useCallback(
    async (modelId: string) => {
      try {
        await removeArenaKey(modelId)
        Toast.push('Key 已删除', 'success')
        onChanged()
      } catch (err) {
        Toast.push(err instanceof Error ? err.message : '删除失败', 'error')
      }
    },
    [onChanged],
  )

  /** 添加自定义模型（前端先做基础校验，服务端再做冲突与格式校验）。 */
  const addCustom = useCallback(async () => {
    if (!customId.trim() || !customLabel.trim() || !customBaseUrl.trim()) return
    if (!/^https?:\/\//i.test(customBaseUrl.trim())) {
      Toast.push('API 基址必须以 http:// 或 https:// 开头', 'warning')
      return
    }
    try {
      await addArenaCustomModel({
        modelId: customId.trim(),
        label: customLabel.trim(),
        baseUrl: customBaseUrl.trim(),
        latencyTier: customLatency as 'fast' | 'balanced' | 'slow',
      })
      Toast.push('自定义模型已添加，请为其配置 API Key', 'success')
      setAdding(false)
      setCustomId('')
      setCustomLabel('')
      setCustomBaseUrl('')
      setCustomLatency('balanced')
      onChanged()
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '添加失败', 'error')
    }
  }, [customId, customLabel, customBaseUrl, customLatency, onChanged])

  const removeCustom = useCallback(
    async (modelId: string) => {
      try {
        await removeArenaCustomModel(modelId)
        Toast.push('自定义模型已删除', 'success')
        onChanged()
      } catch (err) {
        Toast.push(err instanceof Error ? err.message : '删除失败', 'error')
      }
    },
    [onChanged],
  )

  return (
    <section className={styles.section}>
      <p className={styles.hint}>
        外部厂商 Key 以 AES-256-GCM 加密保存在本地保险库，任何接口不回传明文。自定义模型走 OpenAI 兼容
        chat/completions 协议，模型 id 若与价格目录一致可自动估算成本。厂商官方定价页实时抓取的新模型
        会自动出现在目录中，无需手工维护。
      </p>
      <div className={styles.row}>
        <Button size="sm" variant="primary" onClick={() => setAdding((prev) => !prev)}>
          {adding ? '收起' : '添加自定义模型'}
        </Button>
      </div>
      {adding && (
        <div className={styles.keyForm}>
          <Input value={customId} placeholder="模型 id（API 调用的 model 参数，如 glm-5.2）" onChange={(event) => setCustomId(event.target.value)} />
          <Input value={customLabel} placeholder="展示名称（如 智谱 GLM-5.2）" onChange={(event) => setCustomLabel(event.target.value)} />
          <Input value={customBaseUrl} placeholder="API 基址（如 https://open.bigmodel.cn/api/paas/v4）" onChange={(event) => setCustomBaseUrl(event.target.value)} />
          <div className={styles.row}>
            <Select value={customLatency} onChange={(event) => setCustomLatency(event.target.value)}>
              <option value="fast">延迟档位：快</option>
              <option value="balanced">延迟档位：均衡</option>
              <option value="slow">延迟档位：慢</option>
            </Select>
            <Button size="sm" variant="primary" disabled={!customId.trim() || !customLabel.trim() || !customBaseUrl.trim()} onClick={addCustom}>
              保存模型
            </Button>
          </div>
        </div>
      )}
      {models
        .filter((model) => model.provider === 'external')
        .map((model) => (
          <div key={model.id} className={styles.keyRow}>
            <div className={styles.keyInfo}>
              <strong>{model.label}</strong>
              {model.custom && <span className={styles.keyMissing}>自定义</span>}
              <span className={model.keyConfigured ? styles.keyOk : styles.keyMissing}>
                {model.keyConfigured ? '已配置' : '未配置'}
              </span>
            </div>
            {editing === model.id ? (
              <div className={styles.keyForm}>
                <Input value={apiKey} type="password" placeholder="API Key" onChange={(event) => setApiKey(event.target.value)} />
                <Input value={baseUrl} placeholder={`API 基址（缺省 ${model.id} 官方）`} onChange={(event) => setBaseUrl(event.target.value)} />
                <div className={styles.row}>
                  <Button size="sm" variant="primary" disabled={!apiKey.trim()} onClick={save}>
                    保存
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(undefined)}>
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <div className={styles.row}>
                <Button size="sm" variant="secondary" onClick={() => setEditing(model.id)}>
                  {model.keyConfigured ? '更换 Key' : '配置 Key'}
                </Button>
                {model.custom && (
                  <Button size="sm" variant="danger" onClick={() => removeCustom(model.id)}>
                    删除模型
                  </Button>
                )}
                {model.keyConfigured && !model.custom && (
                  <Button size="sm" variant="danger" onClick={() => remove(model.id)}>
                    删除
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
    </section>
  )
}

/** 金丝雀漂移监控面板：勾选模型运行确定性探针组，四维度比对基线检测漂移。 */
function DriftPanel(props: { models: readonly ArenaModelInfo[] }): ReactElement {
  const { models } = props
  // 模型目录：优先复用视图级目录（挂载时已就绪则直接用），否则自行拉取兜底。
  const [ownModels, setOwnModels] = useState<readonly ArenaModelInfo[]>([])
  const catalog = models.length > 0 ? models : ownModels
  const { selected, toggle } = useModelSelection(catalog)

  const [overview, setOverview] = useState<readonly CanaryOverviewRow[]>([])
  const [detail, setDetail] = useState<CanaryModelReport | undefined>()
  const [runReports, setRunReports] = useState<readonly DriftReport[]>([])
  const [busy, setBusy] = useState(false)

  /** 模型目录兜底拉取（仅当视图级目录为空时）。 */
  useEffect(() => {
    if (models.length > 0) return
    fetchArenaModels()
      .then((response) => setOwnModels(response.models))
      .catch((err: unknown) => Toast.push(err instanceof Error ? err.message : '加载模型目录失败', 'error'))
  }, [models])

  /** 加载全部受监控模型概览。 */
  const loadOverview = useCallback(() => {
    fetchCanaryOverview()
      .then((response) => setOverview(response.models))
      .catch((err: unknown) => Toast.push(err instanceof Error ? err.message : '加载漂移概览失败', 'error'))
  }, [])

  useEffect(() => {
    loadOverview()
  }, [loadOverview])

  /** 运行探针并比对基线（探针组逐条串行调用，给长超时）。 */
  const run = useCallback(async () => {
    if (selected.size === 0) return
    setBusy(true)
    setRunReports([])
    try {
      const response = await runCanaryProbes({ models: [...selected] }, { timeoutMs: 120_000 })
      setRunReports(response.reports)
      loadOverview()
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '探针运行失败', 'error')
    } finally {
      setBusy(false)
    }
  }, [selected, loadOverview])

  /** 展开单模型漂移详情（只读报告，不发起任何调用）。 */
  const openDetail = useCallback(async (model: string) => {
    try {
      const response = await fetchCanaryReport(model)
      setDetail(response)
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '加载漂移详情失败', 'error')
    }
  }, [])

  /** 重置基线（确认厂商更新模型后重新锚定）。 */
  const resetBaseline = useCallback(
    async (model: string) => {
      if (!window.confirm(`确认重置 ${model} 的漂移基线？历史比对将清空，下次运行探针重新锚定。`)) return
      try {
        const response = await resetCanaryBaseline({ model })
        Toast.push(response.hint, 'success')
        setDetail((prev) => (prev?.model === model ? undefined : prev))
        loadOverview()
      } catch (err) {
        Toast.push(err instanceof Error ? err.message : '重置基线失败', 'error')
      }
    },
    [loadOverview],
  )

  return (
    <section className={styles.section}>
      <p className={styles.hint}>
        探针为确定性调用，首次运行建立基线，之后累积历史比对；确认厂商更新模型后可重置基线重新锚定。
      </p>
      <h3>模型选择（最多 5 个）</h3>
      <div className={styles.modelGrid}>
        {catalog.map((model) => (
          <label key={model.id} className={styles.modelOption}>
            <Checkbox
              checked={selected.has(model.id)}
              label={`${model.label}${model.provider === 'external' ? (model.keyConfigured ? '（Key 已配置）' : '（未配置 Key）') : ''}`}
              onChange={() => toggle(model.id)}
            />
          </label>
        ))}
      </div>
      <div className={styles.row}>
        <Button variant="primary" size="sm" disabled={busy || selected.size === 0} onClick={() => void run()}>
          {busy ? '探针运行中…' : '运行探针并比对基线'}
        </Button>
      </div>
      {busy && <Spinner label="正在运行确定性探针组并比对基线…" />}

      {runReports.length > 0 && (
        <>
          <h3>本轮探针报告</h3>
          {runReports.map((report) => (
            <DriftReportDetail key={report.model} report={report} />
          ))}
        </>
      )}

      <h3>受监控模型概览（{overview.length}）</h3>
      {overview.length === 0 ? (
        <p className={styles.hint}>尚无监控数据：先勾选模型运行一次探针建立基线。</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>模型</th>
              <th>基线锚点</th>
              <th>历史运行</th>
              <th>判定</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {overview.map((row) => (
              <tr
                key={row.model}
                className={styles.driftRow}
                title="点击查看漂移详情"
                onClick={() => void openDetail(row.model)}
              >
                <td>{row.model}</td>
                <td>{formatTimestamp(row.baselineTs)}</td>
                <td>{row.historyRuns} 次</td>
                <td>
                  <DriftLevelPill level={row.verdict} />
                </td>
                {/* 操作列阻止冒泡，避免按钮点击重复触发行点击。 */}
                <td onClick={(event) => event.stopPropagation()}>
                  <div className={styles.row}>
                    <Button size="sm" variant="secondary" onClick={() => void openDetail(row.model)}>
                      查看详情
                    </Button>
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void resetBaseline(row.model)}>
                      重置基线
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail && (
        <>
          <div className={styles.driftDetailHeader}>
            <h3>{detail.model} · 漂移详情</h3>
            <Button size="sm" variant="ghost" onClick={() => setDetail(undefined)}>
              收起
            </Button>
          </div>
          <p className={styles.driftMeta}>
            基线锚点 {formatTimestamp(detail.baselineTs)} · 历史运行 {detail.historyRuns} 次 · 探针组：
            {detail.probes.join('、')}
          </p>
          <DriftReportDetail report={detail.report} />
        </>
      )}
    </section>
  )
}

/** 漂移级别 Pill（稳定=绿 / 预警=黄 / 漂移=红）。 */
function DriftLevelPill(props: { level: DriftLevel }): ReactElement {
  const meta = DRIFT_LEVEL_META[props.level]
  return <Pill className={meta.cls}>{meta.label}</Pill>
}

/** 单份漂移报告详情：四维度统计表（统计量/阈值/判定/说明）+ 汇总结论。 */
function DriftReportDetail(props: { report: DriftReport }): ReactElement {
  const { report } = props
  return (
    <div className={styles.driftDetail}>
      <div className={styles.driftDetailHeader}>
        <strong>{report.model}</strong>
        <DriftLevelPill level={report.verdict} />
        <span className={styles.driftMeta}>
          基线锚点 {formatTimestamp(report.baselineTs)} · 已比对 {report.runsCompared} 次
        </span>
      </div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>维度</th>
            <th>统计量</th>
            <th>漂移阈值</th>
            <th>判定</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {report.dimensions.map((dimension) => (
            <tr key={dimension.name}>
              <td>{DRIFT_DIMENSION_LABELS[dimension.name]}</td>
              <td>{dimension.statistic}</td>
              <td>{dimension.threshold}</td>
              <td>
                <DriftLevelPill level={dimension.level} />
              </td>
              <td>{dimension.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.driftSummary}>{report.summary}</p>
    </div>
  )
}
