# 06 · 知识查询与上下文技术设计

类型：规格
负责：文献查询、检索投影与上下文读取；technical 中早期形式化接口（查询）
状态：现行；目标接口单独成节

[设计总览](../design.md) · [九模块技术导航](../technical.md)

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
  subject_terms: tuple[str, ...]

  version_roles: tuple[VersionRole, ...]
  statuses: tuple[LiteratureStatus, ...]
  missing_steps: tuple[LiteratureMissingStep, ...]
  needs_manual_pdf: bool | None

  discovery_run_ids: tuple[DiscoveryRunId, ...]
  intake_batch_ids: tuple[IntakeBatchId, ...]

  folder: {id: FolderId, include_descendants: bool} | None
  recently_opened: bool | None

  # 见 2.1.8
  has_primary_pdf: bool | None

  # 见文献与材料 8.4
  needs_metadata: bool | None

LiteratureMissingStep =
    "primary-pdf"
  | "parser-result"
  | "literature-content"
```

`folder` 按使用者的文件夹筛选，`recently_opened` 只取最近阅读过的文献；两者的含义和数据归[用户整理](09-user-organization.md#24-作为筛选条件)。

全部可选单值默认为 `None`，全部多值字段默认为空 tuple；完全空的 `LibraryQuery` 表示查询全部具体 `Literature`。字符串去除边界空白后必须非空，多值字段去重并保持调用方顺序。不同字段之间使用 AND；一般多值字段内部使用 OR；`keywords` 与 `subject_terms` 内部使用 AND，即当前 metadata 必须同时具有全部给定的完整词。

`text` 是普通用户文本，只搜索当前权威视图中的：

- title；
- 当前作者 display/given/family name、ORCID、署名单位名称和 ROR；
- identifiers；
- abstract；
- venue、publisher、volume、issue 和 pages；
- 当前 `LiteratureMetadata.keywords` 与 `subject_terms`；
- 当前 `LiteratureContent.sections` 的标题和 Markdown 正文。

`text` 不搜索 `MetadataObservation`、provenance、AssetHint/URL、供应商参考文献原文、`LiteratureContent.references`、Provider 原始响应、Discovery/Report/日志/失败、Parser/LLM 型号或文件路径，也不接受裸 SQL 或 FTS5 查询语法。专门字段的语义为：

- `title`、`venue` 和 `publisher`：大小写不敏感的包含匹配；`author` 对当前作者 display/given/family name 做同样匹配，不扩展到单位；
- `author_orcids`：规范 ORCID 精确匹配，内部 OR；
- `identifiers`：复用中性 `Identifier`，按规范 namespace/value 精确匹配，内部 OR；
- 年份范围：`1..9999`、包含边界，两个边界同时存在时必须有序；
- `document_types`：开放字符串，按当前规范值精确匹配，内部 OR；
- `languages`：按当前 metadata 规范值精确匹配，内部 OR；
- `keywords`：作者关键词，按完整词忽略大小写匹配，全部给定的词必须存在；
- `subject_terms`：数据库给的学科分类（主题词），匹配规则同 `keywords`；两层词的来源划分见 [ADR 0052](../decisions/0052-intake-batches-and-explicit-scope.md)；
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

`intake_batch_ids` 查询一个或多个入库批次的成员，内部 OR。成员是该次入库命中的全部具体 Literature，包括入库前已经存在的；引用扩展的种子不算成员。schema 15 之前已在库的文献都属于迁移时建立的“早期入库”批次。批次本身的读取见 [2.1.6](#216-入库批次范围词频与-pdf-获取范围)。

`LibraryQuery` 不加入 Collection、Provider 私有字段、observation 内容筛选、citation count 范围、URL/OA/license、普通失败/history、Report/log/attempt、Parser/LLM identity、文件路径、sort、pagination、cursor、include flag 或 raw SQL/FTS 字段。`QuerySelector` 只复用这个查询条件，不复用列表请求的排序、limit 或 cursor。

按文本等级和选择校订范围的事实筛选，见 [2.1.7](#217-文本等级与选择校订范围的事实)。

**被撤回的文献**：任何 `LibraryQuery` 的结果、`total_count`、计数（2.1.8）、词频、引用关系的两端、发现原因与 `QuerySelector` 的展开都排除被撤回的文献，详情按不存在处理；字段不变，调用方不能选择包含它们。撤回的规则见[文献与材料 6.4.11](03-literature-materials.md#6411-撤回)。

`collection_scope` 只接受 `collected | all`，区分收进来的文献与只被发现的文献（[ADR 0065](../decisions/0065-scale-rules.md) 第 2 节）。省略时：浏览列表（查询里没有 text、title、author、venue、publisher、identifiers、author_orcids、discovery_run_ids、intake_batch_ids）按 `collected` 处理，其余查询（搜索、按发现或入库批次查看）覆盖全部；`QuerySelector` 只按显式给出的值展开。每个 `LiteratureSearchItem` 带 `collected`。一篇被导入（`kind='import'` 的批次）、浏览时收藏、手动加标签、放进文件夹或快照、登记过打开阅读（工作台、CLI、MCP 的 `reading-open`）、请求全文或发起加工时，在同一事务里标为收进来，之后不撤销；独立查询页只读，它的打开阅读不算。“收进来”操作见[用户组织 7](09-user-organization.md#7-三个入口)。

只被发现的项（`collected=false`）带 `discovery_origin`：发现过它的主题搜索或引用扩展的入库批次里，`created_at` 最晚的一个（相同时按批次 ID），`kind` 是该批次的发现类型，界面用 `intake_batch_id` 打开那次的发现批次。没有任何发现批次的（例如“早期入库”里缺选用证据的历史文献）为 `null`，不推测来历。收进来的项不带这个字段。取值在同一读快照里按页批量查，耗时与本页项数和每篇被发现的次数有关，与总篇数无关；不另建投影。

`needs_metadata` 为 true 时，只匹配带“书目待补”标记的版本；为 false 时只匹配不带的；null 或省略时不筛选。省略时不进入规范化的查询，已有请求与 cursor 的字节不变。标记的含义见[文献与材料 8.4](03-literature-materials.md#84-书目待补)。

#### 2.1.2 搜索请求与页面

```text
LibrarySort =
    "intake-desc"
  | "collected-desc"
  | "opened-desc"
  | "publication-year-desc"
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
  collected: bool
  discovery_origin?: DiscoveryOrigin | None   # 只在 collected=false 时出现

DiscoveryOrigin
  kind: "topic" | "citation"
  intake_batch_id: IntakeBatchId

LibrarySearchPage
  items: tuple[LiteratureSearchItem, ...]
  total_count: int
  next_cursor: str | None
```

`limit >= 1`；cursor 非空时是调用方不得解释或修改的不透明字符串，并与规范化 query、sort 和稳定位置绑定。cursor 不保存查询或数据库 snapshot；后续翻页重新读取当时的 current facts，数据库在两次请求之间变化时结果和 `total_count` 可以相应变化。`relevance` 只允许在 `query.text` 非空时使用。年份或标题缺失的记录在对应排序中排在具有该值的记录之后；所有排序最后使用 `literature_id` 作为稳定 tie-breaker。`total_count >= 0`，表示忽略本节 cursor/limit 后同一 query 的命中数，口径同 2.1.8 的截断：有筛选或搜索且超过 10,000 时只算到 10,000 并带 `count_truncated`；总数在第一页算出，续页沿用游标里的值，不再重算；按 `relevance` 排序时只能翻到相关度最高的前 1,000 条，命中数超过 1,000 时页面带 `relevance_limit: 1000`，翻到第 1,000 条即止。处理范围的展开（`QuerySelector` 与批量选择）不受这个上限影响。`items` 不重复且数量不超过 limit，`next_cursor` 只在仍有下一页时存在。

`intake-desc` 按最早书目观察的时间（`intake_at`，“最近入库”）；`collected-desc` 按第一次选用的时间（`collected_at`，“最近收进来”），在登记选用的同一事务里写入，之后不改；历史文献按选用证据自带的最早时间回填，没有时间的排在最后。

**受限排序。** 范围超过 10,000 篇（`count_truncated`，或未截断而 `total_count > 10000`）时只接受有索引支撑、按游标翻页的排序：收进来的文献 `collected-desc`，全库、文件夹、入库批次与发现批次 `intake-desc`，最近读过 `opened-desc`，文本搜索 `relevance`；未指定时用这些默认值。其他排序返回 `library-sort-scope-limit`（HTTP 400，CLI 与 MCP 同码），提示先缩小范围，不静默改用别的排序（[ADR 0065](../decisions/0065-scale-rules.md) 第 6 节第 3 条）。不超过 10,000 篇时所有排序照常。文件夹（含下级）、入库批次与发现批次的可见成员由触发器维护成带排序键的投影，翻任意一页只与页大小有关。`relevance` 的第一页给全部命中打分并取前 1,000 条，排名在进程内按最近使用缓存（最多 16 份）；续页沿用第一页的排名与总数，只读取仍可见条目的当前事实；缓存不在时重新打分，从游标锚点接续。

每个 `LiteratureSearchItem` 表示一篇具体 `Literature`，不按 `MetaLiterature` 折叠。不同 Provider 的重复记录已经作为同一 Literature 的多个 observations 收敛，不制造多个列表项；同一 MetaLiterature 下的不同明确版本仍分别出现，并通过 `literature.meta_literature_id` 归组。`Literature` 已经包含当前完整 `LiteratureMetadata` 和派生 `LiteratureStatus`，因此 SearchItem 不在顶层重复 metadata/status；revision/hash、第一缺失步骤和人工 PDF 标记是当前读取上下文的补充。

列表不嵌入 MetadataObservations、资产、ParserResult、LiteratureContent、Reference/Support、Discovery cause 或 artifact 字节。`LibrarySearchPage` 是一次读取结果，不另套 Entry Report。

条目的 `text_level`、`draft_facts` 与按它们排序的键见 [2.1.7](#217-文本等级与选择校订范围的事实)。条目与 `LiteratureDetail` 另增加 `needs_metadata: bool`（见[文献与材料 8.4](03-literature-materials.md#84-书目待补)）。

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

各部分默认文本的等级（`LiteratureAssetView.default_text`）见 [2.1.7](#217-文本等级与选择校订范围的事实)。

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

#### 2.1.6 入库批次、范围词频与 PDF 获取范围

决定见 [ADR 0052](../decisions/0052-intake-batches-and-explicit-scope.md) 与 [ADR 0063](../decisions/0063-unified-intake.md) 第 1、3 节。

**读模型。** 一切入库都形成入库批次：主题发现、引用扩展，以及经[入库过程](03-literature-materials.md#642-过程与状态)的各种载体。`IntakeBatch` 是入库批次唯一的读模型：入库记录的列表、批次页，以及 HTTP 版 MCP 的 `intake_batch_status`，读的都是它。对外只有批次编号，没有另一套会话编号。

**开放批次。** 网页收藏与补 PDF 是逐条确认的，每台设备、每个发起入口每天各一个开放批次。“一天”按服务端的系统时区划分，规则见[文献与材料 6.4.2](03-literature-materials.md#642-过程与状态)。

- 成员按文献去重，分类保留 created > enriched > matched。
- 改名沿用原批次的改名入口；改名后，当天后续的条目仍归入，保留用户名称。

精确类型与解析在 `packages/contracts/src/intake.ts`。

```text
IntakeBatch
  batch_id, kind: topic | citation | import | legacy
  confirmation: batch | per-item | None        # topic、citation、legacy 为 None
  origin: web | cli | mcp | migration
  initiated_by: str                            # "local:web" | "local:cli" | "local:mcp" | "device:<connection_id>"
  state                                        # collecting | awaiting-confirmation | running | finished | cancelled | withdrawn
  result                                       # completed | partial | failed | interrupted | None，只在 finished（及其后撤回）时非空
  created_at, confirmed_at, finished_at
  label, default_label, renamed
  request            # 用户输入的简要形式；多种子、双方向的完整参数留在 DiscoveryRun
  source: {system, library_id, identity: global | local | adhoc, name} | None   # 只有 import 有
  counts: hits, created, enriched, matched, rejected
          restored, conflicts, possible_duplicates, pending_decision, needs_metadata
  pdf: has_pdf, unavailable, pending   # 读取时按当前库现算，按版本
  full_text: FullTextCounts            # 定义同 2.1.8，按论文，范围是批次成员，读取时现算
  progress: IntakeProgress | None      # 只有 running 的 import 批次有
  estimates: {acquire_pdf: int, parse: int}   # 批次页“接着做什么”的两个预估数
  source_failures

IntakeProgress
  phase: metadata | files | closing    # 书目入库、等待文件、收尾
  processed_items: int
  total_items: int
  files: {uploaded: int, existing: int, conflicts: int, pending: int}
```

- **状态与结果**：
  - 主题发现与引用扩展的批次只用 `running`、`finished`（带结果）与 `withdrawn`。
  - 现有的 `status` 列拆为 `state` 与 `result`：原 `running` 对应 `state=running`，原 `completed`、`partial`、`failed`、`interrupted` 对应 `state=finished` 加同名的 `result`。
  - 界面的状态徽标对已结束的批次显示结果。
- **计数**：`counts` 中新增的四项来自批次条目的结算（[文献与材料 6.4.10](03-literature-materials.md#6410-条目决定文件与报告的字段)）；`needs_metadata` 是成员中带“书目待补”标记的篇数，读取时现算。
- **接着做什么**：两个预估数都只读、现算。
  - `estimates.acquire_pdf` 是用 `AcquirePdfSelector` 的 `query` 范围 `{intake_batch_ids:[batch_id]}` 时的 `process` 数。
  - `estimates.parse` 是同一范围内有主 PDF、还没有当前原始解析的版本数。
  - 对应的操作是现有的获取 PDF 任务与解析任务，范围都是入库批次筛选。它们是任务，不形成新的入库批次；任务的 `scope` 记下所用的 selector，从中能看出是哪个入库批次。

```text
LibraryFacets
  total
  coverage: {tags, keywords, subject_terms}   # 当前结果里有这一层词的篇数
  tags: tuple[{tag_id, value, count}, ...]   # value 为标签当前名称
  keywords: tuple[{value, count, tag: {tag_id, name} | None}, ...]
  subject_terms: tuple[{value, count}, ...]

AcquirePdfSelector =
    {kind: "query", query: LibraryQuery, sort: LibrarySort, limit: int | None}
  | {kind: "literatures", literature_ids: tuple[LiteratureId, ...]}

AcquirePdfCounts
  matched, process, skipped_has_pdf, skipped_unavailable, over_limit
```

- **批次**：每次主题发现、引用扩展各形成一个批次；入库过程的批次在建立时就存在，确认后才接纳成员。CLI 与 stdio 的书目入口同样经入库过程。设备 HTTP 的 origin 为 web，`initiated_by` 区分设备与 local:web/cli/mcp。接口见[入库 HTTP](01-product-interface.md#242-入库-http)，导入规则见[书目交换](03-literature-materials.md#61-书目交换规则)与[入库](03-literature-materials.md#64-入库)。成员与身份发布在同一事务提交；同一篇按 created > enriched > matched 计一次。`counts.hits` 是成员数；`legacy` 批次的 hits 不满足 created + enriched + matched 等式。异常或进程退出的发现批次保留已接纳的成员，结果读作 `interrupted`。列表按 `created_at` 倒序翻页，人工改名为单行 1–120 字。
- **词频**（层次与排列见 [ADR 0053](../decisions/0053-scope-terms-led-by-tags.md)）：对一个 `LibraryQuery` 的全部命中统计标签、作者关键词和主题词，同篇同词计一次，按篇数降序、词升序，每层最多 30 个。
  - 标签只计 `active` 的标签直接标注的篇数，主次都算；`tag_id` 即标签筛选用的 ID。标签筛选包含子标签，所以父标签筛出的篇数可能多于词频。
  - 作者关键词规范化后等于某个 `active` 标签的名称或别名时，`tag` 给出该标签，否则为 `None`。
  - `coverage` 各项是当前结果里至少有一个该层词的篇数，不超过 `total`。
- **PDF 范围**：预览与创建任务使用同一个选择函数。
  - `query`：服务端展开全部命中，不受前端已加载行数限制；先跳过已有主 PDF 的和已标记无法获取的，再按 `sort` 取前 `limit` 篇，其余计入 `over_limit`。
  - `literatures`：调用方明确点名的文献全部处理，包括已有 PDF（重新获取）和已标记无法获取的；`process = matched`，三项跳过都为 0。
  - 成员在创建任务时固定，之后入库的文献不加入。任务保存 `scope: {selector, counts}`，任务列表、详情和运行记录返回同一份；旧任务为 `None`。
- 补形成初稿的维护操作复用 `AcquirePdfSelector`，计数与跳过规则另行规定，见[文档与证据 8.11](04-document-evidence.md#811-补形成初稿的维护操作)。

#### 2.1.7 文本等级与选择校订范围的事实

本节按 [ADR 0060](../decisions/0060-two-level-full-text.md) 规定查询读取中的文本等级，以及 [文档与证据 8.7](04-document-evidence.md#87-选择校订范围的事实) 的四项事实怎样筛选和排序。取值的含义归文档与证据第 8 节；本节只规定字段、位置与查询语义。`citing_results` 与 `unfound_citations` 在加工能读取初稿（计划 16）之前恒为 0。

**共用类型。**

```text
TextLevel = "draft" | "proofread"

DraftFacts
  differs_segments: int      # 取 text-layer-differs 的片段数
  differences: int           # 差异条数
  image_only_pages: int      # image-only 页数
  citing_results: int        # 读取了该初稿、内容未过时的加工结果数
  unfound_citations: int     # 引用该初稿片段、用时核对为“找不到”的值数
```

`DraftFacts` 只对默认文本是初稿的部分给出，其余为 null。各字段的来源与计数口径见文档与证据 8.7。

**作用于哪个部分。** 文献库条目、`LibraryQuery` 的新筛选与 `LibrarySort` 的新排序键都只看主 PDF 这一部分的默认文本，与 `long_document` 相同。补充材料的等级与事实在文献详情和建档状态里按部分给出，不参加文献库的筛选和排序。

**文献库条目（`LiteratureSearchItem`）。** 增加两个可选字段，与 `long_document` 并列：

- `text_level: TextLevel | null`：主 PDF 默认文本的等级；没有默认文本为 null。
- `draft_facts: DraftFacts | null`。

**文献详情（`LiteratureDetail`）。** 继承上面两个字段（主 PDF）。`LiteratureAssetView` 另增加可选的 `default_text`，按部分给出：

```text
default_text: { document_version_id, text_level: TextLevel, draft_facts: DraftFacts | None } | None
```

PDF 部分没有默认文本时为 null；非 PDF 资产没有这个字段。

**建档状态（`ArchiveState`）。** `parts[]` 的每一项增加 `text_level: TextLevel | null` 与 `draft_facts: DraftFacts | null`，与该项的 `long_document`、`document_version_id` 并列，描述同一个默认版本。顶层表示主 PDF，与现有 `long_document` 的规则相同。

**`LibraryQuery` 的新筛选。** 全部可选，省略表示不筛选：

| 字段                    | 类型                    | 匹配                                                                              |
| ----------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `text_levels`           | `tuple[TextLevel, ...]` | 主 PDF 默认文本的等级在其中，内部 OR；没有默认文本的文献不匹配；空 tuple 等同省略 |
| `has_draft_differences` | `bool \| None`          | true：主 PDF 默认文本是初稿且 `differs_segments > 0`；false：是初稿且为 0         |
| `has_image_only_pages`  | `bool \| None`          | 同上，按 `image_only_pages`                                                       |
| `cited_by_results`      | `bool \| None`          | 同上，按 `citing_results`                                                         |
| `has_unfound_citations` | `bool \| None`          | 同上，按 `unfound_citations`                                                      |

- 后四项为 true 或 false 时都只匹配主 PDF 默认文本是初稿的文献；默认文本是校订稿或没有默认文本的文献两种取值都不匹配。
- 字段之间仍是 AND。省略的字段不进入规范化的查询，所以已有请求、cursor、`QuerySelector` 与任务里保存的 selector 的字节都不变。

**`LibrarySort` 的新排序键。**

| 键                       | 主排序                                             |
| ------------------------ | -------------------------------------------------- |
| `draft-differences-desc` | `differs_segments` 降序，相同时 `differences` 降序 |
| `image-only-pages-desc`  | `image_only_pages` 降序                            |
| `citing-results-desc`    | `citing_results` 降序                              |
| `unfound-citations-desc` | `unfound_citations` 降序                           |

- 主 PDF 默认文本不是初稿的文献没有这些值，排在有值的文献之后，与缺年份的规则相同。最后都用 `literature_id` 打破并列。
- cursor 与规范化 query、sort 和稳定位置绑定，规则同 2.1.2。事实在两次翻页之间可能变化，后续页按当时的事实读取。
- 凡是接受 `LibrarySort` 的地方（例如 `AcquirePdfSelector` 的 `query` 范围）都接受这些键，含义相同。

**查找命中。** 材料 Context 与混合 Context 的 `MaterialContextItem` 增加可选字段 `text_level`：`kind = "source-text"` 时为命中片段所在固定版本的等级；`kind = "metadata"` 时没有这个字段。它来自命中已核验的固定版本，不来自索引条目；索引条目与游标不变。

**一致性。** 同一次读取中，条目、详情、建档状态和命中的 `text_level` 与 `document_version_id` 来自同一个只读快照，与默认关系一致，规则同 2.1.3。

#### 2.1.8 文献库计数与全文取得情况

`LibraryCounts` 是文献库计数的读取结果。CLI 为 `literature counts --request FILE`，MCP 为 `library_counts`，HTTP 为查询路径 `library-counts`；请求是 `{query: LibraryQuery}`，三者共用同一合同。合同的边界解析在 `packages/contracts/src/library-counts.ts`。

```text
LibraryCounts
  total: int                      # 范围内的具体版本数
  statuses: {LiteratureStatus: int}   # 六种状态各多少个版本，合计等于 total
  unavailable_pdf: int            # 状态为 UNREVIEWED 且有自动 PDF 获取耗尽事实的版本数
  recently_opened: int            # 范围内最近 30 天打开过的版本数，最多计到 100
  with_primary_pdf: int           # 有主 PDF 的版本数，供快速筛选“有 PDF”；“仅元数据”为 total − with_primary_pdf
  full_text: FullTextCounts       # 见下文
  status_updating?: true          # 标签上限或建档方式改变后，状态正在后台重算；重算完后省略
  count_truncated?: true          # 有筛选或搜索且命中超过 10,000 个版本时出现，各数只算到 10,000（显示“1 万以上”）
  counts_backfill_pending?: true  # 迁移后的计数器回填尚未完成
  collection_counts?: {collected: int, discovered_only: int}  # 全库收进来与只被发现的版本数

FullTextCounts
  total: int                      # 范围内的论文数
  obtained: int                   # 已取得全文的论文数
  missing: int                    # 未取得全文的论文数
  exhausted: int                  # missing 中自动途径已试完的论文数
```

**范围。** 计数的范围是请求的 `query`，但忽略其中的 `statuses` 与 `needs_manual_pdf`：它们是文献库的快速筛选，计数要给每个快速筛选显示数字，所以不受当前选中的快速筛选影响。其它条件都生效。范围为空时各数为 0。

**状态计数。** `total`、`statuses`、`unavailable_pdf`、`recently_opened` 与 `with_primary_pdf` 按具体版本（`Literature`）计，与列表的单位相同（[2.2.1](#221-libraryquery-与结果单位)）。同一篇论文的预印本与正式版各计一次。

**全文取得情况。** `full_text` 回答需求[收2](../requirements.md#收2-取得全文)“多少已经取得，多少还没有，其中多少已经试完了自动途径”，按论文计：

- **单位是论文，不是版本。** 一篇论文就是一个 `MetaLiterature`，它的几个版本只计一次（需求[收4](../requirements.md#收4-规模与持续积累)：一个版本达到目标即可）。论文在范围内，当且仅当它至少有一个版本命中 `query`。判断是否取得、是否试完时看这篇论文的全部当前版本，不只看命中的版本；取法同 `selectionSnapshot` 的 matches 与 members（[2.2.1](#221-libraryquery-与结果单位)）。
- **已取得（`obtained`）**：至少一个版本有主 PDF。之后处于什么状态都算：等待解析或建档、建档中、建档失败、就绪，以及 `EXCLUDED`。被排除的论文仍有它的全文。
- **未取得（`missing`）**：没有一个版本有主 PDF。
- **已试完（`exhausted`）**：`missing` 中，每个版本都有自动 PDF 获取耗尽事实的论文（耗尽事实的成立条件见[文献与材料 4.5](03-literature-materials.md#45-获取流程)）。它是 `missing` 的一部分，不是第三类。
- **关系**：`total = obtained + missing`，`exhausted ≤ missing`。“还可以再试”是 `missing − exhausted`，入口可以这样显示，合同不另设字段。
- **与状态计数的关系**：状态计数按版本，`full_text` 按论文，两者不能相加相减。例如一篇论文的预印本是 `UNREVIEWED`、正式版是 `READY`，状态计数里两个版本各计一次，`full_text` 里这篇论文只计一次，算已取得。

**计数器与截断。** 没有筛选，或只按收进来筛选时，各数来自写入时维护的计数器，读取是常数级；计数器与文献状态在同一事务里增减，其他写入者的变更由触发器记下、后台按变化量改正，等待改正期间从同一快照精确计算。有筛选或搜索时，计数与分面取到第 10,001 个命中即停：超过时带 `count_truncated`，分面带 `facets_truncated`，表示分面的覆盖与排名来自前 10,000 个版本；全库与收进来的总数仍准确（[ADR 0065](../decisions/0065-scale-rules.md) 第 6 节第 2 条）。

**准确数。** `LibraryExactCountRequest {kind: "counts" | "search-total", query} | {kind: "facets", query, limit}` 在长请求道上用一个读快照算出准确数，可取消，返回 `snapshot_at` 与对应结果；每次请求重新计算，不缓存。HTTP `/api/v1/query/library-exact-count`、CLI `literature exact-count`、MCP `library_exact_count` 共用这个合同。

**一致性与只读。** 同一次读取的全部数字来自同一个只读快照。计数不联网、不调用模型、不创建任务，不写库（规1）。这些数是查询时的聚合，不另存（[存储 2.3.6](07-versioned-storage.md#236-有意保存与有意推导)）。

**筛选“有主 PDF”。** `LibraryQuery.has_primary_pdf` 为 true 时只匹配有主 PDF 的版本，为 false 时只匹配没有主 PDF 的版本，null 或省略时不筛选。它按版本，与列表的单位相同。省略时不进入规范化的查询，已有请求与 cursor 的字节不变。文献库从“全文取得情况”一行跳到列表时用它（[页面规格“文献库”](../web/page-specs.md#文献库)）；列表按版本列出，所以条数可以多于对应的论文数。

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

### 2.4 规模与目标耗时

规模规则、人与 Agent 的分工和各处做法见 [ADR 0065](../decisions/0065-scale-rules.md)；工作集与“收进来的文献”的含义见该 ADR 第 2 节。下表是目标耗时，在一百万篇书目（其中十万篇有全文）的合成库上、同时每秒写入 100 篇时测量；一千万篇的压力检查中，各项不超过表中的 2 倍。

| 操作                                     | 目标                                        |
| ---------------------------------------- | ------------------------------------------- |
| 文献库首页第一屏                         | ≤ 1 s                                       |
| 全库的几项总数                           | ≤ 0.2 s                                     |
| 工作集内的筛选、计数与翻页               | ≤ 1 s                                       |
| 搜索（任何查询，相关度前 1,000 条）      | ≤ 1.5 s                                     |
| 运行中任务的详情（包括进程重启后的首读） | ≤ 0.5 s                                     |
| 搜索索引落后于写入                       | ≤ 2 分钟                                    |
| 另一进程持续写入时，一次写入等到写许可   | ≤ 1 s                                       |
| 持续大批入库同时有后台回填               | 入库 ≥ 每秒 80 篇；回填耗时 ≤ 空闲时的 5 倍 |

超过一万篇的工作集，计数按 10,000 截断，排序只提供 ADR 0065 第 6 节第 3 条列出的几种。搜索的耗时按固定命中数在两种规模上对比，另有一项几乎全库都命中的查询，也须达到上表的目标。任务详情的耗时按任务大小分档测，不与库的大小对比。打开 PDF 的目标见[阅读体验](../web/reading-experience.md)的验收表。现状与这些目标的差距及处理见[计划 26](../../plans/2026-11-21-library-scale/README.md)。

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

`ready` 表示当前受支持布局可被读取，不是全库健康认证。缺库/真正空库返回 not-initialized，配置或未知布局返回 unavailable；SQLite 报告的真实损坏按[存储完整性验证](07-versioned-storage.md#5-存储完整性验证)返回明确错误与完整检查提示。已打开库的索引或对象错误在实际读取时失败。存在未恢复的 Job、receipt 或回收票据不自动改变它们，也不阻止其它完整已提交资料读取。

CLI `literature search/show/references/cited-by` 与 `export metadata/pdf/content` 使用此图。缺库时退出码 3、code=query-not-initialized，不再隐式建库；已初始化库上的原结果与导出格式保持。导出副本是用户明确请求的文件副作用，不是扩库。

#### 3.2.2 HTTP 与生命周期

`startQueryOnlyWorkbench({ home, port? })` 组装独立阅读页，默认加载安装包中的 query.html/query.js。GET `/api/v1/query/status` 返回 readiness；POST `/api/v1/query/search|read|references|reference|artifact` 使用 `{ protocol_version: 1, request }`。未知输入被拒绝；缺 PDF/内容返回 gap，传输或索引错误不得伪装成空结果。

独立只读 SDK 服务仅监听 loopback 并检查 Host/Origin；它不接纳设备令牌。正式 Web 的设备用途准入由[设备连接](01-product-interface.md#241-设备连接与按用途准入)统一拥有，未登记的既有检索接口不因 read 用途而自动开放。详情请求只接受稳定 ID，artifact只接受ID与已定义kind，不能从远程参数读取任意本机路径。关闭先停止新HTTP请求/结束响应流，再释放QueryApplication；CLI的operation/cleanup同时失败保留两项cause，stdout不输出原始异常或secret。

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

显式整代重建采用固定输入范围、构建新 generation、完整校验和原子切换指针；发布后自动刷新则在 active generation 内逐篇接纳变化。两者的写入、源变化处理和校验边界见 [4.9](#49-材料-context-的实现边界)。继续 cursor 固定查询、范围、generation 与已接纳 source revision；任一身份变化须重新查询，不偷偷换页序。

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

当前 QueryApplication 为普通材料／库读取和检索各持有一个只读 SQLite worker；材料与知识检索共用后者，数量不随请求增加。冷检索和 `data_version` 变化后的首次读取都只做固定大小的身份/布局检查，不运行全库健康检查；具体检查和维护边界见 [4.9](#49-材料-context-的实现边界)。应用关闭先 drain 两个 Context service，再关闭检索 worker 和材料 reader；启动失败复用同一清理路径。维护 Application 为索引构建持有一个独立 SQLite worker，避免整代完整性检查的同步工作堵住建档普通读写队列；全部 generation/repair 状态留在这个连接，共享 catalog 写入 admission，批量写入仍按同一规则串行。HTTP 取消不终止共享 worker，已发送的同步 SQLite 工作仍需结算。

一次读取内部使用已提交 snapshot 和固定 artifact 引用，不混合两个 current 版本。跨页是否固定数据库 snapshot 取决于协议；现有 Library 分页只保证单页一致，新协议若固定索引 generation也不能假称底层业务永不变化。

取消停止继续扫描和资源展开；已交付的读取片段无需回滚。读失败与数据库不可用不能当成零结果。重复查询通常不要求 durable 幂等键；响应变化可来自新的显式维护提交，结果应带版本和覆盖以供识别。

目标耗时见 [2.4](#24-规模与目标耗时)。材料检索的相关度续页同样止于前 1,000 条，实际截断时回执带 `relevance_limit: 1000`，混合 Context 透传材料分支的这个字段。实现需有候选扫描上限、有界片段读取和可解释截断；性能评估区分 FTS 候选时间、源内容验证、资源读取与组装成本，避免每次查询读全库所有 artifact。

### 4.7 当前入口与目标映射

当前 `createQueryApplication(home)` 返回本地只读用例、artifact reader、readiness 和可重复关闭的生命周期。CLI 查询与 `startQueryOnlyWorkbench` 消费它；混合工作台仍可持有完整 Application，不能混为同一个隔离证明。

`/api/v1/query/status` 与 search/read/references/reference/artifact 服务于 Library 合同；`/api/v1/query/context` 服务于已实现的 `MaterialContextRequest`，不接受本节仍属目标的 KnowledgeQuery/manifest/knowledge 类型。旧 `LiteratureSelector.kind = "query"` 仅是明确维护任务的目标选择器，不是读取时创建任务的许可。

新增上下文能力应扩展只读对象图与版本化协议，不从 QueryApplication 取完整 Application 再“约定不用 writer”。公共包、HTTP、CLI 和人类页必须共用事实 owner，不能分别实现一套搜索结果解释。

### 4.9 材料 Context 的实现边界

`retrieval-context.ts` 定义 `MaterialContextRequest/MaterialContextBundle`，固定查询、范围、类型、版本、字节预算与续读位置。当前无 tokenizer；请求与使用方式见[读取指南](../../guides/library-query.md#上下文检索)。

材料投影使用当前 schema 的 `retrieval_*` 表，保留元数据和全部已接纳固定文档版本，默认文档与显式历史版本仍分别筛选。没有新增表、schema 版本或自动迁移。索引是可重建投影，不成为正文或元数据的事实来源。初稿进入索引、命中带 `text_level` 见 [2.1.7](#217-文本等级与选择校订范围的事实)。

**读取**：`active()` 只读单例指针和 ready generation 的标量计数；不逐项重数 entries/FTS。冷连接和外部 `data_version` 变化后的重连只核对 schema identity、固定数量的 retrieval DDL 与触发器、active 是否存在且 ready、已知损坏标记和 source revision。查询不运行 PRAGMA integrity_check/foreign_key_check、FTS integrity-check、整份哈希或来源指纹扫描。普通打开、Web 初始化探针、显式目录库核验与真实损坏错误的规则归[存储技术篇](07-versioned-storage.md#5-存储完整性验证)。显式 `storage retrieval-inspect` 仍保留完整检查，不由搜索触发。

源 revision 与 active 的 source_revision 不同时，仍检索 active，coverage=index-stale 可以携带 items、gaps 与 continuation；没有 active 才是 index-unavailable。回执 source_revision 是当前源水位，可选 indexed_revision 是实际检索代的水位，两者之差不是文献篇数。命中逐篇核对身份、元数据 revision/hash、固定文档/资产与默认选择；来源已变化的命中跳过，继续寻找下一条有效命中，以带 literature_id 的 index-stale gap 说明。gap 仍最多 32 项，超出时按原因归并为 literature_id=null，不因一篇过时材料放弃其它命中。全库材料缺口只查询存在性，不把全部文献行加载到宿主。

发生真实 SQLite/FTS 读取损坏或已经由显式维护确认损坏时，返回 index-corrupt，并带可选 `maintenance_hint="rebuild-index"`。查询不为了发现尚未触达的静默损坏而扫描全库；版本/指纹未变化但固定字节损坏的错误仍保留，不能用“索引落后”掩盖真实来源完整性失败。

**逐篇增量刷新**：影响索引的写入由库里的触发器在同一写事务里把文献 ID 追加进变更表 `retrieval_changes`（位置递增），任何写入者都会被记下，包括直接 SQL、撤回、恢复与删除。`refresh()` 固定变更表的尾位置与源 revision，只读取已处理位置 `retrieval_change_state.processed_position` 之后的变更，逐页合并重复的文献 ID，耗时与变化的篇数成正比；服务启动时不做全库比对。每篇先比对来源的标量指纹，不读正文或 FTS 倒排。指纹为 Literature/Meta 身份、metadata_revision/sha256，以及每个文档的 version、representation、源资产/hash 和 is_default。仅变化、删除或失去来源的 Literature 进入处理；它的元数据与固定文档重新核验并按原规则分块，未变化的文献不读取正文、不重写条目。每篇先借现有 building generation 暂存，每批最多 128 条或 1 MiB，沿用 catalog admission；扫描、文件读取和宿主计算不持有业务写锁。索引内容与变更表的已处理位置在同一事务里推进，中断后从已处理位置继续，不丢不重；已处理的前缀分批删除。已处理位置为空表示迁移后尚未做全量比对，此时刷新返回 `index-reconcile-required`；全库比对只用于这一步、显式重建与 `verify`。

单篇接纳事务重新比较该篇来源指纹；匹配才删除旧的该篇条目并将暂存条目归入 active，按差额更新计数，不切换其它文献。指纹改变只丢弃并重做该篇。后到的新发布导致一次新的轻量比对，已接纳且未再变化的文献保留，不因全局 revision 变化而整批作废。源消失时移除它的旧条目；关闭/取消保留已提交文献，清理未接纳暂存。generation 锁约束刷新、重建与验证，同一 catalog 一个处理者。

全部变化都追上同一 source watermark 后，短事务才将 active.source_revision 推进到该值。分批期间每篇接纳仍原子完成，查询以落后覆盖返回可验证的命中。游标 v3 固定查询、active generation、水位及 state_token；state() 在同一读取快照中仅以代头标量形成 token，不扫描条目。每篇接纳事务使无效证书中的 posting 标记变化，即使水位/条数不变也使旧 token 失效；查询结束再核对 token，变化时返回 context-cursor-invalid。单独的源写入不会作废尚未变更的 active 游标，完成刷新或显式验证改变代状态则要求重新查询。旧 v2 游标返回相同的重新查询错误；不新增 schema 列或迁移。

**显式重建与验证**：`build()` 始终完整读源、创建新 generation，保留原整代校验/CAS；不复用旧 FTS 文字。`verify()` 逐篇从源重算预期条目，与 active 的条目和文字逐项比较，再执行 SQLite/外键健康检查、FTS integrity-check 和整份内容/倒排哈希。成功返回 `IndexVerificationResult {schema_version:1,status:"verified",generation_id,source_revision,entry_count,source_count,elapsed_ms}`。完整哈希扫描在业务写入 admission 外形成有界证明，最终短事务复核数据版本并保存证书；期间有来源或索引变化返回 index-stale，不把并发变化误标为损坏。

**退役代回收**：成功切换 active 后，以及下一次增量刷新比对来源前，持 generation 锁清理全部非 active 代，包括旧 ready 代与中断遗留的 building 暂存；当前结构不保存 failed 状态。每个事务通过 catalog admission 最多删除 128 个条目及对应 FTS 行，并以 1 MiB 原 FTS 文字为批次目标；单条超过目标时独立处理以继续进展。每批重读 active 并拒绝删除它，批次间释放写入 admission；只有条目清空才删除代头，不用一次外键级联删除整代。取消保留已提交回收；已经发布的 active 不撤销，剩余旧代下次刷新续清。回收不改变源 revision，也不自动 VACUUM；释放的页供 SQLite 复用。

候选读取将 active 身份核对与 FTS 查询固定在同一个 SQLite 读取快照，WAL 读者可完成已开始的快照。候选请求的 generation 已失效、或组装完成前 active 身份变化时，返回 context-cursor-invalid，要求重新查询；旧 continuation 不依赖旧代继续存在。完整检查仍覆盖全库 SQLite、外键、FTS 物理结构和孤立 FTS 行；计数与内容/倒排证书只核对 active，部分回收的退役代不再作为可读投影核验。

增量修改会使上一份整代哈希证书失效：content_sha256 的全零保留值表示证书不再对应当前投影，此时 posting_sha256 只承载每次接纳变化的非秘密失效标记，不声称是倒排哈希。完整检查回执 `hashes=not-current`，不能当作正文已经全量核实。显式完整核验通过后将两个字段写为真实证书，`hashes=verified`。维护确认损坏时在 posting hash 保存专用保留标记，供读取常数级拒绝；重建后清除。静默删行或改字并不保证在下一次 MATCH 中立即触发 SQLite 错误，必须由显式 verify 检出，不能恢复搜索前的全量扫描。现有 `storage retrieval-inspect` 保留结构/计数/已有证书检查；核对来源正文使用 verify-index。

**后台调度与状态**：拥有 IndexRefreshService 的 Application 在启动时核对源与 active 水位，运行中每 5 秒再核对；其自身的 indexRefreshStatus 读取也触发同一有界核对。这只读单例和代头，不扫描来源指纹。发现落后或有源而尚无索引时，将请求并入同一持久队列；因此入库、元数据编辑及其它受触发器覆盖的变更不依赖下一次文档发布。文档发布仍显式 schedule 并返回 index_status=scheduled，建档与 READY 不等索引。100 ms 合并窗口只保留最新目标，重复水位不重复排队；真正执行 refresh 时才比较标量指纹，内容未变则直接推进水位。5 秒是检测间隔，不是大规模刷新完成时间上限。

临时的 generation 写入竞争保留 scheduled 并按检测间隔重试；重试定时器在写入准入作用域外创建，不能继承已结束的准入能力。显式 rebuild 与后台刷新共用工作者锁，不互相抢占。其它相同输入的重复失败不循环执行，失败可见且保留已接受文献；新来源或显式维护可重试。关闭停止监测、保留未完成请求，下次 Application 恢复。QueryApplication、只读 CLI/MCP 查询及其 index-status 不启动或排队刷新；Web 由它持有的 Application 监测追赶，不把写入职责放进查询连接。

状态保存在 `<catalog>.index-refresh.json`，属于非秘密的可重建投影队列，不是资产、配置或业务事实。继续要求当前用户 0600 普通单链接文件，拒绝符号链接，独立短锁及 fsync/rename 保证原子替换；worker 锁和 catalog admission 分开。原状态 idle/scheduled/running/updated/failed、request_sequence、requested_revision、indexed_revision、三个时间戳与 technical_details.code 保留。可选 `pending_literatures` 是最近一次指纹比对后尚未接纳的篇数，新请求未比对时为 null；`last_refresh_ms` 是最近一次已结算刷新尝试的墙钟耗时，含失败/取消，不含队列等待。状态读取不重新比对来源，也不能把源水位差当作篇数。旧状态文件没有新增键仍可读。

index-status 另有三个可选字段。`index_state=ready|missing|corrupt` 在读取时以 active 指针、ready 状态、已知损坏标记和固定布局检查派生；ready 不表示已经追上源，也不表示已做完整校验。`operation=refresh|rebuild|null` 是当前执行或最近结算的操作，无历史为 null；仅排队时保持最近操作，执行开始才切换。`progress={done,total}|null` 只记录重建已处理/总来源数，来源为每篇 metadata 与每个固定文档版本，不是 FTS 分块数。来源处理完仍可能在写入、校验、发布或旧代回收，不能把 done=total 当成任务已完成。进度约每 250 ms 更新并在末尾结算；增量刷新 progress=null，沿用 pending_literatures。

显式增量刷新和后台重建共用持久队列与工作者锁。sidecar 的私有 rebuild_requested/rebuild_settled 记录最新重建意图与已结算序列，不进入 IndexRefreshStatus；旧 sidecar 缺这些字段仍可读。它们区分正在执行的操作和排队意图，保留重建期间的新请求，并使取消/进程关闭后的重建下次继续按重建执行。已结算的失败不会无限重建；显式新请求可重试。请求在通过认证并持久接纳后属于 Application，浏览器连接断开不取消；关闭 Application 则停止本次执行并保留未完成意图。

| 动作          | HTTP                                                               | CLI                       | MCP                                |
| ------------- | ------------------------------------------------------------------ | ------------------------- | ---------------------------------- |
| 读取状态      | POST /api/v1/query/index-status，request `{}`                      | maintenance index-status  | index_status                       |
| 增量刷新      | POST /api/v1/maintenance/index-refresh，request `{kind:"refresh"}` | maintenance refresh-index | refresh_index                      |
| 完整重建/修复 | POST /api/v1/maintenance/rebuild-index，request `{kind:"rebuild"}` | maintenance rebuild-index | rebuild_index                      |
| 后台重建      | 同上，request `{kind:"rebuild",background:true}`                   | 使用同步重建命令          | rebuild_index，`{background:true}` |
| 完整核验      | POST /api/v1/maintenance/verify-index，request `{kind:"verify"}`   | maintenance verify-index  | verify_index                       |

HTTP 继续使用 protocol_version=1 封套和现有维护认证/Origin/CSRF。增量刷新和后台重建立即返回 IndexRefreshStatus，后续通过 index-status 读取进度；不带 background 的同步重建继续返回原 generation receipt，并可由请求取消。CLI refresh-index 等到队列结算后返回状态，失败输出同一状态且退出码 3；MCP refresh_index 立即返回排队状态。显式成功重建清除失败，验证不自动修复源或投影。其它短命进程退出时可留下已接纳请求，由长驻 Web 或下一次 Application 续跑。scheduled 只表示排队事实，不承诺固定完成时间。

### 4.10 处理器结果与混合 Context

`knowledgeContext` 将材料 Context 与已发布处理器结果合并。原始文档和生成结果明确区分；固定结果及上游依赖通过 `processorRead` 核验，来源缺失、损坏、过时与未命中分别表达。覆盖、排序、预算及继续位置规则见本节前述合同；score 不表示科学可信度。

混合读取的材料分支落后时，`KnowledgeContextBundle.coverage=index-stale`，仍可包含材料命中、已核验的算子结果及 continuation；不降成普通 partial，也不丢弃整页。`gaps` 保留材料返回的逐文献 index-stale 缺口，并给出 `material-index-stale` 汇总；重复项去重，超过 32 项时按原因归并为 literature_id=null。合同以该汇总标记核对落后覆盖，继续严格验证固定引用、范围、真实回执字节、条数及 truncation/continuation。材料不可用/损坏与算子结果自己的缺口仍分别保留，不把它们伪装成普通落后。材料失效命中的跳过与证据验证复用 [4.9](#49-材料-context-的实现边界)，不建立第二套来源校验。

混合游标 v2 绑定请求和 active 的同一 state_token，包裹材料续页与算子结果的固定水位/位置。材料分支读完后，后续只含算子结果的混合页仍以常数级标量探针核对 active；增量接纳或切代后返回 context-cursor-invalid。旧混合游标同样要求重新查询。请求 kinds 只有 knowledge 时不检索材料，也不受材料索引落后影响，继续使用算子结果自身的固定水位。HTTP knowledge-context、CLI context knowledge 与 MCP search_context(kind=knowledge) 共用此服务；CLI 文本提示落后，JSON 回执保持纯机器封套。

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
