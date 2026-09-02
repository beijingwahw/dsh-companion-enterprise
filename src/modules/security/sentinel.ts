/**
 * 模块 J6：攻击者画像与渐进防御（Adaptive Threat Sentinel）。
 *
 * 一次性检测（injection.ts）只看当前这条输入——攻击者完全可以
 * 「试探性慢攻」：每次只投递低风险载荷（单次 suspicious），永远
 * 摸不到严格模式的 malicious 拦截线。入侵检测系统（IDS）的经典
 * 应对是「会话画像」：把离散事件聚合为行为轨迹。
 *
 * 哨兵机制：
 * - 每个攻击源（调用方 source / 扫描会话）维护一个画像；
 * - 风险分指数衰减累积（半衰期 24h）：连续投递会快速堆分，
 *   隔几天再来一次旧账已翻篇——攻击频率本身成为信号；
 * - 三级防御：normal（<40 常规告警）→ watch（40~70 高危告警，
 *   suspicious 也拦截）→ quarantined（≥70 全链路强制拦截 +
 *   非清洁输入一票否决）；
 * - 事件滚动保留最近 20 条，画像可通过 reset 平反（误报可回滚）。
 */
import type { Domain } from '../../core/storage-adapter.js'

/** 风险分半衰期（毫秒，24 小时）。 */
export const RISK_HALF_LIFE_MS = 24 * 3_600_000

/** 画像滚动保留的最近事件数。 */
export const EVENT_LIMIT = 20

/** watch 阈值。 */
export const WATCH_THRESHOLD = 40

/** quarantined 阈值。 */
export const QUARANTINE_THRESHOLD = 70

/** 画像等级。 */
export type SentinelLevel = 'normal' | 'watch' | 'quarantined'

/** 单次攻击事件记录。 */
export interface SentinelEvent {
  readonly ts: number
  /** 当时注入判定的风险分。 */
  readonly risk: number
  /** 判定档位。 */
  readonly verdict: 'suspicious' | 'malicious'
  /** 命中类别（如「指令覆写×2、角色越狱」）。 */
  readonly categories: string
}

/** 攻击源画像。 */
export interface ThreatProfile {
  /** 攻击源标识（调用 source / 会话 id）。 */
  readonly source: string
  /** 衰减后的当前风险分（0~∞，展示时封顶 100）。 */
  score: number
  /** 首次记录时间。 */
  readonly firstSeenAt: number
  /** 最近记录时间。 */
  lastSeenAt: number
  /** 累计事件数（含已滚动淘汰的）。 */
  totalEvents: number
  /** 恶意判定（malicious）累计次数。 */
  maliciousCount: number
  /** 最近事件（新→旧，≤ EVENT_LIMIT 条）。 */
  events: SentinelEvent[]
}

/** 画像报表条目（含实时等级与衰减分）。 */
export interface ThreatProfileReport extends ThreatProfile {
  readonly level: SentinelLevel
  /** 展示分（0~100 封顶）。 */
  readonly displayScore: number
  /** 距离下一次自然衰减到下一等级的小时数（已隔离时为 null）。 */
  readonly hoursToDowngrade: number | null
}

/** 衰减：按经过时间折算历史分。 */
function decay(score: number, elapsedMs: number): number {
  if (score <= 0 || elapsedMs <= 0) return score
  return score * Math.pow(0.5, elapsedMs / RISK_HALF_LIFE_MS)
}

/** 由当前分值判定等级。 */
export function levelOf(score: number): SentinelLevel {
  if (score >= QUARANTINE_THRESHOLD) return 'quarantined'
  if (score >= WATCH_THRESHOLD) return 'watch'
  return 'normal'
}

/** 降到下一等级需要经过的小时数（衰减推演）。 */
function hoursToDowngrade(score: number): number | null {
  const target =
    levelOf(score) === 'quarantined' ? WATCH_THRESHOLD : levelOf(score) === 'watch' ? 0 : null
  if (target === null || score <= target) return null
  // score * 0.5^(h/24) = target → h = 24 * log2(score/target)
  return Math.round((24 * Math.log2(score / target)) * 10) / 10
}

/**
 * 哨兵画像仓库（sentinel-profiles 表，key = source）。
 */
export class SentinelStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<ThreatProfile>('sentinel-profiles')
  }

  /** 记录一次注入命中事件（指数衰减累积 + 滚动事件）。 */
  async record(
    source: string,
    event: SentinelEvent,
  ): Promise<ThreatProfileReport> {
    const now = event.ts
    const prev = this.table.get(source)
    const prevScore = prev ? decay(prev.score, now - prev.lastSeenAt) : 0
    const next: ThreatProfile = {
      source,
      score: prevScore + event.risk,
      firstSeenAt: prev?.firstSeenAt ?? now,
      lastSeenAt: now,
      totalEvents: (prev?.totalEvents ?? 0) + 1,
      maliciousCount: (prev?.maliciousCount ?? 0) + (event.verdict === 'malicious' ? 1 : 0),
      events: [event, ...(prev?.events ?? [])].slice(0, EVENT_LIMIT),
    }
    await this.table.put(source, next)
    return this.toReport(next)
  }

  /** 读取画像（含实时衰减后的等级）。 */
  get(source: string): ThreatProfileReport | undefined {
    const profile = this.table.get(source)
    if (!profile) return undefined
    // 实时衰减：查询时的等效分。
    const score = decay(profile.score, Date.now() - profile.lastSeenAt)
    return this.toReport({ ...profile, score })
  }

  /** 全部画像（新→旧）。 */
  list(): ThreatProfileReport[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((profile) => {
        const score = decay(profile.score, Date.now() - profile.lastSeenAt)
        return this.toReport({ ...profile, score })
      })
  }

  /** 重置指定画像或全部画像（误报平反）。 */
  async reset(source?: string): Promise<void> {
    if (source !== undefined) {
      await this.table.delete(source)
      return
    }
    for (const [key] of this.table.entries()) {
      await this.table.delete(key)
    }
  }

  /** 画像 → 报表（等级 + 展示分 + 降级倒计时）。 */
  private toReport(profile: ThreatProfile): ThreatProfileReport {
    return {
      ...profile,
      level: levelOf(profile.score),
      displayScore: Math.min(100, Math.round(profile.score)),
      hoursToDowngrade: hoursToDowngrade(profile.score),
    }
  }
}

/**
 * 哨兵防御决策：给定画像等级与本次扫描判定，决定是否强制拦截。
 *
 * 规则（在 injection 设置的严格模式之外叠加）：
 * - quarantined：任何非 clean 输入一票否决（403）；
 * - watch：suspicious 及以上拦截；
 * - normal：维持既有策略（仅严格模式 malicious 拦截）。
 */
export function sentinelShouldBlock(
  level: SentinelLevel,
  verdict: 'clean' | 'suspicious' | 'malicious',
): boolean {
  if (verdict === 'clean') return false
  if (level === 'quarantined') return true
  if (level === 'watch') return verdict === 'suspicious' || verdict === 'malicious'
  return false
}
