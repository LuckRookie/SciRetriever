# Block 01：自主 Browser 会话合同

## 状态与恢复点

- 状态：`Completed`
- 前置：无
- 下游：Block 02、Block 03
- 恢复点：先恢复 controller/transition fixture，再触及真实 Browser runtime

## 块结果

明确 Agent 可以在同一篇文章中自主探索；程序只验证动作是否能在当前 observation 上执行，不验证点击后的页面是否匹配预设路径。`Stop`、候选 capture、超时、取消和致命故障保持不同语义。

## 责任与改动面

- Owner：`/root`
- 主要模块：`src/sciretriever/acquisition/browser_control.py`、`src/sciretriever/network/browser_control.py`
- 直接测试：`tests/test_browser_agent_control.py`、`tests/test_browser_challenge_lifecycle.py`、`tests/test_browser_agent_integration.py`
- 受保护行为：动作必须绑定当前 observation/revision；Agent 不获得任意 URL、脚本、凭据、文件或业务写入；有效 capture 仍不能绕过 Acquisition 验收。

## Tasks

- [x] **ABS01 — 区分动作执行事实与业务终态。** 让 action receipt 只表达动作是否被当前页面接受、是否需要重新观察，不要求 semantic change 或预期页面状态。
  - 验收：点击后页面没有立即变化、页面发生异步导航或仍处于 Challenge 时，controller 可以获得下一次 observation，而不是直接得到 policy/contract 终态。
  - 依赖：无。
- [x] **ABS02 — 保留有限而明确的停止条件。** 保留 Agent Stop、cancel、timeout、Browser 致命 runtime failure 和有限动作/资源预算；移除由单次 no-progress 或中间 page state 推导终止的路径。
  - 验收：Stop 仍不声称 PDF 成功；预算耗尽和取消拥有稳定 failure；正常等待或一次无变化不会被映射成 `no-progress`。
  - 依赖：ABS01。
- [x] **ABS03 — 候选失败可以回到探索。** 设计 controller 与 capture candidate 的中性反馈，不把错误候选或暂时 candidate 直接当成成功/终止。
  - 验收：fixture 中第一候选为 HTML/错误 PDF 时，Agent 获得下一轮观察；有效候选仍立即进入最终验收路径。
  - 依赖：ABS01、ABS02。
- [x] **ABS04 — 锁定自主会话回归测试。** 覆盖 Challenge 点击、异步跳转、无语义变化、候选失败后继续、Stop/timeout/cancel 和 stale action 不重放。
  - 验收：直接测试能证明上述行为，且不使用真实 Provider、Profile、凭据或用户语料。
  - 依赖：ABS01–ABS03。

## 执行方式与审查门

串行完成 ABS01→ABS02→ABS03→ABS04。每项 Task 完成后运行对应测试并检查 diff；Block 退出前复核 `BrowserStepSession` 是否仍是唯一 Network 交接面，未引入第二套业务状态机。

## 接口、数据与依赖影响

- 优先不改公共类型名称和持久化结构；若 transition 语义改变，必须同步所有生产者、消费者和测试。
- 不增加依赖，不保存 Agent history/checkpoint，不扩大 Browser action union。

## 验证与退出条件

```bash
uv run --frozen python -m unittest \
  tests.test_browser_agent_control \
  tests.test_browser_challenge_lifecycle \
  tests.test_browser_agent_integration
```

退出条件：Task 全部完成；直接测试通过；审查确认“动作结果”和“最终 PDF 结果”已经分离；下游可以依赖明确的继续/终止语义。

## 失败与下游交接

若需要新增持久状态、跨进程消息或 Agent 直接控制 vendor object，停止并回到根 README 的“大架构变更判定门”。Block 02 只接收已稳定的继续/终止合同，不接收临时测试分支。

## 完成证据

已完成证据：

- 相关回归命令：`uv run --frozen python -m unittest tests.test_browser_agent_control tests.test_browser_challenge_lifecycle tests.test_browser_agent_integration tests.test_network_browser tests.test_network_playwright_control tests.test_browser_connect tests.test_network_cloakbrowser_local tests.test_acquisition_browser tests.test_acquisition_pdf_identity tests.test_tiered_acquisition_service`；`Ran 172 tests in 10.619s`，`OK (skipped=1)`。
- 通过的行为：页面状态交给 Agent；无变化/重复动作不自动形成 `no-progress`；候选失败可继续下一动作；旧 revision 动作不重放；Stop、取消、超时和 safety fuse 保持独立结果。
- 未覆盖：真实 Provider、真实出版社页面、真实用户 Profile 和真实凭据，留待单独授权的现场计划。
