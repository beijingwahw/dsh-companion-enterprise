import type { ReactElement } from 'react';
/** 组件 props：sessionId 由 slot 注入（缺省时不预选会话）。 */
export interface TraceAnalyzerViewProps {
    readonly sessionId?: string;
}
/** 执行轨迹分析器视图页。 */
export declare function TraceAnalyzerView(props: TraceAnalyzerViewProps): ReactElement;
