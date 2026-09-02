/**
 * 模块 G 创新扩展：能力-成本-延迟帕累托前沿（Pareto Frontier）。
 *
 * 推荐引擎（G3）按「任务类型 + 预算 + 延迟要求」给出排序，但它是
 * 规则驱动的单点答案；Elo 排行榜只回答「谁强」，对「强多少值不值
 * 那个差价」沉默。企业选型的真实决策空间是三维的：能力（Elo）、
 * 成本（元/千次调用）、延迟（毫秒）——决策科学的经典结论是：这个
 * 空间里不存在全能冠军，只存在一组互不支配的「帕累托前沿」
 * （Pareto frontier）：前沿上的每个模型，都至少有一维优于所有
 * 试图替代它的模型。
 *
 * 方法论：
 * 1. 支配判定：A 支配 B ⟺ A.rating ≥ B.rating ∧ A.cost ≤ B.cost ∧
 *    A.latency ≤ B.latency ∧ 至少一维严格占优；
 * 2. 前沿提取：不被任何模型支配的集合——「多花一分钱/多等一毫秒
 *    都要换来能力」的诚实名单；
 * 3. 被支配归因：每个前沿之外的模型给出支配它的最优替代——
 *    「你花的每一分钱都被谁碾压」直接可见；
 * 4. 双冠军裁定：
 *    - 性价比冠军（Elo/元 最高）：单位预算买到最多能力；
 *    - 预算冠军（rating ≥ 最高分 − 100 中成本最低）：用最低成本
 *      拿到与顶配差距小于感知阈值的性能（100 Elo 内的差距在
 *      对战系统中约等于一个势均力敌的量级）。
 *
 * 纯函数模块：输入由端点组装（Elo 评级 × 计价引擎 × 金丝雀延迟）。
 */
/** 感知阈值：与最高分差距在该值内视为「同一量级」（预算冠军依据）。 */
const PERCEPTION_ELO_GAP = 100;
/** A 是否支配 B（三维全部不劣、至少一维严格优）。 */
function dominates(a, b) {
    const ratingNotWorse = a.rating >= b.rating;
    const costNotWorse = a.costCny <= b.costCny;
    const latencyNotWorse = a.latencyMs <= b.latencyMs;
    const strict = a.rating > b.rating || a.costCny < b.costCny || a.latencyMs < b.latencyMs;
    return ratingNotWorse && costNotWorse && latencyNotWorse && strict;
}
/** 输入 → 输出行（先算前沿标记与支配归因，再补充效率值）。 */
function toRow(input, onFrontier, dominatedBy) {
    return {
        model: input.model,
        rating: Math.round(input.rating),
        games: input.games,
        costCny: Math.round(input.costCny * 10_000) / 10_000,
        latencyMs: Math.round(input.latencyMs),
        latencyEstimated: input.latencyEstimated,
        onFrontier,
        dominatedBy,
        eloPerCny: input.costCny > 0 ? Math.round((input.rating / input.costCny) * 100) / 100 : 0,
    };
}
/**
 * 帕累托前沿分析（纯函数）。
 * @param inputs 全部候选（建议只含有 Elo 场次的模型，无场次评级无意义）。
 */
export function analyzeFrontier(inputs) {
    const rows = [];
    for (const input of inputs) {
        // 找到支配自己的模型集合。
        const dominators = inputs.filter((other) => other.model !== input.model && dominates(other, input));
        if (dominators.length === 0) {
            rows.push(toRow(input, true, null));
            continue;
        }
        // 最优替代：支配者中成本最低（同等压制下最便宜的替代品）。
        const best = dominators.reduce((acc, cur) => (cur.costCny < acc.costCny ? cur : acc));
        rows.push(toRow(input, false, best.model));
    }
    rows.sort((a, b) => b.rating - a.rating || a.costCny - b.costCny);
    const frontier = rows.filter((row) => row.onFrontier);
    // 双冠军裁定。
    let valueChampion = null;
    for (const row of frontier) {
        if (!valueChampion || row.eloPerCny > valueChampion.eloPerCny)
            valueChampion = row;
    }
    let budgetChampion = null;
    if (rows.length > 0) {
        const topRating = rows[0].rating;
        for (const row of rows) {
            if (topRating - row.rating > PERCEPTION_ELO_GAP)
                continue;
            if (!budgetChampion || row.costCny < budgetChampion.costCny)
                budgetChampion = row;
        }
    }
    const advice = rows.length === 0
        ? '尚无带 Elo 场次的模型，先通过对战或评测积累评级数据'
        : `前沿 ${frontier.length}/${rows.length} 个模型；` +
            (valueChampion && budgetChampion
                ? budgetChampion.model === valueChampion.model
                    ? `${budgetChampion.model} 同时是性价比与预算冠军，默认之选`
                    : `日常走 ${budgetChampion.model}（与顶配差 ≤${PERCEPTION_ELO_GAP} 分且最便宜），预算敏感批量任务走 ${valueChampion.model}（Elo/元最高）`
                : '前沿模型不足，样本积累后再裁定冠军');
    return {
        generatedAt: Date.now(),
        modelCount: rows.length,
        frontier,
        models: rows,
        valueChampion,
        budgetChampion,
        advice,
    };
}
/** 延迟档位先验（毫秒）：无金丝雀实测时按档位估计。 */
export const LATENCY_TIER_PRIOR_MS = {
    fast: 2_000,
    balanced: 5_000,
    slow: 12_000,
};
