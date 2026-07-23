# 外部机构与 Provider 运维手册

本手册记录 SciRetriever 与外部机构接口适配时需要长期保留的操作知识，包括公开契约、当前实现、现场验证结果和难以从公开资料获得的经验。它解释如何使用和排障，不重新定义 provider 能力；当前行为仍以代码和 README 为准，覆盖状态见实施进度。

任何凭据值、用户身份、内部工单内容或受限响应正文都不得写入本手册。凭据只以环境变量名表示。

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

1. SciRetriever 中的 CLI 名称、发现/获取能力和所需标识符。
2. 凭据申请入口、环境变量、认证位置和是否允许匿名调用。
3. 供应商公开限流规则，以及本项目实际采用的并发和间隔。
4. 凭据生命周期、失效症状、最小健康检查和恢复方式。
5. 返回内容、授权范围和常见失败不能混为一谈的边界。
6. 最后核对日期、证据等级和已知但尚未解决的实现限制。

下文各机构的“当前接入”均属于 `implementation`；“运维知识”中的事实必须单独标注证据等级。新增或实质修改 provider / resolver 还必须填写 [Provider 准入与退役模板](provider-admission-template.md)，记录请求预算、有限 timeout、验证、脱敏和退役证据。

### 1.3 当前实现与批准目标

- 当前 provider 能力只以代码和 [README](../../README.md) 为准，覆盖与差距见[实施进度](../governance/implementation-progress.md)；本手册中的理想语义不表示对应配置或运行路径已经可用。
- 批准目标中，metadata provider 在有界并发和各自有限 timeout 下返回 provider-neutral observations；系统按确定性身份规则与 configured precedence/fill-missing 合并，结果不得依赖完成顺序。provider record 不天然等于 `WorkVersion`。
- acquisition provider 面向具体 `WorkVersion` 的资产缺口。direct official、publisher、open provider 与显式配置的 Sci-Hub 属于第一层进程内竞速；translator 和 browser 是前层耗尽后的顺序回退。
- Sci-Hub、translator 和 browser 当前均未实现。在各自配置、安全边界、离线 fixture 和用户文档完成前，不得把它们登记为 active capability。
- 全文分析不是 provider 职责；只有已保存并通过验证的 primary PDF 才能进入后续 PDF-based fulltext analysis。XML/HTML 可作为补充资产，但不能在缺少 PDF 时满足 analyze，也不能在冲突时覆盖 PDF。

### 1.4 通用排障顺序

当 provider 失败时，按以下顺序区分责任边界：

1. 确认环境变量已配置且非空，但不得打印变量值。
2. 用供应商最小只读端点发起带凭据请求，记录状态码。
3. 对允许匿名访问的服务，再发起同资源的匿名请求作为对照。
4. 区分认证失败、授权范围不足、限流、资源不存在、无全文候选和内容校验失败。
5. 再通过 SciRetriever 发起同一请求，判断问题在供应商、凭据还是本地 adapter/transport。
6. 将新发现按证据等级补回本手册；不得只留在聊天、一次性脚本或个人记忆中。

## 2. Provider 总览

| 机构 | CLI 名称 | Discovery | Acquisition | 凭据 |
|---|---|---:|---:|---|
| arXiv | `arxiv` | 是 | 主文 PDF | 无 |
| Crossref | `crossref` | 是 | 解析主文 PDF | 无；建议提供联系邮箱 |
| Europe PMC | `europe-pmc` | 是 | 开放主文 PDF | 无 |
| OpenAlex | `openalex` | 是 | 公开主文 PDF | 当前实现未接入 key；官方现需 key |
| Semantic Scholar | `semantic-scholar` | 是 | `openAccessPdf` 主文 PDF | 可选 API key |
| Unpaywall | `unpaywall` | 否 | 开放主文 PDF | Email 必需 |
| Elsevier | `elsevier` | 是 | 主文 PDF、补充 PDF、XML | API key 必需，内容授权另计 |
| Wiley | `wiley` | 否 | 主文 PDF | TDM token 必需，内容授权另计 |
| Springer Nature | `springer` | 是 | XML、HTML | API key 必需，端点授权另计 |

`direct` 是对明确 HTTPS 资产地址的通用入口，不对应单一外部机构，因此不在逐机构条目中重复说明。

## 3. Semantic Scholar

> 维护状态：当前实现和公开 API 页面于 2026-07-21 核对；60 天规则来自用户核实的非公开知识。

### 当前接入

- 环境变量：`SCIRETRIEVER_SEMANTIC_SCHOLAR_API_KEY`。
- 认证 header：`x-api-key`。
- Discovery 使用 Academic Graph `paper/search`。
- Acquisition 按 DOI 查询 `openAccessPdf`，只获取供应商返回的开放 PDF 地址。
- API key 在当前实现中可选；没有 key 时仍可调用允许匿名访问的端点。

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

- 本项目运维建议每 30 天执行一次最小只读健康检查，为 60 天失活窗口保留余量。这是本地运维策略，不是官方要求。
- 健康检查应查询一个稳定 DOI，只请求 `paperId,title` 等最小字段；不得下载全文或批量搜索来保活。
- 预期结果：带 key 返回 `200`。若带 key 返回 `403` 而匿名对照返回 `200`，优先判断 key 已失效或被撤销，不应重试轰炸端点。
- `429` 表示限流，应遵守退避；不能据此判断 key 是否过期。
- key 失效后，通过官方申请入口重新申请，并更新环境变量。不得将新 key 写入仓库、命令历史或诊断报告。

### 已知实现边界

- 当前 acquisition 只采用一个 `openAccessPdf.url`，不会从 landing page 提取其它候选。
- API 返回元数据成功不代表存在全文，也不代表具备版权内容访问权。
- 当前 profile 尚未把官方 1 RPS 明确建模为 Semantic Scholar 专属预算；运行时应保守控制请求速率。

## 4. Elsevier

> 维护状态：当前实现、申请入口和产品授权说明于 2026-07-21 核对；key 生命周期待核对。官方入口：[Elsevier Developer Portal](https://dev.elsevier.com/)。

### 当前接入

- 环境变量：`SCIRETRIEVER_ELSEVIER_API_KEY`；认证 header 为 `X-ELS-APIKey`。
- Discovery 使用 Scopus Search。
- Acquisition 先按 DOI 请求 `view=FULL` XML，再从附件元数据选择主文或补充 PDF 的 EID；XML 可以直接作为资产保存。
- 当前 publisher profile 支持 DOI 前缀 `10.1016/`，主文 PDF、补充 PDF 和 XML，并发 2、最小间隔 0.25 秒。

### 运维知识

- `official`，2026-07-21：API key 有效不等于有权获取某篇全文；官方说明完整 API 访问取决于所属机构对相应 Elsevier 产品的订阅。
- `verified`，2026-07-21：现有 key 对官方 API 最小直连请求返回 HTTP `200`，但 SciRetriever 在两篇真实样本的 acquisition 中均超过外层 90 秒。这是本地 provider/transport/timeout 问题的证据，不能归类为 key 无效。
- `implementation`：PDF 获取依赖 article XML 中可识别的附件 EID。HTTP `200` 但没有匹配 EID 应按响应结构或授权范围排查。

### 检查重点

- 分别验证 Scopus Search、Article Retrieval 和 Object Retrieval；不要用一个端点的成功推断全部产品权限。
- `401`/`403` 先检查 key、产品授权和机构网络；`429` 检查配额与并发；长时间不返回需检查本地硬超时是否真正终止底层请求。
- 供应商政策和申请入口变更时，在此补充官方链接和核对日期。

## 5. Wiley

> 维护状态：当前实现和 2026-07-21 实测已核对；公开 TDM 页面在自动核对时返回 HTTP `403`，申请入口、公开限流和 token 生命周期待人工浏览器复核。参考入口：[Wiley Text and Data Mining](https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining)。

### 当前接入

- 环境变量：`SCIRETRIEVER_WILEY_API_KEY`；认证 header 为 `Wiley-TDM-Client-Token`。
- Acquisition 使用 Wiley TDM article 端点，只支持主文 PDF。
- 当前 profile 覆盖 DOI 前缀 `10.1002/`、`10.1111/`，并发 1、最小间隔 1 秒。

### 运维知识

- `inferred`：TDM token 和文章访问授权是两个不同条件；token 可用不保证每个 DOI 都返回 PDF。复核时应以 Wiley 当前 TDM 条款和已知授权 DOI 对照验证。
- `verified`，2026-07-21：现有 token 在分层基准中对 1 篇 OA 和 1 篇 closed 样本均成功，是该轮唯一明确通过出版社授权 API 获取 closed 文献的 provider。
- `implementation`：返回 HTTP `200` 后仍必须通过 PDF 内容校验，不能只依据状态码认定成功。

### 检查重点

- 最小健康检查使用团队确认可访问的稳定 DOI，避免用未知授权文章判断 token 生命周期。
- `401`/`403` 需分别核对 token 状态和内容授权；`404` 还可能表示 DOI 不在当前 TDM 路由内。
- 供应商告知的 token 生命周期、配额或许可变化应按 `official` 或 `support` 等级补录。

## 6. Springer Nature

> 维护状态：当前实现、产品入口和产品分层于 2026-07-21 核对；key 生命周期和具体配额待核对。官方入口：[Springer Nature Developer Portal](https://dev.springernature.com/)。

### 当前接入

- 环境变量：`SCIRETRIEVER_SPRINGER_API_KEY`；key 作为查询参数发送。
- Discovery 使用 Metadata API。
- Acquisition 支持 JATS/XML 和 HTML；当前不声明主文 PDF 能力。
- 当前 profile 覆盖 DOI 前缀 `10.1007/`，并发 1、最小间隔 1 秒。

### 运维知识

- `official`，2026-07-21：Springer Nature 将 Metadata、Open Access 和 Full Text/TDM 作为不同 API 产品；一个产品可用不能证明其它端点已授权。
- `implementation`：HTML acquisition 依赖 metadata 返回的 HTTPS canonical URL；拿到 landing page 不等于拿到 PDF。
- `implementation`：端点返回的媒体类型必须与 profile 声明一致，否则按无效响应拒绝。

### 检查重点

- 分别验证 metadata 和 JATS/XML 端点，并记录 key 的产品授权范围。
- 遇到 `401`/`403` 检查 key 和端点授权；无记录或无 canonical URL 时检查 DOI 覆盖范围与元数据完整性。

## 7. OpenAlex

> 维护状态：当前实现和公开 API 文档于 2026-07-21 核对；当前实现与官方认证要求存在差距。官方入口：[OpenAlex API 文档](https://docs.openalex.org/)、[申请免费 key](https://openalex.org/settings/api)。

### 当前接入

- 当前实现不使用 API key，也没有对应凭据配置。
- Discovery 使用 cursor 分页。
- Acquisition 按 `best_oa_location`、`primary_location`、`locations` 的顺序寻找第一个 HTTPS `pdf_url`。

### 运维知识

- `official`，2026-07-21：当前 OpenAlex 文档说明 API 需要免费 API key，并提供每日免费额度。SciRetriever 尚未接入该 key；匿名访问即使暂时可用，也不应视为稳定契约。
- `inferred`：OpenAlex 的开放状态和 PDF 地址来自聚合元数据，可能滞后或与目标站点实际可访问性不一致；需用 resolver 响应和最终下载结果对照复核。
- `verified`，2026-07-21：真实样本中，标记为 `closed` 的记录仍出现可公开下载的直链；有 `pdf_url` 的候选也可能返回 `403`、HTML 或失效内容。
- `implementation`：当前实现找到第一个候选后即返回；若该候选下载失败，不会继续同一记录的其它 location。

### 检查重点

- 排障时同时保存 resolver URL、候选 PDF 主机和最终状态码，但不得保存受限响应正文。
- 不要把 OpenAlex 的 OA 分类直接解释为版权授权结论。

## 8. Crossref

> 维护状态：当前实现和公开 REST API 页面于 2026-07-21 核对；无凭据生命周期。官方入口：[Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)。

### 当前接入

- 无 API key；Discovery 建议配置 `crossref_mailto` 作为礼貌池身份。
- Acquisition 只接受 work message 中 `content-type` 为 `application/pdf` 的第一个 link。

### 运维知识

- `official`，2026-07-21：Crossref REST API 暴露成员和可信来源登记的元数据，无需注册；官方提供 `mailto` polite pool 用法。
- `inferred`：Crossref link 来自登记元数据，不应假定候选可匿名访问、持续存在或实际返回 PDF；应以最终响应和内容校验复核。
- `implementation`：当前 acquisition client 未传入 Discovery 的 `mailto` 和 User-Agent 配置。
- `verified`，2026-07-21：真实基准中出现候选可下载但响应 `Content-Type` 带参数，随后被严格媒体类型模型拒绝的情况；这是本地规范化问题，不应归因于 Crossref 无链接。

### 检查重点

- 区分“Crossref 无 PDF link”“候选 URL 下载失败”和“下载成功但内容校验失败”。
- 遇到出版社 landing page 或 HTML 响应时，当前 provider 不执行站点解析。

## 9. Europe PMC

> 维护状态：当前实现于 2026-07-21 核对；官方页面自动读取失败，公开限流和服务政策待核对。参考入口：[Europe PMC RESTful Web Service](https://europepmc.org/RestfulWebService)。无凭据生命周期。

### 当前接入

- 无凭据。
- Discovery 支持 cursor 分页。
- Acquisition 优先使用 PMID，否则使用 DOI 查找记录，只返回存在 `open_access_url` 的主文 PDF 路由。

### 运维知识

- `inferred`：Europe PMC 的覆盖具有领域特征；跨领域 DOI 无匹配不应直接判断为服务故障，需用已知收录记录对照。
- `implementation`：找到元数据但没有开放全文路由时，应记录为“无 PDF route”，而不是网络失败。
- `implementation`：已有 PMID 时当前实现会优先使用，否则使用 DOI。

## 10. Unpaywall

> 维护状态：当前实现于 2026-07-21 核对；官方页面依赖 JavaScript，公开限流和 Email 政策待人工浏览器复核。官方入口：[Unpaywall API](https://unpaywall.org/products/api)。Email 是请求身份，不存在 API key 生命周期。

### 当前接入

- 环境变量：`SCIRETRIEVER_UNPAYWALL_EMAIL`，必需且不得为空。
- 仅用于 acquisition；按 DOI 查询 `best_oa_location` 和 `oa_locations` 中的 `url_for_pdf`。

### 运维知识

- `implementation`：Email 用于构造 API 请求身份，不是访问付费全文的凭据。
- `implementation`：当前实现按 location 顺序找到第一个 PDF URL 后立即下载；下载失败时不会继续尝试其余 OA location。
- `implementation`：“无 OA location”与“第一个 location 已失效”必须分开记录，后者属于候选回退能力不足。

### 检查重点

- 使用真实联系邮箱并保持配置一致；不得在公开日志中输出完整请求 URL，因为 query 中含 email。
- Unpaywall 只提供开放获取线索，不提供绕过访问控制的能力。

## 11. arXiv

> 维护状态：当前实现和公开 API 入口于 2026-07-21 核对；无凭据生命周期，具体请求频率要求仍需从 API Terms/Basics 单独核对。官方入口：[arXiv API Access](https://info.arxiv.org/help/api/)。

### 当前接入

- 无凭据。
- Discovery 使用 Atom API，并在分页间执行延迟。
- Acquisition 根据 arXiv identifier 构造规范 PDF URL，仅支持主文 PDF。

### 运维知识

- `implementation`：应保留版本化 arXiv identifier；当前 PDF URL 直接由该 identifier 构造。
- `implementation`：Atom 搜索和 PDF 下载是不同请求路径，单一路径成功不能替代完整 acquisition 验证。
- `official`，2026-07-21：arXiv 要求 API 用户阅读 API Terms、Basics 和 User Manual；具体请求频率尚未在本轮核对，不在此推定数值。

## 12. 更新清单

每次发生凭据失效、供应商接口变更或真实下载事故后，维护者应完成：

- [ ] 更新对应机构的证据等级和最后核对日期。
- [ ] 记录最小复现的状态码与错误类别，不记录 key 或受限正文。
- [ ] 确认 README 的能力/凭据表与当前实现一致。
- [ ] 若公开配置、默认值或 provider 能力变化，同步更新 spec 和测试。
- [ ] 若只是新增现场经验，只更新本手册，不把经验性规则写成稳定契约。
- [ ] 检查示例、测试夹具、归档迁移输出之外的活动文件中不存在明文凭据。
