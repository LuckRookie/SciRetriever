# M1｜TypeScript 基础、v1 兼容与运行时

## 结果

本文件保留首阶段本地运行证据，并承接原始 M1 的 T009–T018。在临时 home 中建立严格 TS workspace、运行时合同、Configuration/Credential、Network、FileStore、SQLite v1 repositories、Agents 和唯一 Application，为 M2–M4 提供不依赖双写的基础。

表中的 `02-01`–`02-08` 是本阶段的实现切片编号；它们不改变原始 T009–T018 的任务边界。任务状态、原始依赖和退出条件以[全量迁移路线](full-migration-roadmap.md#m1ts-基础与-v1-兼容)为准。

## 任务

| ID | 任务 | 交付物 | 验收 | 状态与证据 / 剩余工作 |
| --- | --- | --- | --- | --- |
| 02-01 | 配置 parser 与 projection | `configuration/` | 保持 TOML 现有字段和默认值；输出脱敏 readiness | 已实现；[配置解析记录](../../../migration/evidence/runtime/configuration-boundary.md)和[owner bridge](../../../migration/evidence/runtime/configuration-owner-bridge.md)覆盖 Python parser/defaults、typed projection、TUI/Web readiness 和 unknown-field 拒绝 |
| 02-02 | 配置原子发布 | publication 实现 | 临时文件、权限、no-follow、冲突检测和失败保留原文件 | 已实现首阶段边界；[原子发布记录](../../../migration/evidence/runtime/configuration-publication.md)与 owner bridge 覆盖临时文件、权限、冲突、保留原文件、编辑往返和重读 |
| 02-03 | 凭据 owner | credential port | secret 不进入日志/DTO；按 provider/origin 读取；TUI 与 Browser 不各自保存一份 | 已实现；[凭据边界记录](../../../migration/evidence/runtime/credential-origin.md)和[owner bridge](../../../migration/evidence/runtime/configuration-owner-bridge.md)覆盖 provider/origin、set/keep/remove、TUI/Browser shared projection 和 secret 不泄漏 |
| 02-04 | 最小 Network admission | `network/` | URL、DNS/IP、redirect、body limit、取消和并发预算覆盖目标旅程 | 已实现；[admission](../../../migration/evidence/runtime/network-admission.md)、[redirect](../../../migration/evidence/runtime/network-redirect-credentials.md)、[取消记录](../../../migration/evidence/runtime/network-cancellation.md)、[配置驱动模型 loopback](../../../migration/evidence/runtime/model-loopback.md)及[实际 MinerU/Browser 联合旅程](../../../migration/evidence/runtime/browser-mineru-analysis-journey.md)通过；真实 Provider 仍不在授权范围 |
| 02-05 | FileStore | `storage/files/` | 有界 stage、hash、create-if-absent、冲突拒绝和相对引用 | 已实现；[FileStore 记录](../../../migration/evidence/runtime/immutable-file-store.md)、[Candidate 重启读取/对账](../../../migration/evidence/runtime/candidate-recovery.md)，包括目录 no-follow 与完整性拒绝；最终旅程随阶段 03 验证 |
| 02-06 | 最小 SQLite worker/repository | `storage/sqlite/` | v1 文献事实兼容；Candidate/receipt 使用显式 execution schema，在合成副本完成升级、备份、恢复、回滚和重启对账；不存大型 BLOB | 已实现；[v1 SQLite 记录](../../../migration/evidence/runtime/sqlite-compatibility.md)、[显式 execution schema 与恢复](../../../migration/evidence/runtime/candidate-recovery.md)，合成备份/回滚及独立 Node 进程对账通过 |
| 02-07 | Application 生命周期 | `bootstrap/application.ts` | 临时 home 启动/关闭幂等，错误可见，只有一个 DB/FileStore/Network owner | 已实现；[对象图记录](../../../migration/evidence/runtime/application-assembly.md)、[生命周期记录](../../../migration/evidence/runtime/application-lifecycle.md)和[Browser lifecycle 矩阵](../../../migration/evidence/browser-acquisition/browser-lifecycle-matrix.md)覆盖反向关闭与 page close |
| 02-08 | 后端 API | session/config/status/query 的 typed command | Web、TUI 共用 command/result，不直接读数据库表 | 已实现首阶段消费者边界；工作台通过鉴权 API 消费 session、脱敏配置 status、Library query、引用和 artifact，TUI/CLI 通过 typed owner/probe bridge 消费配置命令；两者都不直接读表，Web 配置编辑不在首阶段界面范围 |

## 依赖

阶段 01 的合同。02-01/02-03 可并行；02-06 依赖 FileStore 和合同；02-08 在实际消费者出现后实现。

## 退出门

临时 home 可启动和关闭；配置保存、路径攻击、取消、超限写入、Candidate 重启读取和 receipt 幂等测试通过；`pnpm quick` 与 TS 配置兼容测试通过；复用 synthetic 配置 fixture，不再运行 Python 全量回归。

## Candidate/receipt 持久化边界

遵守 [ADR 0024 第 4 节](../../architecture/decisions/0024-typescript-browser-workbench-migration.md#4-v2-运行事实与-v1-文献事实隔离)：首阶段需要的是最小 Candidate/receipt 运行事实，并非后台队列。02-06 明确承担这部分 execution schema 工作；表定义、版本标识与迁移映射在实施时写入对应技术文档，不向冻结的 v1 schema 静默加表，也不另建业务文献库。

Acquisition 拥有 Candidate 生命周期和发布决定，Literature 拥有身份/current facts，Storage 只执行确认命令。大字节在 FileStore，运行记录保留相对引用、hash、归属证据和发布回执。新进程须能读回 Candidate，并对账“文件已发布、数据库未提交”和“数据库已提交、回执未返回”；不得把进程内 Map 或页面关闭后的存活当作重启恢复证据。

实现和迁移演练只在临时 home 的合成副本进行；回滚须保留已确认事实和对账证据。生产 schema 升级、用户数据迁移与切换不在本轮授权内。

## M1 边界

持久 jobs/attempts/events、队列和 daemon 按原始 M5 实施，不是 M1 退出条件。TypeScript 配置 owner 已接管生产路径；Python 配置 bridge 按 T061 记录为历史材料，不进入 Application 或安装包。MinerU/Parsing 和 Analysis 已分别在 T041、T042 移除生产 bridge。配置锁、Profile 独占和 Candidate/receipt 恢复继续保留。

## 原始 M1 结论

状态以[全量路线 T009–T018](full-migration-roadmap.md#m1ts-基础与-v1-兼容)为准。T009–T018 的当前支持边界均已由
TypeScript 源码、合成 fixture、直接测试和 Application 组装证据闭合；真实 Provider/LLM、非 Linux 平台和用户
数据仍不在授权范围。后续 M2/T019–T028 只处理 Browser 运行时自身的支持矩阵，不再依赖 Python owner。
