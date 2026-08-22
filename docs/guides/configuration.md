# SciRetriever 配置手册

SciRetriever 把配置分成两条互不替代的边界：

- 普通运行设置写在一个用户选择的 TOML 文件中；
- Provider、LLM 与远程 MinerU 的 secret 统一写在固定的
  `~/.sciretriever/credentials.toml`。

普通配置和凭据都由根级 `sciretriever.configuration` 读取，根级
`sciretriever.bootstrap` 再按当前命令需要的能力组装生产对象。普通配置模型严格、
不可变、拒绝未知字段，而且不包含任何 secret。当前没有文件级版本字段、普通配置内的
凭据组或凭据引用、runtime factory，也不保留旧配置兼容层。LLM/MinerU secret
环境变量不属于当前合同，不读取、不回退，也不自动迁移。

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
交给 Storage 绑定时才进行词法绝对化和结构校验：已有祖先必须是真实目录而非符号
链接，ArtifactStore 根必须是目录，已有 Catalog 必须是普通非符号链接、单硬链接文件。
普通数据路径不根据 Unix owner、权限位或 sticky bit 决定是否允许使用；`0775`、`0777`
目录以及 `0644`、`0666` 文件只要当前进程实际具有所需文件系统访问权限，就可以作为
数据库或资产路径。缺失的最终 ArtifactStore 根和新 Catalog 仍分别以 `0700`、`0600`
作为保守的新建默认值，但这些默认值不是后续打开时的准入条件。运行中路径组件、Catalog
或资产对象被替换，或者对象类型、单硬链接、hash、size 等完整性条件不成立时仍会拒绝。
应使用明确的绝对路径，避免让相对路径随启动工作目录改变含义。凭据文件是独立的 secret
边界，仍适用本手册第 3 节的严格 owner 与 `0700`/`0600` 要求。

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

当前自动 PDF 获取先消费所有已保存的 direct-file/landing-page `AssetHint`，再按配置顺序
运行 arXiv、Europe PMC、Unpaywall 等独立公开协议；公开阶段全部耗尽后，才进入已配置的
授权 Provider API。当前可执行的授权主 PDF API 是 CORE API v3、Elsevier
Article/Object Retrieval 与 Wiley Online Library TDM API。CORE 只有 Metadata
Observation 带 CORE 自己的 `work:<id>` 或 `output:<id>` 强记录身份时才适用，并要求
`[core] api_key`。CORE Metadata 给出的公开 `downloadUrl` 仍在第一阶段先尝试，注册用户
`/download` endpoint 属于第二阶段，不会替代公开 URL。

Wiley 要求 `[wiley] tdm_api_token`，并且当前 Literature 必须恰有一个 DOI；公开来源
耗尽后，Acquisition 才通过共享 Network 安全解析该 DOI，只有最终 origin 是
`https://onlinelibrary.wiley.com` 才调用 Wiley TDM API。Publisher 文本、DOI prefix 和
MetadataObservation 来源都不能单独使 Wiley Source 适用。Token、调用公网 IP 是否在
机构授权范围内，以及具体文章 entitlement 是三个不同事实。

Elsevier 要求 `[elsevier] api_key`，可选 `institution_token`。只有 PII、合法的
`1-s2.0-*` Article EID，或 DOI 安全解析后实际落地到 ScienceDirect/linkinghub 的文献
才适用；普通 Scopus `2-s2.0-*` 和 MetadataObservation 来源不能证明访问方。Adapter 先
请求 Article FULL XML，只接受明确标记为 `MAIN web-pdf` 的 attachment EID，再通过
Object Retrieval 获取 PDF；若 FULL XML 没有可用 MAIN object 或无法安全解释，才以同一
强身份向 Article Retrieval 协商 PDF 表示。可解析的认证、授权、quota 或服务错误不会被
fallback 绕过；XML、任意 object、supplement 和有效 key 本身都不冒充主 PDF 或文章
entitlement。Springer Full Text 当前是 JATS/XML，授权主 PDF API 仍为
`unsupported`。已有通用 AssetHint 路由的 Provider 仍可贡献公开线索。Sci-Hub 只有在 operator 通过
Python 组装边界注入受支持的中性 locator resolver 时才 ready。受控 Browser 的组件已
实现，当前内置 9 条 production 站点规则；规则、origin、selector、risk/session group 和
限速政策不是普通 TOML 字段。普通配置只通过 `[access]` 选择固定身份 Profile、显式启用
Browser、设置跨 Publisher 本机并发上限，并可用封闭 override 把既有政策收得更严格。

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

### `[agents]`、`[agents.analysis]` 与 `[agents.browser]`

| 字段 | 类型 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `[agents].provider` | `openai`、`anthropic`、`custom` 或省略 | 未配置 | 选择共享的 Agent 服务。 |
| `[agents].service_name` | 安全服务标识或省略 | 未配置 | `custom` 必需；官方服务禁止。 |
| `[agents].protocol` | `openai-responses`、`openai-chat-completions`、`anthropic-messages` 或省略 | 未配置 | 明确选择共享 wire protocol。 |
| `[agents].base_url` | 非空字符串或省略 | 未配置 | 官方服务固定到官方 `/v1`；自定义服务使用安全 URL。 |
| `[agents].authentication` | `api-key`、`none` 或省略 | 未配置 | 远程使用 API key；只有自定义 HTTP loopback 可无认证。 |
| `[agents.analysis].model` | NFC 单行 UTF-8 字符串（最多 512 bytes）或省略 | 未配置 | Analysis role 使用的模型标识。 |
| `[agents.analysis].context_window_tokens` | 大于等于 1024 的整数或省略 | 未配置 | 已核实的模型 context window。 |
| `[agents.analysis].max_output_tokens` | 大于等于 1 的整数或省略 | 未配置 | 模型单次响应的硬上限。 |
| `[agents.analysis].structured_output` | Boolean | `false` | Analysis role 必须显式声明严格结构化输出能力。 |
| `[agents.analysis].deadline_seconds` | 大于 0 的有限数 | `180.0` | 单次 Analysis Agent 调用的总 deadline。 |
| `[agents.browser].model` | NFC 单行 UTF-8 字符串（最多 512 bytes）或省略 | 未配置 | 可选 Browser Agent role 使用的视觉/工具模型；不配置时只运行确定性规则。 |
| `[agents.browser].context_window_tokens` | 大于等于 1024 的整数或省略 | 未配置 | Browser role 已核实的模型 context window。 |
| `[agents.browser].max_output_tokens` | 大于等于 1 的整数或省略 | 未配置 | 单次 Browser Agent 决定的输出上限。 |
| `[agents.browser].structured_output` | Boolean | `false` | Browser 使用封闭 tool decision，当前不要求 Analysis 式 structured text。 |
| `[agents.browser].image_input` | Boolean | `false` | Browser Agent 就绪时必须为 `true`。 |
| `[agents.browser].tool_decision` | Boolean | `false` | Browser Agent 就绪时必须为 `true`；只暴露 Click/Scroll/Wait/Stop。 |
| `[agents.browser].image_media_types` | 字符串数组 | `[]` | 只允许 `image/png`、`image/jpeg`、`image/webp`，不得重复。 |
| `[agents.browser].image_count` | 大于等于 0 的整数 | `0` | 每 turn 图像数上限；启用图像时必须至少为 1。 |
| `[agents.browser].image_bytes` | 大于等于 0 的整数 | `0` | 每 turn 图像总字节上限；启用图像时必须大于 0。 |
| `[agents.browser].turns` | 大于等于 1 的整数 | `1` | 当前文章 request-local Agent session 的最大 turn 数；多 turn 要求 tool decision。 |
| `[agents.browser].deadline_seconds` | 大于 0 的有限数 | `180.0` | 单次 Browser Agent provider 调用的总 deadline。 |

`[agents]` 是 Analysis 与受控 Browser Agent 共用的唯一 endpoint、协议和凭据边界；角色只能
选择模型和各自能力预算，不能复制 Base URL 或 secret。Analysis 生产路径消费
`[agents.analysis]`。`[agents.browser]` 是可选项：模型与完整图像/tool 预算存在时，只有在初始
capture、页面终态、通用 locator 和 Publisher 确定性规则都正常未命中后才可能调用；缺少它不
阻断确定性 Browser。challenge、登录、MFA、timeout、quota 或 runtime failure 等终态不会调用
Agent 生成替代流量。

官方 OpenAI 只允许 `https://api.openai.com/v1` 与两种 OpenAI 协议，官方 Anthropic
只允许 `https://api.anthropic.com/v1` 与 Messages 协议。自定义远程服务必须是
hostname-based HTTPS 且使用 API key；自定义 loopback 必须是 HTTP，且只能选择
`authentication = "none"`。URL 拒绝 userinfo、query、fragment、IP literal remote、
路径跳转、编码分隔符和非规范端口文本。

### `[analysis]`

`[analysis]` 只保存文献分析自身的 chunk、阶段和总量预算，不拥有 provider、协议、
endpoint、认证或模型选择。

| 字段 | 类型 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `metadata_max_output_tokens` | 大于等于 1 的整数或省略 | 未配置 | metadata 阶段输出上限。 |
| `content_max_output_tokens` | 大于等于 1 的整数或省略 | 未配置 | content 阶段输出上限。 |
| `reference_max_output_tokens` | 大于等于 1 的整数或省略 | 未配置 | 引用 lookup 输出上限。 |
| `max_input_bytes` | 大于等于 1 的整数或省略 | 未配置 | 内容分析总输入字节上限。 |
| `max_chunk_bytes` | 大于等于 1 的整数或省略 | 未配置 | 单 chunk 字节上限。 |
| `max_chunk_count` | 大于等于 1 的整数或省略 | 未配置 | chunk 数量上限。 |
| `max_total_llm_requests` | 大于等于 1 的整数或省略 | 未配置 | 单次内容分析的总 LLM 请求上限。 |
| `max_total_output_tokens` | 大于等于 1 的整数或省略 | 未配置 | 单次内容分析的总输出 token 上限。 |

引用发现需要完整的 `[agents]`、Analysis role 的模型/context/最大输出/结构化能力，以及
`reference_max_output_tokens`；`content` 补全还要求全部 `[analysis]` 预算字段。

`[agents.analysis].context_window_tokens` 不是展示字段：程序用保守的 UTF-8 字节上界检查 chunk 输入和
最大输出预留是否能同时装入 context。单阶段输出、两阶段总输出、chunk/总输入和总请求数
也必须相互一致；每个阶段输出还必须不超过 `[agents.analysis].max_output_tokens`。交互向导的 Conservative、Balanced、Large context 只是输入便利，最终
写入的是每个明确数值，不保存 preset 名称。

### `[execution]`

| 字段 | 类型 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `max_concurrency` | 整数 | `4` | 范围 1 到 64；用于数据库补全目标的进程内并发。 |

### `[library]`

| 字段 | 类型 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `max_input_bytes` | 整数 | `67108864` | 范围 1024 到 1073741824；限制一次书目导入输入。 |

### `[access]`

当前保存 Browser-last 能力的非 secret 本地选择：

```toml
[access]
browser_enabled = false
# browser_profile = "institutional-access"
browser_max_concurrency = 5
browser_policy_overrides = []
```

| 字段 | 类型 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `browser_enabled` | 布尔值 | `false` | 持久 Profile Browser 总开关；启用时必须同时选择并初始化 `browser_profile`，且只启用已经通过 production 准入的规则。 |
| `browser_profile` | 字符串或省略 | 省略 | 一个不含敏感信息的 Profile identity，不是路径、账号、机构名、URL、UUID、Token 或 Cookie 标签；由 `sciretriever config` 选择和初始化。 |
| `browser_max_concurrency` | 整数 | `5` | 必须是大于 1 的整数，不设上限；只限制同时活动的不同供应商 Browser lane，不改变同一供应商风险组固定串行。 |
| `browser_policy_overrides` | inline table 数组 | `[]` | 只能收紧已有 production `rate_limit_group`；未知、重复或放宽的 group 会拒绝。 |

单项 policy override 可以收紧组内并发、文章启动间隔、窗口计数/时长、完成/失败/限速冷却和
runtime failure threshold。并发、窗口计数和 failure threshold 只能减小；interval、window
duration 和 cooldown 只能增大。窗口计数与时长必须成对出现，负数、零值非法位置、`inf`、
`nan` 和空 override 都会拒绝。普通配置不能改写 Profile 的 group、session key、origin、
selector、rule revision 或官方 `Retry-After` 语义。

当前 9 个 production Browser group 为 `acs-publications`、`aip-publishing`、`elsevier`、
`iopscience`、`oxford-academic`、`rsc-publishing`、`science-aaas`、`springerlink` 和 `wiley`，
对应的最小文章启动间隔分别为 30、30、20、30、30、30、30、10 和 20 秒。
`browser_policy_overrides` 可以分别收紧这些 group 的间隔、窗口、cooldown 或其它封闭策略，
不能放宽。总开关不会把 fixture-verified/unsupported Profile 变为可执行能力。自动 Completion
只在总开关、选中的固定身份 Profile、CloakBrowser wrapper、Playwright API、经核实 binary 与 headed display
各自适用且就绪时使用对应 production route。当前 `9` 个 production group 只是 catalog 规模，
不是 `browser_max_concurrency` 的最大值；较大的配置值只允许更多不同 Publisher lane 共享同一
patched Chromium process/context，不会启动多个 Browser。

配置不接受逐 Publisher 的本地许可占位字段。`browser_enabled = true` 只启用已经通过 production
准入的封闭 route，并不会证明组织合同、机构 IP、Profile 已登录或具体文章权限；这些 route 仍
逐文章区分正文捕获、付费墙、通用拒绝、challenge 与限流，也不会改写固定 origin、selector、
risk/session group、限速或 Network 安全规则。

当前 Browser 使用本机正常网络出口和一个 operator-managed 持久 Profile，固定以
`headless = false` 启动一个 Chrome process/persistent context；无 GUI Linux 使用 Xvfb 虚拟显示。
Publisher 请求由 Chrome 原生网络栈完成，本机 CONNECT proxy 只执行已审核 hostname/port 到精确
IP 的绑定和加密字节透传。普通配置只接受 opaque Profile identity，不接受 Profile 路径、Cookie、
local storage、登录名、机构身份或代理设置；这些认证内容也不进入 `credentials.toml`。Chrome
自己管理的 Cookie、Local Storage、IndexedDB、SSO 状态、偏好和历史只留在固定 owner-only Profile
目录中。Network 的 URL、DNS、TLS、redirect、origin、请求/响应预算、限速、`Retry-After` 与
脱敏策略仍来自固定 Provider/Profile 合同，普通配置只能收紧。

## 3. 统一凭据文件

Provider、LLM 与远程 MinerU secret 只有一个生产来源：

```text
~/.sciretriever/credentials.toml
```

该文件不随普通配置路径变化，也不能通过 CLI 选择另一份。目录必须是当前用户拥有、
非符号链接的真实目录，精确权限为 `0700`；文件必须是当前用户拥有、非符号链接、
`0600`、单硬链接的普通文件，且不超过 1 MiB。目录或文件缺失表示当前没有任何
凭据；存在但 owner、权限、类型、链接、TOML 或字段合同不安全时会 fail closed。

每个 Provider 最多一个 section，字段值必须是去除边界空白后仍非空且无控制字符的
字符串。当前允许的 secret 字段是：

| Provider section | 字段 | 当前凭据合同 |
| --- | --- | --- |
| `[web-of-science]` | `api_key` | Metadata 必需。 |
| `[semantic-scholar]` | `api_key` | Metadata 可选；Acquisition 当前公开路线不读取它。 |
| `[openalex]` | `api_key` | Metadata 可选；Acquisition 当前公开路线不读取它。 |
| `[elsevier]` | `api_key`、`institution_token` | Metadata 和 authorized primary-PDF object retrieval 使用 `api_key`；`institution_token` 可选。 |
| `[springer]` | `api_key` | 当前生产 Metadata 使用；尚不受支持的 Acquisition Full Text `api_metric` 不由交互管理器收集，也不会使 authorized route 可执行。 |
| `[core]` | `api_key` | Metadata 可选；启用 CORE Acquisition 的授权 PDF API 时必需。 |
| `[opencitations]` | `access_token` | Metadata 可选。 |
| `[wiley]` | `tdm_api_token` | 启用 Wiley TDM 授权 PDF API 时必需；只有这一项 token。本地检查非空与 header 安全，实际有效性由 Wiley 响应确认。 |

Crossref、arXiv、Europe PMC、DataCite、Unpaywall 没有当前凭据字段；Sci-Hub 不接受
猜测的凭据 section。未知 Provider、未知字段、空 section、空值和非字符串值
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

[core]
api_key = "<secret>"

[wiley]
tdm_api_token = "<secret>"

[agents]
api_key = "<secret>"
origin = "https://api.openai.com"

[mineru]
bearer_token = "<secret>"
origin = "https://mineru.example.invalid"
```

`[agents]` 与 `[mineru]` 的 secret 必须与保存时的规范 origin 精确绑定。Bootstrap 只会把
secret 发送给普通配置当前引用的同一 origin；修改 Base URL 后，旧 secret 不会被发送到
新服务，跨 origin redirect 也不携带它。loopback LLM/MinerU 不保存或读取核心 secret。

交互中心同时修改普通配置与核心 secret 时，会先在两个目标目录落盘并完整复验 staging，
再发布可同时服务旧/新 origin 的过渡凭据、发布新普通配置，最后清理旧 secret。保留字段
`next_api_key`、`next_bearer_token`、`next_origin` 只用于进程中断恢复，不是用户配置接口；
手工创建不完整组合会 fail closed，正常发布结束后不会保留它们。

## 4. Secret 生命周期

Bootstrap 只按当前 scope 读取实际需要的 credentials section。loopback MinerU、无认证
loopback LLM、纯本地 library、书目交换、手动 PDF 和只到 PDF 的补全不会读取不需要的
核心 secret。真实值只进入短生命周期的私有容器和对应 adapter，不进入 Pydantic Model、
Catalog、ArtifactStore、provenance、Report、日志、URL、异常或 CLI 输出。

## 5. `config` 命令

固定命令树为：

```text
sciretriever config [--theme auto|dark|light|mono]
sciretriever config status [--json] [--theme auto|dark|light|mono]
sciretriever config test <provider|llm|mineru> [--json]
sciretriever config test --browser <publisher-access-key> [--json]
sciretriever config test --all [--json]
```

### 裸 `config` 交互管理器

执行 `sciretriever config` 即进入统一配置中心，首页固定分为 `CORE SERVICES` 和
`LITERATURE PROVIDERS`。LLM 与 MinerU 分别提供 setup/edit、test、reset 和返回；Provider
提供设置/更新、移除和返回；独立的 Provider Access 区管理 authorized primary-PDF API 与
Browser session。TTY 使用 Rich + prompt-toolkit 的非全屏界面，支持方向键、Enter、
`A/L/M/T/Q` 快捷键与隐藏输入；重定向输入或基础终端使用确定性编号菜单。主题支持
`auto/dark/light/mono`，`NO_COLOR` 始终强制单色。交互内容只写 stderr，stdout 为空；
Ctrl+C/EOF 取消不会写文件。公开子命令只有 `status` 和 `test`，旧 `config set/remove`
作为无效输入拒绝。

LLM Guided setup 提供官方 OpenAI Responses、官方 Anthropic Messages 和自定义兼容服务；
自定义服务再选择三种协议与认证。向导收集模型、已核实 context window 和预算。远程 API
key 使用隐藏输入并绑定规范 origin。MinerU Guided setup 只配置当前真实的 3.4.4 /
protocol 2 / `vlm-engine` 后端，不提供虚假 backend 选项；remote 模式在保存前明确提示源
PDF 会离开本机并要求确认，再收集 origin-bound bearer token。Reset 同时清空对应普通
section 与核心 credential，不留下“已启用但无凭据”的中间状态。

设置或更新动作按当前可执行 capability 的 credential spec，用不回显输入收集必需和可选
字段；secret 不能通过普通 option、位置参数或 URL 传入。尚不受支持的 capability 所声明字段
不会被向导冒充为当前必需项，例如 Springer 当前只收集 Metadata 使用的 `api_key`，不会
要求尚未成为生产主 PDF Source 的 Full Text `api_metric`。目标 section 已存在时会在
stderr 询问是否整体替换；必需字段留空会重新询问；某个全可选 Provider 没有输入任何值时
按取消处理，不创建空 section。取消不修改文件。发布前先完整、安全地解析原文件，在内存中
只替换目标 section，然后在同一 `0700` 目录写入 `0600` staging、flush/`fsync`、重新
解析并原子替换正式文件。不会生成含旧值或新值的备份；规范化重写不承诺保留注释或
字段顺序。

例如配置 Wiley：

```text
sciretriever config
# 选择 Wiley Online Library
# 再选择 Set or update credentials
```

向导会给出 Wiley 官方 token 入口 `https://static.wiley.com/tdm/`，并提示在普通配置中把
`wiley` 加入 `[sources.acquisition].providers`。本地写入成功只说明字段存在；它不验证
Wiley 是否接受 token、token 是否符合 Wiley 当前签发格式、当前公网 IP 是否位于授权范围
或具体 DOI 是否有全文 entitlement。

移除动作只删除所选 Provider section并原子发布，其它 section 保留；存在 section 时必须
确认，未配置时明确提示且不写文件。它不修改普通配置，也不删除已经接纳的文献事实或资产。

Provider Access 区把 CORE、Elsevier、Wiley 的 authorized primary-PDF API 本地 readiness 与
Controlled Browser 分开显示。Browser 菜单只管理自动路线：

1. 选择或初始化一个 Browser Profile，并一次生成固定 identity manifest；
2. 永久删除选中的本地 Profile、identity manifest 及其中由 Chromium 管理的状态；
3. 禁用自动 Browser access，同时保留 Profile、并发上限、policy override 和 Provider API credential；
4. 设置跨 Publisher 的 Browser 并发 cap；只接受大于 `1` 的整数，不设置上限。

首页独立的 CloakBrowser runtime 区显示 wrapper、Playwright API、binary presence/version/signature
和回退版本，并提供显式安装、更新、回退以及可选 Pro credential 的预留管理。当前固定
older-free v146 不消费该 credential，status 明确标记
`reserved-not-used-by-pinned-free-binary`。安装/更新是会联网和写盘的独立动作，执行前需要
两次确认；它们必须将签名 manifest 的版本/摘要、仓库固定 SHA-256 和本次实际 archive 字节
绑定后才发布。普通 Completion、status 和 Profile 初始化都不会隐式下载 binary，wheel 也不
包含 binary。普通 Browser 只通过无凭据的临时 cache view 暴露已验证固定版本，不读取长期
runtime root 中的 license/Pro/update 状态。

Profile identity 只是 `config.toml` 中不含敏感信息的选择名；真实 Chromium 数据和 owner-only
identity manifest 进入固定私有目录。manifest 固化 native Linux persona、locale、timezone、
screen、Browser version policy 和 seed 派生身份；seed、Profile 路径与站点状态不会进入普通配置、
status 或日志。初始化与配置修改在同一确认后完成；取消不会创建 Profile、修改 `[access]` 或启动
Browser。自动 Browser 使用当前机器正常网络出口和同一持久 Profile，无 GUI Linux 使用 Xvfb。
第一版不提供可见 Browser 登录、机构选择、MFA、Cookie 导入导出或 CAPTCHA 交互入口。
SciRetriever 不导航登录页、不填写凭据、不选择机构、不读取 Cookie 或登录结果，也不处理或绕过
MFA/CAPTCHA。当前 production Browser route count 和 local eligible count 都是 9；route 已安装、
Profile/identity 就绪、总开关与 runtime ready 都不能证明机构 IP 或具体文章具有 entitlement。

### `config status`

`status` 读取普通配置和统一凭据文件，只做本地静态检查；不构造 Catalog、ArtifactStore
或 Network，也不发请求。默认用紧凑 Panel/Table 分开显示 Core services、Metadata APIs、
authorized primary-PDF APIs、PDF acquisition routes、Controlled Browser 与
Storage/execution；`--json` 使用稳定分组结构供
脚本消费且永不包含 ANSI。PDF Acquisition 依次展示：

- `Public sources`：共享的已保存 direct/landing hints，以及 arXiv、Europe PMC、
  Unpaywall、operator locator 等独立公开服务的本地就绪状态；
- `Authorized Provider APIs`：逐 Provider 显示是否已有可执行主 PDF API、当前限制和
  所需凭据字段；
- `Controlled browser`：显示持久固定身份 Profile、选中的 opaque identity 及其存在/安全状态、
  Cloak wrapper/Playwright API/binary/version/signature/Xvfb、本地 runtime readiness、9 条
  production route、默认 9/9 条 local eligible、总开关、共享 process/context、Publisher lane、
  未评估的文章 entitlement、policy evidence、显式 probe 和下一动作。

Metadata 人类表格只逐项展开已经启用或已有凭据的 Provider，其余禁用能力以数量摘要收起；
完整 capability matrix 仍保留在 JSON。授权 PDF API 不与 Metadata 合并，固定单列 CORE、
Elsevier、Wiley 和当前不支持直接主 PDF 的 Springer API。当前 production Browser route 为
ACS Publications、AIP Publishing、Elsevier / ScienceDirect、IOPscience、Oxford Academic、
RSC Publishing、Science / AAAS、Springer Nature Link 与 Wiley Online Library；Browser 分区
始终显示这 9 条 route，再根据总开关、Profile/identity manifest、Cloak wrapper、Playwright API、
经核实 binary 与 headed display 的实际静态状态给出 `browser-disabled`、`browser-profile-not-selected`、
`browser-profile-missing`、runtime 未就绪原因或 ready。
`browser-production-route-unavailable` 只是将来 production catalog 真的变为空时的 fail-closed
分支，不是当前默认状态。未获 production 验证的其它站点仍不会成为自动路线。

JSON 的 Provider 分区保留完整矩阵，并为每个已接受 Provider 报告以下层：

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

Browser JSON 位于 `providers.controlled_browser`，稳定区分：

- `mode = headed-fixed-profile` 与 `article_entitlement = checked-per-article`：`headed` 只表示
  使用完整窗口栈和 Xvfb，不表示存在用户可见登录窗口；文章权限仍在运行时逐篇判断；
- `profile.selected`、`profile.presence`、`fixed_identity_manifest` 与 `identity_schema`：只报告
  opaque identity、`missing/configured/attention/needs-new-runtime-profile` 和安全 schema，不报告
  路径、seed、Cookie、站点或登录内容；
- `session.assessment = not-assessed`、`authenticated = null` 与
  `article_entitlement = not-proven`：本地状态不会把 Profile presence 冒充认证或授权证明；
- `runtime`：Cloak wrapper、Playwright API、binary presence/version/signature、回退版本与 headed
  display（Linux 上为 Xvfb）是否可用；`launch_assessed` 始终为 `false`，因为 status 只检查本地
  文件，不启动 Browser。CloakBrowser 是唯一生产 runtime；JSON 不提供引擎选择、stock fallback
  或迁移期 `cutover_pending` 字段；
- `routes`：只有通过 production verification 的 Browser route 及其 risk group、官方/项目
  保守 policy revision、验证日期、Notes 引用和有效限速；不含 origin、selector 或页面规则；
- `probe` 与 `action_required`：可显式探测的精确 access key，以及稳定 code/reason/action。

`status` 不启动 Browser，也不读取或枚举 Cookie、local storage、origin history、站点登录信息或
Profile 目录内容。
JSON 和人类输出都不包含 ANSI 以外的隐藏控制数据、secret 掩码/hash/fingerprint 或原始异常。

Storage 分区显示 Catalog/ArtifactStore 是否配置及其当前非 secret 路径。MinerU 分区
显示固定实现身份、`base_url`、连接模式、模型身份、远程上传授权、缺失普通字段，以及
远程 bearer token 是否必需/存在/origin 匹配；LLM 分区显示 provider、protocol、Base URL、
model、context、认证、API key presence/origin 匹配、引用/完整内容 readiness 和预算。未启用但已有凭据的 Provider
仍会显示，便于发现遗留或预配置凭据。这里的 `ready` 只表示本地配置完整，不代表外部
服务或认证已经成功；任何 secret 值都不会显示或进入 JSON。

### `config test`

`test <provider>` 是用户明确发起的诊断：即使 Provider 没有在普通配置中启用，也会
选择它已实现的 Metadata probe；本地 readiness 不通过时返回 `skipped`，不联网。
`test --all` 只选择普通配置中已启用、生产 probe 存在的 Metadata capability；本地
不就绪项明确 `skipped`，其它就绪项逐一执行，一个失败不阻断后续汇总。当前
Acquisition 没有独立于具体 Literature 的官方最小 probe，因此不会被 Provider probe
执行，结果中的 `acquisition_entitlement` 始终是 `not-proven`。

`test llm` 固定发送 `{"probe":"sciretriever-configuration"}` 这一条极小严格 schema
请求，并要求可解析的 `{"ok":true}`；它不发送用户 Literature/PDF 内容，但可能消耗少量
额度，人类模式执行前会确认。`test mineru` 只执行 `GET health`，验证 healthy、release
3.4.4、protocol 2 与 `vlm-engine` profile，不提交 task、不轮询、不取 archive、不上传 PDF。
`test --all` 依次汇总已启用 Provider、LLM 和 MinerU；一个失败不阻断其它结果，任一
failed/skipped 使整体退出码为 3。人类模式统一确认网络/额度副作用；JSON 模式是明确的
脚本调用，不交互确认。

Browser probe 必须单独、显式指定一个 Publisher access key：

```text
sciretriever config test --browser <publisher-access-key> [--json]
```

它与位置 Provider 和 `--all` 互斥，绝不会被 `--all` 隐式执行。人类模式在启动一次
受控有头 Browser 前再次确认；无 GUI Linux 使用 Xvfb。Probe 只访问一个经过 production 批准的最小目标，并使用自动获取相同的
provider risk-group scheduler；一次 probe 最多导航一次。结果分开报告 Browser 是否启动、
最小目标是否到达，同时始终保留 `article_entitlement = not-proven` 与
`persisted = false`。当前支持的目标是：

```text
sciretriever config test --browser elsevier-sciencedirect
sciretriever config test --browser oxford-academic
sciretriever config test --browser science-aaas
sciretriever config test --browser springerlink
sciretriever config test --browser wiley-online-library
```

它只打开所选 production rule 的首页，检查 runtime 与目标可达性。它不访问任意文章、不下载
PDF，也不评估当前机构 IP 或具体文章 entitlement，不持久化结果。未支持的 access key 不会导航
或猜 URL。开关、Playwright 或 Chromium 未就绪时以稳定原因 `skipped`；只有本地就绪时才会
启动 probe。

这些是唯一会主动发起网络请求的配置命令。请求经过共享 DNS/TLS/redirect/origin/限速、
响应预算与脱敏边界。
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
完整服务参数与对应凭据。PDF 补全需要 `paths`，并会在构造期拒绝任何已启用
但不就绪的 Acquisition Provider；内容补全还需要完整 Parser、Analysis 配置与相应
凭据。纯本地查询、三种书目交换、手动 PDF 只需要安全 Storage 路径。

启用但缺少生产实现、普通参数、必需凭据或访问政策会在外部调用和 Storage 创建前
稳定失败，不会静默跳过或伪装为零结果。真实调用后的认证、授权、quota、网络或服务
失败属于该次 Provider failure：Metadata 仍可保留其它来源的已提交成功；Acquisition
也不能把这种不确定失败写成 `NoPrimaryPdf` 或自动获取耗尽。

## 7. 普通配置示意

仓库中的 [`example/config.example.toml`](../../example/config.example.toml) 提供同一合同的
可复制、默认不启用外部 Provider 的完整注释示例。下面片段展示一个纯本地
Library/书目交换基础和一组可选的外部能力参数。请把
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
providers = ["arxiv", "unpaywall", "core"]

[sources.acquisition.unpaywall]
contact_email = "operator@example.org"

[parsing]
base_url = "http://127.0.0.1:8000"
connection_mode = "loopback"
model_identity = "mineru-3.4.4-vlm"
remote_upload_authorized = false

[agents]
provider = "openai"
protocol = "openai-responses"
base_url = "https://api.openai.com/v1"
authentication = "api-key"

[agents.analysis]
model = "operator-selected-model"
context_window_tokens = 300000
max_output_tokens = 4096
structured_output = true
deadline_seconds = 180.0

[analysis]
metadata_max_output_tokens = 1024
content_max_output_tokens = 4096
reference_max_output_tokens = 1024
max_input_bytes = 1048576
max_chunk_bytes = 262144
max_chunk_count = 4
max_total_llm_requests = 6
max_total_output_tokens = 12288

[execution]
max_concurrency = 4

[library]
max_input_bytes = 67108864

[assets]
[access]
```

这份文件在结构上合法，但外部能力是否可运行仍取决于统一凭据文件、
当前生产 capability 与 Network policy。`config status --json` 可做不联网的本地检查；
只有用户明确需要验证真实服务时才执行 `config test`。

上例中的 CORE 还要求另行执行 `sciretriever config`，选择 CORE 后设置 `api_key` 并写入
固定凭据文件；不能把 key 写进这份普通配置。启用 CORE 只注册授权 API Source，不保证任意文献
都有 CORE `work:`/`output:` 身份或具体下载 entitlement。
