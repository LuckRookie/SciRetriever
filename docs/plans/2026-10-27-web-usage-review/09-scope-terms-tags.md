# 09 · 范围内的词以标签为主

类型：计划（结果块）
负责：P35
状态：Done（2026-11-02）

## Outcome

- 文献库“范围内的词”依次列出标签、作者关键词、主题词，每行写明覆盖篇数；点标签即按标签筛选。
- 有标签的篇数达到一半时主题词默认收起；作者关键词对应标签时指出，并可一键改用标签筛选。

决定见 [ADR 0053](../../architecture/decisions/0053-scope-terms-led-by-tags.md)，界面以[页面规格](../../architecture/web/page-specs.md)“文献库”一节的“范围内的词”为准，返回形状见 [technical/06 2.1.6](../../architecture/technical/06-retrieval-context.md#216-入库批次范围词频与-pdf-获取范围)。

## 进入条件

- ADR 0053 已 Accepted（Owner 2026-11-02：“按这个思路做”）。
- 不改 catalog 表结构；部署按本计划 Human Gate 已授权。

## 责任边界

- Codex（`sciretriever-web`）：合同与服务端。派工单 `sandbox/prompts/2026-11-02-plan17-09-scope-terms-tags.md`，回执 `sandbox/reports/2026-11-02-plan17-09/`。
- Claude：Web 界面、文档、测试、部署 4174。

## Tasks

- [x] **9.1 合同与服务端**（Codex，`6d68674`；真实库副本 p95：整库 39.6 → 54.3 ms，“早期入库” 68.9 → 89.4 ms，Chemistry 367 → 506 ms）：范围词频加标签一层、各层覆盖篇数、作者关键词对应的标签；CLI 与 MCP 同一返回。
- [x] **9.2 界面**（Claude，`fd4530b`、`4da530d`）：三层顺序、覆盖篇数、主题词收起、关键词的标签记号与“改用标签筛选”。
- [x] **9.3 收尾**（Claude）：定向测试、提交、部署 4174，在真实库副本上核对。4174 运行 `4da530d`，schema 15 不变；部署前备份在 `production-22/backup-schema15-before`。
- [x] **9.4 清理旧数据的 OpenAlex 顶层大类**（Owner 2026-11-02：“清理，先备份”；Codex `0829936`，Claude 执行）：旧数据没有相关度，只删除来源为 OpenAlex 的 19 个 level 0 大类并重新投影受影响的文献。4174 停机、备份到 `production-23/backup-schema15-before` 后运行 `scripts/cleanup-openalex-top-concepts.mjs`：删除观测主题词 55,149 行，重新投影 29,299 篇，当前主题词 233,910 → 199,890 行，其中 120 篇清理后没有主题词；外键 0、integrity ok，用时 104 s。4174 运行 `0829936`。

## 验证

- 9.1：派工单列出的直接测试；真实库副本上整库与批次范围的词频耗时不劣于现状。
- 9.2：Web 测试覆盖三层顺序、点标签加入标签筛选、主题词收起与展开、改用标签筛选。
- 9.3：4174 上有筛选时可见标签一行（有标签时）与各层覆盖篇数。
