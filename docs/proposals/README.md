# 活动提案

本目录只保存尚在讨论或评审中的产品与架构提案。提案用于说明为什么考虑一项变化、目标与非目标、备选方案和需要 owner 决定的问题，不授权实施，也不作为当前已发布行为的真相源；提案可以引用带日期和边界的当前问题证据。

## 当前提案

- [可信全文、文献档案与算子](../archive/2026-10-20-literature-archive-proposal/proposal.md)：2026-10-20 已接受并归档，长期决定见 [ADR 0037](../architecture/decisions/0037-literature-archive-and-proofread-text.md)，执行见[文献建档计划](../archive/2026-10-20-literature-archive/README.md)。
- [文献知识加工平台提案](../archive/2026-10-18-knowledge-processing-platform/proposal.md)：2026-10-18 已完成精简首版并与计划归档；当前合同见 ADR 0034。完整版仍是未执行参考。
- [文献知识加工平台：完整版设计](2026-10-17-knowledge-processing-full-design/README.md)：参考设计，不作为首版实施范围；保存提案原文副本、算子抽象设计与九块计划副本，以及按需引入各项能力的触发条件。

- [DSH 接入提案](../archive/2026-10-13-dsh-agent-backend/proposal.md)：已获批准并完成首期实施，和[实施计划](../archive/2026-10-13-dsh-agent-backend/README.md)一同归档；长期决定仍见 [ADR 0031](../architecture/decisions/0031-dsh-backed-agent-capabilities.md)。
- [Web Agent 工作台提案与原型](../archive/2026-10-08-agent-workbench/README.md)：已由蓝白设计与[正式工作台实施](../archive/2026-10-13-web-workbench/README.md)承接；原探索及未选择的原型作为历史保留，不把全部设想标为已实现。
- [Agent 后端选型讨论](../archive/2026-10-13-agent-runtime-options/README.md)及[元数据名称治理提案](../archive/2026-10-11-metadata-governance-and-pdf-routing/proposal.md)已归档。

既有产品方向由 ADR 约束；尚待定稿的模块交换细节保留在[统一产品接口：共享合同、结构解析与版本兼容](../architecture/technical/01-product-interface.md#6-共享合同结构解析与版本兼容)，其 Proposed 状态不等于已接受 API。执行与恢复归[活动计划](../plans/README.md)，不在这里复制。已经确认或被替代的材料见 `docs/archive/`；供应商访问调度的当前决策见 [ADR 0012](../architecture/decisions/0012-process-local-provider-access-scheduling.md)。

活动提案使用 TOML front matter：

```toml
+++
document_type = "proposal"
status = "draft"
created = "YYYY-MM-DD"
+++
```

`status` 只允许：

- `draft`：正在形成提案；
- `under-review`：等待或正在接受评审。

提案一旦确认方向、完成实施、被拒绝或被替代，应及时移入 `docs/archive/<日期-主题>/`，不得继续留在本目录。被接受的长期决策必须先同步到 `docs/architecture/` 或 ADR；当前用户行为必须同步到项目 `README` 和用户教程。

获准实施后，需要跨阶段恢复的实施计划写入 [`../plans/`](../plans)；Proposal 不兼任执行台账。

[上级目录](../README.md) · [项目 README](../../README.md)
