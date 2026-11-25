# 04 Agent 的入口：MCP 与 Skill

类型：计划（结果块）
负责：各条导入途径和与 PDF 有关的操作在 MCP、CLI 与 Skill 里齐全、一致
状态：Pending

## Outcome

Agent 能代使用者走通每一条导入途径和与 PDF 有关的操作；Skill 写的与程序现在的行为一致。

## 进入条件

- Owner 2026-11-25：“以后都是 Agents 时代，这些导入最好都提供 MCP 和 Skill。”
- 现状：MCP 已有 `import_bibliography`、`discover_metadata`、`discover_citations`、`acquire_pdf`、`recognize_literatures`、`collect_literatures`、`uncollect_literatures` 与批次的读取；Skill 在 `skills/sciretriever/`（`SKILL.md`、`import.md`、`source-zotero.md`、`use.md`、`connect.md`、`recovery.md`、`scripts/`）。只核对过它们存在，没有通读。
- 块 01 的接口定下之后补它的部分。

## 责任边界

本块不设计新的导入途径；只让已有的和本计划新增的途径在 MCP、CLI 与 Skill 里齐全、一致。

## Tasks

- [ ] 4.1 清点（总设计师）：列一张表，行是每条途径与操作（书目文件、只导入 PDF、Zotero、网页收藏、主题搜索、引用扩展、按 DOI 或标题添加、识别书目、加入与移出文献库、列出候选、获取 PDF、解析全文），列是页面、CLI、MCP、Skill，写明有、没有、过时。表放在本块。
- [ ] 4.2 定缺口的处理（总设计师）：每个“没有”是补上，还是写明不提供及理由。
- [ ] 4.3 后端：补 4.2 定下要补的 MCP 与 CLI。
- [ ] 4.4 Skill：补缺的章节，改过时的说法（包括 2026-11-25 改的用词与规则：文献库与候选、解析全文、识别书目）。
- [ ] 4.5 核对：按 Skill 的写法，用一个 Agent 在样例库上各走一遍，记录走不通的地方并修正。

## 集成与影响

只增加 Agent 一侧的入口与说明。

## 验证

4.1 的表全部为“有”或写明不提供；4.5 的记录。Skill 自带的测试（`skills/sciretriever/tests/`）通过。

## 退出条件

表里没有“过时”；Skill 与[代理接口指南](../../guides/agent-interface.md)一致。

## 恢复与交接

4.1、4.2 是文档工作，可以分次做。

[上级目录](README.md)
