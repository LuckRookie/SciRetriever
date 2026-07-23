# SciRetriever

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Package](https://img.shields.io/badge/package-0.1.0-2F855A)](pyproject.toml)
[![CI](https://img.shields.io/badge/CI-quick%20%2B%20full-1F6FEB)](.github/workflows/ci.yml)

## 当前实现

SciRetriever 当前是一套本地科研文献发现、采集、不可变保存、归一化和文献包发布工具。它能把多来源检索结果写成 JSONL manifest，按 DOI、HTTPS URL 或 manifest 获取 PDF/XML/HTML，将已接受文件保存为不可变 `RawAsset`，再发布确定性的 `DocumentPackageVersion` 处理快照。

当前命令树如下：

| 命令 | 当前行为 |
|---|---|
| `sciretriever discover` | 查询、清洗、去重和合并 metadata，输出 JSONL manifest |
| `sciretriever acquire` | 在当前进程内通过明确 provider 或 source plan 获取一个角色资产 |
| `sciretriever preflight` | 只读检查当前 acquisition 配置，不下载响应正文 |
| `sciretriever catalog` | 创建 catalog，或导入明确指定的现有资产/legacy SQLite |
| `sciretriever package` | 离线归一化并发布 `DocumentPackageVersion` 处理快照 |
| `sciretriever report` | 只读查看 acquisition job、attempt 和脱敏失败 |

当前没有书目 `WorkVersion`、本地 library 查询、作者/作者关系、metadata observation、canonical tag alias、全文 LLM、引用扩展、Sci-Hub、landing-page translator 或 browser acquisition。`package_versions` 是处理结果快照，不是书目版本。完整覆盖与差距见[实施进度](docs/governance/implementation-progress.md)。

## 产品方向

产品按[需求规格](docs/specs/requirements.md)、[系统设计](docs/specs/system-design.md)和[技术架构](docs/specs/technical-architecture.md)定义为以 Work 为中心的本地文献库。当前使用者只应依赖上表、`--help` 和 `config.example.toml` 中已经发布的入口；理想产品描述不是当前操作说明。

## 功能特性

- 多来源 metadata discovery，内置 Crossref、Europe PMC、arXiv、OpenAlex、Semantic Scholar、Elsevier 和 Springer。
- 确定性清洗、批内去重、跨来源合并和 JSONL manifest 发布。
- Direct HTTPS、开放来源和出版社 provider 的 serial fallback 或同层 race。
- primary PDF、supplementary PDF、XML 和 HTML 的角色化内容验证。
- HTTPS、DNS pinning、redirect 复检、敏感 header 处理、有限 timeout 和有界响应读取。
- SHA-256 内容寻址、create-if-absent 发布和不可变 `RawAsset`。
- PDF/XML/HTML 的确定性归一化、evidence、通用轻结构和版本化处理快照。
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

DOI / HTTPS URL / manifest
  -> Work admission
  -> acquisition provider serial/race
  -> validation
  -> immutable RawAsset
  -> normalization and deterministic enrichment
  -> DocumentPackageVersion processing snapshot
```

`discover` 只读 catalog，不为搜索结果创建 placeholder `Work`。`Work` 在 acquisition admission 时创建或复用。完整当前实现概览见[实施进度](docs/governance/implementation-progress.md)。

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

provider 返回候选或 HTTP 200 不等于资产成功。内容必须通过角色、MIME、大小、格式和解析校验，再由不可变存储边界接受。运维事实见 [Provider 运维手册](docs/guides/provider-operations.md)。

`acquire` 是有界前台工作流，不提供 durable pause/resume、due scheduling 或 candidate checkpoint。未接受资产时，重复调用会从 source plan 开头重试；已有合格不可变资产时直接复用。Ctrl+C/SIGTERM 会让当前有限操作安全结束或取消，并停止开始后续 manifest 记录，已经提交的结果保持不变。

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

### 获取一个资产

从 manifest 获取：

```bash
uv run --frozen sciretriever acquire \
  --manifest runtime/manifests/electrolytes.jsonl \
  --catalog runtime/catalog.sqlite \
  --storage-root runtime/storage \
  --providers openalex \
  --providers semantic-scholar \
  --routing race
```

或直接使用 DOI：

```bash
uv run --frozen sciretriever acquire \
  --doi 10.1000/example \
  --catalog runtime/catalog.sqlite \
  --storage-root runtime/storage \
  --provider crossref
```

### 发布当前处理快照

acquisition 成功时输出 `work_id` 和 `raw_asset_id`。使用真实 ID 运行：

```bash
uv run --frozen sciretriever package \
  --catalog runtime/catalog.sqlite \
  --storage-root runtime/storage \
  --work-id <WORK_ID>
```

默认 enrichment 是当前确定性通用轻结构，不是目标全文 LLM。可用 `--no-enrichment` 关闭。

### 查看参数

```bash
uv run --frozen sciretriever --help
uv run --frozen sciretriever discover --help
uv run --frozen sciretriever acquire --help
uv run --frozen sciretriever preflight --help
uv run --frozen sciretriever catalog --help
uv run --frozen sciretriever package --help
uv run --frozen sciretriever report --help
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

当前 `preflight` 要求实际选择一份 TOML。`acquire` 保留当前 CLI 参数覆盖配置的行为。含 `[credentials]` 的文件在 POSIX 上必须为 `0600` 或更严格。

当前 parser 会拒绝未知字段。不要提前加入 provider precedence、LLM、Sci-Hub、translator、browser、reference expansion 或目标 library 字段，它们尚未实现。

### 当前凭据环境变量

| 变量 | 用途 |
|---|---|
| `SCIRETRIEVER_UNPAYWALL_EMAIL` | Unpaywall 请求身份 |
| `SCIRETRIEVER_SEMANTIC_SCHOLAR_API_KEY` | Semantic Scholar |
| `SCIRETRIEVER_ELSEVIER_API_KEY` | Elsevier |
| `SCIRETRIEVER_WILEY_API_KEY` | Wiley TDM |
| `SCIRETRIEVER_SPRINGER_API_KEY` | Springer Nature |

凭据不应出现在 source plan、catalog provenance、attempt details、package lineage 或成功输出中。

## 架构

```text
src/sciretriever/
  core/             contracts, ids, hash, DocumentPackage
  discovery/        metadata query, clean, merge, labels, manifest
  integrations/     provider clients and neutral DTOs
  network/          secure bounded transport
  acquisition/      admission, providers, serial/race, validation
  catalog/          SQLite identity, state, assets, processing, lineage
  storage/          immutable Raw/Derived publication and recovery
  normalization/    PDF/XML/HTML normalization and evidence
  enrichment/       current deterministic light structure
  packaging/        quality gate and processing snapshot publication
  legacy/           restricted adapters and retired-path guards
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

ADR 的权威范围和阅读顺序见 [ADR 索引](docs/adr/README.md)：ADR 0001 控制领域边界，ADR 0002 控制当前批准的 Work-centered 产品方向和旧任务兼容策略。

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
- [方向确认提案](docs/proposals/literature-library-product.md)
- [获批执行计划](docs/planning/literature-library-execution.md)
