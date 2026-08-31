# Block 03：Analysis 去 Session 迁移

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | ABC17–ABC22 |
| 前置块 | Block 02 |
| 下游块 | Block 06、Block 07 |
| 恢复点 | Block 02 已通过的 Agents Runtime 公共合同 |

## 1. 块结果

Analysis 直接通过 `AgentRuntime.execute` 完成现有两阶段内容分析、Metadata stage 和 ReferenceLookup。Analysis 继续唯一拥有 prompt、schema、阶段顺序、输入对齐、业务结果验收和最终 provenance；不再创建单 turn Session，也不再选择 Provider/model。

## 2. 进入条件

- Block 02 Completed；
- Agents Runtime 的 structured result、role binding、取消和稳定失败测试通过；
- 当前 Analysis 三条调用链、生产对象图和直接测试已重新核实。

## 3. 责任与改动面

- Owner：`src/sciretriever/analysis/`；
- 主要文件：`service.py`、`metadata.py`、`references.py`、`ports.py`、`api.py`；
- 组装调用方：`src/sciretriever/bootstrap/services.py` 与相关 graphs 在 Block 06 最终收口，本块先建立可注入合同；
- 测试：Analysis metadata/content/reference、storage adapters、content pipeline contracts；
- 受保护行为：ADR 0008 两阶段顺序、NoUsableContent、Markdown、ReferenceLookup 对齐和 Literature 接纳。

## 4. 需要保持的行为

- 第一次模型结果必须先通过 Analysis 验收，第二次才能运行；
- Provider 调用成功不能替代 Metadata/Markdown/ReferenceLookup schema 与来源证据检查；
- 后续阶段失败不撤销已经提交的有效事实；
- 原始 reference 文本和中间模型响应不持久化；
- 最终业务 provenance 的 provider/model/input hash 对齐继续验证。

## 5. Tasks

- [x] **ABC17 — 迁移正文两阶段调用。** Analysis controller 直接构造并执行第一、第二个 `AgentCall`，继续拥有 prompt、schema、阶段顺序和验收。
  - 验收：fake runtime 证明严格两次调用和短路顺序；源码无 `open_session(max_turns=1)`。

- [x] **ABC18 — 迁移 Metadata stage。** 从 stage 构造参数中移除 model 与 session/budget 透传，由 Runtime 的 Analysis role binding 选择 model。
  - 依赖：ABC17。
  - 验收：stage 只知道业务 input/schema/max output；provenance model 来自结果并与 Runtime binding 对齐。

- [x] **ABC19 — 迁移 ReferenceLookup stage。** 直接执行一次 Agent call，保留输入大小、source alignment、stable failure 和不持久化原始引用约束。
  - 依赖：ABC17。
  - 验收：空引用不调用模型；错位、无可执行 hint、结构错误和取消映射保持稳定。

- [x] **ABC20 — 保持 Analysis provenance。** 把 Provider-neutral 单次结果转换为现有 Analysis 业务 provenance，最终 Literature Content 只保存一项业务 provenance。
  - 依赖：ABC17–ABC19。
  - 验收：Provider wire 参数、Browser turn 和模型原文不进入业务 Model/Catalog。

- [x] **ABC21 — 完成 Analysis 无兼容层切换。** 删除 Analysis 对 `AgentSession`、`open_session`、history/turn 累积、model 透传，以及为它们存在的 Analysis wrapper、旧 provider alias、私有 Provider 实现和双路径测试；尚未到迁移块的 Browser/Configuration 遗留调用不在本块伪装删除。
  - 依赖：ABC17–ABC20。
  - 验收：Analysis 只从 `agents.api`/stable failures 导入模型能力，不导入 provider adapter、Session 或 Network transport；全库遗留清单只剩 ABC35/ABC47 已登记调用方，物理文件与兼容导出由 ABC51 删除。

- [x] **ABC22 — Analysis 回归测试闭环。** 覆盖两阶段顺序、取消、结构错误、provenance 不对齐、ReferenceLookup 和真实生产组装边界。
  - 依赖：ABC17–ABC21。
  - 验收：相关 Analysis、content pipeline 和 architecture tests 全部通过，Ruff/Pyright 无错误。

## 6. 执行方式与集成点

先逐条迁移正文、Metadata 和 ReferenceLookup 调用，再统一 provenance，最后在 ABC21 的一个切片中删除旧 Session/Provider/透传边界。迁移过程中每条调用链完成后运行其直接测试；不允许“新失败后重试旧 adapter”的双路径。

本块完成 I1：Block 02 的 Runtime 由真实 structured consumer 使用，Analysis 内部恢复单一生产路径；Browser 与 Configuration probe 的既有迁移窗口继续由 ABC35/ABC47 跟踪，不扩张为新调用方。

## 7. 审查门

- R1：Block 02 新 Runtime 直接测试通过，ABC15 的旧调用方清单仍准确；
- R2：每条 Analysis 调用审查阶段顺序、业务验收、错误映射、取消和 provenance，不以 Provider 成功替代业务成功；
- R3/I1：三条 Analysis 调用链与生产组装测试通过，Analysis 无 Session/旧 provider 双路径，持久 schema 不变；遗留全库调用只允许是 ABC35/ABC47 已登记范围；
- provenance 或数据合同 finding 为 blocking，不通过放宽校验处理。

## 8. 接口、数据与依赖影响

- Analysis 内部构造器从 `AgentPort + model + AgentBudget` 收敛为 `AgentRuntime` 与业务单次 max output；
- 保存的 Literature/Content/provenance schema 不变；
- 无数据库迁移、外部依赖或配置兼容层；
- Bootstrap 最终构造签名在 Block 06 同步。

## 9. 验证与证据

- `tests/test_analysis_content_proposal.py`；
- `tests/test_analysis_metadata_stage.py`；
- `tests/test_analysis_reference_lookup.py`；
- `tests/test_analysis_storage_adapters.py`；
- `tests/test_content_pipeline_contracts.py`；
- 相关 architecture/bootstrap tests 与 Ruff/Pyright 路径检查。

## 10. 退出条件

- ABC17–ABC22 全部勾选；
- Analysis 三条调用链无 Session/model/provider 泄漏；
- 直接测试证明业务顺序、验收、失败和 provenance 未回归；
- Block 06 可以用同一 Runtime 完成生产组装。

## 11. 完成证据

完成于 2026-08-26，证据如下：

- `AnalysisRequest` 只保留业务 `kind`、输入 hash 与单次输出上限；`AnalysisCall.to_agent_call()` 构造不含 Provider、model、Session 或 history 的 `AgentCall`。
- `AnalysisService`、`MetadataAnalysisStage` 与 `ReferenceLookupStage` 均直接调用同一个注入的 `AgentRuntime.execute()`；正文第一阶段未通过业务验收时不会执行第二次调用，空 reference tuple 的调用数为零。
- 最终 `LiteratureContentProposal` 仍只保存一项 Analysis 业务 provenance；provider/model 来自 Runtime 已校验的单次结果，两阶段身份不一致时拒绝形成 proposal；Model、Storage 与数据库 schema 未改变。
- 完整和 scoped Bootstrap 对象图均把同一个 Runtime 实例交给正文与 ReferenceLookup stage；Browser 与 Configuration probe 的迁移桥没有在本块提前删除。
- `tests/test_architecture_cutover.py` 新增负向边界，锁定 Analysis 只从 `sciretriever.agents.api` 取 Agents 类型、不含 `AgentSession`/`open_session`/`AgentRequest`/`AgentBudget`/`AgentPort`/`to_agent_request`，并证明剩余生产 `open_session` 导入仅位于 `acquisition/browser_control.py` 与 `bootstrap/probes.py`。
- 直接测试两组分别为 79 项与 90 项，均通过；扩大后的 Analysis/Agents/Bootstrap/architecture 回归共 223 项通过。
- 安装 wheel 的离线 `test_installed_database_completion` 与 `test_installed_citation_discovery` 共 2 项通过，迁移后的 acceptance helper 使用真实 `AgentRuntime` 加 fake Provider adapter，不访问外部系统。
- 目标 Ruff lint、Ruff format check、Pyright 均通过（`0 errors / 0 warnings`）；`git diff --check` 通过。
- R2 finding：两个 acceptance fake 的 Provider Port 参数名和一处旧 `structured_input` 读取未完成迁移，已改为新 `AgentProviderCall.text_parts` 合同并由 Pyright 与安装 wheel 旅程验证。
- R2 finding：原 architecture test 尚未防止 Analysis 重新引入 Session/model 透传，已补充 AST/token 负向检查并通过 16 项 architecture tests。
- R3/I1 无未关闭 finding。剩余 Session/旧调用桥仅服务 ABC35（Browser controller）与 ABC47（Configuration probe），物理兼容文件及导出仍由 ABC51 统一删除。

## 12. 失败与恢复

- 若业务验收依赖旧 Provider 原始结构，先在 Agent result/Analysis boundary 明确中性事实，不能导回 vendor response；
- 若 provenance 无法对齐，停止写入，不通过放宽校验维持通过；
- 恢复到最近通过的 stage 切片，保持 Block 02 Runtime 公共合同不变。

## 13. 下游交接

Block 06 获得一个已经由真实 Analysis 消费验证的 Agents Runtime；Block 07 可以删除旧 Analysis provider/config/test 符号，不需要保留迁移桥。
