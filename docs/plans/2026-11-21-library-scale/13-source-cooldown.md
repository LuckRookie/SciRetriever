# 13 · 来源限流后冷却重试

类型：计划（结果块）
负责：长任务中某个来源被限流后，冷却一段时间再用，而不是整个任务都不再用它
状态：Ready（设计已定，等 G-dispatch）

## 现状

Semantic Scholar 与 CORE 被限流一次后，整个任务剩下的时间都不再使用（`apps/server/src/entry/discovery.ts` 的 `recordCitationFailure`），没有冷却后重试。对要跑几天的任务，结果会漏掉这些来源本可以给出的部分。OpenAlex 的额度规则见 [`docs/notes/providers/openalex.md`](../../notes/providers/openalex.md)。

性质：设计问题（B10）。

## Outcome

- 限流后按 B10 的规则冷却、重试；重试次数用完才在本任务内停用该来源，并在任务详情里写明。
- 不超过各来源公开的额度。

## 进入条件

B10 的决定（已定，见 [ADR 0065](../../architecture/decisions/0065-scale-rules.md) 第 6 节）。冷却状态若要跨中断保存，并入 12。

## 责任边界

- 后端。

## Tasks

做法见 [ADR 0065](../../architecture/decisions/0065-scale-rules.md) 第 6 节第 10 条。

- [ ] **13.1 冷却与重试**：替换 `recordCitationFailure` 的“一次即停用”；按 `Retry-After` 或 1、5、15、60 分钟冷却，最多重试 6 次。
- [ ] **13.2 保存**：冷却状态随 12 的进度一起存，中断后不丢。
- [ ] **13.3 任务详情**：显示某来源正在冷却、下次重试时间、已停用及原因。
- [ ] **13.4 测试**：本机假来源模拟限流，断言冷却间隔、重试次数、停用后的记录、其他来源不受影响。

## 退出条件

假来源测试通过；任务详情里能看到某来源被冷却与恢复。
