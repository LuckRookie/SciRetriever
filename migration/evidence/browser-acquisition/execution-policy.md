# Execution Policy 直接验证

`ExecutionPolicy` 在创建时冻结 source/version 和 action/model/retry/bytes/deadline budget，pause/resume 不重置 usage，cancel 与 exhausted 为不同终态。`ExecutionLoop` 在 vendor dispatch 前检查 epoch、observation revision 和 request id 幂等。

命令：`pnpm exec vitest run apps/server/test/execution-policy.test.ts --reporter=verbose`；结果：2 tests passed。

本文件记录最初的 policy/loop 单元切片。后续[Browser Agent runtime](browser-agent-runtime.md)、
[会话 API](workbench-session-api.md)和[Browser lifecycle 矩阵](browser-lifecycle-matrix.md)已接入模型决定、
Browser permit、Candidate 收敛、takeover/取消传播及失败重放；首阶段执行边界已经闭环。后台持久任务队列与
跨重启未完成动作续跑明确 Deferred。
