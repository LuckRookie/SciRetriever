# Block 4：Analysis、Runtime 与反馈

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed（2026-09-03） |
| Task 范围 | `AGT01`-`AGT08` |
| 前置块 | Block 1 Completed；Block 3 Completed 后开始集成 |
| 下游块 | Block 5 |
| 恢复点 | 最后一个通过 Agents/Analysis/Entry 直接测试的 failure 或 feedback slice |

## 块结果

共享 Runtime 按实际 role 报告 Provider/Model，拥有清晰且不重复的 size/token/internal failure 边界；Analysis 在 metadata/content 两阶段保留取消和 Provider 稳定失败，不再把所有问题压成 generic LLM failure。用户从 Report 和正常日志可以看出失败发生在哪个阶段、使用哪个 Provider/Model、是否可重试，以及下一步应该做什么。

## 进入条件

- Block 1 已冻结稳定 failure 分层，Block 3 已确定 Browser 如何消费共享 Agent failure；
- ADR 0019 的 SDK/PydanticAI migration 明确不在本块实施；
- `agents/`、`analysis/`、`bootstrap/services.py` 与相关技术文档的用户 baseline diff 已审查；
- Report/Logging owner 已核实，不能通过解析日志形成 interrupted 或 failure；
- 测试只使用 fake adapter/fixture，不调用真实模型、模型目录或用户 credential。

## 责任与改动面

Primary owner 负责：

- `src/sciretriever/agents/runtime.py`、`agents/ports.py`、`agents/failures.py` 与必要 adapter boundary 的 role identity、limits 和异常转换；
- `src/sciretriever/analysis/metadata.py`、`analysis/service.py`、`analysis/content.py`、`analysis/references.py` 的取消/failure/stage 语义；
- `src/sciretriever/bootstrap/services.py` 的 Analyze/Browser role binding/adapter 组装；
- Agents、Analysis、Entry completion、Bootstrap 与 logging transcript 直接测试；
- 相关 technical/current behavior 文档的候选改动，最终统一在 Block 5 完成。

Agents 只形成单次调用结果/失败；Analysis 拥有两阶段与业务验收；Entry 从 typed failure/result 形成 Report/interrupted，不读取 LogRecord。

## 需要保持的行为

- Analysis 仍严格执行 metadata -> content；metadata 失败时不调用 content，content 失败时不发布部分结果；
- stale input、publication 前复核、规范 Markdown、References、NoUsableContent、当前内容原子替换和成功 provenance 不变；
- `AgentRuntime.execute` 仍是唯一中性 façade，不向消费者暴露 HTTP、SDK、Provider response 或 vendor exception；
- 不增加自动 retry、repair、fallback model、session history 或 reasoning 原文；
- Analyze 与 Browser 可选择同一或不同 Provider；同 Provider 继续复用 adapter/quota scope，不同 Provider 精确使用各自 origin-bound credential；
- stream、reasoning、structured/tool/image capability 与配置选择保持现有合同；
- prompt、schema 正文、模型原文、文献正文、图片、tool arguments、secret 和完整 endpoint 不进入日志/Report。

## Tasks

- [x] **AGT01 — 让 Runtime identity 按 role 解析。** 用 role-aware binding descriptor 或等价窄接口替换无参数 `provider_name`；日志和 controller 从实际 Analyze/Browser binding 取得 provider、wire model、stream 和 reasoning，而不是默认读取 Analysis adapter。
  - 依赖：Block 1 failure/role 合同。
  - 验收：Analyze 与 Browser 配置不同 Provider/Model 时，各自测试 transcript 和 failure provenance 显示正确值；unbound role 稳定报告 readiness failure。
- [x] **AGT02 — 收敛 limits 与 context 责任。** Runtime 只对中性、可客观计算的 output token、prompt/schema/request/image byte/count/capability 限制做 preflight；不得把 input/image bytes 当 token。Provider adapter 只拥有 wire 编码/响应边界和可信 usage，重复或矛盾检查删除。
  - 依赖：AGT01。
  - 验收：byte limits 与 token limits 使用不同单位和测试；没有 tokenizer/官方 token count 时不伪造精确 context preflight，Provider context rejection 仍归一为稳定 failure；post-usage 超限只检查可信 token usage。
- [x] **AGT03 — 建立统一 internal exception boundary。** `AgentRuntime` 捕获 adapter 未声明的实现异常并转换为 non-retryable `agent-internal`，同时保留 `KeyboardInterrupt/SystemExit` 等非业务控制语义；已归一的 `AgentFailure` 不重复包装。
  - 依赖：AGT02。
  - 验收：未知 adapter exception 不逃逸为 traceback、不被标成 retryable Provider failure；failure 不包含异常正文、request body、credential 或 endpoint。
- [x] **AGT04 — 决定 response model identity 策略。** 对 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 建立离线 identity fixture；只有任务范围内的可靠证据支持时才把 exact equality 改为受控 normalization/accepted identity，否则按计划 fallback 保持严格相等并记录外部调研残余风险。
  - 依赖：AGT01。
  - 验收：每种协议的严格选择由 fixture 保护并写入完成证据；未授权的外部 alias/SDK 语义不作事实声明；绝不接受任意不同 model 或按字符串前缀猜测。
- [x] **AGT05 — 保留 Analysis cancellation。** metadata、content 以及 metadata 作为 content operation 第一阶段时遇到 `agent-cancelled`，统一映射为 `analysis-content-cancelled`，Entry 最终 disposition 为 interrupted。
  - 依赖：AGT03。
  - 验收：三个取消时点均不调用后续阶段、不发布内容、不变成 failed/action-required；Report 保留取消 code，进程退出语义与其它用户取消一致。
- [x] **AGT06 — 分离 Provider failure 与 Analysis failure。** authentication、permission、quota/rate、timeout/transport、model、refusal/truncation 等稳定 `agent-*` 原样进入 Report；Analysis 只为自己的 input、structure/schema、metadata/content validation、stale、render 和 publication 形成 `analysis-*`。本地未知异常使用 non-retryable internal code，不冒充 Provider failure。
  - 依赖：AGT03、AGT05。
  - 验收：failure mapping 表与单元测试一一对应；`retryable` 不因跨层包装改变；原 `analysis-metadata-llm`、`analysis-content-metadata-stage`、`analysis-content-llm` 不再吞掉稳定 Provider 原因。
- [x] **AGT07 — 建立阶段与调用反馈 owner。** 正常日志显示 Analysis metadata/content/stale/publication 阶段，以及每次真实 Agent call 的 role/provider/wire model/result/usage/latency；Browser 显示 action kind/settle/semantic outcome。每项事实只有一个 INFO owner，Runtime/adapter 的 protocol/revision/fingerprint 细节留在 Debug。
  - 依赖：AGT01、AGT05、AGT06；消费 Block 3 Browser result。
  - 验收：Analysis 成功/取消/Provider failure 和 Browser 多 action transcript 可扫读、无重复 summary；Report 不依赖日志；禁止内容在 INFO/Debug 均不出现。
- [x] **AGT08 — 完成 Runtime/Analysis/Entry 回归。** 覆盖双 Provider role、unbound、limits 单位、unexpected exception、model identity、metadata/content cancellation、Provider failure family、local validation/internal failure、stale/publication 和日志脱敏。
  - 依赖：AGT01-AGT07。
  - 验收：直接测试断言实际 Provider/Model、stage、code/retryable、调用次数、publication 计数与 Entry disposition；不只匹配日志自然语言。

## 执行方式与集成点

按 AGT01 -> AGT02/03 -> AGT04 -> AGT05/06 -> AGT07 -> AGT08 串行。先修 Runtime 边界，再让 Analysis 移除 generic wrapping；否则会把 adapter 异常直接泄漏到业务层。

### Failure mapping 原则

| 原因 owner | 目标例子 | Analysis 处理 |
| --- | --- | --- |
| 用户取消 | `agent-cancelled` | `analysis-content-cancelled`，最终 interrupted |
| Provider/Network/Runtime | authentication、quota、timeout、model、refusal、`agent-internal` | 保留稳定 `agent-*` code/reason/action/retryable，Report 已有 `stage=analysis` |
| Analysis input/contract | 输入构造、metadata/content schema、result alignment | 使用具体 `analysis-*`，non-retryable 除非合同另有证据 |
| Analysis publication | stale、render、Storage/publication | 使用具体 `analysis-*`，不归因 Provider |
| 未知 Analysis 本地异常 | controller/validator bug | non-retryable internal failure；Debug 仅安全定位，不泄漏原异常正文 |

如果现有 Entry 只能通过 `analysis-*` 前缀识别 stage，不得因此复制 Provider taxonomy；应修正 typed stage/disposition 映射，让 failure code 保持原因 owner。

### Limits 原则

- bytes/count 限制保护内存、请求和安全边界；tokens 限制保护模型 context/output；二者不可相加或比较；
- `max_output_tokens` 可以在调用前与 binding/model token caps 比较；
- input tokens 只有在存在协议/model 可信 tokenizer 或 Provider usage 时才是 token 事实；UTF-8 byte count 不是 token count；
- Runtime 与 adapter 不能对同一事实使用不同算法各判一次；谁能产生权威事实，谁拥有检查与 stable failure 转换；
- 取消和 quota/timeout 不能通过 retry、stream mode 切换或 fallback model 绕过。

### 日志分层

| 层级 | 内容 |
| --- | --- |
| Report | target、stage、准确 code/reason/action/retryable、interrupted/failed 结果 |
| INFO | Analysis 子阶段、role/provider/model、result/usage/latency；Browser action/settle/page-state/challenge cleared/终态 |
| Debug | revision、surface/element counts、semantic/intent fingerprint、transition/capture evidence、protocol/stream 安全字段 |
| Provenance | 仅成功 Analysis 的 provider/model/hashes/usage 与既有 PDF acquisition lineage |

## 审查门

- R1：双 role 生产组装、failure/Report owner、用户 baseline diff 已核实；
- R2/AGT02：bytes/tokens 不混用，删除重复检查没有削弱客观 byte/response/capability 边界；
- R2/AGT03：只在 adapter/Runtime 边界归一 unknown exception，不吞控制异常或已归一 failure；
- R2/AGT04：model identity 每种协议有官方/fixture 证据，不能为某个兼容站点全局放宽；
- R2/AGT05-06：取消、Provider failure、Analysis validation 和 internal failure owner 清晰；
- R2/AGT07：INFO 不重复，Debug/Report/Provenance 不越界；
- R3：Agents、Analysis、Entry 与 logging transcript 直接测试通过。

若修复需要迁移 PydanticAI/SDK、增加 tokenizer 依赖、改变配置 schema 或把 Provider failure 重新复制成一套 Analysis taxonomy，停止并更新计划/独立决策。

## 接口 / 数据 / 依赖影响

- 接口：Runtime 的 provider/model identity 查询变为 role-aware；私有 failure mapping 和 limits owner 调整；
- 数据：成功 Analysis provenance schema 预期不变；失败/cancel/history 不持久化；
- 配置：Model、Analyze、Browser 选择和 reasoning/stream 字段不变；
- 依赖：无新增依赖；SDK/tokenizer 不在本计划引入；
- Report：结构预期不变，code/disposition 保真度提高；
- 日志：event/level/字段与 owner 调整，必须同步 transcript 和 technical docs。

## 验证与证据

进入 Task 后按实际测试模块校准，至少执行：

```bash
uv run --frozen python -m unittest \
  tests.test_agents \
  tests.test_agents_contracts \
  tests.test_agents_providers
uv run --frozen python -m unittest \
  tests.test_analysis_metadata_stage \
  tests.test_analysis_content_proposal \
  tests.test_analysis_reference_lookup \
  tests.test_entry_completion
uv run --frozen python -m unittest \
  tests.test_browser_agent_control \
  tests.test_browser_agent_integration \
  tests.test_logging_presentation \
  tests.test_logging_foundation
uv run --frozen ruff check \
  src/sciretriever/agents \
  src/sciretriever/analysis \
  src/sciretriever/bootstrap/services.py \
  tests/test_agents.py \
  tests/test_analysis_metadata_stage.py \
  tests/test_analysis_content_proposal.py
uv run --frozen ruff format --check \
  src/sciretriever/agents \
  src/sciretriever/analysis
```

model identity 的协议证据需记录来源和 fixture 意义，但测试不得发真实请求或保存 vendor 响应中的敏感/不稳定内容。

## 退出条件

- AGT01-AGT08 全部完成；
- 双 role identity、limits 单位、unexpected exception、model identity 选择有直接证据；
- metadata/content cancellation 最终 interrupted，Provider/Analysis/internal failure owner 清晰；
- INFO/Debug/Report/Provenance 层次一致且安全；
- 相关测试与 Ruff 通过，不改变成功 Analysis 数据合同或引入 SDK/依赖。

## 完成证据

- `AgentRuntime.identity(role)` 按 Analyze/Browser binding 返回实际 Provider、wire model、reasoning 与 stream；双 Provider 与 unbound 场景已有直接测试。
- Runtime 只预检可客观计算的 byte/count/capability 与 output token 边界；input/image UTF-8 bytes 不再被猜成 tokens，adapter 的重复预算判断已删除，可信 response usage 仍在 Runtime 验证。
- adapter 未声明异常统一成为 non-retryable `agent-internal`，已归一 `AgentFailure` 保留；Analysis 自有未知异常成为 non-retryable `analysis-internal`。
- metadata/content 调用取消统一成为 `analysis-content-cancelled`，Entry disposition 为 interrupted；稳定 authentication/quota/timeout/model/refusal 等 `agent-*` code 和 retryable 原样到达 Report，第二阶段或发布失败不发布部分结果。
- INFO 由 Runtime/Analysis/Browser 各自拥有 call、stage、action/settle 与终态；protocol、revision、fingerprint 和 transition evidence 留在 Debug，transcript 脱敏测试通过。
- Agents/Analysis/Bootstrap/Logging/Configuration/installed acceptance 相关集共 247 项通过。
- AGT04 采用计划规定的保守 fallback：本任务没有执行真实外部请求或额外官方 SDK/alias 调研，OpenAI Responses、Chat Completions 与 Anthropic fixture 继续验证 response model 必须与请求 model 严格相等；未依据别名或前缀猜测放宽。真实 Provider 的 alias/snapshot 语义仍是后续经授权调研的残余风险。

## 失败与恢复

若 exact model identity 无法从官方合同确认，保持现有严格行为并记录残余风险，不以兼容性猜测放宽。若 Entry 不能保留 `agent-*` 而需要公共 Report 结构变化，停止在直接测试反例并返回 requirements/architecture 影响分析。恢复从最后通过的 Runtime boundary 或 Analysis stage slice 继续，不恢复 generic catch-all。

## 下游交接

Block 5 可以依赖：Analyze/Browser role identity 正确，稳定 Agent failure 只在 owner 边界转换，Analysis cancellation 可被 Entry 识别，正常/Debug 反馈和脱敏合同已经由直接测试证明。
