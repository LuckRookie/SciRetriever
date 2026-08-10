# Elsevier

- 最后核对：2026-08-07
- schema v2 选择键：metadata `elsevier`；asset `elsevier`
- 供应商角色：Scopus/Elsevier 元数据查询，以及受产品订阅和授权约束的文章全文/对象获取
- 当前仓库接入状态：只有选择键、通用 Protocol/adapter/registry；没有 Elsevier 专用生产 client，registry 未连接到当前 Collection 或 Assets Service

## 1. 官方入口与证据

- [Elsevier Developer Portal](https://dev.elsevier.com/)：API 产品与账户入口。
- [API documentation](https://dev.elsevier.com/api_docs.html)：API 目录、WADL 与公开样例。
- [API key settings](https://dev.elsevier.com/api_key_settings.html)：配额、throttle 与产品授权说明。
- [Scopus Search API WADL](https://dev.elsevier.com/documentation/ScopusSearchAPI.wadl)：搜索参数、分页、view 与响应格式。
- [Abstract Retrieval API WADL](https://dev.elsevier.com/documentation/AbstractRetrievalAPI.wadl)：单条摘要/书目记录与 references。
- [Article Retrieval API WADL](https://dev.elsevier.com/documentation/ArticleRetrievalAPI.wadl)：文章全文 XML/JSON 获取合同。
- [Object Retrieval API WADL](https://dev.elsevier.com/documentation/ObjectRetrievalAPI.wadl)：文章对象获取合同。
- [Abstract Citation API WADL](https://dev.elsevier.com/documentation/AbstractCitationAPI.wadl)：按年引用计数/overview。

均为 `official`，2026-08-07 核对。公开文档和 payload examples 可匿名读取；实际 API 要求 key，本轮没有读取本地凭据，也没有向 API 发送认证请求。

## 2. 认证、授权、配额与 throttle

Elsevier API key 必需，通常用 `X-ELS-APIKey` header。部分产品还支持 OAuth bearer、
`X-ELS-Authtoken` 或机构 token `X-ELS-Insttoken`；“key 可用”和“机构有相应 Scopus/
ScienceDirect 内容订阅”是两个条件，不能由一个端点的 HTTP 200 推断其它产品权限。

各 API 有独立配额，官方当前说明每 7 天重置。响应可提供：

```text
X-RateLimit-Limit
X-RateLimit-Remaining
X-RateLimit-Reset
```

当前官网列出的常用默认值：

| API | 周配额 | throttle | 其它限制 |
|---|---:|---:|---|
| Scopus Search | 20,000 | 9 req/s | 无 cursor 时最多访问 5,000 个结果；`STANDARD` 每页最多 200，`COMPLETE`/`COMPONENT` 最多 25 |
| Abstract Retrieval | 10,000 | 9 req/s | 单记录；view/entitlement 影响字段 |
| Article Retrieval | 50,000 | 10 req/s | 官方表中 TDM key 为 unlimited；内容权限另计 |
| ScienceDirect Search v2 | 20,000 | 2 req/s | 与 Scopus Search 是不同产品 |

这些是供应商默认值，不是 SciRetriever 应用级预算。429 既可能表示 quota exceeded，也可能是瞬时 throttle；实现需结合响应体/headers、重置时间和有界退避判断。key、token、机构身份和 usage headers 不进入业务 Model 或日志。

历史 `verified`，2026-07-21：当时配置的一枚 key 对官方 API 最小请求返回 HTTP 200；与此同时，旧分层 acquisition 路径在两个真实样本上均超过外层 90 秒限制。这只证明该时间点 key/API 可达，以及历史 client/transport 存在 timeout 问题；不证明当前凭据仍有效、内容已授权或 Composition 已接入。本轮没有读取或复用该 key。

## 3. 元数据接口

### 3.1 Scopus Search

搜索 API 的资源形状由 WADL 定义，常用查询为 Scopus query syntax，`start`/`count` 或
cursor 控制分页，`view` 控制字段集。公开 JSON 样例顶层：

```text
search-results {
  opensearch:totalResults
  opensearch:startIndex
  opensearch:itemsPerPage
  opensearch:Query
  link[]
  entry[]
}
```

`entry[]` 常见字段：

- 身份：`dc:identifier`（常为 Scopus EID）、`eid`、`prism:doi`、PII、PubMed ID 等；
- 标题与描述：`dc:title`、`dc:description`、`subtype`/`subtypeDescription`；
- 作者：精简视图可只有 `dc:creator`，扩展 view 可有 `author[]`；
- 发表信息：`prism:publicationName`、`prism:issn`、`prism:eIssn`、
  `prism:volume`、`prism:issueIdentifier`、`prism:pageRange`、`prism:coverDate`；
- 来源扩展：`affiliation[]`、`authkeywords`；
- 引用与链接：`citedby-count`、`link[]`，其中 `@ref=full-text` 是 API/落地入口线索。

不同 `view`、记录类型和 entitlement 返回字段不同，adapter 不能依赖单一公开样例中的完整度。
`dc:creator` 的单一字符串也不能替代有序结构化 authorship。

### 3.2 Abstract Retrieval

Abstract Retrieval 可按 Scopus ID、DOI、PII、PubMed ID 等单条取回，公开 JSON 样例顶层为
`abstracts-retrieval-response`，主要分区：

```text
abstracts-retrieval-response {
  coredata
  affiliation[]
  authors { author[] }
  authkeywords { author-keyword[] }
  item { bibrecord { head ..., tail { bibliography { reference[] } } } }
}
```

`coredata` 包含标题、标识符、摘要、publication/cover date、venue、卷期页、引用计数、链接等。`authors.author[]` 的顺序、preferred/given/surname、ORCID 与 affiliation references 可以提供结构化署名候选；只有明确可对齐的 ORCID/单位信息才能进入 Author。

`tail.bibliography.reference[]` 是文末参考文献集合。每项可能含：

- `ref-info.refd-itemidlist.itemid`：带 ID 类型的被引目标标识；
- `ref-authors`、`ref-sourcetitle`、`ref-publicationyear`、volume/pages；
- 原始或半结构化 `ref-fulltext`。

这些 references 属于获取该 metadata record 时返回的来源内容。显式目标 ID 是未来结构化关系观察的候选，原文是 `MetadataObservation.reference_texts` 候选；不能仅凭作者、标题和年份猜出权威 Reference。当前 schema v2 没有 `elsevier` citation 选择键，本文不把 bibliography 写成已接入的 citation expansion。

## 4. 引用能力边界

- `citedby-count` 是来源计数，不是 citing-work 边列表，不能跨供应商相加或物化边。
- Abstract Citation/Overview API 按年份返回计数与 summary，不提供足以逐边建立 `ProviderRelationObservation` 的 citing work 列表。
- Abstract Retrieval bibliography 描述 outward references；只有显式且可规范化的 target ID 才能形成候选 observation，未匹配原文仍只保留为 reference text。
- 当前项目的 citation provider 允许键只有 `openalex` 与 `semantic-scholar`；若以后要用 Elsevier 做独立引用扩展，必须先修改公开配置合同、责任文档和直接测试。

## 5. 全文、对象与资产线索

### 5.1 Article Retrieval

Article Retrieval 接受 DOI、PII 等标识，内容可受 API key、机构订阅、文章 entitlement 和 TDM 合同共同约束。公开样例 JSON 顶层为：

```text
full-text-retrieval-response {
  coredata
  objects { object[] }
  originalText
}
```

`originalText` 在 JSON 中可包含转义 XML；XML 响应是 Elsevier 文章结构。`objects.object[]` 可列举图像等附属对象及其引用。这些能力不能自动等同为 PDF：本轮当前 WADL/公开样例足以证明 XML/JSON full text 与对象能力，但没有找到可以稳定概括为“按附件 EID 获取主文 PDF”的当前公开依据。

因此 adapter 至少要区分：

1. Scopus `@ref=full-text` 链接：API 或 landing 候选，不保证媒体类型；
2. Article Retrieval XML/JSON：parser 可消费的外部全文候选，但当前 Acquisition 主资产合同是 PDF；
3. Object Retrieval：图像/对象资源，不能默认升级成主文或补充 PDF；
4. publisher landing/PDF locator：只有当前官方响应明确给出且通过安全获取与 PDF 检查时才可接纳。

本轮没有调用 Article/Object API，也没有下载任何内容。旧 Notes 中“附件 EID 一定可取主文或补充 PDF”的概括缺少当前公开证据，不沿用为 official 事实。

## 6. 代表性响应结构

公开 Scopus Search JSON 样例的精简形状：

```json
{
  "search-results": {
    "opensearch:totalResults": "1",
    "opensearch:startIndex": "0",
    "opensearch:itemsPerPage": "1",
    "entry": [{
      "dc:identifier": "SCOPUS_ID:...",
      "eid": "2-s2.0-...",
      "dc:title": "...",
      "dc:creator": "...",
      "prism:publicationName": "...",
      "prism:coverDate": "...",
      "prism:doi": "...",
      "citedby-count": "...",
      "link": [{"@ref": "full-text", "@href": "https://..."}]
    }]
  }
}
```

这是官方文档样例的层级摘录，不是本轮带 key 现场响应。数字常以字符串表达；转换必须显式并处理缺失/非法值。

## 7. 与 SciRetriever 中性数据的候选映射

| 外部字段 | 外部语义 | 候选归属 | 备注 |
|---|---|---|---|
| Scopus EID / `dc:identifier` | provider record identity | `Provenance.source_record_id` | 不代替本地 Literature ID |
| DOI/PII/PMID 等显式 ID | 文献标识 | `LiteratureMetadata.identifiers` | 按 namespace 规范化；不从 URL 猜 |
| title/description | 标题/摘要 | `LiteratureMetadata` | Abstract Retrieval 优先于精简 Search 字段 |
| publication/cover date、venue、卷期页 | 发表信息 | `LiteratureMetadata` | 区分 online/cover/publication date |
| `authors.author[]` | 有序结构化署名 | `Author[]` | 只接受明确对齐的 ORCID/affiliation；`dc:creator` 不足时不伪造 |
| `authkeywords.author-keyword[]` | 作者关键词 | `MetadataObservation.declared_keywords` 候选 | 不把 Scopus 分类词混入 |
| bibliography 原文 | 来源参考文献文本 | `MetadataObservation.reference_texts` 候选 | 保持来源顺序与 provenance |
| bibliography 显式 target ID | 来源结构化引用 | `ProviderRelationObservation` 候选 | 每个显式目标一条；当前无独立 citation key |
| `citedby-count` | 来源引用计数 | observation 计数字段候选 | 不生成边 |
| full-text/link/object locator | 资产线索 | `AssetHint[]` | 区分 landing、XML、image 与 PDF；逐项验证 |

## 8. 不进入业务 Model 的字段

- `opensearch:*`、cursor/start/count、query echo、WADL view、service timings；
- quota headers、key、OAuth/机构 token、entitlement 调试信息；
- 完整 vendor JSON/XML、Scopus 内部分析字段、author/affiliation 聚合实体图；
- `citedby-count` 推导出的伪引用边；
- `originalText` 原样塞进 MetadataObservation 或 Model；
- 由 link 名称、对象 EID 或 HTTP 200 猜测出的媒体类型和授权结论。

## 9. 已知限制与待核对

- 本轮没有可用 key 的只读现场验证；实际 view、字段完整度、entitlement 和错误体需实现时以受控账户再核对。
- 官方默认配额和 throttle 会变化，且可能按 API key/机构协议覆盖；运行时以 headers 与账户设置为准。
- `COMPLETE`/`STANDARD` 字段和每页上限不同；搜索翻页需直接测试 cursor 结束条件与 5,000 结果边界。
- 当前公开依据只支持把 Article Retrieval 写成 XML/JSON full text；稳定 PDF endpoint、PDF 附件对象类型与授权条件待 Elsevier 官方支持确认。
- Citation Overview 不是引用边 API；不要把年度计数当逐条引用。

## 10. 当前实现边界

`elsevier` 是 metadata/asset 两类允许键，但仓库没有 API key/token 注入、Scopus query/cursor、WADL schema、Abstract/Article/Object 解析、entitlement 或 asset media type 选择。`VendorMetadataRecord` 当前也只有精简 title/authors/year/identifiers/abstract，不能承载本文列出的全部目标字段。所有实际协议仍需调用方注入具体 client，且 registry 未接业务 Service；配置选择不代表生产接入。
