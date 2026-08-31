# Block 02：无状态 Agents Runtime

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | ABC08–ABC16 |
| 前置块 | Block 01 |
| 下游块 | Block 03、Block 05 |
| 恢复点 | Block 01 已通过的目标合同 |

## 1. 块结果

`agents/` 成为 Provider-neutral 的窄腰：消费者提交一次 `AgentCall`，`AgentRuntime` 根据 role binding 选择 model，验证 capability 与客观单次限制，调用一个 Provider adapter，并返回严格结构化结果或一个 tool call。公共面不包含 session、history、workflow 或累计作业状态。

## 2. 进入条件

- Block 01 Completed；
- ADR/technical 已固定 Runtime、Call、Result、Port、binding 和 readiness 的 owner；
- Analysis 与 Browser 两个调用形态的真实需求已经由直接调用方和测试核实。

## 3. 责任与改动面

- Owner：`src/sciretriever/agents/`；
- 主要文件：`api.py`、`capabilities.py`、`messages.py`、`tools.py`、`calls.py`、`runtime.py`、`ports.py`、`failures.py`、`providers/`；
- 删除目标：`requests.py`、`sessions.py` 及其公共导出；
- 测试：`tests/test_agents.py`、`tests/test_agents_contracts.py`、`tests/test_agents_providers.py`、架构 cutover tests；
- 受保护工作：Provider HTTP 安全、secret origin binding、AccessScope、稳定失败、usage/provenance hash 和三协议 fake 行为。

## 4. 需要保持的行为

- OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 三种协议；
- 严格 JSON、tool schema、图片媒体/尺寸/字节、请求/响应字节、context/output、HTTP timeout、取消与不可证明幂等 POST 不重试；
- Provider/account quota scope 与 Network 安全访问；
- prompt、模型原文、图片和 secret 不进入日志或 repr；
- Analysis-ready 与 Browser-ready 独立判断。

## 5. Tasks

- [x] **ABC08 — 拆分公共值对象。** 将 messages、calls/results、tools、capabilities 分到职责清晰的模块，保持 Provider 与业务对象不可越界。
  - 验收：公开 `api.py` 只导出消费方需要的中性类型；provider adapter 和业务枚举不泄漏。

- [x] **ABC09 — 定义 `AgentCall`。** 调用只携带 role、messages、required capabilities、严格 response schema 或 tools、输入 hash和单次 max output。
  - 依赖：ABC08。
  - 验收：Call 不含 provider、base URL、model、session history、turn、job budget 或 Browser/Analysis 业务 kind。

- [x] **ABC10 — 定义单次结果。** 保留严格结构化 result、tool call、usage、输入/参数 hash 和脱敏 provenance，不引入 turn/session/job 事实。
  - 依赖：ABC08。
  - 验收：结果不可变、严格解析，provider 原始响应与 reasoning 不越界。

- [x] **ABC11 — 实现 `AgentRuntime.readiness(role)`。** 由角色 binding 和模型 capability 给出纯本地 readiness。
  - 依赖：ABC09、ABC10。
  - 验收：缺配置、协议不支持、模型未声明和 capability 缺口可区分，调用计数仍为零。

- [x] **ABC12 — 实现 `AgentRuntime.execute(...)`。** Runtime 根据 role 选择 model/binding、验证 capability 与单次限制、构造内部 wire call 并调用唯一 adapter。
  - 依赖：ABC11。
  - 验收：消费者不传 model；错 role/model capability 在 I/O 前失败；取消信号只属于本次 execute。

- [x] **ABC13 — 固化 Provider Port。** Adapter 只转换 Runtime 已绑定 model 的 wire protocol，不理解文献、Publisher 或 Browser loop。
  - 依赖：ABC12。
  - 验收：三协议请求/响应 fake、secret forwarding 和 failure mapping 保持通过。

- [x] **ABC14 — 保留客观单次限制。** 把 context window、单次 max output、请求/响应/结果字节和 HTTP timeout 明确为 call/adapter limits，删除跨调用累计 budget。
  - 依赖：ABC12、ABC13。
  - 验收：没有 session/job token、image、wall-clock 累加器；单次 oversize/context/timeout 仍稳定失败。

- [x] **ABC15 — 关闭 Session 新公共面并冻结迁移边界。** `agents.api` 不再向新消费者提供 `AgentSession/open_session`；旧实现只允许开始本块时已经存在的 Analysis、Browser controller 和 Configuration probe 调用方在各自迁移块内继续存在，不允许任何新代码依赖。
  - 依赖：ABC12–ABC14。
  - 验收：新 Runtime 的公开 API 和测试不含 Session；精确 `rg` 固定遗留调用方清单及其迁移 owner：Analysis/ABC21、Browser/ABC35、Configuration probe/ABC47，最终文件和导出删除由 ABC51 接收。

- [x] **ABC16 — Agents 直接测试闭环。** 更新测试覆盖 role binding、readiness、structured/tool 分流、取消、capability、Provider 失败、hash/usage 和无 Session 公共面。
  - 依赖：ABC08–ABC15。
  - 验收：三组 Agents 测试与架构 cutover 测试通过，相关 Ruff/Pyright 无错误。

## 6. 执行方式与集成点

按“值对象 → Runtime/readiness → Provider wire port → 单次技术限制 → 公共面冻结 → 直接测试”串行推进。每一步保持 Agents 自身测试可运行；ABC15 只关闭新公共面并冻结旧 Analysis 调用边界，不在消费者迁移前物理删除 `sessions.py`。

本块不单独形成最终迁移完成点；它在 I1 与 Block 03 汇合。Block 02 退出时新公共面必须稳定，旧 Session 的精确调用方必须分别登记到 ABC21、ABC35、ABC47，并由 ABC51 统一接收物理删除责任。

## 7. 审查门

- R1：Block 01 的 Runtime/Port/role binding 合同已通过，三协议与调用方事实未漂移；
- R2：每个切片审查 Provider 细节、model 选择、business kind、history 或累计状态是否泄漏到公共 Call；
- R3：新 Agents API/测试不依赖 Session，Provider 安全与失败行为保持，旧调用边界精确冻结；
- I1 只有 Block 03 删除最后 Session 调用并通过 Analysis tests 后才通过。

## 8. 接口、数据与依赖影响

- 破坏性内部 Python API：`AgentRequest/AgentSession/open_session` 被新 Call/Runtime 合同替代；不保留兼容层；
- Provider wire call 是 Agents 内部类型，不成为公开或持久合同；
- 无数据库、资产、凭据 schema 或外部依赖变化；
- `uv.lock` 预计不变。

## 9. 验证与证据

- `uv run --frozen python -m unittest tests.test_agents tests.test_agents_contracts tests.test_agents_providers tests.test_architecture_cutover`；
- 对 `src/sciretriever/agents` 和上述测试运行 Ruff/Pyright 相关路径；
- `rg` 检查 Provider/business/vendor 依赖方向和旧 session 符号；
- fake adapter 调用计数证明 I/O 前拒绝。

## 10. 退出条件

- ABC08–ABC16 全部勾选；
- 新 Runtime 直接测试通过且没有面向新消费者的 Session 公共面；
- Provider adapter 的网络安全、失败和 provenance 行为未回归；
- Block 03/05 可只依赖 `agents.api` 与稳定失败。

## 11. 完成证据

- 新增 `messages.py`、`tools.py`、`calls.py`、`runtime.py`，收窄 `api.py`，并在
  `ports.py`/`providers/` 建立 Runtime-bound `AgentProviderCall.execute` 路径；三种 Provider
  adapter 复用既有安全 HTTP 与协议转换机械逻辑，没有复制 transport 或引入业务依赖。
- `AgentCall` 不含 Provider、Base URL、model、credential、session、history、turn、budget 或
  cancel state；`agents.api.__all__` 不导出 `AgentBudget`、`AgentRequest`、`AgentSession`、
  `AgentPort` 或 `open_session`。
- `readiness(role)` 纯本地表达 role 是否配置、protocol 是否支持、model 是否声明及 capability
  缺口；直接测试使用 adapter 调用计数证明 readiness、取消、capability、context/image 与
  request 限制在外部 I/O 前失败。
- Runtime 校验返回的类型、声明 tool、provider/model/input hash、usage、response/result/context
  单次限制；OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 的 structured/image
  与 tool fake wire 路径均通过。
- 直接命令：

  ```text
  uv run --frozen python -m unittest tests.test_agents tests.test_agents_contracts tests.test_agents_providers tests.test_architecture_cutover
  Ran 80 tests — OK

  uv run --frozen python -m unittest tests.test_analysis_content_proposal tests.test_analysis_metadata_stage tests.test_analysis_reference_lookup tests.test_browser_agent_control tests.test_browser_agent_integration tests.test_bootstrap_readiness
  Ran 116 tests — OK

  uv run --frozen ruff check <Block 02 paths>
  All checks passed

  uv run --frozen ruff format --check <Block 02 paths>
  22 files already formatted

  uv run --frozen pyright <Block 02 paths>
  0 errors, 0 warnings, 0 informations

  git diff --check -- <Block 02 paths> docs/plans
  exit 0
  ```
- R2 finding：最初的对象图无法区分“role 已配置但 model 未声明”和“role 未配置”；通过
  `configured_roles` 的纯本地声明修复，并由 Bootstrap 传入本次配置的 role 集合。复验通过。
- 迁移窗口：`requests.py`、`sessions.py`、包根旧导出、Runtime 临时 `complete` 与 Provider
  临时 `complete` 尚存在，只供开始本块时已有的 Analysis、Acquisition Browser controller 和
  Bootstrap Configuration probe 使用。它们分别由 ABC21、ABC35、ABC47 迁移，ABC51 统一物理
  删除；没有把此窗口写入 `agents.api` 或允许新消费者依赖。
- 本块未运行 Quick/Full；按计划由 Block 08 在全部迁移和旧文件删除后运行。无数据库、凭据、
  外部 Provider、真实 LLM、Browser Profile、依赖或 `uv.lock` 变化。

## 12. 失败与恢复

- 若 Provider adapter 需要 consumer 才知道的业务字段，先检查 wire boundary，不把字段提升到 AgentCall；
- 若单次技术限制与旧累计 budget 难以分离，优先保持 HTTP/字节安全，删除跨调用状态；
- 失败时回到最近通过的 value/Runtime/adapter 切片，不恢复 Session 兼容层。

## 13. 下游交接

Block 03/05 只接收 `AgentRuntime`、`AgentCall`、结果和稳定失败；model、Provider、HTTP、credential、quota 与协议细节继续封装在 Agents/Bootstrap 内。Block 03 必须在迁移 Analysis 的同一能力切片中删除被 ABC15 冻结的旧 Session 实现和最后调用方。
