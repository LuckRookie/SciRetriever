# NETWORK-BUDGET 执行与审查记录

状态：`Completed`。本文件记录共享预算和请求编排验收。

## 已有实现与测试

`network-budget.test.ts` 有 11 项通过，覆盖 scope/host permit、排队取消、响应体量、共享 usage、显式 retry loop、Retry-After 和零 redirect budget。

## 验收结果

| 边界 | finding 与关闭条件 |
| --- | --- |
| 主动取消 | queue、connect 和 response read 均消费 AbortSignal；loopback response read 取消后连接关闭且 permit 可再次取得。 |
| 字节预算 | consumeResponse 只接收解析后的 body chunk，Content-Length/截断/超限失败后释放 permit。 |
| retry/redirect | requestFollowingRedirects 使用同一 BudgetUsage；显式 retry 消费 maxRetries，redirect 消费 maxRedirects；Retry-After 有界并进入 coordinator 冷却。 |
| 共享限制 | scope 和 host 均按当前最小上限阻塞，重复 release 不会改变计数，跨 scope host 共享有正例。 |

## 恢复与范围

当前串行恢复点为 `FILE-STAGE-WRITE`，以活动计划根 README 和对应 Task 为准。
测试只使用 fake DNS、合成字节、loopback 和系统临时目录；未读取真实凭据/用户数据或访问真实外部服务。
