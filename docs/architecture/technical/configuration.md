# 配置中心与凭据技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 产品依据：[产品需求](../requirements.md)
- 架构决策：[ADR 0014](../decisions/0014-capability-scoped-providers-and-local-credentials.md)
- 访问安全：[ADR 0012](../decisions/0012-process-local-provider-access-scheduling.md)、[Network 技术文档](network.md)
- PDF 访问画像：[ADR 0015](../decisions/0015-publisher-aware-tiered-pdf-acquisition.md)、[Acquisition 技术文档](acquisition.md)
- 当前用户合同：[配置手册](../../guides/configuration.md)

本文定义 `configuration/`、`bootstrap/` 两个启动边界 package、
`model/configuration.py` 与 `entry/cli/` 的配置协作。统一配置中心、安全发布、状态和诊断的当前
用户行为仍以配置手册、源码和测试为准；本文还规定 ADR 0015 的持久 Browser Profile access
目标边界。普通 `[access]`
配置和裸 `sciretriever config` 的 Access 管理已经实现；
`config status/test` 已实现完整的 Browser 本地状态与显式单目标 probe 合同；共享 Planner、
Profile catalog、tiered cohort executor、Browser scheduler/session broker 的生产对象图及安装 wheel
identity 也已验收。当前 production Browser route 与 local eligible count 均为 9：ACS Publications、
AIP Publishing、Elsevier / ScienceDirect、IOPscience、Oxford Academic、RSC Publishing、Science /
AAAS、Springer Nature Link 与 Wiley Online Library。Bootstrap 依据总开关、选中且安全存在的
Profile、production rule、Playwright Python 依赖、Chrome/Chromium executable 和 headed display
动态创建 `BrowserClient`；
`execution confirmation` 表示本次运行已明确启用，`runtime readiness` 只在 client 真正可构造时
为 true。Provider 的易变外部字段仍以
[Provider Notes](../../notes/providers/README.md) 为依据。

## 1. 责任与依赖

```text
src/sciretriever/
  configuration/               # 配置公开 surface 及按职责拆分的内部文件
    __init__.py                 # 稳定、窄小的公开导出
    documents.py               # 普通配置文档
    credentials.py             # 凭据读取与运行时 secret
    credential_edits.py        # 凭据原子编辑
    browser_profiles.py        # Profile 生命周期与独占 lease
    browser_access.py          # Browser policy 与 readiness
    status.py                  # 本地状态与显式 probe
  bootstrap/                   # 生产对象图公开 surface 及内部组装文件
    __init__.py                # 稳定、窄小的公开导出
    assembly.py                # 生产对象图 orchestration
    browser.py                 # Browser runtime 与 probe assembly
    graphs.py                  # 对象图合同
    services.py                # adapter/service assembly
    storage.py                 # Storage lifecycle 与 rollback
    probes.py                  # 无 Storage probe session
  model/configuration.py        # 不含 secret 的普通配置/readiness/probe Model
  entry/cli/main.py             # 命令路由与交互用例
  entry/cli/config_ui.py        # Rich/prompt-toolkit 呈现与导航
```

`configuration/__init__.py` 只重新导出稳定配置合同，其余同包文件按概念分别拥有普通文件与
凭据文件安全读取、TOML document 编辑、凭据 schema/runtime secret 绑定、readiness/probe 状态、
Browser Profile 生命周期和 Browser access policy。`bootstrap/__init__.py` 只重新导出稳定对象图、
scope、错误与构造函数，其余同包文件分别拥有 Browser runtime、对象图合同、adapter/service
assembly、Storage lifecycle/rollback、无 Storage probe session 和生产 orchestration。目录拆分只是
原 Configuration/Bootstrap 模块的代码治理方式，不增加产品模块；调用方只依赖 package 公开 surface。

配置边界负责普通配置选择、严格 TOML 解析、凭据/Profile owner/权限检查、服务 URL 规范化、
origin 绑定、round-trip 编辑、安全 staging 与发布；它不访问外部服务、不形成文献业务决定。
Bootstrap 只把短生命周期 secret 注入当前需要的具体 adapter，并组装共享 Network/Access
Coordinator 与一个 Profile-backed Browser runtime；它不显示、序列化或保存 secret 或 Profile
内容。

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

### 3.1 Browser access 配置边界

ADR 0015 的目标普通配置只表达 Browser 总启用选择、本机 Browser 资源上限，以及对已核实
Provider policy 的收紧值。普通配置不能：

- 改写 `browser_rate_limit_group`、`browser_session_key`、允许 origin 或 Profile rule revision；
- 把同一风险组按 DOI、Literature、入口 URL 或随机任务拆开；
- 提高官方并发/额度、缩短 interval/cooldown、忽略 window/reset/`Retry-After` 或自动提速；
- 为未知站点启用 generic Browser fallback、任意规则脚本、自动登录或 challenge 绕过；
- 配置 Browser Profile 路径、Cookie、账号、机构名、SSO/CARSI 内容、代理、stealth 或其它认证
  材料；普通配置只允许选择一个 opaque Profile identity。

Browser 使用当前机器的正常网络出口和一个 operator-managed 持久 Profile；在无 GUI Linux 上
由 Xvfb 提供虚拟显示。生产 Configuration 只接受规范化的 Profile identity，不接受路径，也不
读取、导入、导出或显示 Cookie、local storage、账号或机构身份。Configuration 把 identity 解析
到固定 owner-only 目录，验证目录树并通过跨进程独占 lease 保证同一 Profile 同时只有一个 Chrome
process。纯 Browser 访问方不因为拥有 `PublisherAccessProfile` 就需要 Provider credential
section；API token、Profile presence、Browser runtime readiness、登录状态与逐文章 entitlement
始终是不同事实。Chrome 认证状态可以留在 Profile 中；页面登录/MFA/challenge 结果、runtime
health、cooldown 和 circuit 不持久化回普通配置、凭据文件或文献数据库。

当前普通配置字段为：

```toml
[access]
browser_enabled = false
browser_profile = "institutional-access"
browser_max_concurrency = 5
browser_policy_overrides = []
```

`browser_enabled = true` 必须同时具有 `browser_profile`，并只显式授权已进入 production catalog
的规则启动有头 Browser；它不表示 Profile 已登录、当前 IP 或文章已获授权。Profile identity
必须是不含敏感信息的稳定短名称，不能是路径、URL、UUID、账号、机构名、Token 或 Cookie 标签。
`browser_max_concurrency` 是必须大于 1 的全局本机 Publisher-lane 资源 cap，不改变任何 risk
group 固定的组内并发 1。默认值 5；operator 可以按本机资源和活动 Publisher 数量设置任意更大
的整数，配置合同不设置上限。所有 lane 共享一个 Chrome process/persistent context，不会因为
cap 较大而启动多个 Browser。当前 production route 数量 `9` 只是 catalog 实现事实，不是该字段
的最大值。

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
fixture-verified/unsupported Profile 变成生产能力。普通 `[access]` 字段已经接入严格 TOML、
round-trip 编辑和交互管理；status 分开计算 9 条 production route、9 条 automatic eligible
route、总开关、Playwright package、Chrome/Chromium executable 与 headed display，
文章 entitlement 始终在实际获取时检查。

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
与 Browser runtime readiness 分开显示，并支持：

- 选择/初始化一个 opaque Browser Profile identity，并原子保存总开关和 Profile 选择；
- 在 Provider 实际要求登录、机构选择或 MFA 时显式打开使用同一 Profile 的可见 Browser；
- 显式永久删除选中的本地 Profile；
- 禁用自动 Browser access，同时保留 Profile、本地并发上限、Provider policy override 和全部
  API credential；
- 设置跨 Publisher 的本机 Browser 并发 cap。

说明必须明确：自动 Chrome/Chromium 固定以 `headless = false` 使用当前机器正常网络出口和一个
持久 Profile；无 GUI Linux 由 Xvfb 提供虚拟显示。可见 Browser 只在用户显式动作后打开，且与
自动 runtime 通过 Profile lease 互斥；SciRetriever 不自动导航登录页、不填写凭据、不选择机构、
不读取 Cookie/登录结果，也不处理/绕过 MFA、CAPTCHA 或 challenge。初始化、配置写入和删除都
先确认；取消不修改配置、不创建/删除 Profile，也不启动 Browser。登录、MFA 和 challenge 页面
状态在实际文章获取时只会被识别后停止，并建议用户显式处理其获授权的交互后重试、使用授权
API 或手动提供 PDF。

该管理入口如实显示当前 production Browser route count 与本地 automatic eligible count 均为
9，并分开呈现“route 已安装”“Browser 总开关”“本地 runtime 已就绪”和“文章 entitlement
运行时检查”。完整 route/policy/action-required 状态和最小显式探测由下节独立命令提供。

## 7. status 与 probe

`config status` 是纯本地操作：读取两类配置，组装 capability/readiness 和 secret-opaque
presence view，不构造 Storage、Catalog、ArtifactStore 或 Network。人类输出用紧凑表格
展示：

- LLM provider/protocol/endpoint/model/context、credential presence/origin match 与 readiness；
- MinerU mode/endpoint/固定实现身份、credential presence/origin match 与 readiness；
- Metadata API 与 authorized primary-PDF API 的独立 enabled、字段
  configured/missing/optional、policy readiness 和下一动作；
- PDF acquisition 固定顺序：Public → Authorized API → Controlled browser；
- Controlled Browser 的持久 Profile 有头模式、选中的 opaque identity 与 presence、
  framework/Playwright package/Chrome 或 Chromium executable、headed display/Xvfb、9 条
  production route、9/9 local eligible、普通总开关、共享 Chrome lifecycle、Publisher lane、
  未评估认证状态、逐文章 entitlement、显式 probe、policy evidence 与所需下一动作；
- Storage 和执行参数概要。

人类输出只逐项展开已启用或已有凭据的 Metadata API，其余禁用项用数量摘要收起；授权主
PDF API 单独列出 CORE、Elsevier、Wiley 和已知不支持直接 PDF 的 Springer，避免把 Metadata
凭据与全文访问能力混成一项。当前 production Browser route count 为 9，Browser 分区逐项显示
ACS Publications、AIP Publishing、Elsevier / ScienceDirect、IOPscience、Oxford Academic、
RSC Publishing、Science / AAAS、Springer Nature Link 和 Wiley Online Library 的
route/risk group/policy，再根据总开关、Playwright、Chrome/Chromium 与 headed display 给出
automatic acquisition/probe 的本地就绪状态和稳定 action code。catalog 真为空时的
`browser-production-route-unavailable` 分支仍保留，但不是当前默认状态。

本地 readiness 不能描述为 IP entitlement 或文章授权成功。JSON 使用稳定分组 schema、无
ANSI，也不能包含 secret 特征或 configuration fingerprint。

Browser 的纯本地状态只能说明生产规则、总开关、Profile selection/presence、Playwright package、
Chrome/Chromium executable 和 headed display 是否齐备；不能声称 Profile 已登录、当前机器 IP
或具体文献 entitled。动态页面状态、runtime health、circuit/cooldown 不保存为“上次状态”。
`config status` 不启动 Browser、不访问 Provider，也不读取 Profile 内容或枚举 Cookie、origin
history、登录站点或 selector。
Playwright Python package 可发现只表示依赖存在；status 还会检查 Chrome/Chromium executable
和 headed display（Linux 上为 Xvfb）是否存在，但 `launch_assessed` 固定为 `false`，不启动
Browser 或证明启动成功。
JSON 保持原有顶层分组，并在
`providers.controlled_browser` 下稳定区分：

```text
enabled / mode=headed-persistent-profile / persistent_authentication_supported=true
article_entitlement=checked-per-article / local_max_concurrency
runtime.framework_available / python_dependency_available / chromium_executable_available
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
Network，但不构造 Storage。Provider probe 使用官方最小只读请求；LLM probe 固定发送：

```json
{"probe":"sciretriever-configuration"}
```

并要求严格响应 `{"ok":true}`。它不发送用户 Literature 内容，但可能消耗少量额度。
MinerU probe 只调用 `GET health`，验证 healthy、release 3.4.4、protocol 2 和 profile；不
submit、poll、fetch archive 或上传 PDF。`--all` 汇总已启用 Provider、LLM、MinerU；一个
失败不阻断其它结果，failed/skipped 使退出码为 3。人类模式在 LLM/`--all` 前确认副作用；
JSON 模式视为脚本显式授权。

普通 Provider API probe 不隐式启动 Browser。Browser runtime/target probe 必须由用户
显式选择具体 Publisher access key：

```text
sciretriever config test --browser <publisher-access-key> [--json]
```

该选择与位置 Provider、`--all` 互斥，一次只允许一个 production-approved 最小目标；人类
模式再次确认将启动受控有头 Browser；无 GUI Linux 使用 Xvfb，JSON 调用本身视为显式授权。probe 使用与自动获取相同的
risk-group scheduler seam，最多一次导航。passed 只要求 runtime 已启动且最小目标已到达。结果固定
`article_entitlement = not-proven` 与 `persisted = false`。`--all` 永远不隐式加入 Browser。
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

probe 使用 navigation-only Browser 模式：顶层主文档和经 production rule 精确允许的认证
redirect 仍经过 destination/DNS/IP/host/TLS 边界；显式 request 逐项审查，未再次暴露 route 的
native redirect 只允许复用同页 live、已批准且预绑定的关联。非必要 stylesheet、script、image、
font 等子资源在 route 边界安全终止。页面 marker 通过即时、有界 DOM snapshot 判断；selector
不存在立即返回，不读取 Cookie、storage 或 profile 文件，不把页面正文、认证 query、header 或
原始异常写入结果。该优化只限制 probe 的访问面，不改变普通文章 Browser flow。

真实 Provider probe 不进入 Harness，精确
现场范围需要用户另行授权。

核心 probe 返回 `CoreConfigurationProbeResult`，details 分别为
`LLMConfigurationProbeDetails` 和 `MinerUConfigurationProbeDetails`，共同固定
`persisted = false`。任何 probe 都不创建 DiscoveryRun、Literature、MetadataObservation、
Asset、Catalog、Report 或测试历史，也不把认证通过解释成具体文献全文 entitlement。

## 8. 离线验证要求

直接测试覆盖严格 schema、URL/预算组合、origin 错配、权限/符号链接、round-trip、staging
失败、跨文件每个中断点、三种 LLM protocol、认证 redirect、MinerU health-only、Browser
Profile 安全树/独占 lease/显式删除、共享 runtime 与文章临时目录清理、只允许收紧的 policy、
API/Browser readiness 分离、四主题、
窄终端、快捷键、取消和 secret/Cookie 不泄漏。安装 wheel 旅程使用临时 HOME、测试自有
`credentials.toml` 与 fake transport 验证真实 console、生产 Bootstrap、status、LLM/MinerU
probe 和 `--all`；Browser 使用本地 HTTPS 页面 fixture，并覆盖跨 origin `3xx`、navigation-only
probe、普通文章批准子资源、第三方 tracker 丢弃、点击/脚本 redirect、HTTP attachment、共享
context 文章分流与临时资源清理。不得使用旧 secret 环境变量、真实凭据/Cookie/Profile、真实
网络、生产 Catalog 或用户语料。Full Harness 还必须通过 Pyright
strict、全量 unittest、wheel 构建和内容核对。
