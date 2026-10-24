# 代码与文档同步映射

类型：开发
负责：代码变更要同步哪些文档
状态：现行

本页只用于代码改动的文档影响分析。主题归属、文档类型和维护规则统一见[文档导航](../README.md)，验证方法见 [HARNESS](../../HARNESS.md)。映射不要求每次内部重构修改所有文档，也不表示表内目标已全部实现。

## 服务端与合同

| 代码                                                               | 需核对的文档                                                       | 触发变更                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------ |
| `packages/contracts/`                                              | [对应技术篇](../architecture/technical/01-product-interface.md)    | 输入输出、序列化、错误及各消费者合同       |
| `apps/server/src/entry/、application/、bootstrap/`                 | [对应技术篇](../architecture/technical/02-task-coordination.md)    | 操作范围、组装、任务与取消恢复             |
| `apps/server/src/configuration/`                                   | [对应技术篇](../architecture/technical/01-product-interface.md)    | 配置发布、安全边界；用户字段另同步配置手册 |
| `apps/server/src/metadata/、literature/、acquisition/、providers/` | [对应技术篇](../architecture/technical/03-literature-materials.md) | 来源、身份、元数据、引用、材料接纳         |
| `apps/server/src/parsing/、proofread/、document/、archive/`        | [对应技术篇](../architecture/technical/04-document-evidence.md)    | RawParse、校订、结构与证据、建档           |
| `apps/server/src/analysis/、extraction/、tags/、agents/`           | [对应技术篇](../architecture/technical/05-knowledge-processing.md) | 固定算子输入、结果、提取规范、词表和DSH    |
| `apps/server/src/retrieval/`                                       | [对应技术篇](../architecture/technical/06-retrieval-context.md)    | 只读上下文、索引一致性和覆盖               |
| `apps/server/src/storage/`                                         | [对应技术篇](../architecture/technical/07-versioned-storage.md)    | schema、文件、发布、恢复和依赖             |
| `apps/server/src/browser/`                                         | [对应技术篇](../architecture/technical/08-browser-control.md)      | 会话、控制权、下载和资源边界               |
| `apps/server/src/network/、logging/`                               | [对应技术篇](../architecture/technical/02-task-coordination.md)    | 网络准入和安全日志共享支撑                 |

## 入口、运维与前端

| 代码                                         | 需核对的文档                                                                                                                                     | 触发变更                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `apps/server/src/cli/`、`mcp/`、`workbench/` | [产品接口](../architecture/technical/01-product-interface.md)、[Agent 指南](../guides/agent-interface.md)及具体能力指南                          | 新操作、请求、响应、授权、字节预算与生命周期               |
| `apps/web/src/`                              | [Web 设计](../architecture/web/README.md)、[Web 指南](../guides/web-workbench.md)、[产品接口](../architecture/technical/01-product-interface.md) | 页面行为、阅读服务和共享接口；布局/视觉只在其归属文档维护  |
| Provider definitions/adapters                | [名称与责任](provider-governance.md)、[接入步骤](provider-integration.md)、[供应商事实](../notes/providers/README.md)                            | 名称、能力、访问政策、协议与外部证据                       |
| `configuration/` 的用户字段                  | [配置手册](../guides/configuration.md)                                                                                                           | 默认值、合法值、配置生效与凭据入口                         |
| `scripts/`、workspace 与 package manifests   | [开发入口](typescript-foundation.md)、[安装](../guides/installation.md)                                                                          | 构建、依赖、包内容、支持环境                               |
| `storage/sqlite/schema.ts` 与离线转换工具    | [存储](../architecture/technical/07-versioned-storage.md)、[初始化与恢复](../guides/upgrade.md)、[切换](../guides/cutover.md)                    | 受支持结构、数据保留与恢复流程                             |
| Harness / CI / 测试命令                      | [HARNESS](../../HARNESS.md)                                                                                                                      | 验证范围、并发、真实服务边界；普通回归不复制测试数量到规格 |

公开行为变化同时检查生产者、消费者、持久化和相关指南；仅目录或入口调整时维护该模块源码 README。源码 README 自包含，具体规则见[文档导航](../README.md)。
