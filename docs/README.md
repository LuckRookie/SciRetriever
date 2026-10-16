# SciRetriever 文档导航

SciRetriever 面向科研 Agent 供应文献材料、知识压缩与通用提取交付，也提供人类配置、生产浏览器协作和阅读。查询已有数据库与主动扩充/加工是独立操作；缺口不自动启动搜索或下载。

## 按问题阅读

| 要了解什么         | 入口                                                                                                                      | 文档效力                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 当前怎样安装、使用 | [项目README](../README.md)、[用户指南](guides/README.md)                                                                  | 当前行为，以源码/测试及环境证据核对          |
| 当前版本怎样启用、恢复 | [安装与兼容矩阵](guides/installation.md)、[初始化/升级](guides/upgrade.md)、[切换与恢复](guides/cutover.md) | 当前 v8 operator 能力与待授权的真实切换步骤 |
| 产品要做什么       | [requirements](architecture/requirements.md)                                                                              | 已确认需求R1–R13                             |
| 已经决定什么       | [ADR索引](architecture/decisions/README.md)                                                                               | Accepted范围及修订链；不是所有新细节都已接受 |
| 模块怎样协作       | [design](architecture/design.md)、[工作流](architecture/knowledge-service-workflows.md)                                   | 目标责任与场景，具体提案单独标注             |
| 各模块如何实现     | [八模块技术导航](architecture/technical.md)、[TS 基线](architecture/typescript-baseline.md)                               | 8 篇详细模块正文与当前实现差距               |
| 具体合同建议       | [统一产品接口：共享合同、结构解析与版本兼容](architecture/technical/01-product-interface.md#6-共享合同结构解析与版本兼容) | Proposed，未冻结字段/协议不冒充已发布API     |
| 当前 Web 如何设计 | [Web 界面设计与定稿原型](architecture/web/README.md)、[ADR 0032](architecture/decisions/0032-library-centered-web-workspace.md) | 当前有效的布局、视觉与交互基准；不代表正式实现已完成 |
| 正在讨论的产品设计 | [活动提案](proposals/README.md) | 待讨论或评审的建议和未决问题；不作为实施台账 |
| 怎样从当前迁到目标 | [迁移映射](architecture/evolution-map.md)、[活动计划](plans/README.md)                                                    | 前者说明改造/兼容，后者组织执行与恢复        |
| 如何开发与验证     | [开发文档](development/README.md)、[文档影响映射](development/documentation-map.md)                                       | 工程入口与变更检查                           |
| 外部服务事实       | [notes](notes/README.md)                                                                                                  | 有日期的来源资料，不据此推断当前生产接入     |
| 测试材料放在哪里 | [测试目录与本地试验场](../tests/README.md) | 共享离线材料在 `tests/`；本机真实测试与报告在 Git 忽略的 `sandbox/` |
| 过去怎样讨论/实现  | [历史归档](archive/README.md)                                                                                             | 不作为当前目标/完成证明                      |

## 维护规则

产品目标、当前行为、设计提案和执行状态分别标明；每项事实由其owner文档维护，其余通过链接引用。技术文档保留完整技术正文，使用活动 TypeScript 路径，逐条区分当前实现、兼容规则与新目标设计；Python 专属实现留在历史快照。身份、来源、安全和兼容决定继续由 ADR 约束。

供应商notes不因架构整理被重新认证，真实配置、凭据、语料、catalog与资产不属于仓库文档。本轮不做历史坏链接的无界修复，不把旧计划Superseded写成Completed。

`notes/` 只维护外部依赖、许可和兼容性说明；本机测试记录归 `sandbox/reports/`，用例与运行材料分别归 `sandbox/cases/`、`sandbox/runs/`，不随仓库分发。共享合成测试材料继续放在 `tests/fixtures/`。

## 子目录导航

- [architecture/](architecture/README.md)：架构文档入口。
