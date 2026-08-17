/**
 * 模块 F：Prompt 工程工作台 —— 存储。
 *
 * - PromptVersionStore：'prompt-versions' 表，每次保存生成自增版本号（v1, v2...），
 *   支持备注、标签（稳定版/实验版/生产版）与回滚（回滚=复制历史版本为新版本）；
 * - PromptTemplateStore：'prompt-templates' 表，用户模板覆盖同名内置模板；
 * - PromptRatingStore：'prompt-ratings' 表，A/B 人工评分（👍/👎 → 胜率统计）。
 */
import type { Domain } from '../../core/storage-adapter.js';
/** Prompt 版本记录（F1）。 */
export interface PromptVersion {
    /** 自增版本号（1 起）。 */
    readonly version: number;
    readonly content: string;
    /** 备注（如“加了 few-shot 示例”）。 */
    readonly note: string;
    /** 标签（如“稳定版”“实验版”“生产版”）。 */
    readonly tags: readonly string[];
    readonly createdAt: number;
}
/** Prompt 模板（F3）。 */
export interface PromptTemplate {
    readonly name: string;
    /** 模板分类。 */
    readonly category: string;
    readonly content: string;
    /** true=内置模板（不可删除，可被同名用户模板覆盖）。 */
    readonly builtin: boolean;
    readonly updatedAt: number;
}
/** A/B 评分记录（F2）。 */
export interface PromptRating {
    readonly ts: number;
    /** 'A' | 'B' | 'tie'。 */
    readonly winner: string;
    readonly promptA: string;
    readonly promptB: string;
}
/** 内置模板库（F3）：代码生成/代码审查/文档生成/数据分析/翻译/摘要。 */
export declare const BUILTIN_TEMPLATES: readonly Omit<PromptTemplate, 'updatedAt'>[];
/** Prompt 版本仓库。 */
export declare class PromptVersionStore {
    private readonly table;
    constructor(domain: Domain);
    /** 全部版本（版本号升序）。 */
    list(): PromptVersion[];
    get(version: number): PromptVersion | undefined;
    latest(): PromptVersion | undefined;
    /** 保存新版本（自增版本号）。 */
    save(content: string, note: string, tags: readonly string[]): Promise<PromptVersion>;
    /** 回滚：将历史版本内容复制为新版本（保留完整历史，不删除中间版本）。 */
    rollback(version: number, note: string): Promise<PromptVersion>;
    /** 为版本增删标签。 */
    mutateTags(version: number, add: readonly string[], remove: readonly string[]): Promise<PromptVersion>;
}
/** Prompt 模板仓库（用户模板表 + 内置模板合并）。 */
export declare class PromptTemplateStore {
    private readonly table;
    constructor(domain: Domain);
    /** 全部模板：内置 + 用户（同名时用户覆盖内置）。 */
    list(): PromptTemplate[];
    get(name: string): PromptTemplate | undefined;
    save(name: string, category: string, content: string): Promise<PromptTemplate>;
    /** 删除用户模板（内置模板不可删：删除同名覆盖即恢复内置）。 */
    delete(name: string): Promise<void>;
}
/** A/B 评分仓库。 */
export declare class PromptRatingStore {
    private readonly table;
    private counter;
    constructor(domain: Domain);
    rate(winner: 'A' | 'B' | 'tie', promptA: string, promptB: string): Promise<void>;
    /** 胜率统计。 */
    summary(): {
        total: number;
        winsA: number;
        winsB: number;
        ties: number;
    };
}
/**
 * 变量插值：将 {{name}} 替换为 variables[name]；
 * 未提供的变量保留原样（便于发现缺失变量）。
 */
export declare function interpolateTemplate(template: string, variables: Readonly<Record<string, string>>): string;
/** 提取模板中的全部变量名（去重，按出现顺序）。 */
export declare function extractTemplateVariables(template: string): string[];
