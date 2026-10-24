# SciRetriever 架构原则

类型：规格
负责：跨模块不变量与架构审查原则
状态：现行

本文把[产品需求](requirements.md)和[架构决策](decisions/README.md)转换为实现与审查时长期遵守的原则；2026-09-25 已按 [ADR 0026](decisions/0026-agent-knowledge-and-human-collaboration.md)同步科研 Agent 知识与人类协作方向。它不替代[设计文档](design.md)，也不提前决定尚待讨论的 schema、算法、进程模型或用户界面。

## 1. 统一文献库是事实基础

科研知识供给是产品目的，统一逻辑文献数据库是事实中心。Agent 与人类必须读取同一文献身份、来源、材料与派生知识；Configuration、执行、模型、索引和 UI 不形成第二真相源。

按 [ADR 0032](decisions/0032-library-centered-web-workspace.md)，文献库也是 Web 的主空间；获取、解析、分析与检索等能力围绕文献及明确范围组织，不以固定处理管线替代库。保存视图、活动和主题等 UI 投影不新增文献事实，其持久化仍须明确 owner 和合同。

操作从意图和当前事实出发，复用有效结果；查询返回一致、有界投影，不修改数据或隐式生成知识。Catalog 保存关系，ArtifactStore 保存不可变字节，各事实业务含义仍由所属模块决定。

模块重要程度、数据依赖和业务所有权分别表达。PDF 获取需可靠交付真实材料；分析、总结与提取依赖材料合同，不依赖下载流程或 Browser 状态。整体架构完整设计各项能力，不因强调某个模块而重置产品目标。

### 1.1 发现、材料与分析保持分离

发现保留有边界的输入、来源结果和发现原因，不自动全文处理。获取、解析与读取独立可用，Analysis 只有在明确请求时执行。检索/阅读已有结果不隐藏下载、模型成本或用户文件写入。

普通范围依既有 MetaLiterature/版本规则冻结目标，前序有效事实独立提交；稳定缺失才触发规定的版本回退，网络/模型失败不代表材料不可用。新知识产物按用途与输入绑定，不要求全部文献达到一个总完成态。

查询与扩充具有独立操作边界（[ADR 0028](decisions/0028-query-and-expansion-separation.md)）。空结果/材料或知识缺失只能形成读取反馈，不能发起外部发现、获取或补库 Job。用户明确开启一次元数据/PDF 扩充任务后，任务内部可以自动批量执行；读取预算或分析目标不构成扩库授权。已有材料的加工是显式维护操作，不是查询副作用。

运行报告、实时日志与权威事实分开。durable 执行控制、人类介入记录和历史保留只按已明确范围设计；不借知识架构扩张为无限任务/页面历史。

## 2. 需求先于实现

系统主要服务科研 Agent 的原始材料供给与知识压缩，也提供以文献库为中心的独立完整 Web，让人类操作、配置、观看并自愿介入 Browser、读取材料与总结。阅读器细节、后台存续、长期回放未定时保留边界，不从既有 Web/Jobs 反推需求。

先明确用户结果，再确定责任、状态与失败，最后选择具体实现。新目标不能只写入 plans；requirements/Accepted ADR/design/technical 分别拥有需求、决定、设计和技术约束，README/源码/测试反映已实现事实。

## 3. 领域边界

核心范围包括通用文献身份/元数据、原始资产、可读表示、稳定证据、有证据的多粒度知识、检索/上下文、调用方规范下的提取交付和必要来源/处理信息。

Analysis 可以比较指定文献的共识、分歧、条件与局限，但不承担整个科研 Agent 的研究规划；领域 schema 与含义归调用方，候选按 ADR 0027 的独立提取产物合同交付，不加入文献固定字段；通用证据不是任意领域知识图谱。书目交换保留兼容并降低主线优先级。

## 4. 来源事实不能丢失

元数据供应商返回的记录和带来新来源事实的用户书目导入记录都先作为独立、不可变的 `MetadataObservation` 长期保存，再形成统一文献视图。一个 `Literature` 可以关联多个 observation；新来源观察增加新对象和关联，不能原地覆盖既有 observation，重复导入相同规范化内容也不能制造重复 observation。一个来源不能无声覆盖另一个来源，合并规则变化时应能够从保留的事实重新计算。

每个 Literature 只维护一份当前 `LiteratureMetadata`。建档前，它由关联 observations 确定性形成：用户导入 observation 的非空书目信息优先，按配置排序的供应商 observations 只补齐缺失字段。建档的元数据步骤按字段裁决来源（人工、权威来源、校订稿，见 [ADR 0037](decisions/0037-literature-archive-and-proofread-text.md)），记录冲突与锁定；用户导入的非空值继续保留。旧统一元数据不保存为历史 revision；`metadata_revision` 只标识当前值的变化，服务 stale 复检与描述版本。模型提议不是新的 MetadataObservation，来源 observations 始终继续保留。

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

已接纳原始资产不可原地修改，保留来源、hash、关系和规范相对引用。解析表示是派生数据，模型输出是解释，不能混作原始文件。

手动 PDF 明确绑定具体文献，复制而不移动/修改用户原件，并执行统一基本检查；Browser 中人工取得的文件仍经过该路径的文章归属验收。原始材料不因某次分析不适用、部分解析或模型失败而自动删除；错误文件/错误文章的拒绝、失效和删除必须走独立明确业务规则。旧 NoUsableContent 清理属于待修订实现，不反向改变此目标。

文件 create-if-absent 发布，同路径不同字节保留冲突并拒绝覆盖；损坏通过明确恢复处理，不手工改字节伪造来源。

## 7. 轻结构化文档保持通用、总结型和可追溯

知识产物按概览、详细分析、问题相关或范围内综合表达明确用途/粒度，绑定输入版本、生成方法和证据。当前结果合同见[知识加工](technical/05-knowledge-processing.md)，不维护旧总结兼容格式。

压缩非无损：保留影响结论的条件、否定信息、数值/单位、局限、分歧和覆盖。证据引用可定位与解释被证据支持分开验证，不用模型自评置信度替代证明。

支持摘要→片段→章节/原始材料展开。有效产物引用的文档表示不能静默回收或重新定位；版本保留、明确失效和重生成规则由业务生命周期决定，不默认无限历史。

## 8. 阶段结果独立提交

获取、解析、文档表示和分析各自产物完整验证后独立发布；局部失败不撤销前序有效事实。文件先按不可变规则发布，关系在短事务内确认，提交前复核输入绑定，避免过期结果错配。

原始来源、当前文献身份/元数据与原始文件继续可靠保存。新证据/分析产物可重建但不能据此忽略有效引用；当前默认关系更新、引用失效/保留及回收必须一致。

参考文献的 ReferenceSupport 随文档版本更新（ADR 0007、ADR 0037），新科学证据引用不得直接套用文献引用边的删除规则。索引重建不覆盖事实，任务成功必须有业务结果支持。

批量冻结实际范围并有界推进。Public/API/Browser cohort 及共享访问准入不变；取消停止新工作，已在途与已提交结果如实记录；重启根据当前事实恢复，不重放旧 Browser/网络现场。

## 9. 外部访问必须在进程内共享受控

Provider 只分为 Metadata 与 Acquisition 两类不互斥能力；领域搜索、稳定标识符 lookup 和可选引用查询都属于 Metadata，不建立第三类 Citation Provider。领域发现调用本次全部已启用、生产 adapter 已实现且 readiness 通过的 Metadata search 能力，不按 publisher 预分流，也不因目标 Provider 范围完整就对每篇结果盲目执行逐来源补查。

Acquisition 优先解释明确 AssetHint、来源稳定定位、Provider record identity 和 DOI 安全解析后的 landing origin，形成当前运行的访问方 Resolution 与分层 Plan；MetadataObservation 来自哪个聚合服务、publisher 自由文本或单独 DOI 前缀都不能证明全文归属。Route 只有在生产实现、用户启用、policy/readiness 和当前 Literature 适用性都满足后才调用；配置、认证、权限和系统错误不能伪装成正常 PDF 耗尽。精确目标与路由见 [ADR 0014](decisions/0014-capability-scoped-providers-and-local-credentials.md)和 [ADR 0015](decisions/0015-publisher-aware-tiered-pdf-acquisition.md)。

所有外部 HTTP、redirect 和浏览器操作都必须经过当前 SciRetriever 进程中由 Network 提供的共享访问准入。Provider adapter 负责声明和解释供应商政策，Network 按 provider、访问通道、必要的 API service 和实际 host，在当前进程的全部模块、用户操作和文献目标之间执行并发、间隔、周期额度、冷却和 `Retry-After`。功能模块、vendor SDK 和页面流程不得各自建立互不知情的限速器或直接绕过准入。

自动 PDF 获取严格按 Public、Authorized Provider API、Controlled Browser 升级；Planner 可以删除不适用 route，但不能自动提前 Browser。公开协议和 API 按对应官方 quota scope、并发、间隔、window、周期额度与 `Retry-After` 执行。Browser 保留 `browser-generic` 聚合政策，另按当前已准入平台约束网络活动：同平台限一篇，网络真实结束后冷却 30 秒，不同平台可由独立 worker 推进；保留会话、决策 worker、平台资格和文件责任分别结算。operator 只能收紧 baseline、window、cooldown/circuit，平台归属不成为 Publisher 点击策略。普通 HTTP、API 和 Browser 都经过当前进程共享的 Network 准入，具体 API 易变数值由 Provider Notes 维护，长期边界见 [ADR 0012](decisions/0012-process-local-provider-access-scheduling.md)、[ADR 0015](decisions/0015-publisher-aware-tiered-pdf-acquisition.md)与 [ADR 0023](decisions/0023-generic-browser-agent-executor.md)。

受控 Browser 以 [ADR 0016](decisions/0016-cloakbrowser-fixed-identity-runtime.md) 的 CloakBrowser patched Chromium 作为唯一目标生产 runtime，同时继续使用 Playwright API 作为内部控制协议。一个长期 Profile 必须复用固定设备身份、一个有头 process/context 和服务器原始出口；`browser-generic` 聚合政策、同平台网络资格、CONNECT、origin/DNS/host admission、实际资源保护和统一 PDF 验收不因 runtime 切换而放宽。经证据确认的 challenge dependency 只能在发起页面、frame ancestry、当前文章网络资格和页面生命周期内加载；Challenge 与普通页面使用同一 Observation、动作和 capture 合同，本地资源阻断不能冒充页面拒绝或 Agent 失败。Browser Agent 可以在当前文章获准的页面 surface 中操作可见控件，但不能借此取得任意 Browser/URL/脚本、切换身份或出口、外包验证、自动登录、选择机构或处理 MFA。

按 [ADR 0031](decisions/0031-dsh-backed-agent-capabilities.md)，DSH/Cordis 是 `agents` 的唯一执行基础，统一承接单次模型调用、受控会话、工具循环与上下文管理；中性 role/message、配置绑定、capability/readiness、协议转换及稳定失败由项目适配边界维持。普通推理和压缩共用 Configuration/Credential 与 Network，按实际请求准入和计量；原 AgentRuntime 名称只保留为同一实现的兼容入口。Analysis 继续拥有文献 prompt、各用例处理顺序、schema 和结果验收；Browser/Acquisition 继续拥有文章目标、页面与控制版本、允许动作、下载归属与文件接纳。临时对话历史服务于本次能力执行，不成为跨任务长期 memory、持久化页面现场或文献事实。Agent 不获得 Page、Context、CDP、Cookie、任意 URL/selector/JavaScript 或事实写入能力。既有唯一通用 Browser、Network 准入、ADR 0029 的 PDF 未验证标签与 ADR 0030 的捕获/发布分工继续有效。

等待队列、permit、窗口计数、`next_allowed_at`、`blocked_until` 和当次 `Retry-After` 是当前进程的内存运行状态，不是文献事实，不保存到 Catalog、ArtifactStore、provenance 或独立协调文件，也不参与状态推导。进程结束后这些动态状态自然清空；静态访问政策和 operator 收紧值仍由配置表达。

Provider secret 只存在于当前用户的固定 `~/.sciretriever/credentials.toml` 和被 Bootstrap 注入的 adapter 当前进程内存中，不属于普通配置 Model 或文献数据库。`config status` 是纯本地检查；用户显式执行的 `config test` 仍服从统一 Network，但测试结果和时间不持久化，也不能把认证成功解释为任意文献的全文 entitlement。Harness、CI 和离线验收只使用临时凭据文件与 fake Network。

## 10. 单机不等于跨进程限速

产品运行边界是个人单机工具，不要求跨机器协调或分布式任务所有权，也不保证多个 SciRetriever 进程共享供应商限速。每个进程由 `sciretriever.bootstrap` 构造自己的共享 Access Coordinator；多个进程同时运行或进程快速重启时，冷却和额度窗口不会延续。Storage 为保护同一 Catalog 而实施的本机写入互斥是独立的数据库完整性机制，不能与 Network 访问调度混为一体。

## 11. 一个事实只有一个写入所有者

设计文档必须为每项权威业务事实指定唯一写入所有者。其它模块通过明确合同读取或请求修改，不复制第二份权威状态。

## 12. 导出实现不是产品边界

任何当前导出实现都不定义产品边界。ADR 0005 的 `DocumentPackage` 2.0 目标合同已经由 [ADR 0008](../archive/decisions/0008-summarized-markdown-literature-content.md) 撤销；当前产品不实现、读取或迁移该格式。未来若出现完整离线快照需求，必须先确认消费方和公开合同，再以新 ADR 重新版本化设计，不能恢复过时合同。

任何下游集成都必须使用文档化的稳定标识符、hash、provenance 和领域中立表示，不得直接依赖内部数据库表。

## 13. 人类与 Agent 共享能力，控制权有唯一 owner

人类配置、真实 Browser 全程观看/指导、材料与知识阅读是正式能力。UI 只展示与提交意图，配置由 Configuration 管理、操作由 Entry 编排、动作权由运行时裁决，知识读取共用领域服务。

同会话动作互斥，指导绑定文章/流程并在安全决策点消费；接管阻止后续旧动作，交还重新观察，在途请求按实际结果处理。人类取得文件仍统一验收。实时全过程可观察不自动等于永久录像或完整事后回放。

观看不改变控制权；直接点击/输入可以触发接管，但必须先由服务端确认控制权和当前页面绑定。自动获取不以人工响应为前提，无人介入时仍按真实结果结束；界面精简不合并正常耗尽、临时失败、取消与未尝试，也不默认离开画面即可安全恢复 Agent。

## 14. 检索与上下文是有界读取

未分析材料可查询；结果明确原始/解析/生成内容、输入版本、来源、覆盖和截断。索引可重建，相关性不等于真实性；读取没有隐式生成，增量处理须显式表达成本和副作用。

## 15. 通用提取能力与领域策略分离

按 [ADR 0027](decisions/0027-extraction-capabilities-and-caller-defined-records.md)，记录含义与结构由调用方定义；SciRetriever 提供材料/证据、规范绑定及通用交付能力。外部策略可替换，提取不依赖通用总结或内部模型。结构通过、证据可解析与领域接纳分别表达；候选不自动成为文献事实或训练数据。具体接口以[统一产品接口：共享合同、结构解析与版本兼容](technical/01-product-interface.md#6-共享合同结构解析与版本兼容)继续设计。

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
- [ ] Acquisition 是否统一检查 PDF 字节、可读性和适用的文章归属证据；分析不适用、部分解析或失败是否不会单独触发已接纳材料删除？
- [ ] 旧七标题兼容格式的缺失内容是否仍统一使用“未提供”；新知识产物是否准确表达缺失、不确定与覆盖，不把缺失标记当作证据？
- [ ] 多用途知识产物是否按用途和输入版本区分，更新是否保留有效证据；参考文献支持随文档版本更新时是否保持“每条 Reference 至少一项支持”？
- [ ] 是否保护来源与原始材料，并为派生表示明确保留/失效/回收规则，避免以可重建为由无声断开有效引用？
- [ ] 解析材料是否无需分析即可读取，知识要点是否能展开到正确版本的证据，检索是否如实表达预算、覆盖和截断？
- [ ] 人类是否观察同一生产 Browser，指导是否绑定当前流程，接管/交还是否阻止旧动作并重新观察？
- [ ] Agent 与人类是否共享业务语义，并明确区分读取、生成、材料与模型解释？
- [ ] 所有外部访问是否经过当前进程的 provider/channel/host 共享准入，网页独占与冷却是否覆盖普通 HTTP 和浏览器，API 是否遵守对应供应商规则？
- [ ] 生产 Browser 是否只使用一个固定身份 CloakBrowser Profile/process/context，且没有 stock runtime fallback、随机设备身份、环境代理或绕过 CONNECT/Network guard 的第二执行路径？
- [ ] Challenge 必需资源是否只在已核实 Publisher、frame ancestry、当前文章 permit 和页面生命周期内加载；Challenge 是否使用统一 Observation/Action，且本地阻断没有冒充页面拒绝或 Agent 失败？
- [ ] 单次调用与持续会话是否统一进入 DSH 并共享配置和 Network，消费模块是否仍掌握业务 workflow、prompt、工具语义与结果验收；Browser 控制版本、封闭动作和下载交接是否由原 owner 强制执行？
- [ ] Provider secret 是否只来自固定 owner-only 凭据文件并保持在适配边界；status/test 是否不泄漏或持久化 secret/测试结果，离线门禁是否没有真实联网？
- [ ] 限速是否在当前进程的模块、用户操作和文献目标之间共享，且全部动态状态只留在内存，没有污染业务 Model、Catalog、ArtifactStore、provenance 或 Literature 状态？
- [ ] 外部 provider 和 parser 输出是否在边界验证并转换为中性合同？
- [ ] 局部失败是否保留其它已提交结果并允许后续补全？
- [ ] 是否为每项持久化事实指定唯一写入所有者？
- [ ] 是否把单机边界错误扩大成未经讨论的进程或调度方案？
- [ ] 是否避免恢复已撤销的 `DocumentPackage` 2.0；未来快照需求是否重新确认公开合同和版本影响？
