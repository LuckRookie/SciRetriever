# Provider 接入注意事项

本手册记录 SciRetriever 与外部机构接口适配时需要长期保留的注意事项，包括公开契约、外部 API 观察、现场验证结果和难以从公开资料获得的经验。它解释外部事实和排障边界，不重新定义 provider 能力；当前公开入口仍以 README、Composition wiring、源码和直接测试为准。

任何凭据值、用户身份、内部工单内容或受限响应正文都不得写入本手册。配置只使用 `env:VARIABLE_NAME` secret reference；provider client 如何取得认证材料属于调用方依赖，不在本文定义第二套映射。

## 1. 记录规则

### 1.1 证据等级

| 等级 | 含义 | 记录要求 |
|---|---|---|
| `official` | 供应商当前公开文档或协议明确说明 | 给出官方链接和核对日期 |
| `implementation` | 当前 SciRetriever 代码、配置或测试明确表达 | 给出实现位置或说明，并随代码变化同步 |
| `verified` | 使用最小请求在当前环境中直接验证 | 记录日期、状态码和不含敏感信息的结果 |
| `support` | 供应商支持渠道、申请邮件或用户核实获得，公开资料未载明 | 记录来源类型和日期；不得写入工单或邮件中的敏感内容 |
| `inferred` | 根据多次故障和对照试验形成的工作假设 | 明确写成假设，并给出下一次复核方法 |

供应商政策随时可能变化。`support` 和 `inferred` 不能写成永久 SLA；超过六个月未复核的条目应视为待验证。

### 1.2 每个机构的最小信息

新增或更新 provider 时，必须记录以下信息；不适用或尚未核对的字段也要明确标为“不适用”或“待核对”：

1. SciRetriever schema v2 中的 provider 选择键、adapter 能力和所需标识符。
2. 凭据申请入口、外部认证位置和是否允许匿名调用。
3. 供应商公开限流规则，以及本项目实际采用的并发和间隔。
4. 凭据生命周期、失效症状、最小健康检查和恢复方式。
5. 返回内容、授权范围和常见失败不能混为一谈的边界。
6. 最后核对日期、证据等级和已知但尚未解决的实现限制。

下文各机构的端点、响应字段和认证要求均按外部 API 观察或历史验证记录，不代表仓库已经提供对应的具体 client。只有明确标为 `implementation` 的内容才描述当前源码；外部事实必须单独标注证据等级。新增或实质修改 provider / resolver 时使用 [Provider 接入开发手册](../development/provider-integration.md)，记录请求预算、有限 timeout、验证、脱敏和退役证据。历史 WP3 准入记录已进入[文献库实施归档](../archive/2026-07-literature-library/wp3-acquisition-admission.md)。

### 1.3 当前 Composition 边界

- Schema v2 用 `sources.providers`、`collection.citation_providers` 和 `assets.providers` 分别保存 metadata、citation 和 asset 选择键。通过配置验证只证明名称受合同接受。
- 当前 Infrastructure 只提供通用 `MetadataClient`、`CitationClient` 和 `ResolverClient` Protocol，以及包装这些 Protocol 实现的通用 adapter；仓库没有供应商专用的具体 client，也不在 adapter 内选择供应商端点。
- `build_object_graph` 只有在调用方提供 `ProviderDependencies` 时才建立 provider registry。Composition 只连接调用方传入的 `metadata_clients`、`citation_clients` 和 `resolver_clients` 映射，不构造具体 client。Registry 使用 lazy factory，映射中缺少对应 client 时会在构造 capability 时稳定失败。
- 当前对象图没有把 registry 连接到 `CollectionService` 或 `ContentAssetService`，项目也没有受支持的终端用户 CLI。Provider key、adapter 类型或旧树实现存在，都不能写成当前可运行的用户工作流。
- `credentials.metadata` 和 `credentials.acquisition` 只保存通用 secret reference。当前 wiring 不把它们解析并绑定到 provider-specific client；具体 client 和认证材料仍由调用方提供的依赖负责。
- Provider 返回 observation 或 locator，不代表业务接纳。文献身份、资产内容、目标对齐、不可变发布和 provenance 仍由 Core 与 Service 规则决定。
- Sci-Hub 没有默认 endpoint。Translator 和 browser 只存在于历史记录，当前六层树和 Composition 没有这些实现。Operator 仍负责确认 endpoint、会话和内容访问的授权范围。

### 1.4 通用排障顺序

当 provider 失败时，按以下顺序区分责任边界：

1. 确认环境变量已配置且非空，但不得打印变量值。
2. 用供应商最小只读端点发起带凭据请求，记录状态码。
3. 对允许匿名访问的服务，再发起同资源的匿名请求作为对照。
4. 区分认证失败、授权范围不足、限流、资源不存在、无全文候选和内容校验失败。
5. 通过通用 adapter 和调用方所提供 Protocol 实现的受控测试，或通过调用方程序执行同一请求，判断问题在供应商、凭据还是本地 adapter/transport。
6. 将新发现按证据等级补回本手册；不得只留在聊天、一次性脚本或个人记忆中。

## 2. Provider 总览

| 机构 | schema v2 选择键 | 外部 Metadata API 观察 | 外部 Asset API / 字段观察 | 外部认证要求 |
|---|---|---:|---:|---|
| arXiv | `arxiv` | 是 | 主文 PDF | 无 |
| Crossref | `crossref` | 是 | 解析主文 PDF | 无；建议提供联系邮箱 |
| Europe PMC | `europe-pmc` | 是 | 开放主文 PDF | 无 |
| OpenAlex | `openalex` | 有 | 公开主文 PDF | 当前无具体 client；官方现需 key |
| Semantic Scholar | `semantic-scholar` | 有 | `openAccessPdf` 主文 PDF 线索 | 可选 API key |
| Unpaywall | `unpaywall` | 否 | 开放主文 PDF | Email 必需 |
| Elsevier | `elsevier` | 是 | 主文 PDF、补充 PDF、XML | API key 必需，内容授权另计 |
| Wiley | `wiley` | 否 | 主文 PDF | TDM token 必需，内容授权另计 |
| Springer Nature | `springer` | 是 | XML、HTML | API key 必需，端点授权另计 |
| Configured Sci-Hub | `sci-hub` | 否 | 外部主文 PDF 声明 | 由 operator 显式提供 client 与获准 endpoint；仓库没有默认 endpoint 或具体 client |

表中的 Metadata 和 Asset 列只汇总外部 API 能力或响应字段，不表示对应供应商 client 已实现。`direct` 是对 WorkVersion 已持久化 HTTPS locator 的通用入口，不对应单一外部机构，因此不在逐机构条目中重复说明。历史 translator 和 browser 不是 schema v2 的 provider 选择键，当前六层树也没有对应实现。Sci-Hub 和其它外部访问方式的安全边界以当前代码、架构和 [Provider 接入开发手册](../development/provider-integration.md)为准；本文不写入 endpoint、profile path 或 session 数据。

## 3. Semantic Scholar

> 维护状态：公开 API 页面、外部字段观察和历史验证记录于 2026-07-21 核对；60 天规则来自用户核实的非公开知识。

### 外部 API 观察与当前接入状态

- Semantic Scholar 使用 `x-api-key` header；外部 API key 可选，但官方建议提供。
- 外部 Academic Graph API 提供 `paper/search`；响应中的 `openAccessPdf` 可提供开放 PDF 地址线索。
- 当前仓库没有 Semantic Scholar 专用 metadata、citation 或 resolver client，也没有写死 `paper/search` 或 `openAccessPdf` 字段处理。调用方必须自行提供符合通用 Protocol 的实现，并把它放入 `ProviderDependencies` 对应映射。
- Schema v2 没有 Semantic Scholar 专用凭据字段；具体 Protocol 实现如何取得认证材料也由调用方负责。

### 公开规则

- `official`，2026-07-21：大部分端点允许匿名访问，但匿名请求共享限流池，在高负载时可能进一步受限。
- `official`，2026-07-21：新 API key 的起始限流通常为每秒 1 个请求；官方建议每次请求都携带 key。
- `official`，2026-07-21：API key 必须保密；使用许可为 at-will，AI2 可变更或终止 API 能力。
- 官方入口：[Academic Graph API](https://www.semanticscholar.org/product/api)、[API 文档](https://api.semanticscholar.org/api-docs/graph)、[许可协议](https://www.semanticscholar.org/product/api/license)。

### 经验规则与当前事件

- `support`，用户于 2026-07-21 核实：**API key 连续 60 天不活跃会被移除**。截至该日期，公开 API 页面、教程和许可协议均未找到这条 key 生命周期规则，因此不得把它描述为公开保证。
- `verified`，2026-07-21：当前保存的 key 调用 Graph API 返回 HTTP `403 Forbidden`；相同 DOI 不带 key 返回 HTTP `200`。环境变量非空且没有首尾空白。这只证明 API 服务正常且该 key 已不可用；是否由 60 天失活移除导致，不能仅凭状态码确定。
- 归档历史脚本曾包含明文旧 key。归档按工作区策略保持不变，但任何新文档、测试、示例和日志均不得复制该值。

### 保活与排障

- 本项目建议每 30 天执行一次最小只读健康检查，为 60 天失活窗口保留余量。这是本地使用策略，不是官方要求。
- 健康检查应查询一个稳定 DOI，只请求 `paperId,title` 等最小字段；不得下载全文或批量搜索来保活。
- 预期结果：带 key 返回 `200`。若带 key 返回 `403` 而匿名对照返回 `200`，优先判断 key 已失效或被撤销，不应重试轰炸端点。
- `429` 表示限流，应遵守退避；不能据此判断 key 是否过期。
- key 失效后，通过官方申请入口重新申请，并更新调用方管理的 secret 来源和 client。不得将新 key 写入仓库、命令历史或诊断报告。

### 已知实现边界

- 当前通用 `ResolverClient` Protocol 不规定 `openAccessPdf.url` 提取或 landing page 解析，仓库也没有 Semantic Scholar resolver client。归档中的 translator/browser 路径不是当前实现。
- API 返回元数据成功不代表存在全文，也不代表具备版权内容访问权。

## 4. Elsevier

> 维护状态：外部 API 入口、产品授权说明和历史验证记录于 2026-07-21 核对；key 生命周期待核对。官方入口：[Elsevier Developer Portal](https://dev.elsevier.com/)。

### 外部 API 观察与当前接入状态

- Elsevier 使用 `X-ELS-APIKey` header；外部 API key 和内容授权是两个条件。
- 外部 metadata 入口包括 Scopus Search。Article Retrieval 可按 DOI 请求 `view=FULL` XML，附件元数据中的 EID 可用于请求主文或补充 PDF；XML 也可作为外部资产类型。
- 当前仓库没有 Elsevier 专用 client。Schema v2 也没有 Elsevier 专用凭据字段；调用方负责提供已认证且符合通用 Protocol 的具体实现。

### 使用注意

- `official`，2026-07-21：API key 有效不等于有权获取某篇全文；官方说明完整 API 访问取决于所属机构对相应 Elsevier 产品的订阅。
- `verified`，2026-07-21：现有 key 对官方 API 最小直连请求返回 HTTP `200`，但当时的历史 acquisition 在两篇真实样本中均超过外层 90 秒。这是当时本地 provider/transport/timeout 问题的证据，不能归类为 key 无效，也不代表当前 Composition 已接入 Elsevier client。
- 外部 API 观察：通过 article XML 获取 PDF 时需要可识别的附件 EID。HTTP `200` 但没有匹配 EID 应按响应结构或授权范围排查。

### 检查重点

- 分别验证 Scopus Search、Article Retrieval 和 Object Retrieval；不要用一个端点的成功推断全部产品权限。
- `401`/`403` 先检查 key、产品授权和机构网络；`429` 检查配额与并发；长时间不返回需检查本地硬超时是否真正终止底层请求。
- 供应商政策和申请入口变更时，在此补充官方链接和核对日期。

## 5. Wiley

> 维护状态：外部 TDM 入口和 2026-07-21 历史实测已核对；公开 TDM 页面在自动核对时返回 HTTP `403`，申请入口、公开限流和 token 生命周期待人工浏览器复核。参考入口：[Wiley Text and Data Mining](https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining)。

### 外部 API 观察与当前接入状态

- Wiley 使用 `Wiley-TDM-Client-Token` header，token 与文章访问授权是两个条件。
- 外部 Wiley TDM article 端点提供主文 PDF 获取路径。
- 当前仓库没有 Wiley 专用 resolver client。Schema v2 也没有 Wiley 专用凭据字段；调用方负责提供已认证且符合通用 `ResolverClient` Protocol 的具体实现。

### 使用注意

- `inferred`：TDM token 和文章访问授权是两个不同条件；token 可用不保证每个 DOI 都返回 PDF。复核时应以 Wiley 当前 TDM 条款和已知授权 DOI 对照验证。
- `verified`，2026-07-21：现有 token 在当时的分层基准中对 1 篇 OA 和 1 篇 closed 样本均成功，是该轮唯一明确通过出版社授权 API 获取 closed 文献的 provider。该记录不代表当前 Composition 已接入 Wiley client。
- 安全要求：返回 HTTP `200` 后仍必须通过 PDF 内容校验，不能只依据状态码认定成功。

### 检查重点

- 最小健康检查使用团队确认可访问的稳定 DOI，避免用未知授权文章判断 token 生命周期。
- `401`/`403` 需分别核对 token 状态和内容授权；`404` 还可能表示 DOI 不在当前 TDM 路由内。
- 供应商告知的 token 生命周期、配额或许可变化应按 `official` 或 `support` 等级补录。

## 6. Springer Nature

> 维护状态：外部产品入口、产品分层和历史接入记录于 2026-07-21 核对；key 生命周期和具体配额待核对。官方入口：[Springer Nature Developer Portal](https://dev.springernature.com/)。

### 外部 API 观察与当前接入状态

- Springer Nature 的外部 key 作为查询参数发送，不同 API 产品的授权彼此独立。
- 外部 Metadata API 提供元数据。Springer Nature 的外部产品还包括 JATS/XML 和 HTML 路径；本手册不把这些观察解释为 PDF 能力。
- 当前仓库没有 Springer Nature 专用 client。Schema v2 也没有 Springer Nature 专用凭据字段；调用方负责提供已认证且符合通用 Protocol 的具体实现。

### 使用注意

- `official`，2026-07-21：Springer Nature 将 Metadata、Open Access 和 Full Text/TDM 作为不同 API 产品；一个产品可用不能证明其它端点已授权。
- 历史接入记录，非当前实现：HTML acquisition 使用 metadata 返回的 HTTPS canonical URL；拿到 landing page 不等于拿到 PDF。
- 安全要求：端点返回的媒体类型必须与调用方声明的预期类型一致，不能仅凭成功状态码接纳响应。

### 检查重点

- 分别验证 metadata 和 JATS/XML 端点，并记录 key 的产品授权范围。
- 遇到 `401`/`403` 检查 key 和端点授权；无记录或无 canonical URL 时检查 DOI 覆盖范围与元数据完整性。

## 7. OpenAlex

> 维护状态：公开 API 文档、外部字段观察和历史接入记录于 2026-07-21 核对；当前仓库没有带认证的 OpenAlex 具体 client。官方入口：[OpenAlex API 文档](https://docs.openalex.org/)、[申请免费 key](https://openalex.org/settings/api)。

### 外部 API 观察与当前接入状态

- 外部 OpenAlex API 支持 cursor 分页，记录可包含 `best_oa_location`、`primary_location` 和 `locations` 中的 `pdf_url`。
- Schema v2 没有 OpenAlex 专用凭据字段，当前仓库也没有 OpenAlex 专用 client。官方当前要求免费 key，因此调用方提供的具体 Protocol 实现必须自行处理认证；匿名请求不能视为稳定能力。

### 使用注意

- `official`，2026-07-21：当前 OpenAlex 文档说明 API 需要免费 API key，并提供每日免费额度。SciRetriever 没有构造或注入该 key 的具体 OpenAlex client；匿名访问即使暂时可用，也不应视为稳定契约。
- `inferred`：OpenAlex 的开放状态和 PDF 地址来自聚合元数据，可能滞后或与目标站点实际可访问性不一致；需用 resolver 响应和最终下载结果对照复核。
- `verified`，2026-07-21：真实样本中，标记为 `closed` 的记录仍出现可公开下载的直链；有 `pdf_url` 的候选也可能返回 `403`、HTML 或失效内容。
- 历史接入记录，非当前实现：旧 client 曾按确定性顺序扫描 location 列表并返回首个 HTTPS locator；该 locator 下载或验证失败时，不继续同一 OpenAlex record 的其它 locations。

### 检查重点

- 排障时同时保存 resolver URL、候选 PDF 主机和最终状态码，但不得保存受限响应正文。
- 不要把 OpenAlex 的 OA 分类直接解释为版权授权结论。

## 8. Crossref

> 维护状态：公开 REST API 页面、外部字段观察和历史接入记录于 2026-07-21 核对；无凭据生命周期。官方入口：[Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)。

### 外部 API 观察与当前接入状态

- Crossref 无 API key；官方建议用 `mailto` 标识礼貌池请求方。
- 外部 work message 可以包含 `content-type` 为 `application/pdf` 的 link，但登记的候选不保证可下载或确实返回 PDF。
- 当前仓库没有 Crossref 专用 client，schema v2 也没有 provider-specific `mailto` 字段。调用方必须在自己提供的具体 Protocol 实现中处理 `mailto` 和 User-Agent。

### 使用注意

- `official`，2026-07-21：Crossref REST API 暴露成员和可信来源登记的元数据，无需注册；官方提供 `mailto` polite pool 用法。
- `inferred`：Crossref link 来自登记元数据，不应假定候选可匿名访问、持续存在或实际返回 PDF；应以最终响应和内容校验复核。
- `implementation`：当前 Composition 不构造 Crossref client，也不从 schema v2 向供应商专用 client 注入 `mailto` 或 User-Agent。
- `verified`，2026-07-21：真实基准中出现候选可下载但响应 `Content-Type` 带参数，随后被严格媒体类型模型拒绝的情况；这是本地规范化问题，不应归因于 Crossref 无链接。

### 检查重点

- 区分“Crossref 无 PDF link”“候选 URL 下载失败”和“下载成功但内容校验失败”。
- 当前通用 `ResolverClient` Protocol 不规定出版社站点解析，仓库也没有 Crossref resolver client。调用方实现遇到 landing page 或 HTML 响应时仍须遵守访问、验证和脱敏边界。

## 9. Europe PMC

> 维护状态：外部 API 观察和历史接入记录于 2026-07-21 核对；官方页面自动读取失败，公开限流和服务政策待核对。参考入口：[Europe PMC RESTful Web Service](https://europepmc.org/RestfulWebService)。无凭据生命周期。

### 外部 API 观察与当前接入状态

- 无凭据。
- 外部 API 支持 cursor 分页，并可按 PMID 或 DOI 查找记录；部分记录提供 `open_access_url` 主文 PDF 路由。
- 当前仓库没有 Europe PMC 专用 metadata 或 resolver client。调用方必须自行提供符合通用 Protocol 的实现。

### 使用注意

- `inferred`：Europe PMC 的覆盖具有领域特征；跨领域 DOI 无匹配不应直接判断为服务故障，需用已知收录记录对照。
- 排障语义：找到元数据但没有开放全文路由时，应记录为“无 PDF route”，而不是网络失败。
- 历史接入记录，非当前实现：旧 client 曾优先使用 PMID，没有 PMID 时再使用 DOI。

## 10. Unpaywall

> 维护状态：外部 API 观察和历史接入记录于 2026-07-21 核对；官方页面依赖 JavaScript，公开限流和 Email 政策待人工浏览器复核。官方入口：[Unpaywall API](https://unpaywall.org/products/api)。Email 是请求身份，不存在 API key 生命周期。

### 外部 API 观察与当前接入状态

- Unpaywall 外部 API 要求非空联系 Email；它是请求身份，不是访问付费全文的凭据。
- 该 provider 只提供 asset locator，按 DOI 查询 `best_oa_location` 和 `oa_locations` 中的 `url_for_pdf`。
- 当前仓库没有 Unpaywall resolver client。Schema v2 也没有 Unpaywall 专用 Email 字段；调用方负责提供已经包含请求身份且符合通用 `ResolverClient` Protocol 的具体实现。

### 使用注意

- 外部认证语义：Email 用于构造 API 请求身份，不是访问付费全文的凭据。
- 历史接入记录，非当前实现：旧 resolver 曾按 `best_oa_location` 后接 `oa_locations` 的顺序形成去重候选；首候选下载或验证失败后继续下一候选，单来源最多执行 8 个。
- 安全要求：“无 OA location”与“候选均已耗尽”应形成不同的脱敏来源诊断；运行时请求 Email 和候选 URL 不得进入 durable diagnostics。

### 检查重点

- 调用方应使用真实联系邮箱构造具体 client；不得在公开日志中输出完整请求 URL，因为 query 中含 email。
- Unpaywall 只提供开放获取线索，不提供绕过访问控制的能力。

## 11. arXiv

> 维护状态：公开 API 入口、外部路径观察和历史接入记录于 2026-07-21 核对；无凭据生命周期，具体请求频率要求仍需从 API Terms/Basics 单独核对。官方入口：[arXiv API Access](https://info.arxiv.org/help/api/)。

### 外部 API 观察与当前接入状态

- 无凭据。
- 外部 Atom API 提供元数据分页入口；规范 arXiv identifier 可用于构造主文 PDF URL。
- 当前仓库没有 arXiv 专用 metadata 或 resolver client。调用方必须自行提供符合通用 Protocol 的实现，并负责请求间隔。

### 使用注意

- 数据要求：应保留版本化 arXiv identifier。
- 外部 API 观察：Atom 搜索和 PDF 下载是不同请求路径，单一路径成功不能替代完整 acquisition 验证。
- `official`，2026-07-21：arXiv 要求 API 用户阅读 API Terms、Basics 和 User Manual；具体请求频率尚未在本轮核对，不在此推定数值。

## 12. 更新清单

每次发生凭据失效、供应商接口变更或真实下载事故后，维护者应完成：

- [ ] 更新对应机构的证据等级和最后核对日期。
- [ ] 记录最小复现的状态码与错误类别，不记录 key 或受限正文。
- [ ] 确认配置手册的 provider 选择键、secret reference 边界与当前实现一致。
- [ ] 若公开配置、默认值或 provider 能力变化，同步更新 spec 和测试。
- [ ] 若只是新增现场经验，只更新本手册，不把经验性规则写成稳定契约。
- [ ] 检查示例、测试夹具、归档迁移输出之外的活动文件中不存在明文凭据。
