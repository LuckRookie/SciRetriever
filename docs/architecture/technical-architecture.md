# SciRetriever 技术架构

- 产品依据：[产品需求](requirements.md)
- 系统设计：[系统设计](system-design.md)
- 稳定原则：[架构原则](principles.md)
- 重要决策：[架构决策](decisions/README.md)

本文把已经确认的系统设计映射为目标代码模块、依赖方向、数据与事务边界、运行模型、外部适配器和架构验收规则。本文描述理想实现，不记录当前代码清单、实施差距或迁移进度；当前已发布行为仍以项目 `README`、源码和测试为准。

## 1. 技术起点

### 1.1 总体选择

SciRetriever 采用单机 Python 模块化单体：

- Python 3.10+，开发基线为 Python 3.12；
- 一个可安装的 `sciretriever` 包和一个前台 CLI composition root；
- SQLite 作为关系事实、事务和统一读取视图的持久化引擎；
- 同一配置存储根下的内容寻址文件系统保存主 PDF、补充资产、轻结构化文档和结构化分析产物；
- SQLAlchemy 2.x 只用于持久化适配器，不进入业务模块；
- 外部元数据来源、引用来源、资产来源、解析器和语言模型都通过显式端口接入；
- 一个主机、一个 catalog 同时只允许一个修改核心文献事实的批量执行；
- 查询和只读导出可以与核心写批次并行读取已提交事实；
- 不引入常驻 SciRetriever daemon、分布式 worker 或外部工作流平台。

SQLite 与文件系统组成一个逻辑文献数据库，但二者拥有不同物理责任：SQLite 保存身份、关系、当前指针、hash、相对路径和业务结果；文件系统保存不可变大对象。任何模块都不得把大型文献或分析产物作为关系型 BLOB 写入 SQLite。

### 1.2 设计原则

1. 业务模块拥有决定，持久化模块只落实决定。
2. 一个可变事实只有一个业务写入所有者。
3. WorkVersion 状态只从已提交权威事实推导，不维护第二个工作流状态。
4. 外部输入先转换为所有者定义的中性类型，再进入核心逻辑。
5. 网络、解析和语言模型调用不在 SQLite 事务中执行。
6. 文件先不可变发布，SQLite 后建立引用；失败只能产生不可见孤儿，不能产生缺失文件的有效数据库引用。
7. 每篇文献按阶段短事务提交，批量中一篇失败不回滚其它文献。
8. 当前代码中的四阶段 completion、阶段并发 admission 和命令结构不构成目标技术合同。

## 2. 目标代码结构

```text
src/sciretriever/
  kernel/
    ids.py
    hashes.py
    errors.py
    time.py
    contracts.py

  collection/
    api.py
    model.py
    ports.py
    service.py

  bibliography/
    api.py
    model.py
    identity.py
    metadata.py
    completion.py
    ports.py

  content/
    api.py
    model.py
    acquisition.py
    parsing.py
    analysis.py
    ports.py

  literature_store/
    api.py
    sqlite/
      engine.py
      schema.py
      repositories.py
      transactions.py
      read_models.py
      fts.py
    filesystem/
      artifacts.py
      publication.py
      reconciliation.py

  interoperability/
    api.py
    query.py
    import_service.py
    export_service.py
    curation.py
    ports.py
    codecs/

  batching/
    api.py
    model.py
    selection.py
    advancement.py
    exchange.py
    admission.py
    recovery.py
    ports.py

  adapters/
    metadata/
    citation/
    acquisition/
    parser/
    llm/
    transport/

  extensions/
    packaging/

  runtime/
    config.py
    secrets.py
    registry.py
    bootstrap.py
    cli.py
```

`kernel`、`adapters`、`extensions` 和 `runtime` 不是新的业务模块：

- `kernel` 只保存跨模块稳定值类型和无业务所有权的基础合同；
- `adapters` 把外部能力转换为业务模块定义的端口；
- `extensions` 只读取核心事实并发布可选结果，不反向影响核心流程；
- `runtime` 是唯一组装具体实现、配置和凭据的 composition root。

## 3. 六个模块的技术所有权

| 系统设计模块 | 代码所有者 | 独占决定与事实 |
|---|---|---|
| 文献收集 | `collection` | Collection 定义、CollectionRun、主题或引用迭代语义、停止边界、CollectionMembership、发现原因和引用路径 |
| 文献信息管理 | `bibliography` | Work/WorkVersion 身份、来源 observation、当前统一元数据、版本关系、代表版本、权威引用、权威标签、四级状态推导和最终提案验收 |
| 文献内容处理 | `content` | PDF 候选获取与验收、主 PDF、补充资产、轻结构化文档、parser provenance、九类结构化分析提案和步骤失败证据 |
| 文献数据库 | `literature_store` | SQLite schema、repository、事务、统一读取视图、FTS 派生索引、不可变文件发布和对账；不执行身份或内容业务判断 |
| 文献库使用与互操作 | `interoperability` | 查询语义、有限整理请求、四类书目 codec、导入转换、导出选择和格式表达 |
| 批量执行与结果说明 | `batching` | 实际缺失目标选择、两类执行封套、核心写批次 admission、逐目标结果、批量摘要、当前失败投影和中断恢复 |

关键分界如下：

- `content` 生成完整结构化分析以及最终元数据、引用和标签提案，但不直接修改权威统一信息；
- `bibliography` 自动验收完整提案，是最终元数据、引用、标签和 WorkVersion 状态含义的唯一业务所有者；
- `literature_store` 可以在一个物理事务中同时写入多个所有者已经确认的事实，但不能自行形成提案或改变业务含义；
- `batching` 保存逐目标结果和当前失败投影；发生失败的业务模块负责产生类型化失败证据；
- `interoperability` 决定记录是否可导入或导出，`batching` 只提供执行封套与汇总；
- 导入记录转换为初始元数据后不长期保留书目文件、外部工具对象、格式私有字段或导入过程 provenance。

## 4. 依赖方向

### 4.1 允许的依赖图

```text
kernel

bibliography     -> kernel
collection       -> kernel + bibliography.api
content          -> kernel
interoperability -> kernel + bibliography.api

batching         -> kernel
                    + collection.api
                    + bibliography.api
                    + content.api
                    + interoperability.api

literature_store -> kernel
                    + 各业务模块公开的 persistence ports / DTO

adapters         -> kernel
                    + 对应业务模块公开的 capability ports / DTO

extensions       -> kernel + 公开只读合同
runtime          -> 全部公开 API 与具体实现
```

### 4.2 强制规则

1. 业务模块不得导入 `literature_store`、SQLAlchemy、SQLite 表对象、文件系统实现、vendor SDK、环境变量或 CLI 类型。
2. `literature_store` 只实现业务模块面向内部定义的 repository、读取和事务端口，不导入业务 service 实现。
3. `collection` 和 `interoperability` 只能通过 `bibliography.api` 请求身份或统一元数据变更。
4. `content` 只接收已经解析好的 ContentTarget，并返回内容事实或提案；它不直接读取 bibliography repository。
5. `batching` 通过公开 API 编排多个模块，但不得直接写 Work、WorkVersion、元数据、资产、文本、分析、引用或标签表。
6. 外部 adapter 只实现其所有者公开的 capability port，vendor 类型不能出现在业务模块公开合同中。
7. 只有 `runtime.bootstrap` 可以选择具体 repository、provider、transport、parser、LLM、codec、admission 和配置实现。
8. 不允许跨模块导入另一个模块的 `service.py`、私有模型、SQL 表或文件路径布局。
9. `extensions` 只能通过公开只读接口消费稳定 ID、hash、provenance 和领域中立结果；核心模块不得依赖 extension。
10. `runtime.cli` 只负责参数解析、配置选择、组装、调用 use case 和稳定输出，不实现业务规则。

### 4.3 公共合同规则

- 跨模块 ID 使用不可互换的值对象，不传递无品牌字符串；
- 封闭状态和结果集合使用 Enum；
- 边界对象使用冻结且可序列化的明确类型；
- 跨模块错误使用类型化错误和稳定 reason/action，不传递任意异常文本；
- `dict[str, object]` 只允许存在于外部解析边界内部，进入业务模块前必须解析为明确合同；
- 公开合同不得包含 ORM model、SQLAlchemy Row、Path 绝对路径、HTTP response 或 vendor JSON。

## 5. 核心值类型与服务合同

### 5.1 共享值类型

`kernel` 定义：

```text
WorkId
WorkVersionId
CollectionId
CollectionRunId
BatchRunId
AssetId
LightDocumentId
AnalysisArtifactId
MetadataSnapshotId
Sha256
RelativeArtifactPath
UtcTimestamp
```

所有值在构造时完成格式验证。DOI、PMID、PMCID、arXiv ID、ISBN 等外部标识属于 `bibliography` 的中性标识类型，不能代替内部 ID。

### 5.2 文献收集合同

主要类型：

```text
CollectionDefinition
TopicCollectionRequest
CitationCollectionRequest
CollectionRunResult
DiscoveryObservation
DiscoveryCause
CitationObservation
CollectionMembership
```

主要端口：

```text
MetadataDiscoveryPort.search(request) -> ProviderDiscoveryResult
CitationDiscoveryPort.expand(request) -> ProviderCitationResult
BibliographyIngestionPort.prepare_discovery(observation) -> PreparedBibliographyAcceptance
CollectionAcceptancePublisher.publish_discovery(prepared_bibliography, membership, causes, paths) -> IngestOutcome
CollectionRepository.save_definition/run(...)
```

`bibliography` 先形成带预期 identity revision 的 `PreparedBibliographyAcceptance`，`collection` 再形成归属、原因和路径；`CollectionAcceptancePublisher` 在同一事务中复检身份前置条件并发布两位所有者已经确认的事实。这样不能出现“文献已接纳但发现原因尚未保存”的可见中间状态。

`IngestOutcome` 返回统一 `WorkId` 和 `WorkVersionId`。引用迭代只能依据该结果继续，不能在 `collection` 中复制身份判断。CollectionRun 一次只选择主题或引用迭代中的一种模式；重复路径可以保留，成员关系不得重复创建。

### 5.3 文献信息管理合同

主要类型：

```text
BibliographicObservation
InitialMetadata
UnifiedMetadata
IdentityEvidence
IdentityResolution
VersionRelation
ReferenceFact
ReferenceProposal
TagProposal
VersionFacts
WorkVersionState
CompletionSubmission
```

主要命令：

```text
prepare_initial_ingest(command) -> PreparedBibliographyAcceptance
confirm_identity(command) -> IdentityOutcome
delete_work_version(command) -> DeleteOutcome
delete_work(command) -> DeleteOutcome
get_version_facts(work_version_id) -> VersionFacts
accept_completion(command) -> CompletionOutcome
```

`CompletionSubmission` 必须完整包含：

- 目标 WorkVersion；
- 当前轻结构化文档的 ID 与 hash；
- 一份已不可变发布、完整包含九类信息的结构化分析产物引用与 hash；
- 完整最终元数据；
- 完整规范化引用集合，即使为空也必须有集合标记；
- 完整生成标签集合，即使为空也必须有集合标记；
- parser、模型、输入和参数 provenance；
- 预期当前元数据 snapshot 或 revision。

`bibliography.accept_completion` 是进入 `COMPLETED` 的唯一业务入口。它验证提案完整性和输入对齐关系后，只调用一个持久化端口：

```text
CompletionPublisher.publish_completion(validated_submission, target_projection)
```

该端口负责一次性写入完整分析产物引用、最终元数据、权威引用、权威标签和完成 bundle。其它服务不得分别更新这些事实。

### 5.4 文献内容处理合同

主要类型：

```text
ContentTarget
AssetCandidate
AcceptedPrimaryPdf
SupplementaryAsset
LightDocumentManifest
SourceLocator
ParserProvenance
AnalysisProposalV1
ContentStepOutcome
FailureEvidence
```

`ContentTarget` 由 `batching` 根据 `bibliography.VersionFacts` 形成，包含稳定版本 ID、当前统一元数据、当前已验收内容引用和预期 hash。`content` 不自行查询或改变 WorkVersion 身份。

主要端口：

```text
AssetResolverPort.resolve(target) -> tuple[AssetCandidate, ...]
AssetFetcherPort.fetch(candidate) -> BoundedByteStream
ParserPort.parse(primary_pdf) -> ParserResult
AnalysisModelPort.analyze(light_document) -> AnalysisProposalV1
ArtifactStorePort.publish(staged_artifact) -> PublishedArtifact
ContentAcceptancePublisher.publish_primary_pdf(validated_pdf, target_progress)
ContentAcceptancePublisher.publish_light_document(validated_document, target_progress)
```

`AnalysisProposalV1` 固定包含系统设计规定的九类信息。所有顶级字段必须存在；文献没有表达的内容使用类型化空值，不能通过缺少字段形成部分结果。语言模型返回后，`content` 在边界完成 schema、证据、长度和完整性验证，再把提案交给 `batching`；`batching` 映射为 `CompletionSubmission` 并调用 `bibliography.accept_completion`。

网络调用、parser polling 和 LLM 请求均发生在事务外。未完成整体发布的 LLM 输出只属于本次 attempt，不能成为有效分析事实或业务状态。

### 5.5 文献库使用与互操作合同

主要类型：

```text
LibraryQuery
WorkView
WorkVersionDetail
ImportedBibliographicRecord
ImportRecordOutcome
ExportSelection
ExportRecordOutcome
CurationDecision
```

导入提交端口为：

```text
ImportAcceptancePublisher.publish_record(prepared_bibliography, record_result) -> ImportRecordOutcome
```

它在同一事务中发布 `bibliography` 已确认的初始 metadata/reference/tag 事实与 `batching` 的逐记录结果，不能先写文献事实再单独补记导入结果。

每个书目 codec 实现：

```text
BibliographyCodec.read(stream) -> Iterator[RecordParseResult]
BibliographyCodec.write(records, stream) -> ExportEncodingResult
```

核心 codec registry 只包含：

- BibTeX/BibLaTeX；
- RIS；
- CSL JSON；
- EndNote XML。

导入 codec 把外部记录转换为 `ImportedBibliographicRecord` 后立即丢弃格式私有对象。该中性记录必须保留目标格式中所有可转换的通用元数据、关键词、标签和参考文献信息，但不能携带外部工具内部 ID、路径、同步状态或私有字段。

导出读取当前统一书目投影：当前统一元数据，以及目标格式能够表达的当前关键词、通用标签和参考文献信息。导出资格只要求存在可转换的当前统一元数据，不检查 PDF、轻结构化文本、分析结果或 `COMPLETED` 状态。

### 5.6 批量执行合同

状态推进与记录交换使用不同类型：

```text
StateAdvancementBatchSpec
StateAdvancementTargetResult
RecordExchangeBatchSpec
ImportRecordResult
ExportRecordResult
BatchSummary
CurrentFailureProjection
```

状态推进结果固定为：

```text
COMPLETED
PARTIALLY_ADVANCED
MISSING
FAILED
NOT_STARTED
SKIPPED
```

记录交换结果保持业务专用语义：

```text
import: CREATED | ENRICHED | DUPLICATE | REJECTED
export: EXPORTED | SKIPPED | FAILED
```

不得把记录交换结果转换为 WorkVersion 状态推进结果。一个显式单目标操作也使用一项目标的批量执行封套，使结果、失败和中断语义保持一致。

## 6. 四级状态的唯一推导

### 6.1 状态集合

代码中的唯一状态类型是：

```text
UNREVIEWED
ASSET_READY
LIGHT_TEXT_READY
COMPLETED
```

不持久化可独立修改的 WorkVersion `status` 列。`bibliography` 对事务一致的 `VersionFacts` snapshot 使用一个纯函数推导状态：

```text
COMPLETED
  if 存在当前 completion bundle，且它同时对齐：
     当前轻结构化文档、完整包含九类信息的分析产物、最终元数据 snapshot、
     权威引用集合标记和权威标签集合标记

LIGHT_TEXT_READY
  else if 存在通过完整性验收且对齐当前主 PDF 的轻结构化文档

ASSET_READY
  else if 存在已验收主 PDF

UNREVIEWED
  otherwise
```

SQLite 可以提供等价 view 供筛选使用，但 SQL truth table 必须与领域纯函数共用测试样例。以下内容永远不参与状态推导：

- batch run 或逐目标结果；
- 当前失败与历史诊断；
- processing attempt；
- MinerU task ID；
- FTS 索引；
- 没有 catalog 权威关系的文件系统对象；
- 尚未整体提交的 LLM 输出。

完成版本接收新的 provider observation 时只追加不可变来源事实，不重新形成统一初始元数据，也不替换最终 current metadata、reference set 或 tag set。重复导入对完成版本同样不能改变这些最终指针。只有删除错误版本并重新进入完整流程，才能产生新的有效完成结果。

### 6.2 缺失步骤推导

缺失步骤同样从 `VersionFacts` 得到：

| 当前状态 | 默认下一步骤 |
|---|---|
| `UNREVIEWED` | 获取并验收主 PDF |
| `ASSET_READY` | 解析并验收完整轻结构化文档 |
| `LIGHT_TEXT_READY` | 完成结构化分析和最终信息整体反馈 |
| `COMPLETED` | 无 |

指定较早批量目标时，在达到目标状态后停止；不得增加另一套 stop 状态。

## 7. 逻辑持久化模型

表名属于目标 schema 合同；实现可以拆分只读 view 或 repository 文件，但不能改变所有权与约束。

### 7.1 收集事实

```text
collections
collection_runs
collection_memberships
collection_causes
collection_paths
```

约束：

- 一个 CollectionRun 只有一种收集模式；
- `UNIQUE(collection_id, work_id)` 防止同一收集重复成员；
- 不同发现原因或引用路径可以指向同一成员；
- 每个 membership、cause 和 path 都能回到创建它的 CollectionRun；
- 层数、新增数和停止原因属于 CollectionRun，而非 WorkVersion 状态。

### 7.2 文献信息事实

```text
works
work_versions
work_version_relations
stable_identifiers
metadata_observations
metadata_snapshots
work_version_current_metadata
work_representative_versions
reference_sets
reference_members
unresolved_references
tag_sets
tag_members
```

约束：

- 一个 WorkVersion 只属于一个 Work；
- 代表版本必须属于同一 Work；
- 当前 metadata snapshot 必须属于同一 WorkVersion；
- provider observation 不可变，以 provider record identity 与规范化 payload hash 去重；
- 规范化稳定标识符遵守文献信息管理的保守身份规则；
- 导入元数据可以形成初始 snapshot，但不要求创建长期 import observation；
- 导入记录中的全部可转换通用引用、关键词和标签必须形成或补充当前 reference/tag set，并在完成事务中被最终完整集合整体替换；
- WorkVersion 已完成时，新增 provider observation 只追加来源证据，导入记录不替换最终 current metadata、reference set 或 tag set；
- reference set 和 tag set 即使为空也有父记录，用于证明完整集合已经提交。

### 7.3 内容事实

```text
artifacts
raw_assets
work_version_assets
accepted_primary_assets
light_documents
work_version_current_light_document
analysis_artifacts
completion_bundles
```

约束：

- 每个 WorkVersion 最多一个已验收主 PDF；
- 主 PDF 关系记录 role、hash、来源和相对路径；
- 轻结构化文档必须引用同一 WorkVersion 的当前主 PDF；
- 每个 WorkVersion 最多一个当前轻结构化文档；
- 轻结构化文档只有在完整性验收和不可变发布后才能成为 current；
- analysis artifact 必须包含九类 schema、输入轻结构化文档 hash 和完整 provenance；
- `completion_bundles` 同时引用分析产物、最终 metadata snapshot、reference set、tag set 和输入轻结构化文档；
- 每个 WorkVersion 最多一个有效当前 completion bundle。

`completion_bundle` 是已完成状态的完整性证明。不得通过多个互不关联的 nullable row 猜测某篇文献是否完成。

删除 WorkVersion 时，SQLite 事务移除该版本的权威关系、当前指针和完成证明，并按既定版本顺序重新选择代表版本，Work 级收集归属继续保留。若目标是 Work 的最后一个版本，`delete_work_version` 必须拒绝并要求用户显式调用 `delete_work`；只有后者才删除整个 Work、其全部版本及其收集归属。两种删除都把其它文献指向被删除目标的入向引用降级为保留原始引用证据的未解析引用，不沿引用关系删除其它文献。

删除事务不直接删除不可变文件。事务提交后，文件对账只能回收没有任何 catalog 引用的内容寻址对象；相同字节仍被其它版本、资产或产物引用时必须保留。

### 7.4 批次与失败投影

```text
batch_runs
batch_targets
batch_counts
current_failures
parser_attempts
```

约束：

- `UNIQUE(batch_run_id, target_kind, target_id)`；
- 状态推进批次只保存实际缺失目标，已满足记录不创建 target row；
- 同一范围内重复 WorkVersion 收敛为一个 target；
- 每个状态推进 target 保存开始状态、目标状态、是否已启动和最后一次随业务事实提交的状态投影；
- 成功步骤只清除同一步骤的当前失败；
- current failure 不参与 WorkVersion 状态；
- 记录交换 target 可以保存输入 ordinal、业务结果、稳定 reason 和解析后的 WorkVersion ID，但不保存原始导入记录或导入文件 provenance；
- parser attempt 可以保存 MinerU task ID，但它不成为批次或文献状态。

### 7.5 派生读取模型

```text
work_views
work_version_details
missing_step_view
work_status_summary
citation_graph_view
metadata_fts
light_text_fts
analysis_fts
```

读取模型和 SQLite FTS5 索引可以重建，不拥有权威事实。FTS 更新必须与被索引的 catalog 事实处于同一事务，或者写入确定性待对账标记；索引存在与否不能影响状态或导出资格。

## 8. SQLite 与事务规则

### 8.1 连接策略

所有连接统一启用：

- `PRAGMA foreign_keys = ON`；
- WAL journal mode；
- 权威写入使用 `synchronous = FULL`；
- 有界 `busy_timeout`；
- UTC 时间；
- 确定性 JSON 序列化；
- 查询和导出的读取 snapshot 使用 read-only/query-only 连接，批次记录由独立短写连接提交；
- 一个事务只覆盖一次明确业务提交，不覆盖网络、解析、LLM 或整批运行。

### 8.2 必须整体提交的事务

1. 接纳 discovery observation、身份结果、统一初始元数据和受影响收集关系；
2. 接纳导入形成的初始 metadata/reference/tag 事实及其逐记录结果；
3. 接纳主 PDF 关系，并同步清除资产步骤当前失败、更新目标进度；
4. 接纳轻结构化文档及其主 PDF 对齐关系，并同步清除解析步骤当前失败、更新目标进度；
5. 发布 completion bundle、最终元数据、权威引用、权威标签及派生索引，并同步清除分析与最终反馈失败、结束目标结果；
6. 身份合并或版本归组涉及的来源、收集归属和引用关系转移；
7. 删除 WorkVersion 或整个 Work，处理代表版本、收集归属和入向引用降级；
8. 保存一个逐目标结果或当前失败投影；
9. 完成一个批次摘要。

主 PDF、轻结构化文档和完成事务都携带预期 current ID/hash。输入已经改变时必须拒绝 stale 提交，不能把旧处理结果关联到新的当前文档。

### 8.3 跨模块事务

业务模块不共享 SQLAlchemy Session。需要同时写入多个业务所有者事实时，各所有者先形成冻结的 validated payload，再由一个明确 publisher 调用 `literature_store` 的单一事务端口。publisher 只能组合已经确认的事实和带 revision/hash 的前置条件，不能自行作出身份、内容或批次业务判断。

四个跨所有者 publisher 固定为：

```text
CollectionAcceptancePublisher
  -> 原子发布 bibliography 接纳结果与 collection 归属/原因/路径

ImportAcceptancePublisher
  -> 原子发布 bibliography 初始事实与 batching 逐记录导入结果

ContentAcceptancePublisher
  -> 原子发布主 PDF 或轻结构化文档、对应 target progress 和同一步骤 failure clear

CompletionPublisher
  -> 原子发布完整完成事实、最终 target result 和分析/反馈 failure clear
```

当前失败清除和 target progress 都是 `batching` 预先形成的类型化投影；内容或书目信息模块不能任意删除其它步骤失败。单目标调用仍使用一项目标批次，因此沿用同一复合提交合同。

完成态的调用链固定为：

```text
content 产生并验证 AnalysisProposalV1
  -> batching 形成 CompletionSubmission
  -> bibliography.accept_completion 验收完整提案
  -> CompletionPublisher.publish_completion(validated_submission, target_projection)
  -> literature_store 在一个 SQLite 事务中整体提交
```

物理事务可以写入 analysis artifact relation 和 bibliography projection，但业务决定仍分别属于 `content` 与 `bibliography`。

## 9. 文件发布与完成态原子性

SQLite 与普通文件系统没有跨介质事务。目标实现采用“先发布不可变文件，后建立 catalog 引用”，确保失败只能留下不可见孤儿：

1. 在配置存储根的 owner-only 临时目录写入产物；
2. flush、`fsync` 文件并验证大小、格式和 SHA-256；
3. 使用 create-if-absent 发布到内容寻址相对路径；
4. 目标已存在时验证字节完全一致，禁止覆盖冲突证据；
5. `fsync` 目标目录；
6. 所有必需产物都发布完成后，开启短 SQLite 写事务；
7. 重新读取预期 WorkVersion、metadata、主 PDF 和轻结构化文档 ID/hash；
8. 写入完整 analysis artifact relation、最终 metadata snapshot、reference set、tag set 和 provenance；
9. 更新 current metadata 指针并建立 completion bundle；
10. 更新派生读取模型和 FTS 后提交。

WAL reader 只能观察到：

- 提交前仍为 `LIGHT_TEXT_READY` 的完整旧视图；或
- 同时具有九类分析结果、最终元数据、引用、标签和 `COMPLETED` 的完整新视图。

任何中间组合都不得对外可见。SQLite commit 前崩溃可能留下无引用不可变文件；reconciliation 可以删除或按 hash 复用它们。SQLite commit 后崩溃是安全的，因为所有被引用文件都已经持久发布并完成目录同步。

不可变对象 reconciliation 与垃圾回收必须获得同一个核心写锁，并在整个扫描、引用复检和删除期间持有它，因此不能与 publication-before-reference 窗口并发。它只处理正式内容寻址对象，不接触活动 staging；删除前必须在新的 read transaction 中再次证明对象没有任何 catalog 引用。

主 PDF 和轻结构化文档使用相同 publication-before-reference 协议。

## 10. 批量运行模型

### 10.1 核心写入准入

一个主机、一个 canonical catalog path 对应一个核心写批次 advisory lock：

```text
<catalog>.core-write.lock
```

以下操作在形成实际目标前必须以非阻塞方式获得同一个独占锁：

- 主题收集；
- 引用迭代收集；
- 书目信息导入；
- 身份整理和删除；
- 内容状态推进；
- 不可变对象 reconciliation 与垃圾回收。

锁由平台适配的 OS advisory lock 实现，进程退出或崩溃时由操作系统释放。锁在整个批次期间持有，但不得在整个批次期间持有 SQLite 事务。冲突立即返回稳定的“已有核心写批次运行”结果，不排队等待。

不使用 lease、heartbeat、fencing token、后台 owner 或跨机器协调。

### 10.2 状态推进批次

```text
获得核心写锁
  -> 创建 BatchRun
  -> 从统一事实筛选并去重实际缺失目标
  -> 有界执行外部操作
  -> 通过单一进程内 commit queue 提交短写事务
  -> 每个目标立即保留成功阶段或失败结果
  -> 汇总并结束 BatchRun
  -> 释放核心写锁
```

从已有数据库范围启动时，实际目标在批次开始时形成稳定 snapshot。主题收集、引用收集或导入产生新版本时，只把本次新形成且低于目标状态的 WorkVersion 追加为实际目标，不能扩展为扫描整个数据库。

批次内部可以并行执行不同文献的网络、解析或模型调用，但所有 SQLite commit 通过一个进程内提交队列串行完成。并发上限、host 预算和启动间隔来自 typed config。

中断时停止启动新目标，安全结束或取消有限 in-flight 操作，已提交事实继续有效，尚未启动的实际目标标记 `NOT_STARTED`，批次结束为 `INTERRUPTED`。

### 10.3 崩溃恢复

进程硬崩溃后 OS 自动释放写锁。下一次核心写批次获得锁后：

1. 把同一 catalog 上遗留的 `RUNNING` 核心批次结束为 `INTERRUPTED`；
2. 对没有最终结果的实际目标比较开始状态、目标状态、started 标记与当前权威事实：已经达到目标记为 `COMPLETED`，已高于开始状态但未达到目标记为 `PARTIALLY_ADVANCED`，从未启动且事实未变化记为 `NOT_STARTED`，已经启动但没有事实推进记为带稳定 interruption reason 的 `FAILED`；
3. 目标保存的最后进度只用于解释，恢复结论必须重新从当前权威事实推导；
4. 从当前权威事实重新筛选新批次目标；
5. 不恢复旧队列、处理位置、线程、HTTP 请求、parser 调用或 LLM 调用。

MinerU external task ID 是唯一允许的外部 attempt 恢复句柄，只能用于恢复有限 polling，不得形成通用任务中心。

### 10.4 记录交换批次所有权

每个记录交换 BatchRun 使用由 catalog path 与 BatchRun ID 确定的 OS advisory owner lock：

```text
<catalog>.batch-<batch-run-id>.lock
```

进程先获得 owner lock，再把 BatchRun 写为 `RUNNING`，并持有到终态提交完成。任何恢复者只有在非阻塞获得该 owner lock 后，才能认定原 owner 已退出并把遗留批次结束为 `INTERRUPTED`；不得仅依据时间戳把仍在运行的批次判死。导入还必须持有核心写锁。导出不持有核心写锁，但另对规范化目标输出路径持有 advisory lock，防止两个导出同时发布到同一文件。

### 10.5 当前失败

业务模块返回类型化 `FailureEvidence`，包含 step、reason、action、retryable 和脱敏详情。`batching` 在目标失败事务中：

- 保存本次目标结果；
- 更新同一 WorkVersion、同一步骤的 current failure；
- 不改变 WorkVersion 状态；
- 不覆盖其它步骤失败。

某一步后续成功时，通过对应跨所有者 publisher 在成功事实事务中清除该步骤 current failure 并更新 target progress。完整尝试历史不是核心要求；parser 外部 attempt 等经批准恢复信息单独保存。

## 11. 查询、导入与导出

### 11.1 查询

查询使用 read-only snapshot 和 `literature_store` 提供的统一 read model。普通查询不回放业务算法，也不根据 batch 或 failure 推导状态。

关键词检索通过 SQLite FTS5 覆盖：

- 当前统一元数据；
- 当前完整轻结构化文本；
- 当前九类结构化分析结果。

结构化筛选、状态筛选和引用遍历使用关系 view；向量检索与推荐留在 extension。

### 11.2 导入

导入是核心写批次，必须获得核心写锁。每条记录按以下边界处理：

```text
codec 解析与格式验证
  -> ImportedBibliographicRecord
  -> bibliography 精确身份处理并形成 PreparedBibliographyAcceptance
  -> batching 形成逐记录结果
  -> ImportAcceptancePublisher 原子发布初始元数据、引用、关键词、标签和记录结果
```

每条成功记录单独提交，目标格式中所有可转换的通用字段都必须接纳；单个字段无法转换时按 codec 合同形成明确省略或整条拒绝，不能静默丢弃。完成版本只允许匹配身份，不用导入值替换最终 current metadata、reference set 或 tag set。导入文件、原始格式对象、外部工具内部 ID、格式私有字段和导入 provenance 不进入长期数据库。成功形成的 WorkVersion 可以成为后续状态推进批次范围。

### 11.3 导出

导出不获得核心写锁，也不要求 WorkVersion 为 `COMPLETED`：

1. 获得 BatchRun owner lock 和规范化目标输出路径 lock，再用短事务创建 `RUNNING` record-exchange BatchRun；
2. 在 WAL 模式打开一致的 read-only snapshot；
3. 形成具有可转换当前统一元数据的稳定导出选择；默认每个 Work 按正式发表版、作者接受稿、预印本、其它版本的顺序选择一个最佳版本，只有显式请求才选择全部可导出版本；
4. 把结果流式写入与目标输出同目录的 owner-only staging file；
5. flush、`fsync` staging file，计算输出 hash，并在短事务中保存逐条结果、预期 hash 和 `PREPARED` 发布标记；
6. 关闭读取 snapshot，原子替换目标输出并 `fsync` 父目录；
7. 用短事务把发布标记和最终摘要提交为完成，然后释放两个 advisory lock。

默认版本选择只影响本次导出，不修改代表版本或其它核心事实。格式无法表达的字段、信息不足导致的跳过和单条编码失败都进入稳定的逐条结果与摘要，不能静默改变字段含义，也不能撤销其它成功记录。

导出 snapshot 在核心写批次继续提交其它文献时保持一致。导出摘要只写 operational batch 表，不修改核心文献事实；SQLite 对短物理写事务进行串行化，有界 busy handling 处理瞬时竞争。

原子替换前崩溃时旧输出保持不变，staging file 可清理。替换后、最终摘要提交前崩溃时，新输出可能已经完整可见；恢复者获得 BatchRun owner lock 后把批次结束为 `INTERRUPTED`，并依据已持久化的 `PREPARED` hash 给出“发布结果未知”的稳定停止原因，不能谎称旧输出仍在，也不能在没有原目标路径 provenance 的情况下猜测发布成功。无论在哪一点崩溃，用户都不会观察到部分输出文件。

## 12. 外部适配器与安全边界

### 12.1 元数据与引用

- 一个供应商只有一个共享 client，能力 adapter 只完成请求映射和中性 DTO 转换；
- vendor response 不进入 `collection`、`bibliography` 或 `literature_store`；
- 多供应商调用各自具有 timeout、预算和失败结果；
- 单一供应商失败不撤销其它成功 observation；
- adapter 不执行 Work/WorkVersion 身份合并。

### 12.2 资产获取

- acquisition adapter 只返回候选定位与受控请求描述，不直接接受资产；
- 共享 secure transport 负责 HTTPS、DNS 解析与 pinning、redirect 复检、敏感 header 移除、timeout、有界读取和响应大小；
- browser 是显式启用的独立 adapter，使用隔离的 operator-prepared profile，并输出同一候选合同；
- 下载后统一验收 role、MIME、magic、EOF、可解析性、完整性和 WorkVersion 身份；
- 同一 tier 可有界竞速，loser 必须取消并禁止 late acceptance；
- 只有验收合格的 winner 可以进入不可变发布。

### 12.3 解析器

- 一次文档处理只选择一个配置 parser，不自动竞赛、合并或失败回退；
- MinerU 是 operator-managed 能力，SciRetriever 不启动、停止、升级、扩缩容或拥有其模型和任务保留策略；
- endpoint、返回 URL、redirect、归档、路径、symlink、JSON、页码、坐标、文本和图片均视为不可信输入；
- adapter 在资源、协议、schema、页面和内容边界验证后才生成中性轻结构化文档；
- 发布 provenance 至少包含输入资产 hash、parser/service identity、模型或 backend identity 和必要参数。

### 12.4 语言模型

- LLM adapter 只接受已验收完整轻结构化文档；
- 输入具有字符数、source unit 和证据数量上限；
- 输出必须解析为 `AnalysisProposalV1`，九类字段齐全且 evidence 引用有效；
- 任意缺字段、截断、越界、未知结构或输入不对齐都使本次 attempt 失败；
- 无效输出不得持久为当前分析，也不得修改最终元数据、引用或标签。

### 12.5 凭据与诊断

- secret 值不得进入 config DTO、SQLite、provenance、diagnostics、URL 或用户输出；
- 所有外部错误在持久化或显示前转换为稳定、脱敏的 reason/action；
- durable write 前和用户输出前各执行一次 redaction boundary；
- provider loser failure 可以保留诊断，但不能影响已验收 winner 或 WorkVersion 状态。

## 13. 配置边界

`runtime.config` 是唯一 TOML 解析入口。未知 section、key、枚举或组合必须 fail closed。解析先产生冻结 typed config，再构造任何 repository 或 adapter。

配置按责任分组：

```text
paths
collection
metadata
content.acquisition
content.parser
content.analysis
batching
interoperability
credentials
extensions
```

规则：

- CLI 显式覆盖只作用于当前 invocation，并通过同一 typed parser 复验；
- provider、模型、timeout、并发、host 预算、文件大小、归档大小、目标数量和存储根均有显式上限；
- secret 只以环境变量名或明确 secret reference 出现在配置中；
- 只有 `runtime.secrets` 读取环境，只有 composition root 把短生命周期 secret 注入 adapter；
- catalog 与 storage root 必须显式、规范化、位于仓库外，并检查 symlink、包含关系和权限；
- catalog 只保存 artifact 相对路径；
- loopback parser mode 只允许显式 loopback origin；remote mode 必须使用 HTTPS、独立认证引用和明确文档上传许可；
- 拒绝 URL userinfo、fragment、未受控 query、跨 origin redirect 和响应提供的任意 absolute URL；
- `config check` 默认离线验证；只有显式 runtime 模式可以执行有界只读 capability probe。

## 14. Extension 边界

`extensions` 可以读取稳定 ID、hash、provenance、当前元数据、轻结构化文本和结构化分析结果，发布独立命名空间结果。它不能：

- 修改 Work/WorkVersion 身份；
- 修改当前元数据、主 PDF、轻结构化文档、分析、引用、标签或四级状态；
- 成为核心查询、导出或已完成状态的前置条件；
- 让核心模块理解 extension schema。

当前 `DocumentPackage` 或其它完整数据快照只能作为 extension 导出合同存在。它不是 WorkVersion、处理历史或唯一允许的下游集成形式。

## 15. 明确不采用的机制

- 旧 `METADATA_PENDING / ASSET_PENDING / ANALYSIS_PENDING / COMPLETE` 四阶段合同；
- “已有结构化分析结果”中间业务状态；
- acquisition 与 analysis 两套可并行写 admission；
- 可独立修改的 WorkVersion status column；
- batch、failure、attempt 或外部 task 决定文献可用程度；
- SQLite 长事务包裹网络、parser、LLM 或整批处理；
- 分布式 queue、worker、lease、heartbeat、fencing token 或 network exactly-once；
- 自动 parser 竞赛、合并和失败回退；
- 导入 provenance 或外部工具对象长期保存；
- 以 `COMPLETED` 作为书目信息导出资格；
- 领域 schema 写入核心文献数据库；
- 下游直接依赖内部数据库表。

## 16. 架构验收

### 16.1 静态依赖检查

AST 架构门禁必须拒绝：

- 未声明的 package dependency；
- 跨模块 private import；
- `literature_store` 以外的 SQLAlchemy 和 SQLite table 使用；
- `runtime` 以外读取环境变量或 TOML；
- vendor SDK 类型出现在公开合同；
- 业务模块直接创建或覆盖 artifact 文件；
- `batching` 直接写核心文献表；
- 核心模块依赖 `extensions` 或 `runtime`。

### 16.2 状态与 schema 检查

1. 穷举四级状态 truth table，并证明 Python 推导与 SQL view 一致。
2. schema 拒绝同一 WorkVersion 多个主 PDF、跨版本轻结构化文档、缺少任何组成项的 completion bundle 和重复实际目标。
3. batch、failure、attempt、FTS 或孤立文件变化不得改变状态。
4. 已满足目标的版本不得生成状态推进 target row。
5. 元数据收集完成但仍为 `UNREVIEWED` 的版本必须可以导出。
6. 已完成版本接收新 provider observation 或重复导入时，最终 metadata、reference set、tag set 和 `COMPLETED` 保持不变。

### 16.3 事务与崩溃检查

1. 在完成事务每个写入点和 commit 前注入失败；第二连接只能观察完整 `LIGHT_TEXT_READY` 或完整 `COMPLETED`。
2. 在文件 staging、发布、SQLite commit 前后分别崩溃；reconciliation 只清理无引用文件，所有已提交引用都保持可读和 hash 一致。
3. 主 PDF 与轻结构化文档执行同类 failpoint matrix。
4. 在 publication-before-reference 窗口尝试 reconciliation；核心写锁必须阻止它删除待提交对象。
5. 发现接纳、导入接纳、身份合并、两级删除和最终反馈不得暴露部分关系转移；导入事实与逐记录结果必须同时可见，删除后的入向引用保留为未解析证据，共享文件仍被引用时不得回收。

### 16.4 批量与并发检查

1. 两个进程同时启动核心写批次时，只允许一个获得 admission，另一个立即得到稳定冲突结果。
2. 核心写批次运行时，查询和导出可以读取一致 snapshot。
3. 一篇缺失、一篇失败、一篇完成时，全部已提交事实和逐目标结果都保留。
4. 杀死 writer 后 OS 释放锁；下次执行结束旧批次并从事实重新筛选，不恢复旧队列。
5. 重跑只选择仍缺失目标，不产生“已有”逐项目标结果。
6. 导入与导出使用记录交换结果，不产生 WorkVersion 状态结果。
7. 在每个阶段事实提交后、目标最终结果提交前杀死 writer；恢复结果必须按开始状态、started 标记和当前事实区分完成、部分推进、失败与未开始。
8. 导出在替换前、替换后和摘要提交前分别崩溃；输出始终是完整旧文件或完整新文件，owner lock 防止误判活动批次，恢复说明与 `PREPARED` hash 一致。

### 16.5 Adapter 与安全检查

- provider 部分失败保留其它成功 observation；
- malformed URL、redirect、archive、vendor JSON、parser output 和 LLM output 在 durable acceptance 前失败；
- oversize、timeout、race loser 和 late response 不能成为有效资产或分析；
- 凭据不出现在日志、诊断、SQLite、文件名、provenance 或 CLI 输出；
- RawAsset 和派生产物只能通过不可变发布 owner 创建。

### 16.6 离线产品验收

离线集成测试必须覆盖：

- 主题领域收集；
- 引用关系迭代收集；
- 多供应商部分失败；
- 精确身份收敛和版本分离；
- 书目信息导入；
- 元数据完成后的书目导出；
- 主 PDF 验收；
- 完整轻结构化文档发布；
- 九类结构化分析和最终信息整体提交；
- 查询和引用遍历；
- 局部失败、中断和重复执行。

测试、构建和架构门禁不得连接真实供应商、生产数据库或用户语料。

## 17. 需求追踪

| 产品需求 | 主要代码所有者 | 关键技术机制 |
|---|---|---|
| R1 发起文献收集 | `collection`、`batching` | Collection/Run/Membership、主题与引用端口、单写批次 |
| R2 多来源元数据搜索 | `collection`、`bibliography`、`adapters` | 中性 observation、保守身份、统一 metadata snapshot |
| R3 文献资产获取 | `content`、`literature_store` | 候选 adapter、安全传输、三项验收、不可变发布 |
| R4 文献解析 | `content`、parser adapter | 单 parser、完整性验收、source locator、轻结构化文档 |
| R5 语言模型结构化分析 | `content`、`bibliography` | AnalysisProposalV1、CompletionSubmission、整体完成事务 |
| R6 文献数据库 | `bibliography`、`literature_store`、`interoperability` | SQLite + 文件系统、四级状态、统一 read model、FTS |
| R7 书目信息导入与导出 | `interoperability`、`bibliography`、`batching` | 四类 codec、初始 metadata、metadata-only export、记录交换批次 |
| R8 大批量处理 | `batching` | 实际目标、单核心写 admission、逐目标提交、中断重执行、结果摘要 |

## 18. 文档责任

- [产品需求](requirements.md)决定用户问题、核心能力、产品结果和验收场景。
- [系统设计](system-design.md)决定逻辑模块、事实所有权、四级状态和业务协作。
- 本文决定目标代码模块、依赖、接口、数据与运行技术。
- 项目 `README`、CLI `--help`、源码和测试说明当前已经实现的行为。
- 实施顺序、工作包和差距分析只进入 `.omo/plans/`，不进入架构文档。
