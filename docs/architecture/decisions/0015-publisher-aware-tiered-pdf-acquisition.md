# ADR 0015：访问方感知的三级 PDF 获取与 Browser 调度

- Status: Accepted
- Date: 2026-08-15
- Last amended: 2026-10-07
- Supersedes: none
- Amends: [ADR 0012](0012-process-local-provider-access-scheduling.md)、[ADR 0013](0013-decoupled-discovery-and-database-maintenance.md)、[ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)
- Amended by: [ADR 0016](0016-cloakbrowser-fixed-identity-runtime.md)、[ADR 0017](0017-shared-agents-and-controlled-browser-agent.md)、[ADR 0023](0023-generic-browser-agent-executor.md)、[ADR 0030](0030-browser-transport-and-progress.md)（文章平台资格、后台下载与会话 cap）
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[文献与材料：材料获取、路线与候选](../technical/03-literature-materials.md#4-材料获取路线与候选)、[任务与协作控制：共享支撑：受控网络访问](../technical/02-task-coordination.md#7-共享支撑受控网络访问)、[任务与协作控制：数据库补全与阶段协调](../technical/02-task-coordination.md#4-数据库补全与阶段协调)、[Provider Notes](../../notes/providers/README.md)

> 2026-10-04：[ADR 0029](0029-unverified-pdf-acquisition.md) 取消下载阶段的文章身份门；有效 PDF
> 正常发布并标记文章身份未验证，三级路线和 Network 边界继续保留。

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

`PublisherAccessProfile` 是无 secret 的静态访问画像，描述访问方和平台 identity、landing/asset origin、稳定文章 ID、公开路径、官方 API capability、正文/补充材料区分、`browser_rate_limit_group`、`browser_session_key` 和政策证据。它不拥有 Browser 页面规则或下载脚本，也不等于 Metadata Provider 配置，不要求为纯 Browser 出版社创建 API 凭据 section。

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

### 5. Browser 按实际访问平台并行

ADR 0023 撤销 Publisher-specific `browser_rate_limit_group` 字段。通用 Browser 的运行时平台键
来自已核实的 landing/导航关系、稳定 alias 与可靠可注册域名；未知归属可保守进入 unknown 组。
展示名称、Metadata Provider、Publisher 自由文本、单独 DOI prefix 和前台标签页不能决定调度键。
共同 CDN、DOI resolver、SSO 与验证服务不自动成为所有文章的平台。

每个文章平台按 ADR 0030 满足：

```text
network_active_articles = 1
network_completion_cooldown = 30 seconds
stricter declared interval/window/Retry-After policy
one next_allowed_at / blocked_until
one session health / circuit state
```

不同平台可以并行运行；同平台浏览与下载共同限速串行。`browser-generic` 是共享聚合政策，
空 override 不强制全局单 lane；旧显式 `max_concurrency = 1` 继续在聚合层限制整个文章会话寿命。

当前字段为 `[browser].max_concurrency`，表示保留文章会话 cap，默认 5、允许 1，首版有效
上限 8。旧较大值仍可读取，实际 cap 为 `min(配置, 8)`，展示限制原因且不改写配置文件。
worker 数为 `min(2, 有效 cap)` 并服从共享模型预算；每 session 最多一个主下载。会话按
实际可服务任务延迟创建，不启动多个 process/context，也不放宽平台窗口、冷却或共享模型额度。

Browser start 的单位是首次获准的一次文章网络尝试，失败恢复重新取得资格也计 start，普通
5 秒 step 不重复计。平台资格在文章首次请求前取得，覆盖页面与主下载；网络实际结束且保留
页不能继续后台访问后释放，并开始 30 秒冷却。本地文件检查、hash、publication 与临时文件
清理不延长网络资格，session/file owner 继续承担清理责任。多个标签页、redirect、popup、
viewer 或换入口不能绕过平台串行、窗口、间隔、`blocked_until` 或 circuit；CSS/JS 不是独立
文章 start。累计活跃预算与独立传输/session 寿命见 ADR 0023/0030。

上述配置与调度修订是目标合同，生产并行、后台下载和实际资源 cap 的验证由实施记录说明，
不能把配置可读取或逻辑 Promise 并发写成已通过运行验收。

### 6. Browser 使用一个 operator-managed 持久身份 Profile

Browser 的身份状态边界和调度边界明确分离：

```text
一个用户/机构身份 Profile
  -> 一个 Browser process + 一个 persistent BrowserContext
     -> 多个独立文章 session

Profile = 身份与认证状态边界
article platform = 网络调度与风险边界
```

普通配置只保存一个不含敏感信息的 `browser_profile` 身份名，不接受 Profile 路径、Cookie、账号、机构名或认证内容。Configuration 把该身份解析到固定的 owner-only 本地目录，验证目录树的 owner、权限和文件类型，并以跨进程独占 lease 保证同一 Profile 同时只能由一个 Browser process 使用。Profile 可以跨命令保留 Browser 自己管理的 Cookie、Local Storage、IndexedDB、SSO 状态、偏好和历史；SciRetriever 不读取、解释、导入、导出、复制或显示这些内容。删除 Profile 只能由用户在配置中心显式执行，正在使用的 Profile 拒绝删除。固定设备身份、identity manifest 与 Profile 迁移由 ADR 0016 修订本段。

生产对象图按需为选中的 Profile 启动一个有头 Browser process 和一个 persistent BrowserContext，
所有文章 session 共享它。每篇拥有固定 article/session identity、页面及 opener 归属、route/
event handler、受控传输与临时文件责任；同平台网络活动串行，不同平台在有效会话 cap 内并行。
对象图关闭时关闭 process/context、Xvfb、CONNECT proxy 和临时下载工作区，保留持久 Profile。
单篇 cleanup 或页面故障不能关闭或接管另一篇；共享 context/process 崩溃才形成整体 runtime
故障。唯一 CloakBrowser runtime 由 ADR 0016 修订，具体局部/整体取消见 ADR 0030。

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

Publisher 请求由 Browser 原生完成 TLS、HTTP、Cookie、redirect、页面脚本、点击和 native
download。Browser/Network adapter 在首次请求和每一 redirect 继续前证明文章 session 归属并
执行平台资格、通用 URL/DNS/地址及 host 准入；若高层 route 未暴露 redirect 后续，adapter
必须取得请求继续前的可靠底层证据，不能先访问目标再补许可或仅在读取 terminal body 前检查。
无法证明归属/准入时 fail closed。本机 loopback CONNECT proxy 将已审核 hostname/port
绑定到已批准 IP并透传加密字节，不终止 TLS、不读取 HTTPS 内容，也不另发脱离当前浏览器
访问身份的 HTTP 请求代替原传输。

ADR 0023 撤销 Publisher-specific 页面 guard/profile。通用 Browser 按当前文章的已准入页面/
opener 关系约束 navigation、popup、viewer、response 与 download，并经过 Network 的
URL、DNS、redirect、凭据转移、host 与实际资源准入。文章平台资格在网络活动期间持有，
session/file责任独立保留到发布/收尾，不能让每个 CSS/JS 各自等待一次文章许可形成自锁。
未准入资源在实际请求前拒绝；顶层与 PDF capture 必须有归属证据。未知站点具有元数据驱动、
经 Network 准入的起点时可以进入 generic Browser；Agent 仍不能构造任意 URL，起点仅来自
AssetHint 或受控 DOI landing 入口。

ADR 0023 修订后，Controlled Browser 作业只冻结一个 `AgentBrowserController`。它从第一次统一
`BrowserObservation` 起选择封闭动作；不存在确定性规则 controller、Publisher selector/locator 程序
或失败 fallback。controller 与 CloakBrowser/Profile、Network guard、页面 capture 和 PDF 验收协作。
每个单次点击、navigation、capture settle 或 wait 保留有界保护；本次目标统一为 ADR 0023 的
300 秒累计活跃时间、50 次真实模型派发、100 次 Agent 动作和至少 5 秒下一轮决策间隔。
operation 与 transfer/session 总寿命独立计量，不增加累计 token/image 业务预算。此前离线
flow 的 24/12 上限只是被本次目标替代的旧执行基线，不再保留第二套 32 次目标 fuse。
Acquisition 只执行 PDF 文件合法性与当前任务关联检查，下载阶段不以 DOI、标题、版本或
正文/补充材料内容身份匹配阻断接纳（ADR 0029）。短期签名 query 只保留在当前 Browser
operation 内并交给 Browser 实际访问；guard、DNS key、日志、结果、provenance 和持久事实只接收去除
query 的 locator。

Browser 可以从受控 download event、PDF response、允许的 popup/viewer 或已准入 locator
交付文件候选。顶层 PDF 使用原生 download manager；Browser 保留对应已审核 request/session
关联并执行实际资源保护。Agent 使用目标元数据选择主 PDF，Acquisition 保留 provenance 与
任务关联；下载事件、扩展名或媒体类型不能替代统一 PDF reader/页面树检查。

### 7. 升级、暂停与熔断语义

以下低风险终态可以进入 Browser admission：route 明确声明不适用、route 明确声明没有 PDF capability，或正常 locator miss/耗尽且 Browser 独立已获准。API 对具体目标的 `no-entitlement` 当前不在自动 Browser rescue 范围内，保持 action-required/fail-closed，等待用户或外部授权。

2026-10-07 根据化学合成全链路实测与用户要求修订公共 HTTP 的能力判断：不带限流反馈的公共 HTTP `403`、实际返回 HTML 且静态链接不能交付 PDF、以及明确达到有界重定向上限，都只证明该无会话 HTTP 路线不能完成当前获取，允许声明 `http-route-unavailable`，在已配置的后续 API 和独立获准 Browser 中继续。该声明不证明机构无订阅权限，也不代表 Browser 已通过访问校验；Browser 自己观察到的明确拒绝仍按下文停止。来源所谓“PDF 直链”和 `Content-Type` 不能覆盖实际字节，返回 HTML 时仍可按通用静态链接规则处理。此修订不增加任何出版社专用规则，不因 API key 存在而改变已配置来源集合。

上述声明不能覆盖更早的未解决失败：同一层先发生网络故障，后遇到不适用路线，仍保留原失败。`429` 或携带 `Retry-After` 的响应/异常立即停止该目标的备用候选及后续层级；`401`、临时服务错误、超时、未分类网络错误和系统/存储错误不属于公共 HTTP 能力声明。重定向上限只有在 Network 提供精确原因且该链没有限流反馈时才可声明，不能把任意 `network-http` 当作需要 Browser。

以下状态不得通过自动切换 Browser 制造替代流量：timeout、临时传输或服务失败、`429`、有效 `Retry-After`、quota exhausted、未到 reset boundary。它们形成延期或稳定失败，并更新共享 scope。支持的 API 未配置时必须明确报告；只有 Browser 已由用户显式启用且 admission policy 允许时才可继续，不能静默跳过。

Browser 的 `LOGIN_REQUIRED`、`MFA_REQUIRED`、`RATE_LIMITED`、`IP_BLOCKED` 或账号警告暂停或熔断对应风险组；其它独立 Provider 继续。Challenge 只是统一 Observation 的 `page_state=CHALLENGE`，不是文章默认终态，也不拥有 interaction-required/active/exhausted 生命周期、专属 target、controller 或预算。通用 Agent controller 使用与普通页面相同的六种封闭动作。页面自动或经动作清除 Challenge 后继续 capture、entitlement 与 PDF 检查；controller 停止且页面仍为 Challenge 时，Acquisition 可以形成稳定 `challenge-unresolved` 结果。本地资源策略缺口必须报告为 Network 资源阻断，不能冒充用户无权限或 Agent 失败。

Browser 当前尝试中的裸 HTTP `403` 在没有更具体页面证据时稳定分类为文章级 `ACCESS_DENIED`，停止当前尝试但不据此推断“无订阅权限”、Challenge 或打开整个 Publisher circuit。只有明确 paywall/购买访问页面才分类为 `NOT_ENTITLED`；只有 Publisher profile 通过经审查 marker/resource/frame 事实识别出 Challenge 或 IP block 时才进入对应页面状态。登录、机构选择和 MFA 是自动流程识别后停止的页面状态。自动策略只能保持或降低速率，不能因连续成功自动提速，也不能通过新 Literature、重试或备用入口绕过 circuit。

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
- 任意 URL/任意站点的 Browser fallback、任意 JavaScript、MFA 绕过、代理或指纹规避；
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
