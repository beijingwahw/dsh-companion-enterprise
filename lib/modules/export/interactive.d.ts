/**
 * 模块 A 创新扩展：交互式自包含 HTML 导出（Self-Contained Interactive HTML）。
 *
 * 现实痛点：Markdown/PDF 导出是"死文档"——200 轮的长对话导出成 PDF 后
 * 无法搜索、无法按角色过滤、无法折叠长轮次，信息虽在但检索性归零。
 * 而把对话留在插件里又不可携带（会话存储依赖宿主环境）。
 *
 * 方案：单文件交互式 HTML——数据与渲染器全部内嵌，零外部依赖
 * （无 CDN、无字体加载、无 JS 框架），拷到 U 盘、发邮件、归档十年，
 * 双击打开即是一个可用的交互式对话档案：
 * - 即时全文搜索（防抖 120ms + 命中高亮 + 无命中轮次自动隐藏）；
 * - 角色筛选（全部 / 仅用户 / 仅助手）；
 * - 长轮折叠（超 800 字截断 + "展开全部"，长答案不再淹没短问答）；
 * - 时间戳开关与统计栏（轮次 / 双方字数 / 时间跨度 / 当前显示数）；
 * - "/" 快捷键聚焦搜索框。
 *
 * 安全设计（导出内容是不可信数据，naive innerHTML 导出是 XSS 载体）：
 * 1. 会话数据以 JSON 嵌入非执行的 <script type="application/json"> 块，
 *    其中 <、>、&、U+2028/U+2029 一律转义为 \uXXXX——既防止 </script>
 *    提前闭合注入，又是 JSON.parse 可正确解码的合法转义；
 * 2. 渲染全部走 DOM textContent / createElement，永不 innerHTML 用户内容；
 * 3. 搜索高亮通过文本节点切分 + <mark> 元素实现，天然免疫注入。
 */
import type { SessionHeader } from '../../types/harness.js';
import type { TranscriptTurn } from '../../core/transcript.js';
/**
 * 组装自包含交互式 HTML 文档。
 * @param session 会话头信息。
 * @param turns 对话轮次（渲染前的最终文本；脱敏等处理由调用方完成）。
 * @param options timestamps：时间戳缺省开关（查看器内可切换）。
 */
export declare function buildInteractiveHtml(session: SessionHeader, turns: readonly TranscriptTurn[], options: {
    timestamps: boolean;
}): string;
