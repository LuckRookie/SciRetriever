# 持久任务执行服务证据

更新时间：2026-09-12。

`ExecutionTaskService` 是 durable job 唯一执行入口。它读取已冻结的 selector/goal，通过 `ExecutionQueue` 获得 target lease，调用既有 `LiteratureCompletionService`，并把 attempt、failure、intervention 和最终 job 状态写回同一 SQLite runtime；不会建立第二套 Literature 可用状态。

直接证据：

- `apps/server/test/persistent-service-journey.test.ts`：创建 v2 runtime、写入合成 Literature、创建 PDF 目标、执行到 pause intervention，关闭并重新打开 Application，读取同一 job/intervention，resolve skip 后恢复队列并完成；既有 Literature metadata 保持不变。
- `apps/server/test/execution-queue.test.ts`、`execution-recovery.test.ts`：lease fencing、retry、nextEligibleAt、attempt 状态、事件和 boot recovery。
- `apps/server/test/workbench-http.test.ts`：同一认证单端口的 `POST /api/v1/jobs/:id/run`。
- `apps/server/test/cli-main.test.ts`：`storage migrate` 后 `jobs create` 与 `jobs run` 均由 TypeScript Application 执行。

当前限制：执行服务只消费已存在的 Candidate/primary PDF 和已组装的 Literature completion owner；没有授权时不会启动真实站点、Provider、MinerU 或 LLM。Browser 页面重建仍要求用户重新打开工作台，持久状态只恢复任务、候选和业务事实。
