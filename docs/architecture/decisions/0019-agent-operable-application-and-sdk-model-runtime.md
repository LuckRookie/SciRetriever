# ADR 0019：Agent 可编排应用边界与 SDK 驱动模型运行时

- Status: Accepted
- Date: 2026-08-26
- Last amended: 2026-10-15
- Supersedes: none
- Superseded by: none
- Amends: [ADR 0013](0013-decoupled-discovery-and-database-maintenance.md)、[ADR 0017](0017-shared-agents-and-controlled-browser-agent.md)
- Amended by: [ADR 0033](0033-machine-interfaces-cover-web-capabilities.md)（CLI/MCP 分别覆盖 Web；受控配置和 Browser 协作）；[ADR 0026](0026-agent-knowledge-and-human-collaboration.md)；[ADR 0028](0028-query-and-expansion-separation.md)（查询与显式扩充分离）；[ADR 0031](0031-dsh-backed-agent-capabilities.md)（受控 DSH 执行基础）
- Related: [ADR 0010](0010-parser-neutral-markdown-current-result.md)、[ADR 0011](0011-literature-database-centered-incremental-maintenance.md)、[ADR 0012](0012-process-local-provider-access-scheduling.md)、[ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)、[ADR 0021](0021-provider-model-registry-and-direct-task-selection.md)、[产品需求](../requirements.md)、[设计文档](../design.md)、[任务与协作控制：数据库补全与阶段协调](../technical/02-task-coordination.md#4-数据库补全与阶段协调)、[知识加工：共享支撑：无状态模型运行时](../technical/05-knowledge-processing.md#5-共享支撑无状态模型运行时)、[任务与协作控制：共享支撑：受控网络访问](../technical/02-task-coordination.md#7-共享支撑受控网络访问)

> 2026-09-25 修订：科研 Agent 成为主要程序消费者，新增证据、知识压缩、检索/上下文及正式人类协作；Entry 薄适配与内部模型运行时边界保留。详见 [ADR 0026](0026-agent-knowledge-and-human-collaboration.md)。下文保留原决定与兼容背景；冲突条款按新 ADR 执行，具体实现状态以源码和 TS 基线为准。

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
| SciRetriever Application API/SDK | 稳定、领域中立、可供 CLI、Python 和 MCP 共用的产品能力合同       |
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

适用范围：产品消费边界按 ADR 0026/0027 修订；以下旧 BatchGoal 与 Python/PydanticAI 选型保留其历史/兼容背景。当前活动语言、构建与运行合同以 ADR 0024/0025 和 TS 基线为准，不要求恢复 Python。单次模型层的无状态、受控网络与类型隔离约束继续有效；ADR 0031 另允许私有受控 DSH 会话与工具循环，实施方案已批准。

### 1. SciRetriever 是 Agent 可编排但不由 Agent 拥有的文献引擎

产品定位固定为：

> SciRetriever 是科研 Agent 的领域中立知识组件，独立供应原始材料、可读证据、压缩知识及
> 通用提取能力，并为人类提供正式配置、Browser 协作与阅读接口。调用方决定科研目标、提取
> 记录和领域策略；身份、受控访问、材料/产物验收与存储完整性由 SciRetriever 的业务 owner 负责。

科研 Agent 是主要程序消费者，但特定 Agent Harness 不是运行依赖。产品能力必须通过稳定应用边界供 Agent 与人类调用；当前以 TypeScript 应用能力和薄 CLI/Web/Agent 适配组织，不要求 Python API。

在用户明确的任务范围内，外部 Agent 可以调用下列能力。按 ADR 0028，查询与扩充是独立操作；Agent 不能仅因数据库不足自行启动元数据/PDF 扩充，须由用户明确发起或指示代为执行具体维护任务：

- 发起本地查询、外部领域发现、引用发现、数据库补全、手动 PDF 接纳、导入或导出；
- 选择明确 ID、DiscoveryRun、导入结果、查询或全库等类型化范围；
- 分别获取材料、准备可读文档与证据、生成指定用途分析/综合，或读取已有结果；旧 PDF/ParserResult/LiteratureContent 目标保留兼容；
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

### 3. 数据库补全增加解析结果目标，但不增加 Literature 状态

ADR 0013 的两个 `BatchGoal` 以向后兼容的加法扩展为三个：

```text
ASSET_READY
PARSER_RESULT_READY
CONTENT_READY
```

语义分别为：

- `ASSET_READY`：使每个选中对象具有一个通过验收并已正常发布的当前主 PDF；不启动 Parsing
  或 Analysis；
- `PARSER_RESULT_READY`：必要时先补齐主 PDF，再使当前主 PDF 具有与输入 hash、当前有效
  Parser 配置和 provenance 对齐的当前 `ParserResult`；不启动 Analysis；
- `CONTENT_READY`：从当前第一个缺失步骤继续，必要时依次完成 PDF、Parsing、Analysis 和
  Literature 接纳，最终形成与当前输入对齐的 `LiteratureContent`。

`PARSER_RESULT_READY` 只是本次补全的目标和成功判定，不增加 `PARSER_READY`、
`PARSER_RESULT_READY` 或其它第四种 `LiteratureStatus`。具有当前 ParserResult 但尚无最终内容
的 Literature 仍为 `ASSET_READY`；ParserResult 仍是可替换、可重建的中间结果，不直接成为旧 LiteratureContent 或第四种文献状态。按 ADR 0026，Document/Evidence 可提供独立读取与稳定证据，具体表示版本的保留不受旧 current-only 范围限制。

`BatchRequest` 不因第三个目标而接受 Provider、Parser、model、SDK client、数据库连接、并发
实现、凭据、任意 `force`、cursor 或自由参数。明确重解析、切换 Parser、导入外部解析结果或把
ParserResult 改为新的公开交换字节格式仍需精确合同与兼容策略，不能通过通用参数偷偷加入；ADR 0026 已确认的独立文档读取不需重复批准。

如果外部 Agent 希望把网络与解析成本分别审批，它先发起 `ASSET_READY`，检查 Report 后再发起
`PARSER_RESULT_READY`。直接请求后者仍遵循“推进到目标”语义，在缺 PDF 时可以运行必要的
Acquisition；MCP/Skill 必须准确声明这种前置副作用，不能把它描述成纯本地 Parser 调用。

手动 PDF 接纳继续是独立 `admit_manual_pdf` 用例。外部 Agent 已经持有本地 PDF 时只能通过该
边界提交只读 binary input，由 SciRetriever 复制、检查并以准确 provenance 接纳；不能自行写入
ArtifactStore，也不能把 Agent 自行下载的文件伪装成 SciRetriever 自动获取结果。

### 4. MCP 与 Skill 位于 Entry 外侧，不形成第二套产品

MCP 作为 Entry adapter，把已有产品操作映射为适合外部 Agent 选择的类型化工具。MCP 可以为
模型可理解性使用较清晰的薄包装，例如把同一个补全 API 呈现为“确保 PDF”“确保已解析”和
“确保最终内容”，但这些工具必须分别映射到三个 `BatchGoal`，不能形成独立业务语义或另一个
orchestrator。

第一阶段 Agent-facing 能力应清楚区分：

- 纯本地只读：文献搜索、详情、引用页面与详情、当前结果和 artifact 元数据；
- 外部发现与写入：领域发现、引用发现；
- 数据库推进：主 PDF、ParserResult、LiteratureContent；
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

### 5. `AgentRuntime` 保持稳定窄腰，模型协议优先委托成熟 SDK

ADR 0017 的无状态 `AgentRuntime`、role binding、capability/readiness、单次 limits、稳定失败、
usage、input/parameter hash 和消费者业务所有权保持不变。该公共窄腰不是通用自治 Agent，也不
向消费者暴露具体 SDK 类型。

具体 Provider wire protocol 不再默认由 SciRetriever 自行实现。首选实现为：

```text
AgentRuntime neutral call/result
  -> SciRetriever PydanticAI adapter
  -> PydanticAI Direct Model Requests
  -> PydanticAI/provider SDK model implementation
  -> SciRetriever-controlled SDK transport bridge
  -> Network HttpClient / AccessCoordinator
```

采用 `pydantic-ai-slim` 与实际需要的 Provider extras，不引入完整可选依赖集合。使用 Direct
Model Requests 或等价的低层单次请求 API，只委托 message/schema/tool/provider 请求与响应类型
转换；不使用高层 Agent loop 接管业务执行。

框架与 SDK 必须满足：

- 每次 `AgentRuntime.execute` 只有消费者声明的一次模型调用，不保存 session、history、turn、
  memory 或 checkpoint；
- Provider/SDK 自动 retry 关闭，不能隐藏额外模型调用或成本；
- OpenAI Responses、OpenAI Chat Completions 与 Anthropic Messages 默认按 Model 的
  `stream = true` 发送流式请求并消费有界 SSE；具体 Model 可以明确关闭 stream，此时只解析
  非流式 JSON。adapter 或 SDK 必须在私有边界内重建唯一完整结果，`AgentRuntime`、Analysis 和
  Browser 不接收 token/event stream，也不能在任一模式失败后自动切换模式补发请求；
- 单次模型 adapter/SDK 不自动执行 tool。Analysis structured output 与 Browser 动作数据仍由
  消费模块接纳；ADR 0031 的 DSH 执行基础可调度消费模块显式提供的受控工具，不获得其业务所有权；
- PydanticAI、OpenAI、Anthropic、DeepSeek、`httpx` 或其它 SDK 类型不能进入 Model、Entry、
  Analysis、Acquisition、Configuration 公共合同或持久化数据；
- Analysis 继续拥有各用例 prompt、调用编排、schema 含义与产物验收；两阶段、NoUsableContent 和 Markdown 属于旧单篇用例，ReferenceLookup 保持按需；Acquisition 继续拥有 Browser controller、Observation/action 含义、
  语义进展和 route outcome；
- 中性 reasoning、模型目录、capability、usage、failure 和 provenance 由 SciRetriever adapter
  归一化。可使用 SDK 的公开模型目录能力，但不能根据模型名称或缺失字段猜测 capability。

PydanticAI 是第一个实现选择，不是业务公共合同。未来可以在保持同一 `AgentRuntime`、Network
和行为测试的前提下替换为另一成熟 SDK，而不要求业务模块或数据库迁移。只有需要改变这些稳定
边界时才需要新 ADR。

DeepSeek 模型与 DeepSeek Harness 执行基础分别选型。Codex 等外部 Agent 宿主继续位于 Entry/MCP
外侧；按 ADR 0031，DSH 的最小 Cordis 组件可以成为 `agents` 私有生产依赖，提供受控会话与工具循环。
这不允许其默认完整应用、shell、个人配置或第二套网络/业务调度接管 SciRetriever。

### 6. SDK 接入必须先通过 Network transport gate

成熟 SDK 只有在全部外部 I/O 都经过 SciRetriever Network 时才能切入生产对象图。SDK-facing
shim 可以位于 `agents` 的具体 adapter 边界；Network 继续只拥有通用 transport、准入和安全
政策，不反向依赖 Provider 或 PydanticAI 业务类型。

bridge 必须：

- 在 Bootstrap 时绑定经过验证的固定 Provider origin、允许路径和 destination policy；
- 拒绝 SDK 请求扩张到未绑定 origin/path；
- 识别允许的认证 header，将其从普通 header 中分离，并通过 Network 的 origin-bound
  credential 通道发送；未知认证 header、Cookie 或跨 origin credential fail closed；
- 强制 SDK 和请求级自动 retry 为零，redirect 为零；
- 三种协议的 SSE 必须继续受单次响应字节、read/overall timeout 和取消约束；协议各自的终止
  事件、completed output item/delta、usage、refusal、incomplete、error 和截断只在 Agents
  adapter 内转换，不能把 SDK stream/event 类型暴露给消费者；
- 让 Network 执行 DNS/origin/host 准入、AccessCoordinator、timeout、取消、response byte
  limit、quota/`Retry-After` 和日志脱敏；
- 在有界响应已经由 Network 接收后才构造 SDK response，不允许 SDK 先无界读取或另起 transport；
- 禁止 SDK 自行 telemetry、后台联网或其它不经 Network 的外部通信；
- 使用 SDK 的公开稳定 transport/http-client 注入接口，不 monkey patch 私有实现。

切换 gate 至少用离线 fake 验证：

- 全部 outbound request 只在 fake SciRetriever Network 中可见，没有第二条联网路径；
- OpenAI 协议和一个非 OpenAI 协议都能完成一次结构化请求；
- Analysis typed output 与 Browser typed decision 成功，单次模型 adapter 不执行 Browser 动作；DSH 的受控工具委托另按 ADR 0031 验证；
- redirect、重复 POST、credential forwarding、响应上限、timeout、cancel、quota 和
  `Retry-After` 保持当前语义；
- SDK exception、refusal、truncated、tool/schema mismatch 和 usage 能转换为稳定中性结果；
- input hash、parameters hash、provider/model、usage 和 provenance 完整；
- Python 3.10/3.12、Pyright strict、离线测试和 wheel 安装成立；
- SDK 私有类型没有越过 adapter，Provider 升级只影响该 adapter 与直接合同测试。

如果 SDK 无法通过公开接口满足 gate，必须停止切换并保留当前自研 Provider adapter；不得削弱
Network、安全、取消、失败或 provenance 合同来换取 SDK。失败证据和继续自研的理由必须通过
本 ADR 的 amendment 或后续 ADR 记录，不能把临时兼容层长期保留为双路径。

### 7. 业务 workflow 继续使用普通 Python controller，当前不引入 LangGraph

本节标题保留历史决策索引。当前由 TypeScript 业务 controller 组织 Analysis、ReferenceLookup、材料获取与 Browser 流程。ADR 0031 已选定 DSH 支撑内部受控 Agent 交互，尚未实施；业务阶段与结果 owner 不变，任务存续/恢复与部署仍需单独决定。

当前不引入 LangGraph、PydanticAI 高层 Agent、OpenAI Agents SDK 或其它未经选择的运行时。
ADR 0031 允许 DSH 持有受控交互的会话、循环与工具调度；这不能替代 Provider transport gate，
也不能改变业务 owner、增加 durable workflow 或扩展模型工具权限。

未来只有出现真实的跨进程 durable workflow、人工中断后恢复、复杂动态并行分支或长期多 Agent
handoff 产品需求时，才重新评估 LangGraph。若采用，它位于业务 controller 层，节点调用 Entry
或功能模块公开 API，checkpoint 只引用稳定 ID 和已经确认的事实；它不进入 Provider adapter，
不复制数据库事实，也不持久化 prompt、模型原文、Browser 页面或外部调用现场。

### 8. 状态、恢复、日志和权限边界不因 Agent 集成改变

- 文献数据库仍是唯一产品事实源；MCP、Skill、外部 Agent session、PydanticAI 和 SDK 不形成
  第二真相源；
- 外部 Agent 或框架失败不能撤销已提交的有效元数据、PDF、ParserResult 或 LiteratureContent；
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

以下为原 Agent/SDK 边界图，PydanticAI 是历史 Python 选型；当前 TS 组装见技术基线，新知识工作流见[工作流与差异说明](../knowledge-service-workflows.md)。

```text
User
  -> Codex / DeepSeek Harness / other external agent
       -> Skill (workflow guidance)
       -> local MCP (typed Entry adapter)
            -> EntryApi
                 -> Literature / Metadata / Acquisition / Parsing / Analysis
                      -> AgentRuntime (single-call neutral waist)
                           -> PydanticAI Direct adapter
                                -> Provider SDK/model
                                     -> SDK transport bridge
                                          -> Network HttpClient / AccessCoordinator
                                               -> Provider endpoint
```

控制方向与事实方向不同：外部 Agent 向下选择操作，SciRetriever 业务模块向内形成并提交事实；SDK
和 Harness 都不能越过相邻边界直接改变数据库。

## 兼容与迁移

- 现有 `ASSET_READY` 与 `CONTENT_READY` 语义保持不变；新增
  `PARSER_RESULT_READY` 是加法扩展，不迁移 Catalog、ArtifactStore 或既有文献数据；
- `PARSER_RESULT_READY` 不增加 Literature 状态、持久任务或新事实 owner；现有 ParserResult
  schema 和兼容 current 关系保留；新 Document/Evidence 按 ADR 0026 提供独立可读表示和有效证据版本，不静默修改旧字节格式；
- 现有 `AgentRuntime` 继续作为消费者 façade。SDK transport gate、两种真实协议和消费者等价
  测试通过前，不删除当前 Provider adapter；
- gate 通过后按 Provider/消费者切片迁移，并删除已经替代的 wire encoder/parser、schema/tool
  重复实现和只验证 Vendor envelope 的测试，不保留运行时双路径或 fallback；
- 新依赖只使用任务所需的 slim extras，并在实际切换切片中更新 `pyproject.toml`、`uv.lock`、
  wheel 与依赖说明；本 ADR 本身不宣称依赖已经安装；
- MCP/Skill、第三个补全目标和 SDK runtime 只有在源码、直接测试、生产对象图、技术文档、当前
  用户文档和安装后验收闭环后，才能写成已发布行为；
- 任何涉及 Agents、补全目标或外部 Agent 入口的实施计划都必须以本 ADR 为恢复门，不得继续
  扩张已经决定由成熟 SDK 替代的 Vendor wire 实现。

## 后果

### 正面结果

- Codex 等外部 Agent 可以直接控制搜索、PDF 入库、解析、分析和导出顺序，而不复制
  SciRetriever 的身份、状态、事务与安全规则；
- 普通用户仍可通过 `CONTENT_READY` 一次补齐最终内容，不被迫理解内部阶段；
- Parser 可以成为明确的成本和故障检查点，但 ParserResult 不被提升为第四种文献状态或最终
  产品；
- SciRetriever 对外暴露稳定产品能力，而不是内部模块、Provider 或框架类型；
- PydanticAI/Provider SDK 可以减少重复 wire protocol 与 schema/tool 代码，业务消费者保持
  Provider-neutral；
- Codex、DeepSeek Harness、其它 Agent 和 CLI 共用同一事实与 Entry 语义，不形成供应商锁定；
- LangGraph 等 durable runtime 只有在真实需求出现时才引入，避免为当前简单 workflow 增加
  第二套状态系统。

### 成本与风险

- `PARSER_RESULT_READY` 增加一个长期 Application API 目标及相应 Report、CLI/MCP、测试和文档
  责任；
- PydanticAI 与 Provider extras 增加依赖、升级和 supply-chain 审查面；
- 同步、强策略化的 SciRetriever Network 与 SDK 预期 transport 之间可能需要非平凡 bridge，
  gate 可能证明当前 SDK 路线不可行；
- MCP 扩大了可发起联网、成本和写入操作的入口，需要准确工具描述、审批提示和同等服务端保护；
- 外部 Agent 可能根据过期 session 作出错误计划，因此 Skill 和工具结果必须引导它重新读取
  current facts；
- 同时提供高层 `CONTENT_READY` 和阶段目标要求文档明确“推进到目标”而非“精确调用内部一步”。

## 不采用的方案

- **只提供一个从发现到内容完成的黑箱命令。** 它不能满足外部 Agent 对范围、成本、审批和阶段
  结果的实际控制需求，也与已经解耦的 Discovery/Completion 不一致。
- **把 Metadata、Acquisition、Parsing、Analysis、Storage 或数据库直接暴露给 Codex。** 这会
  把调用顺序、stale 检查、provenance 和一致提交知识复制到每个客户端。
- **让 MCP 直接调用模块内部 API 或建立自己的 Job/状态库。** 这会形成第二套应用语义和恢复
  机制。
- **把 ParserResult 提升为第四种 Literature 状态或独立最终文档。** 当前 ParserResult 仍是
  旧 Analysis 的可替换输入；ADR 0026 的独立文档/证据层已修订其仅供分析的范围，不把原始 parser 私有输出直接当成产品文档。
- **把未经裁剪的完整 Agent 应用作为核心运行环境。** 默认 shell、filesystem、个人配置和
  外部工具不因框架接入获得权限；ADR 0031 已明确选择 DSH 的最小受控组件，而非其默认应用。
- **继续默认手写所有 Provider wire protocol。** 只有 SDK transport gate 失败并留下可审计
  证据时才合理，不能在未比较成熟 SDK 的情况下继续扩张。
- **只逐家接入官方 Provider SDK 而不使用统一 typed translation layer。** 它可以作为
  PydanticAI transport gate 失败后的候选，但不是首选；它仍会让三套 message、schema、tool、
  usage 和 failure 归一化分别落在 SciRetriever adapter 中。
- **让 SDK 自行联网或绕过 Network。** 减少 adapter 代码不能补偿 credential、quota、redirect、
  有界响应和日志边界的丢失。
- **使用 PydanticAI 高层 Agent loop 或立即引入 LangGraph。** 当前业务 controller 已有清晰
  owner 和恢复语义，这些 runtime 不解决主要的 Provider wire 重复问题。
- **首版建设远程、多用户 MCP。** 当前本地 catalog、资产、Profile 和凭据没有远程租户与授权
  合同。

## 需要新 ADR 的变化

- 外部 Agent 获得 SQL、Storage publication、事实写入、任意 Provider/Browser/Parser/LLM、
  secret、内部路径或未受控文件系统权限；
- SciRetriever 的核心产品能力开始依赖某个外部 Agent Harness、thread 或持久 conversation；
- ParserResult 成为新的 Literature 状态，永久保存全部解析尝试，或破坏其受支持交换格式；ADR 0026 的独立读取和有效证据保留已获接受；
- MCP 建立持久 Job/Task 状态，或改为远程、多用户、跨租户服务；
- 引入 LangGraph 或其它 durable workflow/checkpoint/HITL runtime；
- framework 开始拥有 Analysis/Acquisition 业务 workflow，执行未经消费模块授权的 Browser tool 或绕过业务验收；ADR 0031 已允许受控工具委托；
- SDK 无法通过公开 transport hook 满足 Network gate 而决定长期保留自研 wire adapter；
- 允许 SDK 自动 retry、redirect、telemetry 或第二条外部联网路径，或者把任一协议 streaming
  暴露为消费者状态、运行时自动协商或失败后的第二次模型请求；
- 改变 `AgentRuntime` 的无状态单次调用窄腰，或把 Provider/SDK 类型暴露给业务消费者；
- 破坏现有 `BatchGoal`、持久数据、artifact 或稳定 Entry 调用方的兼容性。
