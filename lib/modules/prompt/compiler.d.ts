/**
 * 模块 F 创新扩展：Prompt Token 预算编译器（Budget Compiler）。
 *
 * 长上下文的隐性代价是「每 token 都计费、每 token 都稀释注意力」。
 * 手工裁 Prompt 是逐字符的苦役——编译器思想是把它变成一次编译：
 * Prompt 是源代码，组件是 AST 节点，token 预算是寄存器约束，
 * 编译目标是在预算内最大化「指令保真度」。
 *
 * 流水线：
 * 1. 词法分段：按空行/标题切段，每段按关键词归类为六类组件——
 *    role（角色设定）/instruction（任务指令）/constraint（约束）/
 *    format（输出格式）/example（few-shot 示例）/context（背景）；
 * 2. 保真度评分：不同组件对任务成败的边际贡献不同——角色与指令
 *    是语义骨架（不可裁），示例与背景是增强材料（可裁可压）；
 * 3. 预算分配（贪心 pass）：
 *    a. 全部组件入队，超出预算时按「单位 token 保真度」从低到高淘汰；
 *    b. example 支持「截半」软化裁剪（保留首个示例）；
 *    c. context 支持「首尾保留、中段删除」的滑窗压缩（LLM 对首尾
 *       位置注意力最强，呼应 lost-in-the-middle）；
 * 4. 编译报告：每个组件的去向决策 + 前后 token 对比 + 保真度损耗，
 *    裁剪不再黑箱。
 */
/** 组件类别。 */
export type PromptComponentKind = 'role' | 'instruction' | 'constraint' | 'format' | 'example' | 'context';
/** 组件类别中文标签。 */
export declare const COMPONENT_KIND_LABELS: Readonly<Record<PromptComponentKind, string>>;
/** 组件编译决策。 */
export type ComponentDecision = 'kept' | 'halved' | 'compressed' | 'dropped';
/** 编译报告中的组件条目。 */
export interface CompiledComponent {
    readonly kind: PromptComponentKind;
    readonly kindLabel: string;
    /** 编译前文本（截断展示）。 */
    readonly before: string;
    /** 编译后文本（截断展示；dropped 时为空）。 */
    readonly after: string;
    readonly tokensBefore: number;
    readonly tokensAfter: number;
    readonly decision: ComponentDecision;
}
/** 编译结果。 */
export interface CompileResult {
    /** 编译后 Prompt 全文（预算内）。 */
    readonly compiled: string;
    readonly tokensBefore: number;
    readonly tokensAfter: number;
    /** 保真度损耗估计（0~1，越低越好）。 */
    readonly fidelityLoss: number;
    /** 组件级决策明细。 */
    readonly components: readonly CompiledComponent[];
    /** 预算是否完全满足（编译后 ≤ 预算）。 */
    readonly withinBudget: boolean;
    /** 说明（中文）。 */
    readonly note: string;
}
/**
 * Token 估算（混合中英）：CJK 字符 ≈ 0.6 token/字，
Latin 字符 ≈ 0.25 token/字符（对齐主流分词器经验值）。
 */
export declare function estimateTokens(text: string): number;
/**
 * 编译：在 token 预算内对 Prompt 做保真度最大化的组件级裁剪。
 * @param prompt 原始 Prompt。
 * @param budgetTokens token 预算（> 0）。
 */
export declare function compilePrompt(prompt: string, budgetTokens: number): CompileResult;
