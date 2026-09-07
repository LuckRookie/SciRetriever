# Block 2：Network 原子 Step Engine

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | BSB06–BSB11 |
| 前置块 | Block 1 Completed |
| 下游块 | Block 3 Acquisition 与 Controllers 收敛 |
| 恢复点 | BSB06–BSB11 已完成；Network 是唯一瞬态生命周期 owner |

## 块结果

Network 提供唯一的 article-local `start/apply` engine。它在一次调用内完成 Observation readiness、精确
action binding、vendor dispatch、page/frame replacement、quiet settlement、capture Candidate 与终态
收敛，只把稳定 step result 交给调用方。

## 进入条件

- Block 1 的类型与时序测试已通过；
- 五类稳定结果和 reason owner 已冻结；
- stale、candidate、receipt、page successor 被确认是 Network 私有事实；
- 当前 Network/Cloak/Playwright 直接测试 baseline 已记录。

## 责任与改动面

- Owner：Primary Agent；
- 主要文件：`network/browser_control.py`、`network/browser.py`，必要的 `network/playwright.py`、
  `network/cloakbrowser.py` 仅在中性 runtime 信号缺失时修改；
- Network 拥有：snapshot、readiness、action validation/dispatch、settlement、capture/cleanup、step terminal；
- 受保护：request/destination/DNS/host admission、Browser broker、fixed Profile、byte limit、late callback drain。

## 需要保持的行为

- 初始导航和动作后 capture 均优先于再次调用 chooser；
- `DEFER` Candidate 不读取正文、不发布、不泄漏为空白 Ready；
- page replacement 重新绑定当前安全页面，旧 action 绝不重放；
- 每个 step 有界，cancel 能打断等待并确定性 cleanup；
- debug 可保留内部阶段，但普通调用方和日志不需重建 transition 状态机。

## Tasks

- [x] **BSB06 — 实现唯一 Step session。** 将当前 control state 封装为 article-local session，暴露
  `start()` 和 `apply(action)`，强制 Ready-only continuation 和终态后拒绝调用。
  - 验收：错误 article/revision/action、重复 start、terminal 后 apply 均在 dispatch 前稳定失败。
- [x] **BSB07 — 收回初始 readiness。** 把初始 observe/quiet/candidate/page replacement 循环合并到
  `start()` 内部。
  - 验收：调用方只看到 Ready 或四种终态，初始 stale/Candidate 不跨界。
- [x] **BSB08 — 收回动作 settlement。** `apply()` 内完成 pre-dispatch refresh、binding、一次 dispatch、
  quiet/capture settlement 和下一结果。
  - 验收：异步变化与无变化均只返回一次稳定结果；vendor action 计数准确。
- [x] **BSB09 — 统一自然阻断与失败。** 把 terminal page、Stop、candidate timeout 映射为 Blocked reason，
  runtime/policy/timeout/cleanup 映射 Failed，cancel 映射 Cancelled。
  - 验收：failure 不被普通未命中遮蔽；payload-free reason 可由 Acquisition 映射用户结果。
- [x] **BSB10 — 私有化 transient 类型。** 将 stale、settled、candidate、receipt 等保留为私有实现或内部
  debug event，移除公共 Protocol 对其依赖。
  - 验收：`network.browser_control` 的消费方无法编排 settle/execute；生产路径只有一套 engine。
- [x] **BSB11 — 回归 runtime 与资源生命周期。** 覆盖 Playwright/CloakBrowser page replacement、response/
  download capture、late event、cancel、timeout 和 cleanup。
  - 验收：body read、capture、delete/close、callback drain 和 permit release 计数保持既有不变量。

## 执行方式与集成点

顺序为 session invariant → start → apply → terminal mapping → transient 私有化 → adapter/resource 回归。每个
切片先运行 Network 直接测试。Block 3 的唯一集成点是稳定 step Protocol，不暴露内部 wait primitive。

## 审查门

- 进入：Block 1 完成且没有 unresolved reason；
- 切片：检查 bounded wait、dispatch count、current observation 和 cleanup owner；
- 退出：公开调用图无 observe/settle/execute，所有 transient 只在 Network；
- 阻断：内部重试可能重复动作、Candidate 可无限悬挂、ACCEPT 前读取正文、异常默认允许。

## 接口、数据与依赖影响

- 接口：Network control session 一次性切换为 step engine；
- 数据/schema/config：无；所有 state operation-local 且不可序列化；
- 依赖：无预期；
- 打包：模块路径保持，删除类型后由 wheel/full 验证无遗漏。

## 验证与证据

```bash
uv run --frozen python -m unittest discover -s tests -p 'test_network_browser.py'
uv run --frozen python -m unittest discover -s tests -p 'test_network_playwright_control.py'
uv run --frozen python -m unittest discover -s tests -p 'test_network_cloakbrowser.py'
uv run --frozen python -m unittest discover -s tests -p 'test_network_cloakbrowser_local.py'
uv run --frozen python -m unittest discover -s tests -p 'test_network_cloakbrowser_challenge_local.py'
```

## 退出条件

- BSB06–BSB11 完成；
- start/apply 全部 characterization 与安全反例通过；
- Network 之外没有 transient lifecycle consumer；
- Network 不含 Publisher/DOI 业务知识；
- 资源与取消路径没有新增泄漏。

## 完成证据

- `test_network_browser.py` 87 项、`test_network_playwright_control.py` 6 项、
  `test_network_cloakbrowser.py` 31 项全部通过，并由最终 Full 再次覆盖。
- Transition driver 已改为 Network 私有 `_BrowserTransitionDriver`；transition、driver 和 ledger 不在
  `network.browser_control.__all__` 中，跨模块只导出 Step 合同。
- 本地真实 CloakBrowser fixture 未设置显式 opt-in 环境变量，按测试合同跳过；未连接真实站点、Profile
  或凭据。

## 失败与恢复

若 vendor adapter 缺少可靠变更信号，先保留 failing fixture 并证明最小中性缺口；不得用固定 sleep 或
Acquisition reclassification 绕过。恢复从最近通过的 Network 测试切片继续。

## 下游交接

Block 3 获得唯一 step session、五类稳定结果、通过的 runtime/capture/cleanup 证明；不得调用或导入任何
Network 私有 settlement helper。
