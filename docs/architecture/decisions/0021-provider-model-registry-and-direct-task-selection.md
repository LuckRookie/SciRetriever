# ADR 0021：Provider、Model 注册表与任务直接选择

- Status: Accepted
- Date: 2026-08-28
- Supersedes: [ADR 0020](0020-reusable-model-profiles-and-task-bindings.md)
- Superseded by: none
- Amends: [ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)、[ADR 0017](0017-shared-agents-and-controlled-browser-agent.md)、[ADR 0018](0018-fixed-user-configuration-home.md)
- Amended by: none
- Related: [ADR 0019](0019-agent-operable-application-and-sdk-model-runtime.md)、[产品需求](../requirements.md)、[设计文档](../design.md)、[Configuration 技术文档](../technical/configuration.md)、[Agents 技术文档](../technical/agents.md)

## 背景

Analysis 与受控 Browser 需要共享模型连接、凭据和协议 adapter，但用户配置模型时不需要理解
SciRetriever 内部的 role binding、调用预算或完整 capability 对象。ADR 0020 曾把配置分成命名
Model Service 与可复用 Model Profile，并要求 Profile 保存 context/output、structured output、图片
格式/数量/大小和 tool decision 等字段。实际配置流程证明这种形状把三类不同事实混在了一起：

1. endpoint、wire API 与凭据作用域是 Provider 连接事实；
2. 远端 model identity、用户选择的思考程度和是否允许图片输入是 Model 事实；
3. 严格结构化输出、工具集合、图片格式/数量、输入输出预算和验收规则是 Analyze 或 Download 的
   调用合同。

把第三类事实要求用户逐项声明，会让用户面对难以核实且通常不应修改的技术参数，还会让同一
模块合同在配置、Bootstrap 和消费者中出现多个 owner。Profile alias 也没有提供当前产品需要的
独立语义：Analyze 与 Download 最终只需要选择一个确定模型，而不是选择一套可叠加 preset。

用户需要的心智模型是：先配置 Provider，再在该 Provider 下配置 Model，最后让 Analyze 或
Download 选择 Model。Provider 和 Model 是可复用注册表；模块拥有如何安全调用所选 Model。

本 ADR 只调整模型配置、配置 UX、readiness 与生产组装。它不改变 ADR 0017 的无状态单次
`AgentRuntime`，不把 Analysis 或 Browser workflow 移入 Agents，也不改变 ADR 0019 的外部
Agent 可编排边界和 SDK 优先方向。

## 决策

### 1. Provider 只拥有连接与凭据作用域

普通配置中的 Provider 注册表为：

```toml
[providers.example]
api = "openai-responses"
base_url = "https://models.example.com/v1"
```

每个 Provider 只拥有：

- 本地唯一 `name`，即 TOML table key；
- `api`，当前为 `openai-responses`、`openai-chat-completions` 或
  `anthropic-messages`；
- `base_url`。

Provider 不保存远端 model、reasoning、图片能力或任务预算。authentication 不成为用户字段：安全
URL 规则直接决定凭据要求。hostname-based HTTPS Provider 必须使用与规范 origin 精确绑定的
API key；HTTP 只允许 loopback 且不读取或发送 key。远程 HTTP、远程 IP、loopback HTTPS 和其它
不安全 endpoint 继续 fail closed。

模型凭据只进入固定 owner-only 凭据文件：

```toml
[providers.example]
api_key = "<secret>"
origin = "https://models.example.com"
```

普通配置与凭据使用同一 Provider name，但文件、schema 和发布事务仍然分离。status 只显示 key
是否 required/configured/origin-matched，不显示 secret、mask、长度、hash 或其它特征。

### 2. Model 只拥有身份、思考程度和图片输入选择

Model 注册表直接以完整 `provider/model` 为唯一身份：

```toml
[models."example/gpt-5.6-luna"]
reasoning = "max"
image = true
```

每个 Model 只拥有：

- `reference = provider/model`；
- `reasoning`；
- `image`。

`reference` 必须引用已经存在的 Provider。相同 `provider/model` 只有一个当前配置，不再增加本地
Profile、Preset、Entry 或 alias。修改 reasoning/image 就是修改该 Model；删除仍被 Analyze 或
Download 选择的 Model 必须失败，删除仍有 Model 引用的 Provider 也必须失败。

reasoning 的中性值固定为：

```text
default / none / minimal / low / medium / high / xhigh / max
```

`default` 表示 wire adapter 完全省略 reasoning effort 字段；其它值按适用协议精确编码。配置和
adapter 不根据 Provider 或 model 名称静默降级、映射或猜测支持程度；真实支持情况由显式 Model
probe 验证。`image` 只表示该 Model 可被需要图片输入的模块选择，不承载 MIME、数量或字节上限。

### 3. Analyze 与 Browser 直接选择 Model

任务配置保存完整 Model reference：

```toml
[analyze]
model = "example/gpt-5.6-luna"

[download]
model = "example/gpt-5.6-luna"
```

Analyze 只拥有 Model 选择和文献分析的阶段 output、输入、chunk、请求数与总 output 等业务预算。
Browser 只拥有 controller Model 选择以及 Browser 开关、Rules/Agent controller、固定 Browser
identity、本机并发 cap 和 policy 收紧。普通配置出于 Acquisition 运行合同仍把这些字段持久化在
`[download]`，但配置 UX 和用户责任名称统一称为 Browser；Download 一级页只管理 PDF Source。
二者不保存 Provider、API、Base URL、key 或 reasoning override，切换一个任务的 Model 不修改 Model，
也不修改另一个任务。

Analyze 可以选择任意已配置 Model；其严格结构化文本合同由 Analysis 与 Bootstrap 派生并通过
显式 probe 验证。Browser 只列出 `image = true` 的 Model；关闭当前 Browser Model 的 image 会使
普通配置无效并被拒绝。Rules controller 不构造 Browser Agent consumer，也不发起模型调用。

### 4. 模块拥有调用 capability 与安全预算

以下字段不进入用户 Model 配置：

- context window 与单次最大 output；
- structured output 与 tool decision；
- image media types、image count 与 image bytes；
- Provider 目录返回的可选 capability metadata。

Analyze 调用固定派生为 strict structured output、文本输入、无工具；各阶段 output 和总调用预算
来自 `AnalysisConfig`，单次 runtime 边界由 Bootstrap 保守形成。Download Agent 固定派生为一张
有界 PNG 图片、一个封闭工具集合、必须返回 tool decision；图片格式、数量、字节、单次 output
与操作级步数/时间/重复动作限制分别由 Agents、Acquisition 和 Network 的所属合同管理。

用户声明的 Model 不能放宽这些合同。adapter 或远端模型不满足时，显式 `config test llm` 或
`config test browser-agent` 返回稳定失败；系统不能通过向配置暴露更多 capability 开关绕过失败。

### 5. 新增 Model 时自动读取模型目录

`Models → Add` 使用一个连续流程：

```text
Provider → URL → API → Key → Model → Reasoning → Image → Save
```

用户可以选择已有 Provider 或 `New`。内置 Provider 选择只提供已知 URL/API 初值，不增加另一套
持久 preset。新远程 Provider 在同一流程隐藏输入 key；已有 Provider 若已保存 exact-origin key，
直接复用。loopback Provider 不询问 key。

key 就绪后，配置流程自动通过一次有界、只读、无重试的 `/models` 请求获取 Model ID 列表。该
observation 不持久化，不形成运行时 registry，也不成为 capability 真相。只有目录请求失败、响应
无可用 Model 或安全解析失败时才回退到 `Manual`；用户取消时不保存 Provider、Model 或 key 的
部分状态。首页、普通配置页面、`config status` 和业务命令不得隐式读取模型目录。

### 6. 配置 UX 按稳定对象和任务分层

一级选项保持单词级：

```text
Models / Search / Download / Parse / Analyze / Browser / Status / Theme / Quit
```

Model、Provider 与各 owner 的对象操作保持单词级：

```text
Models:    Add / <Model> / Providers / Back
Model:     Edit / Remove / Back
Providers: Add / <Provider> / Back
Provider:  Edit / Key / Test / Remove / Back

Search:    Sources / Limit / Back
Download:  Sources / Back
Parse:     Setup / Test / Reset / Back
Analyze:   Setup / Test / Reset / Back
Browser:   Setup / Profiles / Runtime / Test / Reset / Back
```

选中具体 Model 后，`Edit` 只编辑 reasoning 与 image；Provider endpoint/API/key 进入具体 Provider
对象页。Search 与 Download 选中具体 Source 后，就近显示它实际支持的 `Setup`、`Key`、`Test`、
`Enable` 或 `Disable`；Sci-Hub 的 `Mirrors` 只属于 Sci-Hub Source。Parse、Analyze 与 Browser 的
`Setup` 分别连续完成本 owner 的必要选择。文献 Provider、MinerU 与模型 Provider 凭据不能混成
全局 key 页面；Browser 的 Model 选择也不能重新配置 Provider 或 Model。

### 7. Bootstrap 按 Provider 共享 adapter，按模块派生 binding

Bootstrap 将任务选择解析为 `Model → Provider`，按 Provider name 构造并共享 exact-origin
credential、wire adapter 与 quota scope，再为当前 scope 形成 Analysis 或 Browser binding。binding
携带远端 model、Model reasoning 以及模块派生的 capability/limits；消费者不能覆盖连接、model、
reasoning 或 credential。

同一 Provider 下的 Analyze/Download Model 复用 adapter；不同 Provider 分别构造。只有当前 Entry
scope 实际需要的 binding 才装配，缺少 Provider、key、Model、image 能力或业务预算在外部 I/O 前
形成稳定 readiness 失败。

### 8. 不提供旧 schema 兼容层

这是当前未发布配置合同的一次明确替换，不保留 Service/Profile/Preset/Entry 的解析、映射、双写、
弃用 warning 或自动迁移。以下旧普通配置形状均严格拒绝：

```text
[agents]
[models.services.*]
[models.profiles.*]
[models.entries.*]
```

旧模型凭据 `[models.*]` 也严格拒绝。operator 需要人工删除旧 section，再通过当前 `config` 重新
配置；程序不得读取、覆盖或删除旧文件中的真实 secret。失败发生在打开交互菜单或执行外部 I/O
之前，并保持原文件字节不变。

## 后果

### 正面

- 用户只配置确实知道且需要选择的 Provider、Model、reasoning 和 image，首次配置不再被内部技术
  预算阻塞；
- Provider、Model 与模块调用合同各有唯一 owner，Analyze/Download 不再与 Profile capability
  重复声明；
- API key 在创建远程 Provider/Model 的同一流程完成，同时仍保持普通配置与 secret 分离；
- `/models` 自动读取减少手工输入，失败路径仍然明确、可取消且可离线测试；
- SDK、PydanticAI 或当前自有 adapter 可以在 Agents 内部替换，不改变用户配置心智模型。

### 代价与限制

- 旧 Service/Profile 配置不能直接使用，必须人工重新配置；
- 同一 `provider/model` 不能同时保存两套 reasoning；需要改变时编辑该 Model，或使用不同远端
  model identity；
- `image = true` 是 operator 的选择，不是远端能力证明；真实 strict output、图片与 tool 支持仍需
  显式 probe；
- 模块固定合同可能拒绝某些只能通过特殊 vendor 参数工作的模型；当前不为这种未证明需求扩大
  公共配置，出现真实消费者后再新增 ADR。

## 被否决的方案

### 保留 Service/Profile，只在 TUI 中隐藏高级字段

否决。隐藏字段仍需要默认值和第二套所有权，配置文件、status、Bootstrap 与测试继续把模块合同
误写成 Profile 事实，复杂度没有消失。

### 把 Provider、Model、任务和 key 合成一个配置对象

否决。多个 Model 不能安全复用 endpoint/key，Analyze 与 Download 也会重新拥有连接事实；凭据
轮换或 endpoint 变化会扩散到任务配置。

### 完全依据 `/models` 自动推断 capability 和 reasoning

否决。兼容 API 的目录 schema 通常只可靠提供 Model ID；缺失字段不是“不支持”，Provider 声明
也不能替代 SciRetriever 的实际 strict output/image/tool probe。

### 让 Analyze/Download 保存 reasoning override

否决。reasoning 是 Model 的当前调用选择。任务 override 会让同一 Model 的实际行为取决于第二处
隐藏参数，重新制造用户刚刚移除的层级。

## 验证要求

- Configuration round-trip 必须证明 Provider 与 Model 注册表、完整 reference、八种 reasoning、
  image 门槛和旧 schema 严格拒绝；
- credential 测试必须证明 Provider name + exact origin 绑定、同流程原子更新、endpoint 变更恢复和
  secret 不出现在普通配置/status/log；
- CLI/TUI 测试必须证明单词级菜单、同流程隐藏 key、自动 `/models`、失败后 Manual、取消无部分
  写入、Analyze/Download 直接选择以及 Download 过滤 text-only Model；
- Bootstrap/Agents probe 必须证明 Analyze 的 strict structured output 合同与 Download 的
  image/tool 合同由模块派生，`default` 省略 wire 字段，显式 reasoning 不静默降级；
- Harness 与安装后验收必须使用 fake/fixture，不读取用户配置、真实凭据或真实 Provider。
