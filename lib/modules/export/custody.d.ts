import type { Domain } from '../../core/storage-adapter.js';
/** 公证记录（'custody-records' 表，键为 recordId）。 */
export interface CustodyRecord {
    /** 链上序号（从 1 递增）。 */
    readonly seq: number;
    /** 记录 id（cust_ 前缀）。 */
    readonly recordId: string;
    /** 导出的会话 id。 */
    readonly sessionId: string;
    /** 导出文件名。 */
    readonly fileName: string;
    /** 导出格式（markdown/json/html）。 */
    readonly format: string;
    /** 导出内容 SHA-256（hex）。 */
    readonly contentHash: string;
    /** 前一条记录的 recordHash（创世记录为全零）。 */
    readonly prevRecordHash: string;
    /** 本记录规范形态的 SHA-256（hex；链指针）。 */
    readonly recordHash: string;
    /** recordHash 的 HMAC-SHA256 签名（hex）。 */
    readonly signature: string;
    readonly signedAt: number;
    /** 导出时是否启用隐私脱敏。 */
    readonly redacted: boolean;
}
/** 伴随清单（.custody.json）：与导出文件成对交付的"公证书"。 */
export interface CustodyManifest {
    readonly kind: 'dsh-companion-custody';
    readonly version: 1;
    readonly record: CustodyRecord;
    /** 核验说明（给审计人员的操作提示）。 */
    readonly verifyHint: string;
}
/** 单项核验结果。 */
export interface CustodyChecks {
    /** 文档内容哈希与清单一致。 */
    readonly contentIntact: boolean;
    /** 记录哈希可复算（记录字段未被改动）。 */
    readonly recordIntact: boolean;
    /** HMAC 签名有效。 */
    readonly signatureValid: boolean;
    /** 与链上前一条记录衔接（前条不在库时视为通过并注明）。 */
    readonly chainLinked: boolean;
    /** 前条记录是否在库（false = 首条或已被修剪）。 */
    readonly prevRecordFound: boolean;
}
/** 文档核验结果。 */
export interface CustodyVerifyResult {
    readonly intact: boolean;
    readonly checks: CustodyChecks;
    readonly recordId: string;
    /** 失败原因（intact=true 时为空）。 */
    readonly reason: string;
}
/** 全链核验结果。 */
export interface ChainVerifyResult {
    /** 链上记录总数。 */
    readonly length: number;
    readonly intact: boolean;
    /** 断裂位置（首条断裂记录的 seq；intact=true 时为 0）。 */
    readonly brokenAtSeq: number;
    readonly reason: string;
}
/** 规范序列化：键名递归排序后 JSON.stringify（跨平台稳定形态）。 */
export declare function stableStringify(value: unknown): string;
/** 保管链存储：密钥 + 登记簿（'custody-key' / 'custody-records' 表）。 */
export declare class CustodyStore {
    private readonly keys;
    private readonly records;
    constructor(domain: Domain);
    /** 确保保管密钥存在（首次调用时生成）。 */
    private ensureKey;
    /** 登记簿全量（按 seq 升序）。 */
    list(): CustodyRecord[];
    /**
     * 签署一份导出内容：内容摘要 → 追加链尾 → HMAC 签名 → 落库。
     * @param content 导出内容的 UTF-8 字节。
     */
    sign(input: {
        sessionId: string;
        fileName: string;
        format: string;
        content: Buffer;
        redacted: boolean;
    }): Promise<CustodyRecord>;
    /** 组装伴随清单（.custody.json 内容）。 */
    buildManifest(record: CustodyRecord): CustodyManifest;
    /**
     * 单记录核验（记录哈希 + 签名 + 与前条衔接）。
     * 链衔接语义：前条在库且哈希不匹配 = 断裂；前条不在库（滚动修剪
     * 已移除）= 中性通过——修剪是合法运维，不算篡改。
     */
    verifyRecord(record: CustodyRecord, chain?: readonly CustodyRecord[]): {
        recordIntact: boolean;
        signatureValid: boolean;
        chainLinked: boolean;
    };
    /**
     * 核验一份导出文档：内容哈希 + 记录完整性 + 签名 + 链衔接。
     * @param content 导出文件字节。
     * @param manifest 随文件交付的伴随清单。
     */
    verifyDocument(content: Buffer, manifest: CustodyManifest): CustodyVerifyResult;
    /** 全链核验：逐条验哈希/验签/验衔接，返回断裂点。 */
    verifyChain(): ChainVerifyResult;
}
/** 解析伴随清单（接受对象或 JSON 字符串）。 */
export declare function parseCustodyManifest(raw: unknown): CustodyManifest;
