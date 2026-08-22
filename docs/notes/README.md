# 注意事项

本目录保存外部供应商和工具随时间变化、但又需要集中维护的事实。它们帮助调用方理解外部依赖和排障，不重新定义产品架构、配置合同或已发布能力。

- [Provider 接入注意事项](providers/README.md)：各 Metadata/Acquisition Provider 的总览、认证要求、限流、外部能力、已知限制和厂商调研索引。
- [PDF 获取路径参考实现调研](pdf-acquisition-reference-paths.md)：两个本地下载项目与 Zotero 官方实现的公开来源、授权 API、浏览器路径、候选顺序和验证边界对比。
- [ScanSci PDF 迁移许可与证据审计](scansci-migration-audit.md)：固定 ScanSci revision 的 Apache-2.0 归属、逐文件 provenance 流程、可参考线索与永久禁止迁移边界。
- [CloakBrowser 接入注意事项](cloakbrowser.md)：wrapper/binary 的版本与许可、官方校验链、固定身份、运行时生命周期和升级门禁。
- [MinerU 接入注意事项](mineru.md)：外部 MinerU 服务的固定目标、所有权、安全、恢复和升级注意事项。
- [工具中立性声明](tool-neutrality.md)：项目对来源和工具的中立立场及工程安全边界。

Provider 名称、adapter、Profile 或外部协议存在，不等于它已经进入生产 registry、当前 route plan 或 readiness。当前入口和已组装能力以项目 README、配置手册、Bootstrap 生产对象图、源码与直接测试为准；fixture-verified 也不能写成 production-ready。

任何秘密值、私有 endpoint、Cookie、用户身份或受限正文都不得写入本目录。
