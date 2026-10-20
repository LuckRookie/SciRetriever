# 03 · 文献与材料技术设计

[设计总览](../design.md) · [八模块技术导航](../technical.md)

本模块对应设计中的 **③ 文献与材料**，交付身份与来源清楚的文献记录，以及经过文件和文章归属验收的原始材料。

内部划分为 Metadata 元数据来源、Literature 文献管理、Acquisition 材料获取。前者提供 observation，文献管理裁决身份和书目事实，获取子模块裁决资产接纳；⑦执行持久化。需要页面操作时调用⑧，取得材料后向④⑤⑥交付稳定引用。

获取成功不以分析完成为前提。来源错误、运行失败与正常耗尽分别表达，后续分析不适用不授予删除材料的权限。旧 completion 清理行为在对应兼容小节说明。

> 2026-10-20：[ADR 0037](../decisions/0037-literature-archive-and-proofread-text.md)（Accepted，2026-10-20）将拆分元数据的文献类型、按字段记录来源与锁定，并以六种状态取代三级状态。目标形态见[§8](#8-adr-0037-目标形态元数据字段与文献状态实施中)，实施见[文献建档计划](../../plans/2026-10-20-literature-archive/README.md)。实施完成前，下文仍描述现行合同与实现。

本篇目录：

- [1. 模块边界与连接](#1-模块边界与连接)
- [2. 文献身份、元数据与引用](#2-文献身份元数据与引用)
- [3. 元数据来源与供应商适配](#3-元数据来源与供应商适配)
- [4. 材料获取、路线与候选](#4-材料获取路线与候选)
- [5. 资产验收、发布与有效性](#5-资产验收发布与有效性)
- [6. 书目交换与持久化协作](#6-书目交换与持久化协作)
- [7. 材料与文献验证](#7-材料与文献验证)
- [8. ADR 0037 目标形态：元数据字段与文献状态（实施中）](#8-adr-0037-目标形态元数据字段与文献状态实施中)

## 1. 模块边界与连接

任务② → 本模块；按需使用浏览器⑧，经存储⑦发布；文档④、知识⑤和查询⑥读取稳定材料引用。

本篇按职责归并已有详细合同；示例中的现有类型与目标类型保持各自状态。文档归属不改变源码目录、事实所有权或当前公开 API。

## 2. 文献身份、元数据与引用

### 2.1 文献身份与知识产物的责任分离

按 [ADR 0026](../decisions/0026-agent-knowledge-and-human-collaboration.md)，Literature 继续拥有身份、版本、来源元数据与权威引用；[文档与证据：可读表示与有界读取](04-document-evidence.md#3-可读表示与有界读取)拥有表示/定位，Analysis 拥有新知识产物的解释与验收。各自都通过统一 Storage 保存确认事实，不复制第二份文献身份。

以下三级状态和单一 LiteratureContent 为当前 TS 兼容合同；新材料/分析的可用性、用途、覆盖和有效性需从对应事实投影，不能用 CONTENT_READY 穷尽一切，也不预先改写已有数据。新知识引用不直接套用旧 ReferenceSupport 清理策略。分析不适用不授权删除材料。

### 2.2 结构与实现映射

当前活动实现位于 `apps/server/src/literature/`，跨模块合同来自 `packages/contracts`。当前文件按源码导出和测试为准，例如 `identity.ts`、`identity-rules.ts`、`metadata-rules.ts`、`content.ts`、`state.ts`、`query.ts`、`bibliography.ts` 和 `artifacts.ts`。

`LiteratureIdentityService` 执行身份接纳，`LiteratureQueryService` 组装只读投影，`LiteratureArtifactService` 通过验证读者交付字节，`LiteratureContentService` 执行旧内容的原子接纳。引用 publication 和 SQLite事务由消费方Port与Storage adapter连接；没有新增独立文献库。

### 2.3 MetaLiterature 与 Literature

`MetaLiterature` 表示同一文献多个明确版本的稳定聚合身份；`Literature` 表示可以独立拥有 `LiteratureMetadata`、PDF 和 `LiteratureContent` 的具体、可引用文献。

预印本、作者接受稿和正式发表版只有在来源 observation 存在明确同文献版本连接时才共享 `MetaLiterature`，且始终保留为不同 `Literature`。不同 Literature 的元数据、资产和内容不能混合。

精确主体合同为：

```text
MetaLiterature
  meta_literature_id: MetaLiteratureId
  representative_literature_id: LiteratureId

Literature
  literature_id: LiteratureId
  meta_literature_id: MetaLiteratureId
  version_role: VersionRole
  metadata: LiteratureMetadata
  status: LiteratureStatus

VersionRole = "published" | "accepted-manuscript" | "preprint" | "other"
LiteratureStatus = "UNREVIEWED" | "ASSET_READY" | "CONTENT_READY"
```

`MetaLiterature` 只聚合，不拥有元数据、标识符、PDF、`LiteratureContent`、状态、observation 或关系列表；这些事实均归属具体 `Literature`、来源 observation 或权威 Reference。每个 `Literature` 从创建开始必须且只能属于一个 `MetaLiterature`。第一个 Literature 与其 MetaLiterature 原子创建，并成为必填的代表 Literature；代表 ID 必须始终指向该 MetaLiterature 的成员。

成员关系只由 `Literature.meta_literature_id` 保存，`MetaLiterature` 不重复维护 `literature_ids`。需要查看全部成员时由 read model 反向查询，不形成第二份可变成员事实。只有来源 observation 中明确的 `version_links` 才能让不同 Literature 共享一个 MetaLiterature；引用、更正、撤稿或模糊相似性不触发聚合。共同的 `meta_literature_id` 和各自 `version_role` 已经完整表达版本聚合，不建立独立 `LiteratureRelation`。

`Literature` 是具体、可独立拥有内容的文献版本。`metadata` 必填，表示系统当前接纳的统一初始或最终 `LiteratureMetadata`；标题、标识符等字段不在 Literature 顶层重复。`status` 是当前读取视图中的派生值，不作为可独立写入的状态事实。Observation、资产、轻结构化文档和引用均通过 `literature_id` 关联，不嵌入基础 Literature 对象。

代表 Literature 的默认顺序为：

```text
正式发表版（`published`）
  > 作者接受稿
  > 预印本
  > 其它已确认版本
```

代表 Literature 变化只影响 `MetaLiterature` 聚合视图，不删除其它 Literature，也不转移或覆盖其它版本的元数据、资产和内容。`published` 明确表示正式发表版本，替代含义不清晰的旧名称 `formal`；版本角色不能根据 `document_type` 或 URL 猜测，来源没有可靠证据时使用 `other`。

`MetaLiterature` 不拥有或持久化 `status`。查询可以从成员 current facts 推导“是否至少有一个成员达到 ASSET_READY/CONTENT_READY”；这个聚合视图只服务查询和 Entry 的运行时目标排除。普通范围的具体版本候选由 Entry 在当前进程内冻结，排序先复用成员完成度，再使用上述版本角色顺序；成功事实仍归具体 Literature。Literature 模块只提供一致成员事实和纯读取投影，不把内存候选变成第二份成员或状态事实。

### 2.4 身份收敛

> ADR 0037：严格后备匹配中的 `document_type` 改为出版形式；后备身份索引随迁移重算。见[§8](#8-adr-0037-目标形态元数据字段与文献状态实施中)。

#### 2.4.1 文献标识符与 Provider 记录身份

Literature 只消费已经由 `Identifier` 公共 Model 形成的 canonical `(namespace, value)`，不在身份函数中再次解析 URL、前缀或大小写。当前明确规则为：

| namespace            | canonical value                         | 身份含义                                                       |
| -------------------- | --------------------------------------- | -------------------------------------------------------------- |
| `doi`                | 小写裸 DOI，例如 `10.1021/jacs.5c20087` | 当前具体 Literature 的稳定标识符                               |
| `arxiv`              | 不带 `vN` 的官方新式或旧式基础 ID       | 当前预印本 Literature 的稳定标识符；revision 不另建 Literature |
| `pmid`               | 官方纯数字                              | 当前具体 Literature 的稳定标识符                               |
| `pmcid`              | 官方大写 `PMC` 加数字                   | 当前具体 Literature 的稳定标识符                               |
| 其它受支持 namespace | 经过已明确、可测试的官方格式转换后的值  | 只有官方语义确实标识当前具体 Literature 时才参加身份收敛       |

未知 namespace 的 value 只经过边界空白清理，不推测大小写、分隔符或前缀语义；在其官方身份含义和 canonicalizer 被明确前，Literature 不能据此进行跨来源自动合并。ISBN、ISSN 等未来或当前支持的其它值也必须按各自官方规范建立显式、独立且有 fixture 的纯转换，不能套用 DOI 小写、去标点或其它全局规则。

OpenAlex Work ID、Web of Science UID、Semantic Scholar Paper ID、Scopus EID 及其它供应商数据库记录 ID 不属于上述集合。当前 observation 自己的记录 ID 进入 `Provenance.source_record_id`，关系或版本端点的记录 ID 进入 `ProviderLiteratureKey.record_id`；二者保留供应商官方格式，只能在父 Provenance 的 provider scope 内定位记录，不能进入 `LiteratureMetadata.identifiers` 或参加跨供应商 Literature 标识符匹配。重复的同一 Provider record 可以通过既有 observation 归属幂等命中，但不能因此把不同 Provider 的记录 ID 当作同一文献。

#### 2.4.2 同一 Literature 的判定

接纳一条 observation 时，Literature 在同一数据库 snapshot 中按以下顺序形成决定：

1. 用每个 canonical 文献 identifier 精确查询已有 Literature；
2. 所有已命中的标识符只指向一个 Literature，且 incoming 与该 Literature 的身份型稳定标识符不存在冲突时，命中该 Literature；一条可信 observation 同时携带多个非冲突稳定标识符时，这些值共同描述该具体 Literature；
3. 至少一项身份型稳定标识符指向同一对象、同时另一项身份型稳定标识符明确指向不同值或不同对象时，返回稳定 `identity-conflict` 接纳失败，不选择任意一项继续，也不创建版本关系；
4. 双方都没有稳定文献标识符时，才计算标题、完整作者顺序、发表年份和 `publication_form` 的严格复合后备键；四项必须全部存在且完全一致；
5. 没有精确命中且不存在自相矛盾的身份证据时创建新的 Literature；不同 DOI 因此默认形成不同 Literature，即使标题、作者或年份相同。

标题和每个 `Author.display_name` 的比较键固定为：Unicode NFC、去除首尾空白、把连续 Unicode 空白合并为一个空格，再执行 Unicode casefold。作者部分是上述结果组成的有序 tuple；不删除或统一标点、连字符，不改变姓名组成或作者顺序，也不执行翻译、拼音或其它转写、姓名倒置、首字母展开、编辑距离和模糊相似度。比较键只服务身份判断，不覆盖 `MetadataObservation` 或当前 `LiteratureMetadata` 中的来源展示值。

相同规范化 DOI 默认命中同一 Literature，`version_role` 的差异不能把它拆开。同一基础 arXiv ID 的 `v1`、`v2` 等 revision 也命中同一 Literature；如果供应商明确给出 revision，只在现有来源 record、locator、URL 或 Provenance 中保留，不增加 revision 字段。稳定标识符已经无冲突命中时，题名或作者的描述性差异作为来源元数据冲突保留，不能仅靠相似或不相似文本推翻标识符身份。

`identity-conflict` 是接纳结果，不是持久化业务对象。当前不建立身份候选、冲突历史、人工审核状态机或通用关系；调用方只在本次 Report 中呈现稳定、脱敏的拒绝语义。

#### 2.4.3 不同 Literature 的版本聚合

认定两个不同 `Literature` 属于同一个 `MetaLiterature` 时，只接受来源 `MetadataObservation.version_links` 中明确的同文献版本连接。当前 observation 的 `provenance.source_record_id` 和 `metadata.identifiers` 定位当前端点，`version_links` 中每个 `ProviderLiteratureKey` 定位另一端；目标 key 至少具有非空供应商记录 ID 或一个稳定 Identifier。目标未解析或存在冲突时保留 observation，但不创建占位 Literature，也不改变聚合归属。

arXiv 预印本和具有正式 DOI 的发表版是两个具体 Literature。正式发表记录中的 arXiv ID 只有在供应商语义明确表示相关预印本时才进入 `version_links`；它不能同时作为正式 Literature 自身的 identifier。不同 DOI、不同 `version_role`、相似标题、相似作者或 publisher 都不能自行建立 MetaLiterature 归属。反过来，共享 DOI 的记录也不能仅因 `version_role` 不同而拆成两个 Literature。

`version_links` 是身份决定的来源证据，不是权威关系。接纳成功后的唯一结果是两个具体 Literature 具有相同 `meta_literature_id` 和各自 `version_role`；系统不建立 `LiteratureRelationObservation`、`LiteratureRelation` 或引用以外的关系图谱。

#### 2.4.4 规则与持久化边界

身份函数只消费 Model 数据并返回可审计决定，不执行数据库读写。纯官方格式转换由 Model validator 统一实现；Metadata adapter 负责判断某个 vendor 字段表达当前文献 identifier、Provider record identity 还是相关版本；Literature 独占命中、冲突和 MetaLiterature 聚合决定。需要读取现有身份和整体转移关系时，由 Service 通过 Port 取得一致 snapshot，再把决定交给原子事务 Port。

### 2.5 来源与统一元数据

> ADR 0037：统一元数据改为按字段裁决来源（人工、权威来源、校订稿），记录冲突与锁定；建档的元数据步骤取代两阶段分析中的元数据阶段。见[§8](#8-adr-0037-目标形态元数据字段与文献状态实施中)。

Provider 与用户书目导入 observations 都是长期来源事实，不能被统一视图覆盖。一个 Literature 可以通过持久化关联拥有多个独立、不可变的 `MetadataObservation`；新接纳的非重复来源观察增加新对象和关联，不修改既有 observation。统一初始元数据按以下优先顺序逐字段形成：

1. 用户书目导入 observation 存在非空值时采用该值；
2. 导入 observation 缺少字段时，由按配置顺序排列的 Provider observations 补充；
3. 冲突值继续保留在 observation 中；
4. 非冲突稳定标识符可以共同保留；
5. 相同输入和规则得到相同结果。

Literature 只维护一份当前统一 `LiteratureMetadata`。内容分析前它是关联 observations 的确定性投影；完整 Analysis 接纳后，它由该投影、PDF 明确信息和经过验证的最终提案共同形成。`CONTENT_READY` 后新 observation 仍然建立长期关联，但不能单独替换已与当前 LiteratureContent 对齐的最终 metadata；下一次完整 Analysis 可以把它纳入新的初始投影。Catalog 不保存旧统一元数据快照；`metadata_revision` 是当前元数据每次成功替换时递增的版本令牌，只用于 stale 复检、hash 绑定和当前 LiteratureContent 对齐。

#### 2.5.1 LiteratureMetadata 的边界

`LiteratureMetadata` 只描述文献自身。精确字段为：

```text
LiteratureMetadata
  title: str | None
  authors: Author[]
  abstract: str | None
  publication_date: str | None
  publication_year: int | None
  publication_form: PublicationForm | None
  article_kind: ArticleKind | None
  language: str | None
  venue: str | None
  publisher: str | None
  volume: str | None
  issue: str | None
  pages: str | None
  identifiers: Identifier[]
  keywords: str[]
```

##### 2.5.1.1 作者署名

`Author` 和 `Affiliation` 的精确字段见 [Identifier、Author 与 Affiliation](#29-identifierauthor-与-affiliation)。`LiteratureMetadata.authors` 是当前具体 Literature 的有序、不可变署名列表；它不引用全局作者实体，也不建立跨文献 `author_id`。同一现实作者出现在不同 Literature 中时，当前产品分别保存各篇文献中的署名事实。

每个 `MetadataObservation.metadata.authors` 先独立保留该来源明确提供的有序作者列表。Literature 形成统一初始元数据时，作者列表使用以下保守规则：

1. 先从用户书目导入 observations、再从按配置排序的 Provider observations 中选择第一个非空作者列表作为基础；
2. 只有单个作者的 ORCID 相同，或者两份作者列表的作者数量、顺序和规范化 `display_name` 全部一致时，才允许把两边作者对齐；
3. 对齐后只补充基础作者缺失的 `given_name`、`family_name`、`orcid` 或 `affiliations`，不覆盖高优先来源已经存在的值；
4. 单位只按相同 ROR 或完全相同的规范化单位名称去重，并保留首次出现顺序；
5. 不按姓氏、作者位置、姓名相似度或单位相似度匹配；无法无歧义对齐的冲突继续留在各自 `MetadataObservation` 中。

元数据供应商由 adapter 把明确返回的姓名组成、ORCID、署名单位和 ROR 转换到自己的 observation。书目导入由 Entry codec 把格式能够明确表达的作者字段转换为同一 `LiteratureMetadata.authors`，再组合为用户来源 observation，交给 Literature 使用同一身份和接纳规则。PDF 内容处理时，Analysis 第一阶段可以依据 PDF 与统一初始 metadata 提出最终作者列表；Literature 将它作为最终 `LiteratureMetadata` 的一部分整体验收和替换，不能单独发布作者变更。三条路径都只能保存明确值，不根据姓名猜 ORCID、根据单位名猜 ROR，或机械拆分无法可靠判断的姓名。

`pages` 保存供应商返回的出版定位字符串，既可以是传统页码或页码范围，也可以是电子文章定位号，例如 `"54-58"`、`"e0264587"` 或 `"014103"`。Literature 不根据字符串格式猜测二者的区别，也不建立独立 `article_number` 或 `publication_locator` 字段；供应商适配器把已知页码字段和文章编号字段统一映射到 `pages`。

DOI、arXiv ID、PMID 等均作为带 namespace 的 `identifiers`，不建立平行顶层字段。`title` 可以为空，但 Literature 接纳并入库一条记录时必须满足以下条件之一：

1. 具有非空 `title`；
2. `identifiers` 中至少存在一个 namespace 为 `doi` 的标识符。

其它 namespace 的标识符不能替代 DOI 满足最低入库条件。因此，只有 arXiv ID、PMID、ISBN 或其它标识符且没有标题的记录不能入库。该判断是 Literature 拥有的入库规则，不放入 Model validator，也不由 Metadata provider 决定。未满足条件的来源结果作为稳定的单条拒绝返回，不创建 `MetaLiterature`、`Literature`、统一元数据或已接纳的来源 observation。

按 ADR 0037，统一元数据使用两组封闭枚举 `publication_form` 与 `article_kind`，取值见 [§8.1](#81-出版形式与文章性质)。未知类型在统一字段中保守为空；原始字符串和映射版本保存在 observation，不把供应商开放词汇带入统一字段。预印本仍属于 `version_role`，仅使用明确来源映射中的版本提示。

以下信息不属于 `LiteratureMetadata`：

- 供应商身份、供应商记录 ID 和观察时间；
- 供应商明确声明的同文献 `version_links`；
- 该文献引用的文献列表；
- 引用该文献的文献列表；
- 供应商观察到的参考文献次数；
- 供应商观察到的被引用次数；
- 供应商返回的 `declared_keywords`；
- PDF、落地页或开放获取地址等资产线索；
- 开放获取或其它访问状态；
- 供应商分页、额度和失败信息。

不完整文献可以先形成 `Literature`，后续 observation 继续补充。Literature 只从 observation 的 `metadata` 部分形成当前统一 `LiteratureMetadata`，不能把供应商返回的其它信息捆绑进元数据对象。

#### 2.5.2 MetadataObservation 来源输入

Provider 或用户书目导入形成的一次中性来源观察复用同一结构：

```text
MetadataObservation
  observation_id: ObservationId
  provenance: Provenance
  metadata: LiteratureMetadata
  version_role: VersionRole | None
  version_links: ProviderLiteratureKey[]
  declared_keywords: str[]
  reference_texts: str[]
  reference_count: int | None
  cited_by_count: int | None
  asset_hints: AssetHint[]
```

`MetadataObservation` 是独立、不可变且长期保存的来源对象，不是 `Literature` 的嵌入属性，也不携带 `literature_id` 或 `meta_literature_id`。Metadata 完成中性转换后，Literature 决定其身份归属，Storage 再建立 `observation_id` 到 `literature_id` 的持久化关联；同一 Literature 可以关联任意多个已接纳 observation。新增观察建立新对象和关联，不能覆盖旧 observation，并在同一逻辑提交中清除该 Literature 既有的自动 PDF 获取耗尽事实，使新的获取线索能够在后续操作中重新尝试。`observation_id` 标识整条来源观察；`provenance_id` 标识公共来源追踪对象，二者含义不同。

`provenance` 统一表达来源类别、来源身份和实际观察时间，不在 observation 顶层重复这些字段。Provider observation 使用 `metadata-provider` provenance；书目导入 observation 固定使用 `source_kind = "user"`、`source_name = "bibliographic-import"`、空 `source_record_id/input_sha256/parameters_sha256`，只保留用户明确提供元数据这一事实。`version_role` 只保存来源对当前记录版本的明确声明；没有可靠声明时为空，由 Literature 在接纳时使用 `other`，不能根据 `document_type`、来源名称或 URL 猜测为 `published`。它与描述单个地址版本的 `AssetHint.version_role` 含义不同。

`version_links` 只保存供应商明确声明为同一文献其它版本的目标定位，复用父级 Provenance，不进入 `LiteratureMetadata`。每个 `ProviderLiteratureKey` 至少具有非空 `record_id` 或一个稳定 Identifier；当前端点由本 observation 自身表达，因此 link 不重复 source，也不携带本地 Literature ID、关系类型、方向、状态或目标元数据。更正、撤稿、引用和其它关系不能进入该字段；引用使用独立 `ProviderRelationObservation`。

`declared_keywords` 只保存供应商返回的声明关键词，不直接合入当前统一 `LiteratureMetadata`。书目导入中的 keywords 保存在该 observation 的 `metadata.keywords` 并按导入优先规则进入统一初始 metadata；Analysis 根据 ParserResult 全文形成最终关键词提案，Literature 验收后以最终 `LiteratureMetadata.keywords` 表达，不维护第二套 LLM 关键词、分类或标签结果。

`reference_texts` 按供应商返回顺序保存当前记录实际携带的非空参考文献原文。它不拆分标题、作者、年份等残缺书目信息，不携带 PDF evidence，也不声明列表完整；空列表只表示本次 observation 没有返回原文。`reference_count` 和 `cited_by_count` 分别保存某供应商在 `provenance.observed_at` 观察到的参考文献次数和被引用次数，均为大于等于零的可选值；它们不根据 `reference_texts` 长度推导，不同供应商的数值也不相加。

`asset_hints` 是同一来源 observation 中可供 Acquisition 使用的访问线索，精确合同见 [AssetHint 合同](#443-assethint-合同)；它们不进入 `LiteratureMetadata`，也不成为 Literature 已经拥有资产的事实。Vendor 原始响应不能进入这些 Model，也不增加通用 `extra_metadata` 字段容纳全部供应商属性。

`LiteratureContent.references` 独立保存 PDF 中可导出的有序非空文本；Analysis 可以从这组文本或 `MetadataObservation.reference_texts` 形成临时 `ReferenceLookup`，但 lookup 不进入任何 observation。Analysis 先确定最终元数据，再以该元数据和同一 ParserResult 为上下文完成正文总结；两阶段都成功后，Literature 才验收 Analysis 提交的最终元数据、结构化章节与参考文献提案。引用目标解析和 Reference 建立是独立、可重试的补充步骤。供应商 observation 继续保留 provenance，但不再参与 `CONTENT_READY` 版本的普通统一展示。

#### 2.5.3 最终元数据与内容接纳

Analysis 提案不是数据库事实。Literature 接纳前必须重新读取并确认：

- `literature_id` 仍指向同一具体版本；
- 当前主 PDF ID/hash 与提案输入一致；
- ParserResult 输入/结果 hash 和 parser provenance 一致；
- 当前统一初始 metadata revision/hash 与提案输入一致；
- 最终 metadata 仍满足标题或 DOI 至少存在一个的最低规则；
- `LiteratureContent` 的四个固定 section role、Markdown 字符串、额外标题、reference 索引、内容/Markdown hash 和单一 Analysis provenance 已通过 Analysis 结构验证。

接纳成功时，以第一阶段形成的最终 `LiteratureMetadata` 全量替换该 Literature 的统一初始元数据，保留全部 `MetadataObservation`；LLM 提案不创建新的 MetadataObservation。最终 metadata、递增后的当前 revision、keywords、当前 `LiteratureContent`、规范 Markdown artifact 关系、对当前 PDF/ParserResult/metadata 的输入绑定、单一 Analysis provenance 和 `CONTENT_READY` 推导依据必须整体提交。规范 Markdown 的元数据块和摘要来自已验收 metadata，正文与参考文献来自第二阶段已解析 content，不保存或重新生成第二份元数据。

每个 Literature 只保留一个当前 `LiteratureMetadata` 和一个当前 `LiteratureContent`。重新分析必须先完整形成和验收新结果，再原子替换当前 metadata/content/Markdown 完整视图；失败时保留完整旧当前视图。被替换的统一元数据不进入历史表，旧结构化内容和 Markdown 字节也不形成数据库历史，只成为可回收缓存。当前 content 丢失、损坏或不再与当前 PDF/metadata 对齐时，可以由长期 observations、当前权威元数据和当前 PDF 重新形成 ParserResult 并再分析。

在文献内容处理链中，来源 `MetadataObservation`、当前权威 `LiteratureMetadata` 与当前主 PDF 的 Asset/关系/来源是优先长期可靠保存的事实；ParserResult 与 LiteratureContent 是可重建派生产物。内容接纳或替换失败不得回滚或破坏这些权威输入。该规则不改变 Execution、ProviderRelationObservation 或非 content support 的既有持久化语义。

第一阶段或第二阶段失败、提案 stale、最终 metadata 不合格或整体提交失败时，不留下部分最终 metadata、keywords、sections、references 或当前 artifact 指针。已存在的 PDF 和统一初始 metadata 保持有效，可在后续运行重新分析。

### 2.6 引用解析与权威 Reference

> ADR 0037：参考文献改由校订稿解析，新增 `ArchiveReferenceTextSupport`；`ContentReferenceTextSupport` 随 `LiteratureContent` 退役。见[§8](#8-adr-0037-目标形态元数据字段与文献状态实施中)。

参考文献原文不是权威引用关系。供应商原文保存在 `MetadataObservation.reference_texts`，PDF 中识别的有序参考文献文本保存在当前 `LiteratureContent.references`；两者即使尚未解析目标也继续可用。整份内容通过单一 Analysis provenance 的输入 hash 回溯到 PDF、ParserResult 和最终 metadata，当前不保存逐条位置。空 references 在 Markdown 中显示“未提供”，但该缺失标记不是参考文献。公共 Model 不建立 `ReferenceObservation` 或 `CitationObservation`。

目标解析有两条入口：

```text
元数据供应商的结构化引用关系查询能力
  -> 逐边保存 ProviderRelationObservation
  -> Entry 按当前扩展范围选择 observation
  -> 本地精确查询；必要时取得 MetadataObservation
  -> Literature 接纳选中的相关文献
  -> Reference + ProviderRelationSupport

参考文献原文
  -> Analysis 形成临时 ReferenceLookup
  -> 本地精确查询；未命中时由 Metadata 搜索
  -> Literature 接纳目标文献
  -> Reference + MetadataReferenceTextSupport 或 ContentReferenceTextSupport
```

`ReferenceLookup` 只包含当前检索所需的稳定标识符、标题、作者和年份线索，不持久化。LLM 不能用这些值直接创建目标文献；本地已经通过稳定标识符或其它无歧义规则精确命中时可以直接使用现有 Literature，否则 Metadata 结果仍须形成普通 `MetadataObservation`，并通过本模块与主题搜索相同的最低入库和身份规则。

`ProviderRelationObservation` 的精确合同见 [ProviderRelationObservation](#352-providerrelationobservation)。它是元数据供应商逐边保存的来源事实和待扩展输入，不属于 Literature，也不要求目标已经具有本地身份。Literature 只处理 Entry 当前选中的 observation：目标未接纳时不创建占位 Literature 或权威关系；目标接纳后才形成 Reference 和指回该 observation 的 `ProviderRelationSupport`。保存 observation、创建目标 Literature 和发布权威关系是三个分开的阶段。

只有来源和目标都已经具有本地 `LiteratureId`、目标身份可靠确定后，才创建权威关系：

```text
Reference
  reference_id: ReferenceId
  source_literature_id: LiteratureId
  target_literature_id: LiteratureId
```

`source_literature_id` 是引用方，`target_literature_id` 是被引用方。三个字段全部必填，source 和 target 都必须是本地具体 `LiteratureId`，且 `source_literature_id != target_literature_id`。Reference 不携带供应商记录 ID、原始文本、临时 lookup、残缺元数据、PDF evidence、provenance 或 `MetaLiteratureId`。相同 `(source_literature_id, target_literature_id)` 只形成一条权威关系。

关系依据使用判别联合表达：

```text
ReferenceSupport
  reference_id: ReferenceId
  source: ReferenceSupportSource

ReferenceSupportSource =
    ProviderRelationSupport
  | MetadataReferenceTextSupport
  | ContentReferenceTextSupport

ProviderRelationSupport
  kind: Literal["provider_relation"]
  observation_id: ObservationId

MetadataReferenceTextSupport
  kind: Literal["metadata_reference_text"]
  metadata_observation_id: ObservationId
  reference_index: int

ContentReferenceTextSupport
  kind: Literal["content_reference_text"]
  literature_content_sha256: Sha256
  reference_index: int
```

`ProviderRelationSupport` 表示元数据供应商已经直接给出具有稳定目标标识的结构化引用关系；`observation_id` 指向该关系来源 observation，且 observation 的有向关系在目标接纳后必须与 Reference 的 source/target 一致。`MetadataReferenceTextSupport` 精确定位 `MetadataObservation.reference_texts[reference_index]`，该 observation 必须归属于 Reference 的 `source_literature_id`；`ContentReferenceTextSupport` 精确定位给定当前内容 hash 的 `LiteratureContent.references[reference_index]`，该内容也必须属于引用方。两个索引都从零开始且必须大于等于零。

结构化关系与参考文献原文按返回数据语义区分，而不是按是否主动调用专门接口区分。供应商明确返回稳定目标记录或标识符时属于 `ProviderRelationSupport`；只返回一段仍需解析目标的参考文献文字时属于 `MetadataReferenceTextSupport`。同一种供应商 API 可以产生其中任一形式。

`ReferenceSupport` 没有独立 `reference_support_id`，自然唯一性为 `(reference_id, source)`。它不重复保存 source/target Literature、原文、目标元数据、PDF evidence、`ReferenceLookup`、confidence、status、created_at 或 provenance；这些内容继续由其指向的来源对象拥有。目标元数据查询和 Literature 身份接纳证明“目标是谁”，support 证明“来源确实声明了这条引用”，两者不能混入同一 schema。

Reference 创建时必须同时发布至少一项有效 support；后续供应商或文本来源再次确认同一 source/target 时，只为既有 Reference 增加去重后的 support，不能创建平行边。只有引用或被引用计数、原文、lookup、供应商目标 ID、相似标题、多个不确定候选或只有 MetaLiterature 身份时都不足以形成 Reference。

当前 LiteratureContent 被新结果替换时，全部指向旧 `literature_content_sha256` 的 `ContentReferenceTextSupport` 必须在同一逻辑提交中删除；某条 Reference 因而不再有任何 support 时一并删除。新 references 后续按普通 lookup 流程重新建立；`ProviderRelationSupport` 和 `MetadataReferenceTextSupport` 不受 content 替换影响。

已经完成的引用 DiscoveryRun 不通过 `reference_id` 长期依赖当前 Reference。其 `CitationDiscoveryCause` 独立保存当时实际的 source/target Literature 和 depth，只表达“本次运行由这条直接引用方向发现目标”的历史事实，不是第四种 ReferenceSupport，也不阻止失去全部 support 的当前 Reference 按上述规则删除。

无法解析或候选存在歧义时只保留来源原文，不创建占位 Literature、未解析 Reference 或只指向 `MetaLiterature` 的关系。后续运行可以重新形成 lookup。被引用视图是同一 Reference 的反向查询，`MetaLiterature` 级引用网络由 Literature 级关系汇总；二者都不形成第二份可变事实。引用扩展只通过公开查询 API 读取关系及其 support。

### 2.7 文献状态

> ADR 0037：`CONTENT_READY` 将由 `READY` 取代，状态扩展为六种。见[§8](#8-adr-0037-目标形态元数据字段与文献状态实施中)。

三级状态是纯推导结果，不是可独立修改的数据库列：

```text
UNREVIEWED
ASSET_READY
CONTENT_READY
```

推导规则为：

```text
CONTENT_READY
  if 存在由 Literature 整体接纳、对齐当前主 PDF 和最终 metadata revision，且具有单一 Analysis provenance 的 LiteratureContent 与规范 Markdown

ASSET_READY
  else if 存在通过基本检查的当前主 PDF

UNREVIEWED
  otherwise
```

`CONTENT_READY` 已表示本产品内容处理完成。自动 PDF 获取耗尽、运行时 selector/目标/Report、failure、attempt、`ParserResult`、Parser task、FTS、孤立文件、临时 `ReferenceLookup`、权威引用关系和未整体提交的 LLM 输出不参与状态推导。LLM 明确判断当前 PDF 无实际内容并完成清理后，状态根据剩余事实自然回到 `UNREVIEWED`。

### 2.8 独立读取、新知识关联与事实边界

#### 2.8.1 只读访问

当前QueryApplication向CLI、TS调用方和独立Web提供相同的LiteratureQueryService。`search/detail/references/referenceDetail`只读取已经提交的事实，不调用Metadata补查、Acquisition、Parser或模型。未初始化和不可用库在组装边界区分；查询损坏索引不能自动重建，artifact读取必须验证当前关系、文件身份和hash。

`detail` 返回值包含材料/解析/当前内容引用，而不是字节。`withArtifact`接受这些引用并定位实际登记对象，在消费前后复核文件，客户端取消或关闭应用后读作用域失效。查询结果不作为写入命令复用；UI传回修改意图时仍需对应owner重新读取与验收。

#### 2.8.2 新产物怎样关联

新Document/Evidence和KnowledgeArtifact通过明确Literature/Material/Document ID及输入hash关联。Literature继续提供保守版本身份，不能把document_version_id并入literature_id，也不因为两份表示hash不同创建另一篇论文。

旧 `CONTENT_READY` 表示当前七标题内容兼容视图有效；新“有概览/有问题分析/有提取候选”的可用性分别由相应owner读取投影，不能继续增设单一全局完成态或伪造旧content。不同用途的产物可以共存，current/default仅是明确投影。

ReferenceSupport证明文献引用边的来源，EvidenceRef证明某个材料/表示位置的引用；二者不能互相代替。替换旧LiteratureContent删除旧ContentReferenceTextSupport的既有规则，不得扩展成删除仍被新知识/外部交付引用的证据版本。

#### 2.8.3 更新、冲突与失败

元数据修正仍由Literature接纳；Analysis只提交有输入绑定的提案，Extraction的领域payload不进入metadata或observation。并发提交必须复核metadata_revision/hash以及当前PDF/Parser输入；stale拒绝保留当前完整事实和所有来源。

一种用途分析不适用或模型失败不授权删除Asset。资产的错误文章判定、失效或删除由独立的业务决定说明目标与理由，并核对引用依赖；Literature只更新由其拥有的关系，Storage不根据状态列猜测删除范围。

### 2.9 Identifier、Author 与 Affiliation

跨模块文献标识、署名与单位的精确合同为：

```text
Identifier
  namespace: str
  value: str

Author
  kind: AuthorKind
  display_name: str
  given_name: str | None
  family_name: str | None
  orcid: str | None
  affiliations: tuple[Affiliation, ...]

AuthorKind = "person" | "organization" | "unknown"

Affiliation
  name: str
  ror: str | None
```

`Identifier` 只表达一个标识符的命名空间和值。两个字段去除边界空白后必须非空；`namespace` 规范化为小写开放字符串，不建立全局枚举。为了让书目导入和全部 Provider 共享同一格式，Model 对已经明确的 namespace 执行纯、确定、无 I/O 且幂等的官方 canonicalization：

| namespace      | validator 接受并转换的表示                                                                     | canonical `value`                                                          |
| -------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `doi`          | 裸值、大小写变体、`doi:`、已知 `doi.org`/`dx.doi.org` resolver URL 和边界空白                  | 小写裸 `10.xxxx/...`；不删除可能属于 DOI suffix 的标点                     |
| `arxiv`        | 官方新式或旧式 ID、`arXiv:`、官方 `/abs/` 或 `/pdf/` URL、可选 `.pdf` 及 `v1`/`v2` 等 revision | 不带 revision 的官方基础 ID，例如 `2501.01234` 或 `hep-th/9901001`         |
| `pmid`         | 边界空白内的官方 PMID                                                                          | 纯数字                                                                     |
| `pmcid`        | 边界空白内、前缀大小写可规范化的官方 PMCID                                                     | 大写 `PMC` 加数字                                                          |
| 其它 namespace | 当前没有显式 canonicalizer 的值                                                                | 只去除边界空白并保持其余字符；支持前必须依据官方规范增加独立转换与 fixture |

已知 namespace 的包装去除后仍必须满足对应官方基本格式；不能识别的 URL、前缀、空值或畸形值直接拒绝，不通过猜测修复。DOI 大小写不敏感，因此只有 `doi` 的 value 统一小写；不能把这项规则全局应用到 arXiv、PMCID、ISBN、ISSN 或未知 namespace。arXiv revision 只是来源表示，不形成新的业务字段。ISBN、ISSN 等其它标识符若需要语义规范化，必须分别依据官方合同增加显式 canonicalizer，而不是由 Provider adapter 私自采用不同规则。

Model 只决定一个值的 canonical 表达，不判断该字段究竟标识当前 Literature、相关版本还是 Provider 记录，也不决定两个 Literature 是否合并。Metadata adapter 负责语义归类；Literature 负责身份命中、冲突和版本聚合。供应商内部记录 ID 进入 `Provenance.source_record_id` 或 `ProviderLiteratureKey.record_id`，不伪装成文献 `Identifier`。该对象不增加 URL、provider、provenance、primary 或 confidence 字段。

`Author` 表示作者在一篇具体 `Literature` 中的一次结构化署名，不是全局作者实体。`display_name` 是必填的署名展示值，只允许忠实清理断行与边界空白；`given_name` 和 `family_name` 只保存来源明确给出或能够无歧义对齐的姓名组成，不能从展示名机械猜测。`kind` 允许个人、机构或无法可靠分类的署名，因此能够保留中文姓名、协作组和机构作者。ORCID 只保存不带 URL 前缀的裸值，并校验格式与校验位；不得根据姓名查询或猜测。作者顺序由 `LiteratureMetadata.authors` 的不可变 tuple 表达。

`Affiliation` 表示该作者在这篇具体文献中的署名单位；`name` 非空，`ror` 只保存来源明确给出且不带 URL 前缀的裸值，不能根据单位名称猜测。单位顺序在作者内部保留。当前合同不增加全局 `author_id`、作者 position、email、通讯作者、共同贡献、CRediT role、confidence、供应商作者 ID 或逐作者 provenance；作者及单位的来源由所属 `MetadataObservation` 或最终内容的 Analysis provenance 表达。

### 2.10 文献身份与资产结构

`MetaLiterature`、`Literature`、`VersionRole` 和 `LiteratureStatus` 的精确合同由 [MetaLiterature 与 Literature](#23-metaliterature-与-literature) 定义。`VersionRole` 使用 `published`、`accepted-manuscript`、`preprint` 和 `other`，不保留旧名称 `formal`；`LiteratureStatus` 只承载 Literature 模块已经推导的当前结果，Model validator 不计算状态。

`MetadataObservation` 的精确合同由 [MetadataObservation 来源输入](#252-metadataobservation-来源输入) 定义。它是独立、不可变且长期保存的来源对象，不是 `Literature` 属性；一个 Literature 与多个 observations 的归属由 Storage 关系表达，不把 `literature_id` 放入 observation。Provider observation 与书目导入 observation 复用同一结构，只通过受约束的 Provenance 区分；书目 codec 不得复制 `LiteratureMetadata` 字段建立 `ImportedMetadata`。`version_links` 只保存供应商明确声明为同一文献其它版本的目标 key，用于可审计身份收敛，不进入 `LiteratureMetadata` 或形成独立权威关系；`reference_texts` 只保存供应商实际返回的原文，不声明完整，也不表示已经形成引用关系。`MetadataObservation.declared_keywords` 保存供应商声明关键词；书目导入的 keywords 进入该 observation 的 `metadata.keywords` 并可参与统一初始投影；完整 Analysis 后，当前 `LiteratureMetadata.keywords` 保存 Literature 已验收的全文关键词。`LiteratureMetadata.pages` 同时承载传统页码范围和供应商返回的电子文章定位号，不再建立 `article_number`。`AssetHint` 的精确合同由 [AssetHint 合同](#443-assethint-合同) 定义；其中 URL、媒体类型、资产角色、版本角色、访问状态和许可证都描述具体来源线索，不属于 `LiteratureMetadata`，也不代表已接纳资产。`AssetHint` 不增加获取层级、授权要求或 Browser 要求，运行访问上下文由 Acquisition Resolution/Plan 决定。`PdfCandidate`、`Asset`、`LiteratureAsset` 和 `AcquisitionResult` 的精确合同分别见 [Route hint、候选与 adapter 边界](#444-route-hint候选与-adapter-边界)、[Asset 与 LiteratureAsset](#445-asset-与-literatureasset)和[输入与公开结果](#43-输入与公开结果)：候选与 candidate key 只存在于当前运行；候选只保存 route adapter 的稳定 source identity、Public/Authorized API/Browser path 和声明媒体类型，不要求 URL，也不携带 adapter 私有动作；Asset 只描述不可变文件；唯一 `primary-pdf` 关系表达当前主 PDF；自动业务结果只有已获得或未获得，系统提交错误不属于该联合。`NoPrimaryPdf` 只有在全部适用 routes 正常结束、没有 deferred/action-required/未解决 failure 且最小耗尽事实已提交后成立；运行错误不能伪装成该结果。手动接纳成功使用独立 `AcceptedManualPdf`，只组合已经提交的 `Asset` 与 `LiteratureAsset`；无效本地文件是输入验证错误，不进入自动联合，用户绝对路径不进入 Model。这些来源信息不能通过通用 `extra_metadata`、裸字典或 vendor model 扩展 `LiteratureMetadata`。非空标题或 DOI 至少存在一个是 Literature 的入库规则，不由 Model validator 决定。

### 2.11 元数据并发绑定

`LiteratureMetadata` 是单一当前值，不是来源 observation 或 revision 历史对象。`metadata_revision` 不进入 `LiteratureMetadata` schema；它是持久化关系上的单调并发令牌，和 `metadata_sha256` 一起绑定当前内容输入。Catalog 不暴露旧统一元数据 revision 集合，LLM 最终提案也不转换为 `MetadataObservation`。

### 2.12 权威引用支持结构

`Reference` 只有 `reference_id`、`source_literature_id` 和 `target_literature_id` 三个必填字段。`ReferenceSupport` 由 `reference_id` 和判别联合 `source` 组成，不设置独立 ID；三种 source 分别用关系 observation ID、metadata observation ID 加零基索引，或当前 LiteratureContent SHA-256 加零基索引定位真实来源。Reference 不平铺 provenance、原文、目标元数据或 evidence，support 也不复制这些内容；当前 content 替换后的 support 清理属于 Literature/Storage 规则。精确合同见 [引用解析与权威 Reference](#26-引用解析与权威-reference)。

## 3. 元数据来源与供应商适配

### 3.1 当前实现结构

供应商和外部服务的静态事实由各家 `apps/server/src/providers/<provider>/definition.ts` 拥有，`providers/registry.ts` 统一汇总能力、endpoint、认证声明、覆盖范围与访问政策；本模块 registry 消费该声明并结合实际 adapter/readiness，不再自有一份重复能力清单。Metadata 与 Acquisition 保持独立接口。各服务的共享额度、默认策略和维护步骤见[供应商治理](../../development/provider-governance.md)。

```text
apps/server/src/metadata/
  api.ts / service.ts / ports.ts   # 操作、调用编排与中性 Provider ports
  registry.ts                     # 目录消费、选择与能力
  assembly.ts                     # 当前配置与共享 Network 组装
apps/server/src/providers/
  registry.ts / contracts.ts      # 静态定义汇总与统一合同
  <provider>/definition.ts        # 各家服务、认证与访问政策
  <provider>/metadata.ts          # 各家元数据协议转换
  <provider>/acquisition.ts       # 各家 PDF 协议适配（仅支持者）
  shared/                        # 通用传输与记录帮助
```

`MetadataApi.searchTopic` 按给定 providers 和 scan_limit 返回多来源结果；`searchTopicProvider` 可由 Entry 的 run-owned 预算逐 Provider 调用；`lookup` 接收稳定定位；`queryReferences` 返回来源关系。每种调用都接收可选 `AbortSignal`。普通文献查询不调用这些 API。

`MetadataService` 负责能力验证和稳定失败转换，Entry 拥有 DiscoveryRun 与全 run 预算，Literature 决定接纳/身份；同一个 scan limit 不能在每个分页或种子重新补满。adapter 只有在生产 assembly 已安装且用户选择与 readiness 满足时才参与。

### 3.2 公开 API

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

### 3.3 Ports

`ports.ts` 至少区分：

- Metadata Search：按中性查询条件产生 metadata observation；
- Metadata Lookup：按 DOI、arXiv ID、PMID/PMCID 或供应商稳定记录 ID 等明确标识符精确查询；
- Metadata Reference Query：使用同一类元数据供应商的引用关系查询能力，按中性文献标识和方向返回逐边 `ProviderRelationObservation`，并转换响应实际内联提供的相关 metadata observation；
- Observation Publication：持久化已经完成中性转换且可被 Literature 接纳的 metadata observation，以及可以独立存在的结构化引用关系来源 observation；
- 必要的时钟或调用预算接口。

每个 Metadata Search 调用具有明确 Provider，并消费该 Provider 在整个 DiscoveryRun 内共享的原始扫描预算；分页在结果耗尽、达到上限或失败时停止。Cursor 和运行时计数只存在于适配调用，不属于 Port 返回的持久化事实。

Metadata Lookup 和 Metadata Reference Query 都是 Metadata Provider 的可选能力，不把引用定义成新的供应商种类，也不建立 `CitationProvider` Port。同一供应商可以通过专门 endpoint 或普通元数据响应提供引用信息；接口形式不决定结果属于结构化关系还是参考文献原文。Provider Port 表达供应商能力，不复制 Network transport API。供应商适配器可以使用 `network`，但 Metadata 的规则和用例不能直接使用 HTTP 类型。

### 3.4 供应商适配器

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

每个 Provider adapter（当前为 `providers/<provider>/metadata.ts`）负责：

- Endpoint 和供应商请求参数；
- 查询语法映射；
- 分页 token/cursor；
- 声明稳定 provider/API product AccessScope 与经过核对的访问政策；
- Provider quota、`429`、`Retry-After` 和额度响应头解释，并转换为 Network 可执行的 policy feedback；
- 凭据附着位置；
- 声明该能力的凭据字段需求、非 secret 普通参数和用于用户显式 `config test` 的官方最小只读 probe；
- Vendor 响应结构解析；
- 转换为 `packages/contracts` 中的中性 observation、同文献版本连接、引用查询结果与资产线索；
- 将供应商错误转换为稳定、脱敏失败。

当前 TypeScript Metadata 生产 HTTP 请求使用明确的 `GET`、30 秒单次 timeout 与 4 MiB 响应预算；
预算同时传到 HTTP 字节读取与共享 Network usage。HTTP `429`、认证/授权错误、来源服务错误、
Network timeout/响应超限和无效 JSON 分别转换成来源/传输失败，只有逐记录合同转换失败才报告
`metadata-record-invalid`。稳定失败保留安全的 HTTP status 与 Network 已解析且有界的
`Retry-After` 提示，不携带 header、响应正文、URL 或原始异常。

Crossref 主题游标分页显式使用 `sort=score&order=desc`；arXiv 对主题的每个词或用户明确加引号的
短语加 `all:` 并以 `AND` 连接，避免未限定词产生 OR 扩召回。DataCite 默认每页 25 条，扫描上限
仍跨页累计；其摘要段落空白在供应商边界转换为空格，raw input hash 继续绑定原始响应记录。
Semantic Scholar 的数字 `externalIds.PubMedCentral` 转换为带 `PMC` 前缀的公共 PMCID，搜索、
lookup 和引用端点共用这一转换。以上规则没有增加领域语义过滤或精确主题命中保证。

一个供应商共享一个 client/session；共享同一 key、账户或官方额度池的 search、reference query 和 asset API 还必须共享同一 Network AccessScope。适配器不能执行身份合并、统一字段选择、PDF 基本检查、实际内容判断或文献状态推进，也不能建立只对 Metadata 可见的局部 limiter。

Provider 增加或替换时，只需实现相同中性 Port 和网络安全边界，不能要求改写产品主流程。

### 3.5 Observation 与部分成功

#### 3.5.1 MetadataObservation

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

精确字段见 [MetadataObservation 来源输入](#252-metadataobservation-来源输入)。`MetadataObservation` 是独立、不可变且长期保存的来源对象，不携带 Literature 身份；Literature 接纳后由 Storage 建立归属，一个 Literature 可以关联多个 observations。`LiteratureMetadata` 不是供应商整条返回记录。`version_role`、`version_links`、`declared_keywords`、原始参考文献文本、两类次数和资产线索必须保持为 observation 的独立组成部分，不能为了适配某个供应商而不断向 `LiteratureMetadata` 增加属性。`version_links` 只保留明确同文献版本目标，不能容纳更正、撤稿或其它供应商关系；`declared_keywords` 不直接填入 `LiteratureMetadata.keywords`，也不与 LLM 根据文献内容形成的关键词混合；不同供应商的计数不直接相加；Metadata 也不把 `AssetHint` 接纳为文献资产。Observation 只声明产品需要的中性字段，不增加通用 `extra_metadata` 或让 vendor 原始响应穿透 Model。

Adapter 必须先判断一个供应商字段的语义归属，再构造中性 Model：只有标识“当前这条具体文献记录所描述的 Literature”的 DOI、arXiv ID、PMID、PMCID 或其它官方文献 ID 才进入 `metadata.identifiers`；供应商数据库自身的记录键进入 Provenance 或 ProviderLiteratureKey；指向预印本、正式发表版或其它同文献版本的 ID 进入 `version_links`。官方格式只决定值如何表达，不会把 Provider record identity 自动升级为文献自身 identifier。

供应商字段按其含义转换，而不是按 vendor 字段名照搬：

| 供应商字段表达的事实                                                                                    | 中性归属                                                                                         | 转换规则                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文献自身的题名、摘要、出版日期、类型、语言、出版物、出版社、卷、期、页码或电子文章定位号                | `LiteratureMetadata`                                                                             | 只映射 [LiteratureMetadata 的边界](#251-literaturemetadata-的边界)；页码范围和电子文章定位号都进入 `pages`                                                                                                                                                       |
| 按署名顺序返回的作者展示名、明确姓名组成、ORCID、作者与单位对应关系及 ROR                               | `LiteratureMetadata.authors: Author[]`                                                           | 按来源顺序转换为 [Identifier、Author 与 Affiliation](#29-identifierauthor-与-affiliation)；只保存供应商明确返回或能够在同一记录中无歧义对齐的值，不建立全局作者身份                                                                                              |
| 当前记录自身的 DOI、arXiv ID、PMID、PMCID 等具体文献标识符                                              | `LiteratureMetadata.identifiers`                                                                 | 转换为带 namespace 的中性 `Identifier`；公共 Model 统一执行官方 canonicalization，adapter 不再实现另一套大小写、前缀或 URL 去壳规则                                                                                                                              |
| OpenAlex Work ID、Web of Science UID、Semantic Scholar Paper ID、Scopus EID 等 Provider record identity | 当前记录使用 `provenance.source_record_id`；关系或版本端点使用 `ProviderLiteratureKey.record_id` | 保留供应商官方值并在父 Provenance 的 provider scope 内解释；不能进入 `LiteratureMetadata.identifiers` 或跨供应商身份匹配                                                                                                                                         |
| 供应商明确表示为原始记录声明的关键词                                                                    | `MetadataObservation.declared_keywords`                                                          | 不把主题分类、学科分类或供应商自动推导的 topic 当作声明关键词                                                                                                                                                                                                    |
| 供应商明确声明的文献版本                                                                                | `MetadataObservation.version_role`                                                               | 只映射可靠声明；未知时为空，不根据文献类型、供应商名称或 URL 猜测                                                                                                                                                                                                |
| 供应商明确声明为同一文献其它版本的稳定目标                                                              | `MetadataObservation.version_links`                                                              | 每个目标形成一个 `ProviderLiteratureKey`；当前记录由 observation 自身定位，目标至少具有非空供应商记录 ID 或稳定 Identifier；正式发表记录中表示相关预印本的 arXiv ID 属于这里，不得同时塞入当前正式 Literature 的 identifiers；不映射更正、撤稿、引用或模糊相关项 |
| 当前记录中原样返回的参考文献条目文本                                                                    | `MetadataObservation.reference_texts`                                                            | 按供应商顺序保存非空原文；不拆成残缺元数据，也不解释成已确认 Reference                                                                                                                                                                                           |
| 供应商明确返回稳定目标标识的参考文献或被引用文献                                                        | 逐边 `ProviderRelationObservation`，以及响应实际内联提供的相关 `MetadataObservation`             | observation 规范化为 `citing -> cited` 并独立保存；只有当前扩展范围选中的目标才继续接纳并建立 Reference 与 `ProviderRelationSupport`                                                                                                                             |
| 参考文献次数和被引用次数                                                                                | `MetadataObservation.reference_count`、`cited_by_count`                                          | 保留来源和观察时间，不根据文本列表长度推导，也不跨供应商相加                                                                                                                                                                                                     |
| 直接文件 URL、落地页 URL、媒体类型、资产角色、版本角色、访问状态和许可证                                | `MetadataObservation.asset_hints`                                                                | 每个可独立使用的地址形成一个 `AssetHint`；精确合同见 [AssetHint 合同](#443-assethint-合同)                                                                                                                                                                       |
| 搜索相关度、分页 cursor、供应商抓取或索引时间、供应商为当前文献预生成的展示引用和其它内部运行字段       | 不进入业务 Model                                                                                 | 只在当前适配调用中使用，不持久化为文献事实                                                                                                                                                                                                                       |

作者转换由各 provider adapter 在单条供应商记录的边界内完成：保留原始署名顺序和明确的 `display_name`、`given_name`、`family_name`、ORCID、署名单位名称及 ROR；机构或协作组按机构作者表达，无法可靠分类时使用 `unknown`。Adapter 不从展示名按空格机械拆分姓与名，不翻译姓名，不根据姓名猜 ORCID，不根据单位名称猜 ROR，也不使用供应商作者 ID 建立本地作者身份。供应商没有明确给出作者与单位的对应关系时，不能把全部单位分配给全部作者。

Metadata 只转换每个来源自己的作者事实，不跨供应商匹配作者。选择基础作者列表以及按相同 ORCID 或整表完全对齐补充缺失字段，属于 [作者署名](#2511-作者署名)。冲突仍保留在各自 observation 中，不能由 adapter 用模糊匹配提前消解。

所有 adapter 都把 vendor 值交给同一个 `Identifier` 边界：DOI URL、`doi:`、大小写和边界空白必须得到同一小写裸 DOI；arXiv 前缀、官方 URL、新旧式编号和 `vN` revision 必须得到同一基础 ID；PMID、PMCID 及其它已支持 namespace 使用各自官方格式。Adapter 不能为了提高命中率删除标点、改变未知 namespace 大小写或建立私有 alias。不能通过官方语义确认某字段标识当前具体 Literature 时，不得猜测放入 identifiers。

供应商返回多个地址时必须形成多个 `AssetHint`，不能只保留一个 `pdf_url` 或用后返回值覆盖先返回值。供应商返回多个明确同文献版本目标时分别形成多个 `version_links` key；这些 key 复用当前 observation 的 Provenance，只作为 Literature 身份收敛证据，不产生独立关系对象。只保存能够支持文献识别、版本收敛、引用扩展、资产获取和来源审计的中性字段；不保存完整 vendor 原始对象。

#### 3.5.2 ProviderRelationObservation

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

#### 3.5.3 部分成功

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

领域 DiscoveryRun 由 Entry 调用本次有效选择且 readiness 通过的全部 Metadata Search Provider。有效选择由纯本地 resolver 从 Auto 或 Custom 得到：Auto 是当前版本维护的默认安全集合，Custom 是用户精确顺序并允许为空；Key 和在线状态都不改变集合。明确选择但缺少生产 adapter、必需普通参数、凭据或 AccessPolicy 时，运行开始前形成稳定配置错误；不能静默跳过、凭据驱动启用或伪装为零结果。Metadata 不因一条 observation 被接纳就自动对它发起逐篇精确查询，也不把搜索相关度、候选、未接纳结果、cursor、原始请求/响应或扫描计数交给 publication Port。自然耗尽、达到扫描上限和失败由 Entry 转换为逐来源稳定终止结果；Adapter 的 timeout、重复 cursor 与空分页循环保护不进入业务 Model。

Metadata 不判断一条 Provider 结果是否与用户领域语义相关，不调用 LLM 或 embedding，也不按搜索分数、标题关键词、摘要、连续低收益或其它主题启发式过滤和提前停止。非空标题或 DOI 任一存在就是当前最低入库边界；有实际内容但偏题的 Literature 仍可正常进入后续处理，不属于 `NoUsableContent`。

Metadata 不决定不同 observation 是否属于同一 `Literature`；它把全部成功来源事实交给 Literature。

元数据供应商的引用关系查询能力只返回相关文献的稳定记录 ID 或 DOI 等标识时，适配器直接用它形成对应的 `ProviderLiteratureKey`，不为响应中的全部目标立即补查元数据。Entry 只对当前用户方向、深度、数量和筛选范围选中的关系解析非本地端点：先精确查询本地 Literature，响应已内联提供目标 `MetadataObservation` 时复用它，否则再调用 Metadata Search。目标 observation 被 Literature 接纳后，Entry 建立两个具体 Literature 之间的 Reference，并用 `ProviderRelationObservation.observation_id` 建立 `ProviderRelationSupport`。未选中、元数据不足或接纳失败的 relation observation 继续保留，但不创建占位 Literature、Reference 或 support。

结构化关系和参考文献原文的正式判断标准是供应商是否已经明确给出可稳定识别的目标，而不是调用是否主动、是否使用专门 endpoint，或者字段是否由默认元数据响应携带。只有 DOI、PMID、arXiv ID、供应商稳定记录 ID 等明确目标标识的关系才能形成结构化关系 observation；仅有格式化引用文本时始终进入 `reference_texts`。

Entry 在 Literature 接纳 observation 后保存其中的 `AssetHint`，并在处理对应 `Literature` 时把当前可用线索交给 Acquisition。Metadata 不直接调用 Acquisition，也不把资产线索写成当前主 PDF。

### 3.6 Network 与配置边界

供应商适配器通过 `network/http.ts` 发起访问，遵守统一 URL、DNS、redirect、origin、timeout、响应大小、脱敏和 ADR 0012 的进程内共享准入。Provider 自身的分页、额度和响应语义留在适配器中；adapter 声明 scope 并解释反馈，Network 在当前进程的 Metadata、Acquisition、不同操作和文献目标之间执行并发、间隔、quota 与 `Retry-After`。Vendor SDK 无法注入受控 transport 时不能作为生产实现。

HTTP 200 不能被统一解释为 Metadata 成功或空结果。例如 Elsevier 的 Scopus Search 与
Abstract Retrieval 还可能返回 `service-error.status.statusCode` envelope；adapter 只读取
有界、白名单化的 code，将其转换为认证、产品授权、限额、查询拒绝、可重试服务失败或精确
lookup miss，不读取或记录 vendor `statusText`。未知 code、畸形 envelope 和未知顶层继续
形成稳定的 unknown-shape failure，不能被伪装成零结果。
Scopus Search 的 offset 与 cursor 是两种分页合同：cursor 响应必须提供 total、page count、
当前/下一 cursor 与 entry，`opensearch:startIndex` 可以缺失；若供应商仍返回该 offset 字段，
adapter 会将它与本地已接收计数严格核对。Debug 只记录受控 envelope、字段存在位、disposition
和中性 failure kind，不记录字段值、cursor、query 或响应正文。

普通配置向 `bootstrap/application.ts` 提供 Source mode、Custom Provider 顺序、产品/database/edition、逐 Source `limit`、非 secret 运行身份和 AccessPolicy；Configuration 的有效 Source 解析只用版本常量解析 Auto，不访问 Network 或 credentials。当前 Metadata Auto 是 Crossref、Semantic Scholar、arXiv、OpenAlex、Europe PMC、DataCite 与 CORE；Crossref 无子表时使用 anonymous。OpenCitations 可显式选择其支持的引用能力，不在当前 Auto 列表，也不参加 topic search。Provider secret 只由 TypeScript Configuration owner 从 `~/.sciretriever/credentials.toml` 私有解析后注入具体 adapter。Metadata API、Port、Model、AccessScope 和 observation 都不保存 secret 值或凭据文件原文。未知选择键、缺失生产适配器、缺失所需普通参数/凭据或缺少明确 AccessPolicy 必须形成稳定 readiness 失败，不能静默回退到假实现或无限制访问。

`config status` 只读取 capability spec、普通配置和凭据字段存在性，不调用 Metadata API 或 Network。用户显式执行的 `config test` 可以复用 adapter 声明的最小 probe，但它通过 Bootstrap 的配置测试边界和统一 Network 执行，不伪装成 Metadata Search/Lookup，不产生 MetadataObservation、ProviderRelationObservation、DiscoveryRun、Report 或持久化结果。

### 3.7 持久化协作

Metadata 形成中性 observation 后，通过自己拥有的 publication Port 请求保存，但该 Port 不能绕过 Literature 的最低入库条件。Observation、Literature 身份结果、统一初始元数据、DiscoveryRun 结果/原因，以及该 Literature 既有自动 PDF 获取耗尽事实的清除，由 Entry 在 Literature 接纳后编排复合事务；标题和 DOI 都缺失的结果不会作为已接纳 observation 持久化，但仍消耗原始扫描额度。Storage 不在 SQL 中重新解释供应商数据。

同一来源 observation 重复提交必须幂等，不能因重复收集制造无意义副本；实际接纳到新的来源观察时则新增不可变 observation 和 Literature 归属，不能更新旧对象。幂等键和物理 schema 由 Storage 实现，但不能丢失来源差异。Metadata 只发布 observations，不发布当前统一 LiteratureMetadata 或把 LLM 结果转换为 observation。

### 3.8 验收

直接测试至少覆盖：

- 目标领域搜索 Provider 矩阵按“项目目标、Auto/Custom 有效选择、生产实现、readiness”分层选择；默认 Auto 集合与 Custom 精确/空列表均可离线确定，Key 不改变选择；OpenCitations 只参加精确 lookup/引用，不参加主题搜索；
- 领域发现无需也不能按 publisher 预选 Provider，全部已启用且就绪的 search adapter 各自在自己的覆盖范围内执行；明确启用但 adapter、必需普通参数/凭据或 AccessPolicy 缺失时开始前失败；
- 领域 DiscoveryRun 把 `sources.metadata.limit` 分别应用给每个参与 Provider，过滤、缺少标题/DOI、重复和未接纳 item 都消耗本 Source 上限；默认是 500，结果耗尽或达到上限后正常停止，Provider cursor、过程计数、搜索分数、未接纳候选和请求/响应不进入 Model 或 Storage；
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

### 3.9 查询隔离与请求时凭据

Metadata 的 search/lookup/reference 都可能访问外部服务，属于显式维护范围。库内 search miss、分析缺引用或提取未找到字段，不直接调用这些接口。只有原操作已声明引用发现/外部 lookup 的维护流程，才能继续物化目标文献；一般知识读取返回材料缺口。

普通 Provider 选择和 scan limit 来自本次 Application 配置快照，CLI 未指定 `--scan-limit` 时消费已保存值；显式参数只覆盖本操作，不改写配置。`sources.metadata.limit=7` 表示每个已选择 Source 最多扫描 7 条原始 item，不是最终去重后文献总数。

引用发现 Auto 的执行顺序由 Metadata registry 在既有选择集合内根据 Credential owner 的非敏字段存在性稳定排序：有凭据者在前，公开匿名者在后；Custom 顺序保持不变。Entry 对每个 BFS 节点按顺序消费完整分页，只有正常耗尽、有可用关系且已识别范围内全部目标时才短路后续来源。目标必要 lookup 优先使用关系来源，再按当前优先级尝试其它来源；跨来源 key 移除私有 `record_id`，只携带共同稳定标识。所有精确补查消费调用来源的剩余 raw-item 预算；没有共同标识时，不向其它来源发送私有 ID。

引用运行的 `failure` 汇总与本来源能否继续调用分别处理。目标 404、记录转换或单节点失败只留下诊断，不把整来源设为终止；鉴权/授权失败和 429 暂停该来源，扫描上限停止本来源，其他独立来源继续。存储异常不被吞掉，取消不触发后续来源。已有结果且存在失败时报告 `PARTIAL`；无结果且全部实际尝试来源失败时才为 `FAILED`。`source_results` 只包含实际引用查询或目标 lookup 尝试过的来源，完整选择范围仍保留在 `providers`；未调用不等于 `EXHAUSTED`。种子在引用环中再次出现时保留边和来源支持，但不作为新增发现结果计数。上述变化不新增 catalog schema 或配置字段。

需要认证的 adapter 在每次请求前通过 Configuration owner 复核当前字段。Elsevier/Springer/Web of Science 的必需凭据缺失在 transport 前失败；可匿名来源保留匿名行为。Startup readiness 与 request admission 使用同一必需字段定义，避免“配置页显示可用，调用却无需 key”的分歧。已成功来源的 observations 不因后续来源认证失败而撤销。

### 3.10 来源端点与关系结构

`ProviderLiteratureKey` 是供应商文献记录的中性定位，只包含可选 `record_id` 和稳定 `Identifier[]`，且至少具有其中一种定位。`MetadataObservation.version_links` 用它定位同文献其它版本；当前端点由父 observation 表达。`ProviderRelationObservation` 用两个 key 表达一条规范化 `citing -> cited` 有向引用边。两种用法都不接受本地 Literature ID、目标 MetadataObservation 或状态字段；Model validator 只检查封闭结构、至少一个定位值和非空格式，不决定版本归属、目标接纳或 Reference 建立。精确合同见 [MetadataObservation 来源输入](#252-metadataobservation-来源输入)与 [ProviderRelationObservation](#352-providerrelationobservation)。

## 4. 材料获取、路线与候选

### 4.1 独立材料供给与人类介入

按 [ADR 0026](../decisions/0026-agent-knowledge-and-human-collaboration.md)，Acquisition 独立交付已验证原始材料，Analysis 不适用不直接撤销已接纳资产。TypeScript 生产 completion 已取消 `NoUsableContent` 自动清理；下文保留旧清理服务的显式调用与兼容背景，不能将其描述为当前 Analysis 的副作用。材料失效仍须由独立 owner 的明确决定触发。

生产 Browser 向[统一产品接口：人类工作台与知识阅读](01-product-interface.md#4-人类工作台与知识阅读)提供同会话观察/指导/必要接管能力。控制权与在途动作由共享运行时管理，Acquisition 始终执行 PDF 文件门和任务绑定，文章内容身份保持未验证（ADR 0029）；人工点击或指导不能等同下载成功。公开/API/Browser 分层与 Network 边界保持。

子能力划分及交付见[统一产品接口：共享合同、结构解析与版本兼容](01-product-interface.md#6-共享合同结构解析与版本兼容)。有效获取以文件验收、任务关联和可靠发布为终点；已取得材料可直接交付。Analysis/Extraction 消费材料引用，不了解 route、Browser 或人工介入过程。新架构没有把其他业务模块纳入 Acquisition 控制。

### 4.2 当前实现与内部职责

```text
apps/server/src/acquisition/
  assembly.ts                 # Source 选择、凭据/Network adapter、路由拆分
  tiered.ts                   # 分层调用、候选结果和失败分类
  sources/public.ts           # 公开来源 registry 与受控下载
  sources/locators.ts          # 中性候选与定位线索
  sources/route.ts             # 路由 adapter
  providers/authorized.ts     # 授权内容 API
  pdf-acceptance.ts           # PDF 字节/reader 检查
  identity-verdict.ts         # deprecated 公共工具；不参与下载
  candidate-acceptance.ts     # 验收编排
  candidate-publication.ts    # 候选到不可变资产/关系的发布回执
  candidate-cleanup.ts        # 未接纳临时/候选字节清理
  candidate-abandonment.ts    # 显式放弃候选
  browser-intake.ts           # Browser/手动材料的统一 intake
apps/server/src/entry/pdf-acquisition.ts # 操作内 cohort、代次和 BrowserSessionBroker
apps/server/src/browser/                # page/runtime/flow/observation/control/transfer
```

访问方解析、计划、候选执行、文件验证、文章归属及最终发布是不同职责。当前 `PdfAcquisitionPort` 将这些能力交给 Entry，字段及行为不能因内部拆分丢失。下文 `PublisherAccessProfile/Resolution/Plan` 表达访问决策模型；它们不意味着当前目录存在同名 Python 文件。

普通 HTTP 和授权 API 经共享 Network，受控 Browser 经 Host/broker 与同一 admission。controller 只解释稳定 Observation 并返回下一封闭动作，不持有发布权限。配置、policy、route 可用性、文章权限和候选验收分别判断。

仅属于内存定位的 source candidate/tried set 不作为文献事实保存；已有 Browser transfer 的 `DurableCandidate`、`CandidatePublicationIntent/Receipt` 则按 execution 合同保存受控交付状态。两类候选不能一律描述为不持久化，也不能把恢复回执当作已接纳 PDF。

### 4.3 输入与公开结果

#### 4.3.1 自动获取

公开 API 接收具体 `Literature` 的中性 `LiteratureMetadata`、稳定标识符、当前 MetadataObservation 中的 Provider record identity 与 `AssetHint[]`、当前资产事实和本次运行临时排除的 candidate key 集合。它们只用于形成当前 `PublisherAccessResolution`、`AcquisitionPlan` 和候选，不把完整 vendor 对象带入 Acquisition。Resolution、Plan、route hint、Browser queue 和动态访问状态不是公开业务结果。业务成功/正常缺失的语义结构如下；这是设计记法，当前 TS 入口还以明确的执行 outcome 传递失败、暂停和取消：

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

`NoPrimaryPdf` 是无字段结果，但只能在以下条件全部成立后返回：当前元数据和已配置自动能力下的direct、publisher-api、general-api、public-web 与受控 Browser 的适用路径已经正常遍历；没有候选、正常返回“未找到”、浏览器流程正常结束但没有下载，或候选非 PDF、为空、损坏等预期未命中已经收敛；并且该 Literature 的 `AutomaticPdfAcquisitionExhaustion` 已经安全提交。它不暴露或持久化原因枚举与逐候选详情。

用户中断、Network 传输或 API 错误、权限或配置错误、数据库或文件系统无法安全提交、并发变化导致提交条件失效，以及共享 Network readiness/policy/coordinator 本身不可用，都属于本次操作失败而不是第三种 Acquisition 业务结果。属于一个 candidate、locator、target 或 route adapter 的外部失败可以在内存中保留为脱敏稳定失败，并继续其它独立获取路径；若后续没有任何路径成功，Service 必须向 Entry 抛出稳定失败，不能返回 `NoPrimaryPdf`，也不能建立耗尽事实。配置与 readiness 预检、取消、Port 合同、清理、发布和 stale 失败立即终止。因此只有已经完整收敛且从未留下未解决 route failure，并成功提交耗尽事实的 `NoPrimaryPdf` 可以支持 MetaLiterature 切换版本。

公开 API 不暴露 URL client、HTTP response、Browser page/download、临时绝对路径或来源私有对象。

#### 4.3.2 手动 PDF 接纳

手动接纳是与自动获取并列的独立 API。Entry 必须先把用户选择解析为一个具体 `LiteratureId`，并以只读方式打开用户输入文件；Acquisition 把字节复制到 owner-only 临时文件后再执行统一检查。输入路径和文件 handle 是适配边界值，不进入跨模块 TypeScript contract、provenance 或 Catalog。

成功结果为：

```text
AcceptedManualPdf
  asset: Asset
  relation: LiteratureAsset
```

`relation.role` 必须为 `primary-pdf`，`relation.source_url` 为空，provenance 使用 `source_kind = "user"` 和稳定 `source_name = "manual-pdf"`，并以内部复制字节的 SHA-256 作为输入 hash。只有内部不可变 Asset 和唯一关系都已经提交后才能返回成功。

以下情况直接形成稳定输入验证错误，不返回 `NoPrimaryPdf`：用户文件不存在或不可读、基本 PDF 检查失败、目标 Literature 不存在，或者该 Literature 已有当前主 PDF。文件发布、事务或 stale 复检失败仍是系统错误。手动接纳不进入自动 Source 顺序或自动 tried set，也不增加第四个 `AcquisitionPath`。当前 TypeScript `Application.maintenance.ingestPdf` 使用 transfer/acceptance/identity-validation 与不可变 publication；CLI 本地文件、公开 TS 字节和 Web 受控上传调用同一用例，不启动自动 Source、Parsing 或 Analysis。独立维护页不要求 Browser runtime，上传协议不接受本机路径。

Acquisition 只复制用户字节，不移动、改名、截断、覆盖或删除用户原文件。成功只形成 `ASSET_READY` 并清除已有自动获取耗尽事实；Parsing 与 Analysis 由后续独立数据库补全操作发起。

### 4.4 Access Profile、运行时计划与五层 Route

本节只描述自动获取。手动接纳不注册自动 Route，也不进入下列层级。

目标实现把“识别原文访问方”“制定本次路线”和“执行 HTTP/API/Browser”分开：

```text
PublisherAccessProfile catalog
  + LiteratureMetadata / identifiers / observations / AssetHints
  -> PublisherAccessResolution
  -> AcquisitionPlan grouped by acquisition stage
  -> route adapter execution
```

一个外部机构可以具有多个独立 route adapter，例如公开 locator、授权内容 API 和 Browser 页面流程；它们共享 access profile 和 Network，但不挤进一个带大量可选参数的 vendor 接口。Planner 不执行真实 Provider 请求，adapter 不重新猜测当前 Literature 应属于哪个访问方。

#### 4.4.1 PublisherAccessProfile 与访问身份

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

#### 4.4.2 PublisherAccessResolution 与 AcquisitionPlan

Planner 首先消费已经接纳的中性证据；已有明确 direct-file、公开仓储或稳定公开定位时，不为了识别出版社额外解析 DOI。需要确认访问方且当前出版社 API 规划缺少强证据时，DOI safe resolve 可以作为 API 之前的有界定位动作：读取受控 resolver 的安全 Location，不提前执行公共网站下载。public-web 阶段可以通过共享 Network 逐跳请求文章页面与静态 PDF；Browser 使用自己的文章平台许可与页面传输。已有响应、实际 landing 与安全 locator 只在当前 work item 复用，不增加必经 HEAD/GET 预检。全部证据可用时按以下强度解释：

1. DOI 经 Network 安全解析后的实际 landing origin；
2. 访问方自有的 `AssetHint` origin；
3. arXiv ID、PMCID、Elsevier PII/IEEE arnumber 等来源明确的稳定文章定位；
4. MetadataObservation provenance 中的 Provider record identity；
5. publisher 原文、明确别名或单独 DOI prefix 只形成待确认弱候选。

多个强证据冲突时保持 unresolved 或形成稳定失败，不能按 catalog 顺序任选一个。MetadataObservation 来自 Scopus 不表示文献由 Elsevier 出版；Crossref 返回 Wiley 文献也不改变原文访问方。

已知出版社名称使用 Provider 本地 `publisherAliases`，用户确认扩展在普通配置 `sources.publisher_aliases`。名称按 NFKC、空白和大小写确定性处理；显式维护扫描来源 observation 的原文与有界上下文，选择 AI 时只生成带输入 hash/provenance 的建议。独立接纳核对站点/别名冲突并用配置 revision 防止覆盖并发修改，不覆盖来源、文献身份或期刊原文。未知、冲突和未处理名称保持可见，不阻断其它有依据的获取路线；不新增 Literature 字段或 catalog 表。

名称解析唯一命中一个 Provider ID 时，只把当前 publisher-api 阶段中已选中的同名来源稳定排到前面；其余来源仍保持配置顺序，未知或冲突不改变优先级。此调整不删除来源、不自动启用服务，实际调用仍须通过 `authorizedTargets` 的文章级站点/专用标识证据。

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
  direct_routes
  publisher_api_routes
  general_api_routes
  public_web_routes
  browser_routes
```

每个 planned route 具有稳定 route key、获取阶段、独立认证/传输类别、适用证据、预期 capability、readiness 和 quota/risk-group identity，但不含 secret、HTTP response、Browser 对象或不可脱敏 locator。Planner 可以省略确定不适用的 route，不能把 Browser 排到一个仍适用的公开/API route 之前。相同输入产生相同 plan；层间新 hint 只增加新的 plan revision，不修改已接纳的 MetadataObservation。

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

这里使用稳定 Provider key；`springer` 表示 Springer Nature，`sci-hub` 表示默认关闭、必须由 operator 显式启用的 locator Source。启用后 resolver 使用当前版本 bundled mirror set；`sources.acquisition.sci-hub.urls` 可以用一到八个有序 HTTPS 镜像完整覆盖 bundled 列表，测试/内部显式注入 resolver 又优先于两者。三种选择都只对 canonical DOI 形成 landing locator，按序执行、不并发、不自动发现镜像。这里的“覆盖”表示相应服务能够贡献 PDF 字节、直接 locator、落地页或受控内容路径，并不要求每个名称都复制一套下载 adapter。Crossref、OpenAlex、DataCite 等 Metadata adapter 已经给出 `AssetHint` 时，由通用公开 route 消费同一线索；不为名称对称再实现只转发相同 URL 的 route adapter。Web of Science 和 OpenCitations 当前不作为原文来源。以上是目标矩阵，不证明当前代码或安装产品已经接入。

Acquisition named Source 由本地 Auto/Custom resolver 选择。当前 Auto 只启用 arXiv 与 Europe PMC
两个零配置公开协议；Custom 精确使用用户保存的集合、以每个获取阶段内的列表顺序为基础并允许为空，出版社 API 可按唯一名称候选稳定优先。无论哪种模式，所有已保存且通过
安全验证的 PDF/landing `AssetHint` 分别供 direct 与 public-web/Browser 使用，不依赖同名 Provider enablement。
Sci-Hub、Unpaywall、CORE/Elsevier/Wiley 授权 API 不进入 Auto，Browser 仍由 `[browser]` 独立
显式启用；凭据存在不改变 Source 选择。Registry/status/Planner 的选择解析不执行 DNS 或 HTTP，
运行时仍按 Literature 证据和 direct → publisher-api → general-api → public-web → browser 层级短路，不对每篇 Literature 穷举全部
Provider。

`public:sci-hub` 复用共享 `PublicLocatorFetcher`。每个镜像 hostname 自动得到独立的保守 web
scope；landing 可直接交付 PDF，或通过有限静态声明（`citation_pdf_url` 与明确
`application/pdf` 的 `a/link/embed/object`）发现 locator。它不执行 JavaScript、不猜 selector、不
处理认证或 Challenge。Landing HTML 与发现候选仍先经过实际 PDF 字节、reader 和页面树检查；
最终 provenance 不保存镜像 URL、query 或页面内容。Registry/status/Planner 组装不执行 DNS 或
HTTP，所有测试使用 fake/fixture。

`direct` 只是消费已保存 locator 的通用公开 route，不是 Provider；手动 PDF 是用户明确绑定 Literature 的独立接纳操作，也不是 Provider 或第四种 `AcquisitionPath`。

Acquisition 把每个 planned route 放入一个且仅一个执行阶段，和认证/传输类别分别表示。当前 TS 四个 HTTP 阶段为：

```text
AcquisitionStage = direct | publisher-api | general-api | public-web
```

Browser 是第五层，由 Entry 独立受控 delivery 接纳。旧概念 `AcquisitionPath` 继续描述传输/认证方式，不再表示执行顺序：

```text
AcquisitionPath =
    "public"
  | "authorized-provider-api"
  | "controlled-browser"
```

阶段由 Provider 本地 `acquisitionStage`、通用来源定义与生产对象图共同决定，不由 Provider 响应或 `AssetHint.access_status` 临时改写。Route adapter 可以使用：

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

#### 4.4.3 AssetHint 合同

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

| 字段            | 含义                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `url`           | 供应商返回的绝对访问地址；同一 observation 中的不同地址分别形成不同线索                                |
| `kind`          | `direct-file` 表示供应商声明地址直接指向文件，`landing-page` 表示需要从页面继续发现或触发下载          |
| `media_type`    | 供应商声明的媒体类型，例如 `application/pdf`、`text/html` 或 `application/xml`；未知时为空             |
| `asset_role`    | 地址所指向的主 PDF、补充 PDF、XML、HTML 或其它补充资产；供应商没有明确说明时为空                       |
| `version_role`  | 地址所对应的正式发表版、作者接受稿、预印本或其它版本；供应商没有明确说明时为空                         |
| `access_status` | 供应商在 `MetadataObservation.provenance.observed_at` 观察到的开放、受限或其它访问状态；使用开放字符串 |
| `license`       | 供应商返回的许可证标识或许可证 URL；没有可靠信息时为空                                                 |

Provider identity、provider record identity 和 `observed_at` 由所属 `MetadataObservation.provenance` 提供，不在每个 `AssetHint` 中重复。`AssetHint` 不保存请求 header、cookie、凭据或 vendor 私有对象；`url` 仍是不可信外部输入，每次 HTTP、redirect 或浏览器导航都必须重新经过 Network policy。

`kind`、`media_type`、`asset_role` 和 `version_role` 都是供应商声明的线索，不是 Acquisition 已验证的事实。`access_status` 和 `license` 描述具体访问渠道，不属于 `LiteratureMetadata`；它们也不证明链接当前可访问、响应是 PDF 或内容有效。

#### 4.4.4 Route hint、候选与 adapter 边界

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

Plan 固定按以下顺序组织 routes，同阶段以配置顺序为基础，出版社 API 可按唯一名称候选稳定优先，凭据类别不决定阶段：

1. **direct**：受支持资产线索中明确 PDF 媒体类型/主 PDF 角色，或 URL pathname 中忽略大小写的 `.pdf` 后缀；arXiv ID 与 PMCID 的稳定公开 PDF 定位也属于本层。保留 query、去除阅读器 fragment，排除明确非主 PDF 角色、目标版本冲突与已登记授权 API 地址；
2. **publisher-api**：Elsevier、Wiley 等专用 API，仅调用已配置、就绪且有文章级适用证据的内容服务；
3. **general-api**：CORE、Unpaywall 等聚合/开放获取 API，是否需要凭据仍按所属 adapter 合同；
4. **public-web**：DOI/文章 landing 的有界 HTTP 与静态 PDF 解析、显式启用的 Sci-Hub 等网站；
5. **browser**：只处理前四层结果允许继续且独立准入的剩余目标，消费有序文章入口，使用一个
   operator-managed 固定身份 Profile、共享有头 CloakBrowser Chromium process/context 和隔离文章 page。
   Browser 只使用通用 `AgentBrowserController`；Agent 从第一次稳定 Observation 起选择封闭动作，
   Network 负责动作绑定、页面稳定化与捕获，Acquisition 负责 PDF 文件验收与当前任务关联。无 GUI Linux 使用
   Xvfb；登录、MFA、拒绝或未找到等页面状态仍交给 Agent 观察，只有 Agent 明确 Stop 或硬性运行时
   边界才结束本次会话。

每篇 Literature 依次完成 direct、publisher-api、general-api、public-web，最后才形成 Browser admission 集合。每层产生的新 landing、stable ID、locator 或 entitlement hint 更新 Resolution/Plan；新取得的 locator 立即由原机制下载，不重新排队到 direct，成功的目标立即离开后续 Acquisition 层。Planner 可以删除确定不适用的 route，但不能因为当前网络出口可能具有机构 IP entitlement 就跳过一个仍适用的公开/API route。

CORE 的明确公开 PDF `downloadUrl`/source link 由 direct 消费；尚未获得有效主 PDF 且结果允许继续时，
在 general-api 阶段调用已配置的 CORE 注册用户 download endpoint。CORE
Metadata 与 Acquisition 使用相同 `core/api` AccessScope 和保守准入政策，使 token/quota
反馈作用于同一当前进程预算。API key 只作为绑定到官方 HTTPS origin 的私有
`Authorization` header 传递，不进入 URL、候选、provenance 或输出。

Wiley 位于 publisher-api 阶段，先于通用 API 和公共网页。当前唯一 DOI 可以与已接纳 AssetHint 的
Wiley Online Library（含已登记子域）、官方 ALM origin 或精确绑定的 TDM 提示关联；若现有
证据仍不足以确认 Wiley，按需通过共享 Network 执行一次有界 DOI 定位，结果必须符合 Provider
本地声明的域名/origin 规则。名称别名只能提出候选，不替代这些文章级证据。两条路径都只形成 DOI 与 confirmed origin
组成的中性 lookup target，再把 DOI 作为 opaque path parameter 交给 Wiley TDM endpoint。
唯一的 TDM token 只作为绑定到
`https://api.wiley.com:443` 的私有 `Wiley-TDM-Client-Token` header 传递；本地只验证
安全的非空 header 值，不用推测的 token 语法替代 Wiley 的认证判断。API 可以单跳到精确
`https://alm.wiley.com/alm/api/v2/download/<opaque-locator>`；共享 Network 逐跳复检该
Provider 专属路径，并在跨 origin 前移除 token。Wiley 本地 lookup 保持 entitlement
`UNKNOWN`；服务实际交付该目标的 PDF 才证明本次取得文件，媒体类型本身不证明 entitlement。`404`
是正常 miss；认证、授权、quota、服务、schema、非 PDF 和 Network 失败形成该 route 的
稳定失败；能否继续与升级由 ADR 0015 §7 分别判断，认证、权限、限流和 API 临时错误不得由 Browser 静默掩盖。即使响应
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
header、URL/query 与凭据都不进入 LogRecord。ScienceDirect 的 API route 与 `elsevier` rate/session group 独立于唯一通用
`browser:generic` route；其 landing hint 仍只能在强访问方证据、显式 Browser 启用与 Browser
admission 共同满足时使用，不能把 API miss、quota 或错误本身当作自动启动 Browser 的授权。

前一层全部当前适用 routes 均未成功并到达允许升级的终态后才能启动下一层；层级之间不并发竞速。未启用或对当前 Literature 不适用的 route 不属于本次耗尽集合。当前 plan 需要但缺少生产实现、必需参数、凭据或 policy 的 route 形成明确 unavailable/configuration 结果，不能被静默视为正常未命中；是否允许继续 Browser 由 Browser admission policy 决定。

正常未命中与已识别来源失败都允许后续独立渠道继续。API 请求、认证、权限、服务及外部响应格式错误不决定 Browser 的机构 IP 访问能力；`retryable` 只决定是否适合重试本来源。`429`、`Retry-After` 与 quota 停止本来源剩余候选并保留冷却，所有后续请求仍经过共享额度组/平台准入。取消、内部合同、存储、清理、发布和 stale 错误保持停止语义。任一候选完整提交后立即停止该 Literature 的后续获取；最终未成功时保留未解决故障，不伪装成正常耗尽。人工协助仅在自动路径尝试结束后应用，见 ADR 0015 §7。

明确标记为补充材料、XML 或 HTML 的线索不能作为当前主 PDF 接纳。供应商声明的 `application/pdf` 可以提高同层候选顺序，但不能替代实际下载和基本检查。

`AssetHint` 不增加 `acquisition_path`、`requires_browser` 或 `requires_authorization`。它保存来源当时声明的线索；同一线索可以先匿名尝试，之后由相应授权或 Browser route 使用，但每次真实访问仍受自己的 Network scope 和 candidate key 约束。

每个 `sources/<source>` 或 `providers/<provider>` adapter 负责 endpoint、请求字段、API AccessScope 和官方政策声明、quota/`Retry-After` 解释、候选/hint 转换和来源失败边界。`PublisherAccessProfile` 只保留授权 API 所需的 access identity/origin，以及可选 Browser 首页可达性 probe；它不拥有 Browser 下载策略。Network 负责中性准入和 Browser runtime，Acquisition 的统一 PDF identity validator 负责主文献、supplement 与错文判断。普通 HTTP、API SDK 和 Browser 执行必须经过 Network 的共享访问准入。

Adapter 不能把候选直接写成当前主 PDF，也不能执行 Literature 身份判断、正文语义判断或状态推进。

#### 4.4.5 Asset 与 LiteratureAsset

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

### 4.5 获取流程

```text
冻结目标中的一个 Literature（有界 worker 独立推进）
  -> 为每个目标形成初步 PublisherAccessResolution + AcquisitionPlan
  -> direct pass：当前目标先执行已有文件/稳定公开定位
       ├─ PDF 成功：检查、发布并移出后续层级
       ├─ route hints：更新当前 work item，重新规划
       └─ 正常未命中/失败分类：保留当前运行结果
  -> publisher-api pass：只处理未解决且允许继续的目标
       ├─ PDF 成功：检查、发布并移出后续层级
       ├─ locator/identity/entitlement hint：重新规划
       ├─ 普通 route-local failure：保留问题，继续独立 route
       └─ deferred/action-required：在 Browser admission 前停止
  -> general-api pass：继续适用聚合/开放获取 API
  -> public-web pass：继续有界公共网页与静态 PDF 获取
  -> 复用实际请求结果，准备有限且有序的 Browser 入口
  -> Browser admission：仅当前目标前四层结束且允许继续时进入
  -> CONTROLLED_BROWSER pass
       ├─ 所有文章使用 browser:generic + Agent controller
       ├─ browser-generic 聚合政策 + 同平台文章网络串行/结束后30秒冷却
       ├─ 独立worker跨平台执行一轮，后台下载暂停该篇模型决策
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

一个候选正常未命中、没有 Browser 下载、格式错误或基本检查失败时清理临时结果并继续其它候选，不把详情带入下一个候选或数据库。一个 candidate、locator、target、DOI landing 解析或 adapter 的 Network/API/认证/授权/quota/service/schema 等外部失败，在不放宽 Network policy 的前提下转换为当前运行的脱敏状态；按 ADR 0015 §7，已识别来源失败允许独立 API/Browser 继续；当前服务的限流和冷却仍有效。后续成功交付才清除该目标的未解决失败；全部未成功时保留首个未解决来源失败，不能成为“已耗尽”证据。Browser 的观察与终态仍保留在当次 Debug 事件中。这些状态只进入安全日志、内存聚合和本次非持久化 Report，不成为持久化候选历史。

后续 route 成功时正常短路；最终没有成功时选择稳定失败、deferred 或 action-required 结果，绝不能在尝试其它候选后伪装成完整耗尽。配置预检、取消、Port 合同、临时文件清理、发布和 stale 失败不属于可隔离的 route 失败，必须立即终止。不同候选可以有各自来源，但同一 `Literature` 只有一个主 PDF 驱动解析。候选通过基本检查并完整提交后立即形成 `ASSET_READY`，不等待正文内容判断。补充 PDF 或其它相关文件可以保存为补充资产，但不驱动 Parsing、Analysis 或 Literature 状态。

单个 Literature 内同一层的 routes 与候选按 plan 确定顺序短路，不进行跨层竞速。Entry 可以有界
在有界目标 worker 中并行处理不同 Literature；API 并发最终由官方 quota scope 门控，Browser 尝试由
`browser-generic` 聚合政策与文章平台资格共同准入；同平台网络串行，不同平台可由独立 worker
推进。等待 Network/Browser permit 不等于候选失败。

Debug 诊断为 cohort、tier、route、route adapter、授权 source/target/lookup/download 和 Browser source/candidate 记录单调时钟耗时。每个 route 终态显式使用 `disposition=delivered|miss|deferred|action-required|failure|fatal` 与 `next=next-route|next-tier|browser-admission|stop` 说明实际控制流；授权 API source 同时报告 strong-evidence target 数、attempted 与 delivered。正常模式不逐条显示 route miss 或候选内容；保留交付、Browser 分组/等待、最终耗尽和稳定失败。Browser 另以低频 INFO 记录不含定位信息的传输/Intake/发布计时，见 ADR 0030。日志不能改变 route 聚合、Browser admission 或耗尽判断。

**2026-10-13 当前编排：** 生产 Completion 由有界 worker 逐篇调用 `EntryPdfAcquisitionService.acquire`，
每篇内部保持五层顺序、来源隔离、实际入口证据和不可变发布，完成即反馈并补入新目标。单篇恢复不推进全操作
代次；新任务不会使仍在下载的兄弟会话过期。共享提交、取消与当前输入复检继续由原 owner 执行。

显式 `acquireCohort` 仍接受有限请求，前四层按阶段交付结果，Browser 逐篇通知；最终数组复用同一终态并保持输入顺序。
生产 Completion 不再以该接口等待跨目标 participant。已提交事实不因后续失败撤销，未解决来源故障也不被当作耗尽。
具体目标调度以 [ADR 0015 §3](../decisions/0015-publisher-aware-tiered-pdf-acquisition.md#3-单篇保持五层顺序批量有界持续补位)
及 [任务协调 §4.1](02-task-coordination.md#41-内容处理编排) 为准。

**当前实现与现场边界（完整生产 Browser 对象图）**：生产对象图与 capability-scoped
Completion 对象图都显式组装并共享同一 Profile catalog/Planner、五层获取执行器、
Browser scheduler、session broker 和 admission controller。当前生产 Application 已组装惰性
Browser host factory、Network admission、Entry delivery/Intake 边界、单篇获取执行器和
`BrowserSessionBroker`；缺少 verified runtime 或 admission 时稳定不可用。固定版本
Cloak bundle 的本机 loopback 已验证正式 Application/Entry 经 Host、capture、Intake、
acceptance 到主 PDF 提交；真实 Publisher 站点仍未运行（见
[TS 架构锚定基线 1.2](../typescript-baseline.md) 与
[ADR 0025 §2](../decisions/0025-typescript-entry-and-runtime-contract.md)）。
Publisher profile catalog 继续服务授权 API 识别与可选首页可达性 probe，但不生成 Browser 下载
route。目标生产 Browser 只有：

| Route             | Controller               | Policy group      | 运行准入                                              |
| ----------------- | ------------------------ | ----------------- | ----------------------------------------------------- |
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
attachment、跨 origin CDN、统一 PDF 文件验收、任务关联与未验证标签、通用 cooldown/circuit、共享
persistent context 中的文章隔离/临时资源清理和本地 Chromium foundation 属于目标验证范围；组件级离线 fixture 与固定 bundle 的 loopback 证明局部实现、正式接线和本机 runtime 可运行，但不证明 Profile 已登录、当前 IP、机构协议、任意真实站点 Agent 策略或具体文章 entitlement。

#### 4.5.1 手动接纳流程

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

用户文件从始至终不属于 Storage staging 或 ArtifactStore，不参加对账与回收。旧兼容清理只可能作用于内部副本；新分析不授权删除，内部副本的处置也须经过独立材料决定与依赖检查。

## 5. 资产验收、发布与有效性

### 5.1 PDF 基本检查

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

上述字节门不验证文章身份。按 [ADR 0029](../decisions/0029-unverified-pdf-acquisition.md)，
下载阶段不提取文字或匹配 DOI/标题/作者/版本；Browser Intake、自动及人工接纳和发布都使用
`pdf-acceptance.ts` 的文件检查。当前任务绑定、metadata snapshot/CAS 和不可变发布继续检查。
新的 publication intent 保存 `identity: "unverified"`；详情 `LiteratureAssetView.article_identity_status`
在没有后续核验时对 PDF 返回 `"unverified"`，非 PDF 返回 `null`。旧详情没有标签时保守投影，
旧 accepted 回执可重放但不代表后续解析验证。Catalog v9 的显式核验由 Parsing 提供证据、Literature
接纳判断，详情展示与当前输入绑定的结果；解析成功本身仍不等于身份核验。详见
[解析后的文章身份核验](04-document-evidence.md#解析后的文章身份核验2026-10-08-实现合同)。

### 5.2 发布与并发复检

基本检查通过后，Service 形成独立 `Asset` 和 `LiteratureAsset` 发布请求。Storage 先不可变发布字节，再在短事务中复检：

- Literature 仍存在；
- 当前统一元数据仍与获取输入一致；
- 当前主 PDF 没有被另一结果替换；
- Literature 尚未具有与当前主 PDF 对齐的有效 `CONTENT_READY` 内容；
- 发布的文件 hash 与请求一致。

只有文件发布、唯一 `primary-pdf` 关系和已有自动获取耗尽事实清除都成功后，Service 才返回 `AcquiredPrimaryPdf`。Stale 结果拒绝建立关系并作为系统提交错误返回；已发布但未引用的相同内容由 Storage 对账处理。发布失败、事务失败、hash 冲突或 stale 都不能降级为 `NoPrimaryPdf`。

手动接纳走同一发布、耗尽事实清除和复检边界，但成功返回 `AcceptedManualPdf`。它还必须复检目标从调用开始到提交时都没有主 PDF；竞争产生主 PDF 时拒绝手动结果，不能覆盖。手动关系的 `source_url` 固定为空，机器绝对输入路径不参与去重键、hash 或 provenance。

全部当前自动路径正常结束且没有主 PDF 时，Acquisition 使用独立短事务幂等写入 `AutomaticPdfAcquisitionExhaustion(literature_id)`，成功后才返回 `NoPrimaryPdf`。用户明确重试该 Literature 时，Entry 通过 Acquisition 公开操作先清除该事实，再发起新的自动获取；清除失败属于 Storage 错误。该事实不携带来源、原因、候选、时间、次数或配置快照。

### 5.3 旧 completion 清理与独立材料有效性

旧 completion 曾在显式注入 cleanup adapter 且 Analysis 返回结构有效的 `NoUsableContent` 时，协调 Acquisition/Storage 撤销当前主 PDF 关系并继续其它候选。现行生产 bootstrap 不再向 `ContentAnalysisService` 注入该 adapter，单篇 completion 遇此结果只终止本次内容尝试并保留 PDF、来源、ParserResult 和旧有效结果；数据库补全不把该 hash 放进重取排除集，也不跨版本回退。该结果表示当前 ParserResult 对本次兼容 Analysis 不适用，一页 PDF 不自动无效。

若将来显式失效当前手动 PDF，清理只可作用于 ArtifactStore 中的 SciRetriever 内部副本、关系和派生结果；用户原文件不在数据库中，也绝不能由此流程删除。手动来源没有自动 candidate key，再次手动接纳只能由用户明确发起。

现行 `NoUsableContent` 只作为本次分析反馈：`DatabaseCompletionReport.no_usable_content_literature_ids` 可与最终 `failed` 分区重叠，失败码为 `completion-candidates-exhausted`；durable Job 既有适配把该非系统目标失败记为 `skipped`，并保留同一失败码。没有成功的 `LiteratureContent` 就不报告 `CONTENT_READY`。已接纳 PDF 的 Asset、关系、hash、provenance 与 ParserResult 不变，也不因本次失败写自动获取耗尽。下次明确维护操作可在同一 PDF 上重试 Analysis，但本次不会不断重新获取。ParserResult 乱码、截断、只剩资源引用或不足以判断，以及 Parser 或 LLM 调用失败，同样保留 PDF。

一旦 Literature 已经形成与当前主 PDF 对齐的有效 `CONTENT_READY` 内容，普通候选发现不得自动替换该主 PDF。替换已接纳内容所依据的资产属于单独的显式产品变化，不由本候选循环隐式触发。

仅当 Acquisition 独立拒绝尚未接纳的错误候选时，自动路线才会继续其它候选；Analysis 的内容判断不触发本次重取。后续新操作不恢复自动路线的临时 tried set；如果 Literature 已有自动获取耗尽事实，只有用户明确重试或新的 MetadataObservation 清除该事实后才会再次自动获取。当前进程的重试仍须遵守 ADR 0012 的共享准入。

### 5.4 Network、官方政策、凭据和资源

- Route adapter 使用 Network 的 HTTP 或 Browser；
- 普通配置只表达 capability 启用、产品、Browser 总开关、opaque Profile identity 与只能收紧的
  AccessPolicy override；Provider secret 由根级 configuration 从固定
  `~/.sciretriever/credentials.toml` 私有解析，再由 Bootstrap 注入具体 adapter；Browser Profile
  可以由 Chrome 保存 Cookie/session 状态，但 Acquisition 不读取、解释或输出这些内容；
- Adapter 的本地 readiness、真实认证和具体 Literature 全文 entitlement 是三个不同判断；`config test` 最多验证当前服务 readiness，不能证明任意文献可下载；
- API adapter 声明稳定 quota identity、`provider_name`、`api` channel、必要的 `service_name`、允许 origin，以及从官方规则核实的 concurrency、interval、burst/window、period quota、reset 和 feedback；Metadata/Acquisition 共享官方额度池时使用同一 scope；
- Provider Notes 保存易变官方数字、endpoint、响应头和证据日期；没有可执行 policy 的 production adapter/Profile readiness 不通过，普通配置不能提高速率或扩大额度；
- 所有 routes、Metadata、Parsing 和 Analysis 共用 `bootstrap/application.ts` 为当前进程组装的 Access Coordinator；adapter 不建立局部 limiter，也不能让 vendor SDK 绕过准入；
- 普通网页使用实际 host 的 `web` scope 和声明政策；Browser 额外使用 `browser-generic` policy，
  默认按实际平台网络活动文章 1、网络结束后冷却 30 秒执行，旧显式聚合 `max_concurrency=1`
  仍限制整个会话寿命；不同平台的独立 worker 继续服从共享模型 scope/host 预算；
- 公开 `AssetHint` 指向出版社网站时仍受该出版社网页 scope；不同来源落到同一最终 host 时还共享实际 host 预算；
- `Retry-After`、quota 响应和 `blocked_until` 由 adapter 解释、Access Coordinator 执行；等待 permit 不转换为 `NoPrimaryPdf`，quota/API 失败按 ADR 0015 §7 保留原因并继续独立来源，不能绕过相同 scope 的冷却；
- 所有 redirect 和最终下载主机继续受 URL/DNS/origin policy；
- Provider quota 的含义属于 adapter，进程内执行和 host 预算属于 Network，cohort、worker/平台与会话资源资格属于 Entry/Broker，文章 session/page/transfer 状态属于 Browser，文件接纳与 publication 属于 Acquisition/Literature；
- PDF 响应、hash、reader、candidate 恢复、发布和导出使用受控文件/分块边界；旧 16 MiB/512 MiB 不作为正常大文件能否获得的业务规则，实际字节、磁盘、无进度和总寿命保护见 ADR 0030；
- 临时文件位于 owner-only 临时目录，由所属会话/文件 owner 在真实写者结束后结清；publication 失败保留有效 candidate/receipt，不重新下载或当作无主 PDF；
- 凭据不进入来源 provenance、URL、文件名、数据库或用户输出。

### 5.5 材料交付、调用边界与后续消费者

#### 5.5.1 当前 TypeScript 获取入口

`PdfAcquisitionPort.acquire(PdfAcquisitionRequest)` 接收具体 literature_id、当前 LiteratureDetail、metadata_snapshot 和 AbortSignal。操作内部可附 generation、operation_id、串行 commit 及已排除字节 hash；这些不是持久文献字段。`acquireCohort` 在有限请求集合上执行 direct/publisher-api/general-api/public-web/Browser 屏障，并通过 on_outcomes 提前交付已完成结果（HTTP 阶段波次、Browser 单篇）；最终数组保持冻结顺序。

`splitAcquisitionRoutes().stages` 提供四个 HTTP registry，保留旧 `routes/public_routes/authorized_api_routes` 兼容视图。`AcquisitionSourceRequest.target_version` 用于线索选择；`PdfDownloadOptions.on_response` 在每次真实 transport 响应返回、失败分类前报告 requested/final URL、状态与媒体类型，`on_landing` 继续兼容。该观测只服务当前 Entry 操作，不持久化、不打印敏感 URL，也不额外 HEAD/GET。

DOI 定位只对 doi.org 发出一次 GET。首跳响应由当前操作保存并复用：实际 PDF 立即交统一下载验收和发布，成功后跳过剩余 API/网页；200 HTML、403/404、缺少可用 Location 或回到同一 DOI 的响应也不重复 GET，后续公共下载器消费原响应并沿原错误/静态解析规则处理。确认了不同且安全的 landing 才丢弃首跳缓存并改用该入口。响应字节预算复用公开 PDF 的默认 64 MiB 上限，状态或敏感响应不进入长期事实；即使已交付 PDF 带 Retry-After，已有字节可以验收，而共享 Network 冷却仍执行。

普通 HTTP landing 可以作为经准入的 Browser 入口；无凭据公共下载器仍只处理 HTTPS，不把 HTTP 地址交给 HTTPS 下载器触发内部类型错误，也不因此放宽网络协议或凭据策略。

`PdfAcquisitionOutcome` 当前包含 acquired（带 publication receipt）、exhausted、route-failure、assistance-required、policy-skip、browser-failure、cancelled。只有 acquired 证明发布已确认；exhausted 仍须由适用业务边界安全建立耗尽事实。其余表示执行结果，不是新的 Literature 状态，也不允许被解释成正常没有 PDF。

`not-applicable`、`no-capability` 和 `http-route-unavailable` 必须由 route 明确声明。最后一种仅适用于公共 HTTP 403、无可交付 PDF 的静态页面流程、以及 Network 证明的重定向上限，且不存在 Retry-After 等限流反馈；不证明机构无版权。公共 5xx 或明确传输故障另用 `allows_independent_fallback` 表达独立后备许可，仍是未解决 failure，不冒充上述声明；普通异常、认证失败、配额或 timeout 不允许按错误码字符串猜成低风险不可用并升级 Browser；同层更早的未解决错误不能被后来的不可用声明覆盖，Browser 自身仍须独立 admitted。具体修订见 ADR 0015 §7。

##### 已接受的 Browser 并行与交接目标

[ADR 0023](../decisions/0023-generic-browser-agent-executor.md) 与
[ADR 0030](../decisions/0030-browser-transport-and-progress.md) 于 2026-10-05 接受下列修订。
2026-10-11 再修订首次模型前入口准备，2026-10-13 将默认预算收敛为 300 秒/30 次模型调用，动作只统计而不独立设限。本节说明目标合同，当前生产接线与验收状态以
[本轮实施计划](../../archive/2026-10-11-metadata-governance-pdf-routing/README.md)、[此前并行交接记录](../../archive/2026-10-05-browser-parallel-downloads/README.md)、源码和测试为准，
不把配置中的默认 5 或外层 Promise 并发当作实际并行证据。

- 一个 Profile/process/context 内保留多个文章 session。默认会话 cap 5、允许 1，首版实际
  cap 为 `min(配置, 8)`；旧大值可读取且显示生效限制，不改写文件。worker 数为
  `min(2, 有效 cap)`，每会话最多一个主 transfer。
- session 固定绑定 operation/generation、Literature、metadata snapshot、页面/opener、
  transfer 和 candidate。首次请求继续前确认所属 session 和平台；前台/观看选择不改归属。
- 首次模型派发前，`start_urls` 提供完整有序入口列表并兼容单 `start_url`；去重保留 query，同一 driver/page/clock 逐项最多尝试一次并记录实际到达 URL。Browser 实际 404/410 或 Host 已分类 DNS/连接失败允许有界备用，403/验证页/未知页面交模型；首次实际 dispatch 后不自动换入口。换入口前结算真实在途捕获，下载优先完成，开页/观察计入同一活跃预算，所有网络操作继续取得对应平台准入。
- worker 原子领取一轮观察/决策/动作，下载 started 暂停本轮并让出 worker。单调会话时钟
  累计推理、动作、主动反馈/节奏等待的并集；队列、模型 permit、平台停放、人工接管、下载及
  本地验收/发布不计时。默认上限为 300 秒活跃时间、30 次实际模型派发，先到上限停止进一步探索，动作保留统计而默认不独立设限。
  动作完成后至少 5 秒才派发下一轮模型，页面反馈与节奏等待重叠。
- 传输失败、文件损坏或 excluded hash 由对应 owner 结清拒绝候选，原页携剩余预算/反馈
  恢复，重新取得平台资格计一次 start；普通 step 不重复计。有效 candidate 结束探索，
  Browser 返回候选与内部 lease；Entry 执行原 acceptance/publication，在 finally 通知关闭。
  lease 不暴露给模型/前端，不等待另一篇，也不 abandon 已交付的有效候选。
- 平台网络资格在真实网络结束且保留页不能后台发请求后释放，开始 30 秒冷却；本地验证、
  publication 和文件清理不延长该资格。publication 失败保留 candidate/intent/receipt，
  提交后清理失败单独报告，均不得重下或撤销已确认资产。
- 跨平台主导航先撤销旧文档网络资格并结清旧网络。已准入 GET 因旧子资源无法结束而受阻时，
  CDP owner 可取消尚未发送的新请求，等待其精确 terminal、停止旧网络，再由 Host 在同一页面
  重启一次相同 URL；目标平台仍通过正常准入/start。恢复绑定 session/page/operation/generation、
  源文档代次和请求身份，旧观察不得触发模型，取消后不得重启；POST 不重放。
  在途 PDF 优先完成；若候选被拒，原文档仅保留可恢复资格，重新排队取得平台资格后才可继续访问。
  Chromium 在替换文档时可能取消 Script/XHR 却不发出对应的 Network terminal；Browser 仅在
  精确 frame/loader 的默认 Runtime context 已销毁、且同 frame 已提交不同 loader 两项证据
  同时成立时，且同一请求的 Network 类型与 Fetch 拦截类别一致、均为 Script/XHR，才结清旧记录。
  root Fetch 有时将 keepalive Fetch 上报为 XHR，不能单凭该类别推断寿命。Fetch、Other、native 和 IO PDF 保留自身终态，
  缺少文档/context 证据时不能据此释放资格；不用 URL、前台页或等待时长推断请求结束。
- Workbench 选择一个确定 session 并投影同一页面、控制 epoch、反馈与时钟；人工接管只
  暂停该篇自动派发。operation、单轮决策和 transfer 分别取消，Application 整体关闭才
  结清所有会话并关闭共享 context，保留 Profile 和已提交事实。

当前生产 Workbench 通过 `ProductionWorkbenchSession.queued/registered/open/removed` 投影
调度器已经拥有的身份、文章执行器和最终结果。尚未打开页面的等待项也可以选择或明确取消，
没有 observation 时不能接管或输入；页面打开后预算直接读取该执行器的 `BrowserArticleClock`，
不构造第二套决策循环或墙钟截止。每个观看 client 独立选择 session，选择不转移控制权。
`POST /api/sessions/select` 只提交 `session_id`；指令、指导和控制请求继续验证明确的
session/article/control epoch，截图请求在多会话下必须带当前所选 `session_id`。
中性 `WorkbenchView` 的可选 `sessions/session_phase/session_outcome` 保留旧单会话字段兼容，
会话投影最多64行，与已有 completion cohort 支持范围一致；只淘汰已关闭行，不截掉运行任务。
closed outcome 只投影 published(receipt_id)、retained(code) 或 cancelled；Page、lease、
Cookie、敏感 query 和文件绝对路径均不进入这份合同。可选 `session_cleanup_failure` 单独投影
本篇资源清理的稳定code，已published的receipt和Library事实保持可见，不被随后cleanup错误替换。
Agent的JSON观察包含动作统计、真实模型派发和活跃时间预算，旧Workbench bytes字段保留兼容，
不作为模型的文件大小上限。

#### 5.5.2 获取与材料读取分开

维护请求先明确用户启动意图、目标范围和允许路线，再获取；读取只需要 Literature/Asset ID 与 hash。查询、Analysis 和 Extraction 不注入 `PdfAcquisitionPort`，其输入缺失返回 gap。已保存、人工提供或其它正式入口接纳的 PDF 均可独立参与解析/分析；消费者不需要知道原 PDF 来自哪一层 route。

MaterialRef 的目标设计将已接纳 Asset/关系和 hash 作为最小材料身份。原始字节通过 scoped verified reader 提供，不能暴露绝对路径或让下游直接读 catalog。文件级证据不需要 MinerU/ParserResult；页码或区域证据只有在 Document/Evidence 已支持对应定位时才可声明。

#### 5.5.3 资产有效性与分析适用性

候选的非 PDF、损坏或空页树可以在接纳前拒绝；文章正文身份不作为下载门槛。尚未发布的 staging 由该次操作清理。已接纳材料的删除则需要独立的、精确到资产与引用的失效/删除决定。

当前 completion 不再由 `NoUsableContent` 自动调用清理链。Analysis 用途不适用、内容不足或模型失败只形成该分析结果，不授权 Acquisition 或 Storage 删除 PDF。Acquisition 的 PDF 基本检查继续独立拒绝非 PDF 和无效文件，文章身份不作为下载门槛；失效已接纳材料仍须明确业务决定。

#### 5.5.4 人类介入和交付原子性

人类通过同一生产会话观看、指导或接管，得到的下载继续进入 CandidateAcceptanceService 与 publication。控制成功、download事件和临时文件存在均不能作为获取成功；bytes 校验、当前任务关联、输入复检、不可变发布和关系提交缺一不可。

提交前取消清理本操作尚未接纳的临时资源；提交中取消等待提交结果并报告事实，不能把已发布回执伪装为完全未发生。相同目标路径不同字节拒绝覆盖并保留冲突证据，重试须比较原 intent/输入绑定，不能仅凭文件存在补造成功。

## 6. 书目交换与持久化协作

### 6.1 书目交换规则

导入记录由 Entry codec 转换为现有 `LiteratureMetadata`，并由 `packages/contracts` 的书目边界合同 只组合输入序号等边界信息，再交给 `literature/bibliography.ts`：

- 形成普通 `MetadataObservation`，其 provenance 固定为 `source_kind = "user"`、`source_name = "bibliographic-import"`、`source_record_id = None`，不建立 `ImportedMetadata`；
- 使用同一保守身份规则创建或命中 `Literature`，不能因来源是用户而强行合并稳定标识符冲突的记录；
- 未命中时返回 `created`；命中后，非空导入值补齐缺失字段或替换当前 Provider 值时返回 `enriched`；命中且当前统一投影不变时返回 `matched`。首次与当前 Provider 值相同的用户记录仍保存 user observation，只有相同规范化 user observation 已存在时才复用既有事实；输入不合格、缺少最低识别信息或稳定标识符明确冲突时返回 `rejected`；
- 导入 observation 的非空书目信息优先于全部 Provider observations，Provider 只能补缺；导入 keywords 可以进入统一初始 metadata，完整 Analysis 后仍由全文关键词替换；
- `CONTENT_READY` Literature 可以接纳新的非重复导入 observation，但不能因此单独替换当前最终 metadata/content；下一次完整 Analysis 把该 observation 作为最高优先级初始输入；
- 单条错误只拒绝该条；
- 外部工具数据库 ID、附件绝对路径、同步状态、插件字段、界面设置、笔记和集合层级不进入核心数据库；
- 不长期保存原始书目文件、外部工具对象、导入批次历史或其它过程来源细节。

只要 `Literature` 已形成可转换的当前 `LiteratureMetadata` 即可导出，不要求 PDF、解析或内容总结完成。未达到 `CONTENT_READY` 时导出统一初始 metadata，达到后导出已验收最终 metadata。默认每个 `MetaLiterature` 选择一个最佳可导出 Literature；用户明确要求时可以导出全部 Literature。目标格式无法表达的字段必须形成明确损失说明。

### 6.2 Ports 与事务

Literature 拥有：

- Literature repository；
- 统一 read model；
- Artifact read Port；
- Identity transaction；
- Reference publication；
- Reference support publication；
- Content acceptance publication；
- Import/export publication。

来源 observation、身份、统一元数据和 DiscoveryRun 结果/原因的组合提交，以及最终 metadata、keywords、LiteratureContent、规范 Markdown 关系和内容完成依据的组合提交，由 Entry 调用复合持久化 Port 整体完成。Reference 在两个 Literature 身份都已接纳后，通过独立 publication 与第一项 ReferenceSupport 整体、幂等提交；后续 support 可以向同一 Reference 幂等追加。引用提交失败不回滚目标文献、来源原文或已经接纳的内容。Storage 只能保存 Literature 已形成的决定。

### 6.3 Literature 内容接纳

Application 的 `writes` 为 FileStore 与 SQLite 共同提供 catalog 写入准入。`DatabaseCompletion.run`
只在冻结 selector 时持准入，`runFrozen` 不包裹整个运行；网络、模型、文件准备和后台下载不持
cohort 长写锁。Candidate 的 hash/文件复制和目标检查在准入外准备，最终 create-if-absent
发布、当前输入/receipt 复检及 SQL CAS 提交持各 publication 自身的短准入；准入内遇既有
目标还需比较相同字节，不依赖准备时的旧判断覆盖数据。Parser 和内容提交继续由各自原事实
owner 取得写入准入。同进程排队、活动上下文嵌套复用，跨进程使用与 Python 相同的 OS flock
协议。关闭等待已准入的发布结束。自定义跨文件/SQL 提交应通过 `app.writes.run(...)`，详见
[写入准入证据](../../../migration/evidence/runtime/catalog-write-admission.md)。[显式描述符文件回收](../../../migration/evidence/runtime/artifact-reclamation.md)已接入同一边界。

`app.literatureContent.accept(proposal, markdownBytes, signal?)` 消费闭合中性 Proposal，验证 final metadata、
内容 hash、Analysis lineage 与实际 Markdown 字节，读取当前事实后分配下一 metadata revision。
Storage 先发布不可变 JSON/Markdown，再在同一 SQLite 事务检查 primary/ParserResult/metadata 基线，
一起替换 metadata、content、关键词、引用支持及 FTS。失败保留旧 current view；普通失败不触发
NoUsableContent 业务清理。详见
[内容接纳证据](../../../migration/evidence/runtime/content-acceptance.md)。

## 7. 材料与文献验证

### 7.1 验收

直接测试至少覆盖：

- 每个 Literature 必须且只能属于一个 MetaLiterature，且第一篇 Literature、MetaLiterature 和代表关系原子创建；
- MetaLiterature 不能没有成员，代表 Literature 必须属于当前 MetaLiterature，成员关系不能被双向重复保存；
- MetaLiterature 不保存 status、current asset/content 指针或批量候选；“至少一个成员达到 ASSET_READY/CONTENT_READY”只从成员 current facts 推导；
- `VersionRole` 只接受 `published`、`accepted-manuscript`、`preprint` 和 `other`，未知来源不能猜测为 `published`；
- Literature 基础对象不重复保存 metadata 顶层字段，也不嵌入 observation、资产、内容或关系列表；
- DOI 的裸值、`doi:`、`https://doi.org/`、`http://dx.doi.org/`、大小写和边界空白收敛为相同 canonical key；PMID、PMCID 和其它已支持 namespace 只使用各自官方格式；
- arXiv 新式、旧式、前缀和官方 URL 能够规范化，`v1`/`v2` 命中同一 Literature 且不增加 revision 字段；
- OpenAlex Work ID、Web of Science UID、Semantic Scholar Paper ID、Scopus EID 等只进入 Provider record identity，不进入 Literature identifiers 或跨供应商身份匹配；
- 稳定标识符一致、同 namespace 不同值、一个相同而另一个冲突、全部缺失和多个无冲突 ID 连接场景；一个相同而另一个冲突时稳定拒绝，不建立版本关系或冲突状态机；
- 同一 Literature、同一 MetaLiterature 内不同 Literature 和不同 MetaLiterature 的分离；
- 无稳定标识符的严格复合匹配只执行 NFC、Unicode 空白合并和 casefold，保留标点、连字符、作者组成与顺序；任何字段缺失、姓名倒置、首字母、转写或相似文本都不能命中；
- 相同 DOI 不因 `version_role` 不同拆分，不同 DOI 不因标题相同合并；正式 DOI 与相关 arXiv 预印本只有明确 `version_links` 才共享 MetaLiterature；
- 来源 precedence、字段补充、冲突保留和重复计算确定性；
- 用户导入 observation 的非空值先于全部 Provider observations，Provider 只补缺；首次与 Provider 值相同的 matched 仍保存用户来源，完全重复的 matched 不新增 observation，稳定标识符冲突拒绝而不强制合并；
- 作者统一选择第一个非空高优先来源列表；只有 ORCID 相同或作者数量、顺序和规范化展示名全部一致时才补缺，且不能覆盖高优先来源值或执行模糊匹配；
- `Author` 能保留个人、机构、中文姓名、协作组、明确 ORCID、署名单位和 ROR；不同 Literature 不产生全局 Author 身份；
- 书目导入、供应商 observation 和第一阶段最终 metadata 都使用同一 `Author` 合同，缺失姓名组成、ORCID、单位或 ROR 时保持缺失而不是猜测；
- 非空标题或 DOI 至少存在一个时才能入库，只有其它 namespace 标识符而没有标题时拒绝；
- `source_type` 保留来源开放词汇，统一字段仅接受两组封闭枚举；未知映射保守为空，版本语义仅采用明确来源提示；
- `MetadataObservation` 使用独立 `observation_id` 和公共 `Provenance`，不携带 Literature 身份，也不在顶层重复来源、来源记录 ID 和观察时间；Provider 与书目导入只通过受约束的 provenance 区分；
- 一个 Literature 可以关联多个长期保存的不可变 MetadataObservation，新增 observation 不覆盖旧对象；LiteratureMetadata 始终只有一份当前值；
- `metadata_revision` 只在当前 LiteratureMetadata 成功替换时递增，用于 stale 复检和当前内容对齐，不存在旧统一 metadata revision 历史；
- `CONTENT_READY` 后新增 MetadataObservation 只增加来源事实，不单独覆盖当前最终 metadata/content；完整重分析成功后才整体替换；
- observation 级 `version_role` 与 `AssetHint.version_role` 保持独立，没有可靠证据时不能猜测为 `published`；
- `version_links` 只接受供应商明确声明的同文献版本目标，每个 key 至少有一种稳定定位；未解析或冲突目标不创建占位 Literature，也不改变 MetaLiterature 归属；
- 相同 MetaLiterature 的版本归属只保存为 `Literature.meta_literature_id`，不建立 `LiteratureRelationObservation`、`LiteratureRelation` 或其它平行版本事实；
- 供应商返回的 `declared_keywords`、原始参考文献文本、参考文献次数、被引用次数、资产线索和访问状态不会直接进入 `LiteratureMetadata`；
- `declared_keywords` 与 LLM 最终关键词保持独立，最终关键词只存在于已验收 `LiteratureMetadata.keywords`，没有平行分类或标签结果；
- `reference_count` 和 `cited_by_count` 分别保留、保持非负且不会根据列表长度推导或跨供应商相加；
- `reference_texts` 按来源顺序保存非空原文，不维护或暗示列表完整性，也不根据其长度推导计数；
- `ProviderRelationObservation` 一条只表达一条供应商有向边，可以在目标尚未入库时独立存在且不会自动物化 Literature 或递归；
- 只有当前扩展范围选中的 relation observation 才尝试解析目标，未选中或接纳失败时不形成 ReferenceSupport；
- `LiteratureContent.references` 以允许为空的有序非空文本独立保存 PDF 参考文献，并通过单一 Analysis provenance 回溯输入；空 tuple 渲染“未提供”但不产生 reference；Parser 不产生参考文献文本、lookup 或权威关系；
- `ReferenceLookup` 不持久化，不能绕过 Metadata 和 Literature 身份规则直接创建目标；
- Reference 只有三个 ID 字段，只在两个不同的具体 Literature 都已接纳且至少存在一项有效 ReferenceSupport 后建立，相同 source/target 幂等；
- ReferenceSupport 使用三种封闭来源结构，索引从零开始；结构化关系方向必须与 Reference 一致，文本来源必须属于引用方，相同 `(reference_id, source)` 幂等；
- 供应商结构化关系和原始参考文献文本按数据语义区分，不按专门接口或默认返回方式区分；
- 多个来源只为同一 Reference 增加 support，Reference 不连接原文、供应商记录或 MetaLiterature，也不平铺 provenance；
- 当前 LiteratureContent 成功替换时删除旧 ContentReferenceTextSupport，Reference 没有其它 support 时一并删除；失败替换保留完整旧 content 和 support；
- 解析失败或候选歧义只保留原文，不创建占位 Literature 或未解析 Reference；
- Literature 级引用和 MetaLiterature 级汇总；
- cited-by 查询是权威引用关系的反向读取，不形成第二套关系事实；
- 三级状态完整 truth table，并与 Storage 读取投影使用同一测试样例；当前没有独立可写的 SQL view；
- 自动获取耗尽、运行 Report 或普通失败不改变状态；`needs_manual_pdf` 只来自最小耗尽事实；
- 自动或手动接纳的唯一 `primary-pdf` 关系都按同一规则形成 `ASSET_READY`；手动来源不增加状态或转移到其它 Literature；
- 未完成但已有统一元数据的版本可以导出；
- 导入记录与供应商记录使用同一身份规则；
- 查询不直接依赖内部数据库表结构；
- LibraryQuery 只搜索允许的当前权威字段并以具体 Literature 为结果单位；一般多值 OR、keywords AND、普通 text 无 SQL/FTS 语法，分页/排序不进入 QuerySelector；
- LibrarySearchRequest 的默认排序、缺失值后置、LiteratureId 稳定 tie-break、relevance 前置条件、total_count 和不透明 cursor 绑定成立；后续页面重新读取 current facts，不伪造持久化查询 snapshot；
- SearchItem/Page 和 LiteratureDetail 是同一 read-only snapshot 临时组装的不可变投影，不持久化或形成写入输入；Detail 的 metadata revision/hash、状态、缺失步骤、资产、ParserResult、Content 和引用数量相互一致；
- Detail 不嵌入大型 artifact 字节或无界 Reference/Support/Discovery 图；当前参考文献原文可随来源/content 读取，权威关系、support、发现历史和 artifact 使用独立读取；
- references 与 cited-by 页面使用同一 Reference 的正反向读取，相关 Literature 复用 SearchItem，普通页面只给 support count；ReferenceDetail 才返回同一 snapshot 中的 source、target 与全部当前 support，不建立反向边或第二套引用数量；
- Literature 的 artifact read Port 只接受 Detail 已给出的 Asset/ArtifactRef，复核正式对象的相对引用、普通文件、size、hash 与 media type 后返回 context-managed 只读 binary stream；Model 不执行 I/O，也不暴露内部绝对路径；
- Entry 使用 verified reader 向用户文件原子导出 artifact，默认拒绝已存在目标，明确覆盖时也不暴露半文件；读取或导出不访问 Provider、不修改数据库、不形成 DiscoveryRun 或处理 Report；
- 查询能够分别返回 DiscoveryRun 发现记录和按 MetaLiterature 聚合的成员完成事实，两者不混成 Literature 状态；
- 查询能够筛选需要人工 PDF 的具体 Literature；新增 MetadataObservation 与耗尽事实清除属于一个逻辑提交；
- 最终 metadata/content 接纳拒绝 stale PDF 或 metadata revision，且不会留下部分 keywords、sections、references 或 artifact 关系；
- 每个 Literature 只保留一个当前 LiteratureContent；内容 hash、Markdown 字节 hash 与单一 Analysis provenance 含义分离，当前派生内容可以从权威元数据和 PDF 重建；
- 身份整理、删除和内容接纳提交不存在部分关系更新。

### 7.2 验收

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
- `NoPrimaryPdf` 只有在五层全部适用路径正常结束且最小 `AutomaticPdfAcquisitionExhaustion` 已提交后返回；该事实只有 LiteratureId，不保存来源、原因、候选、时间、次数或配置快照；
- 手动 PDF 要求明确具体 Literature，先复制到内部 staging 再执行相同基本检查；成功返回只含已提交 Asset/LiteratureAsset 的 `AcceptedManualPdf`，且 provenance 为 user/manual-pdf、source URL 为空；
- 手动文件不存在、不可读、不是有效 PDF、目标不存在或已有主 PDF 时形成输入验证错误，不进入 `NoPrimaryPdf` 或第三个自动结果；竞争产生主 PDF 时拒绝而不覆盖；
- 手动接纳不创建 PdfCandidate、candidate key、tried set、第四个 AcquisitionPath 或输入绝对路径记录，只达到 `ASSET_READY`、清除已有自动获取耗尽事实，不自动继续 Parsing/Analysis；
- 成功、失败、取消、stale 和明确材料失效均不移动、修改或删除用户原文件，只能清理 SciRetriever 内部副本；
- 文件发布、数据库提交、耗尽事实提交、hash 冲突或 stale 失败作为系统错误传播，不能返回 `NoPrimaryPdf`；只有 Asset、唯一 `primary-pdf` 关系和已有耗尽事实清除都提交后才能返回 `AcquiredPrimaryPdf`；
- `AssetHint` 的直接文件和落地页语义、可选字段及封闭角色被正确解析；
- 同一 Literature 的不同 `AssetHint` 分别保留 URL、媒体类型、资产角色、版本角色、`access_status` 和 `license`，且这些值不进入 `LiteratureMetadata` 或替代 PDF 基本检查；
- `PdfCandidate` 只存在于当前运行，只保存 candidate key、route adapter 的稳定 source identity、acquisition path 和声明媒体类型，不要求 URL，也不保存 header、Cookie、凭据、API object、页面 action、私有对象或失败详情；补充材料、XML 和 HTML 不成为主 PDF 候选；
- `AccessRouteHint` 只保存封闭、脱敏的 canonical landing、稳定 ID、locator 或 entitlement 线索，不能携带 Cookie/token/vendor object，也不能持久化；短期签名 locator 留在 adapter 私有多步流程；
- 普通 HTTP、多步授权 API 和浏览器捕获都先形成相同的 `TemporaryPdf`，不能绕过统一基本检查；
- `Asset` 只保存不可变文件事实；`LiteratureAsset` 保存 Literature、角色、脱敏来源和 provenance，不复制 Literature version role 或增加 `is_current`；
- direct → publisher-api → general-api → public-web → browser 五层顺序与认证分类独立；单篇当前层结束后才启动自身下一层，其他文章独立推进，成功后不继续后续 routes，已选缺失或未就绪来源保留失败标记；
- 同一 Literature 不跨层竞速；不同 Literature 可在目标 worker 上限内独立并发，API 由官方 quota scope
  门控，Browser 由 `browser-generic` 聚合政策和同平台网络串行/30 秒冷却共同准入；
- Provider 可以贡献公开线索或授权 API；Browser 下载只使用唯一 `browser:generic` route，层级由 Acquisition Plan/Entry admission 决定且不写入 `AssetHint`；
- header、cookie、凭据和 vendor 私有对象不能进入或随 `AssetHint` 持久化；
- 一个候选正常未命中或基本检查失败后继续下一个；candidate/locator/target/DOI landing/adapter 的独立失败可以继续其它适用低风险路径，来源的 HTTP/API/外部响应格式失败或候选地址拒绝保留原因并继续独立渠道；429、`Retry-After`、quota 停止本来源剩余请求并遵守冷却，最终未解决失败不能提交自动获取耗尽；
- 未启用或不适用 route 不进入本次耗尽集合；当前 plan 需要但缺少实现、参数、凭据或 policy 的 route 明确报告且不能静默耗尽；取消、Port、清理、发布和 stale 失败立即终止；
- 同一 Literature 最多存在一个 `primary-pdf` 关系，且该唯一关系就是当前主 PDF；
- PDF 通过基本检查后立即形成 `ASSET_READY`，不等待 LLM 内容判断；
- 基本检查验证非空实际 PDF 字节、reader 可打开、页面树至少一页和当前任务绑定；不以 PDF 内容身份匹配阻断入库，保存未验证标签；不判断正文/
  摘要/目录/封面或学术内容，也不使用固定页数、字节数或正文字符数；
- 重复相同字节复用，不同字节不能覆盖；
- Stale metadata 或当前资产变化时拒绝发布关系；
- Browser 下载不能绕过基本检查；
- `browser-generic` 的显式聚合串行 override、start interval/window/cooldown 与各平台网络活动
  1/结束后 30 秒冷却共同执行；空 override 允许跨平台 worker 并行，独立 API scope 按各自政策推进；
- Browser 平台资格覆盖页面与主下载的真实网络活动，网络结束且保留页后续请求被阻止后释放，
  本地文件/会话责任独立结清；恢复、redirect、popup、viewer、标签页或换入口不能绕过窗口、
  间隔、`blocked_until`、circuit，也不能按 CSS/JS 次数实施文章冷却；
- Browser 的登录、MFA、rate-limit、IP block、账号警告和 runtime failure 形成当前运行事实；只有登录、MFA、IP block、账号警告、cleanup 或达到阈值的 runtime failure 等明确 group feedback 才打开对应 circuit，不写数据库或阻塞无关 group；API 的 `no-entitlement` 仅表示该 API 不能交付，允许独立准入的 Browser 尝试机构 IP 访问；
- Challenge、拒绝和未找到使用与普通页面相同的 Observation 与六种动作；登录/MFA/no-entitlement 等需要人工或外部授权的状态不会被 Agent 自动绕过。页面状态是给 Agent 的描述，不由 Network 自动变成终态。自动或经动作 clear 后继续 capture；
  Agent Stop、候选等待超时、取消、硬性 runtime failure 和 300 秒/30 次调用预算
  保留各自稳定结果；候选等待超时不会单独结束 Agent，也不打开 Challenge group circuit；本地 resource-blocked 不冒充页面拒绝或 Agent 失败；
- Browser 只注册 `browser:generic` 并构造 `AgentBrowserController`，无 Publisher rule、selector controller
  或 fallback；未知 Publisher 具有合法起点时也可进入；
- Agent controller 只调用 `start/apply`；Network 在一次 step 内完成 exact binding、最多一次 dispatch
  和 settlement，只返回五类稳定结果；一次无变化、重复动作或页面短暂不变都仍是可继续的 settled step，
  不再生成 no-progress terminal；
- 原始 capture 不是成功；Acquisition 文件验收通过后，本次 `BrowserCaptureBatch` 的候选及时结束探索并交付 publication，文章身份仍为未验证（ADR 0029、0030）；
- 目标 Browser session 的默认硬上限为 300 秒累计活跃时间与 30 次真实 model dispatch，
  Agent action 保留统计而默认不独立设限；下载/排队/本地验收不误计，恢复不清零。达到上限只形成稳定
  Browser failure，不形成正常未命中、全渠道耗尽或永久无权限。最后一次合法调用允许完成动作、既有
  有界页面反馈和下载交接；时间及控制版本检查继续生效，已启动传输使用独立寿命。5 秒决策间隔
  与反馈等待重叠，迟到动作不执行；
- Agent 每次只返回一个绑定当前 revision/surface/viewport 的封闭动作，由同一 CloakBrowser article
  handle、Browser permit、Network guard 和 capture handler 执行；不能创建额外 context/process、
  任意导航、selector/JavaScript 或直接发布 PDF；
- Browser Agent 没有固定页面路径或页面状态终止规则；同一 session 时钟/控制 epoch 为自动
  与 Workbench 共用，operation/decision/transfer 取消域独立。下载 started 让出 worker，失败
  从原页面重新观察；文件验收通过及时返回候选/lease并交原 publication，不在调用方尚无法
  开始 publication 时等待它。无候选仅收敛真实捕获，原始失败不被空队列超时覆盖；
- 每次 Browser navigation/popup/response/download 在访问前通过文章级 dynamic destination guard 与
  Network policy；有效 PDF 通过任务关联、CAS 与不可变发布，内容身份检验留待解析阶段；
- Metadata 与 Acquisition 使用同一 API quota 时共享 scope；API `Retry-After` 和 quota 阻塞对所有调用方生效；
- redirect 到新的 provider/host 不能绕过目标网页 scope 或 host 预算，公开状态不形成限速豁免；
- 当前进程内的失败、超时和取消不能泄漏网页 permit 或清空仍有效的冷却/`blocked_until`；新进程不恢复这些动态状态；
- 旧清理服务的明确调用单独验证；生产 completion 与独立分析均不因 NoUsableContent 删除材料。一页完整短文不因页数被判无效；
- 同次运行使用临时 tried set 避免立即重试，新运行允许重新发现且数据库不保存无效 candidate/route/decision；
- 新 MetadataObservation、成功自动或手动主 PDF、用户明确重试都会清除自动获取耗尽事实；全库自动补全默认跳过仍有该事实的 Literature；
- Parser/LLM 调用失败、ParserResult 乱码/截断/只有资源引用或无法判断时不删除 PDF；
- 无效候选不留下候选级长期详情；Analysis 明确无内容只终止本次尝试，不删除已接纳 PDF、ParserResult、原始 MetadataObservation 或 AssetHint；旧清理服务仅可明确调用；
- 已有有效 `CONTENT_READY` 内容时不自动替换主 PDF，补充资产不驱动 Parsing、Analysis 或状态。

凭据、readiness 和 `config test` 测试使用临时凭据文件、fake adapter 与本地 Network，不读取真实用户配置，也不访问真实供应商。

HTTP 和 Browser 测试使用本地受控站点，不连接真实供应商。

## 8. ADR 0037 目标形态：元数据字段与文献状态（实施中）

本节描述 ADR 0037 的目标合同。元数据字段、字段来源/人工锁定、v15 迁移和内部 DSH 元数据步骤已实施，正在综合验收；六状态与完整建档编排仍由 09 实施。任务与验证证据见计划的 07、09。

### 8.1 出版形式与文章性质

`LiteratureMetadata.document_type` 拆为两个封闭枚举：

| 字段 | 取值 |
| --- | --- |
| `publication_form` | `journal-article`、`conference-paper`、`book-or-chapter`、`thesis`、`patent`、`report-or-standard`、`dataset` |
| `article_kind` | `research-article`、`review`、`letter-or-communication`、`perspective-or-commentary`、`correction-or-editorial` |

- 预印本由 `version_role` 表达，不属于出版形式。
- 供应商的原始类型字符串保存在 observation 的 `source_type` 中，经带版本的映射表转换，无法映射时为空。
- `LibraryQuery` 的 `document_types` 改为 `publication_forms` 与 `article_kinds`。
- 严格后备身份匹配要求出版形式一致。

### 8.2 字段来源、冲突与锁定

每个字段记录来源（`authority`、`proofread`、`manual`）、证据、冲突标记和锁定标记。优先级：

| 字段 | 优先级 |
| --- | --- |
| 题名、作者、期刊、出版者、卷、期、页、标识符、日期、出版形式 | 人工 > 权威来源 > 校订稿 |
| 文章性质、作者关键词、摘要、语言 | 人工 > 校订稿 > 来源 |

- 用户导入值仍按 ADR 0002 优先。
- 就绪后到来的新 observation 只补空字段并标出冲突；只有显式重新执行建档的元数据步骤，才重新裁决。

### 8.3 文献状态

| 状态 | 条件 |
| --- | --- |
| `UNREVIEWED` | 无主 PDF |
| `ASSET_READY` | 有主 PDF、未就绪；`missing_step` 为 `raw-parse` 或建档的下一步 |
| `ARCHIVING` | 建档任务运行中 |
| `ARCHIVE_FAILED` | 正文部分存在未解决的失败 |
| `READY` | 正文校订完成并成为默认文档、结构满足、必填元数据齐全、标签数在 1 到上限之间 |
| `EXCLUDED` | 文章性质为观点或评论、勘误或社论 |

- 状态仍是纯推导结果；
- 补充材料部分不参与推导；
- 获取 PDF、解析、建档各自手动发起。
