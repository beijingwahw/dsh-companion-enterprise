/**
 * 模块 F：结构化输出校验器（F4）。
 *
 * 轻量 JSON Schema 校验（子集：type/required/properties/items/enum/
 * minimum/maximum/minLength/maxLength/pattern/additionalProperties），
 * 不引入第三方依赖。校验失败时返回具体字段路径，供 UI 高亮标注。
 */
/** 单个校验错误。 */
export interface SchemaViolation {
    /** 字段路径（如 `user.address.city`；根为 ``）。 */
    readonly path: string;
    readonly message: string;
}
/**
 * 校验值是否符合 Schema（递归）。
 * @param value 待校验值（通常是 JSON.parse 后的结果）。
 * @param schema JSON Schema 子集。
 * @param path 当前路径（内部递归用）。
 */
export declare function validateAgainstSchema(value: unknown, schema: unknown, path?: string): SchemaViolation[];
/** 解析并校验 Schema 自身是否可用（对象即可，宽松处理）。 */
export declare function parseSchema(raw: unknown): Record<string, unknown>;
/**
 * 从模型输出文本中提取 JSON（容忍 ```json 代码块包裹与前后杂散文本）。
 * 解析失败返回 undefined。
 */
export declare function extractJsonFromOutput(output: string): unknown;
