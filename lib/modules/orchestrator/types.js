/**
 * 模块 H：断点续跑与任务编排 —— 数据模型。
 *
 * H1 可视化流水线：Pipeline + PipelineStep（模型/Prompt/输入来源/超时/重试/依赖）；
 * H2 断点续跑：PipelineRun 持久化每步中间结果，恢复时从最后成功步骤继续；
 * H3 批量队列：QueueTask（优先级/截止时间/失败策略）；
 * H4 定时调度：ScheduledJob（Cron 或自然语言）+ ScheduledRun 归档。
 */
export {};
