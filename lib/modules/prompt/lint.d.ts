/**
 * 模块 F 创新扩展：Prompt 静态分析器（Prompt Lint：矛盾指令检测 + 复杂度度量）。
 *
 * Prompt 是新代码：它有版本、有变更、有生产事故——但一直没有 ESLint。
 * 变异测试与 A/B 寻优（bandit.ts）都在「改了之后」测量效果；静态分析
 * 管的是「改之前」：一次提交里就肉眼可见的缺陷。四类检查：
 *
 * 1. 矛盾指令检测（LLM 生产事故的真实来源）：
 *    - 语言冲突：「必须用中文回复」+「answer in English」；
 *    - 篇幅冲突：「保持简洁」+「尽可能详细地展开」；
 *    - 行动冲突：同一动作对象上「必须执行 X」与「禁止执行 X」——
 *      通过指令极性（肯定/否定）分组后，对指令宾语做最长公共子串
 *      匹配（≥5 字符重合即判定同一对象），捕捉「同一件事的正反指令」；
 * 2. 占位符完整性：{var}/{{var}}/<var>/$VAR 引用与声明的变量表
 *    对账——未定义引用（渲染时留洞）与已声明未使用（腐化模板）；
 * 3. 模糊量词检测：一些/适当/尽量/大概——不可执行指令的信号，
 *    密度过高说明约束没有收敛；
 * 4. 复杂度度量（Halstead 1977 的思路：从文本统计量推维护性）：
 *    指令密度、硬约束数、句长分布、嵌套深度、token 预算与截断风险。
 *
 * 输出：findings（error/warning/info 三级，含规则名与摘录）+
 * metrics + 健康分（100 − 15×error − 5×warning − 1×info）。
 * 纯函数模块，无副作用。
 */
/** lint 发现。 */
export interface LintFinding {
    /** error = 会导致事故；warning = 质量隐患；info = 风格提示。 */
    readonly severity: 'error' | 'warning' | 'info';
    /** 规则名（contradiction/*, placeholder/*, vagueness/*, style/*, budget/*）。 */
    readonly rule: string;
    readonly message: string;
    /** 触发规则的原文摘录（≤80 字符）。 */
    readonly excerpt: string;
}
/** 复杂度度量。 */
export interface PromptMetrics {
    /** 总字符数与估算 token 数（≈3.5 字符/token）。 */
    readonly chars: number;
    readonly estimatedTokens: number;
    /** 句子总数（按句末标点/换行切分）。 */
    readonly sentences: number;
    /** 指令句数（含指令标记词）。 */
    readonly directives: number;
    /** 指令密度（指令句 / 句子）。 */
    readonly directiveDensity: number;
    /** 硬约束词出现次数（必须/禁止/不得/…）。 */
    readonly hardConstraints: number;
    /** 最长句字符数。 */
    readonly maxSentenceChars: number;
    /** 列表/标题嵌套深度（缩进层级最大值）。 */
    readonly nestingDepth: number;
    /** 模糊量词出现次数。 */
    readonly vagueTerms: number;
}
/** lint 报告。 */
export interface PromptLintReport {
    /** 健康分（0-100）。 */
    readonly score: number;
    /** A（≥90）/ B（≥75）/ C（≥60）/ D（<60）。 */
    readonly grade: 'A' | 'B' | 'C' | 'D';
    readonly findings: readonly LintFinding[];
    readonly metrics: PromptMetrics;
    readonly summary: string;
}
/** lint 选项。 */
export interface LintOptions {
    /** 已声明的模板变量名（缺省只报告占位符形态）。 */
    readonly variables?: readonly string[];
    /** token 预算（超出提示截断风险）。 */
    readonly budgetTokens?: number;
}
/**
 * Prompt 静态分析（纯函数）。
 * @param text Prompt 全文。
 * @param options 变量表与 token 预算。
 */
export declare function lintPrompt(text: string, options?: LintOptions): PromptLintReport;
