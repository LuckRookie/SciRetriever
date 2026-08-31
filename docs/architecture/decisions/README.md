# 架构决策索引

ADR 记录已经接受并会长期约束后续设计的重要选择。ADR 不替代产品需求、设计文档或当前实现文档，也不保存实施进度。

## 权威顺序

1. [产品需求](../requirements.md)定义用户问题、核心流程、产品结果和验收标准。
2. 本目录的 ADR 在各自适用范围内约束后续设计，不得反向修改产品需求。
3. [设计文档](../design.md)在需求和已接受 ADR 的边界内推导系统架构、模块命名、数据流、所有权和设计取舍。
4. [技术文档](../technical.md)把设计映射为代码目录、依赖、端口、持久化和运行技术。
5. 项目 [README](../../../README.md)、源码和测试说明当前实现。

当这些文档发生冲突时，先按主题找到唯一责任文档，而不是让更具体的技术细节反向覆盖产品需求。

## 当前 ADR

| ADR | 状态 | 负责主题 | 不负责 |
|---|---|---|---|
| [ADR 0001：范围与数据边界](0001-sciretriever-scope-and-boundary.md) | Accepted | 通用文献边界、引用以外不建立通用关系图谱、资产证据、总结型轻结构化文档和领域数据下游化 | 身份模型、parser、schema、交互方式 |
| [ADR 0002：多来源文献身份与增量处理](0002-literature-identity-and-incremental-processing.md) | Accepted | MetaLiterature/Literature 内部身份、官方文献标识符表达、Provider record identity 边界、保守身份与冲突关闭、version_links 身份证据、单一版本成员归属、Literature 内作者署名、供应商与用户导入的长期 observations、导入优先的单一当前 LiteratureMetadata、阶段独立提交和单机增量补全 | 产品目标、各 namespace 的底层 parser、物理 schema、PDF/LLM 语义、全局作者分析 |
| [ADR 0003：Operator-managed MinerU PDF parser adapter](0003-operator-managed-mineru-service.md) | Accepted | 当前 MinerU adapter 的服务所有权、验证、provenance 和 parser-neutral 输出边界 | 核心产品需求、唯一 parser 选择、额外 LLM 分析 |
| [ADR 0004：产品需求与派生设计的责任边界](0004-requirement-led-literature-collection.md) | Accepted | 需求、设计、ADR、技术文档和当前实现的文档职责 | 具体设计方案 |
| [ADR 0005：DocumentPackage 2.0 不兼容合同](0005-document-package-2-breaking-contract.md) | Superseded by ADR 0008 | 已撤销的 Package 2.0 历史合同 | 当前目标设计 |
| [ADR 0006：由 LLM 形成 LiteratureContent 与文本参考文献](0006-llm-produced-literature-content.md) | Superseded by ADR 0008 | 旧 LiteratureContent 内容形状的历史决策 | 当前内容合同 |
| [ADR 0007：参考文献解析与权威引用关系](0007-reference-resolution-and-authoritative-relations.md) | Accepted | 逐边 ProviderRelationObservation、来源原文、临时 ReferenceLookup、选择性目标物化、Literature 级 Reference 和三类 ReferenceSupport | 供应商协议细节、物理表结构和已撤销的 Package 投影 |
| [ADR 0008：LLM 总结型 Markdown LiteratureContent](0008-summarized-markdown-literature-content.md) | Accepted，按 ADR 0017 修订 | 先元数据后正文的两阶段 LLM 分析、两道 PDF 验收边界、NoUsableContent、固定标题/“未提供”/有序参考文献、Markdown-string LiteratureSection、单一当前 LiteratureContent、内容/字节 hash、单一 Analysis provenance、Analysis 业务所有权和旧 Package 撤销 | 中性 Agents provider/runtime 基础、分块算法和 Storage 物理实现 |
| [ADR 0009：供应商级全局访问调度](0009-provider-scoped-global-access-scheduling.md) | Superseded by ADR 0012 | 旧同机跨进程 Access Coordinator 与持久化运行协调边界 | 当前访问调度 |
| [ADR 0010：Parser-neutral Markdown 与单一当前解析结果](0010-parser-neutral-markdown-current-result.md) | Accepted | ParserResult 的 Markdown/artifact/provenance 合同、实际引用资源、单一当前结果替换、Parser 私有过程文件和无逐段 locator 边界 | 具体 Parser 协议、缓存额度、多模态 Analysis 和当前实现状态 |
| [ADR 0011：以文献数据库为中心的增量维护](0011-literature-database-centered-incremental-maintenance.md) | Accepted | 统一逻辑文献数据库作为产品中心、当前事实驱动的增量操作与恢复、Catalog/ArtifactStore 边界和第二真相源禁令 | 具体表结构、物理目录、备份、缓存和未确认的新产品能力 |
| [ADR 0012：进程内供应商访问调度](0012-process-local-provider-access-scheduling.md) | Accepted，按 ADR 0015 修订 | 当前进程共享准入、provider/channel scope、Provider policy、内存运行状态和非跨进程边界 | 易变供应商数值、具体 endpoint、产品额度和当前实现状态 |
| [ADR 0013：外部发现与数据库补全解耦](0013-decoupled-discovery-and-database-maintenance.md) | Accepted，按 ADR 0015/0019 修订 | 最小且持久化的 DiscoveryRun、逐 Provider 原始扫描边界、无 Collection/ImportRun 的进程内数据库补全、运行时 selector 与目标冻结、三种推进目标、ImportReportSelector、自动 PDF 获取耗尽、操作特有的非持久化 Report、Report/Logging 分离、Logging 公用基础模块边界、MetaLiterature 版本回退和手动 PDF 接纳 | 具体 CLI 语法、Report 技术字段、Logging 格式、物理表字段、供应商协议和当前实现状态 |
| [ADR 0014：按能力接入 Provider 与本地凭据管理](0014-capability-scoped-providers-and-local-credentials.md) | Accepted，按 ADR 0021/0022 于 2026-08-31 修订 | Metadata/Acquisition 两类非互斥 Provider 能力、证据驱动原文路由、用户级 credentials.toml、capability owner 就近管理凭据、离线状态与显式连通性测试 | Source Auto/Custom 与逐 Source limit、Model Provider/Model 注册表与任务选择、易变 endpoint/认证字段、当前实现状态和具体文献 entitlement |
| [ADR 0015：访问方感知的三级 PDF 获取与 Browser 调度](0015-publisher-aware-tiered-pdf-acquisition.md) | Accepted，按 ADR 0016/0017 于 2026-08-26 修订 | Publisher access resolution、Profile 三态准入与 capability 分离、三级风险升级、层级 cohort、官方 API policy、一个 operator-managed 持久身份 Profile/共享有头 process-context、Browser 组间并行/组内限速串行、作业级 Rules/Agent 二选一、升级与 operation-local 熔断边界 | 单个 Provider 的易变 endpoint、selector、速率数字和当前实现状态 |
| [ADR 0016：CloakBrowser 固定身份 Browser runtime 与验证页资源边界](0016-cloakbrowser-fixed-identity-runtime.md) | Accepted，2026-08-26 修订 | CloakBrowser 单生产 runtime、固定 Profile 设备身份、Linux/Xvfb persona、binary/Profile 生命周期、受限 challenge dependency、统一 Challenge 页面合同与无兼容层切换门 | 具体 binary 版本、单个 Provider marker、实际 entitlement、登录/机构选择/MFA |
| [ADR 0017：无状态共享 Agents 与受控 Browser Controller](0017-shared-agents-and-controlled-browser-agent.md) | Accepted，按 ADR 0019/0021 于 2026-08-28 修订 | Provider-neutral 无状态单次 Agents Runtime、独立 Analysis/Browser role、消费模块 controller 所有权、Rules/Agent 作业级二选一、统一 Browser Observation、六种封闭动作和自然终态 | Model Provider/Model 配置所有权、具体 SDK/transport、文献 prompt/schema、Publisher 规则、任意 Browser/CDP 接管、长期 Agent memory |
| [ADR 0018：固定用户级普通配置文件](0018-fixed-user-configuration-home.md) | Accepted | 唯一 `~/.sciretriever/config.toml`、Configuration 路径所有权、CLI/人工编辑、安全发布与旧配置人工迁移 | 普通配置字段、secret schema、项目级配置继承、当前实现状态 |
| [ADR 0019：Agent 可编排应用边界与 SDK 驱动模型运行时](0019-agent-operable-application-and-sdk-model-runtime.md) | Accepted | 外部 Agent 控制面、Entry/MCP/Skill 边界、第三种解析目标、PydanticAI Direct 首选实现、SDK Network transport gate 与 LangGraph 延后条件 | 具体 MCP schema、SDK 版本、远程多租户服务、当前实现状态 |
| [ADR 0020：可复用 Model Profile 与任务级绑定](0020-reusable-model-profiles-and-task-bindings.md) | Superseded by ADR 0021 | 已撤销的 Model Service/Profile 配置合同 | 当前 Provider/Model 注册表与任务直接选择 |
| [ADR 0021：Provider、Model 注册表与任务直接选择](0021-provider-model-registry-and-direct-task-selection.md) | Accepted | Provider 的 API/endpoint/exact-origin key、`provider/model` Model 的 reasoning/image、Analyze/Download 直接选择、模块派生 capability/limits、自动有界模型目录与无旧 schema 兼容层 | 模型协议或 SDK 具体实现、Analysis/Browser workflow、长期 Agent 状态、远端 capability 自动证明 |
| [ADR 0022：默认安全 Source 选择与逐 Source 扫描上限](0022-default-safe-source-selection-and-per-source-limits.md) | Accepted | Metadata/Acquisition 的 Auto/Custom、版本内置默认安全集合、Custom 精确顺序、逐 Source raw-item limit、有效 Source resolver 与旧 discovery schema 删除 | Provider adapter 协议、在线可用性、凭据内容、具体 Literature route 适用性、Browser enablement |

## 阅读方法

1. 所有产品或架构讨论先读[产品需求](../requirements.md)。
2. 检查是否存在约束当前问题的 Accepted ADR。
3. 讨论系统架构、整体数据流和模块责任时读[设计文档](../design.md)。当前 ADR 的主题为：
   - 领域边界、资产证据或下游集成：ADR 0001；
   - 文献身份、版本和增量补全：ADR 0002；
   - MinerU parser service：ADR 0003；
   - 文档责任和需求/设计分离：ADR 0004；
   - ADR 0005 和 ADR 0006 只用于理解被替代的历史合同；
   - 参考文献解析、目标接纳与权威引用关系：ADR 0007。
   - 先元数据后正文的两阶段分析、总结型 Markdown、固定章节、最终元数据和当前 LLM 边界：ADR 0008。
   - ADR 0009 只用于理解已撤销的同机跨进程协调边界。
   - Parser-neutral Markdown、资源、provenance、当前结果替换和缓存边界：ADR 0010。
   - 文献数据库中心、当前事实驱动的增量维护和恢复：ADR 0011。
   - Provider/API/网页访问限速、进程内共享准入和内存运行状态：ADR 0012。
   - 外部发现、进程内数据库补全、多版本选择、自动 PDF 获取耗尽、运行报告边界、Logging 公用基础模块、手动 PDF 接纳和当前不建立 Collection：ADR 0013。
   - Provider 能力分类、全面 adapter 目标、出版社与聚合来源解耦、本地凭据文件和配置/连通性命令：ADR 0014。
   - 访问方画像与运行时计划、Public/API/Browser 风险升级、官方 API policy 和 Provider-scoped Browser 调度：ADR 0015。
   - CloakBrowser 固定身份、binary/Profile 生命周期、受限验证资源和统一 Challenge 页面合同：ADR 0016。
   - Analysis 与 Browser 的无状态共享 Agents Runtime、消费模块 controller 和受控 Browser 二选一：ADR 0017。
   - 唯一用户级普通配置文件、配置路径所有权和旧配置迁移：ADR 0018。
   - 外部 Agent 编排、Entry/MCP/Skill、解析目标、SDK 驱动模型运行时和 Network transport gate：ADR 0019。
   - ADR 0020 只用于理解已撤销的 Model Service/Profile 配置合同。
   - Provider/Model 注册表、Model 自有 reasoning/image、Analyze/Download 直接选择、模块派生调用合同、自动模型目录与旧 schema 严格拒绝：ADR 0021。
   - Source Auto/Custom、默认安全 catalog、Custom 冻结列表、逐 Source metadata limit 与旧 `[discovery]` 删除：ADR 0022。
4. 讨论代码组织、持久化、外部访问和具体运行机制时再读[技术文档](../technical.md)。

尚未接受的设计放在讨论或活动提案中，不得提前写成 Accepted ADR。完成、拒绝或被替代的讨论材料进入 `docs/archive/`，不参与当前架构解释。
