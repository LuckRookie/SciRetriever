# 共享合同源码

定义跨模块传递的身份、文档、知识、提取、操作与检索结构及其边界解析。

## 内容入口

- [index.ts](index.ts)：包公开导出与基础合同。
- 页面、保存筛选与有序范围共用 `LibrarySort`。`parseLibrarySearchRequest(value)` 接受 `collected-desc`，页面返回的可空 `collected_at` 表示首次选用时间。`intake_at` 表示最早书目观测。`library-sort-scope-limit` 表示当前命中范围需要缩小或使用支持的排序。
- [device-connections.ts](device-connections.ts)：设备连接、配对请求与精确键解析；可省略的显示类型在创建请求中规范为 null，读取结果始终带 nullable `kind`，用途集合独立校验。
- [folders.ts](folders.ts) / [filters.ts](filters.ts)：分组与保存筛选的操作、版本 1 导出格式和精确键解析；分组的机器结果按成员分页，下载文件按文件夹嵌套成员。
- [literature-summary.ts](literature-summary.ts)：文献公开批量读取的最小书目投影，只含稳定 ID、已有标识、题名与年份。
- [library-trash.ts](library-trash.ts)：文献“最近删除”的写请求与回执（`delete`/`restore`，1–1,000 个不重复 ID），以及 `list`（每页 1–100 项，逐项为书目、删除时间与操作人）和 `count` 两个读取的精确键解析。
- [import-sessions.ts](import-sessions.ts)：供现有纯适配器使用的内部类型别名；实际模型与 parser 归 intake.ts，不提供旧 wire 字段。
- [capture.ts](capture.ts)：单篇网页入库的原始页面输入、预览、请求 UUID 与文件声明、补全/接纳结果；PDF 页面在认篇之前返回 literature_id 为 null 的独立待交文件形状，有标题的网页立即保存；空条目由页面适配后的应用边界拒绝。web-capture 的用户 provenance 仍由 index 中的封闭 observation 合同校验。
- [intake-page.ts](intake-page.ts)：原始 WebPageData 的精确键、URL、meta/JSON-LD 数量与 UTF-8 字节上限；保留原始标签值，不在合同层解读页面；拥有上传文件名、相对路径校验与来源地址脱敏。`index.ts` 导出的 URL 解析复用已有来源地址校验。
- [intake-withdrawal.ts](intake-withdrawal.ts)：撤回/恢复预估与撤回/恢复报告的精确键、八种保留原因、对象计数及最多 200 条有序保留项目；registered 标记旧批次的保守范围。
- [bibliography-formats.ts](bibliography-formats.ts)：入库接受的书目格式名（含 `endnote-tagged`、`endnote-xml`、`noteexpress`），以及网页与服务端共用的认格式（扩展名优先，`.txt`、`.xml` 与认不出的扩展名看第一行）和读字节（UTF-8 去 BOM，不是合法 UTF-8 时按 GB18030；`bibliographyEncodingAccepted` 只对 CSL JSON 拒绝 GB18030）。
- [intake.ts](intake.ts)：统一批次、条目、来源、分段、纯适配器、报告、文件状态、状态/结果、进度、端点与错误码；source 可为 null，由服务形成一次性来源。也拥有范围词频与 PDF 获取范围/预览合同，以及预览与报告的 `records.clues_unread`（六种读不出原因，逐项列出，合计校验）。`lookup` 格式另有 `INTAKE_LIMITS.lookup_lines`、错误码 `intake-lookup-too-many`、条目的 `lookup`（`IntakeLookupItem`）、报告条目的 `line`、摘要的 `lookup`（`IntakeLookupSummary`）与本机同步入口的 `IntakeLookupResult`，都是只加的可选字段。Zotero 适配器另用 `IntakeFile.md5` 与 `IntakeItem.file_only` 两个可选字段；`IntakeAdapterResult.optional_group_references` 表示条目可以引用没交来的分组（那一处归属略去）。收到时被拒绝的文件条目带可选的 `IntakeBatchItem.reason`。
- [literature-recognition.ts](literature-recognition.ts)：入库后重新识别的请求（1–1,000 个不重复 ID 或全部书目待补）、加工目标 `recognize-literature` 的请求、逐篇结果、跳过原因与任务计数的汇总函数。
- [acquisition.ts](acquisition.ts)：当前/待生效来源与有界安全获取轨迹，供配置、任务和浏览器读取。
- [document.ts](document.ts)：文档合同。
- [document-read.ts](document-read.ts)：固定文档与证据的有界读取；可选文本等级、初稿计数与角色覆盖说明按精确键解析，片段核对依据按等级分开校验。初稿差异使用独立审计请求/结果合同，规范 JSON 分片收齐后解析；不改变普通读取请求与游标的形状。
- [sentence-split.ts](sentence-split.ts)：分句规则 `sentence-split-v1`（规格 3.5），服务端与网页共用的唯一实现：`splitSentences(text, {whole})` 返回 JavaScript 下标的句子范围，`splitSentencesUtf8` 与 `utf8Offset` 换成 UTF-8 字节，`sentenceNumbers` 给出一个范围碰到的句号（从 1 起）。
- [key-terms.ts](key-terms.ts)：重点词匹配 `key-term-match-v1`（规格 10.7）：`matchKeyTerm(text, term)` 与 `markKeyTerms(text, terms)`（排好序、不重叠，先列的词优先），范围是 JavaScript 下标；拉丁等有词界的文字不分大小写、从词首匹配、词尾可多 `s` 或 `es`、不在词中间；中日韩文字逐字匹配。
- [reading-layers.ts](reading-layers.ts)：阅读层文件 `DocumentLayersFile`（`LAYERS_FILE_SCHEMA_VERSION` 3，ADR 0073 的按段写）与 `describe.layers` 摘要的严格解析、三个提示词版本、类别 `LAYERS_POINT_KINDS`（七种）与关系 `LAYERS_RELATION_WORDS`（六种）、长度规则 `layersTextFits`（`layersStatementFits` 40 字或 20 词、`layersReasonFits` 60 字或 30 词、`layersLabelFits` 8 字或 3 词）与 `layersLabelInStatement`，以及各项上限（每段至多一条批语、一份至多 2,000 条、主干 3–5 条、依据 1–2 句（7 句以上的段 3 句）、`see` 至多 3 件、关系每条批语至多 3 条、`summary` 400、局限至多 5 条各 200、精读建议 300、数据至多 8 行、重点词 40 码点且每项至多 2 个、一份至多 40 段或 12,000 码点、正文少于 3,000 码点不做）。
- [reading-layers-read.ts](reading-layers-read.ts)：文档读取 `layers` 的请求与三种结果（`overview`、`outline`、`markdown`）的精确键解析（批语带 `unit_id`、`paragraph`、`reason`，节旨 `LayersReadSection`），以及 Markdown 文首的机器说明。
- [draft-document.ts](draft-document.ts)：两级文本、schema 3 初稿引用、初稿内容、差异与形成回执的严格合同；初稿用显式解析入口，原 `parseDocumentRef` 仍只接受 schema 2。片段核对依据按显式版本校验。
- [form-drafts.ts](form-drafts.ts)：显式补形成初稿的预览、任务请求、互斥范围计数与逐部分回执合同；请求解析在 `operations.ts`，保存的范围由 `intake.ts` 共用解析。
- [draft-facts.ts](draft-facts.ts)：初稿默认文本的五项计数、PDF 部分的默认版本投影与四个排序键；列表、详情与建档状态共用同一合同。`index.ts` 中的五个新筛选只在有效显式取值时进入规范化查询，省略时保留旧请求与 selector 的编码。
- [raw-parsing.ts](raw-parsing.ts)：双 profile 原始解析与中性区块合同，校验坐标、页码、资源引用和不可变清单身份。
- [archive-text.ts](archive-text.ts)：source/叶块、整理操作与快照、逐页改字与处置、停止原因及实际用量的严格合同；新服务使用，发布与传输接入另行实施。
- [processors.ts](processors.ts)：知识产物合同。
- [snapshots.ts](snapshots.ts)：综合产物合同。
- [operations.ts](operations.ts)：操作合同。
- [extraction.ts](extraction.ts)：提取合同。
- [retrieval-context.ts](retrieval-context.ts)：材料检索上下文合同。
- [index-refresh.ts](index-refresh.ts)：发布后全文索引的非秘密队列状态与严格解码；源 revision 和请求序号独立，失败只携带技术原因码。

## 放置边界

`archive-text.ts` 定义中性 source/叶块、整理操作、断段、页校订与停止合同；`archive-publication.ts` 定义 V2 文本清单、校订版本、整理查询/人工 CAS、预计消耗与进度。`archive.ts` 的新请求采用 schema 2，步骤为 `ARCHIVE_STEPS`（含 `translate` 与 `layers`）；历史步骤仅作读取。`structure-annotation.ts` 按 schema 分派历史注释与整理派生注释，新角色不自动映射旧角色。

修改字段需要同步生产者、消费者、序列化和持久化兼容；不要把厂商原始响应或机器绝对路径放进中性合同。

`processor-transfer.ts` 定义固定结果/导出的有界 UTF-8 传输请求和回执，区分结果 hash 与传输封套 hash，不引入网络或文件访问。

- [proofread.ts](proofread.ts)：校订区块与版本、来源、失败和方法的中性合同；耗时不进入内容或版本身份。
- [metadata-types.ts](metadata-types.ts)：出版形式与文章性质的封闭枚举及统一中文名称；主元数据与 LibraryQuery 均使用新字段；旧字段不兼容。

- [document-structure-v2.ts](document-structure-v2.ts)：校订稿片段、页码区域、来源与 UTF-8 区间的结构校验；章节角色固定留空，由后续独立结构注释提供。v5 长文档由显式 parseLongDocumentStructure 接受混合核对依据，旧解析入口仍拒绝新增取值；页状态由文本存储使用配对版本验证。片段/切片/证据的版本化读取可返回这些取值，旧的无版本位置解析与加工逐值核对仍保留三取值边界。

- 文档输入按 schema 判别旧固定版本与直接引用校订版本的新表示；`document-structure-v2.ts` 定义区块结构，`page-region-v1` 采用公开 1 起计页码。

- `section-roles.ts`：正文/补充材料的封闭章节角色；结构注释消费此合同，不改写文档表示。

`section-roles.ts` 与 `structure-annotation.ts` 定义正文/补充材料的封闭角色、独立注释、图表和引用文本；注释绑定固定 DocumentVersion，独立计算 hash，不改变全文表示与证据 ID。

- `metadata-fields.ts`：逐字段来源/冲突/锁定及人工编辑的严格合同；空值可以人工锁定，非法字段、枚举与重复编辑均拒绝。

`canonical-bounded.ts` 提供带字节、深度、节点和数组预算的规范 JSON 编码；Extraction 与完整算子结果分别使用自己的边界，不能让新增核对字段触发另一接口的更小节点上限。

`library-counts.ts`、`folders.ts` 约定库计数、目录与阅读历史；`snapshots.ts` 将显示名称与不可变快照定义分开；`actor.ts`、`agent-conversation.ts`、`reading-status.ts` 约定操作者和阅读过程的读取投影；`processor-reading.ts` 约定全文／检索范围，`processor-value-checks.ts` 与 `processor-outcomes.ts` 约定六种核对状态和按文献去重的三种结果计数。

`source-configuration.ts` 定义来源目录、单源编辑、测试回执与配置应用状态的封闭中性合同；凭据字段只有存在性与替换/清除动作。

`source-results.ts` 定义元数据任务请求、安全来源进度、最终 PDF 渠道、任务来源汇总与来源统计；比例显式带分子分母，历史无记录可区分，所有问题沿用 source-configuration 的安全诊断。`parseTaskCitationSourceCooldowns` 解析任务详情的来源冷却状态和有界待补查样本，保留字段的省略语义。

`screencast.ts` 定义人类观看的认证握手、订阅、二进制 JPEG 封套、直接输入及控制/连接状态，包含严格边界解析；它与 Agent 的 WorkbenchObservation 分离。
\n`document-layout.ts` 定义普通 Markdown 的文章信息、图表分组（表的分组可带表注区间）和逐条页脚注 UTF-8 区间；新文档通过 describe 返回，outline 的无原标题项以 null 表示。\n
`device-connections.ts` 定义设备用途、无敏感值的连接投影与管理输入；连接码解析和一次性交付类型只用于认证边界，不进入普通文献事实或日志。

`intake.ts` 定义统一入库批次、文件与报告、显式路由清单，以及获取 PDF/解析任务的范围计数。`library-counts.ts` 提供共用的 FullTextCounts 和关系校验；批次及文献库的 full_text 按论文，批次 estimates 与文献库状态、with_primary_pdf 按版本。LibraryQuery 的 has_primary_pdf 按版本筛选；省略或 null 不增加规范化字段。

`LibraryQuery.needs_metadata` 与文献摘要/详情的同名可选字段用于书目待补；省略时不增加查询序列化字段。`post-parse-recognition` 与 `file-recognition` 是封闭的用户来源类型，要求来源记录引用和输入 hash，不接受任意自定义来源。
