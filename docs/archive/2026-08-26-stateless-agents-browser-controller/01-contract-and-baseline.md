# Block 01：合同与基线收敛

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | ABC01–ABC07 |
| 前置块 | 无 |
| 下游块 | Block 02、Block 04 |
| 恢复点 | baseline revision 与当前受保护文档 diff |

## 1. 块结果

Accepted ADR、requirements、design 与 technical 文档形成唯一一致的目标合同：Agents 是无状态单次模型运行时；Analysis/Acquisition 拥有 workflow；Network 执行动作；Rules/Agent 是作业级二选一；Challenge 使用统一页面模型；不存在人为 Browser 作业预算。

## 2. 进入条件

- 用户已经批准目标设计和无兼容层迁移；
- baseline revision、现有未提交文档和旧实现位置已经核实；
- 不读取真实凭据、Profile 或 Provider；
- 计划位置和结构先按当前用户要求完成迁移。

## 3. 责任与改动面

- Owner：Primary Agent；
- 文档：ADR 0015/0016/0017、ADR index、requirements、principles、design、technical 总索引与 Agents/Analysis/Acquisition/Network/Configuration/Entry/Logging 技术文档；
- 受保护工作：任务开始时已有 14 份未提交架构文档修改；只在其基础上收敛，不回滚其它有效内容；
- 消费方：后续 Agents、Analysis、Acquisition、Network、Configuration、Bootstrap 实现块。

## 4. 需要保持的行为

- Public → Authorized API → Controlled Browser 风险顺序；
- Publisher lane 组间并行、同组串行；
- CloakBrowser 固定 Profile/process/context 与 Network guard；
- 统一 PDF 验收、不可变发布、数据/provenance 边界；
- 目标文档描述“应当实现”，README/指南只描述当前行为。

## 5. Tasks

- [x] **ABC01 — 固定基线和受保护改动。** 记录 baseline revision、当前 14 份未提交架构文档、旧 session/预算/fallback 实现与测试入口。
  - 验收：计划根 README 的“事实”可定位这些差距，`git status` 中用户改动未被回滚。

- [x] **ABC02 — 迁移计划治理。** 删除 `.omo/`，把活动计划迁入 `docs/plans/`，建立一个计划一个目录、README 控制面和编号分块执行面的规范。
  - 验收：仓库不存在 `.omo`；活动文档不再指定 `.omo/plans`；当前计划具备 README 与 8 个块文件。

- [x] **ABC03 — 收敛 ADR 0017。** 将 Agents 定义为无状态单次模型运行时，把业务控制器、工具执行和事实写入明确留在消费模块。
  - 依赖：ABC01。
  - 验收：`AgentSession`、多 turn session、累计 job budget、通用 Agent workflow 或 consumer-supplied provider/model 只可出现在历史、删除或明确不采用的语境。

- [x] **ABC04 — 收敛 ADR 0015/0016。** 固化作业级 `rules | agent` 二选一和共享 Browser runtime；Challenge 是可处理页面状态而非专属子系统或默认终态。
  - 依赖：ABC03。
  - 验收：Rules→Agent fallback、challenge 专属 Observation/target/controller/retry/turn budget 或 interaction 状态族只可出现在历史、删除或明确不采用的语境。

- [x] **ABC05 — 同步 requirements、principles 与 design。** 更新可观察行为、模块责任、依赖方向、状态所有权和三级 Acquisition 顺序。
  - 依赖：ABC03、ABC04。
  - 验收：同一事实只有一个权威位置；模块表与对象图不存在相互冲突的 owner。

- [x] **ABC06 — 同步 technical 文档。** 对齐 Agents、Analysis、Acquisition、Network、Configuration、Entry、Logging 的精确接口、对象图、状态和失败语义。
  - 依赖：ABC05。
  - 验收：目标包结构、调用链、配置字段、动作集合、日志和验收能够直接指导 Block 02–07。

- [x] **ABC07 — 固定非目标和合同变化门。** 明确不加入登录、机构选择、MFA、文本输入、文件上传、任意 URL/JavaScript、长期 memory、Agent workflow 持久化或新的安全扩张。
  - 依赖：ABC05。
  - 验收：ADR 的“不采用/需要新 ADR”与计划非目标一致；未来扩张不能从通用 action seam 隐式获得。

## 6. 执行方式与集成点

本块串行执行：ABC03 固定 Agents owner，ABC04 固定 Browser/controller 状态，ABC05 汇总产品与模块责任，ABC06 展开技术合同，ABC07 做范围封口。每个文档切片先检查现有未提交 diff，再用精确术语搜索和链接检查收口；不同时修改源码。

本块的集成点是 R0 Plan readiness：Block 01 通过后，目标合同与计划必须足以让 Block 02/04 不再自行推导 owner、状态或动作集合。

## 7. 审查门

- R1：baseline、14 份受保护文档和真相源链仍与当前工作树一致；
- R2：每项文档修改检查是否误写 current behavior、复制真相源或遗留旧 session/fallback/challenge 专属合同；
- R3/R0：requirements、ADR、design、technical、计划及非目标互相一致，链接/diff 检查通过；
- blocking/material finding 返回 ABC03–ABC05 或用户决策，不进入实现块。

## 8. 接口、数据与依赖影响

- 本块只改变目标文档和计划治理，不修改运行时代码、配置或数据；
- 不迁移数据库、资产、凭据或用户 Profile；
- 不新增依赖；
- 后续内部 API 的破坏性切换由 ADR 明确授权，不在本块提前实现兼容层。

## 9. 验证与证据

- `git diff --check` 覆盖本块文档；
- 检查全部相对链接目标存在；
- `rg` 检查 session、累计预算、fallback 和 challenge 专属词汇只在明确否定/历史语境出现；
- 对照 requirements/ADR/design/technical 做 owner、状态和动作集合语义审查；
- 文档-only 本块不要求 Python Harness。

## 10. 退出条件

- ABC01–ABC07 全部勾选；
- 所有目标文档对 Block 02/04 的接口没有冲突；
- 文档 diff/链接/术语检查通过；
- 没有需要用户重新决定的产品或安全扩张。

## 11. 完成证据

- ABC01：`git status --short --branch` 核实 baseline 为 `b1322d3`，14 份架构文档为受保护修改；旧符号与直接测试由 `rg` 建立索引。
- ABC02：2026-08-26 核实 `.omo` 为仓库根普通目录后删除；活动规范迁到 `docs/plans/README.md`，当前计划拆为独立目录。
- ABC03：ADR 0017 与 Agents/Analysis 技术文档固定 `AgentRuntime.readiness/execute`、`AgentCall`、role binding、单次 structured/tool result；业务 workflow、工具执行、事实写入和跨调用状态均留在消费者。
- ABC04：ADR 0015/0016 与 Acquisition/Network 技术文档固定作业级 `rules | agent` 互斥选择、共享 runtime、统一 `BrowserObservation`、六种动作、三维状态和自然终态；删除 Challenge 专属生命周期和整篇 Browser 作业硬预算。
- ABC05：requirements、principles 与 design 已统一产品行为、模块 owner 和依赖方向；R2 扫描发现并修正 requirements 中一处遗留的 Rules→Agent 顺序描述。
- ABC06：technical 总索引及 Agents、Analysis、Acquisition、Network、Configuration、Entry、Logging 精确合同已同步；附带修正 Model 技术文档中遗留的 `challenge lifecycle` 描述。
- ABC07：ADR“不采用”、requirements、技术合同和计划非目标共同封闭登录、机构选择、MFA、文本输入、文件上传、任意 URL/selector/JavaScript、长期 memory、外部 solver/token 注入和 controller 自动切换。
- 文档证据：`git diff --check` 覆盖 requirements、principles、design、ADR、technical 索引与全部 technical 子文档，退出 0；精确 `rg` 的旧符号命中均处于历史、删除或明确否定语境；相对链接检查共检查 425 个目标，缺失 0。
- R0 Plan readiness：2026-08-26 通过。ABC01–ABC07、58 Tasks、串行依赖、风险、验证、恢复和授权门一致；计划级并行仍未获人类授权并保持关闭。文档-only 本块未运行 Python Harness，符合 HARNESS 文档规则。

## 12. 失败与恢复

- 若文档揭示公开配置/数据兼容性必须迁移，停止进入实现并请求用户决定；
- 若目标文档之间无法一致解释 owner，回到 ABC03–ABC05，不在源码中猜测；
- 恢复时以 baseline + 当前 14 份文档 diff 为保护边界，不使用 Git 回退覆盖已有工作。

## 13. 下游交接

Block 02 可以依赖唯一 `AgentRuntime.execute/readiness` 合同；Block 04 可以依赖统一 Browser Observation/action 的责任划分。下游不能重新引入本块明确删除的 session、作业硬预算、fallback 或 challenge 专属类型。
