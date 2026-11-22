# 13 · 来源限流后冷却重试

类型：计划（结果块）
负责：长任务中某个来源被限流后，冷却一段时间再用，而不是整个任务都不再用它
状态：Done（待部署）

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

- [x] **13.1 冷却与重试**：替换 `recordCitationFailure` 的“一次即停用”；按 `Retry-After` 或 1、5、15、60 分钟冷却，最多重试 6 次。
- [x] **13.2 保存**：冷却状态随 12 的进度一起存，中断后不丢。
- [x] **13.3 任务详情**：显示某来源正在冷却、下次重试时间、已停用及原因。
- [x] **13.4 测试**：本机假来源模拟限流，断言冷却间隔、重试次数、停用后的记录、其他来源不受影响。

## 进度

- 2026-11-22：13.1、13.2、13.4 与 13.3 的后端完成（后端实施者，一轮）。规则写进[任务协调 5.2](../../architecture/technical/02-task-coordination.md#52-并发中断与恢复)的“来源冷却”一段。冷却期间跳过的“文献 × 来源”在来源恢复后补查，结果与没有限流时逐项相同；冷却状态随第 12 块的检查点保存，不加表。没有限流时查询序列与写入不变。总设计师复跑见提交说明，`pnpm build` 通过。报告 `sandbox/reports/2026-11-22-source-cooldown/REPORT.md`。
- 13.3 待前端：现有任务详情能按通用事件展开 `citation-source-cooldown`、`citation-source-deferred`；持续显示“某来源冷却中、下次重试时间、已停用及原因、待补查条数”要用 `task.citation_source_cooldowns`，界面另做。
- 残余：
  - 任务有结果上限时，限流期间健康来源先提交的独有结果可能改变触及上限时的结果集合与顺序。
  - OpenAlex 匿名请求返回 401 是否表示额度用尽，没有确认，仍按认证失败处理。
  - 旧版本已停用来源的检查点里没有历史跳过项，这些不会补查。
- 2026-11-22：前端完成（前端实施者，一轮），报告 `sandbox/reports/2026-11-22-library-frontend/REPORT.md`，截图 `sandbox/reports/design-samples/2026-11-22-2026-11-22-library-2/`、`-library-3/`。总设计师复跑 web 测试 14 个文件 134 项通过（3 项按条件跳过），`pnpm build` 通过。任务详情的“来源”一组显示冷却中、等待重试、已停用、已恢复、冷却结束重试出错与待补查样本。后端缺口：`citation_source_cooldowns` 不在 `packages/contracts`，前端在 `data/tasks.ts` 自行解析。

## 退出条件

假来源测试通过；任务详情里能看到某来源被冷却与恢复。
