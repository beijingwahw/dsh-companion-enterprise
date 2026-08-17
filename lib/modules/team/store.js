/** 最近导入快照归档上限（条）。 */
export const SNAPSHOT_ARCHIVE_LIMIT = 10;
/** 执行卡片上限（条；超出滚动删除最旧）。 */
export const EXPERIENCE_CARD_LIMIT = 500;
/** 缺省团队偏好。 */
export const DEFAULT_TEAM_PREFS = {
    memberName: '',
    defaultStrategy: 'manual',
};
/** 生成模块内唯一 id。 */
export function teamId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
/** 团队偏好仓库（I1）。 */
export class TeamPrefsStore {
    table;
    constructor(domain) {
        this.table = domain.table('team-prefs');
    }
    /** 读取偏好（缺省值兜底）。 */
    get() {
        return this.table.get('prefs') ?? DEFAULT_TEAM_PREFS;
    }
    async put(prefs) {
        await this.table.put('prefs', prefs);
    }
}
/** 配置快照归档仓库（I1：最近导入记录）。 */
export class SnapshotArchiveStore {
    table;
    constructor(domain) {
        this.table = domain.table('team-snapshots');
    }
    /** 全部归档（新→旧）。 */
    list() {
        return this.table
            .entries()
            .map(([, value]) => value)
            .sort((a, b) => b.exportedAt - a.exportedAt);
    }
    get(key) {
        return this.table.get(key);
    }
    /** 归档一份快照（键含时间戳，超出上限时删除最旧）。 */
    async put(snapshot) {
        const key = `snap-${snapshot.exportedAt.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        await this.table.put(key, snapshot);
        const all = this.list();
        for (const entry of all.slice(SNAPSHOT_ARCHIVE_LIMIT)) {
            for (const [k, value] of this.table.entries()) {
                if (value === entry)
                    await this.table.delete(k);
            }
        }
        return key;
    }
}
/** 执行卡片仓库（I2）。 */
export class ExperienceCardStore {
    table;
    constructor(domain) {
        this.table = domain.table('experience-cards');
    }
    /** 全部卡片（新→旧）。 */
    list() {
        return this.table
            .entries()
            .map(([, value]) => value)
            .sort((a, b) => b.createdAt - a.createdAt);
    }
    get(id) {
        return this.table.get(id);
    }
    /** 按来源执行 id 查找（自动提取去重用）。 */
    byRunId(runId) {
        return this.list().find((card) => card.runId === runId);
    }
    async put(card) {
        await this.table.put(card.id, card);
        await this.trim();
    }
    async delete(id) {
        await this.table.delete(id);
    }
    /** 滚动清理：仅保留最新 EXPERIENCE_CARD_LIMIT 张。 */
    async trim() {
        const all = this.list();
        if (all.length <= EXPERIENCE_CARD_LIMIT)
            return;
        for (const card of all.slice(EXPERIENCE_CARD_LIMIT)) {
            await this.table.delete(card.id);
        }
    }
    /**
     * 检索：关键词（标题/Prompt 摘要/笔记/错误全文）、标签（任一命中）、
     * 模型（精确匹配）三条件 AND；缺省条件不参与过滤。
     */
    search(options) {
        const query = (options.query ?? '').trim().toLowerCase();
        const tags = options.tags ?? [];
        const model = (options.model ?? '').trim();
        return this.list()
            .filter((card) => {
            if (model && card.model !== model)
                return false;
            if (tags.length > 0 && !tags.some((tag) => card.tags.includes(tag)))
                return false;
            if (query && !cardSearchText(card).toLowerCase().includes(query))
                return false;
            return true;
        })
            .slice(0, options.limit ?? 200);
    }
    /**
     * 相似推荐：对输入文本分词后与卡片文本求交集得分，
     * 得分 > 0 的卡片按得分（再按创建时间）降序返回。
     */
    recommend(text, limit = 5) {
        const queryTokens = tokenize(text);
        if (queryTokens.length === 0)
            return [];
        const scored = [];
        for (const card of this.list()) {
            const cardTokens = new Set(tokenize(cardSearchText(card)));
            let score = 0;
            for (const token of queryTokens) {
                if (cardTokens.has(token))
                    score += 1;
            }
            if (score > 0)
                scored.push({ card, score });
        }
        scored.sort((a, b) => b.score - a.score || b.card.createdAt - a.card.createdAt);
        return scored.slice(0, limit);
    }
}
/** 评审请求仓库（I3）。 */
export class ReviewRequestStore {
    table;
    constructor(domain) {
        this.table = domain.table('review-requests');
    }
    /** 全部请求（新→旧）。 */
    list() {
        return this.table
            .entries()
            .map(([, value]) => value)
            .sort((a, b) => b.createdAt - a.createdAt);
    }
    get(id) {
        return this.table.get(id);
    }
    async put(request) {
        await this.table.put(request.id, request);
    }
    async delete(id) {
        await this.table.delete(id);
    }
}
/** 评审评论仓库（I3）。 */
export class ReviewCommentStore {
    table;
    constructor(domain) {
        this.table = domain.table('review-comments');
    }
    /** 某评审的全部评论（旧→新）。 */
    forReview(reviewId) {
        return this.table
            .entries()
            .map(([, value]) => value)
            .filter((comment) => comment.reviewId === reviewId)
            .sort((a, b) => a.createdAt - b.createdAt);
    }
    get(id) {
        return this.table.get(id);
    }
    async put(comment) {
        await this.table.put(comment.id, comment);
    }
    async delete(id) {
        await this.table.delete(id);
    }
}
/** 审核决定仓库（I3）。 */
export class ReviewDecisionStore {
    table;
    constructor(domain) {
        this.table = domain.table('review-decisions');
    }
    /** 某评审的全部决定（旧→新）。 */
    forReview(reviewId) {
        return this.table
            .entries()
            .map(([, value]) => value)
            .filter((decision) => decision.reviewId === reviewId)
            .sort((a, b) => a.ts - b.ts);
    }
    async put(decision) {
        await this.table.put(`${decision.reviewId}:${decision.reviewer}:${decision.ts}`, decision);
    }
}
// --------------------------------------------------------------------
// 检索辅助：分词与卡片全文
// --------------------------------------------------------------------
/** 卡片可检索全文（标题 + Prompt 摘要 + 标签 + 笔记 + 错误信息）。 */
function cardSearchText(card) {
    const notes = card.notes.map((note) => `${note.problem} ${note.solution}`).join(' ');
    return `${card.title} ${card.promptSummary} ${card.tags.join(' ')} ${notes} ${card.error}`;
}
/** 常见无意义词（分词后过滤）。 */
const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are',
    '的', '了', '和', '与', '及', '请', '把', '将', '进行', '一个',
]);
/**
 * 分词：ASCII 词按非字母数字切分（小写化），
 * CJK 连续段按二元组切分（适配中文无空格场景）；
 * 过滤停用词与单字符 ASCII 词。
 */
export function tokenize(text) {
    const tokens = [];
    const asciiWords = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    for (const word of asciiWords) {
        if (word.length >= 2 && !STOP_WORDS.has(word))
            tokens.push(word);
    }
    const cjkRuns = text.match(/[\u4e00-\u9fff]+/g) ?? [];
    for (const run of cjkRuns) {
        if (run.length === 1) {
            if (!STOP_WORDS.has(run))
                tokens.push(run);
            continue;
        }
        for (let i = 0; i + 2 <= run.length; i += 1) {
            const bigram = run.slice(i, i + 2);
            if (!STOP_WORDS.has(bigram))
                tokens.push(bigram);
        }
    }
    return tokens;
}
