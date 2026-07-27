# SciRetriever 用户手册

本手册面向使用命令行建立和维护本地科研文献库的研究者与运维人员，介绍 SciRetriever 0.1.0 当前已经发布的功能与使用方法。命令的精确参数以 `sciretriever --help` 和各子命令的 `--help` 为准；完整配置字段以 [`config.example.toml`](../../config.example.toml) 为准。

## 1. 软件用途

SciRetriever 是一套以 `Work` 为中心的本地科研文献库工具。它可以：

- 从多个 metadata provider 检索、清洗、去重并合并文献记录；
- 在 SQLite catalog 中维护作品、书目版本、作者、标签和引用关系；
- 获取并验证 primary PDF，以及可选的 supplementary PDF、XML 和 HTML；
- 以 SHA-256 内容寻址方式不可变保存原始资产；
- 连接 operator-managed MinerU 服务解析 PDF；
- 使用严格配置的 LLM 生成带 PDF 页码和区域证据的 current analysis；
- 扩展 references、cited-by 或双向引用图；
- 查询脱敏失败历史，执行可审计、可撤销的人工整理；
- 导出阅读视图或不可变 `DocumentPackageVersion` 处理快照。

SciRetriever 的处理边界止于通用文献包。反应、分子、路线、产率等领域数据应由下游系统处理，不进入 SciRetriever catalog。

## 2. 先理解四个对象

| 对象 | 含义 |
|---|---|
| `Work` | 一项抽象作品，例如“某篇论文” |
| `WorkVersion` | 作品的具体书目版本，例如预印本或正式发表版 |
| `RawAsset` | 某个 WorkVersion 的不可变 PDF、XML 或 HTML 原始文件 |
| `DocumentPackageVersion` | 某次归一化、分析和导出的不可变处理快照 |

`WorkVersion` 和 `DocumentPackageVersion` 不是同一种版本。前者描述文献版本，后者冻结处理结果。每个 WorkVersion 最多保留一份 current analysis；成功替换 current analysis 后，旧 package snapshot 仍保持可加载。

## 3. 完成阶段

`search`、`download`、`analyze` 和 primary-PDF import 使用同一条 completion 管线。管线从 catalog 的权威事实推导阶段，不保存第二套任务状态：

```text
METADATA_PENDING
  -> ASSET_PENDING
  -> ANALYSIS_PENDING
  -> COMPLETE
```

- `METADATA_PENDING`：尚无满足要求的 provider metadata。
- `ASSET_PENDING`：metadata 已就绪，但没有通过验证的 primary PDF。
- `ANALYSIS_PENDING`：已有 primary PDF，但没有对齐的 current analysis。
- `COMPLETE`：metadata、primary PDF 和 current analysis 均就绪。

重复执行会重读事实并只补齐缺失阶段。来源耗尽时目标停留在当前阶段，不会被报告为成功。

## 4. 安装与首次检查

### 4.1 环境要求

- Python 3.10 或更高版本，开发基线为 Python 3.12；
- `uv`；
- 本地 SQLite 文件和已有的 storage directory；
- 只做 metadata 管理时不需要 MinerU 或 LLM；
- 执行 analysis 时需要 operator-managed MinerU 3.4.4 服务和 OpenAI-compatible LLM endpoint。

### 4.2 安装锁定依赖

在仓库根目录执行：

```bash
uv sync --locked --dev
uv run --frozen sciretriever --version
```

当前版本输出应为 `0.1.0`。

查看命令树：

```bash
uv run --frozen sciretriever --help
uv run --frozen sciretriever search --help
```

## 5. 创建工作目录和 catalog

运行时 catalog、storage 和用户语料不应放入版本控制。CLI 默认拒绝向 Git 工作树写入运行数据，因此以下示例统一使用仓库同级的 `../SciRetriever-runtime/`：

```bash
mkdir -p ../SciRetriever-runtime/storage ../SciRetriever-runtime/manifests ../SciRetriever-runtime/exports

uv run --frozen sciretriever catalog create \
  --catalog ../SciRetriever-runtime/catalog.sqlite
```

要求：

- catalog 的父目录必须已经存在；
- `catalog create` 不覆盖已有文件；
- storage directory 必须在调用需要存储的命令前创建；
- 不要把 storage root 指向符号链接或浏览器 profile 目录。

## 6. 配置

### 6.1 配置选择顺序

SciRetriever 按以下顺序选择配置：

1. `--config PATH`；
2. 环境变量 `SCIRETRIEVER_CONFIG`；
3. 当前目录已有的 `./config.toml`；
4. 未选择配置时使用 CLI 参数和内置默认值。

`--no-config` 会禁用环境变量和隐式 `config.toml`。CLI 显式参数优先于 TOML，TOML 优先于内置默认值；覆盖只作用于本次 invocation，不会回写配置。

### 6.2 准备配置文件

```bash
cp config.example.toml config.toml
chmod 600 config.toml
```

完整样例会列出 acquisition 和 analysis 的凭据、服务及安全上限，因此不能在未编辑时当作 metadata-only 配置直接使用。只建立 metadata 文献库时，可以把 `config.toml` 精简为：

```toml
schema_version = 1

[paths]
catalog = "../SciRetriever-runtime/catalog.sqlite"
storage_root = "../SciRetriever-runtime/storage"

[discovery]
sources = ["crossref", "europe-pmc", "arxiv"]
limit = 100
timeout = 30.0

[search]
level = "metadata"
limit = 100
providers = ["crossref", "europe-pmc", "arxiv"]
precedence = ["crossref", "europe-pmc", "arxiv"]
provider_timeout = 30.0
max_concurrency = 8

[acquisition]
providers = ["direct", "arxiv", "crossref", "europe-pmc", "openalex", "semantic-scholar"]
```

这份配置只启用不强制要求凭据的 provider，也不启用 analysis。确保仓库同级数据目录、catalog 和 storage 已按第 5 节创建后，offline `config check` 应返回 `"status":"ready"`。需要全文、出版社 provider 或 analysis 时，再从 `config.example.toml` 复制对应 section 和安全上限。

Parser 会拒绝未知 section 和字段。不要保留尚未接入当前命令 runtime 的配置名称，也不要在未提供凭据时保留 Unpaywall、Elsevier、Wiley 或 Springer 等 credential-gated acquisition provider。

### 6.3 凭据

Discovery/acquisition 的固定凭据环境变量包括：

| 环境变量 | 用途 |
|---|---|
| `SCIRETRIEVER_UNPAYWALL_EMAIL` | Unpaywall 请求身份 |
| `SCIRETRIEVER_SEMANTIC_SCHOLAR_API_KEY` | Semantic Scholar |
| `SCIRETRIEVER_ELSEVIER_API_KEY` | Elsevier |
| `SCIRETRIEVER_WILEY_API_KEY` | Wiley TDM |
| `SCIRETRIEVER_SPRINGER_API_KEY` | Springer Nature |

LLM 和 remote MinerU 只在 TOML 中保存环境变量名称，秘密值通过运行时环境提供。例如：

```bash
export SCIRETRIEVER_LLM_API_KEY='...'
```

不要把秘密值写入命令、日志、catalog、文档或提交记录。含 `[credentials]` 的配置文件在 POSIX 上必须为 `0600` 或更严格。

### 6.4 检查配置

Offline check 不联网：

```bash
uv run --frozen sciretriever --config config.toml config check
```

只有显式 `--runtime` 才会对已启用 capability 发起有界、只读的 identity/readiness probe：

```bash
uv run --frozen sciretriever --config config.toml config check --runtime
```

Runtime check 不下载论文正文，不启动 MinerU，也不修改外部服务。`config check` 和 `preflight` 都要求实际选择一份 TOML。

## 7. 推荐入门流程：先建立 metadata 文献库

### 7.1 搜索并写入 catalog

```bash
uv run --frozen sciretriever search "solid-state electrolytes" \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --level metadata \
  --provider crossref \
  --provider europe-pmc \
  --precedence crossref \
  --precedence europe-pmc \
  --limit 100
```

`--provider` 与 `--precedence` 必须包含完全相同的 provider 名称。多个 provider 有界并发运行，各自拥有独立 timeout；部分 provider 失败不会阻止其它成功结果入库。

不显式给 provider 时，metadata discovery 默认使用 Crossref、Europe PMC 和 arXiv。

### 7.2 查询本地文献库

按关键词和字段过滤：

```bash
uv run --frozen sciretriever library search "electrolyte" \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --year 2024
```

精确查询 DOI：

```bash
uv run --frozen sciretriever library show \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --doi 10.1000/example
```

精确查询也支持 `--title`、`--work-id` 和 `--work-version-id`。添加 `--include-light-content` 可返回 current analysis 的轻量内容，`--format jsonl` 可切换为 JSONL。

### 7.3 `discover` 与 `search` 的区别

`discover` 生成原子 JSONL manifest，用于独立的 metadata 发现和筛选：

```bash
uv run --frozen sciretriever discover "solid-state electrolytes" \
  --source crossref \
  --source europe-pmc \
  --filter year_from=2020 \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --output ../SciRetriever-runtime/manifests/electrolytes.jsonl \
  --taxonomy literature-topic \
  --taxonomy-version 1 \
  --label-rule battery=electrolyte
```

`discover` 对 catalog 只做只读比较，不为结果创建 placeholder Work。`search` 才会把 canonical Work/WorkVersion 写入本地库，并可继续补齐 PDF 或 analysis。

## 8. 获取全文资产

### 8.1 下载一个明确版本

从 `search` 或 `library` 输出取得真实 ID：

```bash
uv run --frozen sciretriever download \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --storage-root ../SciRetriever-runtime/storage \
  --work-version-id <WORK_VERSION_ID>
```

也可以按 Work 使用 preferred WorkVersion：

```bash
uv run --frozen sciretriever download \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --storage-root ../SciRetriever-runtime/storage \
  --work-id <WORK_ID>
```

### 8.2 批量补全缺失 PDF

按查询和字段选择，默认最多处理 100 个 WorkVersion：

```bash
uv run --frozen sciretriever download \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --storage-root ../SciRetriever-runtime/storage \
  --query "solid-state electrolytes" \
  --author "Ada Lovelace" \
  --year 2024 \
  --limit 50
```

只有显式 `--all-missing` 才会选择全部缺 primary PDF 的版本：

```bash
uv run --frozen sciretriever download \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --storage-root ../SciRetriever-runtime/storage \
  --all-missing
```

没有 exact ID、query/filter/tag 或 `--all-missing` 时命令会 fail closed。`--all-missing` 不能和 query/filter 混用。

### 8.3 Provider 与验证

第一层会在已配置的 direct、开放来源和出版社 provider 之间执行有界竞速。第一层耗尽后，才依次进入显式启用的 translator 和 browser fallback。Sci-Hub 没有默认 endpoint，也不在默认 provider 列表中。

HTTP 200 或 provider 返回候选不代表成功。资产还必须通过：

- HTTPS、DNS、redirect、header、大小和 timeout 边界；
- MIME、文件格式和角色校验；
- DOI 或保守标题、作者、年份身份校验；
- 不可变发布和 hash 验证。

无法确认身份的 PDF 会被拒绝并保持 missing。Acquisition 不对无法确认的扫描件执行 OCR。

### 8.4 可选 XML 和 HTML

```bash
uv run --frozen sciretriever download \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --storage-root ../SciRetriever-runtime/storage \
  --work-version-id <WORK_VERSION_ID> \
  --xml --html
```

XML/HTML 只是可选补充，不能替代 primary PDF，也不改变四阶段完成判定。

## 9. 导入已有资产

把已有 PDF 交给同一验证和不可变发布路径：

```bash
uv run --frozen sciretriever catalog import-asset \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --storage-root ../SciRetriever-runtime/storage \
  --asset /path/to/article.pdf \
  --asset-role primary_pdf \
  --work-version-id <WORK_VERSION_ID> \
  --stop asset
```

`--asset-role` 支持 `primary_pdf`、`supplementary_pdf`、`xml` 和 `html`。完整 analysis 配置下可使用 `--stop complete`。重复导入相同字节会返回 `replayed`，复用同一 asset ID 和 hash。

## 10. 分析 PDF

### 10.1 前置条件

目标 WorkVersion 必须恰好拥有一份通过验证的 primary PDF，并且配置中完整启用：

- `[analysis.mineru]`：MinerU 3.4.4、API protocol 2、`vlm-engine`；
- `[analysis.llm]`：OpenAI-compatible endpoint、模型和 credential 环境变量名。

SciRetriever 不负责启动、停止、重载或升级 MinerU。Loopback 部署和远程部署边界见 [MinerU 接入注意事项](../notes/mineru.md)。

### 10.2 分析一个版本

```bash
uv run --frozen sciretriever --config config.toml analyze \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --storage-root ../SciRetriever-runtime/storage \
  --work-version-id <WORK_VERSION_ID>
```

批量补齐 pending analysis：

```bash
uv run --frozen sciretriever --config config.toml analyze \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --storage-root ../SciRetriever-runtime/storage \
  --all-pending \
  --limit 100
```

### 10.3 强制替换 current analysis

```bash
uv run --frozen sciretriever --config config.toml analyze \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --storage-root ../SciRetriever-runtime/storage \
  --work-version-id <WORK_VERSION_ID> \
  --force
```

`--force` 跳过 metadata 和 acquisition，构建下一 revision。只有完整新结果通过 evidence 和 promotion gate 后才会原子替换 current analysis；失败时旧结果和原有 COMPLETE 状态继续可用。

## 11. 一条命令完成搜索、下载或分析

`search --level` 可以控制停止点：

| Level | 停止位置 | 额外要求 |
|---|---|---|
| `metadata` | metadata 入库 | catalog |
| `download` | accepted primary PDF | catalog、storage root、acquisition 配置 |
| `analyze` | COMPLETE | catalog、storage root、MinerU 和 LLM 配置 |

例如：

```bash
uv run --frozen sciretriever --config config.toml search \
  "solid-state electrolytes" \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --storage-root ../SciRetriever-runtime/storage \
  --level analyze \
  --limit 20
```

它只处理本次 search 持久化的 WorkVersion，不会隐式补全整个 catalog。

## 12. 引用关系与图扩展

查看一跳 references：

```bash
uv run --frozen sciretriever library references \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --work-id <WORK_ID>
```

反向引用使用 `library cited-by`，并且必须使用 `--work-id`：

```bash
uv run --frozen sciretriever library cited-by \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --work-id <WORK_ID>
```

从一个明确种子扩展引用图：

```bash
uv run --frozen sciretriever --config config.toml expand \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --storage-root ../SciRetriever-runtime/storage \
  --work-id <WORK_ID> \
  --direction references \
  --depth 2
```

种子必须是 `--work-id`、`--work-version-id` 或唯一 `--query` 三者之一。方向支持 `references`、`cited-by` 和 `both`。当前 graph provider 是 OpenAlex 与 Semantic Scholar。

`depth 0` 只核对种子当前事实，不调用 graph provider。更深层按 breadth layer 运行 completion；只有 COMPLETE 节点产生下一层 frontier。单个 branch 失败不会终止其它 branch。

## 13. 导出与处理快照

### 13.1 导出阅读视图

```bash
uv run --frozen sciretriever library export \
  --mode reading \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --work-id <WORK_ID> \
  --output ../SciRetriever-runtime/exports/reading.jsonl \
  --format jsonl \
  --include-light-content \
  --include-references
```

Reading export 只接受 `--work-id` 或 `--work-version-id`。输出包含 canonical projection、公开稳定标识符和显式请求的轻量内容，不暴露 provider record ID、storage path 或 raw reference。

### 13.2 发布 package snapshot

```bash
uv run --frozen sciretriever package \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --storage-root ../SciRetriever-runtime/storage \
  --work-id <WORK_ID>
```

也可以直接导出 package：

```bash
uv run --frozen sciretriever library export \
  --mode package \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --storage-root ../SciRetriever-runtime/storage \
  --work-version-id <WORK_VERSION_ID> \
  --output ../SciRetriever-runtime/exports/package.json
```

相同输入会复用既有 package；current analysis 替换后会生成新 snapshot。使用 `--package-version` 和 `--package-sha256` 可以精确重导出旧快照。

## 14. 人工整理、审计与撤销

`library` 提供以下显式整理入口：

- `review`：查询或解决 review item；
- `merge-work`：合并两个明确 Work；
- `regroup-version`：移动一个明确 WorkVersion；
- `preferred set|clear`：设置或清除 preferred version；
- `metadata set|clear`：设置或清除 manual metadata；
- `tag add|remove`：增删 manual tag；
- `author merge`：合并明确的 Author identity；
- `audit`：读取安全审计记录；
- `undo`：按原 operation ID 撤销操作。

人工操作只接受明确 UUID，不会隐式作用于全库。合并示例：

```bash
uv run --frozen sciretriever --no-config library merge-work \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --source-work-id <SOURCE_WORK_ID> \
  --target-work-id <TARGET_WORK_ID> \
  --evidence decision=user_confirmed
```

查看并撤销：

```bash
uv run --frozen sciretriever --no-config library audit \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --operation-id <OPERATION_ID>

uv run --frozen sciretriever --no-config library undo \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --operation-id <OPERATION_ID>
```

成功操作输出确定性 JSON。解析错误通常返回 2，冲突、stale 或 no-op 返回 3，其它运行失败返回 1。

## 15. 查询失败和运行计数

查询某个 WorkVersion 最新失败：

```bash
uv run --frozen sciretriever failures \
  --catalog ../SciRetriever-runtime/catalog.sqlite \
  --work-version-id <WORK_VERSION_ID> \
  --latest
```

可组合 `--stage`、`--role`、`--source`、`--reason`、`--action`、`--retryable` 和 `--outcome`。`--all` 返回全部匹配历史；`--details` 只对 acquisition 展开经过脱敏的 source details。原始 URL、header、query、秘密值和正文不会进入输出。

前台 completion batch 使用统一计数：

- `selected`：所选目标总数；
- `unique_targets`：去除 duplicate 后的目标数；
- `succeeded`：到达请求停止点；
- `exhausted`：来源耗尽但没有到达停止点；
- `failed`：运行失败；
- `duplicates`：重复目标；
- `interrupted`：因中断未继续处理。

PDF missing 计为 `exhausted`/`missing`，不计为 `succeeded`/`accepted`。

## 16. 中断与幂等重跑

长批处理收到 Ctrl+C 后会停止领取新目标，并保留已经提交的 catalog 事实和不可变资产。命令返回稳定的中断结果；`expand` 的中断退出码为 130。

恢复时重新执行同一命令即可。SciRetriever 会复用已有 observation、RawAsset、current analysis 和 frontier，不承诺从每个网络请求的内部断点继续，也不提供 daemon、pause/resume 或 durable job 控制。

## 17. Preflight 与常见排障

### 17.1 Acquisition preflight

```bash
uv run --frozen sciretriever --config config.toml preflight
```

如果 `[acquisition.preflight].readiness = "headers"`，可对明确 HTTPS URL 执行不读取响应正文的 headers readiness：

```bash
uv run --frozen sciretriever --config config.toml preflight \
  --url https://example.org/article.pdf
```

### 17.2 常见问题

| 现象 | 检查方法 |
|---|---|
| `config check` 拒绝未知字段 | 对照 `config.example.toml` 删除未接受字段，不保留旧配置接口 |
| 配置文件权限错误 | 对包含 `[credentials]` 的文件执行 `chmod 600 config.toml` |
| Search 部分 provider 失败 | 查看命令 JSON 和 `failures --stage metadata`；成功 provider 结果仍可能已入库 |
| Download 返回 missing | 区分无候选、网络失败、身份不符和内容验证失败；使用 `failures --stage acquisition --details` |
| HTTP 200 仍未接受 PDF | 检查 MIME、文件结构、大小和文章身份；状态码不等于资产成功 |
| XML/HTML 已存在但仍是 ASSET_PENDING | 这是预期行为；primary PDF 是 required asset |
| Analyze 不推进 | 确认只有一份 accepted primary PDF、MinerU/LLM 配置完整并运行 `config check --runtime` |
| MinerU task 丢失 | 外部 task 可能过期或服务重启；重跑会在同一 deterministic processing run 下创建新 attempt |
| `--force` 失败 | 旧 current analysis 应继续可用；查询 analysis failure 后修复配置或服务再重跑 |
| OpenAlex 匿名访问不稳定 | 当前实现尚未接入官方 key；不要把临时匿名成功视为稳定契约 |

Provider 认证、限流和逐机构排障见 [Provider 接入注意事项](../notes/providers.md)。MinerU 部署、readiness、任务恢复和升级门见 [MinerU 接入注意事项](../notes/mineru.md)。

## 18. 数据与安全边界

- RawAsset 永不原地修改；重复内容按 hash 复用。
- Catalog 不保存文献 BLOB 或绝对资产路径。
- 不要把 catalog、storage、下载资产、用户语料或秘密值放入代码仓库。
- Browser fallback 默认关闭，不支持运行中交互登录或 CAPTCHA。
- Browser profile 必须由 operator 在 SciRetriever 外准备，权限为 owner-only `0700`，且不能位于 storage tree 中。
- Remote MinerU 必须使用 HTTPS、认证和显式 remote upload acknowledgement。
- SciRetriever 不对内容访问授权作法律判断；operator 负责确认 endpoint、凭据和语料的使用权限。
- Runtime URL、header、query、profile/session 和秘密值不得进入诊断或 package lineage。

## 19. 命令速查

| 目标 | 命令 |
|---|---|
| 创建 catalog | `sciretriever catalog create` |
| 生成只读发现清单 | `sciretriever discover` |
| 搜索并写入本地库 | `sciretriever search` |
| 补全 PDF/XML/HTML | `sciretriever download` |
| 导入已有资产 | `sciretriever catalog import-asset` |
| 生成或替换 current analysis | `sciretriever analyze` |
| 扩展引用图 | `sciretriever expand` |
| 查询、整理与导出 | `sciretriever library` |
| 查询失败历史 | `sciretriever failures` |
| 检查 acquisition 策略 | `sciretriever preflight` |
| 检查配置与 runtime identity | `sciretriever config check` |
| 发布处理快照 | `sciretriever package` |

当前已实现能力以项目 [`README`](../../README.md)、CLI `--help`、源码和测试为准。
