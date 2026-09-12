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
  browser_runtime.py
  browser_scheduler.py
  browser_sessions.py
  browser_connect.py
  browser_control.py
  cloakbrowser.py
  playwright.py
  response_feedback.py
```

- `policy.py` 形成 URL、DNS、redirect、origin、credential forwarding、单次资源上限和脱敏决定；
- `admission.py` 定义 AccessScope、规范化访问政策和进程内共享 Access Coordinator；
- `http.py` 执行同时符合 policy 与 admission 的普通 HTTP 请求；
- `browser.py` 执行符合相同边界、带文章级 dynamic destination guard 的隔离浏览器操作；
- `browser_runtime.py` 管理 Profile-backed launch preferences 与 native PDF 行为等无 vendor launch helper；
- `browser_scheduler.py` 执行 `browser-generic` 逐文章限速串行和进程内 circuit；
- `browser_control.py` 为 Agent 生成统一 Browser Observation，并把六种封闭动作解析到当前 article/page/surface/revision；
- `browser_sessions.py` 在一个共享 persistent context 中按所选 Profile identity 管理文章级事件隔离；
- `browser_connect.py` 管理无 GUI Linux 的进程内 Xvfb display lease，以及只做精确 IP pinning
  和加密字节透传的 loopback CONNECT proxy；
- `cloakbrowser.py` 管理 CloakBrowser runtime identity/binary 入口，`playwright.py` 把中性 Browser
  合同转换到真实有头 patched Chromium，并让所有已批准 HTTP(S) 请求继续由浏览器原生网络栈执行；
  CloakBrowser/Playwright vendor 类型不越过该边界；
- `response_feedback.py` 把 HTTP/Provider 安全反馈转换为共享 admission 状态，不形成业务结果。

HTTP 与 Browser 是平级能力。Browser 不是 HTTP transport 的特殊模式；Acquisition 决定公开来源、授权 Provider API 和受控浏览器的业务阶段，Network 只决定真实访问何时可以安全执行。

## 2. 共享访问政策

`policy.py` 负责：

- URL 解析与规范化；
- 允许的 scheme、port 和 userinfo；
- DNS 解析结果与公网、私网、loopback、link-local 等地址分类；
- 每次 redirect 的目标复检；
- origin 变化和 credential forwarding 决定；
- URL、query、header、错误详情和凭据脱敏；
- 单次响应、截图、下载字节上限与单次 I/O/action timeout。

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

Browser 在普通 provider/host admission 之外使用全局中性范围：

```text
BrowserAccessScope
  rate_limit_group: "browser-generic"
  session_key: selected Browser Profile identity
```

`rate_limit_group` 不按 Publisher 拆分；`session_key` 只标识共享 context 使用的 operator-managed
Profile。两者不携带 Cookie、用户登录名、机构身份、DOI、完整 URL 或任务 ID。通用 policy 固定
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
browser-generic 的连续 runtime failure 计数与 circuit reason
```

这些值不得携带 DOI、Literature ID、candidate key、完整 URL、header、Cookie、secret reference/value、响应正文、底层异常或逐请求失败。它们不进入业务 Model、SQLite Catalog、ArtifactStore、provenance、日志合同或独立协调文件。Network 不创建限速表、协调数据库、协调目录、跨进程 advisory lock、lease marker 或可恢复的 rate-limit 现场。

进程退出或崩溃后，全部动态限速状态自然消失；新进程从静态访问政策和 operator 配置重新建立 Coordinator，不延续旧进程的网页冷却、`blocked_until` 或 API 窗口。多个并发 SciRetriever 进程各自限速，当前产品不提供跨进程、跨重启或跨机器的供应商额度协调。Storage 为保护同一 Catalog 而使用的核心写入 advisory lock 是独立的数据库完整性机制，不属于 Network。

静态访问政策、`browser-generic` policy、API 规则和 operator 收紧值仍由 adapter/配置与 Provider
Notes 持久表达；“规则持久化”不等于“动态计数和截止时间持久化”。

## 6. 网页访问规则

普通 HTTP landing-page discovery、出版社站内 direct PDF 和 Browser 都先取得对应 provider `web` scope 与实际 host permit。公开、OA 或 direct 声明不构成网页限速豁免；共享网页政策或 host 的访问仍共享真实准入。

Browser 再取得 `browser-generic` 的 `BrowserAccessScope`，固定满足：

```text
max_concurrency = 1
project-conservative article interval/window/cooldown
project-conservative rate-limit cooldown / runtime-failure threshold
```

全部文章在该组内限速串行。全局 Browser concurrency 只保护本机 process/context 资源，不会按
Publisher 建立第二套队列。基线与证据由 Configuration/ADR 0023 维护，operator 只能收紧。

Browser permit 从 canonical landing 第一次导航前持有到 page、popup/viewer、response/download、TemporaryPdf 交付和临时资源完整清理。成功、无结果、页面失败、timeout、取消、Challenge 和重试都不能绕过对应 `next_allowed_at`、`blocked_until` 或 circuit。页面加载会产生多项子资源请求；文章 permit 覆盖完整高层流程，Network 对每次请求、导航、动作、截图、response/download 和 cleanup 分别执行 timeout 与字节上限，但不建立整篇 Browser 作业 deadline。页面脚本、selector 变化、多个标签页或重建 context 不能取得同组第二个并行 permit。

同一 provider 的 API 使用独立、按官方 quota identity 形成的 `api` scope，因此 Browser 流程占用
或冷却期间，独立 API 产品、Metadata 和公开仓储仍可按各自政策运行。

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
process 和一个 persistent BrowserContext，并按稳定 session key 建立 article lease。当前生产
只使用 `browser-generic`；每个 lease 只覆盖一篇文章。共享 runtime 首次创建时 process 与 context 必须分别按
对象身份确认 Network 提供的连接绑定，之后每篇文章通过
`begin_article(lane_key, downloads_path, connection_binding)`/`end_article()` 协议建立独立 article
token、切换临时下载目录、确认连接绑定并排空晚到事件。Broker 只在共享 context 安装一次封闭
route/event dispatcher；事件按 article token 分流，文章 lease 结束后晚到 route 会被终止，晚到
page/download 会被关闭或删除，不能落入另一篇文章的 handler。

`BrowserClient` 可以注入 broker，并要求每次 `run` 同时提供经过 Network 校验的 session key；
没有 broker 的一次性 session 仍用于通用 Network 离线 fixture。Broker 模式在当前对象图内复用
唯一 process/context，但仍为每篇文章建立独立 `_FlowState`、article context、page、临时目录、
单项资源限制、DNS/host lease 和中性结果。页面、下载、请求 lease 和文章临时目录全部清理且 runtime
确认排空后，才释放 lane lease；runtime、timeout、cancel 或文章清理异常会标记共享 runtime 在
活动 article lease 排空后淘汰，不能中断其它正在工作的文章；下一次 acquire 再创建 runtime。
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

Cloak engine thread 在启动任何 wrapper/Chromium 子进程前，先在 Linux 上用 `CLONE_FS` 取得私有
filesystem context，再设置 `umask 077`。Chromium 因而以 `0600` 创建 Profile 文件，而同进程的
Acquisition、Storage 和用户输出线程仍保留宿主 umask；隔离或 umask 设置失败时 runtime 在启动前
fail closed。生产 viewport screenshot 固定为 quality 70 的 JPEG；Network 的媒体类型常量同时驱动
Playwright Observation、Bootstrap Browser Model binding 与合成 Browser Model probe，Agents 不另行
猜测 Browser producer 格式。

Binary runtime lease 与 Profile lease 分离。Configuration 在持有已验证 binary 的共享锁期间，
为每次 Browser runtime 建立系统临时目录中的 owner-only sterile cache view；其中只有指向当前
已验证 `chromium-<fixed-version>` bundle 的定位项，没有 `license.key`、license cache、Pro/latest
marker、update 状态或其它版本。Network 只把该 view 和 manifest 中的精确版本传给 wrapper，
同时删除 ambient `CLOAKBROWSER_*`/proxy 环境控制；context/process 关闭后先删除 view，再释放
binary lease。长期 runtime root 从不直接暴露给 vendor launch，普通 Completion 因而不能通过
cache-file credential 改变 binary、触发 license 验证或下载其它版本。

固定依赖 `cloakbrowser==0.5.8` 会在全新 cache 直接向 stderr 输出 welcome banner。adapter 只在上述
一次性 sterile cache 内预置该版本识别的 `.welcome_shown` 普通文件，以保持 CLI stderr 属于
SciRetriever；创建过程拒绝 symlink、非当前 owner 和多 hardlink，创建后复核 inode 并固定为 `0600`。
该 marker 不含也不选择 license、binary、Profile 或 update，不能写入长期 runtime root；升级 wrapper
版本时必须重新核实这一 vendor-specific 行为。

Broker 的 Debug 诊断只使用经过校验的安全 session key，明确 acquire 的 `session_reused=true|false`、
article drain、release/invalidate/retire 和 broker cleanup outcome 与耗时；绝不记录 Profile 路径或
内容。外层 `BrowserGroupScheduler` 记录 `browser-generic`、匿名 attempt key、queue wait、pacing、
是否真正 attempted、article disposition/group feedback、耗时和 permit cleanup；文章开始保持串行。

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
- 对 Playwright 在请求继续前暴露的 navigation、页面 request、popup、viewer 与 download，先执行 Acquisition Profile 提供的封闭 Provider guard，再执行 Network 通用 URL、DNS、地址类别、origin、credential forwarding、host admission 和单次资源上限检查；未再次暴露 request 的 native redirect 只能按下文同页 live-proof 规则关联，并在读取 terminal body 前完成最终目标复检与 host admission；
- 在 Profile 允许的范围内捕获 download event、PDF response、合法 popup/viewer 或已核实 locator，并只交付统一 `TemporaryPdf`；
- 对每次 request/navigation/action、screenshot、response/download body 和 cleanup 分别执行客观 timeout/字节上限，不累计文章 step、总时长、popup、download 或 capture 作业预算；
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
task 中运行。取消或单次 Browser 操作 timeout 后先发送非占有式 `abort/cancel/stop`；task 必须在显式的
本机 cleanup timeout 内确认停止。这个 timeout 只保护本机 thread/process/file descriptor 回收，
不是 Provider 请求间隔、quota 或可配置的提速值。未及时确认时调用立即失效全部 late result，
升级到 page/context/process close，继续清理其余资源并返回稳定 cleanup failure；daemon worker
不能把晚到 response/download 重新变成候选。被拒绝的 route 只有在 runtime 确认 abort 后才能
立即释放其 host permit；abort 未确认时必须把 permit 保留到 context/process teardown 完成，避免
仍可能存活的 transport 脱离准入边界。

文章目标、通用页面分类和正文/补充材料判别位于 Acquisition，不进入 Network。Network 不解释
Publisher 页面语义，不执行任意 JavaScript、selector guessing、自动登录、机构选择、MFA 或运行时
指纹脚本；它只执行当前 article
control handle 上的六种中性动作：

```text
ClickElement
ClickPoint
ScrollSurface
GoBack
WaitForChange
Stop
```

`ClickElement` 解析当前 revision 的短期 element ID；`ClickPoint` 必须同时匹配当前 article/page/
surface/viewport/screenshot/revision 并在 vendor I/O 前验证坐标范围；`ScrollSurface` 不能越过当前
surface；`GoBack` 不接受任意 URL；`WaitForChange` 只有单次 action timeout；`Stop` 不调用 vendor。
所有实际 click/scroll/wait 使用同一 CloakBrowser humanized executor。Network 不提供 Page、Locator、
selector、CDP、任意 URL/JavaScript、跨 revision/raw coordinate、token 注入、外部 solver、文件系统、
新 Browser/context 或出口/身份切换。文章级 dynamic destination guard 从 exact start、已准入页面
关系和有限 redirect ancestry 收紧通用 Network policy；未知 Provider 只要已有合法文章起点，就使用
同一合同。Agent 每次只提交一个动作，Network 对一次 `apply` 实施合计的单次 timeout；不通过固定
sleep、全局 `networkidle` 或 action 返回的第一帧作结论。

Agent 的 `BrowserStepSession.start()`、模型调用期间页面变化后的 `apply()` 复检和 action 后评价都经过
同一 Observation readiness/settlement gate。可操作 Observation 表示当前主 Page 仍属于该 article session，
Page/frame/surface/screenshot 来自同一 observation generation，且 stable semantic facts 在内部短
quiet window 内一致；它不要求动画、截图像素或无关网络请求停止。明确的 navigation race、
execution context destroyed、frame detach/reattach、旧 Page closed 和 popup/viewer 交接只使当前
snapshot 暂不可用，Network 在 action deadline 内从 article-owned Page 集合重新观察。deadline 到达、
process/context 真正退出、policy、取消或其它非过渡异常才形成 typed failure。

跨出 Network 的 step 结果只有五种。这里的 `Captured` 只会在 Agent 尚未开始作出动作时作为
初始文章结果暴露；一旦 Agent 已经开始探索，后续捕获物不会把 step 变成终态，而是留在本次
`BrowserCaptureBatch` 中，等 controller 以 `Stop`、预算或硬故障结束后由外层 `BrowserClient`
一次性交给 Acquisition。

```text
Ready      stable actionable Observation; the only result that may continue. Pending capture progress is hidden from the Agent
Captured   an initial bounded capture completed before Agent exploration began
Blocked    Agent Stop with a reason
Failed     a stable Network/policy/runtime/controller failure
Cancelled  cancellation won before another stable result crossed the boundary
```

`page_state`（包括 `CHALLENGE`、登录、MFA、拒绝、未授权、未找到和页面失败）只是当前稳定页面
的描述，不会自动映射为 `Blocked`。一次没有语义变化、重复动作或页面短暂不变都是正常的 settled
step；它们不再生成 `no-progress` 终态。Candidate timeout 是 Network 内部的有界等待结果：它会
隐藏候选进度、恢复一个可执行的 `Ready`，并继续保留 pending correlation，等待迟到的 native download
或 Agent 发现其它入口。Agent 只有选择 `Stop`，或遇到预算、取消和真正的 Network/runtime failure
时才离开继续循环；若最终没有 capture，外层 Browser operation 才以 `capture-timeout` 结束。

`BrowserFlowSession.browser_steps(policy, timeout_seconds=...)` 是创建该 session 的唯一跨模块入口；
Acquisition 只能调用 `start/apply`。内部 transition driver、stale、settled、Candidate、quiet fingerprint
和 page successor 不在 `browser_control.__all__`，也不由 Acquisition 编排。每个携带 receipt 的稳定结果
都验证 article 与 revision 顺序。receipt 的 `page_id` 表示实际 dispatch Page；下一 `Ready` 或终态
Observation 可以来自同一 article 中接替它的 popup/viewer/successor Page，因此不强制使用相同
`page_id`。`execution_binding_fingerprint` 与 request-local ledger 在 vendor I/O 前复检；过期动作不会
dispatch，也不会在新页面上自动重放，而是返回新的 `Ready`。

failure 文案必须服从实际发生阶段。vendor dispatch 前的 Observation/action 绑定不匹配才是
`acquisition-browser-agent-action-rejected`；动作已经 dispatch 后或 readiness/settle 期间发生的
规则外顶层跳转仍是 destination-policy failure，返回
`acquisition-browser-policy-failed` 并保留已有 receipt，不能再描述成“Agent 选择了页面外动作”。

正文归属规则同样是本地封闭合同。每条有捕获能力的规则必须声明至少一种文章身份检查：捕获
locator 与 canonical landing 完全一致、捕获 path 含 landing 的精确文件 stem，或捕获 path
包含指定 namespace 的稳定 `Identifier`（例如 DOI、PII、article ID）。规则另外声明已知
supplement URL prefix、supplement selector、supplement filename marker，以及 issue front
matter、广告等 excluded prefix/filename marker；这些字段和正文捕获优先级都进入 fingerprint。
Known supplement selector 不能同时成为 click action。Acquisition 的 capture policy 在读取 body
前只准入满足正文 locator、媒体线索和当前文章身份的资源，或满足下述精确 DOI-PDF 起点 redirect
lineage 例外的 opaque locator；supplement、excluded 和 wrong-article locator 不读取正文。Source 在
形成候选前用当前 article-local policy 重复验收，防止不合规 runner 把补充材料、错文或无 accepted
lineage 的 opaque capture 注入主候选。只有 supplement 或排除项时形成正常 `no-download`，不会误发布。

`browser.py` 提供中性的 `BrowserDestinationGuard`：Controlled Browser
Source 对每篇文章注入一项只含当前规则 origin 与精确 resolver 起点的 guard。Network 在初始
导航、显式导航、redirect/页面请求、popup、response capture 和 download capture 分别标记
用途，并在 DNS、route continuation 或读取响应/下载字节前调用该 guard；传给 guard 的 locator
已经去除 query，规则外异常统一转换为 `policy` 失败。Response 的实际 transport 已由更早的
request guard、DNS binding 和 live host lease 准入，response hook 再在读取 body 前复核同一
lease。通用 URL/DNS/地址类别/host permit/单次资源上限仍独立执行，guard 只能收紧不能放宽。
正文捕获另有不可序列化的 `BrowserCapturePolicy`。Network 把 query-free locator、封闭
`BrowserCaptureKind`、规范媒体类型、direct/redirect-descendant correlation、是否为 request
navigation、是否精确来自本次 start、redirect depth 和 native-download 标志组成中性的
`BrowserCaptureEvidence`；其中不含 DOI/Publisher 解释、vendor object 或持久状态。Acquisition
policy 只返回 `ACCEPT / DEFER / REJECT`：`ACCEPT` 后 Network 才读取 body；`DEFER` 把 response
或 download 保持为 operation-local、未读取、未发布的 Candidate，并在 landing 事实更新或 native
download 到达后用当前 policy 重新判定；`REJECT`、非法返回或 policy 异常均 fail closed。Pending
resource 保存 lease 与 evidence，不保存可过时的最终布尔判断。

部分 Chromium/Playwright response event 只能稳定提供响应元数据，稍后直接调用 `response.body()`
可能已经失去可读正文。为此 Network 支持一个可选、只读的
`BrowserCapturePrefetchPolicy`：request 已通过 Provider guard、URL/DNS/地址、host admission 与
connection binding 后，Acquisition 才能把一项已审核的主文 `GET document|fetch|xhr` 请求标记为可
预取。Network 随即执行同一 route 的 `fetch(max_redirects=0)` 并用该精确 response `fulfill` 原请求，
把未暴露给 Acquisition 的 `APIResponse` 仅作为后续 response event 的私有 body source。未选择或
runtime 不支持该能力时仍使用普通 `continue`；预取不能跳过 response destination guard、媒体类型、
capture policy、字节上限或最终 Acquisition 验收。任何 `206 Partial Content` 都不读取 body、也不
作为完整 PDF 单独捕获，只有完整响应或 native download 才能形成候选。

response 声明 `download_expected=true` 时，Network 分别计算 `RESPONSE` 与 `DOWNLOAD` evidence 的
当前决定，以 `REJECT < DEFER < ACCEPT` 仲裁，同级优先 `DOWNLOAD`。非导航 `fetch` 的 response 决定
更强时直接走 response body；顶层 PDF navigation 即使由 `RESPONSE` 获准也等待 native download，避免
在 external-PDF 模式下对只能观察 metadata、不能读取正文的 response 取 body。两种决定都拒绝时只保留
一次性 pending correlation，以便迟到的 native download 在不读正文的情况下删除；`has_capture_candidate`
会重新询问 policy 并排除该 reservation，因此它不形成 `CANDIDATE`。

成功结果是非空 `BrowserCaptureBatch`，其中
每项只含 `DOWNLOAD`、`RESPONSE`、`POPUP`、`VIEWER` 或 `VERIFIED_LOCATOR`、一个
`BoundedByteStream` 和安全 locator，不含 response/download/page 等 vendor object。同一文章中
相同实际字节即使同时触发 response 与 download 也只交付一次；每项 body 在读取前独立执行单项
字节上限，不累计 capture 数量或整篇总字节预算。通过 exact-start redirect 例外的 accepted evidence
由注入的同一个 Acquisition policy 保持为不可序列化、operation-local 状态；Acquisition 对返回 capture
再次核对精确 locator/kind/media 绑定并重新验证当前 lineage，普通 capture 则重复 Provider
locator/media/identity 分类，然后分别转换为 `TemporaryPdf`。

完成主导航后，`browser_control.py` 为唯一通用 Agent controller 生成不可序列化的
`BrowserObservation`：

```text
BrowserObservation
  article_id / page_id / revision
  surfaces: page | popup | frame | shadow | viewer tree
  query-free origin/path/title
  viewport / scroll / surface bounds
  screenshot: bytes + identity/size metadata
  elements: short element_id + surface_id + role/name/state + bounding box
  page_state
  capture_state
  previous_action_receipt
```

每个 surface、element 和 screenshot 都绑定当前 article/page/revision；上一 action receipt 绑定同一
article 和不晚于当前 Observation 的 revision，但可指向已经被 successor 接替的 dispatch Page。完整
URL query、response/header/body、Page、Locator、selector、context、Cookie 或 vendor object 不跨越边界。截图与 element 文本
分别使用单次 Observation 技术上限，超限形成稳定 snapshot failure，不成为跨 Observation 累计图像
预算。可见元素由通用 snapshot 一次性枚举并绑定短期 ID，不解析 Publisher selector catalog。

三个运行维度正交：

```text
page_state:
  NORMAL | CHALLENGE | LOGIN_REQUIRED | MFA_REQUIRED |
  NOT_ENTITLED | ACCESS_DENIED | NOT_FOUND | FAILED

agent_status:
  RUNNING | STOPPED | FAILED

capture_state:
  NONE | CANDIDATE | CAPTURED
```

`CANDIDATE` 由当前 policy 仍判为 `ACCEPT/DEFER` 的 pending correlation、未决 response/download
或正在执行的 download callback 产生，不是成功 capture。每次观察 Candidate 都重新询问当前
policy，已经成为 `REJECT` 的资源不会继续冒充进展。settle 在首次观察到 Candidate 后使用独立的
单次 capture wait deadline：完整字节在 `ACCEPT` 后返回 `Captured`，关联被明确清除/拒绝后回到
`NONE` 并返回 `Settled`，一直未完成或未收敛则返回仅供 Network 使用的 `CandidateTimeout`。Step
Session 将该 transition 转换为隐藏候选进度的 `Ready`，controller 可以继续探索；controller
最终停止且外层仍无 capture 时才以 `capture-timeout` 报告，Acquisition 再转换为稳定 route failure。
`active_download_callbacks` 只用于表示 capture progress；
page/download/stream 的资源 ownership 由独立集合维护，callback 计数不能代替资源 close。文章清理
先原子阻止新的 callback，等待已经取得 download ownership 的 callback 全部退出，再分别 drain/close
所有 owner，并粘性保留第一次 cleanup failure；不能在 callback 仍运行时清零计数或提前返回业务结果。

Network 不从通用文本猜页面含义；Acquisition 只从中性 Observation 形成通用 `page_state`。裸 403
不能自动成为 Challenge。

受限页面 dependency 只能由已准入顶层页面和当前 frame ancestry 发起，并继续执行 HTTPS、
DNS/地址、CONNECT prebind、host admission、单次 request/frame timeout
和单项字节上限。它不能成为顶层初始导航、popup、PDF locator 或 capture source。Challenge 只由
`page_state=CHALLENGE` 表达，不建立 resource-loading/settling/interaction 状态族、专属 Observation、
interaction target、动作或预算。资源 admitted/blocked 作为 Network receipt/failure 报告；页面脚本
自动清除 Challenge 时，下一 revision 自然回到普通页面。

Agent controller 只消费 `BrowserStepSession` 的稳定 `Ready` Observation。Network 不决定模型策略，
但在 `start/apply` 返回前必须收敛 readiness、页面替换
和 capture。Agent 动作必须绑定当前 revision/surface/screenshot/element，过期、未知、hidden/disabled、
坐标或 scroll 越界在 vendor I/O 前拒绝。实际动作始终复用同一 CloakBrowser humanized article handle，
不创建第二 context、CDP client 或脚本入口。
`browser_scheduler.py` 把 `browser-generic` policy 固定为 `max_concurrency = 1`，并执行文章启动
间隔、可选滑动窗口、完成冷却和失败冷却。Scheduler callback 的边界是一篇完整文章流程，只有 callback
返回（或抛错）后才记录完成/失败冷却并释放组锁；等待取消不会取得或误释放另一流程的 permit。
同一进程同一 group 只能注册一份完全一致的 policy revision，避免通过别名或新 operation
重建限速状态。

同一个 scheduler 也是通用 Browser 动态状态的唯一进程内所有者。基线 policy 显式声明正数
`rate_limit_cooldown` 与 `runtime_failure_threshold`；
operator 收紧时前者只能取更长值，后者只能取更小值。文章 callback 完整返回后，封闭的
`BrowserGroupFeedback` 原子更新对应 group：rate-limit 把 `blocked_until` 至少推进到声明的
cooldown，登录、MFA、IP block 和账号警告打开带封闭原因的 action-required circuit；Agent 明确
Stop 或候选等待超时后保留文章级具体终态，不产生专属 interaction circuit。候选等待超时本身
不会结束 Agent，只有最终无 capture 时外层才形成 `capture-timeout`。重复 self/cycle
不再由当前自主 session 自动制造终态；若模型最终触发 32 次 safety fuse，则报告 controller safety
failure，而不是伪装成页面或 Challenge 失败。
Challenge dependency 被本地策略阻断形成 Network/配置 failure。资源清理未确认或失败
会立即打开 cleanup circuit，不能等待普通 runtime failure 阈值后
让下一篇文章与未确认停止的旧流程重叠；连续 Browser runtime failure 达到声明阈值后打开
runtime circuit。正常成功只清除
连续 runtime failure 计数，不缩短 `next_allowed_at`、`blocked_until`，也不关闭 circuit。

每篇文章在取得本机全局 Browser permit 和调用 callback 之前都重新读取通用 group 状态。仍在
`blocked_until` 内的任务返回 `deferred`，open circuit 返回 `action-required`；这条路径不调用
Browser adapter，因此同批排队任务、新 Literature、不同 route key 或备用入口都不能再次触网。
rate-limit 到期后按 monotonic clock 自动恢复；action-required
circuit 只能由持有精确 group 与 policy revision 的显式 `acknowledge_circuit()` 关闭，且该操作
不清除仍有效的 cooldown。动态 snapshot 仅含稳定 group、revision、时钟截止、连续计数和封闭
原因，并与 scheduler 一起拒绝序列化；不含 URL、selector、Cookie、Token 或文献标识。

生产 Controlled Browser 仍保持 fail closed：Bootstrap 把共享 session broker、scheduler、
admission controller 和 cohort executor 接入完整及 capability-scoped Completion 对象图，并只组装
Agent controller。统一 Observation、六种封闭动作、多路正文
捕获、supplement/错文排除、Provider cooldown/circuit 和确定性取消/资源清理都必须在同一对象图验收。
`network/cloakbrowser.py` 是唯一正式 adapter：它在一个 Profile-backed shared runtime 的专用
engine thread 上通过 Playwright API 驱动有头 CloakBrowser patched Chromium persistent context，
固定使用 `headless = false` 和 Profile identity manifest 中的 seed/persona。无 GUI Linux 由
`browser_connect.py` 的 Xvfb lease 提供虚拟显示；共享 runtime 关闭后停止 display。Python wrapper
可以进入 wheel，vendor Chromium binary 由 Configuration 显式安装、锁定版本和校验，不进入 wheel、
普通 Completion 或隐式更新。不存在系统 Google Chrome/Playwright Chromium 的生产 fallback。
Profile 的独占 runtime lease 与 Cloak process/context 同生命周期，关闭后释放但不删除 Profile。

Playwright 的 navigation/context/frame/Page replacement 异常必须在 engine thread 内分类，因为原始
vendor exception 不得跨越 CloakBrowser 私有命令队列。明确的可恢复分类转换为不含 payload 的
`BrowserObservationUnavailable`；该类型是 engine command boundary 唯一原样透传的控制信号，供
`BrowserClient` 在当前 article deadline 内重新观察。其它异常正文、vendor 类型和私有状态全部在
该边界内丢弃并转换为通用 payload-free runtime failure。这样既保留页面交接语义，也不把 URL、
selector、页面正文或 vendor 诊断泄漏给 Acquisition、日志或 Report。

第一版使用 native Linux persona，并把 locale、languages、timezone、screen/window、WebGL、字体和
Browser version 作为同一身份快照验收。CloakBrowser `humanize=True` 是所有生产 click、scroll、
wait 和允许输入的唯一执行路径；Agent 和其它调用方都不能用 ElementHandle、直接 DOM click、另一个
CDP client 或任意页面脚本绕过。候选明确使用 `service_workers="block"`：Playwright route 无法保证
观察 Service Worker 接管的请求，而 CONNECT 透传 TLS，不能补证加密流量内的 path、resource type、
frame ancestry 或 capture source。launch flag 与 Profile preference 必须逐项有证据，不能无条件
复制 stock launcher 的历史参数。

每个 CloakBrowser Chromium HTTP(S) request 先被 Playwright route 暂停。`BrowserClient` 在 route 继续前依次执行
Provider destination guard、通用 URL/地址类别检查、DNS 解析、host admission 与单次请求上限，并形成
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
仍存活的同页祖先 request proof，且最终 origin 必须已经由当前文章关系准入、完成
DNS prebind，并在读取 terminal body 前取得或复用最终 host permit。跨 page、祖先已结束、redirect
链循环/超过 32 层或未预绑定 origin 一律 correlation failure，且不得读取 body。最终 response
locator 仍重新通过 article destination guard、URL/DNS 与当前 capture policy；未批准的第三方普通子资源可以按
规则丢弃，顶层导航与 PDF capture 仍 fail closed。
Network 只把“本次初始导航精确命中 start”及其 live redirect depth 表达为中性 evidence，不因
同源、媒体类型或 redirect 本身授权正文。最终 opaque locator 是否仍属于当前文章，由 Acquisition
结合本次 article intent、正文/补充材料分类和显式外来标识符检查决定。

Network 的 `ClickElement` 将当前 revision 的短期 element ID 解析到已缓存 Locator，并通过真实
Playwright/CloakBrowser humanized click 执行。`ClickPoint` 只在绑定当前 screenshot/
viewport/surface/revision 后执行。所有点击都设置明确的单次 action timeout，不把后续整段页面导航
隐式塞进 click 调用。Agent 不能填写表单、注入脚本或绕过目标审查；页面 title 与 element
name/state 使用单次受限 snapshot，不把截图字节或页面正文交付日志或业务结果。运行时 URL 可以
保留经过严格 wire-shape 校验的短期签名 query 并交给 Chromium，guard、DNS key、日志、capture
locator、中性结果与 provenance 始终只使用去除 query 的 URL。

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
读取。各路径复用 transport 前的 request proof，重新执行 query-free capture policy、单项字节上限、
正文归属与确定性清理；SciRetriever 不用 Python HTTP 客户端重新请求 PDF，也不存在第二个 stock
runtime 合同。

显式 Configuration Browser probe 使用 `navigation_only=False` 与生产 Network/runtime contract：顶层文档、
普通页面资源、redirect，以及由当前页面/frame ancestry 证明用途的受限 dependency 都经过相同
guard。Probe 另装配 deny-all capture policy，任何 PDF/body
候选在读取前拒绝；它可以报告 Challenge dependency admission、统一 page state 和动作 readiness，但只证明 Cloak
runtime、固定身份与目标流程可以运行，不下载文章 PDF，也不证明 Profile 已登录、机构 IP、
challenge 已普遍通过或文章 entitlement。合法最终跳转到已准入 origin 不能被误报为
reachability failure。

普通文章流则使用 `navigation_only=False` 和 `discard_unapproved_subresources=True`。当前已准入
页面的同源 CSS/JavaScript 等资源，以及满足发起页/frame/用途约束的受限 challenge
dependency 可以执行；未批准的第三方 tracker 等非关键子资源在
DNS 前 abort，且不会把整篇文章改写为 policy failure。顶层 navigation、popup、PDF
capture 和 redirect 仍 fail closed。这样既支持需要页面 JavaScript 或点击后异步导航的官方
交付链，又不允许未知第三方扩张网络访问面。

当前 production Browser 只有 `browser:generic`。Acquisition 从已接纳 AssetHint 或 DOI safe resolve
形成精确起点；Network 不导航来源不明的 opaque path。只有总开关、Browser Model、选中的固定
身份 Profile 安全存在、CloakBrowser wrapper/经验证 binary、Playwright API 和 headed display 同时
就绪时，Bootstrap
才创建 Browser client 并将 runtime readiness 设为 true；否则 route 仍可在 Registry/status 中
观测，但 fail closed。生产对象图传入 Configuration 解析出的 Profile handle；status 只评估
selection/presence，不读取内容或判断登录。这个 ready 状态只证明
generic adapter/policy 的离线工程准入，不证明 Browser Profile 已认证、当前 IP、
机构协议或具体文章 entitlement。

Browser Observation 的 `page_state` 只区分 `NORMAL`、`CHALLENGE`、`LOGIN_REQUIRED`、`MFA_REQUIRED`、
`NOT_ENTITLED`、`ACCESS_DENIED`、`NOT_FOUND` 和 `FAILED`；`capture_state` 与 Agent controller 的
`agent_status` 正交。rate limit、IP block、账号警告、Challenge dependency resource blocked 和
runtime/cleanup failure 作为对应 Network/scheduler failure 单独表达。所有状态只驱动本次通用
Browser 的继续、暂停或 circuit，不形成 Literature 状态，也不写入 Catalog、ArtifactStore 或配置文件。

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
parsing.backends.mineru  -> network.http
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
- Playwright/CloakBrowser 未声明 exception 在 vendor 边界只按受控 exception type/category 稳定化；
  原始 message 不进入 `StableFailure` 或日志，因而其中可能存在的 URL、token、selector 和本机路径
  不会跨出 Network；
- 原始 exception、HTTP response、response body、完整 URL、header、Cookie、credential 和短期签名参数不得作为 LogRecord 的 message 参数或 `extra`；
- Provider adapter 仍负责供应商私有响应和 SDK 异常的脱敏，Logging 模块的统一 Filter 只能作为最后防护，不能替代各 adapter 的边界转换。

`config status` 是纯本地 configuration/readiness 检查，不得调用 Network。LLM 向导只有在用户
明确选择“获取可用模型”后，才通过 Bootstrap 与共享 HTTP 对 candidate origin 执行一次有界、
无 redirect/retry 的 `GET /models`；credential 仍只附着到该规范 origin，结果不持久化，失败回到
手工输入。用户显式执行 owner-scoped `config test provider/model/search/parse/analyze/browser` 或
`config test --all` 时，Bootstrap 组装的实际外部 probe 必须像普通 adapter 一样经过共享 Coordinator、
安全 HTTP、URL/DNS/redirect、timeout、响应预算、quota、`Retry-After` 和脱敏。Provider probe
只做官方允许的最小只读请求，Analysis probe 只发送固定最小 schema 内容，Browser Agent probe
只发送合成图片与封闭工具，MinerU probe 只做 health 且不上传 PDF；Download 没有安全的独立
外部 probe 时在 Configuration 边界直接报告 unavailable，不向 Network 伪造请求。Network 不因
它是配置测试而绕过限速，也不把认证成功解释为任意 Literature 的全文 entitlement。

Network 只返回本次中性、脱敏的 probe 结果。配置测试不创建 DiscoveryRun、MetadataObservation、ProviderRelationObservation、Asset、Report、Catalog/ArtifactStore 事实或持久日志，也不保存最后测试时间、连接状态、permit 或服务健康状态。

底层异常和响应正文只能作为边界内诊断输入，不能成为持久业务合同。Acquisition 在 INFO 中拥有
已 dispatch action 的 action/dispatch/settle/semantic/page/capture/elapsed 摘要；Network 的
Observation revision、exact/stable fingerprint、surface/element 数量和 transition/capture evidence
只进入 Debug。限速诊断可以 best-effort 表达脱敏 scope、等待类别和下次允许时间，但这些值不是
稳定日志合同，不能被 Report 或业务逻辑解析，也不能包含目标文献、URL 或凭据身份。日志丢失、
过滤或 handler 故障不得改变 permit、冷却、返回结果或数据库事实。

## 12. 资源、并发与取消

Entry 可以有界并发处理不同 Literature，Metadata 可以逻辑并发查询多家供应商；所有真实访问仍由 Coordinator 按 scope 与 host 门控。API 并发不能直接继承 Entry worker 数，而由 adapter 声明的官方 quota identity、并发、间隔、window、周期额度和运行时反馈共同决定。共享同一 API 额度池的 Metadata/Acquisition 调用互相可见，明确独立的 API 产品才可并行推进。

Browser 调度同时服从两个边界：`browser-generic` 固定只有一个活动文章流程并按通用政策限速串行；
进程级 Browser cap 只保护本机 CPU、内存、共享 runtime 和文件描述符。该 cap 默认 `5`，只接受
大于 `1` 的严格整数且不设上限；所有文章共享一个 process/context。Browser 正在等待、命中需要
登录等停止状态或 circuit open 时，不阻塞独立 API/Metadata scope。

Network 同时执行每 host 连接预算和协议无关资源上限。Provider quota 与页面状态含义由对应 provider/profile/parser/LLM adapter 解释，跨文献业务 cohort 和后续阶段并发仍由 Entry 控制。

取消和 timeout 必须传播到实际网络或浏览器操作，不能只停止上层等待。取消 permit 等待不能占用并发名额；已取得 permit 后取消必须完整清理并更新适用冷却。Late response 不得在调用已结束后成为有效结果。

Browser cleanup failure 属于系统失败，不能形成正常未命中或自动获取耗尽。它会请求在其它活动
article 排空后淘汰共享 runtime，并立即打开 `browser-generic` 的 cleanup circuit；
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
- `browser-generic` 最大活动文章流程始终为 1，相邻文章开始时间精确满足 baseline/override 的
  interval/window/cooldown；成功、失败、timeout、取消和重试都不能绕过；
- 全局 Browser cap 只限制本机资源；Browser 占用期间，独立 API scope、Metadata 和公开仓储可以推进；
- 公开/direct URL 指向出版社网页时仍使用该 provider `web` scope；不同来源落到同一 host 时共享 host budget；
- navigation、页面 request、popup、viewer 和 download 在继续前同时通过 Profile guard 与目标准入；未暴露 route 的 native redirect response 只能按同页 live-proof 规则复检并在读 body 前取得 terminal host permit，不能利用重试、多标签页、备用入口或新 host 绕过组内串行、间隔和单次资源上限；
- `429`、`Retry-After`、窗口额度和 `blocked_until` 对共享 scope 的后续调用生效；
- 缺少明确 AccessPolicy 的 production adapter readiness 失败，operator 配置不能放宽安全下限；
- 当前进程内取消、timeout 和失败不会泄漏 permit，也不会绕过仍有效的冷却或 `blocked_until`；
- cleanup failure 立即阻止 `browser-generic` 下一篇触网，不会等待普通 runtime failure 阈值；
- 等待队列、permit、时间截止和额度计数只存在于内存，不创建限速表、协调目录、状态文件、lease 或跨进程锁；
- 新 Coordinator 不恢复旧进程状态，测试和文档不宣称跨进程或跨重启限速保证；
- `[browser].max_concurrency` 默认 `5`、严格大于 `1` 且没有上限；`2` 与更大值均合法，`1`、bool 和 float 非法；较大 cap 不启动多个 Browser，也不改变 `browser-generic` 串行；
- 所有文章共享一个固定身份 Profile、一个有头 CloakBrowser Chromium process/context；`browser-generic` 严格串行，每篇文章的 token、page、popup、download、response stream 和临时目录完整隔离；runtime invalidate 只能在其它活动 article lease 排空后淘汰共享 runtime；
- Profile identity 不能是路径或敏感标识，Profile 目录树满足 owner-only/no-follow 安全合同；同一 Profile 的跨进程 runtime lease 互斥，使用中不能再次启动或删除；runtime 关闭后 Profile 保留且可以再次取得 lease；
- 安装 wheel 的本地 HTTPS/真实有头 Chromium fixture 连续执行通用文章流程时只创建一个 process/context，每篇使用独立 page、download 和文章临时目录，并对每个 landing/PDF hop 重新执行 DNS、TLS authority、connection binding 与 host admission；broker 关闭后临时下载根删除而持久 Profile 保留；无 GUI Linux 通过 Xvfb 启动；
- Publisher 请求由 CloakBrowser Chromium 原生完成 TLS/HTTP/redirect/click/download，loopback CONNECT proxy 只接受已审核的精确 IP binding 并透传加密字节，不终止 TLS 或用 Python HTTP 代发；
- Agent controller 不先运行确定性 PDF locator 或 Publisher 点击规则；签名 query 只进入当前 Chromium operation，不进入 guard、日志、结果或 provenance；
- native redirect response 只有在同页 live ancestor、批准且预绑定的 terminal origin 与最终 host admission 同时成立时才能复用 route proof；跨页或未预绑定时不读取 body；
- 只有 Acquisition 对已审核主文请求明确返回 prefetch 许可时，Network 才在全部 request 准入后使用
  `fetch(max_redirects=0) -> fulfill` 保留稳定 body source；普通资源继续 `continue`，`206` range
  chunk 始终不读取、不作为完整 PDF 捕获；
- Browser 不设置整篇 step/time/request/popup/download/capture 作业预算；单次 request/navigation/
  action/settlement/screenshot/body/cleanup 的 timeout 或字节上限分别稳定失败，dispatch receipt 不能
  代替稳定 step 结果；
- 每个 cleanup failpoint 后资源释放至多调用一次，重复 session/broker cleanup 保留首次失败，且 cleanup failure 不形成耗尽；
- page state、agent status 与 capture state 正交；Challenge 只是统一 page state，不建立 resource/interaction 专属状态机，所有运行状态和 receipt 均不持久化；
- 页面发起的 challenge dependency 与其它子资源一样重新经过 HTTPS、DNS/地址、CONNECT/host、单次 frame/request timeout 与字节上限；它不由 Publisher Profile 预先声明，也不能成为 Agent 构造的任意初始导航或绕过通用 Network admission；
- 同一固定身份 Profile 三次冷启动的 seed 派生 persona、UA/Client Hints、platform、plugins/languages、screen、WebGL、fonts、locale/timezone 保持稳定，不同 Profile 可区分；seed/原始 fingerprint 不进入配置、日志或持久事实；
- 统一 Observation 覆盖 page/popup/frame/Shadow/viewer surface tree、单次 screenshot、短期 element、capture 与 receipt；过期 revision/element/screenshot/surface、未知动作、任意 URL/selector/JavaScript、跨 revision/raw coordinate 和越界滚动在 vendor 调用前拒绝；
- `BrowserStepSession` 只公开 `Ready / Captured / Blocked / Failed / Cancelled`，只有 `Ready` 可继续；
  transition driver、stale、settled 和 Candidate 私有化，`WaitForChange` 与其它 Agent action 使用同一
  变化/timeout，异步 navigation、Challenge clear、capture、取消和 vendor failure 使用可控 fixture 验证；
  页面状态只进入 Observation；Agent 已开始探索后 materialized capture 从 Observation 中隐藏，但仍
  保留在外层 `BrowserCaptureBatch`，由 Acquisition 做 PDF 字节与文章归属验收；
- Candidate 只由当前 policy 仍未拒绝的 pending correlation、deferred resource 或 callback 表示并走向 captured、cleared 或 timeout；timeout
  只恢复 Agent 可继续的 `Ready`，不会单独结束 Agent；外层在最终无 capture 时才返回 `capture-timeout`；callback
  活跃计数与 page/download/stream ownership 分开，cleanup 各自且至多一次；
- Agent 的 `ClickElement`、`ClickPoint`、`ScrollSurface`、`GoBack`、`WaitForChange` 和 `Stop` 复用同一 humanized article handle、permit、Network guard 和 capture handler；Cloudflare-shaped fixture 使用相同动作证明自动 clear、可见交互、语义无进展、资源阻断和 origin escape；
- 普通 `403` 只形成文章级 `ACCESS_DENIED`，不冒充明确 paywall/无 entitlement，也不会误报 `IP_BLOCKED` 或打开整个 group circuit；
- Browser 能从 download、response、popup/viewer 和官方 locator 交付临时 PDF，且正文/补充材料区分、三态 capture policy、单项字节上限和全部 destination guard 均受控；
- Provider 页面流程不能绕过 PDF 基本检查直接发布资产；
- Cookie、Profile 路径/内容、identity seed、登录细节、完整 URL、selector、Agent screenshot/页面文本、凭据和 Browser vendor object 不出现在文献持久化、status、日志或业务结果中；Profile 中由 Chromium 管理的认证字节是唯一例外且不由 SciRetriever 解释；
- `config status` 完全不触发 Network；`config test` 通过同一 Coordinator 和安全访问边界，单项失败不泄漏 secret，且不持久化测试结果、时间或文献事实；
- 原始 exception、response、URL、header、Cookie、credential 和 response body 不进入 LogRecord；边界脱敏先于 Logging filter，限速日志的缺失不影响准入结果。

限速、group 并发、runtime/circuit 和 `config test` 测试使用 fake clock、同进程并发任务、fake adapter 与 fake transport，不用真实长时间 `sleep`；HTTP 与 Browser 测试使用系统临时目录中的测试 Profile、本地受控站点、离线页面 fixture 和 fake DNS，并覆盖批准的外部 JavaScript、未批准 tracker 丢弃、点击/脚本 redirect、跨 origin CDN、HTTP attachment、共享 context 文章分流与临时资源清理；不读取真实用户 Profile/凭据，也不连接真实供应商、机构登录或用户语料。
