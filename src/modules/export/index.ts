/**
 * 模块 A：对话智能导出插件。
 *
 * 经 ctx.companion.http 注册三个私有端点（GET /export/sessions、
 * POST /export/run、POST /export/batch）与合规签名导出端点组
 * （POST /export/custody/sign、POST /export/custody/verify、
 * GET /export/custody/chain：HMAC 签名链 + 防篡改验证，
 * 见 ./custody.js）与差分隐私统计导出端点组
 * （GET /export/dp/state、POST /export/dp/release、POST /export/dp/reset：
 * Laplace 机制加噪 + ε 预算账本，见 ./dp.js），经 ctx.commands 注册 `export` 与
 * `export-batch` 两个命令。HTTP 与命令复用 ./service.js 的同一套
 * 服务函数，不重复实现逻辑（DESIGN.md 第 5 节）。
 * 全部注册经 ctx.effect，随插件卸载自动回卷；错误一律收敛为
 * HttpError / 用户可读文本，不泄漏内部细节。
 */
import type { Context } from '@deepseek-ai/cordis'
import { HttpError, sendJson } from '../../core/http.js'
import { SessionId } from '../../core/ids.js'
import type { CommandInvocation, CommandResult } from '../../types/harness.js'
import { CustodyStore, parseCustodyManifest } from './custody.js'
import { DpBudgetStore } from './dp.js'
import {
  buildEntries,
  buildInclusionProof,
  MerkleStore,
  merkleRootOf,
  verifyInclusion,
  type MerkleSibling,
} from './merkle.js'
import { buildZip, type ZipEntry } from '../../core/zip.js'
import {
  buildBatchExport,
  buildSingleExport,
  toSafeHttpError,
  userFacingMessage,
  type ExportFormat,
  type ExportOptions,
} from './service.js'

/** 插件名。 */
export const name = 'companion-export'

/** 依赖服务：companion 根服务、会话查询、命令面板。 */
export const inject = ['companion', 'sessionQuery', 'commands']

/** 合法导出格式集合（html=交互式自包含页面；png=长图，仅 HTTP 客户端可用，需 canvas 光栅化）。 */
const EXPORT_FORMATS: readonly ExportFormat[] = ['markdown', 'pdf', 'json', 'png', 'html']

/** 格式类型守卫。 */
function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value)
}

/** 插件入口：所有注册经 ctx.effect，卸载时统一回卷。 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const disposers: Array<() => void> = [
      // 会话列表（客户端导出选择器数据源）。
      ctx.companion.http.add('GET', '/export/sessions', async (_req, res) => {
        try {
          const sessions = await ctx.sessionQuery.listSessions()
          sendJson(res, 200, { sessions })
        } catch (error) {
          throw toSafeHttpError(error, '获取会话列表失败')
        }
      }),

      // 单会话导出：响应为 file（base64）、print（html）或 raster（客户端光栅）。
      // HTTP 客户端具备 canvas 光栅能力，统一开启：PNG 长图与含 CJK 的 PDF
      // 由客户端光栅化成品，全程无 window.print() 对话框。
      ctx.companion.http.add('POST', '/export/run', async (_req, res, hctx) => {
        try {
          const { sessionId, options } = parseRunBody(hctx.body)
          const payload = await buildSingleExport(ctx.sessionQuery, sessionId, {
            ...options,
            raster: true,
          })
          sendJson(res, 200, payload)
        } catch (error) {
          throw toSafeHttpError(error, '导出会话失败')
        }
      }),

      // 批量导出：ZIP 文件载荷。
      ctx.companion.http.add('POST', '/export/batch', async (_req, res, hctx) => {
        try {
          const { sessionIds, options } = parseBatchBody(hctx.body)
          const payload = await buildBatchExport(ctx.sessionQuery, sessionIds, options)
          sendJson(res, 200, payload)
        } catch (error) {
          throw toSafeHttpError(error, '批量导出失败')
        }
      }),

      // 命令：导出当前/指定会话。
      ctx.commands.register({
        name: 'companion-export',
        description: '导出对话',
        input: { hint: '<会话ID> [markdown|pdf|json|png|html]' },
        handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
          try {
            const { sessionId, options } = parseExportInput(
              invocation.rawInput,
              invocation.agent.id,
            )
            const payload = await buildSingleExport(ctx.sessionQuery, sessionId, options)
            const text =
              payload.kind === 'file'
                ? `导出完成：${payload.fileName}`
                : `内容包含宽字符（如中文），已生成打印页 ${payload.fileName}，请在浏览器打印对话框中另存为 PDF`
            return { kind: 'success', text }
          } catch (error) {
            return { kind: 'error', text: userFacingMessage(error, '导出失败，请稍后重试') }
          }
        },
      }),

      // 命令：批量导出为 ZIP。
      ctx.commands.register({
        name: 'companion-export-batch',
        description: '批量导出为 ZIP',
        input: { hint: '<会话ID1>,<会话ID2>,…' },
        handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
          try {
            const sessionIds = (invocation.rawInput ?? '')
              .split(',')
              .map((part) => part.trim())
              .filter((part) => part.length > 0)
              .map((part) => SessionId(part))
            if (sessionIds.length === 0) {
              return { kind: 'error', text: '请提供要导出的会话 ID（逗号分隔）' }
            }
            const payload = await buildBatchExport(ctx.sessionQuery, sessionIds, {
              format: 'markdown',
            })
            return { kind: 'success', text: `批量导出完成：${payload.fileName}` }
          } catch (error) {
            return { kind: 'error', text: userFacingMessage(error, '批量导出失败，请稍后重试') }
          }
        },
      }),
    ]
    return () => {
      for (const dispose of [...disposers].reverse()) dispose()
    }
  }, 'companion-export.register')

  // ------------------------------------------------------------------
  // 合规签名导出（创新扩展）：存储域异步就绪后注册公证端点组。
  // ------------------------------------------------------------------
  void (async () => {
    const store = await ctx.companion.ready.catch(() => undefined)
    if (!store) return
    const custody = new CustodyStore(store.domain)
    const merkle = new MerkleStore(store.domain)
    const dp = new DpBudgetStore(store.domain)
    try {
      ctx.effect(() => {
        const disposers: Array<() => void> = [
          /**
           * 签署导出：文本格式（markdown/json/html）导出内容 + 伴随清单
           * （.custody.json 公证书）成对交付；记录追加 HMAC 签名链。
           */
          ctx.companion.http.add('POST', '/export/custody/sign', async (_req, res, hctx) => {
            try {
              const record = bodyAsRecord(hctx.body)
              if (typeof record.sessionId !== 'string' || record.sessionId.trim().length === 0) {
                throw new HttpError('sessionId 必填')
              }
              const format = record.format
              if (
                format !== 'markdown' && format !== 'json' && format !== 'html'
              ) {
                throw new HttpError('format 必须为 markdown/json/html 之一（合规签名仅支持文本格式）', 400)
              }
              const timestamps = parseFlag(record.timestamps, 'timestamps', true)
              const redact = parseFlag(record.redact, 'redact', false)
              const payload = await buildSingleExport(ctx.sessionQuery, SessionId(record.sessionId.trim()), {
                format,
                timestamps,
                redact,
                raster: false,
              })
              if (payload.kind !== 'file') {
                throw new HttpError('合规签名导出仅支持文本格式（markdown/json/html）', 400)
              }
              const content = Buffer.from(payload.contentBase64, 'base64')
              const custodyRecord = await custody.sign({
                sessionId: record.sessionId.trim(),
                fileName: payload.fileName,
                format,
                content,
                redacted: redact,
              })
              sendJson(res, 200, {
                fileName: payload.fileName,
                mimeType: payload.mimeType,
                contentBase64: payload.contentBase64,
                manifest: custody.buildManifest(custodyRecord),
                manifestFileName: `${payload.fileName}.custody.json`,
              })
            } catch (error) {
              throw toSafeHttpError(error, '合规签名导出失败')
            }
          }),

          /** 核验：文件内容 + 伴随清单逐项验证（内容/记录/签名/链衔接）。 */
          ctx.companion.http.add('POST', '/export/custody/verify', async (_req, res, hctx) => {
            try {
              const record = bodyAsRecord(hctx.body)
              if (typeof record.contentBase64 !== 'string' || record.contentBase64.length === 0) {
                throw new HttpError('contentBase64 必填', 400)
              }
              const content = Buffer.from(record.contentBase64, 'base64')
              const manifest = parseCustodyManifest(record.manifest)
              sendJson(res, 200, custody.verifyDocument(content, manifest))
            } catch (error) {
              if (error instanceof HttpError) throw error
              throw new HttpError(
                `核验失败：${error instanceof Error ? error.message : String(error)}`,
                400,
              )
            }
          }),

          /** 公证登记簿：全部签署记录 + 全链核验（含断裂点定位）。 */
          ctx.companion.http.add('GET', '/export/custody/chain', (_req, res) => {
            sendJson(res, 200, {
              records: custody.list(),
              chain: custody.verifyChain(),
            })
          }),

          /**
           * Merkle 可验证批量导出（创新扩展）：逐会话导出 → 叶哈希
           * （文件名+内容双重承诺）→ Merkle 根 → ZIP + 登记表成对交付。
           * 根哈希可发布到任何外部锚点；事后任何单份文件可出包含证明。
           */
          ctx.companion.http.add('POST', '/export/merkle/build', async (_req, res, hctx) => {
            try {
              const record = bodyAsRecord(hctx.body)
              const sessionIds = parseSessionIdList(record.sessionIds)
              const format = record.format
              if (format !== 'markdown' && format !== 'json' && format !== 'html') {
                throw new HttpError('format 必须为 markdown/json/html 之一（Merkle 导出仅支持文本格式）', 400)
              }
              const timestamps = parseFlag(record.timestamps, 'timestamps', true)
              const redact = parseFlag(record.redact, 'redact', false)
              const encoder = new TextEncoder()
              const items: Array<{ fileName: string; sessionId: string; content: Uint8Array }> = []
              const zipEntries: ZipEntry[] = []
              const usedNames = new Set<string>()
              for (const sessionId of sessionIds) {
                try {
                  const payload = await buildSingleExport(ctx.sessionQuery, SessionId(sessionId), {
                    format,
                    timestamps,
                    redact,
                    raster: false,
                  })
                  const fileName = uniqueName(usedNames, payload.fileName)
                  const bytes =
                    payload.kind === 'file'
                      ? new Uint8Array(Buffer.from(payload.contentBase64, 'base64'))
                      : encoder.encode(payload.html)
                  items.push({ fileName, sessionId, content: bytes })
                  zipEntries.push({ name: fileName, data: bytes })
                } catch {
                  // 单会话读取失败跳过（与批量导出语义一致），其余照常入树。
                }
              }
              if (items.length === 0) throw new HttpError('没有可导出的会话', 404)
              const entries = buildEntries(items)
              const root = merkleRootOf(entries.map((entry) => entry.leafHash))
              await merkle.save({
                kind: 'bundle',
                root,
                createdAt: Date.now(),
                format,
                entries,
              })
              const zipBytes = buildZip(zipEntries)
              sendJson(res, 200, {
                kind: 'file',
                fileName: `merkle-export-${root.slice(0, 12)}.zip`,
                mimeType: 'application/zip',
                contentBase64: Buffer.from(zipBytes).toString('base64'),
                /** 批次承诺（发布到外部锚点的就是这个 32 字节根）。 */
                root,
                rootSha256: root,
                entryCount: entries.length,
                entries,
                verifyHint:
                  '任何单份文件可经 POST /export/merkle/proof 获取包含证明，' +
                  '凭根哈希 + 文件 + 证明独立复算验证（无需整包）',
              })
            } catch (error) {
              if (error instanceof HttpError) throw error
              throw toSafeHttpError(error, 'Merkle 可验证导出失败')
            }
          }),

          /** 包含证明：批次内指定文件名的兄弟路径（交给第三方复算）。 */
          ctx.companion.http.add('POST', '/export/merkle/proof', (_req, res, hctx) => {
            try {
              const record = bodyAsRecord(hctx.body)
              const root = typeof record.root === 'string' ? record.root.trim() : ''
              if (root.length === 0) throw new HttpError('root 必填（批量导出返回的根哈希）', 400)
              const bundle = merkle.get(root)
              if (!bundle) throw new HttpError(`未找到根为 ${root.slice(0, 12)}… 的导出批次`, 404)
              const fileName = typeof record.fileName === 'string' ? record.fileName.trim() : ''
              if (fileName.length === 0) throw new HttpError('fileName 必填', 400)
              const proof = buildInclusionProof(bundle, fileName)
              if (!proof) {
                throw new HttpError(`文件「${fileName}」不在该批次的登记表中`, 404)
              }
              sendJson(res, 200, proof)
            } catch (error) {
              if (error instanceof HttpError) throw error
              throw toSafeHttpError(error, '生成包含证明失败')
            }
          }),

          /**
           * 核验包含：文件名 + 内容（base64）+ 根哈希（+ 可选证明）。
           * 登记匹配 / 内容一致 / 证明复算三关全过才算 verified。
           */
          ctx.companion.http.add('POST', '/export/merkle/verify', (_req, res, hctx) => {
            try {
              const record = bodyAsRecord(hctx.body)
              const root = typeof record.root === 'string' ? record.root.trim() : ''
              if (root.length === 0) throw new HttpError('root 必填', 400)
              const bundle = merkle.get(root)
              if (!bundle) throw new HttpError(`未找到根为 ${root.slice(0, 12)}… 的导出批次`, 404)
              const fileName = typeof record.fileName === 'string' ? record.fileName.trim() : ''
              if (fileName.length === 0) throw new HttpError('fileName 必填', 400)
              if (typeof record.contentBase64 !== 'string' || record.contentBase64.length === 0) {
                throw new HttpError('contentBase64 必填（被核验文件的内容）', 400)
              }
              const content = new Uint8Array(Buffer.from(record.contentBase64, 'base64'))
              const proof = Array.isArray(record.proof)
                ? (record.proof as unknown[]).flatMap((item): MerkleSibling[] => {
                    if (typeof item !== 'object' || item === null) return []
                    const sibling = item as Record<string, unknown>
                    if (typeof sibling.hash !== 'string') return []
                    return [{ hash: sibling.hash, right: sibling.right === true }]
                  })
                : undefined
              sendJson(res, 200, verifyInclusion(bundle, fileName, content, proof))
            } catch (error) {
              if (error instanceof HttpError) throw error
              throw toSafeHttpError(error, '核验包含证明失败')
            }
          }),

          /** 已发布批次清单（根哈希登记簿）。 */
          ctx.companion.http.add('GET', '/export/merkle/roots', (_req, res) => {
            sendJson(res, 200, {
              bundles: merkle.list().map((bundle) => ({
                root: bundle.root,
                createdAt: bundle.createdAt,
                format: bundle.format,
                entryCount: bundle.entries.length,
              })),
            })
          }),

          // --------------------------------------------------------------
          // 差分隐私统计导出（创新扩展）：Laplace 机制 + ε 预算账本
          // --------------------------------------------------------------
          /** 预算账本面板：总预算/已消耗/释放历史。 */
          ctx.companion.http.add('GET', '/export/dp/state', (_req, res) => {
            sendJson(res, 200, dp.state())
          }),

          /**
           * DP 释放：metrics=[{key, value, sensitivity?, kind?}]，epsilon 可选
           * （缺省 0.25，单次范围 [0.01, 2]）。预算耗尽时拒绝释放。
           */
          ctx.companion.http.add('POST', '/export/dp/release', async (_req, res, hctx) => {
            try {
              const record = bodyAsRecord(hctx.body)
              const rawMetrics = record.metrics
              if (!Array.isArray(rawMetrics) || rawMetrics.length === 0) {
                throw new HttpError('metrics 必须是非空数组', 400)
              }
              if (rawMetrics.length > 50) throw new HttpError('单次释放不能超过 50 个指标', 400)
              const metrics = rawMetrics.map((raw, index) => {
                if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
                  throw new HttpError(`metrics[${index}] 必须是对象`, 400)
                }
                const entry = raw as Record<string, unknown>
                const key = typeof entry.key === 'string' && entry.key.trim() ? entry.key.trim() : ''
                if (!key) throw new HttpError(`metrics[${index}].key 必须是非空字符串`, 400)
                const value = Number(entry.value)
                if (!Number.isFinite(value)) {
                  throw new HttpError(`metrics[${index}].value 必须是数字`, 400)
                }
                const sensitivity =
                  entry.sensitivity !== undefined ? Number(entry.sensitivity) : undefined
                if (sensitivity !== undefined && (!Number.isFinite(sensitivity) || sensitivity < 0)) {
                  throw new HttpError(`metrics[${index}].sensitivity 必须是非负数字`, 400)
                }
                const kind: 'count' | 'sum' = entry.kind === 'sum' ? 'sum' : 'count'
                return {
                  key,
                  value,
                  ...(sensitivity !== undefined ? { sensitivity } : {}),
                  kind,
                }
              })
              const epsilon =
                record.epsilon !== undefined ? Number(record.epsilon) : undefined
              if (epsilon !== undefined && (!Number.isFinite(epsilon) || epsilon < 0.01 || epsilon > 2)) {
                throw new HttpError('epsilon 必须在 [0.01, 2] 内', 400)
              }
              sendJson(res, 200, await dp.release(metrics, epsilon))
            } catch (error) {
              if (error instanceof HttpError) throw error
              throw toSafeHttpError(error, '差分隐私释放失败')
            }
          }),

          /** 重置预算账本（可选同时调整总预算 ε）。 */
          ctx.companion.http.add('POST', '/export/dp/reset', async (_req, res, hctx) => {
            try {
              const record = bodyAsRecord(hctx.body)
              const budgetEpsilon =
                record.budgetEpsilon !== undefined ? Number(record.budgetEpsilon) : undefined
              if (
                budgetEpsilon !== undefined &&
                (!Number.isFinite(budgetEpsilon) || budgetEpsilon < 0.01)
              ) {
                throw new HttpError('budgetEpsilon 必须是 ≥0.01 的数字', 400)
              }
              await dp.reset(budgetEpsilon)
              sendJson(res, 200, { ok: true, ...dp.state() })
            } catch (error) {
              if (error instanceof HttpError) throw error
              throw toSafeHttpError(error, '重置预算账本失败')
            }
          }),
        ]
        return () => {
          for (const dispose of [...disposers].reverse()) dispose()
        }
      }, 'companion-export.custody-register')
    } catch {
      // 等待存储域期间插件已被卸载（INACTIVE_EFFECT），放弃注册。
    }
  })()
}

/** 将请求体收窄为对象记录（形状不符抛 HttpError）。 */
function bodyAsRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError('请求体必须是 JSON 对象')
  }
  return body as Record<string, unknown>
}

/** 解析必填的格式字段。 */
function parseFormat(value: unknown): ExportFormat {
  if (typeof value === 'string' && isExportFormat(value)) return value
  throw new HttpError('format 必填，且必须为 markdown/pdf/json/png/html 之一')
}

/** 解析布尔开关（缺省取 fallback）。 */
function parseFlag(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new HttpError(`${field} 必须是布尔值`)
  return value
}

/** 解析 POST /export/run 请求体。 */
function parseRunBody(body: unknown): { sessionId: SessionId; options: ExportOptions } {
  const record = bodyAsRecord(body)
  if (typeof record.sessionId !== 'string' || record.sessionId.trim().length === 0) {
    throw new HttpError('sessionId 必填')
  }
  return {
    sessionId: SessionId(record.sessionId.trim()),
    options: {
      format: parseFormat(record.format),
      timestamps: parseFlag(record.timestamps, 'timestamps', true),
      redact: parseFlag(record.redact, 'redact', false),
    },
  }
}

/** 解析 POST /export/batch 请求体。 */
function parseBatchBody(body: unknown): { sessionIds: SessionId[]; options: ExportOptions } {
  const record = bodyAsRecord(body)
  const rawIds: unknown = record.sessionIds
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new HttpError('sessionIds 必填且必须为非空数组')
  }
  const sessionIds: SessionId[] = []
  for (const item of rawIds as readonly unknown[]) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new HttpError('sessionIds 必须全部为非空字符串')
    }
    sessionIds.push(SessionId(item.trim()))
  }
  return {
    sessionIds,
    options: {
      format: parseFormat(record.format),
      timestamps: parseFlag(record.timestamps, 'timestamps', true),
      redact: parseFlag(record.redact, 'redact', false),
    },
  }
}

/** 解析 POST /export/merkle/build 的会话 ID 列表（非空字符串数组）。 */
function parseSessionIdList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError('sessionIds 必填且必须为非空数组', 400)
  }
  const ids: string[] = []
  for (const item of value as readonly unknown[]) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new HttpError('sessionIds 必须全部为非空字符串', 400)
    }
    ids.push(item.trim())
  }
  return ids
}

/** 同名文件去重：冲突时在扩展名前追加序号（a.md → a-2.md）。 */
function uniqueName(used: Set<string>, name: string): string {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}${ext}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

/**
 * 解析 export 命令输入："<会话ID> [markdown|pdf|json]"。
 * 单个 token 且为合法格式时视为格式（会话取调用来源会话）；
 * 缺省会话时回退 invocation.agent.id；格式缺省 markdown。
 */
function parseExportInput(
  input: string | undefined,
  fallbackSessionId: SessionId | undefined,
): { sessionId: SessionId; options: ExportOptions } {
  const tokens = (input ?? '')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

  if (tokens.length === 0) {
    if (!fallbackSessionId) throw new HttpError('请指定要导出的会话 ID')
    return { sessionId: fallbackSessionId, options: { format: 'markdown' } }
  }

  const first = tokens[0].toLowerCase()
  if (tokens.length === 1 && isExportFormat(first)) {
    if (!fallbackSessionId) throw new HttpError('请指定要导出的会话 ID')
    return { sessionId: fallbackSessionId, options: { format: first } }
  }

  const sessionId = SessionId(tokens[0])
  if (tokens.length === 1) return { sessionId, options: { format: 'markdown' } }

  const format = tokens[1].toLowerCase()
  if (!isExportFormat(format)) {
    throw new HttpError(`不支持的导出格式“${format}”，可选 markdown/pdf/json/png/html`)
  }
  return { sessionId, options: { format } }
}
