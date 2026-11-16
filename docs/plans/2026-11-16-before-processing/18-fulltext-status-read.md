# 18 · 全文取得情况的读取

类型：计划（结果块）
负责：任意文献库范围的“已取得、未取得、已试完”三个数在 CLI、MCP、HTTP 上的读取
状态：Pending

来源：原计划 23 的 02（任务 2.x 改为 18.x）。

## Outcome

- `LibraryCounts` 增加 `full_text: {total, obtained, missing, exhausted}`：任意 `LibraryQuery` 范围（全库、文件夹、入库批次、一次发现、保存的筛选的条件）里按论文计的总数、已取得、未取得与其中已试完。没有新的操作，三个入口仍是 CLI `literature counts`、MCP `library_counts` 与 HTTP `library-counts`，结果相同。
- `LibraryCounts` 另增加按版本的 `with_primary_pdf`；`LibraryQuery` 增加筛选 `has_primary_pdf`（按版本），供文献库从这一行跳到列表、并让快速筛选“有 PDF”“仅元数据”按新含义工作（19）。
- 原有的按状态计数不变。读取不联网、不调用模型、不创建任务（规1）。

规格：[查询技术篇 2.1.8](../../architecture/technical/06-retrieval-context.md#218-文献库计数与全文取得情况)（`LibraryCounts`、`FullTextCounts`、范围、单位、关系、一致性、`has_primary_pdf`）；耗尽事实见[文献与材料 4.5](../../architecture/technical/03-literature-materials.md#45-获取流程)。

## 进入条件

规格已补齐（原计划 23 的 01，已完成）。

## 责任边界

- 负责：后端实施者。
- 拥有：`packages/contracts/src/library-counts.ts`；`LibraryQuery` 的解析（`packages/contracts/src/index.ts`）；`apps/server/src/storage/sqlite/library-page.ts` 的 `libraryCounts` 与 `libraryFilter`。
- 触达：CLI `literature counts`（`apps/server/src/cli/main.ts`）、MCP `library_counts`（`apps/server/src/mcp/server.ts`、`tools.ts` 的工具说明）、HTTP `library-counts`（`apps/server/src/workbench/http.ts`）；Web 的数据层 `apps/web/src/app/data/library.ts` 同步类型。
- 不改：文献状态的推导（`sr_status`）；原有计数字段的含义；自动获取耗尽事实的写入与清除；`AcquirePdfSelector` 的跳过规则；表结构（计划 README“数据库”）。

## Tasks

- [ ] **18.1 合同**：`LibraryCounts` 增加 `full_text` 与 `with_primary_pdf`（按版本），`FullTextCounts` 的四个字段与解析函数；解析时核对 `total = obtained + missing` 与 `exhausted ≤ missing`。`LibraryQuery.has_primary_pdf` 与解析；省略时规范化查询与 cursor 的字节不变。
- [ ] **18.2 计数**：在同一个只读快照里求 `full_text`：范围与现有计数相同（忽略 `statuses` 与 `needs_manual_pdf`）；按论文（MetaLiterature）计；论文在范围内当且仅当至少一个版本命中；是否取得、是否试完看这篇论文的全部当前版本（取法同 `selectionSnapshot` 的 matches 与 members）。在 SQL 里聚合，不逐篇读取。
- [ ] **18.3 筛选**：`has_primary_pdf` 按版本筛选，与其它条件 AND。
- [ ] **18.4 三端**：三个入口返回同一结果；MCP 工具说明与 CLI 帮助写明 `full_text` 按论文、状态计数按版本。
- [ ] **18.5 规模**：在 5 万篇的合成库上测一次计数耗时（本机），记入回执；若超出 Web 可用的范围（例如数秒），停下交总设计师，与 20 的数字一起判断是否需要投影（计划 README“数据库”）。

## 集成与影响

计数读取多了字段（或多了一个读取），是公开合同变化；Web 在 19 之前不显示它们。

## 验证

新增或扩展 `apps/server/test/library-counts-intake.test.ts`（或新增 `library-fulltext-status.test.ts`），在合成库上证明：

- 文件夹、入库批次、一次发现、组合筛选各一种范围，三个数与已知值相等；
- 有主 PDF 的 `ASSET_READY`、`ARCHIVING`、`ARCHIVE_FAILED`、`READY` 与 `EXCLUDED` 都算已取得；
- 按论文计：预印本无 PDF、正式版有 PDF 的论文只计一次，算已取得；只有预印本命中查询时，正式版的 PDF 同样使它算已取得；两个版本都没有 PDF、只有一个版本有耗尽事实时，不算已试完；
- `total = obtained + missing`、`exhausted ≤ missing` 在每个范围上成立；原有状态计数不变；
- 当前选中的快速筛选（`statuses`、`needs_manual_pdf`）不影响 `full_text`；
- `with_primary_pdf` 与 `has_primary_pdf: true` 的列表条数相等；`has_primary_pdf` 的 true、false、省略三种情形，省略时规范化查询的字节不变；
- 临时错误（网络、限流、配置、取消）结束的获取不计入已试完；全部途径正常未命中的计入；新元数据到达后不再计入已试完；
- 读取前后 catalog 不变，没有任务被创建，没有网络调用；
- 三端一致：扩展 `cli-main.test.ts`、`mcp.test.ts`、`workbench-http.test.ts`。

## 证据

提交号；定向测试结果；18.4 的耗时与数据规模。

## 退出条件

三个数三端可读；19 可以接界面；20 与 21 可以用它记录覆盖。

## 恢复与交接

中断时以测试为准判断进度。18.5 的耗时不可接受时停下，不自行建投影表。
