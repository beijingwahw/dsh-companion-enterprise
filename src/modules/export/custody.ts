/**
 * 模块 A 创新扩展：合规签名导出（Chain-of-Custody Export）。
 *
 * 现实痛点：导出的对话文件是"死文档"——离开系统后任何人都可以
 * 编辑它，再声称"当时就是这么说的"。审计、举证、企业知识存档等
 * 合规场景需要的是可验证的完整性证明：这份文件自导出以来有没有
 * 被改动过？
 *
 * 方案：本地"公证处"——HMAC 哈希链（与 Certificate Transparency、
 * 入侵检测审计日志同族的思想，附一个运营即可核验的轻量实现）：
 *
 * 1. 内容摘要：导出内容（markdown/json/html 文本字节）取 SHA-256；
 * 2. 设备签名：以本机保管密钥（首次使用时生成、落 companion 存储
 *    域）对记录做 HMAC-SHA256——文档与"这台设备"绑定；
 * 3. 签名链（hash chain）：每条公证记录包含前一条记录的哈希——
 *    任何对历史记录的回溯篡改都会断裂链条，且断裂位置精确定位
 *    （伪造整条链需要保管密钥，而密钥从不离开存储域）；
 * 4. 伴随清单（manifest）：导出文件 + .custody.json 清单成对交付，
 *    清单即"公证书"；任何一方被改动，核验立刻失败；
 * 5. 全链核验：chain 端点对整本"公证登记簿"逐条验签 + 验链，
 *    附断裂点定位——审计人员无需信任，只需核验。
 *
 * 威胁模型（诚实声明）：HMAC 对称签名可验证"内容自签名以来未变"，
 * 但不能向第三方证明"签名者是谁"（密钥持有者自己也能重新签整条
 * 链）——向外部第三方出示的场景应升级为非对称签名（可后续扩展）。
 * 本实现解决的是内部合规与意外篡改的可检测性。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Domain } from '../../core/storage-adapter.js'

/** 保管密钥记录（'custody-key' 表，单键 'key'）。 */
interface CustodyKeyRecord {
  /** 32 字节随机密钥（hex）。 */
  readonly keyHex: string
  readonly createdAt: number
}

/** 公证记录（'custody-records' 表，键为 recordId）。 */
export interface CustodyRecord {
  /** 链上序号（从 1 递增）。 */
  readonly seq: number
  /** 记录 id（cust_ 前缀）。 */
  readonly recordId: string
  /** 导出的会话 id。 */
  readonly sessionId: string
  /** 导出文件名。 */
  readonly fileName: string
  /** 导出格式（markdown/json/html）。 */
  readonly format: string
  /** 导出内容 SHA-256（hex）。 */
  readonly contentHash: string
  /** 前一条记录的 recordHash（创世记录为全零）。 */
  readonly prevRecordHash: string
  /** 本记录规范形态的 SHA-256（hex；链指针）。 */
  readonly recordHash: string
  /** recordHash 的 HMAC-SHA256 签名（hex）。 */
  readonly signature: string
  readonly signedAt: number
  /** 导出时是否启用隐私脱敏。 */
  readonly redacted: boolean
}

/** 伴随清单（.custody.json）：与导出文件成对交付的"公证书"。 */
export interface CustodyManifest {
  readonly kind: 'dsh-companion-custody'
  readonly version: 1
  readonly record: CustodyRecord
  /** 核验说明（给审计人员的操作提示）。 */
  readonly verifyHint: string
}

/** 单项核验结果。 */
export interface CustodyChecks {
  /** 文档内容哈希与清单一致。 */
  readonly contentIntact: boolean
  /** 记录哈希可复算（记录字段未被改动）。 */
  readonly recordIntact: boolean
  /** HMAC 签名有效。 */
  readonly signatureValid: boolean
  /** 与链上前一条记录衔接（前条不在库时视为通过并注明）。 */
  readonly chainLinked: boolean
  /** 前条记录是否在库（false = 首条或已被修剪）。 */
  readonly prevRecordFound: boolean
}

/** 文档核验结果。 */
export interface CustodyVerifyResult {
  readonly intact: boolean
  readonly checks: CustodyChecks
  readonly recordId: string
  /** 失败原因（intact=true 时为空）。 */
  readonly reason: string
}

/** 全链核验结果。 */
export interface ChainVerifyResult {
  /** 链上记录总数。 */
  readonly length: number
  readonly intact: boolean
  /** 断裂位置（首条断裂记录的 seq；intact=true 时为 0）。 */
  readonly brokenAtSeq: number
  readonly reason: string
}

/** 创世前向哈希（全零占位）。 */
const GENESIS_HASH = '0'.repeat(64)

/** 登记簿滚动保留上限。 */
const CHAIN_KEEP_LIMIT = 500

// ---------------------------------------------------------------------------
// 基础原语
// ---------------------------------------------------------------------------

/** SHA-256（hex）。 */
function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** HMAC-SHA256（hex）。 */
function hmacSha256(keyHex: string, data: string): string {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(data).digest('hex')
}

/** 常时比较（长度不等直接 false，防时序侧信道）。 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

/** 规范序列化：键名递归排序后 JSON.stringify（跨平台稳定形态）。 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** 记录的规范形态（不含 recordHash 与 signature 的基础字段）。 */
function recordCanonicalBase(record: Omit<CustodyRecord, 'recordHash' | 'signature'>): string {
  return stableStringify(record)
}

// ---------------------------------------------------------------------------
// 公证存储
// ---------------------------------------------------------------------------

/** 保管链存储：密钥 + 登记簿（'custody-key' / 'custody-records' 表）。 */
export class CustodyStore {
  private readonly keys
  private readonly records

  constructor(domain: Domain) {
    this.keys = domain.table<CustodyKeyRecord>('custody-key')
    this.records = domain.table<CustodyRecord>('custody-records')
  }

  /** 确保保管密钥存在（首次调用时生成）。 */
  private async ensureKey(): Promise<CustodyKeyRecord> {
    const existing = this.keys.get('key')
    if (existing) return existing
    const created: CustodyKeyRecord = {
      keyHex: randomBytes(32).toString('hex'),
      createdAt: Date.now(),
    }
    await this.keys.put('key', created)
    return created
  }

  /** 登记簿全量（按 seq 升序）。 */
  list(): CustodyRecord[] {
    return this.records
      .entries()
      .map(([, record]) => record)
      .sort((a, b) => a.seq - b.seq)
  }

  /**
   * 签署一份导出内容：内容摘要 → 追加链尾 → HMAC 签名 → 落库。
   * @param content 导出内容的 UTF-8 字节。
   */
  async sign(input: {
    sessionId: string
    fileName: string
    format: string
    content: Buffer
    redacted: boolean
  }): Promise<CustodyRecord> {
    const key = await this.ensureKey()
    const chain = this.list()
    const last = chain[chain.length - 1]
    const seq = (last?.seq ?? 0) + 1
    const base: Omit<CustodyRecord, 'recordHash' | 'signature'> = {
      seq,
      recordId: `cust_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      sessionId: input.sessionId,
      fileName: input.fileName,
      format: input.format,
      contentHash: sha256(input.content),
      prevRecordHash: last?.recordHash ?? GENESIS_HASH,
      signedAt: Date.now(),
      redacted: input.redacted,
    }
    const recordHash = sha256(recordCanonicalBase(base))
    const record: CustodyRecord = {
      ...base,
      recordHash,
      signature: hmacSha256(key.keyHex, recordHash),
    }
    await this.records.put(record.recordId, record)
    // 滚动修剪：仅保最近 CHAIN_KEEP_LIMIT 条（修剪不破坏剩余链的衔接）。
    if (chain.length + 1 > CHAIN_KEEP_LIMIT) {
      for (const stale of chain.slice(0, chain.length + 1 - CHAIN_KEEP_LIMIT)) {
        await this.records.delete(stale.recordId)
      }
    }
    return record
  }

  /** 组装伴随清单（.custody.json 内容）。 */
  buildManifest(record: CustodyRecord): CustodyManifest {
    return {
      kind: 'dsh-companion-custody',
      version: 1,
      record,
      verifyHint:
        '核验方式：将导出文件与 .custody.json 原样提交 POST /export/custody/verify，' +
        '任何一方被改动都会核验失败；GET /export/custody/chain 可核验整本登记簿。',
    }
  }

  /**
   * 单记录核验（记录哈希 + 签名 + 与前条衔接）。
   * 链衔接语义：前条在库且哈希不匹配 = 断裂；前条不在库（滚动修剪
   * 已移除）= 中性通过——修剪是合法运维，不算篡改。
   */
  verifyRecord(
    record: CustodyRecord,
    chain: readonly CustodyRecord[] = this.list(),
  ): { recordIntact: boolean; signatureValid: boolean; chainLinked: boolean } {
    const key = this.keys.get('key')
    const { recordHash, signature, ...base } = record
    const recordIntact = sha256(recordCanonicalBase(base)) === recordHash
    const signatureValid =
      key !== undefined && safeEqualHex(hmacSha256(key.keyHex, recordHash), signature)
    const prev = chain.find((item) => item.seq === record.seq - 1)
    const chainLinked = record.seq === 1 || prev === undefined || prev.recordHash === record.prevRecordHash
    return { recordIntact, signatureValid, chainLinked }
  }

  /**
   * 核验一份导出文档：内容哈希 + 记录完整性 + 签名 + 链衔接。
   * @param content 导出文件字节。
   * @param manifest 随文件交付的伴随清单。
   */
  verifyDocument(content: Buffer, manifest: CustodyManifest): CustodyVerifyResult {
    const record = manifest.record
    const stored = this.records.get(record.recordId)
    const { recordIntact, signatureValid, chainLinked } = this.verifyRecord(record)
    const contentIntact = sha256(content) === record.contentHash
    const checks: CustodyChecks = {
      contentIntact,
      recordIntact,
      signatureValid,
      chainLinked,
      prevRecordFound: stored !== undefined,
    }
    // 库中原件比对：登记簿中该记录若被改动，与清单不一致即暴露。
    const storeConsistent = stored === undefined || stableStringify(stored) === stableStringify(record)
    const intact = contentIntact && recordIntact && signatureValid && chainLinked && storeConsistent
    const failures: string[] = []
    if (!contentIntact) failures.push('文件内容与签名时不一致（已被改动）')
    if (!recordIntact) failures.push('清单记录字段与记录哈希不匹配（清单被改动）')
    if (!signatureValid) failures.push('HMAC 签名无效（非本设备密钥签署）')
    if (!chainLinked) failures.push('与前一条公证记录衔接断裂')
    if (!storeConsistent) failures.push('登记簿中的记录与清单不一致')
    return {
      intact,
      checks,
      recordId: record.recordId,
      reason: failures.join('；'),
    }
  }

  /** 全链核验：逐条验哈希/验签/验衔接，返回断裂点。 */
  verifyChain(): ChainVerifyResult {
    const chain = this.list()
    let previous: CustodyRecord | undefined
    for (const record of chain) {
      const { recordIntact, signatureValid } = this.verifyRecord(record, chain)
      if (!recordIntact) {
        return { length: chain.length, intact: false, brokenAtSeq: record.seq, reason: `第 ${record.seq} 条记录哈希无法复算` }
      }
      if (!signatureValid) {
        return { length: chain.length, intact: false, brokenAtSeq: record.seq, reason: `第 ${record.seq} 条记录签名无效` }
      }
      // 相邻衔接：前条在链上（列表连续）时必须哈希咬合；
      // 前条已被修剪（seq 跳跃）时视为合法续链。
      if (previous !== undefined && record.seq === previous.seq + 1 && record.prevRecordHash !== previous.recordHash) {
        return { length: chain.length, intact: false, brokenAtSeq: record.seq, reason: `第 ${record.seq} 条与前条衔接断裂` }
      }
      if (previous !== undefined && record.seq > previous.seq + 1) {
        return { length: chain.length, intact: false, brokenAtSeq: record.seq, reason: `第 ${record.seq} 条与第 ${previous.seq} 条之间存在记录缺失` }
      }
      previous = record
    }
    return { length: chain.length, intact: true, brokenAtSeq: 0, reason: '' }
  }
}

// ---------------------------------------------------------------------------
// 清单解析（unknown → CustodyManifest；非法即抛错）
// ---------------------------------------------------------------------------

/** 解析伴随清单（接受对象或 JSON 字符串）。 */
export function parseCustodyManifest(raw: unknown): CustodyManifest {
  const source: unknown =
    typeof raw === 'string'
      ? safeJsonParse(raw)
      : raw
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error('清单必须是 JSON 对象')
  }
  const record = (source as Record<string, unknown>).record
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new Error('清单缺少 record 字段')
  }
  const r = record as Record<string, unknown>
  const stringField = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`清单 record.${field} 缺失或非法`)
    return value
  }
  const numberField = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`清单 record.${field} 缺失或非法`)
    return value
  }
  return {
    kind: 'dsh-companion-custody',
    version: 1,
    record: {
      seq: numberField(r.seq, 'seq'),
      recordId: stringField(r.recordId, 'recordId'),
      sessionId: stringField(r.sessionId, 'sessionId'),
      fileName: stringField(r.fileName, 'fileName'),
      format: stringField(r.format, 'format'),
      contentHash: stringField(r.contentHash, 'contentHash'),
      prevRecordHash: stringField(r.prevRecordHash, 'prevRecordHash'),
      recordHash: stringField(r.recordHash, 'recordHash'),
      signature: stringField(r.signature, 'signature'),
      signedAt: numberField(r.signedAt, 'signedAt'),
      redacted: r.redacted === true,
    },
    verifyHint: '',
  }
}

/** 宽容 JSON 解析（失败抛 Error）。 */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`清单 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
