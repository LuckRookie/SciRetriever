# Literature 模块技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 设计责任：[设计文档 4.3](../design.md#43-文献管理)
- 身份决策：[ADR 0002](../decisions/0002-literature-identity-and-incremental-processing.md)
- 引用解析：[ADR 0007](../decisions/0007-reference-resolution-and-authoritative-relations.md)
- 内容接纳：[ADR 0008](../decisions/0008-summarized-markdown-literature-content.md)
- 运行原则：[ADR 0011](../decisions/0011-literature-database-centered-incremental-maintenance.md)
- 发现与补全：[ADR 0013](../decisions/0013-decoupled-discovery-and-database-maintenance.md)

本文定义目标 `src/sciretriever/literature/` 的文献身份、统一元数据、引用、状态、查询和书目交换规则。Literature 是这些业务含义的唯一所有者，但不直接访问供应商、网络、文件、Parser 或 LLM。

统一逻辑文献数据库是产品中心，而 Literature 拥有其中与文献身份、当前元数据、引用和状态有关的业务含义。其它模块和 Entry 根据这些 current facts 判断是否继续处理；Storage 只持久化决定，Execution、外部 task、ParserResult 或临时分析结果不能替代 Literature 事实形成第二套文献状态。

## 1. 目标结构

```text
literature/
  api.py
  service.py
  identity.py
  metadata.py
  content.py
  references.py
  query.py
  exchange.py
  ports.py
```

- `api.py` 提供其它模块和 Entry 使用的公开操作；
- `service.py` 组织本模块用例；
- `identity.py` 解释 MetaLiterature/Literature 和保守身份收敛；
- `metadata.py` 形成统一初始元数据并验收最终元数据提案；
- `content.py` 验证 Analysis 提案归属并整体接纳最终元数据与 LiteratureContent；
- `references.py` 解释 Literature 级引用和 MetaLiterature 级汇总；
- `query.py` 定义一致读取的业务查询；
- `exchange.py` 定义书目导入接纳、导出资格和字段取舍；
- `ports.py` 声明 repository、read model 和原子 publication 能力。

## 2. MetaLiterature 与 Literature

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

## 3. 身份收敛

### 3.1 文献标识符与 Provider 记录身份

Literature 只消费已经由 `Identifier` 公共 Model 形成的 canonical `(namespace, value)`，不在身份函数中再次解析 URL、前缀或大小写。当前明确规则为：

| namespace | canonical value | 身份含义 |
|---|---|---|
| `doi` | 小写裸 DOI，例如 `10.1021/jacs.5c20087` | 当前具体 Literature 的稳定标识符 |
| `arxiv` | 不带 `vN` 的官方新式或旧式基础 ID | 当前预印本 Literature 的稳定标识符；revision 不另建 Literature |
| `pmid` | 官方纯数字 | 当前具体 Literature 的稳定标识符 |
| `pmcid` | 官方大写 `PMC` 加数字 | 当前具体 Literature 的稳定标识符 |
| 其它受支持 namespace | 经过已明确、可测试的官方格式转换后的值 | 只有官方语义确实标识当前具体 Literature 时才参加身份收敛 |

未知 namespace 的 value 只经过边界空白清理，不推测大小写、分隔符或前缀语义；在其官方身份含义和 canonicalizer 被明确前，Literature 不能据此进行跨来源自动合并。ISBN、ISSN 等未来或当前支持的其它值也必须按各自官方规范建立显式、独立且有 fixture 的纯转换，不能套用 DOI 小写、去标点或其它全局规则。

OpenAlex Work ID、Web of Science UID、Semantic Scholar Paper ID、Scopus EID 及其它供应商数据库记录 ID 不属于上述集合。当前 observation 自己的记录 ID 进入 `Provenance.source_record_id`，关系或版本端点的记录 ID 进入 `ProviderLiteratureKey.record_id`；二者保留供应商官方格式，只能在父 Provenance 的 provider scope 内定位记录，不能进入 `LiteratureMetadata.identifiers` 或参加跨供应商 Literature 标识符匹配。重复的同一 Provider record 可以通过既有 observation 归属幂等命中，但不能因此把不同 Provider 的记录 ID 当作同一文献。

### 3.2 同一 Literature 的判定

接纳一条 observation 时，Literature 在同一数据库 snapshot 中按以下顺序形成决定：

1. 用每个 canonical 文献 identifier 精确查询已有 Literature；
2. 所有已命中的标识符只指向一个 Literature，且 incoming 与该 Literature 的身份型稳定标识符不存在冲突时，命中该 Literature；一条可信 observation 同时携带多个非冲突稳定标识符时，这些值共同描述该具体 Literature；
3. 至少一项身份型稳定标识符指向同一对象、同时另一项身份型稳定标识符明确指向不同值或不同对象时，返回稳定 `identity-conflict` 接纳失败，不选择任意一项继续，也不创建版本关系；
4. 双方都没有稳定文献标识符时，才计算标题、完整作者顺序、发表年份和 `document_type` 的严格复合后备键；四项必须全部存在且完全一致；
5. 没有精确命中且不存在自相矛盾的身份证据时创建新的 Literature；不同 DOI 因此默认形成不同 Literature，即使标题、作者或年份相同。

标题和每个 `Author.display_name` 的比较键固定为：Unicode NFC、去除首尾空白、把连续 Unicode 空白合并为一个空格，再执行 Unicode casefold。作者部分是上述结果组成的有序 tuple；不删除或统一标点、连字符，不改变姓名组成或作者顺序，也不执行翻译、拼音或其它转写、姓名倒置、首字母展开、编辑距离和模糊相似度。比较键只服务身份判断，不覆盖 `MetadataObservation` 或当前 `LiteratureMetadata` 中的来源展示值。

相同规范化 DOI 默认命中同一 Literature，`version_role` 的差异不能把它拆开。同一基础 arXiv ID 的 `v1`、`v2` 等 revision 也命中同一 Literature；如果供应商明确给出 revision，只在现有来源 record、locator、URL 或 Provenance 中保留，不增加 revision 字段。稳定标识符已经无冲突命中时，题名或作者的描述性差异作为来源元数据冲突保留，不能仅靠相似或不相似文本推翻标识符身份。

`identity-conflict` 是接纳结果，不是持久化业务对象。当前不建立身份候选、冲突历史、人工审核状态机或通用关系；调用方只在本次 Report 中呈现稳定、脱敏的拒绝语义。

### 3.3 不同 Literature 的版本聚合

认定两个不同 `Literature` 属于同一个 `MetaLiterature` 时，只接受来源 `MetadataObservation.version_links` 中明确的同文献版本连接。当前 observation 的 `provenance.source_record_id` 和 `metadata.identifiers` 定位当前端点，`version_links` 中每个 `ProviderLiteratureKey` 定位另一端；目标 key 至少具有非空供应商记录 ID 或一个稳定 Identifier。目标未解析或存在冲突时保留 observation，但不创建占位 Literature，也不改变聚合归属。

arXiv 预印本和具有正式 DOI 的发表版是两个具体 Literature。正式发表记录中的 arXiv ID 只有在供应商语义明确表示相关预印本时才进入 `version_links`；它不能同时作为正式 Literature 自身的 identifier。不同 DOI、不同 `version_role`、相似标题、相似作者或 publisher 都不能自行建立 MetaLiterature 归属。反过来，共享 DOI 的记录也不能仅因 `version_role` 不同而拆成两个 Literature。

`version_links` 是身份决定的来源证据，不是权威关系。接纳成功后的唯一结果是两个具体 Literature 具有相同 `meta_literature_id` 和各自 `version_role`；系统不建立 `LiteratureRelationObservation`、`LiteratureRelation` 或引用以外的关系图谱。

### 3.4 规则与持久化边界

身份函数只消费 Model 数据并返回可审计决定，不执行数据库读写。纯官方格式转换由 Model validator 统一实现；Metadata adapter 负责判断某个 vendor 字段表达当前文献 identifier、Provider record identity 还是相关版本；Literature 独占命中、冲突和 MetaLiterature 聚合决定。需要读取现有身份和整体转移关系时，由 Service 通过 Port 取得一致 snapshot，再把决定交给原子事务 Port。

## 4. 来源与统一元数据

Provider 与用户书目导入 observations 都是长期来源事实，不能被统一视图覆盖。一个 Literature 可以通过持久化关联拥有多个独立、不可变的 `MetadataObservation`；新接纳的非重复来源观察增加新对象和关联，不修改既有 observation。统一初始元数据按以下优先顺序逐字段形成：

1. 用户书目导入 observation 存在非空值时采用该值；
2. 导入 observation 缺少字段时，由按配置顺序排列的 Provider observations 补充；
3. 冲突值继续保留在 observation 中；
4. 非冲突稳定标识符可以共同保留；
5. 相同输入和规则得到相同结果。

Literature 只维护一份当前统一 `LiteratureMetadata`。内容分析前它是关联 observations 的确定性投影；完整 Analysis 接纳后，它由该投影、PDF 明确信息和经过验证的最终提案共同形成。`CONTENT_READY` 后新 observation 仍然建立长期关联，但不能单独替换已与当前 LiteratureContent 对齐的最终 metadata；下一次完整 Analysis 可以把它纳入新的初始投影。Catalog 不保存旧统一元数据快照；`metadata_revision` 是当前元数据每次成功替换时递增的版本令牌，只用于 stale 复检、hash 绑定和当前 LiteratureContent 对齐。

### 4.1 LiteratureMetadata 的边界

`LiteratureMetadata` 只描述文献自身。精确字段为：

```text
LiteratureMetadata
  title: str | None
  authors: Author[]
  abstract: str | None
  publication_date: str | None
  publication_year: int | None
  document_type: str | None
  language: str | None
  venue: str | None
  publisher: str | None
  volume: str | None
  issue: str | None
  pages: str | None
  identifiers: Identifier[]
  keywords: str[]
```

#### 4.1.1 作者署名

`Author` 和 `Affiliation` 的精确字段见 [Model 技术文档](model.md#22-identifierauthor-与-affiliation)。`LiteratureMetadata.authors` 是当前具体 Literature 的有序、不可变署名列表；它不引用全局作者实体，也不建立跨文献 `author_id`。同一现实作者出现在不同 Literature 中时，当前产品分别保存各篇文献中的署名事实。

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

`document_type` 的类型为 `str | None`，并且是开放词汇：

- 项目不为它定义封闭枚举或完整可用值列表；
- `article`、`journal-article`、`book`、`chapter` 和 `other` 等只是可能出现的值，不构成全局类型合同；
- Metadata provider 或书目格式适配器可以对已知外部类型做明确的中性映射；没有映射的类型仍可作为字符串进入 observation，不因未出现在项目列表中而被拒绝；
- Literature 可以在统一元数据中保留选定的当前值，但不维护一套供应商类型注册表；
- 预印本、作者接受稿和正式发表版等版本语义由 Literature 版本角色和 MetaLiterature 成员归属表达，不依赖 `document_type` 推断。

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

### 4.2 MetadataObservation 来源输入

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

`asset_hints` 是同一来源 observation 中可供 Acquisition 使用的访问线索，精确合同见 [Acquisition 技术文档](acquisition.md#31-assethint-合同)；它们不进入 `LiteratureMetadata`，也不成为 Literature 已经拥有资产的事实。Vendor 原始响应不能进入这些 Model，也不增加通用 `extra_metadata` 字段容纳全部供应商属性。

`LiteratureContent.references` 独立保存 PDF 中可导出的有序非空文本；Analysis 可以从这组文本或 `MetadataObservation.reference_texts` 形成临时 `ReferenceLookup`，但 lookup 不进入任何 observation。Analysis 先确定最终元数据，再以该元数据和同一 ParserResult 为上下文完成正文总结；两阶段都成功后，Literature 才验收 Analysis 提交的最终元数据、结构化章节与参考文献提案。引用目标解析和 Reference 建立是独立、可重试的补充步骤。供应商 observation 继续保留 provenance，但不再参与 `CONTENT_READY` 版本的普通统一展示。

### 4.3 最终元数据与内容接纳

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

## 5. 引用解析与权威 Reference

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

`ProviderRelationObservation` 的精确合同见 [Metadata 技术文档](metadata.md#52-providerrelationobservation)。它是元数据供应商逐边保存的来源事实和待扩展输入，不属于 Literature，也不要求目标已经具有本地身份。Literature 只处理 Entry 当前选中的 observation：目标未接纳时不创建占位 Literature 或权威关系；目标接纳后才形成 Reference 和指回该 observation 的 `ProviderRelationSupport`。保存 observation、创建目标 Literature 和发布权威关系是三个分开的阶段。

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

## 6. 文献状态

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

## 7. 查询

`query.py` 拥有本地文献查询的业务语义，`ports.py` 声明统一 read-model Port；精确 Pydantic 合同见 [Model 2.5](model.md#25-本地文献数据库查询与详情)。查询使用 Storage 的 read-only snapshot，不回放身份算法，不访问 Metadata Provider，不创建 DiscoveryRun，不执行 PDF/Parsing/Analysis，也不根据运行报告或日志推导状态。

### 7.1 LibraryQuery 与结果单位

`LibraryQuery` 只表达本地数据库筛选条件。不同字段使用 AND，一般多值字段内部使用 OR，keywords 要求当前 metadata 同时具有全部给定完整关键词。普通 `text` 只搜索当前权威 metadata、作者/单位/标识符和当前 LiteratureContent 正文章节，不搜索来源 observation、参考文献原文、URL、provenance、运行记录、日志、失败或文件路径，也不接受 SQL/FTS 表达式。

搜索结果固定以具体 `Literature` 为单位，不按 MetaLiterature 折叠。多个 Provider observations 已经通过身份规则收敛到同一 Literature，不会制造重复列表项；同一 MetaLiterature 下的预印本、作者接受稿和正式发表版仍是可独立拥有元数据、PDF 和内容的具体版本，因此可以分别出现。`meta_literature_id` 只提供版本归组信息，批量补全随后是否按 MetaLiterature 去重属于 Entry 规则，不能反向改变查询读取语义。

排序、limit 和 cursor 属于 `LibrarySearchRequest`，不进入 `LibraryQuery`。因此 `QuerySelector` 只能复用稳定查询条件，在补全开始时从一致 snapshot 展开全部命中范围；它不能把某一页 UI 结果、relevance 顺序或 cursor 当成处理范围。

### 7.2 搜索列表投影

`LiteratureSearchItem` 复用完整当前 `Literature`，并补充 metadata revision/hash、第一缺失步骤和 `needs_manual_pdf`。`Literature` 已经拥有当前完整 metadata 和派生 status，列表项不得再维护一套摘要 metadata 或独立 status。`LibrarySearchPage` 返回具体 Literature 列表、完整命中总数和可选不透明 next cursor；纯查询结果本身就是输出，不包装 Entry Report。

第一缺失步骤只允许当前最早的一项：没有主 PDF 为 `primary-pdf`，已有主 PDF 但没有对齐 ParserResult 为 `parser-result`，已有两者但没有对齐 LiteratureContent 为 `literature-content`，CONTENT_READY 则为空。`needs_manual_pdf` 只来自最小自动获取耗尽事实；false 只表示没有该事实，不能承诺自动来源一定可用。

### 7.3 LiteratureDetail 临时聚合

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

### 7.4 引用关系页面与关系详情

Detail 的 `reference_count/cited_by_count` 只统计本地、至少具有一项有效 support 的权威 Reference。供应商报告的 reference/cited-by count 仍属于各自 MetadataObservation，可以查看来源差异，但不能与本地已解析关系数量混成一个字段。

完整关系使用 [Model 2.5.4](model.md#254-引用关系页面与关系详情) 的独立读取：

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

### 7.5 Artifact 读取与导出

Detail 不嵌入 PDF、Parser Markdown/资源或规范 LiteratureContent Markdown 的完整字节。调用方直接从 [Model 2.5.5](model.md#255-从详情取得-artifact) 列出的字段取得既有 `Asset | ParserArtifactRef | ArtifactRef`，再调用 Literature 公开的 artifact read 操作；Detail 本身仍是无 I/O 的不可变 Pydantic 数据。

Artifact read Port 由 Literature 消费并由 Storage 实现。公开读取操作返回 context-managed、只读 binary stream，不返回机器绝对路径或长期文件句柄。Storage 在交出 stream 前解析规范相对引用，并复核正式对象是普通文件、byte size、SHA-256 和预期 media type；缺失、越界、大小/hash 冲突或类型不一致时 fail closed。调用方负责在 context manager 内消费，不能依赖 ArtifactStore 的内部目录布局。

面向用户文件的 artifact 导出由 Entry 使用同一 verified reader 完成：在目标文件同目录建立 owner-only staging，写完后 flush、`fsync` 并再次核对字节数/hash，再原子发布。目标已存在时默认拒绝；只有调用方明确要求覆盖才允许原子替换，不能静默覆盖或暴露半文件。目标路径只是本次外部 I/O 参数，不进入 Detail、Pydantic、Catalog、provenance 或 Report。

读取和导出 artifact 都是 query-side 操作：不创建 DiscoveryRun，不访问 Provider，不修改文献数据库，也不形成五类处理 Report。打开或导出失败返回稳定读取/文件错误；它不改变 Literature 状态、当前 artifact 关系或下一缺失步骤。

除上述主要读取外，查询 API 仍提供：MetaLiterature 全部成员和代表 Literature、各 Provider citation count observations、ProviderRelationObservation、DiscoveryRun 发现记录，以及 Entry 所需的按 MetaLiterature 聚合成员 current facts。普通运行 failure 只由本次 Report 呈现，日志只提供非权威实时诊断。

## 8. 书目交换规则

导入记录由 Entry codec 转换为现有 `LiteratureMetadata`，并由 `model/record.py` 只组合输入序号等边界信息，再交给 `exchange.py`：

- 形成普通 `MetadataObservation`，其 provenance 固定为 `source_kind = "user"`、`source_name = "bibliographic-import"`、`source_record_id = None`，不建立 `ImportedMetadata`；
- 使用同一保守身份规则创建或命中 `Literature`，不能因来源是用户而强行合并稳定标识符冲突的记录；
- 未命中时返回 `created`；命中后，非空导入值补齐缺失字段或替换当前 Provider 值时返回 `enriched`；命中且当前统一投影不变时返回 `matched`。首次与当前 Provider 值相同的用户记录仍保存 user observation，只有相同规范化 user observation 已存在时才复用既有事实；输入不合格、缺少最低识别信息或稳定标识符明确冲突时返回 `rejected`；
- 导入 observation 的非空书目信息优先于全部 Provider observations，Provider 只能补缺；导入 keywords 可以进入统一初始 metadata，完整 Analysis 后仍由全文关键词替换；
- `CONTENT_READY` Literature 可以接纳新的非重复导入 observation，但不能因此单独替换当前最终 metadata/content；下一次完整 Analysis 把该 observation 作为最高优先级初始输入；
- 单条错误只拒绝该条；
- 外部工具数据库 ID、附件绝对路径、同步状态、插件字段、界面设置、笔记和集合层级不进入核心数据库；
- 不长期保存原始书目文件、外部工具对象、导入批次历史或其它过程来源细节。

只要 `Literature` 已形成可转换的当前 `LiteratureMetadata` 即可导出，不要求 PDF、解析或内容总结完成。未达到 `CONTENT_READY` 时导出统一初始 metadata，达到后导出已验收最终 metadata。默认每个 `MetaLiterature` 选择一个最佳可导出 Literature；用户明确要求时可以导出全部 Literature。目标格式无法表达的字段必须形成明确损失说明。

## 9. Ports 与事务

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

## 10. 验收

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
- `document_type` 接受未预先枚举的来源类型，已知边界映射保持确定，且版本语义不从该字段推断；
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
- 三级状态完整 truth table，并与 Storage SQL view 使用同一测试样例；
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
