/**
 * 交接摘要对话框（模块 B 客户端 UI）：
 * - 两种模式：「自由文本」POST /handoff/generate 生成可编辑摘要；
 *   「结构化分级」POST /handoff/structured 生成四级分层交接文档
 *   （锚定/进行中/参考/归档 + 锚定强制继承守门 + 世系链溯源）；
 * - 结果置于可编辑 Textarea，可复制到剪贴板、保存为模板、作为新对话起点武装；
 * - 模板列表支持载入与删除；加载与错误态齐全。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  Input,
  Modal,
  Spinner,
  Textarea,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  deleteHandoffTemplate,
  fetchHandoffLineage,
  fetchHandoffTemplates,
  generateHandoff,
  importHandoff,
  saveHandoffTemplate,
  traceHandoffLineage,
} from '../api.js'
import type { HandoffTemplate, LineageSummary, LineageTraceResponse } from '../api.js'
import { generateStructuredHandoff } from '../api.js'
import type { StructuredHandoffResponse } from '../api.js'
import styles from './HandoffDialog.module.css'

/** 组件 props：sessionId 由 slot 的 inject 注入。 */
export interface HandoffDialogProps {
  /** 当前会话 id；存在时打开对话框自动生成摘要。 */
  readonly sessionId?: string
  readonly open: boolean
  readonly onClose: () => void
}

/** 交接模式：自由文本摘要 / 结构化分级交接。 */
type HandoffMode = 'text' | 'structured'

/** 毫秒时间戳 → 本地可读日期时间。 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** 交接摘要对话框：生成/编辑摘要 + 模板管理 + 武装到新对话。 */
export function HandoffDialog(props: HandoffDialogProps): ReactElement {
  /** 当前会话 id（const 局部量，便于在回调中保持类型收窄）。 */
  const sessionId = props.sessionId
  const [mode, setMode] = useState<HandoffMode>('text')
  const [summary, setSummary] = useState('')
  const [model, setModel] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState('')
  const [templates, setTemplates] = useState<readonly HandoffTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templatesError, setTemplatesError] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [importing, setImporting] = useState(false)
  const [deletingName, setDeletingName] = useState<string | null>(null)

  /** 脏标记：用户一旦手动编辑过摘要，后续（慢）生成结果返回时不再覆盖内容。 */
  const dirtyRef = useRef(false)

  /** 手动重试的 AbortController：卸载时中止在途请求，避免对已卸载组件 setState。 */
  const manualAbortRef = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      manualAbortRef.current?.abort()
    },
    [],
  )

  /** 调用服务端为指定会话生成交接摘要。
   *
   * - signal 被中止或 isCancelled 为真（卸载 / sessionId 变化）时静默返回，不再更新任何状态；
   * - 用户已手动编辑过内容（dirtyRef）时，返回的摘要不再覆盖编辑区。
   */
  const generate = useCallback(
    async (targetSessionId: string, signal?: AbortSignal, isCancelled?: () => boolean): Promise<void> => {
      /** 统一取消判定：外部 cancelled 守卫或中止信号任一生效即视为已取消。 */
      const cancelled = (): boolean => (signal?.aborted ?? false) || (isCancelled?.() ?? false)
      setGenerating(true)
      setGenerateError('')
      try {
        const result = await generateHandoff({ sessionId: targetSessionId }, { signal })
        if (cancelled()) return
        if (!dirtyRef.current) {
          setSummary(result.summary)
        }
        setModel(result.model)
      } catch (error) {
        if (cancelled()) return
        setGenerateError(error instanceof Error ? error.message : '交接摘要生成失败')
      } finally {
        if (!cancelled()) setGenerating(false)
      }
    },
    [],
  )

  /** 手动重试生成（错误行的「重试」按钮）：与自动路径同样受 AbortController 保护。 */
  const handleRetry = useCallback((): void => {
    if (!sessionId) return
    manualAbortRef.current?.abort()
    const controller = new AbortController()
    manualAbortRef.current = controller
    void generate(sessionId, controller.signal, () => controller.signal.aborted)
  }, [sessionId, generate])

  /** 拉取模板列表。 */
  const loadTemplates = useCallback(async (): Promise<void> => {
    setTemplatesLoading(true)
    setTemplatesError('')
    try {
      const response = await fetchHandoffTemplates()
      setTemplates(response.templates)
    } catch (error) {
      setTemplatesError(error instanceof Error ? error.message : '模板列表加载失败')
    } finally {
      setTemplatesLoading(false)
    }
  }, [])

  // 打开对话框：刷新模板列表；有 sessionId 时自动生成交接摘要。
  // 摘要生成可能较慢：以 AbortController + cancelled 守卫，卸载 / sessionId 变化时取消在途请求，
  // 避免过期响应覆盖新会话的状态；每次重新打开（或切换会话）时重置脏标记。
  useEffect(() => {
    if (!props.open) return
    const controller = new AbortController()
    let cancelled = false
    void loadTemplates()
    if (sessionId) {
      dirtyRef.current = false
      void generate(sessionId, controller.signal, () => cancelled)
    }
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [props.open, sessionId, loadTemplates, generate])

  /** 复制当前摘要到剪贴板。 */
  const handleCopy = useCallback(async (): Promise<void> => {
    if (!summary.trim()) {
      Toast.push('没有可复制的内容', 'warning')
      return
    }
    try {
      await navigator.clipboard.writeText(summary)
      Toast.push('已复制到剪贴板', 'success')
    } catch {
      Toast.push('复制失败：浏览器未授权剪贴板访问', 'error')
    }
  }, [summary])

  /** 以输入的名称保存当前摘要为模板。 */
  const handleSaveTemplate = useCallback(async (): Promise<void> => {
    const name = templateName.trim()
    if (!name) {
      Toast.push('请输入模板名称', 'warning')
      return
    }
    if (!summary.trim()) {
      Toast.push('摘要内容为空，无法保存模板', 'warning')
      return
    }
    setSavingTemplate(true)
    try {
      await saveHandoffTemplate({ name, content: summary })
      Toast.push(`模板「${name}」已保存`, 'success')
      setTemplateName('')
      await loadTemplates()
    } catch (error) {
      Toast.push(error instanceof Error ? error.message : '模板保存失败', 'error')
    } finally {
      setSavingTemplate(false)
    }
  }, [templateName, summary, loadTemplates])

  /** 将当前摘要作为新对话起点：不带 sessionId 导入 = 武装给下一个新对话。
   *
   * 武装成功后派发 `companion:armed-changed` 自定义事件，供 dock（ImportSummaryDock）刷新武装状态。
   */
  const handleImport = useCallback(async (): Promise<void> => {
    if (!summary.trim()) {
      Toast.push('摘要内容为空，无法武装到新对话', 'warning')
      return
    }
    setImporting(true)
    try {
      await importHandoff({ summary })
      window.dispatchEvent(new CustomEvent('companion:armed-changed'))
      Toast.push('已武装给下一个新对话，新建对话时将自动注入该摘要', 'success')
      props.onClose()
    } catch (error) {
      Toast.push(error instanceof Error ? error.message : '武装摘要失败', 'error')
    } finally {
      setImporting(false)
    }
  }, [summary, props.onClose])

  /** 载入模板内容到编辑区（视为用户主动设置的内容，同样置脏以防在途生成覆盖）。 */
  const handleLoadTemplate = useCallback((template: HandoffTemplate): void => {
    dirtyRef.current = true
    setSummary(template.content)
    Toast.push(`已载入模板「${template.name}」，可继续编辑`, 'info')
  }, [])

  /** 删除模板。 */
  const handleDeleteTemplate = useCallback(
    async (name: string): Promise<void> => {
      setDeletingName(name)
      try {
        await deleteHandoffTemplate(name)
        Toast.push(`模板「${name}」已删除`, 'success')
        await loadTemplates()
      } catch (error) {
        Toast.push(error instanceof Error ? error.message : '模板删除失败', 'error')
      } finally {
        setDeletingName(null)
      }
    },
    [loadTemplates],
  )

  return (
    <Modal
      open={props.open}
      title="交接摘要"
      onClose={props.onClose}
      footer={
        <div className={styles.footer}>
          <Button variant="ghost" onClick={props.onClose}>
            关闭
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        {/* 模式切换：自由文本摘要 / 结构化分级交接 */}
        <div className={styles.modeSwitch}>
          <Button
            size="sm"
            variant={mode === 'text' ? 'primary' : 'secondary'}
            onClick={() => setMode('text')}
          >
            自由文本摘要
          </Button>
          <Button
            size="sm"
            variant={mode === 'structured' ? 'primary' : 'secondary'}
            onClick={() => setMode('structured')}
          >
            结构化分级交接
          </Button>
        </div>

        {mode === 'structured' ? (
          <StructuredHandoffPanel sessionId={sessionId} onArmed={props.onClose} />
        ) : (
          <>
            <div className={styles.status}>
              {generating ? <Spinner label="正在生成当前会话的交接摘要…" /> : null}
              {!generating && generateError ? (
                <div className={styles.error}>
                  <span>{generateError}</span>
                  {sessionId ? (
                    <Button variant="ghost" size="sm" onClick={handleRetry}>
                      重试
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>

            <Textarea
              className={styles.summaryInput}
              rows={10}
              value={summary}
              disabled={generating}
              onChange={(event) => {
                // 用户手动输入即置脏：后续（慢）生成结果返回时不再覆盖已编辑内容
                dirtyRef.current = true
                setSummary(event.target.value)
              }}
              placeholder="生成的交接摘要将显示在这里；也可以直接粘贴或编辑内容…"
            />
            {model ? <div className={styles.modelInfo}>生成模型：{model}</div> : null}

            <div className={styles.actions}>
              <Button variant="secondary" onClick={() => void handleCopy()}>
                复制到剪贴板
              </Button>
              <Button variant="primary" onClick={() => void handleImport()} disabled={importing}>
                {importing ? <Spinner label="武装中…" /> : '作为新对话起点'}
              </Button>
            </div>
          </>
        )}

        <div className={styles.section}>
          <div className={styles.sectionTitle}>保存为模板</div>
          <div className={styles.templateNameRow}>
            <Input
              className={styles.templateNameInput}
              value={templateName}
              onChange={(event) => setTemplateName(event.target.value)}
              onKeyDown={(event) => {
                // Enter 快捷提交：与“保存为模板”按钮等价
                if (event.key === 'Enter' && !savingTemplate) void handleSaveTemplate()
              }}
              placeholder="模板名称，如：前端项目交接"
            />
            <Button
              variant="secondary"
              onClick={() => void handleSaveTemplate()}
              disabled={savingTemplate}
            >
              {savingTemplate ? <Spinner label="保存中…" /> : '保存为模板'}
            </Button>
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>我的模板</div>
          {templatesLoading ? <Spinner label="加载模板列表…" /> : null}
          {!templatesLoading && templatesError ? (
            <div className={styles.error}>
              <span>{templatesError}</span>
              <Button variant="ghost" size="sm" onClick={() => void loadTemplates()}>
                重试
              </Button>
            </div>
          ) : null}
          {!templatesLoading && !templatesError && templates.length === 0 ? (
            <div className={styles.empty}>暂无模板，保存摘要后可在此复用</div>
          ) : null}
          {!templatesLoading && !templatesError
            ? templates.map((template) => (
                <div key={template.name} className={styles.templateItem}>
                  <div className={styles.templateMeta}>
                    <span className={styles.templateName}>{template.name}</span>
                    <span className={styles.templateTime}>更新于 {formatTime(template.updatedAt)}</span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => handleLoadTemplate(template)}>
                    载入
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => void handleDeleteTemplate(template.name)}
                    disabled={deletingName === template.name}
                  >
                    {deletingName === template.name ? <Spinner label="删除中…" /> : '删除'}
                  </Button>
                </div>
              ))
            : null}
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// 结构化分级交接面板（创新扩展）
// ---------------------------------------------------------------------------

/** 活动项 kind → 中文标签。 */
const ACTIVE_KIND_LABELS: Readonly<Record<string, string>> = {
  in_progress: '进行中',
  next: '下一步',
  open_question: '开放问题',
}

/** 参考项 kind → 中文标签。 */
const REFERENCE_KIND_LABELS: Readonly<Record<string, string>> = {
  path: '路径',
  command: '命令',
  id: '标识',
  link: '链接',
  other: '其他',
}

/** 锚定处置 action → 中文标签。 */
const DISPOSITION_LABELS: Readonly<Record<string, string>> = {
  inherited: '继承',
  evolved: '演进',
  dropped: '废弃',
}

/** 结构化分级交接面板 props。 */
interface StructuredHandoffPanelProps {
  /** 当前会话 id；缺省时无法生成（提示切到会话内使用）。 */
  readonly sessionId?: string
  /** 武装成功后关闭对话框。 */
  readonly onArmed: () => void
}

/**
 * 结构化分级交接面板：
 * - 生成四级分层交接文档（锚定/进行中/参考/归档）；
 * - 展示锚定强制继承守门结果（自动补回的约束高亮）与世系深度告警；
 * - 底部世系链总览：点击任一代可沿 parent 链溯源到根（各代锚定与处置记录）。
 */
function StructuredHandoffPanel(props: StructuredHandoffPanelProps): ReactElement {
  const [result, setResult] = useState<StructuredHandoffResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [arming, setArming] = useState(false)

  /** 生成结构化交接（cancelled 守卫 + AbortController，卸载/会话变化时静默中止）。 */
  const generate = useCallback(
    async (signal?: AbortSignal, isCancelled?: () => boolean): Promise<void> => {
      if (!props.sessionId) return
      const cancelled = (): boolean => (signal?.aborted ?? false) || (isCancelled?.() ?? false)
      setLoading(true)
      setError('')
      try {
        const response = await generateStructuredHandoff({ sessionId: props.sessionId }, { signal })
        if (cancelled()) return
        setResult(response)
      } catch (err) {
        if (cancelled()) return
        setError(err instanceof Error ? err.message : '结构化交接生成失败')
      } finally {
        if (!cancelled()) setLoading(false)
      }
    },
    [props.sessionId],
  )

  // 挂载（含会话变化）：自动生成一次结构化交接。
  useEffect(() => {
    if (!props.sessionId) return
    const controller = new AbortController()
    let cancelled = false
    void generate(controller.signal, () => cancelled)
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [props.sessionId, generate])

  /** 复制渲染后的交接文本。 */
  const handleCopy = useCallback(async (): Promise<void> => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.rendered)
      Toast.push('已复制结构化交接文本', 'success')
    } catch {
      Toast.push('复制失败：浏览器未授权剪贴板访问', 'error')
    }
  }, [result])

  /** 把渲染文本武装给下一个新对话（复用既有武装管线与世代门闩）。 */
  const handleArm = useCallback(async (): Promise<void> => {
    if (!result) return
    setArming(true)
    try {
      await importHandoff({ summary: result.rendered })
      window.dispatchEvent(new CustomEvent('companion:armed-changed'))
      Toast.push('已武装给下一个新对话，新建对话时将自动注入', 'success')
      props.onArmed()
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '武装结构化交接失败', 'error')
    } finally {
      setArming(false)
    }
  }, [result, props.onArmed])

  if (!props.sessionId) {
    return <div className={styles.empty}>结构化交接需在会话内使用：请先打开一个会话再生成。</div>
  }

  return (
    <>
      <div className={styles.status}>
        {loading ? <Spinner label="正在生成结构化分级交接（四级分层 + 锚定继承守门）…" /> : null}
        {!loading && error ? (
          <div className={styles.error}>
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void generate()}>
              重试
            </Button>
          </div>
        ) : null}
      </div>

      {result ? (
        <>
          {/* 世系深度告警 */}
          {result.depthWarning ? (
            <div className={styles.warnBanner}>
              上下文已传承 {result.handoff.depth} 代（告警阈值 {result.depthWarnThreshold}），信息损耗风险升高，建议回读源头会话。
            </div>
          ) : null}
          {/* 守门自动补回提示 */}
          {result.autoRestoredCount > 0 ? (
            <div className={styles.gateBanner}>
              守门自动补回 {result.autoRestoredCount} 条锚定约束：模型生成时静默丢失，已被强制继承（静默丢失在结构上不可能）。
            </div>
          ) : null}

          {/* TIER 1 锚定 */}
          <div className={styles.tier}>
            <div className={styles.tierTitle}>锚定约束（{result.handoff.tiers.anchors.length}）</div>
            <div className={styles.tierHint}>不可丢失的硬约束/已定决策/关键前提，注入时配强指令。</div>
            {result.handoff.tiers.anchors.length === 0 ? (
              <div className={styles.empty}>本代无锚定项</div>
            ) : (
              result.handoff.tiers.anchors.map((anchor) => (
                <div key={anchor.hash} className={`${styles.tierItem} ${anchor.autoRestored ? styles.tierItemRestored : ''}`}>
                  <span className={styles.tierText}>{anchor.text}</span>
                  <span className={styles.tierBadges}>
                    {anchor.autoRestored ? <span className={styles.badgeRestored}>守门补回</span> : null}
                    {anchor.origin !== null ? (
                      <span className={styles.badgeOrigin}>继承自 {anchor.origin.slice(0, 8)}</span>
                    ) : (
                      <span className={styles.badgeNew}>本代新增</span>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* TIER 2 进行中 */}
          {result.handoff.tiers.active.length > 0 ? (
            <div className={styles.tier}>
              <div className={styles.tierTitle}>进行中（{result.handoff.tiers.active.length}）</div>
              {result.handoff.tiers.active.map((item, index) => (
                <div key={`${index}-${item.text}`} className={styles.tierItem}>
                  <span className={styles.badgeKind}>{ACTIVE_KIND_LABELS[item.kind] ?? item.kind}</span>
                  <span className={styles.tierText}>{item.text}</span>
                </div>
              ))}
            </div>
          ) : null}

          {/* TIER 3 参考 */}
          {result.handoff.tiers.reference.length > 0 ? (
            <div className={styles.tier}>
              <div className={styles.tierTitle}>参考（{result.handoff.tiers.reference.length}）</div>
              {result.handoff.tiers.reference.map((item, index) => (
                <div key={`${index}-${item.text}`} className={styles.tierItem}>
                  <span className={styles.badgeKind}>{REFERENCE_KIND_LABELS[item.kind] ?? item.kind}</span>
                  <span className={styles.tierMono}>{item.text}</span>
                </div>
              ))}
            </div>
          ) : null}

          {/* TIER 4 归档 */}
          {result.handoff.tiers.archived.length > 0 ? (
            <div className={styles.tier}>
              <div className={styles.tierTitle}>归档（{result.handoff.tiers.archived.length}）</div>
              {result.handoff.tiers.archived.map((item, index) => (
                <div key={`${index}-${item.text}`} className={styles.tierArchived}>
                  {item.text}
                </div>
              ))}
            </div>
          ) : null}

          {/* 锚定处置记录（审计：每条父代锚定去哪了） */}
          {result.handoff.dispositions.length > 0 ? (
            <div className={styles.tier}>
              <div className={styles.tierTitle}>父代锚定处置（{result.handoff.dispositions.length}）</div>
              {result.handoff.dispositions.map((disp, index) => (
                <div key={`${index}-${disp.anchorHash}`} className={styles.dispositionItem}>
                  <span
                    className={`${styles.badgeDisposition} ${
                      disp.action === 'dropped' ? styles.badgeDropped : disp.action === 'evolved' ? styles.badgeEvolved : styles.badgeInherited
                    }`}
                  >
                    {DISPOSITION_LABELS[disp.action] ?? disp.action}
                  </span>
                  <span className={styles.tierText}>{disp.anchorText}</span>
                  {disp.reason ? <span className={styles.dispositionReason}>理由：{disp.reason}</span> : null}
                </div>
              ))}
            </div>
          ) : null}

          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => void handleCopy()}>
              复制交接文本
            </Button>
            <Button variant="primary" onClick={() => void handleArm()} disabled={arming}>
              {arming ? <Spinner label="武装中…" /> : '武装给下一个新对话'}
            </Button>
          </div>
        </>
      ) : null}

      <LineageSection />
    </>
  )
}

/** 世系链分区 props。 */
interface LineageSectionProps {
  readonly handoffId?: string
}

/** 世系链总览与溯源分区：列出各代交接摘要，点击展开沿 parent 链到根的完整链条。 */
function LineageSection(_props: LineageSectionProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [trace, setTrace] = useState<LineageTraceResponse | null>(null)
  const [traceError, setTraceError] = useState('')

  /** 展开世系链总览（懒加载一次）。 */
  const handleExpand = useCallback((): void => {
    setExpanded((prev) => !prev)
  }, [])

  /** 溯源指定交接的世系链（沿 parent 链到根）。 */
  const handleTrace = useCallback(async (handoffId: string): Promise<void> => {
    setTraceError('')
    try {
      setTrace(await traceHandoffLineage(handoffId))
    } catch (error) {
      setTrace(null)
      setTraceError(error instanceof Error ? error.message : '世系溯源失败')
    }
  }, [])

  return (
    <div className={styles.section}>
      <button type="button" className={styles.lineageToggle} onClick={handleExpand}>
        世系链总览{expanded ? '（收起）' : '（展开）'}
      </button>
      {expanded ? <LineageList onTrace={handleTrace} /> : null}
      {traceError ? <div className={styles.error}>{traceError}</div> : null}
      {trace ? (
        <div className={styles.traceChain}>
          <div className={styles.tierTitle}>
            世系溯源：共 {trace.depth + 1} 代{trace.truncated ? '（过深已截断）' : ''}
          </div>
          {trace.chain.map((entry) => (
            <div key={entry.handoffId} className={styles.traceEntry}>
              <div className={styles.traceMeta}>
                第 {entry.depth} 代 · {formatTime(entry.createdAt)} · {entry.anchors.length} 条锚定
              </div>
              {entry.anchors.map((anchor) => (
                <div key={anchor.hash} className={styles.traceAnchor}>
                  {anchor.text}
                  {anchor.autoRestored ? <span className={styles.badgeRestored}>守门补回</span> : null}
                </div>
              ))}
              {entry.dispositions
                .filter((disp) => disp.action === 'dropped')
                .map((disp, index) => (
                  <div key={`${index}-${disp.anchorHash}`} className={styles.traceDropped}>
                    废弃：{disp.anchorText}
                    {disp.reason ? `（${disp.reason}）` : ''}
                  </div>
                ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 世系链列表 props。 */
interface LineageListProps {
  readonly onTrace: (handoffId: string) => void
}

/** 世系链总览列表（按创建时间降序，点击行溯源）。 */
function LineageList(props: LineageListProps): ReactElement {
  const [rows, setRows] = useState<readonly LineageSummary[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchHandoffLineage()
      .then((response) => {
        if (!cancelled) setRows(response.handoffs)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '世系链加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) return <div className={styles.error}>{error}</div>
  if (rows === null) return <Spinner label="加载世系链…" />
  if (rows.length === 0) return <div className={styles.empty}>暂无结构化交接记录</div>
  return (
    <div className={styles.lineageList}>
      {rows.map((row) => (
        <button key={row.handoffId} type="button" className={styles.lineageRow} onClick={() => props.onTrace(row.handoffId)}>
          <span className={styles.lineageDepth}>第 {row.depth} 代</span>
          <span className={styles.lineageTitle}>{formatTime(row.createdAt)}</span>
          <span className={styles.lineageCounts}>
            锚定 {row.anchorCount}
            {row.autoRestoredCount > 0 ? ` · 补回 ${row.autoRestoredCount}` : ''}
            {row.droppedCount > 0 ? ` · 废弃 ${row.droppedCount}` : ''}
          </span>
        </button>
      ))}
    </div>
  )
}
