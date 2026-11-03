# 04 · 文档与证据技术设计

类型：规格
负责：建档、校订稿与算子输入（文档与证据合同）
状态：现行

[设计总览](../design.md) · [八模块技术导航](../technical.md)

本模块对应设计中的 **④ 文档与证据**。输入是③已接纳的材料；输出是可独立阅读的文本、结构和资源，以及绑定具体材料或文档版本的证据引用。

内部划分为 Parsing 解析转换和 Document/Evidence 表示与证据管理。Parsing 隔离外部 parser 协议，表示管理固定结构、版本和定位；二者经⑦发布，由⑤⑥及外部提取程序消费。读取已有材料不隐式解析，也不调用③补库。

当前实现发布 RawParse 与校订稿 DocumentVersion，原始材料证据无需先解析；校订表示证据固定具体版本，页码与区域定位已接入。表格单元级精确定位不在本轮范围。旧数据转换及当前工作树的集中验收尚未完成，不能把实现状态等同于发布完成。

本篇目录：

- [1. 模块边界与连接](#1-模块边界与连接)
- [2. 解析转换与中性结果](#2-解析转换与中性结果)
- [3. 可读表示与有界读取](#3-可读表示与有界读取)
- [4. 证据定位、版本与生命周期](#4-证据定位版本与生命周期)
- [5. 文档与证据验证](#5-文档与证据验证)
- [6. ADR 0037 目标形态：原始解析、校订稿与页码区域证据](#6-原始解析校订稿与页码区域证据)

## 1. 模块边界与连接

任务②明确启动转换；读取文献材料③，经存储⑦发布；知识⑤、查询⑥与外部调用方通过公开接口消费。

本篇按职责归并已有详细合同；示例中的现有类型与目标类型保持各自状态。文档归属不改变源码目录、事实所有权或当前公开 API。

## 2. 解析转换与中性结果

### 2.1 独立可读材料与证据的目标边界

按 [ADR 0026](../decisions/0026-agent-knowledge-and-human-collaboration.md)，解析是可独立请求的材料转换，用户和 Agent 无需等总结完成。Parsing 继续负责中性文本/资源与输入绑定；[文档与证据：可读表示与有界读取](#3-可读表示与有界读取)负责可读结构、稳定定位与被引用表示生命周期。

当前只保留 RawParse 和校订稿生产路径。解析失败不删除原始材料；旧结果只在一次性导入原始 Markdown 时校验。

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

### 2.5 现有 Markdown 的一次性登记

ParserResult 的执行器与发布器已删除。仅 `parsing/legacy-raw.ts` 可从已存在、已验证的旧结果登记 vlm-engine-markdown-only 原始解析；它不能调用解析服务、发布默认全文或伪造区块/坐标。原始字节、来源、图片闭包与 hash 均保留。若 Markdown 无唯一页归属，建档报告 needs-parse。

### 2.6 结构与发布

生产 RawParse 校验 PDF/资产绑定、页数、区块结构、资源引用、字节/hash 和有效解析参数。每个资产/profile 具有当前指针，旧版本按引用保护。发布前复检输入；后续建档失败不撤销原始结果。不用字数、页数或参考文献数量作为内容质量门槛。

### 2.11 TypeScript 运行接口与独立文档协作

`RawParserBackend.identity(profile)` 固定 parser/model/参数 hash，`parseRaw(request, profile, signal?)` 返回 `StagedRawParseOutput`：原始清单、区块、Markdown、被引用的资源和原始 v2 字节。请求中的 `withContent` 只允许在调用作用域内读取固定 PDF；不传路径、SQL 或凭据。

`RawParsingService` 复核 PDF hash/页数与返回绑定，按 asset/profile 互斥，逐 profile 发布或复用。两份解析可并发准备；数据库补全只把短发布操作交给提交队列。共享存储失败优先于同时发生的取消；任何失败不撤销 PDF 或其他 profile 的成功结果。

`DocumentProcessingService.parseDocuments` 请求为 `{ literature_id, asset_id, asset_sha256, profiles?, force? }`；未指定 profiles 时由服务采用 `parsing.archive_profile` 一种，`force=false`。回执只含固定 PDF 与逐 profile 的 raw ID/hash/状态/失败信息。旧 `mode`、默认文档 CAS 与 Document 回执已移除；不接受旧请求形状，不发布 ParserResult，也不改变默认阅读文档。

缺 PDF 或原始输入变化返回明确失败。解析不获取 PDF、不建档、不总结；用户显式发起的 `complete parser` 是允许先获取 PDF 的维护操作，仍停在 raw 边界。校订稿及默认阅读版本由独立校订文档发布操作负责。原始 PDF 与旧证据继续固定到原始 ID/hash，不能跟随 current 重定向。

### 2.13 Parsing 准备与发布

`ApplicationOptions.parsing: { rawParser }` 是离线测试注入端口；生产 backend 由 bootstrap 根据配置组装。`Application.rawParsing` 在具备 raw 存储 schema 与有效 parser 配置时存在，否则为 null。旧 `Application.parsing`、`ParsingService`、旧发布器和单结果转换接口已删除，历史 fixture 仅在 test 中组装。

当前 MinerU adapter 只接纳 ZIP，保留 v2、Markdown 和使用中的图片；旧 JSON 响应或缺失 v2 会失败，不尝试旧转换。所有 HTTP 请求经过共享 NetworkBudget；远程上传要求 exact-origin credential grant，每次请求重新授权，loopback 不附带远程凭据。RawParse 文件采用 create-if-absent，成功发布与 current profile 关系在存储 owner 中确认；失败保留已提交事实。

## 3. 可读表示与有界读取

### 3.1 责任、子能力与依赖

| 子能力        | 输入与输出                                        | 不承担的决定                      |
| ------------- | ------------------------------------------------- | --------------------------------- |
| 表示构建      | complete 校订稿 → DocumentVersion、结构与资源闭包 | 不执行外部 parser，不判断论文身份 |
| 结构浏览      | 精确版本 → 目录、段落/表格/资源条目、能力描述     | 不补造 parser 没有提供的结构      |
| 有界读取      | 版本、选择器、预算 → DocumentSlice、继续位置      | 不隐式重新解析、不调用模型        |
| 证据创建/解析 | 版本与位置 → EvidenceRef → 受校验内容             | 不断言科学解释正确                |
| 版本与依赖    | 已发布版本、默认关系、下游引用 → 可用性与保护     | 不接管原材料删除或下游数据集      |

Document/Evidence 只从 Literature/Acquisition 的公开只读面取得身份和资产，从 Parsing 取得已验证结果，通过自己的发布 Port 使用 Storage。Analysis、Q、外部提取器与人类阅读都使用同一个读取面；禁止各自解释 MinerU JSON、猜文件路径或直接查私表。

建议在模块内分离 builder、reader、locator 和 repository adapter。该划分用于隔离变化：新增 parser 不应修改 EvidenceRef 消费者，新增定位方案不应修改 Literature 身份算法。它不要求部署多个服务。

### 3.2 材料、解析结果与表示的区别

同一 PDF 的 Asset ID/hash 固定原始字节。RawParse 固定某次原始解析的区块、Markdown、资源、输入 hash 和解析身份；ProofreadVersion 固定校订内容。DocumentVersion 再固定结构与定位规则；重新分段、换 builder 或 locator scheme 都可能产生新表示，即使 PDF 不变。

| 对象                        | 身份依据                                                       | 变化时的处理                                     |
| --------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| MaterialRef                 | Literature、Asset ID、PDF hash                                 | 新字节创建新资产；不覆写旧字节                   |
| RawParse / ProofreadVersion | 输入资产、解析/校订输出与资源 hash                             | 不可变版本，current 指针独立更新，受有效依赖保护 |
| DocumentRef                 | document/version ID、representation hash、builder/locator 版本 | 新构建创建新版本                                 |
| default relation            | 文档到默认 DocumentVersion                                     | 独立 CAS 更新；旧引用不跟随变化                  |
| EvidenceRef                 | 精确材料/表示目标与 locator                                    | 引用不可被服务端静默改写                         |

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

校订稿生成 DocumentRef v2，绑定 Literature/Asset、proofread_id、校订内容 hash、builder/locator、正文/结构和资源闭包。每个 segment 保留区块 ID、UTF-8 范围、page/region、continuation regions、核对依据。只有页定位的区块不能伪造 bbox。

DocumentStructure 的 heading 由校订区块类型决定，正文里的 Markdown 标记不能意外生成目录。构建与读取共享正文 8 MiB、结构 16 MiB 上限，取消和输入篡改明确失败；长循环让出事件循环。默认版本更新是独立 CAS，失败仍保留已发布版本。索引失败不撤销文档。

EvidenceRef 固定材料或文档表示和片段 hash；定位必须在固定版本内复核，不能悄悄重绑 current。Web 跳转将内部页码转换为公开页码，区域核对复用经过验证的 PDF 原图；ID/hash 隐藏在技术详情，不作为阅读正文。

只读服务按请求持有有界核验作用域，关闭等待在途操作结束。原始解析、校订稿、文档、算子结果和外部回执的引用保护由存储 owner 执行。新路径不发布或读取旧 markdown-utf8-v1 默认文档；旧字节仅在一次性登记原始解析时处理。

## 5. 文档与证据验证

### 5.1 使用示例与验证

用户已有论文 P 的 PDF M1，未配置任何内部模型。调用原材料读取即可取得 M1，并创建文件级证据；要求表格第 3 行时若尚无可靠定位，返回能力缺口。用户明确启动解析后得到 D1，外部程序读取表 2 的表头、目标行和脚注，再将 EvidenceRef 与提取字段绑定。

之后重解析得到 D2，D1 的引用仍解析到原片段。若 D2 修正了 OCR，调用方可以重新提取并生成新候选，旧候选不会自动被改写。通过引用解析只说明对应内容真实存在，测量值解释与实验归属仍由下游判断。

直接验证覆盖：无模型原始材料读取、结构/资源有界读取、跨 UTF-8 边界、旧 cursor 拒绝、两类 EvidenceRef、资源闭包、hash 冲突、重解析后旧引用、发布/回收竞争和取消。测试用合成文档中已知的具体文本/单元，不能只检查返回了一个 ID。

## 7. 解析后的文章身份核验

落实 ADR 0029 的后续核验能力，不修改下载原则。`ArticleIdentityService.assess` 是对已有固定
DocumentVersion 的显式操作，复用 analysis 模型绑定；普通解析和查询不会隐式产生模型费用。
模型接收完整预算内解析文本及 segment ID，不接收目标元数据，提取文章自身标题、署名及标识符，
明确排除参考文献、正文引用和无法识别的材料。精确原文、字段值和片段 hash 均须可核对；
预算不足、模型失败或坏证据属于本次失败，不冒充信息不足。没有出版社专用规则或固定首页门槛。

Parsing 形成证据，`LiteratureArticleIdentityService` 比较当前元数据并接纳判断，Storage 只执行
不可变插入和绑定检查。同一命名空间的明确标识符冲突为 `conflict`，一致支持 `match-supported`；
没有稳定标识符时，规范化标题与至少一位完整署名均匹配才能支持。歧义或缺少证据保留
`insufficient-evidence`。这些是有证据的辅助判断，不是模型语义必然正确或科学结论正确的保证。

当前 catalog 的 `article_identity_assessments` 保存有限证据、模型方法和 provenance，绑定 Literature、
asset ID/hash、DocumentVersion/representation hash、metadata revision/hash；不保存 PDF/全文 BLOB。
当前标签仅投影与当前元数据、材料关系和校订文档对齐的判断；输入变化回到 `unverified`，
历史结果仍可按 assessment ID 读取。普通启动只接纳当前结构；不匹配的旧库须按[初始化与恢复指南](../../guides/upgrade.md)离线转换。判断不修改权威元数据/文献身份，不自动删除、失效或重新下载 PDF，不阻断后续加工。

调用及请求字段见[Agent 接口指南](../../guides/agent-interface.md)。离线流程和证据检查的通过
不能代替真实文献身份抽取质量验收。

## 6. 原始解析、校订稿与页码区域证据

本节规定原始解析到校订稿和可读文档的处理合同。原始解析、建档与算子分别显式发起。

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
- 完整建档以解析为第一步：部分缺少部署 profile 的原始解析时，编排先调用 `parseDocuments`（不强制重解析），已有解析直接复用；解析失败记为该部分整理步骤的问题，原因取解析的失败码。解析不写 `archive_steps` 行，只在任务中记 `task_steps` 与 `archive-progress` 事件（步骤名 `parse`），用时与页数仍在解析自己的尝试记录里。单独的解析操作保留。

### 6.2 整理与叶块

按 [ADR 0041](../decisions/0041-arrange-then-per-page-proofread.md)，每个部分先整理，再对保留内容逐页校订；整理按 [ADR 0048](../decisions/0048-single-pass-arrangement.md) 每部分一次整理请求、按需一次断段请求，校订按 [ADR 0047](../decisions/0047-single-pass-page-proofread.md) 每页一次请求、由程序防护把关。整理与校订都使用现有 `proofreading` 模型角色，不增加角色配置。

**来源和坐标**：

- 从不可变 `RawParse` 的中性区块直接构造 `ArrangementSourceBlock`，不经过会删除、合并或去连字符的 `cleanRawBlocks`。校验原始清单身份、字节长度、SHA-256、页数和资源闭包。全部原始区块保留在来源清单里；规则预处理只形成显式删除操作，不修改原始字节。
- 表格以原始 HTML 为 canonical text，其余以原始 text 为准，不同时计算两份正文。Markdown-only 输入保留原始子串，只有页归属唯一且顺序一致才进入整理。
- `page_index` 从 0 起始；字符坐标是 Unicode code point 的半开区间 `[start,end)`，不是 UTF-16 下标或 UTF-8 字节。`region` 继续采用 0–1000 的归一化区域；公开 `page-region-v1` 定位的页码仍从 1 起始，在表示边界转换。
- root ID 绑定 raw result 和原始定位；叶块 ID 绑定 raw result、root ID 与源区间，由宿主生成。拆分后的叶块连续且完整覆盖原块；空文字图片也有一个叶块和明确去向。归属或责任页变化不改变相同源区间的叶块 ID。

**去向**：每个最终叶块恰好归属或删除一次。骨架固定为 `title` 标题、`authors` 作者、`abstract` 摘要、`keywords` 关键词、`introduction` 引言、`methods` 方法、`results-discussion` 结果与讨论、`conclusion` 结论、`end-matter` 文末信息、`references` 参考文献、`additional` 附加章节。角色只供结构注释与算子选材，不决定渲染顺序或生成标题；论文自己的标题文字保留为章节标题或小标题。附加章节的原标题引用现有标题叶块，不能由 Agent 新写标题。

作者章节只收姓名；单位、通讯作者、致谢、资助、利益声明、作者贡献、注释和文末支持信息进入文末信息。书目行不进入阅读正文，标题区的期刊、年份与 DOI 由元数据渲染。参考文献表是内容，标题和每一条都归入 `references`，不能用 `bibliography` 删除；提示词与该理由的说明都写明这一点。2026-10-29 发现模型把 `bibliography` 理解成参考文献表，整表删除：1.9 的 5 篇真实样本中有 2 篇、P28 样本 1 篇因此在引用关系一步报 `references-missing`。

删除理由为封闭枚举，不接受自由理由或“其他”：

| 值             | 含义                     |
| -------------- | ------------------------ |
| `header`       | 页眉                     |
| `footer`       | 页脚                     |
| `interface`    | 页面界面杂项与链接标签   |
| `bibliography` | 期刊卷期页、DOI 等书目行 |
| `copyright`    | 版权句                   |
| `decoration`   | 装饰                     |

正文中夹带的版权句用 split 后 drop 对应叶块处理：页眉、页脚、页码以外的区块里，从 `©`、`(c) 年份`、Copyright 或“This article/journal is licensed”开始的一行，以及以“© 年份”结尾的块尾，由程序在该处预拆（`copyrightCut`），模型只决定各部分去向。整理不改任何原文字符；split、merge、caption、assign-page 都不代替唯一的去向。

**整理前预处理**（`page-chrome-v1`）：

- MinerU 类型 header、footer、page-number、aside 直接形成 drop，理由分别为 header、footer、footer、interface；footnote 是内容，不在此列。
- text 块整块在页面顶部 9% 内或底部 9% 内时，页码直接删除；同一边缘的归一文字不少于 4 个字母、至多 80 个词，出现在至少 3 页，或至少 2 页且占全文不少于 30%，删除；与 MinerU 已标页眉页脚文字相同且至多 25 词的也删除。归一键采用 NFKC、小写、连续数字换成 `#`，仅保留字母与该占位符。
- 删除操作附 `source=program` 与命中的 `rule`，仍参加“每个最终叶块恰好一个去向”的验证。已被程序删除的块不进入整理请求；人工恢复或文字锁所在原块优先，下一次整理会再次提供。书目和版权仍按显式整理决定；首页收稿、接受和发表日期保留为 end-matter。
- `ArrangementSourceBlock.pdf_geometry` 是可选的文字层度量：行数、PDF 点单位的行高与主字体字号、首行缩进/行高、末行占宽与主字体。使用 PDF 的真实页面宽高换算 0–1000 坐标；与解析页宽高比相差超过 2%、隐藏 OCR、旋转方向不可靠、无可见水平文字层或超过单页 20,000 个文字项时不做度量。不根据 MinerU 的框估计行宽。几何参与整理输入身份，不进入页校订缓存键。

**断段与合并**（规则版本 `paragraph-break-v3`）：

1. 按来源顺序检查正文文本叶块，不要求同章节或附加组；跳过已删除内容及独立脚注、图、表、图注，首页已归 end-matter、确定为单位/作者信息或日期的文字属于独立文章信息，不阻断跨页续接；其它保留正文或标题会阻断跳过。
2. 程序先判定版面边界：前块是本页/栏最后一块正文，后块是下一页/栏首块正文；或者中间只隔独立图、表、图注、脚注。文字为字母加连字符结尾、小写字母开头，或非句末标点结尾、小写字母开头，且双方均为正文而非标题、列表项、图注、参考条目/分图标签时，直接合并。程序合并记录 source、规则和候选依据，不请求模型。
3. 论文采用首行缩进（至少 5 个不短于 3 行的正文块可度量、其中至少 60% 首行缩进超过 0.8 个行高）时，句末标点结尾、末行占宽至少 93%、下块首行缩进小于 0.3 个行高、跨页/栏的组合新增为 layout 候选，交模型裁决；没有可用文字层不生成这一类候选。其余前块未以 `.?!:;。？！：；`（可带闭引号/括号）结束、后块非空的现有候选继续交模型。
4. 每条候选都有 merge 或 keep 决定；模型 keep 附一行理由（至多 120 code points）。候选与 review hash 绑定当前操作集合，提交时重算。没有待模型裁决候选时不发断段请求。
5. merge 仅允许有序正文叶块，禁止重复成员、交叠合并或跨过普通保留正文。跨章节合并后，各叶块原角色不变，合并段归前段所在章节，后章边界顺延到合并段后；图表、图注、脚注紧随合并段，不丢失或重复。
6. 前叶块去掉尾部空白仅用于判断：若以 `-` 结尾，使用空 joiner 且保留原 `-`；其余 joiner 是一个空格。原文空白不 trim。结构 joiner 与原文 payload 分开计量，逐叶校验原文与源区间逐字一致。

阅读顺序纠正已实现但默认关闭：仅在有可靠双/三栏与明显栏次序倒置时调整该版面带内的区块，图表跟随其上方正文；含糊页面保持来源顺序。真实双栏误序样本验证、Owner 确认前不在生产启用。

**整理与按需断段请求**（`arrangement-single-pass-v2`）：

- **整理请求**一次发出本部分未被程序删除的全部区块：短编号（按来源顺序 `r1`、`r2`…，程序预拆的部分为 `r5#1`、`r5#2`…）、类型、原始页提示、`title_level`、图片与表格的 `region`、完整原文。强制以 `submit_arrangement` 作答：`sections`（按阅读顺序连续、合起来恰好覆盖请求内全部区块的范围，每段一个角色；`additional` 注明自己的标题区块）、`headings`（章节标题或 2–6 级小标题，其余都是内容）、`drops`（区块或部分及封闭理由，优先于所在范围）、`captions`（图片或表格对象与图注区块）、`splits`（程序未预拆、且块内同时有要删和要留的文字时使用）。提示词以 `apps/server/src/archive/arrangement-service.ts` 的 `ARRANGEMENT_SYSTEM` 为准。
- 宿主把回答展开成 assign、drop、split、caption 操作，再执行上面的全部校验。同一图的多个对象可以共享完全相同的图注列表及类型；互相冲突的挂接、不属于 `caption` 类型的区块或已删除的对象不挂，被去掉的挂接记在整理检查点的 `caption_fixes`。
- **页归属**：保留叶块的词至少 4 个不同、且只在另一个 `text-layer` 页的文字层里全部出现（含次数）时，宿主加一条 assign-page，依据页即该页；`image-only` 页不作为目标。assign-page 要求目标页等于依据页，且依据页在本次的文字层证据页集合里（`evidence_pages`）；改变责任页时清除旧 bbox，不改 raw locator。人工也可以改页归属并锁定。
- **断段请求**：展开通过后，只对尚待模型裁决的断段候选再发一次请求，每条给出左块结尾与右块开头各 120 code points（不超过 200 的块给全文）、前块是否以连字符结尾、中间跨过的元素类型；强制以 `submit_breaks` 作答。相连的 merge 接成一条合并操作。没有候选时不发这次请求。提示词以 `BREAK_SYSTEM` 为准。
- **人工锁定**：锁定叶块的去向按人工决定，所在原块沿用人工版本的拆分；带人工文字修正的叶块若被模型删除，恢复为人工版本的去向。
- **退回与重发**：回答无法展开（编号不认识、范围重叠或漏块）或校验不通过时，问题以短编号退回同一请求，模型只能修正一次；再被拒，本部分整理停为 `model-failed`，`cause_code` 为 `arrangement-invalid`。请求没有得到回答（网络、服务或格式问题）时自动重发一次。
- **大小上限**：整理请求的输入 JSON 超过 384 KiB 时不发请求，停为 `request-too-large`；分段整理验证前，超长部分按此停下（ADR 0048 第 5 节）。
- 整理检查点为 `arrangement-checkpoint-v2`，保存快照、用量、文字层证据页与 `caption_fixes`；命中时重验快照并按证据页重验页归属。

### 6.3 逐页校订与复用

- PDF 页分类继续按可见字形区分 `text-layer`、`image-only`、`blank`；隐藏 OCR 不进入参照文字，页面原图始终是最终依据。
- 每个有保留叶块的页发**一次**请求（`page-review-guards-v1`）：整页原图、本页保留叶块（按阅读顺序编为 `b1`、`b2`…，带类型与原文）、程序算出的差异、图内文字叶块清单；人工锁定的叶块单列并注明不改。请求不含邻页、已删除叶块或整理历史，并强制以 `submit_corrections` 作答：改字列表（叶块、原文片段、改成什么、一行理由）与拿不准的地方（叶块、文字、理由）。宿主收到后把短编号换回真实 ID。
- 页请求按配置的并发数运行，默认与范围见[配置手册](../../guides/configuration.md#整理校订模型与停止保护)。完成次序不影响最终页码顺序；进度提交串行执行，required/accepted/reused/pending/failed 始终按已接纳状态计数。PDF 渲染保留内部队列，缓存及 SQLite 写入沿用共享 admission，接受后的缓存写入不因随后取消而丢失。
- **差异**：逐叶块把解析文字与本页文字层对齐（Ratcliff/Obershelp 序列匹配）。对齐前先去掉记号差异：NFKC、文字层的断行连字符、LaTeX 命令与 `$…$` 内的空白和上下标标记、连接号与弯引号。一个叶块的词在文字层中匹配不到 30% 时视为图内文字，单列为图内文字叶块；其余叶块匹配率合计不低于 90% 的 `text-layer` 页为可信页，发送逐处差异，否则不发差异，请模型对照原图校整页。只是分词不同的地方不算差异。
- **提示规则**以 `apps/server/src/proofread/page-review.ts` 的 `PAGE_REVIEW_SYSTEM` 为准，要点：照印刷原样转录，作者原文不改；不删内容，可疑的放进拿不准；不转写结构式中的原子与基团标签；破折号和引号按印刷，印刷是连字符的不改；印刷分开而解析粘在一起的单位拆开；图或反应式里的文字不进图注、表格和正文。
- 公式按印出的字符校订，不按写法校订。数学中的间距、LaTeX 与 Unicode 写法（`^{\circ}` 与 °、`\times` 与 ×）、`\mathrm` 与 `\text`、花括号和 `$` 位置都不算转录错误。改写时沿用周围写法：单位和元素符号用 `\mathrm{}`，多字符上下标加花括号，分开的单位写成 `\mathrm{mg}\,\mathrm{cm}`，`$` 成对。校订新增或改动的上下标，在正文和表格单元格里一律写成 LaTeX（`$^{7}$`、`$^{a,b}$`、`$\mathrm{Cs_2CO_3}$`），与 MinerU 自身写法一致；不写 `<sup>`/`<sub>` 标签（阅读器只在表格内放行这两个标签，正文中会原样显示），也不新造 Unicode 上下标字符。原有写法保持不动。
- **程序防护**逐条检查模型的改字，不通过的不应用：
  - 原文片段为空（G5）、不在该叶块里、叶块被人工锁定，拒收；
  - 新增版权或许可声明（G6），拒收；
  - 原文不少于 20 个字符而改后不到一半，或改后变短并少了数字（G2），拒收；
  - 连续插入三个以上原子或基团标签（G3），拒收；
  - `text-layer` 页上新增的连接号、破折号或弯引号，必须在文字层中前后相邻两词之间（不超过 8 个字符）印着；减号 U+2212 视同连接号与破折号；位置找不到也拒收（G7）；
  - 可信且没有未映射字形的页上（G1），新增的每个词、字母或数字必须是文字层在该处印的：以改字前后最近的已对齐词为锚点，一到两个字符的记号必须落在两锚点之间，更长的词允许两侧各多 2 个词；上下标里的内容只要求出现在该叶块对应的文字层里（文字层常把上标粘在前一个词后）；把一个粘连词拆开（`yielda` → `yield$^{a}$`）不算新拼写；找不到锚点时，三个字母以上的新词须出现在该叶块的文字层里；
  - 任何页上（G1b），新增的四个字母以上的词不在该处印的词里、却与那里某个词的相似度不低于 0.8，拒收；
  - 与已接受改字交叠或破坏表格结构，拒收。
- **标识符**（G4）：叶块里的 DOI、网址、邮箱不在文字层中、而文字层有一个相似度不低于 0.85 的同类标识符时，按文字层改正。
- 改字只有 correct：叶块、原文半开区间、原文片段、替换文字、依据页和一行理由。模型给的原文片段在叶块中出现多处时，每处都改。改字逐条试应用，冲突的那条拒收，其余照常；每条改字确定性映射回 raw root 与源区间。
- 页记录的 `review` 保存被拒的改字（叶块、原文、改成、规则、理由）与拿不准的地方；`suspects`、`dispositions` 为空；证据记录请求携带的全部保留叶块与整页图。`review` 只供诊断与人工查看，不进入阅读视图，也不形成可信度。ADR 0047 之前的页记录没有 `review`，照旧读取；人工改这类页时仍按旧规则重算疑点。
- 一页请求因网络、服务或格式问题失败时，自动重发该页一次；仍失败时该页为 failed，可以只重试该页。页面图渲染失败时不发请求，记 `page-tools-unavailable`。
- 没有保留叶块的页返回 not-required，不调用模型。PDF 有可见内容而没有任何叶块时，同时产生不阻断就绪的 `page-content-missing` 问题和页码，供后续“需处理”投影与重新解析；不虚构正文叶块。
- 显式 retry_page_indexes 只重试所选页；未选的未完成页保留原记录，本次不计执行或模型消耗，整篇仍须所有必需页完成。所选重试对应的方法已变时返回 input-stale，应重新检查完整页输入，不能沿用旧方法的局部提交。
- `page_input_sha256` 绑定 PDF/raw 身份、本页分类与文字层、保留及已删除叶块、改字方法、校订方法与提示词 hash、页面工具方法和有效模型设置，不绑定全篇 arrangement ID。重新整理后，只重校页输入变化的页。成功页记录按键保存，命中时重验来源与改字映射；失败页不作为成功缓存。返回历史页用量与本次新消耗时分别计量，复用页本次消耗为 0。

### 6.4 停止保护与受控上下文

整理和逐页校订服务不设每篇调用次数或 token 上限。保护规则版本为 `validation3-progress8-v1`。整理每部分两次请求、各只有一个工具，被拒的回答只能修正一次（6.2 节）；校订每页一次请求、一个工具。实际起作用的是“同一校验问题连续 3 次”与限流规则；下面关于无进展、读取窗口与压缩的规则保留在共用会话里，现在不会被整理或校订触发：

- 同一校验问题集连续 **3 次**返回，停止该部分整理或该页校订；中间有一次被接受的工具调用就重新计数。问题集按稳定 code 与 ID 排序去重后计算 fingerprint，错误措辞不参与；批量提交中格式不合法的项，以“字段名[序号].字段”作为 ID，告诉模型具体要改哪一项。停下记录 fingerprint、issue_codes、实际次数与阈值。
- 连续 **8 次实际派发的模型调用**没有新进展，停止该会话。新进展是读到新的源字符、页面或参照窗口，或提交新的合法语义操作/疑点处置；重复读取、去掉再放回同一操作或只改理由措辞不计。压缩调用也如实计入实际调用。压缩后模型需要重读草案才能接着做：上次压缩以来有过新进展时，压缩后重新计数；没有进展的压缩不重新计数，避免空转循环。
- 模型返回 429（适配器归一为 retryable agent-quota）时，在同一页、同一 DSH 会话重试同一请求，不追加重复用户输入。页调度与实际模型请求共用本次文献的递减额度，每次限流降一档，最少 1；遵守 Network 已限界的 Retry-After，全篇等待窗口取最大值。已在运行的页不撤销，其后续请求等待降档后的空位，新页也等空位。限流派发计 calls，不能作为无进展决定；usage.rate_limits 保存页码、服务等待提示、实际等待和降档前后额度。无可靠响应 usage 的 token 仍为 null，不推算限流请求用量。单页质量停止不取消其它页；用户取消才中断全部在途请求与限流等待。
- no-progress、validation-repeated 与 cancelled、模型异常、输入冲突、页面工具不可用、协议大小拒绝分别记录，不能把质量停止记成取消。失败派发后没有可靠 usage 时，token 为 null，usage_complete=false，不填成 0；所有已报告 usage 含压缩实耗。
- 工具回执只是确认或退回，不超过 16 KiB，不回传原文。
- 使用 DSH 的 image_policy=latest，旧图在请求中换成文字占位。中性请求超过 384 KiB 的文字/图片字节窗口后，在当前工具批收尾处交回 DSH 显式压缩，再继续同一会话；模型上下文触发的原生压缩也保留。宿主草案、覆盖和用量不依赖压缩摘要，可用有界工具重新查询。协议原有请求/响应大小保护仍有效；这不是文献调用预算。

### 6.5 生产编排、发布与历史读取

新建档固定执行 `arrange → proofread → render → metadata → references → tags`。整理和逐页校订都绑定 `proofreading` 角色。`archive/text-pipeline.ts` 组装 source、整理、逐页校订与接纳清单；检查点和页缓存继续使用现有不可变 artifact、校订版本和 raw pin，不另建业务库。新的写入请求为 schema 2；旧步骤与旧写请求返回 `archive-contract-obsolete`，不把 document/structure 当作新步骤别名。

render 从保留叶块及已记录 correct 确定性生成普通 Markdown、DocumentStructureV2 和叶块 UTF-8 source map。新 builder 为 `source-order-leaves-v3`；历史 `arranged-leaves-v2` 保留原骨架渲染算法，固定旧版本读取与 hash 校验不使用新排版。同一 proofread 的派生 Markdown 按 builder 与内容 hash 分别登记，文档发布核对实际资源 hash/path，不覆盖旧排版资源。保留 payload 恰好出现一次，标题标记、公式分隔符、合并接缝、资源语法和段落分隔单独记录；不插自定义指令、HTML 注释或固定角色标题。原文顺序决定章节顺序，同角色可分多段，原文没有标题的章节 title=null。

标题层级先依章节编号（1 / 1.1 / 1.1.1），其次依可见 PDF 文字层的重复字号/字体样式；至少 90% 标题有样式且嵌套一致率不少于 90% 才使用样式层级，否则沿用整理给出的层级。文末信息与参考文献标题固定同正文章节层级。首页单位、通讯作者/作者注释及收稿/发表信息仍归 end-matter，排在作者后；正文标题区的期刊、年份与 DOI 继续由 catalog 元数据在阅读层投影，不进入不可变正文。

同一图注的面板图片连续排列、图注紧随其后，结构记录图片行列；关系不明的无图注图片独立保留。紧邻已有标题表格、宽度相近而没有自己标题的续表合成一组。脚注有本页引用标记时放在首次引用段落之后；没有标记的留在原位置。独立内容不会插入合并段内部。

`DocumentStructureV2.layout`（可选 schema 1）保存 article_info 字节区间、figure_groups（figure/scheme/table 的对象及图注区间、segment ID、0 起始 row/column 和每行数量 rows）以及 footnotes（每条脚注区间、segment ID、0 起始 page_index）。区间均为固定校订稿 UTF-8 半开区间。文档 describe 原样返回可选 layout；outline 继续分页返回 title（string|null）、role、level 与起止字节。HTTP、CLI 与 MCP 共用同一读取合同，历史无 layout 的结果照旧读取。

结构注释采用独立 schema 2，直接从整理归属和图注挂接派生，role_source 为 arrangement 或 manual，不再调用章节分类模型。11 个新骨架角色与历史角色分别解码，不作名称映射。`body_content_leaf_ids` 记录真正具有保留正文 payload 的正文类叶块；纯标题不满足 READY。正文类角色恰为 introduction、methods、results-discussion、conclusion、additional。主文仍需完整校订、当前默认文档、派生注释、必需元数据与标签；补充材料和参考文献缺口不独自阻断主文。没有叶块的页所产生的 page-content-missing 是非阻断问题。

元数据按 [ADR 0045](../decisions/0045-archive-metadata-reads-whole-paper.md) 读取校订稿的全部保留片段，以及全部删除叶块的原始文字，删除叶块的角色写作 `dropped:<理由>`。后者带 raw parse、整理、源 span 和删除理由的专门证据，不冒充文档 segment。模型引用 `f1`、`f2` 等本次输入内的短编号，宿主按编号保存真实证据；输入上限为 4096 个片段、1 MiB。参考文献、标签、检索和算子使用固定文档的保留内容。内容版本仍为 hash(文档版本, 结构注释)，变更经现有事务内事件使下游结果过时，不隐式重算。

新旧校订稿发布都只等待全文索引刷新请求持久化，回执为 index_status=scheduled；不等待整库扫描，也不因索引失败撤销发布或阻断建档完成。排队、失败读取与显式重试见[检索技术篇](06-retrieval-context.md#49-材料-context-的实现边界)。索引状态与固定文档、注释和 READY 分开。

全文摘要读取器按 builder 分派片段覆盖校验：历史表示连续覆盖全文，新表示允许已验证渲染器生成的结构字节位于叶块片段之外。指定的算子角色在该版本注释中无法表达时，返回 `structure-role-unavailable` 缺口，不把空片段冒充完整阅读或自动映射旧角色。

历史 proofread-blocks-v1、结构注释 schema 1、DocumentStructureV2、page-region-v1 与固定证据继续按各自历史 parser 读取，不转换 hash、不自动重建。历史步骤单列为 legacy_steps；新步骤使用 schema 2 的回执与 archive-progress 事件。历史 document/structure 行保留，不能成为新写请求。

### 6.6 人工修改、并发与资源

`archive-arrangement` 提供摘要、保留/删除叶块、断段、source map 和有界页状态；固定 proofread ID 后继续游标。大块通过 JSON-UTF8 字节窗口无损续读，不能悄悄截掉原文。`archive-arrangement-edit` 以 proofread、arrangement 和 manual revision 做 CAS，原子恢复或重归属并锁定 destination。文字锁和 destination 锁各自保存，源 span 变化返回 manual-conflict，不按相似文本重绑。

人工操作不调用模型。页输入仍有效时确定性重渲染；恢复使保留页输入改变时保存决定、列出待校订页，保留上次完整固定文档，显式恢复建档才重校。Markdown 保存仅接纳能由 source map 唯一分解的叶块改字；无唯一来源边界时返回 typed mapping conflict，不发布无来源全文。人工改字也使用叶块 code point 范围并保留 raw 映射。

校订发布在同一事务内检查 current revision、manual revision 与当前 raw parse，登记资源并 pin 输入。缓存竞争采用首个已验证结果，竞争者的实际调用用量仍记录到本次 attempt；不修改既有 immutable 清单的 usage。默认文档与注释失败不撤销先前有效事实，完整输入与注释未接纳时不成立 READY。

### 6.7 Schema 与预计消耗

建档沿用 schema 12 引入的 archive_steps.step CHECK：接纳 arrange/render，并保留历史 document/structure。当前 catalog 的状态投影结构与版本见[存储合同](07-versioned-storage.md#41-当前-schema-与显式转换)，离线转换入口和顺序见[初始化与恢复](../../guides/upgrade.md#状态投影-schema-13)；打开旧库不自动迁移，转换不执行获取或模型工作。

`[proofread].max_calls_per_document` 不再生效；识别到字段名时不校验、使用或回显旧值，配置状态返回 configuration-option-removed、路径与固定删除说明，其它未知键仍严格拒绝。运行时停止条件见 6.4；协议大小限制继续有效。

usage-estimate 的建档分支为 ArchiveUsageEstimateV2，给出页数、复用篇数、六步的 calls/input/output 中位数和 P90、样本数与未知原因。只使用新流程、相同方法/模型绑定且 usage 完整的成功历史；不混用旧校订/结构分类数据。无历史返回 null，不以旧预算充当预计，也不阻止显式提交。render 和当前确定性参考文献步骤为零模型调用；组件分位数相加仅作展示，不承诺总成本分布。

完整复用与部分文本复用分别计算。原稿、方法、模型及人工决定均匹配时，已有整理的调用单元为零，已接纳或免校订页不计入预计待校订页，page_basis 为 accepted-arrangement；没有可复用整理时按全部 PDF 页保守估计。模型工作完成后缓存或发布失败，失败步骤仍保留本次实际 usage；成功页缓存的历史用量不重复计入新尝试。
