# 05 校订稿文档表示、部分与页码区域证据

状态：In progress（6/9；发布、默认版本、读取、页码证据与检索已接入；5.7、5.8、5.9 尚未达到第二版要求）。执行者：worker。

> ADR 0037 第二版（2026-10-20）：校订改为“部署 profile 初稿 → 文字层找疑点 → DSH 看原图矫正 → 存疑不阻断就绪”。本块受影响的 Task 已取消勾选并写明调整内容；其余已完成项保留。

## Outcome

1. 校订版本以文档表示 `proofread-blocks-v1` 发布，成为该部分的默认文档版本。每个片段对应一个校订区块。
2. 证据可以同时定位到片段和 PDF 的页码区域（`page-region-v1`）。`resolveEvidence` 会返回文字、页码、区域和来源标注。
3. 一篇文献的各个部分（正文、补充材料）可以按部分列出和读取。
4. 检索索引覆盖校订稿的片段。
5. 已有的 `markdown-utf8-v1` 文档版本仍然可以按精确引用读取，直到 12 退役。

## 进入条件

04 的 4.1、4.7、4.8 已完成。

## 责任边界

本块负责：
- `apps/server/src/document/`；
- contracts 中的文档与证据类型；
- 文档 schema 迁移；
- `storage/sqlite/retrieval-engine.ts` 的索引来源。

本块不负责：章节角色。章节角色由 06 负责，但结构 schema 要在本块预留角色字段。

## 现状

- `document/builder.ts` 定义了 `DOCUMENT_BUILDER_VERSION = "markdown-utf8-v1"`，从 `ParserResult` 构建 heading 和 text 片段。
- 证据有两个分支：
  - `material-file-v1`：文件级；
  - `utf8-segment-v1`：片段级。
- 页码和 bbox 尚未实现。
- `document_id` 由 Literature ID 和 Asset ID 派生。由于补充材料本身就是独立资产（`AssetRole` 中的 `supplementary-pdf`），“部分”可以直接对应到“资产的文档”。

## Tasks

- [x] **5.1 结构 schema v2**

  在 contracts 中把 `DocumentStructureV1` 扩展为 `DocumentStructureV2`：

  | 对象 | 新增字段 |
  | --- | --- |
  | 片段 | `kind` 扩展为 `heading`、`text`、`table`、`caption`、`equation`、`image`、`reference-item`、`list`、`footnote`；`block_id`；`page`；`region`（或 `null`）；`locate`；`source` |
  | 章节 | 标题层级与片段范围；角色与来源由独立结构注释（06）提供，读取响应合并展示，不写入 Document 表示 hash |

  v1 结构保持可读。v2 只能由新的 builder 产生。

- [x] **5.2 builder `proofread-blocks-v1`**

  1. 输入是一个 `complete` 状态的校订版本。
  2. 使用 4.7 的 Markdown 字节和区块字节区间生成片段。章节由标题区块构成，构成方式与现有 ATX 标题栈的规则一致。
  3. 表示 hash 覆盖：校订版本的 `content_sha256`、builder 版本、locator scheme、Markdown、结构和资源闭包。
  4. 发布时复核 PDF、Markdown 和资源的 hash，沿用现有的上限，例如 Markdown 8 MiB、片段 100,000 个。
  5. `failed` 状态的校订版本不能构建文档。

- [x] **5.3 locator `page-region-v1`**

  - 在 contracts 的 `DocumentLocator` 判别联合中新增：`{scheme: "page-region-v1", segment_id, page, region | null}`。
  - 证据的 `document` 分支增加可选的区域信息。片段级证据仍以 `utf8-segment-v1` 为主；对来自 `proofread-blocks-v1` 版本的片段，签发证据时同时附带页码和区域。
  - `resolveEvidence` 的校验顺序：
    1. 固定版本；
    2. 片段 hash；
    3. 区块的页码和区域与结构一致。

    任何一步不一致，都返回 `document-integrity` 或 `document-unsupported`，不做模糊匹配。
  - 页码在接口中按 1 起计显示，在存储中按 0 起计。这个约定写入 contracts 的注释和测试。

- [x] **5.4 默认版本与部分**

  - 校订版本构建成功后，把该资产文档的默认版本切换为 `proofread-blocks-v1` 版本，并写入 `document_defaults` 的 revision。旧版本按精确引用仍然可读。
  - 新增按文献列出部分的读取接口。

    返回的每个部分包含：
    - 资产 ID 与 hash；
    - 角色：`main`（主 PDF）或 `supplementary`（补充材料 PDF）；
    - 顺序：先正文，补充材料按接纳时间排序；
    - 默认文档版本；
    - 校订状态。
  - 没有补充材料的文献只返回正文部分。

- [x] **5.5 读取接口扩展**

  - `segments` 和 `slice` 的响应增加以下字段：页码、区域、文字来源、核对依据、存疑说明、片段类型。
  - `outline` 的响应增加章节角色（可能为空，等 06 填写后才有值）。
  - 新增按部分和章节角色过滤片段的读取参数。参数格式在本块定义，角色过滤要等 06 完成后才能生效。
  - 保持现有的分页上限、继续位置和预算约束。

- [x] **5.6 检索索引**

  - 检索引擎的材料索引改为以默认文档版本为来源。来源是 `proofread-blocks-v1` 时，按片段建立索引，并携带页码。
  - 默认版本切换时，触发该文档的索引重建。沿用现有的 generation 机制，查询不会触发加工。
  - 检索结果携带片段的页码，供 Web 跳转使用。

- [x] **5.7 校订记录读取**（供阅读器使用；第二版改写）

  - 新增只读接口：给定片段，返回初稿原文、相关疑点及处置、矫正编辑记录、存疑说明，以及所在页的页面图像引用（04 的页面工具）。
  - 删除第一版“两侧原始区块、比较分类、仲裁摘要”的读取接口。
  - 这个接口只服务于人工查看和追查，不进入算子的读取上下文；片段自身的核对依据与存疑说明照常提供（不变量 2）。

- [x] **5.9 第二版合同适配**

  - builder 改为消费 04 第二版的 `ProofreadVersion`；每个片段携带 `text_source`、`basis` 与 `uncertainty`。
  - 删除对第一版双侧字段（`raw_refs.pipeline/vlm`、`arbitration_ref`、旧来源值）的读取与测试。
  - 已发布的第一版校订文档只存在于合成测试库中，不做兼容读取。

- [x] **5.8 CLI/MCP**

  - `document parts`：列出一篇文献的各个部分。
  - `document segments`、`document slice`：输出新增字段。
  - `document corrections <segment>`：对应 5.7。
  - `evidence resolve`：输出页码和区域。

## 集成与影响

- 新解析的文献，阅读器默认显示校订稿。
- 旧的 `markdown-utf8-v1` 版本在 12 之前仍然存在。
- 检索结果从此可以携带页码。

## 验证

- 定向测试：
  - v2 结构的解析与拒绝，覆盖重叠区间、越界页码、非法区域；
  - builder 的确定性：同样输入得到同样 hash；
  - `page-region-v1` 证据往返：签发、解析、篡改检测；
  - 默认版本切换与旧版本按精确引用读取；
  - 检索索引的重建与页码；
  - 部分列表，包括有补充材料和没有补充材料两种情况。
- 回归：现有的 document、retrieval 和 reader 相关测试全部通过。
- 运行 `pnpm quick` 和相关 Vitest 测试。

## 退出条件

- 校订稿可以作为文档读取，片段带页码和区域，证据可以往返校验；
- 可以按部分读取；
- 检索索引已覆盖校订稿。

## 恢复与交接

- 结构 v2 与旧读取代码不兼容时，所有读取入口先统一走 v1/v2 判别，不允许分叉成两套读取实现。
- 交给 06：
  - v2 结构中的章节角色字段；
  - 写入角色的接口。

  角色版本语义已经由 ADR 0037 和 06 确定：生成独立结构注释版本，不能因角色修改改变文档表示 hash 或既有证据定位。
- 交给 10：按部分和角色过滤片段的读取接口。
- 交给 11：页码、区域、核对依据、存疑说明和校订记录读取接口。

[计划入口](README.md)

## 先行实现记录

- `packages/contracts/src/document-structure-v2.ts`：页码、区域、续接区域、区块与片段 ID、来源、UTF-8 范围、章节嵌套与重叠校验。存储页码为 0 起计。role/role_source 固定为 null，按 ADR 0037 保持结构注释独立，不在发布后改写文档 hash。
- `document/proofread-builder.ts`：只接纳 complete 校订稿，复核 blocks/Markdown 的 hash；每个区块对应一个片段，采用标题栈生成章节。拒绝 failed 或篡改字节。
- 直接测试：`pnpm exec vitest run apps/server/test/proofread-document-builder.test.ts`，3 项通过；日志 `/tmp/sciretriever-archive-implementation-yzz1ycub/document-v2-tests-2.log`。首次运行未构建新增 contracts export，失败已保留；构建 contracts 后通过。
- 尚未完成：DocumentRef/存储绑定、默认版本 CAS、读取器 v2 接入、页码区域证据签发与解析、按部分读取及检索。因此 05 的端到端退出条件尚不成立，不将纯 builder 写为已发布阅读能力。

## v13 接入实施记录

执行 patch：HEAD `2ccf2c2` + 当前未提交工作树；保留原有文档/归档改动，不提交 Git，不使用真实服务或数据。

- 5.1/5.2：DocumentRef schema 2 直接引用 proofread ID/content hash；builder 与原始 PDF/校订文件/资源闭包验证，complete 之外不发布。固定版本与旧版本共用文档表和读取入口，不伪造 ParserResult。
- 5.3：片段证据携带可校验的页码区域；resolve 复核固定版本、文字 hash 和定位，返回来源。公开页码 1 起计，存储 0 起计。
- 5.4：v12→v13 显式迁移并保留固定历史版本；部分列表分页，正文/补充材料独立默认版本；CAS 冲突不覆盖默认选择。补充材料按 literature_assets 的接纳行序排列，不误用来源 observation 的时间；列表先正文，再补充材料。
- 5.5：segments/slice/evidence 已携带位置/来源，outline 通过 06 的独立注释 owner 返回角色；segments 支持 roles 和固定 annotation_id，角色变化不改变全文/证据 hash。
- 5.6：校订结构每块形成检索单元，证据携带页码；默认版本切换会显式刷新 generation，失败独立报告。当前沿用整个 generation 重建，尚无单文档增量重建，不以此承诺大库写入性能。
- 5.7/5.8：CLI/MCP/HTTP 接入 parts/compare 和显式 publish-proofread。对照按固定版本以有界 JSON UTF-8 字节串续读，无丢失截断；未暴露给算子阅读工具。
- 已跑 `document13-tests-2.log`：4 文件，18 通过/1 失败；失败为新增测试调用了不存在的 app.retrievalIndex，已改用正式 maintenance 入口。`document13-tests-3.log`：4 文件，27 通过/1 失败；失败为 catalog 初始化测试仍断言 v12 fingerprint，已更新为 v13。不会抹去首次失败。后续 `document13-tests-4.log` 已通过：7 文件 / 68 项。
- 最终 Quick/Full 尚未通过，以上实现不等同于全块或全计划完成。源码与相关回归仍需最终复核。

### Full 后的语义复核与修复

- 已修复读取闭包：普通固定文档读取只加载校订 manifest/blocks，不再重复读取候选和图片；这些字节已计入共享验证预算。测试覆盖准确累计与预算拒绝。
- 已在发布前检查已有的 16 MiB 结构上限；70,000 个合成区块验证拒绝超限。
- 相同校订内容即使方法版本变化，仍复用同一个全文版本；既有来源绑定不覆盖。`proofread-structure-final-direct.log`：3 文件 / 33 项通过。
- 历史 Full `full-document13-final.log`：298 文件中 297 通过、1 失败；2,170 项中 2,169 通过、1 失败，零跳过。唯一失败为 Browser `/gate` 的首次就绪等待使用默认 1 秒；已改为显式 5 秒，保留所有归属/唯一执行断言。整份 Browser 文件 12 项复验通过。该 Full 未进入最终 build，不能宣称全量通过。
- 06 已接入注释后，`structure-tests-4.log`：3 文件 / 31 项通过（含 v1–v14 显式升级、校订全文和注释/角色读取）。本轮 Full 为 `full-structure-v14.log`，结果待写入。

### v14 已通过的完整回归（后续改动另行验证）

`full-structure-v14-reviewed.log` 退出 0：**301 文件 / 2,204 项通过，零跳过**；Quick、全部 Vitest、最终构建通过，Vitest 耗时 1,008.73 秒。`structure-source-manifest-reviewed.json` 的 890 个活动代码/配置文件复核无变化。未调用真实 Provider/MinerU/模型或真实库，未改变锁文件、定稿原型，未提交 Git。随后继续图表邻接修复及旧补全链清理；这份 Full 仅证明该快照，不等于全计划完成，也不能当作后续源码的 Full。

### Task 台账复核（2026-10-20）

5.1–5.6、5.8 的目标代码、直接回归和 v14 Full 证据已形成闭环，上方早期“尚未完成”条目是历史进展，现据实际实现勾选。公开读取并不会隐式解析/建档；角色归独立注释；固定证据不跟随 current；所有类型的页码采用既定 0/1 起计约定。当前源码在追加解析退役后另跑 Full，不将上一快照的成功冒充本轮结果。

5.7 尚未勾选：固定两侧候选、分类、来源和 arbitration_ref 已提供，完整仲裁摘要与截图引用仍依赖 4.6；当前未配置仲裁，不伪造这些内容。对照内部仍会读取整个候选集合，Web 接入前还需关注大候选的内存/响应预算。5.6 的全 generation 刷新可用，但批量建档合并刷新需要 09 继续处理。

## 本轮测试收敛台账核对（2026-10-20）

依据 Owner 本轮仅修 A/B、保留 C 的授权核对；不把第一版实现或历史 Full 当成第二版验收。本轮证据目录：`/tmp/sciretriever-test-convergence-ndZSeC`。

- 5.8：取消勾选。原有 CLI/MCP 的 parts、segments、evidence 入口存在，但本 Task 还包含 5.7 的校订记录读取；该入口仍是双候选 compare，第二版记录读取未实现，因此不能整项勾选。

### 本轮结束 Full 证据

结束 Full 中固定文档/证据的保留用例已运行；密集片段读取仍被旧双 profile 的仲裁要求阻断，归入 C，不勾选第二版校订记录任务。 完整命令、失败分类和收尾后定向结果见[测试收敛记录](test-convergence.md)。本块勾选数不因旧流程测试通过而增加。

## 第二版实施证据（2026-10-21）

基线 `2ccf2c2` 加未提交工作区；本轮 patch 未提交。证据目录 `/tmp/sciretriever-proofread-v2-zgeot7n6/`。builder 和公开阅读位置都携带 parser/rule/agent/manual、basis 与 uncertainty；公开页码统一转为 1 起计。document corrections 取代 compare，固定版本 JSON 续读返回初稿、最终区块、疑点、编辑与原图页引用；不加入算子工具。proofread-document-builder 原 4 项通过，publication 7 项经新合同适配均已有通过证据（manual-publication.log + value-document-retest.log），最后的公共解析器旧来源枚举已修正。

所有 Vitest 均使用 `VITEST_MAX_FORKS=3 VITEST_MIN_FORKS=1` 与显式 1–3 workers。这里只记录受影响的定向验证；筛选未执行的用例不计为通过。本轮未运行 Full、未新增依赖或数据库版本、未转换本机库。

### 第二版机器接口核销（2026-10-21）

`document-cli-mcp-verified.log`：1 个选定用例通过，明确核对同一固定片段的 CLI `document corrections` 与 MCP `document_read/corrections` 回执一致，包含单初稿、basis 和原图引用；读取未调用模型，也未重新解析。已有 `value-document-retest.log` 与 `verification-boundaries.log` 覆盖固定文档/证据与校订 owner 的三端接线，5.8 据此核销。本次测试只修正新断言遗漏 CLI 协议 envelope 的问题，没有改生产合同。

### 合成读取夹具的第二版边界（2026-10-21）

原先的占位 PDF + 固定文字 parser fixture 没有提供页面工具，新校订链会误尝试使用真实浏览器 renderer。`parser-application-fixture` 现在显式提供匹配的合成文字层，只服务读取/交付/检索测试；专用校订测试仍使用独立的冲突文字层与图像 fake，不以这个夹具证明校订质量。`parser-fixture-second-edition.log`：正文索引 Web、固定文档提取与重开两项通过。
