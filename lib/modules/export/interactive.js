/** 长轮折叠阈值（字符）。 */
const COLLAPSE_THRESHOLD = 800;
/** 嵌入 JSON 的键名（script 标签 id）。 */
const DATA_ELEMENT_ID = 'conversation-data';
// ---------------------------------------------------------------------------
// JSON 安全嵌入
// ---------------------------------------------------------------------------
/**
 * 将 JSON 文本转义为可安全嵌入 <script> 块的形式：
 * <、>、& 转为 \uXXXX 防止 </script> 闭合注入与 HTML 实体解释；
 * U+2028/U+2029（JS 行终止符）转义保证旧引擎兼容。
 * \uXXXX 是合法 JSON 转义序列，JSON.parse 解码后还原为原字符。
 */
function escapeJsonForScript(json) {
    return json
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/[\u2028\u2029]/g, (ch) => (ch.charCodeAt(0) === 0x2028 ? '\\u2028' : '\\u2029'));
}
// ---------------------------------------------------------------------------
// 内嵌样式
// ---------------------------------------------------------------------------
/** 自包含样式（无外部字体/资源引用；打印时自动展开全部分页）。 */
const EMBEDDED_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; margin: 0; background: #f6f7f9; color: #1f2328; }
header { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e1e4e8; padding: 12px 16px; z-index: 10; }
h1 { font-size: 18px; margin: 0 0 4px; word-break: break-word; }
.meta { font-size: 12px; color: #57606a; margin: 0 0 8px; }
.controls { display: flex; gap: 8px; flex-wrap: wrap; }
input[type=search] { flex: 1; min-width: 200px; padding: 6px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; }
select, button { padding: 6px 10px; border: 1px solid #d0d7de; border-radius: 6px; background: #fff; font-size: 13px; cursor: pointer; color: #1f2328; }
button[aria-pressed="true"] { background: #eef4ff; border-color: #84a8ff; }
main { max-width: 860px; margin: 16px auto; padding: 0 12px; }
.turn { background: #fff; border: 1px solid #e6e8eb; border-radius: 8px; padding: 10px 14px; margin-bottom: 10px; }
.turn.user { border-left: 3px solid #4a7dff; }
.turn.assistant { border-left: 3px solid #2da44e; }
.turn-head { font-size: 12px; color: #57606a; margin-bottom: 6px; display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.turn-body { font-size: 14px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
mark { background: #fff3a3; padding: 0 1px; border-radius: 2px; }
.ellipsis { color: #57606a; }
button.expand { margin-top: 6px; font-size: 12px; color: #4a7dff; background: none; border: none; cursor: pointer; padding: 0; }
button.expand:hover { text-decoration: underline; }
.empty { text-align: center; color: #57606a; padding: 40px 0; }
footer { max-width: 860px; margin: 8px auto 24px; padding: 0 12px; font-size: 12px; color: #57606a; }
@media print { header .controls { display: none; } body { background: #fff; } .turn { break-inside: avoid; } }
`;
// ---------------------------------------------------------------------------
// 内嵌渲染器（vanilla JS，零依赖）
// ---------------------------------------------------------------------------
/**
 * 交互渲染器：读嵌入式 JSON → 搜索/筛选/折叠/时间戳渲染。
 * 纪律：全部 DOM 构造走 createElement/textContent，永不 innerHTML
 * 用户内容——对话文本是不可信数据，这是本文件防 XSS 的根本。
 */
const EMBEDDED_JS = String.raw `
(function () {
  'use strict';
  var COLLAPSE_THRESHOLD = ${COLLAPSE_THRESHOLD};
  var data = JSON.parse(document.getElementById('${DATA_ELEMENT_ID}').textContent);
  var state = { query: '', role: 'all', timestamps: !!data.defaultTimestamps };

  var searchInput = document.getElementById('search');
  var roleSelect = document.getElementById('role-filter');
  var stampButton = document.getElementById('stamp-toggle');
  var list = document.getElementById('conversation');
  var stats = document.getElementById('stats');
  var empty = document.getElementById('empty');

  function fmt(ms) {
    var d = new Date(ms + 8 * 3600 * 1000);
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  }

  function roleLabel(role) {
    return role === 'user' ? '用户' : role === 'assistant' ? '助手' : role;
  }

  function appendHighlighted(container, text) {
    if (!state.query) { container.textContent = text; return; }
    var lower = text.toLowerCase();
    var q = state.query.toLowerCase();
    var idx = 0;
    var pos = lower.indexOf(q, idx);
    while (pos !== -1) {
      if (pos > idx) container.appendChild(document.createTextNode(text.slice(idx, pos)));
      var mark = document.createElement('mark');
      mark.textContent = text.slice(pos, pos + q.length);
      container.appendChild(mark);
      idx = pos + q.length;
      pos = lower.indexOf(q, idx);
    }
    if (idx < text.length) container.appendChild(document.createTextNode(text.slice(idx)));
  }

  function matches(turn) {
    if (state.role !== 'all' && turn.role !== state.role) return false;
    if (!state.query) return true;
    return turn.text.toLowerCase().indexOf(state.query.toLowerCase()) !== -1;
  }

  function buildTurn(turn, index) {
    var article = document.createElement('article');
    article.className = 'turn ' + turn.role;
    var head = document.createElement('div');
    head.className = 'turn-head';
    var label = document.createElement('span');
    label.textContent = '#' + (index + 1) + ' ' + roleLabel(turn.role);
    head.appendChild(label);
    if (state.timestamps) {
      var time = document.createElement('span');
      time.textContent = fmt(turn.time);
      head.appendChild(time);
    }
    article.appendChild(head);
    var body = document.createElement('div');
    body.className = 'turn-body';
    var full = turn.text;
    if (full.length > COLLAPSE_THRESHOLD) {
      appendHighlighted(body, full.slice(0, COLLAPSE_THRESHOLD));
      var hint = document.createElement('span');
      hint.textContent = ' …';
      hint.className = 'ellipsis';
      body.appendChild(hint);
      var expand = document.createElement('button');
      expand.className = 'expand';
      expand.type = 'button';
      expand.textContent = '展开全部（' + full.length + ' 字）';
      expand.addEventListener('click', function () {
        body.textContent = '';
        appendHighlighted(body, full);
        expand.remove();
      });
      article.appendChild(body);
      article.appendChild(expand);
    } else {
      appendHighlighted(body, full);
      article.appendChild(body);
    }
    return article;
  }

  function render() {
    list.textContent = '';
    var visible = 0;
    for (var i = 0; i < data.turns.length; i += 1) {
      var turn = data.turns[i];
      if (!matches(turn)) continue;
      list.appendChild(buildTurn(turn, i));
      visible += 1;
    }
    empty.style.display = visible === 0 ? '' : 'none';
    var userChars = 0;
    var assistantChars = 0;
    for (var j = 0; j < data.turns.length; j += 1) {
      if (data.turns[j].role === 'user') userChars += data.turns[j].text.length;
      else if (data.turns[j].role === 'assistant') assistantChars += data.turns[j].text.length;
    }
    var parts = ['共 ' + data.turns.length + ' 轮', '用户 ' + userChars + ' 字', '助手 ' + assistantChars + ' 字'];
    if (data.turns.length > 0) {
      parts.push('时间跨度 ' + fmt(data.turns[0].time) + ' → ' + fmt(data.turns[data.turns.length - 1].time));
    }
    if (state.query || state.role !== 'all') parts.push('当前显示 ' + visible + ' 轮');
    stats.textContent = parts.join(' · ');
  }

  var debounceTimer = null;
  searchInput.addEventListener('input', function () {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      state.query = searchInput.value.trim();
      render();
    }, 120);
  });
  roleSelect.addEventListener('change', function () {
    state.role = roleSelect.value;
    render();
  });
  stampButton.addEventListener('click', function () {
    state.timestamps = !state.timestamps;
    stampButton.setAttribute('aria-pressed', state.timestamps ? 'true' : 'false');
    render();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === '/' && document.activeElement !== searchInput) {
      event.preventDefault();
      searchInput.focus();
    }
  });

  document.title = data.title;
  document.getElementById('title').textContent = data.title;
  document.getElementById('meta').textContent =
    '会话 ID：' + data.sessionId + ' · 创建：' + fmt(data.createdAt) + ' · 导出：' + fmt(data.exportedAt);
  stampButton.setAttribute('aria-pressed', state.timestamps ? 'true' : 'false');
  render();
})();
`;
// ---------------------------------------------------------------------------
// 文档组装
// ---------------------------------------------------------------------------
/**
 * 组装自包含交互式 HTML 文档。
 * @param session 会话头信息。
 * @param turns 对话轮次（渲染前的最终文本；脱敏等处理由调用方完成）。
 * @param options timestamps：时间戳缺省开关（查看器内可切换）。
 */
export function buildInteractiveHtml(session, turns, options) {
    const payload = {
        title: session.title || '未命名对话',
        sessionId: String(session.id),
        createdAt: session.createdAt,
        exportedAt: Date.now(),
        defaultTimestamps: options.timestamps,
        turns: turns.map((turn) => ({ role: turn.role, text: turn.text, time: turn.time })),
    };
    const json = escapeJsonForScript(JSON.stringify(payload));
    return [
        '<!DOCTYPE html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>对话导出</title>',
        `<style>${EMBEDDED_CSS}</style>`,
        '</head>',
        '<body>',
        '<header>',
        '<h1 id="title"></h1>',
        '<p id="meta" class="meta"></p>',
        '<div class="controls">',
        '<input id="search" type="search" placeholder="搜索对话内容（按 / 聚焦）…">',
        '<select id="role-filter" aria-label="角色筛选">',
        '<option value="all">全部角色</option>',
        '<option value="user">仅用户</option>',
        '<option value="assistant">仅助手</option>',
        '</select>',
        '<button id="stamp-toggle" type="button" aria-pressed="true">时间戳</button>',
        '</div>',
        '</header>',
        '<main>',
        '<div id="conversation"></div>',
        '<p id="empty" class="empty" style="display:none">未找到匹配的轮次</p>',
        '</main>',
        '<footer id="stats"></footer>',
        `<script type="application/json" id="${DATA_ELEMENT_ID}">${json}</script>`,
        `<script>${EMBEDDED_JS}</script>`,
        '</body>',
        '</html>',
    ].join('\n');
}
