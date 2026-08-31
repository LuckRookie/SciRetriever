# Block 07：旧架构删除与当前文档同步

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | ABC51–ABC52，并收口 ABC03–ABC07/ABC48–ABC49 的实现事实 |
| 前置块 | Block 03、Block 06 |
| 下游块 | Block 08 |
| 恢复点 | 新 Runtime、Analysis、Browser controller 与生产对象图均已通过直接测试 |

## 1. 块结果

全库只剩新架构。旧 Session、累计预算、challenge 专属类型、Rules→Agent fallback、旧配置字段、旧测试和过时当前行为说明全部删除；架构边界测试与当前用户文档证明模块 owner、对象图和实际行为一致。

## 2. 进入条件

- Block 03 与 Block 06 Completed；
- 所有生产调用方已经使用新 Runtime/controller/config；
- 不存在必须延长的兼容窗口或用户未决迁移；
- 目标文档与实际实现差异已经列出。

## 3. 责任与改动面

- Owner：全库活动源码、测试、示例和 current docs；
- 重点：`agents/requests.py`、`agents/sessions.py`、旧 Browser control/budget/challenge 类型、Configuration/Bootstrap aliases、过时 test fixtures；
- 文档：README、guides、architecture docs、documentation map；
- 不改写 `docs/archive/` 的历史原文，除非活动链接因此断裂。

## 4. 需要保持的行为

- 所有新能力的直接测试与生产对象图保持绿色；
- 历史归档仍明确为非当前真相源；
- 不通过删除有效测试、弱化 Pyright/Ruff 或修改 Harness 掩盖残留；
- 不夹带与 Agents/Browser controller 无关的清理。

## 5. Tasks

- [x] **ABC51 — 全库移除旧符号与概念。** 删除 `AgentSession`、`open_session`、旧 `AgentRequest`、`BrowserAgentLoopBudget`、challenge 专属 Observation/target/controller、Rules→Agent fallback 和预算耗尽状态。
  - 依赖：Block 03、Block 06。
  - 验收：`rg` 只在明确说明“已删除/不采用”的计划或历史语境命中；活动源码、测试、current docs 和 wheel 路径零残留。

- [x] **ABC52 — 架构边界与文档闭环。** 更新/新增测试证明 Agents 不依赖业务模块、Acquisition 不执行 vendor 动作、Network 不决定文献业务事实，并同步全部 current docs。
  - 依赖：ABC51。
  - 验收：architecture cutover tests 通过；requirements/ADR/design/technical/current README/guide 与实现没有 owner、状态、动作、配置或对象图漂移。

## 6. 执行方式与集成点

先从生产对象图向旧符号反向搜索真实调用方，再删除源码/导出/fixture/config 分支，运行直接架构测试后同步 current docs。删除按完整意图进行，不靠 alias、动态探测或测试排除维持绿色。

本块完成 I4：Block 01–06 的实现和目标文档收敛为一个 delivery candidate，Block 08 不再承担功能迁移。

## 7. 审查门

- R1：I1–I3 已通过，旧符号不存在仍需支持的真实消费者；
- R2：每个删除切片审查是否误删数据/历史、弱化测试、破坏 wheel 或夹带无关清理；
- R3/I4：精确 `rg`、架构测试、current docs 和生产对象图一致，无兼容双路径；
- 发现遗漏消费者时返回其 owner Block，不在删除层增加 wrapper。

## 8. 接口、数据与依赖影响

- 完成内部破坏性 API 切换，不保留 import alias/wrapper/配置 fallback；
- 不删除受支持数据或迁移用户数据库/Profile；
- wheel module inventory 随删除/新增源码变化，由 Block 08 验证；
- archived historical references 不代表活动兼容面。

## 9. 验证与证据

- 精确 `rg` 旧符号/词汇清单；
- `tests/test_architecture_cutover.py` 及相邻模块合同测试；
- documentation link/term/command check 与 `git diff --check`；
- `python -m compileall`/相关 Ruff/Pyright 作为早期集成检查；
- wheel 内容最终由 Block 08 Full 证明。

## 10. 退出条件

- ABC51、ABC52 全部勾选；
- 旧源码文件、导出、fixture、配置字段、组装分支和 current docs 语义清零；
- 直接架构测试和文档检查通过；
- 没有为了绿测保留的兼容层或弱化门禁。

## 11. 完成证据

- 物理删除旧生产/测试资产：`src/sciretriever/agents/requests.py`、`src/sciretriever/agents/sessions.py`、`src/sciretriever/acquisition/browser_state.py`、`tests/test_browser_state.py` 与 `tests/fixtures/acquisition/browser/runtime-page-states.json`；公共导出、调用方、fixtures 和配置分支没有保留 alias、wrapper 或动态 fallback。
- I4 审查发现 Block 05 初次完成证据遗漏两组真实残留，并按 owner 返回修复：其一是 `BrowserRunStateMachine` 与 Challenge Publisher circuit；其二是 `BrowserBudget`、整篇 60 秒 deadline、累计 navigation/request/popup/download/capture/byte 限制和 `BrowserSiteRule.max_actions`。修复与直接证据已回填 Block 05，而不是在删除层增加兼容层。
- Current docs 已同步：PDF 获取指南、Provider 接入手册、代码/文档映射、Agents/Acquisition/Network/Configuration 技术文档、配置手册、工具中立性声明和 Provider/现场核实说明现在统一描述 Rules/Agent 作业级互斥、统一 Challenge、六动作、文章级 `challenge-unresolved`、无 Challenge group circuit 与单次 operation limits；2026-08-21/22 旧现场词汇保留时均明确标为历史观察。
- 精确文件/符号检查确认三个旧源码文件不存在，活动生产路径无 `AgentSession`、`AgentRequest`、`AgentBudget`、`BrowserBudget`、`BrowserRunState*`、`CHALLENGE_REQUIRED`、`BrowserAgentLoopBudget` 或旧 Challenge failure；Metadata 的 `RawItemSession.open_session`、Browser flow/session broker 和架构负向哨兵不属于 Agents Session 兼容面。
- 组合回归：Network Browser、local Cloak fixture、Provider fixture、Acquisition Browser/matrix、Bootstrap readiness、content pipeline contract 与 architecture cutover 共 198 项，`OK (skipped=2)`；Configuration/CLI/architecture 邻接组 133 项，`OK`。两个 skip 都是未配置 opt-in Cloak runtime，没有访问真实 Provider/Profile/凭据。
- 静态与文档检查：目标 Ruff lint `All checks passed`，252 个目标 Python 文件 Ruff format check 通过，全库 Pyright 退出 0，`git diff --check` 退出 0；旧行为短语搜索在 README/guides/development/current technical docs 中无输出。实际 wheel module/content 与 fresh-wheel 仍按计划由 Block 08 ABC55/ABC56 验证，不在 I4 提前宣称。
- I4 结论：Block 01–07 已形成无旧兼容双路径的 delivery candidate；数据库 schema、资产布局、凭据文件格式和依赖/lock 均未因本块变化。

## 12. 失败与恢复

- 若残留调用方揭示未迁移真实消费者，回到其 owner 块完成迁移，不在本块加 adapter；
- 若 current docs 与目标文档混淆，目标事实回 architecture，当前使用事实回 README/guide；
- 若删除导致 wheel/source 不一致，不手工修改构建产物，修正源码清单/packaging owner。

## 13. 下游交接

Block 08 接收一个无旧架构残留、直接测试已通过、文档已同步的完整工作树，只负责扩大验证、语义审查和交付，不再进行功能性补丁；若验证揭示根因则回到相应 owner 块。
