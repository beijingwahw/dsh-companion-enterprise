/**
 * 模块 D 创新扩展：组织记忆图谱（Organizational Memory Graph）。
 *
 * 关键词检索回答「哪个会话提到了 X」；它回答不了知识的结构性问题：
 * 「这个团队的知识枢纽是什么？」「围绕 X 还关联着什么、在哪些会话
 * 里被一起讨论过？」——这正是知识图谱的领域。
 *
 * 零依赖轻量实现（正则实体抽取 + 共现图 + PageRank）：
 * 1. 实体抽取：从会话标题与正文提取六类高价值实体——文件路径、
 *    CLI 命令、模型名、URL、错误码/工单号、技术缩写词；
 * 2. 共现构图：同一会话内共同出现的实体连边（权重 = 共现次数），
 *    会话成为实体的天然「上下文容器」；
 * 3. PageRank 枢纽排序：幂迭代（damping 0.85）计算实体中心性——
 *    反复被不同主题提及的实体就是组织的「知识十字路口」，
 *    它们是新人上手地图与跨项目知识的交汇点；
 * 4. 邻域查询：任一实体的关联实体（边权降序）与全部关联会话，
 *    把散落在历史会话中的同一主题知识重新聚合。
 */
import { SessionId } from '../../core/ids.js';
import { transcriptFromLog } from '../../core/transcript.js';
/** 实体类别中文标签。 */
export const ENTITY_KIND_LABELS = {
    path: '文件路径',
    command: '命令',
    model: '模型',
    url: '链接',
    'error-code': '错误/标识',
    acronym: '技术缩写',
};
// --------------------------------------------------------------------
// 实体抽取（正则，双语，零依赖）
// --------------------------------------------------------------------
/** 抽取规则（顺序即优先级：先匹配到的类别优先）。 */
const EXTRACTION_RULES = [
    // 文件路径：绝对/相对路径 + 常见扩展名。
    {
        kind: 'path',
        regex: /(?:[A-Za-z]:)?(?:[\w.-]+\/){1,}[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|c|cpp|h|json|yaml|yml|toml|md|css|html|sql|sh|proto|vue|svelte)/g,
    },
    // URL。
    { kind: 'url', regex: /https?:\/\/[^\s"'<>()\[\]{}]+/g },
    // CLI 命令。
    {
        kind: 'command',
        regex: /(?:^|[\s（(`])((?:npm|npx|pnpm|yarn|node|python|pip|uv|git|docker|kubectl|curl|wget|ssh|make|cmake|cargo|go|dotnet|java|mvn|gradle|brew|apt|systemctl|pytest|jest|vitest|tsc|eslint|prettier)\s[^\n]{0,80})/gm,
    },
    // 模型名。
    {
        kind: 'model',
        regex: /\b(?:deepseek-[a-z0-9.-]+|gpt-[a-z0-9.-]+|claude-[a-z0-9.-]+|gemini-[a-z0-9.-]+|glm-[a-z0-9.-]+|qwen[a-z0-9.-]*|kimi-[a-z0-9.-]+|llama-[a-z0-9.-]+|mistral-[a-z0-9.-]+)\b/gi,
    },
    // 错误码 / 工单号：ERR_XXX、#123、GH-456、CVE-2024-1234。
    {
        kind: 'error-code',
        regex: /\b(?:ERR_[A-Z0-9_]+|E[A-Z]+[0-9]{2,}|(?:GH|JIRA|issue|PR|CVE|RFC|ADR)[-#]\d+)\b/gi,
    },
    // 技术缩写（2~6 位全大写，排除常见非技术词）。
    { kind: 'acronym', regex: /\b[A-Z]{2,6}\b/g },
];
/** 无意义缩写黑名单（常见英文单词/非实体）。 */
const ACRONYM_STOPWORDS = new Set([
    'THE', 'AND', 'FOR', 'NOT', 'YOU', 'ARE', 'ALL', 'CAN', 'NOW', 'NEW', 'ONE', 'TWO',
    'USE', 'HOW', 'WHY', 'WHO', 'TOP', 'YES', 'NO', 'OK', 'AI', 'IT', 'IS', 'IN', 'ON',
    'AT', 'BY', 'OR', 'AS', 'AN', 'TO', 'DO', 'IF', 'SO', 'WE', 'MY', 'ME', 'UP', 'NO',
    'THIS', 'THAT', 'WITH', 'FROM', 'HAVE', 'WILL', 'YOUR', 'WHAT', 'WHEN',
]);
/** 单会话实体上限（防长会话单点霸图）。 */
const ENTITIES_PER_SESSION_CAP = 60;
/** 抽取一段文本中的实体（去重、规范化）。 */
function extractEntities(text) {
    const found = new Map();
    for (const rule of EXTRACTION_RULES) {
        rule.regex.lastIndex = 0;
        for (const match of text.matchAll(rule.regex)) {
            const raw = (match[1] ?? match[0]).trim().replace(/[。，；、"'`]+$/g, '');
            if (raw.length < 2 || raw.length > 100)
                continue;
            if (rule.kind === 'acronym' && ACRONYM_STOPWORDS.has(raw.toUpperCase()))
                continue;
            // 首个命中类别优先（path 优先于 acronym 等）。
            if (!found.has(raw))
                found.set(raw, rule.kind);
            if (found.size >= ENTITIES_PER_SESSION_CAP)
                return found;
        }
    }
    return found;
}
// --------------------------------------------------------------------
// 共现图 + PageRank
// --------------------------------------------------------------------
/** PageRank 阻尼系数。 */
const DAMPING = 0.85;
/** PageRank 迭代次数。 */
const PR_ITERATIONS = 20;
/** 参与图谱构建的会话数上限（按创建时间取最近 N 个）。 */
const MAX_GRAPH_SESSIONS = 200;
/** 单会话进入图谱的文本字符上限。 */
const GRAPH_CHAR_CAP = 20_000;
/**
 * 从会话查询引擎收集图谱语料（标题 + 转录正文）。
 * 单会话读取失败跳过，不影响其余语料。
 */
export async function collectGraphSessions(sessionQuery, maxSessions = MAX_GRAPH_SESSIONS) {
    const sessions = [...(await sessionQuery.listSessions())]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, maxSessions);
    const corpora = [];
    for (const session of sessions) {
        try {
            const snapshot = await sessionQuery.readSession(SessionId(session.id));
            const turns = transcriptFromLog(snapshot);
            corpora.push({
                id: session.id,
                title: session.title ?? null,
                createdAt: session.createdAt,
                text: turns
                    .map((turn) => turn.text)
                    .join('\n')
                    .slice(0, GRAPH_CHAR_CAP),
            });
        }
        catch {
            // 单会话读取失败（损坏/权限）：跳过。
        }
    }
    return corpora;
}
/**
 * 从会话语料构建记忆图谱。
 * @param sessions 每会话的（id、标题、创建时间、正文文本）。
 */
export function buildMemoryGraph(sessions) {
    const entities = new Map();
    const edges = new Map();
    const corpora = [];
    for (const session of sessions) {
        const found = extractEntities(`${session.title ?? ''}\n${session.text}`);
        if (found.size === 0)
            continue;
        for (const [name, kind] of found) {
            const entry = entities.get(name) ?? { kind, sessionIds: new Set() };
            entry.sessionIds.add(session.id);
            entities.set(name, entry);
        }
        // 共现边：同会话实体两两连接（键为排序后的名字对）。
        const names = [...found.keys()];
        for (let i = 0; i < names.length; i += 1) {
            for (let j = i + 1; j < names.length; j += 1) {
                const [a, b] = names[i] < names[j] ? [names[i], names[j]] : [names[j], names[i]];
                const key = `${a}\u0000${b}`;
                edges.set(key, (edges.get(key) ?? 0) + 1);
            }
        }
        corpora.push({
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            entities: new Set(found.keys()),
        });
    }
    return { entities, edges, corpora };
}
/** 邻接表（从边表派生）。 */
function adjacency(entities, edges) {
    const adj = new Map();
    for (const name of entities.keys())
        adj.set(name, new Map());
    for (const [key, weight] of edges) {
        const [a, b] = key.split('\u0000');
        adj.get(a)?.set(b, weight);
        adj.get(b)?.set(a, weight);
    }
    return adj;
}
/** PageRank 幂迭代。 */
function pageRank(adj) {
    const nodes = [...adj.keys()];
    if (nodes.length === 0)
        return new Map();
    let rank = new Map(nodes.map((n) => [n, 1 / nodes.length]));
    for (let iter = 0; iter < PR_ITERATIONS; iter += 1) {
        const next = new Map();
        let dangling = 0;
        for (const node of nodes) {
            const out = adj.get(node);
            if (!out || out.size === 0) {
                dangling += rank.get(node) ?? 0;
                continue;
            }
            const share = ((rank.get(node) ?? 0) * DAMPING) / out.size;
            for (const neighbor of out.keys()) {
                next.set(neighbor, (next.get(neighbor) ?? 0) + share);
            }
        }
        // 悬挂节点均分 + 随机跳转项。
        const base = (1 - DAMPING + DAMPING * dangling) / nodes.length;
        for (const node of nodes) {
            next.set(node, (next.get(node) ?? 0) + base);
        }
        rank = next;
    }
    return rank;
}
/** 生成图谱整体报告（Top 枢纽）。 */
export function graphReport(graph, hubLimit = 30) {
    const adj = adjacency(graph.entities, graph.edges);
    const rank = pageRank(adj);
    const hubs = [...graph.entities.entries()]
        .map(([name, entry]) => ({
        name,
        kind: entry.kind,
        sessionCount: entry.sessionIds.size,
        centrality: Math.round((rank.get(name) ?? 0) * 100_000) / 100_000,
        degree: adj.get(name)?.size ?? 0,
    }))
        .sort((a, b) => b.centrality - a.centrality || b.sessionCount - a.sessionCount)
        .slice(0, hubLimit);
    return {
        sessionCount: graph.corpora.length,
        entityCount: graph.entities.size,
        edgeCount: graph.edges.size,
        hubs,
    };
}
/** 查询某实体的邻域（关联实体 + 关联会话）。 */
export function entityNeighborhood(graph, name) {
    const entry = graph.entities.get(name);
    if (!entry)
        return undefined;
    const adj = adjacency(graph.entities, graph.edges);
    const rank = pageRank(adj);
    const neighbors = [...(adj.get(name)?.entries() ?? [])]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([neighbor, weight]) => ({
        name: neighbor,
        kind: graph.entities.get(neighbor)?.kind ?? 'acronym',
        weight,
    }));
    const sessions = graph.corpora
        .filter((corpus) => corpus.entities.has(name))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20)
        .map((corpus) => ({ id: corpus.id, title: corpus.title, createdAt: corpus.createdAt }));
    return {
        entity: {
            name,
            kind: entry.kind,
            sessionCount: entry.sessionIds.size,
            centrality: Math.round((rank.get(name) ?? 0) * 100_000) / 100_000,
            degree: adj.get(name)?.size ?? 0,
        },
        neighbors,
        sessions,
    };
}
