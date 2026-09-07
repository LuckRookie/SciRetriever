# Block 04：文档、完整验证与交接

## 状态与恢复点

- 状态：`Completed with field validation failed`
- 前置：Block 01–03
- 下游：计划完成或转入现场问题计划
- 恢复点：从最后一个通过的 Full 子步骤或现场测试结果摘要恢复

## 块结果

源码、测试、ADR/technical/guide 和验证证据对“自主 Browser 会话 + 终态 PDF 验收”达成一致；用户能区分 Agent 探索失败、Browser runtime 故障、外部权限问题和最终 PDF 验收失败。

## Tasks

- [x] **AVH01 — 同步架构与当前行为文档。** 修订 ADR 0023、Network/Acquisition technical、PDF guide 和必要 logging 说明，删除“每一步必须匹配预期”的过时描述。
  - 验收：文档说明过程自由度、保留的硬性边界、candidate/validated/terminal 语义和停止条件。
  - 依赖：ATV03。
- [x] **AVH02 — 运行相关测试与 Quick。** 执行 Agents、Browser、Network、Acquisition 相关 unittest、Ruff/format 和 Quick。
  - 验收：命令和结果记录在本块完成证据中；不把未运行的检查写成通过。
  - 依赖：AVH01。
- [x] **AVH03 — 执行 Full Harness。** 运行完整类型、测试、wheel 和内容核对。
  - 验收：Full 通过；若环境失败，记录具体步骤、原因和残余风险，不能宣称完成。
  - 依赖：AVH02。
- [x] **AVH04 — 获得授权后进行一次真实 Browser 验证。** 使用既有 CloakBrowser Profile，观察 Challenge 点击、页面继续探索、候选捕获和最终验收；只记录脱敏摘要。
  - 验收：成功时有有效 PDF 与文章归属；失败时能落在明确阶段，并能判断是 Agent、Browser、Network、外部权限还是 URL/站点问题。
  - 依赖：AVH03；需要用户现场访问授权。
- [x] **AVH05 — 最终 diff/范围/凭据审查与交接。** 检查工作树不含真实资产、临时文件、凭据和无关改动；更新根 README 状态。
  - 验收：满足根计划全局验收，或准确列出未完成和下一步计划。
  - 依赖：AVH01–AVH04。

## 执行方式与审查门

按 AVH01→AVH02→AVH03→AVH04→AVH05 串行执行。现场测试前必须确认离线闭环、Profile/runtime readiness 和用户授权；现场失败不通过修改测试掩盖，必要时创建单独问题计划。

## 接口、数据与依赖影响

- 仅同步当前行为和验证证据；不把真实日志、截图、PDF、Cookie、完整 URL 或响应正文复制到仓库。
- 不执行 commit/push/release，除非用户另行授权。

## 验证与退出条件

```bash
uv run --frozen python -m unittest discover -s tests -p 'test_<name>.py'
uv run --frozen python scripts/harness.py quick
uv run --frozen python scripts/harness.py full
```

退出条件：文档与代码一致；适用 Harness 通过或残余风险已明确；现场验证在授权范围内完成或明确未运行原因；最终交接包含实际完成范围、验证证据、未运行检查、合同/依赖影响和残余风险。

## 失败与恢复

Full 失败时从失败步骤恢复，不删除构建物以外的用户文件；现场失败时保留系统临时目录证据路径，先判断是否属于新的外部站点/权限问题，再决定是否创建后续计划。

## 完成证据

已完成证据：

- 相关 unittest：Browser/Network/Acquisition/Agents 回归 `Ran 172 tests in 10.619s`，`OK (skipped=1)`。
- `uv run --frozen python scripts/harness.py quick`：通过（Ruff lint、format check、compile）。
- `uv run --frozen python scripts/harness.py full`：通过（lint、format、compile、Pyright strict、全量 unittest、wheel 构建与 wheel 内容核对）。
- 全量 Harness 测试阶段通过；测试使用 fake、fixture、系统临时目录和本地 CloakBrowser/HTTPS 组件，不连接真实 Provider、真实凭据、真实出版社或用户 Profile。
- 文档已同步：ADR 0023、Network/Acquisition/Agents 技术文档、PDF 获取指南及本计划。
- AVH04 现场结果（2026-09-07，单篇 Literature，未扩大到 pending 集合）：Browser runtime、固定 Profile、目标导航均就绪；Network 观察到并接受 `application/pdf` response/download 候选，但在 `control settle` 的 `snapshot` 阶段返回 runtime failure，Agent 模型调用次数为 0，未形成 `BrowserCaptureBatch`，未发布 PDF。最终稳定结果为 `acquisition-browser-agent-action-failed`，`retryable=true`；本次 cleanup 已成功完成。
- 独立 Browser Model 探针同日返回 `agent-protocol`：Provider 响应到达，但不符合当前 `openai-responses` 流式响应结构。该问题与文章流程中的 Browser snapshot 失败分开记录。
- 调试截图仍只保留在系统临时目录 `/tmp/sciretriever-agent-debug-81_d0imp`，未复制进仓库；本轮没有新增成功业务事实、凭据或 PDF。
- 残余风险：真实站点的 Agent 协议兼容、异步导航后的 snapshot settle 与候选交接仍未闭环；应创建后续现场问题计划，先修复并离线回归，再用同一篇 Literature 复测。
