# 配置与凭据

管理固定用户配置、凭据、校验、就绪状态和 Browser runtime 识别。

## 内容入口

- [index.ts](index.ts)：配置模型、解析与公开入口。
- [owner.ts](owner.ts)：配置读取、保存和诊断的所有者；Web 启动通过 `ensureStoragePaths` 仅补齐缺失路径并保存共享配置，默认数据位于用户 `~/.sciretriever/` 下。数据库初始化仍由 Storage 负责。
- [acquisition-selection.ts](acquisition-selection.ts)：只根据配置与字段存在性解析 PDF Auto/Custom 来源及生效/待生效路线差异；owner 的 `acquisitionRoutes` 按指定配置快照投影，供读取和保存响应使用，不调用独立的 `status` 就绪检查。
- [sources.ts](sources.ts)：15 家来源的能力/字段目录、来源级 CAS 保存与选择；只输出凭据存在性，跨文件失败明确返回部分发布。
- [source-probes.ts](source-probes.ts)：显式固定样本测试与串行队列，共用 Application Network；不产生文献或资产事实。
- [source-state.ts](source-state.ts)：非秘密测试缓存、发布身份和来源版本；读取不重写缓存。
- [apply.ts](apply.ts)：应用请求的安全状态、等待/取消与已绑定运行时检查；不执行 shell。
- [network.ts](network.ts)、[egress.ts](egress.ts)：按发起方验证显式出口、选中远程服务的 DNS，以及 origin 绑定的代理认证 capability。
- [credentials.ts](credentials.ts)：凭据边界与授权。
- [cloak-runtime.ts](cloak-runtime.ts)：Cloak runtime 身份与可用性。

## 放置边界

这里只保存管理配置的代码。个人 config.toml、credentials.toml、Cookie 和真实值不进入源码目录。

[上级目录](../README.md)
