+++
document_type = "execution-plan"
status = "in-progress"
owner = "acquisition-maintainer"
approved_by = "project-owner"
approved_on = "2026-07-22"
approval_ref = "conversation:2026-07-22:separate-proposals-then-execute; conversation:2026-07-22:expand-current-plan-to-full-product; conversation:2026-07-22:owner-approved-12-request-ceiling-and-m1-spec-implementation"
source_proposal = "download-implementation-proposal.md"
requirements = ["../../specs/requirements.md", "../../specs/system-design.md"]
+++

# 文献下载完整产品执行计划

> **归档状态：已被替代。** 本文的 `status = "in-progress"` 是 2026-07-23 产品重置前的历史状态，不代表当前仍在执行；本文不是当前需求、产品方向或实施授权。当前方向见 [ADR 0002](../../adr/0002-work-centered-literature-library.md)和[文献库执行计划](../../planning/literature-library-execution.md)。下文 front matter 状态和正文保持历史原样。

本计划曾把[文献下载实施提案](download-implementation-proposal.md)中的完整产品路线整理为一个持续活动的 M0 至 M5 执行计划。当前需求和设计见[需求](../../specs/requirements.md)与[系统设计](../../specs/system-design.md)；[产品方案](download-product-shape.md)、[能力对比](download-capability-comparison.md)和[能力差距台账](capability-gaps.md)现与本计划一并作为历史证据保存。

owner 已批准完整路线的排序、准备工作和逐阶段门禁。M0 已退出；M1 的 `DL-0007` 已 BUILT，`DL-0008` fixing。非合作 legacy provider 的进程隔离/强制终止和 crash-safe ACTIVE job ownership/reclaim 是未解决硬门，M1 不得标为完成。`DL-0010` benchmark 决策与 M2 至 M5 仍未获实现授权。

## 目标与非目标

### 产品目标

1. 从当前已完成的 `WP0-D04` 继续，按 M0 至 M5 交付一份 TOML、自检、保守调度、失败诊断、多候选执行、首批 resolver、受限页面解析、批量扩展、可解释排序、代理以及隔离的 browser / session 能力。
2. 覆盖提案中的 `WP0` 至 `WP11`、`WP3-SH` 和 backlog `DL-0001` 至 `DL-0015`，明确依赖、阶段入口和出口、验收证据、发布、回退及文档责任。
3. 复用现有 `DownloadManifest`、catalog、`MultiSourceOrchestrator`、network、validation、`AssetAcceptanceCoordinator` 和不可变 RawAsset，不建立平行状态机或下载体系。
4. 保持 SciRetriever 的权威边界止于带版本与 provenance 的 `DocumentPackageVersion`。

用户最终获得的产品形态是：选择一份严格 TOML，运行无正文自检，提交单篇或 manifest，以保守节奏自动获取文献；系统安全保存合格资产，支持恢复和分类重试，并为每个失败项给出稳定、脱敏且可操作的原因。

### 授权和状态口径

| 口径 | 含义 |
|---|---|
| `BUILT` | 实现、直接测试、适用 harness、责任文档和审查证据均已完成 |
| `in-progress` | 当前有已获授权工作正在执行；M1 的 `DL-0008` fixing |
| `next` | 已获准开始但尚未完成的切片；当前 `DL-0008` fixing，`DL-0010` 仍待单独决策 |
| `waiting` | 已排入路线，但因前置依赖或阶段门禁尚未开始 |
| `approved sequencing` | owner 批准排序和准备，不代表实现授权或当前行为 |

### 非目标

- 不在本计划中新增 ADR、schema migration、Web UI、微服务、外部工作流引擎、第二套队列或第二份策略配置源。
- 不移动、删除或把 proposal 改写成 spec、当前行为或完成记录。
- 不把 M2 至 M5、Sci-Hub、代理、translator、browser / session、机构访问或动态排序描述为已交付。
- 不扩大到反应、分子、路线、产率等 `DocumentPackageVersion` 之外的领域。
- 不以真实 provider、live URL、真实响应体、用户凭据或受限正文作为 CI 条件或 fixture。
- 不通过放宽 HTTPS、DNS、redirect、敏感 header、大小、内容验证、身份核对、不可变存储或脱敏边界提高成功数字。

## 工作包

### 阶段总览与依赖

| 阶段 | 工作包 | backlog | 阶段状态 | 实现授权 |
|---|---|---|---|---|
| M0 产品基础与可信基线 | WP0、WP5 P0、WP7 模板、WP9 M0、WP10 基础 | DL-0001 至 DL-0006 | `BUILT / EXITED` | 实现与验证完成；owner 已批准 12-request ceiling |
| M1 候选内核 | WP1、WP2，WP9 / WP10 候选接入 | DL-0007、DL-0008；DL-0010 单独决策 | `in-progress` | `DL-0007` BUILT；`DL-0008` fixing；两个 hard gate unresolved |
| M2 首批覆盖 | WP3、WP3-SH 独立候选、WP7 持续门 | DL-0009、DL-0011 | `waiting` | 仅批准排序和准备 |
| M3 页面与扩展批量 | WP4、WP5 并发扩展、WP10 完整 | DL-0013 | `waiting` | 仅批准排序和准备 |
| M4 排序与健康建议 | WP8 | DL-0015 | `waiting` | 仅批准排序和准备 |
| M5 复杂访问 | WP6、WP11、WP9 完整 | DL-0012、DL-0014 | `waiting` | 仅批准排序和准备 |

主依赖链为 `M0 -> M1 -> M2 -> M3 -> M4`，M5 还依赖 M1 至 M3 的普通路径稳定。WP7 从 M0 建立模板，此后是每一阶段的持续退出门。WP9 和 WP10 跨阶段增量完成。Sci-Hub 不随 WP3 自动获准，代理也不随 browser / session 自动获准，两者分别经过独立门禁。

### M0：产品基础与可信基线

**进入条件**：owner 已批准 M0 默认值、`DL-0001` 至 `DL-0006`、requirements / system-design 的 M0 目标态和当前计划。`WP0-D04` 已完成并形成下列当前证据。

| 工作包 | M0 交付 | 依赖 | 当前状态 |
|---|---|---|---|
| WP0 | 固定离线 fixture、稳定 reason / action、脱敏报告结构、MIME 和流边界回归 | 无 | `BUILT`，WP0-D04 与 DL-0001 至 DL-0006 完成 |
| WP5 P0 | 默认单 worker、30 秒正文启动门、批次/每日限制、pause / resume / safe stop | DL-0001、DL-0002 | `BUILT`；DL-0004 scheduler/control 与 DL-0005 统一入口完成 |
| WP7 模板 | provider 准入、健康检查、维护责任、复核和退役模板 | DL-0001 | `BUILT`；模板和 M0 amplification 报告已建立，12-request ceiling 已获 owner 批准 |
| WP9 M0 | 扩展现有严格 TOML 和无正文 preflight | DL-0001 | DL-0002 `BUILT` |
| WP10 基础 | 统一入口、只读状态/失败查询、脱敏报告和失败项重试 | DL-0001 至 DL-0004 | `BUILT` |

M0 backlog 按以下顺序执行：

1. `DL-0001`，已完成封闭 reason / action registry、稳定安全摘要、retryable 语义、诊断编号、递归脱敏和历史只读映射 primitive。
2. `DL-0002`，已完成 strict loader 的 M0 策略字段、schema/权限/路径/容量/凭据/provider readiness 和最终策略 preflight。direct URL 使用 headers-only secure HEAD；间接 provider 返回 `not_checked`，不读取或保存正文。
3. `DL-0003` 已完成：在现有 job / attempt / failure / event 上增加只读查询和统一终端、JSON、JSONL 投影，不使用 raw SQL，也不复制权威状态。
4. `DL-0004` 已完成：共享 scheduler gate 默认单 worker和 30 秒间隔；UTC daily limit 与首次 attempt 在 `BEGIN IMMEDIATE` 内原子保留；严格有界 Retry-After、PAUSED 恢复约束和 drain-current-Work stop token 已由直接测试覆盖。
5. `DL-0005` 已完成：提供单篇或 manifest 的统一 TOML-only 自动下载入口、状态、pause、resume、当前 invocation cooperative safe stop 及 terminal 失败项 durable child retry，成功资产继续复用。
6. `DL-0006` 已完成：严格 declared-length/EOF 校验、无 late acceptance deadline、有限 worker cancellation-safe cooperative drain、取消原子闭合，以及 timeout/cancel/shutdown 的 storage/task 清理回归。

#### M0 文件级执行卡

**DL-0001：稳定诊断与脱敏基线**

- 新增 `src/sciretriever/diagnostics/contracts.py`、`redaction.py` 和独立的 versioned diagnostic codec，定义封闭 `ReasonCode`、`ActionCode`、`FailureStage`、诊断 envelope 和 attempt 摘要。未知 enum、未知 codec 版本、非 canonical JSON 和缺失必需字段一律 fail closed。
- 在 `src/sciretriever/acquisition/multi_orchestrator.py`、`attempt_details.py` 和 `errors.py` 的失败写入边界接入确定性 mapper。映射优先级固定为 typed provider error、typed validation/storage/catalog error、attempt/job 终态、`unknown_failure`；异常文本不得生成 reason code。
- 新失败把脱敏 diagnostic envelope 写入现有 `failures.details_json` / event details，保留原有 category/message/retryable 兼容字段；`next_retry_at` 继续以 job 为权威。历史行只读映射，不修改表和旧 codec。
- 所有 URL、header、异常、provenance 和递归 JSON 在持久化前脱敏，输出前再次脱敏；过滤 API key、token、signature、Authorization、Cookie、email/session 值和响应体，并限制长度。完整签名 URL、原始异常和正文不得进入 catalog 或报告。
- 直接测试新增 `tests/test_diagnostics.py`、`tests/test_redaction.py`，扩展 `tests/test_acquisition_p5.py` 和 `tests/test_jobs.py`。验收必须重开 catalog 后得到相同 reason/action/diagnostic id，扫描 attempt/failure/event/provenance 和所有输出均找不到固定 secret、签名 query、正文及原始异常 marker。
- 同步 `docs/specs/requirements.md`、`docs/specs/system-design.md` 和本计划；本切片不新增 CLI、表、索引或 migration。M0 基准同时产出带版本的数值型 request-amplification 上限，owner 批准后供 M2 canary 引用。

**DL-0002：严格 TOML 与无正文 preflight**

- 扩展 `src/sciretriever/config.py` 现有 frozen dataclass 和 `_parse_acquisition()`，严格解析 M0 调度、limit 和 preflight 子表；未知字段、非法范围、非有限 timeout 和冲突设置失败。缺少新表时维持兼容默认值。
- 在 `src/sciretriever/cli/main.py` / `acquire.py` 的 runtime 创建之前增加 preflight composition；不得调用 `open_catalog_engine`、repository、AdmissionService、RawAssetStore、AcquisitionRuntime 或 admission。配置、forbidden URL、source plan、catalog 和 storage 路径只读检查，TOML bytes / mode 不变且不创建目录或文件。
- 在 `src/sciretriever/network/http.py` / `secure.py` 增加独立 headers-only response 与可选 transport protocol，不能把空 body 伪装成普通 `HttpResponse`。direct URL 可执行 HEAD 并复用 HTTPS、DNS、redirect、header 和大小策略；response 必须关闭且 `read()` 不得被调用。
- 间接 resolver 需要正文才能解析最终 URL，M0 preflight 只检查配置、凭据存在、provider capability 和 policy，状态明确为 `not_checked`，不声称最终资产可达。不得调用 provider `.acquire()`。
- 扩展 `tests/test_toml_config.py`、`tests/test_cli.py`、transport tests 和 `config.example.toml` / README。fake response 的 `read()` 一旦调用立即失败；前后 filesystem snapshot、catalog row count 和 TOML bytes/mode 必须完全一致；direct readiness 覆盖 redirect/DNS/Content-Length，间接 provider 稳定返回 `not_checked`。

**DL-0003：只读状态、失败查询与统一报告**

- 新增 `src/sciretriever/catalog/reporting.py` 作为只读 query repository，使用 `open_read_only_catalog_engine()` 和 SQLAlchemy Core `SELECT` 聚合 job/work/attempt/failure/event；不得放宽 writable `JobRepository` 或在 CLI 使用 raw SQL。
- 新增 `src/sciretriever/diagnostics/projection.py` 和 `src/sciretriever/cli/report.py`，terminal、JSON、JSONL 只格式化同一 immutable projection。投影包含 job/work/role/state、provider/stage、reason/action、retryable、job `next_retry_at`、有界 attempt 摘要、诊断编号和安全摘要。
- 历史、部分写入、未知 event 和 orphan event 必须可读；未知 diagnostic codec fail closed，不把原始 `details_json` 暴露给调用者。reason/action 的 SQL 级索引与过滤不属于 M0。
- 新增 `tests/test_catalog_reporting.py` 并扩展 `tests/test_cli.py` / `test_catalog_schema.py`：只读 engine 可查询且写入失败；过滤和排序稳定；terminal/JSON/JSONL 反序列化后语义相同；输出不含 secret、响应体、完整 URL 或原始异常。

**DL-0004：保守调度、UTC limit 与 durable 控制**

- 新增共享 `src/sciretriever/acquisition/scheduler.py`，注入 wall clock、monotonic clock、async sleep 和 stop token；统一包住新 intake、resume、due jobs 和 failed retry。默认 semaphore 为 1，下一启动时间取 30 秒全局门、host budget、有效有界 `Retry-After`、retry due、circuit、pause 和更严格 limit 的最大值。
- `src/sciretriever/acquisition/controls.py` 继续拥有 HostBudget / circuit；`ProviderAcquisitionError` 增加脱敏、有界的 Retry-After delta。缺失、负数、溢出、非整数和当前未支持的 HTTP-date 不得缩短本地等待。
- UTC daily limit 的权威证据是 `acquisition_jobs` 关联 `acquisition_attempts` 后，每个 `work_id` 在 `asset_role='primary_pdf'` 上最早的 `started_at`。同 Work retry/resume 和其它 role 不重复计数。`JobRepository` 必须提供在一次 SQLite 写事务中完成“按 UTC 日重算 distinct Work -> 检查 limit -> 首次 start_attempt”的 reservation；并发 runtime 不能分别通过同一上限。若现有 schema 无法证明该原子性，立即触发 schema 人审，不退化为进程内近似值。
- batch limit 只属于当前 invocation；跨重启从 durable attempt 记录重建 daily count 和最近 document start，不新增 scheduler state 文件。pause 复用现有 `PAUSED`；safe stop 用 process stop token 阻止新 claim、排空当前 Work 并通过 manifest replay 恢复，不把 `CANCELLED` 当作 resumable。
- 扩展 `tests/test_jobs.py`、`test_acquisition_p5.py` 和 `test_cli.py`：fake clock 启动序列为 `0,30,60`，45 秒 host budget 得 `0,45`，更晚 Retry-After 胜出；覆盖 UTC 23:59:59/00:00 rollover、重启重建、limit=1 的并发 reservation、pause/safe-stop 后不 claim 新 Work，以及所有入口都经过同一 gate。

**DL-0005：统一自动入口与失败项重试**

- 在 `src/sciretriever/cli/main.py` / `acquire.py` 建立新自动工作流，接受单篇标识符/direct URL 或 manifest、config path、状态/控制动作和输出选择；非敏感 policy 只从 TOML 来。旧 `acquire` 兼容入口保持现有 CLI-over-TOML 行为并单独测试。
- 单 provider 继续适配成 serial SourcePlan，所有路径复用 AdmissionService、MultiSourceOrchestrator、共享 scheduler 和 read-only report projection，不复制队列、状态机或 catalog 查询。
- terminal failed job 不改回 active。`JobRepository.retry_failed_job()` 保留旧 job/attempt/failure，复制 work/role/source plan 到新 job/request，并用脱敏 event 记录 `retry_of_job_id`；paused/retryable job 复用原 job，成功 Work 由 admission 短路且不得再次联网。
- 混合 manifest 验收必须证明成功 provider 始终只有一次调用，仅失败项生成新 retry job；resume/due/retry 都经过 scheduler；safe stop 后重放 manifest 只处理未完成项；terminal、JSON、JSONL 报告与 catalog 对账。

**DL-0006：流、timeout、取消与清理回归**

- 在 `src/sciretriever/network/secure.py::_read_bounded` 校验声明的 `Content-Length`：提前 EOF 必须在返回 `HttpResponse` 前失败并关闭 response，不能依赖 PDF/XML validator 偶然发现截断。
- 保持 M0 `HttpResponse.body: bytes`、ProviderContent bytes 和 `RawAssetStore.stage` 增量写入边界；只有 transport 和内容 validation 全部通过后，`MultiSourceOrchestrator` 才能调用 coordinator。没有新回归证据时不改 storage coordinator/reconciler。
- M0 继续使用 `asyncio.to_thread` 的合作式 drain 语义。测试 slow/blocked provider 必须最终响应 provider timeout；deadline 后不可 late accept，取消和 safe stop 必须 await worker/race loser、关闭 response、闭合 attempt/job，并确保每个 `.part` 都有 owning intent 或已清理。忽略 timeout 的无限阻塞 provider 留给 M1 可中断 CandidateExecutor。
- 扩展 `tests/test_discovery_transport.py`、`test_acquisition.py`、`test_acquisition_p5.py`、`test_raw_asset_store.py`、`test_asset_coordinator.py` 和 `test_asset_reconciler.py`，覆盖 short EOF、分块慢读、transport read 取消、provider 完成到 coordinator 前取消、误导性截断 payload、shutdown 后无活动 asyncio task/thread 和 staging 所有权对账。

M0 的已解决解释如下，后续实现不得重新作相反假设：

- 新产生的失败在现有允许的 durable details / event 边界持久保存稳定 `reason_code` 和 `action_code`；历史失败不迁移，通过版本化、确定性的只读映射在查询时获得 reason / action。映射未知时 fail closed 到稳定内部错误和诊断编号。
- M0 safe stop 停止领取新文献，排空当前活动文献的已启动工作，保存现有 job / attempt 状态，然后退出。恢复通过重放原 manifest 和现有幂等 admission 跳过成功项、续跑未完成项，不增加 batch-run 或 cursor schema。
- M3 只有在 manifest replay 被证明确实不足时，才可提出 durable batch-run / cursor schema；该提议必须有单独的人审、迁移、备份和回退门，不能由本计划自动授权。
- M0 timeout 的完成语义严格收窄为：deadline 后不允许 late acceptance，已启动且遵守 provider timeout 的 worker 必须 drain 并清理；M0 离线 fixture 必须在测试给定的有限时间内完成，但不对忽略 timeout 的任意同步 provider 承诺通用 wall-clock 上限。可中断 executor、底层流隔离和严格 wall-clock completion 属于 M1 CandidateExecutor 的进入契约，M0 不得把 eventual drain 冒充 hard cancellation。
- 一份 TOML 是新自动下载工作流的非敏感策略唯一来源。该入口的 CLI 只接受配置文件选择、标识符/manifest、pause、resume、stop 和输出格式等运行输入或控制动作，不暴露 provider 顺序、并发、间隔、budget、重试或其它 policy override。现有 `acquire` 命令为兼容面，暂时保持已记录的“显式 CLI 覆盖 TOML”行为；它不作为新自动工作流的配置证明。`DL-0002` 必须分别测试两条入口并在 README 标明差异；任何收敛或弃用先给出 warning、迁移期和公开契约批准，不静默改变旧命令。
- 每日限制按 UTC 自然日统计 distinct `Work` 的首次正文启动。相同 `Work` 的 retry、resume 和其它资产角色不会重复消耗每日名额，但仍受 host budget、`Retry-After`、circuit 和正文节奏约束。

**退出条件（已满足）**：`DL-0001` 至 `DL-0006` 全部完成；离线分类和报告确定；一份 TOML 可完成 headers-only preflight；默认相邻新 Work 启动不少于 30 秒；UTC daily limit、有效 `Retry-After`、pause、safe stop、manifest replay、历史映射和无 late acceptance 均有直接证据；完整 harness 和集中审查无 blocker。project owner 已在 2026-07-22 当前 conversation 批准 `m0-request-amplification-v1` 的 provider-isolated canary 上限为每个 accepted asset `12` 次 HTTP 请求。该数值关闭 M0 门，不授权 M2 canary 或实现。

### M1：候选内核

**进入条件（已满足）**：M0 已退出；requirements / system-design 已批准 runtime 与 durable candidate 字段、敏感边界、稳定 identity/cursor、CandidateAttemptDetails v2/v1 backward read、resume、ownership、compatibility、no-schema 和 no-public-impact 契约。owner 于 2026-07-22 当前 conversation 批准规范和 `DL-0007`、`DL-0008` 实现。获批设计不需要 schema 或公开契约变化；实现发现需要这些变化时必须停止并重新审批。

| 工作包 | 交付 | 依赖 | 当前状态 |
|---|---|---|---|
| WP1 | acquisition 内部 `RuntimeDownloadCandidate`、`DurableCandidateState`、去重、过期、脱敏 URL identity、resolver adapter 和严格 codec | M0 / WP0 | `BUILT`，`DL-0007` 完成 |
| WP2 | 共享 CandidateExecutor，统一 URL policy、budget、redirect、header、流读取、验证、重试、聚合和清理 | WP1 | `fixing`；两个 hard gate unresolved |
| WP9 / WP10 接入 | 仅在现有内部 details/reporting 边界接入候选状态，不增加公开配置或 enum | WP1、WP2 | `fixing`，随 `DL-0008` 重新验收 |

`DL-0007` 先按责任 spec 实现运行时与持久化候选、稳定 `dc1_` identity、`rc1:` resolver cursor、敏感边界和严格 CandidateAttemptDetails v2。`DL-0008` 再实现旧 provider single-candidate adapter 和 CandidateExecutor。`DL-0010` 只在两者完成后单独决定是否批准 benchmark 设计或现场执行；当前不授权 live benchmarking，不决定 M2 provider 顺序，也不能产生通用成功率承诺。

**退出条件（已满足）**：旧 provider 和 P5 终态保持兼容；破损或未知 codec fail closed；完整签名 URL 和凭据不进入 durable state；重启可 re-resolve 未完成候选且不重复执行终态候选；单候选兼容边界保留既有 source fallback；429 遵守有界 `Retry-After`；deadline 后不接受内容；取消和关闭后无线程、任务或 `.part` 泄漏。

### M2：首批覆盖

**进入条件**：M1 退出；每个新 resolver 完成 WP7 准入表，包含标识符、角色、认证、预算、timeout、`Retry-After`、失败映射、fixture、维护责任、复核日期和退役条件；责任 spec 批准首批名单。新增 provider 不因名称或 proposal 排位自动获得实现授权。

| 工作包 | 交付 | 依赖 | 当前状态 |
|---|---|---|---|
| WP3 | OpenAlex、Unpaywall、Crossref 等首批 resolver 返回全部合格候选，并通过共享 executor | WP2、DL-0010 决策 | `waiting` |
| WP3-SH | 显式 Sci-Hub provider、受限页面 parser、镜像级 budget / health / circuit 和 provenance | M1；独立门禁 | `waiting`，未授权实现 |
| WP7 持续门 | 所有新增或变更 provider 的准入、健康、复核和退役证据 | WP7 模板 | `waiting` |

`DL-0009` 实施获批的首批多候选 resolver。`DL-0011` 只负责 Sci-Hub 的独立准入和实施审批；即使 M2 已开始，也必须等 owner 明确批准具体排期后才能实现。

Sci-Hub 独立阶段门要求：默认关闭；仅接受用户显式配置的 HTTPS base URL；第一版只接受规范化 DOI；不得自动发现 legacy HTTP 镜像、调用 legacy `ScihubClient`、使用 `verify=False` 或直接写目标文件；页面 parser 不执行 JavaScript；页面和 PDF 候选都经过 CandidateExecutor、URL policy、redirect、大小、MIME、PDF、身份和 RawAsset 验收；挑战页稳定分类；完整 URL 和页面正文不进入文档、catalog 或报告。其 fixture 和审查与普通新 provider 准入分开记录。

**退出条件**：每个首批 resolver 至少覆盖首候选失败后成功、全候选耗尽、重复候选、无候选和敏感 query；证明增量 unique candidate yield、false acceptance 为 0、provenance 可对账；provider 运维文档完整。Sci-Hub 未获独立批准或未完成时可保持关闭且不阻塞普通 WP3 退出，但不得被计为已交付。

### M3：页面与扩展批量

**进入条件**：M2 普通 resolver 退出；已有可靠失败分布用于选择站点；translator 站点和批量吞吐目标已进入责任 spec；并发、取消、恢复、报告和任何拟议 batch schema 已完成人审。没有单独 schema 批准时继续使用 manifest replay，不创建 durable batch-run / cursor。

| 工作包 | 交付 | 依赖 | 当前状态 |
|---|---|---|---|
| WP4 | 受限 landing-page translator registry、站点 fixture、身份和附件角色过滤 | WP2、WP3 数据 | `waiting` |
| WP5 并发扩展 | 进程内有界 worker pool、共享 budget / health / circuit、失败隔离和批次报告 | M0 P0、WP2、M2 基线 | `waiting` |
| WP10 完整 | 候选摘要、分类重试、人工处理清单和最终报告 | WP2、WP4、WP5 | `waiting` |

`DL-0013` 按实际失败分布增加少量 translator，并扩展批量并发。translator 只消费大小受限的 HTML / JSON，解析获批字段，不执行任意 JavaScript；未知结构返回稳定无候选或不支持，不猜直链。批量并发默认仍为 1，只有显式配置才提高，且所有 Work 共享全局节奏和 host 控制。

**退出条件**：每个 translator 具备最小脱敏 fixture，覆盖相对 URL、重复链接、补充材料、身份错配、无 PDF、挑战页和结构变化；批量不超过 per-host 并发/速率；重复 Work 收敛；单项失败不终止批次；中断只续跑未完成项；终端与 JSON / JSONL 的分类重试和报告与 catalog 对账。任何获批的 batch schema 另附迁移与回退证据；未获批时证据必须证明 manifest replay 足够。

### M4：排序与健康建议

**进入条件**：WP2 已产生足量且分类可靠的候选 attempt；分桶、最小样本、衰减、探索下限、静态兜底、隐私边界和建议口径已进入责任 spec。数据量不足时阶段保持 waiting，不用启发式数据伪装完成。

| 工作包 | 交付 | 依赖 | 当前状态 |
|---|---|---|---|
| WP8 | provider / host / access method / profile version 分桶回放，动态排序解释、健康趋势和配置建议 | WP2、M2 / M3 足量 attempt | `waiting` |

`DL-0015` 实现可关闭、可重放的排序与建议。不得按 DOI、用户身份、凭据值或完整 URL 建立高基数分桶，建议不得自动修改 TOML、启用来源或改变速度。

**退出条件**：固定 attempt 回放逐字节产生相同排序、reason、趋势和建议；低样本候选保留探索下限；统计缺失或损坏时 fail closed 到静态顺序；关闭动态排序恢复批准的静态路径；每条建议可追溯到稳定失败分类且不泄露敏感值。

### M5：复杂访问

**进入条件**：M1 至 M3 普通 HTTPS 路径稳定；proxy 和 browser / session 分别完成设计、责任 spec 和人工安全批准。代理实施不依赖 browser 获批；browser / session 不因代理完成自动获批。

| 工作包 | 交付 | 依赖 | 当前状态 |
|---|---|---|---|
| WP11 | 共享 HTTP / HTTPS / SOCKS 代理配置、transport、自检和稳定失败分类 | WP2；browser 侧依赖 WP6 | `waiting`，未授权实现 |
| WP6 | 默认关闭的隔离 browser / session / institutional adapter | WP2 至 WP5；威胁模型和人审 | `waiting`，未授权实现 |
| WP9 完整 | 同一 TOML 的 proxy、Sci-Hub、browser / session 字段及完整自检 | WP11、WP6、获批的 WP3-SH | `waiting` |

`DL-0012` 在 M3 普通 HTTPS 路径退出且独立代理安全门通过后，实现普通下载可单独使用的共享代理。`DL-0014` 在 browser / session 威胁模型获批后接入隔离 adapter，并完成代理共享与完整配置自检。

代理安全门必须明确 DNS 解析位置、TLS 验证、redirect 复检、timeout、敏感 header、代理认证、日志脱敏和关闭回退；代理凭据不得写入 URL、catalog、报告或 fixture，代理不得绕过 CandidateExecutor、URL policy、大小或 validation。

browser / session 威胁模型必须覆盖进程隔离、cookie jar、local storage、token、人工登录、context 并发隔离、session 过期与撤销、临时和持久 profile 生命周期、捕获响应验收、取消、崩溃及关闭清理。默认配置不得启动浏览器；登录必须由用户显式发起；core / catalog 只看到非敏感 context reference 和候选结果。

**退出条件**：普通下载和 browser 使用同一获批代理选择；HTTP / HTTPS / SOCKS 离线 fixture 覆盖直连、认证、DNS、timeout 和关闭回退；browser context 互不泄露，会话过期和撤销后停止执行并给出稳定动作；临时 profile 在正常、取消和崩溃路径清理；关闭 proxy 或 browser adapter 后普通 acquisition 行为不变；完整自检仍不读取正文或输出 secret。

## 验收与验证

### 全局完成门

每个切片和阶段都必须提供：批准后的责任 spec diff、实现与直接测试、离线 fixture 验收、适用的脱敏现场报告、文档同步清单、发布开关和回退说明。proposal 只能作为设计证据，不能替代这些完成材料。

所有自动测试使用 fake transport、固定时钟、本地最小 fixture 和程序化样本。CI 不连接真实 provider，不使用真实凭据、live URL、第三方受限正文、完整页面或响应体。现场验收只在单独批准、固定 cohort、固定配置和脱敏报告下补充，不能作为 CI 通过条件或通用成功率声明。

| 阶段 | 必需验收证据 |
|---|---|
| M0 | reason / action 新失败持久化与历史读时映射；headers-only preflight；30 秒与 UTC daily limit；`Retry-After`；pause / safe stop / manifest replay；无 late acceptance、合作式 worker 有限时间 drain 和临时文件清理，不宣称任意同步 provider 的 hard cancellation |
| M1 | candidate model / codec / 脱敏；多候选 fallback；流式 deadline；混合结果聚合；re-resolve / resume；取消和 shutdown 清理 |
| M2 | 每 provider 准入表和五类 fixture；增量候选与身份验收；Sci-Hub 如获批则提供独立 parser、安全和回退证据 |
| M3 | translator 站点 fixture；共享预算的批量并发；恢复、失败隔离、分类重试和 catalog 对账；schema 若有则单独批准 |
| M4 | 固定历史回放、低样本探索、静态兜底、隐私分桶和建议可追溯性 |
| M5 | proxy threat cases；browser / session threat model；context 隔离、profile 清理、关闭回退和完整 preflight |

`WP0-D04` 已有并必须保留的验收标准：

- `Application/PDF; charset=utf-8` 经真实 acquisition 接收路径后，以 `application/pdf` 进入 AssetIntent 和 RawAsset。
- malformed type / subtype 或参数在 staging 和 catalog 写入前失败。
- record 与 SQLite 直接写入继续拒绝混合大小写或带参数 MIME。
- 不修改 catalog schema、migration 或已存数据。

其已执行的 targeted commands 为：

```text
uv run --frozen python -m unittest discover -s tests -p 'test_asset_records.py'
uv run --frozen python -m unittest discover -s tests -p 'test_acquisition.py'
uv run --frozen python -m unittest discover -s tests -p 'test_catalog_schema.py'
uv run --frozen python scripts/harness.py quick
```

每个后续切片按受影响模块增加直接测试；每阶段退出时必须执行并记录：

```text
uv run --frozen python scripts/harness.py docs
uv run --frozen python scripts/harness.py architecture
uv run --frozen python scripts/harness.py full
```

涉及网络安全、schema、migration、公开契约、不可变存储或 browser / session 的阶段，即使自动 harness 通过，也必须取得对应人工复核。没有批准证据时保持 `waiting`。

## 发布与回退

### 分阶段发布和回退

| 阶段 | rollout | rollback |
|---|---|---|
| M0 | WP0-D04 已作为兼容修复独立进入；其余按 DL-0001 至 DL-0006 依赖增量发布，保守默认开启 | 关闭新增 CLI、preflight、scheduler 或报告路径；保留资产和历史，不回写 TOML |
| M1 | 候选路径先以内部开关或显式配置只接一个 resolver，保留旧单候选 adapter | 关闭 CandidateExecutor 新路径，回到旧 adapter；保留可读旧 codec 和 attempt 证据 |
| M2 | 每个 resolver 独立 canary 和开关；连续两轮满足 local rejection=0、false acceptance=0、provenance completeness=100%，且 request amplification 不超过 M0 批准上限后才扩展；Sci-Hub 单独默认关闭 | 按 provider 关闭，不删除 attempt / failure；Sci-Hub 关闭不改变普通 source plan |
| M3 | translator 按站点独立开关；worker 默认 1，证明预算与对账后才允许显式提高 | 关闭站点 translator 或并发，继续逐项 manifest replay；不删除 batch / attempt 历史 |
| M4 | 动态排序独立开关，静态顺序始终可用 | 关闭动态排序并回到静态顺序，不删除可靠 attempt 数据 |
| M5 | proxy 和 browser / session 分别默认关闭、分别发布 | 分别关闭 adapter 并回到普通 secure transport；停止并清理临时 context，不影响既有资产 |

任何阶段回退都不得删除、覆盖或降级已接受 RawAsset、AssetIntent、attempt、failure、event 或 lineage，不得改写用户 TOML，也不得放宽 HTTPS、DNS、redirect、header、大小、身份、validation 和不可变发布边界。codec 必须保留上一获批版本的读取能力，未知新版本 fail closed。

### 文档责任

| 变化 | 同步责任 |
|---|---|
| 行为、状态、恢复、候选、排序、browser / session 设计 | `docs/specs/requirements.md`、`docs/specs/system-design.md`，必要时 `technical-architecture.md` |
| CLI、TOML、默认值、自检、代理和用户操作 | `README.md`、`config.example.toml` |
| provider、凭据生命周期、预算、健康和退役 | `docs/guides/provider-operations.md` 与 WP7 准入材料 |
| schema、migration、公开序列化或 `DocumentPackageVersion` 契约 | 先完成人审；按责任映射更新 spec，必要时另建获批 ADR / migration 计划，本计划本身不创建 |
| 活动路线、批准证据和状态 | 本计划与 `docs/planning/README.md` |

每个实现切片曾要求按[代码与文档责任映射](../../governance/code-doc-map.md)同步责任文档。计划不得反向覆盖 spec；若实现发现责任 spec 不足，先停止该阶段并完成审批和文档更新。

## 当前状态

### 已完成证据

- 产品方向、四份 proposal 分离、M0 requirements / system-design 晋级和最初执行批准已完成；本次 owner 方向把同一活动计划扩展为完整 M0 至 M5 路线。
- `WP0-D04` 已 `BUILT`：合法参数化 MIME 在 acquisition 内容边界规范化，record 与 SQLite canonical 约束未放宽，也没有 schema migration。
- `test_asset_records.py`、`test_acquisition.py` 和 `test_catalog_schema.py` 共 45 个定向测试通过，修改文件无 LSP 诊断。
- 完整 harness 最新通过：Pyright 0 错误、492 个测试通过、documentation / architecture gate 通过、wheel 构建成功。
- 上述证据证明 M0 实现与回归基线；owner 已批准 `m0-request-amplification-v1` 的 `12 requests / accepted asset` 上限，M0 已退出。该证据不证明 M1 已 BUILT，也不证明或授权 M2 至 M5。
- `DL-0001` 已 `BUILT`：新增严格 diagnostic schema version 1、封闭 reason/action/stage、确定性 typed-error/legacy 映射和递归 durable-write redaction；未新增 schema、migration、索引或 CLI。
- `test_diagnostics.py`、`test_redaction.py`、`test_jobs.py` 和 `test_acquisition_p5.py` 共 48 个定向测试通过；另有 27 个既有 `test_acquisition.py` 和 23 个 `test_asset_coordinator.py` 回归通过。重开 catalog 后 reason/action/diagnostic id 不变，固定 secret、响应体和原始异常 marker 未进入被扫描的 durable 字段。
- `DL-0004` 已 `BUILT`：新增共享 document scheduler、process stop token、atomic UTC daily primary-Work reservation、严格 delta-seconds Retry-After 和安全 PAUSED 约束；未新增 schema、migration、state file、依赖或兼容 CLI policy flag。
- `DL-0005` 已 `BUILT`：新增 TOML-only `download` 与 reusable automatic service，复用 admission/runtime/orchestrator/scheduler/report projection；manifest 重放和 failed child retry 未新增 schema、IPC、state file 或依赖。
- `test_scheduler.py`、`test_jobs.py`、`test_acquisition_p5.py` 和 `test_cli.py` 共 72 个定向测试通过；Pyright 为 0 错误/0 警告，`uv run --frozen python scripts/harness.py quick` 的 documentation、architecture、compile、harness tests 和 CLI tests 全部通过。
- `DL-0006` 已 `BUILT`：shared secure transport 严格比对声明长度和 EOF 并关闭 owned response；candidate deadline 后不 validation/accept；timeout 与取消先排空有限 provider worker；canonical cancellation transaction 原子关闭全部未完成 attempt、job 和 requests。未修改 schema、migration、依赖或 storage coordinator/reconciler 架构。
- `test_discovery_transport.py`、`test_acquisition.py`、`test_acquisition_p5.py`、`test_jobs.py`、`test_asset_coordinator.py` 和 `test_asset_reconciler.py` 共 141 个定向测试通过；Pyright 为 0 错误/0 警告。固定离线 fixture 证明无 late RawAsset、AssetIntent、Work link、无归属 `.part` 或残留 asyncio provider task；合作式 drain 只承诺有限 worker 最终完成，不承诺 hard cancellation。
- WP7 provider 准入与退役模板已建立；project owner 已在 2026-07-22 当前 conversation 批准 `m0-request-amplification-v1` 的 provider-isolated canary 上限为每个 accepted asset `12` 次 HTTP 请求。
- 同一次 owner conversation 已批准 M1 最小内部候选责任契约与 `DL-0007`、`DL-0008` 实现。契约明确不迁移 schema、不改变 `SourcePlan`、公开 provider protocol/export、`DownloadManifest`、`RawAsset`、诊断 enum 或 `DocumentPackageVersion`。
- `DL-0007` 已 `BUILT`：新增 acquisition 内部 runtime/durable candidate、稳定 `dc1_`/严格 `rc1:`、CandidateAttemptDetails v2/v1 backward read、内部 resolver protocol 与纯 re-resolution/reconciliation；未实现 CandidateExecutor、legacy adapter 或 orchestrator v2 writer。
- `test_acquisition_candidates.py` 与 `test_candidate_codec.py` 共 16 个定向测试通过；既有 P5/jobs/reporting/diagnostics 共 61 个回归测试通过；Pyright、LSP、quick、documentation 和 architecture 均通过。
- `DL-0008` 已实现内部 CandidateExecutor、resolver registry、legacy single-candidate opaque adapter、完整 v2 candidate 数组与 multi-candidate fallback；当前状态仍为 `fixing`，不得用这些有界实现证据替代 hard isolation 或 crash-safe ACTIVE ownership/reclaim 门禁。
- 本轮有界缺陷修复后，`test_candidate_executor.py`、`test_acquisition_candidates.py`、`test_candidate_codec.py`、`test_jobs.py`、`test_acquisition_p5.py`、`test_acquisition.py`、`test_discovery_transport.py` 与 `test_catalog_reporting.py` 共 156 个定向/回归测试通过；full-tree Pyright 0 错误/0 警告/0 information，quick、documentation 和 architecture 通过。按 owner 要求未运行 full harness；该证据不证明 hard isolation 或 crash-safe ACTIVE ownership/reclaim 已完成。

### 工作包状态

| 工作包 | 当前状态 |
|---|---|
| WP0 | `BUILT`；WP0-D04、DL-0001 至 DL-0006 完成；M0 已 `EXITED` |
| WP1 | `BUILT`，`DL-0007` 候选契约、codec 和恢复选择完成 |
| WP2 | `fixing`，有界缺陷修复中；hard isolation 与 ACTIVE ownership/reclaim 未解决 |
| WP3 | `waiting`，依赖 WP2、DL-0010 和 provider 准入 |
| WP3-SH | `waiting`，依赖 M1 稳定和独立 owner / 安全批准 |
| WP4 | `waiting`，依赖 WP2、WP3 数据和站点责任 spec |
| WP5 | P0 scheduler/control 与统一用户入口随 DL-0004/5 完成；M3 扩展等待 WP2 和 M2 基线 |
| WP6 | `waiting`，依赖 M1 至 M3、威胁模型和人工安全批准 |
| WP7 | `BUILT`；provider 准入/复核/退役模板和 M0 amplification 报告完成，后续作为持续阶段门 |
| WP8 | `waiting`，依赖足量可靠 candidate attempt |
| WP9 | DL-0002 M0 配置与 preflight 完成；完整部分等待 WP11 / WP6 / 获批 WP3-SH |
| WP10 | DL-0001 至 DL-0005 基础、统一入口和失败项重试完成；完整部分等待 WP2 / WP4 / WP5 |
| WP11 | `waiting`，依赖 WP2 和独立代理安全批准 |

### Backlog 状态

| Backlog | 阶段 | 当前状态 |
|---|---|---|
| DL-0001 | M0 | `BUILT`，稳定诊断与脱敏基线完成 |
| DL-0002 | M0 | `BUILT`，严格 TOML 扩展与无正文 preflight 完成 |
| DL-0003 | M0 | `BUILT`，只读状态、失败查询与统一报告完成 |
| DL-0004 | M0 | `BUILT`，保守调度、UTC limit、Retry-After 与 durable 控制基础完成 |
| DL-0005 | M0 | `BUILT`，TOML-only 自动入口、manifest replay、状态/控制和失败 child retry 完成 |
| DL-0006 | M0 | `BUILT`，严格流长度、deadline、合作式 drain、取消闭合与清理回归完成 |
| DL-0007 | M1 | `BUILT`，候选类型、identity/cursor、敏感边界、codec v2 和纯恢复选择完成 |
| DL-0008 | M1 | `fixing`，有界缺陷修复中；两个 crash-ownership hard gate unresolved |
| DL-0009 | M2 | `waiting`，依赖 DL-0008、DL-0010 和 provider 准入 |
| DL-0010 | M1 | `pending decision`，DL-0007、DL-0008 完成后另行决定 benchmark 设计/执行；当前未授权 live benchmark |
| DL-0011 | M2 | `waiting`，依赖 M1 和 Sci-Hub 独立批准 |
| DL-0012 | M5 | `waiting`，依赖 WP2、M3 普通 HTTPS 路径退出和代理安全批准 |
| DL-0013 | M3 | `waiting`，依赖 M2、站点选择和批量门 |
| DL-0014 | M5 | `waiting`，依赖 DL-0012、M1 至 M3 和 browser / session 人工批准 |
| DL-0015 | M4 | `waiting`，依赖足量可靠 attempt 和 M3 退出 |

当前 `WP0-D04`、`DL-0001` 至 `DL-0007` 与 WP7 模板为 `BUILT`，M0 已 `EXITED`。`DL-0008` fixing，M1 `in-progress`；hard isolation 与 crash-safe ACTIVE ownership/reclaim 未解决。`DL-0010` 仍是 pending decision；M2 至 M5 均未获实现授权。
