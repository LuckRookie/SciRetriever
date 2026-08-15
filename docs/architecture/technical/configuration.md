# 配置中心与凭据技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 产品依据：[产品需求](../requirements.md)
- 架构决策：[ADR 0014](../decisions/0014-capability-scoped-providers-and-local-credentials.md)
- 访问安全：[ADR 0012](../decisions/0012-process-local-provider-access-scheduling.md)、[Network 技术文档](network.md)
- PDF 访问画像：[ADR 0015](../decisions/0015-publisher-aware-tiered-pdf-acquisition.md)、[Acquisition 技术文档](acquisition.md)
- 当前用户合同：[配置手册](../../guides/configuration.md)

本文定义根级 `configuration.py`、`bootstrap.py`、`model/configuration.py` 与
`entry/cli/` 的配置协作。统一配置中心、安全发布、状态和诊断的当前用户行为仍以配置手册、
源码和测试为准；本文还规定 ADR 0015 的 Browser access/profile 目标边界。普通 `[access]`
配置、安全 profile 存储边界和裸 `sciretriever config` 的 Access 管理已经实现；
`config status/test` 已实现完整的 Browser 本地状态与显式单目标 probe 合同；共享 Planner、
Profile catalog、tiered cohort executor、Browser scheduler/session broker 的生产对象图及安装 wheel
identity 也已验收。当前 Browser client 仍为空、production Browser route count 为 0，execution
confirmation 与 runtime readiness 均关闭，所以这些基础设施不能写成已发布的自动 Browser 获取
能力。Provider 的易变外部字段仍以 [Provider Notes](../../notes/providers/README.md) 为依据。

## 1. 责任与依赖

```text
src/sciretriever/
  configuration.py              # 两类 TOML 的唯一解析、校验和发布边界
  bootstrap.py                  # 按 scope 组装 adapter 与非持久化 probe session
  model/configuration.py        # 不含 secret 的普通配置/readiness/probe Model
  entry/cli/main.py             # 命令路由与交互用例
  entry/cli/config_ui.py        # Rich/prompt-toolkit 呈现与导航
```

`configuration.py` 负责普通配置选择、严格 TOML 解析、凭据文件 owner/权限检查、服务 URL
规范化、origin 绑定、round-trip 编辑、安全 staging 与发布；它不访问外部服务、不形成文献
业务决定。`bootstrap.py` 只把短生命周期 secret 注入当前需要的具体 adapter，并组装共享
Network/Access Coordinator；它不显示、序列化或保存 secret。

Model 只保存普通参数、安全状态和中性 probe 结果。真实 API key、bearer token、Cookie、
凭据原文、binary stream、HTTP/vendor 响应和可辨识 secret 的 mask、长度、hash、前后缀或
fingerprint 都不能进入 Pydantic。CLI 只负责用户交互、确认和安全呈现，不拥有 Provider、
LLM 或 MinerU wire protocol。

## 2. 两类配置文件

普通配置是用户选择的 `config.toml`，只保存九个非 secret 责任组：

```text
paths / discovery / sources / assets / parsing / analysis / execution / library / access
```

Python 调用的显式路径、`SCIRETRIEVER_CONFIG`、当前目录已有 `config.toml` 依次决定读取
目标。交互中心需要写入时也按相同优先级选择目标；若当前目录没有文件，可以创建新的
`config.toml`。普通配置严格拒绝未知 section、字段、重复 key、错误枚举和不一致组合。

Provider、LLM 与远程 MinerU secret 只有一个生产来源：

```text
~/.sciretriever/credentials.toml
```

目录必须为当前用户拥有的真实非符号链接目录且精确 `0700`；文件必须为当前用户拥有、
单硬链接、非符号链接的普通文件且精确 `0600`。两类文件都使用有界 descriptor 读取并复核
文件身份，替换、过大、非法 UTF-8/TOML 或权限不安全都 fail closed。测试通过显式 `home`
依赖注入使用系统临时目录，Harness 不读取真实用户文件。

## 3. 普通配置合同

Provider 启用顺序、产品选择、contact identity、访问池、Storage 路径和运行预算属于普通
配置。`[analysis]` 明确保存：

```text
provider / service_name / protocol / base_url / model
context_window_tokens / authentication / eight budget values
```

支持的 wire protocol 是 OpenAI Responses、OpenAI Chat Completions 与 Anthropic Messages。
官方 OpenAI/Anthropic 只能使用各自官方 hostname、默认 HTTPS 443 和 `/v1`；自定义远程
服务必须使用 hostname-based HTTPS 与 API-key authentication；自定义 HTTP loopback 可以
显式无认证。URL 统一拒绝 userinfo、query、fragment、remote IP literal、dot segments、
编码分隔符和非规范端口文本。

context window 参与真实预算校验：chunk 不得超过总输入，单阶段输出和 metadata+content
输出必须适配总输出预算，内容工作流至少允许两次请求，保守的 UTF-8 字节/token 估算加
输出预留必须小于等于 context。交互层的三个 preset 只展开为明确数值，不进入 schema。

`[parsing]` 只保存 connection mode、Base URL、model identity 与 remote upload consent。
MinerU 3.4.4、protocol 2、profile `vlm-engine`、archive backend `vlm`、parse method `auto`
是只读实现事实，不是 backend 选择。loopback 只接受 HTTP loopback 且不需要 token；remote
只接受 hostname-based HTTPS，必须明确确认 PDF 离开本机并配置 bearer token。

### 3.1 Browser access/profile 配置边界

ADR 0015 的目标普通配置只表达 Browser 总启用选择、无 secret 的 operator-managed Browser
session profile identity、本机 Browser 资源上限，以及对已核实 Provider policy 的收紧值。普通配置不能：

- 改写 `browser_rate_limit_group`、`browser_session_key`、允许 origin 或 Profile rule revision；
- 把同一风险组按 DOI、Literature、入口 URL 或随机任务拆开；
- 提高官方并发/额度、缩短 interval/cooldown、忽略 window/reset/`Retry-After` 或自动提速；
- 为未知站点启用 generic Browser fallback、任意 JavaScript、自动登录或 challenge 绕过。

Browser session profile 位于固定用户级专用目录，由 Configuration 以安全的 opaque identity 解析；
不接受未校验的任意绝对路径。目录与文件按敏感会话材料检查 owner、普通文件/目录和符号链接
边界。Cookie、local storage、账号、机构身份、profile 内容或其 fingerprint 不写入
`config.toml`、`credentials.toml`、Model、Catalog、Report 或日志。纯 Browser 访问方不因为
拥有 `PublisherAccessProfile` 就需要 Provider credential section；API token 与 Browser session
始终是两种不同 readiness。

Browser session profile presence 只表示本地安全会话容器存在，不表示当前已经登录，更不表示任意 Literature
具有 entitlement。登录、MFA、challenge、session health、cooldown 和 circuit 是当前 Browser
运行状态，不持久化回普通配置或凭据文件。

当前普通配置字段为：

```toml
[access]
browser_enabled = false
browser_profile = "institutional-access" # 未选择时省略
browser_max_concurrency = 2
browser_policy_overrides = []
```

`browser_enabled = true` 必须同时选择安全的 `browser_profile` identity；它不要求该目录已经
存在，目录 presence 由独立本地 readiness 检查。`browser_max_concurrency` 是大于等于 1 的
全局本机 process/context 资源 cap，不改变任何 risk group 固定的组内并发 1。默认值 2 允许
两个独立 group 在本机资源许可时并行；operator 可以为资源受限机器进一步收紧为 1。

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

当前 production matrix 没有 Browser route 或 Browser policy group，所以生产配置中的 override
必须保持为空；任何自行猜测的 group 都会以 `browser policy group is unknown` fail closed。
`browser_enabled` 和 profile 选择本身也不会把 fixture-only/unsupported Profile 变成生产能力。

当前 Configuration foundation 已固定 profile 目录为：

```text
~/.sciretriever/browser-profiles/<opaque-profile-identity>/
```

调用方只能提供经过稳定、无 secret token 规则校验的 opaque identity，不能提供绝对路径、相对
跳转、URL、UUID、Cookie/token 等敏感标记或任意目录。`initialize_browser_profile()` 只创建或
选择该固定目录下的空 owner-only 容器；`configure_browser_access_profile()` 先校验普通配置
候选，再初始化 profile 并原子发布 `[access]`。发布前失败只回滚本次新建的空 profile，绝不
删除原本存在的 session，也不创建或改写 `credentials.toml`。`resolve_browser_profile()` 返回
不可序列化且 repr 不含 identity/path 的 opaque handle；handle 在 runtime 使用前重新检查目录
对象身份，目录被替换后 fail closed。

`.sciretriever`、`browser-profiles`、profile 及其所有子目录必须由当前用户拥有且精确 `0700`；
profile 内文件必须由当前用户拥有、为单硬链接普通文件且精确 `0600`。Configuration 使用
no-follow descriptor 递归核对对象身份、类型与修改竞态，不读取或解析任何文件字节；任意层级的
symlink、特殊文件、错误 owner/mode、硬链接或验证期间替换都会拒绝。纯本地
`browser_profile_status()` 只有 `configured`、`missing`、`attention` 三种输出，模型不包含
路径、内部文件名、Cookie 名/域/值/hash/fingerprint。`remove_browser_profile()` 只删除用户
明确选择且再次通过完整安全检查的固定 profile tree；symlink、特殊文件、错误权限或替换竞态
均 fail closed。删除 session 不修改普通配置，也不删除 Provider API credential。

普通 `[access]` 选择字段已经接入严格 TOML、round-trip 编辑和交互管理。当前 production
Browser rule catalog 仍为空，route count 为 0；因此 profile 即使存在，自动 Completion 的
Controlled Browser 仍是 unavailable，而不是 configured 或 authenticated。

## 4. 统一 credentials schema 与 origin 绑定

Provider section 按当前 adapter allowlist 保存字段；固定核心 section 为：

```toml
[llm]
api_key = "<secret>"
origin = "https://api.openai.com"

[mineru]
bearer_token = "<secret>"
origin = "https://mineru.example.invalid"
```

未知 section、未知字段、空 section、空值、控制字符、非法 origin 和不完整过渡字段组合
全部拒绝。Provider section 的具体字段与必需性见配置手册及 Provider Notes。

核心 secret 与保存时的规范 origin 精确绑定。Bootstrap 只能通过
`core_secret_for_origin(service, origin)` 取得当前普通配置精确引用的值；改变 Base URL 后
旧 secret 不会被发送到新服务。Network 在每次 redirect 重新执行 origin/credential alias
检查，跨 origin 不携带认证。loopback 服务和当前 scope 不需要的核心服务不会触发凭据读取。

旧 LLM/MinerU secret 环境变量已经退出产品合同：不读取、不回退、不自动迁移。保留的
环境控制只有普通配置选择 `SCIRETRIEVER_CONFIG` 和显示控制 `NO_COLOR` 等非 secret 边界。

## 5. 安全发布

普通 `[analysis]`/`[parsing]`/`[access]` 编辑使用 `tomlkit` round-trip：只更新目标 section，保留其它
section、注释和排版。发布流程为同目录 staging、`0600`、完整写入、flush/fsync、重读、
TOML/Pydantic 复验、原子 replace；任一步失败保留原文件并清理 staging。确认前只显示
普通字段 diff，不显示或推导 secret。

单一凭据 section 修改沿用相同 owner-only staging 和原子发布。核心服务经常同时改变位于
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
sciretriever config test <provider|llm|mineru> [--json]
sciretriever config test --browser <publisher-access-key> [--json]
sciretriever config test --all [--json]
```

裸 `config` 首页固定区分 `CORE SERVICES` 和 `LITERATURE PROVIDERS`。TTY 使用 Rich 与
prompt-toolkit 的非全屏界面，支持方向键、Enter、`A/L/M/T/Q` 快捷键和隐藏输入；非 TTY
降级为确定性文本菜单。主题支持 auto/dark/light/mono，`NO_COLOR` 强制 mono；状态不能
只靠颜色表达。所有交互、确认和 setup 结果写 stderr，stdout 为空；Ctrl+C/EOF 取消不产生
写入。旧 `config set/remove` 保持无效。

LLM setup 覆盖官方 OpenAI、官方 Anthropic 与 custom/compatible 服务，以及协议、URL、
模型、context、认证和预算。MinerU setup 不制造 backend 选项，remote 模式在 token 输入前
明确确认 PDF 上传边界。Provider 区继续从 adapter credential spec 生成字段，显示用途、
官方申请入口和普通配置启用提示；unsupported capability 字段不能冒充当前必需项。

Browser access 管理位于 `LITERATURE PROVIDERS` 的独立 Access 区，而不是 API key 字段。
Plain/TTY 两种界面都把三个已实现的 authorized primary-PDF API（CORE、Elsevier、Wiley）
与 Browser session readiness 分开显示，并支持：

- 选择或初始化安全 profile identity，同时原子保存启用后的 `[access]`；
- 经第二次明确确认后打开一个以该 persistent profile 为基础的可见空白 Chromium；
- 永久移除所选本地 session，但保留普通配置和全部 Provider API credential；
- 禁用 Browser access，但保留所选 profile 和本地 session。

人工登录 Browser 不接收目标 URL，不自动导航、填写账号、选择机构、处理 MFA/CAPTCHA、枚举
Cookie/storage 或下载文件；所有站点访问和登录都由用户直接操作。关闭窗口后只说明本地
profile 被保留，不声称已经登录，也不声称任意文章具有 entitlement。初始化、打开和删除都在
产生副作用前确认，取消不写配置、不创建或删除 profile、不启动 Browser。任何界面都不能显示、
复制或导出 Cookie。

该管理入口如实显示当前 production Browser route count 为 0，并说明本地 profile 不会启用
自动 Completion。它不把 profile presence 描述成登录，也不把人工登录描述成任意文章授权；
完整 route/profile/session/policy/action-required 状态和最小显式探测由下节独立命令提供。

## 7. status 与 probe

`config status` 是纯本地操作：读取两类配置，组装 capability/readiness 和 secret-opaque
presence view，不构造 Storage、Catalog、ArtifactStore 或 Network。人类输出用紧凑表格
展示：

- LLM provider/protocol/endpoint/model/context、credential presence/origin match 与 readiness；
- MinerU mode/endpoint/固定实现身份、credential presence/origin match 与 readiness；
- Metadata API 与 authorized primary-PDF API 的独立 enabled、字段
  configured/missing/optional、policy readiness 和下一动作；
- PDF acquisition 固定顺序：Public → Authorized API → Controlled browser；
- Controlled Browser 的 framework/Playwright package、production route、普通开关、profile
  presence、未评估的 session/login、未证明的 article entitlement、显式 probe、policy
  evidence 与所需下一动作；
- Storage 和执行参数概要。

人类输出只逐项展开已启用或已有凭据的 Metadata API，其余禁用项用数量摘要收起；授权主
PDF API 单独列出 CORE、Elsevier、Wiley 和已知不支持直接 PDF 的 Springer，避免把 Metadata
凭据与全文访问能力混成一项。当前 production Browser route count 为 0，因此 Browser 分区
如实显示 automatic acquisition 与显式 probe 均不可用，并给出
`browser-production-route-unavailable`，不会因为 profile 已选择或存在而改变结论。

本地 presence 不能描述为认证成功。JSON 使用稳定分组 schema、无 ANSI，也不能包含 secret
特征或 configuration fingerprint。

Browser 的纯本地状态只能说明 Profile 已支持、已选择且通过本地安全检查，或
missing/action-required；不能根据 Cookie 文件存在声称 authenticated，也不能声称具体文献
entitled。动态 login/session/circuit/cooldown 不保存为“上次状态”。`config status` 不启动
Browser、不访问 Provider，也不枚举 Cookie、origin history、selector 或 profile 内部文件。
Playwright Python package 可发现也只表示依赖存在；`launch_assessed` 固定为 `false`，status
不检查 Browser binary 或启动能力。JSON 保持原有顶层分组，并在
`providers.controlled_browser` 下稳定区分：

```text
enabled / local_max_concurrency
runtime.framework_available / python_dependency_available / launch_assessed
profile.selected / presence
session.assessment / authenticated / article_entitlement
automatic_acquisition_available / production_route_count / routes
probe.available / requires_explicit_target / supported_access_keys
action_required[{code, reason, action}]
```

JSON 不含 ANSI、profile path、configuration fingerprint、Cookie 特征、selector、原始异常或
secret 特征。`profile.presence = configured` 仍与
`session.authenticated = null`、`article_entitlement = not-proven` 同时成立。

`config test` 构造独立的 `ProductionConfigurationProbeSession`，复用生产 adapter 和共享
Network，但不构造 Storage。Provider probe 使用官方最小只读请求；LLM probe 固定发送：

```json
{"probe":"sciretriever-configuration"}
```

并要求严格响应 `{"ok":true}`。它不发送用户 Literature 内容，但可能消耗少量额度。
MinerU probe 只调用 `GET health`，验证 healthy、release 3.4.4、protocol 2 和 profile；不
submit、poll、fetch archive 或上传 PDF。`--all` 汇总已启用 Provider、LLM、MinerU；一个
失败不阻断其它结果，failed/skipped 使退出码为 3。人类模式在 LLM/`--all` 前确认副作用；
JSON 模式视为脚本显式授权。

普通 Provider API probe 不隐式启动 Browser。Browser session probe 必须由用户
显式选择具体 Publisher access key：

```text
sciretriever config test --browser <publisher-access-key> [--json]
```

该选择与位置 Provider、`--all` 互斥，一次只允许一个 production-approved 最小目标；人类
模式再次确认可能打开可见 Browser，JSON 调用本身视为显式授权。probe 使用与自动获取相同的
risk-group scheduler seam，最多一次导航，结果只包含 launch/target/authentication 的顺序检查，
固定 `article_entitlement = not-proven` 与 `persisted = false`。`--all` 永远不隐式加入 Browser。
当前 production target 集合为空，所以任何规范 access key 都稳定 `skipped` 并返回
`browser-production-route-unavailable`，不启动 runtime、不导航、不猜 URL。未来接入的真实
target 仍须使用可见 Browser、同一 Profile guard 与共享 scheduler；存在 profile、页面可打开、
当前登录和具体文章 entitlement 始终是不同结果。真实 Provider probe 不进入 Harness，精确
现场范围需要用户另行授权。

核心 probe 返回 `CoreConfigurationProbeResult`，details 分别为
`LLMConfigurationProbeDetails` 和 `MinerUConfigurationProbeDetails`，共同固定
`persisted = false`。任何 probe 都不创建 DiscoveryRun、Literature、MetadataObservation、
Asset、Catalog、Report 或测试历史，也不把认证通过解释成具体文献全文 entitlement。

## 8. 离线验证要求

直接测试覆盖严格 schema、URL/预算组合、origin 错配、权限/符号链接、round-trip、staging
失败、跨文件每个中断点、三种 LLM protocol、认证 redirect、MinerU health-only、Browser
profile identity/owner/symlink、只允许收紧的 policy、API/Browser readiness 分离、四主题、
窄终端、快捷键、取消和 secret/Cookie 不泄漏。安装 wheel 旅程使用临时 HOME、测试自有
`credentials.toml` 与 fake transport 验证真实 console、生产 Bootstrap、status、LLM/MinerU
probe 和 `--all`；Browser 使用临时 profile 与本地页面 fixture。不得使用旧 secret 环境变量、
真实凭据/Cookie、真实网络、生产 Catalog 或用户语料。Full Harness 还必须通过 Pyright
strict、全量 unittest、wheel 构建和内容核对。
