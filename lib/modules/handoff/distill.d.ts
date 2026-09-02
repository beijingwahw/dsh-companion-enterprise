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
import type { TranscriptTurn } from '../../core/transcript.js';
/** 近端原文区缺省轮数。 */
export declare const DEFAULT_RECENT_TURNS = 6;
/** 总字符预算缺省值。 */
export declare const DEFAULT_CHAR_BUDGET = 8000;
/** 事实类别。 */
export type FactKind = 'constraint' | 'decision' | 'action' | 'reference' | 'metric';
/** 蒸馏出的事实。 */
export interface DistilledFact {
    readonly kind: FactKind;
    /** 来源角色（用户/助手）。 */
    readonly role: 'user' | 'assistant' | 'system' | 'tool';
    readonly text: string;
}
/**
 * 从远端轮次抽取事实（近者优先覆盖：从最新句子向前扫，
 * 同类上限内先到先得——最新的约束/决策总是能占住坑位）。
 */
export declare function extractFacts(turns: readonly TranscriptTurn[]): DistilledFact[];
/** 蒸馏统计（可观测性）。 */
export interface DistillStats {
    readonly totalTurns: number;
    /** 近端原文区实际保留轮数（预算允许时 = 请求轮数）。 */
    readonly verbatimTurns: number;
    /** 远端蒸馏区轮数。 */
    readonly distilledTurns: number;
    readonly factCount: number;
    /** 原始对话总字符数。 */
    readonly originalChars: number;
    /** 蒸馏产物字符数。 */
    readonly renderedChars: number;
    /** 压缩比（rendered/original，向下取 4 位小数）。 */
    readonly compressionRatio: number;
}
/** 蒸馏结果。 */
export interface DistilledContext {
    /** 装配完成的注入文本。 */
    readonly rendered: string;
    readonly facts: readonly DistilledFact[];
    readonly stats: DistillStats;
}
/** 蒸馏选项。 */
export interface DistillOptions {
    /** 近端原文区轮数（缺省 6；实际保留数受预算约束）。 */
    readonly recentTurns?: number;
    /** 总字符预算（缺省 8000）。 */
    readonly charBudget?: number;
}
/**
 * 渐进式蒸馏主入口：远端事实抽取 + 近端原文 + 预算装配。
 * 空会话返回空产物（调用方负责前置校验）。
 */
export declare function distillContext(turns: readonly TranscriptTurn[], options?: DistillOptions): DistilledContext;
