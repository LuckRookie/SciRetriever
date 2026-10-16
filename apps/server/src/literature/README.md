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

相关说明：[所属技术文档](../../../../docs/architecture/technical/03-literature-materials.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
