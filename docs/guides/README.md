# 用户指南

本目录只描述安装产物已经公开且经过验收的用户行为。当前公开入口是 `sciretriever` console script；主题/引用发现与数据库补全是两类独立操作，书目导入、手动 PDF、补全、查询和导出都作用于同一个 SQLite Catalog 与 ArtifactStore。

- [项目 README](../../README.md)：安装方式、固定命令树、最小本地旅程、发现与补全边界，以及生产 Bootstrap、离线外部 Port 注入和受控协议/安全 QA 三层验收证据。
- [SciRetriever 配置手册](configuration.md)：九组普通配置、配置文件选择、固定凭据文件、Provider readiness 和显式只读 probe。

用户指南只把安装后可观察、且已有对应验收证据的行为写成当前能力。外部 Port 的受控 fake 验收、loopback 协议 QA 或 Chromium 安全 QA 不等于生产环境已经对真实 Provider、Parser、LLM 或出版社开放；具体证据边界以项目 README 的“当前验收边界”为准。

普通配置与统一用户级凭据文件是两个分离边界；Provider、LLM 和远程 MinerU secret 都由后一边界管理。个人配置、凭据、运行时 Catalog、文献资产和用户语料都不属于仓库内容，也不能作为示例或测试数据提交。
