+++
document_type = "proposal"
status = "superseded"
created = "2026-10-13"
+++

# Agent 能力工具化与执行基础选型提案

> 归档说明（2026-10-13）：Owner 已选择 DSH/Cordis，放弃 Pi Agent 后端。以下保留决定前的调研正文，正文中的“选型未定”仅为历史状态。当前决定见 [ADR 0031](../../architecture/decisions/0031-dsh-backed-agent-capabilities.md)，待审实施方案见 [DSH 接入提案](../2026-10-13-dsh-agent-backend/proposal.md)。选型完成不代表实施获准或验收完成。

本提案保留 2026-10-13 关于 Browser Agent、多轮上下文、Pi 与 LangGraph 的讨论，以及 Owner 后续提出的 DeepSeek Harness（DSH）与 Pi 后端比较。

**当前状态：尚未决定采用 Pi，也未选择其它替代框架。** Owner 已撤回先前“采用 Pi”的决定；当时新增的采用 ADR 及对既有 ADR 的修订已撤回。本文件是讨论材料，不修改 Accepted 架构、不授权实施，不兼任计划。后续 DSH/Pi 源码调查与建议见第 12 节；研究建议不等于选型决定。

## 1. 要解决的问题与设计诉求

近期 Browser 实测和代码核对暴露了两个相关问题：复杂页面流程中存在反复尝试已失败路线、过晚结束的情况；模型收到的历史是近期动作与反馈，缺少贯穿任务的完整“观察—动作—结果”轨迹。单纯减小预算可以更早终止，却不能证明 Agent 的判断得到改善。

讨论进一步涉及长期维护：除 Browser 获取 PDF，未来的数据提取、图片提取等能力也可能需要模型与工具协作。若每项能力都自行实现会话、工具循环、反馈与上下文管理，会增加重复维护；引入库也可能带来额外适配和运行复杂性。

Owner 希望把 Agent 能力工具化：调用方通过明确输入和输出安排工作流，不必逐步操纵内部对话。该诉求独立于是否采用 Pi；本提案不预先冻结能力接口、模块划分或提取算法。

需要回答：

- 补齐现有实现是否已经足够，现成 Agent 库还能减少哪些维护工作？
- 怎样保持完整操作与结果历史，同时控制输入成本和资源增长？
- Pi 或其它执行基础如何融入配置、网络、Web 控制和下载调度？
- 能否复用长对话处理多篇，收益是否大于任务切换、污染和恢复成本？
- 工作流调用的能力与 Agent 内部工具各自应承担什么责任？

## 2. 当前实现与讨论边界

当前 TypeScript 实现使用自有流程控制、共享单次 `AgentRuntime`、Playwright 与 CloakBrowser/Chromium。CDP、Network、Browser 和 Acquisition 协作完成网络准入、页面操作、下载捕获与文件发布；没有接入 Pi 或 LangGraph。

截至本次核对，模型每轮收到当前目标、页面文字/元素/状态、当前截图、最近最多六条动作、最近六次非等待动作的可读描述和即时反馈。请求重新构造为 system/user 消息，没有完整的工具调用及结果会话。代码入口为 [article-flow.ts](../../../apps/server/src/browser/article-flow.ts)、[decision.ts](../../../apps/server/src/browser/decision.ts) 和 [Agent 消息合同](../../../apps/server/src/agents/protocol.ts)。

当前已有文章任务隔离、后台下载让出决策资源、下载失败回到原文章、Web 观看/指导/接管、5 秒动作节奏、单篇累计活跃时间与调用预算、共享平台冷却等机制。这些不能作为引入框架后才获得的新收益。具体当前行为以[Browser 技术文档](../../architecture/technical/08-browser-control.md)和源码为准。

近期真实样本的完整用例、日志、文件与耗时报告保留在本机 Git 忽略的 sandbox；本提案只提炼问题，不复制测试台账。当前尚无 Pi 或 LangGraph 在同一批文献上的真实对照结果，不声称框架已经提高成功率或降低耗时。

## 3. 候选方案与实际收益

| 候选 | 能带来的价值 | 需要承担的工作与限制 |
| --- | --- | --- |
| 改进现有实现 | 补齐完整操作与结果历史，改动范围较小，复用当前调度和配置 | 通用会话、工具消息、上下文管理和模型协议继续由项目维护 |
| Pi Agent Core | 复用有状态模型—工具循环、消息历史、执行事件和上下文变换接口 | Core 不等于完整会话宿主；持久化与自动压缩等能力需另作选择，仍需接 Browser 和 Network |
| Pi 完整 SDK | 在循环基础上复用会话管理、上下文压缩、指导和生命周期机制 | 显式隔离资源发现与配置，统一重试、压缩、请求计量和结束语义，避免两套循环并存 |
| DeepSeek Harness | 用 Cordis 按需组合 Agent、模型、工具、会话与压缩；也提供 ACP 外部控制 | 可进程内直接挂载所需插件，对接 Browser 与 Network；需要管理插件依赖、消息转换与生命周期，见第 12 节 |
| LangGraph | 状态编排、检查点、人工中断与恢复，适合确有复杂流程需求的场景 | 图状态不能自动恢复活浏览器和下载；需决定替换哪层现有调度，不能只叠加第二套状态机 |
| Owner 后续提出的其它方案 | 待补充后比较 | 不预先排除，也不在信息不足时推导实现 |

Pi 在本讨论中的主要预期收益是减少通用 Agent 基础设施的维护，并让未来调整工具、上下文和执行策略更方便。完整历史也能在原实现中补齐；缓存不是 Pi 独有能力。导航错误、站点限流、机构权限和下载捕获不会因为替换 Agent 库而自动解决。

选型应同时比较实际任务效果和维护成本：即使成功率相当，若能明确减少自有循环代码、降低后续变更难度，仍可能有价值。若只是包裹原循环，增加适配却未替代原有责任，收益不足。

## 4. 缓存、会话复用与成本

需要区分三件事：运行环境复用、模型输入缓存、聊天历史复用。三者可以分别设计。

创建一个新的逻辑对话不等于启动新的进程、浏览器或向模型发送额外初始化请求。显式提供精简 Browser 提示词和工具后，不必每篇重新扫描仓库、加载个人指令或 Coding Agent skills。

同样，长寿命 Pi session 不等于模型服务免费永久保存全部上下文。Pi 将当前上下文组织为模型请求；缓存参数、稳定前缀及服务端实现共同影响实际命中。不同对话也可能复用相同系统/工具前缀，长对话则可能因累积历史增加输入量。

当前测试模型服务的缓存支持、计价和实际命中尚未核实。不能仅凭 session ID、SDK 支持缓存参数或对话连续，认定已经节省费用；未返回缓存用量也不能直接解释为已证明无缓存。

| 对话方式 | 可成立的收益 | 主要取舍 |
| --- | --- | --- |
| 长驻运行环境，每篇独立对话 | 复用初始化资源，文章之间上下文清楚，独立暂停/恢复 | 不自然继承上一篇交互经验，稳定提示前缀需要重复表达 |
| 有限批次连续对话 | 保留近期经验，可能获得缓存与连续判断收益，批次结束可轮换 | 需要明确任务切换、下载恢复、压缩归属和保留策略 |
| 永久连续对话 | 连续性最强，依赖压缩维持模型输入范围 | 原始历史仍可能增长，错误经验和旧页面内容可能影响下一篇，调度恢复更复杂 |

Owner 提出的连续会话方案保留为正式候选，不把每篇新对话写成必选。也不将“同出版社上一篇没有访问权”压缩成跨文章禁行规则；摘要中的经验不成为权限事实。

## 5. 资源占用与本机 Pi 隔离

### 资源需要分别测量

嵌入 TypeScript SDK 可以共用 Node 进程、模型客户端和现有浏览器，不必每篇启动 CLI。使用远程模型不要求新增本地模型权重；本机增量主要来自消息、截图、事件、序列化和会话文件。安装依赖体积与实际启用功能的运行占用不是同一个指标，目前没有测得可承诺的内存/CPU 数字。

Pi 的上下文压缩会生成摘要并改变后续模型输入，但不自动删除全部原始 session entries。内存会话只是关闭文件持久化，历史仍会驻留；若工具结果含截图字节，压缩后原图仍可能占用内存或会话文件。长期运行需考虑旧截图投影、历史保留、轮换和资源释放，不能只设置模型上下文阈值。

### 隔离目标与候选接法

Pi SDK 的默认工厂会使用工作目录、文件设置、会话存储和资源发现。只换 session 目录或 agentDir 不足以隔离：默认资源加载器还会读取工作目录及祖先目录的 AGENTS/CLAUDE 指令，设置、凭据与网络也可能受进程环境影响。

若采用 Pi，候选接法是项目锁定本地依赖，显式提供模型运行配置、资源加载器、设置、会话管理和 Browser 工具集合，不调用服务器的全局 Pi 命令。个人 Pi 的模型、凭据、指令、扩展与会话不能隐式进入 SciRetriever；精确 SDK 参数须按最终锁定版本验证，不靠修改进程全局环境变量来切换。

独立进程不会自动共享内存对话，但相同模型账号/API Key 的供应商额度、同服务器的 CPU/内存与网络仍然共享。隔离配置不等于获得独立配额。Browser Profile 也继续由现有 Host 明确管理，不因 Pi 会话复用而改用个人浏览器目录。

## 6. Web、文章任务与后台下载

### 同一个生产浏览器

Web 继续观看和控制现有 Browser，而不是嵌入 Pi 终端或另开一个浏览器。Pi 作为受控操作者，调用同一套页面工具；观察、下载、发布仍由当前模块执行。观看对象与操作授权分开，用户切换 Web 当前文章不能自动把 Agent 的工具绑定切到另一篇。

指导绑定目标文章、会话和控制版本；接管应立即撤销旧动作执行资格并取消在途推理，交还后重新观察并反馈人工操作结果。仅向模型发送“暂停”不能代替程序暂停。模型或工具的迟到结果不能在控制权已经变化后执行。

### 运行时、对话、任务和 worker 分开

当前 worker 是执行文章一次 step 的并发许可，没有长期 worker 身份；文章 session 才持有页面、控制版本、预算与下载关联。把每个 worker 绑定长期 Pi 对话会改变调度关系，不能默认已经有这层归属。

跨篇同对话必须处理以下情况：

```text
A 开始后台下载 → 对话处理 B → A 下载失败 → 恢复 A
```

候选处理是将失败先交给 A 的待恢复任务，正式调度回 A 时，再绑定 A 的目标、预算和新观察。不能把 A 的失败当作 B 当前工具结果，也不能让旧工具执行时读取一个已切到 B 的可变 currentPage。

若同一对话必须等 B 完成才恢复 A，会增加 A 的等待；引入抢占、分支或迁移可以改变该取舍，但也增加复杂性。需要实测，不能只比较输入 token。

同平台网络资格继续由共享调度器管理。当前主下载仍占用该平台资格，网络真实结束后才进入冷却；Pi 转做下一篇不能绕过这一限制。对话压缩、轮换或切换文章不能重置原文章的累计预算或改变下载归属。

## 7. 程序约束与 Agent 策略的分工

采用现成库或长会话并不要求把约束退化成 prompt。

| 程序必须继续掌握 | 模型负责判断 |
| --- | --- |
| 当前任务/页面绑定、观察版本和控制权 | 根据观察选择相关下一步 |
| 模型与页面实际派发、动作间隔、平台准入和累计预算 | 理解页面反馈、判断可行路线 |
| 取消、下载事件归属、文件接纳与正式发布 | 给出有依据的停止意图，不能自行宣布入库成功 |
| 配置、凭据、网络和工具权限 | 使用提供的目标、材料与工具，不自行扩展权限 |

同一页面仍需逐次观察和执行。即使 SDK 设置顺序执行，一次模型输出的多个动作也可能基于同一张旧截图，仍须处理版本变化与重新观察。

Pi 的普通调用、压缩、重试和其它自动请求需要统一准入、计量和取消。核对版本含自动重试、压缩恢复与条件触发的缓存保温请求；候选做法是避免与现有重试叠加，首次验证关闭保温，再根据实际缓存收益评估。Pi 的一次 `agent_end` 之后仍可能恢复，SDK 稳定结束信号需要与调度器交接对齐。

压缩不是业务状态保存者。当前 SDK 的默认压缩会截取长工具结果并以文本摘要处理历史；动作结果和关键障碍应放在工具返回的前部。文章身份、预算、传输与控制版本必须保留在软件中，不能只由摘要记忆。

## 8. Agent 能力工具化的讨论方向

“Agent 工具化”包含两层：

| 层次 | 讨论中的用途 | 不应混淆 |
| --- | --- | --- |
| 工作流调用的 Agent 能力 | 给出目标和材料，得到结果、产物/证据引用、完成范围或失败 | 调用方不需要逐步操纵 Pi，也不依赖框架私有消息类型 |
| Agent 内部使用的工具 | 观察/操作页面、读取材料、访问图片资源等 | 能力不自动授予 shell、任意脚本、凭据或数据库写入权 |

输入/输出明确不表示必须是纯函数、没有副作用或只能同步返回。进度、取消、人工介入、下载与发布仍需明确表达。具体合同待设计，不在本提案中创造一套统一巨型 Agent schema，也不要求每个内部工具都成为公共 MCP 工具。

Browser 获取 PDF、按调用方规范提取数据、提取图片是讨论场景；后两项的精确输入、提取含义、粒度、证据和产物保存尚未确定，不冒充已经实现的算法或 API。

[ADR 0027](../../architecture/decisions/0027-extraction-capabilities-and-caller-defined-records.md) 的边界继续适用：调用方拥有领域记录含义、schema、提取策略及最终数据集；内部 Agent 不成为唯一外部提取入口，候选 payload 不进入 Literature 固定字段。框架历史不成为第二事实库，结果继续绑定真实来源、输入版本及 lineage。

## 9. 与现有 ADR 的关系

本提案未修改以下已接受选择。若最终选择引入有状态 Agent 执行基础，需要明确修订适用条款，而非把旧文档当作无法重新讨论的理由：

- [ADR 0017](../../architecture/decisions/0017-shared-agents-and-controlled-browser-agent.md)：无状态共享 Runtime、会话/历史/工具循环与消费模块控制器的边界。
- [ADR 0019](../../architecture/decisions/0019-agent-operable-application-and-sdk-model-runtime.md)：协议 SDK、内部执行基础、Entry 与 Network transport gate。
- [ADR 0023](../../architecture/decisions/0023-generic-browser-agent-executor.md)：模型输入、文章 session/worker、原子动作与运行约束。
- [ADR 0026](../../architecture/decisions/0026-agent-knowledge-and-human-collaboration.md)：产品职责、人类协作及有限解析/分析的预算边界。

任何方案都应沿用单一事实 owner、不可变资产、凭据与网络准入、独立任务取消及结果来源。底层 SDK 替换不意味着直链下载、MinerU 或所有单次模型处理都要改造成自治 Agent。

## 10. 待继续讨论与候选验证

Owner 已补充 DSH 候选并授权源码调研，结果见第 12 节。当前仍未执行下列运行实验，也未生成实施计划。

后续需要确认的事项：选型与首批范围、现有循环具体替换点、工作流可调用接口、会话/worker关系、完整历史与图像保留、缓存/压缩、模型兼容、配置隔离、Web/下载交接及旧实现迁移。

候选对照可以包括：现有实现补齐历史；Pi 按篇对话；Pi 有限批次连续对话；DSH/Cordis 最小进程内组合。ACP 在确有独立进程需求时另作选择；只有存在匹配需求时再加入 LangGraph 实现对照。保持模型、工具、预算和浏览器初始条件可比，控制限流与执行顺序偏差。

评价维度不止成功率：

- 成功/失败的端到端耗时、活跃操作与等待时间、重复失败路线和过早停止。
- 普通推理、压缩、重试的请求数及 token，实际缓存使用和费用。
- 连续运行的进程内存、截图占用、会话文件增长及释放情况。
- A 下载挂起后推进 B、A 恢复的延迟与正确归属。
- 模型执行期间人工接管、取消、旧动作晚到及交还后的新观察。
- 使用合成的个人 Pi 设置/指令验证隔离，不读取真实个人配置。
- 实际删除了多少自有通用循环责任，后续修改是否更容易，而非只比较新增依赖是否能运行。

## 11. 已核对的公开资料与证据边界

- [Pi 官网](https://pi.dev/)：SDK/RPC 与上下文能力说明。
- [Pi SDK 文档](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/docs/sdk.md)：默认组装、会话与运行事件。
- [Pi Agent Core](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/agent/README.md)：工具循环、消息和钩子。
- [Pi 压缩机制](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/docs/compaction.md)、[默认设置](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/core/settings-defaults.ts)、[会话管理源码](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/core/session-manager.ts)：压缩、自动请求与历史保留。
- [Pi 资源发现](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/core/resource-loader.ts)、[显式配置示例](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/examples/sdk/12-full-control.ts)：隔离候选接法。
- [LangGraph JavaScript 概览](https://docs.langchain.com/oss/javascript/langgraph/overview)、[持久化](https://docs.langchain.com/oss/javascript/langgraph/persistence)：编排与恢复能力。

资料核对日期为 2026-10-13。Pi 固定提交用于追溯讨论中的源码事实，不是已选定或验收的发布版本；不能把当前 main 的接口与默认值当作永久合同。尚未安装依赖，也未验证实际模型兼容、缓存收益、资源占用或框架下载效果。

## 12. DeepSeek Harness 与 Pi 后端比较（2026-10-13）

### 调查范围与结论

Owner 所说的 DSH 已确认为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。本轮读取官方文档、公开接口、实现及相关测试源码，并与 SciRetriever 的 Browser/Agents 边界对照。DSH 固定提交为 `d743267388641bc76f17c45ce8b4c231aed1d32c`（`0.2.1-alpha.2`）；Pi 继续使用第 11 节固定提交（相关包版本 `1.2.0`）。二者均为 TypeScript/MIT，Node 要求与当前项目基线相容。

**研究建议：按长期复用会话、压缩和多种工具化 Agent 能力的目标，优先验证 DSH/Cordis 的最小进程内组合，同时保留 Pi SDK 作为对照。** DSH 的插件边界允许直接接入现有 Browser、Network 和配置，既不必引入完整应用，也不必先增加 ACP/MCP 或子进程。若范围仅为替换短小的 Browser 循环，Pi Core 的直接调用方式更简单。这个建议是架构适配倾向，未证明任一方案的成功率、耗时或维护总成本更好，选型仍未决定。

本轮没有安装依赖、启动候选运行时或调用真实模型。运行内存、冷启动时间、缓存费用和真实下载表现均未测量；不能用包数量或官方功能表代替这些数据。

### 必须比较正确的接入层

**主要比较对象是 DSH 的最小 Cordis 组合与 Pi 的按需 SDK 组装。** 完整 DSH 应用的默认功能和普通 SDK 的协议限制，不是最小进程内后端必须承担的成本。

这不是仅凭“Everything is a Plugin”推导的可能性：官方 `agent-loop/tests/loop.spec.ts` 直接 `new Context()`，只挂载 `LlmRuntime`、`SessionStore`、`SessionProjectionRegistry`、`SystemPrompt`、`ToolRuntime`、`AgentRegistry`、`AgentLoop` 七个基础插件，再注册模型 adapter。该组合不挂 CLI、SDK、ACP、Web、shell、home、settings、遥测、代理或文件持久化服务。

继续核对得到：

- 压缩插件的必需服务为 `llm`、`tokenMeter`、`sessions`；`TokenMeter` 依赖已有的 session projections。可以在上述循环组合上增加压缩所需服务，工具结果裁剪等另行选择。官方测试有直接加载与卸载的例子，无需完整 base profile。
- 图片的 `AttachmentStore` 是可替换的公开抽象服务，不强制采用 `attachment-local` 或个人 home。可以对接任务内截图存储或宿主字节引用，但需实现图片读取、有效性和生命周期合同。
- Browser 工具可以通过 `ctx.tools.register` 直接调用现有函数；自己的 `LlmAdapter.stream()` 可以直接使用 SciRetriever Network。两者均不要求本机 HTTP broker 或跨进程桥。
- npm 上的 `dsh-agent-loop`、`dsh-compaction-basic` 对应版本已分别发布，不要求为了调用它们而安装标准 SDK 客户端。运行时挂载的插件集合与包的传递/peer 依赖集合不同，不能把“七个插件”解释为只有七个 npm 包。

官方完整产品的启动支持仍围绕 `dsh` profile。进程内组合是在复用公开插件及其测试覆盖的接点，需要我们维护自己的组合与升级验证；它既不是修改 DSH 内核，也不是已经验收过的 SciRetriever 接法。

若另行选择外部进程，DSH 还提供两条需要区分的接口；这些不作为进程内方案的扣分项：

- **普通 SDK**：`DeepSeekHarness` / `HarnessClient` 支持会话、图像、事件和持续运行；当前 wire 没有按会话中途取消，放弃执行需要关闭 runtime。`run().finalResponse` 是消息接收至整 Agent idle 期间最后的 assistant 文本，不保证与单个输入存在一一因果关系。
- **ACP**：支持同一连接的多会话、分别取消和关闭、恢复持久会话、选择模型与思考强度，以及挂载 MCP 工具。官方测试包含“取消 A 不影响 B”。标准 ACP 没有直接 steer 接口，内部 Agent 已有；外部人工指导可以取消后携带新观察重新 prompt，或另外暴露所需控制。

Pi 也有两层：Core 提供模型—工具循环、消息、图像、事件和取消；完整 SDK 才进一步提供现成会话管理与自动压缩。不能同时把 Core 的最小接入成本和完整 SDK 的全部能力算作同一方案。完整 SDK 的编码工具、资源发现和提示词可以定制，但会话、设置与模型运行配置仍由 Pi 的具体类及扩展接点承担；若选择 Core，则须把自行补齐上下文管理算入成本。

### 与 SciRetriever 的适配比较

| 项目 | Pi 进程内 SDK | DSH 最小 Cordis 组合 |
| --- | --- | --- |
| Browser 工具接入 | 以工具回调直接调用现有观察和动作函数 | 以工具插件直接调用相同函数，无需 MCP 或 IPC |
| Web 指导与接管 | 有 `steer`、`abort`、idle/settled 语义 | 内部 Agent 已有 `steer`、`cancel`、`whenIdle` 和 scoped lifecycle，不受普通 SDK 的取消限制 |
| 会话与压缩 | 完整 SDK 提供；Core 只有上下文转换接点 | 会话、token 计量、压缩分别组合；支持自定义摘要实现 |
| 使用现有模型服务 | 可声明自有模型并接入模型流；需验证图像、工具、`max` 的准确映射 | 自定义 `LlmAdapter` 可直接复用本项目网络；也可选择已有 `pi-ai` 多供应商 adapter，并非只支持 DeepSeek |
| Network 与请求计量 | Core 有 `streamFn`；完整 SDK 有 `modelRuntime`、HTTP `fetch` 接点，需覆盖全部请求 | `LlmAdapter` 和 `llm/stream` 是统一入口，普通与摘要调用均可经过它；不挂默认模型插件即可避免其独立网络路径 |
| 配置与资源隔离 | 显式提供资源加载器、设置、模型和会话，隔离个人 Pi 默认资源 | 最小组合可完全不挂个人 home/settings/credentials/proxy 服务，由宿主显式注入 |
| 运行与分发成本 | 可共用当前 Node 进程；完整 SDK 含会话、扩展和编码应用相关包 | 同样可共用 Node 进程，按包与服务选择；需要管理 Cordis 依赖图与一致版本，资源优劣尚未实测 |
| 后续提取能力 | 通过自定义工具与扩展复用会话执行基础 | 可按 Agent scope 安装工具、提示和监听器，复用服务，并随 scope 生命周期释放 |
| 版本维护 | 有正式公开 SDK；本次版本仍有事件合同 breaking changes，不能承诺无成本升级 | 官方明确处于 developer preview，会有破坏兼容的变化；需要锁版本与适配验证 |

DSH 的多供应商模型插件本身使用 `pi-ai`。因此二者不是完全独立的模型生态；比较核心是上层 Agent 执行、工具与会话宿主如何接入我们，不能按名字把 DSH 等同于 DeepSeek 模型，也不能认为 Pi 必须使用某个模型。

### 两者都不能自动完成的交接

现有文章 session、页面与控制版本、平台冷却、后台下载、候选接纳与正式发布继续有各自的业务所有者。框架应该替换通用循环与上下文管理，不能再建立第二套 PDF 调度和事实库。

应保留的最小流程是：任务给出元数据与目标；Agent 通过受控工具观察和操作同一个生产 Browser；下载开始后由 Acquisition/传输管理继续下载，并让出决策资源；失败时恢复原文章的执行上下文；文件发布结果由软件反馈给任务。Agent 的自然语言“完成”不是文件入库凭据。

Pi 的 steer 是排队指导，DSH 的内部 steer 在后续 step 消费，都不会自动撤回已发生的页面动作。两者的取消依赖工具和模型请求响应 signal；仍必须服从文章的控制版本和派发资格，人工接管不能只靠模型收到一句“暂停”。

DSH 工具的公开 `concludeTurn()` 可在成功结果后要求循环结束当前 turn，后续以同一 session 的新输入继续。它可以作为下载开始后让出决策资源的接点，不必等待模型自行结束；但同次响应的其它工具仍需由版本与执行资格检查约束。这只是已有接口能表达交接，尚未证明已适配当前 step/worker 调度。

DSH 自带 Browser provider 注册和 Playwright/DevTools 等适配也不等于自动接入当前 Browser：其 provider 自己拥有页面资源和 Session。若使用 DSH，仍应让它调用本项目 Browser 的工具边界，避免产生用户观看一个浏览器而 Agent 操作另一个浏览器的情况。

### 会话、缓存和成本判断

两者都支持在复用运行环境的同时保持多个独立会话，因此都不要求每篇文献重启进程。连续跨篇对话仍是第 4、6 节的独立设计问题；文章 A 下载挂起后处理 B、再恢复 A 的归属与延迟必须实际验证。

两者的压缩都不会自动清除所有原始历史。Pi 保留原 entries；DSH 保留 append-only 事件日志与图像附件，改变的是模型可见历史。长期资源增长仍需明确保留和轮换策略。

DSH 的基础压缩会复用已路由请求的 system/tools/history 前缀并追加摘要指令；Pi 也有缓存参数和保温机制。前缀设计有实际意义，但是否命中、如何计费最终取决于模型服务。当前 `qiuzk` 的缓存收益尚未测得，不给任一方案承诺节省比例。

Pi 完整 SDK 默认有自动重试、压缩和条件触发的缓存保温；压缩使用 Agent 的模型流入口，保温还会直接调用 `modelRuntime`。DSH 压缩直接调用共享 LLM service，绕过仅在普通循环上的 request hook。**统一计量应覆盖实际模型发送入口，不能只数外层 run/prompt 次数。** 二者接上配置并不意味着已通过 SciRetriever Network 验证。

### 什么证据会改变建议

最小组合使两者都能直接调用现有函数，因此不能再单凭“Pi 可内嵌”或“DSH 默认应用功能多”给出优先级。DSH 的优势候选在于循环、会话、压缩和宿主适配能按服务分工；Pi 的优势候选在于直接 SDK 接口与已有完整会话实现。哪种方式实际需要维护更少代码、能删除更多自有循环责任，要用相同任务验证。

若 DSH 发布包的依赖与版本耦合、生命周期衔接或截图处理成本明显高于 Pi，应调整验证顺序；若完整 Pi SDK 为满足本项目需要大量配置与压缩扩展，而 DSH 少量插件即可完成，则 DSH 更合适。可拆卸性不等于零适配成本，也不意味着应把整个 SciRetriever 都迁成 Cordis 插件。

真正进入验证时，先比较相同工具和模型下的几个交接：图像观察与工具结果历史、推理中接管 A 而 B 继续、后台下载失败后恢复 A、压缩与重试的实际请求归属，以及长时间运行的资源释放。随后再做同文献集合的真实下载对照。补齐现有实现的历史仍作为成本基线；本节不授权这些实验或预先规定实施步骤。

### 本轮一手资料

- DSH 最小进程内组合：[循环测试中的七服务组装](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/tests/loop.spec.ts#L31)、[内部控制 API](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/agent.ts#L163)、[模型适配扩展](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/user/develop/practice/llm-adapter.md)、[压缩最小服务测试](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/compaction/compaction-basic/tests/compaction-basic.spec.ts#L2143)、[附件抽象](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/attachment/attachment/src/index.ts#L53)、[工具结束当前 turn](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/tools/src/index.ts#L419)。
- DSH：[架构与支持的启动方式](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/architecture.md)、[SDK 客户端与限制](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/sdk/client/README.md)、[ACP 合同](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/acp/acp/README.md)、[多会话测试源码](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/acp/acp/tests/multi-session.spec.ts)。
- DSH：[最小 profile](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/bundle/sdk-minimal/README.md)、[模型适配](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm/llm-pi-ai/README.md)、[压缩机制](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/compaction/compaction-basic/README.md)、[Browser 责任](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/browser-use/browser-use/README.md)。
- Pi：[Core 接入点](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/agent/src/agent.ts)、[完整 SDK 工厂](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/core/sdk.ts)、[HTTP 请求注入合同](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/ai/src/types.ts)、[保温调用](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/core/cache-warmer.ts)、[版本变更](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/CHANGELOG.md)。

[上级提案索引](../../proposals/README.md) · [架构决策索引](../../architecture/decisions/README.md)
