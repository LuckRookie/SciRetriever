# ADR 0025：TypeScript 当前架构与统一 Entry 运行合同

类型：决策（ADR）
负责：TypeScript 当前架构与统一 Entry 运行合同
状态：Accepted；产品操作范围被 [ADR 0026](0026-agent-knowledge-and-human-collaboration.md) 扩展：旧的两个目标和单篇内容报告不再涵盖全部知识合同

- Date: 2026-09-12
- Last amended: 2026-09-26
- Amends: [ADR 0013](0013-decoupled-discovery-and-database-maintenance.md)、[ADR 0014](0014-capability-scoped-providers-and-local-credentials.md)、[ADR 0015](0015-publisher-aware-tiered-pdf-acquisition.md)、[ADR 0018](0018-fixed-user-configuration-home.md)、[ADR 0024](../../archive/decisions/0024-typescript-browser-workbench-migration.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[TypeScript 架构锚定基线](../typescript-baseline.md)、[任务与协作控制：数据库补全与阶段协调](../technical/02-task-coordination.md#4-数据库补全与阶段协调)
- Amended by: [ADR 0026](0026-agent-knowledge-and-human-collaboration.md)

## 背景

TypeScript 迁移后，活动源码、Accepted 架构和当前文档出现了不同步：旧 Python 目录仍被部分技术文档当作当前实现，Browser 组件与生产对象图的状态边界不清，配置测试的本地 readiness 与真实连通性 probe 被混为一谈，CLI、Web、Job 的处理入口也缺少统一的结果合同。若先按当前代码修补而不先锚定合同，会把临时实现固化为新的公共语义。

本 ADR 只确认架构方向和用户可观察合同；它不宣称任何尚未由源码、直接测试和带环境证据证明的能力已经实现，也不授权真实 Provider、真实 MinerU、真实 Catalog 或生产切换操作。

## 决策

### 1. TypeScript 是唯一活动架构

- TypeScript workspace、`apps/server`、`apps/web`、Application、CLI 和 Browser 生产路线是当前唯一活动实现。
- Python 源码、旧测试和旧 Harness 只作为历史迁移材料或经明确授权的离线 oracle 保留。
- 不支持 Python/TypeScript 双轨、双写、运行时 fallback 或第二个业务真相源。
- 当前技术文档中的 Python 目录、Pydantic、`api.py`、wheel 和 `.venv` 描述，必须明确标为历史或迁移对照；不得写成当前 TS 路径。

### 2. Browser 属于当前生产能力范围

PDF 自动获取的目标分层固定为：

```text
Public → Authorized API → Controlled Browser
```

Browser 生产能力必须使用唯一 `browser:generic` controller、CloakBrowser 固定身份 Profile、共享 process/context、Network admission 和 Acquisition 的 PDF/文章归属验收。CLI、Job 或 workbench 不得另行组装 Browser/Acquisition 对象图。

当前 Browser 组件存在不等于真实运行时已经验收。生产 Application 现已接入惰性 BrowserHost factory、Network navigation admission、统一 `browser:generic` escalation、完整 Public/API/Browser cohort 波次、共享 scheduler/session broker、版本化 landing hint、Article flow 和 Candidate Intake/身份验收；缺少 verified runtime 或 admission 时稳定 fail closed。真实 `verifyInstalledCloakRuntime → new BrowserHost → start/openPage → deliver` 正路径和站点现场验证必须明确写成“未运行”。Workbench/offline seam 证据不能替代生产 runtime 证据。

### 3. 配置身份固定

生产普通配置和凭据身份固定为：

```text
~/.sciretriever/config.toml
~/.sciretriever/credentials.toml
```

正常 CLI 不读取 `SCIRETRIEVER_HOME`、当前工作目录或第二个配置路径，也不提供 `--config`。home 注入仅供内部隔离测试和边界验证，不成为用户可见的路径选择机制。配置和凭据目录/文件继续执行 ADR 0018 的 owner、权限、单硬链接和非符号链接检查。

### 4. `config test` 是真实、显式、最小、只读的 probe

`config status` 只计算本地 readiness；用户显式执行 `config test` 时，统一 TUI 和结构化 CLI 必须调用同一个不含 Storage 副作用的 Probe service。Probe 应按 owner 支持 Provider、Model、Search、Parse、Analyze、Browser Model 和单目标 Browser Site 的最小只读验证；没有安全通用外部请求的 Download 必须返回稳定 `unavailable`，不能借用其它能力或下载任意 PDF 伪装成功。

Probe 结果必须脱敏并区分：本地字段存在、凭据存在、认证成功、endpoint/Model 可用和具体文章 entitlement。当前 `ConfigurationProbeSession` 已执行有界只读请求：Provider、Model、Search、Parse、Analyze 在 adapter/授权具备时运行，Download 稳定返回 `unavailable`，Browser Site 仅在显式 adapter/seam 与 runtime/admission 具备时运行；否则返回稳定 unavailable。测试 fake/loopback 只证明离线边界，不替代生产真实 probe。任何延期仍须显式返回 `deferred`/`unavailable`，并禁止 readiness 或 README 宣称该能力已通过；本 ADR 不接受未标记的离线 stub。

### 5. 所有处理型入口共享统一 Entry 合同

CLI、Web 和 Job 都必须最终调用同一 Entry/Application orchestrator，不得在适配层复制 Acquisition、fallback、取消、错误分类、Storage 写入或 Report 生成。Entry 负责根据当前数据库 snapshot 冻结目标，调用各模块公开 API，并把本次运行结果返回调用方；Storage 只保存业务模块确认的事实。

一次请求允许多个 Literature 目标，采用目标级隔离、请求级汇总：

- 单目标普通失败不回滚其它已经提交的有效事实，也不阻断其它目标的独立处理；
- 不可恢复的共同系统错误可以停止后续调度，但必须报告已完成、当前中断和未开始目标；
- 取消后不启动新目标；已开始且被取消的当前目标进入 `interrupted`，从未开始的冻结目标进入 `notStarted`，已完成目标保留；已提交事实不回滚；
- 断电或强制终止不保证产生最终报告，重启后从当前事实重新选择，不恢复旧外部调用现场。

既有数据库补全报告使用五个互斥分区；独立读取、多用途知识和提取候选各有自己的结果合同，不由此枚举穷尽：

```text
completed
failed
skipped
notStarted
interrupted
```

每个冻结目标只能出现一次。报告至少表达目标、阶段、稳定失败类别、route/provenance、已经提交的事实、是否需要人工介入和是否可重试；日志只提供实时诊断，不能反向构造报告。`DatabaseCompletionReport` 是现有补全合同。接受本 ADR 时，CLI/Application 通过 `DatabaseCompletionService` 运行完整 operation，Jobs 仅使用 `DatabaseCompletionTargetRunner`；当时这是统一 Entry 目标的实现差距。M03-T02 已将新建 Job 的冻结范围和运行接入完整操作，旧 Job 保留已存目标与逐目标 wire；此实施更新不改变本 ADR 的目标合同。

PDF completion Job 与 CLI/Web 使用同一 Entry；如果某个 Job 只提出人工介入而不执行 PDF 获取，必须使用明确的 intervention goal，不能以 `pdf` 名称返回含义相反的 `skipped`。

## 后果

- 设计、技术文档和用户文档可以稳定区分目标合同、当前实现和历史材料。
- 后续 F1/F6、Browser 编排、config probe、completion report 和错误分类修复可以按同一 Entry/Storage 边界验收。
- TypeScript contracts、Entry public surface、Browser production object graph 和 probe service 已形成当前实现边界；当前已有 operation-local bounded cohort、三级 receipt wave 与 Application 共享 scheduler/session broker，后续仍需对真实 Browser runtime 和现场外部服务分别取得直接证据，这些证据不由本 ADR 自动产生。
- 文档和测试必须保留真实外部能力的 `not-run`、`not-authorized` 和 `skipped` 证据，不能用离线绿色结果替代现场授权。

## 不采用的方案

- 继续把 Python 目标目录当作当前 TS 技术结构。
- 让 CLI、Job、Workbench 各自组装一套 Acquisition 或 Browser runtime。
- 用本地 readiness 或固定 `network_performed=false` 伪装真实 config probe 已通过。
- 通过修改需求或测试把未实现的 `DatabaseCompletionReport` 解释为已完成。
- 让 Storage 自行作出业务决定，或让运行进度/日志成为第二套权威文献事实。执行 owner 按明确合同保存必要执行记录不等于第二套文献事实；新任务存续和恢复保证仍待决定。
