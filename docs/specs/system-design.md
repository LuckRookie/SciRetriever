# SciRetriever 系统设计

本文从模块责任、数据所有权、状态和端到端流程四个侧面描述理想中的 SciRetriever。Work-centered 产品决策见 [ADR 0002](../adr/0002-work-centered-literature-library.md)，WP4 MinerU 服务边界见 [ADR 0003](../adr/0003-operator-managed-mineru-service.md)，产品合同见[需求规格](requirements.md)，代码模块和依赖边界见[技术架构](technical-architecture.md)。本文不记录现有代码能力或执行进度；这些信息见[实施进度](../governance/implementation-progress.md)。

## 0. 本文回答什么

本文面向产品 owner 和需要理解全局协作方式的读者，回答三个问题：产品由哪些能力模块组成；每个模块负责和拥有什么；一篇文献的数据如何从查询流到本地库、PDF、分析、引用图和下游导出。规范性功能和验收条件以[产品需求与验收规格](requirements.md)为准。

### 0.1 文档权威层级

| 信息 | 权威来源 |
|---|---|
| 产品领域边界 | [ADR 0001](../adr/0001-sciretriever-scope-and-boundary.md) |
| Work-centered 产品方向和执行模型 | [ADR 0002](../adr/0002-work-centered-literature-library.md) |
| WP4 MinerU parser/service ownership、连接和 attempt/evidence 边界 | [ADR 0003](../adr/0003-operator-managed-mineru-service.md) |
| 产品功能、规则和验收 | [requirements.md](requirements.md) |
| 数据流、模块协作和产品状态模型 | 本文 |
| 代码模块和技术依赖 | [technical-architecture.md](technical-architecture.md) |
| 当前实现与差距 | [implementation-progress.md](../governance/implementation-progress.md) |
| 实施顺序和工作包批准 | [文献库执行计划](../planning/literature-library-execution.md) |

系统设计描述的都是产品应有形态，不因某项能力是否已经实现而改变。README 只公布已发布行为，实施进度文档负责记录覆盖情况。

## 1. 产品全景

```text
                           foreground CLI
               search / download / analyze / expand
                  library / failures / config check
                               |
                               v
                 universal completion orchestration
            METADATA_PENDING -> ASSET_PENDING
            -> ANALYSIS_PENDING -> COMPLETE
                                |
                                v
                    Work-centered local library
                 Work -> WorkVersion -> current view
                    |          |             |
        metadata observations  |      canonical metadata
                    |          |      Markdown/tags/refs
                    |          |
                    |          +-> primary PDF -> PDF analysis
                    |          +-> optional XML/HTML supplements
                    |
        concurrent metadata providers      acquisition tiers
                    |                  race -> translator -> browser
                    v                           |
              deterministic merge              v
                                        immutable asset storage
                               |
                               v
               DocumentPackage + stable IDs/provenance
                               |
                       downstream domain packs
```

设计把 catalog 中的长期文献事实放在中心。所有写入型入库和补全入口先进入共享应用层完成管线，再复用 metadata、acquisition、normalization 和 analysis 阶段能力。搜索、下载、分析和引用扩展不各自产生互不相干的任务产品；只读查询和完成后的导出不属于完成管线。

### 1.1 能力模块与责任

| 能力模块 | 责任 | 拥有或写入 | 明确不负责 |
|---|---|---|---|
| 前台交互与配置 | 解释命令、选择器、defaults、进度和 cooperative stop | invocation 参数；不拥有业务事实 | daemon、后台 ownership、持久化任务恢复 |
| Completion Orchestration | 根据 catalog 事实确定四阶段并只调用下一缺失阶段；为 DOI/search/import/backfill/expansion 提供统一完成契约 | 不拥有新的业务事实；返回当前阶段和本次阶段结果 | 复制 metadata/acquisition/analysis 实现、保存第二套状态、建立后台 workflow |
| Search/Metadata | 并发查询、规范化、身份匹配、provisional WorkVersion 入库 | 通过 catalog 写 observations 和 provisional provider projection | 宣称文献最终完成、下载正文、调用 LLM、保留 vendor dict 作为产品字段 |
| Provider adapters | 把外部 metadata 或 asset candidate 转为中性形状 | provider record id、locator 和 provenance | 决定 Work/版本身份或 canonical 值 |
| Network boundary | 执行通用 HTTP 安全与有限资源约束 | 非敏感 transport diagnostics | 业务重试策略、资产验收和 browser 内部实现 |
| Catalog/Library | 维护 Work、WorkVersion、canonical metadata、observations、authors、registries、tags、references、current result 和 lineage | 文献业务事实与关系 | 存储大型 BLOB、绝对路径或领域 payload |
| Acquisition | 为具体 WorkVersion 填补 primary PDF asset gap，编排竞速和回退 | acquisition overall/per-source diagnostics | 直接发布文件、生成分析或改变书目身份 |
| Storage | 验证 hash 后不可变发布 RawAsset 和派生产物 | 文件字节、相对路径、hash | 决定哪个版本 preferred 或哪个 metadata canonical |
| PDF normalization/OCR | 通过 operator-managed MinerU 3.4.4 service 从 accepted PDF 产生可分析全文、结构和 evidence，并验证 service result | immutable parser artifacts、normalized content、PDF locators 与 external attempt metadata | 启停/升级 MinerU、拥有 GPU/model/capacity、网络获取、身份去重或领域抽取 |
| Analysis | 只基于合格 PDF 生成原文语言 current result，并形成受约束 proposals | current sections、最终 fulltext metadata、references、generated tags 的原子 promotion | 获取 PDF、修改 RawAsset、删除 manual 数据、保留分析历史 |
| References/Expansion | 维护版本级引用、unresolved、cited-by 派生，并让每个图节点调用共享完成管线 | VersionReference、invocation-local visited/层级结果和诊断 | 复制完成逻辑、猜测创建 Work 或设置隐藏文献数上限 |
| Library Query/Curation/Export | 提供 exact/keyword/filter/traversal、待复核项、人工修订和显式导出 | manual overrides、可撤销审计、派生视图和 export artifact | 暴露 backend observations、删除来源证据或建立首版 vector index |
| Failures/Diagnostics | 汇总 metadata、acquisition、analysis、expansion 的对象级 reason/action；acquisition 提供脱敏 source details | 诊断历史、failure 和 lineage | 成为产品导航中心或泄漏 secret |
| Packaging/Boundary | 形成稳定下游文献表示和 export snapshot | DocumentPackage/导出产物 | 充当 WorkVersion 身份或领域数据库 |
| Downstream Domain Pack | 从 DocumentPackage 生成领域数据 | 下游 JSONL/CSV/schema/manifest | 把领域字段写回 SciRetriever catalog |

## 2. 核心关系

```text
Work
  |-- identifiers
  |-- preferred_work_version_id
  |-- canonical tags
  `-- WorkVersion[]
        |-- version identifiers and canonical metadata
        |-- MetadataObservation[]
        |-- Authorship[] -> Author
        |-- Publisher -> flat registry
        |-- Venue -> independent flat registry
        |-- primary PDF
        |-- optional supplemental XML / HTML
        |-- VersionReference[] -> Work or UnresolvedReference
        `-- current generated result only
```

`Work` 聚合同一学术工作。`WorkVersion` 表达实际书目版本；provider record 只是 observation，不按 provider 一条记录创建一个版本。版本先按规范化稳定版本标识符精确匹配；不同非空 DOI 永不属于同一版本。无稳定标识符时，只有 normalized title、version class、publication date 和规范化 Venue 全部精确相同且没有标识符冲突才自动合并，否则保留独立 provisional version。不同 DOI 的预印本和正式版只有在 provider/registry 给出明确版本关系或用户确认时才归入同一 Work；标题相似本身不能触发跨版本归组。版本拥有全文资产、作者顺序、版本 metadata 和引用。处理快照和 `DocumentPackage` 导出快照始终使用独立身份，不承担书目版本职责。

preferred version 使用确定性总排序：`formal publication > accepted manuscript > preprint > unknown/other`，同级依次比较 DOI 是否存在、完整 publication date（较新优先）、configured provider precedence，最后用规范化稳定 version key 升序打破平局。新增 observation 时在同一次原子 catalog 更新中重算 preferred pointer；排序不得依赖 provider 返回或完成顺序。

## 3. Metadata 写入流

```text
query
  -> launch configured metadata providers concurrently with bounded fan-out and per-provider timeout
  -> collect each response or terminal deadline
  -> provider-neutral observations
  -> normalize identifiers and titles
  -> reject auto-merge when both nonempty DOI values differ
  -> allow DOI + no-DOI exact normalized-title merge and DOI enrichment
  -> deterministic Work/WorkVersion match
  -> save MetadataObservation
  -> provider precedence, then fill missing
  -> provisional provider metadata projection + OA status
  -> conservative Author/Authorship match
  -> existing Publisher/Venue alias mapping + provider precedence
  -> unresolved Publisher/Venue when no deterministic match
```

查询默认合并为最多 100 个 Work。所有启用的 metadata provider 在有界并发下启动并各自受有限 timeout 约束；合并只依赖收集到的响应集合、规范化规则和 configured precedence，不依赖完成顺序。两个不同非空 DOI 永不因标题相同自动合并；一个 DOI 记录与一个无 DOI 记录可以在 exact normalized-title match 时合并并补 DOI；两个无稳定标识符记录只按采用版本化规则生成的 exact normalized-title key 合并。不做 fuzzy 或 LLM 去重。明确的跨版本关系进入待验证关系并可把不同 WorkVersion 归入同一 Work；没有关系证据时保持独立。低优先级 provider 只补空字段，冲突 observation 仍保留。metadata source keywords 只作为 observations 保存，不在该层生成 canonical tags。该阶段产生的 projection 可供查询和资产获取，但在 PDF/LLM promotion 前始终是临时元数据。

search limit 的内置默认是 100 个合并 Work，TOML 可修改，CLI `--limit` 只覆盖当前 invocation。provider observations 和原始 shape 只保存在后端供审计和重算，普通 library/search/export 只读取 canonical projection。

## 4. 全局完成管线与前台执行层级

所有写入型入口在单进程前台调用同一个 completion orchestration。它不保存新的 workflow 状态，而是根据 invocation target 和 catalog 权威事实确定当前阶段：

```text
METADATA_PENDING
  -> metadata providers + identity convergence + provisional provider projection
ASSET_PENDING
  -> primary PDF acquisition + validation + immutable acceptance
ANALYSIS_PENDING
  -> MinerU + LLM + PDF evidence + canonical promotion
COMPLETE
```

`METADATA_PENDING` target 可以只是当前 invocation 中的规范化 DOI，不要求预建 WorkVersion 或持久化 status；该阶段结束时只得到支持身份、查询和下载的临时 provider metadata。`ASSET_PENDING` 只在 accepted primary PDF 存在时结束；`ANALYSIS_PENDING` 只在 current analysis、最终 canonical metadata、references 和 generated tags 原子对齐后结束。`COMPLETE` 是唯一表示整篇 WorkVersion 文献信息已完成的阶段。

DOI/稳定标识符和普通 search 从 metadata 阶段进入；已有 WorkVersion 的 download 从资产阶段进入；已有 accepted PDF 的 analyze 或本地资产入口从分析阶段进入；已有 current result 和最终 projection 的对象直接复用 `COMPLETE`。metadata/download/analyze level 是 invocation 的显式停止点，不改变全局阶段语义。

供应商全部失败、资产来源耗尽、MinerU/LLM 失败或 Ctrl+C 都不产生新的文献状态；对象保持在当前阶段。一次 download 已穷尽来源时仍是 `ASSET_PENDING`，一次 analyze 失败时仍是 `ANALYSIS_PENDING`；已有有效 `COMPLETE` 的强制重析失败则保留旧 current 并继续为 `COMPLETE`。重跑按稳定身份、资产关系、输入 hash 和 current 指针只执行缺失阶段。

普通 search 接受 `metadata/download/analyze` level 并使用 TOML 默认值。`download`/`analyze` 没有任何 ID 或 selection 时 fail closed，不隐式处理全库；全库补全与强制重析必须使用显式 all/force 语义。Ctrl+C/cooperative stop 只停止本次前台 invocation，不建立 durable task control。

## 5. Acquisition 流

```text
WorkVersion needs primary PDF
  -> direct official + publisher + open + configured Sci-Hub providers, bounded in-process race
     -> inside each provider: resolve -> deduplicate -> deterministic candidate fallback
  -> if no accepted PDF: bounded landing-page translator
  -> if still missing: configured browser path
  -> validation and identity check
  -> immutable RawAsset linked to WorkVersion
  -> optional XML / HTML according to config
```

第一层使用两级调度：配置的 providers 进行有界竞速；每个 provider 进行有界 resolution 并产生 provider-neutral runtime candidate，候选可携带受控请求凭据或 auth reference，但这些敏感字段不得持久化或进入 diagnostics。候选在 provider 内去重并按确定性顺序逐个执行和回退。共享 candidate executor 统一执行候选 transport、预算、内容与身份 validation；只有第一个验证合格的 winner 可以进入 immutable acceptance，loser 即使稍后完成也不能发布。translator 和 browser 不参加第一层竞速。

每种 direct、official/open、Sci-Hub、translator 和 browser 路径都必须具有明确配置、安全边界、离线 fixture 和用户文档。所有路径共享 secure transport 或经批准的等价边界、有限 timeout、validation、immutable acceptance 和 redaction。

如果所有来源都失败，用户看到一个 overall reason/action，并可展开每个来源的脱敏 details。某一 provider 失败但其它 provider 赢得合格资产时，该失败只进入 diagnostic details，不改变最终 acquisition success。所有 overall 和 source-level 输出都经过 redaction。

## 6. 分析流

```text
accepted WorkVersion primary PDF
  -> validate PDF identity, completeness and content
  -> deterministic processing-run claim by PDF hash + parser/model/config identity
  -> fixed MinerU service health/version/protocol check
  -> async submit/poll/result download; never start or own the service
  -> validate bounded result archive, middle/content/model JSON, page geometry and evidence
  -> publish immutable parser artifacts and PDF-derived normalized/OCR content
  -> optionally use XML/HTML for structure hints or corroboration, never as replacement authority
  -> block analyze when no accepted PDF exists, even if XML/HTML exists
  -> parse references when useful to fulltext processing
  -> fulltext-only LLM in original language
  -> extract original Abstract, generate only if absent
  -> allowed Publisher/Venue IDs + tag registry candidates
  -> ten stable section IDs + localized headings + flexible Markdown
  -> build and validate complete replacement off to the side
  -> attach primary-PDF page/span evidence locators to derived sections, fields and references
  -> atomic replacement of current sections, canonical projection, references and generated tags
  -> WorkVersion completion stage becomes COMPLETE
  -> delete/replace old generated content, no analysis history
  -> replace generated tags, preserve manual tags
```

PDF 是分析事实和 evidence 的基准。XML/HTML 与 PDF 一致时可补充结构定位；发生冲突时 PDF 控制生成内容和 canonical projection，补充资产只保留 provenance/diagnostic evidence。十个 stable section IDs/core sections 为 `document_information`（Document Information/Metadata）、`abstract`（Abstract）、`research_background`（Research Background）、`research_question_and_objectives`（Research Question and Objectives）、`research_approach`（Research Approach）、`methods`（Methods）、`data_and_materials`（Data and Materials）、`results`（Results）、`conclusion`（Conclusion）、`limitations`（Limitations）。heading 使用论文语言；metadata 是普通正文 section/table，不是 YAML front matter；section 内可使用段落、列表、表格和子标题；Data/Materials 不强制表格；证据不足时明确说明，不得幻觉。完整 reference list 默认不进入 light Markdown，可选追加或导出，但不禁止 references 参与解析或 LLM context。

WP4 primary parser 是 pinned MinerU 3.4.4 `vlm-engine`，SciRetriever 只连接 operator-managed persistent `mineru-api`。`normalization` owns connector、service result validation、source-unit/evidence conversion 和 immutable parser artifacts；`analysis` 只消费验证后的 normalized artifacts。MinerU task、Markdown、VLM text 或 bbox 本身都不构成 current result，也不改变 primary PDF 的权威性。

connector 使用 async `/tasks` lifecycle。loopback endpoint 可使用固定 loopback HTTP；remote endpoint 必须为明确授权的 HTTPS origin，认证由运行时 secret reference 和 reverse proxy/private transport 提供。客户端不跟随 redirect，不使用响应返回的任意 absolute task URL，也不把 `server_url` 交给调用者。result ZIP 在临时边界内做路径、symlink、压缩比、文件数、字节数、schema、page/bbox 和内容 limits 后才进入 immutable publication。

MinerU 3.4.4 没有 cancel 或 idempotency API，task state 也只在 service process memory 中保存。SciRetriever 把 task ID 作为 processing attempt metadata，而不是产品 job。Ctrl+C 停止新提交和 polling；远程 task 可能继续执行。重跑先恢复仍存在的 task，`404`/过期时在同一 deterministic processing run 下创建新 attempt。只有本地 result validation 和 publication 成功才把 normalization 计为完成。

parser/service/model/backend/config/input/output hashes 和 operator-attested model revision 进入 provenance；service 版本或模型升级必须重新通过 acceptance corpus。

失败发生在 replacement 前，因此旧 current result 保持可用。replacement 成功后旧 generated content 被删除或替换，不保留 analysis history。RawAsset、current parser/model/schema metadata、provider observations 和 manual tags 保留。

canonical projection 在同一次原子 replacement 中按 `manual edit > current validated fulltext-derived nonempty value > provider precedence/fill-missing` 重建。新分析没有给出某字段时回退到 provider observation，不写空值，也不继续保留没有当前证据的旧 generated 值。stable identifier 必须通过程序验证，不能仅凭 LLM 字符串创建。首版只建 open-access canonical 状态，不建 license/retraction/correction/erratum 模型。

## 7. 引用扩展流

```text
seed Work set
  -> direction references | cited-by | both
  -> stable visited Work identity set prevents cycles/re-enqueue
  -> each new node calls shared completion orchestration
  -> only COMPLETE versions contribute their current references
  -> incomplete nodes remain at METADATA_PENDING / ASSET_PENDING / ANALYSIS_PENDING
  -> next layer
```

默认方向是 references。用户只控制 depth，产品不设置 maximum-new-documents cap。每层报告计数。一个 branch 失败只停止该 branch，其它 branches 继续。Ctrl+C 停止新记录并安全闭合当前有限操作；重跑跳过完成内容。resolved 引用连接目标 Work，cited-by 从 VersionReference 反向派生；未解析项保留原始文本和可得标识符，等待后续重跑补全。

## 8. 标签与作者

canonical tags 是扁平英文集合。analysis 向 LLM 提供整个 registry 或相关候选，LLM 选择 stable IDs，并可输出带 English canonical name、definition 和 multilingual aliases 的 separate new-tag proposal。normalization comparison 合并 synonym/alias 或创建新扁平 tag。用户 tag 使用同一 registry；manual/generated links 分开，重新分析只替换 generated links。metadata source keywords 只作为 observations 保存。

Publisher 和 Venue 分属两个扁平 registry，各有 official/canonical name 和 aliases，无层级。metadata 只按现有 alias mapping 与 precedence 解析。analysis 只允许 LLM 从给定 IDs/names 中选择；未知值保持 unresolved 或形成 separate new-entity proposal，不能静默创建 spelling variants。

Author 独立存在，Authorship 属于 WorkVersion。ORCID 等稳定标识符允许确定合并，姓名相似只形成候选或保持分离。

## 9. 本地 Library Search

local search 支持 exact DOI/title/internal-ID lookup；title、Abstract、light Markdown keyword search；author、year、publisher、venue/journal、tag filters；references/cited-by traversal。首版不建立 vector index，vector semantic search 明确延后。

## 10. 数据所有权与普通用户视图

| 数据 | 权威所有者 | 普通用户看到 | 后台保留但默认不展示 |
|---|---|---|---|
| Work/WorkVersion identity | catalog | 一个 Work、版本列表和 preferred version | 匹配过程与 provisional evidence |
| canonical metadata | catalog projection | `COMPLETE` 后的当前标题、Abstract、日期、Publisher/Venue 等 | provider 字段冲突和重算输入 |
| provider metadata | MetadataObservation + provisional provider projection | analysis 前可作为临时查询/获取视图 | provider、时间、字段值、record id、provenance |
| completion stage | 由 catalog 事实派生 | `METADATA_PENDING`、`ASSET_PENDING`、`ANALYSIS_PENDING` 或 `COMPLETE` | 不保存第二套 workflow 状态 |
| primary PDF | immutable storage + catalog link | 可阅读/导出的版本 PDF | hash、接收来源和验证证据 |
| XML/HTML | supplemental asset links | 按需查看或不展示 | 结构补充、交叉核对和 provenance |
| current analysis | WorkVersion current pointer | 原文语言 light Markdown、生成标签和引用视图 | parser/model/schema/input hash |
| manual metadata/tags/preferred/version relations | catalog | 与 current view 合并后的人工内容和选择 | 前后值、操作者时间、关系证据和撤销记录 |
| references | VersionReference | references/cited-by traversal | unresolved 原文、匹配证据和重跑状态 |
| failures | diagnostics | overall reason/action，按需展开 source details | 脱敏 acquisition diagnostic records |
| 文件字节 | storage | 通过 catalog 关系访问 | 实际存储路径细节不进入普通视图 |

canonical metadata 不是简单选一个 provider 值，而是当前投影：

```text
manual edit
  > current validated PDF-derived nonempty value
  > metadata observations by configured precedence and fill-missing
```

新分析没有给出某字段时回退到 manual/provider 值，不写成空，也不保留已经失去当前证据的旧 generated 值。普通 search/library/export 读取 canonical projection，不读取原始 provider shape。

## 11. 关键跨模块决策门

| 决策门 | 输入 | 决定 | 失败或不确定时 |
|---|---|---|---|
| Work identity | 稳定 ID、normalized title、明确跨版本关系 | 合并到现有 Work、把版本归入同一 Work 或创建新 Work | DOI 冲突且无关系证据时保持分离/人工复核 |
| WorkVersion identity | version ID、class、date、Venue | 连接现有版本或创建 provisional version | 不按 provider 条数创建版本 |
| preferred version | version class、DOI、日期、provider precedence、manual override | 主视图使用哪个版本 | 保留所有非 preferred 版本；manual override 优先 |
| canonical field | manual、PDF-derived、provider observations | 当前用户可见字段 | unresolved 保留，低优先级只补空 |
| Author match | ORCID 和明确佐证 | 合并 Author 或新建 Authorship | 姓名相似但证据不足时不合并 |
| Registry match | allowed Publisher/Venue/tag IDs 和 aliases | 使用现有实体或提交 proposal | 不静默创建拼写变体 |
| Acquisition tier | 前层是否已有 accepted PDF | 停止、进入 translator 或进入 browser | 耗尽后记录 overall failure |
| Race acceptance | candidate 内容、角色、身份、hash | 接受唯一 winner | loser/无效内容不得 late accept |
| Analyze eligibility | accepted primary PDF | 允许 PDF-based analysis | XML/HTML-only 拒绝运行，对象保持 `ASSET_PENDING` |
| Parser service readiness | fixed endpoint、mode、health/version/protocol、auth、bounds | 允许提交 MinerU async task | 不启动服务；错误版本、不安全 endpoint 或缺配置时拒绝提交，完成阶段不变 |
| Parser result admission | task result ZIP、schema、page geometry、PDF locators、hash/limits | 发布 immutable parser artifacts 和 normalized source units | service completed 不等于成功；任一边界失败时拒绝 |
| Result promotion | 完整 payload、schema、PDF locators | 原子切换 current result | 任一验证失败则保留旧 current |
| Completion stage | provider projection、accepted primary PDF、current analysis/final projection | 下一缺失阶段或 `COMPLETE` | 失败保持原阶段，重跑同一管线 |
| Reference resolution | DOI/稳定 ID/确定性 identity | 链接目标 Work | 保存 unresolved raw reference，不猜测 |
| Expansion scheduling | depth、direction、visited set、完成状态 | 当前层新 Work 和下一层 | branch failure 隔离，循环不重复入队 |
| Backfill selection | IDs、query/filter、tags、显式 all/force | 本次处理范围 | 无 selector 时 fail closed |

## 12. 失败、状态与恢复模型

产品不建立或暴露后台 job 状态机，只使用四个由数据事实确定的完成阶段：

| 状态 | 含义 | 用户下一步 |
|---|---|---|
| `METADATA_PENDING` | 尚无足以确定身份并支持资产获取的 provider metadata；target 可以只是 invocation-local DOI | 运行 metadata/search 阶段 |
| `ASSET_PENDING` | 已有临时 provider projection，但没有 accepted primary PDF | 运行或重跑 download |
| `ANALYSIS_PENDING` | 已有 accepted primary PDF，但没有完成 MinerU/LLM 与最终 projection | 运行或重跑 analyze |
| `COMPLETE` | current analysis、最终 canonical metadata、references 和 generated tags 已原子对齐 | 查询、扩展、导出；仅显式 force 才重析 |

```text
provider/source diagnostic failure
  -> another source succeeds? -- yes -> overall success + losing diagnostic detail
  |                              no
  v
all sources exhausted
  -> one redacted overall reason/action
  -> expandable redacted per-source details
  -> fix config/source condition
  -> rerun idempotently
```

`failures` 把 metadata、acquisition、analysis 和 expansion 的 invocation 失败统一投影为“阶段 + 对象 + overall reason/action + 重跑建议”，但 failure record 不改变四阶段模型。metadata 的单 provider 失败在仍有其它响应时只进入命令汇总；全部 provider 失败时对象保持 `METADATA_PENDING`。acquisition 可展开脱敏 per-source details，全部耗尽时对象保持 `ASSET_PENDING`。analysis replacement 失败保留旧 current；没有旧 current 的对象保持 `ANALYSIS_PENDING`。expansion 只停止该 branch，其它 branch 继续。

Ctrl+C 不是 durable pause。进程收到中断后停止领取新记录，安全排空或取消当前有限本地操作，保留已经提交的 Work、资产和 current result，然后退出。MinerU 3.4.4 没有 cancel endpoint，已提交的外部 parse task 可能继续运行；其 handle 仅保存在 processing attempt metadata 中供下次 invocation 恢复 polling，不能据此声称任务已取消、exactly-once 或 durable workflow ownership。下一次命令通过 catalog 完成状态和 processing run identity 跳过已完成内容。

## 13. 完整用户旅程

#### 从关键词到可用文献

```text
search query + level=analyze
  -> shared completion orchestration
  -> METADATA_PENDING: providers + deterministic Work/WorkVersion merge + provisional projection
  -> ASSET_PENDING: primary PDF acquisition
  -> ANALYSIS_PENDING: operator-managed MinerU + fulltext LLM + PDF evidence validation
  -> atomic current result + final canonical metadata + references + tags
  -> COMPLETE searchable Work view
```

#### 从已有库补齐缺失层

```text
library selection / tag / query / explicit all-missing
  -> download only versions missing PDF
  -> preserve already accepted assets
  -> explicit all-pending
  -> analyze only accepted PDFs without current result
```

#### 整理冲突、版本与人工内容

```text
library review
  -> 查看 identifier/版本/作者待复核项
  -> 显式 merge Works 或把 WorkVersion 归入已有 Work
  -> 设置/清除 preferred version
  -> 设置/清除 manual metadata，增删 manual tags
  -> [有明确证据] merge Authors
  -> 写入前后值与关系证据，可撤销
  -> 重新计算 canonical Work view，但不删除 observations/RawAsset
```

#### 从种子论文扩展引用图

```text
seed Works + direction + depth
  -> every layer node calls shared completion orchestration
  -> only COMPLETE nodes contribute outgoing references
  -> derive next-layer identities from references/cited-by
  -> visited dedup + branch isolation
  -> repeat until requested depth
```

#### 从本地库到下游领域数据

```text
WorkVersion + primary PDF + current generic result
  -> explicit library export as versioned DocumentPackage
  -> bind selected version/current inputs + stable IDs/hashes/provenance
  -> immutable export snapshot; later changes require a new export
  -> downstream Prompt + Schema + optional Validator
  -> authoritative domain JSONL + optional CSV
  -> consumer-owned database
```

领域数据不沿箭头反向写回 SciRetriever catalog；首版也不把 domain-run bookkeeping 作为产品能力。

## 14. 长期设计边界

| 长期保留原则 | 产品中不得存在 | 延后或排除 |
|---|---|---|
| Work identity 与稳定 identifiers | durable pause/resume/safe-stop control state | vector semantic search/index |
| RawAsset、hash 和不可变发布 | lease、fencing、后台 owner 协议 | Web UI、多用户权限和协作审批 |
| HTTPS/DNS/redirect/timeout/response bounds | retry-child 和 candidate checkpoint 产品语义 | institution registry/affiliation 消歧 |
| provider-neutral DTO 与 adapter 边界 | task-centered CLI、配置和导航 | license/retraction/correction canonical models |
| 进程内 acquisition race 和 validation | manifest 或 job 作为产品中心 | BibTeX/RIS/Zotero/local-directory import |
| normalization/evidence 与 package boundary | 将处理/导出快照伪装成 WorkVersion | domain extraction/schema/database |
| redaction、diagnostic history 和显式外部 parser adapter | legacy shape 反向定义产品模型 | SciRetriever-owned daemon/microservice、外部 workflow |

“延后”不等于自动批准，进入首版必须更新 requirements；“排除”涉及领域或架构边界时需要新 ADR。

## 15. 用户视图

```text
Local Literature Library
  Work: stable research identity
    Preferred WorkVersion: formal publication
      Canonical metadata
      Primary PDF
      Current PDF-based Markdown analysis
      Manual + generated tags
      Authors / Publisher / Venue
      References / cited-by
    Other WorkVersions
      Preprint / accepted manuscript / other evidence

User actions
  search/import/backfill -> shared completion orchestration -> COMPLETE
  library lookup/filter/traverse/review/curate/export
  expand references/cited-by by depth
  failures inspect -> fix -> rerun
```

产品不是一个“下载成功列表”，而是一套可以逐步补全、反复查询、沿引用扩展、用 PDF 证据核对并安全交给下游的本地文献知识底座。

## 16. 文档责任边界

产品 owner 日常只需阅读本文和[产品需求与验收规格](requirements.md)：本文解释模块责任、数据流和状态模型，requirements 定义功能、边界和验收。两份文档已经吸收适用 accepted ADR；ADR 仍保存决策授权与变更记录。工程团队另外维护[技术架构](technical-architecture.md)、[架构原则](../architecture/principles.md)、[provider 运维手册](../guides/provider-operations.md)和[代码文档责任映射](../governance/code-doc-map.md)。实现覆盖和差距只记录在[实施进度](../governance/implementation-progress.md)，不得反向改变三份规格定义的理想产品。
