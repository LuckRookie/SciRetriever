# Block 04：完整验证与真实复测

## 状态与恢复点

- 状态：`Pending`
- 前置：Blocks 01–03
- 恢复点：从最近失败的 Harness 子步骤或现场结果恢复

## Tasks

- [ ] **BOV01 — 相关测试与 Quick。** 运行 Browser/Network/Acquisition/Agents 相关 unittest 和 Quick。
- [ ] **BOV02 — Full Harness。** 运行 Pyright、全量 unittest、wheel 构建与内容核对。
- [ ] **BOV03 — 单篇真实复测。** 使用既有固定 Profile 和同一篇 Literature；不扩大到 `--all-pending`，只记录脱敏结果。
- [ ] **BOV04 — 交接。** 记录成功 PDF 或明确失败阶段、未运行检查和残余风险；不提交真实截图、PDF、Cookie、Token 或日志正文。

## 退出条件

离线闭环和 Full 通过；真实复测形成 `PDF_READY` 或可定位的现场失败证据；计划状态和当前行为文档同步。
