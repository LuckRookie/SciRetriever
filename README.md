# SciRetriever

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Package](https://img.shields.io/badge/package-0.1.0-2F855A)](pyproject.toml)
[![CI](https://img.shields.io/badge/CI-quick%20%2B%20full-1F6FEB)](.github/workflows/ci.yml)

## 当前实现

SciRetriever 当前是一套以 Work 为中心的本地科研文献库工具。它能检索 metadata、采集并不可变保存 PDF/XML/HTML、通过 operator-managed MinerU 和严格 LLM target 生成 PDF-backed current analysis，并发布确定性的 `DocumentPackageVersion` 处理快照。

当前命令树如下：

| 命令 | 当前行为 |
|---|---|
| `sciretriever discover` | 查询、清洗、去重和合并 metadata，输出 JSONL manifest |
| `sciretriever search` | 以 `metadata`、`download` 或 `analyze` 为显式停止点，通过共享 completion 管线补到 provider metadata、primary PDF 或 COMPLETE |
| `sciretriever download` | 通过共享 completion 管线把显式选择的版本补到 asset stop；XML/HTML 是不改变完成阶段的可选操作 |
| `sciretriever analyze` | 通过共享 completion 管线把显式选择的版本补到 COMPLETE；`--force` 独立替换已有 current analysis |
| `sciretriever library` | 只读精确查找、关键词/字段过滤、引用遍历和安全导出 |
| `sciretriever preflight` | 只读检查当前 acquisition 配置，不下载响应正文 |
| `sciretriever catalog` | 创建 catalog，或导入明确指定的现有资产 |
| `sciretriever package` | 离线归一化并发布 `DocumentPackageVersion` 处理快照 |

当前已有独立书目 `WorkVersion`、WP3 全文补全、WP4 PDF current analysis 和 WP5 全局完成管线。引用扩展和 library 人工整理尚未实现。`package_versions` 是不可变处理/导出快照，不是书目版本或 analysis history。完整覆盖与差距见[实施进度](docs/governance/implementation-progress.md)。

## 产品方向

产品按[需求规格](docs/specs/requirements.md)、[系统设计](docs/specs/system-design.md)和[技术架构](docs/specs/technical-architecture.md)定义为以 Work 为中心的本地文献库。当前使用者只应依赖上表、`--help` 和 `config.example.toml` 中已经发布的入口；理想产品描述不是当前操作说明。

## 功能特性

- 多来源 metadata discovery，内置 Crossref、Europe PMC、arXiv、OpenAlex、Semantic Scholar、Elsevier 和 Springer。
- 确定性清洗、批内去重、跨来源合并和 JSONL manifest 发布。
- 有界并发 metadata search、provider 独立 timeout、configured precedence/fill-missing 和 canonical catalog 入库。
- DOI/title/internal ID 本地查找、关键词/字段过滤、references/cited-by 和 JSON/JSONL 安全导出。
- Direct HTTPS、开放来源、出版社 provider 和显式配置 Sci-Hub 的同层有界竞速；每个 provider 内对去重候选顺序回退。
- 受限 landing-page translator 第二层和默认关闭的 Playwright browser 第三层回退。
- primary PDF、supplementary PDF、XML 和 HTML 的角色化内容验证。
- HTTPS、DNS pinning、redirect 复检、敏感 header 处理、有限 timeout 和有界响应读取。
- SHA-256 内容寻址、create-if-absent 发布和不可变 `RawAsset`。
- PDF/XML/HTML 的确定性归一化、PDF-backed current analysis、evidence 和版本化处理快照。
- SQLite catalog 中的 Work identity、标识符、资产、处理、引用、失败和 lineage。

SciRetriever 的通用处理边界止于带 provenance 的 `DocumentPackageVersion`。反应、分子、路线、产率和其它领域数据由下游系统处理，不进入 catalog。

## 工作流程

```text
SearchSpec
  -> discovery providers
  -> clean / deduplicate / merge
  -> read-only catalog compare
  -> deterministic labels
  -> DownloadManifest JSONL

DOI / search result / existing WorkVersion / imported primary PDF
  -> shared CompletionPipeline reads catalog facts
  -> METADATA_PENDING: exact metadata resolution and provider observations
  -> ASSET_PENDING: bounded acquisition, validation and immutable RawAsset
  -> ANALYSIS_PENDING: MinerU, evidence, LLM and atomic current promotion
  -> COMPLETE: aligned current analysis, canonical projection, references and tags
```

`discover` 仍是只读 manifest 流程，不为结果创建 placeholder `Work`。completion 阶段只从 catalog 权威事实派生，不另存 workflow status。精确 DOI 在 metadata 成功前只存在于当前 invocation；失败不创建 placeholder。普通 search 只把本批持久化的 WorkVersion 交给共享管线，不会隐式扩展到全库。完整当前实现概览见[实施进度](docs/governance/implementation-progress.md)。

## 数据来源

### Metadata discovery

| 来源 | CLI 名称 | 默认启用 | 当前凭据 |
|---|---|---:|---|
| Crossref | `crossref` | 是 | 无，建议 `crossref_mailto` |
| Europe PMC | `europe-pmc` | 是 | 无 |
| arXiv | `arxiv` | 是 | 无 |
| OpenAlex | `openalex` | 否 | 当前 parser 未接入 key |
| Semantic Scholar | `semantic-scholar` | 否 | API key 可选 |
| Elsevier | `elsevier` | 否 | API key 必需 |
| Springer Nature | `springer` | 否 | API key 必需 |

### Asset acquisition

| Provider | CLI 名称 | 当前能力 | 当前凭据 |
|---|---|---|---|
| Direct HTTPS | `direct` | 明确 HTTPS URL 的目标资产 | 无 |
| arXiv | `arxiv` | primary PDF | 无 |
| Crossref | `crossref` | metadata link 指向的 primary PDF | 无 |
| Unpaywall | `unpaywall` | open primary PDF | Email 必需 |
| Europe PMC | `europe-pmc` | open primary PDF | 无 |
| OpenAlex | `openalex` | metadata 指向的 primary PDF | 当前 parser 未接入 key |
| Semantic Scholar | `semantic-scholar` | `openAccessPdf` primary PDF | API key 可选 |
| Elsevier | `elsevier` | primary/supplementary PDF、XML | API key 必需 |
| Wiley | `wiley` | primary PDF | TDM token 必需 |
| Springer Nature | `springer` | XML、HTML | API key 必需 |
| Sci-Hub | `sci-hub` | 显式配置 endpoint 的 primary PDF | 无默认 endpoint；必须显式启用并自行确认授权 |

未给 `--provider` 或 `[acquisition].providers` 时，第一层默认使用 `direct`、`arxiv`、`crossref`、`unpaywall`、`europe-pmc`、`openalex`、`semantic-scholar`、`elsevier`、`wiley` 和 `springer`；无法满足凭据或标识符要求的 resolver 不会构造成功。Sci-Hub 从不进入默认列表。

上表 provider 构成第一层：已配置 provider 有界竞速，每个 provider 的候选先去重，再按确定性顺序最多执行 8 个。Unpaywall 按 `best_oa_location` 后接其它 OA locations 形成有序去重候选；OpenAlex 按 best/primary/locations 顺序选择首个 HTTPS PDF locator。第一层没有合格 primary PDF 时，系统依次运行显式配置的 translator rules；仍未命中时才运行 browser rules。translator 和 browser 不参与第一层竞速。

provider 返回候选或 HTTP 200 不等于资产成功。primary PDF 是必需角色；XML/HTML 仅在 primary PDF 已成功或复用后按配置补充，不能替代 primary PDF。PDF/XML/HTML 都必须通过角色、MIME、大小、格式、解析和目标文章身份校验。精确 DOI 一致可通过；没有可用 DOI 时，保守标题匹配或标题加作者/年份佐证可通过。明确身份不符或无法确认身份（包括无法确认的扫描件）会被拒绝并保持 missing；acquisition 身份校验不执行 OCR。WP4 `analyze` 会把已 accepted primary PDF 交给配置的 MinerU parser，解析/OCR 结果只在严格 evidence 和 current-replacement 门后生效。

`download` 是有界前台 completion batch，固定停在 asset ceiling。已有合格 primary PDF 时直接复用，不重复联网或覆盖；`--xml`/`--html` 在 required batch 后单独运行，成功或失败都不改变四阶段判定。Ctrl+C 保留已完成记录并在稳定、脱敏的 batch JSON 中报告逐目标结果和 interruption。运维事实见 [Provider 运维手册](docs/guides/provider-operations.md)。

## 快速开始

### 安装

```bash
uv sync --locked --dev
uv run --frozen sciretriever --version
```

### 创建当前 catalog

存储目录必须预先存在，`catalog create` 不覆盖已有文件。

```bash
mkdir -p runtime/storage runtime/manifests

uv run --frozen sciretriever catalog create \
  --catalog runtime/catalog.sqlite
```

### 发现 metadata

```bash
uv run --frozen sciretriever discover "solid-state electrolytes" \
  --source crossref \
  --source europe-pmc \
  --filter year_from=2020 \
  --catalog runtime/catalog.sqlite \
  --output runtime/manifests/electrolytes.jsonl \
  --taxonomy literature-topic \
  --taxonomy-version 1 \
  --label-rule battery=electrolyte
```

不指定 `--source` 时使用 Crossref、Europe PMC 和 arXiv。当前 `--limit` 默认 100，`--timeout` 默认 30 秒。

### 补全 WorkVersion 全文

`download` 要求当前 schema 的 catalog 和一个已存在、非符号链接的 storage directory。它只选择 catalog 中已有的 WorkVersion，不从 DOI 或 manifest 临时创建 Work。精确选择一个书目版本：

```bash
uv run --frozen sciretriever download \
  --catalog runtime/catalog.sqlite \
  --storage-root runtime/storage \
  --work-version-id <WORK_VERSION_ID>
```

按 Work 选择当前 preferred WorkVersion：

```bash
uv run --frozen sciretriever download \
  --catalog runtime/catalog.sqlite \
  --storage-root runtime/storage \
  --work-id <WORK_ID>
```

组合 query、字段过滤和 tag 时默认最多选择 100 个 WorkVersion；可用显式 `--limit` 进一步收紧：

```bash
uv run --frozen sciretriever download \
  --catalog runtime/catalog.sqlite \
  --storage-root runtime/storage \
  --query "solid-state electrolytes" \
  --author "Ada Lovelace" \
  --year 2024 \
  --publisher "Example Press" \
  --venue "Journal of Examples" \
  --tag battery \
  --limit 50
```

只有显式 `--all-missing` 才会选择全部缺 primary PDF 的 WorkVersion：

```bash
uv run --frozen sciretriever download \
  --catalog runtime/catalog.sqlite \
  --storage-root runtime/storage \
  --all-missing
```

没有 exact ID、query/filter/tag 或 `--all-missing` 时命令在构造 runtime 前 fail closed。exact ID 和 `--all-missing` 不能与 query/filter 混用。

### 分析 accepted primary PDF

`analyze` 是有界前台 backfill，支持显式 Work/WorkVersion ID、library query/filter、`--all-pending` 或 `--all-current --force`。它要求恰好一份 accepted primary PDF，以及完整启用的 `[analysis.mineru]` 和 `[analysis.llm]` 配置；XML/HTML-only 版本保持 `ASSET_PENDING`，命令返回未推进结果及脱敏的 reason/action，不存在额外的 blocked 状态。凭据只在运行时从配置指定的环境变量读取。

```bash
uv run --frozen sciretriever analyze --work-version-id <WORK_VERSION_ID>
uv run --frozen sciretriever analyze --all-pending --limit 100
uv run --frozen sciretriever analyze --all-current --force --limit 100
uv run --frozen sciretriever search "query" --level analyze
```

SciRetriever 不启动、停止、重载或升级 MinerU。普通 `analyze` 补齐到 COMPLETE，已完成目标直接复用；`--force` 跳过 metadata/acquisition 并请求 current 的下一 revision，完整替换失败时旧 current 和 COMPLETE 阶段持续可用。

### 发布当前处理快照

使用 `search` 或 `library` 返回的真实 Work ID 运行：

```bash
uv run --frozen sciretriever package \
  --catalog runtime/catalog.sqlite \
  --storage-root runtime/storage \
  --work-id <WORK_ID>
```

若所选 WorkVersion 已有 current analysis，包会冻结其 revision、完整十节内容、canonical proposals、references、generated tags、PDF locators、artifact hashes 和 run lineage。重导出相同输入复用包；current replacement 后生成新包，旧包保持可加载。

### 搜索并写入本地文献库

```bash
uv run --frozen sciretriever search "solid-state electrolytes" \
  --catalog runtime/catalog.sqlite \
  --provider crossref \
  --provider europe-pmc \
  --precedence crossref \
  --precedence europe-pmc \
  --limit 100
```

当前支持 `--level metadata`、`--level download` 和 `--level analyze`；它们分别映射到 METADATA、ASSET 和 COMPLETE stop，后两者要求 `--storage-root`。共享管线每次重读事实并只调用缺失阶段；来源耗尽的目标停在当前阶段，不伪装成功。多个 metadata provider 同时启动，各自有有限 timeout；部分 provider 失败时成功结果仍会入库，失败条目以脱敏形式出现在 JSON 输出中。

`catalog import-asset` 始终由现有资产 importer 验证并发布字节。primary PDF 导入在未配置 analysis 时默认停在 asset ceiling，也可显式 `--stop asset`；完整 analysis 配置可使默认 stop 为 complete，或显式使用 `--stop complete`。supplementary/XML/HTML 导入不推进 required completion stage；重复导入相同字节返回 `replayed` 并保留同一 asset ID/hash。

### 查询与导出本地文献库

```bash
uv run --frozen sciretriever library show \
  --catalog runtime/catalog.sqlite \
  --doi 10.1000/example

uv run --frozen sciretriever library search "electrolyte" \
  --catalog runtime/catalog.sqlite \
  --year 2024 \
  --tag battery

uv run --frozen sciretriever library export \
  --catalog runtime/catalog.sqlite \
  --work-id <WORK_ID> \
  --output runtime/library.jsonl \
  --format jsonl
```

`library` 通过只读 SQLite 连接运行。Work/title 主视图返回 preferred WorkVersion；DOI 和显式 `--work-version-id` 返回精确匹配的版本。JSON 的 `identifiers` 只包含该 WorkVersion 的公开稳定标识符（DOI、PMID、PMCID、arXiv），并按确定性顺序输出。导出只包含 canonical projection、这些稳定标识符和显式请求的 light content，不包含 provider record ID、observation provenance、存储路径或 raw reference。

### 查看参数

```bash
uv run --frozen sciretriever --help
uv run --frozen sciretriever discover --help
uv run --frozen sciretriever search --help
uv run --frozen sciretriever analyze --help
uv run --frozen sciretriever download --help
uv run --frozen sciretriever library --help
uv run --frozen sciretriever preflight --help
uv run --frozen sciretriever catalog --help
uv run --frozen sciretriever package --help
```

## 配置

当前 parser 的完整可接受字段见 [`config.example.toml`](config.example.toml)。复制后按需保留字段：

```bash
cp config.example.toml config.toml
chmod 600 config.toml
```

配置选择顺序：

1. 显式 `--config PATH`
2. `SCIRETRIEVER_CONFIG`
3. 当前目录已有的 `./config.toml`
4. 无配置文件时使用命令行参数和内置默认值

当前 `preflight` 要求实际选择一份 TOML。`search` 和 `download` 的 CLI 参数只覆盖当前 invocation，不回写配置。含 `[credentials]` 的文件在 POSIX 上必须为 `0600` 或更严格。

当前 parser 会拒绝未知字段。`[search]` 接受 `level`、`limit`、`providers`、`precedence`、`provider_timeout`、`max_concurrency` 和 `crossref_mailto`；provider 与 precedence 必须同时定义且包含完全相同的名称。

`[acquisition]` 接受 first-tier providers、timeout/concurrency/host budget、资产大小、forbidden URL 文件和可选 XML/HTML 开关。`[acquisition.sci_hub]`、`[acquisition.translator]` 和 `[acquisition.browser]` 都是严格、默认关闭的 capability；完整字段和仅使用 `.example` host 的占位示例见 [`config.example.toml`](config.example.toml)。未启用 capability 不要求 endpoint、rule、profile 或运行时；translator/browser 在 disabled 时不得携带 rules，browser 也不得携带 profile。

Sci-Hub 没有默认 mirror/endpoint。只有 `acquisition.providers` 包含 `sci-hub` 且 `[acquisition.sci_hub].enabled = true` 时配置才一致；启用后必须提供 operator 明确授权的 HTTPS `base_url`，可用 `allowed_pdf_hosts` 收紧候选 host。translator 使用带单个 `{doi}` 或 `{doi_path}` 的 HTTPS landing template、精确 landing/PDF host allowlist 和固定静态 HTML selector whitelist，不执行任意页面脚本。

browser 默认关闭。启用时 `profile_dir` 必须是已存在的真实目录，在 POSIX 上由当前用户拥有且权限为 `0700`，并且与 storage root 互不包含。每次 browser candidate execution 都在当前 invocation 内把 profile 受限复制到 owner-only 临时目录，headless 使用副本，结束后清理；原 profile 不被修改，也不调用 `storage_state`。运行中不提供交互登录，不处理登录页或 CAPTCHA。operator 应在 SciRetriever 外准备已授权 profile，并对 endpoint、内容访问和使用权限负责。

### 当前凭据环境变量

Acquisition 的固定变量如下。除此之外，`analysis.mineru.auth_env`（仅 remote mode）和
`analysis.llm.credential_env` 接受 operator 选择的环境变量名称，配置只保存名称、不保存秘密值；
`config.example.toml` 的 LLM 示例使用 `SCIRETRIEVER_LLM_API_KEY`。

| 变量 | 用途 |
|---|---|
| `SCIRETRIEVER_UNPAYWALL_EMAIL` | Unpaywall 请求身份 |
| `SCIRETRIEVER_SEMANTIC_SCHOLAR_API_KEY` | Semantic Scholar |
| `SCIRETRIEVER_ELSEVIER_API_KEY` | Elsevier |
| `SCIRETRIEVER_WILEY_API_KEY` | Wiley TDM |
| `SCIRETRIEVER_SPRINGER_API_KEY` | Springer Nature |

凭据以及运行时 URL、header、query、profile/session 数据不应出现在 catalog diagnostics、package lineage 或命令输出中。

## 架构

```text
src/sciretriever/
  core/             contracts, ids, hash, DocumentPackage
  discovery/        metadata query, clean, merge, labels, manifest
  integrations/     provider clients and neutral DTOs
  network/          secure bounded transport
  acquisition/      WorkVersion targets, resolvers, tier orchestration, identity validation
  completion/       derived stages, missing-suffix pipeline, batch/force/optional operations
  catalog/          SQLite identity, state, assets, processing, lineage
  storage/          immutable Raw/Derived publication and recovery
  normalization/    PDF/XML/HTML normalization, MinerU parsing and evidence
  analysis/         PDF-backed LLM analysis and atomic current replacement
  packaging/        quality gate and processing snapshot publication
  cli/              current composition root
```

当前模块事实与目标所有权见[技术架构](docs/specs/technical-architecture.md)。

## 数据与安全边界

- RawAsset 永不原地修改，catalog 不存文献 BLOB 或绝对资产路径。
- 网络入口执行 HTTPS、DNS、redirect、header、大小和 timeout 检查。
- 竞速 loser 不能在 winner 后接受内容。
- catalog 保存相对路径、hash、关系、失败和 lineage。
- 领域数据不进入 SciRetriever catalog。
- 文献数据和运行时 catalog 不提交到代码仓库。

ADR 的权威范围和阅读顺序见 [ADR 索引](docs/adr/README.md)：ADR 0001 控制领域边界，ADR 0002 控制 Work-centered 产品方向，ADR 0003 控制 operator-managed MinerU 服务边界。

## 开发与验证

```bash
uv run --frozen python scripts/harness.py quick
uv run --frozen python scripts/harness.py full
uv run --frozen python scripts/harness.py docs
uv run --frozen python scripts/harness.py architecture
```

协作规则见 [`AGENTS.md`](AGENTS.md) 和 [`HARNESS.md`](HARNESS.md)，代码与文档同步关系见[责任映射](docs/governance/code-doc-map.md)。

## 项目文档

- [需求规格](docs/specs/requirements.md)
- [系统设计](docs/specs/system-design.md)
- [技术架构](docs/specs/technical-architecture.md)
- [ADR 索引与权威范围](docs/adr/README.md)
- [ADR 0001，范围与边界](docs/adr/0001-sciretriever-scope-and-boundary.md)
- [ADR 0002，文献库产品重置](docs/adr/0002-work-centered-literature-library.md)
- [ADR 0003，operator-managed MinerU 服务](docs/adr/0003-operator-managed-mineru-service.md)
- [方向确认提案](docs/proposals/literature-library-product.md)
- [获批执行计划](docs/planning/literature-library-execution.md)
- [Provider 运维手册](docs/guides/provider-operations.md)
- [MinerU 服务运维指南](docs/guides/mineru-service-operations.md)
- [WP3 acquisition 准入记录](docs/guides/wp3-acquisition-admission.md)
- [实施进度](docs/governance/implementation-progress.md)
