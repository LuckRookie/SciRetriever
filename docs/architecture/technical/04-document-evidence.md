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
- 解析是独立阶段，建档不调用解析服务。

### 6.2 整理与叶块

按 [ADR 0041](../decisions/0041-arrange-then-per-page-proofread.md)，每个部分先整理，再对保留内容逐页校订。整理与校订都使用现有 `proofreading` 模型角色，不增加角色配置。

**来源和坐标**：

- 从不可变 `RawParse` 的中性区块直接构造 `ArrangementSourceBlock`，不经过会删除、合并或去连字符的 `cleanRawBlocks`。校验原始清单身份、字节长度、SHA-256、页数和资源闭包；页眉、页脚、书目等都保留到显式整理决定。
- 表格以原始 HTML 为 canonical text，其余以原始 text 为准，不同时计算两份正文。Markdown-only 输入保留原始子串，只有页归属唯一且顺序一致才进入整理。
- `page_index` 从 0 起始；字符坐标是 Unicode code point 的半开区间 `[start,end)`，不是 UTF-16 下标或 UTF-8 字节。`region` 继续采用 0–1000 的归一化区域；公开 `page-region-v1` 定位的页码仍从 1 起始，在表示边界转换。
- root ID 绑定 raw result 和原始定位；叶块 ID 绑定 raw result、root ID 与源区间，由宿主生成。拆分后的叶块连续且完整覆盖原块；空文字图片也有一个叶块和明确去向。归属或责任页变化不改变相同源区间的叶块 ID。

**去向**：每个最终叶块恰好归属或删除一次。骨架固定为 `title` 标题、`authors` 作者、`abstract` 摘要、`keywords` 关键词、`introduction` 引言、`methods` 方法、`results-discussion` 结果与讨论、`conclusion` 结论、`end-matter` 文末信息、`references` 参考文献、`additional` 附加章节。没有内容的章节留空；论文自己的标题文字保留为章节标题或小标题。附加章节的原标题引用现有标题叶块，不能由 Agent 新写标题。

作者章节只收姓名；单位、通讯作者、致谢、资助、利益声明、作者贡献、注释和文末支持信息进入文末信息。书目行不进入阅读正文，标题区的期刊、年份与 DOI 由元数据渲染。

删除理由为封闭枚举，不接受自由理由或“其他”：

| 值             | 含义                          |
| -------------- | ----------------------------- |
| `header`       | 页眉                          |
| `footer`       | 页脚                          |
| `interface`    | 页面界面杂项与链接标签        |
| `bibliography` | 期刊卷期页、DOI、日期等书目行 |
| `copyright`    | 版权句                        |
| `decoration`   | 装饰                          |

正文中夹带的版权句用 split 后 drop 对应叶块处理。整理不改任何原文字符；split、merge、caption、assign-page 都不代替唯一的去向。

**断段与合并**（规则版本 `paragraph-break-v1`）：

1. 按原始阅读顺序检查同一章节或同一附加组的正文文本叶块；跳过已删除内容及独立的脚注、图、表、图注，普通保留正文或标题会阻断跳过。
2. 前块最后一个非空白字符不在句末符号集合 `.?!:;。？！：；` 中；后块首个非空白字符是 Unicode 小写字母、数字或右括号、右引号时，生成候选。
3. 每条候选必须决定 merge 或 keep；keep 附 1–40 code points、无空白的一词理由。候选与 review hash 绑定当前操作集合，提交时重算；旧决定不能覆盖变化后的候选。
4. merge 只允许同一正文流的有序文本叶块，禁止重复成员、交叠合并或跨过普通保留正文。被跨过的保留图表、图注、脚注紧随合并段，不丢失或重复；图注仍有自己的去向，并挂接到保留对象。
5. 前叶块去掉尾部空白仅用于判断：若以 `-` 结尾，程序使用空 joiner 且保留原 `-`；其余 joiner 是一个空格。原文自身的空白不 trim。结构 joiner 与原文 payload 分开计量，逐叶校验保留 payload 与源区间逐字一致。

整理会话可查看任意页；文字层给出可能的页归属提示，原图是依据。assign-page 要求目标页等于依据页，宿主证明会话看过该整页；改变责任页时清除旧 bbox，不改 raw locator。操作草案由宿主保存；非法 ID、漏去向、断段漏决定、过时 review 或文字差异都退回同一会话修正。

### 6.3 逐页校订与复用

- PDF 页分类继续按可见字形区分 `text-layer`、`image-only`、`blank`；隐藏 OCR 不进入参照文字，页面原图始终是最终依据。
- 每个有保留叶块的页各建一个短 DSH 会话。会话只能读本页保留叶块、查看本页整图或局部放大、读本页可见文字层与疑点；不能访问邻页、已删除叶块或整理历史。文字层仍可包含被删除内容，疑点计算按出现次数扣除它们，不把它们作为待校订正文发送。
- 疑点为 missing、extra、token-mismatch 三类；页归属问题由整理处理。比较词和数字多重集，并保留乱码/控制字符提示，不把科学结论当作需要校订的内容。
- 改字只有 correct：叶块、原文半开区间、原文片段、替换文字、依据页和一词理由。允许叶块内空区间插入或删除文字；拒绝跨叶块、已删除内容、错误页、原文不符、交叠改字及破坏表格结构的操作。每条改字确定性映射回 raw root 与源区间。
- 每个有保留叶块的页都必须提交；没有改字时明确 no_change。宿主记录全部保留字符的读取覆盖和整页查看证明，crop 不能替代整页。每条原始及当前新增疑点都须处置：fixed 引用实际改字，draft-correct 或 uncertain 附一词理由。无法确定时保留原文，不因此失败。撤销草案产生的临时疑点随草案重算，原始疑点仍保留。
- 没有保留叶块的页返回 not-required，不要求空校订提交，也不调用模型。PDF 有可见内容而没有任何叶块时，同时产生不阻断就绪的 `page-content-missing` 问题和页码，供后续“需处理”投影与重新解析；不虚构正文叶块。
- `page_input_sha256` 绑定 PDF/raw 身份、本页分类与文字层、保留及已删除叶块、校订/疑点/页面工具方法和有效模型设置，不绑定全篇 arrangement ID。重新整理后，只重校页输入变化的页。成功页记录按键保存，命中时重验来源、覆盖、改字映射与重算疑点；失败页不作为成功缓存。返回历史页用量与本次新消耗时分别计量，复用页本次消耗为 0。

### 6.4 停止保护与受控上下文

整理和逐页校订服务不设每篇调用次数或 token 上限。保护规则版本为 `validation3-progress8-v1`：

- 同一校验问题集连续 **3 次**返回，停止该部分整理或该页校订。问题集按稳定 code 与 ID 排序去重后计算 fingerprint，错误措辞不参与；停下记录 fingerprint、issue_codes、实际次数与阈值。
- 连续 **8 次实际派发的模型调用**没有新进展，停止该会话。新进展是读到新的源字符、页面或参照窗口，或提交新的合法语义操作/疑点处置；重复读取、去掉再放回同一操作或只改理由措辞不计。压缩调用也如实计入实际调用。
- no-progress、validation-repeated 与 cancelled、模型异常、输入冲突、页面工具不可用、协议大小拒绝分别记录，不能把质量停止记成取消。失败派发后没有可靠 usage 时，token 为 null，usage_complete=false，不填成 0；所有已报告 usage 含压缩实耗。
- 读取窗口最多 20 项，按 JSON 编码后的字节数限界，工具文字回执不超过 16 KiB；大块用 code point 游标继续读。操作和处置由宿主分批保存，提交只引用当前草案，不重复传整篇全文。
- 使用 DSH 的 image_policy=latest，旧图在请求中换成文字占位。中性请求超过 384 KiB 的文字/图片字节窗口后，在当前工具批收尾处交回 DSH 显式压缩，再继续同一会话；模型上下文触发的原生压缩也保留。宿主草案、覆盖和用量不依赖压缩摘要，可用有界工具重新查询。协议原有请求/响应大小保护仍有效；这不是文献调用预算。

### 6.5 实现接入与文档表示

`archive/text-source.ts`、`archive/arrangement*.ts` 与 `proofread/{leaf-corrections,page-service}.ts` 已实现上述服务和严格合同。接纳检查点复用现有 ProofreadCache 接口，不新增表，也不写 archive_steps 或旧 document/structure 步骤。新整理审计投影校验保留文字，不是已发布 Markdown/DocumentVersion。

默认生产编排、六步入库、最终渲染/结构注释、元数据等后续读取、人工整理修改与传输入口尚待接入；本段服务不能被描述为已切换的 Web/CLI/MCP 建档。旧每篇上限的配置警告与启动前预计也属于后续接入，现有配置行为不因独立服务新增而自动改变。

目标文档表示由保留叶块和已记录改字确定性渲染，章节与图表注释从整理归属生成，仍独立绑定文档版本，不改变表示 hash；内容版本 = hash(文档版本, 结构注释)。历史已发布的 proofread-blocks-v1、结构 schema v2、page-region-v1 和固定证据保持读取，不能把旧记录交给新叶块 parser，也不自动重建历史版本。最终渲染、默认发布与历史读取切换另行验证。
