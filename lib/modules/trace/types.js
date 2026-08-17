/**
 * 模块 E：执行轨迹分析器 —— 数据模型。
 *
 * Harness 原生“执行轨迹”记录每个步骤，但只是线性流水。这里把它规范化为
 * 带层级、耗时、Token 消耗与缓存命中的节点树，供可视化/异常标注/对比/统计复用。
 * 节点来源有两类：
 * 1. 从 session-query 的会话事件日志派生（tool/step/agent/model 事件）；
 * 2. 直接摄入 Harness 导出的原生轨迹 JSON（`ingestRawTrace`）。
 */
export {};
