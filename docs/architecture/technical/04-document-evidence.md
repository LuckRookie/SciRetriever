# 04 · 文档与证据技术设计

类型：规格
负责：建档、校订稿与算子输入（文档与证据合同）
状态：现行

[设计总览](../design.md) · [八模块技术导航](../technical.md)

本模块对应设计中的 **④ 文档与证据**，交付需求的[读1 可信的全文文本与读3 Agent 的读取](../requirements.md#32-读人和-agent-都能读到每篇文献的全文)。输入是③已接纳的材料；输出是可独立阅读的文本、结构和资源，以及绑定具体材料或文档版本的证据引用。

按 [ADR 0060](../decisions/0060-two-level-full-text.md)，全文文本分两级：

- **初稿**：原始解析经程序规则清理，再与 PDF 文字层做程序对比。不调用模型。
- **校订稿**：在初稿上做整理和逐页校订，即第 6 节的建档。

两级文本都可以阅读、查找和加工，并标明等级。

内部划分为 Parsing 解析转换和 Document/Evidence 表示与证据管理。Parsing 隔离外部 parser 协议，表示管理固定结构、版本和定位；二者经⑦发布，由⑤⑥及外部提取程序消费。读取已有材料不隐式解析，也不调用③补库。

当前实现发布 RawParse 与校订稿 DocumentVersion，原始材料证据无需先解析；校订表示证据固定具体版本，页码与区域定位已接入。初稿还不是可读的文本：它只在建档内部作为整理的输入存在，与文字层的对比只在逐页校订请求里临时计算。初稿的形成、文本等级的标注和按等级的加工准入是目标合同，见[第 8 节](#8-目标接口尚未实现两级文本)。表格单元级精确定位不在本轮范围。旧数据转换及当前工作树的集中验收尚未完成，不能把实现状态等同于发布完成。

本篇目录：

- [1. 模块边界与连接](#1-模块边界与连接)
- [2. 解析转换与中性结果](#2-解析转换与中性结果)
- [3. 可读表示与有界读取](#3-可读表示与有界读取)
- [4. 证据定位、版本与生命周期](#4-证据定位版本与生命周期)
- [5. 文档与证据验证](#5-文档与证据验证)
- [6. 原始解析、校订稿与页码区域证据](#6-原始解析校订稿与页码区域证据)
- [7. 解析后的文章身份核验](#7-解析后的文章身份核验)
- [8. 目标接口（尚未实现）：两级文本](#8-目标接口尚未实现两级文本)

## 1. 模块边界与连接

任务②明确启动转换；读取文献材料③，经存储⑦发布；知识⑤、查询⑥与外部调用方通过公开接口消费。

本篇按职责归并已有详细合同；示例中的现有类型与目标类型保持各自状态。文档归属不改变源码目录、事实所有权或当前公开 API。

## 2. 解析转换与中性结果

### 2.1 独立可读材料与证据的目标边界

按 [ADR 0026](../decisions/0026-agent-knowledge-and-human-collaboration.md)，解析是可独立请求的材料转换，用户和 Agent 无需等总结完成。Parsing 继续负责中性文本/资源与输入绑定；[文档与证据：可读表示与有界读取](#3-可读表示与有界读取)负责可读结构、稳定定位与被引用表示生命周期。

当前实现只有 RawParse 和校订稿两条生产路径。按 ADR 0060，解析完成后还要由程序形成初稿，见 [8.2](#82-初稿的形成)。解析失败不删除原始材料；旧结果只在一次性导入原始 Markdown 时校验。

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

`DocumentProcessingService.parseDocuments` 请求为 `{ literature_id, asset_id, asset_sha256, profiles?, force? }`；未指定 profiles 时由服务采用 `parsing.archive_profile` 一种，`force=false`。当前实现的回执只含固定 PDF 与逐 profile 的 raw ID/hash/状态/失败信息。旧 `mode`、默认文档 CAS 与 Document 回执已移除；不接受旧请求形状，不发布 ParserResult。当前实现中解析也不改变默认阅读文档；目标中同一次解析操作在 RawParse 发布后形成初稿，回执增加初稿结果，见 [8.2](#82-初稿的形成)。

缺 PDF 或原始输入变化返回明确失败。解析不获取 PDF、不建档、不总结；用户显式发起的 `complete parser` 是允许先获取 PDF 的维护操作，仍停在 raw 边界（目标中包括形成初稿）。校订稿及其默认版本更新由独立校订文档发布操作负责；初稿何时成为默认文本见 [8.5](#85-默认文本内容版本与证据)。原始 PDF 与旧证据继续固定到原始 ID/hash，不能跟随 current 重定向。

### 2.13 Parsing 准备与发布

`ApplicationOptions.parsing: { rawParser }` 是离线测试注入端口；生产 backend 由 bootstrap 根据配置组装。`Application.rawParsing` 在具备 raw 存储 schema 与有效 parser 配置时存在，否则为 null。旧 `Application.parsing`、`ParsingService`、旧发布器和单结果转换接口已删除，历史 fixture 仅在 test 中组装。

当前 MinerU adapter 只接纳 ZIP，保留 v2、Markdown 和使用中的图片；旧 JSON 响应或缺失 v2 会失败，不尝试旧转换。所有 HTTP 请求经过共享 NetworkBudget；远程上传要求 exact-origin credential grant，每次请求重新授权，loopback 不附带远程凭据。RawParse 文件采用 create-if-absent，成功发布与 current profile 关系在存储 owner 中确认；失败保留已提交事实。

## 3. 可读表示与有界读取

### 3.1 责任、子能力与依赖

| 子能力        | 输入与输出                                                                     | 不承担的决定                                  |
| ------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| 表示构建      | 初稿或 complete 校订稿 → DocumentVersion、结构与资源闭包（当前实现只有校订稿） | 不执行外部 parser，不判断论文身份，不调用模型 |
| 结构浏览      | 精确版本 → 目录、段落/表格/资源条目、能力描述                                  | 不补造 parser 没有提供的结构                  |
| 有界读取      | 版本、选择器、预算 → DocumentSlice、继续位置                                   | 不隐式重新解析、不调用模型                    |
| 证据创建/解析 | 版本与位置 → EvidenceRef → 受校验内容                                          | 不断言科学解释正确                            |
| 版本与依赖    | 已发布版本、默认关系、下游引用 → 可用性与保护                                  | 不接管原材料删除或下游数据集                  |

Document/Evidence 只从 Literature/Acquisition 的公开只读面取得身份和资产，从 Parsing 取得已验证结果，通过自己的发布 Port 使用 Storage。Analysis、Q、外部提取器与人类阅读都使用同一个读取面；禁止各自解释 MinerU JSON、猜文件路径或直接查私表。

建议在模块内分离 builder、reader、locator 和 repository adapter。该划分用于隔离变化：新增 parser 不应修改 EvidenceRef 消费者，新增定位方案不应修改 Literature 身份算法。它不要求部署多个服务。

### 3.2 材料、解析结果与表示的区别

同一 PDF 的 Asset ID/hash 固定原始字节。RawParse 固定某次原始解析的区块、Markdown、资源、输入 hash 和解析身份；ProofreadVersion 固定校订内容。DocumentVersion 再固定结构与定位规则；重新分段、换 builder 或 locator scheme 都可能产生新表示，即使 PDF 不变。

文本等级是 DocumentVersion 的固定属性：同一部分的初稿和校订稿是同一 `document_id` 下的不同版本，等级不随默认关系改变（目标合同，见 [8.3](#83-初稿的结构与核对依据)）。

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

当前校订稿的 DocumentRef 是 `schema_version: 2`（第 4 节）。初稿的 DocumentRef 取 `schema_version: 3`，绑定原始解析、页面文字层与初稿方法，是目标合同，见 [8.3](#83-初稿的结构与核对依据)。

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

建议读取面包括 `describe`、`outline`、`readSlice`、`readResource` 和 `resolveEvidence`。查询型操作不触发新建档或 parser；已有表示由 verified reader 按记录的 builder 核对，表示不存在直接返回缺口。

verified reader 在进程内按文档版本与 representation hash 保留有界的整篇校验证明（Owner 2026-11-05 决定）。每次读取仍核对版本声明、限额、表示 hash 与校对稿绑定，并比对闭包中每个文件的 dev/ino/size/mtime/ctime；全部一致才跳过重算 PDF 与资源 hash 和重建结构，任一不同即完整核验，失败不留证明。证明不跨进程、不落盘；保持五项文件元数据全不变的篡改不在其检测范围内。交付给调用方的字节仍逐字节核验。规则细节见 `apps/server/src/document/README.md`。

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

`DocumentLocator` 是按 locator_scheme 判别的封闭类型。不能接受 SQL、任意 XPath、文件路径或 parser 私有 JSON。版本/schema 不匹配在读取前拒绝；预算必须为合法正整数且不超过服务上限。读取合同规定 slice 正文最多 64 KiB、完整片段 evidence/location 最多 200 条；outline、segments、resources 的分页上限也是 200 条。正文预算与 JSON 元数据条目边界分别生效；触及 evidence 上限时返回 `evidence-page-limit` 和 continuation，不丢弃后续段落。

继续位置绑定版本、selector 与返回顺序，不能把上一版本 cursor 用于新版本。一个 slice 的文本、资源和 evidence 由同一固定版本组成。预算不足以容纳完整单元时返回截断和可继续位置；对大表格说明仅返回哪些行及重复的表头，不能伪称整表已读。

以字节作为基础资源计量。文本边界不能截断 UTF-8 字符；若公开文本 offset，locator scheme 必须明确采用 UTF-8 byte、Unicode code point 或其它单位，不能混用 JavaScript UTF-16 索引。token 预算需要声明 tokenizer，由 Q/Analysis 管理，不从字符数猜成准确 token。

资源 JSON 读取继续提供有界 Base64 分页。阅读器也可向 `POST /api/v1/query/document-resource-bytes` 提交协议 1 包装的 `{document_version_id, resource_id}`，一次流式读取此固定版本的完整 PNG/JPEG/GIF/WebP 图片，单图上限 32 MiB。此接口与原始 PDF 的 material-bytes 同属 HTTP 二进制运输面，沿用查询认证、取消、背压与停服等待；CLI/MCP 保留原资源 JSON 读取。每次请求先经 verified reader 校验完整文档闭包，再校验所交付资源，响应头绑定文档版本、representation hash、resource ID/hash 与字节数。流结束前资源核验失败时中断响应，不能把部分字节视为成功。整篇闭包可由上述校验证明命中，所交付资源本身每次都完整核验。

### 3.5 分句与出处角标（目标，尚未实现）

机器写的内容用“¶段·句”标出依据，例如“¶13·2,3”。段号和句号都是显示用的编号，由引用的文本位置算出，不保存在结果里。

- **段号**：片段在所读文档版本里的序号，从 1 起。
- **句号**：片段内句子的序号，从 1 起。分句由固定的程序规则 `sentence-split-v1` 完成，不调用模型：
  - 句末标点是中文的“。！？”和西文的“. ! ?”。紧跟其后的引号和括号归入前一句。
  - 西文的句点只有在后面是空白加大写字母、数字或引号，或者片段到此结束时，才算句末。常见缩写（e.g.、i.e.、et al.、Fig.、Eq.、vs.、No.、Dr.）之后、数字内部（例如 3.12）和省略号内部不断句。
  - 分号、冒号和换行不断句。
  - 行内公式算在所在的句子里。独立公式、图注、表题和标题各自算一句。
- 一条引用跨几句时列出各句的句号。引用的起点落在句子中间时，取包含起点的那一句。
- 规则有版本号。规则改变只改变显示的句号，不改变引用所指的文本位置，也不使结果过时。

## 4. 证据定位、版本与生命周期

校订稿生成 DocumentRef v2，绑定 Literature/Asset、proofread_id、校订内容 hash、builder/locator、正文/结构和资源闭包。每个 segment 保留区块 ID、UTF-8 范围、page/region、continuation regions、核对依据。只有页定位的区块不能伪造 bbox。初稿的 DocumentRef 改为绑定原始解析与初稿方法，片段的核对依据取初稿的三种值，见 [8.3](#83-初稿的结构与核对依据)。

DocumentStructure 的 heading 由校订区块类型决定，正文里的 Markdown 标记不能意外生成目录。构建与读取共享正文 8 MiB、结构 16 MiB 上限，取消和输入篡改明确失败；长循环让出事件循环。默认版本更新是独立 CAS，失败仍保留已发布版本。索引失败不撤销文档。

EvidenceRef 固定材料或文档表示和片段 hash；定位必须在固定版本内复核，不能悄悄重绑 current。Web 跳转将内部页码转换为公开页码，区域核对复用经过验证的 PDF 原图；ID/hash 隐藏在技术详情，不作为阅读正文。

只读服务按请求持有有界核验作用域，关闭等待在途操作结束。原始解析、校订稿、文档、算子结果和外部回执的引用保护由存储 owner 执行。新路径不发布或读取旧 markdown-utf8-v1 默认文档；旧字节仅在一次性登记原始解析时处理。

## 5. 文档与证据验证

### 5.1 使用示例与验证

用户已有论文 P 的 PDF M1，未配置任何内部模型。调用原材料读取即可取得 M1，并创建文件级证据；要求表格第 3 行时若尚无可靠定位，返回能力缺口。用户明确启动解析后，程序形成初稿 D1，等级为初稿（目标行为，见第 8 节；当前实现要先建档，得到校订稿后才有可读文档）。外部程序读取 D1 中表 2 的表头、目标行和脚注，再将 EvidenceRef 与提取字段绑定；每个片段带核对依据，表 2 所在页如果是扫描页，片段标为“没有文字层可以核对”。

之后用户对 P 发起建档，得到校订稿 D2，默认文本改为 D2。依据 D1 的结果标为过时，它的引用仍解析到 D1 的原片段，不改指 D2。重解析得到新初稿时同样如此。若 D2 修正了 OCR，调用方可以重新提取并生成新候选，旧候选不会自动被改写。通过引用解析只说明对应内容真实存在，测量值解释与实验归属仍由下游判断。

直接验证覆盖：无模型原始材料读取、结构/资源有界读取、跨 UTF-8 边界、旧 cursor 拒绝、两类 EvidenceRef、资源闭包、hash 冲突、重解析后旧引用、发布/回收竞争和取消。两级文本的验证见 [8.9](#89-验证)。测试用合成文档中已知的具体文本/单元，不能只检查返回了一个 ID。

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

按 [ADR 0041](../decisions/0041-arrange-then-per-page-proofread.md)，每个部分先整理，再对保留内容逐页校订；普通文献的整理按 [ADR 0048](../decisions/0048-single-pass-arrangement.md) 每部分一次整理请求、按需一次断段请求，校订按 [ADR 0047](../decisions/0047-single-pass-page-proofread.md) 每页一次请求、由程序防护把关。长文档按 [ADR 0055](../decisions/0055-long-document-simplified-archive.md) 使用下面的分段与简化规则。整理与校订都使用现有 `proofreading` 模型角色，不增加角色配置。

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
- **判定与大小上限**：规则预处理后，计算未分段整理输入 JSON 的 UTF-8 字节数；PDF 页数超过 50 或该字节数超过 384 KiB（`ARRANGE_INPUT_MAX_BYTES`）即为长文档，等于阈值不触发。新快照的可选 `classification={pages,arrange_input_bytes,reasons}` 保存本次判定，原因按 pages、arrange-input 顺序列出，普通文献为空数组；旧快照缺字段照旧读取。重新整理重新判定。
- **长文档分段**：按完整 PDF 页、来源顺序贪心装入请求，每个请求连同 `previous_section` 外壳均不超过同一字节上限，依次调用；前段末尾保留块的角色及附加章节原标题身份由宿主交接。后段起始若延续 additional 且没有新标题，宿主沿用该附加章节的标题叶块，不能凭空生成标题。程序删除、人工锁、预拆和页归属规则照常，全部段合并后重验完整覆盖与零改字。单页本身超过请求上限时仍返回 request-too-large，不截断正文或擅自拆页。整理回执 stats.segment_count 记录段数。
- **长文档断段**：在合并后的完整整理上生成全部候选，保留跨段候选；待裁决请求按序、按实际输入 JSON 字节数分批，每批受同一上限约束，保留所有已接纳批次的决定，最后全局接纳。
- 整理检查点为 `arrangement-checkpoint-v2`，保存快照、用量、文字层证据页与 `caption_fixes`；命中时重验快照并按证据页重验页归属。

### 6.3 逐页校订与复用

- PDF 页分类继续按可见字形区分 `text-layer`、`image-only`、`blank`；隐藏 OCR 不进入参照文字，页面原图始终是最终依据。
- 普通文献每个有保留叶块的页发**一次**请求（`page-review-guards-v1`）：整页原图、本页保留叶块（按阅读顺序编为 `b1`、`b2`…，带类型与原文）、程序算出的差异、图内文字叶块清单；人工锁定的叶块单列并注明不改。请求不含邻页、已删除叶块或整理历史，并强制以 `submit_corrections` 作答：改字列表（叶块、原文片段、改成什么、一行理由）与拿不准的地方（叶块、文字、理由）。宿主收到后把短编号换回真实 ID。
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
- 长文档默认不调用页模型或页面图工具，保留叶块的解析文字直接发布，人工文字锁仍有效。有保留叶块的页记 status=unreviewed、unreviewed_reason=long-document；无伪造阅读证据、无模型改字，用量为零。这是简化流程已完成，允许 complete；无保留叶块继续 not-required。required 仍计有保留叶块的页，新增可选 unreviewed 计数，pending 不包括这些页，accepted 只计实际校订通过。unreviewed 不写入成功页缓存；已有 accepted 页及人工决定照常复用。
- 显式 retry_page_indexes 只重试所选页；未选页（含 unreviewed 与未完成页）保留原记录，本次不计执行或模型消耗；所选长文档页按正常页校订规则运行，成功后改为 accepted。整篇仍须所有必需页完成或按简化流程免校订。所选重试对应的方法已变时返回 input-stale，应重新检查完整页输入，不能沿用旧方法的局部提交。
- `page_input_sha256` 绑定 PDF/raw 身份、本页分类与文字层、保留及已删除叶块、改字方法、校订方法与提示词 hash、页面工具方法和有效模型设置，不绑定全篇 arrangement ID。重新整理后，只重校页输入变化的页。成功页记录按键保存，命中时重验来源与改字映射；失败页不作为成功缓存。返回历史页用量与本次新消耗时分别计量，复用页本次消耗为 0。

### 6.4 停止保护与受控上下文

整理和逐页校订服务不设每篇调用次数或 token 上限。保护规则版本为 `validation3-progress8-v1`。普通整理每部分至多两次请求，长文档按各整理段和断段批分别请求，各只有一个工具，被拒的回答只能修正一次（6.2 节）；校订每页一次请求、一个工具。实际起作用的是“同一校验问题连续 3 次”与限流规则；下面关于无进展、读取窗口与压缩的规则保留在共用会话里，现在不会被整理或校订触发：

- 同一校验问题集连续 **3 次**返回，停止该部分整理或该页校订；中间有一次被接受的工具调用就重新计数。问题集按稳定 code 与 ID 排序去重后计算 fingerprint，错误措辞不参与；批量提交中格式不合法的项，以“字段名[序号].字段”作为 ID，告诉模型具体要改哪一项。停下记录 fingerprint、issue_codes、实际次数与阈值。
- 连续 **8 次实际派发的模型调用**没有新进展，停止该会话。新进展是读到新的源字符、页面或参照窗口，或提交新的合法语义操作/疑点处置；重复读取、去掉再放回同一操作或只改理由措辞不计。压缩调用也如实计入实际调用。压缩后模型需要重读草案才能接着做：上次压缩以来有过新进展时，压缩后重新计数；没有进展的压缩不重新计数，避免空转循环。
- 模型返回 429（适配器归一为 retryable agent-quota）时，在同一页、同一 DSH 会话重试同一请求，不追加重复用户输入。页调度与实际模型请求共用本次文献的递减额度，每次限流降一档，最少 1；遵守 Network 已限界的 Retry-After，全篇等待窗口取最大值。已在运行的页不撤销，其后续请求等待降档后的空位，新页也等空位。限流派发计 calls，不能作为无进展决定；usage.rate_limits 保存页码、服务等待提示、实际等待和降档前后额度。无可靠响应 usage 的 token 仍为 null，不推算限流请求用量。单页质量停止不取消其它页；用户取消才中断全部在途请求与限流等待。
- no-progress、validation-repeated 与 cancelled、模型异常、输入冲突、页面工具不可用、协议大小拒绝分别记录，不能把质量停止记成取消。失败派发后没有可靠 usage 时，token 为 null，usage_complete=false，不填成 0；所有已报告 usage 含压缩实耗。
- 工具回执只是确认或退回，不超过 16 KiB，不回传原文。
- 使用 DSH 的 image_policy=latest，旧图在请求中换成文字占位。中性请求超过 384 KiB 的文字/图片字节窗口后，在当前工具批收尾处交回 DSH 显式压缩，再继续同一会话；模型上下文触发的原生压缩也保留。宿主草案、覆盖和用量不依赖压缩摘要，可用有界工具重新查询。协议原有请求/响应大小保护仍有效；这不是文献调用预算。

### 6.5 生产编排、发布与历史读取

新建档固定执行 `arrange → proofread → render → metadata → references → tags`。整理和逐页校订都绑定 `proofreading` 角色。`archive/text-pipeline.ts` 组装 source、整理、逐页校订与接纳清单；检查点和页缓存继续使用现有不可变 artifact、校订版本和 raw pin，不另建业务库。新的写入请求为 schema 2；旧步骤与旧写请求返回 `archive-contract-obsolete`，不把 document/structure 当作新步骤别名。

render 从保留叶块及已记录 correct 确定性生成普通 Markdown、DocumentStructureV2 和叶块 UTF-8 source map。新建档及显式重新发布采用 `source-order-leaves-v4`：公式叶块有非空 LaTeX 时只输出 LaTeX，不再同时输出该叶块截图或将未使用截图加入资源闭包；LaTeX 为空时保留截图兜底。历史 `source-order-leaves-v3` 保留公式图片与文字并列的原行为，`arranged-leaves-v2` 保留原骨架渲染算法；固定旧版本读取与 hash 校验按记录的 builder 逐字节重建。同一 proofread 的派生 Markdown 按 builder 与内容 hash 分别登记，文档发布核对实际资源 hash/path，不覆盖旧排版资源。保留 payload 恰好出现一次，标题标记、公式分隔符、合并接缝、资源语法和段落分隔单独记录；不插自定义指令、HTML 注释或固定角色标题。原文顺序决定章节顺序，同角色可分多段，原文没有标题的章节 title=null。

标题层级先依章节编号（1 / 1.1 / 1.1.1），其次依可见 PDF 文字层的重复字号/字体样式；至少 90% 标题有样式且嵌套一致率不少于 90% 才使用样式层级，否则沿用整理给出的层级。文末信息与参考文献标题固定同正文章节层级。首页单位、通讯作者/作者注释及收稿/发表信息仍归 end-matter，排在作者后；正文标题区的期刊、年份与 DOI 继续由 catalog 元数据在阅读层投影，不进入不可变正文。

同一图注的面板图片连续排列、图注紧随其后，结构记录图片行列；关系不明的无图注图片独立保留。紧邻已有标题表格、宽度相近而没有自己标题的续表合成一组。脚注有本页引用标记时放在首次引用段落之后；没有标记的留在原位置。独立内容不会插入合并段内部。

`DocumentStructureV2.layout`（可选 schema 1）保存 article_info 字节区间、figure_groups（figure/scheme/table 的对象及图注区间、segment ID、0 起始 row/column 和每行数量 rows）以及 footnotes（每条脚注区间、segment ID、0 起始 page_index）。区间均为固定校订稿 UTF-8 半开区间。文档 describe 原样返回可选 layout；outline 继续分页返回 title（string|null）、role、level 与起止字节。HTTP、CLI 与 MCP 共用同一读取合同，历史无 layout 的结果照旧读取。

结构注释采用独立 schema 2，直接从整理归属和图注挂接派生，role_source 为 arrangement 或 manual，不再调用章节分类模型。11 个新骨架角色与历史角色分别解码，不作名称映射。`body_content_leaf_ids` 记录真正具有保留正文 payload 的正文类叶块；纯标题不满足 READY。正文类角色恰为 introduction、methods、results-discussion、conclusion、additional。主文仍需校订流程 complete（包括长文档的 unreviewed 页）、该校订稿是当前默认文档、派生注释、必需元数据与标签；默认文本是初稿时不成立 READY。READY 表示库整理完成；它不是阅读的门槛，按 ADR 0060 也不再是加工的门槛（目标，见 [8.6](#86-加工读取)；当前实现的算子仍只读取 READY 文献）；补充材料和参考文献缺口不独自阻断主文。没有叶块的页所产生的 page-content-missing 是非阻断问题。

普通文献的元数据按 [ADR 0045](../decisions/0045-archive-metadata-reads-whole-paper.md) 读取校订稿的全部保留片段，以及全部删除叶块的原始文字；长文档只读取前 20 页与最后 5 页的并集，保留片段及删除叶块都按各自实际责任页过滤（跨页合并段的叶块片段仍各有页码），删除叶块的角色写作 `dropped:<理由>`。后者带 raw parse、整理、源 span 和删除理由的专门证据，不冒充文档 segment。模型引用 `f1`、`f2` 等本次输入内的短编号，宿主按编号保存真实证据；输入上限为 4096 个片段、1 MiB。参考文献、标签、检索和算子使用固定文档的保留内容；元数据、参考文献和标签只来自校订稿，初稿不提供。校订稿的内容版本仍为 hash(文档版本, 结构注释)，变更经现有事务内事件使下游结果过时，不隐式重算。初稿的内容版本见 [8.5](#85-默认文本内容版本与证据)。

机器读取的 `long_document` 为非空 reasons 的判定对象，普通与历史未标记结果为 null。archive status 顶层及文献库条目表示主 PDF，parts[] 分别表示各部分；来源为当前资产整理步骤的非秘密 JSON 回执，列表按本页 ID 批量读取，不读正文。document describe 的标记属于指定不可变文档版本，来自结构 JSON 可选字段 long_document；只在长文档结构中写入，普通结构字节不变。archive-arrangement summary 也提供标记。HTTP、CLI、MCP 共享这些读取；Markdown 正文不加标记，骨架角色和下游选材不变。长文档的文本等级是校订稿，“长文档”是校订稿上的附加标记，不是第三个等级（[8.4](#84-文本等级的标注)）。

新旧校订稿发布都只等待全文索引刷新请求持久化，回执为 index_status=scheduled；不等待整库扫描，也不因索引失败撤销发布或阻断建档完成。排队、失败读取与显式重试见[检索技术篇](06-retrieval-context.md#49-材料-context-的实现边界)。索引状态与固定文档、注释和 READY 分开。

全文摘要读取器按 builder 分派片段覆盖校验：历史表示连续覆盖全文，新表示允许已验证渲染器生成的结构字节位于叶块片段之外。指定的算子角色在该校订稿版本注释中无法表达时，返回 `structure-role-unavailable` 缺口，不把空片段冒充完整阅读或自动映射旧角色。初稿没有结构注释，按角色读取的规则见 [8.6](#86-加工读取)。

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

## 8. 目标接口（尚未实现）：两级文本

本节按 [ADR 0060](../decisions/0060-two-level-full-text.md) 规定两级文本怎样形成、标注和读取，决定的理由见该 ADR。本节尚未实现。实现之前，上文的现行合同不变：可读文档只有校订稿，算子只读 READY 文献的校订稿。

### 8.1 两级文本

| 等级   | 机器取值    | 怎样形成                                  | 片段核对依据                                     |
| ------ | ----------- | ----------------------------------------- | ------------------------------------------------ |
| 初稿   | `draft`     | 解析完成后由程序形成（8.2），不调用模型   | 与文字层一致、与文字层有差异、没有文字层可以核对 |
| 校订稿 | `proofread` | 建档的整理与逐页校订（第 6 节），标准不变 | 文字层核对、仅图像核对、人工（第 4 节）          |

- 只有这两级。长文档按 6.5 的简化流程建档，产物仍是校订稿，另带“长文档”标记。
- 两级文本都是正式的 DocumentVersion：可以阅读，可以查找，可以加工。
- 原始解析（RawParse）不是文本等级。它只供人工查看，不进入阅读视图的正文，也不进入算子上下文。

### 8.2 初稿的形成

**时机。** 一个部分的原始解析发布后，同一次解析操作接着形成初稿：

- 不调用模型，不联网，不需要使用者另外发起；
- 适用于所有发布原始解析的操作：单独的解析、`complete parser` 维护操作，以及建档的第一步解析（6.1）。

**输入。**

- 该部分部署 profile（`parsing.archive_profile`）的当前原始解析。没有它时，用已登记的 `vlm-engine-markdown-only` 原始解析。另一种 profile 的结果不形成初稿。
- 一次解析请求只在本次发布或复用了部署 profile 的原始解析时形成初稿。请求只含另一种 profile，或部署 profile 本次失败时，不形成初稿，也不改用该部分以前的原始解析。
- 固定 PDF 的页面分类与可见文字层，与 6.3 使用的页面工具相同，在本机运行。
- 来源区块按 6.2 的“来源和坐标”构造，与建档整理用同一个 `ArrangementSourceBlock` 构造函数（包括可选的 `pdf_geometry`）；身份和完整性按同一处核验：清单身份、字节长度、SHA-256、页数和资源闭包。
- 仅 Markdown 的输入按 6.2 的规则确定页归属。无法唯一确定时形成失败，对外原因为 `needs-parse`（内部的 `input-missing` 不出现在回执里）。

**规则。** 只使用 ADR 0054 的规则预处理，与建档整理前的程序步骤相同：

1. 程序删除页眉页脚：6.2 的 `page-chrome-v1`，规则不变。
2. 程序直接合并明确的断段：6.2 断段规则第 2 条，按下面的“没有章节角色时的判定”执行。需要模型裁决的候选（第 3 条的 layout 候选，以及其余前块未以句末标点结束的候选）不合并，两块保持分开。合并的接缝按第 6 条。
3. 阅读顺序纠正：只在 6.2 所说的纠正开关启用时执行。
4. 不做模型整理：没有章节角色，没有图注挂接，没有拆分。书目行、版权句和界面文字只由整理删除，所以初稿保留它们。每个保留的原始区块是一个叶块，叶块 ID 按 6.2 的规则生成（源区间为整个区块）。

**没有章节角色时的判定。** 初稿只按解析类型判定“正文”和“标题”，不调用模型，不推断章节角色：

- 正文：未被程序删除、解析类型为 `text` 的叶块。断段规则第 2 条要求的“双方均为正文”指这一类；“而非列表项、图注、参考条目/分图标签”等文字条件照旧。
- 标题：解析类型为 `title` 的叶块。
- 可跳过的独立内容（第 1 条）：程序已删除的叶块，以及解析类型为 `footnote`、`image`、`table`、`caption` 的叶块。
- 第 1 条里“首页已归 end-matter 的单位、作者信息或日期”依赖章节角色，初稿不用。这类文字在初稿里是 `text` 类型，按正文对待：它阻断跳过，自己也可以成为合并的一方。
- 其余保留叶块（`title`、`list`、`equation`、`reference`、`discarded` 等）阻断跳过。

**渲染。**

- 保留的叶块按来源顺序排列。
- 每个渲染出的段落是一个片段（segment）。没有被合并的叶块单独成一个片段。程序合并的几个叶块合成一个片段：片段 ID 与 `block_id` 取第一个叶块的 ID，`page` 与 `region` 取第一个叶块，其后各叶块按顺序写入 `continuation_regions`（没有区域的叶块不写，页码仍在差异记录里）。校订稿是每个叶块一个片段（6.5），这一点两级不同。
- 标题叶块单独成片段，类型为 `heading`，并开始一个章节。章节的 `title` 是标题文字，`role` 与 `role_source` 为 null。第一个标题之前的内容属于 `title` 为 null、层级 2 的章节，同 6.5。
- 标题层级按 6.5 的程序规则，有三处不同：
  - 所有标题叶块都参加字号字体的样式统计，包括论文题名。初稿分不出题名、文末信息和参考文献的标题，所以不给它们固定层级（校订稿里题名固定为 1，文末信息与参考文献固定为 2）。
  - 次序是：有章节编号时，层级为编号段数加 1，最大 6；否则样式层级可靠（6.5 的条件）时用样式层级；两者都不成立时取解析的 `title_level` 加 1，最大 6，`title_level` 为 null 时取 2。
  - 初稿不使用层级 1。
- 公式、图片、表格按 `source-order-leaves-v4` 的写法输出。图注、脚注留在来源位置。结构不写可选的 `layout`：初稿没有图注挂接，不重排文章信息与脚注。
- 资源闭包只含渲染后正文实际引用的原始解析图片，规则同 `source-order-leaves-v4`。
- 正文与结构的大小上限同第 4 节：正文 8 MiB，结构 16 MiB。

**与文字层对比。** 程序逐个叶块与所在页的文字层对比，结果写成片段的核对依据，见 8.3。

**版本。**

- 初稿是不可变版本。身份由四项决定：固定 PDF 的资产 ID 与 hash、原始解析 ID 与 result hash、PDF 页面分类与文字层、初稿方法。
- 页面分类与文字层用 `page_layer_sha256` 表示：各页 `pdfPageText`（页码、分类、可见文字层、字形计数、是否有图形）组成的规范 JSON 的 SHA-256。字段与建档整理来源的 `input_sha256` 所用的页面字段相同。
- 初稿方法用 `draft_method_sha256` 表示：规范 JSON `{chrome, breaks, reading_order, comparison, builder}` 的 SHA-256。五项依次是 `page-chrome-v1`、`paragraph-break-v3`、阅读顺序纠正开关（布尔值）、对比规则版本 `draft-compare-v1`、builder 版本 `draft-leaves-v1`。任一项改变就是新方法。
- 相同输入和方法得到相同字节和相同 `document_version_id`，复用已有版本，不重复登记。
- 解析操作总按当前方法形成初稿；身份相同时复用。重新解析产生新原始解析时，形成新初稿。
- 初稿方法改变后，已有初稿不自动重新形成：不在启动、读取或建档时重建。重新形成由使用者显式发起：对单个部分重新解析，或用 8.11 的维护操作并打开 `include_older_method`。

**失败。**

- 初稿形成失败时，原始解析和其它部分的结果照常保留，不登记部分产物。
- 失败原因是封闭取值，写进回执的初稿结果：

| `failure_code`           | 含义                                                    |
| ------------------------ | ------------------------------------------------------- |
| `page-tools-unavailable` | 页面工具不可用，得不到页面分类或文字层                  |
| `draft-too-large`        | 正文、结构或初稿内容超过上限（8.3）                     |
| `needs-parse`            | 仅 Markdown 的输入无法唯一确定页归属，需要重新解析      |
| `source-integrity`       | 原始解析或资源闭包的身份、字节长度或 SHA-256 核验不通过 |
| `draft-publication`      | 文件发布或 catalog 提交失败                             |
| `cancelled`              | 原始解析已提交、初稿提交前收到取消；原始解析保留        |

- 失败后可以用 8.11 的维护操作单独重试，也可以对该部分再次解析（复用原始解析，见上文“版本”）。

**已有的原始解析。** 已经存在、但还没有初稿的原始解析，用 8.11 的维护操作形成初稿。范围用库内筛选写明（ADR 0052）。这个操作同样不调用模型、不联网。

**回执。** 解析回执（`ParseDocumentReceipt`）在逐 profile 的原始结果之外增加 `draft`，表示该部分这次的初稿结果：

```ts
type DraftOutcome =
  | {
      readonly status: "formed" | "reused";
      readonly raw_parse_id: string;
      readonly document_version_id: string;
      readonly representation_sha256: Sha256;
      readonly default_changed: boolean;
      readonly default_text_level: "draft" | "proofread";
    }
  | {
      readonly status: "failed";
      readonly raw_parse_id: string;
      readonly failure_code: DraftFailureCode;
    }
  | {
      readonly status: "not-formed";
      readonly reason: "profile-not-requested" | "raw-parse-failed";
    };
```

- `formed`：新形成；`reused`：身份相同的初稿已经存在。
- `default_changed` 表示这次是否改了默认关系；`default_text_level` 是本次之后该部分默认文本的等级（8.5）。
- `not-formed`：请求只含另一种 profile（`profile-not-requested`），或部署 profile 本次解析失败（`raw-parse-failed`）。
- 原始解析提交后收到取消：初稿不提交，回执（如果返回）为 `failed` 与 `cancelled`。整次操作以取消结束、不返回回执时，结果相同：原始解析保留，没有初稿。
- `complete parser` 维护任务的逐篇回执与建档第一步的解析使用同一个 `draft` 结果。

### 8.3 初稿的结构与核对依据

**DocumentRef。** 初稿的 DocumentRef 和校订稿使用同一读取合同，`schema_version` 取新值 3：

```ts
interface DraftDocumentRef {
  readonly schema_version: 3;
  readonly text_level: "draft";
  readonly document_id: string;
  readonly document_version_id: string;
  readonly representation_sha256: Sha256;
  readonly source_material_ref: DocumentMaterialRef;
  readonly raw_parse_id: string;
  readonly raw_parse_result_sha256: Sha256;
  readonly page_layer_sha256: Sha256;
  readonly draft_method_sha256: Sha256;
  readonly draft_content: ArtifactRef;
  readonly builder_version: "draft-leaves-v1";
  readonly locator_scheme: "utf8-segment-v1";
  readonly markdown: ArtifactRef;
  readonly structure: ArtifactRef;
  readonly resources: readonly DocumentResource[];
}
type DocumentRef = ProofreadDocumentRef | DraftDocumentRef;
```

- 校订稿的 DocumentRef 仍是 `schema_version: 2`，字节与 hash 不变，不加 `text_level` 字段；它的等级由 `schema_version` 推出。读取结果（describe、文献库、证据解析等）对两级都显式给出 `text_level`。
- 现有只接受 `schema_version: 2` 的检查遇到初稿时照旧拒绝。哪些读取方接受初稿，只按 8.10 的表逐项放开，不靠默认接收。
- `document_id` 与校订稿相同，按文献与资产生成；`document_version_id` 按 `document_id` 与 representation hash 生成，规则同校订稿发布。
- representation hash 是规范 JSON `{schema_version: 3, ...}` 的 SHA-256，覆盖上面除 `document_id`、`document_version_id`、`representation_sha256` 以外的全部字段：资产、原始解析 ID 与 result hash、`page_layer_sha256`、`draft_method_sha256`、初稿内容（含差异记录）、builder 与 locator、Markdown、结构和资源闭包。
- 没有结构注释。outline 的 `role` 为 null，`title` 来自解析标题，`level` 按 8.2 的规则。

**初稿内容。** 形成初稿时保存一份不可变的初稿内容 `draft-content-v1`（规范 JSON，`application/json`），即 `draft_content` 所指的文件：

- `raw`：原始解析 ID、result hash 与 profile；`page_layer_sha256`；各页的页码与分类（不含文字层文字）；初稿方法的五项与 `draft_method_sha256`。
- `source_blocks`：8.2 构造的全部来源区块，与 6.2 的 `ArrangementSourceBlock` 相同。
- `operations`：程序的删除与合并，按 6.2 的方式记录 `source=program` 与命中的规则；合并记录有序叶块 ID 与接缝。
- `leaves`：每个保留叶块的 ID、所在页、核对依据，以及该叶块的差异记录。
- 上限 16 MiB，与结构相同。超过时形成失败，原因 `draft-too-large`。

verified reader 只从初稿内容重建初稿：按 `draft-leaves-v1` 重新渲染 Markdown 与结构，核对它们与资源闭包的 hash，并核对初稿内容的字节、hash 及其中的原始解析绑定与 DocumentRef 一致。读取时不打开 PDF 页面工具，不重算对比，不读取原始解析的区块文件。初稿内容文件和校订稿的 manifest、blocks 一样，计入 3.4 校验证明的文件指纹与预算。

**片段与叶块。** 8.2 合成的一个片段可能含多个叶块，也可能跨页：

- 每个叶块各自按下面的对比规则得到一个取值，只和它自己所在页的文字层比，跨页片段也一样。
- 片段取其中最差的一个，顺序为：`text-layer-differs` 差于 `no-text-layer`，`no-text-layer` 差于 `text-layer-match`。
- 片段的差异记录是各叶块差异记录的并集，按叶块在片段中的顺序排列，每条注明叶块与页。
- 只有一个叶块的片段，取值和差异就是这个叶块的。

**对比规则（`draft-compare-v1`）。** 程序对每个保留叶块按下面的步骤取值，单位是词和数字，不做区块仲裁：

1. 所在页不是 `text-layer`（是 `image-only` 或 `blank`）：取 `no-text-layer`。
2. 取叶块的词。叶块文字用解析原文（表格为 HTML）。先把 HTML 标签换成空格，再解码字符引用：`&amp;`、`&lt;`、`&gt;`、`&quot;`、`&apos;`、`&nbsp;` 与数字引用解码为字符，其余命名引用换成空格。然后按 6.3 的写法归一化并切词（NFKC、LaTeX 命令与 `$…$` 内的记号、连接号与弯引号）。表格的标记因此从不算作词。
3. 没有词（纯图片，或去掉 LaTeX 记号后什么也不剩的公式）：取 `no-text-layer`。公式叶块不单独处理，有词就照样对比。
4. 取本页文字层的词，写法同 6.3（含文字层的断行连字符）。用 6.3 的序列匹配对齐叶块的词与文字层的词。
5. 对上的词少于叶块词数的 30%（与 6.3 判定图内文字的门槛相同）即“找不到”：
   - 叶块文字按 6.2 页归属的条件（`textLayerPage`：至少 4 个不同的词，含次数全部出现在另一个、且只在一个 `text-layer` 页上）找到另一页：取 `text-layer-differs`，记一条“在另一页”的差异。
   - 找不到另一页：取 `no-text-layer`（例如图片里的文字）。
6. 其余叶块按 6.3 的方式逐段比较：对齐范围从第一处匹配到最后一处匹配，每个不相等的段落、且两边连起来不相同（不只是分词不同）的，记一条差异。没有差异取 `text-layer-match`，有差异取 `text-layer-differs`。对上了 30% 以上但缺了很多词的叶块，缺的词就是差异，同样取 `text-layer-differs`。
7. 对比结果不受整页匹配率影响：6.3 的“可信页”只决定校订请求里发不发差异，不决定初稿的核对依据。

初稿与逐页校订共用对齐和差异提取这一步。逐页校订请求一侧保持现在的行为：照旧用解析原文取词（不去掉表格标记），照旧按可信页决定发不发差异、丢弃不可信页的差异；请求字节、方法与 `page_input_sha256` 都不变。上面第 2 步的取词与第 5 步的“另一页”判定只用于初稿。

**核对依据的取值。** 初稿片段的 `basis` 取以下三种之一：

| 取值                 | 显示文字           | 什么时候取这个值（叶块；片段取最差）                                                                                     |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `text-layer-match`   | 与文字层一致       | 所在页是 `text-layer`；叶块对上 30% 以上，归一化后没有剩下的差异                                                         |
| `text-layer-differs` | 与文字层有差异     | 所在页是 `text-layer`；叶块对上 30% 以上，但至少剩下一处差异。或者叶块在本页找不到，却全部出现在另一个 `text-layer` 页上 |
| `no-text-layer`      | 没有文字层可以核对 | 所在页是 `image-only` 或 `blank`；或者叶块没有可比的词；或者本页找不到，别的页也没有                                     |

- 校订稿片段的 `basis` 仍取 `text-layer`、`image-only`、`manual`。片段的取值集合由所在版本决定：初稿取上表三种；校订稿取这三种，唯一的例外是下面的长文档。
- 片段读取与证据解析的 `basis` 字段（`DocumentSegmentLocation.basis`）因此有六种取值；解析时按版本核对，不在本版本取值集合里的值拒绝。
- `text-layer-differs` 就是“疑点，未处理”。差异不写进正文，也不换算成可信度分数。

**差异记录（`draft-differences-v1`）。** 每条差异是：

```ts
interface DraftDifference {
  readonly leaf_id: string;
  readonly page_index: number; // 叶块所在页，从 0 起
  readonly kind: "mismatch" | "elsewhere";
  readonly parsed: string;
  readonly text_layer: string;
  readonly other_page_index: number | null;
}
```

- `mismatch`：对比第 6 步的一段差异。`parsed` 与 `text_layer` 是两边归一化后的词，用一个空格连接，不是原文字节；一边为空表示缺词或多词。`other_page_index` 为 null。
- `elsewhere`：对比第 5 步找到另一页。`parsed` 是叶块全部的词，`text_layer` 为空串，`other_page_index` 是那一页。
- 差异按叶块保存在初稿内容的 `leaves` 里，读取时按片段组织（上文“片段与叶块”）。它们在初稿内容里，所以受 representation hash 覆盖，不另设文件；大小计入初稿内容的 16 MiB 上限，单条不截断。
- 形成时同时算出三个计数并保存为 catalog 事实（07 §2.3.4）：取 `text-layer-differs` 的片段数、差异条数、`image-only` 页数。它们由初稿内容确定，同一版本不变。

**差异的有界读取。** 操作名 `draft-differences`，形式与校订对照（`corrections`）相同：

- 请求：`{document_version_id, segment_id, max_bytes, continuation}`。`max_bytes` 为 1 到 65536 的整数；首次 `continuation` 为 null。
- 结果：`{document, segment_id, location, text_level, basis, encoding: "json-utf8", text, actual_range, total_bytes, continuation}`。`text` 是该片段差异列表（`DraftDifference[]`，可能为空）规范 JSON 的有界字节片段，不截断 UTF-8 字符；按 `continuation` 收集后再解析，可以无损读取。`location` 同片段读取，页码从 1 起。
- 继续位置绑定版本、片段与字节位置，不能用于别的版本。
- 版本不是初稿（`schema_version` 不是 3）时返回 `document-unsupported`；片段不存在时按请求无效拒绝。
- HTTP 为 `POST /api/v1/query/document-draft-differences`，CLI 为 `sciretriever document draft-differences --request FILE|-`，MCP 为 `document_read` 的 `draft-differences` 操作。三者共用同一合同与上限，设备连接的用途为 `read`。
- 读取不形成初稿，不打开页面工具，不调用模型。

**长文档。** 长文档（6.5）里未逐页校订的页（`unreviewed`）的文字没有经过校订：

- 这些页上叶块的 `basis` 取初稿的三种取值之一，用上面的对比规则逐叶块计算；校订稿每个叶块一个片段，所以不需要片段合并。叶块带人工文字锁时取 `manual`，与现在相同。
- 计算在形成校订内容时进行，写进 `ArchiveTextBundleV2` 叶块的 `basis`。校订内容中 `basis` 的取值集合因此扩展为六种：三种初稿取值只允许出现在 `unreviewed` 页的叶块上，其余页仍按页面类型取 `text-layer` 或 `image-only`，或取 `manual`。所需的页面分类与文字层已经在建档来源里，不另调用页面工具。
- 用“重试指定页”校订过的页（`accepted`），取校订稿的取值。
- 只对本规则上线后新形成的长文档校订内容生效，渲染使用新 builder `source-order-leaves-v5`。v5 与 v4 的渲染完全相同，只多接受上述三种取值；v4 遇到它们拒绝。普通文献继续使用 v4，字节不变。
- 已发布的版本不重写、不重新发布，按记录的 builder（v3、v4）照旧重建，hash 不变。
- 长文档校订稿不保存差异记录。`draft-differences` 对它返回 `document-unsupported`；疑点的具体差异可以在该部分的初稿上读取。

**人工修改。** 初稿是程序产物，不接受人工改字。人工修改通过建档进行（6.6）。

### 8.4 文本等级的标注

文本等级属于具体的 DocumentVersion，在以下位置显示：

| 位置                                  | 显示的内容                                               |
| ------------------------------------- | -------------------------------------------------------- |
| 文献库的文献行                        | 主 PDF 默认文本的等级                                    |
| 阅读页的信息栏                        | 各部分默认文本的等级                                     |
| 全文阅读视图的顶部                    | 当前所读版本的等级；初稿附说明文字                       |
| HTTP、CLI、MCP 的文档描述（describe） | `text_level`；长文档另有 `long_document`（6.5）          |
| 文献库与建档状态的机器读取            | 每个部分默认文本的 `text_level`，与 `long_document` 并列 |
| 查找结果                              | 每个命中片段所在版本的 `text_level`                      |
| 证据解析                              | 所引片段所在版本的 `text_level` 与片段的 `basis`         |

- 初稿的说明文字固定为：“未经校订，文字可能含解析错误；以 PDF 为准”。
- 长文档的等级显示为校订稿，同时保留 6.5 的“长文档”标记和说明文字。
- Markdown 正文不加等级标记。Web 上的摆放见[页面规格](../web/page-specs.md#阅读页)。
- describe 的结果增加 `text_level: "draft" | "proofread"`。初稿另有 `draft_summary: {differs_segments, differences, image_only_pages}`，即 8.3 保存的三个计数；校订稿没有这个字段。
- 文献库、文献详情、建档状态与查找命中的字段名和位置见[查询技术篇 2.1.7](06-retrieval-context.md#217-目标接口尚未实现文本等级与选择校订范围的事实)。

### 8.5 默认文本、内容版本与证据

**默认文本。** 每个部分的默认文本按下面的规则确定：

- 该部分有当前有效的校订稿时，默认文本是校订稿。“当前有效”指校订完整，并且它依据的原始解析仍是该 profile 的当前原始解析。
- 没有当前有效的校订稿时，默认文本是当前有效的初稿。“当前初稿”是该部分最近一次形成或复用、并登记为当前的初稿（07 §2.3.4 的当前指针）；“当前有效”指它依据的原始解析仍是该 profile 的当前原始解析。
- 两者都没有时，该部分没有默认文本。默认关系删除，不保留一个已失效的版本。读取默认文本返回现有的缺口 `document-missing`；阅读、查找和加工把这个部分当作没有文本。
- 默认关系的更新仍是独立 CAS（第 4 节）。下面三种写入都在各自的事务内按上面三条重新求默认文本：原始解析当前指针切换、初稿形成（含复用并登记为当前）、校订稿发布。默认文本改变或删除时请求全文索引刷新，同 6.5。

边界情形：

- 重新解析：新原始解析成为当前后，旧校订稿与旧初稿都不再有效，默认关系先删除；同一次操作形成新初稿后，默认文本是新初稿。初稿形成失败时，该部分保持没有默认文本，直到再次解析或 8.11 的维护操作形成初稿，或者完成新的校订。
- 部署 profile 改变：已有的初稿与校订稿不重写，按 `document_version_id` 照旧可读，默认关系不因配置改变而变化。按新 profile 形成新初稿时，当前初稿才换成新的，默认文本再按上面三条重新求：旧 profile 的校订稿只要它依据的原始解析仍是该 profile 的当前原始解析，就仍然有效并优先。
- 补充材料：每个补充材料 PDF 是独立的部分，同样适用上面全部规则。文献库按主 PDF 显示与筛选（8.4），阅读页按部分显示。

阅读页、查找和加工默认使用默认文本。调用方可以按 `document_version_id` 读取另一级文本，前提是该版本仍然可读。

**内容版本。** 文本等级是内容版本的一部分：

- 校订稿：hash(文档版本, 结构注释)，与 6.5 相同。
- 初稿：hash(`draft`, 文档版本)，没有结构注释。

内容版本的机器读取同时给出 `text_level`。

**过时。**

- 一个部分的默认文本改变时，内容版本随之改变。依据旧内容版本的加工结果经现有事件标为过时，不自动重算。这包括从初稿升级为校订稿、重新解析形成新初稿，以及默认关系被删除（这时内容版本为 null）。
- 过时的结果仍然可读。它的证据继续解析到原来那份初稿的片段。

**证据。**

- EvidenceRef 固定具体的初稿版本和片段 hash。部分校订之后，引用不会悄悄改指校订稿的片段，即使两边文字相同也不会。
- 被有效结果引用的初稿版本受引用保护，和校订稿一样，不被回收（第 4 节）。确需失效时明确报告，不无声断开。

### 8.6 加工读取

算子的准入、复用与计数归[知识加工](05-knowledge-processing.md#72-算子输入与复用)。本模块为它提供以下读取合同：

- 算子输入取每个部分的默认文本，同时取得它的 `text_level` 和内容版本。READY 不是读取的前提。
- 运行限定“只用校订稿”时，默认文本是初稿的部分记为输入缺失，不读取初稿。
- 初稿没有章节角色。按角色限定读取范围时（`segments` 带 `roles`，或算子声明了角色范围），在初稿上返回整篇文本，结果带 `coverage_note`，取值固定为“初稿没有章节角色，读取了整篇”。这时不返回 `structure-role-unavailable` 缺口。整篇包括初稿保留的书目行和参考文献表。
- 这句说明文字由本模块的读取结果给出，以本节为准。知识加工原样写进结果的覆盖说明，不另写一句。
- 用时核对（提取值与所引片段的文字比对）在初稿上同样执行。核对结果旁显示片段的文本等级和核对依据。
- 原始解析不进入算子上下文。

### 8.7 选择校订范围的事实

为了帮助使用者决定校订哪些文献，每个以初稿为默认文本的部分提供下列事实。它们都不调用模型：

| 事实                       | 字段                              | 来源                                                                   |
| -------------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| 疑点数量                   | `differs_segments`、`differences` | 初稿中取 `text-layer-differs` 的片段数与差异条数，形成初稿时计算并保存 |
| 是否含有扫描页             | `image_only_pages`                | 页面分类中 `image-only` 页的数量，形成初稿时保存                       |
| 是否被加工结果引用         | `citing_results`                  | 读取了该初稿版本、且未过时的加工结果数，读取时聚合                     |
| 是否有“找不到”的引用指向它 | `unfound_citations`               | 用时核对为“找不到”、且引用该初稿片段的值的数量，读取时聚合             |

- 前三个字段属于初稿版本本身，形成后不变（8.3）。
- `citing_results`：只计内容未过时的结果，即 `processor_result_freshness` 为 `current`；内容已过时的不计。算子方法版本较旧（`processor_result_currentness` 因方法记为过时）不影响计数，因为结果仍然读了这份文字。只计输入记录里有这个初稿 `document_version_id` 的结果（`processor_result_documents`）；同一结果计一次。
- `unfound_citations`：只计同样未过时的结果。一个值（结果、记录、字段指针）有任一来源的用时核对状态为 `not-found`，且该来源引用这个初稿版本的片段，计一次。
- 逐值核对的结果现在只在结果文件里。知识加工在发布结果的同一事务内写入一张可重建的投影，每个“找不到”的值与它引用的初稿版本一行；结构与写入所有权见[存储技术篇 4.2](07-versioned-storage.md#42-数据与写入所有权)。读取时只按版本聚合这张投影，不打开结果文件。
- 这些事实只对默认文本是初稿的部分给出；默认文本是校订稿或没有默认文本时为 null。
- 它们可以用于文献库的筛选和排序，并在机器入口的文献库读取中返回，字段与位置见[查询技术篇 2.1.7](06-retrieval-context.md#217-目标接口尚未实现文本等级与选择校订范围的事实)。校订范围仍用库内筛选写明（ADR 0052），只在使用者明确发起建档时校订，系统不自动校订。
- 发起前的用量估算沿用 6.7 的 usage-estimate，按每页一次请求计算（ADR 0047）。

### 8.8 不变的规则

- 解析不触发建档。整理和逐页校订只在使用者明确发起建档时进行。
- 校订稿的标准、防护与完成条件不变（6.2–6.5）。
- 原始解析不进入阅读正文，也不进入算子上下文。
- READY 的条件不变，仍要求校订稿是默认文档（6.5）。
- 读取已有内容不形成初稿，不解析，不调用模型（3.4）。

### 8.9 验证

用合成文档中已知的文字和页面核对，不能只检查返回了一个 ID：

- 解析完成后不调用模型、不联网就得到初稿；解析失败或初稿失败时，原始解析与 PDF 不受影响。
- 三种核对依据各有覆盖：文字一致的页、故意改错一处的片段、扫描页、图片里的文字、放错页的片段。
- 相同输入重复形成初稿，得到相同的字节和版本。
- 默认文本：只有初稿时是初稿；校订完成后改为校订稿；重新解析后回到新初稿。
- 升级为校订稿后，依据初稿的结果标为过时，它的证据仍解析到初稿片段。
- 文本等级在 describe、文献库读取、查找命中和证据解析中都能读到，与实际版本一致。
- 按角色读取初稿时返回整篇并带覆盖说明；“只用校订稿”时初稿部分记为缺失。
- 8.7 的四项事实与合成数据的已知值相等。
- 片段取值：一个合并片段里分别有一致、无文字层、有差异的叶块时，片段取 `text-layer-differs`，差异是各叶块差异的并集；跨页片段的每个叶块只与本页比。
- 对比：带 HTML 标记与字符引用的表格，印出的文字与文字层一致时取 `text-layer-match`；只有 LaTeX 的公式去掉记号后没有词时取 `no-text-layer`；对上 30% 以上但缺词的叶块取 `text-layer-differs`。
- 逐页校订请求在共用对比代码前后，对同一组合成页得到逐字节相同的请求和 `page_input_sha256`。
- 断段与层级：首页单位行（`text` 类型）阻断跳过；论文题名参加样式统计；没有编号和可靠样式时层级为 `title_level + 1`。
- verified reader 在页面工具不可用时仍能读取已形成的初稿；改动初稿内容一个字节即核验失败。
- 失败码：页面工具不可用、超过上限、仅 Markdown 无法定页、来源篡改、原始解析提交后取消，各得到 8.2 表中对应的码，原始解析保留。
- 默认关系：重新解析后初稿失败时该部分没有默认文本，读取返回 `document-missing`；部署 profile 改变后旧版本仍按 ID 可读，默认文本直到形成新初稿才变化。
- 差异读取：小 `max_bytes` 分多次续读后拼出的 JSON 与一次读出的相同；对校订稿返回 `document-unsupported`。
- 长文档：上线后新建的长文档在 `unreviewed` 页带初稿取值、builder 为 v5；已发布的 v4 长文档按 v4 重建，hash 不变。
- 8.10 表中每个读取方遇到初稿时的行为各有一例；8.11 的预览计数与创建任务后的成员一致。

### 8.10 各读取方对初稿的处理

现有读取方默认只接受校订稿（8.3）。下表逐项写明遇到初稿时接受还是返回缺口：

| 读取方                                                                                  | 遇到初稿                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文档读取（describe、outline、segments、slice、resources、resource、资源字节、evidence） | 接受，结果带 `text_level`（8.4）                                                                                                                                                                                                                        |
| 全文索引与查找（06 §4.9）                                                               | 接受。索引收入全部已接纳的固定文档版本，两级相同；命中带 `text_level`                                                                                                                                                                                   |
| 解析后的文章身份核验（第 7 节）                                                         | 接受。它比较的是文章自身的题名、署名和标识符，不依赖文本等级。判断照旧绑定具体 DocumentVersion；当前标签对齐的是该部分当前的默认文本，不论哪一级                                                                                                        |
| 全文翻译                                                                                | 接受，初稿是阅读辅助。来源取主 PDF 的默认文本：是初稿时取初稿的叶块，按解析类型选块（`text`、`title`、`caption`、`list`、`footnote`），`reference` 类型不翻译；初稿没有角色，作者行照常翻译。主 PDF 没有默认文本时返回现有的 `translation-not-archived` |
| 外部提取（第 5 节例子）                                                                 | 接受。提取准备固定默认文本，不论等级；每次读取（准备的清单、片段读取、证据解析）都返回 `text_level`，初稿片段另返回 `basis`                                                                                                                             |
| 知识加工                                                                                | 接受，规则见 8.6                                                                                                                                                                                                                                        |
| 批注锚点校验                                                                            | 接受，规则见[用户整理 9.2](09-user-organization.md#92-初稿上的批注)                                                                                                                                                                                     |
| 标签、元数据、参考文献                                                                  | 不接受。它们是建档步骤，只读校订稿（6.5）；初稿不提供，不返回缺口也不改读初稿                                                                                                                                                                           |
| 整理与人工保存（6.6）                                                                   | 不接受。请求绑定 proofread ID，初稿没有，无从提交；初稿不接受人工改字（8.3）                                                                                                                                                                            |
| 校订对照（`corrections`）                                                               | 不接受，返回 `document-unsupported`；初稿的差异用 8.3 的 `draft-differences` 读取                                                                                                                                                                       |
| 结构注释（`document annotate`）                                                         | 不接受，返回 `document-unsupported`；初稿没有结构注释                                                                                                                                                                                                   |
| READY 判定（6.5）                                                                       | 不变：默认文本是初稿时不成立 READY                                                                                                                                                                                                                      |

### 8.11 补形成初稿的维护操作

为已有的原始解析形成初稿，用一次显式的维护操作。它同时覆盖两种对象：

- 没有初稿的原始解析：默认处理。
- 初稿是用旧方法形成的：只在请求打开 `include_older_method` 时处理。8.2 的“初稿方法改变时，只在使用者显式发起时重新形成”就是指这个开关。

**请求。**

```text
FormDraftsRequest
  selector: AcquirePdfSelector            # {kind:"query",query,sort,limit} | {kind:"literatures",literature_ids}
  include_older_method: bool = false
  idempotency_key: str
```

- 范围的写法与获取 PDF 相同（[查询技术篇 2.1.6](06-retrieval-context.md#216-入库批次范围词频与-pdf-获取范围)）：`query` 由服务端展开全部命中，不受前端已加载行数限制；`literatures` 是点名的文献，最多 10,000 篇。
- 对象是文献的每个部分（主 PDF 与补充材料）。每个部分只看 8.2 的输入：部署 profile 的当前原始解析，没有时用 `vlm-engine-markdown-only` 原始解析。
- 一个部分“要处理”：它有这样的原始解析，并且该原始解析没有任何初稿；或者 `include_older_method` 为真，且它的当前初稿的 `draft_method_sha256` 不是当前方法。
- 一篇文献“要处理”：至少有一个部分要处理。两种范围都按同一规则跳过：同样的输入和方法得到同样的字节（8.2），点名也没有可强制的事。

**预览。** 提交前用同一个选择函数读出计数，不形成初稿：

```text
FormDraftsCounts
  matched                 # 范围命中的文献数
  process                 # 要处理的文献数
  process_parts           # 要处理的部分数
  skipped_has_draft       # 有原始解析的部分都已有初稿（按 include_older_method 的口径）
  skipped_no_raw_parse    # 没有一个部分有可用的原始解析
  over_limit              # query 范围中排在 limit 之后的要处理文献
```

`matched = process + skipped_has_draft + skipped_no_raw_parse + over_limit`；`process_parts` 不计入这个等式。`query` 范围先跳过，再按 `sort` 取前 `limit` 篇，同获取 PDF。

**执行。**

- 作为持久任务运行，与获取 PDF、`complete parser` 的批量维护任务相同：成员在创建时固定，之后入库或新解析的文献不加入；任务保存 `scope: {selector, counts}`，任务列表、详情和运行记录返回同一份。持久任务的目标为 `draft`。
- 单次上限与这些任务相同：固定的目标超过 10,000 篇时拒绝创建任务，返回相同的错误。
- 并发受 `[execution].max_concurrency` 限制。不调用模型，不联网，不解析，不建档。
- 每个部分按 8.2 形成，默认文本按 8.5 更新，索引刷新按 6.5 排队。取消保留已提交的初稿；一个部分失败不影响其它部分和其它文献。

**回执。** 每篇目标给出各部分的结果：

```text
FormDraftsPartResult
  asset_id, part: "main" | "supplementary"
  status: "formed" | "reused" | "failed" | "skipped"
  document_version_id: str | None
  failure_code: DraftFailureCode | None     # 8.2 的表
  default_changed: bool
```

`skipped` 是不需要处理的部分（已有初稿或没有原始解析）。`reused` 只在创建任务后另一操作先形成了同一初稿时出现。

**入口。**

| 动作     | HTTP                                                                                 | CLI                                                  | MCP                   | 设备用途  |
| -------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------- | --------- |
| 预览     | `POST /api/v1/query/form-drafts-preview`，request `{selector, include_older_method}` | `sciretriever form-drafts preview --request FILE\|-` | `form_drafts_preview` | `read`    |
| 创建任务 | `POST /api/v1/maintenance/form-drafts`，request `FormDraftsRequest`                  | `sciretriever form-drafts start --request FILE\|-`   | `form_drafts`         | `operate` |

HTTP 使用 `protocol_version: 1` 封套与现有维护认证；任务进度与结果用现有任务读取。
