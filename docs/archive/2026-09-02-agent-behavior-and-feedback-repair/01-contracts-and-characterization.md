# Block 1：合同、ADR 与行为刻画

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed（2026-09-03） |
| Task 范围 | `ARC01`-`ARC06` |
| 前置块 | 无 |
| 下游块 | Block 2、3、4 |
| 恢复点 | ADR amendment 与 transition/failure 行为矩阵最后一次通过审查的版本 |

## 块结果

形成一套能被 Network、Acquisition、Analysis、Agents 和测试共同消费的稳定设计合同：明确 action execution 与 settle 的区别、Candidate 生命周期、精确绑定与稳定语义 fingerprint 的区别、transition graph 的停止证明、终态原因优先级和 controller safety fuse。现有错误行为被目标测试准确刻画，但不作为兼容行为保留。

## 进入条件

- 用户明确授权按本计划开始源码/ADR 实施；当前“写入计划”授权本身不满足该条件；
- 重新读取 ADR 0017、ADR 0019 与目标技术文档，确认自计划创建后没有新的 Accepted 决定；
- 对 baseline revision 之后的目标文件逐个检查 diff，记录用户已有修改并确定本计划可以安全编辑的片段；
- R0 Plan readiness 通过，safety fuse 的性质和 model identity 补证任务未被误写成当前已实现行为。

## 责任与改动面

Primary owner 负责：

- `docs/architecture/decisions/0017-shared-agents-and-controlled-browser-agent.md` 的 amendment；
- `src/sciretriever/network/browser_control.py` 中 Network/Acquisition 相邻的 Observation、action binding、receipt/transition 类型；
- `src/sciretriever/acquisition/browser_control.py` 中 controller result/reason 合同；
- `src/sciretriever/agents/failures.py`、`analysis` failure 映射的影响分析，但本块不提前重写 Block 4 行为；
- `tests/test_browser_agent_control.py`、`tests/test_browser_agent_integration.py`、`tests/test_network_playwright_control.py` 和相关 contract tests 的 fixture/目标矩阵。

Network 生产 action/settle 事实，Acquisition 解释 progress 与业务终态；合同不得把 Playwright、CloakBrowser、Page、response 或 callback 私有类型带出 Network。

## 需要保持的行为

- `AgentRuntime` 仍然无状态、一次调用；Analysis 与 Browser 继续共享调用面但分别拥有业务 controller；
- Browser 仍只接受 `ClickElement / ClickPoint / ScrollSurface / GoBack / WaitForChange / Stop`；
- model decision 必须绑定 exact current Observation，model call 期间页面变化时旧 action 不执行；
- Rules 与 Agent 继续互斥，Challenge 仍只是 `page_state=CHALLENGE`，不建立专属 Agent 或第二套页面状态机；
- Public -> API -> Browser 顺序、Publisher profile、Network guard、capture/PDF 验收和用户取消保持；
- transition 与 history 只在当前 article flow 内存中存在，不进入数据库、Report provenance 或资产；
- 当前 Provider stream、reasoning、Model 配置和日志脱敏合同不因本块改变。

## Tasks

- [x] **ARC01 — 冻结现状证据与调用影响。** 建立从 `AgentBrowserController`、`BrowserAgentControlSession`、生产 Browser source/factory 到 Playwright/CloakBrowser executor 的调用图，并把现有错误行为对应到直接测试，不把 fake 的即时 Observation 切换当成生产 settle。
  - 依赖：无。
  - 验收：影响清单覆盖所有生产者、消费者、Bootstrap 组装和直接测试；能逐项解释 action receipt、第二次 observe、capture state、failure owner 的现状。
- [x] **ARC02 — 修订 ADR 0017。** 记录 execute/settle 分离、Candidate 中间态、exact/stable 两类 fingerprint、settled transition graph、终态 resolver 和非业务 safety fuse；明确这些是对“自然终态”的补充，不恢复用户可配置的 step/token budget。
  - 依赖：ARC01。
  - 验收：ADR 与 ADR 0019 不冲突；`controller-safety-limit` 被定义为系统 safety failure/action-required，不是 normal miss、`NoPrimaryPdf` 或 acquisition exhaustion。
- [x] **ARC03 — 固定 closed transition 与 terminal reason 合同。** 定义 `Stale / Settled / Captured / CandidateTimeout / Stopped / Cancelled / Failed` 的封闭中性结果，明确 receipt、settle evidence、Observation 和稳定失败证据的不变量；给 `BrowserAgentResult` 增加不会丢失的具体 stop/cycle/candidate/safety 原因。
  - 依赖：ARC02。
  - 验收：非法组合在构造时失败；`CANDIDATE` 不能构造成功 capture；`APPLIED` 不能单独证明 changed；consumer 不依赖 vendor 类型或异常文本。
- [x] **ARC04 — 分离安全绑定与稳定意图。** 保留 exact `execution_binding_fingerprint` 阻止 stale action，并设计 `stable_semantic_page_fingerprint` 与 `stable_action_intent_fingerprint(action, observation)` 用于 progress/cycle。
  - 依赖：ARC02。
  - 验收：revision、screenshot ID/bytes、短期 page/surface/element ID 和无意义 geometry 抖动不会改变 stable identity；origin/path、page state、可行动语义和关键结构变化会改变；两类 fingerprint 不能互换使用。
- [x] **ARC05 — 建立目标行为矩阵与反例 fixture。** 把异步 click、第一次 self-transition、重复 intent、`A -> B -> A`、Candidate 三终点、capture/Stop 竞争、specific/generic failure 竞争、stale action 和 safety fuse 写成可复用离线场景；替换固化错误行为的测试命名和断言。
  - 依赖：ARC03、ARC04。
  - 验收：每个场景明确“允许 dispatch 次数、模型调用次数、最终 transition/reason/failure、是否允许 exhaustion”；本块提交的纯合同/fixture 测试通过，后续行为测试在对应 Block 完成后转绿，不保留永久 skip/xfail。
- [x] **ARC06 — 完成合同审查与下游交接。** 对照 requirements、ADR、模块 owner、安全边界和当前 diff 审查 transition/failure API；锁定 Block 2-4 可依赖的名称、语义和迁移顺序。
  - 依赖：ARC01-ARC05。
  - 验收：无 blocking/material finding；旧 receipt-only 消费路径已列入删除清单，不设计双路径 compatibility layer。

## 执行方式与集成点

按 ARC01 -> ARC02 -> ARC03/ARC04 -> ARC05 -> ARC06 串行执行。ARC03 与 ARC04 都必须先在 ADR 语义下工作；若类型位置导致 Network 依赖 Acquisition 或 Agents 获得 Browser workflow，应返回设计，不以循环 import 或复制类型解决。

### Fingerprint 设计约束

建议但需由反例测试验证的稳定意图组成如下：

| Action | stable intent 使用 | 明确排除 |
| --- | --- | --- |
| ClickElement | surface/page semantic key、element role/name/state、位置区间 | element ID、revision、screenshot ID |
| ClickPoint | surface semantic key、相对 surface 的归一化坐标区间 | 原始 screenshot ID、像素 hash、绝对轻微抖动 |
| ScrollSurface | surface semantic key、方向与幅度区间 | surface ID、精确浮点 geometry |
| GoBack | action kind 与当前 history/page semantic class | page ID、revision |
| WaitForChange | action kind 与当前 semantic state | screenshot/revision |
| Stop | action kind 与封闭 reason class | 自由模型原文 |

不能仅靠把坐标四舍五入“猜”出正确阈值。必须用相邻目标、同一控件抖动和不同控件反例证明既不会无限制造新 intent，也不会误合并不同意图。

### Terminal resolver 设计约束

resolver 必须消费 typed evidence，而不是依赖 `facts.fail()` 调用顺序：

1. 已完成的真实 capture 先进入既有 PDF candidate 验收；Candidate 本身只等待，不参与成功优先级；
2. 若没有可接纳 capture，保留 cancellation 与具体 Network/Browser/Agent failure；
3. 具体 page terminal 或 challenge resource block 优先于 generic Agent Stop/cycle unresolved；
4. generic `no-download` 只能在没有更强证据时形成；
5. safety fuse 始终是 action-required/system safety result，绝不转成自动耗尽。

具体 code family 至少包括：

```text
acquisition-browser-challenge-unresolved-agent-stop
acquisition-browser-challenge-unresolved-cycle
acquisition-browser-challenge-candidate-timeout
acquisition-browser-challenge-resource-blocked
controller-safety-limit
```

## 审查门

- R1：确认实施授权、目标 diff owner 和 ADR 0017 amendment 范围；
- R2/ARC02：审查 safety fuse 是否改变产品业务终态、是否与 ADR 0019 SDK/外部 Agent 边界冲突；
- R2/ARC03-04：审查 closed variants、非法组合、依赖方向、安全绑定和语义稳定性；
- R2/ARC05：测试不得把 fake 即时切状态继续当 settle，也不得通过固定 sleep 证明异步行为；
- R3：合同测试、文档链接和下游 API 交接通过，无 compatibility branch。

任何以下情况阻断退出：ADR 未修订便实现 safety fuse；Candidate 仍能映射为 success；stable fingerprint 使用 screenshot ID/短期 ID；exact binding 被弱化；终态仍 first-wins；测试需要真实 Browser/Profile/Provider。

## 接口 / 数据 / 依赖影响

- 接口：内部 `BrowserAgentControlSession.execute`/receipt 合同和 `BrowserAgentResult` 预计破坏性调整；当前授权方向允许任务范围内无兼容层切换，但必须同步全部生产调用方和测试；
- 数据：无 Catalog、资产、provenance 或配置 schema 变化；
- 依赖：无新增依赖；
- 文档：ADR 0017 必改，technical/current docs 留在后续行为稳定后同步；
- 打包：公开包内容不新增 SDK/vendor 类型。

## 验证与证据

进入 Task 时按实际文件校准，至少执行：

```bash
uv run --frozen python -m unittest \
  tests.test_browser_agent_control \
  tests.test_browser_agent_integration \
  tests.test_network_playwright_control
uv run --frozen python -m unittest tests.test_agents_contracts
uv run --frozen ruff check \
  src/sciretriever/network/browser_control.py \
  src/sciretriever/acquisition/browser_control.py \
  tests/test_browser_agent_control.py \
  tests/test_browser_agent_integration.py \
  tests/test_network_playwright_control.py
git diff --check
```

本块允许在 TDD 过程中短暂出现目标行为红测，但退出时本块已提交的合同/fixture 测试必须通过；由 Block 2/3 拥有的行为断言必须明确登记，不能以永久 skip 留在主线。

## 退出条件

- ARC01-ARC06 全部完成；
- ADR 0017 amendment、closed transition、fingerprint 和 terminal reason 语义一致；
- 目标行为矩阵覆盖根计划验收中的全部 Browser 关键场景；
- 本块直接测试与 Ruff 通过；
- Block 2-4 不需要从实现细节猜测 receipt、settle、cycle、failure 或 safety fuse 的含义。

## 完成证据

- [ADR 0017](../../architecture/decisions/0017-shared-agents-and-controlled-browser-agent.md) 已修订为 execute/settle、Candidate 三终点、exact/stable fingerprint、transition graph、typed terminal resolver 与固定 32 次 model-decision safety fuse 的 Accepted 合同。
- `network/browser_control.py` 定义七种 closed transition；Network 使用自己已拥有的 `AccessFailure` 承载稳定、脱敏的失败证据，Acquisition 在边界显式转换为 Report `StableFailure`，未让 `network` 依赖业务报告模型。
- `execution_binding_fingerprint`、`stable_semantic_page_fingerprint`、`stable_action_intent_fingerprint` 已分离；旧 `observation_hash`、`semantic_page_fingerprint`、`action_fingerprint` 名称在 `src/` 与 `tests/` 中均不存在。
- characterization/合同矩阵覆盖 delayed action、first/repeated self edge、`A -> B -> A`、Candidate captured/cleared/timeout、capture/terminal 竞争、stale、specific failure 与 safety fuse；Network/Browser 相关集 `Ran 143 tests, OK (skipped=1)`，跳过项是显式本地 Cloak runtime opt-in 验收。
- 架构依赖门禁与 Browser controller 目标回归 38 项通过；Pyright 目标检查 0 error。最终审查无 blocking finding。

## 失败与恢复

若 ADR 审查证明 safety fuse 与自然终态方向冲突、stable fingerprint 无法在不暴露 vendor/页面正文的情况下成立，或类型放置破坏模块依赖，停止实现并记录最小反例，返回用户/架构决定。恢复时从最后通过的 ADR/合同版本和目标矩阵继续，不保留半套 receipt/transition 双路径。

## 下游交接

Block 2 可以依赖：Network 要生产的 closed transition、Candidate 生命周期、exact binding 与 settle 终点已经冻结。Block 3 可以依赖 stable state/intent 和 terminal reason 合同。Block 4 可以依赖稳定 failure 分层，但不得改变 Browser transition 语义。
