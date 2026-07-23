# SciRetriever 产品需求与验收规格

- 文档效力：2026-07-23 owner 批准的产品需求
- 决策依据：[ADR 0002](../adr/0002-work-centered-literature-library.md)
- 方向背景：[文献库产品提案](../proposals/literature-library-product.md)
- 产品设计：[系统设计](system-design.md)
- 实施顺序：[文献库执行计划](../planning/literature-library-execution.md)
- 决策追踪：[产品决策追踪](../governance/product-decision-trace.md)

本文只定义理想产品必须具备的能力、约束和验收结果，不记录实现进度。当前可运行行为见 [README](../../README.md)，实现覆盖与差距见[实施进度](../governance/implementation-progress.md)。

## 0. 文档用途与阅读方法

本文面向产品 owner、使用者和验收人员，回答五个问题：SciRetriever 是什么；用户能完成哪些任务；产品必须遵守哪些规则；哪些能力明确不属于产品；如何判断产品已经按要求完成。模块如何协同和数据如何流转见[系统设计](system-design.md)，代码模块、依赖和技术边界见[技术架构](technical-architecture.md)。

本文使用以下范围词：

| 范围 | 含义 |
|---|---|
| 首版 | 理想产品第一版必须满足的要求 |
| 延后 | 方向未否决，但不属于首版产品合同 |
| 排除 | 不属于 SciRetriever，或必须通过新 ADR 才能纳入 |

本文的 `必须`、`不得`、`默认` 和需求编号均描述理想产品。提案提供方向背景，决策追踪保存讨论证据，但只有适用 ADR 和本文定义产品行为。

## 1. 产品目标与边界

SciRetriever 是以前台 CLI 操作的本地科研文献库。产品围绕 `Work`、书目版本、全文资产、作者、标签、分析结果和引用关系组织数据。用户可以检索并合并多来源元数据，为已有文献补全文或补分析，再按引用图扩展文献库。

### 1.1 一句话定位

**SciRetriever 把分散在多个来源的论文线索收敛成一个可持续维护的本地文献库，并以 PDF 为证据基准完成全文分析、检索、引用扩展和可审计导出。**

产品中心是文献及其版本，不是下载任务、provider 响应、单个 PDF 文件或后台 job。任务和失败记录只用于解释一次处理发生了什么；用户日常面对的是 Work、WorkVersion、全文、分析、标签和引用关系。

### 1.2 主要使用角色

这里的角色描述使用目的，不引入账号或权限系统：

| 角色 | 主要目标 | 典型操作 |
|---|---|---|
| 研究者 | 建立并使用自己的本地文献库 | 搜索、查看版本、阅读 PDF、检索分析、沿引用扩展、导出 |
| 文献整理者 | 补齐和修正文献数据 | 合并来源、选择 preferred version、补 PDF、补分析、维护 manual tags |
| 运行维护者 | 配置来源并处理失败 | 检查配置、查看脱敏失败、重跑缺失项、维护 provider 顺序 |
| 下游领域消费者 | 使用通用文献包生成领域数据 | 通过稳定 ID、hash 和 provenance 读取 `DocumentPackage`，不访问内部表 |

同一位用户可以同时承担前三种角色；首版不设计多用户权限、协作审批或 Web UI。

### 1.3 产品成功定义

| 成功结果 | 用户可观察的证明 |
|---|---|
| 文献身份稳定 | 多来源重复结果收敛到同一 Work；预印本与正式版作为不同 WorkVersion 保留 |
| 数据可逐步补全 | metadata、download、analyze 可分别运行，重跑只处理缺失或显式强制项 |
| 全文可信 | analysis 必须基于验证合格的 primary PDF，每项提升结果可回到 PDF 页码/span |
| 结果可持续维护 | canonical metadata、manual tags 和当前分析可更新，RawAsset 与 observations 不丢失 |
| 文献关系可探索 | 用户可查 references/cited-by，并按 depth 逐层扩展、下载和分析 |
| 失败可恢复 | 部分 provider 或 branch 失败不破坏已完成数据，用户能看到行动建议并幂等重跑 |
| 产品边界清楚 | 通用文献数据留在 SciRetriever；反应、分子等领域数据留在下游 domain pack |

项目边界继续止于通用、带 provenance 的文献表示。反应、分子、路线、材料属性等领域 schema 和数据库仍属于下游，见 [ADR 0001](../adr/0001-sciretriever-scope-and-boundary.md)。

执行模型是有界的前台命令和幂等重跑。产品不包含 daemon、lease、fencing、后台 worker ownership、durable pause/resume/safe-stop control state 或逐内部步骤的精确崩溃续跑。前台 invocation 必须支持 Ctrl+C/cooperative stop：停止启动新记录，安全排空或取消当前有限操作，保留已完成记录，随后重跑跳过已完成内容。task、attempt、failure 和 event 只支撑诊断与审计。

### 1.4 产品边界总览

| SciRetriever 负责 | SciRetriever 不负责 |
|---|---|
| 文献检索、身份、书目版本、元数据和来源观察 | 化学、生物、材料等领域抽取 schema |
| primary PDF 获取、验证、不可变保存和 PDF-based analysis | 反应、分子、路线、产率或领域数据库 |
| 通用 Markdown、标签、作者、引用和本地查询 | 下游预测、规划、统计分析或知识推理 |
| 失败诊断、配置检查、幂等补全和导出 | Web UI、daemon、外部 workflow engine 或微服务 |
| `DocumentPackage`、稳定 ID、hash 和 provenance 下游边界 | 下游直接查询 SciRetriever 内部存储结构或把领域字段写回 catalog |

## 2. 用户任务与完整工作流

### 3.1 常规发现与入库

用户输入关键词、标题、DOI 或其它受支持查询，选择处理到 `metadata`、`download` 或 `analyze` 层级。系统并发查询启用的 metadata providers，先清洗和确定性去重，再创建或更新 Work、WorkVersion、observations、authors 和 canonical placeholder。若选择更深层级，系统继续补 primary PDF 和 PDF-based analysis。

```text
查询
  -> 多来源 metadata
  -> 清洗、去重、版本识别
  -> 写入本地文献库 placeholder
  -> [可选] 获取并验证 primary PDF
  -> [可选] PDF normalization/OCR + LLM analysis
  -> 当前 canonical view、Markdown、tags、references
```

### 3.2 独立补全文与补分析

用户不需要重新搜索才能修复缺失层级。`download` 可为指定 ID、查询结果、标签集合或显式全部缺失项补 PDF；`analyze` 可为已有合格 PDF 的版本补 current result。没有选择器时命令不得隐式处理全库。已有结果只有在显式 all-current/force 语义下才重析。

### 3.3 本地查询、查看与导出

用户可以按 DOI、标题或内部 ID 精确查找，按 title、Abstract 和 light Markdown 做关键词检索，按 author、year、publisher、venue 和 tag 过滤，并遍历 references/cited-by。文献整理者可以查看待复核项，显式合并 Work、把已有 WorkVersion 归入同一 Work、设置或清除 preferred version、修订或清除 manual metadata、增删 manual tags，以及在有明确证据时合并 Author。每次人工操作都记录对象、动作、时间和前后值，不删除 observations、RawAsset 或其它版本。

`library export` 提供两类明确输出：面向阅读的 canonical metadata + light Markdown，以及面向下游的版本化 `DocumentPackage`。完整 reference list 只在显式要求时加入。`DocumentPackage` 导出绑定所选 WorkVersion、primary PDF、current result、稳定 ID、输入 hash 和 provenance；它是导出时刻的不可变快照。之后 canonical/current 内容变化不会静默改写旧快照，用户重新导出会得到与新输入对应的新快照。

### 3.4 引用扩展

用户从一个或多个种子 Work 出发，选择 references、cited-by 或 both 以及 depth。系统逐层完成新 Work 的 metadata、download 和 analyze，再进入下一层；循环和重复通过稳定 Work identity 去除，单分支失败不阻塞其它分支。

### 3.5 失败处理与恢复

用户通过 `failures` 统一查看 metadata、acquisition、analysis 和 expansion 的失败阶段、对象、overall reason/action 与重跑建议；acquisition 还可按需展开脱敏的 per-source details。某个 metadata provider 失败但仍有其它响应时，命令继续并在汇总中报告该来源；全部 provider 失败时 search 明确失败。analysis replacement 失败时旧 current result 保持可用，同时记录新尝试失败。Ctrl+C 停止领取新记录并安全结束当前有限操作；重跑根据已有 Work、资产和 current result 跳过完成内容，不依赖后台任务恢复协议。

### 3.6 配置与运行检查

用户通过统一 TOML 配置数据位置、默认处理层级、provider 优先级、获取顺序、LLM、格式和启动间隔，通过 `config check` 在实际处理前发现未知字段、缺失 secret、不可写目录、模型或 browser profile 问题。

## 3. 核心实体与身份

### 4.1 业务对象关系

```text
Work（同一学术工作）
  |-- stable identifiers
  |-- preferred WorkVersion
  |-- canonical tags
  `-- WorkVersion[]（预印本、accepted manuscript、正式版等）
        |-- version identifiers + canonical metadata
        |-- provider MetadataObservation[]
        |-- Authorship[] -> Author
        |-- Publisher / Venue
        |-- primary PDF + optional XML/HTML
        |-- VersionReference[] -> Work 或 unresolved reference
        `-- single current generated result
```

`WorkVersion` 是书目版本；processing snapshot 和 `DocumentPackage` export snapshot 是处理或导出结果。三类对象的名称、身份、生命周期和用户含义必须始终分开。

### FR-1 Work 与书目版本

- `Work` 表示同一学术工作的稳定身份。
- 一个 `Work` 可以连接多个 `WorkVersion`，包括预印本版本、accepted manuscript 和正式发表版本。
- provider record 是 observation，不天然等于一个 `WorkVersion`。版本先按规范化的稳定版本标识符（例如 DOI、arXiv identifier）精确匹配；不同非空 DOI 必须属于不同版本。没有稳定版本标识符时，只有 normalized title、normalized version class、normalized publication date 和规范化 Venue 都精确相同且不存在标识符冲突的记录才自动合并；关键证据缺失或冲突时保留独立 provisional version，等待后续确定性证据或人工复核。
- 不同 DOI 阻止的是仅凭标题把记录自动当成同一身份或同一版本，不阻止有明确版本关系证据的预印本与正式版归入同一 Work。只有 provider 提供的显式版本关系、稳定 registry 关系或用户确认可以跨不同标识符连接已有 WorkVersion；系统保留关系证据和原 Work 身份，人工操作可审计并可撤销。没有这类证据时保持为独立 Work，不凭相似标题猜测关系。
- 系统用完整、可测试且与 provider 完成顺序无关的排序选择一个 preferred version：`formal publication > accepted manuscript > preprint > unknown/other`，同级依次优先有 DOI、较新的完整 publication date、较高 configured provider precedence，最后按规范化稳定 version key 升序打破平局。新增 observation 后在同一次原子 catalog 更新中重新计算 preferred pointer。所有非 preferred 版本、关系和来源证据都必须保留。
- 用户可以显式覆盖 preferred version；显式选择存在时自动排序不得改写它，用户清除覆盖后才恢复自动选择。主文献默认展示 preferred version 的 canonical metadata、light Markdown 和 reference view，其它版本仍可独立查看。
### FR-2 确定性 Work 去重

- DOI 或其它稳定、规范化的外部标识符优先决定身份。
- 两条记录都有非空且不同的 DOI 时，即使 normalized title 相同也不得仅凭标题自动合并为同一 Work 或同一 WorkVersion；FR-1 定义的显式跨版本关系或用户确认除外，且两个 DOI 仍归属于不同 WorkVersion。
- 一条记录有 DOI、另一条没有 DOI 时，可以在 normalized title 完全相同的情况下合并，并把 DOI 补给原无 DOI 记录。
- 两条记录都没有稳定标识符时只按完全相同的 deterministic normalized-title key 合并。标题规范化规则必须版本化、可测试、与 provider 顺序无关；不做 fuzzy match。
- 标识符冲突或证据不足时保留独立记录并进入可查询的人工复核清单，不静默合并。用户未处理的复核项不会阻塞其它文献入库。
- LLM 不参与 Work、WorkVersion 或 Author 的身份去重。

### FR-3 版本资产

- primary PDF、可选 XML 和可选 HTML 归属于具体 `WorkVersion`。
- PDF 是保存、阅读、导出和分析的主文基准资产；XML/HTML 是可配置的补充全文资产。
- `analyze` 必须读取通过身份、完整性和内容验证的 primary PDF。XML/HTML 可以补充章节边界、表格或机器可读结构，并可用于与 PDF 交叉核对，但不能覆盖 PDF 支持的事实，也不能在缺少合格 PDF 时独立满足 `analyze`。XML/HTML 与 PDF 冲突时以 PDF 和其 evidence locator 为准，并保留补充资产的 provenance 供诊断。
- 同一字节按 hash 收敛，但每个版本与资产的关系和 provenance 独立保存。
- RawAsset 不可变，修复解析或分析时重跑派生步骤。

## 4. 元数据、作者与标签

### FR-4 Canonical metadata

canonical metadata 只保存稳定产品字段：标题、原始 Abstract、语言、work type、发表日期或年份、venue、publisher、卷、期、页码或 article number、稳定标识符和 open-access status。provider 专有响应字段不得直接进入 canonical schema。首版不建立 license、retraction、correction 或 erratum 的 canonical model。

open-access 只记录来源观察到的状态和 provenance，不表达项目对来源或用户行为的判断。

metadata 阶段的 canonical 值是可用但非权威的 placeholder。fulltext analysis 完成后，系统在同一次原子更新中按以下确定性投影重建 canonical metadata：手工修订优先；其次使用通过 schema、证据和 allowed-ID/identifier validation 的当前 fulltext-derived 非空值；仍缺失的字段按 provider precedence/fill-missing 回退到 observations。LLM 不得创造未经正文支持的标识符。新分析未提供某字段时，不把已有 placeholder 擦成空值。

### FR-5 MetadataObservation

- 每个 provider 返回的字段值在后端保存为 `MetadataObservation`，至少记录 provider、观察时间、目标 Work/WorkVersion、字段、值、provider record id 和 provenance。
- observations 和原始 provider shape 是 backend-only audit/recompute evidence，不作为 canonical 值显示，也不进入普通 library/search/export 输出；诊断输出只能显示经过脱敏的必要摘要。
- 配置决定 provider precedence。高优先级 provider 先确定 canonical 值，低优先级 provider 只填补缺失字段。
- 已有 canonical 值不因后到的低优先级 observation 被无声覆盖。冲突保持可审计。
- 相同输入和配置重复合并必须得到相同 canonical metadata。

### FR-6 Publisher 与 Venue registry

- `Publisher` 与 `Venue` 是两个独立的扁平 registry，各自保存 official/canonical name 和 aliases，不建立层级。
- metadata 阶段只通过确定性的现有 alias mapping 和 provider precedence 关联 registry。未知值保持 unresolved，不静默创建大小写、缩写或拼写变体。
- fulltext analysis 只接收允许的内部 Publisher/Venue IDs 和 names，并按 strict output 选择。没有匹配时输出 unresolved 或独立 new-entity proposal；normalization comparison 决定合并 alias 或创建新扁平实体。

### FR-7 Author 与 Authorship

- `Author` 独立于 Work 和版本存在。
- `Authorship` 连接 Author 与 `WorkVersion`，保存作者顺序及可得的角色、通讯作者或 affiliation observation。
- ORCID 等稳定标识符或明确的多项佐证可确定合并。仅姓名相同或相似时采取保守策略，证据不足则创建独立 Author 或进入人工复核，不静默合并。
- 首版 affiliation 只作为 Authorship observation 保存原始字符串，不建立机构 registry 或机构消歧模型。

### FR-8 Canonical tags

- canonical tag 词表为扁平、可自增长的英文词表，无父子层级。
- 非英文标签、拼写变体和同义词作为 alias 指向一个 canonical tag。
- metadata provider 的 keywords/topics 只保存为 source observations，不在 metadata level 生成 canonical tags。
- fulltext LLM 接收现有 registry，或在 registry 很大时接收相关候选，必须选择 stable tag IDs。它可以另行输出 new-tag proposal，包含英文 canonical name、definition 和 multilingual aliases。
- normalization comparison 把 proposal 合并为现有 synonym/alias，或创建新的扁平 tag。用户标签使用同一 registry。
- manual tag 和 generated tag links 的来源分开。重新分析替换 generated links，但不得删除 manual links。
- tag 合并必须可审计，不能依靠隐藏的层级推断。

## 5. 搜索与处理层级

### FR-9 多来源搜索

- 一次搜索必须在有界并发和各 provider 独立有限 timeout 下同时查询所有已启用的 metadata provider；不得因某个 provider 缓慢或失败而把其它 provider 串行阻塞到其后。
- 系统等待已启动 provider 完成或到达各自 deadline 后，再按 configured precedence 确定性合并；相同 provider 响应集合在任意完成顺序下必须产生相同结果。
- 默认结果上限为 100，指去重合并后的 Work 数，而不是每个 provider 各 100 条。
- TOML 可以修改默认上限，`search --limit` 只覆盖本次 invocation；优先级为 CLI 显式值、TOML 默认值、内置默认 `100`。任何覆盖都不改写 TOML。
- 清洗、稳定标识符匹配和 normalized-title 去重必须在任何 LLM 调用前完成。

### FR-10 三个处理层级

| 层级 | 本次操作的终止条件与持久状态 |
|---|---|
| `metadata` | Work、版本、canonical metadata、observations、authors/authorships、Publisher/Venue placeholders/links 和标识符已入库；provider source keywords 可作为 observations 保存，但不产生 canonical generated tags |
| `download` | 每个目标版本都得到 accepted primary PDF 或本次来源已耗尽并明确记录 PDF missing；只有前者计为下载成功和资产完备，后者仍是可由 all-missing 选择器重试的未完成资产缺口；按配置补 XML/HTML |
| `analyze` | 目标版本已有基于合格 primary PDF 的 current generated result；XML/HTML-only 不算完成 |

`download` 和 `analyze` 必须可作为独立 backfill 运行。已有 metadata 不要求重新搜索，已有全文不要求重新下载。

普通 `search` 必须接受 `metadata`、`download`、`analyze` processing level；未显式指定时使用 TOML 默认值。`download` 和 `analyze` 支持显式 Work/WorkVersion IDs、library query/filters、tag selection 和 all-missing/all-pending 选择器。无 ID 或选择器时不得隐式处理全库；全库补全必须显式使用 `--all-missing` 或 `--all-pending`。强制重析当前结果使用显式 `--all-current --force` 或等价双重确认语义。

## 6. 全文获取

### FR-11 获取顺序

1. direct official、publisher、open providers 和用户配置的 Sci-Hub provider 在同一 primary PDF 目标内进行进程内竞速。
2. 第一层没有合格 PDF 时，运行受限 translator，从文章 landing page 提取候选。
3. translator 耗尽后，运行显式配置的 browser 路径。
4. PDF 优先。XML 和 HTML 是否同时获取由配置决定。

### FR-12 获取安全、幂等与失败 UX

- 保留 HTTPS、DNS 与 redirect 检查、敏感 header 处理、有限 timeout、有界读取、内容和身份验证、进程内 race、不可变发布和 redaction。
- race loser 不得 late accept。未完整下载或未通过 validation 的内容不得进入 RawAsset。
- 重复命令通过 WorkVersion 身份、目标角色和内容 hash 收敛，不依赖 lease、fencing 或精确 checkpoint。
- 最终 acquisition 失败显示一个 overall reason/action，并允许展开 per-source details。某一来源失败但其它来源成功时，losing provider failure 只是诊断细节，不构成最终失败。
- overall 和 per-source 输出都必须脱敏。

## 7. 全文分析与生成结果

### FR-13 全文限定和语言

- LLM 只消费已保存并通过验证的 primary PDF 及从该 PDF 得到的 normalized/OCR content；可选 XML/HTML 只能补充结构或交叉核对，不用标题、搜索摘要、provider snippet 或 XML/HTML-only 内容代替 PDF 分析。
- 输出保持原文语言。
- 优先从全文抽取原始 Abstract。全文没有 Abstract 时才生成，并明确记录 `generated`；不得把生成文本冒充原始 Abstract。

### FR-14 固定核心与灵活 Markdown

- 固定核心使用以下 stable internal section IDs，渲染 heading 使用论文语言：`document_information`（Document Information/Metadata）、`abstract`（Abstract）、`research_background`（Research Background）、`research_question_and_objectives`（Research Question and Objectives）、`research_approach`（Research Approach）、`methods`（Methods）、`data_and_materials`（Data and Materials）、`results`（Results）、`conclusion`（Conclusion）、`limitations`（Limitations）。
- document information/metadata 是正常的 Markdown body section，可使用表格，不是 YAML front matter。
- 每个 section 内允许 LLM 按证据选择段落、列表、表格和子标题。`Data and Materials` 不强制为表格，也不固定为领域 schema。
- 证据不足的 section 必须明确说明证据不足，不得补写或 hallucinate。
- fulltext-derived section、canonical field 和 reference 必须携带可回到 primary PDF RawAsset 的页码/文本 span evidence locator；可另附 XML/HTML section/path 作为补充 locator，但不能替代 PDF locator。无法形成 PDF locator 的模型输出不得直接提升为 canonical field 或 resolved reference。
- 完整 reference list 默认不进入 light Markdown，可显式追加或导出。reference parsing 可以属于 fulltext processing；本需求不禁止 references 参与 LLM context/input。
- analysis 向 LLM 提供允许的 Publisher/Venue IDs/names 和现有 tag registry 或相关候选，并严格解析 stable IDs 与 separate proposals。

### FR-15 直接覆盖与原子替换

- 每个 `WorkVersion` 只保留一份 current generated result，不建立 analysis history。
- 系统先在旁路构建并验证完整新结果。构建或验证失败时旧 current result 继续可用，不能留下半个新结果。
- replacement payload 包含 light Markdown/sections、fulltext-derived canonical metadata 投影、fulltext-derived references 和 generated tag links。原子 replacement 成功后旧 payload 被删除或替换，不保留旧分析内容或旧 generated-result lineage 作为历史。
- RawAsset、current parser/model/schema metadata、后端 provider observations、手工 metadata 修订和 manual tag links 不随 analysis replacement 改变。新 payload 缺失的 canonical 字段按 FR-4 回退到手工值或 provider placeholder，而不是保留无来源的旧 generated 值。
- 书目 `WorkVersion`、current analysis 和 `DocumentPackage` 导出快照必须使用不同名称、身份和生命周期；处理或导出快照不得充当 analysis history。

## 8. 引用与扩展

### FR-16 版本级引用

- reference 从具体 `WorkVersion` 指向目标 `Work` 或 unresolved raw reference。
- resolved link 优先使用 DOI 或其它稳定标识符。无法解析时保存原始引用文本、顺序和可得标识符。
- cited-by 是已保存版本引用的反向派生视图，不是独立手工维护事实。

### FR-17 图扩展

- `expand` 默认方向为 `references`，支持 `cited-by` 和 `both`。
- 用户只指定 depth。depth 0 只处理种子，depth N 扩展 N 层。
- expansion 只由 depth 限制，不设置 product-level maximum-new-documents cap。
- 每次 expansion 使用稳定 Work identity 维护 invocation visited set；已经访问、已排队或已在当前层收敛的 Work 不重复入队，循环引用不能造成重复处理。跨 invocation 由 catalog 完成状态和幂等选择跳过已完成节点。
- 每一层必须先完成全部新 Work 的 metadata，然后完整执行该层的 download 和 analyze，再进入下一层。
- 命令报告每层发现、已有、完成和失败数量。一个 branch 失败只停止该 branch，其它 branches 继续。
- Ctrl+C 停止启动新记录并安全排空或取消当前有限操作；已完成记录保留，重跑跳过完成内容。
- 单项失败不得伪装成功。失败项保留诊断，整层完成状态必须可查询和幂等重跑。

## 9. CLI 与配置

### FR-18 CLI 与本地搜索

产品命令为 `search`、`expand`、`download`、`analyze`、`library`、`failures` 和 `config check`。它们都是前台命令，不要求后台服务。

`library` 首版必须支持：exact DOI/title/internal ID lookup；对 title、Abstract 和 light Markdown 的 keyword search；author、year、publisher、venue/journal 和 tag filters；references/cited-by traversal；待复核项查询；显式 Work 合并或 WorkVersion 归组；preferred version 设置/清除；manual metadata 设置/清除；manual tag 增删；有明确证据的 Author 合并。人工更改必须审计并允许撤销，自动重算不得覆盖仍有效的人工选择。Vector semantic search 明确延后，不属于 first release。

CLI 的具体安全边界为：`download`/`analyze` 使用 FR-10 的显式选择器；`library show` 读取单个 Work；所有人工合并、归组和修改都要求显式对象且不能隐式批量处理全库；`library export` 明确选择阅读版或版本化 `DocumentPackage`，只有显式 `--include-references` 才追加完整 reference list。`failures` 按阶段和对象查询失败，acquisition source details 保持脱敏。各前台命令统一报告 provider 返回、去重后 Work、新建/复用、下载 accepted/missing/failed、分析成功/失败等适用计数，不能把 PDF missing 计为下载成功。

### FR-19 严格 TOML

- 一份严格 TOML 管理 catalog database/assets 路径、普通 search 默认 level/limit、metadata enabled providers 与 precedence、acquisition tier/order、LLM、Sci-Hub、translator、browser profile、资产格式、引用导出和默认 30 秒文献启动间隔。
- secret 可以直接写入权限合格的 TOML，也可以通过明确支持的环境变量提供。
- 未知字段、错误类型和冲突设置 fail closed。程序不自动改写 TOML。
- CLI 参数只能覆盖本次 invocation，不持久修改 TOML。`config check` 至少验证未知字段、类型和冲突、所需 secret 引用、目录存在性/权限、provider/模型必填配置和启用 browser 的 profile；未启用能力不强制要求其 secret 或运行时。
- secret 不进入终端、JSON、日志、catalog details、provenance 或生成结果。

## 10. 跨能力质量规则

- 确定性：相同 provider observations 和配置得到相同 Work、版本、metadata 和作者连接结果。
- 保守合并：不因标题或姓名相似而静默误合并。
- 幂等：search、download、analyze、expand 重跑不重复创建身份或资产。
- 不可变：RawAsset 永不原地修改；current generated analysis 按 FR-15 直接原子覆盖，不建立分析历史。
- 可审计：canonical 值、current 生成结果、标签和引用能追溯当前来源与输入 hash；provider observations 独立保留。
- 安全：获取路径不绕过 transport、timeout、validation、redaction 和 immutable acceptance。
- 文档真相分离：README 只描述已发布行为；本规格只描述理想产品；实施覆盖和差距只在独立进度文档记录。

## 11. 关键产品决策及理由

本节汇总 owner 已确认的产品选择，帮助读者理解为什么需求采用当前形态。讨论证据和 supersession 见[产品决策追踪](../governance/product-decision-trace.md)。

| 决策点 | 采用方案 | 未采用方案与原因 |
|---|---|---|
| 产品中心 | Work-centered 本地文献库 | 下载任务中心不能表达研究者长期使用的文献、版本和引用关系 |
| 同一论文的版本 | 一个 Work 下保留多个 WorkVersion | 把预印本和正式版压成一条记录会丢失版本证据；按 provider 建版本会制造重复 |
| 身份去重 | DOI/稳定 ID 和 exact normalized title 的确定性规则 | fuzzy/LLM 去重不可重复且容易错误合并 |
| preferred version | 正式版优先的确定性排序，可由用户显式覆盖 | 自动删除其它版本或让 provider 完成顺序决定主版本均不可接受 |
| 元数据来源 | canonical projection + backend observations | 只保留一个 provider 会丢 provenance；把所有原始字段展示给用户会污染产品模型 |
| 全文基准 | primary PDF 是保存、阅读、导出和分析的权威资产 | XML 很难稳定获得且不能代表用户看到的版面；XML/HTML 只作补充 |
| LLM 使用边界 | 仅处理 PDF 全文，不参与 Work/版本/作者身份去重 | 标题、摘要或 provider snippet 不足以支撑正文结论；LLM 身份判断不可审计 |
| 分析输出 | 十个稳定核心 section，内部 Markdown 灵活并保留 PDF evidence | 完全自由结构难以检索；固定领域 schema 又会越过通用文献边界 |
| 重新分析 | 每个 WorkVersion 一份 current result，旁路构建后原子替换 | 保存分析历史增加产品和迁移复杂度，owner 已明确不需要 |
| 标签 | 扁平英文 canonical registry + 多语言 aliases，manual/generated 分离 | 主观层级不稳定；metadata keywords 不能直接成为 canonical generated tags |
| 引用 | 版本级单向 reference，cited-by 反向派生，unresolved 原样保留 | 猜测创建 Work 会污染引用图；双向手工事实会产生不一致 |
| 获取顺序 | 第一层来源竞速，随后 translator，再 browser | 全部串行会延迟常见成功路径；全部同时启动会浪费重型 browser 资源 |
| 执行模型 | 前台 CLI、合作式停止、幂等重跑 | daemon、lease、fencing、durable pause/resume 优化了任务控制而非文献库 |
| 引用扩展边界 | 只由 depth 限制，逐层完整处理并隔离失败分支 | 隐藏文献数上限会截断用户明确要求的图；重复和循环由 visited set 控制 |
| 本地搜索 | exact lookup、关键词、字段过滤和引用遍历 | vector semantic search 延后，避免首版引入另一套索引和相关性语义 |
| 产品领域边界 | 止于通用 `DocumentPackage` 和 provenance | 反应、分子、路线等领域 schema 属于下游 domain pack，不进入 catalog |

## 12. 延后与排除项

### 13.1 延后

- vector semantic search 和 vector index；首版只做 exact、keyword、filters 和 citation traversal。
- 机构 registry、机构 alias 和 affiliation 消歧；首版只保存 affiliation observation。
- 新的 license、retraction、correction 和 erratum canonical models；首版只增加 OA status。
- 多用户权限、协作审批和 Web UI。Web UI 同时受 ADR 0001 约束，纳入前需要新 ADR。
- BibTeX、RIS、Zotero library 和任意本地目录导入。本轮“入库”只指 metadata 候选清洗、去重并创建或更新 placeholder；新增导入格式需要单独输入契约和验收。

### 13.2 明确排除

- 反应、分子、合成路线、产率、材料性质等领域字段、schema 或 catalog 表。
- 下游领域数据库、预测、规划、统计分析或领域知识推理。
- daemon、外部 workflow engine、微服务、lease、fencing、后台 worker ownership 和逐内部步骤 exactly-once。
- durable pause/resume、retry-child、candidate checkpoint 或任务中心产品导航。
- 对旧下载任务 CLI、配置、状态和 codec 的完整向后兼容承诺。
- 把实际文献语料、运行时 catalog、secret 或用户身份写入代码仓库。
- 让下游直接访问 SciRetriever 内部存储结构；下游只能使用稳定 ID、hash、provenance 和 `DocumentPackage`。

## 13. 产品验收场景

以下场景是 owner 验收的最低集合。实现可以增加更细测试，但不得用“功能看起来正常”代替这些可观察结果。

| 场景 | 给定与操作 | 必须得到 | 必须避免 |
|---|---|---|---|
| 多来源搜索 | 固定多个 provider 响应，以不同完成顺序运行 search | 相同 Work、WorkVersion、canonical metadata 和计数 | provider 完成顺序改变结果 |
| DOI 冲突 | 两条 normalized title 相同但 DOI 均非空且不同 | 两个独立身份或人工复核 | 仅因标题相同自动合并 |
| DOI 补全 | 一条有 DOI、一条无 DOI且 exact normalized title 相同 | 收敛并补 DOI，保留两条 observations | 丢失来源证据 |
| 跨版本关系 | 预印本与正式版 DOI 不同，但存在明确 registry/provider 版本关系或用户确认 | 两个 WorkVersion 归入同一 Work并保留关系证据 | 仅凭相似标题自动归组或覆盖任一 DOI |
| 多书目版本 | 同一工作包含预印本和正式版 | 两个 WorkVersion 均可读，正式版默认 preferred | 删除预印本或把 processing snapshot 当版本 |
| preferred override | 用户显式选择非默认版本后新增 observations | 显式选择保持；清除后恢复自动排序 | 后台重算覆盖用户选择 |
| PDF 获取 | 多来源竞速，其中一个返回合格 PDF、其它失败或较慢 | 接受一个不可变 PDF；其它失败仅为诊断 | loser late accept 或保存无效内容 |
| 无 PDF | 只有 XML/HTML 或所有 PDF 来源失败 | download 记录缺失；analyze pending/blocked | XML/HTML-only 被计为分析完成 |
| PDF missing 重跑 | 某版本上次来源耗尽并记录 missing，随后运行 `download --all-missing` | 该版本重新进入获取；本次 accepted 与 missing 分开计数 | 把 missing 当作成功或永久跳过 |
| PDF 与补充资产冲突 | PDF 与 XML/HTML 内容不一致 | PDF 控制分析与 canonical projection，补充 provenance 保留 | XML/HTML 覆盖 PDF 事实 |
| 全文分析 | 合格 PDF 含可定位证据 | 原文语言、十个稳定 section、PDF page/span locators | 用标题/摘要替代全文或生成无证据结论 |
| Abstract 缺失 | PDF 确实没有 Abstract | 生成并标记 `generated` | 把生成文本冒充原始 Abstract |
| 重新分析成功 | 已有 current result，新的完整结果通过验证 | light content、fulltext metadata、references、generated tags 整体替换 | 保留旧 generated payload 形成隐式历史 |
| 重新分析失败 | 新结果构建或验证失败 | 旧 current result 继续完整可用 | 留下半个新结果或破坏 manual 数据 |
| manual/generated 分离 | 已有 manual tags 和 metadata 修订后重新分析 | manual 数据保留，generated links 更新 | 删除用户维护内容 |
| 人工整理 | 用户处理复核项、归组版本、修改 metadata/tag 或 preferred version | 立即反映在 canonical view，操作可审计并可撤销 | 删除 observations/资产或被自动重算静默覆盖 |
| unresolved reference | 引用没有稳定标识符或确定性匹配 | 保存原文、顺序和可得 ID，后续可重跑解析 | 为图完整性猜测创建 Work |
| 引用循环 | 固定引用图含循环和重复边 | 每个 Work 每次 invocation 只入队一次 | 无限循环或重复处理 |
| 分支失败 | expansion 某 branch 缺 PDF，其它 branch 正常 | 失败 branch blocked，其他 branch 继续；层级计数可对账 | 单分支失败终止全部扩展 |
| 跨阶段失败查询 | 固定 metadata 全失败、acquisition 耗尽、analysis replacement 失败和 expansion branch 失败 | `failures` 可按阶段/对象给出脱敏 reason/action；旧 current 仍可用 | 只显示总失败数或泄漏原始异常/secret |
| 无选择器 backfill | 运行 download/analyze 但不给 ID、query、tag 或 all selector | fail closed 并提示显式选择 | 隐式处理整个文献库 |
| Ctrl+C 与重跑 | 长操作中断后再次运行同一命令 | 不再领取新记录，保留完成项，重跑跳过完成内容 | 依赖后台 lease 或重复创建资产 |
| 配置检查 | TOML 含未知字段、错误类型、缺失启用能力 secret 或不可写目录 | `config check` 明确失败且不泄漏 secret | 自动改写配置或要求未启用能力的 secret |
| 下游边界 | domain pack 消费 DocumentPackage 生成领域数据 | 领域输出在下游 portable dataset/consumer store | 领域字段回写 SciRetriever catalog |
| DocumentPackage 重导出 | current result 更新后再次导出同一 WorkVersion | 新快照绑定新输入 hash；旧快照保持不可变且可追溯 | 静默改写旧导出或暴露内部表 |

## 14. 首版完成定义

产品首版只有在以下条件同时成立时才算完成：

1. CLI、schema 和用户流程以 Work/WorkVersion 为中心；任务历史只作为内部诊断，不形成任务中心产品面。
2. Work/WorkVersion、版本资产、observations、authors、registries、tags 和 references 已按本文身份规则运行。
3. search、download、analyze 和 expand 可独立、可组合、可中断并幂等重跑。
4. PDF 获取、PDF-based analysis、evidence locator 和原子 current replacement 通过离线验收。
5. local library 查询、人工整理、复核、可撤销审计和阅读版/`DocumentPackage` 显式 export 可用。
6. failures 能覆盖 metadata、acquisition、analysis 和 expansion，config check 能给出脱敏、可行动的结果。
7. README、示例配置和 `--help` 只声明已发布能力，并与[实施进度](../governance/implementation-progress.md)中的验证证据一致。
8. 任何适用的数据迁移、备份、回退、不可变资产和 retired-database safeguards 均通过相应人工门禁。
