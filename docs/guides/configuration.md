# SciRetriever 配置手册

SciRetriever 把配置分成三条互不替代的边界：

- 普通运行设置写在一个用户选择的 TOML 文件中；
- Provider 凭据只写在固定的 `~/.sciretriever/credentials.toml`；
- MinerU 和 Analysis 的运行密钥只从固定环境变量读取。

普通配置和凭据都由根级 `sciretriever.configuration` 读取，根级
`sciretriever.bootstrap` 再按当前命令需要的能力组装生产对象。普通配置模型严格、
不可变、拒绝未知字段，而且不包含任何 secret。当前没有文件级版本字段、普通配置内的
凭据组或凭据引用、动态 endpoint、runtime factory，也不保留旧配置兼容层。

## 1. 选择普通配置文件

安装后的 `sciretriever` 命令按以下顺序选择普通配置文件：

1. 程序内调用显式传入的路径；当前终端 CLI 没有对应的全局路径选项；
2. `SCIRETRIEVER_CONFIG` 环境变量指向的路径；
3. 当前工作目录中已经存在的 `config.toml`。

三处都没有时稳定失败；程序不会退回隐式配置文件或在当前目录自动生成一份。
即使只执行 `config status` 或 `config test`，也必须先选中一个普通配置文件。

普通配置文件必须是 UTF-8 TOML、普通非符号链接文件，且不超过 1 MiB。读取通过
一个有界文件描述符完成并复核文件身份，路径或内容在读取期间发生替换时会
fail closed。普通配置文件本身没有凭据文件那套 `0600` 强制要求，但其中不应写入
任何 secret。

一个零字节文件是合法 TOML，并等价于九个空配置组；这只证明结构可解析。空配置
没有 Storage 路径、Metadata 扫描上限、Parser 或 Analysis 参数，也没有启用任何
Provider。`config status` 仍可据此输出本地 capability 矩阵，但所有当前业务 Entry scope
都会先返回 `paths-not-ready`，不会把空结构解释成完整默认运行环境。

## 2. 普通配置的九组合同

普通配置只接受以下九个顶层组；九组都可省略，并由严格模型补成空组或字段默认值：

```text
paths
discovery
sources
assets
parsing
analysis
execution
library
access
```

未知顶层组、未知字段、错误类型、未知枚举、重复 Provider、重复 TOML key 和旧字段都会
被拒绝。`providers` 数组可以为空；它表示当前未启用对应 Provider，而不是使用一组
隐式 Provider。

### `[paths]`

| 字段 | 类型 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `catalog_path` | 非空字符串或省略 | 未配置 | SQLite Catalog 文件路径。 |
| `artifact_root` | 非空字符串或省略 | 未配置 | 私有 ArtifactStore 根目录。 |

所有本地数据库读取、导入、导出、手动 PDF 和补全入口都需要两个路径同时配置。配置
解析只保留字符串，不展开 `~`，也不相对配置文件所在目录改写路径。Bootstrap 把路径
交给 Storage 绑定时才进行安全校验和词法绝对化：已有祖先必须是真实目录而非符号
链接；非 sticky 的 group/world 可写祖先会被拒绝；ArtifactStore 根必须由当前用户
拥有且为 `0700`；已有 Catalog 必须是当前用户拥有、`0600`、单硬链接的普通文件。
缺失的最终 ArtifactStore 根和新 Catalog 会按 owner-only 权限安全创建。应使用明确的
绝对路径，避免让相对路径随启动工作目录改变含义。

### `[discovery]`

| 字段 | 类型 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `metadata_scan_limit` | 大于等于 1 的整数或省略 | 未配置 | 每个 Metadata Provider 在一次 DiscoveryRun 中扫描的原始 item 上限。 |

只要启用的 Metadata 能力包含主题搜索或引用查询，构造 Discovery scope 就要求该值
存在。它是逐 Provider、整次 Run 的上限，不是多个来源共享的总量。

### `[sources]`

`sources` 分成两个互不混用的能力集合：

```toml
[sources.metadata]
providers = []

[sources.acquisition]
providers = []
```

两个 `providers` 字段都是按顺序、不可重复的 Provider key 数组；默认均为空。
Metadata 的允许值为：

```text
web-of-science, crossref, semantic-scholar, arxiv, openalex,
europe-pmc, elsevier, springer, datacite, core, opencitations
```

Acquisition 的允许值为：

```text
arxiv, crossref, semantic-scholar, openalex, europe-pmc,
unpaywall, elsevier, springer, wiley, datacite, core, sci-hub
```

Provider key 出现在允许集合中只说明配置模型认识它；实际调用还要求对应 capability
有生产实现并通过 readiness。引用搜索是 Metadata 的可选能力，不另设 Citation
Provider。

以下普通 Provider 参数有额外子表：

#### `[sources.metadata.web-of-science]`

| 字段 | 类型 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `product` | `starter` 或 `expanded` | 必需 | 明确选择官方产品；不同产品的引用能力和 AccessPolicy 不同。 |
| `database` | 非空字符串 | 必需 | 普通产品参数，不属于凭据。 |
| `edition` | 非空字符串或省略 | 未配置 | 可选普通产品参数。 |

启用 `web-of-science` 时还必须配置 `discovery.metadata_scan_limit`，并在固定凭据文件中
提供 `api_key`。

#### `[sources.metadata.crossref]`

| 字段 | 类型 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `mode` | `anonymous` 或 `polite` | 必需 | 显式选择 public 或 polite pool。 |
| `mailto` | ASCII 联系邮箱或省略 | 未配置 | `polite` 必需，`anonymous` 禁止。 |

`mailto` 是公开联系身份，不是 secret，因此不进入 `credentials.toml`。

#### `[sources.acquisition.unpaywall]`

| 字段 | 类型 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `contact_email` | ASCII 联系邮箱 | 必需 | 启用 Unpaywall 时必需，属于普通配置。 |

当前 Acquisition 的可执行生产路径是通用已接纳 AssetHint，以及 arXiv、Europe PMC、
Unpaywall 的公开协议和 operator 注入的 Sci-Hub locator。Elsevier、Springer、Wiley
和 CORE 的 authorized API 路径仍明确未支持；受控 Browser 的生产规则目录也为空。
其中有通用 AssetHint 路由的 Provider 仍可贡献已经接纳的 direct-file/landing-page
线索；这不等于其 authorized API 或 Browser 已上线。Wiley 当前没有可执行生产路由，
启用会 fail closed。Sci-Hub 只有在 operator 通过 Python 组装边界注入受支持的中性
locator resolver 时才 ready；普通 TOML 没有 endpoint、selector、session 或浏览器
profile 字段。

### `[assets]`

当前是严格空表：

```toml
[assets]
```

任何子字段都会被拒绝。PDF 大小、检查、发布和 Source 的安全边界由 Acquisition 与
Storage 的固定合同控制，不由自由配置绕过。

### `[parsing]`

| 字段 | 类型 | 默认值 | 用途与约束 |
| --- | --- | --- | --- |
| `base_url` | 非空字符串或省略 | 未配置 | Operator 管理的 MinerU protocol-2 服务 URL。 |
| `connection_mode` | `loopback`、`remote` 或省略 | 未配置 | 显式选择本机或远程边界。 |
| `model_identity` | 非空字符串或省略 | 未配置 | 写入 parser-neutral provenance 的部署模型身份。 |
| `remote_upload_authorized` | Boolean | `false` | 远程上传必须由 operator 明确授权；loopback 模式必须为 `false`。 |

`content` 补全要求 `base_url`、`connection_mode` 和 `model_identity` 全部存在；远程
模式还要求 `remote_upload_authorized = true`。当前固定实现是 MinerU 3.4.4、protocol
2、`vlm-engine` profile 和 `vlm` archive backend，这些不是可配置字段。

实际绑定时，loopback 模式只接受 `http` 和 `localhost` 或 loopback IP，并禁止 bearer
token 与远程上传授权；remote 模式要求 `https`、非 IP/非 `localhost` host、明确上传
授权和 bearer token。两种模式都拒绝 URL credential、query、fragment 以及不安全的
规范化结果。SciRetriever 只作为 client 使用 operator 管理的 MinerU，不负责安装、
启动、停止或升级该服务。

### `[analysis]`

| 字段 | 类型 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `provider` | `openai`、`anthropic` 或省略 | 未配置 | 选择固定生产 adapter 和固定官方 endpoint。 |
| `model` | 非空字符串或省略 | 未配置 | 请求使用的模型标识。 |
| `metadata_max_output_tokens` | 大于等于 1 的整数或省略 | 未配置 | metadata 阶段输出上限。 |
| `content_max_output_tokens` | 大于等于 1 的整数或省略 | 未配置 | content 阶段输出上限。 |
| `reference_max_output_tokens` | 大于等于 1 的整数或省略 | 未配置 | 引用 lookup 输出上限。 |
| `max_input_bytes` | 大于等于 1 的整数或省略 | 未配置 | 内容分析总输入字节上限。 |
| `max_chunk_bytes` | 大于等于 1 的整数或省略 | 未配置 | 单 chunk 字节上限。 |
| `max_chunk_count` | 大于等于 1 的整数或省略 | 未配置 | chunk 数量上限。 |
| `max_total_llm_requests` | 大于等于 1 的整数或省略 | 未配置 | 单次内容分析的总 LLM 请求上限。 |
| `max_total_output_tokens` | 大于等于 1 的整数或省略 | 未配置 | 单次内容分析的总输出 token 上限。 |

引用发现只需要 `provider`、`model` 和 `reference_max_output_tokens`；`content` 补全要求
表中所有字段。普通配置不能自定义 Analysis endpoint，也不能保存或间接引用 API key。
OpenAI 和 Anthropic adapter 分别使用代码内固定的官方 Responses API 与 Messages API
endpoint，并通过共享 Network 安全和准入边界访问。

### `[execution]`

| 字段 | 类型 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `max_concurrency` | 整数 | `4` | 范围 1 到 64；用于数据库补全目标的进程内并发。 |

### `[library]`

| 字段 | 类型 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `max_input_bytes` | 整数 | `67108864` | 范围 1024 到 1073741824；限制一次书目导入输入。 |

### `[access]`

当前是严格空表：

```toml
[access]
```

Network 的 URL、DNS、TLS、redirect、origin、请求/响应预算、限速、`Retry-After` 与
脱敏策略来自固定 Provider 合同。普通配置不能添加字段来放宽这些政策。

## 3. Provider 凭据文件

Provider secret 只有一个生产来源：

```text
~/.sciretriever/credentials.toml
```

该文件不随普通配置路径变化，也不能通过 CLI 选择另一份。目录必须是当前用户拥有、
非符号链接的真实目录，精确权限为 `0700`；文件必须是当前用户拥有、非符号链接、
`0600`、单硬链接的普通文件，且不超过 1 MiB。目录或文件缺失表示当前没有 Provider
凭据；存在但 owner、权限、类型、链接、TOML 或字段合同不安全时会 fail closed。

每个 Provider 最多一个 section，字段值必须是去除边界空白后仍非空且无控制字符的
字符串。当前允许的 secret 字段是：

| Provider section | 字段 | 当前凭据合同 |
| --- | --- | --- |
| `[web-of-science]` | `api_key` | Metadata 必需。 |
| `[semantic-scholar]` | `api_key` | Metadata 可选；Acquisition 当前公开路线不读取它。 |
| `[openalex]` | `api_key` | Metadata 可选；Acquisition 当前公开路线不读取它。 |
| `[elsevier]` | `api_key`、`institution_token` | Metadata 的 `api_key` 必需，`institution_token` 可选；Acquisition 当前公开路线不读取它。 |
| `[springer]` | `api_key`、`api_metric` | `config set springer` 当前要求两项都存在；Metadata 只消费 `api_key`，`api_metric` 来自尚不受支持的 Acquisition Full Text 字段合同，配置它不会使 authorized route 可执行。 |
| `[core]` | `api_key` | Metadata 可选；Acquisition 当前公开路线不读取它。 |
| `[opencitations]` | `access_token` | Metadata 可选。 |

Crossref、arXiv、Europe PMC、DataCite、Unpaywall 没有当前凭据字段；Wiley 与 Sci-Hub
也不接受猜测的凭据 section。未知 Provider、未知字段、空 section、空值和非字符串值
都会被拒绝。凭据文件只保存认证材料，不保存启用状态、顺序、product、database、
edition、scan limit、endpoint、联系邮箱、AccessPolicy、浏览器设置、测试结果或文献
事实。

形状示例（尖括号内容不是可用 secret）：

```toml
[web-of-science]
api_key = "<secret>"

[elsevier]
api_key = "<secret>"
institution_token = "<secret>"

[opencitations]
access_token = "<secret>"
```

## 4. Parser 与 Analysis 的固定环境变量

MinerU 和 Analysis 运行 secret 不写入普通配置或 Provider 凭据文件。Bootstrap 只按
当前 scope 和明确选择读取下列固定变量：

| 环境变量 | 读取条件 |
| --- | --- |
| `SCIRETRIEVER_MINERU_BEARER_TOKEN` | `parsing.connection_mode = "remote"` 且当前 scope 需要 Parser。 |
| `SCIRETRIEVER_OPENAI_API_KEY` | `analysis.provider = "openai"` 且当前 scope 需要 Analysis。 |
| `SCIRETRIEVER_ANTHROPIC_API_KEY` | `analysis.provider = "anthropic"` 且当前 scope 需要 Analysis。 |

所需变量缺失、空白或含控制字符时在组装期失败。loopback MinerU 不读取 token；纯本地
library、书目交换、手动 PDF 和只到 PDF 的补全也不会读取不需要的 Parser/Analysis
变量。真实值只进入短生命周期的私有容器和对应 adapter，不进入 Pydantic Model、
Catalog、ArtifactStore、provenance、Report、日志、URL、异常或 CLI 输出。

## 5. `config` 命令

固定命令树为：

```text
sciretriever config set <provider> [--json]
sciretriever config remove <provider> [--json]
sciretriever config status [--json]
sciretriever config test <provider> [--json]
sciretriever config test --all [--json]
```

### `config set`

`set` 按当前 credential spec 用不回显的交互输入收集必需和可选字段；secret 不能通过
普通 option 或位置参数传入。目标 section 已存在时会在 stderr 询问是否整体替换；
取消不修改文件。发布前先完整、安全地解析原文件，在内存中只替换目标 section，
然后在同一 `0700` 目录写入 `0600` staging、flush/`fsync`、重新解析并原子替换正式
文件。不会生成含旧值或新值的备份；规范化重写不承诺保留注释或字段顺序。

### `config remove`

`remove` 只删除目标 Provider section并原子发布，其它 section 保留。重复删除返回
`not-configured`。它不修改普通配置，也不删除已经接纳的文献事实或资产。

### `config status`

`status` 读取普通配置和固定凭据文件，只做本地静态检查；不构造 Catalog、
ArtifactStore 或 Network，也不发请求。它输出完整的 Metadata/Acquisition capability
矩阵，并把以下层分别报告：

- `production_available`：该 capability 是否有当前可执行生产实现；
- `enabled`：是否列在普通配置对应 `providers` 数组中；
- `ordinary_parameters_ready`：Provider 专属产品选择、联系身份等普通参数是否齐备；
  Discovery 的 `metadata_scan_limit` 由具体运行 scope 另行检查；
- `credential.status`：凭据是 `not-required`、`configured`、`partial`、`missing`、
  `optional-missing` 还是 `unsupported`；
- `access_policy_ready`：固定 Network 访问合同是否存在；
- `probe_available`：是否实现了独立的最小只读 probe；
- `local_ready` 与 `failure_code`：组合后的本地 readiness 与稳定原因。

字段状态只显示名称、必需性和是否存在；不显示值、掩码、长度、前后缀、hash 或
fingerprint。`enabled = false` 不会改写其它 readiness 层：status 是完整矩阵，而实际
运行只注册已启用且就绪的能力。`configured` 只说明本地必需/可选字段存在，不表示
认证已成功；Acquisition 的 `local_ready` 也不表示当前具体 Literature 有全文授权。

### `config test`

`test <provider>` 是用户明确发起的诊断：即使 Provider 没有在普通配置中启用，也会
选择它已实现的 Metadata probe；本地 readiness 不通过时返回 `skipped`，不联网。
`test --all` 只选择普通配置中已启用、生产 probe 存在的 Metadata capability；本地
不就绪项明确 `skipped`，其它就绪项逐一执行，一个失败不阻断后续汇总。当前
Acquisition 没有独立于具体 Literature 的官方最小 probe，因此不会被 `config test`
执行，结果中的 `acquisition_entitlement` 始终是 `not-proven`。

这是唯一会主动发起 Provider 网络请求的配置命令。用户每次显式执行都可能消耗真实
Provider 请求额度；请求经过共享 DNS/TLS/redirect/origin/限速/响应预算与脱敏边界。
它不创建 Storage、DiscoveryRun、Literature、MetadataObservation、Asset、Report，
也不保存最后结果或时间。Harness、单元测试和安装后离线验收只使用 fake 或
“readiness 不通过所以跳过”的路径，不会调用真实 Provider；受控 fake 的 `passed`
证据也不能解释成生产在线服务当前成功。

## 6. 能力、启用与 readiness

普通配置可解析、Provider key 被接受、生产 adapter 存在、用户启用、普通参数齐备、
凭据齐备、AccessPolicy 齐备、probe 通过和一次真实业务调用成功是不同事实。生产调用
顺序可概括为：

```text
production capability 存在
  -> 普通配置启用
  -> 普通参数、凭据与 AccessPolicy 就绪
  -> Acquisition 还要对当前 Literature 有中性适用证据
  -> 才执行真实 Provider/Source 调用
```

领域发现要求非空的 Metadata Provider 选择、`paths` 和
`discovery.metadata_scan_limit`；实际只有已启用、就绪且具有 topic-search 的 adapter
参加主题搜索，配置时应至少选择一个这样的 Provider。引用发现还需要引用 Analysis 的
三项配置与对应 Analysis 环境变量。PDF 补全需要 `paths`，并会在构造期拒绝任何已启用
但不就绪的 Acquisition Provider；内容补全还需要完整 Parser、Analysis 配置与相应
环境变量。纯本地查询、三种书目交换、手动 PDF 只需要安全 Storage 路径。

启用但缺少生产实现、普通参数、必需凭据或访问政策会在外部调用和 Storage 创建前
稳定失败，不会静默跳过或伪装为零结果。真实调用后的认证、授权、quota、网络或服务
失败属于该次 Provider failure：Metadata 仍可保留其它来源的已提交成功；Acquisition
也不能把这种不确定失败写成 `NoPrimaryPdf` 或自动获取耗尽。

## 7. 普通配置示意

下面示例只展示一个纯本地 Library/书目交换基础和一组可选的外部能力参数。请把
Storage 路径、模型身份、Provider 选择与安全授权换成自己的实际设置；不要把 secret
写入此文件。

```toml
[paths]
catalog_path = "/absolute/private/path/catalog.sqlite3"
artifact_root = "/absolute/private/path/artifacts"

[discovery]
metadata_scan_limit = 100

[sources.metadata]
providers = ["crossref", "arxiv"]

[sources.metadata.crossref]
mode = "anonymous"

[sources.acquisition]
providers = ["arxiv", "unpaywall"]

[sources.acquisition.unpaywall]
contact_email = "operator@example.org"

[parsing]
base_url = "http://127.0.0.1:8000"
connection_mode = "loopback"
model_identity = "mineru-3.4.4-vlm"
remote_upload_authorized = false

[analysis]
provider = "openai"
model = "operator-selected-model"
metadata_max_output_tokens = 512
content_max_output_tokens = 2048
reference_max_output_tokens = 512
max_input_bytes = 16777216
max_chunk_bytes = 4194304
max_chunk_count = 4
max_total_llm_requests = 6
max_total_output_tokens = 8192

[execution]
max_concurrency = 4

[library]
max_input_bytes = 67108864

[assets]
[access]
```

这份文件在结构上合法，但外部能力是否可运行仍取决于固定环境变量、Provider 凭据、
当前生产 capability 与 Network policy。`config status --json` 可做不联网的本地检查；
只有用户明确需要验证真实 Provider 时才执行 `config test`。
