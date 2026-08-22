# Agents 模块技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 设计责任：[设计文档 5.2](../design.md#52-agents)
- 架构决策：[ADR 0017](../decisions/0017-shared-agents-and-controlled-browser-agent.md)
- Analysis 消费方：[Analysis 技术文档](analysis.md)
- Browser 消费方：[Acquisition 技术文档](acquisition.md)、[Network 技术文档](network.md)

本文定义目标 `src/sciretriever/agents/` 的中性模型 provider、capability、预算、请求级 session、协议 adapter 和稳定失败边界。它不定义文献 prompt、Analysis schema、Publisher 页面规则、Browser 动作含义或业务结果接纳。

## 1. 目标结构

```text
agents/
  __init__.py
  api.py
  ports.py
  requests.py
  capabilities.py
  sessions.py
  failures.py
  providers/
    __init__.py
    openai_responses.py
    openai_chat.py
    anthropic.py
```

- `api.py` 提供窄小、稳定的请求与 session 构造面；
- `ports.py` 声明 provider-neutral 执行 Port，不包含文献或 Browser 业务枚举；
- `requests.py` 定义有界文本、图像、结构化响应和 tool declaration/decision；
- `capabilities.py` 定义模型能力与本地 readiness；
- `sessions.py` 管理 request-local 多 turn 上下文、预算、取消和释放；
- `failures.py` 将配置、capability、认证、quota、timeout、协议、预算和取消稳定化；
- `providers/` 只负责具体模型协议、认证和响应边界转换，并通过 Network 发出请求。

`__init__.py` 只导出消费方实际需要的稳定调用面和失败，不导出具体 provider adapter、vendor 类型或可变全局 registry。模块不建立 service locator、singleton、background worker 或通用 workflow engine。

## 2. 中性交换值

Agents 边界使用不可变、封闭的内部交换值，至少表达：

```text
AgentRole
  analysis | browser

AgentCapability
  structured_text
  image_input
  tool_decision

AgentTextPart
  media_type: text/plain | application/json
  text: bounded str

AgentImagePart
  media_type: image/png | image/jpeg | image/webp
  bytes: bounded bytes
  width/height: positive int

AgentToolDeclaration
  name: bounded stable name
  input_schema: strict JSON schema subset

AgentToolDecision
  tool_name: declared name
  arguments: duplicate-free finite JSON value

AgentStructuredResult
  value: duplicate-free finite JSON value
  provider/model identity
  usage/provenance summary
```

真实命名可以在实现时收敛，但必须保持以下约束：

- 拒绝未知字段、重复 JSON key、NaN/Infinity、无界递归和超预算字符串/数组；
- 图像在进入 provider 前已经有媒体类型、尺寸、字节和数量硬上限；
- tool decision 只能选择本次声明的工具，不能携带 callable、URL client、Page 或 vendor object；
- vendor SDK response、HTTP response、Cookie、Browser screenshot path、Literature、Publisher 和 Analysis request kind 不越过 Agents 边界；
- 输入 hash、role、provider/model identity 和安全 usage 可以返回给消费方形成自己的 provenance，但 prompt、原始响应和 reasoning 不进入公共结果。

这些值属于当前调用，不进入 `sciretriever.model`，因为它们不是文献数据库、跨业务模块事实或公开持久合同。

## 3. Provider Port 与 capability

provider-neutral Port 对每次请求显式接收：

- role 与所需 capability 集合；
- 模型选择；
- 有界输入 parts；
- 可选严格响应 schema 或 tool declarations，二者不能无合同混用；
- deadline、最大输出 token、最大响应字节和取消信号；
- 当前请求级 session state。

模型 capability 至少保存：

```text
context_window
max_output_tokens
structured_output
image_input
tool_decision
supported_image_media_types
max_image_count / max_image_bytes
```

readiness 分为：

1. 配置字段完整；
2. 当前协议 adapter 支持所需 capability；
3. 选定模型由配置明确声明相应能力和预算；
4. 用户显式执行的真实 probe 结果。

前三级可以纯本地计算；第四级不持久化。`analysis-ready` 只要求当前 Analysis 请求的 structured-text 合同，`browser-agent-ready` 还要求 image input 与 tool decision，二者不能互相推断。capability 不满足时在任何外部 I/O 前稳定失败，不能偷降级为自由文本或丢弃图片。

## 4. 请求级 session 与预算

单次 structured request 可以使用无状态 convenience API；Browser 多 turn 通过 request-local session 复用已选 provider/model、角色、预算和有限历史。Session 必须：

- 只属于一项 Analysis 逻辑调用或当前一篇 Browser 文章；
- 由消费方显式 close，取消和异常也进入相同清理；
- 对 turn 数、累计输入/输出 token、图像、响应字节和 wall-clock 设置硬预算；
- 每 turn 重新检查 deadline、capability 和剩余预算；
- 关闭后拒绝继续调用并释放图像、tool output、模型响应和临时序列化字节；
- 不跨文章、Publisher、Entry 操作、命令或进程恢复；
- 不写入 Catalog、ArtifactStore、Profile、普通配置、credentials、Report 或日志。

Provider adapter 不自行扩大预算或自动进行未声明的重试。POST 模型请求只有在当前协议明确提供幂等语义并由调用方提供稳定 idempotency key 时才可重试；否则 transport 不确定性返回稳定失败。Quota 和 rate-limit 反馈进入相同 provider/account/API product 的进程内 AccessScope，Analysis 与 Browser 不能各自建立额度池。

## 5. Provider adapter

目标 adapter 支持当前已经实现的三类协议：

- OpenAI Responses；
- OpenAI Chat Completions；
- Anthropic Messages。

每个 adapter 负责：

- 把中性 parts、schema 和 tool declarations 转换为当前协议请求；
- 只向配置绑定的规范 origin 附着 secret，跨 origin redirect 不转发；
- 在序列化后复检 context、输出预留、图像和响应大小；
- 将协议结构化输出或 tool decision 严格转换为中性值；
- 将认证、quota、timeout、拒绝、截断、未知响应和取消转换为稳定失败；
- 返回安全 provider/model/usage 身份，不返回 SDK object、header 或原始响应。

协议不支持请求 capability 时必须明确拒绝。Adapter 通过 Network 的安全 HTTP、URL/DNS/TLS、redirect、AccessCoordinator、timeout、有界读取和脱敏边界访问外部服务；不得由 vendor SDK 创建绕过 Network 的隐藏 transport。

## 6. Configuration 与 Bootstrap

普通配置保留一个 Agent provider 边界，并为 `analysis` 与 `browser` 两个角色选择模型和预算。相同 endpoint/credential 可以复用，不满足 Browser capability 时可以为 browser 角色显式选择另一模型，但不能复制 secret 或创建第二套 provider 配置语义。

普通配置至少包含：

- protocol；
- HTTPS Base URL 或允许的 loopback HTTP origin；
- analysis/browser role model；
- 模型声明的 context/output/capability；
- 每角色 token、响应、图像、turn 和 deadline 上限。

Secret 只存在于固定 owner-only `credentials.toml`，与规范 service origin 绑定，不读取 Agent 环境变量。`config status` 只展示本地配置和 capability 缺口，不调用模型；`config test` 由用户分别选择 Analysis/Browser role，发送固定极小、无用户文献的 probe，并说明可能消耗额度。

Bootstrap 每个生产对象图只构造一个 Agents provider runtime 和一个共享 Network quota scope，再把 structured-text capability 注入 Analysis、把 image/tool capability 注入已准入的 Browser Agent controller。关闭顺序先停止消费 session，再关闭 provider response/transport；没有 Browser role 配置时不得影响 Analysis 或确定性 Browser。

## 7. 消费方边界

### 7.1 Analysis

Analysis 构造文献 prompt、阶段 schema、输入 hash 和结果验收，通过 Agents structured-text capability 发起请求。Analysis 私有的 metadata/content/reference request kind 不进入 Agents；Agents 的“请求成功”不能替代 NoUsableContent、LiteratureMetadata、Markdown 或 ReferenceLookup 检查。Analysis 形成并拥有最终业务 provenance。

### 7.2 Browser Acquisition

Acquisition 构造“取得当前文章主 PDF”的目标、允许动作和安全页面摘要。Network 生成有界 observation；Agents 只返回一个封闭 tool decision；Acquisition/Network 在同一文章 flow 中解释并执行。Agent 不取得 Browser runtime 或捕获/发布能力，成功仍只能由 Network 交付 `TemporaryPdf` 后进入 Acquisition 的统一验收。

确定性初始 capture、通用 locator 和 Publisher 静态规则先执行。只有页面非终态、正常未命中、Browser role capability ready 且剩余预算充足时才创建 Agent session；challenge/login/MFA、timeout、quota、runtime failure 和已有 capture 都不进入 Agent fallback。

## 8. 日志、失败和数据边界

INFO 只记录 role、provider/model identity、所需 capability、成功/失败、usage 类别、延迟和下一动作类别。Debug 可以增加 turn、阶段、输入/输出/图像安全大小、剩余预算和 adapter 状态，但不记录：

- prompt、schema 内容或模型原文；
- screenshot、页面文本、元素名称或 tool arguments；
- reasoning、隐藏状态或 vendor request/response；
- API key、header、Cookie、完整 URL 或 Profile；
- Literature 正文和用户语料。

稳定失败至少区分配置、认证、capability、输入预算、输出预算、协议、timeout、quota、provider service、取消和 cleanup。Filter 只作最终防线；provider adapter 必须在错误离开 Agents 边界前完成稳定化和脱敏。

## 9. 验收

直接测试至少覆盖：

- 三类协议的 structured-text fake Network 成功与错误转换；
- 支持的 image/tool 请求和不支持 capability 的 I/O 前拒绝；
- duplicate JSON key、非有限数、未知字段、超大文本/图像/响应和未声明工具拒绝；
- context/output 预算、deadline、取消、quota、不可证明幂等的 POST 不重试；
- request-local session 多 turn、累计预算、关闭后拒绝和资源释放；
- analysis-ready 与 browser-agent-ready 独立判断；
- 相同 provider/account scope 下 Analysis 与 Browser 共享准入；
- 跨 origin 不转发 secret，日志/失败不泄露 prompt、响应、截图或凭据；
- 架构测试阻止 Analysis/Acquisition 直接导入 Agents provider adapter 或 vendor SDK；
- fake runtime 可以驱动单 turn structured result 和多 turn tool decision，不连接真实模型。

Harness、CI、wheel 与安装后验收不读取真实凭据、用户语料、Browser Profile 或外部 LLM。fresh wheel 必须包含 `agents` 的全部 Python 模块而不包含运行内容、截图、模型缓存或 secret。
