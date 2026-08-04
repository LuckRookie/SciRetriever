# SciRetriever 文档

本目录只保留当前软件需要长期维护的教程、开发说明、整体架构、活动提案和外部依赖注意事项。OMO 执行计划只放在 `.omo/plans/`；完成或终止的提案、评估、进度台账和工作包记录进入 `archive/`，不作为当前行为或设计依据。

| 分类 | 适合谁 | 内容 |
|---|---|---|
| [当前用户文档](guides/README.md) | 在程序内使用 SciRetriever 的调用方 | Python 包入口、schema v2 配置和外部服务边界 |
| [开发手册](development/README.md) | 修改代码或接入 Provider 的开发者 | 协作入口、文档同步和 Provider 接入检查 |
| [整体架构](architecture/README.md) | 维护产品边界和模块设计的开发者 | 需求、设计文档、技术文档、原则和架构决策 |
| [注意事项](notes/README.md) | 配置外部依赖或排查供应商问题的使用者与开发者 | Provider、MinerU 和工具中立性事实 |
| [活动提案](proposals/README.md) | 讨论产品或架构变化的维护者 | 仍处于 draft 或 under-review 的提案 |
| [历史归档](archive/) | 需要审计历史决策过程的维护者 | 已完成或终止的提案、评估、进度和阶段证据 |

当前用户行为以项目 [`README`](../README.md)、[配置手册](guides/configuration.md)、公开 Composition/Service API、源码和直接测试为准。项目没有受支持的终端用户 CLI，也不维护可直接运行的公开配置模板。根目录 `config.toml` 是个人运行配置，不定义公开行为；归档内容也不授权新的实现。
