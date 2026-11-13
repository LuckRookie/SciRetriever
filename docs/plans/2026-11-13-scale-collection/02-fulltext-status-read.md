# 02 · 全文取得情况的读取

类型：计划（结果块）
负责：任意文献库范围的“已取得、未取得、已试完”三个数在 CLI、MCP、HTTP 上的读取
状态：Pending

## Outcome

- 对任意 `LibraryQuery`（全库、文件夹、入库批次、一次发现、保存的筛选的条件），一次只读读取返回三个数：已取得全文、还没有、其中已试完自动途径；单位与名称按 01 的 1.1、1.2。
- CLI、stdio MCP、HTTP MCP 与 HTTP（Web 登录）结果相同。
- 读取不联网、不调用模型、不创建任务（规1）。

规格：经 01 的 1.1、1.2 补齐的[查询技术篇第 2.1 节](../../architecture/technical/06-retrieval-context.md#21-本地文献数据库查询与详情)；耗尽事实见[文献与材料 4.5](../../architecture/technical/03-literature-materials.md#45-获取流程)。

## 进入条件

01 的 1.1、1.2 已写进规格；G1。

## 责任边界

- 负责：后端实施者。
- 拥有：`packages/contracts/src/library-counts.ts`（或 1.2 规定的新合同）；`apps/server/src/storage/sqlite/library-page.ts` 的计数。
- 触达：CLI `literature counts`（`apps/server/src/cli/main.ts`）、MCP `library_counts`（`apps/server/src/mcp/server.ts`、`tools.ts`）、HTTP `library-counts`（`apps/server/src/workbench/http.ts`）；Web 的数据层 `apps/web/src/app/data/library.ts` 只在合同变化时同步类型。
- 不改：文献状态的推导（`sr_status`）；自动获取耗尽事实的写入与清除；`AcquirePdfSelector` 的跳过规则；表结构（计划 README“数据库”）。

## Tasks

- [ ] **2.1 合同**：按 1.2 扩展或新增合同与解析函数；原有字段的含义不变。
- [ ] **2.2 计数**：按 1.1 计算三个数。若按 MetaLiterature 计，用现有 `selectionSnapshot` 的 matches 与 members（06 §2.2.1）在同一只读快照里求，不在 SQL 之外逐篇读取。
- [ ] **2.3 三端**：三个入口返回同一结果；MCP 工具说明与 CLI 帮助写明三个数的含义。
- [ ] **2.4 规模**：在 5 万篇的合成库上测一次计数耗时（本机），记入回执；若超出 Web 可用的范围（例如数秒），停下交总设计师，与 04 的数字一起判断是否需要投影（计划 README“数据库”）。

## 集成与影响

计数读取多了字段（或多了一个读取），是公开合同变化；Web 在 03 之前不显示它们。

## 验证

新增或扩展 `apps/server/test/library-counts-intake.test.ts`（或新增 `library-fulltext-status.test.ts`），在合成库上证明：

- 文件夹、入库批次、一次发现、组合筛选各一种范围，三个数与已知值相等；
- 1.1 规定的状态归属（含 `EXCLUDED`、`ARCHIVE_FAILED`）；
- 按 MetaLiterature 计时（若 1.1 要求）：预印本无 PDF、正式版有 PDF 的算已取得；
- 临时错误（网络、限流、配置、取消）结束的获取不计入已试完；全部途径正常未命中的计入；新元数据到达后不再计入已试完；
- 读取前后 catalog 不变，没有任务被创建，没有网络调用；
- 三端一致：扩展 `cli-main.test.ts`、`mcp.test.ts`、`workbench-http.test.ts`。

## 证据

提交号（G-commit 之后）；定向测试结果；2.4 的耗时与数据规模。

## 退出条件

三个数三端可读；03 可以接界面；04 与 05 可以用它记录覆盖。

## 恢复与交接

中断时以测试为准判断进度。2.4 的耗时不可接受时停下，不自行建投影表。
