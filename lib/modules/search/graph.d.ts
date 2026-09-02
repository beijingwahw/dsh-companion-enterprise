import type { SessionQueryEngine } from '../../types/harness.js';
/** 实体类别。 */
export type EntityKind = 'path' | 'command' | 'model' | 'url' | 'error-code' | 'acronym';
/** 实体类别中文标签。 */
export declare const ENTITY_KIND_LABELS: Readonly<Record<EntityKind, string>>;
/** 图中实体节点。 */
export interface GraphEntity {
    /** 实体规范名（原样保留，作为唯一键）。 */
    readonly name: string;
    readonly kind: EntityKind;
    /** 出现于多少个会话。 */
    readonly sessionCount: number;
    /** PageRank 中心性（归一化）。 */
    readonly centrality: number;
    /** 关联实体数（度）。 */
    readonly degree: number;
}
/** 实体邻域查询结果。 */
export interface EntityNeighborhood {
    readonly entity: GraphEntity;
    /** 关联实体（边权降序，≤ 20 个）。 */
    readonly neighbors: ReadonlyArray<{
        readonly name: string;
        readonly kind: EntityKind;
        readonly weight: number;
    }>;
    /** 关联会话（新→旧，≤ 20 个）。 */
    readonly sessions: ReadonlyArray<{
        readonly id: string;
        readonly title: string | null;
        readonly createdAt: number;
    }>;
}
/** 图谱整体报告。 */
export interface MemoryGraphReport {
    /** 参与构图的会话数。 */
    readonly sessionCount: number;
    /** 实体总数。 */
    readonly entityCount: number;
    /** 边总数。 */
    readonly edgeCount: number;
    /** 枢纽实体（PageRank 降序，≤ 30 个）。 */
    readonly hubs: readonly GraphEntity[];
}
/** 单会话贡献（内部中间结构）。 */
interface SessionCorpus {
    readonly id: string;
    readonly title: string | null;
    readonly createdAt: number;
    readonly entities: ReadonlySet<string>;
}
/**
 * 从会话查询引擎收集图谱语料（标题 + 转录正文）。
 * 单会话读取失败跳过，不影响其余语料。
 */
export declare function collectGraphSessions(sessionQuery: Pick<SessionQueryEngine, 'listSessions' | 'readSession'>, maxSessions?: number): Promise<Array<{
    id: string;
    title: string | null;
    createdAt: number;
    text: string;
}>>;
/**
 * 从会话语料构建记忆图谱。
 * @param sessions 每会话的（id、标题、创建时间、正文文本）。
 */
export declare function buildMemoryGraph(sessions: ReadonlyArray<{
    id: string;
    title: string | null;
    createdAt: number;
    text: string;
}>): {
    entities: Map<string, {
        kind: EntityKind;
        sessionIds: Set<string>;
    }>;
    edges: Map<string, number>;
    corpora: SessionCorpus[];
};
/** 生成图谱整体报告（Top 枢纽）。 */
export declare function graphReport(graph: ReturnType<typeof buildMemoryGraph>, hubLimit?: number): MemoryGraphReport;
/** 查询某实体的邻域（关联实体 + 关联会话）。 */
export declare function entityNeighborhood(graph: ReturnType<typeof buildMemoryGraph>, name: string): EntityNeighborhood | undefined;
export {};
