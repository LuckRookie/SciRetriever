# 01 运行时与模型传输

状态：Completed（实现与定向/Quick 已验证；最终集成 Full 和现场对照由 04 收口）。上级：[计划控制面](README.md)。Owner 已批准实施。

## Outcome

在当前 Node 22.19.0 进程内启动一个只挂所需服务的真实 DSH/Cordis runtime。外部消费方通过 SciRetriever 中性能力/session 合同发起、继续和取消执行；DSH 私有 adapter 使用现有模型选择、凭据解析与 Network，能够往返保留 assistant 文本、tool-call identity、多工具调用、工具结果及 usage。普通和压缩请求均有准确文章归属与真实派发计量。既有 Analysis 单次处理与已导出的 Agent 合同保持兼容。

## 进入条件

- Owner 已批准提案的实施范围，含最小依赖安装与必要锁文件修改；不从 DSH 选型本身推导这些授权。
- ADR 0031、接入提案与本计划对 Agents/Browser 责任一致；若仍有冲突，由文档 owner 先澄清。
- 本机只使用现有 workspace 及系统临时合成 home；本块所有模型响应为 fake/loopback，不需要真实 Provider 或个人配置。

## 责任边界

主要修改位置是 `apps/server/src/agents/`、拟新增私有 `agents/dsh/`、现有三个协议 adapter 及直接测试；`bootstrap/application.ts` 提供当前配置/transport 接口证据，生产接线在 03 收口。`agents/dsh/README.md` 应说明 vendor 隔离与上级分工。

DSH 拥有通用会话与循环；Agents 拥有中性模型和能力边界、配置绑定与错误转换；Network 拥有 URL/凭据目标、共享 permit、发送与取消。新协议不进入 `packages/contracts`，不成为持久化文献 schema。`apps/server/src/index.ts` 已公开导出 `AgentCall`、`AgentMessage`、`AgentResult`、`AgentRuntime`，必须将它们视为受支持合同审查。

## Tasks

- [x] **1.1 固定基线、依赖与验证范围。** 记录 HEAD、现有目标文件 diff、Node/pnpm 版本和当前直接测试入口；检查本轮之外的用户修改并保留。在实现变更前为 4.3 保留原实现的可执行构建及对应源码清单/hash、精确 patch 与非秘密配置投影，基线产物只放 sandbox；需要构建时使用现有 `pnpm build`，不从历史报告猜测源码版本。核验调查版本对应的实际 npm 包、peer/传递依赖、exports、许可证与 Node 要求，列出唯一拟安装集合及统一版本。输出本块中的非秘密依赖说明、确切版本与基线定位；验收为每个包都有所需服务理由，发布包与源码证据可对应，未把 `pi-ai` 模型插件或完整应用 profile 当成必要接入条件。依赖与版本未核实时不得开始 1.2。
- [x] **1.2 建立最小私有运行时。** 在 `agents/dsh/` 组合 `LlmRuntime`、`SessionStore`、`SessionProjectionRegistry`、`SystemPrompt`、`ToolRuntime`、`AgentRegistry`、`AgentLoop`，按压缩需要加入 TokenMeter/compaction，按图片需要注入 AttachmentStore 实现。锁定必要依赖，使用项目现有生命周期组装方式，记录 npm 依赖集合与实际挂载插件集合的区别。初次 smoke 使用显式合成 LLM adapter；正式共享 wire 在 1.4 接入，1.7 才验证完整组合，不能把本项当成生产模型链路已通过。输出可构建的私有 runtime 工厂及正常/异常关闭测试；验收为创建 scope、执行一个工具、结束 turn 和释放 scope 均经过真实 DSH，未启动 home/settings、默认 Browser、shell、CLI、ACP、MCP、遥测、代理或额外自动 retry 服务。
- [x] **1.3 定义中性能力与完整模型协议。** 先列出生产者、消费者、导出及序列化影响，再在 Agents 内定义中性 session 句柄、输入/事件/终止结果、取消域、调用关联和模型 turn/request/result。完整协议至少保留 assistant 文本、稳定 call ID、工具名和参数、对应结果的成功/失败/拒绝/取消状态、图片引用及 usage；允许准确表达多工具同批返回，Browser 是否执行由 2.3 限制。公开 `AgentRuntime.execute(AgentCall)` 继续保持单次结构化/单工具兼容语义；使用内部通用协议和明确转换，避免直接拓宽已导出 union 使调用方穷尽检查失效。输出类型、验证器、转换图与合同测试；验收为无 vendor 类型外泄、Analysis 无需 session、缺失/重复 call ID 和悬空结果明确拒绝或按已定义规则关联，而非静默丢弃。
- [x] **1.4 贯通三个现有模型 wire。** 依赖 1.3，在 OpenAI Responses、Chat Completions、Anthropic Messages 中实现完整 request/result 的双向映射，共享当前 `agents/common.ts` 的凭据与传输路径。工具调用和结果必须保留对应 ID、顺序与必要协议字段，兼容图像、普通文本结束、压缩文本结果、流式与非流式终止、usage/错误。核实当前 transport 返回有界完整 body 与 DSH `stream()` 事件的适配语义，不能声称已逐 token 交付；保留现有流完整性检查与响应大小约束。输出共享 wire 实现、DSH `LlmAdapter` 及三协议 fixture；验收为完整工具往返、多工具但 Browser 只准一个动作、空结果、截断流、模型不匹配、非法工具参数和拒绝均有真实边界断言，旧 Analysis 严格结果校验仍有效。
- [x] **1.5 逐真实请求计量并关联文章。** 依赖 1.3–1.4，保留现有 `AgentCallLifecycle.onDispatched` 在单次调用中只触发一次的兼容语义，在 Agents 内另建 DSH 逐真实 request 生命周期；不能把整个 turn 传给一个只允许 dispatch 一次的旧 Browser decision 对象，也不能把原 callback 改为重复触发。每次普通推理、压缩及已允许的实际请求都绑定 operation、文章 session、request identity 与用途；Network 获取 permit 后、真实发送前做当前执行资格/取消/预算复检并计数，结束时结清活跃区间。压缩直接进入 LLM service 也经过同一 adapter，不能只在普通 loop hook 计量。输出生命周期接点与离线 Network 测试；验收为排队取消/预算拒绝零发送零计数，发送后失败计一次，两次请求计两次，压缩加普通推理计两次并归属同一篇，A/B 并发无全局可变“当前文章”。不得通过为每个 turn 重置计数恢复可用预算。
- [x] **1.6 保留模型绑定与 Analysis 无状态兼容。** 依赖 1.4–1.5，复用 `buildAgentBindings()` 的 provider/API、model、reasoning、stream、capabilities、credentialProvider 与 Network 原则；在中性入口注入绑定而非把模型名写入 DSH profile。用合成配置证明 `qiuzk/gpt-6-luna` 与 `max` 原样映射到所选协议，同时证明其它已支持模型不被拒绝。保留配置 probe、缺凭据/能力错误、Analysis 输入 hash、有限单次结构化结果与 provenance；不为 Analysis 自动增加会话、压缩或工具。输出兼容测试及导出变化清单（预期无破坏）；验收为分析服务和配置测试通过，不读取真实凭据、不新增配置字段或隐藏 fallback。
- [x] **1.7 验证真实 DSH 循环与隔离。** 依赖 1.2–1.6，用真实插件、session 与 `LlmAdapter`，只 fake 外部响应：完成“模型工具调用→宿主工具结果→下一模型输入→最终结果”，再触发一次压缩；核对完整历史、模型可见投影、调用/usage 和结束状态。并发运行 A/B，取消 A，确认 B 继续、A 迟到请求被拒绝；用合成 home/settings/环境值证明不自动读取资源或发送旁路请求。输出运行证据与定向结果；验收为压缩和普通请求都命中既有 transport，应用关闭没有悬挂 scope、listener 或 request，DSH 本体没有被 mock。

## 集成与影响

01 给 02 提供可测试的中性 session/模型合同和实际请求生命周期；给 03 提供配置绑定、共享 runtime 工厂与关闭入口。内部完整协议与公开单次入口应共享一次 wire 实现，不能维护两套逐渐漂移的认证、SSE 解析或错误语义。

本块允许在已批准范围内改变内部 TypeScript API；公共导出、个人配置、catalog、资产路径和发布格式预期不变。若确认新能力需要公共导出，先说明调用方与兼容影响并同步方案，不能临时把 DSH 类型导出以绕过边界。

## 验证

现有直接入口（根据实现影响增补具体断言，不弱化原测试）：

```bash
pnpm exec vitest run apps/server/test/agent-runtime.test.ts apps/server/test/agent-wire.test.ts apps/server/test/agent-network-transport.test.ts
pnpm exec vitest run apps/server/test/analysis-service.test.ts apps/server/test/knowledge-analysis.test.ts apps/server/test/configuration-probe-journey.test.ts
pnpm quick
```

拟新增 `apps/server/test/dsh-runtime.test.ts`、`dsh-model-transport.test.ts`，由 1.2/1.4–1.7 建立后运行：

```bash
pnpm exec vitest run apps/server/test/dsh-runtime.test.ts apps/server/test/dsh-model-transport.test.ts
```

必须直接断言运行的是发布包的真实循环和压缩实现，所有外部出站均由 fake/loopback 隔离。此处不证明真实 `qiuzk` 服务兼容、缓存收益、Browser 效果或生产对象图已接入；这些分别由后续块收口。

## 退出条件

1.1–1.7 有对应 patch、命令、通过结果和残余风险；旧公开 Analysis 行为兼容，真实 DSH 多轮与压缩历史通过，共享 Network 逐请求计量和独立取消域通过。所有必要版本和许可证说明有据可查，01 的 Quick 通过，02 可使用稳定中性合同，无需自行维护 DSH wire 或第二个模型 transport。

## 恢复与交接

失败时保留目标 diff、锁文件变化说明、合成响应与测试日志定位；不修改真实配置、重置工作树或升级无关依赖。版本/插件组合失败回到 1.1/1.2；工具历史映射失败回到 1.3/1.4；计量或归属失败停在 1.5，不让 02 绕过 Network 继续接线。

交接给 02/03 的是中性类型与生命周期、已验证插件/版本、准确命令及未覆盖限制。不能把私有 factory 的单测成功写成 Browser 已交付。2026-10-13 实施记录：

- 已固定起始工作树、源码 hash 与可执行构建：`sandbox/runs/dsh-agent-backend-baseline-2026-10-13/`。基线构建通过；此前四文件 143 项直接测试通过。Node `22.19.0`、pnpm `10.32.1`。
- 锁定 Cordis `4.0.5-alpha.1` 与 DSH `0.2.1-alpha.2`，14 个直接组件包，required peer 闭包共 32 包、全为 MIT；依赖理由见 [DSH 外部说明](../../notes/deepseek-harness.md)。安装成功。
- `agents/model-protocol.ts` 保留完整工具 ID/结果与 adapter 私有 replay；既有公开 `execute` 继续单次严格语义。模型与协议直接测试已通过，包括三种 wire 的流/非流、多工具、拒绝、continuation 与原 Analysis 路径。
- `dsh-runtime.test.ts` + `dsh-runtime-network.test.ts` 已有 13 项通过：真实发布包循环、附件、压缩、A/B 取消、创建/关闭竞争、实际工具成功与取消区别、Network 逐请求计量；正在补充自动压缩失败后恢复及最终全量验收。
- `portable-package.test.ts`、`package-entrypoints.test.ts` 共 2 项通过，证明递归 required peer 后仍可空缓存离线安装/启动；首次集成 Quick 的剩余错误位于并行开发中的新 Browser 测试，未把中间轮次称为最终通过。

[下一结果块](02-browser-session-and-tools.md) · [计划控制面](README.md)

最终定向补证：模型历史 27 项；模型、三种协议、DSH/Network 合并 9 文件 78 项通过。修复并验证自动压缩错误恢复、跨轮重复工具 ID 零第二次执行、Responses/Anthropic 原生交错块准确重放。DSH 两文件最终 15 项通过。`quick-frozen.log` 已通过；最终 Full 见 04。
