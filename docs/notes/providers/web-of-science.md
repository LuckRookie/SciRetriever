# Web of Science

- 最后核对：2026-08-07
- 当前配置选择键：无；ADR 0014 已接受为目标 Metadata Provider，当前尚未实现
- 外部角色：受许可的基础/完整书目元数据、Times Cited 计数、cited references 与 citing items
- 当前仓库接入状态：完全未接入；无选择键、无 Protocol 注册、无 adapter、无 registry wiring

## 1. 产品必须分开

Clarivate 当前至少有两个不可混写的 Web of Science API 产品：

| 产品 | 当前 base | 能力边界 |
|---|---|---|
| Web of Science Starter API | `https://api.clarivate.com/apis/wos-starter/v1`、`/v2` | 基础 document/journal metadata、Web of Science 页面链接；按 plan 返回 Times Cited |
| Web of Science API Expanded | `https://wos-api.clarivate.com/api/wos` | Full Record、完整检索、addresses/affiliations/funding、cited references、citing items、related records |

[Web of Science API Lite](https://developer.clarivate.com/apis/woslite) 的当前官方页明确写明已被 Starter API 取代，并要求应用迁移。旧 Lite endpoint/schema 不能作为新 adapter 的依据，也不能把旧代码示例写成 Starter 合同。

## 2. 官方入口与证据

- [Starter API product page](https://developer.clarivate.com/apis/wos-starter)：用途、base、plan、throttling，以及取代 Lite/Links AMR。
- [Starter API OpenAPI](https://developer.clarivate.com/apis/wos-starter/swagger)：v1/v2 server、query tags、pagination、Document schema 与错误。
- [Expanded API product page](https://developer.clarivate.com/apis/wos)：用途、base、付费 entitlement 与 plan。
- [Expanded API OpenAPI](https://developer.clarivate.com/apis/wos/swagger)：检索、ID lookup、references/citing/related、Full Record schema、分页与 quota headers。
- [Web of Science advanced search](https://webofscience.help.clarivate.com/en-us/Content/advanced-search.html)：Web of Science query language 的上游帮助入口。
- [Web of Science API release notes](https://clarivate.com/release-notes/wos-apis/)：易变字段与行为更新入口。

以上为 `official`，2026-08-07 核对。当天不带 key 对 Starter v2 document search 与 Expanded search 各做一次最小匿名请求，均返回 HTTP 401、`application/json`、`WWW-Authenticate: Key`；只检查顶层 error keys，未复制 request ID 或 body。没有读取本地凭据，也没有成功 metadata/citation 现场响应。因此下文 response shape 只来自当前官方 OpenAPI/example，标记为 `official`，不是 `verified`。

## 3. 认证、订阅和额度

两个产品的 OpenAPI 都要求 header：

```text
X-ApiKey: API_KEY
```

所有生产请求均需 key。目标实现只从 `~/.sciretriever/credentials.toml` 私有读取 key 并由 Bootstrap 注入 adapter，不放 query、日志、异常、trace、provenance、fixture 或 Notes。HTTP 401 只表示 key 缺失/无效，不能区分机构订阅、具体 database edition、record depth 或 citation entitlement。

### 3.1 Starter plans

当前官方 Starter plans：

| Plan | 次/秒 | 次/日 | Times Cited |
|---|---:|---:|---|
| Free Trial | 1 | 50 | 不返回 |
| Free Institutional Member | 5 | 5,000 | 面向 WoS 订阅机构成员，官方说明可返回 |
| Free Institutional Integration | 5 | 20,000 | 需机构管理员审批，用于内部集成；具体字段 entitlement 仍以账户为准 |

Starter 有“free plan”不等于匿名，也不等于所有机构/产品数据库内容免费；仍要注册 application 和 API key。

### 3.2 Expanded plans

Expanded 需要付费许可；计划可用性取决于机构 Web of Science subscription、可检索 databases/editions、Full Record 数与请求配额。当前公开标准计划为：

| Plan | 次/秒 | Full Records/年 |
|---|---:|---:|
| Basic | 2 | 50,000 |
| Intermediate | 2 | 250,000 |
| Advanced | 3 | 1,000,000 |
| Premium | 5 | 3,000,000 |

Essentials plans 当前另列：

| Plan | 次/秒 | 次/日 | Full Records/月 |
|---|---:|---:|---:|
| Essentials 1 | 3 | 30,000 | 1,000,000 |
| Essentials 2 | 3 | 10,000 | 500,000 |
| Essentials 3 | 2 | 5,000 | 100,000 |

Expanded `optionView=FR` 取 Full Record，`SR` 是不计 Full Record quota 的短记录，`FS` 配合 `viewField` 做字段选择。响应 quota header 示例包括 `X-REC-AmtPerYear-Remaining`、`X-REQ-ReqPerSec-Remaining`；实际 header/窗口以账户和合同为准。HTTP 429 是 throttle，不应重试成“无结果”。

## 4. Starter API

### 4.1 endpoints、查询和分页

```text
GET /documents?q=...&db=...&limit=...&page=...
GET /documents/{uid}
GET /journals?q=...&limit=...&page=...
GET /journals/{id}
```

`/documents` 使用 Web of Science advanced query 语法，但 Starter 只支持其文档列出的 tags，当前包括 `TI`、`IS`、`SO`、`VL`、`PG`、`CS`、`PY`、`FPY`、`DOP`、`AU`、`AI`、`UT`、`DO`、`DT`、`PMID`、`OG`、`TS`、`SUR`。例如 DOI exact lookup 的 query 是 `DO=...`，不是普通全文关键词。`TS` 同时搜索 title、abstract、author keywords、Keywords Plus；搜索命中不能反推出具体命中字段或关键词。

`db` 默认 `WOS`，也可按 entitlement 选择 WOS Core Collection、BIOSIS、MEDLINE、Preprint Citation Index、Research Commons、All Databases 等当前枚举。不同 database 返回/计数覆盖不同，必须把 database/edition 写入 provenance，不能把多个 collection 的 count 静默相加。

分页使用 `limit` + `page`：OpenAPI 参数明确 `limit` 为 1–50、默认 10，`page` 默认 1。响应：

```text
metadata {
  total
  page
  limit
}
hits[]
```

`sortField` 支持 `LD`、`PY`、`RS`、`TC` 加 `+A|+D`；还可用 mutually constrained 的 publication/modified/times-cited modified time spans。分页增量必须固定 query、database、sort 与时间边界；page number 不是持久业务游标。

### 4.2 Document 字段

Starter 当前 Document schema：

```text
uid
title
types[]
sourceTypes[]
source {
  sourceTitle
  publishYear
  publishMonth
  volume
  issue
  supplement
  specialIssue
  articleNumber
  pages {range,begin,end,count}
}
names {
  authors[] {displayName,wosStandard,researcherId}
  contributors[] ...   # v2 only
  bookEditors[] / editors[] / corp[] / other roles ...
}
links {record,citingArticles,references,related}
citations[] {db,count}
identifiers {doi,issn,eissn,isbn,eisbn,pmid}
keywords {authorKeywords[]}
```

Starter 不提供 abstract、作者 affiliation/ROR、ORCID 或逐条 cited reference/citing record JSON。`links.references`、`links.citingArticles` 和 `links.related` 是 Web of Science 产品页面 URL，不是 API relation payload。`contributors` 只在 v2 可用，且贡献者/编辑/组织等 role 不能混入 authors。

`researcherId` 是 Web of Science ResearcherID，不是 ORCID；当前 Author 合同没有该字段，最多供 adapter 内部对齐/诊断，不能建立全局 Author identity。作者顺序按响应保持，只把明确 author role 映射为署名。Starter `issn/eissn` 是 source identifier，不进入当前 Literature identifiers；`isbn/eisbn` 只有在官方字段上下文可确定标识当前 book Literature 而非容器时才可作为 Literature identifier 候选，否则保持 adapter 内部核对值。

### 4.3 官方 response example 的精简形状

```json
{
  "metadata": {"total": 2, "page": 1, "limit": 10},
  "hits": [{
    "uid": "WOS:000222526200005",
    "title": "...",
    "types": ["Article"],
    "source": {
      "sourceTitle": "BULLETIN OF HISPANIC STUDIES",
      "publishYear": 2004,
      "volume": "81",
      "issue": "2",
      "pages": {"range": "215-228", "begin": "215", "end": "228", "count": 14}
    },
    "names": {"authors": [{"displayName": "Tomlinson, E", "wosStandard": "Tomlinson, E"}]},
    "links": {"record": "https://www.webofscience.com/...", "references": "https://www.webofscience.com/..."},
    "citations": [{"db": "WOS", "count": 3}],
    "identifiers": {"doi": "10.3828/bhs.81.2.5", "issn": "1475-3839"},
    "keywords": {"authorKeywords": []}
  }]
}
```

这是官方 OpenAPI example 的层级摘要，本轮没有授权成功读取该记录。

## 5. Expanded API metadata

### 5.1 search、ID lookup 与分页

- `GET /`：`databaseId` + `usrQuery` 提交检索并返回 records 与 `QueryID`。
- `GET /id/{uniqueId}`：按一个或逗号分隔的多个 WoS UID 取记录。
- `GET /query/{queryId}`、`/recordids/{queryId}`：对已提交 query 继续取记录/ID。
- `GET /citation-report/{queryId}`、`/category-context/{uniqueId}`：聚合/上下文能力，不是 metadata identity。

`usrQuery` 使用完整 Web of Science query language，例如 `TS=(cadmium)`；`databaseId`、edition 与 language 仍受订阅限制。WOS Core Collection search language 当前只允许/默认 English，regional databases 可能不同。

分页是 `count`（0–100，默认 10）和 `firstRecord`（1–100,000，默认 1）。references、citing 等列表也使用同一形式。100,000 上限是当前公开 endpoint 参数约束，不代表允许导出同等规模；Full Record quota、每秒请求和响应大小预算仍先行。

检索响应的主要顶层：

```text
Data.Records.records.REC[]
QueryResult {
  QueryID
  RecordsSearched
  RecordsFound
}
```

QueryID 是服务端检索上下文，不是 provenance source ID；不能跨环境长期持久化为文献标识。需要增量重放时应保存规范 query、database/edition、sort/time span 和实际 observation。

### 5.2 Full Record 主要层级

Expanded `WosRecord` 是深层 vendor JSON，候选 adapter 只应显式读取需要的字段：

- `UID`：WoS source record；
- `static_data.summary.titles.title[] {type,content}`：item/source/book 等不同 title；
- `summary.pub_info`：cover/sort/early-access date、year、volume、issue、page、publication type；
- `summary.names.name[]`：`seq_no`、`role`、full/display/first/last name、`orcid_id`、`r_id`、`addr_no[]`；
- `summary.publishers`、`summary.doctypes`；
- `fullrecord_metadata.abstracts`、`languages`/`normalized_languages`、`keywords`、`addresses`、`refs.count`；
- identifiers 在 record 的 item/cluster identifiers 层级；具体 type/value 必须显式解析；
- `dynamic_data.citation_related.tc_list.silo_tc[] {coll_id,local_count}`：分 collection Times Cited；
- funding、conference、category、citation context/topic 等其它 Full Record 信息。

作者只取明确 author role，按 `seq_no` 保序。ORCID 只有同一 name item 的 `orcid_id` 明确提供时才候选；`addr_no[]` 与 addresses 的 `addr_no` 对齐后才可保存 affiliation 文本。当前公开 schema 没有明确 ROR 字段，不能从组织名猜 ROR。ResearcherID、内部 DAIS ID 不进入 Author 业务身份。

`fullrecord_metadata.keywords` 在对应 author keyword 语义明确时可形成 `declared_keywords`；`item.keywords_plus`、category、citation topics/context 是 Clarivate 分类/派生数据，不属于来源声明关键词，也不新增分析模型。

## 6. Expanded citation operations

### 6.1 cited references

`GET /references?databaseId=WOS&uniqueId=WOS:...&count=...&firstRecord=...` 返回当前记录引用的 references。每条当前官方 `ReferenceRecord`：

```text
UID?
citedAuthor
citedTitle
citedWork
year
page
doi?
timesCited
```

若 `UID` 或 DOI 可稳定解析，每项可形成一条 `citing=current -> cited=reference` 的 `ProviderRelationObservation` 候选。没有稳定目标 ID 的 author/title/year 只能作为未来临时 lookup 输入，不能伪造 Literature 或权威 Reference。该响应没有明确的原始 reference string/原文位置，不能把拼接字段写入 `reference_texts`。每项 `timesCited` 是外部 reference record 的计数，不是当前 citing Literature 的计数，也不用于生成边。

### 6.2 citing items

`GET /citing?databaseId=WOS&uniqueId=WOS:...` 查找引用当前记录的 items；官方限定该 operation 的有效 database 为 Web of Science Core Collection (`WOS`)。返回普通 WoS search records：每个返回 UID 是 citing 端，输入 UID 是 cited 端，可逐项形成 `citing=result -> cited=input` 的 observation 候选。

### 6.3 counts 与 related records

Full Record `silo_tc[]` 或 Starter `citations[]` 是按 collection 的 Times Cited count，可带 provider/database provenance 候选映射 `MetadataObservation.cited_by_count`；不能跨 collection/供应商相加，也不能反推 citing edges。`refs.count` 可候选映射 `reference_count`，但不能补齐 reference observations。

`GET /related` 返回 related records，不是 citation，不能形成 `ProviderRelationObservation`、version link 或通用关系图。`citation-report`/citation context/category 是聚合分析，不进入当前领域中立 Model。

## 7. 与 SciRetriever 中性数据的候选映射

| 外部字段 | 外部语义 | 候选归属 | 约束 |
|---|---|---|---|
| WoS `UID` | source record/accession number | provenance/source record | 不代替本地 Literature ID |
| DOI/PMID 等明确 document ID | 稳定文献标识 | `LiteratureMetadata.identifiers` | source ISSN 不进入文献 identifiers；未知 type 不猜 |
| item title / Starter `title` | 文献标题 | `LiteratureMetadata.title` | Expanded 必须按 title `type` 选 item title |
| Expanded abstract | 摘要 | `LiteratureMetadata.abstract` | Starter 缺失，不从 `TS` 命中反推 |
| author role names | 有序署名 | `LiteratureMetadata.authors` | role + seq_no/响应顺序；ORCID/affiliation 只用明确对齐值 |
| source title | venue 名称 | `LiteratureMetadata.venue` | ISSN 仅 adapter 内部容器辨识，不进入当前 Model |
| pub info/source pages | 年月日、卷期页、类型 | `LiteratureMetadata` 对应字段 | cover/early-access/sort date 需明确 precedence；不伪造日精度 |
| publisher/language | 出版者、语言 | `LiteratureMetadata.publisher` / `LiteratureMetadata.language` | 显式值 |
| author keywords | 来源声明关键词 | `MetadataObservation.declared_keywords` | Keywords Plus/category/topic 排除 |
| `refs.count` | outgoing reference count | `MetadataObservation.reference_count` | 不反推边 |
| Times Cited by collection | incoming count | `MetadataObservation.cited_by_count` | 保留 database；不跨 collection 相加 |
| references 中稳定 UID/DOI | outgoing edge | `ProviderRelationObservation` | 一 reference 一 observation，`current -> target` |
| citing records UID | incoming edge的 citing 端 | `ProviderRelationObservation` | 一 result 一 observation，`result -> current` |
| request time、database/edition/query | 来源上下文 | provenance | API query ID、page 不作为业务 ID |

Starter 与 Expanded 是两套外部产品/response parser；不能根据字段相似就共用未经区分的 vendor model。若两者对同一 UID 给出事实，仍是带产品、数据库、观察时间的独立 observation。

## 8. 资产能力

当前 Starter/Expanded 公开 schema 不提供可确认的 PDF/full-text locator、OA 状态、license 或 file media type。Starter/Expanded 的 `record`、`references`、`citingArticles`、`related` gateway link 都是 Web of Science 产品页面/导航，不是主 PDF，不能形成 `AssetHint`。Web of Science 因此不是当前 asset source 候选；不得从 DOI/source title 拼 publisher URL。

## 9. 不进入业务 Model 的字段

- Web of Science ResearcherID、DAIS/internal person ID、全局作者分析实体；
- ISSN/eISSN 等容器 identifier；
- Keywords Plus、categories、citation topics/context/function、related records；
- funding/conference 等当前未进入 `LiteratureMetadata` 的 Full Record 扩展；
- QueryID、pagination、records searched、quota/throttle headers；
- Web UI/gateway links作为资产；
- API key、institution/account/contract 信息和完整 vendor JSON/XML。

## 10. 错误与排障语义

Starter 当前公开错误：400 query/request 语法；401 key 缺失/无效；404 resource/query 无记录；405 非 GET；50x server error。Expanded 另明确 429 throttle。实际接入必须进一步区分：

1. key 未配置/无效；
2. institution subscription 或具体 API product 未授权；
3. database/edition/Full Record/citation operation entitlement 不足；
4. Full Record 配额耗尽或 requests/s throttle；
5. query language 错误；
6. 正常零结果/UID 不存在；
7. Network policy/响应校验失败。

上述情况都不能降级为“未找到文献”。错误 body/request ID 只做脱敏诊断，不持久化账户上下文。

## 11. 已知限制与待核对

- 本轮没有任何 key/机构环境，无法现场验证成功响应、实际 entitlement、quota headers 或不同 database shape；官方 OpenAPI example 不冒充 `verified`。
- Advanced Search 帮助入口在本轮匿名抓取时重定向到 Web of Science Zendesk 并返回 403；本文支持的 field tags/query 参数来自当前 Starter/Expanded OpenAPI，未用受阻页面补全语法。
- Starter v1/v2 同时公开；contributors 明确仅 v2。实施前应选定 v2 并确认兼容/退役政策，不自动 fallback 到 v1。
- Expanded JSON 很深且 object/array 形态可能随 cardinality变化；需要按当前 OpenAPI 为每个边界建立真实授权环境的小型脱敏 fixture。
- Starter publication year 对 early access search 的命中可能与返回 `publishYear` 不同，官方已明确提示；不能把 search predicate 当返回 metadata。
- Expanded cited reference 的 `UID`/DOI 覆盖、引用原文缺失和 citing endpoint 的 edition 范围需在有授权环境中验证。
- Lite 已被替代；本 Notes 不保留其旧 endpoint、分页或 model 作为 fallback。
- 本轮未访问受限正文、PDF、用户语料或本地凭据。

## 12. 当前实现边界

Web of Science 已进入目标 Metadata 领域搜索能力，但不属于当前 schema v2 的 metadata 或 citation allowlist，也不属于目标 Acquisition 来源。仓库没有 Web of Science 选择键、Starter/Expanded 产品选择、`X-ApiKey` 配置、institution entitlement、query/pagination parser、Full Record/references/citing adapter、Protocol 注册或 registry wiring；当前 Collection/Assets Service 不会调用 Clarivate。目标已接受不能替代这些实现与 readiness 证据。
