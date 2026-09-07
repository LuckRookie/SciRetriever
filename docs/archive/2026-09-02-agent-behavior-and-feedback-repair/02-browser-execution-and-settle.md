# Block 2：Browser execute、settle 与 capture

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed（2026-09-03） |
| Task 范围 | `NET01`-`NET07` |
| 前置块 | Block 1 Completed |
| 下游块 | Block 3、5 |
| 恢复点 | 最后一个通过 Network action/capture 直接测试的 executor slice |

## 块结果

Network 对每个 Browser action 提供统一的 execute-and-settle 语义：receipt 只说明 dispatch，返回给 Acquisition 的 Observation 已经过同一变化/timeout/capture 规则稳定。点击触发的异步导航、Challenge 变化、popup/viewer 和 capture callback 不再依赖 controller 立即截图碰运气；`CANDIDATE` 在 Network owner 内完成 captured、cleared 或 timeout 生命周期。

## 进入条件

- Block 1 的 ADR amendment、closed transition、exact binding 和 Candidate 合同已通过；
- `BrowserClient`、Publisher control/session、Playwright/CloakBrowser action executor 的生产调用关系已核实；
- 目标文件的用户 baseline diff 已逐文件审查；
- 测试仍限定为 fake/fixture 或本地受控 vendor event，不连接真实网站、Profile 或凭据。

## 责任与改动面

Primary owner 负责：

- `src/sciretriever/network/browser_control.py` 的 action/transition/ledger 公共中性合同；
- `src/sciretriever/network/playwright.py`、`src/sciretriever/network/cloakbrowser.py` 中 action dispatch、event observation、timeout、capture callback 与 cleanup；
- `src/sciretriever/acquisition/sources/browser.py` 内把当前 request-local Browser session 暴露为 Agent control port 的最小 adapter，不能在此解释业务终态；
- `tests/test_network_playwright_control.py`、`tests/test_network_cloakbrowser.py`、`tests/test_network_cloakbrowser_local.py`、`tests/test_browser_agent_integration.py` 的离线边界证据。

Network 是 vendor action、Observation、capture 和 settle 的唯一 owner；Acquisition 只传入中性封闭 action 并消费 typed transition。

## 需要保持的行为

- 每次 action 在 dispatch 前仍验证 article/page/surface/revision/screenshot/coordinate 等 exact binding；
- 所有导航、popup、viewer、response/download 和 challenge dependency 继续经过 Publisher permit、Network policy、capture guard、quota/lane 与安全 URL 边界；
- `ClickElement` 优先 DOM locator，`ClickPoint` 只作用于当前可见 surface/screenshot，不能引入 arbitrary selector/URL/JS；
- `no_wait_after=True` 可以作为底层 dispatch 选择保留，但其后必须由本块显式 settle；不得恢复 Playwright 隐式无限 navigation wait；
- Browser process/context/Profile lifecycle、单 Publisher 串行、cleanup 和 session health/circuit 语义不变；
- response body、页面正文、完整 URL、Cookie、Profile、screenshot bytes 和 vendor exception 不进入 transition、日志或测试快照；
- Rules controller 的既有 action/capture 路径不能被 Agent-specific settle 破坏；共用能力应落在 Network，而不是复制实现。

## Tasks

- [x] **NET01 — 建立单一变化与 settle 谓词。** 将 action 后自动 settle 与显式 `WaitForChange` 收敛到同一 Network primitive，基于受控 navigation/DOM/surface/capture/page-state event 和单次 action deadline 等待，不使用固定 sleep 作为正确性证据。
  - 依赖：Block 1 transition 合同。
  - 验收：相同初始 state/event 序列对普通 action 与 WaitForChange 产生一致的 changed/capture/timeout 结论；没有第二套等待逻辑。
- [x] **NET02 — 分离 dispatch receipt 与 settled transition。** action executor 先形成 payload-free receipt，再等待并生成 `Settled/Captured/CandidateTimeout/Cancelled/Failed`；`APPLIED` 不再被任何 consumer 当作页面变化证明。
  - 依赖：NET01。
  - 验收：立即返回但稍后变化的 click 最终带回变化后的 Observation；完全无变化的 action 也返回合法 settled-no-change，而不是伪造 failure。
- [x] **NET03 — 完成 Candidate 生命周期。** capture callback 首次出现只发布 `CANDIDATE`，随后在同一 article/session deadline 内等待 guard 接纳并完成、明确清除/拒绝或 timeout；只有完整 `BrowserCapture` 对应 `Captured`。
  - 依赖：NET01、NET02。
  - 验收：candidate -> captured、candidate -> cleared、candidate -> timeout 三条路径都有直接测试；超时返回 `CandidateTimeout`，不会变成 `CAPTURE_AVAILABLE` 或 generic `no-download`。
- [x] **NET04 — 统一 stale、取消和 action failure。** dispatch 前最后一次 exact revalidation 失败返回 `Stale` 且 vendor 调用计数为零；settle 期间取消返回 `Cancelled`；可预期的 Network/vendor/action 失败归一为 `Failed(AccessFailure)`，Acquisition 再转换为 Report `StableFailure`；未知 controller 实现异常边界转换为 non-retryable internal failure。
  - 依赖：NET02。
  - 验收：当前生产中直接抛 `_Abort` 的路径有明确 typed owner；不存在“声明 FAILURE receipt、生产却永远抛异常”的死合同。
- [x] **NET05 — 保留 settle evidence 但隔离 vendor。** transition 携带 Acquisition 判断所需的 bounded evidence，例如 dispatch outcome、settle outcome、changed signal class、before/after revision 和当前 Observation；不携带 selector、raw event、Page、response、callback、异常正文或任意 URL。
  - 依赖：NET02-04。
  - 验收：Acquisition 无需再次立即 `observe()` 就能评价当前 action；所有 transition 值可独立构造/测试且通过安全审查。
- [x] **NET06 — 补齐异步与竞态测试。** 用可控 event scheduler 覆盖 delayed navigation、delayed challenge clear、DOM mutation、popup/viewer、capture during settle、candidate timeout、cancel during settle、stale before dispatch、vendor failure 和 cleanup。
  - 依赖：NET01-05。
  - 验收：测试能先在旧 receipt-only 行为下稳定失败、在新实现下通过；不得由 fake `execute()` 直接替换最终 Observation 来模拟 settle。
- [x] **NET07 — 审查 Rules/Agent 共用路径与资源回收。** 验证新增 primitive 没有让一次 action 重复 dispatch、重复 capture、延长 Publisher permit 生命周期或遗漏临时 stream/page cleanup。
  - 依赖：NET06。
  - 验收：Rules 与 Agent 代表性测试通过；每条成功、失败、取消和 timeout 路径都恰好释放一次拥有资源。

## 执行方式与集成点

按 NET01 -> NET02 -> NET03/NET04 -> NET05 -> NET06 -> NET07 串行实施。每个 slice 先用受控时钟/event fixture 描述时序，再修改 executor；不能通过普遍增加 timeout、轮询次数或固定 sleep 掩盖缺少 settle 信号。

目标时序：

```text
Acquisition               Network control                 Vendor/event source
    | exact action + obs         |                                  |
    |--------------------------->| validate exact binding           |
    |                            | dispatch ----------------------->|
    |                            |<------------------------ receipt |
    |                            | wait on shared settle predicate  |
    |                            |<------ navigation/DOM/capture ---|
    |<---------------------------| typed settled transition         |
```

### Settle 终点

在单次 action timeout 内，Network 可在以下安全点返回：

- 已完成 capture；
- pending Candidate 完成、明确清除，或到达 Candidate timeout；
- 页面/可行动 surface/page-state 的受控变化已经被新 Observation 捕获；
- vendor 明确报告 action/页面失败；
- 用户取消；
- deadline 到达且没有变化，此时是合法 `Settled(changed=false)`，由 Acquisition 记录转换证据，不由 Network 宣布业务 no-progress。

“一次 navigation event”“revision 增加”或“screenshot 像素变化”只是 settle evidence，不等于 semantic progress。后者只能由 Block 3 使用 stable fingerprint 判断。

## 审查门

- R1：Network/Acquisition owner、当前 diff、测试 event source 和无真实外部访问已确认；
- R2/NET01：WaitForChange 与自动 settle 确认使用同一 primitive/deadline；
- R2/NET03：Candidate 不能提前成功，stream/callback 生命周期和字节上限仍由 Network/capture guard 控制；
- R2/NET04：stale 时 vendor 调用为零，expected failure 与 unknown exception 均只有一个转换边界；
- R2/NET06：测试时钟确定、没有 wall-clock flake、fixed sleep 或 fake 代做 settle；
- R3：异步、竞态、Rules/Agent 和 cleanup 直接测试全部通过。

若实现需要把 Publisher 业务分类下沉到 Network、把 vendor event 暴露给 Acquisition、绕过 guard，或依赖真实网站才能证明正确性，立即停止并返回 Block 1/架构审查。

## 接口 / 数据 / 依赖影响

- 接口：内部 action executor 从 `BrowserActionReceipt` 单结果升级为 receipt + typed settled transition；所有调用方必须同一切片迁移；
- 数据：无持久状态；transition/event 仅在 request/article flow 内存中存在；
- 依赖：无新增依赖；继续使用当前 Playwright/CloakBrowser 与标准同步原语；
- 配置：复用现有单次 action/capture timeout，不新增普通用户开关；
- 日志：Network Debug 可增加 `dispatch/settle/capture_state/elapsed` 安全字段，INFO owner 仍在上层。

## 验证与证据

至少执行并按实际修改扩展：

```bash
uv run --frozen python -m unittest \
  tests.test_network_playwright_control \
  tests.test_network_browser \
  tests.test_network_cloakbrowser \
  tests.test_network_cloakbrowser_local \
  tests.test_browser_agent_integration
uv run --frozen python -m unittest \
  tests.test_browser_challenge_lifecycle \
  tests.test_browser_challenge_resources
uv run --frozen ruff check \
  src/sciretriever/network/browser_control.py \
  src/sciretriever/network/playwright.py \
  src/sciretriever/network/cloakbrowser.py \
  tests/test_network_playwright_control.py \
  tests/test_browser_agent_integration.py
uv run --frozen ruff format --check \
  src/sciretriever/network/browser_control.py \
  src/sciretriever/network/playwright.py \
  src/sciretriever/network/cloakbrowser.py
```

完成证据需记录受控 event 场景数量、测试结果，以及 test double 如何走真实 settle primitive，而不是只写“integration passed”。

## 退出条件

- NET01-NET07 全部完成；
- 所有 action 都只有一条 execute-and-settle 生产路径；
- delayed change 不提前结束，no-change 能安全返回，Candidate 三终点和取消/失败完整；
- Rules/Agent、capture guard、Publisher permit、cleanup 和安全边界未回归；
- Block 3 无需直接调用 `observe()` 猜测 action 是否完成。

## 完成证据

- `BrowserClient` 先 dispatch 形成 payload-free receipt，再通过 `_client_control_settle` 返回 typed transition；click/scroll/go-back 后自动 settle 与 `WaitForChange` 共用 vendor `control_wait_for_change` primitive 和同一 stable semantic 判定。
- Candidate callback 的资源 ownership 与 callback 活跃状态已经分开；Candidate 只会进入 captured、cleared 后的 settled state或 bounded timeout，不再成为伪成功。
- exact revalidation 在任何 vendor action 前执行；stale transition 不携带 receipt。取消、expected vendor/runtime failure 和 controller unexpected exception 分别保持 typed、安全、脱敏的失败语义。
- fake event scheduler 覆盖 delayed navigation/challenge clear、DOM/页面变化、popup/viewer、capture during settle、Candidate timeout/clear、settle cancellation、stale、vendor failure 和 cleanup；`tests.test_network_browser` 最终目标回归 72 项通过。
- Network/Browser 相关集 `Ran 143 tests, OK (skipped=1)`；页面、context、process、download/stream 与 Publisher/session permit 的确定性回收断言均通过。

## 失败与恢复

若 event source 无法可靠表达 settle，先保存最小 delayed-event 失败 fixture，停在最后一个通过的 executor slice；不得以延长固定 sleep 或让 Acquisition 轮询作为长期补丁。若 Candidate ownership 与现有 capture guard 冲突，返回 Block 1 重新确认相邻合同，不复制第二套 capture state。

## 下游交接

Block 3 可以依赖：每个非 Stop action 返回的 Observation 已经 settle；receipt 只代表 dispatch；Candidate 已经解析为 captured/cleared/timeout；stale、cancel、expected failure 和 internal failure 都是 typed transition；Network 不声明 semantic progress 或业务 route outcome。
