# Block 1：Step 合同与行为基线

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | BSB01–BSB05 |
| 前置块 | 无；计划已获准 |
| 下游块 | Block 2 Network 原子 Step Engine |
| 恢复点 | BSB01–BSB05 已完成；合同、时序与直接测试已冻结 |

## 块结果

以直接测试冻结五类稳定结果和关键时序，并确定 Network/Acquisition policy/chooser 的唯一接口。Block 2
不需要再猜测 loading、stale、Candidate、terminal 和 failure 应由谁解释。

## 进入条件

- 已确认用户目标是减少 Agent–Browser 交接复杂度，而不是放宽网页适配或安全边界；
- 已读取 R3、ADR 0017、Acquisition/Network 技术文档和当前生产调用方；
- 当前脏工作树及此前 Browser/capture 修改均作为受保护 baseline。

## 责任与改动面

- Owner：Primary Agent；
- 主要文件：`network/browser_control.py`、`network/browser.py`、Network/Acquisition Browser 直接测试，
  必要时 ADR 0017 的接口 amendment；
- 生产者：Network Browser flow；消费者：Acquisition Rules/Agent controller；
- 受保护：现有 action/observation binding、capture policy、PDF 验收、cancel/cleanup 和用户工作树。

## 需要保持的行为

- stale action 在 vendor dispatch 前拒绝；
- 页面变化必须达到现有 quiet/readiness 语义才可再次交给 chooser；
- Candidate 在捕获、明确拒绝或超时前不交给 Agent；
- login/MFA/not-found 等页面状态和 `Stop`/no-progress/cycle 仍能形成具体结果；
- 安全 failure 不退化成 normal miss。

## Tasks

- [x] **BSB01 — 刻画现有跨层状态机。** 用调用图和现有测试确认每个 transition、disposition、
  reclassification 的实际生产者、消费者与用户语义。
  - 验收：能够区分应私有化的 transient 与必须保留的稳定结果；无未审查调用方。
- [x] **BSB02 — 冻结 Step result 合同。** 定义 `Ready / Captured / Blocked / Failed / Cancelled`、
  payload-free reason、receipt/observation 可见性和 session 生命周期。
  - 验收：非法组合构造失败；只有 Ready 可继续 apply；非 Ready 全部终止。
- [x] **BSB03 — 冻结初始收敛时序。** 添加初始稳定页面、初始 capture、page replacement、terminal page、
  candidate timeout、cancel/failure 的 characterization。
  - 验收：调用者只收到一次稳定 step，不看见 stale/candidate 中间事件。
- [x] **BSB04 — 冻结动作原子时序。** 添加 stale-before-dispatch、异步 capture、no-change、稳定变化、
  destination failure 和 cleanup 的 characterization。
  - 验收：每个动作最多一次 vendor dispatch；旧动作不在新 observation 上自动重放。
- [x] **BSB05 — 冻结 policy 与 chooser 边界。** 用 fake policy/chooser 证明 Publisher 只分类中性页面/capture
  事实，Rules/Agent 只在 Ready 上选动作。
  - 验收：Network 不出现 Publisher/DOI 分支；chooser 不见 vendor object、Candidate 或 settle primitive。

## 执行方式与集成点

依次完成现状调用图、类型合同、初始时序、动作时序、policy/chooser。优先改直接测试和新中性类型；在
合同通过前不改 Acquisition 主循环。唯一交接是经测试的 step Protocol，不建立旧/新长期 adapter。

## 审查门

- 进入：确认所有 `BrowserTransition` 和 `BrowserAgentDisposition` 调用方；
- 切片：每个结果检查是否稳定、是否可继续、是否泄漏 vendor/transient；
- 退出：五类结果覆盖现有用户语义，且不存在用 `Blocked` 吞 failure 的情况；
- 阻断：需要任意 URL/selector/vendor object，或无法保持 stale-before-dispatch。

## 接口、数据与依赖影响

- 内部接口：新增唯一 step result/session Protocol；旧类型在 Block 3 删除；
- 数据/config/schema：无；
- 依赖：无；
- 文档：必要时先 amendment ADR 0017 的目标边界，当前行为文档留到 Block 4。

## 验证与证据

```bash
uv run --frozen python -m unittest discover -s tests -p 'test_network_browser.py'
uv run --frozen python -m unittest discover -s tests -p 'test_browser_agent_control.py'
uv run --frozen python -m unittest discover -s tests -p 'test_browser_agent_integration.py'
```

测试必须断言 step 类型、vendor dispatch 次数、模型调用次数、body read/capture/cleanup 次数，不能只断言
异常文字。

## 退出条件

- BSB01–BSB05 完成；
- 新合同及关键 characterization 通过；
- owner、reason、timeout、cancel 和 stale 语义无开放歧义；
- Block 2 可只在 Network 内实现 settlement。

## 完成证据

- `test_browser_agent_control.py` 28 项、`test_browser_agent_integration.py` 3 项、
  `test_network_browser.py` 87 项全部通过，并由最终 Full 再次覆盖。
- 直接测试证明重复 `start()`、未 start 的 `apply()`、终态后 `apply()` 均被拒绝；初始 capture、
  Candidate timeout、terminal page、cancel 与 runtime failure 只暴露五类稳定结果。
- 一个动作最多产生一次 vendor dispatch；模型飞行期间页面变化会拒绝旧绑定，不自动重放动作。

## 失败与恢复

合同覆盖不足时停在失败测试，不把 transient 重新写入公共结果。若发现用户可见语义无法归入五类，记录
具体反例并回根计划设计门。恢复从首个未完成 BSB Task 继续。

## 下游交接

Block 2 只能依赖测试冻结的 step 类型、reason 分类、timeout/cancel 语义和 action binding；不得依赖
Block 1 的临时 fake 或旧 transition adapter。
