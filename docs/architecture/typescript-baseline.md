# TypeScript 架构锚定基线

类型：规格
负责：当前 TypeScript 代码目录映射
状态：现行

本页只维护活动源码与技术责任的映射。产品目标见[需求](requirements.md)，模块责任见[设计](design.md)，运行操作见[指南](../guides/README.md)，开发与验证见[开发入口](../development/typescript-foundation.md)及 [HARNESS](../../HARNESS.md)。

## 当前模块地图

| 活动源码                                                 | 责任与技术说明                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/contracts/`                                    | 中性合同与解析；[产品接口 §6](technical/01-product-interface.md#6-共享合同结构解析与版本兼容) |
| `apps/server/src/entry/`、`application/`、`bootstrap/`   | 操作边界、持久任务、生命周期与生产组装；[任务协调](technical/02-task-coordination.md)         |
| `metadata/`、`literature/`、`providers/`、`acquisition/` | 来源、身份和材料；[文献与材料](technical/03-literature-materials.md)                          |
| `parsing/`、`proofread/`、`document/`、`archive/`        | 原始解析、校订、文档与建档；[文档与证据](technical/04-document-evidence.md)                   |
| `analysis/`、`extraction/`、`tags/`、`agents/`           | 算子、外部候选、词表与 DSH 执行；[知识加工](technical/05-knowledge-processing.md)             |
| `retrieval/`                                             | 索引与有界上下文；[查询](technical/06-retrieval-context.md)                                   |
| `storage/`                                               | 目录、不可变文件和读写准入；[存储](technical/07-versioned-storage.md)                         |
| `browser/`                                               | 生产会话、页面与控制；[浏览器](technical/08-browser-control.md)                               |
| `configuration/`、`network/`、`logging/`                 | 配置、受控访问、安全日志；对应技术篇的共享支撑节                                              |
| `cli/`、`mcp/`、`workbench/`、`apps/web/src/`            | CLI/MCP/HTTP 与 React 适配；[产品接口](technical/01-product-interface.md)                     |

除完整路径外，服务端目录均位于 `apps/server/src/`。实现入口沿[服务端源码导航](../../apps/server/src/README.md)和[Web 导航](../../apps/web/README.md)查找；目录存在不表示某项能力通过了真实服务验收。

## 支持与变更边界

生产使用 TypeScript/Node，不启用 Python 桥接或双写。配置、安装及 catalog 支持范围分别见[配置手册](../guides/configuration.md)、[安装指南](../guides/installation.md)、[初始化与恢复](../guides/upgrade.md)。文档类型与目标/现状的区分遵循[文档导航](../README.md)；本页不保存版本流水账或测试数量。
