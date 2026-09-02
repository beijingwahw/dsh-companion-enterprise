/**
 * 插件私有 HTTP API 路由器。
 *
 * 根插件在 ctx.webServer 上注册唯一的前缀路由 `/companion`
 * （docs/subsystems/web-server.md），各功能模块通过
 * `ctx.companion.http.add(method, path, handler)` 挂载自己的端点；
 * 浏览器侧客户端（src/client）通过同源 fetch 调用这些端点。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface HttpRequestContext {
  query: URLSearchParams
  /** POST/DELETE 请求的 JSON 正文（GET 为 undefined）。 */
  body: unknown
}

export type HttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpRequestContext,
) => void | Promise<void>

/** 带状态码的业务错误。 */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/**
 * 将错误收敛为用户安全的 HttpError：
 * HttpError 原样透传；其余错误以通用文案包装为 500，避免泄漏内部细节
 * （堆栈、文件路径、依赖报错原文）。端点错误出口的统一约定——
 * 该函数曾在导出与搜索模块各有一份逐字相同的拷贝，现收敛于此。
 */
export function toSafeHttpError(error: unknown, fallbackMessage: string): HttpError {
  if (error instanceof HttpError) return error
  return new HttpError(fallbackMessage, 500)
}

/** 提取命令面板可用的用户可读错误文本（不泄漏内部细节）。 */
export function userFacingMessage(error: unknown, fallbackMessage: string): string {
  if (error instanceof HttpError) return error.message
  return fallbackMessage
}

/**
 * 将 JSON 请求体数值收窄为 [min, max] 区间内的整数：
 * 缺省/非法（非 number 类型或非有限数）回退 fallback，越界钳制。
 * 严格类型检查：字符串数字（"5"）不静默转换——JSON 里本该是数字的位置
 * 出现字符串说明调用方传错了，静默纠正会掩盖协议 bug。
 * HTTP 数值参数钳制的统一实现（此前在 team/handoff 模块各有一份拷贝）。
 */
export function clampIntParam(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const clamped = Math.min(Math.max(Math.floor(value), min), max)
  return Number.isFinite(clamped) ? clamped : fallback
}

/**
 * 解析可选数值查询参数：缺省取默认值，非法抛 400，越界钳制到 [min, max]。
 * 与 clampIntParam 的差异：查询字符串参数非法时显式报错（而非静默回退），
 * 调用方因此能在 URL 拼错时立即发现。
 */
export function clampNumberParam(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw === null || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new HttpError(`${name} 必须是数字`, 400)
  return Math.min(max, Math.max(min, value))
}

export interface CompanionRouter {
  /** 挂载端点；返回注销 disposer。重复 (method, path) 抛错。 */
  add(method: 'GET' | 'POST' | 'DELETE', path: string, handler: HttpHandler): () => void
  /** 由 webServer 前缀路由委派的统一入口。 */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

/**
 * 创建路由器。
 * @param basePath 前缀路径（默认 /companion）。
 */
export function createRouter(basePath: string = '/companion'): CompanionRouter {
  const routes = new Map<string, HttpHandler>()
  return {
    add(method, path, handler) {
      const key = `${method} ${path}`
      if (routes.has(key)) throw new Error(`companion http: duplicate route ${key}`)
      routes.set(key, handler)
      return () => {
        // 身份比对：仅当当前注册的仍是同一个 handler 时才注销，
        // 避免误删注销期间被重新注册到同一 key 的新 handler。
        if (routes.get(key) === handler) routes.delete(key)
      }
    },
    async handle(req, res) {
      let url: URL
      try {
        url = new URL(req.url ?? '/', 'http://localhost')
      } catch {
        return sendJson(res, 400, { error: 'bad request url' })
      }
      // 前缀匹配要求完全相等，或其后紧跟 '/'（防止 /companion-x 被误匹配）。
      if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
        return sendJson(res, 404, { error: 'not found' })
      }
      const sub = url.pathname.slice(basePath.length) || '/'
      const key = `${req.method ?? 'GET'} ${sub}`
      const handler = routes.get(key)
      if (!handler) {
        return sendJson(res, 404, { error: `no route: ${key}` })
      }
      try {
        const body =
          req.method === 'GET' || req.method === 'HEAD' ? undefined : await readJsonBody(req)
        await handler(req, res, { query: url.searchParams, body })
      } catch (error) {
        // 错误响应本身也可能失败（如连接已断开）：兜底销毁连接，杜绝未处理 rejection。
        try {
          if (error instanceof HttpError) {
            sendJson(res, error.status, { error: error.message })
          } else {
            sendJson(res, 500, {
              error: error instanceof Error ? error.message : 'internal error',
            })
          }
        } catch {
          res.destroy()
        }
      }
    },
  }
}

/** 发送 JSON 响应。 */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return
  if (res.headersSent) {
    // 响应头已发出（handler 已开始写 body）：无法再改写状态行，直接结束响应。
    res.end()
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** 请求体读取默认超时（毫秒）。 */
const BODY_READ_TIMEOUT_MS = 30_000

/**
 * 读取并解析 JSON 请求体（大小上限默认 8 MB；空正文返回 {}）。
 * @param req 请求对象。
 * @param limitBytes 大小上限（字节）。
 * @param timeoutMs 读取超时（默认 30 秒）：慢速/停滞的 body 不会无限挂起，超时抛 408。
 */
export async function readJsonBody(
  req: IncomingMessage,
  limitBytes: number = 8 * 1024 * 1024,
  timeoutMs: number = BODY_READ_TIMEOUT_MS,
): Promise<unknown> {
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    const buffer: Buffer[] = []
    let size = 0
    let settled = false
    const timer = setTimeout(() => {
      fail(new HttpError('request body read timeout', 408))
      req.destroy()
    }, timeoutMs)
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.byteLength
      if (size > limitBytes) {
        fail(new HttpError('request body too large', 413))
        req.destroy()
        return
      }
      buffer.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(buffer)
    })
    req.on('error', (error: Error) => fail(error))
    req.on('close', () => {
      // 正常结束时 close 在 end 之后到达，settled 已置位；此处只处理提前断开。
      fail(new HttpError('request body stream closed early', 400))
    })
  })
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError('request body is not valid JSON', 400)
  }
}
