/**
 * 模块 G：多模型竞技场 —— 用户自定义模型存储。
 *
 * 'arena-custom-models' 表：用户可添加任意 OpenAI 兼容模型
 * （modelId + baseUrl + Key），与内置目录合并后参与对比/评测/推荐。
 */
import type { Domain } from '../../core/storage-adapter.js'
import type { CustomModelRecord } from './catalog.js'

/** 用户自定义模型仓库。 */
export class CustomModelStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<CustomModelRecord>('arena-custom-models')
  }

  /** 全部自定义模型（按创建时间升序）。 */
  list(): CustomModelRecord[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): CustomModelRecord | undefined {
    return this.table.get(id)
  }

  /** 新增或覆盖一个自定义模型。 */
  async save(record: CustomModelRecord): Promise<void> {
    await this.table.put(record.id, record)
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(id)
  }
}
