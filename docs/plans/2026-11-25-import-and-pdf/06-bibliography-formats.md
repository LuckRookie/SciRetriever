# 06 书目文件的格式

类型：计划（结果块）
负责：EndNote、NoteExpress、知网等导出的书目文件的导入
状态：In progress（Owner 2026-11-26：“整个计划还剩下什么？需要做的？可以开始做了。”按此纳入；没有真实的导出文件，按公开的格式说明做）

## Outcome

国内常用的文献管理软件与数据库导出的书目文件可以直接导入。

## 进入条件

- 现状：文件导入接受 BibTeX、BibLaTeX、RIS、CSL JSON（[导入指南](../../guides/importing.md)）。
- 要有真实的导出文件做样本：EndNote（XML 与 `.enw`）、NoteExpress、知网的各种导出。

## 责任边界

只增加解析器；批次、认篇、查重不变。

## Tasks

- [x] 6.1 取舍（总设计师，2026-11-26）：先支持 EndNote 的文本格式（`.enw`，知网的“EndNote”导出同此）、EndNote 的 XML、NoteExpress 的文本格式（`.net`，知网的“NoteExpress”导出同此）。RefWorks 与知网 E-Study 不做。**没有收集到真实的导出文件**：实现只在按格式说明合成的样本上验证，Owner 提供真实文件后再核对一遍。
- [x] 6.2 规格（2026-11-26）：[文献与材料 6.4.14](../../architecture/technical/03-literature-materials.md#6414-endnote-与-noteexpress-的导出文件)，标为目标。
- [x] 6.3 后端（2026-11-26，`845dea89`、`24835a2c`；只在合成样本上验证）：解析器与测试；同时拖入的 PDF 照现有办法按路径配对。
- [ ] 6.4 前端：文件导入的说明文字列出新格式。
- [ ] 6.5 MCP 与 Skill：`import_bibliography` 的说明与 `skills/sciretriever/import.md` 同步。

## 验证

每种格式用真实的导出文件各一条测试：条目数、题名、作者顺序、年份、DOI、附件路径。

## 退出条件

选定的格式都能导入，指南同步。

## 恢复与交接

各格式互相独立，可以一种一种做。

[上级目录](README.md)
