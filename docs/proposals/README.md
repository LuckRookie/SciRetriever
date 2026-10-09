# 活动提案

本目录只保存尚在讨论或评审中的产品与架构提案。提案用于说明为什么考虑一项变化、目标与非目标、备选方案和需要 owner 决定的问题，不授权实施，也不作为当前已发布行为的真相源；提案可以引用带日期和边界的当前问题证据。

## 当前提案

| 提案 | 状态 | 当前讨论范围 |
| --- | --- | --- |
| [Web Agent 工作台设计](2026-10-08-agent-workbench.md) · [两版 HTML 对比](2026-10-08-agent-workbench/comparison.html) | Draft | 已确认 Agent 工作台优先及四个一级入口；Codex 与 Opus 两版并列保留，本轮收口，配色等后续讨论，收敛后再编写 plans |

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
