# DataCite

- 官方资料最后在线核对：2026-08-07
- 当前实现离线对照：2026-08-15
- 当前选择键：Metadata `datacite`；Acquisition `datacite`；引用是 Metadata 的可选能力
- 外部角色：通用 DOI 元数据、显式关联标识符、引用/版本关系摘要与资源 locator
- 当前仓库接入状态：DataCite JSON:API 专用 Metadata search/lookup/reference adapter 已进入生产 registry；资源 locator 只形成可由通用 Public route 复核的 `AssetHint`

## 1. 官方入口与证据

- [DataCite REST API](https://support.datacite.org/docs/api)：REST API 总览、JSON:API、公开读取与 Member API 边界。
- [Get a single DOI](https://support.datacite.org/docs/api-get-doi)：单 DOI endpoint、响应结构，以及按需返回 affiliation/publisher 详情的参数。
- [Return a DOI OpenAPI definition](https://support.datacite.org/reference/get_dois-id)：当前 REST API 2.3.0 的 `attributes`、`container`、name type 与计数字段 schema。
- [Queries](https://support.datacite.org/docs/api-queries)：`query`、字段查询、布尔表达式、wildcard、filter 与 sort。
- [Pagination](https://support.datacite.org/docs/pagination)：page-number 与 cursor 分页。
- [Retrieve more than 10,000 records](https://support.datacite.org/docs/how-should-i-set-up-my-query-via-the-rest-api-to-retrieve-large-numbers-of-records-10000)：深分页必须跟随 `links.next`。
- [Rate limits](https://support.datacite.org/docs/rate-limit)：匿名、identified、authenticated 请求与 HTTP 429。

以上均为 `official`，2026-08-07 核对。当天对一个公开 DOI 和一个 `page[size]=1` 搜索做了匿名只读请求，均为 HTTP 200、`application/json`；响应层级与下文 shape 属于 `verified`，不是可用性 SLA。

## 2. 服务边界、认证与限流

DataCite REST API 遵循 JSON:API，base 为 `https://api.datacite.org`。公开 DOI 的 GET 不要求认证；创建/更新 DOI、读取 draft/registered DOI、联系人等 Member API 能力需要 DataCite 账户认证，SciRetriever 的候选只涉及公开只读接口。

当前官方按单 IP、五分钟窗口给出的限制为：

| 请求类别 | 当前限制 | 识别方式 |
|---|---:|---|
| authenticated | 3,000 / 5 分钟 | 账户认证 |
| identified | 1,000 / 5 分钟 | `User-Agent` 含 email 或请求含 `mailto=` |
| unidentified | 500 / 5 分钟 | 不含上述识别信息 |
| `doi.org` content negotiation | 1,000 / 5 分钟 | 独立限制 |
| test system | 不超过 750 / 5 分钟 | 测试环境 |

超限返回 HTTP 429。生产 adapter 不能把真实 email 写入持久 URL、日志、异常或 provenance；若将来采用 identified 流量，应由 secret/config 依赖在请求边界注入并脱敏。调用预算还要小于共享 Network policy 的总请求、并发和响应大小预算。

## 3. DOI metadata 接口

### 3.1 请求与查询

- `GET https://api.datacite.org/dois/{id}`：按 DOI 取单条记录；path 中 DOI 应规范化但不能错误地二次解码斜线或转义。
- `GET https://api.datacite.org/dois`：列表/搜索；`query` 支持全文或字段查询、wildcard 和布尔表达式，也可组合 `filter`、`sort`。
- 默认响应可能不展开 affiliation 和 publisher identifier 详情；官方要求显式加 `affiliation=true&publisher=true` 才返回包括 ROR 在内的详细对象。adapter 不能因默认响应只有字符串就猜 ROR。

DataCite 收录 dataset、software、text、collection、event 等通用研究资源，不等同于“学术文献库”。`types.resourceTypeGeneral` 和来源的具体类型必须先经过 SciRetriever 领域中立的文献适用性规则；title 或 DOI 的最低身份输入条件不等于所有 DOI 都应接纳为 Literature。

当前 adapter 对 `resourceTypeGeneral` 未命中受支持文献类型白名单的合法 DOI 记录返回空的中性
item，并使用稳定 Debug reason `datacite-resource-type-not-supported-as-literature`。它不是坏记录，
不计入 rejected，也不会把实际资源类型、标题或 vendor body 写入日志；Provider 汇总仍满足
`raw = accepted + empty + rejected`。字段类型错误、DOI 冲突或无法安全解析的记录才进入稳定
rejected 路径。

### 3.2 分页

- page-number 模式默认 `page[size]=25`，允许 0–1000；`page[number]` 从 1 开始，只能检索前 10,000 条。
- cursor 模式第一次传 `page[cursor]=1`；后续必须原样跟随顶层 `links.next`，不能对 cursor 自增或自行拼接。
- cursor 模式固定按创建时间升序；需要稳定增量边界时仍要保存查询、观察时间和 source record，不把 cursor 当业务标识。

列表顶层当前形状为：

```text
data[]
links {
  self
  next?
}
meta {
  total
  totalPages
  page?       # page-number 模式
}
```

## 4. DOI 记录字段

单条响应为 `data{type,id,attributes,relationships}`。当前公开 shape 的重要字段包括：

- 身份：`doi`、`identifiers[]`、`alternateIdentifiers[]`；
- 标题与责任者：`titles[]`、`creators[]`、`contributors[]`；creator 可含 `name`、`nameType`、`givenName`、`familyName`、`affiliation[]`、`nameIdentifiers[]`；
- 出版：`publisher`、`publicationYear`、`dates[]`、`language`、`version`；
- 容器：`container{type,identifier,identifierType,title,volume,issue,firstPage,lastPage}`；这是 REST API 的只读增强对象，不是顶层字段；
- 类型：`types{resourceTypeGeneral,resourceType,ris,bibtex,citeproc,schemaOrg}`；这些表示不同输出格式/分类，不应混成一个文献类型；
- 描述与主题：`descriptions[] {description,descriptionType}`、`subjects[]`；
- 关系：`relatedIdentifiers[]`，以及 JSON:API `relationships.references`、`citations`、`parts`、`partOf`、`versions`、`versionOf`；
- 访问/权利：`url`、`contentUrl`、`formats[]`、`sizes[]`、`rightsList[]`；
- 计数：`viewCount`、`downloadCount`、`referenceCount`、`citationCount`、`partCount`、`partOfCount`、`versionCount`、`versionOfCount`；当前 OpenAPI 说明这些值来自 Event Data；
- 管道信息：`source`、`state`、`isActive`、`created`、`registered`、`published`、`updated`、`schemaVersion`。

作者顺序按 `creators[]` 保持。当前 OpenAPI 的 `nameType` 枚举为 `Personal`、`Organizational`：前者可候选映射为 person author，后者可候选映射为 organization author，不能丢弃组织责任者，也不能把组织名硬拆为 given/family。`nameIdentifiers[]` 中 ORCID 可能带 `https://orcid.org/` wrapper，只有同一 creator 对象内明确对齐时才规范化为作者 ORCID。现场样本也显示来源可能把完整姓名放入 `familyName`；adapter 应保留 `name` 展示值，只在给定/姓氏确实可无歧义对齐时填结构化字段。affiliation/ROR 同理，不做名称推断。

`contributors[]` 具有 contributor type 等自己的责任语义，不自动并入 authors。只有具体 contributor role 在产品规则中被明确认定为该 Literature 的署名者且顺序含义可保留时，才考虑形成 Author；编辑、联系人、数据管理员等角色不能因有姓名字段就混入作者序列。

`subjects[]` 是来源主题词的通用容器，不能仅凭字段名全部写为 `MetadataObservation.declared_keywords`；只有上游语义明确为提交者声明关键词的值才是候选。DataCite 分类或推导主题不进入当前关键词合同。

## 5. 引用、版本与其它关系

`relatedIdentifiers[].relationType` 可以表达 `References`、`IsReferencedBy`、`IsCitedBy`、`Cites`、`IsVersionOf`、`IsPreviousVersionOf`、`IsPartOf` 等不同语义。它们必须按 relation type 分流，不能把所有 related DOI 都当引用：

- 明确 `References`/`Cites` 的 DOI 可形成 `citing=current -> cited=related` 的 `ProviderRelationObservation` 候选；
- 明确 `IsReferencedBy`/`IsCitedBy` 的 DOI 可形成 `citing=related -> cited=current` 的候选；
- `relationships.references`/`citations` 中逐个 DOI linkage 也可按同一方向形成独立 observation；
- `referenceCount`、`citationCount` 等计数不能反推任何边；
- version/part 关系不是引用。明确同一文献版本的供应商证据最多是 `MetadataObservation.version_links` 候选，仍由 Literature 的保守身份规则解释；数据集版本、软件版本或部分/整体关系不能自动收敛 Literature。

关系目标 DOI 存在不等于目标 Literature 已接纳，也不等于权威 `Reference` 已建立。若存在来源原始参考文献文本，应保留在 `reference_texts`；结构化 relation 不伪造原文。

## 6. 资产线索

`url` 通常是资源 landing page；`contentUrl`、media relationship 或 rights/format 信息可能提供更具体的 locator。它们只属于未来运行时解析或 metadata observation 的 `AssetHint` 候选：

- URL 非空不证明可访问、OA、许可适用或媒体类型；
- `rightsList` 是 DOI metadata 声明，不能自动传播成具体文件许可；
- `formats[]`/`sizes[]` 不证明某个 URL 与某种格式一一对应；
- `contentUrl` 也可能指数据文件、软件包或 HTML，不等于主 PDF；
- 实际获取仍要走 Network policy、redirect/origin 复核、有界读取、PDF bytes 校验、hash、lineage 与 immutable publish。

DataCite 没有专属 PDF protocol 或授权下载 API；当前 Acquisition 只通过通用 mapping 消费 Metadata observation 中明确保存的 locator，并重新执行 Network 与 PDF 验证。本 Notes 不授权从 DOI、resource type 或关系字段猜下载地址。

## 7. 代表性响应结构

2026-08-07 匿名单 DOI 请求的精简结构如下；示例特意保留 `Software`，用于说明 DataCite DOI 不能自动等同于 Literature：

```json
{
  "data": {
    "type": "dois",
    "id": "10.5281/zenodo.3727209",
    "attributes": {
      "doi": "10.5281/zenodo.3727209",
      "titles": [{"title": "Advanced Terrestrial Simulator (ATS) v0.88"}],
      "creators": [{
        "name": "Coon, Ethan",
        "nameType": "Personal",
        "givenName": "Ethan",
        "familyName": "Coon",
        "affiliation": ["Oak Ridge National Laboratory"],
        "nameIdentifiers": [{
          "nameIdentifierScheme": "ORCID",
          "nameIdentifier": "https://orcid.org/0000-0001-8124-9622"
        }]
      }],
      "publisher": "Zenodo",
      "publicationYear": 2020,
      "types": {"resourceTypeGeneral": "Software", "schemaOrg": "SoftwareSourceCode"},
      "descriptions": [{"descriptionType": "Abstract", "description": "..."}],
      "relatedIdentifiers": [{
        "relationType": "IsCitedBy",
        "relatedIdentifierType": "DOI",
        "relatedIdentifier": "10.5194/gmd-2019-265"
      }],
      "rightsList": [{"rightsIdentifier": "bsd-3-clause"}],
      "url": "https://zenodo.org/record/3727209",
      "contentUrl": null,
      "citationCount": 1
    },
    "relationships": {
      "citations": {"data": [{"id": "10.5194/gmd-2019-265", "type": "dois"}]},
      "versionOf": {"data": [{"id": "10.5281/zenodo.3727208", "type": "dois"}]}
    }
  }
}
```

列表搜索另观察到顶层 `data[]`、`links`、`meta`；没有复制完整 payload 或用户语料。

## 8. 与 SciRetriever 中性数据的候选映射

| 外部字段 | 外部语义 | 候选归属 | 约束 |
|---|---|---|---|
| `data.id` / `attributes.doi` | DataCite DOI source record | provenance/source record；`LiteratureMetadata.identifiers` | DOI 规范化，不代替本地 Literature ID |
| `titles[]` | 主标题/副标题/翻译标题等 | `LiteratureMetadata.title` | 按 title type 明确选择；不拼接未知类型 |
| `creators[]` | 有序责任者 | `LiteratureMetadata.authors` | `Personal`→person、`Organizational`→organization；contributors 不自动混入 |
| creator ORCID/affiliation | 对齐到 creator 的标识与单位 | `Author` 嵌套字段 | 仅明确值；请求详细对象后才候选 ROR |
| `descriptions[type=Abstract]` | 摘要 | `LiteratureMetadata.abstract` | 多摘要/语言选择需确定性规则 |
| publication/type/language fields | 年份、日期、类型、语言、publisher | `LiteratureMetadata` 对应字段 | 先确认是项目范围内文献；不混用不同 type vocabulary |
| `container.title` | 容器标题 | `LiteratureMetadata.venue` | 只读增强对象内取值；不从 publisher 或 URL 猜测 |
| `container.identifier` / `identifierType` | 容器标识及 namespace | 不进入当前业务 Model | 可供 adapter 内部容器辨识/核对；当前 `LiteratureMetadata` 没有 venue identifier，不能塞入文献 identifiers |
| `container.volume` / `issue` | 容器卷期 | `LiteratureMetadata.volume` / `issue` | 不与顶层资源 `version` 混用 |
| `container.firstPage` / `lastPage` | 容器内首页/末页 | `LiteratureMetadata.pages` | 两端均有值时确定性组成范围；单端按实际精度保留 |
| 明确来源声明的 keyword | 来源关键词 | `MetadataObservation.declared_keywords` | 普通 `subjects[]` 不自动等同 |
| reference/citation linkage | DOI 逐边关系 | `ProviderRelationObservation` | 每边独立、按 relation type 定方向 |
| `referenceCount` | 来源 outgoing reference 计数 | `MetadataObservation.reference_count` | Event Data 聚合；不能物化引用边 |
| `citationCount` | 来源 incoming citation 计数 | `MetadataObservation.cited_by_count` | Event Data 聚合；不能物化引用边或跨来源相加 |
| version relation | 外部版本连接 | `MetadataObservation.version_links` 候选 | 只在明确同文献且保守规则接纳时使用 |
| `url` / `contentUrl` / rights/media | locator 与来源声明 | `MetadataObservation.asset_hints` 候选 | landing/direct 分开；未下载、未验证 |
| `created`/`updated` 与请求时间 | 来源新鲜度 | provenance 候选输入 | 不作为 publication date |

## 9. 不进入业务 Model 的字段

- JSON:API page/cursor、`meta.totalPages` 和请求调试信息；
- view/download/part/version 等聚合计数（当前 Model 仅有明确接受的引用计数）；
- client/provider 账户关系、schema 管道状态和完整 vendor JSON；
- RIS/BibTeX/Citeproc/Schema.org 的并行 vendor 表示；
- API 认证材料、identified email、quota headers；
- 未经产品合同接受的 dataset/software 专属 schema。

## 10. 已知限制与待核对

- DataCite 是聚合/注册元数据，记录完整度、creator 姓名结构、relationship 覆盖与 locator 新鲜度依赖上游 deposit。
- affiliation/publisher identifier 默认不展开；当前 adapter 只请求合同所需详情并受响应大小预算约束，新增映射前仍须核对官方展开形状。
- `relatedIdentifiers` 与 JSON:API relationships 可能重复；去重必须保留单条 observation 的来源支持，不能静默丢 provenance。
- `subjects` 是否是提交者关键词取决于具体来源语义，通用判定规则尚无公开依据。
- 本轮没有下载 `contentUrl` 或任何文件，没有测试 Member API，也没有认证请求。

## 11. 当前实现边界

当前 `DataCiteAdapter` 实现 JSON:API 领域搜索、DOI lookup 和按明确 relation type 分流的引用查询，
解析分页、creator/ORCID/affiliation、标识符、版本/引用关系和资源 locator；生产 registry 注入共享
`HttpClient`、Access Coordinator 与 `datacite/api` policy。DataCite 收录不限于 Literature，adapter
仍在边界把不适用但合法的对象归为带稳定原因的中性 empty disposition，而不是静默丢弃或伪装
为 rejected。100-item 离线回归固定了 51 accepted、49 empty、0 rejected 的守恒计数与日志脱敏。
当前 Acquisition 只通过通用 Public route 消费已保存 locator，
DataCite DOI、`contentUrl` 或媒体声明都不等于已获得主 PDF。实现证据为离线 fake/fixture；本轮
没有认证请求、Member API 调用或文件下载。
