# 共享合同源码

定义跨模块传递的身份、文档、知识、提取、操作与检索结构及其边界解析。

## 内容入口

- [index.ts](index.ts)：包公开导出与基础合同。
- [folders.ts](folders.ts) / [filters.ts](filters.ts)：分组与保存筛选的操作、版本 1 导出格式和精确键解析；分组的机器结果按成员分页，下载文件按文件夹嵌套成员。
- [literature-summary.ts](literature-summary.ts)：文献公开批量读取的最小书目投影，只含稳定 ID、已有标识、题名与年份。
- [import-sessions.ts](import-sessions.ts)：供现有纯适配器使用的内部类型别名；实际模型与 parser 归 intake.ts，不提供旧 wire 字段。
- [capture.ts](capture.ts)：单篇网页入库的原始页面输入、预览、请求 UUID 与文件声明、补全/接纳结果；PDF 页面在认篇之前返回 literature_id 为 null 的独立待交文件形状，有标题的网页立即保存；空条目由页面适配后的应用边界拒绝。web-capture 的用户 provenance 仍由 index 中的封闭 observation 合同校验。
- [intake-page.ts](intake-page.ts)：原始 WebPageData 的精确键、URL、meta/JSON-LD 数量与 UTF-8 字节上限；保留原始标签值，不在合同层解读页面；拥有上传文件名、相对路径校验与来源地址脱敏。`index.ts` 导出的 URL 解析复用已有来源地址校验。
- [intake.ts](intake.ts)：统一批次、条目、来源、分段、纯适配器、报告、文件状态、状态/结果、进度、端点与错误码；source 可为 null，由服务形成一次性来源。也拥有范围词频与 PDF 获取范围/预览合同。
- [acquisition.ts](acquisition.ts)：当前/待生效来源与有界安全获取轨迹，供配置、任务和浏览器读取。
- [document.ts](document.ts)：文档合同。
- [document-read.ts](document-read.ts)：固定文档与证据的有界读取；可选文本等级、初稿计数与角色覆盖说明按精确键解析，片段核对依据按等级分开校验。初稿差异使用独立审计请求/结果合同，规范 JSON 分片收齐后解析；不改变普通读取请求与游标的形状。
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

`archive-text.ts` 定义中性 source/叶块、整理操作、断段、页校订与停止合同；`archive-publication.ts` 定义 V2 文本清单、校订版本、整理查询/人工 CAS、预计消耗与进度。`archive.ts` 的新请求采用 schema 2 六步；历史步骤仅作读取。`structure-annotation.ts` 按 schema 分派历史注释与整理派生注释，新角色不自动映射旧角色。

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

`source-results.ts` 定义元数据任务请求、安全来源进度、最终 PDF 渠道、任务来源汇总与来源统计；比例显式带分子分母，历史无记录可区分，所有问题沿用 source-configuration 的安全诊断。

`screencast.ts` 定义人类观看的认证握手、订阅、二进制 JPEG 封套、直接输入及控制/连接状态，包含严格边界解析；它与 Agent 的 WorkbenchObservation 分离。
\n`document-layout.ts` 定义普通 Markdown 的文章信息、图表分组和逐条页脚注 UTF-8 区间；新文档通过 describe 返回，outline 的无原标题项以 null 表示。\n
`device-connections.ts` 定义设备用途、无敏感值的连接投影与管理输入；连接码解析和一次性交付类型只用于认证边界，不进入普通文献事实或日志。

`intake.ts` 定义统一入库批次、文件与报告、显式路由清单，以及获取 PDF/解析任务的范围计数。`library-counts.ts` 提供两者共用的 FullTextCounts 和关系校验；批次 full_text 按论文，estimates 按版本，LibraryCounts 的后续扩展不在此处提前启用。

`LibraryQuery.needs_metadata` 与文献摘要/详情的同名可选字段用于书目待补；省略时不增加查询序列化字段。`post-parse-recognition` 是封闭的用户来源类型，要求原始解析引用和输入 hash，不接受任意自定义来源。
