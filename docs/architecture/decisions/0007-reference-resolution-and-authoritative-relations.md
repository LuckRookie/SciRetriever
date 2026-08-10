# ADR 0007：参考文献解析与权威引用关系

- Status: Accepted
- Date: 2026-08-05
- Revised: 2026-08-07
- Supersedes: [ADR 0006](0006-llm-produced-literature-content.md) 中关于 `ReferenceObservation` 的决策
- Superseded by: none
- Amended by: [ADR 0008](0008-summarized-markdown-literature-content.md)（撤销 Package 修订；引用关系决策继续有效）、[ADR 0010](0010-parser-neutral-markdown-current-result.md)（参考文献改为有序文本，不保存逐段 locator）
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[Literature 技术文档](../technical/literature.md)、[Metadata 技术文档](../technical/metadata.md)、[Analysis 技术文档](../technical/analysis.md)

## 背景

参考文献相关数据来自三种来源：元数据供应商明确返回的结构化引用关系、元数据供应商返回的参考文献原文，以及 LLM 从 ParserResult 中识别的参考文献原文。前一种已经声明“哪条来源记录引用哪条目标记录”；后两种只有原文，仍需解析目标。这个区别由返回数据的语义决定，与供应商使用专门引用接口还是在普通元数据结果中默认携带该信息无关。

原方案让供应商和 LLM 共同产生 `ReferenceObservation`，因此一个对象同时需要容纳供应商目标记录 ID、PDF evidence、原始文本和残缺的书目信息。这混合了供应商定位、文档内容和权威引用关系，并形成一套质量参差不齐的第二文献元数据。

Owner 已确认：参考文献原文、用于检索的临时结构和已经确认的引用关系必须分开。LLM 可以从不统一的参考文献格式中提取检索线索，但这些线索不是数据库事实；只有目标文献经过正常元数据接纳并获得本地 `LiteratureId` 后，才能建立权威 `Reference`。

## 决策

1. 取消公共、持久化的 `ReferenceObservation` 和 `CitationObservation`。供应商记录定位、解析器私有位置、参考文献原文和目标文献元数据不得再放进同一个引用 observation。
2. PDF 中实际识别到的参考文献继续由 `LiteratureContent.references: tuple[str, ...]` 按原文顺序保存。文本属于轻结构化文档，并通过当前内容的 Analysis provenance 与输入 hash 回溯到 PDF、ParserResult 和最终 metadata；当前不保存逐条 `SourceLocator`。即使目标未解析，文档仍可独立阅读和导出。没有可识别参考文献时保存空 tuple，规范 Markdown 显示“未提供”；该固定缺失标记不是参考文献，也不能形成 lookup 或 support。
3. Metadata Provider 在当前记录中只提供原始参考文献文本时，`MetadataObservation.reference_texts: str[]` 按来源顺序保存这些非空文本。它们属于该供应商 observation，不获得 PDF evidence，也不解释成已经确认的引用关系。
4. 元数据供应商明确返回结构化引用关系时，每条有向关系独立形成一个最小、不可变的来源事实：

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

   `citing` 是引用方，`cited` 是被引用方；无论通过 references 还是 cited-by 查询获得，都规范化为 `citing -> cited`，不保存 `query_direction`。每个 key 至少具有非空 `record_id` 或一个稳定 `Identifier`，且 citing 与 cited 不能表示同一供应商文献。一项供应商响应返回 A→B、A→C、A→D 时形成三个 observation；它们各有独立 `observation_id`，可以复用同一次调用的 Provenance。

   `ProviderRelationObservation` 不保存本地 `LiteratureId`、目标 `MetadataObservation`、标题、作者、参考文献原文或解析器私有位置。它可以在目标尚未接纳时独立持久化，既是供应商关系的最小保存单位，也是后续引用扩展可以读取的待扩展单位；“待扩展”不增加 status、expanded flag 或任务生命周期。

   供应商只返回稳定目标记录 ID 或 DOI 等标识时，不立即为全部目标补查元数据。Entry 只对当前引用扩展方向、深度、数量和其它用户边界实际选中的 observation 解析非本地端点：先精确查询本地 Literature，未命中时才取得普通 `MetadataObservation` 并按统一规则接纳。供应商响应已经内联提供可用目标元数据时，选中目标可以直接使用它，避免重复请求。未选中、元数据不足或接纳失败的 observation 继续独立保留，但不创建占位 Literature、Reference 或 ReferenceSupport。只有参考文献原文而没有稳定目标标识时，仍按第 3 项保存为 `reference_texts`，不能伪装成结构化关系。
5. Analysis 可以根据 `LiteratureContent.references`，或根据 Entry 明确提交的供应商参考文献文本，使用 LLM 形成临时 `ReferenceLookup`：

   ```text
   ReferenceLookup
     reference_index: int
     identifiers: Identifier[]
     title: str | None
     authors: str[]
     publication_year: int | None
   ```

   `reference_index` 只定位本次输入列表中的原文。`identifiers`、`title`、`authors` 和 `publication_year` 只保存 LLM 从原文明确识别的搜索线索；至少存在一个稳定标识符或非空标题时才产生可执行 lookup。代码负责校验和规范化 DOI、PMID、arXiv ID 等明确格式。`ReferenceLookup` 不持久化、不进入 `LiteratureContent` 或权威引用关系，也不能直接创建 `Literature` 或 `Reference`。
6. Entry 先用 `ReferenceLookup` 对本地 Literature 做稳定标识符或其它无歧义的精确查询；本地没有可靠命中时才调用 Metadata 搜索。供应商返回的结果必须先形成普通 `MetadataObservation`，再由 Literature 使用与主题搜索相同的身份和最低入库规则创建或找到目标 `Literature`。LLM 提取值不是目标文献的权威元数据，外部查询也不是本地已经精确命中时的强制步骤。
7. `Reference` 只表达两个已经入库的具体 Literature 之间已经确认的有向关系：

   ```text
   Reference
     reference_id: ReferenceId
     source_literature_id: LiteratureId
     target_literature_id: LiteratureId
   ```

   `source_literature_id` 是引用方，`target_literature_id` 是被引用方。三个字段全部必填，source 和 target 都必须是已经接纳的具体 `LiteratureId`，且二者不能相同。Reference 不指向供应商记录 ID、原始文本、临时 lookup 或 `MetaLiterature`，也不携带 provenance、标题、作者、年份、标识符或解析器位置。`MetaLiterature` 级引用网络由 Literature 级关系汇总查询。
8. `ReferenceSupport` 独立表达一条权威 Reference 的形成依据，不把来源内容复制进 Reference：

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

   `ProviderRelationSupport` 指向元数据供应商直接返回的 `ProviderRelationObservation`；`MetadataReferenceTextSupport` 指向 `MetadataObservation.reference_texts[reference_index]`；`ContentReferenceTextSupport` 指向由 `literature_content_sha256` 标识的当前 `LiteratureContent.references[reference_index]`。两个 `reference_index` 都从零开始且不得为负。`ProviderRelationObservation` 在 Reference 建立前不是 ReferenceSupport；目标接纳并建立 Reference 后，才用其 `observation_id` 形成 support。
9. `ReferenceSupport` 没有独立业务生命周期，因此不设置 `reference_support_id`；相同 `(reference_id, source)` 只能保存一次。它不重复保存 source/target Literature、原文、目标元数据、解析器位置、临时 `ReferenceLookup`、confidence、status、created_at 或 `Provenance`。Provenance 与文本继续由 support 指向的关系 observation、`MetadataObservation` 或 `LiteratureContent` 拥有。目标如何完成身份接纳属于 Literature 身份事实，不混入关系支持。
10. Reference 只在来源和目标都已有本地 `LiteratureId`、引用方向明确、目标身份已经可靠确定，并且存在至少一项有效 `ReferenceSupport` 时创建。Reference 与第一项 support 必须整体发布；后续可靠来源只增加 support。相同 `(source_literature_id, target_literature_id)` 只形成一条权威关系，不能制造平行边。
11. 只有计数、原始文本、临时 `ReferenceLookup`、尚未物化目标的 `ProviderRelationObservation`、相似标题、多个不确定候选或仅有 `MetaLiterature` 身份时，不创建 Reference。原文继续留在其来源容器中，relation observation 继续作为来源事实和待扩展单位保留，后续运行可以重新选择和解析。
12. 引用解析是可独立重试的补充步骤。保存 `LiteratureContent` 或 `MetadataObservation.reference_texts` 不等待目标解析；lookup、供应商搜索、目标接纳或 Reference publication 失败不撤销已经保存的原文、文献内容或目标 Literature。
13. 每个 Literature 只保留一个当前 `LiteratureContent`。新内容完整接纳并原子替换旧内容时，同一事务删除指向旧 `literature_content_sha256` 的 `ContentReferenceTextSupport`；某条 Reference 因此不再有任何 support 时一并删除，以维持“每条权威 Reference 至少具有一项 support”的不变量。新 references 后续按普通 lookup 流程重新建立 support；`ProviderRelationSupport` 和 `MetadataReferenceTextSupport` 不受替换影响。
13. 被引用视图是同一 `Reference` 的反向查询，不建立第二套 cited-by 关系。元数据供应商正向或反向关系查询的返回方向只决定入库后 Reference 的 source/target 方向。

## 被撤销的 Package 修订

本 ADR 原先对 ADR 0005 的 `DocumentPackage` 2.0 引用视图作过修订。ADR 0008 已撤销整个 Package 2.0 目标合同，因此这些 Package 投影视图、排序和 canonicalization 不再约束当前架构。本文关于 `ProviderRelationObservation`、`ReferenceLookup`、`Reference` 和 `ReferenceSupport` 的领域决策继续有效；未来若重新提出完整快照需求，必须从当前领域模型重新设计公开合同。

## 后果

- 不再维护一套残缺、质量不一致的参考文献元数据。
- 文档参考文献、逐边 `ProviderRelationObservation`、目标身份解析、权威引用关系和关系支持各自保留单一含义。
- LLM 负责理解不统一的引用文本并提供搜索线索，Metadata Provider 负责返回目标元数据，Literature 负责身份接纳和最终连接。
- 原文已经保存但尚未形成 Reference 是正常状态；它不阻止文献内容完成。
- 供应商关系 observation 已保存但尚未进入当前扩展范围或尚未物化目标也是正常状态；它不会自行创建 Literature 或触发递归。
- 权威引用图只包含可以稳定连接两个本地 Literature 且至少具有一项来源支持的关系；多个来源只增加 `ReferenceSupport`，反向 cited-by 视图不会形成第二份可变事实。
- 当前 LiteratureContent 被替换时，只有依赖旧内容文本的 support 随之清理；来源 observation 及其 support 不被误删。

## 需要新 ADR 的变化

以下变化需要新的 owner 决策：

- 再次建立把原文、PDF evidence、目标元数据或供应商记录定位混在一起的公共 `ReferenceObservation` 或 `CitationObservation`；
- 允许 LLM 提取结果绕过 Metadata Provider 和 Literature 身份规则直接创建目标文献；
- 允许权威 Reference 指向原始文本、供应商记录或只有 `MetaLiterature` 身份的目标；
- 允许没有 `ReferenceSupport` 的权威 Reference，或把来源原文、evidence 和目标元数据重新平铺到 Reference；
- 把 `ReferenceLookup` 作为文献元数据、`LiteratureContent` 或权威引用关系长期保存；
- 在没有新需求和 ADR 的情况下恢复已撤销的 Package 引用合同。
