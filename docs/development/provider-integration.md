# Provider 接入开发手册

新增或实质修改 Metadata Provider、Acquisition route 或 PublisherAccessProfile 前，维护者应填写一份准入记录，并由责任文档明确它是当前实现、已批准目标还是未批准提案。Publisher/Access Provider 还必须进入统一的 [Profile 准入与验证矩阵](../notes/providers/publisher-access-matrix.md)。Provider 分类、目标矩阵、证据路由与凭据边界必须遵守 [ADR 0014](../architecture/decisions/0014-capability-scoped-providers-and-local-credentials.md)，访问设计必须遵守 [ADR 0012](../architecture/decisions/0012-process-local-provider-access-scheduling.md)、[ADR 0015](../architecture/decisions/0015-publisher-aware-tiered-pdf-acquisition.md)、[ADR 0016](../architecture/decisions/0016-cloakbrowser-fixed-identity-runtime.md)与 [ADR 0017](../architecture/decisions/0017-shared-agents-and-controlled-browser-agent.md)，精确配置合同见 [Configuration 技术文档](../architecture/technical/configuration.md)。当前具体 provider client 由调用方注入；配置选择键、通用 Protocol、registry 或测试 fake 都不能单独证明生产接入。

本手册统一使用当前身份 `MetaLiterature`/`Literature`。`Work`/`WorkVersion` 是已删除旧架构中的历史名称，不得在当前实现或文档中与现行术语混用。

记录不得包含凭据值、完整签名 URL、Cookie、Token、用户身份、响应正文或内部工单内容。未知信息写“待核对”，不得猜测。

## 1. 身份与责任

| 字段 | 内容 |
|---|---|
| provider / adapter ID |  |
| Provider 能力 | Metadata / Acquisition；两者可以分别实现，引用不能作为第三类 Provider |
| 具体能力 | Metadata search / identifier lookup / optional reference query / Acquisition route / PublisherAccessProfile / Browser route |
| Acquisition path | 不适用 / public / authorized-provider-api / controlled-browser；由 Acquisition 归类，不由响应决定 |
| 产品阶段 | current implementation / approved target / unapproved proposal |
| 运行状态 | proposed / active / degraded / retiring / retired；仅适用于 current implementation |
| 维护责任人 |  |
| 首次准入日期 |  |
| 最后复核日期 |  |
| 下次复核截止 |  |
| 证据等级 | official / implementation / verified / support / inferred |
| 责任 spec / 批准引用 |  |

## 2. 能力与输入

| 字段 | 内容 |
|---|---|
| 支持的标识符 | DOI / arXiv / PMID / URL / 其它 |
| 输入与归属 | MetaLiterature 查询 / Literature asset gap / landing page |
| metadata 字段或资产角色 |  |
| 输出语义 | metadata observation / same-literature version links / structured reference observation / reference texts / zero-or-more candidate / bounded bytes |
| 身份核对规则 |  |
| 匿名能力 |  |
| 凭据字段 | `credentials.toml` 中已经由官方合同确认的字段名、必需性和适用 capability；不得记录值 |
| 授权范围与已知限制 |  |
| 本地 readiness | 生产 adapter/Profile、普通参数、凭据字段、官方 policy、origin/challenge guard、固定 identity manifest、Cloak wrapper、Playwright API、经核实 binary 和 headed display 的要求 |
| Acquisition 适用性证据 | AssetHint origin / 来源稳定定位 / Provider record identity / DOI landing origin / 弱提示 / 不适用 |
| 访问身份 | Metadata Provider / Publication-Access Provider / Access Platform-CDN；不能用展示名称混为一个调度 key |

元数据供应商的引用关系查询能力不是一种独立供应商类型。供应商明确返回稳定两端定位时，adapter 为每条有向边分别产生 `ProviderRelationObservation`，统一表达为 `citing -> cited`。一次响应的多条 observation 可以共享调用 Provenance，但各有独立 `observation_id`。相关目标只有供应商 ID 时直接进入 `ProviderLiteratureKey.record_id`，不立即为响应中的全部目标补查元数据，也不得成为 SciRetriever `LiteratureId` 或 `Reference` 目标。响应实际内联提供的目标元数据可以并列转换为独立 `MetadataObservation`，但不嵌入 relation observation。供应商只返回原始参考文献文本时，文本进入来源 `MetadataObservation.reference_texts`，后续由临时 `ReferenceLookup` 尝试搜索，不伪装成已经确认的关系。

领域 search adapter 只有在普通配置已启用、生产实现存在且 readiness 通过时才参加本次 DiscoveryRun；Entry 不按 publisher 预选 Metadata Provider。Acquisition Planner 必须先根据调用方提供的中性证据形成无副作用 Resolution/Plan；MetadataObservation 来自某机构、publisher 字符串或单独 DOI prefix 不能直接证明其内容 API/Browser 适用。DOI landing origin 只能在强证据不足且本次计划需要时，由公开层的通用安全解析动作经过 Network 取得，并只作为当前进程证据使用。API 或页面产生的 locator/稳定 ID 只能形成脱敏 `AccessRouteHint`，不能持久化 vendor object、签名 URL 或 Cookie。

结构化关系和原文只按“目标是否已经由供应商稳定明确”区分，不按主动查询、默认返回或 endpoint 类型区分。目标 Literature 接纳后，前者形成 `ProviderRelationSupport`，后者形成 `MetadataReferenceTextSupport`；精确边界见 [ADR 0007](../architecture/decisions/0007-reference-resolution-and-authoritative-relations.md)。

供应商明确声明当前记录与其它稳定目标是同一文献的不同版本时，每个目标转换为当前 `MetadataObservation.version_links` 中的 `ProviderLiteratureKey`。它复用 observation 的 Provenance，只用于 Literature 身份收敛；更正、撤稿、引用和其它关系不得进入该字段。目标未解析时保留 observation，不自动补查全部版本目标，也不创建占位 Literature、`LiteratureRelationObservation` 或 `LiteratureRelation`。

每个 adapter 必须把供应商字段分成三个语义位置，不能只看字符串是否像一个 ID：

1. 当前具体 Literature 自身的 DOI、arXiv ID、PMID、PMCID 或其它官方文献标识符进入 `LiteratureMetadata.identifiers`；
2. OpenAlex Work ID、Web of Science UID、Semantic Scholar Paper ID、Scopus EID 等供应商数据库记录身份进入当前 observation 的 `provenance.source_record_id`，关系或版本目标的同类值进入 `ProviderLiteratureKey.record_id`；
3. 明确表示同一文献其它版本的标识符进入 `version_links`，例如正式 DOI 记录中作为相关预印本返回的 arXiv ID，不能同时进入正式 Literature 自身 identifiers。

所有 adapter 复用公共 `Identifier` 的官方 canonicalization，不建立 Provider 私有规范化：DOI URL/`doi:`/大小写统一为小写裸值，arXiv 前缀/官方 URL/`vN` 统一为基础 ID，PMID、PMCID 和其它已支持值遵循各自官方格式。未知 namespace 不得通过删除标点、全局 lowercase 或模糊修复提高命中率。

## 3. 网络与请求预算

| 字段 | 内容 |
|---|---|
| 允许的 HTTPS host |  |
| DNS / redirect 规则 |  |
| AccessScope | 稳定 provider name、api/web channel、必要的独立 API service；不含凭据、文献或 URL |
| quota 共享范围 | 哪些 metadata/reference/asset 调用共享 key、账户、官方额度或响应头 |
| 官方政策与核对日期 | 链接到对应 Provider Notes；未知不能猜测或冒充官方规则 |
| API quota policy | quota identity、最大并发、最小间隔、burst/window、周期/日额度、reset、反馈头；Network 共享执行，普通配置只能收紧 |
| Browser policy | `browser_rate_limit_group`、`browser_session_key`、`max_concurrency=1`、文章 interval/window/cooldown、circuit；不同独立组可并行 |
| Browser origin/action guard | 每次 navigation/popup/viewer/response/download 前的封闭 allowlist、有限动作、批准页面子资源、第三方丢弃、动态 redirect、正文/补充材料规则与 revision |
| metadata fan-out 与 completion-order-independent merge |  |
| connect/read/operation timeout |  |
| 最大响应大小 |  |
| `Retry-After` 支持 |  |
| 单 Literature 请求预算 |  |
| circuit / health 分桶 | 不得使用 DOI、完整 URL、凭据或用户身份 |

Adapter 负责解释供应商政策并声明 scope/policy，不能在自身内部用 `sleep`、局部 semaphore 或 SDK 默认重试建立只对该模块可见的第二套限速。Network Access Coordinator 在当前进程的 Metadata、Acquisition、Parsing、Analysis、批次和文献目标之间统一执行。Vendor SDK 只有能够注入受控 transport 时才允许进入生产 adapter。

公开来源也必须声明访问政策。公开 `AssetHint` 指向出版社网页或站内 PDF 时仍使用该出版社的 `web` scope；不同来源 redirect 到同一最终 host 时共享 host budget。授权 API 使用独立 `api` scope，是否与 metadata/reference query 共享由真实 quota 范围决定。

Browser 不使用所有供应商统一的固定间隔。独立 risk group 可以并行，同一 group 只有一个
文章流程，并按 Profile/Notes 中已核实的政策串行。全局 Browser cap 只保护本机资源；重试、
popup、多个标签页或备用入口不能拆出新的 group。未知 Provider 不获得 generic Browser
fallback。该 cap 默认 `5`，只接受大于 `1` 的整数且不设上限；当前 route 数量不是配置上限，
Publisher lane 仅为实际 Browser work 按需进入调度。生产 Browser 使用当前机器正常网络出口、
一个 operator-managed 固定身份 Profile、一个共享 CloakBrowser patched Chromium process/context；
SciRetriever 继续以 Playwright API 控制它，无 GUI Linux 使用 Xvfb。Publisher 请求由 Chromium
原生网络栈完成；broker 关闭或进程退出后删除临时下载工作区但保留 Profile。普通配置只接受
opaque Profile identity，不接受路径、seed、Cookie 或登录内容；`credentials.toml` 也不保存这些
Browser 状态。第一版不提供人工 Browser 认证流程。

## 4. 敏感信息边界

- 哪些 URL、header、cookie、referrer 或 auth context 只能存在于运行时：
- 可保存的非敏感 provider record id、locator 和 provenance：
- 日志、failure、catalog 和报告的脱敏断言：
- `~/.sciretriever/credentials.toml` 中允许的字段、必需性、owner/权限和 adapter 注入边界：
- `config status` 的纯本地状态与 `config test` 的最小只读 probe（均不得包含 secret 特征或持久结果）：
- 当前机器网络出口、持久 Profile identity/presence、共享 Browser runtime/context、Cookie/Profile
  内容、Publisher lane readiness 与 action-required 的边界：
- 禁用该能力后的回退：

## 5. 验证与资产接受

- metadata provider 如何转成 `MetadataObservation`，不泄漏 vendor dict：
- 当前文献 identifier、Provider record identity 和相关版本 identifier 如何按语义分别进入 `metadata.identifiers`、Provenance/ProviderLiteratureKey.record_id 与 `version_links`：
- DOI/arXiv/PMID/PMCID 如何复用公共 canonicalization，adapter 没有第二套前缀、URL、大小写或 revision 规则：
- provider 的明确同文献版本目标如何进入 `MetadataObservation.version_links`，且不混入更正、撤稿、引用或通用关系：
- 元数据供应商如何把具有稳定目标的结构化关系与仅有文本的 `reference_texts` 按语义区分，而不依赖 endpoint 形式：
- 一个响应中的多条结构化关系如何逐边转换为 `ProviderRelationObservation`，且保存 observation 不立即补查或物化全部目标：
- metadata provider 如何在有界并发和独立 timeout 下运行，并按 configured precedence/fill-missing 得到与完成顺序无关的 canonical 结果：
- provider record 如何只形成 observation，而不按来源膨胀 `Literature`：
- asset candidate 如何通过 URL policy、有限 timeout 和 redirect 检查：
- route 如何被唯一归入 public、authorized-provider-api 或 controlled-browser，且同一 Literature 不跨层竞速：
- route 如何只填补指定 `Literature` 的资产缺口：
- Resolution/Plan 如何根据 AssetHint、来源稳定定位、Provider record identity 或必要时 DOI landing origin 判断适用，且不会按 publisher/metadata 来源硬编码：
- API capability、quota identity、官方 policy 和 route hint 如何表达，临时/额度错误为何不能自动升级 Browser：
- Browser 如何证明显式 request 的 per-hop guard、未暴露 route 的 native redirect 只能复用同页 live 且已批准/预绑定的关联、不同 risk group 并行、同组串行、所有 Publisher lane 共享一个固定身份 Profile/process/context、文章级隔离、受限 challenge dependency/settle、第三方 tracker 在 DNS 前丢弃、确定性发现/Publisher 规则优先、可选 Agent 封闭动作、正文捕获和 supplement 排除：
- primary PDF 与 supplemental XML/HTML 的角色验证；XML/HTML 不得提升为 PDF 或独立满足内容分析：
- 基本检查如何只确认非空 PDF、可读取文件结构、可打开页面结构和候选具有文献来源依据，而不进行固定大小/页数阈值、正文完整性或标题/作者/DOI 身份比对：
- 何时允许进入不可变资产接纳：
- 取消、timeout 和 late response 如何禁止 late acceptance，且不会泄漏 permit 或绕过冷却：

## 6. 失败与动作映射

- 所有适用 routes 正常耗尽且无 deferred/action-required/未解决 failure 时如何收敛为无字段 `NoPrimaryPdf`：
- 缺少生产 adapter、必需普通参数/凭据/AccessPolicy 或认证/权限错误如何在耗尽之外形成稳定失败：
- 临时来源诊断如何限制在当前边界且不持久化 candidate/route failure：
- permit 等待、网页冷却和 `blocked_until` 如何保持为 Network 进程内内存状态而不是 Literature/Acquisition 失败：

| 场景 | 边界内脱敏 reason | retryable | 用户动作 | 最小复现证据 |
|---|---|---:|---|---|
| 配置或凭据缺失 |  |  |  |  |
| 认证或授权失败 |  |  |  |  |
| 429 或限流 |  |  |  |  |
| 资源不存在或无候选 |  |  |  |  |
| challenge 或 unsupported response |  |  |  |  |
| timeout 或 transport failure |  |  |  |  |
| 非 PDF、空响应或 PDF 结构不可读 |  |  |  |  |

本表只要求 adapter 在当次调用边界内给出可测试、已脱敏的动作转换。Acquisition 公开结果仍只是 `AcquiredPrimaryPdf | NoPrimaryPdf`；候选、Plan、route、Browser session/circuit 和其失败 reason 不进入长期持久化。

## 7. 离线 fixture 与验收

Browser 规则按供应商分别放在
`src/sciretriever/acquisition/sources/browser_rules/providers/<provider>.py`；共享规则合同和 helper
不得混入供应商页面知识。新增文件后仍须在 `catalog.py` 中显式加入 verification catalog，并且
只有完整准入结论允许它被显式加入 production catalog；禁止通过目录扫描或 import side effect
自动注册。

PublisherAccessProfile 的 evidence manifest 固定放在 `tests/fixtures/acquisition/profiles/<access-key>.json`，并与源码 `PublisherAccessEvidence.fixture_reference` 一一对应。验证状态只允许 `production-ready`、`fixture-verified`、`unsupported`；public/API-only 是 capability 组合，不是第四个状态。Browser Profile 必须引用真正的 `BrowserSiteRule` id/revision，并由统一矩阵证明 origin、risk scope、policy、页面状态、正文/补充材料归属和 fixture 对齐；测试摘要 selector 不能替代执行规则。

按能力覆盖适用场景，CI 不使用真实凭据、真实受限正文或 live provider：

- metadata 缺字段、冲突字段和 provider precedence；
- DOI 裸值、`doi:`、已知 resolver URL、大小写和边界空白 fixture 得到同一小写裸值；arXiv 新旧式、前缀、官方 abs/pdf URL、`.pdf` 与 `vN` fixture 得到同一基础 ID；
- PMID、PMCID 和当前实际支持的其它 namespace 使用官方 canonical form，未知 namespace 不被 adapter 擅自 lowercase、去标点或猜测修复；
- OpenAlex Work ID、Web of Science UID、Semantic Scholar Paper ID、Scopus EID 等 fixture 只形成 Provider record identity，不进入 Literature identifiers；
- 正式 DOI 记录中的相关 arXiv 预印本 fixture 只形成 `version_links` 目标，不把两个具体 Literature 错合并；
- 明确同文献版本目标形成 `version_links`，未解析、冲突、更正、撤稿和模糊关系不会形成 MetaLiterature 归属或通用关系；
- metadata provider 实际并发启动、独立 timeout，且不同完成顺序产生相同 MetaLiterature、Literature 和 LiteratureMetadata；
- metadata provider 逻辑并发时仍分别取得进程内共享 scope permit；共享 API quota 的 metadata/reference/asset 调用相互限速，独立产品不错误互锁；
- 引用响应返回多条边时逐边形成 observation；当前扩展范围只选择其中一部分时，其余 observation 保留且不创建 Literature、Reference、support 或递归任务；
- 同一 `Literature` 的多 provider records 收敛为 observations，不按 provider 数量创建 Literature；
- 零、单个和多个候选；
- 首候选失败后其它候选成功；
- 一个有界 cohort 全部完成 Public 后才启动未解决目标的 Authorized API，API 层结束并通过 admission 后才启动最小 Browser 集合；同一 Literature 不跨层竞速；
- 两个独立 Browser risk group 实际并行，同一 group 最大并发为 1 且精确满足自身 interval/window/cooldown；
- navigation、页面 request、popup、viewer、response 和 download 通过 Profile guard 与 Network policy；普通文章只加载规则批准的页面资源，challenge dependency 还必须满足发起页/frame/用途约束，未批准第三方资源在 DNS 前丢弃；点击或页面脚本产生的显式 request 逐项复审，未暴露 route 的 native redirect 只有同页 live ancestor、批准且预绑定的最终 origin 与 terminal host admission 同时成立时才能关联；共享 persistent context 中的 Publisher lane reuse/文章隔离、challenge 自动 clear/resource-blocked/interaction-required/settle-timeout、operation-local 状态机/circuit、可选受控 Agent 和 supplement exclusion 使用离线 fixture；
- 重复候选收敛；
- 429、timeout、redirect、截断、超限和无效内容；
- 敏感 query/header/cookie 不进入 durable state 或输出；
- 临时 owner-only `credentials.toml` fixture 覆盖 configured/partial/missing/optional-missing/unsupported，`config status` 不联网且 `config test` 只使用 fake Network、不创建数据库事实；
- 普通 HTTP/API 按实际 provider/host/quota scope 推进；Browser 不同 risk group 可并行、同组按 Profile policy 串行，同时独立 API 和其它 provider 可以推进；
- 当前进程内 `Retry-After`、quota、取消和 timeout 不会泄漏 permit、丢失有效阻塞或产生 late acceptance；新进程不恢复旧限速状态；
- provenance、Literature asset link 和 catalog 对账；
- 只有当前主 PDF 可以驱动 Parsing 与 Analysis，只有 XML/HTML 时必须阻断；PDF 与补充资产冲突时，由 PDF 控制结果并保留 PDF locator；
- 关闭 provider 后其它已批准路径保持可用。

记录 fixture 来源、版本、最后核对日期、预期结果和刷新规则。

## 8. 健康、复核与退役

- 只供用户显式 `config test` 使用的官方最小只读 probe（不得由 CI 真实执行）：
- 凭据失效、API 版本变化、限流和内容授权变化的稳定症状：
- 超过复核窗口时的降级行为：
- 禁用开关和回退路径：
- 退役触发条件：
- 退役后保留的脱敏 failure/provenance 证据：
- 用户迁移说明：

## 9. Review Checklist

- [ ] 责任 spec 明确该 provider/adapter 是当前能力还是尚未实现目标。
- [ ] 只使用 Metadata/Acquisition 两类 Provider；search/lookup/reference 是 Metadata 的具体能力，没有建立 Citation Provider。
- [ ] 凭据、签名 URL、正文和用户身份未进入文档或 fixture。
- [ ] 凭据 spec 只声明已核实字段并从固定 owner-only `credentials.toml` 注入；status/test 不泄漏或持久化值/结果，真实 probe 不进入 Harness/CI/离线验收。
- [ ] metadata provider 使用有界并发、独立 timeout 和 completion-order-independent merge；provider precedence/fill-missing 有确定性配置语义。
- [ ] adapter 已声明不含 secret 的 AccessScope、真实 quota 共享范围、当前政策依据和复核日期；缺失 policy 时不是 production-ready。
- [ ] API 声明并执行真实 quota identity、并发、interval、window/周期额度、reset 和反馈头；普通配置只能收紧，公开/direct URL 没有绕过 provider/host scope。
- [ ] Browser Profile 声明 risk/session group、文章 policy 与证据日期；不同独立 group 实际并行，同组 `concurrency=1` 且精确满足 interval/window/cooldown，全局 cap 只保护本机资源。
- [ ] Publisher Profile 具有唯一 evidence manifest 和三态结论；production catalog 只由 `production-ready` 派生，fixture-verified/unsupported rule 未进入生产对象图；Browser 总开关关闭或 runtime 未就绪时不构造可执行 client，逐文章结果不由本地配置预先宣称。
- [ ] 每次 Browser navigation/popup/viewer/response/download 在访问前通过 Profile guard 与 Network policy；批准页面子资源、受限 challenge dependency、第三方 tracker 丢弃、动态 redirect、一个固定身份 Profile/process/context、Publisher lane reuse/文章隔离、自动 settle 与人工终态、operation-local circuit、确定性规则优先/Agent 有界 fallback、多路正文捕获和 supplement 排除有离线 fixture，seed、Cookie、Profile 内容/路径、Agent 页面内容和临时下载路径不泄露。
- [ ] Metadata、reference query 和 asset API 共享真实 quota 时使用同一 scope；adapter/SDK 没有自建局部 limiter 或绕过受控 transport。
- [ ] 只有供应商明确声明的同文献版本目标进入 `MetadataObservation.version_links`；未解析目标不触发自动补查、占位 Literature 或通用关系。
- [ ] 当前文献 identifier、Provider record identity 和相关版本 identifier 已按字段语义分流；Provider record ID 没有进入 `LiteratureMetadata.identifiers`，正式记录的相关 arXiv ID 没有冒充当前正式 Literature 的 ID。
- [ ] adapter 复用公共 Identifier canonicalization；DOI/arXiv/PMID/PMCID 与实际支持的其它 namespace 有官方格式 fixture，未知 namespace 没有私有 lowercase、去标点或模糊修复。
- [ ] 结构化关系和参考文献原文只按目标是否稳定明确分类；主动查询、默认返回和 endpoint 形式不改变中性语义。
- [ ] 结构化引用响应逐边形成 `ProviderRelationObservation`；未进入当前扩展范围的 observation 不导致目标元数据补查、Literature 物化或递归。
- [ ] provider record 只形成 observation；Acquisition route 只填补 `Literature` asset gap。
- [ ] PublisherAccessResolution/Plan 基于强证据，未把 publisher、DOI prefix 或 MetadataObservation 来源当成全文归属；readiness/权限失败不形成正常耗尽。
- [ ] Public/Authorized API/Browser cohort 顺序和失败隔离与责任文档一致；同一 Literature 没有跨层竞速，临时/额度错误没有触发 Browser 绕行。
- [ ] primary PDF 是 Parsing 与 Analysis 的必需权威基准；XML/HTML 只补充且不能覆盖 PDF。
- [ ] HTTPS、DNS、redirect、有限 timeout、响应上限和失败映射完整。
- [ ] fake clock、受控多进程和 fake transport 证明并发、间隔、冷却、quota、`Retry-After`、取消与崩溃恢复语义；没有 live provider 测试进入 CI。
- [ ] 资产经过共享 validation 和 immutable acceptance，没有直接写目标文件。
- [ ] 离线 fixture、维护责任、复核日期和退役条件完整。
- [ ] 关闭能力后，其它已批准程序内流程和既有已接纳资产不受影响。
