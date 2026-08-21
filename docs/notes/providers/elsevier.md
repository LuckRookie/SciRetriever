# Elsevier

- 官方资料最后在线核对：2026-08-19
- 当前实现离线对照：2026-08-20
- 当前选择键：Metadata `elsevier`；Acquisition `elsevier`
- 供应商角色：Scopus/Elsevier 元数据查询，以及受产品订阅和授权约束的文章全文/对象获取
- 当前仓库接入状态：Scopus Search 与 Abstract Retrieval 的专用 Metadata adapter、Article/Object Retrieval 授权 PDF route，以及使用所选持久 Profile 的 ScienceDirect Browser route 均已进入生产 registry

## 1. 官方入口与证据

- [Elsevier Developer Portal](https://dev.elsevier.com/)：API 产品与账户入口。
- [API documentation](https://dev.elsevier.com/api_docs.html)：API 目录、WADL 与公开样例。
- [API key settings](https://dev.elsevier.com/api_key_settings.html)：配额、throttle 与产品授权说明。
- [Scopus Search API WADL](https://dev.elsevier.com/documentation/ScopusSearchAPI.wadl)：搜索参数、分页、view 与响应格式。
- [Abstract Retrieval API WADL](https://dev.elsevier.com/documentation/AbstractRetrievalAPI.wadl)：单条摘要/书目记录与 references。
- [Article Retrieval API WADL](https://dev.elsevier.com/documentation/ArticleRetrievalAPI.wadl)：按 DOI、PII 或 Article EID 获取文章 FULL 表示及其媒体类型合同。
- [Article Retrieval FULL XML example](https://dev.elsevier.com/payloads/retrieval/articleRetrievalResp.xml)：官方 FULL XML 中 `MAIN web-pdf` attachment EID 的静态响应样例。
- [Object Retrieval API WADL](https://dev.elsevier.com/documentation/ObjectRetrievalAPI.wadl)：按 object EID 取回对象并协商 `application/pdf` 的合同。
- [Authentication error example](https://dev.elsevier.com/payloads/authError.xml)、[quota error example](https://dev.elsevier.com/payloads/quotaExceeded.xml)、[resource-not-found example](https://dev.elsevier.com/payloads/resourceNotFound.xml) 与 [generic error example](https://dev.elsevier.com/payloads/genericError.xml)：官方 `service-error/status/statusCode` 错误 envelope。
- [Abstract Citation API WADL](https://dev.elsevier.com/documentation/AbstractCitationAPI.wadl)：按年引用计数/overview。

均为 `official`，2026-08-18 核对。公开 WADL、配额页和 payload example 可匿名读取；实际内容 API 要求 key，本轮只读取这些静态官方资料，没有读取本地凭据，也没有向内容 API 发送认证请求。

## 2. 认证、授权、配额与 throttle

Elsevier API key 必需，通常用 `X-ELS-APIKey` header。部分产品还支持 OAuth bearer、
`X-ELS-Authtoken` 或机构 token `X-ELS-Insttoken`；“key 可用”和“机构有相应 Scopus/
ScienceDirect 内容订阅”是两个条件，不能由一个端点的 HTTP 200 推断其它产品权限。

各 API 有独立配额，官方当前说明每 7 天重置。响应可提供：

```text
X-RateLimit-Limit
X-RateLimit-Remaining
X-RateLimit-Reset
```

当前官网列出的常用默认值：

| API | 周配额 | throttle | 其它限制 |
|---|---:|---:|---|
| Scopus Search | 20,000 | 9 req/s | 无 cursor 时最多访问 5,000 个结果；`STANDARD` 每页最多 200，`COMPLETE`/`COMPONENT` 最多 25 |
| Abstract Retrieval | 10,000 | 9 req/s | 单记录；view/entitlement 影响字段 |
| Article Retrieval | 50,000 | 10 req/s | 官方表中 TDM key 为 unlimited；内容权限另计 |
| ScienceDirect Search v2 | 20,000 | 2 req/s | 与 Scopus Search 是不同产品 |

这些是供应商默认值，不是 SciRetriever 应用级预算。429 既可能表示 quota exceeded，也可能是瞬时 throttle；实现需结合响应体/headers、重置时间和有界退避判断。key、token、机构身份和 usage headers 不进入业务 Model 或日志。

当前实现没有因为两项产品都叫 Scopus 而合并额度：topic search/probe 使用
`elsevier/api/scopus-search`，以 20,000/7 天 rolling window 为本地保守上限；单条 lookup
使用 `elsevier/api/abstract-retrieval`，以 10,000/7 天为独立上限。两者都采用单并发和
0.125 秒 start interval，略严于官方 9 req/s。rolling window 是对固定重置周期的项目
保守表达；实时 `X-RateLimit-Limit`、`Remaining`、`Reset` 和标准 `Retry-After` 只反馈到
实际请求的产品 scope，畸形或无 header 的 429/5xx fail closed。operator policy 可以同时
收紧两项产品，但不能放宽官方基线。

Acquisition 的 Article Retrieval 与 Object Retrieval 使用第三个独立 scope：
`elsevier/api/article-retrieval-object`。两步属于同一次内容获取链，当前进程保守共享
50,000/7 天窗口和单并发；最小 start interval 为 0.1 秒，对应官方 Article Retrieval
10 req/s 上限。`X-RateLimit-*`、`Retry-After`、429 和 5xx 只反馈到这个内容 scope，
不会借用 Scopus Search/Abstract 的额度，也不会因额度或临时错误切换 Browser 绕过。

历史 `verified`，2026-07-21：当时配置的一枚 key 对官方 API 最小请求返回 HTTP 200；与此同时，旧分层 acquisition 路径在两个真实样本上均超过外层 90 秒限制。这只证明该时间点 key/API 可达，以及历史 client/transport 存在 timeout 问题；不证明当前凭据仍有效、内容已授权，也不作为当前生产对象图或 route 准入的实现证据。本轮没有读取或复用该 key。

## 3. 元数据接口

### 3.1 Scopus Search

搜索 API 的资源形状由 WADL 定义，常用查询为 Scopus query syntax，`start`/`count` 或
cursor 控制分页，`view` 控制字段集。公开 JSON 样例顶层：

```text
search-results {
  opensearch:totalResults
  opensearch:startIndex
  opensearch:itemsPerPage
  opensearch:Query
  link[]
  entry[]
}
```

`entry[]` 常见字段：

- 身份：`dc:identifier`（常为 Scopus EID）、`eid`、`prism:doi`、PII、PubMed ID 等；
- 标题与描述：`dc:title`、`dc:description`、`subtype`/`subtypeDescription`；
- 作者：精简视图可只有 `dc:creator`，扩展 view 可有 `author[]`；
- 发表信息：`prism:publicationName`、`prism:issn`、`prism:eIssn`、
  `prism:volume`、`prism:issueIdentifier`、`prism:pageRange`、`prism:coverDate`；
- 来源扩展：`affiliation[]`、`authkeywords`；
- 引用与链接：`citedby-count`、`link[]`，其中 `@ref=full-text` 是 API/落地入口线索。

不同 `view`、记录类型和 entitlement 返回字段不同，adapter 不能依赖单一公开样例中的完整度。
`dc:creator` 的单一字符串也不能替代有序结构化 authorship。

`verified`，2026-08-18：一次由用户明确授权的最小只读 `config test elsevier` 使用 cursor
和 `COMPLETE` view，受控结构遥测显示 HTTP 200 顶层为 `search-results`，total、page count、
cursor 与 entry 均存在，但公开 offset 样例中的 `opensearch:startIndex` 缺失；Network、认证和
Search product 均已通过，原 adapter 因把该 offset 字段误作 cursor 必填而返回
`metadata-provider-unknown-shape`。此次探测没有保存或记录 response body、字段值、query、
cursor、`statusText` 或凭据。当前 adapter 因而按两种分页语义处理：cursor 是进度真相源；
`startIndex` 缺失时不猜 vendor offset，若可选出现则必须与本地已接收计数一致。

Scopus/Abstract 正常 JSON 与错误 JSON 不能只靠 HTTP status 区分。官方错误样例的中性结构为
`service-error.status.statusCode`；当前 adapter 只读取这个有界、白名单化的 code，不读取或记录
`statusText`。HTTP 200 下的 `AUTHENTICATION_ERROR`、`AUTHORIZATION_ERROR`、
`QUOTA_EXCEEDED`、`INVALID_INPUT` 和 `SYSTEM_ERROR` 分别转换成认证、产品授权、限额、查询拒绝
和可重试服务失败；精确 lookup 的 `RESOURCE_NOT_FOUND` 是正常 miss。未识别 code、畸形错误
envelope 与真正未知顶层仍保持 `metadata-provider-unknown-shape`，不会把未知响应伪装为空结果。

### 3.2 Abstract Retrieval

Abstract Retrieval 可按 Scopus ID、DOI、PII、PubMed ID 等单条取回，公开 JSON 样例顶层为
`abstracts-retrieval-response`，主要分区：

```text
abstracts-retrieval-response {
  coredata
  affiliation[]
  authors { author[] }
  authkeywords { author-keyword[] }
  item { bibrecord { head ..., tail { bibliography { reference[] } } } }
}
```

`coredata` 包含标题、标识符、摘要、publication/cover date、venue、卷期页、引用计数、链接等。`authors.author[]` 的顺序、preferred/given/surname、ORCID 与 affiliation references 可以提供结构化署名候选；只有明确可对齐的 ORCID/单位信息才能进入 Author。

`tail.bibliography.reference[]` 是文末参考文献集合。每项可能含：

- `ref-info.refd-itemidlist.itemid`：带 ID 类型的被引目标标识；
- `ref-authors`、`ref-sourcetitle`、`ref-publicationyear`、volume/pages；
- 原始或半结构化 `ref-fulltext`。

这些 references 属于获取该 metadata record 时返回的来源内容。当前 adapter 保留来源 reference text 和明确可规范化的 cited identifier，但没有暴露独立 reference-query capability；不能仅凭作者、标题和年份猜出权威 Reference，也不能把 bibliography 写成一次无边界的引用扩展。

## 4. 引用能力边界

- `citedby-count` 是来源计数，不是 citing-work 边列表，不能跨供应商相加或物化边。
- Abstract Citation/Overview API 按年份返回计数与 summary，不提供足以逐边建立 `ProviderRelationObservation` 的 citing work 列表。
- Abstract Retrieval bibliography 描述 outward references；只有显式且可规范化的 target ID 才能形成候选 observation，未匹配原文仍只保留为 reference text。
- 引用查询是 Metadata Provider 的可选 capability，不存在第三类 Citation Provider；若以后让 Elsevier 暴露独立 reference query，必须同步修改 capability matrix、责任文档和直接测试。

## 5. 全文、对象与主 PDF 链

### 5.1 Article Retrieval 与 Object Retrieval

Article Retrieval 接受 DOI、PII 和 Elsevier Article EID，内容可受 API key、机构订阅、
文章 entitlement 和 TDM 合同共同约束。WADL 当前给出以下资源族，并允许
`view=FULL`：

```text
/content/article/doi/{doi}
/content/article/pii/{pii}
/content/article/eid/{eid}
```

Article Retrieval WADL 的 HTTP 200 representations 明确同时包括 `text/xml`、
`application/json` 和 `application/pdf`。FULL XML 本身不是主 PDF，但官方静态 FULL XML 样例
明确包含：

```xml
<xocs:web-pdf>
  <xocs:attachment-eid>1-s2.0-S0014579301033130-main.pdf</xocs:attachment-eid>
  <xocs:filename>main.pdf</xocs:filename>
  <xocs:extension>pdf</xocs:extension>
  <xocs:web-pdf-purpose>MAIN</xocs:web-pdf-purpose>
</xocs:web-pdf>
```

Object Retrieval WADL 同时定义 `GET /content/object/eid/{eid}` 与
`Accept: application/pdf`。因此当前经过核实并实现的授权链是：

```text
Article Retrieval view=FULL + application/xml
  -> 只读取显式 MAIN web-pdf attachment EID
  -> 有 MAIN object：Object Retrieval application/pdf
  -> XML 不可解释或无 MAIN object：相同 DOI/PII/Article EID 的 Article Retrieval application/pdf
  -> TemporaryPdf
  -> 统一 PDF reader、页面树和不可变发布边界
```

这不是把任意 XML/object 冒充 PDF。Adapter 只接受同时具有 `web-pdf`、
`web-pdf-purpose=MAIN`、`extension=pdf`、PDF filename 和合法 attachment EID 的条目；
去重并保持响应顺序，排除 supplement、MMC、appendix、graphical 等对象。它不会：

- 根据普通 EID 或 PII 猜测 `-main.pdf`；
- 把普通 Scopus EID `2-s2.0-*` 当作 Article/Object identity；
- 接受任意 `<attachment>`、image、supplement 或 JSON `objects.object[]`；
- 用固定最小字节数、页数或正文阈值判断 preview/正文。

直接 Article PDF 不是由 DOI 模板猜出的公开 URL，也不是 Browser fallback。它只由已经通过强证据
准入的 DOI、PII 或 Article EID 形成当次私有 locator，并继续使用同一 Elsevier 内容 API scope、
credential origin、额度反馈和 `Accept: application/pdf` 合同。FULL XML 的 MAIN object 优先；
只有 XML 媒体类型冲突、畸形/不安全/未知 envelope 或没有 MAIN object 时才使用直接表示。可解析的
`service-error` 会先转换成 authentication、entitlement、quota、service、request failure 或
resource-not-found miss，不能以 direct PDF 绕过。

公开样例 JSON 顶层仍可表示为：

```text
full-text-retrieval-response {
  coredata
  objects { object[] }
  originalText
}
```

`originalText` 在 JSON 中可包含转义 XML；`objects.object[]` 可列举图像等附属对象及其引用。
这些普通结构仍不能自动等同为主 PDF。Adapter 区分：

1. Scopus `@ref=full-text` 链接：API 或 landing 候选，不保证媒体类型；
2. Article Retrieval XML/JSON：结构化全文或 locator 容器，不直接形成 `TemporaryPdf`；
3. 显式 `MAIN web-pdf` attachment EID：优先进入 Object Retrieval 的主 PDF locator；
4. 相同强身份的 Article Retrieval `application/pdf`：XML/object locator 不可用时的官方表示；
5. 其它 Object Retrieval 对象：图像、补充材料和未声明用途对象，不能升级成主文；
6. publisher landing：只形成安全的当次 route hint，不能由页面名称证明 entitlement。

配置存在 API key、Provider 接受 key、机构拥有 ScienceDirect 订阅和具体文章允许下载是四个
不同事实。可选 `X-ELS-Insttoken` 只表达机构 token；最终 Object 或 Article PDF 请求成功返回
`application/pdf` 才形成该对象或文章表示的授权下载候选，实际字节仍必须通过统一 PDF 接纳。
2026-08-18 的合同复核只读取公开 WADL/静态样例；没有为本次修复调用带凭据的 Article/Object
API、验证真实账户 entitlement 或读取响应正文。

## 6. 代表性响应结构

Acquisition 的官方 FULL XML 证据只需下列脱敏层级；实际 parser 使用 namespace 的 local
name，并拒绝 DTD/ENTITY、畸形 XML、冲突字段和无界 element 数量：

```text
full-text-retrieval-response
  coredata
    pii / pii-unformatted
    eid                         # 1-s2.0-* Article EID
  attachments
    web-pdf
      attachment-eid            # 1-s2.0-*-main.pdf
      filename
      extension                 # pdf
      web-pdf-purpose           # MAIN
```

公开 Scopus Search JSON 样例的精简形状：

```json
{
  "search-results": {
    "opensearch:totalResults": "1",
    "opensearch:startIndex": "0",
    "opensearch:itemsPerPage": "1",
    "entry": [{
      "dc:identifier": "SCOPUS_ID:...",
      "eid": "2-s2.0-...",
      "dc:title": "...",
      "dc:creator": "...",
      "prism:publicationName": "...",
      "prism:coverDate": "...",
      "prism:doi": "...",
      "citedby-count": "...",
      "link": [{"@ref": "full-text", "@href": "https://..."}]
    }]
  }
}
```

这是官方文档样例的层级摘录，不是本轮带 key 现场响应。数字常以字符串表达；转换必须显式并处理缺失/非法值。

## 7. 与 SciRetriever 中性数据的候选映射

| 外部字段 | 外部语义 | 候选归属 | 备注 |
|---|---|---|---|
| Scopus EID / `dc:identifier` | provider record identity | `Provenance.source_record_id` | 不代替本地 Literature ID |
| DOI/PII/PMID 等显式 ID | 文献标识 | `LiteratureMetadata.identifiers` | 按 namespace 规范化；不从 URL 猜 |
| title/description | 标题/摘要 | `LiteratureMetadata` | Abstract Retrieval 优先于精简 Search 字段 |
| publication/cover date、venue、卷期页 | 发表信息 | `LiteratureMetadata` | 区分 online/cover/publication date |
| `authors.author[]` | 有序结构化署名 | `Author[]` | 只接受明确对齐的 ORCID/affiliation；`dc:creator` 不足时不伪造 |
| `authkeywords.author-keyword[]` | 作者关键词 | `MetadataObservation.declared_keywords` 候选 | 不把 Scopus 分类词混入 |
| bibliography 原文 | 来源参考文献文本 | `MetadataObservation.reference_texts` 候选 | 保持来源顺序与 provenance |
| bibliography 显式 target ID | 来源结构化引用 | `ProviderRelationObservation` 候选 | 每个显式目标一条；当前无独立 citation key |
| `citedby-count` | 来源引用计数 | observation 计数字段候选 | 不生成边 |
| full-text/link/object locator | 资产线索 | `AssetHint[]` | 区分 landing、XML、image 与 PDF；逐项验证 |
| `MAIN web-pdf` attachment EID | 授权主 PDF object locator | 当次 `AuthorizedDownloadLocator` | 只在 Acquisition client 内使用，不进入 Literature 数据库 |
| 强 DOI/PII/Article EID + Article `application/pdf` | 授权主 PDF representation locator | 当次 `AuthorizedDownloadLocator` | 仅在 FULL XML 无可用 MAIN object 时使用；不是公开 URL 猜测或 Browser fallback |

## 8. 不进入业务 Model 的字段

- `opensearch:*`、cursor/start/count、query echo、WADL view、service timings；
- quota headers、key、OAuth/机构 token、entitlement 调试信息；
- 完整 vendor JSON/XML、Scopus 内部分析字段、author/affiliation 聚合实体图；
- `citedby-count` 推导出的伪引用边；
- `originalText` 原样塞进 MetadataObservation 或 Model；
- 由 link 名称、普通对象 EID 或 HTTP 200 猜测出的媒体类型和授权结论；
- Article/Object route hint、quota 状态、当次 entitlement 和下载候选历史。

## 9. 已知限制与待核对

- 最小只读 probe 验证了当前 key、Scopus Search product 和首个 cursor；后续隔离 Discovery 已连续读取 4 个 cursor 页并完成 100/100，确认真实 cursor 可以省略 offset-only `opensearch:startIndex`。这仍不验证 Abstract Retrieval 的全部字段变体或任意 Article/Object entitlement。
- 官方默认配额和 throttle 会变化，且可能按 API key、机构协议或 TDM 合同覆盖；运行时以 headers 与账户设置为准，默认值变化时必须同步 policy revision、Notes 与直接测试。
- `COMPLETE`/`STANDARD` 字段和每页上限不同；搜索翻页需直接测试 cursor 结束条件与 5,000 结果边界。
- 当前优先接纳官方 FULL XML 明确标记的 `MAIN web-pdf`，并只在 XML/object locator 不可用时使用同一强身份的官方 Article PDF representation；其它附件类型或 schema 变化不能通过放宽 parser 猜测兼容。
- ScienceDirect Browser 使用项目审慎的 20 秒文章启动间隔；当前 IP、机构协议和 live entitlement 未在线断言，challenge 只识别后停止。
- Citation Overview 不是引用边 API；不要把年度计数当逐条引用。

## 10. 当前实现边界

`src/sciretriever/metadata/providers/elsevier/adapter.py` 已实现显式 credential readiness、Scopus `COMPLETE` topic search/pagination、按 EID/Scopus ID/DOI/PII/PMID 的 Abstract Retrieval lookup、结构化作者/单位、关键词、bibliography 原文与显式 target ID、引用计数和安全 landing AssetHint 转换。

`src/sciretriever/acquisition/providers/elsevier.py` 另实现 Article FULL XML → `MAIN web-pdf`
attachment EID → Object PDF，并以 Article direct PDF 作为同一强身份的受控表示 fallback。API key 和可选 institution token 只作为绑定到
`https://api.elsevier.com:443` 的私有 header 进入 Network；Article/Object 共享自己的
内容 API scope，与 Scopus Search/Abstract scope 分离。PII、合法 Article EID、实际
ScienceDirect/linkinghub DOI landing 可以构成强访问证据；普通 Scopus metadata
observation 和 `2-s2.0-*` 不能。FULL XML 没有 MAIN object 或无法安全解释时，先尝试同一
强身份的官方 Article PDF representation；该表示正常 miss 后只保留当次 canonical landing、
PII 和 Article EID hints，且不写入数据库。lookup/download 的 Debug 只记录数值 HTTP status、
受控 `informational|success|redirection|client-error|server-error` 状态类别、representation、
envelope、disposition 与中性 failure kind，不记录 vendor status text、header、正文、locator、
URL/query 或 credential。

`elsevier-sciencedirect` Profile 当前同时为 API 与 Browser `production-ready`。生产规则
`sciencedirect-pdf@2` 只接受强 DOI/PII/Article EID，或经安全解析的 ScienceDirect landing；
DOI resolver 返回的 `https://linkinghub.elsevier.com` 是经审查的 landing alias，不会因为第一跳
主机名不同而跳过 Elsevier Browser route。规则精确允许 ScienceDirect、linkinghub、
`pdf.sciencedirectassets.com` 以及封闭的 Elsevier auth origin。它从 `/pdfft` 点击后的
response、download、popup、viewer 或 verified locator 中等待任一正文 capture，亦可接收 HTTP
attachment 或批准的 PDF CDN 候选，并在读取正文前排除 MMC、supplement、excluded 和
wrong-article。规则包含 entitlement/paywall、login、MFA/challenge、rate/IP/account-warning
等封闭页面状态；裸 403 记录为 access denied，只有明确 challenge 或 paywall 页面证据才分别
归为 challenge 或无文章权限，登录/challenge 只识别后停止。

Browser 使用当前机器正常网络出口，以及共享 persistent Profile/context 中独立的 `elsevier`
lane；组内并发 1，项目审慎最小文章启动间隔 20 秒。无 GUI Linux 使用 Xvfb。自动流程不导入或
读取 Cookie、不填写凭据，也不会通过 Browser 绕过 API quota、429、临时错误或 challenge；用户
只能在配置中心的独立显式动作中打开同一 Profile 的可见 Browser，自行处理获授权的认证。离线真实 Chromium 场景
覆盖外部 JavaScript、未批准 tracker 丢弃、`/pdfft` 点击后的跨 origin CDN redirect、HTTP
attachment、supplement/错文排除、Publisher lane 隔离与临时下载工作区清理。这些证据不证明
当前 IP、Profile 已登录、机构订阅或任意文章 entitlement。

2026-08-18 用户授权的隔离 Completion
已经让 27 个强证据目标进入真实 Article/Object route，其中 26 个交付 PDF，1 个在 lookup
阶段形成 `http-status`/missing representation 的 response-schema failure。补齐 status-only
telemetry 后，对该精确目标的另一次只读重试确认 lookup 返回 HTTP 400 / `client-error`；它不是
401 authentication、403 entitlement、404 normal miss、429 quota 或 5xx service failure。
在没有读取响应正文的边界内，当前只能保留为明确、非重试的 response-schema failure，不能猜测
更具体的 vendor 原因或把 400 放宽成正常未命中。该诊断没有读取或记录 response body、vendor
status text、header、URL/query、credential 或 PDF 字节；历史批次没有调用 Elsevier Browser，
所以不能作为 Browser 在线成功率证据。
