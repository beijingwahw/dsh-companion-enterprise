/**
 * 插件私有 HTTP API 路由器。
 *
 * 根插件在 ctx.webServer 上注册唯一的前缀路由 `/companion`
 * （docs/subsystems/web-server.md），各功能模块通过
 * `ctx.companion.http.add(method, path, handler)` 挂载自己的端点；
 * 浏览器侧客户端（src/client）通过同源 fetch 调用这些端点。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
export interface HttpRequestContext {
    query: URLSearchParams;
    /** POST/DELETE 请求的 JSON 正文（GET 为 undefined）。 */
    body: unknown;
}
export type HttpHandler = (req: IncomingMessage, res: ServerResponse, ctx: HttpRequestContext) => void | Promise<void>;
/** 带状态码的业务错误。 */
export declare class HttpError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
/**
 * 将错误收敛为用户安全的 HttpError：
 * HttpError 原样透传；其余错误以通用文案包装为 500，避免泄漏内部细节
 * （堆栈、文件路径、依赖报错原文）。端点错误出口的统一约定——
 * 该函数曾在导出与搜索模块各有一份逐字相同的拷贝，现收敛于此。
 */
export declare function toSafeHttpError(error: unknown, fallbackMessage: string): HttpError;
/** 提取命令面板可用的用户可读错误文本（不泄漏内部细节）。 */
export declare function userFacingMessage(error: unknown, fallbackMessage: string): string;
/**
 * 将 JSON 请求体数值收窄为 [min, max] 区间内的整数：
 * 缺省/非法（非 number 类型或非有限数）回退 fallback，越界钳制。
 * 严格类型检查：字符串数字（"5"）不静默转换——JSON 里本该是数字的位置
 * 出现字符串说明调用方传错了，静默纠正会掩盖协议 bug。
 * HTTP 数值参数钳制的统一实现（此前在 team/handoff 模块各有一份拷贝）。
 */
export declare function clampIntParam(value: unknown, min: number, max: number, fallback: number): number;
/**
 * 解析可选数值查询参数：缺省取默认值，非法抛 400，越界钳制到 [min, max]。
 * 与 clampIntParam 的差异：查询字符串参数非法时显式报错（而非静默回退），
 * 调用方因此能在 URL 拼错时立即发现。
 */
export declare function clampNumberParam(raw: string | null, fallback: number, min: number, max: number, name: string): number;
export interface CompanionRouter {
    /** 挂载端点；返回注销 disposer。重复 (method, path) 抛错。 */
    add(method: 'GET' | 'POST' | 'DELETE', path: string, handler: HttpHandler): () => void;
    /** 由 webServer 前缀路由委派的统一入口。 */
    handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}
/**
 * 创建路由器。
 * @param basePath 前缀路径（默认 /companion）。
 */
export declare function createRouter(basePath?: string): CompanionRouter;
/** 发送 JSON 响应。 */
export declare function sendJson(res: ServerResponse, status: number, payload: unknown): void;
/**
 * 读取并解析 JSON 请求体（大小上限默认 8 MB；空正文返回 {}）。
 * @param req 请求对象。
 * @param limitBytes 大小上限（字节）。
 * @param timeoutMs 读取超时（默认 30 秒）：慢速/停滞的 body 不会无限挂起，超时抛 408。
 */
export declare function readJsonBody(req: IncomingMessage, limitBytes?: number, timeoutMs?: number): Promise<unknown>;
