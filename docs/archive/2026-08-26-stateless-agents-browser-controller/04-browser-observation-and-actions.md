# Block 04：统一 Browser Observation 与动作

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | ABC23–ABC32 |
| 前置块 | Block 01 |
| 下游块 | Block 05 |
| 恢复点 | Block 01 已接受的 Browser ownership/action 合同 |

## 1. 块结果

Network 为 Rules 与 Agent 提供同一 Browser runtime 基础：带 revision 的 page/popup/frame/Shadow/viewer surface tree、统一页面状态、viewport screenshot、可见操作元素、scroll/capture 状态和上一动作 receipt。Network 唯一校验并执行六种封闭动作，不向 Acquisition/Agents 暴露 Playwright/CloakBrowser 对象。

## 2. 进入条件

- Block 01 Completed；
- 统一 Observation/action 合同、Challenge 普通化和 Network/Acquisition owner 已写入目标文档；
- 当前 `network/browser_control.py`、Browser session/runtime/capture 与 production fake 已核实。

## 3. 责任与改动面

- Owner：`src/sciretriever/network/` 的 Browser snapshot、control、runtime、session 和 Playwright/CloakBrowser adapter；
- 中性值若跨模块复用，放在项目既有中性 Model owner，不把 vendor 类型提升到 `sciretriever.model` 的持久业务事实；
- 测试：Browser agent control、state、runtime、sessions、provider fake、local Cloak fixture；
- 受保护工作：origin/DNS/CONNECT/host admission、Publisher permit、capture、临时 PDF、清理、固定 Profile/process/context。

## 4. 需要保持的行为

- 每篇文章隔离 page、token、event handler、临时目录和 capture；
- 所有 navigation/popup/viewer/response/download 继续通过 Profile guard 与 Network policy；
- 下载只形成 `TemporaryPdf`，后续仍通过 Acquisition 统一 PDF reader/页面树/主资产验收；
- Challenge dependency 仍受批准 Publisher、frame ancestry 和 origin guard 约束；
- 动作复用同一 humanized CloakBrowser article session，不创建第二 Browser/context/CDP client。

## 5. Tasks

- [x] **ABC23 — 定义统一页面状态。** 使用 `NORMAL | CHALLENGE | LOGIN_REQUIRED | MFA_REQUIRED | NOT_ENTITLED | ACCESS_DENIED | NOT_FOUND | FAILED`。
  - 验收：Challenge 不再派生 resource/interaction 专属状态族；裸 403 仍不自动等于 Challenge。

- [x] **ABC24 — 定义三维运行状态。** 分离 `page_state`、`agent_status = RUNNING | STOPPED | FAILED` 与 `capture_state = NONE | CANDIDATE | CAPTURED`。
  - 依赖：ABC23。
  - 验收：无 correlated enum 组合爆炸；运行状态不进入 Literature/Catalog。

- [x] **ABC25 — 定义统一 surface tree。** Snapshot 表达 page、popup、frame、Shadow/viewer surface 的稳定层级、去 query 的 origin/path/title、viewport 和 scroll。
  - 依赖：ABC23。
  - 验收：每个 surface 都属于当前 article/revision；未知或跨 origin surface 按现有 guard fail closed。

- [x] **ABC26 — 定义可操作元素。** 当前 revision 的可见元素含短期 element ID、surface ID、role/name/state 和 bounding box。
  - 依赖：ABC25。
  - 验收：不暴露 selector、DOM handle、Page/Locator/CDP；stale/hidden/disabled target 可在 vendor 动作前拒绝。

- [x] **ABC27 — 定义截图与动作 receipt。** Observation 携带当前 screenshot 元信息/字节、capture state 和上一动作 receipt，引用绑定 article/page/viewport/screenshot/revision。
  - 依赖：ABC25、ABC26。
  - 验收：截图有现有单次图片技术上限且不持久化；receipt 能表达 applied/no-change/navigation/capture/failure 的脱敏结果。

- [x] **ABC28 — 实现 `ClickElement`。** Network 通过短期 element ID 执行 DOM 可定位目标，并验证 revision、surface、可见性、可用性和 scope。
  - 依赖：ABC26、ABC27。
  - 验收：过期或未知 element 在 Playwright 调用计数为零时拒绝。

- [x] **ABC29 — 实现 `ClickPoint`。** 对当前 screenshot/viewport/surface 中的通用可见坐标执行 humanized click，不建立 challenge 专属 target。
  - 依赖：ABC27。
  - 验收：坐标越界、错误 screenshot/revision/surface 在 vendor I/O 前拒绝；closed Shadow/canvas/challenge 共用该动作。

- [x] **ABC30 — 实现其余封闭动作。** 支持 `ScrollSurface`、`GoBack`、`WaitForChange`、`Stop`，每次实际动作使用 Network 单次 timeout。
  - 依赖：ABC27。
  - 验收：滚动绑定 surface/revision，GoBack 不接受任意 URL，Wait 不接受 job deadline，Stop 不执行 vendor 动作。

- [x] **ABC31 — 统一 capture/runtime 基础。** Rules 与 Agent 共用 response/download/popup/viewer capture、navigation guard、Publisher permit、cleanup 和 PDF 临时交付。
  - 依赖：ABC28–ABC30。
  - 验收：两种 controller 不复制 Browser process/context/capture handler 或绕过 Network action executor。

- [x] **ABC32 — Network 合同测试闭环。** 使用离线 fixture 覆盖 frame/popup/Shadow/viewer、stale revision、坐标、不可见元素、receipt、capture 和 cleanup。
  - 依赖：ABC23–ABC31。
  - 验收：相关 Network/Browser tests 通过，Ruff/Pyright 无错误，测试不访问真实站点/Profile。

## 6. 执行方式与集成点

按“状态维度 → surface/element/screenshot/receipt → 单项动作 → 共享 capture/runtime → fixture”推进。每个新 Network 合同先由 fake/control tests 驱动，再让当前 Browser 调用方使用新中性 API；Block 04 不提前改变 Rules/Agent 的产品选择语义。

本块与 Block 05 形成一个受控迁移窗口：Block 04 退出时 Network 新合同及当前调用方必须可测；Block 05 随后删除旧 orchestration、challenge 专属解释和 fallback。不得留下长期 adapter 或第二套 control session。

## 7. 审查门

- R1：Block 01 的 action/owner 合同稳定，现有 Browser guard/capture/cleanup 证据已核实；
- R2：每个值/动作审查 revision、scope、vendor I/O 前拒绝、日志脱敏和资源清理；
- R3：统一 Observation/action fixture 通过，当前调用方可运行，未暴露 Page/Locator/selector/CDP；
- I2 延迟到 Block 05：只有旧 orchestration 被删除且两个 controller 互斥后才通过。

## 8. 接口、数据与依赖影响

- Browser control 内部接口发生破坏性变化；不保留旧 limited top-level Observation 或 challenge target alias；
- 不改变持久 Model、数据库 schema 或 TemporaryPdf/发布合同；
- 不新增 Browser engine 或外部依赖；
- screenshot/element/receipt 只存在于当前内存 flow。

## 9. 验证与证据

- `tests/test_browser_agent_control.py`、`test_browser_challenge_lifecycle.py`、`test_browser_runtime.py`、`test_browser_sessions.py`；
- `tests/test_network_browser.py`、`test_network_playwright_control.py`、`test_network_cloakbrowser.py`、local fixture tests 与 `test_architecture_cutover.py`；
- fake vendor 调用计数证明所有 stale/越界拒绝发生在动作前；
- `rg` 证明 Network 公共面不暴露 Page/Locator/selector/CDP。

## 10. 退出条件

- ABC23–ABC32 全部勾选；
- 统一 Observation/action/capture 的直接测试通过；
- 旧 challenge target 和有限顶层 Observation 已删除；
- Block 05 可以只通过中性 control session 驱动 Browser。

## 11. 完成证据

- `network/browser_control.py` 现在只有八种 `page_state`、三个正交运行维度、统一 surface/element/screenshot/receipt 及六种封闭动作；旧 Challenge lifecycle、interaction target、settle loop 和旧 Agent action port 已删除。
- `network/browser.py` 在任何刷新 snapshot 或 vendor action 前，先用当前 ledger 拒绝 stale revision、未知 page/element/surface、disabled element、错误 screenshot 和越界坐标；随后才刷新页面以发现真实的异步变化。fake 同时证明非法输入不会新增 snapshot 调用，也不会触发动作调用。
- `tests/test_network_playwright_control.py` 以纯 fake raw Playwright page/frame/locator/mouse 直接证明 frame、Shadow、viewer、query-free locator、按需 screenshot、短期 Locator 私有绑定、点击二次身份校验、坐标点击、surface 滚动、GoBack/Wait 单次 timeout 和关闭时 vendor handle 清理。
- popup、多 page、capture pipeline、revision、receipt 和 article cleanup 由 `test_network_browser.py` 覆盖；统一状态正交性、不可序列化 Observation、脱敏 repr 和无 URL/selector/JavaScript 动作由 `test_browser_challenge_lifecycle.py` 覆盖。
- opt-in `test_network_cloakbrowser_challenge_local.py` 已从 Challenge settle/interaction lifecycle 改为普通 `BrowserControlSession` Observation/Wait/Stop；当前未设置 `SCIRETRIEVER_TEST_CLOAK_HOME`，因此没有启动或下载真实 Cloak runtime。
- 相关命令结果：26 个目标文件 Ruff lint、Ruff format check、Pyright 均通过；Browser/Network/Acquisition 相关组运行 216 项，`OK (skipped=2)`。两个 skip 均为显式本地 Cloak runtime fixture；自动测试未访问真实 Provider、Profile 或凭据。
- `BrowserActionReceipt.FAILURE` 保留为可表达、脱敏的中性合同；实际 policy/runtime/cancel/timeout 仍通过 Network 稳定失败通道终止，不返回一个可被 controller 误当作继续信号的普通 receipt。
- 残余风险：纯 fixture 已证明适配器转换和边界，真实 Cloak/Publisher 的 closed Shadow、canvas 与页面变化仍只能由后续显式本地/真实环境验收确认；本块没有据此声称真实站点成功率。

## 12. 失败与恢复

- 若某 surface 无法稳定枚举，保留 screenshot + scoped coordinate 路径，不能暴露任意 JS/selector；
- 若 revision 无法覆盖 popup/frame 变化，先修正 snapshot identity，不用固定 sleep 掩盖 stale action；
- 恢复到最近通过的 state/surface/action 切片，保持现有 capture 与 Network guard 可用。

## 13. 下游交接

Block 05 获得一个与 controller 无关的 Browser control session：观察当前状态、执行一个封闭动作、返回 receipt/capture。Acquisition 不需要知道 vendor 页面结构或 Challenge 特殊执行器。
