# Agent 调用与加工任务

SciRetriever 提供 MCP stdio，以及同语义的 TypeScript 和 CLI 操作。
从源码构建后启动只读 MCP：

```bash
pnpm build
node apps/server/dist/cli/main.js mcp
```

需要代用户提交明确的维护工作时，启动 `mcp --maintenance`。MCP 客户端配置中的 command 使用
`node`，args 使用安装副本中 `apps/server/dist/cli/main.js` 的绝对路径、`mcp` 和可选的
`--maintenance`。普通配置仍由唯一的 `~/.sciretriever/` owner 管理，命令不接受另一个配置路径。
stdout 专用于 MCP JSON-RPC，诊断写 stderr。查询模式不会启动维护 Application、Browser 或模型。

## 工具与流程

| 工具 | 行为 |
| --- | --- |
| `status`、`search_library`、`read_literature` | 本地 readiness、库内查询和详情；缺口不扩库 |
| `document_read` | default/describe/outline/segments/slice/resources/resource/evidence/material；使用[固定文档读取合同](library-query.md) |
| `prepare_analysis_inputs` | 从明确 Literature ID 固定已有材料和默认文档，返回 InputManifest 与元数据身份快照 |
| `prepare_synthesis` | 按现有 SynthesisPreparationRequest 固定集合输入；不调用模型 |
| `read_knowledge`、`search_context` | 读取已有单篇/集合知识和检索上下文 |
| `read_task`、`read_article_identity` | 读取执行结果引用、失败和已保存的身份判断 |
| `submit_processing` | 显式加工已有材料，返回持久任务 ID；使用工具声明的封闭请求 schema |
| `acquire_pdf` | 明确 Literature ID 的 PDF 获取，复用 Public/API/Browser 流程 |
| `discover_metadata` | 有界主题发现，只接纳元数据，不下载 PDF |
| `control_task` | run/pause/cancel/resume/retry；保留完成结果 |

读取和准备输入的工具无需维护模式。`submit_processing`、`acquire_pdf`、`discover_metadata`、
`control_task` 只在 `--maintenance` 下声明；Agent 只应执行用户已明确启动的任务。
响应包含 `protocol_version:1` 和 `result`；MCP 的 `isError` 表示操作调用失败。任务 accepted/queued
不是 PDF 或知识产物完成，须读取任务目标及结果引用。所有异常只返回稳定 code，不回显原始异常或请求。

推荐顺序：查询/发现 → 明确获取 PDF → 解析 → 读取固定文档/准备 InputManifest → 分析或身份核验 → 读取产物。
每一步都可以独立使用；解析、分析、身份核验不会为了补输入而暗中下载。

## CLI 与 TypeScript 任务

```bash
pnpm sciretriever jobs submit --request /absolute/path/request.json --json
pnpm sciretriever jobs run JOB_ID --json
pnpm sciretriever jobs show JOB_ID --json
pnpm sciretriever jobs pause JOB_ID --json
pnpm sciretriever jobs resume JOB_ID --json
pnpm sciretriever jobs retry JOB_ID --json
```

CLI submit 只保存任务；resume/retry 调整为可执行，随后显式 run。MCP submit 和 run/resume/retry 会在服务
进程内启动任务，调用方通过 read_task 查看。服务退出后不会继续运行；重新启动后显式恢复。
同一 catalog 同时由一个执行 runtime 持锁；同一 Application 的新旧任务共享该锁，
直接调用 `taskService.runJob` 或 `queue.runNext/runUntilIdle` 也会持锁，防止其它 Application 误恢复活任务。
加工调度使用 `execution.max_concurrency`（默认 4）：后台 `start()` 超额时排队；
前台 `run()/runResults()` 超额返回 `processing-capacity`，不会留下后台执行请求。已取消的调用不会启动任务。
另一个进程抢跑时返回或记录 `processing-runtime-owned`，不改变原运行任务；待原 runtime 结束后显式 run。

请求形状：

```json
{
  "schema_version": 1,
  "idempotency_key": "my-paper-parse-1",
  "operations": [{
    "operation": "parse-documents",
    "request": {
      "literature_id": "返回的 Literature UUID",
      "asset_id": "返回的主 PDF UUID",
      "asset_sha256": "返回的 SHA-256",
      "mode": "reparse",
      "expected_default_revision": null
    }
  }]
}
```

以上占位值必须替换为真实读取结果。同一请求最多 100 项、1 MiB；操作还各自执行其已有预算。
支持 `parse-documents`、`assess-article-identity`、`analyze`、`analyze-long`、`synthesize`，
分别复用 ParseDocumentRequest、ArticleIdentityRequest、KnowledgeAnalysisRequest、
KnowledgeLongAnalysisRequest 和 KnowledgeSynthesisRequest。
operations 是独立固定目标，不在同一请求内引用尚未产生的结果。前序结果出来后再提交后续请求。

TypeScript 使用 `Application.processingTasks.submit/run/read/control`；只读状态通过
`QueryApplication.taskRead(jobId)` 读取，不启动恢复。结果只携带 DocumentVersion、KnowledgeArtifact
或 assessment 的稳定 ID/hash，后续通过对应读取接口展开内容。局部失败不撤销其它目标结果。
重启后只重试未完成目标；外部服务恰好调用一次不在保证范围内。

`read_task` 的 `skipped` 保留跳过原因和预算耗尽记录，`failures` 保留失败历史，包含因失败而跳过、
等待协助或安排重试的目标及其 code/reason/action。`completed` 表示本轮执行已结束，
应结合 targets、skipped、failures 和结果引用判断是否达成请求；成功重试后历史失败记录仍保留。
已满足目标不会被标为失败，也不会触发人工协助。
显式 `retry` 可以重新排入因失败而跳过的目标，即使任务显示 `completed`；
已经完成、已经满足、正常获取耗尽、预算耗尽或人工选择跳过的目标保留原状态，取消的任务不可重试。
旧事件没有跳过原因时，保留原始诊断，并允许对带 failure 的跳过项显式重试；不会自动重新执行。

## 解析后身份核验

Catalog v9 上使用 `Application.articleIdentity.assess(request)` 或对应加工任务：

```text
schema_version: 1
literature_id、document_version_id、representation_sha256
metadata_revision、metadata_sha256
budget: {max_input_bytes, max_output_tokens}
```

文档字段来自 DocumentRead，元数据绑定来自 Literature detail 或 prepare_analysis_inputs。
核验复用配置中的 analyze 模型，明确消耗一次模型调用；模型未配置、超预算或坏证据会报告失败。
完整请求序列化字节受 `max_input_bytes` 限制，不能只按原文长度估算。已存在同一当前输入的判断时复用。

返回 `match-supported`、`conflict` 或 `insufficient-evidence`，包含实际原文片段、方法和模型来源。
详情标签投影当前判断；没有判断或输入已变化时仍为 `unverified`。历史判断可由
`QueryApplication.articleIdentityRead(assessmentId)` 读取，`current:false` 表示已不适用于当前输入。
这不是下载验收门槛，也不自动删除、失效或重新下载任何材料。模型提取的语义准确率需独立验收。
当前证据定位到单个文档片段；跨片段断行的字段尚不能作为一条完整字段证据提交，不能据此宣称所有排版均可识别。

旧 catalog 可以继续读取和执行其既有能力，身份结果写入要求显式升级至 v9。
升级前停写并按[升级指南](upgrade.md)提供精确目标与原始备份；普通 MCP/CLI 启动不会升级。
