/**
 * 模块 F 创新扩展：k-匿名泛化引擎（k-Anonymity Generalization）。
 *
 * DLP 扫描（发送前预检）回答「这条消息里有没有敏感值」；污点追踪回答
 * 「敏感数据流到了哪里」。但当团队要把一批用户数据交给外部分析时，
 * 还有第三个问题：逐字段脱敏后剩下的「无害字段」组合起来还能认出
 * 具体的人吗？Latanya Sweeney 的著名研究（2002）给出了答案——
 * 87% 的美国人口可被 {邮编, 性别, 出生日期} 三元组唯一标识：
 * 单独无害的准标识符（Quasi-Identifier, QI）组合起来就是指纹。
 * 这正是 k-匿名的出发点：发布的数据中，任何 QI 组合至少对应
 * k 条记录——想认出一个人，至少要同时怀疑 k 个人。
 *
 * 引擎（单维全定义域泛化，Incognito/Samarati 谱系的轻量实现）：
 * 1. 每个准标识符定义一条泛化格（generalization lattice）：
 *    年龄 → 5 岁段 → 10 岁段 → 20 岁段 → 掩蔽 *；
 *    邮编 → 前 4 位 → 前 2 位 → 掩蔽 *；
 *    出生日期 → 年 → 年代 → 掩蔽 *；
 *    城市 → 省级（首字 + *）→ 掩蔽 *；
 *    性别 → 掩蔽 *；
 * 2. 贪心迭代：只要仍有 QI 组 < k，就在「泛化后违规记录数下降最多」
 *    的维度上升一级（信息损失最小化启发式）；
 * 3. 兜底抑制（suppression）：泛化到顶仍孤立的记录整行移除——
 *    宁可少发布一行，也不留可被唯一标识的个体；
 * 4. 发布报告：每维度泛化层级、组大小分布、抑制清单、
 *    等价类数与 k 达成状态——审计材料与数据一并交付。
 *
 * 纯函数模块：输入记录数组与 k，输出泛化后的记录与审计报告。
 */
/** 各维度的泛化层级数（含第 0 级 = 原值）。 */
const LATTICE_LEVELS = {
    age: 4,
    zip: 3,
    birth: 3,
    city: 2,
    gender: 1,
};
/** 各维度第 0 级之上的标签（报告展示用）。 */
const LEVEL_LABELS = {
    age: ['5岁段', '10岁段', '20岁段', '掩蔽'],
    zip: ['前4位', '前2位', '掩蔽'],
    birth: ['年份', '年代', '掩蔽'],
    city: ['省级', '掩蔽'],
    gender: ['掩蔽'],
};
/** 参与泛化的字段（缺省全部 QI；可由调用方裁剪）。 */
const ALL_FIELDS = ['age', 'zip', 'birth', 'city', 'gender'];
/** 输入记录条数上限。 */
const MAX_RECORDS = 5000;
// ---------------------------------------------------------------------------
// 单值泛化函数
// ---------------------------------------------------------------------------
/**
 * 年龄泛化：L0 原值 → L1 5 岁段 → L2 10 岁段 → L3 20 岁段 → L4 掩蔽。
 * 段格式「[下界,上界)」保持可读且不破坏序。
 */
function generalizeAge(value, level) {
    if (value === undefined || level >= 4)
        return '*';
    if (level === 0)
        return String(value);
    const width = level === 1 ? 5 : level === 2 ? 10 : 20;
    const lower = Math.floor(value / width) * width;
    return `[${lower},${lower + width})`;
}
/** 邮编泛化：L0 原值 → L1 前 4 位 → L2 前 2 位 → L3 掩蔽。 */
function generalizeZip(value, level) {
    if (value === undefined || level >= 3)
        return '*';
    const trimmed = value.trim();
    if (trimmed.length === 0)
        return '*';
    if (level === 0)
        return trimmed;
    const keep = level === 1 ? 4 : 2;
    return `${trimmed.slice(0, Math.min(keep, trimmed.length))}***`;
}
/** 出生日期泛化：L0 原值（YYYY-MM-DD）→ L1 年份 → L2 年代 → L3 掩蔽。 */
function generalizeBirth(value, level) {
    if (value === undefined || level >= 3)
        return '*';
    const match = /^(\d{4})/.exec(value.trim());
    if (!match)
        return level === 0 ? value.trim() : '*';
    const year = Number(match[1]);
    if (level === 0)
        return value.trim();
    if (level === 1)
        return String(year);
    const decade = Math.floor(year / 10) * 10;
    return `${decade}s`;
}
/** 城市泛化：L0 原值 → L1 省级（首 2 字 + *）→ L2 掩蔽。 */
function generalizeCity(value, level) {
    if (value === undefined || level >= 2)
        return '*';
    const trimmed = value.trim();
    if (trimmed.length === 0)
        return '*';
    if (level === 0)
        return trimmed;
    return `${trimmed.slice(0, 2)}**`;
}
/** 性别泛化：L0 原值 → L1 掩蔽。 */
function generalizeGender(value, level) {
    if (value === undefined || level >= 1)
        return '*';
    return value.trim() || '*';
}
/** 统一分发：单字段单级泛化。 */
function generalizeField(field, value, level) {
    switch (field) {
        case 'age':
            return generalizeAge(typeof value === 'number' ? value : undefined, level);
        case 'zip':
            return generalizeZip(typeof value === 'string' ? value : undefined, level);
        case 'birth':
            return generalizeBirth(typeof value === 'string' ? value : undefined, level);
        case 'city':
            return generalizeCity(typeof value === 'string' ? value : undefined, level);
        case 'gender':
            return generalizeGender(typeof value === 'string' ? value : undefined, level);
    }
}
// ---------------------------------------------------------------------------
// 组分析与贪心泛化
// ---------------------------------------------------------------------------
/** QI 组键：各字段泛化值用 ‖ 连接（组 = 键相同的记录集合）。 */
function groupKey(record, fields, levels) {
    return fields.map((field) => generalizeField(field, record[field], levels[field])).join('‖');
}
/** 各组大小统计：键 → 条数。 */
function groupSizes(records, fields, levels) {
    const sizes = new Map();
    for (const record of records) {
        const key = groupKey(record, fields, levels);
        sizes.set(key, (sizes.get(key) ?? 0) + 1);
    }
    return sizes;
}
/** 违规记录数：所在组 < k 的记录条数。 */
function violatingRecords(records, fields, levels, k) {
    const sizes = groupSizes(records, fields, levels);
    let count = 0;
    for (const record of records) {
        if ((sizes.get(groupKey(record, fields, levels)) ?? 0) < k)
            count += 1;
    }
    return count;
}
/** 需要参与分组的 QI 字段：记录中至少出现一次的字段。 */
function activeFields(records) {
    return ALL_FIELDS.filter((field) => records.some((record) => record[field] !== undefined));
}
/**
 * k-匿名化主入口：贪心单维泛化 + 兜底抑制。
 * @param records 输入记录（≤5000 条）。
 * @param k 目标匿名度（≥2）。
 * @throws Error 输入非法时。
 */
export function kanonymize(records, k) {
    if (!Number.isInteger(k) || k < 2)
        throw new Error('kanonymity: k 必须是 ≥2 的整数');
    if (records.length === 0)
        throw new Error('kanonymity: 输入记录不能为空');
    if (records.length > MAX_RECORDS) {
        throw new Error(`kanonymity: 输入记录不能超过 ${MAX_RECORDS} 条`);
    }
    const fields = activeFields(records);
    if (fields.length === 0) {
        throw new Error('kanonymity: 记录中不含任何准标识符字段（age/zip/birth/city/gender）');
    }
    if (records.length < k) {
        throw new Error(`kanonymity: 记录数（${records.length}）小于 k（${k}），无法匿名化`);
    }
    // 贪心迭代：每次把「违规下降最多」的维度升一级；平手取信息损失
    // 更小的（当前层级更低的）维度。全部到顶仍违规则交给抑制兜底。
    const levels = { age: 0, zip: 0, birth: 0, city: 0, gender: 0 };
    let violations = violatingRecords(records, fields, levels, k);
    while (violations > 0) {
        let bestField;
        let bestImprovement = 0;
        let bestLevel = -1;
        for (const field of fields) {
            const nextLevel = levels[field] + 1;
            if (nextLevel > LATTICE_LEVELS[field])
                continue;
            const candidate = { ...levels, [field]: nextLevel };
            const candidateViolations = violatingRecords(records, fields, candidate, k);
            const improvement = violations - candidateViolations;
            if (improvement > bestImprovement || (improvement === bestImprovement && improvement > 0 && bestField !== undefined && levels[field] < levels[bestField])) {
                bestField = field;
                bestImprovement = improvement;
                bestLevel = nextLevel;
            }
        }
        if (bestField === undefined || bestImprovement <= 0)
            break;
        levels[bestField] = bestLevel;
        violations -= bestImprovement;
    }
    // 兜底抑制：仍处 <k 组的记录整行移除（不发布）。
    const sizes = groupSizes(records, fields, levels);
    const published = [];
    const suppressed = [];
    for (const record of records) {
        if ((sizes.get(groupKey(record, fields, levels)) ?? 0) >= k)
            published.push(record);
        else
            suppressed.push(record);
    }
    // 等价类统计。
    const publishedSizes = groupSizes(published, fields, levels);
    const classes = [];
    for (const [key, size] of publishedSizes) {
        const parts = key.split('‖');
        const qi = {};
        fields.forEach((field, index) => {
            qi[field] = parts[index] ?? '*';
        });
        classes.push({ qi, size });
    }
    classes.sort((a, b) => b.size - a.size);
    const minClassSize = classes.reduce((min, c) => Math.min(min, c.size), Number.POSITIVE_INFINITY);
    const averageClassSize = classes.length > 0 ? published.length / classes.length : 0;
    const generalizations = fields.map((field) => ({
        field,
        level: levels[field],
        label: levels[field] === 0 ? '原值' : LEVEL_LABELS[field][levels[field] - 1] ?? '泛化',
        fullyMasked: levels[field] === LATTICE_LEVELS[field] &&
            LATTICE_LEVELS[field] > 0 &&
            LEVEL_LABELS[field][LATTICE_LEVELS[field] - 1] === '掩蔽',
    }));
    // 抑制兜底后：发布集内全部组 ≥ k（published 仅收组 ≥k 的记录）；
    // satisfied = 发布非空即达成——代价体现在 suppressionRate 里。
    const satisfied = published.length > 0 && minClassSize >= k;
    const output = published.map((record) => {
        const qi = {};
        const payload = {};
        for (const [key, value] of Object.entries(record)) {
            if (ALL_FIELDS.includes(key))
                qi[key] = generalizeField(key, value, levels[key]);
            else
                payload[key] = value;
        }
        return { qi, payload };
    });
    const suppressionRate = Math.round((suppressed.length / records.length) * 1000) / 1000;
    return {
        records: output,
        report: {
            inputCount: records.length,
            publishedCount: published.length,
            k,
            satisfied,
            suppressedCount: suppressed.length,
            suppressionRate,
            generalizations,
            equivalenceClasses: classes.slice(0, 200),
            classCount: classes.length,
            averageClassSize: Math.round(averageClassSize * 100) / 100,
            reidentificationRisk: published.length > 0 && Number.isFinite(minClassSize) ? Math.round((1 / minClassSize) * 1000) / 1000 : 0,
            summary: `${records.length} 条输入发布 ${published.length} 条（抑制 ${suppressed.length} 条，` +
                `${(suppressionRate * 100).toFixed(1)}%），${classes.length} 个等价类、平均组大小 ` +
                `${averageClassSize.toFixed(1)}；泛化决策：${generalizations
                    .filter((g) => g.level > 0)
                    .map((g) => `${g.field}→${g.label}`)
                    .join('、') || '无需泛化'}；` +
                `${satisfied ? `k=${k} 达成，最大再识别风险 ${(minClassSize > 0 ? 1 / minClassSize : 0).toFixed(3)}` : `k=${k} 未达成（抑制兜底后仍有孤立组）`}。`,
        },
    };
}
