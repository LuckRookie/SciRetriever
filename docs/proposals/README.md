# 活动提案

类型：导航
负责：活动提案
状态：现行

本目录只保存仍在讨论或评审的方案，不授权实施。文档类型与归属见[文档导航](../README.md)。

## 当前提案

- [知识加工](2026-11-16-knowledge-processing/README.md)：draft，暂缓。所有关于知识加工的计划内容（原计划 16 的全部、原计划 24 的第三次交付、原计划 21 与 24 中只为加工服务的部分），Owner 2026-11-16 决定收在这里，计划中不再出现。

已被精简首版替代的完整版知识加工方案已完整移入[历史提案](../archive/2026-10-17-knowledge-processing-full-design/README.md)；其它已接受或被替代材料见[历史索引](../archive/README.md)。目标合同中尚待定稿的部分继续在其归属技术文档标明，不能当作已发布接口。

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
