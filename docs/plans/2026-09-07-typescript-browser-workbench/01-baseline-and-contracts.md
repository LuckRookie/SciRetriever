# M0｜全量 TypeScript 迁移的基线、合同与高风险验证

## 目标与原始依据

本文件恢复原始 M0 的 **T001–T008**，为整个 M0–M6 / T001–T064 全量迁移建立实施基线。最终目标是全部活动 Python 产品能力由 TypeScript 实现，发布包由 TypeScript/Node 运行，不依赖 Python 解释器，也不通过 Python RPC 运行业务。Browser 工作台是其中一个能力切片；配置、全部 Provider、文献业务、CLI、解析、分析、持久任务、恢复和安装发行均在全量计划内。

原始依据只使用归档的 [`original-bundle`](../../archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/)：

- [01｜代码盘点](../../archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/01-codebase-audit.md)：活动文件、公开入口和测试的完整映射。
- [05｜TS 迁移](../../archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/05-ts-migration.md)、[06｜存储升级](../../archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/06-storage-upgrade.md)：稳定行为、v1 字节与数据兼容。
- [07｜路线](../../archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/07-roadmap.md)和 [tasks.json](../../archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/tasks.json)：固定任务、依赖、交付物和退出条件。
- [08｜验收矩阵](../../archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/08-tests-release.md)、[09｜合同与 ADR 草案](../../archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/09-contracts-adr.md)：验收 ID、合同变更与决策主题。
- [10｜来源](../../archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/10-sources.md)、[11｜实施交接](../../archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/11-agent-handoff.md)、[sources.json](../../archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/sources.json)和 [validation-report.json](../../archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/validation-report.json)：原始证据范围、实施纪律、机器来源清单和原始计划包自检结果。

原始材料是计划基线；[产品需求](../../architecture/requirements.md)和 [Accepted ADR](../../architecture/decisions/README.md)仍约束实现。任务状态统一维护在[全量迁移路线](full-migration-roadmap.md#m0冻结基线与高风险验证)，本文件说明执行与验收，不维护第二套完成状态。当前 M0 基线、依赖、安全和性能观察项已完成，真实外部验证仍按授权边界记录。

## 全量盘点范围

T001 从原始 commit `e1a33d5986f654f2692d7619dd58448944ec3463` 与当前工作树分别记录基线及增量，不能只筛选 Browser 调用链。盘点至少覆盖：

| 范围 | 必须追踪的行为与入口 |
| --- | --- |
| Entry / CLI / Configuration | 全部公开 API、CLI leaves、参数、报告、退出码、配置与 TUI、凭据、实际 parser 和配置示例 |
| Metadata / Discovery / Import | 全部注册 Provider、Auto/Custom、search/lookup/citations、分页和逐来源限额、主题/引用发现、书目编解码与导入 |
| Literature / Acquisition | 身份、版本、来源 observation、引用 support、current facts；Public/API/Browser、手动 PDF、候选验收、资产发布与耗尽语义 |
| Parsing / Analysis / Agents | 外部 MinerU 协议与产物、两阶段分析和 lineage、三种模型协议、流式/非流式、图像/tool/schema、预算与取消 |
| 基础设施与交付 | Model、Network、Storage、Logging、Bootstrap、Browser；所有活动测试及用例、scripts、CI、打包元数据和安装入口 |

2026-09-10 的[现有盘点](../../../migration/evidence/baseline/inventory.md)记录了 242 个 Python 源模块（原始 235 个 + 7 个迁移 bridge）、161 个 Python 测试文件、8 个公开 `api.py` 入口、23 个 CLI 路径、11 个 Metadata Provider、7 个 Acquisition source 和 3 个授权 Acquisition provider。这些是盘点快照，不是完成数量或固定上限；执行时必须追踪后续增量。161 个测试文件也不能代替逐用例的验收映射。

每个条目需表达原始要求的 `currentPath / publicSymbols / consumers / tests / targetPath / disposition / taskId / evidence`。复用现有 `migration/inventory.json` 的字段结构，补齐缺项并说明字段对应，不另建清单系统。处置应能区分 `port`、`redesign`、`retire-approved`、`historical-nonruntime`；现有 `migrate` 标记需细化为迁移或重设计，不能作为已退役证据。每个旧验收用例要有 TS 验收映射或明确变更理由，不要求新旧文件一一对应，也不用文件减少或测试数量相等证明迁移完成。

## 原始 M0 任务

下表保留原始任务 ID、标题、依赖与验收 ID。产物路径是原计划落点；已有等价实现、fixture 或证据时直接复用并记录对应关系，不为满足目录形式重复建立 spike 工程。

| ID | 原始任务 | 依赖 | 交付物与验收重点 | 验收 ID |
| --- | --- | --- | --- | --- |
| T001 | 冻结仓库、实际入口与逐文件迁移盘点 | — | `migration/inventory.json`、`migration/baseline/`：commit/工作树记录、全部活动文件及公开符号、消费者、Provider、CLI、配置和测试映射；历史目录独立标识，每项有去向；旧离线 Harness 已有结果、失败或未运行原因如实记录，不访问用户数据或真实站点 | C03、C06、E07 |
| T002 | 形成新需求和六项ADR草案及变更清单 | T001 | 需求/ADR 变更表与 `migration/intentional-changes.json`：覆盖全 TS、Browser 工作区、冻结策略、持久任务、catalog v2、原生访问六个主题；逐项说明旧合同保留或修改、适用 Accepted 决策和待决差异；运行状态不替代文献事实，草案不标为 Accepted | E07 |
| T003 | 验证并固定TS浏览器与投屏依赖组合 | T001 | `spikes/browser-compat/`、`migration/runtime-matrix.json` 或现有等价证据：wrapper/Playwright/Chromium/Node/平台组合、persistent/download/screencast 探针、许可与二进制分发检查；真实 Chromium 只访问本地 fixture，显式处理原始 Playwright 1.55 限制，未验证组合不得标支持 | B08、D01 |
| T004 | 验证文件原语、单写锁与原生出口安全可实现性 | T001 | `spikes/platform-safety/`、`migration/native-capabilities.json` 或现有等价证据：锁、no-follow、no-clobber、fsync、CONNECT 与 DNS 绑定验证；覆盖路径替换、崩溃释放，区分隧道预算与逐响应字节预算；Node 能力缺口必须有窄适配器或明确平台限制，不能降低保证 | N01、N06、S04 |
| T005 | 验证TS PDF结构检查与身份文本提取引擎 | T001 | `spikes/pdf-inspector/`、`tests/fixtures/pdf/` 或现有等价证据：引擎评估及主文/引用/补充/无文本/加密/大文件样本；区分结构校验与文本提取质量，独立执行可终止，最终用户无需另装 Python 或编译工具 | D09、D10、D11、D12 |
| T006 | 导出v1数据库、Model与哈希的离线goldens | T001 | `tests/fixtures/compat-v1/`、`migration/oracle-manifest.json`：合成 v1 库、DDL 原始字节/指纹、Model 正负例、canonical 字节、查询、关系及资产 manifest；固定时钟与 ID，覆盖 Unicode/时间/null/数字边界，先比较字节再比较 hash，不用用户库或修改 golden 掩盖差异 | C01、C02、S01 |
| T007 | 冻结威胁模型、性能观察项与平台发行目标 | T001、T003、T004、T005 | `migration/threat-model.md`、`migration/release-matrix.json` 或现有等价证据：单操作者、控制面、凭据、外部页面威胁模型及平台/性能/配额语义；单端口仍有认证和 Origin/CSRF 保护，列明 Linux 显示依赖，不使用浮动 binary 或隐式外网测试 | N03、N04、E04 |
| T008 | 关闭关键spike并接受实施基线 | T002、T003、T004、T005、T006、T007 | `migration/m0-decision-record.md`、`migration/runtime-selection.json` 或现有等价记录：选型、ADR 状态、阻塞/不支持组合及首个切片范围；每项关键能力有可重现结果和明确结论，区分实施文档与需授权的变更，未通过 spike 不进入生产替换 | B08、S04、E07 |

### T002 的合同处理

六个主题分别核对即可，已有 Accepted ADR 覆盖的内容通过链接复用，不机械新增六份 ADR。变更表要记录原合同、目标合同、受影响的生产者/消费者、持久化与兼容性、任务、验收以及实际决策状态。

原始草案建议扩大 Agent 动作并改变进程内任务限制，这两项必须显式处理：当前 [ADR 0023](../../architecture/decisions/0023-generic-browser-agent-executor.md)与 [ADR 0024](../../architecture/decisions/0024-typescript-browser-workbench-migration.md)保留六种封闭 Agent 动作，人工键盘/文本输入使用独立 operator command；不能直接把归档中的通用动作草案写入模型权限。持久 job/attempt/candidate 和 v2 则按全量 M5 范围，在合成副本中验证，运行事实与 Literature current facts 保持隔离。实际公开合同变更依照仓库规则处理，计划恢复本身不代表合同已获接受。

继续冻结 MetaLiterature/Literature 身份、来源 observation、版本与引用 support、唯一 current metadata/content、primary-pdf、provenance/lineage、固定 home、外部 MinerU、v1 schema 和不可变资产语义。Configuration、Network、Browser、Acquisition、Literature、Storage、Agents 与 Application 的单一 owner 使用 ADR 0024 的责任表。

### T003–T008 的实现约束

保留模块化单体、SQLite Catalog、不可变 ArtifactStore 和单一 Application。当前开发/CI 基线为 Node 22.19.0，最终发行组合由 T003/T057 的证据确定；复用现有 `node:sqlite`、鉴权 HTTP + SSE/JPEG 和 command 输入，只有相关验收证明缺口才更换 binding 或增加 WebSocket。T004 只有证明 Node 文件原语不足时才引入窄 native 适配器。

M5 只保存恢复所需的 job/target/attempt/policy、关键事件、Candidate 和 intervention，不扩展为完整 event sourcing，也不引入 Redis、微服务、分布式调度、多租户或多 Agent 平台。性能只记录原计划要求的观察项、测量方法和实际结果，不自行建立额外阈值门禁。

## 已有首阶段证据如何复用

下表保留旧 `01-01–01-07` 编号以承接既有文档引用；这些编号仅为历史证据索引，当前执行与关闭使用 T001–T008。已有切片证据不能直接证明对应原始任务全部完成。

| 旧索引 | 现有证据 | 原始任务归属与仍需核对的范围 |
| --- | --- | --- |
| 01-01 | [目标旅程](README.md)、[支持矩阵](../../../migration/evidence/final/support-matrix.md) | T003/T007/T008：开发平台与首阶段安装证据可复用；最终发行平台、依赖、许可和安装边界仍需冻结 |
| 01-02 | [inventory 记录](../../../migration/evidence/baseline/inventory.md)、[模块迁移映射](migration-map.md) | T001：保留 242 模块等盘点快照，补齐消费者、直接测试及用例、任务和证据映射 |
| 01-03 | [v1 Model/canonical 记录](../../../migration/evidence/contracts/model-and-canonical.md) | T002/T006，并交接 T010/T011：已有 DTO/schema 和 canonical 切片可复用；全业务 Model 正负例与差分仍待覆盖 |
| 01-04 | [Observation 记录](../../../migration/evidence/browser-acquisition/browser-observation.md)、[会话 API 记录](../../../migration/evidence/browser-acquisition/workbench-session-api.md) | T002，并交接 T021/T024/T026：保留 revision/viewport_version 与 document_generation/viewport_revision/control_epoch/frame_seq 的映射、唯一生产者、递增条件和消费者，不直接改名破坏合同 |
| 01-05 | [ADR 0024 owner 表](../../architecture/decisions/0024-typescript-browser-workbench-migration.md) | T002/T008，并交接 T018：复用唯一 TS owner；Application 对象图已闭合，Python 仅作历史 oracle |
| 01-06 | [fixture 记录](../../../migration/evidence/baseline/fixture-integrity.md)、[Browser→MinerU→Analysis 联合旅程](../../../migration/evidence/runtime/browser-mineru-analysis-journey.md) | T006：复用合成字节与 loopback 输入；补齐 v1 查询、关系、资产 manifest 和边界样本 |
| 01-07 | [Accepted 合同记录](../../../migration/evidence/baseline/migration-contracts.md) | T002/T008：复用已有决策，补齐六主题变更表、关键 spike 结论与统一实施基线 |

## 执行顺序与验证

先补齐 T001 的完整映射与工作树增量记录；满足依赖后推进 T002–T006，T007 汇总平台和能力验证，最后由 T008 关闭实施基线。已有 TS 切片可继续提供证据，但不能据此省略未完成依赖。每份 spike 记录保留复现入口、环境/依赖、预期与实际结果、限制、证据路径和影响任务即可。

依据 owner 于 2026-09-10 的决定及 [HARNESS.md](../../../HARNESS.md)，后续代码验证使用相关 Vitest、`pnpm quick`、`pnpm full`；不默认运行 Python Quick、Python Full 或全量 unittest。T001 的旧 Harness 结果保留已有记录，未运行项标记 `not-run-by-owner-decision`，不得写成通过，也不为关闭 M0 重启 Python 全量测试。T006 复用已冻结的离线 goldens，缺失基线如实登记，不能由 TS 实现自生成预期后宣称完成兼容差分。

文档修改检查 diff、本地链接、术语、命令事实和 Markdown 结构。行为测试使用 fake、合成 fixture 或 loopback；T003 使用实际 Chromium 访问本地 fixture。真实 Provider、站点、MinerU、LLM、个人配置、凭据、Profile、用户库和语料不作为默认验证输入。

## M0 退出门与后续交接

- T001 覆盖全部活动文件、入口、adapter、配置、测试及用例，每项有迁移去向或明确处置依据；新增 bridge 也有后续迁移与退役任务。
- T002 的六主题合同差异、Accepted/Proposed 状态和 intentional changes 清楚，稳定数据语义与单一 owner 没有隐式改变。
- T003–T007 的依赖组合、文件/网络原语、PDF 引擎、v1 goldens、威胁模型和发行目标有可重现结果；未解决能力有明确阻断范围，不能通过标记“不支持”省略必需业务能力。
- T008 汇总并接受统一实施基线，所有原始 M0 验收项都有结果或允许不运行的明确依据；计划、证据和全量路线状态一致。

M0 关闭表示全量迁移基线成立；M1–M6 的任务、证据和剩余授权边界见全量路线。最终 TS 包不保留 Python 业务回退；真实生产切换和用户数据迁移仍按 T063/T064 的授权流程执行，历史 Python 源码按 T061 报告保留为非运行材料。
