# arXiv

- 官方资料最后在线核对：2026-08-07
- 当前实现离线对照：2026-08-15
- schema v2 选择键：metadata `arxiv`；asset `arxiv`
- 供应商角色：预印本元数据与主文 PDF 线索
- 当前仓库接入状态：专用 Metadata Atom adapter 与公开 PDF Source 均已进入生产 registry；两者共享 `arxiv/api` 准入范围

## 1. 官方入口与证据

- [API Access](https://info.arxiv.org/help/api/)：API 总入口。
- [API Basics](https://info.arxiv.org/help/api/basics.html)：`query` 入口、GET/POST 和 Atom 1.0 响应。
- [API User's Manual](https://info.arxiv.org/help/api/user-manual.html)：查询参数、分页、排序、版本和 Atom 字段。
- [Terms of Use for arXiv APIs](https://info.arxiv.org/help/api/tou.html)：访问政策、版权和限流。
- [arXiv Identifier](https://info.arxiv.org/help/arxiv_identifier.html)：新旧标识符与版本后缀。

以上均为 `official`，2026-08-07 可访问。另于同日对公开 `query` 端点做了一次匿名只读请求；未下载 PDF。

## 2. 认证、政策与限流

Legacy arXiv API 不要求 API key。官方 Terms 要求所有受调用方控制的机器合计最多每三秒一次请求，并且同一时间只使用一个连接；规则可能变化，超过该速率需联系 arXiv。版权归作者或出版者，API 可访问不等于内容可任意再利用。

当前 Metadata 与 Acquisition 都声明 `max_concurrency = 1`、`min_start_interval = 3s`，并使用同一 `AccessScope(provider_name="arxiv", channel="api")`，所以同一进程内的搜索、lookup 和 PDF locator lookup 不会分别绕开官方限制。标准 `Retry-After` 会形成共享阻塞；无可用 header 的 `5xx` 也按项目保守退避处理。这里的数值来自上述官方 Terms，`5xx` 退避则是项目安全策略，不是 arXiv 公布的额外额度。

API 文档仍以 `http://export.arxiv.org/api/query` 举例；实际核验时 HTTPS 可用。SciRetriever 候选实现仍应只接受经过统一 Network policy 检查的 HTTPS URL，不能把官方历史 HTTP 示例直接变成生产例外。

## 3. 元数据接口

### 3.1 请求

主入口为 `GET` 或 `POST https://export.arxiv.org/api/query`：

- `search_query`：字段查询，常见字段包括 `ti`、`au`、`abs`、`co`、`jr`、`cat`、`rn`、`id` 和 `all`；支持 `AND`、`OR`、`ANDNOT`。
- `id_list`：逗号分隔的 arXiv ID；需要精确版本时在 ID 后保留 `vN`。官方明确建议按 ID 取记录时使用 `id_list`，不要用 `search_query=id:...` 代替。
- `start`：从 0 开始的结果偏移，默认 0。
- `max_results`：本页数量，默认 10。
- `sortBy`：`relevance`、`lastUpdatedDate` 或 `submittedDate`。
- `sortOrder`：`ascending` 或 `descending`。

`search_query` 与 `id_list` 同时出现时取两者交集。响应是 Atom 1.0 XML，不提供 JSON 变体。

### 3.2 响应层级

`feed` 顶层包含：

- Atom `id`、`title`、`updated` 和 `link`；
- OpenSearch `totalResults`、`startIndex`、`itemsPerPage`；
- 零到多个 Atom `entry`。

每个 `entry` 可包含：

- `id`：通常为带版本后缀的 abstract URL；
- `title`、`summary`；
- `published`：第一版本提交时间；
- `updated`：当前返回版本的提交时间；
- 有序 `author[]`，每项有 `name`，可选 `arxiv:affiliation`；
- `category[]` 和 `arxiv:primary_category`；
- 可选 `arxiv:comment`、`arxiv:journal_ref`、`arxiv:doi`；
- `link[]`：通常包括 `rel="alternate" type="text/html"` 的落地页和 `rel="related" type="application/pdf" title="pdf"` 的 PDF 线索。

字段是可选且来源自投稿记录。API 没有结构化 given/family name、ORCID、ROR、卷期页拆分、出版社、许可证或通用 document type 字段；不能从展示名、`journal_ref` 或分类字符串猜出这些值。arXiv category 是分类，不是作者声明关键词。

## 4. 引用接口

Legacy Atom API 不返回结构化 references、cited-by 边、引用计数或逐条原始 reference text。Terms 中把“基于 e-print 参考文献构建 citation graph”列为允许用例，不等于 Atom API 自身提供引用数据。

因此 arXiv 当前只能贡献元数据和资产线索；不能仅凭 `arxiv:journal_ref` 建立引用关系。

## 5. PDF、全文与资产线索

`entry/link[@type="application/pdf"]` 是供应商声明的直接 PDF 地址候选；abstract 页面 link 是 landing page 候选。它们可带版本化 ID，因此应保留版本后缀。URL 可访问、媒体类型声明为 PDF 或来自 arXiv 都不替代 SciRetriever Acquisition 的实际字节、PDF 结构、页面结构和目标归属检查。

Atom API 没有补充材料清单、结构化全文 XML/HTML、OA 状态或许可证字段。arXiv 可公开读取也不能推出具体稿件的许可证；如需许可事实，应另找该记录明确提供的官方依据，不能按站点默认猜测。

## 6. 代表性响应结构

以下片段来自 2026-08-07 对
`https://export.arxiv.org/api/query?id_list=2106.14834&max_results=1`
的匿名只读请求，已删去摘要正文：

```xml
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:itemsPerPage>1</opensearch:itemsPerPage>
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2106.14834v1</id>
    <title>...</title>
    <updated>2021-06-28T16:21:21Z</updated>
    <published>2021-06-28T16:21:21Z</published>
    <summary>...</summary>
    <author><name>Mariarosa Mazza</name></author>
    <category term="math.NA" scheme="http://arxiv.org/schemas/atom"/>
    <arxiv:primary_category term="math.NA"/>
    <link href="https://arxiv.org/abs/2106.14834v1"
          rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/2106.14834v1"
          rel="related" type="application/pdf" title="pdf"/>
  </entry>
</feed>
```

注意 `entry/id` 在本次响应中仍是 HTTP URL，而 asset link 是 HTTPS；适配边界应抽取标识符并独立验证 URL，不能把传输形式当作标识符规范。

## 7. 与 SciRetriever 中性数据的候选映射

| 外部字段 | 外部语义 | 候选归属 | 备注 |
|---|---|---|---|
| `entry/id` 中的版本化 ID | arXiv 记录/版本定位 | `MetadataObservation.provenance.source_record_id`；`LiteratureMetadata.identifiers` | 标识符 namespace 候选为 `arxiv`，保留 `vN`；URL 本身不必成为标识符值 |
| `title` | 投稿标题 | `LiteratureMetadata.title` | 规范空白，不改写内容 |
| `summary` | 投稿摘要 | `LiteratureMetadata.abstract` | 不是 LLM 总结 |
| `published` / `updated` | 首版/当前版本提交时间 | `LiteratureMetadata.publication_date` 或 `Provenance` 的候选输入 | 必须先明确项目希望表达哪种日期；不同时写成两个“发表日期” |
| `author[].name` | 有序署名展示名 | `Author.display_name` | 不机械拆 given/family |
| `author[].arxiv:affiliation` | 作者投稿时声明单位文本 | `Author.affiliations` | 无 ROR 时只保留明确名称 |
| `arxiv:doi` | 投稿者提供的 DOI | `LiteratureMetadata.identifiers` | 规范化后 namespace `doi` |
| `category[]` / `primary_category` | arXiv 分类 | 暂无业务字段 | 不是 `declared_keywords`，除非未来有明确产品规则 |
| HTML `link` | abstract landing page | `AssetHint` | `landing-page`，不是已获得资产 |
| PDF `link` | 供应商声明的 PDF 地址 | `AssetHint` | `direct-file`、媒体类型 `application/pdf`、角色候选 `primary-pdf`、版本候选 `preprint` |
| feed 查询与观察时间 | 调用上下文 | `Provenance` | 输入 hash 由适配边界形成 |

arXiv 记录代表预印本这一事实很强，但 `MetadataObservation.version_role = preprint` 是否由 provider adapter 固定声明，仍应由实现任务对照目标 schema 与测试确认；本 Notes 不替代该设计决定。Atom API 也没有明确给出“这是某个 DOI 正式版的同文献版本连接”，所以 DOI 共现本身不能自动形成 `version_links`。

## 8. 不进入业务 Model 的字段

- feed 自身 `title`、`id`、规范化查询 `link` 和 feed `updated`；
- `start`、`max_results`、排序参数及 OpenSearch 分页控制值；
- HTTP headers、连接状态、重试计数和 XML parser 私有对象；
- `arxiv:comment` 中的页数/图数自由文本，除非未来有明确中性字段；
- category 评分或查询相关度（本 API 未公开稳定评分字段）。

## 9. 已知限制与待核对

- API 文档较旧但 2026-08-07 仍由官方维护并可用；实现前需继续以当前 Terms 为准。
- `max_results` 的服务器硬上限和大结果集分批建议在本轮未找到足够清晰的当前官方表述，待核对，不猜数值。
- Atom 作者没有 ORCID，单位也没有 ROR；不得跨来源或按名称猜测。
- `arxiv:doi`、`journal_ref` 与版本关系含义不足以自动证明 preprint/published 两条记录属于同一 `MetaLiterature`。
- 未匿名下载 PDF，只验证了响应中的 PDF link 形状。

## 10. 当前实现边界

`src/sciretriever/metadata/providers/arxiv/adapter.py` 已实现匿名 probe、topic search、按 arXiv ID lookup、Atom 分页与中性 Metadata 转换；`src/sciretriever/acquisition/sources/arxiv.py` 按版本对齐的 arXiv identity 查询 Atom，只把明确的官方 PDF link 交给统一 `PublicLocatorFetcher`。最终字节仍经过 Network 安全边界、PDF 检查和不可变发布，Atom 的媒体类型声明不会直接形成资产事实。

Metadata 与 Acquisition 共用 `arxiv/api` scope 和上述官方政策。当前实现不提供引用扩展、补充材料、许可证推断或 Browser 站点规则。本轮 2026-08-15 只使用 fake transport、fixture 和可注入 clock 复验实现，没有调用真实 arXiv endpoint，也没有下载真实 PDF；第 6 节保留的匿名响应来自 2026-08-07 的既有核对记录。
