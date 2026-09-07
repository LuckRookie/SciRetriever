# Acquisition 模块技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 设计责任：[设计文档 4.4](../design.md#44-acquisition)
- 产品需求：[R3 文献资产获取](../requirements.md#r3-文献资产获取)
- 运行边界：[ADR 0013](../decisions/0013-decoupled-discovery-and-database-maintenance.md)
- Provider 与凭据：[ADR 0014](../decisions/0014-capability-scoped-providers-and-local-credentials.md)、[Configuration 技术文档](configuration.md)
- PDF 路由与 Browser 调度：[ADR 0015](../decisions/0015-publisher-aware-tiered-pdf-acquisition.md)、[ADR 0016](../decisions/0016-cloakbrowser-fixed-identity-runtime.md)
- 通用 Browser Agent：[ADR 0017](../decisions/0017-shared-agents-and-controlled-browser-agent.md)、[ADR 0023](../decisions/0023-generic-browser-agent-executor.md)、[Agents 技术文档](agents.md)

本文定义目标 `src/sciretriever/acquisition/` 的 PDF 候选发现、下载、基本检查和当前主资产提交。下载阶段只确认文件和获取关系的基本有效性，不严格判断正文完整性。

## 1. 目标结构

```text
acquisition/
  api.py
  tiered_service.py
  cohort.py
  browser_admission.py
  browser_control.py
  planning.py
  access_profiles.py
  profile_catalog.py
  profile_verification.py
  outcomes.py
  routes.py
  manual.py
  rules.py
  ports.py
  authorized.py
  providers/
  sources/
```

- `api.py` 提供具体 `Literature` 的计划、分层获取和手动接纳操作；
- `tiered_service.py` 执行分层计划，形成当前操作的候选或耗尽 receipt，并在 Entry 的提交边界消费 receipt；
- `cohort.py` 保存无持久化副作用的 work item，并对一个有界请求集合执行层级屏障；
- `browser_admission.py` 在 Browser route 前形成允许、延期、待处理或拒绝决定及脱敏汇总；
- `browser_control.py` 定义唯一 `AgentBrowserController`，根据统一 Observation 构造单次 Browser role `AgentCall`、解析六种封闭动作并判断语义进展；它不拥有 Browser runtime、页面对象或 PDF 发布；
- `planning.py` 根据当前 Literature 证据形成运行时访问方 Resolution、Plan 和 route hints；
- `access_profiles.py` 定义无 secret、版本化的 Publisher access/profile 与统一证据包；
- `profile_catalog.py` 声明当前验证矩阵并派生已核实的生产访问画像；
- `profile_verification.py` 把 Profile evidence、可选 Browser reachability probe 与三态生产资格对齐；
- `outcomes.py` 定义 route 的 PDF、hint、正常未命中、延期和待处理结果；
- `routes.py` 把已安装的 route adapter 与 Planner 形成的稳定 route key 对齐；
- `manual.py` 接纳用户明确绑定到具体 Literature 的本地 PDF 内部副本；
- `rules.py` 实现协议无关的 PDF 基本检查和当前主资产决定；
- `ports.py` 声明 asset source、临时获取、原子资产发布和自动获取耗尽事实 publication/clear 能力；
- `authorized.py` 固定已核实的授权主 PDF 合同和协议无关 route helper；
- `providers/` 保存授权内容 API client；
- `sources/` 保存公开协议、通用 direct 与受控 Browser 的外部访问实现；`routes.py` 将这些实现和授权 Provider client 包装成中性 route adapter。

Pre-v1 切换直接用 `PdfRouteAdapter`、Profile catalog 和 Planner 替换旧 `PdfSource`/registry/
Browser rule 内部合同，不保留双注册、adapter shim 或按旧 Source 列表执行的兼容层。该切换
只替换运行时内部接口：现有 `Literature`、`Asset`、`LiteratureAsset`、provenance、唯一
`primary-pdf` 与 `AutomaticPdfAcquisitionExhaustion` 的持久合同保持不变，不迁移或保存旧
tried set、route、cooldown、Cookie 或失败历史，因此不需要数据库 schema 迁移。

## 2. 输入与公开结果

### 2.1 自动获取

公开 API 接收具体 `Literature` 的中性 `LiteratureMetadata`、稳定标识符、当前 MetadataObservation 中的 Provider record identity 与 `AssetHint[]`、当前资产事实和本次运行临时排除的 candidate key 集合。它们只用于形成当前 `PublisherAccessResolution`、`AcquisitionPlan` 和候选，不把完整 vendor 对象带入 Acquisition。Resolution、Plan、route hint、Browser queue 和动态访问状态不是公开业务结果。正常业务结果严格是二选一：

```text
AcquisitionResult =
    AcquiredPrimaryPdf
  | NoPrimaryPdf

AcquiredPrimaryPdf
  asset: Asset
  relation: LiteratureAsset
  candidate_key: str

NoPrimaryPdf
```

`AcquiredPrimaryPdf` 表示不可变 PDF 字节、该 Literature 的唯一 `primary-pdf` 关系和已有自动获取耗尽事实的清除都已经安全提交；只完成下载或临时检查不能返回它。`candidate_key` 仅供当前 Entry 操作更新内存 tried set，不进入持久化关系。

`NoPrimaryPdf` 是无字段结果，但只能在以下条件全部成立后返回：当前元数据和已配置自动能力下的公开来源、已授权 Provider API 与受控浏览器路径已经正常遍历；没有候选、正常返回“未找到”、浏览器流程正常结束但没有下载，或候选非 PDF、为空、损坏等预期未命中已经收敛；并且该 Literature 的 `AutomaticPdfAcquisitionExhaustion` 已经安全提交。它不暴露或持久化原因枚举与逐候选详情。

用户中断、Network 传输或 API 错误、权限或配置错误、数据库或文件系统无法安全提交、并发变化导致提交条件失效，以及共享 Network readiness/policy/coordinator 本身不可用，都属于本次操作失败而不是第三种 Acquisition 业务结果。属于一个 candidate、locator、target 或 route adapter 的外部失败可以在内存中保留为脱敏稳定失败，并继续其它独立获取路径；若后续没有任何路径成功，Service 必须向 Entry 抛出稳定失败，不能返回 `NoPrimaryPdf`，也不能建立耗尽事实。配置与 readiness 预检、取消、Port 合同、清理、发布和 stale 失败立即终止。因此只有已经完整收敛且从未留下未解决 route failure，并成功提交耗尽事实的 `NoPrimaryPdf` 可以支持 MetaLiterature 切换版本。

公开 API 不暴露 URL client、HTTP response、Browser page/download、临时绝对路径或来源私有对象。

### 2.2 手动 PDF 接纳

手动接纳是与自动获取并列的独立 API。Entry 必须先把用户选择解析为一个具体 `LiteratureId`，并以只读方式打开用户输入文件；Acquisition 把字节复制到 owner-only 临时文件后再执行统一检查。输入路径和文件 handle 是适配边界值，不进入 Pydantic 业务 Model、provenance 或 Catalog。

成功结果为：

```text
AcceptedManualPdf
  asset: Asset
  relation: LiteratureAsset
```

`relation.role` 必须为 `primary-pdf`，`relation.source_url` 为空，provenance 使用 `source_kind = "user"` 和稳定 `source_name = "manual-pdf"`，并以内部复制字节的 SHA-256 作为输入 hash。只有内部不可变 Asset 和唯一关系都已经提交后才能返回成功。

以下情况直接形成稳定输入验证错误，不返回 `NoPrimaryPdf`：用户文件不存在或不可读、基本 PDF 检查失败、目标 Literature 不存在，或者该 Literature 已有当前主 PDF。文件发布、事务或 stale 复检失败仍是系统错误。手动接纳不产生 `PdfCandidate`、candidate key、tried set 或 `AcquisitionPath`，因此没有第四个自动阶段，也不是 `AcquisitionResult` 的第三个分支。

Acquisition 只复制用户字节，不移动、改名、截断、覆盖或删除用户原文件。成功只形成 `ASSET_READY` 并清除已有自动获取耗尽事实；Parsing 与 Analysis 由后续独立数据库补全操作发起。

## 3. Access Profile、运行时计划与三层 Route

本节只描述自动获取。手动接纳不注册自动 Route，也不进入下列层级。

目标实现把“识别原文访问方”“制定本次路线”和“执行 HTTP/API/Browser”分开：

```text
PublisherAccessProfile catalog
  + LiteratureMetadata / identifiers / observations / AssetHints
  -> PublisherAccessResolution
  -> AcquisitionPlan grouped by AcquisitionPath
  -> route adapter execution
```

一个外部机构可以具有多个独立 route adapter，例如公开 locator、授权内容 API 和 Browser 页面流程；它们共享 access profile 和 Network，但不挤进一个带大量可选参数的 vendor 接口。Planner 不执行真实 Provider 请求，adapter 不重新猜测当前 Literature 应属于哪个访问方。

### 3.1 PublisherAccessProfile 与访问身份

Acquisition 私有、无 secret 的静态画像至少表达：

```text
PublisherAccessProfile
  access_key
  platform_key
  landing_origins
  asset_origins
  stable_id_kinds
  weak_hints
  public_capabilities
  api_capabilities
  browser_probe_enabled
  policy_evidence / policy_revision
  production_status
  evidence
    display_name / product_name
    official / access-terms / rate-limit references
    verification_date / evidence_revision
    Provider Notes / offline fixture reference
```

`Metadata Provider`、`Publication/Access Provider` 和 `Access Platform/CDN` 是三种身份。ACS、IEEE、
RSC 等访问方可以拥有 Profile，而不加入 Metadata Provider 枚举或创建不需要的 API secret。

Profile 只包含经过核实、可静态验证的 origin、ID、Public/API capability、政策证据，以及是否支持
显式 Browser 可达性 probe；不再引用或安装 Browser route、页面程序、selector/locator、限速组或
会话组。统一状态只有 `production-ready`、`fixture-verified` 与 `unsupported`，但该状态不决定
通用 Browser 是否可用于某个网页。`browser_probe_enabled` 只让 `config test browser site` 对已知
目标执行只读可达性检查，不下载 PDF，也不证明登录、权限或 Browser 获取适用性。当前字段与矩阵
见 [Publisher Access Profile 准入与验证矩阵](../../notes/providers/publisher-access-matrix.md)。

### 3.2 PublisherAccessResolution 与 AcquisitionPlan

Planner 首先消费已经接纳的中性证据；已有明确 direct-file、公开仓储或稳定公开定位时，不为了识别出版社额外解析 DOI。需要确认访问方且强证据不足时，DOI safe resolve 作为 PUBLIC 层的一次受控动作：HTTP 只对 `doi.org` 发出不跟随 redirect 的第一跳 `GET`，读取并规范化 `Location` 后停止，不解析或请求 Publisher hostname；Publisher 目标等到 Browser lane 获得 permit 后才由 Chrome 访问。结果只保存在当前 work item。全部证据可用时按以下强度解释：

1. DOI 经 Network 安全解析后的实际 landing origin；
2. 访问方自有的 `AssetHint` origin；
3. arXiv ID、PMCID、Elsevier PII/IEEE arnumber 等来源明确的稳定文章定位；
4. MetadataObservation provenance 中的 Provider record identity；
5. publisher 字符串或单独 DOI prefix 只形成待确认弱候选。

多个强证据冲突时保持 unresolved 或形成稳定失败，不能按 catalog 顺序任选一个。MetadataObservation 来自 Scopus 不表示文献由 Elsevier 出版；Crossref 返回 Wiley 文献也不改变原文访问方。

运行时合同为：

```text
PublisherAccessResolution
  selected_access_key: str | None
  platform_key: str | None
  confidence: confirmed | unresolved | conflicting
  evidence: tuple[redacted resolution evidence, ...]
  canonical_landing: safe locator | None
  stable_article_ids: tuple[neutral stable id, ...]

AcquisitionPlan
  revision
  public_routes
  authorized_api_routes
  browser_routes
```

每个 planned route 具有稳定 route key、`AcquisitionPath`、适用证据、预期 capability、readiness 和 quota/risk-group identity，但不含 secret、HTTP response、Browser 对象或不可脱敏 locator。Planner 可以省略确定不适用的 route，不能把 Browser 排到一个仍适用的公开/API route 之前。相同输入产生相同 plan；层间新 hint 只增加新的 plan revision，不修改已接纳的 MetadataObservation。

目标 Acquisition 能力范围覆盖：

```text
arxiv
crossref
semantic-scholar
openalex
europe-pmc
unpaywall
elsevier
springer
wiley
datacite
core
sci-hub
```

这里使用稳定 Provider key；`springer` 表示 Springer Nature，`sci-hub` 表示默认关闭、必须由 operator 显式启用的 locator Source。启用后 resolver 使用当前版本 bundled mirror set；`sources.acquisition.sci-hub.urls` 可以用一到八个有序 HTTPS 镜像完整覆盖 bundled 列表，Python 显式注入 resolver 又优先于两者。三种选择都只对 canonical DOI 形成 landing locator，按序执行、不并发、不自动发现镜像。这里的“覆盖”表示相应服务能够贡献 PDF 字节、直接 locator、落地页或受控内容路径，并不要求每个名称都复制一套下载 adapter。Crossref、OpenAlex、DataCite 等 Metadata adapter 已经给出 `AssetHint` 时，由通用公开 route 消费同一线索；不为名称对称再实现只转发相同 URL 的 route adapter。Web of Science 和 OpenCitations 当前不作为原文来源。以上是目标矩阵，不证明当前代码或安装产品已经接入。

Acquisition named Source 由本地 Auto/Custom resolver 选择。当前 Auto 只启用 arXiv 与 Europe PMC
两个零配置公开协议；Custom 精确使用用户保存的顺序并允许为空。无论哪种模式，所有已保存且通过
安全验证的 direct/landing `AssetHint` 都是固有 Public 路线，不依赖同名 Provider enablement。
Sci-Hub、Unpaywall、CORE/Elsevier/Wiley 授权 API 不进入 Auto，Browser 仍由 `[download]` 独立
显式启用；凭据存在不改变 Source 选择。Registry/status/Planner 的选择解析不执行 DNS 或 HTTP，
运行时仍按 Literature 证据和 Public → API → Browser 层级短路，不对每篇 Literature 穷举全部
Provider。

`public:sci-hub` 复用共享 `PublicLocatorFetcher`。每个镜像 hostname 自动得到独立的保守 web
scope；landing 可直接交付 PDF，或通过有限静态声明（`citation_pdf_url` 与明确
`application/pdf` 的 `a/link/embed/object`）发现 locator。它不执行 JavaScript、不猜 selector、不
处理认证或 Challenge。Landing HTML 与发现候选仍先经过实际 PDF 字节、reader 和页面树检查；
最终 provenance 不保存镜像 URL、query 或页面内容。Registry/status/Planner 组装不执行 DNS 或
HTTP，所有测试使用 fake/fixture。

`direct` 只是消费已保存 locator 的通用公开 route，不是 Provider；手动 PDF 是用户明确绑定 Literature 的独立接纳操作，也不是 Provider 或第四种 `AcquisitionPath`。

Acquisition 把每个 planned route 放入一个且仅一个风险层级：

```text
AcquisitionPath =
    "public"
  | "authorized-provider-api"
  | "controlled-browser"
```

层级由 Planner、Profile capability 和生产对象图共同决定，不由 Provider 响应或 `AssetHint.access_status` 临时改写。Route adapter 可以使用：

- 已持久化并在使用时重新验证的 URL；
- 稳定标识符对应的来源 API；
- 供应商记录提供的资产线索；
- 受控浏览器页面流程。

目标概念 Port 为：

```text
PdfRouteAdapter
  name: str
  capabilities: tuple[RouteCapability, ...]
  readiness: RouteReadiness
  execute(
    planned_route,
    acquisition_context,
    excluded_candidate_keys
  ) -> one-or-more RouteExecutionOutcome

RouteExecutionOutcome =
    TemporaryPdfDelivery
  | AccessRouteHintsDiscovered
  | NormalRouteMiss
  | RouteDeferred
  | RouteActionRequired
```

Planner 已经决定当前 route 的适用证据；adapter 只验证 planned route 属于自己的封闭 capability，并在每个真实动作前检查 candidate/route key、Network admission 和取消。DOI 型授权 API 只有在当前 Literature 恰有一个 canonical DOI，且合同列出的 landing origin 或 AssetHint origin 已精确确认访问方时才形成 lookup target；AssetHint 只贡献规范 origin，原始 URL 不进入 target。Adapter 不能自行根据 publisher 文本、DOI prefix 或 Metadata Provider 名称增加其它 Provider 路线，也不能把 API 429、临时错误或页面 challenge 转换成 Browser route。Route adapter 只产生临时运行结果，不能发布 Asset、建立 `primary-pdf` 关系或改变 Literature 状态。

`RouteReadiness` 区分项目能力已实现、用户启用、静态参数/凭据/policy 就绪、当前 Literature 适用和当前 plan 实际需要。配置结构错误立即失败；未被当前 plan 使用的可选 capability 不阻止无关公开路径。当前 plan 需要但未就绪的 route 不能被计为正常耗尽，是否允许进入 Browser 由显式 Browser admission policy 决定并进入运行报告。

API capability 必须明确区分：

```text
metadata/search
locator/resolution
entitlement-check
structured-full-text
direct-pdf
multi-step-pdf-object
```

只有实际 PDF bytes 形成 `TemporaryPdfDelivery`；XML/JATS、canonical landing、稳定 object ID 或 entitlement 信息只能形成相应的运行时 hint/status，不能冒充主 PDF。

### 3.3 AssetHint 合同

`AssetHint` 表示 Metadata 供应商在一次 observation 中返回的单个资产访问线索。它不是已经下载的资产，也不是候选尝试记录。精确 schema 为：

```text
AssetHint
  url: str
  kind: AssetHintKind
  media_type: str | None
  asset_role: AssetRole | None
  version_role: VersionRole | None
  access_status: str | None
  license: str | None

AssetHintKind = "direct-file" | "landing-page"
AssetRole = "primary-pdf" | "supplementary-pdf" | "xml" | "html" | "supplementary"
VersionRole = "published" | "accepted-manuscript" | "preprint" | "other"
```

字段含义为：

| 字段 | 含义 |
|---|---|
| `url` | 供应商返回的绝对访问地址；同一 observation 中的不同地址分别形成不同线索 |
| `kind` | `direct-file` 表示供应商声明地址直接指向文件，`landing-page` 表示需要从页面继续发现或触发下载 |
| `media_type` | 供应商声明的媒体类型，例如 `application/pdf`、`text/html` 或 `application/xml`；未知时为空 |
| `asset_role` | 地址所指向的主 PDF、补充 PDF、XML、HTML 或其它补充资产；供应商没有明确说明时为空 |
| `version_role` | 地址所对应的正式发表版、作者接受稿、预印本或其它版本；供应商没有明确说明时为空 |
| `access_status` | 供应商在 `MetadataObservation.provenance.observed_at` 观察到的开放、受限或其它访问状态；使用开放字符串 |
| `license` | 供应商返回的许可证标识或许可证 URL；没有可靠信息时为空 |

Provider identity、provider record identity 和 `observed_at` 由所属 `MetadataObservation.provenance` 提供，不在每个 `AssetHint` 中重复。`AssetHint` 不保存请求 header、cookie、凭据或 vendor 私有对象；`url` 仍是不可信外部输入，每次 HTTP、redirect 或浏览器导航都必须重新经过 Network policy。

`kind`、`media_type`、`asset_role` 和 `version_role` 都是供应商声明的线索，不是 Acquisition 已验证的事实。`access_status` 和 `license` 描述具体访问渠道，不属于 `LiteratureMetadata`；它们也不证明链接当前可访问、响应是 PDF 或内容有效。

### 3.4 Route hint、候选与 adapter 边界

`AccessRouteHint` 表示当前运行中已经确认、可以改善后续计划但尚未取得 PDF 的中间结果，例如 canonical landing、来源明确的稳定 article ID、可安全表达的 PDF object locator 或具体 entitlement 状态。Hint 必须是封闭中性类型，携带来源 route、适用 access profile 和脱敏值；它不保存 header、Cookie、token、完整 vendor response、Browser object 或无法去除 secret 的签名 URL。必须依赖短期签名 locator 的多步请求留在同一个 adapter 私有流程中立即消费，不跨 Port 暴露。

Hint 只更新当前 work item 和 plan revision，不写入 `MetadataObservation`、`LiteratureMetadata`、Catalog、ArtifactStore 或 provenance。新操作不会恢复旧 hint；同一操作的后续 route 可以使用它减少重复 DOI 解析、页面导航或 locator lookup。

`PdfCandidate` 表示当前运行中一次可识别、可排除的实际 PDF 获取动作，不再假设所有动作都是一个可由通用 fetcher 直接请求的 URL。公开 URL、需要多步请求的 Provider API 和需要导航/点击/捕获的 Browser 流程都由各自 adapter 执行。候选精确合同为：

```text
PdfCandidate
  candidate_key: str
  source_name: str
  acquisition_path: AcquisitionPath
  declared_media_type: str | None
```

`PdfCandidate` 只存在于当前获取运行中。`candidate_key` 是当前运行 tried set 使用的非空稳定键，不是资产 ID、数据库身份或跨运行失败记录；它由 route、path 和不含凭据的来源内定位身份确定。同一 URL 在匿名 HTTP、授权 API 和 Browser 上下文中可以形成不同 key，因为三者可能取得不同字节。`source_name` 保留具体 route adapter 的稳定来源 identity，`acquisition_path` 只表达这次获取的风险层级；`declared_media_type` 只是来源声明，不能替代字节检查。

候选不保存或暴露 URL query secret、请求 header、cookie、凭据、API object ID、浏览器对象、页面 action 或其它 vendor 私有值，也不携带失败原因。Adapter 私有定位与多步动作留在边界内，不能用裸字典或 vendor model 扩展 `PdfCandidate`。明确为补充材料、XML 或 HTML 的线索不会形成主 `PdfCandidate`；补充资产走独立角色，不得伪装成主 PDF。

Route adapter 取得字节后向 Acquisition Service 交付 Port 内部临时结果：

```text
TemporaryPdf
  candidate: PdfCandidate
  content: bounded byte stream or owner-only temporary artifact
  safe_source_url: str | None
  provenance: Provenance
```

`TemporaryPdf` 不是业务 Model，不进入公开 API 或数据库。`safe_source_url` 只在能够去除凭据、敏感 query 和 fragment 时提供；`provenance` 记录具体 source 和输入 hash，不复制 Cookie、header、浏览器 profile 或页面对象。普通 HTTP 直接下载、多步授权 API 和浏览器 download/response 捕获都必须交付同一种临时结果，随后由 Acquisition 执行统一 PDF 基本检查。

Plan 固定按以下风险顺序组织 routes：

1. **公开来源**：先尝试 `kind = "direct-file"` 且声明或未排除为主 PDF 的 `AssetHint`，再按配置顺序尝试公共全文服务、OA locator 和普通 HTTP landing-page discovery；
2. **已授权 Provider API**：只调用 operator 已配置、当前 route readiness 通过且有强适用证据的内容 API；API key 存在、认证、quota、API 产品 capability 和目标内容 entitlement 分别判断；
3. **受控 Browser**：只处理前两层正常结束后的剩余目标，从 canonical landing 开始，使用一个
   operator-managed 固定身份 Profile、共享有头 CloakBrowser Chromium process/context 和隔离文章 page。
   Browser 只使用通用 `AgentBrowserController`；Agent 从第一次稳定 Observation 起选择封闭动作，
   Network 负责动作绑定、页面稳定化与捕获，Acquisition 负责 PDF/文章归属验收。无 GUI Linux 使用
   Xvfb；登录、MFA、拒绝或未找到等页面状态仍交给 Agent 观察，只有 Agent 明确 Stop 或硬性运行时
   边界才结束本次会话。

同一有界 cohort 的所有目标先完成公开层，再对未解决目标执行 API 层，最后才形成 Browser admission 集合。每层产生的新 landing、stable ID、locator 或 entitlement hint 更新 Resolution/Plan；公开/API 成功的目标立即离开后续 Acquisition 层。Planner 可以删除确定不适用的 route，但不能因为当前网络出口可能具有机构 IP entitlement 就跳过一个仍适用的公开/API route。

CORE 的公开 `downloadUrl`/source link 由第一阶段通用 route 消费；只有这些公开
路径全部未得到有效主 PDF，才会进入第二阶段 CORE 注册用户 download endpoint。CORE
Metadata 与 Acquisition 使用相同 `core/api` AccessScope 和保守准入政策，使 token/quota
反馈作用于同一当前进程预算。API key 只作为绑定到官方 HTTPS origin 的私有
`Authorization` header 传递，不进入 URL、候选、provenance 或输出。

Wiley 同样只在公开路径全部耗尽后运行。当前唯一 DOI 可以与已接纳 AssetHint 的
`https://onlinelibrary.wiley.com` 或 `https://alm.wiley.com` 精确 origin 直接绑定；若现有
证据仍不足以确认 Wiley，Acquisition 此时才通过共享 Network 安全解析该 DOI，且最终 origin
必须精确为 `https://onlinelibrary.wiley.com`。两条路径都只形成 DOI 与 confirmed origin
组成的中性 lookup target，再把 DOI 作为 opaque path parameter 交给 Wiley TDM endpoint。
唯一的 TDM token 只作为绑定到
`https://api.wiley.com:443` 的私有 `Wiley-TDM-Client-Token` header 传递；本地只验证
安全的非空 header 值，不用推测的 token 语法替代 Wiley 的认证判断。API 可以单跳到精确
`https://alm.wiley.com/alm/api/v2/download/<opaque-locator>`；共享 Network 逐跳复检该
Provider 专属路径，并在跨 origin 前移除 token。Wiley 本地 lookup 保持 entitlement
`UNKNOWN`；最终对该 DOI 返回 `200 application/pdf` 才证明该篇下载 entitlement。`404`
是正常 miss；认证、授权、quota、服务、schema、非 PDF 和 Network 失败形成该 route 的
稳定失败并允许其它独立 route 继续，最终没有其它路径成功时仍作为整个操作失败。即使响应
为 200，字节仍进入统一 PDF reader/页面树与不可变发布边界。

Elsevier 内容获取使用独立的 `api:elsevier-article-object` 多步 route。只有 PII、合法的
`1-s2.0-*` Article EID，或 DOI 已安全解析到 ScienceDirect/linkinghub origin 才构成
强适用证据；Scopus metadata observation 与普通 `2-s2.0-*` EID 不构成内容身份。
Adapter 以 `view=FULL` 和 `Accept: application/xml` 请求 Article Retrieval，只把同时
声明 `web-pdf-purpose=MAIN`、`extension=pdf`、PDF filename 与合法 attachment EID 的
条目转换成 `elsevier-main-pdf-object` locator，再以 `Accept: application/pdf` 请求
Object Retrieval。若 FULL XML 没有 MAIN object，或该 XML 表示因媒体类型冲突、畸形、
DTD/ENTITY 或未知 envelope 而不能安全解释，Adapter 不放宽 XML parser，而是用同一强 DOI、
PII 或 Article EID 形成私有的 direct Article PDF locator，并向相同 Article Retrieval
resource 协商 `application/pdf`。可解析的 `service-error` 必须先转换为 normal miss、认证、
授权、quota、服务或请求失败，不能借 direct representation 绕过。Article/Object 共用
`elsevier/api/article-retrieval-object` scope；
API key 与可选 institution token 只作为绑定到 `https://api.elsevier.com:443` 的私有
header。Object 或 direct Article PDF 正常 miss 后可返回当次 canonical landing、PII 和
Article EID hint；hint 不进入数据库。两种 PDF 响应都仍经过统一 PDF reader、页面树与
不可变发布；XML/JSON/HTML、补充材料和标记为 PDF 但实际承载错误 envelope 的响应不会成为
候选。Authorized adapter 的 Debug classification 对每个 lookup/download 只增加数值
`http_status`、受控 `informational|success|redirection|client-error|server-error` 状态类别、
representation、envelope、disposition 和中性 failure kind；response body、vendor status text、
header、URL/query 与凭据都不进入 LogRecord。ScienceDirect 同时具有独立的 production Browser
route、Profile rule 与 `elsevier` rate/session group；它仍只能由强访问方证据、显式 Browser
启用与 Browser admission 共同规划，不能把 API miss、quota 或错误本身当作自动启动 Browser 的
授权。

前一层全部当前适用 routes 均未成功并到达允许升级的终态后才能启动下一层；层级之间不并发竞速。未启用或对当前 Literature 不适用的 route 不属于本次耗尽集合。当前 plan 需要但缺少生产实现、必需参数、凭据或 policy 的 route 形成明确 unavailable/configuration 结果，不能被静默视为正常未命中；是否允许继续 Browser 由 Browser admission policy 决定。

正常未命中、明确不适用、明确无 PDF capability，以及 API 对当前目标无 entitlement 但机构 Browser 可能具有独立权限，可以进入下一步判断。一个普通、非临时的 route-local `failure` 本身不授权风险升级，但也不能取消已经由强访问证据和显式 policy 独立规划的后续 route；它在当前 work item 中保留，允许同层 route、后续 API 或独立 Browser route 救回。Timeout、临时传输/服务失败、`429`、`Retry-After`、quota exhausted 和未到 reset boundary 必须形成 `deferred`，需要用户处理的状态必须形成 `action-required`，二者都在 Browser admission 前停止该目标，不能用 Browser 制造替代流量。Fatal、配置结构、Port、清理、发布、stale 和取消错误立即终止。任一后续候选完整提交后立即停止该 Literature 的全部后续 routes，并清除先前 route-local issue；若最终没有成功，任一 deferred、action-required 或未解决 route failure 都必须作为稳定结果/失败返回，不能伪装成本次耗尽。

明确标记为补充材料、XML 或 HTML 的线索不能作为当前主 PDF 接纳。供应商声明的 `application/pdf` 可以提高同层候选顺序，但不能替代实际下载和基本检查。

`AssetHint` 不增加 `acquisition_path`、`requires_browser` 或 `requires_authorization`。它保存来源当时声明的线索；同一线索可以先匿名尝试，之后由相应授权或 Browser route 使用，但每次真实访问仍受自己的 Network scope 和 candidate key 约束。

每个 `sources/<source>` 或 `providers/<provider>` adapter 负责 endpoint、请求字段、API AccessScope 和官方政策声明、quota/`Retry-After` 解释、候选/hint 转换和来源失败边界。`PublisherAccessProfile` 只保留授权 API 所需的 access identity/origin，以及可选 Browser 首页可达性 probe；它不拥有 Browser 下载策略。Network 负责中性准入和 Browser runtime，Acquisition 的统一 PDF identity validator 负责主文献、supplement 与错文判断。普通 HTTP、API SDK 和 Browser 执行必须经过 Network 的共享访问准入。

Adapter 不能把候选直接写成当前主 PDF，也不能执行 Literature 身份判断、正文语义判断或状态推进。

### 3.5 Asset 与 LiteratureAsset

候选通过基本检查后形成两个不同的持久化事实：

```text
Asset
  asset_id: AssetId
  sha256: Sha256
  size_bytes: int
  media_type: str
  path: RelativeArtifactPath

LiteratureAsset
  literature_asset_id: LiteratureAssetId
  literature_id: LiteratureId
  asset_id: AssetId
  role: AssetRole
  provenance: Provenance
  source_url: str | None
```

`Asset` 只描述不可变文件事实。`size_bytes` 非负，`path` 是配置存储根下的规范化相对路径；Asset 不携带 Literature ID、资产角色、当前状态、来源 URL、版本角色或 provenance。

`LiteratureAsset` 表达具体 Literature 与 Asset 的角色和获取来源。`source_url` 只在能够安全保留时保存规范化、脱敏 URL；凭据、敏感 query 和 fragment 不能进入。来源身份、观察时间和输入 hash 由关系的 `provenance` 表达。关系不复制 `Literature.version_role`，也不增加 `is_current`。

同一 Literature 最多存在一项 `role = "primary-pdf"` 的 `LiteratureAsset`；这项唯一关系本身就是当前主 PDF。补充角色可以有多个，但不驱动 Parsing、Analysis 或 Literature 状态。相同 Asset 字节可以被不同关系复用，文件事实和文献归属不能因此混为一个对象。

## 4. 获取流程

```text
冻结的 Literature cohort
  -> 为每个目标形成初步 PublisherAccessResolution + AcquisitionPlan
  -> PUBLIC pass：全部目标先执行公开 routes
       ├─ PDF 成功：检查、发布并移出后续层级
       ├─ route hints：更新当前 work item，重新规划
       └─ 正常未命中/失败分类：保留当前运行结果
  -> AUTHORIZED_PROVIDER_API pass：只处理未解决目标
       ├─ PDF 成功：检查、发布并移出后续层级
       ├─ locator/identity/entitlement hint：重新规划
       ├─ 普通 route-local failure：保留问题，继续独立 route
       └─ deferred/action-required：在 Browser admission 前停止
  -> Browser admission：只选择低风险层允许升级的最小剩余集合
  -> CONTROLLED_BROWSER pass
       ├─ 所有文章使用 browser:generic + Agent controller
       ├─ browser-generic policy 逐文章限速串行
       └─ 共享一个 Profile/process/context，每篇文章使用隔离 article context
  -> 任一 route 取得 TemporaryPdf
       -> 执行统一 PDF 基本检查
            ├─ 不通过：清理临时结果，继续当前层的其它候选
            └─ 通过：计算 hash，形成 Asset 与 LiteratureAsset
  -> Storage 不可变发布 Asset
  -> 原子提交唯一 primary-pdf 关系并清除已有耗尽事实
       ├─ 成功：AcquiredPrimaryPdf
       └─ 系统提交错误：抛出，不转换为 NoPrimaryPdf

全部当前自动 routes 没有成功且存在 deferred、action-required 或未解决 route failure
  -> 抛出/报告脱敏稳定结果，不提交 AutomaticPdfAcquisitionExhaustion

全部当前自动 routes 正常结束、没有未解决状态且候选均未成功
  -> 提交 AutomaticPdfAcquisitionExhaustion(literature_id)
       ├─ 成功：NoPrimaryPdf
       └─ Storage 错误：抛出，不转换为 NoPrimaryPdf
```

一个候选正常未命中、没有 Browser 下载、格式错误或基本检查失败时清理临时结果并继续其它候选，不把详情带入下一个候选或数据库。一个 candidate、locator、target、DOI landing 解析或 adapter 的 Network/API/认证/授权/quota/service/schema 等外部失败，在不放宽 Network policy 的前提下转换为当前运行的脱敏状态；普通 route-local failure 允许独立路径继续，临时/额度状态则必须阻断 Browser admission，不能成为“已耗尽”证据。前者只有在后续 route 完整交付时才被清除。最终没有成功时，deferred/action-required 阻断结果优先；否则返回实际执行得最深的具体 route failure。Browser 正常未命中不新增 failure，因此仍保留先前 Public/API failure；Browser 实际执行并产生具体 failure 时以该 Browser failure 作为用户主结果，早期 route 证据仍保留在 Debug 事件中。这些状态只进入安全日志、内存聚合和本次非持久化 Report，不成为持久化候选历史。

后续 route 成功时正常短路；最终没有成功时选择稳定失败、deferred 或 action-required 结果，绝不能在尝试其它候选后伪装成完整耗尽。配置预检、取消、Port 合同、临时文件清理、发布和 stale 失败不属于可隔离的 route 失败，必须立即终止。不同候选可以有各自来源，但同一 `Literature` 只有一个主 PDF 驱动解析。候选通过基本检查并完整提交后立即形成 `ASSET_READY`，不等待正文内容判断。补充 PDF 或其它相关文件可以保存为补充资产，但不驱动 Parsing、Analysis 或 Literature 状态。

单个 Literature 内同一层的 routes 与候选按 plan 确定顺序短路，不进行跨层竞速。Entry 可以有界
并行处理 cohort 内不同 Literature；API 并发最终由官方 quota scope 门控，Browser 尝试由
`browser-generic` policy 串行。等待 Network/Browser permit 不等于候选失败。

Debug 诊断为 cohort、tier、route、route adapter、授权 source/target/lookup/download 和 Browser source/candidate 记录单调时钟耗时。每个 route 终态显式使用 `disposition=delivered|miss|deferred|action-required|failure|fatal` 与 `next=next-route|next-tier|browser-admission|stop` 说明实际控制流；授权 API source 同时报告 strong-evidence target 数、attempted 与 delivered。正常模式不逐条显示 route miss、candidate、capture 或 cleanup，而保留交付、Browser 分组/等待、最终耗尽和带 code/retryable/reason/action 的稳定失败。日志不能改变 route 聚合、Browser admission 或耗尽判断。

当前实现通过 `prepare_primary_pdf_cohort()` 一次接收按冻结顺序排列的请求，在 Public 与
Authorized API pass 中对不同 Literature 使用有界 worker；每篇内部的 route 顺序保持
确定，整个 cohort 完成当前层后才进入下一层。每层结束都重新生成 Resolution/Plan；新出现
且尚未尝试的同层 route 会在离开该层前补跑，已经尝试的 route/candidate 不会重复，plan
revision 回环作为稳定合同失败终止。返回的 `PreparedAcquisitionCohort` 只包含按输入顺序
排列的 opaque receipt 或稳定失败，以及当前 Browser admission summary；它不可序列化，
不会在 prepare 阶段发布 Asset 或写入耗尽事实。调用方提供 observer 时，Acquisition 在每层
屏障结束后把该层刚到终态的 item 作为不可变波次提前交付：波次按 Public、Authorized API、
Browser/final 顺序发生，波内保持输入冻结顺序，每个 Literature 只交付一次。最终 cohort
必须复用已经提前交付的同一 item 与同一 receipt，并补齐尚未交付项；不能生成第二份 receipt
或改变早期结果。observer 拒绝波次或合同构造中途失败时，Acquisition 尝试清理该波全部新
receipt，清理错误优先传播且不能阻止其余 receipt 的清理尝试。

Entry 可以在 cohort 继续处理后续层时，通过单一串行提交边界逐个 commit/discard 已提前
交付的 receipt；stale/CAS 只影响对应 Literature。任何 receipt 清理失败都必须作为稳定
Acquisition 失败或原始程序错误传播，不能只写日志。最终 cohort 合同不一致时，不回滚已经
安全提交的局部成功，但必须清理尚未交付 receipt 并让未交付目标稳定失败。

当前完整生产对象图与 capability-scoped Completion 对象图都显式组装并共享同一 Profile
catalog/Planner、tiered cohort executor、Browser scheduler、session broker 和 admission controller。
Publisher profile catalog 继续服务授权 API 识别与可选首页可达性 probe，但不生成 Browser 下载
route。生产 Browser 只有：

| Route | Controller | Policy group | 运行准入 |
|---|---|---|---|
| `browser:generic` | `AgentBrowserController` | `browser-generic` | 总开关 + image Model + Profile + runtime + 逐文章检查 |

普通 `[browser].enabled`、所选 image Model、选中且安全存在的固定身份 `profile`、CloakBrowser
wrapper、经验证的 patched Chromium binary、Playwright API 和 headed display 共同决定 Bootstrap
是否创建真实 Browser client。存在一个全局 operator-managed Browser Profile identity，不存在逐
Publisher Profile/grant 或点击规则字段；Profile presence、登录状态和逐文章 entitlement 分开判断。
Browser admission 据此报告最小剩余集合、runtime readiness、待处理动作和保守时长，只为具有安全
文章起点的 admitted work 产生 Browser 流量。Source 从已接纳的文章 landing/direct hint 或 DOI safe
resolve 形成有界文章流程；opaque AssetHint path 不直接导航。若精确起点仍是
`doi.org/<唯一 DOI>`，destination guard 只把该完整 URL 的 initial navigation、同一导航响应和受
审查重定向链视为本次入口，不会因此批准其它 resolver URL、download 或任意站点。普通文章流使用
`navigation_only=False` 和 `discard_unapproved_subresources=True`：当前已准入页面发起的必要资源
仍逐项通过 destination guard，未批准的第三方非关键子资源在 DNS 前丢弃；顶层 navigation、popup
和 PDF capture 继续 fail closed。导航期间已经捕获的 PDF 优先，否则 Agent 根据稳定 Observation
选择一项封闭动作。点击或页面脚本触发的 `3xx` 由 Chrome 原生继续；每个显式 request 逐项重审，
未再次暴露 route 的 native redirect 成员只能在同页 live ancestor、批准且预绑定的最终 origin 和
terminal host admission 都成立时关联，任何跨页或未预绑定结果都不读取 body。多路正文捕获、HTTP
attachment、跨 origin CDN、统一 PDF 文章归属、supplement/错文排除、通用 cooldown/circuit、共享
persistent context 中的文章隔离/临时资源清理和安装 wheel 后的本地 Chromium foundation 已由离线
测试验收；这只证明实现与准入闭环，不证明 Profile 已登录、当前 IP、机构协议、任意站点 Agent
策略或具体文章 entitlement。

### 4.1 Browser admission、会话与调度

Browser admission 在启动任何 Browser runtime 前检查：

- 当前 Literature 的公开/API routes 是否已正常结束，是否仍有 deferred、quota 或系统失败；
- 是否存在已准入的 landing/direct 起点，或唯一 DOI 已经安全解析为 landing；不要求命中已知
  `PublisherAccessProfile`；
- `browser:generic`、`browser-generic` policy、显式总开关、选中的本地 Browser Profile identity
  manifest、CloakBrowser wrapper/binary、Playwright API 与 headed display 是否 ready；
- Browser role 的 image/tool capability 和所选 Model 是否 ready；
- Browser 是否由用户显式启用，以及支持但未配置的 API route 是否按当前 policy 允许继续；
- `browser-generic` 是否处于 cooldown、blocked 或 open circuit。

Admission 汇总剩余论文数、Agent/readiness、runtime 状态、通用政策、最早开始时间和保守最低时长。
它只形成当前操作的允许、延期、action-required 或拒绝结果，不读取 Cookie，也不把完整 URL 或
临时 runtime 信息写入 Report。

相同安全诊断在 Debug 中报告 eligible、admitted、attempted、delivered，以及 `browser-generic` 的
queue wait、pacing、Profile session reuse、Observation/step、capture 分类和 cleanup outcome。完整
URL、DOI、页面文本、截图内容、Profile 路径/内容和 PDF 字节不进入 LogRecord。

所有文章进入同一 `browser-generic` 串行队列，按项目审慎 baseline 执行文章启动间隔、窗口、
完成/失败冷却和 circuit。Operator 只能通过 `[browser].policy_overrides` 收紧这一组，不能按
Publisher 拆组、改名或放宽。`max_concurrency` 是本机资源 cap，不会创建额外 process/context，
也不会绕过通用队列的逐文章串行。

一次 `BrowserArticleAttempt` 的 permit 从第一次文章起点导航前开始，覆盖 Observation、页面动作、
popup、response/download 捕获、TemporaryPdf 转换以及页面、下载和临时文件清理。下一篇和失败重试
都必须等待 `browser-generic` policy；redirect、多个标签页或备用起点不能绕过 permit。页面子资源
不逐个使用“文章间隔”，但继续受 Network host admission、单次请求/导航/动作 timeout 和单项
响应/捕获字节上限约束。

作业进入 Controlled Browser 时只构造 `AgentBrowserController`。它从第一份经过 Network readiness
gate 的可操作 Observation 起构造 Browser role `AgentCall`；每次 Runtime 调用只返回当前 revision
的一个动作。Controller 只取得当前 article 的 `BrowserFlowSession`，不取得 process、persistent
context、Profile、Cookie、selector/locator 或 download vendor object。Agent 的公共动作精确为：

```text
ClickElement
ClickPoint
ScrollSurface
GoBack
WaitForChange
Stop
```

`ClickElement` 绑定当前 revision 的短期 element ID。`ClickPoint` 绑定当前 article/page/surface/viewport/screenshot/revision，用于 closed Shadow DOM、canvas、图片控件或 Challenge 等只能从当前截图定位的可见目标；Network 在执行前验证 revision、surface、viewport 与坐标范围。`GoBack` 不接受 URL，`WaitForChange` 只使用单次 action timeout，`Stop` 不调用 Browser vendor API。Agent 不获得任意 URL、JavaScript、selector、跨 revision/raw coordinate、键盘文本、文件上传、Cookie、Profile、CDP、文件系统或创建额外 Browser/context 的能力。

`AgentBrowserController` 不保存模型 Session、跨作业 history、累计 token/image/time 或用户可配置的
repeat/step budget；实现只保留固定的 controller safety fuse。它取得一个 article-local
`BrowserStepSession`，唯一循环是：

```text
step = steps.start()
while step is Ready:
    action = decide(step.observation)
    step = steps.apply(action)
```

每次 `Ready` 都重新构造独立 `AgentCall`；一次模型决定只对应一次 `apply`。安全绑定与机械无进展判断
使用两类不可互换的 fingerprint：

```text
execution_binding_fingerprint(observation)              # exact stale safety
stable_semantic_page_fingerprint(observation)            # article-local state
stable_action_intent_fingerprint(action, observation)    # article-local intent
```

exact fingerprint 包含当前 revision/短期对象绑定；模型调用期间页面变化时，`apply` 在 vendor I/O 前
重新收敛当前页面并返回新的 `Ready`，不会把旧动作重放到新页面。stable fingerprint 排除 revision、
screenshot/element/surface 短期 ID 与无意义 geometry 抖动，只用于判断观察是否已经稳定和记录
`semantic_changed`，不再用于把重复动作或 self edge 自动升级为 `Blocked`。页面没有变化时仍可继续
让 Agent 决定下一步；candidate timeout 只是 Network 的内部等待结果，会隐藏 pending 状态并恢复
可继续的 `Ready`。只有显式 `Stop`、取消、controller safety fuse 或硬故障结束会话。

`_GenericStepPolicy` 由 Acquisition 拥有，只把中性 Observation 分类为通用 page state，并绑定
当前 article capture policy；`_GenericStepSessionFactory` 把它交给 `session.browser_steps(...)`。
Acquisition 不取得 transition driver，也不调用 `observe / settle / execute`。Network 在 `start/apply`
内部完成页面 readiness、分类后的 ledger 同步、page/frame/popup/viewer replacement、Candidate/capture、
timeout 和 cancellation；相同 stale 状态有界失败，不能忙循环。Agent 因此只会看到满足 Network
稳定性和通用页面分类的 Observation。

跨层结果只有 `Ready / Captured / Blocked / Failed / Cancelled`。`Ready` 是唯一可继续结果；
`CANDIDATE`、stale、quiet fingerprint 和 vendor transition 都只存在于 Network。`Captured` 仅表示
Agent 尚未开始探索时已有一项有界捕获；Agent 已开始探索后，materialized capture 从 Observation
中隐藏，但保留在 Browser 的外层 `BrowserCaptureBatch`。`Blocked` 的 payload-free reason 由 Agent
`Stop` 提供；candidate timeout 不跨越 StepSession 边界，系统、policy、runtime 和 controller safety 是 `Failed`，
用户取消是 `Cancelled`。`BrowserAgentResult` 只保存这一项终态以及 action/model count 和 last
action，不重复保存业务验收结论。不可配置的 32 次 model-decision safety fuse 防止实现缺陷无限运行；
触发时形成 non-retryable `controller-safety-limit`，不能写成正常未命中或自动获取耗尽。

route 只把这一项稳定终态映射为 Acquisition evidence，而不重建第二套状态机：完整 capture batch 先
进入既有 PDF candidate 验收；没有可接纳 capture 时保留取消与具体 Network/Agent failure；只有没有
更强证据时才形成普通 `no-download`。Challenge、登录、MFA、拒绝和未找到只是交给 Agent 的页面
描述，Agent 明确 Stop 后才按 stop reason 形成对应稳定结果。Network 已有关联但未收敛的 capture
会在控制层返回隐藏候选进度的 `Ready`，让 Agent 继续寻找入口；只有 Agent 最终停止且外层仍无
capture 时才返回 `capture-timeout`，Source 再转换为
`acquisition-browser-candidate-timeout`；该失败比更早 Public/API route failure 更接近实际交付点。
如果动作已经 dispatch、Network 只因 successor Page 的统一 snapshot 暂时失败，Network 会在 action
deadline 内重新观察；只有真正超时或不可恢复故障才返回 generic `acquisition-browser-agent-action-failed`。
该处理不适用于 destination policy、取消、timeout、Candidate/capture、Stop、cleanup 或其它具体
Network 终态。

当前 Browser 事件形成非空、按实际字节 hash 去重的中性候选批次；每项分别服从单项字节上限，
不设置整篇累计候选数量或总字节预算。
捕获机制封闭为 download event、普通 PDF response 和 popup response。每项 Browser action 在导航前
构造不可序列化的 article-local capture intent；
Network 只提供 query-free locator、kind/media、direct 或 redirect-descendant correlation、exact
start、navigation、redirect depth 和 native-download 等中性 `BrowserCaptureEvidence`，Acquisition
的 `_GenericCapturePolicy` 才解释当前 article goal、identifiers 与 landing 事实。

Policy 返回 `ACCEPT / DEFER / REJECT`。`ACCEPT` 后 Network 才读取 response/download body；
`DEFER` 只保留 operation-local、未读取、未发布的 Candidate，并在 landing 绑定或 native download
到达后按当前事实重新判定；`REJECT` 立即丢弃。Pending resource 不缓存最终布尔许可。只有受控
direct start 或当前文章关联证据充分的候选才 `ACCEPT`；supplement、显式冲突 DOI 和 wrong article
直接 `REJECT`，身份事实尚可能补齐时才 `DEFER`。

同一个 article-local policy 还实现可选 prefetch 判定，但它只为 `GET` 且资源类型为
`document|fetch|xhr`、并已按当前 goal/start/identifiers 明确分类为 `PRIMARY` 的 response 请求返回
true。这只允许 Network 在正常 response event 前保留稳定的 Playwright body source，不等于
`ACCEPT`：实际 status/media/evidence 仍必须再次通过 capture policy，`206` partial response 不形成
主文候选。

精确 direct-PDF 起点的 opaque redirect 只在以下条件同时成立时接纳：起点来自本篇已接纳的
AssetHint，最终 response/download 是该 navigation 的 live redirect descendant，Network
destination/origin/DNS/host 已准入，且最终 locator 没有显式携带另一 DOI。普通 landing、同源
PDF 或单独的媒体类型不能借此
放宽文章归属。通过该例外的 evidence 只保存在同一个 article-local policy 中，不进入可序列化的
`BrowserCaptureBatch`；Source 在形成候选前要求返回 capture 的 locator、kind 与 media type 精确匹配
一项 accepted evidence，并按当前 article goal 重新验证原 lineage。普通 capture 仍再次执行
locator/media/identity 分类；没有 accepted evidence 的同源 opaque locator 或与 evidence 不一致的
capture 继续拒绝。只有 `application/pdf` 或受控 locator 返回的 `application/octet-stream` 可以通过；`.pdf` 后缀、
媒体声明和 Browser 事件本身都不证明字节有效。每项不同捕获分别形成 `TemporaryPdf` 和稳定 candidate
key，随后仍依次经过统一 PDF reader、页面树、hash 和不可变发布；任何捕获都不能从 Browser 直接写成
主资产。

每项 capture 在形成 `TemporaryPdf` 时必须附带 `BrowserPdfAssociationEvidence`。统一
`pdf_identity` validator 从 PDF 可提取文本、安全 locator 和起点 lineage 比较目标 DOI、标题与
作者；受控 direct-PDF 起点可作为强关联证据，冲突 DOI、supplement/appendix、错文和总证据不足
直接拒绝。多个候选保持事件顺序并逐项进入字节门和文章归属门；媒体类型、文件名和 Agent 判断
都不能越过最终验收。

当前 `TieredCohortExecutor` 只把 Browser admission 明确允许的最小剩余 item 转为
`BrowserArticleAttempt`，并从 `browser-generic` snapshot 取得 policy 与所选 Profile session key。
Scheduler callback 覆盖整个 route adapter 调用，因此 Network Browser 的 page/download/临时
目录清理已经完成后才会释放组内文章 permit；route 的 deferred、action-required、失败、取消
或异常均按失败完成处理并保留适用冷却。所有 Browser item 保持冻结输入顺序；缺少 scheduler 的
admitted route 会稳定失败。

`max_concurrency` 默认 `5`，必须是严格整数且大于 `1`，不设上限；它只保护本机执行资源。所有
文章共享一个 CloakBrowser Chromium process/persistent context，较大的 cap 不会启动多个 Browser，
也不改变 `browser-generic` 固定 `concurrency = 1` 的政策。

Scheduler 同时拥有 `browser-generic` 的进程内 `blocked_until`、连续 runtime failure 计数和封闭 circuit
reason。Cohort 把 Browser route 的稳定终态转换成封闭 `BrowserGroupFeedback`，只有完整 route
callback 和资源清理结束后才原子更新 group。rate-limit 推进声明的 cooldown；登录、MFA、
IP block、账号警告或达到阈值的 runtime failure 打开相应 circuit；Agent 明确 Stop 或 Candidate
timeout 时保留当前文章的具体结果，不制造 interaction 状态族。重复 self/cycle 不再自动形成
failure；若达到 32 次 safety fuse，则形成 controller safety failure。Challenge resource 被本地策略阻断形成独立的 resource-blocked failure，不能
冒充页面拒绝或 Agent 已经尝试 Challenge；cleanup failure
不等待 runtime 阈值，立即打开通用 cleanup circuit。每个排队任务在
Browser callback 前再次检查该状态，所以同一批中的后续 Literature、下一次 cohort、不同
route key 和备用入口均不能绕过。被动态状态拦截的 item 分别形成稳定
`deferred` 或 `action-required`，不会被写成 exhaustion。

Browser route 的 article context/page/popup/download/response stream、文章临时目录、Network
permit 和 scheduler task 使用一次性所有权与粘性 cleanup 结果；共享 process/context/Profile
lease 由 Browser broker/runtime 独立拥有，单篇文章不能关闭仍服务其它 lane 的共享资源。取消或
timeout 后未在本机 cleanup timeout 内确认停止的 runtime 不交付晚到候选；即使此前已经捕获 PDF，也转换
为 cleanup 系统失败，请求在其它活动 lane 排空后淘汰共享 runtime，并阻断同组后续任务。这个
本机单次 cleanup timeout 不属于 Provider policy，不能用来缩短文章间隔。
如果不可变资产与 catalog 关系已经成功提交，之后 receipt/staging cleanup 失败仍必须传播稳定
系统失败，但不得删除、覆盖或回滚已经发布的资产和关系，也不得转而提交自动获取耗尽。

Admission 在下一次评估时把同一 scheduler 的动态 snapshot 与通用 Browser route、本地 Browser
Profile presence/runtime readiness 合并，摘要显示 `rate-limited` 或具体 action-required reason
以及剩余最早开始时间。rate-limit
只在 monotonic `blocked_until` 到期后自动恢复；circuit 不因连续成功自动关闭，只能以精确
group 和 policy revision 显式确认。确认不会清空仍有效的 cooldown。动态 snapshot、scheduler
和有序执行结果均不可序列化，且不携带 URL、selector、Cookie、Token、Literature 或 route
locator。

Network 已提供使用所选 Profile identity 的 process-local session broker：一个 operator-managed
固定身份 Profile 只启动一个有头 CloakBrowser Chromium process/persistent context；每篇文章仍拥有
独立 article token、page、下载临时
目录、单项字节上限、连接绑定和结果。runtime/清理失败只在其它活动 lane 排空后淘汰共享 runtime。
Broker 关闭或进程退出后删除临时下载目录、释放 Profile lease，但保留 Profile 中 Chromium 管理的
Cookie/认证状态。Bootstrap 已把同一个 broker 与 scheduler、admission、cohort executor 注入
Acquisition 运行对象图。总开关关闭、Browser Model/Profile 缺失或 runtime 未就绪时不构造可执行
client。自动流程只使用当前
机器正常网络出口和所选固定身份 Profile，固定以 `headless = false` 启动 CloakBrowser patched Chromium；无 GUI Linux
由 Xvfb 提供完整窗口栈，但不开放用户可见 Browser 认证流程。自动流程不填写登录表单、
不选择机构、不读取 Cookie/登录结果，也不处理 MFA；这些身份页面形成 action-required 并暂停对应
group。Challenge 页面不是身份登录流程；Agent controller 通过统一页面合同处理，Agent
可以使用当前 revision 的 element 或 screenshot-bound point，不取得专属 Challenge target。

Browser 运行事实使用三个正交维度，不再建立 `BrowserRunStateMachine` 或 Challenge 子生命周期：

```text
page_state:
  NORMAL | CHALLENGE | LOGIN_REQUIRED | MFA_REQUIRED |
  NOT_ENTITLED | ACCESS_DENIED | NOT_FOUND | FAILED

agent_status:
  RUNNING | STOPPED | FAILED

capture_state:
  NONE | CANDIDATE | CAPTURED
```

`page_state=CHALLENGE` 本身不是默认终态；页面脚本自动清除或 controller 动作清除后，下一 Observation
自然返回普通页面。`LOGIN_REQUIRED`、`MFA_REQUIRED`、`NOT_ENTITLED`、`ACCESS_DENIED`、`NOT_FOUND`
和 `FAILED` 都只是给 Agent 的稳定页面描述，不能由 Network 或 Publisher policy 自动升级为终态；
只有 Agent 明确 Stop，或之后发生独立的 timeout、cancel、controller safety、runtime/cleanup failure
时才形成对应 route 结果。rate limit、IP block、账号警告、Network resource blocked 和
runtime/cleanup failure 仍由相应 route/scheduler failure 表达，不挤进 page state。
文章资源清理或 runtime failure 可以让已经捕获的候选失效，因为完整文章事务关闭前不能把字节视为
安全交付。

Observation、动作 receipt、语义转换记录和 controller status 只存在于当前进程内存，可以转换为
安全日志和本次操作的稳定 `normal-miss`、`deferred`、`action-required` 或 failure；它们不进入
Literature Model、Catalog、数据库表、Artifact、provenance 或跨运行失败历史。risk-group 信号由当前
进程 scheduler 更新 `blocked_until` 与 circuit；独立 API/Metadata scope 仍按各自政策继续。自动策略只能减速或暂停，
不能根据连续成功自动提速或自动关闭 action-required circuit。

页面分类只消费 Network 提供的统一 `BrowserObservation`。Observation 包含 article/page identity、
单调 revision、page/popup/frame/Shadow/viewer surface tree、query-free origin/path/title、viewport/scroll/
surface bounds、当前 screenshot、安全可见 element、page state、capture state 与上一动作 receipt；
不含 response、HTML、header、Cookie、selector 或 vendor object。通用分类只使用这些中性状态；
不会加载 Publisher marker 或 selector catalog。登录、MFA、无 entitlement、拒绝、404 与 Challenge
通过 Observation 的封闭 `page_state` 表达；裸 HTTP `403` 仍只表示 `ACCESS_DENIED`。

当前文章的动态 destination guard 必须在每次 navigation、popup、response 和 download 实际访问前
执行，并叠加 Network 的通用 URL、DNS、redirect、origin、credential forwarding 和 host admission。
它从 exact start、当前已准入 page/request 关联和有限 redirect ancestry 扩展，不从 Publisher catalog
取得任意 origin。supplement/appendix/supporting information 在 Acquisition PDF 文章归属门排除。
签名 query 只保留在当前 Browser operation 并交给 Chrome，日志、结果、provenance 和持久事实只
接收 query-free locator。未知 Provider 只要有合法文章起点，也可使用同一通用 Browser 路线。

### 4.2 手动接纳流程

```text
具体 Literature + 只读用户文件
  -> 预检 Literature 当前没有 primary-pdf
  -> 复制字节到 SciRetriever owner-only staging
  -> 对 staging 副本执行统一 PDF 基本检查
       ├─ 不通过：删除 staging，返回输入验证错误
       └─ 通过：形成 Asset 与 source_kind=user 的 LiteratureAsset
  -> Storage create-if-absent 发布内部字节
  -> 事务内复检 Literature 和唯一 primary-pdf 条件
       ├─ 成功：建立关系、清除已有耗尽事实并返回 AcceptedManualPdf
       └─ 失败：系统错误；用户原文件保持不变
```

用户文件从始至终不属于 Storage staging 或 ArtifactStore，不参加对账与回收。只有复制后的内部字节可以在后续明确 `NoUsableContent` 清理中删除。

## 5. PDF 基本检查

自动获取和手动接纳的内部副本执行同一组基本检查：

1. 实际字节非空，并通过字节嗅探确认是 PDF，而不是空响应、HTML、JavaScript 或其它格式；
2. 标准 PDF reader 能够打开文件；
3. 页面树可读取且至少有一页；需要密码但没有可用密码、因而无法读取的加密 PDF 不能通过；
4. 自动候选来自目标 `Literature` 的 `AssetHint`、稳定标识符或已配置文献来源；手动文件由用户明确选择具体 Literature，两种路径都不能无依据地关联字节。

轻微不规范但仍能由 reader 正常打开并读取页面树的 PDF 可以接纳。检查失败时立即清理 `TemporaryPdf`，不形成 `Asset`、`LiteratureAsset` 或候选级失败事实，并继续下一个候选。

以下信号不能单独代表成功：

- HTTP `200`；
- Browser download event；
- `.pdf` 文件扩展名；
- HTTP `Content-Type`；
- 网页声称提供全文；
- 响应文件名或 Content-Disposition。

本阶段不比较标题、作者、年份或 DOI，不设置固定最小页数、最小字节数或正文字符数，也不判断是否提取到正文、是否只有封面、目录、标题/元数据、摘要、错误提示或正文是否完整。PDF 是否包含属于当前目标 Literature 的实际文献内容由 Analysis 根据 parser-neutral `ParserResult` 判断，不能写成 MinerU 专属规则。

## 6. 发布与并发复检

基本检查通过后，Service 形成独立 `Asset` 和 `LiteratureAsset` 发布请求。Storage 先不可变发布字节，再在短事务中复检：

- Literature 仍存在；
- 当前统一元数据仍与获取输入一致；
- 当前主 PDF 没有被另一结果替换；
- Literature 尚未具有与当前主 PDF 对齐的有效 `CONTENT_READY` 内容；
- 发布的文件 hash 与请求一致。

只有文件发布、唯一 `primary-pdf` 关系和已有自动获取耗尽事实清除都成功后，Service 才返回 `AcquiredPrimaryPdf`。Stale 结果拒绝建立关系并作为系统提交错误返回；已发布但未引用的相同内容由 Storage 对账处理。发布失败、事务失败、hash 冲突或 stale 都不能降级为 `NoPrimaryPdf`。

手动接纳走同一发布、耗尽事实清除和复检边界，但成功返回 `AcceptedManualPdf`。它还必须复检目标从调用开始到提交时都没有主 PDF；竞争产生主 PDF 时拒绝手动结果，不能覆盖。手动关系的 `source_url` 固定为空，机器绝对输入路径不参与去重键、hash 或 provenance。

全部当前自动路径正常结束且没有主 PDF 时，Acquisition 使用独立短事务幂等写入 `AutomaticPdfAcquisitionExhaustion(literature_id)`，成功后才返回 `NoPrimaryPdf`。用户明确重试该 Literature 时，Entry 通过 Acquisition 公开操作先清除该事实，再发起新的自动获取；清除失败属于 Storage 错误。该事实不携带来源、原因、候选、时间、次数或配置快照。

## 7. 无效内容清理协作

Analysis 返回结构有效且明确的 `NoUsableContent` 时，Entry 协调 Acquisition/Storage 撤销当前主 PDF 关系并删除 PDF、对应 ParserResult 和待验收结果，再继续其它候选。该结果表示 ParserResult 没有属于目标 Literature、足以说明该文献实际研究、论证、综述、讨论或报告了什么的内容；一页 PDF 不自动无效。

如果当前主 PDF 来自手动接纳，清理只作用于 ArtifactStore 中的 SciRetriever 内部副本、关系和派生结果；用户原文件不在数据库中，也绝不能由此流程删除。手动来源没有自动 candidate key，清理后是否再次手动接纳只能由用户明确发起。

清理后不保留该次 `PdfCandidate`、逐候选失败、无效决定、主 PDF 的 `LiteratureAsset` 或其获取 provenance；Asset 字节不存在其它有效关系时一并回收，存在其它关系时只删除当前 Literature 的关系。原始 `MetadataObservation` 及其 `AssetHint` 仍是先前已经取得的来源事实，不附加本次失败标记。本次 Report 只需要表达仍未获得可用内容。Entry 在本次运行的内存 tried set 中记录稳定 candidate key，避免立即选择同一候选；新运行不恢复 tried set，允许从当前元数据重新发现。ParserResult 乱码、截断、只剩资源引用或不足以判断，以及 Parser 或 LLM 调用失败，都不属于内容无效，必须保留 PDF。

一旦 Literature 已经形成与当前主 PDF 对齐的有效 `CONTENT_READY` 内容，普通候选发现不得自动替换该主 PDF。替换已接纳内容所依据的资产属于单独的显式产品变化，不由本候选循环隐式触发。

同次操作内再次获取仍从公开阶段开始，但跳过本次 tried set 中的 candidate key，因此会先耗尽剩余公开候选，再进入授权 API 和浏览器。后续新操作不恢复 tried set；如果该 Literature 已有自动获取耗尽事实，只有用户明确重试或新的 MetadataObservation 清除该事实后才会再次自动获取。新进程不恢复上一进程的 provider 冷却、`blocked_until` 或 API 窗口；当前进程仍在运行时，重试不能绕过 ADR 0012 的共享准入。

## 8. Network、官方政策、凭据和资源

- Route adapter 使用 Network 的 HTTP 或 Browser；
- 普通配置只表达 capability 启用、产品、Browser 总开关、opaque Profile identity 与只能收紧的
  AccessPolicy override；Provider secret 由根级 configuration 从固定
  `~/.sciretriever/credentials.toml` 私有解析，再由 Bootstrap 注入具体 adapter；Browser Profile
  可以由 Chrome 保存 Cookie/session 状态，但 Acquisition 不读取、解释或输出这些内容；
- Adapter 的本地 readiness、真实认证和具体 Literature 全文 entitlement 是三个不同判断；`config test` 最多验证当前服务 readiness，不能证明任意文献可下载；
- API adapter 声明稳定 quota identity、`provider_name`、`api` channel、必要的 `service_name`、允许 origin，以及从官方规则核实的 concurrency、interval、burst/window、period quota、reset 和 feedback；Metadata/Acquisition 共享官方额度池时使用同一 scope；
- Provider Notes 保存易变官方数字、endpoint、响应头和证据日期；没有可执行 policy 的 production adapter/Profile readiness 不通过，普通配置不能提高速率或扩大额度；
- 所有 routes、Metadata、Parsing 和 Analysis 共用 `sciretriever.bootstrap` 为当前进程组装的 Access Coordinator；adapter 不建立局部 limiter，也不能让 vendor SDK 绕过准入；
- 普通网页使用实际 host 的 `web` scope 和声明政策；Browser 额外使用 `browser-generic` policy，
  对全部文章固定 `concurrency=1` 并执行项目审慎 pacing；
- 公开 `AssetHint` 指向出版社网站时仍受该出版社网页 scope；不同来源落到同一最终 host 时还共享实际 host 预算；
- `Retry-After`、quota 响应和 `blocked_until` 由 adapter 解释、Access Coordinator 执行；等待 permit 不转换为 `NoPrimaryPdf`，quota/临时失败也不自动切 Browser；
- 所有 redirect 和最终下载主机继续受 URL/DNS/origin policy；
- Provider quota 的含义属于 adapter，进程内执行和 host 预算属于 Network，cohort 与目标并发属于 Entry，Browser group/session 调度属于 Acquisition 与 Network Browser 边界；
- PDF 响应使用有界流式读取和硬大小上限；
- 临时文件位于 owner-only 临时目录，并在成功、失败、取消后清理；
- 凭据不进入来源 provenance、URL、文件名、数据库或用户输出。

## 9. 验收

直接测试至少覆盖：

- 目标 Acquisition catalog 区分 Metadata Provider、Access Provider 与平台；项目能力、生产实现、用户启用、route readiness 和当前 Literature 适用性分别判断，已有 AssetHint 由通用公开 route 消费而不复制转发 adapter；
- `PublisherAccessResolution` 优先解释实际 DOI landing、访问方自有 AssetHint origin、来源稳定定位和 Provider record identity；publisher 字符串、单独 DOI prefix 或 MetadataObservation 来源都不能独立证明内容 API/Browser 适用；多个强证据冲突不会任选一个；
- Scopus 返回的 Wiley 文献不会误路由到 Elsevier Content API，而 Crossref 返回且 DOI 实际落地到 Elsevier 的文献可以选择就绪的 Elsevier route；访问方 Profile 不要求成为 Metadata Provider 或凭据 section；
- `AcquisitionPlan` 对相同输入确定，Planner 可以省略不适用 route 但不能提前 Browser；DOI safe resolve 同一 work item 最多一次，层间 route hint 可以重新规划且不进入数据库；
- 实际字节非空、reader 可打开、页面树可读取且至少一页的 PDF 成功，轻微不规范但可正常读取的文件不被过度拒绝；
- 空响应、截断、损坏、非 PDF 字节和无可用密码的不可读加密 PDF 失败；
- HTTP 成功但内容错误不能接纳；
- `.pdf` 后缀、文件名、HTTP `Content-Type`、Content-Disposition 或 Browser download event 都不能替代字节与 reader 检查；
- 候选与 Literature 没有依据关系时拒绝；
- 自动 `AcquisitionResult` 只接受 `AcquiredPrimaryPdf` 或无字段 `NoPrimaryPdf`；没有候选、正常未命中、Browser 流程正常结束但无下载及无效 PDF 可以收敛到后者且不携带原因；candidate/locator/target/route 局部外部失败允许继续其它独立路径，但最终没有成功时必须抛出稳定失败，配置预检、取消和共享 Network readiness/coordinator 错误立即向外传播，二者都不能形成耗尽；
- `NoPrimaryPdf` 只有在三阶段全部当前路径正常结束且最小 `AutomaticPdfAcquisitionExhaustion` 已提交后返回；该事实只有 LiteratureId，不保存来源、原因、候选、时间、次数或配置快照；
- 手动 PDF 要求明确具体 Literature，先复制到内部 staging 再执行相同基本检查；成功返回只含已提交 Asset/LiteratureAsset 的 `AcceptedManualPdf`，且 provenance 为 user/manual-pdf、source URL 为空；
- 手动文件不存在、不可读、不是有效 PDF、目标不存在或已有主 PDF 时形成输入验证错误，不进入 `NoPrimaryPdf` 或第三个自动结果；竞争产生主 PDF 时拒绝而不覆盖；
- 手动接纳不创建 PdfCandidate、candidate key、tried set、第四个 AcquisitionPath 或输入绝对路径记录，只达到 `ASSET_READY`、清除已有自动获取耗尽事实，不自动继续 Parsing/Analysis；
- 成功、失败、取消、stale 和后续 NoUsableContent 清理均不移动、修改或删除用户原文件，只能清理 SciRetriever 内部副本；
- 文件发布、数据库提交、耗尽事实提交、hash 冲突或 stale 失败作为系统错误传播，不能返回 `NoPrimaryPdf`；只有 Asset、唯一 `primary-pdf` 关系和已有耗尽事实清除都提交后才能返回 `AcquiredPrimaryPdf`；
- `AssetHint` 的直接文件和落地页语义、可选字段及封闭角色被正确解析；
- 同一 Literature 的不同 `AssetHint` 分别保留 URL、媒体类型、资产角色、版本角色、`access_status` 和 `license`，且这些值不进入 `LiteratureMetadata` 或替代 PDF 基本检查；
- `PdfCandidate` 只存在于当前运行，只保存 candidate key、route adapter 的稳定 source identity、acquisition path 和声明媒体类型，不要求 URL，也不保存 header、Cookie、凭据、API object、页面 action、私有对象或失败详情；补充材料、XML 和 HTML 不成为主 PDF 候选；
- `AccessRouteHint` 只保存封闭、脱敏的 canonical landing、稳定 ID、locator 或 entitlement 线索，不能携带 Cookie/token/vendor object，也不能持久化；短期签名 locator 留在 adapter 私有多步流程；
- 普通 HTTP、多步授权 API 和浏览器捕获都先形成相同的 `TemporaryPdf`，不能绕过统一基本检查；
- `Asset` 只保存不可变文件事实；`LiteratureAsset` 保存 Literature、角色、脱敏来源和 provenance，不复制 Literature version role 或增加 `is_current`；
- 公开直接主 PDF 线索优先；一个 cohort 的公开层完成后才启动未解决目标的授权 Provider API，API 层完成并通过 admission 后才启动最小剩余 Browser 集合，成功后不继续后续 routes；
- 同一 Literature 不跨层竞速；不同 Literature 可以在 cohort 内有界并发，API 由官方 quota scope
  门控，Browser 由 `browser-generic` 严格限速串行；
- 同一 provider 可以分别注册公开线索、授权 API 和 Browser route，层级由 Acquisition Plan 决定且不写入 `AssetHint`；
- header、cookie、凭据和 vendor 私有对象不能进入或随 `AssetHint` 持久化；
- 一个候选正常未命中或基本检查失败后继续下一个；candidate/locator/target/DOI landing/adapter 的独立失败可以继续其它适用低风险路径，但 timeout、429、`Retry-After`、quota 或临时服务失败不能自动触发 Browser，最终 unresolved/deferred/action-required 不能提交自动获取耗尽；
- 未启用或不适用 route 不进入本次耗尽集合；当前 plan 需要但缺少实现、参数、凭据或 policy 的 route 明确报告且不能静默耗尽；取消、Port、清理、发布和 stale 失败立即终止；
- 同一 Literature 最多存在一个 `primary-pdf` 关系，且该唯一关系就是当前主 PDF；
- PDF 通过基本检查后立即形成 `ASSET_READY`，不等待 LLM 内容判断；
- 基本检查验证非空实际 PDF 字节、reader 可打开、页面树至少一页和候选归属依据；Browser 候选
  额外比较 DOI/标题/作者/direct-start 关联，强冲突、supplement 或总证据不足时拒绝；不判断正文/
  摘要/目录/封面或学术内容，也不使用固定页数、字节数或正文字符数；
- 重复相同字节复用，不同字节不能覆盖；
- Stale metadata 或当前资产变化时拒绝发布关系；
- Browser 下载不能绕过基本检查；
- `browser-generic` 在当前进程跨用户操作和文献目标 `concurrency=1` 并遵守声明的文章间隔/window/
  cooldown；独立 API scope 仍按各自政策推进；
- Browser permit 覆盖完整文章流程和资源清理；重试、redirect、popup、viewer、多个标签页或备用入口不能绕过组内串行、间隔、`blocked_until` 或 circuit；
- Browser 的登录、MFA、无 entitlement、rate-limit、IP block、账号警告和 runtime failure 形成当前运行事实；只有登录、MFA、IP block、账号警告、cleanup 或达到阈值的 runtime failure 等明确 group feedback 才打开对应 circuit，不写数据库或阻塞无关 group；
- Challenge、登录、MFA、无 entitlement、拒绝和未找到使用与普通页面相同的 Observation 与六种动作；
  页面状态是给 Agent 的描述，不由 Network 自动变成终态。自动或经动作 clear 后继续 capture；
  Agent Stop、候选等待超时、取消、硬性 runtime failure 和 32 次 model-decision safety fuse
  保留各自稳定结果；候选等待超时不会单独结束 Agent，也不打开 Challenge group circuit；本地 resource-blocked 不冒充页面拒绝或 Agent 失败；
- Browser 只注册 `browser:generic` 并构造 `AgentBrowserController`，无 Publisher rule、selector controller
  或 fallback；未知 Publisher 具有合法起点时也可进入；
- Agent controller 只调用 `start/apply`；Network 在一次 step 内完成 exact binding、最多一次 dispatch
  和 settlement，只返回五类稳定结果；一次无变化、重复动作或页面短暂不变都仍是可继续的 settled step，
  不再生成 no-progress terminal；
- Candidate 必须在 Network 内 captured、cleared 或 timeout，不能交给 Agent；已捕获候选在 Agent 已开始
  探索后从 observation 中隐藏，但保留在本次 `BrowserCaptureBatch`，以便 Agent 继续尝试其它入口，
  最终由 Acquisition 统一执行 PDF 与文章归属验收；
- 固定 32 次 model-decision safety fuse 只形成 `controller-safety-limit`，不形成正常未命中或耗尽；
- Agent 每次只返回一个绑定当前 revision/surface/viewport 的封闭动作，由同一 CloakBrowser article
  handle、Browser permit、Network guard 和 capture handler 执行；不能创建额外 context/process、
  任意导航、selector/JavaScript 或直接发布 PDF；
- Browser Agent 没有固定页面路径或页面状态终止规则；保留单次 action/observation、文章运行时和
  32 次模型调用等硬预算。PDF candidate 只是待验收批次；Agent Stop、取消、真实系统错误或预算
  耗尽才是自然停止条件，候选 timeout 只触发一次内部等待并恢复 Agent 可继续的 `Ready`；
- 每次 Browser navigation/popup/response/download 在访问前通过文章级 dynamic destination guard 与
  Network policy；supplementary、冲突 DOI、错文或关联证据不足的 PDF 不成为主 PDF；
- Metadata 与 Acquisition 使用同一 API quota 时共享 scope；API `Retry-After` 和 quota 阻塞对所有调用方生效；
- redirect 到新的 provider/host 不能绕过目标网页 scope 或 host 预算，公开状态不形成限速豁免；
- 当前进程内的失败、超时和取消不能泄漏网页 permit 或清空仍有效的冷却/`blocked_until`；新进程不恢复这些动态状态；
- Analysis 明确返回 `NoUsableContent` 时完成清理并可继续候选；一页完整短文不因页数被直接判无效；
- 同次运行使用临时 tried set 避免立即重试，新运行允许重新发现且数据库不保存无效 candidate/route/decision；
- 新 MetadataObservation、成功自动或手动主 PDF、用户明确重试都会清除自动获取耗尽事实；全库自动补全默认跳过仍有该事实的 Literature；
- Parser/LLM 调用失败、ParserResult 乱码/截断/只有资源引用或无法判断时不删除 PDF；
- 无效候选不留下候选级长期详情；Analysis 明确无内容后的清理移除当前关系和无效资产信息，但不篡改原始 MetadataObservation/AssetHint；
- 已有有效 `CONTENT_READY` 内容时不自动替换主 PDF，补充资产不驱动 Parsing、Analysis 或状态。

凭据、readiness 和 `config test` 测试使用临时凭据文件、fake adapter 与本地 Network，不读取真实用户配置，也不访问真实供应商。

HTTP 和 Browser 测试使用本地受控站点，不连接真实供应商。
