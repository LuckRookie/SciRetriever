# Block 02：Generic Browser runtime

## 块身份

| 字段 | 值 |
|---|---|
| 状态 | `Completed`（2026-09-06） |
| Owner | `/root` |
| 前置块 | Block 01 R3 |
| 下游块 | Block 03 Agent controller、Block 04 Acquisition |
| 恢复点 | fake Browser/replay 通过 runtime contract 测试后 |

## 块结果

Network 提供不依赖 Publisher click rule 的 article-local Browser executor：只把稳定页面交给 Agent，只执行绑定当前 revision 的六种动作，统一处理 page/frame/popup/viewer 替换、quiet settlement、capture candidate、下载事件和清理。

## 进入条件

- Block 01 已冻结 `BrowserObservation`、`BrowserAction`、`BrowserStepResult` 和 candidate 合同。
- 现有 `network.browser_control` 的 start/apply、revision/stale、settlement 和 capture 代码已经完成调用方盘点。
- 测试使用 fake/fixture，不启动真实 CloakBrowser 或访问真实站点。

## 责任与改动面

- Owner：`src/sciretriever/network/browser_control.py`、`browser.py`、`browser_runtime.py`、`browser_sessions.py`、`response_feedback.py` 及直接测试。
- 可能触及：`cloakbrowser.py`、`playwright.py` 的事件/下载适配，但不改变 vendor 类型跨边界规则。
- 受保护：Network 通用安全政策、限速和用户已有其它 Browser/日志改动。

## 需要保持的行为

- Browser 进程、persistent context、Publisher lane 和 article lease 的所有权不变；不为每个站点创建隐含 Browser identity。
- 所有导航、popup、response、native download 和 cleanup 继续执行 destination/DNS/host/correlation guard。
- Agent 不取得 Page、Context、Locator、Cookie、CDP、任意 URL 或文件系统能力。
- 不能把 `capture_state=CANDIDATE` 或 vendor transition 暴露给模型，也不能因页面动画等待无限阻塞。

## Tasks

- [x] **GBR01 — 收敛 generic step session。** 让 `start()` 只返回首个稳定 `Ready`/终态，`apply()` 在一次调用内完成 exact binding、最多一次 vendor dispatch、页面替换、quiet settlement、capture 和取消处理。
  - 依赖：CGA02。
  - 验收：Acquisition 不再调用/解释 `observe`、`settle`、`execute` 等第二套 Network transition；stale 动作只得到新的 `Ready`，不重放旧动作。

- [x] **GBR02 — 扩充中性 Observation。** 在不泄漏 secret/vendor object 的前提下，加入可见文本摘要、actionable link 的规范化目标类别、surface/frame/popup/viewer 关系、page state、截图和上一动作 receipt。
  - 依赖：GBR01。
  - 验收：fixture 能区分正文链接、补充材料、viewer、登录/challenge/404 等页面状态；query、header、Cookie 和签名 locator 不进入模型输入。

- [x] **GBR03 — 固化六种动作和 exact binding。** 实现 `ClickElement`、`ClickPoint`、`ScrollSurface`、`GoBack`、`WaitForChange`、`Stop` 的解析、边界检查、单次 timeout 和取消语义。
  - 依赖：GBR02。
  - 验收：过期 revision、错误 article/surface、越界坐标和任意 URL/selector 均在 vendor dispatch 前稳定失败；`Stop` 不调用 vendor API。

- [x] **GBR04 — 抽取通用 capture/candidate 生命周期。** 建立 response/native download/popup/viewer 的统一 lineage、pending candidate、capture timeout、accepted/rejected 反馈入口；保留 `BrowserCapturePolicy` 作为 Acquisition 正确性 owner。
  - 依赖：GBR01、CGA02。
  - 验收：一个 candidate 只能属于一个 article operation；capture 延迟、晚到事件、下载目录切换和清理都有确定性结果；capture 不直接发布主资产。

- [x] **GBR05 — 把 Challenge 作为 page state。** 删除独立 Challenge observation/interaction controller/retry 状态族，让 challenge、login、MFA、paywall 等与普通页面共享 observation/action/终态机制。
  - 依赖：GBR02、GBR03。
  - 验收：测试能区分 `page_state=CHALLENGE` 与 runtime failure；Agent 可用同一封闭动作处理，Network 不为 challenge 开第二条 loop。

- [x] **GBR06 — 移除 rule catalog 对 runtime 的硬依赖。** Generic Browser 的 admission 只依赖 ArticleGoal、通用 Network policy 和可选 correctness capability；没有 Publisher click rule 也能生成 Browser step session。
  - 依赖：GBR01–GBR05、CGA03。
  - 验收：无 rule fixture 可以从 canonical landing 进入 `Ready`；不把无 canonical landing 或未通过通用 admission 的 URL 放宽为 arbitrary-site Browser。

## 执行方式与集成点

GBR01–GBR05 按 Network 内部依赖串行推进；GBR06 在所有 runtime contract 稳定后移除 rule gate。每个 Task 用 fake Page/Download event 和 replay fixture 验证，最后与 Block 03 的 Agent decision schema 汇合。

## 审查门

- R1：检查 runtime 修改范围不覆盖用户未提交的 Acquisition/日志无关改动。
- R2：检查页面稳定判定、stale 和 candidate 清理是否在 Network 内完成，是否存在 sleep/retry 猜测。
- R3：确认 fake Browser 能覆盖 page replacement、popup/viewer、download delay、late event、cancel 和 cleanup。

## 接口 / 数据 / 依赖影响

- 接口：`BrowserStepSession.start/apply` 和 observation/action/result schema 重构；旧 transition API 直接删除。
- 数据：candidate 只留内存和当前 operation evidence，不进入 Catalog。
- 依赖：复用现有 Playwright/CloakBrowser adapter；不新增 Browser SDK。

## 验证与证据

- `tests/test_network_browser.py`、`tests/test_network_playwright_control.py`、capture/cleanup 直接测试。
- fake event replay 覆盖稳定页面、stale、page replacement、native download、candidate timeout、cancel。
- `uv run --frozen ruff check`、相关 unittest、Block 退出时 Quick。
- 证据记录 action dispatch 次数、stale 重观察次数、candidate 清理结果和终态映射，不记录真实 URL/凭据。

## 退出条件

- Generic runtime 在无 Publisher click rule fixture 中产生稳定 `Ready` 并执行六种动作；
- 所有不稳定 transition、candidate pending 和 late event 都在 Network 内有界收敛；
- Challenge 不再拥有专属控制器/状态机；
- Block 02 R3 通过，Block 03 可直接依赖其合同。

## 完成证据

- `BrowserStepSession.start/apply` 是唯一通用 step 边界；稳定 observation、revision/article/surface binding、
  单次 vendor dispatch、settlement、capture、stale 和 cleanup 由 Network 收敛。
- 六种动作 `ClickElement`、`ClickPoint`、`ScrollSurface`、`GoBack`、`WaitForChange`、`Stop` 均保留
  exact binding；任意 URL、selector、脚本和 vendor object 未进入 Agent 接口。
- Challenge、login、MFA、paywall/not-entitled、not-found 均使用同一 `page_state`/step 机制；不存在
  Challenge 专属 controller loop。
- fake Browser 回归覆盖页面替换、popup/viewer、下载候选、candidate timeout、stale、取消、重复/环路和
  terminal cleanup。Browser/Agent/Acquisition 等直接回归共 307 项，通过。
- Quick 的 Ruff lint、Ruff format check 和 compileall 均通过；残余风险仅为未经本任务授权的真实站点差异。

## 失败与恢复

若 runtime 仍需 Acquisition 二次解释页面 transition，回到 GBR01；若 candidate 只能靠模型判断是否读取，回到 GBR04；若无 rule fixture 无法进入且原因只是 profile lookup，回到 GBR06。不要在 Agent controller 增加页面等待或重试补丁。

## 下游交接

Block 03 获得稳定 Observation/action/result 和 capture feedback；Block 04 获得通用 Browser session、article-local candidate lineage 和 cleanup 语义。
