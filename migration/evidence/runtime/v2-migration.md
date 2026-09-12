# v1 → v2 Catalog 迁移证据

更新时间：2026-09-12。

迁移通过 `SqliteWorker` 的显式命令完成，不在普通查询时静默升级：先读取 schema identity，执行 backup/restore-check 或 dry-run，再由 `upgradeExecutionSchema` 创建 execution runtime 表和 v2 fingerprint。原 Literature、Asset、Reference、Parser 和 Content 事实保持原有 ID、hash 与相对路径。

直接证据：`apps/server/test/execution-runtime.test.ts` 覆盖 v1 合成 Catalog、dry-run、v2 升级、重复执行、备份完整性和 rollback；`apps/server/test/persistent-service-journey.test.ts` 覆盖 Application 关闭/重开后 v2 durable job 恢复。CLI 对应命令为 `storage inspect`、`storage migrate`、`storage backup` 和 `storage restore-check`。

迁移只使用系统临时目录中的合成数据库。真实用户 Catalog、WAL、副本和 Profile 的切换仍需 T056/T063 的单独授权流程。
