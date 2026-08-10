# Crossref

- 最后核对：2026-08-07
- schema v2 选择键：metadata `crossref`；asset `crossref`
- 供应商角色：DOI 注册元数据、来源参考文献、引用计数与 TDM 资产线索
- 当前仓库接入状态：只有选择键、通用 Protocol/adapter 和 lazy registry；没有 Crossref 专用生产 client，registry 未连接到当前 Collection 或 Assets Service

## 1. 官方入口与证据

- [REST API 总览](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)：endpoint、JSON 返回和能力概述。
- [Access and authentication](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/)：匿名、polite、Metadata Plus、限流和并发。
- [REST API filters](https://www.crossref.org/documentation/retrieve-metadata/rest-api/rest-api-filters/)：works filters。
- [REST API Swagger](https://api.crossref.org/swagger-ui/index.html)：参数与响应 schema。
- [References metadata](https://www.crossref.org/documentation/principles-practices/best-practices/references/)：成员登记参考文献的来源语义。
- [Accessing full texts](https://www.crossref.org/documentation/retrieve-metadata/xml-api/accessing-full-texts/) 与
  [Text and data mining](https://www.crossref.org/documentation/retrieve-metadata/text-and-data-mining/)：登记资源 link 与访问边界。

以上为 `official`，2026-08-07 核对。`Access and authentication` 页面标注最后更新 2025-10-16。另于 2026-08-07 对一个公开 DOI 做了匿名只读 JSON 请求；未访问返回的 PDF URL。

## 2. 认证、政策与限流

REST API 公开池无需注册。polite 池通过 `mailto` query 或 agent header 标识调用方；官方建议同时提供可识别的 `User-Agent`。Metadata Plus 使用付费 token header。

官方当前列出的限制为：

| 池 | 速率 | 并发 |
|---|---:|---:|
| Public | 5 requests/s | 1 |
| Polite | 10 requests/s | 3 |
| Plus | 150 requests/s | 页面标为 None |

实际响应还会通过 `x-rate-limit-limit`、`x-rate-limit-interval` 和
`x-concurrency-limit` header 给出当前值。超限返回 `429`；人工 block 可能返回 `403`。
实现应以响应 header 和 `Retry-After`/退避为准，不能把表格数值复制成永不变化的 SLA。

## 3. 元数据接口

### 3.1 endpoint 与查询

- `GET https://api.crossref.org/works/{doi}`：单条 Crossref work；DOI path 必须正确编码。
- `GET https://api.crossref.org/works`：works 列表；支持 `query`、字段查询、`filter`、`select`、`sort`、`order`、`sample`、`rows` 等参数。
- `/members/{id}/works`、`/prefixes/{prefix}/works`、`/journals/{issn}/works`、
  `/funders/{id}/works`、`/types/{id}/works`：在限定集合中返回相同 work 形状。

普通浅分页使用 `offset` + `rows`；大结果遍历应使用 `cursor=*`，随后把响应
`message.next-cursor` 原样 URL 编码后传回。`rows=0` 可只取计数。cursor、offset、rows
是传输控制，不是文献事实。

### 3.2 响应层级

单 work 顶层为：

```text
status
message-type = "work"
message-version
message = { ...work... }
```

works 列表顶层同样有 `status`、`message-type`、`message-version`，但 `message` 包含
`total-results`、`items-per-page`、`query`、可选 `next-cursor`、`items[]` 和可选 `facets`。

单条 work 常见字段（均可能按登记完整度缺失）包括：

- `DOI`、`URL`、`prefix`、`member`、`type`、`subtype`；
- `title[]`、`subtitle[]`、`short-title[]`、`abstract`（常为 JATS 片段）；
- `author[]` / `editor[]`：`given`、`family`、`name`、`sequence`、可选 `ORCID`、
  `authenticated-orcid`、`affiliation[].name`；Crossref 可接收 ROR，但实际 API 字段形状需逐记录验证，不能按单位名补 ROR；
- `container-title[]`、`short-container-title[]`、`publisher`、`institution[]`、
  `volume`、`issue`、`page`、`article-number`、`ISSN[]`、`ISBN[]`；
- 多组日期：`published`、`published-print`、`published-online`、`issued`、`created`、
  `deposited`、`indexed`，其 `date-parts` 精度可只有年或年月；
- `language`、`subject[]`、`license[]`、`link[]`、`resource.primary.URL`；
- `reference-count`、`is-referenced-by-count`、`reference[]`；
- `relation`、`update-to[]`、`updated-by[]` 等非引用关系字段。

`subject[]` 是 Crossref 分类/主题元数据，不应自动当作者声明关键词。`article-number`
候选映射到 SciRetriever 现有 `pages`，不新增平行模型字段。日期必须按外部语义选择，不能简单取第一个存在值。

## 4. 引用接口与字段

Crossref work 的 `reference[]` 来自成员或可信来源登记，条目可含：

- `key`；
- `DOI` 和 `doi-asserted-by`；
- `unstructured`；
- `article-title`、`author`、`year`、`journal-title`、`volume`、`issue`、
  `first-page`、`volume-title`、`edition-number` 等不完整结构字段。

当一项 reference 有稳定 DOI 时，可候选转换为逐边 `ProviderRelationObservation`；同一项
`unstructured` 若存在，则仍可作为 `MetadataObservation.reference_texts` 的来源原文。
只有 `unstructured` 或残缺书目信息时不能建立结构化目标边。

`reference-count` 是登记参考文献计数，`is-referenced-by-count` 是 Crossref Cited-by
计数。公开 REST work 记录不内联“哪些作品引用了本作品”的完整 ID 列表；要找 citing works
通常依赖 Crossref Cited-by/查询能力与成员登记覆盖，不能从计数反推边。`relation`、Crossmark
update 或 correction 也不是引用关系，更不能误入 `version_links`。

## 5. PDF、全文与资产线索

`link[]` 每项可含 `URL`、`content-type`、`content-version` 和 `intended-application`。
`content-type=application/pdf` 是直接文件线索；`text/html` 是页面/HTML 线索；
`content-version` 常见 `vor` 或 `am`，`intended-application` 可为 `text-mining` 或
`similarity-checking`。`resource.primary.URL` 和顶层 `URL` 通常是 DOI/落地页线索。

Crossref 只传播成员登记的 link 与 license metadata：有 link 不证明匿名可下载，不证明响应
仍是 PDF，也不单独证明调用方具有访问授权。`license[].URL`、`start`、
`content-version` 和 `delay-in-days` 描述登记的许可元数据；候选映射时必须保持来源与观察时间。
主文 PDF、accepted manuscript 和其它版本不能仅按 URL 文件名猜测。

## 6. 代表性响应结构

以下为 2026-08-07 对
`GET https://api.crossref.org/works/10.1038%2Fs41586-020-2649-2`
的匿名只读响应精简形状：

```json
{
  "status": "ok",
  "message-type": "work",
  "message": {
    "DOI": "10.1038/s41586-020-2649-2",
    "type": "journal-article",
    "title": ["Array programming with NumPy"],
    "author": [
      {
        "given": "K. Jarrod",
        "family": "Millman",
        "sequence": "additional",
        "ORCID": "https://orcid.org/0000-0002-5263-5070",
        "authenticated-orcid": false,
        "affiliation": []
      }
    ],
    "container-title": ["Nature"],
    "issued": {"date-parts": [[2020, 9, 16]]},
    "link": [{
      "URL": "https://www.nature.com/articles/s41586-020-2649-2.pdf",
      "content-type": "application/pdf",
      "content-version": "vor",
      "intended-application": "text-mining"
    }],
    "license": [{
      "content-version": "vor",
      "delay-in-days": 0,
      "URL": "https://creativecommons.org/licenses/by/4.0"
    }],
    "reference": [{
      "key": "2649_CR1",
      "DOI": "10.1103/PhysRevLett.116.061102",
      "unstructured": "Abbott, B. P. et al. ... (2016).",
      "year": "2016"
    }],
    "reference-count": 57,
    "is-referenced-by-count": 23441
  }
}
```

本例说明 `title`、`container-title` 是数组，日期是嵌套 `date-parts`，作者 ORCID 与单位是
作者项内部字段，link/license/reference 也是对象数组；实现不能把它们按扁平字符串解析。

## 7. 与 SciRetriever 中性数据的候选映射

| 外部字段 | 外部语义 | 候选归属 | 备注 |
|---|---|---|---|
| `DOI` | Crossref work DOI | `LiteratureMetadata.identifiers` | namespace `doi`；同时保留 Crossref record identity |
| `title[0]` | 主标题 | `LiteratureMetadata.title` | 多标题/翻译的选择待 provider 规则明确，不静默拼接 |
| `abstract` | 登记摘要，可能为 JATS | `LiteratureMetadata.abstract` | 在 adapter 边界安全提取文本 |
| `type` / `subtype` | Crossref 内容类型 | `LiteratureMetadata.document_type` | 需要显式映射表；未知值不猜 |
| `author[]` | 有序贡献者 | `Author[]` | 保留顺序、明确姓名组成、ORCID 和逐作者 affiliation；`authenticated-orcid` 是来源质量信息，不是另一个 ID |
| `container-title[]` | 期刊/会议/书名 | `LiteratureMetadata.venue` | 按 work type 解释 |
| `publisher` | 登记出版社 | `LiteratureMetadata.publisher` | 可缺失 |
| `volume`、`issue`、`page` / `article-number` | 卷期页/文章号 | 对应 `volume`、`issue`、`pages` | article number 进入现有 `pages` |
| `published*` / `issued` | 多种出版日期 | `LiteratureMetadata.publication_date` / `LiteratureMetadata.publication_year` | 按明确 precedence 选择并保留来源 observation |
| `subject[]` | Crossref subject | 暂无业务字段 | 不自动写 `declared_keywords` 或最终 `keywords` |
| `reference[].unstructured` | 登记的参考文献原文 | `MetadataObservation.reference_texts` | 保持条目顺序；缺 DOI 也保留原文 |
| 有 DOI 的 `reference[]` | 结构化 citing→cited 线索 | `ProviderRelationObservation` | 当前 work 是 citing 端，reference DOI 是 cited 端 |
| 两类计数 | 来源时点的计数 | `reference_count` / `cited_by_count` | 不跨供应商相加 |
| `link[]` | 资源地址与声明媒体/版本 | `AssetHint[]` | 每个地址独立形成线索，不覆盖 |
| `license[]` | 登记许可范围与生效信息 | `AssetHint.license` 的候选来源 | 需与相应 content-version/URL 对齐，不能全局套用 |
| work `URL` / `resource.primary.URL` | DOI/主资源 landing page | `AssetHint` | landing page，不是已获得资产 |
| Crossref source、member、观察时间 | 来源上下文 | `Provenance` | member ID 不是 Literature ID |

## 8. 不进入业务 Model 的字段

- `status`、`message-type`、`message-version`；
- `indexed`、`deposited`、`created` 等 Crossref 管道时间，除非作为 provenance 内部输入；
- `score`、query 结构、facets、cursor、offset、rows；
- `prefix`、`member` 的传输/组织内部 ID（可用于来源诊断，不是文献标识）；
- `authenticated-orcid`、`doi-asserted-by` 等 vendor 质量标志，不另创业务字段；
- 完整原始 JSON、HTTP headers、rate-limit headers 和 client 对象；
- correction、retraction、update、relation 等当前产品边界外关系。

## 9. 已知限制与待核对

- Crossref metadata 由成员/可信来源登记，字段覆盖和准确度不均；缺失不代表文献本身没有该事实。
- ROR 在 REST 作者/单位对象中的当前精确嵌套形状，本轮未找到一个足够小且稳定的官方响应样例，需在实现具体映射前按官方 Swagger/example 再核对；不得根据 affiliation name 猜 ROR。
- cursor 的失效/持久期限未找到公开稳定保证；只应在一次有界调用内使用。
- `link` 可用性与授权逐资源变化，未匿名访问本例 PDF。
- cited-by 边的公开检索完整性取决于成员参与和登记覆盖，不能把计数当完整图谱。

## 10. 当前实现边界

当前配置接受 `crossref` metadata/asset 选择键，registry 只在调用方注入同名
`MetadataClient` / `ResolverClient` 后构造通用 adapter。仓库没有 REST endpoint、query/filter、
cursor、polite identity、JSON 嵌套字段、reference/link/license 转换的供应商代码；通用
`VendorMetadataRecord` 也只含 title、作者字符串、年份、标识符和摘要，远未实现本文候选映射。
测试使用 fake client，只证明通用 adapter 与 lazy failure，不证明 Crossref 生产接入。
