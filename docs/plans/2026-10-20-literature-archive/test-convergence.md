# 本轮测试收敛记录

范围：Owner 已暂停新功能；本轮只修 A（夹具/初始化）和 B（保留模块缺陷），C 保留待第二版统一退役。无真实服务/真实库操作、无提交、无新依赖或 schema 版本。

## 全量命令台账

| 轮次 | 文件 | 用例 | 状态 |
| --- | --- | --- | --- |
| 开始 `pnpm full` | 执行 0 个测试文件 | 执行 0 项，跳过 0 项 | Prettier 在 127 个文件报错，未到 Vitest |
| 经 Owner 另行授权的补充 Vitest 基线 | 308：256 通过、36 失败、16 跳过 | 2,132：2,002 通过、90 失败、40 跳过 | 退出 1，845.61 秒 |
| 结束 `pnpm full` | 308：286 通过、6 失败、16 跳过 | 2,132：2,086 通过、6 失败、40 跳过 | 退出 1，984.29 秒；Quick 通过，测试失败使后续 build 未执行 |

所有 Vitest 使用 `VITEST_MAX_FORKS=3 VITEST_MIN_FORKS=1`；单独命令同时传 `--maxWorkers=3 --minWorkers=1`。一次只运行一个 Vitest。定向命令的名称过滤未选中项不算通过，也不混入整轮的既有跳过数。

证据目录：`/tmp/sciretriever-test-convergence-ndZSeC/`。`full-start.log` 是开始 Full，`baseline.json`/`baseline-failures.json` 是补充基线；`failure-classification.json` 含下表及原始堆栈。公开记录在此直接列出结论，不依赖临时文件链接才能理解。

## 根因修复

- A：按当前单一 schema、校订 Document、READY 算子输入、结果四态和 Web 入口重建合成夹具；保留字节/hash、数据完整性、无隐式模型调用等断言，不恢复旧迁移阶梯。
- B：修复原始解析提交后回执写入错误传播、外部交付误用内部就绪准备、只读提取准备路由缺失、搜索返回状态、证据返回结果、总结任务链接，以及快照 map 结果漏建索引。
- C：双 profile 前置条件、align/compare/merge/arbitration/crop 与旧就绪规则不改行为；仅进行了已获授权的格式整理。其测试通过也不代表第二版已实现。

## 90 项基线失败逐项归类

按首次失败位置归类：A 80 项、B 6 项、C 4 项。修正 A 类夹具后发现的外部交付依赖等真实缺陷另按 B 类根因修复，不能用修夹具掩盖。

| 序号 | 类 | 文件与测试名 | 根因 |
| --- | --- | --- | --- |
| 1 | A | `apps/web/test/next-extraction-maintenance.test.ts`<br>delivers a v5 extraction batch through the real Chromium maintenance form and refuses forged responses | 外部交付旅程误用已改成 READY-only 的内部准备；改为调用方固定 manifest，并验证独立交付的真实证据与持久回执。 |
| 2 | A | `apps/web/test/next-jobs-parity.test.ts`<br>durable task workbench recovers empty, failed, stale, cancelled and completed task states | Web 夹具假设默认显示全部状态，实际默认仅 READY；明确选择全部状态后验证原旅程。 |
| 3 | A | `apps/web/test/next-knowledge-journey.test.ts`<br>keeps parsing separate from document publication and reads existing verified knowledge in the authenticated workspace | 旧知识产物/综合入口与解析即更新全文的假设；按原始解析复用、显式建档和总结算子核验。 |
| 4 | A | `apps/web/test/next-knowledge-journey.test.ts`<br>preserves the default document during raw parsing and supports missing-model recovery (true) | 旧知识产物/综合入口与解析即更新全文的假设；按原始解析复用、显式建档和总结算子核验。 |
| 5 | A | `apps/web/test/next-knowledge-journey.test.ts`<br>preserves the default document during raw parsing and supports missing-model recovery (false) | 旧知识产物/综合入口与解析即更新全文的假设；按原始解析复用、显式建档和总结算子核验。 |
| 6 | A | `apps/web/test/next-launch.test.ts`<br>formal Web launch and database binding launches Web with default storage, imports literature and keeps the running binding fixed after path publication | Web 夹具假设默认显示全部状态，实际默认仅 READY；明确选择全部状态后验证原旅程。 |
| 7 | A | `apps/web/test/next-launch.test.ts`<br>formal Web launch and database binding launches Web with configured storage, imports literature and keeps the running binding fixed after path publication | Web 夹具假设默认显示全部状态，实际默认仅 READY；明确选择全部状态后验证原旅程。 |
| 8 | B | `apps/web/test/next-library-relations.test.ts`<br>restores search and detail history and reads more than 25 references with their separate evidence | 库搜索防抖未提交时打开阅读器，返回时搜索丢失。 |
| 9 | A | `apps/web/test/next-library-workflows.test.ts`<br>requires confirmation before a PDF dropped on a library row is accepted and never processes it implicitly | Web 夹具假设默认显示全部状态，实际默认仅 READY；明确选择全部状态后验证原旅程。 |
| 10 | A | `apps/web/test/next-library.test.ts`<br>paginates a 30,000-record library, bounds rendered rows, restores scroll and selection, and explains over-limit actions | Web 夹具假设默认显示全部状态，实际默认仅 READY；明确选择全部状态后验证原旅程。 |
| 11 | A | `apps/web/test/next-maintenance.test.ts`<br>accepts a selected PDF in Chromium, reads the same fact, and reports rejection and conflict | Web 夹具假设默认显示全部状态，实际默认仅 READY；明确选择全部状态后验证原旅程。 |
| 12 | A | `apps/web/test/next-motion.test.ts`<br>keeps repeated real workspace transitions responsive without frame-by-frame PDF painting (no-preference) | 筛选按钮已有计数，旧固定 accessible name 无法定位。 |
| 13 | A | `apps/web/test/next-motion.test.ts`<br>keeps repeated real workspace transitions responsive without frame-by-frame PDF painting (reduce) | 筛选按钮已有计数，旧固定 accessible name 无法定位。 |
| 14 | A | `apps/web/test/next-processing.test.ts`<br>submits enum labels on an explicit search scope and retains unparsed material as a gap | 沿用旧标签名称、默认全库/结果串联综合、提交即校验模型等设定；按当前 READY 筛选、快照和持久任务断言。 |
| 15 | A | `apps/web/test/next-processing.test.ts`<br>retains drafts and idempotent requests after a lost save receipt and a failed start | 沿用旧标签名称、默认全库/结果串联综合、提交即校验模型等设定；按当前 READY 筛选、快照和持久任务断言。 |
| 16 | A | `apps/web/test/next-processing.test.ts`<br>preserves a valid form when the analysis model is absent and never processes missing documents | 沿用旧标签名称、默认全库/结果串联综合、提交即校验模型等设定；按当前 READY 筛选、快照和持久任务断言。 |
| 17 | B | `apps/web/test/next-processing.test.ts`<br>keeps cross-page selections and fixed evidence while exporting every original record | 从证据返回结果时 URL 未清除 literature，继续停在阅读器。 |
| 18 | A | `apps/web/test/next-processing.test.ts`<br>cancels an explicit processor task and refuses its late model response | 沿用旧标签名称、默认全库/结果串联综合、提交即校验模型等设定；按当前 READY 筛选、快照和持久任务断言。 |
| 19 | A | `apps/web/test/next-processing.test.ts`<br>retains the synthesis question and policy but invalidates fixed inputs when selection changes | 沿用旧标签名称、默认全库/结果串联综合、提交即校验模型等设定；按当前 READY 筛选、快照和持久任务断言。 |
| 20 | A | `apps/web/test/next-processor-labels.test.ts`<br>keeps false distinct from unknown labels, restores associated papers, and exposes content search and stale-index recovery without hidden work | 旧处理器版本及 null 占位行，当前明确区分 false、有证据结果与原文未报告的空结果。 |
| 21 | A | `apps/web/test/next-query-cache.test.ts`<br>does not refetch material queries on Browser heartbeats or control changes, but invalidates publications and reconnects | 只断言旧 5 个缓存域，当前新增档案/标签/快照/元数据/文档域；改为精确核对 10 个域及去重。 |
| 22 | B | `apps/web/test/next-query-parity.test.ts`<br>reads, searches, follows references and downloads through the query-only page | 独立只读 Web 丢失 extraction-prepare 路由，准备请求返回 404。 |
| 23 | C | `apps/web/test/next-reader-boundaries.test.ts`<br>continues fixed Unicode Markdown without rebuilding stable blocks and recovers a failed continuation | 旧双 profile 给同一内联图片写入不同路径，compare 判为实质分歧并要求 unavailable 仲裁，建档未发布文档。 |
| 24 | A | `apps/web/test/next-remote-login.test.ts`<br>IP-address HTTP login and workspace logs in, preserves a link, operates without secure-context APIs, logs out and prevents a cached return | Web 夹具假设默认显示全部状态，实际默认仅 READY；明确选择全部状态后验证原旅程。 |
| 25 | A | `apps/web/test/next-shell.test.ts`<br>serves the React library under the production CSP with persisted preferences and independent selection | 筛选按钮已有计数，旧固定 accessible name 无法定位。 |
| 26 | A | `packages/contracts/test/document-contract.test.ts`<br>Document and Evidence boundary parsers rejects invalid IDs and parses both closed evidence variants | DocumentRef 测试混用旧 schema_version/parser provenance 与新校订表示。 |
| 27 | C | `apps/server/test/archive-mode-and-interfaces.test.ts`<br>uses the explicitly registered Markdown-only VLM source and exposes read-only CLI/MCP status | 仅 Markdown VLM 的旧 pipeline 对齐路径使建档失败；第二版单 profile 初稿替代这一路径。 |
| 28 | A | `apps/server/test/candidate-acceptance.test.ts`<br>publishes Browser bytes with 'no DOI' as unverified and preserves the label after restart | 缺失步骤仍断言 parser-result，当前是 raw-parse。 |
| 29 | A | `apps/server/test/candidate-acceptance.test.ts`<br>publishes Browser bytes with 'spaced DOI' as unverified and preserves the label after restart | 缺失步骤仍断言 parser-result，当前是 raw-parse。 |
| 30 | A | `apps/server/test/candidate-acceptance.test.ts`<br>publishes Browser bytes with 'different DOI and version' as unverified and preserves the label after restart | 缺失步骤仍断言 parser-result，当前是 raw-parse。 |
| 31 | A | `apps/server/test/candidate-acceptance.test.ts`<br>publishes Browser bytes with 'no extractable text' as unverified and preserves the label after restart | 缺失步骤仍断言 parser-result，当前是 raw-parse。 |
| 32 | A | `apps/server/test/cli-main.test.ts`<br>TypeScript CLI keeps backup create-if-absent and refuses unsafe target paths | 夹具调用退役迁移命令，或未完成正常 writer 初始化就比较 catalog 文件字节。 |
| 33 | A | `apps/server/test/cli-main.test.ts`<br>TypeScript CLI database completion report reports the five mutually exclusive partitions instead of an ad-hoc item list | 夹具调用退役迁移命令，或未完成正常 writer 初始化就比较 catalog 文件字节。 |
| 34 | A | `apps/server/test/cli-main.test.ts`<br>TypeScript CLI database completion report stops launching chunks on cancellation and distinguishes active targets from notStarted | 夹具调用退役迁移命令，或未完成正常 writer 初始化就比较 catalog 文件字节。 |
| 35 | C | `apps/server/test/document-read.test.ts`<br>bounded document and material reading pages dense segment evidence and reports only reliable resource context | 旧双 profile 对伪图片、注释中的引用重写后要求仲裁，阻止密集片段文档发布。 |
| 36 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 rejects valid and invalid create calls after shutdown without orphaned parsing | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 37 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 preserves each write admission failure and only reports actual cancellation as cancelled | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 38 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 returns distinct HTTP statuses for each write admission outcome | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 39 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 does not post a queued cancelled write and settles a posted real commit before shutdown | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 40 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 keeps a posted SQLite commit discoverable after the HTTP client disconnects | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 41 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 requires relation endpoints themselves to carry different input evidence | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 42 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 accepts an explicit missing input without a pin and rejects processed coverage for it | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 43 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 returns a historical receipt before inspecting newly damaged evidence | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 44 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 keeps pins until both the receipt and protection periods end | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 45 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 refuses full operation and receipt capacity without evicting valid history | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 46 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 checks named cross-input relations and accepts explicit zero-record or failed coverage | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 47 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 exposes explicit CSRF-protected maintenance delivery and receipt reading over loopback | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 48 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 rolls back receipt and the first material pin when a later pin fails | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 49 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 commits a whole batch with exact manifest pins, returns historical receipt after close and restart | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 50 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 rejects malformed payload, pointer, wrong evidence, coverage and duplicate batch without partial receipt | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 51 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 serializes cancellation before new submission, retains earlier receipts and cleans expired rows explicitly | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 52 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 settles a concurrent submit and cancel at one durable admission point | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 53 | A | `apps/server/test/extraction-delivery.test.ts`<br>extraction candidate delivery on v5 lets an ordinary external program read fixed PDFs and deliver distinct caller schemas without an internal parser or model | 外部交付测试沿用内部 READY 输入准备；改用调用方持有的固定证据 manifest，并修复交付误依赖内部准备的 B 类缺陷。 |
| 54 | A | `apps/server/test/extraction-document.test.ts`<br>keeps a real DocumentVersion and ready retrieval index through reopening and rebuild | 固定文档交付测试误用内部就绪准备；用外部固定 manifest 验证 pin、重开和证据。 |
| 55 | A | `apps/server/test/extraction-prepare.test.ts`<br>external extraction preparation binds two exact raw PDFs of one Literature on v1 without parsing or a model | 准备测试使用未建档材料；改为真实合成 READY 正文及未解析补充材料，保留完整性/取消断言。 |
| 56 | A | `apps/server/test/extraction-prepare.test.ts`<br>external extraction preparation reports an implicit segment gap, missing material and corrupt bytes distinctly | 准备测试使用未建档材料；改为真实合成 READY 正文及未解析补充材料，保留完整性/取消断言。 |
| 57 | A | `apps/server/test/extraction-prepare.test.ts`<br>external extraction preparation preserves document integrity errors and waits for in-flight preparation during reentrant close | 准备测试使用未建档材料；改为真实合成 READY 正文及未解析补充材料，保留完整性/取消断言。 |
| 58 | B | `apps/server/test/extraction-prepare.test.ts`<br>external extraction preparation serves the real preparation over loopback HTTP and rejects duplicate JSON keys | 独立只读 Web 丢失 extraction-prepare 路由，准备请求返回 404。 |
| 59 | B | `apps/server/test/extraction-prepare.test.ts`<br>external extraction preparation cancels an in-flight HTTP preparation when its client disconnects | 准备路由返回 404，无法进入读取与断线取消阶段。 |
| 60 | A | `apps/server/test/installed-public-journey.test.ts`<br>passes producer IDs, hashes and evidence through installed public SDK, CLI and HTTP entrypoints | 安装旅程仍断言多版本 schema-upgrade；改为安装包当前 schema 初始化、读取及拒绝旧命令。 |
| 61 | A | `apps/server/test/interface-maintenance-parity.test.ts`<br>machine interfaces over shared maintenance owners delivers the same evidence-linked extraction candidates through MCP and CLI with persistent receipts | MCP prepare_extraction 已要求 READY，原夹具仅有 PDF；改用真实建档夹具后核对 CLI/MCP 共享固定输入与持久回执。 |
| 62 | A | `apps/server/test/literature-identity-publication.test.ts`<br>enriches missing metadata fields independently of stored PDF material | 旧断言把存在 PDF 当作冻结元数据的理由；改为核对来源投影更新且 PDF 不变。 |
| 63 | A | `apps/server/test/literature-query-integrity.test.ts`<br>matches the existing query filter semantics and rejects incomplete discovery causes without conflating versions | 筛选使用退役 parser-result 缺失步骤。 |
| 64 | A | `apps/server/test/literature-query-scope.test.ts`<br>isolates discovery queries from unrelated invalid metadata in catalog v15 while validating selected versions | 仍断言开发中间版本 15，当前唯一 schema 为 11。 |
| 65 | A | `apps/server/test/mcp.test.ts`<br>formal MCP product adapter uses the real protocol client and production graph for parse, identity, analysis and durable result retrieval | 机器旅程使用已退役知识产物操作；迁至当前总结/快照综合，保留解析、身份与固定证据读取。 |
| 66 | A | `apps/server/test/processor-workbench.test.ts`<br>submits through the authenticated shared processor owner and reads results, evidence and exports without more model calls | 算子夹具未建档且版本仍为 1；改为真实 READY 夹具和版本 2。 |
| 67 | A | `apps/server/test/processor-workbench.test.ts`<br>enforces authentication, exact requests and scoped sizes while retaining drafts larger than ordinary HTTP commands | 算子夹具未建档且版本仍为 1；改为真实 READY 夹具和版本 2。 |
| 68 | B | `apps/server/test/processor-workflow.test.ts`<br>processor application acceptance composes labels and joint records into an evidence-linked synthesis; CLI and MCP read the same persisted content without models | 快照综合内部逐篇结果没有检索投影，索引整体过期。 |
| 69 | A | `apps/server/test/processor-workflow.test.ts`<br>processor application acceptance preserves partial attempts, permits later complete publication, and never treats search absence as a full-text negative | 旧标签空值行和覆盖断言与当前空结果/四态合同不符。 |
| 70 | C | `apps/server/test/proofread-service.test.ts`<br>durable proofreading and human locks requires existing raw inputs, publishes/reuses one immutable version, and reads it after reopening | 断言旧双侧 candidate 列表只有一个元素；新夹具产生两块，且 candidate/compare 结构本身属于待删除机制。 |
| 71 | A | `apps/server/test/publisher-governance.test.ts`<br>publisher name maintenance counts distinct articles and preserves source observations without default model calls | 共享 detail 夹具仍带已移除的 parser_result/content 字段，strict 合同拒绝。 |
| 72 | A | `apps/server/test/publisher-governance.test.ts`<br>publisher name maintenance paginates a bounded scope, reports continuation, and deduplicates unknown names before inference | 共享 detail 夹具仍带已移除的 parser_result/content 字段，strict 合同拒绝。 |
| 73 | A | `apps/server/test/publisher-governance.test.ts`<br>publisher name maintenance reports malformed model responses without publishing mappings: {"mappings":[{"name":"invented","provider_id":"elsevier"}]} | 共享 detail 夹具仍带已移除的 parser_result/content 字段，strict 合同拒绝。 |
| 74 | A | `apps/server/test/publisher-governance.test.ts`<br>publisher name maintenance reports malformed model responses without publishing mappings: {"mappings":[{"name":"novel press","provider_id":"invented"}]} | 共享 detail 夹具仍带已移除的 parser_result/content 字段，strict 合同拒绝。 |
| 75 | A | `apps/server/test/publisher-governance.test.ts`<br>publisher name maintenance reports malformed model responses without publishing mappings: {"mappings":[{"name":"novel press","provider_id":"elsevier","confidence":1}]} | 共享 detail 夹具仍带已移除的 parser_result/content 字段，strict 合同拒绝。 |
| 76 | A | `apps/server/test/publisher-governance.test.ts`<br>publisher name maintenance reports malformed model responses without publishing mappings: {"mappings":[]} | 共享 detail 夹具仍带已移除的 parser_result/content 字段，strict 合同拒绝。 |
| 77 | A | `apps/server/test/publisher-governance.test.ts`<br>publisher name maintenance reports malformed model responses without publishing mappings: {"mappings":[{"name":"novel press","provider_id":"elsevier"},{"name":"novel press","provider_id":"wiley"}]} | 共享 detail 夹具仍带已移除的 parser_result/content 字段，strict 合同拒绝。 |
| 78 | A | `apps/server/test/publisher-governance.test.ts`<br>publisher name maintenance reports malformed model responses without publishing mappings: {"mappings":[{"name":"novel press","provider_id":"elsevier"}],"url":"https://invented.test"} | 共享 detail 夹具仍带已移除的 parser_result/content 字段，strict 合同拒绝。 |
| 79 | A | `apps/server/test/publisher-governance.test.ts`<br>publisher name maintenance rejects suggestions contradicted by article sites and does not infer conflict names | 共享 detail 夹具仍带已移除的 parser_result/content 字段，strict 合同拒绝。 |
| 80 | A | `apps/server/test/publisher-governance.test.ts`<br>publisher name maintenance accepts only explicit selected suggestions, rejects stale reports, and reuses aliases on restart | 共享 detail 夹具仍带已移除的 parser_result/content 字段，strict 合同拒绝。 |
| 81 | A | `apps/server/test/publisher-governance.test.ts`<br>bounds AI batches, reports unavailable and failed models, and honors cancellation | 共享 detail 夹具仍带已移除的 parser_result/content 字段，strict 合同拒绝。 |
| 82 | A | `apps/server/test/publisher-governance.test.ts`<br>accepts a selected JSON report through CLI and preserves concurrent configuration edits | 共享 detail 夹具仍带已移除的 parser_result/content 字段，strict 合同拒绝。 |
| 83 | A | `apps/server/test/query-application.test.ts`<br>serves a real query-only Web request without changing the catalog | 仍要求退役 content:null 字段。 |
| 84 | A | `apps/server/test/retrieval-context.test.ts`<br>explicit retrieval projection and bounded Context batches metadata sources without losing source counts or searchable entries | 旧片段 ID/段落分隔/分组假设及重复索引计数；用当前文档定位与精确文本，独立计量显式索引调用，批量夹具去掉逐条写入开销。 |
| 85 | A | `apps/server/test/retrieval-context.test.ts`<br>explicit retrieval projection and bounded Context bounds replay bytes and counts a fragmented document only once | 旧片段 ID/段落分隔/分组假设及重复索引计数；用当前文档定位与精确文本，独立计量显式索引调用，批量夹具去掉逐条写入开销。 |
| 86 | A | `apps/server/test/retrieval-context.test.ts`<br>explicit retrieval projection and bounded Context keeps a pinned DocumentVersion and its evidence readable after reopening and index rebuild | 旧片段 ID/段落分隔/分组假设及重复索引计数；用当前文档定位与精确文本，独立计量显式索引调用，批量夹具去掉逐条写入开销。 |
| 87 | A | `apps/server/test/retrieval-context.test.ts`<br>explicit retrieval projection and bounded Context bounds a repeated long heading without replacing the previous generation | 旧片段 ID/段落分隔/分组假设及重复索引计数；用当前文档定位与精确文本，独立计量显式索引调用，批量夹具去掉逐条写入开销。 |
| 88 | A | `apps/server/test/retrieval-context.test.ts`<br>explicit retrieval projection and bounded Context indexes exact published versions and returns verified Unicode text with resolvable evidence | 旧片段 ID/段落分隔/分组假设及重复索引计数；用当前文档定位与精确文本，独立计量显式索引调用，批量夹具去掉逐条写入开销。 |
| 89 | A | `apps/server/test/retrieval-context.test.ts`<br>explicit retrieval projection and bounded Context reports evidence-limit for a matching unit with more than 32 source segments | 旧片段 ID/段落分隔/分组假设及重复索引计数；用当前文档定位与精确文本，独立计量显式索引调用，批量夹具去掉逐条写入开销。 |
| 90 | A | `apps/server/test/retrieval-context.test.ts`<br>explicit retrieval projection and bounded Context marks candidate-limit before pagination when more than 4097 matching rows exist | 旧片段 ID/段落分隔/分组假设及重复索引计数；用当前文档定位与精确文本，独立计量显式索引调用，批量夹具去掉逐条写入开销。 |

## 计划勾选核对

| 块 | 核对前 → 后 | 修改与依据 |
| --- | --- | --- |
| 05 | 7/9 → 6/9 | 取消 5.8：第二版矫正记录 API 未实现；当前仍为旧双侧比较 |
| 06 | 6/10 → 9/10 | 补勾 6.7/6.8/6.10：保守引用匹配、固定注释支持、CLI/MCP 有代码和直接测试；6.9 未完成 |
| 07 | 7/9 → 6/9 | 取消 7.3/7.9 的一次性转换验收；补勾 7.4 字段来源、冲突、锁定 |
| 08 | 10/10 → 9/10 | 取消 8.3：标签执行存在，但截断与输入覆盖记录没有完成 |
| 09 | 6/10 → 5/10 | 取消 9.9：仍统计旧比较/仲裁，未实现疑点处置/存疑统计 |
| 11 | 5/9 → 4/9 | 取消 11.9：已有 Web 旅程不能证明第二版单 profile、存疑与用时核对 |

其它块沿用当前第二版任务：01 8/8、02 1/5、03 7/11、04 0/12、10 11/12、12 0/8。全计划当前 **66/113 已勾选，47 项未勾选**；这不是功能完整或发布验收结论。02 的真实统计来自既有工作，本轮没有再次读取真实库。

## C 类保留清单（本轮不修行为、不删除）

1. `apps/server/test/document-read.test.ts` — `bounded document and material reading > pages dense segment evidence and reports only reliable resource context`：旧 profile 路径重写触发 `arbitration-unavailable`，文档无法发布。
2. `apps/web/test/next-reader-boundaries.test.ts` — `continues fixed Unicode Markdown without rebuilding stable blocks and recovers a failed continuation`：内联图像在 pipeline 与 VLM 中的引用路径不同，被旧 compare 判为实质分歧；已从合成建档状态确认 `proofread-failed / arbitration-unavailable`。
3. `apps/server/test/archive-mode-and-interfaces.test.ts` — `uses the explicitly registered Markdown-only VLM source and exposes read-only CLI/MCP status`：旧双侧/Markdown 对齐路径阻止就绪，待第二版初稿流程取代。
4. `apps/server/test/proofread-service.test.ts` — `durable proofreading and human locks > requires existing raw inputs, publishes/reuses one immutable version, and reads it after reopening`：旧 candidate/compare 检查断言单块，当前合成原文得到两块；该双侧候选接口本身列入第二版统一退役。本轮未为它恢复旧夹具或调整断言。

C 类后续需结合新的单 profile、疑点处置、存疑与人工锁定合同重新安排有效覆盖；保留模块的阅读/证据/人工修改验收不能因删除旧路径而丢失。本轮没有执行删除。

## 结束 Full 与后续定向验证

结束 Full 的六项失败包含上述四项 C，以及下列两项超时，后者不能归入 C：

- `apps/server/test/processor-snapshot-synthesis.test.ts` — `runs persistent DSH summaries as reusable maps, then synthesizes only their records`：5,000 ms 超时；补充基线曾以 4,235 ms 通过，结束 Full 与首次隔离复跑均超时；最终定位为集成测试将档案准备和完整算子旅程混在同一默认超时内，后续按下述夹具职责拆分验证。
- `apps/server/test/processor-workflow.test.ts` — `processor application acceptance > reuses exactly overlapping unchanged documents for 100→120, 80-overlap and five revised inputs`：600,000 ms 超时；基线 500,338 ms，已记录 200 篇档案准备与批处理各阶段开销，后续定向结果见下。保留 200 篇、各次复用比例、五篇修订及不可变集合断言。

两次 Full 配额已用完，不再运行第三次 Full。后续结果单列，不能改写结束 Full 的六项失败为四项。结束 Full 期间 754 个源码/配置文件保持不变（清单摘要 `d0005e1cfbe99684c2eed1b5ba481609ad4f908aad798341ce4d383f6f1c8043`），日志为 `full-end.log`；其后改动及定向验证记录如下。

已完成的收尾核对：

- `pnpm build` 单独运行成功，补上 Full 因测试失败而未执行的构建步骤（`build-final.log`）；没有以此宣称 Full 通过。
- 源码 README 共 76 份，指向源码树外的链接为 0；不读取或修改用户配置/真实 catalog。
- 快照综合夹具改为真实 `processorFixture` 档案输入，准备放入独立的 5 秒 beforeAll，清理有独立的 5 秒 afterAll；业务测试仍保留 5 秒限制，全部原断言保留。定向结果 `snapshot-final.log/json`：1 项通过，业务阶段 2,266 ms，含钩子 4,373 ms。拆分是为了区分档案准备和被测算子旅程，**并非证明原来整段操作在所有负载下都能低于 5 秒**。
- 200 篇夹具只将单篇档案准备合并到一次真实、可重入的 catalog 写锁内；正式批处理的写入准入、证据验证与模型调用断言不变。定向复验通过，600 秒限制没有增加（`bulk-final.log/json`，1 项通过，421,643 ms）。名称过滤留下的另外 5 项未执行，不是新加 skip。分段：200 篇准备 203,632 ms；首轮 100 篇结束于 267,757 ms；扩大到 120 篇结束于 311,502 ms；80 篇重叠轮结束于 359,635 ms；最终 75 复用/45 新算及历史集合不变断言全部通过。临时分段日志已从测试源码移除，保存于证据日志。
- 临时性能诊断代码已撤除，生产源码保持与结束 Full 的清单一致；只有上述两份测试与计划记录追加了改动。未引入新的长期验证缓存或放宽数据库完整性检查。

本轮收敛结论：基线中的 86 项 A/B 失败已通过结束 Full；结束 Full 新出现的两项超时已分别用定向用例验证解决。剩余四项 C 明确保留，不改行为、不删测试。**结束 Full 的实际结果仍为六项失败**，没有另跑一轮 Full 来取得“只剩 C”的新全量结果，因此不能宣称 Full 或第二版计划已完成。测试/源码严格类型检查、独立 build 通过；收尾两份测试的 Prettier 与 ESLint 检查也已通过（`format-after-full.log`、`lint-after-full.log`）。40 项既有条件跳过未增加。

本轮没有新增需要 Owner 决定的事项。功能开发仍暂停；下一阶段才能按第二版计划统一替代 C 类逻辑并保留其阅读、证据、锁定等有效覆盖。真实 MinerU/模型调用、真实库转换与切换继续需要各自的明确授权，本轮没有执行这些操作或 Git 提交。
