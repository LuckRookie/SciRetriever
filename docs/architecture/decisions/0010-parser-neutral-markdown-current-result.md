# ADR 0010：Parser-neutral Markdown 与单一当前解析结果

- Status: Accepted
- Date: 2026-08-07
- Supersedes: none
- Superseded by: none
- Amends: [ADR 0003](0003-operator-managed-mineru-service.md)、[ADR 0007](0007-reference-resolution-and-authoritative-relations.md)、[ADR 0008](0008-summarized-markdown-literature-content.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[Parsing 技术文档](../technical/parsing.md)、[Model 技术文档](../technical/model.md)、[Storage 技术文档](../technical/storage.md)

## 背景

Parsing 需要适配 MinerU、GROBID、Docling、PyMuPDF 等不同解析器。MinerU 的 `middle.json`、`content_list.json`、坐标、block 和运行后端只是一个具体实现的私有输出，不能反向定义 SciRetriever 的公共 `ParserResult`。

Analysis 当前真正需要的是一份可由语言模型读取、能够追溯到输入资产的完整中间文档。Owner 已确认：各 Parser Adapter 统一交付规范化 Markdown；保留 Markdown 实际引用的资源及其 hash，但 Parsing 不理解图片内容，也不要求当前 Analysis 使用图片。当前产品也不需要页级 block graph、bbox 或逐段 PDF source locator。

解析中间结果不是用户产品文档或 Literature 状态事实。文献规模扩大后，为同一输入长期维护多套旧解析产物会浪费空间和管理成本；Owner 因此要求数据库只保存一个当前解析结果，成功重解析后直接替换当前结果，旧字节只作为可回收缓存存在。

## 决策

### 1. ParserResult 由消费合同定义

`ParserResult` 是 Parsing 向 Analysis 交付的 parser-neutral 中间合同，不是对 MinerU 或其它具体解析器输出的抽象副本。MinerU Markdown/JSON、GROBID TEI、Docling JSON、PyMuPDF block 等私有结果均由各自 Adapter 在边界内验证和转换，不能进入公共 Model。

各 Adapter 必须产生同一类规范化 Markdown。不能直接产生 Markdown 的解析器由自己的 Adapter 完成确定性转换；增加新 Parser 不得改变 Analysis 的输入含义。

### 2. 精确中间合同

目标合同为：

```text
ParserArtifactRef
  sha256: Sha256
  media_type: str
  byte_size: int

ParserResource
  reference: str
  artifact: ParserArtifactRef

ParserProvenance
  provenance: Provenance
  parser_version: str
  mode: str | None
  model_identity: str | None

ParserResult
  source_asset_id: AssetId
  source_sha256: Sha256
  page_count: int
  markdown: ParserArtifactRef
  resources: tuple[ParserResource, ...]
  result_sha256: Sha256
  provenance: ParserProvenance
```

`markdown` 指向 Storage 中不可变、UTF-8 的 `text/markdown` 字节。`resources` 只保存该 Markdown 实际使用的规范化相对引用及其不可变文件描述；绝对路径、父目录逃逸、外部 URL 冒充本地资源和未被 Markdown 引用的文件不得进入结果。Parsing 只保证资源存在、hash/大小/媒体类型对齐，不解释图片或表格的科学含义。

`result_sha256` 是规范化结果清单的确定性 hash。清单包含输入资产身份/hash、页数、Markdown artifact、按 `reference` 排序的资源，以及 parser 名称、版本、mode、model identity 和参数 hash；不包含观察时间、provenance ID、task ID、endpoint 或机器路径。同一规范输入产生相同清单 hash。

`ParserResult` 不包含 Markdown 正文副本、页级 block、bbox、source locator、参考文献判断、内容可用性判断或解析器私有字段。Analysis 通过 Storage 读取 `markdown`，当前不自动把关联图片发送给模型；未来多模态 Analysis 可以消费已经保留的资源，但那是 Analysis 的独立设计。

### 3. Parser provenance

`ParserProvenance.provenance` 复用公共 `Provenance`，并满足：

- `source_kind = "parser"`；
- `source_name` 是 `mineru`、`grobid`、`docling`、`pymupdf` 等稳定解析器名称；
- `source_record_id = None`，外部 task ID 不长期保存；
- `observed_at` 是新结果完成并被接纳的时间；
- `input_sha256` 必须等于 `ParserResult.source_sha256`；
- `parameters_sha256` 必须覆盖 parser 名称、版本、mode、model identity、影响输出的有效参数和 Markdown 转换规则版本。

`parser_version` 必填；没有 mode 或模型的 Parser 分别使用 `None`。Provenance 不保存凭据、endpoint、请求 header、Cookie、GPU 编号、临时路径、原始参数字典或未脱敏错误。

### 4. 只保存一个当前结果

每个输入 `Asset` 最多有一个数据库当前 `ParserResult`。重解析必须先在 staging 完成新 Markdown、资源、结构和 hash 验证，再以短事务原子替换当前关系；新解析或提交失败时保留完整旧结果。

替换当前关系不允许原地覆盖文件。新字节仍按内容寻址 create-if-absent 发布；旧结果失去数据库引用后进入不受产品合同保证的本地缓存，并由统一缓存策略回收。Catalog 不保存 ParserResult 历史、旧参数、旧 provenance、外部 task 历史或旧 artifact 关系。

当前 ParserResult 是可替换中间结果，不推进 `LiteratureStatus`。该规则不允许覆盖当前主 PDF 或已接纳 `LiteratureMetadata`；已接纳的当前 `LiteratureContent` 与规范产品 Markdown 只有在新的完整 Analysis 结果通过 Literature 验收后才能原子替换。最终内容通过单一 Analysis provenance 的输入 hash 绑定 PDF、ParserResult 和最终 metadata；它不要求旧 ParserResult 字节永久存在。

### 5. Parser 私有产物是过程文件

MinerU 的 `middle.json`、`content_list.json`、`content_list_v2.json`、model output、layout/span PDF、归档及未引用图片，GROBID TEI、Docling 原生 JSON 和其它 Parser 私有输出，都只用于适配、验证与转换。当前 `ParserResult` 成功提交或本次尝试结束后清理这些过程文件，不写入 Catalog，也不成为公开合同。

### 6. 结构检查与内容判断分离

Parsing 只检查输入 hash、页数、UTF-8 非空 Markdown、资源路径与完整性、parser provenance、结果 hash 和提交前 current-PDF 对齐。标题、摘要、公式、数值、参考文献、正文完整性和“是否具有实际文献内容”不由 Parsing 判断。

Analysis 第一阶段继续负责实际内容判断。只有结构有效的明确 `NoUsableContent` 可以触发 Entry 清理当前 PDF 和 ParserResult；Parser/LLM 失败不能触发删除。

### 7. 文本参考文献不依赖逐段 locator

`LiteratureContent` 的正文 section 保存 Markdown 字符串，参考文献保存有序文本，并通过整份内容的一项 Analysis provenance 及其输入 hash 回溯到 PDF、ParserResult 和最终 metadata。ParserResult 自身继续拥有 parser provenance，LiteratureContent 不复制它，也不保存两阶段 LLM 调用的独立 lineage。当前合同不保存逐段 `SourceLocator`。

`ContentReferenceTextSupport` 继续用不可变 `literature_content_sha256 + reference_index` 精确定位一条参考文献文本；它不需要 block、bbox 或逐段 PDF 坐标。ADR 0007 中引用目标接纳、权威 `Reference` 与三种 `ReferenceSupport` 的其它边界保持不变。

## 后果

- Analysis 永远消费同一类 Markdown 中间文档，不需要理解具体 Parser。
- MinerU 的 VLM、pipeline 或其它 backend 只改变 Adapter 配置和 provenance，不产生不同公共 schema，也不自动竞速、回退或合并。
- ParserResult 保留 Markdown 实际引用的资源，未来可以增加多模态 Analysis，而当前不增加图片理解要求。
- 数据库不积累旧 ParserResult 历史；成功重解析替换当前关系，旧字节可按缓存预算回收。
- 失去逐段 PDF locator 是有意的范围收缩；当前可追溯性由资产 hash、ParserResult hash、最终 metadata hash 和单一 Analysis provenance 保证。
- 当前迁移前代码中的 `LightDocumentV1`、`ManifestBlock` 和 MinerU 专属 `ParserProvenance` 不是目标合同，不能反向约束实现。

## 需要新 ADR 的变化

以下变化需要新的 owner 决策：

- 重新把 parser 私有 JSON、TEI、block、bbox 或 source locator 提升为公共合同；
- 同时保存、竞速、合并或自动回退多套 Parser 结果；
- 长期保存 ParserResult 历史或把它提升为用户可查询的产品文档；
- 让 Parser 直接判断实际内容、产生 `LiteratureContent`、`ReferenceLookup` 或权威 `Reference`；
- 取消 ParserResult 的输入/结果 hash 与 parser provenance，或取消最终内容的 PDF/ParserResult/metadata 输入 hash 与 Analysis provenance。
