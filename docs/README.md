# SciRetriever 文档

本目录只保留当前软件需要长期维护的教程、开发说明、整体架构、活动提案和外部依赖注意事项。OMO 执行计划只放在 `.omo/plans/`；完成或终止的提案、评估、进度台账和工作包记录进入 `archive/`，不作为当前行为或设计依据。

| 分类 | 适合谁 | 内容 |
|---|---|---|
| [用户教程](guides/README.md) | 使用 SciRetriever 的研究者 | 安装、配置、检索、下载、分析、导出和排障 |
| [开发手册](development/README.md) | 修改代码或接入 Provider 的开发者 | 协作入口、文档同步和 Provider 接入检查 |
| [整体架构](architecture/README.md) | 维护产品边界和模块设计的开发者 | 需求、系统设计、技术架构、原则和架构决策 |
| [注意事项](notes/README.md) | 配置外部依赖或排查供应商问题的使用者与开发者 | Provider、MinerU 和工具中立性事实 |
| [活动提案](proposals/README.md) | 讨论产品或架构变化的维护者 | 仍处于 draft 或 under-review 的提案 |
| [历史归档](archive/) | 需要审计历史决策过程的维护者 | 已完成或终止的提案、评估、进度和阶段证据 |

当前用户行为以项目 [`README`](../README.md)、CLI `--help` 和 [`config.example.toml`](../config.example.toml) 为准。归档内容不定义当前行为，也不授权新的实现。
