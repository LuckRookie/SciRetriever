# ADR 0006：由 LLM 形成 LiteratureContent 与文本参考文献

- Status: Superseded by [ADR 0008](0008-summarized-markdown-literature-content.md)
- Date: 2026-08-05
- Revised: 2026-08-06
- Supersedes: none
- Superseded by: [ADR 0008](0008-summarized-markdown-literature-content.md)
- Amended by: [ADR 0007](0007-reference-resolution-and-authoritative-relations.md)（第 6、7、9 项及对应后果中的引用 observation/Package 规则）
- Amends: [ADR 0003](0003-operator-managed-mineru-service.md)、[ADR 0005](0005-document-package-2-breaking-contract.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[Parsing 技术文档](../technical/parsing.md)、[Analysis 技术文档](../technical/analysis.md)

> 本 ADR 保存此前 Parser/LLM 内容边界的历史决策。ADR 0008 延续 ParserResult、文本参考文献和 lineage 边界，但以总结型 Markdown、统一有序章节和一次最终提案替代这里的旧 LiteratureContent 含义。

## 背景

不同期刊 PDF 的章节名称、排版和参考文献格式并不统一。MinerU 可以恢复文本、页面、块和部分结构线索，但不能作为 SciRetriever 对正文含义、参考文献边界或最终轻结构化文档的业务判断者。

`LiteratureContent` 还需要成为可独立读取和导出的轻结构化文档。如果只在独立引用关系中保存参考文献信息，导出文档时就必须重新查询并拼装引用图，而且无法稳定保留 PDF 中实际出现的参考文献文本。

Owner 当时确认：MinerU 只产生中性的 Parser 中间结果；LLM 判断实际内容并形成最终 `LiteratureContent`；`LiteratureContent` 自身保存文本形式的参考文献。供应商和 LLM 共同产生 `ReferenceObservation` 的原决策已经由 [ADR 0007](0007-reference-resolution-and-authoritative-relations.md) 替代。

## 决策

1. Parsing 把当前主 PDF 提交给选定 parser，并把不可信私有输出转换为 parser-neutral `ParserResult`。`ParserResult` 保留后续 LLM 所需的文本、结构线索、source locator、输入 PDF hash、parser identity 和参数，但不是 `LiteratureContent`、文献状态或可独立导出的产品文档。
2. MinerU 或其它 parser 不产生参考文献文本、临时引用检索线索或权威引用关系，也不决定哪些块在业务上构成参考文献。Parser 返回的章节名称或结构标记只能作为 LLM 的输入线索。
3. Analysis 消费经过验证且对齐当前 PDF 的 `ParserResult`，先判断是否包含实际文献内容。只有明确的无实际内容判断才能触发清理；Parser 或 LLM 调用失败不能触发删除。
4. 内容有效时，由 Analysis 使用 LLM 形成领域中立、可独立读取和导出的 `LiteratureContent`。`LiteratureContent` 必须保留回到当前 PDF 的 source locator，并同时记录 parser 与 analysis-model provenance 和 lineage。
5. `LiteratureContent.references` 的类型固定为 `EvidenceText[]`。每个元素保存一条非空参考文献文本及其 PDF `SourceLocator[]`，保持文献中的引用顺序；允许标题、DOI 或其它结构化字段缺失，不允许补写原文没有表达的信息，也不保存列表完整性声明。
6. ~~元数据供应商和 LLM 分别产生 `ReferenceObservation`。~~此项由 ADR 0007 替代：原文留在各自来源容器，LLM 只形成临时 `ReferenceLookup`，目标文献正常入库后才形成权威 `Reference`。
7. 文档导出直接读取 `LiteratureContent.references`，不依赖引用目标是否已经解析，也不从权威引用关系反向重建原文参考文献。引用解析与关系合同以 ADR 0007 为准。
8. `CONTENT_READY` 只在已经发布对齐当前 PDF 的有效 `LiteratureContent` 时成立。`ParserResult`、MinerU task 或未提交的 LLM 输出不推进 Literature 状态。
9. ADR 0005 的 `LiteratureContent.references:[EvidenceText]` 修订继续有效；`ReferenceView`、`AnalysisProposal.references`、`ReferenceSnapshot` 和引用排序由 ADR 0007 再次修订。

## 后果

- Parsing 和 Analysis 之间存在一个中性的 `ParserResult` 合同；它隔离 MinerU 私有输出，但不形成第二种产品文档。
- `LiteratureContent` 的形成需要 parser 与 LLM 两段 lineage，不能只记录其中一段。
- 用户导出轻结构化文档时可以直接获得参考文献文本，即使对应目标尚未解析为本地 `Literature`。
- 供应商原文和 PDF 原文分别留在各自来源容器；目标解析和权威关系形成遵守 ADR 0007。
- Parser 成功而 LLM 内容判断或文档整理失败时，当前主 PDF 仍然有效；目标仍未达到 `CONTENT_READY`，后续运行可以重新处理。

## 需要新 ADR 的变化

以下变化需要新的 owner 决策：

- 重新让 parser 私有输出或 Parser adapter 直接成为 `LiteratureContent`；
- 允许 MinerU 或其它 parser 直接发布权威引用关系；
- 从 `LiteratureContent` 删除可独立导出的参考文献文本；
- 取消从 `LiteratureContent` 到原始 PDF 的 evidence、provenance 或 lineage；
- 再次修改 ADR 0005 已冻结的递归 Package 形状。
