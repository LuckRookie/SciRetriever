# 验收矩阵

本矩阵由当前计划自行定义语义场景，执行时只依赖项目真相源、owner Task、直接测试和实际证据。场景名称是
稳定行为名称，不使用历史资料编号、里程碑、阶段、步骤、Block 顺序或 Task ID 命名测试。

## 验收层级

| 层级 | 内容 | 关闭要求 |
| --- | --- | --- |
| L0 | diff、目录/清单、最小复现、直接测试 | 目标文件与受保护改动清楚，失败可重现 |
| L1 | Quick、lint、format、compile/type local checks | 失败不得跳过、忽略或转 warning |
| L2 | strict 类型、fixture/golden、对象图、事务、Browser loopback、局部安装 | 证明合同、边界、数据和生命周期 |
| L3 | 全量测试、构建、真实包、支持平台与关键离线旅程 | 记录版本、数量、退出码与真实 skip |
| L4 | requirements/ADR、所有权、安全、兼容、文档和最终 diff 审查 | material change 与块退出必需 |
| L5 | 真实数据、真实外部服务、生产迁移、发布和切换 | 只在精确授权后运行 |

## 语义场景追踪

| 场景名称 | 可观察结果 | Owner Task | 直接测试路径 | 证据路径 | 当前状态 | 未运行原因 | 恢复点 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `contract-strict-input` | 未知字段、错误 null/brand/格式在副作用前稳定拒绝且不回显输入 | [MODEL-IDENTITY](01-baseline-and-contracts.md#model-identity)、[MODEL-RECORDS](01-baseline-and-contracts.md#model-records)、[MODEL-ERRORS](01-baseline-and-contracts.md#model-errors) | `packages/contracts/test/contract-validation.test.ts` | `migration/evidence/contracts/model-and-canonical.md` | Owner 已记录 Completed；最终重跑待办 | 本轮只修计划，未重跑 | `MODEL-IDENTITY` |
| `contract-canonical-bytes` | 同一 fixture 的 canonical UTF-8 bytes、SHA-256 与 cursor 防篡改逐字节一致 | [CANONICAL-JSON](01-baseline-and-contracts.md#canonical-json)、[CANONICAL-INTEGRITY](01-baseline-and-contracts.md#canonical-integrity) | `packages/contracts/test/canonical-encoding.test.ts` | `migration/evidence/contracts/model-and-canonical.md` | Owner 已记录 Completed；最终重跑待办 | 本轮只修计划，未重跑 | `CANONICAL-JSON` |
| `inventory-complete-traceability` | 每个活动 Python 能力都有 consumer、owner Task、直接测试、证据和 disposition | [INVENTORY-TRACEABILITY](01-baseline-and-contracts.md#inventory-traceability) | `tests/test_migration_inventory.py` | `migration/evidence/baseline/inventory.md` | In progress | inventory 当前缺必填追踪；本轮未改实现材料 | `INVENTORY-MODULES` |
| `runtime-supported-combination` | Browser/SQLite/PDF/文件原语和发行平台组合有实测支持或明确 unsupported | [RUNTIME-SELECTION](01-baseline-and-contracts.md#runtime-selection) | `tests/test_runtime_capabilities.py` 与各 spike 指定检查 | `migration/evidence/baseline/runtime-selection.md` | Pending | 高风险 spike 未闭环 | `BROWSER-RUNTIME-SPIKE` |
| `repository-v1-roundtrip` | v1 metadata、literature、asset、reference、analysis 和 query typed command 可无损往返 | [RUNTIME-FOUNDATION-ACCEPTANCE](02-runtime-storage-network.md#runtime-foundation-acceptance) | `apps/server/test/sqlite-v1-roundtrip.test.ts` | `migration/evidence/runtime/repository-v1-roundtrip.md` | Pending | repository Task 未完成 | `REPOSITORY-LITERATURE` |
| `repository-snapshot-consistency` | 长查询响应时单 writer 不阻塞事件循环，跨表读取来自一致快照 | [SQLITE-SNAPSHOT-CONCURRENCY](02-runtime-storage-network.md#sqlite-snapshot-concurrency) | `apps/server/test/sqlite-snapshot-concurrency.test.ts` | `migration/evidence/runtime/sqlite-snapshot-concurrency.md` | Pending | Owner Task 未完成 | `SQLITE-SNAPSHOT-CONCURRENCY` |
| `browser-single-surface` | 两客户端观看同一真实页面，服务端仅有一个 Browser/Context owner | [BROWSER-HOST](03-browser-and-acquisition.md#browser-host)、[WORKBENCH-WEB](03-browser-and-acquisition.md#workbench-web) | `apps/server/test/browser-host.test.ts`、`apps/web/test/browser-workbench.test.ts` | `migration/evidence/browser-acquisition/browser-workbench.md` | In progress | Web 前端与组合证据未完成 | `BROWSER-HOST` |
| `browser-slow-viewer` | 慢观看者丢旧帧或断开，最新画面可恢复且不阻塞 Browser/transfer | [SCREEN-STREAM](03-browser-and-acquisition.md#screen-stream) | `apps/server/test/browser-screen-stream.test.ts` | `migration/evidence/browser-acquisition/browser-screen-stream.md` | Pending | 拟新增实现/测试 | `SCREEN-SOURCE` |
| `browser-control-epoch` | takeover/release 后旧控制者与迟到模型动作在 Browser 调用计数为零 | [BROWSER-CONTROL](03-browser-and-acquisition.md#browser-control)、[EXECUTION-LOOP](03-browser-and-acquisition.md#execution-loop) | `apps/server/test/browser-control.test.ts`、`apps/server/test/execution-loop.test.ts` | `migration/evidence/browser-acquisition/browser-control.md` | In progress | server 有局部测试，Web/loop 直接测试未闭环 | `WORKBENCH-INPUT` |
| `browser-bounded-observation` | 慢页面或预算耗尽返回 `partial + loading`，不依赖 `networkidle` | [BROWSER-OBSERVATION](03-browser-and-acquisition.md#browser-observation) | `apps/server/test/browser-observation.test.ts` | `migration/evidence/browser-acquisition/browser-observation.md` | In progress | 新验收尚无当前证据 | `BROWSER-OBSERVATION` |
| `browser-event-admission` | navigation/redirect/popup/frame/resource/download/Service Worker 每个事件先经 Network admission | [BROWSER-EGRESS-INTEGRATION](03-browser-and-acquisition.md#browser-egress-integration) | `apps/server/test/browser-event-admission.test.ts` | `migration/evidence/browser-acquisition/browser-event-admission.md` | Pending | 现实现只覆盖部分入口 | `BROWSER-EGRESS-INTEGRATION` |
| `browser-closed-actions` | 未知动作、任意 URL/selector/script/file input 在浏览器调用前拒绝 | [BROWSER-ACTION-EXECUTOR](03-browser-and-acquisition.md#browser-action-executor) | `apps/server/test/browser-action-executor.test.ts` | `migration/evidence/browser-acquisition/browser-action-executor.md` | Pending | 完整封闭动作集合未实现 | `BROWSER-ACTION-EXECUTOR` |
| `browser-popup-frame-attribution` | popup/iframe/viewer transfer 只归属有 opener/ancestry/document/permit 证据的文章 | [TRANSFER-ATTRIBUTION](03-browser-and-acquisition.md#transfer-attribution) | `apps/server/test/transfer-popup-frame.test.ts` | `migration/evidence/browser-acquisition/transfer-attribution.md` | Pending | 拟新增实现/测试 | `TRANSFER-ATTRIBUTION` |
| `transfer-response-forms` | GET/POST、inline/attachment、viewer、blob/data 和延迟 download 均有准确捕获结果 | [TRANSFER-RESPONSE-FORMS](03-browser-and-acquisition.md#transfer-response-forms) | `apps/server/test/transfer-response-forms.test.ts` | `migration/evidence/browser-acquisition/transfer-response-forms.md` | Pending | 拟新增实现/测试 | `TRANSFER-DISPATCH` |
| `transfer-range-etag` | 206 分段只在长度、顺序和 validator 一致时形成完整实体 | [TRANSFER-RANGE-ETAG](03-browser-and-acquisition.md#transfer-range-etag) | `apps/server/test/transfer-range-etag.test.ts` | `migration/evidence/browser-acquisition/transfer-range-etag.md` | Pending | 拟新增实现/测试 | `TRANSFER-RANGE-ETAG` |
| `transfer-deduplication` | 重复 response/download 幂等，同 hash 合并证据，异 hash 不误合并 | [TRANSFER-DEDUPLICATION](03-browser-and-acquisition.md#transfer-deduplication) | `apps/server/test/transfer-deduplication.test.ts` | `migration/evidence/browser-acquisition/transfer-deduplication.md` | Pending | 拟新增实现/测试 | `TRANSFER-DEDUPLICATION` |
| `transfer-service-worker-attribution` | Service Worker 响应必须有 workspace/page/document/permit 证据，否则 unowned/rejected | [TRANSFER-ATTRIBUTION](03-browser-and-acquisition.md#transfer-attribution) | `apps/server/test/transfer-service-worker.test.ts` | `migration/evidence/browser-acquisition/transfer-attribution.md` | Pending | 拟新增实现/测试 | `TRANSFER-ATTRIBUTION` |
| `transfer-lifecycle-drain` | 页面/Agent/客户端结束后已开始传输在独立 deadline 内完成或明确超时 | [TRANSFER-DRAIN](03-browser-and-acquisition.md#transfer-drain) | `apps/server/test/transfer-lifecycle-drain.test.ts` | `migration/evidence/browser-acquisition/transfer-lifecycle-drain.md` | Pending | 拟新增实现/测试 | `TRANSFER-DRAIN` |
| `policy-frozen-snapshot` | 执行中配置变化不扩张 action/time/model/retry/bytes/observation/drain budget | [POLICY-CONTRACT](03-browser-and-acquisition.md#policy-contract)、[EXECUTION-POLICY](03-browser-and-acquisition.md#execution-policy) | `apps/server/test/policy-frozen-snapshot.test.ts`、`apps/server/test/execution-policy.test.ts` | `migration/evidence/browser-acquisition/policy-contract.md` | In progress | 当前 policy 只覆盖部分预算 | `POLICY-CONTRACT` |
| `policy-assistance-expiry` | assistance 过期、拒绝、takeover、release 与重连有确定终态且不重置预算 | [POLICY-ASSISTANCE](03-browser-and-acquisition.md#policy-assistance) | `apps/server/test/policy-assistance-expiry.test.ts` | `migration/evidence/browser-acquisition/policy-assistance.md` | Pending | 拟新增实现/测试 | `POLICY-ASSISTANCE` |
| `policy-private-observation` | Cookie、表单 secret、签名 URL、页面大文本不进入模型、DTO、事件或日志 | [POLICY-PRIVACY](03-browser-and-acquisition.md#policy-privacy) | `apps/server/test/browser-policy-privacy.test.ts` | `migration/evidence/browser-acquisition/policy-privacy.md` | Pending | 拟新增实现/测试 | `POLICY-PRIVACY` |
| `execution-late-result-fencing` | 人工接管、页面改变、取消或新 epoch 后模型迟到结果零执行 | [EXECUTION-LOOP](03-browser-and-acquisition.md#execution-loop) | `apps/server/test/execution-loop.test.ts` | `migration/evidence/browser-acquisition/execution-loop.md` | In progress | 指定直接测试当前不存在 | `EXECUTION-LOOP` |
| `pdf-resource-boundary` | 损坏/加密/恶意 PDF 超时或超限拒绝，可读小 PDF 不因体积/文本少误拒 | [PDF-ACCEPTANCE](03-browser-and-acquisition.md#pdf-acceptance) | `apps/server/test/pdf-acceptance.test.ts` | `migration/evidence/browser-acquisition/pdf-acceptance.md` | In progress | PDF 引擎 spike 与资源故障证据未闭环 | `PDF-ENGINE-SPIKE` |
| `pdf-text-evidence-boundary` | 文本证据提取有界，无文本是无证据且不承担内容解析 | [PDF-TEXT-EVIDENCE](03-browser-and-acquisition.md#pdf-text-evidence) | `apps/server/test/pdf-text-evidence.test.ts` | `migration/evidence/browser-acquisition/pdf-text-evidence.md` | Pending | 拟新增实现/测试 | `PDF-TEXT-EVIDENCE` |
| `identity-three-way-verdict` | identity 与 version 分别返回 accepted/rejected/uncertain 并保留证据 | [IDENTITY-VERDICT](03-browser-and-acquisition.md#identity-verdict)、[VERSION-VERDICT](03-browser-and-acquisition.md#version-verdict) | `apps/server/test/identity-verdict.test.ts`、`apps/server/test/version-verdict.test.ts` | `migration/evidence/browser-acquisition/version-verdict.md` | In progress | version 独立裁决未完成 | `IDENTITY-VERDICT` |
| `candidate-durable-handoff` | Candidate 在页面/截图/Agent/客户端结束后存活，同 receipt 重放幂等 | [CANDIDATE-PUBLICATION](03-browser-and-acquisition.md#candidate-publication) | `apps/server/test/candidate-publication.test.ts` | `migration/evidence/browser-acquisition/candidate-publication.md` | Pending | transfer 与 publication 前置未完成 | `CANDIDATE-PUBLICATION` |
| `literature-asset-owner` | 只有 Literature owner 能从已确认 Candidate 写正式 Asset/LiteratureAsset/current facts | [LITERATURE-ASSET-PUBLICATION](04-business-and-service.md#literature-asset-publication) | `apps/server/test/literature-asset-publication.test.ts` | `migration/evidence/business-service/literature-asset-publication.md` | Pending | Block 04 未开始 | `LIT-IDENTITY` |
| `metadata-provider-parity` | 11 个 adapter 各自在同一合成输入上保持记录、分页、失败和 provenance 语义 | [META-DISPATCH](04-business-and-service.md#meta-dispatch) | 各 `*-provider.test.ts` 与 `apps/server/test/metadata-dispatch.test.ts` | `migration/evidence/business-service/metadata-dispatch.md` | Pending | Block 04 未开始 | `META-ARXIV` |
| `business-application-parity` | Discovery、导入导出、Parsing、Analysis、Query、配置和 CLI 从同一 Application 可调用 | [ENTRY-APPLICATION](04-business-and-service.md#entry-application) | `apps/server/test/application-api.test.ts` 与各业务行为测试 | `migration/evidence/business-service/application-api.md` | Pending | Block 04 未开始 | `DISCOVERY-ENTRY` |
| `python-regression-gates` | Python Quick/Full 在当前工作树通过 strict 类型、全部测试、wheel 构建与内容核对 | [PYTHON-QUALITY-GATES](06-verification-and-handoff.md#python-quality-gates) | `scripts/harness.py quick`、`scripts/harness.py full` | `migration/evidence/final/python-quality-gates.md` | Pending | 本轮只修计划，未运行 Python Harness | `PYTHON-QUALITY-GATES` |
| `execution-restart-recovery` | running 进程崩溃后以 lease/receipt/ACK 收敛且不重放点击、POST、模型或发布 | [EXECUTION-RECOVERY](05-persistent-service-and-recovery.md#execution-recovery) | `apps/server/test/execution-restart-recovery.test.ts` | `migration/evidence/persistent-service/execution-recovery.md` | Pending | Block 05 未开始 | `EXECUTION-SCHEMA` |
| `service-authentication` | 未认证、过期、伪造和跨 workspace 请求在业务/Browser 调用前拒绝 | [SERVICE-AUTHENTICATION](05-persistent-service-and-recovery.md#service-authentication) | `apps/server/test/service-authentication.test.ts` | `migration/evidence/persistent-service/service-authentication.md` | Pending | Block 05 未开始 | `SERVICE-AUTHENTICATION` |
| `service-stream-backpressure` | 事件可按 cursor 恢复，画面丢旧帧，慢消费者不阻塞服务或无界增长 | [SERVICE-EVENT-STREAM](05-persistent-service-and-recovery.md#service-event-stream)、[SERVICE-SCREEN-STREAM](05-persistent-service-and-recovery.md#service-screen-stream) | `apps/server/test/service-event-stream.test.ts`、`apps/server/test/service-screen-stream.test.ts` | `migration/evidence/persistent-service/service-event-stream.md` | Pending | Block 05 未开始 | `SERVICE-EVENT-STREAM` |
| `offline-install-journey` | 实际包在临时 home 完成配置、服务、Browser、Candidate、Literature、查询、导出和恢复 | [OFFLINE-JOURNEY](06-verification-and-handoff.md#offline-journey) | `apps/server/test/offline-release-journey.test.ts` | `migration/evidence/final/offline-journey.md` | Pending | 前五块未退出 | `TS-QUALITY-GATES` |
| `clean-environment-validation` | 无源码、Python 环境、已有配置/DB/Profile/cache 时实际包仍可首次启动 | [CLEAN-ENVIRONMENT-JOURNEY](06-verification-and-handoff.md#clean-environment-journey) | `apps/server/test/clean-environment-journey.test.ts` | `migration/evidence/final/clean-environment-journey.md` | Pending | 包与平台安装未完成 | `PACKAGE-BUILD` |
| `data-profile-rollback` | 合成数据、配置和 Profile 可按精确边界备份/迁移/回滚且不覆盖源 | [RECOVERY-DRILL](06-verification-and-handoff.md#recovery-drill) | `apps/server/test/recovery-drill.test.ts` | `migration/evidence/final/recovery-drill.md` | Pending | Block 06 未开始 | `DATA-BACKUP-DRILL` |
| `security-boundary-validation` | Network、credential、path、PDF、Browser、auth、log、DTO 和 package 攻击面有正反例 | [SECURITY-VALIDATION](06-verification-and-handoff.md#security-validation) | `apps/server/test/security-boundaries.test.ts` | `migration/evidence/final/security-validation.md` | Pending | Block 06 未开始 | `SECURITY-VALIDATION` |
| `live-site-validation-status` | 每类现场验证都有 `not-authorized/not-run/passed/failed` 和范围限制 | [LIVE-SITE-STATUS](06-verification-and-handoff.md#live-site-status) | 授权记录、脱敏执行记录或零外部访问证明 | `migration/evidence/final/live-site-status.md` | Pending | 当前没有真实外部访问授权 | `LIVE-SITE-STATUS` |

## 固定命令

Python 基线与交付门禁：

```bash
uv sync --locked --dev
uv run --frozen python -m unittest discover -s tests -p 'test_<name>.py'
uv run --frozen python scripts/harness.py quick
uv run --frozen python scripts/harness.py full
```

TypeScript 迁移入口：

```bash
pnpm install --frozen-lockfile
pnpm quick
pnpm test
pnpm full
```

单项 TS 直接测试使用 `pnpm exec vitest run <实际行为测试路径>`。拟新增路径在实现前可以不存在；不存在时状态保持
Pending，不能执行替代测试后宣称通过。Browser 测试必须显式使用受审查本地 binary 且只访问 loopback fixture。

本轮只修文档，不运行以上 TS/Python 命令。文档验收检查 diff、链接、Task/台账、依赖、状态、测试命名和 Markdown。

## 证据格式

每项证据至少包含：baseline commit、工作树范围、命令原文、工具与 runtime 版本、平台、输入/fixture、退出码、
通过/失败/跳过数量、产物或数据 hash、外部访问状态、残余限制和恢复点。不得包含 secret、Cookie、签名 URL、
个人配置、真实响应、用户资产、Profile、临时数据库或构建目录。

Task 完成前必须回答：生产者/消费者是否一致？失败是否可见？数据是否可恢复？secret 是否可达？是否出现第二 owner
或双写？直接测试是否保护用户结果和错误路径？安装验证是否消费真实 package？文档是否区分目标与当前行为？

## 发布门

只有 189 个 Task、全部矩阵场景、前五块 R3/R4、Block 06 R5、TS/Python Full、支持平台真实安装、恢复/安全和
readiness 报告全部闭合，才可形成具体切换授权包。用户授权只允许执行所列精确动作；真实站点效果、生产迁移、
发布和 Python 退役不能由离线 fixture、计划 checkbox 或授权本身代替验证。
