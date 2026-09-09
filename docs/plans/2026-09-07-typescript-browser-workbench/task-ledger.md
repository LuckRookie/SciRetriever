# 任务索引

任务的动作、依赖、checkbox、状态和验收只定义在对应编号块的 `Tasks` 中。本文件仅提供稳定 ID 到任务的导航，
不维护第二份状态、测试数或完成计数。增加、移动、拆分或删除 Task 时必须同步本索引。

## Block 01：基线、风险与公共合同

| 稳定 ID | 具体结果与执行入口 |
| --- | --- |
| [BASE-01](01-baseline-and-contracts.md#base-01) | 固定 baseline revision、工作树、Python 版本和既有门禁结果。 |
| [INVENTORY-MODULES](01-baseline-and-contracts.md#inventory-modules) | 为 235 个 Python 源模块逐一记录 target、owner、公开符号和 disposition。 |
| [INVENTORY-ENTRY](01-baseline-and-contracts.md#inventory-entry) | 逐一记录 8 个公开 `api.py` 入口及导出符号。 |
| [INVENTORY-METADATA](01-baseline-and-contracts.md#inventory-metadata) | 逐一记录 11 个 Metadata adapter 及其请求、响应和失败边界。 |
| [INVENTORY-ACQUISITION](01-baseline-and-contracts.md#inventory-acquisition) | 逐一记录 7 个来源和 3 个授权获取 adapter。 |
| [INVENTORY-CLI](01-baseline-and-contracts.md#inventory-cli) | 逐一记录 23 个 CLI command path、参数和用户可观察错误。 |
| [INVENTORY-CONFIG](01-baseline-and-contracts.md#inventory-config) | 逐一记录 11 个 configuration section、alias、敏感字段和读写 owner。 |
| [INVENTORY-TESTS](01-baseline-and-contracts.md#inventory-tests) | 为 161 个现有 Python 测试文件记录行为 area、被保护能力和迁移测试落点。 |
| [INVENTORY-TRACEABILITY](01-baseline-and-contracts.md#inventory-traceability) | 关闭活动能力、调用方、Task、直接测试和证据的逐项迁移追踪。 |
| [RUNTIME-SPIKE](01-baseline-and-contracts.md#runtime-spike) | 记录本机运行时能力与未验证限制。 |
| [BROWSER-RUNTIME-SPIKE](01-baseline-and-contracts.md#browser-runtime-spike) | 验证并固定 Browser wrapper、Playwright、Chromium、Profile、下载和投屏组合。 |
| [PLATFORM-SAFETY-SPIKE](01-baseline-and-contracts.md#platform-safety-spike) | 验证文件持久原语、跨进程锁和 Browser 原生出口安全可实现性。 |
| [PDF-ENGINE-SPIKE](01-baseline-and-contracts.md#pdf-engine-spike) | 选择可受限执行的 PDF 结构检查和文章身份文本提取组合。 |
| [THREAT-MODEL](01-baseline-and-contracts.md#threat-model) | 固定单操作者、控制面、凭据、外部页面、PDF 和持久服务威胁模型。 |
| [PLATFORM-RELEASE-MATRIX](01-baseline-and-contracts.md#platform-release-matrix) | 定义可测试平台、运行依赖、性能观察项和支持声明规则。 |
| [RUNTIME-SELECTION](01-baseline-and-contracts.md#runtime-selection) | 形成 Browser、SQLite、PDF、文件安全和发行组合的正式运行时选择记录。 |
| [FIXTURE-V1](01-baseline-and-contracts.md#fixture-v1) | 生成固定的 synthetic metadata、literature、relation、asset、query、canonical bytes 和 hash fixture。 |
| [MIGRATION-DECISIONS](01-baseline-and-contracts.md#migration-decisions) | 记录迁移 ownership、威胁模型、平台范围、回退和待授权事项。 |
| [TOOLCHAIN-CONTRACT](01-baseline-and-contracts.md#toolchain-contract) | 使源码、测试和安装入口共同通过严格工具链。 |
| [MODEL-IDENTITY](01-baseline-and-contracts.md#model-identity) | 解析固定 UUID、SHA-256、相对 POSIX 路径、枚举、Identifier，并以不同 brand 阻止 ID 互换；拒绝大小写/空白/非法格式。 |
| [MODEL-RECORDS](01-baseline-and-contracts.md#model-records) | 解析 Provenance、LiteratureMetadata、Literature、MetaLiterature、Reference、Asset、LibraryQuery；拒绝未知字段、错误 null、反向年份范围和自引用。 |
| [MODEL-ERRORS](01-baseline-and-contracts.md#model-errors) | 提供 closed `ContractValidationError`、稳定脱敏 failure 和严格 ReportEnd；错误只返回固定消息、路径和 code，不回显输入。 |
| [CANONICAL-JSON](01-baseline-and-contracts.md#canonical-json) | 实现递归 key 排序、Unicode NFC、UTF-8、有限数字和 duplicate-key strict JSON；输出与 v1 fixture 逐字节一致。 |
| [CANONICAL-INTEGRITY](01-baseline-and-contracts.md#canonical-integrity) | 对 canonical bytes 计算 SHA-256，并实现带 kind/version/checksum 绑定的无填充 base64url cursor 编解码和篡改拒绝。 |
| [MIGRATION-CONTRACTS](01-baseline-and-contracts.md#migration-contracts) | 把已获准的迁移方向落实到权威设计，并分离 Proposed 与 Accepted 决策。 |
| [BASELINE-ACCEPTANCE](01-baseline-and-contracts.md#baseline-acceptance) | 在实现继续前关闭清单、spike、运行时选择、合同和验收追踪的 R3。 |

## Block 02：运行时、配置、网络、持久基础与组装

| 稳定 ID | 具体结果与执行入口 |
| --- | --- |
| [CONFIG-PARSER](02-runtime-storage-network.md#config-parser) | 保持 TOML/默认值兼容并安全读取普通配置。 |
| [CONFIG-CREDENTIAL](02-runtime-storage-network.md#config-credential) | 按 owner、用途和 origin 隔离凭据消费。 |
| [NETWORK-URL](02-runtime-storage-network.md#network-url) | 在建立 DNS 或 socket 之前拒绝不具备安全 URL 语义的请求。 |
| [NETWORK-RESOLUTION](02-runtime-storage-network.md#network-resolution) | 对 DNS 全部答案执行地址分类并固定批准地址集合。 |
| [NETWORK-CONNECTION](02-runtime-storage-network.md#network-connection) | 让 HTTP/TLS socket 固定到批准 IP，同时保留 hostname 校验。 |
| [NETWORK-REDIRECT](02-runtime-storage-network.md#network-redirect) | 每跳重新 admission，并按 origin 决定是否转发凭据。 |
| [NETWORK-ADMISSION](02-runtime-storage-network.md#network-admission) | 将已通过的 URL、解析、连接和 redirect 规则汇合到唯一请求入口。 |
| [NETWORK-PERMIT](02-runtime-storage-network.md#network-permit) | 以 scope 与 host 两级共享状态实施最严格并发限制。 |
| [NETWORK-CANCEL](02-runtime-storage-network.md#network-cancel) | 让 AbortSignal 贯穿排队、连接和响应读取。 |
| [NETWORK-BODY-LIMIT](02-runtime-storage-network.md#network-body-limit) | 只按响应 body 字节实施有界读取和失败释放。 |
| [NETWORK-RETRY-AFTER](02-runtime-storage-network.md#network-retry-after) | 解析并绑定有界 Retry-After，且只由显式编排消费。 |
| [NETWORK-BUDGET](02-runtime-storage-network.md#network-budget) | 将 permit、取消、体量和 Retry-After 切片汇合到请求编排。 |
| [NETWORK-BROWSER-PORT](02-runtime-storage-network.md#network-browser-port) | 向 Browser Host 提供逐事件、不可绕过的 Network admission 端口。 |
| [FILE-STAGE-WRITE](02-runtime-storage-network.md#file-stage-write) | 在 owner-only、O_EXCL、no-follow 的临时对象中执行有界写入。 |
| [FILE-STAGE-READ](02-runtime-storage-network.md#file-stage-read) | 通过绑定目录和文件身份提供有界、不可越界的读取。 |
| [FILE-STAGE-HANDOFF](02-runtime-storage-network.md#file-stage-handoff) | 以明确状态转换封存 stage 并生成可发布引用。 |
| [FILE-STAGING](02-runtime-storage-network.md#file-staging) | 将受控写入、绑定读取和封存交接汇合为不可变文件切片。 |
| [FILE-PUBLICATION](02-runtime-storage-network.md#file-publication) | 实现 fsync 后 create-if-absent/no-clobber 发布和冲突证据。 |
| [FILE-LOCKING](02-runtime-storage-network.md#file-locking) | 实现跨进程锁、目录/文件 fsync、故障关闭和持锁进程退出处理。 |
| [CONFIG-PUBLICATION](02-runtime-storage-network.md#config-publication) | 安全保存普通配置和凭据编辑。 |
| [SQLITE-WORKER](02-runtime-storage-network.md#sqlite-worker) | 让独立 DB Worker 持有连接，只接受 typed v1 read/write command。 |
| [SQLITE-SNAPSHOT-CONCURRENCY](02-runtime-storage-network.md#sqlite-snapshot-concurrency) | 证明单 writer、长查询响应性和跨表读取快照一致。 |
| [REPOSITORY-OBSERVATION](02-runtime-storage-network.md#repository-observation) | 发布和读取 metadata observation、identity/current facts，保留 provenance 和 CAS。 |
| [REPOSITORY-ASSET](02-runtime-storage-network.md#repository-asset) | 发布和读取 asset、parser/content artifact 及 literature-asset relation。 |
| [REPOSITORY-REFERENCE](02-runtime-storage-network.md#repository-reference) | 发布和读取 reference/provider relation，提供一致快照和只读边界。 |
| [REPOSITORY-LITERATURE](02-runtime-storage-network.md#repository-literature) | 提供 Literature/MetaLiterature 身份、版本成员和 current-facts 的 typed commands。 |
| [REPOSITORY-DISCOVERY](02-runtime-storage-network.md#repository-discovery) | 提供 Discovery run、scope、candidate 和逐来源进度的 v1 兼容持久边界。 |
| [REPOSITORY-PARSER-CONTENT](02-runtime-storage-network.md#repository-parser-content) | 提供 ParserResult、ContentArtifact、current 关系和 lineage 的 typed commands。 |
| [REPOSITORY-ANALYSIS](02-runtime-storage-network.md#repository-analysis) | 提供 metadata/content/reference analysis 结果、receipt 和 current 投影的 typed commands。 |
| [REPOSITORY-QUERY](02-runtime-storage-network.md#repository-query) | 提供 v1 兼容的 search/detail/reference/cited-by、排序、cursor 和 FTS 读取。 |
| [REPOSITORY-ATOMIC-PUBLICATION](02-runtime-storage-network.md#repository-atomic-publication) | 汇合文件先行、短 DB 事务、stale CAS、FTS 和失败对账。 |
| [AGENT-RUNTIME](02-runtime-storage-network.md#agent-runtime) | 建立 provider-neutral call、model capability、tool/image/reasoning/stream/usage 和 cancel 合同。 |
| [AGENT-RESPONSES](02-runtime-storage-network.md#agent-responses) | 实现 OpenAI Responses JSON/SSE adapter，共用 NetworkClient。 |
| [AGENT-CHAT](02-runtime-storage-network.md#agent-chat) | 实现 OpenAI Chat adapter，共用 NetworkClient 和 usage/error mapping。 |
| [AGENT-ANTHROPIC](02-runtime-storage-network.md#agent-anthropic) | 实现 Anthropic JSON/SSE adapter，保持 stream mode 显式。 |
| [LOGGING-REDACTION](02-runtime-storage-network.md#logging-redaction) | 提供独立于报告的脱敏日志入口。 |
| [APP-COMPOSITION](02-runtime-storage-network.md#app-composition) | 组装唯一 FileStore、DB Worker、Network、Agents、日志和 repositories。 |
| [APP-LIFECYCLE](02-runtime-storage-network.md#app-lifecycle) | 实现启动失败清理、幂等 close、错误传播和临时 home 离线加载。 |
| [RUNTIME-FOUNDATION-ACCEPTANCE](02-runtime-storage-network.md#runtime-foundation-acceptance) | 关闭 Configuration、Network、FileStore、v1 repositories、Agents 和对象图的 R3。 |

## Block 03：Browser 工作台与候选获取

| 稳定 ID | 具体结果与执行入口 |
| --- | --- |
| [BROWSER-HOST](03-browser-and-acquisition.md#browser-host) | 建立唯一 Browser Host，管理固定 Profile、页面集合、诊断与关闭。 |
| [BROWSER-EGRESS-INTEGRATION](03-browser-and-acquisition.md#browser-egress-integration) | 将 Browser 的每个外部事件接入不可绕过的 Network admission。 |
| [BROWSER-RECOVERY](03-browser-and-acquisition.md#browser-recovery) | 定义 Host、Context、Page 和 Profile 的故障恢复与 fencing。 |
| [BROWSER-OBSERVATION](03-browser-and-acquisition.md#browser-observation) | 生成有版本、可截断并显式标注加载状态的 Observation。 |
| [BROWSER-ACTION-EXECUTOR](03-browser-and-acquisition.md#browser-action-executor) | 实现唯一、封闭且穷举校验的 Browser Action Executor。 |
| [SCREEN-SOURCE](03-browser-and-acquisition.md#screen-source) | 从唯一页面生成带 viewport/version 的有界画面帧。 |
| [SCREEN-STREAM](03-browser-and-acquisition.md#screen-stream) | 向多个观看者发送有背压、可丢旧帧的单页面画面流。 |
| [WORKBENCH-ENDPOINT](03-browser-and-acquisition.md#workbench-endpoint) | 提供本地工作台的会话、画面、控制和诊断协议端点。 |
| [WORKBENCH-WEB](03-browser-and-acquisition.md#workbench-web) | 实现可观看状态、控制权和错误的真实 Browser 前端。 |
| [WORKBENCH-INPUT](03-browser-and-acquisition.md#workbench-input) | 将鼠标、滚轮、键盘和 IME 输入转换为受控动作。 |
| [BROWSER-UNSUPPORTED-INPUT](03-browser-and-acquisition.md#browser-unsupported-input) | 对剪贴板、拖放、文件选择和未知输入显式拒绝或安全降级。 |
| [BROWSER-CONTROL](03-browser-and-acquisition.md#browser-control) | 闭合单人工控制者、观看者、takeover/release 与重连。 |
| [TRANSFER-DISPATCH](03-browser-and-acquisition.md#transfer-dispatch) | 统一接收 response、download、popup、frame 和 viewer 产生的传输信号。 |
| [TRANSFER-RESPONSE-FORMS](03-browser-and-acquisition.md#transfer-response-forms) | 捕获 GET/POST、inline、attachment、blob/data 和 viewer 响应形态。 |
| [TRANSFER-RANGE-ETAG](03-browser-and-acquisition.md#transfer-range-etag) | 正确处理 Range、206、ETag 与重取边界。 |
| [TRANSFER-ATTRIBUTION](03-browser-and-acquisition.md#transfer-attribution) | 将 popup、iframe、viewer 和 Service Worker 传输归属到正确文章执行。 |
| [TRANSFER-DEDUPLICATION](03-browser-and-acquisition.md#transfer-deduplication) | 对重复事件和同字节候选实现稳定幂等。 |
| [TRANSFER-DRAIN](03-browser-and-acquisition.md#transfer-drain) | 在动作、页面或工作台结束后有界排空仍在进行的传输。 |
| [BROWSER-COLLECTOR](03-browser-and-acquisition.md#browser-collector) | 将完整 Transfer 生命周期汇合为 durable-ready Candidate。 |
| [POLICY-CONTRACT](03-browser-and-acquisition.md#policy-contract) | 定义封闭 policy schema、收紧规则、版本和冻结快照。 |
| [POLICY-ASSISTANCE](03-browser-and-acquisition.md#policy-assistance) | 定义人工协助请求、超时、恢复和控制权转换。 |
| [POLICY-PRIVACY](03-browser-and-acquisition.md#policy-privacy) | 限制 Observation、模型输入、日志和持久事件中的敏感信息。 |
| [EXECUTION-POLICY](03-browser-and-acquisition.md#execution-policy) | 汇合冻结预算、pause/defer、assistance 与 privacy 语义。 |
| [EXECUTION-LOOP](03-browser-and-acquisition.md#execution-loop) | 按 Observation、budget 和 epoch 执行至多一个 typed action。 |
| [EXECUTION-DIAGNOSTICS](03-browser-and-acquisition.md#execution-diagnostics) | 生成有界、脱敏且可恢复的 Browser 执行诊断。 |
| [PDF-ACCEPTANCE](03-browser-and-acquisition.md#pdf-acceptance) | 在受限执行环境验证实际 PDF 字节的基本结构。 |
| [PDF-TEXT-EVIDENCE](03-browser-and-acquisition.md#pdf-text-evidence) | 有界提取仅供 identity/version 判断的文本和文档属性证据。 |
| [IDENTITY-VERDICT](03-browser-and-acquisition.md#identity-verdict) | 对目标文章身份给出 accepted/rejected/uncertain 与证据。 |
| [VERSION-VERDICT](03-browser-and-acquisition.md#version-verdict) | 独立裁决版本归属并保留三态证据。 |
| [CANDIDATE-PUBLICATION](03-browser-and-acquisition.md#candidate-publication) | 发布 durable Candidate、候选 evidence 和可重放 receipt。 |
| [SOURCE-ARXIV](03-browser-and-acquisition.md#source-arxiv) | 按可靠 arXiv 标识和版本生成公开 PDF locator。 |
| [SOURCE-EUROPE-PMC](03-browser-and-acquisition.md#source-europe-pmc) | 按 PMID/PMCID 和开放资产线索解析候选。 |
| [SOURCE-DIRECT](03-browser-and-acquisition.md#source-direct) | 消费明确 direct PDF locator 并校验实际目标站点。 |
| [SOURCE-DOI-LANDING](03-browser-and-acquisition.md#source-doi-landing) | 从 DOI landing 生成受校验的下一步 locator 与站点证据。 |
| [SOURCE-UNPAYWALL](03-browser-and-acquisition.md#source-unpaywall) | 转换开放位置、版本和来源并获取候选。 |
| [SOURCE-CONFIGURED-MIRRORS](03-browser-and-acquisition.md#source-configured-mirrors) | 保持配置镜像默认关闭、顺序精确和普通安全边界。 |
| [SOURCE-CORE](03-browser-and-acquisition.md#source-core) | 按 CORE 内容能力与明确 grant 完成 lookup/download。 |
| [SOURCE-ELSEVIER](03-browser-and-acquisition.md#source-elsevier) | 按可靠标识和实际内容站点调用授权内容 API。 |
| [SOURCE-WILEY](03-browser-and-acquisition.md#source-wiley) | 按 Wiley 内容定位与授权范围执行 lookup/download。 |
| [SOURCE-BROWSER](03-browser-and-acquisition.md#source-browser) | 将合法文章起点交给唯一 Browser 执行器并消费 Candidate。 |
| [ACQUISITION-ROUTE](03-browser-and-acquisition.md#acquisition-route) | 编排公开、授权与 Browser route 的混合批次。 |
| [AUTOMATED-ACQUISITION-JOURNEY](03-browser-and-acquisition.md#automated-acquisition-journey) | 在 loopback 完成 Browser 动作、捕获、裁决和 durable Candidate 旅程。 |
| [BROWSER-ACQUISITION-ACCEPTANCE](03-browser-and-acquisition.md#browser-acquisition-acceptance) | 完成工作台与候选获取的块级 R3。 |

## Block 04：业务能力与正式文献发布

| 稳定 ID | 具体结果与执行入口 |
| --- | --- |
| [META-ARXIV](04-business-and-service.md#meta-arxiv) | 迁移 arXiv XML search/lookup、分页、identity 和失败映射。 |
| [META-CORE](04-business-and-service.md#meta-core) | 迁移 CORE JSON search/lookup、分页、凭据和失败映射。 |
| [META-CROSSREF](04-business-and-service.md#meta-crossref) | 迁移 Crossref search/lookup、polite identity 和 envelope。 |
| [META-DATACITE](04-business-and-service.md#meta-datacite) | 迁移 DataCite works/dataset lookup、分页和 identifier mapping。 |
| [META-ELSEVIER](04-business-and-service.md#meta-elsevier) | 迁移 Elsevier search/lookup、quota/access feedback 和 cursor。 |
| [META-EUROPE-PMC](04-business-and-service.md#meta-europe-pmc) | 迁移 Europe PMC search/lookup/citation/reference pages。 |
| [META-OPENALEX](04-business-and-service.md#meta-openalex) | 迁移 OpenAlex search/lookup、abstract location 和分页。 |
| [META-OPENCITATIONS](04-business-and-service.md#meta-opencitations) | 迁移 OpenCitations lookup/citation/reference relation。 |
| [META-SEMANTIC-SCHOLAR](04-business-and-service.md#meta-semantic-scholar) | 迁移 Semantic Scholar search/lookup/citation/reference pages。 |
| [META-SPRINGER](04-business-and-service.md#meta-springer) | 迁移 Springer search/lookup、access feedback 和 cursor。 |
| [META-WEB-OF-SCIENCE](04-business-and-service.md#meta-web-of-science) | 分别迁移 WoS starter/expanded search/lookup/citation/reference adapter。 |
| [META-DISPATCH](04-business-and-service.md#meta-dispatch) | 统一 Source 选择、逐来源扫描和 publication。 |
| [LIT-IDENTITY](04-business-and-service.md#lit-identity) | 保持保守身份收敛与单一版本成员归属。 |
| [LIT-CURRENT-FACTS](04-business-and-service.md#lit-current-facts) | 迁移 version/current facts、observation precedence 和 stale CAS 处理。 |
| [LITERATURE-ASSET-PUBLICATION](04-business-and-service.md#literature-asset-publication) | 由 Literature owner 将已确认 Candidate 发布为正式文献资产。 |
| [LIT-REFERENCES](04-business-and-service.md#lit-references) | 迁移 metadata/content/provider reference acceptance 和 closure。 |
| [LIT-DELETE](04-business-and-service.md#lit-delete) | 迁移 deletion、replacement 和 no-usable-content cleanup 语义。 |
| [DISCOVERY-ENTRY](04-business-and-service.md#discovery-entry) | 迁移 topic/citation discovery、scope、report 和 cancellation。 |
| [IMPORT-METADATA](04-business-and-service.md#import-metadata) | 迁移 BibTeX/CSL JSON/RIS import、逐记录结果和 provenance。 |
| [IMPORT-PDF](04-business-and-service.md#import-pdf) | 迁移用户指定 Literature 的 PDF admission 和 immutable asset。 |
| [EXPORT-METADATA](04-business-and-service.md#export-metadata) | 迁移 scoped BibTeX/CSL JSON/RIS export 和 no-clobber output。 |
| [EXPORT-ARTIFACT](04-business-and-service.md#export-artifact) | 迁移 PDF/content artifact export、overwrite 保护和 raw stdout。 |
| [PARSER-MINERU](04-business-and-service.md#parser-mineru) | 迁移 operator-managed MinerU health/submit/poll/result handoff，不引入服务状态 owner。 |
| [ANALYSIS-METADATA](04-business-and-service.md#analysis-metadata) | 迁移 metadata analysis prompt、budget、schema 和 receipt。 |
| [ANALYSIS-CONTENT](04-business-and-service.md#analysis-content) | 迁移 markdown content analysis、chunk/lineage 和 artifact publication。 |
| [ANALYSIS-REFERENCES](04-business-and-service.md#analysis-references) | 迁移 reference analysis、evidence 和 relation publication。 |
| [LIBRARY-QUERY](04-business-and-service.md#library-query) | 迁移 search/detail/reference/cited-by、sort、cursor 和 structured output。 |
| [ENTRY-APPLICATION](04-business-and-service.md#entry-application) | 闭合业务公共入口和生产对象图。 |
| [CLI-DISCOVERY](04-business-and-service.md#cli-discovery) | 实现 `discover topic` 与 `discover citations` 的参数、JSON、错误和退出码。 |
| [CLI-COMPLETION](04-business-and-service.md#cli-completion) | 提供 pdf/parse/content 数据库补全命令。 |
| [CLI-LIBRARY](04-business-and-service.md#cli-library) | 实现 `literature search/show/references/cited-by` 的帮助和结果。 |
| [CLI-EXCHANGE](04-business-and-service.md#cli-exchange) | 实现 `import metadata/pdf`、`export metadata/pdf/content` 的参数与输出。 |
| [MODEL-CATALOG](04-business-and-service.md#model-catalog) | 在模型配置流程执行有界模型目录读取。 |
| [CONFIG-PROBE](04-business-and-service.md#config-probe) | 提供按 owner 组织的无 Storage 探测。 |
| [CONFIG-EDITOR](04-business-and-service.md#config-editor) | 完成普通配置和凭据的交互编辑闭环。 |
| [CLI-CONFIG](04-business-and-service.md#cli-config) | 实现 `config/status/test` 的 owner target、脱敏和退出码。 |

## Block 05：持久服务、调度与恢复

| 稳定 ID | 具体结果与执行入口 |
| --- | --- |
| [EXECUTION-SCHEMA](05-persistent-service-and-recovery.md#execution-schema) | 定义并检查版本化 v2 execution schema 与不变量。 |
| [SCHEMA-BACKUP](05-persistent-service-and-recovery.md#schema-backup) | 在升级前生成一致、带 hash 且 no-clobber 的数据库备份。 |
| [SCHEMA-MIGRATION](05-persistent-service-and-recovery.md#schema-migration) | 在合成副本上从 v1 显式迁移到 v2。 |
| [SCHEMA-ROLLBACK](05-persistent-service-and-recovery.md#schema-rollback) | 从受验证备份恢复 v1 副本并拒绝错误目标。 |
| [JOB-REPOSITORY](05-persistent-service-and-recovery.md#job-repository) | 持久化 job 输入快照、状态、租约和终态 CAS。 |
| [ATTEMPT-REPOSITORY](05-persistent-service-and-recovery.md#attempt-repository) | 记录 attempt、worker epoch、预算消耗与可解释终态。 |
| [EVENT-REPOSITORY](05-persistent-service-and-recovery.md#event-repository) | 追加有序、脱敏、可游标恢复的运行事件。 |
| [CANDIDATE-ACK](05-persistent-service-and-recovery.md#candidate-ack) | 持久记录 Candidate 交付、接纳或拒绝 ACK。 |
| [RECOVERABLE-QUEUE](05-persistent-service-and-recovery.md#recoverable-queue) | 用租约和 fencing 构建可重启的有界 job 队列。 |
| [WORKSPACE-SCHEDULING](05-persistent-service-and-recovery.md#workspace-scheduling) | 实现 workspace 内串行与跨 workspace 有界调度。 |
| [ASSISTANCE-REQUEST](05-persistent-service-and-recovery.md#assistance-request) | 持久化并恢复人工协助请求与过期结果。 |
| [EXECUTION-RECOVERY](05-persistent-service-and-recovery.md#execution-recovery) | 在崩溃重启后对账 running attempt、事件、Candidate 与 ACK。 |
| [SERVICE-AUTHENTICATION](05-persistent-service-and-recovery.md#service-authentication) | 为本地服务建立认证主体、会话和 workspace 授权。 |
| [SERVICE-HTTP-API](05-persistent-service-and-recovery.md#service-http-api) | 暴露 status、jobs、workspaces、assistance 与业务操作 HTTP API。 |
| [SERVICE-EVENT-STREAM](05-persistent-service-and-recovery.md#service-event-stream) | 提供按游标恢复且有背压的事件 WebSocket。 |
| [SERVICE-SCREEN-STREAM](05-persistent-service-and-recovery.md#service-screen-stream) | 将 Browser 画面流接入认证服务并保持丢旧帧背压。 |
| [CLI-DAEMON-COORDINATION](05-persistent-service-and-recovery.md#cli-daemon-coordination) | 协调 CLI 与 daemon 的启动、发现、关闭和失败语义。 |
| [SERVICE-API](05-persistent-service-and-recovery.md#service-api) | 汇合认证、HTTP、事件与画面流到唯一服务端口。 |
| [PERSISTENT-SERVICE-JOURNEY](05-persistent-service-and-recovery.md#persistent-service-journey) | 从真实 loopback 服务完成提交、观看、协助、重连和恢复。 |
| [SCHEMA-COPY-RECOVERY](05-persistent-service-and-recovery.md#schema-copy-recovery) | 在 v1/v2 合成副本演练升级、服务运行、失败与恢复。 |
| [PERSISTENT-SERVICE-ACCEPTANCE](05-persistent-service-and-recovery.md#persistent-service-acceptance) | 完成持久服务、调度和恢复的块级 R3/R4。 |

## Block 06：最终验证、发布准备与交接

| 稳定 ID | 具体结果与执行入口 |
| --- | --- |
| [TS-QUALITY-GATES](06-verification-and-handoff.md#ts-quality-gates) | 在当前工作树运行并记录 TypeScript Quick、Test 与 Full。 |
| [PYTHON-QUALITY-GATES](06-verification-and-handoff.md#python-quality-gates) | 在当前工作树运行并记录既有 Python Quick 与 Full 回归。 |
| [CI-INTEGRATION](06-verification-and-handoff.md#ci-integration) | 让 CI 在正确触发条件运行 TS 与既有 Python 门禁。 |
| [PACKAGE-BUILD](06-verification-and-handoff.md#package-build) | 从清理后的源码构建版本化、可复现的交付产物。 |
| [PACKAGE-CONTENT](06-verification-and-handoff.md#package-content) | 核对包内 exports、CLI、Worker、Web、native 组件、许可证和禁入内容。 |
| [PLATFORM-INSTALLATION](06-verification-and-handoff.md#platform-installation) | 在支持矩阵每个平台安装实际产物并验证原生依赖。 |
| [PACKAGE-INSTALLATION](06-verification-and-handoff.md#package-installation) | 汇合构建、内容和平台安装为可交付安装结论。 |
| [CLEAN-ENVIRONMENT-JOURNEY](06-verification-and-handoff.md#clean-environment-journey) | 在全新临时 home 从实际安装包完成首次启动与基础业务旅程。 |
| [OFFLINE-JOURNEY](06-verification-and-handoff.md#offline-journey) | 从实际安装包完成 Browser、Candidate、Literature 与持久恢复全旅程。 |
| [DATA-BACKUP-DRILL](06-verification-and-handoff.md#data-backup-drill) | 演练 Catalog、资产引用和 execution 数据的一致备份。 |
| [DATA-MIGRATION-DRILL](06-verification-and-handoff.md#data-migration-drill) | 从冻结 v1 副本演练完整 v2 数据升级。 |
| [DATA-ROLLBACK-DRILL](06-verification-and-handoff.md#data-rollback-drill) | 从备份演练 v2 到 v1 恢复并核对用户可观察结果。 |
| [PROFILE-ROLLBACK-DRILL](06-verification-and-handoff.md#profile-rollback-drill) | 演练配置、凭据和 Browser Profile 的备份边界与恢复。 |
| [RECOVERY-DRILL](06-verification-and-handoff.md#recovery-drill) | 汇合数据与 Profile 的备份、迁移、回滚和故障恢复。 |
| [PERFORMANCE-VALIDATION](06-verification-and-handoff.md#performance-validation) | 在声明平台测量关键吞吐、延迟、内存和磁盘边界。 |
| [BACKPRESSURE-VALIDATION](06-verification-and-handoff.md#backpressure-validation) | 验证 HTTP、事件、画面、队列和文件流的有界背压。 |
| [SECURITY-VALIDATION](06-verification-and-handoff.md#security-validation) | 验证 SSRF、认证、凭据、路径、PDF、Browser 与包边界。 |
| [LIVE-SITE-STATUS](06-verification-and-handoff.md#live-site-status) | 记录真实站点、Provider、MinerU 与 LLM 验证的授权和实际状态。 |
| [DOCUMENTATION-SYNC](06-verification-and-handoff.md#documentation-sync) | 同步当前行为、安装、配置、服务、迁移、恢复和限制文档。 |
| [PYTHON-RETIREMENT-REPORT](06-verification-and-handoff.md#python-retirement-report) | 逐能力证明 Python 保留、替代或待退役状态。 |
| [CUTOVER-DRILL](06-verification-and-handoff.md#cutover-drill) | 在隔离副本演练入口切换、失败回退和责任交接。 |
| [READINESS-REPORT](06-verification-and-handoff.md#readiness-report) | 汇总全局验收、平台、证据、残余风险和待授权动作。 |
| [CUTOVER-REVIEW](06-verification-and-handoff.md#cutover-review) | 对实际包、数据、安全、文档和回退材料执行最终 R5。 |
| [CUTOVER-AUTHORIZATION](06-verification-and-handoff.md#cutover-authorization) | 记录用户对具体生产切换、发布或 Python 退役动作的决定。 |

## 命名和状态规则

- Python 测试使用 `test_<behavior>.py`，TypeScript 测试使用 `<behavior>.test.ts`；suite 描述被保护行为。
- 不使用 `m4`、里程碑、phase、step、块号、计划顺序或 Task ID 命名测试；编号只用于计划文件排序。
- 每个 Task 在所属块写明结果、改动面、依赖、可观察验收、直接验证和证据；索引不能替代这些字段。
- 历史研究档案不参与任务依赖、验收、状态、证据或恢复；执行只使用本计划、项目真相源和实际证据。
- 状态规则见[上级计划规范](../README.md#5-task-与状态语义)；新增验收后必须重新核对原证据。

当前索引共 189 个稳定 Task；数量仅用于本次结构一致性检查，状态仍以所属块为准。
