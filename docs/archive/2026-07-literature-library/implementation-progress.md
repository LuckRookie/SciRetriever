# SciRetriever 实施进度

- 最后核对：2026-07-26
- 进度依据：当时的 OMO 执行计划与下列代码、测试和发布证据；执行计划不作为项目文档保留
- 理想产品：[需求规格](../../architecture/requirements.md)、[系统设计](../../architecture/system-design.md)、[技术架构](../../architecture/technical-architecture.md)
- 当前用户行为：[README](../../../README.md)、`sciretriever --help`

## 1. 文档职责

本文是唯一的活动实施进度台账，记录代码相对三份理想产品规格已经覆盖什么、尚缺什么以及有哪些可验证证据。它可以随实现变化频繁更新，但不定义产品行为、不批准新范围、不规定工作包顺序，也不替代 README 的当前用户说明。

权威边界如下：

| 问题 | 权威来源 |
|---|---|
| 理想产品必须是什么 | requirements、system design、technical architecture |
| 为什么采用这些边界 | accepted ADR |
| 按什么顺序实施 | 当时的 OMO 执行计划 |
| 当前用户能运行什么 | README、CLI help 和代码 |
| 已实现多少、差距在哪里 | 本文 |

每项状态必须带核对日期和代码、测试、命令或用户文档证据。没有证据时只能标为“未核对”，不能根据计划或规格推断已经实现。

## 2. 总体状态

截至 2026-07-26，SciRetriever 已具备 Work-centered catalog、多来源 metadata 入库、本地 library 读取、WorkVersion selector、三层全文获取、安全网络边界、不可变保存、MinerU PDF 解析、十节 current analysis、包含 current analysis 的不可变 `DocumentPackageVersion`、从 catalog 事实派生四阶段的共享 completion 管线，以及 WP6 的引用扩展、人工整理、两类导出、统一失败查询、统一计数和严格配置检查。WP0-WP5 已完成，WP6 代码能力与发布文档已覆盖。

当前主交接是：

```text
SearchSpec
  -> discovery providers
  -> clean / deduplicate / merge
  -> shared completion: METADATA_PENDING -> ASSET_PENDING
  -> provider race / validation / immutable RawAsset
  -> ANALYSIS_PENDING -> MinerU / evidence / atomic current promotion
  -> COMPLETE
  -> DocumentPackageVersion processing snapshot
```

当前用户可以观察 canonical search JSON、library JSON/JSONL、manifest、逐层 expansion JSON、脱敏 failure history，以及共享 completion batch 驱动的 `search`、`download`、`analyze` 和 primary-PDF import 结果。WorkVersion 是书目与内容所有权基础；completion 只决定下一缺失阶段，不保存状态或复制 WP2-WP4 写入逻辑。人工整理、reading/package export、citation expansion、`failures` 和 offline/runtime `config check` 均已进入当前 CLI。

## 3. 当前命令与配置

当前命令树由 [README](../../../README.md) 和 `sciretriever --help` 定义：

```text
discover
search
expand
download
analyze
failures
library show|search|references|cited-by|export|review|merge-work|regroup-version|preferred|metadata|tag|author|audit|undo
preflight
config check
catalog create|import-asset
package
```

严格配置 parser 接受 `schema_version = 1`、根级 `document_start_interval_seconds`，以及 `paths`、`credentials`、`discovery`、`search`、`acquisition`、`analysis`、`package` 和 `expansion`。`search.level` 接受 `metadata`、`download`、`analyze`；`[analysis.mineru]` 和 `[analysis.llm]` 使用严格 endpoint、运行时 credential-env 和资源上限；`[expansion]` 使用封闭 direction/provider 集合和有界 provider paging。expansion 和既有命令的 CLI 显式值只覆盖当前 invocation；未接入命令 runtime 的整理或导出配置字段由 parser fail closed。

证据：`README.md`、`config.example.toml`、`src/sciretriever/config.py`、`src/sciretriever/config_loader.py`、`src/sciretriever/config_models.py`、`src/sciretriever/config_parsing/`、`src/sciretriever/cli/parser.py`、`src/sciretriever/cli/main.py`、`tests/test_config_check_wp6.py`、`tests/test_documentation_wp6.py`。最后核对：2026-07-26。

## 4. 当前模块事实

| 当前模块 | 已验证职责 |
|---|---|
| `core/` | 中性契约、标识符、枚举、hash、`DocumentPackageVersion` |
| `catalog/` | Work/WorkVersion identity、metadata observations、authorship、registries/aliases、tags、version relations/references、WorkVersion assets、acquisition diagnostics、processing 和 package snapshots |
| `discovery/` | provider 查询、清洗、去重、确定性合并、并发 metadata catalog ingestion、只读 catalog 比对、确定性标签和 manifest writer |
| `integrations/` | 外部 provider client 和中性 DTO |
| `integrations/graph.py` | OpenAlex/Semantic Scholar graph capability、direction/depth/page contract 和 provider-neutral citation candidates |
| `network/` | HTTPS、DNS pinning、redirect、header、有限读取和 timeout |
| `acquisition/` | WorkVersion target/resolver、provider 有界竞速、provider 内去重候选顺序执行、translator/browser tier、身份/内容校验、脱敏诊断和不可变验收调用 |
| `storage/` | Raw/Derived staging、不可变 create-if-absent 发布、hash 验证和 reconciliation |
| `normalization/` | PDF/XML/HTML 到 sections、tables、references、source map 和 evidence |
| `analysis/` | PDF-backed 十节分析、严格 evidence、current replacement 和前台 backfill |
| `completion/` | DOI/WorkVersion targets、四阶段事实驱动管线、稳定 batch、中断后缀、force analysis 和正交 optional assets |
| `diagnostics/` | metadata/acquisition/analysis/expansion 的稳定、脱敏 failure 投影与 latest/all 查询语义 |
| `packaging/` | quality gate 与 `DocumentPackageVersion` 处理快照发布 |
| `cli/` | invocation composition root；统一装配 completion runtime，命令只选择 target、stop、force 或 optional operation |

当前 `work_versions` 保存书目版本身份和 metadata，`works` 只保存作品身份、状态和首选版本指针；`package_versions` 保存处理/导出快照，不是书目 `WorkVersion`。Catalog 已覆盖 metadata observations、Author/Authorship、Publisher/Venue registry 与 alias、canonical tag 与 manual/generated links、version relations/assets/references，以及原子替换的 single current analysis。

证据：`src/sciretriever/`、`docs/development/documentation-map.md`。最后核对：2026-07-24。

## 5. 能力覆盖与差距

| 能力 | 实施状态 | 当前证据 | 对应计划 |
|---|---|---|---|
| Work identity | 已覆盖 WP1 | Work identity、identifier aliases、preferred WorkVersion ranking/manual override | WP1 |
| 书目 WorkVersion | 已覆盖 WP1 | `work_versions` 与 processing `package_versions` 分离；内容运行时归属 WorkVersion | WP1 |
| MetadataObservation | 已覆盖 WP2 | provider record 幂等 observation、provenance、precedence/fill-missing 与 canonical reprojection | WP1-WP2 |
| Author/Authorship | 已覆盖 WP1 | typed author/authorship repository，ORCID 保守复用 | WP1 |
| Publisher/Venue registries | 已覆盖 WP1 | typed registry 与 alias repository | WP1-WP2 |
| Canonical tags | 已覆盖 WP1 基础 | canonical tag/alias、manual Work tag、generated WorkVersion tag 分离 | WP1/WP4 |
| Metadata discovery | 已覆盖 WP2 | 多 provider 有界并发、独立 timeout、确定性合并、OA status、observations 和 canonical WorkVersion 入库；manifest 入口仍保持只读 | WP2 |
| Local library search/curation | WP2 读取面和 WP6 人工整理 CLI 已覆盖 | exact lookup、keyword/filters、references/cited-by、safe JSON/JSONL export；显式 review/merge/regroup/preferred/metadata/tag/author、audit 和 undo | WP2/WP6 |
| Primary PDF acquisition | 已覆盖 WP3 | 显式 WorkVersion selectors、first-tier provider race、每来源 8 个去重候选顺序回退、accepted/missing/reused/interrupted 输出 | WP3 |
| Sci-Hub / translator / browser | 已覆盖 WP3 | Sci-Hub first-tier 显式 opt-in；restricted translator second-tier；默认关闭的 profile-copy browser third-tier；全部使用离线 fixture | WP3 |
| Article identity validation | 已覆盖 WP3 | PDF/XML/HTML 的 DOI 或保守标题/佐证确认；mismatch/unconfirmed 均 reject 且不进入 RawAsset | WP3 |
| Immutable RawAsset | 已覆盖 WP3 | validation、hash、create-if-absent、同角色并发收敛、reconciliation | WP3 |
| PDF normalization | 已覆盖 WP4 | MinerU 3.4.4 connector、async attempt、hostile ZIP admission、source map 和 PDF locators | WP4 |
| Current LLM analysis | 已覆盖 WP4 | 十个稳定 section、严格 evidence、OpenAI-compatible provider 和脱敏 provenance | WP4 |
| Atomic current replacement | 已覆盖 WP4 | single current revision、force convergence、失败保留旧 current、immutable package snapshot | WP4 |
| Global completion pipeline | 已覆盖 WP5 | 四阶段由 catalog 事实派生；DOI/WorkVersion/accepted PDF/COMPLETE 入口只执行缺失后缀；无 mutable completion state | WP5 |
| Shared write entry points | 已覆盖 WP5 | search/download/analyze/primary-PDF import 共享 completion；metadata/asset/complete stops、force 与 XML/HTML 正交操作有直接 CLI 测试 | WP5 |
| Version references | 已覆盖 WP1 基础 | ordered `version_references`、目标 Work link 与 reverse citation query | WP1/WP4 |
| Reference expansion | 已覆盖 WP6 | 显式单种子、references/cited-by/both、depth-only 图边界、visited 去环、逐层 completion、branch failure 隔离和 exit 130 | WP6 |
| Failures UX | 已覆盖 WP6 | 独立只读 `failures` 按对象/stage/role/source/reason/action/retryability/outcome 和 latest/all 查询；acquisition details 显式且脱敏 | WP3/WP6 |
| Deterministic progress counts | 已覆盖 WP6 | search/download/analyze/expand 共享终态计数等式和 stop-specific aliases；PDF missing 保持 exhausted/missing | WP6 |
| Strict product config | WP2-WP6 parser 与主要 runtime 已覆盖 | schema v1 覆盖 search、acquisition、analysis、expansion 和 30 秒 document start interval；未接入 runtime 的配置字段 fail closed；offline/runtime config check 已暴露 | WP2-WP6 |
| Foreground stop/idempotent rerun | 已覆盖 WP0/WP3/WP5/WP6 | batch/expansion 保留稳定顺序和完成项，Ctrl+C 停止新工作；事实重读只执行缺失阶段，重复运行不复制 observations/assets/current/frontier | WP0/WP3/WP5/WP6 |
| 旧任务控制移除 | 已完成 | 已删除旧 `acquire`/`report`、durable task/job、pause/resume/due、retry scheduling、source-plan persistence 和 candidate checkpoint 当前运行路径 | WP0 |
| Domain pack boundary | 已批准并有基础 | `DocumentPackageVersion`、stable references、ADR 0001 | 持续约束 |

最后核对：2026-07-24。目标含义以三份规格为准，本表只说明覆盖程度。

## 6. 工作包进度

| 工作包 | 计划生命周期 | 实施进度 | 已完成证据 | 阻塞 |
|---|---|---|---|---|
| WP0 旧架构收缩 | approved | completed | fresh schema 无 durable acquisition tables；旧 `acquire`/`report` 与 task-centered modules 已删除；CLI/schema 直接测试通过 | 无 |
| WP1 文献模型 | approved | completed | direct fresh schema bootstrap、typed WP1 repositories、WorkVersion-owned runtime persistence 和 `test_catalog_wp1.py` 直接验收；完整 unittest 与 Pyright 通过 | 无 |
| WP2 搜索与本地库 | approved | completed | `test_search_wp2.py`、`test_library_wp2.py`、`test_cli_wp2.py` 覆盖并发/timeout/确定性入库、preferred/non-preferred 读取、filters、引用遍历、安全导出和 CLI/config precedence；完整 harness 511 项通过 | 无 |
| WP3 PDF 获取 | approved | completed | `test_wp3_foundation.py`、`test_download_wp3.py`、`test_cli_download_wp3.py`、`test_sci_hub_wp3.py`、`test_translator_wp3.py`、`test_browser_wp3.py`、`test_acquisition_identity_validation.py` 覆盖 selector/tier/candidate/identity/profile/中断/脱敏/不可变验收；完整 harness 522 项通过 | 无 |
| WP4 PDF 分析 | complete | completed | 严格配置、MinerU connector/admission、PDF source map、current replacement、analyze/search 与 package snapshot 离线验收 | 无 |
| WP5 全局文献信息完成管线 | approved | completed | `completion/`、catalog facts、exact DOI、四入口 cutover、真实 SQLite/storage acceptance、十个 promotion rollback failpoints、架构/删除/wheel gates；`test_completion*_wp5.py` 74 项与 Todo 8 full harness 682 项通过 | 无 |
| WP6 引用扩展与产品收口 | approved | completed | graph/reference/curation/export/diagnostics/config/count/CLI 直接测试、当前 README/config/help 同步证据和 Todo 31 发布门回执 | 无 |

`approved` 只表示当时的 OMO 执行计划获得授权，不等于代码已经实现；本归档只以代码、测试和发布记录证明完成事实。

## 7. 最近验证

### WP6 发布记录

<!-- WP6_FINAL_RELEASE_RECEIPT: TODO31_940 -->

Todo 31 最终 `full` harness 940 项通过；documentation、architecture、compile、Pyright、完整 unittest、wheel build 和 wheel contents 均退出 0。发布门还确认 `quick`、`git diff --check`、dependency/lock 无漂移、diff-scoped pure LOC、wheel/source parity、retired path absence、installed-wheel CLI 和九类离线 ultraqa。完整命令、退出码、计数、wheel digest、人工 QA、无 live-service 证明和 cleanup 记录见 `.omo/evidence/wp6/task-31.txt`。

2026-07-26 WP6 实现覆盖核对：

- graph adapter、引用解析、逐层 completion、循环去重、branch isolation 和中断结果由 `tests/test_graph_*wp6.py`、`tests/test_reference_resolution_wp6.py`、`tests/test_expansion_*wp6.py` 与 `tests/test_cli_expand*_wp6.py` 覆盖。
- review/merge/regroup/preferred/metadata/tag/author/audit/undo 与 reading/package export 由 `tests/test_*curation*wp6.py`、`tests/test_cli_curation_wp6.py`、`tests/test_*export*wp6.py` 覆盖。
- 四阶段 failures、脱敏 details、strict config offline/runtime、统一 count vocabulary 和文档/help/config snapshot 由 `tests/test_*failures_wp6.py`、`tests/test_diagnostics_wp6.py`、`tests/test_config_check_wp6.py`、`tests/test_completion_counts_wp6.py`、`tests/test_documentation_wp6.py` 覆盖。

2026-07-25 WP5 实现验收：

- `test_completion*_wp5.py` 74 项、`test_cli_completion*_wp5.py` 19 项和受影响 WP1-WP4 回归 103 项通过。
- 真实临时 SQLite/不可变存储 fixture 覆盖 DOI、provider WorkVersion、accepted PDF、COMPLETE、重启、部分失败、并发收敛和十个原子 promotion 回滚 failpoint。
- Todo 8 最终 `full` harness 682 项通过；Pyright 0 diagnostics，documentation、architecture、clean wheel/source parity 和退休 backfill module 删除检查通过。
- Todo 8 精确手工 CLI QA 使用修正后的 `1 1 2 1` metadata 投影和有效双页 PDF fixture，symlink fail-closed、首次导入、幂等 replay、安全 library view、无 selector 拒绝及临时目录清理全部 PASS；证据记录在 `.omo/evidence/wp5/manual-qa.txt` 和 `final-f2.txt`。

2026-07-24 WP4 完成验证：

- 聚焦 core package、publication、WP4.4/WP4.5 和 strict config 测试 71 项通过。
- 完整单元与验收测试：582 项通过。
- Pyright：0 errors、0 warnings、0 informations。
- `quick`、`docs`、`architecture` 和 `full` harness 全部通过；wheel build 与 wheel contents 通过。

2026-07-24 WP3 完成验证：

- WP3 聚焦离线测试：`test_*wp3.py` 47 项通过；article identity 11 项通过；strict TOML config 27 项通过。
- 完整单元与验收测试：522 项通过。
- Pyright：0 errors、0 warnings、0 informations。
- `uv run --frozen python scripts/harness.py docs`：通过。
- `uv run --frozen python scripts/harness.py architecture`：通过。
- `uv run --frozen python scripts/harness.py full`：通过；documentation、architecture、compile、Pyright、完整 unittest、wheel build 和 wheel contents 全部通过。

2026-07-24 WP4 完成核对：

- 本地 parser comparison 确认 MinerU 3.4.4 `vlm-engine` 在目标科学 PDF 上的布局、公式和损坏文本层恢复优势；具体 parser 缺陷和样本观察保留在 comparison 报告，不提升为产品 requirements。
- 已核对 MinerU 3.4.4 API protocol 2 的 health/async task/result、process-local retention、model preload/cache、no-cancel/no-idempotency 和无内置 TLS/auth/upload-limit 边界。
- 已将 WP4 执行顺序细化为 current-result/attempt/config contracts、connector/result admission、PDF source units/evidence、LLM analysis/current replacement、CLI/package/release surface 五个内部阶段；该细化不改变 ADR 或产品规格。
- MinerU connector、配置、source map、current analysis、`analyze`/`search --level analyze` 和 package snapshot 均已实现并由离线测试覆盖。

## 8. 更新规则

1. 代码或测试改变实现覆盖时更新本文和 README；规格不随进度更新。
2. 工作包顺序、依赖或验收门变化时更新 `.omo/plans/` 中的活动计划；本文只保存收口时的事实状态。
3. 产品行为或边界变化时先更新 ADR/requirements/system design/technical architecture，再调整计划和进度映射。
4. 每个“已实现”或“已验证”状态必须附具体代码、测试或命令证据及核对日期。
5. 本文不得新增需求、重写验收条件、安排任务 owner/工期或把计划授权解释为实现完成。
