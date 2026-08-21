# ADR 0012：进程内供应商访问调度

- Status: Accepted
- Date: 2026-08-09
- Supersedes: [ADR 0009：供应商级全局访问调度](0009-provider-scoped-global-access-scheduling.md)
- Amended by: [ADR 0015](0015-publisher-aware-tiered-pdf-acquisition.md)
- Related: [ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)、[产品需求](../requirements.md)、[设计文档](../design.md)、[配置与凭据技术文档](../technical/configuration.md)、[Network 技术文档](../technical/network.md)、[Acquisition 技术文档](../technical/acquisition.md)、[Provider Notes](../../notes/providers/README.md)

## 背景

SciRetriever 会在一次运行中并行处理多篇文献，Metadata、Acquisition、Parsing 和 Analysis 也可能访问同一个外部机构。如果每个 adapter、单篇文献或单个批次分别限速，它们会各自认为没有超限，合计却可能超过供应商的并发、请求间隔或周期额度。普通 HTTP、授权 Provider API 和浏览器访问也可能落到同一供应商的不同域名，因此同一进程中的真实外部访问仍需要共享的供应商级准入。

[ADR 0009](0009-provider-scoped-global-access-scheduling.md)进一步要求同机并发进程共享活动租约、冷却截止和额度窗口。Owner 随后明确当前产品是个人使用的单机工具，不要求多个 SciRetriever 进程同时协调，也不要求进程重启后延续上一进程的冷却或 API 窗口。为小概率的并发进程和快速重启持久化运行限速状态，会引入协调目录、状态文件、锁和恢复规则，但不改善主要个人使用流程。

静态访问政策与动态限速状态需要继续分开：供应商政策、项目安全下限和 operator 收紧配置是可重复加载的配置；当前活动请求、等待队列、额度计数、冷却截止和 `Retry-After` 阻塞只服务正在运行的进程，不是文献事实。

## 决策

### 1. 所有外部访问经过当前进程的共享准入

Metadata 搜索、元数据引用关系查询、公开资产来源、授权资产 API、普通网页访问、受控浏览器、外部 parser 和 LLM provider 的真实网络操作，都必须先经过当前 SciRetriever 进程内由 Network 提供的共享 Access Coordinator。功能模块、provider adapter、vendor SDK 和浏览器页面流程不得绕过该边界直接发起不受控请求。

`sciretriever.bootstrap` 每个 SciRetriever 进程只构造一个 Coordinator，并注入安全 HTTP 与受控浏览器。当前进程内的不同 Literature、批次、功能模块和 adapter 共享它；不能为每个调用方建立互不知情的 limiter。

### 2. 规则由 adapter 声明，Network 在进程内执行

Provider 或 service adapter 负责解释并声明当前官方政策、产品或凭据的额度范围、分页和 `429`、`Retry-After`、额度响应头等供应商语义。Network 不硬编码 Crossref、Elsevier、arXiv、MinerU 或 LLM 的业务协议，只接收规范化的访问范围、并发、最小间隔、窗口额度和阻塞截止，并在当前进程的全部调用方之间统一执行。

生产 adapter 没有明确访问政策时 readiness 不通过。Operator 配置可以收紧已接受的安全政策，不能通过普通运行配置放宽官方限制或项目安全下限。易变数字、证据日期和具体 endpoint 归 Provider Notes 或对应外部服务 Notes 维护。

### 3. AccessScope 按供应商和访问通道划分

运行时访问范围至少由以下中性维度确定：

```text
AccessScope
  provider_name
  channel: "api" | "web"
  service_name: str | None
```

共享同一 key、账户、quota 或官方额度池的 metadata、reference query 和 PDF API 请求在当前进程内使用同一 scope；明确属于独立产品和独立额度池的请求可以分开。API 与网页是不同通道，因此一个供应商的网页流程占用或冷却时，其 API 可以继续按 API 自身规则运行。AccessScope 不携带 secret、DOI、Literature ID、完整 URL 或用户身份，也不进入业务 Model。

### 4. 网页与 Browser 按真实 Provider policy 准入

普通 HTTP 获取供应商 landing page 或站内直接文件，以及受控 Browser 的导航、点击、response/download 捕获，都属于该供应商的 `web` 访问；公开来源身份不构成限速豁免。普通 HTTP 的 `web` scope 并发、间隔、窗口额度与失败冷却由 adapter 根据供应商官方规则或已接受审慎政策声明，不固定为并发 1，也不继承 Browser 的文章间隔。

Browser 除了适用 `web`/host policy，还使用 Profile 声明的文章级政策。不再由架构硬编码一个适用于所有供应商的固定 30 秒。缺少可执行网页政策的 production adapter/Profile readiness 不通过；未知普通网页只使用明确标注的审慎默认，不能把猜测冒充供应商官方规则，且未知站点不因此获得 production Browser Profile。

Browser 还按照 [ADR 0015](0015-publisher-aware-tiered-pdf-acquisition.md) 的 `browser_rate_limit_group` 调度：不同风险组可以并行，同一组 `max_concurrency = 1` 并按组内政策限速串行。浏览器 permit 从第一次导航前持有到 page、context、popup、download 和临时文件完整清理；成功、失败、超时、取消和重试都不能绕过仍有效的 `next_allowed_at`、`blocked_until` 或 circuit。API 不继承 Browser 文章间隔，而是遵守对应 API 产品的真实官方政策。

### 5. 动态限速状态只保存在内存中

Coordinator 在当前进程内维护：

```text
等待队列和活动 permit
provider/channel/service 与 host 的并发状态
next_allowed_at
blocked_until
窗口额度计数和重置时间
当次 Retry-After 与保守退避
```

这些值不是文献事实，不进入 Pydantic 业务 Model、SQLite Catalog、ArtifactStore、provenance、日志合同或独立状态文件。Network 不建立限速表、协调数据库、协调目录、跨进程 advisory lock、lease marker 或可恢复的 rate-limit 现场。进程退出后全部动态限速状态自然丢弃；下一次运行从静态配置重新建立 Coordinator。

静态供应商政策、项目安全下限、Browser/Profile policy 和 operator 收紧值仍由 adapter/Profile、普通配置与 Provider Notes 表达。Provider 凭据按 [ADR 0014](0014-capability-scoped-providers-and-local-credentials.md) 从用户级 `credentials.toml` 解析并注入具体 adapter，但不进入限速状态；本地字段存在、认证成功和具体内容 entitlement 始终是不同事实。

### 6. 不提供跨进程与跨重启限速保证

同时运行的多个 SciRetriever 进程各自拥有独立 Coordinator；产品不保证它们共享并发、冷却、`Retry-After` 或额度窗口。进程退出后立即重启时，新进程不延续旧进程尚未到期的网页冷却或 API 窗口。当前个人使用边界明确接受这两种小概率情况，不为其引入持久化协调。

这项限制只作用于 Network 访问调度。Storage 为保护统一文献数据库而实施的一个 catalog 一个核心写入锁仍由 Storage 拥有，不因本 ADR 删除或放宽。

### 7. 业务并发与网络准入正交

Entry 可以有界并行等待不同 Literature，Metadata 可以逻辑并行组织多供应商；Acquisition 仍按公开来源、已授权 Provider API、受控浏览器三个风险层级短路，并在批量操作中先让 cohort 完成低风险层，再把最小剩余集合交给 Browser。不同 Browser risk group 可以并行，同一组内严格串行。任何逻辑并发最终都必须在当前进程的真实 HTTP、redirect 或浏览器操作前取得适用 scope 和 Browser group permit。

等待 permit 不等同于来源失败，也不产生 Literature、Acquisition 或批量业务状态。取消和 timeout 必须释放当前进程内 permit 并完成资源清理；当前进程仍在运行时，失败不能绕过已经形成的冷却或 `blocked_until`。

## 后果

- 同一 SciRetriever 进程内的模块、批次和文献目标不能分别绕过同一供应商的 API 配额、网页政策或 Browser risk-group 调度。
- 同一 Browser risk group 在进程内限速串行，但独立 risk group、该供应商独立 API scope 和其它公开来源可以按各自政策推进。
- Network 的动态状态完全留在内存，不属于由 SQLite Catalog 与 ArtifactStore 组成的统一逻辑文献数据库。
- 不实现跨进程协调目录、限速状态文件、活动租约恢复或进程重启后的剩余冷却恢复，代码、测试和文档也不得宣称这些保证。
- Provider adapter 仍必须具有可审查的 scope、政策依据、`Retry-After`/quota 解释和离线进程内限速测试，才能成为 production-ready。
- `LiteratureMetadata`、`AssetHint`、`PdfCandidate`、`Asset`、`LiteratureAsset` 和 `AcquisitionResult` 不增加限速字段；已接受资产来源仍通过正常 provenance 表达。
- 当前源码中的局部 host budget、候选竞速或调用方注入 client 不是目标进程内共享准入已经实现的证据；只有完成对象图接线和直接测试后，README 与用户指南才能把它写成当前能力。

## 需要新 ADR 的变化

以下变化需要新的 owner 决策：

- 允许 provider adapter、vendor SDK、普通 HTTP 或浏览器绕过进程内共享访问准入；
- 取消同一 Browser risk group 的进程内独占，或允许普通配置放宽 Provider/Profile policy；
- 把共享范围继续缩小为单篇 Literature、单个 batch 或单个 adapter；
- 增加同机跨进程、跨重启或跨机器的供应商配额协调；
- 把动态 rate-limit 状态、凭据或逐请求详情写入文献业务 Model、Catalog、ArtifactStore、provenance 或业务状态；
- 允许普通配置放宽官方限制或项目安全下限。

供应商 API/Browser 的具体限速数字、endpoint、产品额度、selector 和 evidence 日期变化不需要新 ADR；它们按 Provider Notes 和 Provider 接入流程更新，但不能绕过本 ADR 与 ADR 0015 的进程内共享准入、三级升级和安全访问边界。
