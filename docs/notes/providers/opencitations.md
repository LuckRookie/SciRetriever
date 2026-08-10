# OpenCitations

- 最后核对：2026-08-07
- 当前配置选择键：无；ADR 0014 已接受为目标 Metadata lookup/引用能力，当前尚未实现
- 外部角色：开放结构化引用边与基础书目元数据
- 当前仓库接入状态：完全未接入；无选择键、无 Protocol 注册、无 adapter、无 registry wiring

## 1. 官方入口与证据

- [OpenCitations Index REST API v2](https://opencitations.net/index/api/v2)：逐边引用、引用/参考文献计数、方向、字段、格式与限流。
- [OpenCitations Meta REST API v1](https://opencitations.net/meta/api/v1)：按 PID 取基础书目元数据、作者/编辑查询、字段与格式。
- [OpenCitations Access Token](https://opencitations.net/accesstoken)：token 申请、header 示例与自愿使用说明。

当前生产 API base 分别为：

```text
https://api.opencitations.net/index/v2
https://api.opencitations.net/meta/v1
```

以上为 `official`，2026-08-07 核对。当天匿名调用 Index 的 references、citations、reference-count、citation-count，以及 Meta 的一条 metadata，均返回 HTTP 200、`application/json`；下文 shape 为 `verified`。测试发现高被引记录的单次 citations 响应可非常大，因此没有继续做大响应调用，也没有下载 dump。

## 2. 认证、限流与格式

Index v2 与 Meta v1 当前均明确限制为每 IP 每分钟 180 次；大规模获取应使用官方 database dumps，而不是遍历 API。默认返回 JSON，也可按 `Accept` 请求 CSV；Meta 文档还支持 `format=json|csv`，且该 query 参数优先于 `Accept`。

官方 token 页面存在需要忠实保留的措辞差异：一处说应用代码“need to specify” token，但同页 FAQ 明确说 token “not compulsory”且“voluntary”，Index/Meta API 页面使用“encourage”。本轮匿名请求也仍成功。因此当前可确认的合同是：token 不是强制认证，但官方强烈鼓励应用使用；不能把它改写为匿名永久 SLA或强制认证。

当前 API 文档和代码示例稳定展示：

```text
authorization: <OpenCitations access token>
```

token 不得进入 URL、日志、异常、provenance、fixture 或 Notes。未来 adapter 只接收根级 configuration 从 `~/.sciretriever/credentials.toml` 私有读取并由 Bootstrap 注入的 token；不能自行申请、扫描或读取其它本机 token。

## 3. Index API v2

### 3.1 operations 与方向

| Endpoint | 外部语义 | SciRetriever 方向 |
|---|---|---|
| `/citation/{oci}` | 按 Open Citation Identifier 取一条 citation | 读取响应中的显式 `citing -> cited` |
| `/references/{id}` | 给定实体的 outgoing references | `current -> returned cited` |
| `/citations/{id}` | 指向给定实体的 incoming citations | `returned citing -> current` |
| `/reference-count/{id}` | 给定实体的 outgoing 数量 | 计数，不是边 |
| `/citation-count/{id}` | 给定实体的 incoming 数量 | `cited_by_count` 候选，不是边 |
| `/venue-citation-count/{id}` | ISSN 对应 venue 中实体的 incoming 总量 | venue 聚合分析，不进入当前 Literature observation |

当前文档给 citation/reference operations 列出的 bibliographic PID 包括 DOI、PMID、OMID；venue count 使用 ISSN。输入和响应中的 namespace 必须显式解析，不能仅按冒号或 URL 猜类型。

Index 文档没有为这些 endpoints 声明 page/offset/cursor 参数；响应是匹配边数组。现场的高被引响应说明“一个 endpoint 一次返回全部边”会直接冲击响应大小和内存预算。生产接入前必须验证是否有新的分页合同；在没有公开依据时不能私造分页参数。规模化任务应路由到受控 dump 流程，但 dump 尚不属于当前产品能力。

### 3.2 引用边字段

每条边当前返回：

```text
oci
citing
cited
creation
timespan
journal_sc
author_sc
```

`citing`/`cited` 各是一个字符串，可能同时包含空格分隔的 OMID、DOI、OpenAlex ID、PMID 等多个 PID。`oci` 标识 citation 本身，不是 Literature ID。需要为端点选取稳定、受支持的标识符集合，并把同一端的多个 PID 作为目标身份证据处理，不能为每个 PID 生成不同引用边。

当前官方 prose 还说明合并多个 Index 时字段值可能带 `[index name] =>` 前缀，并用分号组合；但官方示例与本轮响应均观察到没有前缀的 PID 字符串。adapter 必须以显式、受测 parser 处理这两种公开形态；未识别前缀不能静默写成 identifier。

`creation` 是 citing entity 的 publication date，不是 citation observation 的创建时间；`timespan` 是 citing/cited 出版日期间隔。`journal_sc`、`author_sc` 是派生自引标志。后三类值均不进入当前 `ProviderRelationObservation`；observed_at 仍取实际请求/来源导入时间。

每个响应元素最多形成一条独立 `ProviderRelationObservation` 候选，方向严格来自 `citing`/`cited`。count endpoint 或 `timespan` 不能补边；目标 Literature 未接纳时 observation 仍可独立存在，但权威 `Reference` 只有在两端具体 Literature 与 `ReferenceSupport` 均满足后由 Literature 建立。

## 4. Meta API v1

### 4.1 operations 与输入

- `/metadata/{ids}`：按一个或多个 bibliographic ID 取 metadata；多个 ID 用双下划线 `__` 分隔。
- `/author/{id}`：按 ORCID 或 OMID 查询该人署名的 bibliographic entities。
- `/editor/{id}`：按 ORCID 或 OMID 查询该人编辑的 bibliographic entities。

对 SciRetriever，按已知稳定 PID 的 `/metadata/{ids}` 是最窄候选。author/editor 反向搜索涉及全局人员实体与结果集合，不授权建立全局 Author identity，也不应仅因 OMID 相同而跨文献合并作者。

### 4.2 返回字段与字符串解析

`metadata` 返回 JSON 数组，每项字段为：

```text
id
title
author
pub_date
issue
volume
venue
page
type
publisher
editor
```

多个 PID 被压在 `id` 字符串中；`author`/`editor` 是分号分隔字符串，单项可形如 `Name [orcid:... omid:...]`；`venue`、`publisher` 也可能把名称与 `[issn:... openalex:... omid:...]` 等标识放在同一字符串。它们不是已经结构化的 Pydantic 业务对象，adapter 必须显式拆分并保留作者顺序。

ORCID 只有在同一 author item 的方括号中明确对齐时才是作者候选；OMID 是 OpenCitations Meta 实体 ID，不成为本地 Author identity。venue 方括号中的 ISSN/OpenAlex/OMID 只用于 adapter 内部解析、容器辨识和核对；当前 `LiteratureMetadata` 只有 venue 名称，没有 venue identifier 字段，这些值也不能塞入文献 identifiers。

Meta v1 不返回 abstract、author affiliation/ROR、language、keywords、license、OA 状态或 PDF locator；这些字段必须保持缺失，不从 title、venue、DOI 或其它来源猜测。它也不提供原始参考文献文本。

## 5. 代表性响应结构

2026-08-07 匿名 Index references 请求的首条精简形状：

```json
[{
  "oci": "06120343876-061901512048",
  "citing": "omid:br/06120343876 doi:10.1038/s41586-020-2649-2 openalex:W3099878876 pmid:32939066",
  "cited": "omid:br/061901512048 doi:10.1109/mcse.2007.51 openalex:W2035776949",
  "creation": "2020-09-16",
  "timespan": "P13Y",
  "journal_sc": "no",
  "author_sc": "no"
}]
```

计数响应的形状为字符串值，不应假设 JSON number：

```json
[{"count": "37"}]
```

2026-08-07 匿名 Meta metadata 请求的完整小型 shape：

```json
[{
  "id": "doi:10.1007/978-1-4020-9632-7 isbn:9781402096327 openalex:W4249829199 omid:br/0612058700",
  "title": "Adaptive Environmental Management",
  "author": "",
  "pub_date": "2009",
  "issue": "",
  "volume": "",
  "venue": "",
  "type": "book",
  "page": "",
  "publisher": "Springer Science And Business Media Llc [crossref:297 omid:ra/0610116006]",
  "editor": "Allan, Catherine [orcid:0000-0003-2098-4759 omid:ra/069012996]; Stankey, George H. [omid:ra/061808486861]"
}]
```

空字符串是外部缺失表示，必须规范化为缺失，不能当成有效 metadata。

## 6. 与 SciRetriever 中性数据的候选映射

| 外部字段 | 外部语义 | 候选归属 | 约束 |
|---|---|---|---|
| Index `citing` / `cited` | 一条 citation 两端的多 PID 集合 | `ProviderRelationObservation` | 一响应元素一条边；namespace 显式解析；方向不反转 |
| Index `oci` | citation identity | provenance/source record 候选 | 不进入 Literature identifiers |
| `citation-count.count` | incoming citation count | `MetadataObservation.cited_by_count` | 字符串转非负整数；不反推边 |
| `reference-count.count` | outgoing reference count | `MetadataObservation.reference_count` | 不与 reference text 数量强制相等 |
| Meta `id` | entity 多 PID 字符串 | `LiteratureMetadata.identifiers` | 仅接受项目支持且成功解析的 namespace |
| Meta `title` | 标题 | `LiteratureMetadata.title` | 空串视缺失 |
| Meta `author` | 有序作者字符串 | `LiteratureMetadata.authors` | 显式 parser；仅明确 ORCID；不建全局作者 |
| Meta `pub_date` | 来源出版日期 | `LiteratureMetadata.publication_date` / `LiteratureMetadata.publication_year` | 只按实际精度解析，不伪造月日 |
| Meta `type` | 来源文献类型 | `LiteratureMetadata.document_type` | 显式 vocabulary 映射 |
| Meta `venue` | venue 名称与 PID | 名称候选映射 `LiteratureMetadata.venue` | 方括号内 ISSN/OpenAlex/OMID 不进入当前业务 Model，仅供 adapter 内部核对 |
| Meta `publisher` | publisher 名称及来源实体标识 | `LiteratureMetadata.publisher` | 只保留名称；聚合实体 ID 不进入业务 Model |
| Meta volume/issue/page | 卷期页 | `LiteratureMetadata` 对应字段 | page 保留外部范围；不从页数推断 |
| 实际请求时间/数据版本 | observation 上下文 | provenance | `creation` 不是 observed_at |

OpenCitations 可以分别作为 citation source 和 metadata source 候选；接入一种能力不能暗中写另一种事实。尤其 citation adapter 不应顺带把 Meta 字段写入 LiteratureMetadata。

## 7. 资产能力

不适用。Index/Meta 当前公开字段不提供 OA/PDF locator、媒体类型或 license。OpenCitations 不能成为 asset provider，也不能从 DOI 拼 publisher PDF URL 或把 Web 页面当主 PDF。

## 8. 不进入业务 Model 的字段

- `journal_sc`、`author_sc`、`timespan` 等派生 citation analytics；
- OCI/OMID 的完整实体图、全局 author/editor 聚合身份；
- `format`、`json` transformation、排序/过滤等 API 表示参数；
- dump 内部格式和完整 vendor 行；
- token、rate-limit 运行信息；
- Meta 不提供但可能从别处推断出的 abstract、关键词、OA、license、affiliation。

## 9. 已知限制与待核对

- Index/Meta 覆盖由 OpenCitations 数据源决定，不应把缺边或缺 metadata 解释为文献不存在。
- Index endpoint 未公开分页，本轮已观察到高被引响应可很大；生产接入需先证明响应大小/超时预算和大规模 dump 路径。
- 文档对合并 Index 字段前缀的 prose 与当前示例/现场 shape 不完全一致；parser 需要双形态 fixture 和未知前缀失败语义。
- token 页面“need to specify”与“not compulsory/voluntary”措辞不一致；当前以非强制但强烈鼓励记录，后续需持续复核。
- token header 的当前稳定官方示例是 `authorization`；若其它页面出现 `access-token` 等文字，应在实施时再以官方 runnable 示例确认。
- 本轮没有申请/读取 token，没有下载 dumps，没有持久化 9.9 MB 的现场 citations payload 到仓库。

## 10. 当前实现边界

OpenCitations 已进入目标 Metadata 的稳定标识符 lookup 与可选引用能力，但不参加主题 DiscoveryRun，也不作为 Acquisition 来源；它仍不属于当前 schema v2 的 metadata 或 citation allowlist。仓库没有 OpenCitations 选择键、token 配置、PID/string parser、Index/Meta client、Protocol 注册、adapter、registry wiring 或 dump importer；当前业务流程不会调用 OpenCitations。迁移前 `citation` 名称不构成目标第三类 Citation Provider。
