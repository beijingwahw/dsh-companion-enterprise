/**
 * 模块 B 创新扩展：交接验收测试（Handoff Acceptance Tests）。
 *
 * 就绪度门评估「交接文档写得全不全」；但写得全不等于读得懂——
 * 软件工程对「需求是否真的可交付」的回答是验收测试：不是检查
 * 文档的字段齐不齐，而是问「使用者能否凭这份交付通过一组
 * 关于它的问题」。Specification by Example（Gojko Adzić）把这个
 * 思想带入敏捷世界：把要求转化为可检验的例子。
 *
 * 本模块把同样的纪律用于上下文交接：
 * 1. 自动出题：从结构化交接的四个层级生成验收问题——
 *    锚定 →「硬约束 N 的边界是什么？」（接班人必须能复述红线）；
 *    参考 →「X 的路径/命令是什么？」（必须能直接找到东西）；
 *    开放问题 →「哪些问题仍然悬而未决？」（必须知道未知的未知）；
 *    行动 →「接手后第一件事做什么？」（必须能立刻起步）；
 * 2. 可检验的期望答案：每题携带从原文提取的关键词集合——
 *    答案里缺少关键词即知识缺口（Levenshtein 级别的字面比对
 *    对转述太苛刻，关键词覆盖是宽容而可辩护的口径）；
 * 3. 打分与验收：关键词覆盖率 ≥60% 记过，<60% 记缺口并点名
 *    缺失关键词——「接手者答不上来的，就是交接真正欠的债」。
 *
 * 用法：GET /handoff/acceptance 出卷（人读或自动注入新会话自检），
 * POST /handoff/acceptance/grade 交卷评分。
 * 纯函数模块：输入 StructuredHandoff，无需存储。
 */
import type { StructuredHandoff } from './structured.js';
/** 题目类别。 */
export type TestKind = 'anchor' | 'reference' | 'open' | 'action';
/** 单道验收题。 */
export interface AcceptanceQuestion {
    readonly id: string;
    readonly kind: TestKind;
    readonly kindLabel: string;
    readonly question: string;
    /** 期望答案（交接原文；评分基准）。 */
    readonly expectedAnswer: string;
    /** 期望答案的关键词（评分口径）。 */
    readonly keywords: readonly string[];
    /** 题目来源（层级与序号）。 */
    readonly source: {
        readonly tier: 'anchors' | 'reference' | 'active';
        readonly index: number;
    };
}
/** 验收卷。 */
export interface AcceptanceSuite {
    readonly handoffId: string;
    readonly depth: number;
    readonly totalQuestions: number;
    /** 各类别题数。 */
    readonly byKind: Readonly<Record<TestKind, number>>;
    readonly questions: readonly AcceptanceQuestion[];
    readonly summary: string;
}
/** 单题评分。 */
export interface QuestionGrade {
    readonly id: string;
    readonly kind: TestKind;
    readonly kindLabel: string;
    readonly question: string;
    /** 关键词覆盖率（0-1）。 */
    readonly score: number;
    readonly passed: boolean;
    /** 答案中缺失的关键词（缺什么补什么）。 */
    readonly missingKeywords: readonly string[];
    /** 未作答。 */
    readonly unanswered: boolean;
}
/** 评分结果。 */
export interface AcceptanceGrade {
    readonly handoffId: string;
    readonly totalQuestions: number;
    readonly answered: number;
    readonly passed: number;
    /** 总分（过题率 0-1）。 */
    readonly score: number;
    /** 裁定：passed（≥0.8）/ borderline（≥0.6）/ failed。 */
    readonly verdict: 'passed' | 'borderline' | 'failed';
    readonly perQuestion: readonly QuestionGrade[];
    /** 最薄弱的类别（过题率最低且至少 1 题未过）。 */
    readonly weakestKind: TestKind | null;
    readonly summary: string;
}
/**
 * 从结构化交接自动生成验收问题集（纯函数）。
 * 锚定每条一题、参考每条一题、开放问题每条一题、
 * 下一步/进行中合并一题起步行动（取第一条 next，无则第一条 in_progress）。
 */
export declare function generateAcceptanceTests(handoff: StructuredHandoff): AcceptanceSuite;
/**
 * 验收评分（纯函数）：对每题计算关键词覆盖率并裁定。
 * 未出现在 answers 里的题记未作答（0 分）。
 */
export declare function gradeAcceptance(suite: AcceptanceSuite, answers: readonly {
    questionId: string;
    answer: string;
}[]): AcceptanceGrade;
