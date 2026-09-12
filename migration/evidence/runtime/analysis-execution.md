# Analysis 两阶段执行与模型协议

> 本文件中的 Python bridge 描述和早期测试统计是迁移期历史证据。当前生产 Analysis 由 TypeScript
> `AnalysisService`、`AgentRuntime` 和三种协议 adapter 直接组装；不启动 Python 子进程。当前结果以
> `migration/evidence/runtime/analysis-typescript.md` 和最新 `pnpm full` 为准。

2026-09-10。阶段 05-03/05-05 的执行切片，衔接正式 ParserResult 与 Literature 内容接纳。

## 实际路径

`createApplication(home, {configurationOwner: runtime, analysisRuntime: runtime})` 从实际配置 owner 的
projection 读取 analysis 模型及七项预算，组装 `app.analysis`；缺失配置拒绝并清理已打开资源。
未显式选择 runtime 时该服务为 null，启动组装不请求模型。

`analyzeContent(literatureId, signal?)` 经 Literature Detail/Artifact Port 取得当前主 PDF、ParserResult、
metadata revision/hash 和经 hash 验证的 Parser Markdown。Python `entry.analysis_bridge` 执行现有
AnalysisService，两阶段保留 metadata 保护、正文与原文对齐、canonical Markdown renderer、Proposal
hash/lineage/provenance 语义。Python 不打开 catalog、不加载配置/凭据，也不构造 HTTP client。

父进程只接受三种有限 RPC：核对当前输入、执行 TS AgentRuntime、发布 Markdown。每阶段模型请求的
输入 JSON hash、角色、schema、token 预算和次数都校验；当前事实检查绑定初始 PDF/Parser/metadata。
Markdown 通过 TS FileStore 不可变发布；最终 Proposal 必须匹配全部初始身份字段和真实 Markdown hash。
服务返回 `{outcome: "proposal", proposal, markdownBytes}`，由调用方交给 Literature owner 接纳。
`{outcome: "no_usable_content", input}` 是独立业务结果，input 为六项闭合分析输入身份，普通失败不能伪装成该结果。

子进程默认总期限 180 秒，最多一小时；消息 64 MiB、总输出 96 MiB、16 次 RPC、最多两次模型调用。
输入/单块及最终 Markdown 分别限制为 16 MiB；每阶段输出 token 最多 131072。
关闭、超时和取消终止子进程及正在等待的模型调用，并等待子进程关闭。失败保留正式 PDF、ParserResult
和既有内容；已经发布而未接纳的文件保持不可变，可能作为未登记对象留待后续对账。

每个模型调用的 parameters hash 使用 `sciretriever-ts-analysis-call-parameters-v1` manifest，包含
role/provider/model/reasoning/stream、max_output_tokens 与 response_schema。它提供确定的 TS 调用参数
证据，不宣称等同于 Python vendor wire 参数 hash；最终 Analysis provenance 沿用现有组合规则。

## 模型协议修复

实际 Analysis 的 nullable metadata schema 暴露了此前协议实现的问题。已修正：

- Chat 使用 `max_completion_tokens`、`response_format.json_schema`、function 工具包装和 image_url。
- Responses 使用 input_text/output_text/input_image、`text.format`、平铺 function 工具和输出 token 预算。
- Anthropic 使用独立 system、base64 image source、`output_config.format`、input_schema 工具、x-api-key
  和 anthropic-version；reasoning effort 与 structured format 同时保留。
- Chat 的原生 prompt_tokens/completion_tokens 转换为中性 usage；普通分片 `usage: null` 合法，
  最终 usage 必须在完成 choice 后。拒绝结束后继续输出、重复结束和未知 finish reason。
- Responses 完成事件不要求额外 DONE，但仍拒绝重复终态、DONE 后数据或缺失终态。
- Schema 支持有限深度的 anyOf/null；对象必须闭合，标量不要求 additionalProperties；返回值同时校验
  anyOf 和 enum，不能借联合类型绕过约束。

## 直接证据

迁移期 `analysis-service.test.ts` 七项测试使用实际 Application、SQLite、FileStore、PDF inspector、Python Parsing
规则、Python AnalysisService、TS AgentRuntime 和 Chat adapter；当前同等行为由 TypeScript 测试直接覆盖，只有
解析输出、模型 HTTP 响应为合成 fixture。
验证配置驱动组装/拒绝、真实两阶段产出与 Literature 接纳/FTS、metadata 保护失败、正文失败、无可用内容、
分析期间 Parser 被替换、请求预算不足和关闭取消。成功 fixture 的参考文献确实存在于 Parser Markdown，
没有降低正文来源对齐规则。

`agent-wire.test.ts` 八项测试核对三种协议的实际请求体、鉴权、图片、工具、nullable schema、拒绝不匹配
响应，以及 Chat 原生 usage 和无 DONE 的 Responses。既有 Chat/Responses/Anthropic adapter 测试联合通过。
未调用真实 LLM、Provider、MinerU 或用户数据；未新增依赖、v1 schema 或切换生产入口。

## 剩余范围

Entry 的 [analyze → accept 入口](content-analysis-entry.md)、[NoUsableContent 精确业务清理](no-usable-content-entry.md)
和[Browser Candidate → 实际 MinerU → Analysis 联合旅程](browser-mineru-analysis-journey.md)均已组装。
[配置 loopback 模型 transport](model-loopback.md)补充了实际两次 HTTP 模型调用到内容接纳的测试；最初七项测试
继续用 fake transport 隔离外部模型。阶段 05-05 的 source-checkout 首阶段边界已经完成，真实 LLM/MinerU 效果
和安装包自含运行依赖明确 Deferred。

## 本次全量验收

`SCIRETRIEVER_CLOAK_BUNDLE=/home/duanjw/.sciretriever/cloakbrowser-cache/chromium-146.0.7680.177.5 pnpm full`
通过：69 个测试文件、258 项测试，含实际 Cloak 工作台、配置 owner、离线包安装与本次 Analysis。
Quick、源码/测试 strict 类型检查和 build 均通过；日志 `/tmp/sciretriever-analysis-full.log`。
新增 Python bridge 单文件 Ruff lint/format 通过；未运行 Python Quick/Full/unittest。
`git diff --check` 通过；无 commit/push/PR、凭据或真实数据操作。
