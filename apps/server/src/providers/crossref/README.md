# Crossref 适配器

本目录集中维护 元数据搜索/查询和来源记录转换，让同一供应商的定义与协议实现可以就近查找。

## 内容入口

- [definition.ts](definition.ts)：服务 URL、静态能力、认证声明、访问政策及适用范围。
- [metadata.ts](metadata.ts)：供应商元数据协议到中性 observation 的转换。
- [record.ts](record.ts)：来源记录字段转换。

## 放置边界

只声明并实现实际支持的能力；元数据返回 PDF 线索不等于有独立 PDF API。共享限流/网络由 network 执行，身份与入库由业务模块处理；真实凭据不写入这里。

[上级目录](../README.md)
