# 07 · 版本化材料与知识存储技术设计

[设计总览](../design.md) · [八模块技术导航](../technical.md)

本模块对应设计中的 **⑦ 版本化材料与知识存储**，保存业务模块确认的结构化事实和不可变字节，并提供一致读取、发布、完整性校验与受控恢复。

内部包括 SQLite Catalog、ArtifactStore、写入准入、事务/文件发布以及版本依赖保护。③④⑤决定事实含义和是否接纳；⑦执行已确认决定。②的执行记录与业务事实分别保存，⑥只读已有提交。

Catalog v6 已为单篇知识产物增加独立表与精确依赖；Catalog v7 允许版本化集合综合产物，Catalog v8 append 独立知识检索投影。正式 operator 可用本篇 §4.1.11 的精确目标 CLI 显式初始化或升级；历史单步合成门禁保留。execution 子 schema 仍单独计版本。本篇保留现有表、文件和兼容语义；文档不授权代理执行真实用户数据迁移。

> 2026-10-20：[ADR 0037](../decisions/0037-literature-archive-and-proofread-text.md)（Accepted，2026-10-20）将新增原始解析、校订、结构注释、元数据字段状态、标签词表、建档状态、快照与结果新鲜度等存储。目标形态见[§6](#6-adr-0037-新增存储实施中)，实施见[文献建档计划](../../plans/2026-10-20-literature-archive/README.md)。实施完成前，下文仍描述现行合同与实现。

本篇目录：

- [1. 模块边界与连接](#1-模块边界与连接)
- [2. Catalog 与文件组织](#2-catalog-与文件组织)
- [3. 事务、发布、并发与恢复](#3-事务发布并发与恢复)
- [4. 知识版本、依赖与回收](#4-知识版本依赖与回收)
- [5. 存储完整性验证](#5-存储完整性验证)
- [6. ADR 0037 新增存储（实施中）](#6-adr-0037-新增存储实施中)

## 1. 模块边界与连接

业务模块③④⑤和执行模块②提交已确认决定；本模块保存字节和关系并提供受控读取。

本篇按职责归并已有详细合同；示例中的现有类型与目标类型保持各自状态。文档归属不改变源码目录、事实所有权或当前公开 API。

## 2. Catalog 与文件组织

### 2.1 知识证据生命周期的目标变化

按 [ADR 0026](../decisions/0026-agent-knowledge-and-human-collaboration.md)，统一 Catalog/ArtifactStore 承载业务 owner 已确认的文档表示、证据依赖和不同用途知识产物；索引可重建，不成为第二事实库。单篇知识已有 v6 schema，集合综合在 v7 的精确依赖、比较域及不可变发布已接通；物理回收策略仍待设计，不能据文档直接操作用户数据。

当前单一 ParserResult/Content 与回收表结构是兼容实现，不授权新架构静默回收被有效产物引用的表示。材料失效/删除由独立业务决定驱动，分析不适用不能直接产生删除命令。人类控制与指导状态不默认持久化为文献事实或完整录像。

按 [ADR 0027](../decisions/0027-extraction-capabilities-and-caller-defined-records.md)，候选记录可按独立提取产物合同交付或托管；Extraction 只接纳通用协议，领域含义归调用方。当前 v5 仅存规范、operation、回执和输入保护 pin，不托管候选 payload；容量、保留和合成迁移见本篇 §4.1.7。不能添加任意 Literature JSON 字段来替代所有权设计，也不能将候选当权威科学事实。

### 2.2 结构与实现映射

当前活动实现位于 `apps/server/src/storage/`，跨模块合同来自 `packages/contracts`：

```text
apps/server/src/storage/
  artifact-layout.ts       # 新产物的分类路径、hash 分桶与扩展名
  locking.ts
  write-admission.ts
  sqlite/worker.ts          # typed IPC client 与 worker 装载
  sqlite/worker-runtime.ts  # strict TypeScript worker 命令、schema 与查询实现
  sqlite/schema.ts          # 核心业务 schema 与 fingerprint
  sqlite/schema-v2.ts       # v2 兼容与升级边界
  sqlite/execution-schema.ts # candidate/receipt、execution runtime 子 schema
  sqlite/repositories.ts   # 关系与业务合同映射
  execution/repository.ts  # Jobs/targets/attempts/budgets/leases
  execution/migration-gate.ts # 显式迁移前置检查
  files/store.ts           # ArtifactStore
  files/staging.ts         # 本次操作 staging
  files/publication.ts     # 不可变发布
  files/reader.ts          # 校验读取
  files/reclamation.ts     # 回收适配
  files/recovery.ts        # 发布恢复
```

上述文件是当前 TS 路径。SQL binding、最终文件创建、对账和回收必须继续留在 Storage 边界内，不得让其它业务模块直接依赖内部表。

当前 SQLite worker 业务实现位于受 strict TypeScript 检查的 `worker-runtime.ts`；源码运行通过 Node 22
`--experimental-strip-types` 装载 `.ts`，build/portable 运行装载同目录 `.js`。`worker.ts` 只保留
typed `SqliteCommand` IPC client、生命周期和入口选择，不再以 `String.raw` 内嵌一份未检查的 worker
程序。portable 包必须携带构建后的 `worker-runtime.js`，安装后 CLI smoke 会实际启动 worker 并执行
本地 `literature search --json`。

### 2.3 SQLite 责任

SQLite 使用关系 schema 保存需要约束、连接、去重和高频查询的结构化事实。`packages/contracts` 的 TypeScript 合同负责模块交换，不意味着把整个对象统一序列化成一个 JSON 列：

- 字符串、整数、布尔、时间、枚举、ID 和 hash 使用普通列；
- 有序作者、单位、标识符、关键词、资产线索、版本 key 和其它重复结构使用带 ordinal 或自然键的子表；
- 外键、唯一性、当前关系和支持关系使用明确关联表；
- PDF、Parser Markdown/资源、结构化 LiteratureContent 和规范 Markdown 的完整字节进入 ArtifactStore，SQLite 只保存 artifact identity、hash、大小、媒体类型和关系；
- 只有某项业务语义本身是无需字段查询与关系约束的封闭树，并且已经单独获批时才可使用 canonical JSON。核心文献 schema 不提供通用 JSON、`extra`、`details` 或“完整合同 dump”兜底。现有 execution 子 schema 对封闭运行合同使用经过 parser 校验的 JSON，见 [已有执行持久化](#238-已有执行持久化)；这不是向业务核心开放任意 payload 字段。

Repository 负责在这些关系行和公开 TypeScript contract/read projection 之间组装；SQL row 不是第二套业务 Model。

显式 Literature/MetaLiterature selector 通过 `library_snapshot` 的 ID 参数在同一 read-only transaction
内定向读取，不先加载全库；Literature 的 authors、affiliations、identifiers 和 keywords 按本次 ID
集合批量加载。查询仍由 Literature 层完成状态、hash、版本与 integrity 校验，Storage 不因减少 IPC
或 SQL 往返而接管业务决定。普通 FTS/分页合同保持不变。

#### 2.3.1 共享表

| 表                 | 保存内容与关键约束                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `schema_identity`  | 单行 schema version、manifest fingerprint 和创建/升级时间；不保存业务对象                                  |
| `artifact_objects` | artifact identity、SHA-256、byte size、media type、规范化相对路径；`sha256 + byte_size` 与路径保持唯一一致 |
| `provenances`      | 公共 Provenance 的七个普通字段；不保存凭据、绝对路径、原始响应或异常正文                                   |

只有持久化业务合同明确拥有的稳定失败才进入对应关系行，例如失败的 Discovery source result；不建立能够与业务对象脱离的通用 failure blob，也不为普通补全、Network、Parser 或 LLM 失败建立 current failure 表。

#### 2.3.2 DiscoveryRun

外部发现使用以下表组：

| 表组                                                    | 保存内容与关键约束                                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `discovery_runs`                                        | run ID、`topic`/`citation` kind、status 和开始时间；创建即 `RUNNING`，终态后不可修改                       |
| `topic_discovery_inputs`                                | 每个 topic run 唯一的 query、year_from、year_to 普通列                                                     |
| `citation_discovery_inputs`、`citation_discovery_seeds` | 每个 citation run 唯一的方向、max_depth、result_limit，以及按 ordinal 保存的具体 seed LiteratureId         |
| `discovery_run_providers`                               | run 内 Provider ordinal、稳定名称和整个 Run 的 scan_limit；同一 Provider 每 run 唯一                       |
| `discovery_source_results`                              | 每个 run/provider 唯一的 `EXHAUSTED`、`SCAN_LIMIT_REACHED` 或 `FAILED`，以及仅失败时存在的稳定脱敏 failure |
| `discovery_results`                                     | `(discovery_run_id, meta_literature_id)` 唯一的已接纳结果                                                  |
| `topic_discovery_causes`                                | 结果与实际 `MetadataObservation` 的类型化来源关联                                                          |
| `citation_discovery_causes`                             | 结果与本次发现时实际 source/target Literature、正 depth 的历史原因；不以 ReferenceId 为长期外键            |

`DiscoveryRun` 不保存 `finished_at`、`CREATED` 或 `NO_TARGET`。零结果可以 `COMPLETED`；用户提前停止或恢复时发现遗留 `RUNNING` 后转为 `INTERRUPTED`。中断时已经完成的 source result 和已接纳 result/cause 保留，未完成 Provider 不生成 source result。Topic cause 指向长期不可变 observation；citation cause 是不可变运行历史，即使以后当前 Reference 因失去全部 support 被删除也继续存在，但它本身不是 ReferenceSupport。

当前产品不建立 Collection、membership、membership cause 或 Collection selector 表。Provider cursor、请求/响应、搜索候选、相关度、原始扫描/接纳/拒绝计数、分页现场、完整 DiscoveryPath 和未接纳结果不进入上述表。一个本地只读查询也不创建 discovery row。

#### 2.3.3 Literature、MetadataObservation 与引用

主体和当前统一元数据使用：

| 表组                                                                     | 保存内容与关键约束                                                                                                                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta_literatures`                                                       | MetaLiteratureId 和必须指向自身成员的 representative LiteratureId；不保存成员列表或状态                                                                                    |
| `literatures`                                                            | LiteratureId、唯一 meta_literature_id 归属和 version_role                                                                                                                  |
| `literature_metadata`                                                    | 每个 Literature 唯一当前行、metadata revision/hash 及 title、abstract、publication date/year、document type、language、venue、publisher、volume、issue、pages 等普通标量列 |
| `literature_metadata_authors`、`literature_metadata_author_affiliations` | 当前作者与单位按 ordinal 关系化保存                                                                                                                                        |
| `literature_metadata_identifiers`、`literature_metadata_keywords`        | 当前标识符与 LLM 最终关键词；自然键去重并保持 ordinal                                                                                                                      |

来源 observations 完整长期保存，但使用同样的关系化映射。`provenances` 对 Provider observation 保存 `metadata-provider` 来源字段；对书目导入 observation 固定保存 `user`、`bibliographic-import`、空 source record/input/parameters hash 和接纳时间。Catalog 不保存原始书目文件、外部工具身份、外部记录 ID 或导入批次：

| 表组                                                                                  | 保存内容与关键约束                                                                                                                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata_observations`                                                               | ObservationId、provenance FK、version_role、可选 reference/cited-by counts 和 observation metadata 的标量列；Provider 与用户导入共用，行不可变 |
| `metadata_observation_authors`、`metadata_observation_author_affiliations`            | 来源作者和单位的有序结构                                                                                                                       |
| `metadata_observation_identifiers`、`metadata_observation_keywords`                   | observation 内 LiteratureMetadata 的标识符与关键词字段                                                                                         |
| `metadata_observation_declared_keywords`、`metadata_observation_reference_texts`      | Provider 声明关键词与原始参考文献文本，按 ordinal 独立保存；书目导入不以这些表复制 `metadata.keywords`                                         |
| `metadata_observation_asset_hints`                                                    | 每个 AssetHint 的 URL、kind、media/asset/version role、access status 和 license 普通列；没有线索的导入 observation 不生成子行                  |
| `metadata_observation_version_links`、`metadata_observation_version_link_identifiers` | Provider 明确版本连接中每个 ProviderLiteratureKey 的可选 record_id 与稳定 identifiers；至少一种定位                                            |
| `literature_metadata_observations`                                                    | Observation 到具体 Literature 的接纳归属；每个 observation 最多归属一个 Literature，一个 Literature 可以有多个 observation                     |

全部 identifier 子表都保存 Model 已形成的 canonical `(namespace, value)`：DOI 是小写裸值，arXiv 是不带 revision 的基础 ID，PMID/PMCID 及其它已支持 namespace 使用各自官方形式。一个父对象内以 canonical pair 去重并用 ordinal 保持首次顺序；跨 Literature 的查找使用普通索引，但 Storage 不用全局唯一约束替代 Literature 的命中、冲突和身份整理决定。OpenAlex Work ID、Web of Science UID、Semantic Scholar Paper ID、Scopus EID 等 Provider record identity 只能出现在 `provenances.source_record_id` 或相应 key/endpoint 的 `record_id` 列，不能复制到 identifier 子表或建立混用索引。

供应商结构化引用与权威引用使用：

| 表组                                                                    | 保存内容与关键约束                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `provider_relation_observations`                                        | ObservationId 与 provenance；一行一条有向边，不保存扩展状态                                      |
| `provider_relation_endpoints`、`provider_relation_endpoint_identifiers` | 每条边固定 `citing`/`cited` 两个端点的 record_id 与 identifiers                                  |
| `literature_references`                                                 | ReferenceId、source LiteratureId、target LiteratureId；source != target，source/target pair 唯一 |
| `provider_relation_reference_supports`                                  | Reference 到 ProviderRelationObservation 的 support                                              |
| `metadata_reference_text_supports`                                      | Reference 到 `(metadata_observation_id, reference_index)` 的 support                             |
| `content_reference_text_supports`                                       | Reference 到 `(literature_content_sha256, reference_index)` 的 support                           |

每条 Reference 至少有一项有效 support；support 不复制原文、evidence、目标 metadata 或 provenance。临时 `ReferenceLookup`、供应商目标 ID 占位和未解析 Reference 不建表。权威引用默认使用 FK `RESTRICT`：在未来明确设计文献删除语义之前，不通过级联悄悄删除有效 Reference 或 support。

MetaLiterature 成员关系只由 `literatures.meta_literature_id` 保存；不建立成员关联表、Meta 状态、`LiteratureRelationObservation` 或 `LiteratureRelation`。Meta “已有一个可用版本”通过成员 current facts 查询推导。

#### 2.3.4 Asset、ParserResult 与 LiteratureContent

| 表组                                 | 保存内容与关键约束                                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assets`                             | AssetId 到一个 `artifact_objects` PDF 字节对象的一对一关系；公开 Asset 视图通过 join 得到 hash、size、media type 和 path                                                                              |
| `literature_assets`                  | LiteratureAssetId、LiteratureId、AssetId、role、provenance FK 和可选脱敏 source_url                                                                                                                   |
| `parser_results`                     | 每个 source AssetId 最多一个当前 ParserResult，保存 source/result hash、page count、Markdown artifact FK、parser provenance/version/mode/model identity                                               |
| `parser_result_resources`            | 当前 ParserResult 实际引用资源的 reference、ordinal 和 artifact FK                                                                                                                                    |
| `literature_contents`                | 每个 Literature 最多一个当前 content；保存 content hash、metadata revision/hash、结构化 content artifact FK、规范 Markdown artifact FK、当前主 PDF/ParserResult 输入绑定和单一 Analysis provenance FK |
| `literature_content_reference_texts` | 当前 content 的有序参考文献文本投影，用于 support FK、详情读取和独立引用原文读取；不进入普通全文检索                                                                                                  |
| `literature_search_fts`              | 从当前 metadata、作者/单位/标识符和当前 LiteratureContent 正文章节的允许字段重建的 FTS5 投影；不索引来源 observation 或参考文献原文                                                                   |

同一 Literature 最多存在一个 `role = "primary-pdf"` 的 `literature_assets` 行；这项唯一关系就是当前主 PDF，不另设 current pointer 或 `is_current`。`Asset` 不混入 Literature、role、version 或 provenance，`LiteratureAsset` 不复制 Literature.version_role。手动接纳与自动获取使用同一表；手动关系的 provenance 为 user/manual-pdf、`source_url` 为空，输入绝对路径不保存。

每个 Asset 的 `parser_results` 当前行和每个 Literature 的 `literature_contents` 当前行都可原子替换但不保留历史。结构化 LiteratureContent 与规范 Markdown 的完整字节进入 ArtifactStore；SQLite 不为每个 `LiteratureSection`、subsection 或正文 Markdown 建表，只保存 current binding、hash、参考文献投影和 FTS。这样既保持文档原子性，也避免把大段 Markdown 塞进 SQLite。

#### 2.3.5 自动 PDF 获取耗尽

Catalog 只为会改变未来自动目标选择的稳定缺失保存一张最小关系表：

| 表                                      | 保存内容与关键约束                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `automatic_pdf_acquisition_exhaustions` | `literature_id` 同时是主键和指向 `literatures` 的外键；只表示该具体 Literature 已正常耗尽当前自动 PDF 获取路径 |

该表没有 reason、Provider、candidate、configuration hash、created/updated time、attempt count 或 status。它不改变 LiteratureStatus；read model 只通过该行投影 `needs_manual_pdf = true`。只有 Acquisition 已正常遍历全部当前自动路径时才能插入，提交成功后才允许返回 `NoPrimaryPdf`。接纳任意新 MetadataObservation、自动或手动主 PDF 成功，或用户明确重试时删除。用户中断、Network/API/权限/配置错误、Storage 错误、Parser/LLM 失败和无法判断不能插入。

#### 2.3.6 有意保存与有意推导

数据库可以用空间换取高成本、稳定且可核对的读取结果：metadata/content hash、FTS 和自动 PDF 获取耗尽事实可以保存。以下低成本值不作为独立事实保存：

- LiteratureStatus 与 MetaLiterature “至少一个可用版本”；
- 当前主 PDF pointer；
- artifact reference count；
- Discovery result count 等简单聚合；
- observation 内容 hash `observation_sha256`。

这些值通过唯一关系、TypeScript 读取规则或查询聚合推导。若未来性能证据要求物化，只能建立可重建投影并保持一个权威来源，不能新增可独立修改的状态。

`LiteratureSearchItem`、`LibrarySearchPage`、`LiteratureAssetView`、`LiteratureDetail`、`LiteratureReferencePage` 和 `ReferenceDetail` 都在查询时由上述权威行、唯一关系、聚合值和稳定 artifact 引用临时组装。Catalog 不建立 search item、page、detail、asset view、missing step、引用数量、关系读取 DTO 或其它投影表；这些对象没有独立 ID、provenance、revision 或写入操作。`LiteratureDetail` 必须在同一个 read-only SQLite snapshot 中读取 Literature/MetaLiterature、metadata binding、observations、资产关系、当前 ParserResult/Content、其它版本与 Reference 数量，再使用已经提交的不可变 artifact 引用读取需要的结构化内容，不能把不同时间点的 current facts 拼成一个结果。

`LiteratureReferencePage` 在同一 snapshot 中读取指定端点的权威 Reference、相关 Literature current facts 和每条边的 support count；`ReferenceDetail` 在同一 snapshot 中读取 Reference 两端和全部当前 support。正向和反向列表都查询 `literature_references`，不能物化 cited-by 副本。关系页面的固定排序、total 和 cursor 位置必须来自同一读取视图；后续页面可以看到后续提交的 current facts，但单页内部不能混合提交前后状态。

#### 2.3.7 不持久化的核心查询投影与临时现场

以下约束针对核心文献事实和同步 completion 临时现场；[已有执行持久化](#238-已有执行持久化) 中明确拥有的 durable execution 合同是独立持久化边界：

- Network permit、等待队列、冷却、窗口计数、`Retry-After`、`next_allowed_at` 和 `blocked_until`；
- Provider/LLM/MinerU 凭据、凭据字段状态、readiness、`config test` 结果/时间和服务健康状态；secret 只由 Configuration 管理在唯一用户级凭据文件中，不属于逻辑文献数据库；
- HTTP/浏览器现场、Provider cursor、request/response 和 vendor SDK object；
- 搜索候选、相关度、原始扫描/接纳/拒绝计数、分页中间状态和未接纳结果；
- 自动 route 内部 `PdfCandidate`、临时 candidate key/tried set；它们不同于 [已有执行持久化](#238-已有执行持久化) 的 transfer candidate、attempt 和发布回执；
- Parser 外部 task、私有 JSON/TEI/block/bbox、未引用资源与未接纳结果；旧 current ParserResult 不提供历史保证，新 DocumentVersion 按 [新文档与知识存储设计](#41-新文档与知识存储设计) 保留依赖；
- LLM prompt/request/response、第一阶段 metadata proposal、第二阶段 Markdown 草稿、临时 `ReferenceLookup` 和两次调用的独立 provenance；
- 同步 completion 的 BatchRequest/selector、目标和内存 Report；显式 durable Job 持有自己的 selector、targets、attempts 与结果事件，不能套用此禁令；
- LibraryQuery/LibrarySearchRequest/LiteratureReferenceRequest 的调用现场、cursor、SearchItem/SearchPage、LiteratureAssetView、LiteratureDetail、LiteratureReferenceItem/Page 和 ReferenceDetail 查询投影；
- 旧统一 metadata、旧 ParserResult、旧 LiteratureContent 的无条件完整历史；新文档/知识依赖不是可随意清除的旧缓存；
- 用户本地 PDF 的绝对路径和原文件；
- SQLite 大型 BLOB、原始书目导入文件、外部导入对象/记录 ID、导入批次历史和导出文件。

其中需要向用户呈现的稳定脱敏 failure 进入本次 Report；日志可以旁路输出安全诊断，但不能替代 Report。failure 不建立 Catalog current-failure 投影，不能恢复外部现场或决定 Literature 状态。自动 PDF 获取耗尽不保存失败内容，它只是影响下次自动选择的当前事实。

#### 2.3.8 已有执行持久化

Catalog v1–v6、candidate/receipt 子 schema 和 execution runtime schema 分别有版本/fingerprint。v2 在核心文献表上增加执行支持；v3 加 Document/Evidence 存储基础，v4 加独立可重建材料检索投影，v5 加提取交付，v6 加单篇知识产物与精确依赖。

| 表组                                              | 实际用途和写入 owner                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `execution_candidates`、`execution_receipts`      | Intake/发布流程保存 transfer candidate、intent 与提交结果；回执用于关联实际发布，不由日志推断 |
| `execution_jobs`、`execution_targets`             | Application Jobs 保存明确请求、selector、幂等键、冻结目标与阶段                               |
| `execution_policy_snapshots`、`execution_budgets` | Job 的执行政策、预算上限与实际核销                                                            |
| `execution_attempts`、`execution_events`          | 有限执行记录、稳定失败与按 job 排序的事件                                                     |
| `execution_interventions`、`execution_leases`     | 已有人工介入记录、boot/control 绑定与运行租约                                                 |
| `execution_schema_migrations`                     | 显式迁移动作的版本与 fingerprint 回执                                                         |

这些表不能决定 PDF、元数据或知识内容是否有效。Job completed 不能替代 Asset/关系的实际提交，failed Job 也不能撤销其此前成功接纳的文献。JSON 列保留封闭运行合同并由边界解析；未知 schema、非法枚举、无界 payload 不得借此写入。

同步 DatabaseCompletion 与 durable Jobs 是两条已有入口。同步重跑重新展开选择器；新 Job 的 selector JSON 保存 `schema_version: 2` 的冻结 MetaLiterature 目标及有序版本候选，`execution_targets` 为每个操作目标保存一条可领取记录，既有 `schema_version: 1` 单篇记录仍可读取并执行。相同幂等键和请求的重复创建复用已存快照，不因后来的库内变化重新选择目标；v2 快照有 4 MiB 的有界 JSON 上限，旧 selector-only 记录继续使用 64 KiB 上限，catalog schema 未变。Job 按其持久化合同读取目标、预算和恢复状态；候选列表不成为文献事实或同步 Report。不能从“存在 Job 表”推导客户端断开后有常驻 daemon 自动继续，进程存续仍由应用入口决定。

### 2.4 文件责任

文件存储保存：

- 通过基本检查的当前主 PDF，包括自动获取字节和手动文件的内部副本；
- 补充资产；
- 每个输入 Asset 当前 ParserResult 的规范化 Markdown 与实际引用资源；
- 结构化 `LiteratureContent` 的规范序列化；
- 从同一已验收 metadata/content 确定性渲染的规范 Markdown。

文件使用内容寻址和 create-if-absent 发布。已接受对象不得原地覆盖；相同目标存在相同字节时复用，存在不同字节时保留冲突证据并拒绝发布。

同一个逻辑文献库使用一个配置的 `artifact_root`；搜索、任务和文献不会各自创建资产根。
新发布文件按职责分类，类别内按 SHA-256 前两位分桶，完整 hash 保留为文件名。路径生成由
`storage/artifact-layout.ts` 统一负责，业务 owner 传入产物用途与已确认的媒体类型：

```text
artifacts/
  originals/pdf/<hh>/<sha256>.pdf
  parsed/markdown/<hh>/<sha256>.md
  parsed/structure/<hh>/<sha256>.json
  parsed/images/<hh>/<sha256>.jpg        # 或 png、webp、svg 等实际图片类型
  parsed/resources/<hh>/<sha256>.<ext>   # 已支持的非图片 parser 资源
  knowledge/summaries/<hh>/<sha256>.json # 兼容 LiteratureContent 也可为 md
  knowledge/syntheses/<hh>/<sha256>.json
  .staging/                            # 未完成写入
  .candidates/<sha256>.bin              # 持久下载候选，尚非正式 PDF 路径
```

目录按写入需要创建。扩展名按已接纳的 `media_type` 选择；未知资源类型继续使用 `.bin`，
不从供应商文件名猜测类型。Parser Markdown 内的相对资源引用与内容 hash 保持原样，读取
通过 catalog 的资源映射解析；物理分类目录不是可直接复制发布的文献导出包。

数据库中的既有规范相对路径优先于新命名规则：已登记的同内容文件继续复用原位置，
旧 `objects/*.pdf`、`objects/*.bin` 及既有回执仍可读取、恢复和重放。路径变化不修改
文献 ID、artifact ID、字节 hash、证据定位或 catalog schema，也不在启动时搬动旧文件。
已经生成的新路径需要本版本或之后的 reader；旧版本程序不保证支持新的 PDF intent 路径。
恢复/回收同时识别新分类目录与既有对象目录，继续按精确引用、实际所有权和依赖保护执行，
目录分类不授权回收已接纳材料或下载候选。

Storage 不根据文件内容自行决定它是否属于某篇文献。消费模块先形成经过规则确认的发布请求，Storage 再执行物理保存。

Catalog、ArtifactStore、写锁和面向用户的输出属于普通本地数据，不以 Unix owner、mode 或 sticky bit 作为准入条件。已有目录或文件只要当前进程能实际访问即可；组可写或全局可写祖先、Catalog、资产对象和输出目标不会仅因权限位被拒绝。新建目录和文件可以使用 `0700`、`0600` 作为保守默认值，但再次打开时不要求保持这些权限。Storage 仍以 descriptor-relative、nofollow、对象类型、单硬链接、inode 身份、hash、size 和原子发布检查防止路径逃逸、对象错配与半成品。凭据文件不属于 Storage，继续由 Configuration 的独立 secret 权限合同管理。

Storage 还实现 Literature 拥有的 artifact read Port。输入只接受已经从查询投影取得的 `Asset`、`ParserArtifactRef` 或 `ArtifactRef`；实现必须在配置的 ArtifactStore 根下解析规范路径或内容地址，拒绝绝对路径、父目录跳转、符号链接逃逸和非普通文件，并在返回 context-managed 只读 binary stream 前复核 byte size、SHA-256 与 Catalog 中的 media type。读取不改变访问时间以外的文件系统实现细节，不建立数据库事实，也不把解析后的绝对路径返回调用方。

导出到用户选择的文件不把目标纳入 ArtifactStore。Entry 使用 verified reader，在目标同目录完成 owner-only staging、flush、`fsync`、size/hash 复核和原子发布；目标存在时默认拒绝，明确覆盖也只能原子替换。失败清理 staging 并保持已有目标不变；用户目标路径、导出副本和导出成功标记都不进入 Catalog、ArtifactStore、provenance 或 Report。

用户手动提供的原文件从不成为 ArtifactStore 对象。Acquisition 复制到 owner-only staging 后，Storage 只接收内部副本及其 hash；输入绝对路径不进入文件名、相对路径、provenance、Catalog、对账或清理。后续内容无效清理只能删除内部对象。

文献内容处理链中，来源 observation、当前权威 metadata 和原始 PDF 是优先长期可靠保存的事实。原始解析、校订稿、结构注释、标签与算子结果按 ADR 0037 以不可变版本发布，并按引用关系保护：仍被引用的版本必须可读，否则明确失效；派生产物损坏、清理或丢失不能破坏 metadata 和 PDF。当前代码中的 ParserResult、LiteratureContent 与规范总结 Markdown 属于将退役的旧路径（见 §6），新依赖保护与读取/回收竞争见[新文档与知识存储设计](#41-新文档与知识存储设计)。

ParserResult 是当前可替换中间结果，不是不可变产品历史。Storage 仍以内容寻址和 create-if-absent 发布每一份新字节，但 Catalog 对同一输入 Asset 只保留一项当前 ParserResult 关系。成功切换后旧关系删除，旧字节进入与正式对象区隔离的本地缓存；旧兼容缓存不参与文献状态；新表示仍被有效证据引用时须保留对应版本及可读取关系，不能套用仅按缓存预算回收的旧规则。新结果提交失败时旧关系和旧字节保持完整。

LiteratureContent 使用相同的“不可变字节、可替换当前关系”语义：每个 Literature 只保存一个当前 content，只有新结果完整发布并经 Literature 接纳后才切换；失败保留旧当前结果，旧结构化内容与 Markdown 不进入 Catalog 历史。这里不进一步规定缓存物理实现。

### 2.5 SQLite 连接策略

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

## 3. 事务、发布、并发与恢复

### 3.1 整体事务

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
12. 原实现的 `NoUsableContent` 清理事务不再是目标授权条件。分析不适用或失败不能单独撤销已接纳资产；独立 owner 的资产失效/删除决定须说明精确目标、依据与引用处理，再由 Storage 执行。用户原文件始终不由该事务处理；
13. 身份合并或版本整理涉及的 observation 归属、DiscoveryResult/cause、自动获取耗尽归属和引用关系转移；
14. 在 Reference 默认 FK `RESTRICT` 边界内，已经由 Literature 明确形成的删除或整理决定所涉及的全部关系变化。

事务适配器只能持久化调用方传入的已确认 Model 决定，不能在 SQL 分支中形成新业务规则。内容接纳前重新检查预期 Literature、初始 metadata revision/hash 和当前主资产 ID/hash；其它提交复检各自预期输入，拒绝 stale 结果。

### 3.2 不可变文件发布

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

### 3.3 写入准入与并发

一个主机、一个 canonical catalog path 对应一个核心写 advisory lock。领域/引用 DiscoveryRun、数据库补全操作、手动 PDF、书目导入、身份整理、删除和文件对账在形成实际写入前必须非阻塞获得同一个独占锁；冲突立即返回稳定结果，不排队等待。

锁由平台适配的 OS advisory lock 实现，进程退出或崩溃时由操作系统释放。锁可以覆盖一次完整写执行，但 SQLite 事务始终保持短小。查询和只读导出使用已提交 snapshot，不获得核心写锁。

执行内部即使并行等待不同目标的外部调用，SQLite commit 仍通过一个进程内提交队列串行完成。

### 3.4 对账与崩溃恢复

对账必须在获得同一核心写锁后运行，并遵守：

- 只处理正式对象区中的无数据库引用对象；
- 不接触活动 staging；
- 缓存区不解释为数据库历史，并按独立预算回收；
- 不删除仍被其它关系引用的相同字节；
- 不把孤立文件、FTS 或执行记录当作文献状态依据；
- 发现缺失文件、hash 冲突或非法相对路径时保留证据并 fail closed。

进程崩溃后，持久化 DiscoveryRun 的遗留 `RUNNING` 收尾由 `entry` 解释；Storage 只提供 DiscoveryRun 和当前文献事实的事务一致读取与更新。同步数据库补全没有需恢复的持久化 BatchRun，重跑重新展开 selector；durable Jobs 则由 Application/Execution 解释自己的租约、attempt 和终态，不由查询入口恢复。

下一次运行和恢复以 Catalog 与 ArtifactStore 中已经完整提交的 current facts 为依据。临时 staging、外部 task、Parser/LLM 草稿和内存队列不是权威业务现场。已有 durable candidate/receipt、publication/reclamation 记录按各自合同恢复，不能由孤立文件推断接纳成功。

### 3.5 数据与生命周期

文件系统保存 PDF、ParserResult 和其它大字节；SQLite/catalog 只保存规范相对引用、hash、relation、
provenance 和已确认的业务事实。FileStore 使用 bounded reader、no-follow、descriptor identity、fsync、
create-if-absent 和冲突证据。DB Worker 单独持有连接，只接受 typed command；repository 不在查询或写入
时形成身份、主资产或业务状态决定。

Candidate 的生命周期为：

```text
captured -> staged -> validated -> durable-ready -> accepted | rejected | failed
```

`durable-ready` 表示字节已经独立于页面和工作台保存；它不表示 PDF 已通过文章归属或已成为 Literature
主资产。Acquisition 完成字节门、文章/版本门和 receipt 后，才调用 Storage 发布已确认事实。文件发布
与数据库提交之间的进程退出必须可通过 hash、receipt 和现有事实对账；实现不能声称文件系统与 SQLite
具有一个跨系统原子事务。

v1 文献事实与 v2 job/attempt/event/candidate/receipt 运行事实使用显式 schema 边界。历史 v2 合成迁移门禁
保持；正式 operator 的整链入口见 §4.1.11。代理执行生产数据迁移、恢复、切换及双写仍需独立授权。

### 3.6 Candidate 与 receipt 的持久化

v1 schema manifest 保持冻结。`SqliteWorker.upgradeExecutionSchema()` 显式添加同 catalog 下的 execution version 1：

| 表                          | 内容 / owner                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `execution_schema_identity` | version、manifest fingerprint；Storage 校验版本                                                                |
| `execution_candidates`      | transfer ID 和严格 Candidate JSON，含相对引用、长度、hash；Acquisition 确认，Storage 保存                      |
| `execution_receipts`        | receipt ID、Candidate 外键、完整确认输入 JSON、可空的结果 JSON；Acquisition 决定发布，Storage 原子写事实与结果 |

大字节存于 FileStore `.candidates/<sha256>.bin`，先不可变封存，再保存 Candidate 记录。正式发布先写 receipt 输入，
再 create-if-absent 发布 `objects/` 文件，最后同一事务写入 v1 provenance/asset/relation 与 receipt 结果。
重复 receipt 必须全部输入一致；任何已存在事实 ID 的字段冲突都拒绝。`reconcile()` 重试已确认输入，
不恢复未完成 Agent 或 Browser 任务。备份使用 `VACUUM INTO`；回滚先备份执行证据，再只移除扩展，保留已确认 v1 事实及字节。

Application 仅在 `executionSchema: "upgrade-synthetic"` 显式选项下组装此路径。默认不迁移 v1，当前仅用于合成/副本验证。
[恢复证据](../../../migration/evidence/runtime/candidate-recovery.md) 记录新进程、两种中断窗口、冲突和回滚演练。

`Application.execution.acceptance` 是已有 Literature 的 Candidate 接纳入口；外部命令只携带 ID 和 metadata
CAS 基线。Acquisition 重读 durable 字节并形成身份/版本证据，Literature 按同 snapshot 的 current facts 准入，
再通过既有 publisher 发布。相同字节复用现有 Asset 和主关系，新 provenance/capture/receipt 保留；异 hash
主资产拒绝覆盖。该切片与限制见 [接纳证据](../../../migration/evidence/browser-acquisition/candidate-acceptance.md)。

## 4. 知识版本、依赖与回收

### 4.1 新文档与知识存储设计

> ADR 0037：原始解析与校订版本按引用保护；旧 `markdown-utf8-v1` 版本、`LiteratureContent` 与旧处理器结果在 GB 确认后删除。见[§6](#6-adr-0037-新增存储实施中)。

#### 4.1.1 关系布局与 owner

下表概述已实现 v3–v6 与后续目标的逻辑关系。已发布 DDL、fingerprint 和 reader matrix 以本节各版本小节与源码 manifest 为准；未来集合综合、失效及回收不能从逻辑示意推导为已交付。

| 逻辑关系                     | 必要字段与约束                                                                         | 写入决定者                           |
| ---------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------ |
| document versions            | 文档/版本 ID、源资产、parser hash、builder/locator 版本、表示 hash、结构/资源 artifact | Document/Evidence                    |
| document defaults            | 文档到默认版本的唯一关系，独立 revision/CAS                                            | Document/Evidence                    |
| knowledge artifacts          | 产物 ID、用途/问题、manifest/method/hash、内容 artifact、覆盖与 provenance             | Analysis                             |
| knowledge defaults           | 文献/用途到默认产物的显式关系；不把所有用途合成一个 current                            | Analysis                             |
| artifact dependencies        | 精确源/目标版本或 artifact、依赖类型和有效性；可查反向依赖                             | 源产物 owner                         |
| external evidence protection | 对外交付的证据目标、保护身份与失效规则；不含领域 payload                               | 交付 owner 与 Document/Evidence 协作 |
| index generations            | 索引格式、输入范围与投影版本、完成范围；可重建                                         | Retrieval/Context                    |

Schema 不能只有 `objects(id,json)`：唯一性、跨版本关联和回收条件要能约束、查询。结构正文与大 payload 进入 ArtifactStore；Catalog 保存 ID、hash、相对引用、关系和必要检索标量。候选 payload 托管尚未接受，不能默认增加历史候选表；最小回执记录和外部证据保护另行设计。

#### 4.1.2 发布、读取与回收竞争

新版本发布分为字节准备与关系提交。先验证全部依赖的精确版本，准备不可变字节，再取得写入准入，在短事务内复检依赖可用性、提交产物和依赖。设置默认关系另带期望 revision；CAS 失败不应删除已经合法发布的历史版本产物。

读取固定版本，生命周期内保护正在读取的字节。长期依赖登记与短期读取 pin 不同：前者跨进程重启有效，后者只保护当前读者。回收必须同时检查当前关系、有效产物、外部交付保护和活动读取；不能先判“没有 current 引用”，随后与新产物发布并发删除。

具体 pin 的存储/锁实现仍待冻结，但必须在同一发布/回收准入协议下消除检查后删除竞态。旧 reader 与新 writer 混合运行时，未知依赖不能被旧回收器当作零引用；缺少兼容保证就禁用该回收路径。

依赖闭包可从 KnowledgeArtifact 追到 DocumentVersion、Markdown/资源、MaterialRef。目标丢失或损坏时返回明确 integrity failure，不能把引用重指向最新版本。显式失效可以保留 tombstone/原因投影；具体删除合同须在删除入口暴露前定义，不因本节设计自动迁移真实材料。

#### 4.1.3 只读打开与维护打开

当前 `SqliteWorker` 的 readonly 模式使用 SQLite read-only/query-only 和命令 allowlist。`createQueryApplication` 只对已有 Catalog 做支持版本与 fingerprint 前置检查，不建库、不执行 schema 升级、不运行 publication/job/reclamation 恢复，也不做全库文件扫描。

冷启动缺库返回 not-initialized；未知 schema 或损坏返回 unavailable。WAL/SHM 是 SQLite 并发协调文件，不是新增业务事实。查询可看到活跃 writer 已提交的内容，不能用内存中的未提交候选补齐。

待恢复发布回执不全局封锁已有有效资料；查询读取实际引用并按需校验，只有受影响对象失败。恢复、重索引和对账均由明确维护入口进行。future reader 对旧对象可做纯内存投影，不能在 load 时写回“升级后”对象。

#### 4.1.4 兼容与恢复证明

新增表前需给出输入 schema/fingerprint、目标 manifest、旧/新 reader 支持矩阵和恢复步骤。dry-run 只读报告，真实迁移经明确授权，对精确目标先备份并验证恢复可用；不将查询启动当作迁移机会。

验证必须覆盖：文件发布前/后与事务提交前/后崩溃、default CAS 冲突、重复发布、并发读/回收、外部候选交付后重解析与回收尝试、未知 schema 拒绝。完整性证据是“已提交关系可读且 hash 正确”，不能仅以进程成功退出判断。

#### 4.1.5 M05-T01 Catalog v3 文档基础

当前 Catalog v3 manifest 是 `schema-v3.ts` 中按序 `schema_identity` v3 + 完整 v2 DDL（不改动 v1 文献表和 execution/runtime 子 schema）+ `DOCUMENT_SCHEMA`。fingerprint 是完整 SQL 字符串数组 JSON 的 SHA-256，冻结为 `e4d474b1627e39f668752f315bdc2edb995ab5bf5d275262b72d2019ea6f4e36`；DDL 变化必须作新的版本决定。旧 v1/v2 fingerprint 保持原值；Catalog v3 与 execution v2、`DocumentRef.schema_version=1` 不共享版本号。迁移 inspection 比较 identity/fingerprint、清单中每条 SQLite DDL、`integrity_check`、`foreign_key_check` 和 execution 两个子 schema identity；普通 v3 只读/写 worker 准入也检查完整 DDL、对象集合、完整性、外键和 execution 子 schema identity。未知、局部建表、损坏均拒绝。

首版只新增四张表，不为 Analysis、Retrieval 或 Extraction 预建表：

| 表                           | 固定内容与约束                                                                                                                                                                                                                                                                      | Owner             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `document_versions`          | 版本/文档 ID、对象 schema v1、Literature 与源 Asset ID/hash/大小/媒体类型/规范相对 artifact 路径、ParserResult hash、parser provenance FK、builder/locator 版本、表示 hash、Markdown 和结构 artifact 描述、创建时间；源/产物均有精确 FK，`(document_id,representation_sha256)` 唯一 | Document/Evidence |
| `document_version_resources` | 按 ordinal 的确定性资源 ID、逻辑 reference、关系种类、artifact 描述；版本内 ID/reference 唯一，artifact FK                                                                                                                                                                          | Document/Evidence |
| `document_defaults`          | 文档到默认版本的独立 revision；复合外键确保默认版本属于同一文档；T02 发布后用期望 revision CAS，版本本身不可覆盖                                                                                                                                                                    | Document/Evidence |
| `document_schema_migrations` | 从 v1/v2 到 v3 的显式迁移 receipt、fingerprint 和时间，不承载业务事实                                                                                                                                                                                                               | Storage 维护入口  |

ParserResult 当前行可被重解析替换，因此新版本保存 ParserResult hash 和 parser provenance FK 快照，**不**以旧 current 行作版本 FK。版本的源资产、parser provenance 与 Markdown/结构/资源 FK 阻止旧清理删除有效依赖。Storage 不决定版本接纳；T01 的 `DocumentStoragePort` 冻结 create-if-absent 文件发布、精确输入检查、事务内依赖复检与默认 revision CAS、固定版本读取 pin 和 verified artifact 读取的边界。T02 已由 Document/Evidence owner 接通这些 Port：先按 SHA 查找已登记结构路径，缺失时发布不可变文件，再通过短事务提交版本；CAS 失败保留已合法发布版本，回执区分版本登记与默认切换。相同表示重复发布沿用首次版本 provenance，新的 ParserResult 来源仍独立保存。输入与版本的多表读取使用短 read transaction；T03 版本 reader 固定 v3 路径闭包、读前检查声明上限、复算表示 hash 与规范结构并验证依赖字节，随后交付有界片段/资源及证据解析。目录标题最多 512 UTF-8 字节、每页片段证据最多 32 条等界限仅作用于读取投影，不改规范结构或已发布表示 hash。当前禁用物理回收，因此读取回调期间版本可用；M08-T02 已在 v5 为外部候选回执登记有限期依赖保护，但这里没有未来 GC 所需的跨进程读取 pin。

当前安全回收合同为：v3 上旧 `NoUsableContent` 已接纳材料删除入口不可用，旧 artifact reclaimer 对任何 retired descriptor 返回保留；文档版本/原材料没有新删除 writer。这样在外部保护登记、失效原因、读取 pin 与统一回收准入尚未设计完成前，不能把未知引用误当作零引用。回收若恢复，须由 Document/Evidence owner 对当前关系、持久内部/外部依赖及活动读取作同一准入内复检；仅靠 FK 或进程内 Set 不足以授权物理删除。

| Reader / writer                             | v1                                    | v2                                    | v3                                                                                 |
| ------------------------------------------- | ------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| 当前 TS 通用只读 Library/材料/旧内容 reader | 支持、纯读                            | 支持、纯读                            | 支持、纯读；不建文档表                                                             |
| 当前 TS 既有业务 writer                     | 支持既有行为                          | 支持既有行为                          | 支持既有行为；旧删除入口受保护                                                     |
| Document/Evidence reader 与 writer          | 原 PDF 文件级证据可读；文档版本不可用 | 原 PDF 文件级证据可读；文档版本不可用 | v3 显式 writer、固定版本有界阅读及证据 resolver 已接通；旧库材料仍受旧删除策略约束 |
| 旧 v1/v2 二进制读取 v3                      | 未验证且不承诺                        | 未验证且不承诺                        | 未知 fingerprint 时拒绝；不得无损回退后丢弃 v3 增量                                |
| 显式 document inspection / dry-run          | 纯读                                  | 纯读                                  | 纯读                                                                               |
| 显式合成 document migrate                   | v1→v2→v3，同一事务                    | v2→v3，同一事务                       | 幂等返回，零写入                                                                   |

`storage document-inspect/document-migrate` 使用精确 `--catalog` 路径；真正迁移只接受系统临时目录下 `sciretriever-*` 合成副本、显式 `--synthetic-copy`、同目录不存在的 `--backup`。非 dry-run 迁移全程持有与 Application 写操作相同的 catalog 写锁，锁内重新核对源库。迁移先以 SQLite `VACUUM INTO` 在同目录私有 staging 中做一致性备份并只读检查，再以 create-if-absent 原子发布备份；已存在或并发抢占的目标绝不覆盖。随后开启事务迁移；失败保留已发布备份，事务回滚，使用新的备份路径重跑。`inspect`/`--dry-run` 不创建写锁 sidecar、不打开写连接、不备份、不改原字节。真实用户 catalog 切换未授权；操作示例见[文档 Catalog 迁移指南](../../guides/document-catalog-migration.md)。

#### 4.1.6 M07-T01 Catalog v4 检索投影

`schema-v4.ts` 的完整 manifest 是 v4 identity、未改动的 v3 其余 DDL 与 `RETRIEVAL_SCHEMA`，冻结 fingerprint 为 `5391b92b4cab13ad2f1380705d603e21619264f442789a6659a1036ba0086c33`。`retrieval_source_revision` 通过文献、当前元数据/作者/关键词、资产关系和 DocumentVersion/default 的触发器增长；`retrieval_generations`、`retrieval_active_generation`、`retrieval_entries` 与 `retrieval_fts` 只保存可重建索引状态和精确来源引用，不拥有业务文献事实。v3→v4 仅通过合成副本上的显式 `storage retrieval-migrate`，另有 `storage retrieval-inspect`/dry-run；迁移不建索引，正式维护须显式 `maintenance rebuild-index`。旧 generation 失败保留，指针仅在来源 revision 未改变且新 generation 的 entries/FTS 计数、规范内容摘要和 FTS posting 摘要通过后原子切换；读写共用 v4 manifest、execution identity、完整性与 generation 校验。检索 SQL 和检查在 SQLite worker 内执行，独立检索 reader 固定 generation 和 source revision；业务源改变返回 stale。v4 延续 v3 的 Document 发布、旧版本读取和禁物理回收，并维持 execution 子 schema identity 不变。更多读取和预算语义见[⑥知识查询与上下文](06-retrieval-context.md#49-m07-t01t02-已实现的材料-context-切片)。

#### 4.1.7 M08-T01 Catalog v5 提取协商与回执基础

v5 只在 v4 完整 manifest 后增加 Extraction 表，不改 v1–v4 任一 DDL 或 fingerprint。`schema-v5.ts` 的完整 manifest 是 v5 identity、原样的 v4 其余 DDL 与 `EXTRACTION_SCHEMA`，冻结 fingerprint 为 `b32a2e853ae0dbde4ae3bcb1f58e109e86a1489db7b9025c4b7e809e330bd7b5`。`extraction_specs` 存调用方命名空间、规范 id/version、固定 hash 与有界规范 JSON；spec 的完整 JSON 以 UTF-8 字节限制在 64 KiB，manifest JSON 在 256 KiB，检查摘要在 4 KiB；operation 通过 `(caller_id,spec_id,spec_version,spec_sha256)` 复合外键锁定同一规范内容；`extraction_operations` 存服务器生成 ID、规范绑定、固定有序 manifest JSON/hash 与状态/接纳窗；`extraction_receipts` 只存批次 key、完整比较 hash、接纳时间、期限和有界检查摘要；`extraction_receipt_materials` 与 `extraction_receipt_documents` 以外键固定整个已承诺 manifest 中实际存在的原件与精确文档版本，文档版本继续通过 v3 外键保护其不可变闭包。任何表都不存候选 records 或领域 payload。`extraction_schema_migrations` 只记显式迁移回执。T01 建立 schema、inspection 和迁移；T02 通过现有 SQLite worker 与 CatalogWriteAdmission 写入 operation，并在单事务内写 receipt 与全部实际 material/document pin。首版已接纳回执与 pin 同期保留 30 天；显式有界清理仅在回执与保护期限均结束后删除，回执查询不写库，也不能恢复历史 payload。

`storage extraction-inspect`/`extraction-migrate` 只读检查或显式迁移 v4→v5；真正迁移仅接受系统临时 `sciretriever-*` 合成目标、`--synthetic-copy` 与同目录不存在的 `--backup`。迁移取得同一 catalog 写锁，先用 SQLite `VACUUM INTO` 建一致备份并检验 v4，再通过 create-if-absent 发布；事务内建 v5 对象、改 identity 并登记迁移记录，失败回滚原库而保留备份。dry-run/inspect 不升级。v1/v2 原件查询仍可用，文档读取需 v3+，检索需 v4+；持久候选提交必须显式到 v5。普通 QueryApplication 不升级任何版本，未知版本、未知 fingerprint 和 v5 DDL 漂移均拒绝。v5 继承 v4 ready generation、源 revision/FTS 摘要与显式 repair 语义；源读取在仅检索投影损坏时仍按既有 source-only 规则工作，检索 writer/reader 仍严格检查投影。Document 旧版本发布/读取和 v3/v4 的禁止物理回收继续生效，v5 不新增 GC。

首版 receipt 与整个 manifest 的 pin 在同一个 `BEGIN IMMEDIATE` 接纳事务内登记。业务判断属于 Extraction，Storage 只执行完整原子提交；提交前的文件/文档实证检查在事务内复检身份和引用关系，未来若启用 GC 必须增加跨进程读 pin 和接纳并发协议。回执的 30 天保护与查询保证一致：期限内同 key/hash 可复核最小回执，期限后显式有限维护可以清理 receipt 和 pin；之后只能报告 `unknown-or-expired`，不能取回历史 payload。当前 v5 依旧不会物理回收被接纳原件/文档，因此到期不自动删除字节；未来 GC 必须纳入有效外部 pin、到期/失效检查，并重新验证发布/读取/回收竞争。

#### 4.1.8 M06-T01 Catalog v6 单篇知识产物

`schema-v6.ts` 的完整 manifest 是 v6 identity、未改动的 v5 其余 DDL 与 `KNOWLEDGE_SCHEMA`，冻结 fingerprint 为 `7c721811397763aa44115fa788d35f7ed641d071ac310cc6b7d0ece61d0930ec`；v1–v5 的 manifest/fingerprint 不变。`knowledge_artifacts` 保存单篇用途/问题、比较域、精确 InputManifest 与方法、内容相对引用/hash/大小、覆盖和 provenance；`knowledge_input_materials`、`knowledge_input_documents` 用外键固定一项原件与一项文档版本，`knowledge_defaults` 以 Literature/用途/问题 hash 为键独立保存 revision/CAS。`knowledge_input_artifacts` 为将来综合保留精确知识依赖表，但 InputManifest v1 只有材料/文档，当前 writer 不插入综合产物；未来须扩展版本化 manifest 并保留 v1 与 Extraction reader。

`manifest_json` 的 SQL 上限 262234 字节对应 InputManifest 规范内容上限 256 KiB 加现有 hash 字段的 90 字节余量，与共享 parser 的限制一致。内容列的 1 MiB SQL 上限是存储防护上限；当前公开单篇内容 parser 另限制为 512 KiB，写入仍必须先经过该 parser。此处不修改冻结的 v6 DDL 或 fingerprint。

内容 JSON 位于 ArtifactStore，先 create-if-absent，再在 SQLite worker 中以 CatalogWriteAdmission 和短事务复核材料、表示、hash 与依赖并插入关系；同一比较域首次提交获胜，重复或并发提交返回真实已存产物、内容和 provenance。默认关系更新是独立 CAS；冲突不删除已合法发布的历史产物。`SqliteKnowledgeStorage.byId/list/default` 对内容字节、manifest、依赖和文档片段证据执行读时闭包复核。Document、Extraction、Retrieval 与 execution runtime 仍在 v6 共用原 owner 和子 schema；旧 NoUsableContent 清理和已接纳资产/文档物理回收继续禁用。

`inspectKnowledgeCatalog`/`migrateKnowledgeCatalog` 只读检查或在系统临时 `sciretriever-*` 合成副本上显式执行 v5→v6。迁移持同一 catalog 写锁，先用 `VACUUM INTO` 建同目录可恢复备份并只读验证，再在事务中加 v6 表、切换 identity、登记迁移回执；失败回滚原库并保留备份。普通 Application、QueryApplication、Web 或知识分析请求不自动迁移；真实用户 catalog 切换尚未授权。v1/v2 原件证据、v3+ 文档读取、v4+ Context、v5+ Extraction 和旧 LiteratureContent reader 均维持原合同，知识发布/历史读取要求完整 v6。

#### 4.1.9 M06-T03-A Catalog v7 综合合同基础

`schema-v7.ts` 继承 v6 表与依赖，只扩大 `knowledge_artifacts` 中综合问题和覆盖 JSON 的约束，并增加 v7 迁移回执；v6 DDL/fingerprint 保持冻结，v7 fingerprint 为 `2e55955946c476beddc9a0a4d61bd8e9d5788cde316f322ddae8b201e405f13a`。综合仍写入 `knowledge_artifacts`，`scope_kind=manifest`，以 manifest hash、非空问题、政策和方法确定比较域；`knowledge_input_materials`、`knowledge_input_documents` 和 `knowledge_input_artifacts` 固定有序清单中的精确依赖。首次比较域写入获胜；文件 create-if-absent 与 Catalog 短事务不是单一原子事务，失败时可能保留待对账的孤儿对象。

`inspectSynthesisCatalog`/`migrateSynthesisCatalog` 只对系统临时 `sciretriever-*` 合成库实施 v6→v7：先在同目录建立并核验可恢复备份，再在锁与事务内重建带新约束的 parent 表、逐列保留旧行、检查子表 FK/完整性并登记回执。失败回滚原库且保留备份；只读检查、dry-run、普通 Application 和 QueryApplication 均不自动升级。真实用户 catalog 的切换另需授权。

v7 继续支持 v1 单篇 writer 和严格 `byId/list/default`；旧单篇 reader 收到综合 ID 明确拒绝其 kind。独立综合 reader 按 ID 检查规范内容、manifest/覆盖、SQL 关系和递归引用，对知识节点、文档、边数、深度与验证字节设闭包上限；只有核实原 PDF 缺失且派生 Markdown、结构与资源文件仍完整时才将来源标为 `source-only`。派生文件缺失、路径异常、权限错误、hash 损坏或错绑仍失败。v7 发布与读取现已接入有界综合模型执行、产品维护和只读 API；不授权旧资产回收。

准备与综合读取共用有界闭包上下文，重复引用只计一次声明大小，允许调用方在 64 MiB 默认上限内传入更小的验证预算；底层为了核验原件、派生表示与哈希可能重复读取，声明预算不等同于实际 I/O 总量。writer 在事务内复核已知材料与文献关系、缺失知识、无 PDF、无默认文档及所有已固定的版本/hash；缺项在准备后变为存在时拒绝旧部分清单。`SqliteKnowledgeStorage.sourceCoreById` 只验证单篇知识内容与 Catalog 关系，不能单独声明原文证据有效；综合 reader 才在同一闭包中区分已验证与严格的 `source-only`。

#### 4.1.10 M07-T03-A Catalog v8 知识检索基础

`schema-v8.ts` 只替换 schema identity 版本、append `knowledge_retrieval_source_revision`、独立 generation/active、statement entry、FTS5、范围索引、迁移回执和源 revision trigger；v1–v7 DDL/fingerprint 不变。v8 fingerprint 为 `42096bd3c5b5cf5dcb97ca0a0671bbc625b0772272228aef8e461792dda20a05`。触发器覆盖知识产物、材料/文档/上游知识依赖、默认关系，以及影响原件/默认/范围验证的 Literature、Asset、LiteratureAsset、DocumentVersion、DocumentDefault；它只更新知识投影 revision，不触碰 v4 材料 revision。知识 entry 的 Artifact ID、content/manifest hash、用途/问题、statement ID/完整 canonical statement hash、来源 Literature ID 集、范围完整标记和默认标记都是派生投影，不是第二知识事实。FTS title/body 不用于正文返回。Generation 记录输入 revision、计数、内容与 posting 摘要；构建状态和 active 指针分离，正常发布保留旧 ready generation，修复坏投影时才事务清除旧 generation；投影内容损坏可由显式知识维护替换，DDL 缺失或未知对象拒绝写入修复。

`inspectKnowledgeRetrievalCatalog`/`migrateKnowledgeRetrievalCatalog` 仅支持系统临时 `sciretriever-*` 合成库 v7→v8：dry-run 只读；真实执行使用同一 Catalog 锁，`VACUUM INTO` 同目录可恢复备份并复核 v7，检查跨连接 data version，再在短事务中 append schema、切换 identity、记回执。事务前/中断点失败保留 v7 和备份；普通启动、查询、知识发布与 Web 不自动升级，真实用户 Catalog 尚无切换授权。v8 的旧 Library/Document/Knowledge/Synthesis/source-only reader 保持源表 DDL/完整性准入；独立材料 Context 仍读 v4 投影，即使知识投影 DDL 或 FTS 损坏也不会被它误判成材料缺失。知识投影 reader 另行检查自身 DDL、计数、内容/posting hash 与 active pointer，损坏时报 `index-corrupt`。已注册的旧程序并不被要求理解 v8；旧版本拒绝未知 identity。

| Catalog 版本 | Library/原 PDF | Document/Evidence | 材料 Context | 单篇知识 | 集合综合 | 知识 Context/索引 |
| --- | --- | --- | --- | --- | --- | --- |
| v1–v2 | 已有兼容读取 | 不可用 | 不可用 | 不可用 | 不可用 | 不可用 |
| v3 | 已有兼容读取 | 可读 | 不可用 | 不可用 | 不可用 | 不可用 |
| v4 | 已有兼容读取 | 可读 | 可读 | 不可用 | 不可用 | 不可用 |
| v5 | 已有兼容读取 | 可读 | 可读 | 不可用 | 不可用 | 不可用 |
| v6 | 已有兼容读取 | 可读 | 可读 | 可读 | 不可用 | 不可用 |
| v7 | 已有兼容读取 | 可读 | 可读 | 可读 | 可读 | 不可用 |
| v8 | 已有兼容读取 | 可读 | 可读 | 可读 | 可读 | 显式重建后可查询；未构建、陈旧或损坏会报告缺口 |

#### 4.1.11 正式 operator 的 Catalog v8 启用

2026-09-30 增加 `storage schema-inspect --catalog PATH`、`schema-init --catalog PATH` 与
`schema-upgrade --catalog PATH --dry-run | --backup PATH`。CLI 直接调用 Storage 的 schema operator，
不创建 Application、不读取用户配置或凭据、不访问 Provider/Parser/模型/站点。必须给规范绝对精确路径；
父目录已经存在且整条父链没有符号链接，现有 catalog 必须是单链接普通文件。读检查和 dry-run 不创建目录、
catalog、备份、写锁 sidecar、receipt 或任务。

`schema-init` 只接受不存在的目标，允许同目录已有配置、资产等合法内容。它在同目录私有 staging 中使用冻结
v8 manifest 建库，初始化 catalog identity、execution/runtime identity、两个检索 source revision，再完整检查，
fsync 并 create-if-absent 发布；不覆盖竞争创建的文件，不修改已有内容。发布后发生失败时保留有效 v8，返回实际
可识别版本。空库没有文献/知识/Job/active generation；启用 schema 不生成文献、索引或知识。

`schema-upgrade` 支持完整 v1–v7，并对完整 v8 返回 already-v8。写入必须给同目录不同且不存在的备份目标；
它全程持有规范 catalog 的同一跨进程 flock，锁内重新检查源版本、完整 DDL/fingerprint、integrity/外键和子 schema。
先用 SQLite `VACUUM INTO` 为原始版本建一致性备份，包含已提交 WAL 事实；只读验证、fsync 后 create-if-absent 发布。
内部活跃 scope 只绑定这一目标与该备份，旧迁移在该 scope 中复用外层锁和经 hash 复核的原始备份，不再次获取锁。
无有效 scope 的旧单步函数仍要求合成路径和原来的 gate/独立备份，不能用普通对象或失效 scope 绕过。

v1/v2→v3→v4→v5→v6→v7→v8 复用各步骤的原事务与完整检查，不改任何冻结 DDL/fingerprint。各步提交后仍持外层锁；
某步失败回滚该步，保留前面已提交步骤与原始备份，并返回 from/current version、completed versions、failed step 和
备份位置。重试从完整中间版本继续，必须给新的备份目标。升级不重新下载、解析、分析、改写原件或构建索引。

这把锁拒绝遵守同一写入准入的业务 writer，SQLite 事务与各步骤的 data-version 检查提供其实际检测范围；工具不能
证明所有外部程序、Browser 和在途任务已经停止。operator 应先停止它们，不能将文件系统发布、SQL 和整个升级链当成
一个绝对原子事务。恢复必须先保全当前 catalog、资产与任何切换后增量；不能直接用旧备份覆盖唯一新库。
具体命令与边界见[升级指南](../../guides/upgrade.md)，切换交接见[切换与回退](../../guides/cutover.md)。

### 4.2 数据、状态与写入所有权

- Literature 决定身份、元数据和权威书目引用；Acquisition 决定资产接纳/关系与正常耗尽；Parsing 决定中性转换结果；Document/Evidence 决定可读表示及定位；Analysis 决定知识产物；Extraction 决定候选协议接纳。
- 新 Analysis 产物建议由 Analysis 验收、通过其持久化 Port 发布；旧 LiteratureContent 兼容路径仍由 Literature 接纳。新产物与旧视图映射必须显式设计，不能双写两套权威元数据。
- InputManifest 只固定本次输入，执行记录只描述意图/进度，索引只加速读取。三者都不能决定某份材料或知识是否有效。
- 各模块拥有局部可用性与结果，不增加一个把“有 PDF、已解析、全部用途已分析、全部记录已提取”混合的总完成态。旧 LiteratureStatus 保留兼容投影。
- S 是统一逻辑存储的实现，不是万能业务模块。跨模块读取可使用经过约定的 read projection；写入只能由事实 owner 作决定，禁止直接跨写私表。

#### 4.2.1 发布与默认视图

不可变产物身份与“当前默认结果”关系分开。发布检查精确输入版本仍存在且符合本次固定范围；更新默认视图另检查当前关系是否已变化。这样可以保留基于明确旧版本的合法结果，又不会把它冒充基于最新材料的结果。旧 completion 的 stale 拒绝规则不因新产物合同而改变。

复用至少比较输入 manifest hash、用途/问题、规范/方法版本与所有影响结果的参数 hash。相同 PDF 的不同研究问题不能误复用同一摘要；候选在 [候选交付的剩余合同与收敛时点](05-knowledge-processing.md#411-候选交付的剩余合同与收敛时点) 待明确的去重作用域和有效期内，相同提交身份配不同完整比较域应冲突，相同内容可安全重试；不能在回执协议未定时承诺跨重启或永久返回相同结果。仅靠重复提交控制不能承诺模型/网络调用只收费一次。新 schema 如需多表，Storage 采用 Catalog 内有 owner 的表和 `artifact_dependencies` 等显式关系；payload 字节放 ArtifactStore，Catalog 保存稳定 ID、版本、hash、相对引用和 provenance，不用 Literature 任意 JSON 字段。

#### 4.2.2 生命周期

生命周期采用以下安全默认值；具体时间期限及外部候选保证按 [候选交付的剩余合同与收敛时点](05-knowledge-processing.md#411-候选交付的剩余合同与收敛时点) 收敛：

- 已接纳原始字节不按时间自动删除。显式失效/删除由 Acquisition/Literature owner 按独立规则决定；被有效产物依赖的字节必须保留，或先让该产物明确失效。模型失败、不适用或零记录不是删除依据。
- 被 KnowledgeArtifact/EvidenceRef 引用的 DocumentVersion、资源和输入 MaterialRef 必须继续可读。无引用的旧派生表示可由 owner 的显式回收策略处理；默认不按新版本发布就立即覆盖/删除，也不对仍被引用的数据设置 TTL。
- 未接纳的 Analysis/Extraction 尝试不是领域产物；不为每次模型尝试默认永久保存结果。现有 execution/job/report 生命周期继续用既有规则，本合同不增加长期回放或无限历史保证。
- 检索索引和可重建 cache 可独立丢弃/重建；它们不能成为文献、表示、证据或候选的唯一副本。索引不可用时 query 返回 coverage gap，不暗中重建、解析或扩库。
- CandidateBatch 首版由 API response/调用方指定的交付目的返回接纳载荷与 receipt，不提供平台“稍后查询历史候选”的承诺；任务结束后平台不因本合同新增持久候选仓库。首版验证即时交付闭环。若之后要托管候选，需先由 Extraction 将 payload、读取权限、保留/删除、恢复、重复提交和 schema 迁移定成独立合同；该存储/历史查询范围在选择前受阻，不阻止结构验证和即时交付。

## 5. 存储完整性验证

### 5.1 验收

直接测试至少证明：

- 核心 scalar 使用普通列、重复结构使用有序子表、关系使用 FK/unique table、大型内容使用 ArtifactStore；不存在通用合同 JSON dump、`extra`、`details`、selected IDs JSON 或 SQL query blob fallback；
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
- 核心 schema 不建立同步 BatchRun/BatchTarget/current failure/Report 副本；已有 execution_jobs/targets/attempts/candidates 只保存其明确拥有的运行合同；
- `automatic_pdf_acquisition_exhaustions` 只以 LiteratureId 为主键/外键，不保存原因、Provider、候选、配置 hash、时间、次数或状态；read model 正确投影 `needs_manual_pdf`，但三级 LiteratureStatus 不受该行改变；
- 只有全部当前自动路径正常耗尽才能建立该行；新 MetadataObservation、自动或手动主 PDF 成功、明确重试都原子清除，Network/API/权限/配置/Storage 错误和中断不能建立；
- Schema 拒绝同一 Literature 多个 `primary-pdf` 关系、多个当前 LiteratureContent、跨 Literature 内容关系，以及缺少最终 metadata、content、Markdown hash 或 Analysis provenance 组成项的 `CONTENT_READY` 事实；主 PDF 不存在 `is_current` 或平行当前指针；
- Asset 只保存不可变文件字段，LiteratureAsset 只保存文献关系、角色、脱敏来源和 provenance，不复制 Literature version role；共享 Asset 不复制文件字节；
- 手动 PDF 只保存内部副本对应的 Asset 和 user/manual-pdf LiteratureAsset，source_url 为空；用户绝对路径和原文件不能进入 Catalog/ArtifactStore，对账或 NoUsableContent 清理不能触及原文件；
- 自动 route 的临时 `PdfCandidate`、tried key 和 `NoPrimaryPdf` 原因不进入核心 catalog；transfer candidate/receipt 按 [已有执行持久化](#238-已有执行持久化) 保存；自动获取耗尽行不反向扩展成 Acquisition 原因分类；
- 主 PDF 的文件发布或关系提交失败时只能观察完整旧状态或完整新状态，并向上返回系统错误，不能形成 `NoPrimaryPdf` 或已获得业务结果；
- ParserResult 首次发布或替换在每个文件 staging、create-if-absent、stale 复检和 SQLite 提交失败点都只能观察完整旧结果或完整新结果；失败保留旧当前关系，成功后 Catalog 不保留旧结果历史；
- ParserResult 的 Markdown 和每个实际引用资源均通过 hash、媒体类型和大小读取；未引用资源、Parser 私有 JSON/TEI、task 和过程文件不进入 Catalog；
- 三级状态读取投影与 `literature` 的纯规则共享同一 truth table 和测试样例；当前没有独立可写的 SQL view；
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
- 旧 LiteratureContent/ParserResult 兼容视图不保证完整历史；新知识和文档的有效版本依赖必须保留或明确失效。可重建不允许损坏来源元数据或原始 PDF，具体回收/恢复方案需另行设计；
- 独立材料失效决定按引用保护规则处理 LiteratureAsset/Asset；新分析不产生 PDF 清理决定。旧兼容清理路径、durable 发布记录与临时 tried set 分别验证，原始 MetadataObservation/AssetHint 不改成失败记录；
- 每个跨事实事务写入点失败时，只能观察完整旧视图或完整新视图；
- 文件 staging、发布和 SQLite commit 各崩溃点都保持已提交引用可读且 hash 一致；
- 对账不能在 publication-before-reference 窗口删除对象；
- 身份整理和删除不暴露部分关系转移；
- 共享文件仍被引用时不能回收；
- Catalog 只保存规范化相对路径，不保存大型 BLOB 或机器相关绝对路径。
- Network 动态准入、凭据/readiness/probe、Provider cursor、临时 tried set、Parser/LLM 私有现场、同步 Report、原始导入文件和导出文件不进入核心事实库；已有 execution failure 按 [已有执行持久化](#238-已有执行持久化) 保存，新依赖版本按 [新文档与知识存储设计](#41-新文档与知识存储设计) 保护。

## 6. ADR 0037 新增存储（实施中）

本节描述 ADR 0037 的目标存储，尚未实现。表名为计划中的建议名，以实施时的 schema 为准。

| 子系统 | 主要表 | 不可变产物 | 保护规则 |
| --- | --- | --- | --- |
| 原始解析 | `raw_parses`、`raw_parse_resources`、`raw_parse_current` | 区块列表 JSON、原始 v2 字节、Markdown、图片 | 被校订版本引用时不能回收 |
| 校订 | `proofread_versions`、`proofread_current`、`proofread_arbitrations`、`proofread_manual_decisions` | 区块列表、Markdown、资源闭包 | 被文档版本引用时不能回收；人工决定锁定 |
| 结构 | `structure_annotations` | 结构注释 JSON | 被内容版本引用时不能回收 |
| 元数据 | `literature_metadata` 列变更、`literature_metadata_field_states` | — | 锁定字段不被自动流程改写 |
| 标签 | `tags`、`tag_aliases`、`vocabulary_state`、`vocabulary_changes`、`literature_tag_assignments`、`literature_tag_items`、`tag_search` | 词表导出 | 词表写入串行；变更带撤销数据 |
| 建档 | 建档状态与失败项、版本事件 | — | 事件幂等消费 |
| 算子 | `snapshots`、`snapshot_members`、`processor_result_freshness` | 结果沿用现有不可变发布 | 快照不可变 |

- 真实库迁移与重建，只能在 Owner 授权（计划 GR）后先在隔离副本上执行。
- 四类旧数据在 GB 确认后删除，VLM Markdown 作为原始解析保留。
