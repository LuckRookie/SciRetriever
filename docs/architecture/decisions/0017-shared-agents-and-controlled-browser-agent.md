# ADR 0017：无状态共享 Agents 与受控 Browser Controller

- Status: Accepted
- Date: 2026-08-21
- Last amended: 2026-09-04
- Supersedes: none
- Amends: [ADR 0008](0008-summarized-markdown-literature-content.md)、[ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)、[ADR 0015](0015-publisher-aware-tiered-pdf-acquisition.md)、[ADR 0016](0016-cloakbrowser-fixed-identity-runtime.md)
- Amended by: [ADR 0019](0019-agent-operable-application-and-sdk-model-runtime.md)、[ADR 0021](0021-provider-model-registry-and-direct-task-selection.md)、[ADR 0023](0023-generic-browser-agent-executor.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[Analysis 技术文档](../technical/analysis.md)、[Agents 技术文档](../technical/agents.md)、[Acquisition 技术文档](../technical/acquisition.md)、[Network 技术文档](../technical/network.md)

## 背景

> **2026-09-06 修订：** ADR 0023 删除了 Rules controller、Publisher Browser rule 和
> `rules | agent` 配置。本文的无状态 Agents Runtime、六种封闭动作、稳定 Observation、
> Candidate/settlement 与安全 fuse 继续有效；当前 Browser 只有通用 Agent controller。

Analysis 与受控 Browser 是两个需要模型能力的真实消费者，但二者的业务目标完全不同。Analysis 需要严格结构化文本并自己组织两阶段文献分析；Browser 需要图像和 tool decision，并自己组织页面观察、动作与下载终态。复制 Provider、凭据、quota、协议和稳定失败会形成两套基础设施；把 Analysis 或 Browser workflow 放进通用 Agents 又会让项目失去清晰的业务 owner。

现有实现已经证明共享 Provider adapter 可行，但同时暴露了不必要的复杂度：通用 `AgentSession` 保存 history、turn 和累计预算；Analysis 为单次调用创建 `max_turns=1` session；Browser 又把 session 与 step、总时长、token、图像和重复动作次数组合成作业状态。Challenge 还被建模为专属 Observation、target、动作和交互生命周期。它们把模型协议、业务 workflow 和 Browser runtime 混在了一起。

本 ADR 最初将 Agents 收敛为无状态窄腰，并把受控 Browser 的两个 controller 设计为作业开始前的互斥选择，而不是一条“规则失败后调用 Agent”的 fallback 链。该双 controller 部分后来由 ADR 0023 修订为唯一通用 Agent controller。

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

### 4. 历史决策：Controlled Browser 在作业开始前选择一个 controller

> 本节的双 controller 配置已由 ADR 0023 替代，仅保留为决策演进记录；当前运行时只有通用
> `AgentBrowserController`。

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

### 5. 历史决策：两种 controller 共用 Publisher 知识

> 本节已由 ADR 0023 替代。当前 Publisher profile 不拥有 Browser 页面策略，Network/Acquisition
> 分别拥有通用执行与 PDF 正确性。

Publisher access profile 继续拥有并同时服务两种 controller：

- route 与 canonical landing；
- allowed origins、challenge dependency、navigation guard 和三态 capture policy；
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
- 真实 Network/Browser/Provider 错误。

2026-09-04 amendment 将 Browser Agent 的跨层合同收敛为一个 article-local 原子 step session：
`start()` 返回首个稳定 step；只有 `Ready` 可以继续；Acquisition 对其 Observation 作一次独立模型决定，
再调用 `apply(action)`；`Captured / Blocked / Failed / Cancelled` 全部是终态。Acquisition 不再调用或解释
Network 的 `observe / settle / execute`，也不再把七种 Network transition 二次转换成 Agent disposition
和 terminal cause。

一次 `start/apply` 内由 Network 完成 readiness、exact binding、最多一次 vendor dispatch、页面替换、
quiet settlement、Candidate/capture、timeout 和 cancellation。这里的稳定是当前主 Page 仍属于同一
article session，Page/frame/surface/screenshot 来自同一 observation generation，且稳定语义事实在内部
短 quiet window 内一致；不要求动画、像素或无关网络请求停止。加载、document/frame/Page replacement
以及 popup/viewer 交接期间，Network 从 article-owned Page 集合重新观察，不把半加载界面交给 Agent。
旧 action 在 dispatch 前发现 binding 已变时不重放，只返回新的 `Ready` 让 Agent 重新决定。

vendor 过渡仍在持有原始 Browser 异常的 adapter/engine thread 内分类；navigation race、execution
context destroyed、frame replacement 或旧 Page closed 是 Network 私有瞬态，不直接成为跨层 failure。
只有有界 deadline 内不能形成稳定结果，或 Browser process/context 真正退出、策略越界、用户取消时，
才形成稳定 `Failed` 或 `Cancelled`。action receipt 可以记录动作实际 dispatch 的旧 Page，终态或下一
`Ready` 可以来自同一 article session 的 successor Page；二者共享 article identity 和 revision 顺序，
但不要求 `page_id` 相同。

Publisher marker 与文章归属分类仍由 Acquisition 的 operation-local policy 拥有。Network 在返回
`Ready` 前调用该 policy，并在分类改变 page state 或页面代际不匹配时重新进入同一个有界 settlement；
相同 stale 状态不能无限重试。`capture_state=CANDIDATE` 仍是 Network 私有中间态，必须先走向完整
capture、明确清除或 candidate timeout，不能发送给 Agent。稳定跨层结果只保留：可继续的 `Ready`、
已捕获的 `Captured`、页面/Stop/no-progress/candidate-timeout 等自然 `Blocked`、系统或策略 `Failed`，
以及用户 `Cancelled`。Acquisition 再将这一项终态映射为 route/report 语义并执行既有 PDF 二次验收。

Rules 与 Agent 共享同一 Network Browser flow、capture、timeout、cancel 和 cleanup owner，但权限面不同：
Rules 可使用版本化且经过代码审查的 selector/locator 程序；Agent 永远只使用上述六种 Observation-bound
动作。不得为了形式统一向 Agent 开放 selector、locator、URL、script 或 text-entry，也不得让 Rules
复制一套 Network transport/capture 生命周期。

2026-09-04 amendment 将正文交接从一次性的布尔 capture guard 改为唯一的三态
`BrowserCapturePolicy`。Network 在 destination、DNS、host admission 和 request correlation 已通过后，
只向 Acquisition 提交不可序列化、operation-local 的 `BrowserCaptureEvidence`：query-free locator、capture
kind、规范媒体类型、direct request 或 live redirect-descendant correlation、redirect depth、request 是否
navigation、是否来自精确起点，以及是否为 native download。该证据不包含 header、Cookie、query、正文、
vendor object、Publisher 名称或 DOI 解释；Network 也不得自行判断文章身份。

Acquisition 使用当前 Publisher rule 和 article intent 返回 `ACCEPT | DEFER | REJECT`：

- `ACCEPT` 是读取 response/download 正文的必要条件，但仍不是已发布主 PDF；字节还要经过既有 PDF
  validation、candidate dedupe 和 create-if-absent 发布；
- `DEFER` 只建立一个未读取、未发布、当前 article 隔离的 Candidate。response 或 native download 的
  vendor owner 继续由 Network 持有；landing 等文章证据更新后必须重新调用当前 policy，不能复用旧布尔值；
- `REJECT` 在正文读取前丢弃；timeout、取消、runtime/cleanup failure 和 article 结束也必须确定性清理，
  不得把 Candidate 带入下一篇文章。

response 预告 native download 时，pending 只保存 request lease、destination 和中性 evidence；download
真正到达后重新判定。`CANDIDATE` 存在时 readiness/settle gate 先收敛 capture，`CAPTURED` 后不再调用模型；
未决 Candidate 超时形成具体的 capture/candidate timeout，而不是让 Agent 接收下载后的空白页或只报告更早
的 public `403`。

同一 response 预告 native download 时，Network 分别向当前 policy 提交 `RESPONSE` 和 `DOWNLOAD`
evidence，并按 `REJECT < DEFER < ACCEPT` 选择更强决定；同级优先保留 `DOWNLOAD` 的原生关联。非导航
`fetch` 若 `RESPONSE` 决定更强，可以直接读取已经获准的 response；顶层 PDF navigation 在
`always_open_pdf_externally` 下即使选择 `RESPONSE`，也必须等待 native download，因为 response metadata
可见不代表正文仍可由 response 读取。若两种 evidence 都为 `REJECT`，Network 只保留一次性关联以便
native download 到达后不读正文并安全删除；该关联不是 Candidate，不能延长 Agent 流程或成为成功证据。

当具体 Browser runtime 的普通 response event 不能保证稍后仍可读取正文时，Acquisition 可以只对按
当前 rule 已明确分类为主文的 `GET document|fetch|xhr` request 提供 prefetch 许可。Network 必须先完成
全部 request guard、DNS/host admission 与 connection binding，再以不跟随 redirect 的
`route.fetch(max_redirects=0)` 获取并 `fulfill` 同一请求；该私有 response 只作为后续 body source，
不改变正常 response guard、capture policy、字节验收和 cleanup。`206 Partial Content` 不得作为完整
PDF 单独读取或接纳。

download callback 必须原子取得资源 ownership 并进入在途计数。文章 cleanup 先封闭新的 callback，等待
已经开始的 callback 完成，再回收 page、download 和 stream；不能为了开始 cleanup 而清零在途计数，也不能
让 callback 的正常结束把已捕获结果覆盖为 cleanup failure。

一个受限补充证据适用于 Publisher 将精确、已审核的 DOI-PDF 起点实时重定向到 opaque download endpoint：
只有起点本身已由当前 rule/identifiers 判为主 PDF、最终 request 是该起点仍存活的 redirect descendant、
全部 origin/destination/DNS/host guard 已通过、最终 locator 没有明确另一文章身份且不属于 supplement 或
excluded 资源时，lineage 才能补足最终 path 不再携带 DOI 的信息。普通 landing 起点、无 live correlation、
同源任意 PDF 或错误 DOI 均不能借此放行。

通过该例外的 `ACCEPT` evidence 必须由同一个 article-local policy 保留到 capture 交付完成；
`BrowserCaptureBatch` 无需序列化或暴露这份 operation-local evidence，但 Source 的二次验收必须同时匹配
最终 locator、capture kind 和 media type，并按当前 rule 重新验证原 lineage。只剩同源 opaque locator、
没有对应 accepted evidence，或 evidence 与返回 capture 不一致时仍然拒绝；二次验收不得退化成要求 opaque
locator 单独重复证明已经由 lineage 证明过的文章身份。

本决策明确拒绝固定 sleep、同源 PDF 全放行、ACS 专属分支、在 `DEFER` 时预读正文，以及长期保留 bool
guard 与三态 policy 两套生产路径。页面 readiness 的 quiet window 仍只解决可操作 Observation 的短暂
过渡，不能代替文章归属和 capture handoff 合同。

精确 action 安全绑定和语义进展使用两类不同 fingerprint：

- `execution_binding_fingerprint` 包含当前 revision、screenshot、短期 page/surface/element identity 与精确 geometry，用于确保 stale action 在 vendor dispatch 前失败；
- `stable_semantic_page_fingerprint` 与 `stable_action_intent_fingerprint` 排除 revision、pixels、screenshot ID 和无意义的短期 ID/geometry 抖动，用于当前 article flow 的 progress/cycle 证明。

语义无进展由以下 settled 转换记录判断：

```text
stable_semantic_page_fingerprint
+ stable_action_intent_fingerprint
-> resulting_stable_semantic_page_fingerprint
```

第一次 `state + intent -> same state` 只形成证据并反馈给下一次独立模型调用，不能立即退出；同一稳定 state 再次提出已经证明无效的 intent 时，才在 vendor dispatch 前停止。article-local transition graph 同时记录非 self edge，因此 `A -> B -> A` 后再次提出已知 `A` edge 时能够识别 cycle。动作名称重复但页面发生真实语义进展时继续；单独的 revision、navigation event 或 screenshot pixels 变化不等于语义进展。Agent 停止时页面仍为 Challenge，Acquisition 使用具体原因区分 Agent Stop、cycle、candidate timeout、resource blocked 等 unresolved 结果，无需专属 Challenge 状态机。

自然终态之外增加一个不可由普通用户配置的 controller high-water safety fuse：每个 article flow 最多允许 32 次模型 decision。它只防止模型持续制造未重复 click-point 等新 intent 而造成无限调用；触发时稳定失败为 `controller-safety-limit`，属于 action-required/system safety，不是 normal miss、`NoPrimaryPdf`、`BUDGET_EXHAUSTED` 或自动 acquisition exhaustion。单次 Provider/Network/Browser timeout、取消、quota 和 Publisher lane 约束继续独立生效。修改该 safety 边界或把它变成业务预算需要重新审查本 ADR。

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
