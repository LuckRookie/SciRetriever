# OpenAlex

- 最后核对：2026-08-07
- schema v2 选择键：metadata `openalex`；citation `openalex`；asset `openalex`
- 供应商角色：聚合元数据、结构化引用图与 OA/全文 locator
- 当前仓库接入状态：只有选择键、通用 Protocol/adapter/registry；没有 OpenAlex 专用生产 client，registry 未连接到当前 Collection 或 Assets Service

## 1. 官方入口与证据

- [OpenAlex Developers](https://developers.openalex.org/) 与 [LLM reference](https://developers.openalex.org/llms.txt)：当前入口、参数、价格/额度摘要和响应顶层。
- [Authentication & Pricing](https://developers.openalex.org/guides/authentication)：API key、免费预算与计费。
- [Works schema](https://developers.openalex.org/api-reference/works)：Work 字段与可过滤字段。
- [Get a single work](https://developers.openalex.org/api-reference/works/get-a-single-work)：OpenAlex ID/DOI 等单条查询。
- [Filter](https://developers.openalex.org/guides/filtering)、[Search](https://developers.openalex.org/guides/searching)、[Page through results](https://developers.openalex.org/guides/page-through-results)：查询与分页。
- [OpenAPI spec](https://developers.openalex.org/api-reference/openapi.json)：机器可读规范。

均为 `official`，2026-08-07 核对。当天无 key 对单 work 与一个 cursor search 做了匿名只读请求，均返回 HTTP 200；这只是一项 `verified` 现场事实，不替代官方预算/认证政策。

## 2. 认证、政策与额度

当前官方按调用成本预算，不再只描述固定 requests/s。免费 API key 每日含 USD 1 免费使用；无 key 每日 USD 0.10。官方示例成本：singletons 免费，list/filter 为 USD 0.0001/call，search 为 USD 0.001/call，content download 为 USD 0.01。免费 key 示例容量分别约为 10,000 次 list/filter、1,000 次 search、100 次 content download；成本与政策会变化，调用方应读取当前 usage headers/账户状态。

官方文档说“规模化使用需要 key”；本轮匿名请求成功只说明试用预算仍可用，不能记录为稳定匿名 SLA。key 放 `api_key` query 或官方支持的认证位置；任何 key 均不得进入日志、provenance 或持久 URL。

## 3. 元数据接口

### 3.1 请求、过滤和分页

- `GET https://api.openalex.org/works/{id}`：`W...`、DOI URL/`doi:`、PMID 等单条 lookup。
- `GET https://api.openalex.org/works`：使用 `filter`、`search`、`sort`、`select`、
  `group_by`、`sample`、`per_page`、`page` 或 `cursor`。
- filter 用 `field:value`，逗号为 AND，`|` 为同字段 OR（官方当前上限 100 个值），`!` 为 NOT。
- `search` 检索 title、abstract 和 fulltext；它与精确 filter 的语义和成本不同。
- `per_page` 当前最大 100。基础 `page` 只适合前 10,000 条；深分页从 `cursor=*` 开始，后续传 `meta.next_cursor`。

列表响应：

```text
meta {
  count
  db_response_time_ms
  page              # cursor 模式为 null
  per_page
  next_cursor?
  groups_count?
  cost_usd?
  x_query?          # 当前响应可出现内部解释
}
results[]
group_by[]
```

`x_query`、cost、数据库耗时与 cursor 都不是业务事实。

### 3.2 Work 主要字段与层级

Work 字段很多且会演进，候选映射应只读取项目需要的显式字段：

- 身份：`id`、`doi`、`ids{openalex,doi,pmid,pmcid,mag,...}`；
- 描述：`title`、`display_name`、`type`、`language`、`publication_year`、
  `publication_date`、`abstract_inverted_index`；摘要不是字符串，而是 token→position[] 的倒排表；
- 作者：`authorships[]` 保持记录顺序，每项含 `author_position`、
  `author{id,display_name,orcid}`、`raw_author_name`、`raw_orcid`、`is_corresponding`、
  `institutions[]`、`raw_affiliation_strings[]`、`affiliations[]`；institution 可含
  `id`、`display_name`、`ror`、`country_code`、`type`、`lineage`；
- 出版：`primary_location.source{display_name,issn_l,issn,type,...}` 和
  `biblio{volume,issue,first_page,last_page}`；
- 主题：`topics[]`、`keywords[]`、`concepts[]` 等 OpenAlex 推导分类；
- 访问：`primary_location`、`best_oa_location`、`locations[]`、`open_access`；
- 引用：`referenced_works[]`、`referenced_works_count`、`cited_by_count`；通过
  `filter=cites:W...` 或 `cited_by:W...`/相应当前 filter 查询方向边；
- 质量/管道：`is_retracted`、`is_paratext`、`indexed_in`、`updated_date`、`created_date`、评分等。

OpenAlex author/institution ID 是聚合实体 ID，不应成为 SciRetriever 全局 Author identity；ORCID 和 ROR 只有在同一 authorship/institution 嵌套明确对齐时才是候选值。topics/keywords 是 OpenAlex 算法产物，不是供应商“原始记录声明关键词”。

## 4. 引用接口

当前 Work 的 `referenced_works[]` 是该 work 引用的 OpenAlex Work ID 数组，每个目标可形成独立
`citing=current -> cited=target` 的 `ProviderRelationObservation` 候选；
`referenced_works_count` 可能与数组长度/覆盖不同，不能自行补边。

反向 cited-by 列表通过 works filter 查询，返回普通 Work 列表；每个结果是 citing 端，当前 work 是 cited 端。`cited_by_count` 是计数，不是边。OpenAlex 不在 Work 中提供逐条原始 reference text，也不提供 reference 在原文中的位置；因此这些结构化边不能填充 `reference_texts`。

`related_works` 是相似/相关作品，不是引用；`is_retracted` 等也不进入当前通用关系图。

## 5. PDF、全文与资产线索

Location 对象常见字段：

```text
id
is_oa
landing_page_url
pdf_url
source { id, display_name, issn_l, issn, host_organization..., type }
license
license_id
version
is_accepted
is_published
raw_source_name
raw_type
```

`primary_location` 是首要发表位置，`best_oa_location` 是 OpenAlex 选择的 OA 位置，
`locations[]` 是多个位置；它们可能不是同一对象。每个非空 URL 应分别成为 locator 候选，不能只保存
`best_oa_location` 或后值覆盖前值。`version` 可见 `publishedVersion`、
`acceptedVersion`、`submittedVersion` 等外部值，需要显式映射。

`open_access{is_oa,oa_status,oa_url,any_repository_has_fulltext}` 是聚合访问观察；
`pdf_url`、`is_oa` 或 `has_fulltext` 不证明链接当前可访问、内容是 PDF或许可适用。OpenAlex 的
content download 是另一个计费动作；本轮未使用。

## 6. 代表性响应结构

2026-08-07 匿名 cursor search 的精简形状：

```json
{
  "meta": {
    "count": 1774645,
    "page": null,
    "per_page": 1,
    "next_cursor": "...",
    "cost_usd": 0.001
  },
  "results": [{
    "id": "https://openalex.org/W3035965352",
    "doi": "https://doi.org/10.1038/s41586-020-2649-2",
    "title": "Array programming with NumPy",
    "publication_year": 2020,
    "publication_date": "2020-09-16",
    "ids": {"openalex": "https://openalex.org/W3035965352", "pmid": "https://pubmed.ncbi.nlm.nih.gov/32939066"},
    "authorships": [{
      "author_position": "middle",
      "author": {"display_name": "K. Jarrod Millman", "orcid": "https://orcid.org/0000-0002-5263-5070"},
      "institutions": [{"display_name": "University of California, Berkeley", "ror": "https://ror.org/01an7q238"}],
      "raw_affiliation_strings": ["Berkeley Institute for Data Science, ..."]
    }],
    "primary_location": {
      "landing_page_url": "https://doi.org/10.1038/s41586-020-2649-2",
      "pdf_url": "https://www.nature.com/articles/s41586-020-2649-2.pdf",
      "license": "cc-by",
      "version": "publishedVersion"
    },
    "biblio": {"volume": "585", "issue": "7825", "first_page": "357", "last_page": "362"},
    "referenced_works": ["https://openalex.org/W1969761972"],
    "referenced_works_count": 41,
    "cited_by_count": 22998
  }],
  "group_by": []
}
```

本次响应还含 `meta.x_query` 和大量 topics/keywords，说明响应字段会超出 SciRetriever 当前中性业务合同；不能保存完整 vendor 对象。

## 7. 与 SciRetriever 中性数据的候选映射

| 外部字段 | 外部语义 | 候选归属 | 备注 |
|---|---|---|---|
| `id` | OpenAlex Work ID | `Provenance.source_record_id` | 可同时作为 provider key，不代替本地 Literature ID |
| `doi` / `ids.pmid` / `ids.pmcid` | 稳定标识符 | `LiteratureMetadata.identifiers` | 去 URL wrapper 后按 namespace 规范化 |
| `title` | work 标题 | `LiteratureMetadata.title` | `display_name` 通常重复，不保存两份 |
| `abstract_inverted_index` | 摘要倒排索引 | `LiteratureMetadata.abstract` | 必须按 position 完整重建；缺失不猜 |
| `type`、`language`、publication fields | 类型、语言、出版日/年 | `LiteratureMetadata` | 显式值映射 |
| `authorships[]` | 有序署名及对齐单位 | `Author[]` | 只用明确 ORCID/ROR；OpenAlex author ID 不建全局作者 |
| location source + `biblio` | venue、ISSN、卷期页 | `LiteratureMetadata` | first/last page 确定性组成 pages |
| `referenced_works[]` | 结构化引用目标 | `ProviderRelationObservation` | 一 ID 一条边；目标未入库也可独立保存 observation |
| `referenced_works_count` / `cited_by_count` | 来源计数 | observation 计数字段 | 不跨供应商相加 |
| location URL/media/version/license/OA | 获取线索 | `AssetHint[]` | 多 location 分开；OA/license 不进 LiteratureMetadata |
| `updated_date` 与调用时间 | 数据新鲜度/观察上下文 | `Provenance` 的候选输入 | 以实际 observed_at 为主，不把 updated_date 当出版日 |

OpenAlex `keywords[]`、`topics[]` 是自动推导内容，明确不候选映射到
`MetadataObservation.declared_keywords`；本 Notes 不新增自动 topic 模型。

## 8. 不进入业务 Model 的字段

- `meta.db_response_time_ms`、`meta.cost_usd`、`meta.x_query`、cursor/page；
- Work/Author/Institution 的全局分析指标、counts_by_year、percentile、FWCI、topic score；
- OpenAlex 自动 topics、keywords、concepts、SDGs；
- `related_works`、retraction/correction 等当前范围外关系；
- `author.id`、institution lineage 等聚合实体图（ROR 值除外）；
- 原始 vendor JSON、API key、usage headers 和查询调试字段。

## 9. 已知限制与待核对

- 无 key 请求本轮为 200，但官方只给其十分之一试用预算；不能依赖为生产匿名能力。
- 聚合 metadata、OA/location 和机构匹配可能滞后或误配；候选 URL 必须实取验证。
- `abstract_inverted_index` 重建必须处理重复 position、缺口和 Unicode；具体 adapter 需直接测试。
- Work schema 易变且字段很多；应使用显式解析并拒绝 vendor 私有类型穿透。
- cited-by 的当前推荐 filter 拼写和弃用别名需在实现时以 Works schema/OpenAPI 再确认；不得硬编码旧 `cited_by_api_url`。
- 本轮未调用 content download/PDF。

## 10. 当前实现边界

`openalex` 是当前 metadata/citation/asset 三类允许键，但三类实现都是调用方必须注入的窄通用
Protocol。仓库没有 API key 处理、filter/cursor、Work schema、abstract 重建、authorship/location 或
referenced_works 转换。fake citation client 只返回 namespace/value，不能证明 OpenAlex 引用 API
已接入；registry 也没有连接到当前业务 Service。
