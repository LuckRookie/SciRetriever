# 配置与凭据

管理固定用户配置、凭据、校验、就绪状态和 Browser runtime 识别。

## 内容入口

- [index.ts](index.ts)：配置模型、解析与公开入口。
- [owner.ts](owner.ts)：配置读取、保存和诊断的所有者；Web 启动通过 `ensureStoragePaths` 仅补齐缺失路径并保存共享配置，默认数据位于用户 `~/.sciretriever/` 下。数据库初始化仍由 Storage 负责。
- [credentials.ts](credentials.ts)：凭据边界与授权。
- [cloak-runtime.ts](cloak-runtime.ts)：Cloak runtime 身份与可用性。

## 放置边界

这里只保存管理配置的代码。个人 config.toml、credentials.toml、Cookie 和真实值不进入源码目录。

[上级目录](../README.md)
