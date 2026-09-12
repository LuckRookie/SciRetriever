# TypeScript Metadata core

日期：2026-09-11。

`apps/server/src/metadata/ports.ts`、`service.ts`、`api.ts` 和 `registry.ts` 已建立 provider-neutral 的 TS 边界：topic search、exact lookup、reference query 使用独立 capability；raw item、vendor cursor 和分页状态只留在 adapter session；scan limit 在转换前消耗；取消返回短生命周期 `INTERRUPTED`；孤立 record failure 保留第一条脱敏 `StableFailure`，不把 provider raw 值带入结果。

`apps/server/src/metadata/` 已实现原 Python 基线中的 11 个 Provider：Crossref、Semantic Scholar、arXiv、OpenAlex、Europe PMC、DataCite、CORE、OpenCitations、Elsevier、Springer Nature 和 Web of Science。它们分别解析实际 REST/Atom envelope，并由 `assembleMetadataRegistry` 通过共享 `NetworkBudgetCoordinator` 和受限 Network transport 装入唯一 Application。没有 Provider 会在组装时探测网络；缺少 adapter 或凭据分别稳定显示为 `missing-production-adapter` 或 `credential-missing`。

引用能力按 Python 基线开放给 Semantic Scholar、OpenAlex、Europe PMC、DataCite、CORE、OpenCitations 和 Web of Science Expanded；其余 Provider 的 capability matrix 明确没有 `reference-query`。Europe PMC 的引用结果同时保留锚点 `reference_texts`、关联条目的 inline metadata 和 PMID/PMCID/DOI；纯文本引用不会虚构关系。所有 reference adapter 都去除可证明的自环，保持有向 citing/cited 端点和来源 provenance。

Auto/Custom selection 只依据本地配置和 capability，不受 readiness 或网络状态重写。`MetadataService` 在 raw item 转换前消耗逐来源 scan limit，保留已成功转换的结果和第一条脱敏失败；各 adapter 负责验证自身 cursor、offset、page size、total 和无进展页。Provider record ID 始终留在 `source_record_id`/relation endpoint，不冒充 DOI、PMID 等中性 identifier。

完整 Provider、capability 和测试索引见[Metadata Provider TypeScript 迁移矩阵](metadata-provider-matrix.md)。直接证据还包括 `apps/server/test/metadata-service.test.ts` 的分页预算、record failure 和取消合同，以及 `apps/server/test/metadata-assembly.test.ts` 的 11 Provider 生产对象图、readiness 和 credential 注入矩阵。全部测试使用 fixture/fake/loopback，没有访问真实 Provider。
