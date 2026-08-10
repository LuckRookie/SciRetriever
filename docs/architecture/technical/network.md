# Network 模块技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 设计责任：[设计文档 5.2](../design.md#52-网络基础设施)
- 长期决策：[ADR 0012](../decisions/0012-process-local-provider-access-scheduling.md)
- Provider 与凭据：[ADR 0014](../decisions/0014-capability-scoped-providers-and-local-credentials.md)、[Configuration 技术文档](configuration.md)
- 外部事实：[Provider 注意事项](../../notes/providers/README.md)

本文定义目标 `src/sciretriever/network/` 的共享访问政策、进程内供应商级准入、安全 HTTP 和受控浏览器实现。Network 负责协议无关的安全访问与限速执行，不理解供应商业务协议，也不判断文献身份、PDF 归属或文献状态。

## 1. 目标结构

```text
network/
  policy.py
  admission.py
  http.py
  browser.py
```

- `policy.py` 形成 URL、DNS、redirect、origin、credential forwarding、资源预算和脱敏决定；
- `admission.py` 定义 AccessScope、规范化访问政策和进程内共享 Access Coordinator；
- `http.py` 执行同时符合 policy 与 admission 的普通 HTTP 请求；
- `browser.py` 执行符合相同边界的隔离浏览器操作。

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

`bootstrap.py` 对每个 SciRetriever 进程只构造一个共享 Coordinator，并把它注入 HTTP 和 Browser。当前进程中的 Metadata、Acquisition、Parsing、Analysis、不同 Literature 和不同用户操作不能获得互不知情的 limiter。

Coordinator 的逻辑 scope 状态与精确 host 状态同时生效：

- 同一 provider 的多个允许 origin 共享 provider scope；
- 不同 provider 的候选最终落到同一 host 时共享 host budget；
- redirect 到新 host 前必须先通过目标 policy 与目标 host admission；
- 未知站点按规范化 host 建立保守 `web` scope，使用并发 1 和至少 30 秒冷却；
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
```

这些值不得携带 DOI、Literature ID、candidate key、完整 URL、header、Cookie、secret reference/value、响应正文、底层异常或逐请求失败。它们不进入业务 Model、SQLite Catalog、ArtifactStore、provenance、日志合同或独立协调文件。Network 不创建限速表、协调数据库、协调目录、跨进程 advisory lock、lease marker 或可恢复的 rate-limit 现场。

进程退出或崩溃后，全部动态限速状态自然消失；新进程从静态访问政策和 operator 配置重新建立 Coordinator，不延续旧进程的网页冷却、`blocked_until` 或 API 窗口。多个并发 SciRetriever 进程各自限速，当前产品不提供跨进程、跨重启或跨机器的供应商额度协调。Storage 为保护同一 Catalog 而使用的核心写入 advisory lock 是独立的数据库完整性机制，不属于 Network。

静态访问政策、最低网页冷却、API 规则和 operator 收紧值仍由配置与 Provider Notes 持久表达；“规则持久化”不等于“动态计数和截止时间持久化”。Network 不拥有数据库补全编排，也不参与文献事实写入。

## 6. 网页访问规则

同一 provider 的 `web` scope 在当前进程内固定满足：

```text
max_concurrency = 1
cooldown_after_completion >= 30 seconds
```

普通 HTTP landing-page discovery、出版社站内直接 PDF 和受控浏览器流程都使用对应 provider 的网页 scope。浏览器 permit 从第一次导航前持有到 page、context、popup、download 和临时文件全部清理；成功、无结果、页面失败、timeout、取消和 challenge 都在清理后进入至少 30 秒冷却。供应商政策更严格时使用更长间隔。

浏览器页面加载会产生多项子资源请求；网页 permit 覆盖完整顶层流程，Network 另以资源预算限制请求数量、导航、popup、下载和总时长。页面脚本、selector 重试或重新创建 context 不能取得第二个并行 permit或绕过冷却。

同一 provider 的 API 使用独立 `api` scope，因此网页流程占用或冷却期间，API 可以继续按其真实政策运行。其它 provider 和公开仓储也使用自己的 scope，不被无关网页流程阻塞。

## 7. API 访问规则

API adapter 根据当前官方政策和产品 entitlement 声明并发、间隔、burst/window 和周期额度。API 不继承统一 30 秒网页冷却，也不能默认无限制。API key 已配置、认证成功、quota 可用和目标内容 entitlement 分别判断。

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

## 9. 浏览器实现

`browser.py` 负责：

- 在流程开始前取得 provider `web` 与适用 host permit；
- 浏览器进程生命周期；
- 隔离 context；
- operator-managed profile 的受控使用；
- 请求拦截和顶层导航目标复检；
- 页面、popup 和下载捕获；
- 导航、页面、下载和临时文件资源上限；
- 成功、失败、取消和超时后的完整清理、permit 释放和冷却登记。

来源专属 selector、点击顺序、登录状态识别和目标页面判断放在 `acquisition/sources/<source>/`。浏览器下载事件只产生临时获取结果，不能直接发布当前主 PDF。Cookie、profile、header、短期签名 URL 和页面对象不进入 `PdfCandidate`、SQLite、provenance 或日志。

## 10. 调用方向

```text
metadata.providers       -> network.http
acquisition.sources      -> network.http and/or network.browser
parsing.mineru           -> network.http
analysis.providers       -> network.http
bootstrap provider probe -> network.http

network.http              -> network.policy + network.admission
network.browser           -> network.policy + network.admission
```

消费模块公开 API、规则和用例不得看到 URL client、header、cookie、HTTP response、Playwright page/context、浏览器 download 或 permit 类型。只有对应 adapter 可以使用协议技术类型；AccessScope 和 policy 只用于 Network 准入，不进入业务 Model。

## 11. 凭据、配置测试与诊断

- Network 不读取普通 TOML、环境变量、`~/.sciretriever/credentials.toml` 或任何 secret reference/value；Provider secret 由根级 configuration 私有解析，再由 `bootstrap.py` 注入具体 adapter；
- Adapter 声明允许附着凭据的 origin 和不含 secret 的 quota scope；
- 跨 origin redirect 默认移除凭据，除非 policy 明确允许；
- 凭据值不得进入 scope、内存限速状态、日志、异常、诊断、SQLite、provenance、URL、文件名或用户输出；
- Network 在错误离开 HTTP/Browser 边界前，把协议异常和不可信网络值转换为稳定、脱敏的中性失败；消费模块与 Entry 不接触原始异常或 response；
- 原始 exception、HTTP response、response body、完整 URL、header、Cookie、credential 和短期签名参数不得作为 LogRecord 的 message 参数或 `extra`；
- Provider adapter 仍负责供应商私有响应和 SDK 异常的脱敏，Logging 模块的统一 Filter 只能作为最后防护，不能替代各 adapter 的边界转换。

`config status` 是纯本地 configuration/readiness 检查，不得调用 Network。用户显式执行 `config test <provider>` 或 `config test --all` 时，Bootstrap 组装的 Provider probe 必须像普通 adapter 一样经过共享 Coordinator、安全 HTTP、URL/DNS/redirect、timeout、响应预算、quota、`Retry-After` 和脱敏。Probe 只做官方允许的最小只读请求；Network 不因它是配置测试而绕过限速，也不把认证成功解释为任意 Literature 的全文 entitlement。

Network 只返回本次中性、脱敏的 probe 结果。配置测试不创建 DiscoveryRun、MetadataObservation、ProviderRelationObservation、Asset、Report、Catalog/ArtifactStore 事实或持久日志，也不保存最后测试时间、连接状态、permit 或服务健康状态。

底层异常和响应正文只能作为边界内诊断输入，不能成为持久业务合同。限速诊断可以 best-effort 表达脱敏 scope、等待类别和下次允许时间，但这些值不是稳定日志合同，不能被 Report 或业务逻辑解析，也不能包含目标文献、URL 或凭据身份。日志丢失、过滤或 handler 故障不得改变 permit、冷却、返回结果或数据库事实。

## 12. 资源、并发与取消

Entry 可以有界并发处理不同 Literature，Metadata 可以逻辑并发查询多家供应商；所有真实访问仍由 Coordinator 按 scope 与 host 门控。Network 同时执行每 host 连接预算和协议无关资源上限。Provider quota 含义由对应 provider/source/parser/LLM adapter 解释，跨文献业务并发仍由 Entry 控制。

取消和 timeout 必须传播到实际网络或浏览器操作，不能只停止上层等待。取消 permit 等待不能占用并发名额；已取得 permit 后取消必须完整清理并更新适用冷却。Late response 不得在调用已结束后成为有效结果。

## 13. 验收

直接安全测试至少覆盖：

- malformed URL、禁止 scheme/port/userinfo；
- 私网、loopback、link-local 和 DNS rebinding 风险；
- 越权 redirect、跨 origin 凭据剥离和逐跳复检；
- timeout、取消、oversize 和 late response；
- HTTP 与 Browser 使用等价 URL/DNS/redirect/origin/redaction policy；
- 同一 scope 在当前进程的不同模块、任务和用户操作之间共享，不为每个 adapter 重建 limiter；
- 同一 API quota 被 Metadata 与 Acquisition 共用时相互限速，独立 API product scope 不错误互锁；
- 同一 provider 网页普通 HTTP 和 Browser 在当前进程最多一个活动流程，成功、失败、timeout 和取消后都至少冷却 30 秒；
- provider 网页占用期间，其独立 API scope、其它 provider 和公开仓储可以推进；
- 公开/direct URL 指向出版社网页时仍使用该 provider `web` scope；不同来源落到同一 host 时共享 host budget；
- redirect 到新 provider/host 前取得目标准入，不能利用 redirect 绕过网页冷却；
- `429`、`Retry-After`、窗口额度和 `blocked_until` 对共享 scope 的后续调用生效；
- 缺少明确 AccessPolicy 的 production adapter readiness 失败，operator 配置不能放宽安全下限；
- 当前进程内取消、timeout 和失败不会泄漏 permit，也不会绕过仍有效的冷却或 `blocked_until`；
- 等待队列、permit、时间截止和额度计数只存在于内存，不创建限速表、协调目录、状态文件、lease 或跨进程锁；
- 新 Coordinator 不恢复旧进程状态，测试和文档不宣称跨进程或跨重启限速保证；
- Browser context、profile、page、download 和临时目录完整清理；
- Provider 页面流程不能绕过 PDF 基本检查直接发布资产；
- 凭据不出现在任何持久化或用户可见输出中；
- `config status` 完全不触发 Network；`config test` 通过同一 Coordinator 和安全访问边界，单项失败不泄漏 secret，且不持久化测试结果、时间或文献事实；
- 原始 exception、response、URL、header、Cookie、credential 和 response body 不进入 LogRecord；边界脱敏先于 Logging filter，限速日志的缺失不影响准入结果。

限速和 `config test` 测试使用 fake clock、同进程并发任务、fake adapter 与 fake transport；HTTP 与 Browser 测试使用本地受控站点和 fake DNS，不读取真实用户凭据，也不连接真实供应商、机构登录或用户语料。
