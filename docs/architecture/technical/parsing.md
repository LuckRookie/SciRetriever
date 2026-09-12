# Parsing 模块技术设计

- 总技术入口：[技术文档索引](../technical.md)
- 设计责任：[设计文档 4.5](../design.md#45-parsing)
- 产品需求：[R4 文献解析](../requirements.md#r4-文献解析)
- Parser 服务边界：[ADR 0003](../decisions/0003-operator-managed-mineru-service.md)
- 当前中间合同：[ADR 0010](../decisions/0010-parser-neutral-markdown-current-result.md)

本文定义活动 `apps/server/src/parsing/` 的 ParserBackend、后端选择、parser-neutral Markdown `ParserResult`、结构检查、当前结果替换和资产 lineage。Parsing 不判断文献身份、实际内容或参考文献边界，不形成 `LiteratureContent`，也不拥有 MinerU 等外部 Parser 服务。

## 1. 目标结构

```text
parsing/
  ports.ts
  service.ts
  artifact-rules.ts
  publication.ts
  backends/
    mineru/
      index.ts
      http.ts
      loopback.ts
      archive.ts
```

- `service.ts` 组织 ParserBackend 调用、结构接纳、stale 复检和当前结果替换；
- `artifact-rules.ts` 检查 Markdown、资源、hash、页数、provenance 和输入对齐；
- `ports.ts` 声明 Parsing 与所有后端共享的 ParserBackend 兼容性接口，以及 artifact 存取能力；
- `backends/` 按具体后端隔离私有协议，并转换为统一合同；每个后端拥有自己的子目录和导出入口。

`ParserBackend` 是 Parsing 模块内部所有后端的稳定兼容性接口，不是动态第三方插件平台。`bootstrap` 根据已解析配置显式构造一个后端；同一 PDF 一次只调用一个后端，不竞赛、不合并，也不自动回退。增加 GROBID、Docling 或 PyMuPDF 等后端时，只需在 `backends/<name>/` 实现该接口并完成同一组结构验收，Analysis 不需要理解新的输入格式。MinerU 只是当前的一个后端，不拥有 Parsing 公共合同。

## 2. 输入与 ParserBackend

Parsing 公开输入只定位已经接纳的当前主 PDF：

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
ParserBackend.parse(ParserRequest) -> staged parser output
```

`staged parser output` 只存在于 Parsing backend 边界，可以包含本次转换所需的临时 Markdown、资源和后端私有产物；它不是公共 Model，也不能直接持久化为产品事实。backend 在返回 Parsing service 前必须完成 vendor/service 类型隔离和初步协议验证。

Operator-managed MinerU 的 submit、poll、resume task 和归档下载仍属于 `backends/mineru/` 内部。外部 task ID 只服务当前尝试的有界恢复和诊断，不进入 `ParserRequest`、`ParserResult` 或 Catalog。

当前 production backend 锁定 MinerU 3.4.4、protocol 2、profile `vlm-engine`、archive
backend `vlm` 与 parse method `auto`。Bootstrap 从严格 `[parsing]` 读取 connection mode、
Base URL、model identity 与 remote upload consent；remote bearer token 从统一凭据文件读取并
与规范 origin 精确绑定，loopback 不读取 token。`config test parse` 复用同一 production
client 但只执行 health/release/protocol/profile 检查，不提交 task 或上传 PDF。

## 3. Backend 转换

不同 backend 使用自己的转换路径：

```text
MinerU Markdown/JSON/images ──> MinerUBackend ──┐
GROBID TEI                  ──> GROBIDBackend ──┤
Docling JSON                ──> DoclingBackend ─┼─> normalized Markdown + resources
PyMuPDF text/blocks         ──> PyMuPDFBackend ─┘
```

公共结果由 Analysis 的消费需要定义，不由 MinerU 输出定义。backend 必须：

1. 验证自己支持的 Parser 版本、mode 和原始输出合同；
2. 恢复该 Parser 能稳定表达的阅读顺序；
3. 产生 UTF-8、非空的规范化 Markdown；
4. 把 Markdown 实际使用的本地资源改写为规范化相对引用；
5. 提供实际引用资源的字节、媒体类型、大小和 SHA-256；
6. 形成 parser identity、有效参数 hash 和输入 hash；
7. 隔离并在尝试结束后清理私有过程文件。

MinerU 的 VLM、pipeline 或其它 backend 是同一个 MinerU backend 的显式 profile。配置与返回声明不一致、版本不受支持或输出合同无法无歧义转换时稳定失败；backend 不根据 JSON 形状偷猜 mode，也不在一个 mode 失败后自动切换另一个 mode。只有未来真实输出合同出现不兼容时，才在 `backends/mineru/` 内增加版本或 profile 专属转换器，公共 `ParserResult` 不变。

## 4. ParserResult 精确合同

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

### 4.1 Artifact 与资源

`markdown` 指向已通过 Storage create-if-absent 发布的不可变 Markdown；其 `media_type` 固定为 `text/markdown`，实际字节必须是合法 UTF-8。`byte_size` 非负，`sha256` 与实际字节一致。Model 不保存 Markdown 正文、绝对路径或 Storage 私有 row。

`ParserResource.reference` 是 Markdown 中实际出现的规范化相对引用。它必须非空、使用 `/` 分隔，不能是绝对路径、父目录逃逸、反斜杠路径、带 userinfo 的 URL 或外部网络地址。相同 `reference` 只能出现一次；resources 按 `reference` 确定排序。每个引用都必须对应已经发布且 hash/大小/媒体类型一致的 artifact，未引用文件不得进入 `ParserResult`。

Parsing 只理解“Markdown 使用了这个资源”，不解释图片、表格或其它资源的科学内容。当前 Analysis 可以只读取 Markdown；资源的存在不等于已经支持多模态分析。

### 4.2 Parser provenance

`ParserProvenance.provenance` 复用公共 `Provenance`：

- `source_kind` 固定为 `parser`；
- `source_name` 是稳定 Parser 名称；
- `source_record_id` 固定为 `None`；
- `observed_at` 是结果完成并被接纳的 UTC 时间；
- `input_sha256` 必须等于 `source_sha256`；
- `parameters_sha256` 必填，并覆盖 Parser 名称/版本、mode、model identity、影响输出的有效选项和 Markdown 转换规则版本。

`parser_version` 必填非空；没有 mode 或模型的 Parser 使用 `None`。Endpoint、secret、header、Cookie、GPU 编号、机器路径、task ID、原始参数字典和未脱敏错误不能进入 provenance。

### 4.3 Result hash

`result_sha256` 对规范结果清单计算。清单包含：

- `source_asset_id`、`source_sha256` 和 `page_count`；
- Markdown artifact 的 hash、媒体类型和大小；
- 按 `reference` 排序后的全部资源引用和 artifact 描述；
- Parser 名称、版本、mode、model identity 和 `parameters_sha256`。

清单不包含 `observed_at`、`provenance_id`、task ID、endpoint、临时路径或 Catalog 相对路径。同一规范输入必须得到相同 hash；任何实际输入、内容、资源或有效解析配置变化都形成不同 hash。

### 4.4 明确不进入合同的内容

`ParserResult` 不包含：

- MinerU `middle.json`、`content_list.json`、model output 或其它私有 JSON；
- GROBID TEI、DoclingDocument 或 PyMuPDF 私有 block；
- Markdown 正文的第二份数据库副本；
- page/block graph、bbox、逐段 `SourceLocator` 或 Parser 私有坐标；
- 摘要、正文、参考文献等业务章节判断；
- 内容可用性、confidence、完成状态、失败详情或外部 task 状态。

## 5. 结构接纳

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

Parsing 不使用固定最小页数、固定最小字符数、标题匹配、摘要存在、公式数量或参考文献数量判断实际内容。识别错误、数值错误、只有封面/错误页、正文是否完整和文献是否值得保留属于 Analysis 第一阶段的内容判断。

## 6. 当前结果发布与替换

每个输入 `Asset` 最多只有一个 Catalog 当前 `ParserResult`。发布流程为：

1. 在 owner-only staging 中完成 Parser 调用和转换；
2. 校验 Markdown、资源、provenance 和结果 hash；
3. 按内容寻址 create-if-absent 发布新的 Markdown 与资源字节；
4. 开启短 SQLite 事务，复检当前主 PDF ID/hash；
5. 原子新增或替换该输入 Asset 的当前 ParserResult 关系；
6. 提交后解除旧 ParserResult 的 Catalog 引用；
7. 旧 artifact 进入不受产品合同保证的本地缓存，并由统一缓存预算回收。

新解析、转换、文件发布、stale 复检或 SQLite 提交失败时，只能观察完整旧结果或没有结果，不能暴露部分新结果。文件字节不原地覆盖；“替换”只表示当前数据库关系切换。Catalog 不保存旧 ParserResult、旧 provenance、旧参数或 task 历史。

当前 ParserResult 是可替换、可重建的中间结果，不推进 `UNREVIEWED`、`ASSET_READY` 或 `CONTENT_READY`。已经发布的当前 `LiteratureContent` 通过单一 Analysis provenance 的输入 hash 绑定 PDF、ParserResult 和最终 metadata；Parser provenance 由 ParserResult 自身保存，不复制到内容。旧 ParserResult artifact 不要求永久保留，后续重解析也不会自动覆盖当前 LiteratureContent，只有新的完整 Analysis 结果经 Literature 接纳后才能替换它。

## 7. 私有过程文件与清理

MinerU 的原始归档、`middle.json`、`content_list*.json`、model output、layout/span PDF、origin PDF 副本和未引用图片，以及其它 Parser 的 TEI、JSON、调试文件和未引用资源，全部位于本次 staging。成功接纳或尝试结束后清理，不进入 Catalog、ParserResult、provenance 或用户查询。

只有 Analysis 返回结构有效的 `NoUsableContent` 时，Entry 才协调删除当前主 PDF、当前 ParserResult 和待验收结果；Parser 或 LLM 调用失败不能触发删除。已接纳的有效 `LiteratureContent` 不由重解析失败、其它候选或引用 lookup 失败自动删除。

## 8. 失败语义

- Parser 不可用、timeout、协议错误、版本/mode 不一致、私有输出错误、Markdown/资源验证失败和 stale 输入都属于解析失败；
- 解析失败保留当前主 PDF 和已经存在的完整当前 ParserResult；
- 单篇失败不影响其它目标；
- 外部 task ID 只在当前尝试的有界恢复中使用，retention 到期或服务不认识 task 时由本次尝试失败或重新提交，不形成产品状态；
- 诊断只保存有界、脱敏的目标级失败，不保存原始归档、用户正文、secret、task URL 或机器路径。

## 9. Backend 验收

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
