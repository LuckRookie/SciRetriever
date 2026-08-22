# Storage 模块技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 设计责任：[设计文档 5.4](../design.md#54-存储)
- 身份决策：[ADR 0002](../decisions/0002-literature-identity-and-incremental-processing.md)
- 稳定原则：[架构原则](../principles.md)
- 运行原则：[ADR 0011](../decisions/0011-literature-database-centered-incremental-maintenance.md)
- 发现与补全：[ADR 0013](../decisions/0013-decoupled-discovery-and-database-maintenance.md)

本文定义目标 `src/sciretriever/storage/` 的 SQLite、不可变文件、本机写入互斥和对账实现。Storage 保存其它模块已经确认的事实，不形成文献身份、元数据收敛、PDF 判断、状态或导出资格决定。

SQLite Catalog 与文件系统 ArtifactStore 共同构成产品级统一逻辑文献数据库：前者保存结构化事实、关系和稳定 artifact 引用，后者保存不可变字节。Storage 是这套数据库的技术实现边界，不是文献业务中心；数据库之所以是产品中心，不会把身份、验收、状态或 precedence 的含义转移给 Storage。

Network 不构成这套文献数据库的第三部分。供应商访问政策属于配置；等待队列、permit、窗口计数、冷却和 `Retry-After` 截止只存在于当前进程内存，既不进入 SQLite 或 ArtifactStore，也不由 Storage 提供协调文件。Storage 的本机核心写入锁只保护同一 Catalog 的完整性，不承担供应商限速；精确边界见 [ADR 0012](../decisions/0012-process-local-provider-access-scheduling.md)。

## 1. 目标结构

```text
storage/
  sqlite/
  files/
  locking.py
```

- `sqlite/` 实现消费模块拥有的 repository、publisher 和 read-model Ports；
- `files/` 实现临时写入、不可变发布、读取、hash 验证和对账；
- `locking.py` 实现同机核心写入准入。

SQL 和 `sqlite3` 只能出现在 `sqlite/`；最终文件创建、对账和回收只能出现在 `files/`。

## 2. SQLite 责任

SQLite 使用关系 schema 保存需要约束、连接、去重和高频查询的结构化事实。Pydantic 是模块交换合同，不意味着把整个对象统一序列化成一个 JSON 列：

- 字符串、整数、布尔、时间、枚举、ID 和 hash 使用普通列；
- 有序作者、单位、标识符、关键词、资产线索、版本 key 和其它重复结构使用带 ordinal 或自然键的子表；
- 外键、唯一性、当前关系和支持关系使用明确关联表；
- PDF、Parser Markdown/资源、结构化 LiteratureContent 和规范 Markdown 的完整字节进入 ArtifactStore，SQLite 只保存 artifact identity、hash、大小、媒体类型和关系；
- 只有某项业务语义本身是无需字段查询与关系约束的封闭树，并且已经单独获批时才可使用 canonical JSON。当前核心 schema 不提供通用 JSON、`extra`、`details` 或“完整 Pydantic dump”兜底。

Repository 负责在这些关系行和公开 Pydantic Model 之间组装；SQL row 不是第二套业务 Model。

### 2.1 共享表

| 表 | 保存内容与关键约束 |
|---|---|
| `schema_identity` | 单行 schema version、manifest fingerprint 和创建/升级时间；不保存业务对象 |
| `artifact_objects` | artifact identity、SHA-256、byte size、media type、规范化相对路径；`sha256 + byte_size` 与路径保持唯一一致 |
| `provenances` | 公共 Provenance 的七个普通字段；不保存凭据、绝对路径、原始响应或异常正文 |

只有持久化业务合同明确拥有的稳定失败才进入对应关系行，例如失败的 Discovery source result；不建立能够与业务对象脱离的通用 failure blob，也不为普通补全、Network、Parser 或 LLM 失败建立 current failure 表。

### 2.2 DiscoveryRun

外部发现使用以下表组：

| 表组 | 保存内容与关键约束 |
|---|---|
| `discovery_runs` | run ID、`topic`/`citation` kind、status 和开始时间；创建即 `RUNNING`，终态后不可修改 |
| `topic_discovery_inputs` | 每个 topic run 唯一的 query、year_from、year_to 普通列 |
| `citation_discovery_inputs`、`citation_discovery_seeds` | 每个 citation run 唯一的方向、max_depth、result_limit，以及按 ordinal 保存的具体 seed LiteratureId |
| `discovery_run_providers` | run 内 Provider ordinal、稳定名称和整个 Run 的 scan_limit；同一 Provider 每 run 唯一 |
| `discovery_source_results` | 每个 run/provider 唯一的 `EXHAUSTED`、`SCAN_LIMIT_REACHED` 或 `FAILED`，以及仅失败时存在的稳定脱敏 failure |
| `discovery_results` | `(discovery_run_id, meta_literature_id)` 唯一的已接纳结果 |
| `topic_discovery_causes` | 结果与实际 `MetadataObservation` 的类型化来源关联 |
| `citation_discovery_causes` | 结果与本次发现时实际 source/target Literature、正 depth 的历史原因；不以 ReferenceId 为长期外键 |

`DiscoveryRun` 不保存 `finished_at`、`CREATED` 或 `NO_TARGET`。零结果可以 `COMPLETED`；用户提前停止或恢复时发现遗留 `RUNNING` 后转为 `INTERRUPTED`。中断时已经完成的 source result 和已接纳 result/cause 保留，未完成 Provider 不生成 source result。Topic cause 指向长期不可变 observation；citation cause 是不可变运行历史，即使以后当前 Reference 因失去全部 support 被删除也继续存在，但它本身不是 ReferenceSupport。

当前产品不建立 Collection、membership、membership cause 或 Collection selector 表。Provider cursor、请求/响应、搜索候选、相关度、原始扫描/接纳/拒绝计数、分页现场、完整 DiscoveryPath 和未接纳结果不进入上述表。一个本地只读查询也不创建 discovery row。

### 2.3 Literature、MetadataObservation 与引用

主体和当前统一元数据使用：

| 表组 | 保存内容与关键约束 |
|---|---|
| `meta_literatures` | MetaLiteratureId 和必须指向自身成员的 representative LiteratureId；不保存成员列表或状态 |
| `literatures` | LiteratureId、唯一 meta_literature_id 归属和 version_role |
| `literature_metadata` | 每个 Literature 唯一当前行、metadata revision/hash 及 title、abstract、publication date/year、document type、language、venue、publisher、volume、issue、pages 等普通标量列 |
| `literature_metadata_authors`、`literature_metadata_author_affiliations` | 当前作者与单位按 ordinal 关系化保存 |
| `literature_metadata_identifiers`、`literature_metadata_keywords` | 当前标识符与 LLM 最终关键词；自然键去重并保持 ordinal |

来源 observations 完整长期保存，但使用同样的关系化映射。`provenances` 对 Provider observation 保存 `metadata-provider` 来源字段；对书目导入 observation 固定保存 `user`、`bibliographic-import`、空 source record/input/parameters hash 和接纳时间。Catalog 不保存原始书目文件、外部工具身份、外部记录 ID 或导入批次：

| 表组 | 保存内容与关键约束 |
|---|---|
| `metadata_observations` | ObservationId、provenance FK、version_role、可选 reference/cited-by counts 和 observation metadata 的标量列；Provider 与用户导入共用，行不可变 |
| `metadata_observation_authors`、`metadata_observation_author_affiliations` | 来源作者和单位的有序结构 |
| `metadata_observation_identifiers`、`metadata_observation_keywords` | observation 内 LiteratureMetadata 的标识符与关键词字段 |
| `metadata_observation_declared_keywords`、`metadata_observation_reference_texts` | Provider 声明关键词与原始参考文献文本，按 ordinal 独立保存；书目导入不以这些表复制 `metadata.keywords` |
| `metadata_observation_asset_hints` | 每个 AssetHint 的 URL、kind、media/asset/version role、access status 和 license 普通列；没有线索的导入 observation 不生成子行 |
| `metadata_observation_version_links`、`metadata_observation_version_link_identifiers` | Provider 明确版本连接中每个 ProviderLiteratureKey 的可选 record_id 与稳定 identifiers；至少一种定位 |
| `literature_metadata_observations` | Observation 到具体 Literature 的接纳归属；每个 observation 最多归属一个 Literature，一个 Literature 可以有多个 observation |

全部 identifier 子表都保存 Model 已形成的 canonical `(namespace, value)`：DOI 是小写裸值，arXiv 是不带 revision 的基础 ID，PMID/PMCID 及其它已支持 namespace 使用各自官方形式。一个父对象内以 canonical pair 去重并用 ordinal 保持首次顺序；跨 Literature 的查找使用普通索引，但 Storage 不用全局唯一约束替代 Literature 的命中、冲突和身份整理决定。OpenAlex Work ID、Web of Science UID、Semantic Scholar Paper ID、Scopus EID 等 Provider record identity 只能出现在 `provenances.source_record_id` 或相应 key/endpoint 的 `record_id` 列，不能复制到 identifier 子表或建立混用索引。

供应商结构化引用与权威引用使用：

| 表组 | 保存内容与关键约束 |
|---|---|
| `provider_relation_observations` | ObservationId 与 provenance；一行一条有向边，不保存扩展状态 |
| `provider_relation_endpoints`、`provider_relation_endpoint_identifiers` | 每条边固定 `citing`/`cited` 两个端点的 record_id 与 identifiers |
| `literature_references` | ReferenceId、source LiteratureId、target LiteratureId；source != target，source/target pair 唯一 |
| `provider_relation_reference_supports` | Reference 到 ProviderRelationObservation 的 support |
| `metadata_reference_text_supports` | Reference 到 `(metadata_observation_id, reference_index)` 的 support |
| `content_reference_text_supports` | Reference 到 `(literature_content_sha256, reference_index)` 的 support |

每条 Reference 至少有一项有效 support；support 不复制原文、evidence、目标 metadata 或 provenance。临时 `ReferenceLookup`、供应商目标 ID 占位和未解析 Reference 不建表。权威引用默认使用 FK `RESTRICT`：在未来明确设计文献删除语义之前，不通过级联悄悄删除有效 Reference 或 support。

MetaLiterature 成员关系只由 `literatures.meta_literature_id` 保存；不建立成员关联表、Meta 状态、`LiteratureRelationObservation` 或 `LiteratureRelation`。Meta “已有一个可用版本”通过成员 current facts 查询推导。

### 2.4 Asset、ParserResult 与 LiteratureContent

| 表组 | 保存内容与关键约束 |
|---|---|
| `assets` | AssetId 到一个 `artifact_objects` PDF 字节对象的一对一关系；公开 Asset 视图通过 join 得到 hash、size、media type 和 path |
| `literature_assets` | LiteratureAssetId、LiteratureId、AssetId、role、provenance FK 和可选脱敏 source_url |
| `parser_results` | 每个 source AssetId 最多一个当前 ParserResult，保存 source/result hash、page count、Markdown artifact FK、parser provenance/version/mode/model identity |
| `parser_result_resources` | 当前 ParserResult 实际引用资源的 reference、ordinal 和 artifact FK |
| `literature_contents` | 每个 Literature 最多一个当前 content；保存 content hash、metadata revision/hash、结构化 content artifact FK、规范 Markdown artifact FK、当前主 PDF/ParserResult 输入绑定和单一 Analysis provenance FK |
| `literature_content_reference_texts` | 当前 content 的有序参考文献文本投影，用于 support FK、详情读取和独立引用原文读取；不进入普通全文检索 |
| `literature_search_fts` | 从当前 metadata、作者/单位/标识符和当前 LiteratureContent 正文章节的允许字段重建的 FTS5 投影；不索引来源 observation 或参考文献原文 |

同一 Literature 最多存在一个 `role = "primary-pdf"` 的 `literature_assets` 行；这项唯一关系就是当前主 PDF，不另设 current pointer 或 `is_current`。`Asset` 不混入 Literature、role、version 或 provenance，`LiteratureAsset` 不复制 Literature.version_role。手动接纳与自动获取使用同一表；手动关系的 provenance 为 user/manual-pdf、`source_url` 为空，输入绝对路径不保存。

每个 Asset 的 `parser_results` 当前行和每个 Literature 的 `literature_contents` 当前行都可原子替换但不保留历史。结构化 LiteratureContent 与规范 Markdown 的完整字节进入 ArtifactStore；SQLite 不为每个 `LiteratureSection`、subsection 或正文 Markdown 建表，只保存 current binding、hash、参考文献投影和 FTS。这样既保持文档原子性，也避免把大段 Markdown 塞进 SQLite。

### 2.5 自动 PDF 获取耗尽

Catalog 只为会改变未来自动目标选择的稳定缺失保存一张最小关系表：

| 表 | 保存内容与关键约束 |
|---|---|
| `automatic_pdf_acquisition_exhaustions` | `literature_id` 同时是主键和指向 `literatures` 的外键；只表示该具体 Literature 已正常耗尽当前自动 PDF 获取路径 |

该表没有 reason、Provider、candidate、configuration hash、created/updated time、attempt count 或 status。它不改变 LiteratureStatus；read model 只通过该行投影 `needs_manual_pdf = true`。只有 Acquisition 已正常遍历全部当前自动路径时才能插入，提交成功后才允许返回 `NoPrimaryPdf`。接纳任意新 MetadataObservation、自动或手动主 PDF 成功，或用户明确重试时删除。用户中断、Network/API/权限/配置错误、Storage 错误、Parser/LLM 失败和无法判断不能插入。

### 2.6 有意保存与有意推导

数据库可以用空间换取高成本、稳定且可核对的读取结果：metadata/content hash、FTS 和自动 PDF 获取耗尽事实可以保存。以下低成本值不作为独立事实保存：

- LiteratureStatus 与 MetaLiterature “至少一个可用版本”；
- 当前主 PDF pointer；
- artifact reference count；
- Discovery result count 等简单聚合；
- observation 内容 hash `observation_sha256`。

这些值通过唯一关系、SQL view 或查询聚合推导。若未来性能证据要求物化，只能建立可重建投影并保持一个权威来源，不能新增可独立修改的状态。

`LiteratureSearchItem`、`LibrarySearchPage`、`LiteratureAssetView`、`LiteratureDetail`、`LiteratureReferencePage` 和 `ReferenceDetail` 都在查询时由上述权威行、唯一关系、聚合值和稳定 artifact 引用临时组装。Catalog 不建立 search item、page、detail、asset view、missing step、引用数量、关系读取 DTO 或其它投影表；这些对象没有独立 ID、provenance、revision 或写入操作。`LiteratureDetail` 必须在同一个 read-only SQLite snapshot 中读取 Literature/MetaLiterature、metadata binding、observations、资产关系、当前 ParserResult/Content、其它版本与 Reference 数量，再使用已经提交的不可变 artifact 引用读取需要的结构化内容，不能把不同时间点的 current facts 拼成一个结果。

`LiteratureReferencePage` 在同一 snapshot 中读取指定端点的权威 Reference、相关 Literature current facts 和每条边的 support count；`ReferenceDetail` 在同一 snapshot 中读取 Reference 两端和全部当前 support。正向和反向列表都查询 `literature_references`，不能物化 cited-by 副本。关系页面的固定排序、total 和 cursor 位置必须来自同一读取视图；后续页面可以看到后续提交的 current facts，但单页内部不能混合提交前后状态。

### 2.7 不持久化的查询投影、运行现场与报告

以下内容不进入 SQLite、ArtifactStore 或 Storage 拥有的其它状态文件：

- Network permit、等待队列、冷却、窗口计数、`Retry-After`、`next_allowed_at` 和 `blocked_until`；
- Provider/LLM/MinerU 凭据、凭据字段状态、readiness、`config test` 结果/时间和服务健康状态；secret 只由 Configuration 管理在唯一用户级凭据文件中，不属于逻辑文献数据库；
- HTTP/浏览器现场、Provider cursor、request/response 和 vendor SDK object；
- 搜索候选、相关度、原始扫描/接纳/拒绝计数、分页中间状态和未接纳结果；
- `PdfCandidate`、candidate key/tried set、下载 attempt、逐候选失败、无效 PDF 及其信息；
- Parser task、私有 JSON/TEI/block/bbox、未引用资源、失败结果和历史结果；
- LLM prompt/request/response、第一阶段 metadata proposal、第二阶段 Markdown 草稿、临时 `ReferenceLookup` 和两次调用的独立 provenance；
- BatchRequest/BatchSelector、冻结目标、MetaLiterature 候选顺序、逐目标普通失败、运行统计、Report 和日志；
- LibraryQuery/LibrarySearchRequest/LiteratureReferenceRequest 的调用现场、cursor、SearchItem/SearchPage、LiteratureAssetView、LiteratureDetail、LiteratureReferenceItem/Page 和 ReferenceDetail 查询投影；
- 旧统一 metadata、旧 ParserResult、旧 LiteratureContent 历史；
- 用户本地 PDF 的绝对路径和原文件；
- SQLite 大型 BLOB、原始书目导入文件、外部导入对象/记录 ID、导入批次历史和导出文件。

其中需要向用户呈现的稳定脱敏 failure 进入本次 Report；日志可以旁路输出安全诊断，但不能替代 Report。failure 不建立 Catalog current-failure 投影，不能恢复外部现场或决定 Literature 状态。自动 PDF 获取耗尽不保存失败内容，它只是影响下次自动选择的当前事实。

## 3. 文件责任

文件存储保存：

- 通过基本检查的当前主 PDF，包括自动获取字节和手动文件的内部副本；
- 补充资产；
- 每个输入 Asset 当前 ParserResult 的规范化 Markdown 与实际引用资源；
- 结构化 `LiteratureContent` 的规范序列化；
- 从同一已验收 metadata/content 确定性渲染的规范 Markdown。

文件使用内容寻址和 create-if-absent 发布。已接受对象不得原地覆盖；相同目标存在相同字节时复用，存在不同字节时保留冲突证据并拒绝发布。

Storage 不根据文件内容自行决定它是否属于某篇文献。消费模块先形成经过规则确认的发布请求，Storage 再执行物理保存。

Catalog、ArtifactStore、写锁和面向用户的输出属于普通本地数据，不以 Unix owner、mode 或 sticky bit 作为准入条件。已有目录或文件只要当前进程能实际访问即可；组可写或全局可写祖先、Catalog、资产对象和输出目标不会仅因权限位被拒绝。新建目录和文件可以使用 `0700`、`0600` 作为保守默认值，但再次打开时不要求保持这些权限。Storage 仍以 descriptor-relative、nofollow、对象类型、单硬链接、inode 身份、hash、size 和原子发布检查防止路径逃逸、对象错配与半成品。凭据文件不属于 Storage，继续由 Configuration 的独立 secret 权限合同管理。

Storage 还实现 Literature 拥有的 artifact read Port。输入只接受已经从查询投影取得的 `Asset`、`ParserArtifactRef` 或 `ArtifactRef`；实现必须在配置的 ArtifactStore 根下解析规范路径或内容地址，拒绝绝对路径、父目录跳转、符号链接逃逸和非普通文件，并在返回 context-managed 只读 binary stream 前复核 byte size、SHA-256 与 Catalog 中的 media type。读取不改变访问时间以外的文件系统实现细节，不建立数据库事实，也不把解析后的绝对路径返回调用方。

导出到用户选择的文件不把目标纳入 ArtifactStore。Entry 使用 verified reader，在目标同目录完成 owner-only staging、flush、`fsync`、size/hash 复核和原子发布；目标存在时默认拒绝，明确覆盖也只能原子替换。失败清理 staging 并保持已有目标不变；用户目标路径、导出副本和导出成功标记都不进入 Catalog、ArtifactStore、provenance 或 Report。

用户手动提供的原文件从不成为 ArtifactStore 对象。Acquisition 复制到 owner-only staging 后，Storage 只接收内部副本及其 hash；输入绝对路径不进入文件名、相对路径、provenance、Catalog、对账或清理。后续内容无效清理只能删除内部对象。

文献内容处理链中，来源 observation、当前权威 metadata 和原始 PDF 是优先长期可靠保存的事实；ParserResult、Parser Markdown/资源、当前 LiteratureContent、规范总结 Markdown 以及基于当前内容的 support 是可重建派生产物。派生产物仍使用 hash、轻量 provenance、完整当前关系和原子发布防止错配或半成品，但不维护数据库历史；派生产物损坏、清理或丢失不能破坏 metadata 和 PDF。本轮只同步该跨模块合同，不据此新增物理目录、备份、缓存配额、清理周期或恢复算法；已有 ADR 0010 ParserResult 当前结果与缓存边界保持有效，其余细节留待 Storage 模块后续讨论。

ParserResult 是当前可替换中间结果，不是不可变产品历史。Storage 仍以内容寻址和 create-if-absent 发布每一份新字节，但 Catalog 对同一输入 Asset 只保留一项当前 ParserResult 关系。成功切换后旧关系删除，旧字节进入与正式对象区隔离的本地缓存；缓存不进入 Catalog、不参与查询或状态，并可按统一预算回收。新结果提交失败时旧关系和旧字节保持完整。

LiteratureContent 使用相同的“不可变字节、可替换当前关系”语义：每个 Literature 只保存一个当前 content，只有新结果完整发布并经 Literature 接纳后才切换；失败保留旧当前结果，旧结构化内容与 Markdown 不进入 Catalog 历史。这里不进一步规定缓存物理实现。

## 4. SQLite 连接策略

所有连接统一启用：

- `PRAGMA foreign_keys = ON`；
- WAL journal mode；
- 权威写入使用 `synchronous = FULL`；
- 有界 `busy_timeout`；
- UTC 时间；
- 对已经明确采用 canonical artifact serialization 的内容执行确定性序列化；不因此启用通用 SQLite JSON fallback；
- 查询和导出使用 read-only/query-only snapshot；一次 SearchPage、LiteratureDetail、LiteratureReferencePage 或 ReferenceDetail 的全部 current facts 来自同一 snapshot；
- 一个事务只覆盖一次明确业务提交。

网络、浏览器、parser、LLM 和文件 staging 都发生在 SQLite 事务外。

## 5. 整体事务

以下逻辑更新分别需要在一个 SQLite 事务中整体成功：

1. DiscoveryRun 创建时的 run、类型化输入、Provider 顺序与各自在整个 Run 内的 scan_limit；
2. 已完成中性转换的 `ProviderRelationObservation` 按最多 256 条的冻结批次发布；每条仍是独立、
   幂等的不可变来源事实，一个批次在同一短事务内整体成功或回滚，先前已提交批次不被后续
   失败撤销；
3. 新的不可变 metadata observation、到 Literature 的归属、身份结果、当前统一初始元数据替换、DiscoveryResult 与直接 cause，以及对应 Literature 自动 PDF 获取耗尽事实的清除；既有 observation 不更新，旧统一元数据不插入历史；
4. 单个 Discovery source result 或最终 run status；完成后输入和已确认结果不可修改，且不写入过程 counts；
5. 来源和目标 Literature 都已接纳后的权威 Reference 与第一项 ReferenceSupport 整体幂等发布，以及既有 Reference 的后续 support 幂等追加；
6. Acquisition 正常遍历全部当前自动路径后，为具体 Literature 幂等建立自动获取耗尽事实；提交成功后才能返回 `NoPrimaryPdf`，临时或系统失败不能调用该 publication；
7. 导入记录形成的不可变 user/bibliographic-import MetadataObservation、身份接纳、当前统一初始元数据更新和已有自动 PDF 获取耗尽事实清除；首次匹配 Provider 值的 user observation 仍插入，只有相同规范化 user observation 已存在的完全重复 matched 才复用既有行；`CONTENT_READY` 时只保存新 observation 而不拆开替换当前 metadata/content；原始导入文件、外部工具身份、导入批次和本次运行报告不进入事务；
8. 自动或手动主 Asset 文件事实、唯一 `primary-pdf` LiteratureAsset 关系与已有自动获取耗尽事实清除；手动输入绝对路径不进入行；
9. 用户明确重试自动 PDF 获取前，删除对应 Literature 的自动获取耗尽事实；
10. 新 ParserResult 的当前关系新增或替换与旧当前关系解除；Catalog 不插入旧结果历史；
11. Literature 接纳的最终 current metadata、递增后的 metadata revision、keywords、当前结构化 `LiteratureContent`、规范 Markdown 关系、内容/Markdown hash、metadata/PDF/ParserResult 输入绑定和单一 Analysis provenance；替换时不保留旧统一元数据，并同步删除旧 `ContentReferenceTextSupport` 及因此失去全部 support 的 Reference；第一阶段 metadata 提案不得单独提交或转成 observation；
12. 第一阶段 Analysis 明确返回 `NoUsableContent` 时，当前 `primary-pdf` 关系和对应 ParserResult/待验收结果删除，并在 Asset 没有其它关系时回收内部字节；Parser/Analysis 失败或无法判断不能进入本事务。用户原文件、无效候选和决定不长期保存，原始 MetadataObservation/AssetHint 不附加失败标记；
13. 身份合并或版本整理涉及的 observation 归属、DiscoveryResult/cause、自动获取耗尽归属和引用关系转移；
14. 在 Reference 默认 FK `RESTRICT` 边界内，已经由 Literature 明确形成的删除或整理决定所涉及的全部关系变化。

事务适配器只能持久化调用方传入的已确认 Model 决定，不能在 SQL 分支中形成新业务规则。内容接纳前重新检查预期 Literature、初始 metadata revision/hash 和当前主资产 ID/hash；其它提交复检各自预期输入，拒绝 stale 结果。

## 6. 不可变文件发布

SQLite 与文件系统没有跨介质事务，因此统一采用：

1. 在 owner-only 临时目录写入产物；
2. flush、`fsync` 并验证大小、格式和 SHA-256；
3. 使用 create-if-absent 发布到内容寻址相对路径；
4. 目标已存在时验证字节完全一致；
5. `fsync` 目标目录；
6. 开启短 SQLite 写事务并复检输入 ID/hash；
7. 建立文件关系；主 PDF 只建立唯一 `primary-pdf` 关系，ParserResult 对输入 Asset 只建立一个可替换当前关系，每个 Literature 的内容产物只建立一个可替换当前关系和完成依据；
8. 更新读取 view 与 FTS 后提交。

SQLite commit 前崩溃最多留下无引用孤儿，不能产生指向缺失文件的有效数据库关系。

ParserResult 替换提交后，旧正式对象在确认没有其它引用时才能移动到缓存。移动或缓存清理失败不能回滚已经提交的新当前关系，也不能误删仍被当前 ParserResult、其它资源引用或活动 Analysis 固定 hash 使用的字节；活动读取通过本次 artifact hash 固定对象，不跟随中途变化的当前指针。

## 7. 写入准入与并发

一个主机、一个 canonical catalog path 对应一个核心写 advisory lock。领域/引用 DiscoveryRun、数据库补全操作、手动 PDF、书目导入、身份整理、删除和文件对账在形成实际写入前必须非阻塞获得同一个独占锁；冲突立即返回稳定结果，不排队等待。

锁由平台适配的 OS advisory lock 实现，进程退出或崩溃时由操作系统释放。锁可以覆盖一次完整写执行，但 SQLite 事务始终保持短小。查询和只读导出使用已提交 snapshot，不获得核心写锁。

执行内部即使并行等待不同目标的外部调用，SQLite commit 仍通过一个进程内提交队列串行完成。

## 8. 对账与崩溃恢复

对账必须在获得同一核心写锁后运行，并遵守：

- 只处理正式对象区中的无数据库引用对象；
- 不接触活动 staging；
- 缓存区不解释为数据库历史，并按独立预算回收；
- 不删除仍被其它关系引用的相同字节；
- 不把孤立文件、FTS 或执行记录当作文献状态依据；
- 发现缺失文件、hash 冲突或非法相对路径时保留证据并 fail closed。

进程崩溃后，持久化 DiscoveryRun 的遗留 `RUNNING` 收尾由 `entry` 解释；Storage 只提供 DiscoveryRun 和当前文献事实的事务一致读取与更新。数据库补全没有持久化运行、冻结目标、目标开始标记或 Report 需要收尾，重跑重新展开运行时 selector。

下一次运行和恢复以 Catalog 与 ArtifactStore 中已经完整提交的 current facts 为依据。Staging、下载候选、外部 task、临时响应、Parser/LLM 草稿、内存队列和缓存不是另一套可恢复业务现场；除其它 Accepted 设计明确要求的中性事实外，Storage 不保存它们。

## 9. 验收

直接测试至少证明：

- 核心 scalar 使用普通列、重复结构使用有序子表、关系使用 FK/unique table、大型内容使用 ArtifactStore；不存在通用 Pydantic JSON dump、`extra`、`details`、selected IDs JSON 或 SQL query blob fallback；
- `schema_identity`、`artifact_objects` 和 `provenances` 的唯一性、相对路径、hash/size/media type 约束成立，业务 Model 可以由关系行确定性重建；
- identifier 子表按父对象内 canonical `(namespace, value)` 去重并保持 ordinal，DOI/arXiv/PMID/PMCID 可确定重建；跨 Literature 只有查找索引而没有越过 Literature 规则的全局唯一决定；Provider record ID 不进入 identifier 子表或混用索引；
- LibraryQuery 只读取允许的当前权威字段；普通全文检索不命中 MetadataObservation、参考文献原文、URL/provenance、运行记录、日志、失败或文件路径，也不把用户文本作为裸 SQL/FTS 执行；
- SearchItem/SearchPage、LiteratureAssetView、LiteratureDetail、LiteratureReferencePage 和 ReferenceDetail 只从同一 read-only snapshot 临时组装，没有对应持久化表、ID、provenance、revision 或写入 API；搜索以具体 Literature 为结果单位，不按 MetaLiterature 折叠；
- LiteratureDetail 中 metadata revision/hash、status、missing step、人工 PDF 标记、唯一 primary PDF、当前 ParserResult/Content 和其它版本相互一致；本地 Reference 正反向数量来自具有有效 support 的权威边，不与 Provider count observation 合并；
- references/cited-by 页面从同一 `literature_references` 表正反向读取，在一个 snapshot 中组装相关 Literature、support count、固定排序、total 和 cursor；ReferenceDetail 返回同一关系两端与全部有效 support，不保存 cited-by 副本或关系 DTO；
- Artifact reader 只接受既有 Asset/ArtifactRef，在 ArtifactStore 根内拒绝路径逃逸、符号链接逃逸和非普通文件，并在交出 context-managed stream 前验证 size、hash 和 media type；调用方不能取得内部绝对路径；普通数据路径的 owner、mode 与 sticky bit 不构成准入条件；
- 面向用户文件的 artifact 导出使用同目录 staging、flush、`fsync`、校验和原子发布，默认拒绝已有目标，失败保持旧目标不变；目标路径、副本和结果不进入数据库或处理 Report；
- Topic/Citation DiscoveryRun 使用互斥类型化输入；每个 Provider 保存整个 Run 的独立 scan limit 和三值 source outcome，已接纳结果与直接 cause 可查询，cursor/request/response/score/过程计数/完整 path/未接纳候选不能入库；
- DiscoveryRun 本体没有 finished_at、CREATED 或 NO_TARGET；零结果正常完成，用户中断保留已确认 source/result/cause，未完成 Provider 不生成 source result；
- Topic cause 指向实际 MetadataObservation；Citation cause 保存不同的 source/target Literature 与正 depth，不以 ReferenceId 为长期外键，当前 Reference 后续删除不破坏历史 cause；
- Catalog 不建立 Collection、membership、membership cause 或 Collection selector 表；
- Catalog 不存在 BatchRun、BatchTarget、scope、候选 snapshot、target result/failure、current failure、Report 或 counts 表；运行时 selector、目标和候选不能通过 JSON 或其它兜底形式入库；
- `automatic_pdf_acquisition_exhaustions` 只以 LiteratureId 为主键/外键，不保存原因、Provider、候选、配置 hash、时间、次数或状态；read model 正确投影 `needs_manual_pdf`，但三级 LiteratureStatus 不受该行改变；
- 只有全部当前自动路径正常耗尽才能建立该行；新 MetadataObservation、自动或手动主 PDF 成功、明确重试都原子清除，Network/API/权限/配置/Storage 错误和中断不能建立；
- Schema 拒绝同一 Literature 多个 `primary-pdf` 关系、多个当前 LiteratureContent、跨 Literature 内容关系，以及缺少最终 metadata、content、Markdown hash 或 Analysis provenance 组成项的 `CONTENT_READY` 事实；主 PDF 不存在 `is_current` 或平行当前指针；
- Asset 只保存不可变文件字段，LiteratureAsset 只保存文献关系、角色、脱敏来源和 provenance，不复制 Literature version role；共享 Asset 不复制文件字节；
- 手动 PDF 只保存内部副本对应的 Asset 和 user/manual-pdf LiteratureAsset，source_url 为空；用户绝对路径和原文件不能进入 Catalog/ArtifactStore，对账或 NoUsableContent 清理不能触及原文件；
- `PdfCandidate`、candidate key、逐候选失败和 `NoPrimaryPdf` 原因不进入 catalog；自动获取耗尽行不反向扩展成 Acquisition 原因分类；
- 主 PDF 的文件发布或关系提交失败时只能观察完整旧状态或完整新状态，并向上返回系统错误，不能形成 `NoPrimaryPdf` 或已获得业务结果；
- ParserResult 首次发布或替换在每个文件 staging、create-if-absent、stale 复检和 SQLite 提交失败点都只能观察完整旧结果或完整新结果；失败保留旧当前关系，成功后 Catalog 不保留旧结果历史；
- ParserResult 的 Markdown 和每个实际引用资源均通过 hash、媒体类型和大小读取；未引用资源、Parser 私有 JSON/TEI、task 和过程文件不进入 Catalog；
- 三级状态 SQL view 与 `literature` 的纯规则共享同一 truth table；
- DiscoveryRun、自动获取耗尽、普通 failure、attempt、Report、FTS 和孤立文件变化不改变文献状态；MetaLiterature 可用版本、当前主 PDF pointer 和 refcount 都由关系推导；
- `ReferenceLookup`、供应商目标 ID 和未解析目标不能进入引用表；Reference 只有三个 ID 字段，source/target 都引用不同的具体 Literature，且相同 source/target 只有一条关系；
- `ProviderRelationObservation` 可以在没有目标 Literature、Reference 或 support 时独立保存，一条只表达一条有向边且不携带扩展状态；大量 relation 以最多 256 条的有界短事务批次提交，批内失败完整回滚、批间保留已确认事实，重复批次保持幂等且 FK、端点 identifier 与 provenance 完整；
- `MetadataObservation.version_links` 中每个目标 key 至少有非空供应商记录 ID 或稳定 Identifier；未解析目标只保留来源 observation，不形成占位 Literature、MetaLiterature 归属或独立关系行；
- 正式记录的相关 arXiv ID 保存在 canonical version-link identifier 中，不同时复制为该正式 Literature 的 identifier；arXiv revision 不产生额外 Literature 或 revision 列；
- 同一 Literature 可以关联多个不可变 MetadataObservation；新增观察不更新旧 observation，每个 Literature 只有一个当前 LiteratureMetadata，metadata revision 递增但不产生历史元数据行；
- 同一文献不同版本的权威结果只由 `Literature.meta_literature_id` 和 `version_role` 表达，不存在 `LiteratureRelationObservation`、`LiteratureRelation` 或第二份版本成员事实；
- 一个响应返回多条边时分别保存 observation；只有当前扩展范围选中的目标才继续物化，普通 metadata 响应中的关系不会自行触发递归；
- 每条 Reference 至少有一项 ReferenceSupport；结构化关系 observation 的方向必须与 Reference 一致，两个文本 support 只能指向引用方拥有的有效来源位置，相同 `(reference_id, source)` 不能重复；
- 增加第二项 support 不创建平行 Reference，support 不生成独立业务 ID，也不重复保存来源内容；
- Reference publication 失败不回滚已经接纳的目标 Literature、来源原文或 `LiteratureContent`；
- 内容接纳只允许完整旧视图或完整的新最终 metadata/keywords/Markdown-string sections/references/Markdown 视图，不存在独立分析或标签关系；成功替换同时删除旧 content support 和因此无 support 的 Reference，失败保留旧内容与 support；
- 当前 LiteratureContent 与 ParserResult 不保存数据库历史，并可在不破坏来源元数据与原始 PDF 的前提下重建；本轮不据此引入新的物理目录、备份、缓存配额、清理周期或恢复算法；
- 无效 PDF 清理移除当前 LiteratureAsset、无效获取 provenance 和无引用 Asset，不留下 candidate/decision；运行时 tried set 不进入 SQLite，原始 MetadataObservation/AssetHint 不被改写为失败记录；
- 每个跨事实事务写入点失败时，只能观察完整旧视图或完整新视图；
- 文件 staging、发布和 SQLite commit 各崩溃点都保持已提交引用可读且 hash 一致；
- 对账不能在 publication-before-reference 窗口删除对象；
- 身份整理和删除不暴露部分关系转移；
- 共享文件仍被引用时不能回收；
- Catalog 只保存规范化相对路径，不保存大型 BLOB 或机器相关绝对路径。
- Network 动态准入、Provider 凭据/readiness/config test 状态、Provider cursor、PdfCandidate/tried set、Parser/LLM 私有现场、BatchSelector/目标/候选、Report/日志、旧派生结果历史、原始导入文件和导出文件均不进入 Catalog 或 ArtifactStore；普通稳定脱敏 failure 只进入当前 Report 且不能恢复现场。
