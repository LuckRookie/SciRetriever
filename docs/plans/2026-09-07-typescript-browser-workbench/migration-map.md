# 全量模块迁移映射

本表把原始计划中的模块范围落到当前仓库。它是 T001、T037–T045、T061 的追踪入口，不改变架构真相源。`migration/inventory.json` 保存原始 235 个模块及迁移期间新增 7 个 bridge 的逐文件机器清单；本表只保留模块、Provider、入口和状态，避免再维护一份 242 行的人工台账。

## 模块去向

| 当前 Python 能力 | TypeScript 目标 | 原始任务 | 当前状态与下一步 |
| --- | --- | --- | --- |
| `model/` | `packages/contracts` 与领域模块 types | T010–T011 | **完成（当前支持合同）**：Model、名义 ID、strict schema、canonical/hash 和 v1 oracle 已由 contracts 与 server 测试覆盖；未支持字段继续拒绝。 |
| `configuration/`、`entry/configuration_bridge.py` | `apps/server/src/configuration` | T012、T044、T061 | **完成**：TypeScript parser/credential/readiness owner 已接管生产路径；Python bridge 仅保留为历史 oracle，按 T061 逐项处置。 |
| `network/` | `apps/server/src/network` | T013、T020、T034、T039 | **完成（Linux/loopback 支持边界）**：URL、DNS/IP、redirect、credential origin、body limit、取消和共享预算均有 TS 测试；真实站点和其它平台未授权。 |
| `storage/` | `apps/server/src/storage`（SQLite、FileStore、锁） | T014–T016、T046、T049、T056 | **完成（当前支持边界）**：v1 schema/worker、repositories、FileStore、Candidate 对账、v2 显式迁移、备份/恢复/回滚均有 TS 直接证据；其它平台锁语义未声明。 |
| `agents/` | `apps/server/src/agents` | T017、T030 | **完成（离线协议边界）**：三协议 adapter、stream/JSON、tool/image/reasoning/usage、预算和取消均有 fixture；真实 LLM 未授权。 |
| `bootstrap/`、应用生命周期 | `apps/server/src/bootstrap`、`application` | T018、T044、T052 | **完成**：单一 Application、生命周期、CLI/daemon 复用和认证单端口入口均已接入 TS。 |
| `browser/`、`configuration/cloak_runtime.py` | `apps/server/src/browser` | T019–T027、T050–T053 | Browser 工作区、持久任务、复杂 download/response/blob/data/frame/popup 归属和单端口 API 已完成；复杂 viewer/跨版本 Range 重组保持 Deferred。 |
| `acquisition/` | `apps/server/src/acquisition` | T023、T029–T039、T049 | **完成（受支持来源边界）**：Candidate spool/receipt、PDF/identity 门、Public/API/Browser 统一来源合同、分层批次、失败/冷却/assistance 语义均已实现；复杂 viewer/Range 仍 Deferred。 |
| `metadata/` | `apps/server/src/metadata` | T037、T040 | 11 个 Provider、实际 citation capability、生产组装、Discovery 的逐 run 限额和部分失败闭环已完成。 |
| `literature/` | `apps/server/src/literature` | T033、T038、T040、T043 | **完成**：身份、metadata、版本、Reference support、current facts、Import selector、FTS/Detail/References 读取及四格式/Artifact 原子导出均有 TS 生产路径。 |
| `parsing/` | `apps/server/src/parsing` | T031、T041 | **完成**：受限 PDF、loopback/remote MinerU、archive/resource gate 与 current ParserResult publication 均为 TS；生产 export/Application 无 Python parser seam。 |
| `analysis/` | `apps/server/src/analysis` | T042 | **完成**：两阶段 schema、元数据证据保护、固定 Markdown/引用提取、canonical hash、provenance/lineage、NoUsableContent 和失败保留均由 TS 实现；生产源码无 Python Analysis seam。 |
| `entry/`、CLI | `apps/server/src/entry`、`apps/server/src/cli` | T040、T043–T044 | Discovery、六类 selector、四格式 Import、Query/Detail/Reference 与原子 Export 已完成；全命令树、报告/退出码和安装后流程继续由 T044/M6 跟踪。 |
| `logging/` | `apps/server/src/logging` | T018、T044 | **完成**：CLI/服务日志和错误边界采用统一脱敏 logger，凭据/query/PDF 正文不进入日志。 |
| Python `tests/` | `apps/server/test`、`apps/web/test`、Vitest/Playwright fixtures | T006、T045、T055 | 161 个 Python 测试保留为迁移语义清单；按行为和合同迁移，不以测试文件数量代替功能完成。 |
| `scripts/`、Python Harness、CI | 根 `package.json`、必要 Node scripts、TS CI | T009、T055、T061 | TS Quick/Full/CI、portable package/doctor 已建立；Python Harness 仅保留明确授权的历史维护入口，生产构建不依赖它。 |
| `archive/`、`docs/archive/` | 历史非运行材料 | T001、T045、T061 | 保留追溯价值，不进入最终运行包，也不计作待迁移生产能力。 |

## Metadata Provider（T037）

以下 11 个 Provider 必须逐项有 TypeScript adapter、分页/limit、lookup 或 citation 能力的 fixture 和差分记录；没有能力的 Provider 也要明确 `unsupported/unavailable`，不能静默删除。

| Provider | TypeScript 目标 | 状态 |
| --- | --- | --- |
| arXiv | `apps/server/src/metadata/arxiv` | 完成：topic/lookup Atom、分页、ID/version、PDF hint；Python 基线不提供 citation |
| CORE | `apps/server/src/metadata/core` | 完成：topic/lookup/reference、work/output 身份、全文 hint、生产组装 |
| Crossref | `apps/server/src/metadata/crossref` | 完成：topic/DOI lookup、分页/filter/mailto、生产组装；Python 基线不提供 citation |
| DataCite | `apps/server/src/metadata/datacite` | 完成：topic/DOI lookup/reference、relatedIdentifier 方向、生产组装 |
| Elsevier | `apps/server/src/metadata/elsevier` | 完成：Scopus topic/lookup、cursor、PII/EID/DOI、凭据与生产组装；Python 基线不提供 citation |
| Europe PMC | `apps/server/src/metadata/europe-pmc` | 完成：topic/lookup/reference、分页、PMID/PMCID/DOI、inline metadata/reference text、生产组装 |
| OpenAlex | `apps/server/src/metadata/openalex` | 完成：topic/lookup/reference、cursor、倒排摘要、双向引用、生产组装 |
| OpenCitations | `apps/server/src/metadata/opencitations` | 完成：lookup/reference、DOI 关系和方向边界、生产组装；不提供 topic search |
| Semantic Scholar | `apps/server/src/metadata/semantic-scholar` | 完成：topic/lookup/reference、external ID、offset/next、自环与生产组装 |
| Springer | `apps/server/src/metadata/springer` | 完成：Meta v2 topic/lookup、分页、`api_key` query seam、生产组装；Python 基线不提供 citation |
| Web of Science | `apps/server/src/metadata/web-of-science` | 完成：Starter/Expanded topic/lookup，Expanded reference，WOS UID、分页、凭据和生产组装 |

## Acquisition source 与授权 Provider（T039）

| 类型 | 名称 | TypeScript 目标 | 状态 |
| --- | --- | --- | --- |
| Source | arXiv | `apps/server/src/acquisition/sources/public.ts` | 完成：ID/version locator、共享安全下载与 Candidate 门 |
| Source | Browser | `apps/server/src/browser`、`apps/server/src/acquisition/browser-intake.ts` | 完成：capture、identity、durable Candidate 与相同发布门；独立显式启用 |
| Source | configured sci-hub | `apps/server/src/acquisition/sources/public.ts` | 完成：Custom-only、有序内置/custom mirror、DOI landing |
| Source | direct | `apps/server/src/acquisition/sources/public.ts` | 完成：PDF direct-file hint、安全下载、验收与发布 |
| Source | DOI landing | `apps/server/src/acquisition/sources/public.ts` | 完成：DOI locator、受控静态 PDF locator 解析与下载 |
| Source | Europe PMC | `apps/server/src/acquisition/sources/public.ts` | 完成：PMCID/PMID locator、安全下载与 Candidate 门 |
| Source | Unpaywall | `apps/server/src/acquisition/sources/public.ts` | 完成：联系参数、OA location 顺序、PDF/landing 区分与 Network 组装 |
| 授权 Provider | CORE | `apps/server/src/acquisition/providers/authorized.ts` | 完成：work/output record、credential header、状态映射与统一发布门 |
| 授权 Provider | Elsevier | `apps/server/src/acquisition/providers/authorized.ts` | 完成：PII/EID/confirmed DOI、MAIN object/fallback、凭据与 XML 安全 |
| 授权 Provider | Wiley | `apps/server/src/acquisition/providers/authorized.ts` | 完成：confirmed DOI、TDM token、状态/取消与统一发布门 |

## 公开入口、CLI 与配置

- 8 个公开 `api.py` 入口分别落到 `apps/server/src/{acquisition,agents,analysis,entry,literature,logging,metadata,parsing}`；每个入口均有 TS export、直接测试和组装记录，历史 Python API 不进入安装包。
- 23 个 CLI 路径必须由 TS 单次 Application 提供：`discover topic/citations`、`complete`、`literature search/show/references/cited-by`、`import metadata/pdf`、`export metadata/pdf/content`、`config`、`config status`、`config test` 及其 provider/model/search/download/parse/analyze/browser 子命令。
- 11 个配置 section（`paths`、`sources.metadata`、`sources.acquisition`、`assets`、`parsing`、`providers`、`models`、`analyze`、`browser`、`execution`、`library`）必须由同一个 TS Configuration owner 解析和发布；secret 继续由独立 Credential owner 管理。

## 退役规则

T045 业务全集差分、T054 持久服务验收、T057/T062 安装后验收、T060 文档同步和 T063 副本切换演练已完成，T061 已移除 Python `sciretriever` CLI entry 并以 [`migration/retirement-report.json`](../../../migration/retirement-report.json) 记录全部历史文件。Python 测试和无 TS 替代的历史语义保留，不进入生产包；任何退役都不能修改用户 Catalog、ArtifactStore、Profile 或配置文件。
