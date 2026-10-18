# SQLite catalog 与迁移

保存 catalog schema、各版本迁移、业务事实仓库和专用 SQL worker。

## 内容入口

- [catalog-schema.ts](catalog-schema.ts)：Catalog 版本与准入。
- [repositories.ts](repositories.ts)：文献等事实仓库。
- [worker.ts](worker.ts)：Worker 调用边界。
- [worker-runtime.ts](worker-runtime.ts)：SQLite worker 运行实现。
- [retrieval-engine.ts](retrieval-engine.ts)：材料检索持久化。
- [knowledge-engine.ts](knowledge-engine.ts)：知识持久化。

## 放置边界

schema-v*.ts 与 *-migration.ts 维护版本/迁移；真实数据库不进入本目录，兼容变更遵守迁移合同。

[上级目录](../README.md) · [项目 README](../../../../../README.md)

- `schema-v10.ts`、`processor-migration.ts`、`processor-engine.ts`：显式 v9→v10 迁移、结果依赖保护与记录/FTS 投影。
