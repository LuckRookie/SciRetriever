# 提案目录

`docs/proposals/` 保存产品方向、评估和决策输入。提案不是当前行为真相源，只有满足治理要求的 `docs/planning/` 执行计划可以记录实施授权。

## 文件元数据

除本 README 外，每份 Markdown 提案必须从第一行开始使用 TOML front matter：

```toml
+++
document_type = "proposal"
status = "direction-confirmed"
created = "2026-07-23"
updated = "2026-07-23"
+++
```

允许状态：

| 状态 | 含义 |
|---|---|
| `draft` | 正在形成方案 |
| `under-review` | 正在评审 |
| `direction-confirmed` | 产品方向已确认，不代表当前实现 |
| `rejected` | 明确不采用 |
| `superseded` | 已被其它提案替代，必须提供 `replaced_by` |

提案不得使用 `approved`、`in-progress` 或 `blocked` 等执行状态。

## 当前提案

- [以 Work 为中心的文献库产品提案](literature-library-product.md)，状态 `direction-confirmed`。
- [WP3 全文获取三方方案对比](wp3-acquisition-reference-comparison.md)，状态 `under-review`，保留 Zotero、`scansci-pdf` 与 SciRetriever 的设计对照，并记录批准 WP3 计划下已经落实的实现处置；实现状态仍以实施进度为准。

旧下载产品提案已移入 [2026-07 下载路线归档](../archive/2026-07-download-roadmap/README.md)，不在活动索引中列为当前方向。
