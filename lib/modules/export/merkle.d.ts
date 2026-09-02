import type { Domain } from '../../core/storage-adapter.js';
/** SHA-256（hex 输出；输入字符串按 UTF-8 编码）。 */
export declare function sha256Hex(data: string | Uint8Array): string;
/** Merkle 树：levels[0] = 叶（输入顺序），逐层向上直到根。 */
export type MerkleLevels = readonly string[][];
/**
 * 构建 Merkle 树（Bitcoin 风格：每层奇数个节点时复制末位再配对）。
 * 空输入返回空 levels（root 为 undefined）。
 */
export declare function buildMerkleTree(leafHashes: readonly string[]): MerkleLevels;
/** 根哈希（hex；空树返回空串）。 */
export declare function merkleRootOf(leafHashes: readonly string[]): string;
/** 兄弟节点（方向：true = 兄弟在右侧）。 */
export interface MerkleSibling {
    readonly hash: string;
    /** true：兄弟是右孩子（拼接顺序 sibling 在后）。 */
    readonly right: boolean;
}
/** 生成 index 叶到根的包含证明（兄弟路径）。 */
export declare function merkleProof(levels: MerkleLevels, index: number): MerkleSibling[];
/**
 * 验证包含证明：叶哈希沿兄弟路径逐层上推，终点须等于根。
 * 任何人（无需访问原数据集）都能复算——可验证性独立于本系统存在。
 */
export declare function verifyMerkleProof(leafHash: string, index: number, proof: readonly MerkleSibling[], root: string): boolean;
/** 批量导出条目的可验证登记项。 */
export interface MerkleEntry {
    /** 条目文件名（ZIP 内名称）。 */
    readonly fileName: string;
    readonly sessionId: string;
    /** 内容 SHA-256（hex）。 */
    readonly contentHash: string;
    /** 叶哈希 = SHA-256(fileName + '\n' + contentHash)（hex）。 */
    readonly leafHash: string;
}
/** 单条目的叶哈希（同时承诺文件名与内容，防同名调包）。 */
export declare function leafHashOf(fileName: string, content: string | Uint8Array): string;
/** 从条目序列构建登记表（叶哈希序列与树一并可复算）。 */
export declare function buildEntries(items: readonly {
    fileName: string;
    sessionId: string;
    content: Uint8Array;
}[]): MerkleEntry[];
/** Merkle 批次记录（'export-merkle' 表，键为根哈希）。 */
export interface MerkleBundleRecord {
    readonly kind: 'bundle';
    /** 根哈希（hex；批次承诺）。 */
    readonly root: string;
    readonly createdAt: number;
    /** 导出格式（markdown/json/…）。 */
    readonly format: string;
    /** 批次内条目（登记表：文件名/会话/内容哈希/叶哈希）。 */
    readonly entries: readonly MerkleEntry[];
}
/** Merkle 批次仓库（按根哈希索引）。 */
export declare class MerkleStore {
    private readonly table;
    constructor(domain: Domain);
    save(record: MerkleBundleRecord): Promise<void>;
    get(root: string): MerkleBundleRecord | undefined;
    list(): MerkleBundleRecord[];
    delete(root: string): Promise<void>;
}
/** 包含证明响应（交给第三方自行复算的全部材料）。 */
export interface InclusionProof {
    readonly root: string;
    readonly fileName: string;
    /** 叶在批次中的位次（0 起）。 */
    readonly index: number;
    readonly leafHash: string;
    /** 兄弟路径（叶 → 根）。 */
    readonly proof: readonly MerkleSibling[];
    /** 复算说明（给审计人员）。 */
    readonly verifyHint: string;
}
/** 生成条目的包含证明（从已存批次）。 */
export declare function buildInclusionProof(record: MerkleBundleRecord, fileName: string): InclusionProof | undefined;
/** 核验结果。 */
export interface InclusionVerifyResult {
    /** 内容哈希与登记表一致。 */
    readonly contentMatch: boolean;
    /** 叶 + 证明 → 根 复算成功。 */
    readonly proofValid: boolean;
    /** 文件名在批次登记表中。 */
    readonly registered: boolean;
    readonly verified: boolean;
    readonly root: string;
    readonly fileName: string;
    readonly leafHash: string;
    /** 不一致时的差异定位（中文）。 */
    readonly detail: string;
}
/**
 * 核验一份文件内容确属某根哈希承诺的批次：
 * 1. 登记：文件名在批次登记表中；
 * 2. 内容：SHA-256(content) 与登记的内容哈希一致；
 * 3. 证明：叶 + 兄弟路径复算等于根。
 */
export declare function verifyInclusion(record: MerkleBundleRecord, fileName: string, content: Uint8Array, proof?: readonly MerkleSibling[]): InclusionVerifyResult;
