# Europe PMC

- 官方资料最后在线核对：2026-08-07
- 当前实现离线对照：2026-08-15
- schema v2 选择键：metadata `europe-pmc`；asset `europe-pmc`
- 供应商角色：生命科学元数据、references/citations 与开放全文线索
- 当前仓库接入状态：专用 Metadata REST adapter 与公开 PDF Source 均已进入生产 registry；两者共享 `europe-pmc/api` 准入范围

## 1. 官方入口与证据

- [RESTful Web Service](https://europepmc.org/RestfulWebService)：search、resultType、格式和能力总览。
- [Web Service Reference Guide（PDF）](https://europepmc.org/docs/EBI_Europe_PMC_Web_Service_Reference.pdf)：REST 模块、参数和响应字段参考。
- [Search syntax](https://europepmc.org/searchsyntax)：查询字段与布尔语法。
- [REST search endpoint](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=p53&format=json)：官方公开 endpoint/example。
- [Fields endpoint](https://www.ebi.ac.uk/europepmc/webservices/rest/fields)：当前可搜索字段。
- [Developers Forum](https://groups.google.com/a/ebi.ac.uk/g/epmc-webservices)：服务变更与问题渠道。

以上为 `official`，2026-08-07 核对。当天对 search、references、citations 和 fullTextXML
做了最小匿名只读核验；未下载 PDF 或 supplementary archive。

## 2. 认证、政策与限流

上述公开 REST endpoint 的最小请求无需 API key。官方 Web Service 页面本轮未发现明确、当前且可引用的固定 requests/s、并发数或日配额，因此记录为“未找到公开明确数值”，实现不得猜测。应使用可识别 User-Agent、连接复用、有界分页、缓存和指数退避；遇到 `429`/`5xx` 时按响应信息处理。

因为没有核实到官方固定数值，当前 Metadata 与 Acquisition 共享项目审慎政策：`max_concurrency = 1`、`min_start_interval = 1s`。标准 `Retry-After` 会更新同一共享 scope；无可用 header 的 `5xx` 也形成保守退避。1 秒间隔和无 header 退避均是项目安全值，不标记为 Europe PMC 官方额度。

Europe PMC 的开放全文能力只适用于相应收录与许可集合。元数据命中、`inEPMC=Y`、
`inPMC=Y`、`isOpenAccess=Y`、`hasPDF=Y` 是不同字段，不能互相替代。

## 3. 元数据接口

### 3.1 请求与分页

`GET https://www.ebi.ac.uk/europepmc/webservices/rest/search` 常用参数：

- `query`：必需；支持字段查询（如 `EXT_ID:`、`DOI:`、`PMCID:`）与布尔表达式；
- `resultType=idlist|lite|core`：默认 `lite`；`core` 才包含摘要、作者细节、全文 link、MeSH 等完整字段；
- `format=xml|json|dc`：默认 XML；DC 始终按 core 语义；
- `pageSize`：本页数量；
- `cursorMark`：首次 `*`，后续使用响应 `nextCursorMark`；
- `sort` 或 query 中 `sort_date:y` / `sort_cited:y`；
- `synonym=true|false`。

当前 JSON 顶层形状为：

```text
version
hitCount
nextCursorMark?          # 最后一页可省略或 null
request {
  queryString
  internalQuery?
  resultType
  cursorMark
  pageSize
  sort
  synonym
}
resultList { result[] }
```

`request` 和 cursor 是传输信息，不是文献事实。

### 3.2 core result 字段

单条 `result` 常见字段（不同 source/记录会缺失）包括：

- 标识：`id`、`source`、`pmid`、`pmcid`、`doi`、`fullTextIdList`；
- 标题与作者：`title`、`authorString`、`authorList.author[]`；author 可含
  `fullName`、`firstName`、`lastName`、`initials`、单个 `authorId{type,value}` 以及
  `authorAffiliationDetailsList.authorAffiliation[].affiliation`；
- `authorIdList.authorId[]` 是记录级作者 ID 汇总，不能仅凭位置重新分配给作者；优先使用
  author 内已明确对齐的 `authorId`；
- 出版：`journalInfo.issue`、`journalInfo.volume`、`journalInfo.dateOfPublication`、
  `journalInfo.printPublicationDate`、`journalInfo.journal{title,medlineAbbreviation,issn,essn,nlmid}`、
  `pubYear`、`pageInfo`、`firstPublicationDate`、`publicationStatus`、`pubModel`；
- 内容：`abstractText`（可含 inline markup）、`language`、`pubTypeList.pubType[]`、
  `keywordList.keyword[]`、`meshHeadingList`；
- 资产/访问：`fullTextUrlList.fullTextUrl[]`，每项有 `availability`、
  `availabilityCode`、`documentStyle`、`site`、`url`；另有 `isOpenAccess`、`inEPMC`、
  `inPMC`、`hasPDF`、`hasSuppl`；
- 引用：`citedByCount`、`hasReferences`；
- 索引/特征：`hasData`、`hasTextMinedTerms`、`dateOfCreation`、`firstIndexDate`、
  `dateOfRevision` 等。

`meshHeadingList` 是索引主题；`keywordList` 才是关键词候选，但仍需确认来源是否代表作者/记录声明，不能与 LLM 最终关键词混合。机构文本未携带 ROR；不得猜测。

## 4. 引用接口

### 4.1 References

`GET /europepmc/webservices/rest/{source}/{id}/references`，常用 `page`、`pageSize`、
`format`。JSON 顶层为 `version`、`hitCount`、`request{id,source,offSet,pageSize}`、
`referenceList.reference[]`。

reference 项可含 `id`、`source`、`citationType`、`title`、`authorString`、
`journalAbbreviation`、`pubYear`、`volume`、`issue`、`pageInfo`、`doi`、
`unstructuredInformation`、`citedOrder`、`match`、`issn`、`essn`。`match=Y` 且有
`id/source`，或条目有 DOI 时，提供稳定目标候选；`match=N` 但有 DOI 仍可用 DOI 定位。
`unstructuredInformation` 是原始/格式化 reference text 候选。结构化字段不完整且无稳定 ID
时只保留文本，不能物化目标。

### 4.2 Citations

`GET /europepmc/webservices/rest/{source}/{id}/citations` 使用同类分页参数。顶层为
`version`、`hitCount`、`request`、`citationList.citation[]`。citation 项通常带 citing record 的
`id`、`source` 及 metadata；方向必须规范化为 `citing -> 当前被查询记录`。

search core 的 `citedByCount` 只是来源时点计数，不能替代 citations 列表，也不与其它供应商计数相加。

## 5. PDF、全文与资产接口

- core `fullTextUrlList.fullTextUrl[]` 可返回 DOI landing page、Europe PMC HTML 和 PDF
  地址；`documentStyle=pdf` 是直接 PDF 线索，`html`/`doi` 是 landing/HTML 线索。
- `GET /europepmc/webservices/rest/{PMCID}/fullTextXML` 返回 JATS-like XML；本次匿名请求
  返回 `application/xml`。这是全文资产，不是 `LiteratureContent`。
- 官方 REST 还提供 open-access subset 的 supplementary file 能力；本轮没有下载 archive，
  其列表/压缩包精确响应形状在实现前需再按 Reference Guide 核对。

`availability=Open access`、`hasPDF=Y` 和 URL 都只是 observation/locator 事实。Acquisition
仍须验证最终 URL、redirect、媒体类型、字节和 PDF 结构。XML、HTML 和 supplementary 不能作为
primary PDF 接纳。

## 6. 代表性响应结构

2026-08-07 匿名请求
`search?query=PMCID:PMC7759461&resultType=core&format=json&pageSize=1` 的精简形状：

```json
{
  "version": "6.9",
  "hitCount": 1,
  "request": {"resultType": "CORE", "cursorMark": "*", "pageSize": 1},
  "resultList": {"result": [{
    "id": "32939066",
    "source": "MED",
    "pmid": "32939066",
    "pmcid": "PMC7759461",
    "doi": "10.1038/s41586-020-2649-2",
    "title": "Array programming with NumPy.",
    "authorList": {"author": [{
      "fullName": "Millman KJ",
      "firstName": "K Jarrod",
      "lastName": "Millman",
      "authorId": {"type": "ORCID", "value": "0000-0002-5263-5070"},
      "authorAffiliationDetailsList": {"authorAffiliation": [
        {"affiliation": "Brain Imaging Center, University of California, Berkeley, ..."}
      ]}
    }]},
    "journalInfo": {"issue": "7825", "volume": "585",
      "journal": {"title": "Nature", "issn": "0028-0836", "essn": "1476-4687"}},
    "pubYear": "2020",
    "pageInfo": "357-362",
    "fullTextUrlList": {"fullTextUrl": [
      {"availability": "Open access", "documentStyle": "html", "site": "Europe_PMC", "url": "https://europepmc.org/articles/PMC7759461"},
      {"availability": "Open access", "documentStyle": "pdf", "site": "Europe_PMC", "url": "https://europepmc.org/articles/PMC7759461?pdf=render"}
    ]},
    "isOpenAccess": "Y",
    "hasPDF": "Y",
    "hasSuppl": "Y",
    "citedByCount": 7572,
    "hasReferences": "Y"
  }]}
}
```

同日 references 请求返回 `referenceList.reference[]`；第一项有 `id/source/match=Y`，第二项
没有 Europe PMC ID 但有 DOI、`unstructuredInformation` 和 `match=N`，证明条目字段确实可选且不能按一种固定形状解包。

## 7. 与 SciRetriever 中性数据的候选映射

| 外部字段 | 外部语义 | 候选归属 | 备注 |
|---|---|---|---|
| `source` + `id` | Europe PMC 记录定位 | `Provenance.source_record_id` | source 必须保留，`MED:...` 与 `PMC:...` 语义不同 |
| `pmid`、`pmcid`、`doi` | 稳定标识符 | `LiteratureMetadata.identifiers` | 分别规范化 namespace |
| `title`、`abstractText`、`language` | 标题、摘要、语言 | `LiteratureMetadata` | abstract 清理 markup 时保持文本忠实 |
| `authorList.author[]` | 有序署名与逐作者信息 | `Author[]` | 只使用明确嵌套的 ORCID/单位；记录级 authorIdList 不猜对齐 |
| `journalInfo`、`pageInfo` | venue、卷期页、NLMID/ISSN | `LiteratureMetadata` 的 venue/volume/issue/pages | NLMID/ISSN 仅供 adapter 内部容器辨识/核对，不进入当前文献 identifiers |
| `pubYear` / `firstPublicationDate` | 年/首次出版日期 | `LiteratureMetadata.publication_year` / `LiteratureMetadata.publication_date` | 不把 index/revision date 当发表日期 |
| `pubTypeList` | 文献类型列表 | `document_type` | 需要显式映射和 precedence |
| `keywordList.keyword[]` | 来源关键词 | `MetadataObservation.declared_keywords` 候选 | 不使用 MeSH 自动代替 |
| reference `unstructuredInformation` | 参考文献原文 | `reference_texts` | 保持 citedOrder |
| references/citations 稳定 `source/id` 或 DOI | 有向引用目标 | `ProviderRelationObservation` | 每条边独立；方向规范化 |
| `citedByCount` / `hitCount` | 引用计数/接口总数 | `cited_by_count` / 不入业务 Model | references hitCount 可辅助 reference_count，但优先明确字段语义 |
| `fullTextUrl[]` | PDF/HTML/landing locator | `AssetHint[]` | 每个 URL 分开，保留 style、availability |
| 调用时间与输入 | 观察上下文 | `Provenance` | cursor/page 不持久化 |

## 8. 不进入业务 Model 的字段

- `version`、`request`、`cursorMark`、`nextCursorMark`、`offSet`、`pageSize`；
- 搜索相关度、内部 query、index/revision/completion timestamps；
- `hasTextMinedTerms`、`hasLabsLinks` 等站点功能 flag；
- MeSH、chemical、subset、grant 等本任务未授权扩展的 vendor 大字段；
- `match`、`citationType` 等关系解析辅助值，不另创业务字段；
- 原始 JSON/XML、HTTP response/client 对象。

## 9. 已知限制与待核对

- 覆盖集中于生命科学；跨领域零结果不能直接解释为服务故障。
- 未找到当前公开固定限流数值。
- 作者记录级 `authorIdList` 与逐作者对齐可能不完整；不得按列表位置猜测。
- supplementary endpoint 的当前列表/zip schema 本轮未做响应体核验，待实现时按官方 Reference Guide 复核。
- `fullTextXML` 与 PDF/HTML 可能具有不同版本或更新节奏，不能自动混为同一 asset。

## 10. 当前实现边界

`src/sciretriever/metadata/providers/europe_pmc/adapter.py` 已实现匿名 probe、topic search、稳定 lookup、cursor 分页以及双向 relation 查询，并把 core JSON 转换为中性 observation/relation；`src/sciretriever/acquisition/sources/europe_pmc.py` 只对明确 PMCID 查询 `resultType=core`，从 `fullTextUrlList` 中选择 `documentStyle=pdf` 的安全 HTTPS locator，再交给统一 `PublicLocatorFetcher`。

两条路径共用 `europe-pmc/api` scope 和上述项目审慎政策。当前 Acquisition 不把 `fullTextXML`、supplementary archive 或 `hasPDF` flag 当作已经取得的主 PDF，也没有 Europe PMC Browser 站点规则。本轮 2026-08-15 没有调用真实 endpoint、下载真实 PDF 或 supplementary archive；实现验证全部使用 fake transport、fixture 与可注入 clock，历史匿名核验仍以第 1 节记录的 2026-08-07 为准。
