# 02 · 任务与协作控制技术设计

[设计总览](../design.md) · [八模块技术导航](../technical.md)

本模块对应设计中的 **② 任务与协作控制**，执行用户明确启动的维护操作。输入是操作范围、目标、预算和取消信号，输出是已提交结果、失败与未处理部分；它不决定文献身份、PDF 归属或知识内容是否有效。

内部包括应用生命周期、来源发现协调、补全阶段、durable Jobs 和人工介入协调。②调用③④⑤的公开能力，按需协调⑧；⑥的普通查询不进入维护调度。Network 和 Logging 是所有模块共享的支撑，本篇集中记录它们的技术合同，未将其业务所有权并入调度器。

当前同步 completion 与 durable Jobs 有各自合同；已有 Job 持久化不代表客户端断开后必有后台继续执行。所有关闭、恢复与提交结果以本篇对应合同为准。

本篇目录：

- [1. 模块边界与连接](#1-模块边界与连接)
- [2. 生产组装与应用生命周期](#2-生产组装与应用生命周期)
- [3. 发现操作与范围合同](#3-发现操作与范围合同)
- [4. 数据库补全与阶段协调](#4-数据库补全与阶段协调)
- [5. 报告、取消、并发与恢复](#5-报告取消并发与恢复)
- [6. 跨模块调用与协作约束](#6-跨模块调用与协作约束)
- [7. 共享支撑：受控网络访问](#7-共享支撑受控网络访问)
- [8. 共享支撑：安全日志](#8-共享支撑安全日志)
- [9. 整体协作验证](#9-整体协作验证)

## 1. 模块边界与连接

统一接口① → 本模块 → 文献③ / 文档④ / 知识⑤ / 浏览器⑧；状态和报告不替代业务事实。

本篇按职责归并已有详细合同；示例中的现有类型与目标类型保持各自状态。文档归属不改变源码目录、事实所有权或当前公开 API。

## 2. 生产组装与应用生命周期

### 2.1 结构与实现映射

当前活动目录为 `apps/server/src/entry/` 与 `apps/server/src/cli/`，例如 `discovery.ts`、`literature-completion.ts`、`content-analysis.ts`、`selectors.ts`、`bibliography.ts`、`bibliography-export.ts`、`artifact-export.ts` 和 `main.ts`。`apps/server/src/application/` 提供生命周期与 durable jobs；它调用 Entry，不改变 Entry 的业务所有权。

`discovery.ts` 组织来源发现，`database-completion.ts` 拥有完整冻结操作，`completion-execution.ts` 控制串行提交，`pdf-acquisition.ts` 拥有操作内层级协调，`literature-completion.ts` 推进单目标，`content-analysis.ts` 连接提案与 Literature 接纳。Jobs 新建任务共享冻结范围和 Meta 版本候选，运行时调用完整操作；Job 自有预算、租约、尝试、事件和干预策略。

### 2.2 全局技术形状

SciRetriever 使用按功能模块组织的 TypeScript/Node 模块化单体：

- Node 22.19.0，包管理器为 pnpm；
- `packages/contracts` 提供中性合同，`apps/server` 提供生产服务与 CLI，`apps/web` 提供工作台；
- 保留既有核心与共享基础，新增 Document/Evidence、Retrieval/Context 责任，扩展 Analysis 与 Agent/人类接口；
- 模块内部使用 Ports/Adapters 隔离外部能力，不建立项目级技术分层目录；
- `configuration/` 与 `bootstrap/` 分别是运行配置与生产组装模块；公开调用以 `apps/server/src/index.ts` 的包导出和模块构造入口为准，不要求每个目录人为增加 `index.ts`；
- Logging 使用显式 `createLogger(component, sink, minimum)`，不修改全局命名空间；日志默认走 stderr，稳定结果与 JSON 走 stdout；
- SQLite 保存关系事实、事务和当前关系；统一读取结果由 Storage read projection 组装，不建立独立可写 SQL view；
- 同一存储根保存不可变原始材料与派生产物；新证据引用按 Document/Evidence 与 Storage 的版本依赖设计保留/失效/回收，不能套用旧结果无条件回收；
- 一个主机、一个 catalog 同时只允许一个修改核心文献事实的执行；
- 查询和只读导出可以并行读取已经提交的事实；
- 不预设分布式 worker 或外部工作流平台；客户端断开后的存续服务需求待定，不据现有 Jobs 自动承诺 daemon。

SQLite 与文件系统组成一个逻辑文献数据库，但拥有不同物理责任。SQLite 不保存大型 BLOB；文件系统对象通过规范化相对路径与 SHA-256 关联到数据库事实。

这套逻辑文献数据库保存跨操作共享的事实；模块仍各自拥有业务决定。查询和只读导出直接读取一致 snapshot；会改变数据库的 Entry 操作把用户请求与当前 snapshot 组合成实际目标，复用已经有效的事实，只为缺失或明确失效的步骤调用外部能力；事实所有者验证结果后，Storage 才把新事实提交到 Catalog 与 ArtifactStore。新的 DiscoveryRun 和导入同样通过当前数据库完成身份命中、去重和接纳，不建立平行结果集合。

[ADR 0013](../decisions/0013-decoupled-discovery-and-database-maintenance.md)进一步把持久化 DiscoveryRun 与进程内数据库补全操作分开，并删除没有当前产品需求的 Collection。外部发现结束于元数据入库，不自动开始 PDF 或内容处理；数据库补全可以从全库、历史发现、导入、查询或明确 ID 独立启动，只在当前进程内展开 selector、冻结目标与候选并形成 Report。普通范围按 MetaLiterature 去重，只有稳定缺失才跨版本回退。手动 PDF 是 Acquisition 的独立接纳操作，不属于自动三阶段。

网络、浏览器、Parser、LLM 和 vendor 调用在事务外发生，并以开始时读取的 ID/hash 绑定输入；提交前重新检查 current facts，过期结果拒绝写入。重启后重新读取当前数据库并重新选择实际目标，不恢复旧 HTTP 请求、浏览器页面、Parser/LLM task、线程、队列或内存现场。具体长期约束见 [ADR 0011](../decisions/0011-literature-database-centered-incremental-maintenance.md)。

Provider 的目标能力集合、领域发现启用边界、Acquisition 证据路由以及本地凭据合同由 [ADR 0014](../decisions/0014-capability-scoped-providers-and-local-credentials.md) 约束。Metadata 与 Acquisition 是两个不互斥的 Provider 能力，不建立第三类 Citation Provider；Provider、Agents 模型服务、可选 CloakBrowser Pro 与远程 MinerU 密钥只从 `~/.sciretriever/credentials.toml` 注入，核心服务 secret 与规范 origin 精确绑定，凭据状态与连接测试都不是文献数据库事实。

[ADR 0015](../decisions/0015-publisher-aware-tiered-pdf-acquisition.md)进一步把原文访问方识别、运行时计划与执行分开。缺 PDF 目标按有界 cohort 严格执行 Public → Authorized API → Browser admission；API 按官方 quota policy，Browser 使用一个 operator-managed 持久身份 Profile、一个共享 Browser process/context 和单一 `browser-generic` 限速组。Resolution、Plan、route hint、Browser queue/runtime/circuit 只属于当前操作，不进入文献数据库；Browser 自己管理的认证状态只留在 owner-only Profile 中。具体唯一 runtime 与固定身份由 ADR 0016 修订，通用 Agent route 由 ADR 0023 修订。

[ADR 0016](../decisions/0016-cloakbrowser-fixed-identity-runtime.md)把生产 Browser runtime 切换为 CloakBrowser patched Chromium，同时保留 Playwright API、一个长期 Profile/process/context、原始出口、Provider 调度和 Network guard。Profile 使用固定设备身份；经证据确认的 challenge dependency 只在发起页面、frame ancestry、当前文章 permit 和页面生命周期内加载，Challenge 与普通页面使用同一 Observation/Action/capture 合同。

[ADR 0017](../decisions/0017-shared-agents-and-controlled-browser-agent.md)把 Analysis 与 Browser 共用的 Agents 基础收敛为 Provider-neutral、无状态、一次只执行一个模型调用的 Runtime。每个 role binding 冻结 model、capability 与默认 reasoning effort；显式配置模型目录读取短生命周期经过 Network 且不持久化。Analysis 保留各分析用例的编排、prompt/schema 和验收，旧两阶段 controller 继续约束兼容路径；Acquisition 保留唯一 `AgentBrowserController`、动作语义和进展判断；Network 唯一生成 Observation、执行动作、capture 和 cleanup。ADR 0023 已删除 Publisher 规则 controller 与双路径选择。

#### 2.2.1 活动代码结构

当前活动生产源码以 TypeScript 为准：

```text
packages/contracts/
  src/
  test/

apps/server/src/
  acquisition/   analysis/      agents/        application/
  bootstrap/     browser/       cli/           configuration/
  entry/         literature/    logging/       metadata/
  network/       parsing/        storage/       workbench/

apps/web/src/
```

`packages/contracts` 是跨模块中性合同的当前归属；当前没有活动的 `apps/server/src/model/` 作为共享 Model 目录，也不以 Python `src/sciretriever/` 作为目标路径。`bootstrap/` 负责生产对象图，`configuration/` 负责固定用户配置与凭据，`entry/` 负责用户操作边界，`application/` 负责应用生命周期与 durable jobs，`workbench/` 负责工作台运行边界。实际公开 surface 以源码导出为准，不因目录存在就推断已提供稳定 API。

解析后端必须位于 `parsing/backends/<name>/`；不要把某个后端提升为 Parsing 公共模块。目标架构与当前实现的差异见 [TypeScript 架构锚定基线](../typescript-baseline.md)。

#### 2.2.2 模块内部约定

核心功能模块按实际复杂度选择以下内部文件或目录：

- `index.ts`：其它模块和 `entry` 可以调用的公开操作；
- `service.ts` 或按用例命名的文件：本模块用例编排；
- `*-rules.ts` 或具体规则文件：纯业务判断；
- `ports.ts`：本模块消费的外部能力和兼容性接口；
- `providers/`、`sources/`、`backends/<name>/` 等明确目录：本模块专属适配器。

这些名称不是强制模板。简单模块可以合并文件，复杂模块可以按明确责任继续拆分；不得为了目录对称创建空实现或虚假公开 API。

### 2.3 全局依赖方向

下面是既有模块的 import 方向；新增知识职责在图后规定逻辑依赖，不预先虚构物理目录：

```text
apps/server/src/entry ------> metadata / literature / acquisition / parsing / analysis
apps/server/src/entry ------> packages/contracts
apps/server/src/application -> entry

metadata -------------------> packages/contracts + network
literature -----------------> packages/contracts
acquisition ----------------> packages/contracts + network
parsing --------------------> packages/contracts + network
analysis -------------------> packages/contracts + agents
agents ---------------------> packages/contracts + network
network --------------------> packages/contracts
storage --------------------> packages/contracts

runtime modules ------------> logging
logging --------------------> Node standard library only
```

专属适配器使用以下受控方向：

```text
metadata adapters ----------> metadata ports + network
acquisition routes ---------> acquisition ports + network
parsing backends -----------> parsing ports + network
analysis -------------------> agents public API
acquisition browser --------> agents public API + network
agents providers -----------> agents ports + network
entry codecs ---------------> entry ports + packages/contracts

storage adapters -----------> 消费模块的 ports + packages/contracts
bootstrap ------------------> 全部模块的公开构造入口
bootstrap ------------------> logging public API/configuration
```

新增责任沿用公开边界与 Ports：

- Entry 编排 Parsing → Document/Evidence，以及显式请求的 Analysis/综合；Retrieval/Context 只读取已有知识。
- Document/Evidence 消费已确认身份、资产和中性解析结果；Analysis 消费文档/证据读取合同；Retrieval/Context 消费元数据、文档与知识的读取合同。消费者声明所需 Port，Bootstrap 通过公开 API 或所属 Storage adapter 组装，不反向导入私有实现。
- Agent 与人类 adapter 共享 Entry/知识读取服务；配置和 Browser 控制意图分别交 Configuration 和服务端运行时 owner。UI 不直接调度模型、发布文件或写 SQL。

全局依赖规则是：

1. `packages/contracts` 只依赖声明性类型、解析逻辑与必要的 Node 标准库能力；
2. 功能模块的规则和用例只依赖本模块、`packages/contracts`、logging 公开 API、本模块声明的 Ports，以及经过 ADR 0017 允许的 `agents` 中性公开 API；
3. `entry` 是跨功能模块顺序编排的唯一位置；
4. 功能模块之间的业务调用只使用对方公开入口和中性合同，不导入对方私有规则、用例、Ports 或适配器；
5. 规则和用例不得直接使用 `node:sqlite`、SQL、绝对路径、HTTP response、Playwright、vendor SDK、环境变量或 TOML；
6. SQL 和 `node:sqlite` 只存在于活动 Storage 实现，最终文件创建、对账和回收只存在于 Storage 边界；
7. 共享 URL、DNS、redirect、HTTP 和浏览器执行只存在于 `network/`，供应商专属协议和页面步骤留在消费模块的适配目录；
8. Vendor、HTTP、浏览器、SQL、MinerU 和模型协议私有类型不得进入模块公开 API、规则、用例或中性合同；Agents 中性交换值不得携带 Literature、Publisher、Page、Cookie、任意 callable 或消费模块业务枚举；
9. `storage` 只实现功能模块定义的持久化 Ports，不形成身份、验收、状态或导出资格决定；
10. 除 `packages/contracts` 外的目标生产模块只通过 logging 公开 API 获取 logger；Handler、formatter、最终脱敏 Filter 和 logger 配置只存在于 `logging/`，该模块只依赖 Node 标准库；
11. 任何完整快照或下游导出不得成为核心身份、状态或处理完成的前置条件；
12. 所有产品操作读取并更新同一个逻辑文献数据库；模块不得维护可与当前数据库事实漂移的平行文献结果或处理完成状态。

### 2.4 Ports 与生产组装（目标合同）

本节描述应由 TypeScript Bootstrap 形成的唯一对象图；它不证明审查快照中的每个对象已经接线。当前实现状态见 [TypeScript 架构锚定基线](../typescript-baseline.md)。

Port 由消费能力的模块所有：

| 消费模块      | Port 范围                                                                                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry`       | DiscoveryRun repository、selector/current-facts read、write admission、clock、literature metadata codec、原子用户文件输出；目标、候选和 Report 只在内存形成                                                                               |
| `metadata`    | metadata search、metadata reference query、observation publication                                                                                                                                                                        |
| `literature`  | literature repository、read model、artifact read、identity transaction、reference/support publication、content acceptance publication、import/export publication                                                                          |
| `acquisition` | route adapter、临时获取、Asset 与 LiteratureAsset 原子 publication、自动获取耗尽事实 publication/clear；Resolution、Plan、route hint 和 Browser queue 只在模块/Entry 当前运行内存中形成                                                   |
| `parsing`     | parser                                                                                                                                                                                                                                    |
| `analysis`    | Agents structured-text capability；第一阶段元数据提案、第二阶段内容 Markdown 草稿和完整待验收提案都是临时结果，不拥有持久化 publication                                                                                                   |
| `agents`      | 从任务所选 Model 与 Provider 解析出的 role binding、provider/model 协议的单次执行、capability/readiness、有界非持久模型目录读取、客观单次 limits、取消和稳定失败；不拥有用户 Model 配置、任务级模型覆盖、文献或 Browser workflow/业务结果 |

禁止建立顶层共享 `ports/`、`repositories/`、`utils/` 或笼统 `integrations/` package。

Bootstrap 边界（`apps/server/src/bootstrap/application.ts`、`workbench.ts` 与 server 包导出）是唯一生产对象图组装
点，负责把以下具体实现注入模块公开构造入口：

- `node:sqlite` repository 与 publisher；
- 文件系统不可变发布、verified artifact reader 与原子用户文件输出；
- metadata search、metadata reference query 和 Acquisition route adapters；
- 当前进程共享的 Access Coordinator、secure HTTP、Publisher access profile catalog/Planner、tiered cohort orchestrator 与 Browser scheduler/session broker；只有存在经过生产准入的 Browser route 时才注入受控浏览器 adapter；
- `parsing/backends/mineru/` 中按 ParserBackend 构造的 MinerU parser backend；
- 一个共享无状态 Agents runtime，并按 Analyze/Browser 所选 Model 的 Provider 构造一或两个具体模型 adapter 与 role binding；同一 Provider 复用 adapter，不同 Provider 分别绑定，再向 Analysis 和唯一 Agent Browser controller 注入同一调用面；
- BibTeX、RIS 和 CSL JSON codec；
- 本机写锁、时钟和资源预算。

Logging 当前公开函数是 `createLogger(component, sink?, minimum?)`，默认输出 stderr；生产统一配置和更丰富 formatter 属于 Logging 的设计责任，不能虚构已存在的 `configure_logging`。注入 sink 是技术输出边界，不是文献业务 Port。

完整维护对象图中的获取能力必须共享 Network coordinator、Browser session broker 和相同配置。`createQueryApplication` 则只组装 Library/Artifact reader，不能先构造维护图再屏蔽写入方法；当前 TS 没有名为 `ASSET_COMPLETION`/`CONTENT_COMPLETION` 的公开构造模式。当前发布的 Publisher profile catalog 保存授权 API、访问 origin、稳定身份和可选 Publisher 首页 probe 证据；它不生成 Browser 下载 route。生产 Browser 只有 `browser:generic`、`browser-generic` policy 与唯一 `AgentBrowserController`。目标生产对象图只在普通 `[browser]` 已启用、Browser Model、选中且安全存在的固定身份 Profile、CloakBrowser wrapper/经验证 binary、Playwright API 与 headed display 同时就绪时构造 Browser client，并据此动态设置 execution confirmation 与 runtime readiness；不存在 stock Chrome/Chromium fallback。普通文章流程允许已准入页面发起的必要子资源和受限 challenge dependency、丢弃未批准的第三方非关键资源，并逐项审查显式或点击/脚本导航 request；未再次暴露 route 的 native redirect 只能复用同页 live、已批准且预绑定的关联，并在读 terminal body 前取得最终 host permit。Configuration Publisher probe 使用生产 Network contract 加 deny-all capture policy，只证明首页可达性。所有文章共享一个 Profile 和一个 CloakBrowser process/persistent context，并在 `browser-generic` 中限速串行。production catalog、总开关、Model/Profile/runtime readiness、登录状态、机构 IP 与具体文章 entitlement 仍是分立事实。

模块公开入口不得构造具体 adapter，也不得读取全局配置。测试可以直接注入 fake ParserBackend；生产对象图只能由 `bootstrap` 构造。

Configuration 边界（`apps/server/src/configuration/index.ts`、`owner.ts`、`credentials.ts`）是唯一普通
TOML、非 secret 环境选择、统一凭据文件与 Browser Profile 生命周期入口。未知 section、key、
枚举或组合必须 fail closed；普通配置转换为 `OrdinaryConfiguration` 中不含 secret 的中性配置数据，再执行跨字段和运行环境规则。文献 Provider、Model Provider 与远程 MinerU secret 只从
`~/.sciretriever/credentials.toml` 读取并作为私有短生命周期值交给 Bootstrap；不保留 secret
环境变量回退。Browser Profile 只接受 opaque identity，Chrome 自己管理的 Cookie/认证内容不进入
TOML、Model 或 status。精确文件、权限、origin、readiness 和 CLI 合同见
[统一产品接口：共享支撑：配置与凭据](01-product-interface.md#5-共享支撑配置与凭据)。

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
browser
```

Source 的 Auto/Custom mode、Custom 精确顺序、Metadata 逐 Source limit、产品/database/edition、AccessPolicy 和联系邮箱留在普通配置；Auto effective catalog 只由版本内置常量解析，不读取 Network 或 credentials。Provider API key 与 token 只进入固定凭据文件，不能形成普通配置中的 `credentials` 责任组，也不能反向启用 Source。Secret 值不得进入 Model configuration、SQLite、ArtifactStore、provenance、Report、diagnostics、URL、文件名或用户输出。普通配置在 Application 启动时形成快照；已组装 adapter 在每次新请求派发前通过 Configuration owner 重新授权当前凭据，撤销不等到进程重启。adapter 决定允许附着凭据的 origin；`network` 负责 redirect stripping 和脱敏。

#### 2.4.1 新知识服务的输入绑定和发布

| owner             | 接收的已确认输入                                | 形成的事实                             | 对后续读取的保证                                 |
| ----------------- | ----------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| Acquisition       | 具体 Literature、复制后的候选字节、文章归属证据 | Asset + LiteratureAsset                | 原始材料不可覆盖；来源与 SHA-256 保留            |
| Parsing           | Asset ID/hash、解析选项                         | ParserResult 与中性资源闭包            | 后端私有 task 不越界；解析与分析独立             |
| Document/Evidence | MaterialRef 或 ParserResult                     | 文档表示版本、定位规则与可解析证据引用 | 引用固定精确材料/表示版本，不跟随 current 重绑定 |
| Analysis          | 冻结输入清单、用途/问题、方法和预算             | KnowledgeArtifact 与证据/覆盖          | 内容属于派生解释，不改写来源或删除材料           |
| Extraction        | 调用方 Spec、输入清单、外部候选和证据           | 校验/交付回执；按合同托管的候选        | 格式、证据解析与领域接纳分别表达                 |
| Retrieval/Context | 已发布事实、索引版本和读取预算                  | 临时查询/上下文结果                    | 缺口明确返回；索引不能反向成为事实               |

新对象的 schema/hash、读取和保留合同在各模块文档展开。先准备不可变字节，再短事务复核输入并提交事实/依赖；后续阶段失败不撤销前序已提交结果。有效证据依赖尚未保护时，不得启用相关产物的自动回收。Storage 执行业务 owner 的决定，不自行推导材料是否有价值。

### 2.5 明确不采用的机制

- ORM；
- 顶层共享 `ports`、`repositories`、`utils` 或笼统 `integrations` package；
- 让 Model validator 执行业务判断、I/O 或副作用；
- 让功能模块规则或用例直接访问 SQLite、文件系统、HTTP 或浏览器；
- 把浏览器当作 HTTP transport，或让浏览器流程绕过统一访问 policy；
- 让 source、parser 或 LLM adapter 执行文献身份与最终验收；
- 绕过 Agents provider 边界复制模型 adapter，或把 Agents 扩大为任意 prompt/workflow、长期 memory、Browser/CDP 接管接口；
- 无明确用途、输入/证据合同或事实 owner 的平行结果；不同粒度分析与指定集合综合按 ADR 0026 正式设计，不受旧单一 LiteratureContent 限制；
- 已撤销的 `DocumentPackage` 2.0 占位或实现；
- 可独立修改的文献状态列；
- 让 execution、failure、attempt 或外部 task 决定文献可用程度；
- 当前目标中的 Collection、membership、CollectionSelector、领域占位符或未经确认的 Zotero 式人工文件夹；
- 在 Metadata 阶段使用 LLM、搜索分数、关键词、摘要分类或低收益启发式判断相关性或提前停止；
- 用 accepted count 代替 Provider 原始 scan limit，或持久化 Discovery 过程计数、cursor、完整路径和完成时间；
- 让 DiscoveryRun 自动启动 PDF、Parsing、Analysis 或对每条结果执行逐篇全 Provider 补查；
- 把同步 completion 的 BatchRun、内存波次和 Report另建持久化体系；现有 execution Jobs/targets/attempts/receipts 按独立合同保留，不在此禁止；
- 让补全操作在运行中动态吸收新增目标，或因系统、Parser、LLM、取消和无法判断的失败切换 Literature 版本；
- 把手动 PDF 作为第四种 AcquisitionPath、静默替换现有主 PDF 或移动/修改用户原文件；
- 为收集、导入、处理或导出维护独立于统一逻辑文献数据库的平行权威结果集合；
- 依赖恢复旧 HTTP、浏览器、Parser、LLM、线程、队列或内存现场才能继续中断流程；
- 把获取尝试失败写成文献权威事实或增加平行主资产 `is_current`；已有 Browser durable candidate/receipt 是受控交付记录，须与业务 Asset 区分；
- SQLite 长事务包裹网络、浏览器、parser、LLM 或整批执行；
- 分布式 queue、worker、lease、heartbeat、fencing token 或 network exactly-once；
- 自动 parser 竞赛、合并和失败回退；
- 通用 extension 平台；
- 下游直接依赖内部数据库表。

### 2.6 Workspace 与公共边界

```text
packages/contracts/       # provider-neutral Model、canonical bytes/hash、cursor、稳定 failure
apps/server/              # Configuration、Network、Storage、Agents、Browser、Acquisition、业务与 Entry
apps/web/                 # 人工观看、控制权和状态呈现；不持有 Page/Context/CDP
```

`packages/contracts` 不读取 home、数据库、凭据或外部服务。`apps/server` 通过一个 Application composition
构造共享 Configuration、Network coordinator、FileStore、DB Worker、Agents 和各 repository。`apps/web`
只消费认证后的 Observation、Frame、Action、Transfer 和报告；Browser vendor 对象只存在于 server 的
Browser Host。

包的公开入口只导出文档化的中性 Application/contract API。Provider SDK、SQLite binding、Playwright/
CloakBrowser 类型、secret、绝对路径和内部数据库表不穿过公开入口。

## 3. 发现操作与范围合同

### 3.1 DiscoveryRun 编排

每次外部领域搜索或引用扩展创建一个即为 `RUNNING` 的 `DiscoveryRun`，本体只保存 ID、类型化输入、状态和开始时间；运行中逐条提交已经接纳的结果，结束时保存每个 Provider 的稳定终止结果和整体状态。完成后的输入、逐来源结果、发现对象和原因不可修改。本地 Literature 查询不创建 DiscoveryRun。

DiscoveryRun 的公开结果只说明发现：它不携带 `advance_to`、目标状态或自动内容处理选项。用户需要 PDF 或内容时另行发起数据库补全操作。当前 Entry 不提供 Collection 或 membership API。

#### 3.1.1 领域发现

```text
查询文本/可选年份 + 每个 Provider 在整个 Run 内的 scan_limit
  -> 创建 topic DiscoveryRun
  -> 本次选择的全部 Metadata Provider 分别执行有界搜索
  -> 每条结果转换为 MetadataObservation
  -> Literature 使用稳定标识符及已解析 version_links 接纳身份和统一元数据
  -> Storage 原子保存 observation、文献事实、DiscoveryRun 结果与 topic 发现原因
  -> Provider relation 按返回顺序以最多 256 条的短事务批次保存
  -> 各 Provider 结果耗尽或达到自己的原始扫描上限后结束运行
```

`scan_limit` 在最低身份准入和去重前统计 Provider 返回的每条原始 item；缺少标题/DOI、重复或最终未接纳仍计数。自然耗尽形成 `EXHAUSTED`，达到上限形成 `SCAN_LIMIT_REACHED`，分页中途失败形成 `FAILED` 并携带稳定脱敏 failure；source result 不保存 ordinal、扫描/接纳/拒绝计数或输入中已经存在的上限。单个 Provider 失败不撤销其它 Provider 已提交结果，失败前已接纳页面保留。

Metadata 边界的 raw-item `accepted` 只表示该 item 已成功转换为中性 `MetadataObservation`，不等于 Literature 已接纳其身份和事实。Literature 仍可按最低身份准入或身份冲突合同拒绝 observation；这时不创建 DiscoveryResult，也不增加已接纳 observation 计数。Debug 日志保留 Literature 返回的稳定 `decision_reason`，但不记录 Provider 原始 item、标题、摘要或响应正文；该诊断不进入 Report、Catalog 或新的业务 schema。

所有 Provider 正常到达边界时 Run 为 `COMPLETED`，正常与失败并存时为 `PARTIAL`，全部失败时为 `FAILED`。用户在边界前停止或恢复时发现遗留 `RUNNING` 才为 `INTERRUPTED`；停止后不发起新页，已接纳结果不回滚，未完成 Provider 不生成 source result，也不保存 cursor 原地续跑。零发现结果仍可正常 `COMPLETED`。

领域运行不会对每个发现结果再执行 `N × Provider` 精确补查，也不会继续 Acquisition。Entry 不执行 LLM、embedding、搜索分数、关键词、摘要分类或连续低收益相关性过滤；只让 Literature 应用标题或 DOI 的最低入库条件。有实际内容但偏题的文献仍是有效 Literature，不进入 `NoUsableContent`。

`MetadataObservation.version_links` 只为已经能够稳定解析为具体 Literature 的同文献版本目标提供身份收敛证据。目标尚未出现在本地或当前结果中时，Entry 保存来源 observation，但不为版本连接自动补查全部目标、不创建占位 Literature，也不建立独立关系；后续 DiscoveryRun 获得目标后可以重新进行确定性身份收敛。

#### 3.1.2 引用发现

```text
具体 Literature 种子 + 方向/max_depth/result_limit + 每个 Provider 的 run-wide scan_limit
  -> 创建 citation DiscoveryRun
  -> Literature 解析本地种子身份
  -> Metadata 查询供应商引用关系
  -> 每条返回边形成独立 ProviderRelationObservation，并按顺序以最多 256 条的短事务批次保存
  -> Entry 只选择本次边界内的 observation
  -> 对选中关系的非本地端点：
       ├─ 本地精确命中：使用现有 LiteratureId
       ├─ 响应内联 MetadataObservation：交给 Literature 接纳
       └─ 其它情况：Metadata Search 后交给 Literature 接纳
  -> 目标获得 LiteratureId 后建立 Reference 与 ProviderRelationSupport
  -> 保存 DiscoveryRun 结果与直接引用原因
  -> 逐层继续，直到达到用户边界或没有新文献
```

`ProviderRelationObservation` 是供应商有向边的最小持久化单位，也是后续 DiscoveryRun 可以重新读取的单位。一次查询返回几十或上万条边时，每条仍形成独立 observation，但 Entry 只按供应商返回顺序组成最多 256 条的冻结 publication batch，避免逐边事务和无界长事务。批内失败整体回滚，正常取消在批次之间生效，先前批次已经提交的来源事实保留；这不会立即创建对应数量的 Literature、Reference 或 support。未进入本次边界、元数据不足或接纳失败的 observation 独立保留；它没有 expanded/status 字段，也不自行构成数据库补全目标。

已经保存的参考文献原文也可以成为明确引用发现的输入：

```text
MetadataObservation.reference_texts 或 LiteratureContent.references
  -> Analysis 形成临时 ReferenceLookup
  -> Literature 精确查询本地目标
       ├─ 命中：使用现有 LiteratureId
       └─ 未命中：Metadata 搜索 -> Literature 接纳 -> LiteratureId
  -> 建立 Reference 与对应文本 ReferenceSupport
  -> 记录本次 DiscoveryRun 发现结果与直接引用原因
```

`ReferenceLookup` 不持久化，本地已经精确命中时不强制调用外部供应商。无法提取可执行线索、Metadata 搜索失败或目标存在歧义时，只保留原文；后续新 DiscoveryRun 可以重试。供应商只返回自己的目标记录 ID 时，由 Metadata 适配器先取得相关文献的中性元数据，该 ID 不进入 Reference。

供应商结构化引用关系与供应商参考文献原文按数据语义区分，不按主动查询或默认携带区分。普通元数据响应即使带来新的 `ProviderRelationObservation`，也只保存来源事实；只有当前引用 DiscoveryRun 显式选中的 observation 才进入下一层，因此取得 B、C、D 的元数据不会自动递归创建 E、F、G。

引用发现的 `result_limit` 按不同 `MetaLiterature` 的 DiscoveryResult 计数：新入库和既有对象都计数，输入种子不计数，重复到达只增加 cause 而不增加结果数量。Citation cause 保存本次发现时实际引用方向的 `source_literature_id`、`target_literature_id` 和正 depth；创建时必须存在对应受支持 Reference，但完成后的 cause 作为历史事实独立存在，不长期依赖以后可能删除的 Reference。直接原因和 depth 足以表达发现链，Entry 不发布完整 DiscoveryPath。

### 3.2 DiscoveryRun 与运行时数据库补全

外部发现和数据库补全使用两组不同 Model，不能恢复旧的 `CollectionRun` 混合合同，也不预留当前没有产品需求的 Collection Model。

领域和引用发现的输入为：

```text
ProviderDiscoveryLimit
  provider_name: str
  scan_limit: int

TopicDiscoveryInput
  kind: Literal["topic"]
  query: str
  year_from: int | None
  year_to: int | None
  providers: tuple[ProviderDiscoveryLimit, ...]

CitationDiscoveryInput
  kind: Literal["citation"]
  seed_literature_ids: tuple[LiteratureId, ...]
  direction: Literal["references", "cited-by", "both"]
  max_depth: int
  result_limit: int
  providers: tuple[ProviderDiscoveryLimit, ...]

DiscoveryInput = TopicDiscoveryInput | CitationDiscoveryInput
```

`query` 去除边界空白后非空；年份为 1–9999 且范围有序。Provider 列表非空，名称非空且在一次输入中唯一，`scan_limit >= 1`。Citation seeds 非空且去重，`max_depth >= 0`，`result_limit >= 1`。Topic 输入不增加语言、文献类型、排序、相关度阈值或 Provider 私有查询参数。

`scan_limit` 是每个 Provider 在整个 DiscoveryRun 中的原始 item 上限，过滤、最低身份准入和去重前计数；它不在每个种子、深度或请求上重置。`result_limit` 只用于引用发现，统计种子以外按 MetaLiterature 去重的 `DiscoveryResult`；无论对象是新入库还是已经存在都计数，同一对象重复到达只计一次。这些字段只表达已经由 Entry 边界规范化的中性输入，不包含 vendor query、cursor、request/response 或搜索分数。

运行及结果合同为：

```text
DiscoveryRun
  discovery_run_id: DiscoveryRunId
  input: DiscoveryInput
  status: DiscoveryRunStatus
  started_at: UtcTimestamp

DiscoveryRunStatus =
    "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED" | "INTERRUPTED"

DiscoverySourceResult
  discovery_run_id: DiscoveryRunId
  provider_name: str
  outcome: DiscoverySourceOutcome
  failure: StableFailure | None

DiscoverySourceOutcome =
    "EXHAUSTED" | "SCAN_LIMIT_REACHED" | "FAILED"

DiscoveryResult
  discovery_run_id: DiscoveryRunId
  meta_literature_id: MetaLiteratureId

DiscoveryCause = TopicDiscoveryCause | CitationDiscoveryCause

TopicDiscoveryCause
  kind: Literal["topic"]
  discovery_run_id: DiscoveryRunId
  meta_literature_id: MetaLiteratureId
  metadata_observation_id: ObservationId

CitationDiscoveryCause
  kind: Literal["citation"]
  discovery_run_id: DiscoveryRunId
  meta_literature_id: MetaLiteratureId
  source_literature_id: LiteratureId
  target_literature_id: LiteratureId
  depth: int
```

`DiscoverySourceResult.failure` 复用[非持久化 Entry Report](#55-非持久化-entry-report)定义的 `StableFailure`；该公共失败类型从 `packages/contracts` 导出，Discovery 合同只引用它，不建立第二份失败合同。

`DiscoveryRun` 创建即为 `RUNNING`。所有 Provider 自然耗尽或达到扫描上限时为 `COMPLETED`，正常结束与失败并存时为 `PARTIAL`，全部失败时为 `FAILED`；用户提前停止或恢复时发现遗留运行才为 `INTERRUPTED`。零结果仍是正常完成。`DiscoverySourceResult` 自然唯一性为 `(discovery_run_id, provider_name)`；正常结束分别记录自然耗尽或扫描上限，分页中途失败即为 `FAILED`，此前已接纳结果保留。`failure` 只允许在 `FAILED` 时存在。未完成的 Provider 在 Run 中断时不生成 source result，已经完成的 source result 保留。

`DiscoveryResult` 自然唯一性为 `(discovery_run_id, meta_literature_id)`；引用输入种子本身不形成结果，既有数据库对象在本次被发现时仍形成结果。同一结果可以具有多个 cause。Topic cause 精确指向使该结果进入数据库的不可变 observation。Citation cause 中 `source_literature_id` 表示引用方、`target_literature_id` 表示被引用方，二者必须不同，`depth >= 1`；创建原因时对应受支持的权威 Reference 必须存在，但 cause 保存的是本次发现历史，不持久依赖以后可能因当前内容替换而删除的 Reference。直接原因和 depth 足以表达发现链，目标 Model 不建立 `DiscoveryPath`。

完成后的 input、source result、result 和 cause 不修改；Run 只允许从 `RUNNING` 进入一个终态。`StableFailure` 只保存稳定脱敏 code/reason/action/retryable，不保存异常正文。扫描、接纳、拒绝计数只在运行时用于执行边界，不进入这些 Model。

数据库补全的公开运行时输入为：

```text
BatchRequest
  selector: BatchSelector
  goal: BatchGoal

BatchSelector =
    AllPendingSelector(kind="all-pending")
  | DiscoveryRunSelector(kind="discovery-run", discovery_run_id)
  | ImportReportSelector(kind="import-report", meta_literature_ids)
  | QuerySelector(kind="query", query)
  | MetaLiteratureSelector(kind="meta-literatures", meta_literature_ids)
  | LiteratureSelector(kind="literatures", literature_ids)

BatchGoal = "ASSET_READY" | "CONTENT_READY"
```

每个 selector 只接受自己需要的字段；ID 列表非空、去重并保持用户顺序，`QuerySelector.query` 使用 Literature 查询模块的封闭 `LibraryQuery`，不接受裸 SQL 或自由字典。`AllPendingSelector` 选择当前仍可自动推进的对象，不选择需要 PDF 且已有自动获取耗尽事实的对象。`MetaLiteratureSelector` 允许版本选择，`LiteratureSelector` 严格处理明确版本；后者在目标需要 PDF 时也构成用户对该具体 Literature 的明确重试。不得恢复 `ids: tuple[str, ...] + details JSON + include_all_versions`，也不得向 selector 混入 goal、Provider、并发、Parser、LLM、`force`、retry、cursor 或 `details`。

`ImportReportSelector.meta_literature_ids` 直接使用一次 `ImportReport` 返回的有序去重 `accepted_meta_literature_ids`。它不引用不存在的 ImportRun，也不要求 SciRetriever 保存 Report；同一进程可以直接传递该 tuple，跨进程时用户也可以从自己保留的 JSON Report 中明确提交这些 ID。Entry 每次仍重新验证 ID 并读取 current facts，不能把旧 Report 当成目标状态。该 selector 与手工构造 `MetaLiteratureSelector` 的执行语义相同，只保留“来自本次导入结果”的输入意图。

Entry 展开 selector 后，只在当前进程中持有不可变目标 tuple 和每个 MetaLiterature 的有序 Literature 候选。目标和候选是编排私有运行数据，不形成 `BatchRun`、`BatchTarget`、`LiteratureCandidateSnapshot`、`BatchStatus`、`BatchTargetResult` 或 counts Model，也不进入 Catalog。运行期间范围变化不会修改该 tuple；重跑重新展开 selector。

自动 PDF 获取耗尽是不同于运行数据的当前事实：

```text
AutomaticPdfAcquisitionExhaustion
  literature_id: LiteratureId
```

它没有 reason、Provider、candidate、配置 hash、时间、次数或状态字段。只有 Acquisition 正常遍历全部当前自动路径时才能建立，提交成功后才允许返回 `NoPrimaryPdf`；新 MetadataObservation、自动或手动主 PDF 成功、用户明确重试时清除。它不进入 `LiteratureStatus`，只允许查询投影 `needs_manual_pdf = true`。

处理型 Entry 操作使用[非持久化 Entry Report](#55-非持久化-entry-report)的精确 typed Report。纯查询直接返回查询结果，不另外包装 Report；Acquisition、Parsing 和 Analysis 作为数据库补全内部阶段时返回各自公开结果，由 Entry 汇总到 `DatabaseCompletionReport`，不形成嵌套运行报告。

### 3.3 发现与执行结构

`DiscoveryRun` 与运行时数据库补全输入的精确合同见 [DiscoveryRun 与运行时数据库补全](#32-discoveryrun-与运行时数据库补全)。不为同步 completion 恢复 `CollectionRun`、Collection、membership、`CollectionSelector`、`BatchRun`、`BatchTarget` 或任意 execution `details`。已有 TS execution 的 Job、target、attempt 和 durable candidate/receipt 是独立受支持合同；禁止把同步内存报告复制为另一套持久化批次，也不能删除已有 execution 数据。DiscoveryRun input/source outcome/cause 和 BatchSelector 使用各自封闭判别联合；补全目标、候选和 Report 只服务当前进程。

## 4. 数据库补全与阶段协调

### 4.1 内容处理编排

普通范围先形成 `MetaLiterature` 目标，再按[处理范围与目标](#42-处理范围与目标)在内存中冻结具体 Literature 候选；用户明确选择具体 Literature 时直接形成单版本目标。以下流程始终作用于当前选中的具体 Literature，形成的事实不会转移到其它版本。

Entry 对每个目标仍从第一个缺失步骤继续，但不会让缺 PDF 的每篇 Literature 各自完整跑完
Public/API/Browser 后才处理下一篇。它先重读当前事实：已有主 PDF 的目标可以直接进入后续
Parsing/Analysis；缺少主 PDF 的当前具体 Literature 组成有界 PDF cohort。大型范围可以拆成
多个有界 cohort，但一个 cohort 内的风险层级屏障固定为：

```text
冻结并重读当前具体 Literature
  -> 初步 PublisherAccessResolution / AcquisitionPlan
  -> PUBLIC pass：全部缺 PDF 目标完成适用公开 routes
  -> 对未解决目标使用 landing/locator/identity hint 重新规划
  -> AUTHORIZED_PROVIDER_API pass：全部未解决目标完成适用官方 API routes
  -> 再规划与 Browser admission
  -> 只有允许升级的最小剩余集合进入 Browser scheduler
       └─ 唯一 browser-generic group 限速串行
```

较早在 Public 或 API 获得并完整提交主 PDF 的 Literature 不必等待整个 cohort 的 Browser
层结束，便可以在本机并发与单次资源边界内继续自己的 Parsing/Analysis；层级屏障只限制尚未获得 PDF
目标的风险升级。任何单篇都不能因为自己较早 miss，就在同 cohort 的低风险层尚未结束时
提前打开 Browser。Resolution、Plan、route hint、Browser queue 和 scheduler 状态都只属于
当前操作。

> **当前实现（chunk/cohort 编排）**：当前 `DatabaseCompletionOperation` 已按既有
> `execution.max_concurrency`（默认 4，范围 1–64）分割冻结目标，一块全部结束后才启动下一块。
> 块内 PDF acquisition preparation 使用 operation-local bounded cohort；主 PDF 接纳、
> ParserResult 发布、内容接纳、NoUsableContent 清理及耗尽标记修改经过同一个 operation-local
> 串行提交执行者。每个 chunk 带有 operation-local `generation` 与 `operation_id`，取消会拒绝
> 尚未开始的 cohort action；Browser delivery 另外经过 Application 共享的 FIFO lane，并在排队
> 期间检查 generation，关闭时先停止 admission 再 drain。缺 PDF 的 `CONTENT_READY` 目标在
> 生产对象图中会先走同一自动 PDF acquisition，成功后重新读取 Literature 才进入 Parsing/Analysis。
> `EntryPdfAcquisitionService.acquireCohort()` 对所有 participant 先完成 Public pass，再对剩余目标
> 完成 Authorized API pass，最后只把最小剩余集合交给 Browser；每一波终态按冻结索引排序后立即
> 交付，已经安全提交 PDF 的目标可以继续 Parsing/Analysis。该协调与共享 session broker 已由
> 离线 fake/loopback 直接测试覆盖；真实外部吞吐与 CloakBrowser 现场能力仍需独立证据。见
> [TS 架构锚定基线 1.5](../typescript-baseline.md) 与
> [ADR 0025 §5](../decisions/0025-typescript-entry-and-runtime-contract.md)。

当前操作会等待块内全部已启动 worker 和提交队列收束后释放写准入。取消时未启动块进入
`notStarted`，已启动并受控停止的目标进入 `interrupted`；排队的提交不会开始，已进入提交边界的
事实按 owner 的实际结果报告。Parser/Analysis 普通失败保留为单目标失败；发布、持久化或清理
完整性失败停止调度并优先于取消。报告各分区维持冻结顺序，进度 sink 失败不改变结果。
独立调用 TargetRunner/单篇服务保留原调用形式；只有批量操作注入共享提交执行者。

目标合同要求 Entry 按 `DatabaseCompletionOperation.max_concurrency` 将冻结目标的确定顺序切成
固定大小 chunk；最后一个 chunk 可以更小。一个 chunk 是一次进程内 cohort 协调范围，不是
持久 BatchRun，也不会跨进程恢复。每个 target worker 先绑定稳定 participant identity：缺
PDF 的 participant 提交当代 `AcquisitionRequest`，已有 PDF、已经满足目标、失败、取消或完成
的 participant 退出本代等待集合，因此已有 PDF 的 Literature 可以直接继续 Parsing/Analysis，
不会被同 chunk 的 Acquisition 等待阻塞。其余请求全部到齐后才调用一次
`prepare_primary_pdf_cohort()`。operation-local 单 worker coordinator 独立执行 cohort，target
worker 只等待自己的终态；因此触发 cohort 的最后一个 participant 也能在 Public/API 层结束
时消费自己的早期 receipt，不会被 coordinator 同步占住。receipt 按层级形成 Public、API、
Browser/final 波次，每个波次内按冻结 target 顺序交付，而不是按 route 完成或 worker 唤醒
顺序交付；前一波已经安全提交的目标可以继续下游，后续波仍受 acquisition 层级屏障约束。
coordinator 在 chunk 退出前确定性关闭，内部错误会解除所有等待者并清理尚未交付 receipt，
不能留下后台线程或永久等待。

MetaLiterature 的首选版本正常耗尽后，下一版本在同一 target 的下一代重新加入 cohort；
在旧兼容链中，`NoUsableContent` 完成原子清理后，同一 Literature 也在本次操作的下一代重新加入，并继续
携带 operation-local tried candidate keys。每一代的 prepare 可以有界并行，但所有
publication/exhaustion commit 仍经过一个 operation-scoped 串行 commit executor。预取消的
chunk 会让全部 participant 形成 `notStarted` 而不调用 Acquisition；已经形成的 receipt
必须 commit 或 discard，清理失败不能被中断结果掩盖。重复操作重新读取数据库当前事实，
不依赖上一轮 chunk、generation、request、receipt 或 route hint。

> **当前实现（Browser lane 与共享 runtime）**：生产 Completion 共享同一
> Planner/Profile catalog、tiered cohort executor、Browser scheduler 和 session broker。
> 当前生产 Application 已构造惰性 `BrowserHost` factory，并通过统一 acquisition port 接入
> Browser escalation、Network navigation admission、版本化 landing hint、Browser flow 和
> Intake/身份接纳；`BrowserDeliveryScheduler` 在同一 Application 内串行 delivery，使用
> `operation_id + generation` 拒绝过期排队请求，并在 Application close 时 drain；
> `BrowserSessionBroker` 是 Application 内唯一 Browser delivery admission。缺少 verified runtime
> 或 admission 时仍稳定 fail closed。真实 CloakBrowser 正路径和站点验证仍未运行；**offline seam 证据不能替代真实 runtime
> 证据**。见 [TS 架构锚定基线 1.2](../typescript-baseline.md)、
> [ADR 0025 §2](../decisions/0025-typescript-entry-and-runtime-contract.md)。
>
> 配置中心已实现 Browser 总开关、一个 operator-managed 持久 Profile、Agent Model、显式可见
> Browser 入口与本机资源 cap（由 Configuration owner 的直接测试覆盖）。该 cap 默认 `5`，只接受大于 `1` 的整数且不设上限。

`browser-generic` 自身始终并发 1。目标合同要求：总开关、Model、选中且安全存在的固定身份 Profile、CloakBrowser
wrapper/经验证 binary、Playwright API 与 headed display 同时就绪时，Bootstrap 才创建唯一
`browser:generic` client 并将 execution confirmation/runtime readiness 传入 Admission。目标合同规定 Browser 使用
当前机器正常网络出口和一个共享有头 CloakBrowser Chromium process/persistent context；无 GUI
Linux 由 Xvfb 提供虚拟显示，broker 关闭后清理 runtime 与临时下载工作区但保留 Profile。所有文章
由 `browser-generic` 限速串行；每篇文章使用隔离 page/handler。Entry 仍只消费 Acquisition 返回的中性
receipt 或脱敏 escalation summary，不接触 page、Cookie、Profile 路径/内容、CloakBrowser 或 Playwright 对象；
production catalog、Profile presence 或本地 runtime 就绪都不能证明已登录、机构 IP 或具体文章
具有 entitlement。目标对象图只构造唯一 `AgentBrowserController`，Agent 从第一次稳定
Observation 起决策；不存在 Publisher rule 或 fallback controller。Challenge 只是普通 page state；自动 clear、controller
动作、资源阻断、未解决页面和普通拒绝分别映射为稳定进度或 failure。Entry 只看到 route 的中性
结果，不读取页面证据，也不让 Agent 处理 login 或 MFA。产品没有用户可见 Browser 认证用例；
Entry 不自动登录或选择机构，页面动作仍完全由 Acquisition 决策、Network 执行。

`createApplication()`（`bootstrap/application.ts`）返回的 `Application` 是显式可关闭资源
（`Application.close()`）；需要 Application 的 CLI 操作（如 `complete`、文献查询与资产导出）
通过 `withApplication()` 在成功与异常路径调用 `close()`（`apps/server/src/cli/main.ts`）。
`config test` 使用独立的 `ConfigurationProbeSession`，由其 `finally` 关闭 probe session。
正常返回、稳定失败、用户中断或 presenter 异常都不能跳过 broker close；关闭失败必须作为系统清理问题传播，
不能把仍存活的 CloakBrowser Chromium/Xvfb、未释放的 Agent HTTP response、Profile runtime lease、临时下载工作区或 host/scope permit 留给
下一条 CLI 命令；持久 Profile 本身不属于临时资源，正常关闭不得删除。

当前 Application 的启动回滚与正常关闭共用一次清理：重复或并发调用返回同一个 Promise，
关闭开始后 `browserHost()` 返回 `null`，不再创建宿主。清理保持依赖顺序，单项抛错后继续尝试后续资源，
全部关闭错误通过 `AggregateError` 保留。启动或 CLI 操作同时失败时，外层聚合错误以原始操作异常为
`cause`，并保留清理错误；只有操作失败时仍传播原始异常。CLI 将清理失败归为系统错误
（退出码 70，脱敏输出 `internal-failed`），不将资源关闭抛出的 `TypeError` 误报为用户输入错误。

每个实际 `Literature` 的结果继续按下面的缺失步骤消费：

```text
缺少当前主 PDF
  -> 进入当前有界 PDF cohort
  -> 分层 Acquisition
       ├─ AcquiredPrimaryPdf：继续 Parsing
       ├─ NoPrimaryPdf：自动获取耗尽事实已经安全提交；本版本稳定缺失
       └─ deferred/action-required/Network/API/权限/配置/Storage 错误：本次目标失败，不建立耗尽事实

已有 PDF，缺少当前 LiteratureContent
  -> 读取与当前 PDF hash 对齐的当前 ParserResult
       ├─ 已有且未要求重解析：复用
       └─ 缺少或明确重解析：Parsing 形成新结果并原子替换当前 ParserResult
  -> Analysis 第一阶段判断属于当前 Literature 的实际内容并确定最终 metadata
       ├─ NoUsableContent：旧兼容链可进入清理/下一候选；新独立分析只返回不适用，不删除材料
       ├─ FinalMetadataProposal：进入第二阶段
       └─ 无法判断或处理失败：保留 PDF，进入本次 Report
  -> Analysis 第二阶段使用 ParserResult 和已确定 metadata 形成正文与参考文献草稿
  -> 形成完整提案，交给 Literature 验收最终 metadata、sections 和 references
  -> 程序确定性渲染规范 Markdown
  -> 整体提交最终 metadata、当前 LiteratureContent、artifact 关系和 Analysis provenance
  -> 可独立、按需尝试参考文献 lookup
```

Entry 不自行判断 route、候选、Parser 中间结果、最终 metadata、内容 Markdown 草稿、LiteratureContent 或引用目标是否有效，只按模块公开结果决定下一次调用。Acquisition 对候选的实际 PDF 字节、reader 和页面树检查失败会自行删除临时文件并继续候选。Entry 只在 Acquisition 已正常结束全部适用 routes、不存在 deferred/action-required/未解决 route failure，并已安全提交 `AutomaticPdfAcquisitionExhaustion(literature_id)` 后接收无字段 `NoPrimaryPdf`；候选级原因不读取或保存。用户中断、timeout、临时服务错误、`429`/`Retry-After`/quota、Browser 登录/MFA/Challenge 未解决、Network/API/权限/配置错误、文件发布、数据库提交或 stale 复检错误进入稳定失败或待处理结果，不能降级为缺失或建立耗尽事实，也不能通过备用 Browser 入口绕开。

以下描述旧单篇兼容链与待修订实现，不作为新知识架构的清理授权：两阶段内容分析由 Analysis 保证顺序，Entry 不直接调用通用 prompt。当前代码仅在结构有效的 `NoUsableContent` 后进入清理；该联动需按 ADR 0026 拆除，已接纳材料的失效由独立 owner 决定。ParserResult 乱码、截断、只剩资源引用、无法判断、拒答、未知结构或调用失败都进入失败分支并保留 PDF。`ParserResult` 和第一阶段元数据提案本身都不推进状态；每个输入 Asset 只有一个当前 ParserResult，每个 Literature 只有一个当前 LiteratureContent。成功重处理在新结果完整接纳后原子替换当前关系但不建立历史，失败保留旧结果。替换 content 时同一提交清理旧 `ContentReferenceTextSupport`，并删除因此失去全部 support 的 Reference。Literature 整体接纳最终 metadata/content 后才达到 `CONTENT_READY`，这表示旧单篇兼容目标完成，不代表全部新知识用途完成。Reference lookup 和连接不参与三级状态推导。每个可持久化阶段成功后立即形成独立事实，后续失败不撤销权威元数据或 PDF。

旧同步 completion 对每个 Literature 维护内存中的 candidate tried set。旧清理路径在明确 `NoUsableContent` 时，当前 PDF、来源关系、ParserResult 和待验收结果直接删除，候选和无效决定不长期保存；该 Literature 在需要其它 PDF 时重新进入后续有界 acquisition cohort，tried set 只防止本次运行立即再次选择同一候选。新运行不恢复这个集合，允许根据当前元数据重新发现来源。已经达到 `CONTENT_READY` 的主 PDF 不自动被其它候选替换，补充资产也不进入本流程。

当前 Literature 的 Acquisition 最终返回 `NoPrimaryPdf` 并建立耗尽事实，或明确 `NoUsableContent` 后本版本候选全部耗尽时，MetaLiterature 目标才进入内存候选列表的下一 Literature。Network/Storage 系统错误、Parser/LLM 失败、取消或无法判断直接进入本次 Report 并停止该 Meta 目标，不能切换版本。

手动 PDF 使用独立编排：Entry 先解析明确的 `LiteratureId` 和用户输入文件，确认该 Literature 当前没有主 PDF，再调用 Acquisition 的 manual admission。成功整体提交 Asset、user provenance、唯一 `primary-pdf` 关系并清除已有自动获取耗尽事实，Literature 达到 `ASSET_READY`；不在该入口内自动继续 Parsing/Analysis。无效文件作为输入验证错误返回，用户绝对路径和原文件不进入持久化或清理范围。

### 4.2 处理范围与目标

同步数据库补全概念合同接受 `BatchRequest(selector, goal)`，其中 selector 使用判别联合表达逻辑范围，不使用通用 `ids + details JSON`：

```text
BatchSelector =
    AllPendingSelector
  | DiscoveryRunSelector
  | ImportReportSelector
  | QuerySelector
  | MetaLiteratureSelector
  | LiteratureSelector
```

- `AllPendingSelector` 选择整个数据库中尚无可用版本达到目标、且当前仍可自动推进的 MetaLiterature；
- `DiscoveryRunSelector` 选择该次发现实际接纳的 MetaLiterature；
- `ImportReportSelector` 接受一次 `ImportReport.accepted_meta_literature_ids`；它只携带调用方明确重新提交的有序 ID，不引用或要求持久化 ImportRun；
- `QuerySelector` 保存类型化本地查询条件，并在开始时解析结果；查询本身不形成 DiscoveryRun；
- `MetaLiteratureSelector` 和 `LiteratureSelector` 接受明确 ID 列表，前者允许版本候选，后者严格单版本。

同步 completion 的 selector 只在本次内存中固定；durable Jobs 按独立合同保存 selector/targets。selector 本身不携带 goal、Provider、并发、Parser、LLM、`force`、重试或 cursor。Entry 在写入准入保护下读取一个一致 snapshot，展开 selector、排除已经满足目标或当前不能自动推进的对象，并把实际目标 tuple 与版本候选冻结在当前进程内存。运行开始后不重新展开 selector，数据库新增对象或查询结果变化不进入本次操作。支持的内容目标为：

- `ASSET_READY`：补充当前主 PDF；
- `CONTENT_READY`：默认端到端目标；补充 PDF，经 Parsing、Analysis 和 Literature 接纳形成最终 metadata、轻结构化文档与规范 Markdown。

普通 selector 先按 MetaLiterature 去重。只要任一成员已经达到目标，该 MetaLiterature 就不生成实际目标；否则在内存冻结全部当前成员的候选顺序。排序键先比较完成度：`CONTENT_READY`、已有当前 ParserResult、已有当前主 PDF、没有派生结果；完成度相同时再比较 `published`、`accepted-manuscript`、`preprint`、`other`，最后使用稳定 Literature ID 作为确定性 tie-breaker。运行期间代表版本或成员状态变化不会悄悄改写内存队列；每次真正开始候选前仍重新读取 current facts，已经被其它提交满足时跳过。

需要 PDF 且已有 `AutomaticPdfAcquisitionExhaustion` 的具体 Literature 不进入 `AllPendingSelector` 自动目标。一个 MetaLiterature 只要还有未耗尽的可用候选，就可以按上述顺序处理；全部候选都已耗尽时，整个 MetaLiterature 从全库自动范围排除并通过 `needs_manual_pdf` 查询呈现。用户以 `LiteratureSelector` 明确选择这个具体 Literature 并发起需要 PDF 的目标时，视为明确重试，Entry 在开始自动获取前清除该事实；`DiscoveryRunSelector`、`ImportReportSelector`、`QuerySelector` 或 `MetaLiteratureSelector` 等宽范围 selector 不自动清除。

`LiteratureSelector` 不做 Meta 去重或版本回退。全库“补齐缺失 PDF/内容”的默认语义是为每个尚无可用版本的 MetaLiterature 取得一个优先版本；补齐全部明确版本需要用户逐个选择具体 Literature，不由普通 selector 隐式扩张。

当前 TypeScript `DatabaseCompletionService` 在 Application 共享的 `CatalogWriteAdmission` 内
冻结并执行本次操作；底层读取事务仍保持短事务。全库、查询和发现范围通过 Literature 的
`selectionSnapshot()` 一次读取命中版本及其完整 Meta 成员；Entry 再排除已有版本满足目标的 Meta，
冻结版本顺序。普通搜索与书目导出仍只包含实际命中的具体 Literature，不因为补全需要而扩大结果。
显式 Literature/Meta/import ID 的顺序和去重语义保持；运行期间不增加新成员或重排候选，
真正开始候选前重读 current facts，已满足目标时归 `skipped(already-satisfied)`。
宽范围遇到已有耗尽事实时保留事实且不重新请求获取，继续其它冻结的未耗尽版本；
只有具体 Literature 的明确重试允许在开始获取前清除。取消在读取后、清除前和获取前再次检查，
不把尚未启动的目标或尚未发起的获取悄悄推进。chunk 与 cohort 的当前实现见[内容处理编排](#41-内容处理编排)。

## 5. 报告、取消、并发与恢复

### 5.1 运行报告

目标架构要求每次有效的处理型 Entry 请求都在当前进程内形成 [非持久化 Entry Report](#55-非持久化-entry-report) 定义的 typed Report，并直接返回程序内调用方。纯查询的 typed read result 已经是完整结果，不再包装 Report；Acquisition、Parsing 和 Analysis 作为数据库补全阶段时返回各自公开结果，由 Entry 汇总到一个 `DatabaseCompletionReport`，不制造嵌套报告。当前 TypeScript CLI 与 Application 使用 `DatabaseCompletionService` 返回五分区报告；durable Jobs 在创建时保存同一服务冻结的目标和 MetaLiterature 版本候选，在显式运行时把仍可执行的目标交给完整 completion 操作，包含 chunk、cohort、层级屏障、回执波次与串行提交。Jobs 将操作结果映射到原有 target/attempt/event、预算和干预策略，仍返回自身的逐目标结果，不把同步 Report 持久化或改写既有 CLI/HTTP wire。旧 `schema_version: 1` Job 的已存单篇目标可继续运行。真实 Browser runtime 仍需独立现场验收。

生产 Browser 工作台只订阅当前显式获取操作：Entry 在冻结选择器后报告目标范围，并在目标开始和结算时投影当前目标与各分区计数；操作结束后投影同一个最终 `DatabaseCompletionReport`。这些会话反馈不创建持久 Job，也不改变报告对冻结目标的五分区归属。

Job 运行中，`DatabaseCompletionService` 在冻结操作全程持有 Catalog 写入准入。应用层决定的外部 pause/cancel 通过 Storage 的专用 `execution_control_job` 命令直接交给同一个 SQLite worker，以短事务原子改变 Job 状态；这条窄控制通道不发布文献事实，也不开放给一般 Job 结算或其它写入。它不等待长操作的写入准入，但仍由单 worker 顺序执行，并在关闭后拒绝。pause 仅从 queued/running 生效，cancel 可覆盖 paused，已取消 Job 不会被 pause 或运行终态覆写；每个后续目标在领取时原子检查 Job 状态，已在途目标继续结算并保留其有效提交。

目标 Entry 使用五种互斥 Report：

- `DiscoveryReport` 汇总持久化 DiscoveryRun 对应的当次 Provider 终止、过滤前扫描、已接纳 observation 和新增对象数量；
- `DatabaseCompletionReport` 对冻结目标做 `completed`、`failed`、`skipped`、`notStarted`、`interrupted` 五类不重不漏分区；`skipped` 携带稳定 reason（例如 `manual-pdf-required`），并单独列出本次曾明确清理无实际内容 PDF 的具体 Literature；
- `ManualPdfReport` 说明一个明确 Literature 的本地 PDF 已接纳或被正常拒绝；
- `ImportReport` 保留逐记录接纳/拒绝结果和可直接形成 `ImportReportSelector` 的 MetaLiterature ID；
- `ExportReport` 说明原子发布的具体 Literature、跳过项、字段损失和未发布对象。

它们只共享 `ReportEnd`：`finished` 表示到达正常边界但允许局部失败，`interrupted` 表示用户受控停止，`failed` 携带使整个操作提前结束的稳定脱敏 failure。Report 不设置 ID、时间、持续时间、通用 status、自由 details 或日志数组，也不复用 DiscoveryRunStatus 和已撤销的 Batch status/counts。

数据库补全从冻结目标开始就为每个目标保留一个且仅一个最终分区。停止信号到达时，正在处理的目标进入 `interrupted`，未开始目标进入 `notStarted`；目标已经提交 PDF 但随后 Parsing 失败时只进入 `failed`，PDF 仍由数据库事实表达。自动路径耗尽且需要用户介入的目标进入 `skipped(reason = "manual-pdf-required")`，不得把它写成普通失败。Report 中的成功、耗尽和失败只能来自模块 typed result 或稳定异常，不能通过解析日志文本推断。

Entry 可以在当前操作内维护脱敏的 acquisition 进度摘要，向实时 UX 说明当前 tier、允许升级的目标数、`browser-generic`/page state、限速等待、deferred 和 action-required；它不增加持久化 BatchRun 或候选历史。最终 `DatabaseCompletionReport` 的五个分区保持不变：Browser 登录/MFA/Challenge 未解决、quota 延期或其它 action-required 以对应目标的稳定 `code/reason/action/retryable` 进入 `failed`，不新增 Literature 状态或长期 failure 表。摘要和失败都不得包含 Cookie、临时 Browser 路径、完整 URL、selector、页面动作、短期 locator 或供应商原始响应。

Report 不写入 Catalog 或 ArtifactStore，不产生 BatchRun、BatchTarget、目标结果表或 counts 表，不参与 Literature 状态、自动获取耗尽、版本回退或下一次 selector 展开。CLI presenter 可以显示摘要或输出完整 JSON，但摘要数字必须直接取各结果 tuple 的长度，不能维护第二套可漂移计数。

#### 5.1.1 实时 Logging 与 Report 的关系

Logging 是 Report 之外的 best-effort 实时反馈。Entry 选择用户可理解的操作开始、阶段推进、目标完成、局部失败和受控停止信息；各运行模块通过 `sciretriever.logging.api.get_logger(__name__)` 输出安全诊断。业务模块始终先返回 typed result 或稳定 failure，Entry 独立累计 Report；日志被过滤、丢失或输出失败不能改变 Report、数据库提交、退出结果或下一次选择，Report 也不能通过回放 LogRecord 构造。

Entry 是正常模式下 PDF tier 与 Browser escalation 汇总的用户级 owner；Acquisition 内部的同一 tier/group 快照只在 Debug 保留，避免一次进度重复显示。Completion 为真正开始的目标记录诊断耗时，未开始目标明确显示 `elapsed_ms=-`；Discovery/Completion 的 finished、interrupted 或 failed 终态也显示本次操作耗时。这些值来自调用内单调时钟，不加入五类 Report 的 Model、JSON 或 Catalog，也不参与超时、排序或退出决定。

CLI 标准流严格分工：

- stdout 只承载命令的稳定主要结果，包括文本 presenter、完整 JSON Report 或明确的导出数据；
- stderr 只承载实时日志、进度和脱敏诊断；
- 日志 Handler 不得写 stdout，因此 JSON、BibTeX、RIS、CSL JSON 或其它可管道输出不会被进度消息污染。

Report 是稳定 Model；日志消息、level、格式、时间和可选上下文不是公共数据合同。日志不得复制完整 Report、文献正文、prompt、供应商响应或文件内容。程序内 API 只返回 Report，不调用 Logging 的生产配置、不修改宿主程序的 root logger，也不要求调用方使用 CLI presenter。

### 5.2 并发、中断与恢复

写执行在形成实际目标前通过 Entry 的 Write Admission Port 非阻塞获得核心写锁。锁由 Storage 实现；冲突立即返回稳定结果。

Selector 展开、Meta 去重、目标排除和候选排序在锁内的一致 snapshot 中完成，结果只成为内存中的不可变 target tuple，不写入数据库。之后释放读取事务但保持本次核心写准入；运行只消费该 tuple，不动态重查范围吸收新目标。

Entry 编排可以并行等待不同 `Literature` 的网络、浏览器、Parser 或 LLM，但必须：

- 遵守模块和 Network 的单次资源上限、取消与真实 timeout；
- 让所有外部访问经过 ADR 0012 的进程内共享 Access Coordinator，不把批量并发直接等同于供应商请求并发；
- 把缺 PDF 目标分成有界 cohort，并在 cohort 内执行完整 Public pass、未解决目标的 API pass 和最小剩余集合的 Browser admission，不允许单篇提前跨越层级屏障；
- 让 API 请求按官方 quota scope、并发、间隔、window 和 `Retry-After` 门控；让所有 Browser 文章进入单一 `browser-generic` group，并固定 `concurrency=1` 串行；
- 允许已经提交主 PDF 的目标继续后续阶段，但不因此撤销其它未解决目标的层级屏障；
- 通过单一提交队列串行 SQLite commit；
- 停止信号到达后不再启动新目标；
- 保留全部已提交阶段事实；
- 在能够执行收尾逻辑时把已完成、失败和尚未开始情况汇总进本次 Report。

正常结束、普通异常和用户受控中断都应尽可能返回截至当时的 Report。`kill -9`、断电等硬崩溃不保证生成最终 Report；下一次写操作重新获得锁、处理可能遗留的 `RUNNING` DiscoveryRun，并从当前权威事实重新形成补全目标。数据库中没有需要结束或恢复的 BatchRun。新操作不恢复旧线程、队列、HTTP 请求、浏览器页面、Provider cursor、Parser、LLM 调用、内存候选或 Report。

### 5.3 Ports

Entry 拥有：

- DiscoveryRun repository 与逐来源/发现结果 publication；
- 类型化 selector/current-facts 读取；目标冻结、版本候选和 Report 只在 Entry 内存中形成，不声明 repository；
- Write admission；
- Clock；
- Literature metadata codec；
- 面向用户目标文件的原子输出；Artifact verified reader 通过 `literature.api` 取得，不在 Entry 重复声明；
- 需要跨事实所有者整体提交的复合持久化 Port。

复合 Port 只接收各模块已经确认的 Model 决定。Entry 可以选择提交顺序和事务边界，但不在持久化适配器中隐藏业务判断。

### 5.4 错误边界

- 单个 provider 失败只影响该来源；
- 单个 `Literature` 的获取、Parser 中间解析或 LLM 内容判断与总结失败只影响该目标；
- 数据库不可用、无法获得写入准入、全部目标共同依赖不可用或无法安全保存结果属于本次操作级问题；
- 所有用户结果使用 `StableFailure` 的稳定 code/reason/action/retryable；
- 外部 adapter 在异常离开协议边界前完成稳定化和脱敏；Entry 把安全 failure 与稳定 ID 写入 Report，并可以选择把同一安全信息用于实时日志，不能把原始 SDK/HTTP/浏览器/Parser/LLM 异常对象交给 logger；
- 底层异常链可以保留在内存诊断边界，但保留因果链不等于把原始异常正文、response、URL、prompt、正文或凭据输出到 stderr；
- 意外的内部编程错误保留 traceback 并按顶层错误边界传播；已知外部失败不使用可能重新暴露原始 cause 的无条件 `logger.exception`；
- 明确无内容是业务决定，不归类为 LLM 调用失败。

### 5.5 非持久化 Entry Report

Report 是一次有效 Entry 请求开始后的最终运行回执，不是持久化运行、恢复 checkpoint 或文献事实。所有 Report 默认不可变、拒绝未知字段，只存在于当前进程；CLI 可以把它序列化到 stdout，程序内调用方直接接收 Model。项目不建立通用字段容器、Report ID、开始/结束时间、持续时间、自由 `details`、日志事件数组或可恢复状态机。

各 Report 只共享一个精确的最终停止值，不共享大而全父类或 envelope：

```text
ReportEnd = FinishedReportEnd | InterruptedReportEnd | FailedReportEnd

FinishedReportEnd
  kind: Literal["finished"]

InterruptedReportEnd
  kind: Literal["interrupted"]

FailedReportEnd
  kind: Literal["failed"]
  failure: StableFailure

EntryReport =
    DiscoveryReport
  | DatabaseCompletionReport
  | ManualPdfReport
  | ImportReport
  | ExportReport
```

`finished` 只表示 Entry 到达该操作的正常边界，不表示全部 Provider、目标或记录成功；局部失败保留在操作特有结果中。`interrupted` 只表示用户受控停止。`failed` 表示写入准入、共同依赖、Storage 或其它操作级错误使本次操作无法正常走到边界；已经形成的局部结果仍可保留在 Report 中，已经提交的数据库事实也不回滚。CLI 参数、输入文件路径或枚举在操作开始前验证失败时直接返回稳定输入错误，不伪造一份没有运行内容的 Report。

`StableFailure` 是 DiscoverySourceResult 和全部 Report 复用的稳定、脱敏失败合同：

```text
StableFailure
  code: str
  reason: str
  action: str
  retryable: bool
```

三个文本字段去除边界空白后必须非空。它不保存 traceback、原始异常正文、HTTP/SDK 对象、URL、header、Cookie、prompt、文献正文、文件绝对路径或自由 details；`retryable` 只给用户提供本次失败的重试提示，不形成自动重试状态。

#### 5.5.1 DiscoveryReport

```text
DiscoveryProviderReportOutcome =
    "EXHAUSTED"
  | "SCAN_LIMIT_REACHED"
  | "FAILED"
  | "INTERRUPTED"
  | "NOT_STARTED"

DiscoveryProviderReport
  provider_name: str
  raw_item_count: int
  accepted_observation_count: int
  outcome: DiscoveryProviderReportOutcome
  failure: StableFailure | None

DiscoveryReport
  kind: Literal["discovery"]
  end: ReportEnd
  discovery_run_id: DiscoveryRunId
  run_status: DiscoveryRunStatus
  providers: tuple[DiscoveryProviderReport, ...]
  discovery_result_count: int
  new_meta_literature_count: int
  new_literature_count: int
  new_metadata_observation_count: int
```

Provider tuple 按输入顺序且名称唯一；所有 count 均非负。`raw_item_count` 使用与 scan limit 相同的过滤前口径，`accepted_observation_count` 只统计已经成功接纳的来源 observation。`failure` 只在 provider outcome 为 `FAILED` 时存在；`INTERRUPTED` 表示已经开始但受控停止，`NOT_STARTED` 表示停止或操作级失败前尚未调用。前三种 outcome 与已经提交的 `DiscoverySourceResult` 对齐，后两种只属于当次 Report。

`discovery_result_count` 是本次按 MetaLiterature 去重的 DiscoveryResult 数量；其余三个 count 分别说明真正新建的 MetaLiterature、具体 Literature 和 MetadataObservation。Report 不保存扫描 item、结果 ID 列表、cursor 或完整发现路径。`run_status` 报告数据库中最后成功提交的 DiscoveryRun status；如果操作级提交错误使其仍为 `RUNNING`，`FailedReportEnd` 说明本次失败，恢复时仍按 DiscoveryRun 规则收尾。

#### 5.5.2 DatabaseCompletionReport

```text
CompletionTarget = MetaLiteratureCompletionTarget | LiteratureCompletionTarget

MetaLiteratureCompletionTarget
  kind: Literal["meta-literature"]
  meta_literature_id: MetaLiteratureId

LiteratureCompletionTarget
  kind: Literal["literature"]
  literature_id: LiteratureId

CompletionStage = "acquisition" | "parsing" | "analysis" | "literature"

CompletedCompletionTarget
  target: CompletionTarget
  literature_id: LiteratureId

SkippedCompletionTarget
  target: CompletionTarget
  reason: "manual-pdf-required" | "already-satisfied" | "not-eligible"
  literature_ids: tuple[LiteratureId, ...]

FailedCompletionTarget
  target: CompletionTarget
  literature_id: LiteratureId | None
  stage: CompletionStage
  failure: StableFailure

InterruptedCompletionTarget
  target: CompletionTarget
  literature_id: LiteratureId | None

NotStartedCompletionTarget
  target: CompletionTarget

DatabaseCompletionReport
  kind: Literal["database-completion"]
  end: ReportEnd
  goal: BatchGoal
  completed: tuple[CompletedCompletionTarget, ...]
  failed: tuple[FailedCompletionTarget, ...]
  skipped: tuple[SkippedCompletionTarget, ...]
  notStarted: tuple[NotStartedCompletionTarget, ...]
  interrupted: tuple[InterruptedCompletionTarget, ...]
  no_usable_content_literature_ids: tuple[LiteratureId, ...]
```

五个结果 tuple 对本次已经冻结的实际目标做不重不漏的分区，其长度之和就是实际选择数，presenter 直接按长度形成摘要，不在 Model 中再复制一组可能漂移的 counts。`CompletedCompletionTarget.literature_id` 是最终满足目标的具体版本。`SkippedCompletionTarget` 只用于明确未执行但不属于失败的目标，例如自动获取已耗尽、需要用户手动绑定 PDF，或目标已经满足；`reason` 必须稳定，不能用 `skipped` 隐藏系统错误。目标在失败、中断或从未开始时尚未进入具体版本，`literature_id` 可以为空。

以下 `no_usable_content_literature_ids` 与清理描述仅记录旧报告/实现语义，目标资产保留按 ADR 0026 执行；新产物不能沿用其清理授权。`no_usable_content_literature_ids` 按首次出现顺序去重，只说明这些具体 Literature 在本次至少有一个 PDF 被 Analysis 明确判定为 `NoUsableContent` 并完成清理；它可以与最终分区中的 `completed` 或 `skipped` 同时出现，不保存 PDF、候选、原因或次数。这样用户能够区分内容无效与调用失败，而不会把一次中间清理错误提升成最终目标状态。

Network 或 Storage 错误按当时消费它的业务阶段报告；开始处理实际目标前发生的共同能力错误进入 `FailedReportEnd`。`NoUsableContent` 删除当前无效候选并继续同一版本或下一版本，不单独成为最终目标 outcome；最终要么由另一具体 Literature 达到目标，要么进入 `skipped(reason = "manual-pdf-required")`，要么形成失败/中断。一个目标即使已经提交 PDF 后在 Parsing 失败，也只形成一项 `FailedCompletionTarget`，数据库中的 PDF 事实仍然有效。

#### 5.5.3 ManualPdfReport

```text
AcceptedManualPdfReportResult
  kind: Literal["accepted"]
  accepted: AcceptedManualPdf

RejectedManualPdfReportResult
  kind: Literal["rejected"]
  failure: StableFailure

ManualPdfReportResult = AcceptedManualPdfReportResult | RejectedManualPdfReportResult

ManualPdfReport
  kind: Literal["manual-pdf"]
  end: ReportEnd
  literature_id: LiteratureId
  result: ManualPdfReportResult | None
```

有效 PDF 完整提交后形成 `accepted`；目标不存在、已有主 PDF 或基本节件检查失败等正常输入拒绝形成 `rejected`，不增加第三种自动 AcquisitionResult。`FinishedReportEnd` 必须有一个 result；`InterruptedReportEnd` 或 `FailedReportEnd` 时 result 为空。Report 不保存用户输入路径，也不复制 PDF 字节。

#### 5.5.4 ImportReport 与 ImportReportSelector

```text
ImportAcceptanceOutcome = "created" | "enriched" | "matched"

AcceptedImportRecord
  kind: Literal["accepted"]
  record_index: int
  outcome: ImportAcceptanceOutcome
  meta_literature_id: MetaLiteratureId
  literature_id: LiteratureId

RejectedImportRecord
  kind: Literal["rejected"]
  record_index: int
  failure: StableFailure

ImportRecordReport = AcceptedImportRecord | RejectedImportRecord

ImportReport
  kind: Literal["import"]
  end: ReportEnd
  format: BibliographyFormat
  input_record_count: int
  records: tuple[ImportRecordReport, ...]
  not_processed_record_indexes: tuple[int, ...]
  accepted_meta_literature_ids: tuple[MetaLiteratureId, ...]
```

`record_index` 从零开始。Codec 先形成有序记录或逐记录格式失败，因此 `input_record_count` 在接纳开始前确定；`records` 与 `not_processed_record_indexes` 对 `0..input_record_count-1` 做不重不漏的分区。`created` 表示未命中并创建具体 Literature；`enriched` 表示命中后，导入记录至少提供了一个原本缺失的非空值，或以用户值替换了当前由供应商选择的值；`matched` 表示命中已有 Literature 且当前统一投影不变。首次出现但与当前 Provider 值相同的用户记录仍保存为 user observation；只有已经存在相同规范化 user observation 时才复用既有事实而不重复插入。格式不合格、缺少最低识别信息或稳定标识符明确冲突形成 `RejectedImportRecord`。前三种接纳结果都进入按首次出现顺序去重的 `accepted_meta_literature_ids`，单条拒绝不撤销其它接纳。对于 `CONTENT_READY` Literature，`enriched` 可以表示新导入 observation 已保存并将参与下一次完整 Analysis，不表示当前 metadata/content 已被拆开替换。

`ImportReportSelector` 只接受非空、去重且保持顺序的 `meta_literature_ids`；调用方可以直接复制 `accepted_meta_literature_ids`，空结果不形成补全请求。Report 本身不被 Entry 保存，也没有 ImportRunId。

#### 5.5.5 ExportReport

```text
SkippedExportRecord
  literature_id: LiteratureId
  failure: StableFailure

ExportFieldOmission
  literature_id: LiteratureId
  field: str
  reason: str

ExportReport
  kind: Literal["export"]
  end: ReportEnd
  format: BibliographyFormat
  selected_literature_ids: tuple[LiteratureId, ...]
  published_literature_ids: tuple[LiteratureId, ...]
  skipped: tuple[SkippedExportRecord, ...]
  not_published_literature_ids: tuple[LiteratureId, ...]
  omissions: tuple[ExportFieldOmission, ...]
  bytes_written: int | None
```

选择结果按最终具体 Literature 去重并保持导出顺序。`published_literature_ids`、`skipped` 和 `not_published_literature_ids` 对 selected 做不重不漏的分区；字段损失只用非空 `field/reason` 说明，不能用自由 details。导出发布是文件级原子操作：只有 staging file 完整 flush、`fsync` 并原子发布后，才能填充 `published_literature_ids` 和非负 `bytes_written`；中断或操作级失败时二者分别为空和 `None`，已经编码但未发布的 Literature 仍进入 `not_published_literature_ids`，旧目标文件保持不变。Report 不保存输出绝对路径或导出文件字节。

## 6. 跨模块调用与协作约束

### 6.1 跨模块运行约束（目标合同与治理门禁）

以下包括继续有效的不变量和明确注明的既有兼容合同。新增知识操作的精确 schema 尚待设计；旧 CLI 名称、三态状态或五类报告不构成新产品能力上限。按公开依赖和适配边界核对，不把目录、文档或计划状态当作已验收证据。

- 每项操作由用户请求和一致的当前数据库 snapshot 共同决定；查询和只读导出直接读取该 snapshot，会改变数据库的操作据此形成实际目标，新结果只有经过业务所有者验证并提交到同一逻辑数据库后才成为后续步骤的输入。
- 既有 CLI 合同使用 `discover`、`complete`、`literature`、`import`、`export`、`config` 六个一级名称；`literature` 保持只读，元数据文件和手动 PDF 分别通过 `import metadata/pdf` 接纳，书目元数据、当前主 PDF 和当前轻结构化 Markdown 分别通过 `export metadata/pdf/content` 导出。裸 `config` 打开交互式凭据管理器，公开子命令只保留 `status/test`，且不形成处理 Report 或文献数据库事实；内部模块名和通用 artifact 不形成一级命令。当前实现额外提供 `storage inspect|migrate|backup|restore-check`、`doctor` 和 `jobs create|run` 三个内部/operator 入口（`apps/server/src/cli/main.ts`）；这些是当前已存在的 operator/执行入口；迁移必须保留其已文档化行为，不能用上面的六类文献操作将它们删掉或假称不存在。
- `LibraryQuery` 只查询本地数据库并以具体 Literature 为结果单位；SearchItem/SearchPage、LiteratureAssetView、LiteratureDetail、LiteratureReferencePage 和 ReferenceDetail 是同一 snapshot 临时组装的不可变 read model，不建立持久化表、第二份 metadata/status、反向引用边或写入生命周期。大型 artifact 字节和可能无界增长的关系边使用独立读取。
- `LiteratureDetail` 只携带既有 Asset/ArtifactRef，不能执行 I/O。Literature 的 artifact reader 在 Storage 根内复核普通文件、size、hash 和 media type 后返回 context-managed 只读 stream；Entry 向用户目标导出时默认拒绝已有文件，并通过同目录 staging 原子发布。两者不访问 Provider、不修改数据库或形成处理 Report。
- 外部领域搜索和引用扩展各自形成 DiscoveryRun；本地只读查询不形成运行记录。DiscoveryRun 完成后不创建 Collection、不启动主 PDF/Parsing/Analysis，也不对每条发现结果执行全部 Provider 的逐篇精确补查。
- DiscoveryRun 本体只保存 ID、类型化输入、五态 status 和开始时间。每个 Provider 在整个 Run 内按过滤和去重前原始 item 执行 scan limit，只持久化自然耗尽、达到上限或失败；扫描/接纳/拒绝计数、cursor、完整路径和完成时间不进入合同。
- Metadata 只应用标题或 DOI 的最低入库条件，不通过 LLM、搜索分数、关键词、摘要分类或低收益启发式判断领域相关性；偏题但有实际内容的 Literature 不属于 `NoUsableContent`。
- 领域 DiscoveryRun 调用本次全部已启用、生产 adapter 已实现且 readiness 通过的 Metadata search 能力，不按 publisher 预先筛选；明确启用但缺少 adapter、必需普通参数、Provider 凭据或 AccessPolicy 时在开始前返回配置错误。引用查询只是 Metadata Provider 的可选能力，不建立 Citation Provider。
- 同步数据库补全以运行时 `BatchSelector + BatchGoal` 为输入，在当前进程内冻结实际目标；selector、目标、候选与 Report 不持久化。运行期间新增文献或查询结果变化不动态加入。按操作的 `max_concurrency` 将冻结顺序切成固定大小 chunk；不同目标可以有界并行，每个目标从自己的第一个缺失步骤继续，缺 PDF participant 按代组成有界 cohort，已有 PDF 目标可以直接进入后续步骤。Receipt 按 Public、API、Browser/final 层级波次提前交付，波内保持冻结顺序，并经 operation-scoped 串行提交边界消费；chunk、generation、coordinator 和 receipt 不跨进程恢复。TS 源码已实现 `DatabaseCompletionOperation`、固定大小 chunk、operation-local coordinator、三级层级 barrier、receipt wave、generation/operation metadata、Application 共享 `BrowserSessionBroker` 和五分区 Report。真实 Provider/CloakBrowser 现场运行仍是独立证据边界，标注见 [任务与协作控制：数据库补全与阶段协调](#4-数据库补全与阶段协调) 与 [TS 架构锚定基线 1.5](../typescript-baseline.md)。
- 普通范围按 MetaLiterature 去重并冻结有序 Literature 候选；先按 `CONTENT_READY`、已有 ParserResult、已有主 PDF 的完成度排序，同等完成度再按 `published`、`accepted-manuscript`、`preprint`、`other` 排序。只有稳定缺失才尝试下一版本，系统、Parser、LLM、取消或无法判断的失败不得触发回退。
- Provider 私有响应、PublisherAccessResolution、AcquisitionPlan、AccessRouteHint、下载候选、HTTP/Browser 现场、session health/circuit、Parser task、LLM 草稿、内存队列、冻结目标、运行报告和缓存不是文献事实，不得形成第二真相源；只有适用 ADR 明确接纳的中性结果进入 Catalog 或 ArtifactStore。
- 一个 Literature 可以关联多个长期保存的不可变 MetadataObservation，但只拥有一份当前 LiteratureMetadata；新增 observation 不覆盖来源事实，当前 metadata revision 只作为单调并发与内容对齐令牌，不形成旧统一元数据历史。LLM 最终提案只在完整内容接纳时替换当前元数据，不成为 MetadataObservation。
- 同步 completion 重跑重新读取 current facts，不保存它的内存 selector、波次与 Report。已有 durable Jobs 单独保存授权任务、冻结目标及版本候选、尝试和 receipt；运行时只对仍可执行的持久目标启动新的操作局部 cohort，不能恢复上一进程的波次或 Browser/网络/模型现场。这些执行记录不等于文献事实，也不授权纯查询恢复任务。
- 文献版本状态只从已提交的权威事实推导，不维护第二个可修改状态；具体规则见 [文献与材料：文献身份、元数据与引用](03-literature-materials.md#2-文献身份元数据与引用)。
- 现有 Literature 兼容状态为 `UNREVIEWED`、`ASSET_READY`、`CONTENT_READY`，文献引用解析不参与状态。新文档/知识能力按所请求产物、输入版本和有效性表达可用性，不能把全部用途压成旧单一内容完成态。
- Acquisition 正常业务结果只有已经完整提交主 PDF 和本次没有获得主 PDF；候选问题不形成长期原因，文件或数据库提交问题按系统错误传播。唯一 `primary-pdf` 关系就是当前主 PDF，不建立平行 `is_current`。
- 只有 Acquisition 正常遍历具体 Literature 的全部当前自动路径时才建立最小 `AutomaticPdfAcquisitionExhaustion`，提交成功后才返回 `NoPrimaryPdf`；该事实只保存 LiteratureId，不改变三级状态。`AllPendingSelector` 排除需要 PDF 且已有该事实的对象；新 MetadataObservation、成功主 PDF 或用户明确重试会清除它。中断、Network/API/权限/配置错误和 Storage 错误不得形成耗尽事实。
- Acquisition 分别执行字节/可读页面树检查与文章归属验收，不信任后缀、文件名或 HTTP 类型，也不判断学术内容；Analysis 的不适用判断、部分解析或失败不能单独触发已接纳材料删除；旧 `NoUsableContent` 清理链需按 ADR 0026 修订。错误文件/文章的失效由独立规则裁决。
- Acquisition 先形成访问方 Resolution 和按 Public、Authorized Provider API、Controlled Browser 分组的确定性 Plan；Planner 可以省略不适用 route，但不能自动提前 Browser。一个 cohort 的全部目标完成 Public 后，未解决目标完成 API，最后只有 admission 允许的最小集合进入 Browser；同一 Literature 不跨层竞速，较早提交 PDF 的目标可以继续后续步骤。
- Resolution 依据明确 AssetHint origin、arXiv ID/PMCID/PII 等来源稳定定位、Provider record identity 和必要时 DOI 安全解析后的实际 landing origin；publisher 字符串和 DOI prefix 只能作为弱提示。Metadata Provider、Publication/Access Provider 与 Access Platform 分开表达，凭据存在、认证成功和具体文献 entitlement 也必须分别判断。
- DOI/API/页面产生的 canonical landing、稳定文章 ID 或 locator 只形成当前运行的安全 `AccessRouteHint`；Cookie、token、签名 URL、vendor/page object 不进入 hint、日志、Report 或数据库。
- 手动 PDF 接纳要求 Entry 明确指定具体 Literature，复制而不移动用户文件，复用相同基本检查和唯一主资产 publication；它不进入 `AcquisitionPath`，无效输入不成为第三种自动 AcquisitionResult，已有主 PDF 时默认拒绝。
- 所有外部访问先经过 [ADR 0012](../decisions/0012-process-local-provider-access-scheduling.md) 的进程内共享 `NetworkBudgetCoordinator`。公开协议和 API 按 adapter 声明的官方 quota identity、并发、间隔、window/周期额度、reset boundary 和 `Retry-After` 执行；普通配置只能收紧。Browser 在唯一 `browser-generic` 中以 `concurrency=1` 按通用 interval/window/cooldown 串行；全局 Browser cap 只保护本机资源。等待 permit、session health 和 circuit 不形成 Literature 状态。
- Timeout、临时服务错误、`429`、有效 `Retry-After`、quota exhausted、Browser 登录/MFA 或 Challenge 未解决不能通过重试、新 Literature、popup 或备用入口绕过；只有全部适用 routes 正常结束且没有 deferred/未解决 failure 时才能提交自动耗尽。
- `config` 使用 `Models / Search / Download / Parse / Analyze / Browser / Status / Theme / Quit` 单词级首页；Models 拥有 Provider、Model 和模型 key，Search/Download 在具体 Source 对象页拥有普通参数、key 与 test，Parse 用 Setup 连续配置 MinerU，Analyze/Browser 用 Setup 选择 Model 和保存业务参数，Browser 另行拥有 Profile 与 Runtime。`config status` 只检查本地 Provider/Model/MinerU 普通字段、凭据 presence/origin 与静态 readiness，不调用 Network；`Models → Add` 在 key 就绪后自动读取一次有界模型目录且不保存结果，失败或空结果才回退 Manual。用户显式执行的 owner-scoped `config test` 与 TUI Test 共用无 Storage Probe 服务；实际外部调用仍经过同一 Access Coordinator、安全 HTTP、限速、redirect 与脱敏边界。Provider 目录不证明具体 Model，Download 无安全内容无关 probe 时明确报告 unavailable 而不借用 Metadata 或下载 PDF；Analyze/Browser Model probe 不发送用户文献或真实页面，MinerU probe 不上传 PDF，Browser Site 不进入 `--all`。结果只属于当次 CLI，不创建 DiscoveryRun、Report 或任何数据库事实，也不保存最后结果和时间；真实 Search/PDF/内容能力分别走 `discover topic`、`complete pdf`、`complete content`。
- Analysis 与 Browser 共用一个无状态 `AgentRuntime` 调用面；所选 Model 引用同一 Provider 时复用 adapter/credential，不同 Provider 时使用各自 exact-origin credential 与 adapter，role identity、日志与失败始终来自实际 binding。Model 只拥有远端 identity、reasoning、image 与 stream；stream 默认开启，OpenAI Responses、OpenAI Chat Completions 与 Anthropic Messages 精确继承该值，流式 SSE 只在 adapter 内重建为完整结果，失败后不切换模式重发。Analyze 的 strict structured output/业务预算和 Download 的 image/tool/当前生产 Observation 的 `image/jpeg`/安全限制由各模块派生，不形成用户 capability 配置或任务级 override。Reasoning 中性值覆盖 `default/none/minimal/low/medium/high/xhigh/max`；default 省略 wire 字段，显式值原样发送。Runtime 不从 bytes 猜 input tokens，只在 Provider usage 返回后验证 context；未知 adapter exception 稳定为 non-retryable `agent-internal`。Analysis 保留文献 prompt/schema、取消/失败 owner 和各用例完整验收；两阶段只约束旧单篇兼容路径；Acquisition 保留 Publisher policy、Browser action chooser 和稳定终态的 route 映射；Network 通过 article-local `start/apply` step session 唯一拥有 Observation readiness、exact dispatch、页面替换、Candidate/capture、timeout、cancel 和 cleanup，只跨层返回 `Ready/Captured/Blocked/Failed/Cancelled`。Agents 不形成公共任意 prompt、Page/CDP、session 或长期 memory 接口。
- 旧兼容 LiteratureSection 只结构化 H1/H2，正文继续保存 Markdown 字符串，缺失内容统一渲染“未提供”；这些渲染约定不限制新证据/分析产物的用途或粒度。
- 每个 Literature 的旧兼容路径维护一个当前 LiteratureContent，完整接纳后原子替换且失败保留旧结果；新知识产物按用途、粒度和输入版本区分，保留内容/hash/provenance 与证据，不能静默互相覆盖。
- 来源元数据和原始材料长期可靠保存；新文档表示及知识产物可以重建，但有效证据依赖不能无声断开。精确保留、失效、回收与恢复策略在 Document/Evidence、Analysis 和 Storage 合同中确定，不再以旧派生结果不留历史作为全部新产物的约束。
- 网络、浏览器、parser 和 LLM 调用发生在 SQLite 事务之外。
- 每个目标按阶段使用短事务提交，单个目标失败不回滚其它目标；执行边界见 [任务与协作控制：数据库补全与阶段协调](#4-数据库补全与阶段协调)。
- 文件先不可变发布，SQLite 后建立引用；失败最多留下不可见孤儿，不能形成缺失文件的有效引用；具体机制见 [版本化材料与知识存储：Catalog 与文件组织](07-versioned-storage.md#2-catalog-与文件组织)。
- 跨事实所有者需要原子提交时，各模块先形成已确认的 Model 决定，再由 `entry` 调用明确的复合持久化 Port；`storage` 只保存决定。
- 既有处理型 Entry 操作目标上直接返回 `DiscoveryReport`、`DatabaseCompletionReport`、`ManualPdfReport`、`ImportReport` 或 `ExportReport` 之一，纯查询直接返回 read result；`DatabaseCompletionReport` 使用 `completed/failed/skipped/notStarted/interrupted` 五个互斥目标分区，Report 终止值共享 `finished/interrupted/failed`。Report 不进入 Catalog，也不参与后续选择。Logging 独立写入 stderr，不能生成或替代 Report；硬崩溃不保证最终 Report。
- 所有外部失败在用户输出前转换为稳定、脱敏的 reason/action；只有 Accepted 设计明确要求长期保留的失败边界才进入持久化合同，底层异常文本不能成为业务合同。

### 6.2 显式维护与加工的设计边界

新增维护 facade 的每个操作必须先冻结意图和范围，再调用所需 owner。discoverMetadata只发现；acquirePdf只获取；ingestPdf仅消费受控用户字节；parseDocuments只处理已有材料；analyze/synthesize与submitExtractionBatch分别拥有自己的输入和结果。只有用户明确列出的组合步骤才能串联，不从知识缺口推导获取授权。

现有 `complete content` 的已声明语义可以包含PDF获取、解析和旧Analysis，继续作为兼容维护入口。它不能被新的独立解析/分析/提取当作依赖补齐器。同步 complete 与 durable Jobs 共用冻结目标、Meta 候选顺序、cohort 波次和取消的执行语义；同步入口给出五分区 Report，Jobs 保留持久 target/attempt/event 与逐目标结果。纯查询不会调用此维护操作。

自然语言问题属于查询/分析意图，不默认构成增加元数据或PDF的命令。Agent adapter须明确区分读取与维护工具；人类工作台的建议按钮只有用户显式发起后才进入维护入口。

### 6.3 模块间操作合同

| ID / 调用方 → 提供方                           | 输入                                               | 输出与成功标准                                      | 副作用与失败语义                                                                        |
| ---------------------------------------------- | -------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| C01 Agent/人类 → Entry/T                       | 独立查询或明确维护意图、范围、目标、处理步骤与预算 | 操作特有结果；实际目标与已交付产物可核对            | 按查询/维护边界分派；知识缺口不生成扩库任务；长任务存续不由返回形式推断                 |
| C02 T → Metadata/Literature                    | 来源条件或标识、Provider 范围与停止边界            | 已接纳文献/来源和发现结果                           | 仅来自用户明确启动的发现/补充操作；不自动下载；源失败保留其它结果                       |
| C03 T → Acquisition                            | 具体文献/版本、来源线索、材料要求和获准能力        | 资产可读取且文件/归属验收及关系提交完成             | 仅来自明确启动的 PDF 维护；分层按现行政策；捕获非成功，暂时失败非耗尽                   |
| C04 T → Parsing → Document/Evidence            | 已接纳 MaterialRef、支持的转换规格                 | 中性解析结果，再由文档 owner 发布可读取 DocumentRef | 可调用外部 parser；失败保留原始材料；没有可靠表格/坐标时报告能力缺口                    |
| C05 入口/Analysis/提取器/Q → Document/Evidence | 明确版本、选择器、读取预算                         | 对应版本的片段/资源及稳定引用                       | 只读；旧版本不可用明确失败，不自动重解析或重定位                                        |
| C06 T → Analysis                               | 固定输入、用途/问题、分析规格、预算与部分处理政策  | 已接纳知识产物、证据及覆盖；也可明确不适用或失败    | 可调用模型并发布；缺材料只返回缺口，应用层也不因此调用获取；不修改来源事实              |
| C07 调用方 → Extraction                        | Spec、输入清单、能力要求                           | 有效规范绑定与材料缺口                              | 不因接受规范就运行模型；不支持的 schema/能力明确拒绝或协商缩小范围                      |
| C08 外部提取器 → Extraction                    | CandidateBatch、证据、生产者方法声明               | 接纳回执与可交付产物，或具体结构/引用错误           | 推荐以显式批次为原子提交单位；批次失败不撤销此前已接纳批次；科学验收归下游              |
| C09 入口/提取器 → Q                            | 问题、文献/版本范围、内容类型、预算                | 有界命中/上下文、来源及展开入口                     | 不隐式下载/解析/分析；索引不可用与零命中分开；不声称穷尽所有证据                        |
| C10 人类 → Configuration                       | 编辑意图、期望配置版本、显式 probe 对象            | 发布/冲突、生效范围或实际 probe 诊断                | 凭据不回显；状态查询无外联；普通参数快照不延续已撤销权限                                |
| C11 人类/T/R → Browser 控制                    | ControlBinding、指导/暂停/接管/交还/取消           | 受理、拒绝、过期或已执行及实际观察                  | 一个动作控制者；指导在安全决策点消费；已派发动作如实结算；人工候选仍由 Acquisition 验收 |
| C12 业务 owner → Storage                       | 已验证产物与输入绑定、发布决定、并发前置条件       | 不可变字节及一致引用可见                            | create-if-absent；先准备字节后短事务提交；冲突、损坏和提交失败明确，不伪造业务成功      |

C08 的批次原子性是本方案推荐，不是已发布保证；较大的任务拆成有界批次，接纳回执标明具体批次。schema 方言推荐 Draft 2020-12；支持的词汇表/本地引用子集、精确大小及错误列表上限在 Extraction 接纳实现前确定，不凭空规定数值。

### 6.4 失败、取消与外部执行

| 情况                               | 合同应表达                        | 后续动作                                               |
| ---------------------------------- | --------------------------------- | ------------------------------------------------------ |
| 没有材料 / 没有可读表示            | 缺什么、已知覆盖和可选后续操作    | 返回缺口；另行启动扩充，已有材料的准备仅限明确加工步骤 |
| 不支持表格、图像理解或 schema 特征 | 具体能力缺口                      | 缩小范围或调用方换策略，不补造内容                     |
| 引用版本/范围不匹配                | 冲突或无效证据                    | 使用原固定版本，或明确建立新输入重新执行               |
| 某篇失败 / 部分材料未处理          | 已完成项、失败/未处理项、实际覆盖 | 保存局部有效结果；是否可综合由显式部分处理政策决定     |
| 预算不足 / 用户取消                | 停止原因、已接纳产物与未开始工作  | 停止新工作，处理在途结果；不回滚有效提交               |
| 查询零命中                         | 实际搜索范围、索引覆盖与限制      | 不等同于论文从未报告该信息                             |
| 提取零记录                         | 实际处理材料及无记录原因          | 区分未找到、未处理、读取失败与领域不适用               |
| 存储损坏/提交失败                  | 操作失败和已提交边界              | 停止受影响调度；不可降级为“没有文献”                   |

外部提取器可调用同一读取与提交协议，自行选择规则程序、领域模型或 Agent。本系统只能验证自身观测到的读取、证据和提交；外部声明的模型、usage 和方法要标为声明。取消本系统请求不等于杀死任意外部程序，结束后迟到提交的接纳规则要由会话/提交合同限定。

用户新发起的维护请求可以基于已提交事实补齐其范围内缺口；查询、分析或提取反馈不自动生成这个请求。是否保留同一个任务 ID、关闭客户端后继续、跨重启自动恢复及等待人工的时限仍需决定；不把已有 durable Jobs 当作这些保证全部成立的证据。

### 6.5 实现方向与取舍建议

| 选择      | 本方案建议与理由                                                | 何时重新评估                                                              |
| --------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 进程/部署 | 延续 TS 模块化单体及统一生产组装，先验证职责与合同              | 明确后台存续、独立扩缩容或资源隔离需求后再评估 worker/服务拆分            |
| 文档表示  | 以中性 Markdown/资源为输入，建立可版本绑定的结构读取层          | 消费场景确需更强表格或坐标能力时增加 adapter 能力，不泄漏 parser 私有格式 |
| 分析      | Analysis 自有有界流程，Agents 只做单次调用；单篇与综合用例分开  | 复杂恢复/动态编排需求有证据时再评估 workflow 框架                         |
| 检索      | 先验证现有 FTS 与文档/知识索引投影，预算组装独立                | 用代表性问题评估召回/排序，确需时再加入向量或重排                         |
| 提取      | 外部策略优先，统一材料与候选协议；首版不依赖内置模型提取器      | 多个真实消费者重复需要相同默认策略时再决定内置能力                        |
| 人类接口  | 优先复用现有 Web；控制协议独立于 UI 形态                        | 使用环境要求桌面/宿主嵌入时替换 adapter，不改业务服务                     |
| 存储      | 复用 Catalog + ArtifactStore，增加有 owner 的文档/产物/依赖合同 | schema、保留/回收与查询规模评估后决定物理设计，避免预建通用任意 JSON 库   |

收益是模块可独立使用、来源转换变化更局部、下游免于重复实现材料基础、人工介入与自动流程共享结果。代价是版本/依赖管理、产物校验、更多读取合同和组合验收；没有实测依据，不承诺吞吐提升或更高下载成功率。

### 6.6 待冻结内容与验证输入

本方案已经给出推荐职责、语义与取舍，以下不是继续悬空全部设计，而是实施前需要定稿的具体边界：

| 未决项                          | 已可继续的设计                                                                                                         | 受影响部分                                                                                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q01 客户端断开/重启后的任务存续 | 独立操作、事实重读、取消和模块合同                                                                                     | durable 调度、任务 ID/保留、介入等待、部署                                                                                                                                                                    |
| Q02 配置与撤销时点              | 普通参数由 Application 启动绑定；新 CLI 构造新 Application，已有工作台明确提示重启；已组装能力的新外部请求重新授权凭据 | 当前 HTTP/Agent/Parser/Provider 请求边界已实现；Browser 生产指导/控制的具体生效边界按 Human Interaction 合同验证                                                                                              |
| Q03 文献规模/成本与质量目标     | 有界读取、实际覆盖和分层验证                                                                                           | 批量大小、性能目标、知识质量评测样本，不编造 SLA                                                                                                                                                              |
| Q04 人类界面与允许动作          | 复用 Web 的配置/观看/指导/阅读方案                                                                                     | 最终形态、登录/MFA 等人类权限范围                                                                                                                                                                             |
| Q05 长期历史/回放               | 实时观看和有界会话反馈                                                                                                 | 长期截图、指导历史、保留与存储成本                                                                                                                                                                            |
| 新 schema/兼容                  | 对象语义、owner、发布/读取边界；schema 方言推荐 Draft 2020-12                                                          | Storage 确定 DDL/reader/canonicalization/迁移；Extraction 明确词汇表与本地引用子集及大小边界                                                                                                                  |
| 候选回执与外部引用              | 即时交付不要求历史 payload 托管；两类证据目标                                                                          | Extraction 接纳实现前定 scope/寿命/并发/重启/取消；Storage 回收前及 Extraction 交付前定外部依赖保护与失效政策，见 [候选交付的剩余合同与收敛时点](05-knowledge-processing.md#411-候选交付的剩余合同与收敛时点) |

[工作流](../knowledge-service-workflows.md)给出成功/失败推演。实现验收应同时覆盖：无内部模型的材料读取与提取、一文多条/嵌套/跨文记录、旧证据稳定读取、重复提交冲突、人工接管竞态、输入变化和局部失败。结构合法、引用可解析、语义支持、领域正确四个结论分别验证，不以单一 schema 测试替代。

## 7. 共享支撑：受控网络访问

本节是全系统共享 Network 的唯一详细说明。Metadata、Acquisition、Parser、Agents 和 Browser 都复用这些访问政策；任务模块只负责组装和生命周期，不解释各供应商业务协议。Browser 页面事件、捕获和控制的专属细节见⑧。

### 7.1 实现结构与边界

```text
apps/server/src/network/
  policy.ts          # URL/DNS/origin、地址类别、凭据转发与脱敏
  budget.ts          # NetworkBudgetCoordinator、进程内共享准入
  connection.ts      # VerifiedConnection 与目标绑定
  http.ts            # 受控 HTTP、模型 transport
  browser-proxy.ts   # loopback CONNECT、精确目标 binding
  probe.ts           # 复用生产协议的显式诊断
apps/server/src/browser/
  boundary.ts        # 中性 BrowserSessionHost/delivery 接口
  production-host.ts # 唯一生产 host factory、惰性构造
  host.ts            # persistent context、Profile lease、page 生命周期
  page-runtime.ts    # 观察与实际页面动作
  control.ts         # 控制租约和 epoch
  observation.ts     # revision、元素与截图观察
  article-flow.ts    # 有界文章动作流程
  decision.ts        # Browser Agent 请求与响应转换
  transfers.ts       # 原生下载/响应事件分派
  transfer.ts        # 候选读取与交付
  display.ts         # 无 GUI Linux display 生命周期
  human-input.ts     # 人类输入 adapter
apps/server/src/entry/pdf-acquisition.ts # 文章排队与 BrowserSessionBroker
```

Network 拥有所有外部访问的安全政策；Browser 拥有 context/page/control，Entry 拥有一次维护操作的调度。Acquisition 解释下载字节与文章归属，Agents 解释一次模型调用。它们不能通过共享一个“浏览器对象”混合所有权。

### 7.2 共享访问政策

`policy.ts` 负责：

- URL 解析与规范化；
- 允许的 scheme、port 和 userinfo；
- DNS 解析结果与公网、私网、loopback、link-local 等地址分类；
- 每次 redirect 的目标复检；
- origin 变化和 credential forwarding 决定；
- URL、query、header、错误详情和凭据脱敏；
- 单次响应、截图、下载字节上限与单次 I/O/action timeout。

Policy 不理解 Crossref、arXiv、Semantic Scholar、出版社页面、MinerU 或具体 LLM 的字段和状态码语义。Provider pagination、quota 含义、`429` 解释、页面 selector 和服务轮询属于对应 adapter。

URL 校验不能只发生在第一次请求。DNS 结果、每跳 redirect、浏览器顶层导航、popup 和最终下载地址都必须重新满足相同边界；无法形成等价安全判断时 fail closed。

### 7.3 AccessScope 与访问政策

每个生产 adapter 在发起外部操作前声明一个稳定运行范围：

```text
AccessScope
  provider_name: str
  channel: "api" | "web"
  service_name: str | None
```

- `provider_name` 是稳定、非空、无凭据的 provider/service identity；
- `channel = "api"` 表示由供应商 API 政策控制的请求；
- `channel = "web"` 表示普通网页、站内直接文件或受控浏览器流程；
- `service_name` 只在供应商明确具有独立 API 产品或额度池时区分。

共享同一 key、账户、官方 quota 或额度响应头的 metadata search、metadata reference query 和 PDF API 必须声明同一 scope。独立产品只有在外部政策明确分开时才能拆分。Scope 不使用 DOI、Literature ID、完整 URL、凭据值、用户身份或随机任务 ID，避免把同一供应商预算错误拆散。

Adapter 还声明规范化 `AccessPolicy`。政策至少能够表达：

- 最大活动并发；
- 最小启动间隔；
- 完成后的冷却间隔；
- burst/window request quota；
- 已知周期额度及其重置边界；
- 动态 `Retry-After` 或额度反馈形成的 `blocked_until`。

供应商官方政策、项目安全下限、operator 收紧配置和运行时响应反馈同时适用时执行最严格组合：并发和可用额度取更小值，间隔、冷却和阻塞截止取更大值。普通配置不能放宽官方约束或 ADR 0012 的网页安全下限。缺少可执行政策的 production adapter readiness 失败，不能退化为无限制访问。

Browser 在普通 provider/host admission 之外使用全局中性范围：

```text
BrowserAccessScope
  rate_limit_group: "browser-generic"
  session_key: selected Browser Profile identity
```

`rate_limit_group` 不按 Publisher 拆分；`session_key` 只标识共享 context 使用的 operator-managed
Profile。两者不携带 Cookie、用户登录名、机构身份、DOI、完整 URL 或任务 ID。通用 policy 固定
`max_concurrency = 1`；普通配置仍只能收紧。

具体 provider 数字及核对日期不在本节件复制，由 `docs/notes/providers/<provider>.md` 或对应外部服务 Notes 维护。Adapter 的静态 policy 与 Notes 必须能够互相追溯。

### 7.4 进程内 Access Coordinator

`budget.ts` 在真实访问边界执行以下流程：

```text
adapter 声明 provider/channel/service scope 与允许 origin
  -> Access Coordinator 合并静态政策、operator 收紧和运行时阻塞
  -> 等待并取得 provider scope permit
  -> 按实际连接或导航目标取得 host permit
  -> HTTP / Browser 执行
  -> adapter 解释 Retry-After、quota 和 provider 错误
  -> Coordinator 更新 blocked_until / quota state
  -> 清理响应、页面和临时资源
  -> 释放 permit 并记录必要冷却
```

`sciretriever.bootstrap` 对每个 SciRetriever 进程只构造一个共享 Coordinator，并把它注入 HTTP 和 Browser。当前进程中的 Metadata、Acquisition、Parsing、Analysis、不同 Literature 和不同用户操作不能获得互不知情的 limiter。

Coordinator 的逻辑 scope 状态与精确 host 状态同时生效：

- 同一 provider 的多个允许 origin 共享 provider scope；
- 不同 provider 的候选最终落到同一 host 时共享 host budget；
- redirect 到新 host 前必须先通过目标 policy 与目标 host admission；
- 未知普通网页按规范化 host 建立保守 `web` scope；其具体默认 policy 必须明确标注为项目审慎值，不能冒充供应商官方规则；未知站点不因此获得 production Browser Profile；
- 公开、OA 或 direct 声明不构成网页限速豁免。

等待 permit 是可取消的资源等待，不是 provider 失败、`NoPrimaryPdf`、Literature 状态或数据库补全状态。调用方 deadline 到达时可以结束当前操作；只要当前进程仍在运行，取消、失败或重新发起同一操作就不能绕过已经形成的冷却或 `blocked_until`。

### 7.5 内存状态与非持久化边界

Coordinator 的动态状态只在当前 SciRetriever 进程内存中共享。它至少包括：

```text
等待队列和活动 permit
provider/channel/service 与 host 的并发状态
next_allowed_at
blocked_until
窗口额度计数和重置时间
当前 Retry-After 与有界退避
browser-generic 的连续 runtime failure 计数与 circuit reason
```

这些值不得携带 DOI、Literature ID、candidate key、完整 URL、header、Cookie、secret reference/value、响应正文、底层异常或逐请求失败。它们不进入业务 Model、SQLite Catalog、ArtifactStore、provenance、日志合同或独立协调文件。Network 不创建限速表、协调数据库、协调目录、跨进程 advisory lock、lease marker 或可恢复的 rate-limit 现场。

进程退出或崩溃后，全部动态限速状态自然消失；新进程从静态访问政策和 operator 配置重新建立 Coordinator，不延续旧进程的网页冷却、`blocked_until` 或 API 窗口。多个并发 SciRetriever 进程各自限速，当前产品不提供跨进程、跨重启或跨机器的供应商额度协调。Storage 为保护同一 Catalog 而使用的核心写入 advisory lock 是独立的数据库完整性机制，不属于 Network。

静态访问政策、`browser-generic` policy、API 规则和 operator 收紧值仍由 adapter/配置与 Provider
Notes 持久表达；“规则持久化”不等于“动态计数和截止时间持久化”。

### 7.6 网页访问规则

普通 HTTP landing-page discovery、出版社站内 direct PDF 和 Browser 都先取得对应 provider `web` scope 与实际 host permit。公开、OA 或 direct 声明不构成网页限速豁免；共享网页政策或 host 的访问仍共享真实准入。

Browser 再取得 `browser-generic` 的 `BrowserAccessScope`，固定满足：

```text
max_concurrency = 1
project-conservative article interval/window/cooldown
project-conservative rate-limit cooldown / runtime-failure threshold
```

全部文章在该组内限速串行。全局 Browser concurrency 只保护本机 process/context 资源，不会按
Publisher 建立第二套队列。基线与证据由 Configuration/ADR 0023 维护，operator 只能收紧。

Browser permit 从 canonical landing 第一次导航前持有到 page、popup/viewer、response/download、TemporaryPdf 交付和临时资源完整清理。成功、无结果、页面失败、timeout、取消、Challenge 和重试都不能绕过对应 `next_allowed_at`、`blocked_until` 或 circuit。页面加载会产生多项子资源请求；文章 permit 覆盖完整高层流程，Network 对每次请求、导航、动作、截图、response/download 和 cleanup 分别执行 timeout 与字节上限，但不建立整篇 Browser 作业 deadline。页面脚本、selector 变化、多个标签页或重建 context 不能取得同组第二个并行 permit。

同一 provider 的 API 使用独立、按官方 quota identity 形成的 `api` scope，因此 Browser 流程占用
或冷却期间，独立 API 产品、Metadata 和公开仓储仍可按各自政策运行。

### 7.7 API 访问规则

API adapter 根据当前官方政策和产品 entitlement 声明 quota identity、并发、间隔、burst/window、周期/日额度和 reset boundary。API 不继承 Browser 文章间隔，也不能默认无限制。API key 已配置、认证成功、quota 可用和目标内容 entitlement 分别判断。

Adapter 负责把 `429`、`Retry-After`、额度响应头和供应商专属错误转换成中性 policy feedback；Coordinator 把 feedback 应用于当前进程的共享 scope。`Retry-After` 或明确额度耗尽在当前进程的所有 Metadata/Acquisition 调用方之间共同生效。没有 `Retry-After` 时采用 adapter 规定的有界保守退避，不能立即高频重试。

Vendor SDK 只有能够注入受 Coordinator 约束的 transport 时才能使用；内部自行联网且无法复用准入、安全 redirect 和脱敏政策的 SDK 不能成为生产 adapter。

### 7.8 HTTP 实现

`http.ts` 负责：

- 在连接前取得适用 provider 与 host permit；
- HTTPS 与 TLS 校验；
- DNS 结果约束和连接目标一致性；
- 连接池与 session 生命周期；
- 逐跳 redirect policy 与 admission 复检；
- connect/read/overall timeout；
- 有界流式读取；
- 协议无关且幂等的连接级重试；
- 取消后的连接、permit 和响应清理。

HTTP 返回中性访问结果，不把 client response 类型暴露给消费模块。API pagination、provider quota 解释、MinerU polling、LLM retry 和候选业务重试不进入 HTTP 层。

无 credential header/query 的请求在 Debug 中只记录安全 `AccessScope`、method、最终 status/response bytes 或中性失败，以及从请求开始到终态的单调时钟耗时；不记录 URL、host、query、header、response body 或原始异常。携带凭据的请求在 Network logger 上完全静默，由上层 adapter 记录不含 endpoint/credential/response 的 provider 语义步骤。日志关闭或失败不能改变 admission、transport 或返回值。

普通 URL 和普通 redirect 始终拒绝 percent-encoded path separator。若已核实的 Provider
API 返回把签名 locator 编码在单个 path segment 中，adapter 必须同时提供精确
redirect-target guard 并显式启用 guarded opaque-path 模式；guard 在目标 DNS 和 transport
之前限制 HTTPS origin、port、固定 path prefix、query/fragment 与 locator 形状，Network
仍执行 raw path/traversal、percent/UTF-8、DNS、地址类别、重绑定、host admission 和资源
预算检查，但不对 Provider 签发的 opaque segment 做多层解码后再猜测 path 语义。该模式
不会扩大普通 redirect，跨 origin 时也不会转发 credential。

### 7.9 调用方向

```text
metadata.providers       -> network.http
acquisition.routes       -> network.http and/or network.browser
parsing.backends.mineru  -> network.http
agents.providers        -> network.http
bootstrap provider probe -> network.http

network.http              -> network.policy + network.admission
network.browser           -> network.policy + network.admission
```

消费模块公开 API、规则和用例不得看到 URL client、header、cookie、HTTP response、Playwright page/context、浏览器 download 或 permit 类型。只有对应 adapter 可以使用协议技术类型；AccessScope 和 policy 只用于 Network 准入，不进入业务 Model。

### 7.10 凭据、配置测试与诊断

- Network 不读取普通 TOML、环境变量、`~/.sciretriever/credentials.toml` 或任何 secret reference/value；Provider secret 由 `sciretriever.configuration` 私有解析，再由 `sciretriever.bootstrap` 注入具体 adapter；
- Adapter 声明允许附着凭据的 origin 和不含 secret 的 quota scope；
- 跨 origin redirect 默认移除凭据，除非 policy 明确允许；
- 凭据值不得进入 scope、内存限速状态、日志、异常、诊断、SQLite、provenance、URL、文件名或用户输出；
- Network 在错误离开 HTTP/Browser 边界前，把协议异常和不可信网络值转换为稳定、脱敏的中性失败；消费模块与 Entry 不接触原始异常或 response；
- Playwright/CloakBrowser 未声明 exception 在 vendor 边界只按受控 exception type/category 稳定化；
  原始 message 不进入 `StableFailure` 或日志，因而其中可能存在的 URL、token、selector 和本机路径
  不会跨出 Network；
- 原始 exception、HTTP response、response body、完整 URL、header、Cookie、credential 和短期签名参数不得作为 LogRecord 的 message 参数或 `extra`；
- Provider adapter 仍负责供应商私有响应和 SDK 异常的脱敏，Logging 模块的统一 Filter 只能作为最后防护，不能替代各 adapter 的边界转换。

`config status` 是纯本地 configuration/readiness 检查，不得调用 Network。LLM 向导只有在用户
明确选择“获取可用模型”后，才通过 Bootstrap 与共享 HTTP 对 candidate origin 执行一次有界、
无 redirect/retry 的 `GET /models`；credential 仍只附着到该规范 origin，结果不持久化，失败回到
手工输入。用户显式执行 owner-scoped `config test provider/model/search/parse/analyze/browser` 或
`config test --all` 时，Bootstrap 组装的实际外部 probe 必须像普通 adapter 一样经过共享 Coordinator、
安全 HTTP、URL/DNS/redirect、timeout、响应预算、quota、`Retry-After` 和脱敏。Provider probe
只做官方允许的最小只读请求，Analysis probe 只发送固定最小 schema 内容，Browser Agent probe
只发送合成图片与封闭工具，MinerU probe 只做 health 且不上传 PDF；Download 没有安全的独立
外部 probe 时在 Configuration 边界直接报告 unavailable，不向 Network 伪造请求。Network 不因
它是配置测试而绕过限速，也不把认证成功解释为任意 Literature 的全文 entitlement。

Network 只返回本次中性、脱敏的 probe 结果。配置测试不创建 DiscoveryRun、MetadataObservation、ProviderRelationObservation、Asset、Report、Catalog/ArtifactStore 事实或持久日志，也不保存最后测试时间、连接状态、permit 或服务健康状态。

底层异常和响应正文只能作为边界内诊断输入，不能成为持久业务合同。Acquisition 在 INFO 中拥有
已 dispatch action 的 action/dispatch/settle/semantic/page/capture/elapsed 摘要；Network 的
Observation revision、exact/stable fingerprint、surface/element 数量和 transition/capture evidence
只进入 Debug。限速诊断可以 best-effort 表达脱敏 scope、等待类别和下次允许时间，但这些值不是
稳定日志合同，不能被 Report 或业务逻辑解析，也不能包含目标文献、URL 或凭据身份。日志丢失、
过滤或 handler 故障不得改变 permit、冷却、返回结果或数据库事实。

### 7.11 资源、并发与取消

Entry 可以有界并发处理不同 Literature，Metadata 可以逻辑并发查询多家供应商；所有真实访问仍由 Coordinator 按 scope 与 host 门控。API 并发不能直接继承 Entry worker 数，而由 adapter 声明的官方 quota identity、并发、间隔、window、周期额度和运行时反馈共同决定。共享同一 API 额度池的 Metadata/Acquisition 调用互相可见，明确独立的 API 产品才可并行推进。

Browser 调度同时服从两个边界：`browser-generic` 固定只有一个活动文章流程并按通用政策限速串行；
进程级 Browser cap 只保护本机 CPU、内存、共享 runtime 和文件描述符。该 cap 默认 `5`，只接受
大于 `1` 的严格整数且不设上限；所有文章共享一个 process/context。Browser 正在等待、命中需要
登录等停止状态或 circuit open 时，不阻塞独立 API/Metadata scope。

Network 同时执行每 host 连接预算和协议无关资源上限。Provider quota 与页面状态含义由对应 provider/profile/parser/LLM adapter 解释，跨文献业务 cohort 和后续阶段并发仍由 Entry 控制。

取消和 timeout 必须传播到实际网络或浏览器操作，不能只停止上层等待。取消 permit 等待不能占用并发名额；已取得 permit 后取消必须完整清理并更新适用冷却。Late response 不得在调用已结束后成为有效结果。

Browser cleanup failure 属于系统失败，不能形成正常未命中或自动获取耗尽。它会请求在其它活动
article 排空后淘汰共享 runtime，并立即打开 `browser-generic` 的 cleanup circuit；
同组后续排队任务不再触网，已经活动的独立 group 可以完成。只有 runtime task 已停止、文章资源
已逐项清理、host/scope permit
已经释放或其释放失败已明确传播后，scheduler callback 才结束并更新组状态。cleanup circuit 与
其它 action-required circuit 一样，只能用精确 group 和 policy revision 显式确认。

### 7.12 验收

直接安全测试至少覆盖：

- malformed URL、禁止 scheme/port/userinfo；
- 私网、loopback、link-local 和 DNS rebinding 风险；
- 越权 redirect、跨 origin 凭据剥离和逐跳复检；
- timeout、取消、oversize 和 late response；
- HTTP 与 Browser 使用等价 URL/DNS/redirect/origin/redaction policy；
- 同一 scope 在当前进程的不同模块、任务和用户操作之间共享，不为每个 adapter 重建 limiter；
- 同一 API quota 被 Metadata 与 Acquisition 共用时相互限速，独立 API product scope 不错误互锁；
- API 精确执行 adapter 声明的官方并发、最小间隔、window/周期额度、reset boundary 和反馈头；operator 只能收紧，不能放宽；
- `browser-generic` 最大活动文章流程始终为 1，相邻文章开始时间精确满足 baseline/override 的
  interval/window/cooldown；成功、失败、timeout、取消和重试都不能绕过；
- 全局 Browser cap 只限制本机资源；Browser 占用期间，独立 API scope、Metadata 和公开仓储可以推进；
- 公开/direct URL 指向出版社网页时仍使用该 provider `web` scope；不同来源落到同一 host 时共享 host budget；
- navigation、页面 request、popup、viewer 和 download 在继续前同时通过 Profile guard 与目标准入；未暴露 route 的 native redirect response 只能按同页 live-proof 规则复检并在读 body 前取得 terminal host permit，不能利用重试、多标签页、备用入口或新 host 绕过组内串行、间隔和单次资源上限；
- `429`、`Retry-After`、窗口额度和 `blocked_until` 对共享 scope 的后续调用生效；
- 缺少明确 AccessPolicy 的 production adapter readiness 失败，operator 配置不能放宽安全下限；
- 当前进程内取消、timeout 和失败不会泄漏 permit，也不会绕过仍有效的冷却或 `blocked_until`；
- cleanup failure 立即阻止 `browser-generic` 下一篇触网，不会等待普通 runtime failure 阈值；
- 等待队列、permit、时间截止和额度计数只存在于内存，不创建限速表、协调目录、状态文件、lease 或跨进程锁；
- 新 Coordinator 不恢复旧进程状态，测试和文档不宣称跨进程或跨重启限速保证；
- `[browser].max_concurrency` 默认 `5`、严格大于 `1` 且没有上限；`2` 与更大值均合法，`1`、bool 和 float 非法；较大 cap 不启动多个 Browser，也不改变 `browser-generic` 串行；
- 所有文章共享一个固定身份 Profile、一个有头 CloakBrowser Chromium process/context；`browser-generic` 严格串行，每篇文章的 token、page、popup、download、response stream 和临时目录完整隔离；runtime invalidate 只能在其它活动 article lease 排空后淘汰共享 runtime；
- Profile identity 不能是路径或敏感标识，Profile 目录树满足 owner-only/no-follow 安全合同；同一 Profile 的跨进程 runtime lease 互斥，使用中不能再次启动或删除；runtime 关闭后 Profile 保留且可以再次取得 lease；
- 当前 TypeScript portable/package 的本地 HTTPS/有头 Chromium fixture 连续执行通用文章流程时只创建一个 process/context，每篇使用独立 page、download 和文章临时目录，并对每个 landing/PDF hop 重新执行 DNS、TLS authority、connection binding 与 host admission；broker 关闭后临时下载根删除而持久 Profile 保留；无 GUI Linux 通过 Xvfb 启动；历史 wheel 证据不替代当前产物验证；
- Publisher 请求由 CloakBrowser Chromium 原生完成 TLS/HTTP/redirect/click/download，loopback CONNECT proxy 只接受已审核的精确 IP binding 并透传加密字节，不终止 TLS 或用宿主 HTTP 代发；
- Agent controller 不先运行确定性 PDF locator 或 Publisher 点击规则；签名 query 只进入当前 Chromium operation，不进入 guard、日志、结果或 provenance；
- native redirect response 只有在同页 live ancestor、批准且预绑定的 terminal origin 与最终 host admission 同时成立时才能复用 route proof；跨页或未预绑定时不读取 body；
- 只有 Acquisition 对已审核主文请求明确返回 prefetch 许可时，Network 才在全部 request 准入后使用
  `fetch(max_redirects=0) -> fulfill` 保留稳定 body source；普通资源继续 `continue`，`206` range
  chunk 始终不读取、不作为完整 PDF 捕获；
- Browser 不设置整篇 step/time/request/popup/download/capture 作业预算；单次 request/navigation/
  action/settlement/screenshot/body/cleanup 的 timeout 或字节上限分别稳定失败，dispatch receipt 不能
  代替稳定 step 结果；
- 每个 cleanup failpoint 后资源释放至多调用一次，重复 session/broker cleanup 保留首次失败，且 cleanup failure 不形成耗尽；
- page state、agent status 与 capture state 正交；Challenge 只是统一 page state，不建立 resource/interaction 专属状态机，所有运行状态和 receipt 均不持久化；
- 页面发起的 challenge dependency 与其它子资源一样重新经过 HTTPS、DNS/地址、CONNECT/host、单次 frame/request timeout 与字节上限；它不由 Publisher Profile 预先声明，也不能成为 Agent 构造的任意初始导航或绕过通用 Network admission；
- 同一固定身份 Profile 三次冷启动的 seed 派生 persona、UA/Client Hints、platform、plugins/languages、screen、WebGL、fonts、locale/timezone 保持稳定，不同 Profile 可区分；seed/原始 fingerprint 不进入配置、日志或持久事实；
- 统一 Observation 覆盖 page/popup/frame/Shadow/viewer surface tree、单次 screenshot、短期 element、capture 与 receipt；过期 revision/element/screenshot/surface、未知动作、任意 URL/selector/JavaScript、跨 revision/raw coordinate 和越界滚动在 vendor 调用前拒绝；
- `BrowserStepSession` 只公开 `Ready / Captured / Blocked / Failed / Cancelled`，只有 `Ready` 可继续；
  transition driver、stale、settled 和 Candidate 私有化，`WaitForChange` 与其它 Agent action 使用同一
  变化/timeout，异步 navigation、Challenge clear、capture、取消和 vendor failure 使用可控 fixture 验证；
  页面状态只进入 Observation；Agent 已开始探索后 materialized capture 从 Observation 中隐藏，但仍
  保留在外层 `BrowserCaptureBatch`，由 Acquisition 做 PDF 字节与文章归属验收；
- Candidate 只由当前 policy 仍未拒绝的 pending correlation、deferred resource 或 callback 表示并走向 captured、cleared 或 timeout；timeout
  只恢复 Agent 可继续的 `Ready`，不会单独结束 Agent；外层在最终无 capture 时才返回 `capture-timeout`；callback
  活跃计数与 page/download/stream ownership 分开，cleanup 各自且至多一次；
- Agent 的 `ClickElement`、`ClickPoint`、`ScrollSurface`、`GoBack`、`WaitForChange` 和 `Stop` 复用同一 humanized article handle、permit、Network guard 和 capture handler；Cloudflare-shaped fixture 使用相同动作证明自动 clear、可见交互、语义无进展、资源阻断和 origin escape；
- 普通 `403` 只形成文章级 `ACCESS_DENIED`，不冒充明确 paywall/无 entitlement，也不会误报 `IP_BLOCKED` 或打开整个 group circuit；
- Browser 能从 download、response、popup/viewer 和官方 locator 交付临时 PDF，且正文/补充材料区分、三态 capture policy、单项字节上限和全部 destination guard 均受控；
- Provider 页面流程不能绕过 PDF 基本检查直接发布资产；
- Cookie、Profile 路径/内容、identity seed、登录细节、完整 URL、selector、Agent screenshot/页面文本、凭据和 Browser vendor object 不出现在文献持久化、status、日志或业务结果中；Profile 中由 Chromium 管理的认证字节是唯一例外且不由 SciRetriever 解释；
- `config status` 完全不触发 Network；`config test` 通过同一 Coordinator 和安全访问边界，单项失败不泄漏 secret，且不持久化测试结果、时间或文献事实；
- 原始 exception、response、URL、header、Cookie、credential 和 response body 不进入 LogRecord；边界脱敏先于 Logging filter，限速日志的缺失不影响准入结果。

限速、group 并发、runtime/circuit 和 `config test` 测试使用 fake clock、同进程并发任务、fake adapter 与 fake transport，不用真实长时间 `sleep`；HTTP 与 Browser 测试使用系统临时目录中的测试 Profile、本地受控站点、离线页面 fixture 和 fake DNS，并覆盖批准的外部 JavaScript、未批准 tracker 丢弃、点击/脚本 redirect、跨 origin CDN、HTTP attachment、共享 context 文章分流与临时资源清理；不读取真实用户 Profile/凭据，也不连接真实供应商、机构登录或用户语料。

### 7.13 Network 内部值边界

ADR 0012 的 `AccessScope`、访问政策、permit、`next_allowed_at` 和 `blocked_until` 是 Network 内部技术数据；其中动态状态只存在于当前进程内存。它们不属于模块间业务 Model，也不进入公开文献合同、Catalog、ArtifactStore、provenance 或独立协调文件，且不能携带 DOI、Literature ID、候选、完整 URL、凭据或响应正文。

## 8. 共享支撑：安全日志

本节说明全系统共享 Logging。日志与任务报告、文献事实各自独立；当前实际 logger API 与更丰富的目标呈现明确区分。

### 8.1 当前实现与职责

当前实现为 `apps/server/src/logging/index.ts`，只依赖 Node 标准能力；它不导入 Entry、Network、Storage 或业务 Model。日志 API 不接收整个业务对象，调用方选择可安全披露的标量字段。

```ts
type LogLevel = "debug" | "info" | "warn" | "error";
interface Logger {
  debug(message: string, fields?: SafeLogFields): void;
  info(message: string, fields?: SafeLogFields): void;
  warn(message: string, fields?: SafeLogFields): void;
  error(message: string, fields?: SafeLogFields): void;
}
function createLogger(
  component: string,
  sink?: (line: string) => void,
  minimum?: LogLevel,
): Logger;
```

这是实际公开形态：默认 sink 向 `process.stderr` 写一行，默认 minimum 为 info；component 非空且拒绝空白/控制字符。当前输出是 level、component、message 和安全字段；没有 Python Logger/Handler，也没有 `get_logger`、`configure_logging` 或全局命名空间配置 API。

### 8.2 格式化、安全字段与故障边界

当前字段 allowlist 为 provider、model、role、operation、endpoint、status、http_status、code、retryable、bytes、attempt。未在集合中的字段被过滤；密钥类字段名不进入输出。字符串值对明显 credential 模式和 URL 中已知敏感参数脱敏；安全 endpoint 仍须由来源边界保证，不可据过滤器推断任意 URL 或对象都安全。

logger import 和构造不修改宿主配置，不安装全局 Handler。宿主可以注入 sink；最低 level 在 logger 构造时确定，不从任意业务请求更改全局输出。业务结果由 typed result/failure 表达，不解析日志重建结果。

以下 [标准流与目标呈现合同](#83-标准流与目标呈现合同) 描述项目需要的更完整呈现合同，部分格式化、字段和诊断层级尚未在当前简单 logger 中实现。尤其当前自定义 sink 抛错会沿调用栈传播，尚不能宣称所有日志路径已具备 best-effort 故障隔离；扩展时应在 Logging 自身捕获输出失败并保持业务结果，而不能让每个业务模块复制防护逻辑。新字段须经过安全评估再加 allowlist，不能仅因下文提到字段就传入任意上下文。

### 8.3 标准流与目标呈现合同

Logging 只写实时运行信息：

- stderr：进度、限速等待、局部失败和安全诊断；
- stdout：由 Entry/CLI presenter 独占，用于稳定文本结果、JSON Report 或其它可管道输出。

Logging 不得安装 stdout Handler。日志 message、level、时间、formatter 输出和可选上下文不是稳定公共 API；测试只固定标准流、安全边界和不影响业务的行为，不绑定完整自然语言文案。

目标诊断上下文适用时可以携带安全的 `stage`、`tier`、`provider_name`、`route_key`、`browser_rate_limit_group`、`plan_revision`、`disposition`、`next`、`http_status`、`http_status_class`、`elapsed_ms`、`action`、`meta_literature_id` 或 `literature_id`。其中 HTTP 状态只允许使用 Network 已验证的三位数字和受控状态类别，不能携带 status text、header 或 body。这些只是可选诊断上下文，不形成统一事件 schema、operation ID、目标状态或新的公共业务合同；route/group 值必须来自静态无 secret identity，不能从完整 URL、账号、Cookie、DOI 或随机任务派生。诊断耗时来自单调时钟，只进入 LogRecord，不进入 Report、Catalog 或业务 Model。

模块提供中性 message 和安全标量。丰富 formatter 的设计如下，不表示当前简单 logger 已实现全部布局：Formatter 只对以合法 `event=<稳定事件 ID>` 开头的 message 做 best-effort 展示；普通 message、未知事件或解析失败都安全回退。每个 LogRecord 渲染为一个不可交叉的静态 block：首行固定从时间、level、component、状态符号和动作开始，并尽量容纳按优先级排序的主字段；剩余主字段与原始 event ID 折到 `context`，稳定失败的 `reason`、`action` 和其它 `details` 分别使用具名续行。Debug 再追加源码模块与行号的 `source` 续行。event ID 始终保留，便于 `rg`，但不保证位于首行，完整格式也不是公共 API。

TTY 使用当前终端宽度，并将布局限制在 80–240 列；非 TTY 使用确定的 120 列宽度。折行按终端 cell 宽度处理中文和组合字符，过长的安全单值也会继续拆分。TTY 可以使用有限颜色；非 TTY、重定向、`TERM=dumb` 或设置 `NO_COLOR` 时必须是无 ANSI 的普通 UTF-8 文本。

#### 8.3.1 正常与 Debug 模式

呈现设计区分正常与 Debug 两种语义；当前 `--debug` 的接线应以 CLI 实现为准，不凭本表宣称已支持全部详细事件：

| 模式  | level   | 必须呈现的内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常  | `INFO`  | 操作和 Metadata Provider 生命周期；由 Entry 拥有的 Discovery/Completion 终态、PDF tier/Browser escalation、目标与 Provider group 进度；Analysis metadata/content/publication stage；每次真实 role-level Agent call 的实际 Provider/wire Model、结果、usage/elapsed 或稳定失败；已 dispatch Browser action 的 dispatch/settle/page/capture/elapsed 摘要；Browser group 等待/暂停和需要确认的 circuit；最终的 Challenge、login/MFA/access-denied 等安全分类。partial、manual PDF、interrupted、not-started 或 failed 使用 WARNING；具体失败优先保留 code、retryable、reason 与 action |
| Debug | `DEBUG` | 正常模式全部内容，加上 Metadata item、Analysis stale/input 检查、Acquisition route/candidate/delivery、Agent preflight/protocol/capability 与安全大小、Network 边界以及 Browser scheduler/controller/native 的 Observation revision/fingerprint/transition evidence、正常 miss、capture、cleanup、`disposition/next` 和诊断耗时                                                                                                                                                                                                                                                     |

INFO 按事实拥有层输出，不把每一层生命周期复制一遍。Entry 拥有 tier/group/target 和最终批次摘要，
因此 Cohort 的 route-local delivery/结果失败留在 Debug；具体 Source/Provider 仍可拥有其外部边界的
稳定失败。Analysis 拥有 metadata/content/publication stage，Agents Runtime 拥有一次 role-level
call start/finish，Acquisition Browser controller 拥有已 dispatch action 的 settle summary；adapter、
Network 和下游 presenter 不重复这些 INFO。Agent preflight、Provider protocol/capability/安全大小，
Analysis stale 检查，以及 Browser Observation revision/fingerprint/transition evidence 留在 Debug。
Browser scheduler/native 的普通步骤同样只作 Debug 下钻，等待、暂停、中断和 Source 已完成分类的
终态才进入正常模式。

Debug 的“逐步骤”按责任边界记录，而不是给每个函数做调用追踪。完整诊断应覆盖：

- Network 的无凭据请求开始、最终 HTTP status/响应字节数/耗时、API quota feedback、risk-group permit/circuit 状态，或 `policy`、`timeout`、`TLS`、`transport`、`admission`、`resource-limit` 等中性失败分类；
- Metadata 的 Provider session 与耗时、逐 raw item 的 `accepted/empty/rejected` disposition、observation/relation 增量和稳定 reason；Provider 汇总满足 raw = accepted + empty + rejected；
- Topic/Citation Discovery 的深度、observation 接纳/拒绝、关系和结果发布；Literature 拒绝 observation 时保留其拥有的稳定 `decision_reason`，但不记录 Provider 原始记录或正文；
- Database Completion 的冻结目标、有界 PDF cohort、tier barrier、并发目标进度、current facts、Acquisition、Parsing、Analysis 和 Literature 接纳阶段；Analysis 的 metadata/content/publication started/finished 在 INFO 有单一 owner，stale/input hash 证据留在 Debug；
- Acquisition 的 plan revision、resolution evidence kind、route readiness/applicability、route key、public/API route hint 类别、候选匿名 ID、route 的 `disposition/next`、授权 target/lookup/download、Browser eligible/admitted/attempted/delivered、group queue/pacing、article-handle reuse、页面 observation/marker 检查、state/capture/cleanup、PDF 验证/准备、提交与正常耗尽。Browser marker 事件只记录静态 rule/marker ID、selector 数量、matched/miss 和 `elapsed_ms`；不记录 selector 或页面文本。
- Agents Runtime 在 INFO 记录 role、provider、实际 wire model、stream/reasoning、单次 structured-result/
  tool-call 类别、usage、延迟和稳定失败；Debug 才增加 protocol、required capabilities 与输入/输出/
  图像安全大小。两层日志都不记录 prompt/schema 内容、模型原文或 reasoning 内容、图片字节、页面文本、
  元素名称或 tool arguments。当前 TS 没有 `AgentDebugImageRecorder`，普通 Debug 不保存图片；历史截图诊断方案不是当前能力。
- Controlled Browser 已 dispatch action 的 action class、receipt outcome、settle kind、semantic changed、
  `page_state`、`capture_state` 和局部耗时进入 INFO；controller lifecycle、`agent_status`、Observation
  revision、安全 surface/element/screenshot 数量或大小、semantic/intent fingerprint、transition/
  capture evidence 与 Challenge dependency admitted/blocked 留在 Debug。Challenge 只作为统一
  `page_state=CHALLENGE` 记录；页面自行或经允许动作清除后记录新的普通 page state，停止时仍未清除
  则记录具体 Agent Stop/self/cycle/Candidate timeout/resource-blocked 终态。Debug 不建立 Challenge
  专属阶段、target 或交互状态机，也不记录 title、selector、iframe URL/query、页面正文、验证码内容、
  截图字节或 tool payload。显式 Debug 下的图片文件由 Agents 边界的 opt-in recorder 单独保存，不能据此
  扩大日志、Catalog 或持久化数据边界。

Elsevier Authorized lookup/download 的 response classification 在 Debug 中额外记录数值
`http_status` 和受控 `http_status_class`，用于区分认证、授权、配额、not-found、服务错误与
真正未知状态；即使 failure kind 为 response-schema，也不记录供应商 status text、header、
response body、URL/query 或 credential。

这些 Browser 字段属于 route、scheduler、Completion 的日志合同；当前生产 Application 已接入惰性 `browser:generic` escalation、Network admission、统一 flow/Intake、三级 cohort、共享 `BrowserSessionBroker` 和稳定失败映射，离线 fixture 覆盖其中的 wiring、字段和分类。真实 `verifyInstalledCloakRuntime`/CloakBrowser 执行仍未运行。实际日志只证明已执行的步骤与结果分类，不能把 production catalog、本地 runtime 就绪或 probe 成功写成组织授权或任意文章 entitlement。

携带 credential header/query 的 Network 调用不在 Network 层生成 LogRecord，避免凭据对象或别名进入日志系统；它们仍由 Provider/route/Agents adapter 在更高边界记录不含 endpoint、凭据或响应正文的安全步骤和稳定失败。这项抑制在 Debug 模式下也不放宽。Browser 日志只能记录无 secret 的 generic controller/group identity、Cloak runtime/version readiness、固定身份是否稳定和统一状态类别，不能记录 seed、完整导航目标、selector、页面文本、截图字节、Cookie、Profile 路径/内容、登录细节或签名 locator。

#### 8.3.2 Config probe 与运行日志

`config test` 的人类表格和 JSON diagnosis 是显式 probe 结果，不由 LogRecord 生成，也不进入 Catalog 或 Report。Model、Analyze 与 Browser Model probe 必须显示本地 Provider、实际发送的 wire `model`、method、安全 endpoint 和 stream on/off；Provider/MinerU probe 显示其实际无凭据 method/endpoint。安全 endpoint 不允许 userinfo、query 或 fragment，结果不展示 header、key、响应正文、供应商任意 message 或外部异常正文。

HTTP 400/401/404/429、transport 和 response/contract failure 使用同一结构化 diagnosis 驱动人类与 JSON 输出，给出当前证据支持的 reason/action；没有更强证据时，404 只能说明 wire model 或 endpoint 之一不存在。Probe 的请求上下文用于解释“本次测了什么”，不改变运行日志的 INFO owner，也不授权读取用户文献或真实页面。

#### 8.3.3 stderr 重定向

正常和 Debug 都只写 stderr。SciRetriever 不接管日志文件路径和轮转；用户需要保留文件时，用 shell、进程管理器或宿主应用把 stderr 定向到本次运行目录。例如：

```bash
sciretriever complete pdf --all-pending --json \
  > reports/completion.json \
  2> logs/completion.log

```

### 8.4 Report 边界

Logging 与 Entry Report 正交：

- 各业务模块先返回 typed result 或稳定、脱敏的 failure；
- Entry 只根据这些结果累计 `DiscoveryReport`、`DatabaseCompletionReport`、`ManualPdfReport`、`ImportReport` 或 `ExportReport`；
- Entry 可以把相同安全信息作为实时日志，但不能解析、回放或统计 LogRecord 形成 Report；
- 当前操作的 tier/group 升级摘要、等待与 action-required 可以同时用于实时 UX 和 typed failure，但不能通过日志反推、补写或扩张 Report；
- 日志被过滤、丢失、重定向或输出失败不能改变 Report、退出结果、数据库提交、版本回退或下一次 selector；
- Logging 不能替代 DiscoverySourceResult、自动 PDF 获取耗尽或其它必须持久化的业务事实。

Logging 不定义业务事件类型、运行状态或成功/失败语义，也不建立 Observer、EventBus、subscriber、日志 repository 或审计流水。

### 8.5 脱敏责任

来源边界必须先完成语义脱敏：

- Network 处理 URL、query、header、Cookie、凭据和网络异常；
- Provider adapter 处理供应商私有响应和 SDK 异常；
- Parser adapter 处理 task、私有输出和服务异常；
- Agents adapter 处理 prompt、schema、模型响应、图像、tool payload、正文片段和 SDK/协议异常；
- Entry 只记录已经稳定化的 failure 与安全 ID。

Logging 的最终字段/值过滤器 是统一最终防线，只处理已知敏感字段和明显凭据模式，并在无法安全格式化诊断值时使用固定替代文本。它不能证明任意对象安全，也不能代替来源 adapter 的边界转换。

以下内容不得作为日志 message 参数、`extra`、`exc_info` 或未受控异常正文进入 LogRecord：

- 凭据、Authorization、Cookie 和 secret reference/value；
- 完整 URL、敏感 query 和短期签名参数；
- 原始 HTTP/SDK response、response body 和外部异常对象；
- prompt、schema、模型原文/reasoning、Agent screenshot/tool payload、页面/文献正文和 Parser 私有输出；
- 用户文件绝对路径和机器相关内部路径。

Publisher resolution 只记录证据类别和 confirmed/unresolved/conflicting，不记录完整 DOI landing
URL；route hint 只记录类别和是否产生，不记录 locator；Browser 只记录统一状态变化和安全
controller/group identity，不记录 Cookie 名称、profile 文件、selector、页面标题/正文或截图。

已知外部失败转换为稳定 failure 后记录，不能无条件使用可能重新暴露原始 cause 的 `logger.exception`。意外内部编程错误的 traceback 由顶层错误边界按安全政策处理，不把外部不可信对象重新拼入用户日志。

### 8.6 故障与非持久化边界

Logging 是 best-effort 技术旁路。模块拥有的 formatter、Filter 和 Handler 必须隔离自身失败；格式化失败使用安全占位，输出故障不能向业务调用方制造新的业务失败或改变事务结果。

当前目标不建立：

- 日志文件和轮转；
- SQLite sink、Artifact 或日志 repository；
- 跨进程日志协调；
- 持久审计、日志恢复或日志驱动重试；
- 稳定 LogEvent schema；
- 依赖日志决定文献状态、处理完成度或恢复位置的机制。

用户自行重定向 stderr 不改变日志的非权威、非持久化含义。

### 8.7 依赖方向

```text
business/adapters -> logging/index.ts -> Node standard library
entry presenters -> stdout (result) / stderr (diagnosis)
contracts -X-> logging
logging -X-> business facts / SQL / artifact publication
```

调用方只依赖 `createLogger` 和 Logger；sink/formatter 是 Logging 的技术实现，不能扩为业务事件总线。宿主使用库 API 时保持自己的进程日志配置。

### 8.8 验收

当前 API 直接测试应验证基础边界；丰富 formatter/故障隔离实现时还须验证下列目标，不把尚无实现的条件记作已通过：

- `createLogger` 拒绝非法 component，minimum 过滤低等级消息且不产生配置副作用；
- package import、模块 import 和普通 adapter 构造不安装 Handler、不调用 `basicConfig()`；
- 默认 sink 只写 stderr，自定义 sink 不改变宿主 logger 或 stdout；
- 默认 info 过滤 debug，minimum=debug 保留两类记录；CLI 调试开关的接线需单独验证；
- 重复配置不叠加 Handler，stdout 不被日志污染；
- formatter 在并发 LogRecord 下保持整个静态 block 不交叉拼接；80/120/160 列折行、中文 cell 宽度、TTY 颜色、`NO_COLOR` 和重定向单色降级可直接验证；
- formatter、Filter 或输出故障不改变被记录操作的业务结果；
- 最终 Filter 对已知敏感字段使用安全替代文本，但测试仍证明每个外部 adapter 在进入 Logging 前完成自身边界脱敏；
- 原始异常、response、URL、header、Cookie、credential、prompt、正文和绝对路径不进入 LogRecord 或用户输出；
- 携带凭据的 Network 调用在 Network logger 上保持静默，而对应 Provider/route adapter 只记录安全步骤与稳定失败；
- 正常模式能解释 Public/API/Browser tier 汇总、Provider group、等待/暂停、目标结果、耗尽、稳定失败
  原因和下一动作，同时不重复输出 Entry/Cohort/route 的同一 delivery 或 tier/group 快照；Analysis
  metadata/content/publication stage、role-level Agent call 和已 dispatch Browser action/settle 在 INFO
  各有一个 owner；Debug 额外覆盖 plan revision、resolution evidence kind、Metadata raw-item
  disposition、route `disposition/next`、API target、quota feedback、Browser queue/controller/state/
  capture/cleanup 和关键 `elapsed_ms`；
- 正常模式呈现具体 Challenge Stop/self/cycle/Candidate timeout/resource-blocked、login/MFA/
  access-denied 和 Network resource failure，并显示已 dispatch action 的 receipt/settle/page/capture/
  elapsed；Challenge observed/cleared、`agent_status`、dependency outcome、安全 surface/element/screenshot
  计数、revision/fingerprint/transition evidence 只在 Debug 下钻，且同一事实只由拥有层输出一次；
- Agents Runtime 的 start/result 在 INFO 并按实际 role 区分 provider/wire model/stream/reasoning、usage/
  latency、quota/timeout/取消与 structured-result/tool-call；preflight/protocol/capability/安全大小只在
  Debug。prompt、schema、模型原文/reasoning 内容、图片、页面文本、元素名称和 tool arguments 从不
  进入 LogRecord；
- Config Model/Analyze/Browser Model probe 的 human/JSON 结果来自同一 diagnosis，显示实际 wire model、Provider、method、安全 endpoint 与 stream，并对 400/401/404/429、transport 和 contract failure 保守分类；
- 不同 Browser group 的日志可按安全 group identity 区分，同一 group 的 retry/popup/备用入口不会伪装为并行新流程；
- Cookie、profile 内容、完整 URL、selector、页面文本、短期 locator 和 Browser vendor object 在 INFO/DEBUG 两种模式都不进入 LogRecord；
- Report 在关闭、过滤或故障 Logging 时保持相同内容；日志不能生成 Report 或持久事实；
- 目标生产模块不绕过 Logging 公开 API 配置或取得项目 logger，Model 不依赖 Logging；
- 不创建日志文件、数据库表、Artifact、Observer、EventBus、LogEvent Model 或 repository。

这些测试使用内存 stream、fake formatter/Filter 和受控异常，不读取真实凭据、不连接外部供应商，也不依赖完整日志文案。

## 9. 整体协作验证

### 9.1 验收

离线入口测试至少覆盖：

- 领域 DiscoveryRun 只保存 ID、类型化 input、五态 status 和开始时间；全部本次 Provider 及各自 run-wide scan limit、逐来源三值终止结果、已接纳 MetaLiterature 和 topic cause 可查询，结束后不自动开始 PDF/Parsing/Analysis；
- 每个 Provider 在过滤和去重前按原始 item 运行到结果耗尽或 scan limit；一个来源失败保留其它来源结果和自己已接纳页面，source result 不保存过程计数，也不会为每条结果执行逐篇全 Provider 补查；
- 元数据阶段只应用标题或 DOI 的最低入库条件，不用 LLM、搜索分数、关键词、摘要分类或低收益启发式过滤或提前停止；偏题但有实际内容的文献不成为 `NoUsableContent`；
- 所有 Provider 正常到达边界、部分失败、全部失败和用户中断分别形成正确 Run 终态；零结果正常完成，用户中断保留已确认结果且不保存 cursor 续跑；
- 本地只读查询不创建 DiscoveryRun；相同发现条件再次执行形成新的运行，并基于当前数据库重新身份接纳；
- 本地搜索只接收 LibrarySearchRequest 并返回具体 Literature 的 SearchPage，单篇读取返回同一 snapshot 临时组装的 LiteratureDetail；二者不访问 Provider、不修改数据库、不形成 Report 或持久化查询结果；
- 引用页面只接收 LiteratureReferenceRequest，并从同一 Reference 正向或反向返回相关 Literature 与 support count；ReferenceDetail 返回两端和全部当前 support，二者不创建第二套 cited-by 边、Provider count 或持久化读取投影；
- QuerySelector 只复用 LibraryQuery，不接受列表 sort/limit/cursor，也不把先前页面动态当作补全目标；artifact 字节和无界关系边通过独立读取获得；
- Entry 文献业务 API 只覆盖领域/引用发现、数据库补全、手动 PDF、本地 Search/Detail/Reference 读取、Artifact 打开/导出和书目导入/导出；CLI 只使用 `discover`、`complete`、`literature`、`import`、`export`、`config` 六个一级名称及[文献操作 CLI 与 operator 入口](01-product-interface.md#312-文献操作-cli-与-operator-入口)的固定二级路径；
- `literature` 命令组保持只读；用户元数据文件与手动 PDF 分别走 `import metadata`、`import pdf`，PDF/轻结构化 Markdown 分别走 `export pdf`、`export content`，不存在 `exchange`、`bibliography`、`artifact` 或内部模块一级命令；
- 所有安装后命令只从隔离 HOME 的 `.sciretriever/config.toml` 读取普通配置，旧路径环境变量和
  cwd 文件不生效；首次确认交互编辑创建 `0700` 目录与 `0600` 文件；裸 `config` 对缺失文件
  打开当前空配置，对 malformed/未知/无效普通配置、旧 singleton section、旧 credentials
  `[agents]` 与不安全文件均在首页前返回退出码 4、保持原字节且不提供 Reset；配置中心隐藏输入，
  Provider 区安全更新/删除选中 section，LLM/MinerU 区通过可恢复顺序同步当前普通配置与
  origin-bound secret；`status` 纯本地且不显示 secret 值或特征，`test` 只通过 fake Network
  离线验证 Provider/LLM/MinerU probe 编排；旧 `config set/remove` 被拒绝；这些动作不创建
  DiscoveryRun、处理 Report 或文献数据库事实；
- Artifact 从 LiteratureDetail 中既有 Asset/ArtifactRef 取得，Model 不执行 I/O；打开返回 verified context-managed binary stream，导出默认拒绝已有目标并原子发布，二者不访问 Provider、不修改数据库或形成 Report；
- Entry 不公开 Collection、membership 或 CollectionSelector；未来人工文件夹不能通过旧 CollectionRun 残留进入当前合同；
- 供应商明确版本连接保存在 `MetadataObservation.version_links`；只有目标已经可靠解析时才允许形成共同 MetaLiterature 归属，未解析目标不触发自动补查、占位 Literature 或独立关系；
- 种子文献双向或指定方向引用 DiscoveryRun，方向、深度、去重结果数量和逐 Provider 原始扫描均有界；
- 元数据供应商返回的每条结构化关系分别保存为 `ProviderRelationObservation`，查询返回多少 observation 不会自动创建同等数量的 Literature、Reference 或 support；
- Entry 只对当前方向、深度和数量边界选中的 observation 解析目标，目标接纳后才建立 Literature 级 Reference 与 `ProviderRelationSupport`；
- 未选中、元数据不足或接纳失败的 observation 独立保留且没有扩展状态，普通元数据响应携带关系也不会自行触发下一层递归；
- PDF 或供应商原文经临时 `ReferenceLookup` 先查询本地、必要时搜索 Metadata，成功时建立关系及相应文本 support，失败或歧义时只保留原文且可重试；
- 专门关系接口与普通元数据响应按相同数据语义分类；多个来源只增加 support，不产生平行 Reference；
- DiscoveryResult 按 MetaLiterature 去重且不包含 citation seeds；topic cause 指向实际 observation，citation cause 保存 source/target Literature 与 depth，不依赖长期 ReferenceId，也不保存完整 DiscoveryPath；
- 多供应商部分失败；
- 多家 Metadata 供应商可以逻辑并发，但同一 provider/API quota 在当前进程跨调用方共享并精确执行官方政策；所有 Browser 文章共用 `browser-generic`，始终只有一个活动文章流程并遵守其 interval/window/cooldown；
- 缺 PDF 目标按有界 cohort 执行 Public → API → Browser admission 层级屏障；同一 Literature 不跨层竞速，较早成功并已提交 PDF 的目标可继续 Parsing/Analysis，等待 Network/Browser permit 不产生新的 Literature 状态或持久失败事实；
- Browser deferred/action-required 进入当前目标稳定 failure/action，不能建立自动耗尽；运行摘要不泄露 Cookie、profile 内容、完整 URL、selector 或页面动作，也不建立 BatchRun；
- `AllPendingSelector`、`DiscoveryRunSelector`、`ImportReportSelector`、`QuerySelector`、`MetaLiteratureSelector` 和 `LiteratureSelector` 六类 selector 都使用类型化 Model，不使用 selected IDs/details JSON；`ImportReportSelector` 只接受调用方从非持久化 Report 明确重新提交的有序 MetaLiterature ID，不存在 ImportRunId；
- Entry 在一致 snapshot 中把实际目标与 MetaLiterature 候选顺序冻结为内存 tuple，不保存 BatchRun、BatchTarget 或候选 snapshot；运行期间新增文献或查询结果变化不动态加入；
- 普通范围按 MetaLiterature 去重并排除已有可用版本；完成度优先于 `published > accepted-manuscript > preprint > other`，稳定 ID 提供确定性 tie-breaker；明确 Literature selector 不跨版本；
- 只有自动获取全部当前路径正常耗尽并形成事实，或 `NoUsableContent` 后本版本候选耗尽时才尝试下一 Literature；Network/Storage 系统错误、Parser/LLM 失败、取消和无法判断形成本次失败而不触发版本回退；
- `AllPendingSelector` 排除需要 PDF 且已有耗尽事实的 Literature；全部版本均耗尽的 MetaLiterature 只进入 `needs_manual_pdf` 查询范围；
- 从首个缺失步骤继续；
- 目标状态只有 `ASSET_READY` 和作为默认端到端目标的 `CONTENT_READY`，不存在独立第四状态；
- 单篇失败不阻止其它目标；
- 元数据、资产分阶段提交，最终 metadata/keywords/Markdown-string sections/references/Markdown 整体接纳；固定缺失统一渲染“未提供”；
- Discovery、数据库补全、手动 PDF、导入和导出分别形成精确 typed Report；纯查询不重复包装，内部 Acquisition/Parsing/Analysis 结果归入数据库补全报告；
- 书目 codec 只复用现有 LiteratureMetadata 并形成固定 user/bibliographic-import observation；created/enriched/matched/rejected 语义准确，首次匹配 Provider 值仍保存用户来源而完全重复 matched 不复制，CONTENT_READY 导入不拆开覆盖当前内容；
- 数据库补全 Report 的五个结果 tuple 对冻结目标不重不漏，CLI 摘要由 tuple 长度形成，不建立第二组 counts；`finished` 允许局部失败，受控中断区分正在处理与尚未开始目标；
- Report 直接返回调用方且不从日志构造；stdout 只承载稳定结果/JSON/导出数据，stderr 只承载 best-effort 进度和脱敏诊断，日志不得污染机器输出；
- Report、日志、selector、目标和候选都不建立批次 status/history 或 repository；普通异常和受控中断尽可能报告未开始目标与已提交结果；
- 硬崩溃可以没有最终 Report，之后基于当前事实重新筛选，不恢复旧运行现场；
- 旧清理链按兼容测试记录其行为；新独立 Analysis 的不适用/失败必须保留已接纳 PDF。两者分开验证，不把旧清理测试作为新材料保留合同；
- Acquisition 返回 `AcquiredPrimaryPdf` 时才继续 Parsing；无字段 `NoPrimaryPdf` 只在全部当前自动路径正常结束后形成，并建立最小耗尽事实；Network/API/权限/配置、文件/数据库/stale 提交错误形成失败且不能伪装成缺失；
- 新 MetadataObservation、成功自动或手动主 PDF、用户明确重试会原子清除耗尽事实；该事实不保存原因、候选、时间或尝试次数，也不改变 LiteratureStatus；
- 手动 PDF 必须明确具体 Literature，复制并通过 Acquisition 相同基本检查，只达到 `ASSET_READY` 且清除耗尽事实；无效文件是输入错误，已有主 PDF 默认拒绝，绝对路径和用户原文件不持久化、不移动也不进入无效内容清理；
- 当前 LiteratureContent 只有一个；成功替换时同步清理旧 content support 与无 support Reference，失败时保留完整旧结果；
- 已达到 `CONTENT_READY` 后不自动替换主 PDF，补充资产不驱动内容状态；
- BibTeX/BibLaTeX、RIS 和 CSL JSON 逐条导入导出；
- ImportReport 的已接纳 MetaLiterature ID 可以显式形成后续 `ImportReportSelector`；Report 不持久化，系统不建立 ImportRun，下一次补全仍读取 current facts；
- 导出原子文件替换；失败或中断不发布 staging file，Report 区分 published、skipped、not-published 和字段 omissions；
- 安装后的公开入口能够离线串起 R1–R8；
- CLI/入口代码不包含业务规则、SQL、网络或具体适配器构造。

### 9.2 整体验收（目标合同、非当前通过声明）

本节列出的验收层级是目标验证设计；实际是否通过必须以有日期、命令、环境和结果的直接证据为准。未运行的真实 Provider、MinerU、CloakBrowser 或生产 Catalog 验收必须明确标记为 `not-run`/`not-authorized`。

依赖审查应检查以下违规方向；这份设计不额外注册自动门禁：

- 违反[全局依赖方向](#23-全局依赖方向)依赖方向的 import；
- 跨模块导入对方私有规则、用例、Ports 或适配器；
- `storage/sqlite/` 以外使用 SQLite binding 或 SQL；
- 业务模块绕过 Configuration owner 读取普通配置或凭据；
- 入口绕过 Bootstrap 自行复制生产对象图；
- 业务模块自行建立平行日志配置或绕过 Logging 的安全输出边界；
- `packages/contracts` 导入 Logging，或 `logging` 导入任何 SciRetriever 业务模块、Model、Network 或 Storage；
- vendor SDK、HTTP、浏览器或 SQL 类型进入 Model、模块公开 API、规则或用例；
- Analysis/Acquisition 直接导入 Agents provider adapter 或 vendor SDK，或 Agents 公共 API 携带 Literature、Publisher、Page、Cookie、任意 URL/JavaScript/callable；
- 供应商业务规则进入 Network 通用访问政策；
- provider adapter、vendor SDK、普通 HTTP 或浏览器绕过共享 `NetworkBudgetCoordinator`；
- 已撤销的 `DocumentPackage` 2.0 名称、占位或类型进入目标 Model、公开 API 或持久化。

行为测试和语义审查还必须证明：

- 收集、导入、处理、查询和导出使用同一逻辑文献数据库，实际目标由用户请求与当前事实共同决定，且没有平行结果集合或处理完成状态；
- 本地 LibraryQuery 不访问外部 Provider，也不修改数据库，搜索以具体 Literature 为单位；SearchPage 和 LiteratureDetail 从同一 read-only snapshot 临时组装，metadata/status/缺失步骤/资产/ParserResult/Content/引用数量一致，且没有查询结果持久化表或无界嵌套 artifact/关系图；
- 安装后的 CLI 命令树严格使用 `discover topic/citations`、`complete`、`literature search/show/references/cited-by`、`import metadata/pdf`、`export metadata/pdf/content`、裸 `config` 交互管理器和 `config status/test`；`config set/remove` 必须拒绝。命令只负责边界解析和呈现，不包含业务规则。未实现的目标命令**不得**作为当前可用能力写入 README 或用户指南；如确需给出目标接口示例，必须逐段显式标注“目标合同·未实现/部分实现”、链接对应 architecture/ADR，且不得附带完成状态或证据声明，也不得要求用户读取尚未输出的分区。当前实现已存在的内部/operator 入口（`storage`/`doctor`/`jobs`）必须在用户文档中标为内部入口，不得计入六个一级名称的目标合同；
- Metadata Provider 与 Acquisition Provider 使用独立中性合同，引用能力只作为 Metadata 可选能力；目标 Adapter 矩阵、用户启用状态、生产实现和 readiness 分开表达，未实现目标不得伪装成当前集成；
- `credentials.toml` 的 owner、普通文件、非符号链接、目录 `0700`、文件 `0600`、字段 allowlist、核心服务 origin 绑定和可恢复发布均 fail closed；secret 不进入 Model、CLI 参数/输出、数据库、Report、日志或生产 fixture；`config status` 不联网且不显示任何 secret 特征，离线测试中的 `config test` 使用 fake Network，但显式生产 Probe 可在授权后执行一次受控真实只读请求；
- references/cited-by 页面从同一 Reference 正反向读取相关 Literature 与 support count，ReferenceDetail 才返回两端和全部当前 support；页面/详情不持久化、不形成 cited-by 副本，也不混入 Provider citation count；
- Artifact reader 只接受 Detail 中已有 Asset/ArtifactRef，验证相对引用、普通文件、size/hash/media type 后返回 context-managed stream；用户文件导出默认拒绝覆盖并原子发布，内部绝对路径、目标路径、副本和导出结果不进入数据库或处理 Report；
- 持久化 DiscoveryRun 只表达有边界外部发现，数据库补全只在当前进程内冻结范围；当前合同不存在 Collection，领域发现不会自动触发 PDF、Parsing、Analysis 或逐篇全 Provider 补查；
- Provider scan limit 在整个 DiscoveryRun 内按过滤和去重前原始 item 消耗；source result 不保存过程计数，Metadata 不执行领域语义过滤或低收益提前停止；
- DiscoveryResult 按 MetaLiterature 去重，topic cause 指向 observation，citation cause 保存 source/target Literature 与 depth；不存在长期 ReferenceId 依赖或完整 DiscoveryPath；
- 同步 completion 的六类 BatchSelector 在内存中冻结实际目标；durable Job 的独立持久化合同仍有效；`ImportReportSelector` 只接受调用方明确重新提交的有序 MetaLiterature ID，不建立 ImportRun；普通 MetaLiterature 目标只在自动 PDF 获取正常耗尽或独立材料有效性规则确认不可用且候选耗尽时切换版本，系统/Parser/LLM 失败不切换；
- 五类处理型 Entry Report 和三种 `ReportEnd` 严格使用 Model 精确合同；数据库补全五分区覆盖全部冻结目标，导入逐记录分区，导出只在原子发布后报告 published，受控中断尽可能报告已完成情况；不出现 ReportId、自由 details、日志数组或第二套 counts；
- Report 只从 typed result 和稳定 failure 形成并直接返回调用方；Logging 模块只提供 stderr 上的 best-effort 旁路，不能污染 stdout、改变业务结果或替代持久事实，其最终 Filter 不能替代各外部边界的脱敏；
- 自动 PDF 获取耗尽只保存具体 LiteratureId，在新 observation、成功主 PDF 或明确重试时清除；临时错误不建立耗尽事实，查询能够筛选 `needs_manual_pdf`；
- 手动 PDF 只接纳到明确具体 Literature，复制且不伤害用户原文件，不保存绝对输入路径，不进入自动三阶段或二值 AcquisitionResult；
- 中断和崩溃后的新运行重新读取当前事实，不依赖恢复旧外部调用、线程、队列或内存现场；
- `network` 和 `storage` 不形成文献身份、业务验收、状态或导出资格决定；
- Metadata、Acquisition、Parsing 和 Analysis 的外部请求在当前进程共享 provider/channel/host 准入；API 精确遵守官方 quota scope 与反馈，唯一 `browser-generic` 最大并发为 1 且满足通用文章政策；
- Acquisition 的 Resolution/Plan 由 AssetHint、稳定定位、Provider record identity 和必要时安全解析后的 DOI landing origin 决定；不能按 publisher 字符串、单独 DOI prefix 或 MetadataObservation 来源硬编码内容 API/Browser，readiness/权限错误也不能形成 `NoPrimaryPdf` 或自动获取耗尽；
- 缺 PDF 目标按有界 cohort 完成 Public → API → Browser admission，单篇不能提前跨层；timeout、临时错误、`429`/quota 和 Browser 未解决页面不触发备用入口绕行；
- 每次 Browser navigation、popup、viewer、response 和 download 在访问前同时通过 Profile guard 与 Network policy；重试、多标签页和备用入口不能绕过组内串行、interval、cooldown 或 circuit；
- 一个 operator-managed 固定身份 Browser Profile 同时只由一个 CloakBrowser Chromium process 使用；所有 Publisher
  lane 在当前对象图共享一个 persistent context，Browser 统一在 `browser-generic` 串行，不按 publisher 拆并行组，每篇
  文章使用隔离 page/handler/临时下载目录；broker 关闭后删除 runtime 临时资源但保留 Profile。
  自动流程不填写凭据、选择机构或处理 MFA；人类操作范围仍待独立设计，不因协作接口自动扩大。Agent controller
  可以通过统一页面动作处理当前文章中的可见 Challenge。Cookie、seed、
  Profile 路径/内容、登录细节、完整 URL、selector 和页面对象不进入配置内容、status、日志、
  Report、provenance 或文献数据库；
- 同一 Browser Profile 跨冷启动保持固定 seed 派生身份、native Linux persona、语言/时区/屏幕/字体与 Browser version 表面一致；CloakBrowser 是唯一生产 runtime，不存在公开或隐藏的 stock launcher、系统 Chrome、Playwright bundled Chromium 或其它 fallback；
- 经核实的 challenge dependency 只有在批准 Publisher 顶层页面、frame ancestry、当前文章 permit 和页面生命周期内可加载；Challenge 使用统一 Observation/Action/capture，资源阻断与普通 access denied 分别稳定化，challenge 资源不能成为 capture；
- Analysis 与 Browser 通过同一无状态 Agents runtime 获得统一单次执行、capability/readiness、limits、取消和稳定失败；二者选择同一 Model Provider 时共享 provider/account quota adapter，选择不同 Provider 时分别使用对应 adapter。Analysis 仍验收文献结果，唯一 Browser Agent 只返回六种封闭动作并由 Network 执行；
- 等待队列、permit、窗口计数、`next_allowed_at` 和 `blocked_until` 只存在于当前进程内存，不包含 DOI、Literature、候选、URL、凭据或响应正文，也不进入 Catalog、ArtifactStore、provenance 或协调文件；
- 外部调用不在 SQLite 事务中执行；
- 功能模块不直接创建或覆盖最终文件；
- 间接调用、别名或动态值不能绕过模块责任；
- 目标架构、当前实现和迁移计划没有被混写。

离线产品验收覆盖 R1–R13，并区分兼容行为、新目标与生产证据：

- R1–R3/R6/R8：有界发现、来源保留、保守身份/版本收敛、冻结范围、分层 PDF 获取与统一验收、配置/凭据隔离、共享访问准入、原子提交、局部失败和取消；不能把未解决失败记作正常耗尽。
- R4/R5/R9：无需 Analysis 即可解析/读取材料；多用途压缩绑定输入和证据；定位正确、语义支持、重要条件/局限保留分别验证；长文覆盖与预算如实表达；替换、失效和回收不静默破坏有效引用。
- R10/R11：通过正式 adapter 验证范围/预算内检索、去重、逐层展开、稳定错误与取消，并证明查询无隐式生成、人类与 Agent 读取同一事实。检索质量须记录语料和评价依据，不能以单元测试数代替。
- R12：正式 Browser 获取中的全程观看、指导受理、接管/交还、在途动作和旧命令失效、断线重连及跨文章隔离；静态页面或单次模型动作不能替代完整旅程。
- R13：外部程序按调用方规范读取材料并交付候选；替换记录结构与提取算法无需核心领域字段，结构/证据/领域验收分开，部分覆盖、重复提交和取消有直接验证。
- R7 与既有格式：保留书目交换、旧单篇两阶段/七标题内容、现有报告与 ID/hash 的兼容验证；受 ADR 0026 修订的清理规则不能继续作为新行为的验收要求。

Harness、单元测试、构建和安装后离线验收不读取真实用户凭据、Cookie、外部 Profile、生产数据库或用户语料。外部依赖使用 fake/fixture 或 loopback；真实 runtime binary、真实服务与生产切换分别注明环境、授权、命令及结果。当前实现证据仍以基线、源码和直接测试为准，本节不宣称新目标已通过。

### 9.3 兼容与验证边界

先用固定 synthetic v1 fixture 验证 contracts、canonical bytes/hash、配置和基础运行时，再实现 Network、
FileStore、DB Worker、Agents、Browser、Acquisition 与业务。每个切片的直接测试按行为命名，并至少覆盖
一个拒绝、失败、取消、恢复或回滚路径。按 2026-09-10 项目 owner 决定，以 TS `pnpm quick/test/full`
作为后续验证入口，不再默认执行 Python Full；实际 Chromium、原生 SQLite binding、真实 Provider、用户数据库和生产切换分别保持授权边界。

任何 v1 bytes/hash/schema、owner、secret、SSRF、不可变发布、Candidate 对账或恢复差异都阻断下游并回到
对应 owner；不在后续模块增加长期兼容旁路。
