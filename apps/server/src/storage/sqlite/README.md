# SQLite catalog 与事务

保存当前 catalog schema（结构 19）、业务事实仓库和专用 SQL worker。

## 内容入口

- [catalog-schema.ts](catalog-schema.ts) 提供显式检查、空库初始化和按名称应用增补集。普通打开核对基础 DDL、执行层身份与所有必需增补集。显式检查列出额外的表、索引、触发器、视图，以及已知表末尾可空或带默认值的列。
- [catalog-additions.ts](catalog-additions.ts) 在业务写许可内以同一事务应用已声明的 DDL 和增补集登记。新增触发器在未注册应用函数的连接上编译。[catalog-backfill.ts](catalog-backfill.ts) 在专用 worker 的短事务中提交回填和游标，每 32 个键检查 40 ms 工作预算，每批最多 1,024 个键。有剩余工作时通过共享队列登记下一批，持续写入时按实际持许可时间取得保留份额。
- [repositories.ts](repositories.ts)：文献等事实仓库。
- [worker.ts](worker.ts)：Worker 调用边界；`withReadSnapshot` 为多次关联读取创建独立只读连接，消费结束或失败时关闭，不占用普通查询连接的事务。
- [read-lanes.ts](read-lanes.ts) 列出读取的分道与耗时上限。工作台的查询与应用对象共用一个只读长请求线程。许可内的读取继续随原写入处理。短读排队及执行合计超过 5 秒时记录 `sqlite-short-read-slow`。
- [literature-bibliographies.ts](literature-bibliographies.ts)：文献公开批量书目读取的存储适配，只取当前标识、题名与年份；与文件夹导出共享同一快照，不读取正文或状态。
- [worker-runtime.ts](worker-runtime.ts)：SQLite worker 运行实现。
- [citation-progress.ts](citation-progress.ts) 将引用扩展的待查队列、原因去重、待补查队列和未完成查询的回放键放入临时 SQLite。持久来源为与发现结果同一事务提交的 `citation-write-checkpoint`。恢复按事件序号每页取 32 条，执行按索引取各队列的最早待查项。旧检查点中尚未发布的原因按段补写。
- [literature-search-rows.ts](literature-search-rows.ts) 使用内容表的 `c0` 覆盖索引按文献 ID 找到书目 FTS 的 rowid，供改写和撤回使用。FTS5 内部内容表的文件格式规定 `id` 为 rowid，`c0` 为第一个声明列，此处是 `literature_id`。SQLite 随每次 FTS 写入维护该索引。
- [library-page.ts](library-page.ts) 按 FTS5 rowid 倒序限制整库文字查询的原始命中，再筛选、计数、分面或排名。文件夹、批次、任务产出、收进来的文献和近期阅读用计数器或有界探针比较两侧成本，小工作集精确匹配，大工作集按原始命中或成员时间分窗。成员按时间倒序、文献 ID 升序，空时间在后。续查在同一侧从最旧位置排他地往后读，窗口内冷续页在原区间重排。索引标题里的空格分隔词能确认短 ASCII 查询的全部命中时直接接纳该成员，其余成员执行完整 `MATCH`。[library-search-rank.ts](library-search-rank.ts) 用 FTS 文档长度与短语数为工作集顺序中的前缀分配计分预算。计分从索引文本还原短语频次，混合 Unicode 片段使用 `unicode61` 分词及请求内有界缓存，超过分词预算时合并提取原生高亮。整次查询共享全局词频和平均文档长度，钳位词使用真实频次。已打分项先按原生 BM25 排序，其余按工作集顺序接在后面。
- [literature-search-schema-migration.ts](literature-search-schema-migration.ts) 接受五个旧结构 19 指纹与已经合并 04–07 的旧指纹，登记首个增补集 `library-scale-04-07`。首次切换在同一事务中将存量触发器改为按列名写入并保留原执行顺序，重建 `archive_current_parts`，按文献和 PDF 的索引定位默认文档。已完成的状态、计数和分页投影沿用原水位。需要补齐检索水位时，用迁移入口的 `--reconcile` 显式比对并登记差异。
- [library-state.ts](library-state.ts) 保存在写事务中计算的文献状态和缺失步骤、选用记录以及回填游标。SQLite 触发器为其他写入者记录受影响的 Literature ID，后台以短事务核对。读取在同一快照内优先使用当前代的存储值，回填和后台核对期间按篇现算缺少或已改变的值。
- [library-page.ts](library-page.ts) 依据首页总数选择允许的排序。收进来范围用 `collected_at`，其他范围用 `intake_at`。相关度查询在长请求道保留最多 16 个前 1,000 项的排名，续页沿用入选 ID 与评分并读取仍可见条目的当前事实。缓存淘汰或服务重启时重算。
- [library-paging-schema.ts](library-paging-schema.ts) 的触发器登记首次选用时间，同时维护文件夹、入库批次和发现批次的有序成员与发现原因校验结果。[library-paging-state.ts](library-paging-state.ts) 按原表批量回填，完成前分页使用原始事实。
- [draft-text-engine.ts](draft-text-engine.ts)：初稿版本、资源闭包、不可变计数、当前指针及默认关系的同事务登记；按版本读事实、按本页文献批量读主 PDF 默认版本与等级。补形成候选共用文献库筛选和排序，在同一只读快照返回 PDF 部分、当前部署/历史 Markdown raw、指定 raw 的既有初稿 ID 和当前初稿方法；不读取正文或其它文件，业务跳过、limit 与任务冻结由应用层决定。
- [document-defaults.ts](document-defaults.ts)：原始解析当前切换、初稿登记与校订发布事务内按独立 CAS 重求默认文本，优先有效完整校订稿，再选有效当前初稿，否则删除默认关系。校订发布可提名刚登记的版本，仍复检当前校订内容、人工 revision 和原始解析 pin；相同校订内容的等价方法版本可以复用固定表示。没有提名时保留仍有效的默认表示。资产当前指针切换同时重求其全部文献关系；读取不重求。
- [draft-text-schema-migration.ts](draft-text-schema-migration.ts)：独立离线 16→17；精确匹配冻结 16，原地重建文档父表、子表不改名或重建，核对全部旧表行数及校订行、内容版本、事件和结果过时状态；不形成初稿，不访问 artifact。
- [user-organization-schema-migration.ts](user-organization-schema-migration.ts)：独立离线 17→18，精确匹配冻结 V17，一次增加筛选与批注定位缓存两表，以及设备连接的 nullable `kind` 列（旧连接为 null）；原地重建批次对象登记表以接受 literature，逐行保留原登记、索引和外键；失败回滚并保留原异常。
- [library-state-cache.ts](library-state-cache.ts)：基于事务内输入版本的建档状态缓存。
- [library-state-schema-migration.ts](library-state-schema-migration.ts)：显式离线安装当前按篇失效结构；[library-state-previous-layout.ts](library-state-previous-layout.ts) 只描述工具的精确旧输入，不由 catalog opener 接受。
- [intake-engine.ts](intake-engine.ts)：入库批次及按文献去重的成员写入、改名与当前 PDF 状态读取；成员与 identity 发布共用事务。
- [capture-engine.ts](capture-engine.ts)：单篇网页的请求 UUID/规范输入 hash 与持久回执、设备按系统时区日期唯一的开放批次。条目存在 intake_items，文件存在 import_files，身份发布与批次成员复用相同事务边界；重放从已提交成员恢复分类，不再有独立收藏表。
- [intake-schema-migration.ts](intake-schema-migration.ts)：显式离线 14 → 15，旧运行回填、早期批次、主题词映射及确定性元数据/索引投影；[intake-metadata-migration.ts](intake-metadata-migration.ts) 复用元数据裁决与读取。
- [openalex-top-concepts-cleanup.ts](openalex-top-concepts-cleanup.ts)：显式离线删除旧 OpenAlex 观测中 19 个顶层大类，并复用关键词层重投影，仅更新受影响文献与 Library FTS；不改 schema，不由启动或查询调用。检索 source revision 正常推进，后续刷新追赶。
- [library-page.ts](library-page.ts)：LibraryQuery 的只读 SQL 筛选、计数和游标分页，完整文献只装载当前页；has_primary_pdf 与 with_primary_pdf 按版本，full_text 复用 [full-text-counts.ts](full-text-counts.ts) 在同一快照按论文聚合，并检查全部可见兄弟版本。计数忽略 statuses、needs_manual_pdf，其余筛选保留；不修改业务事实或 catalog schema。
- [filter-engine.ts](filter-engine.ts)：保存筛选的只读列表、导出与原子写入；不改文献状态或检索 revision。`folder-engine.ts` 的导出只读目录与成员 ID，按复合主键分页，不直接读取书目表。
- [draft-facts.ts](draft-facts.ts)：在查询的只读快照中按页批量读取各 PDF 的默认版本及初稿事实；引用数与“找不到”计数沿固定版本索引聚合，只排除内容过时的结果，不打开结果文件。列表筛选与排序仅使用主 PDF，补充部分只在详情和建档状态返回。
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

基础布局和当前增补集由 `schema.ts` 声明。`catalog-layout.ts` 统一初始化空库。历史布局只供专用离线工具精确核对，普通打开要求当前基础指纹和必需的增补集登记。

`raw-parsing-engine.ts`、`proofread-engine.ts`、`structure-annotation-engine.ts`、`metadata-field-storage.ts` 和 `archive-reference-engine.ts` 在同一当前结构中分别保存对应 owner 提交的事实。模块拆分不产生独立数据库版本。

`worker-runtime.ts` 的文档版本提交保留校订稿来源、raw pin、人工 revision、产物登记及默认版本 CAS 检查。`source-order-leaves-v4` 允许省略已登记的公式截图，实际引用的图片仍须逐一匹配同一校订稿的 reference、hash、路径和完整 artifact 描述；历史 builder 保留原来的图片数量检查。文档提交失败仅跨 worker 传递 `errors.ts` 中的有限错误码，不透传 SQL 文本、参数或文件路径。

`archive-engine.ts` 将建档第一步的完整解析回执写进既有 archive-progress 事件，与 task_steps 的状态更新同事务提交；校验文献、资产与 hash 绑定，不借用 reason。`review-engine.ts` 的任务步骤和建档步骤按 job、文献、资产取最近的解析事件投影 receipt；旧事件缺字段时省略，不继承较早尝试的回执。schema 和 task_steps 布局不变。

`tag-engine.ts` 实现词表与有序标签的事务端口、名称唯一索引、检索、回溯覆盖和可逆变更。业务变更规则由源码树内的 `tags/` 模块决定，数据库只提交已裁决事实。

`archive-engine.ts` 保存建档步骤、问题与统计，读取当前材料和描述的版本投影；就绪状态统一调用 `literature/state.ts`。版本变化在原事实的写入事务中记录，不依赖读取触发，不启动后续任务。

`folder-engine.ts` 保存目录树、幂等成员与显式阅读历史；`library-page.ts` 为列表和快速计数共用 SQL 条件；`snapshot-engine.ts` 将人工显示名称保存在附加表。`processor_result_summaries.method_revision` 是当前生成方法的读取投影标记；`processor_result_currentness` 在读取旧方法结果时返回 stale，不改写旧产物或自动重算。所有 DDL 只在当前 `schema.ts` 维护，不创建额外数据库版本。

## 文献库查询投影与取消

全库和收进来的文献计数在计数器就绪时直接读汇总。计数器回填或核对期间，长请求道在同一只读快照中计算准确数。稳定期的状态筛选页走短请求道，查询直接使用状态索引。回填或核对期间，涉及状态或历史选用的筛选页走长请求道，在读取快照里按篇补算。

任务详情由 [task-detail-engine.ts](task-detail-engine.ts) 聚合。没有可用缓存时固定事件尾部，按序号每段读最多 1,000 条，然后复核任务身份、尾锚及前缀条数。短线程最多保留 32 个任务的聚合缓存，续读只重放尾部新增事件。

[task-detail-sidecar.ts](task-detail-sidecar.ts) 把重放位置、聚合状态和去重 SQLite 放入同一个带版本和 SHA-256 校验的旁路文件。CLI 与工作台共享 home 下的 `.sciretriever/cache/task-detail/`。成功的全量重放以及累计至少 1,000 条新事件后的读取，在结束 catalog 读事务后以原子改名发布。加载验证库身份、schema、任务创建时间、前缀条数和尾事件。整个目录可删除，缺失或校验失效时全量重放。缓存保留最近写入的文件，最多 32 个、总计 512 MiB、单个 128 MiB。

工作台每 10 秒在独立的 SQLite worker 检查 WAL。最近一次 WAL 修改满 15 秒后尝试 PASSIVE，只有全部帧已写回且 WAL 未继续变化才以零等待尝试 TRUNCATE。显式校验持有快照时，PASSIVE 仍可推进到该快照允许的位置。

本地连接需要复用状态时，`library-state-cache.ts` 使用只读事务中的完整状态映射，键包含 catalog 文件身份、SQLite `schema_version`、标签上限和部署解析 profile。事务内触发器维护 `library_state_revision` 与按篇的 `library_state_changes`，少量已定位变更只重新读取并推导对应文献；未知归属、大批量、身份或配置变化退回全量。不同连接独立记录已消费水位，不删除其它连接仍需的提示；删除文献保留失效 tombstone。候选 Map 和水位同时发布，取消或失败不改旧 Map。

状态输入包括：文献与元数据完整性、作者存在性、文献资产角色与 PDF 类型/hash、当前原始解析与 pin、校订版本/当前指针/人工 revision、固定文档与默认指针、结构注释及当前指针、建档 run 与对应 job 状态、步骤、问题处置、标签数量和描述头。完整表集合与 INSERT/UPDATE/DELETE 触发器由 `schema.ts` 的 `LIBRARY_STATE_INPUT_TABLES` 定义。获取失败记录不改变六态，仍在每次计数/筛选的同一快照中读取；阅读历史和文件夹不改变状态缓存版本。结果引用不改变六态，但会改变初稿事实：`library-state-cache.ts` 在同一快照按版本索引比较各篇 PDF 默认初稿的事实摘要，只失效事实变化的文献；不在结果发布事务或冻结结构中另加触发器。内部仅推导就绪状态时不重复聚合事实。

[library-count-store.ts](library-count-store.ts) 按 MetaLiterature 保存全库与收进来范围的贡献，状态提交钩子在同一事务内把差额计入两个汇总行。耗尽、撤回、收进来成员和版本移组或删除通过触发器记录受影响论文。旧写入者的提交由状态维护循环按批核对。计数回填与设置重算期间，读取同一快照中的文献事实并带进度标记。最近打开按时间索引最多取 100 个当前版本。

[library-page.ts](library-page.ts) 的普通筛选计数及分面用第 10,001 个匹配判定截断，列表游标保留第一页总数。显式准确数在长请求道持有一个可取消的读快照并返回 `snapshot_at`。批量选择保持全量。

`literature_intake` 是最早关联元数据观测时间的查询投影，保留 `min(julianday(observed_at))` 的 UTC 毫秒语义；无观测时为 null。观测关系、观测的 provenance 和 provenance 时间发生增删改时，在原事务中重新计算受影响文献；索引按时间降序、文献 ID 升序排列。`library-page.ts` 的入库排序直接使用索引，null 在末尾，其它排序继续保持原游标语义。已有 catalog 必须在停服后的副本上显式追加结构并执行 `LIBRARY_INTAKE_BACKFILL_SQL`，启动和查询不自动迁移。

文献库计数和分页的取消从 HTTP/Entry 经查询服务传至 worker。每次可取消查询带一个共享原子标记，worker 在取出排队请求、状态计算阶段之间、SQL 扫描行及结果装载之间检查；取消时回滚只读事务，不返回部分结果。调用方立即收到 AbortError，worker 随后确认取消并继续处理后续请求。没有终止共享 worker，也不取消任何写事务；SQLite 无检查点的单条内部操作仍需运行到下一个检查点。这是协作式取消，不承诺任意指令处立即中断。

schema 15 增加入库批次、成员与主题词；13 的按篇状态失效提示和 14 的阅读批注继续保留。archive_steps 仍接纳 arrange/render，并保留 document/structure 历史行。`archive-schema-migration.ts` 固定提供显式离线 11 → 12，`library-state-schema-migration.ts` 再执行 12 → 13；二者复用完整布局与行数核对，catalog open 都不会调用。历史定义仅供显式工具识别输入。

只读 worker 的 query preflight 仅核对固定布局与版本，检索命令由 `retrieval-engine.ts` 的独立连接执行。`active/search` 只作轻量检查，完整验证由显式索引维护承担。来源变更由触发器在原事务追加文献 ID。刷新固定日志尾和来源修订，按有界页核对来源指纹，书目小批直接接纳，全文使用 building generation 暂存。每次接纳同时推进已处理位置，末批发布该轮来源修订。短事务回收已处理日志。完整哈希证书的全零保留值表示失效，维护确认损坏的专用标记使查询直接拒绝。

`schema.ts` 中冻结的 13 至 19 manifest 供相应离线迁移证明输入与输出，普通 opener 校验当前结构 19 的精确指纹。14 → 15 修正规范化的来源关键词子表，保留 Provider 原始响应的 provenance hash；全部文献更新关键词投影、metadata revision/hash 和 Library FTS，再生成新的 active 检索代，复用未改变的文档证据。若输入索引原本落后，保留落后水位，由既有后台刷新追赶；已知损坏或文档存在而索引缺失时先拒绝，须在旧版本完成显式重建后重试。

`device-connection-engine.ts` 保存设备认证派生值、配对消费、撤销和有界限流计数；check 只按已认证的连接 ID 重读有效性，不能代替令牌认证；不记录认证原值，不改变文献/索引水位。[import-engine.ts](import-engine.ts) 保存通用导入库、外部编号对应、会话、原始分段引用、去重键、逐条结果与文件状态；书目事实仍由身份 owner 提交，文件夹和 PDF 不另建写入 owner。冻结 schema 16 由 `import-schema-migration.ts` 显式离线从精确 15 转换，设备与导入表共用 `IMPORT_SCHEMA_V16`，不回填历史虚构来源；16 布局已冻结。旧 14→15 迁移固定旧输出，打开路径仍只接纳当前布局。

统一入库从建批次时就有唯一 batch_id。intake_batches 是状态与结果的所有者，import_sessions 仅保存来源、分段与检查点，其 active 与批次状态在同一写事务中变化。导入根目录的外部对应先 pending 预留编号，再创建目录，最后 settled；content_sha256 只保存内容 hash。schema.ts 的 IMPORT_SCHEMA_V16 汇集全部入库与未来认篇/决定/撤回 DDL，import-schema-migration.ts 在单一 15→16 事务中回填旧批次并保留全部旧表行数。决定与书目待补事实由对应入库服务写入，启动不推断业务事实。撤回使用既有标记表，不改 schema；标记及恢复显式推进检索修订，不改变建档状态输入表。

后台入库复用 phase、storage_failures 与 updated_at 保存检查点和一分钟重试间隔；成功的逐条结算重置连续失败数，第三次存储失败同事务结束为 failed，summary.excluded 写明 storage-failure 与 unprocessed-records。失败计数按显式累计值幂等写入；若连失败检查点也暂时无法落盘，进程保留累计值，达到三次后只重试写入失败终态，不再接纳记录。进程退出前始终无法写入的计数不能跨重启保存，恢复以最后落盘的检查点为准。补 PDF 的开放批次使用 supplement:web/cli/mcp 与本地日期，条目、matched 成员及待交文件同事务登记；不增加第二套文件状态表。

[full-text-counts.ts](full-text-counts.ts) 是全文取得情况的共用只读 SQL 投影：范围先选 Literature，再按 MetaLiterature 去重，是否取得与耗尽检查全部当前版本，不以建档状态排除已有 PDF。intake-engine 将此投影与成员、PDF、书目待补计数合并，在同一只读快照返回 full_text 与两个任务预估；import-engine 不将 full_text 写入 summary_json。library-page 的获取/解析选择共用筛选，解析选择绑定当前主 PDF 的 hash 和部署 profile，不把其它 profile 的结果算成已解析。批次预估复用已有 PDF 分类计数和与任务选择相同的当前解析判定，以聚合 SQL 读取，不为计数展开或排序任务成员，也不保存另一份计数或新增表。当前快照没有 PDF 或耗尽事实时，可直接证明相应计数为零；这些判断不跨请求缓存。

metadata_only 仅存 intake_batches.request_json，不增加列；import-engine 读取工作状态时从此字段投影，旧记录缺省为 false。只导书目的普通元数据接纳、分段检查点和终态沿用同一事务，文件关系不产生。

[intake-items.ts](intake-items.ts) 读写已有条目表的文件暂存引用、配对与认篇工作 JSON、决定和书目待补标记，不增表。SHA-256 对应包括被撤回内容；恢复仅移除所对应文献及其材料、成员与批注的撤回标记。人工保存标题与按标识入库时，标记清除并入元数据发布事务。

该模块的 `duplicate-candidates` 只读投影按一次 SQL 快照返回标题、有序作者、年份与出版形式，排除已撤回文献；它不读取正文、来源记录或资产字节，不形成身份或合并决定。

`intake-items.ts` 还保存首次预览物化的数据条目、可能重复候选、决定审计与三十天保留期限。普通条目和批次成员写入仍检查原状态；结束后的决定与文件结算走专用受限操作。`import-engine.ts` 在同一事务里替换待决定回执并更新原批次成员与结果，过期清理保留 `decision-expired` 报告原因，不重开批次、不改变身份规则或表结构。

`marks-engine.ts` 在 `reading_mark_places` 按批注与目标替换位置，读取仅给当前定位方法，随批注物理清除级联；定位不改 `reading_marks` 原锚点或文献状态。`place` 的 PDF 校验先只读检查，再带页数进入写事务重判；原 `create`/`update` 锚点规则保持。

[intake-objects.ts](intake-objects.ts) 在文献、文件夹、成员、资产关系与批注的创建事务中登记批次归属；文献登记与 created 成员在同一事务完成，保留条目的延迟决定沿用原保留校验进入身份发布事务。[intake-withdrawal-engine.ts](intake-withdrawal-engine.ts) 在单个事务中重判八种保留原因、检查忙碌任务、撤回或恢复并保存报告。撤回记录读回与恢复预估复用已有记录和剩余标记；与批次状态在同一个只读快照返回，恢复执行重新读取剩余标记。旧批次没有登记时，有任何文件夹成员或批注都保留；不推断历史归属。共享文件字节与来源事实保留。

[intake-visibility.ts](intake-visibility.ts) 为文献库、词频、全文检索与 Context、引用两端、发现原因、任务范围、文件夹与批注提供读取排除条件；MetaLiterature 代表只在读投影中重选。身份、sha256 和外部对应读取完整事实，命中后在成员写入事务恢复原文献及其原撤回关系，分类 restored，原批次报告保持不变。撤回服务只接网页登录的五条入库 HTTP 路由，无设备用途、CLI 或 MCP 操作。
