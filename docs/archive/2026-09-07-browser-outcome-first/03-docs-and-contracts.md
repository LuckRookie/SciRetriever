# Block 03：合同、文档与回归同步

## 状态与恢复点

- 状态：`Complete`
- 前置：Blocks 01–02
- 下游：Block 04
- 恢复点：文档与实现对齐后进入完整验证

## Tasks

- [x] **BDC01 — 修订长期合同。** 更新 ADR 0023、Network/Acquisition/Agents technical 和 PDF guide，说明 Agent 探索、Browser capture、最终 PDF 验收的最小职责。
- [x] **BDC02 — 更新当前行为与日志。** 记录 candidate pending、capture complete、snapshot transient 和最终失败阶段，避免把中间事件写成业务成功。
- [x] **BDC03 — 语义审查。** 检查配置、数据、provenance、cleanup、凭据边界和公开结果未被扩大。

## 验证与退出条件

文档事实与实现一致，`git diff --check` 通过，相关回归保持通过。
