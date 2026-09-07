# Block 02：Agent 与 Candidate 捕获解耦

## 状态与恢复点

- 状态：`Complete`
- 前置：Block 01
- 下游：Block 03
- 恢复点：candidate 与 snapshot 独立的 controller 回归通过后进入文档同步

## 块结果

Agent 只在需要页面探索时获得 observation。candidate 等待和 PDF 验证拥有独立路径；页面短暂不可观察不会取消候选。

## Tasks

- [x] **BAC01 — 调整控制顺序。** 在要求 snapshot 前先处理已完成或正在完成的 candidate；candidate body 读取期间允许页面 observation 暂时不可用。
- [x] **BAC02 — 保留明确终态。** 有效 PDF、Agent Stop、超时、取消和真正 Browser runtime failure 分别产生稳定结果。
- [x] **BAC03 — 补 controller 回归。** 覆盖“candidate 已完成不调用 Agent”“candidate pending 不因 snapshot 失败丢失”“候选错误后继续探索”。

## 责任与改动面

- Owner：`network/browser.py`、`acquisition/browser_control.py` 及对应测试。
- Acquisition 继续拥有最终 PDF/文章归属验收；Agent 不声明成功。

## 验证与退出条件

相关 Browser/Agent/Acquisition 测试通过，且候选读取不再要求页面 snapshot 成功。

## 失败与恢复

若必须引入持久化会话或第二套跨进程状态机，停止并重新评估大架构门；当前计划不包含该变化。
