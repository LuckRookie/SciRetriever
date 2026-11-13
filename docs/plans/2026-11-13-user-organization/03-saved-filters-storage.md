# 03 · 保存的筛选进入 catalog

类型：计划（结果块）
负责：保存的筛选的合同、服务、存储、三端入口，以及本计划唯一的表结构迁移
状态：Pending

## Outcome

- 保存的筛选存在 catalog 里，随库备份。
- `FilterOperation` 的 `list`、`create`、`rename`、`update`、`delete`、`import` 在 CLI `filters`、MCP `filters_query`／`filters_manage`、HTTP `/api/v1/query/filters` 与 `/api/v1/maintenance/filters` 上可用；设备用途 `read` 读、`operate` 写。`export` 在 07 块交付。
- 名称规则、200 项上限、按名称排序、`missing_folder_id` 与错误码按规格。
- 一个离线迁移工具把精确的前一个 schema 升级到本计划的编号（暂定 19，见计划 README“schema 编号”），一次加入 `saved_filters` 与 `reading_mark_places` 两张表（后者供 05 使用），不改文献资产，不调用模型。

规格：[用户整理 9.1](../../architecture/technical/09-user-organization.md#91-保存的筛选进入文献库)（是什么、操作、入口、浏览器导入）；两张表见[存储技术篇第 7 节](../../architecture/technical/07-versioned-storage.md#7-运行审查存储)的“用户整理的两张表”；设备用途见[第 6.3 节](../../architecture/technical/09-user-organization.md#63-agent-的同等授权)；迁移方式见[存储技术篇第 7 节](../../architecture/technical/07-versioned-storage.md#7-运行审查存储)与 [4.1](../../architecture/technical/07-versioned-storage.md#41-当前-schema-与显式转换)。

## 进入条件

- G1。规格已补齐（01 完成）。
- 3.2 起要 C1：前一个编号的迁移已合入，指纹固定。
- 3.7 要 G-lib。

## 责任边界

- 负责：后端实施者。
- 拥有：
  - `packages/contracts` 中保存筛选的合同与解析（建议新文件，与 `folders.ts` 并列）；
  - 服务（建议放在 `apps/server/src/literature/`，与 `FolderService` 并列，模块⑨的 owner）；
  - SQL（建议新文件，与 `folder-engine.ts` 并列）；
  - `schema.ts` 中本计划编号的清单；新迁移模块与脚本 `scripts/migrate-<主题>-v19.mjs`（命名沿用现有 `migrate-<主题>-v<编号>.mjs`，编号按 C1）。
- 触达：CLI（`apps/server/src/cli/main.ts`）、MCP 工具（`apps/server/src/mcp/tools.ts`，按设备用途列出）、HTTP（`apps/server/src/workbench/http.ts` 的 query 与 maintenance 路由）、写入的操作记录（规格 6.4）；所有检查当前 schema 编号的位置（`rg -n '\[1[6-9]\]\.includes' apps/server/src`）。
- 不改：文件夹与批注的现有行为；文献库查询本身；Web（04 块）；前一个编号的清单与迁移脚本。

## Tasks

- [ ] **3.1 DDL 清单与测试数据**
  - 按 07 第 7 节写出 `saved_filters` 与 `reading_mark_places` 的 DDL，记入本块回执，交总设计师核对后再写进 `schema.ts`。
  - 准备合成的前一编号的库：含文件夹、批注、最近阅读、加工结果，供 3.6 使用。
- [ ] **3.2 schema 清单**：保留前一编号的清单与指纹作为迁移的精确输入；`SCHEMA_MANIFEST` 与 `SCHEMA_VERSION` 改为本计划的编号。两张新表都不进入 `LIBRARY_STATE_INPUT_TABLES`，不推进检索 source revision（规格 6.1、07 第 7 节）。
- [ ] **3.3 合同与服务**：`packages/contracts` 中的 `FilterOperation` 与解析；`FilterService`（`query` 只接受 `list` 与 `export`，`manage` 只接受写操作）。按 09 §9.1 实现名称规则、上限、排序、`missing_folder_id`、`update` 替换条件与排序、`import` 的逐项结果（截短、跳过、加序号、不合格列出原因）；写入在一个事务内完成，经 `executeMaintenance` 记操作记录。
- [ ] **3.4 三端入口**：CLI `filters list` 与 `filters create|rename|update|delete|import --request FILE`；MCP `filters_query`（`read`）与 `filters_manage`（`operate`）；HTTP `POST /api/v1/query/filters` 与 `POST /api/v1/maintenance/filters`；MCP 工具按设备用途列出与拒绝；设备令牌不能调用 `/api/v1/query/*` 与 `/api/v1/maintenance/*`（规格 6.3）。
- [ ] **3.5 schema 编号的检查**：所有写死当前编号的检查改为本计划的编号，与前一编号所在计划的列表对齐（C1）。
- [ ] **3.6 离线迁移**：沿用现有迁移模块的结构：只接受绝对路径与精确的前一编号指纹；未知结构、已是本编号、有运行中任务时拒绝；事务内 DDL 与身份更新；完整性与外键检查；所有旧表行数不变；新表为空；回执写出耗时与核对结果。不读个人配置，不调用模型，不改文献资产，不搬迁浏览器里的数据。
- [ ] **3.7 正式库只读副本演练**（G-lib）：在本机副本上运行脚本，记录耗时与回执；副本与报告放 `sandbox/runs/`、`sandbox/reports/`，不提交。

## 集成与影响

- 程序只打开本计划的编号；部署要停服离线迁移（08）。
- 三端新增一组读写操作，是公开合同变化。
- Web 在 04 合入之前仍用浏览器里的保存筛选；两者此期间并存，互不影响。

## 验证

- 新增 `apps/server/test/saved-filters.test.ts`（合成库），证明：
  - `list`、`create`、`rename`、`update`、`delete` 的结果；列表按名称排序；`update` 只换条件与排序、名称不变；
  - 名称为空、超过 128 字符、重名（规范化后）被拒为 `filter-name-conflict` 等规格的码；条件不合法为 `filter-condition-invalid`；第 201 项为 `filter-limit`；编号不存在为 `filter-not-found`；读写操作混用被拒；
  - `import`：合格与不合格的项混在一起时只有不合格的不写入，并列出原因；超长名称截为 128；同名同条件跳过；同名不同条件加序号；再次导入同一批不新建；
  - 保存的是条件：库变化后应用同一筛选得到新的结果；
  - 条件里的文件夹被删除后，筛选保留、条件不变，列表带 `missing_folder_id`，按它查询命中零篇；
  - 写入前后文献的书目、来源、资产、文本、标签、状态投影与加工结果的新旧状态不变（规格第 8 节“不改变文献事实”）；
  - 只读查询不写库；
  - Web 登录、CLI、stdio MCP、HTTP MCP 结果相同。
- 扩展 `mcp-http.test.ts`：只有 `read` 的令牌看不到写工具，调用被拒；只有 `operate` 的令牌不能读。
- 新增迁移测试（参照 `import-schema-migration.test.ts`）：精确的前一编号被升级；其它情形拒绝；旧表行数与内容不变；注入失败后库保持原样。
- 扩展 `catalog-schema.test.ts`：清单与指纹。
- `rg` 确认没有遗漏的编号检查；定向测试与 `pnpm quick`。

## 证据

提交号（G-commit 之后）；DDL 清单（3.1 回执）；定向测试与迁移测试结果；只读副本演练的耗时与回执位置（G-lib 之后）。

## 退出条件

保存的筛选三端可用；迁移工具在合成库上通过。04、07 可以开工；05 若有，在同一迁移里已有它要的表结构。

## 恢复与交接

- 迁移失败时库保持原样（事务回滚）；记录失败的核对项。
- C1 未通过时停在 3.1，回执标明 BLOCKED。
