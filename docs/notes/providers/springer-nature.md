# Springer Nature

- 官方资料最后在线核对：2026-08-07
- 当前实现离线对照：2026-08-15
- schema v2 选择键：metadata `springer`；asset `springer`
- 供应商角色：Springer Nature 元数据，以及 OA/协议授权的 JATS/XML 全文和资产 locator
- 当前仓库接入状态：Meta API v2 专用 Metadata adapter 已进入生产 registry；Springer 授权主 PDF route 仍明确标记为 unsupported

## 1. 官方入口与证据

- [Springer Nature Developer Portal](https://dev.springernature.com/)：账户、产品与 API 管理入口。
- [Authentication](https://dev.springernature.com/docs/quick-start/authentication)：API key 要求。
- [Meta API](https://dev.springernature.com/docs/api-endpoints/meta-api)：`/meta/v1`、`/meta/v2` 与 JSON 样例。
- [Metadata API](https://dev.springernature.com/docs/api-endpoints/metadata-api)：`/metadata` 入口与 JSON 样例。
- [Open Access API](https://dev.springernature.com/docs/api-endpoints/open-access)：OA metadata 与 JATS 全文。
- [Full Text API](https://dev.springernature.com/docs/api-endpoints/fulltext-api)：协议授权的 JATS/XML TDM 全文。
- [Full Text endpoint migration](https://dev.springernature.com/docs/full-text-api-migration-guide)：2026-08-07 主机迁移截止。
- [REST operations and formats](https://dev.springernature.com/docs/quick-start/restful-ops-and-response-formats)：collection 与 `pam`/`jats`/`BITS`/`json`/`jsonp` 格式。
- [Pagination and limits](https://dev.springernature.com/docs/advanced-querying/pagination-limits)：`s`/`p` 与单页上限。
- [Rate limits](https://dev.springernature.com/docs/rate-limit-details/rate-limits)：基础/高级计划的分钟和每日额度。

均为 `official`，2026-08-07 核对。官方文档页面可匿名读取；实际 API 要求 key，本轮没有读取本地凭据，也没有向 API 发出认证请求。

## 2. 认证、计划与限流

所有当前文档化 endpoint 都要求账户 API key。JSON 示例以 `api_key=...` query 展示；Full Text 示例还包含从 API Management 取得的 API metric。key/metric 会进入 URL，生产 transport 必须在日志、异常、trace、provenance 和 redirect 处理中脱敏，不能持久化完整请求 URL。

官方当前基础与 Premium 计划额度：

| API | Basic requests/min | Basic requests/day | Premium requests/min | Premium requests/day |
|---|---:|---:|---:|---:|
| Metadata API | 100 | 500 | 300 | 10,000 |
| Meta API v1/v2 | 100 | 500 | 300 | 10,000 |
| Open Access API | 100 | 500 | 200 | 10,000 |
| Full Text API | 200 | 500 | 200 | 20,000 |

Full Text Premium 取决于具体 agreement，其它 Premium 也需联系销售/支持。这些是供应商账户上限，不是建议把应用并发开到同值；SciRetriever 仍需自己的资源预算和有界并发。官方 throttle 页面以 HTTP 429 表示 rate limit/daily quota，并建议 exponential backoff。

当前 `springer/api/meta-v2` 基线只按 Basic Meta v2 合同运行：单并发、0.6 秒 start interval（100/min）以及 500 次/24 小时 rolling window。rolling window 比依赖未知账户重置时刻更保守；不会因配置了 Premium key 就自行放宽。标准 `Retry-After` 与 `X-RateLimit-Remaining` / `RateLimit-Remaining` 会收紧共享 scope，无 header 的 429/5xx 使用保守退避。当前公开材料不足以确定 `RateLimit-Reset` 在所有部署中的稳定单位和时钟语义，因此实现不会猜测并转换为正式 deadline。

## 3. 查询、分页与响应顶层

查询参数 `q` 使用字段约束，例如 `doi:`、`keyword:`、`title:`、`year:`、`issn:`、
`isbn:`、`orcid:`、`openaccess:true` 等；具体适用 collection 由官方参数表标记。不要把全文 search、精确 DOI 和 metadata filter 当同一召回语义。

分页使用：

- `s`：起始结果号；官方示例从 1 起；
- `p`：本次返回数量；未给 `s`/`p` 时从首项开始且每页 10 条；
- 单次 `p` 当前上限：Metadata/Meta Basic 25、Premium 100；Open Access Basic/Premium 都是 20；Full Text Basic 10、Premium 20。

JSON metadata/OA 样例共有顶层：

```text
apiMessage
query
result[] {
  total
  start
  pageLength
  recordsDisplayed
}
records[]
```

`result[]` 是查询/pagination summary，不是文献记录。`total`、`start`、`pageLength` 和
`recordsDisplayed` 在示例中是字符串，adapter 应显式验证/转换；业务 Model 不保存查询 echo 或页码。

## 4. 元数据产品与字段

### 4.1 Meta API v1/v2

```text
GET https://api.springernature.com/meta/v2/json?api_key={key}&q={query}
```

官方把 `/meta/v1` 描述为 foundational/basic metadata，`/meta/v2` 描述为附加字段和优化查询的 enhanced/versioned metadata。两者覆盖 articles、chapters、protocols 等；同一 adapter 需把版本写入 provenance/adapter revision，而不是把 vendor API version 混成 LiteratureContent schema version。

### 4.2 Metadata API

官方示例：

```text
GET https://api.springernature.com/metadata/v1/articles?api_key={key}&q=doi:{doi}
```

该产品提供 foundational metadata。当前门户同时保留 Meta v1/v2 与 Metadata API 页面；实现不能只凭名称猜它们完全等价，应按选定 endpoint 的实际 schema 做契约测试。

### 4.3 records 字段

端点页面的短样例显示 `records[]` 至少可包含：

```text
title
doi
abstract
publicationDate
journalTitle
```

Quick Start 的较完整 Meta v2 样例还展示：

```text
contentType
identifier
url[] { format, platform, value }
title
creators[] { creator }
publicationName
openaccess
publisher
publicationDate / year
language
subjects[]
```

字段集会随 endpoint、format、document type 和计划变化。`identifier` 可能带 namespace wrapper；
`creators[]` 是作者字符串而非完整 authorship；`subjects[]` 可能是供应商分类，不应自动当作者声明关键词；`openaccess` 在官方样例中是字符串而不是布尔值。

## 5. 引用能力

当前 Springer Nature provider 选择键不含 citation。官方本轮核对的 Meta/Metadata/OA/Full Text 页面也没有给出逐条 citing/cited work 图 API。因此：

- 不从结果数量或文章字段推导引用边；
- JATS `<ref-list>` 若随全文返回，只是 parser 输入；由后续 Analysis 解析文本参考文献和临时 lookup，不能由 provider adapter 直接建立权威 `Reference`；
- 如果将来要加入 Springer Nature citation expansion，需有官方逐边依据并先更新配置合同、责任文档和测试。

## 6. OA、全文与资产线索

### 6.1 Open Access API

- `/openaccess/json`：获取 OA articles 的 metadata；
- `/openaccess/jats`：在可用时获取 OA articles/chapters 的 JATS 全文。

OA API 的 JATS 是结构化全文，不是 PDF。它可以是未来 parser 的外部输入，但当前 Acquisition 的主资产公开结果仍是 PDF；不能仅因内容完整就把 XML 冒充主 PDF。

### 6.2 Full Text API

当前示例：

```text
GET https://api.springernature.com/xmldata/jats?q={query}&api_key={key}/{api_metric}
```

当前官方示例把 API metric 以 `/` 拼在 `api_key` 值之后，而不是另设
`api_metric` 参数。实际参数拼接仍以 API Management 为准；本文不保存真实 key 或 metric。响应示例顶层为 XML：

```xml
<response>
  <apiMessage>...</apiMessage>
  <query>year:2018</query>
  <records>
    <book-part-wrapper dtd-version="2.0" xml:lang="...">...</book-part-wrapper>
  </records>
</response>
```

内容“where available”，并明确依赖 special agreement。JATS/BITS article/book 结构要经过中性 parser 转换，vendor XML 类型不能穿透 Model。

### 6.3 2026-08-07 endpoint 迁移

官方迁移指南要求在 2026-08-07 前把 Full Text 主机从旧
`spdi.public.springernature.app` 改为 `api.springernature.com`，路径 `/xmldata/jats`、key、metric、query 和响应结构保持不变；旧主机按计划在 2026-08-07 下线。当前实现应只采用新主机。本轮没有 key，未实测新旧 endpoint 状态，因此“旧主机已实际不可达”仍未验证。

### 6.4 URL/PDF locator

Meta v2 Quick Start 样例的 `url[]` 含 `format=html`、`format=pdf` 等项，并展示 legacy
`http://link.springer.com/openurl/...` 值。这证明 metadata 可携带不同格式的 locator，但不证明：

- URL 当前可访问或最终媒体类型正确；
- 非 OA 内容已授权；
- HTTP locator 符合 SciRetriever 的安全 HTTPS 边界；
- `pdf` format 可以跳过 PDF 基本检查。

adapter 应保留每个安全 HTTPS 候选的 format/platform/provenance；legacy HTTP 值不能直接成为资产请求。是否允许通过受控 HTTPS canonicalization 得到新 locator，需以 Network policy 和直接测试证明，不能简单字符串替换。

## 7. 代表性 JSON 结构

基于当前官方 endpoint 与 Quick Start 样例的精简形状：

```json
{
  "apiMessage": "This JSON was provided by Springer Nature",
  "query": "doi:...",
  "result": [{
    "total": "1",
    "start": "1",
    "pageLength": "10",
    "recordsDisplayed": "1"
  }],
  "records": [{
    "contentType": "Chapter",
    "identifier": "doi:...",
    "url": [
      {"format": "html", "platform": "web", "value": "http://..."},
      {"format": "pdf", "platform": "web", "value": "http://..."}
    ],
    "title": "...",
    "creators": [{"creator": "..."}],
    "publicationName": "...",
    "openaccess": "false",
    "publisher": "Springer ..."
  }]
}
```

这是公开文档样例层级，不是本轮带 key 的现场响应。

## 8. 与 SciRetriever 中性数据的候选映射

| 外部字段 | 外部语义 | 候选归属 | 备注 |
|---|---|---|---|
| `identifier` / `doi` | provider record ID 与 DOI | provenance / `LiteratureMetadata.identifiers` | 拆除 namespace wrapper 后规范化 |
| `title` / `abstract` | 标题与摘要 | `LiteratureMetadata` | 不从 JATS 重复写 metadata owner |
| `creators[]` | 有序作者字符串 | `LiteratureMetadata.authors` 候选 | observation 组合中性 metadata；不猜 ORCID、affiliation 或全局作者 |
| publication/journal/publisher/date/year/language | 出版信息 | `LiteratureMetadata` | 区分明确日期语义；document type 显式映射 |
| 明确声明的 keyword 字段 | 作者/记录关键词 | `declared_keywords` 候选 | `subjects[]` 未证明为声明关键词时不混入 |
| `url[]` | format/platform locator | `AssetHint[]` | 仅安全 HTTPS；一个 URL 一个候选；PDF 仍需实取验证 |
| OA/JATS/Full Text response | 访问与结构化全文观察 | provenance / parser 输入 | 不把 XML 作为 PDF，也不直接形成 LiteratureContent |
| 实际调用时间、API 产品与版本 | 来源上下文 | `Provenance` 候选输入 | key、metric 与 query echo 不保存 |

## 9. 不进入业务 Model 的字段

- `apiMessage`、`query`、`result[]` pagination、`s`/`p`；
- API key、API metric、账户计划、usage/限流状态；
- 完整 vendor JSON、JATS/BITS/PAM 类型与原始响应；
- `subjects[]` 未经语义确认就形成的 declared keywords；
- `openaccess` 或 URL format 形成的授权、媒体类型或接纳结论；
- JATS reference list 直接形成的权威 Reference。

## 10. 已知限制与待核对

- 本轮没有 key，未验证实际 API 状态、错误体、响应 headers、字段完整度或 plan entitlement。
- 当前门户 Quick Start 标题/示例存在产品名称容易混淆之处；实现应以明确 endpoint 和契约响应为准。
- Full Text 旧主机按计划于本日下线，但本轮未验证实际下线状态；禁止新实现依赖旧主机。
- 官网公开样例含 legacy HTTP OpenURL；安全 HTTPS canonical locator 的获取方式需实现时核对。
- 未找到 Springer Nature 逐边 citation API 或当前公开 PDF bytes endpoint 的足够依据；JATS/XML 和 metadata PDF locator 不能扩写成已验证 PDF API。

## 11. 当前实现边界

`springer` 是当前配置选择键；`src/sciretriever/metadata/providers/springer/adapter.py` 已实现显式 API-key readiness、Meta v2 JSON probe、topic search、按 DOI/ISBN lookup、`s`/`p` 分页、记录身份与中性 Metadata 转换，并把明确 `url[].format` 转为有 provenance 的 PDF/landing AssetHint。API key 虽按官方合同作为 query credential 发送，但只允许绑定到 `https://api.springernature.com`，Network 在日志、redirect 和异常边界剥离/脱敏，不把带凭据的完整 URL 写入业务事实。

当前 adapter 不调用 Open Access JATS、Full Text JATS/BITS 或旧主机，也不把 metadata 中的 `format=pdf` locator、XML/JATS 内容、HTTP 200 或有效 key 冒充已授权主 PDF。Acquisition registry 对 `springer` 的 authorized PDF capability 继续明确为 unsupported；安全 locator 仍需经过公开路径的实际字节与 PDF 验证，Browser 生产规则尚未接入。2026-08-15 本轮没有读取真实 key、调用真实 Springer Nature API、验证产品 entitlement 或下载内容；Meta v2 schema、额度与失败行为仅由离线 fake/fixture 验证。
