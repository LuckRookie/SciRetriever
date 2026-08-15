# SciRetriever 设计

- Owner 确认：2026-08-10
- 需求依据：[产品需求](requirements.md)
- 技术实现：[技术文档](technical.md)
- 重要决策：[架构决策](decisions/README.md)

本文说明 SciRetriever 为满足产品需求所采用的整体架构、模块责任、核心数据流和事实所有权。本文只描述已经确认的目标设计，不描述当前代码完成度，也不规定类、函数、数据库表、供应商协议或部署参数；这些内容由[技术文档](technical.md)、当前源码和测试说明。

## 1. 设计边界

SciRetriever 围绕统一文献数据库设计。用户通过领域条件或种子文献发起有边界的外部发现，系统从多个来源获得元数据并写入数据库；用户随后可以按数据库当前事实独立补齐 PDF 与总结型内容。发现和补全不强制绑定成一次线性运行，最终共同维护可以持续查询、补充和交换书目信息的文献数据库。

设计必须覆盖[产品需求](requirements.md)中的八项能力：

1. 按主题领域收集文献；
2. 按引用关系迭代收集文献；
3. 从多个来源汇总和整理文献元数据；
4. 获取文献全文及相关资产；
5. 解析文献资产并获得语言模型可用的中间内容；
6. 使用语言模型判断内容，先确定最终元数据，再以该元数据为上下文形成总结型轻结构化文档；
7. 持续建立、查询和补充文献数据库；
8. 通过主流文献格式导入和导出书目信息。

系统保持领域中立，只管理通用文献元数据、资产、总结型轻结构化文档、引用关系和必要的 provenance。轻结构化文档的规范 Markdown 与结构化章节是同一内容的两种表示，不再建立平行分析或标签结果。反应、分子、路线、产率、材料性质等领域数据不进入 SciRetriever 文献数据库。

## 2. 整体架构

整体架构遵循[以文献数据库为中心的增量维护](decisions/0011-literature-database-centered-incremental-maintenance.md)和[外部发现与数据库补全解耦](decisions/0013-decoupled-discovery-and-database-maintenance.md)：每项产品操作都由用户输入和当前逻辑文献数据库共同启动。查询和只读导出直接读取一致的当前事实；外部发现和数据库补全分别形成自己的明确操作，新的有效结果再提交回同一数据库。

```text
用户输入 + 当前逻辑文献数据库
  -> Entry 形成实际目标范围
  -> Literature 与各读取 Port 提供当前权威事实
  -> 推导缺失或明确失效的步骤
  -> Metadata / Acquisition / Parsing / Analysis 执行必要能力
  -> 对应业务所有者验证结果
  -> Storage 原子保存确认事实
  -> 得到新的文献数据库状态
```

新的 DiscoveryRun 和书目导入也先结合已有数据库完成身份命中、去重和接纳；查询、导出和重复处理读取同一套事实。数据库补全只在当前进程内展开 selector、冻结目标和形成报告，不建立持久化 BatchRun。Provider、网络、Parser、LLM、运行报告和临时文件只服务于形成确认事实或反馈本次操作，不构成与文献数据库并列的状态或结果来源。数据库在这里是产品级统一逻辑边界，不等同于具体存储引擎，也不改变各业务模块对事实含义的所有权。

### 2.1 端到端框架

```text
用户操作 + 当前逻辑文献数据库
  │
  ├─ 领域条件或种子文献
  │    -> DiscoveryRun
  │    -> Metadata 多来源搜索或有界引用扩展
  │    -> Literature 身份接纳、统一元数据与引用关系
  │    -> 保存发现结果和原因
  │
  ├─ 缺失 PDF 或最终内容补全
  │    -> 运行时 BatchSelector 从当前数据库展开范围
  │    -> 在当前进程内冻结实际 MetaLiterature/Literature 目标
  │    -> 按当前事实选择具体版本和第一个缺失步骤
  │    -> 缺 PDF 目标形成有界 cohort
  │         -> Public pass -> 未解决目标 API pass -> 最小 Browser admission
  │    -> 已有或新提交 PDF 的目标继续 Parsing -> Analysis -> Literature 接纳
  │    -> 各阶段确认事实写回数据库
  │    -> 返回本次运行报告，不保存批次历史
  │
  ├─ 手动 PDF
  │    -> 明确具体 Literature
  │    -> Acquisition 复制、基本检查并发布内部主资产
  │
  └─ 查询、书目导入导出
       -> 读取或更新同一数据库
```

单个具体 Literature 的内容补全继续使用以下处理链：

```text
Acquisition（PDF 获取或已有当前主 PDF）
  -> 当前 PDF、来源和关系入库
  -> Parsing（选定 Parser，当前为 MinerU）
  -> parser-neutral Markdown 中间解析结果
  -> LLM 分析与总结：第一阶段
       判断实际内容并确定结构化最终元数据
       ├─ 没有当前文献实际内容
       │    -> 删除内部 PDF 和对应中间结果
       │    -> 当前 Literature 继续其它候选；候选耗尽后才允许尝试其它版本
       └─ 具有实际内容
            -> LLM 分析与总结：第二阶段
            -> 使用最终元数据总结正文与参考文献
            -> Literature 验收最终元数据、关键词和 LiteratureContent
            -> Storage 保存单一当前内容、规范 Markdown、参考文献与 Analysis provenance
```

`Model` 为图中除 Logging 外的模块提供统一数据合同；`网络基础设施`为元数据供应商、Acquisition、Parsing 和 LLM 提供共同的外部访问能力；`存储`保存其它模块已经确认的事实，不自行作出业务判断；`Logging` 统一提供命名 logger、进程启动配置和最终脱敏防线。DiscoveryRun 由 Entry 编排并通过 Storage 持久化，因为它保存无法从当前文献反推的发现 provenance；批量 selector、目标、候选和报告只属于当前操作内存。

Logging 是具有独立代码目录和公开 API 的公用基础模块，但仍只承担横向运行支撑：生产启动时统一配置，具有运行行为的模块通过它输出安全实时诊断，Entry 独立形成 typed Report。日志不会被反向解析为 Report，不进入逻辑文献数据库，也不影响状态、回退、重试或恢复。

查询、书目信息导入导出和重复处理使用同一入口、文献管理和存储，不建立第二条文献流程。

### 2.2 模块划分

系统只使用六个核心功能模块和四个公用基础模块描述产品架构。

| 类别 | 模块 | 主要责任 |
|---|---|---|
| 核心功能 | 入口与流程编排 | 接收用户操作，分别组织 DiscoveryRun、运行时 selector 与内存目标冻结、缺 PDF 目标的有界风险 cohort、逐目标后续补全、运行报告、手动 PDF、查询和书目交换 |
| 核心功能 | 元数据供应商 | 执行元数据搜索和引用查询，把供应商结果转换为统一内部数据 |
| 核心功能 | 文献管理 | 管理文献身份、版本、来源元数据、统一元数据、引用和当前状态 |
| 核心功能 | Acquisition | 根据访问方 Profile/Resolution 形成 Public/API/Browser Plan 并执行当前层 route，或接纳用户明确绑定的本地 PDF；所有路径执行相同基本文件检查 |
| 核心功能 | Parsing | 通过当前解析器把 PDF 转换为中性的 Parser 中间结果 |
| 核心功能 | LLM 分析与总结 | 先判断内容并确定结构化最终元数据，再以该元数据为上下文生成和解析正文 Markdown、结构化章节与参考文献，并按需形成临时引用检索线索 |
| 公用基础 | Model | 定义除 Logging 外各模块交换的领域中立数据合同 |
| 公用基础 | 网络基础设施 | 统一提供安全 HTTP、受控浏览器、资源预算和脱敏 |
| 公用基础 | 存储 | 保存 DiscoveryRun、文献当前关系事实、自动 PDF 获取耗尽事实和不可变文件，提供一致查询与事务边界；不保存批量运行现场或报告 |
| 公用基础 | Logging | 统一 logger 获取、生产进程配置、stderr 输出、formatter 和最终脱敏防线；不形成 Report 或业务事件系统 |

书目格式编解码、运行配置、对象组装和本机写入互斥是上述模块内部或启动阶段需要的技术能力，不增加新的产品模块。具体代码位置由技术文档规定。

### 2.3 按功能模块组织

代码按六个核心功能模块和四个公用基础模块组织，不再建立 `core`、`services`、`infrastructure`、`interface`、`composition` 等顶层分层目录。目录名称与本设计中的模块名称保持一一对应，使一个功能的规则、用例、Ports 和供应商适配能够在同一模块内阅读和维护。

```text
sciretriever/
  entry/              # 入口与流程编排
  metadata/           # 元数据供应商
  literature/         # 文献管理
  acquisition/        # Acquisition：PDF 获取
  parsing/            # Parsing：PDF 解析
  analysis/           # LLM 分析与总结

  model/              # 统一数据合同
  network/            # 网络基础设施
  storage/            # 数据库、文件和本机写入互斥
  logging/            # logger 获取、进程配置与最终脱敏防线

  bootstrap.py        # 实现选择和对象组装
  configuration.py    # 运行配置读取与边界解析
```

每个核心功能模块可以在内部按需要区分以下职责，但这些职责不再成为项目级目录层次：

- `api.py`：模块对外提供的稳定操作；
- `service.py` 或按用例命名的文件：组织本模块用例；
- `rules.py` 或更具体的规则文件：保存纯业务判断；
- `ports.py`：声明本模块需要的外部能力；
- `providers/`、`sources/` 或其它明确命名的适配目录：实现本模块专属的外部协议。

只有实际需要时才创建这些文件或子目录，不要求每个模块机械复制同一模板。

模块依赖遵守：

1. 除 `logging` 外的模块可以使用 `model` 中的中性数据合同；
2. `entry` 只通过其它核心模块的公开 API 编排流程，不导入其私有实现；
3. 核心功能模块之间只通过公开 API 和 Model 数据协作，不跨模块调用私有规则或适配器；
4. 需要网络或持久化的模块在自己的 `ports.py` 声明能力，由 `network`、`storage` 或本模块专属适配器实现；
5. `network` 和 `storage` 不拥有文献身份、元数据收敛、内容判断和状态等业务规则；
6. 除纯声明的 `model` 外，具有运行行为的模块只通过 `logging.api` 获取 logger，不直接配置 Python root logger、Handler 或 formatter；`logging` 只依赖 Python 标准库，不反向调用业务模块；
7. 根级 `configuration.py` 负责读取并解析运行配置，`bootstrap.py` 是唯一选择具体实现并构造完整对象图的位置，并通过 `logging.api` 触发生产日志初始化；二者都不承载产品规则；
8. Vendor、HTTP、浏览器、SQL、MinerU 和 LLM 私有类型只能存在于对应模块的适配边界，不能进入公共 API 或 Model。

### 2.4 Provider 能力与启动配置

外部文献能力仍按两类不互斥产品能力接入：Metadata Provider 负责领域搜索、稳定标识符 lookup 及可选引用关系/资产线索；Acquisition route 负责为具体 Literature 发现或取得主 PDF。引用查询属于 Metadata 的可选能力，不形成第三类 Provider；同一机构可以分别实现 metadata 和 acquisition adapter，也可以只实现其中之一。`direct` 是对已有 locator 的通用公开 route，用户手动 PDF 是独立接纳操作，二者都不是 Provider。

原文访问还必须区分三种不能互相替代的身份：Metadata Provider 表示“谁提供了元数据”，Publication/Access Provider 表示“谁控制原文访问”，Access Platform/CDN 表示“实际页面或文件运行在哪里”。Scopus 找到 Wiley 文献不表示 Elsevier 拥有其原文；纯页面访问方可以拥有 Acquisition 的 `PublisherAccessProfile`，而无需加入 Metadata Provider 枚举或创建无用的 API 凭据 section。

目标生产范围覆盖 [ADR 0014](decisions/0014-capability-scoped-providers-and-local-credentials.md) 已确认的 Provider 能力，并由 [ADR 0015](decisions/0015-publisher-aware-tiered-pdf-acquisition.md) 约束原文访问计划。“能力已实现”“用户启用”“普通参数/凭据/政策就绪”“当前 Literature 适用”和“当前 route 实际需要”必须分别判断。领域发现调用全部已启用且就绪的 Metadata search adapter；Acquisition 先形成访问方 Resolution 和分层 Plan，只执行其中适用且需要的 route。全面接入不会把每次运行变成对全部服务的无条件调用。

普通配置由根级 `configuration.py` 解析；Provider、LLM 与远程 MinerU 密钥只来自 `~/.sciretriever/credentials.toml`，用户可以直接编辑，也可以通过同一 CLI 配置边界安全修改。核心服务 secret 与规范 origin 精确绑定；loopback 服务不读取不需要的 secret。密钥存在、认证成功与具体全文 entitlement 是不同事实。Secret、凭据状态和连通性测试不属于文献数据库；精确文件、命令和测试边界见 [配置与凭据技术文档](technical/configuration.md)。

Publisher access Profile 使用 `production-ready`、`fixture-verified` 和 `unsupported` 三种准入状态，Public、授权 API 与 Browser capability 另行表达。一个只完成授权 API 的 Profile 可以是 production-ready，同时没有 Browser route；fixture-verified 只证明离线合同，不能进入生产 catalog；unsupported 不保留可执行 route。易变 endpoint、页面 selector、限速数字和证据日期由 [Provider Notes](../notes/providers/README.md)维护，不能写进长期设计或由相似平台猜测继承。

## 3. 核心数据流

### 3.1 DiscoveryRun 与两种发现输入

用户通过两种方式发起外部发现：

1. 提交领域条件，通过多个元数据供应商搜索相关文献；
2. 提交一篇或一组种子文献，沿参考文献、被引用文献或双向引用关系继续发现文献。

每次外部发现形成一个独立 `DiscoveryRun`。它只冻结类型化输入和停止边界，作为逐来源结果、发现对象和原因的稳定锚点，并表达本次发现是否完整执行。Run 本体只有 ID、输入、状态和开始时间；创建即运行，零结果可以正常完成，不保存完成时间、cursor、页码、重试现场或结果数组。本地数据库查询只读取当前事实，不创建 DiscoveryRun。

DiscoveryRun 的结束点是发现结果已经经 Metadata 中性转换和 Literature 接纳进入数据库。运行完成后不自动获取 PDF，不启动 Parsing、Analysis 或另一轮引用扩展；`ReferenceLookup` 只在用户明确发起的引用 DiscoveryRun 内按需使用。当前产品不创建领域占位 Collection，也不预留 Zotero 式人工文件夹的 membership。

主题输入只包含查询文本、可选年份范围和逐 Provider 原始扫描上限。引用输入包含具体 Literature 种子、方向、深度、按 MetaLiterature 去重的结果上限和逐 Provider 原始扫描上限；Provider 上限作用于整个 Run，结果上限统计新入库和既有的发现对象但不统计种子。引用扩展逐层执行，达到这些边界或没有新文献时停止。相同 MetaLiterature 在同次运行中只形成一个发现结果。

引用扩展有两种目标发现方式：元数据供应商可以返回结构化引用关系；已经保存的参考文献原文也可以由 LLM 临时提取检索线索，再查询本地 Literature 或元数据供应商。供应商每返回一条结构化有向边，先独立保存一个 `ProviderRelationObservation`；它可以在目标尚未入库时作为待扩展单位存在。Entry 只选择当前用户方向、深度和数量边界内的目标继续解析，两种方式得到的选中目标都先按普通元数据规则形成或命中具体 `Literature`，之后才建立本地 Literature 之间的引用关系及其来源支持。

```text
元数据供应商返回 A→B、A→C、A→D
  -> 分别保存三个 ProviderRelationObservation
  -> Entry 按当前扩展范围选择目标
  -> 本地精确查询；必要时获取 MetadataObservation
  -> 目标 Literature 入库
  -> Reference + ProviderRelationSupport

参考文献原文
  -> LLM ReferenceLookup
  -> 本地精确查询或 Metadata
  -> 目标 Literature 入库
  -> Reference + 对应文本 ReferenceSupport
```

`ReferenceLookup` 只服务当前搜索，不进入数据库；本地已经精确命中目标时不强制访问外部供应商。保存 `ProviderRelationObservation` 不等于创建目标 Literature，也不自动触发下一层递归；未选中的 observation 留待后续 DiscoveryRun。`Reference` 只连接已经入库的两个具体 `Literature`，`ReferenceSupport` 定位供应商结构化关系、供应商参考文献原文或 PDF 参考文献原文中的实际形成依据。

每个发现对象只保存 `(discovery_run_id, meta_literature_id)`。同一对象可以有多个原因：主题原因指向实际 `MetadataObservation`；引用原因保存本次发现时的 citing source Literature、cited target Literature 和 depth。引用原因是运行历史，不依赖以后可能删除的当前 Reference。直接原因和 depth 已经能够表达发现链，不另存重复且可能组合膨胀的完整路径。

### 3.2 元数据搜索与入库

```text
领域 DiscoveryRun 输入
  -> 调用本次选择、已启用且 readiness 通过的全部元数据搜索能力
  -> 每个供应商分别运行到结果耗尽或达到整个 Run 的原始 scan limit
  -> 各供应商结果转换为中性元数据 observation
  -> 文献管理执行身份判断和版本区分
  -> 形成或补充当前统一元数据
  -> 保存来源 observation、统一文献、DiscoveryRun 结果与发现原因
```

每个供应商独立返回结果并具有自己的 `scan_limit`。过滤和去重前的每条原始 item 都消耗上限，因此无标题/DOI、重复或最终未接纳的 item 不能让 Provider 无限分页。自然耗尽和达到上限都是正常完成；单个供应商失败只影响该来源，其它来源的成功结果继续进入文献管理。已接纳结果可以逐条提交，不等待全部 Provider 结束。具有标题或 DOI 的不完整记录可以先入库，后续运行继续补充；标题和 DOI 都缺失的记录不能形成数据库中的文献，但仍消耗扫描额度。

Web of Science、Crossref、Semantic Scholar、arXiv、OpenAlex、Europe PMC、Elsevier/Scopus、Springer Nature、DataCite 和 CORE 的目标生产 adapter 各自直接在其官方覆盖范围内执行领域查询；OpenCitations Meta 当前只参与稳定标识符 lookup 和引用能力，不伪装成领域搜索。Entry 不先判断出版社：Springer Nature 只返回自身覆盖内容、Scopus 可以返回多家出版社文献，都是 Provider 自己的正常检索语义。明确启用但缺少生产 adapter、必需凭据或 AccessPolicy 时在运行开始前形成配置错误，不能静默跳过或记录为零结果。

逐来源结果只说明 Provider 是自然耗尽、达到扫描上限还是失败；失败时附稳定脱敏信息，不持久化扫描、接纳或拒绝计数。所有 Provider 正常到达边界时 Run 为 `COMPLETED`，正常与失败并存时为 `PARTIAL`，全部失败时为 `FAILED`。用户在正常边界前停止或恢复时发现遗留运行才是 `INTERRUPTED`；已接纳结果不回滚，下一次运行重新从数据库去重。

领域 DiscoveryRun 完成初始多来源搜索后结束。系统不为每一篇已发现 Literature 自动再执行一次全部 Provider 的精确补查，也不自动进入 PDF 获取；用户需要更多来源信息时发起新的明确发现或补充操作。元数据阶段不使用 LLM、embedding、搜索分数、标题关键词、摘要分类或连续低收益规则判断领域相关性或提前停止；Provider 返回只表示本次查询命中。有实际内容但偏题的 Literature 仍然有效，不属于 `NoUsableContent`。搜索候选、相关度、Provider cursor、请求/响应、运行时扫描计数和未接纳结果只存在于当前调用中，不能因为保存 DiscoveryRun 而成为数据库事实。

供应商记录不是文献主身份，也不能直接覆盖统一元数据。一个 Literature 可以关联多个独立、不可变且长期保留的 `MetadataObservation`；后续来源观察增加新 observation，不覆盖旧对象。文献管理根据全部已关联 observations 按确定规则形成一份当前统一 `LiteratureMetadata`。

内容分析前，当前统一元数据是 observations 的确定性投影；Analysis 第一阶段再以它和 PDF 为输入提出最终元数据。提案不是新的 observation，只有与完整 LiteratureContent 一起通过 Literature 验收后，才原子替换当前统一元数据。`CONTENT_READY` 后新增 observation 继续保存，但不能单独覆盖与当前内容对齐的最终元数据，只能进入以后完整重分析的输入。来源 observations 始终保留，Catalog 不保存旧的统一元数据快照；`metadata_revision` 只作为当前值的单调版本令牌，用于 stale 复检及当前内容对齐。

Metadata 可以并行组织多个供应商，但每个真实请求都先经过当前进程的供应商级共享准入。同一 API 产品或额度池被 metadata search、reference query 或其它调用方共同使用时共享一个访问 scope；供应商 adapter 声明并解释政策，Network 在当前进程的模块、用户操作和文献目标之间执行并发、间隔、额度和 `Retry-After`。

### 3.3 PDF 获取与状态记录

文献管理向 Acquisition 提供具体 `Literature`、当前 `LiteratureMetadata`、稳定标识符、来源明确的 Provider record identity 和 `AssetHint`。Acquisition 先使用无 secret 的 `PublisherAccessProfile` catalog 形成当前运行的 `PublisherAccessResolution` 与 `AcquisitionPlan`，再执行 route；识别访问方本身不会打开 Browser。

Resolution 优先使用安全解析后的实际 DOI landing origin、访问方自有 AssetHint origin、来源明确的稳定文章 ID 和 Provider record identity。Publisher 自由文本、Metadata Provider 名称或单独 DOI prefix 只能形成待确认提示，不能独自启用出版社 API 或 Browser；多个强证据冲突时保持 unresolved 或失败。DOI safe resolve 只在确有规划需要且现有强证据不足时作为 Public 层受控动作执行，同一 work item 不重复解析。

默认自动风险顺序固定为：

```text
PUBLIC cohort
  -> 未解决目标重新规划
AUTHORIZED_PROVIDER_API cohort
  -> 未解决目标重新规划并执行 Browser admission
CONTROLLED_BROWSER，只有允许升级的最小剩余集合
```

Planner 可以删除确定不适用的 route，但不能把 Browser 自动提前到仍可能成功的公开或官方 API route 之前。一个有界 cohort 的全部缺 PDF 目标先完成 Public pass，再让未解决目标完成 API pass，最后才按访问风险组调度 Browser；大型范围可以拆成多个 cohort。某个 Literature 较早提交主 PDF 后可以继续 Parsing/Analysis，层级屏障只约束仍未解决目标的风险升级。

Public 层先消费明确的直接主 PDF 线索、公开仓储、OA locator 和受控普通 HTTP discovery。官方 API route 根据真实 capability 区分 search、locator/resolution、entitlement、structured full text、direct PDF 与 multi-step PDF object retrieval；XML/JATS、canonical landing、稳定 object ID 或 entitlement 不是 PDF。DOI/API/页面获得的中性 canonical landing、稳定文章 ID 或安全 locator 可以作为当前运行的 `AccessRouteHint` 交给重规划，但 Cookie、token、签名 URL、vendor/page object 不进入 hint 或数据库。

公开协议和 API 按各自官方 quota identity、并发、间隔、window、周期/日额度、reset boundary 与 `Retry-After` 执行；共享额度池的 Metadata 与 Acquisition 调用共享当前进程 scope。Timeout、临时服务错误、`429`、有效 `Retry-After` 或 quota exhausted 形成延期或失败，不能通过自动切 Browser 制造替代流量。未配置但当前 plan 需要的 route 必须明确报告；是否仍允许 Browser 只由显式 admission policy 决定。

Browser 按 `browser_rate_limit_group` 调度：不同独立风险组可以并行，同一组固定 `concurrency = 1` 并按该 Profile 的文章间隔、window 和 cooldown 限速串行。它复用 operator-managed persistent session，但 permit 覆盖一篇文章从 canonical landing、授权标记、有限页面动作、popup/viewer、response/download 到临时资源清理的完整流程。登录、MFA、challenge、无 entitlement、rate limit、IP block 或账号警告只暂停/熔断对应组；自动流程不登录、不处理 MFA/CAPTCHA、不执行任意 JavaScript 或反检测动作。每次 navigation、popup、viewer、response 和 download 在访问前同时通过 Profile guard 与 Network 通用安全准入。

所有 HTTP、API 与 Browser 路径只把实际字节交付为统一 `TemporaryPdf`。候选通过实际字节、PDF reader、页面树和目标归属基本检查后才成为当前主 PDF；Storage 保存不可变 PDF、hash、来源和与 `Literature` 的唯一 `primary-pdf` 关系。文献状态由这些已经提交的事实推导为“已有文献资产”，而不是由下载任务或 Browser 状态单独维护。内容有效性留给后续 Analysis；下载阶段不提前建立严格正文验收，补充材料也不能成为主 PDF。

只有三层全部适用 routes 正常结束、不存在 deferred、action-required、未解决 route failure 或配置/Port/清理/发布/stale 错误，且该具体 Literature 的最小自动获取耗尽事实已经安全保存后，Acquisition 才返回 `NoPrimaryPdf`；查询据此投影 `needs_manual_pdf = true`。该事实不保存 route、候选、失败、计划或会话，也不改变 Literature 的三级状态；全库自动补全默认跳过它。新的 MetadataObservation、成功接纳主 PDF 或用户明确重试会清除该事实。

用户也可以通过独立入口为一个明确的具体 `Literature` 提供本地 PDF。Entry 把该文件交给 Acquisition；Acquisition 复制字节到自己的临时边界，执行与自动获取相同的非空 PDF、reader 和页面树检查，再通过 Storage 正常发布 `Asset` 和唯一 `primary-pdf` 关系，并清除已有自动获取耗尽事实。手动接纳使用 user provenance，不保存用户文件的绝对路径，不加入三阶段 `AcquisitionPath`，也不产生 `NoPrimaryPdf`。无效文件是输入错误；已有主 PDF 时默认拒绝，不能静默替换。

手动接纳成功只形成 `ASSET_READY`，不在同一操作中自动执行 Parsing 或 Analysis。用户原文件始终留在原处且不由 SciRetriever 修改或删除；后续 Analysis 明确无内容时，清理范围只包括 SciRetriever 管理的内部副本与派生结果。

### 3.4 Parser、LLM 与最终入库

```text
当前主 PDF
  -> 选定 Parser 解析
  -> 转换并检查统一 Markdown ParserResult 与实际引用资源
  -> 原子保存为该输入 Asset 的唯一当前 ParserResult
  -> Analysis 第一阶段使用 LLM 判断实际内容并确定最终 LiteratureMetadata
       ├─ 明确没有：删除 PDF 和对应中间结果，继续下一个候选
       └─ 具有内容：验证结构化最终元数据
  -> Analysis 第二阶段同时使用 ParserResult 和已确定元数据总结正文与参考文献
  -> 解析 LiteratureSection[] 和参考文献
  -> Literature 验收结果与当前 Literature、PDF 和元数据输入的对应关系
  -> 整体保存最终元数据、当前 LiteratureContent、规范 Markdown 和 Analysis provenance
  -> Literature 达到内容完成状态
```

Parser 负责中间解析，Analysis 负责按先元数据、后正文的顺序执行 LLM、验证内容草稿并完成结构化解析，Literature 负责最终元数据与内容接纳，三者不能互相替代。`ParserResult` 不是产品文档或状态事实；第一阶段元数据提案也不能单独发布。最终 `LiteratureContent` 同时承载程序可读的有序章节和可确定性渲染的 Markdown。若第一阶段 LLM 明确判断 PDF 没有实际内容，PDF 和对应中间结果一起删除，不执行第二阶段，也不发布 `LiteratureContent`；任一阶段的其它失败都不能触发删除。

每个输入 Asset 只保存一个当前 `ParserResult`，每个 Literature 只保存一个当前 `LiteratureContent`。重新处理先在临时区形成并验证新的不可变 artifact；全部成功且通过相应模块接纳后原子切换当前关系，失败时保留完整旧结果。旧 artifact 不进入数据库历史，只作为可回收缓存存在。任何派生结果的替换都不能覆盖或破坏当前主 PDF 和来源 observation；当前 LiteratureContent 只能由新 Analysis 完整结果经 Literature 接纳后替换。

### 3.5 局部失败与继续处理

每篇文献的事实与失败相互隔离；PDF 风险升级可以按有界 cohort 协同调度，但不会把多篇文献合并为一个业务结果。某个 route、PDF、解析或 LLM 调用失败时，同次操作的其它文献和其它独立 Browser risk group 继续处理，已经提交的有效结果保持可用。后续运行重新读取数据库中的当前权威事实，从第一个缺失或明确失效的步骤继续；运行报告只说明本轮发生了什么，不持久化、不决定 Literature 当前状态，也不要求恢复旧 plan、queue、session health、线程、HTTP 请求、浏览器页面、Parser 或 LLM 调用现场。

语言模型明确判断 PDF 没有属于当前目标 Literature 的实际内容时，删除该 PDF 和对应解析结果并继续其它候选。这个候选、来源、无效决定和候选级失败不形成长期记录；同次运行只在内存中保留已尝试集合，避免立即重新选择，后续新运行仍可重新发现。ParserResult 乱码、截断、只剩资源引用或不足以判断，以及 Parser 或 LLM 调用失败，都不等同于内容无效，不能据此删除 PDF。

普通 MetaLiterature 目标只有在当前具体版本正常耗尽自动 PDF 路径并形成耗尽事实，或明确无内容且该版本其余候选已经耗尽时，才继续尝试内存候选列表中的下一版本。Network/Storage 系统错误、Parser 或 LLM 失败、取消和无法判断都停止该目标并只进入本次报告，不能通过切换版本掩盖当前问题。

## 4. 六个核心功能模块

### 4.1 入口与流程编排

入口与流程编排是用户操作进入系统的唯一边界，并把一次操作组织成对其它模块的顺序调用。

它负责：

- 接收领域条件和种子文献两种发现输入，建立独立且有边界的 DiscoveryRun；
- 对元数据供应商结构化关系直接发现的相关文献，或 LLM 从原文形成的临时 `ReferenceLookup`，顺序编排本地精确查询、必要的目标元数据搜索、Literature 接纳以及 Reference 与 support 建立；
- 接收手动 PDF、查询、引用正反向浏览、Artifact 读取/导出、书目信息导入导出和明确的数据库补全请求；
- 根据全库、DiscoveryRun、导入、查询或明确 ID 的运行时 selector，从当前数据库展开范围并在内存中冻结实际目标；
- 普通范围按 MetaLiterature 去重，在内存中冻结有序 Literature 候选并从选中版本第一个缺失步骤开始推进；
- 把当前缺 PDF 的具体 Literature 组成有界 cohort，组织完整 Public pass、未解决目标的 API pass 和最小剩余集合的 Browser admission；
- 允许已经提交主 PDF 的目标继续后续处理，同时阻止其它未解决目标提前跨越 PDF 风险层级；
- 只在稳定缺失时尝试下一版本，系统、Parser、LLM 或无法判断的失败不触发跨版本回退；
- 在 LLM 明确判断内容不可用时，协调删除当前 PDF 和解析结果并继续其它候选；
- 协调建立或清除自动 PDF 获取耗尽事实，使全库操作不会无限重试已经正常耗尽的 Literature；
- 隔离单篇失败，并为每次操作在内存中汇总成功、缺失、失败、未处理和中断情况，返回操作特有 Report，同时可以输出不替代 Report 的安全实时日志；
- 在重复执行时读取当前数据库事实，只补充缺失内容。

它不负责：

- 判断两条记录是否属于同一文献；
- 选择统一元数据字段；
- 判断 PDF、解析结果或 LLM 输出是否有效；
- 直接实现供应商、网络、数据库、MinerU 或 LLM 协议；
- 把 DiscoveryRun、运行报告或内存补全状态当作文献当前状态；
- 维护独立于文献事实的第二套文献状态。

目标 CLI 使用 `sciretriever` 作为命令根，并按用户动作设置六个一级名称：

```text
discover  -> topic | citations
complete  -> 类型化范围 + pdf/content 目标
literature -> search | show | references | cited-by
import    -> metadata | pdf
export    -> metadata | pdf | content
config    -> 裸命令交互管理 | status | test
```

`literature` 只读取本地数据库；手动 PDF 属于 `import pdf`，不是 Literature 查询动作；PDF 与轻结构化文档分别通过 `export pdf` 和 `export content` 导出。裸 `config` 交互中心统一管理 LLM/MinerU 普通配置以及同一用户级文件中的 Provider、LLM、MinerU 凭据；`config status/test` 呈现安全本地状态或执行显式最小只读 Provider/LLM/MinerU 诊断，不访问文献数据库。CLI 不建立 `config set/remove`、`exchange`、`bibliography`、`artifact` 或内部 Metadata/Acquisition/Parsing/Analysis 模块一级命令。具体参数只能把外部输入映射到已经确定的中性合同，不能改变模块业务含义。

入口未来可以增加 GUI 或其它形式，但不会改变这些用户操作的业务边界。当前公开入口和已经实现的命令仍只由 README 与用户指南说明；目标命令在安装入口与离线测试完成前不能写成已发布行为。

### 4.2 元数据供应商

元数据供应商模块统一承接外部文献来源能力，包括主题元数据搜索、稳定标识符 lookup 和引用关系查询。引用是 Metadata Provider 的可选能力，不建立平行 Citation Provider 类型。目标生产范围包括 Web of Science、Crossref、Semantic Scholar、arXiv、OpenAlex、Europe PMC、Elsevier/Scopus、Springer Nature、DataCite、CORE 以及只按当前官方能力提供精确 lookup/引用的 OpenCitations；每项能力只有在真实 adapter、配置、凭据和 AccessPolicy 就绪后才能调用。

它负责：

- 为一次领域 DiscoveryRun 调用本次选择的全部已配置供应商，并分别执行到结果耗尽或达到各自在整个 Run 内的原始扫描上限；
- 执行供应商特有的查询、分页和响应解释，声明 API 产品/额度 scope，并把限速、`429`、`Retry-After` 与 quota 响应转换为 Network 可执行的访问政策；
- 把 vendor 数据转换成领域中立的元数据 observation、明确的同文献 `version_links`、原始参考文献文本或逐边 `ProviderRelationObservation`；
- 按数据含义区分已经明确目标的结构化引用关系和仍需解析目标的参考文献原文，不按专门接口或默认返回方式分类；
- 把供应商返回的直接文件 URL、落地页 URL、媒体类型、资产角色、版本角色、访问状态和许可证转换为中性资产线索；
- 保留供应商身份、供应商记录标识和观察时间；
- 把已知的单个供应商失败转换为稳定结果，不撤销其它来源成功内容。

Metadata 不为每条已发现 Literature 自动发起全供应商逐篇补查；是否开始新的发现属于 Entry 的用户操作边界。

它不负责：

- 创建 `MetaLiterature` 或 `Literature`；
- 合并不同供应商记录；
- 选择统一元数据；
- 下载 PDF 或判断文献处理状态；
- 根据 publisher 名称选择出版社内容 API；
- 把 vendor model、HTTP response 或浏览器对象暴露给其它业务模块。

供应商可以增加或替换，只要产生相同含义的中性结果并遵守共同网络边界，就不改变产品主流程。Adapter 不自行维护只对本模块可见的 limiter；真实请求由当前进程共享的 Network Coordinator 准入。

### 4.3 文献管理

文献管理是文献身份、统一元数据、引用关系和当前状态的唯一业务所有者。所有元数据入口——领域搜索、引用扩展和书目信息导入——都必须先经过文献管理。

它负责：

- 管理 `MetaLiterature` 和 `Literature` 两层身份；
- 保留供应商与用户书目导入的来源 observation 和来源差异；
- 使用来源 observation 中明确的 `version_links` 作为版本收敛证据，并以单一 MetaLiterature 成员归属表达最终结果；
- 形成未完成文献的当前统一初始元数据；
- 区分同一 Literature、同一 MetaLiterature 内的不同 Literature，以及不同 MetaLiterature；
- 在来源和目标都已获得本地 Literature 身份后建立 Literature 级引用事实，以独立 `ReferenceSupport` 保留每项形成依据，并提供 MetaLiterature 级汇总；
- 根据已提交事实推导每个 `Literature` 的当前状态；
- 确认 Analysis 结果属于当前具体 Literature、当前主 PDF 和当前元数据输入；
- 验收最终 `LiteratureMetadata`，并用它全量替换该版本的统一初始元数据，同时保留来源 observation；
- 整体接纳最终元数据、关键词、单一当前 `LiteratureContent`、规范 Markdown 和 Analysis provenance，使文献达到内容完成状态；
- 为查询、PDF 获取和书目导出提供一致文献视图。

它不负责：

- 查询外部供应商；
- 下载或解析 PDF；
- 调用 LLM；
- 决定数据库表、文件路径或网络协议；
- 根据模糊相似度静默合并身份。

### 4.4 Acquisition

Acquisition 模块根据具体 `Literature` 的统一元数据自动寻找主文献 PDF，或者接纳用户明确提供给该 Literature 的本地 PDF，并把成功结果交给存储。

获取对象保持四层持久语义：`AssetHint` 是来源 observation 中的线索，`PdfCandidate` 是单次运行中的候选，`Asset` 是不可变文件事实，`LiteratureAsset` 是具体 Literature 与资产之间的角色和来源关系。线索和候选都不是已经获得的资产。`PublisherAccessResolution`、`AcquisitionPlan` 与 `AccessRouteHint` 是独立的当前运行规划对象，也不是资产或持久事实。

它负责：

- 维护无 secret、版本化且具有 origin/policy 证据的 Publisher access profile catalog；
- 根据 AssetHint、来源稳定定位、Provider record identity 或必要时 DOI 安全解析后的实际 landing origin 形成访问方 Resolution，不把 metadata 来源机构、publisher 自由文本或单独 DOI prefix 当作原文归属；
- 形成按公开来源、官方授权 API 和受控 Browser 分组的确定性 Plan，省略确定不适用 route 但不提前 Browser；
- 在公开层优先尝试供应商明确返回的直接主 PDF 线索，再尝试公开全文服务、OA locator 和普通 HTTP landing page；
- 接受 Entry 的 cohort 层级调用，为 API/DOI/页面产生的安全 route hint 重新规划，并保证同一 Literature 不跨层竞速；
- 把 API capability 明确区分为 metadata/search、locator/resolution、entitlement、structured full text、direct PDF 和 multi-step PDF object retrieval，只有实际 PDF 字节形成临时候选；
- 为 Browser route 声明封闭页面规则、正文/补充材料区分、`browser_rate_limit_group`、`browser_session_key` 与政策证据；
- 对每个候选执行统一基本检查；
- 对手动提供的文件复制内部副本并执行同一基本检查，不移动、修改或删除用户原文件；
- 一个候选正常未命中或未通过基本检查时继续其它候选；timeout、临时服务错误、`429`/quota、Browser action-required、Network/API/权限/配置错误和取消不能被解释为正常耗尽或无条件升级；
- 为通过检查的 PDF 形成 hash、来源和 Literature 关系；
- 保证同一 `Literature` 只有一个当前主 PDF 驱动后续处理；
- 在内容被明确判定无效时撤销当前关系并删除对应资产和中间结果，使 Entry 能继续其它候选。
- 已有当前主 PDF 时拒绝普通手动接纳，不能静默替换。

下载阶段只做以下基本检查：

1. 实际字节非空，并根据字节确认是 PDF，不能信任扩展名、文件名、HTTP `Content-Type` 或下载事件；
2. 标准 PDF reader 能够打开；
3. 页面树可读取且至少有一页；没有可用密码而无法读取的加密 PDF 不能通过；
4. 候选来自目标 `Literature` 的 `AssetHint`、稳定标识符或已配置文献来源，而不是无依据地关联文件。

轻微不规范但仍能正常打开和读取页面的 PDF 可以接纳。下载阶段不证明正文完整性，也不判断摘要、目录、封面或学术内容，不比较标题、作者、年份或 DOI，不使用固定最小页数、固定最小字节数或正文字符数。HTTP 成功、浏览器下载事件、HTTP 类型、文件扩展名、文件名或网页声称提供全文都不能单独代表已经获得 PDF。

一个 `Literature` 可以发现多个候选来源，但只有一个当前主 PDF。同次运行只以临时已尝试集合避免立即重复候选，不长期保存无效候选及其失败信息。已经形成有效 `LiteratureContent` 后，不因发现其它候选自动替换当前主 PDF。补充材料和其它相关资产可以保存为补充资产，但不驱动 Parsing、Analysis 或核心状态。

层级表示 Acquisition 选择的风险上下文，不等于网络限速范围。公开 `AssetHint` 指向出版社网页时，普通 HTTP 使用该访问方的网页与 host scope；官方 API 使用按真实 quota identity 形成的独立 API scope；Browser 额外使用 Profile 的 risk group 和 session key。Acquisition 不以固定 sleep 计算等待，也不把网页繁忙解释为来源正常未命中，所有真实请求在当前进程共享的 Network permit 下执行。用户配置了密钥只表示 adapter 可以尝试认证；认证成功仍不能代替对当前 Literature 的内容 entitlement 判断。

Acquisition 的公开业务结果只有“获得当前主 PDF”和“没有获得当前主 PDF”。单个候选未通过文件检查时删除临时文件，不创建 `Asset`/`LiteratureAsset`、不保存候选级原因并继续下一候选；没有候选、正常未命中、Browser 流程正常结束但没有下载、非 PDF 或损坏 PDF，在全部适用 routes 都正常结束且没有 deferred/action-required/未解决 failure 后归入无字段的 `NoPrimaryPdf`，并只保存该具体 Literature 已自动耗尽这一最小事实。临时网络/API 错误、`Retry-After`/quota、Browser 登录/MFA/challenge、权限/配置错误、用户中断、数据库、文件系统或关系提交错误直接形成本次失败，不能虚构“没有获得”或需要人工 PDF。唯一的 `primary-pdf` 关系就是该 Literature 的当前主 PDF，不再维护平行 `is_current` 状态。

上述二值结果只属于自动获取。手动 PDF 是单独操作：有效文件发布后返回已经接纳的 Asset 与 LiteratureAsset，无效文件形成输入验证错误；它既不产生 `NoPrimaryPdf`，也不增加自动获取的第三种结果或第四种 `AcquisitionPath`。

供应商返回的 URL、媒体类型、开放状态和许可证只是某次来源观察到的获取线索，不属于 `LiteratureMetadata`，也不证明已经获得有效资产。Metadata 将这些线索转换为中性 `AssetHint`，Entry 把它们交给 Acquisition；Acquisition 使用时仍经过统一网络政策和 PDF 基本检查。一个线索失败后继续其它线索，直接主 PDF 获取成功后不再进行无意义的来源搜索。

### 4.5 Parsing

Parsing 模块把当前主 PDF 转换为领域中立的 `ParserResult` 中间结果。当前解析实现选择 operator-managed MinerU 服务，但 MinerU 不是产品合同，也不拥有 SciRetriever 的文献状态、轻结构化文档或引用事实。

它负责：

- 把当前主 PDF 提交给选定解析器；
- 把解析器私有结果转换为统一、规范化 Markdown `ParserResult`；
- 保存 Markdown 实际引用的资源及其 hash，但不解释图片内容；
- 检查返回协议、Markdown、资源、路径、页数和输入资产对应关系；
- 保存解析器身份、输入 PDF hash、必要参数和结果 hash；
- 在新结果完整接纳后替换同一输入 Asset 的当前 ParserResult，并把旧字节交给缓存回收；
- 在单篇解析失败时返回稳定失败，不影响其它文献。

`ParserResult` 至少为后续 LLM 保留：

- 规范化 Markdown 的不可变 artifact 引用；
- Markdown 实际引用资源的相对引用、媒体类型、大小和 hash；
- 输入 PDF identity/hash 与物理页数；
- parser identity、版本、mode、model identity、参数 hash 和 ParserResult hash。

`ParserResult` 由 Analysis 的消费需要定义，不复制 MinerU `middle.json`、GROBID TEI、Docling JSON、block、bbox 或逐段 source locator。不能直接产生 Markdown 的 Parser 由自己的 Adapter 完成确定性转换；原生 JSON、TEI、模型输出和未引用资源只作为过程文件，转换结束后清理。

`ParserResult` 不是 `LiteratureContent`，不作为可独立导出的文档，也不推进 Literature 状态。解析器不判断文献身份、实际内容、参考文献边界或最终元数据，也不产生引用检索线索或权威引用关系。一次处理只使用一个解析器，不竞赛、不合并，也不在失败后自动回退到另一解析器。

### 4.6 LLM 分析与总结

LLM 分析与总结模块消费经过验证且对齐当前 PDF 的 `ParserResult`。对普通长度文献，一项逻辑内容分析包含两次有序核心请求：第一阶段同时使用当前统一初始元数据和 `ParserResult`，判断实际内容并确定结构化最终 `LiteratureMetadata`，其中包括最终关键词和原文摘要；内容有效且元数据通过结构验证后，第二阶段同时使用同一 `ParserResult` 与第一阶段的完整元数据，总结正文并识别参考文献文本。第二阶段不能提前开始，也不能重新生成另一份元数据、关键词或摘要。超长文献可以在各阶段内部使用有界分段和汇总，但不能改变先元数据、后正文的依赖顺序；对其它模块仍是一项逻辑 Analysis 和一份最终结果。

第一阶段形成的是一份完整最终元数据，而不是零散字段补丁。它保留统一初始元数据中没有冲突的可靠值，只根据 PDF 明示内容补齐摘要、页码等缺失项，并在能够确认同一出版社时统一来源中的名称变体；不能确认的值保持缺失。供应商身份仍属于来源 observation 的 provenance，不随出版社名称一起进入或改写 `LiteratureMetadata`。

内容判断遵守：

- 必须存在属于当前目标 Literature、足以说明该文献实际研究、论证、综述、讨论或报告了什么的内容；
- 只有封面、目录、标题与元数据、摘要、访问提示、错误页、下载说明，或者内容明确属于另一篇文献时，判定为不可用；
- 一页 PDF 不自动无效，完整短文、通信、评论、更正或技术说明可以通过；
- 只有结构有效且明确的 `NoUsableContent` 可以触发删除 PDF 和对应解析结果；
- ParserResult 乱码、截断、只剩资源引用或不足以判断，以及 LLM 调用失败、响应缺失、未知结构或输入不对齐，都只是处理失败，必须保留 PDF。

第一阶段结果的封闭合同为：

```text
NoUsableContent
  outcome: Literal["no_usable_content"]

FinalMetadataProposal
  outcome: Literal["usable"]
  metadata: LiteratureMetadata

MetadataAnalysisResult = NoUsableContent | FinalMetadataProposal
```

`NoUsableContent` 不携带评分、置信度或详细原因；`FinalMetadataProposal` 直接使用 `LiteratureMetadata`，不建立第二个元数据类。LLM provenance 由程序补充，不由模型输出。

Markdown 固定一级标题及顺序为：

```markdown
# 元数据

# 摘要

# 研究背景与目标

# 研究方法

# 数据

# 结论与局限性

# 参考文献
```

七个标题必须存在且不能改名、删除或重排。允许在摘要之后、参考文献之前增加必要的额外正文一级标题；研究背景与目标、研究方法、数据、结论与局限性及额外正文一级标题可以具有二级标题。元数据、摘要和参考文献下不增加二级标题；当前只承诺 H1/H2，参考文献始终最后。原文未明确提供固定内容时保留标题并使用精确字符串“未提供”，不能使用 `N/A`、`null`、`None`、空字符串或其它自然语言表达同一缺失事实；没有内容的额外标题不创建。

`# 元数据` 是封闭填空块，字段与顺序固定为 Title、Authors、DOI、Other Identifiers、Publication Date、Year、Document Type、Language、Venue、Publisher、Volume、Issue、Pages、Keywords。程序 renderer 不能增删、改名或重排；URL、开放获取、许可证、引用计数、供应商、状态和 provenance 不进入。结构化可选字段使用 `None`、关键词缺失使用空 tuple，渲染时统一显示“未提供”。Abstract 属于第一阶段确定的 `LiteratureMetadata`，但单独渲染为 `# 摘要`；缺失 abstract 以 `None` 保存并显示“未提供”。

标题、原文摘要、写入文档的原始数据、数值、单位、公式和参考文献文本必须忠于 PDF；背景、目标、方法、数据解释、结论与局限允许跨原文章节总结。最终关键词只有 `LiteratureMetadata.keywords` 一个扁平列表，突出核心领域、问题、方法、对象、材料、理论或贡献，不要求维度齐全，也不为测试、对照、背景或次要案例机械加标签。

参考文献字段固定为：

```text
LiteratureContent.references: tuple[str, ...]
```

第二阶段必须在最后使用 `# 参考文献` 和 Markdown 有序列表，一项对应一条参考文献原文。程序去掉编号后按顺序保存每条非空文本。LLM 可以清理断行、空白和明确的 OCR 分隔问题，但不能补写 PDF 没有表达的标题、作者或标识符。文本即使缺少标题或 DOI 仍然保留，使 `LiteratureContent` 无需查询引用关系即可独立导出。没有可识别参考文献时保存空 tuple，最终 Markdown 显示“未提供”；缺失标记不能解析成一条参考文献。整份内容通过单一 Analysis provenance 的输入 hash 回溯到 PDF、ParserResult 和最终 metadata，不建立逐条 block/source-locator 合同。

Analysis 验证 Markdown 结构和输入对齐后，把正文解析为统一有序的 `LiteratureSection[]`：

```text
LiteratureSubsection
  title: str
  markdown: str

LiteratureSection
  role: LiteratureSectionRole
  title: str | None
  markdown: str
  subsections: tuple[LiteratureSubsection, ...]
```

一级章节角色为 `background-and-objectives`、`methods`、`data`、`conclusions-and-limitations` 和 `additional`。程序只理解 H1/H2；章节内部段落、列表、表格、公式和代码块继续作为 Markdown 字符串保存。四个固定角色各出现一次并保持相对顺序，其 `title = None`；固定 section 整体没有相关信息时使用 `markdown = "未提供"` 和空 subsections，有实际内容时由非空 H1 直属 Markdown 或至少一个有内容的 H2 表达，只有 H2 有内容时 H1 直属 `markdown` 可以为空。“未提供”不能与有内容的 H2 混用。`additional` 可出现零到多次且必须携带不与七个固定标题冲突的非空 title，没有内容时不创建。全部一级章节处于同一个序列中以保留实际 Markdown 顺序，H2 作为所属 H1 的有序子项。元数据、摘要和参考文献不作为 additional section。

Analysis 从第一阶段的结构化响应取得最终元数据和摘要，从第二阶段内容 Markdown 草稿解析章节与有序参考文献文本。Literature 验收最终 `LiteratureMetadata` 后，程序从已验收 metadata、sections 和 references 确定性渲染规范 Markdown；`# 元数据` 和 `# 摘要` 不由第二阶段重复生成。两阶段临时结果都不长期保存。

最终 `LiteratureContent` 保存内容 hash、metadata revision/hash、有序 sections、references、规范 Markdown `ArtifactRef` 和一项 Analysis provenance。内容 hash 只覆盖 metadata hash、sections 和 references 的规范序列化，不包含 metadata revision、provenance、模型、时间、路径、Markdown hash 或数据库 ID；Markdown hash 只覆盖 UTF-8 `text/markdown` 字节。provenance 的输入 hash 覆盖 PDF、ParserResult 和最终 metadata，参数 hash 覆盖 prompt 版本和有效模型参数；不保存两个调用的独立 provenance、Parser provenance 副本或完整 prompt/request/response。

每个 Literature 只保留一个当前 LiteratureContent。新结果必须完整生成、验证并接纳后原子替换当前关系，失败保留旧结果；旧结构化内容和 Markdown 字节不形成数据库历史，只成为可回收缓存。当前内容缺失、损坏或输入不再对齐时，可以从权威元数据和当前 PDF 重新解析、分析生成。

`ReferenceLookup` 是 Analysis 内按引用扩展需要调用的另一个 LLM 用例。Lookup 只包含原文中明确识别出的稳定标识符、标题、作者和年份等搜索线索；它不持久化，也不能作为被引文献的权威元数据。明确格式的 DOI、PMID、arXiv ID 等由代码校验和规范化。引用 lookup 失败不影响原文保存、文档导出或内容完成。

当前不建立公共 LLM 基础设施模块。文献总结和 `ReferenceLookup` 共用 Analysis 内部的 LLM Port 与 provider adapter，adapter 经过 Network；其它模块只调用 Analysis 的业务 API。只有未来至少两个独立功能模块真实需要中性的 LLM 能力时，才通过新 ADR 讨论提升。

## 5. 四个公用基础模块

### 5.1 Model

Model 定义除 Logging 外各模块之间交换的统一数据合同，包括：

- 发现输入、运行时批量选择、当前操作报告和发现原因；
- 供应商元数据、原始参考文献文本与引用查询结果；
- `MetaLiterature`、`Literature`、`LiteratureMetadata`、`MetadataObservation.version_links`、`ProviderRelationObservation`、`Reference` 和 `ReferenceSupport`；
- PDF 候选、资产和来源关系；
- 总结型 `LiteratureContent`、有序 `LiteratureSection`、规范 Markdown 和文本参考文献；
- 内容可用判断、最终元数据提案和临时 `ReferenceLookup`；
- 查询、书目交换、自动 PDF 获取耗尽事实，以及当前操作使用的内存目标和结果。

结构化业务数据统一使用 Pydantic。Model 默认不可变，只完成字段类型、必填项、额外字段拒绝、不可变容器转换和必要的跨字段结构约束，不执行身份判断、状态推导、I/O、环境读取或供应商调用。

`LibraryQuery`、搜索请求/页面、列表项、资产组合 view、`LiteratureDetail`、引用关系页面和 `ReferenceDetail` 也使用 Pydantic，以便 CLI、JSON 和程序调用共享稳定读取合同；但这些只是查询时形成的不可变投影，不是新的数据库主体或长期业务事实。Artifact binary stream 和用户目标路径是 I/O boundary 对象，不进入 Pydantic，也不让 Detail 执行 I/O。

Vendor、HTTP、浏览器、SQL、MinerU 私有响应和 LLM 私有响应必须在对应模块的适配边界转换成 Model，不能进入模块公开 API 或业务规则。

### 5.2 网络基础设施

网络基础设施为元数据供应商、Acquisition、Parsing 和 LLM 提供共同的安全访问能力，逻辑上包含共享访问政策、进程内供应商级准入、普通 HTTP 和受控浏览器。

它负责：

- URL 规范化、scheme、port 和 userinfo 限制；
- DNS 结果和公网、私网、loopback 判断；
- redirect 逐跳复检、origin 和凭据转发控制；
- 按 provider、`api`/`web` 通道、必要的 API service 和实际 host 执行当前进程共享的访问准入；
- 在 adapter/Profile 声明的规则基础上执行并发、最小间隔、窗口/周期额度、reset boundary、`Retry-After`、`next_allowed_at` 和 `blocked_until`；
- 对 API 按真实 quota identity 执行官方政策，并在共享额度池的当前进程调用方之间共享反馈；
- 对 Browser 按 `browser_rate_limit_group` 执行不同组并行、同组 `concurrency = 1` 且按 Provider 文章政策限速串行；全局 Browser 上限只保护本机资源；
- HTTPS、TLS、timeout、连接复用和有界响应读取；
- operator-managed persistent Browser context、文章级 page 隔离、多路 PDF 捕获和资源清理；
- 在每次 Browser navigation、popup、viewer、response 和 download 实际访问前，同时执行 Profile guard 与通用安全准入；
- URL、header、query、错误和凭据脱敏；
- 响应大小、导航次数和访问预算。

网络基础设施不理解 Crossref、arXiv、出版商、MinerU 或某个 LLM 的业务协议，也不判断记录身份、PDF 归属、正文/补充材料或文献状态。供应商分页、配额含义、页面步骤和 Browser 状态 marker 属于相应 adapter/Profile；adapter 负责解释和声明政策，Network 负责在当前进程的全部调用方之间执行。等待队列、permit、窗口计数、session health、circuit 和截止时间只存在于当前进程内存，不属于由 Catalog 与 ArtifactStore 组成的文献数据库，也不携带 DOI、Literature、候选、完整 URL、Cookie 或凭据。Network 不持久化动态限速状态，不提供跨进程或跨重启的访问协调。

### 5.3 存储

统一逻辑文献数据库由结构化 Catalog 和同一配置存储根下的 ArtifactStore 共同构成，二者由 Storage 提供技术实现：

- Catalog 保存 DiscoveryRun、文献身份、元数据、关系、hash、相对引用、状态所需事实和自动 PDF 获取耗尽事实；
- ArtifactStore 保存 PDF、结构化 `LiteratureContent` 的规范序列化和规范 Markdown 产物；
- Catalog 不保存大型 BLOB 或机器相关绝对路径；
- 文件发布使用 create-if-absent，不原地覆盖已接受内容；
- 相同字节可以复用，不同字节不能无声覆盖；
- Catalog 关系只引用已经成功发布的 artifact。

Storage 还实现消费模块拥有的一致 read-model 与 artifact reader Port。关系页面/详情在一个 read-only snapshot 中从同一权威 Reference 正反向组装；artifact reader 只按已提交的 Asset/ArtifactRef 解析正式对象并复核大小、hash 与媒体类型，不暴露内部绝对路径。导出到用户文件使用独立的同目录 staging 和原子发布，不把用户副本纳入 ArtifactStore，也不修改数据库。

Storage 只保存其它模块已经确认的事实，不自行合并文献、选择统一元数据、选择主 PDF、判断内容可用或改变业务状态。Catalog 与 ArtifactStore 共同构成产品数据库，不表示 Storage 拥有其中事实的业务含义。

Storage 在一个 read-only snapshot 中为 Literature 组装 SearchPage、LiteratureDetail、Reference 正反向页面和 ReferenceDetail，但不保存查询条件、cursor、页面、详情或其派生计数。查询投影丢弃后可以从相同 current facts 重新形成；持久化它们只会复制 metadata/status/关系并产生漂移，因此当前不建立对应表或 artifact。

Catalog 长期保存一个 Literature 关联的全部已接纳 `MetadataObservation`，并且只保存一份当前统一 `LiteratureMetadata`。新的 observation 不覆盖旧来源事实；当前统一元数据替换时递增 revision 令牌但不保留旧统一元数据历史。LLM 最终提案只有和当前 LiteratureContent 整体接纳后才替换当前元数据，不作为 observation 保存。

在文献内容处理链中，来源 observation、当前权威元数据和原始 PDF 是优先长期可靠保存的权威输入；当前 ParserResult、Parser Markdown 与引用资源、当前 LiteratureContent、总结型 Markdown 和由当前内容形成的 `ContentReferenceTextSupport` 是可以重建的派生产物。派生产物仍须有一个完整当前结果、hash、轻量 provenance 和原子发布，但不维护历史；它们的损坏、清理或丢失不能破坏元数据和 PDF。本节只确定该逻辑合同，不提前规定物理目录、备份、缓存配额、清理周期或恢复算法。

#### 5.3.1 事实所有权

| 事实 | 业务所有者 | 存储责任 |
|---|---|---|
| DiscoveryRun、来源结果、发现对象和原因 | 入口与流程编排 | 保存冻结输入、逐来源终止结果、到 MetaLiterature 的结果关系及直接原因；不保存过程计数或完整路径 |
| 自动 PDF 获取耗尽 | Acquisition | 只保存具体 Literature 已正常耗尽当前自动路径这一最小事实；不保存原因、候选、尝试或配置快照，并在输入变化、主 PDF 成功或明确重试时清除 |
| 来源 observation | 元数据供应商 | 保存元数据事实、同文献版本连接、逐边 ProviderRelationObservation 和供应商身份 |
| MetaLiterature、Literature、LiteratureMetadata、Reference、ReferenceSupport 和状态 | 文献管理 | 保存权威身份、信息、关系及其来源支持 |
| 当前主 PDF、补充资产及来源 | Acquisition | 保存不可变文件和版本关系 |
| 当前 ParserResult、实际引用资源及 parser provenance | Parsing | 只保存每个输入 Asset 的当前中间结果；新结果完整接纳后替换当前关系，旧字节进入可回收缓存，不形成历史或文献状态 |
| 第一阶段元数据提案、第二阶段内容 Markdown 草稿、内容判断和待验收解析结果 | LLM 分析与总结 | 两阶段临时结果不长期保存；只保存最终接纳内容的一项 Analysis provenance |
| 最终 LiteratureMetadata、当前 LiteratureContent 与规范 Markdown | 文献管理 | 权威元数据长期保存；结构化章节、参考文献和 artifact 关系只保存一个可重建当前结果，不形成历史 |
| BatchSelector、冻结目标候选、逐目标运行结果和 Report | 入口与流程编排 | 只在当前进程内展开、冻结、汇总并返回；不进入 Catalog，也不参与下次选择 |

#### 5.3.2 一致提交

以下逻辑更新必须整体成功，用户不能观察到互相矛盾的部分结果：

- 来源 observation、身份结果、统一初始元数据、DiscoveryRun 结果与直接原因；
- 新 MetadataObservation 接纳与对应自动 PDF 获取耗尽事实的清除；
- 手动 PDF 内部副本、user provenance、唯一 `primary-pdf` 关系和已有耗尽事实清除；用户原路径和原文件不进入提交；
- 主 PDF、与 `Literature` 的关系、“已有文献资产”事实和已有耗尽事实清除；
- Acquisition 正常遍历全部当前自动路径后，建立该具体 Literature 的自动获取耗尽事实；
- 新 ParserResult artifact 发布、同一输入 Asset 当前关系替换和旧关系解除；
- 最终元数据、关键词、当前 `LiteratureContent`、规范 Markdown、与当前 PDF/metadata revision 的关系和内容完成事实；替换旧内容时同步删除旧 `ContentReferenceTextSupport`，并删除因此失去全部 support 的 Reference；
- 两个具体 Literature 之间已经确认的 Reference 及其第一项 ReferenceSupport；
- 内容无效时当前 PDF、解析结果和对应关系的删除；
- 身份整理或删除涉及的全部关系变化；
- 用户明确重新尝试自动 PDF 获取时，先清除相应耗尽事实。

网络、浏览器、MinerU 和 LLM 调用发生在数据库事务之外。提交前必须重新确认输入 `Literature`、当前元数据和 PDF 没有变化，拒绝过期结果。

### 5.4 Logging

Logging 是公用基础模块，拥有独立的 `sciretriever/logging/` 目录和 `api.py` 公开边界。它统一提供命名 logger，配置 `sciretriever` logger 层级、stderr handler、formatter 和最终脱敏 Filter，并承载当前进程中的操作开始、阶段推进、局部失败、限速等待、目标完成和受控停止信息，为用户提供实时反馈、为实现者提供安全诊断。

Logging 不拥有业务结果：各模块先形成 typed result 或稳定 failure，Entry 据此累计 Report，同时选择少量进度信息进入日志；日志缺失、过滤或输出失败不能改变数据库提交、Report、退出结果和后续选择。项目不建立全局可变 Observer、事件总线、LogEvent Model、Logging Port 或日志 repository。

具有运行行为的模块通过 `logging.api.get_logger(__name__)` 获取 logger，不直接调用标准库配置函数。生产 Bootstrap 只通过 `logging.api.configure_logging(...)` 传入 level 并触发一次生产配置；formatter、最终脱敏 Filter 和 stderr handler 全部由 Logging 模块实现。模块 import、adapter 构造和每次操作不得私自安装 handler。Logging 不修改宿主应用的 root logger，纯声明的 Model 不依赖 Logging。

日志和用户主要结果使用不同通道：实时日志与进度进入 stderr，CLI 文本结果、JSON Report 和其它可管道结果进入 stdout。日志格式不是稳定公开 API，也不能成为批次历史或恢复输入。Network 负责 URL、header、Cookie、凭据和网络异常的边界脱敏；Provider、Parser 和 LLM adapter 负责各自私有对象、响应、prompt 和异常的边界转换；Logging 的 Filter 只提供最终防线，不能替代这些来源边界。Entry 只记录已经稳定化的 failure 与安全 ID，不直接记录原始外部对象或文献正文。

## 6. 文献身份、元数据与状态

### 6.1 MetaLiterature 与 Literature

系统使用两层内部身份：

| 身份 | 含义 |
|---|---|
| `MetaLiterature` | 同一文献多个明确版本的稳定聚合身份 |
| `Literature` | 能够独立拥有 `LiteratureMetadata`、PDF 和 `LiteratureContent` 的具体文献 |

预印本、作者接受稿和正式发表版只有在来源 observation 存在明确同文献版本连接时才共享 `MetaLiterature`，并保留为不同 `Literature`。不同 Literature 之间不混合元数据、资产或内容。

核心归属关系为：

```text
MetaLiterature
  -> 聚合一个或多个 Literature
  -> 必须选择其中一个代表 Literature

Literature
  metadata: LiteratureMetadata
  content: LiteratureContent | None
```

每个 `Literature` 从创建开始必须且只能属于一个 `MetaLiterature`，即使当前只有一个版本也不例外。成员关系只由 Literature 指向 MetaLiterature 的归属保存，不在 MetaLiterature 中重复维护成员 ID 集合。`MetaLiterature` 至少包含一个 Literature，代表 Literature 必填且必须属于当前聚合。

`MetaLiterature` 只负责聚合和选择代表 Literature，不拥有元数据、标识符、PDF、`LiteratureContent`、状态、observation 或关系列表。每个 Literature 独立拥有自己的元数据、资产和内容。代表 Literature 默认优先选择正式发表版（`published`），其次是作者接受稿、预印本和其它已确认版本；代表关系变化只影响聚合视图，不删除其它 Literature，也不转移或覆盖版本数据。共同的 `meta_literature_id` 和各自 `version_role` 已经完整表达版本聚合，不再建立独立 `LiteratureRelation`。

### 6.2 保守身份收敛

自动身份收敛只使用确定、可解释的证据，不使用模糊相似度静默合并。

文献 identifier 的值不使用 SciRetriever 私有格式，而是在公共 Model 边界转换为官方 canonical form：

| namespace | 接受的传输表示 | 当前 Literature 身份值 |
|---|---|---|
| `doi` | 裸 DOI、`doi:`、`https://doi.org/` 或 `http://dx.doi.org/` 包装 | 去壳、去边界空白并转为小写的 `10.xxxx/...` |
| `arxiv` | 官方新式/旧式 ID、`arXiv:` 或官方 arXiv URL，可带 `vN` revision | 不带 `vN` 的新式 `2501.01234` 或旧式 `hep-th/9901001` 基础 ID |
| `pmid` | 官方 PMID 值 | 纯数字 |
| `pmcid` | 官方 PMCID 值 | 大写 `PMC` 加数字 |
| 其它受支持 namespace | 官方规范允许的表示 | 各自官方 canonical form，不附加项目自定义前缀 |

只有确实标识当前具体 Literature 的官方 ID 才能进入 `LiteratureMetadata.identifiers`。OpenAlex Work ID、Web of Science UID、Semantic Scholar Paper ID、Scopus EID 等 Provider record identity 即使格式稳定，也只能进入 `Provenance.source_record_id` 或 `ProviderLiteratureKey.record_id`。它们可以定位同一 Provider 中的来源记录或版本端点，不能作为跨供应商文献自身标识符。

身份判断按以下顺序执行：

1. 先对已知 namespace 形成 canonical `(namespace, value)`，再查询当前数据库中的精确身份映射；
2. 至少共享一项身份型稳定标识符且不存在其它身份型稳定标识符冲突时，命中同一 `Literature`；一条记录同时把对象指向相同和不同身份时返回稳定身份冲突接纳失败，不选择其中一个值继续；
3. 双方都没有稳定文献标识符时，才允许使用规范化标题、完整作者顺序、发表年份和 `document_type` 的严格复合后备；四项必须全部存在且完全一致；
4. 没有共享稳定标识符、后备条件不完整或证据不足时保持独立；不同 DOI 默认是不同 `Literature`，即使标题相同；
5. 标题或作者相似不能覆盖稳定标识符冲突，身份冲突也不能自动建立版本关系。

标题和作者比较键只执行 Unicode NFC、首尾空白清理、连续 Unicode 空白合并和 Unicode casefold。来源题名与署名展示值不被这个比较键改写；标点、连字符、姓名组成和完整作者顺序均保留，不做翻译、拼音或其它转写、姓名倒置、首字母展开、标点删除、编辑距离或模糊匹配。

相同规范化 DOI 默认是同一 `Literature`，`version_role` 不得把它强行拆开。同一基础 arXiv ID 的 `v1`、`v2` 等 revision 也是同一 `Literature`；revision 可以保留在来源已有的 record、locator、URL 或 Provenance 中，但不新增业务字段。arXiv 预印本和具有正式 DOI 的发表版是两个具体 Literature；正式记录中的相关 arXiv ID 应形成 `version_links` 目标，而不是混入正式 Literature 自身 identifiers。

只有 `MetadataObservation.version_links` 保留了供应商明确声明的同文献版本连接时，才能认定两个不同 `Literature` 属于同一 `MetaLiterature`。当前 observation 自身定位一端，每个 `ProviderLiteratureKey` 定位另一端；目标必须具有非空供应商记录 ID 或稳定 Identifier。引用、更正、撤稿、不同 `version_role`、相似标题、相似作者或 publisher 都不触发版本聚合。

`version_links` 复用所属 `MetadataObservation` 的 Provenance，只作为身份收敛证据。目标尚未解析或证据不足时继续保留来源 observation，但不创建占位 Literature，也不改变任何 `MetaLiterature` 归属。系统不建立通用 `LiteratureRelationObservation`、`LiteratureRelation` 或引用以外的关系图谱；更正、撤稿和其它供应商关系当前不进入业务 Model。

身份冲突只形成稳定接纳失败；当前不建立候选、冲突历史或人工审核状态机。来源中的描述性差异继续由独立 observation 保留，不能反向改变已经由无冲突稳定标识符确认的身份。

### 6.3 来源 observation 与统一元数据

每个供应商实际返回并被接纳的中性记录，以及每条带来新来源事实并通过接纳的用户书目导入记录，都作为独立、不可变的 `MetadataObservation` 长期保存，一个 Literature 可以关联多个 observation；重复导入相同规范化内容只形成 matched，不增加 observation。导入记录直接复用 `LiteratureMetadata`，不建立 `ImportedMetadata` 或其它平行字段体系。统一初始元数据按以下优先顺序逐字段形成：

1. 用户导入 observation 中存在非空值时采用该值；
2. 用户导入缺少字段时，按显式配置顺序选择供应商 observation 的有效值补充；
3. 来源冲突继续保留，不被统一视图覆盖；
4. 非冲突稳定标识符可以共同保留；
5. 相同输入和规则重复执行得到相同结果。

数据库只保存一份当前统一 `LiteratureMetadata`，不保存旧统一元数据的 revision 历史。revision 是当前元数据的并发与 lineage 令牌，不是历史对象。Analysis 最终提案在完整内容接纳时替换当前元数据，但不删除或改写任何来源 observation；LLM 结果也不伪装成 MetadataObservation。

元数据不完整的文献可以先入库并继续处理，但必须至少具有标题或 DOI。DOI 继续作为带 namespace 的稳定标识符表达，不建立平行顶层字段；其它标识符不能替代 DOI 满足最低入库条件。

供应商返回的 `declared_keywords` 保留在来源 observation 中，不直接进入统一 `LiteratureMetadata`。用户书目导入中的 keywords 保存在该 observation 的 `metadata.keywords`，可以进入统一初始元数据；完整 Analysis 仍按全文形成最终 `LiteratureMetadata.keywords`。最终关键词不再建立平行分类或标签结果，并使用一个扁平列表突出核心信息，不要求领域、方法、材料等维度全部存在。供应商明确声明的同文献版本目标保存在 `MetadataObservation.version_links: ProviderLiteratureKey[]` 中，不进入 `LiteratureMetadata`，也不产生独立权威关系。开放获取等访问状态描述具体获取渠道，归入资产线索，也不进入 `LiteratureMetadata`。来源 observation 只显式保存产品需要的中性信息，不建立容纳全部 vendor 字段的通用扩展对象。

`LiteratureMetadata.authors` 按署名顺序保存具体 Literature 的结构化作者列表。每个供应商 observation 独立保留自己的作者列表；统一初始列表选择第一个非空高优先来源作为基础，只有 ORCID 相同，或者作者数量、顺序和规范化展示名全部一致时，才允许从其它来源补齐缺失字段。补齐只增加缺失的姓名组成、ORCID 或单位，不覆盖高优先来源已有值；单位只按相同 ROR 或完全规范化名称去重。系统不按姓氏、作者位置或模糊名称匹配作者，也不建立全局 Author 实体。

Analysis 对有效文献形成一份最终元数据与内容提案后，文献管理验收并用最终 `LiteratureMetadata` 整体替换该版本的统一初始元数据。规范 Markdown 的元数据块和摘要从这份已验收 metadata 确定性渲染，避免保存两份可能漂移的信息。所有来源 observations 继续保留用于说明元数据依据，但不再参与内容完成版本的普通统一展示。已经 `CONTENT_READY` 的 Literature 接纳新导入 observation 时，不立即拆开替换当前 metadata/content；下一次完整 Analysis 使用新的导入优先初始投影，并且只有新的最终 metadata/content 整体接纳后才切换当前视图。

### 6.4 引用关系

供应商关系 observation、参考文献原文、目标检索、权威引用关系和关系形成依据是五个不同事实：

- 供应商明确返回的每条有向关系保存为独立 `ProviderRelationObservation`，可以先于目标 Literature 存在；
- PDF 中识别的有序参考文献文本保存在当前 `LiteratureContent.references`，并通过整份内容的 Analysis provenance 与输入 hash 回溯来源，不保存逐条位置；
- 供应商只返回原始文本时，文本保存在该 `MetadataObservation`；
- LLM 从原文形成的 `ReferenceLookup` 只在当前检索过程中使用；
- 目标先在本地精确查询，未命中时经 Metadata 形成 `MetadataObservation`，再按普通身份规则创建或命中具体 `Literature`；
- 只有来源与目标都具有本地 `LiteratureId` 后，Literature 才建立从引用方到被引用方的权威 `Reference`；
- `ReferenceSupport` 指回供应商结构化关系、`MetadataObservation.reference_texts` 中的具体条目，或当前 `LiteratureContent.references` 中的具体条目。

`ProviderRelationObservation` 是供应商关系的最小持久化和待扩展单位，一项 observation 只表达 `citing -> cited` 一条边。它不是任务，不维护扩展状态；Entry 根据当前收集范围和现有 Literature/Reference 事实决定是否继续物化目标。未进入范围、元数据不足或接纳失败时，只保留 observation，不创建 Literature、Reference 或 ReferenceSupport。

`Reference` 的字段只有 `reference_id`、`source_literature_id` 和 `target_literature_id`。它只连接两个不同的具体 `Literature`，不指向供应商记录、原始文本、临时 lookup 或 `MetaLiterature`，也不平铺 provenance。每条权威关系至少具有一项 support；相同 source/target 只形成一条 Reference，多个来源只增加 support。ReferenceSupport 本身不复制原文、目标元数据、evidence 或 provenance，这些内容继续由其指向的来源对象拥有。`ProviderRelationObservation` 只有在目标接纳并形成 Reference 后，才通过 `ProviderRelationSupport.observation_id` 成为该权威边的支持。

当前 LiteratureContent 被替换时，删除全部指向旧内容 hash 的 `ContentReferenceTextSupport`；Reference 因此没有任何剩余 support 时一并删除。新参考文献按普通 lookup 流程重新建立关系支持，ProviderRelationSupport 和 MetadataReferenceTextSupport 不受内容替换影响。

元数据供应商返回结构化关系还是参考文献原文，由数据语义决定：已经明确给出稳定目标标识的是结构化关系；只有格式化文字的是参考文献原文。两者可能来自专门关系接口，也可能由普通元数据响应默认携带，调用方式不是分类标准。只有计数、原文、lookup、供应商目标 ID 或不确定候选时都不形成 Reference。被引用视图和 `MetaLiterature` 级引用网络由 Literature 级关系反向查询或汇总；后续运行可以重新尝试尚未解析的原文。

### 6.5 三级文献状态

每个 `Literature` 根据已经提交的权威事实推导三级状态：

```text
未审阅
  -> 已有文献资产
  -> 内容完成
```

| 状态 | 推导依据 |
|---|---|
| 未审阅 | 已有当前统一元数据，但没有当前主 PDF |
| 已有文献资产 | 当前主 PDF 已通过基本检查并与该版本关联 |
| 内容完成 | 当前最终元数据、关键词、`LiteratureContent` 和规范 Markdown 已由 Literature 整体接纳，对齐当前主 PDF 和 metadata revision，并具有 Analysis provenance |

状态不是可以独立修改的第二份字段。任务、失败、MinerU task 或 LLM 调用记录不能直接决定文献状态。

内部枚举分别为 `UNREVIEWED`、`ASSET_READY` 和 `CONTENT_READY`；`CONTENT_READY` 已表示本产品内容处理完成。普通后续失败不撤销已经提交的有效前序结果。语言模型明确判断当前 PDF 没有实际内容时，删除 PDF 和对应解析结果，状态随现有事实回到未审阅；这是清理无效内容，不是失败回滚有效结果。`ReferenceLookup` 和权威引用关系解析是补充操作，不参与状态推导。

### 6.6 Provenance 与数据完整性

- DiscoveryRun 结果能够追溯到领域条件、种子或直接引用原因；
- 元数据能够追溯到供应商 observation；
- 同一 MetaLiterature 内不同 Literature 的版本归属能够追溯到来源 observation 中明确的 `version_links`；
- 权威 Reference 能够通过 `ReferenceSupport` 追溯到供应商结构化关系或来源中的具体参考文献原文；
- 当前 PDF 能够追溯到获取来源并具有内容 hash；
- 当前 ParserResult 能够通过输入 Asset/hash、结果 hash 和 parser provenance 回溯来源；
- `LiteratureContent`、最终 metadata revision 和规范 Markdown 能够通过内容 hash、Markdown 字节 hash 和单一 Analysis provenance 共同追溯到 PDF hash、`ParserResult` hash、最终 metadata hash 和 LLM identity；Parser identity 由 ParserResult 自身的 provenance 保存；
- 已经提交的有效事实不因其它来源失败、运行中断或重复运行被无声破坏；
- 被判断为没有实际内容的 PDF 及其解析结果直接删除，不保存该候选的资产、来源、解析结果或候选级失败信息。

## 7. 查询与书目信息交换

查询和书目交换不是另一套文献模块。入口接收用户操作，文献管理决定业务含义，存储提供一致读取或写入。

### 7.1 查询

本地文献查询与外部元数据发现是两种不同操作。`LibraryQuery` 只读取当前统一逻辑文献数据库，不访问 Metadata Provider、不创建 `DiscoveryRun`、不执行 Parser/Analysis，也不修改数据库。`QuerySelector` 可以复用同一查询条件在补全开始时形成范围，但只复用条件本身，不复用用户列表读取的排序、分页或 cursor。

查询的主要读取关系为：

```text
LibrarySearchRequest(LibraryQuery + sort + page)
  -> LibrarySearchPage
       -> LiteratureSearchItem[]          # 每项是一篇具体 Literature
            -> literature_id
                 -> LiteratureDetail      # 单篇当前详情读取投影
                      -> Asset/ArtifactRef # 再交给独立 verified reader

LiteratureReferenceRequest(literature_id + direction + page)
  -> LiteratureReferencePage
       -> Reference + related LiteratureSearchItem + support_count
            -> reference_id
                 -> ReferenceDetail       # source + target + supports
```

搜索结果以具体 `Literature` 为单位，不按 `MetaLiterature` 折叠。多个供应商 observation 已经收敛到同一具体 Literature，因此不会制造多条结果；同一 MetaLiterature 下的预印本、作者接受稿和正式发表版是不同具体版本，可以分别出现并通过 `meta_literature_id` 归组。

`LiteratureSearchItem` 返回具体 Literature 的完整当前元数据、状态、metadata revision/hash、第一缺失步骤和人工 PDF 标记。`LiteratureDetail` 在一个一致的只读 snapshot 中进一步聚合当前 MetaLiterature 上下文、全部来源 observation、主 PDF 与补充资产、与当前主 PDF 对齐的 ParserResult、当前 LiteratureContent、其它版本以及本地权威引用数量。它和资产组合视图都只是临时、不可变的 read model：不建立数据库表、独立 ID、provenance、hash、revision 或写入生命周期，每次读取都从当前事实重新组装。

详情不嵌入 PDF 或规范 Markdown 的完整字节，也不无界嵌入全部权威引用边、ReferenceSupport、ProviderRelationObservation 或 DiscoveryRun 历史。主 PDF、Parser Markdown/资源和规范轻结构化 Markdown 都通过 Detail 中已经存在的 `Asset | ParserArtifactRef | ArtifactRef` 交给独立 verified reader；Detail 本身不执行 I/O。向用户文件导出时默认拒绝已有目标，只允许显式覆盖并使用原子发布。

references 与 cited-by 页面是同一权威 `Reference` 的正向和反向读取，不建立第二套边。普通关系列表只返回相关 `LiteratureSearchItem` 和 `support_count`；打开具体 `ReferenceDetail` 时才返回 source、target 和全部当前 support。参考文献原文已经在 MetadataObservation 或 LiteratureContent 中可见，support 只定位这些来源；详情中的引用数量和关系页面 total 只统计本地权威 Reference，不能冒充供应商报告的全网引用次数。

用户至少能够：

- 按标题、作者、年份、文献类型和稳定标识符查询；
- 在当前统一元数据和 `LiteratureContent` 中进行关键词与正文检索；
- 按 DiscoveryRun、Literature 状态和缺失步骤筛选；
- 筛选已经正常耗尽自动 PDF 获取能力、需要用户人工提供 PDF 的具体 Literature；
- 查看 `MetaLiterature`、全部 `Literature` 和代表文献；
- 查看来源差异、引用关系、引用关系形成依据和 DiscoveryRun 发现记录；
- 查看当前 PDF、`LiteratureContent` 的结构化章节和规范 Markdown；
- 从一篇文献沿参考文献或被引用关系继续浏览。

查询只读取当前统一事实，不重新执行身份判断、解析或分析。完全空的查询表示列出全部具体 Literature；筛选条件、组合语义、排序、分页、详情、引用读取和 artifact 引用边界的精确合同见 [Model 技术文档](technical/model.md#25-本地文献数据库查询与详情)。

### 7.2 书目信息导入

核心书目交换格式为：

- BibTeX/BibLaTeX；
- RIS；
- CSL JSON。

导入逐条把外部记录直接转换为现有 `LiteratureMetadata`，再组合为普通 `MetadataObservation` 交给文献管理；它不建立第二套导入元数据 schema。导入 observation 使用最小用户 provenance，表达“用户通过书目导入明确提供了这份元数据”。文献管理继续使用与供应商记录相同的保守身份规则：未命中时创建文献，命中且导入值补齐缺失字段或替换供应商当前值时形成 enriched，命中且当前统一投影不变时形成 matched；格式不合格、缺少最低识别信息或稳定标识符明确冲突时只拒绝该条。首次与 Provider 当前值相同的 matched 仍保存 user observation；只有已经存在相同规范化 user observation 的完全重复 matched 才不增加 observation。单条拒绝不撤销其它成功记录。

导入 observation 的非空书目信息在统一初始投影中优先于全部供应商 observations，供应商只能补齐它缺少的字段。导入 keywords 可以进入统一初始 metadata；完整 Analysis 仍根据全文形成最终 keywords。已经完成内容分析的 Literature 仍保存新的非重复导入 observation，但不立刻覆盖与当前 `LiteratureContent` 对齐的最终 metadata，只在下一次完整 Analysis 整体成功时更新当前视图。

导入 observation 的 provenance 固定表达用户书目导入，不追踪外部工具数据库 ID、本地附件路径、同步状态、私有插件字段、界面设置、用户笔记、外部集合层级、原始书目文件或导入批次历史。这些内容都不进入核心文献数据库。

### 7.3 书目信息导出

Literature 形成可转换的当前统一元数据后即可导出，不要求先获得 PDF 或 `LiteratureContent`。未达到 `CONTENT_READY` 的 Literature 导出当前统一初始元数据；达到 `CONTENT_READY` 后导出经 Literature 验收的最终元数据。

用户可以按收集、查询结果或明确选择导出。默认每个 `MetaLiterature` 导出一个具有当前统一元数据的代表 Literature，顺序为：

```text
正式发表版
  > 作者接受稿
  > 预印本
  > 其它版本
```

用户明确要求时可以导出全部可导出版本。单条记录无法转换时只跳过该条并说明原因。目标格式不能表达的字段必须明确说明，不能静默改成其它含义。

书目交换是文件级双向交换，不直接连接或同步 Zotero 等外部工具数据库，也不共享内部 ID 或同步状态。

## 8. DiscoveryRun 与数据库补全操作

二者都由入口与流程编排负责，但持久化边界不同：

| 概念 | 含义 | 生命周期 |
|---|---|---|
| `DiscoveryRun` | 一次领域搜索或引用扩展的冻结输入、来源结果、发现对象和原因 | 运行中追加已确认结果，完成后作为不可反推的发现 provenance 长期保存 |
| 数据库补全操作 | 从当前数据库范围补齐 PDF 或最终内容的一次调用 | Selector、目标、候选和 Report 只存在于当前进程，不形成运行历史 |

当前产品不建立 Collection。一次历史发现由 DiscoveryRun 表达，动态语义范围由本地查询表达，明确处理对象由 MetaLiterature/Literature ID 表达；系统不创建领域占位符，也不判断文献是否属于某个集合。未来 Zotero 式人工文件夹只有在形成独立产品需求后才设计。本地只读查询不保存为 DiscoveryRun，但可以成为本次补全的类型化 selector。

### 8.1 运行时范围与目标冻结

数据库补全请求由一个 `BatchSelector` 和一个 `BatchGoal` 组成。当前 selector 为：

1. `AllPendingSelector`：全库当前仍可自动推进的对象；
2. `DiscoveryRunSelector`：某次 DiscoveryRun 已接纳的对象；
3. `ImportReportSelector`：调用方从一次非持久化 ImportReport 明确重新提交的 MetaLiterature ID；
4. `QuerySelector`：类型化本地数据库查询；
5. `MetaLiteratureSelector`：明确选择的逻辑文献；
6. `LiteratureSelector`：明确选择的具体版本。

Selector 本身不保存，不混入目标、Provider、并发、Parser、LLM、强制重试或 cursor。`ImportReportSelector` 不引用 ImportRunId；同一进程可以直接使用 Report 返回的有序去重 ID，跨进程只有用户明确保存并再次提交这些 ID 时才成立，Entry 仍重新验证 ID 和 current facts。Entry 在一次一致读取中展开范围，排除已经满足目标或当前不能自动推进的对象，并把实际目标 tuple 冻结在当前进程内存。运行期间后来进入数据库、DiscoveryRun 或查询条件的文献不动态加入；重跑重新展开 selector 并依据当时的 current facts 形成新目标。

支持两个内容维护目标：

| 目标 | 含义 |
|---|---|
| `ASSET_READY` | 为尚无可用版本主 PDF 的 MetaLiterature，或用户明确指定的具体 Literature，执行 PDF 获取和基本检查 |
| `CONTENT_READY` | 从所选版本第一个缺失步骤继续，必要时补充主 PDF，再经 Parsing、Analysis 和 Literature 接纳形成最终内容；这是默认端到端目标 |

冻结目标后，已有 PDF 的 Literature 可以从自己的后续缺失步骤继续；缺 PDF 的当前具体 Literature 形成有界 acquisition cohort。每个 cohort 先让全部目标完成 Public 层，再让未解决目标完成 Authorized API 层，最后只把允许升级的最小剩余集合交给按风险组调度的 Browser。该层级屏障不改变冻结范围、不建立 BatchRun，也不要求较早获得并已提交 PDF 的目标等待 Browser 层结束后才能继续 Parsing/Analysis。

### 8.2 MetaLiterature 版本候选

普通全库、DiscoveryRun、导入和查询范围先按 `MetaLiterature` 去重。一个 MetaLiterature 只要已有任一成员达到所选目标，就不进入实际目标；系统不默认补齐全部版本。用户明确选择具体 Literature 时只处理该版本，不创建跨版本候选。

对于尚未满足目标的 MetaLiterature，Entry 在当前进程内冻结有序 Literature 候选。先按当前完成度复用：

```text
CONTENT_READY
  > 已有当前 ParserResult
  > 已有当前主 PDF
  > 没有上述结果
```

完成度相同才按代表版本顺序选择：

```text
published
  > accepted-manuscript
  > preprint
  > other
```

每个候选从自己的第一个缺失步骤继续；其中缺 PDF 的候选参加当前有界 cohort 的层级获取，已有 PDF 的候选直接进入后续步骤。只有 Acquisition 的全部适用 routes 正常结束、不存在 deferred/action-required/未解决 failure 并形成耗尽事实，或者 Analysis 明确 `NoUsableContent` 且该版本其它 PDF 候选已经耗尽时，才继续下一 Literature。Network/Storage 系统错误、Parser 失败、LLM 失败、Browser action-required、取消或无法判断只进入本次报告，不触发跨版本回退。成功的 PDF、ParserResult 和 LiteratureContent 始终归实际成功的具体 Literature；MetaLiterature 只通过成员 current facts 推导是否已有可用版本，不保存状态。

`AllPendingSelector` 默认排除需要 PDF 且已经具有自动获取耗尽事实的具体 Literature；当一个 MetaLiterature 的所有可用版本都已耗尽时，整个 MetaLiterature 不进入自动补全目标，而由 `needs_manual_pdf` 查询交给用户处理。用户以 `LiteratureSelector` 明确选择这个具体 Literature 并发起需要 PDF 的目标时构成明确重试，开始前清除耗尽事实；宽范围 selector 不自动清除。

### 8.3 运行报告

处理型 Entry 操作分别返回 `DiscoveryReport`、`DatabaseCompletionReport`、`ManualPdfReport`、`ImportReport` 或 `ExportReport`；它们组成判别联合但没有大而全的通用 envelope。纯查询直接返回 read result，不再套报告。PDF 获取、Parsing 和 Analysis 作为一次数据库补全中的内部阶段时，其 typed result、稳定失败和当前具体 Literature 归入同一个 `DatabaseCompletionReport`；未来只有出现独立用户操作时才需要新的操作特有 Report。

Report 只共享三种最终停止方式：正常走到边界、用户受控中断、操作级失败。正常结束允许 Provider、目标或记录局部失败，不增加 `PARTIAL` 通用状态；DiscoveryRun 继续使用自己的五态持久 status。数据库补全对实际冻结目标按达到目标、需要人工 PDF、失败、处理中断、尚未开始做不重不漏分区，并以单独的具体 Literature ID 列表说明本次发生过明确 `NoUsableContent` 清理而不保存候选细节；手动 PDF 报告接纳或拒绝；导入按记录报告并返回可形成 `ImportReportSelector` 的 MetaLiterature ID；导出区分原子发布、跳过、字段损失和未发布对象。CLI 摘要从这些精确结果计算，不另存一套 counts。

Report 不设置 ReportId、时间、持续时间、通用任务 status、自由 details 或日志数组，不进入 Catalog 或 ArtifactStore，不参与 Literature 状态、自动耗尽判断、版本回退或下一次 selector 展开。硬崩溃可以没有最终 Report；已经提交的当前事实仍然有效。

实时 Logging 与 Report 正交：模块日志是可过滤、可丢失的运行旁路，Entry Report 始终从 typed result 和稳定 failure 独立累计，不能解析日志反向生成。CLI 的稳定结果或 JSON 写 stdout，实时进度与诊断写 stderr；日志文案和字段不是公共业务合同。

### 8.4 局部失败、中断与重跑

- 不同内存目标可以在资源预算内有界并行；已有 PDF 的目标从后续缺失步骤推进，缺 PDF 目标按有界 cohort 的 Public → API → Browser admission 层级屏障推进；
- API 并发服从真实官方 quota scope；Browser 不同 risk group 可以并行，同一 group 固定串行并服从自己的文章间隔/window/cooldown；
- 一个目标提交主 PDF 后可以继续 Parsing/Analysis，不撤销其它未解决目标的层级屏障；
- 每个确认事实立即独立提交，局部失败不回滚其它目标或本目标已经确认的前序事实；
- 正常结束、普通失败或用户受控中断时，报告汇总截至当时已经完成和未处理的情况；
- `kill -9`、断电等硬崩溃可能没有最终报告，但已经提交的数据库事实继续有效；
- 重跑重新读取 current facts，不恢复旧 selector 展开结果、网络、候选、Parser、LLM、线程或队列现场；
- 数据库不可用、全部目标共同依赖的能力不可用或无法安全保存结果属于本次操作失败，不产生批次状态记录。

同一时间只允许一个会修改核心文献事实的补全操作。查询和书目导出可以读取已经完整提交的结果。目标与风险组并发不能让同一 Literature 跨层竞速，不能让单篇提前打开 Browser，也不能绕过 [ADR 0012](decisions/0012-process-local-provider-access-scheduling.md) 与 [ADR 0015](decisions/0015-publisher-aware-tiered-pdf-acquisition.md) 的进程内共享访问准入和 Browser group policy。

## 9. 需求对应

| 产品需求 | 主要设计响应 |
|---|---|
| R1 发起文献收集 | 入口与流程编排把领域搜索和引用扩展分别保存为有边界 DiscoveryRun；它不创建 Collection 或自动启动内容处理，供应商关系只有当前范围选中的目标接纳后才建立本地引用 |
| R2 多来源元数据搜索 | 领域 DiscoveryRun 对本次全部 Provider 按过滤前原始 item 分别执行 scan limit；文献管理保留满足标题或 DOI 最低条件的 observation、收敛身份并形成统一元数据，不对每条结果自动执行逐篇全源补查或元数据阶段语义过滤 |
| R3 文献资产获取 | Acquisition 先根据明确资产线索、稳定定位和实际 landing origin 形成访问方 Resolution/Plan，不按 publisher 或 metadata 来源硬编码；Public/API/Browser 严格升级和手动接纳都按实际字节、标准 PDF reader 和可读页面树执行最低文件检查；手动操作复制并保护用户原文件；全部适用 routes 正常耗尽时保存最小 `needs_manual_pdf` 当前事实，临时错误或 Browser action-required 不冒充耗尽 |
| R4 文献解析 | Parsing 通过可替换 Parser 生成规范化 Markdown `ParserResult`，保留实际引用资源、输入/结果 hash 与 parser provenance，并只维护一个当前结果 |
| R5 语言模型内容判断与总结 | Analysis 用一次有序两阶段逻辑分析先判断属于当前 Literature 的实际内容并确定最终元数据与关键词，再以该元数据为上下文生成和解析 Markdown 字符串章节与有序参考文献；Literature 整体接纳单一当前内容并以统一“未提供”缺失值确定性渲染规范 Markdown |
| R6 文献数据库 | 所有操作从当前逻辑文献数据库出发并把确认结果提交回同一数据库；DiscoveryRun 保存发现 provenance，数据库补全只保存确认的文献事实和自动获取耗尽，Catalog + ArtifactStore 提供稳定引用、逐阶段保存和一致查询 |
| R7 书目信息导入与导出 | 入口、文献管理和存储共同提供三类书目格式的逐条导入导出；导入复用 MetadataObservation、用户非空值优先且不保存过程历史，导出不要求全文完成 |
| R8 大批量处理 | 入口与流程编排从运行时 selector 在内存冻结目标、按 MetaLiterature 选择具体版本并只在稳定缺失时回退；缺 PDF 目标按有界 cohort 先 Public、再 API、最后最小 Browser 集合，不同 Browser group 并行而同组串行；逐目标事实与失败仍隔离，报告、中断和重跑不保存批次运行历史 |

## 10. 文档责任

- [产品需求](requirements.md)定义用户问题、核心能力、产品结果和验收标准。
- 本文定义整体框架、十个模块、数据流、事实所有权和用户可观察的协作语义。
- [架构决策](decisions/README.md)保存长期有效的关键选择及其理由。
- [技术文档](technical.md)把本文映射为代码目录、依赖、Ports、持久化和运行技术。
- README、用户指南、源码和测试说明当前已经实现的行为，不得把本文中的目标架构写成已经发布的能力。
