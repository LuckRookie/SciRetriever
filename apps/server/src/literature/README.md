# 文献事实与身份

拥有文献身份、元数据汇聚、主 PDF 及内容关系、书目查询和已确认材料的业务接纳规则。

## 内容入口

- [identity.ts](identity.ts)：文献身份接纳，与入库批次成员在同一事务接纳；导入预览复用只读身份判定，来源对应仍须通过稳定标识符冲突检查。
- [intake.ts](intake.ts)：主题、引用及书目导入批次的生命周期与真实入口归属；中断保留已接纳的成员。
- [metadata-rules.ts](metadata-rules.ts)：来源元数据的确定性处理。
- [primary-pdf.ts](primary-pdf.ts)：主 PDF 关系。
- [query.ts](query.ts)：文献库查询；初稿事实的筛选、排序和范围冻结仅看主 PDF 默认文本。新排序的 cursor 绑定规范化筛选、排序、可空数值及文献 ID；旧排序的请求、cursor 和保存范围的编码保持原样。
- [article-identity.ts](article-identity.ts)：下载后的文章身份判断事实。

## 放置边界

外部响应先经 provider 转换；storage 只持久化已确认事实，不自行决定文献合并或接纳。

[上级目录](../README.md)

- [metadata-types.ts](metadata-types.ts)：带版本的来源类型映射，由 `metadata-rules.ts` 导出；未知值保守返回空，原始字符串由 observation 保留。Provider observation 保留 `source_type` 和映射版本；统一元数据、查询与后备匹配使用 `publication_form` / `article_kind`。

- `metadata-fields.ts` / `metadata-service.ts`：逐字段裁决、来源、冲突及人工编辑/解锁；与 identity 共同使用单个元数据发布事务和 revision CAS，不建立第二套元数据。
- `metadata-proposals.ts` / `metadata-agent.ts` / `archive-metadata.ts`：建档内部的 DSH 元数据提议；只读固定校订稿的第一页及 front-matter/abstract/keywords，逐字段核对片段和 DOI。无模型时明确失败，不回退到旧两阶段总结。建档编排由相邻的 `archive/` 模块调用。

- [import-adapters.ts](import-adapters.ts)：中性记录、书目格式和网页原始标签的纯适配器登记；decode 只转换输入，不访问时钟、随机数、网络、文件或数据库。[bibliography-attachments.ts](bibliography-attachments.ts) 读取 BibTeX/BibLaTeX file 与 RIS L1，形成首选 PDF 的中性引用、脱敏本机路径并统计未导入附件；CSL JSON 不推断附件。
- [web-page-adapter.ts](web-page-adapter.ts)：按标签与 JSON-LD 优先序产生中性书目、PDF 地址和无效 JSON 计数；单篇收藏接收原始 `WebPageData`，PDF 页面由文件流程处理，不据页面地址猜书目。
- [file-clues.ts](file-clues.ts)：单个受控 PDF 的只读线索端口，由适配器入口导出；复用基本验收，再用受限 MuPDF 读取文档信息、XMP、首页/必要的第二页和醒目标题，全部操作受 10 秒总时限约束，不查库、不联网、不调用模型。文件条目上传与确认的组装不在此端口中。[import-clues.ts](import-clues.ts) 共用字符串及标识规范化。

书目适配器只收原始文本；bibliography-import 的 bibliographyText 共用 UTF-8/带 BOM UTF-16 的严格字节解码，供本地入口转换文本。只导书目的文件策略由 Entry 的批次选项处理，纯适配器仍返回同样的文件引用与排除计数。

- `bibliography-import.ts`：共享的 BibTeX/RIS/CSL 解码和元数据导入；从 Entry 移入同一 Literature 所有者，CLI、MCP 与引用关联复用一份实现。`reference-matching.ts` 优先 DOI 精确身份；只有可确定完整书目字段的结构化引用才使用现有严格后备键，普通非结构化文本不做模糊猜测。

- `reference-matching.ts` / `archive-references.ts`：固定校订稿参考文献的保守库内匹配与原子关系支持；不依靠模糊题名猜测。`bibliography-import.ts` 是书目解码与导入的共享实现，Entry 不再持有重复副本。

- [folders.ts](folders.ts)：文献文件夹、批量成员与显式阅读历史的操作边界；目录与阅读历史不改变文献事实、资产或就绪状态。只读导出提供成员分页和单一快照的文件流，书目通过 `query.ts` 的有界 `bibliographies` 公开读取取得。`query.ts` 的快速筛选计数与搜索共享筛选条件，入库排序取最早关联观测时间。
- [filters.ts](filters.ts)：保存筛选的读写合同边界；只保存规范条件与排序，导入逐项报告，全部写入经维护操作记录。只读导出一次返回全部筛选的名称、条件和排序。

`metadata-rules.ts` 将作者声明（declared_keywords）投影为作者关键词，逐字段裁决仍保留人工 > 校订证据 > 来源的优先级及锁。数据库主题词由 provider 顺序合并、忽略大小写去重并限于 8 项；不进入书目导出的作者关键词。`query.ts` 提供批次读取、整个筛选范围的词频，以及按当前排序冻结的 PDF 获取预览；分页搜索与批量范围使用同一 SQL 条件。

`query.ts` 的 parseSelection 复用获取 PDF 的范围选择器，读取有主 PDF 且没有当前部署 profile 原始解析的版本；它只读，不下载、解析或创建任务。批次读取返回按论文的 full_text 及按版本的 acquire_pdf/parse 预估；文献库 LibraryCounts 的扩展另行接入同一计数 owner。

[intake-recognition.ts](intake-recognition.ts) 依次核对标识、标题与作者/年份，只复用配置允许的元数据查询；按 Unicode 码点计算标题相似度，候选不自动接纳。预览不写文献事实。[post-parse-recognition.ts](post-parse-recognition.ts) 在原始解析发布后只处理书目待补文献，保留来源与人工锁；不执行解析或模型。文献查询的 needs_metadata 标记独立于建档状态。

[possible-duplicates.ts](possible-duplicates.ts) 提供可能重复的纯判断与只读服务：复用认篇的标题规范化和码点相似度，结合第一作者和年份给出最多三个有序候选；标识、来源库编号及严格身份命中优先。服务只调用身份预览与书目小投影，不写文献事实。入库预览只比较已在库文献，确认按顺序重判；同批已接纳的前序条目也参与比较。批次与网页收藏共用本判断，候选不自行触发合并或新增。

`marks.ts` 的 `place` 只写独立定位缓存，保留原始锚点与批注更新时间；PDF 页数经已核验资产的只读工具取得，事务内重新核对同篇、同部分与范围。读取和 JSON 导出只返回当前方法的 `places`。
