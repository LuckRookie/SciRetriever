# 07 · 文本等级的机器读取与加工读取合同

类型：计划（结果块）
负责：文本等级与核对依据在三端读取中的表达，差异的有界读取，以及交给计划 16 的加工读取合同
状态：Pending

## Outcome

Agent 经 HTTP、CLI、MCP 读到同样的结果：

- `document describe`：`text_level`；长文档另有 `long_document`。
- 文献库读取与建档状态：每个部分默认文本的 `text_level`，与 `long_document` 并列；文献库条目给出主 PDF 的等级。
- 初稿的 outline：`role` 为 null，`title` 来自解析标题。segments 与 slice 的位置带初稿的 `basis`。
- 查找命中：每个命中片段所在版本的 `text_level`。
- 证据解析：所引片段所在版本的 `text_level` 与片段的 `basis`。
- 差异读取：按片段有界读取初稿的差异记录。
- 内容版本的机器读取同时给出 `text_level`。

计划 16 拿到一个读取合同：取每个部分的默认文本及其等级与内容版本；按角色读初稿时得到整篇与覆盖说明；“只用校订稿”时初稿部分记为缺失；原始解析不进入。

规格：[04 §8.4](../../architecture/technical/04-document-evidence.md#84-文本等级的标注)、[§8.6](../../architecture/technical/04-document-evidence.md#86-加工读取)、[§3.4](../../architecture/technical/04-document-evidence.md#34-版本绑定的有界读取)；[06 §2.1](../../architecture/technical/06-retrieval-context.md#21-本地文献数据库查询与详情)（经 01 的 1.10 补齐）；01 的 1.6、1.12。

## 进入条件

04 完成；01 的 1.6、1.10、1.12 已写进规格。

## 责任边界

- 负责：后端实施者。
- 拥有：
  - `packages/contracts/src/document-read.ts`、`retrieval-context.ts`、`archive.ts`、`index.ts` 中相应读取类型；
  - `packages/contracts/src/processor-value-checks.ts` 中片段 `basis` 的取值集合（只放宽合同，不改核对逻辑）；
  - `apps/server/src/document/read.ts` 的读取实现。
- 触达：
  - `apps/server/src/storage/sqlite/archive-engine.ts`（建档状态与文献库的 `long_document` 旁边加 `text_level`）；
  - `apps/server/src/storage/sqlite/worker-runtime.ts`（文献库条目与详情）；
  - `apps/server/src/storage/sqlite/retrieval-engine.ts` 与 `apps/server/src/retrieval/index.ts`（索引初稿、命中带等级）；
  - `apps/server/src/workbench/http.ts`、`apps/server/src/cli/main.ts`、`apps/server/src/mcp/tools.ts`（工具说明与新操作）；
  - 7.6 列出的读取方。
- 不改：算子执行器的准入与复用键（计划 16）；页面（10 块）。

## Tasks

- [ ] **7.1 读取合同**：按 1.10 与 04 §8.4 扩展 describe、segments/slice 的位置、evidence、文献库条目、建档状态、`LiteratureDetail` 各部分、查找命中的类型与解析函数。现有解析函数按精确键集解析，生产者与消费者同时更新。
- [ ] **7.2 文档读取**：`read.ts` 读取初稿版本：
  - describe、outline、segments、slice、resources、resource-bytes、evidence 都可用；
  - 按版本取等级，不按默认关系推断；
  - 可读性校验调用 03 的 3.3（从初稿内容重建，不跑 PDF 工具）。
- [ ] **7.3 差异读取**：按 1.6 实现新的读取操作，三端提供，设备用途为 `read`；它只读已保存的差异记录。
- [ ] **7.4 文献库与建档状态**：按本页文献 ID 批量读取主 PDF 默认文本的等级，不读正文；建档状态的 `parts[]` 逐部分给出。
- [ ] **7.5 查找**：
  - 全文索引收入初稿版本（索引构建现在只认校订稿的 builder，要按 builder 分派）；
  - 命中带 `text_level`；
  - 默认文本改变时只经现有刷新机制更新索引，读取不重建。
- [ ] **7.6 读取方逐个处置**（按 1.12）
  - 现有约 30 个文件按“文档版本是 schema 2 的校订稿”取值。用 `rg -n 'schema_version !== 2|schema_version === 2|version\.proofread_id' apps/server/src` 列出全部，逐个处置：接受初稿，或返回明确的缺口。
  - 至少包括：
    - 接受：`document/annotations.ts`（初稿上的全文锚点，09 §9.2）、`retrieval/index.ts`；
    - 按 1.12 决定：`parsing/article-identity.ts`、`translation/`、`extraction/prepare.ts`；
    - 返回缺口：`tags/service.ts`、`literature/archive-metadata.ts`、`literature/archive-references.ts`、`archive/arrangement-access.ts`、`entry/proofread-save.ts`；
    - 不在本块：`analysis/processor-archive.ts` 与 `application/jobs/processors.ts` 的算子输入，由计划 16 按 7.7 改。
  - 逐文件的处置写进回执。
- [ ] **7.7 加工读取合同**（交计划 16）
  - 在文档模块提供一个读取函数：输入部分、读取范围（含章节角色）、是否“只用校订稿”；输出默认文本的版本、`text_level`、内容版本，或缺口。
  - 初稿上按角色读取：返回整篇，带 04 §8.6 规定的覆盖说明（文字按 01 的 1.14 统一），不返回 `structure-role-unavailable`。
  - “只用校订稿”而默认文本是初稿：返回输入缺失，不读初稿。
  - 原始解析没有读取入口。
  - `processor-value-checks.ts` 接受初稿的 `basis` 取值；`analysis/value-check.ts` 的文字比对在初稿片段上照常执行。
  - 现行算子执行器仍只读 `READY` 文献（计划 16 改），本块不改执行器。
  - 写一份接口说明交计划 16 的负责人，记入回执。
- [ ] **7.8 说明文字**：MCP 工具说明与 CLI 帮助写明 `text_level`、初稿的 `basis` 与差异读取。

## 集成与影响

- 三端读取结果增加字段，是公开合同变化。
- 查找结果开始包含初稿。规1 不变：查询只读已有内容。
- 计划 16 的 04 块（按需材料门槛）中标〔计划 21〕的内容使用 7.7。该块由计划 16 的负责人维护；本块只交付合同与说明，交付时通知对方。

## 验证

新增 `apps/server/test/draft-read.test.ts`（合成库），证明：

- describe、outline、segments、slice、evidence 在初稿上返回已知文字，`text_level` 为 `draft`，位置的 `basis` 为初稿取值；同一部分的校订稿版本返回 `proofread`。
- 按 `document_version_id` 读取非默认的另一级文本可用。
- 差异读取：分页续读得到完整的差异记录；超出预算时截断并给出续读位置；旧版本的续读位置不能用于新版本。
- 按角色读初稿返回整篇与覆盖说明；“只用校订稿”时返回输入缺失。
- 读取过程中不形成初稿、不解析、不调用模型。

扩展：

- `document-read.test.ts`、`retrieval-context.test.ts`（命中带等级）、`workbench-library.test.ts`（文献库条目与建档状态）、`reading-marks.test.ts`（初稿上的全文锚点通过校验）、`processor-value-check.test.ts`（初稿 `basis` 的核对）。
- 三端一致：`cli-main.test.ts`、`mcp.test.ts`、`workbench-http.test.ts`、`processor-interface-parity.test.ts`。
- 7.6 中“返回缺口”的读取方：每个至少一条测试，证明遇到初稿时返回缺口而不是误读。
- 合同：`packages/contracts/test/document-contract.test.ts`、`processor-reading.test.ts`。

## 证据

提交号；定向测试结果；7.6 的逐文件处置表；交给计划 16 的接口说明位置。

## 退出条件

三端读取一致带等级；计划 16 可以依赖 7.7；10 块可以接界面。

## 恢复与交接

7.6 的处置按文件推进，每改一个文件跑它的直接测试。规格没有回答的读取方（1.12 未覆盖）先返回缺口，记入回执交总设计师。
