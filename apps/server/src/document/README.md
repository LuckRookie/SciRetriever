# 可读文档与证据

提供固定版本的正文、片段、资源与证据读取。ADR 0037 的新文档来源是校订稿；v13 已支持显式发布为默认全文，原始解析入口已停止自动发布全文。完整建档仍在实施。

## 内容入口

- [builder.ts](builder.ts)：历史 UTF-8 结构的确定性重建，供已有版本完整性检查与历史 fixture。
- [proofread-builder.ts](proofread-builder.ts)：complete 校订版本到 v2 结构的确定性构建，保存区块 ID、页码与区域。
- [service.ts](service.ts)：`document parse` 的 raw 操作边界，不生成 Document，不更新默认全文。
- [read.ts](read.ts)：统一文档与证据读取、部分分页、用于人工核对的有界对照。
- [proofread-publication.ts](proofread-publication.ts)：完整校订版本到固定文档的显式发布与默认版本 CAS；索引刷新失败单独报告，不撤销有效文档。
- [location.ts](location.ts)：统一存储页码到公开页码的转换。
- [storage.ts](storage.ts)：文档存储协作接口。

`read.ts` 的内部 `withReadScope` 供知识／结果读取在一次逻辑操作内复用已核验文档；最多保留 16 份、32 MiB 的正文与序列化结构计量，结束即清空，独立请求重新验证。带独立预算计量的检索不走此复用。发布流程不跨写入保留读取证明。`storage.ts` 对资源采用有界并发完整校验，等待全部文件 reader 关闭后才交付结果；文件路径、hash 和篡改拒绝不变。

## 放置边界

第三方 parser 协议留在 parsing/backends；通用文件/SQLite 实现留在 storage；知识解释留在 analysis。

[上级目录](../README.md)

- `section-rules.ts`、`structure-extract.ts`：结构注释的规则识别、模型边界、继承、前置信息角色、图表与参考文献的纯提取逻辑；尚未接入注释持久化与正式命令。

结构注释由 `annotations.ts` 管理：规则/DSH 补充角色、图表与引用文本、人工锁定及版本发布；`section-classifier.ts` 只连接现有 DSH。`annotation-read.ts` 提供固定注释有界续读，outline/segments 经同一注释存储返回角色和过滤结果。引用关系仍由后续 Literature 接入负责，注释不拥有文献身份或关系合并。
