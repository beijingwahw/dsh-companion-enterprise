/**
 * 模块 B 创新扩展：交接就绪度评分与缺口检测（Handoff Readiness Gate）。
 *
 * 结构化交接（structured.ts）解决了「交接里有什么」；但一份交接
 * 拿到新会话里到底「够不够用」，此前只能靠感觉。航空业的答案是不能
 * 靠感觉——起飞前过检查单（pre-flight checklist），逐项打勾，任何
 * critical 项不过就不得起飞。本模块把同样的纪律引入上下文交接：
 * 交接文档在投递之前先过「就绪度门」。
 *
 * 六维检查单（权重合计 100）：
 * 1. 锚定覆盖（25）：硬约束的数量与质量——0 条锚定是最严重的缺口
 *    （新会话无从知道哪些线不能踩）；过短/无具体细节的锚定打折；
 * 2. 行动清晰（20）：是否有显式「下一步」；进行中事项是否含
 *    未决措辞（待定/TODO/不确定）——下一步不明，接班第一脚就踩空；
 * 3. 开放问题显式化（15）：悬而未决的问题是否被显式列为开放问题，
 *    而不是藏在字里行间——显式的未知是资产，隐式的未知是地雷；
 * 4. 参考完整性（20）：活动项里提到的路径/命令/ID 是否在参考区
 *    登记（悬空引用检测）——「去改那个配置文件」但没说文件在哪，
 *    是交接事故的高发源头；
 * 5. 世系健康（10）：深度超阈值（逐代转述损耗）、无理由废弃锚定、
 *    守门自动补回（模型已遗忘的信号）——历史债要显式还，不能滚；
 * 6. 体积预算（10）：注入渲染文本是否超出预算（超限即注入截断，
 *    排在后面的参考项会整段丢失——就绪度在交付管道上被物理截胡）。
 *
 * 输出：0-100 总分 + 分级（A/B/C/D）+ 分维得分 + 缺口清单
 * （critical/warning/info 三级，每条附修复建议）。
 * 纯函数实现，评估任何 StructuredHandoff，无需存储。
 */
import { type StructuredHandoff } from './structured.js';
/** 注入文本字符预算（超出将在注入时被截断，参考项整段丢失风险）。 */
export declare const INJECTION_CHAR_BUDGET = 4000;
/** 分维权重（合计 100）。 */
declare const WEIGHTS: {
    readonly anchorCoverage: 25;
    readonly actionClarity: 20;
    readonly openQuestions: 15;
    readonly referenceIntegrity: 20;
    readonly lineageHealth: 10;
    readonly sizeBudget: 10;
};
/** 缺口严重级别。 */
export type GapSeverity = 'critical' | 'warning' | 'info';
/** 单条缺口。 */
export interface ReadinessGap {
    readonly severity: GapSeverity;
    /** 所属维度键（锚定覆盖/行动清晰/…）。 */
    readonly dimension: string;
    /** 问题描述（中文，可直接展示）。 */
    readonly message: string;
    /** 修复建议。 */
    readonly suggestion: string;
}
/** 分维得分。 */
export interface DimensionScore {
    readonly key: keyof typeof WEIGHTS;
    readonly label: string;
    /** 0-100。 */
    readonly score: number;
    readonly weight: number;
    /** 本维度的缺口（与总 gaps 中的条目同源）。 */
    readonly gaps: readonly ReadinessGap[];
}
/** 就绪度报告。 */
export interface ReadinessReport {
    readonly handoffId: string;
    readonly depth: number;
    /** 0-100 总分（分维加权）。 */
    readonly score: number;
    /** A（≥85 可放心投递）/ B（≥70 小缺口）/ C（≥50 需补课）/ D（<50 不可投递）。 */
    readonly grade: 'A' | 'B' | 'C' | 'D';
    /** 是否存在 critical 缺口（存在则不建议投递）。 */
    readonly blocking: boolean;
    readonly dimensions: readonly DimensionScore[];
    /** 全部缺口（critical 在前）。 */
    readonly gaps: readonly ReadinessGap[];
    /** 一句话总评。 */
    readonly summary: string;
    /** 注入渲染的字符量与预算。 */
    readonly renderedChars: number;
    readonly charBudget: number;
}
/** 就绪度门：评估一份结构化交接（纯函数）。 */
export declare function assessReadiness(handoff: StructuredHandoff): ReadinessReport;
export {};
