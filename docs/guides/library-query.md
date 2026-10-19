# 独立文献库阅读

SciRetriever 提供独立只读的 Web 文献阅读入口，可搜索已有文献、打开详情和引用证据，并下载当前已接纳的 PDF 或 Markdown。它不会启动发现、下载、解析、分析、Job 或补库操作。缺少 PDF、内容或引用时，页面显示缺口；需要补齐时应另行执行明确的维护操作。

## 启动

查询入口以正式 TypeScript API 启动。默认配置身份与 CLI 相同，使用 Node 的用户 home；Catalog 和 ArtifactStore 路径继续由 `~/.sciretriever/config.toml` 的 `paths.catalog_path` 与 `paths.artifact_root` 指定。

```ts
import { homedir } from "node:os";
import { startQueryOnlyWorkbench } from "@sciretriever/server";

const reader = await startQueryOnlyWorkbench({ home: homedir() });
console.log(`SciRetriever 文献库：${reader.origin}`);

// 保持当前进程提供服务，收到 Ctrl+C 或终止信号后关闭只读资源。
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await reader.close();
```

默认监听系统分配的本机 loopback 端口，`reader.origin` 是实际地址。需要固定本机端口时可传 `port`。服务只接受本机同源请求。`startQueryOnlyWorkbench` 会装载安装包内随 server 发布的 `query.html`、`query.js` 和共享样式；源码测试应显式注入合成静态资源，不从 `src/` 路径读取 `dist/`。

## 就绪状态与缺口

页面启动先读取 `GET /api/v1/query/status`。`ready` 表示现有受支持 Catalog 可以查询；`not-initialized` 表示 Catalog 尚不存在或 schema 尚未初始化，页面会说明只读服务没有创建它；`unavailable` 表示配置、schema 或存储不可用，需要通过显式维护判断。已就绪但索引错误会在相应查询失败时显示不可用，不会伪装成零命中。就绪 Catalog 中零条文献会显示为空库；带检索词但零命中会显示无匹配结果。

Web 查询使用 `POST /api/v1/query/search|read|references|reference|artifact`，请求封套包含 `protocol_version: 1`。缺 PDF、文献内容或其它产物时，artifact API 返回明确的 `gap`，不会把错误 JSON 当成下载文件。文献列表、详情、搜索条件与浏览器前进/后退都保留在页面 URL 中。

程序查询可用 `query.discovery_run_ids` 限定一个或多个发现批次，返回发现原因实际指向的具体 Literature；同一 MetaLiterature 的其它版本不会自动进入普通搜索结果。该范围在读取元数据前与全文检索条件相交，因此批次外的旧记录合同问题不会阻断本批次列表；所选记录和发现原因仍严格校验。数据库补全则在同一读取 snapshot 中取得所选 MetaLiterature 的全部版本事实，再由 Entry 决定目标与版本回退；必需版本损坏仍会使范围读取失败。

## 只读边界

独立入口使用 `createQueryApplication` 和 SQLite read-only/query-only 连接，不创建 home、Catalog、schema、恢复票据或 Jobs，不执行恢复、对账或修复。打开已有 Catalog 时可能看到 SQLite WAL/SHM 协调文件；文献事实、Job、ticket 和 publication receipt 不会因此改变。

现有混合实时工作台仍包含 Browser、Jobs 与配置入口，并组装完整 Application；它不是独立 query-only 启动方式。独立页面从所选文献的已接纳 PDF 显示文件级证据；v3–v8 若已有默认 DocumentVersion，还能列出章节、全部片段（包括无标题正文和首标题前引言）、继续阅读文本、资源翻页及安全小图片预览。页面展示实际字节范围、片段证据和能力/覆盖缺口，切换选择后晚到的旧响应不会追加到当前正文。没有默认表示时页面只报告缺口，不会解析。需要手动 PDF、发布表示、重建 v4+ 材料索引或 v8 知识索引、提交 v5+ 提取候选、启动 v6 单篇分析或 v7 集合综合时另行启动 `startMaintenanceWorkbench({home})`，其 `/` 页面是受控维护，`/query` 是独立阅读；它不启动 Browser，会明确打开维护 Application。Agent 可使用已导出的 `createQueryApplication(home)` 调用相同的 `query.search/detail/references/referenceDetail`、`context.search`、`knowledgeContext.search`、`knowledgeRead.byId/list/default`、`synthesisPreparation.prepare`、`synthesisRead.byId/sourceById/list` 与 `documentRead.default/describe/outline/segments/resources/slice/resource/materialEvidence/resolveEvidence`，并通过 `literatureArtifacts.withArtifact` 读取校验过的原始字节；调用方先检查 `readiness`，结束时 `await close()`。该 TypeScript 入口没有维护或 Job 端口，不要求启动 HTTP 服务。候选交付与分析使用独立维护入口，不由只读查询触发。

集合综合阅读显示本次覆盖和实际独立证据来源数；已处理但无相关断言的文献不会作为支持来源，排除行也不表示当前来源缺失。点开引用时只核对该条来源断言及其有界原文证据；`source-only` 表示已存知识仍可追溯，但原 PDF 当前未复核。

## 单篇知识分析与阅读（Catalog v6）

单篇知识读取与发布支持完整 v6–v8，并需配置有效的 Analyze Model 才能启动分析。新库使用[正式初始化入口](upgrade.md)启用 v8，旧库先显式升级；真实用户 Catalog 迁移另需授权。维护页“单篇知识分析”按 Literature ID 核对已接纳主 PDF 的文件证据和当前可读 DocumentVersion，固定一项 `InputManifest` v1，选择概览、详细分析或针对问题，v1/v2 请求均使用 DSH 持续阅读，明确启动。问题型必须有非空问题；普通概览和详细分析不带问题。默认选择“仅发布历史产物”；选“按 revision 更新默认视图”时，首次默认留空 revision，已有默认需填当前 revision。CAS 冲突仍可发布知识历史，页面返回产物 ID 并说明默认视图未更新。取消、模型失败、引用无效不会删除 PDF、文档版本和旧知识；发布已经提交时即使后续取消，仍可通过只读页面核对历史 ID。

程序使用 `Application.knowledgeAnalysis.analyze(request, signal?)` 或 `Application.maintenance.analyze`；受控 HTTP 使用 `POST /api/v1/maintenance/analyze-knowledge`，请求为 `{protocol_version:1,request:{schema_version:1,input,purpose,question,default_update}}`。`default_update` 为 `null` 或 `{expected_revision:null|正整数}`；旧 `budget` 可省略，保留读取兼容但不执行；成功的 `result` 是 `{schema_version:1,artifact,published,default_updated,default_revision,default_update_outcome,default_update_failure}`。`default_update_outcome` 为 `not-requested`、`updated`、`conflict`、`cancelled` 或 `failed`；仅失败时有安全的 `default_update_failure`。默认指针更新取消或失败仍返回已提交产物，不伪称 CAS 成功。模型鉴权、配额等失败通过安全的 `reason` 和 `retryable` 随维护 HTTP 错误返回，不包含 Provider 原始响应。服务端派生方法和非密模型绑定，调用方不能指定方法身份；同一比较域重复请求返回首次已存产物和 provenance。v1/v2 共用 DSH 持续会话：分页读取完整正文、按需搜索和回读，模型具备图像能力时查看已保存的 PNG/JPEG/WebP。两者没有人为 token、累计调用数、整篇时长或片段数量预算。结构化断言包含类别、原文报告/推论、条件、可空数值和片段 EvidenceRef；引用可定位不等于科研结论已被证明。

长文程序入口为 `Application.knowledgeAnalysis.analyzeLong(request, signal?)` 或 `Application.maintenance.analyzeLong`；HTTP 为 `POST /api/v1/maintenance/analyze-knowledge-long`，外层协议 v1、内层 `schema_version:2`。历史 `budget` 可省略且不执行。原固定分块/层级合并算法已经删除。正文工具按 UTF-8 安全边界分页，引用绑定完整原片段；未读完正文、未查看可用图片或引用未知片段时，结果提交会被拒绝并反馈给同一 DSH 会话。模型不具备视觉能力、资源格式/大小不支持时明确记录缺口。实际 usage 包含会话里的推理和压缩，不作为截断条件。新方法 `dsh-document-analysis` v1 不复用旧方法总结，历史结果继续可读；没有引入数据库迁移。网络、模型上下文、结构序列化和文件完整性仍有实际边界。

查询页“已发布知识”按 Literature ID 列出最多十项最近历史，再按 Artifact ID 展开断言、片段版本/hash、覆盖与能力缺口。片段证据通过“展开证据”读取原文；超过 64 KiB 时明确标为部分内容，点击“继续读取证据”逐页核对至末尾，选择变化或页面离开会取消当前证据读取。Agent 可用 `createQueryApplication(home).knowledgeRead.byId(id)`、`.list(literatureId,limit)`、`.default(literatureId,purpose,questionSha256)`；只读 HTTP 分别为 `POST /api/v1/query/knowledge-read|knowledge-list|knowledge-default`，请求依次为 `{artifact_id}`、`{literature_id,limit}`、`{literature_id,purpose,question}`，成功均以 `{protocol_version:1,result:...}` 返回。默认读取返回 `{revision,artifact}`，缺失为 `knowledge-missing`；问题在服务端按 NFC/去首尾空白规范化，非问题型必须传 `null`。旧 `LiteratureContent` 与 metadata/current 状态不因新知识发布改变。v1–v5 查询仍可读旧材料，但知识读取和发布要求完整 v6–v8；普通查询不会自动升级。

## 集合知识综合（Catalog v7）

集合综合支持完整 v7/v8。新库初始化 v8，旧库通过[正式升级入口](upgrade.md)启用；真实用户 Catalog 的迁移仍需另行授权。维护页“集合知识综合”填写 1–128 项有序来源 JSON。文档项格式为 `{kind:"document",input_id,literature_id,asset_id,asset_sha256,document_version_id}`，知识项为 `{kind:"knowledge",input_id,source_artifact_id}`；`document_version_id` 可为 `null` 以读取当前默认版本。每个 ID、hash 应来自已接纳材料、文档阅读或历史知识按 ID 阅读，不能凭空填写。先选 `require-all` 或 `allow-partial` 并点击“固定来源与缺口”，再填写非空集合问题并明确启动。选项变化会清除旧准备结果。`require-all` 有缺项、`allow-partial` 全部不可用时返回 blocked 回执，不调用模型。`allow-partial` 成功产物会逐项标明纳入、降级或排除；`source-only` 表示知识字节与派生证据仍可验证，但原 PDF 当前不可读，不能说已重验原文。

程序入口是 `Application.maintenance.synthesize(request)`；HTTP 是受维护会话保护的 `POST /api/v1/maintenance/synthesize`。只读准备和阅读可调用 `createQueryApplication(home).synthesisPreparation.prepare({policy,inputs})`、`.synthesisRead.byId/sourceById/list`，HTTP 为 `POST /api/v1/query/synthesis-prepare|synthesis-read|synthesis-source|synthesis-list`，均使用 `protocol_version:1` 外层封套。综合请求使用 `schema_version:3`，含固定的 `SynthesisInputManifest` v2、`purpose:"synthesis"`、问题和政策；历史 `budget` 字段可省略且不执行。先通过 DSH 阅读明确输入，再在 DSH 综合会话中整合，并可回读候选或原文证据。模型可以归纳改写，程序检查结构与真实引用，不强制逐字保留候选、条件或分歧组条数；按实际引用链计算独立来源数。科学质量仍需单独评价。

只读页可按 Artifact ID 阅读或列出最近 20 项综合，展示逐项覆盖、共识或分歧组、条件/数量、每条文档片段或知识断言来源以及**当前**来源状态。知识来源按钮可继续核对上一层内容和 `source-only` 状态。重复精确版本不会重复计算模型输入；相同 Literature 的不同版本也不算多篇独立支持。发布后的原始资产和旧知识保持不可变。

## 提取输入准备（Catalog v1–v8 只读）

查询页的“提取输入准备”表单接收调用方规范 JSON 和有序输入 JSON 数组；规范可省略 `spec_sha256`，页面会计算规范 hash。每项输入必须显式给出 `input_id`、`literature_id`、`asset_id`、`asset_sha256` 和 `document_version_id`（没有表示时为 `null`）。页面只绑定已经接纳的资产与精确版本，返回材料清单、实际能力和缺口；同篇论文的主 PDF 与补充 PDF 可以分别输入。没有 ParserResult 或内部模型时，原 PDF 仍可提供文件级证据；需要片段等更细定位时应按能力缺口处理。该表单不获取 PDF、不解析、不运行提取算法，也不提交候选。

正式程序入口为 `createQueryApplication(home).extractionPreparation.prepare({spec,inputs})`，HTTP 入口为 `POST /api/v1/query/extraction-prepare`，请求封套是 `{ "protocol_version": 1, "request": { "spec": ..., "inputs": [...] } }`。返回的 `persistence: "requires-catalog-v5"` 指后续候选回执需要 v5，并不表示准备读取要求 v5。完整规范字段、支持的 JSON Schema 子集及能力名见[知识加工技术合同](../architecture/technical/05-knowledge-processing.md#4-调用方规范与提取交付)。

规范完整 JSON 上限为 64 KiB，manifest 上限为 256 KiB，单次最多绑定 128 项；schema 根可以是对象、数组或其它 JSON 类型。页面在发送前拒绝重复字段、无效规范和输入，收到响应后也核对协议版本、规范/manifest hash、逐项资产与显式版本及能力缺口。准备请求进行时会锁定规范、输入和提交按钮；完成或失败后才恢复编辑，修改任一输入即清除旧结果，重复提交不会并发发出第二个请求。规范要求片段证据时，即使没有单独列出片段能力，准备结果也会报告缺口。明确缺失、已接纳字节/文档损坏、能力不支持和取消分别返回可识别原因；断连和关闭会停止并等待在途准备。

## 候选批次交付（Catalog v5 维护）

在查询页准备并保存返回的 `spec`、`manifest` 后，启动 `startMaintenanceWorkbench({home})`。维护页的提取区域可以粘贴完整准备结果、创建 operation、提交候选 JSON、关闭或取消 operation、读取回执与显式清理。程序可用 `createApplication(home).extractionDelivery` 的 `create/submit/operation/receipt/closeOperation/cancelOperation/cleanupExpired`；操作结束后关闭 Application。此入口支持完整 v5–v8 Catalog；新库初始化 v8，旧库需先显式升级，不会因读取或提交自动迁移。输入准备保持只读，可先在旧版 Catalog 使用；创建 operation 会重新核对固定规范、manifest 和已接纳材料。

维护 HTTP 使用 `POST /api/v1/maintenance/extraction-operation|extraction-submit|extraction-operation-read|extraction-close|extraction-cancel|extraction-receipt|extraction-cleanup`；各路径展开后均以 `/api/v1/maintenance/` 开头。所有请求都用 `{ "protocol_version": 1, "request": ... }`，成功返回 `{ "protocol_version": 1, "result": ... }`，并要求同源 `Origin`、维护会话 Cookie、`x-sciretriever-csrf`、`x-sciretriever-protocol-version: 1` 与 `Content-Type: application/json`。会话和 CSRF 由受控维护页面获取；无维护 Application 时端点不可用。创建的 `request` 是 `{caller_id,spec,manifest}`，其中 spec 与 manifest 原样取自准备结果；`caller_id` 是本机声明的逻辑命名空间，并非远程租户认证。读取/关闭/取消使用 `{operation_id}`，回执读取使用 `{receipt_id}`，清理使用 `{limit}`（1–1000）。读取未知或已过期回执得到 `null`，而不是历史候选。

提交的 `request` 为封闭 `schema_version: 1` 对象，包含 `operation_id`、调用方唯一的 `submission_key`、本 operation 唯一的 `batch_id`、`records`、`relations`、按 manifest 顺序逐项填写的 `coverage` 和 `producer`。每条 record 包含批内唯一 `record_id`、符合规范 JSON Schema 的 `payload`，以及 `{pointer,sources:[{input_id,evidence}]}` 字段证据；pointer 是指向实际字段的 RFC 6901 路径，空串指根。具名关系包含 `relation_type`、`from/to` 的 `record_id` 与 pointer、以及关系证据。`evidence` 应来自受控的 `material-evidence` 或文档证据读取，并与固定 manifest 的输入、版本及内容 hash 对齐。`producer` 是 `{method_id,method_version,usage}`，其中版本可为 `null`，usage 是最多 16 项的非负安全整数计数；它是调用方声明，平台不会验证算法或科学结论。

每批最多 1 MiB 规范 JSON、64 条记录、128 条关系、256 个证据来源；每条记录最多 128 个字段 pointer，每个字段或关系最多 8 个来源。`coverage` 对每个输入恰好一项，状态可为 `processed-with-records`、`processed-no-records`、`not-processed`、`unreadable`、`unsupported`、`failed`、`cancelled`。前两种只适用于实际材料与所需能力齐备的输入；`processed-with-records` 还须有该输入的证据。`unreadable`、`unsupported`、`failed` 必须提供非空且不超过 512 UTF-8 字节的 `reason`。允许零记录批次，但仍须逐项声明覆盖；记录/证据校验通过不代表科学接纳。

operation 的新提交窗口为创建后 24 小时，最多 64 批。有效 operation 全库最多 1000 个，未过期回执最多 10000 个；满额返回明确容量错误，不会驱逐有效历史。接纳批次在一个事务中同时保存回执及**整个 manifest** 中实际存在的材料/文档 pin，回执和保护通常为 30 天。相同 operation/key 与完整内容 hash 在回执有效期内重试会返回同一回执，即使 operation 已关闭、取消或输入后来变化；同 key 不同内容返回 `submission-conflict`，同批次 ID 换 key 返回 `batch-conflict`。响应丢失后应用原始内容和 key 重试；过期或显式清理后只能得到 `unknown-or-expired`，不能据此判断此前是否接纳。关闭/取消阻止新批次，不撤销已接纳批次。成功当次的 `result` 为 `{schema_version:1,receipt,accepted_batch}`，其中 `accepted_batch` 回显本次完整复制过的候选 records/payload、证据、coverage 和 producer 声明；`receipt` 只含固定 hash、平台检查计数、期限与 pin。相同内容历史重试仍随本次请求回显等价 batch，但不重新验证已接纳的旧证据。单独读取回执只返回 `schema_version:1` 的回执，不恢复生产者声明或 payload，也不暴露内部 `checks_json`。物理资产/文档回收当前未开放；到期清理会等待回执期限与保护期限均结束，再删回执和 pin。

新提交的错误响应可附一个 `issue`，指明 `record_id`、JSON Pointer、`input_id`、`relation_index` 或 schema `keyword`；`truncated` 表示仅报告首个问题，不回显完整 payload。提交 request 的规范 JSON 上限为 1 MiB；HTTP 协议封套和带固定 scope 的比较 hash 各有最多 4 KiB 额外开销。回执上限为 128 KiB，成功双份回显结果上限为 2 MiB + 128 KiB，固定外层封套的节点和深度开销单独计入，不缩小原请求本身的限制。Web 按 UTF-8 字节数有界读取会话、成功和错误响应，对协议版本、结果字段、请求绑定和提交 hash 做严格检查；修改表单输入会清除旧结果。常见错误码包括 `catalog-v5-required`（未迁移）、`spec-conflict`（同调用方规范 id/version 被改义）、`input-stale`（固定输入已变）、`payload-invalid`、`pointer-invalid`、`evidence-out-of-scope`、`evidence-unavailable`、`coverage-invalid`、`relation-invalid`、`relation-required`、`submission-conflict`、`batch-conflict`、`operation-not-open`、`operation-expired`、`unknown-or-expired` 及 `operation-capacity`/`batch-capacity`/`receipt-capacity`。写入准入冲突返回 `delivery-write-conflict`（HTTP 409）；准入安全异常、关闭和期限失效分别返回 `delivery-write-security`、`delivery-write-closed`、`delivery-write-expired`（HTTP 503），只有实际取消返回 `delivery-cancelled`（HTTP 409）。HTTP 对非法封套和共享合同输入返回 `invalid-command`，未授权返回 `maintenance-auth-required`；调用方应依据 `code` 处理，不把失败当作零候选。精确结构与比较域见[知识加工技术合同](../architecture/technical/05-knowledge-processing.md#4-调用方规范与提取交付)。

## 材料上下文检索（Catalog v4）

v4 的阅读页在普通文献库搜索之外提供“材料上下文”。填写问题或关键词，可选单篇 Literature ID 与最终响应 JSON 的 UTF-8 字节上限；结果区分元数据和原文片段，显示覆盖、缺口、固定版本及可继续读取的原文范围。它搜索**已保存**材料，不调用 Provider、Parser、模型或 Job。建库或材料变更后须在受控维护页明确点击“重建材料索引”，或使用 `maintenance rebuild-index`。索引缺失、陈旧、损坏分别以 `index-unavailable`、`index-stale`、`index-corrupt` 报告，不能解释为零命中。检索 schema 完整而索引内容或 FTS 损坏时，可用同一显式重建操作修复；源材料或检索 DDL 损坏仍会拒绝重建，只读普通文献和文档读取不因检索投影损坏而停止。

正式 HTTP 请求为 `POST /api/v1/query/context`，封套仍是 `{ "protocol_version": 1, "request": ... }`。例如：

```json
{
  "protocol_version": 1,
  "request": {
    "query": "剂量",
    "scope": { "kind": "library" },
    "kinds": ["metadata", "document"],
    "versions": { "kind": "default" },
    "budget": { "max_items": 10, "max_bytes": 16384, "token_limit": null },
    "continuation": null
  }
}
```

显式旧版可改用 `versions: { "kind": "explicit", "documents": [{ "literature_id": "…", "document_version_id": "…", "representation_sha256": "…" }] }`；范围可用 `{ "kind": "literatures", "literature_ids": ["…"] }`。`continuation` 必须原样带回且同查询、范围、类型、版本和预算；源改变时重新发起查询。当前最多 20 项/262144 字节，没有 tokenizer，非空 `token_limit` 会拒绝。响应 `usage.bytes` 计算整个 `result` JSON，含证据、缺口和继续位置；`score_rule` 为 `weighted-term-frequency-v1`，`score` 是固定 generation 内命中单元的词频排序值（title 权重 4、body 权重 1，负值优先），不是可信度。正文引用返回精确 `start_utf8/end_utf8`，可用 `document-slice` 的 `{ "kind": "range", "start_utf8": …, "end_utf8": … }` 选择器分块继续读取；资源与证据仍使用本页下述受控阅读 API。只读请求不重建索引。

维护 HTTP 路由为受同源会话/CSRF 保护的 `POST /api/v1/maintenance/rebuild-index`，请求为 `{ "protocol_version": 1, "request": { "kind": "rebuild" } }`。从源码构建后的 CLI 可执行 `node apps/server/dist/cli/main.js maintenance rebuild-index --json`；它支持完整 v4–v8 Catalog。新库初始化 v8、旧库显式升级的步骤见[升级指南](upgrade.md)；v3→v4 单步合成演练保留在[文档 Catalog 迁移指南](document-catalog-migration.md)。真实用户数据切换仍需单独授权。

## 知识与材料混合上下文（Catalog v8）

明确限定多个 Literature 或 Artifact 时，部分来源有知识也会列出其余 ID 的 `knowledge-missing`；已有知识但关键词无匹配时不会误报缺失。坏源按 Artifact 或 Literature 给出缺口，缺口本身受最终 JSON 字节预算约束，需按 `continuation` 继续读取；如果完整正文装不下，页面可用固定引用继续阅读。验证预算按完整文档声明大小在文件读取前计入，材料和知识各自核验同一资产时会保守重复计量。切换查询或离开页面会取消正在进行的固定范围原文续读。

Catalog 显式初始化或升级至 v8 后，在受控维护页分别点击“重建材料索引”和“重建知识索引”；知识产物发布或来源变化后须再次明确重建知识索引。CLI 可运行 `node apps/server/dist/cli/main.js maintenance rebuild-knowledge-index --json`。HTTP 维护入口是 `POST /api/v1/maintenance/rebuild-knowledge-index`，使用与材料重建相同的同源会话、CSRF 和 `{ "protocol_version": 1, "request": { "kind": "rebuild" } }`，返回独立 generation 回执。真实用户 Catalog 迁移仍需单独授权；普通查询和 Web 打开不会升级或重建。

只读查询调用 `createQueryApplication(home).knowledgeContext.search(request, signal?)` 或 `POST /api/v1/query/knowledge-context`，HTTP 使用 `{ "protocol_version": 1, "request": ... }`，成功返回 `{ "protocol_version": 1, "result": ... }`。一个混合请求示例：

```json
{
  "protocol_version": 1,
  "request": {
    "schema_version": 2,
    "query": "稳定性",
    "scope": { "kind": "library" },
    "kinds": ["metadata", "document", "knowledge"],
    "versions": { "kind": "default" },
    "knowledge": {
      "purposes": ["overview", "detailed", "question", "synthesis"],
      "question": null,
      "selection": "all",
      "artifact_ids": []
    },
    "budget": { "max_items": 10, "max_bytes": 16384, "token_limit": null },
    "continuation": null
  }
}
```

知识选择可限定用途、原始问题或精确 Artifact ID；`question` 只可与 `question`/`synthesis` 用途同用，按规范化后原文精确匹配。Literature 范围下，集合综合的全部已知来源都须在范围内，未知上游不能冒充范围内结果。返回项显式区分 `source-text` 原文、`metadata` 和 `generated-knowledge`；生成知识带固定 Artifact/statement hash、当前来源层级、历史覆盖与独立文献数。页面的“按固定产物阅读并展开证据”会核对命中的 Artifact 内容 hash、manifest hash 和断言 hash，再在卡片内展开固定断言及其文档/上游知识证据；`source-only` 明示原 PDF 当前不可复核。`source-text` 卡片也可按固定 DocumentVersion/表示 hash/资产 hash 与 UTF-8 范围续读，并逐条展开证据。索引未构建、陈旧、损坏及来源降级会报告覆盖/缺口；单支索引故障时另一支仍可返回。结果按共同词频规则排序，`score` 不是科学置信度；完整 JSON 字节预算包含来源、证据、缺口和游标，续页须保持原请求与 generation。当前无 tokenizer，非空 token 限额会拒绝。

固定合成语料的检索质量记录见[实施计划 M07-T03](../archive/2026-09-28-typescript-knowledge-architecture-migration/07-retrieval-context.md#m07-t03-b-检索质量记录)。它只说明合成条件下的召回、排序和条件保留，不证明真实科学语料表现。

## 固定版本阅读与证据

阅读 API 使用 `POST /api/v1/query/document-default|document-describe|document-outline|document-segments|document-resources|document-slice|document-resource|material-evidence|evidence-resolve`。每个 JSON 请求为 `{ "protocol_version": 1, "request": ... }`，成功响应为 `{ "protocol_version": 1, "result": ... }`。`material-evidence` 只需 `literature_id`、`asset_id`，在 v1–v8 中均可验证仍存在的已接纳 PDF，返回 `material-file-v1` 文件证据，不声明页码或字段位置。旧 v1/v2 库仍使用旧清理语义；证据目标后来若消失会明确报缺失。`document-default` 需该材料的 Literature ID、Asset ID 和 SHA-256，在完整 v3–v8 可用；没有已发布表示返回 `document-missing` 缺口。正式初始化/升级与全部 reader 范围见[安装兼容矩阵](installation.md#当前-catalog-与-reader-兼容)。

外部程序读取原 PDF 字节可调用只读 TS `QueryApplication.documentRead.withMaterialBytes({literature_id,asset_id,asset_sha256}, async (material,chunks) => ...)`，或 `POST /api/v1/query/material-bytes`，请求仍用上述 JSON 协议封套，`request` 仅含这三个稳定字段。HTTP 成功响应是 `application/pdf` 原始字节流，`x-sciretriever-asset-id`、`x-sciretriever-asset-sha256` 和 `x-sciretriever-byte-size` 给出固定资产绑定；调用方应读到正常结束并复算整份 PDF 的 SHA-256。入口按显式资产 ID 读取主 PDF 或补充 PDF，不按 current 主件重选；服务在同一受控文件读取前后验证完整 hash、大小和文件身份，最多读取 256 MiB，流中断或末次校验失败不会正常结束。`material-evidence` 可在读取后取得文件级引用；它只验证和描述材料，不返回 PDF 字节。错误 hash 为 `material-stale`，错误资产关系为 `material-missing`；不向调用方暴露内部相对路径、FileStore 或数据库表。文件级证据可支持整条记录的根证据，不能声称页码、字段位置或满足要求 segment 的规范。

例如根据已取得的固定版本读取章节：

```json
{
  "protocol_version": 1,
  "request": {
    "document_version_id": "00000000-0000-0000-0000-000000000001",
    "selector": { "kind": "section", "section_id": "s1" },
    "max_bytes": 8192,
    "continuation": null
  }
}
```

该请求发送至 `/api/v1/query/document-slice`。`max_bytes` 必须为 1–65536 的整数，只限制本次返回的 UTF-8 文本；响应给出 `actual_range` 半开字节范围、`truncated` 和可继续的 `continuation`。每页最多附 32 条完整片段证据；达到上限会缩短本页正文并返回 `evidence-page-limit` 和继续位置。资源读取也以 65536 原始字节为单次上限，返回 base64、字节范围及继续位置；大图片可以分块给程序，页面仅预览从字节 0 覆盖完整声明大小、且资源 hash/大小/媒体类型与列表一致的安全小图片。目录、片段与资源列表每页最多 200 项；目录长标题在读取时截为最多 512 个 UTF-8 字节并标记 `title_truncated`，不改变已发布的结构/hash。`segments` 的 `section_id: null` 列出全局片段。继续位置绑定版本、表示 hash、选择器与下一位置，下一页可以改变合法预算；校验和用于发现误配，不充当授权凭证。

完整片段才附带 `utf8-segment-v1` 证据。`evidence-resolve` 重新校验固定表示、片段定位及内容 hash；大段落也按最多 65536 字节分块，文件级材料证据只校验整个 PDF。资源上下文当前仅认定行首最多三个空格、单独成行的直接 Markdown 图片语法 `![标签](相对引用)`；转义图片、代码、HTML 注释/块、普通提及或无可靠位置时返回 `resource-context-unavailable`。没有可证实的表格单元、图注关系、PDF 页码或 bbox 时返回能力缺口，不会推断或降级定位。读前校验 PDF、Markdown、结构与资源各自的声明上限，并在固定闭包内验证实际 hash；片段的 64 KiB 响应预算不代替完整性扫描上限。请求和响应都经过共享读取合同验证，结果绑定所请求材料和固定版本；非法输入、未知证据 scheme/schema 和已接纳材料的 hash 冲突分别报告不同错误。v3 起禁物理回收，故旧表示在重解析后仍可核验；v5 起的外部候选回执登记有限期保护，跨进程回收锁与通用回收入口尚未实现。

## CLI 兼容边界

现有 `literature search/show/references/cited-by` 和 `export metadata/pdf/content` 改用独立查询组装；已初始化数据库上的成功结果与报告格式保留。未初始化时不再由查询顺便建库，而是退出码 `3`、错误码 `query-not-initialized`；不可用库为 `query-unavailable`。需要新增数据时先显式执行导入或维护命令。资产导出仍会按用户指定目标写出导出副本，但不会因此改写库内资料。

QueryApplication 的并发、重复或关闭回调中的再次关闭共用一个关闭结果。某个资源关闭失败仍会尝试关闭其他资源，CLI 的操作与关闭同时失败时保留两项原因，对外仍只报告稳定错误码。

Catalog v10 另有通用处理器结果与记录内容查询，不改变旧回执行为。长期保存候选必须显式 retain，见[统一知识加工指南](knowledge-processors.md)。
