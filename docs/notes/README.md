# 注意事项

类型：导航
负责：注意事项
状态：现行

本目录保存需要持续维护的外部供应商、工具、许可和兼容性说明。它们帮助调用方理解外部依赖和排障，不重新定义产品架构、配置合同或已发布能力。

- [Provider 接入注意事项](providers/README.md)：各 Metadata/Acquisition Provider 的总览、认证要求、限流、外部能力、已知限制和厂商调研索引。
- [PDF 获取路径参考实现调研](pdf-acquisition-reference-paths.md)：两个本地下载项目与 Zotero 官方实现的公开来源、授权 API、浏览器路径、候选顺序和验证边界对比。
- [ScanSci PDF 迁移许可与证据审计](scansci-migration-audit.md)：固定 ScanSci revision 的 Apache-2.0 归属、逐文件 provenance 流程、可参考线索与永久禁止迁移边界。
- [CloakBrowser 接入注意事项](cloakbrowser.md)：wrapper/binary 的版本与许可、官方校验链、固定身份、运行时生命周期和升级门禁；依赖风险与可能更换（Owner 2026-11-25）。
- [DeepSeek Harness 组件与兼容性](deepseek-harness.md)：固定组件版本、required peer、许可、安装闭包及运行服务边界。
- [MinerU 接入注意事项](mineru.md)：外部 MinerU 服务的固定目标、所有权、安全、恢复和升级注意事项。
- [Node SQLite / FTS5 兼容性](sqlite-fts5-long-reader.md)：长期连接的已知问题、处理方式及适用版本。
- [Web 阅读渲染依赖与兼容性](web-reading-dependencies.md)：PDF.js、Markdown、数学排版的固定版本、许可、本地资源与 CSP 边界。
- [Web 前端框架依赖与兼容性](web-frontend-dependencies.md)：ADR 0036（Proposed）的 React、React Aria、Motion、TanStack、Vite 候选版本、许可、选版理由与 CSP/体积待实测项。
- [工具中立性声明](tool-neutrality.md)：项目对来源和工具的中立立场及工程安全边界。

Provider 名称、adapter、Profile 或外部协议存在，不等于它已经进入生产 registry、当前 route plan 或 readiness。当前入口和已组装能力以项目 README、配置手册、Bootstrap 生产对象图、源码与直接测试为准；fixture-verified 也不能写成 production-ready。

任何秘密值、私有 endpoint、Cookie、用户身份或受限正文都不得写入本目录。

## 文件身份与存放位置

- 长期维护的接口、版本、配置、已知限制和第三方许可说明放在本目录。
- 本机测试结果、故障对照和验收报告放在 `sandbox/reports/`；真实/一次性测试用例与人工步骤放在 `sandbox/cases/`。
- 原始日志、截图、模型响应、隔离测试数据库和语料放在 `sandbox/runs/`；整个 `sandbox/` 被 Git 忽略，不作为仓库文档提交。
- 可共享的离线回归放在各模块的 `test/`，合成 fixture 放在 `tests/fixtures/`；详细约定见[测试目录说明](../../tests/README.md)。

测试记录是阶段材料。能够长期复用的结论经核对后提炼为维护说明，不能把某次成功率、故障现场或执行日志继续堆入 Notes。

[上级目录](../README.md) · [项目 README](../../README.md)
