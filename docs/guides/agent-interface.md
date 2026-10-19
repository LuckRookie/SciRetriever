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

| 工具                                          | 行为                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `status`、`search_library`、`read_literature` | 本地 readiness、库内查询和详情；缺口不扩库                                                                             |
| `document_read`                               | default/describe/outline/segments/slice/resources/resource/evidence/material；使用[固定文档读取合同](library-query.md) |
| `prepare_analysis_inputs`                     | 从明确 Literature ID 固定已有材料和默认文档，返回 InputManifest 与元数据身份快照                                       |
| `prepare_synthesis`                           | 按现有 SynthesisPreparationRequest 固定集合输入；不调用模型                                                            |
| `read_knowledge`、`search_context`            | 读取已有单篇/集合知识和检索上下文                                                                                      |
| `read_task`、`read_article_identity`          | 读取执行结果引用、失败和已保存的身份判断                                                                               |
| `submit_processing`                           | 显式加工已有材料，返回持久任务 ID；使用工具声明的封闭请求 schema                                                       |
| `acquire_pdf`                                 | 明确 Literature ID 的 PDF 获取，复用 direct → publisher-api → general-api → public-web → browser 五层流程              |
| `discover_metadata`                           | 有界主题发现，只接纳元数据，不下载 PDF                                                                                 |
| `control_task`                                | run/pause/cancel/resume/retry；保留完成结果                                                                            |

读取和准备输入的工具无需维护模式。`submit_processing`、`acquire_pdf`、`discover_metadata`、
`control_task` 只在 `--maintenance` 下声明；Agent 只应执行用户已明确启动的任务。
响应包含 `protocol_version:1` 和 `result`；MCP 的 `isError` 表示操作调用失败。任务 accepted/queued
不是 PDF 或知识产物完成，须读取任务目标及结果引用。所有异常只返回稳定 code，不回显原始异常或请求。

推荐顺序：查询/发现 → 明确获取 PDF → 解析 → 读取固定文档/准备 InputManifest → 分析或身份核验 → 读取产物。
每一步都可以独立使用；解析、分析、身份核验不会为了补输入而暗中下载。

Browser 获取在一篇文章内保留模型工具历史、人工指导和真实下载反馈。模型返回动作或文本不等于取得 PDF；调用方仍以 `read_task` 的文件验收、发布结果和失败信息判断完成。内置模型历史不是独立公开调用合同，也不跨进程恢复；外部 Agent 可按下文显式连接持有该会话的 Web runtime，使用受控 Browser 协作工具。知识分析继续针对固定输入调用单次结构化模型边界，不因此获得 Browser 探索权限。

## 三端能力覆盖与结构化入口

目标是 CLI 与 MCP 分别覆盖 Web 的业务能力，见 [ADR 0033](../architecture/decisions/0033-machine-interfaces-cover-web-capabilities.md)。当前常规业务、材料传输、配置和活会话均有机器入口；2026-10-15 的接口适配范围与验收见[历史能力矩阵](../archive/2026-10-15-interface-capability-parity/capability-matrix.md)。纯 UI 偏好不做机器接口，未实现的自动提取执行器也不在覆盖声明内。

新增 CLI 命令使用 `--request /absolute/path/request.json` 或 `--request -` 从 stdin 读取严格 JSON，支持 `--json`。结果封套为 `{protocol_version:1,result}`；空查询不会启动加工。原有命令和工具格式继续支持。

| CLI（请求命令加 `--request FILE\|-`）                                                   | MCP                                                                                                                                  | 请求与效果                                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `literature status`                                                                     | `status`                                                                                                                             | 本地库状态，不初始化                                                                                                             |
| `literature search`                                                                     | `search_library`                                                                                                                     | 完整 LibrarySearchRequest：query、sort、limit、cursor；MCP 旧 text/limit/cursor 格式保留                                         |
| `literature read`、`reference`、`references`、`identity`                                | `read_literature`、`read_reference`、`read_references`、`read_article_identity`                                                      | 稳定 ID 或既有关系分页合同；read_references 通过 request 字段提交                                                                |
| `document default/describe/outline/segments/slice/resources/resource/evidence/material` | `document_read`                                                                                                                      | 对应既有 DocumentReadRequest，不下载或解析                                                                                       |
| `literature artifact-chunk`                                                             | `read_artifact_chunk`                                                                                                                | 有界读取主 PDF / 内容 Markdown，固定 hash 与 offset；完整原始导出仍可用 CLI `export pdf/content`                                 |
| `literature bibliography`                                                               | `export_bibliography`                                                                                                                | `{literature_ids,format}`，最多 100 个 ID；返回文本、字节数与 hash                                                               |
| `import pdf ID SOURCE`                                                                  | `begin_pdf_upload/append_pdf_upload/commit_pdf_upload/discard_pdf_upload`                                                            | PDF 字节显式接纳；MCP 分块上传，提交后走同一验收 owner                                                                           |
| `analysis prepare`                                                                      | `prepare_analysis_inputs`                                                                                                            | `{literature_ids:[...]}`，固定已有材料与身份元数据快照                                                                           |
| `knowledge read/list/default`                                                           | `read_knowledge`、`list_knowledge`、`default_knowledge`                                                                              | ID、文献/limit，或文献/purpose/question；缺默认结果返回 null                                                                     |
| `synthesis prepare/read/source/list`                                                    | `prepare_synthesis`、`read_knowledge(kind=synthesis)`、`read_synthesis_source`、`list_syntheses`                                     | 固定输入、产物 ID、来源状态，或 manifest_sha256/limit                                                                            |
| `context search/knowledge`                                                              | `search_context`                                                                                                                     | MaterialContextRequest / KnowledgeContextRequest                                                                                 |
| `jobs list/inspect`                                                                     | `list_tasks`、`inspect_task`                                                                                                         | 列表支持 limit/cursor/status_group；详情提供任务结果、活动、策略、预算和干预；均为只读                                           |
| `jobs create-request`                                                                   | `create_task`                                                                                                                        | Web 任务请求：`{kind:"processing",request:...}` 或 `{kind:"acquire-pdf",idempotency_key,selector,policy?}`；只保存，随后显式运行 |
| `jobs resolve`                                                                          | `resolve_intervention`                                                                                                               | `{job_id,intervention_id,resolution:"continue"\|"skip"\|"cancel"}`，核对干预归属，不自动运行                                     |
| `import bibliography`                                                                   | `import_bibliography`                                                                                                                | `{format,content}`；书目接纳不自动获取 PDF                                                                                       |
| `discover request`                                                                      | `discover_citations`                                                                                                                 | CLI 接收 Web 发现请求；MCP 引用扩展使用 seed_literature_id/direction/scan_limit，复用配置来源                                    |
| `extraction prepare`                                                                    | `prepare_extraction`                                                                                                                 | 只读提取准备，MCP 使用 request 字段                                                                                              |
| `extraction create/read/submit/receipt/close/cancel/cleanup`                            | `create_extraction/read_extraction/submit_extraction/read_extraction_receipt/close_extraction/cancel_extraction/cleanup_extractions` | 复用候选验收、幂等回执与保留策略；create/submit 的 MCP 参数置于 request；没有内置自动提取执行器                                  |
| `config read`、原有 `config status --json`                                              | `configuration_read`、`configuration_status`                                                                                         | 固定用户配置和凭据存在状态，无密钥值、无外部请求                                                                                 |
| `config preview/publish`                                                                | `configuration_preview`、`configuration_publish`                                                                                     | baseline 加 payload（完整 TOML）或 configuration（完整普通配置投影），二者选一；publish 另给 sections，过期 revision 拒绝        |
| `config credential`                                                                     | `configuration_credential`                                                                                                           | baseline 与受控 edit；通过 stdin/文件输入，不把密钥写进命令参数，不回显秘密                                                      |
| `config probe`                                                                          | `configuration_probe`                                                                                                                | `{owner,target,image}`；明确外部请求与可能配额；与既有 config test 共用 probe owner                                              |

`config publish` 不改动运行中 Application 的启动快照，需重启相应 runtime。凭据变更于后续外部请求生效，已派发请求可能完成。配置操作不需要初始化文献库。MCP 的写入、凭据编辑和 probe 仅在 `--maintenance` 下声明；`configuration_preview` 只验证、不写入。

新查询/维护入口返回同一领域结果；协议外壳可能不同，例如 Web 对缺失知识返回 HTTP 404，而机器读取可以返回 null。CLI 退出码 2 表示输入非法，3 表示业务失败，4 表示配置失败，130 表示取消；不以原始异常回显请求或密钥。

## 材料传输与导出

MCP 请求 JSON 上限为 1 MiB + 4096 字节，领域合同自己的限制仍然有效；结构化结果上限为 4 MiB，以覆盖合法的单个知识/综合产物。过大的批量结果返回 `response-budget`，须缩小分页或 ID 范围，不会静默截断。Browser 图像使用独立 image 内容块，最大原始字节为 4 MiB，不重复塞入文本结果。

PDF 上传按以下顺序调用，仅在 `--maintenance` 下提供：

1. `begin_pdf_upload`：传入 `literature_id`、完整文件 `sha256` 和 `byte_size`。单文件不超过 16 MiB，返回 `upload_id`、`max_chunk_bytes` 和过期时间。
2. `append_pdf_upload`：传入 `upload_id`、`offset` 和规范 `bytes_base64`，每块最多 192 KiB。offset 必须连续；已经收到的相同字节可重试，跳跃或不一致的重放会拒绝。
3. `commit_pdf_upload`：只传 `upload_id`，完整大小和 hash 匹配后消费缓冲并调用 Web/CLI 共用的 PDF 接纳服务。已存在主 PDF 时拒绝覆盖，接纳不等于文章身份已核验。
4. 放弃时调用 `discard_pdf_upload`。上传缓冲只属于当前 MCP 连接，最长存在十分钟；最多四个、总计 32 MiB（含正在提交的缓冲），断开清理。完整性校验前失败可继续补传；开始接纳后句柄已消费，遇到结果不明应先读文献事实，不盲目再次提交。

这些工具不接收服务器文件路径；调用方选择和读取自己的输入文件。`read_artifact_chunk` / `literature artifact-chunk` 使用：

```json
{
  "literature_id": "文献 UUID",
  "kind": "primary-pdf",
  "expected_sha256": null,
  "offset": 0,
  "max_bytes": 196608
}
```

首次读取返回完整 `sha256`、`byte_size`、`chunk_sha256`、`bytes_base64` 和 `next_offset`。后续请求必须带回完整 hash，直到 `next_offset:null`；版本不同返回 `artifact-changed`。`kind` 还支持 `content-markdown`；固定文档资源继续使用 `document_read/resource` 的既有 continuation 合同。每次读取经过目录引用和文件完整性校验，不接受任意资产路径。分块会重复校验文件；同机大文件批量导出可优先用 CLI 的原始文件导出。

书目支持 BibTeX、BibLaTeX、RIS、CSL-JSON。知识、综合、上下文的结构化读取结果本身可交付或保存为 JSON，保留稳定引用与证据；无需新增产物或任务来“导出”。展示型 Markdown 可由调用方从这些结果生成。

## 连接正在运行的 Web 服务

活 Browser 会话和后台执行属于持有它们的服务进程。机器入口显式指定服务地址：

```bash
sciretriever mcp --maintenance --workbench-url http://127.0.0.1:4174
sciretriever browser session --workbench-url http://127.0.0.1:4174 --request - --maintenance
sciretriever jobs runtime --workbench-url http://127.0.0.1:4174 --request /absolute/path/runtime-task.json --maintenance
```

地址接受显式 IPv4 HTTP origin 与明确端口（`localhost` 规范为 `127.0.0.1`）；不接受域名、HTTPS、用户信息、路径、查询串，不跟随重定向。按 [ADR 0035](../architecture/decisions/0035-authenticated-remote-web-access.md)，所有 Web 连接均须在 CLI/MCP 进程环境中设置 `SCIRETRIEVER_WEB_PASSWORD`，值为服务的固定密码或启动终端显示的 API key；本机连接也不免除认证。客户端拒绝连接未提供统一登录协议的服务。认证材料不进入工具结果或持久化文件；退出客户端撤销自己的登录，不影响其它登录者。不会从 catalog 自动发现或接管其它进程。

例如 `sciretriever mcp --maintenance --workbench-url http://192.0.2.10:4174` 连接指定服务器；先通过环境变量提供密码或启动密钥，不把密码放进参数、请求 JSON 或 URL。HTTP 不加密传输，应在可信网络使用。普通不带 `--workbench-url` 的 CLI/MCP 仍直接使用本机业务 owner，无需 Web 密码。

配置了 `--workbench-url` 后，MCP 增加以下工具；普通模式只可观察，变更仍需 `--maintenance`：

| 范围     | 工具                                                    | 行为                                                                        |
| -------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| 观察     | `browser_view/select/tabs/frame`                        | 当前会话/观察、选择文章、列出页面、读取确切 frame_seq；观看不暂停 Agent     |
| 控制     | `browser_control/action/activate_tab`                   | 取得/交还/暂停/恢复/取消控制，以及带页面绑定的 OperatorInput；不暴露 JS/CDP |
| 指导     | `browser_guidance/cancel_guidance`                      | 提交或撤销当前连接的待处理指导                                              |
| 候选     | `browser_accept_candidate/abandon_candidate`            | 既有候选操作，仍校验当前控制权与 transfer hash                              |
| 生命周期 | `browser_disconnect`                                    | 撤销当前连接，不停止 Web 服务                                               |
| 服务任务 | `runtime_list_tasks/read_task/create_task/control_task` | 在连接的 Web 服务内读、保存、启动、暂停、取消、恢复或重试任务               |

`browser_view` 返回既有 WorkbenchView，并补充 `controlled_by_client`。先观察，再用返回的 `session_id/article_id/control.epoch` 请求 takeover；取得控制后重新读取观察，用确切的 session/page/document/observation/viewport/epoch 和唯一 `request_id` 发送动作。支持 `click-element`、`click-point`、`scroll-surface`、`go-back`、`wait-for-change`、`type-text`、`press-key`、`stop`，字段使用既有 OperatorInput 合同；旧 epoch/页面版本拒绝，不自动重放。调用 action 超时不代表动作被撤销，应重新观察再判断。

CLI `browser session` 是持续连接，输入为 NDJSON，每行 `{operation,request}`，每行输出 `{protocol_version:1,result}`。可用操作：`view/select/tabs/frame/control/action/guidance/cancel-guidance/activate-tab/accept-candidate/abandon-candidate`；也支持 `task-list/task-read/task-create/task-control`。单行不超过 256 KiB。Agent 可以边读回复边生成下一行，无需人类交互。错误行返回稳定 failure.code，后续行可继续；有错误时最终退出码为 3。例：

```json
{ "operation": "view", "request": {} }
```

连接的观察请求维持 viewer 生命周期，但不隐式获取/恢复控制。明确结束介入时先 `release`，确认成功再关闭连接；CLI EOF、MCP 关闭或 disconnect 会撤销连接，仍持有控制权时遵守服务端暂停政策。异常断线最终由服务端三分钟 grant 过期撤销，不推断已经交还成功。

`runtime_create_task` 的 `request` 与 `create_task` 相同且只保存。`runtime_control_task` 接收 `{job_id,action}`，action 为 `run/pause/cancel/resume/retry`；后台执行由 Web 服务持有，机器客户端退出后服务可以继续工作。CLI `jobs runtime` 使用一次性 JSON：

```json
{ "operation": "control", "request": { "job_id": "任务 ID", "action": "run" } }
```

operation 还支持 `list/read/create`。这条路径操作明确连接的服务所绑定的库，不使用另一份本地配置重新组装执行器。普通 `jobs run` / `control_task` 仍在自己的进程运行，共享 catalog 不会绕过执行锁；存在活 Web 执行器时，应使用 runtime 入口。

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
  "operations": [
    {
      "operation": "parse-documents",
      "request": {
        "literature_id": "返回的 Literature UUID",
        "asset_id": "返回的主 PDF UUID",
        "asset_sha256": "返回的 SHA-256",
        "mode": "reparse",
        "expected_default_revision": null
      }
    }
  ]
}
```

以上占位值必须替换为真实读取结果。同一请求最多 100 项、1 MiB；固定输入解析/总结/综合不要求业务预算；Browser、发现及检索仍执行各自的范围与预算合同。
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

## 发现结果与扫描预算

种子查询同时携带已知稳定标识（如 DOI）与该 Provider 的来源 observation 中保存的原生记录 ID；存在 DOI 不会丢弃已有原生 ID。部分反向接口要求原生 ID，尚无该 Provider 观察时仍可能受其 key 能力限制；来源失败不会撤销其它已接纳结果。

主题发现会把年份限制交给 Provider，并在接纳前按规范 `publication_year` 核对范围。指定
年份范围时，越界或缺失年份的记录不进入该次发现结果；Provider 的原始扫描计数仍包含这些
记录，避免为了凑齐结果绕过预算。这也处理了供应商按在线发表日期命中、记录规范年份却取
纸本年份的情况。

供应商可选字段无法解释时局部置空或跳过列表项，不阻止其它有效元数据接纳。例如坏 ORCID
不会删除作者，坏摘要不会删除 DOI 与标题。完整数字字符串、文本空白和可信日期精度会规范化；
未知格式不会猜测。身份或响应协议错误仍保留失败，已取得的有效记录继续接纳。
因此发现任务标记 `FAILED` 也可能已有入库结果，应同时查看接纳数量与来源结果。
详细边界见[供应商治理](../development/provider-governance.md#元数据转换明确协议与局部舍弃)。

种子扩展逐条接纳关系中已有的目标元数据；只有缺少可接纳目标时才 lookup，lookup 和关系
扫描共同消耗该 Provider 的原始项预算。达到预算时，已经拿到的内嵌元数据仍可接纳。
同一对有向文献端点重复出现时复用引用边并追加来源支持；边与该次支持在同一事务内确认，
错误或取消保留先前已提交的有效结果。结果上限和深度只限制本次扩展，不表示供应商的全部
引用已经扫描完。

## 名称维护与 PDF 获取边界

PDF 获取与元数据名称维护可以分别启动。下载默认先消费已有 PDF 线索和稳定公开地址，再依次尝试出版社专用 API、聚合/开放获取 API、公共网站和独立准入的 Browser；同阶段以配置顺序为基础，出版社 API 可按唯一名称候选稳定优先。凭据存在与名称归类都不证明文章授权，未知名称也不会阻断其它有依据的路线。

名称维护目前使用显式 CLI（不新增同名 MCP 工具）：

```bash
sciretriever maintenance publisher-names --all --output /absolute/path/publishers.json
sciretriever maintenance publisher-names --query 'local query' --ai --max-ai-requests 20 --output /absolute/path/publisher-suggestions.json
sciretriever maintenance publisher-names-accept --report /absolute/path/publisher-suggestions.json --name 'normalized name'
```

扫描默认不调用模型，也不下载或改变来源。`--ai` 复用 Analysis Model，只产出带输入 hash/provenance 的建议；通过 `--output` 保存建议报告，再按所选名称显式接纳。接纳按所选规范名称和配置 revision 核对冲突并写入 `sources.publisher_aliases`，不会覆盖出版社/期刊原文或新增 Literature 字段。范围、分页与限制见[出版社名称维护](../development/provider-governance.md#出版社名称维护)。

Browser 复用前四层的实际响应准备有限文章入口，不增加 HEAD/GET 预检。普通 HTTP 403/404 不构成 Browser 永久拒绝；首次模型派发前，只有 Browser 实际 404/410 或明确 DNS/连接失败才自动尝试备用入口，已有在途下载优先结算，模型接管后不自动换页。每篇默认共享 300 秒活跃时间与 30 次实际模型派发预算，先到上限停止进一步探索，动作保留统计而默认不独立设限；5 秒节奏、平台准入/冷却继续执行，换入口或恢复不重置预算。最后一次合法调用可以完成动作及有界页面反馈与下载交接，时间和控制版本检查仍有效；已开始的文件传输使用独立寿命。预算耗尽不推断永久无权限或全渠道耗尽。此能力的离线验证不证明真实站点成功率或机构 entitlement。

统一处理器由 `submit_processor`、`processor_query`、`rebuild_processor_index`、`retain_extraction` 提供；任务控制沿用 `read_task/control_task`，见[完整合同与例子](knowledge-processors.md)。
