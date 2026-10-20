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

表、索引、视图与事务内版本事件的触发器统一维护在当前 `schema.ts`；真实数据库不进入本目录，旧库不在启动时自动转换。

文档 schema 的完整健康检查按连接内的 `data_version`、`schema_version`、`total_changes()` 与合同版本复用；外部提交、同连接写入、DDL 或重开连接使证明失效。操作仍解析所读事实，文件字节仍由 FileStore 校验；这个内存证明不写入 catalog，也不能替代 operator 的完整检查。

[上级目录](../README.md)


只读对象图由 `bootstrap/application.ts` 固定组装普通查询 worker 与共享检索 worker，隔离冷索引校验对文献读取的排队影响；材料与知识 Context 共用一个检索连接 owner。校验规则、显式重建和写入 admission 不变，服务 drain 后由应用统一关闭。





- `metadata-rows.ts` / `metadata-field-storage.ts`：中性元数据读取及字段状态的原子保存；来源证据必须属于同一篇文献，建档提议提交时重新检查默认文档与结构注释。

当前数据库结构只由 `schema.ts` 定义；`catalog-layout.ts` 统一初始化空库，`catalog-schema.ts` 提供检查和显式创建。旧 schema 定义与逐级迁移已删除。版本或指纹不匹配时拒绝按当前结构读取，不隐式转换已有库。

`raw-parsing-engine.ts`、`proofread-engine.ts`、`structure-annotation-engine.ts`、`metadata-field-storage.ts` 和 `archive-reference-engine.ts` 在同一当前结构中分别保存对应 owner 提交的事实。模块拆分不产生独立数据库版本。

`tag-engine.ts` 实现词表与有序标签的事务端口、名称唯一索引、检索、回溯覆盖和可逆变更。业务变更规则由源码树内的 `tags/` 模块决定，数据库只提交已裁决事实。

`archive-engine.ts` 保存建档步骤、问题与统计，读取当前材料和描述的版本投影；就绪状态统一调用 `literature/state.ts`。版本变化在原事实的写入事务中记录，不依赖读取触发，不启动后续任务。
