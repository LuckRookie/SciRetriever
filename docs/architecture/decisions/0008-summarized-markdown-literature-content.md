# ADR 0008：LLM 总结型 Markdown LiteratureContent

- Status: Accepted
- Date: 2026-08-06
- Revised: 2026-08-10
- Supersedes: [ADR 0005](0005-document-package-2-breaking-contract.md)、[ADR 0006](0006-llm-produced-literature-content.md)
- Amends: [ADR 0001](0001-sciretriever-scope-and-boundary.md)、[ADR 0002](0002-literature-identity-and-incremental-processing.md)、[ADR 0003](0003-operator-managed-mineru-service.md)、[ADR 0007](0007-reference-resolution-and-authoritative-relations.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[Analysis 技术文档](../technical/analysis.md)、[Literature 技术文档](../technical/literature.md)
- Amended by: [ADR 0010](0010-parser-neutral-markdown-current-result.md)、[ADR 0013](0013-decoupled-discovery-and-database-maintenance.md)

## 背景

Parser-neutral `ParserResult` 为 LLM 提供接近原始 PDF 的规范化 Markdown，但它不是面向用户的文献总结。原 ADR 0005/0006 又把 `LiteratureContent` 描述成接近完整原文结构的内容表示，并在其后增加独立的八类 `AnalysisProposal`。这会让 LLM 对背景、方法、结果和结论总结两次，也会维护独立关键词、标签和元数据副本。

Owner 进一步明确：轻结构化文档的目的，是让 LLM 按少量固定一级标题总结文献并保存为可直接读取和导出的 Markdown；固定结构不足时允许补充其它正文一级标题及正文二级标题。最终元数据必须先于正文总结确定，并作为正文总结请求的明确上下文；它和关键词只产生一次，进入权威 `LiteratureMetadata` 后再用于规范化渲染 Markdown。LLM 产生的额外标题必须能够进入封闭、可验证的 Pydantic 合同，不能依靠动态字段或自由 `extra` 字典。

## 决策

### 1. 撤销 DocumentPackage 2.0 目标合同

ADR 0005 的 `DocumentPackage` 2.0 完整递归 schema、`AnalysisSnapshot`、`TagSnapshot` 和对应 canonical Package 合同不再是目标设计。当前 pre-v1 项目没有已经发布或需要迁移的受支持 Package 2.0 字节，因此不提供 reader、writer、兼容 shim 或迁移。

`DocumentPackage` 不是当前产品需求，也不作为 Literature 身份、状态、查询、书目交换或完成条件。未来若出现明确的完整离线快照、跨机器传递或历史复现需求，必须重新确认消费方和完整 schema，并用新 ADR 定义新的版本、canonicalization、hash、时间和兼容边界；不得恢复或静默解释 ADR 0005 的 2.0 合同。

### 2. ParserResult 与 LiteratureContent 保持分离

Parsing 继续把 operator-managed MinerU 或其它 parser 的私有输出转换为 [ADR 0010](0010-parser-neutral-markdown-current-result.md) 定义的 parser-neutral `ParserResult`。`ParserResult` 通过不可变 artifact 提供规范化 Markdown，保留 Markdown 实际引用资源及其 hash，并记录输入 PDF、parser identity、必要参数和结果 hash；不复制 parser 私有 JSON、block、bbox 或 source locator。

`ParserResult` 不是产品文档或 Literature 状态事实，不直接产生参考文献文本、`ReferenceLookup` 或权威 `Reference`。Analysis 是当前唯一拥有 LLM 文献解释行为的功能模块。

### 3. 一次逻辑分析包含两个有序阶段

对普通长度文献，一次逻辑内容分析使用两次有严格先后关系的核心 LLM 请求：

1. **元数据确定**：输入当前统一初始 `LiteratureMetadata` 和经过验证的同一 `ParserResult`，先明确判断是否具有可供分析的实际文献内容；内容有效时形成结构化的最终 `LiteratureMetadata` 提案，其中包括最终关键词和原文摘要。
2. **内容总结**：只在第一阶段成功且最终元数据通过结构验证后开始；输入同一 `ParserResult` 和第一阶段已经确定的完整元数据，形成研究背景与目标、研究方法、数据、结论与局限性、必要的额外正文标题及按原文顺序排列的参考文献文本。

第一阶段的公共结果严格为以下二选一：

```text
NoUsableContent
  outcome: Literal["no_usable_content"]

FinalMetadataProposal
  outcome: Literal["usable"]
  metadata: LiteratureMetadata

MetadataAnalysisResult = NoUsableContent | FinalMetadataProposal
```

`NoUsableContent` 不保存评分、置信度或详细原因。它只表示当前 `ParserResult` 没有属于目标 `Literature`、足以说明该文献实际研究、论证、综述、讨论或报告了什么的内容。只有封面、目录、标题与元数据、摘要、访问提示、错误页、下载说明，或者内容明确属于另一篇文献时，可以形成该结果。一页 PDF 不自动无效；完整短文、通信、评论、更正或技术说明仍可具有实际内容。

只有结构有效且明确的 `NoUsableContent` 才不执行第二阶段并允许 Entry 触发清理。PDF 可能具有正文但 `ParserResult` 乱码、截断、只剩资源引用或不足以判断，属于 Parsing 或 Analysis 失败，必须保留 PDF；缺字段、拒答、未知结构、输入不对齐和模型调用失败也不能解释为没有实际内容。第二阶段失败时，第一阶段的元数据提案不单独发布。`FinalMetadataProposal` 直接复用公共 `LiteratureMetadata`，不建立平行元数据类型；模型调用的 provenance 由程序形成，不要求 LLM 输出。

第二阶段只生成正文与参考文献的内容 Markdown 草稿，不重新生成元数据、关键词或摘要。最终用户 Markdown 中的 `# 元数据` 和 `# 摘要` 由程序从第一阶段形成并最终验收的同一 `LiteratureMetadata` 确定性渲染，再与第二阶段解析出的正文和参考文献合并。因此两次请求仍只形成一项逻辑 Analysis、一份最终元数据和一份最终文档，不形成两套平行产品事实。

超长文献可以在各阶段的 Analysis 适配器内部使用有界的分段与汇总请求，但第二阶段仍必须等待第一阶段完成，并使用第一阶段唯一确定的元数据。具体分块、token 预算、物理请求数和重试属于技术文档。

### 4. 固定 Markdown 一级结构

总结型 Markdown 的固定一级标题及顺序为：

```markdown
# 元数据

# 摘要

# 研究背景与目标

# 研究方法

# 数据

# 结论与局限性

# 参考文献
```

七个固定一级标题必须存在，不能改名、删除或由额外标题替代。第二阶段可以在四个固定正文标题之间或其后、参考文献之前提供其它正文一级标题；程序组装最终文档后，这些额外标题自然位于“摘要”之后、“参考文献”之前。“研究背景与目标”“研究方法”“数据”“结论与局限性”和额外正文一级标题可以具有二级标题。元数据、摘要和参考文献下不允许二级标题；当前产品合同不要求更深层级。“参考文献”始终是最后一个一级标题。原文未明确提供固定内容时保留固定标题并使用精确字符串“未提供”，不能编造内容或使用第二种缺失标记；额外标题没有内容时不创建。

标题、原文摘要、写入文档的原始数据、数值、单位、公式和参考文献文本必须忠于 PDF；允许清理断行、空白和明确 OCR 问题。背景、目标、方法、数据解释、结论和局限允许跨原文章节整理和总结。额外标题只能用于固定结构无法合理容纳的重要信息。

### 5. 元数据是封闭填空块

`# 元数据` 的字段名称和顺序固定为：

```markdown
# 元数据

+ Title:
+ Authors:
+ DOI:
+ Other Identifiers:
+ Publication Date:
+ Year:
+ Document Type:
+ Language:
+ Venue:
+ Publisher:
+ Volume:
+ Issue:
+ Pages:
+ Keywords:
```

确定性 renderer 不能增加、删除、改名或重排元数据项。元数据可选字段在结构化对象中使用 `None`，关键词缺失使用空 tuple；渲染到 Markdown 时两者都使用精确字符串“未提供”，不能使用 `N/A`、`null`、`None`、空字符串或其它自然语言。URL、开放获取状态、许可证、引用计数、供应商身份、处理状态和 provenance 不进入该块。`LiteratureMetadata.abstract` 缺失时同样以 `None` 保存，并在 `# 摘要` 下渲染“未提供”。

第一阶段 LLM 只产生一次结构化的最终元数据提案，不生成或解析一份 Markdown 元数据块。该提案以统一初始 `LiteratureMetadata` 和 PDF 为共同依据：保留没有冲突的可靠来源值；用户书目导入 observation 的非空书目信息作为最高优先级可靠值，除最终关键词重新形成和已经允许的出版社名称规范化外不得改写。PDF 明确内容只补齐摘要、页码等缺失项；能够确定为同一出版社时可以把名称变体统一为项目约定名称，无法可靠确认的值保持缺失，不能编造。供应商和用户书目导入身份仍由 `MetadataObservation.provenance` 保存，不进入最终 `LiteratureMetadata`。

Literature 验收后以该提案全量替换具体 Literature 的统一初始 `LiteratureMetadata`；“全量替换”表示原子安装一份新的完整当前元数据，不表示删除来源 observation 或无依据地丢弃原有可靠字段。一个 Literature 可以长期关联多个不可变 `MetadataObservation`，但只保留一份当前 `LiteratureMetadata`；旧统一元数据不形成历史记录。`metadata_revision` 是当前元数据每次成功替换时递增的并发复检和内容对齐令牌，不是可查询的历史实体。

规范化发布的 Markdown 从已验收的同一 `LiteratureMetadata` 确定性渲染 `# 元数据`，从 `LiteratureMetadata.abstract` 渲染 `# 摘要`。第二阶段只消费该元数据作为总结上下文，不能生成第二份并行元数据或摘要。LLM 最终元数据提案不是 `MetadataObservation`；它只在完整 Analysis 通过 Literature 验收后成为当前统一元数据。当前 metadata、LiteratureContent 和 Markdown 必须绑定同一 revision/hash 并整体替换，失败保留完整旧当前视图；不可变旧 Markdown 字节不原地改写，但失去当前关系后只属于可回收缓存，不构成产品历史。

### 6. 关键词不再建立平行分类或标签

供应商声明关键词继续保存在 `MetadataObservation.declared_keywords`。LLM 根据全文形成的最终关键词只保存在 `LiteratureMetadata.keywords`，并由 Markdown 元数据块的 `Keywords` 项展示。

不再建立 `BasicClassification`、`KeywordsAndTags`、领域标签、方法标签、材料标签或通用标签等平行核心结果。关键词使用一个扁平列表，可以表达文献的核心领域、问题、方法、研究对象、材料、理论或贡献，但不要求各维度齐全。只作为测试、对照、benchmark、背景或次要案例出现的材料、方法和对象不能机械进入关键词；术语必须由文献内容支持并使用稳定、去重的规范表达。

### 7. Markdown 解析为统一有序 LiteratureSection

Analysis 不为每个可能的一级标题增加动态 Pydantic 字段，也不使用 `other: dict`。它验证并解析第二阶段的内容 Markdown 草稿，将正文转换为一个统一、有序、封闭的 `LiteratureSection[]`。

一级章节具有以下稳定语义角色：

```text
background-and-objectives
methods
data
conclusions-and-limitations
additional
```

精确结构为：

```text
LiteratureSubsection
  title: str
  markdown: str

LiteratureSection
  role: LiteratureSectionRole
  title: str | None
  markdown: str
  subsections: tuple[LiteratureSubsection, ...]

LiteratureSectionRole =
    "background-and-objectives"
  | "methods"
  | "data"
  | "conclusions-and-limitations"
  | "additional"
```

程序只把 H1/H2 解释成结构；章节中的段落、列表、表格、公式和代码块继续作为 Markdown 字符串保存，不拆成 block、paragraph 或其它递归类型。四个固定角色各出现一次并保持相对顺序，其 `title = None`，展示标题由 renderer 决定；`additional` 可以出现零次或多次，必须携带非空、自定义且不与七个固定标题冲突的 `title`。全部一级章节在同一个序列中保持实际 Markdown 顺序，因而“理论基础”可以位于研究方法之前，“讨论”可以位于数据之后。二级标题作为所属一级章节的有序 `LiteratureSubsection` 保存。

固定正文 section 整体没有相关信息时以 `markdown = "未提供"` 且空 `subsections` 表示；有实际内容时，必须具有非空 H1 直属 Markdown 或至少一个有内容的 H2，只有 H2 有内容时 H1 的 `markdown` 可以是空字符串。“未提供”不能与有内容的 subsection 混用。额外 section 没有实际内容时不创建，不能创建一个内容为“未提供”的额外标题。

`# 元数据`、`# 摘要` 和 `# 参考文献` 不作为普通 additional section：前两者来自已验收 metadata，参考文献继续使用稳定、有序的非空文本，以便独立导出并由 `ContentReferenceTextSupport` 通过内容 hash 和索引精确定位。第二阶段参考文献草稿必须采用以下形式：

```markdown
# 参考文献

1. 第一条参考文献原文
2. 第二条参考文献原文
```

一条有序列表项对应一条参考文献；程序去掉编号后按顺序保存到 `LiteratureContent.references`。LLM 可以清理断行、空白和明确的 OCR 分隔问题，但不能补写 PDF 未表达的标题、作者或 DOI。没有可识别参考文献时保存空 tuple，renderer 在固定标题下显示“未提供”；“未提供”本身不能解析成一条参考文献。

### 8. Analysis 形成，Literature 接纳

Analysis 拥有两阶段 LLM 调用、内容 Markdown 草稿结构验证、内容可用判断、结构化最终元数据响应验证、章节解析、参考文献文本识别和输入对齐规则。它不能证明模型总结在事实层面绝对正确，也不拥有文献身份、最终元数据接纳、文件删除或持久化。

Literature 确认结果仍然属于当前具体 Literature、当前主 PDF 和当前 metadata 输入，验收最终 `LiteratureMetadata`，并接纳解析后的 `LiteratureContent` 作为该 Literature 的当前权威轻结构化文档。Entry 只协调 Analysis、Literature、Acquisition 和 Storage 的公开 API；Storage 只原子保存已经确认的结果。

第一阶段元数据提案、第二阶段内容 Markdown 草稿和完整待验收提案都是临时结果，不作为独立产品事实长期保存。最终保存的精确内容合同为：

```text
ArtifactRef
  sha256: Sha256
  media_type: str
  byte_size: int

LiteratureContent
  literature_content_sha256: Sha256
  metadata_revision: int
  metadata_sha256: Sha256
  sections: tuple[LiteratureSection, ...]
  references: tuple[str, ...]
  markdown: ArtifactRef
  provenance: Provenance
```

规范 Markdown artifact 的 `media_type` 固定为 `text/markdown`，字节编码固定为 UTF-8。`literature_content_sha256` 表达结构化内容本身，只覆盖 `metadata_sha256`、`sections` 和 `references` 的规范序列化；它不包含 `metadata_revision`、provenance、模型名称、生成时间、文件路径、`markdown.sha256` 或数据库 ID。`markdown.sha256` 只表达最终规范 Markdown 字节。因而三个概念分别是：内容 hash 说明“结构化内容是什么”，Markdown hash 说明“发布字节是什么”，provenance 说明“哪个模型根据什么输入生成”。

`LiteratureContent.provenance` 是一项公共 `Provenance`，而不是两次调用的 provenance 列表或新的 `LiteratureContentLineage`：`source_kind = "analysis"`；`source_name` 保存 provider/model 标识；`input_sha256` 覆盖当前 PDF hash、`ParserResult` hash 和用于正文的最终 metadata hash；`parameters_sha256` 覆盖 prompt 版本与有效模型参数；`observed_at` 是总结完成时间。不保存两次 LLM 请求的独立 provenance、Parser provenance 副本、完整 prompt/request/response、task ID、endpoint、GPU 或机器路径。

### 9. 内容接纳形成最终内容状态

最终元数据、关键词、结构化章节、参考文献和规范化 Markdown 来自同一次有序两阶段逻辑 Analysis 并整体接纳，不再保留独立的八类分析或第二套标签结果。因此 Literature 状态只有三个有独立事实依据的阶段：

```text
UNREVIEWED
ASSET_READY
CONTENT_READY
```

`CONTENT_READY` 表示当前 Literature 已经具有与当前主 PDF 和已验收最终 metadata 对齐的结构化 `LiteratureContent`、规范化 Markdown 和 Analysis provenance；它已经是本产品内容处理的完成状态。引用目标解析是可独立重试的补充步骤，不参与状态推导。

每个 Literature 只保留一个当前 `LiteratureContent`。重新分析时必须先完整生成、验证并由 Literature 接纳新结果，再原子替换当前关系；失败保留完整旧结果。数据库不保存旧 `LiteratureContent` 历史，旧结构化内容和旧 Markdown 字节成为没有历史保证的可回收缓存。当前内容丢失、损坏或不再与当前 PDF/metadata 对齐时，可以由权威元数据、当前主 PDF 和重新形成的 ParserResult 再生成。

### 10. 文件与内容使用两道不同验收门

Acquisition 在下载完成后只检查文件事实：实际字节非空；按字节确认是 PDF，不能信任扩展名、文件名、HTTP `Content-Type` 或下载事件；标准 PDF reader 能够打开；页面树可读取且至少有一页；需要密码但没有可用密码的加密 PDF 不能接纳。轻微不规范但仍能正常打开并读取页面的 PDF 可以接纳。该阶段不设置固定最小字节数、页数或字符数，也不判断正文、摘要、目录、封面或学术内容。失败候选删除临时文件，不建立 `Asset`/`LiteratureAsset`，不保存候选级原因，并继续下一个候选；只有全部当前自动路径正常耗尽并按 ADR 0013 保存最小耗尽事实后才形成 `NoPrimaryPdf`。用户中断、Network/API/权限/配置错误和无法安全发布文件或提交关系都属于本次运行失败，不能降级成 `NoPrimaryPdf`。

PDF 通过上述检查后成为当前主 PDF 并形成 `ASSET_READY`。Analysis 随后只根据 `ParserResult` 判断是否存在属于当前目标 Literature 的实际文献内容。只有第一阶段返回结构有效、明确的 `NoUsableContent` 时，Entry 才协调 Acquisition/Storage 撤销当前关系并删除 PDF 与对应 ParserResult，然后在本次运行继续其它候选。该 PDF、候选、来源、ParserResult 和无效决定不形成长期记录；本次运行使用临时已尝试集合避免立即重试，后续新运行仍可重新发现候选。Parsing 或 Analysis 失败不能触发清理，且必须保留 PDF。

已经形成有效 `LiteratureContent` 的当前主 PDF 不由其它候选自动替换。补充资产可以保存，但不驱动 Parsing、Analysis 或 Literature 状态。

### 11. 当前不建立公共 LLM 基础设施模块

当前两个 LLM 用例——文献总结和从参考文献原文形成临时 `ReferenceLookup`——都属于 Analysis。两个用例共用 Analysis 内部的 LLM Port 和 provider adapter；其它模块只调用 Analysis 的公开业务 API，不能直接调用通用 prompt 接口。Provider adapter 继续经过 Network 的统一访问政策。

只有未来至少两个独立功能模块出现明确、不同的 LLM 业务需求，并且能够提取不包含文献业务语义的中性 provider/model 调用机制时，才通过新 ADR 考虑公共 `llm` 基础设施。功能模块始终拥有自己的 prompt 语义、业务输出和验收规则。

### 12. ReferenceLookup 仍是按需补充操作

`LiteratureContent.references` 和 `MetadataObservation.reference_texts` 是当前可查询的参考文献原文来源。只有引用扩展实际选择这些原文时，Analysis 才使用 LLM 形成临时 `ReferenceLookup`；lookup 不持久化、不直接创建 Literature 或 Reference。本地未精确命中时仍须经过 Metadata 和 Literature 的正常目标接纳流程，权威关系继续遵守 ADR 0007。

替换当前 `LiteratureContent` 时，同一事务删除指向旧内容 hash 的 `ContentReferenceTextSupport`；某条 `Reference` 因此不再有任何 support 时，按“权威 Reference 必须至少具有一项 support”的既有约束一并删除。新内容中的 references 后续按普通 lookup 和 Reference 流程重新解析。`ProviderRelationSupport` 与 `MetadataReferenceTextSupport` 不受 content 替换影响；空 references 不产生 content support。

### 13. 内容处理链区分权威资产与可重建派生产物

在文献内容处理链中，必须优先、可靠、长期保存的是来源 observation 与当前权威文献元数据，以及原始 PDF 的 `Asset`、关系和来源信息。`ParserResult`、Parser Markdown 与引用资源、`LiteratureContent`、最终总结型 Markdown，以及从当前内容形成的 `ContentReferenceTextSupport` 都是可重新生成的派生产物：它们仍保存一个完整当前结果供查询、阅读与导出，并通过原子发布、hash 和轻量 provenance 防止错配、半成品与静默损坏，但不维护历史，也不获得与元数据和 PDF 相同的不可替代性。

该边界只适用于文献内容处理链，不改变 Execution、来源 `MetadataObservation`、`ProviderRelationObservation` 或其它 `ReferenceSupport` 的既有持久化语义。派生产物损坏、清理或丢失不能破坏权威元数据和 PDF。

## 后果

- LLM 先确定一次最终元数据与关键词，再以该元数据为上下文总结一次正文；第二阶段不重复生成元数据或摘要，结构化章节和 Markdown 也不成为两套独立内容。
- 固定 Pydantic schema 通过有序 `LiteratureSection[]` 容纳动态一级标题，不引入自由扩展字典。
- Markdown 的固定标题和元数据填空格式由 Analysis parser 和确定性 renderer 保证，不能依赖模型自由输出作为最终规范字节。
- 已接受的 `LiteratureContent` 同时是程序可读取的结构化内容和可直接导出的 Markdown；不再保存独立八类分析、标签快照或完成提案。
- 每个 Literature 只保留一个可原子替换的当前 `LiteratureContent`；它与 ParserResult 都可以从权威元数据和 PDF 重建，不维护历史结果。
- 内容级 hash、Markdown 字节 hash 和单一 Analysis provenance 各自具有唯一含义，不保存两次模型调用的平行 lineage。
- `DocumentPackage` 2.0 不再约束当前设计；未来完整快照必须重新立项和版本化。
- 当前仍只有十个目标模块，LLM 不是新的项目级公用模块。

## 需要新 ADR 的变化

以下变化需要新的 owner 决策：

- 改变七个固定一级标题或封闭元数据填空项；
- 取消“先确定最终元数据、再以其为上下文总结正文”的两阶段顺序，或让第二阶段重新生成平行元数据；
- 重新让 ParserResult 或 parser 私有输出直接成为 LiteratureContent；
- 重新建立独立八类分析、标签或与 `LiteratureMetadata.keywords` 平行的 LLM 关键词；
- 从 LiteratureContent 删除可独立导出的参考文献文本，或取消 PDF/ParserResult/metadata 输入 hash、内容 hash、Markdown 字节 hash 或 Analysis provenance；
- 让其它模块绕过 Analysis 直接拥有当前两个 LLM 业务行为；
- 建立公共 LLM 基础设施模块；
- 重新引入完整 DocumentPackage 或其它受支持快照合同。
