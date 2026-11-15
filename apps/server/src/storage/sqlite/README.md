# SQLite catalog 与事务

保存单一当前 catalog schema、业务事实仓库和专用 SQL worker。

## 内容入口

- [catalog-schema.ts](catalog-schema.ts)：Catalog 版本与准入。
- [repositories.ts](repositories.ts)：文献等事实仓库。
- [worker.ts](worker.ts)：Worker 调用边界。
- [worker-runtime.ts](worker-runtime.ts)：SQLite worker 运行实现。
- [draft-text-engine.ts](draft-text-engine.ts)：初稿版本、资源闭包、不可变计数、当前指针及默认关系的同事务登记；按版本读事实、按本页文献批量读主 PDF 默认版本与等级。补形成候选共用文献库筛选和排序，在同一只读快照返回 PDF 部分、当前部署/历史 Markdown raw、指定 raw 的既有初稿 ID 和当前初稿方法；不读取正文或其它文件，业务跳过、limit 与任务冻结由应用层决定。
- [document-defaults.ts](document-defaults.ts)：原始解析当前切换、初稿登记与校订发布事务内按独立 CAS 重求默认文本，优先有效完整校订稿，再选有效当前初稿，否则删除默认关系。校订发布可提名刚登记的版本，仍复检当前校订内容、人工 revision 和原始解析 pin；相同校订内容的等价方法版本可以复用固定表示。没有提名时保留仍有效的默认表示。资产当前指针切换同时重求其全部文献关系；读取不重求。
- [draft-text-schema-migration.ts](draft-text-schema-migration.ts)：独立离线 16→17；精确匹配冻结 16，原地重建文档父表、子表不改名或重建，核对全部旧表行数及校订行、内容版本、事件和结果过时状态；不形成初稿，不访问 artifact。
- [library-state-cache.ts](library-state-cache.ts)：基于事务内输入版本的建档状态缓存。
- [library-state-schema-migration.ts](library-state-schema-migration.ts)：显式离线安装当前按篇失效结构；[library-state-previous-layout.ts](library-state-previous-layout.ts) 只描述工具的精确旧输入，不由 catalog opener 接受。
- [intake-engine.ts](intake-engine.ts)：入库批次及按文献去重的成员写入、改名与当前 PDF 状态读取；成员与 identity 发布共用事务。
- [capture-engine.ts](capture-engine.ts)：单篇网页的请求 UUID/规范输入 hash 与持久回执、设备按系统时区日期唯一的开放批次。条目存在 intake_items，文件存在 import_files，身份发布与批次成员复用相同事务边界；重放从已提交成员恢复分类，不再有独立收藏表。
- [intake-schema-migration.ts](intake-schema-migration.ts)：显式离线 14 → 15，旧运行回填、早期批次、主题词映射及确定性元数据/索引投影；[intake-metadata-migration.ts](intake-metadata-migration.ts) 复用元数据裁决与读取。
- [openalex-top-concepts-cleanup.ts](openalex-top-concepts-cleanup.ts)：显式离线删除旧 OpenAlex 观测中 19 个顶层大类，并复用关键词层重投影，仅更新受影响文献与 Library FTS；不改 schema，不由启动或查询调用。检索 source revision 正常推进，后续刷新追赶。
- [library-page.ts](library-page.ts)：LibraryQuery 的只读 SQL 筛选、计数和游标分页，完整文献只装载当前页；不修改业务事实或 catalog schema。
- [retrieval-engine.ts](retrieval-engine.ts)：材料检索持久化。
- [processor-engine.ts](processor-engine.ts)：算子结果、集合与固定引用的持久化。
- [review-engine.ts](review-engine.ts)：操作审计、DSH 有界历史、固定任务步骤、长期用量、运行和文献结果的分页投影。过程记录结束满 7 天后删除，结果不随之删除。

## 放置边界

材料检索刷新比对来源身份、元数据版本/hash、文档版本/表示/source asset hash 与默认状态，只重写变化文献；全量重建仍读取全部来源。索引各批写入沿用业务 catalog admission，构建间互斥由检索服务的独立 generation 锁负责。发布后与下次刷新时分批删除非 active 代的 FTS、条目及代头，未接纳暂存也按批回收，不自动 VACUUM。外部提交仍触发检索连接刷新；损坏索引修复文本暂存在独立的匿名临时 SQLite 连接中，允许落盘且关闭即清理，不新增 catalog 表，避免批次间业务写入丢失修复暂存或复用过时 FTS 视图。修复发布在主库同一事务内流式重建 FTS、校验并切换 active，失败保留旧指针。

表、索引、视图与事务内版本事件的触发器统一维护在当前 `schema.ts`；真实数据库不进入本目录，旧库不在启动时自动转换。

`catalog-identity.ts` 用一次 sqlite_master 清单和单例身份核对当前布局，普通写入/只读 worker 共享；打开不执行完整健康扫描。Web 启动仅用 `catalog-schema.ts` 的空目标探针，再由 Application 验证布局；该模块的显式 schema-inspect 保留完整检查。布局证明按 schema_version、文件 inode 和合同版本复用。`errors.ts` 保留真实 SQLite 损坏码，实际操作遇到损坏时提示显式 verify-catalog；完整核验由 retrieval-engine 的维护方法执行，不在普通读取前运行。FileStore 继续校验实际读取的文件字节。

[上级目录](../README.md)

只读对象图由 `bootstrap/application.ts` 固定组装普通查询 worker 与共享检索 worker，隔离冷索引校验对文献读取的排队影响；材料与知识 Context 共用一个检索连接 owner。校验规则、显式重建和写入 admission 不变，服务 drain 后由应用统一关闭。

- `metadata-rows.ts` / `metadata-field-storage.ts`：中性元数据读取及字段状态的原子保存；来源证据必须属于同一篇文献，建档提议提交时重新检查默认文档与结构注释。

当前数据库结构只由 `schema.ts` 定义；`catalog-layout.ts` 统一初始化空库，`catalog-schema.ts` 提供检查和显式创建。历史布局仅保留为专用离线工具的精确输入证明，不是运行时支持的另一套 schema。版本或指纹不匹配时拒绝按当前结构读取，不隐式转换已有库。

`raw-parsing-engine.ts`、`proofread-engine.ts`、`structure-annotation-engine.ts`、`metadata-field-storage.ts` 和 `archive-reference-engine.ts` 在同一当前结构中分别保存对应 owner 提交的事实。模块拆分不产生独立数据库版本。

`worker-runtime.ts` 的文档版本提交保留校订稿来源、raw pin、人工 revision、产物登记及默认版本 CAS 检查。`source-order-leaves-v4` 允许省略已登记的公式截图，实际引用的图片仍须逐一匹配同一校订稿的 reference、hash、路径和完整 artifact 描述；历史 builder 保留原来的图片数量检查。文档提交失败仅跨 worker 传递 `errors.ts` 中的有限错误码，不透传 SQL 文本、参数或文件路径。

`archive-engine.ts` 将建档第一步的完整解析回执写进既有 archive-progress 事件，与 task_steps 的状态更新同事务提交；校验文献、资产与 hash 绑定，不借用 reason。`review-engine.ts` 的任务步骤和建档步骤按 job、文献、资产取最近的解析事件投影 receipt；旧事件缺字段时省略，不继承较早尝试的回执。schema 和 task_steps 布局不变。

`tag-engine.ts` 实现词表与有序标签的事务端口、名称唯一索引、检索、回溯覆盖和可逆变更。业务变更规则由源码树内的 `tags/` 模块决定，数据库只提交已裁决事实。

`archive-engine.ts` 保存建档步骤、问题与统计，读取当前材料和描述的版本投影；就绪状态统一调用 `literature/state.ts`。版本变化在原事实的写入事务中记录，不依赖读取触发，不启动后续任务。

`folder-engine.ts` 保存目录树、幂等成员与显式阅读历史；`library-page.ts` 为列表和快速计数共用 SQL 条件；`snapshot-engine.ts` 将人工显示名称保存在附加表。`processor_result_summaries.method_revision` 是当前生成方法的读取投影标记；`processor_result_currentness` 在读取旧方法结果时返回 stale，不改写旧产物或自动重算。所有 DDL 只在当前 `schema.ts` 维护，不创建额外数据库版本。

## 文献库查询投影与取消

`library-state-cache.ts` 在只读事务中复用完整的状态映射，键包含 catalog 文件身份、SQLite `schema_version`、标签上限和部署解析 profile。事务内触发器维护 `library_state_revision` 与按篇的 `library_state_changes`，少量已定位变更只重新读取并推导对应文献；未知归属、大批量、身份或配置变化退回全量。不同连接独立记录已消费水位，不删除其它连接仍需的提示；删除文献保留失效 tombstone。候选 Map 和水位同时发布，取消或失败不改旧 Map。

状态输入包括：文献与元数据完整性、作者存在性、文献资产角色与 PDF 类型/hash、当前原始解析与 pin、校订版本/当前指针/人工 revision、固定文档与默认指针、结构注释及当前指针、建档 run 与对应 job 状态、步骤、问题处置、标签数量和描述头。完整表集合与 INSERT/UPDATE/DELETE 触发器由 `schema.ts` 的 `LIBRARY_STATE_INPUT_TABLES` 定义。获取失败记录不改变六态，仍在每次计数/筛选的同一快照中读取；阅读历史、文件夹和算子结果不改变状态缓存版本。

`literature_intake` 是最早关联元数据观测时间的查询投影，保留 `min(julianday(observed_at))` 的 UTC 毫秒语义；无观测时为 null。观测关系、观测的 provenance 和 provenance 时间发生增删改时，在原事务中重新计算受影响文献；索引按时间降序、文献 ID 升序排列。`library-page.ts` 的入库排序直接使用索引，null 在末尾，其它排序继续保持原游标语义。已有 catalog 必须在停服后的副本上显式追加结构并执行 `LIBRARY_INTAKE_BACKFILL_SQL`，启动和查询不自动迁移。

文献库计数和分页的取消从 HTTP/Entry 经查询服务传至 worker。每次可取消查询带一个共享原子标记，worker 在取出排队请求、状态计算阶段之间、SQL 扫描行及结果装载之间检查；取消时回滚只读事务，不返回部分结果。调用方立即收到 AbortError，worker 随后确认取消并继续处理后续请求。没有终止共享 worker，也不取消任何写事务；SQLite 无检查点的单条内部操作仍需运行到下一个检查点。这是协作式取消，不承诺任意指令处立即中断。

schema 15 增加入库批次、成员与主题词；13 的按篇状态失效提示和 14 的阅读批注继续保留。archive_steps 仍接纳 arrange/render，并保留 document/structure 历史行。`archive-schema-migration.ts` 固定提供显式离线 11 → 12，`library-state-schema-migration.ts` 再执行 12 → 13；二者复用完整布局与行数核对，catalog open 都不会调用。历史定义仅供显式工具识别输入。

只读 worker 的 query preflight 仅核对固定布局/版本，不执行逐表健康扫描；检索命令直接交给 `retrieval-engine.ts` 的独立连接，不顺带初始化普通写入连接。`active/search` 只作轻量检查，完整验证由显式索引维护承担。增量修改使用现有 building generation 暂存，按篇 CAS 接纳；未接纳的暂存不参与搜索。完整哈希证书的全零保留值表示失效，维护确认损坏的专用标记使查询直接拒绝，原始事实和 schema 不因此改变。

`schema.ts` 中冻结的 13、14、15、16 manifest 仅供相应离线迁移证明输入/输出，普通 opener 只接纳当前 17。14 → 15 修正规范化的来源关键词子表，保留 Provider 原始响应的 provenance hash；全部文献更新关键词投影、metadata revision/hash 和 Library FTS，再生成新的 active 检索代，复用未改变的文档证据。若输入索引原本落后，保留落后水位，由既有后台刷新追赶；已知损坏或文档存在而索引缺失时先拒绝，须在旧版本完成显式重建后重试。

`device-connection-engine.ts` 保存设备认证派生值、配对消费、撤销和有界限流计数；check 只按已认证的连接 ID 重读有效性，不能代替令牌认证；不记录认证原值，不改变文献/索引水位。[import-engine.ts](import-engine.ts) 保存通用导入库、外部编号对应、会话、原始分段引用、去重键、逐条结果与文件状态；书目事实仍由身份 owner 提交，文件夹和 PDF 不另建写入 owner。冻结 schema 16 由 `import-schema-migration.ts` 显式离线从精确 15 转换，设备与导入表共用 `IMPORT_SCHEMA_V16`，不回填历史虚构来源；16 布局已冻结。旧 14→15 迁移固定旧输出，打开路径仍只接纳当前布局。

统一入库从建批次时就有唯一 batch_id。intake_batches 是状态与结果的所有者，import_sessions 仅保存来源、分段与检查点，其 active 与批次状态在同一写事务中变化。导入根目录的外部对应先 pending 预留编号，再创建目录，最后 settled；content_sha256 只保存内容 hash。schema.ts 的 IMPORT_SCHEMA_V16 汇集全部入库与未来认篇/决定/撤回 DDL，import-schema-migration.ts 在单一 15→16 事务中回填旧批次并保留全部旧表行数。未来功能的表先保留结构，不由启动流程产生决定、撤回或书目待补事实；这些表不参与建档状态输入或检索修订。

后台入库复用 phase、storage_failures 与 updated_at 保存检查点和一分钟重试间隔；成功的逐条结算重置连续失败数，第三次存储失败同事务结束为 failed，summary.excluded 写明 storage-failure 与 unprocessed-records。失败计数按显式累计值幂等写入；若连失败检查点也暂时无法落盘，进程保留累计值，达到三次后只重试写入失败终态，不再接纳记录。进程退出前始终无法写入的计数不能跨重启保存，恢复以最后落盘的检查点为准。补 PDF 的开放批次使用 supplement:web/cli/mcp 与本地日期，条目、matched 成员及待交文件同事务登记；不增加第二套文件状态表。

[full-text-counts.ts](full-text-counts.ts) 是全文取得情况的共用只读 SQL 投影：范围先选 Literature，再按 MetaLiterature 去重，是否取得与耗尽检查全部当前版本，不以建档状态排除已有 PDF。intake-engine 将此投影与成员、PDF、书目待补计数合并，在同一只读快照返回 full_text 与两个任务预估；import-engine 不将 full_text 写入 summary_json。library-page 的获取/解析选择共用筛选，解析选择绑定当前主 PDF 的 hash 和部署 profile，不把其它 profile 的结果算成已解析。批次预估复用已有 PDF 分类计数和与任务选择相同的当前解析判定，以聚合 SQL 读取，不为计数展开或排序任务成员，也不保存另一份计数或新增表。当前快照没有 PDF 或耗尽事实时，可直接证明相应计数为零；这些判断不跨请求缓存。

metadata_only 仅存 intake_batches.request_json，不增加列；import-engine 读取工作状态时从此字段投影，旧记录缺省为 false。只导书目的普通元数据接纳、分段检查点和终态沿用同一事务，文件关系不产生。
