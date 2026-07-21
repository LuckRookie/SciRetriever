# SciRetriever v2 技术架构

- 状态：P0-P9 BUILT
- 目的：说明 v2 代码如何组织、采用什么技术路线、按什么阶段落地。不写逐函数细节。
- 规范引用：[需求](./requirements.md)、[系统设计](./system-design.md)、[ADR 0001](../adr/0001-sciretriever-scope-and-boundary.md)、[架构原则](../architecture/principles.md)、[README](../../README.md)、[AGENTS.md](../../AGENTS.md)。
- 当前态声明：P0-P9 的契约、catalog、discovery / acquisition 流水线及 CLI、不可变 Raw / derived store、确定性 PDF / XML / HTML normalization、通用 enrichment、质量门、`DocumentPackageVersion` publication、显式已有资产导入及只读 legacy SQLite 适配均已交付。导入不自动迁移 corpus；小写 `sciretriever` 是 v2 主路径，大写 `SciRetriever` 仅保留兼容与安全守卫。当前没有替代性的运营文献库。

## 1. 技术路线

- **Modular monolith**：单一、良分层的 Python 包演进；不引入微服务、外部工作流平台、向量库、Web UI（须新 ADR 才可破例）。
- **两段分离、JSONL 交接**：discovery（发现）与 acquisition（采集）是两个独立模块，用 `DownloadManifest`（JSONL，一行一条）交接，各自可单独运行与测试。
- **catalog = SQLite（初期）**：以 SQLite 为初始 catalog，配事务化 migrations 与方言中立的 repository 边界，后续可换库而不动上层。
- **文件系统不可变存储**：已交付的 Raw 字节写配置存储根，以确定性 hash + 同文件系统 hard-link create-if-absent 发布；目标态 derived 字节另存。DB 只存相对路径、hash 与元数据，不存 BLOB。
- **异步采集编排 + 有界同步执行 legacy**：orchestrator 异步调度 job / attempt；legacy provider 在适配器内有界同步执行，不阻塞整体。
- **typed contracts + CLI-first**：核心契约用类型化数据类；对外操作以 CLI 为主入口。
- **provider / normalizer 接口化**：discovery provider、acquisition provider、normalizer 各自实现统一接口，便于增删。
- **测试策略**：fake HTTP + fixtures 的可复现测试，覆盖清洗 / 去重 / 标注、幂等、去重、对账、验收、发布。

## 2. 模块映射（目标）

| 模块 | 职责 |
| --- | --- |
| `core/contracts` | 类型化契约：ids、hash、provenance、`SearchSpec`、`DownloadManifest`、`DocumentPackage`、状态枚举、错误类型 |
| `discovery` + `discovery/providers` | 检索、清洗、批内去重、跨来源合并、catalog 比对、基于 title+abstract 标注；manifest writer；各 discovery provider 实现 |
| `catalog` | identity / requests / jobs / attempts / artifacts / failures / lineage / domain-run 记账；repository + migrations |
| `acquisition` + `acquisition/providers` | manifest reader；Work admission；编排器、source plan、路由、per-host 预算、健康评分、熔断；各 download provider 实现 |
| `storage` | 已交付：不可变 Raw store、staging、hard-link create-if-absent、协调与对账；目标态：derived store |
| `normalization` | Raw(PDF/XML/HTML) -> `NormalizedArtifact` + evidence，损失感知 |
| `enrichment` | 下载后轻结构（摘要 / 标签 / 引用关系）、search projection |
| `packaging` | 质量门、达标判定、`DocumentPackageVersion` 发布 |
| `cli` | 统一命令行入口 |
| `legacy` (adapters) | 包装 `Paper` / `Optera` / 脚本 / provider，翻译进新模型 |

目标包树（示意，源码目录统一为小写 `sciretriever`）：

```
src/sciretriever/
├── core/             # contracts、ids、hash、provenance、SearchSpec、DownloadManifest、DocumentPackage、状态枚举
├── discovery/        # 检索、清洗、去重、合并、catalog 比对、标注、manifest writer
│   └── providers/    # discovery provider（当前内置 Crossref / Europe PMC / arXiv，可插拔）
├── catalog/          # repository + migrations（SQLite 起步，方言中立）
├── acquisition/      # manifest reader、Work admission、orchestrator、路由、预算 / 健康 / 熔断
│   └── providers/    # acquisition provider（全文下载：OA / 出版商 / HTML / browser ...）
├── storage/          # 已交付 Raw / derived store、staging、hard-link 发布、协调 / 对账
├── normalization/    # PDF / XML / HTML -> NormalizedArtifact + evidence
├── enrichment/       # 下载后轻结构、search projection
├── packaging/        # 质量门、达标判定、DocumentPackageVersion 发布
├── cli/              # 统一命令行入口
└── legacy/           # Paper / Optera / 脚本 / provider 适配器
```

**依赖方向**：一切依赖 `core/contracts`。`discovery` 与 `acquisition` 互不依赖，只通过 `DownloadManifest` 契约与文件交接（`discovery` 写、`acquisition` 读）。**discovery provider（元数据检索）与 acquisition provider（全文下载）是两组不同的接口与实现，不混用。** 上层不反向依赖具体 provider；legacy 只经 `legacy/` 适配器进入；跨边界只暴露稳定 id / hash / provenance，不泄漏内部 ORM 表（ADR 0001 决策 8、9）。

**manifest 契约 / writer / reader**：`DownloadManifest` 定义在 `core/contracts`（每行一条候选记录的 schema：标识符、合并后的元数据、标签、`missing_abstract` / 复核标记、来源）；`discovery` 提供 writer 落 JSONL，`acquisition` 提供 reader 逐行读入并做 Work admission。选 JSONL 而非单个大 JSON 数组，保证可流式、可增量、模块可分离。

### 2.1 已交付的 P2 bounded workflow

`sciretriever discover QUERY` 已实现以下固定顺序：**元数据 retrieve -> clean / 批内去重 / 跨来源 merge -> 只读 catalog compare -> 本地 title+abstract keyword label -> 原子写 JSONL**。整次 discovery 失败则不发布部分 manifest。缺少 abstract 的候选不会被丢弃，而是输出 `missing_abstract=true`，本地规则仍可匹配 title。

CLI 装配 Crossref、Europe PMC、arXiv、OpenAlex、Semantic Scholar、Elsevier Scopus Search 与 Springer Nature Metadata 共 7 个 discovery providers，并只实例化 `--source` 请求的 provider；默认来源保持为 Crossref、Europe PMC 与 arXiv。所有 provider 共享安全的 HTTPS transport 和对应供应商 integration client；Crossref 可通过 `--crossref-mailto` 提供 polite-pool identity，Semantic Scholar API key 可选，Elsevier 与 Springer 在被显式选择时要求配置 API key。`--filter` 仅接受唯一的 `year_from` / `year_to`，label rules 为可重复的本地 `LABEL=TERM` 字面规则。catalog 只通过 `open_read_only_catalog_engine` + `ReadOnlyCatalogView` 打开并始终 dispose；该阶段只比较既有 Work / 复用精确标签，不创建或修改 Work，也不下载全文。`catalog` 已提供创建及一次性导入命令，`package` 已提供离线归一化、质量检查与 `DocumentPackageVersion` 发布命令。

**scansci-pdf 仅为本地设计参考**：不 import、不作依赖、不写适配器、不 vendoring、不复制其专有核心。其多来源路由、publisher profile、自适应评分、验证与续跑模式一律**原生重写**。SciRetriever 当前不调用、将来也不调用 `third_party/scansci-pdf`。

### 2.2 已交付的 P3 immutable RawAsset storage

P3 的公开 Python API 由 `sciretriever.storage` 暴露：`RawAssetStore`、`AssetAcceptanceCoordinator`、`RawAssetReconciler`、相关不可变 record 与 typed storage errors。P3 本身不联网、不选择 provider、不验证 PDF 业务格式；P4 在调用该 API 前完成这些职责。

- **root / layout / permissions**：storage root 必须预先存在且为无 symlink alias 的真实目录。相对布局固定为 `staging/<intent-id>.part`、`staging/.lock`、`raw/<sha256[:2]>/<sha256>`；managed directories / shards 为 `0700`，lock 为 `0600`，staged / raw files 为 `0400`。
- **single-pass staging**：输入 stream 只读一遍并同步计算 SHA-256 与正数 size；严格 fsync 文件内容、只读权限后的文件和 staging directory。失败只清理本次尚未形成 intent 的 owned incomplete file。
- **immutable replay intent**：catalog 在发布前记录 Work / job / optional attempt / role、staging / target 相对路径、expected hash / size、media type、format 与 provenance。状态仅允许 `pending -> published -> finalized` 或 `pending -> abandoned`，重放元数据由 SQLite trigger 保持不可变。
- **publication boundary**：coordinator 持 shared lock，以同文件系统 `os.link` create-if-absent 发布。它从不 rename / replace / copy / overwrite，也无 cross-device copy fallback。新目标与碰撞目标都重新校验 size + SHA-256 并严格 fsync；只有 durable target verification 后，catalog 才事务化创建 / 复用每 SHA 唯一的 `RawAsset`、写 per-Work + role link、保留 per-intent provenance 并转 `published`。staging 耐久删除后才转 `finalized`。
- **reconciliation boundary**：reconciler 持 exclusive lock，按 immutable intent + deterministic paths 处理 pending / published / finalized / abandoned 与 staged / target 的 absent / valid / corrupt 组合。valid staged 可重建 missing target，valid target 可补 catalog；missing evidence 按状态 abandon 或留 failure。corrupt target、corrupt staged、unknown staging、catalog metadata mismatch 全部保留且从不自动覆盖 / 删除。只有无 intent 的 recognized regular `staging/<uuid>.part` orphan 可在 exclusive lock 下耐久删除；abandoned intent 永不发布或删文件。
- **catalog / idempotency**：同 SHA 只存一个 Raw target 与一个 `RawAsset` row，每个 Work 保留 role link，每个 intent 保留自己的 provenance。catalog 无 Raw BLOB、无绝对路径；状态 event、exact failure 与 replay 均幂等。

验收已覆盖六个 crash checkpoints、restart 后 two-pass reconciliation、并发相同字节收敛为一个 target / raw row，以及 SQLite `integrity_check=ok` 与空 `foreign_key_check`。这里的 hard-link 发布只描述 P3；P2 `DownloadManifest` writer 的 staged file + atomic replace 语义保持不变。

### 2.3 已交付的 P4-P5 acquisition

P4 保留单来源 primary PDF API，但仅作为 one-entry serial plan adapter；`MultiSourceOrchestrator` 是 P4-P5 唯一 lifecycle owner。P5 在同一 catalog / Raw acceptance 边界上提供严格、无凭证、规范 JSON 的 durable `SourcePlan`，支持 serial fallback、同 tier race、基于 versioned candidate-attempt codec 的 restart resume、due retry job，以及 primary PDF / Supplementary PDF / XML / HTML 独立目标。catalog 不依赖 acquisition 模块，仅持久化 canonical JSON 和通用 metadata。OpenAlex、Semantic Scholar、Elsevier、Wiley、Springer 为原生 provider；publisher profile 仅为声明式数据，凭证只由环境 / 配置注入。每个 CLI invocation 复用 provider、orchestrator、per-host budget、provider health EMA、circuit breaker 与 retry policy；这些控制不伪装成 durable 状态。混合耗尽按全部 candidate 聚合，结果不依赖 race 完成顺序。fake transport 测试覆盖竞速、回退、取消 drain、重试续跑、角色校验、凭证不落库与 SQLite 完整性；不包含 browser / institutional automation。

## 3. 现有代码：retain / replace / new

| 处置 | 内容 | 去向 |
| --- | --- | --- |
| **Retain（保留知识 / 概念）** | 检索 provider 业务知识（Semantic Scholar / Crossref / Google Scholar / OpenAlex stub）；下载 provider 端点与出版商特性（Sci-Hub / Elsevier-ScienceDirect XML / Wiley / 通用 web / CJEM）；`NetworkClient` 的 `RateLimiter` / `Proxy` / fake-useragent 与 `forbidden_urls.txt`；`UniversalFilter` + `KeywordGroup`、config 解析；`workspace_paths` discovery 与退役库 guards | 检索知识重实现进 `discovery/providers`，下载知识进 `acquisition/providers`，guards 原样保留 |
| **Replace（替换实现）** | `Paper` ORM（约 22 列扁平表 + 自引用引用 join）；`Optera` CRUD（Insert / Query / Update / Delete）；DB 脚本（`work/combin.py`、`work/filter_database.py`）；相对路径默认（`./Elsever` / `./scihub` / `./wiley`，多为 cwd）；单体 `google_scholar` 与内联 retry；旧 CLI 占位 `main.py`；临时 `work/` 下载脚本（无批量编排） | catalog schema + repository；migrations + 编目；配置存储根 + 已交付 Raw hard-link 发布；统一 CLI；async orchestrator + jobs/attempts；检索侧改为 discovery 清洗 / 去重 / 合并 / 标注 流水线 |
| **New（新增）** | 已交付：`discovery`、`DownloadManifest`、catalog identity / jobs / events / processing、immutable Raw / derived store、单 / 多来源 acquisition、内容 validation、PDF / XML / HTML normalization、generic enrichment、quality gate、`DocumentPackageVersion` packaging 与 P9 legacy adapters | 全新模块，见模块映射；以阶段表的 BUILT 状态为准 |

legacy 一律**经适配器进入**，不得让其形状定义 v2 schema 或模块边界（ADR 0001 决策 9）。

## 4. <a id="phases"></a>落地阶段（可验证里程碑）

领域抽取始终在下游，不进任何阶段。落地顺序让 discovery 与 acquisition 可分别成 MVP，再组合闭环：

| 阶段 | 内容 | 里程碑（可验证） |
| --- | --- | --- |
| P0 foundation / contracts（**BUILT**） | `core/contracts`（含 `SearchSpec`、`DownloadManifest`）、config、hash、workspace 解析 | 契约类型与 hash 有单测；无硬编码路径 |
| P1 catalog / identity / jobs（**BUILT**） | catalog schema、repository、migrations、identity resolver、jobs / attempts、去重 / upsert | discovery 可只读比对既有 `Work` 与标签；并发同标识符收敛为一个 `Work`、每资产目标至多一个非终结 job |
| P2 discovery（**发现 MVP，BUILT**） | 多来源检索 -> 清洗 -> 批内去重 -> 跨来源合并 -> 只读 catalog 比对 -> 本地 title+abstract 标注 -> 原子 manifest writer；argparse CLI | 一条 `SearchSpec` 产出干净、去重、带标签的 `DownloadManifest`（JSONL）；缺摘要标 `missing_abstract` 不丢弃；清洗去重发生在标注之前；CLI 成功 / 运行失败 / 参数失败稳定返回 0 / 1 / 2 |
| P3 raw asset store（**BUILT**） | preexisting real root、restrictive staging / raw layout、single-pass SHA-256 + size、immutable `AssetIntent`、same-filesystem hard-link create-if-absent、durable verification、Raw / Work link registration、finalize、exclusive reconciliation | 六个 crash checkpoint 可恢复；presence matrix 与 two-pass 对账幂等；并发相同字节收敛为一个 target / raw row；corrupt / unknown evidence 保留；SQLite 完整性检查通过 |
| P4 acquisition（**采集 MVP，BUILT**） | manifest reader + Work admission、单来源 primary PDF 网络采集 / 内容校验 + 登记，接入 P2-P3；acquisition CLI | 消费 `DownloadManifest` 或直接 DOI/HTTPS URL，单来源端到端 PDF 采集入库、幂等 / 去重可复现，闭合到 `RawAsset` |
| P5 multi-source routing（**BUILT**） | 严格 durable source plan、serial / race 路由、进程内预算 / 健康 / 熔断、durable retry / resume、SI 与 XML/HTML 独立目标、OA / 凭证化 publisher provider、acquisition CLI 控制 | fake transport 下多来源竞速 / 回退 / 取消 drain / 续跑可复现；实际尝试全入库；凭证不进入 plan / event / attempt / failure；SQLite 完整性检查通过 |
| P6 normalization（**BUILT**） | bounded PDF / XML / HTML -> deterministic `NormalizedArtifact` + source map + evidence；immutable derived store | 同一 Raw / version / 参数重跑得同一 bytes / id / path；格式无关；越界 / malformed fail closed |
| P7 enrichment / search（**BUILT**） | 下载后通用摘要 / 标签 / citation links、rebuildable search projection | 清洗去重先于 summarizer；失败走确定性 fallback；轻结构缺失不影响正文 |
| P8 package publication（**BUILT**） | persistent quality gates、material change detection、immutable version publication、offline `package` CLI | XML-only 发布 `limited_xml_html`；PDF 发布 `pdf_backed`；exact replay 不增版本；catalog row 晚于 durable bytes |
| P9 import / legacy retirement（**BUILT**） | 显式已有资产导入、只读 legacy SQLite 与中性适配器 | 旧资产经正常生命周期登记为 `RawAsset`；旧路径不是主路径 |

**MVP 组合**：发现 MVP = P0 + P1 + P2，已交付；Raw preservation = P0 + P1 + P3，已交付；采集 MVP = P0 + P1 + P3 + P4，已交付；P5 多来源增强、P6-P8 Raw-to-package 闭环与 P9 一次性 legacy adaptation 均已交付。SciRetriever 的权威边界闭合于 `DocumentPackageVersion`。

## 5. 非功能技术决策

- **fail closed**：缺配置 / 缺凭证 / 校验不过一律不产出、不入库，宁可失败不可污染。
- **no secret literals**：P5 凭证只来自 `SCIRETRIEVER_*` 环境 / 配置注入，既不进入 source plan / catalog / log，也不上命令行；legacy 与 LLM 环境名保持各自现有约定。
- **provider rate limits**：per-host 预算与礼貌延时内建，遵守 `forbidden_urls`。
- **成本控制**：清洗与去重在标注前完成，catalog 已有可复用标签不重复消耗 token。
- **可复现测试**：fake HTTP + 本地 fixtures，禁止测试期真网请求；核心路径确定性可复现。
- **schema migrations**：catalog 变更走事务化 migration；repository 边界方言中立。
- **observability**：结构化 event 与 failure 记录入 catalog，支撑审计、恢复与来源健康。
- **不依赖退役迁移控制**：正常开发不得依赖 archived migration controls；退役库 guards 保持启用；DB 访问为 existing-file 模式，退役路径显式创建恒被拒。
