# 工作审视报告：TypeScript Browser Workbench 活动计划纠偏

日期：2026-09-09

审查者：Primary

范围：活动计划 Markdown 与项目真相源链接；历史研究档案只用于本轮差异审计，不作为执行依赖

## 原定目标

修复活动计划，使下一位执行者无需依赖历史研究档案即可知道每个 Task 的具体结果、owner、依赖、验收、直接测试、
证据和恢复点；补齐旧计划相对于目标能力的遗漏；撤回证据不足的完成声明；禁止以 `m4`、阶段、步骤、计划顺序或
Task 编号命名测试。修复完成后停在实现执行前。

## 完成情况

- [x] 已将计划从 5 个 Block、111 个 Task 修订为 6 个 Block、189 个具体 Task。
- [x] 已撤回 Block 01/02 的块级完成状态；Block 03 在新验收下全部未勾选；Block 04–06 保持 Pending。
- [x] 已补齐 inventory 追踪、Browser/文件/PDF/runtime spike、v1 repositories、Browser 工作台、逐事件 Network、
  Action Executor、Screen、输入、完整 Transfer、Policy、PDF 文本证据、version、端到端验收等遗漏。
- [x] 已把 Candidate durable handoff 与 Literature 正式 Asset/LiteratureAsset/current facts 写入分开。
- [x] 已把 v2 schema、repositories、queue、恢复、认证服务和 daemon 从业务块拆为独立 Block 05。
- [x] 已把最终质量、CI、包、平台、旅程、数据/Profile 恢复、性能、背压、安全、文档、retirement、drill、readiness、
  R5 和授权拆为 Block 06 的独立 Task。
- [x] 已建立当前计划自己的语义验收矩阵，每行包含结果、owner、直接测试、证据、状态、未运行原因和恢复点。
- [x] 已同步根 README、6 个块文件、任务索引、执行顺序、跨块不变量、决策记录和本审视报告。
- [x] 已检查 6 个块的 14 个必需组件、Task heading/checkbox/status、稳定 ID、索引、Markdown 本地链接/anchor、
  测试行为命名、旧文件链接和历史档案执行依赖；结构检查为 0 errors。
- [ ] 未执行任何源码实现、TS/Python 测试、build、Browser、外部访问、数据迁移、Git 或发布动作；这是用户要求的停止点。

## 发现的问题

| 严重程度 | 问题描述 | 根本原因 | 改进与当前处置 |
| --- | --- | --- | --- |
| 必须改正 | 原 111 个 Task 形式上一一入账，但 Block 01/02 仍用不完整 inventory、环境发现和局部旧测试支持 Completed | 把记录存在和局部成功当成完整验收，没有按新增语义重新核对证据 | Block 01/02 重开；新增 `BASELINE-ACCEPTANCE`、`RUNTIME-FOUNDATION-ACCEPTANCE`；恢复点回到 `INVENTORY-MODULES` |
| 必须改正 | Block 03 只有 20 个 Task，Observation 要求页面 settle，未覆盖慢 viewer、真实 Web、完整动作、popup/frame、POST、Range/ETag、Service Worker、drain 等 | 一个 checkbox 汇总多个可独立失败生命周期，且把 `networkidle` 类完成信号误作稳定条件 | 扩为 43 个行为 Task；明确 `partial + loading` 和不依赖 `networkidle`；为每种关键失败建立测试/证据 owner |
| 必须改正 | `BROWSER-CONTROL` 指向不存在的 Web 测试，`EXECUTION-LOOP` 的直接测试不存在却被旧证据概括 | 未核对实际测试路径，用相邻测试或总数代替直接验证 | 控制测试区分已有 server 与拟新增 Web；execution loop 明确“拟新增”且保持未完成 |
| 必须改正 | `CANDIDATE-PUBLICATION` 同时写候选和正式文献事实，形成 Acquisition 对 Literature 的反向依赖 | 没有把 durable handoff 与业务接纳两个 owner 分开 | Block 03 只写 Candidate/evidence/receipt；Block 04 新增 `LITERATURE-ASSET-PUBLICATION` 作为正式写入 owner |
| 必须改正 | Block 04 同时承担 11 个 Metadata adapter、业务、v2 schema、恢复和服务 API | 按文件/时间顺序分块，没有按结果、风险、数据 owner 与恢复点分块 | Block 04 保留 36 个业务 Task；新增 Block 05 的 21 个持久服务 Task |
| 必须改正 | 原最终 Block 只有 5 个 Task，package、平台、旅程、恢复、性能、安全、文档和授权会被汇总勾选 | 将多个交付门压成报告型父任务，无法定位失败 owner | Block 06 拆为 24 个 Task；父汇合 Task 只在全部子结果有证据后完成 |
| 必须改正 | 原验收矩阵只有 L0–L5 层级，没有语义场景、owner、直接测试、证据和恢复点 | 把验证方法当作验收覆盖，没有建立能力追踪 | 新矩阵建立 38 个当前行为场景，逐行注明状态和本轮未运行原因 |
| 应当改正 | 根 README、执行顺序、台账、决策记录与块文件保留不同状态和恢复点 | 控制面在增删 Task 后未做机械一致性检查 | 重写控制面；台账从块内 Task 生成；结构脚本确认 189/189、0 duplicate、0 missing link |
| 应当改正 | 计划曾把历史研究材料中的状态和编号继续带入活动执行语义 | 将差异输入误当长期真相源或运行台账 | 活动计划不出现该档案路径依赖；Task、场景、证据与恢复均由当前计划自行定义 |
| 应当改正 | 测试命名虽然未发现 `m4`，但旧计划没有把禁止顺序命名贯穿新增任务 | 命名约束只写在局部说明，新增 Task 容易回退为计划编号命名 | 根计划、每个新块、台账和验收矩阵都明确行为命名；检查未发现顺序型测试名 |

## 做得好的地方

- 原计划已有稳定 Task ID、块模板、行为测试名和串行执行纪律，可保留并扩展。
- 合成 fixture、loopback、no-clobber、exact-origin、唯一 Browser/Network/Application owner 和真实操作授权边界方向正确。
- 旧实现与证据没有被回滚；本次只撤回无法由当前验收支持的计划完成结论，避免破坏用户工作。

## 文档验证

本轮运行了只读/文档检查：

- 6 个 Block，Task 数分别为 26、39、43、36、21、24，总计 189；
- `task-ledger.md` 含 189 个唯一 ID，与块内 heading/checkbox 顺序完全一致；
- 每个块均有计划规范要求的 14 个二级组件；checkbox 与 Task 状态无冲突；
- 活动 Markdown 本地链接与 Task anchor 可解析，未发现旧最终块文件链接；
- 活动计划未出现历史档案目录的直接依赖；
- 测试路径未发现 `m4`、phase、step、block、Task 顺序型命名；
- 未运行 TS/Python 测试或 Harness，因此不对实现质量或迁移完成作结论。

## 下次重点关注

- 收到新的执行指令后，从 `INVENTORY-MODULES` 开始补齐 235 个模块的 consumer、owner、Task、直接测试、证据和 disposition。
- 在任何新实现前关闭 Browser runtime、文件安全、PDF engine、threat model、release matrix、runtime selection 与 ADR/合同状态。
- 每个 Task 用自己的直接测试和当前证据关闭；不能再用目录存在、父 Task、历史测试总数或相邻测试代替。
- Candidate/Literature、v1/v2、Browser/Network、Application/Service owner 是后续审查重点。

跨会话继续时应把本报告与根 README 作为上下文，先核实工作树和当前恢复点；本轮已经按用户要求停在执行前。
