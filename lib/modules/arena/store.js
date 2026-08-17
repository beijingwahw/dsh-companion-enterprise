/** 用户自定义模型仓库。 */
export class CustomModelStore {
    table;
    constructor(domain) {
        this.table = domain.table('arena-custom-models');
    }
    /** 全部自定义模型（按创建时间升序）。 */
    list() {
        return this.table
            .entries()
            .map(([, value]) => value)
            .sort((a, b) => a.createdAt - b.createdAt);
    }
    get(id) {
        return this.table.get(id);
    }
    /** 新增或覆盖一个自定义模型。 */
    async save(record) {
        await this.table.put(record.id, record);
    }
    async delete(id) {
        await this.table.delete(id);
    }
}
