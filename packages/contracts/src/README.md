# 共享合同源码

定义跨模块传递的身份、文档、知识、提取、操作与检索结构及其边界解析。

## 内容入口

- [index.ts](index.ts)：包公开导出与基础合同。
- [acquisition.ts](acquisition.ts)：当前/待生效来源与有界安全获取轨迹，供配置、任务和浏览器读取。
- [document.ts](document.ts)：文档合同。
- [raw-parsing.ts](raw-parsing.ts)：双 profile 原始解析与中性区块合同，校验坐标、页码、资源引用和不可变清单身份。
- [archive-text.ts](archive-text.ts)：source/叶块、整理操作与快照、逐页改字与处置、停止原因及实际用量的严格合同；新服务使用，发布与传输接入另行实施。
- [processors.ts](processors.ts)：知识产物合同。
- [snapshots.ts](snapshots.ts)：综合产物合同。
- [operations.ts](operations.ts)：操作合同。
- [extraction.ts](extraction.ts)：提取合同。
- [retrieval-context.ts](retrieval-context.ts)：材料检索上下文合同。

## 放置边界

`archive-text.ts` 定义中性 source/叶块、整理操作、断段、页校订与停止合同；`archive-publication.ts` 定义 V2 文本清单、校订版本、整理查询/人工 CAS、预计消耗与进度。`archive.ts` 的新请求采用 schema 2 六步；历史步骤仅作读取。`structure-annotation.ts` 按 schema 分派历史注释与整理派生注释，新角色不自动映射旧角色。

修改字段需要同步生产者、消费者、序列化和持久化兼容；不要把厂商原始响应或机器绝对路径放进中性合同。

`processor-transfer.ts` 定义固定结果/导出的有界 UTF-8 传输请求和回执，区分结果 hash 与传输封套 hash，不引入网络或文件访问。

- [proofread.ts](proofread.ts)：校订区块与版本、来源、失败和方法的中性合同；耗时不进入内容或版本身份。
- [metadata-types.ts](metadata-types.ts)：出版形式与文章性质的封闭枚举及统一中文名称；主元数据与 LibraryQuery 均使用新字段；旧字段不兼容。

- [document-structure-v2.ts](document-structure-v2.ts)：校订稿片段、页码区域、来源与 UTF-8 区间的结构校验；章节角色固定留空，由后续独立结构注释提供。

- 文档输入按 schema 判别旧固定版本与直接引用校订版本的新表示；`document-structure-v2.ts` 定义区块结构，`page-region-v1` 采用公开 1 起计页码。

- `section-roles.ts`：正文/补充材料的封闭章节角色；结构注释消费此合同，不改写文档表示。

`section-roles.ts` 与 `structure-annotation.ts` 定义正文/补充材料的封闭角色、独立注释、图表和引用文本；注释绑定固定 DocumentVersion，独立计算 hash，不改变全文表示与证据 ID。

- `metadata-fields.ts`：逐字段来源/冲突/锁定及人工编辑的严格合同；空值可以人工锁定，非法字段、枚举与重复编辑均拒绝。

`canonical-bounded.ts` 提供带字节、深度、节点和数组预算的规范 JSON 编码；Extraction 与完整算子结果分别使用自己的边界，不能让新增核对字段触发另一接口的更小节点上限。

`library-counts.ts`、`folders.ts` 约定库计数、目录与阅读历史；`snapshots.ts` 将显示名称与不可变快照定义分开；`actor.ts`、`agent-conversation.ts`、`reading-status.ts` 约定操作者和阅读过程的读取投影；`processor-reading.ts` 约定全文／检索范围，`processor-value-checks.ts` 与 `processor-outcomes.ts` 约定六种核对状态和按文献去重的三种结果计数。
