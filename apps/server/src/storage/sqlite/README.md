# SQLite catalog 与迁移

保存 catalog schema、各版本迁移、业务事实仓库和专用 SQL worker。

## 内容入口

- [catalog-schema.ts](catalog-schema.ts)：Catalog 版本与准入。
- [repositories.ts](repositories.ts)：文献等事实仓库。
- [worker.ts](worker.ts)：Worker 调用边界。
- [worker-runtime.ts](worker-runtime.ts)：SQLite worker 运行实现。
- [library-page.ts](library-page.ts)：LibraryQuery 的只读 SQL 筛选、计数和游标分页，完整文献只装载当前页；不修改业务事实或 catalog schema。
- [retrieval-engine.ts](retrieval-engine.ts)：材料检索持久化。
- [knowledge-engine.ts](knowledge-engine.ts)：知识持久化。

## 放置边界

schema-v*.ts 与 *-migration.ts 维护版本/迁移；真实数据库不进入本目录，兼容变更遵守迁移合同。

文档 schema 的完整健康检查按连接内的 `data_version`、`schema_version`、`total_changes()` 与合同版本复用；外部提交、同连接写入、DDL 或重开连接使证明失效。操作仍解析所读事实，文件字节仍由 FileStore 校验；这个内存证明不写入 catalog，也不能替代 operator 的完整检查。

[上级目录](../README.md) · [项目 README](../../../../../README.md)

- `schema-v10.ts`、`processor-migration.ts`、`processor-engine.ts`：显式 v9→v10 迁移、结果依赖保护与记录/FTS 投影。

只读对象图由 `bootstrap/application.ts` 固定组装普通查询 worker 与共享检索 worker，隔离冷索引校验对文献读取的排队影响；材料与知识 Context 共用一个检索连接 owner。校验规则、显式重建和写入 admission 不变，服务 drain 后由应用统一关闭。
