# 04 · 文档与证据技术设计

[设计总览](../design.md) · [八模块技术导航](../technical.md)

本模块对应设计中的 **④ 文档与证据**。输入是③已接纳的材料；输出是可独立阅读的文本、结构和资源，以及绑定具体材料或文档版本的证据引用。

内部划分为 Parsing 解析转换和 Document/Evidence 表示与证据管理。Parsing 隔离外部 parser 协议，表示管理固定结构、版本和定位；二者经⑦发布，由⑤⑥及外部提取程序消费。读取已有材料不隐式解析，也不调用③补库。

当前实现发布 RawParse 与校订稿 DocumentVersion，原始材料证据无需先解析；校订表示证据固定具体版本，页码与区域定位已接入。表格单元级精确定位不在本轮范围。旧数据转换及当前工作树的集中验收尚未完成，不能把实现状态等同于发布完成。

> 2026-10-21：[ADR 0037 第二版](../decisions/0037-literature-archive-and-proofread-text.md) 使用单一部署 profile 初稿、文字层找疑点与 DSH 看原图矫正；存疑不阻断就绪。当前边界见[§6](#6-adr-0037-目标形态原始解析校订稿与页码区域证据实施中)，实施与待验收项见[计划](../../plans/2026-10-20-literature-archive/README.md)。下文明确标为历史的 ParserResult/两阶段关系不属于当前生产入口。

本篇目录：

- [1. 模块边界与连接](#1-模块边界与连接)
- [2. 解析转换与中性结果](#2-解析转换与中性结果)
- [3. 可读表示与有界读取](#3-可读表示与有界读取)
- [4. 证据定位、版本与生命周期](#4-证据定位版本与生命周期)
- [5. 文档与证据验证](#5-文档与证据验证)
- [6. ADR 0037 目标形态：原始解析、校订稿与页码区域证据（实施中）](#6-adr-0037-目标形态原始解析校订稿与页码区域证据实施中)

## 1. 模块边界与连接

任务②明确启动转换；读取文献材料③，经存储⑦发布；知识⑤、查询⑥与外部调用方通过公开接口消费。

本篇按职责归并已有详细合同；示例中的现有类型与目标类型保持各自状态。文档归属不改变源码目录、事实所有权或当前公开 API。

## 2. 解析转换与中性结果

### 2.1 独立可读材料与证据的目标边界

按 [ADR 0026](../decisions/0026-agent-knowledge-and-human-collaboration.md)，解析是可独立请求的材料转换，用户和 Agent 无需等总结完成。Parsing 继续负责中性文本/资源与输入绑定；[文档与证据：可读表示与有界读取](#3-可读表示与有界读取)负责可读结构、稳定定位与被引用表示生命周期。

下文精确 ParserResult schema、单一当前关系和旧缓存策略描述现有/兼容路径。它们不得被解释为新架构禁止片段定位，或允许回收仍被有效知识引用的表示；新表示/schema 与兼容在实施前确定。解析失败不删除原始材料；TypeScript 生产 Analysis/completion 已不自动调用 NoUsableContent 清理，旧清理服务仅保留明确调用路径。

### 2.2 目标结构

```text
parsing/
  ports.ts
  raw-service.ts
  artifact-rules.ts
  legacy-raw.ts
  backends/
    mineru/
      index.ts
      http.ts
      health.ts
      profile.ts
      protocol.ts
      loopback.ts
      archive.ts
```

- `raw-service.ts` 按显式请求或部署 profile 组织调用、源 hash 复核、逐 profile 复用和不可变发布；
- `artifact-rules.ts` 检查 Markdown、资源、hash、页数、provenance 和输入对齐；
- `ports.ts` 声明 Parsing 与所有后端共享的 RawParserBackend 兼容性接口，以及 artifact 存取能力；
- `backends/` 按具体后端隔离私有协议，并转换为统一合同；每个后端拥有自己的子目录和导出入口。

`RawParserBackend` 是 Parsing 模块内部所有后端的稳定兼容性接口，不是动态第三方插件平台。`bootstrap` 根据已解析配置显式构造一个后端；未指定 profiles 时对同一 PDF 只运行 `parsing.archive_profile`，显式请求也可包含 pipeline 与 vlm-engine，分别保存原始解析；不自动选择其他后端回退。增加 GROBID、Docling 或 PyMuPDF 等后端时，只需在 `backends/<name>/` 实现该接口并完成同一组结构验收，Analysis 不需要理解新的输入格式。MinerU 只是当前的一个后端，不拥有 Parsing 公共合同。

### 2.3 输入与 RawParserBackend

Parsing 公开输入定位 Literature 中已经接纳的固定 PDF 资产（正文或补充材料）：

```text
ParserRequest
  source_asset_id: AssetId
  source_sha256: Sha256
  media_type: "application/pdf"
  withContent(consume, signal?) -> Promise<T>
```

`withContent` 是 Storage 提供的有界字节读取能力，不把机器绝对路径暴露给 backend。完整 `Literature`、元数据、供应商 URL、SQL row、Parser mode 和凭据不进入请求。后端选择、mode、模型和连接配置在 `bootstrap` 构造具体 backend 时固定。

逻辑 Port 为：

```text
RawParserBackend.identity(profile) -> parser/model/parameters identity
RawParserBackend.parseRaw(ParserRequest, profile) -> StagedRawParseOutput
```

`staged parser output` 只存在于 Parsing backend 边界，可以包含本次转换所需的临时 Markdown、资源和后端私有产物；它不是公共 Model，也不能直接持久化为产品事实。backend 在返回 Parsing service 前必须完成 vendor/service 类型隔离和初步协议验证。

Operator-managed MinerU 的 submit、poll、resume task 和归档下载仍属于 `backends/mineru/` 内部。外部 task ID 只服务当前尝试的有界恢复和诊断，不进入 `ParserRequest`、`ParserResult` 或 Catalog。

当前 production backend 锁定 MinerU 3.4.4、protocol 2、profiles `pipeline` 与 `vlm-engine`、分别对应 archive
backend `pipeline` 与 `vlm`，parse method `auto`。Bootstrap 从严格 `[parsing]` 读取 connection mode、
Base URL、model identity 与 remote upload consent；remote bearer token 从统一凭据文件读取并
与规范 origin 精确绑定，loopback 不读取 token。`config test parse` 复用同一 production
client 但只执行 health/release/protocol/profile 检查，不提交 task 或上传 PDF。

当前 TypeScript 接线中，`profile.ts` 就近保存固定版本、请求字段与转换规则版本；
`protocol.ts` 统一本机与远程的 health、multipart submit、poll 和 ZIP 下载，
`health.ts` 提供独立诊断和协议 client 共用的必需字段校验。`loopback.ts` 与 Bootstrap
中的远程运输层分别保持本机网络准入和逐请求凭据授权。未消费的外部扩展字段不会单独
导致失败；返回的 task URL 不用于导航，后续地址只由配置基址与已校验 task ID 构造。

归档转换从 middle 输出读取连续页数，由 Parsing service 与独立检查的输入 PDF 页数
交叉校验，不用 PDF 字节正则推测。资源以 Markdown 所在目录解析；公共资源引用继续
相对于发布的 Markdown。归档转换和 P2 接纳复用 Parsing 内部的资源发现与规范路径规则，
覆盖行内/引用式图片以及 HTML `src`/`srcset`，忽略代码与注释里的示例；正文与标题字节不因此改变。RawParse 清单固定输入、profile、parser/model/参数和产物 hash，不包含时间或任务 ID，相同输入、参数与结果可复用。

### 2.4 Backend 转换

不同 backend 使用自己的转换路径：

```text
MinerU Markdown/JSON/images ──> MinerUBackend ──┐
GROBID TEI                  ──> GROBIDBackend ──┤
Docling JSON                ──> DoclingBackend ─┼─> normalized Markdown + resources
PyMuPDF text/blocks         ──> PyMuPDFBackend ─┘
```

公共结果由通用文献读取、Document/Evidence 与 Analysis 的共同材料需求定义，不由 MinerU 私有输出定义，也不以总结完成为前提。backend 必须：

1. 验证自己支持的 Parser 版本、mode 和原始输出合同；
2. 恢复该 Parser 能稳定表达的阅读顺序；
3. 产生 UTF-8、非空的规范化 Markdown；
4. 把 Markdown 实际使用的本地资源改写为规范化相对引用；
5. 提供实际引用资源的字节、媒体类型、大小和 SHA-256；
6. 形成 parser identity、有效参数 hash 和输入 hash；
7. 隔离并在尝试结束后清理私有过程文件。

MinerU 的 VLM、pipeline 或其它 backend 是同一个 MinerU backend 的显式 profile。配置与返回声明不一致、版本不受支持或输出合同无法无歧义转换时稳定失败；backend 不根据 JSON 形状偷猜 mode，也不在一个 mode 失败后自动切换另一个 mode。只有未来真实输出合同出现不兼容时，才在 `backends/mineru/` 内增加版本或 profile 专属转换器，公共 RawParse 合同不由服务端私有格式决定。

### 2.5 ParserResult 精确合同

> ADR 0037：`ParserResult` 已由原始解析（含中性区块列表）取代，生产发布器已经删除。§2.5–2.10 记录迁移前存量事实的验证规则，不是新解析生产路径。见[§6](#6-adr-0037-目标形态原始解析校订稿与页码区域证据实施中)。

```text
ParserArtifactRef
  sha256: Sha256
  media_type: str
  byte_size: int

ParserResource
  reference: str
  artifact: ParserArtifactRef

ParserProvenance
  provenance: Provenance
  parser_version: str
  mode: str | None
  model_identity: str | None

ParserResult
  source_asset_id: AssetId
  source_sha256: Sha256
  page_count: int
  markdown: ParserArtifactRef
  resources: tuple[ParserResource, ...]
  result_sha256: Sha256
  provenance: ParserProvenance
```

#### 2.5.1 Artifact 与资源

`markdown` 指向已通过 Storage create-if-absent 发布的不可变 Markdown；其 `media_type` 固定为 `text/markdown`，实际字节必须是合法 UTF-8。`byte_size` 非负，`sha256` 与实际字节一致。Model 不保存 Markdown 正文、绝对路径或 Storage 私有 row。

`ParserResource.reference` 是 Markdown 中实际出现的规范化相对引用。它必须非空、使用 `/` 分隔，不能是绝对路径、父目录逃逸、反斜杠路径、带 userinfo 的 URL 或外部网络地址。相同 `reference` 只能出现一次；resources 按 `reference` 确定排序。每个引用都必须对应已经发布且 hash/大小/媒体类型一致的 artifact，未引用文件不得进入 `ParserResult`。

Parsing 只理解“Markdown 使用了这个资源”，不解释图片、表格或其它资源的科学内容。当前 Analysis 可以只读取 Markdown；资源的存在不等于已经支持多模态分析。

#### 2.5.2 Parser provenance

`ParserProvenance.provenance` 复用公共 `Provenance`：

- `source_kind` 固定为 `parser`；
- `source_name` 是稳定 Parser 名称；
- `source_record_id` 固定为 `None`；
- `observed_at` 是结果完成并被接纳的 UTC 时间；
- `input_sha256` 必须等于 `source_sha256`；
- `parameters_sha256` 必填，并覆盖 Parser 名称/版本、mode、model identity、影响输出的有效选项和 Markdown 转换规则版本。

`parser_version` 必填非空；没有 mode 或模型的 Parser 使用 `None`。Endpoint、secret、header、Cookie、GPU 编号、机器路径、task ID、原始参数字典和未脱敏错误不能进入 provenance。

#### 2.5.3 Result hash

`result_sha256` 对规范结果清单计算。清单包含：

- `source_asset_id`、`source_sha256` 和 `page_count`；
- Markdown artifact 的 hash、媒体类型和大小；
- 按 `reference` 排序后的全部资源引用和 artifact 描述；
- Parser 名称、版本、mode、model identity 和 `parameters_sha256`。

清单不包含 `observed_at`、`provenance_id`、task ID、endpoint、临时路径或 Catalog 相对路径。同一规范输入必须得到相同 hash；任何实际输入、内容、资源或有效解析配置变化都形成不同 hash。

#### 2.5.4 明确不进入合同的内容

`ParserResult` 不包含：

- MinerU `middle.json`、`content_list.json`、model output 或其它私有 JSON；
- GROBID TEI、DoclingDocument 或 PyMuPDF 私有 block；
- Markdown 正文的第二份数据库副本；
- page/block graph、bbox、逐段 `SourceLocator` 或 Parser 私有坐标；
- 摘要、正文、参考文献等业务章节判断；
- 内容可用性、confidence、完成状态、失败详情或外部 task 状态。

### 2.6 结构接纳

Parsing 只做结构与输入一致性检查：

- 当前输入 Asset 仍是调用时的主 PDF，ID/hash 对齐；
- PDF 可读取，物理页数至少为 1；
- Parser 调用和私有输出转换完整完成；
- Markdown 是合法 UTF-8、非空且不是纯空白；
- Markdown artifact 的 hash、大小和媒体类型对齐；
- 每个声明的本地资源引用安全、存在且 hash/大小/媒体类型对齐；
- 没有未声明的本地引用或重复 reference；
- Parser provenance 完整并与输入 hash 对齐；
- `result_sha256` 能够确定性复算；
- 提交当前关系前再次复检 current-PDF ID/hash，拒绝 stale 结果。

Parsing 不使用固定最小页数、固定最小字符数、标题匹配、摘要存在、公式数量或参考文献数量判断实际内容。内容是否支持某项分析由 Analysis 的对应业务用例判断；这不授予其决定已接纳原始材料是否保留的权限。

### 2.7 当前结果发布与替换

> ADR 0037：改为每个 (资产, profile) 一个当前原始解析，旧版本被校订稿引用时受保护。见[§6](#6-adr-0037-目标形态原始解析校订稿与页码区域证据实施中)。

每个输入 `Asset` 最多只有一个 Catalog 当前 `ParserResult`。发布流程为：

1. 在 owner-only staging 中完成 Parser 调用和转换；
2. 校验 Markdown、资源、provenance 和结果 hash；
3. 按内容寻址 create-if-absent 发布新的 Markdown 与资源字节；
4. 开启短 SQLite 事务，复检当前主 PDF ID/hash；
5. 原子新增或替换该输入 Asset 的当前 ParserResult 关系；
6. 提交后解除旧 ParserResult 的 Catalog 引用；
7. 旧兼容关系不保证完整历史；回收前必须考虑新 Document/Evidence 与知识产物的有效依赖，不能仅因失去 current 关系就删除。

新解析、转换、文件发布、stale 复检或 SQLite 提交失败时，只能观察完整旧结果或没有结果，不能暴露部分新结果。文件字节不原地覆盖；“替换”只表示当前数据库关系切换。旧 ParserResult 兼容关系不保存全部尝试历史；新增被引用表示的版本/来源由 Document/Evidence 生命周期合同明确，外部 task 现场不因此持久化。

当前 ParserResult 是可替换、可重建的解析产物，不推进 `UNREVIEWED`、`ASSET_READY` 或 `CONTENT_READY`。已经发布的当前 `LiteratureContent` 通过单一 Analysis provenance 的输入 hash 绑定 PDF、ParserResult 和最终 metadata；Parser provenance 由 ParserResult 自身保存，不复制到内容。旧 ParserResult artifact 不要求永久保留，后续重解析也不会自动覆盖当前 LiteratureContent，只有新的完整 Analysis 结果经 Literature 接纳后才能替换它。

### 2.8 私有过程文件与清理

> ADR 0037：改为保留 `content_list_v2` 转换出的区块列表、原始 v2 字节、Markdown、实际引用的图片与页面尺寸。见[§6](#6-adr-0037-目标形态原始解析校订稿与页码区域证据实施中)。

MinerU 的原始归档、`middle.json`、`content_list*.json`、model output、layout/span PDF、origin PDF 副本和未引用图片，以及其它 Parser 的 TEI、JSON、调试文件和未引用资源，全部位于本次 staging。成功接纳或尝试结束后清理，不进入 Catalog、ParserResult、provenance 或用户查询。

目标合同中 `NoUsableContent`、不适用、Parser 或 LLM 失败均不能单独触发已接纳 PDF/表示删除。当前 TypeScript 生产 Entry 已断开自动清理链；资产失效/删除须走独立 owner 规则。已接纳的有效 `LiteratureContent` 不由重解析失败、其它候选或引用 lookup 失败自动删除。

### 2.9 失败语义

- Parser 不可用、timeout、协议错误、版本/mode 不一致、私有输出错误、Markdown/资源验证失败和 stale 输入都属于解析失败；
- 解析失败保留当前主 PDF 和已经存在的完整当前 ParserResult；
- 单篇失败不影响其它目标；
- 外部 task ID 只在当前尝试的有界恢复中使用，retention 到期或服务不认识 task 时由本次尝试失败或重新提交，不形成产品状态；
- 诊断只保存有界、脱敏的目标级失败，不保存原始归档、用户正文、secret、task URL 或机器路径。

### 2.10 Backend 验收

每个生产 backend 必须使用同一组离线合同测试，至少覆盖：

- 普通文本、双栏、表格/公式、扫描型和带本地图片引用的代表性 PDF；
- 私有输出能够形成非空规范化 Markdown 和完整资源映射；
- 不同 Parser 产生同一公共 `ParserResult` 形状，Analysis 不需要识别 Parser 类型；
- 输入 hash、页数、parser identity、参数 hash 和结果 hash 完整对齐；
- 绝对路径、父目录逃逸、反斜杠、重复引用、缺失资源、hash/大小/媒体类型不一致被拒绝；
- 未支持版本、mode、未知结构、截断输出和资源预算超限稳定失败；
- 新结果完整成功后替换当前关系，任一失败点保留完整旧结果；
- Parser 私有产物和未引用资源不会进入 Catalog 或公共 Model；
- Parser 不产生 `LiteratureContent`、参考文献文本、`ReferenceLookup`、权威 `Reference` 或实际内容决定；
- Stale 当前主 PDF 拒绝提交，单篇失败不删除 PDF 或影响同批其它文献。

测试使用 fake Parser、恶意归档 fixture 和本地受控文件，不连接真实服务或用户语料。具体 MinerU 版本、后端可用性和 acceptance corpus 结果由 [MinerU Notes](../../notes/mineru.md) 记录，不反向成为公共合同。

### 2.11 TypeScript 运行接口与独立文档协作

`RawParserBackend.identity(profile)` 固定 parser/model/参数 hash，`parseRaw(request, profile, signal?)` 返回 `StagedRawParseOutput`：原始清单、区块、Markdown、被引用的资源和原始 v2 字节。请求中的 `withContent` 只允许在调用作用域内读取固定 PDF；不传路径、SQL 或凭据。

`RawParsingService` 复核 PDF hash/页数与返回绑定，按 asset/profile 互斥，逐 profile 发布或复用。两份解析可并发准备；数据库补全只把短发布操作交给提交队列。共享存储失败优先于同时发生的取消；任何失败不撤销 PDF 或其他 profile 的成功结果。

`DocumentProcessingService.parseDocuments` 请求为 `{ literature_id, asset_id, asset_sha256, profiles?, force? }`；未指定 profiles 时由服务采用 `parsing.archive_profile` 一种，`force=false`。回执只含固定 PDF 与逐 profile 的 raw ID/hash/状态/失败信息。旧 `mode`、默认文档 CAS 与 Document 回执已移除；不接受旧请求形状，不发布 ParserResult，也不改变默认阅读文档。

缺 PDF 或原始输入变化返回明确失败。解析不获取 PDF、不建档、不总结；用户显式发起的 `complete parser` 是允许先获取 PDF 的维护操作，仍停在 raw 边界。校订稿及默认阅读版本由独立校订文档发布操作负责。原始 PDF 与旧证据继续固定到原始 ID/hash，不能跟随 current 重定向。

### 2.12 历史 ParserResult 字段与约束

`ParserResult` 是历史库中保留的中性产物，生产端不再创建；它不是 `LiteratureContent` 或文献状态。以下两阶段关系专指当前 LiteratureContent 兼容用例。Analysis 先根据它形成结构化最终 `LiteratureMetadata` 提案，再把该元数据和同一 `ParserResult` 交给第二阶段形成内容 Markdown 草稿；`LiteratureContent` 由 Analysis 解析第二阶段草稿后形成，并由 Literature 与最终元数据整体接纳。第一阶段提案和第二阶段草稿都不是独立持久化 Model 事实。

`ParserResult` 的精确合同为：

```text
ParserArtifactRef
  sha256: Sha256
  media_type: str
  byte_size: int

ParserResource
  reference: str
  artifact: ParserArtifactRef

ParserProvenance
  provenance: Provenance
  parser_version: str
  mode: str | None
  model_identity: str | None

ParserResult
  source_asset_id: AssetId
  source_sha256: Sha256
  page_count: int
  markdown: ParserArtifactRef
  resources: tuple[ParserResource, ...]
  result_sha256: Sha256
  provenance: ParserProvenance
```

`page_count` 至少为 1；Markdown artifact 的媒体类型固定为 `text/markdown`，实际字节必须是合法 UTF-8。`resources` 只接受 Markdown 实际使用的安全相对引用，按 `reference` 确定排序且不能重复。Parser provenance 组合复用公共 `Provenance`，其中 source kind 固定为 parser、source record ID 为空、输入与参数 hash 必填；Parser 专属版本必填，mode/model identity 可以为空。`result_sha256` 的 canonical 清单和当前结果替换规则见 [ParserResult 精确合同](#25-parserresult-精确合同)。ParserResult 不接收正文副本、私有 JSON、block、bbox、source locator、内容决定或 task 状态。

### 2.13 Parsing 准备与发布

`ApplicationOptions.parsing: { rawParser }` 是离线测试注入端口；生产 backend 由 bootstrap 根据配置组装。`Application.rawParsing` 在具备 raw 存储 schema 与有效 parser 配置时存在，否则为 null。旧 `Application.parsing`、`ParsingService`、旧发布器和单结果转换接口已删除，历史 fixture 仅在 test 中组装。

当前 MinerU adapter 只接纳 ZIP，保留 v2、Markdown 和使用中的图片；旧 JSON 响应或缺失 v2 会失败，不尝试旧转换。所有 HTTP 请求经过共享 NetworkBudget；远程上传要求 exact-origin credential grant，每次请求重新授权，loopback 不附带远程凭据。RawParse 文件采用 create-if-absent，成功发布与 current profile 关系在存储 owner 中确认；失败保留已提交事实。

## 3. 可读表示与有界读取

### 3.1 责任、子能力与依赖

| 子能力        | 输入与输出                                            | 不承担的决定                      |
| ------------- | ----------------------------------------------------- | --------------------------------- |
| 表示构建      | 已验收 ParserResult → DocumentVersion、结构与资源闭包 | 不执行外部 parser，不判断论文身份 |
| 结构浏览      | 精确版本 → 目录、段落/表格/资源条目、能力描述         | 不补造 parser 没有提供的结构      |
| 有界读取      | 版本、选择器、预算 → DocumentSlice、继续位置          | 不隐式重新解析、不调用模型        |
| 证据创建/解析 | 版本与位置 → EvidenceRef → 受校验内容                 | 不断言科学解释正确                |
| 版本与依赖    | 已发布版本、默认关系、下游引用 → 可用性与保护         | 不接管原材料删除或下游数据集      |

Document/Evidence 只从 Literature/Acquisition 的公开只读面取得身份和资产，从 Parsing 取得已验证结果，通过自己的发布 Port 使用 Storage。Analysis、Q、外部提取器与人类阅读都使用同一个读取面；禁止各自解释 MinerU JSON、猜文件路径或直接查私表。

建议在模块内分离 builder、reader、locator 和 repository adapter。该划分用于隔离变化：新增 parser 不应修改 EvidenceRef 消费者，新增定位方案不应修改 Literature 身份算法。它不要求部署多个服务。

### 3.2 材料、解析结果与表示的区别

同一 PDF 的 Asset ID/hash 固定原始字节。ParserResult 固定某次已接纳转换的 Markdown、资源、输入 hash 和 parser provenance。DocumentVersion 再固定结构与定位规则；重新分段、换 builder 或 locator scheme 都可能产生新表示，即使 PDF 不变。

| 对象             | 身份依据                                                       | 变化时的处理                                                 |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| MaterialRef      | Literature、Asset ID、PDF hash                                 | 新字节创建新资产；不覆写旧字节                               |
| ParserResult     | 输入资产、转换输出与资源 hash                                  | 旧合同的 current 可替换，建立新 DocumentVersion 前须保护依赖 |
| DocumentRef      | document/version ID、representation hash、builder/locator 版本 | 新构建创建新版本                                             |
| default relation | 文档到默认 DocumentVersion                                     | 独立 CAS 更新；旧引用不跟随变化                              |
| EvidenceRef      | 精确材料/表示目标与 locator                                    | 引用不可被服务端静默改写                                     |

`document_id` 是一组表示的逻辑身份，`document_version_id` 是具体可读版本。它们不替代 LiteratureId，也不把预印本与正式版合并为一个“文本版本”。同 hash 的文件可被多个文献关系引用，来源关系继续分别保留。

### 3.3 表示合同

#### 3.3.1 DocumentRef 与结构清单

以下省略与模块契约重复的 branded ID 定义：

```ts
interface DocumentRef {
  readonly schema_version: 1;
  readonly document_id: string;
  readonly document_version_id: string;
  readonly representation_sha256: Sha256;
  readonly source_material_ref: DocumentMaterialRef;
  readonly parser_result_sha256: Sha256;
  readonly parser_provenance_id: string;
  readonly builder_version: string;
  readonly locator_scheme: "utf8-segment-v1";
  readonly markdown: ArtifactRef;
  readonly structure: ArtifactRef;
  readonly resources: readonly DocumentResource[];
}
interface DocumentMaterialRef {
  readonly literature_id: string;
  readonly asset_id: string;
  readonly asset_sha256: Sha256;
  readonly media_type: "application/pdf";
  readonly byte_size: number;
  readonly artifact: ArtifactRef;
}
interface DocumentResource {
  readonly resource_id: string;
  readonly reference: string;
  readonly artifact: ArtifactRef;
  readonly relation: "image" | "table-source" | "supplement" | "other";
}
```

表示 hash 覆盖输入绑定、parser result、builder/locator 版本、规范化结构、Markdown 与资源闭包；不包含机器路径、创建时间或默认关系 revision。hash 相同不自动合并业务身份或 provenance。

结构条目至少能定位章节和有序文本片段。表格、图片、图注与页码是明确能力，不是每个文档必填的假数据。无法可靠识别表格时可以返回原 Markdown 及 `table-structure-unavailable`，不能按空格随意切列。

#### 3.3.2 能力描述

能力按具体表示返回，不能以“配置了 MinerU”替代实际产物检查：

| 能力           | 成立条件                                  | 不成立时                             |
| -------------- | ----------------------------------------- | ------------------------------------ |
| text/outline   | 有经过验证的文本和可复核章节边界          | 返回不可读或无目录；允许全文文本读取 |
| resources      | 资源引用有实际对象且 hash/size 正确       | 指明缺失资源，不显示假图片           |
| table-context  | 能保持单元关系、表头、单位、脚注          | 返回原始片段并报告结构能力缺口       |
| figure-caption | 图与图注有可靠关系                        | 可分别读取，不能猜测配对             |
| page/bbox      | parser 或受支持原始材料定位器提供可靠映射 | 不返回虚构页码/坐标                  |

读取图片只是交付资源字节；图中数值识别属于提取策略。文档不能因为存在一张图就声明具有数值提取能力。

### 3.4 版本绑定的有界读取

建议读取面包括 `describe`、`outline`、`readSlice`、`readResource` 和 `resolveEvidence`。查询型操作不调用 builder 或 parser；表示不存在直接返回缺口。

```ts
interface SliceRequest {
  readonly document: DocumentRef;
  readonly selector: DocumentSelector;
  readonly max_bytes: number;
  readonly continuation: string | null;
}
type DocumentSelector =
  | { kind: "section"; section_id: string }
  | { kind: "range"; locator: DocumentLocator }
  | { kind: "resource-context"; resource_id: string };
interface DocumentSlice {
  readonly document: DocumentRef;
  readonly actual_range: DocumentLocator;
  readonly text: string;
  readonly evidence: readonly EvidenceRef[];
  readonly related_resources: readonly DocumentResource[];
  readonly truncated: boolean;
  readonly continuation: string | null;
  readonly gaps: readonly Gap[];
}
```

`DocumentLocator` 是按 locator_scheme 判别的封闭类型。不能接受 SQL、任意 XPath、文件路径或 parser 私有 JSON。版本/schema 不匹配在读取前拒绝；预算必须为合法正整数且不超过服务上限，精确上限由实现合同统一公布。

继续位置绑定版本、selector 与返回顺序，不能把上一版本 cursor 用于新版本。一个 slice 的文本、资源和 evidence 由同一固定版本组成。预算不足以容纳完整单元时返回截断和可继续位置；对大表格说明仅返回哪些行及重复的表头，不能伪称整表已读。

以字节作为基础资源计量。文本边界不能截断 UTF-8 字符；若公开文本 offset，locator scheme 必须明确采用 UTF-8 byte、Unicode code point 或其它单位，不能混用 JavaScript UTF-16 索引。token 预算需要声明 tokenizer，由 Q/Analysis 管理，不从字符数猜成准确 token。

## 4. 证据定位、版本与生命周期

### 4.1 EvidenceRef 的两种目标

> ADR 0037：来自校订稿的片段证据同时携带页码与区域（`page-region-v1`）。见[§6](#6-adr-0037-目标形态原始解析校订稿与页码区域证据实施中)。

```ts
type EvidenceRef =
  | {
      readonly schema_version: 1;
      readonly target_kind: "material";
      readonly locator_scheme: "material-file-v1";
      readonly material: DocumentMaterialRef;
      readonly locator: { readonly kind: "file" };
      readonly content_sha256: Sha256;
    }
  | {
      readonly schema_version: 1;
      readonly target_kind: "document";
      readonly locator_scheme: "utf8-segment-v1";
      readonly document_version_id: string;
      readonly representation_sha256: Sha256;
      readonly locator: {
        readonly kind: "segment";
        readonly segment_id: string;
      };
      readonly content_sha256: Sha256 | null;
    };
```

T01 中性合同的 Material 分支只允许文件级定位，不要求 ParserResult；Document 分支只允许固定版本的文本片段 ID。PDF 页/区域和资源定位须在后续单独定义 locator scheme 才可接入。解析依赖失效时不能自动退回 current 文档。`content_sha256` 只有定位可生成确定性内容时才填写，不能由调用方随意声明后不复核。

文件级引用说明“使用了这个文件”；字段级引用还需具体可复核位置。调用方要求每个数值有位置证据时，文件级引用应报告粒度不足。ReferenceSupport 表达论文 A 引用论文 B，与这里某个字段/断言来自何处不同，不能复用其表或业务含义。

当前提取准备会按调用方给出的有序 `input_id` 逐项绑定已接纳原 PDF 和可选精确 DocumentVersion。同一 Literature 的主 PDF 与补充 PDF 可各成一项，不能按 Literature ID 合并。尚无表示的输入仍可使用文件级证据；需要片段定位的规范只能得到对应能力缺口，不能把原件存在误报为片段可用。此准备只读，不触发解析、模型或材料获取。

输入准备对原文件实证字节与 hash；已接纳资产的字节损坏属于完整性错误，不降格为 `material-missing`。默认文档指向损坏表示也报完整性错误；只有没有默认表示时才列 `document-missing`。准备关闭先取消并等待在途验证与读取，再关闭 Document reader 和数据库。

证据解析顺序为：校验版本与目标判别 → 取得固定对象 → 检查资产/表示 hash → 按支持的 locator 解码 → 检查范围/内容校验值 → 返回原文/资源与精确范围。无论哪步失败都不做模糊搜索来“修好”旧引用。

### 4.2 构建、发布与重新解析

构建只由明确加工请求启动。应用层先固定 MaterialRef，再调用 Parsing；本模块接收完整 ParserResult，验证输入对应、资源闭包、结构引用与规范化结果。构建失败保留 PDF、旧 ParserResult 和旧 DocumentVersion。

准备新表示字节后，通过 Storage create-if-absent 发布；短事务登记版本、资源依赖与 provenance，最后按期望 revision 更新默认关系。取消发生在提交前时清理自身临时产物，提交后则返回实际已发布引用，不能报告“什么都没发生”。

重新解析相同 PDF 可以产生 D2；引用 D1 的知识产物继续读取 D1。新建默认关系不移动原 EvidenceRef。旧 ParserResult 的 current 表不保留全部历史，因此建立 D1 时必须将其实际依赖纳入新存储合同；不能只存一个未来可能消失的 current 外键。

### 4.3 保留、失效与外部证据

内部知识产物的依赖与外部交付引用都需要保护。回收只能处理 owner 明确允许、没有有效依赖且没有活动读者的对象。原材料按 Acquisition/Literature 规则处置，本模块不能从“无人查看”或“分析不适用”推出删除。

外部提取器收到证据后可能在任务结束后复核。候选 payload 不托管，不代表这些引用没有消费者。外部引用保护记录或明确有效性/失效政策尚需冻结；在此之前不能启用会删除这些目标的回收 writer，也不能承诺永久保存。

合法失效返回可识别状态与原因，保留 ID/hash 的解释能力；损坏与按政策失效不同。重生成得到同样文本也不能静默声称旧版本重新存在，恢复需要验证完整输入和表示身份。

### 4.4 失败分类与并发

| 情况                  | 返回语义                            | 禁止的替代行为       |
| --------------------- | ----------------------------------- | -------------------- |
| 无 Material/Document  | 缺少前置材料/表示                   | 自动下载或解析       |
| 不支持 locator/schema | 能力/版本不支持                     | 猜位置或忽略字段     |
| 范围越界              | 请求无效                            | 截到别处返回成功     |
| hash/资源不符         | 完整性失败                          | 返回最新版本或空文本 |
| 表格/坐标不可靠       | 能力缺口、实际可读片段              | 伪造单元/页码        |
| 预算不足              | 实际覆盖、截断、继续位置            | 声称全文已读         |
| 取消                  | 结束当前有界读取/构建、报告提交边界 | 撤销已发布版本       |

并发读固定各自版本；并发构建可以准备字节，但默认关系更新需 CAS。读取 pin 与长期依赖不同，必须与 Storage 回收协议共同验证，不能只在内存 Set 中记录长期保护。

### 4.5 M05-T01 已冻结的首版对象与规范表示

首版 `DocumentRef`/`EvidenceRef` 对象 `schema_version` 均为 `1`，与 Catalog v3、execution/runtime 子 schema v1 分别计数。T01 冻结合同、Catalog manifest 与显式迁移；T02 接通 Document writer 和结构 builder；T03 接通有界只读入口。

`DocumentRef` 由 `document_id`、`document_version_id`、`representation_sha256`、精确 `source_material_ref`、`parser_result_sha256`、`parser_provenance_id`、`builder_version`、`locator_scheme`、Markdown/结构 `ArtifactRef` 和按逻辑引用排序的资源组成。`source_material_ref` 固定 Literature ID、Asset ID/hash/大小/媒体类型及相同字节的 ArtifactRef。每个资源包含确定性的 `resource_id`、安全相对 `reference`、关系种类和 ArtifactRef；影响定位的 `resource_id` 与 `reference` 都进入表示 hash。结构是 `application/json` artifact，其 JSON v1 固定 `schema_version:1`、`text_encoding:"utf8"`、有序 `sections[]` 与 `segments[]`。章节包含 `section_id/title/level/start_utf8/end_utf8`，片段包含 `segment_id/kind/section_id|null/start_utf8/end_utf8`；kind 限定 `heading/text/table/caption`，offset 均为 Markdown UTF-8 byte 半开区间。T02 builder 须验证 ID 唯一、顺序、范围、边界与 Markdown 字节和资源闭包，并只声明实际可得的能力；T01 不假装已有可用结构或发布版本。

`documentRepresentationHash` 对现有 `canonicalJsonBytes` 的对象计算 SHA-256，覆盖对象 schema 版本、精确材料绑定、ParserResult hash、builder/locator 版本、Markdown/结构 artifact 描述，以及按 `reference` 排序的资源 ID、逻辑引用、关系和 artifact 描述。规范化 JSON 的 Unicode、数字、null、数组和键序由共享合同决定；资源重复引用/ID、不安全逻辑相对引用和不匹配的材料字节描述拒绝。机器相对存储路径、生成的文档/版本 ID、创建时间与 `parser_provenance_id` 不参与**内容 hash**。这几项仍分别由版本主键、Catalog 中不可变版本行、既有 provenance FK 和受控文件引用保存；来源行被版本 FK 保护，不能在旧清理时无声删除。ParserResult 既有字段与 `result_sha256` 算法保持原样。

首版 `EvidenceRef` 两个互斥分支：`material` 固定上述 MaterialRef，仅 `material-file-v1`/文件级 locator，以资产 SHA-256 作内容校验；`document` 固定版本 ID、表示 SHA-256、该版本的 `locator_scheme`、片段 ID 和可空内容 SHA-256。字段级/页码/bbox 仍无定位能力；未知 scheme 或无法复核的 locator 不降级到文件级，也不重绑 current。

### 4.6 M05-T02 已接通的独立解析与表示发布

当前 `Application.documentProcessing.parseDocuments` 只返回所请求 profile 的原始解析，未指定时使用部署 profile，见 §2.11。旧 T02 从 ParserResult 自动创建文档的入口、请求与回执已移除；可读文档由校订稿发布生成，已发布校订版本按固定 ID 读取。

`document_id` 从 Literature ID + Asset ID 确定派生；同一文献换主 PDF 后属于另一逻辑文档。`document_version_id` 从 document_id + representation hash 确定派生。重建相同规范表示复用同一版本与首次 provenance；重解析改变 ParserResult hash、Markdown/资源或 builder/locator 时产生新版本。当前文档选择先固定 current 主 PDF，再选择其 document_id 的 default；旧 document_id/版本只能用精确引用读取，不能静默改绑。

首个 builder `markdown-utf8-v1` 对经过 Parsing 资源闭包验收的 Markdown 按实际 UTF-8 byte 产生有序 heading/text 片段和 Markdown 标题章节。只将围栏/缩进代码之外的 ATX 标题识别为章节，CRLF 与多级章节按原字节范围保留；章节用栈线性收束。长文档构建定期让出事件循环并复核取消信号，定时取消不必等到整个同步循环结束。片段半开 offset 在合法 UTF-8 边界；不从图片或表格语法推测图注、表格单元、页码或 bbox。结构作为规范 JSON 不可变 artifact 发布，资源沿用 ParserResult 已验收的引用与字节，关系首版仅标 `other`。Document owner 在发布前复核 PDF、Markdown 和每个资源的实际 hash/size，结构 hash 与规范表示 hash；PDF 256 MiB、Markdown 8 MiB、资源 4096 个/单个 32 MiB/合计 128 MiB、片段 100000 个与结构 JSON 16 MiB 是当前上限，声明大小在文件读取前检查。

### 4.7 M05-T03 已接通的有界阅读和证据解析

`DocumentReadService` 仅依赖只读 SQLite worker、已验 FileStore 和 DocumentStorage 固定版本闭包。`createQueryApplication` 不构造 Parser、维护、Browser 或 Job；v1–v6 上的已接纳 PDF 可按 Literature ID + Asset ID 形成并复核 `material-file-v1` 文件证据，先核对业务关系与 Catalog artifact，再完整验证文件 hash/大小。调用方还可用 `withMaterialBytes({literature_id,asset_id,asset_sha256},consume)` 按显式稳定 ID/hash 取得主件或补充件的有界原 PDF 字节流；只读 HTTP `/api/v1/query/material-bytes` 复用该服务、同一受控打开文件的读取前后整件 hash/身份验证及响应背压。外部不接触机器路径或内部 FileStore；HTTP 不发送固定 `Content-Length`，只有末次验证成功才正常结束，错误或断连会中止流，调用方须复算完整字节 hash。大小上限 256 MiB，不建立分页游标或读取会话。v1/v2 仍受旧清理语义约束：目标若已被移除则返回 `material-missing`，不宣称有 v3 的禁回收保护。文档 default、describe、outline、segments、resources、slice、resource 和 document evidence 在完整 v3–v6 可用；没有表示返回 `document-missing`，查询不触发下载、解析或 schema 升级。v6 知识分析只消费这里固定的完整版本与片段 ID；超预算时拒绝，不能以部分读取伪称完整覆盖。

`describe` 只返回固定版本的小型身份投影、计数与真实能力；`outline`、`segments`、`resources` 每页最多 200 条。目录标题只在读取投影中截为最多 512 个 UTF-8 字节，并以 `title_truncated` 和 `outline-title-truncated` 标记；已发布结构和表示 hash 不变。`segments` 允许 `section_id: null` 读取全局片段，包括没有 ATX 标题的正文和首个标题前的引言。`slice` 在章节、片段或实际资源引用所在的 Markdown 片段内读取，单次最多返回 64 KiB UTF-8 文本和 32 条完整片段证据，使用合法字符边界与实际半开字节范围；证据达到 32 条时缩短本页文本、返回 `evidence-page-limit` 和继续位置，不遗漏正文。`resource` 单次最多返回 64 KiB 原始字节并以 base64 交付，仅允许 PNG/JPEG/GIF/WebP 和纯文本媒体类型。超预算部分由继续位置读取，不把大资源伪称不可读。完整性扫描仍按 PDF 256 MiB、Markdown 8 MiB、结构 16 MiB 和资源闭包各自的独立输入上限进行，64 KiB 是响应 payload 上限而非扫描上限。资源上下文当前只认定行首最多三个空格、单独成行的直接 Markdown 图片语法 `![标签](相对引用)`；转义图片、代码、HTML 注释/块、普通文字提及和其它无法可靠定位的引用均返回 `resource-context-unavailable`，不猜测来源片段。表格结构、图注关系、页码和 bbox 均报告能力缺口，不猜测单元或页码。

无状态继续位置含 kind、精确 version ID、representation hash、selector 和下一字节/条目位置及校验和；下一页可使用不同的合法 payload 预算，但每次重新校验固定版本和范围。校验和只用于拒绝误配或损坏的 cursor，**不是**授权签名；任何输入位置仍由服务端用固定结构验证。共享 `parseDocumentReadRequest/parseDocumentReadResult` 在边界复制、约束并绑定请求与响应；非法输入（包括畸形 cursor）与未知证据 scheme/schema 分别报告 `document-invalid` 和 `document-unsupported`，已接纳材料或表示的 hash 冲突报告 `document-integrity`。完整片段才签发带片段内容 hash 的 `utf8-segment-v1` 证据；部分 slice 只返回真实覆盖和继续位置。`resolveEvidence` 重验固定表示、定位与整个片段 hash，并对较长片段以 64 KiB 上限分块返回；材料证据只声明文件粒度。缺目标和完整性故障不重绑 default。查询 HTTP 协议 v1 与 TS 调同一 reader；同源 loopback 与断连取消沿用只读查询边界。人类 Query Web 从 Library 的已接纳 PDF 进入相同固定版本，提供全局片段、目录、资源翻页与缺口展示；选择片段后晚到的旧响应不能追加到当前正文，响应必须匹配所选 PDF 和固定表示后才显示文本或受限图片媒体。

合成 D1→显式重解析 D2 后，D1 的证据仍解析到 D1；v3/v4 旧物理回收返回 preserved。当前没有跨进程 GC pin 或外部引用登记，禁回收是旧证据稳定的实际前提；恢复回收必须另定同一准入下的长期依赖与活动读取协议。

原始解析请求在首个异步步骤前冻结，关闭时取消并结算活跃工作；HTTP 断连传递同一取消信号。新解析不会提交默认文档。校订文档的不可变发布与 default CAS 使用固定源资产/校订 hash，失败保留已有事实，详见 §6。

T02 的 `withPinnedVersion` 从 v3 一致快照读取固定版本与完整路径闭包，复算表示 hash、重建并比较 Markdown 的规范结构，再逐个复核源、Markdown、结构和资源的实际字节 hash/大小，把版本交给回调；各单次 verified file scope 不同时占用大量句柄。v3/v4 上旧物理回收和已接纳材料清理仍禁用，固定版本因此在回调期间不被产品回收。当前没有未来启用 GC 所需的跨进程读取 pin 协议。v1/v2 Document writer/reader 均拒绝，不在查询或读取时升级 Catalog。

## 5. 文档与证据验证

### 5.1 使用示例与验证

用户已有论文 P 的 PDF M1，未配置任何内部模型。调用原材料读取即可取得 M1，并创建文件级证据；要求表格第 3 行时若尚无可靠定位，返回能力缺口。用户明确启动解析后得到 D1，外部程序读取表 2 的表头、目标行和脚注，再将 EvidenceRef 与提取字段绑定。

之后重解析得到 D2，D1 的引用仍解析到原片段。若 D2 修正了 OCR，调用方可以重新提取并生成新候选，旧候选不会自动被改写。通过引用解析只说明对应内容真实存在，测量值解释与实验归属仍由下游判断。

直接验证覆盖：无模型原始材料读取、结构/资源有界读取、跨 UTF-8 边界、旧 cursor 拒绝、两类 EvidenceRef、资源闭包、hash 冲突、重解析后旧引用、发布/回收竞争和取消。测试用合成文档中已知的具体文本/单元，不能只检查返回了一个 ID。

## 解析后的文章身份核验（2026-10-08 实现合同）

落实 ADR 0029 的后续核验能力，不修改下载原则。`ArticleIdentityService.assess` 是对已有固定
DocumentVersion 的显式操作，复用 analysis 模型绑定；普通解析和查询不会隐式产生模型费用。
模型接收完整预算内解析文本及 segment ID，不接收目标元数据，提取文章自身标题、署名及标识符，
明确排除参考文献、正文引用和无法识别的材料。精确原文、字段值和片段 hash 均须可核对；
预算不足、模型失败或坏证据属于本次失败，不冒充信息不足。没有出版社专用规则或固定首页门槛。

Parsing 形成证据，`LiteratureArticleIdentityService` 比较当前元数据并接纳判断，Storage 只执行
不可变插入和绑定检查。同一命名空间的明确标识符冲突为 `conflict`，一致支持 `match-supported`；
没有稳定标识符时，规范化标题与至少一位完整署名均匹配才能支持。歧义或缺少证据保留
`insufficient-evidence`。这些是有证据的辅助判断，不是模型语义必然正确或科学结论正确的保证。

Catalog v9 的 `article_identity_assessments` 保存有限证据、模型方法和 provenance，绑定 Literature、
asset ID/hash、DocumentVersion/representation hash、metadata revision/hash；不保存 PDF/全文 BLOB。
当前标签仅投影与当前元数据、材料关系和 ParserResult 对齐的判断；输入变化回到 `unverified`，
历史结果仍可按 assessment ID 读取。旧库和旧详情继续保守读取；新写入需显式 schema 升级，
普通启动不迁移。判断不修改权威元数据/文献身份，不自动删除、失效或重新下载 PDF，不阻断后续加工。

调用及请求字段见[Agent 接口指南](../../guides/agent-interface.md)。离线流程和证据检查的通过
不能代替真实文献身份抽取质量验收。

## 6. ADR 0037 目标形态：原始解析、校订稿与页码区域证据（实施中）

本节描述 ADR 0037（第二版）的目标合同。双解析对齐与区块仲裁已被第二版取代。任务细节见计划 03–06。

### 6.1 部分与原始解析

- 文献的正文 PDF 与每个补充材料 PDF 各是一个**部分**，独立解析和校订。
- MinerU 适配保留 `pipeline` 与 `vlm-engine` 两种 profile。建档只需要部署选定的一种；另一种如果存在，只供人工查看。
- 每份不可变的 `RawParse` 包括：
  - 中性区块列表 `raw-blocks-v1`：页码、页内顺序、封闭类型、文字或 LaTeX、表格 HTML、图片引用、0–1000 归一化坐标；
  - 原始 `content_list_v2.json` 字节；
  - Markdown；
  - 实际引用的图片；
  - 页面尺寸。
- 页码与坐标只是定位提示，不作为正确性依据。
- 未知的 MinerU 类型会使转换失败，而不是被静默丢弃。
- 现有文献只有 VLM Markdown，登记为 `vlm-engine-markdown-only`，可以直接作为初稿；段落页归属由文字层确定，无法确定时需重新解析。
- 解析是独立阶段，建档不调用解析服务。

### 6.2 校订稿

**处理流程**：规则清理 → 页面分类 → 文字层找疑点（`text-layer` 页）→ DSH 看原图矫正 → 处置完整性检查 → 渲染。

- **页面分类**按 PDF 字形而非整套字体判断：有可见且能映射 Unicode 的字形为 `text-layer`；有绘图或字形但没有有效可见文字为 `image-only`，完全空白页独立标记。不可见 OCR 不进入参照文字。无隐藏字形时使用 PDF.js 的文字布局还原，不能把 TJ 字距微调当作空格；混合可见/隐藏页使用仅含可见字形的操作流。
- **疑点**：逐页比较文字层与初稿中归属该页的内容，以词和数字为单位，不做区块对齐。分为可能漏掉、可能多出或错字、数字单位化学式不一致、页归属错误四类。
- **矫正**：DSH 使用整页渲染、局部放大、相邻页和初稿片段读取工具。`text-layer` 页只处理疑点；`image-only` 页逐页检查。页面原图是最终依据；文字层只用来找疑点。矫正以编辑操作提交（替换、插入、删除、移动、调整页归属、标为存疑），每个操作注明依据页码，由程序应用并生成完整校订稿。
- **处置完整性**：每条疑点有处置（已修正、确认初稿无误并附原因、存疑）；每个 `image-only` 页有检查记录；编辑操作和图片引用有效；删除文字层中存在的内容必须附原因。应用后重新比较，新差异在现有预算内继续处理；续跑复用页面缓存，当前稿与分页文字同步。相同内容和未处置问题反复出现时停止，编辑说明换了措辞不代表进展。

**`ProofreadVersion`** 记录：
- 输入：一份原始解析与该部分的 PDF；
- 方法版本：清理、页面分类、疑点比较、矫正任务；
- 人工决定；
- 状态：`complete`、`incomplete`（处置未完成，可继续）或 `failed`；
- 区块列表；
- Markdown 及资源闭包；
- 页面分类、疑点及其处置、存疑清单、调用统计。

**每个区块**包含：
- 稳定 ID；
- 页码、区域（或仅定位到页）；
- 类型；
- 最终文字；
- 文字来源：`parser`、`rule`、`agent`、`manual`；
- 核对依据：`text-layer`、`image-only`、`uncertain`、`manual`；
- 存疑说明（如有）与相关编辑操作引用。

校订只检查抄录保真，不认证全文正确。存疑不使该部分失败。失败只在缺少原始解析、某页有内容但校订稿完全没有对应内容且无处置、矫正任务异常中止时发生。

### 6.3 文档表示与定位

- 文档表示 `proofread-blocks-v1` 由 `complete` 状态的校订版本构建，结构 schema v2 的每个片段对应一个区块，并携带页码、区域、来源、核对依据与存疑说明。
- 新增定位方案 `page-region-v1`：片段 ID 加页码和区域，解析时逐项校验，不做模糊匹配。
- 校订版本构建成功后成为该部分的默认文档；旧版本可按精确引用读取。
- 疑点、处置与矫正记录只供人工查看，不进入算子上下文；片段的核对依据与存疑说明随片段提供给算子。
- 算子结果中的值按 ADR 0037 第 10 节做用时核对，核对结果（`text-layer`、`image-checked`、`uncertain`）记录在值上。

### 6.4 结构注释

- 章节角色与图表清单单独保存为结构注释，以文档版本和方法版本为键，不改变表示 hash。
- 规则识别优先，模型兜底；人工修正的角色会被锁定。
- 内容版本 = hash(文档版本, 结构注释)。
