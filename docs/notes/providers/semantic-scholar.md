# Semantic Scholar

- 官方资料最后在线核对：2026-08-07
- 当前实现离线对照：2026-08-15
- 当前选择键：Metadata `semantic-scholar`；Acquisition `semantic-scholar`；引用是 Metadata 的可选能力，不存在第三类 citation 选择键
- 供应商角色：Academic Graph 元数据、结构化 references/citations 与开放 PDF locator
- 当前仓库接入状态：Semantic Scholar Graph 专用 Metadata search/lookup/reference adapter 已进入生产 registry；`openAccessPdf` 只形成可由通用 Public route 复核的 `AssetHint`

## 1. 官方入口与证据

- [Semantic Scholar API](https://www.semanticscholar.org/product/api)：服务总览、认证和当前速率说明。
- [Academic Graph API docs](https://api.semanticscholar.org/api-docs/graph)：Redoc 规范。
- [Graph OpenAPI JSON](https://api.semanticscholar.org/graph/v1/swagger.json)：endpoint、参数和响应 schema。
- [API tutorial](https://www.semanticscholar.org/product/api/tutorial)：fields、分页、batch/bulk 和错误码。
- [API License Agreement](https://www.semanticscholar.org/product/api/license)：使用许可。
- [API status](https://status.api.semanticscholar.org/)：服务状态。

以上为 `official`，2026-08-07 核对。当天对 paper details、relevance search、references 和 citations
做了最小匿名只读核验，均未下载 PDF。

## 2. 认证、政策与限流

大部分 endpoint 可匿名调用；官方当前说明匿名用户共享 1000 requests/s 池，高负载时还会进一步
throttle。需要认证的 endpoint 或使用个人额度时，在大小写敏感的 `x-api-key` header 中提供 key。
新 key 的起始限流为所有 endpoint 合计 1 request/s；更高额度需审查。官方建议每个请求携带 key，
key 必须保密。

匿名共享池数值不是单调用方保证；实现应以 `429`、当前响应 header、服务状态和有界退避为准。
API License 是 at-will 服务边界，不应将其写成永久可用 SLA。

旧 Notes 记录一项 `support` 信息：用户曾于 2026-07-21 核实“key 连续 60 天不活跃会被移除”。
截至 2026-08-07，公开 API 页面、tutorial、OpenAPI 与 license 仍未找到该生命周期规则，因此只能保留为
非公开 support 事实，不能写成官方保证。旧 key 的具体值或状态不得读取或复制；本轮未使用任何 key。

## 3. 元数据接口

### 3.1 endpoint、fields 与分页

- `GET /graph/v1/paper/{paper_id}`：单条 paper；支持 S2 SHA、`CorpusId:`、`DOI:`、
  `ARXIV:`、`PMID:`、`PMCID:` 等官方列出的 ID 形式。
- `GET /graph/v1/paper/search`：relevance search，`query` 必需；用 `offset`、`limit` 分页。
- `GET /graph/v1/paper/search/bulk`：bulk search；初次不带 token，响应 `token` 时在下一请求传回。
- `POST /graph/v1/paper/batch`：批量按 ID 获取；请求体和最大数量以 OpenAPI 当前定义为准。
- 大多数 endpoint 使用 `fields=...` 显式选择字段；不请求的字段通常不会返回，不能把缺字段解释为
  供应商明确的空值。

relevance search 当前顶层为 `total`、`offset`、可选 `next`、`data[]`。bulk search 也有
`total` 和 `data[]`，但以可选 `token` 翻页；不能混用两套分页。details endpoint 直接返回 Paper
对象，不包 `data`。

### 3.2 Paper 字段

可请求的核心字段包括：

- `paperId`、`corpusId`、`externalIds`；
- `title`、`abstract`、`url`；
- `venue`、`publicationVenue{id,name,type,alternate_names,url}`、`journal{name,pages,volume}`；
- `year`、`publicationDate`、`publicationTypes[]`；
- `authors[]{authorId,name}`；
- `referenceCount`、`citationCount`、`influentialCitationCount`；
- `isOpenAccess`、`openAccessPdf{url,status,license,disclaimer}`；
- `fieldsOfStudy[]`、`s2FieldsOfStudy[]`；
- embeddings、tldr 等可选派生数据（不在 SciRetriever 当前业务映射范围）。

paper authors 只给 Semantic Scholar author ID 与展示名；Paper schema 不提供逐作者 given/family、ORCID、
逐作者 affiliation 或 ROR。Author endpoint 的独立档案也不能靠 authorId 反向建立 SciRetriever 全局
Author；当前产品只保存文献内明确署名。

`externalIds` 的 key 大小写与 namespace 是 vendor 值，如 `DOI`、`ArXiv`、`PubMed`、
`PubMedCentral`、`CorpusId`、`MAG`、`DBLP`；adapter 必须使用显式允许映射，不把所有 key 无条件
写成中性 identifier。

## 4. 引用接口

- `GET /paper/{paper_id}/references`：当前 paper 引用的 papers。
- `GET /paper/{paper_id}/citations`：引用当前 paper 的 papers。
- 两者用 `offset`（默认 0）和 `limit`（默认 100、当前最大 1000）；响应含 `offset`、可选 `next`、
  `data[]`。

reference 项的嵌套目标是 `citedPaper{...}`；citation 项的嵌套来源是 `citingPaper{...}`。
根据 `fields`，edge 项还可带 `contexts[]`、`intents[]`、`isInfluential`。OpenAPI 官方示例明确说明
paper 字段与 edge 字段共用 `fields` 参数，例如 `fields=contexts,isInfluential,abstract`。

`paperId`/稳定 external ID 可以形成逐边 `ProviderRelationObservation`；references 方向为
`current -> citedPaper`，citations 方向为 `citingPaper -> current`。`contexts` 是 S2 提取的引用上下文，
不是原始 bibliography reference text；不能自动写入 `MetadataObservation.reference_texts`。
`referenceCount`、`citationCount` 与 `influentialCitationCount` 只是来源计数/派生指标，不能反推边。

## 5. PDF、全文与资产线索

`openAccessPdf` 可含：

- `url`：PDF 或来源页面地址候选；
- `status`：如本次样例的 `HYBRID`；
- `license`：如 `CCBY`；
- `disclaimer`：提示调用方回到来源核实许可与版权。

`isOpenAccess=true` 和 `openAccessPdf.url` 都是聚合 observation。即使 URL 看似 `.pdf`，也必须按
Network/Acquisition 重新检查 redirect、媒体类型、字节、PDF 结构和目标归属。disclaimer 不能丢弃，
但它是 vendor 提示，不应直接复制成业务许可字段或用户合同。Graph API 不提供主文/补充材料清单、
结构化全文 XML/HTML 或保证 URL 永久有效。

## 6. 代表性响应结构

2026-08-07 匿名 relevance search：

```json
{
  "total": 7813039,
  "offset": 0,
  "next": 1,
  "data": [{
    "paperId": "024a2c03be8e468e7c4fdf9bda36cdc0eaae85fb",
    "corpusId": 219792763,
    "externalIds": {
      "DOI": "10.1038/s41586-020-2649-2",
      "ArXiv": "2006.10256",
      "PubMed": "32939066",
      "PubMedCentral": "7759461"
    },
    "title": "Array programming with NumPy",
    "venue": "Nature",
    "year": 2020,
    "publicationDate": "2020-06-18",
    "journal": {"name": "Nature", "pages": "357 - 362", "volume": "585"},
    "authors": [{"authorId": "2061249", "name": "K. Millman"}],
    "referenceCount": 89,
    "citationCount": 21570,
    "isOpenAccess": true,
    "openAccessPdf": {
      "url": "https://www.nature.com/articles/s41586-020-2649-2.pdf",
      "status": "HYBRID",
      "license": "CCBY",
      "disclaimer": "Notice: Paper or abstract available at ..."
    }
  }]
}
```

同日 references 请求的精简形状：

```json
{
  "offset": 0,
  "next": 1,
  "data": [{
    "citedPaper": {
      "paperId": "8d7f03c75bdb21d9a981cde8ae6a8359be2a67f8",
      "externalIds": {"DOI": "10.1109/MCSE.2021.3059232"},
      "title": "Reproducing GW150914: ...",
      "year": 2020
    }
  }]
}
```

本次 references 响应还出现 `citingPaperInfo`，而 OpenAPI 的稳定批次 schema 重点是
`offset/next/data[].citedPaper`。实现必须允许官方 schema 中可选新增字段但不把未建模扩展穿透业务层。

## 7. 与 SciRetriever 中性数据的候选映射

| 外部字段 | 外部语义 | 候选归属 | 备注 |
|---|---|---|---|
| `paperId` | S2 paper 主 ID | `Provenance.source_record_id` | provider ID，不是本地 Literature ID |
| `externalIds` 白名单项 | DOI/arXiv/PMID/PMCID 等 | `LiteratureMetadata.identifiers` | 显式 namespace 映射；CorpusId/MAG/DBLP 是否保留按当前 identifier 合同决定 |
| `title`、`abstract` | 标题、摘要 | `LiteratureMetadata` | fields 未请求与 null 要区分 |
| `publicationTypes` | S2 类型列表 | `document_type` | 需显式映射与 precedence |
| `publicationDate` / `year` | 出版日期/年 | `LiteratureMetadata.publication_date` / `LiteratureMetadata.publication_year` | 日期可能与正式版/预印本日期不同，保留来源差异 |
| `venue` / `publicationVenue` / `journal` | venue、卷页 | `venue`、`volume`、`pages` | 多表示有重叠，adapter 需固定规则 |
| `authors[]` | 有序展示署名 | `Author.display_name` | authorId 不建全局 Author，不拆 name，不猜 ORCID/单位 |
| reference/citation `paperId`/external ID | 结构化有向边端点 | `ProviderRelationObservation` | 每条 edge 独立、方向规范化 |
| `referenceCount` / `citationCount` | 来源计数 | observation 计数字段 | 不与 edge 列表长度或其它来源相加 |
| `openAccessPdf` | OA PDF locator、status/license | `AssetHint` | URL 是线索；status/license 只描述该访问渠道 |
| API 调用和时间 | 来源观察 | `Provenance` | `fields`、offset/next 不持久化 |

`fieldsOfStudy`、`s2FieldsOfStudy` 和 tldr 等是分类/派生数据，不候选映射为
`declared_keywords`、最终 `keywords` 或 `LiteratureContent`。

## 8. 不进入业务 Model 的字段

- offset、next、token、total、fields、search relevance；
- Semantic Scholar authorId、CorpusId 的分析图身份和内部评分；
- `influentialCitationCount`、`isInfluential`、intents、contexts 等派生分析值；
- fields-of-study、S2 topic、embedding、TLDR；
- `openAccessPdf.disclaimer` 的完整 vendor 文案（可作为适配边界诊断/来源提醒，不复制成 license）；
- HTTP response、API key、quota header 和完整 vendor JSON。

## 9. 已知限制与待核对

- 匿名池共享且会动态 throttle；成功匿名请求不构成稳定容量。
- 60 天不活跃 key 规则没有公开官方依据，仍为 `support` 待核对。
- Paper author 数据不含 ORCID/affiliation/ROR，不能通过另一个 author profile 猜回文献内对齐。
- search 与 details 的 `referenceCount` 在同日对同一 paper 可出现差异（本轮分别观察到 89 和 91），
  表明计数会更新或因 endpoint/view 不同；必须保留 observed_at，不能当强一致值。
- references/citations 的覆盖与 context 提取不是原文 bibliography 的完整性保证。
- 本轮未请求 PDF；OA/license 必须到来源复核。

## 10. 当前实现边界

当前 `SemanticScholarAdapter` 通过 Graph API 实现领域搜索、稳定 paper lookup、references 与
citations，显式解析请求 fields、分页、Paper/author/externalIds、引用方向和 `openAccessPdf`；
生产 registry 为它注入共享 `HttpClient`、Access Coordinator、`semantic-scholar/api` policy 与
可选 API key。OA locator 进入 `AssetHint` 后仍由 Acquisition 通用 Public route 重新做 URL、
redirect、媒体类型、实际 PDF 字节和归属验证。当前证据为离线 fake/fixture；2026-07-21 的旧 key
事件不证明当前凭据、容量、单篇 locator 或 entitlement，本轮也没有访问 API/PDF。
