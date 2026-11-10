# 01 · 统一产品接口技术设计

类型：规格
负责：统一产品操作、配置发布与中性合同；Web 前端技术栈；technical 中早期形式化接口（Entry）
状态：现行；目标接口单独成节

[设计总览](../design.md) · [八模块技术导航](../technical.md)

本模块对应设计中的 **① 统一产品接口**，把科研 Agent、CLI 和人类工作台的意图转换成一致的产品操作。查询分派到⑥；明确维护分派到②；业务接纳由③④⑤各自决定。

内部由产品协议、CLI/HTTP 适配、人类工作台与输入输出边界组成。配置是共享支撑，本篇集中说明其编辑、发布和凭据合同；它仍由 Configuration owner 实现，不属于文献业务规则。公共中性合同也在本篇说明基础规则，具体文献、文档、查询和产物字段分别归其所属模块正文。

当前已提供 TypeScript/CLI、配置页、独立查询 Web 及单篇三用途知识分析/阅读，单篇长文另有显式分段请求；集合综合的有界执行、只读准备/阅读、HTTP 和 Web 入口已接通；MCP stdio 与 HTTP 已接入统一 Application；部分人类协作能力仍有独立验收范围。代码字段、已有合同和目标草案在相应小节区分。

本篇目录：

- [1. 模块边界与连接](#1-模块边界与连接)
- [2. 公开操作、协议与资源交付](#2-公开操作协议与资源交付)
- [3. CLI 与输入输出适配](#3-cli-与输入输出适配)
- [4. 人类工作台与知识阅读](#4-人类工作台与知识阅读)
- [5. 共享支撑：配置与凭据](#5-共享支撑配置与凭据)
- [6. 共享合同、结构解析与版本兼容](#6-共享合同结构解析与版本兼容)
- [9. 目标接口（尚未实现）](#9-目标接口尚未实现)

## 1. 模块边界与连接

调用方 → 本模块 → 查询⑥ / 维护② / 共享配置；返回稳定结果和明确副作用。

本篇按职责归并已有详细合同；示例中的现有类型与目标类型保持各自状态。文档归属不改变源码目录、事实所有权或当前公开 API。

## 2. 公开操作、协议与资源交付

### 2.1 三类 Agent 的区别

| 参与方                  | 拥有的决定                         | 可使用的能力                                  |
| ----------------------- | ---------------------------------- | --------------------------------------------- |
| 外部科研 Agent          | 问题、范围、提取算法、下游科研流程 | 明确开放的 query/maintenance 产品用例         |
| 内部 Analysis           | 单篇/集合知识加工、阶段与产物校验  | Document/Evidence、Agents 单次执行、发布 Port |
| 内部 Browser controller | 当前文章中下一步受控页面动作       | 观察、封闭动作、同一控制租约                  |

`agents/` 包含共享无状态单次模型层；按 [ADR 0031](../decisions/0031-dsh-backed-agent-capabilities.md)，还将提供内部受控 DSH 执行基础，方案已批准。它不是外部科研 Agent 的对话宿主，不开放任意 prompt 执行来代替产品操作，也不将 Browser/Page、SQL 或 secret 当工具参数传给调用方。

### 2.2 查询与维护的能力分组

#### 2.2.1 查询面

查询面只读取既有事实：文献搜索/详情、资产与文档读取、证据解析、已有知识检索和上下文组装。缺输入返回 Gap，不能调用任何补库、重解析、重分析或建 Job 接口。

建议将工具描述写成“库内检索”，明确范围与返回类别。大文件采用受控资源读取，默认结果只给引用、大小、媒体类型和读取方法，避免把整份 PDF 放入模型上下文。

#### 2.2.2 维护面

维护请求是用户明确开始的一次工作，范围与副作用必须可说明。元数据扩充和 PDF 获取/导入每次都需用户启动；Agent 可以代为执行已有授权，但一般科研问题、查询权限或成本预算本身不等于扩库授权。操作内部可以自动处理整个冻结批次，无需逐篇确认。

| 目标操作                       | 会发生的工作                             | 成功边界                               |
| ------------------------------ | ---------------------------------------- | -------------------------------------- |
| discoverMetadata               | 访问选定 Provider、接纳来源与身份        | observation/文献事实已提交，不下载 PDF |
| acquirePdf                     | 执行允许路线、必要时受控 Browser         | 字节与文章归属通过，资产关系已提交     |
| ingestPdf / ingestBibliography | 接收明确提供的文件/记录并验收            | 合法材料/书目事实已提交                |
| parseDocuments                 | 对已有 MaterialRef 调用 parser、构建表示 | 精确版本的中性结果与表示可读           |
| analyze / synthesize           | 对固定已有输入调用模型、发布知识         | 内容、证据、覆盖与依赖完整提交         |
| submitExtractionBatch          | 验证外部候选并交付回执                   | 通用协议接纳，不代表科学验收           |

parse/analyze/extraction 不继承 acquire 权限。旧 `complete content` 仍是明确维护命令，可按兼容语义包含获取、解析和旧分析；新 query/knowledge 用例不能调用它作为缺口 fallback。

当前单篇知识维护使用 `Application.maintenance.analyze` 和受同源 Cookie/CSRF 保护的 `POST /api/v1/maintenance/analyze-knowledge`。协议封套为 `{protocol_version:1,request:KnowledgeAnalysisRequest}`，成功为 `{protocol_version:1,result:KnowledgeAnalysisReceipt}`。请求只支持一个有材料和可读表示的 `InputManifest` v1、`overview/detailed/question`、问题及可选默认 CAS（历史 budget 可省略且不执行）；模型和方法身份由服务端实际有效绑定决定，客户端不能伪造。`startMaintenanceWorkbench` 的表单先核对所选 PDF 和默认表示，再明确启动分析；`createQueryApplication(home).knowledgeRead.byId/list/default` 与 `POST /api/v1/query/knowledge-read|knowledge-list|knowledge-default` 只读，不启动模型。知识列表是按 Literature ID 的最近历史产物，按 ID 读取返回完整结构、片段证据和覆盖；v8 显式索引后的知识排序与混合 Context 见[知识查询](06-retrieval-context.md#410-处理器结果与混合-context)。HTTP 同源/JSON/版本和共享 parser 拒绝非法或重复键，维护断连/关闭会取消在途分析，已提交的知识仍保留。精确内容与 v6 依赖见[知识加工](05-knowledge-processing.md#2-分析与综合)和[版本化存储](07-versioned-storage.md#4-知识版本依赖与回收)。

单篇长文另用 `Application.maintenance.analyzeLong` 与 `POST /api/v1/maintenance/analyze-knowledge-long`，内层请求为 `KnowledgeLongAnalysisRequest` v2，外层仍是协议 v1。固定输入加工不设置业务 token、次数、累计输入或整篇时长预算；网页只选择长文模式、用途和输入。Analysis 实际执行局部调用和有界整合，只有完整处理及证据校验成功才发布 v1 知识产物；普通请求 v1 的全文字节含义不变。当前 TS 失败异常可携带调用统计；HTTP 返回安全错误 code 及适用的 reason/retryable，不声称已经返回详细成本账单。精确分块、邻接证据与整合限制见知识加工正文。

集合综合使用 `SynthesisInputManifest` v2、`KnowledgeSynthesisRequest` v3、内容/覆盖/产物 v2 的独立共享 parser，不把新字段塞进单篇 v1。`Application.maintenance.synthesize` 和受同源会话/CSRF 保护的 `POST /api/v1/maintenance/synthesize` 接受精确固定的集合、问题和覆盖政策（历史 budget 保留读取兼容但不执行）；执行前重新准备并核对 manifest。`createQueryApplication(home).synthesisPreparation/synthesisRead` 与 `POST /api/v1/query/synthesis-prepare|synthesis-read|synthesis-source|synthesis-list` 提供只读准备、按 ID 阅读、来源和有界列表。维护页显式选择文档/知识来源并展示固定缺口，查询页展示覆盖、共识/分歧和逐条来源的当前状态，并只展开被引用的来源断言及其证据；展开时复核固定内容 hash、manifest、层级和断言 hash，证据按有界续页读取。排除行表示本次无固定引用，不表示已经查询当前来源可用性。真实用户库不会因解析新合同或打开页面而迁移。当前执行先对有文档的来源做有界局部分析，再以**一次有界集合归并**处理全部候选；实际模型/协议无法容纳单次 AgentCall 时返回相应失败且不发布，不承诺多层集合归并或人工科研质量评估。

### 2.3 应用面、adapter 与公开合同

按 [ADR 0033](../decisions/0033-machine-interfaces-cover-web-capabilities.md)，两个机器入口分别覆盖 Web 业务能力。`entry/query-operations.ts` 共享只读合同和固定输入准备；`task-read.ts`、`task-operations.ts`、`metadata-operations.ts`、`maintenance-operations.ts` 复用任务和业务 owner；`configuration-operations.ts` 为非交互配置适配提供同一配置 owner。HTTP 保留 Cookie/CSRF、传输取消及原有封套，CLI/MCP 保留既有入口并增加结构化调用。目标覆盖与当前缺口须区分，当前调用见 Agent 指南。

建议未来按 `Application.query.*` 与 `Application.maintenance.*` 暴露用例组。精确代码命名在对应实现中确定，但职责不能因 MCP/HTTP/SDK 改变。

```text
外部 Agent / CLI / 人类 Web
          ↓ 输入解析、协议版本、副作用说明
       产品 adapter
          ↓ 中性 request / result
       Entry / 应用用例
          ↓ 明确 owner 的公开 Port
       文献、材料、文档、知识、提取服务
```

adapter 负责边界校验、取消映射、有界序列化和稳定错误，不实现身份合并、PDF 验收、分析 prompt、候选 schema 规则或隐式重试整个业务操作。用户原始文件路径仅在本地 CLI adapter 转为受控 intake；远程消息不能指示服务器读取任意本机路径。

新 wire 使用 `protocol_version: 1`，新领域对象按独立 `schema_version` 解析。旧 ParserResult/LiteratureContent、CLI 报告与 `/api/library/*` 继续其既有字段；不往旧严格 schema 塞进新字段冒充兼容。

### 2.4 当前只读 API

当前公开导出为 `createQueryApplication(home, options?)`。它提供 Library 的 search/detail/references/referenceDetail、`literatureArtifacts.withArtifact`、readiness 与 close。调用方必须释放应用生命周期，不能拿到内部 SQLite worker 或绝对资产路径。

QueryApplication 的状态为 ready、not-initialized、unavailable。缺库不初始化；未知 schema 不升级；待恢复的 Job/回执不触发恢复。已提交资料可独立读取，损坏按对应读取报错，不降格成零命中。

`startQueryOnlyWorkbench({ home })` 提供独立阅读页，当前 HTTP 合同为：

| 路由                           | 方法与输入                                                    | 结果                      |
| ------------------------------ | ------------------------------------------------------------- | ------------------------- |
| `/api/v1/query/status`         | GET                                                           | v1 envelope 与 readiness  |
| `/api/v1/query/search`         | POST `{ protocol_version: 1, request }`，LibrarySearchRequest | 已有 LibrarySearchPage    |
| `/api/v1/query/read`           | POST，同 envelope，Literature ID                              | 既有 LiteratureDetail     |
| `/api/v1/query/references`     | POST，同 envelope，引用分页请求                               | 既有引用页                |
| `/api/v1/query/reference`      | POST，同 envelope，Reference ID                               | 引用关系详情              |
| `/api/v1/query/artifact`       | POST，同 envelope，文献 ID 与受支持 kind                      | 校验后的文件或明确缺口    |
| `/api/v1/query/material-bytes` | POST，同 envelope，显式 Literature ID、Asset ID、预期 SHA-256 | 校验后的固定原 PDF 字节流 |

该协议服务当前 Library；不能向它传入未来 KnowledgeQuery 然后声称支持文档片段。artifact 成功可以是二进制响应，失败/缺口为结构化 JSON；客户端不能无条件按 JSON 解码所有响应。`material-bytes` 按显式稳定资产 ID/hash 读取主件或补充件，不按 current 重选；流正常结束后客户端仍应校验完整 hash。它不暴露内部文件路径，也不提供任意 range 或持久读取会话。

按 [ADR 0035](../decisions/0035-authenticated-remote-web-access.md)，正式 Web 默认监听所有 IPv4 网卡，Web 访问统一登录，不存在本机免登录分支或固定公开 origin 配置。使用操作者指定的密码，或将自动生成的 256 位 API key 仅返回启动调用方显示。HTTP access owner 在业务路由之前保护 HTML、资料、配置与流；Host 只接受 IPv4 字面地址/localhost，Web Origin 必须与请求 Host 一致，不信任转发头。tab grant 绑定登录会话，注销/过期撤销观看连接。设备连接是 [ADR 0058](../decisions/0058-import-system-and-agent-access.md) 规定的独立认证边界，见下节；不授予 Web 会话权限。没有远程多租户身份系统，已有 stdio MCP 与显式工作台连接保持原协议。

#### 2.4.1 设备连接与按用途准入

`workbench/device-connections.ts` 拥有一次性配对与设备认证，生产和合成 Web 组装到同一 HTTP 地址。连接码为 `sr-connect1:<encodeURIComponent(address)>:<pairing_code>`；地址只接受带明确端口的 localhost/IPv4 HTTP origin，生成时必须与已登录请求的 origin 相同。`pairing_code` 为 `srp1_` 加 32 随机字节 base64url，10 分钟后失效。`POST /api/v1/device-connections/exchange` 接受 `{pairing_code}`，一次成功后返回 `{protocol_version:1,result:{connection,token,token_type:"Bearer"}}`；token 为 `srd1_` 加独立 32 随机字节 base64url，仅该响应交付一次。敏感交付响应禁止进入普通审计、日志或前端持久状态。

令牌仅通过 `Authorization: Bearer ...` 使用；URL/path/query 中的认证材料在路由前拒绝。令牌请求忽略 Origin/跨站提示但保留 Host 地址检查，不信任转发头，也不宽开 CORS；未携带令牌的 Web/SDK 接口继续原认证。携带 Authorization 时绝不回退到同一请求的 Web Cookie。令牌不能登录、取得 Web client/CSRF、访问配置/凭据、管理设备或观看 Browser WebSocket。

用途为 `capture/import/read/operate`，非空且彼此不隐含；当前导入会话登记为 `import`，见[导入会话 HTTP](#242-导入会话-http)。唯一登记点 `bootstrap/device-routes.ts::deviceBusinessRoutes(application)` 返回用途—接口表，`DeviceRouteRegistry` 只允许新 import/capture 命名空间和 `/mcp`，每个精确方法/路径（允许受限 `:id`）列出可接受的用途。MCP 同时在列出和调用工具处检查用途，见[HTTP 版 MCP](#http-版-mcp)。未登记的所有既有 query/maintenance/管理路径均拒绝令牌。每次认证从 catalog 核对撤销并更新 last_used_at，无跨请求授权缓存；撤销不回滚先前已接纳的操作。

Web 管理均为 POST，要求登录 Cookie、工作台 Cookie、client_id、同源、`X-Workbench-Csrf` 和 `X-Sciretriever-Protocol-Version:1`。封套为 `{protocol_version:1,request}` / `{protocol_version:1,result}`：

| 路由（均可带原 Web client_id）        | request                        | result                                      |
| ------------------------------------- | ------------------------------ | ------------------------------------------- |
| `/api/v1/device-connections/pairings` | `{address,name,purposes}`      | `{connection,expires_at,connection_code}`   |
| `/api/v1/device-connections`          | `{cursor:null\|connection_id}` | `{items,next_cursor}`，每页 200，按 ID 升序 |
| `/api/v1/device-connections/rename`   | `{connection_id,name}`         | `{connection}`                              |
| `/api/v1/device-connections/revoke`   | `{connection_id}`              | `{connection}`，幂等                        |

`DeviceConnection` 只含 UUID connection_id、1–120 字符 name、purposes、created_at、nullable paired_at/last_used_at/revoked_at；列表不返回 token、配对码或其派生值，包含未配对与已撤销项。用途变更需重新连接。管理不走记录请求/响应的通用 operation wrapper。换令牌由 catalog 事务消费配对码，次数限制跨进程/重启共享：直接 socket peer 每 60 秒 10 次、全局 60 次；包括失败和畸形尝试。短期桶有界，不保存 peer 原值。

任一有效令牌可 GET `/api/v1/device-connections/instructions` 与 `/api/v1/device-connections/skill`；未带 Authorization 的登录 Web 用户也可通过原 Cookie、工作台 Cookie、client_id 和同源准入下载（GET 不要求 CSRF）。有 Authorization 时只走设备认证，不回退 Cookie。两种入口读取同一固定构建产物 `apps/server/dist/agent-access/instructions.md`（1 MiB 上限）和 `skill.zip`（8 MiB 上限）。内容和打包由独立构建工作提供；产物不存在、不是普通单硬链接文件或超限时返回 `device-artifact-unavailable`（503），不读取个人文件。成功响应 no-store/nosniff，分别为 Markdown、ZIP 附件。

设备错误统一为 `{protocol_version:1,code}`：`device-input-invalid`/`device-pairing-invalid`/`device-token-in-url`（400），`device-address-mismatch`/`device-purpose-forbidden`（403），`device-pairing-expired`/`device-pairing-used`（409），`device-exchange-rate-limited`（429，Retry-After 60），`device-token-invalid`/`device-revoked`（401），`device-connection-missing`（404），`device-artifact-unavailable`/`device-unavailable`（503）。实际 SQLite 损坏保留 `catalog-corrupt`（503）和 `maintenance_hint:"verify-catalog"`；未知内部异常不透传。Web 原有认证错误保持。持久化与迁移见[设备认证存储](07-versioned-storage.md#8-设备认证存储)。

#### 2.4.2 导入会话 HTTP

`workbench/import-http.ts` 在设备用途表登记 `/api/v1/import/` 路由。设备以 Bearer 令牌及 `import` 用途调用；登录 Web 用户经既有 Cookie、client_id、Origin 和 POST CSRF 规则调用同一处理函数。不带设备 Authorization 的请求不获得设备身份，带 Authorization 的请求不回退 Cookie。

JSON POST 要求 `X-Sciretriever-Protocol-Version: 1`、`Content-Type: application/json`，输入 `{protocol_version:1,request}`，成功 `{protocol_version:1,result}`；未知字段拒绝。下面路径都以 `/api/v1/import` 为前缀，`:session_id`、`:file_id` 为服务返回的 UUID：

| 方法与路径                                        | request                                                                                                                              | result                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| GET `/instructions`                               | 无正文、无需协议头                                                                                                                   | 支持格式、中性模型、端点、限制、错误码与认证说明      |
| POST `/sessions`                                  | `{format,library:null\|{system,library_id,identity:"global"\|"local",name},scope,import_user_tags?:boolean,file_name?:string\|null}` | `{session}`                                           |
| POST `/sessions/list`                             | `{cursor?:session_id\|null,limit?:number}`                                                                                           | `{items,next_cursor}`                                 |
| POST `/sessions/:session_id/status`               | `{}`                                                                                                                                 | `{session}`                                           |
| POST `/sessions/:session_id/data`                 | `{sequence,data}`                                                                                                                    | `{session}`                                           |
| POST `/sessions/:session_id/preview`              | `{}`                                                                                                                                 | `{session,estimated:true,summary}`                    |
| POST `/sessions/:session_id/confirm`              | `{}`                                                                                                                                 | `{session}`                                           |
| POST `/sessions/:session_id/files`                | `{cursor?:file_id\|null,limit?:number,pending?:boolean}`                                                                             | `{items,next_cursor}`                                 |
| POST `/sessions/:session_id/files/:file_id/hash`  | `{sha256}`                                                                                                                           | `{file}`                                              |
| POST `/sessions/:session_id/files/:file_id/bytes` | 原始 PDF 字节流，无 JSON 封套                                                                                                        | `{file}`                                              |
| POST `/sessions/:session_id/finish`               | `{}`                                                                                                                                 | `{session}`                                           |
| POST `/sessions/:session_id/cancel`               | `{}`                                                                                                                                 | `{session}`                                           |
| POST `/sessions/:session_id/report`               | `{cursor?:"sequence:record_index"\|null,limit?:number}`                                                                              | `{session,estimated:false,summary,items,next_cursor}` |

`library` 必填但可为 null，表示无来源库号的导出文件；返回的 session.library 始终为对象。精确的一次性来源身份、去重、分组及批次命名见[书目交换规则](03-literature-materials.md#61-书目交换规则)。传了 global/local 对象时沿用原验证，不能自行指定 adhoc 身份或命名空间。

`files.pending` 默认为 true；终态报告用 false 读取全部文件及冲突/缺失项。分页默认 50、最多 200。会话列表按创建时间/ID 倒序，报告按输入序号/条号，文件按 ID。书目阶段 `metadata_complete=false` 时文件清单仍会增长，完成后从空 cursor 重读最终清单。

JSON（含封套）最多 8 MiB，会话暂存数据共 256 MiB、50,000 条记录（含拒绝项）、1,024 段（序号 0–1,023）、10,000 个组、层级深度 128。每记录最多 1,000 组、1,000 用户标签、100 文件、10,000 批注，每批注最多 128 个矩形；精确字符串限制在 `IMPORT_LIMITS` 和合同 parser。PDF bytes 仅接受 application/pdf 或 application/octet-stream，不接受压缩正文，无文件大小上限；边写边算 SHA-256，至少保留 256 MiB 磁盘空间。现有手动 PDF 上传的 16 MiB 限制独立保留。

会话、记录、分组、文件、批注与报告的字段在 `packages/contracts/src/import-sessions.ts`；业务含义见[导入模型与会话规则](03-literature-materials.md#61-书目交换规则)。接口说明直接从同一服务的路由表与限制生成，供外部 Agent 查询，不依赖 skill 包，也不提供新的服务器文件读取能力。

失败响应为 `{protocol_version:1,code}`。设备与 Web 认证码沿用上一节；导入错误如下：

| HTTP | code                                                                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400  | `import-input-invalid`、`import-format-unsupported`、`import-local-identity-required`、`import-data-conflict`、`import-group-missing`、`import-group-cycle`、`import-group-depth`、`import-folder-target-missing`、`import-file-hash-mismatch`、`import-file-size-mismatch`、`import-upload-cancelled` |
| 404  | `import-session-missing`、`import-file-missing`、`import-literature-missing`                                                                                                                                                                                                                           |
| 409  | `import-library-busy`、`import-session-state`、`import-data-changed`、`import-metadata-pending`、`import-file-hash-required`、`import-file-upload-required`、`import-file-conflict`、`import-source-stale`                                                                                             |
| 413  | `import-request-too-large`、`import-session-limit`                                                                                                                                                                                                                                                     |
| 422  | `import-pdf-invalid`                                                                                                                                                                                                                                                                                   |
| 507  | `import-disk-space`                                                                                                                                                                                                                                                                                    |
| 503  | `import-disk-unavailable`、`import-unavailable`、`import-closed`                                                                                                                                                                                                                                       |

真实 SQLite 损坏仍返回 `catalog-corrupt` 和 `maintenance_hint:"verify-catalog"`，内部异常不透传。首轮文件哈希与已有 PDF 冲突是 HTTP 200 的 file.status=conflict；已结算文件的不同字节重放才是 `import-file-conflict` 错误。逐条身份/分组原因在报告中，不把部分成功伪装成整场失败。

工作台界面地址的 `setting` 白名单包含 `devices`，`/?view=set&setting=devices` 按原 Web 登录规则进入设备设置分区；未知分区仍为 `invalid-ui-location`。这不改变 API 或设备令牌的权限。

### 2.4.3 网页收藏 HTTP

`bootstrap/device-routes.ts` 将以下精确路径登记为 capture 用途。业务接口只接受设备 Bearer 令牌，无 Web Cookie 准入，不授予 import、MCP 或管理权限；认证、URL 令牌拒绝和撤销规则沿用[设备连接](#241-设备连接与按用途准入)。JSON POST 的协议头、严格封套及成功封套沿用导入 HTTP，但请求含封套最多 64 KiB；未知字段拒绝。`:capture_id` 为返回的 UUID，结果和文件始终绑定最初的设备连接。

| 方法与路径（前缀 `/api/v1/capture`） | request                                                                                                                                           | result                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| POST `/lookup`                       | `{identifiers:{namespace:"doi"\|"arxiv",value:string}[]}`，1–16 项                                                                                | `{found,literature_id,title,has_pdf,sha256}`；未找到时 nullable 字段为 null |
| POST `/folders`                      | `{cursor?:folder_id\|null,limit?:number}`                                                                                                         | `{items:FolderNode[],next_cursor}`；默认 50、最多 200，按 folder_id 排序    |
| POST `/save`                         | `{request_id:UUID,metadata:Partial<LiteratureMetadata>,folder_ids?:UUID[],file?:{file_name,size_bytes?:number\|null,sha256?:string\|null}\|null}` | `CaptureResult`                                                             |
| POST `/items/:capture_id/status`     | `{}`                                                                                                                                              | `CaptureResult`；尚未结算为 capture-pending                                 |
| POST `/items/:capture_id/file/hash`  | `{sha256}`                                                                                                                                        | `{file:ImportFileStatus}`                                                   |
| POST `/items/:capture_id/file/bytes` | 原始 PDF 字节，协议头及 Content-Type 同导入文件通道                                                                                               | `{file:ImportFileStatus}`                                                   |
| GET `/extension`                     | capture 令牌；或原登录 Web Cookie、client_id 与同源准入                                                                                           | ZIP 附件，无 JSON 封套                                                      |

`CaptureResult` 含 capture_id、batch_id、literature_id、disposition（created/enriched/matched）、metadata（`{status:"completed"|"partial"|"failed"|"unavailable",job_id:string|null,code:string|null}`）、missing_folder_ids、nullable file。file 沿用 ImportFileStatus，文件原因沿用共享通道的 `import-*` 值；HTTP 文件失败码转换为 `capture-*`。file 声明可省略，省略时不产生待交文件；有声明时每篇一份 PDF，外部引用固定为 pdf。folder_ids 最多 100；文件名、大小和哈希按原中性合同校验。页面字段、来源与补全语义见[网页收藏](03-literature-materials.md#网页收藏)。

收藏错误为 `{protocol_version:1,code}`：输入、缺标识及声明不符为 400（capture-input-invalid、capture-identifier-required、capture-file-hash-mismatch、capture-file-size-mismatch、capture-upload-cancelled）；请求超限 capture-request-too-large 为 413；capture-missing/file-missing/literature-missing 为 404；capture-identity-conflict/request-conflict/pending/file-conflict/file-hash-required/file-upload-required/source-stale 为 409；capture-pdf-invalid 为 422；capture-disk-space 为 507；capture-disk-unavailable/unavailable/closed 为 503。SQLite 损坏仍是 catalog-corrupt（503，verify-catalog 提示），不透传异常、SQL 或路径。metadata.code 的 metadata-unavailable、metadata-source-failed、metadata-task-failed 是 HTTP 200 接纳结果中的补全结论，不撤销书目。

安装包为 `apps/server/dist/agent-access/browser-extension.zip`，最多 16 MiB，由扩展构建工作提供；不存在、空文件、符号链接、非普通单硬链接文件、超限或读取中变化均为 device-artifact-unavailable（503）。复用说明/skill 的 no-store、nosniff、有界读取及固定附件规则。Web GET 不需要 POST CSRF，有 Authorization 时不回退 Cookie；安装包以外的收藏接口未开放 Web 分支。

### 2.5 新请求与结果语义

新操作应提供的通用元信息如下；用例专属字段由其 owner 定义，不构造通用任意 `operation + payload` 来跳过类型校验：

| 部分     | 要求                                                                   |
| -------- | ---------------------------------------------------------------------- |
| 能力说明 | 名称、支持协议/对象版本、输入/输出大小、所需前置、外部调用和写入副作用 |
| 范围     | 明确的文献/版本/manifest，或有界来源发现条件                           |
| 预算     | 该操作实际能控制的请求、字节、调用数与取消边界                         |
| 成功     | 已提交产物/回执与精确引用；无产物时明确原因                            |
| 部分结果 | 实际完成项、未处理项、失败与覆盖政策                                   |
| 失败     | 稳定 code/retryable、可安全呈现原因、精确提交边界                      |

查询 Gap 可给建议，但不能携带执行中的维护任务。工具调用成功和产品目标成功分开：HTTP 200、Job accepted 或 Provider 返回内容，都不能单独证明 PDF 归属或知识产物发布。

新 envelope、对象 schema、方法/spec、内容版本、控制 epoch 五类版本分别解释。npm SemVer 不替代这些协议；未知字段/版本由边界明确拒绝或通过文档化兼容 reader 处理，不能默默忽略。

### 2.6 材料与证据的受控交付

材料读取只接受由事实 owner 返回的稳定引用，校验范围、size/hash/media type 后在受控生命周期中提供字节。远程 adapter 使用自己拥有的响应流，不暴露服务器路径、Storage handle 或临时下载 URL。

Document/Evidence 返回精确版本的片段、资源与 EvidenceRef。知识产物返回用途、输入、方法、证据与覆盖；旧 LiteratureContent 若以兼容投影展示，要标 `legacy-final-content`，不凭空补上字段级证据。

上下文预算作用于实际响应内容；继续位置绑定范围与版本。资源未读取不能算作模型已经看过，截断必须保留。导出是用户请求写出的副本，不改变文献库事实；目标冲突与原子发布沿用本地导出合同。

### 2.7 长操作、重复执行与取消

普通 TS/HTTP 调用和 durable Job 是不同交互模式。接纳 Job 只说明执行意图已保存，结果以实际 owner 提交为准。MCP stdio 在服务进程内继续已提交工作；进程退出停止执行，重启后显式恢复，具体实现见本篇 MCP 小节和任务协调文档。

维护开始前冻结已有材料 ID/hash；发现操作固定来源条件与预算，未知结果按实际接纳顺序记录。请求取消停止新的工作，正在执行的网络/模型/Browser 动作尽力取消并如实结算。已提交事实保留，不能将取消映射为数据库回滚整个操作。

重复提交必须按用例合同处理。获取可从已有有效资产复用；模型重算不能承诺不重复收费；Extraction 的 submission scope/回执寿命另有冻结项。adapter 不能遇到超时就无条件重新提交写操作，响应丢失需要区分“未提交”与“结果未知”。

控制 Browser 的请求另带 session/文章/epoch/revision，陈旧动作拒绝；它不沿用一般 API request_id 作权限证明。人工指导与低层浏览器控制也不默认对外部 Agent 开放。

### 2.8 错误和敏感信息边界

| 错误类型                              | 对调用方的意义                                |
| ------------------------------------- | --------------------------------------------- |
| invalid-request / unsupported-version | 请求不能按该合同解释，修正后重试              |
| not-initialized / missing-input       | 前置不存在，需要用户明确另一操作              |
| capability-unavailable                | 当前对象图没有所需能力，不自动更换服务        |
| conflict / stale-binding              | 输入、默认关系或控制版本已变，应重新读取      |
| integrity-failure                     | 文件/版本/证据不一致，不能当作空结果          |
| external-failure                      | 已脱敏的 Provider/Parser/模型失败与 retryable |
| cancelled / budget-exhausted          | 停止原因与实际已提交结果                      |

这些分类用于新合同设计，既有 code 保持。外部异常、SDK 对象、完整 URL query、Cookie、header、prompt 和个人路径不进入结果、provenance 或日志。合理诊断需要 provider/model/operation 与稳定失败，不能以泄露原请求替代。

查询和配置状态不触发 probe。显式 probe 可能联网/耗费额度，其副作用单独说明；不能在能力发现里默默调用模型来“看看能不能用”。

### 2.9 典型调用流程

已有材料分析：query 搜索 → 读取并选择具体文献/版本 → 建立 manifest → 明确 analyze → 得到 KnowledgeArtifact → query 展开 EvidenceRef。缺 PDF 时分析返回缺口，到此结束；用户另行启动 acquire 才扩库。

外部提取：读取能力 → 绑定调用方 Spec 与 manifest → read/检索/展开证据 → 外部程序提取 → submitExtractionBatch → 获得候选与校验回执 → 下游科学接纳。整条路径允许没有内部模型配置。

当前只读准备段由 `createQueryApplication(home).extractionPreparation.prepare({spec,inputs})` 和 `POST /api/v1/query/extraction-prepare` 提供：校验规范与有序输入，返回固定材料 manifest、能力与缺口；查询页提供同一表单。它不创建 operation 或回执。显式接纳段由 v5 维护 Application 的 `extractionDelivery.create/submit` 和受同源会话/CSRF 保护的 `POST /api/v1/maintenance/extraction-operation|extraction-submit` 提供；维护页可创建 operation、提交有界批次、关闭/取消、读取回执及清理。两个 HTTP 面均使用 `{protocol_version:1,request:...}` 封套与严格 JSON 解析，成功返回 `{protocol_version:1,result:...}`。提交不继承 query 的只读身份，也不启动获取、解析或模型；spec、manifest、批次、期限与错误码见[知识加工合同](05-knowledge-processing.md#4-调用方规范与提取交付)和[用户指南](../../guides/knowledge-processors.md#提取范围和证据)。

准备请求与结果使用共享运行时 parser；结果必须对应所请求规范、输入顺序、资产 hash 和显式文档版本。文件或文档损坏报告 `input-integrity`，明确缺失报告 `input-missing`，关闭/断连会取消并等待在途读取。只读入口不会因为能力缺口生成文件级替代片段证据。

人工辅助获取：明确 acquire → Browser 流程需要帮助 → 人类观看/指导/接管同一会话 → Acquisition 验收候选 → query 读取已接纳材料。人类完成点击不等于文件已验收成功。

### 2.10 验证与安装边界

验证必须从实际公开包/adapter 进入 Entry 和真实内部读取/发布边界，只隔离外部 Provider、模型、parser 和 Browser vendor。仅 mock Application 返回值不能证明查询隔离或发布成功标准。

需要覆盖安装后的公开导入、无库冷启动、当前 v1/v2 reader、错误/二进制响应、范围与预算、取消/关闭、重复提交冲突和缺口无副作用。新知识对象还要验证未知 schema、旧 ID/hash 保持、产物来源与证据可展开。

当前 TS 查询面可作为这些能力的基础；完整 MCP 工具名、异步 operation handle、远程权限和候选回执不能在实现前写进用户指南作为可用功能。接口设计可审阅与产品已经交付应分别报告。

## 3. CLI 与输入输出适配

### 3.1 入口边界

CLI 或其它入口只负责：

- 解析用户参数和输入文件；
- 对手动 PDF 解析用户选择的具体 Literature 和输入路径，但不把绝对路径写入业务 Model 或持久化结果；
- 把外部值转换为 Model；
- 调用 Entry 公开 API；
- 呈现稳定结果和退出状态。

入口不执行身份收敛、元数据 precedence、PDF 检查、内容判断、SQL、网络或供应商协议。未知字段、组合和枚举在边界 fail closed；底层 traceback 不直接成为用户合同。

当前是否已经存在受支持 CLI 由 README、用户指南和安装后测试说明，不能从目标目录推断。

#### 3.1.1 Entry 公开 API

完整目标接口见[Entry 公开 API](#91-entry-公开-api)；当前实现以源码为准。

#### 3.1.2 文献操作 CLI 与 operator 入口

安装后的命令根固定为 `sciretriever`。根级 `--debug` 选择逐步骤脱敏日志，默认使用正常日志；该选项不改变任何用户请求、Report、退出状态或持久化事实。一级名称按用户操作而不是内部模块划分为：

```text
discover
complete
literature
import
export
config
```

当前目标命令路径固定为：

```text
sciretriever discover topic
sciretriever discover citations

sciretriever complete pdf|content

sciretriever literature search
sciretriever literature show
sciretriever literature references
sciretriever literature cited-by

sciretriever import metadata
sciretriever import pdf

sciretriever export metadata
sciretriever export pdf
sciretriever export content

sciretriever config
sciretriever config status
sciretriever config test provider <name>
sciretriever config test model <provider/model> [--image]
sciretriever config test search <source>
sciretriever config test search --all
sciretriever config test download <source>
sciretriever config test download --all
sciretriever config test parse
sciretriever config test analyze
sciretriever config test browser model
sciretriever config test browser site <publisher-access-key>
sciretriever config test --all
```

命令语义为：

- `discover topic` 和 `discover citations` 分别形成领域或引用 DiscoveryRun；
- `complete` 接收一个类型化范围和 `pdf`/`content` 目标，分别映射到 `ASSET_READY`/`CONTENT_READY`，不再按 Acquisition、Parsing 和 Analysis 拆成用户命令；
- `literature search/show/references/cited-by` 只读取本地文献数据库，整个 `literature` 组保持只读；
- `import metadata` 读取 BibTeX/BibLaTeX、RIS 或 CSL JSON，允许创建或命中 Literature；
- `import pdf` 必须指定一个已经存在的具体 Literature，复制、检查并接纳用户 PDF，不隐式继续 Parsing/Analysis；
- `export metadata` 按已接受的导出范围与格式原子发布书目文件；
- `export pdf` 和 `export content` 从一个具体 LiteratureDetail 取得当前主 PDF 或规范轻结构化 Markdown 引用，再按 artifact 导出规则写入用户目标。
- 所有正常命令都经 Configuration 读取固定的 `~/.sciretriever/config.toml`；Entry 不读取配置路径
  环境变量、不检查当前工作目录，也不提供 `--config`。正式 `web` 在固定文件缺失时保存默认存储路径并准备空库；其它入口保持各自的缺失配置诊断与只读边界。
  裸 `config` 把缺失文件视为尚未写入的空当前配置，打开统一交互中心，并在第一次确认普通配置
  修改时创建该文件。已有普通配置与凭据必须在首页前通过唯一当前 schema 的严格读取；malformed、
  未知 section/key、无效值、旧 singleton/Service/Profile/Entry 普通配置或旧 credentials
  `[agents]`/`[models.*]` 都返回退出码 4，
  不显示菜单、不写文件，也不提供 Reset、迁移、恢复或 fallback。operator 手工修复精确文件后，
  才能从当前入口重新配置。首页固定为单词级
  `Models / Search / Download / Parse / Analyze / Browser / Status / Theme / Quit`。Models 管理 Model
  Provider、完整 `provider/model` Model 与 Provider key；Search/Download 在具体 Source 对象页就近
  管理普通设置、凭据与 probe；Parse 用 Setup 连续配置 MinerU 服务、上传授权与 token；Analyze 与
  Browser 用各自 Setup 选择 Model 并管理业务参数，Browser 还独立拥有 Profile 与 Runtime。新增
  Model 时，远程 Provider key 在同一流程隐藏输入；key 就绪后 Entry
  让 Bootstrap 通过共享 Network 自动获取一次有界、非持久模型目录，只有失败、为空或不能安全
  解析时才出现 Manual。该 GET 不是首页、`status` 或模型 probe。公开子命令只保留
  `status/test`，旧 `set/remove` 路径拒绝。
  `config status` 只做本地状态检查，分别呈现 Model Providers/Models、credential presence、
  Analyze/Browser Model readiness 和 Cloak
  wrapper/binary/version/identity manifest，不启动模型或 Browser；`config test` 是用户显式发起的
  owner-scoped 配置诊断。Provider 目录、精确 Model、Search Source、Download probe availability、
  Parse、Analyze、Browser Model 与显式单目标 Browser Site 共用一个无 Storage Probe dispatcher。
  Download 不借用 Metadata 或下载任意 PDF；Browser Site 不进入 `--all`。这些动作都不读取或写入
  文献数据库，也不形成五类 Entry Report；真实能力仍由 `discover topic`、`complete pdf` 与
  `complete content` 承担。

这里不建立 `exchange` 一级组，也不使用容易被理解为参考文献列表的 `bibliography` 命令名；书目信息文件统一称为 `metadata`。`metadata`、`acquisition`、`parsing`、`analysis` 和 `artifact` 是内部责任/资源名称，不是对应的当前一级业务命令。当前另有 `jobs`、`storage`、`doctor`、`workbench` 等运行/维护入口，精确选项见 `cli/main.ts`；通用 artifact 能力由 TypeScript 受控读取 API 提供，CLI 只暴露用户实际需要的 PDF 与 content。`config` 表达用户配置动作，不把 Configuration 提升为新的文献业务模块。

每个命令把外部参数严格解析成对应中性输入；selector、分页、格式、目标文件、`--json` 和 `--debug` 等参数组织不能改变对应 Model 语义。真实密钥不得作为普通 option 或位置参数，只能由裸 `config` 管理器通过不回显交互读取。管理器提示和结果写 stderr 且不提供 `--json`；其它命令的稳定文本或 JSON 主结果写 stdout，正常或 Debug 实时进度和脱敏诊断写 stderr。当前 CLI 已提供这些受支持路径；目标合同中尚未接线的 cohort/Browser runtime 能力仍必须在 README、用户指南和 当前 CLI/package 公开入口 之外明确标为目标或未运行。

### 3.2 查询与书目交换

查询调用 Literature 公开 API，使用 Storage 提供的一致 read-only snapshot。Entry 只负责把 CLI/JSON 等外部输入解析为 [本地文献数据库查询与详情](06-retrieval-context.md#21-本地文献数据库查询与详情) 的中性合同，并呈现结果；它不回放身份或状态规则。

本地搜索接收 `LibrarySearchRequest` 并直接返回 `LibrarySearchPage`；用户从列表选择一个具体 `literature_id` 后，单篇详情读取直接返回临时组装的 `LiteratureDetail`。引用浏览接收 `LiteratureReferenceRequest` 返回 `LiteratureReferencePage`，打开一个具体 `reference_id` 返回 `ReferenceDetail`。这些读取都不创建 DiscoveryRun、不访问外部 Provider、不修改数据库、不形成 Report，也不保存查询、cursor、页面或详情结果。具体 Literature 或 Reference 不存在时返回稳定 not-found 读取错误，不能伪造空 Detail。

`QuerySelector` 只复用 `LibraryQuery` 条件，在数据库补全开始时从当时的一致 snapshot 展开完整范围；它不接收或复用 `LibrarySearchRequest.sort/limit/cursor`，也不把用户先前看到的一页结果当成冻结目标。`LiteratureReferencePage` 同样不能成为数据库补全 selector；它只是同一权威 Reference 的正向或反向读取。

列表和详情中的 artifact 只有稳定引用。`open_artifact` 把 `Asset | ParserArtifactRef | ArtifactRef` 交给 Literature 的 verified artifact reader 并返回 context-managed 只读 binary stream；`export_artifact` 使用同一 reader 原子写入用户目标。两者都不把 I/O 放进 `LiteratureDetail`，也不暴露内部绝对路径、修改数据库或形成 Report。目标文件默认不覆盖，调用方明确要求覆盖时仍必须使用同目录 staging 和原子替换。

`codecs/` 固定支持：

- BibTeX/BibLaTeX；
- RIS；
- CSL JSON。

Codec 只在外部文件与 `packages/contracts` 的书目边界合同 边界记录之间转换。边界记录直接组合现有 `LiteratureMetadata` 和输入序号，不复制 BibTeX/RIS/CSL 字段建立第二套导入元数据 schema。导入接纳、身份处理、来源优先级、导出资格和字段取舍属于 Literature。

导入 codec 先形成带零基 `record_index` 的有序记录或逐记录格式失败，使 `ImportReport.input_record_count` 在接纳开始前确定。对每条结构有效记录，Entry 只补充固定的 user/bibliographic-import Provenance 并交给 Literature：未命中为 `created`，命中后以非空用户值补缺或替换当前 Provider 值为 `enriched`，命中且当前统一投影不变为 `matched`，格式、最低识别条件或稳定标识符冲突为 `rejected`。首次与 Provider 当前值相同的 matched 仍保存 user observation；只有完全相同的规范化 user observation 已存在时才复用而不重复插入。`CONTENT_READY` 对象的 enriched 只表示新 observation 已接纳并可供下一次完整 Analysis 使用，不表示 Entry 拆开覆盖当前 metadata/content。前三种接纳结果的 MetaLiterature ID 按首次出现顺序去重形成 `accepted_meta_literature_ids`。单条错误不撤销其它记录；中断时已经完成的逐条结果保留，尚未接纳的 index 进入 `not_processed_record_indexes`。调用方后续可以把非空 `accepted_meta_literature_ids` 明确提交为 `ImportReportSelector`，Entry 仍重新读取 current facts。

导出使用一致 snapshot，把最终选中的具体 Literature ID 冻结在当前进程，写入目标目录下 owner-only staging file，flush、`fsync` 后原子替换目标文件；用户不能观察到部分输出。只有成功发布的对象进入 `published_literature_ids`，无法编码的单条记录进入 `skipped`，目标格式不能表达的字段进入带 LiteratureId 的 `omissions`。中断或操作级失败时不发布 staging file，已经编码但未发布的对象仍归入 `not_published_literature_ids`，旧目标文件保持不变。导出不要求 Literature 已完成全文处理，Report 不保存输出绝对路径或文件字节。

## 4. 人类工作台与知识阅读

### 4.1 功能与子模块

Web 面向人的独立日常操作，CLI/MCP 主要服务 Agent 与自动化。正式 Web 首次启动由 Configuration owner 补齐缺失存储路径为 `~/.sciretriever/catalog.sqlite` 和 `~/.sciretriever/artifacts/` 并按 revision CAS 保存。Bootstrap 对不存在的目标调用 Storage 的 create-if-absent 初始化，直接进入工作台，不要求先运行配置向导或 CLI 建库；已有路径优先，已有库不自动升级、覆盖或搬迁。自定义数据库文件的父目录须已存在。只读入口不执行该准备过程。具体默认存储决策见 [ADR 0018](../decisions/0018-fixed-user-configuration-home.md)。

| 子模块     | 交互功能                                      | 真实业务 owner                    |
| ---------- | --------------------------------------------- | --------------------------------- |
| 配置编辑   | 表单/草稿、校验、保存、显式 probe、生效反馈   | Configuration                     |
| 运行观察   | 当前目标、阶段、真实页面、动作与下载/验收状态 | Entry、Browser、Acquisition       |
| 指导与控制 | 指导、暂停、接管、交还、取消、过期反馈        | 应用协调与 Browser control        |
| 知识阅读   | 搜索、文献版本、PDF/文档、总结与证据展开      | Literature、Document、Analysis、Q |
| 维护操作   | 明确选择来源/目标，启动发现、获取、导入或加工 | 对应 Entry 用例                   |

UI 只持有展示与交互草稿。配置默认值、来源排序、材料有效性、任务终态和控制权都由服务端 owner 返回；前端不能根据按钮是否禁用推断获得了操作权限。

Web 的定位与设计依据见 [ADR 0032](../decisions/0032-library-centered-web-workspace.md)、[ADR 0038](../decisions/0038-web-design-basis.md)，页面排布见[页面规格](../web/page-specs.md)。查询与写操作围绕同一对象显式区分，不把后台用例逐个平铺为表单。此处的功能/owner对照说明业务归属，代码分工见下节。

### 4.2 当前代码与连接

```text
apps/web/src/
  app/data/       # HTTP封套、Query缓存、URL、固定来源和本机偏好
  app/components/ # React Aria控件、焦点、弹层和统一状态
  app/motion/     # Motion预设与减少动效
  app/shell/      # 侧栏、阅读标签、活动与错误边界
  app/features/   # 库/阅读/检索/处理/任务/Browser/设置及独立入口
  reading/        # PDF.js、Markdown/KaTeX、续读与证据框架无关引擎
  browser-platform.ts # 普通HTTP下的随机ID与主动复制
apps/server/src/workbench/
  http.ts         # 本地 HTTP、配置/阅读/会话边界
  session.ts      # WorkbenchSession、目标、控制与观察
  production-session.ts # 显式生产获取与当前文章会话投影
apps/server/src/browser/
  control.ts      # 控制者与 epoch
  observation.ts  # 观察 revision 与元素
  page-runtime.ts # 真实页面观察/动作
apps/server/src/bootstrap/workbench.ts # 工作台对象图与关闭
```

`startQueryOnlyWorkbench` 只组装 QueryApplication；混合 live 工作台仍依赖完整 Application。`startProductionWorkbench({ home, literature_id? })`（CLI `sciretriever web`）打开本机工作台时不发起获取；省略初始文献时投影 `WorkbenchView.article_id:null`，已选文献、文章 session 与动作仍使用非空身份。同源 `POST /api/acquisition/start` 接到该 Application 的 `DatabaseCompletionService.run`。进入 Browser 层后，工作台经生产文章 flow 的开页回调观察/控制同一个 Host page；不为画面另启 Browser。生产 `/api/control` 除 `kind`、`control_epoch` 外还要求当前 `session_id` 与 `article_id`；尚未开页的显式操作可用同一绑定的 `cancel` 中止。生产 view 的可选 `operation_feedback` 包含真实阶段、冻结后的目标分区与当前目标、最终报告、稳定失败，以及操作后 Library 校验文件字节才确认的主 PDF hash/大小；文件丢失或损坏时标记 `unreadable`，不提供阅读引用。旧合成预览保留既有控制请求形状和 v1 view 字段集。文献库入口使用同一 Literature ID 和既有 detail/artifact，只读刷新不调用获取。下一篇需要新的明确获取操作，旧文章请求不复用。

正式库中心Web由 `apps/web/src/app/` 在 `/` 提供，通过 `/api/tasks` 调用同一 `ProcessingTaskService`，PDF获取复用已有Job owner，解析/身份核验/知识分析/综合复用固定 `ProcessingTaskRequest`。创建、启动与控制是显式写操作；查询、结果阅读和证据展开不提交任务。任务详情展示结果、跳过、失败及有界活动记录。`/api/workspace` 返回启动时的catalog/artifact绑定和能力；`/api/discovery`（主题与引用扩展）保存并运行同一元数据任务，回执附 job_id 与来源汇总；`/api/import` 仍是书目导入 Entry 的显式薄适配。来源统计的三端读取与计数合同见[任务技术篇 10.1](02-task-coordination.md#101-获取来源记录与统计)。

React以React Aria管理键盘/焦点/浮层，TanStack Query管理请求生命周期，Virtual/Table管理长列表与结果，Motion和集中CSS tokens管理交互呈现。Vite声明式资源清单随server安装包交付；生产CSP不增加JavaScript eval、内联脚本或运行时style标签。共享纯读取投影在 `app/data/`，固定PDF/Markdown引擎在框架无关的 `reading/`。正式入口仅 `/` 及维护服务所需 `/query`，静态资源前缀为 `/assets/`。`/next` 路由与旧 `workspace` URL 别名已经撤销，不提供兼容跳转。

同一正式 HTTP server 在 Host/Origin/Cookie/client/CSRF 验证后复用完整 `/api/v1/query/*` 与 `/api/v1/maintenance/*` handler，QueryApplication 固定到启动时同一数据库/资产目录。配置保存不切换已打开的运行库。独立 query-only 仍仅有读取能力，独立 maintenance 保留原有认证；共用 handler 不扩大只读部署权限。正式启动、配置与运行边界见[Web 指南](../../guides/web-workbench.md)。

#### 4.2.1 统一处理器 HTTP 适配

处理器沿用 `entry/processor-operations.ts` 的 `queryProcessors` 与 `submitProcessor`，与 CLI/MCP 共用冻结、执行与结果 owner。生产工作台和独立维护入口通过 `processorHttpAdapters` 显式组装提交能力；只读入口没有该适配。维护对象保持原 owner 引用，新增提交适配单独传入 HTTP handler。

| 路由                                        | 请求                                                                                                                                                       | 成功回执                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `POST /api/v1/query/processors`             | `{protocol_version:1, operation, request}`，operation 为 list/read/results/collections/collection/search/search-collections/query/evidence/export/transfer | `{protocol_version:1, result}`                                               |
| `POST /api/v1/maintenance/processor-submit` | `{protocol_version:1, request:ProcessorBatchRequest, start:boolean}`                                                                                       | HTTP 202，`{protocol_version:1, task}`；task 包含持久 job_id，不表示执行完成 |

两端严格解析 JSON 封套、拒绝重复键和未知字段；查询参数复用对应 action 合同。正式工作台要求同源 Cookie、client grant 与 `X-Workbench-Csrf`；维护请求另带 `X-Sciretriever-Protocol-Version:1`，独立维护部署继续使用自身 Cookie/CSRF。仅查询部署的提交路由返回 404，不会因读取 registry 组装写入能力。旧 catalog 可读取离线 registry，读取 v10 结果返回 `catalog-v10-required`，不会隐式升级。

处理器查询 wire body 限 310 KiB，批量提交 wire body 限 1 MiB，普通 HTTP 命令的 64 KiB 上限保持不变；业务规范和输入数量另由共享 parser 校验。该 HTTP 结果封套最多 16 MiB，超限返回 `processor-response-too-large`，不截断后冒充完整结果。此上限不改变结果文件的 8 MiB 限制、MCP 的 4 MiB 响应限制；完整大结果通过下面的 `transfer` 有界读取，三个入口不截断后冒充完成。

提交在客户端断连／服务关闭时取消未完成的输入准备；已经保存的任务仍由持久任务 owner 管理，重试使用原幂等键核对。`start:true` 请求保存后在所属 runtime 启动，状态和结果仍通过任务服务读取。HTTP 错误携带稳定 code，不暴露内部异常或任意文件路径。新路由为现有处理器能力的适配，不新增 catalog schema、领域字段或执行引擎。

#### 4.2.2 处理器大结果传输

新增只读 action `transfer`，CLI `processors transfer --request …`、MCP `processor_query {action:"transfer",request}`、HTTP query/processors 共用 Analysis 的导出/传输实现，Storage 仍负责完整性核验。既有 `read/export` 的小结果合同保持兼容，不改变 catalog schema、8 MiB 文件上限和 4 MiB MCP 回执上限；ADR 0033 的共享能力与受控资源边界不变。

请求严格为 `{result_id,content_sha256,format,max_bytes,continuation}`。固定引用来自 `results` 或集合成员；format 为 `result/json/csv/markdown`，max_bytes 为 4–262144，首次 continuation 为 null。`result` 传输 `read` 的完整 JSON 对象；其余格式传输 `export` 的完整 JSON 封套，因此 CSV/Markdown 的 metadata 不丢失，而非只切下载正文。

回执为 `{schema_version:1,result_id,content_sha256,format,transfer_sha256,total_bytes,start,end,text,next}`。start/end 为传输对象的 UTF-8 字节范围，text 始终在完整 Unicode 字符边界切分；按 next 顺序续读到 null，再对拼接后的 UTF-8 字节校验 total_bytes 与 transfer_sha256，最后解析 JSON。content_sha256 是不可变结果自身的 hash，不与传输封套 hash 混用。max_bytes 只约束本块 text，JSON 转义后的响应仍有界且低于 MCP 预算；不持久化读取会话。

续读 token 绑定结果 ID/hash、格式、完整传输 hash 与下一偏移，拒绝变更身份、格式、非字符边界、畸形或无效游标。它是位置校验而非授权凭据，每次请求继续执行原认证和固定结果校验。取消信号穿过 HTTP/MCP、共享读取及 Storage；断连不产生后台加工、写入或租约。缺失结果、hash 不符、无效续读分别返回 `processor-result-missing`、`processor-input-changed`、`processor-continuation-invalid`，不会退回最新结果。超过 4 MiB 的合成结果已通过三端逐块重组，Unicode、引用和换行导出、错误身份与取消有直接验证。

#### 4.2.3 检索来源与临时导航状态

工作区将命中映射为有类型的固定来源：文档保留 literature/document/asset ID、表示与资产 hash、UTF-8 范围；旧知识／综合保留 artifact、content/manifest/statement hash；元数据保留 literature、revision/hash。URL 的 `source` 区分来源种类，`from=ask` 表达返回入口；服务端只接受有界 scalar 字段，客户端重新解析并在读取时校验。它们不是处理器 result ID，后续结果导航必须另行绑定 result 引用。

`RetrievalState` 由单个工作区实例持有，保存检索草稿、已返回结果、continuation 与上下文篮子；离开页面 abort 当前请求，旧回执不能覆盖新页面。浏览器后退和“返回检索”使用会话内状态；刷新仍可读取固定来源，但不承诺恢复整份结果篮子或自动重发检索。UI 状态不写 catalog，也不成为另一份知识事实。

合成预览的 `WorkbenchSession.runAgent()` 仍只执行一次决定。生产 flow 则在每次安全点使用同一会话的 `runAutomaticStep()`，可在模型调用之间受理指导、暂停、接管、人工动作与交还。生产工作台的配置 HTTP 接口复用同一 TypeScript Configuration owner；保存普通配置后分别显示已保存 revision 和运行中 Application 的重启需求。当前正式 TS/HTTP/Web 回环测试覆盖真实 Cloak page、统一 PDF 接纳、最终反馈及 Library 阅读衔接；真实 Publisher 站点仍需独立现场证据。

### 4.3 配置交互

#### 4.3.1 草稿、发布与运行快照

页面读取安全配置投影后建立本地草稿。编辑不改运行配置；保存携带期望 revision，经 owner 验证并发布。冲突返回最新 revision，用户可保留草稿重新比对，不能前端强行覆盖别人刚保存的内容。

当前普通配置在 Application 启动时绑定；保存成功表示磁盘已发布，不表示当前 Browser/Parser/Provider 对象已经重建。页面分别显示保存状态、运行 snapshot 和已组装能力，必要时提示重新启动。Sources 排序和 Auto 派生值由服务端定义，不能两端各算一套。

保存成功后若状态刷新失败，仍显示“已保存，运行状态暂无法确认”，不能回滚表单或告诉用户保存失败。Provider/Model 引用校验、删除保护、当前 scan limit 与保密字段处理复用 Configuration owner。

#### 4.3.2 凭据与 probe

凭据表单与普通配置分开，读取不回显密钥；只显示已设置/缺失等安全状态。撤销/轮换在新外部请求前重新授权，已有普通参数快照不能继续使用已撤销 key。已派发请求如实结算，不承诺能撤回已经发送的数据。

配置状态读取无外联。probe 是用户明确动作，指出将联系何种服务及可能费用，只发送固定最小测试内容，不发送用户文献。结果显示实际阶段和稳定诊断；probe 成功不表示所有文献获取或分析都会成功。

#### 4.3.3 web 守护与应用配置

正式 `web` 命令是前台父进程，使用当前 Node 和随包私有入口 fork 一个 worker，不打开 catalog、不装配第二个 Application、不提供父进程 HTTP。worker 持有 Application/HTTP；直接嵌入 startProductionWorkbench 未注入 lifecycle 时为 unmanaged。来源目录、单源保存/测试与 apply 均经 configuration-operations 共享边界，接口封套为 protocol_version=1/result；来源合同与存储规则见[来源目录](03-literature-materials.md#310-来源目录与安全测试)。

apply 绑定 runtime_id、generation、request_id 与保存的 binding revision。同目标在途幂等，不同目标冲突；等待中目标变化产生 stale failure。先回送并 flush 202，再异步交接。waiting/draining 可取消，commit 后不可取消。状态包括 unmanaged/idle/waiting/draining/stopping/starting/applied/cancelled/failed；blockers 分 queued、running、foreground、probes、browser_transfers，原因码仅在安全 problem 技术详情中。

每次异步取锁、释放锁或检查返回后，在写交接状态前重新核对本请求身份；取消后迟到的锁不能恢复 waiting/draining，旧请求异常不能改写后继请求。并发同目标请求在配置读取后再次合并为同一在途 receipt；迟到的取消确认只处理其原请求。

新工作先持 intent shared，再在释放前登记 queued 或取得覆盖执行及清理的 activity shared。许可同时按规范 home 与 catalog 身份建立，另一个 home 指向同一库也不能绕过。Application 启动/恢复、CLI/MCP/Entry、前台写入与 probe 使用同一准入；已登记任务的 continuation 由实际 owner 调用 activity，不接受客户端自报 job_id 授权。HTTP、CLI 和 MCP 入口先脱离内部许可上下文，不能继承创建 listener 或调用传输入口时尚有效的 bootstrap 许可；长期内部回调继承的过期 ALS 上下文必须重新取许可，不能借它继续写。

父进程持 intent exclusive 后阻止新提交/恢复/重试/前台工作及测试；已有队列继续排空，必要人工 Browser 协助和取消可用。父取得 activity exclusive 后，屏障下再次检查全部 blocker、目标与外部 execution-runtime lease；现有 execution lease 只作短检查并释放，不能持到下一代恢复。父持专用两类交接锁至新代 ready。下一代通过 IPC 的一次性本进程 bootstrap capability 完成启动；装配使用已校验的同一配置/凭据快照，ready 核对代次、实际端口、binding revision 与 IPC 版本。旧 PID 真退出前不启动新代。查询为零本身不是重启许可。

受控 apply 仅在匹配本代 commit 后 exit 75 才换代；裸 75 属异常。异常退避为 1、2、4 秒，60 秒内最多重启 3 次，之后非零停止；启动/端口/schema/IPC 错误不 crash-loop。60 秒未收到合格 ready 时报告启动超时并要求正常关闭，不将其当成已就绪。正常关闭卡住只报告 failed 并等待，不自动 kill 或启动第二代。父 SIGINT/SIGTERM 关闭整树；直接子信号按 operator 停服；父死亡/IPC 断开时子进程正常关闭。异常恢复只沿现有对账标记中断，不重演 Provider、模型或 Browser 动作。

端口 0 首次分配后由父记住，后代保持；端口被抢明确失败。固定密码只由父消费一次启动环境并删除，通过私有 IPC 内存注入，禁止 argv、文件或生命周期日志传递。自动 API key 每代重生，仍只走启动安全交付；cookie、登录、CSRF 和控制 grant 失效，需重新登录。父重启不重演 pending apply。应用配置不执行 build、升级或 schema 迁移；首次从直接子进程方式切换见[升级指南](../../guides/upgrade.md#web-守护的首次切换与程序升级)。

### 4.4 知识阅读与维护分离

阅读页展示文献身份、具体版本、元数据来源、材料、可读表示和不同用途知识产物。Agent 与人类看到同一事实，差异只在渲染与交互，不在“谁有更完整的数据库”。

打开已有 PDF、章节、总结或证据不发起外部调用。没有资料时如实说明可用性，提供按需使用的维护或上传入口，不要求默认展开缺口待办和加工表单；用户明确提交范围后才开始发现、获取、解析或分析。搜索输入变化、详情展开和页面刷新都不能自动补库。

知识阅读要区分原文、旧总结、新用途分析和跨篇综合。产物显示输入版本、方法/用途、实际覆盖与限制；点证据打开精确原版本。若定位能力不足，展示文件级引用而不画假高亮；原版本失效要说明，不能跳到最新近似段落。

大型文件采用单独读取/下载，导出副本不改变文献事实。下载按钮不允许通过用户输入的服务器路径读取任意文件，文件名和 Markdown/HTML 渲染也按不可信内容处理。

### 4.5 工作台在新产品中的位置

[ADR 0026](../decisions/0026-agent-knowledge-and-human-collaboration.md)确认人类配置、Browser 全过程观看/指导和知识阅读为正式能力；[ADR 0032](../decisions/0032-library-centered-web-workspace.md)进一步确定 Web 的库中心结构和可选直接交互，现有任务工作台是复用基础。阅读器细节、保存视图持久化、跨入口活会话可见性和具体控制交互待设计验证。`LibraryQuery` 的字段/状态/发现范围筛选不能证明所有新材料层筛选或计数已经支持；发现批次也不等于所有导入均有长期历史。当前 discovery/import 的直接报告与 processing Job 可以统一展示，但不能为统一 UI 擅自改变持久化合同。

下文为当前 TS 迁移/兼容实现记录。生产 Browser 会话已支持连续观察、自然语言指导、安全点消费、控制交接及 PDF 获取报告与既有 Library 原始材料阅读衔接；单步合成预览仍独立保留。新文档、知识与提取候选的阅读和展示已接入正式工作台，精确能力见 [知识查询与上下文：知识检索与上下文组装](06-retrieval-context.md#4-知识检索与上下文组装)。

## 5. 共享支撑：配置与凭据

本节集中说明共享 Configuration owner。它管理设置和授权，不授予产品接口文献写入裁决权；所有模块复用同一配置来源。

### 5.1 人类配置接口与操作生效

[ADR 0026](../decisions/0026-agent-knowledge-and-human-collaboration.md)将人类配置列为正式能力，ADR 0032 确定 Web 提供完整人类入口，既有 CLI 配置能力继续保留。Configuration 继续唯一拥有固定 home、发布、凭据和显式 probe；新界面复用这些操作，Agent 知识接口不默认开放凭据管理。

必须明确草稿、保存、probe 与业务操作的配置时点；保存后测试应针对新确认配置，普通参数绑定与凭据撤销/禁用影响分别设计。以下已有菜单/字段是现有或兼容合同，不能据页面存在宣称完整用户旅程通过。

### 5.2 责任与依赖

当前模块的实际分工如下：

```text
apps/server/src/
  configuration/
    index.ts          # OrdinaryConfiguration、严格 TOML、文件读取与原子发布
    owner.ts          # snapshot/revision、section diff/publish、Model/Source 编辑、probe
    credentials.ts    # 不透明 credential bundle、grant、origin 绑定、安全编辑
    cloak-runtime.ts  # pinned binary、安装/验证与 runtime readiness
  bootstrap/
    application.ts    # 普通配置快照、业务资源组装、每次请求凭据 reader
    workbench.ts      # 当前运行能力投影、工作台组装
  cli/
    config-center.ts  # 对象页、编辑流程、显式 probe session
    config-ui.ts      # 终端选择、主题和诊断呈现
apps/web/src/config.ts # 同一 owner 的 HTTP 表单 adapter
```

`TypeScriptConfigurationOwner` 拥有 `read/validate/diff/publish/publishConfiguration/status` 与凭据编辑/授权；`ConfigurationProbeSession` 拥有一次显式 probe 的资源。配置 UI 不构造另一套 Provider adapter，不通过直接改文件绕过 revision 检查。Profile 与 binary 生命周期仍在 Configuration 边界，通过不暴露内容的 handle/readiness 交给 Browser。

配置边界负责固定用户路径解析、严格 TOML 解析、Model Provider/Model 注册表与任务选择、
凭据/Profile owner/权限检查、服务 URL 规范化、origin 绑定、round-trip 编辑、安全 staging、
唯一当前 schema 的严格拒绝与正常原子发布；它不迁移、恢复或回退旧配置，不访问外部服务、
不形成文献业务决定。
Bootstrap 只把短生命周期 secret 注入当前需要的具体 adapter，并组装共享 Network/Access
Coordinator、一个共享 Agents runtime 与一个 Profile-backed Browser runtime；它不显示、序列化或保存 secret 或 Profile
内容。

Model 只保存普通参数、安全状态和中性 probe 结果。真实 API key、bearer token、Cookie、
凭据原文、binary stream、HTTP/vendor 响应和可辨识 secret 的 mask、长度、hash、前后缀或
fingerprint 都不能进入 `packages/contracts` 的业务合同。CLI 只负责用户交互、确认和安全呈现，不拥有 Agents、Provider
或 MinerU wire protocol。

### 5.3 两类配置文件

普通配置只有一个生产文件：

```text
~/.sciretriever/config.toml
```

它只保存十个非 secret 责任组：

```text
paths / sources / assets / parsing / providers / models / analyze / browser / execution / library
```

Configuration 是该路径的唯一 owner。正常 CLI、Entry 与 Bootstrap 不读取环境变量、不检查
当前目录，也不提供第二个配置路径；裸配置中心在首次确认编辑时创建固定文件。`parseConfiguration(text)` 只解析调用方提供的文本；`loadConfiguration(home)` 从固定文件读取。测试注入 home 不构成生产环境变量覆盖入口。普通配置严格
拒绝未知 section、字段、重复 key、错误枚举和不一致组合。

文献 Provider、Model Provider、可选 CloakBrowser Pro 与远程 MinerU secret 只有一个生产来源：

```text
~/.sciretriever/credentials.toml
```

共享的 `~/.sciretriever/` 必须为当前用户拥有的真实非符号链接目录且精确 `0700`；两个文件
都必须为当前用户拥有、单硬链接、非符号链接的普通文件且精确 `0600`。两类文件都使用有界
descriptor 读取并复核文件身份，替换、过大、非法 UTF-8/TOML 或权限不安全都 fail closed。
普通配置仍不是 secret，用户可以直接编辑；严格权限来自共享私有运行目录合同。测试通过显式
`home` 依赖注入使用系统临时目录，Harness 不读取真实用户文件或旧路径环境变量。

### 5.4 普通配置合同

普通配置字段、默认值、模型/来源选择及 Browser 收紧项统一见[配置手册](../../guides/configuration.md#2-普通配置字段)。Configuration 负责严格解析与原子发布；业务模块不得另建配置解析或默认值。本篇保留发布、凭据隔离和运行时生命周期的技术合同。

#### 5.4.4 CloakBrowser binary 与 Profile identity 生命周期

Browser binary/Profile 完整生命周期见[Browser 技术篇的目标设计](08-browser-control.md#62-cloakbrowser-binary-与-profile-identity-生命周期)。

### 5.5 统一 credentials schema 与 origin 绑定

文献 Provider section 按当前 adapter allowlist 保存字段；每个需要 key 的 Model Provider 使用命名
`[providers.<provider>]`，其余固定核心 section 为：

```toml
[providers.openai]
api_key = "<secret>"
origin = "https://api.openai.com"

[cloakbrowser]
license_key = "<optional-secret>"
origin = "https://cloakbrowser.dev"

[mineru]
bearer_token = "<secret>"
origin = "https://mineru.example.invalid"
```

Model credential section name 必须是合法本地 Provider identity，并精确引用普通配置中的 Provider；
每个 Provider 最多一套 `api_key + origin`，多个 Model 复用。未知 section、未知字段、空 section、
空值、控制字符、非法 origin 和不完整过渡字段组合全部拒绝。Provider section 的具体字段与必需性
见配置手册及 Provider Notes。

`[cloakbrowser]` 当前是保留但不消费的核心 section：status 会把它显示为
`reserved-not-used-by-pinned-free-binary`；v146 显式安装和普通 Browser launch 都不会读取或传递
这个值。未来若启用需要 license 的不同 binary，必须重新完成许可、版本、签名、Profile 和离线/
现场门禁，不能借该预留 section 绕过当前固定 runtime。

核心 secret 与保存时的规范 origin 精确绑定。Bootstrap 注入 `CurrentCredentialReader`，adapter 在新请求前调用 owner 的
`authorizeCurrentCredential({ namespace, provider, field, origin, operation })` 取得当前允许的短生命周期值；改变 Base URL 后旧 secret
不会被发送到新服务。Network 在每次 redirect 重新执行 origin/credential alias 检查，跨 origin
不携带认证。loopback 服务和当前 scope 不需要的核心服务不会触发凭据读取。

旧普通配置路径以及 LLM/MinerU、Agents 与 CloakBrowser secret 环境变量均不属于产品合同：
不读取、不回退、不迁移。旧 credentials `[agents]` 与 `[models.*]` 是未知 section，不能由普通启动变成命名
`[providers.<provider>]` key，并会在配置首页前直接拒绝。operator 必须在配置中心之外手工删除旧
section 或替换精确文件，再按当前 Models 入口重新配置；`NO_COLOR` 等显示控制只影响终端呈现，
不能改变普通配置身份。

### 5.6 安全发布

普通 `[sources]`/`[models]`/`[analyze]`/`[parsing]`/`[browser]` 编辑由 TypeScript `mergeConfigurationText` 按 section 合并：未选 section 及其注释保留，选中 section 按当前 schema 确定性重写；不依赖 `tomlkit`。发布流程为同目录 staging、`0600`、完整写入、flush/fsync、重读、
TOML/TypeScript parser 复验、原子 replace；任一步失败保留原文件并清理 staging。确认前只显示
普通字段 diff，不显示或推导 secret。

单一凭据 section 修改沿用相同 owner-only staging 和原子发布。Model Provider 或核心服务同时改变独立的普通配置文件和凭据文件；文件系统没有跨文件 rename 事务，因此实现使用可恢复顺序：

```text
1. 在各自目录落盘全部 staging，chmod 0600，fsync，并完整复验
2. 发布同时服务旧/new origin 的过渡凭据
3. 发布引用 new origin 的普通配置
4. 清理过渡凭据，只保留最终 origin
```

内部 `next_api_key` / `next_bearer_token` / `next_origin` 必须形成完整过渡组、与主 origin
不同，且不通过 status、field names 或 repr 暴露。第一次发布前中断时两份旧文件均不变；
步骤 2 后中断时旧普通配置仍可取旧 secret；步骤 3 后中断时新普通配置可取 new secret；
正常结束后清理过渡字段。reset 也通过同一函数同时清空普通 section 与凭据。

### 5.7 交互配置中心

命令树固定为：

```text
sciretriever config [--theme auto|dark|light|mono]
sciretriever config status [--json] [--theme auto|dark|light|mono]
sciretriever config test provider <name> [--json]
sciretriever config test model <provider/model> [--image] [--json]
sciretriever config test search <source> [--json]
sciretriever config test search --all [--json]
sciretriever config test download <source> [--json]
sciretriever config test download --all [--json]
sciretriever config test parse [--json]
sciretriever config test analyze [--json]
sciretriever config test browser model [--json]
sciretriever config test browser site <publisher-access-key> [--json]
sciretriever config test --all [--json]
```

裸 `config` 首页只使用单词级责任名称：

```text
Models / Search / Download / Parse / Analyze / Browser / Status / Theme / Quit
```

首页只组装本地状态，不触发 Network。TTY 使用当前 Node 交互组件与 `config-ui.ts` 的非全屏界面，支持方向键、
Enter、Esc/左方向键返回、首页快捷键和隐藏输入；长 Model/Provider 列表支持 `/` 搜索。非 TTY
降级为具有相同选项与责任的确定性文本菜单。主题支持 auto/dark/light/mono，`NO_COLOR` 强制
mono；状态不能只靠颜色表达。所有交互、确认和 setup 结果写 stderr，stdout 为空；Ctrl+C/EOF
取消不产生写入。旧 `config set/remove` 保持无效。

共享选择器为所有二级及更深菜单自动追加 `Quit`，并与页面显式的 `Back`
保持不同控制流：`Back`、Esc 和左方向键只返回上一级，`Quit` 直接退出整个配置中心。
`Cancel`、Ctrl+C 与输入 EOF 仍是操作取消/中断语义，不得复用为菜单导航。非 TTY 选择器等价提供
`b/back` 和 `q/quit`。

本地 Web 工作台的 Configuration 页面是同一 owner 的 HTTP adapter，不是第二套配置实现。GET
只返回脱敏 snapshot/readiness；publish 接受已知 section 的完整 typed projection，并复用 owner 的
validation、revision CAS 和原子发布。`configuration-invalid`、`configuration-conflict` 与
`configuration-probe-invalid` 分别形成稳定 400/409/400 结果。页面保存成功直接消费返回的 snapshot，
较旧 refresh 不能覆盖新 revision；冲突保留表单草稿。Parse/Browser Model probe 只能由显式按钮
触发，完成后重新读取本地 readiness，任何 outcome 都不持久化。Credential 请求走独立 owner，响应
只含 presence；secret 不进入 URL、history、DOM、普通 snapshot 或 probe 结果。

`ConfigOption.label` 保持单词级稳定选择合同，`description` 是同一行右侧的只读展示合同。共享
TerminalChoice 统一对齐说明列、按终端宽度截断，并允许长列表同时按 label 或 description 搜索；
非 TTY 编号菜单输出同一说明。首页 description 来自本次已读取的本地状态快照，展示各 area 的
Ready/Incomplete/Off 与关键选择，不发起额外 probe。该可操作列表是 area 状态的唯一首页表示，
不再在其前面渲染重复的静态 summary table；顶部只显示配置文件位置和 local/no-network 边界。

`Models` 与 Provider 使用对象页：

```text
Models:    Add / <Model> / Providers / Back
Model:     Edit / Test / Remove / Back
Providers: Add / <Provider> / Back
Provider:  Edit / Key / Test / Remove / Back
```

`Providers` 管理 name、API、Base URL 与 exact-origin key；官方 OpenAI/Anthropic/DeepSeek 只提供
已知 URL/API 初值，自定义 Provider 仍按严格 loopback/remote URL 规则验证。`Key` 为选中的
Provider 添加、替换或移除 key，并只显示 Saved/Missing/Not required。仍有 Model 引用时不能删除
Provider。

`Models → Add` 使用 `Provider → URL → API → Key → Model → Reasoning → Image → Stream → Save` 的连续
流程：选择已有 Provider 或 New；新远程 Provider 在同一流程隐藏输入 key，已有 exact-origin key
直接复用，loopback 不询问 key。key 就绪后自动调用 Bootstrap 的 `fetch_agent_models`；经共享
Network 对规范 `/models` 执行一次无 redirect、无 retry、最多 1 MiB/100 项的 GET，返回非持久
typed observation 后立即关闭 client。目录只用于选择 Model ID；所有失败稳定、脱敏，只有失败、
空目录或协议无可用结果时才提示 `Manual`。取消不保存部分 Provider、Model 或 key；首页、Status、
打开 Models 和普通业务命令的目录调用计数为零。保存前展示不含 secret 的配置摘要。

具体 Model 对象页的 `Edit` 只修改 reasoning、image 与 stream，`Test` 验证该精确 Model 而不改变任务选择。reasoning schema 接受
`default/none/minimal/low/medium/high/xhigh/max`；`default` 完全省略 wire 字段，其它值由 adapter
按协议精确编码，不降级或映射。Provider 目录中的 context/output/image/effort 提示不写入 Model，
也不成为 capability 证明。`Remove` 只删除未被 Analyze/Browser 引用的 Model。

其余 owner 页固定为：

```text
Search:   Sources / Limit / Test / Back
Download: Sources / Test / Back
Parse:    Setup / Test / Reset / Back
Analyze:  Setup / Test / Reset / Back
Browser:  Setup / Profiles / Runtime / Test / Reset / Back
```

`Search` 只管理 Metadata Sources 与逐 Source raw-item limit，`Download` 只管理 Acquisition
Sources。两者的 Sources 都只有 Auto/Custom 两层；Auto 页可以切换 Custom，Custom 页可以切回 Auto
或逐项修改精确列表。Auto → Custom 冻结当时的有效集合和顺序，Custom → Auto 清空固定列表。
选中具体 Source 后，对象页按该 Source 的能力就近提供 `Setup`、`Key`、`Test`、`Enable` 或
`Disable`；Key 与普通参数不会自行启用 Source。Search Auto 仍可配置 Crossref anonymous/polite。
每个 Sources 选择行的 description 由 Source 用途、当前 Active/Off 状态和 capability-scoped
credential status 组成；因此同一 CORE Source 在 Metadata 显示可选 API key，在 Acquisition
显示必需 API key。读取只经过 secret-opaque credential presence 接口。Sci-Hub 的 `Mirrors` 只在
Sci-Hub 对象页出现，修改镜像不会启用 Sci-Hub。

`Parse → Setup` 连续配置 MinerU Service、远程 PDF upload 授权和所需 exact-origin bearer token；
loopback 不询问 token，remote 必须在同一流程明确确认 Upload。`Analyze → Setup` 连续选择 Model 与
八项文献分析业务 limit。`Browser → Setup` 连续配置 Off 或 Agent 所需图片 Model、固定 Browser
identity Profile 与本机资源 cap；`Profiles` 和 `Runtime` 分别管理本地身份与
CloakBrowser 生命周期，`Test` 再区分合成 Model probe 和实际 Browser 最小站点 probe。

Analyze/Browser 的 `Setup` 只把完整 Model reference 写入各自任务配置；reasoning、image 与 stream 保留在
Model 中，Provider 连接保留在 Provider 中。Analyze 选择不改变 Browser，Browser 选择不改变
Analyze。首次选择 Analyze Model 时生成产品内部安全业务预算；不会从模型目录 metadata 推导。
Browser 只列出 `image = true` 的 Model；strict output、tool、当前生产 Observation 的 `image/jpeg`
与图片大小合同由模块派生。普通 schema 与 `config status --json` 都使用独立 `browser` 名称；
`download` 只表达 Acquisition Source。

Download 的 Plain/TTY 两种界面只管理 PDF Source；三个已实现的 authorized primary-PDF API
（CORE、Elsevier、Wiley）的普通参数、Key 与 probe 都在各自 Source 对象页。Browser 一级页把这些
Source 与 Browser runtime readiness 分开，并支持：

- 在 Sci-Hub Source 的 `Mirrors` 中管理有序镜像，且不出现 Key 或隐藏凭据输入；
- 选择唯一 Agent controller 使用的 `image = true` Model；
- 选择/初始化一个 opaque Browser identity Profile 与固定 identity manifest；
- 显式永久删除选中的本地 Browser Profile、manifest 和由 Chromium 管理的状态；
- 禁用自动 Browser access，同时保留 Profile、本机并发上限、Provider policy override 与凭据；
- 设置本机 Browser 资源 cap；
- 显式安装、更新或回退 CloakBrowser binary。用户不能输入 binary/Profile 路径、seed、persona 或
  Cookie。

配置菜单把动作含义同时编码为颜色和单色仍可见的标记：配置 `◆`、查看 `◇`、测试 `▶`、危险
`!`、返回 `←`、退出 `×`。说明必须明确：自动 CloakBrowser patched Chromium 固定以
`headless = false` 使用浏览器一项所选的
出口（直连或经代理，见 [ADR 0056](../decisions/0056-outbound-proxy-by-requester.md)）和一个持久固定身份 Profile；无 GUI Linux 由 Xvfb 提供完整窗口栈，但不提供用户可见
交互窗口。产品没有 Browser 登录、机构选择、MFA 或 Cookie 导入导出入口；SciRetriever 不自动
导航登录页、不填写凭据、不选择机构、不读取 Cookie/登录结果，也不处理 MFA。Challenge 不需要
单独配置入口：Browser Model readiness 通过后，唯一 Agent controller 可以在同一 Profile/IP、
文章 permit 和统一 Observation/Action 合同内操作当前文章页面的可见控件；初始化、配置写入、
binary 网络动作和删除都先确认，取消不修改配置、不创建/删除 Profile，也不启动 Browser。

Browser 如实显示唯一 `browser:generic` production route，并分开呈现 route 已安装、Browser 总
开关、本地 runtime 就绪和文章 entitlement 运行时检查。完整 route/policy/action-required 状态由
Status 提供；模型合成 probe 与实际 Browser 最小站点 probe 只
在 `Browser → Test → Model/Site` 由用户显式执行。

### 5.8 status 与 probe（当前实现与目标边界）

`status` 是纯本地投影；`ConfigurationProbeSession` 已提供统一 dispatcher、真实最小只读请求、稳定退出码和正式 Browser Site adapter。Browser Site 只在显式单目标调用时使用已验证 bundle、选中的固定身份 Profile 与同一 BrowserHost/Network 边界；页面可写入 Chrome 管理的 Profile 状态，但 probe 不写 Catalog、下载或发布论文，结果 `persisted=false` 仅指产品事实。Probe 结果显式区分 passed、failed、skipped/unavailable、未授权、`network_performed`、`browser_launched`。固定 bundle 的 loopback 已验证本机可运行，真实 Publisher 站点仍需另行授权与现场证据。

当前 `TypeScriptConfigurationOwner.status()` 返回 `packages/contracts` 的精确 `ConfigurationReadiness`：

```ts
interface ConfigurationReadiness {
  readonly version: 1;
  readonly network_performed: false;
  readonly browser_launched: false;
  readonly items: readonly ConfigurationReadinessItem[];
  readonly credentials: {
    readonly sources: readonly { target: string; present: boolean }[];
    readonly models: readonly { target: string; present: boolean }[];
    readonly mineru: boolean;
  };
}
```

每个 item 携带 owner、target、state、code、next_action；state 为 configured/ready/blocked/unavailable。owner 的本地投影不验证真实数据库可读性、运行时已经启动或文章 entitlement。工作台另外报告已保存 revision、运行 snapshot 与实际已组装能力，不能用 status 中的 local-ready 替代生产对象图就绪。

下述完整分区是配置中心的技术呈现设计，包含尚未由当前 status 输出的 Runtime/Profile 细项；并非另一套已发布 JSON。实际 CLI/Web 序列化使用上述合同。

`config status` 是纯本地操作：读取两类配置，组装 capability/readiness 和 secret-opaque
presence view，不构造 Storage、Catalog、ArtifactStore 或 Network。人类输出用紧凑表格
展示：

- Model Providers 的 name/API/endpoint 与 credential presence/origin match，以及全部 Models 的
  完整 reference、reasoning、image 与 stream；Analyze/Browser 各自选择的 Model 和静态 readiness；
- MinerU mode/endpoint/固定实现身份、credential presence/origin match 与 readiness；
- Metadata API 与 authorized primary-PDF API 的独立 enabled、字段
  configured/missing/optional、policy readiness 和下一动作；
- PDF acquisition 固定顺序：Public → Authorized API → Controlled browser；
- Controlled Browser 的持久 Profile 有头模式、选中的 opaque identity 与 presence、
  CloakBrowser wrapper/binary/version、Playwright API、fixed identity manifest、headed display/Xvfb、
  唯一 `browser:generic` route、普通总开关、共享 process/context lifecycle、`browser-generic` policy、
  未评估认证状态、逐文章 entitlement、显式 Publisher reachability probe 与所需下一动作；
- Storage 和执行参数概要。

人类输出只逐项展开已启用或已有凭据的 Metadata API，其余禁用项用数量摘要收起；授权主
PDF API 只逐项展开当前有效 Acquisition Source 中的 CORE、Elsevier、Wiley 或已知不支持直接
PDF 的 Springer，避免把未启用能力和 Metadata 凭据混入当前路线。完整 capability matrix 仍保留
在 JSON。Browser 分区只显示 `browser:generic` 与 `browser-generic` policy，再根据总开关、
CloakBrowser wrapper/binary、Playwright API、Profile manifest 与 headed display 给出 automatic
acquisition/probe 的本地就绪状态和稳定 action code。通用 route 未安装时的
`browser-production-route-unavailable` 分支仍保留，但不是当前默认状态。

本地 readiness 不能描述为 IP entitlement 或文章授权成功。JSON 使用稳定分组 schema、无
ANSI，也不能包含 secret 特征或 configuration fingerprint。

Browser 的纯本地状态只能说明通用 route、总开关、Profile selection/presence/identity manifest、
CloakBrowser wrapper/binary/version、Playwright API 和 headed display 是否齐备；不能声称 Profile 已登录、当前机器 IP
或具体文献 entitled。动态页面状态、runtime health、circuit/cooldown 不保存为“上次状态”。
`config status` 不启动 Browser、不访问 Provider，也不读取 Profile 内容或枚举 Cookie、origin
history、登录站点或 selector。
当前 Playwright API/bundle 可发现只表示本地运行依赖存在；status 还会检查 binary 安装 manifest、版本/校验兼容性
和 headed display（Linux 上为 Xvfb）是否存在；本地检查不启动
Browser 或证明启动成功。
以下是历史完整 readiness 的目标分组，不能当作当前 TypeScript status 的精确 wire schema（当前返回形状见本节开头）：

```text
models / analyze / download / browser / parsing / providers / storage / execution / library
```

`models.providers[]` 只包含 Provider 普通事实与 credential presence/origin match，
`models.models[]` 包含完整非 secret Model；`analyze.model` 与 `browser.model` 保存完整 Model
reference，并分别通过 `selected_model` 附带所选 Model/readiness。`download` 只表达 Acquisition
Source，Controlled Browser 由独立 `browser` 分区稳定区分：

```text
enabled / mode=headed-fixed-profile / interactive_authentication_supported=false
article_entitlement=checked-per-article / local_max_concurrency
runtime.cloak_wrapper_available / playwright_api_available / binary_presence / binary_version
runtime.binary_verified / fixed_identity_manifest / identity_schema
runtime.headed_display_available / launch_assessed
profile.selected / profile.presence
session.assessment=not-assessed / authenticated=null / article_entitlement=not-proven
model / selected_model / model_locally_ready / model_missing_fields
automatic_acquisition_available / production_route_count=1 / automatic_route_count=1 / routes
routes[].access_key / route_key / rate_limit_group / automatic_acquisition_eligible
probe.available / requires_explicit_target / supported_access_keys
action_required[{code, reason, action}]
```

JSON 不含 ANSI、Profile 路径/内容、configuration fingerprint、Cookie 特征、登录详情、selector、
原始异常或 secret 特征。`automatic_acquisition_available = true` 只表示本地执行条件齐备；
`profile.presence = configured` 只表示安全目录存在；`article_entitlement = checked-per-article`
明确表示权限仍须由实际文章响应判断。

`config test` 构造独立的 `ConfigurationProbeSession`，复用生产 adapter 和共享
Network，但不构造 Storage。TUI 与结构化 CLI 先形成同一个 probe request，再由共享 dispatcher
选择 owner；两条入口不能各自实现测试语义。Model Provider probe 只读取一次有界目录，
目录成功不成为具体 Model capability 证明。精确 Model Text/Image probe 使用临时任务选择调用生产
Agents runtime，保留该 Model 的 reasoning 与 stream，但不修改或持久化 Analyze/Browser 选择。Analyze 固定发送：

```json
{ "probe": "sciretriever-configuration" }
```

并要求严格响应 `{"ok":true}`。Browser Model 发送一张程序生成的极小无文字图片和一项固定工具
声明，要求返回该工具决定；二者都不发送用户 Literature、页面或 screenshot，但可能消耗少量额度。
Search probe 只走 Metadata registry 的官方最小只读请求；精确 Source 即使 disabled 也可选择，
`--all` 只选 enabled Source。Download 不通过 Metadata registry 冒充 Acquisition 成功：当前没有
安全、与 Literature 无关的 Acquisition probe，本地就绪 Source 返回
`acquisition-probe-unavailable`，本地不就绪 Source 保留 readiness failure code；两者都不发
外部 Download 请求、不访问 Sci-Hub、不下载任意 PDF，`article_entitlement` 保持 `not-proven`。

MinerU probe 只调用 `GET health`，验证 healthy、release 3.4.4、protocol 2 和 profile；不
submit、poll、fetch archive 或上传 PDF。`--all` 汇总 enabled Search、Download 的可见限制、Analyze
和 Parse；Browser 已启用时还执行一次 Browser Model 的合成图片/tool probe。它不读取 Provider
目录、不测试任意未选 Model、
不启动 Browser Site、不下载或上传 PDF。Download unavailable 不参与全局 passed 判定；其它已选择
Probe 的 failed/skipped 使退出码为 3。人类模式在实际外部调用前确认副作用；JSON 模式视为脚本
显式授权。

普通 Model/Search/Download/Parse/Analyze probe 不隐式启动 Browser。Browser runtime/target probe
必须由用户显式选择具体 Publisher access key：

```text
sciretriever config test browser site <publisher-access-key> [--json]
```

该选择与其它 owner、`--all` 互斥，一次只允许一个 production-approved 最小目标；人类
模式再次确认将启动受控有头 CloakBrowser；无 GUI Linux 使用 Xvfb，JSON 调用本身视为显式授权。
probe 使用与自动获取相同的 `browser-generic` scheduler、通用 controller、目标 origin 和
Network challenge dependency 边界，并用 deny-all capture policy 在读取前拒绝 PDF/body。passed
只要求 runtime、固定身份和最小目标流程完成；结果固定 `article_entitlement = not-proven` 与
`persisted = false`。`--all` 永远不隐式启动 Publisher Browser probe；Download 的合成模型
probe 不启动 Browser，也不访问 Publisher。
当前 production target 集合为九家，Browser 启用且 runtime 就绪时均可作为单目标 probe：

```text
acs-publications
aip-publishing
elsevier-sciencedirect
iopscience
oxford-academic
rsc-publishing
science-aaas
springerlink
wiley-online-library
```

Probe 只打开所选 Publisher profile 声明的首页；不打开具体文章、不下载 PDF、不评估机构 IP
entitlement，也不
持久化结果。开关或 runtime 未就绪时以
精确 action code 稳定 `skipped`；未支持 access key 不启动 runtime、不导航、不猜 URL。
页面可打开、机构 IP entitlement 和具体文章 entitlement 始终是不同结果。这些 access key 只用于
显式 reachability probe，不是九条下载 route；生产文章统一进入 `browser:generic` 并使用浏览器所选
出口，只有具体文章响应才能分类 IP 放行、login/MFA/action-required、paywall 或其它授权结果。

probe 使用受限 Browser 模式：顶层主文档、经 production Profile 精确允许的 redirect，
以及由目标页面/frame ancestry 实际发起的受限 challenge dependency 仍经过 destination/DNS/IP/
host/TLS 边界；显式 request 逐项审查，未再次暴露 route 的
native redirect 只允许复用同页 live、已批准且预绑定的关联。非必要 stylesheet、script、image、
font 等子资源在 route 边界安全终止。页面 marker 通过即时、有界 DOM snapshot 判断；selector
不存在立即返回，不读取 Cookie、storage 或 profile 文件，不把页面正文、认证 query、header 或
原始异常写入结果。合法跳转到同一 rule 允许的最终 origin 视为可达，不因离开起始 origin 产生
Springer 假阴性。Probe 可以报告 challenge dependency admitted/blocked、统一 `page_state`、所选
controller 与单次动作 readiness，但不能声明 Challenge 或 entitlement 普遍成功。该优化只限制
probe 的访问面，不改变普通文章 Browser flow。

真实 Provider probe 不进入 Harness，精确
现场范围需要用户另行授权。

核心 probe 返回 `CoreConfigurationProbeResult`，details 分别为
`AgentConfigurationProbeDetails`、`ModelConfigurationProbeDetails`、
`ModelProviderConfigurationProbeDetails` 和 `MinerUConfigurationProbeDetails`，共同固定
`persisted = false`。实际发出请求时，details 还保存经过普通配置与 Network URL 规则验证的
`request_method/request_url`；Agent task probe 同时保存完整 `model_reference`、本地 `provider` 与实际进入
wire payload 的 `model`。失败可以额外携带只包含
三位 `http_status`、闭合 Network `access_code` 和闭合 Provider `remote_error` 的
`failure_evidence`。CLI 的共享 diagnosis builder 把同一 payload 投影为 `request/reason/action`，
因此 TUI 与 `--json` 不会各自猜测原因。人类表格只显示 `Test / Request / Result`：Test 把 wire Model
与本地 Provider 分行显示，不把 `provider/model` reference 冒充发送值；Request 显示实际 method、
endpoint 和该 Model 本次 stream on/off；Result 为结果、
一句原因和失败时的一项下一步，不显示内部 failure code 或检查清单。响应 body、任意 Provider
message、header、query、credential 和异常不进入这些字段；404 没有 `model-not-found` 等闭合证据时
只能解释为 Model 或 endpoint 二者之一不存在。任何 probe 都不创建 DiscoveryRun、Literature、MetadataObservation、
Asset、Catalog、Report 或测试历史，也不把认证通过解释成具体文献全文 entitlement。

配置 Probe 会在安全、授权和 adapter 条件满足时执行一次有界只读请求，证明对应 endpoint/capability 的最小可用性；它不证明完整业务流程或具体文章 entitlement。正式业务能力仍由 Entry 路径验收：Search 使用 `discover topic`，PDF 获取使用 `complete pdf`，Parse/Analyze 的真实内容链路使用 `complete content`。

### 5.9 离线验证要求

直接测试覆盖 Source Auto/Custom、版本默认 catalog、Custom 空/精确顺序、Auto 禁止固定
providers、默认及自定义逐 Source limit、旧 discovery schema 拒绝、严格 Provider/Model registry、Analyze/Browser 直接引用与 image 门槛、八级 Model
reasoning、Model stream 默认开启/显式关闭与三协议传播、旧 singleton/Service/Profile/Entry 普通配置与 credentials `[agents]`/`[models.*]` 在菜单前严格拒绝且零写入、多 Provider adapter 选择、Agents role capability/单次
limits、URL/limit 组合、origin 错配、权限/符号链接、round-trip、staging 失败、跨文件每个中断点、
三种 LLM protocol、认证 redirect、MinerU health-only、Browser
Profile 安全树/固定 identity manifest/独占 lease/显式删除、Cloak binary install/update/rollback、
共享 runtime 与文章临时目录清理、只允许收紧的 policy、
API/Browser readiness 分离、单词级首页与 owner 子页、四主题、窄终端、快捷键、取消和
secret/Cookie 不泄漏。当前 TypeScript 验证使用合成临时 home、测试自有 `credentials.toml` 与 fake/loopback transport；它不得使用旧 secret 环境变量、真实凭据/Cookie/Profile、真实网络、生产 Catalog 或用户语料。历史 wheel/Pyright/unittest 旅程仅属于归档迁移证据，不是当前门禁。当前代码交付必须运行 `pnpm full`（Quick、Vitest 和 TypeScript build）；真实 Provider、MinerU、CloakBrowser 或 Browser→MinerU→Analysis 闭环未获授权或未运行时必须单独标记，不能由离线 Full 替代。

### 5.10 生效模型、请求授权与 Web 发布

#### 5.10.1 三种配置时点

| 对象                  | 捕获或读取时点                           | 发布后的行为                                               |
| --------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| 普通 Application 参数 | `createApplication` 时的 revision        | 已运行进程继续使用启动快照；新 CLI 构造读取新值            |
| 显式 probe            | 每次测试新建 `ConfigurationProbeSession` | 保存后的下一次 probe 使用新配置，结束确定性 close          |
| 当前请求的凭据        | 已组装 adapter 派发每次请求之前          | 下一请求看到撤销/轮换；已进入 transport 的请求按原授权结算 |

`configuration_revision` 与保存的 snapshot revision 分开比较。普通参数保存成功并不等于现有 Browser/Jobs 对象图已经重组装。启动时未组装的能力也不会因后来补 key 自动出现；必须重启/重建 Application。已组装能力的新请求能够重新授权凭据，两者不能合并成一个“保存后立即生效”的承诺。

Metadata、授权 Acquisition、Agents 的 HTTP POST 和远程 MinerU `/parse` 在新外部动作边界复核当前凭据。必需凭据缺失在本地拒绝，再进入 transport 就太迟；允许匿名的公开来源维持其原本无 key 行为。loopback 服务继续禁止携带远程 credential，origin 改变不复用旧授权。

#### 5.10.2 Web 配置发布协议

1. GET snapshot 得到普通配置与 revision；页面按 section 保存独立草稿。
2. 提交只包含该 owner section 的 typed projection 和 baseline revision。
3. owner 重新读取当前文件、验证字段/引用，比较 revision，再合并和原子发布。
4. 成功响应返回新的权威 snapshot；页面以它更新 revision，不等待后续 readiness 查询来判断是否已保存。
5. readiness 获取失败只提示状态暂不可读，不能将已经成功的发布显示成“未保存”。请求结果未知时提示结果未确认，不自动重提。
6. 冲突保留草稿并要求读取当前版本；校验拒绝不写文件。普通发布在页面内串行，其他未保存表单不能被刷新覆盖。

运行时投影包含 `runtime_configuration_current`、`ordinary_configuration_restart_required`、`application_restart_required`、`application_restart_reason` 与 `runtime_capabilities`。缺少运行时信息返回 unknown/null，不凭保存动作猜测已经具备能力；补 key 不得消除尚未应用普通配置的重启提示。

#### 5.10.3 Sources 与 Models 的编辑完整性

Sources 的 Auto 使用服务端版本目录，前端不复制默认 Provider 清单。Custom 保留已保存顺序；只改扫描 limit 不重排来源，新选来源按明确顺序追加。内部 `web_of_science`/`sci_hub` 投影写回 TOML 时仍使用既有 `web-of-science`/`sci-hub` 名称，不能放宽解析器接受另一套配置拼写。

Provider 删除/改名须检查 Model 引用，Model 删除/改名及 image 能力变更须检查 Analyze/Browser 选择。页面只发布 providers/models，不顺手修改任务选择；Browser 只能选 image Model。凭据始终走独立密码输入与 owner 操作，不混入普通 snapshot 或 diff。

Web 当前可编辑 Sources、Provider/Model、任务 Model 选择及已有 Parser/Browser 字段；尚未暴露的高级字段由同一 CLI 或固定 TOML 配置。界面覆盖范围不改变 owner 的完整 schema，也不额外建立配置事实源。

### 5.11 配置数据边界

普通配置的 `OrdinaryConfiguration` 与解析器当前位于 server 的 `configuration/index.ts`；公共 `ConfigurationReadiness` 从 contracts 导出，只包含安全投影。它可以表达稳定 Provider key、`metadata`/`acquisition` capability、启用状态、非 secret 产品选择、AccessPolicy、凭据字段名称/必需性/存在性，也可以表达 LLM provider/protocol/Base URL/model/context/authentication/预算与 MinerU connection mode/Base URL/model identity/upload consent。服务 URL 和预算 validator 只执行结构与安全组合检查，不读取文件、secret 或 Network。Provider 凭据使用以下本地状态：

```text
not-required
configured
partial
missing
optional-missing
unsupported
```

真实 Provider API key、metric、Cookie、浏览器 session、凭据文件原文和任何可以辨识这些 secret 的值、掩码、长度、hash、前后缀或 fingerprint 都不能进入普通 `packages/contracts` Model。设备配对/令牌仅在本篇 2.4.1 的专用认证交付类型中短暂存在，不成为文献事实、普通 Web 状态或审计结果。Model 也不承担读取 `~/.sciretriever/credentials.toml`、检查 owner/权限、隐藏交互、原子写入或调用 Provider；这些都是 configuration/CLI/adapter 边界行为。

若 `config status` 或 `config test` 提供 JSON，结构化结果只组合非 secret 普通配置、稳定 Provider key、capability、安全状态、统一凭据 presence/origin-match、通过/失败/跳过结果和稳定 failure code。`ConfigurationRuntimeStatus` 分组表达 Storage、MinerU 与 Analysis 本地完整性；`CoreConfigurationProbeResult` 以中性 typed details 分别表达任务 Model、精确 Model、Model Provider 目录和 MinerU health-only probe，并固定 `persisted = false`。`ConfigurationProbeSummary` 同时承载 Search Metadata 结果和 Download 的 `acquisition-probe-unavailable` 限制，不把未执行外部 Acquisition probe 解释为通过。它们不包含 secret 值或其可辨识特征、原始网络异常、响应正文、测试时间、Literature 身份、DiscoveryRun 或 Report；结果只是本次非持久化配置诊断，不成为 Entry 处理 Report 或数据库 Model。认证接受与具体文献全文 entitlement 必须分别表达，不能由 Model 字段合并成一个“可下载”布尔值。

### 5.12 TypeScript 配置与凭据 owner

`TypeScriptConfigurationOwner` 直接读取和发布受支持 TOML projection，`Credential` 由同一 owner 通过独立文件、原子替换和 exact-origin grant 管理。Application 启动时固定普通配置与 credentials bundle，并暴露启动时的普通配置 revision。revision/CAS 冲突在发布前拒绝，凭据只在明确的 provider/origin/operation 范围内短时可读。

`status` 输出闭合的 `ConfigurationReadiness`，只暴露本地状态、下一步和凭据 presence；TUI/非 JSON CLI 与 Web 使用相同投影。status 不联网，显式 test 才能访问 loopback 或获准外部端点。CLI TUI 每次 Probe 创建新的 session，Application-backed CLI 命令也逐次构造 Application。Workbench 的 configuration read/publish 响应指出保存 revision 是否匹配运行中 Application 的启动 revision；Web 明确提示不匹配时重启服务，并且其显式 Probe 每次从 owner 创建新 session。配置发布不热重配已运行的普通 Browser/Jobs 对象图。

Web 分区提供 Source Auto/Custom 与来源参数、Provider/Model 注册和任务模型选择，调用同一 owner 的 section 发布。局部保存保留其它分区草稿，并串行管理保存按钮；已保存引用的删除/重命名要先调整任务选择。运行快照投影实际 Parser 组装状态、来源选择与启动 readiness，和保存后的 readiness 分开。总重启字段涵盖普通配置变化与缺凭据导致的能力重组装；未知投影用 null，不从 Probe 成功推断当前 Application 已可用。

凭据与普通参数的生效边界不同：长寿命 Application 保留启动时普通配置 revision；Metadata Provider、Agent、MinerU 与授权 Acquisition adapter 在每次新外部请求派发前由 Configuration owner 重读凭据文件并复核 namespace/provider/field/origin/operation。已进入 transport 的请求可按原授权结算，下一请求重新授权；缺失凭据在其 owner 边界形成稳定失败。Resolver 不保存新的 secret 副本。Python 配置 owner 仅作为历史 oracle 保留，不在 TS 生产入口、安装包或 Application 生命周期中启动。

## 6. 共享合同、结构解析与版本兼容

以下规则属于统一接口使用的中性合同基础；具体数据所有权仍归各业务模块。协议版本、对象 schema、方法版本、内容版本和控制 epoch 分开解释。

### 6.1 实现位置与合同分组

```text
packages/contracts/src/
  index.ts             # identity/metadata/assets/query/reports/browser/execution 导出与解析
  content.ts           # AnalysisInput、LiteratureContent 与 proposal 校验
```

文件清单以实际仓库为准；合同按语义分组，并不要求每组拆成独立文件。跨模块传递中性值，库外消费者使用包导出；应用进程中的 SQL、文件句柄、取消信号和 adapter 不编码成 JSON。

### 6.2 Provenance 公共合同

`Provenance` 是各模块通过组合复用的公共来源追踪数据，不是其它 Model 的父类。精确 schema 为：

```text
Provenance
  provenance_id: ProvenanceId
  source_kind: SourceKind
  source_name: str
  source_record_id: str | None
  observed_at: UtcTimestamp
  input_sha256: Sha256 | None
  parameters_sha256: Sha256 | None

SourceKind = "metadata-provider" | "asset-provider" | "parser" | "analysis" | "user"
```

| 字段                | 含义                                                                   |
| ------------------- | ---------------------------------------------------------------------- |
| `provenance_id`     | SciRetriever 分配的来源追踪身份，不是业务对象、供应商记录或批次 ID     |
| `source_kind`       | 元数据供应商、资产供应商、解析器、逻辑 Analysis 或用户等来源类别       |
| `source_name`       | `crossref`、`openalex`、`mineru` 等稳定具体来源名称                    |
| `source_record_id`  | 来源系统中的记录 ID；该来源没有独立记录身份时为空                      |
| `observed_at`       | SciRetriever 实际获得或观察到这条来源信息的 UTC 时间，不是文献发表时间 |
| `input_sha256`      | 产生该事实所依据输入的 SHA-256；无法定义稳定输入时为空                 |
| `parameters_sha256` | 影响结果的规范化查询或处理参数 SHA-256；没有有意义参数时为空           |

Provider 形成的 `MetadataObservation` 使用 `source_kind = "metadata-provider"`，并要求非空 `source_name`、`source_record_id`、`observed_at` 和 `input_sha256`。书目导入形成的 `MetadataObservation` 使用 `source_kind = "user"`、`source_name = "bibliographic-import"`、`source_record_id = None`，`observed_at` 为接纳该记录的 UTC 时间，`input_sha256` 和 `parameters_sha256` 均为空；它只表达用户明确提供元数据，不保存原始文件或导入过程身份。其它 `source_kind` 不能用于 `MetadataObservation`。Provenance 不保存凭据、header、cookie、完整 URL query、原始响应、未脱敏异常或机器相关绝对路径。已经处于一个来源上下文中的 `LiteratureMetadata`、`version_links`、原始 `reference_texts` 和 `AssetHint` 复用父级 Provenance，不重复携带。元数据供应商每条结构化有向引用边形成独立 `ProviderRelationObservation` 并拥有关系来源 Provenance；同一响应的多条边可以复用同一 Provenance。相关文献自己的供应商记录 ID 只进入 `ProviderLiteratureKey.record_id` 或其 Provider `MetadataObservation.provenance.source_record_id`，不能成为本地身份。`ReferenceSupport` 只定位这些来源，不重复保存 Provenance。

### 6.3 外部类型隔离

Model 不能导入或暴露：

- Vendor SDK model；
- HTTP request/response、header 或 cookie 类型；
- Playwright page、context 或 download 类型；
- `node:sqlite` row、statement、connection 或 SQL 结果类型；
- MinerU 私有响应；
- LLM vendor 私有响应；
- 机器相关绝对路径。

外部适配器必须先把这些类型转换成中性 Model。转换失败停留在适配边界，不能通过裸字典或 `Any` 穿透。

### 6.4 标识、时间与序列化

- `Literature` 身份、metadata revision、内容 artifact identity 与 schema version 使用不同类型和字段名；
- SHA-256 统一使用小写十六进制表达；
- 持久化时间统一为 UTC；
- 文件引用使用配置存储根下的规范化相对路径；
- 需要确定性持久化或 hash 的对象使用明确的 canonical serialization 规则；
- 普通 API 序列化不能暗中改变业务含义、排序或缺失值语义。

具体身份、排序和状态算法不放入 Model。

### 6.5 不建立 DocumentPackage 占位

[ADR 0008](../../archive/decisions/0008-summarized-markdown-literature-content.md) 已撤销 ADR 0005 的 `DocumentPackage` 2.0 目标合同。当前 contracts 不保留 DocumentPackage 占位，不公开该名称，也不建立对应 API、数据库表、文件命名空间、状态或 CLI。未来出现明确完整快照需求时，先确认消费方和公开合同，再新增 ADR 与 Model；不能让空占位暗示过时合同仍会实现。

### 6.6 验收

直接测试至少证明：

- 未知字段、错误枚举、无效 ID/hash/time/path 被拒绝；
- `Identifier` 拒绝空 namespace/value 和畸形的已知标识符；DOI 裸值、`doi:`、已知 resolver URL、大小写与边界空白得到同一小写裸值，且不会错误删除 suffix 标点；
- arXiv 新式/旧式、`arXiv:`、官方 abs/pdf URL、`.pdf` 与 `vN` revision 得到不带 revision 的同一基础 ID；PMID 保持纯数字，PMCID 使用大写 `PMC`，未知 namespace 只 trim 而不做全局大小写或标点转换；canonicalization 幂等且确定；
- `Identifier` 不接收独立的 `url`、`provider`、`provenance`、`primary` 或 `confidence` 等额外字段；已知 resolver URL 只允许作为 `value` 的输入包装并立即去壳。Provider record ID 只能进入 `Provenance.source_record_id` 或 `ProviderLiteratureKey.record_id`；validator 不执行 Provider 语义归类、身份合并或 I/O；
- `Author` 能表达个人、机构与未知署名并保持作者和单位顺序；ORCID 校验格式与校验位，缺失姓名组成、ORCID 或 ROR 时不猜测；
- `ParserArtifactRef`、`ParserResource`、`ParserProvenance` 和 `ParserResult` 拒绝未知字段、不安全资源引用、重复 reference、无效 hash/媒体类型/大小、错误 parser kind、输入 hash 不对齐和非确定结果清单；
- 默认不可变和不可变容器成立；
- Topic/Citation DiscoveryInput 拒绝空 query、无效年份、重复 Provider、非正 scan/result limit、空 citation seeds 或负 depth；每个 Provider 的 scan limit 作用于整个 Run，citation result limit 按种子外的不同 MetaLiterature 计数；
- DiscoveryRun 只接受 ID、类型化输入、五态 status 和开始时间；source result 只接受 Provider、三值 outcome 与匹配的可选 failure，result/cause 不接收 Provider cursor、request/response、搜索分数、过程计数、完整路径、处理目标或自动 advance 字段；
- CitationDiscoveryCause 保存不同的 source/target Literature 与正 depth，不依赖 ReferenceId；Topic cause 指向实际 MetadataObservation；
- `BatchRequest` 只包含六类运行时 BatchSelector 之一和 BatchGoal；其中导入范围必须使用 `ImportReportSelector`，不存在 ImportRun 或 CollectionSelector，selector 不接收执行策略或自由 details，目标与候选只在 Entry 内存中保持有序且不成为持久 Model；
- `EntryReport` 只接受 `DiscoveryReport`、`DatabaseCompletionReport`、`ManualPdfReport`、`ImportReport` 或 `ExportReport`；五者只共享 `finished`、`interrupted`、带 `StableFailure` 的 `failed` 三种 `ReportEnd`，不建立通用 envelope；
- `StableFailure` 只接受非空 `code/reason/action` 和布尔 `retryable`，不接受原始异常、URL、凭据、正文、路径或自由 details；Discovery 与 Report 复用同一类型；
- Provider 配置 Model 只接受稳定 key、capability、非 secret 配置和安全状态/失败；凭据值或其掩码、长度、hash、fingerprint、原始文件、网络响应、测试时间和 entitlement 推断不能进入公开 TypeScript 合同或 JSON；
- `DiscoveryReport` 保持输入 Provider 顺序，逐来源 outcome 与 failure 匹配，所有运行时 count 非负且不复制 cursor、结果 ID 或发现路径；
- `DatabaseCompletionReport` 的 `completed`、`failed`、`skipped`、`notStarted`、`interrupted` 对冻结目标不重不漏；`skipped` 必须带稳定 reason，不能隐藏系统错误；`no_usable_content_literature_ids` 只是可与最终分区重叠的本次反馈，不成为目标状态或候选历史；
- `ManualPdfReport` 正常结束时恰有 accepted/rejected 结果，中断或操作级失败时 result 为空，且不保存用户输入路径或 PDF 字节；
- `ImportReport.records` 与 `not_processed_record_indexes` 对输入索引不重不漏，`accepted_meta_literature_ids` 按首次出现顺序去重，并能直接形成非空 `ImportReportSelector`；
- 导入边界只组合既有 `LiteratureMetadata`，不建立第二套导入元数据字段；导入 observation 只接受固定 user/bibliographic-import provenance，Provider observation 只接受 metadata-provider provenance；
- ImportReport 能区分 created、以用户值补缺或替换供应商当前值的 enriched、当前统一投影不变的 matched，以及格式/最低识别/稳定标识符冲突导致的 rejected；首次匹配 Provider 值的用户记录仍保存 observation，只有完全重复的 user observation 不复制；
- `ExportReport` 的 published/skipped/not-published 对 selected 不重不漏；只有文件完整原子发布后才允许非空 published 和 `bytes_written`，中断或操作级失败保持旧输出不变；
- Model 不公开 BatchRun、BatchStatus、BatchTarget、候选 snapshot、目标结果、批次 counts、普通 current failure、ReportId、报告时间/持续时间、通用报告 status、日志事件数组或第二套摘要 counts；
- `AutomaticPdfAcquisitionExhaustion` 只接受 LiteratureId，不接收 reason、Provider、candidate、配置 hash、时间、次数或状态，也不增加 LiteratureStatus；
- 目标 Model 不再公开 `CollectionRun`、`requested_advance_to`、`include_all_versions` 或其它发现与处理混合合同；
- `LibraryQuery` 完成字符串/tuple 规范化、年份范围和封闭 role/status/missing-step 结构验证，并拒绝 sort/cursor/include/raw SQL/FTS、Provider 私有字段或文件路径；字段间 AND、一般多值 OR、keywords AND 和实际匹配由 Literature 查询测试证明，不在 validator 中执行数据库语义；
- `LibrarySearchRequest` 默认按发表年份降序且 limit 为 50，只接受正 limit 和非空不透明 cursor，relevance 要求非空 text；`LibrarySearchPage` 只接受非负 total、不可变无重复 items 和可选 next cursor，实际排序、cursor 绑定与翻页由 Literature/Storage 查询测试证明；
- `LiteratureSearchItem` 以具体 Literature 为单位并复用其中的完整 metadata/status，不建立 MetaLiterature 折叠结果、MetadataSummary 或第二份顶层 metadata/status；
- `LiteratureDetail` 和 `LiteratureAssetView` 只组合既有中性 Model、非负计数和明确可选字段，不接受 artifact 字节、完整关系图、Discovery 历史、Report/log/failure 或自己的 ID/provenance/hash/revision；Meta 归属、observation 归属、primary role、ParserResult/Content 对齐、三级 status、第一缺失步骤、人工 PDF 标记和其它版本一致性由 Literature/Storage producer 测试证明，Model validator 不重新形成这些业务决定；
- `LiteratureReferenceRequest` 只接受具体 LiteratureId、正反两个方向、正 limit 和不透明 cursor；`LiteratureReferencePage` 只接受非负 total、不可变无重复 items 和可选 next cursor，方向端点、稳定排序、cursor 绑定与同一 snapshot 由 Literature/Storage 查询测试证明；
- `LiteratureReferenceItem.support_count` 至少为 1，相关 Literature 复用非递归 SearchItem；`ReferenceDetail` 必须组合同一 Reference 的 source/target SearchItem 和至少一项去重 support，不复制来源原文、observation 或 provenance；
- Artifact 读取只接受既有 `Asset`、`ParserArtifactRef` 或 `ArtifactRef`；binary stream、context manager、用户目标路径和文件字节不形成序列化合同，也不进入 Detail、JSON、Catalog 或 Report；
- 边界 validator 只执行纯结构转换；
- Vendor、HTTP、浏览器、SQL、MinerU 和 LLM 私有类型没有进入 Model；
- 同一 canonical 输入得到确定序列化结果；
- `DocumentPackage` 名称、占位和旧 Package 2.0 类型没有进入目标 Model 或公开 API；
- `MetadataAnalysisResult` 只接受无附加字段的 `NoUsableContent` 或携带完整 `LiteratureMetadata` 的 `FinalMetadataProposal`；
- `LiteratureContent` 只接受与第一阶段最终 metadata revision/hash 对齐的有序 sections 和 references；章节正文使用 Markdown 字符串，四个固定 role 恰好各一次，additional 标题非空且不与保留标题冲突；固定缺失值为“未提供”，空 references 不把缺失标记作为条目；
- 内容 hash、UTF-8 Markdown artifact hash 和单一 `source_kind = "analysis"` provenance 的字段与覆盖范围严格区分，不接受 `LiteratureContentLineage`、两次 LLM provenance tuple 或 Parser provenance 副本；
- `MetadataObservation.version_links` 只接受至少具有一种稳定定位的 `ProviderLiteratureKey`，不接受关系类型、本地 ID、目标 metadata 或状态，也不产生 `LiteratureRelationObservation` 或 `LiteratureRelation`；
- `Reference` 和三种 `ReferenceSupportSource` 拒绝未知字段、错误判别值、负索引和额外混合字段，且 support 不产生第二份 provenance 或原文；
- `ProviderRelationObservation` 一条只接受一条 citing/cited 边，两个 key 至少有一种稳定定位且不能相同，不接受 query direction、本地 ID、目标 metadata 或扩展状态；
- `PdfCandidate`、`Asset` 和 `LiteratureAsset` 拒绝边界外字段；候选只接受 candidate key、route adapter 的稳定 source identity、三值 acquisition path 和可选声明媒体类型且不持久化，不接受 URL、header、Cookie、凭据、API object、页面 action 或失败原因；Asset 不混入文献归属，LiteratureAsset 不复制版本角色或 `is_current`；
- 自动 `AcquisitionResult` 只允许完整提交的 `AcquiredPrimaryPdf` 和无字段 `NoPrimaryPdf`，不能用原因枚举或第三个结果承载系统错误；`AcceptedManualPdf` 是独立成功类型且不接收 path，输入验证错误不进入该联合；

架构检查和人工语义审查共同验证 Model 没有形成第二套业务规则。

### 6.7 新知识合同的版本与组合

完整目标接口见[新知识合同的版本与组合](#92-新知识合同的版本与组合)；当前实现以源码为准。

### 6.8 设计依据与适用范围

完整目标接口见[设计依据与适用范围](#93-设计依据与适用范围)；当前实现以源码为准。

### 6.9 交换对象及其含义

完整目标接口见[交换对象及其含义](#94-交换对象及其含义)；当前实现以源码为准。

### 6.10 公共解析入口

所有外部 JSON、数据库重建值、CLI/HTTP 输入都先作为 `unknown` 进入相应 `parse*` 边界：

1. 校验对象类型及允许字段，不用 TypeScript 类型断言替代运行时验证。
2. 按合同处理必填、null 与省略；不能把数据库损坏默认为空对象。
3. 检查字符串/整数/判别联合/数组元素与跨字段结构约束。
4. 构造新的中性值和只读数组，避免把外部可变对象传给业务层。
5. 需要 hash 的解析器执行确定序列化和 hash 复核；异步 parser 必须被 await。
6. 拒绝未知协议/schema 版本；不能在读取过程中回写升级。

常用入口包括 `parseLiteratureMetadata`、`parseMetadataObservation`、`parseLibrarySearchRequest`、`parseParserResult`、`parseLiteratureDetail`、`parseLiteratureContentProposal` 和 `parseDatabaseCompletionReport`。`ContractValidationError` 只表示合同解析失败；展示边界还应区分非法用户输入与存储/上游对象违反合同，不能凭错误类型把真实故障说成零命中。

解析器不得执行身份合并、元数据 precedence、PDF/内容判定、状态推导、入库/导出决策、环境读取或网络/文件 I/O。规范化 DOI 等纯格式处理与业务接纳分开；例如“至少有标题或 DOI 才能入库”由 Literature 的准入规则执行。

### 6.11 字段记法与合同分布

以下数据结构代码块使用语言中立记法：`str` 表示字符串、`int` 表示通过整数约束的 number、`None` 表示 JSON null，`tuple[T, ...]` 表示有序只读数组。它们描述字段与约束，不是可导入的 Python API。当前 TypeScript 示例使用 `readonly` 和 `null`；JSON 字段名保持兼容，不因语言迁移改名。

## 7. MCP 适配

### stdio

正式适配使用官方 MCP TypeScript SDK，`sciretriever mcp` 默认只读，`--maintenance` 增加
显式维护工具；具体命令、schema 和行为见[Agent 接口指南](../../guides/agent-interface.md)。
工具声明副作用并经过 JSON Schema 初检及所属产品合同解析；不开放 SQL、凭据、任意路径、
Browser/CDP、脚本或任意 prompt。查询缺口不启动维护 Application。

MCP 复用 Application/QueryApplication；stdio stdout 仅承载 JSON-RPC，调用错误脱敏。
大型原始材料默认只交付引用，有界片段通过文档读取合同获得。提交任务只返回执行引用，
完成与产物由任务和业务读取结果说明；不将工具调用成功等同于 PDF 或知识生成成功。

MCP 服务进程存续期间任务可在工具调用之间继续；关闭进程会停止在途工作并保留已提交事实，
停止后不继续后台执行。重启后的未知项需显式恢复，不自动重放收费调用。新进程读取任务
通过只读 QueryApplication，不触发恢复。stdio 不创建常驻 daemon；HTTP 复用下述 Web owner，仍无远程多租户身份。

### HTTP 版 MCP

按 ADR 0058，正式与合成工作台的同一地址提供 `/mcp`（Streamable HTTP），使用仓库既有的 MCP SDK 1.27.1。POST 接受 MCP JSON-RPC，GET 是可选的 SDK SSE 通道，DELETE 关闭协议会话；每次请求都要求设备 Bearer 令牌。认证沿用[设备连接](#241-设备连接与按用途准入)，不以 Cookie 或 session ID 代替令牌，也不授予原 Web/配置端点权限。

SDK 初始化生成 `Mcp-Session-Id`，后续请求带同一 ID 和令牌；会话绑定 connection_id，另一设备不能借此进入。`Mcp-Protocol-Version`、初始化与取消通知由 SDK 处理；不保存 event store，断线不承诺重放旧响应，应按稳定任务/结果 ID 查询事实。协议会话只在进程内，重启后重新初始化，不形成业务状态或 catalog 表。

工具声明与处理只维护在 `mcp/tools.ts` 和 `mcp/server.ts`。HTTP 规则由 `httpMcpPurpose/httpMcpAllowed` 定义，并在 tools/list 和 tools/call 两处执行：

| 设备用途         | 工具                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| read             | stdio 的 `QUERY_TOOLS`，去除 `configuration_*`；包括只读导入状态与报告 |
| operate          | stdio `MAINTENANCE_TOOLS` 中的业务工具，去除配置和输入传输工具         |
| read + operate   | 上述并集；两种用途互不隐含                                             |
| capture / import | 不授予 MCP 权限；导入会话继续走[导入 HTTP](#242-导入会话-http)         |

HTTP 不提供 `configuration_*`、`device_*`、`browser_*`、`runtime_*`，也不提供 `import_bibliography`、`begin_pdf_upload`、`append_pdf_upload`、`commit_pdf_upload`、`discard_pdf_upload`。导入数据与文件不经 MCP；stdio 的这些既有能力及 `--workbench-url` 保持。未知或用途不足的工具既不列出，调用也以 `device-purpose-forbidden` 拒绝。

两种传输新增 `import_session_status({session_id}) → {session}` 和 `import_session_report({session_id,cursor?,limit?}) → {session,estimated:false,summary,items,next_cursor}`。报告分页沿用 03 的 sequence:record_index 游标、默认 50/最多 200。QueryApplication 只组装既有 ImportSessionReadService，不创建写入 Application、恢复会话或推进导入。模型与分类见[书目交换规则](03-literature-materials.md#61-书目交换规则)。工具成功仍采用既有 MCP `{content,structuredContent:{protocol_version:1,result}}`；业务失败为 isError=true 与 result.failure.code，不回显内部异常。

MCP HTTP 总 JSON 上限 10 MiB，以容纳原有 `proofread_save`；各工具参数继续受原来 1 MiB+4 KiB 或该工具 9 MiB 限额，回执保持 4 MiB。协议会话最多 64、每设备 8；没有在途 HTTP/SSE 的会话空闲 30 分钟后清理（每分钟及新请求时检查）。服务关闭、显式 DELETE 或 Web 设备撤销会关闭连接；撤销取消在途调用，已经接纳的 durable 任务继续由业务 owner 管理。MCP 连接只借用 Web 的 Application/QueryApplication，不关闭共享 owner。审计身份固定为 `mcp:device:<connection_id>`，不采用客户端自报名称；认证与 Cookie 不传给 SDK 请求上下文。

认证失败沿用设备错误封套。MCP 适配层返回标准 JSON-RPC error，data.code 为 mcp-input-invalid（400）、mcp-request-too-large（413）、mcp-session-required（400）、mcp-session-missing（404）、mcp-session-limit（429，Retry-After 60）或 mcp-unavailable（503）；跨设备 session ID 为 device-purpose-forbidden（403）。SDK 的协议/版本错误保持其标准 JSON-RPC 响应。连接状态不是授权缓存，下一次 HTTP 和工具请求继续核对 catalog 中的有效性。

### 显式连接现有运行时

CLI/MCP 的 `--workbench-url` 接受显式 IPv4 HTTP origin（所有连接须提供同一 Web 密码或启动 API key），通过 `workbench/machine-client.ts` 连接已存在的工作台 HTTP owner。认证材料仅保留在进程内，动作沿用 WorkbenchActionCommand、session/article、epoch 和 lease 校验；工具只映射封闭业务操作。`runtime_*` 任务入口在该服务的同一个 Application 执行，独立机器进程不再争用执行锁。断开需确认服务端 detach；若仍持控制租约则遵守既有暂停政策。Web、CLI、MCP 的材料字节均经 LiteratureArtifactService 或 ManualPdfIngestionService，MCP 分块缓冲不构成持久业务事实。传输限额和命令见[Agent 指南](../../guides/agent-interface.md)。

### Web 结果与阅读接入

正式工作台使用共享处理器 `query/evidence/transfer`；`results` 增加可选 `literature_id`，Storage 在既有固定文档、材料、知识和结果输入关系上递归投影，排序和 next_after 语义不变，不新增业务表。无字段证据的未知记录仍按其固定输入关联文献。CLI/MCP 使用同一 Entry 验证与实现。

React入口由Vite按需加载阅读模块，保留框架无关引擎；不再提供旧 `/reader.js` bundle。`build-reader-assets.mjs` 交付PDF.js worker、cMaps、标准字体、wasm、KaTeX字体和文字层CSS；静态服务只枚举随包资源，不把HTTP路径映射成任意文件路径。主工作台允许本地worker与受控Blob，仍拒绝JavaScript eval和外部连接。独立查询/维护使用相同React外壳，各自原有读取、CSRF和能力边界保持。

PDF 原字节仍按固定 asset_id/hash、大小与 SHA-256 校验，受 256 MiB 读取上限约束；可见页及邻近页才持有 canvas/文字层。全文使用有界 document-slice 续读，按原始 UTF-8 与 Markdown 块映射保存位置、定位证据；CRLF 与 Unicode 不按 DOM 字符索引混算。图片通过 document-resource 分块读取并校验，不请求 Markdown 的远程图片 URL；内嵌支持 PNG/JPEG/GIF/WebP，单图超过 16 MiB 时显示不支持预览。会话 UI 状态按库和固定版本隔离，关闭文献释放状态。阅读没有模型、加工或索引重建副作用。

### React适配与证据读取边界（ADR 0036）

`apps/web/src/app/data/` 负责已有HTTP封套、固定来源解析、Query缓存和失效；`features/` 只保留页面展示与草稿，文献选择、任务、结果和持久事实仍由既有业务owner提供。TanStack Query消费AbortSignal，离开页面中止在途读取；Browser心跳和控制epoch变化不触发全库重读，真实发布和重连才失效材料查询。URL参数沿用既有格式，不引入另一套路由合同。

处理结果使用既有processor `query/evidence/transfer`；文档证据使用 `evidence-resolve`，知识与综合使用 `synthesis-source`。旧知识库因此不需要处理器schema才能核对综合。综合递归来源保留并验证内容、输入清单和断言hash；只剩已存产物时明确“原PDF未复核”。分段证据验证实际UTF-8范围连续，跳转使用完整 `target_range`，不把首个传输块冒充完整证据。

本机UI偏好包括主题、栏宽、默认阅读字号/行宽与按catalog隔离的保存筛选；它们不成为文献事实。它们只读写当前React命名空间，不读取旧键、不执行偏好迁移；不读取或复制凭据、Cookie、文献正文或其它应用数据。

## 8. 运行审查与校订编辑

三端新增读取 `proofread-text`、`agent-sessions`、`task-run`、`usage-estimate`、`processor-runs`、`literature-results`、`operation-history`，由统一 QueryApplication 提供有界读取，模型身份仅从配置解析，不加载凭据或调用模型。机器请求映射见[Agent 接口](../../guides/agent-interface.md#校订与运行审查入口)。

维护操作 `proofread-save` 固定 asset、当前 proofread 版本和完整 Markdown，以 CAS 发布人工决定与新版本，然后重建文档、无模型结构规则和引用；后续失败返回已保存事实，不撤销人工稿。只有此 HTTP 路径放宽到 9 MiB，正文最多 8 MiB，其余请求上限不变。Web 身份绑定独立认证会话，CLI/MCP 绑定入口和系统用户；调用输入不能覆写实际身份。

历史预估使用与执行相同的固定输入、规范、方法和模型键。无样本返回无法预估；只显示输入/输出 token 历史中位数至 P90、样本及复用数，不构成预算或执行时限。

## 9. 目标接口（尚未实现）

本节集中保留尚未整套实现的目标合同；当前实现以源码为准，设计记法不等同于已发布 API。

### 9.1 Entry 公开 API

目标 Entry API 只公开下面这些文献数据库用户操作。表中的英文是稳定责任名，不是当前 TypeScript 函数名，也不能据此推断对应导出已经存在。它们与[文献操作 CLI 与 operator 入口](#312-文献操作-cli-与-operator-入口)的文献操作 CLI 对应，但 API 名称和 CLI 层级仍是两个不同合同，不能通过字符串转换自动生成。`config` 是生产启动配置的 CLI 边界，直接复用根级 configuration/bootstrap 能力，不进入文献业务 API。

| 能力              | 目标 Entry responsibility    | 输入                                                                                                       | 直接结果                           |
| ----------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 领域发现          | `discover_topic`             | `TopicDiscoveryInput`                                                                                      | `DiscoveryReport`                  |
| 引用发现          | `discover_citations`         | `CitationDiscoveryInput`                                                                                   | `DiscoveryReport`                  |
| 数据库补全        | `complete_database`          | `BatchRequest`                                                                                             | `DatabaseCompletionReport`         |
| 手动 PDF 接纳     | `admit_manual_pdf`           | `LiteratureId`；PDF 是本次只读 binary input                                                                | `ManualPdfReport`                  |
| 本地文献搜索      | `search_literature`          | `LibrarySearchRequest`                                                                                     | `LibrarySearchPage`                |
| 单篇详情          | `get_literature_detail`      | `LiteratureId`                                                                                             | `LiteratureDetail`                 |
| 正向/反向引用页面 | `list_literature_references` | `LiteratureReferenceRequest`                                                                               | `LiteratureReferencePage`          |
| 引用关系详情      | `get_reference_detail`       | `ReferenceId`                                                                                              | `ReferenceDetail`                  |
| Artifact 打开     | `open_artifact`              | `Asset \| ParserArtifactRef \| ArtifactRef`                                                                | context-managed 只读 binary stream |
| Artifact 导出     | `export_artifact`            | 同一 artifact 引用；本次目标路径；显式覆盖开关                                                             | 正常返回或稳定文件错误             |
| 书目导入          | `import_bibliography`        | `BibliographyFormat`；本次只读 binary input                                                                | `ImportReport`                     |
| 书目导出          | `export_bibliography`        | `BibliographyFormat`；全库、DiscoveryRun、LibraryQuery 或明确 MetaLiterature/Literature 范围；本次目标路径 | `ExportReport`                     |

其中 binary input、binary stream 和目标路径是 I/O boundary 对象，不是跨模块业务数据；它们不进入 JSON、Catalog、provenance 或 Report。手动 PDF 和书目导入可以由 CLI 路径、stdin 或程序内 reader 提供，但进入业务用例后只看到 reader 和已经解析的中性数据。Artifact 和书目导出在 Entry 边界接收用户目标；内部文件读取与原子输出分别通过受控 Port 完成。当前 TypeScript contracts 的具体解析和类型以 `packages/contracts` 为准。

这些操作的副作用边界固定为：

| 操作组                                     |            访问外部 Provider |                       修改文献数据库 | 创建 DiscoveryRun |                形成处理 Report |
| ------------------------------------------ | ---------------------------: | -----------------------------------: | ----------------: | -----------------------------: |
| 领域/引用发现                              |                           是 |                                   是 |                是 |          是，`DiscoveryReport` |
| 数据库补全                                 |           按缺失步骤可能访问 |                                   是 |                否 | 是，`DatabaseCompletionReport` |
| 手动 PDF 接纳                              |                           否 |                                   是 |                否 |          是，`ManualPdfReport` |
| 搜索、详情、引用页面/详情                  |                           否 |                                   否 |                否 |                             否 |
| Artifact 打开/导出                         |                           否 |             否；导出只写用户目标文件 |                否 |                             否 |
| 书目导入                                   |                           否 |                                   是 |                否 |             是，`ImportReport` |
| 书目导出                                   |                           否 |                 否；只写用户目标文件 |                否 |             是，`ExportReport` |
| 统一配置中心与 status                      |                           否 | 否；只安全修改普通配置和固定凭据文件 |                否 |                             否 |
| Provider/Analyze/Browser Model/MinerU test | 是；仅用户显式最小只读 probe |                                   否 |                否 |                             否 |

读取操作直接返回 read result；不能为了接口统一套通用 Report。写数据库的四组入口必须取得写入准入，并只提交各业务模块已经确认的事实。公开 API 不接受 Provider 名称之外的私有参数、SQL、内部路径、adapter、数据库连接、HTTP client、Parser client 或 LLM client；实现选择只在 Bootstrap。

### 9.2 新知识合同的版本与组合

以下对象是新设计，不通过给旧 ParserResult 或 LiteratureContent 放宽字段实现：

| 对象              | 必需的技术信息                                                                                         | owner 与验证                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| MaterialRef       | Literature/Asset ID、字节 SHA-256、媒体类型、大小、来源关系                                            | Acquisition 提供已接纳材料；读取按 hash 复核         |
| DocumentRef       | document/version ID、representation hash、输入材料、parser result、builder 和 locator scheme、资源闭包 | Document/Evidence 构建版本并保持精确引用             |
| EvidenceRef       | schema_version、material/document 判别、精确目标、locator、内容校验信息                                | Document/Evidence 解析；原 PDF 证据无需 ParserResult |
| InputManifest     | 按序固定的输入 ID/版本/hash、不可用项、范围 hash                                                       | Entry 冻结；执行者不得追逐 current 增补输入          |
| KnowledgeArtifact | 用途/问题、输入清单、方法/参数 hash、内容引用、证据、覆盖与 provenance                                 | Analysis 接纳派生解释                                |
| ExtractionSpec    | 调用方记录语义、schema 方言/结构、字段证据与缺失规则、规范 hash                                        | 调用方定义；Extraction 校验能力和结构                |
| CandidateBatch    | spec/input 绑定、候选 payload、证据关联、生产者方法、覆盖与失败                                        | Extraction 校验并交付；不成为 Literature 字段        |

稳定 ID 说明对象身份，hash 说明精确内容，schema_version 说明对象格式，protocol_version 说明消息协议；四者不互相替代。输入列表的顺序与缺失项参与清单比较。重新解析、locator 规则变化或影响结果的参数变化产生新的派生身份，不能仅依据 PDF hash 复用所有用途的总结。

当前新消息封套使用 `protocol_version: 1`；可持久化对象各自独立计 `schema_version`，单篇知识产物仍为 v1，集合综合基础合同采用独立 v2/v3，不从封套版本推导对象版本。schema、canonical JSON 的数字/Unicode/null/数组规则和具体 DDL 在对应模块说明；未完成 reader matrix 与显式迁移设计前，不写入新格式。Catalog 版本号与上述对象/消息版本分开。

EvidenceRef 的 material 分支至少能精确指向原始文件；只支持文件级证据时必须如实返回粒度，不伪称页码/bbox/字段支持。document 分支固定表示版本及该表示中的 locator。引用仍可解析不代表证据支持科学结论；字段语义校验与最终领域接纳归调用方。

新设计的 payload 托管、回执去重作用域/寿命及外部证据保留分别是独立合同；无历史候选服务不等于无需幂等回执或引用保护。精确交付与保留策略见 [知识加工：调用方规范与提取交付](05-knowledge-processing.md#4-调用方规范与提取交付) 与 [文档与证据：可读表示与有界读取](04-document-evidence.md#3-可读表示与有界读取)。

### 9.3 设计依据与适用范围

系统完整提供材料、文档、分析/总结、提取、查询及人类协作。PDF 有效获取是非常重要的业务能力；分析等依赖材料已经可用，不依赖获取算法、Browser 或下载运行状态。重要程度、数据前置和模块所有权分别表达。

图中的 R/D/K/Q/T/S/B 是逻辑分组，不是七个必建微服务：R 内保留来源、身份和获取的不同 owner；D 内区分解析转换与文档证据；K 内区分 Analysis 与 Extraction。T 协调产品请求，S 实现持久化，均不接管业务判断。

以下新合同是迁移实施输入，不是当前已发布 API。一个操作可以经 TypeScript API、CLI、Web 或 Agent adapter 适配，传输只改变边界转换，不改变成功标准。各模块在不改变此处语义的前提下确定代码级类型和物理 DDL。旧格式的兼容约束仍有效。

#### 9.3.1 查询与维护的独立入口

[ADR 0028](../decisions/0028-query-and-expansion-separation.md)已确认：查询只读已有库；每次元数据/PDF 扩充由用户明确开启。维护内部可以自动批量执行，不能把“手动开启”实现成逐条审批。已有材料的解析、分析和提取也须由独立加工操作明确启动，且不拥有外部补库权限。

统一应用边界提供两组能力：`query` 只获得文献/资产/文档/产物 read ports 和 Q；`maintenance` 提供发现/获取/导入与加工用例。读取实现不注入 Metadata、Acquisition、Parser、Analysis、Extraction 或 Job-create Port，缺口结果不携带自动执行的 fallback。二者可以在同一进程与数据库中实现，不要求额外服务或框架。

当前独立读取入口是公开 `createQueryApplication(home)` 与 `startQueryOnlyWorkbench({ home })`：前者供 CLI 和 Agent 直接消费现有 Library/verified artifact 读取，后者提供独立阅读页及 `/api/v1/query/*`。它们不启动完整维护 Application。支持 v1/v2 的既有库；未知 schema 不升级，索引和引用错误不降格为零命中。SQLite WAL/SHM 协调文件不属于新增业务事实。待恢复 Job、发布回执或回收票据本身不封锁已提交资料读取，也不会因查询被恢复；确实不可读的资料在对应读取中报错，维护仍须单独启动。

CLI 已初始化库上的结果格式保持；缺库查询由旧的隐式建库改为 `query-not-initialized`（退出码 3），落实 ADR 0028 的冷启动边界。下表的新文档/知识引用与通用 Gap 合同仍是后续目标，不能用本次 Library 读取宣称全部实现。

#### 9.3.2 目标公开操作合同

新 TypeScript surface 推荐为 `Application.query.*` 与 `Application.maintenance.*`；CLI、Web 和 Agent adapter 调用同一用例。新 wire 消息带 `protocol_version: 1`，分属 `sciretriever.query` 或 `sciretriever.maintenance` 合同。已有 `/api/library/*`、CLI 已初始化库的结果与维护命令、包导出保持兼容；CLI 缺库读取按上文只读启动边界报告未初始化；新 HTTP 路由若采用协议，放在 `/api/v1/query/*` 和 `/api/v1/maintenance/*` 下，不能让旧路由改义。

| 操作                           | 必需输入与成功输出                                                                                                                    | 业务 owner                                                                                         | 明确副作用与失败合同                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query.search/read`            | 库内文本/身份/版本范围、内容类型和读取预算；返回已提交命中、精确版本引用、覆盖/截断、不可用项与 `Gap[]`                               | Q 负责检索/组装；Literature、Acquisition、Document/Evidence、Analysis、Extraction 各自负责被读事实 | 不写业务事实、不建 Job、不联络外部 Provider/Parser/模型、不触发重索引或升级 schema。空库、缺 PDF/表示/知识、索引陈旧/不可用都返回可区分缺口；失败不得降格成“无文献”。查询日志和进程内缓存不得成为权威业务事实。 |
| `maintenance.discoverMetadata` | 用户给定来源条件、来源范围、扫描上限和停止边界；返回来源 observation、已接纳/未接纳身份、逐来源结果                                   | Metadata 产 observation；Literature 裁决身份、元数据与引用事实                                     | 只因该明确操作调用来源并提交已验收 observation；一个来源失败不回滚其它有效接纳；成功发现不自动获取 PDF、解析或分析。身份冲突保留 observation 并报告，不猜并合。                                                 |
| `maintenance.acquirePdf`       | 用户给定的 Literature ID/版本或冻结目标集合、材料要求及允许路线；返回通过字节与文章归属验收的 `MaterialRef`，或稳定缺失/可重试失败    | Acquisition 决定候选验收、资产关系与正常耗尽；Storage 执行发布                                     | 仅在该请求范围调用获取路线；已接纳字节 create-if-absent。临时网络/权限/配置/存储错误不记作正常耗尽。单独 PDF 操作不接着解析/分析。                                                                              |
| `maintenance.ingestPdf`        | 明确 Literature ID/版本与调用方主动提供的文件；入口将 CLI 本地路径或上传字节转换为受控 intake 引用，返回 MaterialRef 或拒绝/冲突/失败 | Entry 统一协调，Acquisition 复制、验收与接纳，Storage 发布                                         | 保留用户原文件；不以远程输入读取任意本机路径，不静默替换已有主 PDF，不自动外部发现/下载、解析或分析。旧手动接纳 CLI 改为调用同一用例，Web/Agent 适配同一合同；失败/取消清理自身未接纳 staging，不撤销有效事实。 |

当前 TypeScript 入口为 `Application.maintenance.ingestPdf({ literature_id, bytes }, signal?)`，返回既有 `CandidatePublicationReceipt`（含 ID、hash 与内部相对引用）；CLI `import pdf` 仅在本地适配边界读取用户路径，再传相同字节用例。`startMaintenanceWorkbench({home})` 使用完整维护 Application 与独立 QueryApplication，在没有 Browser 会话时提供 `/` 维护页、`/query` 阅读页和受限的 `POST /api/v1/maintenance/ingest-pdf`。上传只接受 `application/pdf` 原始字节、`X-Literature-Id`、协议版本 1 和同源会话/CSRF；不会解释远端 JSON 路径。原 `startQueryOnlyWorkbench` 不注入写入用例。手动接纳记录 `user/manual-pdf` 来源、输入 SHA-256 和空 `source_url`；同一主 PDF 已存在也拒绝重复接纳。当前单项成功以 receipt 表达，失败以稳定错误码表达；多项目报告形状仍按相应维护用例单独定义。
| `maintenance.ingestBibliography` | 明确选择的本地文件/记录及受支持格式；返回匹配/新增/拒绝/冲突计数和 Literature ID | Literature | 仅提交通过验证的用户来源 observation；部分有效记录可提交，失败项在报告定位；不复制文件到不必要位置、不丢来源、不静默改写已有身份。 |
| `maintenance.parseDocuments` | 已接纳 MaterialRef（ID + SHA-256）、解析规格和资源预算；返回精确 PDF 绑定与逐 profile RawParse 回执，或能力缺口/失败 | Parsing 接纳原始解析；Document/Evidence 另行发布校订稿 | 只处理给定材料，不下载、不调用 Analysis；失败保留原资产和已发布旧表示；新资源与 Markdown 字节不可覆盖。 |

当前解析请求为 `{ literature_id, asset_id, asset_sha256, profiles?, force? }`，默认两种 profile、允许复用。共享边界冻结输入并验证已接纳 PDF；回执只含固定资产和逐 profile 原始解析结果/失败。旧 mode、默认文档 CAS 与 Document 回执已删除。解析不下载、不建档、不总结，也不修改阅读默认版本；仅显式 `complete parser` 可先获取 PDF，再运行同一 raw 服务。v11 及后续 catalog 是 raw 存储前提，入口不隐式迁移旧库。HTTP 保持现有认证、CSRF、协议版本与断连取消边界，见[解析运行接口](04-document-evidence.md#211-typescript-运行接口与独立文档协作)。

| `maintenance.analyze/synthesize` | 明确用途/问题、精确 InputManifest、规格及是否允许部分集合；返回 `KnowledgeArtifact`、实际覆盖/证据，或不适用/缺口/失败 | Analysis | 只能读指定已有输入并发布新不可变结果；缺输入返回 `Gap[]`，不调 Metadata/Acquisition/旧 completion；模型失败、不适用、零覆盖不得删除 PDF 或 ParserResult。跨文综合未获明确部分处理许可时，缺项使结果失败或标记为不完整，不能伪称覆盖全集。 |
| `maintenance.submitExtractionBatch` | 调用方 `ExtractionSpec`、精确 InputManifest、一次有界 CandidateBatch；返回批次接纳/拒绝回执和逐记录结构/证据问题 | 调用方拥有规范/记录语义/策略与科学接纳；Extraction 校验中性交付；下游拥有最终数据集 | 不调用内部 Analysis/LLM，不调用外部发现/获取，不写 Literature 固定字段。单个批次全收或全拒；多批次任务失败不撤销先前接纳批次。结构/证据合格不代表科学接纳。 |

处理已有材料的批量维护先解析选择器，再以稳定 ID/hash 和请求顺序冻结实际输入集合；来源发现冻结来源、查询条件、预算和停止边界，未知新文献按实际发现/接纳顺序记录，不预先伪造输入 ID/hash；执行报告同时列目标、已提交事实、失败/未处理项与覆盖。取消停止新工作并如实结算在途提交，不撤销已提交事实。查询 `Gap[]` 中可以列出由人选择的下一步，但该建议不构成命令或 fallback。

现有 `LiteratureSelector.kind = "query"` 是“用户已明确创建维护 Job 后，用来选目标”的选择器，不是 query API，也不授予自动维护权。新 `query.*` 只读消息与维护请求中的范围选择器必须用不同的顶层合同名；实现须保留已有 Job/selector 能力并验证二者不串线。

### 9.4 交换对象及其含义

#### 9.4.1 引用、输入与产物

| 对象建议            | 必须表达的语义                                                              | owner / 重要限制                                                                       |
| ------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `MaterialRef`       | 具体 Literature、资产 ID/hash、媒体类型与受控读取引用                       | Acquisition 接纳资产，Literature 拥有文献身份；不是绝对文件路径或下载 URL              |
| `DocumentRef`       | 表示 ID/版本/hash、源 MaterialRef、中性格式版本和转换来源                   | Document/Evidence；同一 PDF 可有不同表示，不能只用论文 ID 当作表示版本                 |
| `DocumentSlice`     | 具体 DocumentRef、实际片段/资源、定位、覆盖、截断和后续读取位置             | Document/Evidence；表头/单位/脚注等关联上下文按能力返回，不能伪造结构                  |
| `EvidenceRef`       | 表示版本、定位种类、稳定位置及必要内容校验值                                | Document/Evidence；原始资源证据可直接绑定资产与资源位置，页码/bbox 仅在可靠映射时提供  |
| `InputManifest`     | 本次明确选择的材料/表示版本、有序条目、不可用项及范围规则                   | 应用层组织，条目由各事实 owner 验证；用于复现输入，不建立新的文献身份或自动 Collection |
| `KnowledgeArtifact` | 用途/问题/粒度、输入清单、内容及证据、实际覆盖、生成方法与版本              | Analysis；单篇和集合产物分别表达，默认视图不等于唯一产物                               |
| `ExtractionSpec`    | 规范版本/hash、记录含义、输出 schema、字段说明、纳入/缺失规则、所需材料能力 | 调用方定义；Extraction 校验可支持的合同，不替调用方解释领域规则                        |
| `CandidateBatch`    | 规范与输入、提交身份、记录 payload、字段/关系证据、覆盖和生产者声明         | Extraction 接纳交换；交付记录 ID 不等于样品/实验等领域实体 ID                          |
| `ControlBinding`    | 目标文章、会话、控制版本、必要页面/观察版本                                 | 应用/Browser 控制 owner；不以 UI 按钮状态作为控制权依据                                |

例如同一论文同时有概览和针对问题 A 的分析，两者都是独立知识产物，绑定各自输入与生成规格。调用方规范可以规定“一条记录是一项测量”，也可以规定“一条记录包含一组实验”；平台不会假定一文一条、固定实验实体或统一领域表。

#### 9.4.2 五类版本不能混用

1. **协议版本**决定 API/wire 字段如何解释，reader 必须明确支持范围。
2. **对象 schema 版本**决定持久化 JSON/record shape；它不同于 npm package version 和 Catalog version。
3. **规范/方法版本**决定按什么规则加工；提取规范、分析模板和影响结果的参数分别绑定。
4. **材料/表示/产物版本**决定具体输入/内容，已发布字节不可原地覆盖。
5. **控制版本**用于拒绝过期 Browser 动作，不能用作材料版本或科学证据。

hash 表示内容或规范一致性，不证明来源可信、语义正确或调用恰好执行一次。时间戳、任务 ID 和来源名称不能代替输入绑定。

#### 9.4.3 引用字段与版本设计

新增 JSON/API envelope 使用 `protocol_version: 1`；新增可持久化产品 envelope（DocumentRef、EvidenceRef、InputManifest、KnowledgeArtifact、ExtractionSpec、CandidateBatch）各自使用 `schema_version: 1`。协议/对象名限定 version namespace；不得新增一个全局任意 `version` 字段。既有 `ParserResult`、`LiteratureContent`、`ArtifactRef` shape 不加字段，旧 parser 继续严格校验旧字段集。

| 对象                | 首版必需的版本与引用字段                                                                                                                                                                                                            | 版本如何变化 / 直接 owner                                                                                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MaterialRef`       | `literature_id`、`asset_id`、`asset_sha256`、`media_type`、`byte_size`、受控 `artifact_ref`                                                                                                                                         | Asset SHA-256 固定字节；Asset ID 固定 catalog 身份。Acquisition 发布，Literature 保有文献版本身份。                                                                                                                                                                      |
| `DocumentRef`       | `document_id`、`document_version_id`、`schema_version`、`representation_sha256`、`source_material_ref`、`parser_result_sha256`、`builder_version`、`locator_scheme`、Markdown/资源 ArtifactRef 集合                                 | 表示 hash 覆盖输入 hash、parser result、builder/locator scheme、规范化结构与资源闭包；Parsing 提供输入，Document/Evidence 决定版本与可读性。重新解析/重建定位产生新版本。                                                                                                |
| `EvidenceRef`       | `schema_version`、目标判别 `target_kind`、`locator_scheme`、locator 与必要内容校验；`material` 目标固定 MaterialRef/资产 SHA-256及可用资源 hash；`document` 目标固定 document_version_id/representation_sha256及定位文本或资源 hash | 两类目标互斥解析，原始 PDF/资源证据无需 ParserResult 或 DocumentVersion。Document/Evidence 校验支持的定位，Acquisition 提供受控原始材料读取；locator scheme 版本化，永不重绑定 current。未可靠支持的页码/bbox/文本定位明确报告能力缺口；仅文件级引用不能伪称字段级支持。 |
| `InputManifest`     | `manifest_id`、`schema_version`、按序 `entries[]`（精确 Literature/Material/Document/Knowledge ID + 版本/hash）、显式不可用项、范围摘要 hash                                                                                        | 一次调用冻结的输入快照，由 Entry 组织；不等于 Collection、业务事实或可自动重跑任务。成员/顺序/版本变化生成新 hash。                                                                                                                                                      |
| `KnowledgeArtifact` | `artifact_id`、`schema_version`、`purpose`、可空 `question`、`input_manifest_ref/hash`、`method_id/version/hash`、内容 ArtifactRef/hash、EvidenceRef[]、实际覆盖/缺口、Analysis provenance                                          | Analysis 接纳；相同输入但用途/问题/方法或影响结果的参数不同即为不同产物。新产物不可覆盖旧字节，current/default 只是可并发检验的投影关系。                                                                                                                                |
| `ExtractionSpec`    | 调用方的 `spec_id/version/hash`、`schema_version`、记录语义、JSON Schema Draft 2020-12、字段/关系证据要求、缺失含义与所需材料能力                                                                                                   | 调用方是 schema/领域解释 owner；平台对规范内容计算 hash 并验证可支持能力。schema 用规范化 JSON 固定；禁止远程 `$ref`，避免校验过程中隐式网络访问。                                                                                                                       |
| `CandidateBatch`    | `batch_id`、调用方 submission/idempotency key、固定 operation 绑定的精确 spec/manifest hash、记录 payload、字段/关系 EvidenceRef、覆盖/失败、外部生产者方法声明                                                                     | Extraction 拥有通用结构/引用校验与原子批次回执；v5 当前按 operation/key/完整内容 hash 在有效回执期内跨重启重试，异内容冲突。operation 新提交窗 24 小时，回执与材料/文档保护 30 天；每批全收或全拒，多批次间不回滚。不托管历史 payload，也不承诺永久幂等。                |

稳定对象 ID 与内容 hash 分开。hash 相同不自动合并来源、输入或业务身份。Reader 只接受其明确声明支持的 `schema_version`；未知版本、缺依赖、hash/fingerprint 不符均 fail closed。可读旧版本必须经显式、纯读取 adapter 转为内存视图，不能在 query、load 或 `dry-run` 时回写/升级。增加、删除或改变序列化字段/含义时递增对应对象版本，并为仍受支持的旧版保留 reader 或给出 可验证的显式迁移。

`@sciretriever/contracts` npm SemVer 只控制 TypeScript 包消费者；它不替代上述存储/协议版本。新 HTTP/Agent adapter 首版映射相同 request/result shape；已有 `/api/library/*` 继续旧 DTO，不能冒充新协议 reader。

#### 9.4.4 生产者、消费者与旧合同兼容矩阵

| 产物/合同                                                                                                   | 当前生产者 → 当前消费者                                                                                                                                                                        | 迁移后的生产者 → 新消费者                                                           | 兼容决定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MetaLiterature` / `Literature`、metadata revisions、provider/user observations、Reference/ReferenceSupport | Metadata + Literature → Library search/detail、discovery/completion selector、bibliography import/export、CLI/Web                                                                              | 原 owner 不变；Q、Agent 与人类阅读新能力                                            | ID、来源 observation、权威引用关系和保守身份继续原格式；不将领域候选写入 Literature。                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 已接纳 PDF/Asset/ArtifactRef                                                                                | Public/API/Browser/manual Acquisition → Parsing、completion、PDF 导出和 Library detail                                                                                                         | 同一 owner → Document/Evidence、Q、Analysis、Extraction                             | ID/hash/不可变字节/相对路径保持；下游必须 pin `asset_sha256`，错误或后续失败不覆盖/删除有效资产。                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ParserResult`（当前 parser-neutral Markdown 与资源）                                                       | Parsing/MinerU adapter → 旧 ContentAnalysis 与资产/解析读取                                                                                                                                    | Parsing → 新 Document/Evidence builder；旧 reader 继续受支持                        | 既有精确字段/哈希含义不变。新定位和表示版本包裹在独立 `DocumentRef`，不扩展旧 ParserResult 或将 `result_sha256` 直接当作 locator version。                                                                                                                                                                                                                                                                                                                                                            |
| `LiteratureContent` 与当前 LiteratureStatus 投影                                                            | 旧 Analysis/ContentAnalysis → Literature detail、CLI content export、Web Library、completion/reuse                                                                                             | 旧消费者照读；新 Analysis/Q/Human 可并列读 KnowledgeArtifact                        | 旧格式、单一 current 视图与字段含义保持。不得把旧内容静默改解释为任意用途/问题结果；迁移投影须显式标 `legacy-final-content` 且不补造字段级 EvidenceRef。LiteratureStatus 留作兼容摘要，不作新模块的唯一 readiness。                                                                                                                                                                                                                                                                                   |
| 操作报告（Discovery、Bibliography import/export、DatabaseCompletion、Jobs）                                 | 各 Entry/Jobs → CLI JSON/终端、WorkBench HTTP/Web Jobs                                                                                                                                         | operation-specific report v1 → CLI/Web/Agent adapter                                | 旧字段/退出码/goal 语义保留；尤其 `complete content` 的 `CONTENT_READY` 可含 PDF 获取+Parsing+旧 Analysis。新 Query/Analysis/Extraction 不返回该旧 report、不将其用于缺口 fallback。                                                                                                                                                                                                                                                                                                                  |
| 配置文件与能力选择                                                                                          | Configuration owner → CLI/Web/Bootstrap/业务 Entry                                                                                                                                             | 同一 owner 提供新用例所需配置投影                                                   | 固定 home、普通/secret 分离及既有字段语义不改；首批 query/Document/Extraction 无新增配置字段。旧 `[discovery]` 仍按 ADR 0022 拒绝，不建立 Profile/配置迁移。                                                                                                                                                                                                                                                                                                                                          |
| 书目交换格式                                                                                                | Literature bibliography owner → CLI/Web 及外部书目工具                                                                                                                                         | 同一 reader/writer                                                                  | 已支持格式和字段保留，不等待 PDF/KnowledgeArtifact；新 Knowledge/Candidate 不是书目字段。                                                                                                                                                                                                                                                                                                                                                                                                             |
| Catalog v1–v8 与 execution/runtime sub-schema                                                               | Storage → 当前 Library/Entry/Jobs；v1/v2 compatibility/migration gate                                                                                                                          | Catalog v3 的 Document/Evidence 基础；后续 owner-specific schema 单独演进           | v2 在 v1 业务表基础上加 execution/runtime；v3 在完整 v2 上仅加文档版本/资源/default/迁移记录，execution/runtime 子 schema 仍独立。v1/v2 原始事实不变。当前 TS 通用 reader 支持 v1–v8；v1/v2 可复核仍存的原始 PDF 文件级证据，Document writer 与固定版本阅读需 v3+，材料 Context 需 v4+，候选回执 writer 需显式 v5，单篇知识发布/读取需显式 v6，集合综合需显式 v7，知识检索投影需显式 v8。DDL、fingerprint、输入/读取矩阵与合成恢复见[版本化存储](07-versioned-storage.md#41-当前-schema-与显式转换)。 |
| `LiteratureSelector.kind = "query"`                                                                         | 明确 `jobs create` / `complete` 入口 → Jobs/DatabaseCompletion 选择已请求目标                                                                                                                  | 可保留作维护 selector；新 Q 使用独立 QueryRequest                                   | 已按用户显式点选/调用维护命令时才是范围过滤器；不能将它解释成 query 命中后的自动排队许可。                                                                                                                                                                                                                                                                                                                                                                                                            |
| 新 Document/Evidence、InputManifest、KnowledgeArtifact、ExtractionSpec/CandidateBatch                       | Document/Evidence 的固定版本 reader、InputManifest 准备、ExtractionSpec/候选交付已接通；KnowledgeArtifact 的单篇三用途及长文 v2 请求生产者、v6 reader 与 v7 集合综合执行、发布及 reader 已接通 | Parsing/Document, Entry/Analysis, 调用方/Extraction → 新 Q、Agent、人类、下游调用方 | 新增类型通过 contracts v1；旧 DTO/reader 不隐式消费。v5 只持久化规范、operation、回执及整个 manifest 的有限期依赖 pin；当前成功响应即时交付 accepted_batch，历史 payload 不入库。v6 单篇知识持久化独立内容、精确材料/文档依赖和默认 CAS，保留旧 LiteratureContent reader。共享 Operation/Receipt/AcceptedResult/Issue parser 拒绝未知字段并校验请求绑定；详见[提取交付首版合同](05-knowledge-processing.md#412-首版规范输入绑定与提交语义)。                                                          |

完整 Agent knowledge API 尚未实现；当前公开 TypeScript/HTTP 已提供 Library 与 Document/Evidence 有界读取，M07-T01/T02 的元数据与已发布 DocumentVersion 检索、预算 Context 已接通；M06 单篇与集合知识产物已接通。M07-T03 的 v2 知识 Context 使用独立的 Catalog v8 显式知识索引，通过 `createQueryApplication(home).knowledgeContext.search`、`POST /api/v1/query/knowledge-context` 和查询 Web 页按共同排序、预算与游标混合读取材料和生成知识。知识索引由 `Application.maintenance.rebuildKnowledgeIndex`、`maintenance rebuild-knowledge-index` 或受同源会话/CSRF 保护的 `POST /api/v1/maintenance/rebuild-knowledge-index` 独立重建；材料 `rebuild-index` 及 v1 Context 不变。旧 Analysis 输出与 LiteratureContent 仍由既有 reader 证明兼容，新生产者与消费者分别见各模块技术设计。查询 HTTP 的 `/api/v1/query/document-default|document-describe|document-outline|document-segments|document-resources|document-slice|document-resource|material-evidence|evidence-resolve` 使用统一 `protocol_version:1` 封套，成功字段为 `result`；请求和响应由共享合同解析并绑定固定版本/材料。人类阅读页提供全局片段（包括无标题正文和首标题前引言）、目录与资源翻页，显示实际范围、证据和能力缺口；晚到的旧片段响应不会覆盖新选择。各预算/缺口见[④文档与证据](04-document-evidence.md#3-可读表示与有界读取)。
