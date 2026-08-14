# ADR 0015：访问方感知的三级 PDF 获取与 Browser 调度

- Status: Accepted
- Date: 2026-08-15
- Supersedes: none
- Amends: [ADR 0012](0012-process-local-provider-access-scheduling.md)、[ADR 0013](0013-decoupled-discovery-and-database-maintenance.md)、[ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[Acquisition 技术文档](../technical/acquisition.md)、[Network 技术文档](../technical/network.md)、[Entry 技术文档](../technical/entry.md)、[Provider Notes](../../notes/providers/README.md)

## 背景

SciRetriever 面向用户指定领域批量补全文献。公开仓储和官方 API 通常有明确的批量访问合同与相对宽松的并发/额度；使用用户账号、机构授权和 Cookie 的 Browser 页面流程成本更高，也更容易触发登录失效、MFA、challenge、账号或 IP 限制。因此现有“公开来源、授权 Provider API、受控 Browser”三级顺序是风险控制边界，不能因为 Browser 能处理出版社页面就改成默认 Browser-first。

另一方面，逐篇 Literature 让每个 Source 分别判断适用性并完整走完三层，会丢失 DOI 解析、API object locator、canonical landing 和稳定文章 ID 等中间知识，也无法在批量任务中先用低风险路径消化全部目标。Browser 若被当成普通第三个 Source，也无法按访问供应商复用会话、独立限速、暂停或熔断。

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

Resolution 优先消费已有中性事实，只有强证据不足且本次计划需要时，才在公开层安全解析一次 DOI landing。证据强度为：

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

Browser 调度键是 `browser_rate_limit_group`，不是展示名称、Metadata Provider、DOI 或单篇任务。共享同一网页政策、账号、会话平台、quota 或风控域的品牌进入同一组；有证据证明独立的风险域才可拆分。

每个 Browser 风险组固定满足：

```text
max_concurrency = 1
provider-declared article interval/window policy
one next_allowed_at / blocked_until
one session health / circuit state
```

不同风险组可以并行运行各自一个文章流程；同一组内严格限速串行。全局 Browser concurrency 只作为本机 CPU、内存和 runtime 数量的资源上限，不能把不同供应商重新设计成一个全局业务锁。

Browser 限速单位是一篇文章的受控流程。Permit 从 canonical landing 第一次导航前持有，覆盖登录/授权标记检查、有限页面动作、popup/viewer、response/download 捕获、临时文件和页面资源完整清理。失败重试也重新排队并服从同一政策；多个标签页、redirect、selector fallback 或换入口不能绕过组内串行和间隔。页面子资源由 host admission 与导航、请求、popup、下载、字节和总时长预算约束，不把每个 CSS/JS 请求误当下一篇文章。

### 6. Browser 使用受控持久会话

`browser_session_key` 与 rate-limit group 分开表达会话复用范围。Operator-managed Browser session profile 保存于用户级专用目录，是与 `PublisherAccessProfile` 不同的敏感会话材料；它不进入 `credentials.toml`、普通配置内容、Catalog、ArtifactStore、Report、provenance 或日志，配置只引用安全的 session profile identity 并显示 configured/missing/action-required。

同一 session key 的多篇论文可以复用合法登录状态，不重复登录；页面、context、Cookie、download 或 Browser vendor object 不越过 Network/Acquisition adapter 边界。自动 Completion 不填写账号、选择机构、处理 MFA/CAPTCHA、绕过 challenge 或执行任意 JavaScript。人工登录只能由用户显式发起的可见 Browser 配置操作完成。

`PublisherAccessProfile` 必须在每次 navigation、popup、viewer、response 和 download 实际访问前实施封闭 origin/target guard，并同时通过 Network 的通用 URL、DNS、redirect、credential forwarding、host admission 和资源预算。未知站点没有 generic arbitrary-site Browser fallback。

Browser 可以从受控 download event、PDF response、允许的 popup/viewer 或已核实官方 locator 交付 `TemporaryPdf`。正文与 supplementary material 必须按稳定文章 ID、origin 和 Profile 规则区分；下载事件、扩展名或媒体类型仍不能替代统一 PDF reader/页面树检查。

### 7. 升级、暂停与熔断语义

以下低风险终态可以进入 Browser admission：明确不适用、正常未命中、明确无 PDF capability，以及 API 对具体目标无 entitlement 但 operator Browser 会话可能具有独立机构授权。

以下状态不得通过自动切换 Browser 制造替代流量：timeout、临时传输或服务失败、`429`、有效 `Retry-After`、quota exhausted、未到 reset boundary。它们形成延期或稳定失败，并更新共享 scope。支持的 API 未配置时必须明确报告；只有 Browser 已由用户显式启用且 admission policy 允许时才可继续，不能静默跳过。

Browser 的 `LOGIN_REQUIRED`、`MFA_REQUIRED`、`CHALLENGE_REQUIRED`、`RATE_LIMITED`、`IP_BLOCKED`、可疑 403 或账号警告暂停或熔断对应风险组；其它独立 Provider 继续。自动策略只能保持或降低速率，不能因连续成功自动提速，也不能通过新 Literature、重试或备用入口绕过 circuit。

只有所有适用 routes 正常结束且不存在 deferred、action-required、未解决 route failure、配置/Port/清理/发布/stale 错误时，Acquisition 才能提交 `AutomaticPdfAcquisitionExhaustion` 并返回 `NoPrimaryPdf`。

### 8. 运行状态不成为文献事实

Resolution、Plan、route hints、tried keys、Browser queue、session health、登录/MFA/challenge、`next_allowed_at`、`blocked_until`、circuit 和候选失败只服务当前操作。它们可以形成脱敏实时进度；需要用户处理或延期的目标只通过现有 `DatabaseCompletionReport.failed` 中稳定的 `code/reason/action/retryable` 表达，不新增 Report 分区、自由 `details` 或第二套 counts。它们不形成 Literature 状态、数据库表、Artifact、provenance、可恢复任务或跨运行失败历史。

进程退出后不恢复这些动态状态；仍遵守 ADR 0012 的非跨进程保证。静态 `PublisherAccessProfile`、官方政策和 operator 收紧配置可以持久加载，敏感 Browser session profile 可以由 operator 在用户目录中维护；两者都不等于持久化当次计数、队列、session health 或 circuit，Cookie 内容也不进入产品配置和业务存储。

## 后果

- 三级架构继续保护用户账号和机构会话，Browser 不成为默认大批量入口。
- Publisher recognition 为公开、API 和 Browser 共享，但识别本身不会启动 Browser。
- 批次低风险层先消化目标，Browser 只处理最小剩余集合。
- API 取得的 locator/稳定 ID 可以降低 Browser 导航和无效点击，但不会污染数据库。
- 不同 Provider Browser 可以并行；同一风险组始终串行并服从自己的政策。
- 一个 Provider 的登录、限速或熔断不会无关阻塞其它 Provider。
- 新 Provider 必须经过 Profile、官方政策、origin guard、正文归属、fixture 和明确验证门，不能通过 generic fallback 猜测接入。
- Browser 会比公开/API 慢，CLI 和 Report 必须把等待、预计时长和 action-required 清楚呈现。
- Requirements R3 的二值结果、最低 PDF 检查、不可变发布、唯一主 PDF 和耗尽边界不改变，不需要新增持久 schema。

## 不采用的方案

- 所有论文默认 Browser-first；
- 识别出 Publisher 后自动跳过仍适用的公开/API 路线；
- 每篇 Literature 私建 limiter、Browser process 或 session；
- 所有 Provider Browser 全局串行；
- 同一 Provider 多标签页或多 worker 并发；
- 固定一个数字冒充所有 Provider 的官方 Browser 间隔；
- API rate-limit 后立即切 Browser；
- 任意未知站点 Browser fallback、任意 JavaScript、CAPTCHA/MFA 绕过、代理或指纹规避；
- 把 Cookie、页面、候选失败、队列或限速状态写入文献数据库。

## 需要新 ADR 的变化

以下变化需要新的 owner 决策：

- 改变默认 Public -> API -> Browser 风险顺序或允许自动 Browser-first；
- 允许同一 Browser risk group 并发多个文章流程；
- 取消 Provider policy、origin guard、统一 Network 准入或 Browser action 安全边界；
- 把动态 plan、queue、session、限速、Cookie 或失败历史持久化为产品状态；
- 增加跨进程、跨重启或跨机器的 Browser/API 配额协调；
- 引入自动登录、MFA/CAPTCHA 处理、反检测或任意未知站点执行能力。

单个 Provider 的 endpoint、selector、官方限速数字、origin、产品 capability 和 evidence 日期变化不需要新 ADR，但必须更新 Provider Notes、Profile revision、adapter policy 和直接测试，且不能放宽本 ADR 的层级与安全边界。
