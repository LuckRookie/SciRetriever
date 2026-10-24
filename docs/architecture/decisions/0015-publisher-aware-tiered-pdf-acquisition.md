# ADR 0015：访问方感知的五层 PDF 获取与 Browser 调度

类型：决策（ADR）
负责：访问方感知的五层 PDF 获取与 Browser 调度
状态：Accepted

- Date: 2026-08-15
- Last amended: 2026-10-13
- Supersedes: none
- Amends: [ADR 0012](0012-process-local-provider-access-scheduling.md)、[ADR 0013](0013-decoupled-discovery-and-database-maintenance.md)、[ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)
- Amended by: [ADR 0016](0016-cloakbrowser-fixed-identity-runtime.md)、[ADR 0017](0017-shared-agents-and-controlled-browser-agent.md)、[ADR 0023](0023-generic-browser-agent-executor.md)、[ADR 0030](0030-browser-transport-and-progress.md)（文章平台资格、后台下载与会话 cap）
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[文献与材料：材料获取、路线与候选](../technical/03-literature-materials.md#4-材料获取路线与候选)、[任务与协作控制：共享支撑：受控网络访问](../technical/02-task-coordination.md#7-共享支撑受控网络访问)、[任务与协作控制：数据库补全与阶段协调](../technical/02-task-coordination.md#4-数据库补全与阶段协调)、[Provider Notes](../../notes/providers/README.md)

> 2026-10-04：[ADR 0029](0029-unverified-pdf-acquisition.md) 取消下载阶段的文章身份门；有效 PDF
> 正常发布并标记文章身份未验证，Network 边界继续保留。
> 2026-10-11：用户接受五层顺序、独立名称治理与首次模型前入口准备；下文替代旧三级执行顺序，
> 凭据、权限、限流和不可变发布边界不因排序变化放宽。

## 背景

> **2026-09-06 修订：** ADR 0023 删除了下文的 Publisher-specific Browser route/rule、
> risk/session group 与 Rules/Agent 二选一。仍有效的是 Browser 最后执行、一个 operator-managed
> Profile、Network 安全边界和 operation-local 失败语义；当前 Browser 设计以 ADR 0023 为准。

SciRetriever 面向用户指定领域批量补全文献。公开仓储和官方 API 通常有明确的批量访问合同与相对宽松的并发/额度；Browser 页面流程则面向交互式访问，成本更高，也更容易触发 challenge、限流或 IP 限制。2026-10-11 将原三级顺序细化为“已有直链、出版社专用 API、通用 API、公共网站、Browser”五层，以优先消费已知文件与适用服务；不能因为 Browser 能处理出版社页面就改成默认 Browser-first。

另一方面，逐篇 Literature 让每个 Source 分别判断适用性并完整走完各层，会丢失 DOI 解析、API object locator、canonical landing 和稳定文章 ID 等中间知识，也无法在批量任务中先用低风险路径消化全部目标。Browser 若被当成普通 locator Source，也无法在同一用户/机构身份 Profile 上复用认证状态，同时按访问供应商独立限速、暂停或熔断。

元数据来源、原文访问方和页面平台也不是同一身份。Scopus 找到 Wiley 论文不表示 Elsevier 拥有其原文；同一集团可能使用多个独立平台，同一平台也可能托管多个品牌。自由 publisher 字符串、Metadata Provider 名称或单独 DOI prefix 都不足以决定内容 API、Browser 会话或限速范围。

## 决策

### 1. 五层执行顺序与认证边界分别表达

默认自动 PDF 获取固定为：

```text
direct
  -> publisher-api
  -> general-api
  -> public-web
  -> browser
```

| 阶段 | 当前来源归类 |
| --- | --- |
| direct | 已有主 PDF 线索；arXiv ID、PMCID 可以确定构造的公开 PDF 地址 |
| publisher-api | Elsevier Article/Object、Wiley TDM 等有文章级适用证据的专用服务 |
| general-api | CORE、Unpaywall 等跨出版社聚合或开放获取 API |
| public-web | DOI/文章落地页的有界 HTTP 与静态 PDF 解析、显式启用的 Sci-Hub 镜像 |
| browser | 独立准入的通用 Browser Agent |

每家服务在自己的 Provider 定义中声明阶段；是否需要凭据继续由独立的能力与认证合同决定。来源同阶段以配置顺序为基础，出版社 API 可按唯一名称候选稳定优先，不可用的已选来源必须保留稳定失败，不能静默移出耗尽集合。旧 `public / authorized-api` 认证分组兼容公开调用方，但不再决定五层优先级。

Direct 只消费受支持资产线索与明确稳定定位：供应商明确 PDF 媒体类型/主 PDF 角色，或 URL `pathname` 的大小写不敏感 `.pdf` 后缀可以形成候选；查询参数保留，阅读器 fragment 按网络边界移除。明确补充材料、其它资产角色或目标版本冲突的线索不能仅凭后缀进入主 PDF 获取。无后缀的明确 PDF 地址仍可使用，不扫描任意元数据 URL。已登记需要凭据的 API 地址仍由其适配器取得。

HTTP 类型和 URL 只提供线索，实际字节与统一 PDF reader 决定文件是否有效。任一层取得明确 locator 后立即由原适配器/共享下载器/Browser 获取，不重新排队到 direct；已取得有效 PDF 不重复 GET，本地发布失败保留候选。只有完整提交主 PDF 后，当前 Literature 才结束后续获取。

Planner 可以省略确定不适用的路线，前一层按 §7 保留错误、停止或独立 fallback 语义。显式 Browser 诊断不改变自动顺序，也不能被普通 Completion 隐式调用。

### 2. 先识别原文访问方，再形成运行时计划

Acquisition 在当前操作中加载静态、无 secret 的访问画像，并据此建立不持久化的运行对象：

```text
PublisherAccessProfile catalog（模块私有静态定义）
  -> PublisherAccessResolution（当前操作）
  -> AcquisitionPlan（当前操作）
  -> AccessRouteHint（当前操作）
```

`PublisherAccessProfile` 是无 secret 的静态访问画像，描述访问方和平台 identity、landing/asset origin、稳定文章 ID、公开路径、官方 API capability、正文/补充材料区分与政策证据。它不拥有 Browser 页面规则或下载脚本，也不等于 Metadata Provider 配置，不要求为纯 Browser 出版社创建 API 凭据 section。

Resolution 优先消费已有中性事实；只有本次出版社 API 规划确实缺少文章访问证据时，才执行有界 DOI 定位。定位可以先于出版社 API，但不提前执行公共网站的全部下载策略。初始 DOI 定位只读取受控 resolver 的安全 Location；后续 public-web 层可以通过共享 Network 逐跳访问网页与静态文件，Browser 使用自己的页面网络与平台准入。每次请求已有的实际 landing、状态和 locator 只在当前操作复用，不增加必经 HEAD/GET 预检。证据强度为：

DOI 定位只对 doi.org 发出一次 GET。首跳响应由当前操作保存并复用：实际 PDF 立即交统一下载验收和发布，成功后跳过剩余 API/网页；200 HTML、403/404、缺少可用 Location 或回到同一 DOI 的响应也不重复 GET，后续公共下载器消费原响应并沿原错误/静态解析规则处理。确认了不同且安全的 landing 才丢弃首跳缓存并改用该入口。响应字节预算复用公开 PDF 的默认 64 MiB 上限，状态或敏感响应不进入长期事实；即使已交付 PDF 带 Retry-After，已有字节可以验收，而共享 Network 冷却仍执行。

普通 HTTP landing 可以作为经准入的 Browser 入口；无凭据公共下载器仍只处理 HTTPS，不把 HTTP 地址交给 HTTPS 下载器触发内部类型错误，也不因此放宽网络协议或凭据策略。

```text
实际安全解析后的 DOI landing origin
> 访问方自有 AssetHint origin
> 来源明确的稳定文章 ID
> Provider record identity
> publisher text / DOI prefix 仅作待确认提示
```

已有明确 direct-file、公开仓储或稳定公开定位时不必为了识别出版社先请求 DOI。弱提示不能独自启用内容 API 或 Browser；多个强证据冲突时保持 unresolved 或稳定失败，不能按 catalog 顺序任选一个。

名称别名与 AI 辅助维护按 ADR 0014 §3.1 执行；原文保留，接纳的映射只提出访问方候选，不能独自证明文章适用性或授权。

名称解析唯一命中一个 Provider ID 时，只把当前 publisher-api 阶段中已选中的同名来源稳定排到前面；其余来源仍保持配置顺序，未知或冲突不改变优先级。此调整不删除来源、不自动启用服务，实际调用仍须通过 `authorizedTargets` 的文章级站点/专用标识证据。

Plan 将适用动作按五层分组并保持确定顺序。API、DOI landing 或页面步骤可以返回当前运行的脱敏 `AccessRouteHint`，例如 canonical landing、PII/EID 等稳定 ID 或可安全继续的 locator。Hint 不携带 Cookie、header、token、无法脱敏的签名 URL、vendor object 或页面对象，不进入 Catalog、ArtifactStore、provenance 或长期失败历史。

### 3. 单篇保持五层顺序，批量有界持续补位

2026-10-13 用户确认优化 Browser 吞吐，替代固定 chunk 与跨文章层级屏障：Entry 从一致 snapshot
冻结目标，由 `execution.max_concurrency` 个有界 worker 持续领取目标。完成一篇即可补入下一篇，
不等待一整块；没有占用执行槽的目标只保存冻结记录，不预先创建页面或无限量 Promise。

每篇依次完成 direct、publisher-api、general-api、public-web，仍未取得 PDF 且通过独立准入时
才进入 Browser。同一篇不跨层竞速，不跳过适用来源；不同文章可处于不同阶段。各自 Resolution、
Plan、实际响应与入口在单篇流程内保留，Provider quota 与平台准入始终由原 owner 执行。

单篇完成或失败立即通知；最终五分区 Report 仍按冻结顺序排列。已提交 PDF 可以继续自己的
Parsing/Analysis，普通单篇失败不阻止补位；取消、停止后续准入和共享完整性错误仍按原合同结算。
操作 ID 和 epoch 在一次执行内保持稳定；普通补位及串行的单目标恢复不使兄弟 Browser 会话过期。

既有显式 `acquireCohort` 接口保留前四层的批量阶段顺序，Browser 结果按单篇返回及时通知，最终
数组仍保持请求顺序。生产 Completion 使用单篇 `acquire`，不再依赖全员到齐的 participant coordinator。
后台下载继续释放模型 worker，但仍占用保留会话和真实平台网络资格；本地/模型/平台容量均不因补位放宽。

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

`production-ready` Browser runtime 表示政策证据、安全边界、生产对象图和离线验收已经
闭环，可以在保守政策下执行一次机构 IP 文章访问尝试；它不表示当前组织、当前 IP 或具体文章
已经获得访问权。Operator 通过普通配置中的 `[browser].enabled = true` 对整个受控 Browser 第五层
作一次显式启用。SciRetriever 不再保存或接受逐 Publisher 的本机“机器访问许可”占位声明：
这样的布尔值无法验证合同，也曾把实际可逐篇判断的机构 IP 路线错误挡在 Browser 启动之前。

启用只允许唯一 `browser:generic` route 进入逐文章检查，不会扩大许可范围，也不会改写
文章任务归属、实际平台准入、限速、Network 安全、Challenge 页面动作边界
或五层执行顺序。Operator 仍负责确保其使用符合组织授权和 Publisher 条款；程序以真实文章页
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

ADR 0023 修订后，Controlled Browser 作业只冻结一个 `AgentBrowserController`。首次模型请求前，程序可以按 §1 与 ADR 0023 整理的有限入口执行导航、观察与明确失败恢复；需要交互或程序不能确定时，再从当前统一
`BrowserObservation` 选择封闭动作。首次模型派发后不再后台自动换入口；不存在确定性规则 controller、Publisher selector/locator 程序
或失败 fallback。controller 与 CloakBrowser/Profile、Network guard、页面 capture 和 PDF 验收协作。
每个单次点击、navigation、capture settle 或 wait 保留有界保护；本次目标统一为 ADR 0023 的
300 秒累计活跃时间、30 次真实模型派发和至少 5 秒下一轮决策间隔；默认不设独立动作上限，保留动作统计。
全部初始入口、必要页面恢复与人工交还共享同一文章 clock，不重新取得整篇预算；换入口前结算真实在途 capture，已开始下载优先沿原传输完成。operation 与 transfer/session 总寿命独立计量，不增加累计 token/image 业务预算。此前离线
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

2026-10-12 根据用户确认的顺序获取目标，统一来源失败隔离，替代之前仅允许部分公共 HTTP 故障进入后续渠道的规则：

- `retryable` 只表示是否适合重试当前来源，不决定其它来源是否可以执行。HTTP/API 的请求、认证、权限、服务及响应格式错误只属于该来源；无可用 PDF、候选文件不可读或 URL 未通过网络准入只拒绝当前来源/候选。保留失败原因，继续所有独立且已配置的后续来源，最后进入已启用且独立准入的 Browser。
- API 无权限不证明当前机构 IP 的网页访问无权限，DOI 定位失败也不阻止直接用 DOI 查询其它服务。Browser 仍独立判断文章页，不能继承 API 的失败来宣称全文权限。
- `429`、quota 和 `Retry-After` 停止当前来源的剩余候选并执行该服务的冷却；其它独立服务可以继续。共享 Network 及 Browser 平台准入仍在每次请求前执行，不能借切换来源、入口或标签页绕过同一额度组/平台的限制。普通 5xx 的退避与服务明确限流继续分别记录。
- 成功下载的字节即使带有 Retry-After 也可以继续本地检查和发布，无需再发请求。候选验收保留最低 PDF 文件检查与当前任务关联，不恢复下载阶段的文章内容身份校验。
- 取消、数据库/文件系统故障、发布/receipt 冲突和未识别的内部合同异常仍保留其原始身份并停止相关执行。适配器必须在外部响应边界把可识别的协议/格式错误转换为来源失败，不能把任意内部异常一律吞成未命中。
- 人工协助策略在自动渠道尝试结束后应用，不能在某一层失败时提前阻止后续层。所有渠道未交付时保留未解决故障；来源未配置、限流或响应失败不能伪装成正常耗尽。后续渠道成功则发布该 PDF，不重复前面的失败来源。若 Browser Agent 按 ADR 0023 返回明确的两类主动停止判断，最终报告保留其失败码和说明；较早来源错误仍留在各自诊断中。

公共 HTTP `403`、实际返回 HTML 且静态链接不能交付 PDF、明确的有界重定向上限等仍可记录为 `http-route-unavailable`。这种能力判断不证明机构无版权；静态解析与 Browser 都使用通用规则，不新增出版社专用页面分支。

Browser 的 `LOGIN_REQUIRED`、`MFA_REQUIRED`、`RATE_LIMITED`、`IP_BLOCKED` 或账号警告暂停或熔断对应风险组；其它独立 Provider 继续。Challenge 只是统一 Observation 的 `page_state=CHALLENGE`，不是文章默认终态，也不拥有 interaction-required/active/exhausted 生命周期、专属 target、controller 或预算。通用 Agent controller 使用与普通页面相同的六种封闭动作。页面自动或经动作清除 Challenge 后继续 capture、entitlement 与 PDF 检查；controller 停止且页面仍为 Challenge 时，Acquisition 可以形成稳定 `challenge-unresolved` 结果。本地资源策略缺口必须报告为 Network 资源阻断，不能冒充用户无权限或 Agent 失败。

Browser 当前尝试中的裸 HTTP `403` 在没有更具体页面证据时稳定分类为文章级 `ACCESS_DENIED`，停止当前尝试但不据此推断“无订阅权限”、Challenge 或打开整个 Publisher circuit。只有明确 paywall/购买访问页面才分类为 `NOT_ENTITLED`；只有 Publisher profile 通过经审查 marker/resource/frame 事实识别出 Challenge 或 IP block 时才进入对应页面状态。登录、机构选择和 MFA 是自动流程识别后停止的页面状态。自动策略只能保持或降低速率，不能因连续成功自动提速，也不能通过新 Literature、重试或备用入口绕过 circuit。

只有所有适用 routes 正常结束且不存在 deferred、action-required、未解决 route failure、配置/Port/清理/发布/stale 错误时，Acquisition 才能提交 `AutomaticPdfAcquisitionExhaustion` 并返回 `NoPrimaryPdf`。

### 8. 运行状态不成为文献事实

Resolution、Plan、route hints、tried keys、Browser queue、runtime health、登录/MFA/challenge 页面状态、`next_allowed_at`、`blocked_until`、circuit 和候选失败只服务当前操作。它们可以形成脱敏实时进度；需要用户处理或延期的目标只通过现有 `DatabaseCompletionReport.failed` 中稳定的 `code/reason/action/retryable` 表达，不新增 Report 分区、自由 `details` 或第二套 counts。它们不形成 Literature 状态、数据库表、Artifact、provenance、可恢复任务或跨运行失败历史。

进程退出后不恢复这些动态状态；仍遵守 ADR 0012 的非跨进程限速保证。静态 `PublisherAccessProfile`、官方政策、operator 收紧配置和选中的 Browser Profile 身份可以持久加载。Chrome 自己管理的认证状态只留在 owner-only Profile 中；Browser process/context、临时下载目录、当次计数、队列、runtime health 和 circuit 都不跨操作保留，也不进入文献数据库。

## 后果

- 五层顺序与独立认证边界继续保护用户的机构网络访问和供应商风控边界，Browser 不成为默认大批量入口。
- Publisher recognition 为公开、API 和 Browser 共享，但识别本身不会启动 Browser。
- 批次低风险层先消化目标，Browser 只处理最小剩余集合。
- API 取得的 locator/稳定 ID 可以降低 Browser 导航和无效点击，但不会污染数据库。
- 不同实际平台的 Browser 文章可以并行；同一平台网络活动始终串行并服从自己的政策。
- 所有文章复用一个用户/机构身份 Profile 和一个 CloakBrowser process/context；Profile 不按 Provider 拆分，也不因命令结束而删除。
- Browser 总开关只启用已审查 route 的逐文章 Profile/IP 尝试，不把本地 Profile 或会话状态冒充组织或文章权限证明。
- 一个 Provider 的页面状态、限速或熔断不会无关阻塞其它 Provider。
- 新 Provider API 需有本地定义、政策、文章级适用证据与离线验证；Browser 对有合法起点的未知站点继续使用通用执行器，不要求预先建立 Publisher 页面规则。
- Browser 会比公开/API 慢，CLI 和 Report 必须把等待、停止原因和下一步清楚呈现。
- Requirements R3 的二值结果、最低 PDF 检查、不可变发布、唯一主 PDF 和耗尽边界不改变，不需要新增持久 schema。

## 不采用的方案

- 所有论文默认 Browser-first；
- 识别出 Publisher 后自动跳过仍适用的公开/API 路线；
- 每篇 Literature 私建 limiter、Browser process 或 session；
- 每个 Publisher 各自维护一套身份 Profile、Cookie 和 Chrome process；
- 每次命令使用并删除临时 Profile，使已授权的浏览器状态无法复用；
- 所有 Provider Browser 全局串行；
- 同一实际平台多文章网络活动并发；
- 固定一个数字冒充所有 Provider 的官方 Browser 间隔；
- 用逐 Publisher 的本地布尔值冒充合同或文章访问权，并在真实页面检查前阻断 route；
- 未经 Browser 总开关、runtime readiness 与调度准入就构造可执行 Browser adapter；
- 通过切换来源或 Browser 入口绕过同一服务/平台的限流；
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
