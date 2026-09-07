# Block 03：Agent controller 与 PydanticAI 单次 adapter

## 块身份

| 字段 | 值 |
|---|---|
| 状态 | `Completed`（2026-09-06） |
| Owner | `/root` |
| 前置块 | Block 01 R3、Block 02 R3 |
| 下游块 | Block 04 Acquisition、Block 05 验证 |
| 恢复点 | fake model 对稳定 step 的单次调用测试通过后 |

## 块结果

Agent 看到一份稳定、文章绑定的 Observation，输出一个严格结构化的封闭动作；Acquisition 控制下一次 `start/apply`，而不是把 Browser 状态机搬进 Agent。PydanticAI 若作为 SDK 采用，只存在于 provider adapter 边界，仍返回既有 `AgentRuntime` 中性结果。

## 进入条件

- Block 02 已证明每个 `Ready` 都是稳定页面，`apply` 能处理 stale 和终态。
- `AgentRuntime.execute` 的无状态一次调用合同和 model capability/readiness 已冻结。
- 已确定不使用 SDK 高层 Agent loop、tool registry、persistent session 或自动业务重试。

## 责任与改动面

- Owner：`src/sciretriever/agents/api.py`、`runtime.py`、`providers/`、`capabilities.py`、`failures.py`、可选 `debug.py`，以及 Acquisition 的 controller/prompt adapter。
- 依赖边界：`pyproject.toml`/`uv.lock` 只有在 SDK 适配验证通过后修改。
- 受保护：Analysis 的两阶段业务控制器、既有 Provider-neutral Runtime public surface、Debug 图片脱敏和日志合同。

## 需要保持的行为

- Runtime 每次 `execute` 只处理一项中性 call；不保存 history、turn、跨文章 token/image/time 或业务状态。
- stream/timeout/reasoning 等模型设置继续由既有 Model/Runtime 合同管理；Agent prompt 不复制供应商 wire 参数。
- 模型不能改变 ArticleGoal、PDF 验收、文章身份、candidate accept/reject 或数据库事实。
- 任何 provider/SDK 错误都保留稳定失败上下文，不静默回退到旧 transport 或旧规则。

## Tasks

- [x] **AGC01 — 定义 Browser decision schema。** 固化单次响应结构：一个封闭动作及其当前 observation binding，必要的简短意图/停止原因，禁止任意 URL、selector、script、text input 和额外工具。
  - 依赖：GBR02、GBR03。
  - 验收：schema 对未知动作、缺少 binding、跨 revision、空/多动作和越权字段稳定拒绝。

- [x] **AGC02 — 重写 Browser prompt/context builder。** 将 ArticleGoal、稳定 Observation、允许动作、上一动作 receipt、candidate pending/accepted/rejected(reason) 反馈和终止语义组织成 provider-neutral message。
  - 依赖：AGC01、GBR04。
  - 验收：prompt 明确目标模型名/URL 不被伪造；不把 query、Cookie、真实凭据、vendor object 或未经验证的“已下载”写入上下文。

- [x] **AGC03 — 保持“一次 Ready 一次决策”。** Controller 在每个 `Ready` 上调用一次 `AgentRuntime.execute`，收到 action 后只调用一次 `apply`；stale/新 Ready 进入下一轮，不在同一轮重放。
  - 依赖：AGC01、AGC02、GBR01。
  - 验收：fake model 调用次数等于稳定 Ready 次数；页面 transition、candidate pending、模型失败和用户取消不产生隐藏循环。

- [x] **AGC04 — 评估 PydanticAI provider adapter（可选依赖）。** 若 SDK 能复用既有 Network/credential/stream/timeout 边界，则用 PydanticAI 解析严格响应；否则保留当前 adapter，不为了引入 SDK 改变公共合同。
  - 依赖：AGC01、现有 AgentRuntime provider adapter 盘点。
  - 验收：fake transport 下 provider-neutral `AgentCall → AgentStructuredResult` 与现有协议等价；SDK 不导出到 Acquisition，错误不回退到旧路径。

- [x] **AGC05 — 重构 Agent 失败和终态映射。** 区分 provider/model failure、invalid action、repeated self/cycle、Stop、candidate timeout、page terminal、controller safety、cancel；将结果交回 Acquisition，不替它判断 PDF。
  - 依赖：AGC03、GBR05。
  - 验收：同一失败原因在 report 中可读；generic Stop 不覆盖更强的 page/capture 失败；不再出现旧 `BUDGET_EXHAUSTED`/Challenge 专属状态族。

- [x] **AGC06 — 更新 debug 可观测性。** 在 debug 模式保存安全的 observation 摘要、模型输入/输出 hash 和截图引用，保留每步 article/revision 关联；默认日志不包含图片、URL query 或凭据。
  - 依赖：AGC02、既有 `agents/debug.py` 和日志合同。
  - 验收：fixture 测试可定位“模型看到什么/返回什么/Browser 实际执行什么”，但 debug artifact 不进入仓库或长期数据库。

## 执行方式与集成点

先完成 AGC01–AGC03 的 fake model 闭环，再评估 AGC04 是否引入依赖；AGC05/06 在一次决策闭环稳定后完成。Block 03 不修改 Network transition，不在 Agent 层增加页面等待、点击重试或 PDF 解析。

## 审查门

- R1：确认 Agent 输入/输出是中性 schema，未把 Browser vendor 类型或 Publisher selector 传给模型。
- R2：检查 prompt、schema、调用计数、stream/timeout/error 传播和图片 debug 脱敏。
- R3：fake model、invalid response、provider failure、stale、Stop、cycle、candidate feedback 和 cancel 全部有直接测试。

## 接口 / 数据 / 依赖影响

- 接口：新增 Browser decision schema；`AgentRuntime` 维持窄腰；删除旧 Agent Browser loop/session API。
- 数据：不持久化 Agent history、prompt 正文、截图或候选状态。
- 依赖：可能新增 `pydantic-ai`；仅在 transport/capability/stream 行为通过测试后锁定版本。

## 验证与证据

- `tests/test_agents.py`、`tests/test_agents_providers.py`、`tests/test_browser_agent_control.py` 及新增 fake model 测试。
- 断言一次 Ready 一次 execute/apply、严格 schema、stream 结果重组、错误分类和 debug artifact 脱敏。
- Provider SDK 的测试只用 fake transport，不使用真实 key 或真实 endpoint。
- 证据记录调用计数、终态映射和模型输入字段集合，不记录 secret。

## 退出条件

- Browser controller 能在无 Publisher rule fixture 上完成多步决策；
- PydanticAI（若启用）仅是 adapter，未引入第二状态机或兼容 fallback；
- 所有失败/取消/候选反馈可被 Acquisition 消费；
- Block 03 R3 通过。

## 完成证据

- 未引入 PydanticAI。现有 `AgentRuntime.execute` 与 provider adapters 已提供 provider-neutral、无状态、
  单次结构化调用边界；引入 SDK 不会减少本次 Browser 合同复杂度，反而需要重做已经受测的 transport、
  stream、timeout 和错误映射。因此 AGC04 按原计划的“否则保留当前 adapter”分支完成，无依赖或锁文件变化。
- `AgentBrowserController` 对每个稳定 `BrowserReady` 只发起一次模型调用，并只把一个绑定当前 observation
  的封闭动作交给 `apply`；fake runtime 验证调用数、32 次安全上限、stale、cycle、Stop、candidate timeout、
  provider failure 和 cancel。
- Browser 单次模型输出预算为 131072 tokens；该值属于 Browser 任务容量，不改变用户配置中的模型能力事实。
- debug artifact 保存脱敏 observation/model input-output hash、step 关联和截图引用；默认日志不写入图片、
  URL query、凭据或完整 prompt。
- 直接回归 307 项、Quick 及 Full 均通过；真实 LLM 未调用。

## 失败与恢复

若 SDK 需要接管 loop、无法遵守一次调用或隐藏重试，撤回 AGC04，仅保留现有 adapter；若模型输出无法在六种动作内表达，回到 Block 01/02 评估 observation/action 合同，不开放任意工具。

## 下游交接

Block 04 获得可调用的 generic Agent controller、终态/feedback 合同和无规则页面策略；Block 05 获得 fake model、debug/replay 证据入口。
