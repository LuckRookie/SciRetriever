# SciRetriever 技术文档索引

- 产品依据：[产品需求](requirements.md)
- 设计依据：[设计文档](design.md)
- 稳定原则：[架构原则](principles.md)
- 重要决策：[架构决策](decisions/README.md)

本文是 SciRetriever 目标技术设计的总入口。它只说明整体代码结构、模块依赖、生产组装和跨模块技术约束；每个模块的实现细节由 [`technical/`](technical/) 下对应文档独占说明。当前已发布行为仍以项目 `README`、源码和测试为准。

## 1. 阅读与维护方式

讨论或实现某个模块时，按以下顺序阅读：

1. 从[产品需求](requirements.md)确认对应 R1–R8 和用户可观察结果；
2. 从[架构决策索引](decisions/README.md)读取适用的 Accepted ADR；
3. 从[设计文档](design.md)确认模块责任、事实所有权和业务协作；
4. 从本文确认全局目录、依赖和组装边界；
5. 阅读对应模块技术文档，确定内部文件、Ports、适配器、持久化和验证方式。

模块技术文档只描述目标实现，不记录迁移进度、工作包或当前代码清单。目标设计、当前实现和迁移计划不得混写为同一种事实。

## 2. 全局技术形状

SciRetriever 使用按功能模块组织的 Python 模块化单体：

- Python 3.10+，开发基线 Python 3.12；
- 一个可安装的 `sciretriever` 包；
- 六个核心功能 package 和五个公用基础 package；
- 模块内部使用 Ports/Adapters 隔离外部能力，不建立项目级技术分层目录；
- `configuration/` 与 `bootstrap/` 分别是原运行配置与生产组装模块的 package 形态；各自
  `__init__.py` 提供稳定窄 public surface，其余同包文件按变化原因组织实现；
- 生产 Bootstrap 通过 Logging 模块公开 API 一次性配置 `sciretriever` 命名空间；日志走 stderr，稳定结果与 JSON 走 stdout；
- SQLite 保存关系事实、事务、当前关系和统一读取视图；
- 同一配置存储根下的文件系统保存不可变 PDF，以及只保留当前关系的可重建 ParserResult、结构化 `LiteratureContent` 和规范 Markdown；
- 一个主机、一个 catalog 同时只允许一个修改核心文献事实的执行；
- 查询和只读导出可以并行读取已经提交的事实；
- 不引入常驻 SciRetriever daemon、分布式 worker 或外部工作流平台。

SQLite 与文件系统组成一个逻辑文献数据库，但拥有不同物理责任。SQLite 不保存大型 BLOB；文件系统对象通过规范化相对路径与 SHA-256 关联到数据库事实。

这套逻辑文献数据库是运行中心，不是某次批量执行的输出附件。查询和只读导出直接读取一致 snapshot；会改变数据库的 Entry 操作把用户请求与当前 snapshot 组合成实际目标，复用已经有效的事实，只为缺失或明确失效的步骤调用外部能力；事实所有者验证结果后，Storage 才把新事实提交到 Catalog 与 ArtifactStore。新的 DiscoveryRun 和导入同样通过当前数据库完成身份命中、去重和接纳，不建立平行结果集合。

[ADR 0013](decisions/0013-decoupled-discovery-and-database-maintenance.md)进一步把持久化 DiscoveryRun 与进程内数据库补全操作分开，并删除没有当前产品需求的 Collection。外部发现结束于元数据入库，不自动开始 PDF 或内容处理；数据库补全可以从全库、历史发现、导入、查询或明确 ID 独立启动，只在当前进程内展开 selector、冻结目标与候选并形成 Report。普通范围按 MetaLiterature 去重，只有稳定缺失才跨版本回退。手动 PDF 是 Acquisition 的独立接纳操作，不属于自动三阶段。

网络、浏览器、Parser、LLM 和 vendor 调用在事务外发生，并以开始时读取的 ID/hash 绑定输入；提交前重新检查 current facts，过期结果拒绝写入。重启后重新读取当前数据库并重新选择实际目标，不恢复旧 HTTP 请求、浏览器页面、Parser/LLM task、线程、队列或内存现场。具体长期约束见 [ADR 0011](decisions/0011-literature-database-centered-incremental-maintenance.md)。

Provider 的目标能力集合、领域发现启用边界、Acquisition 证据路由以及本地凭据合同由 [ADR 0014](decisions/0014-capability-scoped-providers-and-local-credentials.md) 约束。Metadata 与 Acquisition 是两个不互斥的 Provider 能力，不建立第三类 Citation Provider；Provider、Agents 模型服务、可选 CloakBrowser Pro 与远程 MinerU 密钥只从 `~/.sciretriever/credentials.toml` 注入，核心服务 secret 与规范 origin 精确绑定，凭据状态与连接测试都不是文献数据库事实。

[ADR 0015](decisions/0015-publisher-aware-tiered-pdf-acquisition.md)进一步把原文访问方识别、运行时计划与执行分开。缺 PDF 目标按有界 cohort 严格执行 Public → Authorized API → Browser admission；API 按官方 quota policy，Browser 使用一个 operator-managed 持久身份 Profile 和一个共享 Browser process/context，并按 `browser_rate_limit_group` 不同组并行、同组限速串行。Resolution、Plan、route hint、Browser queue/runtime/circuit 只属于当前操作，不进入文献数据库；Browser 自己管理的认证状态只留在 owner-only Profile 中。具体唯一 runtime 与固定身份由 ADR 0016 修订。

[ADR 0016](decisions/0016-cloakbrowser-fixed-identity-runtime.md)把生产 Browser runtime 切换为 CloakBrowser patched Chromium，同时保留 Playwright API、一个长期 Profile/process/context、原始出口、Provider 调度和 Network guard。Profile 使用固定设备身份；经证据确认的 challenge dependency 只在发起页面、frame ancestry、当前文章 permit 和页面生命周期内加载，Challenge 与普通页面使用同一 Observation/Action/capture 合同。

[ADR 0017](decisions/0017-shared-agents-and-controlled-browser-agent.md)把 Analysis 与 Browser 共用的 Agents 基础收敛为 Provider-neutral、无状态、一次只执行一个模型调用的 Runtime。每个 role binding 冻结 model、capability 与默认 reasoning effort；显式配置模型目录读取短生命周期经过 Network 且不持久化。Analysis 保留文献两阶段 controller、prompt/schema 和验收；Acquisition 保留 Browser controller、动作语义和进展判断；Network 唯一生成 Observation、执行动作、capture 和 cleanup。Controlled Browser 作业开始前固定选择 Rules 或 Agent，二者不是 fallback。

### 2.1 目标代码结构

```text
src/sciretriever/
  __init__.py
  __main__.py
  bootstrap/
    __init__.py
    assembly.py
    browser.py
    graphs.py
    probes.py
    services.py
    storage.py
  configuration/
    __init__.py
    browser_access.py
    browser_profiles.py
    credential_edits.py
    credentials.py
    documents.py
    errors.py
    file_store.py
    filesystem.py
    status.py

  entry/
  metadata/
  literature/
  acquisition/
  parsing/
  analysis/

  model/
  agents/
  network/
  storage/
  logging/
```

十一个功能/基础 package 与设计模块一一对应。`bootstrap/` 和 `configuration/` 仍是两个启动阶段
技术模块，不计入产品功能/基础模块；各自 `__init__.py` 是稳定公开 surface，其余同包文件只是按
概念拆分的实现。包化是一种代码治理手段，不增加产品模块；业务调用方不依赖内部实现符号。

### 2.2 模块内部约定

核心功能模块按实际复杂度选择以下内部文件或目录：

- `api.py`：其它模块和 `entry` 可以调用的公开操作；
- `service.py` 或按用例命名的文件：本模块用例编排；
- `rules.py` 或具体规则文件：纯业务判断；
- `ports.py`：本模块消费的外部能力；
- `providers/`、`sources/`、`mineru/` 等明确目录：本模块专属适配器。

这些名称不是强制模板。简单模块可以合并文件，复杂模块可以按明确责任继续拆分；不得为了目录对称创建空实现或虚假公开 API。

## 3. 模块技术文档

| 模块 | 技术文档 | 实现细节归属 |
|---|---|---|
| 入口与流程编排 | [Entry](technical/entry.md) | DiscoveryRun、运行时 BatchSelector、内存目标与版本候选、缺 PDF 目标的有界 tier cohort、非持久化 Report、手动 PDF、本地 Library 查询/详情/引用呈现、Artifact 打开与用户文件导出、书目 codec、固定导入 provenance，以及 `discover/complete/literature/import/export/config` 目标 CLI |
| 启动配置与凭据 | [Configuration](technical/configuration.md) | 普通配置、统一固定 `credentials.toml`、核心服务 origin 绑定与可恢复发布、Agents role/capability/reasoning、有界非持久模型目录读取、Cloak wrapper/binary/version 与 owner-only fixed Profile identity/lifecycle、交互配置中心、纯本地状态与显式 Provider/Agents/MinerU/Browser probe；secret、seed、Profile 内容和测试结果不进入 Model 或文献数据库 |
| 元数据供应商 | [Metadata](technical/metadata.md) | 领域搜索与稳定标识符 lookup、可选 version_links/引用关系/参考文献原文能力、逐边 ProviderRelationObservation、Author 中性转换、目标 Provider adapters、资产线索和部分失败 |
| 文献管理 | [Literature](technical/literature.md) | MetaLiterature/Literature、version_links 身份证据、单一版本成员归属、Provider/用户导入 observations、导入优先的 LiteratureMetadata 与作者统一、单一当前 LiteratureContent 接纳、Reference/ReferenceSupport、状态、LibraryQuery/Search/Detail/Reference 读取语义、Artifact read Port 和交换规则 |
| Acquisition | [Acquisition](technical/acquisition.md) | PublisherAccessProfile/Resolution、确定性 AcquisitionPlan 与 AccessRouteHint、Public/API/Browser route 执行、route-scoped readiness、独立手动 PDF 接纳、运行时 PdfCandidate、二值自动 AcquisitionResult、实际 PDF 字节/reader/页面树检查、唯一主资产关系和自动获取耗尽事实 |
| Parsing | [Parsing](technical/parsing.md) | Parser Port、规范化 Markdown ParserResult、实际引用资源、当前结果替换和资产 lineage |
| LLM 分析与总结 | [Analysis](technical/analysis.md) | 通过 Agents structured-text capability 执行先元数据后正文的两阶段内容分析；Analysis 独占文献 prompt/schema、导入非空值保留边界、明确 NoUsableContent、Markdown-string LiteratureSection、统一“未提供”、有序文本参考文献和临时 ReferenceLookup |
| Model | [Model](technical/model.md) | Pydantic 数据合同、LibraryQuery/SearchPage/LiteratureDetail/ReferencePage/ReferenceDetail 等非持久化读取合同、结构解析和外部类型隔离；binary stream 和目标路径不进入 Model |
| Agents | [Agents](technical/agents.md) | Provider-neutral 单次模型协议、role binding/reasoning、structured text/image/tool capability、readiness、客观单次 limits、显式模型目录 adapter、取消、稳定失败和 fake runtime；不拥有消费模块 workflow、工具执行或结果验收 |
| 网络基础设施 | [Network](technical/network.md) | provider/channel/host 进程内共享准入、官方 API/Agents quota policy、一个 fixed Profile-backed CloakBrowser Chromium process/persistent context、Browser risk-group/Publisher lane 调度、Xvfb/Chromium 原生网络、CONNECT、per-request guard、受限 challenge dependency、统一 Browser Observation/action/capture、内存限速/circuit 状态、URL/DNS/redirect policy、安全 HTTP 和脱敏 |
| 存储 | [Storage](technical/storage.md) | DiscoveryRun、Provider/用户导入共用的 MetadataObservation、文献当前事实与自动 PDF 获取耗尽的关系 schema、SQLite、不可变文件、一致 read snapshot、临时 Search/Detail/Reference 投影、verified artifact reader、原子用户文件输出、事务、对账、锁和崩溃边界；不保存查询结果、导入过程、批量运行或 Report |
| Logging | [Logging](technical/logging.md) | 命名 logger 公开入口、生产进程一次性配置、stderr handler、formatter、最终脱敏 Filter 和 best-effort 故障隔离 |

## 4. 全局依赖方向

箭头表示 import 方向：

```text
entry ---------------------> metadata.api
entry ---------------------> literature.api
entry ---------------------> acquisition.api
entry ---------------------> parsing.api
entry ---------------------> analysis.api
entry ---------------------> model

metadata ------------------> model
literature ----------------> model
acquisition ---------------> model
parsing -------------------> model
analysis ------------------> model
agents --------------------> model
network -------------------> model
storage -------------------> model

entry ---------------------> logging.api
metadata ------------------> logging.api
literature ----------------> logging.api
acquisition ---------------> logging.api
parsing -------------------> logging.api
analysis ------------------> logging.api
agents --------------------> logging.api
network -------------------> logging.api
storage -------------------> logging.api

logging -------------------> Python standard library only
```

专属适配器使用以下受控方向：

```text
metadata.providers --------> metadata.ports + network
acquisition.routes --------> acquisition.ports + network
parsing.mineru ------------> parsing.ports + network
analysis ------------------> agents.api
acquisition.browser_agent -> agents.api + network
agents.providers ----------> agents.ports + network
entry.codecs --------------> entry.ports + model

storage adapters ----------> 消费模块的 ports + model
bootstrap -----------------> 全部模块的公开构造入口
bootstrap -----------------> logging.api.configure_logging
```

全局依赖规则是：

1. `model` 只能依赖 Pydantic 和 Python 标准库中的声明性类型能力；
2. 功能模块的规则和用例只依赖本模块、`model`、`logging.api`、本模块声明的 Ports，以及经过 ADR 0017 允许的 `agents` 中性公开 API；
3. `entry` 是跨功能模块顺序编排的唯一位置；
4. 功能模块之间的业务调用只使用对方 `api.py` 和 Model 数据，不导入对方私有规则、用例、Ports 或适配器；
5. 规则和用例不得直接使用 `sqlite3`、SQL、绝对路径、HTTP response、Playwright、vendor SDK、环境变量或 TOML；
6. SQL 和 `sqlite3` 只存在于 `storage/sqlite/`，最终文件创建、对账和回收只存在于 `storage/files/`；
7. 共享 URL、DNS、redirect、HTTP 和浏览器执行只存在于 `network/`，供应商专属协议和页面步骤留在消费模块的适配目录；
8. Vendor、HTTP、浏览器、SQL、MinerU 和模型协议私有类型不得进入模块公开 API、规则、用例或 Model；Agents 中性交换值不得携带 Literature、Publisher、Page、Cookie、任意 callable 或消费模块业务枚举；
9. `storage` 只实现功能模块定义的持久化 Ports，不形成身份、验收、状态或导出资格决定；
10. 除 `model` 外的目标生产模块只通过 `logging.api` 获取 logger；Handler、formatter、最终脱敏 Filter 和 `sciretriever` logger 配置只存在于 `logging/`，该模块只依赖 Python 标准库；
11. 任何完整快照或下游导出不得成为核心身份、状态或处理完成的前置条件；
12. 所有产品操作读取并更新同一个逻辑文献数据库；模块不得维护可与当前数据库事实漂移的平行文献结果或处理完成状态。

## 5. Ports 与生产组装

Port 由消费能力的模块所有：

| 消费模块 | Port 范围 |
|---|---|
| `entry` | DiscoveryRun repository、selector/current-facts read、write admission、clock、literature metadata codec、原子用户文件输出；目标、候选和 Report 只在内存形成 |
| `metadata` | metadata search、metadata reference query、observation publication |
| `literature` | literature repository、read model、artifact read、identity transaction、reference/support publication、content acceptance publication、import/export publication |
| `acquisition` | route adapter、临时获取、Asset 与 LiteratureAsset 原子 publication、自动获取耗尽事实 publication/clear；Resolution、Plan、route hint 和 Browser queue 只在模块/Entry 当前运行内存中形成 |
| `parsing` | parser |
| `analysis` | Agents structured-text capability；第一阶段元数据提案、第二阶段内容 Markdown 草稿和完整待验收提案都是临时结果，不拥有持久化 publication |
| `agents` | 从任务所选 Model 与 Provider 解析出的 role binding、provider/model 协议的单次执行、capability/readiness、有界非持久模型目录读取、客观单次 limits、取消和稳定失败；不拥有用户 Model 配置、任务级模型覆盖、文献或 Browser workflow/业务结果 |

禁止建立顶层共享 `ports/`、`repositories/`、`utils/` 或笼统 `integrations/` package。

Bootstrap 边界（公开 `sciretriever.bootstrap` package surface 与同包实现文件）是唯一生产对象图组装
点，负责把以下具体实现注入模块公开构造入口：

- raw `sqlite3` repository 与 publisher；
- 文件系统不可变发布、verified artifact reader 与原子用户文件输出；
- metadata search、metadata reference query 和 Acquisition route adapters；
- 当前进程共享的 Access Coordinator、secure HTTP、Publisher access profile catalog/Planner、tiered cohort orchestrator 与 Browser scheduler/session broker；只有存在经过生产准入的 Browser route 时才注入受控浏览器 adapter；
- MinerU parser；
- 一个共享无状态 Agents runtime，并按 Analyze/Download 所选 Model 的 Provider 构造一或两个具体模型 adapter 与 role binding；同一 Provider 复用 adapter，不同 Provider 分别绑定，再向 Analysis 和选中的 Browser controller 注入同一调用面；
- BibTeX、RIS 和 CSL JSON codec；
- 本机写锁、时钟和资源预算。

此外，`sciretriever.bootstrap` 在生产 CLI 启动时一次性调用 `logging.api.configure_logging(...)`；logger level、formatter、最终脱敏 Filter 和 stderr handler 由 Logging 模块实现，不通过模块构造器注入，也不形成 Logging Port。

完整对象图与 `ASSET_COMPLETION`/`CONTENT_COMPLETION` capability-scoped 对象图必须分别只拥有一套上述 Acquisition 运行对象，并以对象 identity 证明 Registry、Planner、Service 与 Executor 共享同一 Profile catalog、Coordinator、scheduler、session broker 和 admission controller。当前发布的 production Profile catalog 共 10 项：CORE 提供授权 API；Elsevier 与 Wiley 同时提供授权 API 和 Browser route；ACS、AIP、IOP、Oxford Academic、RSC、Science / AAAS 与 Springer Nature Link 提供 Browser route。production Browser rule catalog 为 `acs-publications-pdf@3`、`aip-publishing-pdf@3`、`sciencedirect-pdf@3`、`iopscience-pdf@2`、`oxford-academic-pdf@3`、`rsc-publishing-pdf@3`、`science-aaas-pdf@3`、`springerlink-pdf@5` 和 `wiley-online-library-pdf@3`。目标生产对象图只在普通 `browser_enabled`、选中且安全存在的固定身份 Browser Profile、CloakBrowser wrapper/经验证 binary、Playwright API 与 headed display 同时就绪时构造 Browser client，并据此动态设置 execution confirmation 与 runtime readiness；切换完成后不存在 stock Chrome/Chromium fallback。普通文章流程允许 Profile 批准的页面子资源和受限 challenge dependency、丢弃未批准的第三方非关键资源，并逐项审查显式或点击/脚本导航 request；未再次暴露 route 的 native redirect 只能复用同页 live、已批准且预绑定的关联，并在读 terminal body 前取得最终 host permit。Configuration probe 使用生产 Network contract 加 deny-all capture guard。所有 Publisher lane 共享一个 Profile 和一个 CloakBrowser process/persistent context；同一 Publisher 严格串行，不同 Publisher 在 cap 内并行。Bootstrap 根据作业开始时冻结的 `browser_controller` 只构造 Rules 或 Agent controller；Rules 只运行确定性页面流程，Agent 从第一次统一 Observation 起决策，二者不会相互切换。production catalog、总开关、Profile presence、route/runtime/所选 controller capability 就绪、登录状态、机构 IP 与具体文章 entitlement 仍是分立事实。

模块 `api.py` 不得构造具体 adapter，也不得读取全局配置。测试可以直接注入 fake Port；生产对象图只能由 `sciretriever.bootstrap` 构造。

Configuration 边界（公开 `sciretriever.configuration` package surface 与同包实现文件）是唯一普通
TOML、非 secret 环境选择、统一凭据文件与 Browser Profile 生命周期入口。未知 section、key、
枚举或组合必须 fail closed；普通配置转换为 `model/configuration.py` 中不含 secret 的中性配置
数据，再执行跨字段和运行环境规则。文献 Provider、Model Provider 与远程 MinerU secret 只从
`~/.sciretriever/credentials.toml` 读取并作为私有短生命周期值交给 Bootstrap；不保留 secret
环境变量回退。Browser Profile 只接受 opaque identity，Chrome 自己管理的 Cookie/认证内容不进入
TOML、Model 或 status。精确文件、权限、origin、readiness 和 CLI 合同见
[Configuration 技术文档](technical/configuration.md)。

普通配置按以下十个公开责任组组织：

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

Source 的 Auto/Custom mode、Custom 精确顺序、Metadata 逐 Source limit、产品/database/edition、AccessPolicy 和联系邮箱留在普通配置；Auto effective catalog 只由版本内置常量解析，不读取 Network 或 credentials。Provider API key、token 与 metric 只进入固定凭据文件，不能形成普通配置中的 `credentials` 责任组，也不能反向启用 Source。Secret 值不得进入 Model configuration、SQLite、ArtifactStore、provenance、Report、diagnostics、URL、文件名或用户输出。`sciretriever.bootstrap` 只把短生命周期凭据注入具体 adapter；adapter 决定允许附着凭据的 origin；`network` 负责 redirect stripping 和脱敏。

### 5.1 Logging 模块启动与标准流

除纯声明的 Model 外，具有运行行为的模块只使用 `logging.api.get_logger(__name__)` 获得命名 logger，不依赖 Bootstrap、全局 Observer、事件总线、Logging Port 或自定义 LogEvent Model。模块 import、adapter 构造和每次 Entry 操作都不得调用标准库 `basicConfig()`、修改 root logger 或安装 Handler。生产 CLI 启动时由 `sciretriever.bootstrap` 通过 Logging API 显式配置一次；程序内 API 不触发配置，也不修改宿主应用的 Logging 设置。精确目录、API 和测试合同见 [Logging 技术文档](technical/logging.md)。

默认生产输出只需要一个 stderr handler。实时进度、等待和安全诊断进入 stderr；CLI 的稳定文本结果、完整 JSON Report 或其它可管道结果进入 stdout。即使未来 formatter 使用结构化文本，日志也不得写 stdout。当前目标不建立日志文件、轮转、SQLite sink、Artifact、跨进程日志协调或持久审计；用户自行重定向 stderr 不改变其非权威性质。

当前 formatter 把合法 `event=... key=value` message 呈现为包含时间、level、component、状态符号、原始事件 ID 和固定顺序字段的人类可读主行；稳定 failure 的 reason/action 使用续行。正常模式保留操作与阶段汇总、等待、交付/耗尽和全部稳定失败，把 route/candidate miss、capture、cleanup 等逐步骤细节留给 Debug。Debug 终态使用 `disposition/next` 表明链路去向，并为关键 Provider/tier/route/target、API 与 Browser 步骤显示单调时钟耗时。TTY 可着色，非 TTY、重定向或 `NO_COLOR` 必须无 ANSI。

日志是 best-effort 旁路：level 过滤、handler 故障或硬崩溃造成的缺失不得改变业务结果、事务、Report 或退出语义。Entry Report 只从 typed result 和 `StableFailure` 累计，不能读取 LogRecord；日志也不能替代必须持久化的 DiscoverySourceResult、自动 PDF 获取耗尽或其它业务事实。日志 message、时间、level 和可选上下文不是稳定公共 API，不建立 Pydantic schema；测试只固定标准流、安全字段和“不影响业务”的边界，不绑定完整文案。

适用时日志可以携带安全的 `stage`、`provider_name`、`meta_literature_id` 或 `literature_id`，但不建立 operation ID 或目标状态。Network 在返回前脱敏 URL、header、Cookie、凭据和网络异常；Provider、Parser 与 LLM adapter 分别脱敏自己的响应、task、prompt 和 SDK 异常。原始外部对象、response body、完整 URL、签名参数、用户文件绝对路径、文献正文和 prompt 不得作为 message 参数或 `extra`。Logging 模块的 Filter 只能做最后防护，不能取代来源 adapter 的边界转换。

## 6. 跨模块运行约束

- 每项操作由用户请求和一致的当前数据库 snapshot 共同决定；查询和只读导出直接读取该 snapshot，会改变数据库的操作据此形成实际目标，新结果只有经过业务所有者验证并提交到同一逻辑数据库后才成为后续步骤的输入。
- 目标 CLI 只使用 `discover`、`complete`、`literature`、`import`、`export`、`config` 六个一级名称；`literature` 保持只读，元数据文件和手动 PDF 分别通过 `import metadata/pdf` 接纳，书目元数据、当前主 PDF 和当前轻结构化 Markdown 分别通过 `export metadata/pdf/content` 导出。裸 `config` 打开交互式凭据管理器，公开子命令只保留 `status/test`，且不形成处理 Report 或文献数据库事实；内部模块名和通用 artifact 不形成一级命令。
- `LibraryQuery` 只查询本地数据库并以具体 Literature 为结果单位；SearchItem/SearchPage、LiteratureAssetView、LiteratureDetail、LiteratureReferencePage 和 ReferenceDetail 是同一 snapshot 临时组装的不可变 read model，不建立持久化表、第二份 metadata/status、反向引用边或写入生命周期。大型 artifact 字节和可能无界增长的关系边使用独立读取。
- `LiteratureDetail` 只携带既有 Asset/ArtifactRef，不能执行 I/O。Literature 的 artifact reader 在 Storage 根内复核普通文件、size、hash 和 media type 后返回 context-managed 只读 stream；Entry 向用户目标导出时默认拒绝已有文件，并通过同目录 staging 原子发布。两者不访问 Provider、不修改数据库或形成处理 Report。
- 外部领域搜索和引用扩展各自形成 DiscoveryRun；本地只读查询不形成运行记录。DiscoveryRun 完成后不创建 Collection、不启动主 PDF/Parsing/Analysis，也不对每条发现结果执行全部 Provider 的逐篇精确补查。
- DiscoveryRun 本体只保存 ID、类型化输入、五态 status 和开始时间。每个 Provider 在整个 Run 内按过滤和去重前原始 item 执行 scan limit，只持久化自然耗尽、达到上限或失败；扫描/接纳/拒绝计数、cursor、完整路径和完成时间不进入合同。
- Metadata 只应用标题或 DOI 的最低入库条件，不通过 LLM、搜索分数、关键词、摘要分类或低收益启发式判断领域相关性；偏题但有实际内容的 Literature 不属于 `NoUsableContent`。
- 领域 DiscoveryRun 调用本次全部已启用、生产 adapter 已实现且 readiness 通过的 Metadata search 能力，不按 publisher 预先筛选；明确启用但缺少 adapter、必需普通参数、Provider 凭据或 AccessPolicy 时在开始前返回配置错误。引用查询只是 Metadata Provider 的可选能力，不建立 Citation Provider。
- 数据库补全以运行时 `BatchSelector + BatchGoal` 为输入，在当前进程内冻结实际目标；selector、目标、候选与 Report 不持久化。运行期间新增文献或查询结果变化不动态加入。当前实现按操作的 `max_concurrency` 将冻结顺序切成固定大小 chunk；不同目标可以有界并行，每个目标从自己的第一个缺失步骤继续，缺 PDF participant 按代组成有界 cohort，已有 PDF 目标可以直接进入后续步骤。Receipt 按 Public、API、Browser/final 层级波次提前交付，波内保持冻结顺序，并经 operation-scoped 串行提交边界消费；chunk、generation、coordinator 和 receipt 不跨进程恢复。
- 普通范围按 MetaLiterature 去重并冻结有序 Literature 候选；先按 `CONTENT_READY`、已有 ParserResult、已有主 PDF 的完成度排序，同等完成度再按 `published`、`accepted-manuscript`、`preprint`、`other` 排序。只有稳定缺失才尝试下一版本，系统、Parser、LLM、取消或无法判断的失败不得触发回退。
- Provider 私有响应、PublisherAccessResolution、AcquisitionPlan、AccessRouteHint、下载候选、HTTP/Browser 现场、session health/circuit、Parser task、LLM 草稿、内存队列、冻结目标、运行报告和缓存不是文献事实，不得形成第二真相源；只有适用 ADR 明确接纳的中性结果进入 Catalog 或 ArtifactStore。
- 一个 Literature 可以关联多个长期保存的不可变 MetadataObservation，但只拥有一份当前 LiteratureMetadata；新增 observation 不覆盖来源事实，当前 metadata revision 只作为单调并发与内容对齐令牌，不形成旧统一元数据历史。LLM 最终提案只在完整内容接纳时替换当前元数据，不成为 MetadataObservation。
- 重跑和崩溃恢复重新读取 current facts 并从缺失或明确失效的步骤继续；不恢复或持久化上一轮 selector、目标、候选、队列或 Report。
- 文献版本状态只从已提交的权威事实推导，不维护第二个可修改状态；具体规则见 [Literature](technical/literature.md)。
- Literature 状态只有 `UNREVIEWED`、`ASSET_READY` 和作为内容完成状态的 `CONTENT_READY`；引用解析不参与状态。
- Acquisition 正常业务结果只有已经完整提交主 PDF 和本次没有获得主 PDF；候选问题不形成长期原因，文件或数据库提交问题按系统错误传播。唯一 `primary-pdf` 关系就是当前主 PDF，不建立平行 `is_current`。
- 只有 Acquisition 正常遍历具体 Literature 的全部当前自动路径时才建立最小 `AutomaticPdfAcquisitionExhaustion`，提交成功后才返回 `NoPrimaryPdf`；该事实只保存 LiteratureId，不改变三级状态。`AllPendingSelector` 排除需要 PDF 且已有该事实的对象；新 MetadataObservation、成功主 PDF 或用户明确重试会清除它。中断、Network/API/权限/配置错误和 Storage 错误不得形成耗尽事实。
- Acquisition 只按实际字节、标准 PDF reader、可读且至少一页的页面树和来源依据执行最低文件检查，不信任后缀、文件名或 HTTP 类型，也不判断学术内容；Analysis 只在有明确证据时返回 `NoUsableContent`，无法判断、解析异常或模型失败必须保留 PDF。
- Acquisition 先形成访问方 Resolution 和按 Public、Authorized Provider API、Controlled Browser 分组的确定性 Plan；Planner 可以省略不适用 route，但不能自动提前 Browser。一个 cohort 的全部目标完成 Public 后，未解决目标完成 API，最后只有 admission 允许的最小集合进入 Browser；同一 Literature 不跨层竞速，较早提交 PDF 的目标可以继续后续步骤。
- Resolution 依据明确 AssetHint origin、arXiv ID/PMCID/PII 等来源稳定定位、Provider record identity 和必要时 DOI 安全解析后的实际 landing origin；publisher 字符串和 DOI prefix 只能作为弱提示。Metadata Provider、Publication/Access Provider 与 Access Platform 分开表达，凭据存在、认证成功和具体文献 entitlement 也必须分别判断。
- DOI/API/页面产生的 canonical landing、稳定文章 ID 或 locator 只形成当前运行的安全 `AccessRouteHint`；Cookie、token、签名 URL、vendor/page object 不进入 hint、日志、Report 或数据库。
- 手动 PDF 接纳要求 Entry 明确指定具体 Literature，复制而不移动用户文件，复用相同基本检查和唯一主资产 publication；它不进入 `AcquisitionPath`，无效输入不成为第三种自动 AcquisitionResult，已有主 PDF 时默认拒绝。
- 所有外部访问先经过 [ADR 0012](decisions/0012-process-local-provider-access-scheduling.md) 的进程内共享 Access Coordinator。公开协议和 API 按 adapter 声明的官方 quota identity、并发、间隔、window/周期额度、reset boundary 和 `Retry-After` 执行；普通配置只能收紧。Browser 按 `browser_rate_limit_group` 不同组并行、同组 `concurrency=1` 且按 Profile 的文章间隔/window/cooldown 串行；全局 Browser cap 只保护本机资源。等待 permit、session health 和 circuit 不形成 Literature 状态。
- Timeout、临时服务错误、`429`、有效 `Retry-After`、quota exhausted、Browser 登录/MFA 或 Challenge 未解决不能通过自动切换 controller、重试、新 Literature、popup 或备用入口绕过；只有全部适用 routes 正常结束且没有 deferred/未解决 failure 时才能提交自动耗尽。
- `config` 使用 `Models / Search / Download / Parse / Analyze / Browser / Status / Theme / Quit` 单词级首页；Models 拥有 Provider、Model 和模型 key，Search/Download 在具体 Source 对象页拥有普通参数、key 与 test，Parse 用 Setup 连续配置 MinerU，Analyze/Browser 用 Setup 选择 Model 和保存业务参数，Browser 另行拥有 Profile 与 Runtime。`config status` 只检查本地 Provider/Model/MinerU 普通字段、凭据 presence/origin 与静态 readiness，不调用 Network；`Models → Add` 在 key 就绪后自动读取一次有界模型目录且不保存结果，失败或空结果才回退 Manual。用户显式执行的 `config test` 仍经过同一 Access Coordinator、安全 HTTP、限速、redirect 与脱敏边界。Analyze/Browser Model probe 不发送用户文献或真实页面，MinerU probe 不上传 PDF；结果只属于当次 CLI，不创建 DiscoveryRun、Report 或任何数据库事实，也不保存最后结果和时间。
- Analysis 与 Browser 共用一个无状态 `AgentRuntime` 调用面；所选 Model 引用同一 Provider 时复用 adapter/credential，不同 Provider 时使用各自 exact-origin credential 与 adapter。Model 只拥有远端 identity、reasoning 与 image；Analyze 的 strict structured output/业务预算和 Download 的 image/tool/PNG/安全限制由各模块派生，不形成用户 capability 配置或任务级 override。Reasoning 中性值覆盖 `default/none/minimal/low/medium/high/xhigh/max`；default 省略 wire 字段，显式值原样发送。Analysis 保留文献 prompt/schema 和两阶段验收，Acquisition 保留 Browser controller/动作语义/进展，Network 唯一生成 Observation、执行动作与 capture。Agents 不形成公共任意 prompt、Page/CDP、session 或长期 memory 接口。
- LiteratureSection 只结构化 H1/H2，章节正文继续保存 Markdown 字符串；固定内容缺失统一渲染“未提供”，参考文献空 tuple 的缺失标记不成为一条引用。
- 每个 Literature 只保留一个当前 LiteratureContent；内容 hash、UTF-8 Markdown 字节 hash 和单一 Analysis provenance 分别表达结构化内容、发布字节和形成依据。成功重分析完整接纳后原子替换，失败保留旧结果。
- 文献内容处理链优先长期保护来源元数据、当前权威 metadata 和原始 PDF；ParserResult 与 LiteratureContent 是保留当前结果、可以重建且不维护历史的派生产物。本轮不从该结论新增 Storage 物理目录、备份、缓存配额、清理周期或恢复算法，未决细节留待 Storage 模块后续讨论。
- 网络、浏览器、parser 和 LLM 调用发生在 SQLite 事务之外。
- 每个目标按阶段使用短事务提交，单个目标失败不回滚其它目标；执行边界见 [Entry](technical/entry.md)。
- 文件先不可变发布，SQLite 后建立引用；失败最多留下不可见孤儿，不能形成缺失文件的有效引用；具体机制见 [Storage](technical/storage.md)。
- 跨事实所有者需要原子提交时，各模块先形成已确认的 Model 决定，再由 `entry` 调用明确的复合持久化 Port；`storage` 只保存决定。
- 每个有效的处理型 Entry 操作直接返回 `DiscoveryReport`、`DatabaseCompletionReport`、`ManualPdfReport`、`ImportReport` 或 `ExportReport` 之一，纯查询直接返回 read result；五类 Report 只共享 `finished/interrupted/failed` 最终停止值，不进入 Catalog，也不参与后续选择。Logging 独立写入 stderr，不能生成或替代 Report；硬崩溃不保证最终 Report。
- 所有外部失败在用户输出前转换为稳定、脱敏的 reason/action；只有 Accepted 设计明确要求长期保留的失败边界才进入持久化合同，底层异常文本不能成为业务合同。

## 7. 整体验收

静态依赖检查必须拒绝：

- 违反第 4 节依赖方向的 import；
- 跨模块导入对方私有规则、用例、Ports 或适配器；
- `storage/sqlite/` 以外使用 `sqlite3` 或 SQL；
- `sciretriever.configuration` package 以外读取环境变量或 TOML；
- `sciretriever.bootstrap` package 以外构造跨模块生产对象图；
- `logging/` 以外的目标生产代码配置 root logger、Handler 或 formatter，或直接绕过 `logging.api` 获取项目 logger；
- `model` 导入 Logging，或 `logging` 导入任何 SciRetriever 业务模块、Model、Network 或 Storage；
- vendor SDK、HTTP、浏览器或 SQL 类型进入 Model、模块公开 API、规则或用例；
- Analysis/Acquisition 直接导入 Agents provider adapter 或 vendor SDK，或 Agents 公共 API 携带 Literature、Publisher、Page、Cookie、任意 URL/JavaScript/callable；
- provider-specific browser flow 进入 `network/browser.py`；
- provider adapter、vendor SDK、普通 HTTP 或浏览器绕过共享 Access Coordinator；
- 已撤销的 `DocumentPackage` 2.0 名称、占位或类型进入目标 Model、公开 API 或持久化。

行为测试和语义审查还必须证明：

- 收集、导入、处理、查询和导出使用同一逻辑文献数据库，实际目标由用户请求与当前事实共同决定，且没有平行结果集合或处理完成状态；
- 本地 LibraryQuery 不访问外部 Provider，也不修改数据库，搜索以具体 Literature 为单位；SearchPage 和 LiteratureDetail 从同一 read-only snapshot 临时组装，metadata/status/缺失步骤/资产/ParserResult/Content/引用数量一致，且没有查询结果持久化表或无界嵌套 artifact/关系图；
- 安装后的 CLI 命令树严格使用 `discover topic/citations`、`complete`、`literature search/show/references/cited-by`、`import metadata/pdf`、`export metadata/pdf/content`、裸 `config` 交互管理器和 `config status/test`；`config set/remove` 必须拒绝。命令只负责边界解析和呈现，不包含业务规则，未实现前不进入 README 或用户指南；
- Metadata Provider 与 Acquisition Provider 使用独立中性合同，引用能力只作为 Metadata 可选能力；目标 Adapter 矩阵、用户启用状态、生产实现和 readiness 分开表达，未实现目标不得伪装成当前集成；
- `credentials.toml` 的 owner、普通文件、非符号链接、目录 `0700`、文件 `0600`、字段 allowlist、核心服务 origin 绑定和可恢复发布均 fail closed；secret 不进入 Model、CLI 参数/输出、数据库、Report、日志或生产 fixture；`config status` 不联网且不显示任何 secret 特征，`config test` 只用 fake Network 做离线验收；
- references/cited-by 页面从同一 Reference 正反向读取相关 Literature 与 support count，ReferenceDetail 才返回两端和全部当前 support；页面/详情不持久化、不形成 cited-by 副本，也不混入 Provider citation count；
- Artifact reader 只接受 Detail 中已有 Asset/ArtifactRef，验证相对引用、普通文件、size/hash/media type 后返回 context-managed stream；用户文件导出默认拒绝覆盖并原子发布，内部绝对路径、目标路径、副本和导出结果不进入数据库或处理 Report；
- 持久化 DiscoveryRun 只表达有边界外部发现，数据库补全只在当前进程内冻结范围；当前合同不存在 Collection，领域发现不会自动触发 PDF、Parsing、Analysis 或逐篇全 Provider 补查；
- Provider scan limit 在整个 DiscoveryRun 内按过滤和去重前原始 item 消耗；source result 不保存过程计数，Metadata 不执行领域语义过滤或低收益提前停止；
- DiscoveryResult 按 MetaLiterature 去重，topic cause 指向 observation，citation cause 保存 source/target Literature 与 depth；不存在长期 ReferenceId 依赖或完整 DiscoveryPath；
- 六类 BatchSelector 都在内存中冻结实际目标且不持久化；`ImportReportSelector` 只接受调用方明确重新提交的有序 MetaLiterature ID，不建立 ImportRun；普通 MetaLiterature 目标只在自动 PDF 获取正常耗尽或明确无内容且候选耗尽时切换版本，系统/Parser/LLM 失败不切换；
- 五类处理型 Entry Report 和三种 `ReportEnd` 严格使用 Model 精确合同；数据库补全五分区覆盖全部冻结目标，导入逐记录分区，导出只在原子发布后报告 published，受控中断尽可能报告已完成情况；不出现 ReportId、自由 details、日志数组或第二套 counts；
- Report 只从 typed result 和稳定 failure 形成并直接返回调用方；Logging 模块只提供 stderr 上的 best-effort 旁路，不能污染 stdout、改变业务结果或替代持久事实，其最终 Filter 不能替代各外部边界的脱敏；
- 自动 PDF 获取耗尽只保存具体 LiteratureId，在新 observation、成功主 PDF 或明确重试时清除；临时错误不建立耗尽事实，查询能够筛选 `needs_manual_pdf`；
- 手动 PDF 只接纳到明确具体 Literature，复制且不伤害用户原文件，不保存绝对输入路径，不进入自动三阶段或二值 AcquisitionResult；
- 中断和崩溃后的新运行重新读取当前事实，不依赖恢复旧外部调用、线程、队列或内存现场；
- `network` 和 `storage` 不形成文献身份、业务验收、状态或导出资格决定；
- Metadata、Acquisition、Parsing 和 Analysis 的外部请求在当前进程共享 provider/channel/host 准入；API 精确遵守官方 quota scope 与反馈，同一 Browser risk group 最大并发为 1 且满足自身文章政策，两个独立 group 在本机资源允许时实际并行；
- Acquisition 的 Resolution/Plan 由 AssetHint、稳定定位、Provider record identity 和必要时安全解析后的 DOI landing origin 决定；不能按 publisher 字符串、单独 DOI prefix 或 MetadataObservation 来源硬编码内容 API/Browser，readiness/权限错误也不能形成 `NoPrimaryPdf` 或自动获取耗尽；
- 缺 PDF 目标按有界 cohort 完成 Public → API → Browser admission，单篇不能提前跨层；timeout、临时错误、`429`/quota 和 Browser 未解决页面不触发自动 Browser/controller 绕行；
- 每次 Browser navigation、popup、viewer、response 和 download 在访问前同时通过 Profile guard 与 Network policy；重试、多标签页和备用入口不能绕过组内串行、interval、cooldown 或 circuit；
- 一个 operator-managed 固定身份 Browser Profile 同时只由一个 CloakBrowser Chromium process 使用；所有 Publisher
  lane 在当前对象图共享一个 persistent context，同一 risk group 串行、不同 group 可并行，每篇
  文章使用隔离 page/handler/临时下载目录；broker 关闭后删除 runtime 临时资源但保留 Profile。
  产品不提供用户可见 Browser 认证入口，自动流程不填写凭据、选择机构或处理 MFA；Agent controller
  可以通过统一页面动作处理当前文章中的可见 Challenge。Cookie、seed、
  Profile 路径/内容、登录细节、完整 URL、selector 和页面对象不进入配置内容、status、日志、
  Report、provenance 或文献数据库；
- 同一 Browser Profile 跨冷启动保持固定 seed 派生身份、native Linux persona、语言/时区/屏幕/字体与 Browser version 表面一致；CloakBrowser 是唯一生产 runtime，不存在公开或隐藏的 stock launcher、系统 Chrome、Playwright bundled Chromium 或其它 fallback；
- 经核实的 challenge dependency 只有在批准 Publisher 顶层页面、frame ancestry、当前文章 permit 和页面生命周期内可加载；Challenge 使用统一 Observation/Action/capture，资源阻断与普通 access denied 分别稳定化，challenge 资源不能成为 capture；
- Analysis 与 Browser 通过同一无状态 Agents runtime 获得统一单次执行、capability/readiness、limits、取消和稳定失败；二者选择同一 Model Provider 时共享 provider/account quota adapter，选择不同 Provider 时分别使用对应 adapter。Analysis 仍验收文献结果，Browser Agent 只返回六种封闭动作并由 Network 执行，Rules 模式不要求 Download Model；
- 等待队列、permit、窗口计数、`next_allowed_at` 和 `blocked_until` 只存在于当前进程内存，不包含 DOI、Literature、候选、URL、凭据或响应正文，也不进入 Catalog、ArtifactStore、provenance 或协调文件；
- 外部调用不在 SQLite 事务中执行；
- 功能模块不直接创建或覆盖最终文件；
- 间接调用、别名或动态值不能绕过模块责任；
- 目标架构、当前实现和迁移计划没有被混写。

离线产品验收覆盖 R1–R8：独立领域/引用 DiscoveryRun、逐 Provider 原始 scan limit、无元数据阶段语义过滤、目标 Metadata Provider 全启用且就绪搜索、Provider 配置/readiness 与 `credentials.toml` 安全边界、纯本地 `config status` 和 fake Network `config test`、最小 source result、按 MetaLiterature 去重的 DiscoveryResult 与直接 cause、无 Collection 的运行时 selector 与内存目标冻结、非持久化运行 Report、MetaLiterature 版本候选与稳定缺失回退、同文献 `version_links` 身份证据与单一 MetaLiterature 成员归属、文献内有序 Author/ORCID/署名单位、元数据供应商结构化关系和参考文献原文两种引用扩展、逐边独立且可延后物化的 `ProviderRelationObservation`、临时 `ReferenceLookup`、本地精确命中或目标元数据接纳、Literature 级 Reference 及三种 ReferenceSupport、多来源部分失败、身份收敛和版本分离、Publisher access resolution/plan、PDF Public/API/Browser cohort 严格升级、官方 API quota policy、Browser 组间并行/组内限速串行与 per-hop guard、独立手动 PDF 接纳、provider/channel/host 进程内共享准入、实际 PDF 字节/reader/页面树基本检查、二值自动 AcquisitionResult、自动获取耗尽与 `needs_manual_pdf`、Asset 与唯一 `primary-pdf` LiteratureAsset、Parser-neutral Markdown `ParserResult`、实际引用资源与 hash、单一当前结果替换、明确内容判断与失败保留 PDF、LLM 一次逻辑分析按先元数据后正文的两次有序核心请求形成最终 metadata/keywords、内容 Markdown 草稿、Markdown-string LiteratureSection、有序文本参考文献、统一“未提供”、单一 Analysis provenance、Literature 整体接纳与规范 Markdown、当前内容原子替换和旧 content support 清理、书目导入复用 MetadataObservation、导入非空值优先、完全重复 matched 不复制 observation、书目导出、本地 LibraryQuery、具体 Literature SearchPage、一致 snapshot LiteratureDetail、Reference 正反向页面与详情、verified artifact 打开/原子导出、局部失败、中断和重复执行。未解析 `version_links` 不得创建占位 Literature 或通用关系；供应商响应携带多少引用关系也不得自动创建同等数量的 Literature 或触发无边界递归。Harness、单元测试、构建和安装后离线验收不得读取真实用户凭据、Cookie、外部 Browser Profile、执行 `config test` 的真实网络路径、连接真实供应商、生产数据库或用户语料。

## 8. 需求追踪

| 产品需求 | 主要模块技术文档 |
|---|---|
| R1 发起文献收集 | [ADR 0013](decisions/0013-decoupled-discovery-and-database-maintenance.md)、[Entry](technical/entry.md)、[Metadata](technical/metadata.md)、[Literature](technical/literature.md) |
| R2 多来源元数据搜索 | [ADR 0014](decisions/0014-capability-scoped-providers-and-local-credentials.md)、[Configuration](technical/configuration.md)、[Metadata](technical/metadata.md)、[Literature](technical/literature.md)、[Network](technical/network.md) |
| R3 文献资产获取 | [ADR 0013](decisions/0013-decoupled-discovery-and-database-maintenance.md)、[ADR 0014](decisions/0014-capability-scoped-providers-and-local-credentials.md)、[ADR 0015](decisions/0015-publisher-aware-tiered-pdf-acquisition.md)、[ADR 0016](decisions/0016-cloakbrowser-fixed-identity-runtime.md)、[ADR 0017](decisions/0017-shared-agents-and-controlled-browser-agent.md)、[ADR 0021](decisions/0021-provider-model-registry-and-direct-task-selection.md)、[Configuration](technical/configuration.md)、[Agents](technical/agents.md)、[Metadata](technical/metadata.md)、[Acquisition](technical/acquisition.md)、[Network](technical/network.md)、[Storage](technical/storage.md) |
| R4 文献解析 | [Parsing](technical/parsing.md) |
| R5 语言模型内容判断与总结 | [ADR 0017](decisions/0017-shared-agents-and-controlled-browser-agent.md)、[ADR 0021](decisions/0021-provider-model-registry-and-direct-task-selection.md)、[Agents](technical/agents.md)、[Analysis](technical/analysis.md)、[Literature](technical/literature.md)、[Storage](technical/storage.md) |
| R6 文献数据库 | [ADR 0011](decisions/0011-literature-database-centered-incremental-maintenance.md)、[ADR 0013](decisions/0013-decoupled-discovery-and-database-maintenance.md)、[Literature](technical/literature.md)、[Storage](technical/storage.md)、[Entry](technical/entry.md) |
| R7 书目信息导入与导出 | [Entry](technical/entry.md)、[Literature](technical/literature.md) |
| R8 大批量处理 | [ADR 0013](decisions/0013-decoupled-discovery-and-database-maintenance.md)、[ADR 0015](decisions/0015-publisher-aware-tiered-pdf-acquisition.md)、[Entry](technical/entry.md)、[Network](technical/network.md)、[Storage](technical/storage.md)、[Logging](technical/logging.md) |

## 9. 明确不采用的机制

- ORM；
- 顶层共享 `ports`、`repositories`、`utils` 或笼统 `integrations` package；
- 让 Model validator 执行业务判断、I/O 或副作用；
- 让功能模块规则或用例直接访问 SQLite、文件系统、HTTP 或浏览器；
- 把浏览器当作 HTTP transport，或让浏览器流程绕过统一访问 policy；
- 让 source、parser 或 LLM adapter 执行文献身份与最终验收；
- 绕过 Agents provider 边界复制模型 adapter，或把 Agents 扩大为任意 prompt/workflow、长期 memory、Browser/CDP 接管接口；
- 与 `LiteratureContent` 平行的独立分析、分类或标签结果；
- 已撤销的 `DocumentPackage` 2.0 占位或实现；
- 可独立修改的文献状态列；
- 让 execution、failure、attempt 或外部 task 决定文献可用程度；
- 当前目标中的 Collection、membership、CollectionSelector、领域占位符或未经确认的 Zotero 式人工文件夹；
- 在 Metadata 阶段使用 LLM、搜索分数、关键词、摘要分类或低收益启发式判断相关性或提前停止；
- 用 accepted count 代替 Provider 原始 scan limit，或持久化 Discovery 过程计数、cursor、完整路径和完成时间；
- 让 DiscoveryRun 自动启动 PDF、Parsing、Analysis 或对每条结果执行逐篇全 Provider 补查；
- 持久化 BatchRun、BatchTarget、版本候选快照、普通目标失败、运行 Report 或批次统计；
- 让补全操作在运行中动态吸收新增目标，或因系统、Parser、LLM、取消和无法判断的失败切换 Literature 版本；
- 把手动 PDF 作为第四种 AcquisitionPath、静默替换现有主 PDF 或移动/修改用户原文件；
- 为收集、导入、处理或导出维护独立于统一逻辑文献数据库的平行权威结果集合；
- 依赖恢复旧 HTTP、浏览器、Parser、LLM、线程、队列或内存现场才能继续中断流程；
- 为 Acquisition 增加候选失败原因业务枚举、持久化候选尝试或平行主资产 `is_current`；
- SQLite 长事务包裹网络、浏览器、parser、LLM 或整批执行；
- 分布式 queue、worker、lease、heartbeat、fencing token 或 network exactly-once；
- 自动 parser 竞赛、合并和失败回退；
- 通用 extension 平台；
- 下游直接依赖内部数据库表。

## 10. 文档责任

- [产品需求](requirements.md)决定用户问题、核心能力、产品结果和验收场景。
- [设计文档](design.md)决定整体架构、模块责任、事实所有权、状态和业务协作。
- 本文决定全局目录、依赖、组装、跨模块运行约束和技术文档路由。
- [`technical/`](technical/) 下的模块文档分别决定各模块内部代码、Ports、适配器、持久化协作和专项验证。
- 项目 `README`、已实现入口的帮助文本、源码和测试说明当前已经实现的行为。
- 实施顺序、差距和逐项 TODO 只进入执行计划，不进入设计或技术文档。
