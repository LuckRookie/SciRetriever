# SciRetriever 全量 TypeScript 迁移与 Browser 工作台计划

> 计划基线是 [`original-bundle`](../../archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/)；
> 其中 `00-README.md`、`01`–`11`、`tasks.json`、`sources.json` 和 `validation-report.json` 共同定义原始范围、设计、依赖、验收、来源和文档包自检结果。
> 当前文档只结合已接受架构、现有实现和“全量迁移为 TypeScript”的目标更新实施方式与状态，不以此前裁剪版反向缩小原始范围。

## 当前目标

依据原始 `2026-09-07-typescript-browser-workbench` 计划，完成 SciRetriever 活动 Python 能力到 TypeScript 的全量迁移，并保持一个可运行的本地单用户文献工作台。最终用户可以配置模型和来源，进行主题/引用发现、导入、PDF 获取、身份与版本确认、Literature/Asset 发布、解析、分析、查询和导出；需要时通过 Browser 观看、接管和处理候选。

最终发布包由 TypeScript/Node 运行，不依赖 Python 解释器，也不通过 Python RPC 执行数据库、Agent 或业务流程。Python 只保留为历史维护材料和离线 oracle；TypeScript 是当前配置、凭据、Catalog、ArtifactStore、Browser、Parser、Analysis 与任务的唯一生产 owner。

历史过程材料中的迁移期约束曾写作“Python 保持生产入口”；当前切换后该入口仅作为可追溯的历史维护材料保留，TS 不写用户生产配置、catalog、资产或 Profile。所有默认验证只使用临时 home、合成数据和 loopback；计划完成不构成生产切换授权。

## 与原始计划对齐

| 原始包基线 | 当前计划落点 |
| --- | --- |
| 7 个阶段 M0–M6 | README 阶段地图、`01`–`06` 阶段说明和全量路线 |
| 64 个固定任务 T001–T064 | [全量迁移路线](full-migration-roadmap.md)；标题、依赖和验收 ID 与 `tasks.json` 一致 |
| 54 个验收案例、41 个来源 | 原始验收 ID 保留在路线和阶段退出门；来源与证据边界保留在 `migration/evidence/` 和对应文档 |
| 原始计划包的文档/链接/依赖自检 | `validation-report.json` 仅作为原始包自检记录，当前文档修改另按本仓库 `HARNESS.md` 检查 |

## 当前状态

首阶段 Browser 工作台闭环已经完成，且已扩展到持久任务和单端口任务工作台：配置 owner → Browser Host → Observation/封闭动作 → PDF Candidate → identity/version verdict → Literature/Asset → Library/Jobs 查询的 loopback 证据已保留。复杂 blob/viewer/popup/Range 仍按支持矩阵显式 Deferred，真实站点和生产切换仍需授权。

当前全量状态如下：

- M0 基线、依赖、安全和性能观察项已有可重放证据；T008 的统一基线审查记录在 `implementation-baseline.md`；
- M1 的 TS workspace、合同、Network、FileStore、SQLite、Configuration/Credential owner、v1 repository 和模型协议已接入 Application；
- M2/M3 的人工 Browser、Candidate、PDF identity、策略化 intervention 和分层 Acquisition 已形成 loopback 闭环；blob/data/frame/popup 已有受控归属，Range 明确拒绝，复杂 viewer 和跨版本 Range 重组保留明确 Deferred；
- M4 的 242 个模块映射、11 个 Metadata Provider、7 个 Acquisition Source、3 个授权 Provider、Discovery/Import、Parsing、Analysis、Query/Export 和 CLI 已有 TS target/test/evidence；
- M5 的 v2 显式迁移、durable jobs/targets/attempts/events、队列恢复、Candidate 对账、单端口 `/api/v1/jobs/*`、CLI `jobs run` 和任务工作台已通过合成重启旅程；
- M6 的 Quick/Full、便携包/doctor、备份回滚、性能安全报告、安装/升级/切换文档和 Python 生产入口退役已完成；Python 历史源码按逐项报告保留，T059 真实站点验证仍保持授权边界。

全量任务的唯一状态入口是[全量迁移路线](full-migration-roadmap.md)；模块和 Provider 去向见[全量模块迁移映射](migration-map.md)。六份阶段文档保留首阶段实现证据，并作为对应 M0–M6 的执行说明。

阶段文档中的 `02-01`、`03-01`、`03-W1` 等编号是当前实现切片的导航编号，不是原始任务的新版本，也不替代 `T001–T064`。原始任务的标题、依赖、验收 ID 和状态只以[全量迁移路线](full-migration-roadmap.md)为准；每个阶段文档都必须把切片交接回对应的 T 任务。

## 范围与非目标

**本计划范围：**

- 原始基线 235 个 Python 模块，加迁移期间新增的 7 个活动 bridge（当前共 242 个）、8 个公开 `api.py` 入口和 161 个直接测试的迁移语义；
- 11 个 Metadata Provider、7 个 Acquisition source、3 个授权 Acquisition provider 的 TypeScript adapter 和离线行为差分；
- Model、Configuration/Credential、Network、Storage、Agents、Browser、Acquisition、Literature、Parsing、Analysis、Entry、Logging、Bootstrap 及 CLI 的单一 TypeScript Application 组装；
- 原始 M5 的最小持久 jobs/targets/attempts/events、恢复、Candidate 对账、单端口 API 和工作台；
- 原始 M6 的 TS 验收、支持平台安装、数据备份/迁移/回滚、文档同步、Python 退役和发布就绪审查。

**明确不增加的工程复杂度：** 保留模块化单体、SQLite Catalog、不可变 ArtifactStore 和单一 Application；不引入 Redis、微服务、分布式调度、多 Agent 平台、多租户或云服务。M5 只实现原始计划要求的最小持久运行事实，不能借机扩展成新的平台产品。

真实 Provider、真实站点、真实 LLM/MinerU、用户 Profile 和生产数据迁移需要独立授权。没有授权时只使用 synthetic/loopback fixture，并记录 `not-authorized/not-run`。

## 对原始方案的当前化

`original-bundle` 中未落地的依赖选择仍按原计划放在 M0 验证，不为追求形式一致而替换已经满足合同的实现：

| 原始建议 | 当前计划采用的方式 |
| --- | --- |
| Node 24、具体包版本由 M0 固定 | 当前开发/CI 基线保持 Node 22.19.0；T003/T057 依据支持期和安装实测决定最终发行版本，不同时维护两套 runtime |
| 候选 `better-sqlite3` + Worker | 复用已通过 v1 切片的 `node:sqlite`；只有 T015/S01/S02 发现能力或性能缺口时才换 binding |
| WebSocket 事件与画面通道 | 复用现有鉴权 HTTP + SSE/JPEG + command 输入；只在 T052 的恢复、背压或双向输入验收无法满足时增加 WebSocket，不维护重复传输协议 |
| 原始通用 navigate/fill/press 等 Agent 动作草案 | 服从 Accepted ADR 0023 的六种封闭 Agent 动作；人工键盘/文本输入保持独立 operator command，不扩大模型权限 |
| 可能的小型 Rust/native 适配器 | 只有 T004 证明 Node 无法保持锁、no-follow/no-clobber 或 fsync 保证时才增加窄适配器 |
| v2 运行表和恢复 | 只保存恢复所需的 job/target/attempt/policy、关键事件、Candidate 和 intervention，不做完整 event sourcing |
| 多 workspace/平台化 | 保持单机、单 operator；Browser workspace 按 Profile 隔离，仅实现原始任务的最小调度与恢复，不扩展租户体系 |

这些当前化只收缩实现方式，不删除原始的业务完整性、数据安全、恢复、安装或 Python 退役验收。

## 阶段地图（原始 M0–M6）

| 阶段 | 交付结果 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| M0 | 冻结基线、入口盘点、需求/ADR、spike 和威胁模型 | 每个活动文件有去向；高风险依赖可重现；阻断缺口有明确决定 | 已完成（真实外部验证除外） |
| M1 | TS 基础、v1 Model/DB/文件兼容、配置、Network、Agents | canonical bytes/hash、v1 schema、文件和访问边界差分通过 | 已完成 |
| M2 | 可旁观、可接管的 Browser 工作区 | 同一页面、Observation、封闭动作、画面和支持矩阵 Candidate fixture 通过 | 已完成（复杂机制 Deferred） |
| M3 | 策略、Agent、PDF 验收和分层 Acquisition | 自动批次按策略结束；成功均有 Candidate 和身份提交证据 | 已完成（真实站点未授权） |
| M4 | 所有 Provider、业务、解析、分析、查询、导出和 CLI 全量迁移 | 每个模块/入口/Provider/命令有 TS target/test/evidence | 已完成 |
| M5 | v2、持久任务、恢复和受控服务 | 重启/断线/接管/升级恢复演练通过；单一服务入口可用 | 已完成 |
| M6 | 打包、切换、Python 退役和发布审查 | 干净环境安装后全流程、回滚和最终证据总表通过 | 工程验收完成；Python 生产入口已退役，历史材料和真实切换按授权执行 |

阶段可以在依赖满足后并行推进，但公共合同、canonical bytes、schema 升级、生产对象图和控制权协议必须先统一。M2 的完成不能跳过 M4–M6。

## 迁移原则

- 不是逐行翻译。稳定领域语义按 ID、字节、哈希、排序、错误、持久化和用户结果对照；Browser/runtime/policy 按已接受合同实现。
- `Storage` 只保存已确认事实；身份、Candidate、Literature current facts、策略和运行状态分别由各自 owner 写入。
- 所有外部输入在边界解析；模型、Provider、MinerU 和 Browser 只通过中性合同进入 Application。凭据按 provider/origin 绑定，不进入日志、DTO、事件或前端。
- Candidate 先落盘和验收，再由 Literature owner 发布正式 Asset；create-if-absent、hash、receipt 和 stale 检查必须保留。
- 旧行为与新行为分开记录。修复旧错误时使用 intentional-change ledger，不能修改旧数据或删掉有效测试来制造差分通过。
- Python 迁移期能力必须有明确退役任务，不建立永久 Python 后门或长期双写。

## 验证与交付规则

后续代码默认只运行 TypeScript 验收：相关 Vitest、`pnpm quick`、`pnpm full` 和适用的安装后 smoke。依据项目 owner 于 2026-09-10 的决定，不再默认运行 Python Quick、Python Full 或全量 unittest；Python 仅在用户明确要求时运行。TS 测试中调用尚未退役的配置 bridge 只能使用锁定依赖和合成输入，不改变最终 TS-only 目标；MinerU/Parsing 和 Analysis bridge 已从 TS 生产与测试路径移除。

文档-only 修改检查 Markdown 结构、链接、命令事实和 `git diff --check`。真实外部效果不进入默认 CI，也不能用 loopback 证据代替 Provider、站点或用户数据授权。T064 之前不得声明“全量迁移完成”或执行生产切换。

## 计划文档

- [全量迁移路线：M0–M6、T001–T064](full-migration-roadmap.md)
- [全量模块迁移映射、Provider 与入口](migration-map.md)
- [阶段 01：基线与合同](01-baseline-and-contracts.md)
- [阶段 02：本地运行基础](02-runtime-storage-network.md)
- [阶段 03：Browser 与 Acquisition](03-browser-and-acquisition.md)
- [阶段 04：config TUI](04-config-tui.md)
- [阶段 05：Literature 与兼容业务](05-literature-and-compatibility.md)
- [阶段 06：验证与交接](06-verification-and-handoff.md)
- [Browser 设计手册](browser-design-manual.md)
- [config TUI 设计手册](config-tui-design-manual.md)
- [计划文档清单](document-map.md)
- [架构审查](architecture-review.md)

## 历史材料

原始参考包保留在 [`docs/archive/2026-09-07-typescript-browser-workbench-reference`](../../archive/2026-09-07-typescript-browser-workbench-reference/)，其中的 `tasks.json` 和 M0–M6 文档是本计划的来源。首阶段过程材料保留在 [`docs/archive/2026-09-07-typescript-browser-workbench-process`](../../archive/2026-09-07-typescript-browser-workbench-process/)，只用于追溯，不覆盖本 README 和全量路线的状态。

归档包中的 `validation-report.json` 只证明原始计划包在生成时的文档、链接、依赖和验收引用检查结果；它不是当前代码迁移或发布验收。当前计划的文档检查以本目录实际内容和项目 [HARNESS](../../../HARNESS.md) 规则为准。
