# Block 3：Browser progress、cycle 与终态

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed（2026-09-03） |
| Task 范围 | `ACQ01`-`ACQ08` |
| 前置块 | Block 2 Completed |
| 下游块 | Block 4、5 |
| 恢复点 | 最后一个通过 Browser controller/source 直接测试的能力切片 |

## 块结果

Acquisition Browser controller 只评价 Network 已 settle 的 Observation，用 article-local stable transition graph 判断进展、self-loop 和 cycle；模型下一轮收到安全且足够的上一转换反馈。Browser source 使用一个 typed resolver 处理 capture、Stop、Challenge、page terminal 与具体失败，最终 Report 不再只看到笼统 `challenge-unresolved` 或错误的 `no-download`。

## 进入条件

- Block 2 的 execute-and-settle、Candidate 与 failure transition 已通过直接测试；
- Block 1 的 stable semantic/action intent 合同和 terminal code family 未发生未记录变化；
- `acquisition/browser_control.py`、`acquisition/sources/browser.py` 当前用户 diff 已逐段审查；
- Browser Agent fake 不再被允许在 `execute()` 返回时直接替实现发布最终 Observation。

## 责任与改动面

Primary owner 负责：

- `src/sciretriever/acquisition/browser_control.py` 的 Agent loop、call input、transition graph、stop reason、safety fuse 和 controller result；
- `src/sciretriever/acquisition/sources/browser.py` 的 Agent flow integration、capture validation 顺序和 terminal outcome resolver；
- `src/sciretriever/acquisition/outcomes.py` 或现有相邻中性结果类型的必要调整，不新增第二套业务状态；
- `tests/test_browser_agent_control.py`、`tests/test_browser_agent_integration.py`、`tests/test_acquisition_browser.py`、`tests/test_acquisition_matrix.py` 和 Entry/tiered acquisition 相关回归。

Acquisition 可以保存当前 article flow 的 bounded transition graph，但不得执行 vendor action、保存 screenshot/model history 或把运行图写入 Storage。

## 需要保持的行为

- 每次模型调用仍是独立 `AgentRuntime.execute`，没有 session history、hidden retry 或自动 repair；
- model call 期间 capture/page 变化会触发重新观察，旧 decision 不 dispatch；
- action parser 继续只接受当前 Observation 可验证的六种封闭动作；
- Rules/Agent 不互相 fallback，Agent 不能绕过 Publisher profile 或 Network policy；
- 完成的 Browser capture 仍必须经过既有 capture guard、主 PDF 识别、字节/reader/page-tree 验收和 publication；
- route 局部失败不撤销其它已提交事实，deferred/system failure 不建立自动 acquisition exhaustion；
- Browser Observation、transition graph、模型决定和 stop reason 不进入 Literature/Catalog/provenance。

## Tasks

- [x] **ACQ01 — 只消费 settled transition。** 删除 action receipt 后立即自行 `observe()` 并评价的路径；controller 对 `Stale/Settled/Captured/CandidateTimeout/Stopped/Cancelled/Failed` 做穷尽处理。
  - 依赖：Block 2。
  - 验收：delayed click 在 Network settle 完成前不会被 Acquisition 判定；未知 transition 或非法组合 non-retryable 失败，不被当作 miss。
- [x] **ACQ02 — 实现 stable transition graph。** 以 `(stable_state, stable_intent) -> resulting_state` 记录已 settle 的 article-local 边，分别识别首次 self-transition、重复 self edge 和返回旧 state 后重复已知边。
  - 依赖：ACQ01。
  - 验收：第一次 `A + x -> A` 继续；再次在 `A` 提出 `x` 时 dispatch 计数不增加并以 no-progress 停止；`A + x -> B, B + y -> A` 后再次提出 `x` 以 cycle 停止。
- [x] **ACQ03 — 分离 semantic progress 与 capture progress。** revision、navigation event、screenshot 像素变化或 settle changed 本身不增加 semantic progress；Candidate/Captured 使用独立状态和反馈。
  - 依赖：ACQ02。
  - 验收：像素/ID/geometry 抖动不会规避重复检测；真正 page state、origin/path、actionability 或结构变化可以继续；Candidate 不污染 semantic edge。
- [x] **ACQ04 — 给下一轮模型提供 bounded transition feedback。** Browser call 除当前 Observation 外，加入上一动作的安全 dispatch/settle 结果、是否 semantic changed、page/capture state 和 normalized stop hint；不发送完整历史、fingerprint 原值、tool arguments 或 vendor/private data。
  - 依赖：ACQ01-ACQ03。
  - 验收：第一次 self-transition 后第二次模型明确知道“动作已执行并 settle，但语义未变化”；input hash 随有意义反馈变化；call 仍满足单次大小/capability 限制。
- [x] **ACQ05 — 统一 capture 与 terminal evidence resolver。** 用 typed evidence 替换 first-wins `facts.fail()`；已完成 capture 先进入 validation，Candidate timeout、Agent Stop、cycle、page terminal、resource block 和 Network/Agent failure 按证据强度解析。
  - 依赖：ACQ01、ACQ03。
  - 验收：capture 与 Stop/Challenge 同时出现时 capture 不丢失；无可接纳 capture 时最具体 failure 胜出；generic unresolved/no-download 只作为最后 fallback。
- [x] **ACQ06 — 保留具体 Browser terminal cause。** 扩展 `BrowserAgentResult`/route mapping，使 Report 能区分 Agent Stop、self no-progress、cycle、candidate timeout、resource blocked、page terminal、Agent Provider failure、Network failure 和 internal failure。
  - 依赖：ACQ05。
  - 验收：Challenge code family 与 Block 1 一致；不记录模型自由文本 Stop reason；`retryable/reason/action` 与 cause 匹配。
- [x] **ACQ07 — 实现 controller safety fuse。** 按 ADR 0017 amendment 的固定 high-water policy 监控总模型调用/动作或单 flow elapsed；到达边界时安全停止并形成 `controller-safety-limit`。
  - 依赖：ACQ02、Block 1 已确定阈值。
  - 验收：持续生成未重复 click-point intent 的模型也有限终止；结果不是 `NO_PROGRESS`、normal miss 或 exhaustion；普通配置/TUI 不新增复杂阈值。
- [x] **ACQ08 — 建立 controller/source/route 回归矩阵。** 覆盖异步 click、首次/重复 self edge、`A -> B -> A`、stale、Candidate 三终点、capture/Stop、capture/Challenge、specific resource block、Provider/Network/internal failure、取消和 safety fuse。
  - 依赖：ACQ01-ACQ07。
  - 验收：每个测试同时断言模型调用、vendor dispatch、capture validation、最终 disposition/code/retryable 和 exhaustion publication；旧的 `test_proven_semantic_self_transition_stops_without_a_repeat_budget` 被目标语义测试替代。

## 执行方式与集成点

按 ACQ01 -> ACQ02/03 -> ACQ04 -> ACQ05/06 -> ACQ07 -> ACQ08 串行。先让 controller 正确消费 Network transition，再改变 route outcome；不能在 source 里通过重试 controller 或切换 Rules 掩盖 progress 缺陷。

### Transition graph 规则

```text
current stable state S
  + proposed stable intent I

if (S, I) 已有 settled edge:
    不 dispatch
    edge.result == S       -> repeated-self-transition
    edge.result != S       -> repeated-cycle-edge
else:
    dispatch -> settle -> state T
    record (S, I) -> T
    T == S                 -> 反馈模型并继续
    T != S                 -> semantic progress，继续
```

这不是模型调用 history，也不是固定 repeat budget；它只保存当前文章已被真实 execute-and-settle 证明的边。若页面回到 `S`，相同 intent 不应再次支付动作/模型后续成本来重走已知边。

### 模型反馈最小字段

下一轮 Browser request 可以携带一项受控 previous transition summary：

```text
action_kind
dispatch_outcome
settle_outcome
semantic_changed
page_state
capture_state
```

不得携带 raw receipt、StableFailure 自由文本、selector、coordinates、URL query、fingerprint、模型原文或累积 turn history。具体 failure 只用稳定 code 或封闭 hint，避免 prompt 注入和无限增长。

### 终态优先级

resolver 的业务顺序固定为：

1. 真实 completed capture 进入既有 PDF candidate 验收；成功则 route 成功；
2. capture 全部拒绝后继续评价同一 flow 已收集的终态证据；
3. cancellation；
4. specific Network/Browser/Agent runtime failure 或 resource block；
5. 明确 page terminal；
6. safety fuse 单独形成 action-required，并阻止 exhaustion publication；
7. Challenge 下的 Agent Stop、cycle/self no-progress 或 Candidate timeout，映射为具体 unresolved code；
8. 非 Challenge 的 Stop/no-progress/no-download fallback。

若实际业务合同要求 cancellation 在已完成 capture 前胜出，必须回到 ADR/requirements 判断；不得由 callback 顺序偶然决定。

## 审查门

- R1：Block 2 transition、stable fingerprint 与目标 diff 已核实；
- R2/ACQ02：第一次 self edge 和 repeated edge dispatch 数有明确测试；graph 不使用 raw screenshot/revision 充当 progress；
- R2/ACQ04：反馈 bounded、无历史增长、无禁止内容、不会让 Agents 取得 Browser workflow；
- R2/ACQ05：capture validation 与 terminal resolver 的证据优先级不依赖写入顺序；
- R2/ACQ07：safety fuse 不形成用户预算、normal miss 或 exhaustion；
- R3：controller、source、route/Entry 回归通过，failure/Report 语义一致。

以下情况阻断退出：第一次 self-transition 仍立即停止；重复 edge 仍会 dispatch；Candidate 被当作 capture；specific resource block 被 generic challenge 覆盖；safety fuse 发布 `NoPrimaryPdf`；日志或结果保存模型自由文本/页面私有内容。

## 接口 / 数据 / 依赖影响

- 接口：`BrowserAgentResult` 增加 typed terminal cause，controller control port 消费 Block 2 transition；旧 receipt-only/first-wins 私有路径删除；
- 数据：article-local graph 和 terminal evidence 不持久化，无 Catalog/schema/asset 变化；
- 配置：无新增普通配置；safety fuse 为实现/架构 high-water policy；
- 依赖：无；
- Report：稳定 failure code/reason/action 更具体，但 Report 结构预计不变；若结构需变，停止并更新影响矩阵/公开合同。

## 验证与证据

至少执行：

```bash
uv run --frozen python -m unittest \
  tests.test_browser_agent_control \
  tests.test_browser_agent_integration \
  tests.test_acquisition_browser \
  tests.test_acquisition_matrix
uv run --frozen python -m unittest \
  tests.test_browser_challenge_lifecycle \
  tests.test_browser_challenge_resources \
  tests.test_tiered_acquisition_service \
  tests.test_entry_completion
uv run --frozen ruff check \
  src/sciretriever/acquisition/browser_control.py \
  src/sciretriever/acquisition/sources/browser.py \
  tests/test_browser_agent_control.py \
  tests/test_browser_agent_integration.py \
  tests/test_acquisition_browser.py
uv run --frozen ruff format --check \
  src/sciretriever/acquisition/browser_control.py \
  src/sciretriever/acquisition/sources/browser.py
```

测试证据必须报告关键场景的 model call、dispatch、capture validation 与最终 code，而不只报告总测试数。

## 退出条件

- ACQ01-ACQ08 全部完成；
- controller 只评价 settled Observation，stable graph 和 feedback 正确；
- capture/terminal resolver、Challenge code family 和 safety fuse 通过 route/Entry 回归；
- 不新增持久状态、配置复杂度、权限或 fallback；
- 相关直接测试与 Ruff 通过，无 blocking/material finding。

## 完成证据

- `AgentBrowserController` 只穷尽消费 typed transition；article-local graph 记录 `(stable state, stable intent) -> resulting state`，第一次 self edge 继续，重复 self edge 在 dispatch 前停止，`A -> B -> A` 的已知边形成独立 cycle cause。
- 下一轮模型只得到 bounded previous-transition summary；semantic/capture progress 分离，revision、screenshot 和临时 ID 不冒充进展。
- `acquisition/sources/browser.py` 使用 typed evidence resolver；完成 capture 优先进入既有 PDF validation，specific Network/resource failure 优先于 generic page/challenge failure。
- route/Report 已区分 Agent Stop、repeated self、cycle、Candidate timeout、page terminal、resource blocked、Agent Provider failure、Network failure、controller internal 与 `controller-safety-limit`。固定 32 次 model call fuse 形成 action-required safety failure，不提交 normal miss/exhaustion 事实。
- Acquisition/Entry 相关回归共 191 项通过；production-shaped Browser 场景验证 self/cycle 的实际 dispatch 次数、Candidate captured/timeout、specific vendor failure、取消、safety fuse 与资源回收。

## 失败与恢复

若 stable graph 在真实 production-shaped fixture 中误合并不同页面或无法识别明显循环，保留最小反例并回到 Block 1 fingerprint 合同；不得增加固定重复次数绕过。若 terminal resolver 需要改变 PDF publication 或 exhaustion 事实 owner，停止并返回架构/requirements，而不是在 source 中增加例外。

## 下游交接

Block 4 可以依赖：Browser failure/cancellation 与共享 Agent failure 已有稳定边界，不得再由 Runtime 泛化。Block 5 可以依赖：Network settle + Acquisition progress/terminal 已形成一条生产形状路径，可用于 Bootstrap 对象图离线验收。
