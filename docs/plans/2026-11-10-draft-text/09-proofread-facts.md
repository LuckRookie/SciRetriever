# 09 · 选择校订范围的事实

类型：计划（结果块）
负责：四项不调用模型的事实的计算、保存、机器读取，以及作为文献库筛选与排序
状态：Completed（2026-11-15；9.1 随计划 16 暂缓）

## Outcome

- 每个以初稿为默认文本的部分提供 `DraftFacts`：形成时保存的 `differs_segments`、`differences`、`image_only_pages`，以及读取时聚合的 `citing_results`、`unfound_citations`。默认文本不是初稿时为 null。
- 三端的文献库条目（`draft_facts`）、文献详情（含 `LiteratureAssetView.default_text`）与建档状态（`parts[].draft_facts`）返回这些事实。
- `LibraryQuery` 的五个新筛选与 `LibrarySort` 的四个新排序键可用，只看主 PDF 的默认文本。例如“疑点最多的 50 篇”“含扫描页的”。筛选结果可以作为建档的范围（ADR 0052），只在使用者明确发起建档时校订。
- 结果发布时写入 `processor_unfound_citations` 投影。
- 发起建档前的用量估算沿用现有 `usage-estimate`（04 §6.7）。

规格：[04 §8.7](../../architecture/technical/04-document-evidence.md#87-选择校订范围的事实)（事实与计数口径）；[06 §2.1.7](../../architecture/technical/06-retrieval-context.md#217-目标接口尚未实现文本等级与选择校订范围的事实)（字段、位置、筛选、排序、cursor）；[07 §4.2](../../architecture/technical/07-versioned-storage.md#42-数据与写入所有权)（投影的结构与写入方）。

## 进入条件

03、04、07 完成。

## 责任边界

- 负责：后端实施者。
- 拥有：`DraftFacts`、`LibraryQuery` 与 `LibrarySort` 的新字段（`packages/contracts/src/index.ts`）及解析；文献库查询的筛选与排序实现；`processor_unfound_citations` 的写入。
- 投影的写入方按 07 §4.2 是 Analysis（在发布结果的同一事务内）。本块在 Analysis 的结果发布路径里加写入，不改结果内容。
- 触达：
  - `apps/server/src/storage/sqlite/worker-runtime.ts` 与文献库查询代码；
  - 加工结果发布的存储事务（`apps/server/src/storage/sqlite/processor-engine.ts`），写入 03 建的投影表；
  - 文献库状态缓存的失效触发。
- 不改：逐值核对的规则（`analysis/value-check.ts`）；加工结果的身份与内容；保存的筛选（技术文档 09 §9.1，另有计划）。

## Tasks

- [ ] **9.1 投影写入**（2026-11-15 随计划 16 暂缓：现行算子只读校订稿，投影恒为空；计划 16 让算子读取初稿时，在结果发布事务里补上这项写入）：按 07 §4.2 写 `processor_unfound_citations`：只为引用初稿版本的来源写行，结果删除时级联删除。schema 17 之前没有初稿，不回填（07 §4.2）。
- [x] **9.2 聚合读取**：按本页文献 ID 批量读取 `DraftFacts`；`citing_results` 与 `unfound_citations` 的口径见 04 §8.7，按 `document_version_id` 查索引（03 建的索引），不扫描全部结果、不打开结果文件。
- [x] **9.3 字段**：文献库条目与文献详情的 `draft_facts`、`LiteratureAssetView.default_text`、建档状态 `parts[].draft_facts`（06 §2.1.7）。
- [x] **9.4 筛选与排序**：按 06 §2.1.7 实现 `text_levels`、`has_draft_differences`、`has_image_only_pages`、`cited_by_results`、`has_unfound_citations` 与四个排序键。省略的新字段不进入规范化查询，已有请求、cursor 与任务里保存的 selector 字节不变；接受 `LibrarySort` 的地方（包括 `AcquirePdfSelector`，因此也包括 05 的 `form-drafts`）都接受新键。
- [x] **9.5 缓存与失效**：初稿形成、默认文本改变、结果发布或过时都会改变事实，相关文献的文献库状态缓存要失效。
- [x] **9.6 三端**：文献库读取与查询在 HTTP、CLI、MCP 一致。

## 集成与影响

- 文献库查询增加筛选与排序项，是公开合同变化。
- 在计划 16 让算子读取初稿之前，后两项事实恒为 0。这是事实，不是缺陷；界面不应暗示“没人用过”以外的含义。

## 验证

新增 `apps/server/test/draft-proofread-facts.test.ts`（合成库、合成结果行），证明：

- 四项事实等于合成数据的已知值（04 §8.9）；
- 内容过时的结果不计入 `citing_results`；只因算子方法较旧而过时的结果仍计入；同一结果计一次；校订稿上的“找不到”不计入初稿；
- 默认文本是校订稿或没有默认文本时 `draft_facts` 为 null，后四个筛选 true 与 false 都不匹配它；
- 按 `draft-differences-desc` 排序、按 `has_image_only_pages` 筛选的结果与已知顺序一致；没有值的文献排在最后；`literature_id` 打破并列；分页稳定；
- 不带新字段的旧请求，规范化查询与 cursor 字节不变；
- 结果发布失败时投影不留半条；
- 事实变化后文献库读取到新值（缓存失效）。

扩展：`library-pagination.test.ts`、`library-state-incremental.test.ts`、`processor-storage.test.ts`（投影写入）、`workbench-library.test.ts`；三端一致：`interface-maintenance-parity.test.ts` 或 `cli-main.test.ts`、`mcp.test.ts`。

## 证据

提交号；定向测试结果；排序与筛选在 1,000 篇合成库上的查询耗时（本机，记入回执）。

## 退出条件

四项事实三端可读、可筛选、可排序；10 块可以接界面。

## 恢复与交接

9.1 改的是 Analysis 的结果发布事务，计划 16 也在改结果存储。开工前与计划 16 的负责人确认先后与写入位置，记入本块。
