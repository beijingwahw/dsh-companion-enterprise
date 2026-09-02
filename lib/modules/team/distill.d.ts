/**
 * 模块 I 创新扩展：经验自动蒸馏（从会话轨迹挖矿可复用经验卡）。
 *
 * 现实痛点：执行经验库依赖人工撰写——但真正有价值的"教训"
 * （踩过的坑、修复手法、环境特异性）都埋在会话轨迹里，任务结束即遗忘。
 * 团队的 institutional knowledge 随成员离开而蒸发，新人重踩同样的坑。
 *
 * 方案：四段式蒸馏管线，全自动、可回溯、防噪：
 *
 * 1. 信号挖矿（本地启发式，零模型成本）：扫描会话转录，识别"错误→修复"
 *    结构对——错误信号（error/exception/失败/报错…）之后跟随修复信号
 *    （解决/修复/成功/works…）的轮次对，按错误严重度、修复距离、用户
 *    确认强度打分。低信号会话直接跳过，模型调用只花在高价值轨迹上；
 *
 * 2. 元提示蒸馏（模型侧结构化生成）：把最高分信号的错误-修复上下文
 *    窗口交给模型，产出 JSON 经验卡（一句话教训 + 问题模式 + 解决方案
 *    模式 + 标签）——教训必须具体可执行，拒绝"要仔细检查"式空话；
 *
 * 3. 语义去重合并（本地）：新卡与既有卡做 token Jaccard 相似度比对，
 *    超过阈值不新建而是合并——occurrences +1、lastSeenAt 更新、来源
 *    会话累积。复发度是经验价值的黄金标准：同一教训在多个会话反复
 *    出现，几乎必然是真实可复用的知识；一次性出现更可能是噪声；
 *
 * 4. 证据链回溯（防幻觉）：每张卡保留来源会话与错误/修复轮次的原文
 *    摘录（含 seq 定位），任何蒸馏出的"教训"都能回读原始轨迹核实，
 *    蒸馏幻觉无处遁形。
 */
import type { Domain } from '../../core/storage-adapter.js';
import type { TranscriptTurn } from '../../core/transcript.js';
/** 信号挖矿最多回看轮次（长会话取尾部，控制本地计算量）。 */
export declare const MINING_TURN_CAP = 300;
/** 信号得分低于该值的会话不值得蒸馏（批量扫描的缺省门槛）。 */
export declare const DEFAULT_MIN_SIGNAL = 0.45;
/** 语义去重 Jaccard 阈值：超过即合并而非新建。 */
export declare const DEDUP_JACCARD_THRESHOLD = 0.55;
/** 蒸馏卡滚动保留上限。 */
export declare const DISTILLED_CARD_LIMIT = 200;
/** 挖矿信号：一对错误→修复轮次及其得分与证据。 */
export interface MiningSignal {
    /** 错误轮次（transcript 下标）。 */
    readonly errorIndex: number;
    /** 修复轮次（transcript 下标）。 */
    readonly recoveryIndex: number;
    /** 得分 0-1（严重度 0.35 + 距离 0.25 + 修复明确度 0.25 + 用户确认 0.15）。 */
    readonly score: number;
    /** 错误轮 seq（证据定位）。 */
    readonly errorSeq: number;
    /** 修复轮 seq（证据定位）。 */
    readonly recoverySeq: number;
    /** 错误摘录（截断）。 */
    readonly errorExcerpt: string;
    /** 修复摘录（截断）。 */
    readonly recoveryExcerpt: string;
    /** 上下文窗口（错误→修复的全部轮次，已截断）。 */
    readonly context: readonly TranscriptTurn[];
}
/**
 * 信号挖矿主入口：识别转录中全部不重叠的错误→修复结构对，
 * 按得分降序返回。得分构成：
 * - 严重度（0.35）：错误轮中错误词重复出现，越多越严重（3 次封顶）；
 * - 因果距离（0.25）：修复距错误越近越可能因果相关；
 * - 修复明确度（0.25）：明确"解决/修复/fixed"强于仅"不再报错"；
 * - 用户确认（0.15）：中间有用户正面确认，最强的人工验证信号。
 */
export declare function mineSignals(turns: readonly TranscriptTurn[]): MiningSignal[];
/** 蒸馏元提示：从错误-修复上下文产出结构化经验卡。 */
export declare function buildDistillPrompt(signal: MiningSignal): string;
/** 蒸馏产物（模型 JSON 输出收窄后的形状）。 */
export interface DistilledContent {
    readonly title: string;
    readonly lesson: string;
    readonly problem: string;
    readonly solution: string;
    readonly tags: readonly string[];
}
/**
 * 容错解析模型输出：剥可能的代码栅栏、截取首个 `{` 到末个 `}`、
 * JSON.parse 后逐字段收窄（title/lesson/problem/solution 必须非空，
 * tags 剔除非字符串项并封顶 5 个）。解析失败抛 Error（调用方转 502）。
 */
export declare function parseDistilledCard(raw: string): DistilledContent;
/** token 集合 Jaccard 相似度（0-1）。 */
export declare function jaccardTokens(a: string, b: string): number;
/** 证据条目：来源轮次定位 + 原文摘录。 */
export interface EvidenceEntry {
    /** 会话日志事件 seq（回读定位）。 */
    readonly seq: number;
    /** 'error' | 'recovery'。 */
    readonly kind: 'error' | 'recovery';
    readonly excerpt: string;
}
/** 蒸馏经验卡（存储记录形状）。 */
export interface DistilledCard {
    readonly id: string;
    /** 首次蒸馏来源会话。 */
    readonly sessionId: string;
    /** 全部来源会话（合并时累积；扫描据此跳过已处理会话）。 */
    sourceSessions: string[];
    readonly createdAt: number;
    /** 最近一次复发时间。 */
    lastSeenAt: number;
    /** 出现次数（复发度：跨会话反复出现 = 高置信知识）。 */
    occurrences: number;
    /** 首次挖矿信号得分（0-1）。 */
    readonly signalScore: number;
    readonly title: string;
    readonly lesson: string;
    readonly problem: string;
    readonly solution: string;
    readonly tags: readonly string[];
    /** 证据链：错误/修复轮次摘录。 */
    readonly evidence: readonly EvidenceEntry[];
    /** 是否已晋升为正式执行卡。 */
    promoted: boolean;
}
/**
 * 置信度：复发度为主（出现 3 次即满格——跨会话复发是经验真实性的
 * 最强证据），信号强度为辅。0-1。
 */
export declare function confidenceOf(card: DistilledCard): number;
/** 蒸馏卡仓库：'distilled-cards' 表，键为卡片 id。 */
export declare class DistilledCardStore {
    private readonly table;
    constructor(domain: Domain);
    /** 全部卡片（按置信度降序，同置信度按复发时间降序）。 */
    list(): DistilledCard[];
    get(id: string): DistilledCard | undefined;
    delete(id: string): Promise<void>;
    /** 会话是否已有蒸馏记录（批量扫描跳过依据）。 */
    hasSession(sessionId: string): boolean;
    /**
     * 语义去重写入：与既有卡 Jaccard 超阈值 → 合并（occurrences +1、
     * lastSeenAt 更新、来源会话累积；蒸馏内容保留首版，防逐次改写漂移）；
     * 否则新建。返回写入结果与是否走了合并。
     */
    dedupPut(content: DistilledContent, signal: MiningSignal, sessionId: string): Promise<{
        card: DistilledCard;
        merged: boolean;
    }>;
    /** 标记已晋升。 */
    markPromoted(id: string): Promise<DistilledCard | undefined>;
    /** 滚动修剪：按 lastSeenAt 保留最近 DISTILLED_CARD_LIMIT 张。 */
    private trim;
}
