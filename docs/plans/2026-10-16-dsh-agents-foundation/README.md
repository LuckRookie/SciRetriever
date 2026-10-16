# DSH 统一 Agents 底座

状态：Completed（执行底座范围；真实内容质量对照未包含）。日期：2026-10-16。Primary owner：当前执行者。

Owner 已确认 DSH 应作为全项目唯一 Agents 底座，并授权先完成基础接入。目标是完整承接原单次文本/结构化/图像/工具调用，统一受控多轮会话，移除 Browser 专用默认与旧运行时生产路径。依据 [ADR 0031](../../architecture/decisions/0031-dsh-backed-agent-capabilities.md)、[需求](../../architecture/requirements.md)及 [HARNESS](../../../HARNESS.md)。

## 范围与边界

- 单次调用与会话均进入 DSH 原生 LlmRuntime；会话由 AgentLoop 管理。现有 AgentRuntime 导出仅允许作为同一实现的兼容入口。
- 保留模型协议、配置/凭据/Network owner、业务 prompt/schema、证据与发布 owner；不改变 catalog、用户配置、已有知识产物或业务任务输入。
- Browser 的图片投影、动作选择与输出限制由 Browser 显式提供；分析会话可使用纯文本、多图和受控工具。
- 本轮实现底座与所有既有模型消费者接线，不擅自改写分析算法、增加自主发现、提取执行器或持久会话。
- 用户要求能力完整覆盖及内容质量更好，费用/耗时不参与质量取舍。离线合同测试只证明底座能力；真实科研内容质量对照尚需独立样本验收，不能由本轮通过推导。
- 已授权代码、文档、合成测试与 Full；不访问真实 Provider、凭据、catalog/语料，不执行 Git 提交、发布或数据迁移。

## 结果块

| 结果块 | 输出与依赖 | 状态 |
| --- | --- | --- |
| [01 · 统一执行与集成验收](01-foundation.md) | 架构修订、原生 DSH 单次调用、通用会话、所有调用方接线和 Full | Completed |

## 验证与恢复

直接验证纯文本、结构化 schema、图片、工具历史/反馈、跨会话隔离、压缩、取消/关闭、错误与 provenance；现有分析、综合、身份核验、配置和 Browser 回归保持。使用合成数据与 fake/loopback，最终运行 `pnpm full`。

开始前工作树已含大量改动。基线及日志目录：`/tmp/sciretriever-dsh-foundation-UxPNgY`；`baseline.patch` 与 `status.txt` 记录原有已跟踪差异与状态，不用于覆盖工作树。恢复时先核对本计划和实际 diff，仅继续本轮任务。

当前进度：统一底座及所有既有消费者接入完成。相关 16 文件 / 197 项、Quick 和最终 Full 通过；Full 为 226 文件 / 1793 项通过、40 项按既有环境条件跳过，包含最终构建。精确结果见结果块和 `/tmp/sciretriever-dsh-foundation-UxPNgY/full.log`。文档链接与 diff 检查通过，依赖/锁文件无本轮变化，无 schema、真实数据或配置迁移，无 Git 提交。

[上级计划目录](../README.md)

交付边界：DshAgentRuntime 是唯一实现，AgentRuntime 为同一类的兼容别名；close() 现在可等待底座清理，消费者应 await。现有分析仍按原有单次/分段算法执行，但全部模型调用进入 DSH；通用会话可供后续业务能力接入。没有把本次框架与协议验证写成科研内容质量全面提升。
