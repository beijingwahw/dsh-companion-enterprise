/**
 * 模块 B 创新扩展：结构化分级交接 + 世系链（Tiered Handoff + Lineage）。
 *
 * 现实痛点：交接摘要是一整段自由文本——"一揽子"交接。两个致命缺陷：
 *
 * 1. 信息无分级：核心决策与已完成琐事以同样的信息密度传递。新会话
 *    token 预算紧张时整体截断，最先蒸发的往往是"必须遵守的约束"；
 *    而已完成的事项却占着篇幅，导致下一代重复劳动或走回头路。
 *
 * 2. 传话游戏（generation loss）：会话 A → 摘要 → 会话 B → 摘要 →
 *    会话 C……关键约束逐代改写、衰减、最终静默消失，且没有任何机制
 *    察觉"这条约束去哪了"。多轮交接后没有人能回答"我当前的上下文
 *    传承自哪里、经过了几次转述"。
 *
 * 方案（借鉴数据库级联完整性约束的思想，引入 LLM 上下文传承）：
 *
 * 1. 四级信息分层（tier）：交接文档结构化为四个信息层级——
 *    - anchors（锚定）：不可丢失的硬约束/已定决策/关键前提。丢失
 *      代价最高，注入时配"不得违反"的强指令；
 *    - active（活动）：进行中的工作、下一步、开放问题；
 *    - reference（参考）：关键路径/命令/ID/链接；
 *    - archived（归档）：已完成事项的一句话记录（防重复劳动，
 *      注入时压缩为单行清单）。
 *
 * 2. 锚定项强制继承（anchor inheritance）：生成第 N+1 代交接时，
 *    第 N 代的全部锚定项作为输入交给模型，模型必须逐条显式处置——
 *    inherited（继承）/ evolved（演进，约束已变化）/ dropped（废弃，
 *    必须附理由）。生成后程序化守门校验：凡模型未处置、或声称继承
 *    却在新文档中找不到对应项的锚定，一律自动补回（autoRestored）。
 *    静默丢失在结构上不可能——这是与自由文本交接的本质区别。
 *
 * 3. 世系链（lineage）：每次结构化交接分配全局唯一 handoffId，记录
 *    parentHandoffId 与祖先链，形成可溯源的传承 DAG。深度超过阈值
 *    时注入告警（"上下文已传承 N 代，建议回读源头会话"）——对抗
 *    传话游戏损耗的可观测性抓手。
 */
import type { Domain } from '../../core/storage-adapter.js';
/** 世系深度告警阈值：超过该代数的注入文本携带"回读源头"告警。 */
export declare const LINEAGE_DEPTH_WARN_THRESHOLD = 3;
/** 锚定项（TIER 1）：不可丢失的硬约束/决策/前提。 */
export interface AnchorItem {
    /** 稳定内容哈希（跨代比对用）。 */
    readonly hash: string;
    /** 约束文本。 */
    readonly text: string;
    /** 本代新增（null）或继承来源交接 id。 */
    readonly origin: string | null;
    /** 是否为守门校验自动补回的项。 */
    readonly autoRestored: boolean;
}
/** 活动项（TIER 2）：进行中/下一步/开放问题。 */
export interface ActiveItem {
    readonly kind: 'in_progress' | 'next' | 'open_question';
    readonly text: string;
}
/** 参考项（TIER 3）：路径/命令/ID/链接。 */
export interface ReferenceItem {
    readonly kind: 'path' | 'command' | 'id' | 'link' | 'other';
    readonly text: string;
}
/** 归档项（TIER 4）：已完成事项一句话记录。 */
export interface ArchivedItem {
    readonly text: string;
}
/** 父代锚定项的处置记录（显式继承/演进/废弃）。 */
export interface AnchorDisposition {
    /** 父代锚定项哈希。 */
    readonly anchorHash: string;
    /** 父代锚定项文本（留档，便于审计"废弃了什么"）。 */
    readonly anchorText: string;
    readonly action: 'inherited' | 'evolved' | 'dropped';
    /** dropped/evolved 的理由（模型输出或守门默认说明）。 */
    readonly reason?: string;
}
/** 完整结构化交接文档（存储记录形状）。 */
export interface StructuredHandoff {
    readonly handoffId: string;
    readonly parentHandoffId: string | null;
    /** 交接源会话（从哪个会话的对话生成）。 */
    readonly sourceSessionId: string;
    readonly createdAt: number;
    /** 世系深度（初代 = 0）。 */
    readonly depth: number;
    /** 祖先链（从根到父，不含自身）。 */
    readonly lineage: readonly string[];
    readonly tiers: {
        readonly anchors: readonly AnchorItem[];
        readonly active: readonly ActiveItem[];
        readonly reference: readonly ReferenceItem[];
        readonly archived: readonly ArchivedItem[];
    };
    /** 对父代锚定项的全部处置（含守门补回说明）。 */
    readonly dispositions: readonly AnchorDisposition[];
    /** 已注入到哪些会话（投递轨迹）。 */
    readonly deliveredTo: readonly string[];
}
/** FNV-1a 32 位哈希（十六进制；用于跨代锚定比对，非密码学用途）。 */
export declare function fnv1a(text: string): string;
/** 文本归一化：小写、去全部空白与常见标点（跨代表述比对的宽容基础）。 */
export declare function normalizeText(text: string): string;
/**
 * 锚定项相似判定：归一化后相等，或（长度足够时）一方包含另一方。
 * 模型逐代改写措辞时哈希必然变化，靠包含关系识别"同一约束的新表述"。
 */
export declare function anchorSimilar(a: string, b: string): boolean;
/** 生成结构化交接的元提示（要求模型输出严格 JSON）。 */
export declare function buildStructuredHandoffPrompt(conversation: string, parent: StructuredHandoff | null): string;
/** 模型输出的原始 JSON 形状（宽松：字段可缺、kind 可越界）。 */
interface RawHandoff {
    anchors?: unknown;
    active?: unknown;
    reference?: unknown;
    archived?: unknown;
    parentAnchorDispositions?: unknown;
}
/**
 * 容错解析模型输出：剥可能的 markdown 代码栅栏、截取首个 `{` 到末个 `}`、
 * JSON.parse 失败时抛出带原因的错误（调用方转 502）。
 */
export declare function parseStructuredHandoff(raw: string): RawHandoff;
/** 守门校验产物：新锚定数组 + 全部处置记录。 */
export interface GatekeepingResult {
    anchors: AnchorItem[];
    dispositions: AnchorDisposition[];
    /** 守门自动补回的锚定数（可观测性指标）。 */
    autoRestoredCount: number;
}
/**
 * 锚定继承守门：对父代每个锚定项执行强制继承校验。
 *
 * 判定顺序（保真优先——存疑一律补回）：
 * 1. 模型处置为 dropped 且给了理由 → 允许废弃（记录在案，可审计）；
 * 2. 其余情形（inherited/evolved/完全遗漏）在新 anchors 中找相似项：
 *    找到 → 标记继承/演进（origin 指向父代交接）；
 *    找不到 → 自动补回父代原文（autoRestored=true，reason 说明守门来源）。
 */
export declare function enforceAnchorInheritance(parent: StructuredHandoff | null, newAnchorTexts: readonly string[], modelDispositions: readonly {
    anchorText: string;
    action: string;
    reason?: string;
}[]): GatekeepingResult;
/** 生成新的交接 handoffId（hd_ 前缀 + base36 时间戳 + 随机后缀）。 */
export declare function newHandoffId(): string;
/**
 * 从模型输出组装完整的 StructuredHandoff（解析 → 收窄 → 守门 → 世系组装）。
 * 任何一级失败都抛 Error（HTTP 层转错误响应），绝不静默降级为半成品。
 */
export declare function assembleStructuredHandoff(rawModelOutput: string, parent: StructuredHandoff | null, sourceSessionId: string): {
    handoff: StructuredHandoff;
    autoRestoredCount: number;
};
/** 注入文本中的世系标记行（装配回调据此回写投递轨迹）。 */
export declare const LINEAGE_MARKER_PATTERN: RegExp;
/**
 * 渲染为系统提示词注入文本：分层呈现，TIER 1 配强指令与世袭标注，
 * TIER 4 压缩为单行清单；深度超阈值时附"回读源头"告警。
 * 首行携带世系标记（LINEAGE_MARKer_PATTERN 可解析），供投递回写。
 */
export declare function renderStructuredForInjection(handoff: StructuredHandoff): string;
/** 世系链条目（列表视图：列表页不返回全文，只返回摘要性字段）。 */
export interface LineageSummary {
    readonly handoffId: string;
    readonly parentHandoffId: string | null;
    readonly sourceSessionId: string;
    readonly createdAt: number;
    readonly depth: number;
    readonly anchorCount: number;
    readonly activeCount: number;
    readonly archivedCount: number;
    readonly autoRestoredCount: number;
    readonly droppedCount: number;
    readonly deliveredTo: readonly string[];
}
/** 世系链存储：handoff-structured 表，键为 handoffId。 */
export declare class LineageStore {
    private readonly table;
    constructor(domain: Domain);
    /** 保存交接记录并滚动修剪（按创建时间保留最近 LINEAGE_KEEP_LIMIT 条）。 */
    save(handoff: StructuredHandoff): Promise<void>;
    /** 按 id 读取（不存在返回 undefined）。 */
    get(handoffId: string): StructuredHandoff | undefined;
    /** 记录投递：把目标会话追加到 deliveredTo（去重）。 */
    markDelivered(handoffId: string, sessionId: string): Promise<void>;
    /** 全部记录的摘要视图（按创建时间降序）。 */
    listSummaries(): LineageSummary[];
    /** 查找注入到指定会话的最近一次交接（作为该会话生成交接时的父代）。 */
    findLatestDeliveredTo(sessionId: string): StructuredHandoff | undefined;
    /**
     * 从指定交接向上溯源到根（含自身，按世代从新到旧）。
     * 祖先记录已被修剪掉时链在此截断（返回已收集部分 + truncated 标记）。
     */
    trace(handoffId: string): {
        chain: StructuredHandoff[];
        truncated: boolean;
    };
}
export {};
