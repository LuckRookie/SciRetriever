# 活动提案

本目录只保存尚在讨论或评审中的产品与架构提案。提案用于说明为什么考虑一项变化、目标与非目标、备选方案和需要 owner 决定的问题，不授权实施，也不描述当前已发布行为。

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

实施计划由 OMO 写入 `.omo/plans/`，不放在 `docs/`，也不归档为项目文档。
