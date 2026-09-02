/**
 * 模块 E 创新扩展：频谱根因定位（Spectrum-Based Fault Localization）。
 *
 * 前兆挖掘回答「失败之前会发生什么序列」；但序列命中只说明「相关」，
 * 不指认「元凶」。当失败已经发生，工程师的真实问题是：这批失败轨迹
 * 和成功轨迹相比，到底是哪个步骤出了问题？
 *
 * 方法论（SBFL，软件工程顶会二十年的经典谱系：Tarantula → Ochiai）：
 * 1. 频谱采集：把每条轨迹的成功/失败与「组件覆盖」组成 0/1 矩阵——
 *    组件 = 行为签名（kind:name，如 tool:http_request），一条轨迹
 *    覆盖某组件 = 含有该签名的节点；
 * 2. Ochiai 可疑度：sus(n) = failed(n) / √(totalFailed × (failed(n) +
 *    passed(n)))——同时满足「失败轨迹几乎都经过它」（高召回）与
 *    「成功轨迹几乎不经过它」（高区分度）的组件得分逼近 1；
 * 3. 差分画像：对可疑组件附上失败/成功轨迹中的耗时与重试率差分
 *    ——「同一工具在失败运行中平均慢 8 倍、重试率 60%」这种证据
 *    把统计可疑度翻译成可行动的工程线索；
 * 4. 根因裁定：failed 支持度与可疑度双达标才输出结论——
 *    小样本下宁可不指认，也不冤枉一个常规步骤（Ochiai 的
 *    √totalFailed 项天然压制只在个别失败中出现的偶发组件）。
 *
 * 纯函数模块：数据来自既有 TraceStore 与派生轨迹。
 */
import type { Trace, TraceNode, TraceNodeKind } from './types.js';
/** 单组件画像。 */
export interface ComponentSuspicion {
    /** 行为签名（kind:name）。 */
    readonly component: string;
    readonly kind: TraceNodeKind;
    readonly name: string;
    /** 覆盖该组件的失败轨迹数。 */
    readonly failedCount: number;
    /** 覆盖该组件的成功轨迹数。 */
    readonly passedCount: number;
    /** Ochiai 可疑度（0-1）。 */
    readonly suspiciousness: number;
    /** 失败轨迹中该组件的平均耗时（毫秒）。 */
    readonly avgDurationInFailedMs: number;
    /** 成功轨迹中该组件的平均耗时（毫秒；无样本为 0）。 */
    readonly avgDurationInPassedMs: number;
    /** 失败轨迹中该组件的重试率（0-1）。 */
    readonly retryRateInFailed: number;
    /** 人类可读的工程线索。 */
    readonly advice: string;
}
/** 根因定位报告。 */
export interface LocalizationReport {
    /** 参与定位的轨迹总数（成功/失败）。 */
    readonly traces: {
        readonly ok: number;
        readonly failed: number;
    };
    readonly failureRate: number;
    /** 组件可疑度排行（降序，≤ TOP_COMPONENTS 条）。 */
    readonly components: readonly ComponentSuspicion[];
    /** 根因结论（证据不足时为 null）。 */
    readonly verdict: string | null;
    /** 数据不足说明（verdict 为 null 时给出原因）。 */
    readonly note: string;
}
/** 组件键：行为签名（kind:name，剥离状态与参数）。 */
export declare function componentKey(node: Pick<TraceNode, 'kind' | 'name'>): string;
/**
 * 频谱根因定位（纯函数）。
 * @param traces 历史轨迹集合（成功与失败对照语料）。
 */
export declare function localizeFaults(traces: readonly Trace[]): LocalizationReport;
