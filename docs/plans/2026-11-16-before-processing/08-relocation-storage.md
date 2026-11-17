# 08 · 重新定位结果的记录

类型：计划（结果块）
负责：批注在另一版 PDF 或另一文档版本上找到的位置的记录、校验与读取
状态：Completed（2026-11-16）

来源：原计划 22 的 05（任务 5.1–5.4 改为 8.1–8.4）。

## Outcome

- `MarkOperation` 增加 `place`：阅读器在另一版 PDF（不同 sha256）或另一文档版本上找到一条批注后，把位置、相似度与方法版本 `mark-locate-v1` 写进 `reading_mark_places`；同一批注、同一目标再写时替换。
- 批注自己的锚点从不改写；位置是缓存，随批注清除，方法版本改变时不再使用。
- 写入校验：目标必须是这篇文献、同一部分的 PDF 或文档版本，范围不超出；已删除的批注不能写入。
- `list` 的每条批注带 `places`（当前方法版本下的），`export` 的 JSON 同 `list`；三个入口结果相同。

规格：[用户整理 9.4](../../architecture/technical/09-user-organization.md#57-材料换版本时重新定位并记录)“只在同一部分里找”“记录”，校验同 [5.2](../../architecture/technical/09-user-organization.md#52-锚点)；表 `reading_mark_places` 见[存储技术篇第 7 节](../../architecture/technical/07-versioned-storage.md#7-运行审查存储)。

## 进入条件

- 07 的迁移已合入（`reading_mark_places` 由它加入）。规格已补齐。

## 责任边界

- 负责：后端实施者。
- 拥有：`packages/contracts/src/marks.ts` 中的 `place` 操作与 `places` 字段；`apps/server/src/literature/marks.ts` 的 `MarkService`；`apps/server/src/storage/sqlite/marks-engine.ts`。
- 不改：现有锚点的校验规则与 `update` 对颜色、笔记的行为；导入批注的写入（17）；阅读器（10）。

## Tasks

- [x] **8.1 合同**：`place` 的请求 `{mark_id, target, similarity, method}` 与解析；`ReadingMark` 的读取结果增加 `places`（09 §9.4“记录”）。
- [x] **8.2 存储与校验**：写入与替换 `reading_mark_places`；目标属于这篇文献且与批注同一部分（09 §9.4“只在同一部分里找”，原 PDF 已不属于这篇文献时按主 PDF）；范围校验同 5.2；不改写批注自己的锚点；一个事务内完成，记操作记录。
- [x] **8.3 列表与导出**：`list` 只给出当前方法版本的 `places`；`export` 的 JSON 同 `list`，Markdown 不变；JSON 仍能被 `parseReadingMark` 逐条解析（规格第 8 节）。
- [x] **8.4 三端**：CLI `marks place --request FILE`、MCP `marks_manage` 的 `place`、HTTP `POST /api/v1/maintenance/marks`；设备用途 `operate`。

## 集成与影响

批注的读取结果多了字段（或多了操作），是公开合同变化。17 的导入批注与使用者批注共用这些规则。

## 验证

扩展 `apps/server/test/reading-marks.test.ts`（合成文献，两份 sha256 不同的 PDF、两个文档版本），证明：

- 记下另一版 PDF 与另一文档版本上的位置后，原锚点逐字段不变；同一目标再写入时替换；
- 指向别的文献、别的部分（主 PDF 的批注写到补充材料上）、超出字节范围、页码不存在的位置被拒（`mark-anchor-invalid`）；相似度低于 0.7 被拒；
- 方法版本不是当前版本的记录不出现在 `list` 里；
- 批注被清除（删除满 30 天）时记录一起删除；
- 已删除的批注不能记录位置（`mark-deleted`）；
- `list` 与 `export` 给出记下的位置；JSON 逐条可解析；
- Web 登录、CLI、stdio MCP、HTTP MCP 结果相同；设备用途不足时被拒；
- 写入前后文献事实不变（规格第 8 节）。

## 证据

- 2026-11-16，后端实施者实现，总设计师审查后提交。`ReadingMark.places` 为必带字段；PDF 目标先只读核验资产与页数，写事务内重判归属、部分与范围；原锚点与更新时间不变。
- 后端实施者串行运行 8 个文件 84 项通过（`sandbox/reports/2026-11-16-plan25-08/`）；Web 乐观对象补 `places: []`（前端实施者）。总设计师复跑 `pnpm quick` 通过，`reading-marks`、`mcp-stdio`、`mcp-http` 15 项通过（`review/`）。

## 退出条件

记录与读取三端可用；10 可以在阅读器里调用。

## 恢复与交接

中断时以测试为准判断进度。规格的规则在实现中发现不可行（例如与导入批注冲突）时停下，写回执交总设计师，不自行改规则。
