# 02 · 初稿构建器与核对依据

类型：计划（结果块）
负责：从原始解析与 PDF 文字层确定性地得到初稿的正文、结构、片段核对依据与差异记录
状态：Pending

## Outcome

- 给定一份原始解析和该 PDF 的页面检查结果，一个纯函数返回初稿：
  - Markdown 正文、结构（outline 的 `role` 为 null）、资源闭包；
  - 每个片段的 `basis`：`text-layer-match`、`text-layer-differs`、`no-text-layer`；
  - 初稿内容 `draft-content-v1`（含差异记录 `draft-differences-v1`）与三个计数；
  - `page_layer_sha256`、`draft_method_sha256` 与 representation hash。
- 相同输入得到相同字节。
- 构建器不调用模型、不联网、不写库。
- 逐页校订请求的行为与字节不变。

规格：[04 §8.2](../../architecture/technical/04-document-evidence.md#82-初稿的形成)、[§8.3](../../architecture/technical/04-document-evidence.md#83-初稿的结构与核对依据)。下文只指出小节，规则以规格为准。

## 进入条件

- 01 已完成（规格已补齐）。
- G1：Owner 同意开工并指定实施者。

## 责任边界

- 负责：后端实施者。
- 拥有：`packages/contracts` 中两级文本的类型与解析；初稿构建模块（建议放在 `apps/server/src/document/`，与校订稿 builder 并列）；从现有代码抽出的共用函数。
- 触达（只抽取，不改行为）：
  - `apps/server/src/archive/text-source.ts`（来源准备）；
  - `apps/server/src/archive/preprocess.ts`（页眉页脚删除）；
  - `apps/server/src/archive/paragraph-breaks.ts`（断段判定）；
  - `apps/server/src/archive/source-layout.ts`（标题层级）；
  - `apps/server/src/archive/render.ts`（公式、图片、表格的写法）；
  - `apps/server/src/proofread/page-review.ts`（叶块对齐）。
- 不改：整理请求、逐页校订请求与防护、`PAGE_REVIEW_METHOD`、`page_input_sha256` 的组成、`source-order-leaves-v4` 的输出字节、数据库与对外接口。

## Tasks

- [ ] **2.1 合同类型**（`packages/contracts`）
  - `TextLevel`；`DraftDocumentRef`（`schema_version: 3`，builder `draft-leaves-v1`）与 `DocumentRef` 并集；`DraftDifference`；`DraftOutcome` 与 `DraftFailureCode`；初稿内容 `draft-content-v1` 的类型与解析函数。字段见 04 §8.2“回执”“失败”与 §8.3“DocumentRef”“初稿内容”“差异记录”。
  - `DocumentSegmentLocation.basis` 扩为六种取值，解析时按所在版本核对取值集合（04 §8.3“核对依据的取值”）。校订稿 DocumentRef（`schema_version: 2`）的解析与字节不变。
  - 现有只接受 `schema_version: 2` 的解析函数遇到初稿照旧拒绝（04 §8.3）。
  - 输出：导出的类型与解析函数；`packages/contracts/test/` 中的合同测试。
- [ ] **2.2 来源准备**
  - 直接复用 `prepareArrangementSource` 构造并核验来源区块（含可选的 `pdf_geometry`），不复制它的逻辑（04 §8.2“输入”）。
  - 构建器接收调用方选好的原始解析；选择规则（哪次解析形成初稿）由 04 块按 04 §8.2“输入”实现。
  - 在初稿一侧把 `input-missing` 转换为 `needs-parse`，其余失败按 04 §8.2“失败”的表映射。`archive/` 里的错误码不改。
  - 阅读顺序纠正使用与建档相同的开关（当前默认关闭）；开关值进入方法 hash（04 §8.2“版本”）。
- [ ] **2.3 规则预处理（没有章节角色）**
  - 页眉页脚：原样调用 `programChromeDrops`。
  - 断段：把 `paragraphBreakEvidence` 中与角色无关的部分（版面边界判定与“直接合并”的条件）抽成接受“正文判定”参数的函数。建档一侧传入现有的角色判定，结果逐字节不变；初稿一侧传入 04 §8.2“没有章节角色时的判定”。
  - 合并的范围与接缝、不做的整理、叶块 ID 的生成，见 04 §8.2“规则”第 2、4 条。
  - 删除与合并记入初稿内容的 `operations`（04 §8.3“初稿内容”）。
- [ ] **2.4 叶块与文字层对比**（04 §8.3“对比规则（`draft-compare-v1`）”）
  - 从 `pageReviewPlan` 抽出对齐与差异提取这一步（`matchingBlocks`、`opcodes`），放进共用函数。
  - 逐页校订一侧保持现在的行为，见 04 §8.3 对比规则之后的一段。用现有 `page-review.test.ts` 与 `page-proofread.test.ts` 证明。
  - 初稿一侧按规则第 1–7 步实现。实现时要注意的现有代码：
    - 现有 `pageReviewPlan` 用 `reviewTokens(leaf.original_text)` 取词，表格的 HTML 标记会成为词；初稿按第 2 步先换掉标签、解码字符引用；
    - 现有函数在页面不可信时返回空的差异列表；初稿按第 7 步不看整页可信度；
    - “另一页”判定复用 6.2 页归属的 `textLayerPage`（第 5 步）。
  - 按 04 §8.3“片段与叶块”把叶块取值合成片段取值，差异按叶块保存。
  - 输出：每个叶块的取值与差异、每个片段的取值，以及 04 §8.3“差异记录”末条的三个计数。
- [ ] **2.5 渲染**
  - builder `draft-leaves-v1`，按 04 §8.2“渲染”：片段的组成与 `continuation_regions`、标题片段与章节、层级、不写 `layout`、资源闭包。
  - 公式、图片、表格沿用 `source-order-leaves-v4` 的写法：从 `render.ts` 抽出逐叶块的写法函数，v4 的字节不变（`archive-render-v2.test.ts` 不改断言）。
  - 层级规则与校订稿不同（题名参加样式统计、不使用层级 1）：从 `source-layout.ts` 的 `headingLevels` 抽出样式统计部分，建档一侧输出不变。
  - 上限：正文 8 MiB、结构 16 MiB（`document/limits.ts`），初稿内容 16 MiB；超过时为 `draft-too-large`。
  - 长循环让出事件循环，响应取消（`cancelled`）。
- [ ] **2.6 初稿内容与重建**
  - 形成初稿内容 `draft-content-v1`（04 §8.3“初稿内容”）。
  - 计算 `page_layer_sha256`、`draft_method_sha256`（04 §8.2“版本”）与 representation hash（04 §8.3“DocumentRef”）。
  - 提供“从初稿内容重建 Markdown 与结构”的函数，供 03 的可读性校验调用。重建不打开 PDF 页面工具、不重算对比、不读原始解析的区块文件（04 §8.3 verified reader 一段）。

## 集成与影响

- 本块不接入生产对象图，不改变任何对外行为。
- 抽出的共用函数被建档与逐页校订调用，二者的输出必须不变。

## 验证

新增 `apps/server/test/draft-builder.test.ts`（合成 PDF 与合成原始解析，造法沿用 `archive-text-fixture.ts` 与 `proofread-fixture.ts`）。必须证明：

- 04 §8.9 中属于构建器的各条：三种核对依据、片段取值、对比、断段与层级、重复构建、失败码。具体包括：
- 文字一致的页：片段全为 `text-layer-match`，差异为零。
- 故意改错一个词：只有该片段为 `text-layer-differs`，差异记录写出解析文字与文字层文字。
- 表格：带 HTML 标记与字符引用、文字与文字层一致的表格为 `text-layer-match`。测试要包含“不去标记就会判为有差异”的对照。
- 只有 LaTeX 的公式去掉记号后没有词：`no-text-layer`；对上 30% 以上但缺词：`text-layer-differs`。
- 页面整体不可信（大部分叶块对不上）时，对得上的叶块仍为 `text-layer-match`。
- 扫描页（`image-only`）与空白页：`no-text-layer`；纯图片叶块：`no-text-layer`；图片里的文字（本页与他页都没有）：`no-text-layer`。
- 放错页的片段（词全部出现在另一页）：`text-layer-differs`，差异为 `elsewhere`。
- 一个合并片段里分别有一致、无文字层、有差异的叶块：片段取 `text-layer-differs`，差异是并集；跨页片段的每个叶块只与本页比。
- 页眉页脚被删除并记录规则；明确的跨页断段被合并；需要模型裁决的断段保持分开；书目行与版权句保留。
- 没有章节角色：outline 的 `role` 为 null；首页单位行（`text` 类型）阻断跳过；论文题名参加样式统计；没有编号和可靠样式时层级为 `title_level + 1`。
- 相同输入两次构建，字节、representation hash、方法 hash 都相同；改一个方法组成（如对比规则版本），方法 hash 改变。
- 超过大小上限为 `draft-too-large`；来源篡改为 `source-integrity`；取消为 `cancelled`。
- 从初稿内容重建得到相同的 Markdown 与结构；改动初稿内容一个字节即核验失败。
- 构建过程中模型适配器与网络都没有被调用（用会抛错的假对象）。
- Markdown-only 输入：页归属唯一时形成初稿；不唯一时返回 `needs-parse`。

回归（只跑这些文件，断言不改）：`page-review.test.ts`、`page-proofread.test.ts`、`archive-rule-layout.test.ts`、`archive-arrangement.test.ts`、`archive-render-v2.test.ts`。

合同：扩展 `packages/contracts/test/document-contract.test.ts`，覆盖初稿 DocumentRef 与差异记录的接受与拒绝。

## 证据

提交号；定向测试命令与结果；回归文件的通过记录；一份合成样例的初稿 Markdown 与片段取值（放 `sandbox/reports/`，计划只记位置）。

## 退出条件

构建器、共用对比函数与合同类型合入；逐页校订与建档的回归测试不改断言而通过。03 与 04 可以调用构建器。

## 恢复与交接

- 中断时，以测试为准判断哪些 Task 完成，不从记忆推断。
- 抽取共用函数导致回归测试失败时，先撤回该次抽取，保留初稿一侧的独立实现，记录在本块，再找原因。
- 规格不足以决定时停下，写回执交总设计师补规格，不自行决定。
