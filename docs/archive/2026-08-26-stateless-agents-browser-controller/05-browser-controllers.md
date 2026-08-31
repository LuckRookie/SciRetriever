# Block 05：Acquisition Browser Controllers

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | ABC33–ABC41 |
| 前置块 | Block 02、Block 04 |
| 下游块 | Block 06 |
| 恢复点 | 已通过的 AgentRuntime 与 BrowserControlSession 合同 |

## 1. 块结果

Acquisition 拥有两个互斥 controller。Rules controller 只执行确定性获取；Agent controller 从首次统一 Observation 起循环执行单次 Agent 决定。Challenge 与普通页面共享同一循环和动作。流程只因 PDF captured、明确页面终态、Agent Stop、用户取消、真实系统失败或已证明语义无进展而结束。

## 2. 进入条件

- Block 02 和 Block 04 Completed；
- Runtime 可以执行 Browser role tool call；
- Network control session 可以观察统一页面并执行全部封闭动作；
- Publisher rule/profile 与 Browser scheduler 的现有 owner 已核实。

## 3. 责任与改动面

- Owner：`src/sciretriever/acquisition/browser_control.py`、`sources/browser.py`、必要的 controller 文件；
- Consumer：Tiered Acquisition Browser route；
- Executor：Network BrowserControlSession；
- Tests：Browser agent control/integration、Acquisition Browser、cohort/tiered service、challenge fixture；
- 受保护工作：Publisher rule modules、route applicability、risk group scheduler、TemporaryPdf 统一验收与 route outcome。

## 4. 需要保持的行为

- Browser 只处理 Public/API 层未解决且已准入的目标；
- 未知 Publisher 不执行 generic arbitrary-site Browser；
- 相同 risk group 的一篇文章 permit 覆盖完整页面流程和 cleanup；
- Publisher marker、主 PDF/supplement discrimination、allowed origins、rate policy 继续共用；
- 登录、机构选择和 MFA 仍是明确停止状态，不扩大本次动作集合。

## 5. Tasks

- [x] **ABC33 — 固化 `BrowserFlowController` seam。** Controller 只拥有当前文章目标和控制循环，不取得 process/context/Profile/Cookie 或 PDF 发布权限。
  - 验收：Acquisition 只调用中性 observe/act/capture API，Network vendor 类型不越界。

- [x] **ABC34 — 收敛 `RuleBrowserController`。** 只执行初始 capture、通用 locator 和 Publisher 确定性页面动作；正常 miss 后结束。
  - 依赖：ABC33。
  - 验收：fake Agent 调用计数始终为零；没有普通 miss 后 Agent fallback。

- [x] **ABC35 — 实现 `AgentBrowserController`。** 从首次 Observation 起由 Agent 决定封闭动作；不先运行确定性点击规则，capture/runtime 基础仍共享。
  - 依赖：ABC33、Block 02、Block 04。
  - 验收：首次模型输入是首次统一 Observation；controller 只能解析本次声明的六种动作。

- [x] **ABC36 — 统一 Challenge 处理。** Challenge 作为 Observation 的 `page_state=CHALLENGE` 交给 Agent，删除 challenge 专属 prompt/target/controller/retry/interaction 状态机。
  - 依赖：ABC35。
  - 验收：Challenge 可以选择 ClickElement/ClickPoint/Scroll/Back/Wait/Stop，与普通页面使用相同 validation/action receipt。

- [x] **ABC37 — 实现自然终态。** PDF captured、明确 page state、Agent Stop、用户取消、Provider/Network 真实失败或语义无进展时结束。
  - 依赖：ABC35、ABC36。
  - 验收：Agent 停在 Challenge 时由 Acquisition 组合为 `challenge-unresolved`；无需专属状态机。

- [x] **ABC38 — 实现语义无进展检测。** 记录 `semantic_page_fingerprint + action_fingerprint -> resulting_page_fingerprint`。
  - 依赖：ABC37。
  - 验收：同语义状态下同一动作已经证明回到同一状态时停止；仅动作名称重复但页面变化时继续。

- [x] **ABC39 — 删除 Browser 作业硬预算。** 删除 step、总秒数、累计 token/image、重复动作次数和 `BUDGET_EXHAUSTED`。
  - 依赖：ABC37、ABC38。
  - 验收：只剩单次 model/context/output、单次 navigation/action timeout、quota/rate limit、用户取消和真实系统错误。

- [x] **ABC40 — 保持 Publisher 知识共用。** route、allowed origins、risk/rate policy、page marker、主 PDF判别、popup/viewer admission 和 capture validation 同时服务两种 controller。
  - 依赖：ABC34、ABC35。
  - 验收：只有确定性点击序列属于 Rules；Agent 模式不复制或绕过 Publisher 安全知识。

- [x] **ABC41 — Controller 直接测试闭环。** 证明 Rules 不调用模型、Agent 不先执行规则、Challenge 可处理、语义循环停止和 Publisher lane 调度不回归。
  - 依赖：ABC33–ABC40。
  - 验收：Browser agent/control/integration、Acquisition browser/cohort/tiered tests 通过，Ruff/Pyright 无错误。

## 6. 执行方式与集成点

先固定 controller seam 与 Rules 单一路径，再实现 Agent 首次 Observation/loop，随后统一 Challenge、自然终态和语义 fingerprint，最后删除硬预算并做 Publisher/调度回归。切换以完整 controller 为单位，不允许同一作业内按失败结果切换模式。

本块完成 I2：Block 04 的 Network control contract 与 Acquisition controller 组合后，Rules/Agent 互斥、Challenge 普通化、capture/guard 共用，旧 fallback 与专属状态消失。

## 7. 审查门

- R1：Block 02 Browser tool call 和 Block 04 control session 均通过直接测试；
- R2：每个 controller 切片审查模型调用计数、动作权限、自然终态、语义进展和 Publisher permit；
- R3/I2：Rules 不调用 Agent、Agent 不先跑 Rules，旧 fallback/预算/challenge 专属符号清零，调度与 PDF 验收回归通过；
- 任意 URL/JS/登录/MFA 等动作扩张为 blocking，返回用户/ADR 决策。

## 8. 接口、数据与依赖影响

- 旧组合/fallback controller 与 BrowserAgentLoopBudget 被破坏性删除；
- route outcome 可增加/收敛 `challenge-unresolved` 等稳定原因，但不新增数据库或 Report 分区；
- 不改变 Publisher Profile catalog 的身份、rate policy 或 PDF 发布合同；
- 无新增外部依赖。

## 9. 验证与证据

- `tests/test_browser_agent_control.py`；
- `tests/test_browser_agent_integration.py`；
- `tests/test_acquisition_browser.py`、`test_acquisition_cohorts.py`；
- `tests/test_tiered_acquisition_service.py`；
- challenge local fixture 和 fake Runtime action sequence；
- `rg` 检查 fallback、预算和 challenge 专属符号。

## 10. 退出条件

- ABC33–ABC41 全部勾选；
- 两个 controller 单独可运行且不互相调用；
- Challenge 和普通页面共用 Observation/action/natural termination；
- 直接测试证明调度、Network guard 与 PDF 验收未回归。

## 11. 完成证据

- `BrowserControllerKind.RULES | AGENT` 在 Source 与 Registry 组装时互斥；Rules 正常 miss 不构造 Runtime，Agent 从首次统一 Observation 开始且不运行 locator 发现或 Publisher 静态点击。
- Agent 每次 Observation 构造独立 `AgentCall`，只声明 `click_element`、`click_point`、`scroll_surface`、`go_back`、`wait_for_change`、`stop`；Challenge 通过同一调用、validation 与 receipt 路径处理。
- `semantic_page_fingerprint + action_fingerprint -> resulting_page_fingerprint` 直接测试证明同态动作停止、同类动作伴随页面进展时继续；capture race、页面 mutation、取消、quota 与 Network failure 均有直接证据。
- Rules 的 reviewed selector 只在 Network snapshot 内解析为当前 revision 的短期 element ID，再构造 `ClickElement` 进入与 Agent 相同的 action executor；旧 vendor `click(selector)` 直通路径由失败哨兵测试证明未调用。
- Registry 直接测试证明 9 条 Publisher Browser route 在 Agent 模式复用同一个 ready `AgentRuntime`，未选 controller 依赖缺席且组装过程不调用模型。
- 初次退出审查曾运行 Controller、Acquisition、matrix、cohort/tiered、Publisher、scheduler/session/state/admission、Network、Playwright 共 291 项测试：`OK (skipped=1)`；但 Block 07 的 I4 语义审查随后发现该绿色测试集没有证明旧 `BrowserRunStateMachine`、Challenge group circuit 和全部累计 Browser 作业预算已经真正删除，因此这条初始证据不再单独作为 ABC36/ABC39 的完成依据。
- Block 07 将 finding 路由回本块后，物理删除 `acquisition/browser_state.py`、`test_browser_state.py` 与旧 runtime-state fixture；Source 直接消费统一 `BrowserPageState`/controller result，Challenge 未解决只形成文章级 `acquisition-browser-challenge-unresolved`，同组下一篇仍执行。`tests/test_acquisition_cohorts.py` 直接证明 Challenge 不再打开 Publisher circuit。
- 同一次返回修复删除 `BrowserBudget`、整篇 60 秒 deadline、navigation/request/popup/download/capture/总字节累计阻断和 `BrowserSiteRule.max_actions`；`BrowserOperationLimits` 只保留单次 capture 字节、action timeout 与 capture-wait timeout。`test_progressing_flow_has_no_article_total_deadline` 用 fake clock 跨过 120 秒后继续第二次页面操作，证明持续进展不会被整篇 deadline 终止；九个静态规则动作也可构造而不受累计 job cap。
- 修复后的组合回归运行 Network Browser、local Cloak fixture、Provider fixture、Acquisition Browser/matrix、Bootstrap readiness、content pipeline contract 与 architecture cutover 共 198 项：`OK (skipped=2)`；两个 skip 都是未配置 opt-in Cloak runtime。相关 Ruff lint/format 与全库 Pyright 均退出 0，精确 `rg` 只在架构负向哨兵或“已删除/不采用”的文档语境命中。
- 残余边界：本块没有获得真实 Provider、真实模型、机构 IP 或持久 Profile 探测授权，真实站点效果不作为离线完成证据。

## 12. 失败与恢复

- 若 Agent loop 无法区分新进展与同态页面，修正 fingerprint 输入，不恢复固定 step/repeat budget；
- 若 Rules 与 Agent 共享 capture 时发生双执行，收窄 controller seam，不复制 runtime；
- 若新增页面动作超出批准集合，停止并回到 Block 01/用户决定。

## 13. 下游交接

Block 06 可以根据冻结配置只构造其中一个 controller，并把同一 Browser client、Publisher scheduler 和 AgentRuntime 注入所选对象；未选 controller 不得留在生产图中。
