# Metadata 模块技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 设计责任：[设计文档 4.2](../design.md#42-元数据供应商)
- 产品需求：[R2 多来源元数据搜索](../requirements.md#r2-多来源元数据搜索)
- 身份决策：[ADR 0002](../decisions/0002-literature-identity-and-incremental-processing.md)
- 引用解析：[ADR 0007](../decisions/0007-reference-resolution-and-authoritative-relations.md)
- 发现边界：[ADR 0013](../decisions/0013-decoupled-discovery-and-database-maintenance.md)
- Provider 与凭据：[ADR 0014](../decisions/0014-capability-scoped-providers-and-local-credentials.md)、[Configuration 技术文档](configuration.md)

本文定义目标 `src/sciretriever/metadata/` 的元数据供应商搜索与引用关系查询实现。Metadata 执行供应商协议并产生中性 observation，不创建 `MetaLiterature` 或 `Literature`，不合并供应商记录，也不形成统一 `LiteratureMetadata`。

## 1. 目标结构

```text
metadata/
  api.py
  service.py
  rules.py
  ports.py
  providers/
```

- `api.py` 暴露元数据搜索和引用查询的稳定模块操作；
- `service.py` 组织多供应商调用、分页和部分成功；
- `rules.py` 解释本模块封闭结果和稳定失败，不承载文献身份规则；
- `ports.py` 声明元数据领域搜索、稳定标识符 lookup、元数据供应商引用关系查询和 observation publication；
- `providers/` 保存每个目标 Metadata Provider 的供应商专属适配器。

只有对应生产适配器真实实现并由 `bootstrap.py` 连接后，供应商才能写成已接入能力。

## 2. 公开 API

公开 API 使用 Model 表达：

- 中性的领域查询条件；
- 已解析的种子文献标识；
- 要查询的引用方向和边界；
- 本次启用的全部供应商及各自在整个 DiscoveryRun 内的原始扫描上限；
- 各供应商成功 observation，包括供应商明确声明的同文献 `version_links`；
- 元数据供应商返回的逐边 `ProviderRelationObservation`，以及响应中实际内联提供的相关文献 `MetadataObservation`；
- 各供应商自然耗尽、达到扫描上限或稳定脱敏失败的终止结果。

公开 API 不接收或返回 vendor client、HTTP request/response、SDK model、URL session 或裸供应商 JSON。

Metadata 不直接组织 PDF 下载、解析或 LLM 分析，也不把供应商记录 ID 当作 SciRetriever 文献身份。

DiscoveryRun 由 Entry 拥有；数据库补全的 selector、内存目标和 Report 同样由 Entry 编排但不形成持久化运行。Metadata API 只执行本次有界供应商能力并返回中性结果，不接收 BatchGoal、`advance_to`、Collection 或内容处理选项，也不在领域搜索结束后对每条发现结果自动执行全供应商精确补查。

## 3. Ports

`ports.py` 至少区分：

- Metadata Search：按中性查询条件产生 metadata observation；
- Metadata Lookup：按 DOI、arXiv ID、PMID/PMCID 或供应商稳定记录 ID 等明确标识符精确查询；
- Metadata Reference Query：使用同一类元数据供应商的引用关系查询能力，按中性文献标识和方向返回逐边 `ProviderRelationObservation`，并转换响应实际内联提供的相关 metadata observation；
- Observation Publication：持久化已经完成中性转换且可被 Literature 接纳的 metadata observation，以及可以独立存在的结构化引用关系来源 observation；
- 必要的时钟或调用预算接口。

每个 Metadata Search 调用具有明确 Provider，并消费该 Provider 在整个 DiscoveryRun 内共享的原始扫描预算；分页在结果耗尽、达到上限或失败时停止。Cursor 和运行时计数只存在于适配调用，不属于 Port 返回的持久化事实。

Metadata Lookup 和 Metadata Reference Query 都是 Metadata Provider 的可选能力，不把引用定义成新的供应商种类，也不建立 `CitationProvider` Port。同一供应商可以通过专门 endpoint 或普通元数据响应提供引用信息；接口形式不决定结果属于结构化关系还是参考文献原文。Provider Port 表达供应商能力，不复制 Network transport API。供应商适配器可以使用 `network`，但 Metadata 的规则和用例不能直接使用 HTTP 类型。

## 4. 供应商适配器

当前目标的领域搜索生产 adapter 范围为：

```text
web-of-science
crossref
semantic-scholar
arxiv
openalex
europe-pmc
elsevier
springer
datacite
core
```

这里使用稳定 Provider key；`elsevier` 的 Metadata 产品包括 Scopus，`springer` 的外部展示名称为 Springer Nature。Web of Science、Elsevier/Scopus 和 Springer Nature 仍分别遵守其具体产品、database/edition 与覆盖范围；这些属于普通配置和 adapter 协议，不产生新的 Provider 类型。OpenCitations Meta 当前只实现稳定标识符 lookup，并与引用能力一起归 Metadata；没有官方领域关键词搜索合同前不参加主题 DiscoveryRun。以上是目标能力矩阵，不证明某个 adapter 已经在当前代码、Bootstrap 或已安装产品中可用；当前行为必须以 README、源码和测试为准。

一次领域 DiscoveryRun 选择本次全部“普通配置已启用、生产 search adapter 存在、必需普通参数/凭据/AccessPolicy 就绪”的能力。Entry 不按 publisher 预分流：Scopus 可以返回多家出版社文献，Springer Nature 只返回自身覆盖内容，都是各自正常的检索语义。全面目标范围不表示每次无条件调用全部机构，也不改变“发现后不做逐篇全 Provider 补查”的边界。

每个 `providers/<provider>/` 负责：

- Endpoint 和供应商请求参数；
- 查询语法映射；
- 分页 token/cursor；
- 声明稳定 provider/API product AccessScope 与经过核对的访问政策；
- Provider quota、`429`、`Retry-After` 和额度响应头解释，并转换为 Network 可执行的 policy feedback；
- 凭据附着位置；
- 声明该能力的凭据字段需求、非 secret 普通参数和用于用户显式 `config test` 的官方最小只读 probe；
- Vendor 响应结构解析；
- 转换为 `model/metadata.py` 和 `model/acquisition.py` 中的中性 observation、同文献版本连接、引用查询结果与资产线索；
- 将供应商错误转换为稳定、脱敏失败。

一个供应商共享一个 client/session；共享同一 key、账户或官方额度池的 search、reference query 和 asset API 还必须共享同一 Network AccessScope。适配器不能执行身份合并、统一字段选择、PDF 基本检查、实际内容判断或文献状态推进，也不能建立只对 Metadata 可见的局部 limiter。

Provider 增加或替换时，只需实现相同中性 Port 和网络安全边界，不能要求改写产品主流程。

## 5. Observation 与部分成功

### 5.1 MetadataObservation

每条成功 `MetadataObservation` 至少表达：

- Observation identity；
- 通过公共 `Provenance` 表达的 provider identity、provider record identity、实际观察时间和输入 hash；
- 描述文献自身的 `LiteratureMetadata`；
- 供应商对当前记录明确声明的可选 `version_role`；
- 供应商明确声明的同文献其它版本 `version_links`；
- 供应商返回的可选 `declared_keywords`；
- 供应商在当前记录中实际返回的原始 `reference_texts`；
- 供应商在该时间观察到的可选 `reference_count` 和 `cited_by_count`；
- PDF、落地页或开放获取地址等可选 `AssetHint`；
- 可用于后续稳定补充的来源标识。

精确字段见 [Literature 技术文档的 MetadataObservation 合同](literature.md#42-metadataobservation-来源输入)。`MetadataObservation` 是独立、不可变且长期保存的来源对象，不携带 Literature 身份；Literature 接纳后由 Storage 建立归属，一个 Literature 可以关联多个 observations。`LiteratureMetadata` 不是供应商整条返回记录。`version_role`、`version_links`、`declared_keywords`、原始参考文献文本、两类次数和资产线索必须保持为 observation 的独立组成部分，不能为了适配某个供应商而不断向 `LiteratureMetadata` 增加属性。`version_links` 只保留明确同文献版本目标，不能容纳更正、撤稿或其它供应商关系；`declared_keywords` 不直接填入 `LiteratureMetadata.keywords`，也不与 LLM 根据文献内容形成的关键词混合；不同供应商的计数不直接相加；Metadata 也不把 `AssetHint` 接纳为文献资产。Observation 只声明产品需要的中性字段，不增加通用 `extra_metadata` 或让 vendor 原始响应穿透 Model。

Adapter 必须先判断一个供应商字段的语义归属，再构造中性 Model：只有标识“当前这条具体文献记录所描述的 Literature”的 DOI、arXiv ID、PMID、PMCID 或其它官方文献 ID 才进入 `metadata.identifiers`；供应商数据库自身的记录键进入 Provenance 或 ProviderLiteratureKey；指向预印本、正式发表版或其它同文献版本的 ID 进入 `version_links`。官方格式只决定值如何表达，不会把 Provider record identity 自动升级为文献自身 identifier。

供应商字段按其含义转换，而不是按 vendor 字段名照搬：

| 供应商字段表达的事实 | 中性归属 | 转换规则 |
|---|---|---|
| 文献自身的题名、摘要、出版日期、类型、语言、出版物、出版社、卷、期、页码或电子文章定位号 | `LiteratureMetadata` | 只映射 [LiteratureMetadata 精确字段](literature.md#41-literaturemetadata-的边界)；页码范围和电子文章定位号都进入 `pages` |
| 按署名顺序返回的作者展示名、明确姓名组成、ORCID、作者与单位对应关系及 ROR | `LiteratureMetadata.authors: Author[]` | 按来源顺序转换为 [Author/Affiliation](model.md#22-identifierauthor-与-affiliation)；只保存供应商明确返回或能够在同一记录中无歧义对齐的值，不建立全局作者身份 |
| 当前记录自身的 DOI、arXiv ID、PMID、PMCID 等具体文献标识符 | `LiteratureMetadata.identifiers` | 转换为带 namespace 的中性 `Identifier`；公共 Model 统一执行官方 canonicalization，adapter 不再实现另一套大小写、前缀或 URL 去壳规则 |
| OpenAlex Work ID、Web of Science UID、Semantic Scholar Paper ID、Scopus EID 等 Provider record identity | 当前记录使用 `provenance.source_record_id`；关系或版本端点使用 `ProviderLiteratureKey.record_id` | 保留供应商官方值并在父 Provenance 的 provider scope 内解释；不能进入 `LiteratureMetadata.identifiers` 或跨供应商身份匹配 |
| 供应商明确表示为原始记录声明的关键词 | `MetadataObservation.declared_keywords` | 不把主题分类、学科分类或供应商自动推导的 topic 当作声明关键词 |
| 供应商明确声明的文献版本 | `MetadataObservation.version_role` | 只映射可靠声明；未知时为空，不根据文献类型、供应商名称或 URL 猜测 |
| 供应商明确声明为同一文献其它版本的稳定目标 | `MetadataObservation.version_links` | 每个目标形成一个 `ProviderLiteratureKey`；当前记录由 observation 自身定位，目标至少具有非空供应商记录 ID 或稳定 Identifier；正式发表记录中表示相关预印本的 arXiv ID 属于这里，不得同时塞入当前正式 Literature 的 identifiers；不映射更正、撤稿、引用或模糊相关项 |
| 当前记录中原样返回的参考文献条目文本 | `MetadataObservation.reference_texts` | 按供应商顺序保存非空原文；不拆成残缺元数据，也不解释成已确认 Reference |
| 供应商明确返回稳定目标标识的参考文献或被引用文献 | 逐边 `ProviderRelationObservation`，以及响应实际内联提供的相关 `MetadataObservation` | observation 规范化为 `citing -> cited` 并独立保存；只有当前扩展范围选中的目标才继续接纳并建立 Reference 与 `ProviderRelationSupport` |
| 参考文献次数和被引用次数 | `MetadataObservation.reference_count`、`cited_by_count` | 保留来源和观察时间，不根据文本列表长度推导，也不跨供应商相加 |
| 直接文件 URL、落地页 URL、媒体类型、资产角色、版本角色、访问状态和许可证 | `MetadataObservation.asset_hints` | 每个可独立使用的地址形成一个 `AssetHint`；精确合同见 [Acquisition 技术文档](acquisition.md#31-assethint-合同) |
| 搜索相关度、分页 cursor、供应商抓取或索引时间、供应商为当前文献预生成的展示引用和其它内部运行字段 | 不进入业务 Model | 只在当前适配调用中使用，不持久化为文献事实 |

作者转换由各 provider adapter 在单条供应商记录的边界内完成：保留原始署名顺序和明确的 `display_name`、`given_name`、`family_name`、ORCID、署名单位名称及 ROR；机构或协作组按机构作者表达，无法可靠分类时使用 `unknown`。Adapter 不从展示名按空格机械拆分姓与名，不翻译姓名，不根据姓名猜 ORCID，不根据单位名称猜 ROR，也不使用供应商作者 ID 建立本地作者身份。供应商没有明确给出作者与单位的对应关系时，不能把全部单位分配给全部作者。

Metadata 只转换每个来源自己的作者事实，不跨供应商匹配作者。选择基础作者列表以及按相同 ORCID 或整表完全对齐补充缺失字段，属于 [Literature 的作者统一规则](literature.md#411-作者署名)。冲突仍保留在各自 observation 中，不能由 adapter 用模糊匹配提前消解。

所有 adapter 都把 vendor 值交给同一个 `Identifier` 边界：DOI URL、`doi:`、大小写和边界空白必须得到同一小写裸 DOI；arXiv 前缀、官方 URL、新旧式编号和 `vN` revision 必须得到同一基础 ID；PMID、PMCID 及其它已支持 namespace 使用各自官方格式。Adapter 不能为了提高命中率删除标点、改变未知 namespace 大小写或建立私有 alias。不能通过官方语义确认某字段标识当前具体 Literature 时，不得猜测放入 identifiers。

供应商返回多个地址时必须形成多个 `AssetHint`，不能只保留一个 `pdf_url` 或用后返回值覆盖先返回值。供应商返回多个明确同文献版本目标时分别形成多个 `version_links` key；这些 key 复用当前 observation 的 Provenance，只作为 Literature 身份收敛证据，不产生独立关系对象。只保存能够支持文献识别、版本收敛、引用扩展、资产获取和来源审计的中性字段；不保存完整 vendor 原始对象。

### 5.2 ProviderRelationObservation

元数据供应商每明确返回一条具有稳定两端定位的引用关系，适配器产生一个中性、不可变的最小来源事实：

```text
ProviderRelationObservation
  observation_id: ObservationId
  provenance: Provenance
  citing: ProviderLiteratureKey
  cited: ProviderLiteratureKey

ProviderLiteratureKey
  record_id: str | None
  identifiers: Identifier[]
```

`citing` 是引用方，`cited` 是被引用方；references 与 cited-by 响应都转换成同一个 `citing -> cited` 方向，不把查询方式持久化为关系字段。每个 `ProviderLiteratureKey` 至少具有一个非空供应商 `record_id` 或稳定 Identifier，规范化后的 citing 与 cited 不能相同。Provider identity 由 observation 的 `provenance.source_name` 统一表达，不在两个 key 中重复。

一个响应返回 A→B、A→C、A→D 时产生三个 observation。它们具有不同 `observation_id`，但可以复用同一次供应商调用的 Provenance。Observation 不携带 `LiteratureId`、目标 `MetadataObservation`、标题、作者、原始参考文献文本、PDF evidence、扩展状态或任务状态。

`ProviderRelationObservation` 可以在目标尚未入库时独立发布，是供应商关系的最小持久化单位，也是 Entry 后续选择引用扩展目标的输入单位。保存它不创建目标 Literature、Reference 或 ReferenceSupport，也不自动触发递归。响应实际内联提供的目标 metadata 可以同时转换成独立 `MetadataObservation`，但二者不互相嵌套；只有 Entry 选中该关系目标时，才使用内联 observation、本地精确命中或后续 Metadata Search 完成目标接纳。

### 5.3 部分成功

一次调用中各供应商在各自 Network scope 准入后独立执行：

- Adapter 在转换、最低入库判断和去重前对 Provider 返回的每条原始 item 计数，并在整个 DiscoveryRun 共享该 Provider 的 `scan_limit`；该上限不按页、种子、深度或请求重置；
- 一个供应商失败不撤销其它供应商成功结果；
- 已完成转换的 observation 可以先交给 Entry 和 Literature 接纳，不必等待同一供应商的后续页面；
- 不完整 observation 可以交给 Literature；只有 Literature 按“非空标题或 DOI 至少存在一个”的规则接纳后，才能形成已入库的文献和来源事实；
- 单条原始 item 在 vendor-to-neutral 转换时形成稳定 `MetadataProviderFailure`，该 item 仍消耗 `scan_limit`；Service 只记录序号和脱敏稳定失败字段，保留此前事实并继续同一 Provider 的后续 item，不记录原始 item、cursor 或响应；
- 同一 Provider 正常耗尽或达到扫描上限时，只要本次扫描存在上述拒绝记录，最终终止结果仍为 `FAILED` 并携带首个记录级稳定失败；拒绝记录前后已经成功转换的 observations 和 relations 全部保留，不能把部分损坏伪装为完整成功；
- 同一供应商分页失败时保留此前已确认页面，并返回该供应商的部分失败；
- 后续页面、Network 或其它 Provider 级稳定失败优先作为最终失败；取消仍形成 `INTERRUPTED`，Port 合同或编程错误仍向上传播而不能按坏记录隔离；
- 失败不能伪装成“零结果”。

Debug 日志为每条原始 item 记录 `accepted`、`empty` 或 `rejected` disposition、
observation/relation 增量和稳定 reason；Provider 结束汇总满足
`raw = accepted + empty + rejected`。这些扫描计数与逐条 disposition 只用于诊断，
不加入 `MetadataProviderInvocation`、Report、Catalog 或其它业务 Model。Adapter 对合法但明确
不产生任何中性事实的 item 可以在 package-local `NeutralMetadataItem.empty_reason` 中给出受控的
稳定代码；该值只能与空 observations/relations 同时出现，Service 只把它写入 Debug disposition，
不会把 vendor 类型、原始字段或响应正文带出边界。未提供专用原因的通用空 item 继续使用
`no-neutral-facts`。

Provider 已完成中性转换的 relation 仍逐边形成独立、不可变的
`ProviderRelationObservation`，但 publication Port 不再逐边打开 SQLite 事务。Entry 保持
observation/result 的既有先后顺序，再按供应商返回顺序切成最多 256 条的冻结批次；Storage
在一个短事务内原样保存一批。批内任一 relation 失败时整批回滚，已经成功提交的先前批次
继续保留；正常取消只在批次之间生效。若 Provider invocation 已明确返回 `INTERRUPTED`，Entry
仍保存它已经返回的全部 observation/relation，再结束运行且不发布 source result。批量只改变
物理提交粒度，不合并 observation、端点、provenance 或后续待扩展单位，也不把整次 Provider
的无界关系集合放入一个长事务。

领域 DiscoveryRun 由 Entry 调用本次全部已启用且 readiness 通过的 Metadata Search Provider。明确启用但缺少生产 adapter、必需普通参数、凭据或 AccessPolicy 时，运行开始前形成稳定配置错误；不能静默跳过、匿名回退或伪装为零结果。Metadata 不因一条 observation 被接纳就自动对它发起逐篇精确查询，也不把搜索相关度、候选、未接纳结果、cursor、原始请求/响应或扫描计数交给 publication Port。自然耗尽、达到扫描上限和失败由 Entry 转换为逐来源稳定终止结果；Adapter 的 timeout、重复 cursor 与空分页循环保护不进入业务 Model。

Metadata 不判断一条 Provider 结果是否与用户领域语义相关，不调用 LLM 或 embedding，也不按搜索分数、标题关键词、摘要、连续低收益或其它主题启发式过滤和提前停止。非空标题或 DOI 任一存在就是当前最低入库边界；有实际内容但偏题的 Literature 仍可正常进入后续处理，不属于 `NoUsableContent`。

Metadata 不决定不同 observation 是否属于同一 `Literature`；它把全部成功来源事实交给 Literature。

元数据供应商的引用关系查询能力只返回相关文献的稳定记录 ID 或 DOI 等标识时，适配器直接用它形成对应的 `ProviderLiteratureKey`，不为响应中的全部目标立即补查元数据。Entry 只对当前用户方向、深度、数量和筛选范围选中的关系解析非本地端点：先精确查询本地 Literature，响应已内联提供目标 `MetadataObservation` 时复用它，否则再调用 Metadata Search。目标 observation 被 Literature 接纳后，Entry 建立两个具体 Literature 之间的 Reference，并用 `ProviderRelationObservation.observation_id` 建立 `ProviderRelationSupport`。未选中、元数据不足或接纳失败的 relation observation 继续保留，但不创建占位 Literature、Reference 或 support。

结构化关系和参考文献原文的正式判断标准是供应商是否已经明确给出可稳定识别的目标，而不是调用是否主动、是否使用专门 endpoint，或者字段是否由默认元数据响应携带。只有 DOI、PMID、arXiv ID、供应商稳定记录 ID 等明确目标标识的关系才能形成结构化关系 observation；仅有格式化引用文本时始终进入 `reference_texts`。

Entry 在 Literature 接纳 observation 后保存其中的 `AssetHint`，并在处理对应 `Literature` 时把当前可用线索交给 Acquisition。Metadata 不直接调用 Acquisition，也不把资产线索写成当前主 PDF。

## 6. Network 与配置边界

供应商适配器通过 `network/http.py` 发起访问，遵守统一 URL、DNS、redirect、origin、timeout、响应大小、脱敏和 ADR 0012 的进程内共享准入。Provider 自身的分页、额度和响应语义留在适配器中；adapter 声明 scope 并解释反馈，Network 在当前进程的 Metadata、Acquisition、不同操作和文献目标之间执行并发、间隔、quota 与 `Retry-After`。Vendor SDK 无法注入受控 transport 时不能作为生产实现。

HTTP 200 不能被统一解释为 Metadata 成功或空结果。例如 Elsevier 的 Scopus Search 与
Abstract Retrieval 还可能返回 `service-error.status.statusCode` envelope；adapter 只读取
有界、白名单化的 code，将其转换为认证、产品授权、限额、查询拒绝、可重试服务失败或精确
lookup miss，不读取或记录 vendor `statusText`。未知 code、畸形 envelope 和未知顶层继续
形成稳定的 unknown-shape failure，不能被伪装成零结果。
Scopus Search 的 offset 与 cursor 是两种分页合同：cursor 响应必须提供 total、page count、
当前/下一 cursor 与 entry，`opensearch:startIndex` 可以缺失；若供应商仍返回该 offset 字段，
adapter 会将它与本地已接收计数严格核对。Debug 只记录受控 envelope、字段存在位、disposition
和中性 failure kind，不记录字段值、cursor、query 或响应正文。

普通配置向 `bootstrap.py` 提供稳定 Provider key、能力启用状态、产品/database/edition、scan limit、非 secret 运行身份和 AccessPolicy；Provider secret 只由根级 configuration 从 `~/.sciretriever/credentials.toml` 私有解析后注入具体 adapter。Metadata API、Port、Model、AccessScope 和 observation 都不保存 secret 值或凭据文件原文。未知选择键、缺失生产适配器、缺失所需普通参数/凭据或缺少明确 AccessPolicy 必须形成稳定 readiness 失败，不能静默回退到假实现或无限制访问。

`config status` 只读取 capability spec、普通配置和凭据字段存在性，不调用 Metadata API 或 Network。用户显式执行的 `config test` 可以复用 adapter 声明的最小 probe，但它通过 Bootstrap 的配置测试边界和统一 Network 执行，不伪装成 Metadata Search/Lookup，不产生 MetadataObservation、ProviderRelationObservation、DiscoveryRun、Report 或持久化结果。

## 7. 持久化协作

Metadata 形成中性 observation 后，通过自己拥有的 publication Port 请求保存，但该 Port 不能绕过 Literature 的最低入库条件。Observation、Literature 身份结果、统一初始元数据、DiscoveryRun 结果/原因，以及该 Literature 既有自动 PDF 获取耗尽事实的清除，由 Entry 在 Literature 接纳后编排复合事务；标题和 DOI 都缺失的结果不会作为已接纳 observation 持久化，但仍消耗原始扫描额度。Storage 不在 SQL 中重新解释供应商数据。

同一来源 observation 重复提交必须幂等，不能因重复收集制造无意义副本；实际接纳到新的来源观察时则新增不可变 observation 和 Literature 归属，不能更新旧对象。幂等键和物理 schema 由 Storage 实现，但不能丢失来源差异。Metadata 只发布 observations，不发布当前统一 LiteratureMetadata 或把 LLM 结果转换为 observation。

## 8. 验收

直接测试至少覆盖：

- 目标领域搜索 Provider 矩阵按“项目目标、生产实现、用户启用、readiness”分层选择；OpenCitations 只参加精确 lookup/引用，不参加主题搜索；
- 领域发现无需也不能按 publisher 预选 Provider，全部已启用且就绪的 search adapter 各自在自己的覆盖范围内执行；明确启用但 adapter、必需普通参数/凭据或 AccessPolicy 缺失时开始前失败；
- 领域 DiscoveryRun 的每个启用 Provider 在整个 Run 内分别遵守自己的原始 scan limit，过滤、缺少标题/DOI、重复和未接纳 item 都消耗上限；结果耗尽或达到上限后正常停止，Provider cursor、过程计数、搜索分数、未接纳候选和请求/响应不进入 Model 或 Storage；
- 接纳一条领域结果不会自动触发该 Literature 的全 Provider 精确补查、PDF、Parsing 或 Analysis，Metadata API 不接收 Collection 或 Batch 状态；
- 新的 MetadataObservation 成功接纳时，在同一逻辑提交中清除对应 Literature 的自动 PDF 获取耗尽事实；重复幂等提交不制造 observation 或额外状态；
- Metadata 不使用 LLM、embedding、score 阈值、标题关键词、摘要分类或低收益启发式判断领域相关性；偏题但有实际内容不被解释成 NoUsableContent；
- 两个以上供应商同时成功；
- 一个供应商失败、其它供应商成功；
- 单个供应商分页中途失败；
- 不完整元数据仍形成中性 observation；
- DOI URL、`doi:`、大小写和边界空白通过公共 Identifier 边界形成同一小写裸值；arXiv 前缀、官方 URL、新旧式与 `vN` 形成同一基础 ID；各 adapter 不维护不同 normalization；
- 当前记录自身的官方文献 ID、Provider record identity 和相关版本 ID 被分别放入 `metadata.identifiers`、`provenance.source_record_id`/`ProviderLiteratureKey.record_id` 与 `version_links`；
- OpenAlex Work ID、Web of Science UID、Semantic Scholar Paper ID 和 Scopus EID 不进入 `LiteratureMetadata.identifiers`；正式 DOI 记录的相关 arXiv ID 不会误并到正式 Literature；
- 同一 observation 可以分别携带元数据、版本角色、明确同文献版本连接、来源声明关键词、原始参考文献文本、两类次数和资产线索；
- observation 使用公共 `Provenance` 表达供应商来源，不在顶层重复 provider、provider record ID 和观察时间；
- 同一 Literature 可以关联多个长期保存的 observation；相同 observation 重放幂等，新的来源观察新增对象而不覆盖旧值；
- `version_links` 中每个 key 至少具有非空供应商记录 ID 或稳定 Identifier，只接受同文献版本声明，不接受更正、撤稿、引用、本地 Literature ID、状态或目标 metadata；
- `version_links` 目标未解析或存在冲突时保留 observation，但不创建占位 Literature、独立 `LiteratureRelation` 或 MetaLiterature 归属；
- `reference_texts` 保持来源顺序且不维护完整性字段，空列表只表示当前 observation 没有返回原文；
- 一个供应商响应中的每条结构化有向边分别形成一个 `ProviderRelationObservation`，多条边可以共享调用 Provenance 但不能共享 observation ID；
- `ProviderLiteratureKey` 至少具有非空 record ID 或稳定 Identifier，citing/cited 规范化方向明确且不能相同；
- relation observation 可以在目标尚未入库时独立保存，不携带本地 ID、目标元数据、扩展状态或任务状态；
- 只有当前引用扩展范围选中的 relation observation 才解析目标并可能形成 Literature、Reference 和 `ProviderRelationSupport`，保存 observation 本身不触发递归；
- 专门引用 endpoint 和普通元数据响应中的相同语义映射到相同中性结果；结构化关系与原文只按目标是否稳定明确区分；
- `reference_count` 与 `cited_by_count` 分别映射、保持非负且不跨供应商合并；
- 作者保持供应商署名顺序，明确的姓名组成、ORCID、作者单位对应关系和 ROR 不丢失；机构作者与未知类型能够中性表达；
- Adapter 不机械拆分姓名、猜测 ORCID/ROR、按模糊姓名合并作者，或把无法映射的全部单位分配给全部作者；跨来源作者补齐只由 Literature 执行；
- 传统页码、页码范围和电子文章定位号都确定映射到 `pages`，不产生 `article_number`；
- 多个直接文件和落地页地址分别形成多个 `AssetHint`，且直接地址、媒体类型、资产角色、版本角色、访问状态和许可证不会丢失；
- 供应商内部记录 ID、自动 topic、搜索分数、分页 cursor 和完整 vendor 对象不会误入文献元数据或资产线索；
- 标题和 DOI 都缺失时形成稳定单条拒绝，不发布已接纳的文献或来源 observation；
- `declared_keywords` 不直接进入 `LiteratureMetadata.keywords`，也不与 LLM 关键词混合；
- 供应商附加信息不会污染 `LiteratureMetadata`；
- 不同供应商的两类次数不会相加，资产线索不会被接纳为当前资产；
- Vendor 未知字段、错误类型和缺失字段被边界处理；
- 同一输入重复运行不制造无意义 observation；
- Vendor 和 HTTP 类型不进入公开 API 或 Model；
- 凭据与底层异常不会进入持久化失败或用户输出；
- Provider secret 只由配置边界注入 adapter，不进入 Metadata Model、Port、AccessScope、observation、日志或 fixture；`config status` 不调用 Network，`config test` 使用 fake Network 且不产生文献事实；
- 同一 API quota 被 Metadata search、reference query 与 Acquisition 共用时，在当前进程使用同一 AccessScope；不同供应商仍可逻辑并发，但真实请求分别服从其共享 policy；
- `429`、`Retry-After` 和 quota 阻塞会限制同一 scope 的其它调用方，取消或重跑不能立即绕过；
- 缺失 policy、vendor SDK 绕过受控 transport 或 adapter 私建局部 limiter 时 readiness/架构检查失败；
- 未提供生产 client 的选择键不能被写成可用集成。

测试使用 fake provider 和本地 transport，不访问真实供应商。
