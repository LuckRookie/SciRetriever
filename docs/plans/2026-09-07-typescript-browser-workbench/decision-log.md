# 计划决策记录

本文件记录会改变活动计划范围、依赖、owner、数据、安全或退出条件的选择。它不替代 requirement 或 Accepted ADR；
长期设计必须由对应真相源批准。本文件中的 `Accepted for planning` 只表示已用于组织当前执行计划。

## 记录模板

```text
日期：
问题：
当前事实：
采用选择：
影响：
关联 Task / 验收：
回退或转化条件：
状态：Proposed | Accepted for planning | Rejected | Superseded
```

## 当前有效记录

### 活动计划必须自包含

日期：2026-09-09

问题：历史研究材料可用于差异审计，但活动计划不能要求后续执行者读取它才能知道任务、验收、状态或恢复点。

当前事实：项目计划规范要求根 README、块文件、owner Task、直接测试与证据形成独立执行闭环；用户明确指出旧计划
仍依赖参考资料且 Task 过宽。

采用选择：6 个块文件直接定义 189 个 Task 的动作、依赖、验收、测试与证据；任务索引只做导航；验收矩阵使用
当前计划自己的行为场景。历史研究档案排除在执行依赖、验收、状态、证据和恢复入口之外。

影响：只改变计划控制面，不改变产品、源码、数据、依赖或发布状态。

关联 Task / 验收：全部 Block；`inventory-complete-traceability`；`task-ledger.md` 与块内 ID 一致性检查。

回退或转化条件：若任一 Task 仍需读取档案才能实施或验收，R0 失败，继续修计划并保持执行暂停。

状态：Accepted for planning

### 旧完成声明按新增验收重开

日期：2026-09-09

问题：原计划把 environment inventory、局部实现、旧测试总数和不存在的测试路径作为 Block 01/02 或 Browser 切片完成依据。

当前事实：inventory 仍缺 consumer/Task/test/evidence；运行时组合未完成 spike；文件 stage 曾引用不存在测试；Web 前端、
execution loop 测试、完整 transfer/policy/service 证据缺失。旧命令结果不能证明当前工作树。

采用选择：Block 01、02 标为 `In progress`，只保留仍有明确 Task 证据的 checkbox；Block 03 的全部任务在新验收下保持
未勾选。恢复点回到 `INVENTORY-MODULES`，随后按真实依赖重新验收。

影响：不回滚已有实现，不宣布已有实现错误；仅撤回证据不足的计划完成结论。

关联 Task / 验收：`BASELINE-ACCEPTANCE`、`RUNTIME-FOUNDATION-ACCEPTANCE`、`BROWSER-ACQUISITION-ACCEPTANCE`。

回退或转化条件：只有直接测试、必要文档、证据和块退出审查重新闭环才能恢复完成状态。

状态：Accepted for planning

### 运行时选择不能由环境发现代替

日期：2026-09-09

问题：Node、缓存 Chromium、系统 PDF 命令或某个 SQLite 模块存在，不等于 Browser/Profile/Screen、跨进程文件安全、
SQLite Worker、PDF 资源隔离与 package 平台组合受支持。

当前事实：当前材料对 Chromium 与 SQLite binding 的可用性描述存在不同口径；Block 01 尚无完整组合 spike 和发布矩阵。

采用选择：保留环境记录为输入，新增 Browser runtime、平台安全、PDF engine、threat model、release matrix 和
`RUNTIME-SELECTION` Task；在 `BASELINE-ACCEPTANCE` 前不将任何组合写成支持结论。

影响：可能改变后续依赖、package 和支持平台；长期选择如与 Accepted ADR 冲突，必须返回 ADR/设计处理。

关联 Task / 验收：`BROWSER-RUNTIME-SPIKE`、`PLATFORM-SAFETY-SPIKE`、`PDF-ENGINE-SPIKE`、`PLATFORM-RELEASE-MATRIX`、
`RUNTIME-SELECTION`、`runtime-supported-combination`。

回退或转化条件：关键安全边界不可实现或 ADR 0024 的接受状态/内容无法与用户授权及其它真相源一致时，停止迁移实现并回到设计决策。

状态：Proposed；等待 Block 01 实证与合同审查

### Candidate 与正式 Literature 资产分离

日期：2026-09-09

问题：原 `CANDIDATE-PUBLICATION` 同时发布候选、主资产关系和 current facts，使 Acquisition 反向依赖尚未实现的 Literature 身份业务。

当前事实：项目真相源要求 Literature 拥有身份/current facts，Storage 不做业务决定；Candidate 必须独立于 page、screen、
Agent 和客户端生命周期，但 Candidate 本身不等于已接纳文献资产。

采用选择：Block 03 只发布 durable Candidate、identity/version evidence 与可重放 receipt；Block 04 新增
`LITERATURE-ASSET-PUBLICATION`，由 Literature owner 在身份、版本和 CAS 前置成立后写 Asset/LiteratureAsset/primary-pdf/current facts。

影响：消除 Acquisition 对 Literature current facts 的写入权；文件与 SQLite 继续通过 receipt/对账恢复，不宣称跨系统单一事务。

关联 Task / 验收：`CANDIDATE-PUBLICATION`、`LITERATURE-ASSET-PUBLICATION`、`candidate-durable-handoff`、`literature-asset-owner`。

回退或转化条件：若权威设计要求不同 owner，先更新 requirement/ADR/design 并重写两个 Task，不在实现中双写。

状态：Accepted for planning；依据现有事实所有权合同

### Browser 观察、动作与传输按独立行为验收

日期：2026-09-09

问题：原 Browser Task 把工作台、输入、动作、response/download、popup/frame、Range/ETag、Service Worker、drain 和
Agent policy 合并，单个 checkbox 无法证明所有失败路径。

当前事实：现有 Web 入口、Action 类型、Browser event admission、transfer collector 和 execution policy 只覆盖部分行为；
页面长连接使 `networkidle` 不能作为稳定完成条件。

采用选择：Block 03 拆为 43 个行为 Task；Observation 在预算耗尽时返回 `partial + loading`；Action Executor 使用封闭集合；
每个 Browser 事件经过 Network；Transfer 全形态、归属、去重和 drain 独立验收；Web 前端必须有自己的直接测试。

影响：增加直接测试与证据，禁止 server 测试替代 Web 旅程；不会因新增 Task 自动删除局部实现。

关联 Task / 验收：Block 03 全部 Screen/Workbench/Transfer/Policy/Execution Task 及验收矩阵对应场景。

回退或转化条件：若 browser runtime 无法暴露某事件，应记录 unsupported 与产品影响并回到 Block 01/架构决策，不用旁路网络或猜测归属。

状态：Accepted for planning

### 持久服务从业务迁移中拆出

日期：2026-09-09

问题：原 Block 04 同时负责 11 个 Metadata adapter、Literature、Parsing/Analysis、CLI、v2 schema、恢复和服务 API，
owner、进入条件、故障恢复与块退出不能独立判断。

当前事实：业务 parity、运行事实持久化和发布准备有不同 truth source、数据风险和验证方式。

采用选择：Block 04 只负责业务与正式资产发布；Block 05 独立负责 schema backup/migrate/rollback、repositories、queue、
调度、assistance、crash recovery、认证 HTTP/WS、CLI/daemon 和 service journey；最终验证顺延为 Block 06。

影响：块数从 5 增至 6，Task 索引和所有跨块链接同步更新；v2 只在副本中产生。

关联 Task / 验收：Block 04–06；`execution-restart-recovery`、`service-authentication`、`offline-install-journey`。

回退或转化条件：若业务 Application 不能独立于 daemon 调用，回到对象图设计，不能让 Entry 或 Service 成为业务事实 owner。

状态：Accepted for planning

### 最终授权与工程完成分离

日期：2026-09-09

问题：把 `CUTOVER-AUTHORIZATION` 与实现、测试和 release readiness 混在一个完成勾选中，会让用户许可看起来像工程验收。

当前事实：仓库规范要求具体发布/生产/Git/真实数据动作获得明确授权；用户当前要求在计划修复后停止。

采用选择：Block 06 先完成质量、CI、package、平台、旅程、恢复、安全、文档、retirement、drill、readiness 与 R5，
再提交精确授权包。`CUTOVER-AUTHORIZATION` 只记录 HUMAN GATE 决定，不自动执行动作或证明实现通过。

影响：当前执行在 R0 后暂停；生产切换、发布、Git 写入、真实迁移和 Python 退役全部保持未执行。

关联 Task / 验收：Block 06 全部 Task，尤其 `READINESS-REPORT`、`CUTOVER-REVIEW`、`CUTOVER-AUTHORIZATION`。

回退或转化条件：授权范围变化时只更新具体外部动作，不放宽工程验收或其他授权门。

状态：Accepted for planning

## 历史记录处置

早期记录中关于 Block 01/02 已退出、Browser 从 `BROWSER-HOST` 继续、旧 TS/Python Full 测试数量和工具链/配置/
Network/FileStore/SQLite/Agents 的整体完成结论，均被“旧完成声明按新增验收重开”替代。底层实现和原始脱敏证据
继续作为后续调查输入；只有所属新 Task 重新验收后才可恢复 checkbox，不再把历史摘要当当前完成依据。
