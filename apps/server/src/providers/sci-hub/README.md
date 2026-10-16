# Configured Sci-Hub 适配器

本目录集中维护 用户配置镜像的页面与 PDF locator 解析，让同一供应商的定义与协议实现可以就近查找。

## 内容入口

- [acquisition.ts](acquisition.ts)：该来源的 PDF/locator 获取适配。
- [definition.ts](definition.ts)：服务 URL、静态能力、认证声明、访问政策及适用范围。
- [locators.ts](locators.ts)：该来源标识符和 PDF 地址规则。

## 放置边界

只声明并实现实际支持的能力；元数据返回 PDF 线索不等于有独立 PDF API。共享限流/网络由 network 执行，身份与入库由业务模块处理；真实凭据不写入这里。

相关说明：[供应商治理与接线](../../../../../docs/development/provider-governance.md)；[外部接口与兼容说明](../../../../../docs/notes/providers/configured-sci-hub.md)。

[上级目录](../README.md) · [项目 README](../../../../../README.md)
