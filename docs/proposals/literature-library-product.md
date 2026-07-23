+++
document_type = "proposal"
status = "direction-confirmed"
created = "2026-07-23"
updated = "2026-07-23"
+++

# 以 Work 为中心的文献库产品提案

本提案记录 owner 已确认的产品形态。它提供方向背景，不描述当前代码。当前行为见 [README](../../README.md)，覆盖与差距见[实施进度](../governance/implementation-progress.md)，实施顺序见[获批执行计划](../planning/literature-library-execution.md)。

## 1. 产品定位

SciRetriever 是本地、前台 CLI 驱动的科研文献库。核心体验是搜索文献，将书目和多个版本收敛到稳定 `Work`，获取各版本全文，生成可替换的通用分析结果，并沿引用关系扩展文献库。

它不是下载任务控制台，不运行 daemon，也不以 lease、fencing、worker ownership、durable pause/resume/safe-stop control state 或精确崩溃续跑为产品能力。前台命令仍响应 Ctrl+C：停止启动新记录，安全排空或取消当前有限操作，保留已完成记录；重复执行同一命令通过稳定身份、不可变资产和幂等写入跳过已完成内容。

## 2. 核心数据形状

### Work 与 WorkVersion

- `Work` 表示同一学术工作的稳定身份。
- 一个 `Work` 可有多个书目 `WorkVersion`，例如预印本、accepted manuscript、正式发表版本或版本化预印本。
- 版本选择优先正式发表版本，其次使用确定性规则和可验证证据决定；用户可显式覆盖 preferred version，清除覆盖后恢复自动选择。选择 preferred version 不删除其它版本。
- DOI 或其它稳定标识符优先用于身份收敛。两个记录都有非空且不同的 DOI 时，即使规范化标题相同也不得自动合并。一个有 DOI、另一个没有 DOI 的记录可以在规范化标题完全相同时合并，并让无 DOI 记录获得该 DOI。两个无稳定标识符的记录只按完全相同的确定性规范化标题键合并；不做 fuzzy 或 LLM 去重。
- 当前 `package_versions` 是处理快照，不是目标 `WorkVersion`。

### 版本资产

- 主文 PDF 归属于 `WorkVersion`，XML 和 HTML 是可选的同版本资产。
- PDF 是保存、阅读、导出和分析的基准资产。分析必须使用通过验证的 primary PDF 及其 normalized/OCR content；XML/HTML 只补充结构或交叉核对，不能覆盖 PDF，也不能在缺少合格 PDF 时独立完成分析。
- 原始资产一经接受即不可变。重跑分析在旁路构建 replacement generated content，不修改原始文件。

### 元数据与观察值

- `Work` 和 `WorkVersion` 只保存产品使用的 canonical metadata 字段与 open-access status，不把每个 provider 的响应形状提升为 canonical schema。
- 后端保存 `MetadataObservation`，记录 provider、观察时间、原始或规范化值、稳定记录标识和 provenance；这些 observations 不作为 canonical 值出现在普通搜索、查看或导出中。
- 配置明确 provider 优先级。合并时高优先级来源先填值，低优先级来源只补缺失字段，不无声覆盖已有 canonical 值。
- canonical metadata 包括标题、原始 Abstract、语言、类型、发表日期或年份、venue、publisher、卷期页码和稳定标识符。metadata 入库值先作为 placeholder；全文分析的当前非空、可验证结果更新 canonical projection，缺失字段回退到 manual/provider 值。open-access 只保存状态，不推导项目立场或使用限制；首版不建 license、retraction、correction 或 erratum 模型。

### Publisher 与 Venue

- `Publisher` 和 `Venue` 是两个彼此独立的扁平 canonical registry，各自保存官方或 canonical 名称和 aliases，不建立层级，也不把 venue/journal 当作 publisher alias。
- metadata 阶段只用已有 alias mapping 和 provider precedence 确定 placeholder 或 canonical link。无法确定的值保持 unresolved，不静默创建拼写变体。
- fulltext analysis 时，LLM 只接收允许选择的内部 registry ID 和名称，并按严格输出规则选择。没有合适项时输出 unresolved 或独立的新实体 proposal；proposal 经 normalization comparison 后才合并 alias 或创建新的扁平实体。

### 作者与标签

- `Author` 是独立实体，`Authorship` 连接作者与具体 `WorkVersion`，保存顺序和可得的角色信息。
- 作者合并采取保守策略。ORCID 等稳定标识符可确定合并；只有姓名相似而证据不足时保留独立记录，不用 LLM 猜测身份。
- affiliation 首版只保存论文中的 observation，不建立机构 registry 或机构消歧。
- canonical tags 是扁平、自增长的英文词表，不建立层级。metadata provider 的 source keywords 只作为 observations 保存，不提前成为 canonical generated tags。
- fulltext analysis 向 LLM 提供现有扁平 tag registry；registry 很大时提供与文献相关的候选子集。LLM 必须选择稳定 tag IDs，并可另行输出 new-tag proposal，包含英文 canonical name、定义和多语言 aliases。
- normalization comparison 将 proposal 与现有 aliases/definitions 比较，合并同义词或创建新的扁平 tag。用户标签使用同一 registry。manual 与 generated links 分开，重新分析只替换 generated links。

### 引用

- 引用属于具体 `WorkVersion`。
- 能以稳定标识符或确定性身份命中时连接到目标 `Work`，`cited-by` 由版本引用关系反向派生。
- 无法解析的引用保留原始文本、顺序和可得标识符，不为满足图完整性而猜测 `Work`。

## 3. 检索、下载与分析

### 三个处理层级

1. `metadata`：多 provider 查询、清洗、确定性去重、合并和入库，默认最多返回 100 个合并结果。
2. `download`：为已入库版本获取 PDF，并按配置选择 XML 和 HTML。可独立为已有元数据补全文。
3. `analyze`：只读取已保存并验证合格的 primary PDF，生成原文语言的通用分析。可独立为已有 PDF 补分析；XML/HTML-only 版本保持 pending/blocked。

普通 `search` 显式选择以上 level，未指定时使用 TOML 默认。独立 `download`/`analyze` 可按 Work/WorkVersion ID、library query/filter、tag 或显式 all-missing/all-pending 选择；没有选择器时不隐式处理全库，强制重析已有 current result 必须显式 `--force`。

### 全文分析

- LLM 只处理 primary PDF 的 normalized/OCR 全文，不根据标题、元数据或 XML/HTML-only 内容生成正文结论。
- 输出使用原文语言。优先抽取原始 Abstract；全文确实没有 Abstract 时才生成一个，并明确记录 `generated` 来源。
- Markdown 使用稳定内部 section ID，渲染 heading 使用论文语言：`document_information`（Document Information/Metadata）、`abstract`（Abstract）、`research_background`（Research Background）、`research_question_and_objectives`（Research Question and Objectives）、`research_approach`（Research Approach）、`methods`（Methods）、`data_and_materials`（Data and Materials）、`results`（Results）、`conclusion`（Conclusion）、`limitations`（Limitations）。
- 每个 section 内是灵活 Markdown，LLM 可按证据选择段落、列表、表格和子标题。`Data and Materials` 不强制为表格；证据不足的 section 明确写证据不足，不得补写或幻觉。
- section、fulltext-derived canonical field 和 resolved reference 必须保留指向 primary PDF RawAsset 的页码/span evidence locator；XML/HTML path 只能作为补充 locator。
- document information/metadata 是普通正文 section，可渲染为表格，但不是 YAML front matter。完整 reference list 默认不进入 light Markdown，可由用户显式追加或导出；reference parsing 仍可属于全文处理，本决策不禁止 references 参与分析上下文。
- 每个 `WorkVersion` 只有一份 current generated result。系统先在旁路构建并验证完整新结果；失败时旧结果保持可用；原子 replacement 成功后替换 light content、fulltext-derived canonical projection、fulltext-derived references 和 generated tag links，不保留分析历史。RawAsset、current parser/model/schema metadata、provider observations、manual metadata 和 manual tags 保留。

## 4. 引用扩展

- 从一个或多个种子 `Work` 扩展，默认方向为 `references`，也支持 `cited-by` 和 `both`。
- 用户只设置深度，不设置每层不同处理策略。
- 每一层先完成元数据收敛，再对该层所有新文献完整执行下载和分析，之后才进入下一层。
- 某版本没有取得合格 primary PDF 时，该版本的 analyze 失败或保持 blocked；它只停止对应 branch，不把 XML/HTML-only 结果计为该层分析成功。
- unresolved raw references 保留，后续 provider 补全后可在幂等重跑中解析。
- invocation 使用 stable Work visited set 去环并避免重复入队；跨 invocation 根据 catalog 完成状态跳过已完成项。
- 扩展只由 depth 限制，没有 product-level maximum-new-documents cap。命令逐层报告发现、已有、完成和失败数量。
- Ctrl+C 停止启动新记录并安全闭合当前有限操作；重跑跳过已完成内容。一个分支失败只停止该分支，其它分支继续。

## 5. 全文获取顺序

目标获取流为：

1. 直接官方地址、出版社接口和开放来源，以及用户配置的 Sci-Hub 来源，在同一 PDF 目标内进行进程内竞速。
2. 第一层没有合格 PDF 时，运行受限 translator 从 landing page 发现候选。
3. translator 仍无法完成时，使用显式配置的 browser 访问路径。
4. PDF 优先。XML 和 HTML 是否同时获取由配置决定。

现有代码已具备官方或开放 provider、直接 HTTPS、进程内 serial/race、安全 transport、验证和不可变接收。Sci-Hub、translator 和 browser 尚未实现，不能在当前用户文档中写成可用能力。

## 6. CLI 目标

目标命令树为：

| 命令 | 产品职责 |
|---|---|
| `search` | 多 provider 检索、合并、去重并写入文献库 |
| `expand` | 按 references、cited-by 或 both 扩展到指定深度 |
| `download` | 为库中版本补 PDF 和可选 XML/HTML |
| `analyze` | 为已有合格 primary PDF 补 current generated result；仅有 XML/HTML 时保持 pending/blocked |
| `library` | exact DOI/title/internal-ID lookup；title/Abstract/light Markdown keyword search；author/year/publisher/venue/tag filters；references/cited-by traversal 与导出 |
| `failures` | 查看每个最终 acquisition 失败的 overall reason/action，并展开各来源的脱敏细节 |
| `config check` | 检查严格 TOML、凭据引用、provider 顺序、路径和可选运行时 |

这些命令均为目标，当前命令树不同，详见 [README](../../README.md)。

本地搜索首版不包含 vector semantic search。向量语义检索明确延后；首版只实现 exact lookup、关键词、过滤和引用遍历。

`download`/`analyze` 无 ID 或选择器时 fail closed；全库补全必须显式使用 `--all-missing`/`--all-pending`，已有结果重析使用显式 `--all-current --force`。`library export` 默认不含完整 references，只有 `--include-references` 才追加。前台进度统一报告适用的 provider 返回、去重后 Work、新建/复用、下载和分析成功/失败计数。

## 7. 配置目标

- 一份严格 TOML 管理 catalog/assets 路径、search 默认 level/limit、metadata enabled providers 与优先级、acquisition tiers/order、LLM、translator、browser profile、资产格式和 30 秒文献启动间隔。
- 用户可把 secret 直接写入权限合格的 TOML，也可通过已声明的环境变量提供。任何输出和 durable provenance 都不得回显 secret。
- 未知字段 fail closed。程序不自动修改 TOML。
- CLI 显式参数只覆盖当前 invocation，优先于 TOML；`search --limit` 的内置 fallback 为 100。`config check` 同时检查目录权限、启用能力所需的 secret/模型/browser profile；未启用能力不强制配置。
- 当前 parser 不支持 provider precedence、LLM、Sci-Hub、translator、browser、标签词表、引用扩展或目标 CLI 配置。这些字段必须随实现和 parser 同步进入示例，不能提前加入 `config.example.toml`。

## 8. 保留与移除

保留：`Work` 和标识符基础、不可变 `RawAsset`、安全 transport、有限 timeout、进程内竞速、内容验证、hash 去重、归一化、lineage、失败脱敏和前台 CLI。

允许删除或解耦：以 durable 下载任务为产品中心的 pause/resume/safe-stop control state、retry-child、candidate checkpoint、精确 crash resume 和相应配置或报告入口。删除 durable control state 不删除 invocation-local Ctrl+C/cooperative stop。任务历史可作为迁移期诊断数据保留，但不塑造新产品。

最终 acquisition 失败向用户显示一个整体 reason/action，并允许展开每个来源的脱敏细节。若某一来源失败但另一来源成功，losing provider failure 只作为诊断细节，不把 WorkVersion 标为最终失败。所有层级的输出都先脱敏。
