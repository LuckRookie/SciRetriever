# 可读文档与证据

将解析结果组织为固定版本的可读文档，提供正文、片段、资源和证据读取。

## 内容入口

- [builder.ts](builder.ts)：中性解析结果到文档表示的构建。
- [service.ts](service.ts)：文档发布服务。
- [read.ts](read.ts)：文档与证据读取。
- [storage.ts](storage.ts)：文档存储协作接口。

`read.ts` 的内部 `withReadScope` 供知识／结果读取在一次逻辑操作内复用已核验文档；最多保留 16 份、32 MiB 的正文与序列化结构计量，结束即清空，独立请求重新验证。带独立预算计量的检索不走此复用。发布流程不跨写入保留读取证明。`storage.ts` 对资源采用有界并发完整校验，等待全部文件 reader 关闭后才交付结果；文件路径、hash 和篡改拒绝不变。

## 放置边界

第三方 parser 协议留在 parsing/backends；通用文件/SQLite 实现留在 storage；知识解释留在 analysis。

相关说明：[所属技术文档](../../../../docs/architecture/technical/04-document-evidence.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
