# 注意事项

本目录保存外部供应商和工具随时间变化、但又需要集中维护的事实。它们帮助调用方理解外部依赖和排障，不重新定义产品架构、配置合同或已发布能力。

- [Provider 接入注意事项](providers.md)：各 metadata/asset Provider 的认证要求、限流、外部能力、已知限制和检查重点。
- [MinerU 接入注意事项](mineru.md)：外部 MinerU 服务的固定目标、所有权、安全、恢复和升级注意事项。
- [工具中立性声明](tool-neutrality.md)：项目对来源和工具的中立立场及工程安全边界。

Provider 名称、adapter 或外部协议存在，不等于 Composition 已把它连接到可运行的 Service。当前入口以项目 README、配置手册、Composition wiring 和直接测试为准。

任何秘密值、私有 endpoint、Cookie、用户身份或受限正文都不得写入本目录。
