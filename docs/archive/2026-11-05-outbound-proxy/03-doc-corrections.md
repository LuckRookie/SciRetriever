# 03 · 旧文档错误修正

类型：计划（结果块）
负责：已发现的、与已接受 ADR 或现行实现不符的现行文档
状态：Completed（2026-11-05）

## Outcome

现行文档与已接受的 ADR、现行代码一致。

## Tasks

- [x] **3.1 Sci-Hub 默认状态**：ADR 0040 起 Auto 默认包含 Sci-Hub（`providers/sci-hub/definition.ts` 的 `acquisitionAuto: true`），以下现行文档仍写“默认关闭、显式启用后”：需求第 111 行与验收表 Sci-Hub 行、`docs/guides/configuration.md` Sci-Hub 一节、`docs/notes/providers/README.md`、`docs/notes/tool-neutrality.md`。
- [x] **3.2 其余**：修正过程中发现的同类错误，记在本块。2026-11-05 已查 Sci-Hub 默认状态与 Metadata Auto 的表述，没有其他不符；“正常网络出口”一类表述已随 02 的 2.3 改完（配置手册、原则、技术 01/02/08、PDF 获取指南、Provider 笔记与接入指南）。

## 验证

逐处对照 ADR 0040 与代码；ADR 正文不改。
