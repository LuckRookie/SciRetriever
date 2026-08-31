# SciRetriever 文档

本目录只保留当前软件需要长期维护的教程、开发说明、整体架构、活动提案、活动实施计划和外部依赖注意事项。需要跨阶段恢复的执行计划放在 `plans/`；完成或终止的提案、评估、进度台账和工作包记录进入 `archive/`，不作为当前行为或设计依据。

| 分类 | 适合谁 | 内容 |
|---|---|---|
| [当前用户文档](guides/README.md) | 使用安装后 `sciretriever` 命令或嵌入公开模块边界的调用方 | CLI、严格配置、PDF 获取和外部服务边界 |
| [开发手册](development/README.md) | 修改代码或接入 Provider 的开发者 | 协作入口、文档同步和 Provider 接入检查 |
| [整体架构](architecture/README.md) | 维护产品边界和模块设计的开发者 | 需求、设计文档、技术文档、原则和架构决策 |
| [注意事项](notes/README.md) | 配置外部依赖或排查供应商问题的使用者与开发者 | Provider、MinerU 和工具中立性事实 |
| [活动提案](proposals/README.md) | 讨论产品或架构变化的维护者 | 仍处于 draft 或 under-review 的提案 |
| [历史归档](archive/) | 需要审计历史决策过程的维护者 | 已完成或终止的提案、评估、进度和阶段证据 |

当前用户行为以项目 [`README`](../README.md)、[用户指南](guides/README.md)、安装后的
`sciretriever` console script、Bootstrap 生产对象图、源码和直接测试为准。根目录
[`example/config.example.toml`](../example/config.example.toml) 是不含 secret、需要复制并填写真实路径的公开普通配置示例；
个人配置、凭据、数据库和文献资产不属于仓库内容。归档内容不授权新的实现。
