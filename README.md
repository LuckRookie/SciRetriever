# SciRetriever

[![Node](https://img.shields.io/badge/Node-22.19.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Package](https://img.shields.io/badge/package-0.1.0-2F855A)](package.json)
[![CI](https://img.shields.io/badge/CI-quick%20%2B%20full-1F6FEB)](.github/workflows/ci.yml)

## 产品定位

SciRetriever 是科研 Agent 的论文知识组件，目标是独立提供可追溯的原始材料与有证据的压缩知识，并支持检索、按需阅读和证据展开。人类也是正式使用者：配置项目，观看/指导 AI 的浏览器获取，查询阅读材料和总结。具体人类界面形态尚未确定，Zotero 深度集成与完整文献管理体验暂降优先级。

新增的通用提取目标允许外部 Agent/程序按自定义记录规范使用材料、证据与结果交付能力；领域算法和最终数据集由下游负责，见 [ADR 0027](docs/architecture/decisions/0027-extraction-capabilities-and-caller-defined-records.md)。当前已提供 v1–v5 Catalog 的只读规范/输入准备，以及 v5 Catalog 上的显式候选批次提交、回执和材料/文档引用保护；候选历史 payload 不托管，科学接纳仍归下游。入口、期限和限制见[独立文献库阅读](docs/guides/library-query.md#候选批次交付catalog-v5-维护)。

统一逻辑文献库仍保存身份、来源、材料和产物，保持领域中立、不可变资产及分阶段提交。反应、分子、路线、产率、材料性质等领域 schema 的含义与维护属于调用方；提取候选不成为文献固定领域字段。已接受目标见[产品需求](docs/architecture/requirements.md)、[设计](docs/architecture/design.md)与[ADR 0026](docs/architecture/decisions/0026-agent-knowledge-and-human-collaboration.md)。

**当前实现边界：** 已有发现/获取、解析、旧单篇总结、查询、配置和工作台基础；文档固定版本证据、已有材料的预算 Context，以及单篇与集合知识产物的显式分析/综合、历史发布和按 ID 阅读已交付。Catalog v8 已提供需显式构建的知识检索索引及材料/生成知识混合 Context；检索分数不是科学置信度，真实语料检索质量尚未评估。MCP stdio 和已有材料的持久加工任务已接入，见[Agent 接口指南](docs/guides/agent-interface.md)；完整生产人类协作仍有独立验收边界。当前 TypeScript 生产 completion 遇 `NoUsableContent` 保留已接纳材料，不再自动清理或重取；旧明确失效服务仍存在。本文下面的命令描述当前行为，完整差距见 [TS 基线](docs/architecture/typescript-baseline.md)。

开发者可以从[供应商适配目录](apps/server/src/providers/README.md)查找各家的定义、元数据与 PDF 实现；业务模块和共享网络责任见[技术文档](docs/architecture/technical.md)。

## 项目目录地图

每个由项目维护的目录都有自己的 `README.md`，说明职责、内容入口和相邻目录的分工。从下面进入，再沿各级 README 找到具体模块。目录说明帮助定位；需求、架构决定和当前行为分别由各自真相源维护。

| 目录                                          | 负责的内容                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [apps/](apps/README.md)                       | 应用实现：核心服务、CLI/MCP/HTTP 与 Web 界面                                              |
| [apps/server/src/](apps/server/src/README.md) | 按业务职责划分的服务端模块地图                                                            |
| [apps/web/](apps/web/README.md)               | 页面、样式、交互与界面回归                                                                |
| [packages/](packages/README.md)               | 跨模块、跨应用共享的中性合同包                                                            |
| [docs/](docs/README.md)                       | 需求、架构、使用指南、维护说明、提案与计划                                                |
| [tests/](tests/README.md)                     | 随仓库分发的共享合成测试材料；正式回归在各模块的 `test/`                                  |
| `sandbox/`                                    | 本机真实测试场地：`cases/` 用例、`runs/` 运行材料、`reports/` 报告；整个目录不随 Git 分发 |
| [scripts/](scripts/README.md)                 | 可复用的构建与打包工具                                                                    |
| [release/](release/README.md)                 | 构建工具使用的发布运行清单                                                                |
| [example/](example/README.md)                 | 可共享的配置示例                                                                          |
| [migration/](migration/README.md)             | 迁移兼容清单、固定 oracle 与历史证据；部分清单仍由测试消费                                |
| [.github/](.github/README.md)                 | GitHub CI 工作流                                                                          |

### 要做什么，去哪里

| 工作                                            | 起点                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 增加或修复一家文献供应商                        | [providers/](apps/server/src/providers/README.md)，定义与协议放在对应供应商目录                                                                                           |
| 调整发现或批量 PDF 获取流程                     | [entry/](apps/server/src/entry/README.md)；元数据能力看 [metadata/](apps/server/src/metadata/README.md)，PDF 接纳看 [acquisition/](apps/server/src/acquisition/README.md) |
| 修改 Browser Agent 的观察、动作、等待或下载捕获 | [browser/](apps/server/src/browser/README.md)；共享网络与冷却看 [network/](apps/server/src/network/README.md)                                                             |
| 修改解析、总结或知识查询                        | [parsing/](apps/server/src/parsing/README.md)、[analysis/](apps/server/src/analysis/README.md)、[retrieval/](apps/server/src/retrieval/README.md)                         |
| 修改统一数据格式、身份或存储                    | [contracts/](packages/contracts/README.md)、[literature/](apps/server/src/literature/README.md)、[storage/](apps/server/src/storage/README.md)                            |
| 做真实测试、保存日志和整理结果                  | 本机 `sandbox/`；约定见[测试目录说明](tests/README.md#本地真实测试)                                                                                                       |
| 给 bug 补可重复回归                             | 对应应用或包的 `test/`；共享合成输入放 [tests/fixtures/](tests/fixtures/README.md)                                                                                        |
| 讨论设计、执行计划或维护长期说明                | [proposals/](docs/proposals/README.md)、[plans/](docs/plans/README.md)、[notes/](docs/notes/README.md)；接受的长期决定归 [ADR](docs/architecture/decisions/README.md)     |

根目录的 [AGENTS.md](AGENTS.md) 是项目约束入口，[HARNESS.md](HARNESS.md) 是工程与验收规则；[package.json](package.json) 定义开发命令，`pnpm-workspace.yaml` 与 `tsconfig*.json` 定义 workspace 和编译范围。

本机可能还保留 `archive/`（退役代码快照）、`work/`（早期工作材料）、`.agent-teams/`（工具状态）和 `.vscode/`（编辑器配置）；这些目录的说明只保存在本机。它们不作为新业务源码或新测试的落点。`.git/`、`node_modules/`、`build/`、`dist/`、缓存、原始运行数据及历史快照内部由工具或原始材料结构决定，不逐层插入 README；其身份在所属上级目录说明。

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

同一文献库共用一个资产根目录。新文件按原始 PDF、解析正文/结构/资源、单篇总结和跨篇综合
分类保存，采用真实扩展名与 hash 前两位子目录；已有文件继续按 catalog 路径读取和复用。
具体目录与配置见[存储路径](docs/guides/configuration.md#paths)。

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

## 正式 Web 工作台

```bash
pnpm build
node apps/server/dist/cli/main.js web --port 4174
```

已安装入口为 `sciretriever web`。正式 Web 按定稿原型以文献库为首页，提供发现、检索、洞察、综合、提取、持久任务、Browser 会话、阅读标签和设置。首次启动直接可用：未配置的数据库与资产路径分别保存为 `~/.sciretriever/catalog.sqlite` 和 `~/.sciretriever/artifacts/`，缺库时创建完整空库；已有自定义路径优先。页面显示实际绑定，CLI/MCP 共享已保存配置。无需初始文献，不自动获取或升级已有库。可在设置中修改位置，重启后生效；不移动已有资料。操作与能力边界见[Web 文献库工作空间指南](docs/guides/web-workbench.md)。

## Browser 工作台预览

源码保留两个本地入口。静态交互样本用于快速查看布局与状态，不启动 Browser Host：

```bash
pnpm install --frozen-lockfile
pnpm preview:browser
```

打开 [静态样本](http://127.0.0.1:4173)，体验人工接管、模拟 PDF 获取、候选确认及失败场景。

实时工作台路径需要 operator 提供已校验的 Cloak bundle，并可构造真实 Browser Host、JPEG/SSE、持久 Candidate 与临时文献库：

```bash
SCIRETRIEVER_CLOAK_BUNDLE=/absolute/path/to/verified/cloak/bundle pnpm preview:workbench
```

固定版本 Cloak bundle 的本机回环测试已运行真实 `verifyInstalledCloakRuntime → new BrowserHost → start/openPage → deliver` 正路径；上面的预览命令仍使用合成页面，不是任意真实站点的验收证据。离线测试支持双 viewer、
接管/释放、PDF 捕获、accepted 发布、uncertain 放弃、文献搜索/详情/引用分页、任务创建/取消/执行，以及配置读取、
保存、冲突恢复、显式 Parse/Browser Model probe 和凭据 presence。工作空间、文献筛选/详情和任务详情使用非敏感 URL
参数恢复，浏览器后退/前进保持上下文；secret 不进入 URL、history 或 DOM。桌面与 390px 布局均由实际 Playwright DOM
旅程覆盖。入口使用新的系统临时 home，正常退出时清理，不读取用户 catalog、Profile 或凭据；配置、凭据和 readiness
由 TypeScript owner 直接组装。
运行依赖、支持边界和验证入口见 [web 工作台说明](apps/web/README.md)及
[TypeScript 开发入口](docs/development/typescript-foundation.md)。

## 独立只读文献阅读

正式阅读入口可通过 server TypeScript API `startQueryOnlyWorkbench({ home })` 单独启动，只提供文献搜索、详情、引用证据与已保存材料下载。它只读打开既有 Catalog；未初始化时明确提示并保持未创建，PDF/内容等缺口也不会自动启动获取、解析、生成或 Job。常规调用以 Node 用户 home（`homedir()`，与 CLI 同一固定配置身份）作为 home；Catalog 和 ArtifactStore 路径继续取自固定配置。完整 API 启动、就绪状态和关闭方式见[独立文献库阅读指南](docs/guides/library-query.md)。

正式任务工作台整合 Browser、持久任务、配置以及全部 query/maintenance 接口；它与 QueryApplication 的独立只读启动保持不同的授权范围。独立查询页已提供文献阅读、固定文档证据、材料和知识混合上下文、提取输入准备、v6 单篇知识和 v7 集合综合历史阅读；v5+ 候选提交、v6 单篇分析、v7 集合综合及 v8 知识索引重建可在正式工作台明确操作，也保留独立受控维护入口。Agent 可通过 `createQueryApplication(home).knowledgeContext.search` 混合检索，通过 `knowledgeRead` 按 ID、Literature 清单或默认指针读取单篇知识，也可通过 `synthesisPreparation/synthesisRead` 固定集合并按 ID、来源及最近清单只读访问综合。用法见[独立文献库阅读指南](docs/guides/library-query.md#知识与材料混合上下文catalog-v8)。

PDF 获取只验证实际文件可读取及任务关联，不在下载阶段按 DOI/标题/作者判断内容身份。
入库 PDF 显示“文章身份未验证”（`article_identity_status: "unverified"`），不阻断下载或后续解析。
Catalog v9 可显式核验固定解析文档，返回有证据的 `match-supported`、`conflict` 或 `insufficient-evidence`；输入变化后标签回到 `unverified`。解析成功本身不等于核验完成，判断也不阻断下载和加工，见[调用说明](docs/guides/agent-interface.md#解析后身份核验)。

手动 PDF 维护可通过 `startMaintenanceWorkbench({ home })` 单独启动，页面 `/` 接收用户明确选择的本机文件并传输原始 PDF 字节，`/query` 保持独立阅读视图；这一入口不启动 Browser，要求 home 已有 v2 catalog。公开 TypeScript `createApplication(home, { executionSchema: "require-v2" }).maintenance.ingestPdf({ literature_id, bytes })` 与 CLI `import pdf` 调用同一接纳用例。HTTP 上传和 TypeScript 字节入口均限制为 16 MiB；HTTP 只接受同源会话和 CSRF 授权，不接受远端请求提供本机路径。有效材料接纳后可通过独立 QueryApplication 读取；可执行 Node 启动示例见 [PDF 获取与手动接纳指南](docs/guides/pdf-acquisition.md)。

生产 Browser 观看与指导可通过 `startProductionWorkbench({ home, literature_id })` 启动。打开本机页面只建立观察入口，点击“获取这篇文献的 PDF”才进入同一 Application 的正式补全流程；自动模型与人工控制共用原文章 page，捕获仍由 Acquisition 验收。当前已用固定 Cloak bundle、fake 模型和回环站点验证 HTTP 接管到主 PDF 提交；完整反馈与阅读衔接留待 M04-T03，真实 Publisher 站点未验证。启动和控制语义见 [PDF 获取指南](docs/guides/pdf-acquisition.md#生产观看指导和接管)。

## 命令行入口

目标命令合同的六个一级名称是 `discover`、`complete`、`literature`、`import`、`export`、`config`
（见 [任务与协作控制：数据库补全与阶段协调](docs/architecture/technical/02-task-coordination.md#4-数据库补全与阶段协调) 与
[技术文档](docs/architecture/technical.md)）：

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
sciretriever config test ...
```

显式 `sciretriever document parse --literature-id ID --asset-id ID --asset-sha256 SHA256 --mode reuse-current|reparse` 将已接纳的主 PDF 发布为固定版本的可读表示。此命令要求已显式迁移的 v3 Catalog；复用模式不调用 Parser，重解析模式使用当前配置的 ParserBackend。默认关系切换需要可选 `--expected-default-revision`，回执分别报告版本发布与 CAS 结果。只读 TS/HTTP 和文献库页面现可按固定版本有界阅读目录、片段和资源，并复核原始文件或文档片段证据；原始 PDF 文件证据也支持旧 v1/v2 Catalog。用法与能力缺口见[解析与发布文档版本](docs/guides/document-processing.md)和[独立文献库阅读](docs/guides/library-query.md)。

当前实现还额外提供以下**内部/operator 入口**，它们不属于上述六个一级名称的目标合同，也没有
进入目标命令树（`apps/server/src/cli/main.ts` 的解析与直接测试覆盖其参数校验）：

```text
sciretriever storage inspect|migrate|backup|restore-check
sciretriever storage schema-inspect|schema-init --catalog PATH
sciretriever storage schema-upgrade --catalog PATH [--dry-run | --backup PATH]
sciretriever storage document-inspect|document-migrate --catalog PATH
sciretriever doctor
sciretriever jobs create|run
```

`jobs create/run` 是当前 durable-job 调试/实验入口（`application/jobs` 之上），其目标合同归属
（纳入或移出六个一级名称）仍待 owner 决定，见
[迁移计划 T047/T048](docs/archive/2026-09-07-typescript-browser-workbench/full-migration-roadmap.md)；
正式 `storage schema-init` 在精确不存在目标创建 v9，`schema-upgrade` 在精确 v1–v8 目标和同目录未存在备份上显式升级；inspect/dry-run 只读，普通启动不升级。整链持业务写锁，每步独立事务，失败报告实际中间版本并保留原始备份；操作前先停写，恢复须保全资产和切换后增量，见[初始化、升级与恢复](docs/guides/upgrade.md)。工具能力不授权代理执行真实数据迁移。
历史 `storage migrate` 仍只允许对合成副本执行。
文档 Catalog v3 的独立合成迁移入口见[文档 Catalog 迁移指南](docs/guides/document-catalog-migration.md)。

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

| 退出码 | 含义                                                                                                      |
| -----: | --------------------------------------------------------------------------------------------------------- |
|    `0` | 正常到达操作边界；包括全部目标成功、局部目标失败和全部目标失败，逐目标结果以本次命令的 JSON 输出为准      |
|    `2` | 命令输入或 usage 错误                                                                                     |
|    `3` | 操作级业务失败（如导出、书目写入或 `literature show` 目标不存在）；不表示一个正常结束的批次中存在失败目标 |
|    `4` | 配置或生产 Bootstrap readiness 失败                                                                       |
|   `70` | 操作系统或系统级 I/O 失败                                                                                 |
|  `130` | 受控中断                                                                                                  |

**当前实际输出：** `complete pdf|content --json` 返回统一的 `DatabaseCompletionReport`，包含
`completed`、`failed`、`skipped`、`notStarted`、`interrupted` 五个互斥分区和 `end`。
`end.kind` 为 `finished`、`interrupted` 或带稳定 failure 的 `failed`。CLI 不自行维护目标循环：
Application 构造的 `DatabaseCompletionService` 服务 CLI；durable Jobs 复用同一个
`DatabaseCompletionTargetRunner`，同时保留逐 target/attempt/event 的持久语义。目标进度以脱敏 JSON
行写入 stderr，最终完整报告写入 stdout。空 selector 也返回合法的空五分区报告，而不是旧的
`{ goal, items }` 过渡对象。

`DatabaseCompletionReport` 是当前实现的稳定程序结果。自动化应读取五个分区和 `end`，不能把
单一退出码解释成“每篇都成功”：`0` 表示操作到达正常边界，仍可能包含逐目标 `failed` 或
`skipped`；报告级 `failed` 返回 `3`，受控中断返回 `130`。参数解析失败返回 `2`，配置或
生产 Bootstrap readiness 失败返回 `4`，系统级 I/O 失败返回 `70`（实现见
`apps/server/src/cli/main.ts`）。

## 发现与补全是两类操作

`discover topic` 和 `discover citations` 负责有边界的外部发现。它们接纳文献身份、保留来源 observation、去重，并记录 DiscoveryRun、来源结果和直接原因；不会顺带下载 PDF、解析内容、运行分析，也不会对每篇文献逐一调用全部 Provider 做二次补查。

引用扩展对每个节点按优先级尝试来源：Auto 在已启用集合内优先使用配置了凭据的 API，再使用无需密钥的 API；Custom 保留用户指定的顺序。当前来源分页正常结束、返回可用关系且目标均可识别时停止查询该节点的后续来源；空结果、记录错误、分页失败或未识别目标继续顺延。尚未识别的引用目标可通过后续来源按共同稳定标识补查，供应商私有 ID 不跨来源使用。404 或单条坏记录不阻断其他目标及下一层节点；鉴权失败、拒绝访问和限流只暂停受影响来源，其他已选来源继续。取消、数量边界及存储错误仍保留停止语义。

两层引用扩展会在边界内遍历第一层接纳的各篇文献，结果按文献身份去重且不重复计入种子。存在来源失败且已取得结果时报告 `PARTIAL`，不能把中途结果称为完整两层规模；来源结果只列实际尝试过的来源，不把因优先来源成功而未调用的来源标记为已扫描完。API 覆盖之外的参考文献不会自动通过网页或 PDF 提取补齐。

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

实际目标集合在当前维护操作或 durable Job 中冻结；重跑会重新读取 current facts，从第一个缺失步骤继续。普通范围按 MetaLiterature 去重，并默认只补一个可用 Literature 版本；仅明确的自动 PDF 正常耗尽可支持跨版本尝试。`NoUsableContent`、网络、存储、Parser、LLM 失败，取消或无法判断的结果都不触发跨版本，已接纳材料不会因分析失败被撤销。

## 本地导入、查询与导出

书目信息交换支持三个格式值：`bibtex`、`ris` 和 `csl-json`；其中 `bibtex` codec 同时覆盖 BibTeX 与 BibLaTeX。导入结果区分 `created`、`enriched`、`matched` 和 `rejected`，完全重复的记录不会复制 observation。即使文献还只有元数据，也可以从数据库导出书目信息。

`literature search`、`show`、`references` 和 `cited-by` 都是纯本地、只读操作；它们不会访问 Provider、创建 DiscoveryRun 或写入数据库事实。`literature references --reference-id ...` 可进一步读取一条 ReferenceDetail。

手动 PDF 使用：

```bash
pnpm sciretriever import pdf LITERATURE_ID input.pdf --json
```

该命令要求选择已经存在的具体 Literature。SciRetriever 复制而不移动用户文件，并在内部副本上检查实际 PDF 字节、标准 reader 和页面树；不会保存用户文件的绝对路径，也不会修改或删除原文件。若已有主 PDF，导入会拒绝而不是静默替换。成功只达到 `ASSET_READY`，不会隐式运行 Parsing 或 Analysis；同时会清除该 Literature 先前的自动获取耗尽事实。

CLI、公开 TS `maintenance.ingestPdf` 和本机维护页使用同一接纳规则。错文章或证据不足时按既有保守身份合同拒绝发布；分析后的内容不足不会推翻已经验收的 PDF。独立维护页入口与上传限制见 [PDF 获取指南](docs/guides/pdf-acquisition.md)。

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

未知组和未知字段会 fail closed。生产命令只读取固定的
`~/.sciretriever/config.toml`；CLI 不提供 `--config`，也不读取配置路径环境变量或当前目录
`config.toml`。内部测试可以注入临时 `home` 进行隔离，但该 seam 不改变生产配置身份。裸
`sciretriever config` 在第一次确认修改时创建并继续管理该文件，直接编辑也受支持。完整字段、
权限和人工迁移说明见[配置手册](docs/guides/configuration.md)。真实路径、Provider 选择、个人
运行参数和用户配置文件都不应提交到仓库。

旧的当前目录配置或旧环境变量曾指向的文件不会被自动读取、复制、移动或删除。迁移时先确认
`~/.sciretriever/config.toml` 不存在；若已存在，应人工比较并合并，不能直接覆盖。迁移完成后
把 `~/.sciretriever/` 设为 `0700`、两个 TOML 文件设为 `0600`。

文献 Provider、Model Provider 与远程 MinerU 的 secret 与普通配置分离，统一固定保存在
`~/.sciretriever/credentials.toml`。其目录必须是当前用户拥有、权限为 `0700` 的普通
非符号链接目录；文件必须是当前用户拥有、权限为 `0600` 的普通非符号链接文件。

- 裸运行 `config` 打开统一交互中心，首页固定为 `Models`、`Search`、`Download`、`Parse`、`Analyze`、`Browser`、`Status`、`Theme` 与 `Quit`。首页和 Status 都只读取本地状态，不会因为打开页面而联网。Models 页面可新增或修改 Provider、设置隐藏 API key、新增 Model，并为 Analyze/Browser 选择 Model；Search/Download 页面编辑 Auto/Custom Source 集合和 Search limit；Parse、Analyze、Browser 页面编辑各自的普通配置。
- 本机 Web 配置工作空间支持 Source Auto/Custom、来源参数、Provider/Model 注册及 Analyze/Browser 模型选择；分区保存保留其它草稿，冲突不覆盖已保存值。普通配置影响已运行工作台时明确提示重启；已组装能力在新外部请求前重新授权凭据。启动时缺凭据而未组装的能力，补齐后需重启重新组装。高级配置仍可使用 CLI 配置中心或固定 TOML，详见[配置手册](docs/guides/configuration.md)。
- TTY 界面使用 ANSI Rich 风格的 Panel/Table 渲染与 `@inquirer/prompts` 交互，支持方向键、Enter、确认、隐藏输入和 `auto/dark/light/mono` 主题；`NO_COLOR` 强制单色。保存普通配置前会显示 Before/After 差异，确认后通过 TypeScript Configuration Owner 校验并原子发布；凭据始终走同一 owner 的 credential 接口，界面不回显 secret。TTY 交互写 stderr；重定向输入使用确定性的纯文本状态页和 `M/S/D/P/A/B/I/T/Q` 菜单。
- `config status` 是纯本地检查，不联网；默认 Panel/Table 显示当前区域、选择摘要、凭据 presence 和 readiness，并明确标出不会联网或启动 Browser。`--json` 保留机器可解析的原始结果。输出绝不显示 secret、mask、长度、hash 或 fingerprint。
- `config status` 是纯本地 readiness 检查，不联网。`config test` 在用户显式确认（或使用 `--json` 的脚本调用）后，通过一个共享 Probe dispatcher 执行有界、只读的最小验证；Provider、Model、Search、Parse、Analyze 会在授权且 adapter 可用时进行一次受控请求。
- Download 没有安全的 Literature-independent probe，稳定返回 `acquisition-probe-unavailable`；Browser Site 只有显式提供 `browser_site` seam/adapter 时才会运行，否则稳定返回 `browser-site-probe-unavailable`。Probe 结果明确给出 `network_performed`、`browser_launched`、`persisted=false` 和 entitlement `not-proven`。
- 配置诊断不得创建 Catalog、DiscoveryRun、Literature、Asset、Entry Report 或测试历史，也不得输出 Key、query、header、响应正文、供应商任意 message 或原始异常。真实 Provider、站点和 Browser runtime 仍需单独授权，离线 unavailable 不能解释为通过。

三项核心处理能力的配置入口与验证是：

| 能力               | 在裸 `config` 中的配置路径                                                                    | 显式验证                                                                                                                                | 本地 ready 还要求                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 文献分析与总结     | `Models → Add` 配置 Model；`Models → Providers` 管理 Provider/Key；`Analyze → Setup` 选择模型 | `config test analyze` 执行一次有界 Model probe；真实内容仍走 `complete content`                                                         | 所选 Model、其 Model Provider 与 exact-origin credential 完整；strict structured output 由模块派生                                       |
| Browser Agent 下载 | `Models → Add` 配置 `image = true` 的 Model；`Browser → Setup` 选择模型和 Profile             | Browser Model probe 可执行；Browser Site 需要显式 site adapter/seam；生产 `complete pdf` 仍受 verified runtime/admission 与真实环境约束 | 所选 image Model、其 Provider/Key、Agent controller、Browser identity Profile、CloakBrowser/Playwright/binary 与 headed display 全部就绪 |
| MinerU 解析        | `Parse → Setup`                                                                               | `config test parse` 使用有界 MinerU health probe；真实 PDF 解析仍走 `complete content`                                                  | endpoint、部署身份，以及 remote 模式的上传授权与 origin-bound token                                                                      |

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

三种 LLM API 都默认发送 `stream = true`。Agents 在内部把有界 SSE 重建为完整模型结果；Analysis 保留 structured
result／单工具的兼容入口，Browser 内部保留文本、工具调用 ID 和对应结果；具体 Model 可以设置 `stream = false`，此时只请求和解析非流式 JSON。
Analyze/Browser 只继承所选 Model，不会收到事件流、覆盖 stream，或在失败后触发另一种模式的重发。

模型调用与持续 Agent 会话统一由进程内 DSH/Cordis 底座执行。DSH 是唯一启用的默认 Agents 后端，无需另行配置后端开关；原内置执行后端不再提供，DSH 失败也不会回退到旧实现。分析、综合、身份核验和模型 probe 的既有结构化请求也进入原生 DSH 模型服务；通用会话支持纯文本、多图、工具反馈与上下文管理。Browser 每篇文章保留独立上下文，显式选择最新截图策略；人工操作和下载失败恢复进入同一会话。Browser owner 仍强制页面/控制版本、动作节奏和文章预算，下载与入库由原 Acquisition/Entry 完成。模型、凭据和 Network 沿用项目配置，不读取本机其它 Agent 的 profile。关闭底座会取消并等待调用及会话释放，不承诺跨进程恢复。此次统一执行基础保留现有分析算法，尚不能据此宣称科研内容质量全面提升。详见 [Agents 模块](apps/server/src/agents/README.md) 与 [DSH 依赖说明](docs/notes/deepseek-harness.md)。

自动 PDF 获取按“公开来源 → 授权 Provider API → 受控浏览器”逐层升级。公开文献优先直接下载：
arXiv 使用 PDF URL，成功后不启动 Browser 或调用 Browser 模型。当前 Auto 公开阶段包含已保存 PDF
直链、arXiv、Europe PMC 的 PMCID 下载及 DOI landing 的静态 PDF 解析；重定向后的相对链接以实际
落地页为基准，CDN 请求仍经过 Network 检查。下载阶段检查 PDF 文件有效性及任务/来源关联，
不以正文 DOI、标题或版本判断文章身份；已接纳 PDF 标注为文章身份未验证。Browser Agent 主要用于剩余出版社文章，通过当前网络出口、机构 IP 和浏览器会话
完成页面操作；实际导航保留合法查询参数，观察 URL 去除 query，顶层 PDF 通过 Chromium 原生下载交付。

当前生产 Application 已通过 Entry 接入惰性 Browser host factory、Network admission、统一 Article flow/Intake 和文件验收：一个有界 cohort 先完成 Public 波次，再让未解决目标进入 Authorized API 波次，最后才把最小剩余集合交给 Application 共享的 Browser 调度器。调度器保留文章会话，以两个独立 worker 推进不同平台；同平台网络活动限一篇，网络真实结束后冷却 30 秒，模型调用继续服从共享并发预算。locator routes 正常耗尽，或 route 自己显式声明 `not-applicable`/`no-capability`/`http-route-unavailable` 且 Browser 独立 admitted 时，才允许进入 Browser；有效 landing HTML 没有静态 PDF 属于正常未命中；公共 HTTP 的 403、静态链接不能交付 PDF 或明确的重定向上限，在无 Retry-After 等限流反馈时允许后续独立路线评估访问能力。Browser 中的明确拒绝、401、timeout、临时网络错误、429、quota、deferred、system、storage、cancel 等仍保持失败。固定 Cloak bundle 的本机回环已验证完整 PDF 接纳，具体出版社文章权限需逐次验证。Unpaywall 需要在 Custom 中配置联系
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
冒充主 PDF。Springer 当前全文 API 产品返回 JATS/XML，不是主 PDF API。Controlled Browser 的生产路线只有一条 `browser:generic` route。它在 locator 正常耗尽或显式低风险 route unavailability 且具有安全 canonical landing 时接收仍缺 PDF 的文献；无需匹配 Publisher 点击规则或预设站点。当前 Entry/Application 已接入这条有界 escalation，并以 Application 共享的 `BrowserSessionBroker` 与文章调度器管理 Browser host、会话和平台资格。用户选择并初始化
一个持久 Browser Profile、显式启用 Browser，并配置 `image = true` 的 Model 与本地 runtime 后，
唯一 `AgentBrowserController` 根据稳定页面 Observation 选择封闭动作。总开关、Profile 存在或
其中保存了浏览器状态都不证明组织合同、登录成功或具体文章有权限，operator 仍须确保实际使用
符合组织授权和站点条款。

目标编排要求同一批目标先完成 Public cohort，再只对剩余目标执行 Authorized API cohort，最后才进入 Browser cohort；低风险路线发生 timeout、临时网络错误、`429`、quota 或 `Retry-After` 时不得借机绕过限制。当前实现已经按这个顺序形成三级屏障，逐波按冻结顺序提前交付终态 receipt。Browser 调度区分决策 worker、保留会话和平台网络资格；后台下载及本地验收/发布不占决策 worker，其它文章可以继续推进。默认两个决策 worker、五个保留会话，同平台真实网络结束后冷却 30 秒；每次动作结束到下一轮模型派发至少 5 秒。实际 Cloak 的并行、大文件和真实站点验证分别记录在本轮验证记录（本地文件：`sandbox/reports/browser-parallel-validation-2026-10-05.md`，不随仓库分发），外部可达性和权限以具体样本为准。

（目标合同·当前未实现）Browser 升级前，正常日志应显示剩余篇数、`browser-generic` 的
`minimum_start_interval`、`next_allowed_in_seconds` 和保守 `minimum_duration_seconds`，仍不包含
无法预知的网络、页面渲染或服务等待时间。Agent 从第一次统一 Observation 起在元素点击、坐标
点击、surface 滚动、后退、等待变化和停止六种封闭动作中选择。若统一 Observation 标为 `CHALLENGE`，Agent
只点击截图或元素中可见的 `Verify`、`I'm human`、`Continue` 控件，随后用 `WaitForChange` 重新观察；不使用
selector、脚本、solver 或验证 token。Controller 只执行
`start → decide → apply`；Network 在每次返回前把
当前 article Page/frame/popup/viewer 收敛成语义 quiet 的可操作 Observation，只把 `Ready / Captured /
Blocked / Failed / Cancelled` 交给 Acquisition；相同页面语义下重复同一动作会形成
`browser-challenge-no-progress`，不会继续重复点击。页面交接期间不会把半加载界面交给 Agent。第一次
self-transition 反馈给下一轮，
重复 self edge 或 `A → B → A` 已知边才停止，可能的下载 Candidate 必须 captured、cleared 或 timeout。
Challenge 只是目标页面状态，并分别保留 Agent Stop、self、cycle、Candidate timeout 与 resource
blocked 结果；当前文章会话使用 100 次 Agent 动作、50 次真实模型派发和 300 秒累计活跃时间，
推理、动作和主动页面反馈等待共用这一预算；人工控制、排队、下载及本地验收/发布暂停计时。
达到上限只形成稳定 Browser failure，不写入获取耗尽。真实验证页和拒绝访问的观察结果见上述记录；进入验证页不等于已证明没有访问权。
第一版仍不提供交互式 Browser 登录、机构选择、
账号/密码输入、MFA、外部 CAPTCHA solver 或 token 注入；登录/MFA/账号警告和 cleanup failure
会以稳定原因进入本次报告。已提交的其它 Provider 结果不会回滚。Ctrl+C 形成受控中断，重跑会
重新读取数据库 current facts，只补仍缺失的步骤。

Controlled Browser 使用一个 operator-managed 持久 Profile，并在首次初始化时把 native Linux
persona、locale、timezone、screen、Browser version policy 和 fingerprint seed 固化到 owner-only
identity manifest。同一 Profile 冷启动时复用同一设备身份；seed、Profile 路径和浏览器状态不会
进入普通配置、日志、Report 或文献数据库。生产 Application 已拥有惰性 host factory、Network
navigation admission 和唯一 `browser:generic` escalation；完整生产对象图仍要求一个
`headless = false` 的 CloakBrowser patched Chromium process/context、共享 scheduler/session broker
和每篇文章隔离 page/handler/临时下载目录。固定 Cloak bundle 的回环测试已验证真实启动与 PDF 接纳；
仅使用离线 seam 的测试仍只证明接线。
对象图关闭后 process/context 与临时下载工作区应清理，Profile 中由 Chromium 管理的状态跨命令保留。
无 GUI Linux 使用 Xvfb；出版社请求继续由 Chromium 原生完成 TLS、HTTP、Cookie、redirect、页面点击
和下载。本机 loopback CONNECT proxy 只把已审核 hostname/port 固定到 Network 批准的精确 IP，并透传
加密字节，不终止 TLS，也不以 Python HTTP 替代浏览器网络栈。

`sciretriever config` 的 `Browser → Runtime` 用于显式安装、更新或回退经核实的 CloakBrowser
binary；`Browser → Setup/Profiles` 用于选择 Agent Model、初始化一个不含敏感信息的固定身份
Profile、删除本地 Profile、禁用自动 Browser 或调整本机资源 cap。普通 Completion 不隐式下载
binary，当前 TypeScript portable package 也不嵌入 vendor binary。历史 wheel 说法仅属于迁移材料。
installer 只在该显式动作中保留并验证本次实际 archive：Ed25519 签名、manifest
version、仓库固定 SHA-256 与 archive 实际 SHA-256 必须同时一致后才会发布。普通
Browser 运行使用每次 lease 创建的无凭据临时 cache view，vendor 只能看见已验证的
固定 v146 bundle，不会读取长期 runtime root 中的 license/Pro/update 状态。当前
older-free v146 不消费 CloakBrowser license；已保留的凭据 section 在 status 中明确显示为
`reserved-not-used-by-pinned-free-binary`。
SciRetriever 不提供 Cookie 导入导出或人工登录窗口，不填写账号/密码、不选择机构、不读取 Cookie
或登录结果，也不处理 MFA、注入 CAPTCHA solver/token 或切换身份/出口；目标合同允许唯一 Agent
controller 在相同封闭页面动作内处理可见 Challenge，但当前真实 Challenge/blocked/denied 正路径仍是
未运行残余。同一 Profile 同时只能由一个 Browser process 使用。

按目标合同，CloakBrowser 是普通 Acquisition 与显式 `config test browser site` 唯一的生产 Browser runtime；当前 Application 惰性组装 host factory，固定 bundle 的回环正路径已验证，真实站点仍受授权和具体环境限制。Playwright 只作为 CloakBrowser context 的内部控制 API。源码不再发现或启动 Playwright bundled Chromium、系统 Chrome 或其它 stock runtime，也没有用户可选或隐藏的双引擎开关、运行失败自动 fallback 或 `cutover_pending` 状态。缺少任一 Cloak runtime 前置条件时，Browser route 会以稳定原因 fail closed，Public 与 Authorized API 路线仍按各自合同运行。

目标生产 Browser route 只有 `browser:generic`。只有 `[browser].enabled = true`、`model` 引用一个
`image = true` 的已就绪 Model、`profile` 已选择且固定 identity manifest 安全就绪、CloakBrowser
wrapper、Playwright API、经签名核实的目标 binary 版本和 headed display（Linux 上
为 Xvfb）都就绪时，生产 Bootstrap 才会把 Browser capability 标为可用；缺 verified runtime 或
Network navigation admission 时，`browserHost()` 和 route 都稳定不可用。`sciretriever config status`
只检查这些本地静态事实，不启动 Browser、不读取 Profile 内容，也不会断言已登录；显式 Browser Site probe 的目标合同如下：

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

目标合同规定，启用 Browser 且 runtime 就绪后，九家都可以成为显式 probe 目标；probe 只使用对应 Profile 的已核实首页与 deny-all capture guard，检查 Cloak runtime、固定身份和目标可达性。当前 CLI 已能通过统一 Probe dispatcher 接受显式 Browser Site adapter/seam；没有该 seam 或 verified runtime 时返回稳定 `browser-site-probe-unavailable`，不伪造通过。它不调用 Browser Model，不使用 Publisher 页面规则，不下载文章 PDF，也不评估 Profile 是否已登录、当前机构 IP 或任意文章 entitlement；`config test --all` 不会隐式启动 Browser。
支持矩阵、等待语义、状态检查和故障处理详见
[PDF 获取指南](docs/guides/pdf-acquisition.md)。限速只能降低风险，不能保证账号不会被限制；
用户仍须遵守自己的访问授权和站点规则。

外部命令只有在 adapter、普通参数、凭据、AccessPolicy 和所需外部服务全部就绪时才会发起调用。缺少任一条件时，生产 Bootstrap 会在创建 Storage 之前稳定 fail closed，例如返回 `metadata-not-ready`、`acquisition-not-ready`、`parser-not-ready` 或 `analysis-not-ready`；这类结果表示当前运行环境尚未就绪，不表示控制流会静默降级。

## 当前验收边界

历史迁移证据、当前 TS 机械门禁和真实外部环境证据不能互相替代：

### 历史迁移验收（非当前 TS 发布门禁）

旧 wheel/虚拟环境 A 层曾用于迁移阶段的安装产物、console 和离线对象图验证。它属于历史证据，不应被解释为当前 TS 生产 Browser、真实 Provider 或真实 Catalog 已验收；当前质量入口以 `pnpm quick`、`pnpm test`、`pnpm full` 和直接测试为准。

迁移阶段的离线 resolver/transport、fake Provider、loopback MinerU 和组件级 Browser fixture 只证明受控 Port、适配器和安全边界；它们不证明真实 Provider、Parser、LLM、Browser 站点或生产 Catalog 已在线成功，也不替代当前 TS Full。

### 历史深度合同与受控协议 QA

迁移阶段曾在公开 Port 注入 fake，以驱动中断、失败、版本组合、解析和分析边界；这些证据可以作为设计合同的历史参考，但当前生产代码是否满足五分区 Report、统一 Entry 和 Browser route，必须重新以当前 TypeScript 源码与直接测试证明。

MinerU loopback QA 只验证受控 `health → submit → poll → archive` 协议边界，不代表 operator 的真实 MinerU 部署已经在线验证。
Browser 组件、workbench fixture 和离线 host seam 证明 Observation、六种封闭动作、capture/cleanup、Network admission、版本化 delivery、Intake/身份验收和稳定拒绝的局部合同；固定 Cloak bundle 的回环测试另证明真实 runtime 正路径与同页人工协作接纳。它们不证明任意站点、机构 IP、真实凭据或具体文章 entitlement 已在线授权。缺少 `SCIRETRIEVER_CLOAK_BUNDLE` 时，依赖 Cloak 的测试应保留 `skipped`/`not-run` 证据。

任何验收都不得使用真实 Provider 在线调用、真实凭据、真实用户 PDF 或真实生产 Catalog，除非用户另行授权；离线绿色结果不能替代这些环境的授权和现场证据。

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

`tests/` 保存随仓库分发的共享合成测试材料，各模块的 `test/` 保存可重复运行的离线回归；本机真实测试、一次性脚本、运行材料和报告统一放在 Git 忽略的 `sandbox/`，不进入 CI 或 GitHub。目录约定见[测试目录与本地试验场](tests/README.md)。

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
- [历史归档](docs/archive)
