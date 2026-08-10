# ADR 0002：多来源文献身份与增量处理

- Status: Accepted
- Date: 2026-07-23
- Revised: 2026-08-10
- Supersedes: none
- Superseded by: none
- Amended by: [ADR 0008](0008-summarized-markdown-literature-content.md)、[ADR 0011](0011-literature-database-centered-incremental-maintenance.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[ADR 0001](0001-sciretriever-scope-and-boundary.md)

## 背景

一次领域收集会从多家供应商获得重复、不完整或相互冲突的元数据。同一文献还可能具有预印本、作者接受稿和正式发表版。资产和轻结构化文档必须对应到正确的具体文献，批量运行也必须能够保留部分成功并在以后继续补全。

这些问题需要稳定的内部身份和增量处理设计，但不意味着某个内部身份类型是产品中心。产品目标仍是大批量文献收集及其文献数据库结果。

## 决策

1. 系统内部使用 `MetaLiterature` 表示同一文献多个明确版本的稳定聚合身份，使用 `Literature` 表示可以独立拥有 `LiteratureMetadata`、资产和 `LiteratureContent` 轻结构化文档的具体文献。
2. `MetaLiterature` 和 `Literature` 是内部一致性机制，不是用户必须理解的产品中心，也不改变[产品需求](../requirements.md)定义的工作流。
3. 供应商返回记录和带来新来源事实的用户书目导入记录都作为独立、不可变的 `MetadataObservation` 长期保存，不建立第二套导入元数据对象。一个具体 `Literature` 可以关联多个 observation；新接纳的来源观察增加新对象和关联，不能原地覆盖既有 observation，重复导入相同规范化内容只形成 matched 而不增加 observation。系统另外维护一份面向查询、处理和展示的当前统一 `LiteratureMetadata`：用户导入 observation 的非空书目信息优先，按配置排序的供应商 observations 只补齐缺失字段，不能无声覆盖用户导入值或其它来源事实。导入只保留最小用户来源 provenance，不保留原始文件、外部工具对象、外部记录 ID 或导入批次历史。
4. 跨来源身份收敛采用保守、确定且可审计的规则。外部文献标识符使用各自官方规范，不创造 SciRetriever 私有值格式：DOI 去除 resolver URL、`doi:` 和边界空白后保存为小写裸值；arXiv 去除官方前缀或 URL，并以不含 `v1`、`v2` 等 revision 后缀的官方新式或旧式基础 ID 表达；PMID 使用官方纯数字，PMCID 使用官方大写 `PMC` 前缀，其它受支持标识符遵循各自官方格式。命名空间和值分开保存，不给值增加 `pmid:` 等项目自定义前缀。
5. OpenAlex Work ID、Web of Science UID、Semantic Scholar Paper ID、Scopus EID 等标识的是供应商数据库记录，不是文献自身标识符。它们只进入 `Provenance.source_record_id` 或 `ProviderLiteratureKey.record_id`，不能因为具有官方格式就进入 `LiteratureMetadata.identifiers` 或参加跨供应商文献标识符匹配。
6. 标题和作者只在双方都没有稳定文献标识符时作为严格后备证据。比较键只执行 Unicode NFC、边界空白清理、连续 Unicode 空白合并和 Unicode casefold；来源展示值、标点、连字符、姓名组成及作者顺序保持不变。只有规范化标题、完整作者顺序、发表年份和 `document_type` 全部存在且完全一致时才自动命中；不使用标点删除、翻译、转写、姓名倒置、首字母展开、编辑距离或其它模糊匹配。
7. 明确相同才自动合并，证据不足时保持独立。不同记录只有同类稳定标识符不同时默认属于不同 `Literature`；若至少一项身份型稳定标识符相同、同时另一项身份型稳定标识符明确冲突，则以稳定的身份冲突接纳失败 fail closed。标题或作者相似不能覆盖稳定标识符冲突，冲突也不能被自动解释为版本关系；当前不为此建立候选表、冲突历史表或人工审核状态机。
8. 相同规范化 DOI 默认命中同一 `Literature`；同一基础 arXiv ID 的不同 revision 也命中同一 `Literature`，明确 revision 只留在既有来源 record、locator、URL 或 Provenance 中，不新增业务字段。`version_role` 不得把共享 DOI 的记录强行拆开。不同 DOI 默认是不同 `Literature`；arXiv 预印本与正式 DOI 版本也是两个具体 `Literature`，只有明确 `version_links` 才能聚合到同一 `MetaLiterature`。正式记录中表示相关预印本的 arXiv ID 必须进入 `version_links`，不能误作该正式 Literature 自身的 identifier。
9. 元数据供应商明确声明当前记录与其它供应商记录是同一文献的不同版本时，目标定位保存在当前 `MetadataObservation.version_links: ProviderLiteratureKey[]` 中。当前记录由 observation 自身定位，每个目标 key 至少具有非空供应商记录 ID 或一个稳定标识符；这些连接复用 observation 的 Provenance，只作为身份收敛证据。
10. 同一文献不同版本的最终权威事实只有各 `Literature` 指向同一 `MetaLiterature` 的成员归属及各自 `version_role`。系统不建立通用 `LiteratureRelationObservation` 或 `LiteratureRelation`；引用使用独立的 Reference 模型，更正、撤稿和其它非引用关系当前不进入产品 schema。
11. 文献资产和 `LiteratureContent` 归属于具体 `Literature`。相同文件字节可以复用，但文献、资产、来源和解析结果之间的关系必须分别保留。
12. 元数据、资产和最终 `LiteratureContent` 分阶段提交。未完成内容分析时，当前统一 `LiteratureMetadata` 由已关联 observations 确定性形成；内容分析成功后，Literature 把统一初始元数据、PDF 明确信息和经过验证的 LLM 提案收敛为一份当前最终 `LiteratureMetadata`，并与关键词、结构化章节、参考文献和规范 Markdown 整体提交。`CONTENT_READY` 后新取得的 observation 继续长期保存，但不能单独覆盖已与当前内容对齐的最终元数据；它只作为以后完整重分析的输入。Catalog 只保留当前统一元数据，不保存旧的统一 metadata revision 历史；`metadata_revision` 只是当前值的单调版本令牌，用于并发复检和内容对齐。Parser 中间结果不单独推进状态，具体责任由 [ADR 0008](0008-summarized-markdown-literature-content.md) 规定。
13. 每篇文献当前可以执行什么操作，由数据库中已有的元数据、资产和 `LiteratureContent` 判断，不由另一套批处理任务状态定义。
14. 产品按 owner 已确认的单机环境设计，不要求跨机器协调或分布式任务所有权。同一主机内采用何种进程模型、互斥、lease、heartbeat、中断恢复和调度方式，由后续设计决定。
15. 已经提交的元数据、资产和 `LiteratureContent` 在运行中断后仍然有效；后续运行根据这些事实补充缺失内容。具体中断与调度机制留给设计文档。
16. `Author` 表示某篇具体 `Literature` 中的结构化作者署名，不是跨文献共享的全局作者实体。作者顺序由 `LiteratureMetadata.authors` 表达；ORCID 和 ROR 只保存来源明确提供或能够与当前署名可靠对齐的值，不据此自动建立 `author_id`、跨文献合并、作者消歧任务或作者分析结果。

## 后果

- 一个供应商记录不等于一篇新的 `Literature`，也不天然等于一个文献版本。
- 多个长期保存的 `MetadataObservation` 构成可审计的来源事实；单一当前 `LiteratureMetadata` 是由这些事实及已验收 Analysis 结果形成的权威视图，不是另一套来源历史。
- 用户导入和供应商元数据共享相同身份、来源保存和统一投影机制；导入记录中的非空值优先，供应商继续独立保存并只用于补缺。重复导入相同记录不制造重复 observation。
- 旧统一元数据不形成 revision 表或历史快照；需要审查来源变化时读取 observations，需要重新形成最终元数据时重新执行确定性统一规则和必要的 Analysis。
- 文献 identifier 具有一套公共、官方且确定的 canonical 表达；Provider adapter 负责判断字段语义，公共 Model 只做纯格式转换，Literature 独占身份命中和冲突决定。
- Provider record identity 可以稳定定位某个来源记录或版本端点，但不会冒充文献自身标识符。
- arXiv revision 不制造新的 Literature；不同实际版本也不会因为相似标题、作者或不同 `version_role` 被猜测合并或拆分。
- `version_links` 保留版本归属决定的供应商证据；目标未解析或证据不足时保留 observation，但不创建占位 Literature 或改变 `MetaLiterature` 归属。
- `MetaLiterature` 成员归属已经完整表达同一文献的版本聚合，不再维护一套可能与成员归属冲突的通用文献关系。
- 资产获取和文献解析可以独立补全，不要求每次重新执行元数据搜索。
- 批次、失败和尝试记录只用于调度、诊断和审计，不能成为文献身份或可用程度的第二真相源。
- 同一现实作者可以在不同 Literature 的作者列表中分别出现；当前查询可以使用明确 ORCID，但不假定数据库已经建立全局作者身份。
- 本 ADR 固定官方标识符表达、严格后备比较、冲突关闭和版本聚合的长期边界；各 namespace 的纯 parser、统一元数据投影、批次选择方式和物理 schema 由设计文档与技术文档精确规定。

## 需要新 ADR 的变化

以下变化需要新的 owner 决策：

- 取消 MetaLiterature/Literature 两层内部身份；
- 让 provider 记录直接成为数据库主身份；
- 引入引用以外的通用文献关系图谱，或让独立关系取代 `MetaLiterature` 成员归属；
- 让批处理任务状态取代已持久化文献事实；
- 建立跨文献全局作者身份、自动作者消歧或以作者为中心的产品分析能力；
- 引入跨机器协调或分布式 worker 系统。
