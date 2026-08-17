/** 内置模板库（F3）：代码生成/代码审查/文档生成/数据分析/翻译/摘要。 */
export const BUILTIN_TEMPLATES = [
    {
        name: '代码生成',
        category: '代码生成',
        builtin: true,
        content: '你是一名资深 {{language}} 工程师。请遵循 {{code_style}} 代码风格，实现以下需求：\n\n{{requirement}}\n\n要求：\n1. 只输出可运行代码与必要注释；\n2. 处理边界情况与错误；\n3. 在结尾用一句话说明实现思路。',
    },
    {
        name: '代码审查',
        category: '代码审查',
        builtin: true,
        content: '请审查以下 {{language}} 代码，从正确性、性能、可读性、安全性四个维度给出意见：\n\n```\n{{code}}\n```\n\n输出格式：按维度列出问题（严重度：高/中/低）与修改建议，最后给出总体评价。',
    },
    {
        name: '文档生成',
        category: '文档生成',
        builtin: true,
        content: '为以下代码生成 {{doc_type}} 文档（语言：{{language}}）：\n\n```\n{{code}}\n```\n\n要求：包含用途说明、参数/返回值、使用示例与注意事项。',
    },
    {
        name: '数据分析',
        category: '数据分析',
        builtin: true,
        content: '你是一名数据分析师。请分析以下数据并回答问题：{{question}}\n\n数据：\n{{data}}\n\n要求：先给出结论摘要，再展示分析过程与关键数字，最后给出可执行建议。',
    },
    {
        name: '翻译',
        category: '翻译',
        builtin: true,
        content: '请将以下{{source_lang}}翻译为{{target_lang}}，保持专业术语准确、语气自然，只输出译文：\n\n{{text}}',
    },
    {
        name: '摘要',
        category: '摘要',
        builtin: true,
        content: '请对以下内容生成不超过 {{max_length}} 字的摘要，突出关键事实与结论：\n\n{{text}}',
    },
];
/** Prompt 版本仓库。 */
export class PromptVersionStore {
    table;
    constructor(domain) {
        this.table = domain.table('prompt-versions');
    }
    /** 全部版本（版本号升序）。 */
    list() {
        return this.table
            .entries()
            .map(([, value]) => value)
            .sort((a, b) => a.version - b.version);
    }
    get(version) {
        return this.table.get(String(version));
    }
    latest() {
        const all = this.list();
        return all[all.length - 1];
    }
    /** 保存新版本（自增版本号）。 */
    async save(content, note, tags) {
        const next = (this.latest()?.version ?? 0) + 1;
        const record = { version: next, content, note, tags, createdAt: Date.now() };
        await this.table.put(String(next), record);
        return record;
    }
    /** 回滚：将历史版本内容复制为新版本（保留完整历史，不删除中间版本）。 */
    async rollback(version, note) {
        const target = this.get(version);
        if (!target)
            throw new Error(`版本 v${version} 不存在`);
        return this.save(target.content, note || `回滚自 v${version}`, target.tags);
    }
    /** 为版本增删标签。 */
    async mutateTags(version, add, remove) {
        const target = this.get(version);
        if (!target)
            throw new Error(`版本 v${version} 不存在`);
        const tags = new Set(target.tags);
        for (const tag of add)
            tags.add(tag);
        for (const tag of remove)
            tags.delete(tag);
        const updated = { ...target, tags: [...tags] };
        await this.table.put(String(version), updated);
        return updated;
    }
}
/** Prompt 模板仓库（用户模板表 + 内置模板合并）。 */
export class PromptTemplateStore {
    table;
    constructor(domain) {
        this.table = domain.table('prompt-templates');
    }
    /** 全部模板：内置 + 用户（同名时用户覆盖内置）。 */
    list() {
        const merged = new Map();
        for (const builtin of BUILTIN_TEMPLATES) {
            merged.set(builtin.name, { ...builtin, updatedAt: 0 });
        }
        for (const [, value] of this.table.entries()) {
            merged.set(value.name, value);
        }
        return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }
    get(name) {
        const stored = this.table.get(name);
        if (stored)
            return stored;
        const builtin = BUILTIN_TEMPLATES.find((t) => t.name === name);
        if (!builtin)
            return undefined;
        return { ...builtin, updatedAt: 0 };
    }
    async save(name, category, content) {
        const record = {
            name,
            category: category || '自定义',
            content,
            builtin: false,
            updatedAt: Date.now(),
        };
        await this.table.put(name, record);
        return record;
    }
    /** 删除用户模板（内置模板不可删：删除同名覆盖即恢复内置）。 */
    async delete(name) {
        await this.table.delete(name);
    }
}
/** A/B 评分仓库。 */
export class PromptRatingStore {
    table;
    counter = 0;
    constructor(domain) {
        this.table = domain.table('prompt-ratings');
    }
    async rate(winner, promptA, promptB) {
        this.counter += 1;
        await this.table.put(`${Date.now()}-${this.counter}`, {
            ts: Date.now(),
            winner,
            promptA,
            promptB,
        });
    }
    /** 胜率统计。 */
    summary() {
        const entries = this.table.entries().map(([, value]) => value);
        return {
            total: entries.length,
            winsA: entries.filter((entry) => entry.winner === 'A').length,
            winsB: entries.filter((entry) => entry.winner === 'B').length,
            ties: entries.filter((entry) => entry.winner === 'tie').length,
        };
    }
}
/**
 * 变量插值：将 {{name}} 替换为 variables[name]；
 * 未提供的变量保留原样（便于发现缺失变量）。
 */
export function interpolateTemplate(template, variables) {
    return template.replace(/\{\{\s*([A-Za-z0-9_\u4e00-\u9fa5]+)\s*\}\}/g, (match, name) => {
        const value = variables[name];
        return value === undefined ? match : value;
    });
}
/** 提取模板中的全部变量名（去重，按出现顺序）。 */
export function extractTemplateVariables(template) {
    const names = [];
    const seen = new Set();
    for (const match of template.matchAll(/\{\{\s*([A-Za-z0-9_\u4e00-\u9fa5]+)\s*\}\}/g)) {
        const name = match[1];
        if (!seen.has(name)) {
            seen.add(name);
            names.push(name);
        }
    }
    return names;
}
