# Metadata Provider TypeScript 迁移矩阵

日期：2026-09-11。

本矩阵关闭全量迁移计划 T037。能力以 Python adapter 的实际公开 Port 为基线；没有
`open_reference_query` 的 Provider 在 TS registry 中不声明 `reference-query`，不会为了名称对称虚构引用能力。

| Provider | TS adapter | Topic / Lookup / Reference | 主要离线证据 |
| --- | --- | --- | --- |
| Crossref | `metadata/crossref.ts` | 是 / 是 / 不支持 | `metadata-crossref.test.ts`：REST envelope、cursor、filter、mailto、DOI lookup、坏页 |
| Semantic Scholar | `metadata/semantic-scholar.ts` | 是 / 是 / 是 | `metadata-semantic-scholar.test.ts`、`metadata-reference-adapters.test.ts`：external ID、offset/next、双向引用、自环 |
| arXiv | `metadata/arxiv.ts` | 是 / 是 / 不支持 | `metadata-arxiv.test.ts`：Atom entry、OpenSearch 分页、arXiv ID/version、PDF hint |
| OpenAlex | `metadata/openalex.ts` | 是 / 是 / 是 | `metadata-openalex.test.ts`：cursor、inverted abstract、DOI/PMID/PMCID lookup、references/cited-by |
| Europe PMC | `metadata/europe-pmc.ts` | 是 / 是 / 是 | `metadata-europe-pmc.test.ts`、`metadata-reference-adapters.test.ts`：cursor/page、PMID/PMCID/DOI、引用文本、inline metadata |
| DataCite | `metadata/datacite.ts` | 是 / 是 / 是 | `metadata-datacite.test.ts`、`metadata-reference-adapters.test.ts`：DOI、creator/affiliation、relatedIdentifier 方向 |
| CORE | `metadata/core.ts` | 是 / 是 / 是 | `metadata-commercial.test.ts`：分页、work/output 身份、全文 hint、嵌入 references |
| OpenCitations | `metadata/opencitations.ts` | 否 / 是 / 是 | `metadata-opencitations.test.ts`：Meta lookup、DOI relation、空/坏响应、方向边界 |
| Elsevier | `metadata/elsevier.ts` | 是 / 是 / 不支持 | `metadata-commercial.test.ts`：Scopus search、abstract lookup、PII/EID/DOI、cursor、凭据 header |
| Springer Nature | `metadata/springer.ts` | 是 / 是 / 不支持 | `metadata-commercial.test.ts`、`metadata-assembly.test.ts`：Meta v2、start/pageLength、`api_key` query seam |
| Web of Science | `metadata/web-of-science.ts` | 是 / 是 / Expanded 是 | `metadata-commercial.test.ts`：Starter/Expanded、WOS UID、分页、引用、凭据 header |

共同边界由以下证据覆盖：

- `metadata-service.test.ts`：逐 Provider raw scan limit、转换前计数、部分成功、取消和稳定失败；
- `metadata-assembly.test.ts`：11 Provider Application 组装、capability/readiness、配置选择和凭据注入；
- `application-assembly.test.ts`：生产 Application 复用同一 Network budget owner；
- `agent-network-transport.test.ts`：URL 准入、redirect、credential header/query 清除和响应大小限制；
- `metadata-reference-adapters.test.ts`：多 key、分页终止、引用方向、self relation 和 Europe PMC 纯文本引用。

本矩阵只证明固定输入下的 adapter、选择、组装和失败合同。真实 Provider 在线可用性、账号 entitlement、
配额和站点效果属于运行时外部事实，未获授权且未执行。
