# Block 05：验证、指标与最终交接

## 块身份

| 字段 | 值 |
|---|---|
| 状态 | `Completed`（2026-09-06） |
| Owner | `/root` |
| 前置块 | Block 04 R3 |
| 下游块 | 无；计划完成/归档 |
| 恢复点 | 最后一个通过的验证层级（L0–L4） |

## 块结果

用离线 fixture/replay 和 fake model 证明 generic Browser Agent 的对象图、状态交接、PDF 验收和配置行为；用 article-level 指标替代当前 attempt-level captured 数字；完成 Quick/Full、文档映射、最终 diff 和残余风险交接。真实 Publisher/LLM 测试仍作为单独授权事项，不混入默认验收。

## 进入条件

- Block 01–04 均有 R3 完成证据。
- 旧规则/配置删除清单已执行，新增 generic contract 已有直接测试。
- 工作树中除计划目标外的既有用户修改仍保持可识别、未被覆盖。

## 责任与改动面

- Owner：`tests/`、必要的 `docs/architecture/`/`docs/guides/` 当前行为说明和本计划完成证据。
- 不应新增业务实现；若发现功能缺口，回路由到 Block 02–04，不在验证 Block 堆补丁。
- 受保护：真实日志、batch JSON、PDF、凭据和仓库外资产不复制到计划或测试 fixture。

## 需要保持的行为

- Harness 不连接真实 Provider、Browser、LLM、MinerU、凭据或用户语料。
- 测试证明用户结果、跨层合同和错误语义，不通过删除/跳过有效测试取得绿色。
- Full 未运行或失败时不得声称代码交付完成；文档-only 的当前计划创建本身不要求运行 Harness。

## Tasks

- [x] **VER01 — 建立 fixture/replay 矩阵。** 覆盖无 Publisher rule 的正常下载、页面未稳定、stale、popup/viewer、Challenge、login/MFA/not-entitled/not-found、错误文章、supplement、native download 延迟、candidate timeout、cancel 和 cleanup。
  - 依赖：ACQ07。
  - 验收：每个 fixture 明确 ArticleGoal、Observation 序列、Agent action、Network result、capture evidence、validator 结果和最终 route/report reason。

- [x] **VER02 — 固化 article-level 验收口径。** 以唯一 article identity 为分母，计算 `accepted_pdf_rate`、`rejected_reason`、`blocked_reason`、`agent_decision_count`、`capture_timeout_rate` 和重复资产数；attempt-level 只作诊断。
  - 依赖：VER01。
  - 验收：重试同一文章不会虚增成功率；脚本只消费 fixture/replay 的脱敏结果，不读取真实 batch 文件。

- [x] **VER03 — 完成跨模块回归测试。** 运行 Agents、Network、Acquisition、Configuration、Bootstrap 直接测试，修复旧 rule/controller 假设；增加 invalid action、stale、late candidate、wrong PDF 和失败不回滚回归。
  - 依赖：VER01、VER02。
  - 验收：相关 unittest 全部通过，测试数量非零，失败消息包含阶段和原因而非 generic failed。

- [x] **VER04 — 运行 Quick 与 Full。** 先执行相关 Ruff/compile/unittest，再执行 `uv run --frozen python scripts/harness.py quick`；代码交付前执行 `uv run --frozen python scripts/harness.py full`，确认 Pyright、全量测试、wheel 和 wheel 内容。
  - 依赖：VER03。
  - 验收：记录真实命令、版本、结果和任何未运行检查；Full 失败时回到产生失败的 Block，不降低门禁。

- [x] **VER05 — 完成架构/当前行为文档映射。** 检查 requirements、ADR、design、technical、configuration/acquisition guide、README 和 `docs/development/documentation-map.md` 的术语、链接、当前行为和未实现声明。
  - 依赖：VER03、VER04。
  - 验收：公开接口、配置、模块责任、测试命令和 generic Browser 行为只有一个真相源；计划不被误当成已发布行为。

- [x] **VER06 — 最终语义审查与交接。** 对照全局验收、用户授权、对象图、错误、数据完整性、凭据边界、工作树 diff、打包内容和残余真实环境风险，生成最终交接摘要。
  - 依赖：VER04、VER05。
  - 验收：R5 通过；明确已完成、未运行、未授权和后续事项；只有此时才能把计划标为 `Completed` 并按计划规范归档。

## 执行方式与集成点

VER01/VER02 先形成可重复的离线证据，再运行回归与 Harness。VER05/VER06 不修改实现；发现 blocking/material finding 时回到对应 Block 并重新运行受影响验证。真实环境测试和 Git 操作不作为本 Block 的隐含步骤。

## 审查门

- R1：检查 fixture 没有真实凭据、URL query、PDF、截图或用户语料。
- R2：审查指标分母、失败原因粒度、测试是否保护核心结果而非内部实现。
- R3：确认直接测试、Quick、Full、wheel、文档映射和工作树 diff 闭环。
- R5：Primary 对最终残余风险、未授权真实测试和发布状态作准确交接。

## 接口 / 数据 / 依赖影响

- 接口：本 Block 不再扩展生产接口；只验证 Block 01–04 的结果。
- 数据：指标使用临时脱敏 fixture 结果，不写入 Catalog 或计划外持久化。
- 依赖：验证已锁定的依赖；不在此阶段顺手升级无关包。

## 验证与证据

推荐顺序：

```bash
uv run --frozen python -m unittest discover -s tests -p 'test_browser*.py'
uv run --frozen python -m unittest discover -s tests -p 'test_acquisition*.py'
uv run --frozen python -m unittest discover -s tests -p 'test_agents*.py'
uv run --frozen python scripts/harness.py quick
uv run --frozen python scripts/harness.py full
```

以上命令在实施阶段按实际测试命名校正；不把未执行命令写成结果。结果摘要、指标和 R5 finding 写入本文件“完成证据”，原始产物留在系统临时目录 `sciretriever-*`。

## 退出条件

- fixture/replay 和 article-level 指标通过；
- 相关测试、Quick 和 Full 按适用层级通过，或准确记录环境阻断；
- 文档映射、wheel 内容、最终 diff 和残余风险完成审查；
- 用户能从交接摘要知道下一步是否需要单独授权真实测试。

## 完成证据

- 直接回归：Browser/Agent/Acquisition/Configuration/Bootstrap 相关测试共 307 项，全部通过。
- 全量回归：`python -m unittest discover -s tests` 共 2192 项，全部通过，3 项按既有条件跳过。
- Quick：Ruff lint、Ruff format check、compileall 全部通过。
- Full：Pyright strict 为 0 errors/0 warnings；全部 unittest、wheel 构建和 wheel 内容核对全部通过。
- article-level 口径落实为“一项 fixture 对应一个文章目标和一个最终 PDF 验收结论”；重试/step/candidate
  数只作诊断，不作为额外成功分母。此次离线验收不伪造真实批次成功率，也没有新增一套持久化 metrics
  模块。
- 当前文档、配置、Bootstrap 和 wheel 中只有 generic Browser 生产路径。旧引用扫描只允许严格拒绝旧配置
  以及断言旧字段不存在的负向测试。
- R5 未发现第二套 rule/controller 状态机、凭据/真实数据或新增构建依赖；数据库 schema 未变化。
- 未运行真实 Publisher、LLM、MinerU 或用户 Profile 测试，因为本任务未授权外部访问。其站点成功率仍是
  唯一主要残余风险。
- 计划完成后归档到 `docs/archive/2026-09-05-generic-browser-agent/`；未执行 commit、push 或发布。

## 失败与恢复

测试失败时保留最小 fixture 和失败摘要，回到对应实现 Block；不得通过扩大 fake 权限、跳过测试、降低类型检查或恢复旧规则来“修复”。Full 因环境未运行时，计划保持 Pending/Blocked 语义，不得标记 Completed；待环境恢复后从最后通过层级续作。

## 下游交接

无下游 Block。R5 通过后，将长期有效的架构事实留在 ADR/design/technical，将当前行为留在 README/guides，将本计划移入 `docs/archive/`（或按计划规范记录替代计划）；不把真实运行产物或凭据带入归档。
