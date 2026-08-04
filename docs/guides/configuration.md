# SciRetriever 配置手册

本文说明当前 `schema_version = 2` 配置合同。配置模型的结构真相源是 `src/sciretriever/model/configuration.py`，TOML、环境变量和 secret reference 的读取责任属于 `src/sciretriever/composition/configuration/`，具体实现选择和对象图属于 `src/sciretriever/composition/wiring/`。

SciRetriever 目前没有受支持的终端用户 CLI，因此本文不提供历史配置检查、批处理或其它命令示例。配置只供 Composition 构造程序内 Service 对象图使用。

## 严格合同

根字段 `schema_version` 必须是整数 `2`。其余配置固定分成十组：

```text
paths
collection
sources
assets
parsing
analysis
execution
library
access
credentials
```

十组都必须存在。未知组、未知字段、错误类型、未知协议枚举、空 provider 数组、空名称和重复名称会被拒绝。Pydantic 模型是 strict、frozen 且 `extra="forbid"`，配置解析不会静默接纳拼写错误。

Provider 名称先由 Composition 按当前允许集合检查，再作为 wiring 的选择键。通过配置检查不等于生产 adapter 已经接入。当前具体 provider clients 和有界 transport 由调用方通过 `ProviderDependencies` 注入，provider registry 也没有连接到 Collection 或 Assets Service。只有 wiring 已连接到对应 Service Port 的实现才可运行。

## 配置选择与读取

`sciretriever.composition.configuration` 是公开的程序内配置入口。主要函数为：

| 函数 | 行为 |
|---|---|
| `load_configuration(path)` | 从一个显式 TOML 文件加载并验证配置，不解析 secret 值。 |
| `parse_configuration(payload, base_dir=...)` | 从 TOML 文本或字节解析，不读取配置文件或环境变量。 |
| `load_selected_configuration(...)` | 按公开顺序选择文件，再调用严格加载。 |

`load_selected_configuration` 的选择顺序是：

1. 程序传入的显式路径；
2. `SCIRETRIEVER_CONFIG` 指定的路径；
3. 当前目录中已经存在的 `config.toml`。

三项都没有时抛出 `FileNotFoundError`，不会退回一组隐式运行默认值。该顺序只用于配置文件选择，不代表单个字段有额外覆盖层。当前没有命令行覆盖合同。

配置文件必须是普通文件，不能是符号链接，大小不能超过 1 MiB。加载时通过一个有界、经身份复核的文件描述符读取，不会为读取内容重新打开路径。`parse_configuration` 使用调用方提供的 `base_dir` 解析相对运行路径，省略时使用当前目录。

## Secret reference

配置只能保存 secret reference，不能保存秘密值。引用格式为：

```text
env:VARIABLE_NAME
```

变量名必须以大写英文字母开头，后续只能使用大写英文字母、数字或下划线。以下字段接受引用：

| 字段 | 必需条件 |
|---|---|
| `parsing.secret_ref` | Remote 必需，loopback 禁止 |
| `analysis.secret_ref` | 必需 |
| `credentials.metadata` | 可选 |
| `credentials.acquisition` | 可选 |

Model 只持有引用字符串，`load_configuration` 和 `parse_configuration` 都不解析 secret 值。Composition 提供 `EnvironmentSecretResolver`，只在调用方显式请求时从引用指定的环境变量取得非空值。解析后的值不写回配置模型。具体 adapter 还必须限制允许携带凭据的 origin。Secret 值不得进入 Model、SQLite、provenance、diagnostics、URL、文件名或用户输出。

## 根字段

| 字段 | 类型 | 必需值 | 说明 |
|---|---|---|---|
| `schema_version` | integer | `2` | 其它版本拒绝，Boolean 不算 integer。 |

## `[paths]`

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `catalog` | path | 必需 | SQLite catalog 文件。 |
| `storage_root` | path | 必需 | 不可变资产和派生产物的存储根目录。 |

相对路径以配置文件所在目录为基准，不能包含 `..`。解析后的运行路径必须是规范绝对路径并位于仓库外，`catalog` 与 `storage_root` 不能相同或互相包含。每个已有组件都通过 `lstat` 检查，不能是符号链接或非目录祖先。任何 group/world 可写祖先都会被拒绝；仅 root/当前用户拥有的 sticky world-writable 目录可以在后面存在当前用户拥有、group/world 不可写的 0700-like 锚点时例外通过。最深已有组件必须由当前用户拥有且不能对 group/world 开放写权限。已有 catalog 必须是单硬链接的普通文件，已有 storage root 必须是目录。

## `[collection]`

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `citation_providers` | nonempty string array | 必需 | 引用来源选择键，不得为空或重复。 |
| `topic_limit` | integer | `1000` | 主题收集上限，范围 1 到 100000。 |
| `citation_max_new` | integer | `1000` | 单次引用扩展最大新增量，范围 1 到 100000。 |

当前 citation provider 只接受 `openalex` 和 `semantic-scholar`。允许集合不代表对应生产 adapter 已由 wiring 连接。

## `[sources]`

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `providers` | nonempty string array | 必需 | Metadata 来源选择键，不得为空或重复。 |
| `timeout_seconds` | number | `30.0` | 正数，最大 3600 秒。 |
| `max_concurrency` | integer | `4` | 范围 1 到 64。 |
| `result_limit` | integer | `1000` | 范围 1 到 100000。 |

当前只接受 `crossref`、`europe-pmc`、`arxiv`、`openalex`、`semantic-scholar`、`elsevier` 和 `springer`。名称获准只说明配置合同认识该选择键，不代表对应生产 adapter 已由 wiring 连接。

## `[assets]`

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `providers` | nonempty string array | 必需 | 资产来源选择键，不得为空或重复。 |
| `timeout_seconds` | number | `30.0` | 正数，最大 3600 秒。 |
| `provider_concurrency` | integer | `4` | 范围 1 到 64。 |
| `host_concurrency` | integer | `2` | 范围 1 到 16。 |
| `max_asset_bytes` | integer | `104857600` | 范围 1024 到 2147483648 字节。 |

当前只接受 `direct`、`arxiv`、`crossref`、`unpaywall`、`europe-pmc`、`openalex`、`semantic-scholar`、`elsevier`、`wiley`、`springer` 和 `sci-hub`。Sci-Hub 没有默认 endpoint，允许集合也不代表任何 endpoint 已配置或获授权。

配置 provider 只允许 Composition 尝试构造对应 adapter。网络响应仍必须经过 Access 安全边界和 Core 资产验收，不能把 HTTP 成功直接当作文献资产成功。

## `[parsing]`

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `protocol` | enum | 必需 | `loopback` 或 `remote`。 |
| `base_url` | string | 必需 | Parser 服务地址，最长 2048 字符。 |
| `model` | nonblank, whitespace-free string | 必需 | Operator 部署的模型标识，最长 256 字符。 |
| `secret_ref` | secret reference | 条件必需 | Remote 必需，loopback 禁止。 |
| `timeout_seconds` | number | `900.0` | 正数，最大 3600 秒。 |
| `remote_upload` | boolean | `false` | Remote 必须为 `true`，loopback 必须为 `false`。 |
| `max_pages` | integer | `2000` | 范围 1 到 10000。 |
| `max_blocks` | integer | `500000` | 范围 1 到 2000000。 |
| `max_source_units` | integer | `100000` | 范围 1 到 1000000。 |

Loopback parser 只接受 `http` 和精确的 `localhost` 或解析为 loopback 的 IP host，并禁止 remote upload 与 secret reference。Remote parser 必须使用 `https` 和 DNS hostname（不接受任何 IP literal 或 terminal-dot/empty-label host），同时提供 secret reference 并明确允许上传。

当前 parser Infrastructure 包含 MinerU adapter，但 MinerU 始终由 operator 管理。SciRetriever 不安装、启动、停止、重载或升级服务。使用 remote parser 前，operator 必须确认文献上传授权、数据边界和服务端保留策略。

## `[analysis]`

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `protocol` | enum | 必需 | `openai` 或 `anthropic`，不能从 URL 或模型名推断。 |
| `base_url` | string | 必需 | 必须使用 DNS hostname 的非 loopback HTTPS base URL，最长 2048 字符，端口只能省略或为 443，不接受 IP literal。 |
| `model` | nonblank, whitespace-free string | 必需 | 模型标识，最长 256 字符。 |
| `secret_ref` | secret reference | 必需 | 只保存引用，不保存 API key。 |
| `timeout_seconds` | number | `120.0` | 正数，最大 3600 秒。 |
| `max_output_tokens` | integer | `16384` | 范围 1 到 131072。 |
| `max_input_characters` | integer | `200000` | 范围 1 到 10000000。 |
| `max_source_units` | integer | `5000` | 范围 1 到 100000。 |

Parser 和 analysis 的 `base_url` 都拒绝 credential、query、fragment、控制字符、terminal-dot/empty-label/percent host、畸形或非 UTF-8 percent escape、解码后的 whitespace/control、不安全的路径跳转和编码后的路径分隔符。Analysis 地址还必须使用 HTTPS、DNS hostname（不接受 IP literal），端口只能省略或为 443。

## `[execution]`

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `max_targets` | integer | `1000` | 范围 1 到 100000。 |
| `max_concurrency` | integer | `4` | 范围 1 到 64。 |

该组可以是空表，此时使用以上默认值。它只限制当前程序内执行用例，不承诺任何 CLI 批处理入口。

## `[library]`

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `max_input_bytes` | integer | `67108864` | 范围 1024 到 1073741824 字节。 |
| `max_records` | integer | `100000` | 范围 1 到 1000000。 |
| `namespaces` | string array | `[]` | 小写命名空间，不得重复；每项必须匹配 `[a-z][a-z0-9.-]{0,127}`。 |
| `max_results` | integer | `100` | 范围 1 到 1000。 |

该组可以是空表。书目查询、导入和导出是否可用，仍取决于 Composition 是否连接了对应 Service Ports 与 IO codec。

## `[access]`

当前合同要求空表：

```toml
[access]
```

任何字段都会因 unknown key 被拒绝。URL、DNS、redirect、origin、budget 和 redaction 由 Access 实现及其业务调用边界控制，不能通过未定义配置项绕过。

## `[credentials]`

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `metadata` | secret reference | `null` | 可选的 metadata 凭据引用。 |
| `acquisition` | secret reference | `null` | 可选的资产获取凭据引用。 |

该组可以是空表。不要在 TOML 中写 API key、token、cookie、Authorization header 或其它解析后的凭据。

## 最小结构示意

下面只展示组结构和 secret reference 语法，不是可直接运行的环境配置，也不代表示例 provider 已接入生产 adapter：

```toml
schema_version = 2

[paths]
catalog = "~/.sciretriever/catalog.sqlite"
storage_root = "~/.sciretriever-assets"

[collection]
citation_providers = ["openalex"]

[sources]
providers = ["crossref"]

[assets]
providers = ["direct"]

[parsing]
protocol = "loopback"
base_url = "http://127.0.0.1:8000"
model = "operator/model-revision"

[analysis]
protocol = "openai"
base_url = "https://llm.example.org/v1"
model = "operator-analysis-model"
secret_ref = "env:SCIRETRIEVER_ANALYSIS_SECRET"

[execution]
[library]
[access]
[credentials]
```

示例路径会从当前用户主目录展开。Operator 必须确认最终位置在仓库外，由当前用户拥有且权限合规。示例 provider 是配置允许的选择键，但是否可运行仍以 wiring 中实际连接的 adapter 为准。

Provider 和 MinerU 的实际可用性以当前 Composition wiring、具体 adapter 与直接测试为准。配置允许的名称不能单独证明外部能力已经接入。
