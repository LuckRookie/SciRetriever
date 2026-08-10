+++
document_type = "proposal"
status = "draft"
created = "2026-07-28"
+++

# 多下载源可用性与合理访问限制提案

> 归档说明：本提案已由 2026-08-07 接受的 [ADR 0009](../../architecture/decisions/0009-provider-scoped-global-access-scheduling.md)和当前 design/technical 取代。文内只覆盖 acquisition、只协调单进程以及供应商建议数值等内容均保留为历史讨论，不再构成当前目标设计或实施授权。

## 1. 提案状态

本文源于 2026-07-28 旧实现中多种全文来源无法稳定取得主文 PDF 的问题，讨论未来如何为下载过程增加符合供应商要求的访问限制。本文是活动提案，不授权实施，不修改当前配置或已发布行为，也不替代项目 README、Provider 注意事项或架构文档。带日期的实现事实只作为形成提案时的证据快照，不作为当前行为真相源；当前六层对象图没有可运行的多来源资产获取流程。

本提案只讨论 acquisition。metadata 搜索的分页、并发和限流需要单独评估，不纳入本文建议值。

## 2. 摘要

形成本文的 2026-07-28 旧实现曾列出 11 个资产获取入口，其中 10 个声明具有主文 PDF 能力，Springer Nature 只提供 XML/HTML。一次同期隔离试跑中，开放论文完成了 metadata 入库，但当次启用的获取路径耗尽后仍未得到合格主文 PDF，旧状态停留在 `ASSET_PENDING`。该试跑没有形成可公开归因的逐来源报告，因此只证明“当次来源组合未成功”，不能证明 11 个入口全部不可用。

当前六层实现只提供通用 source adapter、provider registry、调用方注入的 provider client 合同和 host concurrency primitive。Composition 没有把 provider registry 连接到 `CollectionService` 或 `ContentAssetService`，也没有构造供应商专用 client，因此不存在终端用户可运行的多来源资产获取流程。Schema v2 只表达通用 timeout、provider concurrency、host concurrency 和响应大小上限，没有逐来源请求间隔、周期额度、`Retry-After` 状态或 provider profile。本提案保留旧试跑与供应商规则作为问题证据，但不把已删除的 30 秒启动门、batch admission、profile 或 CLI runtime 写成当前能力。

本提案建议：

1. 每个外部下载来源都必须有明确的访问策略，即使策略只是继承保守默认值。
2. 同时执行“来源接口”和“最终下载主机”两层限制；同一主机由所有来源共享预算。
3. 官方规则、响应头、`Retry-After` 和项目保守默认值共同构成约束，实际执行始终采用其中更严格的限制。
4. 找不到可靠公开规则时，采用“同一主机每 30 秒最多启动一次请求、并发 1”的保守兜底。
5. 来源可用性必须区分已实现、已配置、已验证、受限和不具备主 PDF 能力，不能只用 provider 名称表达。

## 3. 背景与当前问题

### 3.1 当前产品要求

本提案针对当前 PDF-backed analysis 路径讨论来源可用性：`WorkVersion` 只有取得并验证合格的主文 PDF，才能进入该附加分析能力。核心产品需求只要求把受支持资产解析为轻结构化文本；XML/HTML 是否能满足通用解析，不由本提案限制。

当前 `ProviderRegistry` 可以为调用方注入的 `ResolverClient` 建立惰性 asset resolver，并为同一 provider 包装调用方注入的有界 transport。它没有 translator 或 browser 层，当前 Composition 也没有把 registry 连接到资产 Service。若本提案获批，resolver API 请求和最终候选下载都必须经过同一访问政策，随后仍要通过内容验证、文章身份验证和不可变接收。

### 3.2 来源数量与实际可用性不一致

形成提案时记录的外部能力与历史观察如下。该表不表示当前仓库提供对应 client：

| 来源 | 外部能力或历史观察 | 主要可用条件 | 主要风险 |
|---|---|---|---|
| Direct HTTPS | 目标资产 | catalog 已有可信 HTTPS 地址 | 最终主机不确定，没有统一供应商规则 |
| arXiv | 主文 PDF | 有 arXiv identifier | 批量 PDF 访问需要至少 3 秒间隔 |
| Crossref | 主文 PDF 候选 | Crossref 登记了 PDF link | link 可能需授权、失效或返回 HTML |
| Unpaywall | 开放主文 PDF 候选 | 配置联系邮箱且存在 OA location | 最终地址分散在不同仓储或出版社 |
| Europe PMC | 开放主文 PDF | 收录目标且存在开放全文路线 | 当前候选覆盖有限，未找到公开数字限速 |
| OpenAlex | 主文 PDF 候选 | API 可用且记录提供 PDF URL | 调用方 client 需要处理官方当前要求的 key；候选可能失效 |
| Semantic Scholar | `openAccessPdf` 主文 PDF | API 可用且记录提供开放 PDF | API key 初始限制为每秒 1 次；匿名请求共享公共额度并可能进一步受限 |
| Elsevier | 主文/补充 PDF、XML | API key、内容授权和附件 EID 可用 | 真实样本出现外层超时；一个 PDF 需要多次 API 请求 |
| Wiley | 主文 PDF | TDM token 和内容授权有效 | 官方要求 10 秒请求间隔；当前没有供应商专用 client 或访问 profile |
| Springer Nature | XML、HTML | API key 和对应产品授权有效 | 外部资料不证明主文 PDF 能力，当前也没有具体 client |
| Sci-Hub | 主文 PDF | operator 显式提供获准 endpoint 与 client | 无统一官方限速，无 live 验证，也没有默认 endpoint 或具体 client |

表中的能力来自供应商资料或带日期的历史观察，不证明当前凭据、授权、网络、候选地址和供应商服务可以共同完成下载。当前接入状态以 [Provider 注意事项](../../notes/providers/README.md)、Composition wiring、源码和直接测试为准。后续产品呈现和诊断应避免把这些状态合并为一个简单的 available/unavailable 布尔值。

### 3.3 当前访问限制的缺口

当前 schema v2 的 `[assets]` 只定义以下通用边界：

- provider 选择键；
- 默认 30 秒的单次 operation timeout；
- 默认 4 的 provider concurrency；
- 默认 2 的 host concurrency；
- 默认 100 MiB 的响应大小上限。

这些字段不是供应商专用访问策略，也没有公开配置模板或命令行覆盖合同。`HostBudgetManager` 提供进程内精确 hostname 并发限制，但当前对象图没有把 provider registry 连接到资产 Service；resolver API 的具体网络行为仍属于调用方注入的 client。当前代码没有逐来源最小间隔、周期额度、`Retry-After` 预算或 provider profile，不能声称已经执行表中的供应商规则。

因此当前模型存在四类缺口：

1. **官方限制未建模。** Semantic Scholar、arXiv、Crossref、Unpaywall 和 Wiley 都没有当前 provider policy。
2. **来源接口和最终下载分属不同边界。** 调用方注入的 resolver client 可以查询 API，通用 fetcher 再访问候选地址，二者没有共享的来源与主机预算合同。
3. **同一来源可能包含多次请求。** Elsevier 等来源可能先查询元数据或附件，再下载文件，通用 timeout 和并发值不能表达请求间隔。
4. **周期额度没有统一表达。** Unpaywall 有每日调用量，Elsevier 有每周额度，OpenAlex 和 Springer 有每日额度或预算，仅靠并发限制不足以表达。

## 4. 目标与非目标

### 4.1 目标

- 让每个外部 acquisition 请求都有可解释的访问限制来源。
- 遵守供应商公开限速、响应头和重试要求，避免因请求过快导致 `429`、封禁或服务压力。
- 防止多个 provider 同时请求同一最终网站而绕过限制。
- 把来源自身不可用、凭据/授权不足、被限流、无候选和最终 PDF 验证失败区分开。
- 不增加后台任务系统，并保持 ADR 0002 规定的单机、部分成功和已提交事实可继续补全边界。

### 4.2 非目标

- 不在本文中调整 metadata 搜索的限流或分页。
- 不承诺某个 provider 的通用下载成功率。
- 不通过提高并发、切换镜像或浏览器反检测绕过供应商限制。
- 不引入 daemon、跨机器配额协调、durable scheduler 或外部工作流平台。
- 不把 XML/HTML 改为主文 PDF 的替代品。
- 不在提案阶段修改代码、配置 schema、默认值或用户文档。

## 5. 建议的访问控制原则

### 5.1 每个来源都有策略，但不要求每个来源都有完全独立的数值

每个外部来源必须映射到一项策略。能够找到可信官方规则时使用官方规则；找不到时继承统一的未知来源策略。这样可以确保没有 provider 因为缺少专属 profile 而意外使用过快的通用默认值。

### 5.2 来源接口与最终主机两层限制

一次下载可能包含两个不同阶段：

```text
provider API / resolver host
  -> 返回一个或多个候选地址
  -> final PDF host
  -> 下载并验证内容
```

- **来源接口限制**负责 Semantic Scholar、Crossref、Unpaywall、Elsevier 等 API 请求。
- **最终主机限制**负责候选 PDF 实际所在的网站。
- 如果不同 provider 的候选指向同一主机，必须在同一 SciRetriever 进程内共享该主机预算。
- 同一请求同时受来源规则和主机规则约束时，使用更严格的限制。

本提案中的“同一主机”指经过 URL policy 验证、规范化为小写的精确 DNS hostname。每次重定向都必须先复检，随后受重定向目标 hostname 的预算约束。首版不把不同 hostname 自动合并为同一可注册域，避免把共享 CDN 或多租户主机错误地视为同一供应商。

### 5.3 规则优先级

建议按以下顺序收集约束：

1. 当前响应中的 `Retry-After` 和明确的限流/额度响应头；
2. operator 对特定凭据、订阅或获准 endpoint 配置的限制；
3. 已核对的供应商公开规则；
4. 项目内维护的保守静态规则；
5. 未知来源兜底：同一主机 30 秒一次、并发 1。

这些规则不是“靠前的规则覆盖靠后的规则”。实际最小间隔取所有适用值中的最大值，实际并发和周期额度取所有适用值中的最小值；任何响应头或 operator 配置都不能把项目保守默认值放宽。静态规则是启动上限，不代表系统应主动跑满供应商允许的最高请求率。下载是长响应，保守值通常比官方硬上限更适合作为默认运行速度。

### 5.4 `429` 与周期额度

- 收到 `429` 后不得立即重试；存在 `Retry-After` 时，同一来源在该时间结束前不得再次请求。
- 没有 `Retry-After` 时使用有上限的退避，并降低该来源后续速度。
- 对每日或每周额度，应读取供应商响应头并在额度耗尽前停止该来源，而不是把额度耗尽伪装成网络失败。
- `Retry-After` 超过当前 provider timeout 或 invocation 剩余 deadline 时，不延长整个前台任务；该来源以 `limited` 结束，并保留可脱敏表达的下次可重试提示。
- 首版共享预算只约束当前进程，不协调不同调用方进程或不同 catalog。本文建议通过保守默认值和 operator 使用约束降低风险，不为了跨进程或跨机器精确共享配额引入 durable 调度状态。

## 6. 建议的首版下载限制矩阵

下表是待 owner 评审的建议值，不是当前实现或已发布默认值。

| 来源 | 已找到的公开规则 | 建议静态运行值 | 最终候选主机 |
|---|---|---|---|
| Direct HTTPS | 无统一规则 | 不设置来源 API 额度 | 未知时 30 秒一次、并发 1 |
| arXiv | 大量文章下载至少间隔 3 秒；超过 1000 篇应联系 arXiv | 3 秒一次、并发 1 | `arxiv.org` 使用同一规则 |
| Crossref | 单 DOI 公共池 5 次/秒、并发 1；polite pool 10 次/秒、并发 3 | 默认 1 秒一次、并发 1，并读取限流头；`mailto` 只改变官方上限，不自动提高项目默认速度 | 外部 PDF 主机按自身规则，未知时 30 秒 |
| Unpaywall | 每日最多 100,000 次 API 调用 | 1 秒一次、并发 1，并跟踪每日调用量 | 外部 PDF 主机按自身规则，未知时 30 秒 |
| Europe PMC | 未找到可靠公开数字限制 | 30 秒一次、并发 1 | Europe PMC 自有全文主机共享同一预算 |
| OpenAlex | 当前采用每日预算/额度，并有每秒硬上限和额度响应头 | 1 秒一次、并发 1，优先读取额度响应头 | 外部 PDF 主机按自身规则，未知时 30 秒 |
| Semantic Scholar | API key 初始限制为所有端点合计每秒 1 次；匿名请求共享公共额度并可能进一步受限 | 有无 key 均默认 1 秒一次、并发 1；收到更严格响应时降速 | 外部 PDF 主机按自身规则，未知时 30 秒 |
| Elsevier | Article Retrieval 公开上限 10 次/秒，并有每周额度 | 默认 1 秒一次，读取每周额度响应头 | `api.elsevier.com` 的 XML/Object 请求共享预算 |
| Wiley | 每 10 分钟最多 60 次，要求请求间隔 10 秒；同时不超过每秒 3 篇 | 10 秒一次、并发 1 | `api.wiley.com` 使用同一规则 |
| Springer Nature | 免费层 Open Access/Meta API 每天 500 次、每分钟 100 次 | 1 秒一次、并发 1，并跟踪每日额度 | 本提案只按 XML/HTML 外部能力评估，不计为主 PDF 来源 |
| Sci-Hub | 无统一可靠规则 | 显式启用但未配置更严格访问速度时，30 秒一次、并发 1 | operator 配置的 landing/PDF 主机分别共享预算 |

Crossref、Elsevier 和 OpenAlex 的官方上限高于表中的保守运行值时，表中较慢值是产品默认建议，不表示对官方规则的重新解释。后续只有在真实批量验证证明必要且安全时，才讨论提高默认吞吐。

## 7. 来源可用性表达

建议不要把所有信息压入一个“来源状态”，而是区分三个作用层级：

| 层级 | 作用对象与有效期 | 建议表达 |
|---|---|---|
| 静态能力 | provider + asset role；随代码或供应商合同变化 | `implemented`、`unsupported-role`、`unverified`，以及 verification 日期和适用授权类别 |
| Invocation readiness | 当前进程、配置和凭据上下文；只对本次调用有效 | `configured`、`ready`、`unauthorized`、`limited` |
| Target attempt | provider + 当前 WorkVersion/DOI；只描述本次尝试 | `no-candidate`、候选耗尽、下载失败、内容拒绝 |

同一来源可以同时具备不同层级的事实，例如“已实现、当前已配置，但目标文献没有候选”。这些表达用于能力说明和诊断，不新增 WorkVersion 生命周期状态，也不要求把临时 readiness 持久化为产品状态。对象是否完成仍只由 catalog 中是否存在 accepted primary PDF 等权威事实决定。

## 8. 预期效果

- Semantic Scholar、arXiv 和 Wiley 获得不依赖文献启动间隔的专属请求规则，降低配置调整或并行 invocation 后违反公开限制的风险。
- Crossref、Unpaywall、OpenAlex 等来源即使返回相同出版社地址，也不会分别绕过最终主机限制。
- 用户可以区分“来源没有 PDF”“请求过快”“额度耗尽”“授权不足”“候选下载失败”和“内容验证拒绝”。
- Springer 不再在产品解释中被误认为能够补齐主文 PDF。
- 默认吞吐会下降，但失败分类、供应商合规性和长期稳定性会提高。

## 9. 备选方案

### 9.1 只保留统一 30 秒文献启动间隔

不建议。它无法限制同一文献内并发启动的多个 resolver，也无法约束一个 provider 内的连续 API 请求；同时会让互不相关的主机互相阻塞。

### 9.2 每个 provider 独立限速，不按最终主机共享

不建议。多个 provider 可能把候选指向同一出版社，独立预算会在最终网站汇合并形成突发请求。

### 9.3 所有来源统一每 30 秒一次

安全但过于粗糙。Crossref、Semantic Scholar、Elsevier 等已有明确规则；统一 30 秒会不必要地降低查询效率，也不能解决不同 provider 指向同一主机的问题。

### 9.4 完全依赖 `429` 后退避

不建议。先触发供应商限流再降速会产生可避免的失败，也可能导致封禁；没有返回 `429` 不代表当前访问方式符合服务条款。

## 10. 风险与权衡

- **吞吐下降。** 未知主机 30 秒兜底和 Wiley 10 秒间隔会延长批量下载时间。
- **官方规则会变化。** 限制值属于易变外部事实，接受后应由 [Provider 注意事项](../../notes/providers/README.md)维护最后核对日期和证据等级。
- **周期额度难以在多进程间精确共享。** 首版“共享”只指同一 SciRetriever 进程，不协调不同调用方进程或不同 catalog。它们仍可能共同超额，只能依赖响应头、保守速度和 operator 约束来降低风险。
- **候选主机很多。** 对未知主机使用统一兜底简单可靠，但不能替代未来针对高价值出版社的正式规则核对。
- **状态表达增加。** 更细的可用性分类改善解释，但必须避免把它们误写成第二套 completion 状态。

## 11. 已确认的实现质量约束

项目 owner 已确认以下约束。它们只限定未来方案在另行获批后的代码形状，不单独授权开始实施。特别是，本节不授权扩展 `infrastructure/access/`、实现周期额度或 provider policy、增加 live verification，也不授权修改配置 schema 或当前默认行为：

1. **访问限制位于真实网络请求边界。** Resolver API 请求、最终候选下载和重定向后的目标请求都必须经过统一的 request admission；不得用文献启动间隔或在各 resolver 中分散调用 `sleep` 来替代真实请求限速。
2. **若另行获批，在 `infrastructure/access/` 内按责任拆分。** `policy.py`、`limiter.py` 和 `transport.py` 分别承载不可变规则与合并、进程内运行状态、受策略约束的网络执行。周期额度、`Retry-After` 和 transport 反馈不得堆入单个同时负责主机预算、健康度与熔断的 manager。
3. **官方默认值由代码维护，普通配置默认只能收紧。** 供应商公开限制和项目保守值属于受版本控制的 provider policy；operator 可以按凭据、订阅或 hostname 配置更严格规则，不能通过普通配置放宽官方上限或项目安全默认值。
4. **Provider profile 是单一静态真相源。** 每个 provider 的稳定名称、支持的 asset role、API hostname、凭据要求、默认访问策略和 live verification 适用范围集中声明；Composition wiring 负责构造运行对象，但不得再维护一套相互独立的能力或限速事实。
5. **只做本功能需要的相邻重构。** 可以扩充现有 host budget 并按职责拆分 health/circuit，但保留 `services/assets/` 编排、`infrastructure/sources/assets/` adapter、受控 transport、validation、immutable acceptance 和 completion 契约；不得借本提案全面重写异步框架、catalog 或其它业务模块。

这些约束要求规则对象与运行状态使用不同类型，规则合并只有一个权威实现，业务编排不计算访问间隔，provider-specific 分支不进入 `services/assets/` 的共享候选编排。新增模块应保持单一职责，避免形成同时负责 policy、等待、HTTP、诊断和重试的巨型 manager。

## 12. 仍需 owner 决定的问题

1. 是否接受“来源接口 + 最终主机”的两层访问限制模型？
2. 是否接受未知来源和未知最终主机默认 30 秒一次、并发 1？
3. 是否接受第 6 节的首版建议值，特别是 arXiv 3 秒、Semantic Scholar 1 秒和 Wiley 10 秒？
4. 是否将 Springer 从“主 PDF 下载来源”的产品表述中明确排除，仅保留 XML/HTML 补充能力？
5. 是否接受首版只做进程内预算，不为跨进程共享额度引入 durable 调度状态？
6. 是否接受第 7 节的三层可用性表达，并保持它们只作为能力/诊断事实而非 completion 状态？
7. 是否要求无需凭据且进入默认下载列表的 provider，按 provider + asset role 维护至少一个注明验证日期的 live verified 样本？凭据或订阅受限 provider 则按授权类别记录验证，不保存凭据身份。

在这些问题得到明确决定前，本文保持 `draft`，不产生实施授权。不得依据本文扩展 `infrastructure/access/`，实现 quota/provider policy 或 live verification，或把建议矩阵写成当前配置和运行行为。

## 13. 接受本提案后的长期文档责任

如果 owner 接受方向，长期规则应分别落到其真相源：

- acquisition 理想流程与预算责任：设计文档和技术文档；
- 当前程序内入口、配置合同和默认值：README 与配置手册；
- 供应商限速、额度、凭据与现场事实：Provider 注意事项；
- 实际实现和验证：源码、离线测试与受控 live 验证记录。

本文在方向确认、被拒绝、被替代或实施完成后应移入 `docs/archive/`，不能长期作为第二份行为真相源。

## 14. 证据与参考资料

### 当前项目

- [项目 README](../../../README.md)
- [Provider 接入注意事项](../../notes/providers/README.md)
- [ADR 0002](../../architecture/decisions/0002-literature-identity-and-incremental-processing.md)
- [设计文档“PDF 获取与状态记录”](../../architecture/design.md#33-pdf-获取与状态记录)
- `src/sciretriever/model/configuration.py`
- `src/sciretriever/infrastructure/access/budgets.py`
- `src/sciretriever/infrastructure/sources/assets/adapters.py`
- `src/sciretriever/composition/wiring/provider_registry.py`

### 供应商公开资料

以下资料于 2026-07-28 核对。数字只适用于表中注明的产品或访问层级；供应商更新后必须重新核对，不能把本表视为永久 SLA。

| 来源 | 本提案采用的证据 | 适用范围 |
|---|---|---|
| Semantic Scholar | [Academic Graph API](https://www.semanticscholar.org/product/api)：API key 初始 1 request/second；匿名请求共享公共额度并可能进一步受限 | Academic Graph API，metadata 与 acquisition 请求共享同一 key 限制 |
| Crossref | [Access and authentication](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/)：公共池 5 requests/second、并发 1；polite pool 10 requests/second、并发 3 | REST API 单条记录请求；不覆盖返回的外部 PDF 主机 |
| arXiv | [Institutional repository interoperability](https://info.arxiv.org/help/ir.html)：大量文章下载至少间隔 3 秒，超过 1000 篇应联系支持 | 从 arXiv 站点自动下载文章；不是 metadata API 分页规则 |
| Unpaywall | [REST API](https://unpaywall.org/products/api)：每天最多 100,000 次调用 | Unpaywall API；不覆盖其返回的外部 PDF 主机 |
| Europe PMC | [Articles RESTful API](https://europepmc.org/RestfulWebService) 和公开开发入口未给出本提案可确认的数字限制 | Europe PMC API/全文路线，因此采用未知来源兜底 |
| OpenAlex | [Authentication and pricing](https://developers.openalex.org/api-reference/authentication)：每日预算、额度响应头和每秒硬上限 | OpenAlex API；具体免费预算随当前产品层级变化，不覆盖外部 PDF 主机 |
| Elsevier | [API key settings](https://dev.elsevier.com/api_key_settings.html)：Article Retrieval 10 requests/second，并返回周额度响应头 | ScienceDirect Article Retrieval；Object API 采用更保守的共享 1 秒默认值，不声称官方同一上限 |
| Wiley | [Text and Data Mining](https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining)：每 10 分钟最多 60 次，并要求请求间隔 10 秒；同时最多每秒 3 篇 | Wiley TDM article 下载 |
| Springer Nature | [API subscriptions](https://dev.springernature.com/subscription/)：免费层 Open Access/Meta API 每天 500 次、每分钟 100 次 | 外部 Open Access 与 Meta API 能力及限额证据；不证明 SciRetriever 当前已有 Springer 专用 client 或可运行的多来源获取能力 |
