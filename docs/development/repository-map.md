# 仓库目录地图

类型：开发
负责：仓库目录的职责与开发工作的起点
状态：现行

## 目录

每个由项目维护的目录都有自己的 `README.md`，说明职责、内容入口和相邻目录的分工。从下面进入，再沿各级 README 找到具体模块。目录说明帮助定位；需求、架构决定和当前行为分别由各自真相源维护。

| 目录                                                              | 负责的内容                                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [apps/](../../apps/README.md)                                     | 应用实现：核心服务、CLI/MCP/HTTP 与 Web 界面                                              |
| [apps/server/src/](../../apps/server/src/README.md)               | 按业务职责划分的服务端模块地图                                                            |
| [apps/web/](../../apps/web/README.md)                             | React 工作台、共享组件与动效、框架无关阅读引擎和界面回归                                  |
| [apps/browser-extension/](../../apps/browser-extension/README.md) | 在用户自己浏览器里收藏文献的 Chrome/Edge 扩展                                             |
| [skills/](../../skills/README.md)                                 | 文献库自带、给桌面 Agent 用的 skill                                                       |
| [packages/](../../packages/README.md)                             | 跨模块、跨应用共享的中性合同包                                                            |
| [docs/](../README.md)                                             | 需求、架构、使用指南、维护说明、提案与计划                                                |
| [tests/](../../tests/README.md)                                   | 随仓库分发的共享合成测试材料；正式回归在各模块的 `test/`                                  |
| `sandbox/`                                                        | 本机真实测试场地：`cases/` 用例、`runs/` 运行材料、`reports/` 报告；整个目录不随 Git 分发 |
| [scripts/](../../scripts/README.md)                               | 可复用的构建与打包工具                                                                    |
| [release/](../../release/README.md)                               | 构建工具使用的发布运行清单                                                                |
| [example/](../../example/README.md)                               | 可共享的配置示例                                                                          |
| [migration/](../../migration/README.md)                           | 迁移兼容清单、固定 oracle 与历史证据；部分清单仍由测试消费                                |
| [.github/](../../.github/workflows/README.md)                     | GitHub CI 工作流；本目录不放 README，否则 GitHub 会把它显示成仓库首页                     |

## 要做什么，去哪里

| 工作                                            | 起点                                                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 增加或修复一家文献供应商                        | [providers/](../../apps/server/src/providers/README.md)，定义与协议放在对应供应商目录                                                                                                       |
| 调整发现或批量 PDF 获取流程                     | [entry/](../../apps/server/src/entry/README.md)；元数据能力看 [metadata/](../../apps/server/src/metadata/README.md)，PDF 接纳看 [acquisition/](../../apps/server/src/acquisition/README.md) |
| 修改 Browser Agent 的观察、动作、等待或下载捕获 | [browser/](../../apps/server/src/browser/README.md)；共享网络与冷却看 [network/](../../apps/server/src/network/README.md)                                                                   |
| 修改解析、总结或知识查询                        | [parsing/](../../apps/server/src/parsing/README.md)、[analysis/](../../apps/server/src/analysis/README.md)、[retrieval/](../../apps/server/src/retrieval/README.md)                         |
| 修改统一数据格式、身份或存储                    | [contracts/](../../packages/contracts/README.md)、[literature/](../../apps/server/src/literature/README.md)、[storage/](../../apps/server/src/storage/README.md)                            |
| 做真实测试、保存日志和整理结果                  | 本机 `sandbox/`；约定见[测试目录说明](../../tests/README.md#本地真实测试)                                                                                                                   |
| 给 bug 补可重复回归                             | 对应应用或包的 `test/`；共享合成输入放 [tests/fixtures/](../../tests/fixtures/README.md)                                                                                                    |
| 讨论设计、执行计划或维护长期说明                | [proposals/](../proposals/README.md)、[plans/](../plans/README.md)、[notes/](../notes/README.md)；接受的长期决定归 [ADR](../architecture/decisions/README.md)                               |

根目录的 [AGENTS.md](../../AGENTS.md) 是项目约束入口，[HARNESS.md](../../HARNESS.md) 是工程与验收规则；[package.json](../../package.json) 定义开发命令，`pnpm-workspace.yaml` 与 `tsconfig*.json` 定义 workspace 和编译范围。

本机可能还保留 `archive/`（退役代码快照）、`work/`（早期工作材料）、`.agent-teams/`（工具状态）和 `.vscode/`（编辑器配置）；这些目录的说明只保存在本机。它们不作为新业务源码或新测试的落点。`.git/`、`node_modules/`、`build/`、`dist/`、缓存、原始运行数据及历史快照内部由工具或原始材料结构决定，不逐层插入 README；其身份在所属上级目录说明。

[上级目录](README.md) · [项目 README](../../README.md)
