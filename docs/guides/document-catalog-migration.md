# Document Catalog v3 合成迁移操作

正式 operator 的新库 v8 初始化、已有 v1–v7 整链升级和恢复边界见[Catalog 初始化、升级与恢复](upgrade.md)。本页保留历史单步合成入口及其门禁；不能用它冒充正式启用入口。

本入口用于 M05-T01 的**临时合成 catalog** 演练。它只迁移 Catalog DDL，不下载、重新解析或生成表示；迁移后 `document_versions` 为空。真实用户 Catalog/资产/Profile 的切换尚未授权，不能把下面命令指向真实数据。

先在系统临时目录准备已经核实为合成材料的副本，停止所有访问该副本的 writer。目录名必须以 `sciretriever-` 开头，Catalog 和备份位于同一目录。当前构建的 CLI 从仓库根目录调用 `node apps/server/dist/cli/main.js`，已安装包用 `sciretriever`。

```bash
node apps/server/dist/cli/main.js storage document-inspect --catalog /tmp/sciretriever-example/catalog.sqlite --json
node apps/server/dist/cli/main.js storage document-migrate --catalog /tmp/sciretriever-example/catalog.sqlite --dry-run --json
node apps/server/dist/cli/main.js storage document-migrate --catalog /tmp/sciretriever-example/catalog.sqlite --backup /tmp/sciretriever-example/catalog-before-v3.sqlite --synthetic-copy --json
node apps/server/dist/cli/main.js storage document-inspect --catalog /tmp/sciretriever-example/catalog.sqlite --json
node apps/server/dist/cli/main.js storage document-inspect --catalog /tmp/sciretriever-example/catalog-before-v3.sqlite --json
```

`inspect` 和 `--dry-run` 通过 SQLite 只读连接检查现有 catalog；不会建表、写 receipt、创建备份、写锁 sidecar 或恢复任务。输入仅接受完整 v1/v2/v3 identity/fingerprint、DDL、SQLite integrity/foreign key 与 execution 子 schema；未知版本、篡改和损坏拒绝。普通 Query 对 v3 也验证实际 DDL 和子 schema，缺库不会创建表。

真实迁移只接受已存在的合成 catalog、显式 `--synthetic-copy` 和尚不存在的备份文件。工具全程持有与 Application 写操作相同的 catalog 写锁；用 `VACUUM INTO` 对包含 WAL 已提交事实的 catalog 在同目录私有 staging 建立一致性备份，读回验证后原子 create-if-absent 发布，已占用目标不会被覆盖，再于一个事务中执行 v1→v2→v3 或 v2→v3。绕开应用写锁的另一个连接若在备份与事务之间提交，迁移拒绝并保留可读源库与备份；应停写后使用**新的备份路径**重试。事务内失败回滚，原版本仍可读取；不要用旧程序打开已有 v3 增量的 catalog 并试图写回旧 schema。

v3 当前已有明确启动的 DocumentVersion 发布与默认关系 CAS，操作见[解析与发布文档版本](document-processing.md)；本迁移命令本身不生成任何文档版本。证据解析与有界片段阅读已由 M05-T03 接通。v1/v2 原始材料、Library 与旧内容 reader 在新程序中继续可读；当前 Document writer/reader 接受完整 v3–v8。v3 起禁止旧已接纳材料清理与旧 artifact 物理回收；v5 起另有外部候选回执及其有限期输入保护，通用物理回收与明确失效流程仍未开放。所有备份与测试输出留在临时目录；本指南不授权真实用户数据迁移。全部版本和正式 v8 入口见[安装兼容矩阵](installation.md#当前-catalog-与-reader-兼容)。

## Catalog v4 合成迁移与检索索引

M07-T01/T02 在完整 v3 上增加可重建材料检索投影，不改变 v1/v2/v3 manifest 或 v3 fingerprint。只对已核实的系统临时目录 `sciretriever-*` 合成副本执行下列命令；v3→v4 需要一个尚不存在的同目录备份路径：

```bash
node apps/server/dist/cli/main.js storage retrieval-inspect --catalog /tmp/sciretriever-example/catalog.sqlite --json
node apps/server/dist/cli/main.js storage retrieval-migrate --catalog /tmp/sciretriever-example/catalog.sqlite --dry-run --json
node apps/server/dist/cli/main.js storage retrieval-migrate --catalog /tmp/sciretriever-example/catalog.sqlite --backup /tmp/sciretriever-example/catalog-before-v4.sqlite --synthetic-copy --json
node apps/server/dist/cli/main.js storage retrieval-inspect --catalog /tmp/sciretriever-example/catalog.sqlite --json
node apps/server/dist/cli/main.js maintenance rebuild-index --json
```

`retrieval-inspect` 和 dry-run 只读；真实迁移沿用同一写锁、备份验证、create-if-absent 和事务回滚纪律，v4 已存在时幂等返回。迁移只建 DDL/receipt，`active_generation` 初始为 `null`；不会下载、解析或暗中构建索引。`maintenance rebuild-index` 是**另外一次明确操作**，读取已保存元数据和已发布 DocumentVersion，经 Literature owner 校验 canonical 元数据后分批构建并原子发布新 generation；generation 保存索引内容与 FTS posting 的规范 SHA-256 摘要，读写均验证 v4 manifest、execution identity、完整性和摘要。材料变化使旧 generation 陈旧，需再次明确重建。普通查询只报告缺索引/陈旧/损坏，不自动迁移或修复。v4 的 Document writer/reader 继续支持精确版本与旧证据；清理保护延续 v3。真实用户 Catalog/资产切换仍未授权。
