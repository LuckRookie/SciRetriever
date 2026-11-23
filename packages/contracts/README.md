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
- `LibrarySearchPage.relevance_candidate_limit` 仅在相关度只给最新一批命中打分时返回，值为参与打分的候选上限。`relevance_limit: 1000` 仍表示相关度最多可翻到前 1,000 条，`total_count` 与 `count_truncated` 仍表示查询范围的计数。

- `src/marks.ts`：`MarkOperation.place` 使用 PDF 或文档目标、相似度和方法版本；`ReadingMark.places` 保存当前方法的定位记录，JSON 导出与列表同形。
