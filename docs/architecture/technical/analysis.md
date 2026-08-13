# Analysis 模块技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 设计责任：[设计文档 4.6](../design.md#46-llm-分析与总结)
- 产品需求：[R5 语言模型内容判断与总结](../requirements.md#r5-语言模型内容判断与总结)
- 当前内容合同：[ADR 0008](../decisions/0008-summarized-markdown-literature-content.md)
- 引用解析：[ADR 0007](../decisions/0007-reference-resolution-and-authoritative-relations.md)

本文定义目标 `src/sciretriever/analysis/` 的 LLM Port、先元数据后正文的两阶段内容分析、内容 Markdown 草稿验证、`LiteratureSection` 解析和临时 `ReferenceLookup`。Analysis 消费经过 Parsing 检查的 `ParserResult`，不直接读取 PDF 字节、修改文献身份、接纳最终元数据、删除文件或写数据库。

## 1. 目标结构

```text
analysis/
  __init__.py
  api.py
  content.py
  service.py
  metadata.py
  metadata_rules.py
  markdown.py
  markdown_rules.py
  references.py
  ports.py
  providers/
    __init__.py
    openai.py
    anthropic.py
```

- `api.py` 提供文献内容分析和参考文献 lookup 两个公开业务操作；
- `content.py` 声明完整内容分析的输入、资源预算和稳定失败；
- `service.py` 按顺序组织元数据确定、内容总结、草稿解析和中性结果返回；
- `metadata.py` 组织第一阶段元数据请求、严格响应解析和阶段结果；
- `metadata_rules.py` 检查结构化最终元数据、用户输入保护和 Parser 输入对齐；
- `markdown.py` 解析第二阶段内容草稿并从已验收 metadata/content 确定性渲染规范 Markdown；
- `markdown_rules.py` 检查固定标题、章节角色、reference 和 Markdown 结构；
- `references.py` 形成临时、按原文对齐且不持久化的参考文献 lookup；
- `ports.py` 声明 Analysis 消费的中性 LLM 能力；
- `providers/` 实现具体 provider/model 协议，并通过 Network 访问外部服务。

当前不建立顶层公共 `llm/` 功能或基础模块。文献总结和 `ReferenceLookup` 共用 Analysis 内部的 LLM Port 与 provider adapter；其它模块只调用 `analysis.api` 的业务操作，不能调用通用 prompt 接口。

## 2. 两个 LLM 用例

Analysis 当前只有两个 LLM 业务用例：

1. **文献内容判断与总结**：根据当前 `ParserResult` 先判断实际内容并确定结构化最终元数据，再以该元数据为上下文形成正文与参考文献草稿；
2. **参考文献检索线索提取**：只在 Entry 选择引用扩展时，根据一组参考文献原文形成临时 `ReferenceLookup[]`。

第二个用例不是第一个用例的完成条件。内容接纳不等待引用目标解析，lookup 失败也不撤销已经接纳的 `LiteratureContent`。

只有未来至少两个独立功能模块真正消费不含文献业务语义的中性 LLM 能力时，才能通过新 ADR 考虑公共 LLM 基础设施；prompt、输出含义和验收规则始终归消费它的功能模块所有。

## 3. 内容分析输入与输出

内容分析公开输入只包含：

- 当前具体 `Literature` 的中性引用；
- 当前主 PDF ID 与 SHA-256；
- 对齐该 PDF 且通过 Parsing 检查的 `ParserResult`；
- 当前统一初始 `LiteratureMetadata` 及其 revision/hash；
- 已解析的 Analysis 配置、资源预算和允许的模型选择。

PDF 绝对路径、SQL row、MinerU 私有输出、HTTP response 和 provider SDK model 不进入公开 API。

Analysis 通过 `ParserResult.markdown` 的 artifact hash 从 Storage 读取完整 UTF-8 Markdown，并核对实际字节与 ParserResult hash。`ParserResult.resources` 当前用于保证中间文档引用完整；文本 LLM 不要求接收图片，Analysis 也不能因为资源存在就隐式启用多模态调用。

第一阶段输出是封闭的二选一结果：

```text
NoUsableContent
  outcome: Literal["no_usable_content"]

FinalMetadataProposal
  outcome: Literal["usable"]
  metadata: LiteratureMetadata

MetadataAnalysisResult = NoUsableContent | FinalMetadataProposal
```

`NoUsableContent` 没有评分、置信度或详细原因；`FinalMetadataProposal` 直接复用 `LiteratureMetadata`，不建立平行元数据类型。LLM provenance 由程序补充，不要求模型输出。

完整内容分析对外仍是封闭二选一：

```text
ContentAnalysisResult =
    NoUsableContent
  | LiteratureContentProposal
```

`NoUsableContent` 必须由第一阶段模型明确表达并通过结构校验。`LiteratureContentProposal` 至少携带待 Literature 验收的最终 `LiteratureMetadata`、解析后的有序 `LiteratureSection[]`、允许为空的有序参考文献文本、输入 PDF/ParserResult/metadata hash，以及形成最终单一 Analysis provenance 所需的 provider/model、prompt 版本和有效参数信息。它是两阶段全部成功后形成的临时交换结果，不作为独立产品事实长期保存，也不形成新的 `LiteratureContentLineage`。其中的最终元数据不是 `MetadataObservation`；只有 Literature 整体接纳后才替换单一当前 `LiteratureMetadata`。

## 4. 两阶段逻辑分析

普通长度文献固定使用两次有序核心 LLM 请求：

1. **元数据确定请求**
   - 输入当前统一初始 `LiteratureMetadata` 和经过验证的完整 `ParserResult`；
   - 先判断是否具有实际文献内容；
   - 内容有效时输出结构化最终 `LiteratureMetadata`，其中包括最终关键词和原文摘要；
   - 保留统一初始 metadata 中没有冲突的可靠值；用户书目导入 observation 提供的非空值除最终关键词和已允许的名称规范化外不得改写，只用 PDF 明示内容补齐摘要、页码等缺失项，并在能够确认同一出版社时统一名称变体；
   - Analysis 验证 schema、标识符格式、输入对应关系和响应完整性；最终业务接纳规则仍由 Literature 验证。
2. **内容总结请求**
   - 只在第一阶段成功后发起；
   - 输入同一 `ParserResult` 和第一阶段已经通过结构验证的完整最终元数据；
   - 输出正文与参考文献的内容 Markdown 草稿；
   - 总结研究背景与目标、研究方法、数据、结论与局限性，在固定结构不足时补充必要正文标题，并按原文顺序识别参考文献文本。

第二阶段必须实际收到第一阶段确定的完整 `LiteratureMetadata`，不能只收到 metadata hash、供应商初始元数据或再次自行推断的摘要。它不得重新生成标题、作者、关键词、摘要或其它元数据。两次请求是一个 Analysis 业务用例的两个内部阶段，对公开 API 仍只返回 `NoUsableContent` 或一份完整 `LiteratureContentProposal`。

超长文献可以在各阶段的 adapter 内使用有界分段和汇总请求，但第二阶段必须等待第一阶段的唯一最终元数据形成。分块必须有明确 token、片段数和总请求预算，任何片段或汇总失败都使本次逻辑分析失败，不能发布拼接残缺结果或第一阶段的部分结果。

### 4.1 第一阶段的作者处理

作者属于第一阶段最终 `LiteratureMetadata`，不由第二阶段正文草稿再次生成。第一阶段可以根据 PDF 明确内容：

- 识别作者署名顺序并清理断行与多余空格；
- 区分个人作者、机构作者和协作组；
- 提取 PDF 明示的 ORCID；
- 根据 PDF 明确的上标、编号或其它对应关系，把作者与署名单位连接起来；
- 在作者能够无歧义对齐时，保留输入统一初始 metadata 已有的 ORCID 和 ROR。

第一阶段不能根据姓名猜 ORCID、根据单位名称猜 ROR、把展示名按空格机械拆分为姓和名、翻译姓名、猜测缺失单位、模糊合并作者，或在对应关系不明时把全部单位分配给全部作者。无法可靠形成 `given_name`、`family_name`、ORCID、单位或 ROR 时保持字段缺失；`display_name` 和实际署名顺序仍须保留。Analysis 只形成这篇具体 Literature 的最终作者列表，不建立跨文献 Author 身份。

## 5. 实际内容判断

- 判断对象是当前 `ParserResult` 是否包含属于目标 Literature、足以说明该文献实际研究、论证、综述、讨论或报告了什么的内容；
- 只有封面、目录、标题与元数据、摘要、访问提示、错误页、下载说明，或者内容明确属于另一篇文献时，可以判定为不可用；
- 页数不能单独决定有效性；完整的一页短文、通信、评论、更正或技术说明仍可通过；
- 明确具有内容时，第一阶段必须同时返回一份结构完整的最终 `LiteratureMetadata`；
- PDF 可能具有正文但 ParserResult 乱码、截断、只剩资源引用或不足以判断时，属于 Parsing/Analysis 失败，必须保留 PDF；
- 缺字段、拒答、未知结构、Markdown 解析失败、artifact/hash 校验失败或输入不对齐都属于 Analysis 失败，不是“没有实际内容”。

只有第一阶段通过验证的 `NoUsableContent` 可以交给 Entry 触发当前 PDF 和对应中间结果清理。第二阶段失败不能推翻第一阶段的内容有效判断，也不能触发删除。Analysis 自身不删除文件，也不持久化无效决定或第一阶段元数据提案。

## 6. 内容 Markdown 草稿合同

第二阶段草稿只包含正文与参考文献，固定一级标题及顺序为：

```markdown
# 研究背景与目标

# 研究方法

# 数据

# 结论与局限性

# 参考文献
```

验证规则是：

- 五个固定 H1 恰好各出现一次，不能改名、删除或重排；
- 额外 H1 只能出现在四个固定正文标题之间或其后、参考文献之前，标题非空且不与任何保留标题冲突；
- `# 参考文献` 始终是最后一个 H1；
- 当前只接受 H1/H2，不接受更深标题层级；
- 四个固定正文 H1 和额外正文 H1 下允许零到多个有序 H2；参考文献下拒绝 H2；
- 草稿出现 `# 元数据` 或 `# 摘要` 时直接拒绝，防止第二阶段形成平行元数据或摘要；
- 固定正文没有相关信息时保留标题并使用精确字符串“未提供”，不能使用其它缺失表达或补写事实；
- 额外正文标题没有实际内容时不创建；
- `# 参考文献` 下只接受 Markdown 有序列表，一项对应一条参考文献原文；没有可识别参考文献时只接受精确字符串“未提供”。

第一阶段形成的标题和原文摘要，以及第二阶段纳入正文的原始数据、数值、单位、公式和参考文献文本，都必须忠于 PDF；允许清理断行、空白和明确 OCR 错误。背景、目标、方法、数据解释、结论与局限可以跨原文章节整理和总结。Analysis 只能验证结构、输入对齐、标识符格式、artifact/hash 和 Markdown 合同，不能证明模型总结在事实层面绝对正确。

## 7. 结构化最终元数据与固定渲染块

第一阶段直接返回 `LiteratureMetadata` 结构化数据，不返回 Markdown，也不让 Analysis 从自由文本反向解析元数据。最终规范 Markdown 的 `# 元数据` 项目名称与顺序固定为：

```markdown
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

程序 renderer 不得增删、改名或重排项目。可选字段在结构化 metadata 中使用 `None`，关键词缺失使用空 tuple；最终 Markdown 一律渲染精确字符串“未提供”，不能使用空字符串、`unknown`、`N/A`、`null`、`None` 或其它自然语言。字段映射遵守：

- DOI 映射到 `LiteratureMetadata.identifiers` 中 namespace 为 `doi` 的标识符；
- Other Identifiers 只包含非 DOI 稳定标识符；
- Authors 和 Keywords 使用第一阶段结构化结果中经过验证的顺序；
- Authors 或 Keywords 整体缺失时相应固定项显示“未提供”；
- Abstract 不进入元数据块，而由 renderer 从 `LiteratureMetadata.abstract` 写入独立的 `# 摘要`；值为 `None` 时显示“未提供”；
- URL、开放获取、许可证、引用计数、供应商、状态和 provenance 一律拒绝进入元数据块。

第一阶段返回完整 metadata，不返回字段级 patch。摘要、页码或其它值只有在统一初始 metadata 已有可靠值，或 PDF 中能够找到明确依据时才能进入最终提案；不得根据常识补写。用户书目导入 observation 的非空字段作为最高优先级可靠值保留；`keywords` 仍由本次全文分析形成，`publisher` 可以在确认同一实体时使用项目约定的规范名称收敛诸如法人后缀差异之类的来源变体，其它字段只补缺不改写。metadata provider 和 bibliographic import 的身份继续由 `MetadataObservation.provenance` 表达，不能混入 `publisher`。Literature 验收时以该完整提案建立新的 metadata revision，并保留全部来源 observation。

Authors 项由程序从最终 `LiteratureMetadata.authors` 确定性渲染，不使用自由文本占位。例如：

```markdown
+ Authors:
  1. Ada Lovelace
     + Kind: person
     + Given Name: Ada
     + Family Name: Lovelace
     + ORCID: 0000-0002-1825-0097
     + Affiliations:
       1. Analytical Engine Institute
          + ROR: 03yrm5c26
```

每位作者始终渲染 `display_name` 和 `kind`；`given_name`、`family_name`、ORCID、Affiliations 及单位 ROR 只在结构化值存在时渲染。作者与单位顺序保持不变。第二阶段不接收独立 Authors 草稿，也不能覆盖第一阶段已经确定的结构化作者。

最终 metadata 仍必须满足 Literature 的最低接纳规则：非空标题或 DOI 至少存在一个。`document_type` 保持开放字符串，`pages` 原样表达传统页码范围或来源使用的电子文章定位号。

供应商声明关键词仍留在 `MetadataObservation.declared_keywords`。Analysis 形成的最终关键词只进入 `LiteratureMetadata.keywords`，使用扁平列表表达文献的核心领域、问题、方法、对象、材料、理论或贡献，不要求维度齐全。测试、benchmark、对照、背景或次要案例中的术语不能机械成为关键词；不建立其它平行分类、关键词或标签结果。

## 8. LiteratureSection 与参考文献

正文统一解析为一个有序 `LiteratureSection[]`，精确结构为：

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

四个固定角色各出现一次并保持相对顺序，`title = None`，展示标题由 renderer 决定。`additional` 可以出现零到多次，必须携带不与七个固定标题冲突的非空自定义 title。所有固定和额外 H1 处于同一序列，因而能够表达额外章节插入固定章节之间的真实位置；不能使用 `other: dict`、动态 Pydantic 字段或脱离主序列的 `additional_sections` 袋子。

程序只理解 H1/H2。每个 H1 在首个 H2 前的直属内容保存在 `LiteratureSection.markdown`，每个 H2 的内容保存在 `LiteratureSubsection.markdown`；段落、列表、表格、公式和代码块不再细拆。固定 section 有实际内容时必须具有非空 H1 直属 Markdown 或至少一个有内容的 H2；只有 H2 有内容时 H1 的 `markdown` 可以为空字符串。整体没有相关信息时使用 `markdown = "未提供"` 和空 subsections，“未提供”不能与有内容的 H2 混用。额外 section 没有内容时不创建。当前合同不建立 block/bbox/source-locator 图；正文与最终文档通过单一 Analysis provenance 的输入 hash 回溯到 PDF、ParserResult 和最终 metadata。元数据、摘要和参考文献不作为 `additional` section。

参考文献独立保存为：

```text
LiteratureContent.references: tuple[str, ...]
```

第二阶段草稿的固定语法为：

```markdown
# 参考文献

1. 第一条参考文献原文
2. 第二条参考文献原文
```

一项有序列表元素对应 PDF 中一条非空参考文献原文。程序去掉编号后保持引用顺序；标题、作者或 DOI 缺失时仍保存已有文本，不建立残缺的第二文献元数据，也不补写 PDF 未表达的信息。没有可识别参考文献时保存空 tuple，规范 Markdown 显示“未提供”；该字符串不能解析成参考文献。文档导出直接读取这些原文，不依赖引用目标是否已经解析。

## 9. 两阶段验收与规范 Markdown 发布

Analysis 按顺序执行：

1. 验证第一阶段的明确无内容决定或结构化最终 metadata 二选一；
2. 内容有效时，验证最终 metadata，并把它与同一 ParserResult 一起交给第二阶段；
3. 验证第二阶段固定正文标题、额外标题、参考文献和 H2 层级，并拒绝平行的元数据或摘要标题；
4. 解析有序 sections 和 references；
5. 验证标识符、输入 PDF/ParserResult/初始 metadata hash，并形成最终单一 Analysis provenance 所需信息；
6. 形成包含最终 metadata 的封闭 `LiteratureContentProposal` 交给 Literature。

Literature 负责确认提案属于当前具体 Literature、当前主 PDF 和当前 metadata revision，验收最终 `LiteratureMetadata`，并接纳 `LiteratureContent`。接纳在同一事务中递增当前 metadata revision 并替换当前 metadata/content/Markdown；旧统一元数据不形成历史，全部来源 `MetadataObservation` 不受影响。随后程序从已验收 metadata、sections 和 references 确定性渲染具有七个固定 H1 的规范 Markdown：`# 元数据` 从最终 metadata 渲染，`# 摘要` 从 `metadata.abstract` 渲染，正文与参考文献从第二阶段已解析内容渲染。不会再请求 LLM 复制元数据或组装另一份 Markdown。

最终精确合同为：

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

规范 Markdown artifact 的 `media_type = "text/markdown"`，字节固定为 UTF-8。`literature_content_sha256` 只覆盖 `metadata_sha256`、`sections` 和 `references` 的规范序列化，不包含 metadata revision、provenance、模型、时间、路径、Markdown hash 或数据库 ID；`markdown.sha256` 只覆盖最终 Markdown 字节。

`provenance` 只有一项，`source_kind = "analysis"`，`source_name` 是 provider/model 标识，`input_sha256` 覆盖 PDF hash、ParserResult hash 和最终 metadata hash，`parameters_sha256` 覆盖 prompt 版本与有效模型参数，`observed_at` 是总结完成时间。Parser provenance 留在 ParserResult，不复制到 LiteratureContent；不保存两个请求的独立 provenance、完整 prompt/request/response、task ID、endpoint、GPU 或机器路径。

第一阶段 metadata 提案和第二阶段内容草稿都不单独持久化。规范 Markdown 使用 create-if-absent 发布；每个 Literature 只保留一个当前 LiteratureContent。后续 metadata 或内容变化时先完整生成、验证并由 Literature 接纳新结果，再原子替换当前关系；失败保留旧结果。旧结构化内容和 Markdown 字节不形成数据库历史，只作为可回收缓存。最终 metadata、keywords、sections、references、artifact 关系、旧 content support 清理和 `CONTENT_READY` 依据作为一个逻辑更新整体提交。

替换当前 content 时删除指向旧 `literature_content_sha256` 的 `ContentReferenceTextSupport`；某条 Reference 因而没有其它 support 时一并删除。新 references 后续按普通 lookup/Reference 流程处理，`ProviderRelationSupport` 和 `MetadataReferenceTextSupport` 不受影响。当前内容丢失、损坏或输入不再对齐时，可以从权威元数据和当前 PDF 重新生成。

## 10. ReferenceLookup

引用扩展操作只接收一组有稳定顺序的参考文献原文及其来源上下文。Analysis 可形成：

```text
ReferenceLookup
  reference_index: int
  identifiers: Identifier[]
  title: str | None
  authors: str[]
  publication_year: int | None
```

`reference_index` 只定位本次输入列表中的原文。LLM 只提取原文明示的搜索线索；至少存在一个可校验稳定标识符或非空标题时才返回可执行 lookup。代码验证并规范化 DOI、PMID、arXiv ID 等明确格式。Lookup 由 Entry 立即用于本地精确查询或 Metadata 搜索，不持久化、不写入 `LiteratureContent`，也不能直接创建目标 Literature、Reference 或 ReferenceSupport。

## 11. LLM Port、Network 与失败

LLM Port 使用 `model/llm.py` 中的中性请求与响应，明确区分元数据确定、内容总结和 ReferenceLookup 三种请求语义；前两种属于同一个文献内容分析用例的有序内部阶段。Provider adapter 负责 provider/model 映射、凭据附着、timeout、quota、协议重试、响应解析以及本次逻辑分析形成 provenance 所需的 provider/model identity。单次请求信息只用于当前调用与诊断，不作为 LiteratureContent 的两项持久化 provenance。所有外部访问都经过 Network 的 URL、TLS、redirect、预算和脱敏政策；vendor SDK 不能绕过这一边界。

Timeout、认证失败、限流、拒答、截断、未知结构、Markdown 不合格、artifact/hash 校验失败或输入 stale 时：

- 返回稳定、脱敏的 Analysis 失败；
- 保留当前 PDF 和以前已经接纳的有效内容；
- 不形成 `NoUsableContent`；
- 不长期保存第一阶段 metadata 提案或第二阶段待验收草稿；
- 后续运行可以重新分析。

Secret、完整请求 header、底层 SDK 对象、prompt 原文和未脱敏异常不得进入 Model、provenance、持久化结果或用户输出。

## 12. 验收

直接测试至少覆盖：

- 普通有效文献严格按顺序执行两个核心 fake LLM 请求，第二次收到第一次确定的完整 `LiteratureMetadata`；
- 第一阶段只接受精确 `NoUsableContent` 或 `FinalMetadataProposal`；明确无内容时不执行第二阶段，且与任一阶段调用/结构失败严格区分，只有前者可以触发 Entry 清理；
- 只有封面、目录、标题/元数据/摘要、访问或错误提示以及明确错文献可判无内容；一页完整短文可以有效，ParserResult 乱码、截断、只有资源引用或无法判断必须保留 PDF；
- 第二阶段内容草稿的五个固定 H1、固定顺序和最后参考文献规则；
- 第二阶段缺失固定标题、重复标题、保留标题冲突、出现元数据/摘要、H3 或未知结构时被拒绝；
- 第一阶段结构化结果精确形成 `LiteratureMetadata`，摘要只来自 `LiteratureMetadata.abstract`；
- 第一阶段保留用户书目导入 observation 的非空值，只允许重新形成全文 keywords、执行既定 publisher 规范化和用 PDF 补缺；
- 第一阶段能够保留作者顺序、机构作者、明确 ORCID 及作者—单位映射；缺失值保持缺失，不猜测 ORCID/ROR、不机械拆名、不模糊合并或把全部单位分给全部作者；
- Authors 块只由程序从最终结构化 `Author[]` 确定性渲染，可选字段仅在存在时输出，第二阶段不能产生或覆盖作者元数据；
- 最终关键词与供应商 `declared_keywords` 分离，且不存在平行分类或标签结果；
- 四个固定 `LiteratureSection` role 恰好各一次，章节和 H2 使用 Markdown 字符串，额外章节能保留插入位置和有序 H2；固定内容缺失使用“未提供”，无内容额外章节不创建；
- 参考文献有序列表按 PDF 顺序保存非空文本，缺标题或 DOI 时不编造；没有参考文献时为空 tuple 且渲染“未提供”，缺失标记不成为一条引用；
- 数值、单位、公式和标识符的结构与输入对齐检查；
- Literature 验收后由程序确定性渲染七个固定 H1 的 metadata、摘要、正文和参考文献，LLM 不被再次调用；
- `literature_content_sha256` 只覆盖 metadata hash、sections 和 references，Markdown hash 只覆盖 UTF-8 字节；单一 Analysis provenance 对齐 PDF、ParserResult、最终 metadata、模型和 prompt/参数 hash；
- 每个 Literature 只有一个当前 LiteratureContent，新结果失败保留旧结果，成功替换时清理旧 content support 及因此无 support 的 Reference；
- stale 输入或 Storage 失败不留下部分最终 metadata/content；
- `ReferenceLookup` 只提取原文明示线索，不持久化或直接建关系；
- 超长文献分段失败不会发布不完整合并结果，且总请求数受预算约束；
- vendor 类型、secret、prompt 和未脱敏错误不进入公开 API、Model 或持久化结果。

测试使用 fake LLM 和构造的 ParserResult，不调用真实模型或用户语料。
