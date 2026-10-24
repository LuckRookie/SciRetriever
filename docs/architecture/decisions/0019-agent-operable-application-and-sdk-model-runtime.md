# ADR 0019：Agent 可编排应用边界与 SDK 驱动模型运行时

类型：决策（ADR）
负责：Agent 可编排应用边界与 SDK 驱动模型运行时
状态：Accepted；产品操作范围被 [ADR 0026](0026-agent-knowledge-and-human-collaboration.md) 扩展：科研 Agent 为主要程序消费者，新增证据、知识压缩、检索与人类协作

- Date: 2026-08-26
- Last amended: 2026-10-15
- Supersedes: none
- Superseded by: none
- Amends: [ADR 0013](0013-decoupled-discovery-and-database-maintenance.md)、[ADR 0017](0017-shared-agents-and-controlled-browser-agent.md)
- Amended by: [ADR 0033](0033-machine-interfaces-cover-web-capabilities.md)（CLI/MCP 分别覆盖 Web；受控配置和 Browser 协作）；[ADR 0026](0026-agent-knowledge-and-human-collaboration.md)；[ADR 0028](0028-query-and-expansion-separation.md)（查询与显式扩充分离）；[ADR 0031](0031-dsh-backed-agent-capabilities.md)（受控 DSH 执行基础）
- Related: [ADR 0010](../../archive/decisions/0010-parser-neutral-markdown-current-result.md)、[ADR 0011](0011-literature-database-centered-incremental-maintenance.md)、[ADR 0012](0012-process-local-provider-access-scheduling.md)、[ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)、[ADR 0021](0021-provider-model-registry-and-direct-task-selection.md)、[产品需求](../requirements.md)、[设计文档](../design.md)、[任务与协作控制：数据库补全与阶段协调](../technical/02-task-coordination.md#4-数据库补全与阶段协调)、[知识加工：共享支撑：无状态模型运行时](../technical/05-knowledge-processing.md#5-共享支撑无状态模型运行时)、[任务与协作控制：共享支撑：受控网络访问](../technical/02-task-coordination.md#7-共享支撑受控网络访问)

## 背景

SciRetriever 的产品结果是持续维护的统一文献数据库。外部发现、数据库补全、手动 PDF
接纳、查询和导入导出已经是彼此独立的用户操作；每次操作重新读取当前权威事实，已经确认的
元数据、资产、解析结果和内容按各自业务 owner 的规则提交。系统不依赖恢复旧线程、Browser
页面、Parser/LLM 调用或通用 Agent session 才能继续工作。

这项产品定位同时产生两个不同的 Agent 集成问题：

1. **外部 Agent 如何使用 SciRetriever。** Codex、DeepSeek Harness 或其它通用 Agent 可以替
   用户选择搜索、PDF 获取、解析、分析和导出操作，但不能为了获得控制能力而直接接管数据库、
   Storage、Provider、Browser、MinerU 或内部模块状态。
2. **SciRetriever 内部如何调用模型。** Analysis 和受控 Browser 已经通过 ADR 0017 共用无
   状态 `AgentRuntime`，但当前实现仍自行编码和解析 OpenAI Responses、OpenAI Chat
   Completions 与 Anthropic Messages 协议，并自行维护通用 schema/tool 校验、usage、reasoning、
   failure 和模型目录转换。无状态窄腰解决了业务所有权问题，却没有回答为什么这些 Provider
   协议能力不能复用成熟 SDK。

“Agent”“SDK”和“框架”在这两个问题中含义不同，必须明确区分：

| 概念                             | 责任                                                             |
| -------------------------------- | ---------------------------------------------------------------- |
| 外部 Agent Harness               | 面向用户的控制面；选择和组合 SciRetriever 产品操作               |
| SciRetriever Application API/SDK | 稳定、领域中立、可供 CLI、Web 和 MCP 共用的产品能力合同       |
| MCP                              | 把 Application API 映射为外部 Agent 可调用的类型化入口           |
| Skill                            | 说明如何组合 MCP/CLI、何时审批以及如何根据结果恢复；不是权威 API |
| 内嵌模型框架或 Provider SDK      | 在 `agents` 私有适配边界内完成模型协议与类型转换                 |
| LangGraph 一类 workflow runtime  | 在确有 durable workflow、checkpoint 或 HITL 需求时编排业务节点   |

如果把 SciRetriever 做成只能“一键运行到底”的封闭应用，外部 Agent 无法在成本、审批、失败
和阶段结果之间进行有意义的编排。如果把内部模块、数据库或文件系统直接交给外部 Agent，又会
复制身份、校验、provenance、事务和恢复规则，破坏统一事实所有权。目标因此不是“封闭应用”或
“低层组件工具箱”，而是核心不变量闭合、产品能力控制开放的文献引擎。

成熟 SDK 也不能仅因减少代码而绕过 SciRetriever Network。Network 已经统一拥有
AccessCoordinator、URL/DNS/origin 准入、origin-bound credential、redirect、timeout、取消、
响应字节上限、quota/`Retry-After` 反馈和日志脱敏。只有能把全部外部 I/O 注入这条边界的 SDK
才能成为生产实现。

## 决策

适用范围：产品消费边界按 ADR 0026/0027 修订；模型运行时按 ADR 0031；补全目标与文献状态按 ADR 0037。当前活动语言、构建与运行合同以 ADR 0025 和 TS 基线为准。2026-10-20 收口：原 PydanticAI/Python 选型、`CONTENT_READY` 目标等过时正文已改写。

### 1. SciRetriever 是 Agent 可编排但不由 Agent 拥有的文献引擎

产品定位固定为：

> SciRetriever 是科研 Agent 的领域中立知识组件，独立供应原始材料、可读证据、压缩知识及
> 通用提取能力，并为人类提供正式配置、Browser 协作与阅读接口。调用方决定科研目标、提取
> 记录和领域策略；身份、受控访问、材料/产物验收与存储完整性由 SciRetriever 的业务 owner 负责。

科研 Agent 是主要程序消费者，但特定 Agent Harness 不是运行依赖。产品能力必须通过稳定应用边界供 Agent 与人类调用；当前以 TypeScript 应用能力和薄 CLI/Web/Agent 适配组织，不要求 Python API。

在用户明确的任务范围内，外部 Agent 可以调用下列能力。按 ADR 0028，查询与扩充是独立操作；Agent 不能仅因数据库不足自行启动元数据/PDF 扩充，须由用户明确发起或指示代为执行具体维护任务：

- 发起本地查询、外部领域发现、引用发现、数据库补全、手动 PDF 接纳、导入或导出；
- 选择明确 ID、DiscoveryRun、导入结果、查询或全库等类型化范围；
- 分别获取材料、准备可读文档与证据、生成指定用途分析/综合，或读取已有结果；获取 PDF 与解析可以由补全推进，建档按 ADR 0037 单独发起；
- 按预算检索上下文、展开证据，使用调用方规范与策略提取并提交候选；候选须通过平台通用验收，领域接纳归调用方；
- 根据稳定 Report 和当前详情决定下一项操作、停止、等待或重新发起操作；
- 在联网、Browser 升级、批量 Parser/LLM 成本或用户文件写入前请求用户批准。

外部 Agent 不得：

- 判断或直接提交文献身份、统一元数据、引用关系、当前状态或其它数据库事实；
- 直接调用 Storage、SQL、ArtifactStore publication、Provider adapter、MinerU 私有协议或模型
  Provider；
- 取得任意 Browser/Page/CDP、Cookie、Profile、selector、URL、JavaScript、凭据或内部文件
  路径；
- 绕过 PDF 验收、输入/证据对齐、产物验收、stale 检查或一致提交；两阶段验收适用于旧单篇兼容用例；
- 把自身 session、plan、tool history、下载现场或推断结果变成第二套产品状态。

### 2. Entry 是所有人类和外部 Agent 的唯一应用边界

CLI、Web 工作台和 Agent adapter 都调用 Entry/Application 的产品操作。它们不能直接调用功能模块
的内部 service 或 Port。Entry 继续负责外部值解析、类型化范围、写入准入、目标冻结、当前事实
重读、跨模块编排、局部失败隔离和操作 Report；业务模块继续拥有各自判断，Storage 只提交已经
确认的决定。

以下“推进到所需结果”描述明确启动的数据库维护命令，不适用于只读查询或独立知识加工。旧 completion 可按其已声明合同补 PDF，但查询/独立分析的缺口不能自动调用它；新材料扩充须遵守 ADR 0028 的启动边界：

```text
BatchRequest(selector, goal)
  -> Entry 读取并冻结当前目标
  -> 每个目标从第一个缺失或已失效的前置事实继续
  -> 只运行达到 goal 所需的阶段
  -> 每项有效事实按原 owner 的合同独立提交
  -> 返回本次非持久化 DatabaseCompletionReport
```

同一请求重复执行时重新读取数据库事实，复用仍有效且对齐的结果；它不恢复上次运行现场，也不
要求调用方掌握模块内部顺序。

### 3. 数据库补全的解析目标

数据库补全（ADR 0013）提供两个维护目标：

```text
ASSET_READY
PARSER_RESULT_READY
```

- `ASSET_READY`：使每个选中对象具有一个通过验收并已正常发布的当前主 PDF，不启动解析。
- `PARSER_RESULT_READY`：必要时先补齐主 PDF，再完成正文部分的原始解析（ADR 0037：`pipeline` 与 `vlm-engine` 两种 profile）。

原有的 `CONTENT_READY` 目标按 ADR 0037 退役。建档是独立的手动操作，不属于补全；文献状态由 ADR 0037 定义，补全目标本身不增加状态。

`BatchRequest` 不接受 Provider、Parser、model、SDK client、数据库连接、并发实现、凭据、任意 `force`、cursor 或自由参数。

如果外部 Agent 希望把网络与解析成本分别审批，可以先发起 `ASSET_READY`，检查 Report 后再发起 `PARSER_RESULT_READY`。直接请求后者仍遵循“推进到目标”语义，缺 PDF 时会运行必要的 Acquisition；MCP/Skill 必须准确声明这种前置副作用。

手动 PDF 接纳继续是独立的 `admit_manual_pdf` 用例。外部 Agent 已经持有本地 PDF 时，只能通过该边界提交只读 binary input，由 SciRetriever 复制、检查，并以准确的 provenance 接纳；外部 Agent 不能自行写入 ArtifactStore，也不能把自己下载的文件伪装成 SciRetriever 自动获取的结果。

### 4. MCP 与 Skill 位于 Entry 外侧，不形成第二套产品

MCP 作为 Entry adapter，把已有产品操作映射为适合外部 Agent 选择的类型化工具。MCP 可以为
模型可理解性使用较清晰的薄包装，例如把同一个补全 API 呈现为“确保 PDF”“确保已解析”和
“确保最终内容”，但这些工具必须分别映射到三个 `BatchGoal`，不能形成独立业务语义或另一个
orchestrator。

第一阶段 Agent-facing 能力应清楚区分：

- 纯本地只读：文献搜索、详情、引用页面与详情、当前结果和 artifact 元数据；
- 外部发现与写入：领域发现、引用发现；
- 数据库推进：主 PDF 与原始解析（建档单独发起）；
- 明确输入/输出：手动 PDF、书目导入、artifact 与书目导出；
- 新知识能力：文档/证据读取、分析/综合、预算内上下文，以及调用方提取规范和候选交付。

可能联网、打开 Browser、调用 Parser/LLM、修改数据库或写用户目标文件的工具必须在工具描述
和客户端审批信息中准确声明副作用、成本与可能耗时。客户端审批不能替代服务端的类型校验、
Network、安全策略和事实 owner。

MCP 不得：

- 暴露 secret 读取、任意配置文件编辑、原始 SQL、内部表、Storage path、Provider client、原始 Browser/Page/CDP 或任意 prompt API；按 ADR 0033，受控普通配置发布、凭据设置/移除及 Browser 协作须经同一 owner 和授权边界提供；
- 把 PDF、截图或其它大型字节默认塞入模型上下文；应返回稳定 ID、hash、provenance、受控
  artifact reference 和有界摘要，再由明确导出操作取得字节；
- 建立 MCP 专属 Job、Task、Session、Report 历史或文献状态；长操作只返回或投影 SciRetriever
  应用 owner 的执行投影与权威事实，不复制一套 MCP 调度状态；任务存续和恢复保证另行设计；
- 要求外部 Agent 的 session 才能恢复。重启后 Agent 必须重新查询当前数据库事实。

由于当前 catalog、资产、Profile 和凭据都是单用户本地资源，首个 MCP adapter 采用本地进程
边界，优先使用 `stdio`。远程或多用户 MCP 涉及身份、租户、授权、资产传输和凭据隔离，必须
另行决策。

Skill 只保存工具使用说明、推荐工作流、审批点、失败处理与恢复策略。它调用 MCP/CLI，不拥有
secret、数据库状态或隐藏接口，也不能用 prompt 文字改变本 ADR 的业务和安全合同。Codex、
DeepSeek Harness 或其它通用 Agent 可以各自提供 Skill 表达，但共同消费同一个 Entry/MCP
语义。

### 5. 模型调用经唯一的 DSH 底座，保持中性窄腰

模型调用由 ADR 0031 选定的唯一 DSH 底座（`DshAgentRuntime`）承担，提供单次调用与受控会话。消费者看到的是中性的 role binding、capability/readiness、单次 limits、稳定失败、usage、输入与参数 hash，不接触具体 SDK 类型。原先“首选 PydanticAI Direct Model Requests”的选型未在 TypeScript 实现中采用，已经作废。

无论使用哪种 SDK 或 Provider 协议，都必须满足：

- 不隐藏模型调用：Provider/SDK 的自动 retry 关闭，额外调用和成本必须可见；
- 流式响应只在 adapter 私有边界内消费、重建为唯一完整结果；消费者不接收 token/event stream，任一模式失败后不能自动切换模式补发请求；
- 单次模型 adapter 不自动执行工具。DSH 执行基础只能调度消费模块显式提供的受控工具，不获得其业务所有权；
- SDK、Provider 与 HTTP 客户端的类型不进入 Entry、Analysis、Acquisition、Configuration 的公共合同或持久化数据；
- Analysis 拥有各用例的 prompt、编排、schema 含义与产物验收；Acquisition 拥有 Browser controller、Observation/action 含义、语义进展和 route outcome；
- 中性 reasoning、模型目录、capability、usage、failure 和 provenance 由 SciRetriever adapter 归一化，不能根据模型名称或缺失字段猜测 capability。

DeepSeek 模型与 DeepSeek Harness 执行基础分别选型。Codex 等外部 Agent 宿主继续位于 Entry/MCP 外侧；DSH 的默认完整应用、shell、个人配置，以及第二套网络或业务调度，都不能接管 SciRetriever。

### 6. 模型相关的全部外部 I/O 经过 Network

任何 SDK 或 Provider adapter，只有在全部外部 I/O 都经过 SciRetriever Network 时，才能进入生产对象图。Network 只拥有通用 transport、准入和安全政策，不反向依赖 Provider 业务类型。

transport 边界必须满足：

- 在 Bootstrap 时绑定经过验证的 Provider origin、允许路径和 destination policy，拒绝扩张到未绑定的 origin/path；
- 认证 header 通过 Network 的 origin-bound credential 通道发送；未知认证 header、Cookie 或跨 origin credential 一律拒绝（fail closed）；
- 自动 retry 与 redirect 均为零；
- 流式响应受单次响应字节、read/overall timeout 和取消约束；各协议的终止事件、usage、refusal、incomplete、error 和截断只在 adapter 内转换；
- 由 Network 执行 DNS/origin/host 准入、访问调度、timeout、取消、response byte limit、quota/`Retry-After` 和日志脱敏；
- SDK 不得先无界读取响应、另起 transport、自行 telemetry 或后台联网；
- 使用公开稳定的 transport 注入接口，不 monkey patch 私有实现。

离线验证至少覆盖：
- 全部 outbound request 只出现在 fake Network 中；
- 至少一种 OpenAI 协议和一种非 OpenAI 协议完成结构化请求；
- redirect、重复 POST、credential forwarding、响应上限、timeout、cancel、quota 与 `Retry-After` 语义不变；
- 异常、refusal、截断、schema 不匹配和 usage 转换为稳定的中性结果；
- provenance 完整；
- TypeScript 严格类型检查与离线安装包验证通过。

不能为了接入某个 SDK 削弱 Network、安全、取消、失败或 provenance 合同。

### 7. 业务 workflow 由 TypeScript controller 组织，当前不引入 LangGraph

TypeScript 业务 controller 负责组织 Analysis、建档、ReferenceLookup、材料获取与 Browser 流程。DSH（ADR 0031）承担内部受控 Agent 交互的会话、循环与工具调度，但不改变业务阶段与结果 owner，不替代 Network transport 边界，不增加 durable workflow，也不扩展模型的工具权限。

当前不引入 LangGraph、高层 Agent 框架、OpenAI Agents SDK 或其他未经选择的运行时。只有出现真实的跨进程 durable workflow、人工中断后恢复、复杂动态并行分支，或长期多 Agent handoff 的产品需求时，才重新评估。若采用，它位于业务 controller 层，节点调用 Entry 或功能模块的公开 API，checkpoint 只引用稳定 ID 和已确认的事实。

### 8. 状态、恢复、日志和权限边界不因 Agent 集成改变

- 文献数据库仍是唯一产品事实源；MCP、Skill、外部 Agent session、DSH 和 SDK 不形成
  第二真相源；
- 外部 Agent 或框架失败不能撤销已提交的有效元数据、PDF、原始解析或文献档案；
- 重跑重新读取 current facts，从第一个缺失或失效步骤继续；不恢复旧 MCP call、Agent thread、
  SDK request、Parser task 或 Browser turn；
- 外部 Agent 只能获得稳定 ID、hash、provenance、typed result/failure、受控 artifact reference
  和必要有界内容；不能获得 secret、内部路径、SQL row、原始 SDK response 或安全敏感对象；
- 任意 prompt、模型原始响应/reasoning、Browser 现场和外部 Agent conversation 不因 Agent 集成而进入 Catalog、Report 或日志。ADR 0027 的提取候选是经过独立合同验证的产物，不是任意 tool payload 归档。正式人类实时观察按受控会话提供；长期截图/录像与事后重放的保留政策尚未确定；
- 日志继续只记录安全 operation、role/provider/model、结果类别、usage、延迟和稳定失败；客户端
  日志或 thread history 不能替代 SciRetriever Report；
- 当前事实重跑与同一任务跨重启恢复分别设计。必要执行记录可以由应用 owner 按明确合同管理，但不成为第二套文献事实；当前 Jobs 机制不自动承诺新任务的生命周期；
- 所有写入仍经 Entry 写入准入、业务 owner 验收和 Storage 一致提交；外部 Agent 的用户授权不
  等于绕过这些边界的系统权限。

## 目标架构

```text
User
  -> Codex / other external agent
       -> Skill (workflow guidance)
       -> local MCP (typed Entry adapter)
            -> Entry
                 -> Literature / Metadata / Acquisition / Parsing / 建档 / Analysis
                      -> DshAgentRuntime（单次调用与受控会话，ADR 0031）
                           -> Provider adapter
                                -> Network（准入、访问调度、凭据通道）
                                     -> Provider endpoint
```

控制方向与事实方向不同：外部 Agent 向下选择操作，SciRetriever 业务模块向内形成并提交事实；DSH 和 SDK 都不能越过相邻边界直接改变数据库。

## 当前状态

- 原先选定的 PydanticAI 与 Python 实现路线没有进入 TypeScript 生产实现，已作废；模型运行时以 ADR 0031 为准。
- `CONTENT_READY` 补全目标按 ADR 0037 退役；`PARSER_RESULT_READY` 的产物改为原始解析。
- MCP/Skill 的当前能力范围以 ADR 0033 与用户指南为准。

## 后果

### 正面结果

- Codex 等外部 Agent 可以直接控制搜索、PDF 入库、解析、建档、分析和导出的顺序，不必复制 SciRetriever 的身份、状态、事务与安全规则；
- 获取、解析、建档各自是明确的成本与故障检查点；
- SciRetriever 对外暴露稳定的产品能力，而不是内部模块、Provider 或框架类型；
- Codex、其他 Agent、CLI 和 Web 共用同一事实与 Entry 语义，不形成供应商锁定；
- LangGraph 等 durable runtime 只在真实需求出现时引入，避免为当前 workflow 增加第二套状态系统。

### 成本与风险

- `PARSER_RESULT_READY` 是长期的应用目标，需要相应的 Report、CLI/MCP、测试和文档；
- DSH 与 Provider adapter 带来依赖、升级和供应链审查面（ADR 0031）；
- MCP 扩大了可以发起联网、产生成本和写入的入口，需要准确的工具描述、审批提示和同等的服务端保护；
- 外部 Agent 可能依据过期 session 作出错误计划，因此 Skill 和工具结果必须引导它重新读取 current facts；
- 补全目标采用“推进到目标”语义，文档必须说明它不是“精确调用内部某一步”。

## 不采用的方案

- **只提供一个从发现到内容完成的黑箱命令。** 它不能满足外部 Agent 对范围、成本、审批和阶段结果的控制需求。
- **把 Metadata、Acquisition、Parsing、Analysis、Storage 或数据库直接暴露给 Codex。** 这样会把调用顺序、过期检查、provenance 和一致提交的知识复制到每个客户端。
- **让 MCP 直接调用模块内部 API，或建立自己的 Job/状态库。** 这样会形成第二套应用语义和恢复机制。
- **把 parser 私有输出直接当作产品文档。** 原始解析须经校订、建档后才进入算子（ADR 0037）。
- **把未经裁剪的完整 Agent 应用作为核心运行环境。** 默认 shell、filesystem、个人配置和外部工具不因框架接入获得权限；ADR 0031 只选择 DSH 的最小受控组件。
- **让 SDK 自行联网或绕过 Network。** 减少 adapter 代码，不能补偿 credential、quota、redirect、有界响应和日志边界的丢失。
- **立即引入 LangGraph 或高层 Agent 框架。** 当前业务 controller 的 owner 与恢复语义清晰，这些 runtime 不能解决当前问题。
- **首版建设远程、多用户 MCP。** 当前本地 catalog、资产、Profile 和凭据没有远程租户与授权合同。

## 需要新 ADR 的变化

- 外部 Agent 获得 SQL、Storage publication、事实写入、任意 Provider/Browser/Parser/LLM、
  secret、内部路径或未受控文件系统权限；
- SciRetriever 的核心产品能力开始依赖某个外部 Agent Harness、thread 或持久 conversation；
- 原始解析绕过校订直接进入算子，或永久保存全部解析尝试；
- MCP 建立持久 Job/Task 状态，或改为远程、多用户、跨租户服务；
- 引入 LangGraph 或其它 durable workflow/checkpoint/HITL runtime；
- framework 开始拥有 Analysis/Acquisition 业务 workflow，执行未经消费模块授权的 Browser tool 或绕过业务验收；ADR 0031 已允许受控工具委托；
- 允许 SDK 自动 retry、redirect、telemetry 或第二条外部联网路径，或者把任一协议 streaming
  暴露为消费者状态、运行时自动协商或失败后的第二次模型请求；
- 改变单次调用的无状态窄腰，或把 Provider/SDK 类型暴露给业务消费者；
- 未经评估破坏现有 `BatchGoal`、持久数据、artifact 或稳定 Entry 调用方的兼容性（ADR 0037 已决定的变更除外）。
