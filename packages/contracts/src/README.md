# 共享合同源码

定义跨模块传递的身份、文档、知识、提取、操作与检索结构及其边界解析。

## 内容入口

- [index.ts](index.ts)：包公开导出与基础合同。
- [document.ts](document.ts)：文档合同。
- [knowledge.ts](knowledge.ts)：知识产物合同。
- [synthesis.ts](synthesis.ts)：综合产物合同。
- [operations.ts](operations.ts)：操作合同。
- [extraction.ts](extraction.ts)：提取合同。
- [retrieval-context.ts](retrieval-context.ts)：材料检索上下文合同。

## 放置边界

修改字段需要同步生产者、消费者、序列化和持久化兼容；不要把厂商原始响应或机器绝对路径放进中性合同。

[上级目录](../README.md) · [项目 README](../../../README.md)
