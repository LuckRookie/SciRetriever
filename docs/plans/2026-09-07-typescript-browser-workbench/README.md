# SciRetriever TypeScript 与 Browser 工作台迁移计划

## 身份与状态

- Run ID：`sciretriever-typescript-workbench-rebuild`
- 创建日期：2026-09-09
- Primary owner：Codex（跨会话保持一个逻辑 owner）
- Baseline revision：`master@e1a33d5986f654f2692d7619dd58448944ec3463`
- 执行模式：`cross-session`、串行；并行实施未获授权
- 当前状态：`In progress`；计划文档已完成本轮结构纠偏，代码执行按用户要求暂停在 R0/Block 01 前
- 计划规模：6 个 Block、189 个稳定 Task；Task 定义与 checkbox 只在所属块文件中
- 当前恢复点：[INVENTORY-MODULES](01-baseline-and-contracts.md#inventory-modules)；先完成 Block 01 的清单、spike、运行时选择和合同审查

## 目标观察

完成后，用户可从受支持的安装包启动一个持久服务，通过同一真实 Chromium 的本地工作台观看和接管页面；
Agent 只对稳定版本的 Observation 提交一个封闭动作；response/download 在页面与客户端生命周期之外完成有界收集。
系统只在 PDF 字节、文章身份、版本、provenance 和 Literature owner 均确认后发布正式文献资产，并保持发现、
元数据、引用、解析、分析、导入导出、查询、CLI、配置、恢复和安装行为与获准合同一致。

## 授权与真相源

用户本轮只授权修复活动计划文档，并要求在开始实现前停止。以前对源码、测试或离线实现的授权不用于本轮继续执行；
本轮不运行实现测试、不修改源码、不访问外部服务或用户资料，也不执行 Git 写操作、发布、切换或退役。

计划执行时按以下真相源判断，不由本目录创建第二套产品或架构事实：

- 产品范围和 R1–R8：[产品需求](../../architecture/requirements.md)；
- 长期设计：[Accepted ADR 索引](../../architecture/decisions/README.md)，尤其 ADR 0002、0011、0012、0016、0017、0018、0019、0021、0022、0023、0024；
- 模块、数据流和对象图：[架构原则](../../architecture/principles.md)、[设计](../../architecture/design.md)、[技术索引](../../architecture/technical.md)及对应专项技术文档；
- 当前已实现行为：项目 [README](../../../README.md)、`docs/guides/`、源码和直接测试；
- 质量和交付：[HARNESS](../../../HARNESS.md)、`scripts/harness.py`、workspace package scripts 与 CI；
- 活动执行与恢复：本 README、6 个块文件、[任务索引](task-ledger.md)、[执行顺序](execution-order.md)、[验收矩阵](verification-matrix.md)和实际脱敏证据。

目录中的历史研究档案仅供本轮差异审计，明确排除在执行依赖、验收来源、状态依据、证据路径和恢复入口之外。
执行者可以不读取该档案完成全部 189 个 Task。

## 事实、假设与开放问题

已核实的事实：当前 Python 仍是生产入口；工作树包含大量未提交迁移改动；`migration/inventory.json` 的 235 个模块
仍全部是 `migrate/unstarted`，且缺 consumer、direct test、Task 和 evidence 闭环；`apps/web/src/` 尚无可验收的
完整工作台；已有 server Browser 控制测试不能证明 Web 前端；已有 execution policy/transfer 实现不能证明完整动作、
逐事件 admission、传输形态和恢复；旧 Full 测试数不是当前工作树证据。

需要由 Block 01 spike 确认：受支持 CloakBrowser/Chromium、Playwright、Profile、headed/headless、screen stream、
SQLite binding、文件安全原语、PDF 结构检查/文本证据及发行平台组合。环境中发现命令或缓存不等于组合已受支持。

需要由执行证据确认：v1 repository 全覆盖与一致快照、Candidate durable handoff、正式 Literature 资产发布、
v2 schema 备份/迁移/回滚、崩溃恢复、认证服务、平台安装与干净环境旅程。

开放问题：真实站点成功率、真实 Provider/LLM/MinerU 可用性、真实用户数据迁移和生产切换均未授权；它们不会阻止
离线实现，但必须在最终状态中保持 `not-authorized/not-run`，除非用户另行给出精确授权。

## 范围与非目标

范围包括：迁移盘点和高风险 spike、严格 TS contracts、v1 兼容运行基础、真实本地 Browser 工作台、完整传输捕获、
PDF/identity/version Candidate、全部 Metadata/Acquisition/业务能力、Literature 正式发布、v2 持久服务与恢复、
实际包、平台安装、离线旅程、文档与切换准备。

非目标包括：自动读取或迁移真实 Catalog/Profile/Cookie/凭据；新旧实现双写生产库；绕过 Network 的 SDK、Browser
或 adapter；第二 Browser owner、第二文献数据库、任意远程桌面、登录/MFA 绕过、代理轮换、购买/注册；把运行状态、
Candidate 或 MinerU 状态写成 Literature 事实；未经授权的真实外部测试、Git、发布、切换或 Python 删除。

## 全局验收条件

- 235 个 Python 模块、8 个公开入口、11 个 Metadata adapter、10 个 Acquisition 入口、23 个 CLI path、11 个配置 section 和 161 个 Python 测试文件逐项映射到 owner、consumer、Task、直接测试、证据与 disposition。
- 运行时、Browser、文件安全、SQLite、PDF 和支持平台均有 spike 与正式选择，未知组合显式 `not-run/unsupported`。
- TS 对冻结 v1 fixture 保持 Model、ID、canonical bytes/hash、schema、FTS、关系、排序、cursor、资产引用和查询语义。
- Configuration、Network、FileStore、SQLite Worker、repositories、Agents 和唯一 Application graph 完整闭合。
- 工作台有真实 Web 入口；同一页面可多方观看、单人控制；所有 Browser 外部事件逐项 admission，动作集合封闭，旧 epoch 和迟到结果零执行。
- response/download 的 GET/POST、inline/attachment、popup/iframe、viewer、blob/data、Range/ETag、延迟事件、重复事件、Service Worker 和有界 drain 均有 loopback 证据。
- Candidate durable-ready 独立于 page/screen/Agent/client；Acquisition 只发布候选证据和 receipt，Literature owner 才发布正式 Asset/LiteratureAsset/current facts。
- 11 个 Metadata adapter、全部 Acquisition source、Literature、Discovery、Import/Export、Parsing、Analysis、Query、配置、CLI 和公共入口有正反例及 parity 证据。
- v2 运行事实与 v1 文献事实隔离；schema inspect、backup、migrate、rollback、job/attempt/event/Candidate ACK、队列、调度、协助、crash recovery、认证 HTTP/WS 和 daemon 均通过副本验收。
- TS/Python Full、CI、包内容、支持平台安装、干净环境与完整离线旅程、数据/Profile 回滚、性能、背压、安全、文档和 R5 均通过。
- 真实外部状态准确记录；生产切换、发布和 Python 退役只在具体授权后执行。

## 分块地图与依赖

| 块 | Task 数 | 结果 | 依赖 | 状态 | 下游交接 |
| --- | ---: | --- | --- | --- | --- |
| [01 基线、风险与公共合同](01-baseline-and-contracts.md) | 26 | 完整迁移盘点、spike、运行时选择、v1 fixture 和公共合同 | 无 | `In progress` | 经 `BASELINE-ACCEPTANCE` 交给 02 |
| [02 运行时、配置、网络与持久基础](02-runtime-storage-network.md) | 39 | Configuration、Network、FileStore、v1 repositories、Agents 和对象图 | 01 | `In progress` | 经 `RUNTIME-FOUNDATION-ACCEPTANCE` 交给 03/04 |
| [03 Browser 工作台与候选获取](03-browser-and-acquisition.md) | 43 | 工作台、动作、捕获、策略、PDF/identity/version、Candidate 和来源 | 02 | `In progress` | Candidate 给 04；endpoint/stream 给 05 |
| [04 业务能力与正式文献发布](04-business-and-service.md) | 36 | Metadata/Literature/业务 parity、正式资产发布、配置和 CLI | 02、03 | `Pending` | 业务 Application 与 Literature publication 给 05 |
| [05 持久服务、调度与恢复](05-persistent-service-and-recovery.md) | 21 | v2 schema、repositories、queue、恢复、认证 HTTP/WS、daemon | 03、04 | `Pending` | 可安装持久服务给 06 |
| [06 最终验证、发布准备与交接](06-verification-and-handoff.md) | 24 | 质量、CI、package、平台、旅程、恢复、安全、文档和授权包 | 01–05 | `Pending` | 明确授权后的独立外部动作或归档 |

块编号只用于目录顺序。Task ID、源码、测试文件和 suite 使用行为名称，不携带块号、里程碑、阶段、步骤或 Task 顺序。

附件职责：

| 附件 | 用途 | 更新与退出条件 |
| --- | --- | --- |
| [task-ledger.md](task-ledger.md) | 189 个稳定 ID 到 owner 块的导航 | 增删移动 Task 时同步；链接与块内 ID 完全一致，不保存第二份状态 |
| [execution-order.md](execution-order.md) | 块间和关键跨块依赖、恢复顺序 | 依赖/owner 改变时同步；不得产生下游反向前置 |
| [scope-and-invariants.md](scope-and-invariants.md) | 跨块事实所有权、安全和兼容索引 | 只链接真相源和 Task，不创造新合同 |
| [verification-matrix.md](verification-matrix.md) | 语义场景、结果、owner、测试、证据、状态和恢复点 | 每个场景可由本计划独立执行，不依赖历史档案 |
| [decision-log.md](decision-log.md) | 计划级选择、证据和长期决策路由 | 长期选择必须回到 requirement/ADR；旧决定可明确 supersede |
| [plan-review.md](plan-review.md) | R0 纠偏 finding 与文档验收 | 所有计划 finding 关闭后才允许请求开始实现 |

## 跨块合同

- Browser Host 唯一持有 vendor 对象；Action Executor 是动作唯一入口；Screen/Workbench 只消费 typed contracts。
- Network 唯一持有 HTTP、DNS/IP、SSRF、redirect、exact-origin credential、permit、重试和响应预算；Browser 每个事件也必须进入该边界。
- Collector 持有 Transfer；Acquisition 持有 PDF/identity/version verdict 与 Candidate receipt；Literature 持有正式资产关系、identity 和 current facts；Storage 只执行命令。
- Candidate、job、attempt、event 和 ACK 是运行或交接事实，不构成第二文献库，不决定 Literature current facts。
- 文件系统保存字节，Catalog 保存规范相对引用、hash、关系和 provenance；资产 create-if-absent/no-clobber，跨 FS/SQLite 通过 receipt 与对账恢复，不虚构单一原子事务。
- Configuration 唯一管理普通配置和凭据 grant；secret 不进入模型、DTO、URL、日志、事件、数据库、证据或 package。
- 页面观察以版本、预算和 loading 状态稳定，不使用 `networkidle` 作为完成条件；Agent 每次只消费当前 Observation 并至多执行一个封闭动作。
- v1/v2 schema 显式隔离，迁移只在副本；Python 入口在授权切换前保留；真实外部和用户资料默认不访问。

## 影响矩阵

| 方面 | 预期变化 | owner 与控制 |
| --- | --- | --- |
| 运行时 | 增加 Node/TS、Browser、SQLite/PDF 运行组合 | Block 01 选择，02 组装，06 平台安装 |
| 公共合同 | 增加 Browser、Workbench、Candidate、execution/service DTO | Block 01 追踪；长期变化进入 ADR |
| 数据/schema | 保持 v1 文献事实，副本增加 v2 运行表 | Block 02 v1 repositories，05 显式迁移/回滚 |
| 文件资产 | 新增 transfer/Candidate handoff，正式资产仍不可变 | Block 02 FileStore，03 Candidate，04 Literature publication |
| 配置/凭据 | TS 读取/发布既有语义并提供 exact-origin grant | Block 02 owner，04 用户流程，06 安全审查 |
| Browser/Web | 新增唯一 Host、画面、输入和本地工作台 | Block 03，Block 05 接入持久服务 |
| 服务/CLI | 新增认证 HTTP/WS 和 daemon 协调 | Block 04 业务入口，05 服务 owner |
| 依赖/打包 | 增加受选择约束的 JS/native/browser/pdf 资源 | Block 01/02 锁定，06 构建与包内容核对 |
| 文档/发布 | 更新安装、配置、服务、迁移、回滚和切换说明 | Block 06；发布仍需授权 |

## 风险与转化信号

- inventory 无 consumer/Task/test/evidence，或发现活动能力无 owner：停在 Block 01，补盘点和计划，不进入实现。
- runtime spike 无法支持 Browser Network、文件安全、SQLite 或 PDF 关键边界：回到设计/ADR 或调整支持矩阵。
- v1 bytes/hash/schema/query 差异：阻断下游，回到 contracts/repository owner，不更新 golden 迁就实现。
- Browser 绕过 Network、使用任意动作、依赖 `networkidle`、丢 transfer 或迟到动作执行：回到 Block 03。
- Candidate 写 Literature current facts、双 owner、跨 FS/DB 误称原子：回到 Block 03/04 的 publication 边界。
- v2 隐式升级、恢复重放不安全动作、认证旁路或无界队列：回到 Block 05。
- package 缺资源、平台未跑、恢复失败、安全 finding 或 Full 未通过：Block 06 readiness 必须为 not-ready。
- 需要真实外部、真实数据、Git、发布、切换、删除或退役：停在授权门，向用户提交精确可审阅动作。

## 验证与证据策略

每个 Task 执行“最小失败复现/直接测试 → 相关静态检查 → 当前切片 diff/合同审查 → 脱敏证据 → checkbox”。
块退出再运行适用 `pnpm quick/test/full` 和 Python 回归；最终 Block 运行实际 package、平台、旅程、恢复、安全与 R5。
命令和层级见[验收矩阵](verification-matrix.md)。

证据写入 `migration/evidence/<owner-area>/`，至少记录 baseline、工作树范围、命令、版本、平台、输入、退出码、
pass/fail/skip、hash、外部访问状态、残余限制和恢复点。历史命令摘要、目录存在、测试总数或父 Task 不能代替
当前行为证据；不存在的拟新增测试必须先实现再运行。

本轮为文档-only 修复，只执行 Markdown 结构、链接、Task/台账、依赖、状态、命名和 diff 检查，不运行 TS/Python 测试。

## 授权门

本轮授权仅覆盖计划文档修复。后续开始实现需要用户的新指令；并行实施还需明确具体范围。读取/迁移真实用户
Catalog、Profile、Cookie、配置或凭据，访问真实 Provider/LLM/MinerU/出版社，真实数据迁移，commit/amend/rebase/
push/PR，发布、部署、生产切换、删除或 Python 退役均需要精确授权。

`CUTOVER-AUTHORIZATION` 只记录 HUMAN GATE 的实际决定。工程 Task、R5 和授权材料必须先完成，授权不能作为
实现通过的替代证据，也不能从“继续”“完成计划”等一般表达推断生产或发布许可。

## 执行方式与集成点

Primary 串行执行，每次只推进一个最小能力切片：读取 Task 与真相源 → 核实调用方/受保护改动 → 先建立直接
失败证据 → 实现 → 直接验证 → diff/语义审查 → 记录证据 → 更新 Task。并行默认关闭。

集成点依次为：Block 01 `BASELINE-ACCEPTANCE`；Block 02 `RUNTIME-FOUNDATION-ACCEPTANCE`；Block 03
`BROWSER-ACQUISITION-ACCEPTANCE`；Block 04 业务 R3；Block 05 `PERSISTENT-SERVICE-ACCEPTANCE`；Block 06 R5。
公共合同、owner、schema、安全、支持平台或授权事实变化时，先更新真相源与受影响计划，再继续依赖项。

## 执行审查

| Gate | 时点与必查内容 | 未通过处理 |
| --- | --- | --- |
| R0 Plan readiness | 目标、189 Tasks、真相源、依赖、owner、验收矩阵、恢复和授权是否自包含 | 修计划；本轮停在此门后，不开始实现 |
| R1 Block entry | 前置退出、受保护工作、测试入口、外部授权和运行条件 | Block 保持 Pending/In progress，回到前置 Task |
| R2 Slice review | 行为结果、错误路径、producer/consumer、数据、安全、测试、文档和证据 | ordinary 当场修；material/blocking 路由回 owner |
| R3 Block exit | 全部 Tasks、直接测试、适用门禁、下游合同、恢复点 | 不关闭 Block，不向下游交接 |
| R4 Integration | 唯一对象图、Network/Browser/Storage、Candidate/Literature、v1/v2、服务恢复 | 回到产生冲突的块，不加长期旁路 |
| R5 Final delivery | 原始目标、Full、package、平台、旅程、恢复、安全、文档、风险和授权包 | readiness 标为 not-ready，finding 闭合后重审 |

Primary 负责全部集成结论。公共合同、持久数据、安全、迁移或最终切换应在执行时安排独立 reviewer；该安排不等于
并行实施授权。审查 finding 写入对应 Task 证据或正式 review artifact。

## 进度规则

- Task 只有实现、直接测试、必要文档、证据和切片审查都成立才勾选；新验收使旧证据不足时必须撤回勾选。
- Block 只有全部 Task、退出条件与 R3（适用时 R4）通过才标 `Completed`；根状态从块文件汇总。
- Plan 只有全局验收、Block 06 R5、最终交接和授权状态准确记录后才可结束；授权外部动作尚未执行时不得写成已切换。
- `task-ledger.md` 只做索引，不保存 checkbox/状态；`verification-matrix.md` 保存场景状态但不替代 owner Task。
- 状态语义遵循[上级计划规范](../README.md#5-task-与状态语义)。

## 恢复与续作协议

跨会话先读本 README、当前块、对应 Task、`git status --short`、适用 truth source、验收矩阵行和已有证据。
当前执行暂停；收到新的实现指令后从 `INVENTORY-MODULES` 开始，依次完成 Block 01，不能跳到 Browser 或沿用
旧的 Block 01/02 完成声明。

失败时保留最小合成输入和脱敏诊断，停止勾选依赖 Task；先复现、路由回 owner、修复并重验，再从最近成功
Task 继续。工作树未知改动一律保护，不 reset/clean/checkout/格式化覆盖。跨会话总结必须写明最后通过 Task、
下一 Task、未运行检查、授权状态和未解决 finding。

## 计划变更记录

| 日期 | 变化 | 原因与影响 |
| --- | --- | --- |
| 2026-09-09 | 建立最初五块、111 Task 的迁移计划 | 提供了基础执行骨架，但任务覆盖和完成状态随后被证明不足 |
| 2026-09-09 | 撤回 Block 01/02 的完成声明并新增 inventory/spike/repository/acceptance Task | 原 inventory 无完整追踪，环境记录与局部测试不能证明块退出 |
| 2026-09-09 | 将 Block 03 扩为 43 个行为 Task | 补齐工作台、逐事件 admission、Action Executor、输入、传输形态、drain、policy、PDF 证据、version 与端到端验收 |
| 2026-09-09 | 将正式资产发布移到 Block 04 Literature owner | Candidate 只保存候选与 receipt，避免 Acquisition 越权写 current facts |
| 2026-09-09 | 从 Block 04 拆出 Block 05 持久服务，最终验证顺延为 Block 06 | 业务 parity、运行持久化和发布验收拥有不同结果、风险和恢复点 |
| 2026-09-09 | 最终验证拆为 24 个独立门并建立语义验收矩阵 | TS/Python 质量、包、平台、旅程、恢复、性能、背压、安全、文档和授权不能由五个宽泛 Task 汇总勾选 |
| 2026-09-09 | 明确计划修复后停止执行 | 遵循用户本轮授权，当前恢复点回到 Block 01 首个未闭环清单 Task |

## 最终交接

计划执行完成时，应交付：逐 Task 与场景证据、最终 TS/Python Full、实际产物及 hash、支持平台与安装结果、
完整离线旅程、数据/Profile 恢复记录、安全/性能/背压结果、现场验证状态、同步文档、Python disposition、
readiness/R5 报告和精确授权决定。

当前只完成计划文档纠偏。实现、测试、打包、真实外部验证、数据迁移、Git、发布、切换和 Python 退役均未在
本轮执行；下一会话必须从 Block 01 恢复，不能把本轮文档完成写成迁移完成。
