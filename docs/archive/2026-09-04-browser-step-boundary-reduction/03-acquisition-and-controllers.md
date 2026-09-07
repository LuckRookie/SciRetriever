# Block 3：Acquisition 与 Controllers 收敛

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | BSB12–BSB17 |
| 前置块 | Block 2 Completed |
| 下游块 | Block 4 验证、文档与交接 |
| 恢复点 | BSB12–BSB17 已完成；Acquisition 只消费稳定 Step |

## 块结果

Acquisition 只拥有 Publisher/article policy、Rules/Agent action chooser 和稳定业务结果映射。
`_PublisherAgentControl._reclassify*` 及七类 Network transition 到八类 Agent disposition 的双层状态机被
删除；Agent 通过唯一 step engine 操作稳定界面。Rules 保留受审 selector/locator 程序，与 Agent 共享
Network 的 Browser flow、capture、timeout、cancel 和 cleanup owner，但不共享越权的动作 API。

## 进入条件

- Network `start/apply` 合同与直接测试已通过；
- Blocked/Failed/Cancelled reason 能覆盖现有 route/report 语义；
- capture 与页面 classification policy 注入点已明确；
- 旧 Acquisition 主循环 baseline 与模型调用/cycle 测试已记录。

## 责任与改动面

- Owner：Primary Agent；
- 主要文件：`acquisition/browser_control.py`、`acquisition/sources/browser.py`、Publisher rule helper/model、
  必要 Bootstrap 组装和 Acquisition/Agent Browser 测试；
- Acquisition 拥有：article identifiers、Publisher classification、action choice、semantic progress/cycle、
  route/report 映射和 PDF 二次验收；
- 受保护：Agent prompt/tools、32-call fuse、Rules/Agent 固定选择、Cohort partial failure 和 Catalog publication。

## 需要保持的行为

- Agent 每次 Ready 形成一次独立模型调用；模型在飞行期间 capture 到达时不执行过时动作；
- semantic no-progress/cycle 基于稳定页面与动作 intent，不以像素/revision 抖动计算进展；
- Rules 不调用模型，Agent 不执行确定性 fallback；
- login/MFA/not-entitled/not-found 等终态保留准确 failure/report；
- 捕获结果仍由当前 Publisher rule 二次确认后才成为主 PDF。

## Tasks

- [x] **BSB12 — 注入 Publisher step policy。** 用一个 operation-local policy 在 session 创建时提供页面与
  capture 分类，删除对 Network transition 的事后解释。
  - 验收：policy 只消费中性 snapshot/evidence；Network 不导入 Acquisition 类型。
- [x] **BSB13 — 简化 Agent chooser 循环。** 主循环变为 start → decide → apply，只在 Ready 上构造模型
  调用并保留 semantic progress/cycle/safety fuse。
  - 验收：一次 decision 只对应一次 apply；模型飞行期间变化由 apply 原子收敛且过时 action 不 dispatch。
- [x] **BSB14 — 保持 Rules/Agent 权限隔离并共享 Network owner。** Rules 继续使用有限、受审的 selector/
  locator 能力；Agent 只使用六种 observation-bound action。二者复用同一 Browser flow 和 Network
  capture/timeout/cancel/cleanup 生命周期，不建立第二套 transport 状态机。
  - 验收：Rules 模式无模型调用；Agent 未新增 selector、URL、script 或 text-entry；既有 Provider 规则、
    capture 和资源清理结果保持。
- [x] **BSB15 — 收敛 Controller result。** 删除八类 disposition/五类 terminal cause 的重复组合，只保留
  controller 统计和对稳定 Browser result 的薄映射。
  - 验收：action/model count、last action 和具体 failure 可解释；不存在非法交叉组合。
- [x] **BSB16 — 删除 Reclassification 与旧桥接。** 删除 `_reclassify*`、旧 factory/session Protocol、
  transition imports 和仅验证机械转换的测试。
  - 验收：`rg` 无生产调用方；不保留兼容 adapter 或两套主循环。
- [x] **BSB17 — 回归 route/report 与 PDF 验收。** 覆盖正常未命中、阻断、失败、取消、capture handoff、
  Cohort partial failure 和发布。
  - 验收：最深具体失败仍正确，错误 PDF/补充材料/损坏字节继续拒绝，已提交事实不回滚。

## 执行方式与集成点

先 policy 注入，再 Agent chooser，再 Rules chooser，随后收敛结果并删除旧路径，最后验证 route/report。
每个切片同时修改生产者、消费者与直接测试，不留下跨 Block 的临时兼容层。

## 审查门

- 进入：Network engine 唯一且稳定；
- 切片：检查模型调用与 apply 一一对应、policy owner、no-progress/cycle 证据；
- 退出：Acquisition 不见 transient lifecycle，Rules/Agent 无第二 engine；
- 阻断：需要恢复 settle/observe、需要放宽 Agent 工具、或 failure mapping 改变批量/发布语义。

## 接口、数据与依赖影响

- 接口：删除旧 Acquisition control factory/transition mapping，controller 只消费 step session；
- 数据/schema/config：无；
- Agents Provider/Model：无变化；
- Publisher profiles：仅在合同表达确有变化时更新版本，不能为测试机械升级；
- 依赖：无。

## 验证与证据

```bash
uv run --frozen python -m unittest discover -s tests -p 'test_browser_agent_control.py'
uv run --frozen python -m unittest discover -s tests -p 'test_browser_agent_integration.py'
uv run --frozen python -m unittest discover -s tests -p 'test_browser_challenge_lifecycle.py'
uv run --frozen python -m unittest discover -s tests -p 'test_acquisition_browser.py'
uv run --frozen python -m unittest discover -s tests -p 'test_acquisition_cohorts.py'
uv run --frozen python -m unittest discover -s tests -p 'test_entry_completion.py'
```

## 退出条件

- BSB12–BSB17 完成；
- Agent 只使用 start/apply；Rules/Agent 的权限面明确隔离且共享 Network 生命周期 owner；
- reclassification、旧 transition consumer 和重复 disposition 不再存在；
- route/report、PDF 验收与安全反例通过；
- 生产 Bootstrap 只组装一套对象图。

## 完成证据

- `test_browser_agent_control.py` 28 项、`test_browser_agent_integration.py` 3 项、
  `test_browser_challenge_lifecycle.py` 14 项、`test_acquisition_browser.py` 67 项、
  `test_acquisition_cohorts.py` 23 项和 `test_entry_completion.py` 43 项全部通过。
- 生产循环现为 `steps.start() -> agent.decide(Ready.observation) -> steps.apply(action)`；Acquisition
  不再调用 `observe/settle/execute`，也不解释 stale、Candidate 或 page replacement。
- `BrowserAgentDisposition`、`BrowserAgentTerminalCause`、`_reclassify*` 和旧 `control_session()` 已从生产
  调用图删除；`BrowserAgentResult` 仅保存稳定 Step 与必要计数。
- Rules 保留受审 selector/locator 权限，Agent 仍只有六种 observation-bound 动作；二者没有相互 fallback。

## 失败与恢复

若某项现有 rule 依赖同步 selector API，先记录具体调用与可表达的封闭动作，不把整个旧 `BrowserFlowSession`
作为旁路保留。若 route/report 语义回归，停在 BSB17 并保留新 engine，不用恢复双层状态机掩盖。

## 下游交接

Block 4 获得唯一生产对象图、通过的直接/集成测试、待同步的目标/当前行为文档清单和明确的无数据迁移结论。
