import type { DlpRule } from './types.js';
import type { SessionLogSnapshot } from '../../types/harness.js';
/** 污点源（敏感值首次进入会话的位置）。 */
export interface TaintSource {
    readonly ruleId: string;
    readonly ruleName: string;
    /** 掩码值（安全红线：报告不携带明文）。 */
    readonly masked: string;
    /** 首次出现的用户消息 seq。 */
    readonly seq: number;
    readonly time: number;
}
/** 传播链上的一跳。 */
export interface TaintHop {
    readonly seq: number;
    readonly time: number;
    /** 事件类别（user/assistant/tool-call/tool-result/model-call/…）。 */
    readonly kind: string;
    /** 展示标签（如「工具调用：http_request」）。 */
    readonly label: string;
}
/** 汇点信道分级。 */
export type SinkChannel = 'outbound' | 'storage' | 'model' | 'internal';
/** 单条污点流：源 → 传播链 → 汇点。 */
export interface TaintFlow {
    readonly source: TaintSource;
    /** 传播链（源之后的每一跳，按 seq 升序；截尾保留上限）。 */
    readonly hops: readonly TaintHop[];
    /** 链上最远的非 internal 信道（无则 internal）。 */
    readonly sink: SinkChannel;
    readonly sinkLabel: string;
    readonly severity: 'high' | 'medium' | 'low';
    /** 传播链是否被截断展示。 */
    readonly truncated: boolean;
}
/** 污点追踪报告。 */
export interface TaintReport {
    readonly sessionId: string;
    readonly scannedAt: number;
    readonly sources: readonly TaintSource[];
    /** 按严重度降序的污点流（每源一条）。 */
    readonly flows: readonly TaintFlow[];
    readonly stats: {
        readonly sourceCount: number;
        /** 被污点波及的事件总数（去重）。 */
        readonly taintedEventCount: number;
        readonly outboundFlows: number;
        readonly storageFlows: number;
        readonly modelFlows: number;
    };
    readonly riskLevel: 'high' | 'medium' | 'low' | 'none';
    readonly advice: string;
}
/**
 * 污点追踪主函数（纯函数：快照 + 规则集 → 报告）。
 * @param snapshot 会话日志快照（sessionQuery.readSession 的返回）。
 * @param rules DLP 规则集（内置 + 自定义；禁用规则不参与）。
 */
export declare function trackTaint(snapshot: SessionLogSnapshot, rules: readonly DlpRule[]): TaintReport;
