# ADR 0020：可复用 Model Profile 与任务级绑定

- Status: Superseded
- Date: 2026-08-27
- Supersedes: none
- Superseded by: [ADR 0021](0021-provider-model-registry-and-direct-task-selection.md)
- Amends: [ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)、[ADR 0017](0017-shared-agents-and-controlled-browser-agent.md)
- Amended by: none
- Related: [ADR 0019](0019-agent-operable-application-and-sdk-model-runtime.md)、[产品需求](../requirements.md)、[设计文档](../design.md)、[Configuration 技术文档](../technical/configuration.md)、[Agents 技术文档](../technical/agents.md)

## 背景

Analysis 与受控 Browser 都需要模型，但“配置一个模型”和“让某项产品任务使用哪个模型”是两
个不同问题。原配置把唯一共享 connection 放在 `[agents]`，再把 model、reasoning、capability
分别放在 `agents.analysis` 与 `agents.browser` role binding 中。这种形状存在四个问题：

1. 用户必须先理解内部 `Analysis role`、`Browser role` 和共享 connection，才能完成一次普通配置；
2. model、reasoning、context/output 与 capability 被任务页面分别持有，同一完整配置不能复用；
3. 若同一个远端 model 需要一份快速配置和一份深度推理配置，只能把 reasoning 看成任务覆盖，
   无法把两种可独立验证的调用预设命名保存；
4. 全局 `Providers & API Keys` 同时混入模型服务和文献 Provider 凭据，与 Search、Download 的
   业务 owner 重叠，用户难以判断某项 key 应在哪里配置。

用户真正需要的心智模型更接近成熟工具中的 named model profile：先保存一个完整、可复用的
本地模型预设，再让任务只选择预设。这里的 Profile 不是对远端模型能力的自动发现，也不是远端
Provider 的资源；它是用户明确声明并可以单独探测的一组本地调用事实。

本 ADR 只调整模型配置所有权、配置 UX 与生产装配。它不改变 ADR 0017 的无状态单次
`AgentRuntime`，也不把 Analysis 或 Browser workflow 移入 Agents。

## 决策

### 1. `Models` 是完整模型配置的唯一 owner

普通配置建立两个命名注册表：

```toml
[models.services.openai]
provider = "openai"
protocol = "openai-responses"
base_url = "https://api.openai.com/v1"
authentication = "api-key"

[models.profiles.summary]
service = "openai"
model = "gpt-5.4"
context_window_tokens = 400000
max_output_tokens = 32768
reasoning_effort = "max"
structured_output = true
image_input = false
tool_decision = false
```

`Model Service` 拥有可由多个 Profile 复用的 transport 与凭据作用域：

- 本地 service name；
- Provider 类型；
- wire protocol；
- Base URL；
- authentication mode。

`Model Profile` 是完整、可复用且可以独立验证的本地调用预设，拥有：

- 本地 profile name 与所引用的 Service；
- 远端 model identity；
- 已核实的 context window 与最大单次 output；
- `reasoning_effort`；
- structured output、image input、tool decision capability 声明；
- image media types、单次 image count 与 image bytes 上限。

Profile 必须引用已经存在的 Service；Service 只有在没有 Profile 引用时才能删除。Profile 只有在
没有任务引用时才能删除。Configuration 不根据 Provider 名称或远端 model identity 猜测 limits、
reasoning 或 capability；显式 model catalog 读取只能提供选择提示，不能替代用户声明和最小 probe。

### 2. Reasoning 属于 Model Profile，不属于任务

`reasoning_effort` 与 model、limits 和 capabilities 一起构成一个完整 Model Profile。Analyze 与
Download 不保存 reasoning override；每次 Runtime 调用使用所选 Profile 已冻结的值。

中性值继续为：

```text
provider-default / none / minimal / low / medium / high / xhigh / max
```

`provider-default` 省略 wire reasoning 字段；其余值由适用 adapter 按协议精确编码。Profile 可以
保存协议允许的任意中性值，真实模型是否支持仍由用户显式 probe 验证，不能依据名称猜测或静默
降级。

如果同一远端 model 需要不同思考程度、limit 或 capability 声明，用户建立两个不同本地 Profile，
例如 `gpt-fast` 与 `gpt-deep`。两个 Profile 可以引用同一 Service 和同一远端 model identity，但
具有独立生命周期和 readiness；远端 model ID 相同不建立隐式联动。

第一版不提供 task-level model parameter、reasoning 或 capability override。若未来确需临时覆盖，
必须先定义可观察语义、provenance、probe/readiness、失败和 UX，不能借任意高级字段绕开 Profile。

### 3. Analyze 与 Download 只拥有 Profile 选择和业务参数

任务配置为：

```toml
[analyze]
model = "summary"

[download]
model = "browser"
browser_controller = "agent"
```

`[analyze].model` 与 `[download].model` 保存的是本地 Profile name，不是远端 model ID，也不是
Service name。

Analyze 只拥有：

- 一个 Profile 选择；
- 文献分析各阶段 output、输入、chunk、请求数和总 output 等业务预算。

Download 只拥有：

- 一个 Profile 选择；
- Browser 总开关、固定身份 Profile、`rules | agent` controller、本机并发 cap 和 policy 收紧；
- 文献 Acquisition source 与相关 Provider key 的用户配置入口。

Analyze/Download 不拥有或覆盖 Provider、protocol、Base URL、authentication、API key、远端 model、
reasoning、context/output capability 上限或 image/tool capability。切换任务的 Profile 不修改任何
Profile，也不修改另一个任务的选择。

普通 TOML 使用用户操作名称 `[analyze]` 与 `[download]`。内部 Python 类型可以继续使用
`AnalysisConfig`、`AccessConfig` 以及 `configuration.analysis`、`configuration.access`，但这些是
实现 seam，不能重新成为公开 TOML 或 Config UX 名称。

### 4. 任务选择必须在外部 I/O 前通过能力门槛

Analyze 只能选择 `structured_output = true` 的 Profile。其阶段 output 必须不超过 Profile 的
`max_output_tokens`，保守输入与 output 预留必须不超过 Profile 的 context window。

当 Download 使用 `browser_controller = "agent"` 时，所选 Profile 必须同时满足：

```text
image_input = true
tool_decision = true
"image/png" in image_media_types
image_count > 0
image_bytes > 0
```

这是 Browser Agent model readiness，不等于 Browser runtime 或全文获取 readiness。实际下载还要求
Browser 总开关、选中且安全存在的固定身份 Browser Profile、CloakBrowser/Playwright/已核实
binary、headed display、Publisher route/permit、Network guard 和逐文章 entitlement。Rules controller
不要求 Download Model readiness，也不构造 Browser Agent consumer。

### 5. 凭据按 owner 就近管理，不建立全局 Provider 页面

Model Service 的 API key 进入唯一凭据文件中的命名 section：

```toml
[models.openai]
api_key = "<secret>"
origin = "https://api.openai.com"
```

section name 精确引用本地 Model Service name；secret 与保存时的规范 origin 绑定。一个 Service
可以有零或一个当前凭据，多个 Profile 复用它。loopback `authentication = "none"` Service 不需要
key。普通配置不保存 secret，status 只报告 presence/origin match，不显示任何 secret 特征。

Config UX 不再提供职责混合的全局 `Providers & API Keys` 页面：

- `Models → Key` 管理命名 Model Service 的 key；
- `Search → Keys` 管理 Metadata Provider 凭据；
- `Download → Keys` 管理 Acquisition Provider 凭据；
- `Parse → Key` 管理 exact-origin MinerU token。

同一外部机构若同时提供 Search 与 Download 能力，两处配置仍分别表达 capability owner；底层凭据
schema 可以按 ADR 0014 的 capability-scoped 规则复用安全编辑基础，但 UX 不能让一个模糊全局页
同时拥有 service/model/source/task 配置。

### 6. Config 首页和子页按用户任务组织

一级选项保持单词级：

```text
Models
Search
Download
Parse
Analyze
Status
Theme
Quit
```

子页保持一个词表达动作或责任：

```text
Models:   Add / Edit / Service / Key / Test / Remove / Back
Search:   Sources / Keys / Test / Back
Download: Sources / Keys / Browser / Model / Profile / Runtime / Test / Back
Parse:    Service / Upload / Key / Test / Reset / Back
Analyze:  Model / Limits / Test / Back
```

模型目录只在 `Models` 中由用户显式选择 Browse 后读取；打开首页、任一页面或 Status 都不得联网。
`Test` 是用户显式动作，可能发生最小外部 I/O；模型测试按
Profile 或当前任务选择执行，不把测试结果持久化为 readiness 真相。

### 7. Bootstrap 按所选 Profile 装配 adapter 与 Runtime

Configuration 先把 `[analyze].model` 或 `[download].model` 解析为完整 Profile，再解析其 Service，
形成窄的运行时 role binding。Bootstrap 只为当前 Entry scope 实际需要的任务加载 exact-origin
Service key 和构造 adapter：

- Analyze 与 Download 选择同一 Service 时复用同一个 adapter；
- 选择不同 Service 时可以构造两个 adapter，并在同一个无状态 `AgentRuntime` 中分别绑定到
  Analysis 与 Browser role；
- 未选择 Agent Browser controller 时不加载 Download model credential、不构造 Browser adapter 或
  Browser role consumer；
- 每个 role 的 model、reasoning、capability 和单次 limits 来自所选 Profile，业务调用不能透传
  覆盖。

`AgentRuntime` 仍只执行一次 provider-neutral call。Analysis 继续拥有两阶段文献 workflow、schema
和结果验收；Acquisition 继续拥有 Browser loop、动作和语义进展；Network 继续拥有 Browser
Observation/action 执行与外部访问安全。Provider SDK、PydanticAI、vendor 类型或 transport 细节
只能存在于 Agents 私有 adapter 边界，不能进入这些业务模块或 Model 公共合同。

### 8. 当前 schema 是唯一合同，旧 singleton schema 直接拒绝

旧普通配置：

```text
[agents]
[agents.analysis]
[agents.browser]
[analysis]
[access]
```

旧普通 section 不再进入生产解析或 Bootstrap 路径，也不提供字段映射、双 schema reader、
Models 迁移动作或配置中心恢复入口。裸 `sciretriever config` 在打开首页前严格读取当前普通
配置与凭据；以下内容/schema 错误均直接拒绝：

```text
configuration input is malformed
configuration section is unknown
configuration key is unknown
configuration value is invalid
```

CLI 返回配置错误退出码 4，并只显示稳定、无配置值的原因；它不显示菜单或恢复提示，也不写入
任何文件。文件过大、符号链接、非普通文件、不安全所有权/权限、目录不安全或读取竞争同样严格
拒绝，不能被空配置或配置中心动作绕过。配置文件缺失仍表示尚未写入的空当前配置，允许进入配置
中心，并在第一次确认修改时通过正常原子发布创建。

旧 credentials `[agents]` 与未知凭据 section 一样直接拒绝，不会自动成为命名 Model Service
key。operator 必须在配置中心之外手工编辑或替换精确的 `config.toml` /
`credentials.toml`，删除旧 section 后再通过 `Models → Service/Add/Key` 配置当前
Service、Profile 与 key。SciRetriever 不迁移、恢复、转换、备份、自动删除或回退旧配置；
正常当前配置的保存仍使用 owner-only staging、并发检查、原子替换与 `fsync`。

## 后果

- 用户先配置可复用 Model，再让 Analyze/Download 选择，配置所有权与界面心智模型一致；
- reasoning、limits 与 capability 和 model 一起被命名、复用、探测和审计，不再散落为任务覆盖；
- Analyze 与 Download 可以独立选择不同 Provider/Service，也可以安全复用同一 adapter 与凭据；
- 文献 Search/Download key、MinerU token 与模型 key 回到各自 owner，消除全局页面的职责重叠；
- Profile 明确声明能力仍依赖用户和 probe 的正确性；当前不引入远端 capability catalog 或自动推断；
- 公开 TOML 发生一次不兼容切换；旧普通设置与旧 `[agents]` 凭据不会被猜测转换，用户必须在
  配置中心之外手工修复后按当前入口重新配置；
- 内部 `AgentRole`、`AnalysisConfig`、`AccessConfig` 等窄 seam 可以保留，不代表公开配置仍以 role
  为中心。

## 不采用的方案

- 在 Analyze/Download 页面重复配置 Provider、Base URL、model、reasoning 或 capability；
- 让一个全局 `Providers & API Keys` 页面同时拥有模型与文献来源设置；
- 把 reasoning 当作每次任务的临时 override，或让任务值覆盖 Profile；
- 依据模型名称自动猜测 context、output、reasoning 或 image/tool capability；
- 强制 Analyze 与 Download 共用一个 Service、凭据或远端 model；
- 为每个任务复制相同 Service 和 key；
- 自动或显式映射迁移旧配置，或长期同时支持新旧普通生产 schema；
- 在配置中心提供 Reset、恢复或 fallback 入口；
- 因配置层引入 LangGraph/PydanticAI workflow、通用 Agent session、memory 或任意 prompt API。

## 需要新 ADR 的变化

- 增加 task-level model/reasoning/capability override；
- 让远端 catalog 自动写入或覆盖 Profile capability/limit；
- 支持多账户、远程 secret manager、OS keyring 或 Profile 级独立凭据；
- 允许业务模块直接选择 Service、调用 Provider SDK 或持有 vendor 类型；
- 把 Model Profile 变成持久 Agent workflow、memory、tool registry 或运行状态；
- 改变 ADR 0017 的无状态单次 Runtime、Analysis/Acquisition workflow owner 或 Browser 安全边界。
