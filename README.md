# SciRetriever

[![Node](https://img.shields.io/badge/Node-22.19.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Package](https://img.shields.io/badge/package-0.1.0-2F855A)](package.json)
[![CI](https://img.shields.io/badge/CI-quick%20%2B%20full-1F6FEB)](.github/workflows/ci.yml)

## 产品定位

SciRetriever 面向需要持续建立专题文献数据库的研究者和文献整理人员。它把主题发现、引用发现、书目信息导入、手动 PDF、自动补全、本地查询和导出汇入同一个逻辑数据库：关系与运行事实保存在 SQLite Catalog，文献资产和派生产物保存在 ArtifactStore。

产品边界止于通用文献元数据、原始资产、总结型轻结构化内容及其同源章节、引用关系和 provenance。反应、分子、路线、产率、材料性质等领域数据由下游系统处理。完整目标见[产品需求](docs/architecture/requirements.md)，长期约束见[架构决策索引](docs/architecture/decisions/README.md)。

## 安装与最小本地启动

当前 TypeScript 版本使用 Node 22.19.0 和 pnpm 10.32.1；仓库没有声明已经发布到 npm。从源码检出后使用锁定依赖运行：

```bash
pnpm install --frozen-lockfile
pnpm build
```

普通运行配置固定保存在 `~/.sciretriever/config.toml`；文献 Provider、Model Provider 与远程 MinerU 的
secret 另存为同目录下的 `credentials.toml`。推荐通过统一配置中心管理支持的设置：

```bash
node apps/server/dist/cli/main.js config status
node apps/server/dist/cli/main.js config test --help
```

首次确认修改时，配置中心会以私有权限创建普通配置文件。用户也可以直接编辑同一个
`~/.sciretriever/config.toml`。仓库中的
[`example/config.example.toml`](example/config.example.toml) 是不含 secret 的公开模板；若要从
模板开始配置本地存储，可以先确认目标文件尚不存在，再执行：

```bash
mkdir -p ~/.sciretriever
chmod 700 ~/.sciretriever
cp -n example/config.example.toml ~/.sciretriever/config.toml
chmod 600 ~/.sciretriever/config.toml
```

随后把 Catalog 和 ArtifactStore 改成真实绝对路径：

```toml
[paths]
catalog_path = "/absolute/private/path/catalog.sqlite3"
artifact_root = "/absolute/private/path/artifacts"
```

从任意工作目录运行都会读取这一个文件；无需选择配置路径：

```bash
node apps/server/dist/cli/main.js --help
```

一个完全本地的最小旅程如下；它不会访问外部 Provider：

```bash
node apps/server/dist/cli/main.js import metadata bibtex library.bib --json
node apps/server/dist/cli/main.js literature search --json
node apps/server/dist/cli/main.js literature show LITERATURE_ID --json
node apps/server/dist/cli/main.js import pdf LITERATURE_ID article.pdf --json
node apps/server/dist/cli/main.js export pdf LITERATURE_ID article-copy.pdf --json
```

## Browser 工作台预览

源码保留两个本地入口。静态交互样本用于快速查看布局与状态，不启动 Browser Host：

```bash
pnpm install --frozen-lockfile
pnpm preview:browser
```

打开 [静态样本](http://127.0.0.1:4173)，体验人工接管、模拟 PDF 获取、候选确认及失败场景。

实时工作台使用已校验的 operator Cloak bundle、真实 Browser Host、JPEG/SSE、持久 Candidate 与临时文献库：

```bash
SCIRETRIEVER_CLOAK_BUNDLE=/absolute/path/to/verified/cloak/bundle pnpm preview:workbench
```

打开 [实时工作台](http://127.0.0.1:4174)。它只访问合成 loopback 页面，支持双 viewer、接管/释放、PDF 捕获、
accepted 发布、uncertain 放弃、文献搜索/详情/引用/文件下载和 390px 布局。入口使用新的系统临时 home，正常退出
时清理，不读取用户 catalog、Profile 或凭据；配置、凭据和 readiness 由 TypeScript owner 直接组装。
运行依赖、支持边界和验证入口见 [web 工作台说明](apps/web/README.md)及
[TypeScript 开发入口](docs/development/typescript-foundation.md)。

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
sciretriever config test --help
sciretriever jobs create
sciretriever jobs run JOB_ID
```

每个叶命令都支持 `--json`。稳定主结果写入 stdout；日志、进度和脱敏诊断写入 stderr。日志有两个运行模式：

- 默认正常模式记录操作和 Metadata Provider 生命周期，以及由 Entry 拥有的 Discovery、Completion、PDF tier、Browser escalation、目标和 Provider group 摘要；Analysis metadata/content/publication stage、每次真实 role-level Agent call 的实际 Provider/wire Model、usage/elapsed 或稳定失败，以及已 dispatch Browser action 的 requested action/dispatch/稳定 step/page/capture 摘要也由各自 owner 输出一次。局部成功不掩盖问题：partial、需要人工 PDF、中断、未开始或失败会显示为需要处理的 WARNING，并在具体失败处给出稳定 code、reason、action 和 retryable；逐 route delivery/miss、candidate 和 cleanup 不会在 INFO 重复刷屏。
- `--debug` 在正常日志之外记录安全的下钻证据，包括 Metadata raw item 的 accepted/empty/rejected、Network 请求结果与耗时、Analysis stale/input 检查、PDF route 的 `disposition/next`、授权 API target/lookup/download、Agent protocol/capability/安全大小，以及 Browser scheduler/controller/native 的排队、Observation revision/fingerprint、transition/capture evidence 和清理。Debug 日志仍不输出密钥、Cookie、完整 URL、响应正文、文献正文、prompt、schema 内容、模型正文、selector、截图内容、profile 路径或机器路径；Browser Agent 实际收到的图片会在显式 Debug 时额外写入系统临时目录，日志只显示安全的 `directory_name`，目录内的 `manifest.ndjson` 可按序号、媒体类型和 hash 对照每轮输入。

每条日志都是可重定向的静态文本块。首行优先呈现时间、级别、组件、状态符号、动作和关键字段；放不下的字段与原始 `event` ID 折到 `context`，失败原因、建议动作、补充字段分别放在 `reason`、`action`、`details` 续行。例如：

```text
2026-09-02 09:20:31.245 INFO  completion   → target started · progress=4/10 · target-kind=meta-literature
    context target-id=safe-target · [completion-target-started]
2026-09-02 09:20:32.495 WARN  completion   ✗ target failed · progress=4/10 · stage=analysis
    context target-kind=meta-literature · target-id=safe-target · elapsed=1.250s · code=analysis-agent-response-invalid
            retryable=false · [completion-target-failed]
    reason  The returned structured result did not satisfy the expected contract.
    action  Check the selected Model capability and retry the failed target.
```

连接终端时使用实际宽度并限制在 80–240 列；非 TTY 默认按 120 列折行。重定向、`TERM=dumb` 或设置 `NO_COLOR` 时自动输出无 ANSI 的普通文本。Debug block 额外带 `source` 位置；原始 `event` ID 始终保留，方便用 `rg` 定位。

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

Debug 图片不写入仓库、Catalog 或普通日志。需要复核时，从 `completion-debug.log` 中找到
`event=agent-debug-image-directory-created directory_name=...`，再在系统临时目录中查找同名的
`sciretriever-agent-debug-*` 目录；其中 `manifest.ndjson` 将每张图片与 Agent 调用序号关联。

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
pnpm sciretriever import pdf LITERATURE_ID input.pdf --json
```

该命令要求选择已经存在的具体 Literature。SciRetriever 复制而不移动用户文件，并在内部副本上检查实际 PDF 字节、标准 reader 和页面树；不会保存用户文件的绝对路径，也不会修改或删除原文件。若已有主 PDF，导入会拒绝而不是静默替换。成功只达到 `ASSET_READY`，不会隐式运行 Parsing 或 Analysis；同时会清除该 Literature 先前的自动获取耗尽事实。

`export metadata`、`export pdf` 和 `export content` 默认拒绝覆盖已有目标；只有显式提供 `--overwrite` 才会替换。三种书目格式都采用原子发布。PDF 和 content 的目标设为 `-` 时可把原始 artifact 写入 stdout，因此不能同时使用 `--json`。

## 配置、凭据与外部 readiness

普通配置没有版本标记，由十个严格、不可变的责任组组成：

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
download
```

未知组和未知字段会 fail closed。所有正常命令只读取固定的
`~/.sciretriever/config.toml`；CLI 不提供 `--config`，也不读取配置路径环境变量或当前目录
`config.toml`。裸 `sciretriever config` 在第一次确认修改时创建并继续管理该文件，直接编辑也
受支持。完整字段、权限和人工迁移说明见[配置手册](docs/guides/configuration.md)。真实路径、
Provider 选择、个人运行参数和用户配置文件都不应提交到仓库。

旧的当前目录配置或旧环境变量曾指向的文件不会被自动读取、复制、移动或删除。迁移时先确认
`~/.sciretriever/config.toml` 不存在；若已存在，应人工比较并合并，不能直接覆盖。迁移完成后
把 `~/.sciretriever/` 设为 `0700`、两个 TOML 文件设为 `0600`。

文献 Provider、Model Provider 与远程 MinerU 的 secret 与普通配置分离，统一固定保存在
`~/.sciretriever/credentials.toml`。其目录必须是当前用户拥有、权限为 `0700` 的普通
非符号链接目录；文件必须是当前用户拥有、权限为 `0600` 的普通非符号链接文件。

- 裸运行 `config` 打开统一交互中心，首页固定为单词级 `Models`、`Search`、`Download`、`Parse`、`Analyze`、`Browser`、`Status`、`Theme` 与 `Quit`。首页和 Status 都只读取本地状态，不会因为打开页面而联网。
- `Models` 只管理两类对象：Model Provider 与完整 `provider/model` Model。Provider 拥有 `api`、`base_url` 和 exact-origin API key；Model 只拥有 `reasoning`、`image` 与 `stream`。`stream` 默认开启，可在具体 Model 的 Add/Edit 流程关闭。`Models → Providers` 独立管理 Provider、Key 和 Provider 测试；Search/Download 在具体 Source 对象页就近管理普通设置、Key 与 Test，Parse 则用一个 `Setup` 连续配置 MinerU 服务、上传授权与所需 token。
- `Models → Add` 先选择已有 Provider 或 `New`。新增远程 Provider 时，同一流程询问 URL、API 和隐藏 Key；Key 就绪后自动读取一次 `/models`，让用户选择远端 model。只有目录失败、为空或不能安全解析时才出现 `Manual`，目录结果不持久化。
- `Analyze → Setup` 与 `Browser → Setup` 直接选择已有完整 Model reference，不修改 Model，也不保存 reasoning/stream override。Analyze 的 strict structured output、text-only 和 no-tool 合同由 Analysis 派生；Browser 只展示 `image = true` 的 Model，其当前生产 Observation 使用的 JPEG、单图、字节、tool decision 与调用限制由 Acquisition/Bootstrap 派生。
- `Search/Download → Sources` 各有 `Auto / Custom` 两层。Auto 使用当前版本离线维护的默认安全集合；Custom 精确冻结用户列表与顺序并允许为空。Auto → Custom 冻结当时有效集合，Custom → Auto 删除固定列表。Search 的 `Limit` 默认 500，分别约束每个 Source 的过滤前原始 item，不是共享总量或 HTTP 请求数；选中 Source 后才显示它实际拥有的 `Setup`、`Key`、`Test`、`Enable` 或 `Disable`，Key 存在不改变集合。当前 Metadata Auto 为 Crossref、Semantic Scholar、arXiv、OpenAlex、Europe PMC、DataCite、CORE、OpenCitations；Acquisition Auto 命名 Source 为 arXiv、Europe PMC，并始终消费安全的 direct/landing hints。
- Sci-Hub 默认关闭且不进入 Auto；切到 Download Custom 后，`Sources → sci-hub → Enable` 可直接启用当前版本内置列表，Source 页始终就近提供 `Mirrors / Test`，并按当前状态显示 `Enable` 或 `Disable`。镜像编辑器用 `Add / Remove / Save / Reset / Back` 将有效列表保存为 custom override 或恢复跟随 builtin。系统按顺序而非并发尝试，只对 DOI 构造 landing，不自动发现镜像，也不询问 Key/Cookie/代理；配置 Test 不访问镜像或下载任意 PDF。
- TTY 界面使用 Rich 与 prompt-toolkit，支持方向键、Enter、Esc/左方向键返回、`/` 搜索长列表，以及 `M/S/D/P/A/B/I/T/Q` 首页快捷键；配置、查看、测试、危险、返回和退出动作分别使用 `◆/◇/▶/!/←/×` 及不同颜色，`NO_COLOR` 下仍保留标记。所有下级选择菜单都区分 `Back` 与 `Quit`：前者只返回上一级，后者立即关闭整个配置中心；确认和输入中的取消仍保持操作取消/中断语义，不作为菜单导航。`--theme auto|dark|light|mono` 可选主题；重定向输入时自动使用确定性的编号菜单。全部交互提示写 stderr，stdout 保持为空。
- `config status` 是纯本地检查，不联网；默认用紧凑表格分别显示 Model Providers/Models、Analyze/Browser 选择、MinerU、凭据 presence 与 readiness，按 Metadata/Acquisition 列出文献 Provider 字段，并明确展示 PDF 的“公开路径 → 授权 API → 受控浏览器”顺序。JSON 顶层使用 `models/analyze/download/browser/parsing/providers/storage/execution/library`；其中 `download` 只表示 Acquisition Source，`browser` 表示唯一通用 Agent route。输出绝不显示 secret、mask、长度、hash 或 fingerprint。
- `config test` 按配置 owner 分层：`provider <name>` 只读取一次有界 Model 目录；`model <provider/model> [--image]` 验证精确 Model 及其 reasoning/stream，但不改变 Analyze/Browser 选择；`search <source>` 与 `search --all` 执行 Metadata 最小只读请求；`download <source>` 与 `download --all` 只报告 Download 本地 readiness 和外部 probe 是否存在；`parse` 只执行 MinerU health；`analyze` 与 `browser model` 验证当前任务 Model；`browser site <access-key>` 才会显式启动受控 Browser。Model/Search/Analyze/Browser Model 可能消耗少量额度，均不发送用户文献或真实页面。
- 测试结果使用紧凑的 `Test / Request / Result`：Model、Analyze 和 Browser Model 测试把实际发送的 wire `model` 与本地 Provider 分行显示，并在 Request 中显示实际 method/endpoint 与 `Stream · on/off`；Provider/MinerU 显示实际的无凭据 method/endpoint；完整 `provider/model` 配置引用只保留在结构化 details 中。失败优先说明 HTTP/连接/认证/API/Model/请求或响应合同原因并给出一项下一步，不再只显示内部错误码。`--json` 复用同一 `diagnosis.request/reason/action`。Key、query、header、响应正文、供应商任意 message 和异常不会进入结果；没有更强证据的 404 只说明 Model 或 endpoint 之一不存在。
- Acquisition 没有安全且与具体文献无关的 probe 时，Download Test 明确返回 `acquisition-probe-unavailable`，不会借用 Metadata、访问 Sci-Hub、下载任意 PDF 或证明文章 entitlement。`config test --all` 汇总启用的 Search Source、Download 的可见限制、Analyze、Parse，并在 Browser 已启用时测试其 Agent Model；它不读取 Provider 目录、不测试任意未选 Model、不启动 Browser Site、不下载或上传 PDF。所有结果只属于当次 CLI，不创建 Catalog、DiscoveryRun、Literature、Asset、Report 或测试历史。

三项核心处理能力的配置入口与验证是：

| 能力 | 在裸 `config` 中的配置路径 | 显式验证 | 本地 ready 还要求 |
| --- | --- | --- | --- |
| 文献分析与总结 | `Models → Add` 配置 Model；`Models → Providers` 管理 Provider/Key；`Analyze → Setup` 选择并设置业务预算 | `Analyze → Test` 或 `config test analyze`；真实内容走 `complete content` | 所选 Model、其 Model Provider 与 exact-origin credential、Analyze limits 完整；strict structured output 由模块派生 |
| Browser Agent 下载 | `Models → Add` 配置 `image = true` 的 Model；`Browser → Setup/Profiles/Runtime` | `Browser → Test → Model` / `config test browser model` 验证模型；`Browser → Test → Site` / `config test browser site ACCESS_KEY` 验证最小站点；真实 PDF 走 `complete pdf` | 所选 image Model、其 Provider/Key、Agent controller、Browser identity Profile、CloakBrowser/Playwright/binary 与 headed display 全部就绪 |
| MinerU 解析 | `Parse → Setup` | `Parse → Test` 或 `config test parse`；真实 PDF 解析走 `complete content` | endpoint、部署身份，以及 remote 模式的上传授权与 origin-bound token |

模型目录结果只是 Provider 当次报告的 setup observation，不会持久化，也不会替代 probe。目录只
采信安全的模型 ID；`image` 由用户根据模型文档确认，strict output、tool、媒体格式和调用限制由
消费模块固定并通过显式测试验证，不进入 Model 配置。

Model reasoning 可保存 `default`、`none`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。
`default` 完全省略 wire effort 字段；其它值原样发送，不静默降级、近似映射或失败后改成 default。
配置向导对三种协议展示同一完整集合；具体模型是否接受某个值仍由显式 probe 验证，不能根据模型
名称猜测。

LLM 当前支持 `openai-responses`、`openai-chat-completions` 和
`anthropic-messages` 三种明确 API。远程 Model Provider 必须使用 hostname-based HTTPS 与
规范 origin 精确绑定的 API key；HTTP loopback Provider 不使用 key。MinerU 只暴露当前真实实现
`3.4.4 / protocol 2 / vlm-engine / archive vlm / parse auto`：loopback 不需要 token，
remote 必须是 hostname-based HTTPS、配置 origin-bound bearer token，并明确确认 PDF
会离开本机。项目不读取 LLM/MinerU secret 环境变量，也不提供旧合同回退。旧 `[agents]`、
`[analysis]`、`[access]`、`[models.services.*]`、`[models.profiles.*]` 和 `[models.entries.*]`
不做字段映射迁移；旧 credentials `[agents]` 与 `[models.*]` 也不再属于当前 schema。裸
`sciretriever config` 会在首页前以退出码 4 严格拒绝这些 section，保持两个文件原字节，不提供
Reset、迁移、恢复或 fallback。operator 手工删除旧 section 后，模型 key 需按当前
`[providers.<provider>]` 重新配置。

三种 LLM API 都默认发送 `stream = true`。Agents 在内部把有界 SSE 重建为一个完整 structured
result 或 tool call；具体 Model 可以设置 `stream = false`，此时只请求和解析非流式 JSON。
Analyze/Browser 只继承所选 Model，不会收到事件流、覆盖 stream，或在失败后触发另一种模式的重发。

自动 PDF 获取固定按“公开来源 → 授权 Provider API → 受控浏览器”逐层升级。当前 Auto 公开
阶段包含已保存 direct/landing hints、arXiv 与 Europe PMC；Unpaywall 需要在 Custom 中配置联系
邮箱，Sci-Hub 默认关闭并在 Custom 显式启用后按
当前版本 builtin 或普通 `[sources.acquisition.sci-hub].urls` custom override 顺序工作的 DOI-only
Configured Sci-Hub route。custom 完整覆盖 builtin；仓库不自动发现镜像，也不提供 Key、Cookie、
代理或绕过机制；每个 landing/PDF 继续经过共享 Network 和
统一 PDF 验收，operator 必须自行确认适用法律、机构政策、内容许可与服务条款。授权阶段当前
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
当前只有一条 `browser:generic` production route。它在公开与授权 API 层完成后，接收仍缺 PDF 且
具有安全 canonical landing 的文献；无需匹配 Publisher 点击规则或预设站点。用户选择并初始化
一个持久 Browser Profile、显式启用 Browser，并配置 `image = true` 的 Model 与本地 runtime 后，
唯一 `AgentBrowserController` 根据稳定页面 Observation 选择封闭动作。总开关、Profile 存在或
其中保存了浏览器状态都不证明组织合同、登录成功或具体文章有权限，operator 仍须确保实际使用
符合组织授权和站点条款。

同一批目标会先完成 Public cohort，再只对剩余目标执行 Authorized API cohort；低风险路线
发生 timeout、临时网络错误、`429`、quota 或 `Retry-After` 时会延期或失败，不会借机切换
Browser 绕过限制。所有 Browser 文章进入 `browser-generic`，固定 `concurrency = 1`，并按项目
保守的启动间隔、窗口和 cooldown 串行；`[browser].max_concurrency` 只保护本机 Browser 资源，
默认 `5`，必须是大于 `1` 的整数且不设上限。较大的值不会启动多个 Browser，也不会改变通用
执行组的串行语义。

Browser 升级前，正常日志会显示剩余篇数、`browser-generic` 的
`minimum_start_interval`、`next_allowed_in_seconds` 和保守 `minimum_duration_seconds`，仍不包含
无法预知的网络、页面渲染或服务等待时间。Agent 从第一次统一 Observation 起在元素点击、坐标
点击、surface 滚动、后退、等待变化和停止六种封闭动作中选择。Controller 只执行
`start → decide → apply`；Network 在每次返回前把
当前 article Page/frame/popup/viewer 收敛成语义 quiet 的可操作 Observation，只把 `Ready / Captured /
Blocked / Failed / Cancelled` 交给 Acquisition，页面交接期间不会把半加载界面交给 Agent。第一次
self-transition 反馈给下一轮，
重复 self edge 或 `A → B → A` 已知边才停止，可能的下载 Candidate 必须 captured、cleared 或 timeout。
Challenge 只是普通页面状态，并分别保留 Agent Stop、self、cycle、Candidate timeout 与 resource
blocked 结果；固定 32 次模型决策 safety fuse 只形成 `controller-safety-limit`，不写入获取耗尽。
第一版仍不提供交互式 Browser 登录、机构选择、
账号/密码输入、MFA、外部 CAPTCHA solver 或 token 注入；登录/MFA/账号警告和 cleanup failure
会以稳定原因进入本次报告。已提交的其它 Provider 结果不会回滚。Ctrl+C 形成受控中断，重跑会
重新读取数据库 current facts，只补仍缺失的步骤。

Controlled Browser 使用一个 operator-managed 持久 Profile，并在首次初始化时把 native Linux
persona、locale、timezone、screen、Browser version policy 和 fingerprint seed 固化到 owner-only
identity manifest。同一 Profile 冷启动时复用同一设备身份；seed、Profile 路径和浏览器状态不会
进入普通配置、日志、Report 或文献数据库。每个生产对象图只启动一个 `headless = false` 的
CloakBrowser patched Chromium process 和一个 persistent BrowserContext，SciRetriever 仍以
Playwright API 作为内部控制协议。所有文章共享该 context，并由 `browser-generic` 串行调度；
每篇文章使用隔离 page、handler、连接绑定和临时下载目录。对象图关闭后 process/context 与临时
下载工作区会清理，Profile 中由 Chromium 管理的状态
跨命令保留。无 GUI Linux 使用 Xvfb；出版社请求继续由 Chromium 原生完成 TLS、HTTP、Cookie、
redirect、页面点击和下载。本机 loopback CONNECT proxy 只把已审核 hostname/port 固定到 Network
批准的精确 IP，并透传加密字节，不终止 TLS，也不以 Python HTTP 替代浏览器网络栈。

`sciretriever config` 的 `Browser → Runtime` 用于显式安装、更新或回退经核实的 CloakBrowser
binary；`Browser → Setup/Profiles` 用于选择 Agent Model、初始化一个不含敏感信息的固定身份
Profile、删除本地 Profile、禁用自动 Browser 或调整本机资源 cap。普通 Completion 不隐式下载
binary，wheel 也不嵌入 vendor binary。
installer 只在该显式动作中保留并验证本次实际 archive：Ed25519 签名、manifest
version、仓库固定 SHA-256 与 archive 实际 SHA-256 必须同时一致后才会发布。普通
Browser 运行使用每次 lease 创建的无凭据临时 cache view，vendor 只能看见已验证的
固定 v146 bundle，不会读取长期 runtime root 中的 license/Pro/update 状态。当前
older-free v146 不消费 CloakBrowser license；已保留的凭据 section 在 status 中明确显示为
`reserved-not-used-by-pinned-free-binary`。
SciRetriever 不提供 Cookie 导入导出或人工登录窗口，不填写账号/密码、不选择机构、不读取 Cookie
或登录结果，也不处理 MFA、注入 CAPTCHA solver/token 或切换身份/出口；可见 Challenge 仍可由
唯一 Agent controller 在相同封闭页面动作内处理。同一 Profile 同时只能由一个 Browser
process 使用。

CloakBrowser 是普通 Acquisition 与显式 `config test browser site` 唯一的生产 Browser runtime；
Playwright 只作为 CloakBrowser context 的内部控制 API。源码不再发现或启动 Playwright bundled
Chromium、系统 Chrome 或其它 stock runtime，也没有用户可选或隐藏的双引擎开关、运行失败自动
fallback 或 `cutover_pending` 状态。缺少任一 Cloak runtime 前置条件时，Browser route 会以稳定
原因 fail closed，Public 与 Authorized API 路线仍按各自合同运行。

生产 Browser route 只有 `browser:generic`。只有 `[browser].enabled = true`、`model` 引用一个
`image = true` 的已就绪 Model、`profile` 已选择且固定 identity manifest 安全就绪、CloakBrowser
wrapper、Playwright API、经签名核实的目标 binary 版本和 headed display（Linux 上
为 Xvfb）都就绪时，生产 Bootstrap 才会创建可执行 Browser adapter。`sciretriever config status`
只检查这些本地静态事实，不启动 Browser、不读取 Profile 内容，也不会断言已登录；显式 probe
每次只能选择一个当前 eligible 目标：

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

启用 Browser 后，九家都可以成为显式 probe 目标；probe 只使用对应 Profile 的已核实首页与
deny-all capture guard，检查 Cloak runtime、固定身份和目标可达性。它不调用 Browser Model，
不使用 Publisher 页面规则，不下载文章 PDF，也不评估 Profile 是否已登录、当前机构 IP 或任意
文章 entitlement；`config test --all` 不会隐式启动 Browser。
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
场景覆盖准入页面发起的外部 JavaScript、受限 Cloudflare iframe/resource、未批准第三方 tracker 在
DNS 前丢弃、自动 challenge clear、人工控件、settle timeout、普通 response/direct PDF、点击或
页面脚本触发的跨 origin `3xx`、CDN PDF、HTTP attachment、通用 PDF 发现、native Chromium
download、TLS/DNS/IP binding、固定身份 Profile 三次冷启动、一个 process/context、通用 session
reuse 与文章级隔离、临时下载工作区清理、取消/超时和无残留资源清理。Playwright API 与
CloakBrowser wrapper 是 wheel dependency；定制 Chromium binary 由用户显式安装并独立核实版本，
不进入 wheel。离线 QA 使用通用 `browser:generic`、真实 Playwright API、真实 patched Chromium、
本地 HTTPS、fake Model 与多种页面 fixture 验收稳定 Observation、六种动作、popup/viewer/capture、
错误文章与 supplement 拒绝以及 cleanup；这证明安装产物与对象图接线，不等于当前 IP、真实机构
协议、任意站点页面策略或具体文章已在线授权。

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
pnpm install --frozen-lockfile
pnpm quick
pnpm full
```

按项目 owner 于 2026-09-10 的决定，后续默认验收和 CI 采用 TypeScript：Quick 执行 Prettier、ESLint 与 strict 类型检查；Full 追加全部 Vitest 和构建。Python Harness 仅保留为明确要求时使用的历史维护入口，不再默认运行。精确合同见 [`HARNESS.md`](HARNESS.md)。

## 项目文档

- [当前用户指南](docs/guides/README.md)
- [配置手册](docs/guides/configuration.md)
- [安装指南](docs/guides/installation.md)
- [升级与恢复](docs/guides/upgrade.md)
- [切换与回退](docs/guides/cutover.md)
- [产品需求](docs/architecture/requirements.md)
- [架构与设计](docs/architecture/README.md)
- [开发手册](docs/development/README.md)
- [活动提案](docs/proposals/README.md)
- [历史归档](docs/archive/)
