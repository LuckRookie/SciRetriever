# Agents 模块技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 设计责任：[设计文档 5.2](../design.md#52-agents)
- 架构决策：[ADR 0017](../decisions/0017-shared-agents-and-controlled-browser-agent.md)、[ADR 0021](../decisions/0021-provider-model-registry-and-direct-task-selection.md)
- Analysis 消费方：[Analysis 技术文档](analysis.md)
- Browser 消费方：[Acquisition 技术文档](acquisition.md)、[Network 技术文档](network.md)

本文定义目标 `src/sciretriever/agents/` 的无状态 Provider-neutral 模型运行时。它只执行一次模型调用，不定义文献 prompt、Analysis workflow、Publisher 页面规则、Browser loop、工具执行或业务结果接纳。

## 1. 目标结构

```text
agents/
  __init__.py
  api.py
  capabilities.py
  messages.py
  tools.py
  calls.py
  runtime.py
  ports.py
  failures.py
  providers/
    __init__.py
    base.py
    openai_responses.py
    openai_chat.py
    anthropic.py
    models.py
```

- `api.py` 是消费方唯一公共入口，重导出实际需要的中性类型；
- `capabilities.py` 定义 model capability、role readiness 与缺口计算；
- `messages.py` 定义有界文本和图像输入；
- `tools.py` 定义封闭 tool declaration、tool call 与严格参数校验；
- `calls.py` 定义 `AgentCall`、structured result、usage、provenance 和单次技术 limits；
- `runtime.py` 定义 role binding、`readiness(role)` 与 `execute(call)`；
- `ports.py` 声明 Runtime 到 Provider adapter 的内部 wire port；
- `failures.py` 定义稳定、脱敏失败；
- `providers/` 转换具体 wire protocol 并通过 Network HTTP 发出请求；`models.py` 只为显式配置
  向导读取一页有界、非持久的 Provider 模型目录。

目标结构不存在 `requests.py`、`sessions.py`、通用 workflow、registry、background worker 或全局 service locator。

## 2. 公共执行合同

```python
class AgentRuntime:
    def readiness(self, role: AgentRole) -> AgentCapabilityReadiness: ...

    def execute(
        self,
        call: AgentCall,
        *,
        cancel_event: threading.Event | None = None,
    ) -> AgentStructuredResult | AgentToolCall: ...
```

`AgentCall` 包含：

- `role`；
- immutable ordered messages/text parts；
- required capability 集合；
- consumer-owned input hash；
-严格 response schema 或 tool declarations，二者互斥；
-本次 `max_output_tokens`。

`AgentCall` 不包含 Provider、Base URL、model、credential、AccessScope、session、history、turn、job deadline 或 Analysis/Browser 业务枚举。`cancel_event` 是 `execute` 的执行参数，不成为可复用 Call 状态。

`AgentRuntime` 保存 Analysis/Browser role bindings，并为每个 role 保存对应 Provider adapter；
两个 binding 解析到同一 Model Provider 时复用同一 adapter，解析到不同 Provider 时分别使用两个
adapter。每个 binding 包含 role、model、模块派生的 capabilities、Model reasoning effort 与适用单次 limits。消费者不能在
`AgentCall` 中临时覆盖 model 或 effort。Runtime 在 I/O 前完成：

1. role binding 存在性；
2. required capability 与声明 capability 匹配；
3. 图像媒体类型、数量和字节；
4. context window 与 output reservation；
5. 单次请求/schema/result limit；
6. cancel 状态。

验证通过后 Runtime 生成只在 Agents 内部使用的 Provider wire call，绑定 model、reasoning
effort、HTTP limits 和取消信号，并调用 adapter 一次。

## 3. 中性交换值

```text
AgentRole
  analysis | browser

AgentCapability
  structured_text | image_input | tool_decision

AgentTextPart
  media_type: text/plain | application/json
  text: bounded UTF-8

AgentImagePart
  media_type: image/png | image/jpeg | image/webp
  data: bounded bytes
  width / height

AgentToolDeclaration
  name
  description
  closed strict JSON schema

AgentStructuredResult
  canonical strict JSON object
  AgentProvenance

AgentToolCall
  one declared tool name
  canonical strict JSON arguments
  AgentProvenance
```

交换值必须拒绝 duplicate JSON key、NaN/Infinity、未知 schema keyword、未关闭 object schema、无界递归、超大文本/图像/结果和未声明 tool。repr 与日志不包含正文、图片或 tool arguments。

这些值只服务当前调用，不进入 `sciretriever.model`，因为它们不是文献数据库或跨运行事实。

## 4. Capability、role binding 与 readiness

model capability 至少表达：

```text
context_window_tokens
max_output_tokens
structured_output
image_input
tool_decision
supported_image_media_types
max_image_count
max_image_bytes
```

Analysis role 默认需要 `structured_text`；Browser role 默认需要 `image_input + tool_decision`。调用可以声明该次所需 capability，但不能要求 role binding 未声明的能力。

`readiness(role)` 纯本地计算并区分：

- role 是否配置；
- protocol 是否支持；
- model 是否声明；
- required capability 缺口。

它不发网络请求，不持久化 probe 结果。Analyze 与 Download 可以选择同一或不同 Model；
同一 Provider 只构造一套 credential/adapter/quota scope，不同 Provider 各自使用 exact-origin
credential 与 adapter。用户显式 `config test` 才发送固定最小 probe。

Model effort 的中性值为
`default / none / minimal / low / medium / high / xhigh / max`。`default` 在三种
adapter 中都完全省略对应参数；其它七值原样进入 OpenAI Responses 的 `reasoning.effort`、
OpenAI Chat Completions 的 `reasoning_effort` 或 Anthropic Messages 的
`output_config.effort`，并进入 provider parameters hash，不做降级或近似映射。交互配置始终提供
八个中性值；真实模型是否支持由显式 probe 证明。Runtime 不按 model 名称判断支持度，adapter 也
不能在服务拒绝后静默重试为 default。

## 5. 单次客观技术边界

Agents 保留以下单次限制：

- prompt/input/schema/request/response/result 字节；
- model context window 与本次 max output；
-图片媒体、数量和字节；
- HTTP connect/read/overall timeout；
- redirect 禁止与非幂等 POST 不自动重试；
- Network AccessScope quota/rate limit；
- cancel signal。

这些是单次调用或 Provider transport 的客观边界，不是业务作业预算。Agents 不累计多个调用的 token、输入、图片、response、result、wall-clock 或 turn，也不保存历史结果。消费模块需要下一次决定时，根据自己的当前业务状态重新构造一个独立 `AgentCall`。

## 6. Provider Port 与 adapter

内部 Provider Port 接收 Runtime 已绑定 model 的 wire call，只返回一个 structured result 或 tool call。Adapter 负责：

- 中性 parts/schema/tools 到当前协议请求的转换；
- secret 只附着到配置绑定的规范 origin；
- 通过 Network HTTP、AccessCoordinator、URL/DNS/TLS、timeout 和有界读取执行 POST；
-严格解析一个完整 structured result 或一个 tool call；
-认证、quota、timeout、refusal、truncation、model mismatch、协议错误、取消和未知响应的稳定化；
- provider/model/input/parameter hash 与安全 usage。

Adapter 不选择 role model，不理解 Literature、Analysis stage、Publisher、Browser Observation 或动作含义，不执行 tool，也不创建隐藏 SDK transport。协议无法满足 capability 时必须在请求前明确失败，不能降级成自由文本。

## 7. Analysis 消费

Analysis 为每个阶段构造一个独立 `AgentCall`，直接调用 `AgentRuntime.execute`。两阶段 controller、prompt/schema、输入 hash、NoUsableContent、Markdown/Metadata/ReferenceLookup validation 和最终业务 provenance 全部留在 Analysis。

第一阶段结果验收后才构造第二阶段 Call。ReferenceLookup 空输入不调用 Runtime。Provider 返回成功不能绕过 Analysis 对结构、source evidence、alignment 与大小的检查。

迁移完成后不存在 `AgentSession`、`open_session`、model 参数透传、Analysis 私有 Provider adapter 或新旧双路径。

## 8. Browser 消费

Acquisition 根据当前 `BrowserObservation` 构造一个 Browser role `AgentCall`，声明六种封闭工具，执行一次 Runtime 调用，再把 `AgentToolCall` 解析为 Acquisition action。Network 校验并执行动作后返回新的 Observation；循环属于 Acquisition，不属于 Agents。

Rules 模式不调用 Runtime；Agent 模式不先运行确定性点击规则。Challenge 只是 Observation 的一种 page state，不产生专属 Agent Call 类型、session 或 budget。

Agents 不取得 Browser runtime、Page、Context、Profile、Cookie、selector、CDP、任意 URL/JavaScript、capture 或 PDF 发布能力。

## 9. Configuration 与 Bootstrap

Configuration 保存 Model Provider/Model 两个直接注册表：

- Provider 拥有 name、API、Base URL 与 exact-origin credential scope；
- Model 以 `provider/model` 为唯一 reference，并拥有 reasoning 与 image；
- `[analyze].model` 与 `[download].model` 直接引用完整 Model reference；
- `[providers.<provider>]` credential 与 Provider 的规范 origin 精确绑定。

交互配置由 `Models` 管理 Provider、Model 和模型 key；`Analyze`、`Download` 只选择 Model 并管理
各自业务参数。Analyze 的 structured-output/text-only 合同由模块派生；Download 只选择
`image = true` 的 Model，其 image/tool/PNG/正数 image limits 由模块派生。任一任务切换 Model 都不
修改 Model 或另一个任务；没有 Profile、Preset、Entry 或 task-level reasoning override。

固定的单次 HTTP timeout 以及 prompt/input/schema/request/response/result 字节上限由 Agents
实现定义，并由 Bootstrap 与模块业务预算组合；它们不是普通 Model 配置字段。

不再保存 session turns、session deadline、Browser job steps、累计 token/image 或 repeated-action budget。

Bootstrap 先把当前 scope 需要的 Analyze/Download 选择解析为 Model 与 Provider，再按唯一 Provider
name 构造一或两个 adapter、一个 `AgentRuntime` 和最多两个 role bindings。Analysis 获得
同一 Runtime；只有选择 Agent Browser controller 时才加载 Download Provider credential、构造其
adapter，并向 Acquisition 提供 Browser role consumer。未选择的 controller 不进入生产对象图。

配置向导的 model discovery 是另一条显式、短生命周期读取路径，不进入生产 `AgentRuntime`：

1. Entry 在 `Models → Add` 选定 Provider 后取得其规范 origin 精确绑定 credential；新远程 Provider
   在同一流程隐藏输入 key，已有 key 直接复用，loopback 不需要 key；
2. Bootstrap 构造一套共享 Network `HttpClient`，`AgentModelCatalogClient` 对严格解析后的
   `/models` 执行一次 GET，禁止 redirect、retry 和分页跟随，响应最多 1 MiB、结果最多 100 项；
3. OpenAI-compatible 结果只形成 model ID；Anthropic-compatible 可形成可选的 display/context/
   output/image/effort hints；duplicate、错误形状、错误状态和超限响应稳定失败；
4. typed catalog 返回 Entry 后 Network 立即关闭，catalog 不进入 Configuration、Runtime、日志、
   Catalog 或其它持久状态。失败或空结果才让向导进入 Manual，不放宽 URL、credential 或 Model 校验。

`config status` 和普通业务对象图不调用该入口。model discovery 不包含 prompt、Literature、PDF、
页面或模型生成请求，也不能替代 `config test llm/browser-agent` 的真实 capability probe。

## 10. 失败、日志与数据边界

稳定失败至少区分 configuration、credentials、capability、input/context/output/request/response/result limit、timeout、quota/access、refusal、truncated、protocol/model mismatch、tool、structured response、cancelled 和 internal failure。

INFO 只记录 role、provider/model、capabilities、结果类别、usage、延迟和稳定失败。Debug 可以增加输入/图像/schema/tool 数量与 adapter 阶段，但不记录 prompt、schema 内容、模型原文/reasoning、图片、页面正文、元素文本、tool arguments、credential、header、Cookie、完整 URL 或 Profile。

Agent Call/Result、Browser turn 和失败不是 Literature 状态，不进入 Catalog、ArtifactStore、Report、Profile 或日志持久事实。Analysis 只保存其业务 provenance。

## 11. 验收

直接测试至少覆盖：

- Provider/Model 解析、同 Provider adapter 复用、不同 Provider adapter 选择，以及 Analyze/Download
  readiness 独立判断；
- structured result 与 tool call 的严格成功路径；
- 三种 Provider protocol fake 的请求、响应和失败映射；
- 八种 Model reasoning 从 Configuration 经 Bootstrap/Runtime 进入三种 wire 字段，default 省略，
  七种显式 effort 原样发送且参数 hash 随值改变；
- 显式模型目录的 GET/header/origin、可选字段、100 项/1 MiB 上限、duplicate/错误状态/错误形状、
  secret-free 失败和 Network 关闭；
- capability 缺口和错 role 在 adapter 调用计数为零时失败；
- duplicate JSON、非有限数、未知字段、超大输入/图片/响应和未声明 tool 拒绝；
- context/output/request/response/result 与 HTTP timeout 的单次限制；
- 取消、quota、跨 origin secret 拒绝和 POST 不重试；
- Analyze/Download 无 task-level model/reasoning/capability override，用户 Model 不保存模块
  context/output/structured/tool/image limit，且无 Session、history、turn、
  累计预算或公共 Provider/model 选择面；
- Analysis 两阶段真实消费；
- Browser tool decision fake 消费；
- 架构测试阻止业务模块导入 Provider adapter 或 vendor transport。

Harness、wheel 与安装后验收不访问真实 LLM、凭据、用户语料、Browser Profile 或 Publisher。fresh wheel 必须包含新的 Agents 模块且不包含已删除的 `requests.py`、`sessions.py` 或运行内容。
