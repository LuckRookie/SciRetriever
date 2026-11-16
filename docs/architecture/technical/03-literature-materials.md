# 03 · 文献与材料技术设计

类型：规格
负责：文献身份、元数据与材料接纳；technical 中早期形式化接口（获取结果）
状态：现行；目标接口单独成节

[设计总览](../design.md) · [九模块技术导航](../technical.md)

本模块对应设计中的 **③ 文献与材料**，交付身份与来源清楚的文献记录，以及经过文件和文章归属验收的原始材料。

内部划分为 Metadata 元数据来源、Literature 文献管理、Acquisition 材料获取。前者提供 observation，文献管理裁决身份和书目事实，获取子模块裁决资产接纳；⑦执行持久化。需要页面操作时调用⑧，取得材料后向④⑤⑥交付稳定引用。

获取成功不以分析完成为前提。来源错误、运行失败与正常耗尽分别表达，后续分析不适用不授予删除材料的权限。旧 completion 清理行为在对应兼容小节说明。

> 当前实现已采用 [ADR 0037 第二版](../decisions/0037-literature-archive-and-proofread-text.md)：双元数据字段、字段来源/锁定与六种建档状态。源码和离线实现已接入；真实旧库仍须在授权副本上转换，不能据此宣称已经切换。

本篇目录：

- [1. 模块边界与连接](#1-模块边界与连接)
- [2. 文献身份、元数据与引用](#2-文献身份元数据与引用)
- [3. 元数据来源与供应商适配](#3-元数据来源与供应商适配)
- [4. 材料获取、路线与候选](#4-材料获取路线与候选)
- [5. 资产验收、发布与有效性](#5-资产验收发布与有效性)
- [6. 书目交换与持久化协作](#6-书目交换与持久化协作)
- [7. 材料与文献验证](#7-材料与文献验证)
- [8. ADR 0037 目标形态：元数据字段与文献状态](#8-元数据字段与文献状态)
- [9. 目标接口（尚未实现）](#9-目标接口尚未实现)

## 1. 模块边界与连接

任务② → 本模块；按需使用浏览器⑧，经存储⑦发布；文档④、知识⑤和查询⑥读取稳定材料引用。

本篇按职责归并已有详细合同；示例中的现有类型与目标类型保持各自状态。文档归属不改变源码目录、事实所有权或当前公开 API。

## 2. 文献身份、元数据与引用

### 2.1 文献身份与知识产物的责任分离

Literature 拥有身份、来源 observation、统一元数据和权威引用。Document 拥有固定校订表示与证据读取；Analysis 拥有算子结果，Extraction 拥有外部提取候选校验。几者共享稳定 Literature/Material/Document ID，不互相复制事实。

### 2.2 结构与实现映射

`identity.ts`、`identity-rules.ts` 执行保守身份接纳；`metadata-service.ts`、`metadata-fields.ts` 处理字段来源、冲突与锁定；`archive-metadata.ts` 从校订稿提议元数据；`archive-references.ts` 接纳引用支持；`state.ts`、`query.ts` 只读投影。两阶段 `LiteratureContent` 生产与分析失败清理策略已删除。

### 2.3 MetaLiterature 与 Literature

MetaLiterature 通过代表 Literature 和成员关系聚合同一文献的明确版本，不拥有另一份元数据、资产或状态。只有来源明确的 `version_links` 才能连接版本，题名相似或引用关系不能触发版本聚合。Literature 自创建起具有唯一 meta_literature_id、version_role、metadata，读取时投影 status。代表顺序为正式发表版、作者接受稿、预印本、其它；更换代表不转移成员事实。

### 2.4 身份收敛

稳定标识符以 namespace/value 精确匹配。标识冲突或多个候选返回 identity-conflict，不做模糊合并。双方没有稳定标识符时才使用规范题名、完整作者顺序、年份、publication_form 的严格后备键；缺任一字段不参加后备匹配。一次性旧库转换重算后备索引，不能沿用 document_type 的旧哈希。没有标识、又没有命中严格后备键的条目，入库时另按 [6.4.8](#648-可能重复) 判断是否可能重复（目标，尚未实现）。

### 2.5 元数据、来源与字段裁决

当前 metadata 使用 `publication_form` 与 `article_kind` 两个封闭枚举，完整值与状态见 §8；没有 document_type 兼容参数。题名、作者、摘要、日期/年份、期刊、出版者、卷期页、标识符、关键词与语言保持中性合同。

每条 MetadataObservation 不可变，保留 provenance、原始 source_type、映射版本、元数据、声明关键词、参考文本、计数、资产线索和明确版本连接。导入 observation 使用 user 来源；供应商 observation 使用 metadata-provider。未知类型映射为 null，不猜测出版形式。新 observation 保存关联并清除已耗尽的自动获取标记，不能覆盖人工锁定字段。

统一元数据只有一份。metadata_revision/hash 用于并发复检，字段状态保存 authority/proofread/manual、证据、冲突和锁定。就绪后新增观察只补空并记录冲突；显式重建元数据步骤才重新裁决。人工编辑锁定，解锁也是显式操作。建档模型从 front-matter/abstract/keywords 和第一页读取提议；DOI 必须出现在固定片段且格式合法。缺必填字段返回 metadata-missing，不伪造完成。

### 2.6 文献引用与支持

Reference 只连接已接纳的两个 Literature，反向被引和 MetaLiterature 网络均是投影。关系必须有来源支持：ProviderRelationSupport、MetadataReferenceTextSupport 或 ArchiveReferenceTextSupport。校订稿参考文本由结构注释拥有，关联支持绑定固定文档与参考条目；解析不出或有歧义只保留文本，不创建占位 Literature。

引用接纳独立且幂等；失败不撤销文献、PDF、校订稿或元数据。旧总结专属 ContentReferenceTextSupport 已删除；转换时只有失去全部保留支持的引用边被移除。参考文献为空不阻断就绪。

### 2.7 文献状态

六种状态为 UNREVIEWED、ASSET_READY、ARCHIVING、ARCHIVE_FAILED、READY、EXCLUDED，详见 §8.3。它们由当前事实推导，不是可任意写入的一列。READY 要求正文校订 complete、默认文档及结构、必填元数据、有效标签；存疑和补充材料失败不阻断。获取、解析、建档分别显式启动；总结不参与建档或就绪条件。“书目待补”是文献上的标记，不是状态，见 [8.4](#84-书目待补目标尚未实现)（目标，尚未实现）。

### 2.8 独立读取、新知识关联与事实边界

QueryApplication 只读，不补查来源、不获取材料、不调用模型、不重建索引。材料和证据读取验证固定绑定、字节与 hash；应用关闭等待在途读取结束。结果过时由版本事件推导，修正描述不会让单篇内容算子失效，内容修订不会覆盖历史结果。算子不适用或失败不能授权删除原始资产。

### 2.9 Identifier、Author 与 Affiliation

跨模块文献标识、署名与单位的精确合同为：

```text
Identifier
  namespace: str
  value: str

Author
  kind: AuthorKind
  display_name: str
  given_name: str | None
  family_name: str | None
  orcid: str | None
  affiliations: tuple[Affiliation, ...]

AuthorKind = "person" | "organization" | "unknown"

Affiliation
  name: str
  ror: str | None
```

`Identifier` 只表达一个标识符的命名空间和值。两个字段去除边界空白后必须非空；`namespace` 规范化为小写开放字符串，不建立全局枚举。为了让书目导入和全部 Provider 共享同一格式，Model 对已经明确的 namespace 执行纯、确定、无 I/O 且幂等的官方 canonicalization：

| namespace      | validator 接受并转换的表示                                                                     | canonical `value`                                                          |
| -------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `doi`          | 裸值、大小写变体、`doi:`、已知 `doi.org`/`dx.doi.org` resolver URL 和边界空白                  | 小写裸 `10.xxxx/...`；不删除可能属于 DOI suffix 的标点                     |
| `arxiv`        | 官方新式或旧式 ID、`arXiv:`、官方 `/abs/` 或 `/pdf/` URL、可选 `.pdf` 及 `v1`/`v2` 等 revision | 不带 revision 的官方基础 ID，例如 `2501.01234` 或 `hep-th/9901001`         |
| `pmid`         | 边界空白内的官方 PMID                                                                          | 纯数字                                                                     |
| `pmcid`        | 边界空白内、前缀大小写可规范化的官方 PMCID                                                     | 大写 `PMC` 加数字                                                          |
| 其它 namespace | 当前没有显式 canonicalizer 的值                                                                | 只去除边界空白并保持其余字符；支持前必须依据官方规范增加独立转换与 fixture |

已知 namespace 的包装去除后仍必须满足对应官方基本格式；不能识别的 URL、前缀、空值或畸形值直接拒绝，不通过猜测修复。DOI 大小写不敏感，因此只有 `doi` 的 value 统一小写；不能把这项规则全局应用到 arXiv、PMCID、ISBN、ISSN 或未知 namespace。arXiv revision 只是来源表示，不形成新的业务字段。ISBN、ISSN 等其它标识符若需要语义规范化，必须分别依据官方合同增加显式 canonicalizer，而不是由 Provider adapter 私自采用不同规则。

Model 只决定一个值的 canonical 表达，不判断该字段究竟标识当前 Literature、相关版本还是 Provider 记录，也不决定两个 Literature 是否合并。Metadata adapter 负责语义归类；Literature 负责身份命中、冲突和版本聚合。供应商内部记录 ID 进入 `Provenance.source_record_id` 或 `ProviderLiteratureKey.record_id`，不伪装成文献 `Identifier`。该对象不增加 URL、provider、provenance、primary 或 confidence 字段。

`Author` 表示作者在一篇具体 `Literature` 中的一次结构化署名，不是全局作者实体。`display_name` 是必填的署名展示值，只允许忠实清理断行与边界空白；`given_name` 和 `family_name` 只保存来源明确给出或能够无歧义对齐的姓名组成，不能从展示名机械猜测。`kind` 允许个人、机构或无法可靠分类的署名，因此能够保留中文姓名、协作组和机构作者。ORCID 只保存不带 URL 前缀的裸值，并校验格式与校验位；不得根据姓名查询或猜测。作者顺序由 `LiteratureMetadata.authors` 的不可变 tuple 表达。

`Affiliation` 表示该作者在这篇具体文献中的署名单位；`name` 非空，`ror` 只保存来源明确给出且不带 URL 前缀的裸值，不能根据单位名称猜测。单位顺序在作者内部保留。当前合同不增加全局 `author_id`、作者 position、email、通讯作者、共同贡献、CRediT role、confidence、供应商作者 ID 或逐作者 provenance；作者及单位的来源由所属 `MetadataObservation` 或最终内容的 Analysis provenance 表达。

### 2.10 文献身份与资产结构

`MetaLiterature`、`Literature`、`VersionRole` 和 `LiteratureStatus` 的精确合同由 [MetaLiterature 与 Literature](#23-metaliterature-与-literature) 定义。`VersionRole` 使用 `published`、`accepted-manuscript`、`preprint` 和 `other`，不保留旧名称 `formal`；`LiteratureStatus` 只承载 Literature 模块已经推导的当前结果，Model validator 不计算状态。

`MetadataObservation` 的精确合同由 [MetadataObservation 来源输入](#25-元数据来源与字段裁决) 定义。它是独立、不可变且长期保存的来源对象，不是 `Literature` 属性；一个 Literature 与多个 observations 的归属由 Storage 关系表达，不把 `literature_id` 放入 observation。Provider observation 与书目导入 observation 复用同一结构，只通过受约束的 Provenance 区分；书目 codec 不得复制 `LiteratureMetadata` 字段建立 `ImportedMetadata`。`version_links` 只保存供应商明确声明为同一文献其它版本的目标 key，用于可审计身份收敛，不进入 `LiteratureMetadata` 或形成独立权威关系；`reference_texts` 只保存供应商实际返回的原文，不声明完整，也不表示已经形成引用关系。`MetadataObservation.declared_keywords` 保存供应商声明关键词；书目导入的 keywords 进入该 observation 的 `metadata.keywords` 并可参与统一初始投影；完整 Analysis 后，当前 `LiteratureMetadata.keywords` 保存 Literature 已验收的全文关键词。`LiteratureMetadata.pages` 同时承载传统页码范围和供应商返回的电子文章定位号，不再建立 `article_number`。`AssetHint` 的精确合同由 [AssetHint 合同](#443-assethint-合同) 定义；其中 URL、媒体类型、资产角色、版本角色、访问状态和许可证都描述具体来源线索，不属于 `LiteratureMetadata`，也不代表已接纳资产。`AssetHint` 不增加获取层级、授权要求或 Browser 要求，运行访问上下文由 Acquisition Resolution/Plan 决定。`PdfCandidate`、`Asset`、`LiteratureAsset` 和 `AcquisitionResult` 的精确合同分别见 [Route hint、候选与 adapter 边界](#444-route-hint候选与-adapter-边界)、[Asset 与 LiteratureAsset](#445-asset-与-literatureasset)和[输入与公开结果](#43-输入与公开结果)：候选与 candidate key 只存在于当前运行；候选只保存 route adapter 的稳定 source identity、Public/Authorized API/Browser path 和声明媒体类型，不要求 URL，也不携带 adapter 私有动作；Asset 只描述不可变文件；唯一 `primary-pdf` 关系表达当前主 PDF；自动业务结果只有已获得或未获得，系统提交错误不属于该联合。`NoPrimaryPdf` 只有在全部适用 routes 正常结束、没有 deferred/action-required/未解决 failure 且最小耗尽事实已提交后成立；运行错误不能伪装成该结果。手动接纳成功使用独立 `AcceptedManualPdf`，只组合已经提交的 `Asset` 与 `LiteratureAsset`；无效本地文件是输入验证错误，不进入自动联合，用户绝对路径不进入 Model。这些来源信息不能通过通用 `extra_metadata`、裸字典或 vendor model 扩展 `LiteratureMetadata`。非空标题或 DOI 至少存在一个是 Literature 的入库规则，不由 Model validator 决定。

### 2.11 元数据并发绑定

`LiteratureMetadata` 是单一当前值，不是来源 observation 或 revision 历史对象。`metadata_revision` 不进入 `LiteratureMetadata` schema；它是持久化关系上的单调并发令牌，和 `metadata_sha256` 一起绑定当前内容输入。Catalog 不暴露旧统一元数据 revision 集合，LLM 最终提案也不转换为 `MetadataObservation`。

### 2.12 权威引用支持结构

`Reference` 只有 reference_id、source_literature_id、target_literature_id。支持来源分别绑定供应商关系观察、元数据参考文本或固定档案参考条目；不复制来源原文。精确 owner 见 §2.6。

## 3. 元数据来源与供应商适配

### 3.1 当前实现结构

供应商和外部服务的静态事实由各家 `apps/server/src/providers/<provider>/definition.ts` 拥有，`providers/registry.ts` 统一汇总能力、endpoint、认证声明、覆盖范围与访问政策；本模块 registry 消费该声明并结合实际 adapter/readiness，不再自有一份重复能力清单。Metadata 与 Acquisition 保持独立接口。各服务的共享额度、默认策略和维护步骤见[供应商治理](../../development/provider-governance.md)。

```text
apps/server/src/metadata/
  api.ts / service.ts / ports.ts   # 操作、调用编排与中性 Provider ports
  registry.ts                     # 目录消费、选择与能力
  assembly.ts                     # 当前配置与共享 Network 组装
apps/server/src/providers/
  registry.ts / contracts.ts      # 静态定义汇总与统一合同
  <provider>/definition.ts        # 各家服务、认证与访问政策
  <provider>/metadata.ts          # 各家元数据协议转换
  <provider>/acquisition.ts       # 各家 PDF 协议适配（仅支持者）
  shared/                        # 通用传输与记录帮助
```

`MetadataApi.searchTopic` 按给定 providers 和 scan_limit 返回多来源结果；`searchTopicProvider` 可由 Entry 的 run-owned 预算逐 Provider 调用；`lookup` 接收稳定定位；`queryReferences` 返回来源关系。每种调用都接收可选 `AbortSignal`。普通文献查询不调用这些 API。

`MetadataService` 负责能力验证和稳定失败转换，Entry 拥有 DiscoveryRun 与全 run 预算，Literature 决定接纳/身份；同一个 scan limit 不能在每个分页或种子重新补满。adapter 只有在生产 assembly 已安装且用户选择与 readiness 满足时才参与。

### 3.2 公开 API

公开 API 使用 Model 表达：

- 中性的领域查询条件；
- 已解析的种子文献标识；
- 要查询的引用方向和边界；
- 本次启用的全部供应商及各自在整个 DiscoveryRun 内的原始扫描上限；
- 各供应商成功 observation，包括供应商明确声明的同文献 `version_links`；
- 元数据供应商返回的逐边 `ProviderRelationObservation`，以及响应中实际内联提供的相关文献 `MetadataObservation`；
- 各供应商自然耗尽、达到扫描上限或稳定脱敏失败的终止结果。

公开 API 不接收或返回 vendor client、HTTP request/response、SDK model、URL session 或裸供应商 JSON。

Metadata 不直接组织 PDF 下载、解析或 LLM 分析，也不把供应商记录 ID 当作 SciRetriever 文献身份。

DiscoveryRun 由 Entry 拥有；数据库补全的 selector、内存目标和 Report 同样由 Entry 编排但不形成持久化运行。Metadata API 只执行本次有界供应商能力并返回中性结果，不接收 BatchGoal、`advance_to`、Collection 或内容处理选项，也不在领域搜索结束后对每条发现结果自动执行全供应商精确补查。

### 3.3 Ports

`ports.ts` 至少区分：

- Metadata Search：按中性查询条件产生 metadata observation；
- Metadata Lookup：按 DOI、arXiv ID、PMID/PMCID 或供应商稳定记录 ID 等明确标识符精确查询；
- Metadata Reference Query：使用同一类元数据供应商的引用关系查询能力，按中性文献标识和方向返回逐边 `ProviderRelationObservation`，并转换响应实际内联提供的相关 metadata observation；
- Observation Publication：持久化已经完成中性转换且可被 Literature 接纳的 metadata observation，以及可以独立存在的结构化引用关系来源 observation；
- 必要的时钟或调用预算接口。

每个 Metadata Search 调用具有明确 Provider，并消费该 Provider 在整个 DiscoveryRun 内共享的原始扫描预算；分页在结果耗尽、达到上限或失败时停止。Cursor 和运行时计数只存在于适配调用，不属于 Port 返回的持久化事实。

Metadata Lookup 和 Metadata Reference Query 都是 Metadata Provider 的可选能力，不把引用定义成新的供应商种类，也不建立 `CitationProvider` Port。同一供应商可以通过专门 endpoint 或普通元数据响应提供引用信息；接口形式不决定结果属于结构化关系还是参考文献原文。Provider Port 表达供应商能力，不复制 Network transport API。供应商适配器可以使用 `network`，但 Metadata 的规则和用例不能直接使用 HTTP 类型。

### 3.4 供应商适配器

当前目标的领域搜索生产 adapter 范围为：

```text
web-of-science
crossref
semantic-scholar
arxiv
openalex
europe-pmc
elsevier
springer
datacite
core
```

这里使用稳定 Provider key；`elsevier` 的 Metadata 产品包括 Scopus，`springer` 的外部展示名称为 Springer Nature。Web of Science、Elsevier/Scopus 和 Springer Nature 仍分别遵守其具体产品、database/edition 与覆盖范围；这些属于普通配置和 adapter 协议，不产生新的 Provider 类型。OpenCitations Meta 当前只实现稳定标识符 lookup，并与引用能力一起归 Metadata；没有官方领域关键词搜索合同前不参加主题 DiscoveryRun。以上是目标能力矩阵，不证明某个 adapter 已经在当前代码、Bootstrap 或已安装产品中可用；当前行为必须以 README、源码和测试为准。

一次领域 DiscoveryRun 选择本次全部“普通配置已启用、生产 search adapter 存在、必需普通参数/凭据/AccessPolicy 就绪”的能力。Entry 不按 publisher 预分流：Scopus 可以返回多家出版社文献，Springer Nature 只返回自身覆盖内容，都是各自正常的检索语义。全面目标范围不表示每次无条件调用全部机构，也不改变“发现后不做逐篇全 Provider 补查”的边界。

每个 Provider adapter（当前为 `providers/<provider>/metadata.ts`）负责：

- Endpoint 和供应商请求参数；
- 查询语法映射；
- 分页 token/cursor；
- 声明稳定 provider/API product AccessScope 与经过核对的访问政策；
- Provider quota、`429`、`Retry-After` 和额度响应头解释，并转换为 Network 可执行的 policy feedback；
- 凭据附着位置；
- 声明该能力的凭据字段需求、非 secret 普通参数和用于用户显式 `config test` 的官方最小只读 probe；
- Vendor 响应结构解析；
- 转换为 `packages/contracts` 中的中性 observation、同文献版本连接、引用查询结果与资产线索；
- 将供应商错误转换为稳定、脱敏失败。

当前 TypeScript Metadata 生产 HTTP 请求使用明确的 `GET`、30 秒单次 timeout 与 4 MiB 响应预算；
预算同时传到 HTTP 字节读取与共享 Network usage。HTTP `429`、认证/授权错误、来源服务错误、
Network timeout/响应超限和无效 JSON 分别转换成来源/传输失败，只有逐记录合同转换失败才报告
`metadata-record-invalid`。稳定失败保留安全的 HTTP status 与 Network 已解析且有界的
`Retry-After` 提示，不携带 header、响应正文、URL 或原始异常。

Crossref 主题游标分页显式使用 `sort=score&order=desc`；arXiv 对主题的每个词或用户明确加引号的
短语加 `all:` 并以 `AND` 连接，避免未限定词产生 OR 扩召回。DataCite 默认每页 25 条，扫描上限
仍跨页累计；其摘要段落空白在供应商边界转换为空格，raw input hash 继续绑定原始响应记录。
Semantic Scholar 的数字 `externalIds.PubMedCentral` 转换为带 `PMC` 前缀的公共 PMCID，搜索、
lookup 和引用端点共用这一转换。以上规则没有增加领域语义过滤或精确主题命中保证。

一个供应商共享一个 client/session；共享同一 key、账户或官方额度池的 search、reference query 和 asset API 还必须共享同一 Network AccessScope。适配器不能执行身份合并、统一字段选择、PDF 基本检查、实际内容判断或文献状态推进，也不能建立只对 Metadata 可见的局部 limiter。

Provider 增加或替换时，只需实现相同中性 Port 和网络安全边界，不能要求改写产品主流程。

### 3.5 Observation 与部分成功

#### 3.5.1 MetadataObservation

每条成功 `MetadataObservation` 至少表达：

- Observation identity；
- 通过公共 `Provenance` 表达的 provider identity、provider record identity、实际观察时间和输入 hash；
- 描述文献自身的 `LiteratureMetadata`；
- 供应商对当前记录明确声明的可选 `version_role`；
- 供应商明确声明的同文献其它版本 `version_links`；
- 供应商返回的可选 `declared_keywords`；
- 供应商在当前记录中实际返回的原始 `reference_texts`；
- 供应商在该时间观察到的可选 `reference_count` 和 `cited_by_count`；
- PDF、落地页或开放获取地址等可选 `AssetHint`；
- 可用于后续稳定补充的来源标识。

精确字段见 [MetadataObservation 来源输入](#25-元数据来源与字段裁决)。`MetadataObservation` 是独立、不可变且长期保存的来源对象，不携带 Literature 身份；Literature 接纳后由 Storage 建立归属，一个 Literature 可以关联多个 observations。`LiteratureMetadata` 不是供应商整条返回记录。`version_role`、`version_links`、`declared_keywords`、原始参考文献文本、两类次数和资产线索必须保持为 observation 的独立组成部分，不能为了适配某个供应商而不断向 `LiteratureMetadata` 增加属性。`version_links` 只保留明确同文献版本目标，不能容纳更正、撤稿或其它供应商关系；`declared_keywords` 不直接填入 `LiteratureMetadata.keywords`，也不与 LLM 根据文献内容形成的关键词混合；不同供应商的计数不直接相加；Metadata 也不把 `AssetHint` 接纳为文献资产。Observation 只声明产品需要的中性字段，不增加通用 `extra_metadata` 或让 vendor 原始响应穿透 Model。

Adapter 必须先判断一个供应商字段的语义归属，再构造中性 Model：只有标识“当前这条具体文献记录所描述的 Literature”的 DOI、arXiv ID、PMID、PMCID 或其它官方文献 ID 才进入 `metadata.identifiers`；供应商数据库自身的记录键进入 Provenance 或 ProviderLiteratureKey；指向预印本、正式发表版或其它同文献版本的 ID 进入 `version_links`。官方格式只决定值如何表达，不会把 Provider record identity 自动升级为文献自身 identifier。

供应商字段按其含义转换，而不是按 vendor 字段名照搬：

| 供应商字段表达的事实                                                                                    | 中性归属                                                                                         | 转换规则                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文献自身的题名、摘要、出版日期、类型、语言、出版物、出版社、卷、期、页码或电子文章定位号                | `LiteratureMetadata`                                                                             | 只映射 [LiteratureMetadata 的边界](#25-元数据来源与字段裁决)；页码范围和电子文章定位号都进入 `pages`                                                                                                                                                             |
| 按署名顺序返回的作者展示名、明确姓名组成、ORCID、作者与单位对应关系及 ROR                               | `LiteratureMetadata.authors: Author[]`                                                           | 按来源顺序转换为 [Identifier、Author 与 Affiliation](#29-identifierauthor-与-affiliation)；只保存供应商明确返回或能够在同一记录中无歧义对齐的值，不建立全局作者身份                                                                                              |
| 当前记录自身的 DOI、arXiv ID、PMID、PMCID 等具体文献标识符                                              | `LiteratureMetadata.identifiers`                                                                 | 转换为带 namespace 的中性 `Identifier`；公共 Model 统一执行官方 canonicalization，adapter 不再实现另一套大小写、前缀或 URL 去壳规则                                                                                                                              |
| OpenAlex Work ID、Web of Science UID、Semantic Scholar Paper ID、Scopus EID 等 Provider record identity | 当前记录使用 `provenance.source_record_id`；关系或版本端点使用 `ProviderLiteratureKey.record_id` | 保留供应商官方值并在父 Provenance 的 provider scope 内解释；不能进入 `LiteratureMetadata.identifiers` 或跨供应商身份匹配                                                                                                                                         |
| 供应商明确表示为原始记录声明的关键词                                                                    | `MetadataObservation.declared_keywords`                                                          | 不把主题分类、学科分类或供应商自动推导的 topic 当作声明关键词                                                                                                                                                                                                    |
| 供应商明确声明的文献版本                                                                                | `MetadataObservation.version_role`                                                               | 只映射可靠声明；未知时为空，不根据文献类型、供应商名称或 URL 猜测                                                                                                                                                                                                |
| 供应商明确声明为同一文献其它版本的稳定目标                                                              | `MetadataObservation.version_links`                                                              | 每个目标形成一个 `ProviderLiteratureKey`；当前记录由 observation 自身定位，目标至少具有非空供应商记录 ID 或稳定 Identifier；正式发表记录中表示相关预印本的 arXiv ID 属于这里，不得同时塞入当前正式 Literature 的 identifiers；不映射更正、撤稿、引用或模糊相关项 |
| 当前记录中原样返回的参考文献条目文本                                                                    | `MetadataObservation.reference_texts`                                                            | 按供应商顺序保存非空原文；不拆成残缺元数据，也不解释成已确认 Reference                                                                                                                                                                                           |
| 供应商明确返回稳定目标标识的参考文献或被引用文献                                                        | 逐边 `ProviderRelationObservation`，以及响应实际内联提供的相关 `MetadataObservation`             | observation 规范化为 `citing -> cited` 并独立保存；只有当前扩展范围选中的目标才继续接纳并建立 Reference 与 `ProviderRelationSupport`                                                                                                                             |
| 参考文献次数和被引用次数                                                                                | `MetadataObservation.reference_count`、`cited_by_count`                                          | 保留来源和观察时间，不根据文本列表长度推导，也不跨供应商相加                                                                                                                                                                                                     |
| 直接文件 URL、落地页 URL、媒体类型、资产角色、版本角色、访问状态和许可证                                | `MetadataObservation.asset_hints`                                                                | 每个可独立使用的地址形成一个 `AssetHint`；精确合同见 [AssetHint 合同](#443-assethint-合同)                                                                                                                                                                       |
| 搜索相关度、分页 cursor、供应商抓取或索引时间、供应商为当前文献预生成的展示引用和其它内部运行字段       | 不进入业务 Model                                                                                 | 只在当前适配调用中使用，不持久化为文献事实                                                                                                                                                                                                                       |

作者转换由各 provider adapter 在单条供应商记录的边界内完成：保留原始署名顺序和明确的 `display_name`、`given_name`、`family_name`、ORCID、署名单位名称及 ROR；机构或协作组按机构作者表达，无法可靠分类时使用 `unknown`。Adapter 不从展示名按空格机械拆分姓与名，不翻译姓名，不根据姓名猜 ORCID，不根据单位名称猜 ROR，也不使用供应商作者 ID 建立本地作者身份。供应商没有明确给出作者与单位的对应关系时，不能把全部单位分配给全部作者。

Metadata 只转换每个来源自己的作者事实，不跨供应商匹配作者。选择基础作者列表以及按相同 ORCID 或整表完全对齐补充缺失字段，属于 [作者署名](#29-identifierauthor-与-affiliation)。冲突仍保留在各自 observation 中，不能由 adapter 用模糊匹配提前消解。

所有 adapter 都把 vendor 值交给同一个 `Identifier` 边界：DOI URL、`doi:`、大小写和边界空白必须得到同一小写裸 DOI；arXiv 前缀、官方 URL、新旧式编号和 `vN` revision 必须得到同一基础 ID；PMID、PMCID 及其它已支持 namespace 使用各自官方格式。Adapter 不能为了提高命中率删除标点、改变未知 namespace 大小写或建立私有 alias。不能通过官方语义确认某字段标识当前具体 Literature 时，不得猜测放入 identifiers。

供应商返回多个地址时必须形成多个 `AssetHint`，不能只保留一个 `pdf_url` 或用后返回值覆盖先返回值。供应商返回多个明确同文献版本目标时分别形成多个 `version_links` key；这些 key 复用当前 observation 的 Provenance，只作为 Literature 身份收敛证据，不产生独立关系对象。只保存能够支持文献识别、版本收敛、引用扩展、资产获取和来源审计的中性字段；不保存完整 vendor 原始对象。

#### 3.5.2 ProviderRelationObservation

元数据供应商每明确返回一条具有稳定两端定位的引用关系，适配器产生一个中性、不可变的最小来源事实：

```text
ProviderRelationObservation
  observation_id: ObservationId
  provenance: Provenance
  citing: ProviderLiteratureKey
  cited: ProviderLiteratureKey

ProviderLiteratureKey
  record_id: str | None
  identifiers: Identifier[]
```

`citing` 是引用方，`cited` 是被引用方；references 与 cited-by 响应都转换成同一个 `citing -> cited` 方向，不把查询方式持久化为关系字段。每个 `ProviderLiteratureKey` 至少具有一个非空供应商 `record_id` 或稳定 Identifier，规范化后的 citing 与 cited 不能相同。Provider identity 由 observation 的 `provenance.source_name` 统一表达，不在两个 key 中重复。

一个响应返回 A→B、A→C、A→D 时产生三个 observation。它们具有不同 `observation_id`，但可以复用同一次供应商调用的 Provenance。Observation 不携带 `LiteratureId`、目标 `MetadataObservation`、标题、作者、原始参考文献文本、PDF evidence、扩展状态或任务状态。

`ProviderRelationObservation` 可以在目标尚未入库时独立发布，是供应商关系的最小持久化单位，也是 Entry 后续选择引用扩展目标的输入单位。保存它不创建目标 Literature、Reference 或 ReferenceSupport，也不自动触发递归。响应实际内联提供的目标 metadata 可以同时转换成独立 `MetadataObservation`，但二者不互相嵌套；只有 Entry 选中该关系目标时，才使用内联 observation、本地精确命中或后续 Metadata Search 完成目标接纳。

#### 3.5.3 部分成功

一次调用中各供应商在各自 Network scope 准入后独立执行：

- Adapter 在转换、最低入库判断和去重前对 Provider 返回的每条原始 item 计数，并在整个 DiscoveryRun 共享该 Provider 的 `scan_limit`；该上限不按页、种子、深度或请求重置；
- 一个供应商失败不撤销其它供应商成功结果；
- 已完成转换的 observation 可以先交给 Entry 和 Literature 接纳，不必等待同一供应商的后续页面；
- 不完整 observation 可以交给 Literature；只有 Literature 按“非空标题或 DOI 至少存在一个”的规则接纳后，才能形成已入库的文献和来源事实；
- 单条原始 item 在 vendor-to-neutral 转换时形成稳定 `MetadataProviderFailure`，该 item 仍消耗 `scan_limit`；Service 只记录序号和脱敏稳定失败字段，保留此前事实并继续同一 Provider 的后续 item，不记录原始 item、cursor 或响应；
- 同一 Provider 正常耗尽或达到扫描上限时，只要本次扫描存在上述拒绝记录，最终终止结果仍为 `FAILED` 并携带首个记录级稳定失败；拒绝记录前后已经成功转换的 observations 和 relations 全部保留，不能把部分损坏伪装为完整成功；
- 同一供应商分页失败时保留此前已确认页面，并返回该供应商的部分失败；
- 后续页面、Network 或其它 Provider 级稳定失败优先作为最终失败；取消仍形成 `INTERRUPTED`，Port 合同或编程错误仍向上传播而不能按坏记录隔离；
- 失败不能伪装成“零结果”。

Debug 日志为每条原始 item 记录 `accepted`、`empty` 或 `rejected` disposition、
observation/relation 增量和稳定 reason；Provider 结束汇总满足
`raw = accepted + empty + rejected`。这些扫描计数与逐条 disposition 只用于诊断，
不加入 `MetadataProviderInvocation`、Report、Catalog 或其它业务 Model。Adapter 对合法但明确
不产生任何中性事实的 item 可以在 package-local `NeutralMetadataItem.empty_reason` 中给出受控的
稳定代码；该值只能与空 observations/relations 同时出现，Service 只把它写入 Debug disposition，
不会把 vendor 类型、原始字段或响应正文带出边界。未提供专用原因的通用空 item 继续使用
`no-neutral-facts`。

Provider 已完成中性转换的 relation 仍逐边形成独立、不可变的
`ProviderRelationObservation`，但 publication Port 不再逐边打开 SQLite 事务。Entry 保持
observation/result 的既有先后顺序，再按供应商返回顺序切成最多 256 条的冻结批次；Storage
在一个短事务内原样保存一批。批内任一 relation 失败时整批回滚，已经成功提交的先前批次
继续保留；正常取消只在批次之间生效。若 Provider invocation 已明确返回 `INTERRUPTED`，Entry
仍保存它已经返回的全部 observation/relation，再结束运行且不发布 source result。批量只改变
物理提交粒度，不合并 observation、端点、provenance 或后续待扩展单位，也不把整次 Provider
的无界关系集合放入一个长事务。

领域 DiscoveryRun 由 Entry 调用本次有效选择的 Metadata Provider。有效选择由纯本地 resolver 从 Auto 或 Custom 得到：Auto 按 ADR 0043 使用公开默认集合与配置齐全的授权来源，Custom 是用户精确顺序并允许为空；不在启动时探测在线权限。明确选择但缺少生产 adapter、必需普通参数、凭据或 AccessPolicy 时，运行开始前形成稳定配置错误；不能静默跳过或伪装为零结果。Metadata 不因一条 observation 被接纳就自动对它发起逐篇精确查询，也不把搜索相关度、候选、未接纳结果、cursor、原始请求/响应或扫描计数交给 publication Port。自然耗尽、达到扫描上限和失败由 Entry 转换为逐来源稳定终止结果；Adapter 的 timeout、重复 cursor 与空分页循环保护不进入业务 Model。

Metadata 不判断一条 Provider 结果是否与用户领域语义相关，不调用 LLM 或 embedding，也不按搜索分数、标题关键词、摘要、连续低收益或其它主题启发式过滤和提前停止。非空标题或 DOI 任一存在就是当前最低入库边界；有实际内容但偏题的 Literature 仍可正常进入后续处理，不属于 `NoUsableContent`。

Metadata 不决定不同 observation 是否属于同一 `Literature`；它把全部成功来源事实交给 Literature。

元数据供应商的引用关系查询能力只返回相关文献的稳定记录 ID 或 DOI 等标识时，适配器直接用它形成对应的 `ProviderLiteratureKey`，不为响应中的全部目标立即补查元数据。Entry 只对当前用户方向、深度、数量和筛选范围选中的关系解析非本地端点：先精确查询本地 Literature，响应已内联提供目标 `MetadataObservation` 时复用它，否则再调用 Metadata Search。目标 observation 被 Literature 接纳后，Entry 建立两个具体 Literature 之间的 Reference，并用 `ProviderRelationObservation.observation_id` 建立 `ProviderRelationSupport`。未选中、元数据不足或接纳失败的 relation observation 继续保留，但不创建占位 Literature、Reference 或 support。

结构化关系和参考文献原文的正式判断标准是供应商是否已经明确给出可稳定识别的目标，而不是调用是否主动、是否使用专门 endpoint，或者字段是否由默认元数据响应携带。只有 DOI、PMID、arXiv ID、供应商稳定记录 ID 等明确目标标识的关系才能形成结构化关系 observation；仅有格式化引用文本时始终进入 `reference_texts`。

Entry 在 Literature 接纳 observation 后保存其中的 `AssetHint`，并在处理对应 `Literature` 时把当前可用线索交给 Acquisition。Metadata 不直接调用 Acquisition，也不把资产线索写成当前主 PDF。

### 3.6 Network 与配置边界

供应商适配器通过 `network/http.ts` 发起访问，遵守统一 URL、DNS、redirect、origin、timeout、响应大小、脱敏和 ADR 0012 的进程内共享准入。Provider 自身的分页、额度和响应语义留在适配器中；adapter 声明 scope 并解释反馈，Network 在当前进程的 Metadata、Acquisition、不同操作和文献目标之间执行并发、间隔、quota 与 `Retry-After`。Vendor SDK 无法注入受控 transport 时不能作为生产实现。

HTTP 200 不能被统一解释为 Metadata 成功或空结果。例如 Elsevier 的 Scopus Search 与
Abstract Retrieval 还可能返回 `service-error.status.statusCode` envelope；adapter 只读取
有界、白名单化的 code，将其转换为认证、产品授权、限额、查询拒绝、可重试服务失败或精确
lookup miss，不读取或记录 vendor `statusText`。未知 code、畸形 envelope 和未知顶层继续
形成稳定的 unknown-shape failure，不能被伪装成零结果。
Scopus Search 的 offset 与 cursor 是两种分页合同：cursor 响应必须提供 total、page count、
当前/下一 cursor 与 entry，`opensearch:startIndex` 可以缺失；若供应商仍返回该 offset 字段，
adapter 会将它与本地已接收计数严格核对。Debug 只记录受控 envelope、字段存在位、disposition
和中性 failure kind，不记录字段值、cursor、query 或响应正文。

普通配置向 `bootstrap/application.ts` 提供 Source mode、Custom Provider 顺序、产品/database/edition、逐 Source `limit`、非 secret 运行身份和 AccessPolicy；Configuration 的有效 Source 解析只用版本默认和本地配置/凭据存在性，不访问 Network、不读取授权值。Metadata Auto 的公开集合是 Crossref、Semantic Scholar、arXiv、OpenAlex、Europe PMC、DataCite 与 CORE，另加入必要 key 齐全的 Elsevier、Springer Nature，以及 key、产品与数据库齐全的 Web of Science；Crossref 无子表时使用 anonymous。OpenCitations 可显式选择其支持的引用能力，不在当前 Auto 列表，也不参加 topic search。Provider secret 只由 TypeScript Configuration owner 从 `~/.sciretriever/credentials.toml` 私有解析后注入具体 adapter。Metadata API、Port、Model、AccessScope 和 observation 都不保存 secret 值或凭据文件原文。未知选择键、缺失生产适配器、缺失所需普通参数/凭据或缺少明确 AccessPolicy 必须形成稳定 readiness 失败，不能静默回退到假实现或无限制访问。

`config status` 只读取 capability spec、普通配置和凭据字段存在性，不调用 Metadata API 或 Network。用户显式执行的 `config test` 可以复用 adapter 声明的最小 probe，但它通过 Bootstrap 的配置测试边界和统一 Network 执行，不伪装成 Metadata Search/Lookup，不产生 MetadataObservation、ProviderRelationObservation、DiscoveryRun、Report 或持久化结果。

### 3.7 持久化协作

Metadata 形成中性 observation 后，通过自己拥有的 publication Port 请求保存，但该 Port 不能绕过 Literature 的最低入库条件。Observation、Literature 身份结果、统一初始元数据、DiscoveryRun 结果/原因，以及该 Literature 既有自动 PDF 获取耗尽事实的清除，由 Entry 在 Literature 接纳后编排复合事务；标题和 DOI 都缺失的结果不会作为已接纳 observation 持久化，但仍消耗原始扫描额度。Storage 不在 SQL 中重新解释供应商数据。

同一来源 observation 重复提交必须幂等，不能因重复收集制造无意义副本；实际接纳到新的来源观察时则新增不可变 observation 和 Literature 归属，不能更新旧对象。幂等键和物理 schema 由 Storage 实现，但不能丢失来源差异。Metadata 只发布 observations，不发布当前统一 LiteratureMetadata 或把 LLM 结果转换为 observation。

### 3.8 验收

直接测试至少覆盖：

- 目标领域搜索 Provider 矩阵按“项目目标、Auto/Custom 有效选择、生产实现、readiness”分层选择；默认 Auto 集合与 Custom 精确/空列表均可离线确定；必需凭据与普通参数配置齐全的来源按 [ADR 0043](../decisions/0043-configured-metadata-auto.md) 进入 Auto，集合只看本地字段是否齐全，不联网判定；OpenCitations 只参加精确 lookup/引用，不参加主题搜索；
- 领域发现无需也不能按 publisher 预选 Provider，全部已启用且就绪的 search adapter 各自在自己的覆盖范围内执行；明确启用但 adapter、必需普通参数/凭据或 AccessPolicy 缺失时开始前失败；
- 领域 DiscoveryRun 把 `sources.metadata.limit` 分别应用给每个参与 Provider，过滤、缺少标题/DOI、重复和未接纳 item 都消耗本 Source 上限；默认是 500，结果耗尽或达到上限后正常停止，Provider cursor、过程计数、搜索分数、未接纳候选和请求/响应不进入 Model 或 Storage；
- 接纳一条领域结果不会自动触发该 Literature 的全 Provider 精确补查、PDF、Parsing 或 Analysis，Metadata API 不接收 Collection 或 Batch 状态；
- 新的 MetadataObservation 成功接纳时，在同一逻辑提交中清除对应 Literature 的自动 PDF 获取耗尽事实；重复幂等提交不制造 observation 或额外状态；
- 两个以上供应商同时成功；
- 一个供应商失败、其它供应商成功；
- 单个供应商分页中途失败；
- 不完整元数据仍形成中性 observation；
- DOI URL、`doi:`、大小写和边界空白通过公共 Identifier 边界形成同一小写裸值；arXiv 前缀、官方 URL、新旧式与 `vN` 形成同一基础 ID；各 adapter 不维护不同 normalization；
- 当前记录自身的官方文献 ID、Provider record identity 和相关版本 ID 被分别放入 `metadata.identifiers`、`provenance.source_record_id`/`ProviderLiteratureKey.record_id` 与 `version_links`；
- OpenAlex Work ID、Web of Science UID、Semantic Scholar Paper ID 和 Scopus EID 不进入 `LiteratureMetadata.identifiers`；正式 DOI 记录的相关 arXiv ID 不会误并到正式 Literature；
- 同一 observation 可以分别携带元数据、版本角色、明确同文献版本连接、来源声明关键词、原始参考文献文本、两类次数和资产线索；
- observation 使用公共 `Provenance` 表达供应商来源，不在顶层重复 provider、provider record ID 和观察时间；
- 同一 Literature 可以关联多个长期保存的 observation；相同 observation 重放幂等，新的来源观察新增对象而不覆盖旧值；
- `version_links` 中每个 key 至少具有非空供应商记录 ID 或稳定 Identifier，只接受同文献版本声明，不接受更正、撤稿、引用、本地 Literature ID、状态或目标 metadata；
- `version_links` 目标未解析或存在冲突时保留 observation，但不创建占位 Literature、独立 `LiteratureRelation` 或 MetaLiterature 归属；
- `reference_texts` 保持来源顺序且不维护完整性字段，空列表只表示当前 observation 没有返回原文；
- 一个供应商响应中的每条结构化有向边分别形成一个 `ProviderRelationObservation`，多条边可以共享调用 Provenance 但不能共享 observation ID；
- `ProviderLiteratureKey` 至少具有非空 record ID 或稳定 Identifier，citing/cited 规范化方向明确且不能相同；
- relation observation 可以在目标尚未入库时独立保存，不携带本地 ID、目标元数据、扩展状态或任务状态；
- 只有当前引用扩展范围选中的 relation observation 才解析目标并可能形成 Literature、Reference 和 `ProviderRelationSupport`，保存 observation 本身不触发递归；
- 专门引用 endpoint 和普通元数据响应中的相同语义映射到相同中性结果；结构化关系与原文只按目标是否稳定明确区分；
- `reference_count` 与 `cited_by_count` 分别映射、保持非负且不跨供应商合并；
- 作者保持供应商署名顺序，明确的姓名组成、ORCID、作者单位对应关系和 ROR 不丢失；机构作者与未知类型能够中性表达；
- Adapter 不机械拆分姓名、猜测 ORCID/ROR、按模糊姓名合并作者，或把无法映射的全部单位分配给全部作者；跨来源作者补齐只由 Literature 执行；
- 传统页码、页码范围和电子文章定位号都确定映射到 `pages`，不产生 `article_number`；
- 多个直接文件和落地页地址分别形成多个 `AssetHint`，且直接地址、媒体类型、资产角色、版本角色、访问状态和许可证不会丢失；
- 供应商内部记录 ID、自动 topic、搜索分数、分页 cursor 和完整 vendor 对象不会误入文献元数据或资产线索；
- 标题和 DOI 都缺失时形成稳定单条拒绝，不发布已接纳的文献或来源 observation；
- `declared_keywords` 不直接进入 `LiteratureMetadata.keywords`，也不与 LLM 关键词混合；
- 供应商附加信息不会污染 `LiteratureMetadata`；
- 不同供应商的两类次数不会相加，资产线索不会被接纳为当前资产；
- Vendor 未知字段、错误类型和缺失字段被边界处理；
- 同一输入重复运行不制造无意义 observation；
- Vendor 和 HTTP 类型不进入公开 API 或 Model；
- 凭据与底层异常不会进入持久化失败或用户输出；
- Provider secret 只由配置边界注入 adapter，不进入 Metadata Model、Port、AccessScope、observation、日志或 fixture；`config status` 不调用 Network，配置测试经显式授权才请求外部服务，不产生文献事实；自动回归使用 fake Network；
- 同一 API quota 被 Metadata search、reference query 与 Acquisition 共用时，在当前进程使用同一 AccessScope；不同供应商仍可逻辑并发，但真实请求分别服从其共享 policy；
- `429`、`Retry-After` 和 quota 阻塞会限制同一 scope 的其它调用方，取消或重跑不能立即绕过；
- 缺失 policy、vendor SDK 绕过受控 transport 或 adapter 私建局部 limiter 时 readiness/架构检查失败；
- 出版社名称维护：规则与别名归类保留来源原文；范围扫描区分 resolved、unknown 与 conflict；AI 建议保留输入 hash 与模型来源，须显式接纳；配置 revision 变化或站点、别名冲突时拒绝旧建议；名称不能独自启动文章 API，也不证明授权；
- 未提供生产 client 的选择键不能被写成可用集成。

测试使用 fake provider 和本地 transport，不访问真实供应商。

### 3.9 查询隔离与请求时凭据

Metadata 的 search/lookup/reference 都可能访问外部服务，属于显式维护范围。库内 search miss、分析缺引用或提取未找到字段，不直接调用这些接口。只有原操作已声明引用发现/外部 lookup 的维护流程，才能继续物化目标文献；一般知识读取返回材料缺口。

普通 Provider 选择和 scan limit 来自本次 Application 配置快照，CLI 未指定 `--scan-limit` 时消费已保存值；显式参数只覆盖本操作，不改写配置。`sources.metadata.limit=7` 表示每个已选择 Source 最多扫描 7 条原始 item，不是最终去重后文献总数。

引用发现 Auto 的执行顺序由 Metadata registry 在既有选择集合内根据 Credential owner 的非敏字段存在性稳定排序：有凭据者在前，公开匿名者在后；Custom 顺序保持不变。Entry 对每个 BFS 节点按顺序消费完整分页，只有正常耗尽、有可用关系且已识别范围内全部目标时才短路后续来源。目标必要 lookup 优先使用关系来源，再按当前优先级尝试其它来源；跨来源 key 移除私有 `record_id`，只携带共同稳定标识。所有精确补查消费调用来源的剩余 raw-item 预算；没有共同标识时，不向其它来源发送私有 ID。 两层扩展在用户边界内处理完第一层接纳的全部节点，再统一去重；未完成或存在缺口时，不把阶段数量表述为完整的两层结果。

引用运行的 `failure` 汇总与本来源能否继续调用分别处理。目标 404、记录转换或单节点失败只留下诊断，不把整来源设为终止；鉴权/授权失败和 429 暂停该来源，扫描上限停止本来源，其他独立来源继续。存储异常不被吞掉，取消不触发后续来源。已有结果且存在失败时报告 `PARTIAL`；无结果且全部实际尝试来源失败时才为 `FAILED`。`source_results` 只包含实际引用查询或目标 lookup 尝试过的来源，完整选择范围仍保留在 `providers`；未调用不等于 `EXHAUSTED`。种子在引用环中再次出现时保留边和来源支持，但不作为新增发现结果计数。上述变化不新增 catalog schema 或配置字段。

需要认证的 adapter 在每次请求前通过 Configuration owner 复核当前字段。Elsevier/Springer/Web of Science 的必需凭据缺失在 transport 前失败；可匿名来源保留匿名行为。Startup readiness 与 request admission 使用同一必需字段定义，避免“配置页显示可用，调用却无需 key”的分歧。已成功来源的 observations 不因后续来源认证失败而撤销。

### 3.10 来源端点与关系结构

`ProviderLiteratureKey` 是供应商文献记录的中性定位，只包含可选 `record_id` 和稳定 `Identifier[]`，且至少具有其中一种定位。`MetadataObservation.version_links` 用它定位同文献其它版本；当前端点由父 observation 表达。`ProviderRelationObservation` 用两个 key 表达一条规范化 `citing -> cited` 有向引用边。两种用法都不接受本地 Literature ID、目标 MetadataObservation 或状态字段；Model validator 只检查封闭结构、至少一个定位值和非空格式，不决定版本归属、目标接纳或 Reference 建立。精确合同见 [MetadataObservation 来源输入](#25-元数据来源与字段裁决)与 [ProviderRelationObservation](#352-providerrelationobservation)。

### 3.10 来源目录与安全测试

Provider definition 拥有展示名、四列用途所需能力、公开字段描述和 `sourceFixture.version`。Configuration owner 产生 `SourceDirectory`：恰好 15 家来源，Browser 为独立 builtin 测试；Metadata 三种用途共用一份选择，PDF 独立。目录区分本地 ready、当前 Application selected 与 pending；配置-only 进程 selected/effective 为空，不伪造已在用。当前生效与待生效路线使用同一 plan，direct → publisher-api → general-api → public-web → Browser；同阶段保留既有排序，DOI landing 在 Sci-Hub 前。Metadata Auto 见 ADR 0043，PDF 镜像默认见 ADR 0040。

来源保存只接一个来源的小对象和封闭字段动作。目录 CAS 包含普通配置 revision 与凭据文件发布身份元数据，不包含秘密内容 hash；binding revision 只取非秘密配置与组装所需的 presence，所以同 presence key 轮换不自行要求重启。单字段 clear 不删除其它 key。全部校验后持 configuration 锁，依次发布凭据、普通配置及非秘密缓存。每个文件保留权限、链接防护、临时文件/fsync/rename；跨文件不宣称事务，中途失败返回 typed partial 与 committed_fields，不回滚已发布事实。保存成功但测试接纳失败仍返回 saved，并用可选 test_problem 说明测试未启动。

显式来源测试使用一个长寿命 dispatcher，共用 Application Network。固定公开 DOI 或原生 ID 在 provider 就近维护；Metadata lookup 的 scan_limit=1，PDF 只执行该源的一个逻辑原生获取并经共享 PDF reader 验证，不升级其它源/Browser、不发布文献或资产。全部测试串行；相同 request/revision 幂等，同源在途复用，旧 revision 的晚结果拒绝覆盖新状态。Browser 只用已安装 Cloak 和可销毁临时 profile 启动/关闭；PLOS 不伪造 adapter。

`SourceProblem.display` 只有 error、not-configured、credential-invalid、no-fulltext-permission。裸 403 与挑战不足以证明全文权限；只有原生协议明确认证已接受且全文授权拒绝才使用最后一种。其它请求失败统一 error，正常空结果不算错误。安全技术详情只携带稳定 code、scope、白名单字段名和有界数字，不保存 URL、headers、cookie、响应或页面文字。

最近结果保存在可删除重建的 source-state.json，而非 catalog。只保存发布身份、非秘密 generation、方法版本和最多 15+Browser 条安全结果，0700/0600、原子发布。来源变更只使本来源失效，外部未知文件修改保守全失效；测试进度/结果不改变配置 CAS。GET 不写缓存，缺失/损坏不阻启动。运行绑定与平稳重启见[配置交互](01-product-interface.md#43-配置交互)。

## 4. 材料获取、路线与候选

### 4.1 独立材料供给与人类介入

按 [ADR 0026](../decisions/0026-agent-knowledge-and-human-collaboration.md)，Acquisition 独立交付已验证原始材料，Analysis 不适用不直接撤销已接纳资产。TypeScript 生产 completion 已取消 `NoUsableContent` 自动清理；旧清理服务已删除。材料失效仍须由独立 owner 的明确决定触发。

生产 Browser 向[统一产品接口：人类工作台与知识阅读](01-product-interface.md#4-人类工作台与知识阅读)提供同会话观察/指导/必要接管能力。控制权与在途动作由共享运行时管理，Acquisition 始终执行 PDF 文件门和任务绑定，文章内容身份保持未验证（ADR 0029）；人工点击或指导不能等同下载成功。公开/API/Browser 分层与 Network 边界保持。

子能力划分及交付见[统一产品接口：共享合同、结构解析与版本兼容](01-product-interface.md#6-共享合同结构解析与版本兼容)。有效获取以文件验收、任务关联和可靠发布为终点；已取得材料可直接交付。Analysis/Extraction 消费材料引用，不了解 route、Browser 或人工介入过程。新架构没有把其他业务模块纳入 Acquisition 控制。

### 4.2 当前实现与内部职责

```text
apps/server/src/acquisition/
  assembly.ts                 # Source 选择、凭据/Network adapter、路由拆分
  tiered.ts                   # 分层调用、候选结果和失败分类
  sources/public.ts           # 公开来源 registry 与受控下载
  sources/locators.ts          # 中性候选与定位线索
  sources/route.ts             # 路由 adapter
  providers/authorized.ts     # 授权内容 API
  pdf-acceptance.ts           # PDF 字节/reader 检查
  identity-verdict.ts         # deprecated 公共工具；不参与下载
  candidate-acceptance.ts     # 验收编排
  candidate-publication.ts    # 候选到不可变资产/关系的发布回执
  candidate-cleanup.ts        # 未接纳临时/候选字节清理
  candidate-abandonment.ts    # 显式放弃候选
  browser-intake.ts           # Browser/手动材料的统一 intake
apps/server/src/entry/pdf-acquisition.ts # 操作内 cohort、代次和 BrowserSessionBroker
apps/server/src/browser/                # page/runtime/flow/observation/control/transfer
```

访问方解析、计划、候选执行、文件验证、文章归属及最终发布是不同职责。当前 `PdfAcquisitionPort` 将这些能力交给 Entry，字段及行为不能因内部拆分丢失。下文 `PublisherAccessProfile/Resolution/Plan` 表达访问决策模型；它们不意味着当前目录存在同名 Python 文件。

普通 HTTP 和授权 API 经共享 Network，受控 Browser 经 Host/broker 与同一 admission。controller 只解释稳定 Observation 并返回下一封闭动作，不持有发布权限。配置、policy、route 可用性、文章权限和候选验收分别判断。

仅属于内存定位的 source candidate/tried set 不作为文献事实保存；已有 Browser transfer 的 `DurableCandidate`、`CandidatePublicationIntent/Receipt` 则按 execution 合同保存受控交付状态。两类候选不能一律描述为不持久化，也不能把恢复回执当作已接纳 PDF。

### 4.3 输入与公开结果

完整目标接口见[输入与公开结果](#91-输入与公开结果)；当前实现以源码为准。

### 4.4 Access Profile、运行时计划与五层 Route

本节只描述自动获取。手动接纳不注册自动 Route，也不进入下列层级。

目标实现把“识别原文访问方”“制定本次路线”和“执行 HTTP/API/Browser”分开：

```text
PublisherAccessProfile catalog
  + LiteratureMetadata / identifiers / observations / AssetHints
  -> PublisherAccessResolution
  -> AcquisitionPlan grouped by acquisition stage
  -> route adapter execution
```

一个外部机构可以具有多个独立 route adapter，例如公开 locator、授权内容 API 和 Browser 页面流程；它们共享 access profile 和 Network，但不挤进一个带大量可选参数的 vendor 接口。Planner 不执行真实 Provider 请求，adapter 不重新猜测当前 Literature 应属于哪个访问方。

#### 4.4.1 PublisherAccessProfile 与访问身份

Acquisition 私有、无 secret 的静态画像至少表达：

```text
PublisherAccessProfile
  access_key
  platform_key
  landing_origins
  asset_origins
  stable_id_kinds
  weak_hints
  public_capabilities
  api_capabilities
  browser_probe_enabled
  policy_evidence / policy_revision
  production_status
  evidence
    display_name / product_name
    official / access-terms / rate-limit references
    verification_date / evidence_revision
    Provider Notes / offline fixture reference
```

`Metadata Provider`、`Publication/Access Provider` 和 `Access Platform/CDN` 是三种身份。ACS、IEEE、
RSC 等访问方可以拥有 Profile，而不加入 Metadata Provider 枚举或创建不需要的 API secret。

Profile 只包含经过核实、可静态验证的 origin、ID、Public/API capability、政策证据，以及是否支持
显式 Browser 可达性 probe；不再引用或安装 Browser route、页面程序、selector/locator、限速组或
会话组。统一状态只有 `production-ready`、`fixture-verified` 与 `unsupported`，但该状态不决定
通用 Browser 是否可用于某个网页。`browser_probe_enabled` 只让 `config test browser site` 对已知
目标执行只读可达性检查，不下载 PDF，也不证明登录、权限或 Browser 获取适用性。当前字段与矩阵
见 [Publisher Access Profile 准入与验证矩阵](../../notes/providers/publisher-access-matrix.md)。

#### 4.4.2 PublisherAccessResolution 与 AcquisitionPlan

Planner 首先消费已经接纳的中性证据；已有明确 direct-file、公开仓储或稳定公开定位时，不为了识别出版社额外解析 DOI。需要确认访问方且当前出版社 API 规划缺少强证据时，DOI safe resolve 可以作为 API 之前的有界定位动作：读取受控 resolver 的安全 Location，不提前执行公共网站下载。public-web 阶段可以通过共享 Network 逐跳请求文章页面与静态 PDF；Browser 使用自己的文章平台许可与页面传输。已有响应、实际 landing 与安全 locator 只在当前 work item 复用，不增加必经 HEAD/GET 预检。全部证据可用时按以下强度解释：

1. DOI 经 Network 安全解析后的实际 landing origin；
2. 访问方自有的 `AssetHint` origin；
3. arXiv ID、PMCID、Elsevier PII/IEEE arnumber 等来源明确的稳定文章定位；
4. MetadataObservation provenance 中的 Provider record identity；
5. publisher 原文、明确别名或单独 DOI prefix 只形成待确认弱候选。

多个强证据冲突时保持 unresolved 或形成稳定失败，不能按 catalog 顺序任选一个。MetadataObservation 来自 Scopus 不表示文献由 Elsevier 出版；Crossref 返回 Wiley 文献也不改变原文访问方。

已知出版社名称使用 Provider 本地 `publisherAliases`，用户确认扩展在普通配置 `sources.publisher_aliases`。名称按 NFKC、空白和大小写确定性处理；显式维护扫描来源 observation 的原文与有界上下文，选择 AI 时只生成带输入 hash/provenance 的建议。独立接纳核对站点/别名冲突并用配置 revision 防止覆盖并发修改，不覆盖来源、文献身份或期刊原文。未知、冲突和未处理名称保持可见，不阻断其它有依据的获取路线；不新增 Literature 字段或 catalog 表。

名称解析唯一命中一个 Provider ID 时，只把当前 publisher-api 阶段中已选中的同名来源稳定排到前面；其余来源仍保持配置顺序，未知或冲突不改变优先级。此调整不删除来源、不自动启用服务，实际调用仍须通过 `authorizedTargets` 的文章级站点/专用标识证据。

运行时合同为：

```text
PublisherAccessResolution
  selected_access_key: str | None
  platform_key: str | None
  confidence: confirmed | unresolved | conflicting
  evidence: tuple[redacted resolution evidence, ...]
  canonical_landing: safe locator | None
  stable_article_ids: tuple[neutral stable id, ...]

AcquisitionPlan
  revision
  direct_routes
  publisher_api_routes
  general_api_routes
  public_web_routes
  browser_routes
```

每个 planned route 具有稳定 route key、获取阶段、独立认证/传输类别、适用证据、预期 capability、readiness 和 quota/risk-group identity，但不含 secret、HTTP response、Browser 对象或不可脱敏 locator。Planner 可以省略确定不适用的 route，不能把 Browser 排到一个仍适用的公开/API route 之前。相同输入产生相同 plan；层间新 hint 只增加新的 plan revision，不修改已接纳的 MetadataObservation。

目标 Acquisition 能力范围覆盖：

```text
arxiv
crossref
semantic-scholar
openalex
europe-pmc
unpaywall
elsevier
springer
wiley
datacite
core
sci-hub
```

这里使用稳定 Provider key；`springer` 表示 Springer Nature，`sci-hub` 表示 Auto 默认、Custom 可关闭的 locator Source。resolver 使用当前版本 bundled mirror set；`sources.acquisition.sci-hub.urls` 可以用一到八个有序 HTTPS 镜像完整覆盖 bundled 列表，测试/内部显式注入 resolver 又优先于两者。三种选择都只对 canonical DOI 形成 landing locator，按序执行、不并发、不自动发现镜像。这里的“覆盖”表示相应服务能够贡献 PDF 字节、直接 locator、落地页或受控内容路径，并不要求每个名称都复制一套下载 adapter。Crossref、OpenAlex、DataCite 等 Metadata adapter 已经给出 `AssetHint` 时，由通用公开 route 消费同一线索；不为名称对称再实现只转发相同 URL 的 route adapter。Web of Science 和 OpenCitations 当前不作为原文来源。以上是目标矩阵，不证明当前代码或安装产品已经接入。

Acquisition named Source 由 Configuration 的本地 Auto/Custom resolver 选择。Auto 是版本默认公开集合，加上必要配置齐全的授权 API 和通用 API；只消费凭据字段存在性或普通必填参数，不读取授权值，不执行 DNS、HTTP 或权限探测。配置不齐的来源不加入，也不报配置错误；Sci-Hub 使用内置镜像加入 Auto，Custom 可明确关闭。具体当前来源和参数由[配置手册](../../guides/configuration.md)维护。Custom 精确保留用户列表，不因凭据变化扩展；显式选择但不可用的来源保留稳定原因。五层顺序固定，阶段内保持原顺序，出版社 API 可按单篇唯一名称候选稳定优先。

所有模式继续自动加入 direct 与 DOI landing；已有 `AssetHint` 不依赖同名 Provider enablement。Browser 由 `[browser]` 独立启用。Application 冻结当前路线；配置状态返回 `acquisition_routes`，包含执行顺序下的 `effective`、已保存配置对应的 `pending` 与差异/重启标记。路线只含来源、阶段、`mode_reason`、本地 ready 和可选稳定不可用码。没有运行时的配置进程必须返回 `effective=null`，不得声称这是其它进程的生效状态；Browser 的运行时健康也不能从 pending 配置预测。此选源决定见 [ADR 0039](../decisions/0039-configured-acquisition-auto-and-traces.md)。

`public:sci-hub` 复用共享 `PublicLocatorFetcher`。每个镜像 hostname 自动得到独立的保守 web
scope；landing 可直接交付 PDF，或通过有限静态声明（`citation_pdf_url` 与明确
`application/pdf` 的 `a/link/embed/object`）发现 locator。它不执行 JavaScript、不猜 selector、不
处理认证或 Challenge。Landing HTML 与发现候选仍先经过实际 PDF 字节、reader 和页面树检查；
最终 provenance 不保存镜像 URL、query 或页面内容。Registry/status/Planner 组装不执行 DNS 或
HTTP，所有测试使用 fake/fixture。

`direct` 只是消费已保存 locator 的通用公开 route，不是 Provider；手动 PDF 是用户明确绑定 Literature 的独立接纳操作，也不是 Provider 或第四种 `AcquisitionPath`。

Acquisition 把每个 planned route 放入一个且仅一个执行阶段，和认证/传输类别分别表示。当前 TS 四个 HTTP 阶段为：

```text
AcquisitionStage = direct | publisher-api | general-api | public-web
```

Browser 是第五层，由 Entry 独立受控 delivery 接纳。旧概念 `AcquisitionPath` 继续描述传输/认证方式，不再表示执行顺序：

```text
AcquisitionPath =
    "public"
  | "authorized-provider-api"
  | "controlled-browser"
```

阶段由 Provider 本地 `acquisitionStage`、通用来源定义与生产对象图共同决定，不由 Provider 响应或 `AssetHint.access_status` 临时改写。Route adapter 可以使用：

- 已持久化并在使用时重新验证的 URL；
- 稳定标识符对应的来源 API；
- 供应商记录提供的资产线索；
- 受控浏览器页面流程。

目标概念 Port 为：

```text
PdfRouteAdapter
  name: str
  capabilities: tuple[RouteCapability, ...]
  readiness: RouteReadiness
  execute(
    planned_route,
    acquisition_context,
    excluded_candidate_keys
  ) -> one-or-more RouteExecutionOutcome

RouteExecutionOutcome =
    TemporaryPdfDelivery
  | AccessRouteHintsDiscovered
  | NormalRouteMiss
  | RouteDeferred
  | RouteActionRequired
```

Planner 已经决定当前 route 的适用证据；adapter 只验证 planned route 属于自己的封闭 capability，并在每个真实动作前检查 candidate/route key、Network admission 和取消。DOI 型授权 API 只有在当前 Literature 恰有一个 canonical DOI，且合同列出的 landing origin 或 AssetHint origin 已精确确认访问方时才形成 lookup target；AssetHint 只贡献规范 origin，原始 URL 不进入 target。Adapter 不能自行根据 publisher 文本、DOI prefix 或 Metadata Provider 名称增加其它 Provider 路线，也不能把 API 429、临时错误或页面 challenge 转换成 Browser route。Route adapter 只产生临时运行结果，不能发布 Asset、建立 `primary-pdf` 关系或改变 Literature 状态。

`RouteReadiness` 区分项目能力已实现、用户启用、静态参数/凭据/policy 就绪、当前 Literature 适用和当前 plan 实际需要。配置结构错误立即失败；未被当前 plan 使用的可选 capability 不阻止无关公开路径。当前 plan 需要但未就绪的 route 不能被计为正常耗尽，是否允许进入 Browser 由显式 Browser admission policy 决定并进入运行报告。

API capability 必须明确区分：

```text
metadata/search
locator/resolution
entitlement-check
structured-full-text
direct-pdf
multi-step-pdf-object
```

只有实际 PDF bytes 形成 `TemporaryPdfDelivery`；XML/JATS、canonical landing、稳定 object ID 或 entitlement 信息只能形成相应的运行时 hint/status，不能冒充主 PDF。

#### 4.4.3 AssetHint 合同

`AssetHint` 表示 Metadata 供应商在一次 observation 中返回的单个资产访问线索。它不是已经下载的资产，也不是候选尝试记录。精确 schema 为：

```text
AssetHint
  url: str
  kind: AssetHintKind
  media_type: str | None
  asset_role: AssetRole | None
  version_role: VersionRole | None
  access_status: str | None
  license: str | None

AssetHintKind = "direct-file" | "landing-page"
AssetRole = "primary-pdf" | "supplementary-pdf" | "xml" | "html" | "supplementary"
VersionRole = "published" | "accepted-manuscript" | "preprint" | "other"
```

字段含义为：

| 字段            | 含义                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `url`           | 供应商返回的绝对访问地址；同一 observation 中的不同地址分别形成不同线索                                |
| `kind`          | `direct-file` 表示供应商声明地址直接指向文件，`landing-page` 表示需要从页面继续发现或触发下载          |
| `media_type`    | 供应商声明的媒体类型，例如 `application/pdf`、`text/html` 或 `application/xml`；未知时为空             |
| `asset_role`    | 地址所指向的主 PDF、补充 PDF、XML、HTML 或其它补充资产；供应商没有明确说明时为空                       |
| `version_role`  | 地址所对应的正式发表版、作者接受稿、预印本或其它版本；供应商没有明确说明时为空                         |
| `access_status` | 供应商在 `MetadataObservation.provenance.observed_at` 观察到的开放、受限或其它访问状态；使用开放字符串 |
| `license`       | 供应商返回的许可证标识或许可证 URL；没有可靠信息时为空                                                 |

Provider identity、provider record identity 和 `observed_at` 由所属 `MetadataObservation.provenance` 提供，不在每个 `AssetHint` 中重复。`AssetHint` 不保存请求 header、cookie、凭据或 vendor 私有对象；`url` 仍是不可信外部输入，每次 HTTP、redirect 或浏览器导航都必须重新经过 Network policy。

`kind`、`media_type`、`asset_role` 和 `version_role` 都是供应商声明的线索，不是 Acquisition 已验证的事实。`access_status` 和 `license` 描述具体访问渠道，不属于 `LiteratureMetadata`；它们也不证明链接当前可访问、响应是 PDF 或内容有效。

#### 4.4.4 Route hint、候选与 adapter 边界

`AccessRouteHint` 表示当前运行中已经确认、可以改善后续计划但尚未取得 PDF 的中间结果，例如 canonical landing、来源明确的稳定 article ID、可安全表达的 PDF object locator 或具体 entitlement 状态。Hint 必须是封闭中性类型，携带来源 route、适用 access profile 和脱敏值；它不保存 header、Cookie、token、完整 vendor response、Browser object 或无法去除 secret 的签名 URL。必须依赖短期签名 locator 的多步请求留在同一个 adapter 私有流程中立即消费，不跨 Port 暴露。

Hint 只更新当前 work item 和 plan revision，不写入 `MetadataObservation`、`LiteratureMetadata`、Catalog、ArtifactStore 或 provenance。新操作不会恢复旧 hint；同一操作的后续 route 可以使用它减少重复 DOI 解析、页面导航或 locator lookup。

`PdfCandidate` 表示当前运行中一次可识别、可排除的实际 PDF 获取动作，不再假设所有动作都是一个可由通用 fetcher 直接请求的 URL。公开 URL、需要多步请求的 Provider API 和需要导航/点击/捕获的 Browser 流程都由各自 adapter 执行。候选精确合同为：

```text
PdfCandidate
  candidate_key: str
  source_name: str
  acquisition_path: AcquisitionPath
  declared_media_type: str | None
```

`PdfCandidate` 只存在于当前获取运行中。`candidate_key` 是当前运行 tried set 使用的非空稳定键，不是资产 ID、数据库身份或跨运行失败记录；它由 route、path 和不含凭据的来源内定位身份确定。同一 URL 在匿名 HTTP、授权 API 和 Browser 上下文中可以形成不同 key，因为三者可能取得不同字节。`source_name` 保留具体 route adapter 的稳定来源 identity，`acquisition_path` 只表达这次获取的风险层级；`declared_media_type` 只是来源声明，不能替代字节检查。

候选不保存或暴露 URL query secret、请求 header、cookie、凭据、API object ID、浏览器对象、页面 action 或其它 vendor 私有值，也不携带失败原因。Adapter 私有定位与多步动作留在边界内，不能用裸字典或 vendor model 扩展 `PdfCandidate`。明确为补充材料、XML 或 HTML 的线索不会形成主 `PdfCandidate`；补充资产走独立角色，不得伪装成主 PDF。

Route adapter 取得字节后向 Acquisition Service 交付 Port 内部临时结果：

```text
TemporaryPdf
  candidate: PdfCandidate
  content: bounded byte stream or owner-only temporary artifact
  safe_source_url: str | None
  provenance: Provenance
```

`TemporaryPdf` 不是业务 Model，不进入公开 API 或数据库。`safe_source_url` 只在能够去除凭据、敏感 query 和 fragment 时提供；`provenance` 记录具体 source 和输入 hash，不复制 Cookie、header、浏览器 profile 或页面对象。普通 HTTP 直接下载、多步授权 API 和浏览器 download/response 捕获都必须交付同一种临时结果，随后由 Acquisition 执行统一 PDF 基本检查。

Plan 固定按以下顺序组织 routes，同阶段以配置顺序为基础，出版社 API 可按唯一名称候选稳定优先，凭据类别不决定阶段：

1. **direct**：受支持资产线索中明确 PDF 媒体类型/主 PDF 角色，或 URL pathname 中忽略大小写的 `.pdf` 后缀；arXiv ID 与 PMCID 的稳定公开 PDF 定位也属于本层。保留 query、去除阅读器 fragment，排除明确非主 PDF 角色、目标版本冲突与已登记授权 API 地址；
2. **publisher-api**：Elsevier、Wiley 等专用 API，仅调用已配置、就绪且有文章级适用证据的内容服务；
3. **general-api**：CORE、Unpaywall 等聚合/开放获取 API，是否需要凭据仍按所属 adapter 合同；
4. **public-web**：DOI/文章 landing 的有界 HTTP 与静态 PDF 解析、Auto 默认或 Custom 明确选择的 Sci-Hub 网站，固定在 DOI 落地页之后；
5. **browser**：只处理前四层结果允许继续且独立准入的剩余目标，消费有序文章入口，使用一个
   operator-managed 固定身份 Profile、共享有头 CloakBrowser Chromium process/context 和隔离文章 page。
   Browser 只使用通用 `AgentBrowserController`；Agent 从第一次稳定 Observation 起选择封闭动作，
   Network 负责动作绑定、页面稳定化与捕获，Acquisition 负责 PDF 文件验收与当前任务关联。无 GUI Linux 使用
   Xvfb；登录、MFA、拒绝或未找到等页面状态仍交给 Agent 观察，只有 Agent 明确 Stop 或硬性运行时
   边界才结束本次会话。

每篇 Literature 依次完成 direct、publisher-api、general-api、public-web，最后才形成 Browser admission 集合。每层产生的新 landing、stable ID、locator 或 entitlement hint 更新 Resolution/Plan；新取得的 locator 立即由原机制下载，不重新排队到 direct，成功的目标立即离开后续 Acquisition 层。Planner 可以删除确定不适用的 route，但不能因为当前网络出口可能具有机构 IP entitlement 就跳过一个仍适用的公开/API route。

CORE 的明确公开 PDF `downloadUrl`/source link 由 direct 消费；尚未获得有效主 PDF 且结果允许继续时，
在 general-api 阶段调用已配置的 CORE 注册用户 download endpoint。CORE
Metadata 与 Acquisition 使用相同 `core/api` AccessScope 和保守准入政策，使 token/quota
反馈作用于同一当前进程预算。API key 只作为绑定到官方 HTTPS origin 的私有
`Authorization` header 传递，不进入 URL、候选、provenance 或输出。

Wiley 位于 publisher-api 阶段，先于通用 API 和公共网页。当前唯一 DOI 可以与已接纳 AssetHint 的
Wiley Online Library（含已登记子域）、官方 ALM origin 或精确绑定的 TDM 提示关联；若现有
证据仍不足以确认 Wiley，按需通过共享 Network 执行一次有界 DOI 定位，结果必须符合 Provider
本地声明的域名/origin 规则。名称别名只能提出候选，不替代这些文章级证据。两条路径都只形成 DOI 与 confirmed origin
组成的中性 lookup target，再把 DOI 作为 opaque path parameter 交给 Wiley TDM endpoint。
唯一的 TDM token 只作为绑定到
`https://api.wiley.com:443` 的私有 `Wiley-TDM-Client-Token` header 传递；本地只验证
安全的非空 header 值，不用推测的 token 语法替代 Wiley 的认证判断。API 可以单跳到精确
`https://alm.wiley.com/alm/api/v2/download/<opaque-locator>`；共享 Network 逐跳复检该
Provider 专属路径，并在跨 origin 前移除 token。Wiley 本地 lookup 保持 entitlement
`UNKNOWN`；服务实际交付该目标的 PDF 才证明本次取得文件，媒体类型本身不证明 entitlement。`404`
是正常 miss；认证、授权、quota、服务、schema、非 PDF 和 Network 失败形成该 route 的
稳定失败；能否继续与升级由 ADR 0015 §7 分别判断，认证、权限、限流和 API 临时错误不得由 Browser 静默掩盖。即使响应
为 200，字节仍进入统一 PDF reader/页面树与不可变发布边界。

Elsevier 内容获取使用独立的 `api:elsevier-article-object` 多步 route。只有 PII、合法的
`1-s2.0-*` Article EID，或 DOI 已安全解析到 ScienceDirect/linkinghub origin 才构成
强适用证据；Scopus metadata observation 与普通 `2-s2.0-*` EID 不构成内容身份。
Adapter 以 `view=FULL` 和 `Accept: application/xml` 请求 Article Retrieval，只把同时
声明 `web-pdf-purpose=MAIN`、`extension=pdf`、PDF filename 与合法 attachment EID 的
条目转换成 `elsevier-main-pdf-object` locator，再以 `Accept: application/pdf` 请求
Object Retrieval。若 FULL XML 没有 MAIN object，或该 XML 表示因媒体类型冲突、畸形、
DTD/ENTITY 或未知 envelope 而不能安全解释，Adapter 不放宽 XML parser，而是用同一强 DOI、
PII 或 Article EID 形成私有的 direct Article PDF locator，并向相同 Article Retrieval
resource 协商 `application/pdf`。可解析的 `service-error` 必须先转换为 normal miss、认证、
授权、quota、服务或请求失败，不能借 direct representation 绕过。Article/Object 共用
`elsevier/api/article-retrieval-object` scope；
API key 与可选 institution token 只作为绑定到 `https://api.elsevier.com:443` 的私有
header。Object 或 direct Article PDF 正常 miss 后可返回当次 canonical landing、PII 和
Article EID hint；hint 不进入数据库。两种 PDF 响应都仍经过统一 PDF reader、页面树与
不可变发布；XML/JSON/HTML、补充材料和标记为 PDF 但实际承载错误 envelope 的响应不会成为
候选。Authorized adapter 的 Debug classification 对每个 lookup/download 只增加数值
`http_status`、受控 `informational|success|redirection|client-error|server-error` 状态类别、
representation、envelope、disposition 和中性 failure kind；response body、vendor status text、
header、URL/query 与凭据都不进入 LogRecord。ScienceDirect 的 API route 与 `elsevier` rate/session group 独立于唯一通用
`browser:generic` route；其 landing hint 仍只能在强访问方证据、显式 Browser 启用与 Browser
admission 共同满足时使用，不能把 API miss、quota 或错误本身当作自动启动 Browser 的授权。

前一层全部当前适用 routes 均未成功并到达允许升级的终态后才能启动下一层；层级之间不并发竞速。未启用或对当前 Literature 不适用的 route 不属于本次耗尽集合。当前 plan 需要但缺少生产实现、必需参数、凭据或 policy 的 route 形成明确 unavailable/configuration 结果，不能被静默视为正常未命中；是否允许继续 Browser 由 Browser admission policy 决定。

正常未命中与已识别来源失败都允许后续独立渠道继续。API 请求、认证、权限、服务及外部响应格式错误不决定 Browser 的机构 IP 访问能力；`retryable` 只决定是否适合重试本来源。`429`、`Retry-After` 与 quota 停止本来源剩余候选并保留冷却，所有后续请求仍经过共享额度组/平台准入。取消、内部合同、存储、清理、发布和 stale 错误保持停止语义。任一候选完整提交后立即停止该 Literature 的后续获取；最终未成功时保留未解决故障，不伪装成正常耗尽。人工协助仅在自动路径尝试结束后应用，见 ADR 0015 §7。

明确标记为补充材料、XML 或 HTML 的线索不能作为当前主 PDF 接纳。供应商声明的 `application/pdf` 可以提高同层候选顺序，但不能替代实际下载和基本检查。

`AssetHint` 不增加 `acquisition_path`、`requires_browser` 或 `requires_authorization`。它保存来源当时声明的线索；同一线索可以先匿名尝试，之后由相应授权或 Browser route 使用，但每次真实访问仍受自己的 Network scope 和 candidate key 约束。

每个 `sources/<source>` 或 `providers/<provider>` adapter 负责 endpoint、请求字段、API AccessScope 和官方政策声明、quota/`Retry-After` 解释、候选/hint 转换和来源失败边界。`PublisherAccessProfile` 只保留授权 API 所需的 access identity/origin，以及可选 Browser 首页可达性 probe；它不拥有 Browser 下载策略。Network 负责中性准入和 Browser runtime，Acquisition 的统一 PDF identity validator 负责主文献、supplement 与错文判断。普通 HTTP、API SDK 和 Browser 执行必须经过 Network 的共享访问准入。

Adapter 不能把候选直接写成当前主 PDF，也不能执行 Literature 身份判断、正文语义判断或状态推进。

#### 4.4.5 Asset 与 LiteratureAsset

候选通过基本检查后形成两个不同的持久化事实：

```text
Asset
  asset_id: AssetId
  sha256: Sha256
  size_bytes: int
  media_type: str
  path: RelativeArtifactPath

LiteratureAsset
  literature_asset_id: LiteratureAssetId
  literature_id: LiteratureId
  asset_id: AssetId
  role: AssetRole
  provenance: Provenance
  source_url: str | None
```

`Asset` 只描述不可变文件事实。`size_bytes` 非负，`path` 是配置存储根下的规范化相对路径；Asset 不携带 Literature ID、资产角色、当前状态、来源 URL、版本角色或 provenance。

`LiteratureAsset` 表达具体 Literature 与 Asset 的角色和获取来源。`source_url` 只在能够安全保留时保存规范化、脱敏 URL；凭据、敏感 query 和 fragment 不能进入。来源身份、观察时间和输入 hash 由关系的 `provenance` 表达。关系不复制 `Literature.version_role`，也不增加 `is_current`。

同一 Literature 最多存在一项 `role = "primary-pdf"` 的 `LiteratureAsset`；这项唯一关系本身就是当前主 PDF。补充角色可以有多个，但不驱动 Parsing、Analysis 或 Literature 状态。相同 Asset 字节可以被不同关系复用，文件事实和文献归属不能因此混为一个对象。

### 4.5 获取流程

```text
冻结目标中的一个 Literature（有界 worker 独立推进）
  -> 为每个目标形成初步 PublisherAccessResolution + AcquisitionPlan
  -> direct pass：当前目标先执行已有文件/稳定公开定位
       ├─ PDF 成功：检查、发布并移出后续层级
       ├─ route hints：更新当前 work item，重新规划
       └─ 正常未命中/失败分类：保留当前运行结果
  -> publisher-api pass：只处理未解决且允许继续的目标
       ├─ PDF 成功：检查、发布并移出后续层级
       ├─ locator/identity/entitlement hint：重新规划
       ├─ 普通 route-local failure：保留问题，继续独立 route
       └─ deferred/action-required：在 Browser admission 前停止
  -> general-api pass：继续适用聚合/开放获取 API
  -> public-web pass：继续有界公共网页与静态 PDF 获取
  -> 复用实际请求结果，准备有限且有序的 Browser 入口
  -> Browser admission：仅当前目标前四层结束且允许继续时进入
  -> CONTROLLED_BROWSER pass
       ├─ 所有文章使用 browser:generic + Agent controller
       ├─ browser-generic 聚合政策 + 同平台文章网络串行/结束后30秒冷却
       ├─ 独立worker跨平台执行一轮，后台下载暂停该篇模型决策
       └─ 共享一个 Profile/process/context，每篇文章使用隔离 article context
  -> 任一 route 取得 TemporaryPdf
       -> 执行统一 PDF 基本检查
            ├─ 不通过：清理临时结果，继续当前层的其它候选
            └─ 通过：计算 hash，形成 Asset 与 LiteratureAsset
  -> Storage 不可变发布 Asset
  -> 原子提交唯一 primary-pdf 关系并清除已有耗尽事实
       ├─ 成功：AcquiredPrimaryPdf
       └─ 系统提交错误：抛出，不转换为 NoPrimaryPdf

全部当前自动 routes 没有成功且存在 deferred、action-required 或未解决 route failure
  -> 抛出/报告脱敏稳定结果，不提交 AutomaticPdfAcquisitionExhaustion

全部当前自动 routes 正常结束、没有未解决状态且候选均未成功
  -> 提交 AutomaticPdfAcquisitionExhaustion(literature_id)
       ├─ 成功：NoPrimaryPdf
       └─ Storage 错误：抛出，不转换为 NoPrimaryPdf
```

一个候选正常未命中、没有 Browser 下载、格式错误或基本检查失败时清理临时结果并继续其它候选，不把详情带入下一个候选或数据库。一个 candidate、locator、target、DOI landing 解析或 adapter 的 Network/API/认证/授权/quota/service/schema 等外部失败，在不放宽 Network policy 的前提下转换为当前运行的脱敏状态；按 ADR 0015 §7，已识别来源失败允许独立 API/Browser 继续；当前服务的限流和冷却仍有效。后续成功交付才清除该目标的未解决失败；全部未成功时保留首个未解决来源失败，不能成为“已耗尽”证据。Browser 的观察与终态仍保留在当次 Debug 事件中。逐候选定位和临时响应仍不持久化；来源级安全摘要由 Entry 交给 Jobs 的既有 durable events 保存，不成为文献事实、候选历史或自动耗尽依据。

后续 route 成功时正常短路；最终没有成功时选择稳定失败、deferred 或 action-required 结果，绝不能在尝试其它候选后伪装成完整耗尽。配置预检、取消、Port 合同、临时文件清理、发布和 stale 失败不属于可隔离的 route 失败，必须立即终止。不同候选可以有各自来源，但同一 `Literature` 只有一个主 PDF 驱动解析。候选通过基本检查并完整提交后立即形成 `ASSET_READY`，不等待正文内容判断。补充 PDF 或其它相关文件可以保存为补充资产，但不驱动 Parsing、Analysis 或 Literature 状态。

单个 Literature 内同一层的 routes 与候选按 plan 确定顺序短路，不进行跨层竞速。Entry 可以有界
在有界目标 worker 中并行处理不同 Literature；API 并发最终由官方 quota scope 门控，Browser 尝试由
`browser-generic` 聚合政策与文章平台资格共同准入；同平台网络串行，不同平台可由独立 worker
推进。等待 Network/Browser permit 不等于候选失败。

获取来源轨迹与 Debug 日志分开。每篇每来源产生有界 `AcquisitionAttempt`：`stage/source/started_at/finished_at/requested/result`，可选 `problem/technical_details/candidates`（历史 code 只读解码）；结果区分命中、正常未命中、不适用、未启用、不可用、失败、冷却和拒绝。共享 Network 只在已准入 HTTP 请求派发时提供无参数通知，不能把调用 locator 或进入阶段当作实际网络请求。Browser 升级单独产生 `stage=browser,result=escalated,requested=false`，不声称后续 Browser 的联网状态；实际派发与完成另记。首次出版社证据准备的安全计时单列 `doi-resolution`，不保存落地页。

Jobs 按目标/文献/attempt 绑定并保存 `acquisition-attempt` 事件，不新增表；HTTP、CLI、MCP 共用任务读取投影。每次单篇获取最多 64 条；任务读取最多 10,000 个来源事件并显式报告截断，按文献/attempt 聚合后同样有组内截断标记，不受普通技术活动尾部窗口遮蔽。`WorkbenchView.sessions[].prior_attempts` 可选追加最新 16 条，随文章身份进入进程内会话；旧 payload 可省略。合成会话使用同样合同。安全事件只有受限 ID、枚举、时间和计数，不保存 URL、headers、Cookie、token、响应或页面文字。后续成功不能抹去前序来源轨迹；诊断不改变五层短路、失败隔离、取消、预算或不可变发布。最终渠道事件、任务来源汇总与统计口径见[任务技术篇 10.1](02-task-coordination.md#101-获取来源记录与统计)。

**2026-10-13 当前编排：** 生产 Completion 由有界 worker 逐篇调用 `EntryPdfAcquisitionService.acquire`，
每篇内部保持五层顺序、来源隔离、实际入口证据和不可变发布，完成即反馈并补入新目标。单篇恢复不推进全操作
代次；新任务不会使仍在下载的兄弟会话过期。共享提交、取消与当前输入复检继续由原 owner 执行。

显式 `acquireCohort` 仍接受有限请求，前四层按阶段交付结果，Browser 逐篇通知；最终数组复用同一终态并保持输入顺序。
生产 Completion 不再以该接口等待跨目标 participant。已提交事实不因后续失败撤销，未解决来源故障也不被当作耗尽。
具体目标调度以 [ADR 0015 §3](../decisions/0015-publisher-aware-tiered-pdf-acquisition.md#3-单篇保持五层顺序批量有界持续补位)
及 [任务协调 §4.1](02-task-coordination.md#41-内容处理编排) 为准。

**当前实现与现场边界（完整生产 Browser 对象图）**：生产对象图与 capability-scoped
Completion 对象图都显式组装并共享同一 Profile catalog/Planner、五层获取执行器、
Browser scheduler、session broker 和 admission controller。当前生产 Application 已组装惰性
Browser host factory、Network admission、Entry delivery/Intake 边界、单篇获取执行器和
`BrowserSessionBroker`；缺少 verified runtime 或 admission 时稳定不可用。固定版本
Cloak bundle 的本机 loopback 已验证正式 Application/Entry 经 Host、capture、Intake、
acceptance 到主 PDF 提交；真实 Publisher 站点仍未运行（见
[TS 架构锚定基线 1.2](../typescript-baseline.md) 与
[ADR 0025 §2](../decisions/0025-typescript-entry-and-runtime-contract.md)）。
Publisher profile catalog 继续服务授权 API 识别与可选首页可达性 probe，但不生成 Browser 下载
route。目标生产 Browser 只有：

| Route             | Controller               | Policy group      | 运行准入                                              |
| ----------------- | ------------------------ | ----------------- | ----------------------------------------------------- |
| `browser:generic` | `AgentBrowserController` | `browser-generic` | 总开关 + image Model + Profile + runtime + 逐文章检查 |

普通 `[browser].enabled`、所选 image Model、选中且安全存在的固定身份 `profile`、CloakBrowser
wrapper、经验证的 patched Chromium binary、Playwright API 和 headed display 共同决定 Bootstrap
是否创建真实 Browser client。存在一个全局 operator-managed Browser Profile identity，不存在逐
Publisher Profile/grant 或点击规则字段；Profile presence、登录状态和逐文章 entitlement 分开判断。
Browser admission 据此报告最小剩余集合、runtime readiness、待处理动作和保守时长，只为具有安全
文章起点的 admitted work 产生 Browser 流量。Source 从已接纳的文章 landing/direct hint 或 DOI safe
resolve 形成有界文章流程；opaque AssetHint path 不直接导航。若精确起点仍是
`doi.org/<唯一 DOI>`，destination guard 只把该完整 URL 的 initial navigation、同一导航响应和受
审查重定向链视为本次入口，不会因此批准其它 resolver URL、download 或任意站点。普通文章流使用
`navigation_only=False` 和 `discard_unapproved_subresources=True`：当前已准入页面发起的必要资源
仍逐项通过 destination guard，未批准的第三方非关键子资源在 DNS 前丢弃；顶层 navigation、popup
和 PDF capture 继续 fail closed。导航期间已经捕获的 PDF 优先，否则 Agent 根据稳定 Observation
选择一项封闭动作。点击或页面脚本触发的 `3xx` 由 Chrome 原生继续；每个显式 request 逐项重审，
未再次暴露 route 的 native redirect 成员只能在同页 live ancestor、批准且预绑定的最终 origin 和
terminal host admission 都成立时关联，任何跨页或未预绑定结果都不读取 body。多路正文捕获、HTTP
attachment、跨 origin CDN、统一 PDF 文件验收、任务关联与未验证标签、通用 cooldown/circuit、共享
persistent context 中的文章隔离/临时资源清理和本地 Chromium foundation 属于目标验证范围；组件级离线 fixture 与固定 bundle 的 loopback 证明局部实现、正式接线和本机 runtime 可运行，但不证明 Profile 已登录、当前 IP、机构协议、任意真实站点 Agent 策略或具体文章 entitlement。

#### 4.5.1 手动接纳流程

```text
具体 Literature + 只读用户文件
  -> 预检 Literature 当前没有 primary-pdf
  -> 复制字节到 SciRetriever owner-only staging
  -> 对 staging 副本执行统一 PDF 基本检查
       ├─ 不通过：删除 staging，返回输入验证错误
       └─ 通过：形成 Asset 与 source_kind=user 的 LiteratureAsset
  -> Storage create-if-absent 发布内部字节
  -> 事务内复检 Literature 和唯一 primary-pdf 条件
       ├─ 成功：建立关系、清除已有耗尽事实并返回 AcceptedManualPdf
       └─ 失败：系统错误；用户原文件保持不变
```

目标，尚未实现（计划 20 的 14 块）：Web、CLI 与 MCP 的手动接纳改走入库的文件通道（[产品接口 2.4.2](01-product-interface.md#242-入库-http目标尚未实现)中的补 PDF），没有大小上限；它是逐条确认的，归入发起入口当天的“补充文件”批次（[6.4.2](#642-过程与状态)）。上面的流程、唯一主 PDF 与不替换的规则不变。

用户文件从始至终不属于 Storage staging 或 ArtifactStore，不参加对账与回收。旧兼容清理只可能作用于内部副本；新分析不授权删除，内部副本的处置也须经过独立材料决定与依赖检查。

## 5. 资产验收、发布与有效性

### 5.1 PDF 基本检查

自动获取和手动接纳的内部副本执行同一组基本检查：

1. 实际字节非空，并通过字节嗅探确认是 PDF，而不是空响应、HTML、JavaScript 或其它格式；
2. 标准 PDF reader 能够打开文件；
3. 页面树可读取且至少有一页；需要密码但没有可用密码、因而无法读取的加密 PDF 不能通过；
4. 自动候选来自目标 `Literature` 的 `AssetHint`、稳定标识符或已配置文献来源；手动文件由用户明确选择具体 Literature，两种路径都不能无依据地关联字节。

轻微不规范但仍能由 reader 正常打开并读取页面树的 PDF 可以接纳。检查失败时立即清理 `TemporaryPdf`，不形成 `Asset`、`LiteratureAsset` 或候选级失败事实，并继续下一个候选。

以下信号不能单独代表成功：

- HTTP `200`；
- Browser download event；
- `.pdf` 文件扩展名；
- HTTP `Content-Type`；
- 网页声称提供全文；
- 响应文件名或 Content-Disposition。

上述字节门不验证文章身份。按 [ADR 0029](../decisions/0029-unverified-pdf-acquisition.md)，
下载阶段不提取文字或匹配 DOI/标题/作者/版本；Browser Intake、自动及人工接纳和发布都使用
`pdf-acceptance.ts` 的文件检查。当前任务绑定、metadata snapshot/CAS 和不可变发布继续检查。
新的 publication intent 保存 `identity: "unverified"`；详情 `LiteratureAssetView.article_identity_status`
在没有后续核验时对 PDF 返回 `"unverified"`，非 PDF 返回 `null`。旧详情没有标签时保守投影，
旧 accepted 回执可重放但不代表后续解析验证。Catalog v9 的显式核验由 Parsing 提供证据、Literature
接纳判断，详情展示与当前输入绑定的结果；解析成功本身仍不等于身份核验。详见
[解析后的文章身份核验](04-document-evidence.md#7-解析后的文章身份核验)。

### 5.2 发布与并发复检

基本检查通过后，Service 形成独立 `Asset` 和 `LiteratureAsset` 发布请求。Storage 先不可变发布字节，再在短事务中复检：

- Literature 仍存在；
- 当前统一元数据仍与获取输入一致；
- 当前主 PDF 没有被另一结果替换；
- 发布的文件 hash 与请求一致。

只有文件发布、唯一 `primary-pdf` 关系和已有自动获取耗尽事实清除都成功后，Service 才返回 `AcquiredPrimaryPdf`。Stale 结果拒绝建立关系并作为系统提交错误返回；已发布但未引用的相同内容由 Storage 对账处理。发布失败、事务失败、hash 冲突或 stale 都不能降级为 `NoPrimaryPdf`。

手动接纳走同一发布、耗尽事实清除和复检边界，但成功返回 `AcceptedManualPdf`。它还必须复检目标从调用开始到提交时都没有主 PDF；竞争产生主 PDF 时拒绝手动结果，不能覆盖。手动关系的 `source_url` 固定为空，机器绝对输入路径不参与去重键、hash 或 provenance。

全部当前自动路径正常结束且没有主 PDF 时，Acquisition 使用独立短事务幂等写入 `AutomaticPdfAcquisitionExhaustion(literature_id)`，成功后才返回 `NoPrimaryPdf`。用户明确重试该 Literature 时，Entry 通过 Acquisition 公开操作先清除该事实，再发起新的自动获取；清除失败属于 Storage 错误。该事实不携带来源、原因、候选、时间、次数或配置快照。

### 5.3 原始材料有效性

获取成功的 PDF 和原始解析独立保存；解析、建档和算子失败不会触发“无可用总结”清理。任何材料退役必须是独立的显式维护决定，并核查文档、回执和结果依赖。

### 5.4 Network、官方政策、凭据和资源

- Route adapter 使用 Network 的 HTTP 或 Browser；
- 普通配置只表达 capability 启用、产品、Browser 总开关、opaque Profile identity 与只能收紧的
  AccessPolicy override；Provider secret 由根级 configuration 从固定
  `~/.sciretriever/credentials.toml` 私有解析，再由 Bootstrap 注入具体 adapter；Browser Profile
  可以由 Chrome 保存 Cookie/session 状态，但 Acquisition 不读取、解释或输出这些内容；
- Adapter 的本地 readiness、真实认证和具体 Literature 全文 entitlement 是三个不同判断；`config test` 最多验证当前服务 readiness，不能证明任意文献可下载；
- API adapter 声明稳定 quota identity、`provider_name`、`api` channel、必要的 `service_name`、允许 origin，以及从官方规则核实的 concurrency、interval、burst/window、period quota、reset 和 feedback；Metadata/Acquisition 共享官方额度池时使用同一 scope；
- Provider Notes 保存易变官方数字、endpoint、响应头和证据日期；没有可执行 policy 的 production adapter/Profile readiness 不通过，普通配置不能提高速率或扩大额度；
- 所有 routes、Metadata、Parsing 和 Analysis 共用 `bootstrap/application.ts` 为当前进程组装的 Access Coordinator；adapter 不建立局部 limiter，也不能让 vendor SDK 绕过准入；
- 普通网页使用实际 host 的 `web` scope 和声明政策；Browser 额外使用 `browser-generic` policy，
  默认按实际平台网络活动文章 1、网络结束后冷却 30 秒执行，旧显式聚合 `max_concurrency=1`
  仍限制整个会话寿命；不同平台的独立 worker 继续服从共享模型 scope/host 预算；
- 公开 `AssetHint` 指向出版社网站时仍受该出版社网页 scope；不同来源落到同一最终 host 时还共享实际 host 预算；
- `Retry-After`、quota 响应和 `blocked_until` 由 adapter 解释、Access Coordinator 执行；等待 permit 不转换为 `NoPrimaryPdf`，quota/API 失败按 ADR 0015 §7 保留原因并继续独立来源，不能绕过相同 scope 的冷却；
- 所有 redirect 和最终下载主机继续受 URL/DNS/origin policy；
- Provider quota 的含义属于 adapter，进程内执行和 host 预算属于 Network，cohort、worker/平台与会话资源资格属于 Entry/Broker，文章 session/page/transfer 状态属于 Browser，文件接纳与 publication 属于 Acquisition/Literature；
- PDF 响应、hash、reader、candidate 恢复、发布和导出使用受控文件/分块边界；旧 16 MiB/512 MiB 不作为正常大文件能否获得的业务规则，实际字节、磁盘、无进度和总寿命保护见 ADR 0030；
- 临时文件位于 owner-only 临时目录，由所属会话/文件 owner 在真实写者结束后结清；publication 失败保留有效 candidate/receipt，不重新下载或当作无主 PDF；
- 凭据不进入来源 provenance、URL、文件名、数据库或用户输出。

### 5.5 材料交付、调用边界与后续消费者

#### 5.5.1 当前 TypeScript 获取入口

`PdfAcquisitionPort.acquire(PdfAcquisitionRequest)` 接收具体 literature_id、当前 LiteratureDetail、metadata_snapshot 和 AbortSignal。操作内部可附 generation、operation_id、串行 commit 及已排除字节 hash；这些不是持久文献字段。`acquireCohort` 在有限请求集合上执行 direct/publisher-api/general-api/public-web/Browser 屏障，并通过 on_outcomes 提前交付已完成结果（HTTP 阶段波次、Browser 单篇）；最终数组保持冻结顺序。

`splitAcquisitionRoutes().stages` 提供四个 HTTP registry，保留旧 `routes/public_routes/authorized_api_routes` 兼容视图。`AcquisitionSourceRequest.target_version` 用于线索选择；`PdfDownloadOptions.on_response` 在每次真实 transport 响应返回、失败分类前报告 requested/final URL、状态与媒体类型，`on_landing` 继续兼容。该观测只服务当前 Entry 操作，不持久化、不打印敏感 URL，也不额外 HEAD/GET。

DOI 定位只对 doi.org 发出一次 GET。首跳响应由当前操作保存并复用：实际 PDF 立即交统一下载验收和发布，成功后跳过剩余 API/网页；200 HTML、403/404、缺少可用 Location 或回到同一 DOI 的响应也不重复 GET，后续公共下载器消费原响应并沿原错误/静态解析规则处理。确认了不同且安全的 landing 才丢弃首跳缓存并改用该入口。响应字节预算复用公开 PDF 的默认 64 MiB 上限，状态或敏感响应不进入长期事实；即使已交付 PDF 带 Retry-After，已有字节可以验收，而共享 Network 冷却仍执行。

普通 HTTP landing 可以作为经准入的 Browser 入口；无凭据公共下载器仍只处理 HTTPS，不把 HTTP 地址交给 HTTPS 下载器触发内部类型错误，也不因此放宽网络协议或凭据策略。

`PdfAcquisitionOutcome` 当前包含 acquired（带 publication receipt）、exhausted、route-failure、assistance-required、policy-skip、browser-failure、cancelled。只有 acquired 证明发布已确认；exhausted 仍须由适用业务边界安全建立耗尽事实。其余表示执行结果，不是新的 Literature 状态，也不允许被解释成正常没有 PDF。

`not-applicable`、`no-capability` 和 `http-route-unavailable` 必须由 route 明确声明。最后一种仅适用于公共 HTTP 403、无可交付 PDF 的静态页面流程、以及 Network 证明的重定向上限，且不存在 Retry-After 等限流反馈；不证明机构无版权。公共 5xx 或明确传输故障另用 `allows_independent_fallback` 表达独立后备许可，仍是未解决 failure，不冒充上述声明；普通异常、认证失败、配额或 timeout 不允许按错误码字符串猜成低风险不可用并升级 Browser；同层更早的未解决错误不能被后来的不可用声明覆盖，Browser 自身仍须独立 admitted。具体修订见 ADR 0015 §7。

##### 已接受的 Browser 并行与交接目标

[ADR 0023](../decisions/0023-generic-browser-agent-executor.md) 与
[ADR 0030](../decisions/0030-browser-transport-and-progress.md) 于 2026-10-05 接受下列修订。
2026-10-11 再修订首次模型前入口准备，2026-10-13 将默认预算收敛为 300 秒/30 次模型调用，动作只统计而不独立设限。本节说明目标合同，当前生产接线与验收状态以
[本轮实施计划](../../archive/2026-10-11-metadata-governance-pdf-routing/README.md)、[此前并行交接记录](../../archive/2026-10-05-browser-parallel-downloads/README.md)、源码和测试为准，
不把配置中的默认 5 或外层 Promise 并发当作实际并行证据。

- 一个 Profile/process/context 内保留多个文章 session。默认会话 cap 5、允许 1，首版实际
  cap 为 `min(配置, 8)`；旧大值可读取且显示生效限制，不改写文件。worker 数为
  `min(2, 有效 cap)`，每会话最多一个主 transfer。
- session 固定绑定 operation/generation、Literature、metadata snapshot、页面/opener、
  transfer 和 candidate。首次请求继续前确认所属 session 和平台；前台/观看选择不改归属。
- 首次模型派发前，`start_urls` 提供完整有序入口列表并兼容单 `start_url`；去重保留 query，同一 driver/page/clock 逐项最多尝试一次并记录实际到达 URL。Browser 实际 404/410 或 Host 已分类 DNS/连接失败允许有界备用，403/验证页/未知页面交模型；首次实际 dispatch 后不自动换入口。换入口前结算真实在途捕获，下载优先完成，开页/观察计入同一活跃预算，所有网络操作继续取得对应平台准入。
- worker 原子领取一轮观察/决策/动作，下载 started 暂停本轮并让出 worker。单调会话时钟
  累计推理、动作、主动反馈/节奏等待的并集；队列、模型 permit、平台停放、人工接管、下载及
  本地验收/发布不计时。默认上限为 300 秒活跃时间、30 次实际模型派发，先到上限停止进一步探索，动作保留统计而默认不独立设限。
  动作完成后至少 5 秒才派发下一轮模型，页面反馈与节奏等待重叠。
- 传输失败、文件损坏或 excluded hash 由对应 owner 结清拒绝候选，原页携剩余预算/反馈
  恢复，重新取得平台资格计一次 start；普通 step 不重复计。有效 candidate 结束探索，
  Browser 返回候选与内部 lease；Entry 执行原 acceptance/publication，在 finally 通知关闭。
  lease 不暴露给模型/前端，不等待另一篇，也不 abandon 已交付的有效候选。
- 平台网络资格在真实网络结束且保留页不能后台发请求后释放，开始 30 秒冷却；本地验证、
  publication 和文件清理不延长该资格。publication 失败保留 candidate/intent/receipt，
  提交后清理失败单独报告，均不得重下或撤销已确认资产。
- 跨平台主导航先撤销旧文档网络资格并结清旧网络。已准入 GET 因旧子资源无法结束而受阻时，
  CDP owner 可取消尚未发送的新请求，等待其精确 terminal、停止旧网络，再由 Host 在同一页面
  重启一次相同 URL；目标平台仍通过正常准入/start。恢复绑定 session/page/operation/generation、
  源文档代次和请求身份，旧观察不得触发模型，取消后不得重启；POST 不重放。
  在途 PDF 优先完成；若候选被拒，原文档仅保留可恢复资格，重新排队取得平台资格后才可继续访问。
  Chromium 在替换文档时可能取消 Script/XHR 却不发出对应的 Network terminal；Browser 仅在
  精确 frame/loader 的默认 Runtime context 已销毁、且同 frame 已提交不同 loader 两项证据
  同时成立时，且同一请求的 Network 类型与 Fetch 拦截类别一致、均为 Script/XHR，才结清旧记录。
  root Fetch 有时将 keepalive Fetch 上报为 XHR，不能单凭该类别推断寿命。Fetch、Other、native 和 IO PDF 保留自身终态，
  缺少文档/context 证据时不能据此释放资格；不用 URL、前台页或等待时长推断请求结束。
- Workbench 选择一个确定 session 并投影同一页面、控制 epoch、反馈与时钟；人工接管只
  暂停该篇自动派发。operation、单轮决策和 transfer 分别取消，Application 整体关闭才
  结清所有会话并关闭共享 context，保留 Profile 和已提交事实。

当前生产 Workbench 通过 `ProductionWorkbenchSession.queued/registered/open/removed` 投影
调度器已经拥有的身份、文章执行器和最终结果。尚未打开页面的等待项也可以选择或明确取消，
没有 observation 时不能接管或输入；页面打开后预算直接读取该执行器的 `BrowserArticleClock`，
不构造第二套决策循环或墙钟截止。每个观看 client 独立选择 session，选择不转移控制权。
`POST /api/sessions/select` 只提交 `session_id`；指令、指导和控制请求继续验证明确的
session/article/control epoch，截图请求在多会话下必须带当前所选 `session_id`。
中性 `WorkbenchView` 的可选 `sessions/session_phase/session_outcome` 保留旧单会话字段兼容，
会话投影最多64行，与已有 completion cohort 支持范围一致；只淘汰已关闭行，不截掉运行任务。
closed outcome 只投影 published(receipt_id)、retained(code, problem?) 或 cancelled；Page、lease、
Cookie、敏感 query 和文件绝对路径均不进入这份合同。可选 `session_cleanup_failure` 单独投影
本篇资源清理错误，稳定原因码仅在 technical_details，已published的receipt和Library事实保持可见，不被随后cleanup错误替换。
Agent的JSON观察包含动作统计、真实模型派发和活跃时间预算，旧Workbench bytes字段保留兼容，
不作为模型的文件大小上限。

#### 5.5.2 获取与材料读取分开

维护请求先明确用户启动意图、目标范围和允许路线，再获取；读取只需要 Literature/Asset ID 与 hash。查询、Analysis 和 Extraction 不注入 `PdfAcquisitionPort`，其输入缺失返回 gap。已保存、人工提供或其它正式入口接纳的 PDF 均可独立参与解析/分析；消费者不需要知道原 PDF 来自哪一层 route。

MaterialRef 的目标设计将已接纳 Asset/关系和 hash 作为最小材料身份。原始字节通过 scoped verified reader 提供，不能暴露绝对路径或让下游直接读 catalog。文件级证据不需要 MinerU/ParserResult；页码或区域证据只有在 Document/Evidence 已支持对应定位时才可声明。

#### 5.5.3 资产有效性与分析适用性

候选的非 PDF、损坏或空页树可以在接纳前拒绝；文章正文身份不作为下载门槛。尚未发布的 staging 由该次操作清理。已接纳材料的删除则需要独立的、精确到资产与引用的失效/删除决定。

当前 completion 不再由 `NoUsableContent` 自动调用清理链。Analysis 用途不适用、内容不足或模型失败只形成该分析结果，不授权 Acquisition 或 Storage 删除 PDF。Acquisition 的 PDF 基本检查继续独立拒绝非 PDF 和无效文件，文章身份不作为下载门槛；失效已接纳材料仍须明确业务决定。

#### 5.5.4 人类介入和交付原子性

人类通过同一生产会话观看、指导或接管，得到的下载继续进入 CandidateAcceptanceService 与 publication。控制成功、download事件和临时文件存在均不能作为获取成功；bytes 校验、当前任务关联、输入复检、不可变发布和关系提交缺一不可。

提交前取消清理本操作尚未接纳的临时资源；提交中取消等待提交结果并报告事实，不能把已发布回执伪装为完全未发生。相同目标路径不同字节拒绝覆盖并保留冲突证据，重试须比较原 intent/输入绑定，不能仅凭文件存在补造成功。

## 6. 书目交换与持久化协作

### 6.1 书目交换规则

入库批次的过程（实现中为 `ImportSessionService`）由 Entry 编排，Literature 拥有身份和书目接纳。中性 `ImportRecord` 组合外部编号、现有 `LiteratureMetadata`、原始 source_type、组引用、用户标签、文件与批注；`ImportGroup` 表达来源分组树，`ImportFile` 表达附件编号、文件名、媒体类型、首选状态及可选大小/SHA-256。外部编号和本系统的稳定文献标识分开。精确类型在 `packages/contracts/src/import-sessions.ts`，HTTP、上限及错误见[入库 HTTP](01-product-interface.md#242-入库-http目标尚未实现)。

`literature/import-adapters.ts` 统一登记 `records`、BibTeX/BibLaTeX、RIS、CSL JSON；适配器为纯函数，原始数据进，中性记录与不导入的内容计数出，不联网、不读文件、不写库。书目格式沿用原 decoder；单条解析/最小身份不合格计 rejected，其它记录继续。外部工具原始对象、同步状态、插件字段和笔记不扩展 LiteratureMetadata；批注当前只分类计数，supported 进入 deferred，未写入阅读批注。网页、文件与 Zotero 的适配器，以及条目的最低条件，见 [6.4.1](#641-条目与格式)（目标，尚未实现）。

书目会话从 BibTeX/BibLaTeX 的 `file` 和 RIS 的各条 `L1` 读取附件。`file` 按未转义的分号分附件，支持 `说明:路径:媒体类型`、`:路径:PDF` 与单独路径；冒号、分号、反斜杠的转义在拆分后还原，Windows 盘符属于路径。`L1` 每条为完整路径，不按冒号或分号拆分；CSL JSON 没有标准附件字段，不推断 files。媒体类型为 application/pdf、类型名为 PDF，或文件名扩展名为 .pdf（均忽略大小写）时视作 PDF；每条记录只保留第一个有效 PDF，输出 `preferred:true`、media_type=application/pdf，大小和哈希为空。其余 PDF 仅计 `additional-file`，非 PDF 仅计 `non-pdf-file`。

附件 `file_name` 取路径末段，相对引用的 `external_id` 使用还原转义后的相对路径，反斜杠归一为斜杠。绝对路径、Windows 盘符/UNC、本机 home 简写及 `internal-pdf://`、`file://` 只生成 `local-file:<分段序号>:<记录序号>:<附件序号>:<文件名>`，不返回本机目录；两种文件 URI 只解码一次百分号转义。引用继续受中性合同的 1,024 字符、控制字符、文件名及 `.`/`..` 路径组件校验；其他 URI、带 query/fragment 的文件 URI或不合法路径以 `invalid-file-reference` 计数，不使整条书目失败。适配器只产出引用，不尝试读取文件、下载或按文件名查找字节。

来源库优先使用其全局唯一编号；只有本地编号时，由设备连接号限定范围。来源键为 SHA-256(canonical JSON `["sciretriever.import-source.v1", system, scope, library_id]`)，scope 为 global 或 device:<connection_id>，设备编号只由认证推导。Web/CLI/stdio 没有设备身份时只交 local，返回 `intake-local-identity-required`；不共享默认命名空间，不凭文件名或主机名伪造全局号。先以本地号、后以全局号导入会形成独立来源，不自动合并。

外部编号对应先定位记录，再由同一保守身份规则核对稳定标识冲突与歧义；无 DOI 的记录也可以按对应继续导入。目标已删除时报告 external-target-missing，不猜测重绑。规范化记录哈希相同则不重复 observation，仅记录批次命中和补文件夹成员；变化形成新的不可变 user/import observation，source_record_id 为 `[library_key,external_id]` 的 JSON，input_sha256 为记录哈希。导入非空值按现有用户来源优先级处理，不能覆盖人工锁、READY 元数据或已有内容；当前统一值变化分 enriched，不变为 matched，首次无匹配为 created。

分组按外部编号导成来源库根文件夹下的层级，空组和多处归属保留；用户标签可关闭，否则变成根下“标签”中的子文件夹，不进入受控词表。只建一次、只补成员，不跟随来源改名、移动或删除。重名加序号，名称截到现有 Folder 合同的 128 个 UTF-16 单位且不拆 surrogate。用户删除已对应文件夹后不恢复它，报告缺失对应。

批次的状态、两种确认方式、后台入库、开放批次与过期规则见 [6.4.2](#642-过程与状态)（目标，尚未实现）。同一来源最多一个活动批次。分次数据按序号替换；预览只读身份投影，不写文献、来源或文件夹。确认重新判定，形成[入库批次](06-retrieval-context.md#216-入库批次范围词频与-pdf-获取范围)，逐条接纳并检查点保存；部分成功不回滚，重启从检查点续跑。取消停止余下工作、结算本进程在途发布，已提交事实保留。原始分段在结束时回收，结果与对应长期保存。持久化及重放边界见[导入存储](07-versioned-storage.md#9-导入会话与外部编号对应)。

文件清单区分 upload（缺主 PDF）和 hash（只需 SHA-256）。已有主 PDF 不替换；同哈希记 existing，不同记 conflict。上传从磁盘 descriptor 验证可读/非加密 PDF，按 ADR 0029 标为文章身份 unverified；接纳保留上传开始时的 metadata CAS，不调用模型或 Parser。重复上传只核对哈希，不重复发布；中断从零重发。文件到齐自动结束，显式 finish 可保留逐个缺失项。预览之前交来的文件与配对见 [6.4.3](#643-只有文件的条目与配对)，按 sha256 对应见 [6.4.7](#647-文件按-sha256-对应)（目标，尚未实现）。

来源没有库编号时，以 `source:null` 建一次性来源的批次，Web、`intake` 用途的设备和本机入口均可使用；服务端每次生成独立的 `adhoc:<UUID>` scope。读取投影为 `{system:"file",library_id:"",identity:"adhoc",name:file_name??""}`，不把文件名、内容哈希或本地库号伪装成全局身份。同名文件可同时导入；同一批次按批次编号续传，另一个批次不能续用此来源对应，调用方也不能显式指定 adhoc 或其 scope。批次名称优先使用 file_name，未给时用格式名，沿用既有 120 字符上限。

一次性来源的书目 observation 仍为 `user/bibliographic-import`，source_record_id/input/parameters hash 均为空；重复的规范化用户 observation 复用原事实，字段优先级与旧入口一致。分组与用户标签按旧文件导入行为忽略并报告计数，import_user_tags 归一为 false；不保存可续导的记录、组或文件对应，也不覆盖用户整理。中性记录中存在首选 PDF 引用时，预览、文件清单、上传/哈希、结束与报告仍走同一文件通道；不凭上传文件名推断论文归属。没有标识的条目另按 [6.4.8](#648-可能重复) 判断是否可能重复（目标，尚未实现）。

CLI 与 stdio MCP 的书目导入，以及旧 Web `/api/import`，内部都用同一 `source:null` 创建路径，在本进程里同步跑完；原请求、结果、编码处理和逐条拒绝语义不变。这些一步完成的入口忽略附件，不生成待交文件。失败时结算临时批次，不遗留活动批次，也不撤销已经接纳的文献。

只要 `Literature` 已形成可转换的当前 `LiteratureMetadata` 即可导出，不要求 PDF、解析或内容总结完成。始终导出当前接纳的 metadata，不按分析或建档状态切换另一套数据。默认每个 `MetaLiterature` 选择一个最佳可导出 Literature；用户明确要求时可以导出全部 Literature。目标格式无法表达的字段必须形成明确损失说明。

#### 网页收藏

目标，尚未实现（计划 20 的 14、15 块）：网页收藏是只有一条清单、逐条确认的入库（[6.4.2](#642-过程与状态)），页面的原始数据由服务端的 `web-page` 适配器解读（[6.4.5](#645-网页原始数据)）。下面是它的接纳规则。

- 页面字段接纳为 `user/web-capture` observation。输入补齐空默认值，使用同一元数据合同。
- 条目至少要有标识、标题、文件三者之一（[6.4.1](#641-条目与格式)）：没有 DOI 或 arXiv 号、有标题的页面也可以收藏。
- 服务端不下载页面或 PDF，不接收页面 Cookie、凭据、自选来源和 provenance。
- `source_record_id` 为按 namespace 排序的 DOI/arXiv 标识 JSON，没有标识时为 null。`input_sha256` 为规范化页面元数据的 hash，`parameters_sha256` 为空。原 observation 不被后续补全改写。
- 有标识时，保存后照现在的做法同步调用既有的 acquire-metadata/lookup 持久任务：冻结当前来源选择，每个来源 `scan_limit=1`，使用收藏 ID 派生的任务幂等键。结果为 completed、partial、failed 或 unavailable；失败时保留已接纳的页面书目。
- 没有标识时，保存后由后台执行认篇的第 3、4 步（[6.4.6](#646-认出是哪一篇)），保存的结果先为 pending。
- 没有标识、可能与已在库的文献重复的页面，按 [6.4.8](#648-可能重复) 在弹窗里当场决定并入或新增，决定之后才入库。
- Provider observation 仍由原身份和元数据字段的 owner 接纳，不覆盖人工锁或页面已有的用户字段。
- 所选文件夹只补成员。不存在的文件夹在 `missing_folder_ids` 中报告，其它存储失败不伪装为缺失。
- 每个连接内的 `request_id` 是 UUID：相同 ID、相同规范化请求重放原接纳，输入改变时拒绝为冲突。同进程合并在途保存；跨进程由 catalog 的唯一键、稳定 observation ID 和任务幂等键保留事实。
- 收藏的 PDF 与其他入库共用同一条文件通道：沿用磁盘保护、逐字节哈希、PDF 验收、唯一主 PDF、metadata CAS、取消与不可变发布。已有 PDF 只交哈希，相同记 existing，不同记 conflict，都不替换。PDF 的来源地址取扩展报告的实际下载地址（6.4.5）。PDF 不调用模型或 MinerU。
- 接口见[入库 HTTP](01-product-interface.md#242-入库-http目标尚未实现)，每台设备每天的开放批次见 [6.4.2](#642-过程与状态)。

### 6.2 Ports 与事务

Literature 拥有：

- Literature repository；
- 统一 read model；
- Artifact read Port；
- Identity transaction；
- Reference publication；
- Reference support publication；
- Metadata field publication；
- Import/export publication。

来源 observation、身份、统一元数据和 DiscoveryRun 结果/原因组合提交；引用在身份接纳后独立发布。Storage 保存业务 owner 已确认的决定，不因派生状态自行删除资产。

### 6.3 元数据与材料接纳

Application 的 writes 为 FileStore 与 SQLite 提供同一短写入准入。网络、模型和文件准备在锁外；不可变发布、输入复检与 SQL CAS 在准入内完成。元数据、原始解析、校订文档和算子结果分别由各自业务 owner 接纳，不再以两阶段总结绑定统一元数据。已发布事实不因后续索引失败或取消而撤销。

### 6.4 入库（目标，尚未实现）

目标，尚未实现（计划 20 的 14–16 块）。本节按 [ADR 0063](../decisions/0063-unified-intake.md) 规定一种条目、一个过程，以及从各种线索认出是哪一篇。实现之前，6.1 中标为现行的规则不变。

- 接口的路径、封套与错误码见[产品接口 2.4.2](01-product-interface.md#242-入库-http目标尚未实现)。
- 批次的字段见[查询 2.1.6](06-retrieval-context.md#216-入库批次范围词频与-pdf-获取范围)。
- 存储见[存储第 9 节](07-versioned-storage.md#9-导入会话与外部编号对应)。
- 撤回见 [6.4.11](#6411-撤回)。

#### 6.4.1 条目与格式

**条目。** 条目沿用 6.1 的中性记录（`ImportRecord`，合同改名为 `IntakeItem`），可以带：

- 书目，可以不完整；
- 标识；
- 文件；
- 有层级的分组；
- 标签；
- 批注；
- 来源里的编号。

**最低条件。** 条目至少要有标识、标题、文件三者之一。三者都没有的，在数据分段里按条计为 rejected，原因 `missing-identifier-title-file`；在单篇收藏里整个请求返回 `intake-item-empty`。没有标识、只有标题的条目可以入库。

常见的三种形状：

- 只有书目；
- 书目加文件；
- 只有文件（[6.4.3](#643-只有文件的条目与配对)）。

**格式与适配器。** 每种原始格式一个适配器，都是纯函数：原始数据进，条目与“不导入的内容”计数出。适配器不联网、不写库；书目格式的适配器也不读文件，文件适配器只读交来的那个文件（[6.4.4](#644-文件适配器的线索)）。

| 格式名                                  | 来源                                                         | 怎样交来                              |
| --------------------------------------- | ------------------------------------------------------------ | ------------------------------------- |
| `records`                               | 已经整理成中性条目的数据                                     | 数据分段                              |
| `bibtex`、`biblatex`、`ris`、`csl-json` | 导出文件                                                     | 数据分段，`data` 为整份文本或其中一段 |
| `web-page`                              | 网页的书目标签（[6.4.5](#645-网页原始数据)）                 | 单篇收藏，不经数据分段                |
| `file`                                  | 文件本身                                                     | 只有文件的条目                        |
| Zotero 接口数据（格式名待定）           | 扩展读到的本地接口响应（[6.4.9](#649-经扩展从-zotero-导入)） | 数据分段                              |

**`records` 格式。** 它是正式的公开格式，Agent 与脚本可以交已经整理成条目的数据。但来源有专用适配器时（书目文件、Zotero），应当交原始数据，不要自己改写成条目：解读格式是适配器的职责，自己改写会绕过适配器的规则（标签分类、首选附件、Extra 字段中的标识等）。接口说明（`/api/v1/intake/instructions`）写明这一点。

#### 6.4.2 过程与状态

**五步。** 所有入库都形成一个入库批次，依次为：

1. 交清单：数据分段、文件即条目，或单篇收藏的页面数据。
2. 预览。
3. 确认。
4. 补全文。
5. 报告。

批次编号在建批次时产生，是对外唯一的编号。

**状态与结果。**

| 状态   | 值                      | 含义                                          |
| ------ | ----------------------- | --------------------------------------------- |
| 收集中 | `collecting`            | 已建批次，还没有交来条目                      |
| 待确认 | `awaiting-confirmation` | 已有条目，可以预览与决定                      |
| 入库中 | `running`               | 已确认，后台逐条入库，或者等待文件            |
| 已结束 | `finished`              | 带结果                                        |
| 已取消 | `cancelled`             | —                                             |
| 已撤回 | `withdrawn`             | 已撤回，见 [6.4.11](#6411-撤回)，可以整批恢复 |

- 已结束的批次有结果，沿用 ADR 0052 的四个值：
  - `completed`：全部条目已接纳，没有未交的文件，没有待决定的条目；
  - `partial`：有接纳的条目，也有冲突、拒绝、未交的文件或待决定的条目；
  - `failed`：没有接纳任何条目，或者存储错误连续三次（见下文）；
  - `interrupted`：书目阶段没有跑完就因过期结束。
- 其余状态下，结果为 null。
- 主题发现与引用扩展的批次只用 `running`、`finished`（带结果）与 `withdrawn`。

**状态的转换。**

| 从                                               | 到                      | 条件                                                 |
| ------------------------------------------------ | ----------------------- | ---------------------------------------------------- |
| 建批次                                           | `collecting`            | —                                                    |
| `collecting`                                     | `awaiting-confirmation` | 第一段数据或第一个文件交来                           |
| `awaiting-confirmation`                          | `running`               | 确认                                                 |
| `running`                                        | `finished`              | 书目阶段完成且没有待交的文件，或者显式结束，或者过期 |
| `collecting`、`awaiting-confirmation`、`running` | `cancelled`             | 取消；已经入库的内容保留                             |
| `finished`、`cancelled`                          | `withdrawn`             | 网页登录的使用者撤回（6.4.11）                       |
| `withdrawn`                                      | 撤回之前的状态          | 网页登录的使用者整批恢复（6.4.11）                   |

- 同一个有库编号的来源，同时只能有一个处于前三种状态的批次（`intake-source-busy`）。
- 同一序号的数据分段，在确认之前可以重交，重交即替换。

**预览。**

- 预览给出以下估计：
  - 新增、已在库、恢复（[6.4.11](#6411-撤回)）、冲突、可能重复（[6.4.8](#648-可能重复)）、不接纳的条数；
  - 要补的文件数，分要上传的与只需核对的；
  - 未配对的文件（[6.4.3](#643-只有文件的条目与配对)）；
  - 能导入与不能导入的批注数及原因；
  - 不导入的内容及数量。
- 只有文件的条目在预览阶段认篇（[6.4.6](#646-认出是哪一篇)），返回 `recognition`。
- 预览不写文献、来源记录、状态投影与文件夹。认篇结果与可能重复的候选记在批次的条目上，以便确认时不再查询；这属于批次的工作状态，不是文献库的事实。

**确认。**

- 确认时重新判定；结果以报告为准，预览只是估计。
- 认篇尚未结束时，确认返回 `intake-recognition-pending`。
- 需要决定但还没有决定的条目（可能重复、可能是这一篇、未配对的文件），按 6.4.8、6.4.6、6.4.3 各自的默认处理，不入库的条目记为 `pending-decision`。
- 确认立即返回：状态为 `running`，`progress.total_items` 为总条数，`progress.processed_items` 为 0。

**后台入库。**

- 入库在服务进程的后台进行，分三个阶段：
  - `metadata`：逐条书目入库；
  - `files`：等待文件；
  - `closing`：收尾。
- 进度字段见查询 2.1.6 的 `IntakeBatch.progress`。
- 单条失败（身份冲突、拒绝等）记入报告，继续下一条。
- 存储级的错误（写入准入、SQLite、文件系统）使入库暂停，每分钟重试一次；连续三次仍失败时，批次转为 `finished`、结果为 `failed`，报告写明已入库的与没有处理的。
- 服务进程启动时，继续没有跑完的批次。
- 谁发起的批次，由谁的进程跑完。CLI 与 stdio MCP 的书目导入在本进程里同步完成，行为不变。恢复别的进程留下的批次与过期处理，只在服务进程里做；CLI 与 stdio MCP 进程不做这两件事。

**过期。**

- 没确认的批次，自建立起 7 天后转为 `cancelled`。
- `running` 的批次 7 天没有新结算的文件，就转为 `finished`，还没交来的文件记为未交。
- 原始数据分段与暂存文件，在批次结束或取消时删除；待决定条目的保留规则见 6.4.8。

**两种确认方式。**

- 整批确认（`confirmation = "batch"`）：默认方式。人在网页上确认；Agent 在用户说过可以直接导入时自己确认。
- 逐条确认（`confirmation = "per-item"`）：条目交来就入库，只用于以下两种情形。

| 情形                     | 开放批次                                     | 默认名称              |
| ------------------------ | -------------------------------------------- | --------------------- |
| 扩展的单篇收藏           | 每个设备连接每天一个                         | “网页收藏 YYYY-MM-DD” |
| 补 PDF（产品接口 2.4.2） | 每个发起入口（网页、CLI、stdio MCP）每天一个 | “补充文件 YYYY-MM-DD” |

- “一天”按服务端的系统时区划分。
- 当天的开放批次处于 `running`。日期变更后，服务进程的维护把它转为 `finished`，还没交来的文件记为未交。
- 开放批次随时可以改名；改名后，当天后续的条目照常归入。
- 报告随时可读，给出到当时为止的累计；全文取得情况现算。
- 单篇收藏的重放幂等，照 `request_id`（产品接口 2.4.2）。

**再次入库。** 来源有库编号时，按条目在来源里的编号对应，规则见 6.1；再导一次就是同步。

#### 6.4.3 只有文件的条目与配对

**文件即条目。**

- 批次在 `collecting` 或 `awaiting-confirmation` 时，向 `/file-items` 交文件字节，即建一条只有文件的条目。
- 文件进入暂存区，服务端返回条目编号。
- 文件按 ADR 0029 做基本检查。不通过的，条目计为 rejected（`pdf-invalid`、`encrypted-pdf` 或 `non-pdf-file`），暂存文件立即删除。

**计数与暂存。**

- 暂存文件不计入批次 256 MiB 的数据上限，只受磁盘空间检查的约束；条目数计入 50,000 条。
- 批次取消或过期时，暂存文件立即删除。
- 确认之后，暂存文件直接接纳为主 PDF，不再上传；接纳的规则与文件通道相同（6.1“文件清单”一段）。

**配对。** 导出文件与文件在同一个批次里交来时，先把每条导出记录的文件引用与交来的文件配对：

1. 按导出记录里的相对路径：从路径末尾逐段比较（不分大小写，反斜杠视同斜杠），取匹配段数最长并且唯一的那个文件。
2. 第 1 步没有唯一结果时，按文件名配对：文件名唯一，并且导出给了大小时大小一致，才配对。
3. 仍没有唯一结果的引用，计为待交的文件，留待交文件时处理；不猜。

- 配上的文件成为那条记录的首选文件，不再单独成为条目。
- 没有被任何记录引用的 PDF，在预览里单列为“未配对的文件”，默认不入库。使用者可以逐个决定 `include`（作为只有文件的条目入库）或 `exclude`。没有决定的，按 `exclude` 处理，批次结束时删除。

#### 6.4.4 文件适配器的线索

文件适配器从一个 PDF 中读出以下线索，供 6.4.6 认篇。规格只规定能力，不指定所用的库。

| 线索       | 内容                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| 文档信息   | Title、Subject、Keywords                                                                                  |
| XMP        | `dc:title`、`dc:identifier`，以及 DOI 字段（`prism:doi`、`pdfx:doi`）                                     |
| 文件名     | 去掉扩展名                                                                                                |
| 首页文字   | 第 1 页的文字；第 1 页少于 200 个字符时，同时读第 2 页。每页最多读 20,000 个字符                          |
| 最醒目的行 | 首页上半部分字号最大的文字块；相邻、同字号的行合并为一块；长度 10–300 个字符；按字号从大到小取前 3 个候选 |

- 读取一个文件的总超时为 10 秒，超时按没有线索处理，并在条目上注明 `clues-timeout`。
- 没有文字层的扫描件，没有首页文字与最醒目的行。如果其他线索也认不出，以文件名作为暂时的标题，标为书目待补（[8.4](#84-书目待补目标尚未实现)）。
- 加密 PDF 按 ADR 0029 不接纳，计为 `encrypted-pdf`。
- 非 PDF 首版不接纳，计为 `non-pdf-file`。
- 文字在使用前按 6.4.6 的规范化处理。

#### 6.4.5 网页原始数据

扩展只采集、不解读，原样交来 `WebPageData`（字段见产品接口 2.4.2）：

- 网址；
- 页面标题；
- 全部带 `name` 或 `property` 的 `meta`，最多 500 条；
- schema.org 的 JSON-LD 原文，最多 5 块，每块最多 64 KiB；
- 当前页是否就是 PDF。

规范 JSON 共不超过 512 KiB。服务端的 `web-page` 适配器负责解读，规则如下：

- **标识**：
  - DOI 依次取 `citation_doi`、`prism.doi`、`dc.identifier`、`dc.identifier.doi`、`bepress_citation_doi`、JSON-LD 的 `identifier`/`sameAs` 中的 DOI，最后取网址；
  - arXiv 号取网址、`citation_arxiv_id`，以及 DataCite 的 arXiv DOI（`10.48550/arxiv.*`）。
  - 取法与原扩展的 `page.ts` 相同：DOI 去掉结尾的标点和 `/full`、`/abstract`、`/pdf`、`/epdf`、`/html`、`.pdf`，转为小写。
- **书目**：
  - 标题依次取 `citation_title`、`dc.title`、JSON-LD 的 `headline` 或 `name`；`og:title` 只作后备。
  - 作者取 `citation_author`、`dc.creator`、JSON-LD 的 `author`。
  - 日期取 `citation_publication_date`、`citation_date`、`citation_online_date`、`prism.publicationdate`、`dc.date`、JSON-LD 的 `datePublished`。
  - 期刊、出版者、卷、期、起止页、摘要、语言、关键词，取原扩展读取的同名标签，以及 JSON-LD 的对应字段。
- **JSON-LD**：只解读 `@type` 为 `ScholarlyArticle`、`Article`、`Report`、`Thesis`、`Chapter` 的对象，包括其子类型名，以及 `@graph` 中的这些对象。其他对象忽略；不合法的 JSON 整块忽略，并计入 `excluded`。
- **PDF 地址**：
  - 当前页就是 PDF 时，取网址；
  - 否则取 `citation_pdf_url`；
  - 都没有，而页面在 arxiv.org 上时，取 `https://arxiv.org/pdf/<arXiv 号>`。
  - 服务端在 `IntakePagePreview.pdf_url` 中给出，扩展照它下载。
- **来源记录**：读到的字段照 ADR 0057 第 5 节保存为一条 `user/web-capture` 来源记录，文献信息来源只补它没有的字段。
- **PDF 的来源地址**：扩展在 `IntakePageFile.source_url` 中报告实际下载的地址，记为这个文件的 `LiteratureAsset.source_url`。不再编造地址。
- **当前页就是 PDF**：扩展把文件交来，条目按只有文件的条目认篇，网址作为额外线索。

#### 6.4.6 认出是哪一篇

条目带来的书目不完整时，先认出是哪一篇，再向文献信息来源取完整书目。只用程序与文献信息来源，不调用模型。认出的结果只决定书目；文件仍按 ADR 0029 标为“文章身份未验证”。

**规范化与相似度。**

- 比较标题之前，先作规范化：
  1. Unicode NFKC；
  2. 去掉 HTML 标记与 LaTeX 命令，保留命令的花括号参数；
  3. 转为小写；
  4. 标点与符号换成空格；
  5. 连续空白合成一个空格，并去掉首尾空白。
- 相似度为规范化串之间的归一化编辑距离相似度：`1 − d(a,b) / max(|a|,|b|)`。其中 `d` 是按 Unicode 码点计的 Levenshtein 距离，`|a|` 是码点数；两串都为空时为 0。
- “一致”指规范化后相等，或者相似度不低于 0.95；“相近”指相似度不低于 0.85。

**四步。** 按下面的顺序认，前一步成功就不做后一步。

1. **找标识。**
   - 文件依次看 XMP 与文档信息里的 DOI、文件名、首页文字。
   - DOI 按 `10.<4–9 位数字>/<非空白字符>` 匹配，去掉结尾的标点；arXiv 号按新式 `\d{4}\.\d{4,5}(v\d+)?`（前面要有 `arXiv:` 或 arxiv.org 的地址）与旧式 `<学科>/<7 位数字>` 匹配。
   - 首页上有几个不同的标识时，不取首页的标识。
   - 网页的标识按 6.4.5 取。
2. **用标识取书目，并核对。**
   - 取书目用现有元数据补全的同一组来源与次序。
   - 取回的标题要能在线索里找到：文件，规范化后的首页文字包含这个标题，或者某个最醒目的行与它一致；网页，页面标题或标题标签与它一致。
   - 对不上的，当作没有标识，进入第 3 步。
3. **用标题找。**
   - 标题线索：网页取标题标签，后备为 `og:title` 与页面标题；文件依次取 XMP 标题、文档信息标题与最醒目行的前 3 个候选。
   - 向 Crossref 与 OpenAlex 按标题查询，各取前 5 条。
   - 采纳的条件：结果的标题与某个标题线索一致，并且作者或年份能在线索里找到：
     - 文件：任一作者的姓出现在首页文字里，或者出版年份出现在首页文字或文档信息里；
     - 网页：出现在作者、日期标签或 JSON-LD 里。
   - 两个来源各自采纳的结果指向不同的作品（标识不同）时，不采纳，改列为候选。
   - 只是标题相近的结果，作为“可能是这一篇”列在预览里，最多 3 项，按相似度从高到低，相同时按来源次序（Crossref 在前）。使用者用 `candidate` 决定采用其中一项，或用 `unrecognized` 决定都不是。没有决定的，按第 4 步处理。
4. **没有认出。**
   - 以线索里的标题入库：网页取标题标签，后备为页面标题；文件依次取 XMP 标题、文档信息标题、第一个最醒目的行，都没有时取文件名。
   - 标为书目待补（[8.4](#84-书目待补目标尚未实现)）。

**什么时候认。**

- **只有文件的条目**：在预览阶段认。
  - 预览请求启动或继续认篇，并返回 `recognition: {state: "idle" | "running" | "done" | "cancelled", recognized: int, total: int}`。
  - 查询按 ADR 0056 的来源设置出网。
  - 认篇可以取消（`/preview/cancel`）；取消后，没认完的条目按没有认出处理。再次预览时，从没认完的条目继续。
- **网页**：带书目标签的页面本身就有书目，收藏时不必等查询；补全照 6.1 的网页收藏，在保存之后进行。没有任何标识的页面，保存时以页面书目入库，之后由后台代替补全执行第 3、4 步。
- **认出的结果**：记在批次的条目上，确认时不再查询。

#### 6.4.7 文件按 sha256 对应

来源没有库编号时，文件按内容的 sha256 对应，同一个文件不重复入库：

- **命中已有的主 PDF**：这条记为已在库（matched），对应到那篇文献，不建新文献。条目自己带的标识与那篇文献的稳定标识不同时，记为冲突（`file-identity-conflict`），不入库。
- **命中某篇文献的补充材料**：记为已在库，对应到它所属的文献；报告里注明 `matched-by-supplementary`。
- **已撤回的内容**：仍然参与对应。命中被撤回的文献时，按 [6.4.11](#6411-撤回) 恢复它，分类为 `restored`。

#### 6.4.8 可能重复

**判断的范围。** 只对没有标识、来源也没有库编号的条目判断，也就是导出文件、网页和只有文件的条目。认篇之后有了标识的条目不判断。比较的范围是全库（不含被撤回的文献），以及本批中排在它之前的条目。本批的前序条目在接纳之前还没有文献编号，所以预览只与库里已有的文献比较；确认时按条目顺序逐条重新判定，已接纳的前序条目纳入比较。确认后列为可能重复的条目因此可能多于预览（预览本是估计），报告照常列出。

**与严格后备键的关系。** [2.4](#24-身份收敛) 的严格后备键（规范题名、完整作者顺序、年份与出版形式都相同）命中时，仍按同一篇处理，记为已在库，不列为可能重复。可能重复只指达不到严格后备键、但达到下面判定的情形。

**判定。** 以下三条同时成立时，判为可能重复：

- 标题相似度不低于 0.90，规范化与算法同 6.4.6；
- 第一作者的姓相同（NFKC、小写后比较），或者一方没有作者；
- 年份相差不超过 1 年，或者一方没有年份。

**处理。**

- 预览单列“可能重复”。每条给出库里的候选，最多 3 个，按相似度从高到低，相同时按 `literature_id` 排序。
- 决定有两种，经接口逐条提交：
  - `merge`：并入列出的某一篇，作为它的一条来源记录；
  - `new`：新增。
- 系统记下决定者（`web`、`cli`、`mcp` 或 `device:<connection_id>`）与决定时间。
- 逐条确认的网页收藏不推到批次页：单篇预览（`/pages/preview`）返回可能重复的候选，最多 3 个；扩展当场请使用者选择并入某一篇，或者作为新文献收藏。`/pages/save` 必须带 `duplicate_decision`，否则返回 `intake-decision-required`，使用者选了才入库。
- 没有人决定的条目，批次结束后处于 `pending-decision`，不入库。条目的数据与暂存文件自批次结束起保留 30 天；过期后丢弃，并在报告里注明 `decision-expired`。
- 以后在批次页上处理时，不另建批次，结果并入原批次的报告与成员。

#### 6.4.9 经扩展从 Zotero 导入

依据 [ADR 0063](../decisions/0063-unified-intake.md) 第 6 节。下面标“待探测”的各项，以计划 25 的 14（Zotero 探测）结果为准，规格暂不规定。

**扩展交来什么。**

- 扩展读 Zotero 的本地接口，把条目与分组的响应原样分段交来。每段不超过数据分段的上限（产品接口 2.4.2），段内保留响应的原始 JSON。
- 批次的 `source.system` 为 `zotero`。
- 待探测：来源库编号的取法（个人库与群组库）及其 `identity` 是 `global` 还是 `local`；本地接口是否给出 CSL JSON。

**条目的映射。**

- 照 ADR 0057 第 3 节：
  - 书目优先用 CSL JSON，没有时按 Zotero 字段映射；
  - 解析 Extra 字段里的 DOI、arXiv 号与 PMID；
  - 自动标签作为作者关键词，手动标签作为用户标签；
  - 分类作为分组。
- 没有父条目的独立 PDF，按 ADR 0063 第 2 节成为只有文件的条目。
- 笔记、非 PDF 附件、回收站里的条目只计数。
- 批注按 ADR 0057 第 3 节，在主 PDF 与附件逐字节相同时导入。

**首选附件。**

- 父条目带 `links.attachment` 时，用它指向的附件。
- 没有时，在该条目的 PDF 附件（`contentType = application/pdf`）中，优先取 `linkMode` 为 `imported_file` 或 `imported_url` 的，再按 `dateAdded` 最早、附件编号升序取第一个。
- 文件的引用名是附件编号；文件名与 Zotero 给出的 md5 随附。

**文件。**

- 待探测：扩展能否经本地接口直接读到文件。
- 读不到时，扩展请使用者选一次 Zotero 的数据文件夹，按 `storage/<附件编号>/` 找文件：
  - 该目录下只有一个 PDF 时取它；
  - 有多个时，取文件名与附件 `filename` 相同的那个；
  - 都不符合时，计为未交，不猜。
- 链接附件（`linked_file`）不在 `storage` 里，列入报告。

**续传。**

- 上传以服务端的缺失清单为准。
- 扩展在本地只存批次编号与数据文件夹的授权，不存文件清单或进度；中断后重新读取缺失清单，再继续。

#### 6.4.10 条目、决定、文件与报告的字段

下面的类型都由 `import-sessions.ts` 中的同名类型改名而来，未列出的字段不变。

```text
IntakeBatchItem                       # /items 与 /items/:item_id/status 的一项
  item_id: str
  origin: "data" | "file" | "page"
  sequence: int | None                # 数据分段中的位置；文件即条目与单篇收藏为 null
  record_index: int | None
  external_id: str | None
  title: str | None                   # 读出或认出的标题
  file_name: str | None
  recognition: IntakeRecognition | None
  possible_duplicates: tuple[{literature_id, title, first_author, publication_year, similarity}, ...]   # 最多 3 个
  unpaired: bool                      # 未配对的文件
  needs_decision: bool
  decision: IntakeDecision | None
  disposition: IntakeDisposition | None   # 确认后才有

IntakeRecognition
  state: "pending" | "recognized" | "candidates" | "unrecognized" | "cancelled"
  step: 1 | 2 | 3 | 4 | None          # 在哪一步认出或停下
  literature_id: LiteratureId | None  # 第 1–3 步命中已在库的文献时
  candidates: tuple[{candidate_id, title, authors, publication_year, identifiers, source_name, similarity}, ...]   # 最多 3 项

IntakeDecision
    {kind: "merge", literature_id}    # 可能重复：并入列出的某一篇
  | {kind: "new"}                     # 可能重复：新增
  | {kind: "candidate", candidate_id} # 可能是这一篇：采用某个候选
  | {kind: "unrecognized"}            # 可能是这一篇：都不是
  | {kind: "include"}                 # 未配对的文件：作为只有文件的条目入库
  | {kind: "exclude"}                 # 未配对的文件：不入库
  # 返回时另带 decided_by: str 与 decided_at: str

IntakeDisposition = "created" | "enriched" | "matched" | "restored" | "conflict" | "rejected" | "pending-decision" | "excluded"
```

- 决定只接受该条目当时列出的候选或种类，否则返回 `intake-decision-invalid`。
- 确认之前可以改变决定；批次结束后，只能对 `pending-decision` 的条目作出决定。
- `IntakeFileStatus`、`IntakeItemResult` 沿用 `ImportFileStatus`、`ImportRecordResult` 的字段，`disposition` 改用 `IntakeDisposition`。
- `IntakeSummary` 在 `ImportSummary` 上增加以下字段：
  - `records.restored`（恢复被撤回的文献，[6.4.11](#6411-撤回)）、`records.possible_duplicates`、`records.pending_decision`、`records.needs_metadata`（书目待补）；
  - `files.unpaired`；
  - `full_text`，即这一批的全文取得情况，定义同[查询 2.1.8](06-retrieval-context.md#218-文献库计数与全文取得情况)，范围是批次成员。

#### 6.4.11 撤回

依据 [ADR 0063](../decisions/0063-unified-intake.md) 第 9 节。撤回是标记，不是物理删除：被撤回的内容留在存储里，可以恢复。彻底删除已撤回的内容不在首版。路由见[产品接口 2.4.2](01-product-interface.md#242-入库-http目标尚未实现)，存储见[存储 9.1](07-versioned-storage.md#91-schema-16-的目标变化目标尚未实现)。

**谁能撤回、撤回哪个批次。**

- 撤回与恢复只接受网页登录的使用者。任何设备用途、CLI 与 MCP 都不能撤回或恢复。
- 可以撤回 `finished` 或 `cancelled` 的批次，包括主题发现与引用扩展的批次。
- `running` 的批次不能撤回，返回 `intake-batch-state`。当天的开放批次在日期变更、转为 `finished` 之后才能撤回。
- 有运行中或排队中的任务以这一批的文献为目标时，撤回返回 409 `intake-batch-busy`，要先等任务结束或取消。

**撤回什么。** 只撤回这一批新增、之后没有被动过的内容：

- 文献：本批分类为 created 的文献。
- 文件：这些文献的资产关系（`literature_assets`）。资产与文件本身保留，只标记关系；同一个文件可能还被别的文献引用。
- 分组：本批新建的文件夹，包括来源根文件夹与“标签”文件夹。只有当它的成员全部被撤回，并且文件夹本身没有被改名、移动或加入别的成员时，才一起标记。
- 批注：本批导入的批注。
- 本批加入的文件夹成员。

本批新建的对象由 `intake_batch_objects` 记录。

**登记之前形成的批次。** `intake_batch_objects` 的写入随撤回一起上线，在那之前形成的批次没有这些记录。一个批次有分类为 created 的成员、却在 `intake_batch_objects` 中没有任何一行时，按“登记之前形成”处理：

- 仍可撤回。撤回范围只按 `intake_batch_members` 判定：分类为 created、且没有下表任一原因的文献，连同它们的全部文件关系一起标记。
- 下表中 `folder-changed` 与 `annotated` 两个原因无法区分本批与本批以外：文件夹成员与批注都不记录来自哪个批次，导入与使用者加入同一成员后留下的数据完全相同（2026-11-17 用合成库核实）。所以这类批次按保守口径判定：文献有任何文件夹成员即为 `folder-changed`，有任何批注即为 `annotated`，都保留。代价是旧批次中随导入建立分组的文献撤不回；宁可少撤，也不撤掉使用者自己的整理。
- 本批新建的文件夹、文件夹成员与批注认不出来，不撤回。被撤回文献的文件夹成员与批注随文献一起不再出现（见“撤回之后”），但不另行标记；文件夹本身保留，可能因此变空。
- 预估与报告的 `registered` 为 false，并写明“本批在登记之前形成，文件夹与批注不在撤回范围内”。不猜测哪些文件夹或批注属于本批。

**不撤回的内容。** 以下文献连同它在本批的文件关系、文件夹成员与批注都不撤回，在预估与报告里按原因列出。一篇文献可以有几个原因，全部列出。

| 原因                 | 判定                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `pre-existing`       | 入库之前已经在库：本批分类为 enriched、matched 或 restored。本批给它加的来源记录与文件夹成员也保留 |
| `hit-by-later-batch` | 是晚于本批建立的批次的成员                                                                         |
| `folder-changed`     | 有本批以外加入的文件夹成员                                                                         |
| `annotated`          | 有本批以外创建的批注或笔记                                                                         |
| `opened`             | 有阅读记录（`reading_history`）                                                                    |
| `processed`          | 有原始解析、建档、校订稿、标签指派或算子结果                                                       |
| `metadata-edited`    | 有人工编辑或锁定的字段                                                                             |
| `identity-merged`    | 之后与别的文献成为同一 MetaLiterature 的版本，或者有别的条目以 `merge` 决定并入了它                |

**预估与执行。**

- `/withdrawal/preview` 给出 `IntakeWithdrawalPreview`，不写库：

```text
IntakeWithdrawalPreview
  remove: {literatures: int, file_relations: int, folders: int, folder_members: int, marks: int}
  keep: {literatures: int, by_reason: {reason: int}}
  kept_items: tuple[{literature_id, title, reasons: tuple[reason, ...]}, ...]   # 最多 200 项，按 literature_id 排序
  registered: bool                 # 本批新建的对象有无登记；false 时见“登记之前形成的批次”

IntakeWithdrawalReport             # 撤回或整批恢复之后
  remove 或 restore 的实际计数（字段同 remove）
  keep、kept_items（字段同上）
  at: str
  by: str                          # 固定为 "web"
```

- `/withdraw` 执行时重新判定，以报告为准。
- 标记在一个写入事务中完成：
  - 写入 `intake_withdrawn_objects`；
  - 删除被撤回文献的全文检索行，并推进检索 source revision；
  - 批次状态改为 `withdrawn`，原状态与报告记在 `intake_withdrawals`。

**撤回之后。**

- 被撤回的文献从下列范围里排除：
  - 文献库列表与详情，详情按不存在处理；
  - `LibraryQuery` 的一切结果、计数与词频；
  - 全文检索与材料 Context；
  - 引用关系的两端：一端被撤回的引用，不出现在关系页与引用数中；
  - 发现原因；
  - 获取 PDF、解析等任务的范围展开；
  - CLI 与 MCP 的读取。
- 排除的读取规则见[查询 2.1.1](06-retrieval-context.md#211-libraryquery)。
- MetaLiterature 的代表在读取时从未被撤回的版本中选；全部版本都被撤回时，这篇论文整体排除。
- 被撤回的文献**仍然参与身份匹配、sha256 对应与外部编号对应**（6.1、6.4.7），但不进入可能重复的比较范围（6.4.8）。
- 被撤回的文件夹不出现在文件夹树与文件夹查询中。被撤回的批注不出现在批注列表与阅读页中。

**再次入库时恢复。**

- 新的入库按标识、严格后备键、sha256 或外部编号命中一篇被撤回的文献时，恢复这篇文献，不新建文献：
  - 取消它的标记，以及它在原撤回中一并标记的文件关系、文件夹成员与批注的标记；
  - 原批次建立、被标记的文件夹，在有成员恢复时一起恢复。
- 它成为新批次的成员，分类为 `restored`；预览与报告单列“恢复”。
- 来源记录与外部编号对应沿用原来的。内容有变化时，照 6.1 形成新的来源记录。
- 原批次保持 `withdrawn`，它的报告不变。

**整批恢复。**

- 已撤回的批次页上可以整批恢复（`/restore`），只接受网页登录。
- 恢复的是这一批里仍处于撤回状态的内容；已经被后来的批次恢复的内容保持原样。
- 恢复之后，批次回到撤回之前的状态（`finished` 带原结果，或 `cancelled`），并附恢复报告。

**首版不做。** 彻底删除已撤回的内容；撤回单个条目。

## 7. 材料与文献验证

### 7.1 验收

直接测试至少覆盖：

- 每个 Literature 必须且只能属于一个 MetaLiterature，且第一篇 Literature、MetaLiterature 和代表关系原子创建；
- MetaLiterature 不能没有成员，代表 Literature 必须属于当前 MetaLiterature，成员关系不能被双向重复保存；
- `VersionRole` 只接受 `published`、`accepted-manuscript`、`preprint` 和 `other`，未知来源不能猜测为 `published`；
- Literature 基础对象不重复保存 metadata 顶层字段，也不嵌入 observation、资产、内容或关系列表；
- DOI 的裸值、`doi:`、`https://doi.org/`、`http://dx.doi.org/`、大小写和边界空白收敛为相同 canonical key；PMID、PMCID 和其它已支持 namespace 只使用各自官方格式；
- arXiv 新式、旧式、前缀和官方 URL 能够规范化，`v1`/`v2` 命中同一 Literature 且不增加 revision 字段；
- OpenAlex Work ID、Web of Science UID、Semantic Scholar Paper ID、Scopus EID 等只进入 Provider record identity，不进入 Literature identifiers 或跨供应商身份匹配；
- 稳定标识符一致、同 namespace 不同值、一个相同而另一个冲突、全部缺失和多个无冲突 ID 连接场景；一个相同而另一个冲突时稳定拒绝，不建立版本关系或冲突状态机；
- 同一 Literature、同一 MetaLiterature 内不同 Literature 和不同 MetaLiterature 的分离；
- 无稳定标识符的严格复合匹配只执行 NFC、Unicode 空白合并和 casefold，保留标点、连字符、作者组成与顺序；任何字段缺失、姓名倒置、首字母、转写或相似文本都不能命中；
- 相同 DOI 不因 `version_role` 不同拆分，不同 DOI 不因标题相同合并；正式 DOI 与相关 arXiv 预印本只有明确 `version_links` 才共享 MetaLiterature；
- 来源 precedence、字段补充、冲突保留和重复计算确定性；
- 用户导入 observation 的非空值先于全部 Provider observations，Provider 只补缺；首次与 Provider 值相同的 matched 仍保存用户来源，完全重复的 matched 不新增 observation，稳定标识符冲突拒绝而不强制合并；
- 作者统一选择第一个非空高优先来源列表；只有 ORCID 相同或作者数量、顺序和规范化展示名全部一致时才补缺，且不能覆盖高优先来源值或执行模糊匹配；
- `Author` 能保留个人、机构、中文姓名、协作组、明确 ORCID、署名单位和 ROR；不同 Literature 不产生全局 Author 身份；
- 书目导入、供应商 observation 和第一阶段最终 metadata 都使用同一 `Author` 合同，缺失姓名组成、ORCID、单位或 ROR 时保持缺失而不是猜测；
- 非空标题或 DOI 至少存在一个时才能入库，只有其它 namespace 标识符而没有标题时拒绝；
- `source_type` 保留来源开放词汇，统一字段仅接受两组封闭枚举；未知映射保守为空，版本语义仅采用明确来源提示；
- `MetadataObservation` 使用独立 `observation_id` 和公共 `Provenance`，不携带 Literature 身份，也不在顶层重复来源、来源记录 ID 和观察时间；Provider 与书目导入只通过受约束的 provenance 区分；
- 一个 Literature 可以关联多个长期保存的不可变 MetadataObservation，新增 observation 不覆盖旧对象；LiteratureMetadata 始终只有一份当前值；
- `metadata_revision` 只在当前 LiteratureMetadata 成功替换时递增，用于 stale 复检和当前内容对齐，不存在旧统一 metadata revision 历史；
- observation 级 `version_role` 与 `AssetHint.version_role` 保持独立，没有可靠证据时不能猜测为 `published`；
- `version_links` 只接受供应商明确声明的同文献版本目标，每个 key 至少有一种稳定定位；未解析或冲突目标不创建占位 Literature，也不改变 MetaLiterature 归属；
- 相同 MetaLiterature 的版本归属只保存为 `Literature.meta_literature_id`，不建立 `LiteratureRelationObservation`、`LiteratureRelation` 或其它平行版本事实；
- 供应商返回的 `declared_keywords`、原始参考文献文本、参考文献次数、被引用次数、资产线索和访问状态不会直接进入 `LiteratureMetadata`；
- `declared_keywords` 与 LLM 最终关键词保持独立，最终关键词只存在于已验收 `LiteratureMetadata.keywords`，没有平行分类或标签结果；
- `reference_count` 和 `cited_by_count` 分别保留、保持非负且不会根据列表长度推导或跨供应商相加；
- `reference_texts` 按来源顺序保存非空原文，不维护或暗示列表完整性，也不根据其长度推导计数；
- `ProviderRelationObservation` 一条只表达一条供应商有向边，可以在目标尚未入库时独立存在且不会自动物化 Literature 或递归；
- 只有当前扩展范围选中的 relation observation 才尝试解析目标，未选中或接纳失败时不形成 ReferenceSupport；
- `ReferenceLookup` 不持久化，不能绕过 Metadata 和 Literature 身份规则直接创建目标；
- Reference 只有三个 ID 字段，只在两个不同的具体 Literature 都已接纳且至少存在一项有效 ReferenceSupport 后建立，相同 source/target 幂等；
- ReferenceSupport 使用三种封闭来源结构，索引从零开始；结构化关系方向必须与 Reference 一致，文本来源必须属于引用方，相同 `(reference_id, source)` 幂等；
- 供应商结构化关系和原始参考文献文本按数据语义区分，不按专门接口或默认返回方式区分；
- 多个来源只为同一 Reference 增加 support，Reference 不连接原文、供应商记录或 MetaLiterature，也不平铺 provenance；
- 解析失败或候选歧义只保留原文，不创建占位 Literature 或未解析 Reference；
- Literature 级引用和 MetaLiterature 级汇总；
- cited-by 查询是权威引用关系的反向读取，不形成第二套关系事实；
- 三级状态完整 truth table，并与 Storage 读取投影使用同一测试样例；当前没有独立可写的 SQL view；
- 自动获取耗尽、运行 Report 或普通失败不改变状态；`needs_manual_pdf` 只来自最小耗尽事实；
- 自动或手动接纳的唯一 `primary-pdf` 关系都按同一规则形成 `ASSET_READY`；手动来源不增加状态或转移到其它 Literature；
- 未完成但已有统一元数据的版本可以导出；
- 导入记录与供应商记录使用同一身份规则；
- 查询不直接依赖内部数据库表结构；
- LibraryQuery 只搜索允许的当前权威字段并以具体 Literature 为结果单位；一般多值 OR、keywords AND、普通 text 无 SQL/FTS 语法，分页/排序不进入 QuerySelector；
- LibrarySearchRequest 的默认排序、缺失值后置、LiteratureId 稳定 tie-break、relevance 前置条件、total_count 和不透明 cursor 绑定成立；后续页面重新读取 current facts，不伪造持久化查询 snapshot；
- SearchItem/Page 和 LiteratureDetail 是同一 read-only snapshot 临时组装的不可变投影，不持久化或形成写入输入；Detail 的 metadata revision/hash、状态、缺失步骤、资产、原始解析、校订稿和引用数量相互一致；
- Detail 不嵌入大型 artifact 字节或无界 Reference/Support/Discovery 图；当前参考文献原文可随来源/content 读取，权威关系、support、发现历史和 artifact 使用独立读取；
- references 与 cited-by 页面使用同一 Reference 的正反向读取，相关 Literature 复用 SearchItem，普通页面只给 support count；ReferenceDetail 才返回同一 snapshot 中的 source、target 与全部当前 support，不建立反向边或第二套引用数量；
- Literature 的 artifact read Port 只接受 Detail 已给出的 Asset/ArtifactRef，复核正式对象的相对引用、普通文件、size、hash 与 media type 后返回 context-managed 只读 binary stream；Model 不执行 I/O，也不暴露内部绝对路径；
- Entry 使用 verified reader 向用户文件原子导出 artifact，默认拒绝已存在目标，明确覆盖时也不暴露半文件；读取或导出不访问 Provider、不修改数据库、不形成 DiscoveryRun 或处理 Report；
- 查询能够分别返回 DiscoveryRun 发现记录和按 MetaLiterature 聚合的成员完成事实，两者不混成 Literature 状态；
- 查询能够筛选需要人工 PDF 的具体 Literature；新增 MetadataObservation 与耗尽事实清除属于一个逻辑提交；
- 最终 metadata/content 接纳拒绝 stale PDF 或 metadata revision，且不会留下部分 keywords、sections、references 或 artifact 关系；
- 身份整理、删除和内容接纳提交不存在部分关系更新。

### 7.2 验收

直接测试至少覆盖：

- 目标 Acquisition catalog 区分 Metadata Provider、Access Provider 与平台；项目能力、生产实现、用户启用、route readiness 和当前 Literature 适用性分别判断，已有 AssetHint 由通用公开 route 消费而不复制转发 adapter；
- `PublisherAccessResolution` 优先解释实际 DOI landing、访问方自有 AssetHint origin、来源稳定定位和 Provider record identity；publisher 字符串、单独 DOI prefix 或 MetadataObservation 来源都不能独立证明内容 API/Browser 适用；多个强证据冲突不会任选一个；
- Scopus 返回的 Wiley 文献不会误路由到 Elsevier Content API，而 Crossref 返回且 DOI 实际落地到 Elsevier 的文献可以选择就绪的 Elsevier route；访问方 Profile 不要求成为 Metadata Provider 或凭据 section；
- `AcquisitionPlan` 对相同输入确定，Planner 可以省略不适用 route 但不能提前 Browser；DOI safe resolve 同一 work item 最多一次，层间 route hint 可以重新规划且不进入数据库；
- 实际字节非空、reader 可打开、页面树可读取且至少一页的 PDF 成功，轻微不规范但可正常读取的文件不被过度拒绝；
- 空响应、截断、损坏、非 PDF 字节和无可用密码的不可读加密 PDF 失败；
- HTTP 成功但内容错误不能接纳；
- `.pdf` 后缀、文件名、HTTP `Content-Type`、Content-Disposition 或 Browser download event 都不能替代字节与 reader 检查；
- 候选与 Literature 没有依据关系时拒绝；
- 自动 `AcquisitionResult` 只接受 `AcquiredPrimaryPdf` 或无字段 `NoPrimaryPdf`；没有候选、正常未命中、Browser 流程正常结束但无下载及无效 PDF 可以收敛到后者且不携带原因；candidate/locator/target/route 局部外部失败允许继续其它独立路径，但最终没有成功时必须抛出稳定失败，配置预检、取消和共享 Network readiness/coordinator 错误立即向外传播，二者都不能形成耗尽；
- `NoPrimaryPdf` 只有在五层全部适用路径正常结束且最小 `AutomaticPdfAcquisitionExhaustion` 已提交后返回；该事实只有 LiteratureId，不保存来源、原因、候选、时间、次数或配置快照；
- 手动 PDF 要求明确具体 Literature，先复制到内部 staging 再执行相同基本检查；成功返回只含已提交 Asset/LiteratureAsset 的 `AcceptedManualPdf`，且 provenance 为 user/manual-pdf、source URL 为空；
- 手动文件不存在、不可读、不是有效 PDF、目标不存在或已有主 PDF 时形成输入验证错误，不进入 `NoPrimaryPdf` 或第三个自动结果；竞争产生主 PDF 时拒绝而不覆盖；
- 手动接纳不创建 PdfCandidate、candidate key、tried set、第四个 AcquisitionPath 或输入绝对路径记录，只达到 `ASSET_READY`、清除已有自动获取耗尽事实，不自动继续 Parsing/Analysis；
- 成功、失败、取消、stale 和明确材料失效均不移动、修改或删除用户原文件，只能清理 SciRetriever 内部副本；
- 文件发布、数据库提交、耗尽事实提交、hash 冲突或 stale 失败作为系统错误传播，不能返回 `NoPrimaryPdf`；只有 Asset、唯一 `primary-pdf` 关系和已有耗尽事实清除都提交后才能返回 `AcquiredPrimaryPdf`；
- `AssetHint` 的直接文件和落地页语义、可选字段及封闭角色被正确解析；
- 同一 Literature 的不同 `AssetHint` 分别保留 URL、媒体类型、资产角色、版本角色、`access_status` 和 `license`，且这些值不进入 `LiteratureMetadata` 或替代 PDF 基本检查；
- `PdfCandidate` 只存在于当前运行，只保存 candidate key、route adapter 的稳定 source identity、acquisition path 和声明媒体类型，不要求 URL，也不保存 header、Cookie、凭据、API object、页面 action、私有对象或失败详情；补充材料、XML 和 HTML 不成为主 PDF 候选；
- `AccessRouteHint` 只保存封闭、脱敏的 canonical landing、稳定 ID、locator 或 entitlement 线索，不能携带 Cookie/token/vendor object，也不能持久化；短期签名 locator 留在 adapter 私有多步流程；
- 普通 HTTP、多步授权 API 和浏览器捕获都先形成相同的 `TemporaryPdf`，不能绕过统一基本检查；
- `Asset` 只保存不可变文件事实；`LiteratureAsset` 保存 Literature、角色、脱敏来源和 provenance，不复制 Literature version role 或增加 `is_current`；
- direct → publisher-api → general-api → public-web → browser 五层顺序与认证分类独立；单篇当前层结束后才启动自身下一层，其他文章独立推进，成功后不继续后续 routes，已选缺失或未就绪来源保留失败标记；
- 同一 Literature 不跨层竞速；不同 Literature 可在目标 worker 上限内独立并发，API 由官方 quota scope
  门控，Browser 由 `browser-generic` 聚合政策和同平台网络串行/30 秒冷却共同准入；
- Provider 可以贡献公开线索或授权 API；Browser 下载只使用唯一 `browser:generic` route，层级由 Acquisition Plan/Entry admission 决定且不写入 `AssetHint`；
- header、cookie、凭据和 vendor 私有对象不能进入或随 `AssetHint` 持久化；
- 一个候选正常未命中或基本检查失败后继续下一个；candidate/locator/target/DOI landing/adapter 的独立失败可以继续其它适用低风险路径，来源的 HTTP/API/外部响应格式失败或候选地址拒绝保留原因并继续独立渠道；429、`Retry-After`、quota 停止本来源剩余请求并遵守冷却，最终未解决失败不能提交自动获取耗尽；
- 未启用或不适用 route 不进入本次耗尽集合；当前 plan 需要但缺少实现、参数、凭据或 policy 的 route 明确报告且不能静默耗尽；取消、Port、清理、发布和 stale 失败立即终止；
- 同一 Literature 最多存在一个 `primary-pdf` 关系，且该唯一关系就是当前主 PDF；
- PDF 通过基本检查后立即形成 `ASSET_READY`，不等待 LLM 内容判断；
- 基本检查验证非空实际 PDF 字节、reader 可打开、页面树至少一页和当前任务绑定；不以 PDF 内容身份匹配阻断入库，保存未验证标签；不判断正文/
  摘要/目录/封面或学术内容，也不使用固定页数、字节数或正文字符数；
- 重复相同字节复用，不同字节不能覆盖；
- Stale metadata 或当前资产变化时拒绝发布关系；
- Browser 下载不能绕过基本检查；
- `browser-generic` 的显式聚合串行 override、start interval/window/cooldown 与各平台网络活动
  1/结束后 30 秒冷却共同执行；空 override 允许跨平台 worker 并行，独立 API scope 按各自政策推进；
- Browser 平台资格覆盖页面与主下载的真实网络活动，网络结束且保留页后续请求被阻止后释放，
  本地文件/会话责任独立结清；恢复、redirect、popup、viewer、标签页或换入口不能绕过窗口、
  间隔、`blocked_until`、circuit，也不能按 CSS/JS 次数实施文章冷却；
- Browser 的登录、MFA、rate-limit、IP block、账号警告和 runtime failure 形成当前运行事实；只有登录、MFA、IP block、账号警告、cleanup 或达到阈值的 runtime failure 等明确 group feedback 才打开对应 circuit，不写数据库或阻塞无关 group；API 的 `no-entitlement` 仅表示该 API 不能交付，允许独立准入的 Browser 尝试机构 IP 访问；
- Challenge、拒绝和未找到使用与普通页面相同的 Observation 与六种动作；登录/MFA/no-entitlement 等需要人工或外部授权的状态不会被 Agent 自动绕过。页面状态是给 Agent 的描述，不由 Network 自动变成终态。自动或经动作 clear 后继续 capture；
  Agent Stop、候选等待超时、取消、硬性 runtime failure 和 300 秒/30 次调用预算
  保留各自稳定结果；候选等待超时不会单独结束 Agent，也不打开 Challenge group circuit；本地 resource-blocked 不冒充页面拒绝或 Agent 失败；
- Browser 只注册 `browser:generic` 并构造 `AgentBrowserController`，无 Publisher rule、selector controller
  或 fallback；未知 Publisher 具有合法起点时也可进入；
- Agent controller 只调用 `start/apply`；Network 在一次 step 内完成 exact binding、最多一次 dispatch
  和 settlement，只返回五类稳定结果；一次无变化、重复动作或页面短暂不变都仍是可继续的 settled step，
  不再生成 no-progress terminal；
- 原始 capture 不是成功；Acquisition 文件验收通过后，本次 `BrowserCaptureBatch` 的候选及时结束探索并交付 publication，文章身份仍为未验证（ADR 0029、0030）；
- 目标 Browser session 的默认硬上限为 300 秒累计活跃时间与 30 次真实 model dispatch，
  Agent action 保留统计而默认不独立设限；下载/排队/本地验收不误计，恢复不清零。达到上限只形成稳定
  Browser failure，不形成正常未命中、全渠道耗尽或永久无权限。最后一次合法调用允许完成动作、既有
  有界页面反馈和下载交接；时间及控制版本检查继续生效，已启动传输使用独立寿命。5 秒决策间隔
  与反馈等待重叠，迟到动作不执行；
- Agent 每次只返回一个绑定当前 revision/surface/viewport 的封闭动作，由同一 CloakBrowser article
  handle、Browser permit、Network guard 和 capture handler 执行；不能创建额外 context/process、
  任意导航、selector/JavaScript 或直接发布 PDF；
- Browser Agent 没有固定页面路径或页面状态终止规则；同一 session 时钟/控制 epoch 为自动
  与 Workbench 共用，operation/decision/transfer 取消域独立。下载 started 让出 worker，失败
  从原页面重新观察；文件验收通过及时返回候选/lease并交原 publication，不在调用方尚无法
  开始 publication 时等待它。无候选仅收敛真实捕获，原始失败不被空队列超时覆盖；
- 每次 Browser navigation/popup/response/download 在访问前通过文章级 dynamic destination guard 与
  Network policy；有效 PDF 通过任务关联、CAS 与不可变发布，内容身份检验留待解析阶段；
- Metadata 与 Acquisition 使用同一 API quota 时共享 scope；API `Retry-After` 和 quota 阻塞对所有调用方生效；
- redirect 到新的 provider/host 不能绕过目标网页 scope 或 host 预算，公开状态不形成限速豁免；
- 当前进程内的失败、超时和取消不能泄漏网页 permit 或清空仍有效的冷却/`blocked_until`；新进程不恢复这些动态状态；
- 同次运行使用临时 tried set 避免立即重试，新运行允许重新发现且数据库不保存无效 candidate/route/decision；
- 新 MetadataObservation、成功自动或手动主 PDF、用户明确重试都会清除自动获取耗尽事实；全库自动补全默认跳过仍有该事实的 Literature；
- Sci-Hub 来源：Auto 默认启用，Custom 可以不选；没有 custom 列表时使用当前版本内置的有序镜像，custom 列表完整覆盖内置列表并在升级后保持不变；Reset 恢复跟随内置列表，禁用时保留 custom；请求按序而非并发执行，继续经过统一的 Network 与 PDF 验收；不配置凭据、会话或绕过能力，出口按统一的出网选择；
- Parser/LLM 调用失败、ParserResult 乱码/截断/只有资源引用或无法判断时不删除 PDF；
- 无效候选不留下候选级长期详情；Analysis 明确无内容只终止本次尝试，不删除已接纳 PDF、ParserResult、原始 MetadataObservation 或 AssetHint；

凭据、readiness 和 `config test` 测试使用临时凭据文件、fake adapter 与本地 Network，不读取真实用户配置，也不访问真实供应商。

HTTP 和 Browser 测试使用本地受控站点，不连接真实供应商。

## 8. 元数据字段与文献状态

本节规定元数据字段裁决与由事实推导的建档状态。

### 8.1 出版形式与文章性质

`LiteratureMetadata.document_type` 拆为两个封闭枚举：

| 字段               | 取值                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `publication_form` | `journal-article`、`conference-paper`、`book-or-chapter`、`thesis`、`patent`、`report-or-standard`、`dataset`   |
| `article_kind`     | `research-article`、`review`、`letter-or-communication`、`perspective-or-commentary`、`correction-or-editorial` |

- 预印本由 `version_role` 表达，不属于出版形式。
- 供应商的原始类型字符串保存在 observation 的 `source_type` 中，经带版本的映射表转换，无法映射时为空。
- `LibraryQuery` 的 `document_types` 改为 `publication_forms` 与 `article_kinds`。
- 严格后备身份匹配要求出版形式一致。

### 8.2 字段来源、冲突与锁定

每个字段记录来源（`authority`、`proofread`、`manual`）、证据、冲突标记和锁定标记。优先级：

| 字段                                                         | 优先级                   |
| ------------------------------------------------------------ | ------------------------ |
| 题名、作者、期刊、出版者、卷、期、页、标识符、日期、出版形式 | 人工 > 权威来源 > 校订稿 |
| 文章性质、作者关键词、摘要、语言                             | 人工 > 校订稿 > 来源     |

- 用户导入值仍按 ADR 0002 优先。
- 就绪后到来的新 observation 只补空字段并标出冲突；只有显式重新执行建档的元数据步骤，才重新裁决。

### 8.3 文献状态

| 状态             | 条件                                                                        |
| ---------------- | --------------------------------------------------------------------------- |
| `UNREVIEWED`     | 无主 PDF                                                                    |
| `ASSET_READY`    | 有主 PDF、未就绪；`missing_step` 为 `raw-parse` 或建档的下一步              |
| `ARCHIVING`      | 建档任务运行中                                                              |
| `ARCHIVE_FAILED` | 正文部分存在未解决的失败                                                    |
| `READY`          | 正文校订完成并成为默认文档、结构满足、必填元数据齐全、标签数在 1 到上限之间 |
| `EXCLUDED`       | 文章性质为观点或评论、勘误或社论                                            |

- 状态仍是纯推导结果；
- 补充材料部分不参与推导；
- 获取 PDF、解析、建档各自手动发起。

### 8.4 书目待补（目标，尚未实现）

目标，尚未实现（计划 20 的 15 块）。依据 [ADR 0063](../decisions/0063-unified-intake.md) 第 2、11 节。

**是什么。**

- “书目待补”是文献（`Literature`）上的一个标记，表示入库时没有认出它是哪一篇（[6.4.6](#646-认出是哪一篇) 第 4 步）。
- 它不是建档状态机里的状态，不改变 8.3 的六种状态及其推导。

**在哪里出现。**

- 查询合同的文献摘要（`LiteratureSearchItem`）与文献详情带 `needs_metadata: bool`。
- `LibraryQuery.needs_metadata` 可以按它筛选（[查询 2.1.1](06-retrieval-context.md#211-libraryquery)）。
- 文献库有“书目待补”筛选，行上有标注（[页面规格“文献库”](../web/page-specs.md#文献库)）。
- 批次报告的 `records.needs_metadata` 计数（[6.4.10](#6410-条目决定文件与报告的字段)）。

**什么时候清除。**

- 被认出时清除：解析之后再认一次时认出，或者之后的入库按标识认出了它。
- 使用者人工保存了标题时清除，即元数据编辑中设置了 `title` 字段。

**解析之后再认一次。**

- 只对带这个标记的文献进行，时机是原始解析（RawParse）发布之后。
- 线索用解析出的标题、作者与首页文字，按 6.4.6 走前三步。
- 认出时：取回的书目照常作为文献信息来源的来源记录接纳；另记一条 `source_kind = "user"`、`source_name = "post-parse-recognition"` 的来源记录，内容为认出所依据的标识与标题；然后清除标记。
- 仍认不出时：用解析出的标题，以同一种来源记录替换暂时的标题（不覆盖人工锁定的字段），标记保留。
- 不调用模型，不另外花费；查询照 ADR 0056 的来源设置出网。

## 9. 目标接口（尚未实现）

本节集中保留尚未整套实现的目标合同；当前实现以源码为准，设计记法不等同于已发布 API。

### 9.1 输入与公开结果

#### 9.1.1 自动获取

公开 API 接收具体 `Literature` 的中性 `LiteratureMetadata`、稳定标识符、当前 MetadataObservation 中的 Provider record identity 与 `AssetHint[]`、当前资产事实和本次运行临时排除的 candidate key 集合。它们只用于形成当前 `PublisherAccessResolution`、`AcquisitionPlan` 和候选，不把完整 vendor 对象带入 Acquisition。Resolution、Plan、route hint、Browser queue 和动态访问状态不是公开业务结果。业务成功/正常缺失的语义结构如下；这是设计记法，当前 TS 入口还以明确的执行 outcome 传递失败、暂停和取消：

```text
AcquisitionResult =
    AcquiredPrimaryPdf
  | NoPrimaryPdf

AcquiredPrimaryPdf
  asset: Asset
  relation: LiteratureAsset
  candidate_key: str

NoPrimaryPdf
```

`AcquiredPrimaryPdf` 表示不可变 PDF 字节、该 Literature 的唯一 `primary-pdf` 关系和已有自动获取耗尽事实的清除都已经安全提交；只完成下载或临时检查不能返回它。`candidate_key` 仅供当前 Entry 操作更新内存 tried set，不进入持久化关系。

`NoPrimaryPdf` 是无字段结果，但只能在以下条件全部成立后返回：当前元数据和已配置自动能力下的direct、publisher-api、general-api、public-web 与受控 Browser 的适用路径已经正常遍历；没有候选、正常返回“未找到”、浏览器流程正常结束但没有下载，或候选非 PDF、为空、损坏等预期未命中已经收敛；并且该 Literature 的 `AutomaticPdfAcquisitionExhaustion` 已经安全提交。它不暴露或持久化原因枚举与逐候选详情。

用户中断、Network 传输或 API 错误、权限或配置错误、数据库或文件系统无法安全提交、并发变化导致提交条件失效，以及共享 Network readiness/policy/coordinator 本身不可用，都属于本次操作失败而不是第三种 Acquisition 业务结果。属于一个 candidate、locator、target 或 route adapter 的外部失败可以在内存中保留为脱敏稳定失败，并继续其它独立获取路径；若后续没有任何路径成功，Service 必须向 Entry 抛出稳定失败，不能返回 `NoPrimaryPdf`，也不能建立耗尽事实。配置与 readiness 预检、取消、Port 合同、清理、发布和 stale 失败立即终止。因此只有已经完整收敛且从未留下未解决 route failure，并成功提交耗尽事实的 `NoPrimaryPdf` 可以支持 MetaLiterature 切换版本。

公开 API 不暴露 URL client、HTTP response、Browser page/download、临时绝对路径或来源私有对象。

#### 9.1.2 手动 PDF 接纳

手动接纳是与自动获取并列的独立 API。Entry 必须先把用户选择解析为一个具体 `LiteratureId`，并以只读方式打开用户输入文件；Acquisition 把字节复制到 owner-only 临时文件后再执行统一检查。输入路径和文件 handle 是适配边界值，不进入跨模块 TypeScript contract、provenance 或 Catalog。

成功结果为：

```text
AcceptedManualPdf
  asset: Asset
  relation: LiteratureAsset
```

`relation.role` 必须为 `primary-pdf`，`relation.source_url` 为空，provenance 使用 `source_kind = "user"` 和稳定 `source_name = "manual-pdf"`，并以内部复制字节的 SHA-256 作为输入 hash。只有内部不可变 Asset 和唯一关系都已经提交后才能返回成功。

以下情况直接形成稳定输入验证错误，不返回 `NoPrimaryPdf`：用户文件不存在或不可读、基本 PDF 检查失败、目标 Literature 不存在，或者该 Literature 已有当前主 PDF。文件发布、事务或 stale 复检失败仍是系统错误。手动接纳不进入自动 Source 顺序或自动 tried set，也不增加第四个 `AcquisitionPath`。当前 TypeScript `Application.maintenance.ingestPdf` 使用 transfer/acceptance/identity-validation 与不可变 publication；CLI 本地文件、公开 TS 字节和 Web 受控上传调用同一用例，不启动自动 Source、Parsing 或 Analysis；目标是三者都经入库的文件通道（[4.5.1](#451-手动接纳流程)）。独立维护页不要求 Browser runtime，上传协议不接受本机路径。

Acquisition 只复制用户字节，不移动、改名、截断、覆盖或删除用户原文件。成功只形成 `ASSET_READY` 并清除已有自动获取耗尽事实；Parsing 与 Analysis 由后续独立数据库补全操作发起。
