/** 及格线（关键词覆盖率）。 */
const PASS_THRESHOLD = 0.6;
/** 每题提取的关键词上限。 */
const MAX_KEYWORDS = 8;
/** 类别中文标签。 */
const KIND_LABELS = {
    anchor: '硬约束',
    reference: '参考定位',
    open: '开放问题',
    action: '起步行动',
};
// ---------------------------------------------------------------------------
// 关键词提取（拉丁词 + CJK 二元组，与点击模型词元化同源）
// ---------------------------------------------------------------------------
/** 文本归一化：小写 + 压空白。 */
function normalize(text) {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
/** 词元化：拉丁词（≥2 字符）+ CJK 二元组 + 路径/命令整词。 */
function extractKeywords(text) {
    const lower = normalize(text);
    const tokens = new Set();
    for (const word of lower.match(/[a-z0-9][a-z0-9_./:-]*/g) ?? []) {
        if (word.length >= 2)
            tokens.add(word);
    }
    for (const run of lower.match(/[\u4e00-\u9fa5]+/g) ?? []) {
        if (run.length === 1) {
            tokens.add(run);
            continue;
        }
        for (let i = 0; i + 1 < run.length; i += 1)
            tokens.add(run.slice(i, i + 2));
    }
    return [...tokens].slice(0, MAX_KEYWORDS);
}
/** 答案归一化后的关键词命中检查（子串包含，对词形变化宽容）。 */
function hitsKeyword(answerNormalized, keyword) {
    return answerNormalized.includes(keyword);
}
// ---------------------------------------------------------------------------
// 出卷
// ---------------------------------------------------------------------------
/**
 * 从结构化交接自动生成验收问题集（纯函数）。
 * 锚定每条一题、参考每条一题、开放问题每条一题、
 * 下一步/进行中合并一题起步行动（取第一条 next，无则第一条 in_progress）。
 */
export function generateAcceptanceTests(handoff) {
    const questions = [];
    let counter = 0;
    const push = (kind, question, expectedAnswer, tier, index) => {
        counter += 1;
        questions.push({
            id: `q${counter}`,
            kind,
            kindLabel: KIND_LABELS[kind],
            question,
            expectedAnswer,
            keywords: extractKeywords(expectedAnswer),
            source: { tier, index },
        });
    };
    handoff.tiers.anchors.forEach((anchor, index) => {
        push('anchor', `硬约束 ${index + 1} 的内容与边界是什么？（接班人必须能复述的红线）`, anchor.text, 'anchors', index);
    });
    handoff.tiers.reference.forEach((reference, index) => {
        const noun = reference.kind === 'path' ? '路径' : reference.kind === 'command' ? '命令' : reference.kind === 'id' ? '标识' : reference.kind === 'link' ? '链接' : '内容';
        push('reference', `参考项 ${index + 1}：交接提到的${noun}具体是什么？`, reference.text, 'reference', index);
    });
    handoff.tiers.active
        .filter((item) => item.kind === 'open_question')
        .forEach((item, index) => {
        push('open', `交接显式列为「悬而未决」的问题是什么？（显式的未知是资产）`, item.text, 'active', index);
    });
    const firstAction = handoff.tiers.active.find((item) => item.kind === 'next') ?? handoff.tiers.active.find((item) => item.kind === 'in_progress');
    if (firstAction) {
        push('action', '接手后的第一件事是什么？（必须能立刻起步）', firstAction.text, 'active', 0);
    }
    const byKind = { anchor: 0, reference: 0, open: 0, action: 0 };
    for (const question of questions)
        byKind[question.kind] += 1;
    return {
        handoffId: handoff.handoffId,
        depth: handoff.depth,
        totalQuestions: questions.length,
        byKind,
        questions,
        summary: `第 ${handoff.depth} 代交接生成 ${questions.length} 道验收题：` +
            `硬约束 ${byKind.anchor}、参考定位 ${byKind.reference}、开放问题 ${byKind.open}、起步行动 ${byKind.action}；` +
            `每题以关键词覆盖 ≥60% 为过——答不上来的，就是交接真正欠的债。`,
    };
}
// ---------------------------------------------------------------------------
// 评分
// ---------------------------------------------------------------------------
/**
 * 验收评分（纯函数）：对每题计算关键词覆盖率并裁定。
 * 未出现在 answers 里的题记未作答（0 分）。
 */
export function gradeAcceptance(suite, answers) {
    const answerMap = new Map(answers.map((a) => [a.questionId, a.answer]));
    const perQuestion = suite.questions.map((question) => {
        const raw = answerMap.get(question.id);
        if (raw === undefined || raw.trim().length === 0) {
            return {
                id: question.id,
                kind: question.kind,
                kindLabel: question.kindLabel,
                question: question.question,
                score: 0,
                passed: false,
                missingKeywords: question.keywords,
                unanswered: true,
            };
        }
        const normalized = normalize(raw);
        const missing = question.keywords.filter((keyword) => !hitsKeyword(normalized, keyword));
        const score = question.keywords.length > 0
            ? Math.round(((question.keywords.length - missing.length) / question.keywords.length) * 100) / 100
            : 1;
        return {
            id: question.id,
            kind: question.kind,
            kindLabel: question.kindLabel,
            question: question.question,
            score,
            passed: score >= PASS_THRESHOLD,
            missingKeywords: missing,
            unanswered: false,
        };
    });
    const passed = perQuestion.filter((q) => q.passed).length;
    const answered = perQuestion.filter((q) => !q.unanswered).length;
    const score = suite.questions.length > 0 ? Math.round((passed / suite.questions.length) * 100) / 100 : 0;
    const verdict = score >= 0.8 ? 'passed' : score >= 0.6 ? 'borderline' : 'failed';
    // 最薄弱类别：过题率最低且至少一题未过。
    let weakestKind = null;
    let weakestRate = 1;
    for (const kind of ['anchor', 'reference', 'open', 'action']) {
        const items = perQuestion.filter((q) => q.kind === kind);
        if (items.length === 0)
            continue;
        const rate = items.filter((q) => q.passed).length / items.length;
        if (rate < 1 && rate < weakestRate) {
            weakestRate = rate;
            weakestKind = kind;
        }
    }
    const failedCount = perQuestion.length - passed;
    return {
        handoffId: suite.handoffId,
        totalQuestions: perQuestion.length,
        answered,
        passed,
        score,
        verdict,
        perQuestion,
        weakestKind,
        summary: `${perQuestion.length} 题过 ${passed}（得分 ${score.toFixed(2)}，裁定 ${verdict === 'passed' ? '验收通过' : verdict === 'borderline' ? '勉强及格' : '验收不通过'}）；` +
            (weakestKind ? `薄弱环节：${KIND_LABELS[weakestKind]}` : '无薄弱环节') +
            (failedCount > 0 ? `；${failedCount} 题未达标，缺失关键词：${perQuestion.filter((q) => !q.passed).flatMap((q) => q.missingKeywords).slice(0, 6).join('、')}` : '') +
            '。',
    };
}
