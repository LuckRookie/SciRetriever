# TypeScript Browser 工作台改造审查

> 历史审查说明（2026-09-10 补注）：本文审查的是中间过程中的 192 Task 扩写版，不是
> [`original-bundle`](../../archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/)
> 的原始 64 Task 计划。下文“当前计划”“当前状态”均指该次审查快照。本文保留原文供追溯，不作为执行或验收入口。

> 当前决定（2026-09-10）：Browser 前端、唯一配置 owner 边界、真实本地 loopback 垂直旅程和用户可见失败模型
> 已完成首阶段实现与 TS 验收。原始 M0–M6 全量 TypeScript 路线现已恢复，状态见[全量路线](full-migration-roadmap.md)。
> 本文提出的“关闭第二阶段”裁剪意见已被取代；其中关于减少重复抽象、维持模块化单体和最小持久事实的建议继续适用。

审查对象：本目录下 2026-09-07 计划、当前 SciRetriever 工作树和现有测试。审查目的：判断改造范围是否过度、改造后是否能得到预期产品，以及调整模块边界和交付顺序。

## 结论

计划的方向基本正确，但当前版本不适合直接执行。它把三个不同目标绑定成一条 192 Task 的全量迁移链：

1. 把现有 Python 功能迁移到 TypeScript，并保持用户可观察行为；
2. 交付一个可观看、可接管的 Browser 工作台和合法 PDF 候选获取链；
3. 把本地工具升级成带认证、持久队列、崩溃对账、跨 workspace 调度和可发布安装包的平台。

第 1、2 项是当前需求的核心，第 3 项只有在明确要做长期 daemon、多用户或无人值守批处理时才值得进入本轮。建议把计划改成“两阶段、一个可运行垂直切片”：先交付单用户本地工作台和配置 TUI，再决定是否进入持久服务平台化。

当前计划不能证明改造后一定符合预期。它能证明“如果全部 192 个 Task、所有 spike、所有验收和现场试验都完成，边界会很严密”，但不能保证最关键的用户旅程尽早可用。计划自己的状态也承认大部分工作尚未完成；已有仓库有 `apps/server` 和 server tests，但没有 `apps/web`，因此 Browser 工作台前端、WebSocket/画面端点和真实前端输入仍是明显缺口。

## 证据与当前状态

- 计划声明共 6 个 Block、192 个 Task；Block 01、02、03 仍是 `In progress`，Block 04–06 为 `Pending`。
- 当前 TypeScript 代码主要位于 `apps/server/src` 和 `packages/contracts/src`。已有 Browser host、control、observation、transfer、候选发布、策略和网络基础切片。
- 当前 `apps/server/test` 有 Browser 与配置相关的单元/集成测试，但没有 `apps/web` 目录。计划中多个 Web 测试路径是拟新增路径，计划也正确地把它们标为未完成。
- 既有产品文档把 `sciretriever config` 定义为配置中心，并已有 `Models`、`Search`、`Download`、`Parse`、`Analyze`、`Browser`、`Status`、`Theme`、`Quit` 等菜单和 `config status/test` 命令。
- 配置路径、Provider、MinerU、Browser profile 和凭据已经有稳定的 Python 行为与测试。若 TS 同时重新定义配置 owner，容易产生双写和行为漂移。

## 过度工程化判断

### 合理且应保留

以下内容直接保护用户数据或 Browser 获取正确性，应保留，但以最小实现落地：

- typed contract、严格未知字段拒绝、稳定脱敏错误；
- 普通配置与 credential 的 owner 分离；
- URL admission、DNS/IP 绑定、redirect 逐跳检查、请求体大小和取消；
- 单一 Browser owner、固定 Profile、控制权 epoch、Observation 版本和封闭 Action；
- Candidate 与正式 Literature/Asset 分离；
- 文件临时写入、hash、no-clobber 发布和幂等 receipt；
- 不等待 `networkidle`，以有界 Observation 和明确 loading/partial 状态结束；
- 至少一条只访问 loopback 的真实 Browser 垂直旅程。

这些是正确性边界，不是过度工程化。它们可以服务于一个单用户应用。

### 当前阶段过重，应后移

| 计划部分 | 问题 | 建议 |
| --- | --- | --- |
| 235 个 Python 模块逐项 inventory、161 个测试逐项映射 | 对首个 Browser 闭环的边际价值低，会让迁移成为文档项目 | 第一阶段只盘点公开 CLI、配置字段、Browser/Acquisition/Library 入口；全量 inventory 后移 |
| 11 个 Metadata adapter 一次性迁移 | Provider 之间差异大，无法帮助验证工作台主链 | 第一阶段保留 Python metadata 或只迁 1 个代表性 provider；其余按 adapter 独立迁移 |
| 逐一覆盖 Worker、Service Worker、WebSocket、CONNECT、popup、iframe、viewer 的出口证明 | 安全目标合理，但首个 loopback Browser journey 不需要全部通道 | 首阶段覆盖 navigation、redirect、download、普通 response；其余通道作为能力声明和第二阶段门 |
| v2 execution schema、recoverable queue、lease、fencing、unknown-outcome reconciliation | 对单用户前台辅助式流程过重，且会先于真实工作台产生大量抽象 | 先用内存 job 状态 + receipt + 进程关闭清理；只有 daemon/无人值守需求成立后引入持久队列 |
| service authentication、workspace authorization、HTTP API、事件流、画面流全套 | 本地单用户模式中认证与 workspace 层会拖慢交付 | 第一阶段绑定 loopback、随机会话 token、单 workspace；平台化时再扩展多主体模型 |
| PDF 资源炸弹、完整页树、加密、无文本、大文件全矩阵 | 需要，但属于文件接纳的安全专项 | 先做 magic bytes、页数/字节/耗时上限、文本证据和失败分类；复杂 PDF 引擎比较后移 |
| 全平台发行矩阵、实际包安装、Python retirement、cutover drill | 只有产品形态确定后才有意义 | 先定义一台开发平台和一个离线 package smoke；发布矩阵放在第二阶段 |
| 现场真实站点效果试验 | 依赖授权、Provider、LLM 和样本，不能作为工程主链前置 | 继续单列为 `not-authorized/not-run`，不阻断 loopback 工程闭环 |

## 预期符合度

按“本地单用户、人工观看/接管、获取并确认 PDF、写入文献库、继续解析/查询”的预期，建议的第一阶段可以达到预期，前提是补齐四个当前空档：

1. **真正的 Browser 前端**：页面布局、画面流、控制权、Observation、动作反馈、Candidate 状态和错误提示；
2. **唯一的配置 owner**：TUI 仍调用现有 Python 配置中心，或明确由 TS 接管并删除 Python 写入口，不能两边并行写同一文件；
3. **一条真实 loopback vertical slice**：启动服务 → 打开 fixture 页面 → 观察 → 受控点击/输入 → 捕获 PDF → identity/version verdict → Candidate → Literature/Asset；
4. **用户可观察的失败模型**：被拒网络、未配置模型、需要人工接管、超时、文件不完整、身份不确定分别呈现下一步，而不是统一为“失败”。

按“长期后台服务、多 workspace、跨进程崩溃恢复、全平台安装、11 个 provider 全量 parity”的预期，当前计划的方向仍不足以直接保证符合度，因为许多关键 Task 只有拟新增路径和未运行证据。必须先定义容量、支持平台、后台运行场景和恢复承诺，再决定是否承担平台化成本。

## 建议的目标模块

### 第一阶段：可用闭环

```text
apps/server/src/
  app/                 # 单一组装与生命周期
  browser/             # host、page、observation、action、control、screen
  acquisition/         # policy、execution、transfer、candidate
  storage/             # file store、sqlite、最小 literature publication
  network/             # URL admission、connection、budget、cancel
  configuration/       # 只读投影和 CLI/TUI bridge
packages/contracts/    # v1 DTO、action、observation、candidate、errors
apps/web/              # Browser workbench
```

建议新增 `apps/web`，但只保留四个界面状态：`loading`、`watching`、`needs-assistance`、`finished/failed`。画面、事件、控制权和错误可以共用一个认证会话，但不要在第一阶段引入完整多租户概念。

建议新增一个 `browser/session` 聚合层，统一 `page_id`、`document_generation`、`viewport_revision`、`control_epoch`；不要让 `control.ts`、`observation.ts`、`transfer.ts` 各自维护一套生命周期状态。

建议把 `transfer` 拆为 `admission → capture → finalize` 三个状态，而不是首阶段拆成 range、attribution、deduplication、drain 四个互相独立的产品模块。内部仍可有函数，但不必让每个函数成为独立计划 Task。

### 第二阶段：平台化能力

保留现计划中的 `execution schema`、持久 queue、lease/fencing、recovery、service API、事件/画面 stream、platform matrix、v2 migration 和全量 provider parity，但它们要由明确的产品承诺触发：后台任务必须跨重启继续、多个 workspace 必须并行、或需要无人值守批处理。没有这些触发条件时不要提前实现。

## 应添加的模块与功能

- `apps/web`：真实工作台前端及浏览器端输入适配。
- `browser/session`：页面身份、文档代次、视口版本、控制 epoch 的单一聚合。
- `acquisition/user-facing-state`：把内部 verdict、budget、assistance 和 transfer 状态映射为可操作的用户状态。
- `configuration/projection`：向 TUI 与 Web 提供脱敏、只读 readiness 投影。
- `tests/journeys/browser-single-route`：使用真实 server、真实 Browser 和 loopback fixture 的垂直验收，不以全 mock 代替。
- `docs/guides/browser-workbench.md`、`docs/guides/config-tui.md`：与实现同步的用户手册，见本目录同名设计手册。

## 应删除或合并的内容

- 删除首阶段“全量 235 模块、161 测试先完成才可开始”的隐含心理前置；保留 inventory 作为迁移追踪，但切成异步工作。
- 合并 `TRANSFER-RANGE-ETAG`、`TRANSFER-DEDUPLICATION`、`TRANSFER-DRAIN` 为 Candidate pipeline 的内部验收项，除非真实需求确实包含断点续传和长生命周期下载。
- 合并第一阶段的认证、workspace、HTTP API、事件流和画面流为一个本地 `WorkbenchSession`；第二阶段再拆成服务合同。
- 暂不新增第二个 SQLite schema。v1 只要能存 Candidate、Asset、Literature、receipt 和 query 就够；v2 应由真实持久队列需求驱动。
- 暂不迁移所有 Provider。Provider parity 可继续作为兼容性目标，但不能成为 Browser 工作台可用性的阻断条件。

## 推荐执行门

第一阶段只需要 12 个结果门：配置读取、模型 readiness、Browser 启动、loopback navigation、Observation、封闭 Action、下载/response admission、PDF acceptance、identity/version verdict、Candidate durable handoff、Literature publication、移动端/桌面端工作台可用性。12 门全部通过后，再做一次用户试用；试用结果决定第二阶段是否开启。

第一阶段的“完成”应意味着：用户能在一次本地会话内完成目标旅程，失败有明确原因，关闭后已确认 Candidate 不丢，重开后可查询。它不应意味着 11 个 Provider、所有平台、持久多 workspace 服务和 Python 退役都已完成。

## 最终建议

接受计划中的安全原则和合同思想，拒绝当前的全量同步实施顺序。把计划重写为“最小 Browser 闭环 → 配置/TUI 对齐 → 业务发布 → 现场试验 → 可选平台化”。这样既能保持用户数据边界，也能更早验证产品是否真的好用。
