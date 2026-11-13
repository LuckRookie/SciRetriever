# 05 · 重新定位结果的记录

类型：计划（结果块）
负责：批注在另一版 PDF 或另一文档版本上找到的位置，按 01 的 1.3 记录、校验与读取
状态：Pending（01 的 1.3 若决定不记录，本块改为 Cancelled）

## Outcome

- 阅读器在另一版 PDF（不同 sha256）或另一文档版本上找到一条批注的位置后，可以把这个位置记下来；之后打开同一份材料时直接读取，不再重新查找（ADR 0046 第 5 条）。
- 批注原来的锚点不被改写（规格 5.4、9.5）。
- 记下的位置受与原锚点相同的校验：只能指向这篇文献自己的 PDF 或文档版本，范围不超出（规格 5.2）。
- `list` 与 `export` 按 1.3 给出这些位置；三个入口结果相同。

规格：[用户整理 5.2](../../architecture/technical/09-user-organization.md#52-锚点)、[5.4](../../architecture/technical/09-user-organization.md#54-文本变化时)、[9.5](../../architecture/technical/09-user-organization.md#95-pdf-文件不同时重新定位)，经 01 的 1.3 补齐。

## 进入条件

- 01 的 1.3 已写进规格，且决定记录。
- 需要表结构变化时，03 的迁移已包含它（03 的 3.1）。

## 责任边界

- 负责：后端实施者。
- 拥有：`packages/contracts/src/marks.ts` 中按 1.3 新增或扩展的操作与字段；`apps/server/src/literature/marks.ts` 的 `MarkService`；`apps/server/src/storage/sqlite/marks-engine.ts`。
- 不改：现有锚点的校验规则与 `update` 对颜色、笔记的行为；导入批注的写入（计划 20 的 10）；阅读器（06）。

## Tasks

- [ ] **5.1 合同**：按 1.3 写出记录位置的操作或字段、它的解析函数与错误码；`ReadingMark` 的读取结果按 1.3 增加这些位置。
- [ ] **5.2 存储与校验**：按 1.3 写入；校验同规格 5.2；不改写原锚点；一个事务内完成，记操作记录与操作人（规格 6.4）。
- [ ] **5.3 列表与导出**：`list` 与 `export`（Markdown、JSON）按 1.3 给出；JSON 仍能被 `parseReadingMark` 逐条解析（规格第 8 节）。
- [ ] **5.4 三端**：CLI `marks`、MCP `marks_manage`／`marks_query`、HTTP 的批注接口按 1.3 支持；设备用途不变（`operate` 写、`read` 读）。

## 集成与影响

批注的读取结果多了字段（或多了操作），是公开合同变化。计划 20 的导入批注与使用者批注共用这些规则。

## 验证

扩展 `apps/server/test/reading-marks.test.ts`（合成文献，两份 sha256 不同的 PDF、两个文档版本），证明：

- 记下另一版 PDF 与另一文档版本上的位置后，原锚点逐字段不变；
- 指向别的文献的 PDF 或文档版本、超出字节范围、页码不存在的位置被拒（`mark-anchor-invalid`）；
- 已删除的批注不能记录位置（`mark-deleted`）；
- `list` 与 `export` 给出记下的位置；JSON 逐条可解析；
- Web 登录、CLI、stdio MCP、HTTP MCP 结果相同；设备用途不足时被拒；
- 写入前后文献事实不变（规格第 8 节）。

## 证据

提交号（G-commit 之后）；定向测试结果。

## 退出条件

记录与读取三端可用；06 可以在阅读器里调用。

## 恢复与交接

中断时以测试为准判断进度。1.3 的规则在实现中发现不可行（例如与导入批注冲突）时停下，写回执交总设计师，不自行改规则。
