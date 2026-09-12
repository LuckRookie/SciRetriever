# SciRetriever 配置手册

SciRetriever 把配置分成两条互不替代的边界：

- 普通运行设置固定写在 `~/.sciretriever/config.toml`；
- 文献 Provider、Model Provider 与远程 MinerU 的 secret 统一写在固定的
  `~/.sciretriever/credentials.toml`。

普通配置和凭据都由根级 `sciretriever.configuration` 读取，根级
`sciretriever.bootstrap` 再按当前命令需要的能力组装生产对象。普通配置模型严格、
不可变、拒绝未知字段，而且不包含任何 secret。当前没有文件级版本字段、普通配置内的
凭据组或凭据引用、runtime factory，也不保留旧配置生产兼容层。旧普通配置路径和
LLM/MinerU secret 环境变量都不属于当前合同，不读取、不回退，也不迁移；旧 singleton Agents
schema 不能映射为当前配置。裸 `config` 只接受唯一当前 schema，不提供 Reset、迁移、恢复或
fallback。

## 1. 固定用户配置文件

安装后的所有正常命令只读取：

```text
~/.sciretriever/config.toml
```

Configuration 是该路径规则的唯一 owner。CLI 不提供 `--config`，不读取配置路径环境变量，
也不检查当前工作目录或项目根的 `config.toml`。因此从不同目录运行会得到同一配置身份。
固定文件缺失时，业务命令、`config status` 和 `config test` 会给出初始化提示，不会猜测或
回退到旧位置。

推荐执行 `sciretriever config` 进入统一配置中心。打开后不做修改可以安全退出；第一次确认
普通配置修改时，Configuration 会创建 `~/.sciretriever/` 和 `config.toml`。用户也可以直接
创建或编辑同一个文件，例如从公开模板开始：

```bash
mkdir -p ~/.sciretriever
chmod 700 ~/.sciretriever
cp -n example/config.example.toml ~/.sciretriever/config.toml
chmod 600 ~/.sciretriever/config.toml
```

上面的 `cp -n` 在目标已存在时不会覆盖；已有配置必须先比较再人工合并，不能直接
覆盖。普通配置、凭据和 Browser 状态共用的 `~/.sciretriever/` 必须是当前用户拥有、权限
精确为 `0700` 的真实非符号链接目录。普通配置文件必须是当前用户拥有、权限精确为 `0600`、
单硬链接的普通非符号链接文件。

普通配置文件必须是 UTF-8 TOML、普通非符号链接文件，且不超过 1 MiB。读取通过
一个有界文件描述符完成并复核文件身份，路径或内容在读取期间发生替换时会
fail closed。普通配置不是 secret，但其中仍不得写入任何 secret；严格权限用于保护与凭据、
Browser Profile 共用的用户目录边界。

旧的当前目录文件或旧环境变量曾指向的文件不会被自动读取、复制、移动或删除。人工迁移时：

1. 先检查 `~/.sciretriever/config.toml` 是否已经存在；
2. 目标不存在时，把旧文件复制到固定位置；目标存在时，在编辑器中人工比较并合并；
3. 将目录设为 `0700`、目标文件设为 `0600`；
4. 运行 `sciretriever config status` 验证结构与本地 readiness；
5. 确认迁移成功后，再由用户自行决定是否保留旧文件。SciRetriever 不会删除它。

一个零字节文件是合法 TOML，并等价于十个使用字段默认值的配置组；这只证明结构可解析。
空配置具有 Metadata/Acquisition Auto 选择和默认逐 Source `limit = 500`，但没有 Storage 路径、
Parser 或 Analysis 参数。`config status` 仍可据此输出本地 capability 矩阵，但所有当前业务 Entry scope
都会先返回 `paths-not-ready`，不会把空结构解释成完整默认运行环境。

若固定 `config.toml` 是 malformed TOML、包含未知 section/key，或字段值不符合当前 schema，
裸 `sciretriever config` 会在首页前返回退出码 4，并显示不含配置值的固定原因；它不显示菜单，
也不写入文件。旧 `[agents]`、`[analysis]`、`[access]`、`[models.services.*]`、
`[models.profiles.*]` 与 `[models.entries.*]` 和未知普通 section 一样处理；旧 credentials
`[agents]`、`[models.*]` 与未知凭据 section 一样处理。文件过大、符号链接、非普通文件、不安全
所有权/权限、目录问题和读取竞争也会严格拒绝。operator 必须在配置中心之外手工编辑或替换精确
文件，删除旧 section 并保持本节的权限要求，然后从 `Models → Add` 与
`Models → Providers → Key` 按当前 schema 重新配置。SciRetriever 不转换、备份、自动删除或
回退旧内容。缺失的 `config.toml` 仍可打开
配置中心，并在第一次确认修改时通过正常原子发布创建。
其它 `config` 页面或 `status/test` 失败时，CLI 只显示 Configuration 已列入安全清单的固定原因；
任意原始异常文本、配置值、路径参数或 secret 仍统一压成 `configuration operation failed`。文献业务
命令继续使用泛化配置错误，不把配置中心的诊断细节扩散到其它输出合同。

## 2. 普通配置的十组合同

普通配置只接受以下十个顶层组；各组都可省略，并由严格模型补成空组或字段默认值：

```text
paths
sources
assets
parsing
providers
models
analyze
execution
library
browser
```

未知顶层组、未知字段、错误类型、未知枚举、重复 Provider、重复 TOML key 和旧字段都会
被拒绝。旧 `[discovery]` 不兼容读取或迁移。

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

### `[sources]`

`sources` 分成两个互不混用的能力集合，默认都使用 Auto：

```toml
[sources.metadata]
mode = "auto"
limit = 500

[sources.acquisition]
mode = "auto"
```

| 位置 | 字段 | 类型 | 默认值 | 用途 |
| --- | --- | --- | --- | --- |
| `sources.metadata` | `mode` | `auto` 或 `custom` | `auto` | 选择版本默认集合或用户精确集合。 |
| `sources.metadata` | `providers` | 有序、不可重复数组 | 空 | 仅 Custom 使用；允许空列表。 |
| `sources.metadata` | `limit` | 大于等于 1 的整数 | `500` | 分别应用到每个 Metadata Source 的过滤前原始 item 上限。 |
| `sources.acquisition` | `mode` | `auto` 或 `custom` | `auto` | 选择版本默认集合或用户精确集合。 |
| `sources.acquisition` | `providers` | 有序、不可重复数组 | 空 | 仅 Custom 使用；允许空列表。 |

Auto 禁止同时保存非空 `providers`，有效集合由当前版本在本地确定，不根据凭据、Network probe
或临时服务状态变化。Custom 精确保留用户数组与顺序；空列表表示不启用该能力的命名 Provider。
升级可以维护 Auto catalog，Custom 不随 catalog 改变。不存在 preset、include/exclude 或按 Key
自动启用。

当前 Metadata Auto 有序集合是：

```text
crossref, semantic-scholar, arxiv, openalex,
europe-pmc, datacite, core, opencitations
```

OpenCitations 不参加主题搜索，因此默认 `limit = 500` 时主题搜索的理论 raw-item ceiling 是
`7 × 500 = 3500`。`limit` 独立给每个参与 Source，不是共享总量、最终接纳数量或 HTTP 请求数。

当前 Acquisition Auto 的命名 Source 是 `arxiv, europe-pmc`。所有模式都会消费已经保存且安全
验证通过的 direct/landing `AssetHint`；Crossref、Semantic Scholar、OpenAlex、DataCite 等提供的
公开 hint 不需要再启用同名下载服务。Sci-Hub、Unpaywall、授权 PDF API 和 Browser 不进入 Auto。

选择 Custom 时，两个 `providers` 字段都是按顺序、不可重复的 Provider key 数组。
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

启用 `web-of-science` 时还必须保留有效的 `sources.metadata.limit`，并在固定凭据文件中
提供 `api_key`。

#### `[sources.metadata.crossref]`

| 字段 | 类型 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `mode` | `anonymous` 或 `polite` | 未写入时 `anonymous` | 选择 public 或 polite pool。 |
| `mailto` | ASCII 联系邮箱或省略 | 未配置 | `polite` 必需，`anonymous` 禁止。 |

`mailto` 是公开联系身份，不是 secret，因此不进入 `credentials.toml`。

#### `[sources.acquisition.unpaywall]`

| 字段 | 类型 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `contact_email` | ASCII 联系邮箱 | 必需 | 启用 Unpaywall 时必需，属于普通配置。 |

#### `[sources.acquisition.sci-hub]`

```toml
[sources.acquisition]
mode = "custom"
providers = ["sci-hub"]

[sources.acquisition.sci-hub]
urls = [
  "https://mirror-one.example",
  "https://mirror-two.example/base",
]
```

| 字段 | 类型 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `urls` | 一到八项字符串数组 | 不写入时使用当前版本 builtin | 可选 custom override；完整覆盖 builtin；有序、规范化后不可重复；只接受 hostname-based HTTPS 默认端口，不接受 userinfo、query、fragment、IP literal、loopback 或不安全路径。 |

Sci-Hub Source 默认关闭。显式启用且没有 `[sources.acquisition.sci-hub]` 时使用当前版本 bundled
mirror set；custom `urls` 一旦存在就完整覆盖 builtin，升级不会改写它。operator 仍须自行确认
适用法律、机构政策、内容许可与服务条款。有效列表顺序就是尝试顺序：系统不会并发或自动发现
镜像，也不会配置 API key、Cookie、session、代理、selector 或脚本。resolver 只对具有规范 DOI
的 Literature 适用；实际 landing/PDF 仍经过共享 Network、有限静态 PDF locator 解析和统一 PDF
字节检查。Challenge、登录页或普通 HTML 不能冒充 PDF。

交互入口是 `Download → Sources → sci-hub`。未启用时显示 `Enable / Mirrors / Back`，Enable 直接
使用当前有效列表；已启用时显示 `Mirrors / Disable / Back`。镜像编辑器使用
`Add / Remove / Save / Reset / Back`：Save 形成 custom override，Reset 删除 custom 并重新跟随
builtin，禁用保留 custom。整个流程不会询问 API Key。程序集成方仍可显式注入
`ConfiguredLocatorResolver`，优先级高于 custom 与 builtin，但这不是第二套用户配置 schema。

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
`unsupported`。已有通用 AssetHint 路由的 Provider 仍可贡献公开线索。Sci-Hub 在启用时由 stock
production 从 custom `urls` 或当前版本 builtin 自动构造 DOI locator resolver，不会要求终端用户
填写 URL 或注入对象。受控 Browser 只有一条 `browser:generic` production route 和一个
`browser-generic` 调度组；它不内置 Publisher 点击规则，也不要求起点属于预先列出的出版社。
普通配置通过独立 `[browser]` 选择 Agent Model 与固定身份 Profile、显式启用 Browser、设置本机
资源上限，并可用封闭 override 把通用调度政策收得更严格。

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

### `[providers.<name>]` 与 `[models."<provider>/<model>"]`

模型配置固定分为 Model Provider 与 Model 两层，任务选择位于各自模块：

```toml
[providers.openai]
api = "openai-responses"
base_url = "https://api.openai.com/v1"

[models."openai/operator-selected-model"]
reasoning = "max"
image = false
stream = true
```

Model Provider 字段为：

| 字段 | 类型 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `api` | `openai-responses`、`openai-chat-completions` 或 `anthropic-messages` | 必需 | 明确 wire API；实际响应模式由具体 Model 的 `stream` 决定。 |
| `base_url` | 非空安全 URL | 必需 | Provider 的模型目录与调用 Base URL。 |

Provider name 来自 `[providers.<name>]` 的子表名，只允许以字母或数字开头的 ASCII 字母、数字、
`-`、`_`、`.`，读取时统一小写。远程 Provider 必须使用 hostname-based HTTPS，并从凭据文件中
取得与规范 origin 精确绑定的 API key；HTTP loopback Provider 不使用 key。URL credential、
query、fragment、不规范主机、远程 IP literal 和 HTTPS loopback 都会被拒绝。

Model 的唯一身份就是 TOML 子表名中的完整 `provider/model` reference；第一个 `/` 之前必须对应
已经存在的 Provider，之后是最多 512 bytes 的 NFC、单行 UTF-8 远端 model identity。Model 只
接受三个字段：

| 字段 | 类型 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `reasoning` | `default`、`none`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` | `default` | 该 Model 的思考程度。 |
| `image` | Boolean | `false` | 该 Model 是否能读取图片；Download 只允许选择 `true`。 |
| `stream` | Boolean | `true` | 是否使用该 API 的流式响应；三种当前协议统一遵守。 |

`default` 让 adapter 完全省略 wire reasoning 字段；其它值按适用 API 精确编码，不降级、近似映射
或失败后重试 default。省略 `stream` 等价于 `stream = true`；开启时 adapter 请求有界 SSE 并在 Agents 内重建完整结果；
`stream = false` 时只请求和解析非流式 JSON。两种模式失败后都不会切换模式补发请求。
Model 不保存 context window、max output、structured output、tool
decision、图片 MIME、数量或字节上限。这些是消费模块的调用合同：Analyze 派生 strict structured
output、text-only、no-tool 和业务预算，Download 派生当前生产 Observation 的 `image/jpeg`、单图、tool
decision 与内部安全上限。
模型目录也只提供 model ID；`image` 与具体 reasoning 支持由用户依据 Provider 文档确认，并通过
显式 probe 验证，不能根据 model 名称猜测。

Provider 被任一 Model 引用时不能删除；Model 被 Analyze 或 Browser 选择时也不能删除。一个
`provider/model` 只有一份配置；需要改变思考程度时直接编辑该 Model，而不是创建本地别名、预设
或 Profile。

### `[analyze]`

`[analyze]` 直接选择一个完整 Model reference，并保存文献分析自身的 chunk、阶段和总量预算；
它不拥有或覆盖 Provider、远端 model、reasoning、image 或 stream。

| 字段 | 类型 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `model` | `provider/model` 或省略 | 未配置 | Analyze 使用的 Model。 |
| `metadata_max_output_tokens` | 大于等于 1 的整数或省略 | 未配置 | metadata 阶段输出上限。 |
| `content_max_output_tokens` | 大于等于 1 的整数或省略 | 未配置 | content 阶段输出上限。 |
| `reference_max_output_tokens` | 大于等于 1 的整数或省略 | 未配置 | 引用 lookup 输出上限。 |
| `max_input_bytes` | 大于等于 1 的整数或省略 | 未配置 | 内容分析总输入字节上限。 |
| `max_chunk_bytes` | 大于等于 1 的整数或省略 | 未配置 | 单 chunk 字节上限。 |
| `max_chunk_count` | 大于等于 1 的整数或省略 | 未配置 | chunk 数量上限。 |
| `max_total_llm_requests` | 大于等于 1 的整数或省略 | 未配置 | 单次内容分析的总 LLM 请求上限。 |
| `max_total_output_tokens` | 大于等于 1 的整数或省略 | 未配置 | 单次内容分析的总输出 token 上限。 |

引用发现需要选中的 Model、其 Provider/exact-origin key 与 `reference_max_output_tokens`；
`content` 补全还要求全部业务预算字段。程序用 Analysis/Bootstrap 派生的保守 UTF-8 字节与单次
output 边界检查输入；这些边界不是 Model 用户字段。`Analyze → Setup` 会在业务预算缺失时生成
安全初值，已有完整值原样保留，并在同一流程提供 Conservative、Balanced、Large 与逐项 Custom；
最终写入明确数值，不保存 preset name。

### `[execution]`

| 字段 | 类型 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `max_concurrency` | 整数 | `4` | 范围 1 到 64；用于数据库补全目标的进程内并发。 |

### `[library]`

| 字段 | 类型 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `max_input_bytes` | 整数 | `67108864` | 范围 1024 到 1073741824；限制一次书目导入输入。 |

### `[browser]`

当前保存 Browser-last 能力的非 secret 本地选择：

```toml
[browser]
# model = "openai/operator-selected-browser-model"
enabled = false
# profile = "institutional-access"
max_concurrency = 5
policy_overrides = []
```

| 字段 | 类型 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `model` | `provider/model` 或省略 | 未配置 | Browser Agent 使用的 Model；必须配置 `image = true`。 |
| `enabled` | 布尔值 | `false` | Browser 总开关；启用时必须同时选择并初始化 `profile`。 |
| `profile` | 字符串或省略 | 省略 | 一个不含敏感信息的 Profile identity，不是路径、账号、机构名、URL、UUID、Token 或 Cookie 标签；由 `sciretriever config` 选择和初始化。 |
| `max_concurrency` | 整数 | `5` | 必须是大于 1 的整数，不设上限；只保护本机 Browser 资源，不改变 `browser-generic` 固定串行。 |
| `policy_overrides` | inline table 数组 | `[]` | 只能收紧 `browser-generic`；未知、重复或放宽的 group 会拒绝。 |

单项 policy override 可以收紧组内并发、文章启动间隔、窗口计数/时长、完成/失败/限速冷却和
runtime failure threshold。并发、窗口计数和 failure threshold 只能减小；interval、window
duration 和 cooldown 只能增大。窗口计数与时长必须成对出现，负数、零值非法位置、`inf`、
`nan` 和空 override 都会拒绝。普通配置不能改写通用 group、policy revision、起点、页面动作、
PDF 验收或官方 `Retry-After` 语义。

`policy_overrides` 中的每项必须写 `rate_limit_group = "browser-generic"`。当前基线固定为并发 1、
最小启动间隔 1 秒、每小时最多 120 次启动、限流冷却 60 秒、普通失败冷却 5 秒和连续 3 次
runtime failure 熔断；override 只能进一步收紧这些值。较大的 `max_concurrency` 不会启动多个
Browser，也不会让 `browser-generic` 同时处理多篇文章。

配置不接受逐 Publisher 的本地许可、route、selector 或规则字段。`enabled = true` 启用唯一通用
route，但不会证明组织合同、机构 IP、Profile 已登录或具体文章权限；每篇文章仍区分正文捕获、
付费墙、通用拒绝、challenge、限流、错误文章、补充材料和证据不足。

Browser 选择完整 Model reference，不覆盖 Model 的 Provider、reasoning、image 或 stream，也不改变
Analyze。tool decision、当前生产 Observation 的 `image/jpeg`、图片数量/字节与单次调用上限由
Acquisition/Bootstrap 派生。
当前 Browser 使用本机正常网络出口和一个 operator-managed 持久 Profile，固定以
`headless = false` 启动一个 Chrome process/persistent context；无 GUI Linux 使用 Xvfb 虚拟显示。
Publisher 请求由 Chrome 原生网络栈完成，本机 CONNECT proxy 只执行已审核 hostname/port 到精确
IP 的绑定和加密字节透传。普通配置只接受 opaque Profile identity，不接受 Profile 路径、Cookie、
local storage、登录名、机构身份或代理设置；这些认证内容也不进入 `credentials.toml`。Chrome
自己管理的 Cookie、Local Storage、IndexedDB、SSO 状态、偏好和历史只留在固定 owner-only Profile
目录中。Network 的 URL、DNS、TLS、redirect、origin、请求/响应预算、限速、`Retry-After` 与
脱敏策略仍来自固定 Provider/Profile 合同，普通配置只能收紧。

## 3. 统一凭据文件

文献 Provider、Model Provider 与远程 MinerU secret 只有一个生产来源：

```text
~/.sciretriever/credentials.toml
```

该文件与普通配置共处同一个固定用户目录，但保持独立文件、独立 schema 和独立发布责任，
也不能通过 CLI 选择另一份。目录必须是当前用户拥有、
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

[providers.openai]
api_key = "<secret>"
origin = "https://api.openai.com"

[mineru]
bearer_token = "<secret>"
origin = "https://mineru.example.invalid"
```

`[providers.<provider>]` 与 `[mineru]` 的 secret 必须与保存时的规范 origin 精确绑定。Model
Provider section name 必须对应普通配置中的 `[providers.<provider>]`；同一 Provider 下的多个
Model 复用该 key。Bootstrap 只为当前任务实际选择的 Model Provider 读取 key，并只发送给同一
origin。修改 Base URL 后，旧 secret 不会被发送到新 Provider，跨 origin redirect 也不携带它。
loopback Model Provider/MinerU 不保存或读取对应 secret。

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
sciretriever config test provider <name> [--json]
sciretriever config test model <provider/model> [--image] [--json]
sciretriever config test search <source> [--json]
sciretriever config test search --all [--json]
sciretriever config test download <source> [--json]
sciretriever config test download --all [--json]
sciretriever config test parse [--json]
sciretriever config test analyze [--json]
sciretriever config test browser model [--json]
sciretriever config test browser site <publisher-access-key> [--json]
sciretriever config test --all [--json]
```

### 裸 `config` 交互管理器

执行 `sciretriever config` 即进入统一配置中心。首页固定为单词级：

```text
Models / Search / Download / Parse / Analyze / Browser / Status / Theme / Quit
```

首页只读取本地状态并明确显示不发网络请求；外部测试位于对应 owner 页的 `Test` 或公开
`config test` 命令，只能由用户显式触发。

菜单左列继续只使用单词级责任名称和动作标记，右列显示不改变选项值的解释与本地状态。首页的
右列直接预览各 area 的 Ready/Incomplete/Off 状态及关键选择；`Status`、`Theme` 和 `Quit` 显示
各自作用。选择列表是 area 状态与导航的唯一表示，前面不会再打印一份重复的静态
`CONFIGURATION AREAS` 表格。顶部 Panel 只保留普通配置/凭据文件位置和 `LOCAL · NO NETWORK
REQUESTS` 边界。说明过长时按当前终端宽度安全截断，不改变左列标签、快捷键或所选值。

TTY 使用 Rich + prompt-toolkit 的非全屏界面，支持方向键、Enter、Esc/左方向键返回、
`M/S/D/P/A/B/I/T/Q` 首页快捷键与隐藏输入；模型和 Literature Provider 等长列表还支持 `/`
搜索。重定向输入或基础终端使用确定性编号菜单。主题支持 `auto/dark/light/mono`，`NO_COLOR`
始终强制单色。交互内容只写 stderr，stdout 为空；Ctrl+C/EOF 取消不会写文件。公开子命令只有
`status` 和 `test`，旧 `config set/remove` 作为无效输入拒绝。

所有二级及更深的选择菜单都在页面动作后保留两种不同的导航语义：`Back`
只返回上一级，自动追加的 `Quit` 从任意层级直接关闭整个配置中心。Esc/左方向键等价于
`Back`；Ctrl+C、输入取消和保存确认取消仍只终止当前未保存操作，不会被解释为 `Quit`。

所有普通设置操作都更新固定的 `~/.sciretriever/config.toml`；文献 Provider、Model Provider、
MinerU 和可选 CloakBrowser secret 操作只更新同目录下的 `credentials.toml`。两者不会被合并。配置
中心支持当前 Model、Source、Browser、Parser、Analyze 与凭据用例；其它普通字段仍可直接编辑固定
配置文件。直接编辑后必须保留本手册第 1 节的权限与严格 TOML/schema 合同。

`Models` 页固定为 `Add / <Model> / Providers / Back`；具体 Model 页为
`Edit / Test / Remove / Back`。
`Providers` 页固定为 `Add / <Provider> / Back`；具体 Provider 页为
`Edit / Key / Test / Remove / Back`。Provider 只管理 name、API、Base URL 与 exact-origin Key；
Model 只管理完整 `provider/model` reference、reasoning、image 与 stream。远程 Key 使用隐藏输入，从不回显
mask、长度、前后缀、hash 或 fingerprint。任务必须在自己的页面显式选择 Model。

`Models → Add` 的顺序固定为：选择已有 Provider 或 `New`；新增时选择内置入口或 Custom URL，
确认 API；远程 Provider 在同一流程隐藏输入 Key；Key 就绪后自动通过共享 Network 对当前 Base URL
执行一次有界模型目录读取；选择 model；选择 Reasoning、Image 与 Stream；最后一次确认并原子保存 Provider、
Model 和必要凭据。loopback Provider 不询问 Key。使用已有远程 Provider 时会复用与当前 origin
匹配的 Key，缺少时在该流程补录。

目录请求禁止 redirect，只读取第一页最多 100 项并受响应字节与超时边界约束；结果只采信安全的
model ID，不持久化 catalog、context、capability 或测试状态。认证、timeout、HTTP、格式、大小
失败，目录为空或不能安全解析时显示脱敏原因，然后才出现 `Manual` 输入；正常目录成功时不额外
展示手工分支。`config status`、首页、普通命令和进入 Models 本身都不会读取模型目录。Provider
`Test` 也显式读取同一有界目录，只报告安全数量，不证明任意具体 Model 的调用能力。具体 Model
对象页的 `Test` 可以选择 Text；`image = true` 时还可选择 Image。它使用该 Model 自己的 reasoning
与 stream，
不改变 Analyze 或 Browser 选择；任务合同仍分别由 Analyze 与 Browser 的 Test 验证。

Model Edit 只修改 reasoning/image/stream，不改变唯一 reference；Provider Edit 修改 URL/API 并安全处理
origin-bound Key。Provider 被 Model 引用时不能删除，Model 被 Analyze/Browser 选择时不能删除。
旧 `[agents]`、`[analysis]`、`[access]`、`[models.services.*]`、`[models.profiles.*]`、
`[models.entries.*]` 和旧 credentials `[agents]`、`[models.*]` 会在首页前作为未知 schema 直接
拒绝，不会自动映射、迁移或恢复。operator 手工移除旧 section 后，所需 Key 必须在
`Models → Providers → Key` 中按 Model Provider 重新保存。

Model reasoning 接受 `default/none/minimal/low/medium/high/xhigh/max`。`default` 省略 wire 字段；
Model stream 默认开启，也可在 Add/Edit 中关闭；Analyze/Browser 没有 task-level reasoning、stream
或 capability override。

其它 owner 页固定为：

```text
Search:   Sources / Limit / Test / Back
Download: Sources / Test / Back
Parse:    Setup / Test / Reset / Back
Analyze:  Setup / Test / Reset / Back
Browser:  Setup / Profiles / Runtime / Test / Reset / Back
```

Search/Download 的 Sources 使用 Auto/Custom 两层。Auto → Custom 会冻结当前有效集合与顺序；
Custom → Auto 会删除固定 providers 并重新跟随版本 catalog。Search 的 Limit 修改唯一逐 Source
raw-item 上限。选中具体 Source 后，对象页按能力提供 `Setup`、`Key`、`Test`、`Enable` 或
`Disable`；Search Auto 的 Crossref anonymous/polite 也在 Crossref 的 `Setup` 中配置。凭据和普通
参数不会改变有效集合。Sources 选择列表的右列同时显示 Active/Off、用途以及当前能力的凭据合同
和本地存在状态；例如 CORE 在 Search 显示 API key 可选，在 Download 显示 API key 必需。这里
只读取 secret 是否存在，绝不显示值、长度或特征。Sci-Hub 只提供 `Mirrors` 和配置 Test，不会询问
Key；该 Test 不访问镜像或下载 PDF。

`Analyze → Setup` 选择全部已配置 Model 并连续确认八项业务预算；首次选择 Model 时缺失预算会使用
产品固定安全初值，已有完整预算保持不变。`Browser → Setup` 只列出 `image = true` 的 Model，并
连续确认 Profile 与本机资源 cap。两者都只更新完整 Model reference，不
修改 Model 或另一个任务。

`Parse → Setup` 连续配置当前真实的 MinerU 3.4.4 / protocol 2 / `vlm-engine` 部署。loopback 不询问
token；remote 在同一流程先明确授权源 PDF 离开本机，再收集 exact-origin bearer token。Reset
原子清空对应普通 section 与 token，不留下半配置状态。

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
# Download → Sources → wiley
# wiley → Key → Set
```

向导会给出 Wiley 官方 token 入口 `https://static.wiley.com/tdm/`，并提示在普通配置中把
`wiley` 加入 `[sources.acquisition].providers`。本地写入成功只说明字段存在；它不验证
Wiley 是否接受 token、token 是否符合 Wiley 当前签发格式、当前公网 IP 是否位于授权范围
或具体 DOI 是否有全文 entitlement。

移除动作只删除所选 Provider section并原子发布，其它 section 保留；存在 section 时必须
确认，未配置时明确提示且不写文件。它不修改普通配置，也不删除已经接纳的文献事实或资产。

Download 区只管理 CORE、Elsevier、Wiley 等 PDF Source；其普通设置、Key 和 Test 都在对应 Source
对象页。独立的 `Browser` 一级页管理受控 Browser 路线：

1. 选择或初始化一个 Browser Profile，并一次生成固定 identity manifest；
2. 永久删除选中的本地 Profile、identity manifest 及其中由 Chromium 管理的状态；
3. 禁用自动 Browser access，同时保留 Profile、并发上限、policy override 和 Provider API credential；
4. 选择唯一 Agent controller 使用的图片 Model；Browser Model probe 可在真实下载前单独验证；
5. 设置本机 Browser 资源 cap；只接受大于 `1` 的整数，不设置上限，通用执行组仍固定串行。

`Browser → Runtime` 显示 CloakBrowser wrapper、Playwright API、binary presence/version/signature
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
status 或日志。初始化与配置修改在同一确认后完成；取消不会创建 Profile、修改 `[browser]` 或启动
Browser。自动 Browser 使用当前机器正常网络出口和同一持久 Profile，无 GUI Linux 使用 Xvfb。
第一版不提供可见 Browser 登录、机构选择、MFA 或 Cookie 导入导出入口。
SciRetriever 不导航登录页、不填写凭据、不选择机构、不读取 Cookie 或登录结果，也不处理或绕过
MFA。页面 Challenge 与普通文章页使用同一 Observation/Action 合同。当前 production Browser route
只有 `browser:generic`；Publisher access key 仅用于用户显式发起可达性 probe，不再决定下载 route。
route 已安装、Profile/identity 就绪、总开关与 runtime ready 都不能证明机构 IP 或具体文章具有
entitlement。

所有菜单动作都同时使用颜色和单色可见标记区分：`◆` 配置、`◇` 查看、`▶` 测试、`!` 危险、
`←` 返回、`×` 退出。颜色不可用时仍能从标记理解动作性质。

### `config status`

`status` 读取普通配置和统一凭据文件，只做本地静态检查；不构造 Catalog、ArtifactStore
或 Network，也不发请求。默认用紧凑 Panel/Table 分开显示 Model Providers/Models、Analyze、
Download、Parse、Metadata APIs、
authorized primary-PDF APIs、PDF acquisition routes、Controlled Browser 与
Storage/execution；`--json` 使用稳定分组结构供
脚本消费且永不包含 ANSI。JSON 顶层稳定分为
`models/analyze/download/parsing/providers/storage/execution/library`。PDF Acquisition 依次展示：

- `Public sources`：共享的已保存 direct/landing hints，以及 arXiv、Europe PMC、
  Unpaywall、operator locator 等独立公开服务的本地就绪状态；
- `Authorized Provider APIs`：逐 Provider 显示是否已有可执行主 PDF API、当前限制和
  所需凭据字段；
- `Controlled browser`：显示持久固定身份 Profile、选中的 opaque identity 及其存在/安全状态、
  Cloak wrapper/Playwright API/binary/version/signature/Xvfb、本地 runtime readiness、唯一
  `browser:generic` route、总开关、共享 process/context、`browser-generic` policy、未评估的文章
  entitlement、可选 Publisher reachability probe 和下一动作。

Metadata 人类表格只逐项展开当前有效或已有凭据的 Provider，其余禁用能力以数量摘要收起；
完整 capability matrix 仍保留在 JSON。授权 PDF API 不与 Metadata 合并，只展开当前有效
Acquisition Source 中的 CORE、Elsevier、Wiley 或当前不支持直接主 PDF 的 Springer API。Browser
分区只显示 `browser:generic`，再根据总开关、Profile/identity manifest、Cloak wrapper、Playwright API、
经核实 binary 与 headed display 的实际静态状态给出 `browser-disabled`、`browser-profile-not-selected`、
`browser-profile-missing`、runtime 未就绪原因或 ready。
`browser-production-route-unavailable` 只是通用 route 未安装时的 fail-closed 分支，不是当前默认
状态。合法文章起点不需要匹配 Publisher 下载规则；Network admission 与 Acquisition 的 PDF
文章归属验收仍然必须通过。

JSON 的 Provider 分区保留完整矩阵，并为每个已接受 Provider 报告以下层：

- `production_available`：该 capability 是否有当前可执行生产实现；
- `enabled`：是否属于 Auto/Custom 解析后的当前有效集合；
- `ordinary_parameters_ready`：Provider 专属产品选择、联系身份等普通参数是否齐备；Metadata 的
  正数逐 Source `limit` 已由普通配置模型保证；
- `credential.status`：凭据是 `not-required`、`configured`、`partial`、`missing`、
  `optional-missing` 还是 `unsupported`；
- `access_policy_ready`：固定 Network 访问合同是否存在；
- `probe_available`：是否实现了独立的最小只读 probe；
- `local_ready` 与 `failure_code`：组合后的本地 readiness 与稳定原因。

字段状态只显示名称、必需性和是否存在；不显示值、掩码、长度、前后缀、hash 或
fingerprint。`enabled = false` 不会改写其它 readiness 层：status 是完整矩阵，而实际
运行只注册已启用且就绪的能力。`configured` 只说明本地必需/可选字段存在，不表示
认证已成功；Acquisition 的 `local_ready` 也不表示当前具体 Literature 有全文授权。

Browser JSON 位于顶层 `browser`，稳定区分：

- `model`、`selected_model` 与 `model_locally_ready`：明确 Agent 使用的完整 Model reference、Model
  配置和本地 readiness；
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
- `routes`：当前只有 `browser:generic`，并显示 `browser-generic` 的项目保守 policy revision、
  验证日期、Notes 引用和有效限速；不含 origin、selector 或页面规则；
- `probe` 与 `action_required`：可显式探测的精确 access key，以及稳定 code/reason/action。

`status` 不启动 Browser，也不读取或枚举 Cookie、local storage、origin history、站点登录信息或
Profile 目录内容。
JSON 和人类输出都不包含 ANSI 以外的隐藏控制数据、secret 掩码/hash/fingerprint 或原始异常。

Storage 分区显示 Catalog/ArtifactStore 是否配置及其当前非 secret 路径。Parse 分区
显示固定实现身份、`base_url`、连接模式、模型身份、远程上传授权、缺失普通字段，以及
远程 bearer token 是否必需/存在/origin 匹配；Models 分区逐项显示 Model Provider 的 API、Base
URL 与 API key presence/origin match，以及 Model 的完整 reference、reasoning、image 与 stream。
Analyze/Browser JSON 分区显示各自所选 Model、业务参数和 readiness，并提示
`config test analyze` 或 `config test browser model` 才能验证本地声明；`download` 分区只显示
Acquisition Source 选择，不再承载 Browser 配置。
未启用但已有凭据的 Provider
仍会显示，便于发现遗留或预配置凭据。这里的 `ready` 只表示本地配置完整，不代表外部
服务或认证已经成功；任何 secret 值都不会显示或进入 JSON。

### `config test`

配置测试只回答“当前配置是否能完成一个安全、最小的外部握手”，不替代正式业务流程。交互 TUI
与下列结构化命令调用同一个 `ProductionConfigurationProbeSession`，该 Session 复用生产 adapter、
共享 Network 和限速，但不构造 Storage：

```text
sciretriever config test provider <name> [--json]
sciretriever config test model <provider/model> [--image] [--json]
sciretriever config test search <source> [--json]
sciretriever config test search --all [--json]
sciretriever config test download <source> [--json]
sciretriever config test download --all [--json]
sciretriever config test parse [--json]
sciretriever config test analyze [--json]
sciretriever config test browser model [--json]
sciretriever config test browser site <publisher-access-key> [--json]
sciretriever config test --all [--json]
```

- `provider <name>` 对已经配置的 Model Provider 执行一次有界、无 redirect/retry 的模型目录
  GET，只报告数量与是否截断；目录成功不证明某个 Model 支持 reasoning、strict output、图片或工具。
- `model <provider/model>` 对精确 Model 发送固定极小 strict-schema Text 请求；`--image` 改为一张
  程序生成的 1×1 `image/jpeg` 与一个封闭停止工具，仅允许 `image = true` 的 Model。两者使用 Model 保存的
  reasoning 与 stream，不改变 Analyze/Browser 选择，也不发送用户 Literature、PDF、页面或真实 screenshot。
- `search <source>` 即使 Source 当前未启用也可执行其 Metadata 最小只读 probe；`search --all`
  只选择当前启用的 Search Source。本地不就绪项返回 `skipped`，一个失败不阻断其它 Source。
- `download <source>` 与 `download --all` 不借用 Metadata probe，也不下载测试 PDF。当前没有安全、
  与具体 Literature 无关的 Acquisition 外部 probe，因此本地就绪项明确返回
  `acquisition-probe-unavailable`，结果始终不证明 article entitlement；本地不就绪项保留实际
  readiness failure code。单项 Download Test 因未执行外部 Probe 返回退出码 3。
- `parse` 只执行 MinerU `GET health`，验证 healthy、release 3.4.4、protocol 2 与 `vlm-engine`；
  不提交 task、不轮询、不取 archive、不上传 PDF。`analyze` 使用当前 Analyze Model 发送最小
  strict-schema 请求。`browser model` 使用当前 Browser Model 发送合成图片与封闭工具，不启动
  Browser 或访问 Publisher。
- `browser site <publisher-access-key>` 是唯一启动受控有头 Browser 的配置测试。人类模式在启动前
  再次确认；无 GUI Linux 使用 Xvfb。它只访问一个 production-approved 最小目标并复用自动获取的
  risk-group scheduler，一次最多导航一次；结果始终保留 `article_entitlement = not-proven` 与
  `persisted = false`。

`config test --all` 汇总当前启用的 Search Source、Download 的可见限制、Analyze 和 Parse；Browser
已启用时加入 Browser Model。它不读取 Model Provider 目录、不测试任意
未选 Model、不启动 Browser Site、不下载 PDF，也不上传 PDF。Download 的
`acquisition-probe-unavailable` 只作为未探测限制展示，不会把其它已经执行并通过的安全 Probe
误判为失败；其它必需 probe 的 failed/skipped 使整体退出码为 3。人类模式在会联网或消耗额度的
Probe 前确认；`--json` 是明确的脚本调用，不交互确认。

测试结束后增加 execution 摘要：owner、逻辑 target、稳定 code、耗时毫秒、下一步，以及可能的网络和额度
影响；JSON 保留原有结果字段并新增 `execution`。`network = not-requested` 表示本地跳过或没有外部下载
probe；`may-have-run` 是保守的副作用说明，不表示已测得请求数或流量。`may_consume_quota` 同样不是额度账单。
测试运行时按 Ctrl+C 会关闭当前 probe session，输出 `configuration-test-cancelled`；CLI 返回 130，TUI
返回当前页面。已发出的请求可能已经消耗额度，取消不会自动重试。

当前 Browser Site 目标是：

```text
sciretriever config test browser site acs-publications
sciretriever config test browser site aip-publishing
sciretriever config test browser site elsevier-sciencedirect
sciretriever config test browser site iopscience
sciretriever config test browser site oxford-academic
sciretriever config test browser site rsc-publishing
sciretriever config test browser site science-aaas
sciretriever config test browser site springerlink
sciretriever config test browser site wiley-online-library
```

它只打开所选 Profile 已核实的首页，检查 runtime 与目标可达性。它不调用 Browser Model，不
使用 Publisher 页面规则，不访问任意文章、不下载 PDF，也不评估当前机构 IP 或具体文章
entitlement，不持久化结果。未支持的 access key 不会导航或猜 URL。开关、Playwright 或
CloakBrowser binary 未就绪时以稳定原因 `skipped`；只有本地就绪时才会启动 probe。

以上是唯一会主动发起网络请求的配置测试。请求经过共享 DNS/TLS/redirect/origin/限速、
响应预算与脱敏边界。
人类结果固定为紧凑的 `Test / Request / Result`：Model、Analyze 和 Browser Model 把实际发送的 wire
Model 与本地 Provider 分行显示，并显示实际 `POST` endpoint 与 `Stream · on/off`；内部完整 `provider/model` reference 只在
结构化 details 中保留。Provider catalog 显示实际 `GET .../models`，MinerU 显示实际 `GET .../health`；
Result 只保留 Passed/Failed/Skipped、最重要的一句原因和失败时的一项下一步。HTTP 失败显示数值
status；只有 Provider 返回已知结构化错误字段时才进一步说明 Model、reasoning、structured output、
image 或 tool 问题。普通 404 只能说明 Model 或 API endpoint 不存在。`--json` 使用同一诊断并增加
`diagnosis.request/reason/action`。这些 URL 均不含 query、Key 或 userinfo；响应 message/body、header、
credential 和原始异常不会显示。
它不创建 Storage、DiscoveryRun、Literature、MetadataObservation、Asset、Report，
也不保存最后结果或时间。Harness、单元测试和安装后离线验收只使用 fake 或
“readiness 不通过所以跳过”的路径，不会调用真实 Provider；受控 fake 的 `passed`
证据也不能解释成生产在线服务当前成功。

需要验证真实产品能力时使用正式命令：Search 走 `discover topic`，PDF 获取走 `complete pdf`，
Parse 与 Analyze 的真实内容链路走 `complete content`。这些命令会按正常合同创建或更新业务事实，
与不持久化的配置 Probe 不是同一类操作。

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

领域发现要求非空的有效 Metadata Source 选择和 `paths`；默认 Auto 已提供当前版本安全集合，
Custom 空列表则明确不具备该能力。实际只有有效、就绪且具有 topic-search 的 adapter 参加主题
搜索，每个 adapter 独立获得 `sources.metadata.limit`。引用发现还需要引用 Analysis 的
完整服务参数与对应凭据。PDF 补全需要 `paths`，并会在构造期拒绝任何已启用
但不就绪的 Acquisition Provider；内容补全还需要完整 Parser、Analysis 配置与相应
凭据。纯本地查询、三种书目交换、手动 PDF 只需要安全 Storage 路径。

启用但缺少生产实现、普通参数、必需凭据或访问政策会在外部调用和 Storage 创建前
稳定失败，不会静默跳过或伪装为零结果。真实调用后的认证、授权、quota、网络或服务
失败属于该次 Provider failure：Metadata 仍可保留其它来源的已提交成功；Acquisition
也不能把这种不确定失败写成 `NoPrimaryPdf` 或自动获取耗尽。

## 7. 普通配置示意

仓库中的 [`example/config.example.toml`](../../example/config.example.toml) 提供同一合同的
可复制的完整注释示例。下面片段展示一个本地 Library/书目交换基础和默认 Source 选择；纯本地
命令不会因为 Auto 而联网，只有明确发起 Discovery/Completion 才使用对应外部能力。请把
Storage 路径、模型身份、Provider 选择与安全授权换成自己的实际设置；不要把 secret
写入此文件。

```toml
[paths]
catalog_path = "/absolute/private/path/catalog.sqlite3"
artifact_root = "/absolute/private/path/artifacts"

[sources.metadata]
mode = "auto"
limit = 500

[sources.acquisition]
mode = "auto"

[parsing]
base_url = "http://127.0.0.1:8000"
connection_mode = "loopback"
model_identity = "mineru-3.4.4-vlm"
remote_upload_authorized = false

[providers.openai]
api = "openai-responses"
base_url = "https://api.openai.com/v1"

[models."openai/operator-selected-model"]
reasoning = "max"
image = false

[analyze]
model = "openai/operator-selected-model"
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

[browser]
enabled = false
```

这份文件在结构上合法，但外部能力是否可运行仍取决于统一凭据文件、
当前生产 capability 与 Network policy。`config status --json` 可做不联网的本地检查；
只有用户明确需要验证真实服务时才执行 `config test`。

上例中的 OpenAI Model Provider 还要求 `Models → Providers → Key` 写入
`[providers.openai]` exact-origin key；CORE 要求在 `Download → Sources → core → Key` 写入
`api_key`。
两类 key 都不能写进普通配置。启用 CORE 只注册
授权 API Source，不保证任意文献都有 CORE `work:`/`output:` 身份或具体下载 entitlement。
