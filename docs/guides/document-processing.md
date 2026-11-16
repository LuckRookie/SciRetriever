# PDF 解析与校订

类型：指南
负责：原始解析、校订编辑与证据读取操作
状态：现行

解析处理已经接纳的正文或补充 PDF，要求当前单一 catalog schema（内部标识 12）。先从文献详情取得 Literature ID、Asset ID 和 PDF SHA-256。普通解析命令不转换 catalog；新库与隔离转换见[升级指南](upgrade.md)。

## 显式解析

```bash
sciretriever document parse --literature-id LITERATURE_ID --asset-id ASSET_ID --asset-sha256 PDF_SHA256 --json
```

默认只运行部署配置 `[parsing].archive_profile`，未指定时为 `vlm-engine`。已有相同输入、参数、parser/model identity 的成功结果时复用，只补缺失或失败的模式。`--profiles pipeline` 可以指定这次要执行的来源；`--force` 明确重新执行选定模式。另一个 profile 可显式解析供人工查看；校订只消费部署 profile 的一份初稿。修改部署 profile 不会覆盖已发布校订版本。

回执包含固定 PDF 身份，以及每个 profile 的 `published/reused/failed`、原始解析 ID/hash、稳定失败代码。一种失败不会撤销另一种已提交的产物。任务保留部分结果，并将该目标标为失败；显式重试默认只补失败项。强制重解析的任务重试仍保留原始 force 请求语义。

解析不生成可读 DocumentVersion、不修改默认全文，也不会触发建档或总结。旧 `--mode`、`--expected-default-revision` 和必填 Document 回执已移除，不提供旧合同兼容。

```bash
sciretriever document parsing-status --request request.json --json
```

`request.json` 为 `{"literature_id":"…","asset_id":"…"}`。此查询只读，显示各 profile 的原始解析与失败代码，并标出 `archive_profile`；不会调用 MinerU。MCP 使用 `document_read` 的 `parsing-status` 操作；执行解析使用 `submit_processing` 中的 `parse-documents` 操作，请求如下：

```json
{
  "literature_id": "LITERATURE_ID",
  "asset_id": "ASSET_ID",
  "asset_sha256": "PDF_SHA256",
  "force": false
}
```

## 解析之后的初稿

每次解析发布或复用部署 profile 的原始解析后，程序接着形成初稿：不调用模型，不联网，单独提交，失败不改变解析结果。解析回执的 `draft` 写出结果（`formed`、`reused`、`failed` 带原因、`not-formed`），CLI、HTTP、MCP 与持久任务相同。没有有效校订稿时，初稿就是默认文本，可以阅读、查找和读取证据；建档发布校订稿后默认文本换成校订稿。规则见[文档与证据 8.2](../architecture/technical/04-document-evidence.md#82-初稿的形成)。

已有原始解析、还没有初稿的文献，用补形成维护操作显式形成（`sciretriever form-drafts preview|start --request FILE`，HTTP 与 MCP 同名）。初稿与 PDF 文字层的差异已在形成时保存，用 `sciretriever document draft-differences --request FILE` 分段读取（MCP 为 `document_read` 的 `draft-differences`）；校订稿上返回 `document-unsupported`。

## 校订服务

新建档先整理，再只对保留叶块逐页校订。每页独立会话，对照页面图核抄录，不总结、不润色；无法确定时保留初稿和原因。没有保留叶块的页无需空提交。流程、停止保护与人工编辑见[文献建档指南](literature-archive.md#校订全文与单步处理)；模型绑定与旧配置诊断见[配置手册](configuration.md)。

```bash
sciretriever proofread build --request request.json --json
sciretriever proofread inspect --request request.json --json
sciretriever proofread page --request request.json --json
```

- `build`：`{"schema_version":2,"asset_id":"…","arrangement_id":"当前整理 hash","retry_page_indexes":null}`。只处理已有整理结果，不代为整理或解析；失败页局部重试可指定页索引集合，未选页不调用模型；其它页仍未完成时，该部分仍未完成。页输入未变时复用已接纳页，实际调用和用量单独记录。
- `inspect`：新稿返回 `format=arranged-v2`、固定 proofread_id、`encoding=json-utf8` 与 `next_offset`；按 offset 拼接 text 后解析页处置、保留叶块与改字。历史稿仍用历史读取合同，不把历史编辑格式用于新写入。
- `page`：`{"asset_id":"…","page":0,"region":null}`，只读原 PDF 页面 PNG 与固定资产 hash；page 从 0 开始，region 可为 0–1000 归一化区域，不启动模型或解析。

MCP 使用 `proofread_build/inspect/page`，HTTP 与 CLI 共享应用边界。旧 `proofread decide/revoke` 与旧 build 请求返回 `archive-contract-obsolete`。恢复删除、改归属和段落文字编辑使用建档的 V2 编辑接口，不沿用旧 edit union。

## 校订稿发布与读取

完整校订版本可以显式发布为该 PDF 的默认全文，正文和补充材料分别拥有固定文档。此操作不调用 MinerU 或模型；`expected_default_revision` 来自 `document default`，没有默认版本时为 `null`。

```sh
sciretriever document publish-proofread --request request.json --json
sciretriever document parts --request parts.json --json
sciretriever document corrections --request corrections.json --json
```

发布请求：`{schema_version:2, literature_id, asset_id, proofread_id, expected_default_revision}`。回执给出固定文档、`published`、默认版本 CAS 结果与 `index_status`（updated / unchanged / failed）。默认版本冲突不覆盖另一操作的选择，已发布固定版本仍保留；索引刷新失败也不撤销全文，可显式重建索引。

部分列表请求：`{literature_id, offset, limit}`，每页最多 200 项。返回正文与补充材料的资产 ID/hash、默认版本和校订状态，不读取全文或图片。

对照请求：`{document_version_id, segment_id, max_bytes, continuation}`，`max_bytes` 不超过 65536，首次 continuation 为 null。响应 `encoding=json-utf8` 的 `text` 是固定对照记录的有界 JSON 字节片段；按 continuation 收集后再解析，可以无损读取超大区块。新稿记录包含叶块、校后文字、对应页处置和 correct 记录；历史稿包含原固定初稿与编辑记录。两者均包含原图页/区域引用；这个接口用于人工追查，不加入算子的阅读工具。

MCP 对应 `document_publish_proofread` 与 `document_read` 的 `parts` / `corrections` 操作；HTTP 使用同名 query/maintenance 操作。原有 describe/outline/segments/slice/evidence 仍是统一读取入口。校订稿片段的公开页码从 1 开始，结构存储从 0 开始；证据同时保留片段 hash 与 `page-region-v1` 定位。篡改页码或区域会被拒绝，保留的校订固定版本仍可读取；解析入口不会生产旧文档。

显式校订/发布不等同于文献已就绪；仍须完成结构、必填元数据与标签。参考文献缺失会形成不阻断就绪的问题。真实服务验证与库转换分别需要授权。

## 结构注释与角色

对一份已发布的校订全文显式执行：

```bash
sciretriever document annotate --request /absolute/annotation-request.json --json
```

请求为 `{"schema_version":2,"document_version_id":"固定全文版本 ID","arrangement_id":"整理 hash"}`。从该 V2 全文绑定的整理归属确定性生成独立注释，不调用章节分类模型；旧自动分类写请求和 `document role` 返回 `archive-contract-obsolete`。新建档在渲染时已完成此派生，单步接口可验证或修复同一固定表示的注释。

返回 `annotation_id`、章节/参考文献数量、`structure_satisfied` 与零模型用量。正文就绪条件和人工归属锁见[文献建档指南](literature-archive.md)；命名角色与历史结果精确匹配，不猜测新旧角色的对应关系，无法表达的算子范围给出结构角色缺口。

- `document outline` 可附带 `annotation_id` 固定角色解释，响应章节包含 `role` 和 `role_source`。
- `document segments` 可附带 `roles`（如 `["methods","references"]`）和 `annotation_id`；只返回对应的保留片段。
- `document annotation --request FILE|-` 使用 `{"document_version_id":"…","annotation_id":null,"field":"all","max_bytes":65536,"continuation":null}`；`field` 也可为 `figures` 或 `references`。拼接 text 到 continuation 为 null 后解析 JSON，续读固定首段的注释版本。
- `document figures`、`document references` 使用相同请求去掉 field。图表公开页码从 1 起计；不可变注释内部页码从 0 起计。

MCP 的 `document_annotate`、`document_annotation` 和 `document_read` 的 `outline/segments/figures/reference-texts` 操作使用同一应用边界。读取不触发解析、模型调用或建档；旧固定全文、注释和证据照常读取。

## 元数据字段与人工校正

当前只维护 schema.ts 的一份结构，内部标识为 12。元数据的出版形式 `publication_form` 与文章性质 `article_kind` 是不同的封闭枚举；旧 `document_type` / `document_types` 已移除。CLI 搜索用 `--publication-form` 和 `--article-kind`；JSON 查询用 `publication_forms` 和 `article_kinds`。原始来源类型保留在 observation 的 `source_type` 与 `source_type_mapping_version` 中。

`literature metadata-fields --request FILE` 读取 `{ "literature_id": "…" }` 的当前元数据、revision、字段来源、冲突与锁定。`literature metadata-edit --request FILE` 接受 `{ "literature_id": "…", "expected_revision": 1, "set": [{ "field": "article_kind", "value": "review" }], "unlock": [] }`；设置会锁定字段，包括显式空值。解锁用同一请求的 `unlock` 数组，`set` 置空。MCP 对应 `metadata_fields`、`metadata_edit`。这些人工操作不调用模型，也不隐式启动建档。

既有真实 catalog 不自动转换，必须先备份、在隔离副本转换并核对，再单独确认切换。旧总结、知识与算子结果及旧 Markdown Document 的清理范围以既定转换决定为准，不保留多版本迁移阶梯。

建档显式处理元数据、结构与标签。Web 的字段编辑使用同一锁定机制。

校订停下后，显式重试会按页输入复用已接纳的提交，再处理未完成页；应用编辑后新发现的疑点也进入处置检查。缓存命中须通过同一验证，不把缓存存在当作处置完成。无法确定的理由保留在处置记录中，不向算子提供另一套存疑标志；人工锁定的修改不能被自动流程覆盖。

表格校订必须提交 HTML 表格结构，保留原有参数、脚注与已登记原表图。阅读器只重建安全的表格结构、跨行/跨列和本地资源占位，不执行原始 HTML 中的脚本或事件。格式检查不是内容准确性证明，仍可打开固定原图核对。
