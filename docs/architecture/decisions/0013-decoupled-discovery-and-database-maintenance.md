# ADR 0013：外部发现与数据库补全解耦

- Status: Accepted
- Date: 2026-08-10
- Supersedes: none
- Superseded by: none
- Amends: [ADR 0008](0008-summarized-markdown-literature-content.md)、[ADR 0011](0011-literature-database-centered-incremental-maintenance.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[Entry 技术文档](../technical/entry.md)、[Acquisition 技术文档](../technical/acquisition.md)、[Storage 技术文档](../technical/storage.md)

## 背景

SciRetriever 已经确认以统一逻辑文献数据库为产品中心，但“用户发起一次外部发现”与“下载 PDF”“解析并总结内容”之间的关系仍然没有收口。把这些行为固定成一次从搜索到内容完成的线性流水线，会带来三个问题：

1. 旧 `CollectionRun` 容易把一次查询、发现结果、长期分组和内容处理混成一个概念；
2. 数据库中已有文献的完成度天然参差不齐，却只能依附某次收集运行继续处理，无法直接对当前数据库补齐缺失 PDF 或内容；
3. 同一文献具有多个明确版本时，批量处理要么盲目处理全部版本，要么把一个版本的临时系统失败错误解释成整个文献不可用。

讨论中曾把 `Collection` 保留为可选、长期命名的 `MetaLiterature` 集合。但当前核心工作流并不需要这一层：历史发现已经由 `DiscoveryRun` 保存，当前语义范围可以通过数据库查询表达，明确处理对象也可以直接使用 ID。若把 Collection 当作领域占位符，就必须回答自动归属和语义相关性；若把它限定为 Zotero 式手工文件夹，它又是尚未确认的独立产品功能。因此当前目标不能仅为兼容旧概念保留 Collection。

讨论中也曾为数据库补全设计持久化 `BatchRun`、冻结 target、版本候选、逐目标结果和 counts。它们并不决定下一步：下一次操作仍然必须读取 Literature 当前是否有 PDF、ParserResult 或 LiteratureContent。把运行报告保存成另一套表只会引入状态机、恢复规则和与当前事实漂移的风险。用户需要的是每次操作结束时能够看到本次完成情况，而不是长期任务历史；因此补全范围与报告应只存在于当前进程。

但“某个具体 Literature 已经正常耗尽当前全部自动 PDF 获取路径”不同：如果不保存，下一次全库补全会无限重复选择它。这个事实必须以最小形式进入 Catalog，因为它会改变未来选择；网络失败、候选详情和运行统计仍然没有这种用途。

用户还需要在自动来源无法获得 PDF 时，把自己已有的本地 PDF 明确接纳到某个具体 Literature。这个动作需要复用 PDF 基本检查和资产发布规则，但不能伪装成公开来源、授权 Provider API 或受控浏览器之后的第四个自动获取阶段。

## 决策

### 1. DiscoveryRun 只表达一次有边界的外部发现

每次会访问外部元数据来源、把发现结果接纳到文献数据库的领域搜索或引用扩展，都形成独立 `DiscoveryRun`。它只负责冻结本次类型化输入和停止边界，作为来源结果、发现结果与原因的稳定关联锚点，并表达本次发现是否完整执行。Run 本体只保存 ID、输入、状态和开始时间；不保存名称、描述、完成时间、cursor、页码、请求、重试现场或结果数组。

`DiscoveryRun` 创建即进入 `RUNNING`，最终状态只有 `COMPLETED`、`PARTIAL`、`FAILED` 或 `INTERRUPTED`。零结果仍可以正常 `COMPLETED`；不存在排队阶段的 `CREATED` 或把零结果解释成无处理目标的 `NO_TARGET`。用户在正常边界前主动停止，或恢复时发现遗留 `RUNNING`，才形成 `INTERRUPTED`；已经接纳的结果绝不回滚，也不保存 cursor 供原地续跑。

本地数据库查询只是当前事实的读取，不形成 `DiscoveryRun`。`DiscoveryRun` 也不是文献处理流水线：运行完成后不自动下载 PDF，不启动 Parsing、Analysis 或下一次引用扩展。`ReferenceLookup` 只在用户明确发起的引用 DiscoveryRun 内按需使用，不能由普通领域结果自动触发。

### 2. 领域发现按 Provider 分别有界，不执行逐篇全源补查

一次领域 `DiscoveryRun` 调用本次启用的全部 Metadata Provider。每个 Provider 在整个 Run 内具有独立 `scan_limit`，统计过滤和去重前返回的每一条原始 item；无标题/DOI、重复或最终未接纳的 item 仍消耗扫描额度。Provider 自然耗尽或达到 `scan_limit` 都是正常边界，不是中断；单个 Provider 失败不撤销其它来源已经接纳的结果。

每条成功返回先转换为独立 `MetadataObservation`，再由 Literature 按普通身份规则接纳。结果可以逐条提交，不必等待全部 Provider 完成。初始领域搜索结束后，系统不会因为发现了一篇 Literature，就自动再对这篇 Literature 执行一次 `N × Provider` 的精确补查；新的外部补充必须由后续明确操作发起。

元数据发现阶段只执行最低结构准入：非空标题或 DOI 至少存在一个。Provider 在本次查询下返回一条记录，只表示它是本次外部发现的候选，不表示 SciRetriever 已证明其与目标领域语义相关。当前不使用 LLM、embedding、搜索分数阈值、标题关键词命中、摘要分类或连续低收益启发式过滤或提前停止；真正的领域判断留给后续最终关键词和用户查询。具有实际内容但偏离最初主题的文献仍是有效 Literature，不属于 `NoUsableContent`。

每个 Provider 只持久化 `EXHAUSTED`、`SCAN_LIMIT_REACHED` 或 `FAILED` 之一，以及失败时的稳定脱敏信息；不保存扫描、接纳或拒绝计数。运行时原始计数只用于执行 `scan_limit`。Provider cursor、请求与响应、搜索候选、相关度、分页现场和未接纳结果只服务当前调用，不进入 `DiscoveryRun` 或文献数据库。Adapter 仍必须使用 timeout、重复 cursor 和空分页循环防护，但这些机械保护不扩展 DiscoveryRun 业务字段。

### 3. 引用扩展也是独立且有边界的 DiscoveryRun

引用扩展必须具有明确的具体 Literature 种子、方向、深度、去重后结果数量和逐 Provider 原始扫描边界。`result_limit` 统计本次不同 `DiscoveryResult` 的数量：新入库和已经存在的 `MetaLiterature` 都计数，输入种子不计数，同一 MetaLiterature 重复到达只计一次。Provider 的 `scan_limit` 作用于整个 Run，而不是每个种子、每层或每次请求分别重置。

`ProviderRelationObservation` 可以作为待扩展来源事实存在，但只有本次范围选中的目标才取得必要元数据并按普通 Literature 规则接纳；保存关系 observation 或取得某个目标的元数据都不自动触发下一层。

每个 `DiscoveryResult` 只保存 `(discovery_run_id, meta_literature_id)`，同一 Run 内按 MetaLiterature 去重。主题原因指向实际 `MetadataObservation`；引用原因保存本次发现时实际引用方向的 source/target Literature 和 depth。原因是不可变历史事实，不长期依赖以后可能因可重建内容替换而删除的当前 `Reference`。直接引用原因和 depth 已足够表达发现链，不再保存会重复并组合膨胀的完整 `DiscoveryPath`。

一次引用扩展不会继续无界递归。用户需要继续扩展时发起新的 `DiscoveryRun`，新运行重新读取当前 Literature、Reference 和 relation observation 事实。

### 4. 当前产品不建立 Collection

当前目标架构删除 `Collection`、`CollectionMembership`、membership cause 和 `CollectionSelector`。外部发现历史由 `DiscoveryRun` 表达；当前动态范围由类型化数据库查询表达；一次明确处理范围可以使用 DiscoveryRun、导入、查询或 MetaLiterature/Literature ID。系统不创建领域占位符，也不根据元数据、搜索条件或 LLM 标签判断文献是否“属于某个 Collection”。

未来若确认需要 Zotero 式人工文件夹，必须把它作为独立、显式的用户组织能力重新提出。该能力只能直接锚定用户选中的文献，不得借 Collection 名称恢复自动领域归属、保存查询或强制发现流程；在需求获得确认前不预留目标 Model、表或 selector。

### 5. 数据库补全是当前进程内的独立操作

Entry 提供两个核心维护目标：

- `ASSET_READY`：为当前没有可用版本主 PDF 的对象补齐主 PDF；
- `CONTENT_READY`：从每个对象当前第一个缺失步骤继续，必要时先补 PDF，再完成 Parsing、Analysis 和 Literature 接纳。

一次补全由运行时 `BatchRequest` 表达，只有一个类型化 `BatchSelector` 和一个 `BatchGoal`。当前接受的 selector 为：

```text
BatchSelector =
    AllPendingSelector
  | DiscoveryRunSelector
  | ImportReportSelector
  | QuerySelector
  | MetaLiteratureSelector
  | LiteratureSelector
```

它们分别表达全库当前仍可自动推进的对象、某次 DiscoveryRun 已接纳的对象、调用方从一次书目导入 Report 明确重新提交的对象、类型化本地查询、明确 MetaLiterature 和明确 Literature。`ImportReportSelector` 只携带 `ImportReport` 返回的有序 MetaLiterature ID，不引用或建立 ImportRun；同一进程可以直接传递，跨进程只有用户自行保留 Report 并再次提交这些 ID 时才成立。Entry 每次仍重新读取 current facts，旧 Report 不是目标状态。

Selector 是用户发起本次操作的输入，不保存到 Catalog，也不携带 Provider、并发、Parser、LLM、`force`、重试、cursor 或自由 `details`。Entry 从当前数据库展开 selector、排除已经满足目标或当前不能自动推进的对象，并在当前进程内冻结不可变目标 tuple；运行期间新增文献或后来符合查询的对象不加入本次操作。不同目标可以在资源预算内有界并行，每个目标按自身第一个缺失步骤端到端推进。

本设计不建立持久化 `BatchRun`、`BatchTarget`、批次状态机、目标结果表、版本候选快照或批次计数。再次执行相同请求时重新展开 selector 并读取最新 current facts，不恢复上一轮目标、队列或执行现场。

### 6. MetaLiterature 范围默认只取得一个可用版本

DiscoveryRun、查询、导入和全库维护等普通范围先按 `MetaLiterature` 去重；实际元数据、资产、ParserResult 和 LiteratureContent 仍归具体 `Literature`。默认目标是让每个 MetaLiterature 至少具有一个达到所选目标的可用版本，不盲目补齐全部版本。用户明确选择具体 Literature 时，只处理该版本，也不跨版本回退。

对于尚未满足目标的 MetaLiterature，Entry 在本次操作开始时只在内存中冻结有序的具体 Literature 候选。候选先复用完成度更高的成员：

```text
CONTENT_READY
  > 已有当前 ParserResult
  > 已有当前主 PDF
  > 没有上述结果
```

完成度相同时，才使用代表版本顺序：

```text
published
  > accepted-manuscript
  > preprint
  > other
```

只有已经形成稳定“本版本当前无法自动取得可用内容”的事实时才尝试下一版本：Acquisition 正常遍历全部当前自动路径后返回 `NoPrimaryPdf`，或者 Analysis 明确返回 `NoUsableContent` 且本版本在当前操作中的其余 PDF 候选也已耗尽。Storage/Network 系统错误、Parser 失败、LLM 失败、取消或无法判断只表示本次没有完成，不能证明该版本不可用，也不能触发跨版本回退。

成功 PDF 和内容始终归实际成功的具体 Literature，不转移到代表版本。`MetaLiterature` 不保存独立状态；“是否至少有一个可用版本”从成员当前事实推导。

### 7. 自动 PDF 获取耗尽是会影响后续选择的当前事实

当 Acquisition 已经正常遍历某个具体 Literature 在当前元数据和已配置能力下的公开来源、已授权 Provider API 与受控浏览器路径，仍然没有获得主 PDF 时，先形成：

```text
AutomaticPdfAcquisitionExhaustion
  literature_id: LiteratureId
```

该事实安全提交后，Acquisition 才返回无字段 `NoPrimaryPdf`。它只表示“当前自动路径已经正常耗尽，需要用户人工提供 PDF 或明确要求重新尝试”，不保存原因、候选、Provider、配置 hash、尝试次数或过程状态，也不增加 Literature 的第四种状态；没有主 PDF 的 Literature 仍为 `UNREVIEWED`，查询只投影 `needs_manual_pdf = true`。

用户中断、Network/API/权限/配置错误、Storage 错误、Parser/LLM 失败、取消或无法判断不能形成该事实。`AllPendingSelector` 默认排除需要 PDF 且已有该事实的具体 Literature；当一个 MetaLiterature 的全部可用版本都已耗尽时，它不再进入自动补全目标，而进入需要人工 PDF 的查询范围。

以下任一变化必须清除该事实：

- 接纳新的 `MetadataObservation`，因为自动获取输入已经变化；
- 自动或手动成功接纳主 PDF；
- 用户明确要求重新尝试该 Literature 的自动获取；以 `LiteratureSelector` 明确选择这个具体 Literature 并以需要 PDF 的目标发起补全，属于这种明确重试，宽范围 selector 不自动清除。

最小实现允许在接纳任意新 MetadataObservation 时直接清除，宁可多尝试一次，也不为判断线索是否实质变化引入额外规则。该事实进入 Catalog 的唯一理由是它会改变未来自动目标选择；普通网络失败、逐候选失败和运行统计仍不持久化。

### 8. 手动 PDF 接纳是独立用户操作

用户可以明确选择一个具体 Literature 并提供本地 PDF。Entry 调用 Acquisition 的手动接纳操作，系统复制而不是移动用户文件，并对内部副本执行与自动获取相同的 PDF 基本检查。用户原文件永远不由 SciRetriever 修改或删除。

手动接纳沿用正常 `Asset`、唯一 `primary-pdf` `LiteratureAsset`、不可变发布、hash 和 `source_kind = "user"` provenance；Catalog 不保存用户文件的机器绝对路径。已有当前主 PDF 时默认拒绝，不静默替换。

手动文件无效是输入验证错误，不是 `NoPrimaryPdf`，也不增加第三种自动 `AcquisitionResult`。手动接纳不进入 `AcquisitionPath`；自动获取仍只有 `public`、`authorized-provider-api` 和 `controlled-browser` 三个阶段。

成功手动接纳只使具体 Literature 达到 `ASSET_READY`，并清除该 Literature 的自动获取耗尽事实。后续内容补全由新的独立操作发起。Analysis 后续明确判断无实际内容时，只清理 SciRetriever 管理的内部副本和派生结果，绝不删除用户原文件。

### 9. 每次处理型操作形成非持久化运行报告

DiscoveryRun 继续持久化，因为它的查询条件、种子、发现对象和直接原因无法从当前 Literature 事实反推；它不是为了恢复运行进度而保存。数据库补全、手动 PDF、书目交换和其它处理型 Entry 操作则在当前进程内形成面向用户的 typed Report 并直接返回调用方；PDF 获取、Parsing 和 Analysis 作为数据库补全阶段时汇总到同一报告，不建立持久化运行实体。纯查询直接返回 read result。

运行报告只说明本次实际选择、完成、缺失、失败、未处理和停止情况，不复制文献元数据、PDF 或内容，不参与 Literature 状态或下次目标选择。正常结束、普通异常和用户受控中断应尽可能完成报告；`kill -9`、断电等无法执行收尾逻辑的硬崩溃不保证生成最终报告，但已经原子提交的事实保持有效。

Report 按 Discovery、数据库补全、手动 PDF、导入和导出分别使用精确合同，只共享正常结束、受控中断和操作级失败三种最终停止方式；不建立大型通用 envelope、ReportId、时间、日志数组、自由 details 或第二套批次 counts。精确字段由 Model 与 Entry 技术文档定义。

逐条 Logging 是与 Report 正交的 best-effort 实时反馈：Entry 只从 typed result 和稳定 failure 累计 Report，不能解析日志反向生成；日志不持久化、不参与业务决定，缺失或输出失败也不能改变操作结果。Logging 作为第四个公用基础模块，统一项目 logger 获取、生产进程配置、stderr 输出和最终脱敏防线，但不建立 Observer、EventBus、LogEvent Model、repository 或业务状态；精确目录与 API 属于技术合同。

Network permit、Provider cursor、下载 tried set、Parser/LLM 现场、内存目标和候选顺序同样只服务本次操作，不持久化。重跑总是重新读取当前 Catalog 与 ArtifactStore。

## 后果

- 用户可以先快速积累元数据，再按全库、某次发现或查询结果独立补齐 PDF 和内容。
- 外部发现不再制造领域占位符；当前目标架构不为尚未确认的人工文件夹功能保留 Collection 合同。
- 原始扫描上限能够约束持续返回低质量结果的 Provider，又不会在元数据阶段引入昂贵且不可靠的领域相关性判断。
- 补全目标在当前操作中保持稳定且不受运行期间数据库新增文献影响；重跑从最新 current facts 重新形成范围，无需保存批次历史。
- 多版本文献默认只需要取得一个可用版本，已完成资产得到优先复用；临时系统故障不会被错误地当成版本缺失。
- 自动获取耗尽作为最小当前事实阻止全库操作无限重试，同时不保存候选级失败或引入任务状态机。
- 手动 PDF 与自动获取共享资产质量和发布边界，但不会扩大自动来源顺序或威胁用户原文件。
- 每次操作都能向用户说明本次结果，但运行报告不会成为数据库历史或第二真相源。
- 目标实现需要把旧 `CollectionRun` 中混合的发现和处理职责拆分为持久化 DiscoveryRun 与内存数据库补全操作，并删除其 Collection 概念残留；这不代表当前代码已经完成迁移。

## 未采用的方案

- 不保留领域占位符、自动归属集合或尚未确认的 Zotero 式人工文件夹；
- 不把领域搜索或引用扩展默认连接为自动 PDF、Parsing 和 Analysis 流水线；
- 不根据搜索分数、关键词、LLM 或连续低收益启发式在元数据阶段判断领域相关性或提前停止；
- 不用 accepted count 代替 Provider 原始扫描上限；
- 不保存完整引用发现路径、Provider 扫描计数、cursor 或完成时间；
- 不在补全操作运行中动态吸收新目标；
- 不保存 BatchRun、BatchTarget、候选快照、普通目标失败或批次统计；
- 不默认处理同一 MetaLiterature 的全部版本；
- 不因 Parser、LLM、Network 或 Storage 系统错误切换到其它版本；
- 不把手动 PDF 伪装成第四种自动 AcquisitionPath。

## 需要新 ADR 的变化

以下变化需要新的 owner 决策：

- 增加 Zotero 式人工文件夹、保存查询、领域自动归属或其它 Collection 能力；
- 让 DiscoveryRun 默认自动启动 PDF 获取、Parsing 或 Analysis；
- 在元数据发现阶段增加语义相关性判断、自动清理偏题文献或低收益停止机制；
- 让运行中的补全操作动态吸收范围内新增文献；
- 建立需要持久化状态、目标、候选、进度或恢复现场的通用任务系统；
- 普通 MetaLiterature 范围默认补齐全部版本，或允许系统错误触发跨版本回退；
- 把手动 PDF 纳入自动来源三阶段，允许静默替换当前主 PDF，或允许 SciRetriever 移动、修改、删除用户原文件；
- 让 DiscoveryRun、运行报告或内存补全状态取代 Literature 当前事实决定文献可用程度。
