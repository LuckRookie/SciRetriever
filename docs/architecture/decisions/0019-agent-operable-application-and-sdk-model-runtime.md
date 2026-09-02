# ADR 0019：Agent 可编排应用边界与 SDK 驱动模型运行时

- Status: Accepted
- Date: 2026-08-26
- Last amended: 2026-09-01
- Supersedes: none
- Superseded by: none
- Amends: [ADR 0013](0013-decoupled-discovery-and-database-maintenance.md)、[ADR 0017](0017-shared-agents-and-controlled-browser-agent.md)
- Amended by: none
- Related: [ADR 0010](0010-parser-neutral-markdown-current-result.md)、[ADR 0011](0011-literature-database-centered-incremental-maintenance.md)、[ADR 0012](0012-process-local-provider-access-scheduling.md)、[ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)、[ADR 0021](0021-provider-model-registry-and-direct-task-selection.md)、[产品需求](../requirements.md)、[设计文档](../design.md)、[Entry 技术文档](../technical/entry.md)、[Agents 技术文档](../technical/agents.md)、[Network 技术文档](../technical/network.md)

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

| 概念 | 责任 |
| --- | --- |
| 外部 Agent Harness | 面向用户的控制面；选择和组合 SciRetriever 产品操作 |
| SciRetriever Application API/SDK | 稳定、领域中立、可供 CLI、Python 和 MCP 共用的产品能力合同 |
| MCP | 把 Application API 映射为外部 Agent 可调用的类型化入口 |
| Skill | 说明如何组合 MCP/CLI、何时审批以及如何根据结果恢复；不是权威 API |
| 内嵌模型框架或 Provider SDK | 在 `agents` 私有适配边界内完成模型协议与类型转换 |
| LangGraph 一类 workflow runtime | 在确有 durable workflow、checkpoint 或 HITL 需求时编排业务节点 |

如果把 SciRetriever 做成只能“一键运行到底”的封闭应用，外部 Agent 无法在成本、审批、失败
和阶段结果之间进行有意义的编排。如果把内部模块、数据库或文件系统直接交给外部 Agent，又会
复制身份、校验、provenance、事务和恢复规则，破坏统一事实所有权。目标因此不是“封闭应用”或
“低层组件工具箱”，而是核心不变量闭合、产品能力控制开放的文献引擎。

成熟 SDK 也不能仅因减少代码而绕过 SciRetriever Network。Network 已经统一拥有
AccessCoordinator、URL/DNS/origin 准入、origin-bound credential、redirect、timeout、取消、
响应字节上限、quota/`Retry-After` 反馈和日志脱敏。只有能把全部外部 I/O 注入这条边界的 SDK
才能成为生产实现。

## 决策

### 1. SciRetriever 是 Agent 可编排但不由 Agent 拥有的文献引擎

产品定位固定为：

> SciRetriever 是一个面向大批量、持续维护场景的领域中立文献数据库引擎。它向人类和外部
> Agent 提供可组合、幂等、可审计的文献操作；外部 Agent 可以决定操作顺序和范围，但身份、
> 网络访问、资产验收、解析发布、内容接纳和数据库完整性始终由 SciRetriever 负责。

该定位概括为“核心闭合，控制开放；Agent 编排，SciRetriever 裁决”。外部 Agent 是可选控制
面，不是 SciRetriever 的运行依赖。没有 Codex、DeepSeek Harness、MCP 或任何其它通用 Agent
时，CLI 和 Python API 仍必须能够完成全部产品能力。

外部 Agent 可以决定：

- 发起本地查询、外部领域发现、引用发现、数据库补全、手动 PDF 接纳、导入或导出；
- 选择明确 ID、DiscoveryRun、导入结果、查询或全库等类型化范围；
- 把数据库推进到主 PDF、当前 ParserResult 或最终 LiteratureContent；
- 根据稳定 Report 和当前详情决定下一项操作、停止、等待或重新发起操作；
- 在联网、Browser 升级、批量 Parser/LLM 成本或用户文件写入前请求用户批准。

外部 Agent 不得：

- 判断或直接提交文献身份、统一元数据、引用关系、当前状态或其它数据库事实；
- 直接调用 Storage、SQL、ArtifactStore publication、Provider adapter、MinerU 私有协议或模型
  Provider；
- 取得任意 Browser/Page/CDP、Cookie、Profile、selector、URL、JavaScript、凭据或内部文件
  路径；
- 绕过 PDF 验收、ParserResult 对齐、Analysis 两阶段验收、stale 检查或一致提交；
- 把自身 session、plan、tool history、下载现场或推断结果变成第二套产品状态。

### 2. Entry 是所有人类和外部 Agent 的唯一应用边界

CLI、Python 调用方、未来 GUI 和 MCP 都调用 `EntryApi` 的产品操作。它们不能直接调用功能模块
的内部 service 或 Port。Entry 继续负责外部值解析、类型化范围、写入准入、目标冻结、当前事实
重读、跨模块编排、局部失败隔离和操作 Report；业务模块继续拥有各自判断，Storage 只提交已经
确认的决定。

目标控制使用“推进到所需结果”的语义，而不是“执行一段内部实现”的语义：

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
的 Literature 仍为 `ASSET_READY`；ParserResult 仍是可替换、可重建的中间结果，不成为独立
最终文档、文献状态或长期历史。

`BatchRequest` 不因第三个目标而接受 Provider、Parser、model、SDK client、数据库连接、并发
实现、凭据、任意 `force`、cursor 或自由参数。明确重解析、切换 Parser、导入外部解析结果或把
ParserResult 变成最终可交换产品属于独立产品变化，不能通过通用参数偷偷加入。

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
- 明确输入/输出：手动 PDF、书目导入、artifact 与书目导出。

可能联网、打开 Browser、调用 Parser/LLM、修改数据库或写用户目标文件的工具必须在工具描述
和客户端审批信息中准确声明副作用、成本与可能耗时。客户端审批不能替代服务端的类型校验、
Network、安全策略和事实 owner。

MCP 不得：

- 暴露 secret 或普通配置编辑、原始 SQL、内部表、Storage path、Provider client、Browser 或
  任意 prompt API；
- 把 PDF、截图或其它大型字节默认塞入模型上下文；应返回稳定 ID、hash、provenance、受控
  artifact reference 和有界摘要，再由明确导出操作取得字节；
- 建立 MCP 专属 Job、Task、Session、Report 历史或文献状态；长操作只返回或投影 SciRetriever
  已有的同步结果和权威事实；
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
- framework 不自动执行 tool。Analysis structured output 和 Browser 六动作决定都作为数据返回，
  仍由消费模块验证并执行；
- PydanticAI、OpenAI、Anthropic、DeepSeek、`httpx` 或其它 SDK 类型不能进入 Model、Entry、
  Analysis、Acquisition、Configuration 公共合同或持久化数据；
- Analysis 继续拥有文献 prompt、两阶段顺序、schema 含义、NoUsableContent、Markdown 和
  ReferenceLookup 验收；Acquisition 继续拥有 Browser controller、Observation/action 含义、
  语义进展和 route outcome；
- 中性 reasoning、模型目录、capability、usage、failure 和 provenance 由 SciRetriever adapter
  归一化。可使用 SDK 的公开模型目录能力，但不能根据模型名称或缺失字段猜测 capability。

PydanticAI 是第一个实现选择，不是业务公共合同。未来可以在保持同一 `AgentRuntime`、Network
和行为测试的前提下替换为另一成熟 SDK，而不要求业务模块或数据库迁移。只有需要改变这些稳定
边界时才需要新 ADR。

DeepSeek 模型作为普通模型 Provider 接入，不要求嵌入 DeepSeek Harness。Codex、DeepSeek
Harness 等完整 Agent runtime 留在 Entry/MCP 外侧，不能成为 `sciretriever.agents` 的生产依赖。

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
- Analysis typed output 与 Browser typed decision 成功，但 framework 不执行 Browser 动作；
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

PydanticAI Direct 解决模型协议和类型转换，不拥有产品 workflow。当前 Analysis 两阶段、
ReferenceLookup、数据库补全、Acquisition cohort 和 Browser controller 都已有明确 owner、终止
条件、局部提交与当前事实恢复机制，继续由普通 Python controller 组织。

当前不引入 LangGraph、PydanticAI 高层 Agent、OpenAI Agents SDK 或其它会默认拥有 loop、
session、handoff、checkpoint、memory 或 tool execution 的通用 Agent runtime。它们既不能替代
Provider transport gate，也不能改变业务 owner。

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
- prompt、模型原文/reasoning、Browser Observation、screenshot、tool payload 和外部 Agent
  conversation 不进入 Catalog、ArtifactStore、Report、provenance 或日志；
- 日志继续只记录安全 operation、role/provider/model、结果类别、usage、延迟和稳定失败；客户端
  日志或 thread history 不能替代 SciRetriever Report；
- 所有写入仍经 Entry 写入准入、业务 owner 验收和 Storage 一致提交；外部 Agent 的用户授权不
  等于绕过这些边界的系统权限。

## 目标架构

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
  schema、单一当前关系和 replacement 规则保持不变；
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
  Analysis 的可替换中间输入；Agent 控制不需要改变其数据性质。
- **把 Codex、DeepSeek Harness 或其它完整 Agent 嵌入核心运行时。** 它们带入 thread、shell、
  filesystem、工具和更大权限面，并使产品依赖特定 Harness。
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
- ParserResult 成为新的 Literature 状态、长期历史、独立最终文档或公开交换格式；
- MCP 建立持久 Job/Task 状态，或改为远程、多用户、跨租户服务；
- 引入 LangGraph 或其它 durable workflow/checkpoint/HITL runtime；
- framework 开始拥有 Analysis/Acquisition workflow、自动执行 Browser tool 或绕过业务验收；
- SDK 无法通过公开 transport hook 满足 Network gate 而决定长期保留自研 wire adapter；
- 允许 SDK 自动 retry、redirect、telemetry 或第二条外部联网路径，或者把任一协议 streaming
  暴露为消费者状态、运行时自动协商或失败后的第二次模型请求；
- 改变 `AgentRuntime` 的无状态单次调用窄腰，或把 Provider/SDK 类型暴露给业务消费者；
- 破坏现有 `BatchGoal`、持久数据、artifact 或稳定 Entry 调用方的兼容性。
