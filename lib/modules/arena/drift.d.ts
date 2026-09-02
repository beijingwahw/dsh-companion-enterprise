/**
 * 模块 G 创新扩展：模型漂移监控（金丝雀探针 + 分布距离）。
 *
 * 现实痛点：LLM 厂商静默更新模型（价格页没变、名字没变、行为变了）。
 * 一次性排行榜会在模型变化后悄悄失效，用户却毫无感知，直到某天生产
 * 输出劣化才追查——这是 MLOps 里经典的"训练-服务偏移"问题在 LLM 时代
 * 的翻版（模型即服务，服务即黑盒）。
 *
 * 方案（借鉴 SRE 金丝雀发布 + 统计过程控制的成熟实践）：
 * 1. 金丝雀探针组：一组确定性小探针（算术/结构化 JSON/信息抽取/代码/
 *    指令遵循/原文复述），输出被约束得极窄，天然低方差，适合做指纹；
 * 2. 首次运行建立基线（延迟分布/通过率/输出长度/风格指纹），此后每次
 *    运行与基线做分布距离比对：
 *    - 延迟：双样本 Kolmogorov–Smirnov 统计量（对分布形状敏感，
 *      均值不变但方差放大也能检出）；
 *    - 通过率：两比例 z 检验（合并方差，检出能力劣化）；
 *    - 输出长度：均值比 + KS（检出啰嗦度变化，常见于换底座）；
 *    - 风格指纹：字符 3-gram shingle 集合的 Jaccard 相似度
 *      （检出"同一个名字下换了模型"这类最隐蔽的漂移）；
 * 3. 三档判定 stable / warning / drifted，每个维度给出统计量与解释，
 *    确认模型确实更新后可重置基线（与金丝雀发布的"提升基线"同构）。
 */
import type { Domain } from '../../core/storage-adapter.js';
/** 单个金丝雀探针。 */
export interface CanaryProbe {
    readonly id: string;
    readonly description: string;
    readonly prompt: string;
    /** 通过判定（输出为空/失败调用一律不通过）。 */
    readonly check: (output: string) => boolean;
}
/** 内置探针组：六类基础能力，输出被约束得极窄以保证指纹稳定。 */
export declare const CANARY_PROBES: readonly CanaryProbe[];
/** 单探针执行结果。 */
export interface ProbeResult {
    readonly probeId: string;
    readonly ok: boolean;
    readonly latencyMs: number;
    readonly outputChars: number;
}
/** 一次完整探针运行（全部探针）。 */
export interface ProbeRun {
    readonly ts: number;
    readonly results: readonly ProbeResult[];
    /** 各探针原始输出（短文本，作风格指纹比对）。 */
    readonly outputs: readonly string[];
}
/** 每个模型的金丝雀记录。 */
export interface CanaryRecord {
    readonly model: string;
    /** 基线运行（首次成功运行；模型确认更新后可重置）。 */
    readonly baseline?: ProbeRun;
    /** 基线之后的运行（新→旧？否：旧→新，封顶 HISTORY_CAP 条）。 */
    readonly history: readonly ProbeRun[];
}
/** 历史运行封顶（防无限膨胀；足够支撑分布比对）。 */
export declare const HISTORY_CAP = 30;
/** 金丝雀记录仓库（'arena-canary' 表：model → CanaryRecord）。 */
export declare class CanaryStore {
    private readonly table;
    constructor(domain: Domain);
    get(model: string): CanaryRecord | undefined;
    /** 全部受监控模型的记录（按模型名排序）。 */
    list(): CanaryRecord[];
    save(record: CanaryRecord): Promise<void>;
    delete(model: string): Promise<void>;
}
/** 双样本 Kolmogorov–Smirnov 统计量（0-1：两样本经验分布最大间距）。 */
export declare function ksStatistic(a: readonly number[], b: readonly number[]): number;
/** 两比例 z 检验（合并方差；返回 z 值，正=近期劣化）。 */
export declare function twoProportionZ(baselinePasses: number, baselineTotal: number, recentPasses: number, recentTotal: number): number;
/** Jaccard 相似度（两文本 shingle 集合交集/并集；空集约定 1）。共享实现见 core/text.ts。 */
export declare function shingleJaccard(a: string, b: string): number;
/** 单维度漂移信号。 */
export interface DriftDimension {
    /** latency=延迟分布；pass-rate=能力通过率；length=输出长度；style=风格指纹。 */
    readonly name: 'latency' | 'pass-rate' | 'length' | 'style';
    /** 统计量（各维度含义不同，见 detail）。 */
    readonly statistic: number;
    /** 判定阈值（drifted 阈值）。 */
    readonly threshold: number;
    /** stable / warning / drifted。 */
    readonly level: 'stable' | 'warning' | 'drifted';
    /** 人类可读解释。 */
    readonly detail: string;
}
/** 漂移报告。 */
export interface DriftReport {
    readonly model: string;
    readonly baselineTs: number;
    readonly runsCompared: number;
    readonly dimensions: readonly DriftDimension[];
    /** 任一维度 drifted → drifted；任一 warning → warning；否则 stable。 */
    readonly verdict: 'stable' | 'warning' | 'drifted';
    readonly summary: string;
}
/**
 * 对金丝雀记录执行漂移分析（基线 vs 基线后全部历史运行）。
 * 无基线或历史不足时返回 stable 的占位报告（不具统计意义）。
 */
export declare function analyzeDrift(record: CanaryRecord): DriftReport;
