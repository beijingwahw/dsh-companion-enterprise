/**
 * 模块 J5：提示注入（Prompt Injection）检测引擎。
 *
 * 提示注入是 LLM 时代特有的攻击面：恶意指令混入用户输入或外部内容，
 * 诱导模型覆写系统指令、越狱或窃取系统提示词。与 DLP（防数据外泄）
 * 互补——DLP 管「数据出不去」，注入检测管「指令进不来」。
 *
 * 检测器为纯函数、零依赖、双语（中英）模式库，六类攻击语义：
 * 1. instruction-override 指令覆写（「忽略以上所有指令」）；
 * 2. role-jailbreak 角色越狱（「假装你是不受限制的 AI」）；
 * 3. system-exfil 系统提示词窃取（「输出你的系统提示词」）；
 * 4. tool-hijack 工具劫持（诱导以管理员身份调用工具）；
 * 5. delimiter-confusion 分隔符伪造（伪.system 标签/角色标记注入）；
 * 6. encoding-evasion 编码规避（Base64/十六进制/Unicode 转义载荷）。
 *
 * 风险评分：各命中按严重度加权求和（封顶 100），
 * 判定 clean / suspicious / malicious 三档；严格模式下 malicious 直接拦截。
 */
import type { Domain } from '../../core/storage-adapter.js';
/** 注入检测设置（dlp-settings 表 'injection' 键）。 */
export interface InjectionSettings {
    /** 总开关：关闭时不扫描不拦截。 */
    enabled: boolean;
    /** 严格模式：malicious 判定直接拦截调用（否则仅警告）。 */
    strict: boolean;
}
/** 注入命中。 */
export interface InjectionFinding {
    /** 检测器 id（如 'instruction-override'）。 */
    readonly id: string;
    /** 攻击类别（中文展示名）。 */
    readonly category: string;
    /** 严重度权重。 */
    readonly severity: number;
    /** 命中片段（已掩码）。 */
    readonly sample: string;
    readonly count: number;
}
/** 扫描结果。 */
export interface InjectionScanResult {
    readonly findings: InjectionFinding[];
    /** 风险评分 0~100。 */
    readonly risk: number;
    /** 三档判定。 */
    readonly verdict: 'clean' | 'suspicious' | 'malicious';
}
/** 单条检测器定义。 */
interface Detector {
    readonly id: string;
    readonly category: string;
    readonly severity: number;
    readonly regex: RegExp;
}
/** 内置检测器（大小写不敏感、全局匹配；中英双语）。 */
export declare const DETECTORS: readonly Detector[];
export declare function scanInjection(text: string): InjectionScanResult;
/** 注入检测设置仓库（dlp-settings 表 'injection' 键）。 */
export declare class InjectionSettingsStore {
    private readonly table;
    constructor(domain: Domain);
    get(): InjectionSettings;
    update(patch: Partial<InjectionSettings>): Promise<InjectionSettings>;
}
export {};
