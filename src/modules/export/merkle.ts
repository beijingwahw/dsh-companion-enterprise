/**
 * 模块 A 创新扩展：Merkle 包含证明可验证导出（Verifiable Batch Export）。
 *
 * 合规签名（custody.ts）回答「这份文件自导出后有没有被改」；但批量
 * 导出场景还有一个它答不了的问题：「这份文件确实在那批导出里吗？」
 * ——审计方拿到一份单独的 markdown，如何确信它属于某次官方归档，
 * 而不是事后拼凑的？这正是一千年前的思路、2008 年被 Bitcoin
 * 做到家喻户晓的结构：Merkle 树。
 *
 * 方法论：
 * 1. 叶哈希：每个导出条目的叶 = SHA-256(文件名 + '\n' + 内容哈希)——
 *    叶同时承诺「内容」与「身份」（防止同名内容调包）；
 * 2. 二叉 Merkle 树：奇数节点复制最后一个（Bitcoin 风格），逐层
 *    SHA-256 直到根。N 个条目只需 log₂N 个兄弟哈希即可证明包含；
 * 3. 根即承诺：一次批量导出只发布一个 32 字节根哈希（可邮件抄送、
 *    记入公证登记簿、写入 WORM 存储或任何外部锚点）；
 * 4. 包含证明：给定任一条目（文件名 + 内容），生成从叶到根的兄弟
 *    路径 {hash, direction}[]——第三方无需下载整个 ZIP，仅凭
 *    根 + 条目 + 证明即可本地复算验证，缺一不可伪造；
 * 5. 防剔除：若有人从归档中删掉某个「不方便」的会话，重打包的
 *    根必然改变，与已发布根一比即穿——沉默的删除第一次变得
 *    可检测（cryptographic append-only 的核心价值）。
 *
 * 与合规签名链正交互补：custody 证明「未改」，merkle 证明「在册」。
 */
import { createHash } from 'node:crypto'
import type { Domain } from '../../core/storage-adapter.js'

// ---------------------------------------------------------------------------
// Merkle 树原语（纯函数，hex 字符串域）
// ---------------------------------------------------------------------------

/** SHA-256（hex 输出；输入字符串按 UTF-8 编码）。 */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Merkle 树：levels[0] = 叶（输入顺序），逐层向上直到根。 */
export type MerkleLevels = readonly string[][]

/**
 * 构建 Merkle 树（Bitcoin 风格：每层奇数个节点时复制末位再配对）。
 * 空输入返回空 levels（root 为 undefined）。
 */
export function buildMerkleTree(leafHashes: readonly string[]): MerkleLevels {
  if (leafHashes.length === 0) return []
  const levels: string[][] = [[...leafHashes]]
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1]
    const next: string[] = []
    for (let i = 0; i < prev.length; i += 2) {
      const left = prev[i]
      const right = i + 1 < prev.length ? prev[i + 1] : prev[i]
      next.push(sha256Hex(`${left}${right}`))
    }
    levels.push(next)
  }
  return levels
}

/** 根哈希（hex；空树返回空串）。 */
export function merkleRootOf(leafHashes: readonly string[]): string {
  const levels = buildMerkleTree(leafHashes)
  const top = levels[levels.length - 1]
  return top?.[0] ?? ''
}

/** 兄弟节点（方向：true = 兄弟在右侧）。 */
export interface MerkleSibling {
  readonly hash: string
  /** true：兄弟是右孩子（拼接顺序 sibling 在后）。 */
  readonly right: boolean
}

/** 生成 index 叶到根的包含证明（兄弟路径）。 */
export function merkleProof(levels: MerkleLevels, index: number): MerkleSibling[] {
  const proof: MerkleSibling[] = []
  let cursor = index
  for (let level = 0; level < levels.length - 1; level += 1) {
    const nodes = levels[level]
    const siblingIndex = cursor % 2 === 0 ? cursor + 1 : cursor - 1
    if (siblingIndex < nodes.length) {
      proof.push({ hash: nodes[siblingIndex], right: siblingIndex > cursor })
    } else {
      // 奇数末位：兄弟是自身（复制配对）。
      proof.push({ hash: nodes[cursor], right: true })
    }
    cursor = Math.floor(cursor / 2)
  }
  return proof
}

/**
 * 验证包含证明：叶哈希沿兄弟路径逐层上推，终点须等于根。
 * 任何人（无需访问原数据集）都能复算——可验证性独立于本系统存在。
 */
export function verifyMerkleProof(
  leafHash: string,
  index: number,
  proof: readonly MerkleSibling[],
  root: string,
): boolean {
  let current = leafHash
  let cursor = index
  for (const sibling of proof) {
    current = sibling.right
      ? sha256Hex(`${current}${sibling.hash}`)
      : sha256Hex(`${sibling.hash}${current}`)
    cursor = Math.floor(cursor / 2)
  }
  return current === root
}

// ---------------------------------------------------------------------------
// 导出条目与叶哈希约定
// ---------------------------------------------------------------------------

/** 批量导出条目的可验证登记项。 */
export interface MerkleEntry {
  /** 条目文件名（ZIP 内名称）。 */
  readonly fileName: string
  readonly sessionId: string
  /** 内容 SHA-256（hex）。 */
  readonly contentHash: string
  /** 叶哈希 = SHA-256(fileName + '\n' + contentHash)（hex）。 */
  readonly leafHash: string
}

/** 单条目的叶哈希（同时承诺文件名与内容，防同名调包）。 */
export function leafHashOf(fileName: string, content: string | Uint8Array): string {
  return sha256Hex(`${fileName}\n${sha256Hex(content)}`)
}

/** 从条目序列构建登记表（叶哈希序列与树一并可复算）。 */
export function buildEntries(
  items: readonly { fileName: string; sessionId: string; content: Uint8Array }[],
): MerkleEntry[] {
  return items.map((item) => {
    const contentHash = sha256Hex(item.content)
    return {
      fileName: item.fileName,
      sessionId: item.sessionId,
      contentHash,
      leafHash: sha256Hex(`${item.fileName}\n${contentHash}`),
    }
  })
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

/** Merkle 批次记录（'export-merkle' 表，键为根哈希）。 */
export interface MerkleBundleRecord {
  readonly kind: 'bundle'
  /** 根哈希（hex；批次承诺）。 */
  readonly root: string
  readonly createdAt: number
  /** 导出格式（markdown/json/…）。 */
  readonly format: string
  /** 批次内条目（登记表：文件名/会话/内容哈希/叶哈希）。 */
  readonly entries: readonly MerkleEntry[]
}

/** Merkle 批次仓库（按根哈希索引）。 */
export class MerkleStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<MerkleBundleRecord>('export-merkle')
  }

  async save(record: MerkleBundleRecord): Promise<void> {
    await this.table.put(record.root, record)
  }

  get(root: string): MerkleBundleRecord | undefined {
    return this.table.get(root)
  }

  list(): MerkleBundleRecord[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async delete(root: string): Promise<void> {
    await this.table.delete(root)
  }
}

// ---------------------------------------------------------------------------
// 证明与核验服务
// ---------------------------------------------------------------------------

/** 包含证明响应（交给第三方自行复算的全部材料）。 */
export interface InclusionProof {
  readonly root: string
  readonly fileName: string
  /** 叶在批次中的位次（0 起）。 */
  readonly index: number
  readonly leafHash: string
  /** 兄弟路径（叶 → 根）。 */
  readonly proof: readonly MerkleSibling[]
  /** 复算说明（给审计人员）。 */
  readonly verifyHint: string
}

/** 生成条目的包含证明（从已存批次）。 */
export function buildInclusionProof(
  record: MerkleBundleRecord,
  fileName: string,
): InclusionProof | undefined {
  const index = record.entries.findIndex((entry) => entry.fileName === fileName)
  if (index < 0) return undefined
  const levels = buildMerkleTree(record.entries.map((entry) => entry.leafHash))
  return {
    root: record.root,
    fileName,
    index,
    leafHash: record.entries[index].leafHash,
    proof: merkleProof(levels, index),
    verifyHint:
      '复算方法：leaf = SHA-256(fileName + "\\n" + SHA-256(content))；' +
      '自 leaf 起按 proof 顺序拼接哈希（right=true 时兄弟在后）逐层 SHA-256，终点应等于 root',
  }
}

/** 核验结果。 */
export interface InclusionVerifyResult {
  /** 内容哈希与登记表一致。 */
  readonly contentMatch: boolean
  /** 叶 + 证明 → 根 复算成功。 */
  readonly proofValid: boolean
  /** 文件名在批次登记表中。 */
  readonly registered: boolean
  readonly verified: boolean
  readonly root: string
  readonly fileName: string
  readonly leafHash: string
  /** 不一致时的差异定位（中文）。 */
  readonly detail: string
}

/**
 * 核验一份文件内容确属某根哈希承诺的批次：
 * 1. 登记：文件名在批次登记表中；
 * 2. 内容：SHA-256(content) 与登记的内容哈希一致；
 * 3. 证明：叶 + 兄弟路径复算等于根。
 */
export function verifyInclusion(
  record: MerkleBundleRecord,
  fileName: string,
  content: Uint8Array,
  proof?: readonly MerkleSibling[],
): InclusionVerifyResult {
  const index = record.entries.findIndex((entry) => entry.fileName === fileName)
  const registered = index >= 0
  const contentHash = sha256Hex(content)
  const leafHash = leafHashOf(fileName, content)
  if (!registered) {
    return {
      contentMatch: false,
      proofValid: false,
      registered: false,
      verified: false,
      root: record.root,
      fileName,
      leafHash,
      detail: `文件名「${fileName}」不在根 ${record.root.slice(0, 12)}… 批次的登记表中（可能被剔除或从未导出）`,
    }
  }
  const entry = record.entries[index]
  const contentMatch = contentHash === entry.contentHash
  const effectiveProof = proof ?? buildInclusionProof(record, fileName)?.proof ?? []
  const proofValid = verifyMerkleProof(leafHash, index, effectiveProof, record.root)
  const verified = registered && contentMatch && proofValid
  const detail = !contentMatch
    ? `内容哈希不一致：文件自导出后被改动（登记 ${entry.contentHash.slice(0, 12)}…，实测 ${contentHash.slice(0, 12)}…）`
    : !proofValid
      ? '包含证明复算失败：叶到根的路径与批次根不匹配'
      : `通过：文件名、内容与包含证明均与根 ${record.root.slice(0, 12)}… 的承诺一致`
  return {
    contentMatch,
    proofValid,
    registered,
    verified,
    root: record.root,
    fileName,
    leafHash,
    detail,
  }
}
