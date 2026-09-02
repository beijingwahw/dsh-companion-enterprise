/**
 * 全局对话检索视图页（模块 D 客户端 UI，挂载于 conversation.view）：
 * - 顶部全局搜索框（防抖 300ms）+ 检索模式切换（关键词 / 语义）+ 日期范围（两个
 *   type=date 输入，仅关键词模式生效）+ 标签筛选（GET /tags 全量标签，Pill 可点击，
 *   仅关键词模式生效）；
 * - 关键词模式：GET /search 词面检索（既有流程）；
 * - 语义模式（创新扩展）：GET /search/semantic —— 字符 shingle 邻域 + PRF 查询扩展
 *   + RRF 融合；结果区顶部展示扩展词行（term + weight，按 weight 降序）与扫描会话数，
 *   每条命中附带 RRF 分、邻域相似度与扩展词命中标签；
 * - 语义模式下每个命中可“找相似”（GET /search/similar）：以折叠区展示相似会话的
 *   相似度、共有词与标签；
 * - 点击结果派发 `companion:open-session` 自定义事件请求主平台跳转（集成缝，见下注）；
 * - “加载更多”通过递增 limit 实现分页。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Input, Pill, Spinner, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { fetchAllTags, fetchSimilarSessions, searchSessions, searchSessionsSemantic } from '../api.js'
import type { SearchHit, SemanticSearchResponse, SimilarSessionHit } from '../api.js'
import styles from './SearchView.module.css'

/** 组件 props：sessionId 由 slot 的 inject 注入（本视图不使用，仅为统一注入约定）。 */
export interface SearchViewProps {
  readonly sessionId?: string
}

/** 检索模式：keyword=关键词词面检索（缺省）；semantic=语义邻域检索。 */
type SearchMode = 'keyword' | 'semantic'

/** 每次“加载更多”递增的条数。 */
const PAGE_SIZE = 50

/** 搜索输入防抖时长（毫秒）。 */
const DEBOUNCE_MS = 300

/** “找相似”固定拉取的相似会话条数。 */
const SIMILAR_LIMIT = 10

/** 毫秒时间戳 → 本地可读日期时间。 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** 0-1 比例 → 整数百分比文案（如 0.873 → “87%”）。 */
function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** 语义检索结果摘要 props。 */
interface SemanticSummaryProps {
  readonly result: SemanticSearchResponse
}

/** 语义检索结果摘要：PRF 扩展词行（term + weight 降序）+ 扫描会话数小字。 */
function SemanticSummary(props: SemanticSummaryProps): ReactElement {
  // 扩展词按 weight 降序展示（weight 保留 3 位小数）
  const terms = [...props.result.expansionTerms].sort((a, b) => b.weight - a.weight)
  return (
    <div className={styles.semanticPanel}>
      <div className={styles.semanticExpansion}>
        <span className={styles.semanticExpansionLabel}>PRF 查询扩展词（来自邻域文档）</span>
        {terms.length === 0 ? (
          <span className={styles.muted}>本次未产生扩展词</span>
        ) : (
          terms.map((item) => (
            <span key={item.term} className={styles.semanticExpansionItem}>
              <Pill className={styles.semanticExpansionTerm}>{item.term}</Pill>
              <span className={styles.semanticExpansionWeight}>{item.weight.toFixed(3)}</span>
            </span>
          ))
        )}
      </div>
      <span className={styles.semanticScanned}>本次扫描 {props.result.scannedSessions} 个会话</span>
    </div>
  )
}

/** 相似会话折叠区 props。 */
interface SimilarSessionsBoxProps {
  /** 是否正在拉取相似会话。 */
  readonly loading: boolean
  readonly hits: readonly SimilarSessionHit[]
  /** 本次相似扫描的会话数（0 表示尚未拿到响应）。 */
  readonly scanned: number
  readonly error: string
  /** 收起折叠区。 */
  readonly onClose: () => void
  /** 点击相似会话请求跳转（复用主列表的跳转逻辑）。 */
  readonly onOpen: (sessionId: string) => void
}

/** 单条命中的“找相似”结果折叠区：相似度百分比 + 共有词 Pill + 标签。 */
function SimilarSessionsBox(props: SimilarSessionsBoxProps): ReactElement {
  return (
    <div className={styles.similarBox}>
      <div className={styles.similarHead}>
        <span className={styles.similarTitle}>相似会话</span>
        {props.scanned > 0 ? <span className={styles.semanticScanned}>扫描 {props.scanned} 个会话</span> : null}
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          收起
        </Button>
      </div>
      {props.error ? <span className={styles.error}>{props.error}</span> : null}
      {props.loading ? (
        <Spinner label="查找相似会话…" />
      ) : !props.error && props.hits.length === 0 ? (
        <span className={styles.muted}>没有找到相似会话</span>
      ) : (
        props.hits.map((item) => (
          <Button
            key={item.session.id}
            variant="ghost"
            className={styles.similarItem}
            onClick={() => props.onOpen(item.session.id)}
          >
            <span className={styles.resultHead}>
              <span className={styles.resultTitle}>{item.session.title ?? `会话 ${item.session.id}`}</span>
              <Pill className={styles.semanticSimPill}>相似度 {formatPercent(item.similarity)}</Pill>
            </span>
            {item.sharedTerms.length > 0 ? (
              <span className={styles.semanticMatched}>
                <span className={styles.semanticMatchedLabel}>共有词</span>
                {item.sharedTerms.map((term) => (
                  <Pill key={term} className={styles.semanticMatchedTerm}>
                    {term}
                  </Pill>
                ))}
              </span>
            ) : null}
            {item.tags.length > 0 ? (
              <span className={styles.resultTags}>
                {item.tags.map((tag) => (
                  <Pill key={tag} className={styles.resultTag}>
                    {tag}
                  </Pill>
                ))}
              </span>
            ) : null}
          </Button>
        ))
      )}
    </div>
  )
}

/** 全局对话检索视图页。 */
export function SearchView(_props: SearchViewProps): ReactElement {
  const [mode, setMode] = useState<SearchMode>('keyword')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [allTags, setAllTags] = useState<readonly string[]>([])
  const [tagsError, setTagsError] = useState('')
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(new Set())
  const [hits, setHits] = useState<readonly SearchHit[]>([])
  const [semanticResult, setSemanticResult] = useState<SemanticSearchResponse | null>(null)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // “找相似”状态：similarFor 为当前展开相似折叠区的命中会话 id
  const [similarFor, setSimilarFor] = useState<string | null>(null)
  const [similarLoading, setSimilarLoading] = useState(false)
  const [similarHits, setSimilarHits] = useState<readonly SimilarSessionHit[]>([])
  const [similarScanned, setSimilarScanned] = useState(0)
  const [similarError, setSimilarError] = useState('')

  /** 日期区间本地校验：YYYY-MM-DD 格式可直接按字典序比较，from 晚于 to 时不发请求。 */
  const rangeInvalid = from.length > 0 && to.length > 0 && from > to

  /** 当前模式的命中条数（空态与“加载更多”的显隐判断共用）。 */
  const activeCount = mode === 'semantic' ? semanticResult?.hits.length ?? 0 : hits.length

  // 搜索框防抖：停止输入 300ms 后才触发检索
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  // 挂载时拉取全量标签（GET /tags 缺省 sessionId 返回 标签 → 会话列表 映射）
  useEffect(() => {
    let cancelled = false
    fetchAllTags()
      .then((response) => {
        if (!cancelled) setAllTags(Object.keys(response.tags))
      })
      .catch((err: unknown) => {
        if (!cancelled) setTagsError(err instanceof Error ? err.message : '标签加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 检索模式 / 条件或 limit 变化时重新请求（selectedTags 每次切换都是新 Set，引用变化即触发）
  useEffect(() => {
    // 日期区间仅关键词模式生效：from 晚于 to 时仅本地提示，不发起请求
    if (mode === 'keyword' && rangeInvalid) {
      setHits([])
      setError('起始日期不能晚于结束日期，请调整日期区间')
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    // 语义模式：复用同一搜索框与防抖查询；接口必须携带 query，空查询不发请求
    if (mode === 'semantic') {
      const trimmed = debouncedQuery.trim()
      if (trimmed.length === 0) {
        setSemanticResult(null)
        setLoading(false)
        return
      }
      searchSessionsSemantic({ query: trimmed, limit })
        .then((response) => {
          if (!cancelled) setSemanticResult(response)
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : '语义检索失败')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
      return () => {
        cancelled = true
      }
    }
    // 关键词模式：清空语义态，走既有 GET /search 词面检索流程
    setSemanticResult(null)
    searchSessions({
      query: debouncedQuery.trim() || undefined,
      from: from || undefined,
      to: to || undefined,
      tags: [...selectedTags],
      limit,
    })
      .then((response) => {
        if (!cancelled) setHits(response.hits)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '检索失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [mode, debouncedQuery, from, to, selectedTags, limit, rangeInvalid])

  /** 点击结果项：请求主平台跳转到该会话。
   *
   * 集成缝说明：主平台客户端监听 `companion:open-session` 自定义事件完成会话切换；
   * 插件不直接依赖平台内部导航 API，事件即两者之间唯一的导航契约（见 DESIGN.md 第 6 节）。
   */
  const openSession = useCallback((sessionId: string): void => {
    window.dispatchEvent(new CustomEvent('companion:open-session', { detail: { sessionId } }))
    Toast.push('已发送跳转请求', 'info')
  }, [])

  /** 切换标签筛选（点击 Pill）。 */
  const toggleTag = useCallback((tag: string): void => {
    setSelectedTags((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
    setLimit(PAGE_SIZE)
  }, [])

  /** 更新查询词并重置分页。 */
  const handleQueryChange = useCallback((value: string): void => {
    setQuery(value)
    setLimit(PAGE_SIZE)
  }, [])

  /** 更新起始日期并重置分页。 */
  const handleFromChange = useCallback((value: string): void => {
    setFrom(value)
    setLimit(PAGE_SIZE)
  }, [])

  /** 更新结束日期并重置分页。 */
  const handleToChange = useCallback((value: string): void => {
    setTo(value)
    setLimit(PAGE_SIZE)
  }, [])

  /** 切换检索模式：重置分页并收起“找相似”折叠区（查询词保留）。 */
  const handleModeChange = useCallback((next: SearchMode): void => {
    setMode(next)
    setLimit(PAGE_SIZE)
    setSimilarFor(null)
    setSimilarHits([])
    setSimilarScanned(0)
    setSimilarError('')
  }, [])

  /** 展开/收起某命中的“找相似”折叠区；展开时调 GET /search/similar 拉取。 */
  const toggleSimilar = useCallback(
    (sessionId: string): void => {
      if (similarFor === sessionId) {
        setSimilarFor(null)
        return
      }
      setSimilarFor(sessionId)
      setSimilarHits([])
      setSimilarScanned(0)
      setSimilarError('')
      setSimilarLoading(true)
      fetchSimilarSessions({ sessionId, limit: SIMILAR_LIMIT })
        .then((response) => {
          setSimilarHits(response.hits)
          setSimilarScanned(response.scannedSessions)
        })
        .catch((err: unknown) => {
          setSimilarError(err instanceof Error ? err.message : '相似会话查询失败')
        })
        .finally(() => setSimilarLoading(false))
    },
    [similarFor],
  )

  return (
    <div className={styles.view}>
      <header className={styles.toolbar}>
        <div className={styles.modeSwitch} role="group" aria-label="检索模式">
          <Button
            size="sm"
            variant={mode === 'keyword' ? 'primary' : 'secondary'}
            onClick={() => handleModeChange('keyword')}
          >
            关键词
          </Button>
          <Button
            size="sm"
            variant={mode === 'semantic' ? 'primary' : 'secondary'}
            onClick={() => handleModeChange('semantic')}
          >
            语义
          </Button>
        </div>
        <Input
          className={styles.searchInput}
          type="search"
          value={query}
          onChange={(event) => handleQueryChange(event.target.value)}
          placeholder={mode === 'semantic' ? '语义检索历史对话（shingle 邻域 + PRF 扩展）…' : '全局检索历史对话…'}
        />
        {mode === 'keyword' ? (
          <>
            <label className={styles.dateField}>
              <span>从</span>
              <Input type="date" value={from} onChange={(event) => handleFromChange(event.target.value)} />
            </label>
            <label className={styles.dateField}>
              <span>至</span>
              <Input type="date" value={to} onChange={(event) => handleToChange(event.target.value)} />
            </label>
            {rangeInvalid ? <span className={styles.error}>起始日期不能晚于结束日期</span> : null}
          </>
        ) : null}
      </header>

      {mode === 'semantic' ? (
        <p className={styles.semanticHint}>
          语义检索基于字符 shingle 邻域 + PRF 查询扩展 + RRF 融合，无需向量库；邻域索引覆盖最近 200 个会话
        </p>
      ) : null}

      {mode === 'keyword' ? (
        <div className={styles.tagRow}>
          {tagsError ? <span className={styles.error}>{tagsError}</span> : null}
          {!tagsError && allTags.length === 0 ? <span className={styles.muted}>暂无标签</span> : null}
          {allTags.map((tag) => (
            // Pill 原语不支持键盘交互属性（PillProps 未开放 role/tabIndex/onKeyDown），
            // 故以外层 span 补齐 role="button"、tabIndex 与 Enter/Space 键激活。
            <span
              key={tag}
              role="button"
              tabIndex={0}
              aria-pressed={selectedTags.has(tag)}
              onClick={() => toggleTag(tag)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  toggleTag(tag)
                }
              }}
            >
              <Pill className={selectedTags.has(tag) ? styles.tagActive : styles.tag}>{tag}</Pill>
            </span>
          ))}
        </div>
      ) : null}

      <div className={styles.results}>
        {mode === 'semantic' && semanticResult !== null ? <SemanticSummary result={semanticResult} /> : null}
        {loading && activeCount === 0 ? <Spinner label="检索中…" /> : null}
        {error ? <div className={styles.error}>{error}</div> : null}
        {!loading && !error && activeCount === 0 ? (
          <div className={styles.empty}>
            {mode === 'semantic'
              ? debouncedQuery.trim().length === 0
                ? '输入关键词开始语义检索'
                : '没有语义相关的对话，试试换个说法或关键词'
              : '没有匹配的对话，试试调整关键词、日期或标签'}
          </div>
        ) : null}

        {mode === 'keyword'
          ? hits.map((hit) => (
              <Button
                key={hit.session.id}
                variant="ghost"
                className={styles.resultItem}
                onClick={() => openSession(hit.session.id)}
              >
                <span className={styles.resultHead}>
                  <span className={styles.resultTitle}>{hit.session.title ?? `会话 ${hit.session.id}`}</span>
                  <span className={styles.resultTime}>
                    {formatTime(hit.session.updatedAt ?? hit.session.createdAt)}
                  </span>
                </span>
                {hit.snippet ? <span className={styles.resultSnippet}>{hit.snippet}</span> : null}
                {hit.tags.length > 0 ? (
                  <span className={styles.resultTags}>
                    {hit.tags.map((tag) => (
                      <Pill key={tag} className={styles.resultTag}>
                        {tag}
                      </Pill>
                    ))}
                  </span>
                ) : null}
              </Button>
            ))
          : (semanticResult?.hits ?? []).map((hit) => (
              <div key={hit.session.id} className={styles.semanticItem}>
                <Button
                  variant="ghost"
                  className={styles.resultItem}
                  onClick={() => openSession(hit.session.id)}
                >
                  <span className={styles.resultHead}>
                    <span className={styles.resultTitle}>{hit.session.title ?? `会话 ${hit.session.id}`}</span>
                    <span className={styles.resultTime}>
                      <span className={styles.semanticBadges}>
                        <span className={styles.semanticScore}>RRF {hit.score.toFixed(3)}</span>
                        {hit.neighborhoodSimilarity > 0 ? (
                          <Pill className={styles.semanticSimPill}>
                            邻域 {formatPercent(hit.neighborhoodSimilarity)}
                          </Pill>
                        ) : null}
                      </span>
                      {formatTime(hit.session.updatedAt ?? hit.session.createdAt)}
                    </span>
                  </span>
                  {hit.snippet ? <span className={styles.resultSnippet}>{hit.snippet}</span> : null}
                  {hit.tags.length > 0 ? (
                    <span className={styles.resultTags}>
                      {hit.tags.map((tag) => (
                        <Pill key={tag} className={styles.resultTag}>
                          {tag}
                        </Pill>
                      ))}
                    </span>
                  ) : null}
                  {hit.matchedExpansionTerms.length > 0 ? (
                    <span className={styles.semanticMatched}>
                      <span className={styles.semanticMatchedLabel}>扩展词命中</span>
                      {hit.matchedExpansionTerms.map((term) => (
                        <Pill key={term} className={styles.semanticMatchedTerm}>
                          {term}
                        </Pill>
                      ))}
                    </span>
                  ) : null}
                </Button>
                <div className={styles.semanticItemBar}>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={similarLoading && similarFor === hit.session.id}
                    onClick={() => toggleSimilar(hit.session.id)}
                  >
                    {similarLoading && similarFor === hit.session.id ? (
                      <Spinner label="查找中…" />
                    ) : similarFor === hit.session.id ? (
                      '收起相似'
                    ) : (
                      '找相似'
                    )}
                  </Button>
                </div>
                {similarFor === hit.session.id ? (
                  <SimilarSessionsBox
                    loading={similarLoading}
                    hits={similarHits}
                    scanned={similarScanned}
                    error={similarError}
                    onClose={() => setSimilarFor(null)}
                    onOpen={openSession}
                  />
                ) : null}
              </div>
            ))}

        {loading && activeCount > 0 ? <Spinner label="加载更多…" /> : null}
        {!loading && !error && activeCount >= limit ? (
          <div className={styles.more}>
            <Button variant="secondary" onClick={() => setLimit((prev) => prev + PAGE_SIZE)}>
              加载更多
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
