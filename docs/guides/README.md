# 用户指南

类型：导航
负责：业务指南操作与技术接口合同（使用步骤导航）
状态：现行

产品目标已扩展为科研 Agent 知识供给和正式人类协作，见[需求](../architecture/requirements.md)与[ADR 0026](../architecture/decisions/0026-agent-knowledge-and-human-collaboration.md)。当前已接通固定文档证据、分层知识、集合综合、材料/知识 Context、外部候选交付和同一生产 Browser 的观看/指导/接管；本目录说明这些可用入口及其实际验证边界。正式 MCP adapter、真实服务/站点与科学质量验收等剩余目标不能写成已发布或生产就绪。

本目录优先描述当前公开行为，并在能力尚未接线时明确标记“合同目标·未实现”。当前公开入口是 `sciretriever` console script；主题/引用发现与数据库补全是两类独立操作，书目导入、手动 PDF、补全、查询和导出都作用于同一个 SQLite Catalog 与 ArtifactStore。目标/现状总表见 [TypeScript 架构锚定基线](../architecture/typescript-baseline.md)。

- [项目 README](../../README.md)：安装方式、固定命令树、最小本地旅程，以及当前实现与目标合同的证据边界。
- [TypeScript 安装与兼容矩阵](installation.md)：Linux x64 portable 支持、Catalog v1–v8 reader 和实际安装验收边界。
- [Catalog 初始化、升级与恢复](upgrade.md)：精确目标的正式 v8 init/upgrade、只读检查、原始备份与中间版本失败语义。
- [切换与恢复](cutover.md)：待授权目标、停 writer/Jobs/Browser、Catalog 与资产备份、独立恢复及增量保留。
- [独立文献库阅读](library-query.md)：通过 QueryApplication 启动只读 Web 阅读入口，了解 readiness、缺口反馈、默认 home 与关闭方式。
- [Web 文献库工作空间](web-workbench.md)：以文献库为首页的、阅读标签、发现与加工、任务与 Browser、配置和固定数据库绑定。
- [浏览器扩展：网页收藏](browser-extension.md)：在 Chrome、Edge 里把正在看的文献连同 PDF 收进文献库。
- [SciRetriever 配置手册](configuration.md)：普通配置、固定凭据文件、Provider readiness 和显式只读 probe 目标；真实 `config test` 的当前缺口已标注。
- [PDF 获取指南](pdf-acquisition.md)：目标 Public → Authorized API → Browser-last 执行顺序、Browser 安全边界、Provider 分组限速、逐文章权限检查、失败分类和重跑；生产 Browser route 的当前接线状态已标注。
- [解析与发布文档版本](document-processing.md)：对固定已接纳主 PDF 显式复用或重解析，发布不可变 DocumentVersion，再按固定版本有界阅读和复核证据。

用户指南只把安装后可观察、且已有对应验收证据的行为写成当前能力。外部 Port 的受控 fake 验收、loopback 协议 QA 或 Chromium 安全 QA 不等于生产环境已经对真实 Provider、Parser、LLM 或出版社开放；具体证据边界以项目 README 的“当前验收边界”为准。

普通配置与统一用户级凭据文件是两个分离边界；Provider、LLM 和远程 MinerU secret 都由后一边界管理。个人配置、凭据、运行时 Catalog、文献资产和用户语料都不属于仓库内容，也不能作为示例或测试数据提交。

[上级目录](../README.md) · [项目 README](../../README.md)

- [统一知识加工](knowledge-processors.md)：处理器规范、批量复用、内容查询、证据、组合和导出。

- [标签词表与文献打标](tags.md)：浏览、两步打标、人工锁定、可逆整理和回溯。

- [文献建档](literature-archive.md)：独立建档任务、六种状态、失败恢复、版本事件与统计。
