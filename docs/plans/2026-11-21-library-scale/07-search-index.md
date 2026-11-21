# 07 · 搜索索引只处理变化

类型：计划（结果块）
负责：大批量写入期间搜索索引能跟上写入，刷新的耗时与总篇数无关；相关度搜索在千万篇时也能很快出来
状态：Ready（设计已定，等 G-dispatch）

## 现状

- 每次刷新先调用 `scanChanges`（`apps/server/src/storage/sqlite/retrieval-engine.ts`），把全库每篇的“当前版本”与“已索引版本”全部读出来逐篇比对，再处理变化的文献。18.8 万篇时光比对就约 11 s。
- 写入不停，刷新就一轮接一轮；4174 里一个线程长期 100% CPU 就是它。修订号相差 215 万，不代表有那么多篇没进索引。
- 相关度排序要对全部匹配项计算得分；常见词在千万篇里会匹配几百万条。

性质：设计问题（B4）。

## Outcome

- 刷新只处理写入时记下的变更，耗时与变化的篇数成正比。
- 持续写入期间，索引落后保持在 B11 定下的范围内。
- 相关度搜索按 B4 的口径取前若干条，界面如实说明。
- 搜索结果与全量重建一致；现有的 `verify` 作为全量维护操作保留。

## 进入条件

B4 的决定（已定，见 [ADR 0065](../../architecture/decisions/0065-scale-rules.md) 第 6 节）。变更记录要加表，上线方式同 04。

## 责任边界

- 后端。规格：[查询技术篇](../../architecture/technical/06-retrieval-context.md)的索引一节。

## Tasks

做法见 [ADR 0065](../../architecture/decisions/0065-scale-rules.md) 第 6 节第 4 条。

- [ ] **7.1 变更记录**：由触发器把影响索引的变更记进库里（现有触发器已维护源修订号，在此基础上记下文献 ID）；按 11 的方式加表。
- [ ] **7.2 刷新**：`scanChanges` 改为读取上次索引位置之后的变更；全量比对只留给重建与 `verify`。
- [ ] **7.3 相关度截断**：相关度排序只取前 1,000 条，合同与界面写明。
- [ ] **7.4 测试**：增量刷新与全量重建的一致性；百万篇上每秒写入 100 篇时的索引落后；搜索耗时。

## 进度

- 2026-11-21：修复一个缺陷（不属于 7.1–7.4）：持续写入时增量刷新永不收尾。原来收尾要求扫描以来源修订号不变，CLI 引用扩展不停写入时每轮作废重来，正式库的 `indexed_revision` 从 10:00 起停在 1,834,870。现在每轮处理完扫描名单后把水位推进到扫描时点，之后的写入留给下一轮。后端实施者实现，修复前两条新测试失败、修复后通过；总设计师复跑 retrieval-delta 10、retrieval-incremental 6、retrieval-refresh 12、retrieval-stale-serving 6、index-background 3、archive-index-refresh 2，`pnpm build` 通过。报告 `sandbox/reports/2026-11-21-index-refresh-livelock/REPORT.md`。每轮仍是全库比对，由 7.1、7.2 解决。

- 2026-11-21：修复第二个缺陷（不属于 7.1–7.4）：索引在代码里写死最多 100,000 个来源、2,000,000 个条目、2 GiB 文本，规格没有写，与 ADR 0065 矛盾；正式库 18.8 万篇在 16:23 以 `index-limit` 失败，126,406 篇未进索引。现在去掉总量上限，保留单篇 64 MiB 上限；磁盘写满时报 `index-storage-full`；增量比对改为两路有序归并，不再把全库指纹放进内存；启动时对上次 `index-limit` 的失败自动重排一次。12 万篇合成库：重建 1,633 s，追加 1,000 篇后增量 93 s 追平，与再次重建一致。总设计师复跑 retrieval-refresh 14、delta 10、incremental 6、stale-serving 6、index-background 3、archive-index-refresh 2、retrieval-context 24、maintenance 1、reclamation 8、write-fairness 1、contracts index-refresh 5，`pnpm build` 通过。报告 `sandbox/reports/2026-11-21-index-capacity/REPORT.md`。
- 待定：全量重建约每秒 100 个书目来源、5 个全文来源；一百万篇约 4–8 小时，一千万篇约 38–84 小时。最慢的是逐篇核对书目详情。重建是显式维护操作，但这个时长会影响迁移和恢复，拿给 Owner 讨论是否要定目标。
- 回退注意：新的生成回执 `source_count` 可以超过 100,000，旧版本 `56d843ab` 的合同会拒绝这样的回执，回退后旧版本的索引不可用，直到重建。

## 退出条件

14.2 中，持续写入时索引落后在目标范围内，没有长期满载的线程；相关度搜索达到目标耗时。
