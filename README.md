# SciRetriever

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Package](https://img.shields.io/badge/package-0.1.0-2F855A)](pyproject.toml)
[![CI](https://img.shields.io/badge/CI-quick%20%2B%20full-1F6FEB)](.github/workflows/ci.yml)

## 产品定位

SciRetriever 面向需要持续建立专题文献数据库的研究者和文献整理人员。它把主题发现、引用发现、书目信息导入、手动 PDF、自动补全、本地查询和导出汇入同一个逻辑数据库：关系与运行事实保存在 SQLite Catalog，文献资产和派生产物保存在 ArtifactStore。

产品边界止于通用文献元数据、原始资产、总结型轻结构化内容及其同源章节、引用关系和 provenance。反应、分子、路线、产率、材料性质等领域数据由下游系统处理。完整目标见[产品需求](docs/architecture/requirements.md)，长期约束见[架构决策索引](docs/architecture/decisions/README.md)。

## 安装与最小本地启动

SciRetriever 支持 Python 3.10 及以上版本，开发基线为 Python 3.12。当前仓库没有声明已经发布到 PyPI；从源码检出后使用锁定依赖运行：

```bash
uv sync --locked
```

仓库中的 [`example/config.example.toml`](example/config.example.toml) 是不含 secret 的公开示例。复制到自己的私有
运行目录后，最小本地配置只需要把 Catalog 和 ArtifactStore 改成真实绝对路径：

```toml
[paths]
catalog_path = "/absolute/private/path/catalog.sqlite3"
artifact_root = "/absolute/private/path/artifacts"
```

保存为私有位置的 `config.toml`，再选择该文件并查看安装后的控制台入口：

```bash
export SCIRETRIEVER_CONFIG=/absolute/private/path/config.toml
uv run --frozen sciretriever --help
```

一个完全本地的最小旅程如下；它不会访问外部 Provider：

```bash
uv run --frozen sciretriever import metadata bibtex library.bib --json
uv run --frozen sciretriever literature search --json
uv run --frozen sciretriever literature show LITERATURE_ID --json
uv run --frozen sciretriever import pdf LITERATURE_ID article.pdf --json
uv run --frozen sciretriever export pdf LITERATURE_ID article-copy.pdf --json
```

## 命令行入口

安装包公开且固定的命令树是：

```text
sciretriever discover topic
sciretriever discover citations

sciretriever complete pdf
sciretriever complete content

sciretriever literature search
sciretriever literature show
sciretriever literature references
sciretriever literature cited-by

sciretriever import metadata
sciretriever import pdf

sciretriever export metadata
sciretriever export pdf
sciretriever export content

sciretriever config
sciretriever config status
sciretriever config test
```

每个叶命令都支持 `--json`。稳定主结果写入 stdout；日志、进度和脱敏诊断写入 stderr。日志有两个运行模式：

- 默认正常模式记录操作与 Provider 的开始/结束、由 Entry 汇总的 PDF tier/Browser escalation、目标与风险组进度、等待/暂停、交付/耗尽和稳定失败；不会用逐 route miss、candidate、capture 或 cleanup 重复刷屏。失败始终包含稳定错误代码、原因、建议动作和是否可重试。
- `--debug` 在正常日志之外记录逐步骤轨迹，包括 Metadata raw item 的 accepted/empty/rejected、Network 请求结果与耗时、Completion target/tier、PDF route 的 `disposition/next`、授权 API target/lookup/download，以及 Browser 的 eligible/admitted/attempted/delivered、排队限速、session reuse、页面状态、捕获和清理。Debug 仍不输出密钥、Cookie、完整 URL、响应正文、文献正文、prompt、profile 路径或机器路径。

日志按“时间、级别、组件、状态、动作、原始事件 ID、有序字段”呈现；失败原因和建议动作独立换行，避免挤成一段。例如：

```text
2026-08-18 09:20:31.245 INFO  metadata     ✓ provider finished [metadata-provider-finished] provider=datacite · outcome=SCAN_LIMIT_REACHED · raw=100 · accepted-items=51 · empty=49 · rejected=0 · elapsed=3.309s
2026-08-18 09:20:41.506 WARN  acquisition  ✗ route failure [acquisition-route-failure] tier=public · route-key=public:landing-crossref · disposition=failure · next=next-route · code=acquisition-public-locator-network-failed
    reason  A public PDF locator could not be accessed safely.
    action  Check the source and shared Network policy before retrying.
```

连接终端时可以使用有限颜色；重定向、非 TTY、`TERM=dumb` 或设置 `NO_COLOR` 时自动输出无 ANSI 的普通文本。Debug 行额外带源码位置，原始 `event` ID 始终保留，方便用 `rg` 定位。

`--debug` 是全局选项，也可以放在具体命令末尾。需要保存一次运行的报告和日志时，分别重定向 stdout 与 stderr：

```bash
mkdir -p run/logs run/reports
sciretriever complete pdf --all-pending --json \
  > run/reports/completion.json \
  2> run/logs/completion.log
sciretriever --debug complete pdf --all-pending --json \
  > run/reports/completion-debug.json \
  2> run/logs/completion-debug.log
```

日志是本次运行的非权威诊断，不写入 Catalog，也不用于决定重试、耗尽或文献状态。稳定进程退出码如下：

| 退出码 | 含义 |
| ---: | --- |
| `0` | 正常到达操作边界；包括全部目标成功、局部目标失败和全部目标失败，逐目标结果以 Report 为准 |
| `2` | 命令输入或 usage 错误 |
| `3` | 操作级失败，或显式 probe 未通过；不表示一个正常结束的批次中存在失败目标 |
| `4` | 配置或生产 Bootstrap readiness 失败 |
| `70` | 操作系统或系统级 I/O 失败 |
| `130` | 受控中断 |

批处理自动化不能只用退出码判断“每篇都成功”：`0` 表示命令完整走到正常边界，脚本还必须读取
JSON Report 中各目标的结果分区；只有整个操作未能到达该边界时才返回 `3`。参数解析失败仍由
`argparse` 返回 `2`，配置/组装失败返回 `4`，Ctrl+C 或 Report 的受控中断返回 `130`。

## 发现与补全是两类操作

`discover topic` 和 `discover citations` 负责有边界的外部发现。它们接纳文献身份、保留来源 observation、去重，并记录 DiscoveryRun、来源结果和直接原因；不会顺带下载 PDF、解析内容、运行分析，也不会对每篇文献逐一调用全部 Provider 做二次补查。

`complete` 从数据库的 current facts 出发补齐已经入库的文献：

```text
sciretriever complete pdf ...
sciretriever complete content ...
```

`pdf` 的目标是达到 `ASSET_READY`，`content` 的目标是达到 `CONTENT_READY`。每次运行必须通过以下一种 selector 明确选择范围：

- `--all-pending`
- `--discovery-run-id`
- 一个或多个 `--import-meta-literature-id`
- `--query`
- 一个或多个 `--meta-literature-id`
- 一个或多个 `--literature-id`

实际目标集合只在本次进程内冻结，不会作为新的持久实体写入数据库。重跑会重新读取 current facts，从第一个缺失步骤继续。普通范围按 MetaLiterature 去重，并默认只补一个可用 Literature 版本；只有明确的 `NoPrimaryPdf`，或候选耗尽后的明确 `NoUsableContent`，才会跨版本尝试。网络、存储、Parser、LLM 失败，取消，或无法判断的结果都不会触发跨版本。

## 本地导入、查询与导出

书目信息交换支持三个格式值：`bibtex`、`ris` 和 `csl-json`；其中 `bibtex` codec 同时覆盖 BibTeX 与 BibLaTeX。导入结果区分 `created`、`enriched`、`matched` 和 `rejected`，完全重复的记录不会复制 observation。即使文献还只有元数据，也可以从数据库导出书目信息。

`literature search`、`show`、`references` 和 `cited-by` 都是纯本地、只读操作；它们不会访问 Provider、创建 DiscoveryRun 或写入数据库事实。`literature references --reference-id ...` 可进一步读取一条 ReferenceDetail。

手动 PDF 使用：

```bash
uv run --frozen sciretriever import pdf LITERATURE_ID input.pdf --json
```

该命令要求选择已经存在的具体 Literature。SciRetriever 复制而不移动用户文件，并在内部副本上检查实际 PDF 字节、标准 reader 和页面树；不会保存用户文件的绝对路径，也不会修改或删除原文件。若已有主 PDF，导入会拒绝而不是静默替换。成功只达到 `ASSET_READY`，不会隐式运行 Parsing 或 Analysis；同时会清除该 Literature 先前的自动获取耗尽事实。

`export metadata`、`export pdf` 和 `export content` 默认拒绝覆盖已有目标；只有显式提供 `--overwrite` 才会替换。三种书目格式都采用原子发布。PDF 和 content 的目标设为 `-` 时可把原始 artifact 写入 stdout，因此不能同时使用 `--json`。

## 配置、凭据与外部 readiness

普通配置没有版本标记，由九个严格、不可变的责任组组成：

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

未知组和未知字段会 fail closed。程序按以下顺序选择普通配置：

1. Python API 提供的显式路径；
2. `SCIRETRIEVER_CONFIG`；
3. 当前目录中已经存在的 `config.toml`；
4. 均不存在时失败。

CLI 不提供 `--config` 覆盖参数，也不创建隐式默认配置。完整字段和路径限制见[配置手册](docs/guides/configuration.md)。仓库根目录的 `config.toml` 是本机个人运行配置并被 Git 忽略；需要新建配置时复制公开示例，真实路径、Provider 选择和个人运行参数不应提交。

Provider、LLM 与远程 MinerU 的 secret 与普通配置分离，统一固定保存在
`~/.sciretriever/credentials.toml`。其目录必须是当前用户拥有、权限为 `0700` 的普通
非符号链接目录；文件必须是当前用户拥有、权限为 `0600` 的普通非符号链接文件。

- 裸运行 `config` 打开统一交互中心：首页分为 LLM Analysis、MinerU Parser 和 Literature Providers。LLM 向导配置协议、Base URL、模型、context window、认证与预算；MinerU 向导配置 loopback/remote endpoint、部署标识和远程上传确认；Provider 区继续提供凭据申请提示、设置、更新与移除。secret 只通过隐藏输入收集，不接受 argv/option 传值。
- TTY 界面使用 Rich 与 prompt-toolkit，支持方向键、Enter 和 `A/L/M/T/Q` 快捷键；`--theme auto|dark|light|mono` 可选主题，`NO_COLOR` 强制单色。重定向输入时自动使用确定性的编号菜单。全部交互提示写 stderr，stdout 保持为空。
- `config status` 是纯本地检查，不联网；默认用紧凑表格显示 LLM/MinerU 普通配置、凭据 presence 与 readiness，按 Metadata/Acquisition 列出 Provider 字段，并明确展示 PDF 的“公开路径 → 授权 API → 受控浏览器”顺序。它绝不显示 secret、mask、长度、hash 或 fingerprint；`--json` 提供无 ANSI 的稳定分组结果。
- `config test llm` 发送一条不含用户文献内容的最小严格 schema 请求，可能消耗少量额度；`config test mineru` 只执行 health 检查，不上传 PDF；Provider probe 继续使用官方最小只读请求。`config test --all` 汇总已启用 Provider、LLM 和 MinerU，一个失败不阻断其它结果。所有 probe 都不创建 Catalog、DiscoveryRun、Literature、Report 或测试历史。

LLM 当前支持 `openai-responses`、`openai-chat-completions` 和
`anthropic-messages` 三种明确协议。官方 OpenAI/Anthropic 使用固定 HTTPS Base URL 和
与规范 origin 精确绑定的 API key；自定义远程服务必须使用 hostname-based HTTPS 与
API key；自定义 HTTP loopback 可以显式选择无认证。MinerU 只暴露当前真实实现
`3.4.4 / protocol 2 / vlm-engine / archive vlm / parse auto`：loopback 不需要 token，
remote 必须是 hostname-based HTTPS、配置 origin-bound bearer token，并明确确认 PDF
会离开本机。项目不读取 LLM/MinerU secret 环境变量，也不提供旧合同回退或自动迁移。

自动 PDF 获取固定按“公开来源 → 授权 Provider API → 受控浏览器”逐层升级。当前公开
阶段包含已保存 direct/landing hints、arXiv、Europe PMC、Unpaywall 等；授权阶段当前
已接入 CORE API v3、Elsevier Article/Object Retrieval 与 Wiley Online Library TDM API。启用
`core` 时要求通过
`sciretriever config` 交互管理器配置 `api_key`，且只对具有 CORE `work:<id>` 或
`output:<id>` 强记录身份的文献适用；启用 `wiley` 时要求通过
同一管理器配置 `tdm_api_token`，且只对 DOI 安全解析后实际落地到
Wiley Online Library 的文献适用。启用 `elsevier` 时要求配置 `api_key`，可选
`institution_token`；只有 PII、合法 Elsevier Article EID 或 DOI 实际落地到
ScienceDirect/linkinghub 才适用。它先从 Article FULL XML 提取显式 `MAIN web-pdf`
attachment EID，再用 Object Retrieval 获取 PDF；FULL XML 没有可用 MAIN object 或无法
安全解释时，才以同一强身份向 Article Retrieval 协商 PDF 表示。可解析的认证、授权、quota
或服务错误不会被该 fallback 绕过；普通 Scopus EID、任意 object、XML 和 supplement 不会
冒充主 PDF。Springer 当前全文 API 产品返回 JATS/XML，不是主 PDF API。Controlled Browser
当前有 9 条生产 route：ACS Publications、AIP Publishing、Elsevier / ScienceDirect、IOPscience、
Oxford Academic、RSC Publishing、Science / AAAS、Springer Nature Link 和 Wiley Online
Library；它们只在公开与授权 API 层完成后，对仍缺 PDF 且强访问方证据收敛到对应平台的文献
适用。9 条 route 均已通过 production 工程准入；用户选择并初始化一个持久 Browser Profile、
显式启用 Browser 且本地 runtime 就绪后，它们分别按 Publisher 串行限速进行逐文章 Profile/IP
尝试。总开关、Profile 存在或其中保存了浏览器状态都不证明组织合同、登录成功或具体文章有
权限，operator 仍须确保实际使用符合组织授权和 Publisher 条款。

同一批目标会先完成 Public cohort，再只对剩余目标执行 Authorized API cohort；低风险路线
发生 timeout、临时网络错误、`429`、quota 或 `Retry-After` 时会延期或失败，不会借机切换
Browser 绕过限制。进入经过生产核实的 Browser route 时，不同
`browser_rate_limit_group` 可以并行，同一组固定 `concurrency = 1`，并按该 Provider 的文章
启动间隔、窗口和 cooldown 串行；`browser_max_concurrency` 只是跨组的本机资源上限。它默认
为 `5`，必须是大于 `1` 的整数，不设上限；当前 `9` 条 route 不是配置上限。较大的值只允许
更多不同 Publisher lane 在同一个 CloakBrowser process/context 中同时活动，不会启动多个 Browser，
也不会改变同一 Publisher 串行。

Browser 升级前，正常日志会显示剩余篇数、并行组数、各组 `minimum_start_interval`、
`next_allowed_in_seconds` 和保守 `minimum_duration_seconds`。跨组最低总时长取最慢组的下界，
仍不包含无法预知的网络、页面渲染或服务等待时间。验证页会进一步区分“受限资源正在加载”、
“自动验证正在完成”、“本地策略挡住了必要资源”、“明确需要人工交互”和“等待超时”；只有自动
验证自然完成才返回文章流程。登录、MFA、人工 challenge、账号警告和 cleanup failure 会暂停或
熔断对应组，并以稳定原因和建议动作进入本次报告。第一版不提供交互式 Browser 登录、机构选择、
MFA 或 CAPTCHA 处理入口；遇到这些状态时应改用获授权 API 或手动 PDF。已提交的其它 Provider
结果不会回滚。Ctrl+C 形成受控中断，重跑会重新读取数据库 current facts，只补仍缺失的步骤。

Controlled Browser 使用一个 operator-managed 持久 Profile，并在首次初始化时把 native Linux
persona、locale、timezone、screen、Browser version policy 和 fingerprint seed 固化到 owner-only
identity manifest。同一 Profile 冷启动时复用同一设备身份；seed、Profile 路径和浏览器状态不会
进入普通配置、日志、Report 或文献数据库。每个生产对象图只启动一个 `headless = false` 的
CloakBrowser patched Chromium process 和一个 persistent BrowserContext，SciRetriever 仍以
Playwright API 作为内部控制协议。所有 Publisher lane 共享该 context；同一 Publisher 严格串行，
不同 Publisher 在全局 cap 内并行，每篇文章使用隔离 page、handler、连接绑定、预算和临时下载
目录。对象图关闭后 process/context 与临时下载工作区会清理，Profile 中由 Chromium 管理的状态
跨命令保留。无 GUI Linux 使用 Xvfb；出版社请求继续由 Chromium 原生完成 TLS、HTTP、Cookie、
redirect、页面点击和下载。本机 loopback CONNECT proxy 只把已审核 hostname/port 固定到 Network
批准的精确 IP，并透传加密字节，不终止 TLS，也不以 Python HTTP 替代浏览器网络栈。

`sciretriever config` 的 Browser Access 区用于显式安装、更新或回退经核实的 CloakBrowser
binary，选择/初始化一个不含敏感信息的固定身份 Profile、删除本地 Profile、禁用自动 Browser 或
调整跨 Publisher 并发。普通 Completion 不隐式下载 binary，wheel 也不嵌入 vendor binary。
installer 只在该显式动作中保留并验证本次实际 archive：Ed25519 签名、manifest
version、仓库固定 SHA-256 与 archive 实际 SHA-256 必须同时一致后才会发布。普通
Browser 运行使用每次 lease 创建的无凭据临时 cache view，vendor 只能看见已验证的
固定 v146 bundle，不会读取长期 runtime root 中的 license/Pro/update 状态。当前
older-free v146 不消费 CloakBrowser license；已保留的凭据 section 在 status 中明确显示为
`reserved-not-used-by-pinned-free-binary`。
SciRetriever 不提供 Cookie 导入导出或人工登录窗口，不填写账号/密码、不选择机构、不读取 Cookie
或登录结果，也不处理/绕过 MFA、CAPTCHA 或 challenge。同一 Profile 同时只能由一个 Browser
process 使用。

CloakBrowser 是普通 Acquisition 与显式 `config test --browser` 唯一的生产 Browser runtime；
Playwright 只作为 CloakBrowser context 的内部控制 API。源码不再发现或启动 Playwright bundled
Chromium、系统 Chrome 或其它 stock runtime，也没有用户可选或隐藏的双引擎开关、运行失败自动
fallback 或 `cutover_pending` 状态。缺少任一 Cloak runtime 前置条件时，Browser route 会以稳定
原因 fail closed，Public 与 Authorized API 路线仍按各自合同运行。

生产 Browser route count 与 local eligible count 均为 `9`。只有
`[access].browser_enabled = true`、`browser_profile` 已选择且固定 identity manifest 安全就绪、
CloakBrowser wrapper、Playwright API、经签名核实的目标 binary 版本和 headed display（Linux 上
为 Xvfb）都就绪时，生产 Bootstrap 才会创建可执行 Browser adapter。`sciretriever config status`
只检查这些本地静态事实，不启动 Browser、不读取 Profile 内容，也不会断言已登录；显式 probe
每次只能选择一个当前 eligible 目标：

```text
sciretriever config test --browser acs-publications
sciretriever config test --browser aip-publishing
sciretriever config test --browser elsevier-sciencedirect
sciretriever config test --browser iopscience
sciretriever config test --browser oxford-academic
sciretriever config test --browser rsc-publishing
sciretriever config test --browser science-aaas
sciretriever config test --browser springerlink
sciretriever config test --browser wiley-online-library
```

启用 Browser 后，九家都可以成为显式 probe 目标；probe 使用生产规则/controller、目标 origin
和该规则审查过的 challenge dependency，并以 deny-all capture guard 禁止 PDF/body 接纳。它只
检查 Cloak runtime、固定身份和目标页面流程，不下载文章 PDF，也不评估 Profile 是否已登录、
当前机构 IP 或任意文章 entitlement；`config test --all` 不会隐式启动 Browser。
支持矩阵、等待语义、状态检查和故障处理详见
[PDF 获取指南](docs/guides/pdf-acquisition.md)。限速只能降低风险，不能保证账号不会被限制；
用户仍须遵守自己的访问授权和站点规则。

外部命令只有在 adapter、普通参数、凭据、AccessPolicy 和所需外部服务全部就绪时才会发起调用。缺少任一条件时，生产 Bootstrap 会在创建 Storage 之前稳定 fail closed，例如返回 `metadata-not-ready`、`acquisition-not-ready`、`parser-not-ready` 或 `analysis-not-ready`；这类结果表示当前运行环境尚未就绪，不表示控制流会静默降级。

## 当前验收边界

当前证据严格分为三层，不能互相替代：

### A. 安装 wheel、真实 console 与生产 Bootstrap

已在隔离虚拟环境中从 fresh wheel 验证真实 `sciretriever` console script，且没有仓库 `sys.path` 泄漏。该层已经覆盖：固定命令树及旧入口拒绝；生产本地空查询；同一真实 SQLite Catalog/ArtifactStore 上的三种书目导入导出、手动 PDF、search/show、references/cited-by/ReferenceDetail、PDF/content readback 和导出、交互式 `config` 凭据设置/移除及 `config status`；以及外部 scope 未就绪时在 Storage 创建前稳定 fail closed。

同一层还用测试自有的离线 resolver/transport 替换最底层真实网络连接，在不替换 CLI、参数解析、配置与凭据加载、生产 Bootstrap、Provider registry、功能模块 API、Entry operation、SQLite/ArtifactStore、报告或退出码的前提下，验证 production Crossref/Semantic Scholar、direct PDF、MinerU protocol 2 和 OpenAI Responses adapter 的受控线级响应。CORE/Elsevier/Wiley 授权 PDF client/registry 另由离线合同与生产组装测试覆盖 endpoint、私有凭据 header、阶段顺序、强访问身份、MAIN object、Article PDF 表示、DOI landing 路由和失败分类；没有发送真实全文 download 请求。该旅程覆盖 Topic/Citation Discovery、多来源与部分失败、scan limit、去重、PDF/Content Completion、明确无内容后的候选替换与物理回收、六类 selector、局部失败与重跑，以及本地查询和 Artifact 导出不触发外部请求。

这层证明安装产物、生产对象图和已实现 adapter 的离线接线，不等于真实 Provider、Parser 或 LLM 服务已经在线成功。

### B. 安装包与显式 Port 注入的深度合同验收

补充场景使用安装 wheel 中真实的 Entry、Metadata、Literature、Acquisition、Parsing、Analysis 和 Storage 模块，并在公开 Port 边界注入受控 fake，以精确驱动难以稳定在线重现的中断、失败和版本组合。

该层已经覆盖 Topic/Citation Discovery 的多来源、深度、边界、部分失败、去重和关系 publication；PDF/Content Completion 的六类 selector、目标冻结、稳定排序、受控跨版本和 exhaustion；Parser/LLM 局部失败、重跑只补缺失步骤、受控中断、五分区 Report，以及已提交事实保留。它证明这些精细控制流合同，不替代 A 层的真实 console 与 production Bootstrap 证据，也不代表外部服务已经在线验证。

### C. 受控协议与安全组件 QA

MinerU QA 使用安装 wheel 中的 production resolver、policy、transport、client、converter 和 adapter，连接当前测试进程内的受控 loopback HTTP service，验证 `health → submit → poll → archive`，并形成 parser-neutral Markdown、resource 和 provenance；私有 MinerU 中间文件不会泄漏。这不代表 operator 的真实 MinerU 部署已经在线验证。

Browser 已完成受控组件 QA 和真实 CloakBrowser patched Chromium/Playwright API QA；本地 HTTPS
场景覆盖规则批准的外部 JavaScript、受限 Cloudflare iframe/resource、未批准第三方 tracker 在
DNS 前丢弃、自动 challenge clear、人工控件、settle timeout、普通 response/direct PDF、点击或
页面脚本触发的跨 origin `3xx`、CDN PDF、HTTP attachment、通用 PDF 发现、native Chromium
download、TLS/DNS/IP binding、固定身份 Profile 三次冷启动、一个 process/context、Publisher
lane reuse 与文章级隔离、临时下载工作区清理、取消/超时和无残留资源清理。Playwright API 与
CloakBrowser wrapper 是 wheel dependency；定制 Chromium binary 由用户显式安装并独立核实版本，
不进入 wheel。当前 production Browser rule catalog 有 `acs-publications-pdf@3`、
`aip-publishing-pdf@3`、`sciencedirect-pdf@3`、`iopscience-pdf@2`、
`oxford-academic-pdf@3`、`rsc-publishing-pdf@3`、`science-aaas-pdf@3`、
`springerlink-pdf@5` 和 `wiley-online-library-pdf@3`。九家均以真实 Playwright API、真实 patched
Chromium、本地 HTTPS 和生产 selector/locator 完成离线规则验收；这证明安装产物与对象图接线，
不等于当前 IP、真实机构协议或具体文章已在线授权。

验收从未使用真实 Provider 在线调用、真实凭据、真实用户 PDF 或真实生产 Catalog；本项目也不据此宣称这些环境已被验证。

## 数据与安全边界

- 主题发现、引用发现、书目导入、手动 PDF、补全、查询和导出共享同一文献数据库，不创建平行结果集合。
- SQLite 保存关系、相对引用、hash 和 provenance，不保存大型文献 BLOB 或机器相关的绝对资产路径。
- 已接纳资产和发布产物采用不可变发布；不同字节不能原地覆盖。
- Secret 不能进入 Model、SQLite、provenance、diagnostics、URL、文件名或用户输出。
- MinerU、LLM、HTTP、浏览器和供应商私有类型不能越过对应 adapter 边界进入中性 Model。
- 文献数据、运行时 Catalog、下载资产、用户语料、个人配置和凭据不能提交到代码仓库。

## 开发与验证

```bash
uv sync --locked --dev
uv run --frozen python scripts/harness.py quick
uv run --frozen python scripts/harness.py full
```

Quick 执行 Ruff lint、Ruff format check 和 compileall，适合代码开发循环和普通工作分支的快速反馈；Full 还执行 Pyright strict、全部 `unittest`、wheel 构建和 wheel 内容核对，代码交付、PR、master、发布和安装包级验收默认必须通过。精确合同见 [`HARNESS.md`](HARNESS.md)。

## 项目文档

- [当前用户指南](docs/guides/README.md)
- [配置手册](docs/guides/configuration.md)
- [产品需求](docs/architecture/requirements.md)
- [架构与设计](docs/architecture/README.md)
- [开发手册](docs/development/README.md)
- [活动提案](docs/proposals/README.md)
- [历史归档](docs/archive/)
