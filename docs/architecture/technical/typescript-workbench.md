# TypeScript 与 Browser 工作台技术边界

- 长期决策：[ADR 0024](../decisions/0024-typescript-browser-workbench-migration.md)
- 产品与整体对象图：[产品需求](../requirements.md)、[设计文档](../design.md)
- 相关技术合同：[Model](model.md)、[Configuration](configuration.md)、[Network](network.md)、[Agents](agents.md)、[Acquisition](acquisition.md)、[Storage](storage.md)
- 计划入口：[TypeScript Browser 工作台迁移计划](../../plans/2026-09-07-typescript-browser-workbench/README.md)

本文只定义 TypeScript 迁移对既有模块责任的技术映射。产品能力、当前发布行为和长期选择仍分别由需求、
README/源码/测试及 Accepted ADR 负责。

## 1. Workspace 与公共边界

```text
packages/contracts/       # provider-neutral Model、canonical bytes/hash、cursor、稳定 failure
apps/server/              # Configuration、Network、Storage、Agents、Browser、Acquisition、业务与 Entry
apps/web/                 # 人工观看、控制权和状态呈现；不持有 Page/Context/CDP
```

`packages/contracts` 不读取 home、数据库、凭据或外部服务。`apps/server` 通过一个 Application composition
构造共享 Configuration、Network coordinator、FileStore、DB Worker、Agents 和各 repository。`apps/web`
只消费认证后的 Observation、Frame、Action、Transfer 和报告；Browser vendor 对象只存在于 server 的
Browser Host。

包的公开入口只导出文档化的中性 Application/contract API。Provider SDK、SQLite binding、Playwright/
CloakBrowser 类型、secret、绝对路径和内部数据库表不穿过公开入口。

## 2. 数据与生命周期

文件系统保存 PDF、ParserResult 和其它大字节；SQLite/catalog 只保存规范相对引用、hash、relation、
provenance 和已确认的业务事实。FileStore 使用 bounded reader、no-follow、descriptor identity、fsync、
create-if-absent 和冲突证据。DB Worker 单独持有连接，只接受 typed command；repository 不在查询或写入
时形成身份、主资产或业务状态决定。

Candidate 的生命周期为：

```text
captured -> staged -> validated -> durable-ready -> accepted | rejected | failed
```

`durable-ready` 表示字节已经独立于页面和工作台保存；它不表示 PDF 已通过文章归属或已成为 Literature
主资产。Acquisition 完成字节门、文章/版本门和 receipt 后，才调用 Storage 发布已确认事实。文件发布
与数据库提交之间的进程退出必须可通过 hash、receipt 和现有事实对账；实现不能声称文件系统与 SQLite
具有一个跨系统原子事务。

v1 文献事实与 v2 job/attempt/event/candidate/receipt 运行事实使用显式 schema 边界。v2 只在合成副本
中升级、备份、恢复和回滚；生产数据迁移及双写要经过独立授权和最终切换审查。

## 3. 外部访问与 Browser

所有 HTTP、Provider、MinerU、Agent SDK 和 Browser 的外部访问都由同一个进程内 Network coordinator
执行。每次 DNS、连接、navigation、redirect、popup、response 和 download 都重新做 URL、地址类别、
host、origin、预算和取消检查；TLS 保留原 hostname/SNI。跨 origin 不转发凭据，错误与日志不回显 URL、
query、header、secret、响应正文或底层异常。

Browser Host 使用一个 operator-managed CloakBrowser process/persistent context 和固定 Profile；
同一 Profile 的并发由 lease 防止。`browser:generic` controller 只从稳定、绑定当前文章的 Observation
选择六种封闭动作，迟到 epoch 动作在 vendor dispatch 前拒绝。Browser capture 交给 Acquisition 的
统一 PDF/文章归属门，不能由下载按钮、扩展名、HTTP Content-Type 或 Agent 文本代替。

## 4. 配置、Agents 与业务协作

Configuration 只保存 Provider/Model/任务直接选择和固定 home 文件；Provider 持有 API/Base URL/exact-origin
credential scope，Model 持有 reasoning/image/stream，模块 capability/limits 由消费方派生。Model/Core secret 通过
绑定 bundle、用途和精确 HTTPS origin 的 opaque grant 进入 adapter；文献 Provider secret 通过独立用途 grant
进入对应 adapter。secret 不进入 Model、DTO、Report、日志或数据库。

模型 transport 按配置端点限定地址类、端口与精确 URL，使用共享 NetworkBudget。HTTP loopback 只允许
127.0.0.1/::1 或解析到这两个地址的 localhost，且不得携带或保有该 provider 的凭据；HTTPS 继续使用
public admission 与 exact-origin grant。关闭 AgentRuntime 取消进行中的网络请求。实际三种协议及
Analysis 组合验证见[模型 loopback 证据](../../../migration/evidence/runtime/model-loopback.md)。

Agents 是无状态单次调用边界。三种协议的 JSON/SSE 在内部重建为一个完整中性结果，stream 失败不改模式
重发，模型不获得 Browser 或事实写入权限。Metadata/Acquisition adapter 只转换供应商协议并发布
observation；Literature、Analysis 和 Entry 分别拥有 identity/current facts、内容分析和用户协议。

## 5. 迁移与验证顺序

先用固定 synthetic v1 fixture 验证 contracts、canonical bytes/hash、配置和基础运行时，再实现 Network、
FileStore、DB Worker、Agents、Browser、Acquisition 与业务。每个切片的直接测试按行为命名，并至少覆盖
一个拒绝、失败、取消、恢复或回滚路径。按 2026-09-10 项目 owner 决定，以 TS `pnpm quick/test/full`
作为后续验证入口，不再默认执行 Python Full；实际 Chromium、原生 SQLite binding、真实 Provider、用户数据库和生产切换分别保持授权边界。

任何 v1 bytes/hash/schema、owner、secret、SSRF、不可变发布、Candidate 对账或恢复差异都阻断下游并回到
对应 owner；不在后续模块增加长期兼容旁路。


## Candidate/receipt 执行扩展（2026-09-10）

v1 schema manifest 保持冻结。`SqliteWorker.upgradeExecutionSchema()` 显式添加同 catalog 下的 execution version 1：

| 表 | 内容 / owner |
| --- | --- |
| `execution_schema_identity` | version、manifest fingerprint；Storage 校验版本 |
| `execution_candidates` | transfer ID 和严格 Candidate JSON，含相对引用、长度、hash；Acquisition 确认，Storage 保存 |
| `execution_receipts` | receipt ID、Candidate 外键、完整确认输入 JSON、可空的结果 JSON；Acquisition 决定发布，Storage 原子写事实与结果 |

大字节存于 FileStore `.candidates/<sha256>.bin`，先不可变封存，再保存 Candidate 记录。正式发布先写 receipt 输入，
再 create-if-absent 发布 `objects/` 文件，最后同一事务写入 v1 provenance/asset/relation 与 receipt 结果。
重复 receipt 必须全部输入一致；任何已存在事实 ID 的字段冲突都拒绝。`reconcile()` 重试已确认输入，
不恢复未完成 Agent 或 Browser 任务。备份使用 `VACUUM INTO`；回滚先备份执行证据，再只移除扩展，保留已确认 v1 事实及字节。

Application 仅在 `executionSchema: "upgrade-synthetic"` 显式选项下组装此路径。默认不迁移 v1，当前仅用于合成/副本验证。
[恢复证据](../../../migration/evidence/runtime/candidate-recovery.md) 记录新进程、两种中断窗口、冲突和回滚演练。

`Application.execution.acceptance` 是已有 Literature 的 Candidate 接纳入口；外部命令只携带 ID 和 metadata
CAS 基线。Acquisition 重读 durable 字节并形成身份/版本证据，Literature 按同 snapshot 的 current facts 准入，
再通过既有 publisher 发布。相同字节复用现有 Asset 和主关系，新 provenance/capture/receipt 保留；异 hash
主资产拒绝覆盖。该切片与限制见 [接纳证据](../../../migration/evidence/browser-acquisition/candidate-acceptance.md)。

`Application.library.search()` 使用闭合 LibrarySearchRequest 和同一只读 snapshot 形成 LiteratureSearchItem。
状态与 missing step 复用 Literature 的纯推导函数；CONTENT_READY 绑定生成时谱系，重新解析不撤销已接纳内容。
五种排序的 cursor 保持 Python query 的 canonical JSON 语义。`library.references()` 提供正反向分页，
`library.referenceDetail()` 返回同一 snapshot 中两端与有效 support locator；查询不生成第二套关系事实。
Discovery 条件校验结果/cause 的具体 Literature 归属，不能用 MetaLiterature 的所有版本扩大命中。
`library.detail()` 在同一 catalog snapshot 中组装完整 LiteratureDetail，并按不可变引用验证 structured
content 的 canonical JSON、hash 与生成谱系；ParserResult 也重算规范 manifest hash。证据见
[文献详情](../../../migration/evidence/runtime/literature-detail.md)。`Application.literatureArtifacts.withArtifact()`
提供有作用域、大小预算和取消的只读字节流；Entry `exportArtifact()` 使用同一 verified reader 原子导出，默认
拒绝已存在目标。具体边界见[artifact 读取与导出](../../../migration/evidence/runtime/literature-artifact.md)。
当前搜索匹配范围会物化到内存，完整内容容量验收仍待实现；搜索证据见[状态与搜索](../../../migration/evidence/runtime/literature-query.md)。

### TypeScript 配置与凭据 owner

`TypeScriptConfigurationOwner` 直接读取和发布受支持 TOML projection，`Credential` 由同一 owner 通过独立文件、原子替换和 exact-origin grant 管理。普通配置、secret、readiness 和 probe 都在 Application 启动时从同一快照派生；revision/CAS 冲突在发布前拒绝，凭据只在明确的 provider/origin/operation 范围内短时可读。

`status` 输出闭合的 `ConfigurationReadiness`，只暴露本地状态、下一步和凭据 presence；TUI/非 JSON CLI 与 Web 使用相同投影。status 不联网，显式 test 才能访问 loopback 或获准外部端点。Python 配置 owner 仅作为历史 oracle 保留，不在 TS 生产入口、安装包或 Application 生命周期中启动。

## Parsing 准备与发布

迁移 Application 的显式 `parsing: {parser, rules}` 组装 `ParsingService`；未组装时为 null。
服务从正式 current primary PDF 的 verified artifact Port 开始，校验物理页数，复制 staged 输出后验证
共享 ParserResult manifest 和资源闭合。`TypeScriptParserArtifactRules` 在进程内完成 Markdown、资源引用、Unicode 和媒体类型校验，不启动 Python。

`prepareCurrentPrimary / commitCurrentPrimary / discardPrepared` 使用私有一次性准备凭据。发布先完成不可变
文件，再在同一 SQLite 事务检查当前 primary ID/hash 并写入 v1 ParserResult/provenance/resources。
相同 manifest 保留首次 provenance；失败保留原 PDF、ParserResult 和 Content。Application close 取消准备，
已开始的提交仍由存储完成或报告失败。配置可组装 TypeScript loopback/remote MinerU adapter，所有 HTTP 请求经过共享 NetworkBudget；remote 上传要求 exact-origin credential grant，详见[Parsing 证据](../../../migration/evidence/runtime/parsing-publication.md)和[MinerU 执行证据](../../../migration/evidence/runtime/mineru-execution.md)。

## Literature 内容接纳

Application 的 `writes` 为 FileStore 与 SQLite 共同提供 catalog 写入准入。Candidate、Parser 和内容发布
持有完整文件/SQL 发布区间；同进程排队、活动上下文嵌套复用，跨进程使用与 Python 相同的 OS flock
协议。关闭等待已准入的发布结束。自定义跨文件/SQL 操作应通过 `app.writes.run(...)`，详见
[写入准入证据](../../../migration/evidence/runtime/catalog-write-admission.md)。[显式描述符文件回收](../../../migration/evidence/runtime/artifact-reclamation.md)已接入同一边界。

`app.literatureContent.accept(proposal, markdownBytes, signal?)` 消费闭合中性 Proposal，验证 final metadata、
内容 hash、Analysis lineage 与实际 Markdown 字节，读取当前事实后分配下一 metadata revision。
Storage 先发布不可变 JSON/Markdown，再在同一 SQLite 事务检查 primary/ParserResult/metadata 基线，
一起替换 metadata、content、关键词、引用支持及 FTS。失败保留旧 current view；普通失败不触发
NoUsableContent 业务清理。详见
[内容接纳证据](../../../migration/evidence/runtime/content-acceptance.md)。

## Analysis 两阶段执行

显式 `analysisRuntime` 从配置组装 `app.analysis`；要求 analysis 模型和七项预算完整。
`analyzeContent(literatureId, signal?)` 读取正式 Parser Markdown，调用 TypeScript AnalysisService，复用 metadata 保护、正文对齐与 canonical Markdown renderer。AgentRuntime 直接执行中性模型 adapter 和不可变 Markdown 发布，不启动子进程。
`app.contentAnalysis.analyzeCurrent(id, signal?)` 已连接 Analysis Proposal 与 Literature owner 接纳，成功返回
正式内容；明确无可用内容进入下述协调清理，返回独立结果与闭合 `AnalysisInputIdentity`，普通失败保留原事实。关闭入口取消并
等待当前调用。明确 NoUsableContent 清理已接入下述 Entry，完整后续候选旅程仍待组装，见
[Entry 接纳证据](../../../migration/evidence/runtime/content-analysis-entry.md)。

`app.literatureCleanup.cleanup(noUsableResult, signal?)` 已提供基于完整当前事实 token 的 catalog 清理。
Literature 验证输入、内容与 FTS 并决定引用支持清理，Storage 在同一事务再次核对闭合后移除对应关系和
无引用对象登记。结果 `catalog_cleaned` 不等于物理文件已回收；调用方可将返回描述符交给 `app.artifactReclaimer.reclaim`，
它在共同准入内重新检查正式/execution 引用并隔离验证后删除。
`app.noUsableContent.cleanup` 将 Acquisition 的准确 Candidate/receipt 清理决定与 Literature 决定交给同一
Storage 事务，再忘记 Browser 缓存并回收文件。Application 的 `contentAnalysis` 自动消费明确无内容决定；
成功返回 `no_usable_content_cleaned`，回收失败报告已提交与待重试描述符。SQL 提交前先持久化仅含技术
描述符的回收清单，Application 启动时通过 `artifactRecovery.recover()` 重新核对引用并恢复，完成后删除清单；
见[重启恢复](../../../migration/evidence/runtime/artifact-recovery.md)。其它历史孤立文件扫描与后续候选重试仍待接入，
详见 [NoUsableContent Entry](../../../migration/evidence/runtime/no-usable-content-entry.md) 及 [NoUsableContent 清理证据](../../../migration/evidence/runtime/no-usable-content-cleanup.md)。

三种模型 adapter 使用各自的 JSON-schema、工具、图片和鉴权字段；Chat 接受 nullable usage 分片，
Responses 以完成事件为准并允许可选 DONE 标记。Analysis 参数 hash 标识版本化的 TS 调用参数 manifest，
不宣称与 Python vendor wire 参数 hash 相同。验证与限制见
[Analysis 执行证据](../../../migration/evidence/runtime/analysis-execution.md)。


`app.completion.complete({ literature_id, transfer_ids }, signal?)` 已提供有界候选补全 Entry，要求明确组装
execution、Parsing 和 Analysis。它优先处理当前主 PDF/内容，缺少步骤才调用下游；NoUsableContent 清理
后用本次临时 hash 集合跳过重复输入并继续下一候选。提供列表用完只返回 `supplied_candidates_exhausted`，
不形成全自动路径耗尽或跨版本回退。普通运行失败保留已提交输入并终止。同一 Literature 并行调用拒绝，
关闭取消并等待；详见[候选补全旅程](../../../migration/evidence/runtime/literature-completion.md)。

Workbench HTTP 可注入 `library: { queries, artifacts }`，经已有 Cookie/client/CSRF 校验后提供 search、detail、
references 与 current PDF/Markdown attachment 下载。下载只接受 Literature ID 与已定义 kind，不接受路径；
复用 verified reader 并在最终复核后结束 chunked 响应。实时前端文献库已消费该接口，支持分页、详情选择和下载，
尚不改变 Browser 会话目标。详见[Web 文献库证据](../../../migration/evidence/runtime/workbench-library.md)。
