# 计划文档清单

本清单决定哪些 Markdown 属于当前计划，避免把历史过程材料继续当作执行入口。

| 文件 | 处理 | 理由 |
| --- | --- | --- |
| `README.md` | 保留 | 当前计划总入口、全量范围、阶段、完成定义 |
| `full-migration-roadmap.md` | 保留 | 原始 M0–M6、T001–T064 的唯一全量任务状态源 |
| `migration-map.md` | 保留 | 原始 235 个模块及新增 7 个 bridge、Provider、公开入口、CLI 和配置的 TypeScript 去向 |
| `01`–`06` | 保留并重写 | M0–M6 的阶段说明和已完成首阶段证据；不得覆盖全量路线状态 |
| `browser-design-manual.md` | 保留并重写 | Browser 前台、后台、协议和验收设计 |
| `config-tui-design-manual.md` | 保留并重写 | TUI 前台、配置后台、协议和验收设计 |
| `architecture-review.md` | 保留 | 记录此前范围裁剪的历史审查和本次恢复全量计划的说明；不作为执行入口 |
| `original-bundle/`（位于 `docs/archive/`） | 外部基线 | 原始 M0–M6、T001–T064、验收 ID、来源和原始计划包自检；当前目录不复制或改写它 |
| `decision-log.md` | 归档 | 旧计划过程决策已吸收到 README 和各阶段，不再维护第二份事实源 |
| `execution-order.md` | 归档 | 旧的 192 Task 执行顺序，已由六阶段依赖替代 |
| `scope-and-invariants.md` | 归档 | 旧版大范围不变量，保留历史以便追溯 |
| `task-ledger.md` | 归档 | 旧的细粒度台账，避免与阶段任务形成双重状态 |
| `verification-matrix.md` | 归档 | 旧的全量验收矩阵；当前验收直接写在阶段文档 |
| `plan-review.md` | 归档 | 历史审视报告；当前裁剪结论见 `architecture-review.md` |
| 原目录内 `reference/` | 归档 | 删除活动目录中的重复副本，避免两份来源漂移；权威原始基线保存在 `docs/archive/.../original-bundle/` |

## 当前唯一执行入口

从 `README.md` 开始，先读取 `full-migration-roadmap.md` 的 M0–M6 总路线，再按依赖进入对应阶段文档。全量路线是 T001–T064 的唯一状态源；阶段文档只维护实现说明和证据链接。`docs/archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/` 是范围、设计和验收的原始基线；其它历史过程材料不得覆盖当前路线。首阶段 Browser 证据不能扩大为全量迁移完成。
