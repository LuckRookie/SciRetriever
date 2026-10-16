# 历史文档归档

本目录保存已完成、被替代或历史设计材料，不定义当前产品行为。不要把归档日期或计划状态当成当前能力已经验收。

- [Agent 能力工具化与执行基础选型](2026-10-13-agent-runtime-options/README.md)：2026-10-13 已收敛为 DSH/Cordis，原比较提案由 ADR 0031 与已完成的 DSH 接入承接；该目录仅保留选型阶段的证据。

2026-10-13 新归档：

- [DSH 接入计划与提案](2026-10-13-dsh-agent-backend/README.md)：Completed；Full 234 文件 / 1768 项，真实对照及访问限制保持原记录。
- [Web 工作台实施](2026-10-13-web-workbench/README.md)：Completed；Full 214 文件 / 1676 项通过、39 项跳过，仅验证该轮授权的离线范围。
- [Browser 持续补位与计时](2026-10-13-browser-throughput/README.md)：Completed；Full 226 文件 / 1697 项通过，包含预览捕获与错误归因修复。
- [固定输入加工](2026-10-12-knowledge-processing-simplification/README.md)：Completed；Full 211 文件 / 1626 项通过、39 项跳过，真实加工与产物读取验证完成。
- [MinerU 解析](2026-10-12-mineru-parsing/README.md)：Completed；Full 1622 项通过、39 项跳过，未执行生产数据迁移。
- [Web 提案和合成原型](2026-10-08-agent-workbench/README.md)：Superseded；已由蓝白工作台设计与正式实施承接，历史设想不逐项视为已实现。

新归档采用精确文件忽略例外，确保普通 `git status` 可发现移入材料；其它历史目录仍按原策略忽略。

仓库 `.gitignore` 的 `archive/` 规则会忽略尚未跟踪的历史资料；已经跟踪或按用户明确要求纳入提交的归档会随 Git 保存。2026-10-11 按用户要求归档下面四个新完成计划，并保留此前已归档的名称治理提案；提交时仅精确纳入本轮授权的归档文档，不改变其它历史目录的忽略规则。活动需求、ADR、设计与当前源码仍是行为真相源。

- [元数据名称治理、五层 PDF 获取与 Browser 入口准备](2026-10-11-metadata-governance-pdf-routing/README.md)：Completed；2026-10-11 归档，Full 210 文件 / 1,606 项通过，39 项按既有条件跳过，未开展新的线上验收。
- [Provider 可选字段的有界容错](2026-10-10-provider-field-boundaries/README.md)：Completed；2026-10-11 归档，全部生产 Metadata adapters 接入，Full 205 文件 / 1,448 项通过，39 项按既有条件跳过。
- [真实发现与 PDF 获取缺陷修复](2026-10-10-live-discovery-acquisition-fixes/README.md)：Completed；2026-10-11 归档，Full 203 文件 / 1,380 项通过，39 项按既有条件跳过；真实复验与外部限制保留在计划中。
- [核心采集兼容、文章身份核验与 Agent 操作闭环](2026-10-08-core-agent-completion/README.md)：Completed；2026-10-11 归档，含 2026-10-09 生命周期修复，Full 201 文件 / 1,358 项通过，39 项按既有条件跳过。
- [元数据名称治理与 PDF API 路由提案](2026-10-11-metadata-governance-and-pdf-routing/proposal.md)：Accepted；保留 2026-10-11 获准实施时的讨论原文，完成证据见[归档实施计划](2026-10-11-metadata-governance-pdf-routing/README.md)。

- [按供应商组织适配代码](2026-10-07-provider-layout/README.md)：Completed；每家定义与适配器同目录，403 个公开导出保留；最终 Full 194 文件 / 1,334 项通过。
- [供应商能力与访问政策治理](2026-10-07-provider-governance/README.md)：Completed；统一服务定义、共享请求间隔/窗口和限流反馈；账户额度与 Browser 子资源限制见记录。
- [Browser 独立 worker 与后台下载](2026-10-05-browser-parallel-downloads/README.md)：Completed；最终 Full 与跨轮真实 Browser 验收完成，样本成功范围及外部条件见记录。

- [2026-09-28 TypeScript 知识架构迁移](2026-09-28-typescript-knowledge-architecture-migration/README.md)：Completed，27/27 项任务；168 files / 957 tests、零跳过，真实 Cloak portable + loopback 单独验收；真实数据切换与发布未执行。
- [2026-09-28整理前的设计与技术快照](2026-09-28-pre-knowledge-docs/README.md)：保留旧Python描述及旧格式细节；当前活动页已按TS与新需求整理。
- [2026-09-25需求与操作架构讨论计划](2026-09-25-requirements-and-operation-architecture/README.md)：Superseded，由[新迁移计划](2026-09-28-typescript-knowledge-architecture-migration/README.md)承接未执行项。
- [TypeScript与Browser迁移计划](2026-09-07-typescript-browser-workbench/README.md)、[架构UX计划](2026-09-16-architecture-and-ux-improvements/README.md)：保留当时完成条件和现场/生产切换限制。

其它既有归档保持原状。Python源码快照在仓库根archive下；本次不清理历史资料或修复其所有既有链接。当前入口见[docs导航](../README.md)。

## 子目录导航

- [2026-07-download-roadmap/](2026-07-download-roadmap/README.md)：2026-07 下载路线归档。
- [2026-07-literature-library/](2026-07-literature-library/README.md)：2026-07 文献库实施归档。
- [2026-08-26-llm-configuration-ux/](2026-08-26-llm-configuration-ux/README.md)：LLM 配置 UX 收敛计划。
- [2026-08-26-stateless-agents-browser-controller/](2026-08-26-stateless-agents-browser-controller/README.md)：无状态 Agents 与 Browser Controller 重构。
- [2026-08-26-user-configuration-home/](2026-08-26-user-configuration-home/README.md)：用户级统一配置文件迁移。
- [2026-08-provider-access/](2026-08-provider-access/README.md)：2026-08 供应商访问调度归档。
- [2026-09-02-agent-behavior-and-feedback-repair/](2026-09-02-agent-behavior-and-feedback-repair/README.md)：Agents 行为机制与反馈整修计划。
- [2026-09-02-logging-ux-repair/](2026-09-02-logging-ux-repair/README.md)：Logging UX 整修计划。
- [2026-09-03-browser-debug-observability/](2026-09-03-browser-debug-observability/README.md)：Browser Agent 无 PDF 调查与可观测性修复计划。
- [2026-09-03-browser-observation-readiness/](2026-09-03-browser-observation-readiness/README.md)：Browser Observation 就绪与页面交接实施计划。
- [2026-09-04-browser-capture-handoff/](2026-09-04-browser-capture-handoff/README.md)：Browser Capture 交接修复计划。
- [2026-09-04-browser-step-boundary-reduction/](2026-09-04-browser-step-boundary-reduction/README.md)：Browser Step 边界收敛计划。
- [2026-09-05-generic-browser-agent/](2026-09-05-generic-browser-agent/README.md)：Generic Browser Agent 重构计划。
- [2026-09-07-autonomous-browser-session/](2026-09-07-autonomous-browser-session/README.md)：Autonomous Browser Session 改造计划。
- [2026-09-07-browser-outcome-first/](2026-09-07-browser-outcome-first/README.md)：Browser Outcome-First 下载改造计划。
- [2026-10-11-metadata-governance-and-pdf-routing/](2026-10-11-metadata-governance-and-pdf-routing/README.md)：元数据治理与 PDF 路由：历史提案。
