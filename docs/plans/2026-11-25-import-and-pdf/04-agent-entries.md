# 04 Agent 的入口：MCP 与 Skill

类型：计划（结果块）
负责：各条导入途径和与 PDF 有关的操作在 MCP、CLI 与 Skill 里齐全、一致
状态：In progress（4.1、4.2 完成；4.4 的三节已写；4.3、只导入 PDF 与 4.5 未做）

## Outcome

Agent 能代使用者走通每一条导入途径和与 PDF 有关的操作；Skill 写的与程序现在的行为一致。

## 进入条件

- Owner 2026-11-25：“以后都是 Agents 时代，这些导入最好都提供 MCP 和 Skill。”
- 现状：MCP 已有 `import_bibliography`、`discover_metadata`、`discover_citations`、`acquire_pdf`、`recognize_literatures`、`collect_literatures`、`uncollect_literatures` 与批次的读取；Skill 在 `skills/sciretriever/`（`SKILL.md`、`import.md`、`source-zotero.md`、`use.md`、`connect.md`、`recovery.md`、`scripts/`）。只核对过它们存在，没有通读。
- 块 01 的接口定下之后补它的部分。

## 责任边界

本块不设计新的导入途径；只让已有的和本计划新增的途径在 MCP、CLI 与 Skill 里齐全、一致。

## Tasks

- [x] 4.1 清点（总设计师）：列一张表，行是每条途径与操作（书目文件、只导入 PDF、Zotero、网页收藏、主题搜索、引用扩展、按 DOI 或标题添加、识别书目、加入与移出文献库、列出候选、获取 PDF、解析全文），列是页面、CLI、MCP、Skill，写明有、没有、过时。表放在本块。
- [x] 4.2 定缺口的处理（总设计师）：每个“没有”是补上，还是写明不提供及理由。
- [ ] 4.3 后端：补 4.2 定下要补的 MCP 与 CLI。
- [ ] 4.4 Skill：补缺的章节，改过时的说法（包括 2026-11-25 改的用词与规则：文献库与候选、解析全文、识别书目）。
  - [x] 三节已写进 `skills/sciretriever/use.md`（2026-11-26）：文献库与候选、搜索与扩展、整理文献库、获取 PDF 与解析全文；`SKILL.md` 的索引与描述同步。工具名与行为对过 `apps/server/src/mcp/tools.ts`，没有用 Agent 实际走过（4.5）。
  - [ ] 只导入 PDF 的流程：等上传脚本支持只有文件的条目（4.3）。
  - [ ] Zotero：随 [07](07-zotero-import-program.md)。
- [ ] 4.5 核对：按 Skill 的写法，用一个 Agent 在样例库上各走一遍，记录走不通的地方并修正。

## 4.1 的清点结果（2026-11-25）

只读清点，由子代理完成，关键几条已对照代码核实。MCP 分 stdio 版与 Skill 使用的 HTTP 版（`/mcp`）；HTTP 版不提供 `import_bibliography` 与四个 PDF 上传工具。

| 途径或操作             | 页面                                       | CLI          | MCP                | Skill                                                |
| ---------------------- | ------------------------------------------ | ------------ | ------------------ | ---------------------------------------------------- |
| 书目文件，同时带 PDF   | 有                                         | 有，只交书目 | stdio 有，只交书目 | 有                                                   |
| 只导入 PDF             | 有                                         | 没有         | 没有               | 没有（接口支持，上传脚本不调用）                     |
| 从 Zotero 导入         | 过时（说在扩展里导入，扩展里是“尚未开放”） | 没有         | 没有               | 过时（已于当天改正说法）                             |
| 网页收藏               | 有                                         | 不提供       | 不提供             | 不提供（要用浏览器的登录状态）                       |
| 主题搜索               | 有                                         | 有           | 有                 | 没有                                                 |
| 引用扩展               | 有                                         | 有           | 有                 | 没有                                                 |
| 按 DOI 或标题添加      | 没有                                       | 没有         | 没有               | 没有                                                 |
| 识别书目               | 有                                         | 有           | 有                 | 没有                                                 |
| 加入、移出文献库       | 有                                         | 有           | 有                 | 没有                                                 |
| 列出候选               | 有                                         | 有           | 有                 | 没有                                                 |
| 删除与恢复             | 有                                         | 有           | 有                 | 没有                                                 |
| 获取 PDF               | 有                                         | 有           | 有                 | 没有                                                 |
| 给已有文献上传 PDF     | 有                                         | 有           | 只有 stdio 版      | 没有                                                 |
| 解析全文               | 有                                         | 有           | 有，说明过时       | 没有                                                 |
| 批次的预览、确认、报告 | 有                                         | 只读         | 只读               | 有；撤回按设计只给网页                               |
| 全文翻译               | 有                                         | 没有         | 没有               | 没有（随 [08](08-stored-translation.md) 补读取入口） |

结论：CLI 与 MCP 基本齐全，缺的主要在 Skill，它只覆盖“入库批次”一条路。

过时或写错的说法：

- [x] [代理接口指南](../../guides/agent-interface.md)里三处：使用说明与 skill 的地址、接口说明的地址与页面名称、MCP 上传“单文件不超过 16 MiB”。2026-11-25 已改。
- [x] [导入指南](../../guides/importing.md)的 Zotero 步骤、Skill 的 `SKILL.md`、`import.md`、`source-zotero.md`：都说 Zotero 在扩展里导入，实际尚未开放。2026-11-25 已改为现状。
- [x] [配置手册](../../guides/configuration.md)里 `max_concurrency` 的说明不全。2026-11-25 已改。
- [ ] `apps/server/src/mcp/tools.ts` 里 `archive_manage` 的说明写着“需要已有的原始解析，从不调用 MinerU”，实际 `full` 模式缺解析时会先解析。改代码里的说明，交后端。
- [ ] 页面“找文献 → Zotero”标签页说在扩展里选库与分组，扩展里尚未开放。改页面文字，交前端。
- 没有核实、暂不改：导入指南说引用扩展要先配置模型；代理接口指南里上传缓冲“总计 32 MiB”。

## 4.2 的决定（总设计师，2026-11-25）

补：

- Skill 增加三节：搜索与扩展（带回来的是候选）；整理文献库（识别书目、加入与移出、候选、删除与恢复，写明 [ADR 0067](../../architecture/decisions/0067-library-and-candidates.md) 的规则）；获取 PDF 与解析全文（先估用量，再发起，按任务查进度）。
- 只导入 PDF：Skill 写明流程，上传脚本支持只有文件的条目。CLI 以后再说。
- 按 DOI 或标题添加：随 [01](01-add-by-identifier.md) 四处一起做。
- Zotero：随 [07](07-zotero-import-program.md)、[16](16-extension.md)。

不提供，理由如表：网页收藏的 CLI、MCP、Skill；批次的 CLI 预览与确认；经 MCP 写入批次；撤回。

待定：Agent 给一篇已有的文献补 PDF，是给设备开放补 PDF 接口，还是在 Skill 里写“用只含这一篇的批次交文件”。先核对后一种做法现在是否成立，再定。

## 集成与影响

只增加 Agent 一侧的入口与说明。

## 验证

4.1 的表全部为“有”或写明不提供；4.5 的记录。Skill 自带的测试（`skills/sciretriever/tests/`）通过。

## 退出条件

表里没有“过时”；Skill 与[代理接口指南](../../guides/agent-interface.md)一致。

## 恢复与交接

4.1、4.2 是文档工作，可以分次做。

[上级目录](README.md)
