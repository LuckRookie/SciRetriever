# SciRetriever 实施进度

- 最后核对：2026-07-24
- 进度依据：[文献库执行计划](../planning/literature-library-execution.md)
- 理想产品：[需求规格](../specs/requirements.md)、[系统设计](../specs/system-design.md)、[技术架构](../specs/technical-architecture.md)
- 当前用户行为：[README](../../README.md)、`sciretriever --help`

## 1. 文档职责

本文是唯一的活动实施进度台账，记录代码相对三份理想产品规格已经覆盖什么、尚缺什么以及有哪些可验证证据。它可以随实现变化频繁更新，但不定义产品行为、不批准新范围、不规定工作包顺序，也不替代 README 的当前用户说明。

权威边界如下：

| 问题 | 权威来源 |
|---|---|
| 理想产品必须是什么 | requirements、system design、technical architecture |
| 为什么采用这些边界 | accepted ADR |
| 按什么顺序实施 | approved execution plan |
| 当前用户能运行什么 | README、CLI help 和代码 |
| 已实现多少、差距在哪里 | 本文 |

每项状态必须带核对日期和代码、测试、命令或用户文档证据。没有证据时只能标为“未核对”，不能根据计划或规格推断已经实现。

## 2. 总体状态

截至 2026-07-24，SciRetriever 已具备 Work-centered catalog、多来源 metadata 入库、本地 library 读取、WorkVersion selector、三层全文获取、安全网络边界、文章身份验证、不可变保存、确定性归一化和 `DocumentPackageVersion` 处理快照能力。WP0、WP1、WP2 和 WP3 已完成；WP4、WP5 尚未开始。

当前主交接是：

```text
SearchSpec
  -> discovery providers
  -> clean / deduplicate / merge
  -> Work + WorkVersion + observations
  -> explicit WorkVersion download selection
  -> provider race / translator / browser
  -> content and article identity validation
  -> immutable RawAsset
  -> normalization / deterministic enrichment
  -> DocumentPackageVersion processing snapshot
```

当前用户可以观察 canonical search JSON、library JSON/JSONL、manifest，以及 `download`/`search --level download` 的稳定脱敏 JSON 计数和逐 WorkVersion details。WorkVersion 已成为 catalog 书目与内容所有权基础；current PDF analysis、library curation、citation expansion、`failures` 和 `config check` 用户面尚未实现。

## 3. 当前命令与配置

当前命令树由 [README](../../README.md) 和 `sciretriever --help` 定义：

```text
discover
search
download
library show|search|references|cited-by|export
preflight
catalog create|import-asset
package
```

严格配置 parser 当前接受 `schema_version = 1` 以及 `paths`、`credentials`、`discovery`、`search`、`acquisition`、`package`。`search.level` 接受 `metadata`/`download`；`[acquisition]` 接受 first-tier providers、timeout/concurrency/host budget、响应上限、forbidden URL 文件和 XML/HTML 开关，并含严格的 `preflight`、`sci_hub`、`translator`、`browser` 子表。Sci-Hub 要求 provider 列表与 enabled 状态一致且没有默认 endpoint；translator/browser 默认关闭并按规则启用，browser profile 在运行前做 owner/mode/storage-tree 验证。当前凭据字段覆盖 Unpaywall、Semantic Scholar、Elsevier、Wiley 和 Springer。LLM、analysis、reference expansion、`failures` 和 `config check` 字段尚未进入 accepted parser。

证据：`README.md`、`config.example.toml`、`src/sciretriever/config.py`、`src/sciretriever/cli/main.py`、`sciretriever --help`、`download/search/preflight --help`。最后核对：2026-07-24。

## 4. 当前模块事实

| 当前模块 | 已验证职责 |
|---|---|
| `core/` | 中性契约、标识符、枚举、hash、`DocumentPackageVersion` |
| `catalog/` | Work/WorkVersion identity、metadata observations、authorship、registries/aliases、tags、version relations/references、WorkVersion assets、acquisition diagnostics、processing 和 package snapshots |
| `discovery/` | provider 查询、清洗、去重、确定性合并、并发 metadata catalog ingestion、只读 catalog 比对、确定性标签和 manifest writer |
| `integrations/` | 外部 provider client 和中性 DTO |
| `network/` | HTTPS、DNS pinning、redirect、header、有限读取和 timeout |
| `acquisition/` | WorkVersion target/resolver、provider 有界竞速、provider 内去重候选顺序执行、translator/browser tier、身份/内容校验、脱敏诊断和不可变验收调用 |
| `storage/` | Raw/Derived staging、不可变 create-if-absent 发布、hash 验证和 reconciliation |
| `normalization/` | PDF/XML/HTML 到 sections、tables、references、source map 和 evidence |
| `enrichment/` | 确定性 summary、tags 和 citation links |
| `packaging/` | quality gate 与 `DocumentPackageVersion` 处理快照发布 |
| `cli/` | 当前命令的 composition root，包括 metadata/download `search`、独立 `download` 和只读 `library` |

当前 `work_versions` 保存书目版本身份和 metadata，`works` 只保存作品身份、状态和首选版本指针；`package_versions` 仍保存处理/导出快照，不是书目 `WorkVersion`。Catalog 已覆盖 metadata observations、Author/Authorship、Publisher/Venue registry 与 alias、canonical tag 与 manual/generated links、version relations/assets/references；single current generated result 属于后续 WP4。

证据：`src/sciretriever/`、`docs/governance/code-doc-map.md`。最后核对：2026-07-24。

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
| Local library search/curation | WP2 读取面已覆盖 | exact lookup、keyword/filters、references/cited-by、safe JSON/JSONL export；人工整理属于 WP5 | WP2/WP5 |
| Primary PDF acquisition | 已覆盖 WP3 | 显式 WorkVersion selectors、first-tier provider race、每来源 8 个去重候选顺序回退、accepted/missing/reused/interrupted 输出 | WP3 |
| Sci-Hub / translator / browser | 已覆盖 WP3 | Sci-Hub first-tier 显式 opt-in；restricted translator second-tier；默认关闭的 profile-copy browser third-tier；全部使用离线 fixture | WP3 |
| Article identity validation | 已覆盖 WP3 | PDF/XML/HTML 的 DOI 或保守标题/佐证确认；mismatch/unconfirmed 均 reject 且不进入 RawAsset | WP3 |
| Immutable RawAsset | 已覆盖 WP3 | validation、hash、create-if-absent、同角色并发收敛、reconciliation | WP3 |
| PDF normalization | 部分覆盖 | 已有确定性 PDF normalization，尚未覆盖目标 LLM 输入和 locator 合同；WP3 不提供 OCR | WP4 |
| Current LLM analysis | 未实现 | 当前是 deterministic enrichment | WP4 |
| Atomic current replacement | 未实现 | 当前是 processing/package snapshots | WP4 |
| Version references | 已覆盖 WP1 基础 | ordered `version_references`、目标 Work link 与 reverse citation query | WP1/WP4 |
| Reference expansion | 未实现 | 无 `expand` 产品命令 | WP5 |
| Failures UX | 部分覆盖 | `download` 返回稳定脱敏 counts/details 并持久化 acquisition diagnostics；独立 `failures` 命令属于 WP5 | WP3/WP5 |
| Strict product config | 部分覆盖 | schema v1 已覆盖 WP2 search 和 WP3 acquisition/sci_hub/translator/browser/preflight；WP4-WP5 字段尚缺 | WP2-WP5 |
| Foreground stop/idempotent rerun | 已覆盖 WP0/WP3 | Ctrl+C 保留完成项和 interrupted 计数；已有角色资产直接 reuse；整批重跑收敛 | WP0/WP3 |
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
| WP4 PDF 分析 | approved | not started | 只有可复用的 normalization/evidence 基础 | 等待 WP3 验收 |
| WP5 引用与产品收口 | approved | not started | 无目标 expand/CLI/config 收口证据 | 等待 WP4 验收 |

`approved` 只表示执行计划获得授权，不等于代码已经实现。实施顺序和验收门只在[执行计划](../planning/literature-library-execution.md)定义。

## 7. 最近验证

2026-07-24 WP3 完成验证：

- WP3 聚焦离线测试：`test_*wp3.py` 47 项通过；article identity 11 项通过；strict TOML config 27 项通过。
- 完整单元与验收测试：522 项通过。
- Pyright：0 errors、0 warnings、0 informations。
- `uv run --frozen python scripts/harness.py docs`：通过。
- `uv run --frozen python scripts/harness.py architecture`：通过。
- `uv run --frozen python scripts/harness.py full`：通过；documentation、architecture、compile、Pyright、完整 unittest、wheel build 和 wheel contents 全部通过。

## 8. 更新规则

1. 代码或测试改变实现覆盖时更新本文和 README；规格不随进度更新。
2. 工作包顺序、依赖或验收门变化时更新执行计划；本文只同步新的计划引用和事实状态。
3. 产品行为或边界变化时先更新 ADR/requirements/system design/technical architecture，再调整计划和进度映射。
4. 每个“已实现”或“已验证”状态必须附具体代码、测试或命令证据及核对日期。
5. 本文不得新增需求、重写验收条件、安排任务 owner/工期或把计划授权解释为实现完成。
