# SQLite catalog 与事务

保存单一当前 catalog schema、业务事实仓库和专用 SQL worker。

## 内容入口

- [catalog-schema.ts](catalog-schema.ts)：Catalog 版本与准入。
- [repositories.ts](repositories.ts)：文献等事实仓库。
- [worker.ts](worker.ts)：Worker 调用边界。
- [worker-runtime.ts](worker-runtime.ts)：SQLite worker 运行实现。
- [library-state-cache.ts](library-state-cache.ts)：基于事务内输入版本的建档状态缓存。
- [library-state-schema-migration.ts](library-state-schema-migration.ts)：显式离线安装当前按篇失效结构；[library-state-previous-layout.ts](library-state-previous-layout.ts) 只描述工具的精确旧输入，不由 catalog opener 接受。
- [intake-engine.ts](intake-engine.ts)：入库批次及按文献去重的成员写入、改名与当前 PDF 状态读取；成员与 identity 发布共用事务。
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

`tag-engine.ts` 实现词表与有序标签的事务端口、名称唯一索引、检索、回溯覆盖和可逆变更。业务变更规则由源码树内的 `tags/` 模块决定，数据库只提交已裁决事实。

`archive-engine.ts` 保存建档步骤、问题与统计，读取当前材料和描述的版本投影；就绪状态统一调用 `literature/state.ts`。版本变化在原事实的写入事务中记录，不依赖读取触发，不启动后续任务。

`folder-engine.ts` 保存目录树、幂等成员与显式阅读历史；`library-page.ts` 为列表和快速计数共用 SQL 条件；`snapshot-engine.ts` 将人工显示名称保存在附加表。`processor_result_summaries.method_revision` 是当前生成方法的读取投影标记；`processor_result_currentness` 在读取旧方法结果时返回 stale，不改写旧产物或自动重算。所有 DDL 只在当前 `schema.ts` 维护，不创建额外数据库版本。

## 文献库查询投影与取消

`library-state-cache.ts` 在只读事务中复用完整的状态映射，键包含 catalog 文件身份、SQLite `schema_version`、标签上限和部署解析 profile。事务内触发器维护 `library_state_revision` 与按篇的 `library_state_changes`，少量已定位变更只重新读取并推导对应文献；未知归属、大批量、身份或配置变化退回全量。不同连接独立记录已消费水位，不删除其它连接仍需的提示；删除文献保留失效 tombstone。候选 Map 和水位同时发布，取消或失败不改旧 Map。

状态输入包括：文献与元数据完整性、作者存在性、文献资产角色与 PDF 类型/hash、当前原始解析与 pin、校订版本/当前指针/人工 revision、固定文档与默认指针、结构注释及当前指针、建档 run 与对应 job 状态、步骤、问题处置、标签数量和描述头。完整表集合与 INSERT/UPDATE/DELETE 触发器由 `schema.ts` 的 `LIBRARY_STATE_INPUT_TABLES` 定义。获取失败记录不改变六态，仍在每次计数/筛选的同一快照中读取；阅读历史、文件夹和算子结果不改变状态缓存版本。

`literature_intake` 是最早关联元数据观测时间的查询投影，保留 `min(julianday(observed_at))` 的 UTC 毫秒语义；无观测时为 null。观测关系、观测的 provenance 和 provenance 时间发生增删改时，在原事务中重新计算受影响文献；索引按时间降序、文献 ID 升序排列。`library-page.ts` 的入库排序直接使用索引，null 在末尾，其它排序继续保持原游标语义。已有 catalog 必须在停服后的副本上显式追加结构并执行 `LIBRARY_INTAKE_BACKFILL_SQL`，启动和查询不自动迁移。

文献库计数和分页的取消从 HTTP/Entry 经查询服务传至 worker。每次可取消查询带一个共享原子标记，worker 在取出排队请求、状态计算阶段之间、SQL 扫描行及结果装载之间检查；取消时回滚只读事务，不返回部分结果。调用方立即收到 AbortError，worker 随后确认取消并继续处理后续请求。没有终止共享 worker，也不取消任何写事务；SQLite 无检查点的单条内部操作仍需运行到下一个检查点。这是协作式取消，不承诺任意指令处立即中断。

当前 schema 15 增加入库批次、成员与主题词；13 的按篇状态失效提示和 14 的阅读批注继续保留。archive_steps 仍接纳 arrange/render，并保留 document/structure 历史行。`archive-schema-migration.ts` 固定提供显式离线 11 → 12，`library-state-schema-migration.ts` 再执行 12 → 13；二者复用完整布局与行数核对，catalog open 都不会调用。历史定义仅供显式工具识别输入。

只读 worker 的 query preflight 仅核对固定布局/版本，不执行逐表健康扫描；检索命令直接交给 `retrieval-engine.ts` 的独立连接，不顺带初始化普通写入连接。`active/search` 只作轻量检查，完整验证由显式索引维护承担。增量修改使用现有 building generation 暂存，按篇 CAS 接纳；未接纳的暂存不参与搜索。完整哈希证书的全零保留值表示失效，维护确认损坏的专用标记使查询直接拒绝，原始事实和 schema 不因此改变。

`schema.ts` 中冻结的 13、14 manifest 仅供相应离线迁移证明输入/输出，普通 opener 只接纳当前 15。14 → 15 修正规范化的来源关键词子表，保留 Provider 原始响应的 provenance hash；全部文献更新关键词投影、metadata revision/hash 和 Library FTS，再生成新的 active 检索代，复用未改变的文档证据。若输入索引原本落后，保留落后水位，由既有后台刷新追赶；已知损坏或文档存在而索引缺失时先拒绝，须在旧版本完成显式重建后重试。
