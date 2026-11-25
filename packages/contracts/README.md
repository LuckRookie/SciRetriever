# 中性合同包

类型：代码导航
负责：中性合同包
状态：现行

为应用与模块提供共享的数据形状、解析、规范编码和版本合同。

## 下级目录

| 目录                    | 职责         |
| ----------------------- | ------------ |
| [src/](src/README.md)   | 共享合同源码 |
| [test/](test/README.md) | 合同回归测试 |

## 内容入口

- [package.json](package.json)：@sciretriever/contracts 的公开导出。
- [tsconfig.json](tsconfig.json)：合同源码构建配置。

## 放置边界

合同保持供应商与运行环境中立；网络访问、SQL、Browser 操作和业务编排不放入本包。

SHA-256 优先使用 Web Crypto；普通 HTTP 浏览器缺少 SubtleCrypto 时使用固定 `@noble/hashes` 本地实现，保持相同字节输入与 hash 合同，不发起网络请求。标准向量、二进制边界及离线安装包有直接验证。

相关说明：[公共接口与版本兼容](../../docs/architecture/technical/01-product-interface.md)。

[上级目录](../README.md) · [项目 README](../../README.md)

- `src/processors.ts`：冻结加工输入、规范、记录/文本/旧知识引用、覆盖与集合合同；ProcessingTaskRequest v2 承载批量处理器快照。

- `src/filters.ts`：保存筛选的操作、名称规则、规范 LibraryQuery/LibrarySort 与逐项导入回执；字段按精确键集解析。
- 整库文字查询先按索引写入顺序取一窗原始命中，再应用筛选。至多 10,000 篇的工作集精确匹配，更大的工作集按原始命中或按工作集时间分窗。扫描未完时，计数是下界，搜索页同时返回 `scan_incomplete: true`、`scan_side`、`scan_limit` 与 `next_window_cursor`。`scan_side` 为 `hits` 时，`scan_limit` 以原始命中为单位，只提供相关度排序。值为 `members` 时，`scan_limit` 以工作集成员为单位，同时提供相关度与工作集时间排序。`count_truncated` 单独表示既有 10,000 条计数上限。保留同一规范化检索词，把 `next_window_cursor` 作为 `window_cursor` 传给搜索、计数或分面。成员窗还须保留同一工作集，可按各自筛选查更早一窗。窗口内翻页使用 `next_cursor`，相关度每窗至多翻到 1,000 项。
- 相关度工作集搜索仅在部分命中未打分时带 `relevance_scored_count`。该非负整数表示实际打分数，可能为 0。已打分项先按相关度排列，其余命中按工作集顺序接在后面。`next_cursor` 继续这套排序，`relevance_limit` 仍表示相关度分页上限。计数与分面的回执沿用各自的字段。

- `src/marks.ts`：`MarkOperation.place` 使用 PDF 或文档目标、相似度和方法版本；`ReadingMark.places` 保存当前方法的定位记录，JSON 导出与列表同形。
- `src/archive.ts` 中的 `ArchiveIssueCount` 是 `archive` 查询 `{ operation: "issue-count", request: {} }` 的结果。`total_count` 为当前 PDF 材料上未解决问题的条数，等于默认 `issues` 的总数。
- `src/intake.ts` 中的 `IntakeBatchSummary` 是省去 `full_text` 和 `estimates` 的 `IntakeBatch`。工作台 HTTP 的 `intake-batches` 查询使用 `{ operation: "list-summary", request: { limit, cursor } }`，结果由 `parseIntakeBatchSummaryPage` 解析。`limit` 默认 50，范围 1–100。`next_cursor` 可与 `list` 互用，到末页为 `null`。
