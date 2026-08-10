# Provider 外部接口 Notes

本目录记录 SciRetriever 适配外部文献服务时需要长期维护的易变事实：官方入口、认证和限流、endpoint/分页/响应层级、metadata/citation/asset 候选映射、现场验证结果、已知缺口与当前实现边界。

这里是 Notes，不是产品需求或公开能力清单。产品边界以[需求](../../architecture/requirements.md)和 Accepted ADR 为准；Provider 两类能力、目标矩阵、证据路由与本地凭据由 [ADR 0014](../../architecture/decisions/0014-capability-scoped-providers-and-local-credentials.md)决定，进程内供应商访问约束见 [ADR 0012](../../architecture/decisions/0012-process-local-provider-access-scheduling.md)，精确凭据合同见 [Configuration 技术文档](../../architecture/technical/configuration.md)。模块责任与目标合同以 design/technical 为准；当前可运行行为以源码、测试、README 和用户指南为准。新增或实质修改 provider client 时另按[Provider 接入开发手册](../../development/provider-integration.md)完成预算、安全、脱敏、测试和退役设计。

## 1. 证据等级

| 等级 | 含义 | 记录要求 |
|---|---|---|
| `official` | 供应商当前公开文档、机器可读规范或协议明确说明 | 给出官方 URL 和核对日期；政策变化时更新 |
| `implementation` | 当前 SciRetriever 代码、配置或直接测试明确表达 | 说明具体当前边界；不能由目标设计代替 |
| `verified` | 在当前或已注明历史环境中执行最小只读请求直接观察 | 记录日期、状态码/媒体类型和不含敏感信息的 shape；不扩大为 SLA |
| `support` | 供应商支持、申请回复或用户人工核实，公开资料未载明 | 写来源类型与日期，不复制工单、邮件、账户或敏感正文 |
| `inferred` | 根据多次故障、对照或字段组合形成的工作假设 | 明确写“推断”，给出下一次复核方法，不写成合同 |

“待核对/未找到公开依据”不是证据等级，而是主动保留的不确定性。官方页面需要 key、返回 403、依赖 JavaScript 或缺少 schema 时，应保留缺口，不能凭旧代码、字段名或行业经验补全。超过六个月未复核的 `verified`、`support`、`inferred` 条目默认视为需要复核。

`sciretriever config test` 是用户显式发起的当次配置诊断，不自动成为本目录的 `verified` 证据。只有在维护者明确记录核对日期、脱敏 shape、测试边界并完成文档审查后，才能把独立现场观察写回 Notes；Harness、CI 和安装后离线验收不得用真实连接刷新这里的事实。

## 2. 三类事实不得混写

| 层次 | 回答的问题 | 本目录如何表达 |
|---|---|---|
| 外部服务能力 | 供应商公开或现场观察到什么 endpoint、字段和政策？ | 各 provider 文档的官方入口、请求/响应、限制与 evidence |
| 已接受目标设计 | 若将来接入，哪些中性 Model、模块责任和安全边界可接纳这些事实？ | “候选映射”只说明可能归属，不宣称代码已实现 |
| 当前仓库实现 | 现在有哪些选择键、Protocol、adapter、registry 和业务连接？ | 每份文档末尾明确列出当前缺失；以源码/测试为准 |

外部 API 存在不等于 SciRetriever 已接入；配置 key 被接受不等于有 concrete client；fake、Protocol、lazy factory 和目标 Model 也不等于用户可运行工作流。Provider 返回 observation/locator 仍不等于 Literature 或资产已被业务规则接纳。

截至 2026-08-07，已调研的十四家外部服务均没有仓库内供应商专用生产 client。当前 Infrastructure 只有调用方注入的通用 `MetadataClient`、`CitationClient`、`ResolverClient` 和 transport port/依赖；这里的 `CitationClient` 是迁移前实现名称，不代表目标架构建立第三类 Citation Provider。仓库当前没有统一安全 HTTP、供应商级 Access Coordinator 或受控浏览器的生产实现。`build_object_graph` 只有收到 `ProviderDependencies` 才建立 lazy registry，且 registry 尚未连接当前 Collection/Assets Service。项目也没有受支持的终端用户 CLI 或 `config` 命令。

## 3. 已接受的目标能力矩阵

目标架构只分 Metadata Provider 与 Acquisition Provider，两类能力不互斥。领域搜索、稳定标识符 lookup、引用关系和参考文献原文都属于 Metadata 的不同能力；引用不形成第三类顶级 Provider。`direct` 和用户手动 PDF 不在矩阵中，分别是通用公开 Source 和独立接纳操作。

| 外部服务 | 目标 Metadata 能力 | 目标 Acquisition 能力 |
|---|---|---|
| Web of Science | 领域搜索；具体产品与引用深度按 entitlement | 不作为原文来源 |
| Crossref | 领域搜索、标识符 lookup；可返回参考文献/资产线索 | 消费其 PDF/landing locator；相同 AssetHint 可由通用公开 Source 使用 |
| Semantic Scholar | 领域搜索、lookup、可选引用能力 | `openAccessPdf` 等 locator |
| arXiv | 领域搜索与 lookup | 公开 PDF |
| OpenAlex | 领域搜索、lookup、可选引用能力 | OA/location/content 能力 |
| Europe PMC | 领域搜索、lookup、可选引用能力 | OA PDF/full-text locator |
| Elsevier/Scopus | Scopus 等产品的领域搜索与 lookup | 适用且已授权的 Elsevier 内容能力 |
| Springer Nature | 自身覆盖范围的领域搜索与 lookup | locator 或适用且已授权的全文产品 |
| DataCite | 领域搜索与 DOI lookup | 记录明确提供的 locator |
| CORE | 领域搜索与 lookup | 记录明确提供的全文 locator |
| OpenCitations | 仅稳定标识符 metadata lookup 和可选引用能力；当前不参加主题搜索 | 不作为原文来源 |
| Unpaywall | 不参加 Metadata 领域搜索 | DOI/title OA locator |
| Wiley | 不参加 Metadata 领域搜索 | 适用且已授权的 Wiley 内容能力 |
| Configured Sci-Hub | 不参加 Metadata 能力 | operator 明确配置且获准的 locator |

领域 DiscoveryRun 只调用本次普通配置已启用、生产 search adapter 已实现且 readiness 通过的目标 Metadata 能力，不按 publisher 预先分流。Acquisition 还要针对具体 Literature 依据 AssetHint、稳定来源定位、Provider record identity 和 DOI 安全解析后的 landing origin 判断 Source 适用性。上表描述已接受目标，不表示当前 schema v2 已有选择键、当前代码已经实现 adapter，或每次运行会无条件调用所有服务。

## 4. 当前 schema v2 与外部事实总览

表中的“选择能力”只表示迁移前 schema v2 当前允许的键；其中 `citation` 是现有实现类别，不是 ADR 0014 的第三类目标 Provider。“外部能力摘要”是官方/现场观察，不代表当前生产接入。

| Provider | 选择能力 | 外部能力摘要 | 认证与当前证据 | 详细 Notes |
|---|---|---|---|---|
| arXiv | metadata + asset | Atom metadata search；记录含 PDF link；无引用 API | 匿名；官方要求所有调用机器合计最多每 3 秒一次且一个连接；2026-08-07 匿名只读 200 | [arXiv](arxiv.md) |
| Crossref | metadata + asset | REST Works metadata、登记 reference/link；link 只是资产候选 | 匿名 public/polite；当前官方 public 5 req/s、polite 10 req/s；2026-08-07 匿名只读 200 | [Crossref](crossref.md) |
| Europe PMC | metadata + asset | search、references、citations、OA fullTextXML/PDF locator | 匿名；当前固定公开限流数值未找到；2026-08-07 四类最小请求 200 | [Europe PMC](europe-pmc.md) |
| OpenAlex | metadata + citation + asset | Works metadata、结构化引用图、OA/location 与计费 content download | 规模化使用 key/预算；匿名只有小额试用预算；2026-08-07 无 key 单条/cursor 200 | [OpenAlex](openalex.md) |
| Semantic Scholar | metadata + citation + asset | Academic Graph search/details、references/citations、`openAccessPdf` | key 可选但推荐；匿名共享池；2026-08-07 四类匿名只读 200 | [Semantic Scholar](semantic-scholar.md) |
| Unpaywall | asset | DOI/title OA lookup、多个 publisher/repository locator | 请求 email 必需，建议每日不超 100,000；2026-08-07 DOI lookup 200、title search 500 | [Unpaywall](unpaywall.md) |
| Elsevier | metadata + asset | Scopus/Abstract metadata；Article XML/JSON 与 objects；PDF 当前公开依据不足 | API key 必需，内容订阅另计；本轮未带 key；2026-07-21 历史最小请求 200 | [Elsevier](elsevier.md) |
| Wiley | asset | 获准环境中的 TDM 主文 PDF | 官方 TDM 页面本轮 403；endpoint/header/限流待核对；保留 2026-07-21 两篇历史成功记录 | [Wiley](wiley.md) |
| Springer Nature | metadata + asset | Meta/Metadata；OA 与 agreement Full Text JATS/XML；metadata 可含 PDF locator | API key，Full Text 另需 agreement/metric；官方文档可读，本轮未带 key 实测 | [Springer Nature](springer-nature.md) |
| Configured Sci-Hub | asset | 仅 operator 私有、获准 resolver 的通用 locator 输出；无稳定公开 API 合同 | 不记录/测试 endpoint、镜像、session 或绕过方式；本轮无网络请求 | [Configured Sci-Hub](configured-sci-hub.md) |

准确的当前选择键：

```text
metadata: arxiv, crossref, europe-pmc, openalex, semantic-scholar, elsevier, springer
citation: openalex, semantic-scholar
asset: direct, arxiv, crossref, unpaywall, europe-pmc, openalex,
       semantic-scholar, elsevier, wiley, springer, sci-hub
```

`springer` 与 `sci-hub` 是配置合同中的实际键，不用供应商展示名称代替。

### 4.1 已进入目标、但尚未进入当前 schema v2 的服务

下列四家已经由 ADR 0014 纳入目标能力矩阵，但仍不属于上表十家当前 provider，也不属于 schema v2 的任何 allowlist。它们没有当前配置选择键、Protocol 注册、adapter 或 registry wiring；目标 Metadata adapter 只能在后续实现、直接测试和 Bootstrap 接线完成后写成当前能力。OpenCitations 的目标范围仅为精确 lookup/引用，不包含主题搜索。

| 外部服务 | 外部能力摘要 | 认证与当前证据 | 详细 Notes |
|---|---|---|---|
| Web of Science | Starter 基础 metadata/Times Cited；Expanded Full Record、cited references、citing items | `X-ApiKey` 必需，机构 subscription/产品 entitlement 决定深度；2026-08-07 两产品匿名请求均 401，公开 Swagger 可读 | [Web of Science](web-of-science.md) |
| DataCite | 通用 DOI metadata、显式关联标识符、引用/版本关系摘要与 locator | public GET 匿名可用；2026-08-07 单 DOI 与单页搜索均 200 | [DataCite](datacite.md) |
| OpenCitations | Index v2 开放逐边引用/计数；Meta v1 基础书目 metadata | token 非强制但官方鼓励；180 req/min/IP；2026-08-07 Index/Meta 匿名最小请求均 200 | [OpenCitations](opencitations.md) |
| CORE | 去重增强 Works、来源级 Outputs、metadata、参考文献与全文 locator | 匿名可用但低 token 额度且不提供全文；2026-08-07 匿名单条 Work search 200 | [CORE](core.md) |

其中 DataCite 收录的不只文献，CORE Work 是外部聚合身份，OpenCitations Meta/Index 是两类数据，Web of Science Starter/Expanded 是不同许可产品；这些外部划分都不能绕过 SciRetriever 的领域边界、身份收敛、事实所有权与中性 Model，也不能因为目标已接受就伪造当前 schema/adapter/readiness。

## 5. `direct` 不是供应商

`direct` 表示对当前 Literature/迁移前记录中已有安全 HTTPS locator 的通用直接获取入口，不对应单一外部机构，也没有供应商认证、schema 或逐机构文档，因此不创建 `direct.md`。

它仍必须经过 Network policy、有限 timeout/大小预算、redirect 与 origin 检查、media type/PDF bytes 验证、hash、lineage 和 immutable publish。已有 URL 不等于已授权、可访问或内容正确。

## 6. 每份 provider 文档的最小内容

新增或更新文档时，适用项至少覆盖：

1. 最后核对日期、schema v2 选择键、外部角色和当前仓库接入状态。
2. 官方入口与每项重要事实的 evidence 等级。
3. 认证位置、匿名能力、凭据/授权边界、限流/配额和错误语义。
4. endpoint、查询语义、分页/游标、响应顶层及嵌套字段。
5. metadata、citation、asset 各自能力与明确“不适用”项。
6. 一份精简且脱敏的代表性 response shape；公开资料不足时明确不伪造。
7. 外部字段到中性 Model 的候选映射，以及明确不进入 Model 的字段。
8. 已知限制、待核对项、现场验证范围和当前实现缺口。

响应样例只保留理解层级所需字段，不复制大段 vendor payload，不保留受限正文、用户数据或真实凭据。

## 7. 通用安全与数据边界

- Provider 凭据只从当前用户拥有的 `~/.sciretriever/credentials.toml` 私有解析并由 Bootstrap 注入 adapter；目录必须为普通非符号链接目录且权限为 `0700`，文件必须为普通非符号链接文件且权限为 `0600`。不得写入 URL、日志、异常、trace、provenance、fixture 或 Notes；状态诊断不显示值、掩码、长度、hash 或 fingerprint。
- 外部 URL 必须经过共享 Network policy：HTTPS、URL/DNS/redirect/origin 复核、受限 headers、timeout、响应大小、请求总数与并发预算。
- 每个 production adapter 必须声明稳定 provider/channel/service AccessScope、真实 quota 共享范围和经过核对的访问政策；缺少 policy 不得退化为无限制访问。Adapter 解释 provider 规则，Network 在当前进程的 Metadata、Acquisition 和其它调用方之间共享执行。
- 同一 provider 网页普通 HTTP 与受控浏览器在当前进程最多一个活动流程，完整结束后至少冷却 30 秒；更严格的供应商规则优先。API 使用独立 scope 并按真实政策运行，公开/OA/direct 声明不能绕过实际 provider/host scope。
- `429`、`Retry-After` 和 quota 反馈必须作用于当前进程的共享 scope；局部 `sleep`、adapter 私有 semaphore、SDK 内建但不可见的重试不能替代进程内共享准入。
- 重定向后重新做安全判断；不跨 origin 自动携带认证 headers、cookie 或 query secrets。
- HTTP 200、`content-type` 名称、文件扩展名、OA 标志和 `pdf_url` 都不是接纳证据；读取必须有界并做 media type 规范化和 PDF/XML 基本检查。
- metadata/citation/asset 是不同事实。计数不是引用边；landing page 不是 PDF；JATS/XML 不是主 PDF；结构化目标 ID 也不是权威 `Reference`。
- Provider 私有 JSON/XML/model 不穿透公开 API。业务数据使用中性 Model，identity、metadata convergence、content acceptance、Reference 和状态仍由 Literature 拥有。
- 多个 locator/observation 保留来源、观察时间、输入标识、hash 与 lineage；后值不能静默覆盖前值。
- 测试和 Harness 只用 fake/fixture，不连接真实供应商、生产数据库或用户语料。
- `config status` 只做本地字段/readiness 检查；`config test` 只能由用户显式执行并经过同一 Network 准入，不保存结果或时间，不创建文献事实。Harness、CI 与离线验收不得读取真实凭据或执行真实 probe。
- Configured Sci-Hub 绝不在仓库记录 endpoint、镜像发现、session/profile、cookie、凭据或绕过访问控制方法。

## 8. 通用排障顺序

1. 先区分当前迁移前 schema v2 allowlist 与 ADR 0014 目标矩阵；目标实现按 Metadata/Acquisition capability、用户启用、生产 adapter 与 readiness 选择，不把迁移前 `citation` 类别延续成第三类 Provider。
2. 确认 concrete client 已由调用方注入；lazy registry 构造失败不能误报为“无结果”。
3. 在不打印值的前提下确认认证材料存在，并核对该 key/token 的具体 API 产品与内容 entitlement。
4. 使用供应商文档中的稳定标识做最小只读健康检查；允许匿名时再做匿名对照。
5. 区分认证、授权、quota/throttle、资源不存在、无 locator、Network policy、媒体类型/bytes 校验与 immutable publish 冲突。
6. 遵守响应 headers/官方预算做有界退避；不要用高频重试判断凭据状态。
7. 核对该请求实际使用的 provider/channel/service scope 与最终 host，确认没有被当前进程中的其它 adapter 或 redirect 绕过。
8. 将新事实按证据等级补回对应文档；敏感工单内容和一次性 payload 不进入仓库。

## 9. 更新检查清单

- [ ] 核对 provider 展示名、当前 schema v2 真实配置 key和目标 Metadata/Acquisition capability，未把目标矩阵写成当前接入。
- [ ] 官方 URL 可访问；不可访问、需 key/JS 或 403 的部分已明确记录。
- [ ] 认证、内容 entitlement、配额和限流没有混为一项。
- [ ] AccessScope、quota 共享范围、网页/API 通道和官方限速证据明确；网页至少 30 秒冷却，普通配置只能收紧。
- [ ] query/pagination/response 层级来自当前官方依据或带日期的最小验证。
- [ ] 计数、引用边、参考文献原文和权威 Reference 边界清楚。
- [ ] landing、PDF locator、XML/JATS、对象资源和最终主 PDF 已区分。
- [ ] 候选映射没有新增未获 requirements/ADR 授权的 Model 或产品能力。
- [ ] 当前实现没有被目标设计、Protocol、fake 或配置选择键夸大。
- [ ] 当前 adapter/SDK 没有绕过进程内共享准入；共享 quota、redirect host 和 `Retry-After` 具有离线验证边界；没有宣称跨进程或跨重启限速。
- [ ] 文档不含 secret、真实用户 email、session/profile、真实语料或受限响应正文。
- [ ] 凭据字段与 `config status/test` 边界符合 ADR 0014；没有把本地字段存在、认证成功和具体全文 entitlement 混成同一状态，也没有用 Harness/CI 做真实连通性测试。
- [ ] 同步日期、证据等级、已知缺口、直接测试/fixture 和退役条件。
- [ ] 运行 Markdown link、冲突标记、尾随空白与最终 diff 检查。
