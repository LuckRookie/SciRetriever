# ADR 0017：无状态共享 Agents 与受控 Browser Controller

- Status: Accepted
- Date: 2026-08-21
- Last amended: 2026-08-28
- Supersedes: none
- Amends: [ADR 0008](0008-summarized-markdown-literature-content.md)、[ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)、[ADR 0015](0015-publisher-aware-tiered-pdf-acquisition.md)、[ADR 0016](0016-cloakbrowser-fixed-identity-runtime.md)
- Amended by: [ADR 0019](0019-agent-operable-application-and-sdk-model-runtime.md)、[ADR 0021](0021-provider-model-registry-and-direct-task-selection.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[Analysis 技术文档](../technical/analysis.md)、[Agents 技术文档](../technical/agents.md)、[Acquisition 技术文档](../technical/acquisition.md)、[Network 技术文档](../technical/network.md)

## 背景

Analysis 与受控 Browser 是两个需要模型能力的真实消费者，但二者的业务目标完全不同。Analysis 需要严格结构化文本并自己组织两阶段文献分析；Browser 需要图像和 tool decision，并自己组织页面观察、动作与下载终态。复制 Provider、凭据、quota、协议和稳定失败会形成两套基础设施；把 Analysis 或 Browser workflow 放进通用 Agents 又会让项目失去清晰的业务 owner。

现有实现已经证明共享 Provider adapter 可行，但同时暴露了不必要的复杂度：通用 `AgentSession` 保存 history、turn 和累计预算；Analysis 为单次调用创建 `max_turns=1` session；Browser 又把 session 与 step、总时长、token、图像和重复动作次数组合成作业状态。Challenge 还被建模为专属 Observation、target、动作和交互生命周期。它们把模型协议、业务 workflow 和 Browser runtime 混在了一起。

本 ADR 将 Agents 收敛为无状态窄腰，并明确受控 Browser 的两个 controller 是作业开始前的互斥选择，而不是一条“规则失败后调用 Agent”的 fallback 链。

## 决策

### 1. `agents` 是无状态、Provider-neutral 的单次模型运行时

`agents` 只拥有：

- 中性 role、message、图像、严格 response schema 和 tool declaration；
- model capability、role readiness、role-to-model binding 和角色默认 reasoning effort；
- 一次 Provider 调用、严格结果、usage、输入/参数 hash 和稳定失败；
- OpenAI Responses、OpenAI Chat Completions 与 Anthropic Messages 的 wire protocol adapter；
- 单次 context/output/request/response/result 大小、HTTP timeout、取消和 quota 准入。

公共执行合同为：

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

消费者提交 role、messages、required capabilities、严格 response schema 或 tools，以及本次 `max_output_tokens`。消费者不选择 Provider、Base URL、model 或 reasoning effort；Runtime 根据 Bootstrap 已冻结的 role binding 选择 model 与角色默认 effort，并在外部 I/O 前验证 capability。中性配置值为 `default`、`none`、`minimal`、`low`、`medium`、`high`、`xhigh` 与 `max`。`default` 不向 wire request 增加 effort 参数；其它值由具体协议 adapter 原样编码并进入参数 hash，不能降级、近似映射或在失败后静默重试为 default。配置向导对三种 API 提供同一完整集合；模型是否实际支持所选值仍由显式 probe 验证，不能根据模型名称猜测。

`agents` 不拥有业务 workflow、工具执行、Browser loop、Analysis 阶段顺序、长期 memory、Planner、Tool Registry、后台任务、事实写入或持久化运行记录。它不提供 `AgentSession`、`open_session`、session history、turn 计数或跨调用累计预算。

### 2. 完整 Agent 由共享 Runtime 与消费模块控制器组成

责任固定为：

| Owner | 责任 |
| --- | --- |
| `agents` | 单次模型执行、capability/readiness、role binding、Provider protocol、稳定失败与安全 usage |
| `analysis` | 文献 prompt、两阶段顺序、schema、NoUsableContent、Markdown/ReferenceLookup 验收和最终业务 provenance |
| `acquisition` | “取得当前文章主 PDF”的目标、Browser controller、允许动作、语义进展和 route outcome |
| `network` | CloakBrowser runtime、Browser snapshot/revision、动作执行、Network guard、capture 和 cleanup |
| `configuration` | Model Provider/Model 注册表、Analyze/Download 选择、controller、credential 和本地 readiness |
| `bootstrap` | 按所选 Model Provider 共享构造 adapter/runtime、派生 role bindings 和作业选择的一个 Browser controller |

因此：

```text
Analysis Agent
  = AgentRuntime
  + Analysis 两阶段控制器
  + Analysis schema/validator

Browser Agent
  = AgentRuntime
  + Acquisition Browser Agent controller
  + Network Browser action executor
```

### 3. Analysis 直接执行独立的单次调用

Analysis 直接调用两次 `AgentRuntime.execute`，自己决定第二阶段是否运行。Metadata stage 与 ReferenceLookup 同样发起独立的单次调用。Provider 成功不能替代 Analysis 的结构、来源、对齐和业务验收。

迁移完成后删除 `AgentSession`、`open_session`、旧 Analysis Provider wrapper、model 透传和双路径测试，不保留“新 Runtime 失败后回到旧 adapter”的兼容层。已经保存的 Literature、Content 和 provenance schema 不迁移。

### 4. Controlled Browser 在作业开始前选择一个 controller

普通配置提供：

```toml
[download]
browser_controller = "rules" # 或 "agent"
```

一项下载作业开始时冻结选择：

- `rules`：只运行 `RuleBrowserController`，不调用模型；
- `agent`：只运行 `AgentBrowserController`，不先执行确定性点击规则；
- 两种模式不是先后顺序，也不因 miss、timeout、challenge 或其它失败相互切换。

`RuleBrowserController` 可以使用初始 capture、通用 PDF locator 和 Publisher 确定性页面动作。`AgentBrowserController` 从首次统一 Observation 起请求模型决定。response/download/popup/viewer capture、Network guard、Publisher permit、PDF 验收与 cleanup 是二者共享的 Browser runtime 基础，不属于 Rules 点击策略。

Public → Authorized Provider API → Controlled Browser 的三级 Acquisition 顺序保持不变。Browser controller 选择只发生在第三层已经准入的目标中。

### 5. 两种 controller 共用 Publisher 知识

Publisher access profile 继续拥有并同时服务两种 controller：

- route 与 canonical landing；
- allowed origins、challenge dependency 和 navigation/capture guard；
- browser risk/rate group、文章间隔、cooldown 和 circuit policy；
- page-state marker；
-主 PDF 与 supplementary discrimination；
- popup/viewer admission 和 capture validation。

只有确定性点击序列属于 Rules 模式。Agent 模式不能绕过 Publisher profile，也不能给未知站点获得 arbitrary-site Browser。

### 6. Browser 只有一种 Observation，Challenge 只是页面状态

Network 为当前文章生成一个 `BrowserObservation`，包含：

- article/page identity 与单调 revision；
- page、popup、frame、Shadow/viewer surface tree；
- 去除 query 的 origin/path、title、viewport、scroll 和 surface bounds；
- `page_state`；
- 当前 viewport screenshot；
- 可见 actionable elements 的短期 element ID、surface、role/name/state 和 bounding box；
- `capture_state`；
- 上一动作的脱敏 receipt。

三个状态维度正交：

```text
page_state:
  NORMAL | CHALLENGE | LOGIN_REQUIRED | MFA_REQUIRED |
  NOT_ENTITLED | ACCESS_DENIED | NOT_FOUND | FAILED

agent_status:
  RUNNING | STOPPED | FAILED

capture_state:
  NONE | CANDIDATE | CAPTURED
```

Challenge 不再拥有 `BrowserChallengeObservation`、interaction-target ID、专属 controller、专属 retry/turn budget 或 interaction-required/active/exhausted 状态族。它只是 `page_state=CHALLENGE` 的网页，由 Agent 使用与其它页面相同的观察和动作处理。

### 7. 第一版 Browser 动作是六种封闭通用动作

```text
ClickElement
ClickPoint
ScrollSurface
GoBack
WaitForChange
Stop
```

`ClickElement` 优先操作当前 revision 的可定位 DOM 元素。`ClickPoint` 处理 closed Shadow DOM、canvas、图片控件或 Challenge 等只能通过当前截图定位的可见目标；它必须绑定当前 article、page、surface、viewport、screenshot 和 revision，并在 vendor 动作前验证坐标边界。

`GoBack` 不接受任意 URL；`WaitForChange` 只使用 Network 的单次 action timeout；`Stop` 不执行 Browser vendor 动作。Agent 不取得 Page、Context、Profile、Cookie、CDP、selector、任意 URL、任意 JavaScript、键盘文本、登录凭据、文件上传、文件系统或创建 Browser/context 的能力。

### 8. Browser Agent 使用自然终态而非人为作业预算

删除 Browser Agent 的固定 step、总秒数、累计 token/image、重复动作次数和 `BUDGET_EXHAUSTED`。仍保留的客观边界只有：

- model context window 与本次 max output；
- 单次 HTTP connect/read/overall timeout；
- 单次 Browser navigation/action timeout；
- Provider quota/rate limit 与 Publisher lane 串行；
- 用户取消；
-真实 Network/Browser/Provider 错误。

流程在 PDF captured、明确页面终态、Agent `Stop`、用户取消、真实系统失败或语义无进展时结束。语义无进展由以下转换记录判断：

```text
semantic_page_fingerprint
+ action_fingerprint
-> resulting_page_fingerprint
```

只有同一语义状态中的同一动作已经被证明返回同一语义状态时才停止；动作名称重复但页面发生进展时继续。Agent 停止时页面仍为 Challenge，Acquisition 可以把组合结果解释为 `challenge-unresolved`，无需专属状态机。

### 9. Configuration、Bootstrap、日志与持久化边界

> 本节原有的“一个共享 Agent service + 两个 role 自有配置”形状已由
> [ADR 0021](0021-provider-model-registry-and-direct-task-selection.md) 修订为“Provider 注册表 +
> `provider/model` Model 注册表 + Analyze/Download 直接选择”。Reasoning 与 image 属于 Model；
> limits、strict output 与 tool/image 调用合同属于消费模块。下文关于无状态 Runtime、消费模块业务所有权、显式 probe、
> Browser readiness 与日志/持久化边界的决定继续有效。

一个 Model Provider 下的 Model 共享 credential、Provider adapter 和 quota scope；Analyze 与
Download 可以选择同一或不同 Model Provider。每个 role binding 从所选 Model 取得 model/reasoning，
从消费模块取得 capability/context/output；`analysis-ready` 与 `browser-ready` 分别按模块合同计算。

交互配置以 `Models` 管理 Model Provider 与完整 `provider/model` Model，并在 `Providers` 子页管理
origin-bound Key。Analyze/Download 直接选择 Model，修改一方不得改变另一方。新增 Model 时，远程
Provider 的 Key 在同一流程隐藏输入；Key 就绪后自动发起一次有界模型目录请求，只有目录失败、为空
或不能安全解析时才回到 Manual。模型目录只提供 ID，不持久化 capability 或调用预算。

Browser model 的本地 role readiness 不能冒充完整 PDF acquisition readiness；后者还需要用户选择
Agent Browser controller、固定 Profile、CloakBrowser/Playwright/已核实 binary 与 headed
display，并继续受 Publisher permit、Network guard 和逐文章 entitlement 约束。

`config status` 始终纯本地。新增 Model 的自动目录请求不包含文献、页面、PDF 或模型调用，也不
持久化远端 catalog。它与用户显式执行的 `config test` 不同：后者才发送固定最小模型调用来验证
当前角色的结构化输出或图片/tool capability，并可能消耗 quota。

INFO 记录 role/provider/model、结果、usage、动作类别和稳定失败；Debug 可以记录脱敏 Observation/action/receipt/fingerprint 与安全大小，但不记录 prompt、模型原文/reasoning、screenshot bytes、页面正文、Cookie、Token、签名 URL、Profile 内容或 tool payload。

Analysis 继续形成一项业务 provenance。Browser Observation、screenshot、动作、模型决定和循环状态不进入 Literature、Report、Catalog、ArtifactStore、Profile 或 PDF provenance。成功 PDF 仍只记录既有 Acquisition source 与 lineage。

## 后果

- Agents 公共面更小，Provider 变化与业务 workflow 分离；
- Analysis 与 Browser 复用凭据、quota、协议和失败，但保留各自业务 owner；
- Rules 与 Agent 的行为和成本可在作业开始前明确选择，不再隐式制造模型流量；
- Challenge 可以被 Agent 处理，但不再扩张出第二套 Browser 状态机；
- 删除人为作业预算后，停止条件来自真实系统边界和已证明的语义无进展；
- 内部 Python/配置合同进行一次无兼容层切换，持久文献数据不迁移。

## 不采用的方案

- 继续保留 `AgentSession`、多 turn history 或累计 session/job budget；
- 建立 GenericAgent、Planner、Memory、Workflow、Tool Registry 或持久 AgentRun/AgentTurn；
- Rules miss 后自动 fallback 到 Agent，或 Agent 失败后回到 Rules；
- Browser 页面先跑确定性点击，再由 Agent 接管剩余步骤；
- 为 Challenge 建立专属 Observation、target、动作、budget 或状态机；
- 用固定 step/time/repeat 上限替代语义无进展检测；
- Agent 直接取得 Browser/CDP、任意 URL/selector/JavaScript、登录/MFA 或事实写入；
- 让 Provider adapter 理解文献、Publisher 或 Browser 业务。

## 需要新 ADR 的变化

- Agent 获得任意导航、JavaScript、文本输入、登录、机构选择、MFA、文件上传、外部工具或直接 Browser/CDP 所有权；
- 建立跨文章/命令长期 memory、后台自主任务或持久 Agent workflow；
- 让模型决定文献身份、数据库事实、PDF 基本验收或绕过消费模块检查；
- 改变 Public → API → Browser 风险顺序或允许 Browser-first；
- 允许同一 Publisher risk group 并行多个文章流程；
- 引入外部 challenge solver、token 注入、身份/Profile/出口切换；
- 把 Agents 暴露成不受消费模块合同约束的公开任意 prompt API。
