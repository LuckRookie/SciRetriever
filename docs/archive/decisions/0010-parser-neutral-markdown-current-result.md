# ADR 0010：Parser-neutral Markdown 与单一当前解析结果

- Status: Superseded by [ADR 0037](../../architecture/decisions/0037-literature-archive-and-proofread-text.md)（2026-10-20）
- Date: 2026-08-07
- Last amended: 2026-09-26
- Supersedes: none
- Amends: [ADR 0003](../../architecture/decisions/0003-operator-managed-mineru-service.md)、[ADR 0007](../../architecture/decisions/0007-reference-resolution-and-authoritative-relations.md)、[ADR 0008](0008-summarized-markdown-literature-content.md)
- Related: [产品需求](../../architecture/requirements.md)、[设计文档](../../architecture/design.md)、[文档与证据：解析转换与中性结果](../../architecture/technical/04-document-evidence.md#2-解析转换与中性结果)、[统一产品接口：共享合同、结构解析与版本兼容](../../architecture/technical/01-product-interface.md#6-共享合同结构解析与版本兼容)、[版本化材料与知识存储：Catalog 与文件组织](../../architecture/technical/07-versioned-storage.md#2-catalog-与文件组织)
- Amended by: [ADR 0026](../../architecture/decisions/0026-agent-knowledge-and-human-collaboration.md)

> 2026-10-20 [ADR 0037](../../architecture/decisions/0037-literature-archive-and-proofread-text.md)已整体取代本 ADR：单一当前解析结果、私有输出一律清理、不建立区块定位与不合并多套结果整体由原始解析与校订稿取代。仍有效的原则已并入 ADR 0037。本文仅作历史背景，不约束当前设计。

> 2026-09-25 修订：解析仅作中间结果、无逐段定位、旧表示无条件可回收的范围收缩已被修订；新目标支持独立读取和稳定证据生命周期。详见 [ADR 0026](../../architecture/decisions/0026-agent-knowledge-and-human-collaboration.md)。下文保留原决定与兼容背景；冲突条款按新 ADR 执行，具体实现状态以源码和 TS 基线为准。

## 背景

Parsing 需要适配 MinerU、GROBID、Docling、PyMuPDF 等不同解析器。MinerU 的 `middle.json`、`content_list.json`、坐标、block 和运行后端只是一个具体实现的私有输出，不能反向定义 SciRetriever 的公共 `ParserResult`。

Analysis 当前真正需要的是一份可由语言模型读取、能够追溯到输入资产的完整中间文档。Owner 已确认：各 Parser Adapter 统一交付规范化 Markdown；保留 Markdown 实际引用的资源及其 hash，但 Parsing 不理解图片内容，也不要求当前 Analysis 使用图片。当前产品也不需要页级 block graph、bbox 或逐段 PDF source locator。

解析中间结果不是用户产品文档或 Literature 状态事实。文献规模扩大后，为同一输入长期维护多套旧解析产物会浪费空间和管理成本；Owner 因此要求数据库只保存一个当前解析结果，成功重解析后直接替换当前结果，旧字节只作为可回收缓存存在。

## 决策

### 1. ParserResult 由消费合同定义

`ParserResult` 是 Parsing 向 Analysis 及 Document/Evidence 交付的 parser-neutral 解析合同，不是对 MinerU 或其它具体解析器输出的抽象副本。文档读取、检索和提取通过中性文档/证据能力消费它。MinerU Markdown/JSON、GROBID TEI、Docling JSON、PyMuPDF block 等私有结果均由各自 Adapter 在边界内验证和转换，不能进入公共 Model。

各 Adapter 必须产生同一类规范化 Markdown。不能直接产生 Markdown 的解析器由自己的 Adapter 完成确定性转换；增加新 Parser 不得改变 Analysis 的输入含义。

### 2. 精确中间合同

既有 ParserResult 兼容合同为（历史 Python 类型记法；当前 TS 名称以 contracts 为准）：

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

`ParserResult` 不包含 Markdown 正文副本、页级 block、bbox、source locator、参考文献判断、内容可用性判断或解析器私有字段。Analysis 通过 Storage 读取 `markdown`，当前不自动把关联图片发送给模型；未来多模态 Analysis 可以消费已经保留的资源，但那是 Analysis 的独立设计。新 Document/Evidence 的中性片段/资源定位由独立合同定义；这里不含 locator 的旧 schema 不禁止该能力，也不授权公开 parser 私有结构。

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

替换当前关系不允许原地覆盖文件。新字节仍按内容寻址 create-if-absent 发布；旧兼容关系不承诺保存每次解析历史。按 ADR 0026，新文档/知识引用绑定具体表示版本；只失去 current 关系不能证明其可回收，仍被有效证据引用的表示须继续可读，或执行明确的失效/重建政策。精确保留与回收 schema 待设计，外部 parser task 历史仍不因此进入产品合同。

当前 ParserResult 是可替换中间结果，不推进 `LiteratureStatus`。该规则不允许覆盖当前主 PDF 或已接纳 `LiteratureMetadata`；已接纳的当前 `LiteratureContent` 与规范产品 Markdown 只有在新的完整 Analysis 结果通过 Literature 验收后才能原子替换。最终内容通过单一 Analysis provenance 的输入 hash 绑定 PDF、ParserResult 和最终 metadata；它不要求永久保存全部旧解析尝试，但不能据此破坏新知识产物的有效证据依赖。

### 5. Parser 私有产物是过程文件

MinerU 的 `middle.json`、`content_list.json`、`content_list_v2.json`、model output、layout/span PDF、归档及未引用图片，GROBID TEI、Docling 原生 JSON 和其它 Parser 私有输出，都只用于适配、验证与转换。当前 `ParserResult` 成功提交或本次尝试结束后清理这些过程文件，不写入 Catalog，也不成为公开合同。

### 6. 结构检查与内容判断分离

Parsing 只检查输入 hash、页数、UTF-8 非空 Markdown、资源路径与完整性、parser provenance、结果 hash 和提交前 current-PDF 对齐。标题、摘要、公式、数值、参考文献、正文完整性和“是否具有实际文献内容”不由 Parsing 判断。

旧 Analysis 第一阶段继续负责其用例的实际内容判断。`NoUsableContent`、不适用或 Parser/LLM 失败都不能单独授权删除已接纳 PDF 和解析表示；资产拒绝、失效或显式删除由相应 owner 的独立规则决定。

### 7. 文本参考文献不依赖逐段 locator

`LiteratureContent` 的正文 section 保存 Markdown 字符串，参考文献保存有序文本，并通过整份内容的一项 Analysis provenance 及其输入 hash 回溯到 PDF、ParserResult 和最终 metadata。ParserResult 自身继续拥有 parser provenance，LiteratureContent 不复制它，也不保存两阶段 LLM 调用的独立 lineage。这个旧兼容合同不保存逐段 `SourceLocator`。新增知识/提取证据由 Document/Evidence 提供，不受该限制；它与用于权威书目引用关系的 ReferenceSupport 职责不同。

`ContentReferenceTextSupport` 继续用不可变 `literature_content_sha256 + reference_index` 精确定位一条参考文献文本；它不需要 block、bbox 或逐段 PDF 坐标。ADR 0007 中引用目标接纳、权威 `Reference` 与三种 `ReferenceSupport` 的其它边界保持不变。

## 后果

- Analysis 永远消费同一类 Markdown 中间文档，不需要理解具体 Parser。
- MinerU 的 VLM、pipeline 或其它 backend 只改变 Adapter 配置和 provenance，不产生不同公共 schema，也不自动竞速、回退或合并。
- ParserResult 保留 Markdown 实际引用的资源，未来可以增加多模态 Analysis，而当前不增加图片理解要求。
- 既有 current 关系仍原子替换；新证据需要的表示版本另按明确依赖与保留规则管理，不能仅按缓存预算删除。
- 旧版本的无逐段 locator 范围收缩已由 ADR 0026 修订。整体 hash/provenance 保留，新 Document/Evidence 增加稳定定位与版本语义；能够定位不等于证明科学结论。
- 当前迁移前代码中的 `LightDocumentV1`、`ManifestBlock` 和 MinerU 专属 `ParserProvenance` 不是目标合同，不能反向约束实现。

## 需要新 ADR 的变化

以下超出 ADR 0026 已接受的独立文档读取、证据及版本生命周期的变化，需要新的 owner 决策：

- 重新把 parser 私有 JSON、TEI、block、bbox 或 source locator 提升为公共合同；
- 同时保存、竞速、合并或自动回退多套 Parser 结果；
- 无条件永久保存全部 Parser 尝试历史，或破坏既有 ParserResult 字节格式；独立文档读取与有效证据版本保留已获接受；
- 让 Parser 直接判断实际内容、产生 `LiteratureContent`、`ReferenceLookup` 或权威 `Reference`；
- 取消 ParserResult 的输入/结果 hash 与 parser provenance，或取消最终内容的 PDF/ParserResult/metadata 输入 hash 与 Analysis provenance。
