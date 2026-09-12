# Metadata Provider 后续兼容清单

2026-09-11。该清单最初用于冻结 Crossref 以外 Provider 的迁移范围；这些后续项现已由
[Metadata Provider TypeScript 迁移矩阵](metadata-provider-matrix.md)逐项关闭。下表保留原差分关注点，
完成状态以矩阵、源码、直接测试和 TS Full 为准，全程没有触发真实 Provider 请求。

| Provider | Python 基线 adapter | 基线测试索引 | 已关闭的差分重点 |
| --- | --- | --- | --- |
| arXiv | `metadata/providers/arxiv/adapter.py` | `test_metadata_crossref_arxiv.py` | arXiv ID/version、作者、分类与日期映射 |
| CORE | `metadata/providers/core/adapter.py` | `test_metadata_europepmc_datacite_core.py` | 分页边界、全文链接和引用方向 |
| DataCite | `metadata/providers/datacite/adapter.py` | `test_metadata_europepmc_datacite_core.py` | DOI、creator/affiliation 和 resource type |
| Elsevier | `metadata/providers/elsevier/adapter.py` | `test_metadata_elsevier_springer.py` | 商业凭据 origin、PII/EID 与摘要字段 |
| Europe PMC | `metadata/providers/europe_pmc/adapter.py` | `test_metadata_europepmc_datacite_core.py` | PMID/PMCID/DOI 多身份和开放全文标记 |
| OpenAlex | `metadata/providers/openalex/adapter.py` | `test_metadata_semantic_openalex.py` | inverted abstract、work/version ID 和引用关系 |
| OpenCitations | `metadata/providers/opencitations/adapter.py` | `test_metadata_opencitations.py` | DOI 关系方向、游标和缺失记录 |
| Semantic Scholar | `metadata/providers/semantic_scholar/adapter.py` | `test_metadata_semantic_openalex.py` | paper ID/DOI、嵌套作者和引用分页 |
| Springer | `metadata/providers/springer/adapter.py` | `test_metadata_elsevier_springer.py` | 商业凭据 origin、identifier 与 publication type |
| Web of Science | `metadata/providers/web_of_science/adapter.py` | `test_metadata_web_of_science.py` | UT/DOI、游标、商业凭据和限额失败 |

各切片复用统一 `MetadataObservation`、Provider access budget、错误分类和敏感 URL 过滤，并使用固定
fixture/fake 做离线差分。T037 已完成；这不代表真实网络效果已经验证，也不关闭其余 M4 任务。
