/**
 * 模块 G：多模型竞技场 —— 用户自定义模型存储。
 *
 * 'arena-custom-models' 表：用户可添加任意 OpenAI 兼容模型
 * （modelId + baseUrl + Key），与内置目录合并后参与对比/评测/推荐。
 */
import type { Domain } from '../../core/storage-adapter.js';
import type { CustomModelRecord } from './catalog.js';
/** 用户自定义模型仓库。 */
export declare class CustomModelStore {
    private readonly table;
    constructor(domain: Domain);
    /** 全部自定义模型（按创建时间升序）。 */
    list(): CustomModelRecord[];
    get(id: string): CustomModelRecord | undefined;
    /** 新增或覆盖一个自定义模型。 */
    save(record: CustomModelRecord): Promise<void>;
    delete(id: string): Promise<void>;
}
