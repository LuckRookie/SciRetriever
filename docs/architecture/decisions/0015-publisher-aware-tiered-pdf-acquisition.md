# ADR 0015：访问方感知的三级 PDF 获取与 Browser 调度

- Status: Accepted
- Date: 2026-08-15
- Last amended: 2026-08-26
- Supersedes: none
- Amends: [ADR 0012](0012-process-local-provider-access-scheduling.md)、[ADR 0013](0013-decoupled-discovery-and-database-maintenance.md)、[ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)
- Amended by: [ADR 0016](0016-cloakbrowser-fixed-identity-runtime.md)、[ADR 0017](0017-shared-agents-and-controlled-browser-agent.md)、[ADR 0023](0023-generic-browser-agent-executor.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[Acquisition 技术文档](../technical/acquisition.md)、[Network 技术文档](../technical/network.md)、[Entry 技术文档](../technical/entry.md)、[Provider Notes](../../notes/providers/README.md)

## 背景

> **2026-09-06 修订：** ADR 0023 删除了下文的 Publisher-specific Browser route/rule、
> risk/session group 与 Rules/Agent 二选一。仍有效的是三级风险升级、一个 operator-managed
> Profile、Network 安全边界和 operation-local 失败语义；当前 Browser 设计以 ADR 0023 为准。

SciRetriever 面向用户指定领域批量补全文献。公开仓储和官方 API 通常有明确的批量访问合同与相对宽松的并发/额度；Browser 页面流程则面向交互式访问，成本更高，也更容易触发 challenge、限流或 IP 限制。因此现有“公开来源、授权 Provider API、受控 Browser”三级顺序是风险控制边界，不能因为 Browser 能处理出版社页面就改成默认 Browser-first。

另一方面，逐篇 Literature 让每个 Source 分别判断适用性并完整走完三层，会丢失 DOI 解析、API object locator、canonical landing 和稳定文章 ID 等中间知识，也无法在批量任务中先用低风险路径消化全部目标。Browser 若被当成普通第三个 Source，也无法在同一用户/机构身份 Profile 上复用认证状态，同时按访问供应商独立限速、暂停或熔断。

元数据来源、原文访问方和页面平台也不是同一身份。Scopus 找到 Wiley 论文不表示 Elsevier 拥有其原文；同一集团可能使用多个独立平台，同一平台也可能托管多个品牌。自由 publisher 字符串、Metadata Provider 名称或单独 DOI prefix 都不足以决定内容 API、Browser 会话或限速范围。

## 决策

### 1. 保留严格三级风险升级

默认自动 PDF 获取固定为：

```text
PUBLIC
  -> AUTHORIZED_PROVIDER_API
  -> CONTROLLED_BROWSER
```

Planner 可以省略已经确定不适用的路线，但不能把 Browser 自动提升到仍可能成功的公开或官方 API 路线之前。前一层只有正常未命中、明确不适用或按显式 Browser policy 可接受地不可用时，目标才可能进入下一层。任一路线完整提交主 PDF 后，当前 Literature 不再执行后续获取路线。

显式、用户主动发起的 Browser 诊断不改变默认自动获取合同，也不能被普通 Completion 隐式调用。

### 2. 先识别原文访问方，再形成运行时计划

Acquisition 在当前操作中加载静态、无 secret 的访问画像，并据此建立不持久化的运行对象：

```text
PublisherAccessProfile catalog（模块私有静态定义）
  -> PublisherAccessResolution（当前操作）
  -> AcquisitionPlan（当前操作）
  -> AccessRouteHint（当前操作）
```

`PublisherAccessProfile` 是无 secret 的静态访问画像，描述访问方和平台 identity、landing/asset origin、稳定文章 ID、公开路径、官方 API capability、Browser rule、正文/补充材料区分、`browser_rate_limit_group`、`browser_session_key` 和政策证据。它不等于 Metadata Provider 配置，也不要求为纯 Browser 出版社创建 API 凭据 section。

Resolution 优先消费已有中性事实，只有强证据不足且本次计划需要时，才在公开层安全解析一次 DOI landing。DOI resolver 只对 `doi.org` 发出不跟随 redirect 的第一跳 `GET`，读取并规范化 `Location` 后即停止；Python HTTP 不解析或请求 Publisher 目标，Publisher landing 只有在对应 Browser risk group 获得 permit 后才由 Chromium 访问。证据强度为：

```text
实际安全解析后的 DOI landing origin
> 访问方自有 AssetHint origin
> 来源明确的稳定文章 ID
> Provider record identity
> publisher text / DOI prefix 仅作待确认提示
```

已有明确 direct-file、公开仓储或稳定公开定位时不必为了识别出版社先请求 DOI。弱提示不能独自启用内容 API 或 Browser；多个强证据冲突时保持 unresolved 或稳定失败，不能按 catalog 顺序任选一个。

Plan 将适用动作按三层分组并保持确定顺序。API、DOI landing 或页面步骤可以返回当前运行的脱敏 `AccessRouteHint`，例如 canonical landing、PII/EID 等稳定 ID 或可安全继续的 locator。Hint 不携带 Cookie、header、token、无法脱敏的签名 URL、vendor object 或页面对象，不进入 Catalog、ArtifactStore、provenance 或长期失败历史。

### 3. 批量获取使用层级 cohort

Entry 仍从用户选择和一致 snapshot 冻结本次目标，不建立持久 BatchRun。对一个有界 cohort：

1. 所有缺 PDF 目标先完成适用的 PUBLIC routes；
2. 使用新 landing/locator/identity hints 重新规划；
3. 仍未解决的目标完成适用的 AUTHORIZED_PROVIDER_API routes；
4. 再次规划并执行 Browser admission；
5. 只有允许升级的最小剩余集合进入 Browser scheduler。

大型目标可以分成多个有界 cohort，但每个 cohort 内不能让较早失败的单篇文献越过尚未完成的低风险层提前打开 Browser。某个 Literature 已提交 PDF 后可以按 Entry 的局部成功边界继续 Parsing/Analysis；层级屏障只约束 PDF 获取风险升级，不撤销已提交事实。

### 4. 公开协议和 API 按官方政策限速

每个 production adapter 负责核实并声明对应服务当前官方的：

```text
quota identity
max concurrency
minimum interval
burst/window quota
period/daily quota
reset boundary
Retry-After / rate-limit headers
```

Quota identity 按真实 key、账户、IP、产品、endpoint family 或共享额度池形成，不按 adapter 类名任意拆分。Metadata 与 Acquisition 共享同一额度池时使用同一进程内 scope；明确独立产品才可拆开。

易变数字、endpoint 和证据日期保存在 Provider Notes，并与 adapter policy 对齐。Network 只执行中性规则。Operator 普通配置只能收紧，不能提高并发、缩短间隔、扩大额度或忽略 `Retry-After`。缺少可执行政策的 production adapter readiness 不通过；没有官方数字时只能使用明确标注、经接受的审慎项目政策，不能把猜测写成官方限制。

API capability 明确区分 metadata/search、locator/resolution、entitlement、structured full text、direct PDF 和 multi-step PDF object retrieval。只有实际 PDF 字节形成 `TemporaryPdf`；XML/JATS 和 locator 不冒充主 PDF。

### 5. Browser 按访问风险组并行

Browser 调度键是 `browser_rate_limit_group`，不是展示名称、Metadata Provider、DOI 或单篇任务。共享同一网页政策、访问平台、quota 或风控域的品牌进入同一组；有证据证明独立的风险域才可拆分。

每个 Browser 风险组固定满足：

```text
max_concurrency = 1
provider-declared article interval/window policy
one next_allowed_at / blocked_until
one session health / circuit state
```

不同风险组可以并行运行各自一个文章流程；同一组内严格限速串行。全局 Browser concurrency 只作为本机 CPU、内存和同时活动 Publisher lane 的资源上限，不能把不同供应商重新设计成一个全局业务锁。

普通配置 `browser_max_concurrency` 的默认值为 `5`，必须是严格整数且大于 `1`，不设置上限。当前 production Browser route 数量为 `9`，这只是当前 Provider catalog 的实现事实，不是配置边界；以后 route 增加时无需修改该合同。Publisher lane 按实际 Browser work 延迟进入调度，较大的 cap 不会启动多个 Browser process、创建空闲 context，也不会提高同一组固定为 `1` 的文章并发或放宽该组间隔、window、cooldown 与 circuit。

Browser 限速单位是一篇文章的受控流程。Permit 从 canonical landing 第一次导航前持有，覆盖授权和页面状态检查、页面动作、popup/viewer、response/download 捕获、临时文件和页面资源完整清理。失败重试也重新排队并服从同一政策；多个标签页、redirect、selector fallback 或换入口不能绕过组内串行和间隔。页面子资源由 host admission 与单次导航、请求、popup、下载超时和字节上限约束，不把每个 CSS/JS 请求误当下一篇文章，也不形成整篇 Browser 作业的总时长预算。

### 6. Browser 使用一个 operator-managed 持久身份 Profile

Browser 的身份状态边界和调度边界明确分离：

```text
一个用户/机构身份 Profile
  -> 一个 Browser process + 一个 persistent BrowserContext
     -> 多个 Publisher lane

Profile = 身份与认证状态边界
Publisher/rate-limit group = 调度与风险边界
```

普通配置只保存一个不含敏感信息的 `browser_profile` 身份名，不接受 Profile 路径、Cookie、账号、机构名或认证内容。Configuration 把该身份解析到固定的 owner-only 本地目录，验证目录树的 owner、权限和文件类型，并以跨进程独占 lease 保证同一 Profile 同时只能由一个 Browser process 使用。Profile 可以跨命令保留 Browser 自己管理的 Cookie、Local Storage、IndexedDB、SSO 状态、偏好和历史；SciRetriever 不读取、解释、导入、导出、复制或显示这些内容。删除 Profile 只能由用户在配置中心显式执行，正在使用的 Profile 拒绝删除。固定设备身份、identity manifest 与 Profile 迁移由 ADR 0016 修订本段。

生产对象图按需为选中的 Profile 启动一个有头 Browser process 和一个 persistent BrowserContext，并让所有 Publisher lane 共享它。每篇文章仍拥有隔离的 article token、page、route/event handler、连接绑定、单项字节上限和临时下载目录；同一 Publisher 严格串行，不同 Publisher 在 `browser_max_concurrency` 上限内并行。对象图关闭时必须关闭 process/context、Xvfb、CONNECT proxy 和临时下载工作区，但保留持久 Profile。一个 lane 的 runtime/cleanup failure 可以请求在其它活动 lane 排空后淘汰共享 runtime，不能中断或接管另一个 Publisher 正在处理的文章。唯一 CloakBrowser runtime 由 ADR 0016 修订本段。

自动流程首先使用当前机器正常网络出口，因此机构 IP entitlement 仍可直接生效。按 ADR 0016/0017，
产品不提供用户可见 Browser 登录、机构选择、MFA 或 Cookie 导入导出流程。SciRetriever 不自动
导航登录页、不填写账号或密码、不选择机构、不读取登录结果，也不处理 MFA；选用 Agent controller 时，Browser Agent 可以
在当前文章获准 challenge frame 中完成页面提供的可见交互，但不能外包验证、注入 token、切换
代理/IP/Profile 或扩张到任意页面控制。Profile 存在、其中保存了浏览器状态或 challenge 清除都
不构成认证成功或文章 entitlement 的证明。

`production-ready` Browser Profile 表示规则、政策证据、安全边界、生产对象图和离线验收已经
闭环，可以在保守政策下执行一次机构 IP 文章访问尝试；它不表示当前组织、当前 IP 或具体文章
已经获得访问权。Operator 通过普通配置中的 `browser_enabled = true` 对整个受控 Browser 第三层
作一次显式启用。SciRetriever 不再保存或接受逐 Publisher 的本机“机器访问许可”占位声明：
这样的布尔值无法验证合同，也曾把实际可逐篇判断的机构 IP 路线错误挡在 Browser 启动之前。

启用只允许 production catalog 中的封闭 route 进入逐文章检查，不会扩大许可范围，也不会改写
固定 origin、正文归属、risk/rate group、限速、Network 安全、Challenge 页面动作边界
或三级升级顺序。Operator 仍负责确保其使用符合组织授权和 Publisher 条款；程序以真实文章页
结果区分成功、明确付费墙、通用拒绝、challenge、限流和无正文，不能用本地配置字段预先宣称
文章 entitlement。

生产 adapter 固定以 `headless = false` 启动 Browser；无 GUI Linux 由进程内共享的 Xvfb 提供虚拟显示。自动运行时的“有头”只表示使用真实浏览器窗口栈，不表示自动流程会等待用户交互。页面、context、Cookie、download、Profile 路径或 Browser vendor object 不越过 Configuration/Network/Acquisition adapter 边界。ADR 0016/0017 后，固定身份 CloakBrowser runtime 取代 stock launcher，并允许受限 challenge dependency、页面自行清除验证状态，以及所选 Agent controller 的可见页面动作；系统仍不提供自动登录、Cookie 导入导出、机构选择、MFA、代理轮换、外部验证码 solver、验证 token 注入或任意规则脚本。

Publisher 请求由 Browser 原生完成 TLS、HTTP、Cookie、redirect、页面脚本、点击和 native download。Playwright route 对 runtime 暴露的每个请求在实际继续前执行 Provider guard、通用 URL/DNS/地址检查和 host admission；本机 loopback CONNECT proxy 只把已经审核的 hostname/port 绑定到精确、已批准的 IP，并透传加密字节，不终止 TLS、不读取 HTTPS 内容，也不以 Python HTTP 替代浏览器网络栈。Browser native redirect 的后续成员若没有再次暴露 route，只能复用同页仍存活的祖先 request proof，且最终 origin 必须已经过有限 Provider origin 审查、DNS prebind，并在 terminal body 读取前取得对应 host admission；跨 page、祖先已结束、循环/超深链或未预绑定 origin 均 fail closed 且不读取 body。

`PublisherAccessProfile` 必须在每次 navigation、popup、viewer、response 和 download 的可观察边界实施封闭 origin/target guard，并同时通过 Network 的通用 URL、DNS、redirect、credential forwarding、host admission、单次 timeout 和单项字节上限。host admission 的所有权单位是“当前文章访问到的 hostname”：第一次准入时取得实际 permit，同篇文章后续已批准请求复用，直到整篇清理后统一释放；其它 API/Browser 流程仍不能并发抢占该 host。它不能退化成每个 CSS/JS 都在 Playwright 单一事件线程中重新等待 permit，否则第二个 route callback 会阻止第一个 response event 派发而使页面自锁。规则明确允许的同源或批准 origin 页面子资源可以执行；未批准的第三方非关键子资源在 DNS 前丢弃而不拖垮正文流程，顶层 navigation、popup 和 PDF capture 仍 fail closed。页面脚本触发的显式 request 重新进入 route 审查，未暴露 route 的 native redirect 只能使用上一段规定的封闭关联。未知站点没有 generic arbitrary-site Browser fallback。

ADR 0023 修订后，Controlled Browser 作业只冻结一个 `AgentBrowserController`。它从第一次统一
`BrowserObservation` 起选择封闭动作；不存在确定性规则 controller、Publisher selector/locator 程序
或失败 fallback。controller 与 CloakBrowser/Profile、Network guard、页面 capture 和 PDF 验收协作。
每个单次点击、navigation、capture settle 或 wait 都有客观 action timeout，并另设不可由普通用户配置的
32 次模型 decision safety fuse；不存在累计 token/image 业务预算。补充材料、appendix、supporting
information 和错文由 Acquisition 的统一 PDF 归属验收排除。短期签名 query 只保留在当前 Browser
operation 内并交给 Browser 实际访问；guard、DNS key、日志、结果、provenance 和持久事实只接收去除
query 的 locator。

Browser 可以从受控 download event、PDF response、允许的 popup/viewer 或已核实官方 locator 交付 `TemporaryPdf`。顶层 PDF 由 Chrome 的 PDF 下载偏好和 native download manager 处理；Network 仍以对应已审核 request lease 关联下载并执行单项字节上限。正文与 supplementary material 必须按稳定文章 ID、origin 和 Profile 规则区分；下载事件、扩展名或媒体类型仍不能替代统一 PDF reader/页面树检查。

### 7. 升级、暂停与熔断语义

以下低风险终态可以进入 Browser admission：明确不适用、正常未命中、明确无 PDF capability，以及 API 对具体目标无 entitlement 但当前机器网络出口可能具有独立机构 IP 授权。

以下状态不得通过自动切换 Browser 制造替代流量：timeout、临时传输或服务失败、`429`、有效 `Retry-After`、quota exhausted、未到 reset boundary。它们形成延期或稳定失败，并更新共享 scope。支持的 API 未配置时必须明确报告；只有 Browser 已由用户显式启用且 admission policy 允许时才可继续，不能静默跳过。

Browser 的 `LOGIN_REQUIRED`、`MFA_REQUIRED`、`RATE_LIMITED`、`IP_BLOCKED` 或账号警告暂停或熔断对应风险组；其它独立 Provider 继续。Challenge 只是统一 Observation 的 `page_state=CHALLENGE`，不是文章默认终态，也不拥有 interaction-required/active/exhausted 生命周期、专属 target、controller 或预算。通用 Agent controller 使用与普通页面相同的六种封闭动作。页面自动或经动作清除 Challenge 后继续 capture、entitlement 与 PDF 检查；controller 停止且页面仍为 Challenge 时，Acquisition 可以形成稳定 `challenge-unresolved` 结果。本地资源策略缺口必须报告为 Network 资源阻断，不能冒充用户无权限或 Agent 失败。

裸 HTTP `403` 在没有更具体页面证据时稳定分类为文章级 `ACCESS_DENIED`，停止当前尝试但不据此推断“无订阅权限”、Challenge 或打开整个 Publisher circuit。只有明确 paywall/购买访问页面才分类为 `NOT_ENTITLED`；只有 Publisher profile 通过经审查 marker/resource/frame 事实识别出 Challenge 或 IP block 时才进入对应页面状态。登录、机构选择和 MFA 是自动流程识别后停止的页面状态。自动策略只能保持或降低速率，不能因连续成功自动提速，也不能通过新 Literature、重试或备用入口绕过 circuit。

只有所有适用 routes 正常结束且不存在 deferred、action-required、未解决 route failure、配置/Port/清理/发布/stale 错误时，Acquisition 才能提交 `AutomaticPdfAcquisitionExhaustion` 并返回 `NoPrimaryPdf`。

### 8. 运行状态不成为文献事实

Resolution、Plan、route hints、tried keys、Browser queue、runtime health、登录/MFA/challenge 页面状态、`next_allowed_at`、`blocked_until`、circuit 和候选失败只服务当前操作。它们可以形成脱敏实时进度；需要用户处理或延期的目标只通过现有 `DatabaseCompletionReport.failed` 中稳定的 `code/reason/action/retryable` 表达，不新增 Report 分区、自由 `details` 或第二套 counts。它们不形成 Literature 状态、数据库表、Artifact、provenance、可恢复任务或跨运行失败历史。

进程退出后不恢复这些动态状态；仍遵守 ADR 0012 的非跨进程限速保证。静态 `PublisherAccessProfile`、官方政策、operator 收紧配置和选中的 Browser Profile 身份可以持久加载。Chrome 自己管理的认证状态只留在 owner-only Profile 中；Browser process/context、临时下载目录、当次计数、队列、runtime health 和 circuit 都不跨操作保留，也不进入文献数据库。

## 后果

- 三级架构继续保护用户的机构网络访问和供应商风控边界，Browser 不成为默认大批量入口。
- Publisher recognition 为公开、API 和 Browser 共享，但识别本身不会启动 Browser。
- 批次低风险层先消化目标，Browser 只处理最小剩余集合。
- API 取得的 locator/稳定 ID 可以降低 Browser 导航和无效点击，但不会污染数据库。
- 不同 Provider Browser 可以并行；同一风险组始终串行并服从自己的政策。
- 所有 Publisher lane 复用一个用户/机构身份 Profile 和一个 Chrome process/context；Profile 不按 Provider 拆分，也不因命令结束而删除。
- Browser 总开关只启用已审查 route 的逐文章 Profile/IP 尝试，不把本地 Profile 或会话状态冒充组织或文章权限证明。
- 一个 Provider 的页面状态、限速或熔断不会无关阻塞其它 Provider。
- 新 Provider 必须经过 Profile、官方政策、origin guard、正文归属、fixture 和明确验证门，不能通过 generic fallback 猜测接入。
- Browser 会比公开/API 慢，CLI 和 Report 必须把等待、停止原因和下一步清楚呈现。
- Requirements R3 的二值结果、最低 PDF 检查、不可变发布、唯一主 PDF 和耗尽边界不改变，不需要新增持久 schema。

## 不采用的方案

- 所有论文默认 Browser-first；
- 识别出 Publisher 后自动跳过仍适用的公开/API 路线；
- 每篇 Literature 私建 limiter、Browser process 或 session；
- 每个 Publisher 各自维护一套身份 Profile、Cookie 和 Chrome process；
- 每次命令使用并删除临时 Profile，使已授权的浏览器状态无法复用；
- 所有 Provider Browser 全局串行；
- 同一 Provider 多标签页或多 worker 并发；
- 固定一个数字冒充所有 Provider 的官方 Browser 间隔；
- 用逐 Publisher 的本地布尔值冒充合同或文章访问权，并在真实页面检查前阻断 route；
- 未经 Browser 总开关、runtime readiness 与调度准入就构造可执行 Browser adapter；
- API rate-limit 后立即切 Browser；
- Rules miss 后自动切到 Agent，或 Agent 失败后回到 Rules；
- 为 Challenge 建立专属 Observation、target、动作、状态机或重试/turn budget；
- 任意未知站点 Browser fallback、任意 JavaScript、MFA 绕过、代理或指纹规避；
- 自动填写登录凭据、自动选择机构、处理 MFA，或把 challenge 外包给第三方 solver、注入验证 token、切换 IP/Profile；
- 导入、导出、复制或由 SciRetriever 解释 Cookie/浏览器认证内容；
- 把 Cookie、页面、候选失败、队列或限速状态写入文献数据库。

## 需要新 ADR 的变化

以下变化需要新的 owner 决策：

- 改变默认 Public -> API -> Browser 风险顺序或允许自动 Browser-first；
- 允许同一 Browser risk group 并发多个文章流程；
- 取消 Provider policy、origin guard、统一 Network 准入或 Browser action 安全边界；
- 把动态 plan、queue、session、限速、Cookie 或失败历史持久化为产品状态；
- 增加跨进程、跨重启或跨机器的 Browser/API 配额协调；
- 同时激活多个用户/机构身份 Profile，或把 Profile 从身份边界拆成逐 Publisher 身份池；
- 引入 Cookie 导入导出、自动登录、自动机构选择或 MFA；
- 让 Challenge 页面动作脱离当前文章、统一 Observation、同一 Publisher permit 或 Network action executor，或引入外部 solver/token 注入；

单个 Provider 的 endpoint、selector、官方限速数字、origin、产品 capability 和 evidence 日期变化不需要新 ADR，但必须更新 Provider Notes、Profile revision、adapter policy 和直接测试，且不能放宽本 ADR 的层级与安全边界。
