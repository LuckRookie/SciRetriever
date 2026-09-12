# TS 版本切换与回退

真实切换需要独立授权。本手册先用于合成副本演练：

1. 停止旧 writer，等待正在进行的任务和 Browser transfer 收束。
2. 关闭 Browser Profile，确认没有第二个 writer 或活动 lease。
3. 创建 v1 backup，运行 integrity restore-check，并保存迁移 receipt。
4. 在副本上执行显式 v1→v2 migrate，检查 schema fingerprint、Literature/Asset 数量和关键 hash。
5. 启动 TypeScript server，运行 `doctor`、`storage inspect` 和本地 Library/Jobs smoke。
6. 检查 Candidate/receipt reconciliation、任务状态和配置 readiness，再开放本地端口。

如果任一步失败，停止 TS writer，保留失败副本和日志，使用未修改的 backup 做 restore-check；不得把新增关系覆盖回旧副本，也不得在没有确认 lease 已释放时并行启动旧进程。Browser DOM 不作为可恢复事实，回退后由 operator 重新打开工作台。生产数据、凭据、Profile 和真实站点效果不在默认演练范围。
