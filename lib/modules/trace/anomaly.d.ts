/**
 * 模块 E 创新扩展：孤立森林轨迹异常检测（Isolation Forest Anomaly Detection）。
 *
 * SPC 控制图回答「指标是否越出历史控制限」——但控制限是对单一指标的
 * 逐维判断：一个「每项指标都只偏了一点点、但组合起来前所未见」的轨迹
 * 会从所有单维雷达下漏过。Isolation Forest（Liu, Ting & Zhou,
 * ICDM 2008——无监督异常检测被引最高的算法之一）换了一个反直觉的
 * 视角：不建模「正常是什么」，而是利用「异常点稀少且与众不同，
 * 因此更容易被随机切分孤立」——
 *
 * 1. 特征向量化：每条轨迹 → 7 维特征（节点数 / 总耗时对数 / 总 token
 *    对数 / 重试率 / 错误率 / 工具占比 / 缓存未命中率）；
 * 2. iTrees：每棵树从 ψ 条子样本出发，随机选特征 + 随机选切分点
 *    递归二分，直到叶子单点或高度上限——异常点平均在更浅处就被
 *    孤立（路径短）；
 * 3. 异常分：s(x) = 2^(−E[h(x)]/c(ψ))——平均路径越短分越高，
 *    0.5 为分水岭，→1 强异常，→0 稳定正常；
 * 4. 可解释证据：伴随输出各特征的 z 分数——「孤立森林说它异常，
 *    重试率 z=+4.2、缓存未命中 z=+3.1」把黑盒评分翻译成工程线索。
 *
 * 纯函数模块：数据来自既有 Trace 集合（保存轨迹 + 会话派生轨迹）。
 */
import type { Trace } from './types.js';
/** 特征名（固定顺序）。 */
export declare const TRACE_FEATURES: readonly ['nodeCount', 'logDuration', 'logTokens', 'retryRate', 'errorRate', 'toolRatio', 'cacheMissRate'];
/** 轨迹特征名类型。 */
export type TraceFeature = (typeof TRACE_FEATURES)[number];
/** 单轨迹特征向量（与 TRACE_FEATURES 同序）。 */
export interface TraceFeatures {
    readonly traceId: string;
    readonly sessionId?: string;
    readonly startedAt: number;
    /** 特征值（7 维，与 TRACE_FEATURES 同序）。 */
    readonly values: readonly number[];
}
/** 单条异常轨迹。 */
export interface TraceAnomalyEntry {
    readonly traceId: string;
    readonly sessionId?: string;
    readonly startedAt: number;
    /** 异常分 s(x) ∈ (0,1]，> 0.5 偏异常。 */
    readonly score: number;
    /** 是否判为异常（score ≥ 阈值）。 */
    readonly anomalous: boolean;
    /** 各特征 z 分数（与 TRACE_FEATURES 同序；解释证据）。 */
    readonly zScores: readonly {
        readonly feature: TraceFeature;
        readonly label: string;
        readonly z: number;
    }[];
    /** 驱动异常的特征（|z| ≥ 2 的特征，降序）。 */
    readonly drivers: readonly {
        readonly feature: TraceFeature;
        readonly label: string;
        readonly z: number;
    }[];
    /** 一句话证据描述。 */
    readonly evidence: string;
}
/** 异常检测报告。 */
export interface AnomalyReport {
    /** 参与检测的轨迹数。 */
    readonly traces: number;
    /** 检测方法参数。 */
    readonly trees: number;
    readonly subsampleSize: number;
    /** 异常判定阈值。 */
    readonly threshold: number;
    /** 异常轨迹条数。 */
    readonly anomalousCount: number;
    /** 按异常分降序的轨迹（≤ limit 条）。 */
    readonly entries: readonly TraceAnomalyEntry[];
    /** 数据不足说明（轨迹 < 8 条时不输出结论）。 */
    readonly note: string;
    readonly summary: string;
}
/** 从轨迹提取特征向量（与 TRACE_FEATURES 同序）。 */
export declare function extractFeatures(trace: Trace): TraceFeatures;
/**
 * 孤立森林异常检测：轨迹集合 → 异常分排行 + 驱动特征。
 * 轨迹 < MIN_TRACES 条时不输出结论（样本不足）。
 */
export declare function detectTraceAnomalies(traces: readonly Trace[], limit?: number, seed?: number): AnomalyReport;
