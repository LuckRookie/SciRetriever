# SciRetriever 配置手册

本文是当前 `schema_version = 1` 的完整用户配置手册。本目录 [`config.toml`](config.toml) 是覆盖全部字段的完整注释模板；[`config.minimal.toml`](config.minimal.toml) 是保留全部凭据入口、但省略高级调优项的最小可用模板。仓库根目录 `config.toml` 是当前工作区的个人运行配置，不承担公开模板职责。下文为每个字段直接给出类型、默认行为、示例值、约束、使用命令和安全边界。

下一版 `schema_version = 2` 的冻结配置合同由 [`config.target.toml`](config.target.toml) 和 [`config.target.minimal.toml`](config.target.minimal.toml) 记录，责任组固定为 `paths`、`collection`、`sources`、`assets`、`parsing`、`analysis`、`execution`、`library`、`access` 和 `credentials`。当前合同的 `access` 组必须为空表；访问策略由下游 access 模块处理，不接受未定义的配置字段。它只保存 `env:VARIABLE_NAME` 形式的 secret reference；分析协议必须显式选择 `openai` 或 `anthropic`，不得由 URL 或模型名推断。当前 CLI runtime 尚未切换到该合同，不能把目标模板用于当前命令。

## 1. 配置如何生效

SciRetriever 按以下顺序选择配置文件：

1. 命令行 `--config PATH`；
2. 环境变量 `SCIRETRIEVER_CONFIG`；
3. 当前目录已有的 `./config.toml`；
4. 没有选中配置文件时，使用命令行参数和内置默认值。

`--no-config` 会禁用第 2、3 项。单个设置的优先级是：显式 CLI 参数高于 TOML，TOML 高于命令内置默认值。CLI 覆盖只影响当前 invocation，不会回写文件。

配置是严格接口：未知 section、未知字段、错误类型、重复数组值和不满足约束的组合都会被拒绝。解析不会创建目录或文件。

```bash
sciretriever --config config.toml config check
```

默认 check 是 offline，不访问 provider。只有显式增加 `--runtime` 才会执行有界、只读的 capability identity/readiness probe。

## 2. 文件与秘密安全

- 配置文件必须是普通、非符号链接文件，最大 1 MiB。
- 相对路径以配置文件所在目录为基准，不以启动 CLI 的目录为基准。
- `[credentials]` 中只要出现一个真实值，POSIX 权限就必须为 `0600` 或更严格。
- 优先使用环境变量保存 Provider 密钥；环境变量值优先于 `[credentials]` 同名值。
- `analysis.mineru.auth_env` 和 `analysis.llm.credential_env` 保存的是环境变量名称，不是秘密本身。
- 不要提交真实凭据、运行时 URL、header、query、浏览器 profile 或用户语料。

## 先从可运行场景开始

下面的示例按能力逐级增加。推荐把 metadata、download 和 analyze 分成三个独立命令，后一阶段只消费 catalog 和 storage 中已经提交的事实。先选择最接近目标的场景，运行 offline check，再查阅后面的逐字段参考微调参数。

### 场景 A：只做 metadata 建库

这是最适合首次运行的配置，不需要 API key：

```toml
schema_version = 1
document_start_interval_seconds = 30.0

[paths]
catalog = "../SciRetriever-runtime/catalog.sqlite"
storage_root = "../SciRetriever-runtime/storage"

[discovery]
sources = ["crossref", "europe-pmc", "arxiv"]
limit = 1000
timeout = 30.0
taxonomy = "literature-topic"
taxonomy_version = "1"
crossref_mailto = "you@example.org"

[search]
level = "metadata"
limit = 1000
completion_limit = 100
providers = ["crossref", "europe-pmc", "arxiv"]
precedence = ["crossref", "europe-pmc", "arxiv"]
provider_timeout = 30.0
max_concurrency = 3
crossref_mailto = "you@example.org"
```

```bash
sciretriever --config config.toml config check
sciretriever --config config.toml catalog create
sciretriever --config config.toml search "solid-state electrolytes" --level metadata
```

这里显式写出当前默认值，便于核对公开合同。首次冒烟可以在命令行传更小的 `--limit`，但推荐的长期流程仍是先积累 metadata，再单独运行 download 和 analyze。

### 场景 B：加入 Semantic Scholar 和 Elsevier metadata

先在当前 shell 提供密钥。Crossref 只有联系邮箱，没有 API key：

```bash
export SCIRETRIEVER_SEMANTIC_SCHOLAR_API_KEY="真实 Semantic Scholar key"
export SCIRETRIEVER_ELSEVIER_API_KEY="真实 Elsevier key"
```

然后在场景 A 基础上替换以下字段。`providers` 和 `precedence` 必须同时修改且名称完全一致：

```toml
[discovery]
sources = ["crossref", "europe-pmc", "arxiv", "semantic-scholar", "elsevier"]
limit = 1000
timeout = 30.0
taxonomy = "literature-topic"
taxonomy_version = "1"
crossref_mailto = "you@example.org"

[search]
level = "metadata"
limit = 1000
completion_limit = 100
providers = ["crossref", "europe-pmc", "arxiv", "semantic-scholar", "elsevier"]
precedence = ["crossref", "europe-pmc", "arxiv", "semantic-scholar", "elsevier"]
provider_timeout = 30.0
max_concurrency = 5
crossref_mailto = "you@example.org"
```

运行 offline check 只验证密钥是否存在，不向 Provider 发请求；需要检查 capability identity 时再显式增加 `--runtime`。

### 场景 C：获取公开 primary PDF

在场景 A 或 B 的基础上增加：

```toml
[acquisition]
providers = ["direct", "arxiv", "crossref", "europe-pmc", "semantic-scholar", "elsevier"]
timeout = 30.0
provider_concurrency = 3
host_concurrency = 2
host_min_interval = 0.5
max_asset_bytes = 104857600
include_xml = false
include_html = false

[acquisition.preflight]
min_free_bytes = 1073741824
max_asset_bytes = 104857600
readiness = "none"
timeout = 10.0
```

如需额外禁止明确 URL，先创建文本文件（每行一个 URL），再增加示例字段 `forbidden_urls = "./forbidden_urls.txt"`。没有该需求时省略字段，配置才能保持可直接运行。

```bash
sciretriever --config config.toml config check
sciretriever --config config.toml download --work-version-id <WORK_VERSION_ID>
```

如果没有 Semantic Scholar/Elsevier 凭据，就从 `acquisition.providers` 删除这两个名称；不要填写假的 key。批量 `download` 默认最多处理 100 个 WorkVersion，包括 `--all-missing` 选择器。

### 场景 D：使用本机 MinerU 和 LLM 分析 PDF

该场景假设 operator 已在 `127.0.0.1:8000` 运行兼容的 MinerU 3.4.4，并有一个 OpenAI-compatible HTTPS LLM endpoint：

```bash
export SCIRETRIEVER_LLM_API_KEY="真实 LLM key"
```

```toml
[analysis.mineru]
mode = "loopback"
endpoint = "http://127.0.0.1:8000"
remote_upload = false
service_version = "3.4.4"
api_protocol = 2
backend = "vlm-engine"
model = "operator/model@revision"
overall_deadline = 900.0
poll_interval = 2.0

[analysis.llm]
endpoint = "https://llm.example.org/v1"
model = "analysis-model"
credential_env = "SCIRETRIEVER_LLM_API_KEY"
timeout = 120.0
max_output_tokens = 16384
max_input_characters = 200000
max_source_units = 5000
```

未写出的 MinerU 资源上限使用下文列出的 parser 默认值。先运行 runtime check，确认两个外部 capability 的身份和 readiness，再运行 analyze：

```bash
sciretriever --config config.toml config check --runtime
sciretriever --config config.toml analyze --work-version-id <WORK_VERSION_ID>
```

批量 `analyze --all-pending` 默认最多处理 100 个具备唯一 accepted primary PDF 且没有 current analysis 的 WorkVersion。Analysis 不会隐式启动 acquisition。

### 场景 E：使用远程 MinerU

远程模式会上传 PDF，因此必须显式提供 HTTPS origin、认证环境变量和上传确认：

```bash
export SCIRETRIEVER_MINERU_TOKEN="真实 MinerU token"
```

```toml
[analysis.mineru]
mode = "remote"
endpoint = "https://mineru.example.org"
auth_env = "SCIRETRIEVER_MINERU_TOKEN"
remote_upload = true
service_version = "3.4.4"
api_protocol = 2
backend = "vlm-engine"
model = "operator/model@revision"
overall_deadline = 900.0
poll_interval = 2.0
```

远程 endpoint 只能是默认 443 端口的固定 HTTPS origin。Operator 必须确认上传权限、数据边界和服务端保留策略。

## 两份 TOML 如何选择

- 首次建立 metadata 文献库：直接使用 `docs/guides/config.minimal.toml`。
- 配置全文来源、fallback、MinerU、LLM 或资源上限：以 `docs/guides/config.toml` 为模板。
- 查询单个字段：在本文字段表中搜索完整名称；每行都包含可填写的示例值。
- `config.toml` 中未启用的高级 capability 保持注释，避免占位 endpoint 或 key 被误当作真实配置。

## 独立阶段、批次默认值与协调边界

| 入口 | 默认上限 | 含义 |
|---|---:|---|
| `discover --limit` | 1000 | 合并后写入 manifest 的 metadata 结果 |
| `search --limit` | 1000 | 持久化到 catalog 的 metadata 结果 |
| `search --completion-limit` | 100 | 仅在显式 `--level download|analyze` 时送入深层 completion 的目标 |
| `download --limit` | 100 | acquisition 目标，包括 `--all-missing` |
| `analyze --limit` | 100 | analysis 目标 |

`search --level metadata` 是默认和推荐入口。`search --level download|analyze` 只是一种显式便捷方式，不会让未进入 `completion_limit` 前缀的 metadata 消失，也不会补全整个 catalog。

同一主机上，同一 catalog 同时最多运行一个 acquisition batch 和一个 analysis batch。两个不同阶段可以并行；同阶段冲突立即失败，并在持有进程退出后自动释放。这个本地协调不提供跨机器互斥，也不在 catalog 中保存 lease 或 workflow state。

`document_start_interval_seconds` 只控制相邻且确实需要 acquisition 的 WorkVersion 启动。它不限制 metadata、analysis、资产复用或同一 WorkVersion 内部的候选请求。

## 3. 根字段

| 字段 | 类型 | 默认/必需 | 示例值 | 说明与约束 |
|---|---|---|---|---|
| `schema_version` | integer | 必需，固定为 `1` | `1` | 配置 schema 版本；其它值拒绝。Boolean 不算 integer。 |
| `document_start_interval_seconds` | number | `30.0` | `30.0` | 相邻且确实需要 acquisition 的 WorkVersion 启动间隔，单位秒；必须有限且 `30 <= value <= 86400`，小于 30 直接拒绝。它不限制 metadata、analysis、资产复用或同一文献内部候选请求，也不是单个 HTTP timeout。 |

允许的根 section 只有：`paths`、`credentials`、`discovery`、`search`、`expansion`、`acquisition`、`analysis` 和 `package`。

## 4. `[paths]`

| 字段 | 类型 | 默认/必需 | 示例值 | 使用位置 |
|---|---|---|---|---|
| `catalog` | nonblank string path | 可选 | `"../SciRetriever-runtime/catalog.sqlite"` | SQLite catalog。供 `catalog`、`search`、`download`、`analyze`、`expand`、`library`、`failures` 和 `package` 使用。 |
| `storage_root` | nonblank string path | 可选 | `"../SciRetriever-runtime/storage"` | RawAsset、DerivedArtifact 和 package 资产的不可变存储根目录。 |

省略字段表示 TOML 不提供该路径，仍可通过命令行传入。目录必须由 operator 预先创建；配置解析本身不会创建目录。

## 5. `[credentials]`

| 字段 | 对应环境变量 | 示例值 | 用途 |
|---|---|---|---|
| `unpaywall_email` | `SCIRETRIEVER_UNPAYWALL_EMAIL` | `"you@example.org"` | Unpaywall 请求身份。 |
| `semantic_scholar_api_key` | `SCIRETRIEVER_SEMANTIC_SCHOLAR_API_KEY` | `"your-semantic-key"` | Semantic Scholar metadata、graph 和公开 PDF。 |
| `elsevier_api_key` | `SCIRETRIEVER_ELSEVIER_API_KEY` | `"your-elsevier-key"` | Elsevier metadata、PDF/XML。 |
| `wiley_api_key` | `SCIRETRIEVER_WILEY_API_KEY` | `"your-wiley-tdm-token"` | Wiley TDM PDF。 |
| `springer_api_key` | `SCIRETRIEVER_SPRINGER_API_KEY` | `"your-springer-key"` | Springer metadata、XML/HTML。 |

所有值都必须是非空字符串。Crossref 不使用 API key；其联系邮箱分别配置在 `discovery.crossref_mailto` 和 `search.crossref_mailto`。OpenAlex key 尚未接入当前 parser。

## 6. `[discovery]`

`discover` 与 `search` 共用 metadata 候选检索和匹配语义，但保留独立配置 section。`discover` 以 `sources` 顺序作为 effective precedence，只读比较 catalog 并发布 JSONL manifest，不创建 placeholder Work，也不提供 manifest import。

| 字段 | 类型 | 省略时 | 示例值 | 说明与约束 |
|---|---|---|---|---|
| `sources` | nonempty string array | 命令默认来源 | `["crossref", "europe-pmc", "arxiv"]` | 可选 `crossref`、`europe-pmc`、`arxiv`、`openalex`、`semantic-scholar`、`elsevier`、`springer`；不得重复。数组顺序决定 effective precedence。Elsevier/Springer 需要凭据。 |
| `limit` | positive integer | `1000` | `1000` | 本次最多返回的 metadata 结果数。Provider 仍可施加更小上限。 |
| `timeout` | positive finite number | 命令默认值 | `30.0` | 单个 provider timeout，单位秒。 |
| `taxonomy` | nonblank string | 命令默认值 | `"literature-topic"` | manifest 标签体系名称。 |
| `taxonomy_version` | nonblank string | 命令默认值 | `"1"` | 标签体系版本。 |
| `crossref_mailto` | nonblank string | 不发送 mailto | `"you@example.org"` | Crossref polite-pool 联系邮箱，不是 API key。 |

### `[discovery.filters]`

| 字段 | 类型 | 示例值 | 说明 |
|---|---|---|---|
| `year_from` | positive integer | `2020` | 起始年份，范围 1 到 9999。 |
| `year_to` | positive integer | `2026` | 结束年份，范围 1 到 9999，且不得早于 `year_from`。 |

### `[discovery.label_rules]`

这是动态表：每个 key 是标签名，每个值是 nonempty string array。词项任一命中时添加对应标签；标签和值都不得为空，数组不得重复。

```toml
[discovery.label_rules]
battery = ["electrolyte", "lithium"]
```

## 7. `[search]`

`search` 将共享检索得到的候选原子写入 catalog，默认只做 metadata。只有显式选择深层 `level` 时才继续 completion。`providers` 选择来源，独立的 `precedence` 决定字段优先级；这两个字段不会与 `[discovery]` 合并或相互继承。

| 字段 | 类型 | 省略时 | 示例值 | 说明与约束 |
|---|---|---|---|---|
| `level` | string enum | 命令默认值 | `"metadata"` | `metadata`、`download` 或 `analyze`。后两者需要 storage；`analyze` 还需要完整 analysis 配置。 |
| `limit` | positive integer | `1000` | `1000` | 本次最多持久化的 metadata 结果数。 |
| `completion_limit` | positive integer | `100` | `100` | 仅在 `level = "download"` 或 `"analyze"` 时限制深层目标；不减少 metadata 入库数量。精确 DOI 仍是单目标。 |
| `providers` | nonempty string array | 命令默认来源 | `["crossref", "europe-pmc", "arxiv"]` | 支持与 `discovery.sources` 相同的 7 个 provider，不得重复。 |
| `precedence` | nonempty string array | 跟随 providers | `["crossref", "europe-pmc", "arxiv"]` | 必须与 `providers` 同时出现，并且恰好包含相同名称；顺序决定字段冲突时的优先级。 |
| `provider_timeout` | positive finite number | 命令默认值 | `30.0` | 每个 metadata provider 的独立 timeout，单位秒。 |
| `max_concurrency` | positive integer | 命令默认值 | `3` | 同时运行的 metadata provider 数量上限。 |
| `crossref_mailto` | nonblank string | 不发送 mailto | `"you@example.org"` | Search 路径的 Crossref 联系邮箱。 |

### `[search.filters]`

普通 query 支持与 `[discovery.filters]` 相同的年份范围。每个选中的 provider 都接收相同过滤条件；不接受 publisher、subject、document type 或其它 provider-specific filter。精确 DOI search 忽略年份范围并保持单目标语义。

| 字段 | 类型 | 示例值 | 说明 |
|---|---|---|---|
| `year_from` | positive integer | `2020` | 起始年份，范围 1 到 9999。 |
| `year_to` | positive integer | `2026` | 结束年份，范围 1 到 9999，且不得早于 `year_from`。 |

## 8. `[expansion]`

| 字段 | 类型 | 默认 | 示例值 | 说明与约束 |
|---|---|---|---|---|
| `direction` | string enum | `references` | `"references"` | `references`、`cited-by` 或 `both`。 |
| `depth` | nonnegative integer | `0` | `1` | 引用图深度；0 只核对种子事实，不调用 graph provider。 |
| `providers` | nonempty string array | `openalex`, `semantic-scholar` | `["semantic-scholar"]` | 只接受这两个 graph provider，不得重复。 |
| `max_provider_calls` | positive integer | `10` | `5` | 单次 expansion 的 provider 调用预算。 |
| `page_size` | positive integer | `100` | `50` | 每页请求条数，上限 200。 |

## 9. `[acquisition]`

Acquisition 为 WorkVersion 获取、验证并不可变发布资产。第一层 provider 耗尽后，才依次进入 translator 和 browser fallback。

| 字段 | 类型 | 省略时 | 示例值 | 说明与约束 |
|---|---|---|---|---|
| `providers` | nonempty string array | 命令默认来源 | `["direct", "arxiv", "crossref", "europe-pmc"]` | 可选 `direct`、`arxiv`、`crossref`、`unpaywall`、`europe-pmc`、`openalex`、`semantic-scholar`、`elsevier`、`wiley`、`springer`、`sci-hub`；不得重复。 |
| `timeout` | positive finite number | 命令默认值 | `30.0` | 单次 provider 操作 timeout，单位秒。 |
| `provider_concurrency` | positive integer | 命令默认值 | `3` | 全局 provider 并发上限。 |
| `host_concurrency` | positive integer | 命令默认值 | `2` | 单个 hostname 的并发上限。 |
| `host_min_interval` | nonnegative finite number | 命令默认值 | `0.5` | 同一 hostname 两次请求启动的最小间隔，单位秒；允许 0。 |
| `max_asset_bytes` | positive integer | 命令默认值 | `104857600` | 单个候选响应允许读取和保存的最大字节数。 |
| `forbidden_urls` | nonblank path | 命令默认值 | `"./forbidden_urls.txt"` | 本地 URL 禁止清单路径，相对配置文件目录解析。 |
| `include_xml` | boolean | 命令默认值 | `false` | 是否在 primary PDF 成功/复用后尝试可选 XML。 |
| `include_html` | boolean | 命令默认值 | `false` | 是否在 primary PDF 成功/复用后尝试可选 HTML。 |

XML/HTML 不替代 primary PDF，也不改变四阶段完成判定。

### `[acquisition.preflight]`

| 字段 | 类型 | 默认 | 示例值 | 说明与约束 |
|---|---|---|---|---|
| `min_free_bytes` | nonnegative integer | 1 GiB | `1073741824` | storage 所在文件系统要求的最小可用空间；必须不小于 `max_asset_bytes`。 |
| `max_asset_bytes` | positive integer | 100 MiB | `104857600` | Preflight 使用的单资产上限。 |
| `readiness` | string enum | `none` | `"none"` | `none` 不联网；`headers` 允许对显式 `--url` 做不读取正文的 HEAD readiness。 |
| `timeout` | positive finite number | `10.0` | `10.0` | Headers readiness timeout，单位秒。 |

### `[acquisition.sci_hub]`

| 字段 | 类型 | 默认 | 示例值 | 说明与约束 |
|---|---|---|---|---|
| `enabled` | boolean | `false` | `true` | 必须与 `sci-hub` 是否出现在 `acquisition.providers` 完全一致。 |
| `base_url` | nonblank HTTPS URL | 无 | `"https://authorized-endpoint.example"` | 启用时必需；SciRetriever 不提供默认 endpoint。 |
| `allowed_pdf_hosts` | string array | 空 | `["authorized-pdf-host.example"]` | 可选精确 PDF hostname 白名单，不得重复。 |

Operator 负责确认 endpoint 和内容访问授权。

### `[acquisition.translator]` 与 `[[acquisition.translator.rules]]`

| 字段 | 类型 | 默认/必需 | 示例值 | 说明与约束 |
|---|---|---|---|---|
| `enabled` | boolean | `false` | `true` | 启用时 rules 必须非空；关闭时不得携带 rules。 |
| `rules[].name` | string | 每条必需 | `"example-publisher"` | 唯一小写名，匹配 `[a-z][a-z0-9-]{0,31}`。 |
| `rules[].landing_url_template` | string | 每条必需 | `"https://landing.example/article?doi={doi}"` | HTTPS 模板，必须且只能含一个 `{doi}` 或 `{doi_path}`。 |
| `rules[].allowed_landing_hosts` | string array | 空 | `["redirect.example"]` | 可选精确 landing/redirect hostname 白名单。 |
| `rules[].allowed_pdf_hosts` | string array | 空 | `["pdf.example"]` | 可选精确 PDF hostname 白名单。 |

Translator 只使用固定静态 HTML selector 白名单，不执行任意页面脚本。

### `[acquisition.browser]` 与 `[[acquisition.browser.rules]]`

| 字段 | 类型 | 默认/必需 | 示例值 | 说明与约束 |
|---|---|---|---|---|
| `enabled` | boolean | `false` | `true` | 启用时必须提供 profile 和至少一条 rule；关闭时不得携带 profile/rules。 |
| `profile_dir` | nonblank path | 启用时必需 | `"./private-browser-profile"` | 已存在、真实、owner-only `0700` 的 operator profile，必须位于 storage tree 外。 |
| `max_profile_bytes` | positive integer | 512 MiB | `536870912` | Profile 临时副本总字节上限，最大 4 GiB。 |
| `max_profile_files` | positive integer | 20000 | `20000` | Profile 临时副本文件数上限，最大 100000。 |
| `rules[].name` | string | 每条必需 | `"example-publisher"` | 唯一小写名，规则同 translator。 |
| `rules[].landing_url_template` | string | 每条必需 | `"https://landing.example/article?doi={doi}"` | 安全 HTTPS DOI 模板。 |
| `rules[].allowed_landing_hosts` | string array | 每条必需 | `["landing.example"]` | 精确 landing hostname 列表。 |
| `rules[].allowed_pdf_hosts` | string array | 每条必需 | `["pdf.example"]` | 精确 PDF hostname 列表。 |
| `rules[].allowed_network_hosts` | string array | 每条必需 | `["landing.example", "pdf.example", "assets.example"]` | 页面运行期允许访问的精确 hostname 列表。 |

每次 invocation 使用 profile 的受限临时副本，不修改原 profile；不支持运行中交互登录或 CAPTCHA。

## 10. `[analysis.mineru]`

省略整个 section 时 MinerU 为 `disabled`。启用 analysis 还必须同时配置 `[analysis.llm]`。

| 字段 | 类型 | 默认 | 示例值 | 说明与约束 |
|---|---|---|---|---|
| `mode` | string enum | `disabled` | `"loopback"` | `disabled`、`loopback`、`remote`。Disabled 不得携带 endpoint/auth/model。 |
| `endpoint` | URL | 无 | `"http://127.0.0.1:8000"` | 启用时必需。Loopback 只允许显式 loopback HTTP；remote 只允许非 loopback、默认 443 端口的 HTTPS origin。 |
| `auth_env` | env-name string | 无 | `"SCIRETRIEVER_MINERU_TOKEN"` | Remote 必需，loopback 禁止；必须匹配大写环境变量名称格式。 |
| `remote_upload` | boolean | `false` | `false` | Remote 必须为 `true`，loopback 必须为 `false`。 |
| `service_version` | string | `3.4.4` | `"3.4.4"` | 当前固定为 `3.4.4`。 |
| `api_protocol` | integer | `2` | `2` | 当前固定为 `2`。 |
| `backend` | string | `vlm-engine` | `"vlm-engine"` | 当前固定为 `vlm-engine`。 |
| `model` | nonblank string | 无 | `"operator/model@revision"` | 启用时必需，记录 operator 部署的精确模型标识。 |
| `overall_deadline` | positive number | `900.0` | `900.0` | 单次解析总 deadline，单位秒。 |
| `poll_interval` | positive number | `2.0` | `2.0` | 轮询间隔，单位秒，不得超过 overall deadline。 |

### MinerU 资源上限

| 字段 | 默认 | parser 最大值 | 示例值 | 含义 |
|---|---:|---:|---:|---|
| `max_archive_bytes` | 512 MiB | 2 GiB | `536870912` | 返回 archive 字节。 |
| `max_json_bytes` | 128 MiB | 512 MiB | `134217728` | 单个 JSON 字节。 |
| `max_pages` | 2000 | 10000 | `2000` | 页数。 |
| `max_blocks` | 500000 | 2000000 | `500000` | Block 数。 |
| `max_spans` | 2000000 | 10000000 | `2000000` | Span 数。 |
| `max_text_characters` | 100000000 | 500000000 | `100000000` | 总文本字符。 |
| `max_image_bytes` | 64 MiB | 256 MiB | `67108864` | 单图片字节。 |
| `max_archive_files` | 10000 | 100000 | `10000` | Archive 文件数。 |
| `max_extracted_bytes` | 1 GiB | 4 GiB | `1073741824` | 总解压字节。 |
| `max_file_bytes` | 256 MiB | 1 GiB | `268435456` | 单文件字节，且不得超过 `max_extracted_bytes`。 |
| `max_compression_ratio` | 200 | 1000 | `200` | 压缩比。 |
| `max_images` | 5000 | 50000 | `5000` | 图片数量。 |
| `max_json_depth` | 100 | 500 | `100` | JSON 深度。 |
| `max_json_elements` | 2000000 | 10000000 | `2000000` | JSON 元素数。 |
| `max_json_string_characters` | 100000000 | 500000000 | `100000000` | 单 JSON 字符串字符。 |
| `max_upload_bytes` | 100 MiB | 1 GiB | `104857600` | Remote PDF 上传字节。 |
| `max_attempts` | 3 | 100 | `3` | 同一 deterministic processing run 的 attempt 上限。 |

这些字段都必须是 positive integer。

## 11. `[analysis.llm]`

只要 section 存在，`endpoint`、`model` 和 `credential_env` 就必须同时填写。

| 字段 | 类型 | 默认 | 示例值 | 说明与约束 |
|---|---|---|---|---|
| `endpoint` | HTTPS base URL | 无 | `"https://llm.example.org/v1"` | 必需；使用 DNS hostname、默认 443 端口，不允许 credential、query、fragment、IP literal 或 loopback。可带安全路径前缀。 |
| `model` | nonblank string | 无 | `"analysis-model"` | 必需；OpenAI-compatible provider 的模型 ID。 |
| `credential_env` | env-name string | 无 | `"SCIRETRIEVER_LLM_API_KEY"` | 必需；保存 API key 的环境变量名称，不保存 key。 |
| `timeout` | positive number | `120.0` | `120.0` | 请求 timeout，单位秒，上限 600。 |
| `max_output_tokens` | positive integer | 16384 | `16384` | 输出 token 上限，parser 最大 131072。 |
| `max_input_characters` | positive integer | 200000 | `200000` | 输入字符上限，parser 最大 2000000。 |
| `max_source_units` | positive integer | 5000 | `5000` | Evidence/source unit 上限，parser 最大 100000。 |

## 12. `[package]`

这些字段控制 `DocumentPackageVersion` 发布时的拒绝边界；全部必须是 positive integer。省略字段表示 TOML 不覆盖命令内置值。

| 字段 | 示例值 | 说明 |
|---|---:|---|
| `max_input_bytes` | `67108864` | 单个归一化输入允许的最大字节数。 |
| `max_pages` | `2000` | 最多页数。 |
| `max_structural_units` | `100000` | 最多结构单元数。 |
| `max_depth` | `256` | JSON/结构树最大深度。 |
| `max_elements` | `500000` | JSON/结构树最大元素数。 |
| `max_text_characters` | `20000000` | 规范化文本最大字符数。 |

根目录试用模板使用 64 MiB、2000 页、100000 个结构单元、深度 256、500000 个元素和 20000000 个文本字符。

## 13. Provider 与凭据组合

| Provider | Metadata | Graph | Acquisition | 凭据要求 |
|---|---:|---:|---:|---|
| Crossref | 是 | 否 | 是 | 无 key；建议 mailto。 |
| Europe PMC | 是 | 否 | 是 | 无。 |
| arXiv | 是 | 否 | 是 | 无。 |
| OpenAlex | 是 | 是 | 是 | 当前 key 未接入，匿名访问可能不稳定。 |
| Semantic Scholar | 是 | 是 | 是 | Key 可选但建议配置。 |
| Elsevier | 是 | 否 | 是 | API key 必需。 |
| Springer Nature | 是 | 否 | 是 | API key 必需。 |
| Unpaywall | 否 | 否 | 是 | Email 必需。 |
| Wiley | 否 | 否 | 是 | TDM token 必需。 |
| Direct HTTPS | 否 | 否 | 是 | 无，必须有明确 HTTPS locator。 |
| Sci-Hub | 否 | 否 | 是 | 无默认 endpoint，必须由 operator 显式授权和配置。 |

## 14. 推荐修改流程

1. 以 `docs/guides/config.toml` 的三家 metadata 和四家 acquisition 安全基线开始。
2. 填写 Crossref mailto，并通过环境变量提供所需 Provider 凭据。
3. 同时修改 `search.providers` 与 `search.precedence`；两者必须包含相同名称。
4. 运行 offline check，修复所有 schema、路径、权限和凭据引用问题。
5. 只有确实需要验证外部 capability 时才运行 runtime check。
6. 先执行 metadata-only search，再分别运行 download 和 analyze；只有明确需要时才使用 deep search。

```bash
sciretriever --config config.toml config check
sciretriever --config config.toml config check --runtime
```

命令参数的最终解释以 `sciretriever <command> --help` 为准；Provider 的外部限制与最后核对事实见 [Provider 接入注意事项](../notes/providers.md)，MinerU 部署边界见 [MinerU 接入注意事项](../notes/mineru.md)。
