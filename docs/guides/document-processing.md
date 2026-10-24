# PDF 解析与校订

类型：指南
负责：原始解析、校订编辑与证据读取操作
状态：现行

解析处理已经接纳的正文或补充 PDF，要求当前单一 catalog schema（内部标识 11）。先从文献详情取得 Literature ID、Asset ID 和 PDF SHA-256。普通解析命令不转换 catalog；新库与隔离转换见[升级指南](upgrade.md)。

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

## 校订服务

校订读取已经解析的材料。文字层用于找疑点，DSH 通过原图与放大工具矫正抄录；不总结、不润色。每页疑点都处置且扫描页都检查后为 `complete`，无法确定的理由保留在处置记录中、不阻断完成；模型未配置或预算耗尽为 `incomplete`，可以继续；异常中止或非空页面没有对应内容且没有无正文处置则失败。

```bash
sciretriever proofread build --request request.json --json
sciretriever proofread inspect --request request.json --json
sciretriever proofread page --request request.json --json
sciretriever proofread decide --request decision.json --json
sciretriever proofread revoke --request decision.json --json
```

- `build`：`{"asset_id":"…"}`，读取部署 profile 的原始解析；旧 Markdown 登记可以按唯一、顺序一致的文字层页归属复用，不能确定则返回 `proofread-needs-parse`。不会代为解析。
- `inspect`：按 `offset/limit` 读取初稿、校订区块、疑点、编辑与 `decisions`；按 `page_offset/page_limit` 读取页面状态及页面决定，分别跟随 `next_offset` / `next_page_offset`。每次响应有字节上限。
- `page`：`{"asset_id":"…","page":0,"region":null}`。返回原 PDF 页面 PNG 与固定资产 hash；这里页码从 0 开始，region 可为 0–1000 归一化区域。只读，不启动模型或解析。
- `decide`：填写 inspect 的 `proofread_id`、`block_id`、`draft_sha256`、`expected_manual_revision`，以及 `asset_id`、`actor`、`reason`、`action` 和 `text`。action 为 `replace`（text 为修订文字；表格区块须提交完整 HTML table，包含行和单元格，格式不符时不保存决定）、`resolve-suspect`（附 suspect_id 与 disposition）或 `no-body`（附 page）；其余动作 text 为 null。页无区块时使用 inspect.pages 中的页面身份。决定锁定，旧 revision 或已改变的初稿被拒绝。
- `revoke`：`{asset_id, decision_id, expected_manual_revision, actor}`；只撤销所选决定，随后显式重新建档应用。重新解析不会自动丢弃人工冲突。

MCP 对应 `proofread_build/inspect/page/decide/revoke`，HTTP 与 CLI 复用同一业务边界。只有显式写操作才会调用矫正模型。校订使用 `[proofread].model`（未指定时沿用分析模型）和 `max_calls_per_document`；必须具备图片与工具能力。调用次数与 token 单独记录，不作为质量分数。

## 校订稿发布与读取

完整校订版本可以显式发布为该 PDF 的默认全文，正文和补充材料分别拥有固定文档。此操作不调用 MinerU 或模型；`expected_default_revision` 来自 `document default`，没有默认版本时为 `null`。

```sh
sciretriever document publish-proofread --request request.json --json
sciretriever document parts --request parts.json --json
sciretriever document corrections --request corrections.json --json
```

发布请求：`{literature_id, asset_id, proofread_id, expected_default_revision}`。回执给出固定文档、`published`、默认版本 CAS 结果与 `index_status`（updated / unchanged / failed）。默认版本冲突不覆盖另一操作的选择，已发布固定版本仍保留；索引刷新失败也不撤销全文，可显式重建索引。

部分列表请求：`{literature_id, offset, limit}`，每页最多 200 项。返回正文与补充材料的资产 ID/hash、默认版本和校订状态，不读取全文或图片。

对照请求：`{document_version_id, segment_id, max_bytes, continuation}`，`max_bytes` 不超过 65536，首次 continuation 为 null。响应 `encoding=json-utf8` 的 `text` 是固定对照记录的有界 JSON 字节片段；按 continuation 收集后再解析，可以无损读取超大区块。记录包含固定初稿、最终区块、疑点及处置、编辑记录，以及原图页/区域引用；这个接口用于人工追查，不加入算子的阅读工具。

MCP 对应 `document_publish_proofread` 与 `document_read` 的 `parts` / `corrections` 操作；HTTP 使用同名 query/maintenance 操作。原有 describe/outline/segments/slice/evidence 仍是统一读取入口。校订稿片段的公开页码从 1 开始，结构存储从 0 开始；证据同时保留片段 hash 与 `page-region-v1` 定位。篡改页码或区域会被拒绝，保留的校订固定版本仍可读取；解析入口不会生产旧文档。

显式校订/发布不等同于文献已就绪；仍须完成结构、必填元数据与标签。参考文献缺失会形成不阻断就绪的问题。真实服务验证与库转换分别需要授权。

## 结构注释与角色

对一份已发布的校订全文显式执行：

```bash
sciretriever document annotate --request /absolute/annotation-request.json --json
```

请求为 `{"document_version_id":"固定全文版本 ID","max_prefix_characters":512}`。已知标题按规则识别；未知顶层章节交给已配置的 analysis DSH，输入仅包含标题、限定长度的首段和相邻角色。未配置模型或调用失败时，角色为 `body` 并记录原因。相同文档、方法配置和人工 revision 复用已发布注释。

返回 `annotation_id`、`manual_revision`、章节/参考文献数量和 `structure_satisfied`。它是结构步骤的结果，不等同于文献整体已就绪。图表与引用文本由校订稿片段确定；库内引用关系由建档参考文献步骤更新。

- `document outline` 可附带 `annotation_id` 固定角色解释，响应章节包含 `role` 和 `role_source`。
- `document segments` 可附带 `roles`（如 `["methods","references"]`）和 `annotation_id`；只返回对应的校订稿片段。没有注释时不假装完成角色筛选。
- `document role --request FILE|-` 请求为 `{"document_version_id":"…","section_id":"s1","role":"methods","expected_manual_revision":0,"actor":"本人"}`。设置角色即锁定；`role:null` 解除锁定。人工决定和新注释在同一事务发布，旧 revision 被拒绝，旧注释仍可读取。重新识别同一全文不会覆盖锁定角色。人工修正只沿用已有判断和重算继承，不调用模型；解除一个没有规则可识别的角色锁定时，先使用 `body` 并记录 `role-reclassification-needed`，需要时再显式 `document annotate`。
- `document annotation --request FILE|-` 使用 `{"document_version_id":"…","annotation_id":null,"field":"all","max_bytes":65536,"continuation":null}`；`field` 也可为 `figures` 或 `references`。逐段拼接响应的 `text`，到 `continuation:null` 后解析 JSON。续读固定第一段的注释版本，期间人工修改不影响已有读取。
- `document figures`、`document references` 使用相同请求去掉 `field`。它们读取图表清单和有序引用文本；figures 的公开页码从 1 起计，`all` 返回的不可变注释内部页码从 0 起计。

MCP 的 `document_annotate`、`document_role`、`document_annotation` 和 `document_read` 的 `outline/segments/figures/reference-texts` 操作使用同一业务实现。读取不会触发解析、模型调用或建档。角色与注释保存在全文之外，修改角色不会改写原始 PDF、校订文字或已有证据定位。

## 元数据字段与人工校正

当前只维护 schema.ts 的一份结构，内部标识为 11。元数据的出版形式 `publication_form` 与文章性质 `article_kind` 是不同的封闭枚举；旧 `document_type` / `document_types` 已移除。CLI 搜索用 `--publication-form` 和 `--article-kind`；JSON 查询用 `publication_forms` 和 `article_kinds`。原始来源类型保留在 observation 的 `source_type` 与 `source_type_mapping_version` 中。

`literature metadata-fields --request FILE` 读取 `{ "literature_id": "…" }` 的当前元数据、revision、字段来源、冲突与锁定。`literature metadata-edit --request FILE` 接受 `{ "literature_id": "…", "expected_revision": 1, "set": [{ "field": "article_kind", "value": "review" }], "unlock": [] }`；设置会锁定字段，包括显式空值。解锁用同一请求的 `unlock` 数组，`set` 置空。MCP 对应 `metadata_fields`、`metadata_edit`。这些人工操作不调用模型，也不隐式启动建档。

既有真实 catalog 不自动转换，必须先备份、在隔离副本转换并核对，再单独确认切换。旧总结、知识与算子结果及旧 Markdown Document 的清理范围以既定转换决定为准，不保留多版本迁移阶梯。

建档显式处理元数据、结构与标签。Web 的字段编辑使用同一锁定机制。

校订预算耗尽后，重新发起建档/校订会复用已接受的页面提交，再处理剩余疑点；应用编辑后新发现的差异也进入这一步。没有进展或没有足够预算时仍保持未完成，不把缓存命中当作处置完成。无法确定的理由保留在处置记录中，不向算子提供另一套存疑标志；人工锁定的修改不能被自动流程覆盖。

表格校订必须提交 HTML 表格结构，保留原有参数、脚注与已登记原表图。阅读器只重建安全的表格结构、跨行/跨列和本地资源占位，不执行原始 HTML 中的脚本或事件。格式检查不是内容准确性证明，仍可打开固定原图核对。
