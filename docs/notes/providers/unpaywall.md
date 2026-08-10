# Unpaywall

- 最后核对：2026-08-07
- schema v2 选择键：asset `unpaywall`
- 供应商角色：按 DOI 或标题查询开放获取状态与全文 locator；不是 SciRetriever 元数据或引用 provider
- 当前仓库接入状态：只有 asset 选择键、通用 Protocol/adapter/registry；没有 Unpaywall 专用生产 client，registry 未连接到当前 Assets Service

## 1. 官方入口与证据

- [Unpaywall API](https://unpaywall.org/products/api)：DOI lookup、标题搜索、email 要求、调用量建议与分页说明。
- [Unpaywall data format](https://unpaywall.org/data-format)：记录与 OA location 字段说明入口。

以上为 `official`，2026-08-07 核对。页面正文由 JavaScript 渲染，本轮同时核对了官网加载的前端 bundle；support 站点的相关文章返回 HTTP 403，未尝试绕过。

当天使用官网公开示例 email `unpaywall_01@example.com` 对 DOI
`10.1038/nature12373` 发出一次最小匿名只读请求，返回 HTTP 200 JSON，为 `verified`。
同日按官网示例执行标题搜索返回 HTTP 500 HTML，因此搜索只记录公开合同，不记录为本轮已验证可用。

## 2. 认证、政策与额度

Unpaywall API 不使用 API key，但每个请求必须提供用于识别调用方的 `email` query 参数。生产实现应使用团队控制的有效联系邮箱，不应复制文档中的公开示例值；邮箱属于请求配置，不能进入日志、持久 URL、业务 Model 或 provenance。

官方当前要求合理使用，并建议每日不超过 100,000 calls。公开页面没有给出稳定的每秒并发或响应 header 合同；实现仍需使用有界并发、timeout、退避和缓存。HTTP 429 应按限流处理，不能通过高频重试消耗共享服务。

## 3. 查询接口与响应层级

### 3.1 DOI lookup

```text
GET https://api.unpaywall.org/v2/{doi}?email={contact_email}
```

`{doi}` 是 DOI 本体，不含 `https://doi.org/` wrapper。成功响应是一个 work JSON 对象；不存在、无效 DOI、服务失败和“记录存在但无 OA location”是不同状态。

常见顶层字段：

- 身份与描述：`doi`、`doi_url`、`title`、`genre`、`published_date`、`year`；
- 出版信息：`journal_name`、`journal_issns`、`journal_issn_l`、`publisher`；
- OA 汇总：`is_oa`、`oa_status`、`has_repository_copy`；
- OA 位置：`best_oa_location`、`first_oa_location`、`oa_locations[]`、
  `oa_locations_embargoed[]`；
- 管道信息：`data_standard`、`updated`；
- 作者观察：`z_authors[]`。

### 3.2 标题搜索

```text
GET https://api.unpaywall.org/v2/search?query={title}&is_oa=true&email={contact_email}&page={page}
```

官方页面当前说明每页 50 条，以 `page` 翻页。标题搜索是模糊候选发现，不是 DOI 等价判断；每个结果仍需凭显式标识符和项目身份规则处理。本轮示例请求返回 HTTP 500 HTML，不能由此推断永久不可用，也不能把该响应当 JSON 解析。

## 4. OA location 与资产线索

一个记录可能有多个 publisher/repository location。常见 location 字段：

```text
endpoint_id
evidence
host_type
is_best
license
oa_date
pmh_id
repository_institution
updated
url
url_for_landing_page
url_for_pdf
version
```

- `url_for_pdf` 是 PDF 候选；`url_for_landing_page` 是落地页；通用 `url` 不应凭名字猜媒体类型。
- `host_type` 常区分 `publisher` 与 `repository`；它是来源描述，不是访问授权结论。
- `version` 可见 `publishedVersion`、`acceptedVersion`、`submittedVersion` 等，应显式映射；未知值保留为外部观察或拒绝映射，不能静默改义。
- `license`、`is_oa`、`oa_status` 和 `evidence` 是聚合观察，不能替代最终 URL 响应、PDF 基本检查或 operator 对许可的判断。
- `best_oa_location`、`first_oa_location` 与 `oa_locations[]` 可能重叠。adapter 应以稳定规则去重，但不能让单个“best”覆盖其它可审计候选。
- 本轮 DOI 响应中 location 的 `evidence`、`updated` 值为字符串 `deprecated`。因此这两个字段不能按旧字段名想当然地解释为证据文本或时间戳。

SciRetriever 的 Acquisition 最终只公开“已有主 PDF”或“没有主 PDF”；逐候选响应仍是临时执行信息，不形成新的持久化失败模型。无法安全发布或提交关系属于系统失败，不能降级成无候选。

## 5. 作者字段边界

本轮响应中的 `z_authors[]` 包含：

```text
author_position
is_corresponding
raw_author_name
raw_affiliation_strings[]
```

这些字段能辅助检查候选是否明显错配，但 Unpaywall 在当前 schema v2 不是 metadata provider，asset adapter 不应借机写入统一元数据或创建全局作者身份。字段名前缀和数据质量也说明它不是稳定的 SciRetriever Author 合同。

## 6. 代表性响应结构

2026-08-07 DOI lookup 的精简形状；URL 与人名仅示意层级：

```json
{
  "doi": "10.1038/nature12373",
  "doi_url": "https://doi.org/10.1038/nature12373",
  "title": "...",
  "genre": "journal-article",
  "published_date": "2013-07-18",
  "year": 2013,
  "journal_name": "Nature",
  "journal_issns": "0028-0836,1476-4687",
  "publisher": "Springer Science and Business Media LLC",
  "is_oa": true,
  "oa_status": "hybrid",
  "has_repository_copy": true,
  "best_oa_location": {
    "host_type": "publisher",
    "version": "publishedVersion",
    "license": "cc-by-nc-sa",
    "url_for_landing_page": "https://doi.org/...",
    "url_for_pdf": "https://...pdf"
  },
  "oa_locations": [
    {"host_type": "publisher", "version": "publishedVersion"},
    {"host_type": "repository", "version": "submittedVersion"}
  ],
  "data_standard": 2,
  "updated": "...",
  "z_authors": [{"author_position": "first", "raw_author_name": "..."}]
}
```

本轮没有访问任何 location，也没有下载 PDF。

## 7. 与 SciRetriever 中性数据的候选映射

| 外部字段 | 外部语义 | 候选归属 | 备注 |
|---|---|---|---|
| `doi` | 查询记录 DOI | Acquisition source 的解析输入与 `Provenance.source_record_id` 候选 | 不建立本地 Literature ID；必须与输入 DOI 对齐 |
| location URL 字段 | PDF/landing/general URL | 运行时 `PdfCandidate.url` / `access_kind` | 一个 location 形成一个候选；只接受安全 HTTPS 地址，未声明 PDF 时不能伪造媒体类型 |
| `version` | 外部稿件版本 | 当前 adapter 的候选筛选输入 | Unpaywall 不是 metadata provider，不能把该值写入 `MetadataObservation.asset_hints`；只用于避免把明确非主文版本误当主 PDF |
| `license`、`host_type`、OA 字段 | 聚合访问观察 | 当前 adapter 的候选筛选输入或 provenance 输入 hash | 不进入 `PdfCandidate`，也不证明下载成功或合法授权 |
| location/记录更新时间与调用时间 | 来源新鲜度 | `Provenance` 候选输入 | `observed_at` 取实际调用时间；`deprecated` 不解析为时间 |

`title`、出版信息和 `z_authors` 可用于 adapter 内部一致性检查，但在当前能力声明下不写入 `LiteratureMetadata`。同理，OA location 的版本、许可证和访问状态也不能由纯 asset adapter 暗中持久化为 `MetadataObservation.asset_hints`。若未来要让 Unpaywall 成为 metadata provider，需先修改公开选择键、责任文档与测试。

## 8. 不进入业务 Model 的字段

- `data_standard`、服务更新时间、查询页码和传输调试信息；
- 完整 vendor JSON、请求 email 和响应 headers；
- `z_authors` 作为第二套作者模型；
- `is_best` 或位置数组顺序形成的永久业务 precedence；
- 供应商 OA 分类直接形成的版权或接纳结论。

## 9. 已知限制与待核对

- support 文档本轮返回 403；未核对公开服务级 SLA、固定每秒限流、错误体 schema 和 email 生命周期。
- 官网正文依赖 JavaScript；实现时应再次核对公开 data format 与实际响应，使用显式解析和未知字段容忍策略。
- 标题搜索本轮为 HTTP 500 HTML，未验证成功响应的完整顶层 shape、总数或最后一页行为。
- OA location 来自聚合与推断，可能滞后、失效、返回 HTML 或被目标站点拒绝；必须经 Network policy 和 PDF 基本检查。
- 本轮唯一实测使用官方公开示例 email；没有读取或发送本地凭据。

## 10. 当前实现边界

`unpaywall` 仅是当前 asset 允许键。仓库没有 email 注入、DOI/title 请求、分页、location 解析、去重或 OA 字段转换。通用 resolver adapter 只有调用方注入 `ResolverClient` 后才能工作，且 registry 当前未接到 Assets Service；配置接受该键不代表用户已能运行 Unpaywall acquisition。
