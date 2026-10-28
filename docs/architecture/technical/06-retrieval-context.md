# 06 · 知识查询与上下文技术设计

类型：规格
负责：文献查询、检索投影与上下文读取；technical 中早期形式化接口（查询）
状态：现行；目标接口单独成节

[设计总览](../design.md) · [八模块技术导航](../technical.md)

本模块对应设计中的 **⑥ 知识查询与上下文**，从已有库中检索文献、材料和知识，按范围与预算返回内容、来源、证据和缺口。

内部包括 Library 读取、知识检索/排序、版本与重复处理、上下文组装和证据展开。它通过③④⑤的读取合同和⑦的只读适配取得已提交事实，不持有发现、获取、解析、模型生成或 Job-create 能力。

当前 Library/FTS、元数据/已发布文档检索和 Catalog v8 的已发布知识检索、预算 Context、QueryApplication/HTTP/人类阅读页已接通。查不到、缺 PDF 或缺表示都是查询结果，不会触发维护。M07-T03 的 root 全量验收仍待执行。

本篇目录：

- [1. 模块边界与连接](#1-模块边界与连接)
- [2. 文献查询与读取合同](#2-文献查询与读取合同)
- [3. 独立查询应用与只读生命周期](#3-独立查询应用与只读生命周期)
- [4. 知识检索与上下文组装](#4-知识检索与上下文组装)
- [5. 目标接口（尚未实现）](#5-目标接口尚未实现)

## 1. 模块边界与连接

统一接口① → 本模块 → 文献③ / 文档④ / 知识⑤的 read ports 与存储⑦；无维护 writer。

本篇按职责归并已有详细合同；示例中的现有类型与目标类型保持各自状态。文档归属不改变源码目录、事实所有权或当前公开 API。

## 2. 文献查询与读取合同

### 2.1 本地文献数据库查询与详情

本节是本地文献查询输入和主要读取投影的精确合同。它们由 `packages/contracts/src/index.ts` 导出并进行边界解析，使用只读字段并拒绝未知字段，但不是数据库实体。外部 Metadata Provider 搜索继续使用 `TopicDiscoveryInput` 或 `CitationDiscoveryInput`；`LibraryQuery` 只读取已经接纳的 Catalog/ArtifactStore 当前事实，不访问网络、不创建 `DiscoveryRun`、不执行内容处理，也不修改数据库。

#### 2.1.1 LibraryQuery

```text
LibraryQuery
  text: str | None
  title: str | None
  author: str | None
  author_orcids: tuple[str, ...]
  identifiers: tuple[Identifier, ...]

  publication_year_from: int | None
  publication_year_to: int | None
  venue: str | None
  publisher: str | None
  document_types: tuple[str, ...]
  languages: tuple[str, ...]
  keywords: tuple[str, ...]

  version_roles: tuple[VersionRole, ...]
  statuses: tuple[LiteratureStatus, ...]
  missing_steps: tuple[LiteratureMissingStep, ...]
  needs_manual_pdf: bool | None

  discovery_run_ids: tuple[DiscoveryRunId, ...]

LiteratureMissingStep =
    "primary-pdf"
  | "parser-result"
  | "literature-content"
```

全部可选单值默认为 `None`，全部多值字段默认为空 tuple；完全空的 `LibraryQuery` 表示查询全部具体 `Literature`。字符串去除边界空白后必须非空，多值字段去重并保持调用方顺序。不同字段之间使用 AND；一般多值字段内部使用 OR；`keywords` 内部使用 AND，即当前 metadata 必须同时具有全部给定完整关键词。

`text` 是普通用户文本，只搜索当前权威视图中的：

- title；
- 当前作者 display/given/family name、ORCID、署名单位名称和 ROR；
- identifiers；
- abstract；
- venue、publisher、volume、issue 和 pages；
- 当前 `LiteratureMetadata.keywords`；
- 当前 `LiteratureContent.sections` 的标题和 Markdown 正文。

`text` 不搜索 `MetadataObservation`、provenance、AssetHint/URL、供应商参考文献原文、`LiteratureContent.references`、Provider 原始响应、Discovery/Report/日志/失败、Parser/LLM 型号或文件路径，也不接受裸 SQL 或 FTS5 查询语法。专门字段的语义为：

- `title`、`venue` 和 `publisher`：大小写不敏感的包含匹配；`author` 对当前作者 display/given/family name 做同样匹配，不扩展到单位；
- `author_orcids`：规范 ORCID 精确匹配，内部 OR；
- `identifiers`：复用中性 `Identifier`，按规范 namespace/value 精确匹配，内部 OR；
- 年份范围：`1..9999`、包含边界，两个边界同时存在时必须有序；
- `document_types`：开放字符串，按当前规范值精确匹配，内部 OR；
- `languages`：按当前 metadata 规范值精确匹配，内部 OR；
- `keywords`：按完整规范关键词精确匹配，全部给定关键词必须存在；
- `version_roles`：只接受 `published | accepted-manuscript | preprint | other`；
- `statuses`：只接受 `UNREVIEWED | ASSET_READY | CONTENT_READY`。

`missing_steps` 只表达每个 Literature 当前第一个缺失事实，不把一项前置缺失展开成全部后续缺失：

```text
没有 primary-pdf
  -> "primary-pdf"

有 primary-pdf、没有与之对齐的当前 ParserResult
  -> "parser-result"

有 primary-pdf/ParserResult、没有与当前输入对齐的 LiteratureContent
  -> "literature-content"

CONTENT_READY
  -> None
```

`needs_manual_pdf = True` 只匹配当前没有主 PDF 且存在 `AutomaticPdfAcquisitionExhaustion` 的具体 Literature；`False` 匹配没有该耗尽事实的 Literature，不能解释成系统保证仍可自动获得；`None` 不筛选。

`discovery_run_ids` 查询一次或多次 DiscoveryRun 当时实际发现的具体 Literature，内部 OR。Topic cause 通过当时接纳的 `metadata_observation_id` 找到其具体 Literature；Citation cause 使用 source/target 两端中与该 `DiscoveryResult.meta_literature_id` 对应的实际具体 Literature，references 方向通常是 target，cited-by 方向通常是 source。不能把后来加入同一 MetaLiterature 的其它版本反算为该次发现对象。

`LibraryQuery` 不加入 Collection、Provider 私有字段、observation 内容筛选、citation count 范围、URL/OA/license、普通失败/history、Report/log/attempt、Parser/LLM identity、文件路径、sort、pagination、cursor、include flag 或 raw SQL/FTS 字段。`QuerySelector` 只复用这个查询条件，不复用列表请求的排序、limit 或 cursor。

#### 2.1.2 搜索请求与页面

```text
LibrarySort =
    "publication-year-desc"
  | "publication-year-asc"
  | "title-asc"
  | "title-desc"
  | "relevance"

LibrarySearchRequest
  query: LibraryQuery
  sort: LibrarySort = "publication-year-desc"
  limit: int = 50
  cursor: str | None = None

LiteratureSearchItem
  literature: Literature
  metadata_revision: int
  metadata_sha256: Sha256
  missing_step: LiteratureMissingStep | None
  needs_manual_pdf: bool

LibrarySearchPage
  items: tuple[LiteratureSearchItem, ...]
  total_count: int
  next_cursor: str | None
```

`limit >= 1`；cursor 非空时是调用方不得解释或修改的不透明字符串，并与规范化 query、sort 和稳定位置绑定。cursor 不保存查询或数据库 snapshot；后续翻页重新读取当时的 current facts，数据库在两次请求之间变化时结果和 `total_count` 可以相应变化。`relevance` 只允许在 `query.text` 非空时使用。年份或标题缺失的记录在对应排序中排在具有该值的记录之后；所有排序最后使用 `literature_id` 作为稳定 tie-breaker。`total_count >= 0`，表示忽略本节 cursor/limit 后同一 query 的完整命中数；`items` 不重复且数量不超过 limit，`next_cursor` 只在仍有下一页时存在。

每个 `LiteratureSearchItem` 表示一篇具体 `Literature`，不按 `MetaLiterature` 折叠。不同 Provider 的重复记录已经作为同一 Literature 的多个 observations 收敛，不制造多个列表项；同一 MetaLiterature 下的不同明确版本仍分别出现，并通过 `literature.meta_literature_id` 归组。`Literature` 已经包含当前完整 `LiteratureMetadata` 和派生 `LiteratureStatus`，因此 SearchItem 不在顶层重复 metadata/status；revision/hash、第一缺失步骤和人工 PDF 标记是当前读取上下文的补充。

列表不嵌入 MetadataObservations、资产、ParserResult、LiteratureContent、Reference/Support、Discovery cause 或 artifact 字节。`LibrarySearchPage` 是一次读取结果，不另套 Entry Report。

#### 2.1.3 LiteratureDetail

```text
LiteratureAssetView
  asset: Asset
  literature_asset: LiteratureAsset

LiteratureDetail
  literature: Literature
  meta_literature: MetaLiterature

  metadata_revision: int
  metadata_sha256: Sha256

  missing_step: LiteratureMissingStep | None
  needs_manual_pdf: bool

  metadata_observations: tuple[MetadataObservation, ...]

  primary_pdf: LiteratureAssetView | None
  additional_assets: tuple[LiteratureAssetView, ...]

  parser_result: ParserResult | None
  content: LiteratureContent | None

  other_versions: tuple[LiteratureSearchItem, ...]

  reference_count: int
  cited_by_count: int
```

`LiteratureDetail` 是针对一个具体 `LiteratureId`，由当前 Catalog 事实和 ArtifactStore 稳定引用在同一 read-only snapshot 中临时组装的不可变查询投影。它不获得自己的 ID、provenance、hash、revision、数据库表、artifact 或写入生命周期，不能作为更新数据库的输入；每次查询都重新读取当前事实。`LiteratureAssetView` 同样只是把既有不可变 `Asset` 文件事实和 `LiteratureAsset` 归属/来源关系组合起来，不复制成新的持久化对象。

字段语义为：

- `literature` 是当前具体版本，已经携带当前 metadata 与 status；
- `meta_literature` 必须是当前 Literature 所属聚合，并给出代表 Literature；
- `metadata_revision/metadata_sha256` 精确描述 `literature.metadata` 的当前绑定；
- `metadata_observations` 返回已归属当前 Literature 的全部不可变来源事实，按 `provenance.observed_at` 降序、`observation_id` 稳定排序；该顺序只服务展示，不表达字段 precedence；
- `primary_pdf` 只允许唯一 `role = "primary-pdf"` 的当前关系，`additional_assets` 包含其它角色并按 role、`literature_asset_id` 稳定排序；
- `parser_result` 只返回 source Asset/hash 与当前主 PDF 对齐的当前结果；
- `content` 只返回 Literature 已整体接纳、与当前 metadata revision/hash、主 PDF 和 ParserResult 对齐的唯一当前 LiteratureContent；
- `other_versions` 复用列表项表达同一 MetaLiterature 下除当前 Literature 外的具体版本，按 `published`、`accepted-manuscript`、`preprint`、`other` 和 LiteratureId 稳定排序，不递归嵌套其它 Detail；
- `reference_count` 是当前 Literature 作为 `Reference.source_literature_id` 的本地权威边数量；
- `cited_by_count` 是当前 Literature 作为 `Reference.target_literature_id` 的本地权威边数量。

两个引用数量必须非负，只统计至少具有一项有效 `ReferenceSupport` 的本地权威 Reference，不能与 `MetadataObservation` 中某个 Provider 报告的参考文献次数或被引用次数合并。PDF 中的参考文献原文已经位于 `content.references`，Provider 原文位于相应 observation；解析后的完整 references/cited-by 边列表及其 support 使用独立、可分页的关系读取，不无界嵌入 Detail。

下列一致性由 Literature 查询规则和 Storage read-model producer 保证，不由 contracts parser 重新推导身份、状态或缺失步骤：

- `literature.meta_literature_id == meta_literature.meta_literature_id`，其它版本共享该 ID 且不包含当前 Literature；
- Detail 中的全部 MetadataObservation 都已归属当前 Literature；
- `primary_pdf` 存在时其关系归属当前 Literature，AssetId/hash 与 ParserResult 输入一致；
- `content` 存在时其 metadata revision/hash 与 Detail 一致，并与当前主 PDF 和 ParserResult 对齐；
- `CONTENT_READY` 必须具有对齐的 primary PDF、ParserResult 和 content；`ASSET_READY` 必须具有 primary PDF 且没有有效当前 content；`UNREVIEWED` 不具有 primary PDF；
- `needs_manual_pdf = True` 时必须没有 primary PDF，且来源只能是当前自动获取耗尽事实；
- `missing_step` 与上述 current facts 使用同一 truth table。

Detail 可以返回 `LiteratureContent.sections/references` 等已结构化文本，但不嵌入 PDF、Parser Markdown、Parser resources 或规范 LiteratureContent Markdown 的完整 artifact 字节。调用方通过稳定 `Asset`/`ArtifactRef` 使用独立 artifact read 操作取得字节。ProviderRelationObservation 全部待扩展边、完整 Reference/Support、DiscoveryRun 历史、Report/log/failure、Network/Parser/LLM 运行现场和机器绝对路径都不进入 Detail；它们在确有读取需求时使用各自独立查询。

`LibraryQuery`、`LibrarySearchRequest`、`LiteratureSearchItem`、`LibrarySearchPage`、`LiteratureAssetView`、`LiteratureDetail`、`LiteratureReferenceRequest`、`LiteratureReferenceItem`、`LiteratureReferencePage` 和 `ReferenceDetail` 都是 query-side TypeScript contract，不是可持久化业务主体。Storage 只能从当前权威行和 artifact 引用组装它们，不能为这些投影建立第二份可修改事实。

#### 2.1.4 引用关系页面与关系详情

`LiteratureDetail` 只给出本地权威引用数量。实际 references/cited-by 使用同一条
`Reference` 的正向或反向分页读取，不建立第二套“被引关系”：

```text
ReferenceDirection = "references" | "cited-by"

LiteratureReferenceRequest
  literature_id: LiteratureId
  direction: ReferenceDirection
  limit: int = 50
  cursor: str | None = None

LiteratureReferenceItem
  reference: Reference
  related_literature: LiteratureSearchItem
  support_count: int

LiteratureReferencePage
  items: tuple[LiteratureReferenceItem, ...]
  total_count: int
  next_cursor: str | None

ReferenceDetail
  reference: Reference
  source: LiteratureSearchItem
  target: LiteratureSearchItem
  supports: tuple[ReferenceSupport, ...]
```

当 `direction = "references"` 时，请求中的 Literature 必须是
`reference.source_literature_id`，`related_literature` 是被引用的 target；当
`direction = "cited-by"` 时，请求中的 Literature 必须是 target，相关文献是引用它的
source。`LiteratureReferenceItem` 不复制 source/target、metadata 或 support；方向由请求和
`Reference` 本身共同给出。`support_count >= 1`，只统计该 Reference 当前有效的去重 support。

关系列表使用固定排序：相关文献发表年份降序、缺失年份后置，随后按规范化标题升序、缺失
标题后置，最后用相关 `literature_id` 稳定打破并列。`limit >= 1`；cursor 与
`literature_id`、direction 和最后一个稳定位置绑定，并保持不透明。`total_count` 只统计当前
至少具有一项有效 support 的本地权威 Reference。与普通搜索相同，后续页面重新读取届时的
current facts，不承诺跨请求保存数据库 snapshot。

`ReferenceDetail` 通过一个 `ReferenceId` 读取关系两端和全部当前 support。source/target
分别复用非递归的 `LiteratureSearchItem`，不能互换；support 按
`provider_relation`、`metadata_reference_text`、`content_reference_text` 的类型顺序，再按
各自 observation ID、content hash 和零基 reference index 稳定排序。Detail 不复制
support 所定位的供应商 observation、参考文献原文或 provenance；调用方需要查看原文时，
根据 support 定位到 source Literature 的 `LiteratureDetail` 中相应 observation/content。

Provider 报告的 citation count 继续属于 `MetadataObservation`，不进入
`LiteratureReferencePage.total_count`、`support_count` 或 `ReferenceDetail`。请求、页面、
列表项和关系详情都是同一 read-only snapshot 中临时组装的 query projection，不持久化、
不形成 Report，也不允许作为 Reference 写入输入；不存在的 Literature 或 Reference 返回稳定
not-found 读取错误。

#### 2.1.5 从详情取得 artifact

`LiteratureDetail` 已经给出用户可读取的稳定 artifact 引用：

- 主 PDF 使用 `primary_pdf.asset`；
- Parser Markdown 使用 `parser_result.markdown`；
- Parser 实际引用资源使用 `parser_result.resources[].artifact`；
- 规范轻结构化 Markdown 使用 `content.markdown`。

Artifact 读取直接接受既有 `Asset | ParserArtifactRef | ArtifactRef`，不再建立
`ArtifactHandle`、artifact 字节 contract、下载 token 或第二套路径对象。只读 binary
stream、用户目标路径和 context manager 是运行时 I/O 对象，不能进入 contracts、JSON、
Catalog、Report 或 `LiteratureDetail`。因此 Detail 本身不增加 `open()`、`export()` 等业务
方法；调用方从 Detail 取得引用，再交给 Entry/Literature 的独立 artifact 操作。

### 2.2 查询

`query.ts` 拥有本地文献查询的业务语义，Storage adapter 实现统一 read-model 边界；精确 TypeScript 合同见 [本地文献数据库查询与详情](#21-本地文献数据库查询与详情)。查询使用 Storage 的 read-only snapshot，不回放身份算法，不访问 Metadata Provider，不创建 DiscoveryRun，不执行 PDF/Parsing/Analysis，也不根据运行报告或日志推导状态。

#### 2.2.1 LibraryQuery 与结果单位

`LibraryQuery` 只表达本地数据库筛选条件。不同字段使用 AND，一般多值字段内部使用 OR，keywords 要求当前 metadata 同时具有全部给定完整关键词。普通 `text` 只搜索当前权威 metadata、作者/单位/标识符和当前 LiteratureContent 正文章节，不搜索来源 observation、参考文献原文、URL、provenance、运行记录、日志、失败或文件路径，也不接受 SQL/FTS 表达式。

搜索结果固定以具体 `Literature` 为单位，不按 MetaLiterature 折叠。多个 Provider observations 已经通过身份规则收敛到同一 Literature，不会制造重复列表项；同一 MetaLiterature 下的预印本、作者接受稿和正式发表版仍是可独立拥有元数据、PDF 和内容的具体版本，因此可以分别出现。`meta_literature_id` 只提供版本归组信息，批量补全随后是否按 MetaLiterature 去重属于 Entry 规则，不能反向改变查询读取语义。

排序、limit 和 cursor 属于 `LibrarySearchRequest`，不进入 `LibraryQuery`。因此 `QuerySelector` 只能复用稳定查询条件，在补全开始时从一致 snapshot 展开全部命中范围；它不能把某一页 UI 结果、relevance 顺序或 cursor 当成处理范围。

当前 TypeScript 为 Entry 提供内部 `selectionSnapshot(LibraryQuery)` 读取，返回不可变的
`matches`（实际命中的具体版本）与 `members`（这些版本所属 Meta 的全部当前成员）。两者由同一
SQLite read-only transaction 形成，FTS 和其它过滤条件只决定 `matches`，不把补充的兄弟版本
变成新的命中对象。此读取不接收 goal、不决定排除目标或候选优先级；这些决定仍属于 Entry。
现有 `search()` 的具体 Literature 结果、排序、分页、cursor 和书目导出选择语义不变。

#### 2.2.2 搜索列表投影

`LiteratureSearchItem` 复用完整当前 `Literature`，并补充 metadata revision/hash、第一缺失步骤和 `needs_manual_pdf`。`Literature` 已经拥有当前完整 metadata 和派生 status，列表项不得再维护一套摘要 metadata 或独立 status。`LibrarySearchPage` 返回具体 Literature 列表、完整命中总数和可选不透明 next cursor；纯查询结果本身就是输出，不包装 Entry Report。

第一缺失步骤只允许当前最早的一项：没有主 PDF 为 `primary-pdf`，已有主 PDF 但没有对齐 ParserResult 为 `parser-result`，已有两者但没有对齐 LiteratureContent 为 `literature-content`，CONTENT_READY 则为空。`needs_manual_pdf` 只来自最小自动获取耗尽事实；false 只表示没有该事实，不能承诺自动来源一定可用。

#### 2.2.3 LiteratureDetail 临时聚合

`LiteratureDetail` 服务“打开一篇具体 Literature”的读取操作。它在同一个一致 snapshot 中临时聚合：

- 当前 Literature、所属 MetaLiterature、当前 metadata revision/hash、第一缺失步骤和人工 PDF 标记；
- 已归属该 Literature 的全部不可变 MetadataObservations；
- 唯一当前主 PDF、补充资产以及各自 Asset/LiteratureAsset 文件与来源事实；
- 与当前主 PDF 对齐的当前 ParserResult；
- 与当前 metadata/PDF/ParserResult 对齐且已整体接纳的当前 LiteratureContent；
- 同一 MetaLiterature 下其它具体版本的列表项；
- 当前 Literature 作为引用方和被引用方的本地权威 Reference 数量。

Detail、SearchItem、SearchPage 和资产组合 view 都是不可变 query projection，不是新的领域实体或持久化主体。它们没有自己的 ID、provenance、hash、revision、数据库表或写入 API，每次查询都从 current facts 重新组装。Detail 不能成为更新 Literature、资产或内容的输入。

同一个 Detail 不得拼接不同时间点的事实：status、missing step、primary PDF、ParserResult、content 和 metadata revision/hash 必须使用同一 truth table 并相互对齐。MetadataObservations 的展示顺序不表达字段 precedence；当前统一 metadata 始终以 `literature.metadata` 为准。

#### 2.2.4 引用关系页面与关系详情

Detail 的 `reference_count/cited_by_count` 只统计本地、至少具有一项有效 support 的权威 Reference。供应商报告的 reference/cited-by count 仍属于各自 MetadataObservation，可以查看来源差异，但不能与本地已解析关系数量混成一个字段。

完整关系使用 [引用关系页面与关系详情](#214-引用关系页面与关系详情) 的独立读取：

```text
LiteratureReferenceRequest(literature_id, "references")
  -> LiteratureReferencePage
       -> Reference + 被引用 LiteratureSearchItem + support_count

LiteratureReferenceRequest(literature_id, "cited-by")
  -> LiteratureReferencePage
       -> Reference + 引用方 LiteratureSearchItem + support_count

ReferenceId
  -> ReferenceDetail
       -> source LiteratureSearchItem
       -> target LiteratureSearchItem
       -> 当前全部 ReferenceSupport
```

正向和反向读取始终使用同一条 `Reference`，不能建立 cited-by 边、关系摘要表或第二套计数事实。页面只展开相关 Literature 的非递归 `LiteratureSearchItem`，具体关系打开后才返回 support；普通页面不重复返回全部 support。固定排序、cursor 和 total 均从当前受支持关系与相关 Literature 的 current facts 形成，整页必须来自同一 read-only snapshot。

`ReferenceDetail.supports` 只返回已经存在的精确 locator。它不复制供应商关系 observation、原文或 provenance；文本 support 所指向的原文通过引用方 Detail 中的 `MetadataObservation.reference_texts` 或 `LiteratureContent.references` 读取。Provider relation support 指向的 observation 继续由 Metadata 的独立读取拥有。关系不存在、端点已经不一致或没有任何有效 support 时不能伪造 Detail。

#### 2.2.5 Artifact 读取与导出

Detail 不嵌入 PDF、Parser Markdown/资源或规范 LiteratureContent Markdown 的完整字节。调用方直接从 [从详情取得 artifact](#215-从详情取得-artifact) 列出的字段取得既有 `Asset | ParserArtifactRef | ArtifactRef`，再调用 Literature 公开的 artifact read 操作；Detail 本身仍是无 I/O 的不可变 TypeScript query projection。

Artifact read Port 由 Literature 消费并由 Storage 实现。当前公开读取通过 `LiteratureArtifactService.withArtifact` 在 callback 生命周期内提供受控只读内容，不返回机器绝对路径或长期文件句柄。Storage 在交出 stream 前解析规范相对引用，并复核正式对象是普通文件、byte size、SHA-256 和预期 media type；缺失、越界、大小/hash 冲突或类型不一致时 fail closed。调用方负责在 callback 范围内消费，不能依赖 ArtifactStore 的内部目录布局。

面向用户文件的 artifact 导出由 Entry 使用同一 verified reader 完成：在目标文件同目录建立 owner-only staging，写完后 flush、`fsync` 并再次核对字节数/hash，再原子发布。目标已存在时默认拒绝；只有调用方明确要求覆盖才允许原子替换，不能静默覆盖或暴露半文件。目标路径只是本次外部 I/O 参数，不进入 Detail、contracts、Catalog、provenance 或 Report。

读取和导出 artifact 都是 query-side 操作：不创建 DiscoveryRun，不访问 Provider，不修改文献数据库，也不形成五类处理 Report。打开或导出失败返回稳定读取/文件错误；它不改变 Literature 状态、当前 artifact 关系或下一缺失步骤。

除上述主要读取外，查询 API 仍提供：MetaLiterature 全部成员和代表 Literature、各 Provider citation count observations、ProviderRelationObservation、DiscoveryRun 发现记录，以及 Entry 所需的按 MetaLiterature 聚合成员 current facts。普通运行 failure 只由本次 Report 呈现，日志只提供非权威实时诊断。

### 2.3 Library 的实际读取与导出

`Application.library.search()` 使用闭合 LibrarySearchRequest 和同一只读 snapshot 形成 LiteratureSearchItem。
状态与 missing step 复用 Literature 的纯推导函数；CONTENT_READY 绑定生成时谱系，重新解析不撤销已接纳内容。
五种排序的 cursor 保持 Python query 的 canonical JSON 语义。`library.references()` 提供正反向分页，
`library.referenceDetail()` 返回同一 snapshot 中两端与有效 support locator；查询不生成第二套关系事实。
Discovery 条件校验结果/cause 的具体 Literature 归属，不能用 MetaLiterature 的所有版本扩大命中。
`library.detail()` 在同一 catalog snapshot 中组装完整 LiteratureDetail，并按不可变引用验证 structured
content 的 canonical JSON、hash 与生成谱系；ParserResult 也重算规范 manifest hash。证据见
[文献详情](../../../migration/evidence/runtime/literature-detail.md)。`Application.literatureArtifacts.withArtifact()`
提供有作用域、大小预算和取消的只读字节流；Entry `exportArtifact()` 使用同一 verified reader 原子导出，默认
拒绝已存在目标。具体边界见[artifact 读取与导出](../../../migration/evidence/runtime/literature-artifact.md)。
当前搜索匹配范围会物化到内存，完整内容容量验收仍待实现；搜索证据见[状态与搜索](../../../migration/evidence/runtime/literature-query.md)。

## 3. 独立查询应用与只读生命周期

### 3.1 两种生产组装与关闭顺序

维护应用由 `createApplication(home, options)` 构造。它读取普通配置、组装已选择的 Metadata/Acquisition/Parser/Agents、写入准入及业务发布者；显式维护启动可以初始化受支持 catalog 并执行对应恢复。其资源按依赖逆序关闭，某个 release 失败不能跳过其它 release。

查询应用由 `createQueryApplication(home)` 构造，公开结果为：

```ts
interface QueryApplication {
  readonly readiness: {
    readonly status: "ready" | "not-initialized" | "unavailable";
    readonly schema_version: number | null;
    readonly schema_fingerprint: string | null;
  };
  readonly query: Pick<
    LiteratureQueryService,
    "search" | "detail" | "references" | "referenceDetail"
  > | null;
  readonly literatureArtifacts: LiteratureArtifactService | null;
  close(): Promise<void>;
}
```

此处是已实现接口摘录，类型从 server 包导出。`query` 为空时调用方必须先处理 readiness，不能转调 `createApplication` 补齐。catalog 不存在时不创建 home；未知 fingerprint 不升级；已有待恢复票据/Job/receipt 不在查询启动时被扫描执行。SQLite 以 read-only/query-only 打开，允许其 WAL/SHM 协调文件，但不产生业务写入。一次读取见已提交事实；分页之间可以看到后来显式维护的提交，不假称全旅程 snapshot。

查询关闭先停止和释放文件读者，再关闭 SQLite worker；并发、重复和重入 close 共用同一个 Promise，全部 release 被尝试后统一报告错误。CLI 对操作与清理同时失败保留两项原因，对用户只输出稳定错误码。独立 Web 先停止接收 HTTP/中断响应流，再关闭 QueryApplication。客户端断开不获得启动维护的权限。

查询与维护共同读取配置指定的同一个 catalog/artifact root，分离的是能力与副作用；既不复制库，也不引入新的同步总线。

### 3.2 独立查询操作的实际组装

#### 3.2.1 公开面与能力限制

`createQueryApplication(home)` 从 server 包导出，供 CLI、外部科研 Agent 和 Web adapter 使用。它公开 readiness、query、literatureArtifacts、close；不包含 discovery、completion、Jobs、Parser、Agents 或 Browser。普通配置只用于定位同一 catalog 和 artifact root，不加载凭据或构造外部能力。

| 入口        | 调用                                                      | 成功结果                 |
| ----------- | --------------------------------------------------------- | ------------------------ |
| 库内搜索    | `query.search(LibrarySearchRequest)`                      | LibrarySearchPage        |
| 详情        | `query.detail(literatureId)`                              | LiteratureDetail         |
| 正/反向引用 | `query.references(LiteratureReferenceRequest)`            | LiteratureReferencePage  |
| 引用证据    | `query.referenceDetail(referenceId)`                      | ReferenceDetail          |
| 已有文件    | `literatureArtifacts.withArtifact(ref, consume, options)` | 作用域内验证后的只读字节 |

`ready` 表示受支持 v1/v2 schema 可被读取，不是全库健康认证。缺库/无 schema 返回 not-initialized，配置/存储/未知 schema 返回 unavailable；已打开库的索引或对象错误在实际读取时失败。存在未恢复的 Job、receipt 或回收票据不自动改变它们，也不阻止其它完整已提交资料读取。

CLI `literature search/show/references/cited-by` 与 `export metadata/pdf/content` 使用此图。缺库时退出码 3、code=query-not-initialized，不再隐式建库；已初始化库上的原结果与导出格式保持。导出副本是用户明确请求的文件副作用，不是扩库。

#### 3.2.2 HTTP 与生命周期

`startQueryOnlyWorkbench({ home, port? })` 组装独立阅读页，默认加载安装包中的 query.html/query.js。GET `/api/v1/query/status` 返回 readiness；POST `/api/v1/query/search|read|references|reference|artifact` 使用 `{ protocol_version: 1, request }`。未知输入被拒绝；缺 PDF/内容返回 gap，传输或索引错误不得伪装成空结果。

服务仅监听 loopback并检查 Host/Origin。详情请求只接受稳定 ID，artifact只接受ID与已定义kind，不能从远程参数读取任意本机路径。关闭先停止新HTTP请求/结束响应流，再释放QueryApplication；CLI的operation/cleanup同时失败保留两项cause，stdout不输出原始异常或secret。

### 3.3 独立阅读与共享产品服务

`startQueryOnlyWorkbench` 使用独立 `createQueryApplication`，仅打开支持的已有 Catalog 与 artifact reader；它不创建维护 Application，不恢复 Jobs，也不启动 Browser。`query.html/query.ts` 复用 Library 展示，通过 `/api/v1/query/*` 读取；缺库与损坏分别呈现，刷新、搜索和下载都不会隐式扩库。

混合 live 工作台仍持有完整 Application，不能把它的隔离程度等同于 query-only。配置页调用同一 TypeScript Configuration owner，保存 revision 与运行 snapshot 分别反馈，新的外部请求重新授权凭据。Web 不维护第二份来源默认表或业务状态。

完整连续获取的观察与自然语言指导还需把工作台接到同一生产文章流程。控制 epoch、页面观察 revision、文章 generation 分别校验，接管后旧模型结果失效；人工候选仍经过 Acquisition 的同一字节/身份/发布门。详细子协议与未决生命周期见 Human Interaction，不能从页面按钮存在推导这些旅程已验收。

## 4. 知识检索与上下文组装

明确 Literature 或 Artifact 范围的知识覆盖在固定 generation 内逐 ID 检查，并沿用用途、问题和选择过滤；部分 ID 有结果时，其余 ID 仍以 `knowledge-missing` 精确报告。已有索引但查询词零匹配不等于知识缺失。坏源扩展、缺口、候选位置和最终 Bundle 字节数作为一次分页提案核验，装不下时保持原位置供下页重试；完整项和紧凑引用也遵守同一字节及缺口数量上限。文档闭包在读取首个文件字节前，按已核验的 PDF、Markdown、结构和资源声明大小预留验证预算。材料读取与知识来源读取共享请求级累计限额，但两位读取 owner 各自验证同一资产时会保守重复计量。页面切换查询或离开时会取消在途固定范围续读请求。

### 4.1 子能力和数据所有权

| 子能力         | 职责                                 | 输出                     |
| -------------- | ------------------------------------ | ------------------------ |
| 查询规范化     | 验证词句、范围、类型、版本策略和预算 | 内部类型化 QueryRequest  |
| 候选检索       | 按允许字段访问只读索引/投影          | 带来源类别与版本的命中   |
| 版本与重复处理 | 对具体版本分组、去除重复片段         | 可说明的排序与分组       |
| 上下文组装     | 选择片段、预算分配、附邻近上下文     | ContextBundle            |
| 证据展开       | 调用 Document/Evidence 精确读取      | 原文、资源、引用解析结果 |
| 索引维护       | 显式维护生成投影、记录覆盖           | 可替换索引 generation    |

索引维护属于单独写入用例，不能注入查询对象。Q 拥有投影与检索规则，不拥有元数据、材料或知识产物；被读事实的有效性仍由原 owner 判断。索引损坏不会使源文献变成“不存在”。

应用组装只向读取服务注入 Literature、Document、Knowledge 和 artifact read ports。Metadata、Acquisition、Parser、AgentRuntime、Job-create 和 schema migration 均不属于此对象图。依赖隔离要由生产入口证明，不能只靠函数内注释。

### 4.2 查询合同

完整目标接口见[查询合同](#51-查询合同)；当前实现以源码为准。

### 4.3 索引设计与读取一致性

当前 `literature_search_fts` 只索引允许的 current metadata 和旧内容正文，具体字段见 Literature/Storage。新文档或知识索引需要明确独立投影，不能悄悄把来源 observation、日志、参考文献原文和内部路径加入既有搜索语义。

建议每条新索引记录绑定：源 owner、精确对象/版本 ID、内容 hash、分段规则版本、索引 schema/generation。正文仍从受控 artifact reader 取得，索引不成为唯一内容副本。

查询先取得索引命中，再验证源版本仍可读。遇到陈旧或缺失项可返回其缺口并继续其它命中，但 coverage 必须保留事实；不能因为过滤掉失败项就声称全部结果完整。读取不到源对象时不启动重建。

索引发布由维护入口完成：固定输入范围 → 构建新 generation → 校验覆盖 → 原子切换可读指针。失败保留旧 generation。更新期间 reader 固定自身 generation；继续 cursor 绑定查询规范、范围和 generation，失效时返回需重新查询，不偷偷换页序。

第一版优先验证 SQLite FTS 与显式投影是否满足场景。向量、混合排序、重排与单独索引服务要依据代表性数据和问题评估后选择；架构不预定向量数据库。若未来引入付费模型重排，也不能把它隐藏在目前承诺无模型副作用的查询里，必须另行定义能力与成本合同。

### 4.4 排序、去重与上下文组装

#### 4.4.1 候选检索与稳定顺序

查询语法在 Q/Literature 边界解析，用户文本不直接成为 SQL 或裸 FTS 表达式。过滤条件和搜索范围在候选生成阶段执行，不能先检索全库再在前端隐藏越界项。

排序使用明确的主排序和稳定 tie-breaker，如具体文献/产物/片段 ID。默认结果中可优先展示同一论文的一份适合用途的知识产物，但须保留展开其它版本/用途的入口；不能将“默认展示”变成删除其它结果。

#### 4.4.2 重复与相关版本

相同文本片段可在一次上下文中去重，但保留所有实际来源关联。预印本、正式版、综述转述与原始实验的关系不同；多个重复版本不能被总结成多个独立证据支持。

同一文献有多个问题分析产物时，用途不同不应只按 PDF hash 去重。依据论文 ID 去重也会吞掉一文多项实验；Q 不承担领域记录去重。

#### 4.4.3 预算分配

上下文预算先留出来源标识、证据和缺口的开销，再选择正文片段。每次加入片段后核算实际 UTF-8 字节及可用 tokenizer 的 token；不使用“约四字符一 token”伪装精确计量。

尽量按章节/段落/表格上下文边界裁切，保留否定、单位、脚注和条件。预算容不下关联上下文时，返回可展开引用和明确截断，不能只留下数值。资源字节通过单独受控读取交付，不默认把整个 PDF/base64 塞进 ContextBundle。

Context 是临时读取结果，不持久化成 KnowledgeArtifact。若用户要求新的问题回答或综合，须明确调用 Analysis 加工已有输入；该请求同样没有自动扩库权限。

### 4.5 缺口与下一步

| 情况           | 结果应说明                     | 用户另行可做的操作      |
| -------------- | ------------------------------ | ----------------------- |
| 未初始化库     | not-initialized                | 明确初始化/维护         |
| 正常零命中     | 实际搜索范围与类型             | 改查询，或明确外部发现  |
| 有元数据无 PDF | material-missing               | 明确 acquire/ingest     |
| 有 PDF 无文档  | representation-missing         | 明确 parse              |
| 无所需用途分析 | knowledge-missing              | 明确 analyze/synthesize |
| 索引缺失/陈旧  | index-unavailable/stale 与覆盖 | 明确重建索引            |
| 证据失效/损坏  | 原引用和稳定原因               | 人工核对/维护恢复       |

上述类别说明语义，不强行改名现有 CLI 错误码。Gap 可以携带展示建议，但不得包含自动运行 callback、排队 Job 或“已开始准备”假状态。查询后点击维护入口是新请求，必须重新固定目标和副作用。

“未找到某实验条件”只意味着该查询与覆盖范围没有命中，不能自动生成“原文未报告”领域记录。下游提取器应依据完整读取和自己的缺失规则判断。

### 4.6 并发、取消与性能边界

当前 QueryApplication 为普通材料／库读取和检索各持有一个只读 SQLite worker；材料与知识检索共用后者，数量不随请求增加。冷检索的同步完整性校验及 `data_version` 变化后的再校验保持原义，不再占用库读取队列。应用关闭先 drain 两个 Context service，再关闭检索 worker 和材料 reader；启动失败复用同一清理路径。维护 Application 为索引构建持有一个独立 SQLite worker，避免整代完整性检查的同步工作堵住建档普通读写队列；全部 generation/repair 状态留在这个连接，共享 catalog 写入 admission，批量写入仍按同一规则串行。HTTP 取消不终止共享 worker，已发送的同步 SQLite 工作仍需结算。

一次读取内部使用已提交 snapshot 和固定 artifact 引用，不混合两个 current 版本。跨页是否固定数据库 snapshot 取决于协议；现有 Library 分页只保证单页一致，新协议若固定索引 generation也不能假称底层业务永不变化。

取消停止继续扫描和资源展开；已交付的读取片段无需回滚。读失败与数据库不可用不能当成零结果。重复查询通常不要求 durable 幂等键；响应变化可来自新的显式维护提交，结果应带版本和覆盖以供识别。

数据规模未知时不宣称延迟 SLA。实现需有候选扫描上限、有界片段读取和可解释截断；性能评估区分 FTS 候选时间、源内容验证、资源读取与组装成本，避免每次查询读全库所有 artifact。

### 4.7 当前入口与目标映射

当前 `createQueryApplication(home)` 返回本地只读用例、artifact reader、readiness 和可重复关闭的生命周期。CLI 查询与 `startQueryOnlyWorkbench` 消费它；混合工作台仍可持有完整 Application，不能混为同一个隔离证明。

`/api/v1/query/status` 与 search/read/references/reference/artifact 服务于 Library 合同；`/api/v1/query/context` 服务于已实现的 `MaterialContextRequest`，不接受本节仍属目标的 KnowledgeQuery/manifest/knowledge 类型。旧 `LiteratureSelector.kind = "query"` 仅是明确维护任务的目标选择器，不是读取时创建任务的许可。

新增上下文能力应扩展只读对象图与版本化协议，不从 QueryApplication 取完整 Application 再“约定不用 writer”。公共包、HTTP、CLI 和人类页必须共用事实 owner，不能分别实现一套搜索结果解释。

### 4.9 材料 Context 的实现边界

`retrieval-context.ts` 定义 `MaterialContextRequest/MaterialContextBundle`，固定查询、范围、类型、版本、字节预算与续读位置。当前无 tokenizer；请求与使用方式见[读取指南](../../guides/library-query.md#上下文检索)。

材料投影使用当前 schema 中的 `retrieval_*` 表。显式重建完整验证来源，建档发布后的 refresh 可复用来源未变且验证通过的条目。构建者使用独立 generation 锁，catalog 写入按有界批次准入；开始和发布校验、source revision CAS 决定新 generation 是否可用。源变化返回过时，不切换旧 active。只读查询不隐式修复。

发布后的刷新由 `retrieval/refresh.ts` 合并执行。文档接纳后仅等待刷新请求原子落盘，回执 `index_status=scheduled`；建档和 READY 不等待整库索引，也不依赖刷新成功。100 ms 的批次窗口合并相邻发布，运行中最多保留一个最新 source revision；一个 catalog 同时只有一个后台刷新者，底层 generation 锁继续约束显式重建。新请求的 revision 已被本次新代覆盖时不再补跑，否则执行最新一份待处理请求。失败保留现有 active generation 与文档；index-stale 且确认源 revision 前进时，合并最新源重跑，涵盖 render 后元数据步骤造成的变化。没有新源或新请求的同一失败不会循环重试；新发布或显式维护可再次请求。关闭时取消构建并将未完成请求保留，下一次维护 Application 启动恢复 scheduled/running 状态；只读查询不启动工作。

非秘密状态保存为 `<catalog>.index-refresh.json`，属于可重建投影队列，不是资产、配置或新业务事实；不改变 catalog schema。只接受严格 schema、当前用户的 0600 普通单链接文件，拒绝符号链接；写入经独立短锁串行，临时文件 fsync 后原子 rename，再 fsync 目录。独立 worker 锁负责跨进程单刷新者，状态锁只保护短更新，不在扫描期间占用 catalog 写入准入。状态为 idle/scheduled/running/updated/failed，字段含 request_sequence、requested_revision、indexed_revision、请求/开始/结束时间与 technical_details.code；请求序号使同一源 revision 的后到请求在失败后仍可重试。原因码不含异常原文。坏状态返回 index-refresh-state-invalid，不阻止维护进程启动；显式成功重建可重置损坏 JSON，始终拒绝覆盖不安全的文件。

HTTP `POST /api/v1/query/index-status`（request 为 `{}`）、CLI `maintenance index-status`、MCP `index_status` 共享此状态读取。重试使用现有 HTTP maintenance/rebuild-index、CLI `maintenance rebuild-index` 或 MCP `rebuild_index`；显式成功重建清除失败。排队后短命 CLI 进程退出会留下 scheduled 请求，长驻 Web 或下一次维护进程可续跑；需要立即完成时显式重建。没有就绪代仍返回 index-unavailable；源领先于 active 时继续返回 index-stale 缺口，不返回旧命中。scheduled 表示落后状态可见，不承诺刷新固定耗时。

### 4.10 处理器结果与混合 Context

`knowledgeContext` 将材料 Context 与已发布处理器结果合并。原始文档和生成结果明确区分；固定结果及上游依赖通过 `processorRead` 核验，来源缺失、损坏、过时与未命中分别表达。覆盖、排序、预算及继续位置规则见本节前述合同；score 不表示科学可信度。

结果记录与全文投影由结果存储维护，生成成功但索引失败时保留不可变结果，可显式重建；不是另一份知识产物事实。结果输入及递归引用见[知识加工](05-knowledge-processing.md#3-结果格式与发布)，当前单一 catalog 与投影完整性见[存储](07-versioned-storage.md#4-知识版本依赖与回收)。

### 4.8 示例与验证

调用方询问“库内哪些文献讨论催化剂在低温下的稳定性”，选择 metadata/document/knowledge 并给定预算。结果可以同时包含原文片段和已有概览，逐项标注类别；缺 PDF 的论文仍可作为元数据命中，但缺口明确可见。零命中时操作结束，不启动任何 Provider。

调用方进一步展开某个断言时，Q 转交 EvidenceRef 给 Document/Evidence；若旧表示被合法失效，返回该状态，不替换成新的近似段落。用户选择“分析这三篇”后才进入独立 Analysis 请求，并固定三篇实际版本。

验证分两层：行为测试证明无隐式写入/外联、范围隔离、预算准确、重复版本不夸大、截断与取消明确；检索质量评估使用版本固定的合成或获准语料、问题与相关证据标注，记录召回/排序/关键条件保留。测试通过数不能代替召回率，模型自评也不能证明检索完整。

## 5. 目标接口（尚未实现）

本节集中保留尚未整套实现的目标合同；当前实现以源码为准，设计记法不等同于已发布 API。

### 5.1 查询合同

#### 5.1.1 范围和内容种类

```ts
interface KnowledgeQuery {
  readonly query: string;
  readonly scope: QueryScope;
  readonly kinds: readonly ("metadata" | "document" | "knowledge")[];
  readonly version_policy: "default" | "explicit";
  readonly budget: ContextBudget;
  readonly continuation: string | null;
}
type QueryScope =
  | { kind: "library" }
  | { kind: "literatures"; literature_ids: readonly string[] }
  | { kind: "manifest"; manifest: InputManifest };
interface ContextBudget {
  readonly max_items: number;
  readonly max_bytes: number;
  readonly token_limit?: { tokenizer: string; max_tokens: number };
}
```

`library` 指现有逻辑文献库，绝不表示外部互联网。显式 manifest 固定版本；default 在本次读取开始时解析为具体引用后固定。空范围、无效 ID、未知内容类型、超限预算和不支持 tokenizer 分别拒绝，不将无效请求扩大为全库搜索。

源材料的身份按 LiteratureId，而不是标题模糊匹配。用户过滤到某个预印本时，不能自动返回正式版正文充数；允许相关版本展示时必须明确标记不同版本和关系。

#### 5.1.2 结果合同

```ts
interface ContextBundle {
  readonly items: readonly ContextItem[];
  readonly coverage: QueryCoverage;
  readonly gaps: readonly Gap[];
  readonly usage: {
    bytes: number;
    items: number;
    tokens: number | null;
    tokenizer: string | null;
  };
  readonly truncated: boolean;
  readonly continuation: string | null;
}
interface ContextItem {
  readonly kind: "metadata" | "source-text" | "generated-knowledge";
  readonly literature_id: string;
  readonly reference: MaterialRef | DocumentRef | KnowledgeArtifactRef;
  readonly text: string;
  readonly evidence: readonly EvidenceRef[];
  readonly rank: number;
  readonly score: number | null;
}
```

`reference` 按 kind 进一步采用判别式 parser，示意 union 不意味着任意组合都合法。元数据命中可以没有 PDF；知识命中必须能追到其输入和证据。压缩产物与原文不可共用一个含义模糊的 `content` 标签。

QueryCoverage 表达已搜索的数据类型、索引 generation、可见范围、排除/失败部分和截断；不等于穷尽了所有相关研究。score 是具体算法的相关性指标，不能标成科学置信度或跨算法通用概率。
