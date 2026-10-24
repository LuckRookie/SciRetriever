# SciRetriever

类型：指南
负责：产品入口、启动步骤与项目导航
状态：现行

SciRetriever 为科研 Agent 和个人研究者提供文献元数据、原始 PDF、校订全文、证据与通用知识加工。Web、CLI 和 MCP 共用一套文献库；查询已有材料与显式获取、解析、建档、加工分别执行。

当前实现包括元数据发现与导入、PDF 获取、MinerU 原始解析、DSH 校订与总结、元数据人工锁定、标签、快照和多篇综合。领域提取记录由调用方定义，平台保留来源与证据，不替代下游科学判断。能力和限制见[用户指南](docs/guides/README.md)；产品目标与验收见[产品需求](docs/architecture/requirements.md)。

## 安装与启动

源码工作区使用锁定的 Node/pnpm 版本：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm sciretriever web --port 4174
```

启动后按终端给出的地址和登录提示访问。安装条件、便携包与首次建库见[安装指南](docs/guides/installation.md)；远程访问、登录和页面操作见[Web 指南](docs/guides/web-workbench.md)。配置路径、字段与默认值统一见[配置手册](docs/guides/configuration.md)。已有库结构不匹配时，先按[初始化与恢复](docs/guides/upgrade.md)处理，普通启动不自动转换旧库。

## 按工作查指南

| 工作                                 | 操作说明                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| 配置来源、解析和模型                 | [配置手册](docs/guides/configuration.md)                                     |
| 获取或导入 PDF                       | [PDF 获取](docs/guides/pdf-acquisition.md)                                   |
| 解析、校订、结构与证据               | [文档处理](docs/guides/document-processing.md)                               |
| 建档、状态、元数据校正               | [文献建档](docs/guides/literature-archive.md)                                |
| 词表、标签与回溯                     | [标签](docs/guides/tags.md)                                                  |
| 总结、问答标注、记录提取、综合和导出 | [知识加工](docs/guides/knowledge-processors.md)                              |
| 读取已有材料与有界检索               | [独立文献库阅读](docs/guides/library-query.md)                               |
| 从 Agent、CLI 或 MCP 调用            | [Agent 接口](docs/guides/agent-interface.md)                                 |
| 初始化、检查和切换库                 | [初始化与恢复](docs/guides/upgrade.md)、[数据库切换](docs/guides/cutover.md) |

## 项目目录地图

每个由项目维护的目录都有自己的 `README.md`，说明职责、内容入口和相邻目录的分工。从下面进入，再沿各级 README 找到具体模块。目录说明帮助定位；需求、架构决定和当前行为分别由各自真相源维护。

| 目录                                          | 负责的内容                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [apps/](apps/README.md)                       | 应用实现：核心服务、CLI/MCP/HTTP 与 Web 界面                                              |
| [apps/server/src/](apps/server/src/README.md) | 按业务职责划分的服务端模块地图                                                            |
| [apps/web/](apps/web/README.md)               | React 工作台、共享组件与动效、框架无关阅读引擎和界面回归                                  |
| [packages/](packages/README.md)               | 跨模块、跨应用共享的中性合同包                                                            |
| [docs/](docs/README.md)                       | 需求、架构、使用指南、维护说明、提案与计划                                                |
| [tests/](tests/README.md)                     | 随仓库分发的共享合成测试材料；正式回归在各模块的 `test/`                                  |
| `sandbox/`                                    | 本机真实测试场地：`cases/` 用例、`runs/` 运行材料、`reports/` 报告；整个目录不随 Git 分发 |
| [scripts/](scripts/README.md)                 | 可复用的构建与打包工具                                                                    |
| [release/](release/README.md)                 | 构建工具使用的发布运行清单                                                                |
| [example/](example/README.md)                 | 可共享的配置示例                                                                          |
| [migration/](migration/README.md)             | 迁移兼容清单、固定 oracle 与历史证据；部分清单仍由测试消费                                |
| [.github/](.github/README.md)                 | GitHub CI 工作流                                                                          |

### 要做什么，去哪里

| 工作                                            | 起点                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 增加或修复一家文献供应商                        | [providers/](apps/server/src/providers/README.md)，定义与协议放在对应供应商目录                                                                                           |
| 调整发现或批量 PDF 获取流程                     | [entry/](apps/server/src/entry/README.md)；元数据能力看 [metadata/](apps/server/src/metadata/README.md)，PDF 接纳看 [acquisition/](apps/server/src/acquisition/README.md) |
| 修改 Browser Agent 的观察、动作、等待或下载捕获 | [browser/](apps/server/src/browser/README.md)；共享网络与冷却看 [network/](apps/server/src/network/README.md)                                                             |
| 修改解析、总结或知识查询                        | [parsing/](apps/server/src/parsing/README.md)、[analysis/](apps/server/src/analysis/README.md)、[retrieval/](apps/server/src/retrieval/README.md)                         |
| 修改统一数据格式、身份或存储                    | [contracts/](packages/contracts/README.md)、[literature/](apps/server/src/literature/README.md)、[storage/](apps/server/src/storage/README.md)                            |
| 做真实测试、保存日志和整理结果                  | 本机 `sandbox/`；约定见[测试目录说明](tests/README.md#本地真实测试)                                                                                                       |
| 给 bug 补可重复回归                             | 对应应用或包的 `test/`；共享合成输入放 [tests/fixtures/](tests/fixtures/README.md)                                                                                        |
| 讨论设计、执行计划或维护长期说明                | [proposals/](docs/proposals/README.md)、[plans/](docs/plans/README.md)、[notes/](docs/notes/README.md)；接受的长期决定归 [ADR](docs/architecture/decisions/README.md)     |

根目录的 [AGENTS.md](AGENTS.md) 是项目约束入口，[HARNESS.md](HARNESS.md) 是工程与验收规则；[package.json](package.json) 定义开发命令，`pnpm-workspace.yaml` 与 `tsconfig*.json` 定义 workspace 和编译范围。

本机可能还保留 `archive/`（退役代码快照）、`work/`（早期工作材料）、`.agent-teams/`（工具状态）和 `.vscode/`（编辑器配置）；这些目录的说明只保存在本机。它们不作为新业务源码或新测试的落点。`.git/`、`node_modules/`、`build/`、`dist/`、缓存、原始运行数据及历史快照内部由工具或原始材料结构决定，不逐层插入 README；其身份在所属上级目录说明。

## 开发与贡献

开发、构建、预览和打包命令见[TypeScript 开发入口](docs/development/typescript-foundation.md)。测试选择、并发与 Full 规则见 [HARNESS](HARNESS.md#54-typescript-开发验证)；不把历史测试结果当作当前版本的通过声明。

长期设计从[架构导航](docs/architecture/README.md)进入，文档类型和主题归属见[文档导航](docs/README.md)，实施进度见[活动计划](docs/plans/README.md)。本页不维护第二份命令树、配置默认值或验收流水账。
