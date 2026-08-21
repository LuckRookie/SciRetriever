# Model 模块技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 设计责任：[设计文档 5.1](../design.md#51-model)
- 身份决策：[ADR 0002](../decisions/0002-literature-identity-and-incremental-processing.md)
- 稳定原则：[架构原则](../principles.md)
- Provider 配置：[ADR 0014](../decisions/0014-capability-scoped-providers-and-local-credentials.md)、[Configuration 技术文档](configuration.md)

本文定义目标 `src/sciretriever/model/` 的实现边界。Model 只提供模块间交换的中性 Pydantic 数据合同，不拥有业务判断、用例、I/O 或外部协议。

## 1. 目标结构

```text
model/
  primitives.py
  provenance.py
  literature.py
  metadata.py
  discovery.py
  acquisition.py
  parsing.py
  analysis.py
  library.py
  execution.py
  report.py
  access.py
  llm.py
  record.py
  configuration.py
```

文件可以按规模继续拆分，但仍属于一个统一 Model 模块，不建立平行 DTO、schema model、domain model 或 vendor model 体系。

## 2. 数据文件责任

| 文件 | 数据范围 |
|---|---|
| `primitives.py` | 内部 ID、SHA-256、UTC 时间、规范化相对路径和封闭枚举 |
| `provenance.py` | 各模块复用的来源类别、来源身份、观察时间、输入 hash 和参数 hash |
| `literature.py` | MetaLiterature、Literature、版本角色与成员归属、权威 Reference 和 ReferenceSupport |
| `metadata.py` | LiteratureMetadata、MetadataObservation、ProviderLiteratureKey、version_links、ProviderRelationObservation、供应商声明关键词和原始参考文献文本 |
| `discovery.py` | Topic/Citation DiscoveryRun、逐 Provider 终止结果、发现对象和直接原因 |
| `acquisition.py` | AssetHint、运行时 AcquisitionPath/PdfCandidate、Asset、LiteratureAsset、二值自动 AcquisitionResult、手动接纳成功结果和自动 PDF 获取耗尽事实 |
| `parsing.py` | ParserResult、Parser 请求、Markdown/资源 artifact 引用、当前结果 hash 和 parser provenance |
| `analysis.py` | 两阶段内容判断、最终元数据与 LiteratureContent 临时提案、有序 LiteratureSection/参考文献文本、临时 ReferenceLookup 和规范 Markdown artifact 描述 |
| `library.py` | 本地 LibraryQuery、搜索请求/页面、单篇 LiteratureDetail、引用关系请求/页面/详情、资产组合 read view、整理决定和导出选择；查询结果不持久化 |
| `execution.py` | 运行时 BatchRequest/BatchSelector/BatchGoal；目标和候选只服务当前进程，不定义持久化 BatchRun |
| `report.py` | Entry 操作的非持久化 typed Report、最终停止方式、稳定脱敏失败和操作特有结果 |
| `access.py` | HTTP 与浏览器访问请求、中性结果和脱敏失败数据 |
| `llm.py` | LLM 请求、结构化响应和 provenance |
| `record.py` | BibTeX、RIS、CSL JSON 边界记录；只组合现有 LiteratureMetadata 与输入序号，不复制一套导入元数据字段 |
| `configuration.py` | 完成外部边界解析后的非 secret 运行配置、Provider capability/readiness 和安全配置诊断结果；不保存凭据值或文件原文 |

### 2.1 Provenance 公共合同

`Provenance` 是各模块通过组合复用的公共来源追踪数据，不是其它 Model 的父类。精确 schema 为：

```text
Provenance
  provenance_id: ProvenanceId
  source_kind: SourceKind
  source_name: str
  source_record_id: str | None
  observed_at: UtcTimestamp
  input_sha256: Sha256 | None
  parameters_sha256: Sha256 | None

SourceKind = "metadata-provider" | "asset-provider" | "parser" | "analysis" | "user"
```

| 字段 | 含义 |
|---|---|
| `provenance_id` | SciRetriever 分配的来源追踪身份，不是业务对象、供应商记录或批次 ID |
| `source_kind` | 元数据供应商、资产供应商、解析器、逻辑 Analysis 或用户等来源类别 |
| `source_name` | `crossref`、`openalex`、`mineru` 等稳定具体来源名称 |
| `source_record_id` | 来源系统中的记录 ID；该来源没有独立记录身份时为空 |
| `observed_at` | SciRetriever 实际获得或观察到这条来源信息的 UTC 时间，不是文献发表时间 |
| `input_sha256` | 产生该事实所依据输入的 SHA-256；无法定义稳定输入时为空 |
| `parameters_sha256` | 影响结果的规范化查询或处理参数 SHA-256；没有有意义参数时为空 |

Provider 形成的 `MetadataObservation` 使用 `source_kind = "metadata-provider"`，并要求非空 `source_name`、`source_record_id`、`observed_at` 和 `input_sha256`。书目导入形成的 `MetadataObservation` 使用 `source_kind = "user"`、`source_name = "bibliographic-import"`、`source_record_id = None`，`observed_at` 为接纳该记录的 UTC 时间，`input_sha256` 和 `parameters_sha256` 均为空；它只表达用户明确提供元数据，不保存原始文件或导入过程身份。其它 `source_kind` 不能用于 `MetadataObservation`。Provenance 不保存凭据、header、cookie、完整 URL query、原始响应、未脱敏异常或机器相关绝对路径。已经处于一个来源上下文中的 `LiteratureMetadata`、`version_links`、原始 `reference_texts` 和 `AssetHint` 复用父级 Provenance，不重复携带。元数据供应商每条结构化有向引用边形成独立 `ProviderRelationObservation` 并拥有关系来源 Provenance；同一响应的多条边可以复用同一 Provenance。相关文献自己的供应商记录 ID 只进入 `ProviderLiteratureKey.record_id` 或其 Provider `MetadataObservation.provenance.source_record_id`，不能成为本地身份。`ReferenceSupport` 只定位这些来源，不重复保存 Provenance。

### 2.2 Identifier、Author 与 Affiliation

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

| namespace | validator 接受并转换的表示 | canonical `value` |
|---|---|---|
| `doi` | 裸值、大小写变体、`doi:`、已知 `doi.org`/`dx.doi.org` resolver URL 和边界空白 | 小写裸 `10.xxxx/...`；不删除可能属于 DOI suffix 的标点 |
| `arxiv` | 官方新式或旧式 ID、`arXiv:`、官方 `/abs/` 或 `/pdf/` URL、可选 `.pdf` 及 `v1`/`v2` 等 revision | 不带 revision 的官方基础 ID，例如 `2501.01234` 或 `hep-th/9901001` |
| `pmid` | 边界空白内的官方 PMID | 纯数字 |
| `pmcid` | 边界空白内、前缀大小写可规范化的官方 PMCID | 大写 `PMC` 加数字 |
| 其它 namespace | 当前没有显式 canonicalizer 的值 | 只去除边界空白并保持其余字符；支持前必须依据官方规范增加独立转换与 fixture |

已知 namespace 的包装去除后仍必须满足对应官方基本格式；不能识别的 URL、前缀、空值或畸形值直接拒绝，不通过猜测修复。DOI 大小写不敏感，因此只有 `doi` 的 value 统一小写；不能把这项规则全局应用到 arXiv、PMCID、ISBN、ISSN 或未知 namespace。arXiv revision 只是来源表示，不形成新的业务字段。ISBN、ISSN 等其它标识符若需要语义规范化，必须分别依据官方合同增加显式 canonicalizer，而不是由 Provider adapter 私自采用不同规则。

Model 只决定一个值的 canonical 表达，不判断该字段究竟标识当前 Literature、相关版本还是 Provider 记录，也不决定两个 Literature 是否合并。Metadata adapter 负责语义归类；Literature 负责身份命中、冲突和版本聚合。供应商内部记录 ID 进入 `Provenance.source_record_id` 或 `ProviderLiteratureKey.record_id`，不伪装成文献 `Identifier`。该对象不增加 URL、provider、provenance、primary 或 confidence 字段。

`Author` 表示作者在一篇具体 `Literature` 中的一次结构化署名，不是全局作者实体。`display_name` 是必填的署名展示值，只允许忠实清理断行与边界空白；`given_name` 和 `family_name` 只保存来源明确给出或能够无歧义对齐的姓名组成，不能从展示名机械猜测。`kind` 允许个人、机构或无法可靠分类的署名，因此能够保留中文姓名、协作组和机构作者。ORCID 只保存不带 URL 前缀的裸值，并校验格式与校验位；不得根据姓名查询或猜测。作者顺序由 `LiteratureMetadata.authors` 的不可变 tuple 表达。

`Affiliation` 表示该作者在这篇具体文献中的署名单位；`name` 非空，`ror` 只保存来源明确给出且不带 URL 前缀的裸值，不能根据单位名称猜测。单位顺序在作者内部保留。当前合同不增加全局 `author_id`、作者 position、email、通讯作者、共同贡献、CRediT role、confidence、供应商作者 ID 或逐作者 provenance；作者及单位的来源由所属 `MetadataObservation` 或最终内容的 Analysis provenance 表达。

### 2.3 DiscoveryRun 与运行时数据库补全

外部发现和数据库补全使用两组不同 Model，不能恢复旧的 `CollectionRun` 混合合同，也不预留当前没有产品需求的 Collection Model。

领域和引用发现的输入为：

```text
ProviderDiscoveryLimit
  provider_name: str
  scan_limit: int

TopicDiscoveryInput
  kind: Literal["topic"]
  query: str
  year_from: int | None
  year_to: int | None
  providers: tuple[ProviderDiscoveryLimit, ...]

CitationDiscoveryInput
  kind: Literal["citation"]
  seed_literature_ids: tuple[LiteratureId, ...]
  direction: Literal["references", "cited-by", "both"]
  max_depth: int
  result_limit: int
  providers: tuple[ProviderDiscoveryLimit, ...]

DiscoveryInput = TopicDiscoveryInput | CitationDiscoveryInput
```

`query` 去除边界空白后非空；年份为 1–9999 且范围有序。Provider 列表非空，名称非空且在一次输入中唯一，`scan_limit >= 1`。Citation seeds 非空且去重，`max_depth >= 0`，`result_limit >= 1`。Topic 输入不增加语言、文献类型、排序、相关度阈值或 Provider 私有查询参数。

`scan_limit` 是每个 Provider 在整个 DiscoveryRun 中的原始 item 上限，过滤、最低身份准入和去重前计数；它不在每个种子、深度或请求上重置。`result_limit` 只用于引用发现，统计种子以外按 MetaLiterature 去重的 `DiscoveryResult`；无论对象是新入库还是已经存在都计数，同一对象重复到达只计一次。这些字段只表达已经由 Entry 边界规范化的中性输入，不包含 vendor query、cursor、request/response 或搜索分数。

运行及结果合同为：

```text
DiscoveryRun
  discovery_run_id: DiscoveryRunId
  input: DiscoveryInput
  status: DiscoveryRunStatus
  started_at: UtcTimestamp

DiscoveryRunStatus =
    "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED" | "INTERRUPTED"

DiscoverySourceResult
  discovery_run_id: DiscoveryRunId
  provider_name: str
  outcome: DiscoverySourceOutcome
  failure: StableFailure | None

DiscoverySourceOutcome =
    "EXHAUSTED" | "SCAN_LIMIT_REACHED" | "FAILED"

DiscoveryResult
  discovery_run_id: DiscoveryRunId
  meta_literature_id: MetaLiteratureId

DiscoveryCause = TopicDiscoveryCause | CitationDiscoveryCause

TopicDiscoveryCause
  kind: Literal["topic"]
  discovery_run_id: DiscoveryRunId
  meta_literature_id: MetaLiteratureId
  metadata_observation_id: ObservationId

CitationDiscoveryCause
  kind: Literal["citation"]
  discovery_run_id: DiscoveryRunId
  meta_literature_id: MetaLiteratureId
  source_literature_id: LiteratureId
  target_literature_id: LiteratureId
  depth: int
```

`DiscoverySourceResult.failure` 复用第 2.4 节定义的 `StableFailure`；该公共失败类型物理定义在 `model/report.py`，`model/discovery.py` 只引用它，不建立第二份失败合同。

`DiscoveryRun` 创建即为 `RUNNING`。所有 Provider 自然耗尽或达到扫描上限时为 `COMPLETED`，正常结束与失败并存时为 `PARTIAL`，全部失败时为 `FAILED`；用户提前停止或恢复时发现遗留运行才为 `INTERRUPTED`。零结果仍是正常完成。`DiscoverySourceResult` 自然唯一性为 `(discovery_run_id, provider_name)`；正常结束分别记录自然耗尽或扫描上限，分页中途失败即为 `FAILED`，此前已接纳结果保留。`failure` 只允许在 `FAILED` 时存在。未完成的 Provider 在 Run 中断时不生成 source result，已经完成的 source result 保留。

`DiscoveryResult` 自然唯一性为 `(discovery_run_id, meta_literature_id)`；引用输入种子本身不形成结果，既有数据库对象在本次被发现时仍形成结果。同一结果可以具有多个 cause。Topic cause 精确指向使该结果进入数据库的不可变 observation。Citation cause 中 `source_literature_id` 表示引用方、`target_literature_id` 表示被引用方，二者必须不同，`depth >= 1`；创建原因时对应受支持的权威 Reference 必须存在，但 cause 保存的是本次发现历史，不持久依赖以后可能因当前内容替换而删除的 Reference。直接原因和 depth 足以表达发现链，目标 Model 不建立 `DiscoveryPath`。

完成后的 input、source result、result 和 cause 不修改；Run 只允许从 `RUNNING` 进入一个终态。`StableFailure` 只保存稳定脱敏 code/reason/action/retryable，不保存异常正文。扫描、接纳、拒绝计数只在运行时用于执行边界，不进入这些 Model。

数据库补全的公开运行时输入为：

```text
BatchRequest
  selector: BatchSelector
  goal: BatchGoal

BatchSelector =
    AllPendingSelector(kind="all-pending")
  | DiscoveryRunSelector(kind="discovery-run", discovery_run_id)
  | ImportReportSelector(kind="import-report", meta_literature_ids)
  | QuerySelector(kind="query", query)
  | MetaLiteratureSelector(kind="meta-literatures", meta_literature_ids)
  | LiteratureSelector(kind="literatures", literature_ids)

BatchGoal = "ASSET_READY" | "CONTENT_READY"
```

每个 selector 只接受自己需要的字段；ID 列表非空、去重并保持用户顺序，`QuerySelector.query` 使用 Literature 查询模块的封闭 `LibraryQuery`，不接受裸 SQL 或自由字典。`AllPendingSelector` 选择当前仍可自动推进的对象，不选择需要 PDF 且已有自动获取耗尽事实的对象。`MetaLiteratureSelector` 允许版本选择，`LiteratureSelector` 严格处理明确版本；后者在目标需要 PDF 时也构成用户对该具体 Literature 的明确重试。不得恢复 `ids: tuple[str, ...] + details JSON + include_all_versions`，也不得向 selector 混入 goal、Provider、并发、Parser、LLM、`force`、retry、cursor 或 `details`。

`ImportReportSelector.meta_literature_ids` 直接使用一次 `ImportReport` 返回的有序去重 `accepted_meta_literature_ids`。它不引用不存在的 ImportRun，也不要求 SciRetriever 保存 Report；同一进程可以直接传递该 tuple，跨进程时用户也可以从自己保留的 JSON Report 中明确提交这些 ID。Entry 每次仍重新验证 ID 并读取 current facts，不能把旧 Report 当成目标状态。该 selector 与手工构造 `MetaLiteratureSelector` 的执行语义相同，只保留“来自本次导入结果”的输入意图。

Entry 展开 selector 后，只在当前进程中持有不可变目标 tuple 和每个 MetaLiterature 的有序 Literature 候选。目标和候选是编排私有运行数据，不形成 `BatchRun`、`BatchTarget`、`LiteratureCandidateSnapshot`、`BatchStatus`、`BatchTargetResult` 或 counts Model，也不进入 Catalog。运行期间范围变化不会修改该 tuple；重跑重新展开 selector。

自动 PDF 获取耗尽是不同于运行数据的当前事实：

```text
AutomaticPdfAcquisitionExhaustion
  literature_id: LiteratureId
```

它没有 reason、Provider、candidate、配置 hash、时间、次数或状态字段。只有 Acquisition 正常遍历全部当前自动路径时才能建立，提交成功后才允许返回 `NoPrimaryPdf`；新 MetadataObservation、自动或手动主 PDF 成功、用户明确重试时清除。它不进入 `LiteratureStatus`，只允许查询投影 `needs_manual_pdf = true`。

处理型 Entry 操作使用第 2.4 节的精确 typed Report。纯查询直接返回查询结果，不另外包装 Report；Acquisition、Parsing 和 Analysis 作为数据库补全内部阶段时返回各自公开结果，由 Entry 汇总到 `DatabaseCompletionReport`，不形成嵌套运行报告。

### 2.4 非持久化 Entry Report

Report 是一次有效 Entry 请求开始后的最终运行回执，不是持久化运行、恢复 checkpoint 或文献事实。所有 Report 默认不可变、拒绝未知字段，只存在于当前进程；CLI 可以把它序列化到 stdout，程序内调用方直接接收 Model。项目不建立通用字段容器、Report ID、开始/结束时间、持续时间、自由 `details`、日志事件数组或可恢复状态机。

各 Report 只共享一个精确的最终停止值，不共享大而全父类或 envelope：

```text
ReportEnd = FinishedReportEnd | InterruptedReportEnd | FailedReportEnd

FinishedReportEnd
  kind: Literal["finished"]

InterruptedReportEnd
  kind: Literal["interrupted"]

FailedReportEnd
  kind: Literal["failed"]
  failure: StableFailure

EntryReport =
    DiscoveryReport
  | DatabaseCompletionReport
  | ManualPdfReport
  | ImportReport
  | ExportReport
```

`finished` 只表示 Entry 到达该操作的正常边界，不表示全部 Provider、目标或记录成功；局部失败保留在操作特有结果中。`interrupted` 只表示用户受控停止。`failed` 表示写入准入、共同依赖、Storage 或其它操作级错误使本次操作无法正常走到边界；已经形成的局部结果仍可保留在 Report 中，已经提交的数据库事实也不回滚。CLI 参数、输入文件路径或枚举在操作开始前验证失败时直接返回稳定输入错误，不伪造一份没有运行内容的 Report。

`StableFailure` 是 DiscoverySourceResult 和全部 Report 复用的稳定、脱敏失败合同：

```text
StableFailure
  code: str
  reason: str
  action: str
  retryable: bool
```

三个文本字段去除边界空白后必须非空。它不保存 traceback、原始异常正文、HTTP/SDK 对象、URL、header、Cookie、prompt、文献正文、文件绝对路径或自由 details；`retryable` 只给用户提供本次失败的重试提示，不形成自动重试状态。

#### 2.4.1 DiscoveryReport

```text
DiscoveryProviderReportOutcome =
    "EXHAUSTED"
  | "SCAN_LIMIT_REACHED"
  | "FAILED"
  | "INTERRUPTED"
  | "NOT_STARTED"

DiscoveryProviderReport
  provider_name: str
  raw_item_count: int
  accepted_observation_count: int
  outcome: DiscoveryProviderReportOutcome
  failure: StableFailure | None

DiscoveryReport
  kind: Literal["discovery"]
  end: ReportEnd
  discovery_run_id: DiscoveryRunId
  run_status: DiscoveryRunStatus
  providers: tuple[DiscoveryProviderReport, ...]
  discovery_result_count: int
  new_meta_literature_count: int
  new_literature_count: int
  new_metadata_observation_count: int
```

Provider tuple 按输入顺序且名称唯一；所有 count 均非负。`raw_item_count` 使用与 scan limit 相同的过滤前口径，`accepted_observation_count` 只统计已经成功接纳的来源 observation。`failure` 只在 provider outcome 为 `FAILED` 时存在；`INTERRUPTED` 表示已经开始但受控停止，`NOT_STARTED` 表示停止或操作级失败前尚未调用。前三种 outcome 与已经提交的 `DiscoverySourceResult` 对齐，后两种只属于当次 Report。

`discovery_result_count` 是本次按 MetaLiterature 去重的 DiscoveryResult 数量；其余三个 count 分别说明真正新建的 MetaLiterature、具体 Literature 和 MetadataObservation。Report 不保存扫描 item、结果 ID 列表、cursor 或完整发现路径。`run_status` 报告数据库中最后成功提交的 DiscoveryRun status；如果操作级提交错误使其仍为 `RUNNING`，`FailedReportEnd` 说明本次失败，恢复时仍按 DiscoveryRun 规则收尾。

#### 2.4.2 DatabaseCompletionReport

```text
CompletionTarget = MetaLiteratureCompletionTarget | LiteratureCompletionTarget

MetaLiteratureCompletionTarget
  kind: Literal["meta-literature"]
  meta_literature_id: MetaLiteratureId

LiteratureCompletionTarget
  kind: Literal["literature"]
  literature_id: LiteratureId

CompletionStage = "acquisition" | "parsing" | "analysis" | "literature"

GoalReachedTarget
  target: CompletionTarget
  literature_id: LiteratureId

NeedsManualPdfTarget
  target: CompletionTarget
  literature_ids: tuple[LiteratureId, ...]

FailedCompletionTarget
  target: CompletionTarget
  literature_id: LiteratureId | None
  stage: CompletionStage
  failure: StableFailure

InterruptedCompletionTarget
  target: CompletionTarget
  literature_id: LiteratureId | None

NotStartedCompletionTarget
  target: CompletionTarget

DatabaseCompletionReport
  kind: Literal["database-completion"]
  end: ReportEnd
  goal: BatchGoal
  goal_reached: tuple[GoalReachedTarget, ...]
  needs_manual_pdf: tuple[NeedsManualPdfTarget, ...]
  failed: tuple[FailedCompletionTarget, ...]
  interrupted: tuple[InterruptedCompletionTarget, ...]
  not_started: tuple[NotStartedCompletionTarget, ...]
  no_usable_content_literature_ids: tuple[LiteratureId, ...]
```

前五个结果 tuple 对本次已经冻结的实际目标做不重不漏的分区，其长度之和就是实际选择数，presenter 直接按长度形成摘要，不在 Model 中再复制一组可能漂移的 counts。`GoalReachedTarget.literature_id` 是最终满足目标的具体版本。`NeedsManualPdfTarget.literature_ids` 非空，按本次候选顺序列出已经具有自动获取耗尽事实、可供用户明确绑定手动 PDF 的具体版本；Report 不复制耗尽原因。目标在失败或中断时尚未进入具体版本，`literature_id` 可以为空。

`no_usable_content_literature_ids` 按首次出现顺序去重，只说明这些具体 Literature 在本次至少有一个 PDF 被 Analysis 明确判定为 `NoUsableContent` 并完成清理；它可以与最终分区中的 `goal_reached` 或 `needs_manual_pdf` 同时出现，不保存 PDF、候选、原因或次数。这样用户能够区分内容无效与调用失败，而不会把一次中间清理错误提升成目标状态。

Network 或 Storage 错误按当时消费它的业务阶段报告；开始处理实际目标前发生的共同能力错误进入 `FailedReportEnd`。`NoUsableContent` 删除当前无效候选并继续同一版本或下一版本，不单独成为最终目标 outcome；最终要么由另一具体 Literature 达到目标，要么全部自动 PDF 路径耗尽进入 `needs_manual_pdf`，要么形成失败/中断。一个目标即使已经提交 PDF 后在 Parsing 失败，也只形成一项 `FailedCompletionTarget`，数据库中的 PDF 事实仍然有效。

#### 2.4.3 ManualPdfReport

```text
AcceptedManualPdfReportResult
  kind: Literal["accepted"]
  accepted: AcceptedManualPdf

RejectedManualPdfReportResult
  kind: Literal["rejected"]
  failure: StableFailure

ManualPdfReportResult = AcceptedManualPdfReportResult | RejectedManualPdfReportResult

ManualPdfReport
  kind: Literal["manual-pdf"]
  end: ReportEnd
  literature_id: LiteratureId
  result: ManualPdfReportResult | None
```

有效 PDF 完整提交后形成 `accepted`；目标不存在、已有主 PDF 或基本文件检查失败等正常输入拒绝形成 `rejected`，不增加第三种自动 AcquisitionResult。`FinishedReportEnd` 必须有一个 result；`InterruptedReportEnd` 或 `FailedReportEnd` 时 result 为空。Report 不保存用户输入路径，也不复制 PDF 字节。

#### 2.4.4 ImportReport 与 ImportReportSelector

```text
ImportAcceptanceOutcome = "created" | "enriched" | "matched"

AcceptedImportRecord
  kind: Literal["accepted"]
  record_index: int
  outcome: ImportAcceptanceOutcome
  meta_literature_id: MetaLiteratureId
  literature_id: LiteratureId

RejectedImportRecord
  kind: Literal["rejected"]
  record_index: int
  failure: StableFailure

ImportRecordReport = AcceptedImportRecord | RejectedImportRecord

ImportReport
  kind: Literal["import"]
  end: ReportEnd
  format: BibliographyFormat
  input_record_count: int
  records: tuple[ImportRecordReport, ...]
  not_processed_record_indexes: tuple[int, ...]
  accepted_meta_literature_ids: tuple[MetaLiteratureId, ...]
```

`record_index` 从零开始。Codec 先形成有序记录或逐记录格式失败，因此 `input_record_count` 在接纳开始前确定；`records` 与 `not_processed_record_indexes` 对 `0..input_record_count-1` 做不重不漏的分区。`created` 表示未命中并创建具体 Literature；`enriched` 表示命中后，导入记录至少提供了一个原本缺失的非空值，或以用户值替换了当前由供应商选择的值；`matched` 表示命中已有 Literature 且当前统一投影不变。首次出现但与当前 Provider 值相同的用户记录仍保存为 user observation；只有已经存在相同规范化 user observation 时才复用既有事实而不重复插入。格式不合格、缺少最低识别信息或稳定标识符明确冲突形成 `RejectedImportRecord`。前三种接纳结果都进入按首次出现顺序去重的 `accepted_meta_literature_ids`，单条拒绝不撤销其它接纳。对于 `CONTENT_READY` Literature，`enriched` 可以表示新导入 observation 已保存并将参与下一次完整 Analysis，不表示当前 metadata/content 已被拆开替换。

`ImportReportSelector` 只接受非空、去重且保持顺序的 `meta_literature_ids`；调用方可以直接复制 `accepted_meta_literature_ids`，空结果不形成补全请求。Report 本身不被 Entry 保存，也没有 ImportRunId。

#### 2.4.5 ExportReport

```text
SkippedExportRecord
  literature_id: LiteratureId
  failure: StableFailure

ExportFieldOmission
  literature_id: LiteratureId
  field: str
  reason: str

ExportReport
  kind: Literal["export"]
  end: ReportEnd
  format: BibliographyFormat
  selected_literature_ids: tuple[LiteratureId, ...]
  published_literature_ids: tuple[LiteratureId, ...]
  skipped: tuple[SkippedExportRecord, ...]
  not_published_literature_ids: tuple[LiteratureId, ...]
  omissions: tuple[ExportFieldOmission, ...]
  bytes_written: int | None
```

选择结果按最终具体 Literature 去重并保持导出顺序。`published_literature_ids`、`skipped` 和 `not_published_literature_ids` 对 selected 做不重不漏的分区；字段损失只用非空 `field/reason` 说明，不能用自由 details。导出发布是文件级原子操作：只有 staging file 完整 flush、`fsync` 并原子发布后，才能填充 `published_literature_ids` 和非负 `bytes_written`；中断或操作级失败时二者分别为空和 `None`，已经编码但未发布的 Literature 仍进入 `not_published_literature_ids`，旧目标文件保持不变。Report 不保存输出绝对路径或导出文件字节。

### 2.5 本地文献数据库查询与详情

本节是本地文献查询输入和主要读取投影的精确合同。它们全部定义在 `model/library.py`，默认不可变并拒绝未知字段，但不是数据库实体。外部 Metadata Provider 搜索继续使用 `TopicDiscoveryInput` 或 `CitationDiscoveryInput`；`LibraryQuery` 只读取已经接纳的 Catalog/ArtifactStore 当前事实，不访问网络、不创建 `DiscoveryRun`、不执行内容处理，也不修改数据库。

#### 2.5.1 LibraryQuery

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

#### 2.5.2 搜索请求与页面

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

`limit >= 1`；cursor 非空时是调用方不得解释或修改的不透明字符串，并与规范化 query、sort 和稳定位置绑定。cursor 不保存查询或数据库 snapshot；后续翻页重新读取当时的 current facts，数据库在两次请求之间变化时结果和 `total_count` 可以相应变化。`relevance` 只允许在 `query.text` 非空时使用。年份或标题缺失的记录在对应排序中排在具有该值的记录之后；所有排序最后使用 `literature_id` 作为稳定 tie-breaker。`total_count >= 0`，表示忽略本页 cursor/limit 后同一 query 的完整命中数；`items` 不重复且数量不超过 limit，`next_cursor` 只在仍有下一页时存在。

每个 `LiteratureSearchItem` 表示一篇具体 `Literature`，不按 `MetaLiterature` 折叠。不同 Provider 的重复记录已经作为同一 Literature 的多个 observations 收敛，不制造多个列表项；同一 MetaLiterature 下的不同明确版本仍分别出现，并通过 `literature.meta_literature_id` 归组。`Literature` 已经包含当前完整 `LiteratureMetadata` 和派生 `LiteratureStatus`，因此 SearchItem 不在顶层重复 metadata/status；revision/hash、第一缺失步骤和人工 PDF 标记是当前读取上下文的补充。

列表不嵌入 MetadataObservations、资产、ParserResult、LiteratureContent、Reference/Support、Discovery cause 或 artifact 字节。`LibrarySearchPage` 是一次读取结果，不另套 Entry Report。

#### 2.5.3 LiteratureDetail

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

下列一致性由 Literature 查询规则和 Storage read-model producer 保证，不由 Pydantic validator 重新推导身份、状态或缺失步骤：

- `literature.meta_literature_id == meta_literature.meta_literature_id`，其它版本共享该 ID 且不包含当前 Literature；
- Detail 中的全部 MetadataObservation 都已归属当前 Literature；
- `primary_pdf` 存在时其关系归属当前 Literature，AssetId/hash 与 ParserResult 输入一致；
- `content` 存在时其 metadata revision/hash 与 Detail 一致，并与当前主 PDF 和 ParserResult 对齐；
- `CONTENT_READY` 必须具有对齐的 primary PDF、ParserResult 和 content；`ASSET_READY` 必须具有 primary PDF 且没有有效当前 content；`UNREVIEWED` 不具有 primary PDF；
- `needs_manual_pdf = True` 时必须没有 primary PDF，且来源只能是当前自动获取耗尽事实；
- `missing_step` 与上述 current facts 使用同一 truth table。

Detail 可以返回 `LiteratureContent.sections/references` 等已结构化文本，但不嵌入 PDF、Parser Markdown、Parser resources 或规范 LiteratureContent Markdown 的完整 artifact 字节。调用方通过稳定 `Asset`/`ArtifactRef` 使用独立 artifact read 操作取得字节。ProviderRelationObservation 全部待扩展边、完整 Reference/Support、DiscoveryRun 历史、Report/log/failure、Network/Parser/LLM 运行现场和机器绝对路径都不进入 Detail；它们在确有读取需求时使用各自独立查询。

`LibraryQuery`、`LibrarySearchRequest`、`LiteratureSearchItem`、`LibrarySearchPage`、`LiteratureAssetView`、`LiteratureDetail`、`LiteratureReferenceRequest`、`LiteratureReferenceItem`、`LiteratureReferencePage` 和 `ReferenceDetail` 都是 query-side Pydantic Model，不是可持久化业务主体。Storage 只能从当前权威行和 artifact 引用组装它们，不能为这些投影建立第二份可修改事实。

#### 2.5.4 引用关系页面与关系详情

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

#### 2.5.5 从详情取得 artifact

`LiteratureDetail` 已经给出用户可读取的稳定 artifact 引用：

- 主 PDF 使用 `primary_pdf.asset`；
- Parser Markdown 使用 `parser_result.markdown`；
- Parser 实际引用资源使用 `parser_result.resources[].artifact`；
- 规范轻结构化 Markdown 使用 `content.markdown`。

Artifact 读取直接接受既有 `Asset | ParserArtifactRef | ArtifactRef`，不再建立
`ArtifactHandle`、artifact 字节 Pydantic Model、下载 token 或第二套路径对象。只读 binary
stream、用户目标路径和 context manager 是运行时 I/O 对象，不能进入 Pydantic、JSON、
Catalog、Report 或 `LiteratureDetail`。因此 Detail 本身不增加 `open()`、`export()` 等业务
方法；调用方从 Detail 取得引用，再交给 Entry/Literature 的独立 artifact 操作。

### 2.6 配置数据边界

`model/configuration.py` 只接收已经由根级 configuration 边界解析完成的普通配置和安全诊断。它可以表达稳定 Provider key、`metadata`/`acquisition` capability、启用状态、非 secret 产品选择、AccessPolicy、凭据字段名称/必需性/存在性，也可以表达 LLM provider/protocol/Base URL/model/context/authentication/预算与 MinerU connection mode/Base URL/model identity/upload consent。服务 URL 和预算 validator 只执行结构与安全组合检查，不读取文件、secret 或 Network。Provider 凭据使用以下本地状态：

```text
not-required
configured
partial
missing
optional-missing
unsupported
```

真实 API key、token、metric、Cookie、浏览器 session、凭据文件原文和任何可以辨识 secret 的值、掩码、长度、hash、前后缀或 fingerprint 都不能进入 Pydantic。Model 也不承担读取 `~/.sciretriever/credentials.toml`、检查 owner/权限、隐藏交互、原子写入或调用 Provider；这些都是 configuration/CLI/adapter 边界行为。

若 `config status` 或 `config test` 提供 JSON，结构化结果只组合非 secret 普通配置、稳定 Provider key、capability、安全状态、统一凭据 presence/origin-match、通过/失败/跳过结果和稳定 failure code。`ConfigurationRuntimeStatus` 分组表达 Storage、MinerU 与 Analysis 本地完整性；`CoreConfigurationProbeResult` 以中性 typed details 明确 LLM 是 minimal-schema、MinerU 是 health-only，并固定 `persisted = false`。它们不包含 secret 值或其可辨识特征、原始网络异常、响应正文、测试时间、Literature 身份、DiscoveryRun 或 Report；结果只是本次非持久化配置诊断，不成为 Entry 处理 Report 或数据库 Model。认证接受与具体文献全文 entitlement 必须分别表达，不能由 Model 字段合并成一个“可下载”布尔值。

## 3. Pydantic 约束

所有结构化业务数据统一使用 Pydantic v2，并遵守：

- 默认不可变；
- 默认拒绝未知字段；
- 封闭状态集合使用明确枚举；
- 只有语义上封闭的值集才定义枚举；`LiteratureMetadata.document_type` 是 `str | None` 开放词汇，具体规则见 [Literature 技术文档](literature.md#41-literaturemetadata-的边界)；
- 集合在边界转换为不可变容器；
- 时间、hash、ID 和相对路径使用统一 primitive；
- Canonical Model 优先只使用 Pydantic 内建解析；
- 只有边界 Model 可以使用受控 validator 完成纯格式转换、不可变容器转换和跨字段结构约束。

Model 不得使用 validator、自定义 serializer、自定义 `__init__`、`model_post_init`、普通业务方法或 property 执行：

- 文献身份收敛；
- 元数据 precedence；
- PDF 基本检查或实际内容判断；
- 文献状态推导；
- 导入接纳或导出资格判断；
- I/O、环境读取、provider 调用或其它副作用。

这些含义由拥有规则的功能模块解释。

`MetaLiterature`、`Literature`、`VersionRole` 和 `LiteratureStatus` 的精确合同由 [Literature 技术文档](literature.md#2-metaliterature-与-literature) 定义。`VersionRole` 使用 `published`、`accepted-manuscript`、`preprint` 和 `other`，不保留旧名称 `formal`；`LiteratureStatus` 只承载 Literature 模块已经推导的当前结果，Model validator 不计算状态。

`MetadataObservation` 的精确合同由 [Literature 技术文档](literature.md#42-metadataobservation-来源输入) 定义。它是独立、不可变且长期保存的来源对象，不是 `Literature` 属性；一个 Literature 与多个 observations 的归属由 Storage 关系表达，不把 `literature_id` 放入 observation。Provider observation 与书目导入 observation 复用同一结构，只通过受约束的 Provenance 区分；`record.py` 不得复制 `LiteratureMetadata` 字段建立 `ImportedMetadata`。`version_links` 只保存供应商明确声明为同一文献其它版本的目标 key，用于可审计身份收敛，不进入 `LiteratureMetadata` 或形成独立权威关系；`reference_texts` 只保存供应商实际返回的原文，不声明完整，也不表示已经形成引用关系。`MetadataObservation.declared_keywords` 保存供应商声明关键词；书目导入的 keywords 进入该 observation 的 `metadata.keywords` 并可参与统一初始投影；完整 Analysis 后，当前 `LiteratureMetadata.keywords` 保存 Literature 已验收的全文关键词。`LiteratureMetadata.pages` 同时承载传统页码范围和供应商返回的电子文章定位号，不再建立 `article_number`。`AssetHint` 的精确合同由 [Acquisition 技术文档](acquisition.md#33-assethint-合同) 定义；其中 URL、媒体类型、资产角色、版本角色、访问状态和许可证都描述具体来源线索，不属于 `LiteratureMetadata`，也不代表已接纳资产。`AssetHint` 不增加获取层级、授权要求或 Browser 要求，运行访问上下文由 Acquisition Resolution/Plan 决定。`PdfCandidate`、`Asset`、`LiteratureAsset` 和 `AcquisitionResult` 的精确合同分别见 [Acquisition 3.4](acquisition.md#34-route-hint候选与-adapter-边界)、[3.5](acquisition.md#35-asset-与-literatureasset)和[第 2 节](acquisition.md#2-输入与公开结果)：候选与 candidate key 只存在于当前运行；候选只保存 route adapter 的稳定 source identity、Public/Authorized API/Browser path 和声明媒体类型，不要求 URL，也不携带 adapter 私有动作；Asset 只描述不可变文件；唯一 `primary-pdf` 关系表达当前主 PDF；自动业务结果只有已获得或未获得，系统提交错误不属于该联合。`NoPrimaryPdf` 只有在全部适用 routes 正常结束、没有 deferred/action-required/未解决 failure 且最小耗尽事实已提交后成立；运行错误不能伪装成该结果。手动接纳成功使用独立 `AcceptedManualPdf`，只组合已经提交的 `Asset` 与 `LiteratureAsset`；无效本地文件是输入验证错误，不进入自动联合，用户绝对路径不进入 Model。这些来源信息不能通过通用 `extra_metadata`、裸字典或 vendor model 扩展 `LiteratureMetadata`。非空标题或 DOI 至少存在一个是 Literature 的入库规则，不由 Model validator 决定。

`DiscoveryRun` 与运行时数据库补全输入的精确合同见 [2.3 节](#23-discoveryrun-与运行时数据库补全)。目标 Model 不保留 `CollectionRun`、Collection、membership、`CollectionSelector`、`BatchRun`、`BatchTarget`、候选 snapshot、target result、counts、`requested_advance_to`、`selected_version_ids`、`include_all_versions` 或通用 execution `details`。DiscoveryRun input/source outcome/cause 和 BatchSelector 使用各自封闭判别联合；补全目标、候选和 Report 只服务当前进程。

`LiteratureMetadata` 是单一当前值，不是来源 observation 或 revision 历史对象。`metadata_revision` 不进入 `LiteratureMetadata` schema；它是持久化关系上的单调并发令牌，和 `metadata_sha256` 一起绑定当前内容输入。Catalog 不暴露旧统一元数据 revision 集合，LLM 最终提案也不转换为 `MetadataObservation`。

ADR 0012 的 `AccessScope`、访问政策、permit、`next_allowed_at` 和 `blocked_until` 是 Network 内部技术数据；其中动态状态只存在于当前进程内存。它们不属于模块间业务 Model，也不进入 `model/access.py`、Catalog、ArtifactStore、provenance 或独立协调文件，且不能携带 DOI、Literature ID、候选、完整 URL、凭据或响应正文。

ADR 0015 的静态 `PublisherAccessProfile` catalog，以及当前操作的 `PublisherAccessResolution`、`AcquisitionPlan`、`AccessRouteHint`、Browser queue/session health/circuit，都是 Acquisition/Network 模块私有技术对象，不进入共享业务 Model 或持久化 schema。运行对象可以使用模块私有不可变类型在 Entry/Acquisition 边界内协作，但不能被序列化为 Literature、Report 自由 details、Catalog 或 Artifact。Cookie、持久 Browser Profile 的路径/内容、签名 locator 和页面对象始终留在适配边界；runtime process/context、article page、临时下载目录、queue/health/circuit 关闭后不得跨操作保留，但 Chrome 管理的 Profile 状态会在 owner-only 目录中跨命令保留，只有用户显式删除才移除。

`ProviderLiteratureKey` 是供应商文献记录的中性定位，只包含可选 `record_id` 和稳定 `Identifier[]`，且至少具有其中一种定位。`MetadataObservation.version_links` 用它定位同文献其它版本；当前端点由父 observation 表达。`ProviderRelationObservation` 用两个 key 表达一条规范化 `citing -> cited` 有向引用边。两种用法都不接受本地 Literature ID、目标 MetadataObservation 或状态字段；Model validator 只检查封闭结构、至少一个定位值和非空格式，不决定版本归属、目标接纳或 Reference 建立。精确合同见 [Literature 技术文档](literature.md#42-metadataobservation-来源输入)与 [Metadata 技术文档](metadata.md#52-providerrelationobservation)。

`ParserResult` 是 Parsing 交给 Analysis 的中间合同，不是 `LiteratureContent` 或状态事实。Analysis 先根据它形成结构化最终 `LiteratureMetadata` 提案，再把该元数据和同一 `ParserResult` 交给第二阶段形成内容 Markdown 草稿；`LiteratureContent` 由 Analysis 解析第二阶段草稿后形成，并由 Literature 与最终元数据整体接纳。第一阶段提案和第二阶段草稿都不是独立持久化 Model 事实。

`ParserResult` 的精确合同为：

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

`page_count` 至少为 1；Markdown artifact 的媒体类型固定为 `text/markdown`，实际字节必须是合法 UTF-8。`resources` 只接受 Markdown 实际使用的安全相对引用，按 `reference` 确定排序且不能重复。Parser provenance 组合复用公共 `Provenance`，其中 source kind 固定为 parser、source record ID 为空、输入与参数 hash 必填；Parser 专属版本必填，mode/model identity 可以为空。`result_sha256` 的 canonical 清单和当前结果替换规则见 [Parsing 技术文档](parsing.md#4-parserresult-精确合同)。ParserResult 不接收正文副本、私有 JSON、block、bbox、source locator、内容决定或 task 状态。

第一阶段内容判断结果的精确结构为：

```text
NoUsableContent
  outcome: Literal["no_usable_content"]

FinalMetadataProposal
  outcome: Literal["usable"]
  metadata: LiteratureMetadata

MetadataAnalysisResult = NoUsableContent | FinalMetadataProposal
```

`NoUsableContent` 不接受评分、置信度或详细原因；`FinalMetadataProposal` 直接复用 `LiteratureMetadata`。只有 Analysis 可以解释该联合的业务含义，Model 只验证判别值与字段结构。

`LiteratureContent.references: tuple[str, ...]` 保存按 PDF 顺序识别的非空参考文献文本，允许空 tuple，不嵌入临时 `ReferenceLookup` 或权威 `Reference`，也不携带完整性字段或逐条 source locator。“未提供”只是空 tuple 的最终 Markdown 渲染值，不能进入 references。`ReferenceLookup` 只在一次引用目标检索中交换，不持久化或进入 `LiteratureContent`。正文、参考文献和最终文档的来源由单一 Analysis provenance 的输入 hash 在文档级表达；Parser provenance 留在 ParserResult。

`LiteratureContent` 的最小结构为：

```text
LiteratureContent
  literature_content_sha256: Sha256
  metadata_revision: int
  metadata_sha256: Sha256
  sections: tuple[LiteratureSection, ...]
  references: tuple[str, ...]
  markdown: ArtifactRef
  provenance: Provenance

ArtifactRef
  sha256: Sha256
  media_type: str
  byte_size: int

LiteratureSection
  role: LiteratureSectionRole
  title: str | None
  markdown: str
  subsections: tuple[LiteratureSubsection, ...]

LiteratureSubsection
  title: str
  markdown: str

LiteratureSectionRole =
    "background-and-objectives"
  | "methods"
  | "data"
  | "conclusions-and-limitations"
  | "additional"
```

四个固定 role 各出现一次且保持相对顺序，`title` 为空并由 renderer 使用系统标题；`additional` 可出现零到多次，`title` 必须非空且不能使用七个保留标题。全部 H1 共用同一个 `sections` 序列，H2 保存在所属 section 的有序 `subsections` 中。`markdown` 保存对应 H1 或 H2 下的 Markdown 字符串，段落、列表、表格、公式和代码块不拆成更多 Model。固定 section 有内容时必须具有非空 H1 `markdown` 或至少一个有内容的 subsection，只有 H2 内容时 H1 `markdown` 可以为空；整体没有相关信息时使用精确字符串“未提供”和空 subsections，不能混用缺失标记与有内容的 subsection。额外 section 没有实际内容时不创建。`# 元数据`、`# 摘要` 和 `# 参考文献` 不进入 sections：前两者从第一阶段形成并最终验收的 `LiteratureMetadata` 渲染，后者来自第二阶段解析出的 `references`。

`ArtifactRef.media_type` 对规范 Markdown 固定为 `text/markdown`，字节固定为 UTF-8。`literature_content_sha256` 只覆盖 `metadata_sha256`、`sections` 和 `references` 的规范序列化，不包含 `metadata_revision`、provenance、模型、生成时间、文件路径、`markdown.sha256` 或数据库 ID；`markdown.sha256` 只覆盖最终 Markdown 字节。`provenance` 的 `source_kind` 固定为 `analysis`，`source_name` 是 provider/model 标识，输入 hash 覆盖当前 PDF、ParserResult 和最终 metadata，参数 hash 覆盖 prompt 版本与有效模型参数。LiteratureContent 不接受 `LiteratureContentLineage`、两次调用的 provenance tuple 或 Parser provenance 副本。

`LiteratureContent` 只表示已经接纳的最终当前内容。Analysis 的临时提案携带作为 stale 复检依据的输入 metadata revision/hash，但不预先分配权威 revision，也不发布 `LiteratureContent`；Literature 在最终 metadata、sections、references 和规范 Markdown 整体接纳的同一事务中递增当前 metadata revision，并把该 revision/hash 写入最终 `LiteratureContent`。因此这两个字段始终指向实际用于渲染同一份 Markdown 的已接纳当前元数据，而不是 Analysis 的输入 revision、历史元数据或未持久化提案。Model 不增加 current flag 或历史字段；每个 Literature 一个当前 metadata/content 视图及其原子替换由 Literature/Storage 约束。

`Reference` 只有 `reference_id`、`source_literature_id` 和 `target_literature_id` 三个必填字段。`ReferenceSupport` 由 `reference_id` 和判别联合 `source` 组成，不设置独立 ID；三种 source 分别用关系 observation ID、metadata observation ID 加零基索引，或当前 LiteratureContent SHA-256 加零基索引定位真实来源。Reference 不平铺 provenance、原文、目标元数据或 evidence，support 也不复制这些内容；当前 content 替换后的 support 清理属于 Literature/Storage 规则。精确合同见 [Literature 技术文档](literature.md#5-引用解析与权威-reference)。

## 4. 外部类型隔离

Model 不能导入或暴露：

- Vendor SDK model；
- HTTP request/response、header 或 cookie 类型；
- Playwright page、context 或 download 类型；
- `sqlite3` row、cursor、connection 或 SQL 结果类型；
- MinerU 私有响应；
- LLM vendor 私有响应；
- 机器相关绝对路径。

外部适配器必须先把这些类型转换成中性 Model。转换失败停留在适配边界，不能通过裸字典或 `Any` 穿透。

## 5. 标识、时间与序列化

- `Literature` 身份、metadata revision、内容 artifact identity 与 schema version 使用不同类型和字段名；
- SHA-256 统一使用小写十六进制表达；
- 持久化时间统一为 UTC；
- 文件引用使用配置存储根下的规范化相对路径；
- 需要确定性持久化或 hash 的对象使用明确的 canonical serialization 规则；
- 普通 API 序列化不能暗中改变业务含义、排序或缺失值语义。

具体身份、排序和状态算法不放入 Model。

## 6. 不建立 DocumentPackage 占位

[ADR 0008](../decisions/0008-summarized-markdown-literature-content.md) 已撤销 ADR 0005 的 `DocumentPackage` 2.0 目标合同。目标 `model/` 不保留 `document_package.py` 占位，不公开该名称，也不建立对应 API、数据库表、文件命名空间、状态或 CLI。未来出现明确完整快照需求时，先确认消费方和公开合同，再新增 ADR 与 Model；不能让空占位暗示过时合同仍会实现。

## 7. 验收

直接测试至少证明：

- 未知字段、错误枚举、无效 ID/hash/time/path 被拒绝；
- `Identifier` 拒绝空 namespace/value 和畸形的已知标识符；DOI 裸值、`doi:`、已知 resolver URL、大小写与边界空白得到同一小写裸值，且不会错误删除 suffix 标点；
- arXiv 新式/旧式、`arXiv:`、官方 abs/pdf URL、`.pdf` 与 `vN` revision 得到不带 revision 的同一基础 ID；PMID 保持纯数字，PMCID 使用大写 `PMC`，未知 namespace 只 trim 而不做全局大小写或标点转换；canonicalization 幂等且确定；
- `Identifier` 不接收独立的 `url`、`provider`、`provenance`、`primary` 或 `confidence` 等额外字段；已知 resolver URL 只允许作为 `value` 的输入包装并立即去壳。Provider record ID 只能进入 `Provenance.source_record_id` 或 `ProviderLiteratureKey.record_id`；validator 不执行 Provider 语义归类、身份合并或 I/O；
- `Author` 能表达个人、机构与未知署名并保持作者和单位顺序；ORCID 校验格式与校验位，缺失姓名组成、ORCID 或 ROR 时不猜测；
- `ParserArtifactRef`、`ParserResource`、`ParserProvenance` 和 `ParserResult` 拒绝未知字段、不安全资源引用、重复 reference、无效 hash/媒体类型/大小、错误 parser kind、输入 hash 不对齐和非确定结果清单；
- 默认不可变和不可变容器成立；
- Topic/Citation DiscoveryInput 拒绝空 query、无效年份、重复 Provider、非正 scan/result limit、空 citation seeds 或负 depth；每个 Provider 的 scan limit 作用于整个 Run，citation result limit 按种子外的不同 MetaLiterature 计数；
- DiscoveryRun 只接受 ID、类型化输入、五态 status 和开始时间；source result 只接受 Provider、三值 outcome 与匹配的可选 failure，result/cause 不接收 Provider cursor、request/response、搜索分数、过程计数、完整路径、处理目标或自动 advance 字段；
- CitationDiscoveryCause 保存不同的 source/target Literature 与正 depth，不依赖 ReferenceId；Topic cause 指向实际 MetadataObservation；
- `BatchRequest` 只包含六类运行时 BatchSelector 之一和 BatchGoal；其中导入范围必须使用 `ImportReportSelector`，不存在 ImportRun 或 CollectionSelector，selector 不接收执行策略或自由 details，目标与候选只在 Entry 内存中保持有序且不成为持久 Model；
- `EntryReport` 只接受 `DiscoveryReport`、`DatabaseCompletionReport`、`ManualPdfReport`、`ImportReport` 或 `ExportReport`；五者只共享 `finished`、`interrupted`、带 `StableFailure` 的 `failed` 三种 `ReportEnd`，不建立通用 envelope；
- `StableFailure` 只接受非空 `code/reason/action` 和布尔 `retryable`，不接受原始异常、URL、凭据、正文、路径或自由 details；Discovery 与 Report 复用同一类型；
- Provider 配置 Model 只接受稳定 key、capability、非 secret 配置和安全状态/失败；凭据值或其掩码、长度、hash、fingerprint、原始文件、网络响应、测试时间和 entitlement 推断不能进入 Pydantic 或 JSON；
- `DiscoveryReport` 保持输入 Provider 顺序，逐来源 outcome 与 failure 匹配，所有运行时 count 非负且不复制 cursor、结果 ID 或发现路径；
- `DatabaseCompletionReport` 的 `goal_reached`、`needs_manual_pdf`、`failed`、`interrupted`、`not_started` 对冻结目标不重不漏；`no_usable_content_literature_ids` 只是可与最终分区重叠的本次反馈，不成为目标状态或候选历史；
- `ManualPdfReport` 正常结束时恰有 accepted/rejected 结果，中断或操作级失败时 result 为空，且不保存用户输入路径或 PDF 字节；
- `ImportReport.records` 与 `not_processed_record_indexes` 对输入索引不重不漏，`accepted_meta_literature_ids` 按首次出现顺序去重，并能直接形成非空 `ImportReportSelector`；
- 导入边界只组合既有 `LiteratureMetadata`，不建立第二套导入元数据字段；导入 observation 只接受固定 user/bibliographic-import provenance，Provider observation 只接受 metadata-provider provenance；
- ImportReport 能区分 created、以用户值补缺或替换供应商当前值的 enriched、当前统一投影不变的 matched，以及格式/最低识别/稳定标识符冲突导致的 rejected；首次匹配 Provider 值的用户记录仍保存 observation，只有完全重复的 user observation 不复制；
- `ExportReport` 的 published/skipped/not-published 对 selected 不重不漏；只有文件完整原子发布后才允许非空 published 和 `bytes_written`，中断或操作级失败保持旧输出不变；
- Model 不公开 BatchRun、BatchStatus、BatchTarget、候选 snapshot、目标结果、批次 counts、普通 current failure、ReportId、报告时间/持续时间、通用报告 status、日志事件数组或第二套摘要 counts；
- `AutomaticPdfAcquisitionExhaustion` 只接受 LiteratureId，不接收 reason、Provider、candidate、配置 hash、时间、次数或状态，也不增加 LiteratureStatus；
- 目标 Model 不再公开 `CollectionRun`、`requested_advance_to`、`include_all_versions` 或其它发现与处理混合合同；
- `LibraryQuery` 完成字符串/tuple 规范化、年份范围和封闭 role/status/missing-step 结构验证，并拒绝 sort/cursor/include/raw SQL/FTS、Provider 私有字段或文件路径；字段间 AND、一般多值 OR、keywords AND 和实际匹配由 Literature 查询测试证明，不在 validator 中执行数据库语义；
- `LibrarySearchRequest` 默认按发表年份降序且 limit 为 50，只接受正 limit 和非空不透明 cursor，relevance 要求非空 text；`LibrarySearchPage` 只接受非负 total、不可变无重复 items 和可选 next cursor，实际排序、cursor 绑定与翻页由 Literature/Storage 查询测试证明；
- `LiteratureSearchItem` 以具体 Literature 为单位并复用其中的完整 metadata/status，不建立 MetaLiterature 折叠结果、MetadataSummary 或第二份顶层 metadata/status；
- `LiteratureDetail` 和 `LiteratureAssetView` 只组合既有中性 Model、非负计数和明确可选字段，不接受 artifact 字节、完整关系图、Discovery 历史、Report/log/failure 或自己的 ID/provenance/hash/revision；Meta 归属、observation 归属、primary role、ParserResult/Content 对齐、三级 status、第一缺失步骤、人工 PDF 标记和其它版本一致性由 Literature/Storage producer 测试证明，Model validator 不重新形成这些业务决定；
- `LiteratureReferenceRequest` 只接受具体 LiteratureId、正反两个方向、正 limit 和不透明 cursor；`LiteratureReferencePage` 只接受非负 total、不可变无重复 items 和可选 next cursor，方向端点、稳定排序、cursor 绑定与同一 snapshot 由 Literature/Storage 查询测试证明；
- `LiteratureReferenceItem.support_count` 至少为 1，相关 Literature 复用非递归 SearchItem；`ReferenceDetail` 必须组合同一 Reference 的 source/target SearchItem 和至少一项去重 support，不复制来源原文、observation 或 provenance；
- Artifact 读取只接受既有 `Asset`、`ParserArtifactRef` 或 `ArtifactRef`；binary stream、context manager、用户目标路径和文件字节不形成 Pydantic Model，也不进入 Detail、JSON、Catalog 或 Report；
- 边界 validator 只执行纯结构转换；
- Vendor、HTTP、浏览器、SQL、MinerU 和 LLM 私有类型没有进入 Model；
- 同一 canonical 输入得到确定序列化结果；
- `DocumentPackage` 名称、占位和旧 Package 2.0 类型没有进入目标 Model 或公开 API；
- `MetadataAnalysisResult` 只接受无附加字段的 `NoUsableContent` 或携带完整 `LiteratureMetadata` 的 `FinalMetadataProposal`；
- `LiteratureContent` 只接受与第一阶段最终 metadata revision/hash 对齐的有序 sections 和 references；章节正文使用 Markdown 字符串，四个固定 role 恰好各一次，additional 标题非空且不与保留标题冲突；固定缺失值为“未提供”，空 references 不把缺失标记作为条目；
- 内容 hash、UTF-8 Markdown artifact hash 和单一 `source_kind = "analysis"` provenance 的字段与覆盖范围严格区分，不接受 `LiteratureContentLineage`、两次 LLM provenance tuple 或 Parser provenance 副本；
- `MetadataObservation.version_links` 只接受至少具有一种稳定定位的 `ProviderLiteratureKey`，不接受关系类型、本地 ID、目标 metadata 或状态，也不产生 `LiteratureRelationObservation` 或 `LiteratureRelation`；
- `Reference` 和三种 `ReferenceSupportSource` 拒绝未知字段、错误判别值、负索引和额外混合字段，且 support 不产生第二份 provenance 或原文；
- `ProviderRelationObservation` 一条只接受一条 citing/cited 边，两个 key 至少有一种稳定定位且不能相同，不接受 query direction、本地 ID、目标 metadata 或扩展状态；
- `PdfCandidate`、`Asset` 和 `LiteratureAsset` 拒绝边界外字段；候选只接受 candidate key、route adapter 的稳定 source identity、三值 acquisition path 和可选声明媒体类型且不持久化，不接受 URL、header、Cookie、凭据、API object、页面 action 或失败原因；Asset 不混入文献归属，LiteratureAsset 不复制版本角色或 `is_current`；
- 自动 `AcquisitionResult` 只允许完整提交的 `AcquiredPrimaryPdf` 和无字段 `NoPrimaryPdf`，不能用原因枚举或第三个结果承载系统错误；`AcceptedManualPdf` 是独立成功类型且不接收 path，输入验证错误不进入该联合；

架构检查和人工语义审查共同验证 Model 没有形成第二套业务规则。
