# PDF 解析

把已接纳 PDF 交给外部 parser，转换并发布中性的解析结果。

## 下级目录

| 目录 | 职责 |
| --- | --- |
| [backends/](backends/README.md) | 外部解析后端适配 |

## 内容入口

- [ports.ts](ports.ts)：解析服务端口。
- [service.ts](service.ts)：解析执行。
- [publication.ts](publication.ts)：解析结果发布。
- [artifact-rules.ts](artifact-rules.ts)：解析产物规范化与检查。
- [article-identity.ts](article-identity.ts)：解析后文章身份检查协作。

## 放置边界

MinerU 等外部服务协议集中在 backends；文档片段与证据读取归 document；后续总结归 analysis。

相关说明：[所属技术文档](../../../../docs/architecture/technical/04-document-evidence.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
