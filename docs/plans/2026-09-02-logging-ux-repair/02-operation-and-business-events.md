# Block 2：操作与业务生产者

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | `EVT01`-`EVT06` |
| 前置块 | Block 1 Completed |
| 下游块 | Block 3、4 |
| 恢复点 | 最后一个通过模块直接测试的生产者切片 |

## 块结果

正常模式由业务拥有层讲述一次清晰的操作：开始、阶段/Source 或目标进度、稳定失败和最终 summary；Debug 才追加内部决策。Agents 使用统一事件格式，不再成为视觉例外。

## 进入条件

- Block 1 的 formatter 合同和直接测试通过；
- 逐个目标文件先审查现有用户 diff；
- 每项业务事实的 INFO owner 已在 Task 中明确。

## 责任与改动面

Primary owner 负责 Entry、Metadata/Discovery、Completion/Acquisition、Parsing/Analysis、Agents 的日志调用和直接测试。不得改写这些模块的业务结果、Report、数据库提交或 Provider 协议。

## 需要保持的行为

- 局部失败不停止其它目标，最终 Report 从 typed result 独立累计；
- Metadata raw item 计数、Acquisition tier barrier、Browser escalation、Parser/Agent 稳定 failure 语义不变；
- Agents 不记录 Prompt、schema 内容、模型原文、图片、tool arguments 或正文；
- 工作树中 stream 与 Config probe 的当前协议改动不被覆盖。

## Tasks

- [x] **EVT01 — 建立操作摘要 owner。** Entry 对处理型操作输出唯一开始、主要阶段和最终 summary，summary 从现有 typed result 形成而非日志反算。
  - 验收：代表性操作有一个开始和一个 summary，同一阶段快照不由 Entry/Cohort 重复 INFO。
- [x] **EVT02 — 整理 Metadata/Discovery。** INFO 保留 Source 开始/结果和稳定失败，raw item disposition 只在 DEBUG；字段统一为 provider/outcome/progress/elapsed。
  - 依赖：EVT01。
  - 验收：Source 成功、部分记录拒绝和 Source 失败 transcript 可区分且不过度刷屏。
- [x] **EVT03 — 整理 Completion/Acquisition。** Entry 拥有 tier/group/目标用户摘要，route/candidate/permit/capture/cleanup 为 DEBUG，局部失败包含稳定行动建议。
  - 依赖：EVT01。
  - 验收：一次 PDF 补全的 INFO 不重复生命周期，DEBUG 仍能解释 `disposition/next`。
- [x] **EVT04 — 整理 Parsing/Analysis。** 阶段开始、完成、失败语义与其它模块一致，失败不泄露 Parser/LLM 私有响应。
  - 依赖：EVT01。
  - 验收：Parse/Analyze 成功和失败 transcript 包含阶段、结果、耗时及安全建议。
- [x] **EVT05 — 统一 Agents 事件。** 把 plain `agent.call.start/result` 改为事件式消息，明确 role、provider、model reference 或 wire model、stream、capability、result、usage 和 elapsed；成功 INFO 避免按底层调用刷屏，失败由拥有层可见。
  - 依赖：Block 1；需保护当前 stream 改动。
  - 验收：Agents 测试证明两种 stream、成功/失败和 preflight 均可诊断且禁止内容不出现。
- [x] **EVT06 — 增加业务 transcript 与重复检查。** 使用 fake/fixture 覆盖代表性 INFO/DEBUG 流程，并验证同一事实的 INFO owner。
  - 依赖：EVT02-05。
  - 验收：直接测试通过，不以脆弱的完整自然语言快照绑定无关文案。

## 执行方式与集成点

按 EVT01 → EVT02/03 → EVT04/05 → EVT06 串行实施。每个模块切片必须同时修改生产者与直接测试；字段或 owner 变化影响下游时先更新本块再继续。

## 审查门

- R1：逐文件审查用户 diff、调用方和直接测试；
- R2：确认改动只影响日志，不改变业务路径、异常传播或 Report；
- R3：所有模块直接测试和日志 transcript 通过，重复 INFO 已消除。

## 接口 / 数据 / 依赖影响

- 接口：无公开 API 变化；内部事件命名/level/字段变化；
- 数据：无；
- 依赖：无。

## 验证与证据

使用与实际修改模块对应的 unittest，并至少包括：

```bash
uv run --frozen python -m unittest tests.test_logging_presentation tests.test_logging_foundation
uv run --frozen python -m unittest tests.test_agents tests.test_agents_providers
```

Completion、Metadata、Parsing、Analysis 的精确测试在进入各 Task 时从现有测试定位并记录。

## 退出条件

- EVT01-06 全部完成；
- 代表性业务 transcript 和相关模块测试通过；
- INFO owner、DEBUG 下钻与失败字段一致；
- 无业务合同、数据或公开 API 变化。

## 完成证据

完成于 2026-09-02：

- Metadata 单条 rejected record 降为 DEBUG，Provider 终态保留 INFO/WARNING 汇总、计数和稳定失败；
- Topic/Citation Discovery 的 completed、partial/action-required、interrupted 与 failed 终态统一携带 outcome、耗时和必要行动；
- Entry Completion 提升目标开始进度，manual/interrupted/not-started 与部分成功 summary 使用 WARNING 和明确 reason/action；
- Cohort、route delivery/局部 failure、Browser group item 和 publication lifecycle 降为 DEBUG，避免与 Entry 的 tier/group/target INFO 重复；
- Parsing/Analysis 阶段步骤保留在 DEBUG，用户可见失败由 Completion target summary 携带 stage、code、retryable、reason 和 action；
- Agents 改为 `agent-call-started/finished/preflight-failed` 事件，DEBUG 披露 wire model、protocol、stream、reasoning、capability、usage、耗时及安全失败证据，不记录 Prompt、响应正文或凭据。

直接证据：

```text
tests.test_logging_presentation + tests.test_metadata_contracts +
tests.test_agents + tests.test_agents_providers                         98 passed
tests.test_acquisition_cohorts + tests.test_tiered_acquisition_service +
tests.test_entry_completion                                             78 passed
tests.test_entry_topic_discovery + tests.test_entry_citation_discovery +
tests.test_entry_completion                                             72 passed
目标文件 Ruff check / format check                                      passed
```

## 失败与恢复

若生产者清理改变业务行为、测试证明日志由错误层拥有，或当前用户改动与计划冲突，停止当前 Task，保留最后通过切片并返回 owner/设计，不用兼容分支掩盖冲突。

## 下游交接

Block 3 可依赖：业务 INFO 摘要已唯一归属，外部边界只需补充 DEBUG 与稳定失败证据，不得重复阶段 summary。
