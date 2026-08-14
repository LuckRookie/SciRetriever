# Entry 模块技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 设计责任：[设计文档 4.1](../design.md#41-入口与流程编排)
- 产品需求：[R1](../requirements.md#r1-发起文献收集)、[R2](../requirements.md#r2-多来源元数据搜索)、[R3](../requirements.md#r3-文献资产获取)、[R7](../requirements.md#r7-书目信息导入与导出)、[R8](../requirements.md#r8-大批量处理)
- 运行原则：[ADR 0011](../decisions/0011-literature-database-centered-incremental-maintenance.md)
- 发现与补全：[ADR 0013](../decisions/0013-decoupled-discovery-and-database-maintenance.md)
- Provider 与凭据：[ADR 0014](../decisions/0014-capability-scoped-providers-and-local-credentials.md)、[Configuration 技术文档](configuration.md)
- PDF 风险升级与批次：[ADR 0015](../decisions/0015-publisher-aware-tiered-pdf-acquisition.md)

本文定义目标 `src/sciretriever/entry/` 的用户输入、跨模块顺序编排、当前进程内批量补全、运行报告、查询和书目文件交换。Entry 是跨功能模块组织完整流程的唯一位置，不重新解释其它模块拥有的业务规则。

每个 Entry 操作都由用户请求和一致的当前文献数据库 snapshot 共同决定。查询和只读导出直接读取该 snapshot；外部发现形成持久化 DiscoveryRun，数据库补全只在当前进程内展开 selector、冻结目标并形成 Report。两者相互关联但不混成一个运行。Entry 不维护一套平行文献状态、批次历史或必须恢复的运行现场；新的发现和书目导入在目标接纳时同样查询当前数据库进行身份命中和去重。

## 1. 目标结构

```text
entry/
  api.py
  orchestration.py
  discovery.py
  execution.py
  ports.py
  cli/
    config.py
    commands/
    presenters/
  codecs/
    bibtex.py
    ris.py
    csl_json.py
```

- `api.py` 提供用户入口调用的稳定操作；
- `orchestration.py` 按缺失步骤调用模块公开 API；
- `discovery.py` 组织领域条件和引用扩展两种 DiscoveryRun；
- `execution.py` 解析类型化范围，在内存冻结 MetaLiterature/Literature 目标与版本候选，并形成当前运行 Report；
- `ports.py` 声明 DiscoveryRun 存储、current-facts 目标读取、写入准入、时钟和书目 codec；
- `cli/` 解析用户输入并呈现稳定结果；其中 `config.py` 只调用根级 configuration/bootstrap 提供的安全凭据与 probe 能力，不进入文献业务编排；
- `codecs/` 转换外部书目文件与中性记录。

## 2. 入口边界

CLI 或其它入口只负责：

- 解析用户参数和输入文件；
- 对手动 PDF 解析用户选择的具体 Literature 和输入路径，但不把绝对路径写入业务 Model 或持久化结果；
- 把外部值转换为 Model；
- 调用 Entry 公开 API；
- 呈现稳定结果和退出状态。

入口不执行身份收敛、元数据 precedence、PDF 检查、内容判断、SQL、网络或供应商协议。未知字段、组合和枚举在边界 fail closed；底层 traceback 不直接成为用户合同。

当前是否已经存在受支持 CLI 由 README、用户指南和安装后测试说明，不能从目标目录推断。

### 2.1 Entry 公开 API

目标 `entry/api.py` 只公开下面这些文献数据库用户操作。表中的英文是 Python API 责任名；它们与第 2.2 节的文献操作 CLI 对应，但 Python 函数名和 CLI 层级仍是两个不同合同，不能通过字符串转换自动生成。`config` 是生产启动配置的 CLI 边界，直接复用根级 configuration/bootstrap 能力，不进入 `entry/api.py` 的文献业务 API。

| 能力 | Python API | 输入 | 直接结果 |
|---|---|---|---|
| 领域发现 | `discover_topic` | `TopicDiscoveryInput` | `DiscoveryReport` |
| 引用发现 | `discover_citations` | `CitationDiscoveryInput` | `DiscoveryReport` |
| 数据库补全 | `complete_database` | `BatchRequest` | `DatabaseCompletionReport` |
| 手动 PDF 接纳 | `admit_manual_pdf` | `LiteratureId`；PDF 是本次只读 binary input | `ManualPdfReport` |
| 本地文献搜索 | `search_literature` | `LibrarySearchRequest` | `LibrarySearchPage` |
| 单篇详情 | `get_literature_detail` | `LiteratureId` | `LiteratureDetail` |
| 正向/反向引用页面 | `list_literature_references` | `LiteratureReferenceRequest` | `LiteratureReferencePage` |
| 引用关系详情 | `get_reference_detail` | `ReferenceId` | `ReferenceDetail` |
| Artifact 打开 | `open_artifact` | `Asset \| ParserArtifactRef \| ArtifactRef` | context-managed 只读 binary stream |
| Artifact 导出 | `export_artifact` | 同一 artifact 引用；本次目标路径；显式覆盖开关 | 正常返回或稳定文件错误 |
| 书目导入 | `import_bibliography` | `BibliographyFormat`；本次只读 binary input | `ImportReport` |
| 书目导出 | `export_bibliography` | `BibliographyFormat`；全库、DiscoveryRun、LibraryQuery 或明确 MetaLiterature/Literature 范围；本次目标路径 | `ExportReport` |

其中 binary input、binary stream 和目标路径是 I/O boundary 对象，不是 Pydantic 业务数据；它们不进入 JSON、Catalog、provenance 或 Report。手动 PDF 和书目导入可以由 CLI 路径、stdin 或程序内 reader 提供，但进入业务用例后只看到 reader 和已经解析的中性数据。Artifact 和书目导出在 Entry 边界接收用户目标；内部文件读取与原子输出分别通过受控 Port 完成。

这些操作的副作用边界固定为：

| 操作组 | 访问外部 Provider | 修改文献数据库 | 创建 DiscoveryRun | 形成处理 Report |
|---|---:|---:|---:|---:|
| 领域/引用发现 | 是 | 是 | 是 | 是，`DiscoveryReport` |
| 数据库补全 | 按缺失步骤可能访问 | 是 | 否 | 是，`DatabaseCompletionReport` |
| 手动 PDF 接纳 | 否 | 是 | 否 | 是，`ManualPdfReport` |
| 搜索、详情、引用页面/详情 | 否 | 否 | 否 | 否 |
| Artifact 打开/导出 | 否 | 否；导出只写用户目标文件 | 否 | 否 |
| 书目导入 | 否 | 是 | 否 | 是，`ImportReport` |
| 书目导出 | 否 | 否；只写用户目标文件 | 否 | 是，`ExportReport` |
| 统一配置中心与 status | 否 | 否；只安全修改普通配置和固定凭据文件 | 否 | 否 |
| Provider/LLM/MinerU test | 是；仅用户显式最小只读 probe | 否 | 否 | 否 |

读取操作直接返回 read result；不能为了接口统一套通用 Report。写数据库的四组入口必须取得写入准入，并只提交各业务模块已经确认的事实。公开 API 不接受 Provider 名称之外的私有参数、SQL、内部路径、adapter、数据库连接、HTTP client、Parser client 或 LLM client；实现选择只在 Bootstrap。

### 2.2 目标 CLI 命令树

安装后的命令根固定为 `sciretriever`。根级 `--debug` 选择逐步骤脱敏日志，默认使用正常日志；该选项不改变任何用户请求、Report、退出状态或持久化事实。一级名称按用户操作而不是内部模块划分为：

```text
discover
complete
literature
import
export
config
```

当前目标命令路径固定为：

```text
sciretriever discover topic
sciretriever discover citations

sciretriever complete

sciretriever literature search
sciretriever literature show
sciretriever literature references
sciretriever literature cited-by

sciretriever import metadata
sciretriever import pdf

sciretriever export metadata
sciretriever export pdf
sciretriever export content

sciretriever config
sciretriever config status
sciretriever config test <provider|llm|mineru>
sciretriever config test --all
```

命令语义为：

- `discover topic` 和 `discover citations` 分别形成领域或引用 DiscoveryRun；
- `complete` 接收一个类型化范围和 `pdf`/`content` 目标，分别映射到 `ASSET_READY`/`CONTENT_READY`，不再按 Acquisition、Parsing 和 Analysis 拆成用户命令；
- `literature search/show/references/cited-by` 只读取本地文献数据库，整个 `literature` 组保持只读；
- `import metadata` 读取 BibTeX/BibLaTeX、RIS 或 CSL JSON，允许创建或命中 Literature；
- `import pdf` 必须指定一个已经存在的具体 Literature，复制、检查并接纳用户 PDF，不隐式继续 Parsing/Analysis；
- `export metadata` 按已接受的导出范围与格式原子发布书目文件；
- `export pdf` 和 `export content` 从一个具体 LiteratureDetail 取得当前主 PDF 或规范轻结构化 Markdown 引用，再按 artifact 导出规则写入用户目标。
- 裸 `config` 打开统一交互中心，分区管理 LLM Analysis、MinerU Parser 和 Provider；核心服务同时安全发布普通配置与同一 `~/.sciretriever/credentials.toml` 中的 origin-bound secret，Provider 区设置/更新或移除自己的 section。公开子命令只保留 `status/test`，旧 `set/remove` 路径拒绝。`config status` 只做本地状态检查；`config test` 是用户显式发起并经过统一 Network 的最小只读 Provider/LLM/MinerU probe。这些动作都不读取或写入文献数据库，也不形成五类 Entry Report。

这里不建立 `exchange` 一级组，也不使用容易被理解为参考文献列表的 `bibliography` 命令名；书目信息文件统一称为 `metadata`。`metadata`、`acquisition`、`parsing`、`analysis`、`storage` 和 `artifact` 都不是当前一级命令：前五个是内部责任名称，通用 artifact 能力保留在 Python API，CLI 只暴露用户实际需要的 PDF 与 content。`config` 表达用户配置动作，不把 Configuration 提升为新的文献业务模块。

每个命令把外部参数严格解析成对应中性输入；selector、分页、格式、目标文件、`--json` 和 `--debug` 等参数组织不能改变对应 Model 语义。真实密钥不得作为普通 option 或位置参数，只能由裸 `config` 管理器通过不回显交互读取。管理器提示和结果写 stderr 且不提供 `--json`；其它命令的稳定文本或 JSON 主结果写 stdout，正常或 Debug 实时进度和脱敏诊断写 stderr。目标 CLI 尚未实现之前，README、用户指南和 `project.scripts` 不得把这些路径写成当前可用命令。

## 3. DiscoveryRun 编排

每次外部领域搜索或引用扩展创建一个即为 `RUNNING` 的 `DiscoveryRun`，本体只保存 ID、类型化输入、状态和开始时间；运行中逐条提交已经接纳的结果，结束时保存每个 Provider 的稳定终止结果和整体状态。完成后的输入、逐来源结果、发现对象和原因不可修改。本地 Literature 查询不创建 DiscoveryRun。

DiscoveryRun 的公开结果只说明发现：它不携带 `advance_to`、目标状态或自动内容处理选项。用户需要 PDF 或内容时另行发起数据库补全操作。当前 Entry 不提供 Collection 或 membership API。

### 3.1 领域发现

```text
查询文本/可选年份 + 每个 Provider 在整个 Run 内的 scan_limit
  -> 创建 topic DiscoveryRun
  -> 本次选择的全部 Metadata Provider 分别执行有界搜索
  -> 每条结果转换为 MetadataObservation
  -> Literature 使用稳定标识符及已解析 version_links 接纳身份和统一元数据
  -> Storage 原子保存 observation、文献事实、DiscoveryRun 结果与 topic 发现原因
  -> 各 Provider 结果耗尽或达到自己的原始扫描上限后结束运行
```

`scan_limit` 在最低身份准入和去重前统计 Provider 返回的每条原始 item；缺少标题/DOI、重复或最终未接纳仍计数。自然耗尽形成 `EXHAUSTED`，达到上限形成 `SCAN_LIMIT_REACHED`，分页中途失败形成 `FAILED` 并携带稳定脱敏 failure；source result 不保存 ordinal、扫描/接纳/拒绝计数或输入中已经存在的上限。单个 Provider 失败不撤销其它 Provider 已提交结果，失败前已接纳页面保留。

所有 Provider 正常到达边界时 Run 为 `COMPLETED`，正常与失败并存时为 `PARTIAL`，全部失败时为 `FAILED`。用户在边界前停止或恢复时发现遗留 `RUNNING` 才为 `INTERRUPTED`；停止后不发起新页，已接纳结果不回滚，未完成 Provider 不生成 source result，也不保存 cursor 原地续跑。零发现结果仍可正常 `COMPLETED`。

领域运行不会对每个发现结果再执行 `N × Provider` 精确补查，也不会继续 Acquisition。Entry 不执行 LLM、embedding、搜索分数、关键词、摘要分类或连续低收益相关性过滤；只让 Literature 应用标题或 DOI 的最低入库条件。有实际内容但偏题的文献仍是有效 Literature，不进入 `NoUsableContent`。

`MetadataObservation.version_links` 只为已经能够稳定解析为具体 Literature 的同文献版本目标提供身份收敛证据。目标尚未出现在本地或当前结果中时，Entry 保存来源 observation，但不为版本连接自动补查全部目标、不创建占位 Literature，也不建立独立关系；后续 DiscoveryRun 获得目标后可以重新进行确定性身份收敛。

### 3.2 引用发现

```text
具体 Literature 种子 + 方向/max_depth/result_limit + 每个 Provider 的 run-wide scan_limit
  -> 创建 citation DiscoveryRun
  -> Literature 解析本地种子身份
  -> Metadata 查询供应商引用关系
  -> 每条返回边形成 ProviderRelationObservation 并独立保存
  -> Entry 只选择本次边界内的 observation
  -> 对选中关系的非本地端点：
       ├─ 本地精确命中：使用现有 LiteratureId
       ├─ 响应内联 MetadataObservation：交给 Literature 接纳
       └─ 其它情况：Metadata Search 后交给 Literature 接纳
  -> 目标获得 LiteratureId 后建立 Reference 与 ProviderRelationSupport
  -> 保存 DiscoveryRun 结果与直接引用原因
  -> 逐层继续，直到达到用户边界或没有新文献
```

`ProviderRelationObservation` 是供应商有向边的最小持久化单位，也是后续 DiscoveryRun 可以重新读取的单位。一次查询返回几十条边时可以保存几十条 observation，但不会因此立即创建几十个 Literature、Reference 或 support。未进入本次边界、元数据不足或接纳失败的 observation 独立保留；它没有 expanded/status 字段，也不自行构成数据库补全目标。

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

## 4. 内容处理编排

普通范围先形成 `MetaLiterature` 目标，再按第 5 节在内存中冻结具体 Literature 候选；用户明确选择具体 Literature 时直接形成单版本目标。以下流程始终作用于当前选中的具体 Literature，形成的事实不会转移到其它版本。

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
       ├─ 不同 browser_rate_limit_group 并行
       └─ 同一 group 限速串行
```

较早在 Public 或 API 获得并完整提交主 PDF 的 Literature 不必等待整个 cohort 的 Browser
层结束，便可以在资源预算内继续自己的 Parsing/Analysis；层级屏障只限制尚未获得 PDF
目标的风险升级。任何单篇都不能因为自己较早 miss，就在同 cohort 的低风险层尚未结束时
提前打开 Browser。Resolution、Plan、route hint、Browser queue 和 scheduler 状态都只属于
当前操作。

当前 Entry 实现按 `DatabaseCompletionOperation.max_concurrency` 将冻结目标的确定顺序切成
固定大小 chunk；最后一个 chunk 可以更小。一个 chunk 是一次进程内 cohort 协调范围，不是
持久 BatchRun，也不会跨进程恢复。每个 target worker 先绑定稳定 participant identity：缺
PDF 的 participant 提交当代 `AcquisitionRequest`，已有 PDF、已经满足目标、失败、取消或完成
的 participant 退出本代等待集合，因此已有 PDF 的 Literature 可以直接继续 Parsing/Analysis，
不会被同 chunk 的 Acquisition 等待阻塞。其余请求全部到齐后才调用一次
`prepare_primary_pdf_cohort()`；receipt 按冻结 target 顺序交付，而不是按 worker 唤醒顺序
交付。

MetaLiterature 的首选版本正常耗尽后，下一版本在同一 target 的下一代重新加入 cohort；
`NoUsableContent` 完成原子清理后，同一 Literature 也在本次操作的下一代重新加入，并继续
携带 operation-local tried candidate keys。每一代的 prepare 可以有界并行，但所有
publication/exhaustion commit 仍经过一个 operation-scoped 串行 commit executor。预取消的
chunk 会让全部 participant 形成 `not_started` 而不调用 Acquisition；已经形成的 receipt
必须 commit 或 discard，清理失败不能被中断结果掩盖。重复操作重新读取数据库当前事实，
不依赖上一轮 chunk、generation、request、receipt 或 route hint。

生产 Browser 当前仍默认关闭且没有用户确认入口；Entry 只记录 Acquisition 返回的脱敏
Browser escalation summary，不把该 summary 误作已获得用户确认。真实 Browser 执行启用前
还必须完成 session/scheduler 与“side effect 前展示并确认”的产品边界。

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
       ├─ NoUsableContent：协调 Acquisition/Storage 清理 PDF 与中间结果，继续本版本其它 PDF 候选
       ├─ FinalMetadataProposal：进入第二阶段
       └─ 无法判断或处理失败：保留 PDF，进入本次 Report
  -> Analysis 第二阶段使用 ParserResult 和已确定 metadata 形成正文与参考文献草稿
  -> 形成完整提案，交给 Literature 验收最终 metadata、sections 和 references
  -> 程序确定性渲染规范 Markdown
  -> 整体提交最终 metadata、当前 LiteratureContent、artifact 关系和 Analysis provenance
  -> 可独立、按需尝试参考文献 lookup
```

Entry 不自行判断 route、候选、Parser 中间结果、最终 metadata、内容 Markdown 草稿、LiteratureContent 或引用目标是否有效，只按模块公开结果决定下一次调用。Acquisition 对候选的实际 PDF 字节、reader 和页面树检查失败会自行删除临时文件并继续候选。Entry 只在 Acquisition 已正常结束全部适用 routes、不存在 deferred/action-required/未解决 route failure，并已安全提交 `AutomaticPdfAcquisitionExhaustion(literature_id)` 后接收无字段 `NoPrimaryPdf`；候选级原因不读取或保存。用户中断、timeout、临时服务错误、`429`/`Retry-After`/quota、Browser 登录/MFA/challenge、Network/API/权限/配置错误、文件发布、数据库提交或 stale 复检错误进入稳定失败或待处理结果，不能降级为缺失或建立耗尽事实，也不能通过自动切换 Browser 绕开。

两阶段内容分析是 Analysis 的一个公开业务操作，阶段顺序由 Analysis 保证，Entry 不直接调用通用 prompt。只有结构有效的 `NoUsableContent` 允许清理；ParserResult 乱码、截断、只剩资源引用、无法判断、拒答、未知结构或调用失败都进入失败分支并保留 PDF。`ParserResult` 和第一阶段元数据提案本身都不推进状态；每个输入 Asset 只有一个当前 ParserResult，每个 Literature 只有一个当前 LiteratureContent。成功重处理在新结果完整接纳后原子替换当前关系但不建立历史，失败保留旧结果。替换 content 时同一提交清理旧 `ContentReferenceTextSupport`，并删除因此失去全部 support 的 Reference。Literature 整体接纳最终 metadata/content 后才达到 `CONTENT_READY`，这已经是内容处理完成状态。Reference lookup 和连接不参与三级状态推导。每个可持久化阶段成功后立即形成独立事实，后续失败不撤销权威元数据或 PDF。

一次运行对每个 Literature 维护内存中的 candidate tried set。明确 `NoUsableContent` 时，当前 PDF、来源关系、ParserResult 和待验收结果直接删除，候选和无效决定不长期保存；该 Literature 在需要其它 PDF 时重新进入后续有界 acquisition cohort，tried set 只防止本次运行立即再次选择同一候选。新运行不恢复这个集合，允许根据当前元数据重新发现来源。已经达到 `CONTENT_READY` 的主 PDF 不自动被其它候选替换，补充资产也不进入本流程。

当前 Literature 的 Acquisition 最终返回 `NoPrimaryPdf` 并建立耗尽事实，或明确 `NoUsableContent` 后本版本候选全部耗尽时，MetaLiterature 目标才进入内存候选列表的下一 Literature。Network/Storage 系统错误、Parser/LLM 失败、取消或无法判断直接进入本次 Report 并停止该 Meta 目标，不能切换版本。

手动 PDF 使用独立编排：Entry 先解析明确的 `LiteratureId` 和用户输入文件，确认该 Literature 当前没有主 PDF，再调用 Acquisition 的 manual admission。成功整体提交 Asset、user provenance、唯一 `primary-pdf` 关系并清除已有自动获取耗尽事实，Literature 达到 `ASSET_READY`；不在该入口内自动继续 Parsing/Analysis。无效文件作为输入验证错误返回，用户绝对路径和原文件不进入持久化或清理范围。

## 5. 处理范围与目标

`execution.py` 接受 `BatchRequest(selector, goal)`，其中 selector 使用判别联合表达逻辑范围，不使用通用 `ids + details JSON`：

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

Selector 不保存，也不携带 goal、Provider、并发、Parser、LLM、`force`、重试或 cursor。Entry 在写入准入保护下读取一个一致 snapshot，展开 selector、排除已经满足目标或当前不能自动推进的对象，并把实际目标 tuple 与版本候选冻结在当前进程内存。运行开始后不重新展开 selector，数据库新增对象或查询结果变化不进入本次操作。支持的内容目标为：

- `ASSET_READY`：补充当前主 PDF；
- `CONTENT_READY`：默认端到端目标；补充 PDF，经 Parsing、Analysis 和 Literature 接纳形成最终 metadata、轻结构化文档与规范 Markdown。

普通 selector 先按 MetaLiterature 去重。只要任一成员已经达到目标，该 MetaLiterature 就不生成实际目标；否则在内存冻结全部当前成员的候选顺序。排序键先比较完成度：`CONTENT_READY`、已有当前 ParserResult、已有当前主 PDF、没有派生结果；完成度相同时再比较 `published`、`accepted-manuscript`、`preprint`、`other`，最后使用稳定 Literature ID 作为确定性 tie-breaker。运行期间代表版本或成员状态变化不会悄悄改写内存队列；每次真正开始候选前仍重新读取 current facts，已经被其它提交满足时跳过。

需要 PDF 且已有 `AutomaticPdfAcquisitionExhaustion` 的具体 Literature 不进入 `AllPendingSelector` 自动目标。一个 MetaLiterature 只要还有未耗尽的可用候选，就可以按上述顺序处理；全部候选都已耗尽时，整个 MetaLiterature 从全库自动范围排除并通过 `needs_manual_pdf` 查询呈现。用户以 `LiteratureSelector` 明确选择这个具体 Literature 并发起需要 PDF 的目标时，视为明确重试，Entry 在开始自动获取前清除该事实；`DiscoveryRunSelector`、`ImportReportSelector`、`QuerySelector` 或 `MetaLiteratureSelector` 等宽范围 selector 不自动清除。

`LiteratureSelector` 不做 Meta 去重或版本回退。全库“补齐缺失 PDF/内容”的默认语义是为每个尚无可用版本的 MetaLiterature 取得一个优先版本；补齐全部明确版本需要用户逐个选择具体 Literature，不由普通 selector 隐式扩张。

## 6. 运行报告

每次有效的处理型 Entry 请求都在当前进程内形成 [Model 2.4](model.md#24-非持久化-entry-report) 定义的 typed Report，并直接返回程序内调用方。纯查询的 typed read result 已经是完整结果，不再包装 Report；Acquisition、Parsing 和 Analysis 作为数据库补全阶段时返回各自公开结果，由 Entry 汇总到一个 `DatabaseCompletionReport`，不制造嵌套报告。

Entry 使用五种互斥 Report：

- `DiscoveryReport` 汇总持久化 DiscoveryRun 对应的当次 Provider 终止、过滤前扫描、已接纳 observation 和新增对象数量；
- `DatabaseCompletionReport` 对冻结目标做 `goal_reached`、`needs_manual_pdf`、`failed`、`interrupted`、`not_started` 五类不重不漏分区，并单独列出本次曾明确清理无实际内容 PDF 的具体 Literature；
- `ManualPdfReport` 说明一个明确 Literature 的本地 PDF 已接纳或被正常拒绝；
- `ImportReport` 保留逐记录接纳/拒绝结果和可直接形成 `ImportReportSelector` 的 MetaLiterature ID；
- `ExportReport` 说明原子发布的具体 Literature、跳过项、字段损失和未发布对象。

它们只共享 `ReportEnd`：`finished` 表示到达正常边界但允许局部失败，`interrupted` 表示用户受控停止，`failed` 携带使整个操作提前结束的稳定脱敏 failure。Report 不设置 ID、时间、持续时间、通用 status、自由 details 或日志数组，也不复用 DiscoveryRunStatus 和已撤销的 Batch status/counts。

数据库补全从冻结目标开始就为每个目标保留一个且仅一个最终分区。停止信号到达时，正在处理的目标进入 `interrupted`，未开始目标进入 `not_started`；目标已经提交 PDF 但随后 Parsing 失败时只进入 `failed`，PDF 仍由数据库事实表达。Report 中的成功、耗尽和失败只能来自模块 typed result 或稳定异常，不能通过解析日志文本推断。

Entry 可以在当前操作内维护脱敏的 acquisition 进度摘要，向实时 UX 说明当前 tier、允许升级的目标数、Browser risk group、限速等待、deferred 和 action-required；它不增加持久化 BatchRun 或候选历史。最终 `DatabaseCompletionReport` 的五个分区保持不变：Browser 登录/MFA/challenge、quota 延期或其它 action-required 以对应目标的稳定 `code/reason/action/retryable` 进入 `failed`，不新增 Literature 状态或长期 failure 表。摘要和失败都不得包含 Cookie、profile 内容、完整 URL、selector、页面动作、短期 locator 或供应商原始响应。

Report 不写入 Catalog 或 ArtifactStore，不产生 BatchRun、BatchTarget、目标结果表或 counts 表，不参与 Literature 状态、自动获取耗尽、版本回退或下一次 selector 展开。CLI presenter 可以显示摘要或输出完整 JSON，但摘要数字必须直接取各结果 tuple 的长度，不能维护第二套可漂移计数。

### 6.1 实时 Logging 与 Report 的关系

Logging 是 Report 之外的 best-effort 实时反馈。Entry 选择用户可理解的操作开始、阶段推进、目标完成、局部失败和受控停止信息；各运行模块通过 `sciretriever.logging.api.get_logger(__name__)` 输出安全诊断。业务模块始终先返回 typed result 或稳定 failure，Entry 独立累计 Report；日志被过滤、丢失或输出失败不能改变 Report、数据库提交、退出结果或下一次选择，Report 也不能通过回放 LogRecord 构造。

CLI 标准流严格分工：

- stdout 只承载命令的稳定主要结果，包括文本 presenter、完整 JSON Report 或明确的导出数据；
- stderr 只承载实时日志、进度和脱敏诊断；
- 日志 Handler 不得写 stdout，因此 JSON、BibTeX、RIS、CSL JSON 或其它可管道输出不会被进度消息污染。

Report 是稳定 Model；日志消息、level、格式、时间和可选上下文不是公共数据合同。日志不得复制完整 Report、文献正文、prompt、供应商响应或文件内容。程序内 API 只返回 Report，不调用 Logging 的生产配置、不修改宿主程序的 root logger，也不要求调用方使用 CLI presenter。

## 7. 并发、中断与恢复

写执行在形成实际目标前通过 Entry 的 Write Admission Port 非阻塞获得核心写锁。锁由 Storage 实现；冲突立即返回稳定结果。

Selector 展开、Meta 去重、目标排除和候选排序在锁内的一致 snapshot 中完成，结果只成为内存中的不可变 target tuple，不写入数据库。之后释放读取事务但保持本次核心写准入；运行只消费该 tuple，不动态重查范围吸收新目标。

`orchestration.py` 可以并行等待不同 `Literature` 的网络、浏览器、Parser 或 LLM，但必须：

- 遵守模块和 Network 的资源预算；
- 让所有外部访问经过 ADR 0012 的进程内共享 Access Coordinator，不把批量并发直接等同于供应商请求并发；
- 把缺 PDF 目标分成有界 cohort，并在 cohort 内执行完整 Public pass、未解决目标的 API pass 和最小剩余集合的 Browser admission，不允许单篇提前跨越层级屏障；
- 让 API 请求按官方 quota scope、并发、间隔、window 和 `Retry-After` 门控；让不同 Browser risk group 并行、同一 group `concurrency=1` 且按 Provider policy 限速串行；
- 允许已经提交主 PDF 的目标继续后续阶段，但不因此撤销其它未解决目标的层级屏障；
- 通过单一提交队列串行 SQLite commit；
- 停止信号到达后不再启动新目标；
- 保留全部已提交阶段事实；
- 在能够执行收尾逻辑时把已完成、失败和尚未开始情况汇总进本次 Report。

正常结束、普通异常和用户受控中断都应尽可能返回截至当时的 Report。`kill -9`、断电等硬崩溃不保证生成最终 Report；下一次写操作重新获得锁、处理可能遗留的 `RUNNING` DiscoveryRun，并从当前权威事实重新形成补全目标。数据库中没有需要结束或恢复的 BatchRun。新操作不恢复旧线程、队列、HTTP 请求、浏览器页面、Provider cursor、Parser、LLM 调用、内存候选或 Report。

## 8. 查询与书目交换

查询调用 Literature 公开 API，使用 Storage 提供的一致 read-only snapshot。Entry 只负责把 CLI/JSON 等外部输入解析为 [Model 2.5](model.md#25-本地文献数据库查询与详情) 的中性合同，并呈现结果；它不回放身份或状态规则。

本地搜索接收 `LibrarySearchRequest` 并直接返回 `LibrarySearchPage`；用户从列表选择一个具体 `literature_id` 后，单篇详情读取直接返回临时组装的 `LiteratureDetail`。引用浏览接收 `LiteratureReferenceRequest` 返回 `LiteratureReferencePage`，打开一个具体 `reference_id` 返回 `ReferenceDetail`。这些读取都不创建 DiscoveryRun、不访问外部 Provider、不修改数据库、不形成 Report，也不保存查询、cursor、页面或详情结果。具体 Literature 或 Reference 不存在时返回稳定 not-found 读取错误，不能伪造空 Detail。

`QuerySelector` 只复用 `LibraryQuery` 条件，在数据库补全开始时从当时的一致 snapshot 展开完整范围；它不接收或复用 `LibrarySearchRequest.sort/limit/cursor`，也不把用户先前看到的一页结果当成冻结目标。`LiteratureReferencePage` 同样不能成为数据库补全 selector；它只是同一权威 Reference 的正向或反向读取。

列表和详情中的 artifact 只有稳定引用。`open_artifact` 把 `Asset | ParserArtifactRef | ArtifactRef` 交给 Literature 的 verified artifact reader 并返回 context-managed 只读 binary stream；`export_artifact` 使用同一 reader 原子写入用户目标。两者都不把 I/O 放进 `LiteratureDetail`，也不暴露内部绝对路径、修改数据库或形成 Report。目标文件默认不覆盖，调用方明确要求覆盖时仍必须使用同目录 staging 和原子替换。

`codecs/` 固定支持：

- BibTeX/BibLaTeX；
- RIS；
- CSL JSON。

Codec 只在外部文件与 `model/record.py` 边界记录之间转换。边界记录直接组合现有 `LiteratureMetadata` 和输入序号，不复制 BibTeX/RIS/CSL 字段建立第二套导入元数据 schema。导入接纳、身份处理、来源优先级、导出资格和字段取舍属于 Literature。

导入 codec 先形成带零基 `record_index` 的有序记录或逐记录格式失败，使 `ImportReport.input_record_count` 在接纳开始前确定。对每条结构有效记录，Entry 只补充固定的 user/bibliographic-import Provenance 并交给 Literature：未命中为 `created`，命中后以非空用户值补缺或替换当前 Provider 值为 `enriched`，命中且当前统一投影不变为 `matched`，格式、最低识别条件或稳定标识符冲突为 `rejected`。首次与 Provider 当前值相同的 matched 仍保存 user observation；只有完全相同的规范化 user observation 已存在时才复用而不重复插入。`CONTENT_READY` 对象的 enriched 只表示新 observation 已接纳并可供下一次完整 Analysis 使用，不表示 Entry 拆开覆盖当前 metadata/content。前三种接纳结果的 MetaLiterature ID 按首次出现顺序去重形成 `accepted_meta_literature_ids`。单条错误不撤销其它记录；中断时已经完成的逐条结果保留，尚未接纳的 index 进入 `not_processed_record_indexes`。调用方后续可以把非空 `accepted_meta_literature_ids` 明确提交为 `ImportReportSelector`，Entry 仍重新读取 current facts。

导出使用一致 snapshot，把最终选中的具体 Literature ID 冻结在当前进程，写入目标目录下 owner-only staging file，flush、`fsync` 后原子替换目标文件；用户不能观察到部分输出。只有成功发布的对象进入 `published_literature_ids`，无法编码的单条记录进入 `skipped`，目标格式不能表达的字段进入带 LiteratureId 的 `omissions`。中断或操作级失败时不发布 staging file，已经编码但未发布的对象仍归入 `not_published_literature_ids`，旧目标文件保持不变。导出不要求 Literature 已完成全文处理，Report 不保存输出绝对路径或文件字节。

## 9. Ports

Entry 拥有：

- DiscoveryRun repository 与逐来源/发现结果 publication；
- 类型化 selector/current-facts 读取；目标冻结、版本候选和 Report 只在 Entry 内存中形成，不声明 repository；
- Write admission；
- Clock；
- Literature metadata codec；
- 面向用户目标文件的原子输出；Artifact verified reader 通过 `literature.api` 取得，不在 Entry 重复声明；
- 需要跨事实所有者整体提交的复合持久化 Port。

复合 Port 只接收各模块已经确认的 Model 决定。Entry 可以选择提交顺序和事务边界，但不在持久化适配器中隐藏业务判断。

## 10. 错误边界

- 单个 provider 失败只影响该来源；
- 单个 `Literature` 的获取、Parser 中间解析或 LLM 内容判断与总结失败只影响该目标；
- 数据库不可用、无法获得写入准入、全部目标共同依赖不可用或无法安全保存结果属于本次操作级问题；
- 所有用户结果使用 `StableFailure` 的稳定 code/reason/action/retryable；
- 外部 adapter 在异常离开协议边界前完成稳定化和脱敏；Entry 把安全 failure 与稳定 ID 写入 Report，并可以选择把同一安全信息用于实时日志，不能把原始 SDK/HTTP/浏览器/Parser/LLM 异常对象交给 logger；
- 底层异常链可以保留在内存诊断边界，但保留因果链不等于把原始异常正文、response、URL、prompt、正文或凭据输出到 stderr；
- 意外的内部编程错误保留 traceback 并按顶层错误边界传播；已知外部失败不使用可能重新暴露原始 cause 的无条件 `logger.exception`；
- 明确无内容是业务决定，不归类为 LLM 调用失败。

## 11. 验收

离线入口测试至少覆盖：

- 领域 DiscoveryRun 只保存 ID、类型化 input、五态 status 和开始时间；全部本次 Provider 及各自 run-wide scan limit、逐来源三值终止结果、已接纳 MetaLiterature 和 topic cause 可查询，结束后不自动开始 PDF/Parsing/Analysis；
- 每个 Provider 在过滤和去重前按原始 item 运行到结果耗尽或 scan limit；一个来源失败保留其它来源结果和自己已接纳页面，source result 不保存过程计数，也不会为每条结果执行逐篇全 Provider 补查；
- 元数据阶段只应用标题或 DOI 的最低入库条件，不用 LLM、搜索分数、关键词、摘要分类或低收益启发式过滤或提前停止；偏题但有实际内容的文献不成为 `NoUsableContent`；
- 所有 Provider 正常到达边界、部分失败、全部失败和用户中断分别形成正确 Run 终态；零结果正常完成，用户中断保留已确认结果且不保存 cursor 续跑；
- 本地只读查询不创建 DiscoveryRun；相同发现条件再次执行形成新的运行，并基于当前数据库重新身份接纳；
- 本地搜索只接收 LibrarySearchRequest 并返回具体 Literature 的 SearchPage，单篇读取返回同一 snapshot 临时组装的 LiteratureDetail；二者不访问 Provider、不修改数据库、不形成 Report 或持久化查询结果；
- 引用页面只接收 LiteratureReferenceRequest，并从同一 Reference 正向或反向返回相关 Literature 与 support count；ReferenceDetail 返回两端和全部当前 support，二者不创建第二套 cited-by 边、Provider count 或持久化读取投影；
- QuerySelector 只复用 LibraryQuery，不接受列表 sort/limit/cursor，也不把先前页面动态当作补全目标；artifact 字节和无界关系边通过独立读取获得；
- Entry 文献业务 API 只覆盖领域/引用发现、数据库补全、手动 PDF、本地 Search/Detail/Reference 读取、Artifact 打开/导出和书目导入/导出；CLI 只使用 `discover`、`complete`、`literature`、`import`、`export`、`config` 六个一级名称及第 2.2 节的固定二级路径；
- `literature` 命令组保持只读；用户元数据文件与手动 PDF 分别走 `import metadata`、`import pdf`，PDF/轻结构化 Markdown 分别走 `export pdf`、`export content`，不存在 `exchange`、`bibliography`、`artifact` 或内部模块一级命令；
- 裸 `config` 中心隐藏输入，Provider 区安全更新/删除选中 section，LLM/MinerU 区通过可恢复顺序同步普通配置与 origin-bound secret；`status` 纯本地且不显示 secret 值或特征，`test` 只通过 fake Network 离线验证 Provider/LLM/MinerU probe 编排；旧 `config set/remove` 被拒绝；这些动作不创建 DiscoveryRun、处理 Report 或文献数据库事实；
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
- 多家 Metadata 供应商可以逻辑并发，但同一 provider/API quota 在当前进程跨调用方共享并精确执行官方政策；不同 Browser risk group 可以实际并行，同一 group 始终只有一个活动文章流程并遵守自己的 interval/window/cooldown；
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
- Analysis 明确返回 `NoUsableContent` 时清理并继续候选；Parser/LLM 失败或无法判断时保留 PDF；同次运行 tried set 防止立即重试，新运行允许重新发现且不保留无效候选详情；
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
