# Agents 行为机制与反馈整修计划

> 历史实施记录，非当前产品或架构真相源。当前行为以 requirements、Accepted ADR、current
> docs、源码与测试为准。

## 身份与状态

| 字段 | 值 |
| --- | --- |
| Run ID | `AGENTFIX-20260902` |
| 创建日期 | 2026-09-02 |
| Primary owner | Codex `/root` |
| Baseline revision | `4ea15d51a46cf4f6c9c586fd7ad228fda4086a57` |
| 执行模式 | cross-session；单一 Primary owner；串行实施 |
| 当前状态 | Completed and archived — 2026-09-04；离线实现、文档与 Full Harness 已闭环 |

Baseline 工作树包含用户尚未提交的 Agents、Controlled Browser、Configuration、技术文档和测试改动。
本计划必须在这些改动之上做精确集成，不得回滚、覆盖、格式化掉或顺手提交任务无关工作。

## 目标观察

计划完成后，用户能够观察到以下结果：

- Browser Agent 点击或滚动后会等待页面、capture 和 Network 事件真正稳定，再评价是否有进展；不会把异步页面的第一帧误判为 `no-progress`；
- 页面第一次返回同一语义状态只形成一条“已证明转换”，同一稳定状态再次提出同一稳定动作意图或重复已知循环边时才停止；
- `CANDIDATE` 只表示正在确认的 capture，必须等到 captured、cleared 或 timeout，不能冒充 PDF 已经可用；
- Browser 终态保留具体原因，能区分 Agent Stop、cycle、candidate timeout、resource blocked、page terminal、Provider/Network failure 和 controller safety limit；
- Analysis 在 metadata 或 content 调用期间被取消时，最终操作表现为 interrupted；authentication、quota、timeout、model、refusal 等稳定 Agent 失败不会被压成笼统的 LLM 错误；
- 普通日志能说明阶段、实际 Provider/Model、Browser action/settle、usage、耗时和最终原因，Debug 才显示 revision、fingerprint 和转换证据；最终 Report 保留准确、稳定、可行动的 failure；
- 离线测试走过生产 Browser 对象图中的 action executor、publisher control、Agent controller 和受控 vendor event，而不是由 fake 在动作返回时替实现完成 settle。

目标运行形状保持为：

```text
Shared Agent Invocation
  Validate -> Bind -> Request -> Decode -> Validate -> Result / StableFailure

Analysis Controller
  Metadata -> Content
  无循环、无隐藏重试、无自动 repair

Browser Controller
  Observe -> Decide -> Validate -> Execute -> Settle -> Reclassify -> Evaluate
```

## 授权与真相源

用户于 2026-09-02 要求重点审查 Agents 状态机、行为和反馈，并要求把当前收敛方案写入活动计划；随后于 2026-09-03 明确授权开始实施并持续至任务完成。实施授权覆盖本计划内的源码、测试、ADR/文档和离线验证，不覆盖真实外部请求、个人 credential/Profile/config、Git 提交、push 或发布。

适用真相源：

- [产品需求](../../architecture/requirements.md) R3、R5、R6 与失败/中断边界；
- [ADR 0017](../../architecture/decisions/0017-shared-agents-and-controlled-browser-agent.md) 的无状态 Runtime、消费模块 controller、统一 Observation、封闭动作和自然终态；
- [ADR 0019](../../architecture/decisions/0019-agent-operable-application-and-sdk-model-runtime.md) 的外部 Agent、SDK transport gate、PydanticAI Direct 与 LangGraph 边界；
- [架构设计](../../architecture/design.md) 的模块责任、数据 owner 和生产对象图；
- [Agents 技术文档](../../architecture/technical/agents.md)、[Analysis 技术文档](../../architecture/technical/analysis.md)、[Acquisition 技术文档](../../architecture/technical/acquisition.md)与 [Network 技术文档](../../architecture/technical/network.md)；
- [HARNESS](../../../HARNESS.md) 的工程门禁、真实外部访问和 Git 纪律。

计划组织已接受方向，不自行改写产品需求。Block 1 必须把 execute/settle、capture 中间态、循环证明和安全熔断的长期合同修订进 ADR 0017；在 ADR 修订通过前不得实施相冲突的状态机行为。

## 事实、假设与开放问题

### 已核实事实

- `AgentRuntime` 已经是 Provider-neutral 的单次调用窄腰；Analysis 和 Browser controller 分属消费模块，整体模块划分无需推翻；
- Playwright 点击使用 `no_wait_after=True`，当前 controller 在 action receipt 后立即再次 observe，可能在页面异步变化前判定语义自转换；
- `BrowserActionReceipt.APPLIED` 只证明动作调用返回，不证明页面变化已 settle；生产 executor 的多数失败直接抛出异常，使声明的 `FAILURE` receipt 分支缺少真实合同；
- 当前任何非 `NONE` capture state 都会变成 `CAPTURE_AVAILABLE`，因此 `CANDIDATE` 可被误判为成功，但后续 PDF 路径只接受真正存在的 capture；
- 当前 `semantic_page_fingerprint` 包含短期 opaque ID 和精确 geometry，`ClickPoint` 的 action fingerprint 包含 `screenshot_id`，不足以表示跨 revision 的稳定语义状态与动作意图；
- 当前 transition ledger 只能证明单次 self-loop，不能可靠识别 `A -> B -> A` 后重复已知边；
- 下一次模型调用只看到有限的前一动作 outcome，缺少 dispatch、settle、semantic progress 和 pending capture 反馈；
- Browser terminal failure 使用 first-wins 写入，generic `challenge-unresolved` 可能覆盖更具体的 Network resource block；page failure 也可能在 capture 验证前胜出；
- 当前无总调用或总时长 safety guard；若模型持续给出新的 click point，语义重复检测未必保证最终停止；
- Analysis 将 `agent-cancelled`、Provider 稳定失败和若干未知异常包装成 generic metadata/content LLM failure，导致 Entry 无法准确区分 interrupted、可重试 Provider failure 和内部缺陷；
- `AgentRuntime.provider_name` 不带 role；Analyze 与 Browser 绑定不同 Provider 时，Browser 日志可能显示 Analysis Provider；context 预检还存在 byte/token 混用和 Runtime/adapter 重复；
- Browser controller 直接测试的 fake 会在 execute 后立即换成预制 Observation，integration fake 也没有走真实 `BrowserClient` action executor；现有 `test_proven_semantic_self_transition_stops_without_a_repeat_budget` 明确固化“第一次 settled self-transition 立即停止”的错误行为，基线离线单测运行结果为 `Ran 1 test ... OK`，说明这是被测试保护的错误合同而不是偶发失败。

### 待实施验证的假设

- Network owner 提供统一 execute-and-settle 结果后，Acquisition 可以只评价 settled Observation，而不需要持有 Playwright/CloakBrowser 私有对象；
- 稳定语义 fingerprint 与精确 execution binding fingerprint 分离后，可以同时保证 stale action 安全和跨 revision 的 progress/cycle 识别；
- 把 capture progress 与 semantic progress 分开，可消除 Candidate、Stop、Challenge 和真实 capture 的竞争歧义；
- 保留稳定 `agent-*` Provider failure，再由 Report 的 `stage=analysis` 和日志子阶段补充语境，比复制一套 Analysis Provider failure taxonomy 更清晰；
- 无需引入通用 workflow runtime、持久 Agent turn/history 或新的业务状态库即可完成修复。

### 开放问题

1. **安全熔断的客观阈值。** 方向确定为增加非业务 high-water safety fuse；Block 1 必须在 ADR 0017 中明确它只防止失控消耗，稳定 code 为 `controller-safety-limit`，不是 normal miss、不是 acquisition exhaustion，也不成为复杂用户配置。具体调用数/单作业时长阈值需根据单次 timeout、Publisher lane 和离线压力测试确定。
2. **Provider response model identity。** 当前要求响应 model 与请求 model 字符串完全一致。Block 4 必须先核实 OpenAI Responses、Chat Completions、Anthropic Messages及后续 SDK 对 alias/snapshot 的官方语义；证据不足时保持严格校验，不得为了兼容盲目放宽。
3. **`BrowserTransition` 的最终公开位置。** 类型必须属于 Network/Acquisition 相邻合同且不得携带 vendor 对象；Block 1 在调用方影响分析后确定定义位置，不能把 Browser workflow 下沉到 `agents`。

以上开放问题不改变本计划的模块划分。若证据要求改变模块 owner、引入持久 workflow 或开放 Browser 权限，必须停止并返回新 ADR/用户决定。

## 范围与非目标

### 范围

- `network` 的 Browser action dispatch、settle、capture lifecycle、Observation 与 action binding；
- `acquisition` 的 Browser Agent progress/cycle ledger、模型反馈、typed terminal outcome 与具体 failure；
- `analysis` 的两阶段取消、Agent failure 传播、业务阶段事件和最终 interrupted 语义；
- `agents` 的 role identity、稳定 internal failure、单一 limits 责任和待补证 model identity 校验；
- Bootstrap 生产对象图和相应 fake/fixture 离线集成测试；
- ADR 0017 amendment、技术文档、当前行为文档和必要用户指南同步；
- Report、INFO/DEBUG 与安全诊断的闭环。

### 非目标

- 不迁移到 PydanticAI、Provider SDK 或其它模型 SDK；该工作必须作为独立计划通过 ADR 0019 transport gate；
- 不引入 LangGraph、PydanticAI 高层 Agent、OpenAI Agents SDK、Codex/DeepSeek Harness 到内部 Runtime；
- 不增加 GenericAgent、AgentSession、memory、planner、tool registry、自动 repair、hidden retry 或持久 AgentRun/AgentTurn；
- 不改变 Rules/Agent 作业级互斥选择，不增加 Rules 与 Agent 自动 fallback；
- 不扩大六种封闭 Browser 动作，不开放任意 URL、selector、JavaScript、文本输入、登录/MFA、文件系统、Page/CDP 或事实写入；
- 不改变 Public -> Authorized API -> Browser 的 acquisition 风险顺序、Publisher permit、Network guard、PDF 验收或事实 owner；
- 不持久化 Observation、screenshot、模型决定、transition ledger、失败 turn/history 或新的 provenance；
- 不连接真实 Provider、Browser、MinerU、真实凭据、Profile、用户 Catalog、PDF 或语料；
- 不执行 commit、push、发布、依赖升级或破坏性 Git 操作。

## 全局验收条件

- [x] click/scroll/go-back 后的异步变化经过统一 settle，不因第一帧无变化提前退出；
- [x] `WaitForChange` 与其它动作后的自动 settle 使用同一变化定义、timeout 和 capture 观察合同；
- [x] 第一次 settled self-transition 只记录证据并反馈模型，不直接退出；同一 stable state + intent 再次提出时在 dispatch 前停止；
- [x] `A -> B -> A` 后再次提出已知边能被识别为 cycle，单纯 screenshot/revision/navigation event 不冒充 semantic progress；
- [x] `CANDIDATE` 分别经过 captured、cleared 和 timeout 路径；只有真实 capture 进入 PDF candidate 验证；
- [x] capture 与 Agent Stop/Challenge/page terminal 竞争时先保留并验证 capture，失败时仍返回最具体可信终态；
- [x] stale model action 永不 dispatch；action reject、Network/runtime failure 和 controller internal failure 使用正确稳定分类；
- [x] Browser Agent 的下一轮输入得到安全、结构化的上一转换反馈，但不包含 vendor 对象或禁止内容；
- [x] Challenge 至少能区分 Agent Stop、cycle、candidate timeout 与 resource blocked，specific failure 不被 generic unresolved 覆盖；
- [x] safety fuse 有明确 ADR 合同和离线测试，触发 `controller-safety-limit`，不建立自动获取耗尽；
- [x] metadata/content 任一 Agent 调用期间取消都使最终操作成为 interrupted；
- [x] authentication、quota、timeout、model、refusal 等稳定 Agent failure 到达 Report，未知 Python 异常成为 non-retryable `agent-internal`；
- [x] Runtime 日志按实际 role 显示 Provider/Model；context/size limits 不再混用 bytes 与 tokens 或重复做矛盾判断；
- [x] INFO/Report/Debug 信息层次和脱敏边界由 transcript 测试证明；
- [x] BrowserClient + publisher control + Agent controller + fake vendor event 的生产对象图离线测试通过；
- [x] 相关测试、Quick 和 Full Harness 通过，文档与最终行为一致；
- [x] 最终 diff 不夹带凭据、Profile、真实数据、构建产物、个人配置或无关改动。

## 分块地图与依赖

| 顺序 | Block | 结果 | 主要文件/模块 | 前置 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | [合同、ADR 与行为刻画](01-contracts-and-characterization.md) | 稳定 transition/failure 合同和能暴露旧缺陷的 characterization tests | ADR 0017、`network/browser_control.py`、`acquisition/browser_control.py`、直接测试 | 无 | Completed |
| 2 | [Browser execute、settle 与 capture](02-browser-execution-and-settle.md) | Network 返回 settled transition，Candidate 生命周期闭环 | `network/` Browser executor、Playwright/CloakBrowser、Network 测试 | Block 1 | Completed |
| 3 | [Browser progress、cycle 与终态](03-browser-progress-and-outcomes.md) | Acquisition 正确评价 settled state、循环和具体 route outcome | `acquisition/browser_control.py`、`acquisition/sources/browser.py`、Browser 测试 | Block 2 | Completed |
| 4 | [Analysis、Runtime 与反馈](04-analysis-runtime-and-feedback.md) | 取消/失败/role/limits/日志语义闭环 | `analysis/`、`agents/`、Bootstrap、相关测试 | Block 1；与 Block 3 串行集成 | Completed |
| 5 | [验证、文档与交接](05-verification-and-handoff.md) | 生产对象图离线证据、Full 和文档闭环 | 集成测试、architecture/current docs、计划证据 | Block 2-4 | Completed |

依赖主线为 `1 -> 2 -> 3 -> 4 -> 5`。虽然 Block 4 的局部源码与 Block 3 大多不同，本计划默认串行，避免共享 failure/logging/Bootstrap 合同未稳定时产生两套语义。

## 跨块合同

### 模块责任

| Owner | 必须拥有 | 不得获得 |
| --- | --- | --- |
| `agents` | 单次 Provider-neutral 调用、binding、capability、limits、usage、稳定失败 | Analysis/Browser workflow、工具执行、业务终态、长期 history |
| `analysis` | metadata -> content 顺序、prompt/schema、业务验收、stale/publication 决定 | Provider wire、自动 repair、隐藏 retry |
| `acquisition` | Browser 决策、stable progress/cycle、terminal resolution、route outcome | Page/CDP、vendor action executor、数据库绕行写入 |
| `network` | Observation、精确 action binding、dispatch、settle、capture、cleanup | 文献/Publisher 业务决定、Agent prompt 或 route outcome |
| `bootstrap` | 按 Analyze/Browser role 组装 adapter/runtime/controller 的唯一生产对象图 | 第二套 runtime、绕过 Network 的 SDK client |

### Browser transition 合同

目标合同必须能表示：

```text
BrowserTransition
  |-- Stale(current_observation)              # 未 dispatch
  |-- Settled(receipt, observation, changed)  # 已执行且 settle 完成
  |-- Captured(receipt, observation)          # capture 真正完成
  |-- CandidateTimeout(receipt, observation)
  |-- Stopped(reason, observation)
  |-- Cancelled
  `-- Failed(stable_failure)
```

- receipt 只描述动作执行；settle 描述异步效果已经达到可评价点；Acquisition 只评价 settled Observation；
- `CANDIDATE` 永远不是成功，必须等待 captured/cleared/timeout；capture progress 与 semantic progress 分开；
- `execution_binding_fingerprint` 绑定 exact observation/revision/screenshot，阻止 stale action；
- `stable_action_intent_fingerprint(action, observation)` 表达跨 revision 的动作意图；不得依赖 screenshot ID 或纯临时 ID；
- stable semantic state 排除短期 opaque ID、像素和无意义 geometry 抖动，同时保留 page state、安全 origin/path、可行动语义和足以判断进展的结构；
- 第一次 `state + intent -> same state` 只记录；再次提出已证明无效的同一边才停止；已知非 self 边也进入 article-local transition graph 以识别 cycle；
- 终态由单一 typed resolver 从 capture、取消、specific failure、page state、Stop/cycle 等证据计算，不依赖 failure 写入顺序。

### Analysis 与反馈合同

- 两阶段顺序、不发布部分结果、stale input 检查和成功 provenance 保持不变；
- `agent-cancelled` 在任何阶段统一形成 `analysis-content-cancelled` 并由 Entry 识别为 interrupted；
- Provider/Runtime 稳定 `agent-*` failure 原样保留，Report 已用 `stage=analysis` 定位业务阶段；Analysis 自有结构、输入、验收、stale 和 publication failure 继续使用 `analysis-*`；
- 未知内部异常归一为 non-retryable `agent-internal`，不能冒充可重试 Provider failure；
- Report 显示 target、stage、准确 code/reason/action/retryable；INFO 显示阶段、实际 Provider/Model、action/settle、usage/latency 和终态；Debug 才显示 revision、数量、fingerprint、transition evidence 与 capture callback 状态；
- 不记录 prompt、模型原文/reasoning、截图字节、页面正文、Cookie、Profile、完整 URL、secret、SDK/vendor 对象或 tool arguments。

### 数据与安全

- 所有 transition、candidate lifecycle 和失败上下文均为当前 article/operation 内存状态；
- 成功 Analysis 继续保存既有 provider/model/input hashes provenance；成功 PDF 继续保存既有 acquisition lineage；
- 后续阶段失败不撤销已经提交的有效事实；不新增 Catalog schema、资产格式或绝对路径；
- 测试只能使用 fake、fixture、系统临时目录和受控本地 event，不读取个人配置或真实凭据。

## 影响矩阵

| 面向 | 预期影响 | 边界 |
| --- | --- | --- |
| 公开 CLI/Entry | failure 与 interrupted 结果更准确；命令形状不变 | 不新增命令或配置 |
| 内部接口 | Browser action executor 从 receipt-only 收敛为 execute/settle transition；Runtime role identity 调整 | 先改生产者与直接消费者，不保留双路径兼容层 |
| 配置 | safety fuse 不作为复杂用户配置；现有 Model/Analyze/Browser 选择不变 | 无 schema 迁移 |
| Catalog/资产/schema | 无变化 | 不持久化 transition/history |
| Provider 协议 | 本计划不迁移 SDK；model identity 校验只在有官方证据后调整 | streaming、reasoning、quota 现有协议保持 |
| 依赖/锁文件 | 无预期变化 | 不改 `pyproject.toml`/`uv.lock` |
| Logging/Report | event、level、字段与 failure 保真度变化 | 不从日志反算 Report |
| 文档 | ADR 0017 amendment、technical/current behavior 同步 | ADR 0019 边界不变 |
| 打包/生产对象图 | Bootstrap 注入的 Browser action/Agent role 合同调整 | 仍只有一套生产对象图 |

## 风险与转化信号

| 风险 | 观察信号 | 处理 |
| --- | --- | --- |
| settle 定义过弱 | 异步挑战页仍在首次 observe 后误停 | 回到 Block 2，以同一变化谓词统一 action 与 WaitForChange |
| settle 定义过强 | 每次动作都耗尽 timeout、吞吐显著下降 | 区分有证据的 quiet/changed/candidate 终点，不用固定 sleep |
| semantic fingerprint 不稳定 | 相同页面因 ID/geometry 抖动无法识别重复 | 回到 Block 1/3，缩小 stable facts；精确安全绑定仍单独保留 |
| fingerprint 过粗 | 不同关键页面被合并而提前终止 | 增加有业务意义的 page/actionability 特征和反例 fixture |
| capture/终态竞态 | 已捕获 PDF 被 Stop/Challenge failure 丢弃 | typed resolver 先处理真实 capture 并验证，再决定失败 |
| safety fuse 被误当业务耗尽 | Report 提交 `NoPrimaryPdf` 或自动 exhaustion | blocking finding；保持 action-required/system safety outcome |
| failure taxonomy 膨胀 | Analysis/Browser 重复复制全部 Provider code | 保留拥有层 taxonomy；只有组合终态新增具体 code family |
| 测试继续替实现 settle | fake execute 后直接替换 Observation | blocking finding；必须有生产 action executor 对象图测试 |
| SDK 议题混入修复 | 开始新增 PydanticAI/Provider SDK 依赖 | 停止并转独立 ADR 0019 实施计划 |
| 当前用户 diff 冲突 | 目标文件出现无法归属的并行修改 | 停止该 slice，重新审查 baseline/owner，不覆盖用户工作 |

## 验证与证据策略

验证从最低成本到完整门禁串行推进：

1. characterization tests 先证明旧行为的具体缺陷，随后转为目标行为断言；
2. Network execute/settle、capture lifecycle、fingerprint/transition resolver 单元测试；
3. Acquisition Browser controller/source、Analysis、Agents Runtime 和 Entry Report 直接测试；
4. 使用 fake vendor event 但真实生产对象组装路径的 Browser 集成测试；
5. 日志 transcript、脱敏、取消与 failure 分类测试；
6. `scripts/harness.py quick`；
7. `scripts/harness.py full`，包括 Pyright strict、全部 unittest、wheel 构建与内容核对；
8. `git diff --check`、文档链接/术语、secret/真实数据/构建产物与最终语义审查。

所有自动测试必须离线。真实 CloakBrowser/Provider 复测只能在 Full 通过后由用户另行明确授权，且真实结果不得写入测试 fixture、计划或仓库。

## 授权门

- **当前已授权：** 创建和维护本活动计划；修改本计划覆盖的源码、测试、Accepted ADR amendment 与当前行为文档；执行离线测试、Quick 和 Full；持续实施至完成。
- **尚未授权：** 真实外部访问、读取个人 credential/Profile/config、数据迁移、删除用户材料、commit、push、PR、发布或并行 worker。
- 本次“开始实施，直至任务完成”不自动授权真实外部访问、Git 提交、并行 worker 或发布；这些仍需分别明确。
- 任何新增 Agent 权限、持久 workflow、外部 challenge solver、Browser-first 或 Network 绕行都超出本计划，必须取得新架构决定。

## 执行方式与集成点

Primary owner 串行执行五个 Blocks。每个 Task 使用同一循环：精确预检当前 diff 与调用方 -> 添加/修正直接测试 -> 实现最小完整能力切片 -> 运行目标测试和静态检查 -> 审查 diff/合同/错误路径 -> 记录证据后勾选。

关键集成点：

1. Block 1 冻结 `BrowserTransition`、failure 和 fingerprint 语义；
2. Block 2 由 Network 生产 settle/capture transition；
3. Block 3 由 Acquisition 消费 transition，形成 progress graph 与 route outcome；
4. Block 4 对齐共享 Runtime、Analysis 和反馈，不改变 Browser 合同；
5. Block 5 从 Bootstrap 生产组装验证组合对象图，再运行全库门禁。

并行默认关闭。若未来希望拆给多个执行者，必须由用户明确批准具体 Blocks/Tasks、owner、文件范围和汇合点，并先确保共享 transition/failure 合同已稳定。

## 执行审查

| Gate | 时点 | 必查内容 | 阻断处理 |
| --- | --- | --- | --- |
| R0 Plan readiness | Block 1 前 | 用户实施授权、ADR amendment 范围、baseline diff、验收和开放问题是否完整 | 保持 Pending |
| R1 Block entry | 每块前 | 前置证据、owner、调用方、用户改动、测试入口、外部授权 | 修复前置，不开始实现 |
| R2 Slice review | 每个 Task 后 | execute/settle 边界、竞态、失败语义、日志脱敏、测试是否证明用户结果 | finding 回到当前 owner |
| R3 Block exit | 每块结束 | 全部 Tasks、直接测试、接口一致性、下游合同和恢复点 | 不标 Completed |
| R4 Integration | Block 3/4 汇入 5 | Bootstrap 对象图、Report/Logging、取消、capture 和 failure 组合 | 回到产生冲突的 Block |
| R5 Final delivery | Full 后 | 原始目标、ADR/文档、最终 diff、安全、证据、残余风险 | 解决或明确接受后交付 |

以下 finding 一律 blocking：绕过 Network、把 workflow 下沉到 Agents、允许 stale action、Candidate 当成功、specific failure 被 generic failure 覆盖、safety fuse 建立 acquisition exhaustion、测试访问真实外部服务、泄露禁止内容或覆盖用户工作。

## 进度规则

- Task 只有在实现、直接测试、必要文档和 slice review 同时通过后才勾选；
- Block 只有其 Tasks、块级集成、退出条件和完成证据都闭环后才标 `Completed`；
- 根计划只从 Block 状态汇总，不另建虚假百分比；
- 发现合同或 owner 改变时，先更新本 README 的事实、影响、风险和分块地图，再继续实施；
- Full 未运行或未通过时，Plan 不得标为 `Completed`；真实环境未复测可以作为明确残余风险，但不能冒充离线验收失败。

## 恢复与续作协议

跨会话恢复时按以下顺序读取：

1. 本 README 的状态、开放问题、分块地图和计划变更记录；
2. 当前 `In progress` Block 的“完成证据”“失败与恢复”；
3. `git status --short` 与目标文件 diff，重新区分用户 baseline 与本计划改动；
4. ADR 0017、ADR 0019 和被修改的技术文档；
5. 最近通过的直接测试命令与首个失败证据。

最终恢复点为“离线实现、相关测试、Quick、Full、文档和最终审查全部通过”。若后续真实环境复测发现新的 Publisher/Provider 事实，应建立独立问题或新计划，不把未经证明的外部兼容猜测回填到本计划合同。

## 计划变更记录

| 日期 | 变化 | 原因 | 影响 |
| --- | --- | --- | --- |
| 2026-09-02 | 创建五块 Agents 行为机制与反馈整修计划 | 真实 Browser 测试暴露 challenge 点击后提前退出，进一步审查发现 settle、capture、cycle、failure、Analysis 取消与测试对象图存在系统性缺口 | 仅新增计划文档；源码、配置、依赖和 Git 状态未改变 |
| 2026-09-02 | Plan 进入 In progress，Block 1 开始 | 用户明确要求开始实施并持续至任务完成 | 授权源码、测试、ADR amendment、离线验证与文档同步；真实外部访问和 Git 写操作仍未授权 |
| 2026-09-03 | Blocks 1-4 完成并进入 Full | closed transition、Network settle、Acquisition progress/resolver、Analysis/Runtime/failure/logging 已由直接测试和生产形状对象图验证 | 不新增配置/schema/依赖；内部 Browser control contract 与 failure/logging 语义调整 |
| 2026-09-03 | Full 与最终 Review 通过，Plan 完成 | Pyright strict、unittest `Ran 2252 tests, OK (skipped=4)`、wheel 与内容核对通过；架构边界、diff、secret/个人路径和文档审查无 blocking finding | 真实 Provider/Publisher/CloakBrowser 与 model alias 仍保留为需另行授权的外部验收 |
| 2026-09-04 | 计划移入历史归档 | 既定 Agent 行为修复已经闭环；后续真实 ACS 回归发现的是独立的 Browser capture handoff 缺口 | 不回写或扩大本计划范围；新缺陷由后续独立计划承接 |

若 Block 1 的官方协议补证或 ADR 审查改变 safety fuse/model identity 方向，必须在此记录并更新受影响 Blocks，不能把方向变化藏在实现 diff 中。

## 最终交接

- 实际修复：Browser dispatch/settle 与 Candidate 生命周期、stable self/cycle graph、specific typed terminal resolver、32-call safety fuse、Analysis cancellation/failure、role-aware Runtime identity、bytes/tokens owner 和 INFO/Debug/Report 分层均已落地。
- 影响：公开 CLI、Report schema、Configuration schema、Catalog/资产 schema、依赖与锁文件不变；内部 Browser control 由 receipt-only 改为 closed transition，Runtime identity 变为 role-aware，失败 code/disposition 与日志字段更准确。
- 对象图：Bootstrap production RSC route 离线测试走过 shared `AgentRuntime`、`BrowserClient`、publisher control、`AgentBrowserController` 与 fake vendor event，并验证 action/settle/cleanup；未建立第二套 Runtime 或 Browser 绕行。
- 验证：相关离线测试 `Ran 581 tests, OK (skipped=1)`；Quick 通过；Full 最终退出码 0，Pyright strict 0 error、unittest `Ran 2252 tests, OK (skipped=4)`、wheel build 与 contents verification 通过；`git diff --check` 通过。
- 安全：敏感 key/private-key token pattern 与个人绝对路径扫描 clean；无 PDF、截图、Profile、个人 config、真实语料/数据或构建产物进入 diff；`pyproject.toml`/`uv.lock` 无变化。
- 未实施/残余风险：未发起真实 Provider、Publisher、CloakBrowser 或 MinerU 请求，也未读取个人凭据/Profile；response model identity 继续 strict equality，真实 alias/snapshot 语义和真实 Publisher 页面变化需用户另行授权验证。SDK/PydanticAI transport migration 仍属于 ADR 0019 下的独立后续计划。
- Git：未执行 commit、push、PR 或发布；工作树保留为未提交状态。
- 归档：`docs/archive/2026-09-02-agent-behavior-and-feedback-repair/`；本记录不再作为活动执行入口。
