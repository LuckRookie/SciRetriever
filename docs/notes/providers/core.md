# CORE

- 最后核对：2026-08-13
- 当前配置选择键：`core`；支持 Metadata 与 Acquisition
- 外部角色：聚合开放获取 repository/journal 的 metadata、全文 locator、文本与解析参考文献
- 当前仓库接入状态：Metadata Works/Outputs search/lookup/reference/AssetHint adapter 已接入；Acquisition 先消费公开 locator，再可使用注册用户 Work/Output PDF download endpoint

## 1. 官方入口与证据

- [CORE API v3 documentation](https://api.core.ac.uk/docs/v3)：现行 Works/Outputs 实体、字段、查询、认证、限流、PDF policy。
- [CORE API v3 OpenAPI](https://api.core.ac.uk/swagger/v3.json)：机器可读 endpoints、参数与 schema。
- [CORE API service](https://core.ac.uk/services/api)：API key 申请与服务入口。

均为 `official`，download endpoint 与认证合同于 2026-08-13 重新核对。2026-08-07 曾对 `search/works` 做一次匿名 `limit=1` DOI 查询，返回 HTTP 200、`application/json`；顶层、字段名与 rate-limit headers 属于 `verified`。本次实现没有使用真实 key，也没有调用真实 download endpoint、保存或展示 full text；download 行为的当前证据为官方 OpenAPI 与离线合同测试。

## 2. Works、Outputs 与 SciRetriever 身份边界

CORE v3 当前术语不是笼统的 “works/search/outputs” 同义词：

- `Work` 是一项研究工作的去重、增强表示，可由不同 repository/journal 收割的一个或多个 Outputs 组成；
- `Output` 是单一 data provider 收割到的来源级原始表示，不去重，尽量反映来源 metadata；
- `Work.outputs[]` 指向构成该 Work 的 CORE Output；data provider 也是独立实体。

这只是 CORE 的聚合身份决定，不能直接成为 SciRetriever 的 MetaLiterature/Literature 归属。CORE Work ID 和 Output ID 都是 provenance/source record 候选；不同 Output 是否是同一具体 Literature 或明确版本，仍需 Literature 按稳定标识与来源证据保守解释。不能因为多个 Output 被 CORE 聚成一个 Work 就自动物化本地成员归属。

## 3. 认证、token 预算与错误处理

当前官方明确 CORE API 可匿名使用，不要求认证；注册 API key 可获得更高额度。首选认证位置：

```text
Authorization: Bearer API_KEY
```

文档还允许 `api_key=` query fallback，但生产实现不使用会进入 URL/日志的形式。当前实现只从 `~/.sciretriever/credentials.toml` 私有读取 key，由 Bootstrap 注入 adapter，并作为绑定到 `https://api.core.ac.uk` 的 `Authorization: Bearer` 私有 header 交给 Network；不写入普通配置、候选、provenance、fixture 或 Notes。Metadata 可以匿名运行，启用 CORE Acquisition 的授权 PDF Source 时 `api_key` 必需。

当前 token 预算为：

| 用户类别 | 当前额度 |
|---|---|
| anonymous | 每日 100 tokens，最多 10/min；不提供 full text |
| registered personal | 每日 1,000 tokens，最多 25/min |
| registered academic，非 Supporting/Sustaining 机构 | 每日 5,000 tokens，最多 10/min |
| Supporting/Sustaining 机构成员与 non-academic organization | 随服务器负载/合同动态调整；官方估计约 200k tokens/day |
| VIP | 与 CORE 单独约定 |

简单查询通常消耗 1 token，复杂查询通常 3–5；recommender、scroll search、bulk 等可能更贵，且官方可随负载调整 operation cost。必须以响应 headers 为准：

```text
X-RateLimit-Limit
X-RateLimit-Remaining
X-RateLimit-Retry-After
```

2026-08-07 匿名最小响应观察到这三个 header 的小写 HTTP 表示。额度是 token 而非单纯 request count；重试必须遵守 retry-after 和共享 Network budget，不能高频试探 key 状态。

## 4. endpoints、查询与分页

与候选接入直接相关的当前 v3 endpoints：

```text
GET  /v3/works/{identifier}
GET  /v3/works/{identifier}/outputs
GET  /v3/outputs/{identifier}
GET  /v3/search/works?q=...&offset=...&limit=...
GET  /v3/search/outputs?q=...&offset=...&limit=...
POST /v3/search/{entityType}
POST /v3/search/{entityType}/aggregate
GET  /v3/works/{identifier}/download
GET  /v3/outputs/{identifier}/download
```

GET search 的 `q` 支持普通关键词、`field:value`、引号 phrase、布尔组合、范围与 `_exists_:field` 等 CORE query language 表达式。按 DOI 应使用字段查询并保留 URL 编码边界，例如 `q=doi:"..."`。POST search 用 JSON body 的 `q`、`offset`、`limit`、`stats`，适合较长表达式；不能把用户自由输入直接拼入 query 语言。

当前 GET/OpenAPI 分页参数是 `offset`（默认 0）和 `limit`（默认 10），响应回显两者；`stats=true` 会增加开销。现行公开 OpenAPI 没有 scroll/cursor 参数，也没有给 `offset + limit` 的公开最大深度。文档 HTML 中仍有被注释掉的旧 scroll/10,000 说明和 webinar 链接，但它们不构成当前公开合同；大规模枚举路径待实施时向 CORE 核对，不能继续使用旧参数或自行构造 scroll ID。

## 5. Work metadata 字段

当前官方 Works 字段及现场可见层级包括：

- 身份：`id`、`doi`、`arxivId`、`pubmedId`、`oaiIds[]`、`identifiers[] {identifier,type}`；
- 标题/描述：`title`、`abstract`、`documentType`、`language`；
- 作者：`authors[] {name}`，另有 `contributors[]`；
- 出版：`publishedDate`、`yearPublished`、`acceptedDate`、`publisher`、`journals[] {title,identifiers[]}`；
- 聚合来源：`outputs[]`、`dataProviders[]`、`depositedDate`；
- 资产/内容：`downloadUrl`、`sourceFulltextUrls[]`、`links[] {type,url}`、`fullText`；
- 参考文献：`references[]`；
- CORE 管道：`createdDate`、`updatedDate`；
- 已弃用增强：`citationCount`、`fieldOfStudy`、`magId`，官方标为 deprecated 且“不再更新”。

官方文档说 Work authors 可能来自 OAI-PMH，或从去重组中选择作者最多的 Output；现场记录出现同一人的 `Family, Given` 与 `Given Family` 重复变体。因此 `authors[]` 顺序和重复不能无审查地视为权威署名顺序，不能仅按字符串建立全局作者或猜 ORCID。当前 Work author 没有 ORCID、affiliation/ROR 的明确对齐字段，保持缺失。

`documentType` 可能来自全文机器学习或 OAI-PMH `dc.subject`/`dc.type` 解释，属于来源/CORE 增强类型；需显式映射。`fieldOfStudy` 是已弃用 MAG 分类，不是 `declared_keywords`。CORE v3 Work 没有明确 author keyword 字段，不能从 fieldOfStudy、documentType 或全文搜索命中生成关键词。

`publishedDate` 官方说从 Crossref/OAI-PMH 候选中选择最早日期；这是一项聚合决定，必须带 CORE provenance，不能被误写成各原始来源一致。accepted/deposited/created/updated 是不同日期，不替代 publication date。

## 6. Output metadata 字段

Output 表示单一来源记录，包含与 Work 相近的 title、abstract、authors、documentType、doi、identifiers、journals、publisher、published/year、download/fullText、license、references、sourceFulltextUrls 等字段，并带：

- data provider/OAI 上下文、`oai`/`setSpecs`；
- `fulltextStatus`、`rawRecordXml`/raw/history 等来源级能力；
- 来源更新/收割字段与 Work 连接。

Output 更适合保存来源级 provenance，但 vendor 私有 raw XML/full text 不能穿透中性公开 API，也不能作为第二套 LiteratureContent。若未来需要保留 OAI reference text、license 或 locator，应先转为项目已接受的 MetadataObservation/AssetHint 结构，并记录 Output source record。

## 7. references 与 citation 边界

Work/Output 的 `references[]` 由可用全文解析而来。当前 OpenAPI Reference model 包含：

```text
id
title
authors[]
date
doi
raw
cites
```

对于 `current.references[]`：

- `raw` 是来源的具体参考文献原文候选，可进入 `MetadataObservation.reference_texts`，保持顺序与 provenance；
- `doi` 或可解释的 CORE `id` 明确指向目标时，每个 reference 可形成 `citing=current -> cited=target` 的 `ProviderRelationObservation` 候选；
- `title/authors/date` 是 lookup 辅助信息，不能复制进 `ReferenceSupport` 或自动建立目标 Literature；
- `cites` 的准确语义虽在文档中描述为“cites works that cite the given document”，但当前 schema 只是 string，未提供足够方向/结构依据；在进一步核对前不用于建边。

`citationCount` 是已弃用、停止更新的 MAG enrichment。即使响应有数字，也不应作为新鲜的 `cited_by_count`；若未来为历史可追溯性保留，必须标注来源和陈旧状态，且绝不能反推 incoming edges。CORE 当前公开 v3 没有独立的完整 citing-works endpoint 合同。

## 8. PDF、locator 与 full text

当前官方 PDF policy：优先使用 Output 原来源给出的 `downloadUrl`；若该资源被阻止/限制，注册 API 用户可调用 `/v3/outputs/{identifier}/download`，该动作更昂贵并消耗 API token。官方明确禁止绕过 API 系统性收割 CORE fileserver。

候选处理规则：

- `downloadUrl`、`sourceFulltextUrls[]`、`links[type=download|display|reader]` 分别保留为 locator，不相互覆盖；
- `downloadUrl`/download link 只是 PDF 候选；必须经过 HTTPS/redirect/origin、媒体类型、响应大小和 `%PDF-`/结构基本检查；
- display/reader 是 landing page，不标为 `direct-file`；thumbnail 不是主 PDF；
- `fullText` 是 CORE 从 PDF 提取的 plain text，绝不是 PDF bytes，也不是 Analysis 接纳的 LiteratureContent；
- `download` endpoint 返回成功也仍需 hash、lineage 与 immutable publish；
- metadata 中的 license 只按明确关联的 Output/locator 保留，不能从 OA 聚合身份推断文件许可。

官方明确 anonymous 不提供 full text。本轮匿名 search 响应仍含 `fullText` key，但没有展示或依赖其内容；字段存在不代表匿名获得可用全文。没有请求任何 PDF/download endpoint。

## 9. 代表性搜索响应结构

2026-08-07 匿名 DOI 查询的精简 shape：

```json
{
  "totalHits": 1,
  "limit": 1,
  "offset": 0,
  "results": [{
    "id": 143262545,
    "title": "CORE: A Global Aggregation Service for Open Access Papers",
    "doi": "10.1038/s41597-023-02208-w",
    "authors": [{"name": "Herrmannova, Drahomira"}],
    "publishedDate": "2023-01-01T00:00:00+00:00",
    "yearPublished": 2023,
    "identifiers": [
      {"identifier": "10.1038/s41597-023-02208-w", "type": "doi"},
      {"identifier": "oai:oro.open.ac.uk:89835", "type": "oai"}
    ],
    "outputs": ["https://api.core.ac.uk/v3/outputs/571215426"],
    "downloadUrl": "https://core.ac.uk/download/571215426.pdf",
    "sourceFulltextUrls": ["https://oro.open.ac.uk/89835/1/article.pdf"],
    "links": [
      {"type": "download", "url": "https://core.ac.uk/download/571215426.pdf"},
      {"type": "display", "url": "https://core.ac.uk/works/143262545"}
    ],
    "references": []
  }],
  "searchId": "..."
}
```

现场响应使用 camelCase。当前 OpenAPI 的部分 schema/required 名称仍写 `total_hits`、`search_id` 或 snake_case Work properties，而同一官方文档表和实际 API 使用 camelCase；未来 adapter 必须以真实 v3 JSON、官方示例和 contract fixtures 明确版本，不能直接把 OpenAPI property 名机械反序列化。

## 10. 与 SciRetriever 中性数据的候选映射

| 外部字段 | 外部语义 | 候选归属 | 约束 |
|---|---|---|---|
| Work/Output `id` | CORE source record | provenance/source record | 不代替本地 Literature ID |
| `doi` / typed `identifiers[]` / arXiv/PubMed/OAI | 标识符 | `LiteratureMetadata.identifiers` | namespace 明确规范化；OAI/CORE ID 主要作 provenance |
| `title` / `abstract` | 聚合或来源文本 | `LiteratureMetadata.title` / `abstract` | 空值保持缺失；Work/Output provenance 不混 |
| `authors[]` | 来源/聚合作者名 | `LiteratureMetadata.authors` | 顺序/重复需直接测试；无明确 ORCID/ROR 不猜 |
| publication/type/language/publisher | 书目信息 | `LiteratureMetadata` 对应字段 | 区分 published/accepted/deposited/CORE timestamps |
| `journals[]` | venue title 与标识 | title 候选映射 `LiteratureMetadata.venue` | ISSN 等仅供 adapter 内部容器核对，不进入当前业务 Model；空对象不接纳 |
| `references[].raw` | 解析参考文献原文 | `MetadataObservation.reference_texts` | 每项保留来源与顺序 |
| reference DOI/CORE ID | outgoing 稳定目标 | `ProviderRelationObservation` | `current -> target`；每项独立；不自动建 Reference |
| `downloadUrl` / source URL / links | 获取线索 | `MetadataObservation.asset_hints` 候选 | direct/landing 分流；未下载、未验证 |
| Output license | 来源权利声明 | `AssetHint.license` 候选 | 只在与 locator 明确对齐时使用 |
| Work `outputs[]` | CORE 聚合成员 | provenance/身份证据候选 | 不自动建立本地 version/member 关系 |
| request/CORE timestamps | 观察上下文 | provenance | 不能替代 publication date |

纯 acquisition adapter 不能顺带保存 `fullText` 或 metadata；metadata adapter 形成 AssetHint 也不等于文件已下载。

## 11. 不进入业务 Model 的字段

- `searchId`、`totalHits`、offset/limit、timing/stats 与 token headers；
- 已弃用的 MAG `citationCount`、`fieldOfStudy`、`magId` 作为当前权威事实；
- CORE Work/Output/DataProvider 聚合图本身；
- thumbnail、reader UI、raw/history 内部表示；
- plain-text `fullText` 作为资产或 LiteratureContent；
- API key、session、完整 vendor payload。

## 12. 已知限制与待核对

- 当前 OpenAPI 与 live camelCase shape 有命名差异；Metadata adapter 以小型 Work/Output/search fixture 固定当前已接纳字段，后续字段扩展仍需继续核对。
- 当前公开分页只确认 offset/limit；深分页/scroll 的现行合同未找到公开依据。
- Work 作者去重/顺序、publishedDate 最早值选择与类型机器学习均是聚合决定，不能抹去来源差异。
- `references[].cites` 的方向和标识 grammar 缺少足够公开 schema，不用于关系。
- anonymous full-text policy 与响应保留 `fullText` key 不能混写；是否返回空值/提示文本应在 adapter 测试中只判断可用语义，不记录正文。
- 本轮没有注册或使用真实 key，没有请求 raw/fullText/download，没有下载真实 PDF 或用户语料。

## 13. 当前实现边界

当前 `core` 同时属于 Metadata 与 Acquisition allowlist。Metadata adapter 支持 Work search、
Work/Output 精确 lookup、outgoing references 和公开 AssetHint 转换；公开 `downloadUrl`、来源
全文 URL 与 landing link 由通用公开 Source 消费。

Acquisition 的 CORE 授权 Source 只在普通配置启用 `core`、固定凭据文件含 `api_key`，且
当前 Literature 的 MetadataObservation 带 CORE 自己生成的 `work:<id>` 或 `output:<id>`
record identity 时注册并适用。它在全部公开 Source 之后调用官方
`/v3/works/{id}/download` 或 `/v3/outputs/{id}/download`，不接受任意 DOI 或 publisher
字符串路由；204/404/410 是正常未命中，401、403、429、5xx 与 Network failure 分别作为
认证、entitlement、quota、service 与 access failure，不形成自动获取耗尽。200 仍必须
经过媒体类型、实际 PDF 字节、reader、页面树和 Storage 不可变发布检查。

Metadata 与 Acquisition 共用 `core/api` AccessScope 和相同保守本地 policy。当前实现对
429/服务失败施加共享保守退避，但 Acquisition client 尚未利用 CORE 自定义 rate-limit
header 的精确数值；这不影响 fail closed，不过后续可在不让 Acquisition 依赖 Metadata
模块的前提下抽取中性反馈解释器。受控 Browser 仍没有 CORE 生产站点规则。上述生产
接线只由离线 fixture/transport 与对象图测试验证，不表示真实账户或具体文献 entitlement
已经在线成功。
