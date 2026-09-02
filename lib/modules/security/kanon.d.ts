/**
 * 模块 F 创新扩展：k-匿名泛化引擎（k-Anonymity Generalization）。
 *
 * DLP 扫描（发送前预检）回答「这条消息里有没有敏感值」；污点追踪回答
 * 「敏感数据流到了哪里」。但当团队要把一批用户数据交给外部分析时，
 * 还有第三个问题：逐字段脱敏后剩下的「无害字段」组合起来还能认出
 * 具体的人吗？Latanya Sweeney 的著名研究（2002）给出了答案——
 * 87% 的美国人口可被 {邮编, 性别, 出生日期} 三元组唯一标识：
 * 单独无害的准标识符（Quasi-Identifier, QI）组合起来就是指纹。
 * 这正是 k-匿名的出发点：发布的数据中，任何 QI 组合至少对应
 * k 条记录——想认出一个人，至少要同时怀疑 k 个人。
 *
 * 引擎（单维全定义域泛化，Incognito/Samarati 谱系的轻量实现）：
 * 1. 每个准标识符定义一条泛化格（generalization lattice）：
 *    年龄 → 5 岁段 → 10 岁段 → 20 岁段 → 掩蔽 *；
 *    邮编 → 前 4 位 → 前 2 位 → 掩蔽 *；
 *    出生日期 → 年 → 年代 → 掩蔽 *；
 *    城市 → 省级（首字 + *）→ 掩蔽 *；
 *    性别 → 掩蔽 *；
 * 2. 贪心迭代：只要仍有 QI 组 < k，就在「泛化后违规记录数下降最多」
 *    的维度上升一级（信息损失最小化启发式）；
 * 3. 兜底抑制（suppression）：泛化到顶仍孤立的记录整行移除——
 *    宁可少发布一行，也不留可被唯一标识的个体；
 * 4. 发布报告：每维度泛化层级、组大小分布、抑制清单、
 *    等价类数与 k 达成状态——审计材料与数据一并交付。
 *
 * 纯函数模块：输入记录数组与 k，输出泛化后的记录与审计报告。
 */
/** 准标识符字段名（引擎支持的 QI 集合）。 */
export type QiField = 'age' | 'zip' | 'birth' | 'city' | 'gender';
/** 输入记录：QI 字段全部可选，其余字段原样透传。 */
export type QiRecord = Readonly<Record<string, unknown>> & {
    readonly age?: number;
    readonly zip?: string;
    readonly birth?: string;
    readonly city?: string;
    readonly gender?: string;
};
/** 泛化后记录。 */
export interface AnonymizedRecord {
    /** QI 字段的泛化值（掩蔽 = '*'）。 */
    readonly qi: Readonly<Record<string, string>>;
    /** 原样透传的非 QI 字段。 */
    readonly payload: Readonly<Record<string, unknown>>;
}
/** 单维度的泛化决策（报告条目）。 */
export interface FieldGeneralization {
    readonly field: QiField;
    /** 应用的层级（0 = 未泛化）。 */
    readonly level: number;
    /** 层级的人类标签。 */
    readonly label: string;
    /** 该维度是否存在非 QI 原值（完全掩蔽的维度标注信息损失）。 */
    readonly fullyMasked: boolean;
}
/** 等价类（同 QI 组）概况。 */
export interface EquivalenceClass {
    /** 泛化后的 QI 值组合。 */
    readonly qi: Readonly<Record<string, string>>;
    /** 组内记录数（≥ k）。 */
    readonly size: number;
}
/** 匿名化报告。 */
export interface KanymityReport {
    /** 输入记录数。 */
    readonly inputCount: number;
    /** 发布记录数（输入 − 抑制）。 */
    readonly publishedCount: number;
    /** 目标 k。 */
    readonly k: number;
    /** 是否达成 k-匿名（发布部分全部组 ≥ k）。 */
    readonly satisfied: boolean;
    /** 抑制（移除）的记录数与占比。 */
    readonly suppressedCount: number;
    readonly suppressionRate: number;
    /** 各维度泛化决策。 */
    readonly generalizations: readonly FieldGeneralization[];
    /** 等价类列表（按组大小降序，≤200 组）。 */
    readonly equivalenceClasses: readonly EquivalenceClass[];
    /** 等价类总数。 */
    readonly classCount: number;
    /** 平均组大小（发布部分）。 */
    readonly averageClassSize: number;
    /** 最大再识别风险 = 1 / 最小组大小（发布部分；达成时 ≤ 1/k）。 */
    readonly reidentificationRisk: number;
    /** 一句话结论。 */
    readonly summary: string;
}
/** 匿名化结果。 */
export interface KanymityResult {
    readonly records: readonly AnonymizedRecord[];
    readonly report: KanymityReport;
}
/**
 * k-匿名化主入口：贪心单维泛化 + 兜底抑制。
 * @param records 输入记录（≤5000 条）。
 * @param k 目标匿名度（≥2）。
 * @throws Error 输入非法时。
 */
export declare function kanonymize(records: readonly QiRecord[], k: number): KanymityResult;
