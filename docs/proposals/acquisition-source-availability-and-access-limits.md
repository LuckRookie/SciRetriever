+++
document_type = "proposal"
status = "draft"
created = "2026-07-28"
+++

# 多下载源可用性与合理访问限制提案

## 1. 提案状态

本文讨论 SciRetriever 当前多种全文来源在真实使用中无法稳定取得主文 PDF，以及如何为下载过程增加符合供应商要求的访问限制。本文是活动提案，不授权实施，不修改当前配置或已发布行为，也不替代项目 README、Provider 注意事项或架构文档。文中的“当前”事实是形成提案时的证据快照，只用于说明问题，不作为当前行为真相源。

本提案只讨论 acquisition。metadata 搜索的分页、并发和限流需要单独评估，不纳入本文建议值。

## 2. 摘要

SciRetriever 已实现 11 个资产获取入口，其中 10 个声明具有主文 PDF 能力，Springer Nature 当前只提供 XML/HTML。代码覆盖来源数量并不等于真实可用：一次 2026-07-28 的隔离试跑中，开放论文完成了 metadata 入库，但该次 invocation 启用的获取路径耗尽后仍未得到合格主文 PDF，WorkVersion 保持 `ASSET_PENDING`。该试跑没有形成可公开归因的逐来源报告，因此只证明“当次来源组合未成功”，不能证明 11 个入口全部不可用。逐来源判断仍以代码、维护中的 Provider 记录和后续受控验证为准。

当前系统已有不得低于 30 秒的 acquisition 文献启动间隔、同主机同 catalog 的单 acquisition batch admission 和最终候选主机预算，但还不能完整表达不同来源的官方限制，也不能保证 resolver 查询与随后真正下载 PDF 的请求共享同一主机预算。完整模板中的默认同主机间隔为 0.5 秒、并发为 2；Wiley profile 虽记录了 1 秒间隔，但该值当前只参与新文献启动门，而 Wiley 官方要求下载请求之间间隔 10 秒。30 秒硬下限约束相邻需要 acquisition 的 WorkVersion 启动，仍不能替代逐来源请求规则。Semantic Scholar 和 arXiv 同样缺少明确的专属下载限制。

本提案建议：

1. 每个外部下载来源都必须有明确的访问策略，即使策略只是继承保守默认值。
2. 同时执行“来源接口”和“最终下载主机”两层限制；同一主机由所有来源共享预算。
3. 官方规则、响应头、`Retry-After` 和项目保守默认值共同构成约束，实际执行始终采用其中更严格的限制。
4. 找不到可靠公开规则时，采用“同一主机每 30 秒最多启动一次请求、并发 1”的保守兜底。
5. 来源可用性必须区分已实现、已配置、已验证、受限和不具备主 PDF 能力，不能只用 provider 名称表达。

## 3. 背景与当前问题

### 3.1 当前产品要求

本提案针对当前 PDF-backed analysis 路径讨论来源可用性：`WorkVersion` 只有取得并验证合格的主文 PDF，才能进入该附加分析能力。核心产品需求只要求把受支持资产解析为轻结构化文本；XML/HTML 是否能满足通用解析，不由本提案限制。

第一层 acquisition 会让 direct、出版社、开放来源和显式配置的 Sci-Hub 进行有界竞速；每个来源内部可以返回多个候选。第一层耗尽后才进入 translator 和 browser。所有路径最终都必须通过安全网络、内容验证、文章身份验证和不可变接收。

### 3.2 来源数量与实际可用性不一致

当前 11 个入口的产品状态如下：

| 来源 | 当前声明能力 | 主要可用条件 | 当前主要风险 |
|---|---|---|---|
| Direct HTTPS | 目标资产 | catalog 已有可信 HTTPS 地址 | 最终主机不确定，没有统一供应商规则 |
| arXiv | 主文 PDF | 有 arXiv identifier | 批量 PDF 访问需要至少 3 秒间隔 |
| Crossref | 主文 PDF 候选 | Crossref 登记了 PDF link | link 可能需授权、失效或返回 HTML |
| Unpaywall | 开放主文 PDF 候选 | 配置联系邮箱且存在 OA location | 最终地址分散在不同仓储或出版社 |
| Europe PMC | 开放主文 PDF | 收录目标且存在开放全文路线 | 当前候选覆盖有限，未找到公开数字限速 |
| OpenAlex | 主文 PDF 候选 | API 可用且记录提供 PDF URL | 当前实现未接入官方现在建议使用的 key；候选可能失效 |
| Semantic Scholar | `openAccessPdf` 主文 PDF | API 可用且记录提供开放 PDF | API key 初始限制为每秒 1 次；匿名请求共享公共额度并可能进一步受限 |
| Elsevier | 主文/补充 PDF、XML | API key、内容授权和附件 EID 可用 | 真实样本出现外层超时；一个 PDF 需要多次 API 请求 |
| Wiley | 主文 PDF | TDM token 和内容授权有效 | 官方要求 10 秒请求间隔；当前 profile 的 1 秒只参与文献启动门，不独立约束 Wiley 请求 |
| Springer Nature | XML、HTML | API key 和对应产品授权有效 | 当前不提供主文 PDF，不能完成资产阶段 |
| Sci-Hub | 主文 PDF | operator 显式启用并提供获准 endpoint | 无统一官方限速，无 live 验证，默认关闭 |

“已实现”只说明存在代码路径，不证明当前凭据、授权、网络、候选地址和供应商服务可以共同完成下载。后续产品呈现和诊断应避免把这些状态合并为一个简单的 available/unavailable 布尔值。

### 3.3 当前访问限制的缺口

当前完整配置模板采用：

- 相邻需要 acquisition 的 WorkVersion 启动间隔默认 30 秒，且不得配置为更低值；
- 同一主机、同一 catalog 同时只允许一个 acquisition batch；
- 最多同时运行 3 个 provider；
- 最终候选下载对所有主机统一使用并发 2、请求启动间隔 0.5 秒；
- Elsevier profile 记录并发 2、间隔 0.25 秒；
- Wiley profile 记录并发 1、间隔 1 秒；
- Springer profile 记录并发 1、间隔 1 秒。

当前运行时没有把 publisher profile 注册为最终候选的逐主机 override。它只取全局主机间隔与 profile 间隔中的较大值，再把结果交给“新文献启动门”；profile 的并发值没有成为对应主机的独立并发限制。30 秒硬下限保证同一 acquisition batch 内相邻适用 WorkVersion 的启动节奏，host-local stage admission 也阻止同一主机、同一 catalog 的第二个 acquisition batch 并行进入，但两者都不能代替逐来源请求限制：同一篇文献内的多个 provider 仍会竞速启动，一个 resolver 内也可能先查询 API、再访问候选文件，不同 catalog 或不同主机的 CLI 进程也不共享该启动门。

因此当前模型存在四类缺口：

1. **官方限制未完整建模。** Semantic Scholar、arXiv、Crossref、Unpaywall 等没有独立下载策略；Wiley 现值与官方要求不一致。
2. **查询和下载可能分属不同主机。** Crossref、Unpaywall、OpenAlex 和 Semantic Scholar 返回的 PDF 可能落在同一家出版社，但当前来源身份不能保证它们共享来源级预算。
3. **同一来源可能包含多次请求。** Elsevier 先取 FULL XML，再从 Object API 下载 PDF；只限制文献启动不能约束这两个请求的间隔。
4. **周期额度没有统一表达。** Unpaywall 有每日调用量，Elsevier 有每周额度，OpenAlex 和 Springer 有每日额度或预算，仅靠最小时间间隔不足以表达。

## 4. 目标与非目标

### 4.1 目标

- 让每个外部 acquisition 请求都有可解释的访问限制来源。
- 遵守供应商公开限速、响应头和重试要求，避免因请求过快导致 `429`、封禁或服务压力。
- 防止多个 provider 同时请求同一最终网站而绕过限制。
- 把来源自身不可用、凭据/授权不足、被限流、无候选和最终 PDF 验证失败区分开。
- 在不增加后台任务系统的前提下，保持 ADR 0002 批准的前台、有界、进程内竞速模型。

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
- 首版共享预算只约束当前进程。同一主机、同一 catalog 的 stage admission 会排除第二个 acquisition batch，但不同 catalog 或不同主机的 CLI 进程仍可能分别消耗同一外部额度；本文建议通过保守默认值和 operator 使用约束降低风险，不为了跨进程或跨机器精确共享配额引入 durable 调度状态。

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
| Springer Nature | 免费层 Open Access/Meta API 每天 500 次、每分钟 100 次 | 1 秒一次、并发 1，并跟踪每日额度 | 当前只用于 XML/HTML，不计为主 PDF 来源 |
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
- **官方规则会变化。** 限制值属于易变外部事实，接受后应由 [Provider 注意事项](../notes/providers.md)维护最后核对日期和证据等级。
- **周期额度难以在多进程间精确共享。** 首版“共享”只指同一 SciRetriever 进程；stage admission 只排除同一主机、同一 catalog 的并行 acquisition batch，不协调不同 catalog 或不同主机。它们仍可能共同超额，只能依赖响应头、保守速度和 operator 约束来降低风险。
- **候选主机很多。** 对未知主机使用统一兜底简单可靠，但不能替代未来针对高价值出版社的正式规则核对。
- **状态表达增加。** 更细的可用性分类改善解释，但必须避免把它们误写成第二套 completion 状态。

## 11. 已确认的实现质量约束

项目 owner 已确认以下约束。它们只限定未来方案在另行获批后的代码形状，不单独授权开始实施。特别是，本节不授权创建 `acquisition/access/`、实现周期额度或 provider policy、增加 live verification，也不授权修改配置 schema 或当前默认行为：

1. **访问限制位于真实网络请求边界。** Resolver API 请求、最终候选下载和重定向后的目标请求都必须经过统一的 acquisition request admission；不得用文献启动间隔或在各 resolver 中分散调用 `sleep` 来替代真实请求限速。
2. **若另行获批，建立小型 `acquisition/access/` 子包。** 目标结构以 `policy.py`、`limiter.py` 和 `transport.py` 分别承载不可变规则与合并、进程内运行状态、受策略约束的网络执行。不得继续把周期额度、`Retry-After` 和 transport 反馈堆入已经同时包含主机预算、健康度与熔断的 `controls.py`。
3. **官方默认值由代码维护，普通配置默认只能收紧。** 供应商公开限制和项目保守值属于受版本控制的 provider policy；operator 可以按凭据、订阅或 hostname 配置更严格规则，不能通过普通配置放宽官方上限或项目安全默认值。
4. **Provider profile 是单一静态真相源。** 每个 provider 的稳定名称、支持的 asset role、API hostname、凭据要求、默认访问策略和 live verification 适用范围集中声明；CLI composition 负责构造运行对象，但不得再维护一套相互独立的能力或限速事实。
5. **只做本功能需要的相邻重构。** 可以迁移现有主机预算并按职责拆分 health/circuit，但保留现有 acquisition orchestration、resolver、secure transport、validation、immutable acceptance 和 completion 契约；不得借本提案全面重写 acquisition、异步框架、integrations、network 或 catalog。

这些约束要求规则对象与运行状态使用不同类型，规则合并只有一个权威实现，业务编排不计算访问间隔，provider-specific 分支不进入共享 candidate executor。新增模块应保持单一职责，避免形成同时负责 policy、等待、HTTP、诊断和重试的巨型 manager。

## 12. 仍需 owner 决定的问题

1. 是否接受“来源接口 + 最终主机”的两层访问限制模型？
2. 是否接受未知来源和未知最终主机默认 30 秒一次、并发 1？
3. 是否接受第 6 节的首版建议值，特别是 arXiv 3 秒、Semantic Scholar 1 秒和 Wiley 10 秒？
4. 是否将 Springer 从“主 PDF 下载来源”的产品表述中明确排除，仅保留 XML/HTML 补充能力？
5. 是否接受首版只做进程内预算，不为跨进程共享额度引入 durable 调度状态？
6. 是否接受第 7 节的三层可用性表达，并保持它们只作为能力/诊断事实而非 completion 状态？
7. 是否要求无需凭据且进入默认下载列表的 provider，按 provider + asset role 维护至少一个注明验证日期的 live verified 样本？凭据或订阅受限 provider 则按授权类别记录验证，不保存凭据身份。

在这些问题得到明确决定前，本文保持 `draft`，不产生实施授权。不得依据本文创建 `acquisition/access/`，实现 quota/provider policy 或 live verification，或把建议矩阵写成当前配置和运行行为。

## 13. 接受本提案后的长期文档责任

如果 owner 接受方向，长期规则应分别落到其真相源：

- acquisition 理想流程与预算责任：设计文档和技术文档；
- 当前已发布配置、默认值和命令行为：README、配置手册和 TOML 模板；
- 供应商限速、额度、凭据与现场事实：Provider 注意事项；
- 实际实现和验证：源码、离线测试与受控 live 验证记录。

本文在方向确认、被拒绝、被替代或实施完成后应移入 `docs/archive/`，不能长期作为第二份行为真相源。

## 14. 证据与参考资料

### 当前项目

- [项目 README](../../README.md)
- [Provider 接入注意事项](../notes/providers.md)
- [ADR 0002](../architecture/decisions/0002-literature-identity-and-incremental-processing.md)
- [设计文档 Acquisition 流](../architecture/design.md#acquisition-流)
- `src/sciretriever/acquisition/controls.py`
- `src/sciretriever/acquisition/pacing.py`
- `src/sciretriever/acquisition/profiles.py`
- `src/sciretriever/cli/acquisition_runtime.py`

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
| Springer Nature | [API subscriptions](https://dev.springernature.com/subscription/)：免费层 Open Access/Meta API 每天 500 次、每分钟 100 次 | Open Access 与 Meta API；当前 SciRetriever 只获取 XML/HTML |
