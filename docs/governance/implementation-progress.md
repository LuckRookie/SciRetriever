# SciRetriever 实施进度

- 最后核对：2026-07-23
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

截至 2026-07-23，SciRetriever 已具备文献发现、前台全文采集、安全网络边界、不可变保存、确定性归一化和 `DocumentPackageVersion` 处理快照能力，但尚未成为三份规格描述的 Work-centered 本地文献库。WP0 已完成实现，WP1-WP5 尚未进入已验证完成状态。

当前主交接仍是：

```text
SearchSpec
  -> discovery providers
  -> clean / deduplicate / merge
  -> DownloadManifest JSONL
  -> foreground acquisition diagnostics
  -> immutable RawAsset
  -> normalization / deterministic enrichment
  -> DocumentPackageVersion processing snapshot
```

当前用户主要观察 manifest、下载/处理状态、资产和报告；理想产品中的 WorkVersion、current PDF analysis、library curation 和 citation expansion 尚未形成完整用户面。

## 3. 当前命令与配置

当前命令树由 [README](../../README.md) 和 `sciretriever --help` 定义：

```text
discover
acquire
preflight
catalog create|import-asset|import-legacy-db
package
report
```

严格配置 parser 当前接受 `schema_version = 1` 以及 `paths`、`credentials`、`discovery`、`acquisition`、`package`。当前凭据字段覆盖 Unpaywall、Semantic Scholar、Elsevier、Wiley 和 Springer。provider precedence、LLM、Sci-Hub、translator、browser、引用扩展和 canonical tag registry 等理想配置尚未进入 accepted parser。

证据：`README.md`、`config.example.toml`、`src/sciretriever/config.py`、`src/sciretriever/cli/main.py`。最后核对：2026-07-23。

## 4. 当前模块事实

| 当前模块 | 已验证职责 |
|---|---|
| `core/` | 中性契约、标识符、枚举、hash、`DocumentPackageVersion` |
| `catalog/` | SQLite schema/migrations、Work acquisition identity、jobs/attempts/failures、assets、processing、citations、package snapshots |
| `discovery/` | provider 查询、清洗、去重、合并、只读 catalog 比对、确定性标签和 manifest writer |
| `integrations/` | 外部 provider client 和中性 DTO |
| `network/` | HTTPS、DNS pinning、redirect、header、有限读取和 timeout |
| `acquisition/` | admission、SourcePlan、provider、前台 serial/race、candidate execution、诊断和验收调用 |
| `storage/` | Raw/Derived staging、不可变 create-if-absent 发布、hash 验证和 reconciliation |
| `normalization/` | PDF/XML/HTML 到 sections、tables、references、source map 和 evidence |
| `enrichment/` | 确定性 summary、tags 和 citation links |
| `packaging/` | quality gate 与 `DocumentPackageVersion` 处理快照发布 |
| `cli/` | 当前命令的 composition root |
| `legacy/` | 受限只读适配器和退休路径保护 |

当前 `package_versions` 保存处理快照，不是书目 `WorkVersion`。`works` 直接保存部分 metadata；当前 catalog 没有完整的 `WorkVersion`、`MetadataObservation`、`Author`/`Authorship`、canonical tag alias 或 single current generated result 模型。

证据：`src/sciretriever/`、`docs/governance/code-doc-map.md`。最后核对：2026-07-23。

## 5. 能力覆盖与差距

| 能力 | 实施状态 | 当前证据 | 对应计划 |
|---|---|---|---|
| Work identity | 部分覆盖 | Work + identifiers 主要服务 acquisition | WP1 |
| 书目 WorkVersion | 未实现 | `package_versions` 仅为处理快照 | WP1 |
| MetadataObservation | 未实现 | discovery/manifest 保存合并结果，无 observation 模型 | WP1-WP2 |
| Author/Authorship | 未实现 | 作者仍是输入或输出字符串 | WP1 |
| Publisher/Venue registries | 未实现 | 当前为字符串字段 | WP1-WP2 |
| Canonical tags | 部分覆盖 | metadata labels 和 deterministic tags，不是目标 registry | WP1/WP4 |
| Metadata discovery | 部分覆盖 | 多 provider 清洗、去重、manifest；尚未 placeholder 入库 | WP2 |
| Local library search/curation | 未实现 | catalog 只有有限读取入口 | WP2/WP5 |
| Primary PDF acquisition | 部分覆盖 | direct/official/OA providers、serial/race | WP3 |
| Sci-Hub / translator / browser | 未实现 | 无 accepted 配置和完整运行路径 | WP3 |
| Immutable RawAsset | 已覆盖基础 | validation、hash、create-if-absent、reconciliation | WP3 保留边界 |
| PDF normalization/OCR | 部分覆盖 | 已有 PDF normalization，尚未覆盖目标 LLM 输入和 locator 合同 | WP4 |
| Current LLM analysis | 未实现 | 当前是 deterministic enrichment | WP4 |
| Atomic current replacement | 未实现 | 当前是 processing/package snapshots | WP4 |
| Version references | 部分覆盖 | package citations，不是完整 WorkVersion reference 模型 | WP1/WP4 |
| Reference expansion | 未实现 | 无 `expand` 产品命令 | WP5 |
| Failures UX | 部分覆盖 | 当前 report 展示 acquisition job/attempt/failure | WP3/WP5 |
| Strict product config | 未实现 | 当前 schema v1 不含理想产品全部字段 | WP5 |
| Foreground stop/idempotent rerun | 已覆盖 WP0 | signal cooperative stop、记录间停止、整记录重跑、资产复用直接测试 | WP0 |
| 旧任务控制移除 | 已完成 | download、pause/resume/due、retry scheduling、daily reservation、source plan persistence、candidate checkpoint 公开面和运行依赖已删除 | WP0 |
| Domain pack boundary | 已批准并有基础 | `DocumentPackageVersion`、stable references、ADR 0001 | 持续约束 |

最后核对：2026-07-23。目标含义以三份规格为准，本表只说明覆盖程度。

## 6. 工作包进度

| 工作包 | 计划生命周期 | 实施进度 | 已完成证据 | 阻塞 |
|---|---|---|---|---|
| WP0 旧架构收缩 | approved | completed | `test_acquisition_p5.py` 覆盖记录间 stop、rerun、reuse、serial/race、stale attempt 和无 checkpoint；`test_candidate_executor.py` 覆盖有界执行、验证和安全投影；CLI/config removal 有直接测试 | 无 |
| WP1 文献模型 | approved | not started | 无 schema/migration 完成证据 | 等待 WP0 验收 |
| WP2 搜索与本地库 | approved | not started | 无目标 search/library 完成证据 | 等待 WP1 验收 |
| WP3 PDF 获取 | approved | not started | 只有可复用的现有 acquisition 基础 | 等待 WP2 验收 |
| WP4 PDF 分析 | approved | not started | 只有可复用的 normalization/evidence 基础 | 等待 WP3 验收 |
| WP5 引用与产品收口 | approved | not started | 无目标 expand/CLI/config 收口证据 | 等待 WP4 验收 |

`approved` 只表示执行计划获得授权，不等于代码已经实现。实施顺序和验收门只在[执行计划](../planning/literature-library-execution.md)定义。

## 7. 最近验证

2026-07-23 WP0 架构重置后的验证：

- `uv run --frozen python scripts/harness.py full`：通过。
- documentation、architecture、compile、Pyright、完整 unittest 和 wheel 构建门禁均通过。
- Pyright：0 errors、0 warnings、0 informations。
- 单元与验收测试：465 项通过。
- wheel 从干净 `build/` staging 构建，源码与 wheel 的 Python 模块清单一致；已删除的 `download.py`、`automatic.py` 和 `scheduler.py` 未进入发布物。
- WP0 目标/质量与安全/QA 两路独立审查均通过，无剩余 blocker。

## 8. 更新规则

1. 代码或测试改变实现覆盖时更新本文和 README；规格不随进度更新。
2. 工作包顺序、依赖或验收门变化时更新执行计划；本文只同步新的计划引用和事实状态。
3. 产品行为或边界变化时先更新 ADR/requirements/system design/technical architecture，再调整计划和进度映射。
4. 每个“已实现”或“已验证”状态必须附具体代码、测试或命令证据及核对日期。
5. 本文不得新增需求、重写验收条件、安排任务 owner/工期或把计划授权解释为实现完成。
