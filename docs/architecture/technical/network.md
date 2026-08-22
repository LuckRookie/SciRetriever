# Network 模块技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 设计责任：[设计文档 5.3](../design.md#53-网络基础设施)
- 长期决策：[ADR 0012](../decisions/0012-process-local-provider-access-scheduling.md)
- Provider 与凭据：[ADR 0014](../decisions/0014-capability-scoped-providers-and-local-credentials.md)、[Configuration 技术文档](configuration.md)
- PDF 路由与 Browser 调度：[ADR 0015](../decisions/0015-publisher-aware-tiered-pdf-acquisition.md)
- 固定身份 runtime 与 challenge：[ADR 0016](../decisions/0016-cloakbrowser-fixed-identity-runtime.md)
- 受控 Browser Agent：[ADR 0017](../decisions/0017-shared-agents-and-controlled-browser-agent.md)
- 外部事实：[Provider 注意事项](../../notes/providers/README.md)

本文定义目标 `src/sciretriever/network/` 的共享访问政策、进程内供应商级准入、安全 HTTP 和受控浏览器实现。Network 负责协议无关的安全访问与限速执行，不理解供应商业务协议，也不判断文献身份、PDF 归属或文献状态。

## 1. 目标结构

```text
network/
  policy.py
  admission.py
  http.py
  browser.py
  browser_sessions.py
  browser_connect.py
  browser_control.py
  cloakbrowser.py
```

- `policy.py` 形成 URL、DNS、redirect、origin、credential forwarding、资源预算和脱敏决定；
- `admission.py` 定义 AccessScope、规范化访问政策和进程内共享 Access Coordinator；
- `http.py` 执行同时符合 policy 与 admission 的普通 HTTP 请求；
- `browser.py` 执行符合相同边界、带 Provider rule guard 的隔离浏览器操作；
- `browser_control.py` 生成有界 Agent 页面 observation，并把封闭动作解析到当前 page/revision；
- `browser_sessions.py` 在一个共享 persistent context 中按无 secret 的 Publisher lane identity
  管理组内串行、跨组并行和文章级事件隔离；
- `browser_connect.py` 管理无 GUI Linux 的进程内 Xvfb display lease，以及只做精确 IP pinning
  和加密字节透传的 loopback CONNECT proxy；
- `cloakbrowser.py` 通过 Playwright API 驱动真实有头 CloakBrowser patched Chromium，并让所有
  已批准 HTTP(S) 请求继续由浏览器原生网络栈执行；CloakBrowser/Playwright vendor 类型不越过该边界。

HTTP 与 Browser 是平级能力。Browser 不是 HTTP transport 的特殊模式；Acquisition 决定公开来源、授权 Provider API 和受控浏览器的业务阶段，Network 只决定真实访问何时可以安全执行。

## 2. 共享访问政策

`policy.py` 负责：

- URL 解析与规范化；
- 允许的 scheme、port 和 userinfo；
- DNS 解析结果与公网、私网、loopback、link-local 等地址分类；
- 每次 redirect 的目标复检；
- origin 变化和 credential forwarding 决定；
- URL、query、header、错误详情和凭据脱敏；
- 响应大小、导航数量、下载数量和总访问预算。

Policy 不理解 Crossref、arXiv、Semantic Scholar、出版社页面、MinerU 或具体 LLM 的字段和状态码语义。Provider pagination、quota 含义、`429` 解释、页面 selector 和服务轮询属于对应 adapter。

URL 校验不能只发生在第一次请求。DNS 结果、每跳 redirect、浏览器顶层导航、popup 和最终下载地址都必须重新满足相同边界；无法形成等价安全判断时 fail closed。

## 3. AccessScope 与访问政策

每个生产 adapter 在发起外部操作前声明一个稳定运行范围：

```text
AccessScope
  provider_name: str
  channel: "api" | "web"
  service_name: str | None
```

- `provider_name` 是稳定、非空、无凭据的 provider/service identity；
- `channel = "api"` 表示由供应商 API 政策控制的请求；
- `channel = "web"` 表示普通网页、站内直接文件或受控浏览器流程；
- `service_name` 只在供应商明确具有独立 API 产品或额度池时区分。

共享同一 key、账户、官方 quota 或额度响应头的 metadata search、metadata reference query 和 PDF API 必须声明同一 scope。独立产品只有在外部政策明确分开时才能拆分。Scope 不使用 DOI、Literature ID、完整 URL、凭据值、用户身份或随机任务 ID，避免把同一供应商预算错误拆散。

Adapter 还声明规范化 `AccessPolicy`。政策至少能够表达：

- 最大活动并发；
- 最小启动间隔；
- 完成后的冷却间隔；
- burst/window request quota；
- 已知周期额度及其重置边界；
- 动态 `Retry-After` 或额度反馈形成的 `blocked_until`。

供应商官方政策、项目安全下限、operator 收紧配置和运行时响应反馈同时适用时执行最严格组合：并发和可用额度取更小值，间隔、冷却和阻塞截止取更大值。普通配置不能放宽官方约束或 ADR 0012 的网页安全下限。缺少可执行政策的 production adapter readiness 失败，不能退化为无限制访问。

Browser 在普通 provider/host admission 之外使用 Acquisition Profile 声明的中性范围：

```text
BrowserAccessScope
  rate_limit_group: str
  session_key: str
```

`rate_limit_group` 合并共享网页规则、quota 或风控的访问方；`session_key` 标识共享 context 中的
Publisher lane 和组内互斥范围，不再决定独立 context/Profile。两者不携带 Cookie、用户登录名、
机构身份、DOI、完整 URL 或任务 ID。不同 group 可以并行，同一 group 的 policy 固定
`max_concurrency = 1`；普通配置仍只能收紧。

具体 provider 数字及核对日期不在本文件复制，由 `docs/notes/providers/<provider>.md` 或对应外部服务 Notes 维护。Adapter 的静态 policy 与 Notes 必须能够互相追溯。

## 4. 进程内 Access Coordinator

`admission.py` 在真实访问边界执行以下流程：

```text
adapter 声明 provider/channel/service scope 与允许 origin
  -> Access Coordinator 合并静态政策、operator 收紧和运行时阻塞
  -> 等待并取得 provider scope permit
  -> 按实际连接或导航目标取得 host permit
  -> HTTP / Browser 执行
  -> adapter 解释 Retry-After、quota 和 provider 错误
  -> Coordinator 更新 blocked_until / quota state
  -> 清理响应、页面和临时资源
  -> 释放 permit 并记录必要冷却
```

`sciretriever.bootstrap` 对每个 SciRetriever 进程只构造一个共享 Coordinator，并把它注入 HTTP 和 Browser。当前进程中的 Metadata、Acquisition、Parsing、Analysis、不同 Literature 和不同用户操作不能获得互不知情的 limiter。

Coordinator 的逻辑 scope 状态与精确 host 状态同时生效：

- 同一 provider 的多个允许 origin 共享 provider scope；
- 不同 provider 的候选最终落到同一 host 时共享 host budget；
- redirect 到新 host 前必须先通过目标 policy 与目标 host admission；
- 未知普通网页按规范化 host 建立保守 `web` scope；其具体默认 policy 必须明确标注为项目审慎值，不能冒充供应商官方规则；未知站点不因此获得 production Browser Profile；
- 公开、OA 或 direct 声明不构成网页限速豁免。

等待 permit 是可取消的资源等待，不是 provider 失败、`NoPrimaryPdf`、Literature 状态或数据库补全状态。调用方 deadline 到达时可以结束当前操作；只要当前进程仍在运行，取消、失败或重新发起同一操作就不能绕过已经形成的冷却或 `blocked_until`。

## 5. 内存状态与非持久化边界

Coordinator 的动态状态只在当前 SciRetriever 进程内存中共享。它至少包括：

```text
等待队列和活动 permit
provider/channel/service 与 host 的并发状态
next_allowed_at
blocked_until
窗口额度计数和重置时间
当前 Retry-After 与有界退避
Browser risk group 的连续 runtime failure 计数与 circuit reason
```

这些值不得携带 DOI、Literature ID、candidate key、完整 URL、header、Cookie、secret reference/value、响应正文、底层异常或逐请求失败。它们不进入业务 Model、SQLite Catalog、ArtifactStore、provenance、日志合同或独立协调文件。Network 不创建限速表、协调数据库、协调目录、跨进程 advisory lock、lease marker 或可恢复的 rate-limit 现场。

进程退出或崩溃后，全部动态限速状态自然消失；新进程从静态访问政策和 operator 配置重新建立 Coordinator，不延续旧进程的网页冷却、`blocked_until` 或 API 窗口。多个并发 SciRetriever 进程各自限速，当前产品不提供跨进程、跨重启或跨机器的供应商额度协调。Storage 为保护同一 Catalog 而使用的核心写入 advisory lock 是独立的数据库完整性机制，不属于 Network。

静态访问政策、Browser Profile policy、API 规则和 operator 收紧值仍由 adapter/Profile、配置与 Provider Notes 持久表达；“规则持久化”不等于“动态计数和截止时间持久化”。Network 不拥有数据库补全编排，也不参与文献事实写入。

## 6. 网页访问规则

普通 HTTP landing-page discovery、出版社站内 direct PDF 和 Browser 都先取得对应 provider `web` scope 与实际 host permit。公开、OA 或 direct 声明不构成网页限速豁免；共享网页政策或 host 的访问仍共享真实准入。

Browser 再取得 Profile 的 `BrowserAccessScope`。同一 risk group 固定满足：

```text
max_concurrency = 1
provider-declared article interval/window/cooldown
provider-declared rate-limit cooldown / runtime-failure threshold
```

不同 risk group 可以并行运行各自一个文章流程；同一 group 内限速串行。全局 Browser concurrency 只保护本机 process/context 资源，不作为所有 Provider 共用的业务锁。Provider 的具体间隔、window、cooldown 与证据日期属于 Profile/Notes；没有可执行政策的 Profile 不进入 production，不再硬编码一个适用于所有 Provider 的固定 30 秒。

Browser permit 从 canonical landing 第一次导航前持有到 page、popup/viewer、response/download、TemporaryPdf 交付和临时资源完整清理。成功、无结果、页面失败、timeout、取消、challenge 和重试都不能绕过对应 `next_allowed_at`、`blocked_until` 或 circuit。页面加载会产生多项子资源请求；文章 permit 覆盖完整高层流程，Network 另以资源预算限制请求、导航、popup、下载和总时长。页面脚本、selector fallback、多个标签页或重建 context 不能取得同组第二个并行 permit。

同一 provider 的 API 使用独立、按官方 quota identity 形成的 `api` scope，因此 Browser 流程占用或冷却期间，独立 API 产品可以继续按其真实政策运行。其它 Browser risk group、provider 和公开仓储也使用自己的 scope，不被无关组阻塞。

## 7. API 访问规则

API adapter 根据当前官方政策和产品 entitlement 声明 quota identity、并发、间隔、burst/window、周期/日额度和 reset boundary。API 不继承 Browser 文章间隔，也不能默认无限制。API key 已配置、认证成功、quota 可用和目标内容 entitlement 分别判断。

Adapter 负责把 `429`、`Retry-After`、额度响应头和供应商专属错误转换成中性 policy feedback；Coordinator 把 feedback 应用于当前进程的共享 scope。`Retry-After` 或明确额度耗尽在当前进程的所有 Metadata/Acquisition 调用方之间共同生效。没有 `Retry-After` 时采用 adapter 规定的有界保守退避，不能立即高频重试。

Vendor SDK 只有能够注入受 Coordinator 约束的 transport 时才能使用；内部自行联网且无法复用准入、安全 redirect 和脱敏政策的 SDK 不能成为生产 adapter。

## 8. HTTP 实现

`http.py` 负责：

- 在连接前取得适用 provider 与 host permit；
- HTTPS 与 TLS 校验；
- DNS 结果约束和连接目标一致性；
- 连接池与 session 生命周期；
- 逐跳 redirect policy 与 admission 复检；
- connect/read/overall timeout；
- 有界流式读取；
- 协议无关且幂等的连接级重试；
- 取消后的连接、permit 和响应清理。

HTTP 返回中性访问结果，不把 client response 类型暴露给消费模块。API pagination、provider quota 解释、MinerU polling、LLM retry 和候选业务重试不进入 HTTP 层。

无 credential header/query 的请求在 Debug 中只记录安全 `AccessScope`、method、最终 status/response bytes 或中性失败，以及从请求开始到终态的单调时钟耗时；不记录 URL、host、query、header、response body 或原始异常。携带凭据的请求在 Network logger 上完全静默，由上层 adapter 记录不含 endpoint/credential/response 的 provider 语义步骤。日志关闭或失败不能改变 admission、transport 或返回值。

普通 URL 和普通 redirect 始终拒绝 percent-encoded path separator。若已核实的 Provider
API 返回把签名 locator 编码在单个 path segment 中，adapter 必须同时提供精确
redirect-target guard 并显式启用 guarded opaque-path 模式；guard 在目标 DNS 和 transport
之前限制 HTTPS origin、port、固定 path prefix、query/fragment 与 locator 形状，Network
仍执行 raw path/traversal、percent/UTF-8、DNS、地址类别、重绑定、host admission 和资源
预算检查，但不对 Provider 签发的 opaque segment 做多层解码后再猜测 path 语义。该模式
不会扩大普通 redirect，跨 origin 时也不会转发 credential。

## 9. 浏览器实现

`browser_sessions.py` 提供进程内 `BrowserSessionBroker`，为当前生产对象图持有一个共享 CloakBrowser Chromium
process 和一个 persistent BrowserContext，同时按稳定的 `browser_session_key` 建立 Publisher
lane lock。同一 key 的 lease 严格串行，不同 key 可以并行，但不创建独立 Browser 身份或
context；每个 lease 只覆盖一篇文章。共享 runtime 首次创建时 process 与 context 必须分别按
对象身份确认 Network 提供的连接绑定，之后每篇文章通过
`begin_article(lane_key, downloads_path, connection_binding)`/`end_article()` 协议建立独立 article
token、切换临时下载目录、确认连接绑定并排空晚到事件。Broker 只在共享 context 安装一次封闭
route/event dispatcher；事件按 article token 分流，文章 lease 结束后晚到 route 会被终止，晚到
page/download 会被关闭或删除，不能落入另一个 Publisher/文章的 handler。

`BrowserClient` 可以注入 broker，并要求每次 `run` 同时提供经过 Network 校验的 session key；
没有 broker 的一次性 session 仍用于通用 Network 离线 fixture。Broker 模式在当前对象图内复用
唯一 process/context，但仍为每篇文章建立独立 `_FlowState`、article context、page、临时目录、
预算、DNS/host lease 和中性结果。页面、下载、请求 lease 和文章临时目录全部清理且 runtime
确认排空后，才释放 lane lease；runtime、timeout、cancel 或文章清理异常会标记共享 runtime 在
活动 lane 排空后淘汰，不能中断其它正在工作的 Publisher lane；下一次 acquire 再创建 runtime。
Broker 关闭会关闭共享 context/process 和 owner-only 临时下载目录，但不删除持久 Profile。
Shared entry 的关闭结果具有粘性：首次关闭失败后，重复 `close`/lease release 只返回同一失败，
不会再次调用 vendor close，也不会把失败改写成成功。文章 handler 已撤下后的 late route 必须
abort，late page/download 必须各关闭或删除一次；该动作失败会把 shared runtime 标记为 broken，
活动 lane 排空后淘汰并传播 cleanup failure，不能复用、吞错或在 broken entry 上自旋。

生产对象图接收 Configuration 边界解析出的 opaque `BrowserProfileHandle`，不接收任意路径、
Cookie 或认证内容。CloakBrowser 启动前从 handle 取得跨进程独占 runtime lease，并将其中的固定
owner-only 目录作为 `launch_persistent_context` 的 user-data directory；同一 Profile 同时只能由
一个 Browser process 使用。handle 同时提供不暴露 seed 原值的固定 identity manifest，使同一
Profile 跨冷启动复用 native Linux persona、locale/timezone、screen 和 Browser version policy；
Network 不读取 `credentials.toml`、Cookie 或其它 Profile 文件内容，也不导入、
导出、复制或显示 Cookie、local storage、账号或机构身份。page/context/process、Profile path、
Cookie 和 vendor event 对象都不能越过 Configuration/Network/Acquisition 边界。runtime 关闭后
释放 Profile lease，Profile 字节继续由 CloakBrowser Chromium 管理并跨命令保留；删除只由 Configuration 的
显式用户动作拥有。

Binary runtime lease 与 Profile lease 分离。Configuration 在持有已验证 binary 的共享锁期间，
为每次 Browser runtime 建立系统临时目录中的 owner-only sterile cache view；其中只有指向当前
已验证 `chromium-<fixed-version>` bundle 的定位项，没有 `license.key`、license cache、Pro/latest
marker、update 状态或其它版本。Network 只把该 view 和 manifest 中的精确版本传给 wrapper，
同时删除 ambient `CLOAKBROWSER_*`/proxy 环境控制；context/process 关闭后先删除 view，再释放
binary lease。长期 runtime root 从不直接暴露给 vendor launch，普通 Completion 因而不能通过
cache-file credential 改变 binary、触发 license 验证或下载其它版本。

Broker 的 Debug 诊断只使用经过校验的安全 session key，明确 acquire 的 `session_reused=true|false`、article drain、release/invalidate/retire 和 broker cleanup outcome 与耗时；绝不记录 profile 路径或内容。外层 `BrowserGroupScheduler` 记录 provider group、匿名 attempt key、queue wait、Provider pacing wait、是否真正 attempted、article disposition/group feedback、耗时和 permit cleanup。不同 group 的这些记录可以交错，同一 group 的文章开始记录必须保持串行。

`browser.py` 对每个文章流程负责：

- 在 canonical landing 第一次导航前取得 provider `web` scope permit；当前文章第一次使用每个
  已批准 hostname 时取得一项实际 host permit，同篇文章对该 hostname 的 navigation、CSS、JS、
  图片和 PDF 请求复用它，并在文章资源完整清理后统一释放；整篇文章的 Publisher risk-group
  串行、文章启动间隔和 cooldown 由外层 `BrowserGroupScheduler` 拥有。host permit 继续在共享
  Coordinator 中阻止其它 API/Browser 流程并发抢占同一 host，但不会在 Playwright 的单一事件
  线程中让同页第二个子请求等待第一个 response 事件而自锁，也不会把文章间隔错误套到每个
  CSS/JS/PDF 子请求上；
- 复用当前对象图的共享 persistent context，并只管理当前 article token 下的 page、popup/viewer、
  response/download 与临时资源；
- 对 Playwright 在请求继续前暴露的 navigation、页面 request、popup、viewer 与 download，先执行 Acquisition Profile 提供的封闭 Provider guard，再执行 Network 通用 URL、DNS、地址类别、origin、credential forwarding、host admission 和资源预算检查；未再次暴露 request 的 native redirect 只能按下文同页 live-proof 规则关联，并在读取 terminal body 前完成最终目标复检与 host admission；
- 在 Profile 允许的范围内捕获 download event、PDF response、合法 popup/viewer 或已核实 locator，并只交付统一 `TemporaryPdf`；
- 对请求数、顶层导航数、popup、download、去重后捕获候选数、响应字节和文章流程总时长执行有界预算；
- 在成功、正常未命中、失败、取消、timeout 或清理异常后关闭全部文章资源，释放 permit，并保留仍有效的 `next_allowed_at`、`blocked_until` 与 circuit。

每个文章 `_FlowState` 的资源生命周期固定为 `active -> cleaning -> cleaned | cleanup-failed`。
page、popup、download、可关闭 response stream、文章临时目录、host/scope permit 和 runtime task
在进入文章清理时先转移一次所有权；共享 context/process/Profile lease 由 Broker/Playwright
runtime 独立拥有，文章清理不能关闭仍被其它 lane 使用的共享资源。每项文章资源释放最多调用
一次，第一次失败作为粘性结果保留，同时继续尝试其它资源。普通 Playwright
`response.body()` 返回完整 bytes 时不存在越过读取调用的
独立 stream；私有 runtime 若返回 closable stream，Network 只做带上限的单次 `read(size)`，并在
`finally` 中关闭，stream 不进入中性结果或 Provider 合同。

Browser factory、process enter、context/page 创建、导航、页面动作和 body 读取都在可取消 runtime
task 中运行。取消或文章 deadline 到达后先发送非占有式 `abort/cancel/stop`；task 必须在显式的
本机 cleanup timeout 内确认停止。这个 timeout 只保护本机 thread/process/file descriptor 回收，
不是 Provider 请求间隔、quota 或可配置的提速值。未及时确认时调用立即失效全部 late result，
升级到 page/context/process close，继续清理其余资源并返回稳定 cleanup failure；daemon worker
不能把晚到 response/download 重新变成候选。被拒绝的 route 只有在 runtime 确认 abort 后才能
立即释放其 host permit；abort 未确认时必须把 permit 保留到 context/process teardown 完成，避免
仍可能存活的 transport 脱离准入边界。

Provider 专属 origin、selector、有限动作、正文/补充材料判别和页面 marker 位于 Acquisition
的版本化 access profile/Browser route adapter，不进入 Network。规则只能表达经过静态验证
的有限 observe/click/wait/capture 动作；Network 不执行任意 JavaScript、selector guessing、
自动登录、机构选择、MFA/CAPTCHA 或运行时指纹脚本。CloakBrowser 的固定身份和 humanized 输入
属于 adapter/runtime，不形成 Publisher 规则动作。Profile guard 不能放宽通用 Network policy，
规则外目标必须在 DNS 或 transport 前 fail closed；未知 Provider 不获得 generic Browser
fallback。

当前封闭 action contract 把页面观察/marker 分类作为每个动作前后的固定步骤；规则本身只保存
有序 `BrowserRuleAction`，kind 限于静态 selector click、打开已核实 viewer、打开已核实官方
locator 和等待一个明确 `BrowserCaptureKind`。每条规则显式保存不超过全局上限 8 的
`max_actions`，动作数量、顺序、静态参数、rule revision、origin、marker 与 capture prefix
全部进入稳定 fingerprint。空动作序列表示只观察；selector 不能包含脚本、XPath/text/role
表达式、远程 URL 或动态模板，open action 只能使用本 rule allowlist 中且命中已审查 capture
prefix 的 query-free HTTPS locator。生产 `CLICK` 最多等待 10 秒使 selector 成为可操作元素，返回
`performed | not-actionable`；后者是当前静态动作没有可执行目标的正常未命中，不是 runtime 或文章
timeout。点击使用当前 DOM 中第一个可见匹配元素，并不等待点击触发的导航完成；后续导航、response
与 download 仍由受控事件状态机接管。每个显式 capture wait 同样只有 10 秒局部 settle budget，
局部未捕获后正常继续分类，只有整篇 60 秒 deadline 到期才是 `timeout`。这些局部预算不使用
Provider 固定 sleep，也不改变 Provider 文章间隔。该 Port 不暴露任意
navigate/open-popup/fill/evaluate、page、context 或 vendor event。

当前 production Acquisition Browser budget 固定为：4 次顶层 navigation、256 个受控 request、
2 个 popup、4 个 download、4 个去重 capture、单 PDF 与整篇捕获字节各 64 MiB、单次 action wait
10 秒、单次 capture wait 10 秒、整篇 60 秒。达到任一硬边界仍然 fail closed；Debug 的
`browser-budget-exceeded` 必须给出具体 `resource`、`used`、`limit` 和稳定 `code`，不能只留下
无法定位的笼统 budget failure。

正文归属规则同样是本地封闭合同。每条有捕获能力的规则必须声明至少一种文章身份检查：捕获
locator 与 canonical landing 完全一致、捕获 path 含 landing 的精确文件 stem，或捕获 path
包含指定 namespace 的稳定 `Identifier`（例如 DOI、PII、article ID）。规则另外声明已知
supplement URL prefix、supplement selector、supplement filename marker，以及 issue front
matter、广告等 excluded prefix/filename marker；这些字段和正文捕获优先级都进入 fingerprint。
Known supplement selector 不能同时成为 click action。Network 的 capture guard 在读取 body
前只准入同时满足正文 prefix、媒体线索和当前文章身份的 locator；supplement、excluded 和
wrong-article locator 不读取正文。Source 在形成候选前重复同一分类，防止不合规 runner 把
补充材料或错文注入主候选。只有 supplement 或排除项时形成正常 `no-download`，不会误发布。

截至当前实现，`browser.py` 已提供中性的 `BrowserDestinationGuard`：Controlled Browser
Source 对每篇文章注入一项只含当前规则 origin 与精确 resolver 起点的 guard。Network 在初始
导航、显式导航、redirect/页面请求、popup、response capture 和 download capture 分别标记
用途，并在 DNS、route continuation 或读取响应/下载字节前调用该 guard；传给 guard 的 locator
已经去除 query，规则外异常统一转换为 `policy` 失败。Response 的实际 transport 已由更早的
request guard、DNS binding 和 live host lease 准入，response hook 再在读取 body 前复核同一
lease。通用 URL/DNS/地址类别/host permit/资源预算仍独立执行，guard 只能收紧不能放宽。
正文捕获另有不可序列化的 `BrowserCaptureGuard`：Network 在读取 response body 或 download
bytes 前，把已经去除 query 的 locator、封闭 `BrowserCaptureKind` 和规范媒体类型交给当前
Provider 规则；规则拒绝或异常时不会读取正文。成功结果是非空 `BrowserCaptureBatch`，其中
每项只含 `DOWNLOAD`、`RESPONSE`、`POPUP`、`VIEWER` 或 `VERIFIED_LOCATOR`、一个
`BoundedByteStream` 和安全 locator，不含 response/download/page 等 vendor object。一次文章
流程最多捕获 `BrowserBudget.max_captures` 个不同字节候选；相同实际字节即使同时触发
response 与 download 也只交付一次，但全部实际读取字节仍计入总字节预算。Acquisition 对每项
捕获再次核对 Provider locator prefix 与媒体线索，并分别转换为 `TemporaryPdf`。

完成主导航后，Network 可以向当前 flow 提供不可序列化的 `BrowserPageObservation`：其中只有
再次通过 destination guard 的 query-free 规范 locator 和 `100..599` 范围内的主响应状态。
完整 URL query、response/header/body、page、context 和 Cookie 不跨越该边界。Marker 的 DOM
presence 使用非等待式计数；需要读取有界文本时，对同一静态 selector 的多个匹配按 DOM 顺序只取
第一个元素，避免 Playwright strict-locator 因正常页面存在多个 `title` 等节点而误报 runtime。
Network 不再扫描通用页面文本后把 challenge 当作 runtime abort。它只提供主状态、经过审查的
marker presence、frame/challenge-resource admitted/blocked、navigation 和 capture 等有界事实；
同一 `401/403` 在不同 Provider 可能表示登录、无文章 entitlement、paywall、通用拒绝或
challenge，必须由 Acquisition 的版本化 Provider marker 决定。

经 Profile 声明的 challenge dependency 只能由已批准 Publisher 顶层页面和当前 frame ancestry
发起，并继续执行 HTTPS/443、DNS/地址、CONNECT prebind、host admission、request/frame/字节和
总时长预算。它不能成为顶层初始导航、popup、PDF locator 或 capture source。Network 对资源和
页面事实使用 `resource-loading | settling | cleared | interaction-required | resource-blocked |
settle-timeout | failed` 的运行生命周期；只有 terminal 状态结束文章，`cleared` 回到普通页面
流程。Acquisition 唯一把这些事实解释成用户 failure 和 Publisher circuit feedback。

页面正常未命中且 Acquisition 允许 Agent fallback 时，`browser_control.py` 从同一 page 生成
request-local `BrowserAgentObservation`：page revision、query-free origin/path、status、硬上限
viewport screenshot、有限可见元素 role/name/state/短期 element ID、capture 状态和剩余预算。
Agent 决定只能映射为 `ClickElement`、`ScrollPage`、`WaitForPage` 或 `StopFlow`；revision 过期、
元素不可见/disabled、越界滚动/等待和未知动作在 vendor 调用前拒绝。实际动作始终通过同一
CloakBrowser humanized Page/Locator 执行，不创建第二 context、CDP client 或任意脚本入口。
`browser_scheduler.py` 已把每个静态 risk-group policy 固定为 `max_concurrency = 1`，并执行
文章启动间隔、可选滑动窗口、完成冷却和失败冷却；同一 scheduler 中不同 group 受独立锁
保护并在本机全局资源上限内并行。Scheduler callback 的边界是一篇完整文章流程，只有 callback
返回（或抛错）后才记录完成/失败冷却并释放组锁；等待取消不会取得或误释放另一流程的 permit。
同一进程同一 group 只能注册一份完全一致的 policy revision，避免通过别名或新 operation
重建限速状态。

同一个 scheduler 现在也是 Browser risk group 动态状态的唯一进程内所有者。每个 Profile 必须
显式声明正数 `rate_limit_cooldown` 与 `runtime_failure_threshold`，不能从全局隐藏默认值取得；
operator 收紧时前者只能取更长值，后者只能取更小值。文章 callback 完整返回后，封闭的
`BrowserGroupFeedback` 原子更新对应 group：rate-limit 把 `blocked_until` 至少推进到声明的
cooldown，登录、MFA、challenge、IP block 和账号警告打开带封闭原因的 action-required
circuit；资源清理未确认或失败会立即打开 cleanup circuit，不能等待普通 runtime failure 阈值后
让下一篇文章与未确认停止的旧流程重叠；连续 Browser runtime failure 达到声明阈值后打开
runtime circuit。正常成功只清除
连续 runtime failure 计数，不缩短 `next_allowed_at`、`blocked_until`，也不关闭 circuit。

每篇文章在取得本机全局 Browser permit 和调用 callback 之前都重新读取该 group 状态。仍在
`blocked_until` 内的任务返回 `deferred`，open circuit 返回 `action-required`；这条路径不调用
Browser adapter，因此同批排队任务、新 Literature、不同 route key 或备用入口都不能再次触网。
其它 group 仍由独立 worker 继续。rate-limit 到期后按 monotonic clock 自动恢复；action-required
circuit 只能由持有精确 group 与 policy revision 的显式 `acknowledge_circuit()` 关闭，且该操作
不清除仍有效的 cooldown。动态 snapshot 仅含稳定 group、revision、时钟截止、连续计数和封闭
原因，并与 scheduler 一起拒绝序列化；不含 URL、selector、Cookie、Token 或文献标识。

生产 Controlled Browser 仍保持 fail closed：Bootstrap 已把共享 session broker、scheduler、
admission controller 和 cohort executor 接入完整及 capability-scoped Completion 对象图，运行
状态机、封闭页面 marker、多路正文捕获、封闭 action contract、supplement/错文排除、Provider
cooldown/circuit 和确定性取消/资源清理都已验收。
`network/cloakbrowser.py` 是唯一正式 adapter：它在一个 Profile-backed shared runtime 的专用
engine thread 上通过 Playwright API 驱动有头 CloakBrowser patched Chromium persistent context，
固定使用 `headless = false` 和 Profile identity manifest 中的 seed/persona。无 GUI Linux 由
`browser_connect.py` 的 Xvfb lease 提供虚拟显示；共享 runtime 关闭后停止 display。Python wrapper
可以进入 wheel，vendor Chromium binary 由 Configuration 显式安装、锁定版本和校验，不进入 wheel、
普通 Completion 或隐式更新。不存在系统 Google Chrome/Playwright Chromium 的生产 fallback。
Profile 的独占 runtime lease 与 Cloak process/context 同生命周期，关闭后释放但不删除 Profile。

第一版使用 native Linux persona，并把 locale、languages、timezone、screen/window、WebGL、字体和
Browser version 作为同一身份快照验收。CloakBrowser `humanize=True` 是所有生产 click、scroll、
wait 和允许输入的唯一执行路径；静态规则与 Agent 都不能用 ElementHandle、直接 DOM click、另一个
CDP client 或任意页面脚本绕过。候选明确使用 `service_workers="block"`：Playwright route 无法保证
观察 Service Worker 接管的请求，而 CONNECT 透传 TLS，不能补证加密流量内的 path、resource type、
frame ancestry 或 capture source。launch flag 与 Profile preference 必须逐项有证据，不能无条件
复制 stock launcher 的历史参数。

每个 CloakBrowser Chromium HTTP(S) request 先被 Playwright route 暂停。`BrowserClient` 在 route 继续前依次执行
Provider destination guard、通用 URL/地址类别检查、DNS 解析、host admission 与请求预算，并形成
hostname/port 到精确已批准 IP 的一次连接 binding。`_Route.bind_connection()` 只把该 binding
登记到 loopback proxy，随后 `route.continue_()` 让请求回到 Chromium 原生网络栈。Proxy 对 HTTPS
只接受已登记 authority 的 `CONNECT`，连接指定 IP 后透传加密字节；它不终止 TLS、不读取 HTTPS
header/body、不生成证书，Host authority、TLS SNI、HTTP 协议、Cookie 与连接行为仍由 Chromium
完成。HTTP 也只转发已登记的精确目标。未登记、过期或与当前 article generation 不符的连接
fail closed。

这两个边界提供不同证据：Playwright route 在 transport 前检查 query-free URL、reviewed path、
resource/frame 上下文、文章归属和 capture 用途；CONNECT 只把已经批准的 authority 绑定到已解析
IP/port，并在整个文章生命周期维持 host permit 和字节上限。不能用后一层的 origin 许可替代前一层
的请求语义检查，也不能允许 route 不可见的 Service Worker 流量仅凭 CONNECT 放行。

Chromium 原生处理服务器 redirect、页面脚本导航、popup、Cookie 和点击，因此不需要 Python 合成
`3xx`、替换页面或实现另一套 HTTP 客户端。显式导航和 Playwright 暴露的 request 仍逐项进入
route 审查。Chromium 对 native redirect 的后续成员有时不再次触发 route；这时 response 只能复用
仍存活的同页祖先 request proof，且最终 origin 必须已经属于 Provider 的有限 origin 集、完成
DNS prebind，并在读取 terminal body 前取得或复用最终 host permit。跨 page、祖先已结束、redirect
链循环/超过 32 层或未预绑定 origin 一律 correlation failure，且不得读取 body。最终 response
locator 仍重新通过 Provider guard、URL/DNS 与 capture guard；未批准的第三方普通子资源可以按
规则丢弃，顶层导航与 PDF capture 仍 fail closed。

Provider 规则的 `CLICK` 使用第一个可见匹配元素执行真实 Playwright 点击，并设置
`no_wait_after=True`，避免把点击后的整段页面导航隐式塞进 locator 调用。规则仍只能提供经过静态
验证的有限 selector，不能填写表单、注入任意脚本或绕过新的目标审查。最终页面的 title、正文
challenge 文本与 selector marker 使用有界 DOM snapshot，不把 selector 或页面文本交付日志或
业务结果。challenge 文本最多在进程内读取 1 MiB。

完成初始 capture 与页面状态检查后，Playwright 可以从 citation metadata、正文/PDF anchor 和
iframe/embed/object 发现最多 16 个有界 locator。Network 在 DNS 前丢弃不属于预绑定 Provider
origin 的候选，重新执行 guard/policy，并按 query-free locator 去重；Acquisition 最多打开前 4
个候选，之后才运行 Provider 专属动作。运行时 URL 可以保留经过严格 wire-shape 校验的短期签名
query 并交给 Chromium，guard、DNS key、日志、capture locator、中性结果与 provenance 始终只使用
去除 query 的 URL。

Response handler 只在对应 intercepted request correlation 仍存活，且当前文章仍持有 route host
permit；native redirect 到另一批准 host 时还必须先取得该 terminal host permit，之后才读取已准入
PDF body。普通 HTML response 完成分类后可以立即结束单项 request correlation；host permit 不逐
请求释放，而是由整篇文章持有到 page/article context、未决 event、download 和临时资源清理全部确认完成。
这样 Playwright 的单一 engine thread 即使尚未派发第一个 response 事件，也能放行同页第二个已
批准同源子请求；原生 download 则通过 response reservation 保持 request correlation 到 download
event。
Cloak runtime 在取得独占 Profile lease 后原子合并 `always_open_pdf_externally=true` 与
`open_pdf_in_system_reader=false`；只拥有这两个字段，保留其它 Preferences，遇到矛盾值时 fail closed。
该选择会让 v146 把顶层 PDF 交给原生 Browser download/response 事件，而不是内置 viewer；固定身份
验收因此以整套受控 Profile policy 为基线，不把 plugin 数量单独冒充身份结论。普通顶层 inline PDF、
明确 attachment 和页面基于已准入 response 创建的本地 blob download 都只从 Chromium 原生事件有界
读取。各路径复用 transport 前的 request proof，重新执行 query-free capture guard、总字节预算、
正文归属与确定性清理；SciRetriever 不用 Python HTTP 客户端重新请求 PDF，也不存在第二个 stock
runtime 合同。

显式 Configuration Browser probe 使用 `navigation_only=False` 与生产 rule/controller：顶层文档、
普通规则批准资源、redirect，以及该 Profile 明确声明且由当前页面/frame ancestry 证明用途的
challenge dependency 都经过相同 guard。Probe 另装配 deny-all capture guard，任何 PDF/body
候选在读取前拒绝；它可以在局部预算内报告 challenge resource/settle 状态，但只证明 Cloak
runtime、固定身份与目标流程可以运行，不下载文章 PDF，也不证明 Profile 已登录、机构 IP、
challenge 已普遍通过或文章 entitlement。合法最终跳转到规则批准 origin 不能被误报为
reachability failure。

普通文章流则使用 `navigation_only=False` 和 `discard_unapproved_subresources=True`。规则允许的
同源或批准 origin CSS/JavaScript 等资源，以及满足发起页/frame/用途约束的受限 challenge
dependency 可以执行；未批准的第三方 tracker 等非关键子资源在
DNS 前 abort，且不会把整篇文章改写为 policy failure。顶层 navigation、popup、viewer、PDF
capture 和 redirect 仍 fail closed。这样既支持需要页面 JavaScript 或点击后异步导航的官方
交付链，又不允许未知第三方扩张网络访问面。

当前 production Browser rule catalog 有 9 条：`acs-publications-pdf@3`、
`aip-publishing-pdf@3`、`sciencedirect-pdf@3`、`iopscience-pdf@2`、
`oxford-academic-pdf@3`、`rsc-publishing-pdf@3`、`science-aaas-pdf@3`、
`springerlink-pdf@5` 和 `wiley-online-library-pdf@3`。Acquisition 只从强身份与 Provider AssetHint 提取精确 routing
origin；Network 不导航其中可能含 encoded separator 的 opaque path。每条规则先接收导航期间
已经捕获且归属当前文章的 PDF，否则只执行经审查的封闭动作。只有总开关、production rule、
选中的固定身份 Profile 安全存在、CloakBrowser wrapper/经验证 binary、Playwright API 和 headed
display 同时就绪时，Bootstrap
才创建 Browser client 并将 runtime readiness 设为 true；否则 route 仍可在 Registry/status 中
观测，但 fail closed。生产对象图传入 Configuration 解析出的 Profile handle；status 只评估
selection/presence，不读取内容或判断登录。这个 production-ready 状态只证明
adapter/access-profile/rule/policy 的离线工程准入，不证明 Browser Profile 已认证、当前 IP、
机构协议或具体文章 entitlement。

Browser 当前运行状态至少能稳定区分正常开放或已认证、需要登录、需要 MFA、challenge resource
loading/settling/cleared、interaction required、resource blocked、settle timeout、明确无当前文献
entitlement、普通 access denied、rate limited、IP blocked、账号警告、not found、PDF captured
和 runtime failure。状态只驱动本次对应 risk group 的继续、暂停或 circuit；它不
形成 Literature 状态，也不写入 Catalog、ArtifactStore 或配置文件。一个 group 的
action-required/circuit 不阻塞其它独立 group。

Browser 捕获只产生一个或多个有界 `TemporaryPdf`，不能直接发布当前主 PDF。每项捕获使用
包含文章 flow identity、捕获机制、安全 locator 和实际字节 hash 的稳定 candidate key；同一
flow 的多个不同字节可以依次进入统一验证。下载事件、`.pdf` 后缀和 `Content-Type` 不能替代
Acquisition 的统一字节/reader/页面树与归属检查；supplementary material 也不能成为主 PDF。
Cookie、Profile 路径/内容、登录细节、header、短期签名 URL、selector、页面对象和 Browser vendor
exception 不进入 `PdfCandidate`、Report、SQLite、provenance、status 或日志。

## 10. 调用方向

```text
metadata.providers       -> network.http
acquisition.routes       -> network.http and/or network.browser
parsing.mineru           -> network.http
agents.providers        -> network.http
bootstrap provider probe -> network.http

network.http              -> network.policy + network.admission
network.browser           -> network.policy + network.admission
```

消费模块公开 API、规则和用例不得看到 URL client、header、cookie、HTTP response、Playwright page/context、浏览器 download 或 permit 类型。只有对应 adapter 可以使用协议技术类型；AccessScope 和 policy 只用于 Network 准入，不进入业务 Model。

## 11. 凭据、配置测试与诊断

- Network 不读取普通 TOML、环境变量、`~/.sciretriever/credentials.toml` 或任何 secret reference/value；Provider secret 由 `sciretriever.configuration` 私有解析，再由 `sciretriever.bootstrap` 注入具体 adapter；
- Adapter 声明允许附着凭据的 origin 和不含 secret 的 quota scope；
- 跨 origin redirect 默认移除凭据，除非 policy 明确允许；
- 凭据值不得进入 scope、内存限速状态、日志、异常、诊断、SQLite、provenance、URL、文件名或用户输出；
- Network 在错误离开 HTTP/Browser 边界前，把协议异常和不可信网络值转换为稳定、脱敏的中性失败；消费模块与 Entry 不接触原始异常或 response；
- 原始 exception、HTTP response、response body、完整 URL、header、Cookie、credential 和短期签名参数不得作为 LogRecord 的 message 参数或 `extra`；
- Provider adapter 仍负责供应商私有响应和 SDK 异常的脱敏，Logging 模块的统一 Filter 只能作为最后防护，不能替代各 adapter 的边界转换。

`config status` 是纯本地 configuration/readiness 检查，不得调用 Network。用户显式执行 `config test <provider|llm|mineru>` 或 `config test --all` 时，Bootstrap 组装的 probe 必须像普通 adapter 一样经过共享 Coordinator、安全 HTTP、URL/DNS/redirect、timeout、响应预算、quota、`Retry-After` 和脱敏。Provider probe 只做官方允许的最小只读请求，LLM probe 只发送固定最小 schema 内容，MinerU probe 只做 health 且不上传 PDF；Network 不因它是配置测试而绕过限速，也不把认证成功解释为任意 Literature 的全文 entitlement。

Network 只返回本次中性、脱敏的 probe 结果。配置测试不创建 DiscoveryRun、MetadataObservation、ProviderRelationObservation、Asset、Report、Catalog/ArtifactStore 事实或持久日志，也不保存最后测试时间、连接状态、permit 或服务健康状态。

底层异常和响应正文只能作为边界内诊断输入，不能成为持久业务合同。限速诊断可以 best-effort 表达脱敏 scope、等待类别和下次允许时间，但这些值不是稳定日志合同，不能被 Report 或业务逻辑解析，也不能包含目标文献、URL 或凭据身份。日志丢失、过滤或 handler 故障不得改变 permit、冷却、返回结果或数据库事实。

## 12. 资源、并发与取消

Entry 可以有界并发处理不同 Literature，Metadata 可以逻辑并发查询多家供应商；所有真实访问仍由 Coordinator 按 scope 与 host 门控。API 并发不能直接继承 Entry worker 数，而由 adapter 声明的官方 quota identity、并发、间隔、window、周期额度和运行时反馈共同决定。共享同一 API 额度池的 Metadata/Acquisition 调用互相可见，明确独立的 API 产品才可并行推进。

Browser 调度同时服从三个边界：同一 `browser_rate_limit_group` 固定只有一个活动文章流程并按该组政策限速串行；不同独立 group 可以并行；进程级 Browser cap 只保护本机 CPU、内存、共享 runtime 中的活动 lane 和文件描述符，不能充当所有 Provider 共用的业务锁。该 cap 默认 `5`，只接受大于 `1` 的严格整数且不设上限；当前九条 route 不构成配置最大值，lane 只为实际 Browser work 延迟进入调度，所有 lane 共享一个 process/context。Provider group 正在等待、命中需要登录等停止状态或 circuit open 时，不占用或阻塞其它 group 的逻辑 permit。

Network 同时执行每 host 连接预算和协议无关资源上限。Provider quota 与页面状态含义由对应 provider/profile/parser/LLM adapter 解释，跨文献业务 cohort 和后续阶段并发仍由 Entry 控制。

取消和 timeout 必须传播到实际网络或浏览器操作，不能只停止上层等待。取消 permit 等待不能占用并发名额；已取得 permit 后取消必须完整清理并更新适用冷却。Late response 不得在调用已结束后成为有效结果。

Browser cleanup failure 属于系统失败，不能形成正常未命中或自动获取耗尽。它会请求在其它活动
lane 排空后淘汰共享 runtime，并立即打开当前 `browser_rate_limit_group` 的 cleanup circuit；
同组后续排队任务不再触网，已经活动的独立 group 可以完成。只有 runtime task 已停止、文章资源
已逐项清理、host/scope permit
已经释放或其释放失败已明确传播后，scheduler callback 才结束并更新组状态。cleanup circuit 与
其它 action-required circuit 一样，只能用精确 group 和 policy revision 显式确认。

## 13. 验收

直接安全测试至少覆盖：

- malformed URL、禁止 scheme/port/userinfo；
- 私网、loopback、link-local 和 DNS rebinding 风险；
- 越权 redirect、跨 origin 凭据剥离和逐跳复检；
- timeout、取消、oversize 和 late response；
- HTTP 与 Browser 使用等价 URL/DNS/redirect/origin/redaction policy；
- 同一 scope 在当前进程的不同模块、任务和用户操作之间共享，不为每个 adapter 重建 limiter；
- 同一 API quota 被 Metadata 与 Acquisition 共用时相互限速，独立 API product scope 不错误互锁；
- API 精确执行 adapter 声明的官方并发、最小间隔、window/周期额度、reset boundary 和反馈头；operator 只能收紧，不能放宽；
- 同一 `browser_rate_limit_group` 最大活动文章流程始终为 1，相邻文章开始时间精确满足该 Profile 的 interval/window/cooldown；成功、失败、timeout、取消和重试都不能绕过；
- 两个独立 Browser risk group 在全局资源 cap 允许时实际并行，一个 group 的等待、登录、action-required 或 circuit 不阻塞另一个 group；
- 全局 Browser cap 只限制本机资源，不把不同 Provider 重新序列化；provider Browser 占用期间，其独立 API scope、其它 provider 和公开仓储可以推进；
- 公开/direct URL 指向出版社网页时仍使用该 provider `web` scope；不同来源落到同一 host 时共享 host budget；
- navigation、页面 request、popup、viewer 和 download 在继续前同时通过 Profile guard 与目标准入；未暴露 route 的 native redirect response 只能按同页 live-proof 规则复检并在读 body 前取得 terminal host permit，不能利用重试、多标签页、备用入口或新 host 绕过组内串行、间隔和预算；
- `429`、`Retry-After`、窗口额度和 `blocked_until` 对共享 scope 的后续调用生效；
- 缺少明确 AccessPolicy 的 production adapter readiness 失败，operator 配置不能放宽安全下限；
- 当前进程内取消、timeout 和失败不会泄漏 permit，也不会绕过仍有效的冷却或 `blocked_until`；
- cleanup failure 立即阻止同组下一篇触网，不会等待普通 runtime failure 阈值；独立 group 不受影响；
- 等待队列、permit、时间截止和额度计数只存在于内存，不创建限速表、协调目录、状态文件、lease 或跨进程锁；
- 新 Coordinator 不恢复旧进程状态，测试和文档不宣称跨进程或跨重启限速保证；
- `browser_max_concurrency` 默认 `5`、严格大于 `1` 且没有上限；`2` 与远大于当前 route 数量的值均合法，`1`、bool 和 float 非法；较大 cap 不启动多个 Browser，也不改变单组串行；
- 所有 session key 共享一个固定身份 Profile、一个有头 CloakBrowser Chromium process/context；同一 key 严格串行，不同 key 可并行，每篇文章的 token、page、popup、download、response stream 和临时目录完整隔离；一个 lane invalidate 只能在其它活动 lane 排空后淘汰共享 runtime；
- Profile identity 不能是路径或敏感标识，Profile 目录树满足 owner-only/no-follow 安全合同；同一 Profile 的跨进程 runtime lease 互斥，使用中不能再次启动或删除；runtime 关闭后 Profile 保留且可以再次取得 lease；
- 安装 wheel 的本地 HTTPS/真实有头 Chromium fixture 连续执行文章或执行 9 家 production rule 时只创建一个 process/context，每篇使用独立 page、download 和文章临时目录，并对每个 landing/PDF hop 重新执行 DNS、TLS authority、connection binding 与 host admission；broker 关闭后临时下载根删除而持久 Profile 保留；无 GUI Linux 通过 Xvfb 启动；
- Publisher 请求由 CloakBrowser Chromium 原生完成 TLS/HTTP/redirect/click/download，loopback CONNECT proxy 只接受已审核的精确 IP binding 并透传加密字节，不终止 TLS 或用 Python HTTP 代发；
- 通用 PDF 发现只返回已批准 origin 的有界 locator，最多尝试前 4 个；签名 query 只进入当前 Chromium operation，不进入 guard、日志、结果或 provenance；
- native redirect response 只有在同页 live ancestor、批准且预绑定的 terminal origin 与最终 host admission 同时成立时才能复用 route proof；跨页或未预绑定时不读取 body；
- production Browser budget 固定覆盖 4 navigation、256 request、10 秒 action/capture 局部等待和 60 秒整篇 deadline；`not-actionable` 与局部 `no-capture` 是正常未命中，真正总 deadline 才是 timeout；
- 每个 cleanup failpoint 后资源释放至多调用一次，重复 session/broker cleanup 保留首次失败，且 cleanup failure 不形成耗尽；
- 登录、MFA、challenge resource loading/settling/cleared、interaction required、resource blocked、settle timeout、无 entitlement、rate limit、IP block 和 runtime failure 形成稳定的当前运行状态；只有对应 terminal feedback 暂停/熔断 group，状态不会持久化；
- 经 Profile 声明的 challenge dependency 只能由已批准 Publisher 页面/frame ancestry 发起，仍受 HTTPS/443、DNS/地址、CONNECT/host、frame/request/字节/总时长预算；不能成为初始导航、popup、PDF locator 或 capture source，未知 Publisher/origin escape 在 I/O 或 body read 前拒绝；
- 同一固定身份 Profile 三次冷启动的 seed 派生 persona、UA/Client Hints、platform、plugins/languages、screen、WebGL、fonts、locale/timezone 保持稳定，不同 Profile 可区分；seed/原始 fingerprint 不进入配置、日志或持久事实；
- Agent observation 具有 screenshot/元素/字节/revision 硬限制；过期 element、未知动作、任意 URL/selector/JavaScript、越界滚动/等待在 vendor 调用前拒绝，所有允许动作复用同一 humanized page、permit、Network guard 和 capture handler；
- 普通 `403` 只形成文章级 `ACCESS_DENIED`，不冒充明确 paywall/无 entitlement，也不会误报 `IP_BLOCKED` 或打开整个 group circuit；
- Browser 能在封闭规则内从 download、response、popup/viewer 和官方 locator 交付临时 PDF，且正文/补充材料区分、候选数量和全部资源预算均受控；
- Provider 页面流程不能绕过 PDF 基本检查直接发布资产；
- Cookie、Profile 路径/内容、identity seed、登录细节、完整 URL、selector、Agent screenshot/页面文本、凭据和 Browser vendor object 不出现在文献持久化、status、日志或业务结果中；Profile 中由 Chromium 管理的认证字节是唯一例外且不由 SciRetriever 解释；
- `config status` 完全不触发 Network；`config test` 通过同一 Coordinator 和安全访问边界，单项失败不泄漏 secret，且不持久化测试结果、时间或文献事实；
- 原始 exception、response、URL、header、Cookie、credential 和 response body 不进入 LogRecord；边界脱敏先于 Logging filter，限速日志的缺失不影响准入结果。

限速、group 并发、runtime/circuit 和 `config test` 测试使用 fake clock、同进程并发任务、fake adapter 与 fake transport，不用真实长时间 `sleep`；HTTP 与 Browser 测试使用系统临时目录中的测试 Profile、本地受控站点、离线页面 fixture 和 fake DNS，并覆盖批准的外部 JavaScript、未批准 tracker 丢弃、点击/脚本 redirect、跨 origin CDN、HTTP attachment、共享 context 文章分流与临时资源清理；不读取真实用户 Profile/凭据，也不连接真实供应商、机构登录或用户语料。
