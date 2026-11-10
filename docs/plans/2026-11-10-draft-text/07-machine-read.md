# 07 · 文本等级的机器读取与加工读取合同

类型：计划（结果块）
负责：文本等级与核对依据在三端读取中的表达，差异的有界读取，以及交给计划 16 的加工读取合同
状态：Pending

## Outcome

Agent 经 HTTP、CLI、MCP 读到同样的结果：

- `document describe`：`text_level`；初稿另有 `draft_summary`；长文档另有 `long_document`（04 §8.4）。
- 文献库条目（`LiteratureSearchItem.text_level`）与建档状态（`ArchiveState.parts[].text_level`）：字段与位置见 06 §2.1.7。`draft_facts` 与 `LiteratureAssetView.default_text` 带有两项聚合计数，在 09 块交付。
- 初稿的 outline：`role` 为 null，`title` 来自解析标题。segments 与 slice 的位置带初稿的 `basis`。
- 查找命中：`MaterialContextItem.text_level`（06 §2.1.7“查找命中”）。
- 证据解析：所引片段所在版本的 `text_level` 与片段的 `basis`。
- 差异读取：`draft-differences`（04 §8.3“差异的有界读取”）。
- 内容版本的机器读取同时给出 `text_level`（04 §8.5）。
- 现有读取方遇到初稿时，按 04 §8.10 的表接受或拒绝。

计划 16 拿到一个读取合同：取每个部分的默认文本及其等级与内容版本；按角色读初稿时得到整篇与覆盖说明；“只用校订稿”时初稿部分记为缺失；原始解析不进入。

规格：[04 §8.3](../../architecture/technical/04-document-evidence.md#83-初稿的结构与核对依据)（核对依据的取值、差异的有界读取）、[§8.4](../../architecture/technical/04-document-evidence.md#84-文本等级的标注)、[§8.6](../../architecture/technical/04-document-evidence.md#86-加工读取)、[§8.10](../../architecture/technical/04-document-evidence.md#810-各读取方对初稿的处理)、[§3.4](../../architecture/technical/04-document-evidence.md#34-版本绑定的有界读取)；[06 §2.1.7](../../architecture/technical/06-retrieval-context.md#217-目标接口尚未实现文本等级与选择校订范围的事实)。

## 进入条件

04 完成。04 与本块必须在同一次部署中上线（04 的“集成与影响”）。

## 责任边界

- 负责：后端实施者。
- 拥有：
  - `packages/contracts/src/document-read.ts`、`retrieval-context.ts`、`archive.ts`、`index.ts` 中相应读取类型；
  - `packages/contracts/src/processor-value-checks.ts` 中片段 `basis` 的取值集合（只放宽合同，不改核对逻辑）；
  - `apps/server/src/document/read.ts` 的读取实现。
- 触达：
  - `apps/server/src/storage/sqlite/archive-engine.ts`（建档状态与文献库的 `long_document` 旁边加 `text_level`）；
  - `apps/server/src/translation/`、`apps/server/src/extraction/prepare.ts`、`apps/server/src/parsing/article-identity.ts`（8.10 中“接受”的读取方）；
  - `apps/server/src/storage/sqlite/worker-runtime.ts`（文献库条目与详情）；
  - `apps/server/src/storage/sqlite/retrieval-engine.ts` 与 `apps/server/src/retrieval/index.ts`（索引初稿、命中带等级）；
  - `apps/server/src/workbench/http.ts`、`apps/server/src/cli/main.ts`、`apps/server/src/mcp/tools.ts`（工具说明与新操作）；
  - 7.6 列出的读取方。
- 不改：算子执行器的准入与复用键（计划 16）；页面（10 块）。

## Tasks

- [ ] **7.1 读取合同**：按 04 §8.4 与 06 §2.1.7 扩展 describe（`text_level`、`draft_summary`）、segments/slice 的位置、evidence、`LiteratureSearchItem.text_level`、`ArchiveState.parts[].text_level`、`MaterialContextItem.text_level` 的类型与解析函数。现有解析函数按精确键集解析，生产者与消费者同时更新；06 §2.1.7 的新字段可选，省略时已有请求与 cursor 的字节不变。
- [ ] **7.2 文档读取**：`read.ts` 读取初稿版本：
  - describe、outline、segments、slice、resources、resource-bytes、evidence 都可用；
  - 按版本取等级，不按默认关系推断；
  - 可读性校验调用 03 的 3.3（从初稿内容重建，不跑 PDF 工具）；初稿内容计入校验证明的文件指纹与预算（04 §8.3 verified reader 一段）；
  - `segments` 带 `roles` 读初稿时返回整篇与 `coverage_note`（04 §8.6）。
- [ ] **7.3 差异读取**：按 04 §8.3“差异的有界读取”实现 `draft-differences`：HTTP `POST /api/v1/query/document-draft-differences`、CLI `sciretriever document draft-differences`、MCP `document_read` 的 `draft-differences` 操作，用途 `read`。只读初稿内容中已保存的差异。
- [ ] **7.4 文献库与建档状态**：按本页文献 ID 批量读取主 PDF 默认文本的等级，不读正文；建档状态的 `parts[]` 逐部分给出。同一次读取的等级与 `document_version_id` 来自同一个只读快照（06 §2.1.7“一致性”）。
- [ ] **7.5 查找**：
  - 全文索引收入全部已接纳的固定文档版本，两级相同（04 §8.10）；索引构建现在只认校订稿的 builder，要按 builder 分派；
  - 命中的 `text_level` 来自命中已核验的固定版本，不来自索引条目；索引条目与游标不变（06 §2.1.7）；
  - 默认文本改变时只经现有刷新机制更新索引，读取不重建。
- [ ] **7.6 读取方逐个处置**（04 §8.10）
  - 现有约 30 个文件按“文档版本是 schema 2 的校订稿”取值。用 `rg -n 'schema_version !== 2|schema_version === 2|version\.proofread_id' apps/server/src` 列出全部，每个文件对到 04 §8.10 表中的一行，只放开表中“接受”的读取方，其余照旧拒绝。
  - 表中“接受”的读取方要改的代码，至少包括：`document/read.ts`、`document/annotations.ts`、`retrieval/index.ts`、`parsing/article-identity.ts`、`translation/`、`extraction/prepare.ts`。
  - 表中“不接受”的读取方保持拒绝，返回值按表（`corrections` 与 `document annotate` 返回 `document-unsupported`；标签、元数据、参考文献只读校订稿）。
  - 不在本块：`analysis/processor-archive.ts` 与 `application/jobs/processors.ts` 的算子输入，由计划 16 按 7.7 改。
  - 逐文件对应到哪一行，写进回执。
- [ ] **7.7 加工读取合同**（交计划 16）
  - 在文档模块提供一个读取函数：输入部分、读取范围（含章节角色）、是否“只用校订稿”；输出默认文本的版本、`text_level`、内容版本，或缺口。
  - 初稿上按角色读取：返回整篇与 `coverage_note`，不返回 `structure-role-unavailable`（04 §8.6；文字以 04 §8.6 为准，知识加工原样写入）。
  - “只用校订稿”而默认文本是初稿：返回输入缺失，不读初稿。
  - 原始解析没有读取入口。
  - `processor-value-checks.ts` 接受初稿的 `basis` 取值；`analysis/value-check.ts` 的文字比对在初稿片段上照常执行。
  - 现行算子执行器仍只读 `READY` 文献（计划 16 改），本块不改执行器。
  - 写一份接口说明交计划 16 的负责人，记入回执。
- [ ] **7.8 说明文字**：MCP 工具说明与 CLI 帮助写明 `text_level`、`draft_summary`、初稿的 `basis` 与 `draft-differences`。

## 集成与影响

- 三端读取结果增加字段，是公开合同变化。
- 查找结果开始包含初稿。规1 不变：查询只读已有内容。
- 计划 16 的 04 块（按需材料门槛）中标〔计划 21〕的内容使用 7.7。该块由计划 16 的负责人维护；本块只交付合同与说明，交付时通知对方。

## 验证

新增 `apps/server/test/draft-read.test.ts`（合成库），证明：

- describe、outline、segments、slice、evidence 在初稿上返回已知文字，`text_level` 为 `draft`，位置的 `basis` 为初稿取值；同一部分的校订稿版本返回 `proofread`。
- 按 `document_version_id` 读取非默认的另一级文本可用。
- 差异读取：小 `max_bytes` 分多次续读后拼出的 JSON 与一次读出的相同；续读位置不能用于别的版本；对校订稿返回 `document-unsupported`。
- verified reader 在页面工具不可用时仍能读取已形成的初稿；改动初稿内容一个字节即核验失败。
- 按角色读初稿返回整篇与覆盖说明；“只用校订稿”时返回输入缺失。
- 读取过程中不形成初稿、不解析、不调用模型。

扩展：

- `document-read.test.ts`、`retrieval-context.test.ts`（命中带等级）、`workbench-library.test.ts`（文献库条目与建档状态）、`reading-marks.test.ts`（初稿上的全文锚点通过校验）、`processor-value-check.test.ts`（初稿 `basis` 的核对）。
- 三端一致：`cli-main.test.ts`、`mcp.test.ts`、`workbench-http.test.ts`、`processor-interface-parity.test.ts`。
- 04 §8.10 表中每个读取方遇到初稿时的行为各有一例（04 §8.9 末条）；拒绝的读取方证明没有误读初稿。
- 合同：`packages/contracts/test/document-contract.test.ts`、`processor-reading.test.ts`。

## 证据

提交号；定向测试结果；7.6 的逐文件处置表；交给计划 16 的接口说明位置。

## 退出条件

三端读取一致带等级；计划 16 可以依赖 7.7；10 块可以接界面。

## 恢复与交接

7.6 的处置按文件推进，每改一个文件跑它的直接测试。04 §8.10 表里没有的读取方照旧拒绝初稿，记入回执交总设计师。
