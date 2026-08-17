/**
 * 模块 I：协作与知识管理（Team & Knowledge）—— 数据模型。
 *
 * I1 团队配置同步：TeamConfigSnapshot（导出 JSON 文档，经 Git 仓库共享）+
 *    ConfigDiffEntry/SectionReport（本地优先 / 远程优先 / 手动合并三种策略）；
 * I2 执行经验库：ExperienceCard（任务完成后自动提取的执行卡片，
 *    含问题与解决方案的人工补充笔记）；
 * I3 Prompt 协作评审：ReviewRequest/ReviewComment/ReviewDecision
 *    （类 Code Review 流程：提交 → 评论批注 → 审核 → 合并主版本，全程可追溯）。
 */
export {};
