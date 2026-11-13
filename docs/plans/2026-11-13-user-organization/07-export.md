# 07 · 分组与筛选的导出

类型：计划（结果块）
负责：文件夹树、成员与保存的筛选整体导出为 JSON
状态：Pending

## Outcome

- 分组导出：`FolderOperation` 的 `export`，文件格式 `sciretriever-folders` 版本 1：文件夹树与成员，成员带 `literature_id`、已有的 `doi`／`arxiv`／`pmid`／`pmcid`、`title` 与 `year`。机器入口按 cursor 分页；Web 的“导出分组”由服务端流式写成一个文件。
- 筛选导出：`FilterOperation` 的 `export`，文件格式 `sciretriever-filters` 版本 1，一次返回。
- 两个导出都只读，不写库；设备用途 `read`。批注仍按单篇导出（规格 5.6）。
- 分组导出不依赖保存的筛选，可以先于 03 交付。

规格：[用户整理 9.6](../../architecture/technical/09-user-organization.md#96-分组与筛选的导出)（两个导出、规模、入口）；Web 的菜单项见[页面规格“文献库”](../../architecture/web/page-specs.md#文献库)。

## 进入条件

- 7.1–7.3：G1（规格已补齐，不等 03）。
- 7.4：03 完成。
- 7.5：7.3 与 7.4 中对应的服务端部分完成；Web 入口要 C3（“导出筛选”在筛选菜单里）。
- 7.6：G-lib。

## 责任边界

- 负责：后端实施者（7.1–7.4）；前端实施者（7.5）。
- 拥有：两个导出的合同与实现（放在 `FolderService` 与 `FilterService` 里，作为读操作）。
- 触达：`packages/contracts/src/folders.ts`；CLI `folders`、`filters`；MCP `folders_query`、`filters_query`；HTTP `POST /api/v1/query/folders-export`；文献的稳定标识与书目只经文献模块的公开读取取得（规格 1.2），不直接查文献表。
- 不改：文件夹与保存筛选的写操作；批注导出；书目导出。

## Tasks

- [ ] **7.1 分组导出的合同**：`FolderOperation` 的 `export {cursor, limit}`（`limit` 1–1,000），第一页带完整文件夹树，每页一批带 `folder_id` 的成员，按 `(folder_id, literature_id)` 排序，`next_cursor`；文件格式名与版本；解析函数。`FolderService.query` 接受 `export`。
- [ ] **7.2 分组导出的实现**：成员的 `identifiers` 只列已有的四种，`title`、`year` 缺失为 null；一篇文献在几个文件夹里就各出现一次。CLI `folders export --request FILE`、MCP `folders_query` 的 `export`，用途 `read`。
- [ ] **7.3 Web 下载的服务端**：`POST /api/v1/query/folders-export` 在一个只读快照里流式写出整份文件，成员嵌在各自的文件夹下；响应为 `application/json` 附件；不把整份文件先放进内存。
- [ ] **7.4 筛选导出**：`FilterOperation` 的 `export`，一次返回；CLI `filters export`、MCP `filters_query` 的 `export`、HTTP `POST /api/v1/query/filters`。
- [ ] **7.5 Web 入口**（前端实施者）：侧栏“文件夹”一组的菜单“导出分组”；“筛选”菜单“导出筛选”（受 C3 约束，可与 04 一并做）。
- [ ] **7.6 正式库只读副本核对**（G-lib，可选）：在副本上导出一次，记录大小与耗时，抽查几篇成员的标识。

## 集成与影响

新增两个只读操作与一个下载路径，是公开合同变化。

## 验证

- 新增 `apps/server/test/user-organization-export.test.ts`（合成库），证明：
  - 分组导出的树与成员与合成数据一致；多归属的文献在每个文件夹下都出现；
  - `identifiers` 只含已有的标识；`title`、`year` 缺失为 null；
  - 分页：小 `limit` 逐页读完与一次读出的成员集合相同，顺序按 `(folder_id, literature_id)`；`limit` 越界被拒；
  - Web 下载的文件能被解析函数读回，成员嵌在文件夹下；大合成库上下载时内存不随成员数线性增长（流式）；
  - 筛选导出与 `list` 的条件一致；
  - 导出前后 catalog 不变（含 `reading_history` 与操作记录）；
  - 三端结果相同；只有 `operate` 的设备令牌被拒，`read` 可以。
- Web（7.5）：扩展 `apps/web/test/next-folders.test.ts` 与 04 的文献库测试，证明两个菜单项发起下载、不写库。

## 证据

提交号（G-commit 之后）；定向测试结果；7.6 的大小与耗时（G-lib 之后）。

## 退出条件

导出三端可用；JSON 可以被解析函数读回。

## 恢复与交接

导出只读，中断后重做即可。规格的格式在实现中发现不足时停下，交总设计师补规格。
