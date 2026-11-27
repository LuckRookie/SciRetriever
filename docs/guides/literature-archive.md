# 文献建档

类型：指南
负责：建档发起、状态核对与问题处理
状态：现行

获取 PDF 与建档是两个独立操作。建档依次为解析、整理、逐页校订、渲染、翻译、分层、元数据、参考文献、标签：某个部分还没有部署 profile 的原始解析时先调用 MinerU，已有解析直接复用，重新建档不会重新解析；建档不生成全文总结。翻译一步把校订好的全文逐段译成配置的译文语言（`[translation].target_language`，默认简体中文）并存进文献库；全文已经是这种语言时不翻译；它失败不影响全文是否就绪，问题进入需处理，恢复时只补没翻的段。分层一步为这篇文献写出概览与脉络（提要、要点与每个要点在全文里的依据），存进文献库；依据由程序在全文里确认位置，确认不了的不保留；长文档与过短的文献不做；它失败同样不影响全文是否就绪，问题进入需处理。单独的解析操作（`parse-documents`、维护页“解析 PDF”）保留，用于排查和重新解析。

Web、HTTP、CLI、MCP 走同一流程。整理只提交操作：页眉、页脚、页码和页边文字由程序在整理前删除并记录规则；确定的断段（跨页、跨栏或跨图表且前句未完、后块小写开头，或行尾连字符）由程序直接合并，其余断段与“末行排满、下段不缩进”的跨页跨栏续接交模型一次裁决；粘在正文里的版权句、页归属由程序按 PDF 文字层处理；校订逐页对照原图。校订稿按原文的章节顺序与原文标题排版，不写原文没有的标题；首页的单位、日期等文章信息排在作者之后，同一图注的分图合成一组，页脚注放在引用它的段落之后，这些排版信息由文档结构给出，Markdown 正文不加标记（[ADR 0054](../architecture/decisions/0054-rule-preprocessing-and-source-order-layout.md)）。真实库转换和全量重建是独立维护步骤，现有用户库不会在启动时自动转换。

**长文档**：超过 50 页或整理输入超过单次上限的部分自动按简化流程建档（[ADR 0055](../architecture/decisions/0055-long-document-simplified-archive.md)）：整理按整页分段，校订不调用模型、各页记为未逐页校订，元数据只读前 20 页与最后 5 页。建档完成后状态仍为 READY，`archive status`、`document describe` 与文献列表带 `long_document`（页数、整理输入字节数、命中的条件），阅读页、文献库与任务详情注明“长文档，未逐页校对，以 PDF 为准”（界面把建档叫“解析全文”，用词见[页面规格 · 界面用词](../architecture/web/page-specs.md#界面用词)）。需要时可用 `retry_page_indexes` 对选中的页按普通方式校订。

建档需要可用的 MinerU 连接（已有解析时不需要）和可用的 DSH 模型。校订的页面检查还需要已通过安装校验的 CloakBrowser runtime：`SCIRETRIEVER_CLOAK_BUNDLE` 应指向包含 `chrome` 和安装清单的具体版本目录，而不是它的缓存父目录；页面图由随包的 MuPDF `mutool` 渲染；从源码工作区或没有随包 runtime 的目录用 CLI 建档时，用 `SCIRETRIEVER_MUPDF` 指向本机 MuPDF bundle 目录，否则整理或校订报 `page-tools-unavailable`。安装方式见[安装指南](installation.md)。`parser-unavailable` 表示解析后端尚不可用；建档问题中的 `proofread-renderer-unavailable` 表示页面渲染 runtime 不可用。两者应分别检查，已完成的 PDF 接纳和解析不会因此撤销。

## 发起与恢复

```bash
pnpm sciretriever archive build LITERATURE_ID
pnpm sciretriever archive status LITERATURE_ID
pnpm sciretriever archive issues --part main
pnpm sciretriever archive resume LITERATURE_ID
pnpm sciretriever archive stats
```

CLI 等待所提交的持久任务结束；MCP 和 Web 应用边界返回任务编号，沿用已有任务的暂停、继续、取消与重试入口。一次选择最多 10,000 篇，超过上限会拒绝，不截断范围。显式 ID 列表用逗号分隔；复杂筛选使用 `archive build --request FILE`，文件为：

```json
{
  "schema_version": 2,
  "selector": {
    "kind": "literatures",
    "literature_ids": ["00000000-0000-0000-0000-000000000001"]
  },
  "mode": "full",
  "from_step": null,
  "idempotency_key": "archive-reviewed-batch-1"
}
```

`selector` 也可为 `{ "kind": "query", "query": LibraryQuery }`。`from_step` 可选择 `arrange`、`proofread`、`render`、`translate`、`layers`、`metadata`、`references`、`tags`，用于从该步骤重新检查并执行后续步骤（取 `translate` 时整篇重翻，取更早的步骤时文字没变的段沿用原来的译文）；取 `translate` 或 `layers` 时只强制这一步，元数据、参考文献与标签不依赖译文和阅读层，照常按输入复用，不会因此请求外部服务；固定输入、方法和人工决定均未变的成功检查点仍可复用。正常恢复不填此项，由当前输入和已保存回执决定复用。

`full` 要求正文已有部署 profile 的原始解析或可定位的已登记旧 Markdown。旧材料使用 `--mode legacy-vlm-markdown`，只要求已登记的 VLM Markdown，不要求 pipeline。页归属无法确定时报告 needs-parse。缺少这些材料时，成员回执是 `needs-parse`，不会代为解析。

## 状态与问题

- `UNREVIEWED`：没有主 PDF。
- `ASSET_READY`：已有主 PDF，尚缺解析或建档步骤。
- `ARCHIVING`：正在建档。
- `ARCHIVE_FAILED`：正文存在尚未解决的失败。
- `READY`：当前主 PDF 对应的校订稿、默认文档、结构、必填元数据和标签均满足要求；参考文献为空或疑点处置为无法确定不阻断就绪。
- `EXCLUDED`：勘误、社论、观点或评论类文章。人工修改文章性质后重新推导。

补充材料的缺失或失败不阻断正文就绪，问题条目标明 `affects_readiness: false`。人工整理修改使用 archive arrangement-edit；元数据和标签仍由各自命令维护。旧 document/structure 写请求返回 archive-contract-obsolete，历史固定结果照常读取。`archive resolve --request FILE` 接受 `{ "issue_ids": [...], "resolution": "continue" | "skip" | "cancel" }`，与任务介入使用相同的处理决定。确认或跳过问题不会补造缺失事实；取消会停止仍在运行的关联任务。

每个步骤保存输出和耗时。取消保留已完成的发布，恢复不重复执行输入、方法相同的模型步骤。单篇失败不阻断同批的其他文献。每批产生新标签后执行一次整理；整理失败单独记账，不撤销建档。

## 版本与统计

每个部分的内容版本由默认校订文档 ID 和结构注释 ID 决定；整篇描述版本由元数据 revision/hash 和标签分配 hash 决定。变化事件在原事实的数据库事务中保存。`archive events --after 0 --limit 100` 按递增序号读取，查询不生成事件、不触发重算。

`archive stats` 汇总解析页数和耗时、各建档步骤报告的模型调用/token、校订分类与整理状态。模型未返回用量的失败不能据此推算实际计费；统计不代表质量判定。

MCP 对应 `archive_query`（status/issues/stats/events）与 `archive_manage`（build/resolve/resume），共享 CLI 的应用边界。Web 已提供建档问题、显式解析与建档、统计以及元数据／标签／校订编辑入口，见 [Web 工作空间](web-workbench.md#解析全文标签与快照)。

[用户指南](README.md) · [解析与校订文档](document-processing.md) · [标签词表](tags.md)

文献库默认显示全部状态，可用快速筛选“有全文”查看已就绪文献。服务端结果接口返回六种文字核对状态及固定原文引用；片段不再保存“存疑”标记。

## 校订全文与单步处理

后端的 `proofread text --request FILE|-` 有界读取当前或指定校订稿，按 next_start 续读。新稿返回 format=arranged-v2；历史稿按历史格式解码。`proofread inspect` 与 `document corrections` 提供对应格式的页处置、疑点和改字，不能把旧 edit union 用于新写入；按 ADR 0047 校订的页没有疑点，页记录的 `review` 列出被拒的改字与模型拿不准的地方。

单步 `proofread build` 使用 `{schema_version:2, asset_id, arrangement_id, retry_page_indexes:null}`，只校已有整理结果；`document publish-proofread` 使用 `{schema_version:2, literature_id, asset_id, proofread_id, expected_default_revision}`，只渲染完整新校订稿；`document annotate` 使用 `{schema_version:2, document_version_id, arrangement_id}`，从固定整理派生注释。这些单步不会隐式解析或整理，渲染与注释不调用模型。

每页校订只发一次请求：模型看着页面原图，裁决解析文字与 PDF 文字层不一致的地方，一次交回本页全部改字。每处改字先经程序检查（是否印在那里、是否删了内容、是否把版权行或结构式标签写进正文等），不通过的不应用，原文保持不变；同一错字在一个区块里出现多次时一起改。规则见[文档与证据](../architecture/technical/04-document-evidence.md#63-逐页校订与复用)。

逐页校订可以同时运行几页，每页上下文仍独立；配置与限流降档见[配置指南](configuration.md#整理校订模型与停止保护)。一页停止不会撤销其它已接受页，指定页重试和页缓存复用保持原口径。任务回执按页码排序，运行中事件包含准确的必需、已接受、复用、待处理与失败计数。

全文发布后回执 `index_status=scheduled` 表示已排队刷新检索索引，建档可继续完成，固定全文可立即读取。索引失败不撤销文档；用 `maintenance index-status`、HTTP `POST /api/v1/query/index-status`（request `{}`）或 MCP `index_status` 查看状态及技术原因，再用 `maintenance rebuild-index`、HTTP `/api/v1/maintenance/rebuild-index` 或 MCP `rebuild_index` 显式重试。短命 CLI 退出时队列保留，下次维护进程继续；立即需要检索可显式重建。刷新完成前可能有 index-stale 缺口，详见[读取指南](library-query.md#上下文检索)。

`archive arrangement --request FILE|-`（MCP `archive_arrangement`）输入 schema_version=2、asset_id、proofread_id（首次可为 null）和 kind。summary 返回删除/改字/章节统计、人工 revision、当前固定文档与待校订页；leaves、breaks、source-map 和 pages 提供有界读取。leaves 还需 visibility、drop_reason、page_index，所有分页请求带 cursor、limit（最多 200）和 max_bytes（最多 64 KiB）。leaves/breaks/source-map 的 JSON-UTF8 text 需按 next_cursor 拼接后解码；pages 返回有界状态项。后续请求必须固定首次返回的 proofread_id。

`archive arrangement-edit --request FILE|-`（MCP `archive_arrangement_edit`）输入 schema_version=2、literature_id、asset_id、expected_proofread_id、expected_arrangement_id、expected_manual_revision 与 changes。restore/assign 指定 leaf_id、骨架 target、presentation。服务端绑定实际 actor，原子保存 destination 锁；并发变化拒绝覆盖，不隐式调用模型。恢复后若增加待校订内容，返回 pending_page_indexes，原固定文档仍可读；显式 archive resume 后才校订这些页。

`proofread save --request FILE|-`（MCP `proofread_save`）采用 schema 2，输入 literature_id、asset_id、proofread_id、expected_arrangement_id、expected_manual_revision、完整 markdown。全文最多 8 MiB。能唯一映射的修改保存为叶块 correct 并锁定；结构边界不唯一或新增无来源文字返回 typed mapping conflict，请在段落内修改。保存本身不调用模型，能重渲染时返回新固定文档，失败不撤销已保存决定。旧 page_starts_utf8 和任意插块写法不作为新合同别名。

## 建档与初稿

文献解析后已有初稿，建档在它之后形成校订稿；校订稿发布后成为默认文本，初稿仍按版本 ID 可读，依据初稿的结果按内容版本标为过时。初稿不接受人工改字，改字在建档后的校订稿上进行。长文档按简化流程建档时，未逐页校订页上的片段带初稿的三种核对依据（与文字层一致、有差异、没有文字层），重试校订过的页照旧；见[文档与证据 8.3](../architecture/technical/04-document-evidence.md#83-初稿的结构与核对依据)。

## 预计消耗与迁移

建档不设调用/token 上限。`usage estimate` 的 kind=archive、request={selector} 返回 ArchiveUsageEstimateV2：页数、六步的预计 calls/input/output、历史样本数与未知原因。只有匹配的新流程成功历史参与估算；无历史为未知，仍可显式发起。运行停止保护为同错 3 次、连续 8 次实际调用无进展；具体规则见[文档与证据](../architecture/technical/04-document-evidence.md#64-停止保护与受控上下文)。

已有整理和页输入仍匹配时，估算扣除整理及已接纳页的模型工作；缺少可复用整理时按全部 PDF 页保守估计，字段 page_basis 明示依据。整篇复用数不把只完成前几步的文献计算在内。

新六步沿用 schema 12 引入的步骤合同；当前 catalog 的状态投影转换与旧库离线切换统一见[初始化与恢复](upgrade.md#状态投影-schema-13)。打开旧库不会自动迁移，正式切换前须先备份并在副本核对，不修改文献资产或重建历史文档。
