/**
 * 协作与知识管理视图页（模块 I 客户端 UI，挂载于 conversation.view）：
 * - I1 团队配置同步：成员署名与缺省合并策略、导出配置快照（JSON 下载）、
 *   导入配置快照（文件选择 → diff 预览 → 按策略导入 → 分区汇报）、快照归档管理；
 * - I2 执行经验库：关键词/标签/模型检索、手动创建卡片、
 *   卡片详情（笔记列表与笔记补充）、卡片删除；
 * - I 创新扩展 经验蒸馏：批量扫描蒸馏（信号挖矿参数化）、蒸馏卡列表
 *   （置信度 / 复发度 / 证据链回溯）、晋升为正式经验卡与单会话蒸馏；
 * - I3 Prompt 协作评审：评审列表与创建、评审详情（基线/提议对比、
 *   评论批注、通过/拒绝、合并主版本）与删除。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactElement } from 'react'
import { Button, Input, Modal, Pill, Select, Spinner, Textarea, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  addExperienceNote,
  addReviewComment,
  createExperienceCard,
  createReview,
  decideReview,
  deleteDistilledCard,
  deleteExperienceCard,
  deleteReview,
  deleteTeamSnapshot,
  diffTeamConfig,
  distillSessionExperience,
  downloadBlob,
  exportTeamConfig,
  fetchDistilledCards,
  fetchExperienceCards,
  fetchReviewDetail,
  fetchReviews,
  fetchTeamPrefs,
  fetchTeamSnapshots,
  importTeamConfig,
  mergeReview,
  promoteDistilledCard,
  saveTeamPrefs,
  scanDistillExperience,
} from '../api.js'
import type {
  ConfigDiffEntry,
  DistillOutcome,
  DistillScanResponse,
  DistilledCardWithConfidence,
  ExperienceCard,
  MergeStrategy,
  ReviewComment,
  ReviewDecision,
  ReviewRequest,
  SectionReport,
  TeamConfigSnapshot,
  TeamPrefs,
} from '../api.js'
import styles from './TeamView.module.css'

/** 组件 props。 */
export interface TeamViewProps {
  readonly sessionId?: string
}

/** 子面板页签。 */
type Tab = 'sync' | 'experience' | 'distill' | 'review'

/** 协作与知识管理视图页。 */
export function TeamView(_props: TeamViewProps): ReactElement {
  const [tab, setTab] = useState<Tab>('sync')
  return (
    <div className={styles.root}>
      <h2 className={styles.title}>协作与知识管理</h2>
      <div className={styles.tabs}>
        <Button size="sm" variant={tab === 'sync' ? 'primary' : 'secondary'} onClick={() => setTab('sync')}>
          配置同步
        </Button>
        <Button size="sm" variant={tab === 'experience' ? 'primary' : 'secondary'} onClick={() => setTab('experience')}>
          经验库
        </Button>
        <Button size="sm" variant={tab === 'distill' ? 'primary' : 'secondary'} onClick={() => setTab('distill')}>
          经验蒸馏
        </Button>
        <Button size="sm" variant={tab === 'review' ? 'primary' : 'secondary'} onClick={() => setTab('review')}>
          评审
        </Button>
      </div>
      {tab === 'sync' && <SyncPanel />}
      {tab === 'experience' && <ExperiencePanel />}
      {tab === 'distill' && <DistillPanel />}
      {tab === 'review' && <ReviewPanel />}
    </div>
  )
}

/** 错误提示统一转 Toast。 */
function reportError(error: unknown, fallback: string): void {
  Toast.push(error instanceof Error ? error.message : fallback, 'error')
}

/** 时间戳格式化（0 显示为 -）。 */
function formatTime(ts: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** 时长格式化。 */
function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** JSON 预览（超长截断）。 */
function previewJson(value: unknown): string {
  if (value === undefined) return '-'
  const text = JSON.stringify(value)
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

/** 配置分区中文名。 */
const SECTION_LABELS: Record<string, string> = {
  costSettings: '成本设置',
  pricingOverrides: '单价覆盖',
  handoffTemplates: '交接模板',
  promptTemplates: 'Prompt 模板',
  pipelines: '流水线',
  scheduledJobs: '定时任务',
  dlpRules: 'DLP 规则',
}

/** 合并策略中文名。 */
const STRATEGY_LABELS: Record<string, string> = {
  local: '本地优先',
  remote: '远程优先',
  manual: '手动合并',
}

/** diff 动作中文名。 */
const ACTION_LABELS: Record<ConfigDiffEntry['action'], string> = {
  add: '新增',
  update: '更新',
  same: '一致',
  'local-only': '仅本地',
}

/** 经验卡片来源中文名。 */
const SOURCE_LABELS: Record<string, string> = {
  pipeline: '流水线',
  queue: '批量队列',
  cron: '定时任务',
  manual: '手动',
}

// ---------------------------------------------------------------------------
// I1：团队配置同步
// ---------------------------------------------------------------------------

/** 配置同步面板。 */
function SyncPanel(): ReactElement {
  const fileRef = useRef<HTMLInputElement>(null)
  const [prefs, setPrefs] = useState<TeamPrefs | null>(null)
  const [memberName, setMemberName] = useState('')
  const [defaultStrategy, setDefaultStrategy] = useState<MergeStrategy>('manual')
  const [savingPrefs, setSavingPrefs] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [snapshots, setSnapshots] = useState<readonly TeamConfigSnapshot[]>([])
  const [pendingSnapshot, setPendingSnapshot] = useState<unknown>(null)
  const [diffs, setDiffs] = useState<readonly ConfigDiffEntry[] | null>(null)
  const [diffing, setDiffing] = useState(false)
  const [importStrategy, setImportStrategy] = useState<MergeStrategy>('manual')
  const [importing, setImporting] = useState(false)
  const [reports, setReports] = useState<readonly SectionReport[] | null>(null)
  const [viewing, setViewing] = useState<TeamConfigSnapshot | null>(null)
  const [deletingKey, setDeletingKey] = useState<string | null>(null)

  const reload = useCallback(() => {
    Promise.all([fetchTeamPrefs(), fetchTeamSnapshots()])
      .then(([prefsRes, snapsRes]) => {
        setPrefs(prefsRes.prefs)
        setMemberName(prefsRes.prefs.memberName)
        setDefaultStrategy(prefsRes.prefs.defaultStrategy)
        setImportStrategy(prefsRes.prefs.defaultStrategy)
        setSnapshots(snapsRes.snapshots)
      })
      .catch((error) => reportError(error, '加载团队配置失败'))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  /** 保存团队偏好。 */
  const savePrefs = (): void => {
    setSavingPrefs(true)
    saveTeamPrefs({ memberName: memberName.trim(), defaultStrategy })
      .then((response) => {
        setPrefs(response.prefs)
        setMemberName(response.prefs.memberName)
        setDefaultStrategy(response.prefs.defaultStrategy)
        Toast.push('团队偏好已保存', 'success')
      })
      .catch((error) => reportError(error, '保存团队偏好失败'))
      .finally(() => setSavingPrefs(false))
  }

  /** 导出配置快照为 JSON 文件。 */
  const doExport = (): void => {
    setExporting(true)
    exportTeamConfig()
      .then((response) => {
        const blob = new Blob([JSON.stringify(response.snapshot, null, 2)], { type: 'application/json' })
        const day = new Date().toISOString().slice(0, 10)
        downloadBlob(blob, `team-config-${day}.json`)
        Toast.push('配置快照已导出', 'success')
      })
      .catch((error) => reportError(error, '导出配置快照失败'))
      .finally(() => setExporting(false))
  }

  /** 选择 JSON 文件：解析后请求 diff 预览。 */
  const onPickFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setDiffing(true)
    setReports(null)
    file
      .text()
      .then((text) => {
        let snapshot: unknown
        try {
          snapshot = JSON.parse(text)
        } catch {
          throw new Error('所选文件不是合法 JSON')
        }
        return diffTeamConfig(snapshot).then((response) => {
          setPendingSnapshot(snapshot)
          setDiffs(response.diffs)
          Toast.push(`快照解析成功，共 ${response.diffs.length} 条差异`, 'info')
        })
      })
      .catch((error) => {
        setPendingSnapshot(null)
        setDiffs(null)
        reportError(error, '解析配置快照失败')
      })
      .finally(() => setDiffing(false))
  }

  /** 按所选策略执行导入。 */
  const runImport = (): void => {
    if (pendingSnapshot === null) return
    setImporting(true)
    importTeamConfig({ snapshot: pendingSnapshot, strategy: importStrategy })
      .then((response) => {
        setReports(response.reports)
        setPendingSnapshot(null)
        setDiffs(null)
        Toast.push('配置导入完成', 'success')
        reload()
      })
      .catch((error) => reportError(error, '导入配置失败'))
      .finally(() => setImporting(false))
  }

  /** 取消本次导入（清空 diff 预览）。 */
  const cancelImport = (): void => {
    setPendingSnapshot(null)
    setDiffs(null)
  }

  /** 删除归档快照（以导出时间戳为键）。 */
  const removeSnapshot = (snapshot: TeamConfigSnapshot): void => {
    const key = String(snapshot.exportedAt)
    setDeletingKey(key)
    deleteTeamSnapshot(key)
      .then(() => {
        Toast.push('快照已删除', 'success')
        reload()
      })
      .catch((error) => reportError(error, '删除快照失败'))
      .finally(() => setDeletingKey(null))
  }

  /** 快照携带的分区摘要。 */
  const snapshotSections = (snapshot: TeamConfigSnapshot): string => {
    const names = Object.entries(snapshot.sections ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key]) => SECTION_LABELS[key] ?? key)
    return names.length > 0 ? names.join('、') : '-'
  }

  return (
    <>
      <section className={styles.section}>
        <h3>团队偏好</h3>
        {prefs === null ? (
          <Spinner label="加载团队偏好…" />
        ) : (
          <>
            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span>成员署名（评审作者/评论者标识）</span>
                <Input value={memberName} placeholder="如：张三" onChange={(event) => setMemberName(event.target.value)} />
              </label>
              <label className={styles.field}>
                <span>缺省合并策略</span>
                <Select value={defaultStrategy} onChange={(event) => setDefaultStrategy(event.target.value as MergeStrategy)}>
                  <option value="local">本地优先</option>
                  <option value="remote">远程优先</option>
                  <option value="manual">手动合并</option>
                </Select>
              </label>
            </div>
            <div>
              <Button size="sm" variant="primary" disabled={savingPrefs} onClick={savePrefs}>
                {savingPrefs ? <Spinner label="保存中…" /> : '保存偏好'}
              </Button>
            </div>
          </>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3>配置快照导出 / 导入</h3>
          <div className={styles.rowActions}>
            <Button size="sm" variant="secondary" disabled={exporting} onClick={doExport}>
              {exporting ? <Spinner label="导出中…" /> : '导出配置快照'}
            </Button>
            <Button size="sm" variant="secondary" disabled={diffing} onClick={() => fileRef.current?.click()}>
              {diffing ? <Spinner label="解析中…" /> : '导入配置快照'}
            </Button>
          </div>
        </div>
        <input ref={fileRef} type="file" accept=".json" className={styles.hiddenInput} onChange={onPickFile} />
        <p className={styles.hint}>
          导出的 JSON 提交到团队 Git 仓库共享；成员 pull 后在此导入，冲突按所选策略合并。
        </p>

        {diffs !== null && (
          <>
            <h4 className={styles.subTitle}>差异预览（共 {diffs.length} 条）</h4>
            {diffs.length === 0 ? (
              <p className={styles.empty}>快照与本地配置无差异。</p>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>分区</th>
                    <th>条目</th>
                    <th>动作</th>
                    <th>本地值</th>
                    <th>远程值</th>
                  </tr>
                </thead>
                <tbody>
                  {diffs.map((diff, index) => (
                    <tr key={`${diff.section}-${diff.key}-${index}`}>
                      <td>{SECTION_LABELS[diff.section] ?? diff.section}</td>
                      <td className={styles.cellCode}>{diff.key}</td>
                      <td>
                        <Pill
                          className={
                            diff.action === 'add'
                              ? styles.pillSuccess
                              : diff.action === 'update'
                                ? styles.pillWarning
                                : styles.pillInfo
                          }
                        >
                          {ACTION_LABELS[diff.action]}
                        </Pill>
                      </td>
                      <td className={styles.cellCode}>{previewJson(diff.local)}</td>
                      <td className={styles.cellCode}>{previewJson(diff.remote)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className={styles.rowActions}>
              <label className={styles.field}>
                <span>合并策略</span>
                <Select value={importStrategy} onChange={(event) => setImportStrategy(event.target.value as MergeStrategy)}>
                  <option value="local">本地优先（冲突保留本地）</option>
                  <option value="remote">远程优先（冲突覆盖本地）</option>
                  <option value="manual">手动合并（冲突条目跳过）</option>
                </Select>
              </label>
              <Button size="sm" variant="primary" disabled={importing} onClick={runImport}>
                {importing ? <Spinner label="导入中…" /> : '执行导入'}
              </Button>
              <Button size="sm" variant="ghost" disabled={importing} onClick={cancelImport}>
                取消
              </Button>
            </div>
          </>
        )}

        {reports !== null && (
          <>
            <h4 className={styles.subTitle}>导入结果汇报</h4>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>分区</th>
                  <th>新增</th>
                  <th>更新</th>
                  <th>一致</th>
                  <th>跳过</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr key={report.section}>
                    <td>{SECTION_LABELS[report.section] ?? report.section}</td>
                    <td>{report.added}</td>
                    <td>{report.updated}</td>
                    <td>{report.same}</td>
                    <td>{report.skipped}</td>
                    <td>{report.message ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3>快照归档（最近导入）</h3>
          <Button size="sm" variant="secondary" onClick={reload}>
            刷新
          </Button>
        </div>
        {snapshots.length === 0 ? (
          <p className={styles.empty}>暂无归档快照。</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>导出者</th>
                <th>导出时间</th>
                <th>携带分区</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snapshot) => (
                <tr key={snapshot.exportedAt}>
                  <td>{snapshot.exportedBy || '-'}</td>
                  <td>{formatTime(snapshot.exportedAt)}</td>
                  <td>{snapshotSections(snapshot)}</td>
                  <td>
                    <div className={styles.rowActions}>
                      <Button size="sm" variant="ghost" onClick={() => setViewing(snapshot)}>
                        查看
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={deletingKey === String(snapshot.exportedAt)}
                        onClick={() => removeSnapshot(snapshot)}
                      >
                        {deletingKey === String(snapshot.exportedAt) ? <Spinner label="删除中…" /> : '删除'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Modal
        open={viewing !== null}
        title="快照内容"
        onClose={() => setViewing(null)}
        footer={
          <div className={styles.footer}>
            <Button variant="ghost" onClick={() => setViewing(null)}>
              关闭
            </Button>
          </div>
        }
      >
        <pre className={styles.output}>{viewing === null ? '' : JSON.stringify(viewing, null, 2)}</pre>
      </Modal>
    </>
  )
}

// ---------------------------------------------------------------------------
// I2：执行经验库
// ---------------------------------------------------------------------------

/** 经验库面板。 */
function ExperiencePanel(): ReactElement {
  const [cards, setCards] = useState<readonly ExperienceCard[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState({ query: '', tags: '', model: '' })
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ title: '', model: '', tags: '', promptSummary: '' })
  const [creating, setCreating] = useState(false)
  const [noteDraft, setNoteDraft] = useState({ problem: '', solution: '' })
  const [addingNote, setAddingNote] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const reload = useCallback(() => {
    setLoading(true)
    fetchExperienceCards({
      query: filter.query.trim() || undefined,
      tags: filter.tags.trim() || undefined,
      model: filter.model.trim() || undefined,
    })
      .then((response) => setCards(response.cards))
      .catch((error) => reportError(error, '加载经验卡片失败'))
      .finally(() => setLoading(false))
  }, [filter])

  // 仅挂载时自动加载一次；筛选条件变化由「搜索」按钮显式触发。
  const initialLoaded = useRef(false)
  useEffect(() => {
    if (initialLoaded.current) return
    initialLoaded.current = true
    reload()
  }, [reload])

  /** 切换卡片展开态（同时清空笔记草稿）。 */
  const toggleExpand = (id: string): void => {
    setExpandedId((prev) => (prev === id ? null : id))
    setNoteDraft({ problem: '', solution: '' })
  }

  /** 手动创建经验卡片。 */
  const submitCreate = (): void => {
    if (!form.title.trim()) {
      Toast.push('请填写卡片标题', 'warning')
      return
    }
    setCreating(true)
    createExperienceCard({
      title: form.title.trim(),
      model: form.model.trim(),
      tags: form.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
      promptSummary: form.promptSummary.trim(),
    })
      .then(() => {
        Toast.push('经验卡片已创建', 'success')
        setCreateOpen(false)
        setForm({ title: '', model: '', tags: '', promptSummary: '' })
        reload()
      })
      .catch((error) => reportError(error, '创建经验卡片失败'))
      .finally(() => setCreating(false))
  }

  /** 为展开的卡片补充笔记。 */
  const submitNote = (card: ExperienceCard): void => {
    if (!noteDraft.problem.trim() || !noteDraft.solution.trim()) {
      Toast.push('问题与解决方案均需填写', 'warning')
      return
    }
    setAddingNote(true)
    addExperienceNote({ id: card.id, problem: noteDraft.problem.trim(), solution: noteDraft.solution.trim() })
      .then((response) => {
        setCards((prev) => prev.map((item) => (item.id === response.card.id ? response.card : item)))
        setNoteDraft({ problem: '', solution: '' })
        Toast.push('笔记已添加', 'success')
      })
      .catch((error) => reportError(error, '添加笔记失败'))
      .finally(() => setAddingNote(false))
  }

  /** 删除卡片。 */
  const removeCard = (id: string): void => {
    setDeletingId(id)
    deleteExperienceCard(id)
      .then(() => {
        Toast.push('卡片已删除', 'success')
        reload()
      })
      .catch((error) => reportError(error, '删除卡片失败'))
      .finally(() => setDeletingId(null))
  }

  return (
    <>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3>执行经验库</h3>
          <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
            手动创建卡片
          </Button>
        </div>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>关键词</span>
            <Input
              value={filter.query}
              placeholder="标题 / 摘要 / 笔记全文"
              onChange={(event) => setFilter({ ...filter, query: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') reload()
              }}
            />
          </label>
          <label className={styles.field}>
            <span>标签（逗号分隔，任一命中）</span>
            <Input
              value={filter.tags}
              placeholder="导出, 字体"
              onChange={(event) => setFilter({ ...filter, tags: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') reload()
              }}
            />
          </label>
          <label className={styles.field}>
            <span>模型（精确匹配）</span>
            <Input
              value={filter.model}
              placeholder="deepseek-chat"
              onChange={(event) => setFilter({ ...filter, model: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') reload()
              }}
            />
          </label>
          <div className={styles.field}>
            <Button size="sm" variant="secondary" disabled={loading} onClick={reload}>
              {loading ? <Spinner label="搜索中…" /> : '搜索'}
            </Button>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        {loading && cards.length === 0 ? (
          <Spinner label="加载经验卡片…" />
        ) : cards.length === 0 ? (
          <p className={styles.empty}>暂无经验卡片。</p>
        ) : (
          <div className={styles.cardList}>
            {cards.map((card) => (
              <div key={card.id} className={styles.card}>
                <div className={styles.cardHead}>
                  <span className={styles.cardTitle}>{card.title}</span>
                  <div className={styles.rowActions}>
                    <Pill className={styles.pillInfo}>{SOURCE_LABELS[card.source] ?? card.source}</Pill>
                    <Pill className={styles.pillInfo}>{card.model || '未知模型'}</Pill>
                    {card.ok ? (
                      <Pill className={styles.pillSuccess}>成功</Pill>
                    ) : (
                      <Pill className={styles.pillDanger}>失败</Pill>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => toggleExpand(card.id)}>
                      {expandedId === card.id ? '收起' : '展开'}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={deletingId === card.id}
                      onClick={() => removeCard(card.id)}
                    >
                      {deletingId === card.id ? <Spinner label="删除中…" /> : '删除'}
                    </Button>
                  </div>
                </div>
                <div className={styles.cardMeta}>
                  {formatTime(card.createdAt)} · 耗时 {formatDuration(card.durationMs)} · {card.tokens} tokens
                  {card.tags.length > 0 ? ` · ${card.tags.join(' / ')}` : ''}
                </div>
                {expandedId === card.id && (
                  <div className={styles.cardBody}>
                    {card.promptSummary ? <pre className={styles.output}>{card.promptSummary}</pre> : null}
                    {!card.ok && card.error ? <p className={styles.errorText}>错误：{card.error}</p> : null}
                    <h4 className={styles.subTitle}>问题与解决方案笔记（{card.notes.length}）</h4>
                    {card.notes.length === 0 ? (
                      <p className={styles.empty}>暂无笔记。</p>
                    ) : (
                      <div className={styles.noteList}>
                        {card.notes.map((note, index) => (
                          <div key={`${card.id}-${index}`} className={styles.noteItem}>
                            <span>问题：{note.problem}</span>
                            <span>解决：{note.solution}</span>
                            <span className={styles.commentMeta}>{formatTime(note.ts)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <Textarea
                      rows={2}
                      placeholder="补充问题描述"
                      value={noteDraft.problem}
                      onChange={(event) => setNoteDraft({ ...noteDraft, problem: event.target.value })}
                    />
                    <Textarea
                      rows={2}
                      placeholder="补充解决方案"
                      value={noteDraft.solution}
                      onChange={(event) => setNoteDraft({ ...noteDraft, solution: event.target.value })}
                    />
                    <div>
                      <Button size="sm" variant="secondary" disabled={addingNote} onClick={() => submitNote(card)}>
                        {addingNote ? <Spinner label="添加中…" /> : '添加笔记'}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <Modal
        open={createOpen}
        title="手动创建经验卡片"
        onClose={() => setCreateOpen(false)}
        footer={
          <div className={styles.footer}>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button variant="primary" disabled={creating} onClick={submitCreate}>
              {creating ? <Spinner label="创建中…" /> : '创建'}
            </Button>
          </div>
        }
      >
        <div className={styles.modalBody}>
          <label className={styles.field}>
            <span>标题（必填）</span>
            <Input
              value={form.title}
              placeholder="如：PDF 导出字体缺失的修复"
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span>模型</span>
            <Input
              value={form.model}
              placeholder="deepseek-chat"
              onChange={(event) => setForm({ ...form, model: event.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span>标签（逗号分隔）</span>
            <Input
              value={form.tags}
              placeholder="导出, 字体"
              onChange={(event) => setForm({ ...form, tags: event.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span>执行摘要</span>
            <Textarea
              rows={4}
              placeholder="任务 Prompt / 执行过程摘要"
              value={form.promptSummary}
              onChange={(event) => setForm({ ...form, promptSummary: event.target.value })}
            />
          </label>
        </div>
      </Modal>
    </>
  )
}

// ---------------------------------------------------------------------------
// I 创新扩展：经验自动蒸馏
// ---------------------------------------------------------------------------

/** 扫描参数缺省值：扫描会话数（最近 N 个）。 */
const DISTILL_DEFAULT_LIMIT = 30

/** 扫描参数缺省值：单批蒸馏上限。 */
const DISTILL_DEFAULT_MAX = 5

/** 扫描参数缺省值：信号门槛（0-1）。 */
const DISTILL_DEFAULT_MIN_SIGNAL = 0.45

/** 批量扫描蒸馏超时（毫秒）：蒸馏含元提示调用，耗时远超普通接口。 */
const DISTILL_SCAN_TIMEOUT_MS = 300_000

/** 蒸馏结果状态 → 中文名与 Pill 配色（created=新建/绿、merged=合并/蓝、no-signal=无信号/灰）。 */
const DISTILL_STATUS: Record<DistillOutcome['status'], { label: string; cls: string }> = {
  created: { label: '新建', cls: styles.pillSuccess },
  merged: { label: '合并', cls: styles.pillBrand },
  'no-signal': { label: '无信号', cls: styles.pillInfo },
}

/** 0-1 比例 → 整数百分比文案（如 0.873 → “87%”）。 */
function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** 长会话 id → 短 id 展示（前 8 位 + 省略号）。 */
function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

/** 经验蒸馏面板：批量扫描蒸馏 + 蒸馏卡列表（置信度/复发/证据链）+ 单会话蒸馏。 */
function DistillPanel(): ReactElement {
  // 扫描参数（Input 值均为字符串，提交时再解析校验）
  const [scanLimit, setScanLimit] = useState(String(DISTILL_DEFAULT_LIMIT))
  const [maxDistill, setMaxDistill] = useState(String(DISTILL_DEFAULT_MAX))
  const [minSignal, setMinSignal] = useState(String(DISTILL_DEFAULT_MIN_SIGNAL))
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<DistillScanResponse | null>(null)
  // 蒸馏卡列表
  const [cards, setCards] = useState<readonly DistilledCardWithConfidence[]>([])
  const [cardsLoading, setCardsLoading] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [evidenceId, setEvidenceId] = useState<string | null>(null)
  const [promotingId, setPromotingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // 单会话蒸馏
  const [singleSessionId, setSingleSessionId] = useState('')
  const [distillingSingle, setDistillingSingle] = useState(false)

  const reloadCards = useCallback(() => {
    setCardsLoading(true)
    fetchDistilledCards()
      .then((response) => setCards(response.cards))
      .catch((error) => reportError(error, '加载蒸馏卡失败'))
      .finally(() => setCardsLoading(false))
  }, [])

  // 挂载即拉取蒸馏卡列表（服务端已按 confidence 降序返回）
  useEffect(() => {
    reloadCards()
  }, [reloadCards])

  /** 校验并解析扫描参数，执行批量扫描蒸馏（超时放宽到 5 分钟）。 */
  const runScan = (): void => {
    const limitNum = Number.parseInt(scanLimit, 10)
    const maxNum = Number.parseInt(maxDistill, 10)
    const signalNum = Number.parseFloat(minSignal)
    if (!Number.isFinite(limitNum) || limitNum <= 0) {
      Toast.push('扫描会话数需为正整数', 'warning')
      return
    }
    if (!Number.isFinite(maxNum) || maxNum <= 0) {
      Toast.push('单批蒸馏上限需为正整数', 'warning')
      return
    }
    if (!Number.isFinite(signalNum) || signalNum < 0 || signalNum > 1) {
      Toast.push('信号门槛需为 0-1 之间的小数', 'warning')
      return
    }
    setScanning(true)
    scanDistillExperience(
      { limit: limitNum, maxDistill: maxNum, minSignal: signalNum },
      { timeoutMs: DISTILL_SCAN_TIMEOUT_MS },
    )
      .then((response) => {
        setScanResult(response)
        Toast.push(`扫描完成：候选 ${response.candidates.length} 个，蒸馏 ${response.distilled.length} 个`, 'success')
        reloadCards()
      })
      .catch((error) => reportError(error, '扫描蒸馏失败'))
      .finally(() => setScanning(false))
  }

  /** 晋升蒸馏卡为正式执行经验卡（人工确认后调用）。 */
  const promoteCard = (card: DistilledCardWithConfidence): void => {
    if (!window.confirm(`确认晋升「${card.title}」为正式经验卡？`)) return
    setPromotingId(card.id)
    promoteDistilledCard({ id: card.id })
      .then(() => {
        Toast.push('已晋升为正式经验卡', 'success')
        reloadCards()
      })
      .catch((error) => reportError(error, '晋升失败'))
      .finally(() => setPromotingId(null))
  }

  /** 删除蒸馏卡（人工确认后调用）。 */
  const removeCard = (card: DistilledCardWithConfidence): void => {
    if (!window.confirm(`确认删除蒸馏卡「${card.title}」？`)) return
    setDeletingId(card.id)
    deleteDistilledCard(card.id)
      .then(() => {
        Toast.push('蒸馏卡已删除', 'success')
        reloadCards()
      })
      .catch((error) => reportError(error, '删除蒸馏卡失败'))
      .finally(() => setDeletingId(null))
  }

  /** 对指定会话单独执行蒸馏（结果以 Toast 汇报并刷新列表）。 */
  const distillSingle = (): void => {
    const sessionId = singleSessionId.trim()
    if (!sessionId) {
      Toast.push('请填写会话 id', 'warning')
      return
    }
    setDistillingSingle(true)
    distillSessionExperience({ sessionId })
      .then((outcome) => {
        const message =
          outcome.status === 'created'
            ? '已蒸馏出新经验卡'
            : outcome.status === 'merged'
              ? '已合并入已有经验卡'
              : '该会话未发现可蒸馏信号'
        Toast.push(message, outcome.status === 'no-signal' ? 'info' : 'success')
        reloadCards()
      })
      .catch((error) => reportError(error, '单会话蒸馏失败'))
      .finally(() => setDistillingSingle(false))
  }

  return (
    <>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3>扫描并蒸馏</h3>
        </div>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>扫描会话数（最近 N 个）</span>
            <Input type="number" value={scanLimit} onChange={(event) => setScanLimit(event.target.value)} />
          </label>
          <label className={styles.field}>
            <span>单批蒸馏上限</span>
            <Input type="number" value={maxDistill} onChange={(event) => setMaxDistill(event.target.value)} />
          </label>
          <label className={styles.field}>
            <span>信号门槛（0-1）</span>
            <Input type="number" value={minSignal} onChange={(event) => setMinSignal(event.target.value)} />
          </label>
        </div>
        <div className={styles.rowActions}>
          <Button size="sm" variant="primary" disabled={scanning} onClick={runScan}>
            {scanning ? <Spinner label="扫描蒸馏中…" /> : '扫描并蒸馏'}
          </Button>
        </div>
        <p className={styles.hint}>
          蒸馏管线：信号挖矿（本地零成本）→ 元提示蒸馏 → 语义去重合并 → 证据链回溯；复发度是经验价值的黄金标准，晋升需人工确认。
        </p>

        {scanResult !== null && (
          <div className={styles.distillReport}>
            <div className={styles.distillSummary}>
              <span>扫描 {scanResult.scanned} 个会话</span>
              <span>高信号候选 {scanResult.candidates.length} 个</span>
              <span>成功蒸馏 {scanResult.distilled.length} 个</span>
              <span>失败 {scanResult.errors.length} 个</span>
            </div>
            {scanResult.candidates.length > 0 ? (
              <>
                <h4 className={styles.subTitle}>高信号候选（{scanResult.candidates.length}）</h4>
                <div className={styles.distillCandidateList}>
                  {scanResult.candidates.map((candidate) => (
                    <span key={candidate.sessionId} className={styles.distillCandidate}>
                      <span className={styles.distillCandidateTitle}>{candidate.title}</span>
                      <Pill className={styles.pillWarning}>{formatPercent(candidate.score)}</Pill>
                    </span>
                  ))}
                </div>
              </>
            ) : null}
            {scanResult.distilled.length > 0 ? (
              <>
                <h4 className={styles.subTitle}>蒸馏结果（{scanResult.distilled.length}）</h4>
                <div className={styles.distillResultList}>
                  {scanResult.distilled.map((item) => {
                    const status = DISTILL_STATUS[item.outcome.status]
                    return (
                      <div key={item.sessionId} className={styles.distillResultItem}>
                        <span className={styles.cellCode}>{shortId(item.sessionId)}</span>
                        <Pill className={status.cls}>{status.label}</Pill>
                        <span className={styles.distillResultLesson}>
                          {item.outcome.card ? item.outcome.card.lesson : '（无卡片产物）'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </>
            ) : null}
            {scanResult.errors.length > 0 ? (
              <>
                <h4 className={styles.subTitle}>失败明细（{scanResult.errors.length}）</h4>
                <div className={styles.distillErrorList}>
                  {scanResult.errors.map((item) => (
                    <p key={item.sessionId} className={styles.errorText}>
                      {shortId(item.sessionId)}：{item.error}
                    </p>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3>蒸馏经验卡（按置信度降序）</h3>
          <Button size="sm" variant="secondary" disabled={cardsLoading} onClick={reloadCards}>
            刷新
          </Button>
        </div>
        {cardsLoading && cards.length === 0 ? (
          <Spinner label="加载蒸馏卡…" />
        ) : cards.length === 0 ? (
          <p className={styles.empty}>暂无蒸馏经验卡，先运行「扫描并蒸馏」。</p>
        ) : (
          <div className={styles.cardList}>
            {cards.map((card) => (
              <div key={card.id} className={styles.card}>
                <div className={styles.cardHead}>
                  <span className={styles.cardTitle}>{card.title}</span>
                  <div className={styles.rowActions}>
                    <Pill className={styles.pillInfo}>置信度 {formatPercent(card.confidence)}</Pill>
                    {card.occurrences >= 2 ? (
                      <Pill className={styles.pillWarning}>复发 ×{card.occurrences}</Pill>
                    ) : (
                      <Pill className={styles.pillInfo}>{card.occurrences} 次</Pill>
                    )}
                    {card.promoted ? <Pill className={styles.pillSuccess}>已晋升</Pill> : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDetailId((prev) => (prev === card.id ? null : card.id))}
                    >
                      {detailId === card.id ? '收起问题/方案' : '问题/方案'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEvidenceId((prev) => (prev === card.id ? null : card.id))}
                    >
                      {evidenceId === card.id ? '收起证据链' : `证据链（${card.evidence.length}）`}
                    </Button>
                    {!card.promoted ? (
                      <Button size="sm" variant="primary" disabled={promotingId === card.id} onClick={() => promoteCard(card)}>
                        {promotingId === card.id ? <Spinner label="晋升中…" /> : '晋升为经验卡'}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="danger" disabled={deletingId === card.id} onClick={() => removeCard(card)}>
                      {deletingId === card.id ? <Spinner label="删除中…" /> : '删除'}
                    </Button>
                  </div>
                </div>
                <div className={styles.cardMeta}>
                  信号分 {card.signalScore.toFixed(2)} · 出现 {card.occurrences} 次 · 首次 {formatTime(card.createdAt)}
                  · 最近复发 {formatTime(card.lastSeenAt)} · 来源 {card.sourceSessions.length} 个会话（如{' '}
                  {shortId(card.sessionId)}）
                </div>
                <p className={styles.distillLesson}>教训：{card.lesson}</p>
                {card.tags.length > 0 ? (
                  <div className={styles.distillTags}>
                    {card.tags.map((tag) => (
                      <Pill key={tag} className={styles.pillInfo}>
                        {tag}
                      </Pill>
                    ))}
                  </div>
                ) : null}
                {detailId === card.id ? (
                  <div className={styles.cardBody}>
                    <div className={styles.distillPS}>
                      <span className={styles.distillPSLabel}>问题</span>
                      <span>{card.problem || '-'}</span>
                    </div>
                    <div className={styles.distillPS}>
                      <span className={styles.distillPSLabel}>方案</span>
                      <span>{card.solution || '-'}</span>
                    </div>
                  </div>
                ) : null}
                {evidenceId === card.id ? (
                  <div className={styles.distillEvidence}>
                    {card.evidence.length === 0 ? (
                      <p className={styles.empty}>暂无证据链。</p>
                    ) : (
                      card.evidence.map((entry) => (
                        <div key={`${card.id}-${entry.seq}`} className={styles.distillEvidenceItem}>
                          <span className={styles.distillEvidenceHead}>
                            <span className={styles.distillEvidenceSeq}>#{entry.seq}</span>
                            <Pill className={entry.kind === 'error' ? styles.pillDanger : styles.pillSuccess}>
                              {entry.kind === 'error' ? '错误' : '修复'}
                            </Pill>
                          </span>
                          <pre className={styles.distillEvidenceExcerpt}>{entry.excerpt}</pre>
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3>单会话蒸馏</h3>
        </div>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>会话 id（本视图无会话列表，手动粘贴）</span>
            <Input
              value={singleSessionId}
              placeholder="粘贴会话 id"
              onChange={(event) => setSingleSessionId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') distillSingle()
              }}
            />
          </label>
          <div className={styles.field}>
            <Button size="sm" variant="secondary" disabled={distillingSingle} onClick={distillSingle}>
              {distillingSingle ? <Spinner label="蒸馏中…" /> : '蒸馏此会话'}
            </Button>
          </div>
        </div>
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// I3：Prompt 协作评审
// ---------------------------------------------------------------------------

/** 评审状态徽标。 */
function ReviewStatusPill(props: { status: ReviewRequest['status'] }): ReactElement {
  const map: Record<ReviewRequest['status'], { label: string; cls: string }> = {
    open: { label: '待审核', cls: styles.pillWarning },
    approved: { label: '已通过', cls: styles.pillSuccess },
    rejected: { label: '已拒绝', cls: styles.pillDanger },
    merged: { label: '已合并', cls: styles.pillInfo },
  }
  const entry = map[props.status]
  return <Pill className={entry.cls}>{entry.label}</Pill>
}

/** 评论锚点描述。 */
function anchorLabel(anchor: { side: string; line: number } | undefined): string {
  if (!anchor || anchor.line === 0) return '整体评论'
  return `${anchor.side === 'base' ? '基线' : '提议'}侧第 ${anchor.line} 行`
}

/** 评审面板。 */
function ReviewPanel(): ReactElement {
  const [reviews, setReviews] = useState<readonly ReviewRequest[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ title: '', baseContent: '', proposedContent: '', note: '' })
  const [creating, setCreating] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<{
    review: ReviewRequest
    comments: readonly ReviewComment[]
    decisions: readonly ReviewDecision[]
  } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [comment, setComment] = useState('')
  const [addingComment, setAddingComment] = useState(false)
  const [decisionComment, setDecisionComment] = useState('')
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null)
  const [merging, setMerging] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const reload = useCallback(() => {
    setLoading(true)
    fetchReviews()
      .then((response) => setReviews(response.reviews))
      .catch((error) => reportError(error, '加载评审列表失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  /** 打开评审详情。 */
  const openDetail = useCallback((id: string): void => {
    setDetailId(id)
    setDetail(null)
    setDetailLoading(true)
    fetchReviewDetail(id)
      .then((response) => setDetail(response))
      .catch((error) => {
        reportError(error, '加载评审详情失败')
        setDetailId(null)
      })
      .finally(() => setDetailLoading(false))
  }, [])

  /** 创建评审。 */
  const submitCreate = (): void => {
    if (!form.title.trim() || !form.proposedContent.trim()) {
      Toast.push('标题与提议内容必填', 'warning')
      return
    }
    setCreating(true)
    createReview({
      title: form.title.trim(),
      baseContent: form.baseContent,
      proposedContent: form.proposedContent,
      note: form.note.trim() || undefined,
    })
      .then(() => {
        Toast.push('评审已创建', 'success')
        setCreateOpen(false)
        setForm({ title: '', baseContent: '', proposedContent: '', note: '' })
        reload()
      })
      .catch((error) => reportError(error, '创建评审失败'))
      .finally(() => setCreating(false))
  }

  /** 添加评论批注。 */
  const submitComment = (): void => {
    if (!detail || !comment.trim()) return
    setAddingComment(true)
    addReviewComment({ reviewId: detail.review.id, content: comment.trim() })
      .then(() => {
        setComment('')
        Toast.push('评论已添加', 'success')
        openDetail(detail.review.id)
      })
      .catch((error) => reportError(error, '添加评论失败'))
      .finally(() => setAddingComment(false))
  }

  /** 审核决定（通过/拒绝）。 */
  const decide = (verdict: 'approve' | 'reject'): void => {
    if (!detail) return
    setDeciding(verdict)
    decideReview({ reviewId: detail.review.id, verdict, comment: decisionComment.trim() || undefined })
      .then(() => {
        Toast.push(verdict === 'approve' ? '已通过评审' : '已拒绝评审', 'success')
        setDecisionComment('')
        openDetail(detail.review.id)
        reload()
      })
      .catch((error) => reportError(error, '提交审核决定失败'))
      .finally(() => setDeciding(null))
  }

  /** 合并进主版本。 */
  const doMerge = (): void => {
    if (!detail) return
    setMerging(true)
    mergeReview(detail.review.id)
      .then((response) => {
        Toast.push(`已合并为主版本 v${response.mergedVersion}`, 'success')
        openDetail(detail.review.id)
        reload()
      })
      .catch((error) => reportError(error, '合并失败'))
      .finally(() => setMerging(false))
  }

  /** 删除评审。 */
  const removeReview = (id: string): void => {
    setDeletingId(id)
    deleteReview(id)
      .then(() => {
        Toast.push('评审已删除', 'success')
        reload()
      })
      .catch((error) => reportError(error, '删除评审失败'))
      .finally(() => setDeletingId(null))
  }

  return (
    <>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3>Prompt 协作评审</h3>
          <div className={styles.rowActions}>
            <Button size="sm" variant="secondary" disabled={loading} onClick={reload}>
              刷新
            </Button>
            <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
              创建评审
            </Button>
          </div>
        </div>
        {loading && reviews.length === 0 ? (
          <Spinner label="加载评审列表…" />
        ) : reviews.length === 0 ? (
          <p className={styles.empty}>暂无评审请求。</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>标题</th>
                <th>作者</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((review) => (
                <tr key={review.id}>
                  <td>{review.title}</td>
                  <td>{review.author || '-'}</td>
                  <td>
                    <ReviewStatusPill status={review.status} />
                  </td>
                  <td>{formatTime(review.createdAt)}</td>
                  <td>{formatTime(review.updatedAt)}</td>
                  <td>
                    <div className={styles.rowActions}>
                      <Button size="sm" variant="ghost" onClick={() => openDetail(review.id)}>
                        查看
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={deletingId === review.id}
                        onClick={() => removeReview(review.id)}
                      >
                        {deletingId === review.id ? <Spinner label="删除中…" /> : '删除'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Modal
        open={createOpen}
        title="创建评审"
        onClose={() => setCreateOpen(false)}
        footer={
          <div className={styles.footer}>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button variant="primary" disabled={creating} onClick={submitCreate}>
              {creating ? <Spinner label="创建中…" /> : '提交评审'}
            </Button>
          </div>
        }
      >
        <div className={styles.modalBody}>
          <label className={styles.field}>
            <span>标题（必填）</span>
            <Input
              value={form.title}
              placeholder="如：优化导出摘要的章节结构"
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span>基线内容（当前主版本，可为空）</span>
            <Textarea rows={6} value={form.baseContent} onChange={(event) => setForm({ ...form, baseContent: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span>提议内容（必填）</span>
            <Textarea rows={6} value={form.proposedContent} onChange={(event) => setForm({ ...form, proposedContent: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span>备注</span>
            <Input value={form.note} placeholder="变更动机说明" onChange={(event) => setForm({ ...form, note: event.target.value })} />
          </label>
        </div>
      </Modal>

      <Modal
        open={detailId !== null}
        title={detail ? `评审：${detail.review.title}` : '评审详情'}
        onClose={() => setDetailId(null)}
        footer={
          <div className={styles.footer}>
            <Button variant="ghost" onClick={() => setDetailId(null)}>
              关闭
            </Button>
          </div>
        }
      >
        {detailLoading || detail === null ? (
          <Spinner label="加载评审详情…" />
        ) : (
          <div className={styles.modalBody}>
            <div className={styles.cardMeta}>
              作者：{detail.review.author || '-'} · 创建于 {formatTime(detail.review.createdAt)} · 更新于{' '}
              {formatTime(detail.review.updatedAt)}
              {detail.review.mergedVersion > 0 ? ` · 合并主版本 v${detail.review.mergedVersion}` : ''}
            </div>
            <div className={styles.rowActions}>
              <ReviewStatusPill status={detail.review.status} />
            </div>
            {detail.review.note ? <p className={styles.hint}>备注：{detail.review.note}</p> : null}

            <div className={styles.compareGrid}>
              <div className={styles.compareCol}>
                <span className={styles.compareLabel}>基线内容</span>
                <pre className={styles.output}>{detail.review.baseContent || '（空）'}</pre>
              </div>
              <div className={styles.compareCol}>
                <span className={styles.compareLabel}>提议内容</span>
                <pre className={styles.output}>{detail.review.proposedContent || '（空）'}</pre>
              </div>
            </div>

            <h4 className={styles.subTitle}>评论批注（{detail.comments.length}）</h4>
            {detail.comments.length === 0 ? (
              <p className={styles.empty}>暂无评论。</p>
            ) : (
              <div className={styles.commentList}>
                {detail.comments.map((item) => (
                  <div key={item.id} className={styles.commentItem}>
                    <span>{item.content}</span>
                    <span className={styles.commentMeta}>
                      {item.author || '-'} · {anchorLabel(item.anchor)} · {formatTime(item.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <Textarea rows={2} placeholder="添加评论批注" value={comment} onChange={(event) => setComment(event.target.value)} />
            <div>
              <Button size="sm" variant="secondary" disabled={addingComment || !comment.trim()} onClick={submitComment}>
                {addingComment ? <Spinner label="提交中…" /> : '添加评论'}
              </Button>
            </div>

            <h4 className={styles.subTitle}>审核记录（{detail.decisions.length}）</h4>
            {detail.decisions.length === 0 ? (
              <p className={styles.empty}>暂无审核决定。</p>
            ) : (
              <div className={styles.commentList}>
                {detail.decisions.map((decision, index) => (
                  <div key={`${decision.reviewer}-${decision.ts}-${index}`} className={styles.commentItem}>
                    <span>
                      {decision.reviewer || '-'}{' '}
                      {decision.verdict === 'approve' ? (
                        <Pill className={styles.pillSuccess}>通过</Pill>
                      ) : (
                        <Pill className={styles.pillDanger}>拒绝</Pill>
                      )}
                      {decision.comment ? `：${decision.comment}` : ''}
                    </span>
                    <span className={styles.commentMeta}>{formatTime(decision.ts)}</span>
                  </div>
                ))}
              </div>
            )}

            {detail.review.status !== 'merged' && (
              <div className={styles.decideBox}>
                <Input
                  value={decisionComment}
                  placeholder="审核意见（可选）"
                  onChange={(event) => setDecisionComment(event.target.value)}
                />
                <div className={styles.rowActions}>
                  <Button size="sm" variant="primary" disabled={deciding !== null} onClick={() => decide('approve')}>
                    {deciding === 'approve' ? <Spinner label="提交中…" /> : '通过'}
                  </Button>
                  <Button size="sm" variant="danger" disabled={deciding !== null} onClick={() => decide('reject')}>
                    {deciding === 'reject' ? <Spinner label="提交中…" /> : '拒绝'}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={merging || detail.review.status !== 'approved'}
                    title={detail.review.status === 'approved' ? '合并进主版本' : '通过审核后方可合并'}
                    onClick={doMerge}
                  >
                    {merging ? <Spinner label="合并中…" /> : '合并主版本'}
                  </Button>
                </div>
                {detail.review.status !== 'approved' ? (
                  <p className={styles.hint}>通过审核后方可合并主版本。</p>
                ) : null}
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}
