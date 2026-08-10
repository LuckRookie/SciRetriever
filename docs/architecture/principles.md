# SciRetriever 架构原则

本文把[产品需求](requirements.md)和[架构决策](decisions/README.md)转换为实现与审查时长期遵守的原则。它不替代[设计文档](design.md)，也不提前决定尚待讨论的 schema、算法、进程模型或用户界面。

## 1. 文献数据库是产品中心

SciRetriever 的产品是持续积累、查询和维护的统一逻辑文献数据库。它不是一次流水线结束后附带留下的文件集合，也不等同于 SQLite、某组数据表或 Storage 模块；目标实现中的结构化 Catalog 与不可变 ArtifactStore 共同承载这套数据库。

所有产品操作都从“用户输入 + 当前数据库事实”开始。查询和只读导出直接使用一致的当前事实；会改变数据库的操作由 Entry 形成实际范围，各事实所有者判断哪些内容已经有效、仍然缺失或明确失效，只调用必要的外部能力，验证后把新事实提交回同一数据库。新收集也先结合已有数据库进行身份命中和去重；重复运行和崩溃恢复重新读取当前事实，不恢复旧网络、浏览器、Parser、LLM 或内存任务现场。

Metadata Provider、Acquisition、Parser、LLM、Execution、SQLite 和文件系统都是维护这套数据库的能力或实现，不能各自形成第二真相源。新增功能必须说明它读取哪些当前事实、形成哪些新事实、由谁拥有含义、如何保留 provenance，以及如何根据数据库状态重试或恢复。

本地搜索列表、分页结果和单篇详情是从同一已提交 snapshot 临时组装的不可变读取投影，不是需要持久化的新业务实体。它们不获得独立 ID、provenance、revision 或数据库表，也不能作为写入输入；每次读取都从当前权威事实重新形成。投影可以包含低成本派生的状态、第一缺失步骤、人工 PDF 标记和引用数量，但不能因此复制第二份可修改事实。

引用正向列表、被引列表和关系详情遵守同一原则：references/cited-by 只是同一权威 `Reference` 的两个读取方向，Provider citation count 不能混入本地关系数量。大型 artifact 字节也不嵌入 Detail；Detail 只给出既有 Asset/ArtifactRef，verified reader 负责在存储根内复核并打开只读 stream。用户文件导出是原子、默认不覆盖的读取侧 I/O，不让 Model 执行 I/O，也不把内部路径、用户目标、副本或结果写回文献数据库或处理 Report。

### 1.1 发现与补全保持分离

外部发现和数据库补全是两种独立操作：`DiscoveryRun` 长期记录一次有边界的领域搜索或引用扩展；数据库补全从运行时 `BatchSelector` 展开范围，只在当前进程内冻结目标并补齐主 PDF 或最终内容。两者可以关联，但不能共享一份含义混杂、可以漂移的状态。

一次发现不自动启动 PDF、Parsing 或 Analysis；本地只读查询不伪装成外部发现。当前产品不建立领域占位符或 Zotero 式人工 Collection，也不预留 membership 或 Collection selector。补全操作从当前事实形成新目标，不保存 BatchRun、目标、候选快照或普通失败，重跑也不恢复旧发现或处理现场。精确边界见 [ADR 0013](decisions/0013-decoupled-discovery-and-database-maintenance.md)。

每个 DiscoveryRun 的 Provider 原始扫描在整个 Run 内分别有界，过滤、最低身份准入和去重前的 item 都消耗 `scan_limit`。元数据阶段只要求标题或 DOI 至少存在一个，不通过 LLM、搜索分数、关键词、摘要分类或低收益启发式判断领域相关性；有实际内容但偏题的文献仍然有效。Run 完成后只保存类型化输入、整体状态、逐来源终止结果、按 MetaLiterature 去重的发现对象及其直接原因，不保存计数、cursor、完整路径或完成时间。

普通 DiscoveryRun、查询、ImportReport 结果或全库范围先按 `MetaLiterature` 去重，默认只要求至少一个具体版本达到目标。ImportReport 只有在调用方明确重新提交其中的 MetaLiterature ID 时才形成范围，不建立 ImportRun。完成度优先于版本角色；只有已经正常耗尽当前自动 PDF 获取路径，或明确无实际内容且本版本候选耗尽时才尝试下一版本。Parser、LLM、Network 或 Storage 系统失败不能冒充版本不可用。成功事实始终归实际处理的具体 `Literature`，`MetaLiterature` 不保存第二份状态。

每次用户发起的处理都形成操作特有的 typed Report 并直接返回入口调用方；纯查询结果不重复套 Report，内部处理阶段归入发起它们的数据库补全报告。报告说明本次选择、完成、缺失、失败、未处理和停止情况，但不持久化、不参与后续选择，也不成为第二真相源。硬崩溃可能来不及生成最终报告；已经提交的当前事实仍然有效。

Logging 是公用基础模块，只提供当前进程的 best-effort 实时进度和安全诊断。具有运行行为的模块通过它的公开 API 获取命名 logger，生产 Bootstrap 通过同一 API 完成一次性配置；Entry 从 typed result 和稳定 failure 独立累计 Report，不能解析日志反向构造。日志缺失、过滤或输出失败不能改变业务结果，稳定 CLI/JSON 结果走 stdout，日志走 stderr；不建立全局 Observer、事件总线、日志 Model、repository 或持久历史。

## 2. 需求先于实现

SciRetriever 的目标是根据用户指定的领域条件或种子文献大批量发现文献，并允许用户基于同一数据库独立补齐资产、Parser 中间解析和 LLM 总结型轻结构化文档，最终形成可查询并可交换书目信息的文献数据库。

`MetaLiterature`、`Literature`、状态、parser、CLI、数据库引擎和其它技术机制只能用于满足该目标，不能反向定义产品需求。当前代码已经存在的能力也不会自动成为长期产品合同。

## 3. 领域边界

SciRetriever 只拥有通用文献信息：

- 文献身份和通用元数据；
- 文献资产及其来源、hash 和关系；
- 领域中立的轻结构化文档；
- 同一轻结构化文档中的领域中立结构化章节；
- 产生上述结果所需的 provenance、处理证据，以及确实会改变后续选择的当前缺失事实。

规范 Markdown 与结构化章节必须来自同一次有序两阶段逻辑分析并能够追溯到同一 ParserResult 和原始资产：先确定最终元数据，再以该元数据为上下文总结正文。两阶段不能形成相互漂移的内容或平行元数据。反应、分子、路线、产率、材料性质等特定领域数据属于下游消费者，不进入 SciRetriever 文献数据库。下游消费者自行决定领域 schema、导出格式和存储方式。

## 4. 来源事实不能丢失

元数据供应商返回的记录和带来新来源事实的用户书目导入记录都先作为独立、不可变的 `MetadataObservation` 长期保存，再形成统一文献视图。一个 `Literature` 可以关联多个 observation；新来源观察增加新对象和关联，不能原地覆盖既有 observation，重复导入相同规范化内容也不能制造重复 observation。一个来源不能无声覆盖另一个来源，合并规则变化时应能够从保留的事实重新计算。

每个 Literature 只维护一份当前 `LiteratureMetadata`。内容分析前，它由关联 observations 确定性形成：用户导入 observation 的非空书目信息优先，按配置排序的供应商 observations 只补齐缺失字段。完整 Analysis 接纳后，当前值由统一初始元数据、PDF 明确信息和经过验证的 LLM 提案形成；除全文关键词和已有合同允许的规范化外，用户导入的非空值继续保留。旧统一元数据不保存为历史 revision；`metadata_revision` 只标识当前值的变化并服务 stale 复检及当前 LiteratureContent 对齐。LLM 提案不是新的 MetadataObservation，来源 observations 始终继续保留。

供应商专有响应在 adapter 边界转换为中性结构，书目文件在 Entry codec 边界转换为同一中性元数据合同；两者都不能把外部私有对象穿透到核心数据合同，也不建立平行的导入元数据模型。

作者信息按具体 Literature 中的有序署名保存。ORCID、单位和 ROR 只有在来源明确提供或能够无歧义对齐时才进入结构化作者；不根据姓名或单位名称猜测，也不通过相似署名静默建立跨文献全局作者身份。

权威引用关系只表达两个具体 Literature 之间的有向边；供应商结构化关系、供应商参考文献原文或 PDF 参考文献原文继续由各自来源对象拥有。独立 `ReferenceSupport` 只定位形成该边的来源依据，不复制原文、目标元数据、evidence 或 provenance，也不允许没有来源支持的权威边。

供应商结构化引用关系按有向边保存为独立 `ProviderRelationObservation`。Observation 可以早于目标 Literature 和权威 Reference 存在，并作为后续引用扩展输入；只有进入当前用户范围的目标才继续物化。保存 observation 不得自行创建占位 Literature、Reference、ReferenceSupport、递归任务或第二套扩展状态。

## 5. 身份收敛必须保守

`MetaLiterature` 和 `Literature` 是当前接受的目标身份机制，用于处理跨来源重复和真实文献版本。`MetaLiterature` 只聚合已经确认属于同一文献的不同版本，`Literature` 表示可独立拥有元数据、资产和内容的具体文献。

供应商明确声明的同文献版本连接保存在来源 `MetadataObservation.version_links` 中，只作为身份收敛证据并复用 observation 的 Provenance。最终版本聚合只由各 `Literature.meta_literature_id` 和 `version_role` 表达；不建立通用 `LiteratureRelationObservation`、`LiteratureRelation` 或引用以外的关系图谱。目标未解析或证据不足时保留来源 observation，但不得创建占位 Literature 或改变聚合身份。

- 明确相同才自动合并；
- 明确冲突时保持分离；
- 证据不足时不得使用不可复现的猜测静默合并；
- 文献标识符使用各自官方 canonical format，不制造项目私有前缀；DOI 使用小写裸值，arXiv revision 使用不带 `vN` 的基础 ID；
- Provider record identity 只定位来源记录或版本端点，不能冒充 `LiteratureMetadata.identifiers`；
- 标题和有序作者只形成不改变来源展示值的轻量比较键，且只在双方都没有稳定文献标识符时作为完整精确后备；
- 一个稳定标识符相同而另一个身份型稳定标识符冲突时 fail closed，相似标题或作者不能覆盖冲突；
- 相同 DOI 或同一基础 arXiv ID 命中同一 Literature；不同具体版本只由明确 `version_links` 聚合，不由 `version_role`、标题或作者猜测。

精确格式转换、身份判定顺序和版本收敛算法由设计文档与技术文档规定并由测试证明。

## 6. 原始资产是证据

已接受的原始资产不可原地修改。文件字节由资产存储拥有，文献数据库保存相对引用、hash、角色、来源和关系，不保存大型关系型 BLOB。

解析错误通过重新处理原始资产修复，不通过手工修改原文件或伪造来源关系修复。

手动 PDF 接纳与自动获取使用相同的基本检查、不可变发布和唯一主资产关系，但它是用户明确选择具体 Literature 的独立操作，不是第四种自动 AcquisitionPath。SciRetriever 只复制用户文件并管理内部副本，不移动、修改或删除用户原文件；机器绝对路径不进入 Catalog。已有主 PDF 时默认拒绝，不能静默替换。

Acquisition 对单次主 PDF 获取只形成“获得”或“没有获得”两个业务结果；正常未命中和候选内容无效不形成长期原因分类。Network/API/权限/配置错误、用户中断以及无法安全发布文件、提交关系或耗尽事实都属于本次操作失败，不能降级成“没有获得”。

只有 Acquisition 正常遍历某个具体 Literature 的全部当前自动路径仍未获得 PDF，才保存最小的自动获取耗尽事实并在查询中投影为需要人工 PDF。该事实不增加 Literature 状态，也不保存原因或尝试历史；新 MetadataObservation、成功主 PDF 或用户明确重试会清除它。中断、Network/API/权限/配置错误和 Storage 错误不能形成该事实。

Acquisition 的验收只回答字节是否为可用 PDF 文件：按实际字节而不是后缀、HTTP 类型、文件名或下载事件判断，要求非空、标准 reader 可打开、页面树可读取且至少一页，并拒绝没有可用密码而无法读取的加密 PDF。轻微不规范但可正常读取的 PDF 可以接纳；固定最小字节数、页数、字符数以及正文或学术内容判断都不属于这一道门。Analysis 才根据 ParserResult 判断是否存在属于当前目标 Literature 的实际内容；无法判断、解析异常或模型失败必须保留 PDF，不能冒充内容无效。

## 7. 轻结构化文档保持通用、总结型和可追溯

`LiteratureContent` 是 LLM 根据 `ParserResult` 形成的总结型产品文档，不是完整原文副本。它以一组固定一级标题为最小结构，允许在明确边界内补充其它正文一级标题及正文二级标题；最终元数据和关键词先确定，正文总结随后以该元数据为上下文形成。规范 Markdown、最终元数据、关键词、结构化章节和文本参考文献属于同一次逻辑分析，不建立平行分析、分类或标签结果。

`LiteratureContent` 既能直接导出为 Markdown，也能通过有序 `LiteratureSection` 供程序读取。固定和额外一级章节处于同一有序序列，动态标题不通过自由 `dict` 或动态 Pydantic 字段表达。程序只把 H1/H2 解析为结构；章节与子章节正文继续保存为 Markdown 字符串，不拆成 block、paragraph、list、table 或公式对象。参考文献原文独立有序保存，使文档不依赖目标引用关系即可阅读和导出。

固定元数据字段、摘要、四个固定正文章节和参考文献缺失时统一渲染精确字符串“未提供”；结构化可选元数据与摘要使用 `None`，关键词和参考文献使用空 tuple，固定正文 section 使用 `markdown = "未提供"`。额外章节没有内容时不创建。“未提供”不能被解析为参考文献或额外内容。

具体 parser 可以替换，但必须转换到以不可变 Markdown artifact 为核心的 parser-neutral `ParserResult`。外部 parser 的 URL、归档、JSON、文本、图片和坐标均作为不可信输入验证；只有输入 Asset 身份与 hash、页数、规范化 Markdown、实际引用资源、结果 hash 和 parser provenance 进入中间合同，私有 block、bbox 和过程文件不得穿透。Parser 不直接形成 `LiteratureContent`、临时 `ReferenceLookup` 或权威 `Reference`。Analysis 先让 LLM 根据经过验证的中间结果形成结构化最终元数据，再把该元数据和同一中间结果交给 LLM 形成内容 Markdown 草稿，随后验证并解析；Literature 验收最终元数据和内容。`LiteratureContent` 只保存一项 Analysis provenance，其输入 hash 绑定 PDF、ParserResult 和最终 metadata；Parser provenance 留在 ParserResult，不复制两次模型调用的独立 lineage。

## 8. 阶段结果独立提交

元数据、资产和最终轻结构化文档分别形成可持久化事实。最终元数据、关键词、结构化章节、文本参考文献和规范 Markdown 整体接纳为一个内容事实；Parser 中间结果本身不推进文献状态。每个输入资产只保存一个当前 ParserResult，每个 Literature 只保存一个当前 `LiteratureContent`；成功重处理必须先完整生成和验收新 artifact，再原子替换当前关系，旧字节成为可回收缓存而不形成数据库历史，失败不能破坏完整旧结果。

在文献内容处理链中，全部已接纳的来源 observations、单一当前权威元数据和原始 PDF 是优先长期可靠保存的事实。旧统一元数据不作为历史事实保存；需要重新形成时使用长期 observations、当前 PDF 和既有规则。ParserResult、Parser Markdown 与引用资源、LiteratureContent、总结型 Markdown 和从当前内容形成的引用文本 support 是可从这些输入重新生成的派生产物：仍须保留一个完整当前结果并使用 hash、轻量 provenance 和原子发布防止错配与半成品，但不维护历史。该原则不扩展为对 Execution 或全部 Reference 数据的未决存储设计。

替换当前 LiteratureContent 时，依赖旧内容 hash 的 `ContentReferenceTextSupport` 必须在同一逻辑提交中移除；若 Reference 因此没有任何 support，则删除该 Reference。来源 observation 支持不受影响。局部失败不撤销其它文献或已经成功的前面阶段，后续运行重新读取当前权威事实并补充缺失内容，不恢复外部调用或内存执行现场。

批量 selector、冻结目标、候选顺序、尝试、普通失败和运行报告只用于当前操作的调度与反馈，不进入数据库，也不能成为文献身份或结果可用程度的第二真相源。

补全操作开始时在内存中冻结实际目标；运行期间数据库新增文献或查询结果变化不动态加入本次操作。每个目标从自己的第一个缺失步骤端到端推进，不要求全部文献按同一阶段齐步运行。

## 9. 外部访问必须在进程内共享受控

Provider 只分为 Metadata 与 Acquisition 两类不互斥能力；领域搜索、稳定标识符 lookup 和可选引用查询都属于 Metadata，不建立第三类 Citation Provider。领域发现调用本次全部已启用、生产 adapter 已实现且 readiness 通过的 Metadata search 能力，不按 publisher 预分流，也不因目标 Provider 范围完整就对每篇结果盲目执行逐来源补查。

Acquisition 选择内容 Source 时优先解释明确 AssetHint、来源稳定定位、Provider record identity 和 DOI 安全解析后的 landing origin；MetadataObservation 来自哪个聚合服务、publisher 自由文本或单独 DOI 前缀都不能证明全文归属。Source 只有在生产实现、用户启用、凭据/AccessPolicy readiness 和当前 Literature 适用性都满足后才调用；配置、认证、权限和系统错误不能伪装成正常 PDF 耗尽。精确目标与路由见 [ADR 0014](decisions/0014-capability-scoped-providers-and-local-credentials.md)。

所有外部 HTTP、redirect 和浏览器操作都必须经过当前 SciRetriever 进程中由 Network 提供的共享访问准入。Provider adapter 负责声明和解释供应商政策，Network 按 provider、访问通道、必要的 API service 和实际 host，在当前进程的全部模块、用户操作和文献目标之间执行并发、间隔、周期额度、冷却和 `Retry-After`。功能模块、vendor SDK 和页面流程不得各自建立互不知情的限速器或直接绕过准入。

Acquisition 对同一 Literature 按公开来源、已授权 Provider API、受控浏览器三个阶段串行短路。网页访问无论由公开线索的普通 HTTP 还是浏览器触发，都使用对应供应商的网页 scope；同一进程内一个供应商网页最多一个活动流程，结束后至少冷却 30 秒。API 使用独立通道并遵守供应商真实规则，公开来源也不获得无限请求豁免。具体易变数值由 Provider Notes 维护，长期边界见 [ADR 0012](decisions/0012-process-local-provider-access-scheduling.md)。

等待队列、permit、窗口计数、`next_allowed_at`、`blocked_until` 和当次 `Retry-After` 是当前进程的内存运行状态，不是文献事实，不保存到 Catalog、ArtifactStore、provenance 或独立协调文件，也不参与状态推导。进程结束后这些动态状态自然清空；静态访问政策和 operator 收紧值仍由配置表达。

Provider secret 只存在于当前用户的固定 `~/.sciretriever/credentials.toml` 和被 Bootstrap 注入的 adapter 当前进程内存中，不属于普通配置 Model 或文献数据库。`config status` 是纯本地检查；用户显式执行的 `config test` 仍服从统一 Network，但测试结果和时间不持久化，也不能把认证成功解释为任意文献的全文 entitlement。Harness、CI 和离线验收只使用临时凭据文件与 fake Network。

## 10. 单机不等于跨进程限速

产品运行边界是个人单机工具，不要求跨机器协调或分布式任务所有权，也不保证多个 SciRetriever 进程共享供应商限速。每个进程由 `bootstrap.py` 构造自己的共享 Access Coordinator；多个进程同时运行或进程快速重启时，冷却和额度窗口不会延续。Storage 为保护同一 Catalog 而实施的本机写入互斥是独立的数据库完整性机制，不能与 Network 访问调度混为一体。

## 11. 一个事实只有一个写入所有者

设计文档必须为每项权威业务事实指定唯一写入所有者。其它模块通过明确合同读取或请求修改，不复制第二份权威状态。

## 12. 导出实现不是产品边界

任何当前导出实现都不定义产品边界。ADR 0005 的 `DocumentPackage` 2.0 目标合同已经由 [ADR 0008](decisions/0008-summarized-markdown-literature-content.md) 撤销；当前产品不实现、读取或迁移该格式。未来若出现完整离线快照需求，必须先确认消费方和公开合同，再以新 ADR 重新版本化设计，不能恢复过时合同。

任何下游集成都必须使用文档化的稳定标识符、hash、provenance 和领域中立表示，不得直接依赖内部数据库表。

## 审查清单

- [ ] 操作是否由用户输入和当前文献数据库事实共同决定，并只处理仍然缺失或明确失效的部分？
- [ ] 持久化 DiscoveryRun 和进程内数据库补全是否保持分离，而没有重新混成一次线性流水线？
- [ ] 外部发现是否不会创建 Collection、自动启动 PDF、Parsing、Analysis 或逐篇全供应商补查？
- [ ] Provider 是否按过滤和去重前的原始 item 执行整个 Run 共享的 scan limit，且没有在元数据阶段加入语义相关性或低收益停止判断？
- [ ] Provider 是否只分 Metadata/Acquisition 两类，领域搜索按 enabled + production + readiness 选择，引用没有被提升为第三类 Provider？
- [ ] Acquisition 是否依据 AssetHint、稳定定位、Provider record identity 或 DOI landing origin 路由，而没有按 publisher、DOI 前缀或 metadata 来源硬编码内容 API？
- [ ] 数据库补全是否只在当前进程内冻结目标；普通 MetaLiterature 范围是否只追求一个可用版本，且只有稳定缺失才跨版本回退？
- [ ] Selector、目标、候选、普通失败和运行报告是否保持非持久化；报告是否只从 typed result/failure 形成并反馈本次操作，而没有从日志、旧 Report 或 ImportRun 推导状态？
- [ ] 具有运行行为的模块是否只通过 Logging 公开 API 获取 logger，Bootstrap 是否只通过该 API 完成一次性 stderr 配置；是否避免 import-time handler、全局 Observer、日志持久化以及原始外部对象、凭据、prompt、正文或绝对路径泄露？
- [ ] 新确认结果是否回到同一逻辑文献数据库，而没有建立独立结果集合或第二真相源？
- [ ] 中断与恢复是否重新读取当前事实，而没有依赖恢复旧外部调用、线程、队列或内存现场？
- [ ] 变化是否能追溯到一项产品需求或已接受 ADR？
- [ ] 是否把技术选择误写成了用户需求？
- [ ] 是否保持元数据、资产和总结型轻结构化文档的领域中立边界？
- [ ] 是否避免把领域字段写入 SciRetriever 文献数据库？
- [ ] 是否保留来源 observation、资产 hash、解析输入和 provenance？
- [ ] Author 是否只表达具体 Literature 内的有序署名，且 ORCID、单位和 ROR 没有通过猜测或模糊匹配补全？
- [ ] 权威引用关系是否只连接两个具体 Literature，并通过 `ReferenceSupport` 保留实际形成依据？
- [ ] `ProviderRelationObservation` 是否逐边保存且可以独立存在，而没有绕过用户扩展范围自动物化目标或递归？
- [ ] 是否以保守、确定、可审计的方式处理跨来源身份？
- [ ] 同文献版本是否只由来源 `version_links` 提供证据并由单一 MetaLiterature 成员归属表达结果，而没有建立通用关系或第二份版本事实？
- [ ] 是否避免原地修改已接受资产或覆盖冲突证据？
- [ ] Acquisition 是否只形成获得/没有获得两个业务结果，且没有把候选失败持久化或把系统提交错误伪装为没有获得？
- [ ] 自动 PDF 获取耗尽是否只在全部当前路径正常结束后建立，并在新 observation、成功 PDF 或明确重试时清除；临时错误是否不会错误标记为需要人工 PDF？
- [ ] 手动 PDF 是否明确绑定具体 Literature、复制而不移动用户文件、复用相同基本检查，并保持在自动三阶段之外？
- [ ] Acquisition 是否只验证实际 PDF 字节、reader 与页面树，而把实际文献内容判断留给 Analysis；不确定或处理失败是否保留 PDF？
- [ ] 固定内容缺失时是否统一使用“未提供”，且没有把缺失标记解析成参考文献或额外章节？
- [ ] 每个 Literature 是否只有一个原子替换的当前 LiteratureContent，且旧内容 support 与无支持 Reference 得到一致清理？
- [ ] 文献内容处理链是否优先保护来源元数据和原始 PDF，同时把 ParserResult 与 LiteratureContent 作为可重建当前结果而非历史资产？
- [ ] 所有外部访问是否经过当前进程的 provider/channel/host 共享准入，网页独占与冷却是否覆盖普通 HTTP 和浏览器，API 是否遵守对应供应商规则？
- [ ] Provider secret 是否只来自固定 owner-only 凭据文件并保持在适配边界；status/test 是否不泄漏或持久化 secret/测试结果，离线门禁是否没有真实联网？
- [ ] 限速是否在当前进程的模块、用户操作和文献目标之间共享，且全部动态状态只留在内存，没有污染业务 Model、Catalog、ArtifactStore、provenance 或 Literature 状态？
- [ ] 外部 provider 和 parser 输出是否在边界验证并转换为中性合同？
- [ ] 局部失败是否保留其它已提交结果并允许后续补全？
- [ ] 是否为每项持久化事实指定唯一写入所有者？
- [ ] 是否把单机边界错误扩大成未经讨论的进程或调度方案？
- [ ] 是否避免恢复已撤销的 `DocumentPackage` 2.0；未来快照需求是否重新确认公开合同和版本影响？
