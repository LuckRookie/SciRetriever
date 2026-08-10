# ADR 0009：供应商级全局访问调度

- Status: Superseded by [ADR 0012](0012-process-local-provider-access-scheduling.md)
- Date: 2026-08-07
- Superseded by: [ADR 0012：进程内供应商访问调度](0012-process-local-provider-access-scheduling.md)
- Supersedes: [多下载源可用性与合理访问限制提案](../../archive/2026-08-provider-access/acquisition-source-availability-and-access-limits.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[Network 技术文档](../technical/network.md)、[Acquisition 技术文档](../technical/acquisition.md)、[Provider Notes](../../notes/providers/README.md)

> 本 ADR 保存已经撤销的同机跨进程访问协调设计，不再约束当前目标架构。当前进程内共享准入、内存限速状态和非跨进程边界以 ADR 0012 为准。

## 背景

SciRetriever 会并行处理多篇文献，Metadata、Acquisition、Parsing 和 Analysis 也可能分别访问同一个外部机构。只在单个 adapter、单篇文献或单个批次中限速，会让多个调用方分别认为自己没有超限，合计却超过供应商的并发、请求间隔或周期额度。普通 HTTP、授权 Provider API 和浏览器访问还可能落到同一供应商的不同域名；仅按原始候选来源或精确 hostname 限制，无法阻止通过其它 adapter、redirect 或域名别名绕过同一访问预算。

PDF 获取又具有不同访问成本。Owner 已确认 Acquisition 对同一 Literature 必须按“公开来源、已授权 Provider API、受控浏览器”三个阶段串行短路；浏览器网页访问是最后阶段，并且不能因为批量任务并发而同时打开同一供应商的多个页面流程。Metadata 搜索仍可以并行调用多家供应商，但每个真实网络请求都必须服从该供应商自己的全局访问限制。

供应商的公开限速、配额产品和响应头会变化，不能把所有当前数字永久写入 ADR；但“任何外部访问都不能无限制发起”以及“限速必须在所有调用方之间全局执行”是长期安全边界。

## 决策

### 1. 所有外部访问必须先经过共享准入

Metadata 搜索、元数据引用关系查询、公开资产来源、授权资产 API、普通网页访问、受控浏览器、外部 parser 和 LLM provider 的真实网络操作都必须先经过 Network 的共享访问准入。功能模块、provider adapter、vendor SDK 和浏览器页面流程不得绕过该边界直接发起不受控请求。

`bootstrap.py` 为一个本机 SciRetriever 部署构造同一个全局 Access Coordinator，并注入安全 HTTP 与受控浏览器。不同 Literature、批次、功能模块和 adapter 共享它；不能为每个调用方建立互不知情的 limiter。

### 2. 规则由 adapter 声明，Network 全局执行

Provider 或 service adapter 负责解释并声明当前官方政策、产品/凭据额度范围、分页和 `429`、`Retry-After`、额度响应头等供应商语义。Network 不硬编码 Crossref、Elsevier、arXiv、MinerU 或 LLM 的业务协议，只接收已经规范化的访问范围、并发、最小间隔、窗口额度和阻塞截止时间，并在所有调用方之间统一执行。

生产 adapter 没有明确访问政策时 readiness 不通过。Operator 配置可以收紧已接受的安全政策；不能通过普通运行配置把官方限制或项目安全下限放宽。易变数值、证据日期和具体 endpoint 归各 Provider Notes 或对应外部服务 Notes 维护，不进入本 ADR。

### 3. AccessScope 按供应商和访问通道划分

运行时访问范围至少由以下中性维度确定：

```text
AccessScope
  provider_name
  channel: "api" | "web"
  service_name: str | None
```

`service_name` 只在供应商官方政策确实把不同 API 产品或额度池分开时使用。共享同一 key、账户、quota 或官方额度池的 metadata、reference query 和 PDF API 请求必须使用同一 scope；明确属于独立产品和独立额度池的请求可以分开。AccessScope 不携带 secret 值、DOI、Literature ID、完整 URL 或用户身份，也不进入业务 Model。

API 与网页是不同通道。某个供应商的网页流程占用时，其 API 可以继续按 API 自身规则运行；其它供应商或公开仓储也使用各自 scope，不被无关供应商阻塞。

### 4. 网页通道全局独占并具有最低冷却

同一供应商的 `web` scope 在一个本机部署内最多允许一个活动网页流程。普通 HTTP 获取该供应商的 landing page 或站内直接文件，以及受控浏览器导航、点击、response/download 捕获，都属于该供应商的网页访问，不能因为候选处于 Acquisition 的“公开来源”阶段而绕过网页 scope。

浏览器 permit 从第一次导航前持有到 page/context/download 完整清理。网页流程无论成功、失败、超时或取消，彻底结束后到下一次同供应商网页流程开始前至少冷却 30 秒；供应商规则更严格时使用更长间隔。登录、MFA、challenge 或页面失败不得通过高频重启绕过冷却。

### 5. API 通道遵守供应商真实规则

API 不使用统一 30 秒规则。每个 adapter 按已核对的供应商政策声明并发、最小请求间隔、burst/window quota 和必要的额度范围。运行时 `Retry-After`、限流响应和明确的额度截止可以把对应 scope 更新为更严格的 `blocked_until`；没有 `Retry-After` 也不得立即高频重试。

API key 已配置、认证成功和目标全文 entitlement 是不同事实。限速准入不能把凭据存在解释为内容授权，也不能把授权失败解释为可以提高请求频率。

### 6. 供应商范围与实际主机范围同时生效

Adapter 为一次访问声明稳定 provider scope 和允许 origin；Network 还按每次实际连接、redirect、浏览器顶层导航和下载目标执行 host 预算与 URL/DNS/origin policy。不同来源最终访问同一出版社网站时必须共享该网站的网页预算。未知站点按规范化 host 建立保守网页 scope，至少使用并发 1 和 30 秒冷却，直到形成经过核对的供应商政策。

公开状态不是限速豁免。例如公开 `AssetHint` 指向 Elsevier 网页时，该尝试仍同时属于 Acquisition 的公开阶段和 `elsevier:web`；它可以匿名访问，但不能与另一个 Elsevier 网页流程并发。

### 7. 全局范围覆盖同机并发进程

“全局”指同一个本机 SciRetriever 部署中的任务、批次和进程，不只是一份 Python 对象或单个 CLI 进程。Access Coordinator 必须通过本机共享协调保证同一 scope 的活动租约、`next_allowed_at` 和 `blocked_until` 对并发进程可见。该要求不引入跨机器调度、分布式任务所有权或 network exactly-once。

共享协调状态是短小的运行技术状态，不是文献业务事实。它不得保存 DOI、Literature ID、候选、URL、header、Cookie、secret、响应正文或失败详情，也不得参与 Literature 状态推导。具体本机锁和状态文件边界由 Network 技术文档定义。

### 8. 业务并发与网络准入正交

Entry 可以有界并行等待不同 Literature；Metadata 可以并行组织多供应商；Acquisition 对同一 Literature 仍按三个阶段和各阶段 Source 顺序串行短路。任何逻辑并发最终都必须在真实 HTTP、redirect 或浏览器操作前取得适用 scope 的 permit。

等待 permit 不等同于来源失败，也不产生新的 Literature、Acquisition 或批量业务状态。取消、timeout 和进程退出必须释放活动租约；已经计算的冷却或 `blocked_until` 不能因失败和快速重启被静默清空。

## 后果

- 多个模块和批次不能分别绕过同一供应商的 API 配额或网页冷却。
- 同一供应商网页访问被串行化，但该供应商 API、其它供应商和其它公开来源仍可独立推进。
- PDF 获取不会通过跨阶段竞速提前消耗授权 API 或启动浏览器；批量吞吐主要来自不同 Literature 和不同 scope 之间的有界并发。
- Provider adapter 必须具有可审查的 scope、官方政策依据、`Retry-After`/quota 解释和离线限速测试，才能成为 production-ready。
- Network 增加本机共享访问协调责任，但不拥有供应商业务协议、文献判断或业务状态。
- `LiteratureMetadata`、`AssetHint`、`PdfCandidate`、`Asset`、`LiteratureAsset` 和 `AcquisitionResult` 不增加限速字段；网页/API 等已接受资产来源仍通过正常 provenance 表达。
- 当前源码中的进程内 host budget 和候选竞速不是该目标设计已经实现的证据；实现、配置和用户文档只有在完成直接测试与对象图接线后才能宣称支持。

## 需要新 ADR 的变化

以下变化需要新的 owner 决策：

- 允许 provider adapter、vendor SDK、普通 HTTP 或浏览器绕过共享访问准入；
- 取消同一供应商网页全局独占，或把最低 30 秒冷却降低；
- 把“全局”缩小为单篇文献、单个 batch 或单个进程；
- 允许普通配置放宽官方限制或项目安全下限；
- 把 rate-limit 运行状态、凭据或逐请求详情写入文献业务 Model、catalog 或状态；
- 引入跨机器配额协调、分布式调度或外部工作流平台。

供应商 API 的具体限速数字、endpoint、产品额度和 evidence 日期变化不需要新 ADR；它们按 Provider Notes 和 Provider 接入流程更新，只能保持或收紧本 ADR 的长期边界。
