# 07 · 版本化材料与知识存储技术设计

类型：规格
负责：不可变材料、版本依赖与 catalog 持久化
状态：现行

[设计总览](../design.md) · [九模块技术导航](../technical.md)

本模块对应设计中的 **⑦ 版本化材料与知识存储**，保存业务模块确认的结构化事实和不可变字节，并提供一致读取、发布、完整性校验与受控恢复。

内部包括 SQLite Catalog、ArtifactStore、写入准入、事务/文件发布以及版本依赖保护。③④⑤决定事实含义和是否接纳；⑦执行已确认决定。②的执行记录与业务事实分别保存，⑥只读已有提交。

Catalog v6 已为单篇知识产物增加独立表与精确依赖；Catalog v7 允许版本化集合综合产物，Catalog v8 append 独立知识检索投影。正式 operator 可用本篇 §4.1.11 的精确目标 CLI 显式初始化或升级；历史单步合成门禁保留。execution 子 schema 仍单独计版本。本篇保留现有表、文件和兼容语义；文档不授权代理执行真实用户数据迁移。

> 当前采用 [ADR 0037 第二版](../decisions/0037-literature-archive-and-proofread-text.md) 的原始解析、校订稿、结构、标签、建档与快照存储。唯一 schema.ts 的当前编号为 16；显式离线迁移与设备认证存储见第 8 节。打开旧库不隐式升级，正式库迁移须另行授权。

本篇目录：

- [1. 模块边界与连接](#1-模块边界与连接)
- [2. Catalog 与文件组织](#2-catalog-与文件组织)
- [3. 事务、发布、并发与恢复](#3-事务发布并发与恢复)
- [4. 知识版本、依赖与回收](#4-知识版本依赖与回收)
- [5. 存储完整性验证](#5-存储完整性验证)
- [6. ADR 0037 新增存储](#6-建档与校订存储)
- [7. 运行审查存储](#7-运行审查存储)
- [8. 设备认证存储](#8-设备认证存储)

## 1. 模块边界与连接

业务模块③④⑤和执行模块②提交已确认决定；本模块保存字节和关系并提供受控读取。

本篇按职责归并已有详细合同；示例中的现有类型与目标类型保持各自状态。文档归属不改变源码目录、事实所有权或当前公开 API。

## 2. Catalog 与文件组织

### 2.1 知识证据生命周期的目标变化

按 [ADR 0026](../decisions/0026-agent-knowledge-and-human-collaboration.md)，统一 Catalog/ArtifactStore 承载业务 owner 已确认的文档表示、证据依赖和不同用途知识产物；索引可重建，不成为第二事实库。单篇知识已有 v6 schema，集合综合在 v7 的精确依赖、比较域及不可变发布已接通；物理回收策略仍待设计，不能据文档直接操作用户数据。

原始解析、校订稿和结果分别版本化；材料失效/删除由独立业务决定驱动，分析失败不能产生删除命令。

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
- PDF、原始解析、校订稿和算子结果 的完整字节进入 ArtifactStore，SQLite 只保存 artifact identity、hash、大小、媒体类型和关系；
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

来源 observations 完整长期保存，但使用同样的关系化映射。`provenances` 对 Provider observation 保存 `metadata-provider` 来源字段；旧书目文件入口保存 `user/bibliographic-import` 及空 source record/input/parameters hash；有来源库编号的入库批次保存 `user/import`、规范化的来源库/记录定位与记录内容 hash。原始书目文件字节不进入 Catalog；通用外部对应与会话见[导入会话与外部编号对应](#9-导入会话与外部编号对应)：

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

#### 2.3.4 Asset、原始解析与校订稿

Asset 保存 hash/大小/媒体类型与规范相对引用。raw_parses 按资产/profile 保存原始解析版本，raw_parse_current 是明确的当前指针。proofread_versions 保存校订版本，manual decisions 不被自动覆盖。complete 校订稿显式发布 DocumentVersion v2；原始解析不直接成为默认全文。内容均在 FileStore，SQLite 不保存大型 BLOB。

**初稿的存储。** 按 [ADR 0060](../decisions/0060-two-level-full-text.md) 与[文档与证据 8.2、8.3](04-document-evidence.md#83-初稿的结构与核对依据)，初稿是 DocumentVersion 的一级。schema 17 这样保存它：

- **版本行。** 初稿与校订稿放在同一张 `document_versions` 表里，不另建表。现有的默认关系、资源闭包表以及加工结果、提取回执、身份核验对文档版本的外键因此直接覆盖初稿。表要重建：
  - `schema_version` 取 2 或 3；
  - `proofread_id`、`proofread_content_sha256` 改为可空，只在 2 时必填；
  - 新增可空列 `raw_parse_id`、`raw_parse_result_sha256`、`page_layer_sha256`、`draft_method_sha256`，以及初稿内容的 artifact 四列（路径、SHA-256、字节数、媒体类型），只在 3 时必填；
  - CHECK 保证两组列按 `schema_version` 恰好一组非空；`raw_parse_id` 外键指向 `raw_parses`，初稿内容外键指向 `artifact_objects`，都是 `ON DELETE RESTRICT`；
  - 依赖这张表的视图与触发器（文献状态投影、检索来源水位等）随表一起替换，覆盖范围不变。
- **当前初稿。** `draft_current(part_asset_id PK, part_sha256, document_version_id, revision)` 记录每个部分的当前初稿，形式同 `proofread_current`，按 CAS 更新。默认文本按[文档与证据 8.5](04-document-evidence.md#85-默认文本内容版本与证据)由它和校订稿共同求出。默认文本是初稿时，`archive_current_parts` 视图给出的内容版本输入为 `json_object('text_level','draft','document_version_id',…)`（字段名与顺序固定）；是校订稿时，输入仍是原来的 `{"document_version_id":…,"structure_annotation_id":…}`，逐字节不变。默认关系不由触发器推断：切换当前原始解析、登记或复用初稿、发布校订稿，三个写入口在各自的事务里调用同一个重求函数（优先完整的当前校订稿，其次当前初稿，都没有则删除默认关系）。
- **版本事实。** `draft_version_facts(document_version_id PK, differs_segments, differences, image_only_pages)`，在登记初稿版本的同一事务写入，之后不改。三个数都能从初稿内容重算；保存它们是为了文献库筛选与排序不读文件（[有意保存与有意推导](#236-有意保存与有意推导)）。
- **文件。** 初稿内容（含差异记录）、Markdown 与结构都是 create-if-absent 的不可变文件。新分类目录为 `parsed/draft/content` 与 `parsed/draft/markdown`；结构沿用 `parsed/structure`，图片沿用原始解析的资源对象，不复制。catalog 只存引用、hash、字节数与上面的计数。
- **对原始解析的保护。** 初稿行对 `raw_parse_id` 的外键就是保护，不另建 pin 表，也不往 `raw_parse_pins` 写行（该表仍只记校订稿）。原始解析退役（`retire`）的“仍在使用”判断增加一条：有文档版本引用它时返回 `raw-parse-in-use`，不能靠外键错误报出。
- **迁移。** 16 → 17 是显式离线迁移，规则同[第 8 节](#8-设备认证存储)：精确输入布局与完整检查、拒绝运行中的任务和建档、事务内 DDL 与身份替换、全部旧表行数不变。现有校订稿行逐列不变，迁移不产生任何内容版本事件，不形成初稿。初稿只在迁移之后由解析或补形成操作（文档与证据 8.11）产生。

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

`LiteratureSearchItem`、`LibrarySearchPage`、`LiteratureAssetView`、`LiteratureDetail`、`LiteratureReferencePage` 和 `ReferenceDetail` 都在查询时由上述权威行、唯一关系、聚合值和稳定 artifact 引用临时组装。Catalog 不建立 search item、page、detail、asset view、missing step、引用数量、关系读取 DTO 或其它完整读取 DTO 投影表；这些对象没有独立 ID、provenance、revision 或写入操作。`LiteratureDetail` 必须在同一个 read-only SQLite snapshot 中读取 Literature/MetaLiterature、metadata binding、observations、资产关系、当前原始解析/校订稿/建档状态、其它版本与 Reference 数量，再使用已经提交的不可变 artifact 引用读取需要的结构化内容，不能把不同时间点的 current facts 拼成一个结果。

文献库性能路径：`literature_intake` 仅物化最早关联观测时间这一可重建的排序键，事务触发器维护，UTC 规范化与未物化时的 `min(julianday(observed_at))` 一致，无观测为 null；不产生独立业务身份或人工编辑入口。状态缓存的 `library_state_revision` 与 `library_state_changes` 只保存失效提示，六态、missing_step 及其它状态字段仍由同一个 archiveStates/deriveCurrentState 推导，不保存第二份就绪事实。

状态输入触发器在原事务中推进 revision，并按文献 ID 更新变化表的最近 revision；删除保留无外键 tombstone，供不同只读连接各自按水位消费，不在读取时删掉提示。资产和任务的反向关联有专用索引，单个触发器最多定位 32 篇；找不到归属或超过此数则只推进 full_revision。原始解析版本/当前指针可能经 pin 影响其它校订稿，保守全量失效；身份行更新也全量失效。完整表集合及映射由 schema.ts 维护，写入不扫描全库。

读取在同一快照中比较 catalog/schema 身份、标签上限、解析 profile 与版本水位。通常只读最近改变的至多 64 篇，再替换其派生值；更多篇、全量标记领先、未追踪的 revision 更新、身份或配置改变都退回全量。未追踪的计数器写入由 tracked_revision 守护提升全量标记。缓存先复制旧 Map，在候选 Map 中计算、移除已删除文献，最后一次 checkpoint 通过后才同时发布完整 Map 与水位；失败或取消保留原缓存。Map 的复制仍随缓存篇数增长，但不重读或重新推导未变化文献。冷连接仍需一次全量构建。已有 catalog 的转换必须显式离线执行，不在启动时自动迁移。

`LiteratureReferencePage` 在同一 snapshot 中读取指定端点的权威 Reference、相关 Literature current facts 和每条边的 support count；`ReferenceDetail` 在同一 snapshot 中读取 Reference 两端和全部当前 support。正向和反向列表都查询 `literature_references`，不能物化 cited-by 副本。关系页面的固定排序、total 和 cursor 位置必须来自同一读取视图；后续页面可以看到后续提交的 current facts，但单页内部不能混合提交前后状态。

#### 2.3.7 不持久化的核心查询投影与临时现场

以下约束针对核心文献事实和同步 completion 临时现场；[已有执行持久化](#238-已有执行持久化) 中明确拥有的 durable execution 合同是独立持久化边界：

- Network permit、等待队列、冷却、窗口计数、`Retry-After`、`next_allowed_at` 和 `blocked_until`；
- Provider/LLM/MinerU 凭据、凭据字段状态、readiness、`config test` 结果/时间和服务健康状态；secret 只由 Configuration 管理在唯一用户级凭据文件中，不属于逻辑文献数据库；
- HTTP/浏览器现场、Provider cursor、request/response 和 vendor SDK object；
- 搜索候选、相关度、原始扫描/接纳/拒绝计数、分页中间状态和未接纳结果；
- 自动 route 内部 `PdfCandidate`、临时 candidate key/tried set；它们不同于 [已有执行持久化](#238-已有执行持久化) 的 transfer candidate、attempt 和发布回执；
- Parser 外部 task、调试 PDF、middle/model 输出、未引用资源与未接纳结果；中性区块、原始 v2 和资源闭包由 RawParse 保存；
- LLM prompt/request/response、第一阶段 metadata proposal、第二阶段 Markdown 草稿、临时 `ReferenceLookup` 和两次调用的独立 provenance；
- 同步 completion 的 BatchRequest/selector、目标和内存 Report；显式 durable Job 持有自己的 selector、targets、attempts 与结果事件，不能套用此禁令；
- LibraryQuery/LibrarySearchRequest/LiteratureReferenceRequest 的调用现场、cursor、SearchItem/SearchPage、LiteratureAssetView、LiteratureDetail、LiteratureReferenceItem/Page 和 ReferenceDetail 查询投影；
- 每个中间请求的任意调试副本；有效文档与结果依赖不是可随意清除的缓存；
- 用户本地 PDF 的绝对路径和原文件；
- SQLite 大型 BLOB、原始书目导入文件字节、来源工具的完整私有对象和导出文件；通用外部编号、入库批次及其工作状态按各自合同保存。

其中需要向用户呈现的稳定脱敏 failure 进入本次 Report；日志可以旁路输出安全诊断，但不能替代 Report。failure 不建立 Catalog current-failure 投影，不能恢复外部现场或决定 Literature 状态。自动 PDF 获取耗尽不保存失败内容，它只是影响下次自动选择的当前事实。

#### 2.3.8 已有执行持久化

Catalog 只有 schema.ts 一份结构。execution/runtime 指纹标识其内部子集，不是可独立迁移的数据库版本。

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
- 每个输入 Asset 的原始解析 Markdown 与实际引用资源；
- 校订区块、结构注释和算子结果的规范序列化；
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
  knowledge/results/<hh>/<sha256>.json # 不可变算子结果
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

来源 observation、统一元数据与原始 PDF 优先长期保存。原始解析、校订稿、结构和算子结果按引用关系保护，不能因为可重建而丢失有效证据。

原始解析有不可变版本和按资产/profile 的当前指针。换当前指针不覆盖旧字节；旧版本仍被校订稿引用时禁止回收。

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
7. 导入记录的不可变用户 MetadataObservation、身份接纳、当前统一初始元数据更新、自动 PDF 获取耗尽事实清除及入库批次成员；新会话逐条结果/外部对应在随后短事务检查点保存，稳定 observation ID 支持中途崩溃重放。旧书目文件入口沿用完全重复 user/bibliographic-import 的语义复用；`READY` 时不拆开替换当前 metadata/content。原始导入字节留在 FileStore，不作为 SQLite BLOB；
8. 自动或手动主 Asset 文件事实、唯一 `primary-pdf` LiteratureAsset 关系与已有自动获取耗尽事实清除；手动输入绝对路径不进入行；
9. 用户明确重试自动 PDF 获取前，删除对应 Literature 的自动获取耗尽事实；
10. 新 RawParse 的不可变版本登记与对应资产/profile 当前指针切换；
11. 元数据字段裁决与 revision/hash、描述版本事件在同一事务发布；人工锁定不能被自动覆盖；
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
7. 建立文件关系；主 PDF 唯一，原始解析按资产/profile 管理当前指针，校订文档使用独立默认版本 CAS；
8. 更新读取 view 与 FTS 后提交。

SQLite commit 前崩溃最多留下无引用孤儿，不能产生指向缺失文件的有效数据库关系。

任何文件回收须先核查所有保留引用，并与读取/写入准入协调。失败不能撤销新当前关系或删除共享字节。

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

**遗留暂存文件的清理**（目标，尚未实现，计划 20 的 13 块）：

- 清理的对象：`.staging/` 中的暂存文件，它没有登记在任何未结束的入库批次下，并且最后写入时间早于 1 小时。
- 入库的字节路由两次收到数据之间最长 60 秒（[产品接口 2.4.3](01-product-interface.md#243-传输请求时长与-content-type)），所以超过 1 小时没有写入的文件已经没有写者。
- 只由服务进程清理：启动时一次，之后每小时一次。CLI 与 stdio MCP 进程不清理。
- 每次清理记一条运行日志，写明删除的个数与字节数，不进 catalog。
- 清理不触及 `.candidates/` 中仍有记录的候选文件，也不触及正式对象区。

下一次运行和恢复以 Catalog 与 ArtifactStore 中已经完整提交的 current facts 为依据。临时 staging、外部 task、Parser/LLM 草稿和内存队列不是权威业务现场。已有 durable candidate/receipt、publication/reclamation 记录按各自合同恢复，不能由孤立文件推断接纳成功。

### 3.5 数据与生命周期

文件系统保存 PDF、原始解析、校订稿和其它大字节；SQLite/catalog 只保存规范相对引用、hash、relation、
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

候选、下载回执、durable job/target/attempt/event 都位于统一 catalog。运行事实与文献事实有各自 owner，同一当前 schema 初始化；没有 upgrade-synthetic 或独立 execution 迁移入口。候选按固定 Asset/目标与执行身份接纳，原始字节先发布，再在短事务保存关系和回执。重开不伪造未完成 Agent/Browser 操作成功；恢复读取已提交结果并报告未完成工作。

## 4. 知识版本、依赖与回收

### 4.1 当前 schema 与显式转换

`storage/sqlite/schema.ts` 是唯一当前结构定义，内部标识 17 与精确指纹共同验证。启动不自动升级旧库。15 → 16（统一入库，`scripts/migrate-import-v16.mjs`）与 16 → 17（两级文本，`scripts/migrate-draft-text-v17.mjs`）各有专用离线迁移：精确输入布局，拒绝运行中的任务与建档，事务内重建并核对完整布局、完整性、外键与全部旧表行数，失败时库保持原布局、可以重跑；16 → 17 原地重建 `document_versions`，校订稿行、内容版本与加工结果的过时状态不变，不形成初稿（补形成见[文档与证据 8.11](04-document-evidence.md#811-补形成初稿的维护操作)）。状态投影 12 → 13 的专用离线迁移增加失效提示及索引、替换触发器和身份，并核对完整布局、完整性、全部旧表行数及外键，不改文献资产或重建正文；已运行的任务须先停止。旧 11 → 12 建档转换仍固定到 12，再显式执行状态投影转换；历史布局只作为这些离线工具的精确输入，不被运行时接受。操作步骤归[初始化与恢复指南](../../guides/upgrade.md#状态投影-schema-13)。`initializeCatalogSchema` 仅创建空目标；未知/旧结构拒绝。转换不恢复运行时 schema-v\* 兼容或逐级自动迁移。

Owner 已授权在转换副本删除旧总结、旧知识、旧算子结果和 markdown-utf8-v1 文档；VLM Markdown 经验证登记为原始解析，共享 PDF/图片不能删除。未知事实、外部回执引用等超出删除范围的依赖必须拒绝并报告。切换仍须单独确认，并先处理备份后的源库增量。

### 4.2 数据与写入所有权

Literature 拥有元数据与引用；Parsing 拥有原始结果；Proofread 拥有矫正/人工决定；Document 拥有固定表示与结构注释；Tags 拥有词表/赋值；Archive 编排步骤和就绪；Analysis 拥有结果/集合。Storage 执行已确认的事务和引用保护，不推断业务结论。

内容与描述版本事件在同一事务发布。单篇算子只因所读部分的内容变化过时；描述变化不会让其失效。快照不可变，多篇结果依赖固定成员和版本。原始解析被校订稿引用、校订稿被文档引用、文档被结果/外部回执引用时受保护，不能凭“可重建”清理。

**两级文本的写入所有权。**

- Document 拥有初稿版本、当前初稿指针与初稿版本事实（[2.3.4](#234-asset原始解析与校订稿)）。形成初稿的写入由 Parsing 的解析操作或 Document 的补形成维护操作发起，经 Document 的发布 Port 提交；默认关系仍由 Document 按独立 CAS 更新。
- 被有效结果引用的初稿版本与校订稿一样受保护：`processor_result_documents` 等外键已覆盖。初稿版本引用的原始解析同样不能退役。
- “找不到”的引用投影：`processor_unfound_citations(result_id, record_id, pointer, document_version_id, PRIMARY KEY(result_id, record_id, pointer, document_version_id))`。每行是一个用时核对为 `not-found` 的值，以及它的来源所引用的初稿版本。
  - 写入方是 Analysis，在发布结果的同一事务内写入，结果删除时级联删除；Storage 只执行写入与约束。表已在 schema 17 建好，写入随加工读取初稿（知识加工提案）接入，在此之前为空。
  - 只为引用初稿版本（`schema_version` 3）的来源写行。schema 17 之前不存在初稿，所以没有已发布结果需要回填。
  - 它是可重建投影：内容由结果文件确定，可从结果文件重建，不是第二份事实。
  - `processor_result_documents` 在 schema 17 增加按 `document_version_id` 的索引，两项聚合（[文档与证据 8.7](04-document-evidence.md#87-选择校订范围的事实)）都按版本查索引，不扫描全部结果。
- 被引片段的投影（目标，尚未实现）：`processor_result_citations(document_version_id, segment_id, result_id, entry_ref, PRIMARY KEY(document_version_id, segment_id, result_id, entry_ref))`。每行是一份结果里的一个条目对某个文档版本的一个片段的直接引用。
  - 用途是按版本列出被引片段（[知识加工 8.12](05-knowledge-processing.md#812-视图机器读取与导出)的 `material-evidence`），不必打开结果文件。
  - 写入方是 Analysis，在发布结果的同一事务内写入，结果删除时级联删除；Storage 只执行写入与约束。
  - 只记直接引用文本位置的条目；汇总经上游条目的间接引用不记。
  - 它是可重建投影：内容由结果文件确定，可从结果文件重建，不是第二份事实。它随提供 `material-evidence` 的那次结构变更加入，已发布的结果由同一次离线迁移从结果文件回填。

### 4.3 投影与只读应用

全文和结果 FTS 是可重建投影，读取不重建、不调用模型。损坏或陈旧有明确缺口；显式维护才能更新，失败保留可用来源和此前有效投影。QueryApplication 使用独立只读连接，关闭等待在途读取，拒绝新工作。

## 5. 存储完整性验证

普通打开只核对当前 schema identity/fingerprint、两个执行层 identity，以及一次 `sqlite_master` 清单中的必需表、索引、触发器和精确 DDL；拒绝未知对象和不支持的布局。只读源读取保留可重建检索投影的隔离口径。检查不读取业务表数据，不执行逐表或全库 integrity_check/foreign_key_check，不随文献条数增长。布局证明按 SQLite schema_version 与文件 inode 复用，普通外部提交后的重连不升级为健康扫描。`ready` 只证明布局可读，不是全库健康证明。

生产与合成 Web 启动先用 `catalogNeedsInitialization` 探测目标：只校验路径/普通文件，并用一次 `sqlite_master ... LIMIT 1` 区分空库与非空库，不检查业务数据。非空库直接进入上述 Application 布局检查，不在启动门调用显式 inspection；合成启动另外保留位置授权。文件缺失或真正空库的初始化判据不放宽，已有目标不得覆盖。

`maintenance verify-catalog` 显式核验 SQLite 数据、外键、当前布局及 active 检索代的计数/哈希证书；HTTP 为 `POST /api/v1/maintenance/verify-catalog`，使用 protocol_version=1 封套和 request `{kind:"verify"}`；MCP 为 `verify_catalog`，参数 `{}`。三者使用同一维护口径，不要求已建立全文索引，不修复、不读模型或 Provider。耗时检查在独立检索 worker 的固定读取快照中执行，不占用普通库查询 worker 或 catalog 写入 admission。`storage schema-inspect` 与 `storage retrieval-inspect` 也保留显式完整检查。退役代的回收与逻辑校验范围、来源正文与索引文字的逐条核验由[检索技术篇](06-retrieval-context.md#49-材料-context-的实现边界)定义。

源库实际读取/写入时报告 SQLITE_CORRUPT 或 SQLITE_NOTADB，边界返回 `catalog-corrupt`，附 `maintenance_hint="verify-catalog"` 和技术详情 sqlite_code；不转成 not-initialized 或吞为通用 unavailable。可重建检索投影继续使用检索合同的 index-corrupt 与重建提示。布局正确而数据页已损坏的库可以先通过轻量打开，在访问损坏页或显式核验时失败。只有文件不存在或真正空库属于未初始化。备份 `backupExecution`、恢复 `restoreCheck` 及显式 schema 转换继续保留完整检查；普通打开不会代替它们。

自动回归覆盖：

- 轻量打开的指纹、执行层身份和未知/缺失 DDL 拒绝；显式完整性与外键检查；
- 来源 observation、稳定身份、原始 PDF 与资源闭包在失败和重开后保留；
- 不可变字节发布与 SQL CAS，取消、并发和索引失败不会丢失有效事实；
- 字段/区块/标签锁定，版本事件和快照过时的事务一致性；
- 校订未完成不能发布默认文档；疑点处置中的“无法确定”不单独阻断 complete，就绪只由正文要求决定。片段不再保存存疑字段，无法转写的图像区块保留为空文字；
- 外部候选回执与结果的证据版本保护；
- 一次性副本转换的明确删除范围、保守身份索引、源库不变与目标覆盖拒绝。

## 6. 建档与校订存储

以下为唯一当前 schema 中的主要表，普通打开不执行转换。

| 子系统   | 主要表                                                                                                                              | 不可变产物                                  | 保护规则                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------- |
| 原始解析 | `raw_parses`、`raw_parse_resources`、`raw_parse_current`                                                                            | 区块列表 JSON、原始 v2 字节、Markdown、图片 | 被校订版本引用时不能回收               |
| 校订     | `proofread_versions`、`proofread_current`、`proofread_correction_cache`、`proofread_manual_decisions`                               | 区块列表、Markdown、资源闭包                | 被文档版本引用时不能回收；人工决定锁定 |
| 结构     | `structure_annotations`                                                                                                             | 结构注释 JSON                               | 被内容版本引用时不能回收               |
| 元数据   | `literature_metadata` 列变更、`literature_metadata_field_states`                                                                    | —                                           | 锁定字段不被自动流程改写               |
| 标签     | `tags`、`tag_aliases`、`vocabulary_state`、`vocabulary_changes`、`literature_tag_assignments`、`literature_tag_items`、`tag_search` | 词表导出                                    | 词表写入串行；变更带撤销数据           |
| 建档     | 建档状态与失败项、版本事件                                                                                                          | —                                           | 事件幂等消费                           |
| 算子     | `snapshots`、`snapshot_members`、`processor_result_freshness`                                                                       | 结果沿用现有不可变发布                      | 快照不可变                             |

真实库转换按[切换指南](../../guides/cutover.md)独立授权并在副本核对；不从本文推出数据删除或模型重建许可。

## 7. 运行审查存储

Application 拥有操作审计与过程投影。`operation_records` 保存入口会话、操作名及允许的 ID/revision，不存凭据或全文；`job_origins` 固定发起身份。`agent_sessions`/`agent_session_events` 保存脱敏摘要、工具参数/结果、页码区域、提交理由及用量；每事件有界，每会话最多 2 MiB（含计量开销），超限标注并继续累计用量。不保存图片字节、完整上下文或隐藏推理。普通关闭结算会话；进程异常退出的未结束会话不会被当作已完成。

服务启动及每小时清理结束满 7 天的会话和事件。`task_model_usage` 独立保存已结算用量，`task_steps` 固定本次 job 的步骤，不被后来建档覆盖。清理过程不删除结果、来源或任务用量。`agent_view_revision` 与触发器供事件推送读取有界版本号，不通过轮询全量历史判断变化。

Analysis 的 `processor_result_summaries` 保存已发布结果用量/覆盖摘要；`processor_run_requests` 保存实际提交范围，供运行筛选和来源展示。表结构全部写入当前 `schema.ts`，版本号不变；精确指纹改变后仍要求显式核对已有库，普通启动不自动补表。此前正式库切换不代表本轮新增表已部署。

任务发起身份和任务、策略、固定目标同一事务发布。综合逐篇进度使用原有 execution_events 中的 processor-map-progress 事件，不新增表；每篇新算、复用、部分完成、失败和中断均固定到本次目标。task-run 的 target_id/member_offset/member_limit 按页读取，根投影不隐式装载大型快照的全部成员。共享模型生命周期在关闭时等待过程记录收尾，再释放存储。

第二轮库组织新增 `snapshot_labels`（显示名与不可变快照 hash 分离）、`folders`、`folder_members`、`reading_history`。已有 `processor_result_summaries` 增加 `method_revision`，`processor_result_currentness` 只读投影将旧方法标为过时；旧统计无法代表当前三计数时返回 null，不迁移、不当作零。所有 DDL 仍在 schema.ts。schema 13 换为按文献增量更新的文献状态投影；schema 14 新增 `reading_marks`（阅读批注，ADR 0046），由 `scripts/migrate-reading-marks-v14.mjs` 从 13 显式升级。已有正式库需要授权后在副本显式更新，启动不会自动加表。

**目标（尚未实现）：用户整理的两张表。** 按[用户整理 9.1、9.4](09-user-organization.md#9-尚未实现)，下一次 schema 升级增加：

| 表                  | 字段与约束                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| saved_filters       | filter_id TEXT PK（随机 UUID）；name 非空、UNIQUE；query_json 合法 JSON（解析后的规范 `LibraryQuery`）；sort 非空；created_at、updated_at（TEXT NOT NULL，由服务写入 UTC ISO 8601 时间，不设 SQL 默认值，同 folders）。不保存操作人，同 folders；不进入 `LIBRARY_STATE_INPUT_TABLES`                                                                                                                          |
| reading_mark_places | PK(mark_id,target_kind,target_id)；mark_id FK→reading_marks，ON DELETE CASCADE；target_kind 为 pdf 或 document；target_id 为 PDF sha256（64 字符）或 document_version_id；pdf_page、pdf_rects_json 与 document_start_utf8、document_end_utf8 两组按 target_kind 恰好一组非空；similarity 在 0.7–1；method 非空；located_at（TEXT NOT NULL，写法同上）。是可重建的缓存，不设对文档版本的外键，同 reading_marks |

两表都只由离线迁移加入，启动不自动加表；它们不推进文献状态或检索 source revision。

## 8. 设备认证存储

按 ADR 0058，Web transport 认证 owner 提交设备连接事实，Storage 仅保存派生值与生命周期。单一 schema 16 在原 15 上增加：

| 表                     | 字段与约束                                                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| device_connections     | connection_id TEXT PK；name 非空、最多 120；purposes_json 合法 JSON；kind TEXT nullable，非空时为 extension 或 agent（schema 18 加入，旧行为 null）；token_sha256 nullable UNIQUE，非空时 64 字符；created_at、nullable paired_at/last_used_at/revoked_at |
| device_pairings        | code_sha256 TEXT PK（64 字符）；connection_id UNIQUE FK→device_connections，ON DELETE CASCADE；expires_at、nullable used_at                                                                                                                               |
| device_exchange_limits | bucket TEXT PK；window_start INTEGER；attempts 正整数                                                                                                                                                                                                     |

令牌和配对码各为 32 个随机字节（256 位），catalog 只保存 SHA-256，不保存原值；原值不跨 SQLite worker 边界，不写 artifact。用途由认证 owner 的封闭列表校验，目标值为 `intake`、`read`、`operate`（[产品接口 2.4.1](01-product-interface.md#241-设备连接与按用途准入)），旧值 `capture`、`import` 不再接受，也不转换；令牌派生值可为空以表示尚未配对。配对成功在同一事务中标记 used_at 并安装 token 派生值，失败/限流计数也提交以阻止重试绕过。每次认证直接核对已撤销状态。目标（尚未实现，计划 20 的 14 块）：最近使用时间合并写入，同一个连接距上次写入不足 5 分钟时只读核对；交换限流表只保存 socket peer 地址的 hash，不再有全局桶，每个地址每 60 秒 30 次；表最多 256 行，满时淘汰 `window_start` 最早的一行，不因表满而拒绝。它们不推进文献状态或检索 source revision。

`schema.ts` 冻结 `SCHEMA_MANIFEST_V15` 与 fingerprint 仅供离线工具证明输入，不增加 opener 支持的布局。`scripts/migrate-import-v16.mjs` 对显式绝对路径的离线 15 库执行 15→16：catalog admission、精确输入布局及完整检查、拒绝 queued/running 任务和运行中建档、事务内 DDL 和身份替换、全部旧表行数不变、输出布局及外键检查，成功才提交。M1 的后续导入/收藏表追加到同一个 `IMPORT_SCHEMA_V16`，回填放在同一迁移事务，不自动另起版本。已有 14→15 工具固定目标仍为 15，随后须显式执行 15→16；schema 不匹配时运行入口拒绝服务，不做隐式转换。

设备 HTTP 形状、错误和用途登记的唯一接口说明见[设备连接](01-product-interface.md#241-设备连接与按用途准入)。

## 9. 导入会话与外部编号对应

Entry 的 ImportSessionService 提交通用工作流状态，Literature、FolderService 与 Acquisition 分别拥有文献、文件夹与主 PDF。它们共用同一个 catalog admission 和 FileStore；不建立来源专用表。`IMPORT_SCHEMA_V16` 的 7 张导入表与[设备表](#8-设备认证存储)由同一个 15→16 脚本创建：

| 表                       | 字段与约束                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| import_libraries         | library_key PK；system、external_library_id、identity_scope、name、created_at；来源身份是规范化 hash，显示名不参与匹配                                                                                                                                              |
| external_object_mappings | PK(library_key,object_kind,external_id)；internal_id、nullable content_sha256/observation_id；kind 为 record/group/file/annotation，library_key FK RESTRICT；多类目标不设单一目标 FK，保留对应供 owner 检查已删除目标                                               |
| import_sessions          | session_id PK；library_key FK、library_json、format、scope、file_name、import_user_tags、state、生命周期时间、initiated_by/origin、batch_id FK、metadata_complete、record_count、summary_json；活动状态对 library_key 的部分唯一索引；按创建时间与状态/过期时间索引 |
| import_parts             | PK(session_id,sequence)，sequence 在 0–1,023；artifact_id FK RESTRICT、record_count；session FK CASCADE                                                                                                                                                             |
| import_staged_keys       | PK(session_id,object_kind,external_id)，同一会话跨段去重；(session_id,sequence) FK→import_parts CASCADE，替换序号时相应旧键一起退役                                                                                                                                 |
| import_record_results    | PK(session_id,sequence,record_index)；external_id、disposition、nullable literature_id/meta_literature_id/reason；文献删除时置空 literature_id；报告保留接纳结果                                                                                                    |
| import_files             | file_id PK、session_id FK、UNIQUE(session_id,external_id)；record_external_id、literature_id FK CASCADE、file_name、size_bytes、expected_sha256、action、status、sha256、reason；pending 索引按会话/状态/ID                                                         |

原始分段以规范 JSON 保存为 `imports/sources/<hash-prefix>/<hash>.json`；artifact_objects 保存相对引用、媒体类型、字节数和 SHA-256，import_parts 只引用登记。替换及终态退役使用既有 write-ahead reclamation ticket；先删除引用后回收字节，仍被其它活跃引用使用的对象不能删除。启动/定时维护还会清理终态遗留引用，避免提交后崩溃永久保留原始数据。

确认与建立批次在同一事务固定状态。单条身份与批次成员按原发布事务接纳；结果、来源对应和文件清单在短事务中检查点保存。结果前崩溃时，用来源键、外部号与内容哈希派生的稳定 observation ID 重放，并恢复原批次分类；不把已接纳文献当作整场事务回滚。文件落库使用既有不可变 candidate publication；同文件的结算在 admission 内重读状态和哈希，完成/取消在本进程等待在途发布结算。跨进程来源活动唯一性由索引保证；不宣称与另一进程正在进行的文件发布有跨进程取消事务。

会话终结后保留外部对应、逐条结果、文件结算与摘要，删除原始数据。报告的记录统计逐条计数，批次成员按文献去重；生命周期与业务分类见[书目交换规则](03-literature-materials.md#61-书目交换规则)。历史书目导入不补造来源库/外部编号，迁移保存全部旧事实行数。

现在的收藏另有 `capture_daily_batches` 与 `capture_items` 两张表；目标是由下面的 `intake_open_batches` 与 `intake_page_requests` 取代，见 [9.1](#91-schema-16-的目标变化目标尚未实现)。JSON 只保存有界接纳投影和单文件状态，没有原始页面、Cookie、令牌或大文件字节。

### 9.1 schema 16 的目标变化（目标，尚未实现）

目标，尚未实现（计划 20 的 14–16 块已实现，撤回为计划 25 的 13 块；24.1 核对后改为现状）。下列变化都并入同一个 `IMPORT_SCHEMA_V16` 与同一个 15→16 迁移；正式库还在 15，16 没有部署过，开发库与测试库不提供升级路径，重新建库。

| 表                                                                            | 变化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 依据                           | 所属 Task                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------- |
| `intake_batches`                                                              | 删去 `status`，改为 `state`（6 个值）与 nullable `result`（4 个值），并检查 `result` 只在 `finished`、`withdrawn` 时非空。增加 nullable 的 `confirmation`（batch/per-item）与 `confirmed_at`，以及 NOT NULL 的 `initiated_by`。15 的旧行回填：`running` 对应 state running；其余对应 state finished 加同名 result；`initiated_by` 取 `local:<origin>`，origin 为 migration 的取 `migration`                                                                                                      | 查询 2.1.6                     | 14.3                                                                   |
| `import_sessions`                                                             | 主键 `session_id` 改为 `batch_id`，FK→intake_batches。删去自己的 `state`，改为 `active` 标记（0/1），与批次状态在同一事务中维护；“同一来源一个活动批次”的部分唯一索引改为 `ON import_sessions(library_key) WHERE active=1`。增加 `phase`（metadata/files/closing）与 `storage_failures`（连续存储错误次数）                                                                                                                                                                                      | 文献与材料 6.4.2               | 14.3                                                                   |
| `import_parts`、`import_staged_keys`、`import_record_results`、`import_files` | 外键列 `session_id` 改名为 `batch_id`。`import_record_results` 增加 `item_id`，`disposition` 增加 `pending-decision`、`excluded`。`import_files` 增加 nullable 的 `item_id` 与 `source_url`                                                                                                                                                                                                                                                                                                      | 文献与材料 6.4.5、6.4.10       | 14.3、14.4                                                             |
| `intake_items`（新）                                                          | 每个条目一行：item_id PK、batch_id FK CASCADE、origin（data/file/page）、nullable 的 sequence/record_index/external_id/title/file_name；只有文件的条目的暂存候选 `candidate_transfer_id`（指向 `.candidates/` 的持久候选）；`recognition_json`、`possible_duplicates_json`、`unpaired`、`needs_decision`、`decision_json`、`decided_by`、`decided_at`、`disposition`、nullable `literature_id`（FK，文献删除时置空）、`retain_until`（待决定条目的 30 天期限）。数据分段的条目在第一次预览时建行 | 文献与材料 6.4.3、6.4.6、6.4.8 | 15.1（认篇与暂存的列）、16.1（可能重复与决定的列）；表本身由 15.1 建立 |
| `capture_daily_batches`                                                       | 删除，由 `intake_open_batches` 取代                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 文献与材料 6.4.2               | 14.4                                                                   |
| `intake_open_batches`（新）                                                   | PK(opener, day)；opener 为 `device:<connection_id>` 或 `supplement:web\|cli\|mcp`；day 为服务端系统时区的日期；batch_id UNIQUE FK→intake_batches                                                                                                                                                                                                                                                                                                                                                 | 文献与材料 6.4.2               | 14.4                                                                   |
| `capture_items`                                                               | 删除，由 `intake_page_requests` 取代；单篇收藏的结果与文件状态改存在 `intake_items` 与 `import_files`                                                                                                                                                                                                                                                                                                                                                                                            | 产品接口 2.4.2                 | 14.4                                                                   |
| `intake_page_requests`（新）                                                  | PK(connection_id, request_id)；request_sha256（64 字符）、item_id FK→intake_items、batch_id FK；只用于单篇收藏的重放幂等                                                                                                                                                                                                                                                                                                                                                                         | 产品接口 2.4.2                 | 14.4                                                                   |
| `literature_needs_metadata`（新）                                             | literature_id PK FK→literatures ON DELETE CASCADE；set_at；nullable batch_id。行存在即带“书目待补”标记，清除即删除行                                                                                                                                                                                                                                                                                                                                                                             | 文献与材料 8.4                 | 15.1                                                                   |
| `device_exchange_limits`                                                      | 增加索引 `ON device_exchange_limits(window_start)`，供淘汰最早的一行                                                                                                                                                                                                                                                                                                                                                                                                                             | 第 8 节                        | 14.2                                                                   |
| `intake_batch_objects`（新）                                                  | PK(object_kind, object_id)；batch_id FK→intake_batches；object_kind 为 folder、folder-member、literature-asset、mark，schema 18 起另有 literature（本批新建的文献；16、17 的冻结定义不含它，17→18 迁移按新约束重建这张表并保留原有行）；记录哪个批次新建了这些对象，供撤回判断“本批新增”与“登记之前形成”                                                                                                                                                                                         | 文献与材料 6.4.11              | 17.2                                                                   |
| `intake_withdrawals`（新）                                                    | batch_id PK FK→intake_batches；prior_state（finished/cancelled）、withdrawn_at、withdrawn_by、nullable restored_at、report_json、nullable restoration_json；记录撤回与整批恢复                                                                                                                                                                                                                                                                                                                   | 文献与材料 6.4.11              | 17.2                                                                   |
| `intake_withdrawn_objects`（新）                                              | PK(object_kind, object_id)；batch_id FK；object_kind 为 literature、literature-asset、folder、folder-member、mark；withdrawn_at。行存在即该对象处于撤回状态，恢复即删除行；读取路径据此排除                                                                                                                                                                                                                                                                                                      | 文献与材料 6.4.11；查询 2.1.1  | 17.2                                                                   |
| `intake_batch_members`、`import_record_results`                               | `disposition` 增加 `restored`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 文献与材料 6.4.11              | 17.2                                                                   |
| `external_object_mappings`                                                    | 增加 NOT NULL 的 `state`（`pending`/`settled`，默认 `settled`）。导入建文件夹时先写 `pending` 的对应、预留 `internal_id`，文件夹建好后改为 `settled`；恢复时 `pending` 而文件夹不在，就用同一编号补建，`settled` 而文件夹不在，就报缺失。`content_sha256` 不再兼作这个标记                                                                                                                                                                                                                       |

**冻结之前要核对。**

- 撤回的三张表与 `restored` 分类已并入。读取路径的排除（列表、详情、计数、词频、全文检索、引用两端、发现原因、任务范围展开、文件夹与批注读取）属于撤回的行为，在计划 25 的 13 块实现；2026-11-15 已在合成库上演练撤回与恢复（计划 20 的 17.1），确认这些表足以支撑排除且身份匹配、sha256 对应与外部编号对应不排除，不需要再改表。
- `intake_items`、`literature_needs_metadata` 等新表不进入 `LIBRARY_STATE_INPUT_TABLES`，也不推进检索 source revision。查询读取时按需联接它们；`needs_metadata` 筛选不改变文献状态投影。
- 15 的旧行全部回填，所有旧表行数不变：`intake_batches` 的状态拆分与 `initiated_by`，以及 `import_*` 的外键改名。15 里没有会话与收藏表，这几张表的回填为空。
- 外键的级联与置空，和本节及第 9 节一致；`PRAGMA foreign_key_check` 为空。
- 所有写死 schema 编号的检查（`rg -n '\[1[5-6]\]\.includes' apps/server/src`）与 `SCHEMA_FINGERPRINT` 已更新。
- 迁移在正式库的只读副本上演练过，并记录耗时。
