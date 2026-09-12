# Candidate 与发布回执恢复

日期：2026-09-10。仅操作系统临时目录的合成 catalog 和三个测试字节，不使用真实文献、个人配置或网络。

## 实现

- `packages/contracts/src/index.ts` 定义独立 execution contract version 1，严格解析 durable Candidate、发布输入与回执；v1 Model/canonical fixture 不变。
- `BrowserTransferCollector.complete` 先以 create-if-absent 将完整字节封存为 `.candidates/<sha256>.bin`，再写入执行记录。FileStore 关闭只清理未完成 stage，不删除封存字节。恢复重新核对长度/hash，逐层 no-follow 打开目录和文件。
- `SqliteWorker.upgradeExecutionSchema()` 是明确升级入口，普通 v1 打开不创建执行表。`execution_schema_identity` 保存独立 version/fingerprint；`execution_candidates` 保存严格 DTO 的 JSON；`execution_receipts` 保存完整确认输入及 nullable 结果。无 BLOB、无第二个 catalog、无 job 队列。
- Acquisition 先保存确认输入，再发布不可变文件，最后用一个 SQLite 事务写 v1 asset/provenance/relation 与 receipt 结果。receipt ID 绑定完整输入；不同目标、归属、资产 ID 或 provenance 不可复用。现有同 ID 行必须逐字段相同，不能用 `ON CONFLICT DO NOTHING` 掩盖冲突。
- `CandidatePublisher.reconcile()` 只重试已保存的确认输入；不是未完成 Browser 任务续跑。没有确认输入的 Candidate 保留供后续判断。
- `backup(path)` 使用同连接 `VACUUM INTO` 生成快照，目标已存在则拒绝。`rollbackExecutionSchema(backupPath)` 先生成包含 Candidate/receipt 的备份，再移除扩展；已经确认的 v1 文献事实与不可变文件保留。恢复演练从该快照重新打开，不覆写活动库。
- Application 使用 `executionSchema: "upgrade-synthetic"` 显式组装同一 DB/FileStore 下的 collector/publisher；默认不开启扩展。生产迁移/切换没有获得授权。

## 直接证据

`apps/server/test/candidate-publication.test.ts` 使用真实 SQLite 和 FileStore：

1. 关闭全部旧 owner 后，新 worker 读取 Candidate、发布并重复读取回执。
2. 文件发布后模拟事务中断，新 owner 从 pending receipt 对账完成，文件相同即复用。
3. 事务提交后模拟响应丢失，重试返回持久回执，不重复事实。
4. uncertain、不同输入复用 receipt、目标字节冲突、Candidate 篡改、目录符号链接均拒绝。
5. 独立 Node 子进程只凭临时 home 中记录恢复并完成发布。
6. 显式升级、v1 不隐式升级、含已确认事实的备份/回滚/重新打开和重复备份拒绝。

新增独立进程测试发现并修复 worker 继承 `--input-type` 导致启动失败、失败 worker 关闭悬挂的问题。目标 Browser 下载、PDF/identity 归属证据与 Web 正式发布入口仍由阶段 03/05 集成，不据此宣布整条旅程完成。


验证：`pnpm full` 通过，45 个测试文件 / 162 个测试（日志 `/tmp/sciretriever-execution-full.log`）。
发布输入还绑定 Literature metadata revision/hash；prepare 和 commit 都核对快照，期间元数据改变则拒绝，
不覆盖当前事实。已提交回执重放重新校验正式文件长度/hash，损坏时不返回成功。
同轮修复 Network Retry-After 定时器提前唤醒后遗漏重排的问题，直接测试使用可控时钟复现，未增加真实等待。
