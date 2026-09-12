# Candidate durable abandon/reject 闭环

2026-09-10。`CandidateAbandonmentService` 是 Candidate、ArtifactRecovery、FileStore 和 SQLite execution
schema 的统一回收 owner。WorkbenchSession 只允许当前人工 controller 放弃尚未被 receipt 使用的 Candidate；
已发布 Candidate、receipt 或 pending receipt 会在回收前拒绝。服务先写 `ArtifactRecovery` manifest，再在
SQLite 中原子 retire Candidate，最后按 hash 引用检查回收物理字节。catalog 已提交而进程在物理删除前中断时，
启动恢复会继续处理 manifest；共享 hash 被其它 Candidate 或正式 Asset 引用时保留。

Web 使用受保护的 `POST /api/candidate/abandon`，前端只显示给未发布 Candidate。移动端详情抽屉和桌面面板都
显示“放弃候选”；不确定身份的 Candidate 可回收，已发布 Candidate 仍显示已入库。放弃操作与 takeover、release、
pause、cancel、close 共用 AbortSignal 和控制 epoch，迟到结果不会重新删除或发布对象。

直接测试：

- `apps/server/test/candidate-abandonment.test.ts`：共享 hash 保留、receipt/pending receipt 保护、catalog
  提交中断后的重启恢复及物理文件结果；
- `apps/server/test/workbench-session.test.ts`、`workbench-http.test.ts`：controller/CSRF/epoch 约束；
- `apps/web/test/live-workbench.test.ts`：真实 Cloak Browser 双 viewer 旅程中捕获 uncertain PDF、通过 390px
  抽屉放弃、确认 Candidate 从 view 和 durable execution 中消失，已发布项跨重启保留。

未实现任意 artifact root 的全盘孤立文件扫描。该能力没有清单、对象 namespace 和引用边界时会误删用户
资产，因此作为后续显式 recovery 工具候选，当前不把危险扫描伪装成计划完成项。
