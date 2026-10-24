# SQLite catalog 与事务

保存单一当前 catalog schema、业务事实仓库和专用 SQL worker。

## 内容入口

- [catalog-schema.ts](catalog-schema.ts)：Catalog 版本与准入。
- [repositories.ts](repositories.ts)：文献等事实仓库。
- [worker.ts](worker.ts)：Worker 调用边界。
- [worker-runtime.ts](worker-runtime.ts)：SQLite worker 运行实现。
- [library-state-cache.ts](library-state-cache.ts)：基于事务内输入版本的建档状态缓存。
- [library-page.ts](library-page.ts)：LibraryQuery 的只读 SQL 筛选、计数和游标分页，完整文献只装载当前页；不修改业务事实或 catalog schema。
- [retrieval-engine.ts](retrieval-engine.ts)：材料检索持久化。
- [processor-engine.ts](processor-engine.ts)：算子结果、集合与固定引用的持久化。
- [review-engine.ts](review-engine.ts)：操作审计、DSH 有界历史、固定任务步骤、长期用量、运行和文献结果的分页投影。过程记录结束满 7 天后删除，结果不随之删除。

## 放置边界

材料检索刷新先完整验证旧 generation，再按来源身份、元数据版本/hash、文档版本/表示/source asset hash 与默认状态分页复用已有条目；全量重建仍读取全部来源。索引各批写入沿用业务 catalog admission，构建间互斥由检索服务的独立 generation 锁负责。外部提交仍触发检索连接刷新；损坏索引修复文本暂存在独立的匿名临时 SQLite 连接中，允许落盘且关闭即清理，不新增 catalog 表，避免批次间业务写入丢失修复暂存或复用过时 FTS 视图。修复发布在主库同一事务内流式重建 FTS、校验并切换 active，失败保留旧指针。

表、索引、视图与事务内版本事件的触发器统一维护在当前 `schema.ts`；真实数据库不进入本目录，旧库不在启动时自动转换。

文档 schema 的完整健康检查（逐表 `integrity_check` 与 `foreign_key_check`）在每个 worker 启动时运行，之后按 `schema_version`、catalog 文件 inode 与合同版本复用：DDL 或换成另一个 catalog 文件会使证明失效；普通数据提交（包括其它连接的提交和随之重开连接）不再重跑。Owner 2026-10-23 决定：大库上这项检查需数秒，原规则使每次写入（含阅读记录）后的下一次读取停顿；外部连接写入的数据损坏改为在下次启动时发现。操作仍解析所读事实，文件字节仍由 FileStore 校验；这个内存证明不写入 catalog，也不能替代 operator 的完整检查。

[上级目录](../README.md)

只读对象图由 `bootstrap/application.ts` 固定组装普通查询 worker 与共享检索 worker，隔离冷索引校验对文献读取的排队影响；材料与知识 Context 共用一个检索连接 owner。校验规则、显式重建和写入 admission 不变，服务 drain 后由应用统一关闭。

- `metadata-rows.ts` / `metadata-field-storage.ts`：中性元数据读取及字段状态的原子保存；来源证据必须属于同一篇文献，建档提议提交时重新检查默认文档与结构注释。

当前数据库结构只由 `schema.ts` 定义；`catalog-layout.ts` 统一初始化空库，`catalog-schema.ts` 提供检查和显式创建。旧 schema 定义与逐级迁移已删除。版本或指纹不匹配时拒绝按当前结构读取，不隐式转换已有库。

`raw-parsing-engine.ts`、`proofread-engine.ts`、`structure-annotation-engine.ts`、`metadata-field-storage.ts` 和 `archive-reference-engine.ts` 在同一当前结构中分别保存对应 owner 提交的事实。模块拆分不产生独立数据库版本。

`tag-engine.ts` 实现词表与有序标签的事务端口、名称唯一索引、检索、回溯覆盖和可逆变更。业务变更规则由源码树内的 `tags/` 模块决定，数据库只提交已裁决事实。

`archive-engine.ts` 保存建档步骤、问题与统计，读取当前材料和描述的版本投影；就绪状态统一调用 `literature/state.ts`。版本变化在原事实的写入事务中记录，不依赖读取触发，不启动后续任务。

`folder-engine.ts` 保存目录树、幂等成员与显式阅读历史；`library-page.ts` 为列表和快速计数共用 SQL 条件；`snapshot-engine.ts` 将人工显示名称保存在附加表。`processor_result_summaries.method_revision` 是当前生成方法的读取投影标记；`processor_result_currentness` 在读取旧方法结果时返回 stale，不改写旧产物或自动重算。所有 DDL 只在当前 `schema.ts` 维护，不创建额外数据库版本。

## 文献库查询投影与取消

`library-state-cache.ts` 在只读事务中复用完整的状态映射，键包含 catalog 文件身份、SQLite `schema_version`、`library_state_revision`、标签上限和部署解析 profile。事务内触发器维护状态版本，因此其它连接提交后重开连接仍可复用未变化的映射；取消或失败的计算不发布半份映射。

状态输入包括：文献与元数据完整性、作者存在性、文献资产角色与 PDF 类型/hash、当前原始解析与 pin、校订版本/当前指针/人工 revision、固定文档与默认指针、结构注释及当前指针、建档 run 与对应 job 状态、步骤、问题处置、标签数量和描述头。完整表集合与 INSERT/UPDATE/DELETE 触发器由 `schema.ts` 的 `LIBRARY_STATE_INPUT_TABLES` 定义。获取失败记录不改变六态，仍在每次计数/筛选的同一快照中读取；阅读历史、文件夹和算子结果不改变状态缓存版本。

`literature_intake` 是最早关联元数据观测时间的查询投影，保留 `min(julianday(observed_at))` 的 UTC 毫秒语义；无观测时为 null。观测关系、观测的 provenance 和 provenance 时间发生增删改时，在原事务中重新计算受影响文献；索引按时间降序、文献 ID 升序排列。`library-page.ts` 的入库排序直接使用索引，null 在末尾，其它排序继续保持原游标语义。已有 catalog 必须在停服后的副本上显式追加结构并执行 `LIBRARY_INTAKE_BACKFILL_SQL`，启动和查询不自动迁移。

文献库计数和分页的取消从 HTTP/Entry 经查询服务传至 worker。每次可取消查询带一个共享原子标记，worker 在取出排队请求、状态计算阶段之间、SQL 扫描行及结果装载之间检查；取消时回滚只读事务，不返回部分结果。调用方立即收到 AbortError，worker 随后确认取消并继续处理后续请求。没有终止共享 worker，也不取消任何写事务；SQLite 无检查点的单条内部操作及启动完整健康检查仍需运行到下一个检查点。这是协作式取消，不承诺任意指令处立即中断。
