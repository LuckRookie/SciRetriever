# Logging UX 整修计划

> 历史实施记录，非当前产品或架构真相源。当前行为以 requirements、Accepted ADR、current
> docs、源码与测试为准。

## 身份与状态

| 字段 | 值 |
| --- | --- |
| Run ID | `LOGUX-20260902` |
| 创建日期 | 2026-09-02 |
| Primary owner | Codex `/root` |
| Baseline revision | `417b80f4acb6aa6d3c7b532205d44a2d021794e8` |
| 执行模式 | cross-session；单一 Primary owner；串行实施 |
| 当前状态 | Completed and archived — 2026-09-04 |

Baseline 工作树包含用户尚未提交的 Configuration、Agents、Provider stream 与配置测试改动。本计划只在这些改动之上做日志相关的最小集成，不回滚、覆盖或顺手提交其它改动。

## 目标观察

计划完成后，用户在正常运行中能够首先看到操作、阶段、进度、最终结果和需要处理的问题；在 `--debug` 中能够继续下钻到安全的决策与外部边界细节。具体表现为：

- INFO 回答“现在做什么、完成多少、哪里失败、下一步做什么”；
- DEBUG 在 INFO 之上回答“为什么选择这条路径、外部边界实际发生了什么”；
- 主行保持短而可扫读，失败使用统一的 `reason`、`action`、`code` 和 `retryable` 续行；
- `config test` 明确区分本地 Model reference 与实际发送的 wire model，并显示安全 request endpoint 与 stream；
- 同一业务事实只由一个拥有层输出用户可见摘要，正常 miss、candidate、capture、cleanup 和 native operation 不在 INFO 刷屏；
- 日志继续只写 stderr，不污染 stdout、JSON Report 或业务结果。

## 授权与真相源

用户已于 2026-09-02 同意以下方向并授权写入计划、开始实施：

1. 保留 INFO/DEBUG 两层，不新增 verbose/trace；
2. 保留稳定 `event` ID，但降低其视觉优先级；
3. 配置测试显示安全的实际请求上下文；
4. 先建立静态、可折行、可重定向的输出，不在本计划引入动态 Live UI。

适用真相源：

- [产品需求](../../architecture/requirements.md) R6、R8 与运行报告边界；
- [ADR 0013](../../architecture/decisions/0013-decoupled-discovery-and-database-maintenance.md) 的 Report/Logging 分离；
- [架构设计 5.5](../../architecture/design.md#55-logging) 的 Logging 所有权；
- [Logging 技术设计](../../architecture/technical/logging.md) 的 stderr、安全、INFO/DEBUG 与非持久化合同；
- [HARNESS](../../../HARNESS.md) 的工程验证和 Git 纪律。

本计划只组织实施，不修改上述产品和架构边界。

## 事实、假设与开放问题

### 已核实事实

- `logging/` 已有命名 logger、项目自有 stderr handler、最终脱敏 Filter 和 best-effort formatter；
- 当前 formatter 能解析 `event=<id> key=value`、排序字段、显示 glyph/颜色并为 `reason`、`action` 换行；
- 生产代码约有两百多个日志调用，存在 Entry、Completion、Cohort、Route、Provider、Browser Session、Browser Native 与 Network 多层生命周期重叠；
- Agents 仍存在 `agent.call.start/result` plain message，未进入事件式展示；
- 当前测试重点证明基础安全和单条格式，尚未系统证明完整流程的日志数量、所有权、重复和可读性；
- Rich 已是项目依赖，但 Logging 当前只依赖标准库，且静态日志必须安全支持重定向和并发。

### 待实现验证的假设

- 用“主行 + context/reason/action 续行”的静态布局可以同时改善窄终端阅读和重定向文本；
- 通过生产者 level/所有权清理即可显著降低 INFO 噪声，不需要第三种生产日志等级；
- 原始 event ID 可移到较低视觉优先级，同时继续满足 `rg` 检索；
- 无需引入公共 LogEvent Model，也能以内部字段词汇和测试保持一致性。

### 开放问题

- 是否在静态 transcript 稳定后另行设计 Rich Live 进度视图：不属于本计划，由真实使用反馈决定；
- 是否需要仅在单次 Debug 运行中提供非持久化关联标识：当前不增加，只有并发 transcript 证明目标归属仍不可辨认时才返回设计讨论。

## 范围与非目标

### 范围

- `src/sciretriever/logging/` 的静态呈现、折行、字段分层和安全回退；
- Entry、Metadata、Discovery、Completion、Acquisition、Parsing、Analysis、Agents、Browser 与 Network 中代表性生产日志的 level、命名、字段和所有权；
- Config probe 与运行日志之间的诊断展示边界；
- 日志 foundation、presentation、生产流程 transcript、脱敏和重复检测测试；
- 当前行为文档和 Logging 技术文档的必要同步。

### 非目标

- 不增加第三种日志模式、配置文件日志开关或 per-component CLI filter；
- 不创建 LogEvent Model、EventBus、Observer、repository、日志数据库、日志文件或轮转；
- 不从日志生成 Report、业务状态、重试或恢复决定；
- 不输出 secret、Cookie、query、Prompt、模型原文、响应正文、页面正文、selector、截图内容或绝对路径；
- 不引入动态 Rich Live UI；
- 不连接真实 Provider、MinerU、Browser、真实凭据、用户 Catalog、PDF 或语料；
- 不执行 commit、push、发布或破坏性 Git 操作。

## 全局验收条件

- [x] INFO 与 DEBUG 的职责由实现、直接测试和用户文档共同证明；
- [x] 代表性 Search、Download/Completion、Parse、Analyze、Agents 和 Browser 流程有可读 transcript；
- [x] 同一业务事实的 INFO 摘要只有一个拥有层；
- [x] 每个用户可见失败优先呈现安全的 code/reason/action/retryable；
- [x] Config Model/Analyze/Browser Model probe 区分 model reference 与 wire model，并显示 method、safe endpoint 与 stream；
- [x] 窄终端、非 TTY、`NO_COLOR`、并发、formatter/filter/stream 故障与 stdout 隔离测试通过；
- [x] 两种模式均不泄露禁止内容，Logging 故障不改变 Report 或业务结果；
- [x] 相关测试、Quick 和 Full Harness 通过；
- [x] README、Logging 技术文档、源码和测试描述一致；
- [x] 最终 diff 不夹带凭据、真实数据、构建产物、个人配置或无关改动。

## 分块地图与依赖

| 顺序 | Block | 结果 | 主要文件 | 前置 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | [展示合同与 Presenter](01-presentation-contract.md) | 静态、分层、可折行且安全的统一布局 | `logging/presentation.py`、日志直接测试 | 用户确认设计 | Completed |
| 2 | [操作与业务生产者](02-operation-and-business-events.md) | INFO 只保留拥有层摘要，Agents 使用统一事件 | Entry、Metadata、Acquisition、Parsing、Analysis、Agents | Block 1 | Completed |
| 3 | [外部边界与失败诊断](03-external-boundaries-and-diagnostics.md) | Browser/Network Debug 可诊断但不刷屏，Probe 请求语义一致 | Browser、Network、Config probe | Block 1、2 | Completed |
| 4 | [验证、文档与交接](04-verification-and-handoff.md) | 集成行为、Full、文档和最终审查闭环 | tests、README、technical logging | Block 1-3 | Completed |

执行严格串行。Block 2 可以在 Block 1 的 transcript 合同稳定后开始；Block 3 依赖 Block 2 已明确业务摘要所有权；Block 4 只在前三块的直接测试完成后进入。

## 跨块合同

- 日志只写 stderr，stdout 继续由 CLI result/JSON Report 独占；
- `configure_logging` 与 `get_logger` 的公开 API 不扩张；
- 保留标准库 `Logger`，不建立第二套 logger 类型或公共事件 schema；
- 原始 event ID 保留为可检索诊断身份，但不是公共业务 API；
- INFO 只包含操作、阶段、Source/Provider、进度、稳定失败与 summary；
- DEBUG 追加候选、route、permit、session、capture、cleanup、native operation 和安全耗时；
- adapter 先把外部失败转换为稳定、安全事实，Logging Filter 只作最终防线；
- 日志关闭、过滤、格式化或写入失败不能改变业务返回、Report、提交、选择、重试或恢复；
- 工作树中的 Configuration/Agents/stream 改动属于受保护上下文，日志改动必须与其当前接口集成。

## 影响矩阵

| 面 | 影响 |
| --- | --- |
| 公开 Python API | 无；仍为 `get_logger` 与 `configure_logging` |
| CLI | `--debug` 语义不变；stderr 可读性、字段层级和事件数量变化 |
| 配置 | 无新字段或迁移 |
| 数据/schema | 无 Catalog、Artifact、Report 或 Model schema 变化 |
| 依赖 | 预计无；不为 Logging 新增依赖 |
| 对象图 | 无；Bootstrap 仍只配置现有 Logging |
| 文档 | README 与 Logging technical 同步当前行为 |
| 打包 | wheel 应继续包含同一 Logging package；Full 验证 |
| 兼容性 | 日志格式本非稳定公共 API；event ID 尽量保留以支持排障检索 |

## 风险与转化信号

| 风险 | 控制 | 转化信号 |
| --- | --- | --- |
| 为了整洁删掉必要诊断 | INFO/DEBUG 成对 transcript，失败分类直接测试 | Debug 仍无法区分失败层 |
| Formatter 变复杂后泄密或故障 | 来源脱敏 + 最终 Filter + hostile fixture | 禁止内容出现在任一模式 |
| 修改两百多调用导致范围失控 | 先代表性流程，按拥有层审查，不机械重写 | event owner 或字段合同无法稳定 |
| 折行破坏 `rg`/重定向 | event ID 保留；非 TTY golden sample | 重定向结果丢 event 或 ANSI |
| 并发目标上下文混淆 | 原子 record；稳定进度/目标上下文 | transcript 无法判断行属于哪个目标 |
| 覆盖用户正在修改的 Agents/Config | 修改前审查精确 diff，局部 patch | 目标文件现有改动与计划合同冲突 |

若出现产品语义、公开 API、持久数据、依赖、真实外部访问或新关联状态需求，停止当前块并返回用户/架构设计，不在实现中堆兼容层。

## 验证与证据策略

| 顺序 | 证明 | 检查 | 证据位置 |
| --- | --- | --- | --- |
| 1 | Presenter 单条和折行合同 | `tests/test_logging_presentation.py` | Block 1 完成证据 |
| 2 | 安全、stderr、并发与故障隔离 | `tests/test_logging_foundation.py` | Block 1/4 完成证据 |
| 3 | 业务 INFO/DEBUG 所有权与 transcript | 相关 Entry/Metadata/Acquisition/Agents 测试 | Block 2 完成证据 |
| 4 | Browser/Network/Probe 失败诊断 | 相关离线 fixture 测试 | Block 3 完成证据 |
| 5 | 全库机械质量 | `uv run --frozen python scripts/harness.py quick` | Block 4 完成证据 |
| 6 | 类型、全部 unittest、wheel | `uv run --frozen python scripts/harness.py full` | Block 4 完成证据 |
| 7 | 用户目标、安全与最终范围 | diff 与语义审查 | 最终交接 |

测试只使用内存 stream、fake/fixture 和受控异常，不产生真实外部调用。

## 授权门

| 触发 | 动作 | 所需授权 | 当前状态 |
| --- | --- | --- | --- |
| 当前计划实施 | 编辑计划、源码、直接测试与必要文档 | 用户已授权 | Approved |
| 真实 Provider/MinerU/Browser 测试 | 访问真实外部服务或凭据 | 逐次明确授权 | Not approved |
| 并行执行单元 | 启用多个实现 owner | 明确批准具体范围 | Not approved；串行执行 |
| Git commit/push/PR | 写入历史或外部仓库 | 明确授权 | Not approved |
| 新依赖或公开合同变化 | 修改依赖/架构合同 | 新用户决定 | Not approved |

## 执行方式与集成点

Primary owner 逐 Task 执行“精确预检 → 最小完整切片 → 直接测试 → diff/安全审查 → 记录证据”。不启用 worker 或并行实现。每块退出后更新根计划状态，下游只依赖已经通过直接测试的合同。

集成点为：

1. Block 1 输出稳定的 formatter 输入/输出约定；
2. Block 2 让业务生产者遵循该约定并明确 INFO owner；
3. Block 3 在不复制业务摘要的前提下提供外部边界 Debug；
4. Block 4 对组合状态运行 Full 并完成文档与最终审查。

## 执行审查

| Gate | 时点 | 必查内容 | 未通过处理 |
| --- | --- | --- | --- |
| R0 | Block 1 前 | 用户决定、真相源、范围、受保护工作、验收、恢复 | 返回计划，不实施 |
| R1 | 每块进入 | 前置证据、owner、目标文件 diff、测试入口 | 保持 Pending |
| R2 | 每个切片 | 用户结果、错误路径、安全、重复、测试、无夹带 | 当前块修复或返回 owner |
| R3 | 每块退出 | Tasks、直接测试、下游合同、残余风险 | 不标 Completed |
| R4 | Block 4 集成 | INFO/DEBUG、Probe、对象图、文档和全库测试 | 返回产生问题的块 |
| R5 | 最终交付 | 原始目标、最终 diff、Full、安全、Git 状态 | finding 闭环后交付 |

安全、Report 边界、模块所有权或公开合同 finding 为 blocking；改变 owner、接口、数据、风险或验收的 finding 为 material，并返回设计/计划；局部格式和测试问题在当前块修复。

## 进度规则

- Task 只有实现、直接测试和必要文档同时成立时才勾选；
- Block 只有全部 Task 与退出审查闭环后才标记 Completed；
- 根计划只从块状态汇总，不另造百分比；
- Full 未通过或未运行时，计划不能标记 Completed；
- 事实改变方向、owner、接口、安全或验收时先更新计划，再继续执行。

## 恢复与续作

恢复时依次读取：

1. 仓库 `AGENTS.md` 与 `HARNESS.md`；
2. 本 README 与当前未完成 Block；若计划已经完成，则读取最终交接；
3. `git status --short` 和目标文件 diff；
4. 当前 Block 已记录的测试证据；
5. 从第一个未勾选 Task 继续，不重复已经通过且未受漂移影响的工作。

最近恢复点始终是最后一个通过直接测试和 R2 审查的 Task。失败时保留用户工作和失败证据，不使用 reset/checkout，不删除不属于本计划的文件；在当前块恢复或返回上一块合同。

## 计划变更记录

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-09-02 | 创建四块串行计划 | 用户确认日志 UX 原则并授权开始实施 |
| 2026-09-02 | Block 1 Completed，进入 Block 2 | 静态分层 Presenter、宽度折行、安全和并发直接测试通过 |
| 2026-09-02 | Block 2 Completed，进入 Block 3 | 业务 INFO owner、Agents 事件和代表性 transcript 直接测试通过 |
| 2026-09-02 | Block 3 Completed，进入 Block 4 | Browser/Network 分层、Probe 请求诊断与离线边界安全测试通过 |
| 2026-09-02 | Block 4 Completed，计划闭环 | 468 项集成回归、Quick、2226 项 Full unittest、Pyright strict 与 wheel 内容核对通过；文档和最终安全审查完成 |
| 2026-09-04 | 计划移入历史归档 | 已完成实现、文档和验证事实已由当前源码、测试及权威文档承接 |

## 最终交接

完成于 2026-09-02。实现形成 INFO owner / DEBUG drill-down、静态折行 Presenter、安全失败续行、Agent/Browser/Network 下钻与 Config probe 请求诊断的一致 UX；README 与 Logging technical 已同步当前行为。

离线证据为 468 项目标集成测试、Quick、Pyright strict 0 errors/0 warnings、Full 发现的 2226 项 unittest，以及 wheel 构建和内容核对全部通过。`git diff --check` 通过，新增行未发现凭据 token，diff 不包含配置/credential 文件、数据库、PDF、依赖文件或构建产物。工作树仍包含计划开始前即存在且受保护的 Configuration/Agents/stream 改动；本计划没有回滚、单独提交或重新归属这些改动。

本次未运行真实 Provider、MinerU、Browser 或用户凭据测试，也未执行 commit、push、PR 或发布；后续真实整体测试仍需新的明确授权，并不能由离线通过推断外部服务可用。

归档位置为 `docs/archive/2026-09-02-logging-ux-repair/`。
