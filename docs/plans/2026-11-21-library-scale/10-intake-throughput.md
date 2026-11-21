# 10 · 入库吞吐

类型：计划（结果块）
负责：查清入库每条约 0.4 s CPU 花在哪里，把入库吞吐提到 B7 的目标
状态：Done（待部署，随 14.3）

## 现状（待查）

CLI 引用扩展稳定在每秒 2 到 3 条、CPU 满载，约每条 0.4 s CPU。照这个速度，一百万篇要四天多，一千万篇要一个多月。可能的原因：入库时的身份匹配、合并，或每次写入后的状态与索引维护。写入越慢、越重，04、07 的负担越大。

已知的一项（14.1 第 3 轮）：写入一篇文献时，`apps/server/src/storage/sqlite/worker-runtime.ts` 约 619–627 行按 `literature_id` 查询、删除 `literature_search_fts` 的旧条目，`intake-withdrawal-engine.ts` 约 266 行同样删除。这一列声明为 `UNINDEXED`，两条语句都是全表扫描：1 万篇约 10 ms，1 百万篇约 0.94 s，千万篇约 10 s。性质：缺陷，违反 ADR 0065 第 3 节“写入只与本次的量有关”。改法需要文献到 FTS 行的映射（新表，或让 FTS 的 rowid 与文献的整数键对齐），属于结构变化，并入 14.3 的迁移。证据：`sandbox/reports/2026-11-21-scale-library/1m-20261121/round-3/concurrent-writer-fts-probe.json`。

## Outcome

- 一份剖析报告：CPU 按函数分布；每个热点的原因与性质。
- 入库吞吐达到 B7 的目标，且与库的总篇数无关（身份匹配用索引查找，不随总篇数变慢）。

## 进入条件

10.1、10.2 只读调查，G-dispatch 后即可做；10.3 起按已定的做法。

## 责任边界

- 后端。只在合成数据上剖析，不碰正式库与执行会话的进程。

## Tasks

- [x] **10.1 剖析**：在一百万篇合成库上入库 1,000 条引用扩展结果，用 `--cpu-prof` 或等价办法输出火焰图与前十个热点；并在一万篇库上做同样的入库，比较每条 CPU 是否随总篇数增长。
- [x] **10.2 结论**：每个热点写明原因、性质与建议去处；缺陷写成本块的修复任务，设计问题交 Owner。
- [x] **10.3 去掉随总篇数增长的两处**（缺陷，结构变化并入 14.3）：在 FTS5 的内容表 `literature_search_fts_content` 的 `c0`（即 `literature_id`）上建索引，按文献找旧条目改为索引查找，读旧正文、删旧条目都按 rowid；两张发现原因表各加按 `actual_literature_id` 的索引。只加三个索引，任何写入者（包括旧版本）写 FTS 时 SQLite 都会维护索引，不需要映射表或后台回填。
- [x] **10.4 按批写入**：做法见 [ADR 0065](../../architecture/decisions/0065-scale-rules.md) 第 6 节第 7 条。Provider 返回一批后，取一次写许可、开一个事务写完这一批（数百篇），批内复用预编译语句；进度、来源关系等事件仍逐条记录，只是同批提交。中途失败时这一批整体回滚，从批首重做。
- [x] **10.5 测试**：百万篇合成库上入库吞吐每秒至少 100 篇，且与一万篇上的吞吐相近；未达到时给出剩余热点，交 Owner 决定。

## 退出条件

14.2 中入库吞吐达到 B7 的目标。

## 进度

- 2026-11-22：10.1、10.2 完成（后端实施者）。在 1 万篇、1 百万篇合成库副本上各入库 1,000 条（新建 600、重放匹配 200、合并 200），走生产的 `runMetadataTask`，Provider 用本地假响应。每条墙钟 158 → 1,271 ms，CPU 98 → 1,291 ms。
  - 随总篇数增长：`literature_search_fts` 按 `literature_id` 的查询与删除，CPU 合计 13 → 1,122 ms/条，占 1 百万篇 CPU 的 87%；改为按 rowid 定位后同一查询 950 → 0.012 ms。另有发现原因表按 `actual_literature_id` 查询是全表扫描，随历史增长（合成库里这两张表为空，未能量化）。
  - 与总篇数无关、但每条太重：每条 7 个写事务、7 次启动 `flock` 进程取写许可（1 万篇上占 CPU 19%）、语句每次重新编译。
  - 身份匹配（DOI、稳定标识、标题指纹、Provider 记录）都走索引，两种规模的查询计划相同。
  - 估算：去掉 FTS 扫描并按批写入后约每秒 40–68 篇，仍低于 100，10.5 实测后再看剩余热点。
  - 报告 `sandbox/reports/2026-11-22-intake-profile/REPORT.md`。
- 2026-11-22：10.3 完成（后端实施者，两轮）。第 1 轮照原定做法加了映射表与后台回填，同时在 FTS 内容表上建了索引；总设计师核实单靠这个索引就够（建索引 20 万行 58 ms，FTS5 的 `rebuild`、`optimize`、`integrity-check` 之后正常），第 2 轮去掉映射表，只留三个索引。每条入库：1 万篇 158 → 132 ms，1 百万篇 1,271 → 140 ms，CPU 1,291 → 81 ms。1 百万篇副本上建三个索引用时 1.2 s。迁移是显式的（`scripts/migrate-literature-search-indexes.mjs`），结构号仍是 19，指纹改变：新版本要先迁移才能打开正式库；旧版本 `56d843ab` 打不开迁移后的库（`catalog-layout-not-current`），归 11。总设计师复跑 literature-search-rows 2、literature-search-schema-migration 1、catalog-schema 8、intake-withdrawal 19、discovery-citation 1、discovery-topic 2、intake-batches 5、library-pagination 1、citation-limits-schema-migration 4、openalex-top-concepts-cleanup 4，`pnpm build` 通过。报告 `sandbox/reports/2026-11-22-intake-fts-map/REPORT.md`。
- 2026-11-22：10.4、10.5 完成（后端实施者，两轮）。引用扩展从 Provider 已缓冲的回包每次取最多 128 条，一段取一次写许可、一个事务；写满 150 ms 或有同进程写入在等时提前交出许可，一篇的关系多时可以切段，“已查”写在最后一段。段失败整体回滚，从段首重做；段的检查点记为执行事件 `citation-write-checkpoint`，任务详情与事件列表不显示。批内复用预编译语句。每条入库 1 万篇 9.65 ms、1 百万篇 9.92 ms，每秒 104 / 101 篇，每条写事务 7.0 → 0.06；最长一段 188 ms，网页上一次写入 142 ms。1 百万篇刚过线，前一次测得 99.2 篇/秒。第 2 轮由总设计师审查提出：续跑时 Provider 的返回与上次写到一半的不同，原来会让任务失败；改为保留已提交的关系、写入新返回，记一条 `citation-response-replaced` 后继续。总设计师复跑 discovery-intake-segments 11、intake-batches 5、retrieval-write-fairness 1、discovery-citation 1、discovery-topic 2、task-detail-source-results 10、production-workbench-tasks 18、processing-tasks 9、metadata-source-results 4、literature-search-rows 2，`pnpm build` 通过。报告 `sandbox/reports/2026-11-22-intake-batches/REPORT.md`。
- 残余：千条以上的任务结算段与跨进程 HTTP 写入等待没有实测上限，归 14.2。
