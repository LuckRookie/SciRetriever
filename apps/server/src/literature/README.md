# 文献事实与身份

拥有文献身份、元数据汇聚、主 PDF 及内容关系、书目查询和已确认材料的业务接纳规则。

## 内容入口

- [identity.ts](identity.ts)：文献身份接纳。
- [metadata-rules.ts](metadata-rules.ts)：来源元数据的确定性处理。
- [primary-pdf.ts](primary-pdf.ts)：主 PDF 关系。
- [query.ts](query.ts)：文献库查询。
- [article-identity.ts](article-identity.ts)：下载后的文章身份判断事实。

## 放置边界

外部响应先经 provider 转换；storage 只持久化已确认事实，不自行决定文献合并或接纳。

[上级目录](../README.md)

- [metadata-types.ts](metadata-types.ts)：带版本的来源类型映射，由 `metadata-rules.ts` 导出；未知值保守返回空，原始字符串由 observation 保留。Provider observation 保留 `source_type` 和映射版本；统一元数据、查询与后备匹配使用 `publication_form` / `article_kind`。

- `metadata-fields.ts` / `metadata-service.ts`：逐字段裁决、来源、冲突及人工编辑/解锁；与 identity 共同使用单个元数据发布事务和 revision CAS，不建立第二套元数据。
- `metadata-proposals.ts` / `metadata-agent.ts` / `archive-metadata.ts`：建档内部的 DSH 元数据提议；只读固定校订稿的第一页及 front-matter/abstract/keywords，逐字段核对片段和 DOI。无模型时明确失败，不回退到旧两阶段总结。建档编排由相邻的 `archive/` 模块调用。

- `bibliography-import.ts`：共享的 BibTeX/RIS/CSL 解码和元数据导入；从 Entry 移入同一 Literature 所有者，CLI、MCP 与引用关联复用一份实现。`reference-matching.ts` 优先 DOI 精确身份；只有可确定完整书目字段的结构化引用才使用现有严格后备键，普通非结构化文本不做模糊猜测。

- `reference-matching.ts` / `archive-references.ts`：固定校订稿参考文献的保守库内匹配与原子关系支持；不依靠模糊题名猜测。`bibliography-import.ts` 是书目解码与导入的共享实现，Entry 不再持有重复副本。
