# Node SQLite 长期连接与 FTS5 完整性检查

适用范围：Node 22.19.0 / SQLite 3.50.4。长期只读连接在其它连接更新 FTS5 后，可能因旧连接视图报告 `malformed inverted index`；不能仅凭该现象认定磁盘索引损坏，也不能跳过正式完整性检查。

正式 v4 worker 与只读检索适配在命令边界检查 `PRAGMA data_version`，外部提交后重开连接并重新进行只读、schema 与完整性准入。运行时升级后应复核此兼容行为。

合成双连接复现、观测结果和适用边界见测试记录（本地文件：`sandbox/reports/sqlite-fts5-long-reader-2026-09-29.md`，不随仓库分发）；回归代码位于 `apps/server/test/`。
