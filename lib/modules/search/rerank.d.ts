/**
 * 模块 D 创新扩展：点击反馈学习重排序（Click-Feedback Learning to Rank）。
 *
 * 检索引擎打分的上限是「文本相似」，而用户真正想找什么只有点击知道。
 * Web 搜索二十年的一条铁律：点击日志是最后的裁判（Joachims 2002 起
 * 的点击模型谱系）。本模块把这条方法论搬进会话检索：
 *
 * 1. 展示即曝光：每次 /search/rerank 返回结果时记录一条展示事件
 *    （query + 按位次排列的会话清单）——没有曝光计数，点击率无从谈起；
 * 2. 逆倾向加权（IPW）去位置偏：用户几乎总点前几条，不是因为更相关，
 *    而是因为更靠前（position bias）。按级联检验假设，位次 r 的被检
 *    验概率 π_r ≈ 1/log₂(r+2)：
 *    - 曝光按 π_r 折算为「期望检验数」（有效曝光）；
 *    - 点击按 1/π_r 加权为「无偏点击证据」（低位次点击更难得，证据更强）；
 *    二者之比即 Horvitz-Thompson 无偏相关度估计；
 * 3. 贝叶斯平滑：rate = (有效点击 + α·全局率) / (有效曝光 + α)——
 *    冷启动会话不会因一次幸运点击登顶，全局先验兜底；
 * 4. 术语泛化：新查询未必与历史查询字面相同。把查询分解为词元
 *    （拉丁词 + CJK 二元组），在词元层累积同一套无偏统计——
 *    查「部署流水线」能吃到历史查「部署」攒下的点击证据；
 * 5. 融合重排：final = w·点击相关度 + (1−w)·引擎位次置信
 *    （1/log₂(rank+1)，DCG 折扣）——点击信号修正引擎，而非取代引擎；
 * 6. 可解释输出：每条结果附带原始位次/新位次/证据说明
 *    （「查询「部署」下 3 次有效点击 / 5.1 次有效曝光」），
 *    重排不再是黑箱。
 */
import type { Domain } from '../../core/storage-adapter.js';
import type { SessionRecord } from '../../types/harness.js';
import type { SearchHit } from './service.js';
/** 点击信号默认融合权重。 */
export declare const DEFAULT_CLICK_WEIGHT = 0.6;
/** 点击/展示事件（'search-clicks' 表，键为事件 id）。 */
export interface ClickEventRecord {
    readonly kind: 'click' | 'impression';
    readonly ts: number;
    /** 归一化后的查询文本。 */
    readonly query: string;
    /** click：被点击的会话 id。 */
    readonly sessionId: string;
    /** click：点击位次（1 起）。 */
    readonly position: number;
    /** impression：本次展示的会话 id 序列（按位次）。 */
    readonly shown: readonly string[];
}
/** 点击反馈事件仓库。 */
export declare class ClickFeedbackStore {
    private readonly table;
    private counter;
    constructor(domain: Domain);
    /** 记录一次展示（rerank 返回结果时调用）。 */
    recordImpression(query: string, shown: readonly string[]): Promise<void>;
    /** 记录一次点击（位次从 1 起）。 */
    recordClick(query: string, sessionId: string, position: number): Promise<void>;
    private put;
    /** 全部事件（时间升序）。 */
    events(): ClickEventRecord[];
    /** 滚动修剪（保留最近 EVENT_KEEP_LIMIT 条）。 */
    trim(): Promise<void>;
    clear(): Promise<void>;
}
/** 查询归一化：小写 + 压空白。 */
export declare function normalizeQuery(query: string): string;
/**
 * 词元化：拉丁字母数字词 + CJK 二元组（unigram 噪声太大，二元组是
 * 中文检索的工业惯例）。短于 2 的拉丁词丢弃。
 */
export declare function tokenizeQuery(query: string): string[];
/** （查询或词元 × 会话）聚合统计。 */
interface SessionStats {
    /** 有效曝光（Σ 检验倾向 π_r）。 */
    effectiveImpressions: number;
    /** 有效点击（Σ 1/π_r，无偏证据）。 */
    effectiveClicks: number;
    clicks: number;
    lastClickedAt: number;
}
/** 去位置偏点击模型。 */
export interface ClickModel {
    readonly eventCount: number;
    /** 全局无偏点击率（有效点击 / 有效曝光）。 */
    readonly globalRate: number;
    /** 精确查询 → 会话统计。 */
    readonly queryStats: ReadonlyMap<string, ReadonlyMap<string, SessionStats>>;
    /** 词元 → 会话统计（泛化到未见查询）。 */
    readonly termStats: ReadonlyMap<string, ReadonlyMap<string, SessionStats>>;
    /** 学到过证据的会话总数。 */
    readonly knownSessions: number;
}
/**
 * 从事件流学习点击模型（IPW 去偏 + 查询/词元双通道聚合）。
 */
export declare function learnClickModel(events: readonly ClickEventRecord[]): ClickModel;
/** 会话级点击相关度打分结果。 */
export interface ClickScoreResult {
    /** 平滑后的无偏点击相关度 ∈ [0, 1]。 */
    readonly score: number;
    /** 证据说明（可展示）。 */
    readonly reason: string;
    /** 证据来源：'query'（精确查询）| 'term'（词元泛化）| 'none'。 */
    readonly evidence: 'query' | 'term' | 'none';
}
/**
 * 为（query, session）计算点击相关度：
 * 精确查询通道优先（证据最直接），否则词元通道取最强信号，
 * 均无证据返回 0（退化为纯引擎位次）。
 */
export declare function clickScore(model: ClickModel, query: string, sessionId: string): ClickScoreResult;
/** 单条重排结果。 */
export interface RerankEntry {
    readonly session: SessionRecord;
    readonly snippet?: string;
    readonly tags: readonly string[];
    readonly originalRank: number;
    readonly newRank: number;
    readonly clickScore: number;
    /** 融合分（点击 w + 位次 1−w）。 */
    readonly finalScore: number;
    readonly reason: string;
}
/** 重排报告。 */
export interface RerankReport {
    readonly query: string;
    /** 点击模型是否有任何可泛化的证据。 */
    readonly learned: boolean;
    /** 是否发生了顺序变化。 */
    readonly reordered: boolean;
    readonly entries: readonly RerankEntry[];
    readonly clickWeight: number;
}
/**
 * 点击反馈重排：final = w·clickScore + (1−w)·1/log₂(rank+1)。
 * 点击证据缺位时自动退化为引擎原序（w 项全为 0 时按原序稳定输出）。
 */
export declare function rerankHits(hits: readonly SearchHit[], model: ClickModel, query: string, weight?: number): RerankReport;
/** 点击模型统计面板。 */
export interface ClickModelStats {
    readonly eventCount: number;
    readonly knownSessions: number;
    readonly globalRate: number;
    readonly distinctQueries: number;
    readonly vocabularySize: number;
    /** 全局最强的会话信号（跨词元聚合的有效点击，降序前 10）。 */
    readonly topSessions: readonly {
        readonly sessionId: string;
        readonly effectiveClicks: number;
        readonly clicks: number;
        readonly lastClickedAt: number;
    }[];
}
/** 汇总模型面板（top 会话跨词元聚合）。 */
export declare function clickModelStats(model: ClickModel): ClickModelStats;
export {};
