# DeepSeek Companion Enterprise

> DeepSeek Harness 企业级伴侣插件 —— 面向企业开发团队的 AI 工程效率与安全平台。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-blue)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek-Harness-orange)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.en.md) | 中文

**DeepSeek Companion Enterprise** 是构建于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 之上的企业级伴侣插件，为开发团队提供从**安全合规**到**协作效率**的完整能力矩阵。所有数据仅存于本地 Harness 沙箱，零遥测、零追踪。

---

## 核心能力

### 安全与合规
- **安全审计**：全量操作审计日志，支持导出与检索
- **DLP 数据防泄漏**：内置规则引擎自动识别 API Key、手机号、邮箱、密码等敏感信息，支持自定义规则与开关
- **提示注入检测**：六类攻击语义模式识别（指令覆写/角色越狱/系统提示词窃取/工具劫持/分隔符混淆/编码逃逸），风险评分三档判定，严格模式自动拦截
- **密钥管理**：命名密钥库、作用域控制、轮换提醒、泄露检测

### 团队协作与知识管理
- **团队配置**：成员偏好、默认策略、配置导入/导出/差异对比
- **知识快照**：会话快照存档与检索
- **经验库**：团队经验沉淀、笔记、智能推荐
- **经验自动蒸馏**：从会话轨迹自动挖矿"错误→修复"经验卡——信号挖矿、元提示蒸馏、语义去重合并、证据链回溯，复发度加权排序 + 人工晋升把关闭环
- **评审流**：多轮评审、评论、决策、合并

### 任务编排与自动化
- **任务编排器**：多步 Pipeline 定义、条件分支、超时重试、依赖管理
- **自愈执行**：错误分类（不可重试/限流/超时/瞬态）、指数退避全抖动、三态模型断路器（熔断冷却 + 半开探针）、主模型失败自动降级备跑
- **定时任务**：Cron 调度、空闲时段执行、断点续跑
- **任务队列**：运行中/排队/完成/失败状态追踪

### 开发者效率
- **多模型竞技场**：多模型并行对比、历史评测记录
- **模型漂移监控**：确定性金丝雀探针组 + 三维分布距离（成功率 z 检验 / 时延 KS 检验 / 输出风格 Jaccard），检测厂商静默更新导致的行为漂移
- **执行轨迹分析**：耗时/Token/异常检测、最慢步骤定位
- **SPC 统计过程控制**：EWMA 控制图 + Western Electric 规则监控轨迹指标漂移，区分缓慢漂移与突发波动
- **Prompt 工程工作台**：版本管理、模板库、变量插值
- **Prompt 自动优化**：元提示生成候选变体 + 配对符号检验（McNemar 精确法）判定统计显著性，仅显著胜者晋升版本库
- **API 成本治理**：实时计价（动态抓取官方定价页）、预算控制、用量报表
- **自适应模型路由**：滑动窗口 UCB1 多臂赌博机从调用结果中学习最优模型（成功率/成本/时延加权奖励），探索-利用平衡 + 非平稳漂移自动遗忘

### 基础能力
- **对话智能导出**：Markdown / PDF / JSON / 交互式 HTML，单会话与批量 ZIP
- **交互式 HTML 导出**：单文件自包含交互档案——全文搜索、角色筛选、长轮折叠、零外部依赖（无 CDN/无框架），JSON 安全嵌入免疫 XSS
- **上下文交接摘要**：自动生成会话交接摘要，武装给下一个对话
- **结构化分级交接**：四级信息分层（锚定/活动/参考/归档）+ 锚定约束强制继承守门（静默丢失在结构上不可能）+ 世系链溯源（传承 N 代告警）
- **全局对话检索**：全文检索 + 标签管理
- **语义邻域检索**：字符 shingle 邻域 + 伪相关反馈查询扩展 + 多源 RRF 融合，无向量库即可语义召回；相似会话（more-like-this）

---

## 安装

### 前置要求
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `>= 0.1.0`
- Node.js `^22.19 || >=24`
- pnpm（`npm install -g pnpm`）

### 一键安装

```bash
dsh plugin add beijingwahw/dsh-companion-enterprise --profile web
```

启动后插件面板自动加载：

```bash
dsh web
```

> 常用进阶命令：升级 `dsh plugin upgrade dsh-companion-enterprise --profile web`；卸载 `dsh plugin remove dsh-companion-enterprise --profile web`；本地路径安装 `dsh plugin add ./dsh-companion-enterprise --profile web`。

---

## 模块清单

| 模块 | 说明 | 默认启用 |
|------|------|:--------:|
| `security` | 安全审计与 DLP 数据防泄漏 | ✅ |
| `team` | 团队协作与知识管理 | ✅ |
| `orchestrator` | 任务编排与断点续跑 | ✅ |
| `arena` | 多模型竞技场 | ✅ |
| `trace` | 执行轨迹分析 | ✅ |
| `prompt` | Prompt 工程工作台 | ✅ |
| `cost` | API 成本治理 | ✅ |
| `export` | 对话智能导出 | ✅ |
| `handoff` | 上下文交接摘要 | ✅ |
| `search` | 全局对话检索 | ✅ |

所有模块均可在 `cordis.patch.yml` 中独立开关。

---

## 权限与隐私

- **网络**：仅访问 `api.deepseek.com`（模型调用）及五家官方定价页（只读 GET，用于动态计价）
- **存储**：仅使用 `companion` 存储域，数据保存在 Harness 插件沙箱本地
- **隐私**：无用户行为追踪、无遥测、无数据上报；对话内容与 API Key 仅存于本地

---

## 开发

```bash
pnpm install          # 安装依赖
pnpm run build        # 编译 TypeScript
pnpm run typecheck    # 类型检查
pnpm run dev          # 本地 HMR 开发
```

### 从源码构建安装（贡献者 / 离线场景）

```bash
git clone https://github.com/beijingwahw/dsh-companion-enterprise.git
cd dsh-companion-enterprise
pnpm install
pnpm run build
dsh plugin add . --profile web
```

### 项目结构

```
src/
├── core/            # 核心服务（存储适配、HTTP、加密、隐私、计价）
├── modules/         # 功能模块
│   ├── security/    # 安全审计与 DLP
│   ├── team/        # 团队协作与知识管理
│   ├── orchestrator/# 任务编排
│   ├── arena/       # 多模型竞技场
│   ├── trace/       # 执行轨迹分析
│   ├── prompt/      # Prompt 工程工作台
│   ├── cost/        # API 成本治理
│   ├── export/      # 对话智能导出
│   ├── handoff/     # 上下文交接摘要
│   └── search/      # 全局对话检索
├── client/          # Web UI 组件
└── types/           # 类型定义
```

---

## 贡献

欢迎提交 Issue 和 Pull Request。请遵循以下规范：

1. Fork 本仓库并创建特性分支
2. 确保 `npm run typecheck` 通过
3. 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范
4. 提交 PR 并描述变更内容

---

## 许可证

[MIT](LICENSE)

---

## 相关链接

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — Everything is a Plugin
- [dsh-plugin Topic](https://github.com/topics/dsh-plugin) — DeepSeek Harness 插件生态
- [DeepSeek Companion](https://github.com/beijingwahw/dsh-companion) — 社区版
- [DeepSeek Companion Dev](https://github.com/beijingwahw/dsh-companion-dev) — 开发版
