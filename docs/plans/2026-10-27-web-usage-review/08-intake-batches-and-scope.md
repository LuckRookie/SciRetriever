# 08 · 入库批次与获取范围

类型：计划（结果块）
负责：P33、P34
状态：In progress

## Outcome

- 每次元数据入库都有持久的批次记录，写明命中、新增、已在库与这批的 PDF 进度；可以从批次直接获取其中待获取的文献。
- 文献库可以按入库批次、作者关键词、主题词缩小范围，并看到范围内最常见的词；获取 PDF 先写明范围再提交，按筛选整体提交不受 1,000 篇限制。
- OpenAlex 学科分类改为主题词；作者关键词按 ADR 0037 的优先级显示出来。

决定见 [ADR 0052](../../architecture/decisions/0052-intake-batches-and-explicit-scope.md)，界面以[页面规格](../../architecture/web/page-specs.md)的“文献库”“阅读页”“入库”“任务与 Agent 会话”各节为准，查询合同见 [technical/06 第 2.1 节](../../architecture/technical/06-retrieval-context.md#21-本地文献数据库查询与详情)。设计稿：https://claude.ai/artifact/Dyhj5rMeUox2g2w73C343M

## 进入条件

- ADR 0052 已 Accepted（Owner 2026-11-01：“按设计做”）。
- 表结构迁移、部署按本计划 Human Gate 已授权。

## 责任边界

- Codex（`sciretriever-web`，gpt-6.1-sol / max，Owner 2026-11-01 指定）：合同、服务端、迁移与测试。派工单 `sandbox/prompts/2026-11-01-plan17-08-intake-batches-backend.md`，回执 `sandbox/reports/2026-11-01-plan17-08/`。
- Claude：Web 界面、文档、全量测试、部署 4174。

## Tasks

- [x] **8.1 合同**（Codex，`1003049`、`755892a`）：入库批次、`LibraryQuery` 的批次与主题词、范围内词频、获取范围预览与按筛选提交、`subject_terms`。
- [x] **8.2 服务端与迁移**（Codex，`53a34f6`、`437f409`；副本演练 14 → 15 用时 115 s，文献 35,177 篇不变）：批次记录与“早期入库”、词频、范围解析、OpenAlex 映射、关键词投影、表结构迁移；真实库副本上演练。
- [x] **8.3 界面**（Claude）：入库记录、侧栏最近入库、批次名筛选、范围内的词、获取 PDF 范围对话框、任务范围、阅读页三种词与入库。
- [x] **8.4 文档**（Claude）：technical/06 查询合同、Web 指南、入库与 PDF 获取指南。
- [ ] **8.5 收尾**（Claude）：全量测试、提交、部署 4174（含迁移），在 4174 上核对 P33、P34 的检验。

## 验证

- 8.1–8.2：派工单列出的直接测试；迁移演练的耗时与前后计数。
- 8.3：Web 测试覆盖入库记录、批次筛选、词频点选、获取对话框的篇数与提交范围一致。
- 8.5：Full 通过；4174 上入库页显示“早期入库” 35,177 篇，阅读页显示主题词，文献库词频可点选。

## 恢复与交接

- 迁移在部署前先在真实库副本上演练；部署按现行流程先备份，失败用备份回滚。
- Codex 与 Claude 在同一工作区并行：Codex 只提交 `packages/contracts`、`apps/server` 下的具体路径，Claude 只提交 `apps/web`、`docs`。
