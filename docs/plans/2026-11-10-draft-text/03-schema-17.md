# 03 · schema 17：初稿的存储与离线迁移

类型：计划（结果块）
负责：catalog 对初稿版本、初稿事实、引用保护与“找不到”投影的结构，及 16 → 17 的离线迁移
状态：In progress（3.1–3.5 完成，2026-11-15；3.6 待 G2，不阻塞 04）

## Outcome

- catalog 能保存初稿版本（`document_versions` 的 `schema_version` 3 行）、每个部分的当前初稿（`draft_current`）与初稿版本事实（`draft_version_facts`）。
- 默认文本按 04 §8.5 由当前初稿与校订稿共同求出；初稿成为默认文本时内容版本变化，现有校订稿的内容版本不变。
- 被引用的初稿版本及其原始解析不能被删除或退役。
- 结果发布时写入的“找不到”投影 `processor_unfound_citations` 有表可写（写入在 09 块）。
- 一个离线迁移工具把精确的 schema 16 库升级到 17：不改文献资产，不产生内容版本事件，不调用模型。

规格：[07 §2.3.4](../../architecture/technical/07-versioned-storage.md#234-asset原始解析与校订稿)“初稿的存储”（版本行、当前初稿、版本事实、文件、对原始解析的保护、迁移）；[07 §4.2](../../architecture/technical/07-versioned-storage.md#42-数据与写入所有权)“两级文本的写入所有权”；[04 §8.5](../../architecture/technical/04-document-evidence.md#85-默认文本内容版本与证据) 的默认文本与内容版本。表结构以规格为准，本块不重复。

## 进入条件

- 01 已完成；02 的 2.1（合同类型）已合入。
- 3.1 不需要 C1。3.2 起需要 C1：计划 20 宣布 schema 16 冻结（README“schema 编号”一节）。
- 3.6 需要 G2。

## 责任边界

- 负责：后端实施者。
- 拥有：`apps/server/src/storage/sqlite/schema.ts` 中的 schema 17 清单；新迁移模块 `apps/server/src/storage/sqlite/draft-text-schema-migration.ts`；脚本 `scripts/migrate-draft-text-v17.mjs`（命名沿用 `migrate-<主题>-v<编号>.mjs`）；storage 层初稿的写入与读取函数。
- 触达：所有检查当前 schema 编号的位置（3.4）。
- 不改：schema 16 的清单与 `scripts/migrate-import-v16.mjs`（归计划 20）；现有校订稿行的任何字段值；文献资产与不可变文件；`sandbox/` 之外的真实库。

## Tasks

- [x] **3.1 表结构清单与测试数据**
  - 对照 07 §2.3.4 与 §4.2 写出 schema 17 的 DDL 清单：要重建的表、要替换的视图与触发器、新表与新索引。记入本块回执，交总设计师核对后再写进 `schema.ts`。
  - 准备合成的 schema 16 库：含校订稿、长文档、加工结果、批注、全文索引，供 3.5 的迁移测试使用。
- [x] **3.2 schema 17 清单**
  - 保留 `SCHEMA_MANIFEST_V16` 与其指纹作为迁移的精确输入；`SCHEMA_MANIFEST` 与 `SCHEMA_VERSION` 改为 17。
  - 按 07 §2.3.4 实现：
    - 重建 `document_versions`（`schema_version` 2 或 3，两组列按版本恰好一组非空，外键 `ON DELETE RESTRICT`）。文本等级由 `schema_version` 推出，不另设列；
    - 依赖它的视图与触发器随表替换，覆盖范围不变；
    - 新表 `draft_current`、`draft_version_facts`。
  - 按 07 §4.2 实现：新表 `processor_unfound_citations`；`processor_result_documents` 按 `document_version_id` 的索引。
  - 视图 `archive_current_parts`：默认文本是初稿时给出 04 §8.5 的初稿内容版本；默认文本是校订稿时，内容版本 JSON 与 schema 16 **逐字节相同**。
  - 原始解析退役：`raw-parsing-engine.ts` 的 `retire` 增加“有文档版本引用它”的判断，返回 `raw-parse-in-use`（07 §2.3.4“对原始解析的保护”）。
  - 文献库状态缓存：初稿登记、当前初稿与默认关系改变时，相关文献的 `library_state_changes` 要更新，沿用现有触发器写法。规格没有规定这一点，做法记入回执。
- [x] **3.3 写入与读取函数**
  - 在 storage owner 内实现：
    - 登记初稿版本：版本行、资源闭包、版本事实、当前初稿指针在同一事务；文件目录与复用按 07 §2.3.4“文件”（图片沿用原始解析的资源对象，不复制）；
    - 默认关系（2026-11-15 定：本块只建好并测试重求函数 `recomputeDocumentDefault`，三种写入的接入移到 04 的 4.1）：04 §8.5 列出的三种写入（原始解析当前指针切换、初稿形成或复用、校订稿发布）都在各自的事务内重新求默认文本，两者都没有时删除默认关系。其中原始解析当前指针的切换在 `raw-parsing-engine.ts` 的发布事务里，现在不碰默认关系，要补上；
    - 按版本读取初稿事实；按本页文献 ID 批量读取主 PDF 默认文本的版本与等级（供 07、09 使用，不读正文）。
  - 可读性校验（`document/storage.ts`）按 builder 分派：`draft-leaves-v1` 调用 02 的 2.6 重建，不调用 PDF 页面工具。
- [x] **3.4 当前 schema 编号的检查**
  - 现在有十余处写死 `[16].includes(...)`，都改为 17：
    - `document/service.ts`、`document/proofread-publication.ts`、`document/read.ts`（两处）；
    - `parsing/article-identity.ts`；
    - `storage/sqlite/` 下的 `extraction-engine.ts`、`processor-engine.ts`、`proofread-engine.ts`、`structure-annotation-engine.ts`、`raw-parsing-engine.ts`；
    - 以及 `rg -n '\[16\]\.includes' apps/server/src` 找到的其它位置。
  - 计划 20 若在此后还要写 schema 16 的代码，这个列表要和它对齐（C1）。
- [x] **3.5 离线迁移**
  - 迁移模块与脚本，沿用 `import-schema-migration.ts` 的结构：
    - 规则见 07 §2.3.4“迁移”：精确输入布局、拒绝运行中的任务与建档、事务内 DDL 与身份替换；
    - 校验 SQLite 完整性与外键；
    - 所有旧表行数不变；现有校订稿行逐列不变；
    - `archive_content_heads` 逐行相同，`archive_version_events` 与 `processor_result_freshness` 的行数和内容不变；
    - 新表为空；
    - 回执写出耗时与各项核对结果。
  - 不读个人配置，不调用模型，不改文献资产，不形成初稿（形成初稿是 05 的显式操作）。
- [ ] **3.6 正式库只读副本演练**（G2）
  - 在本机副本上运行脚本，记录耗时与回执；核对迁移前后校订稿可读、加工结果的过时状态不变、全文检索可用。
  - 副本与报告放 `sandbox/runs/`、`sandbox/reports/`，不提交。

## 集成与影响

- 程序只打开 schema 17；旧程序不能打开 17 的库。部署要停服离线迁移（12 块）。
- 正式库要先从 15 迁到 16（计划 20），再到 17。
- 本块不改变任何对外读取结果。

## 验证

- 新增 `apps/server/test/draft-text-schema-migration.test.ts`（参照 `import-schema-migration.test.ts`），证明：
  - 精确的 16 被升级；17、未知结构、有运行中任务时拒绝；
  - 迁移后现有校订稿的 DocumentRef、representation hash、内容版本 JSON 与迁移前逐字节相同；
  - 迁移没有新增 `archive_version_events`，加工结果的过时状态不变；
  - 外键与完整性检查通过，旧表行数不变；
  - 注入事务中途失败后库保持 16 原样。
- 扩展 `catalog-schema.test.ts`：清单、指纹、CHECK（`schema_version` 与两组列不成对时拒绝）。
- 扩展 `raw-parsing-storage.test.ts`：初稿引用的原始解析退役返回 `raw-parse-in-use`。
- 新增或扩展 storage 测试：登记初稿的事务（中途失败不留半条记录）；`draft_current` 的 CAS 冲突；三种写入各自重新求默认文本，两者都无效时默认关系被删除；初稿成为默认文本时内容版本变化，校订稿成为默认文本时内容版本 JSON 与 16 的格式相同。
- 跑 `rg -n '\[16\]\.includes' apps/server/src` 确认无遗漏。
- 定向测试与 `pnpm quick`。

## 证据

提交号；表结构清单（3.1 回执）；迁移测试结果；只读副本演练的耗时与回执位置（G2 之后）。

## 退出条件

schema 17 与迁移工具合入；合成库迁移测试通过。04 可以登记初稿。3.6 在 G2 之后补做，不阻塞 04。

## 恢复与交接

- 迁移失败时库保持 16 原样（事务回滚）；记录失败的核对项。
- 不在正式库或其副本以外的位置试迁移。
- C1 未通过时停在 3.1，写回执标明 BLOCKED。
