# 配置中心与凭据技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 产品依据：[产品需求](../requirements.md)
- 架构决策：[ADR 0014](../decisions/0014-capability-scoped-providers-and-local-credentials.md)、[ADR 0021](../decisions/0021-provider-model-registry-and-direct-task-selection.md)
- 普通配置路径：[ADR 0018](../decisions/0018-fixed-user-configuration-home.md)
- 访问安全：[ADR 0012](../decisions/0012-process-local-provider-access-scheduling.md)、[Network 技术文档](network.md)
- PDF 访问画像：[ADR 0015](../decisions/0015-publisher-aware-tiered-pdf-acquisition.md)、[Acquisition 技术文档](acquisition.md)
- Browser runtime：[ADR 0016](../decisions/0016-cloakbrowser-fixed-identity-runtime.md)、[Network 技术文档](network.md)
- 模型运行时：[ADR 0017](../decisions/0017-shared-agents-and-controlled-browser-agent.md)、[Agents 技术文档](agents.md)
- 当前用户合同：[配置手册](../../guides/configuration.md)

本文定义 `configuration/`、`bootstrap/` 两个启动边界 package、
`model/configuration.py` 与 `entry/cli/` 的配置协作。统一配置中心、安全发布、状态和诊断的当前
用户行为仍以配置手册、源码和测试为准；本文还规定 ADR 0015 的持久 Browser Profile access
目标边界。普通 `[download]` 配置由裸 `sciretriever config` 的 Browser 一级页管理，Download
一级页只管理 PDF Source；
`config status/test` 已实现完整的 Browser 本地状态与显式单目标 probe 合同；共享 Planner、
Profile catalog、tiered cohort executor、Browser scheduler/session broker 的生产对象图及安装 wheel
identity 也已验收。当前 production Browser route 与 local eligible count 均为 9：ACS Publications、
AIP Publishing、Elsevier / ScienceDirect、IOPscience、Oxford Academic、RSC Publishing、Science /
AAAS、Springer Nature Link 与 Wiley Online Library。ADR 0016/0017 的目标对象图依据总开关、
选中且安全存在的固定身份 Profile、production rule、CloakBrowser wrapper/经验证 binary、
Playwright API 和 headed display 动态创建 `BrowserClient`，并构造一个共享无状态 Agents runtime、
由 Analyze/Browser 所选 Model 及其 Provider 解析出的两个 role binding、一或两个 Provider adapter，以及配置
选中的唯一 Browser controller；
`execution confirmation` 表示本次运行已明确启用，`runtime readiness` 只在 client 真正可构造时
为 true。Provider 的易变外部字段仍以
[Provider Notes](../../notes/providers/README.md) 为依据。

## 1. 责任与依赖

```text
src/sciretriever/
  configuration/               # 配置公开 surface 及按职责拆分的内部文件
    __init__.py                 # 稳定、窄小的公开导出
    documents.py               # 普通配置文档
    file_store.py              # 固定用户配置与凭据的安全文件读写
    filesystem.py              # owner/权限/文件身份基础检查
    credentials.py             # 凭据读取与运行时 secret
    credential_edits.py        # 凭据原子编辑
    agent_setup.py             # Model Provider/Model 注册表与任务选择策略
    browser_identity.py        # 固定 Browser identity manifest
    browser_profiles.py        # Profile 生命周期与独占 lease
    browser_access.py          # Browser policy 与 readiness
    cloak_runtime.py           # Cloak wrapper/binary/version 与 identity readiness
    status.py                  # 本地状态与显式 probe
  bootstrap/                   # 生产对象图公开 surface 及内部组装文件
    __init__.py                # 稳定、窄小的公开导出
    assembly.py                # 生产对象图 orchestration
    browser.py                 # Browser runtime 与 probe assembly
    graphs.py                  # 对象图合同
    services.py                # adapter/service 与共享 Agents runtime assembly
    storage.py                 # Storage lifecycle 与 rollback
    probes.py                  # 无 Storage probe session
    errors.py                  # 稳定 Bootstrap 组装错误
  model/configuration.py        # 不含 secret 的普通配置/readiness/probe Model
  entry/cli/main.py             # 通用 CLI 参数、文献命令路由与进程错误边界
  entry/cli/config_ui.py        # Rich/prompt-toolkit 配置呈现与动作语义
  entry/cli/config_center/      # 配置中心用例；不回流到 main.py
    commands.py                 # config/status/test 命令分发
    manager.py                  # 一级导航与首页本地状态
    common.py                   # 选择、输入、确认与安全 diff helper
    models.py                   # Model 与 Provider 对象页
    sources.py                  # Search、Download、Source 与 Sci-Hub Mirrors
    source_credentials.py       # 具体 Source 的 Key 生命周期
    parsing.py                  # MinerU Setup/Test/Reset
    analysis.py                 # Analyze Setup/Test/Reset
    browser.py                  # Browser Setup/Profile/Runtime/Test/Reset
    status.py                   # 本地 status payload 与呈现
    probes.py                   # owner-scoped 最小 probe
```

`configuration/__init__.py` 只重新导出稳定配置合同，其余同包文件按概念分别拥有普通文件与
文件身份检查、凭据文件安全读取、TOML document 编辑、凭据 schema/runtime secret 绑定、readiness/probe 状态、
Browser Profile 生命周期和 Browser access policy。`bootstrap/__init__.py` 只重新导出稳定对象图、
scope、错误与构造函数，其余同包文件分别拥有 Browser runtime、对象图合同、adapter/service
assembly、Storage lifecycle/rollback、无 Storage probe session 和生产 orchestration。目录拆分只是
原 Configuration/Bootstrap 模块的代码治理方式，不增加产品模块；调用方只依赖 package 公开 surface。

配置边界负责固定用户路径解析、严格 TOML 解析、Model Provider/Model 注册表与任务选择、
凭据/Profile owner/权限检查、服务 URL 规范化、origin 绑定、round-trip 编辑、安全 staging、
唯一当前 schema 的严格拒绝与正常原子发布；它不迁移、恢复或回退旧配置，不访问外部服务、
不形成文献业务决定。
Bootstrap 只把短生命周期 secret 注入当前需要的具体 adapter，并组装共享 Network/Access
Coordinator、一个共享 Agents runtime 与一个 Profile-backed Browser runtime；它不显示、序列化或保存 secret 或 Profile
内容。

Model 只保存普通参数、安全状态和中性 probe 结果。真实 API key、bearer token、Cookie、
凭据原文、binary stream、HTTP/vendor 响应和可辨识 secret 的 mask、长度、hash、前后缀或
fingerprint 都不能进入 Pydantic。CLI 只负责用户交互、确认和安全呈现，不拥有 Agents、Provider
或 MinerU wire protocol。

## 2. 两类配置文件

普通配置只有一个生产文件：

```text
~/.sciretriever/config.toml
```

它只保存十个非 secret 责任组：

```text
paths / sources / assets / parsing / providers / models / analyze / execution / library / download
```

Configuration 是该路径的唯一 owner。正常 CLI、Entry 与 Bootstrap 不读取环境变量、不检查
当前目录，也不提供第二个配置路径；裸配置中心在首次确认编辑时创建固定文件。显式
`load_configuration(path)` 只是一项底层 TOML 文档解析能力，不参与生产选择。普通配置严格
拒绝未知 section、字段、重复 key、错误枚举和不一致组合。

文献 Provider、Model Provider、可选 CloakBrowser Pro 与远程 MinerU secret 只有一个生产来源：

```text
~/.sciretriever/credentials.toml
```

共享的 `~/.sciretriever/` 必须为当前用户拥有的真实非符号链接目录且精确 `0700`；两个文件
都必须为当前用户拥有、单硬链接、非符号链接的普通文件且精确 `0600`。两类文件都使用有界
descriptor 读取并复核文件身份，替换、过大、非法 UTF-8/TOML 或权限不安全都 fail closed。
普通配置仍不是 secret，用户可以直接编辑；严格权限来自共享私有运行目录合同。测试通过显式
`home` 依赖注入使用系统临时目录，Harness 不读取真实用户文件或旧路径环境变量。

## 3. 普通配置合同

Provider 启用顺序、产品选择、contact identity、访问池、Storage 路径和客观单次资源限制属于普通
配置。模型配置分成两个直接注册表：

```text
providers.<name>.api / base_url
models."<provider>/<model>".reasoning / image
```

Model Provider 是可复用 transport 与 exact-origin credential scope，只拥有本地 name、API 协议和
Base URL。Model 以完整 `provider/model` 为唯一身份，只拥有 reasoning 与 image；必须引用已经存在
的 Provider。被 Analyze/Browser 引用的 Model 不能删除，仍有 Model 引用的 Provider 不能删除。
配置不建立 Model Profile、Preset、Entry、alias 或 task-level reasoning override。

支持的 wire API 是 OpenAI Responses、OpenAI Chat Completions 与 Anthropic Messages。远程
Provider 必须使用 hostname-based HTTPS 并要求 API key；HTTP 只允许 loopback 且不读取 key。URL
统一拒绝 userinfo、query、fragment、remote IP literal、dot segments、编码分隔符和非规范端口
文本。官方 Provider 选择只为配置向导提供 URL/API 初值，不形成另一套持久 preset。固定的单次
prompt/input/schema/request/response/result 字节上限与 HTTP timeout 由 Agents 实现和 Bootstrap
组装，不是普通 TOML 字段。

任务直接引用 Model：

```toml
[analyze]
model = "openai/gpt-5.4"

[download]
model = "openai/gpt-5.4"
```

`[analyze]` 另外只保留文献两阶段 output、输入与 chunk 等业务预算；`[download]` 另外只保留
Acquisition/Browser 业务设置。两者不保存 Provider、key、远端 model 或 reasoning override。
Analyze 可以引用任意已配置 Model，其 strict structured output/text-only/no-tool 合同由模块派生；
`[download]` 中的 Browser 选择只允许引用 `image = true` 的 Model，其 PNG/image/tool 合同由模块
派生。Rules controller 不要求 Browser Model，也不构造 Browser Agent consumer。

远端 model identity 在 Configuration 边界规范化为 NFC，并拒绝空白、C0/C1 控制字符、无效
UTF-8 和超过 512 bytes 的值；Provider name 最长 128 bytes，完整 reference 最长 641 bytes。同样
约束在 Agents binding 与 request 边界再次执行。reasoning 接受
`default/none/minimal/low/medium/high/xhigh/max`；`default` 让 adapter 省略 wire effort，其它值
按协议精确编码，不从 Provider/model 名称猜测或静默降级。context/output、structured output、
tool decision、图片 MIME/数量/大小、session turns、Browser deadline 和累计作业预算都不进入
Model 配置，由当前消费模块和 Bootstrap 的安全合同拥有。

旧 `[agents]`、`[agents.analysis]`、`[agents.browser]`、`[models.services.*]`、
`[models.profiles.*]`、`[models.entries.*]`、`[analysis]` 与 `[access]` 不进入普通生产
解析，也没有字段映射迁移器、双生产路径或恢复入口。裸 `config` 在首页前严格读取当前普通
配置与凭据；malformed、未知 section/key、无效值以及文件过大、链接、所有权/权限、目录或读取
竞争错误都返回退出码 4 和无配置值诊断，不显示菜单、不写文件。文件缺失按尚未写入的空当前
配置处理；第一次确认修改仍走正常原子发布。

`[parsing]` 只保存 connection mode、Base URL、model identity 与 remote upload consent。
MinerU 3.4.4、protocol 2、profile `vlm-engine`、archive backend `vlm`、parse method `auto`
是只读实现事实，不是 backend 选择。loopback 只接受 HTTP loopback 且不需要 token；remote
只接受 hostname-based HTTPS，必须明确确认 PDF 离开本机并配置 bearer token。

### 3.1 Source 选择与逐 Source limit

`Configuration.sources.metadata` 与 `Configuration.sources.acquisition` 都使用严格的
`SourceMode.AUTO/CUSTOM`。配置文件形状是：

```toml
[sources.metadata]
mode = "auto"
limit = 500

[sources.acquisition]
mode = "auto"
```

Auto 时 `providers` 必须为空，运行时由 `configuration/source_selection.py` 的本地常量解析有效
有序集合；Custom 时 `providers` 是用户精确列表并允许为空。resolver 不读取 credentials、环境、
Network 或 readiness，也不把结果写回配置。Metadata Auto 固定为 Crossref、Semantic Scholar、
arXiv、OpenAlex、Europe PMC、DataCite、CORE、OpenCitations；Acquisition Auto 的命名 Source
固定为 arXiv、Europe PMC。默认 catalog 是当前 release 事实，可以随版本维护；Custom 列表不受
catalog 变化影响。

`sources.metadata.limit` 是严格正整数，默认 500。Metadata registry 把同一值分别复制成每个
参与 topic/reference Source 的 `ProviderDiscoveryLimit`；OpenCitations 没有 topic-search port，
因此当前 Auto 主题搜索的理论原始 item ceiling 是 `7 × limit`。计数发生在过滤、准入、去重和
接纳前，不是 HTTP 请求数。旧 `DiscoveryConfig`、顶层 `[discovery]` 和
`metadata_scan_limit` 已删除，解析边界将其作为未知 schema 拒绝，不提供兼容层。

Auto/Custom 只决定命名 Source enablement。可选 Key 可以改善已经有效的 Metadata Source，不能
反向启用 capability；Acquisition 始终消费安全的 direct/landing AssetHint。Sci-Hub、Browser 和
需要 operator 参数或授权凭据的 Acquisition API 不进入 Auto。

### 3.2 Sci-Hub 有序镜像配置边界

Sci-Hub Source 默认关闭。operator 显式启用且没有 custom table 时，Acquisition 使用当前版本的
bundled mirror set；bundled 列表是 release 实现事实，不写入用户 TOML，升级可以更新它。
`sources.acquisition.sci-hub.urls` 是可选的一到八项有序 custom override；一旦存在就完整覆盖
bundled 列表，升级不得改写该用户列表。每项在 Model 边界规范化为 hostname-based HTTPS 默认
端口 Base URL；userinfo、query、fragment、IP literal、loopback、dot segment、编码路径分隔符、
重复规范 URL 与未知字段全部 fail closed。有效列表的顺序是唯一尝试顺序，不形成健康度、权重、
并发组或第二套运行状态。URL 不属于 credentials，Sci-Hub 也没有
Key/Cookie/session/代理/selector/script 配置。

Acquisition registry 在无 I/O 组装中按“显式注入 resolver → custom `urls` → bundled mirror set”
选择 `ConfiguredSciHubLandingResolver`。该 resolver 只把已接纳 canonical DOI 逐 segment 编码后
附到每个 Base URL，不访问 Network；缺 DOI 时 route 不适用。显式注入只用于程序集成和离线测试，
不是兼容 schema 或普通用户的必需依赖。未启用 Source 时即使 bundled/custom 已就绪也不安装 route。

交互所有权固定在 `Download → Sources → sci-hub`。未启用时入口动作是
`Enable / Mirrors / Back`，Enable 直接使用当前有效列表；已启用时是
`Mirrors / Disable / Back`。镜像编辑器为 `Add / Remove / Save / Reset / Back`：从当前有效列表
开始，Save 形成 custom override，
Reset 删除 custom table 并重新跟随 bundled，Back 不发布 draft，空列表不能 Save。Disable 保留
custom override。URL 列表由 Pydantic 做最终规范化、唯一性与上限验证，CLI 不建立平行 validator；
Status 以 `mode = builtin|custom` 与有效 `urls` 明确两种状态。

### 3.3 Browser access 配置边界

ADR 0015 的目标普通配置只表达 Browser 总启用选择、作业级 controller、本机 Browser 资源上限，
以及对已核实 Provider policy 的收紧值。普通配置不能：

- 改写 `browser_rate_limit_group`、`browser_session_key`、允许 origin 或 Profile rule revision；
- 把同一风险组按 DOI、Literature、入口 URL 或随机任务拆开；
- 提高官方并发/额度、缩短 interval/cooldown、忽略 window/reset/`Retry-After` 或自动提速；
- 为未知站点启用 generic Browser fallback、在 Rules/Agent 间自动切换、任意规则脚本、自动登录或 Challenge 边界绕过；
- 配置 Browser Profile 路径、Cookie、账号、机构名、SSO/CARSI 内容、代理、fingerprint seed/persona
  或其它认证材料；普通配置只允许选择一个 opaque Profile identity。

Browser 使用当前机器的正常网络出口和一个 operator-managed 持久 Profile；在无 GUI Linux 上
由 Xvfb 提供虚拟显示。生产 Configuration 只接受规范化的 Profile identity，不接受路径，也不
读取、导入、导出或显示 Cookie、local storage、账号或机构身份。Configuration 把 identity 解析
到固定 owner-only 目录，验证目录树和 identity manifest，并通过跨进程独占 lease 保证同一 Profile
同时只有一个 CloakBrowser Chromium process。manifest 在 Profile 初始化时一次生成固定 seed、
native Linux persona、locale/timezone、screen、identity schema 与 Browser version policy；status
只报告 manifest schema/version readiness，不显示或派生 seed。纯 Browser 访问方不因为拥有 `PublisherAccessProfile` 就需要 Provider credential
section；API token、Profile presence、Browser runtime readiness、登录状态与逐文章 entitlement
始终是不同事实。Chromium 认证状态可以留在 Profile 中；页面登录/MFA/challenge 结果、runtime
health、cooldown 和 circuit 不持久化回普通配置、凭据文件或文献数据库。

当前普通配置字段为：

```toml
[download]
model = "openai/operator-selected-browser-model"
browser_enabled = false
browser_profile = "institutional-access"
browser_controller = "rules"
browser_max_concurrency = 5
browser_policy_overrides = []
```

`browser_enabled = true` 必须同时具有 `browser_profile`，并只显式授权已进入 production catalog
的 Browser routes 启动有头 Browser；它不表示 Profile 已登录、当前 IP 或文章已获授权。Profile identity
必须是不含敏感信息的稳定短名称，不能是路径、URL、UUID、账号、机构名、Token 或 Cookie 标签。
`browser_max_concurrency` 是必须大于 1 的全局本机 Publisher-lane 资源 cap，不改变任何 risk
group 固定的组内并发 1。默认值 5；operator 可以按本机资源和活动 Publisher 数量设置任意更大
的整数，配置合同不设置上限。所有 lane 共享一个 CloakBrowser Chromium process/persistent context，不会因为
cap 较大而启动多个 Browser。当前 production route 数量 `9` 只是 catalog 实现事实，不是该字段
的最大值。

`browser_controller` 只接受 `"rules"` 或 `"agent"`，默认 `"rules"`。Entry 在一项下载作业开始前
冻结该选择，Bootstrap 只构造对应 controller；运行中不能因 miss、timeout、Challenge 或失败切换。
Rules 模式不要求 Browser Model readiness，也不构造 Agent controller；Agent 模式要求选择一个
`image = true` 的 Model，tool decision、PNG 与正数 image limits 由模块合同派生，但不先执行确定性点击规则。

普通配置不接受逐 Publisher 的本机许可声明。`browser_enabled = true` 是对整个受控 Browser
第三层的一次显式启用；9 条 production route 随后仍分别服从固定 origin、rule、正文归属、
risk/session group、policy、Network 安全边界和逐文章 entitlement 检查。该开关不能证明组织
合同、当前 IP 或具体文章权限；旧的逐 Publisher grant 配置不再属于公开 schema。

`browser_policy_overrides` 是按 `rate_limit_group` 唯一标识的 inline-table 数组。每项只允许
以下收紧字段：

```text
max_concurrency = 1
minimum_start_interval
maximum_starts_per_window + window_seconds
cooldown_after_completion
rate_limit_cooldown
failure_cooldown
runtime_failure_threshold
```

窗口计数和时长必须成对出现；时间必须是有限非负数，需要正值的窗口和 rate-limit cooldown
不能为 0；阈值和计数必须为正整数。相对 Profile baseline，并发/窗口计数/运行失败阈值只能
减小，interval/window duration/cooldown 只能增大。未知 group、重复 group、空 override、负数、
`inf`/`nan` 或任何放宽都会在 Configuration 边界拒绝。配置不接受 policy revision、session key、
origin、selector 或 Browser rule 字段，因此 operator 不能借 override 重定义供应商画像。

当前 production matrix 的 Browser policy group 为 `acs-publications`、`aip-publishing`、
`elsevier`、`iopscience`、`oxford-academic`、`rsc-publishing`、`science-aaas`、`springerlink`
和 `wiley`；operator 可以分别进一步收紧，但不能改名、拆组或放宽。任何其它自行猜测的 group
都会以 `browser policy group is unknown` fail closed。`browser_enabled` 本身也不会把
fixture-verified/unsupported Profile 变成生产能力。普通 `[download]` 字段已经接入严格 TOML、
round-trip 编辑和交互管理；status 分开计算 9 条 production route、9 条 automatic eligible
route、总开关、CloakBrowser wrapper/经验证 binary、Playwright API 与 headed display，
文章 entitlement 始终在实际获取时检查。

### 3.4 CloakBrowser binary 与 Profile identity 生命周期

CloakBrowser Python wrapper 是 wheel 依赖；patched Chromium binary 具有独立许可、版本与平台
生命周期，不能进入 wheel、仓库、`config.toml` 或 Profile。Configuration 把它解析到固定
owner-only runtime/cache root，并维护不含 secret 的安装 manifest：wrapper version、binary version、
platform/architecture、vendor digest/signature、verified-at、compatible Playwright range 与上一个已
验证版本。普通 Completion 只读取 manifest/readiness，缺失或不匹配时 fail closed，绝不隐式联网
下载或自动升级。生产 runtime lease 不把该长期 root 直接交给 vendor wrapper；它在系统临时目录
创建 owner-only 的单次无凭据 cache view，只暴露当前已验证版本目录，关闭 lease 后删除。因此
长期 root 中即使意外出现 `license.key`、license cache、Pro marker 或其它 vendor 状态，也不能被
普通 Completion 解析、注入 Browser 子进程或用于改变固定 binary。

安装、更新和回退只能由配置中心中的显式动作触发。动作必须先显示网络、许可、磁盘和版本影响，
下载到 owner-only staging，保留本次实际 archive，先用锁定 wrapper 的 Ed25519 公钥验证 detached
signature 和 manifest version binding，再同时要求 manifest digest、仓库固定 digest 与实际 archive
SHA-256 三者一致；之后才解压、校验完整 bundle 并原子发布。任一证据缺失、同版本 archive 被替换
或 digest 漂移都会在解压前 fail closed，失败保留当前已验证版本。当前固定 older-free v146 路径
不使用 Pro license，并在任何 vendor/network 调用前拒绝安装动作传入的 license key；
`credentials.toml` 中保留的 `[cloakbrowser]` section 只为未来另行审查的版本线预留，不影响当前
runtime。环境变量、cache-file credential、命令行和普通配置均不是当前 license 来源。删除 binary
与删除 Profile 是两个独立确认动作，均不能由普通 Completion 或 reset 隐式执行。

Profile identity manifest 与 Browser user-data directory 同属一个 owner-only Profile identity，
但不读取或复制 Cookie/站点内容。新 Profile 一次生成 seed 后原子发布 manifest；同一 Profile 后续
启动必须复用。现有 stock Chrome Profile 只有在程序创建的兼容 fixture 证明可安全接纳，且用户
显式确认后，才允许以原子 manifest 初始化升级；否则 status 返回 `needs-new-runtime-profile`，
要求创建新的 Cloak Profile，并保持旧目录完全不动。版本回退不得用较旧 Chromium 就地打开可能已
升级的真实 Profile；需要时创建隔离 Profile，不通过保留双生产 runtime 解决。

## 4. 统一 credentials schema 与 origin 绑定

文献 Provider section 按当前 adapter allowlist 保存字段；每个需要 key 的 Model Provider 使用命名
`[providers.<provider>]`，其余固定核心 section 为：

```toml
[providers.openai]
api_key = "<secret>"
origin = "https://api.openai.com"

[cloakbrowser]
license_key = "<optional-secret>"
origin = "https://cloakbrowser.dev"

[mineru]
bearer_token = "<secret>"
origin = "https://mineru.example.invalid"
```

Model credential section name 必须是合法本地 Provider identity，并精确引用普通配置中的 Provider；
每个 Provider 最多一套 `api_key + origin`，多个 Model 复用。未知 section、未知字段、空 section、
空值、控制字符、非法 origin 和不完整过渡字段组合全部拒绝。Provider section 的具体字段与必需性
见配置手册及 Provider Notes。

`[cloakbrowser]` 当前是保留但不消费的核心 section：status 会把它显示为
`reserved-not-used-by-pinned-free-binary`；v146 显式安装和普通 Browser launch 都不会读取或传递
这个值。未来若启用需要 license 的不同 binary，必须重新完成许可、版本、签名、Profile 和离线/
现场门禁，不能借该预留 section 绕过当前固定 runtime。

核心 secret 与保存时的规范 origin 精确绑定。Bootstrap 通过
`model_secret_for_origin(provider, origin)` 取得当前 Model 引用的命名 Provider key，通过
`core_secret_for_origin(service, origin)` 取得 MinerU 等固定核心 secret；改变 Base URL 后旧 secret
不会被发送到新服务。Network 在每次 redirect 重新执行 origin/credential alias 检查，跨 origin
不携带认证。loopback 服务和当前 scope 不需要的核心服务不会触发凭据读取。

旧普通配置路径以及 LLM/MinerU、Agents 与 CloakBrowser secret 环境变量均不属于产品合同：
不读取、不回退、不迁移。旧 credentials `[agents]` 与 `[models.*]` 是未知 section，不能由普通启动变成命名
`[providers.<provider>]` key，并会在配置首页前直接拒绝。operator 必须在配置中心之外手工删除旧
section 或替换精确文件，再按当前 Models 入口重新配置；`NO_COLOR` 等显示控制只影响终端呈现，
不能改变普通配置身份。

## 5. 安全发布

普通 `[sources]`/`[models]`/`[analyze]`/`[parsing]`/`[download]` 编辑使用 `tomlkit` round-trip：只更新目标 section，保留其它
section、注释和排版。发布流程为同目录 staging、`0600`、完整写入、flush/fsync、重读、
TOML/Pydantic 复验、原子 replace；任一步失败保留原文件并清理 staging。确认前只显示
普通字段 diff，不显示或推导 secret。

单一凭据 section 修改沿用相同 owner-only staging 和原子发布。Model Provider 或核心服务同时改变位于
不同目录的普通配置和凭据；文件系统没有跨文件 rename 事务，因此实现使用可恢复顺序：

```text
1. 在各自目录落盘全部 staging，chmod 0600，fsync，并完整复验
2. 发布同时服务旧/new origin 的过渡凭据
3. 发布引用 new origin 的普通配置
4. 清理过渡凭据，只保留最终 origin
```

内部 `next_api_key` / `next_bearer_token` / `next_origin` 必须形成完整过渡组、与主 origin
不同，且不通过 status、field names 或 repr 暴露。第一次发布前中断时两份旧文件均不变；
步骤 2 后中断时旧普通配置仍可取旧 secret；步骤 3 后中断时新普通配置可取 new secret；
正常结束后清理过渡字段。reset 也通过同一函数同时清空普通 section 与凭据。

## 6. 交互配置中心

命令树固定为：

```text
sciretriever config [--theme auto|dark|light|mono]
sciretriever config status [--json] [--theme auto|dark|light|mono]
sciretriever config test <provider|llm|browser-agent|mineru> [--json]
sciretriever config test --browser <publisher-access-key> [--json]
sciretriever config test --all [--json]
```

裸 `config` 首页只使用单词级责任名称：

```text
Models / Search / Download / Parse / Analyze / Browser / Status / Theme / Quit
```

首页只组装本地状态，不触发 Network。TTY 使用 Rich 与 prompt-toolkit 的非全屏界面，支持方向键、
Enter、Esc/左方向键返回、首页快捷键和隐藏输入；长 Model/Provider 列表支持 `/` 搜索。非 TTY
降级为具有相同选项与责任的确定性文本菜单。主题支持 auto/dark/light/mono，`NO_COLOR` 强制
mono；状态不能只靠颜色表达。所有交互、确认和 setup 结果写 stderr，stdout 为空；Ctrl+C/EOF
取消不产生写入。旧 `config set/remove` 保持无效。

`Models` 与 Provider 使用对象页：

```text
Models:    Add / <Model> / Providers / Back
Model:     Edit / Remove / Back
Providers: Add / <Provider> / Back
Provider:  Edit / Key / Test / Remove / Back
```

`Providers` 管理 name、API、Base URL 与 exact-origin key；官方 OpenAI/Anthropic/DeepSeek 只提供
已知 URL/API 初值，自定义 Provider 仍按严格 loopback/remote URL 规则验证。`Key` 为选中的
Provider 添加、替换或移除 key，并只显示 Saved/Missing/Not required。仍有 Model 引用时不能删除
Provider。

`Models → Add` 使用 `Provider → URL → API → Key → Model → Reasoning → Image → Save` 的连续
流程：选择已有 Provider 或 New；新远程 Provider 在同一流程隐藏输入 key，已有 exact-origin key
直接复用，loopback 不询问 key。key 就绪后自动调用 Bootstrap 的 `fetch_agent_models`；经共享
Network 对规范 `/models` 执行一次无 redirect、无 retry、最多 1 MiB/100 项的 GET，返回非持久
typed observation 后立即关闭 client。目录只用于选择 Model ID；所有失败稳定、脱敏，只有失败、
空目录或协议无可用结果时才提示 `Manual`。取消不保存部分 Provider、Model 或 key；首页、Status、
打开 Models 和普通业务命令的目录调用计数为零。

具体 Model 对象页的 `Edit` 只修改 reasoning 与 image。reasoning schema 接受
`default/none/minimal/low/medium/high/xhigh/max`；`default` 完全省略 wire 字段，其它值由 adapter
按协议精确编码，不降级或映射。Provider 目录中的 context/output/image/effort 提示不写入 Model，
也不成为 capability 证明。`Remove` 只删除未被 Analyze/Browser 引用的 Model。

其余 owner 页固定为：

```text
Search:   Sources / Limit / Back
Download: Sources / Back
Parse:    Setup / Test / Reset / Back
Analyze:  Setup / Test / Reset / Back
Browser:  Setup / Profiles / Runtime / Test / Reset / Back
```

`Search` 只管理 Metadata Sources 与逐 Source raw-item limit，`Download` 只管理 Acquisition
Sources。两者的 Sources 都只有 Auto/Custom 两层；Auto 页可以切换 Custom，Custom 页可以切回 Auto
或逐项修改精确列表。Auto → Custom 冻结当时的有效集合和顺序，Custom → Auto 清空固定列表。
选中具体 Source 后，对象页按该 Source 的能力就近提供 `Setup`、`Key`、`Test`、`Enable` 或
`Disable`；Key 与普通参数不会自行启用 Source。Search Auto 仍可配置 Crossref anonymous/polite。
Sci-Hub 的 `Mirrors` 只在 Sci-Hub 对象页出现，修改镜像不会启用 Sci-Hub。

`Parse → Setup` 连续配置 MinerU Service、远程 PDF upload 授权和所需 exact-origin bearer token；
loopback 不询问 token，remote 必须在同一流程明确确认 Upload。`Analyze → Setup` 连续选择 Model 与
八项文献分析业务 limit。`Browser → Setup` 连续配置 Off/Rules/Agent controller、Agent 所需图片
Model、固定 Browser identity Profile 与本机并发 cap；`Profiles` 和 `Runtime` 分别管理本地身份与
CloakBrowser 生命周期，`Test` 再区分合成 Model probe 和实际 Browser 最小站点 probe。

Analyze/Browser 的 `Setup` 只把完整 Model reference 写入各自任务配置；reasoning 与 image 保留在
Model 中，Provider 连接保留在 Provider 中。Analyze 选择不改变 Browser，Browser 选择不改变
Analyze。首次选择 Analyze Model 时生成产品内部安全业务预算；不会从模型目录 metadata 推导。
Browser 只列出 `image = true` 的 Model；strict output、tool、PNG 与图片大小合同由模块派生。底层
普通 schema 与 `config status --json` 为保持 Acquisition 合同仍使用 `[download]`/`download` 名称。

Download 的 Plain/TTY 两种界面只管理 PDF Source；三个已实现的 authorized primary-PDF API
（CORE、Elsevier、Wiley）的普通参数、Key 与 probe 都在各自 Source 对象页。Browser 一级页把这些
Source 与 Browser runtime readiness 分开，并支持：

- 在 Sci-Hub Source 的 `Mirrors` 中管理有序镜像，且不出现 Key 或隐藏凭据输入；
- 选择 `rules` 或 `agent` controller，并在确认前说明两者互斥、不会 fallback；
- 选择一个 `image = true` 的 Model；
- 选择/初始化一个 opaque Browser identity Profile 与固定 identity manifest；
- 显式永久删除选中的本地 Browser Profile、manifest 和由 Chromium 管理的状态；
- 禁用自动 Browser access，同时保留 Profile、本机并发上限、Provider policy override 与凭据；
- 设置跨 Publisher 的本机 Browser 并发 cap；
- 显式安装、更新或回退 CloakBrowser binary。用户不能输入 binary/Profile 路径、seed、persona 或
  Cookie。

配置菜单把动作含义同时编码为颜色和单色仍可见的标记：配置 `◆`、查看 `◇`、测试 `▶`、危险
`!`、返回 `←`、退出 `×`。说明必须明确：自动 CloakBrowser patched Chromium 固定以
`headless = false` 使用当前机器正常
网络出口和一个持久固定身份 Profile；无 GUI Linux 由 Xvfb 提供完整窗口栈，但不提供用户可见
交互窗口。产品没有 Browser 登录、机构选择、MFA 或 Cookie 导入导出入口；SciRetriever 不自动
导航登录页、不填写凭据、不选择机构、不读取 Cookie/登录结果，也不处理 MFA。Challenge 不需要
单独配置入口：选择 Agent controller 且 Browser Model readiness 通过后，Agent 可以在同一
Profile/IP、Publisher permit 和统一 Observation/Action 合同内操作当前文章页面的可见控件；Rules
controller 只执行已审查的确定性规则。两种 controller 不会在运行中切换；初始化、配置写入、
binary 网络动作和删除都先确认，取消不修改配置、不创建/删除 Profile，也不启动 Browser。

Browser 如实显示当前 production Browser route count 与本地 automatic eligible count 均为 9，并
分开呈现 route 已安装、Browser 总开关、本地 runtime 就绪和文章 entitlement 运行时检查。完整
route/policy/action-required 状态由 Status 提供；模型合成 probe 与实际 Browser 最小站点 probe 只
在 `Browser → Test → Model/Browser` 由用户显式执行。

## 7. status 与 probe

`config status` 是纯本地操作：读取两类配置，组装 capability/readiness 和 secret-opaque
presence view，不构造 Storage、Catalog、ArtifactStore 或 Network。人类输出用紧凑表格
展示：

- Model Providers 的 name/API/endpoint 与 credential presence/origin match，以及全部 Models 的
  完整 reference、reasoning 与 image；Analyze/Browser 各自选择的 Model 和静态 readiness，当前
  `browser_controller` 及其所需 Browser Model readiness；
- MinerU mode/endpoint/固定实现身份、credential presence/origin match 与 readiness；
- Metadata API 与 authorized primary-PDF API 的独立 enabled、字段
  configured/missing/optional、policy readiness 和下一动作；
- PDF acquisition 固定顺序：Public → Authorized API → Controlled browser；
- Controlled Browser 的持久 Profile 有头模式、选中的 opaque identity 与 presence、
  CloakBrowser wrapper/binary/version、Playwright API、fixed identity manifest、headed display/Xvfb、9 条
  production route、9/9 local eligible、普通总开关、共享 process/context lifecycle、Publisher lane、
  未评估认证状态、逐文章 entitlement、显式 probe、policy evidence 与所需下一动作；
- Storage 和执行参数概要。

人类输出只逐项展开已启用或已有凭据的 Metadata API，其余禁用项用数量摘要收起；授权主
PDF API 只逐项展开当前有效 Acquisition Source 中的 CORE、Elsevier、Wiley 或已知不支持直接
PDF 的 Springer，避免把未启用能力和 Metadata 凭据混入当前路线。完整 capability matrix 仍保留
在 JSON。当前 production Browser route count 为 9，Browser 分区逐项显示
ACS Publications、AIP Publishing、Elsevier / ScienceDirect、IOPscience、Oxford Academic、
RSC Publishing、Science / AAAS、Springer Nature Link 和 Wiley Online Library 的
route/risk group/policy，再根据总开关、CloakBrowser wrapper/binary、Playwright API、Profile manifest 与 headed display 给出
automatic acquisition/probe 的本地就绪状态和稳定 action code。catalog 真为空时的
`browser-production-route-unavailable` 分支仍保留，但不是当前默认状态。

本地 readiness 不能描述为 IP entitlement 或文章授权成功。JSON 使用稳定分组 schema、无
ANSI，也不能包含 secret 特征或 configuration fingerprint。

Browser 的纯本地状态只能说明生产规则、总开关、Profile selection/presence/identity manifest、
CloakBrowser wrapper/binary/version、Playwright API 和 headed display 是否齐备；不能声称 Profile 已登录、当前机器 IP
或具体文献 entitled。动态页面状态、runtime health、circuit/cooldown 不保存为“上次状态”。
`config status` 不启动 Browser、不访问 Provider，也不读取 Profile 内容或枚举 Cookie、origin
history、登录站点或 selector。
wrapper/API 可发现只表示 Python 依赖存在；status 还会检查 binary 安装 manifest、版本/校验兼容性
和 headed display（Linux 上为 Xvfb）是否存在，但 `launch_assessed` 固定为 `false`，不启动
Browser 或证明启动成功。
JSON 顶层稳定分为：

```text
models / analyze / download / parsing / providers / storage / execution / library
```

`models.providers[]` 只包含 Provider 普通事实与 credential presence/origin match，
`models.models[]` 包含完整非 secret Model；`analyze.model` 与 `download.model` 保存完整 Model
reference，并分别通过 `selected_model` 附带所选 Model/readiness。Controlled Browser 同时作为 Download readiness 和
Provider acquisition route 事实呈现，并稳定区分：

```text
enabled / mode=headed-fixed-profile / controller=rules|agent / interactive_authentication_supported=false
article_entitlement=checked-per-article / local_max_concurrency
runtime.cloak_wrapper_available / playwright_api_available / binary_presence / binary_version
runtime.binary_verified / fixed_identity_manifest / identity_schema
runtime.headed_display_available / launch_assessed
profile.selected / profile.presence
session.assessment=not-assessed / authenticated=null / article_entitlement=not-proven
automatic_acquisition_available / production_route_count / automatic_route_count / routes
routes[].access_key / route_key / rate_limit_group / automatic_acquisition_eligible
probe.available / requires_explicit_target / supported_access_keys
action_required[{code, reason, action}]
```

JSON 不含 ANSI、Profile 路径/内容、configuration fingerprint、Cookie 特征、登录详情、selector、
原始异常或 secret 特征。`automatic_acquisition_available = true` 只表示本地执行条件齐备；
`profile.presence = configured` 只表示安全目录存在；`article_entitlement = checked-per-article`
明确表示权限仍须由实际文章响应判断。

`config test` 构造独立的 `ProductionConfigurationProbeSession`，复用生产 adapter 和共享
Network，但不构造 Storage。Provider probe 使用官方最小只读请求；模型 probe 使用 Analyze 或
Browser 当前选择的 Model。Analyze 固定发送：

```json
{"probe":"sciretriever-configuration"}
```

并要求严格响应 `{"ok":true}`。Browser Model 发送一张程序生成的极小无文字图片和一项固定工具
声明，要求返回该工具决定；二者都不发送用户 Literature、页面或 screenshot，但可能消耗少量额度。
MinerU probe 只调用 `GET health`，验证 healthy、release 3.4.4、protocol 2 和 profile；不
submit、poll、fetch archive 或上传 PDF。`--all` 始终汇总已启用 Provider、Analysis LLM 和 MinerU；
当前选择 `agent` Browser controller 时还执行一次 Browser Model 的合成图片/tool probe，选择
`rules` 时不调用未使用的 Browser Model。一个
失败不阻断其它结果，failed/skipped 使退出码为 3。人类模式在 LLM/`--all` 前确认副作用；
JSON 模式视为脚本显式授权。

普通 Provider API probe 不隐式启动 Browser。Browser runtime/target probe 必须由用户
显式选择具体 Publisher access key：

```text
sciretriever config test --browser <publisher-access-key> [--json]
```

该选择与位置 Provider、`--all` 互斥，一次只允许一个 production-approved 最小目标；人类
模式再次确认将启动受控有头 CloakBrowser；无 GUI Linux 使用 Xvfb，JSON 调用本身视为显式授权。
probe 使用与自动获取相同的 risk-group scheduler、production rule/controller、目标 origin 和
规则审查过的 challenge dependency，并用 deny-all capture guard 在读取前拒绝 PDF/body。passed
只要求 runtime、固定身份和最小目标流程完成；结果固定 `article_entitlement = not-proven` 与
`persisted = false`。`--all` 永远不隐式启动 Publisher Browser probe；Download 的合成模型
probe 不启动 Browser，也不访问 Publisher。
当前 production target 集合为九家，Browser 启用且 runtime 就绪时均可作为单目标 probe：

```text
acs-publications
aip-publishing
elsevier-sciencedirect
iopscience
oxford-academic
rsc-publishing
science-aaas
springerlink
wiley-online-library
```

Probe 只打开所选规则的首页；不打开具体文章、不下载 PDF、不评估机构 IP entitlement，也不
持久化结果。开关或 runtime 未就绪时以
精确 action code 稳定 `skipped`；未支持 access key 不启动 runtime、不导航、不猜 URL。
页面可打开、机构 IP entitlement 和具体文章 entitlement 始终是不同结果。生产文章 route 直接
使用当前机器网络出口；只有具体文章响应才能分类 IP 放行、login/MFA/action-required、paywall
或其它授权结果。

probe 使用受限 Browser 模式：顶层主文档、经 production Profile 精确允许的 redirect，
以及由目标页面/frame ancestry 实际发起的受限 challenge dependency 仍经过 destination/DNS/IP/
host/TLS 边界；显式 request 逐项审查，未再次暴露 route 的
native redirect 只允许复用同页 live、已批准且预绑定的关联。非必要 stylesheet、script、image、
font 等子资源在 route 边界安全终止。页面 marker 通过即时、有界 DOM snapshot 判断；selector
不存在立即返回，不读取 Cookie、storage 或 profile 文件，不把页面正文、认证 query、header 或
原始异常写入结果。合法跳转到同一 rule 允许的最终 origin 视为可达，不因离开起始 origin 产生
Springer 假阴性。Probe 可以报告 challenge dependency admitted/blocked、统一 `page_state`、所选
controller 与单次动作 readiness，但不能声明 Challenge 或 entitlement 普遍成功。该优化只限制
probe 的访问面，不改变普通文章 Browser flow。

真实 Provider probe 不进入 Harness，精确
现场范围需要用户另行授权。

核心 probe 返回 `CoreConfigurationProbeResult`，details 分别为
`LLMConfigurationProbeDetails` 和 `MinerUConfigurationProbeDetails`，共同固定
`persisted = false`。任何 probe 都不创建 DiscoveryRun、Literature、MetadataObservation、
Asset、Catalog、Report 或测试历史，也不把认证通过解释成具体文献全文 entitlement。

## 8. 离线验证要求

直接测试覆盖 Source Auto/Custom、版本默认 catalog、Custom 空/精确顺序、Auto 禁止固定
providers、默认及自定义逐 Source limit、旧 discovery schema 拒绝、严格 Provider/Model registry、Analyze/Browser 直接引用与 image 门槛、八级 Model
reasoning、旧 singleton/Service/Profile/Entry 普通配置与 credentials `[agents]`/`[models.*]` 在菜单前严格拒绝且零写入、多 Provider adapter 选择、Agents role capability/单次
limits、URL/limit 组合、origin 错配、权限/符号链接、round-trip、staging 失败、跨文件每个中断点、
三种 LLM protocol、认证 redirect、MinerU health-only、Browser
Profile 安全树/固定 identity manifest/独占 lease/显式删除、Cloak binary install/update/rollback、
共享 runtime 与文章临时目录清理、只允许收紧的 policy、
API/Browser readiness 分离、单词级首页与 owner 子页、四主题、窄终端、快捷键、取消和
secret/Cookie 不泄漏。安装 wheel 旅程使用临时 HOME、测试自有
`credentials.toml` 与 fake transport 验证真实 console、生产 Bootstrap、status、Agents/MinerU
probe 和 `--all`；Browser 使用本地 HTTPS 页面 fixture，并覆盖跨 origin `3xx`、navigation-only
probe、普通文章批准子资源、第三方 tracker 丢弃、点击/脚本 redirect、HTTP attachment、共享
context 文章分流与临时资源清理，以及 Cloudflare-shaped 跨 origin fixture 的自动 clear、统一
Observation/Action、语义无进展、资源阻断和 origin escape。不得使用旧 secret 环境变量、真实凭据/Cookie/Profile、真实
网络、生产 Catalog 或用户语料。Full Harness 还必须通过 Pyright
strict、全量 unittest、wheel 构建和内容核对。
