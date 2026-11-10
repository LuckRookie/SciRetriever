# 02 · 初稿构建器与核对依据

类型：计划（结果块）
负责：从原始解析与 PDF 文字层确定性地得到初稿的正文、结构、片段核对依据与差异记录
状态：Pending

## Outcome

- 给定一份原始解析和该 PDF 的页面检查结果，一个纯函数返回初稿：
  - Markdown 正文、结构（outline 的 `role` 为 null）、资源闭包；
  - 每个片段的 `basis`：`text-layer-match`、`text-layer-differs`、`no-text-layer`；
  - 差异记录与疑点计数；
  - 初稿方法 hash。
- 相同输入得到相同字节。
- 构建器不调用模型、不联网、不写库。
- 逐页校订请求的行为与字节不变。

规格：[04 §8.2](../../architecture/technical/04-document-evidence.md#82-初稿的形成)、[§8.3](../../architecture/technical/04-document-evidence.md#83-初稿的结构与核对依据)，以及 01 的 1.1–1.5 写入的规则。

## 进入条件

- 01 的 1.1–1.5 已写进规格。
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
  - `TextLevel = "draft" | "proofread"`；初稿的三种 `basis`；片段 `basis` 的并集类型。
  - 初稿 DocumentRef 的类型与解析函数（按 1.4）；差异记录的类型与解析函数（按 1.5）。
  - 现有校订稿的解析函数不变：它们仍只接受 `text-layer`、`image-only`、`manual`。
  - 输出：导出的类型与解析函数；`packages/contracts/test/` 中的合同测试。
- [ ] **2.2 来源准备**
  - 直接复用 `prepareArrangementSource` 校验原始解析与资源闭包，生成来源区块，不复制它的逻辑。
  - 输入选择按 04 §8.2：部署 profile 的当前原始解析，没有时用 `vlm-engine-markdown-only`。另一种 profile 不形成初稿。
  - 在初稿一侧把 `input-missing`（Markdown 无法唯一确定页归属）转换为 `needs-parse`。`archive/` 里的错误码不改。
  - 阅读顺序纠正使用与建档相同的开关（当前默认关闭）；开关值进入方法 hash。
- [ ] **2.3 规则预处理（没有章节角色）**
  - 页眉页脚：原样调用 `programChromeDrops`。
  - 断段：把 `paragraphBreakEvidence` 中与角色无关的部分（版面边界判定与“直接合并”的条件）抽成接受“正文判定”参数的函数。建档一侧传入现有的角色判定，结果逐字节不变；初稿一侧传入 1.3 规定的判定。
  - 只执行程序直接合并（`automatic`）。需要模型裁决的候选不合并。
  - 不做拆分、图注挂接、书目行与版权句删除（04 §8.2 第 4 条）。
  - 删除与合并记录 `source=program` 与命中的规则。
- [ ] **2.4 叶块与文字层对比**
  - 从 `pageReviewPlan` 抽出逐叶块对齐的核心（`matchingBlocks`、`opcodes`、归一化），放进共用函数。
  - 逐页校订继续用现有取词方式，输出不变。用现有 `page-review.test.ts` 与 `page-proofread.test.ts` 证明。
  - 初稿一侧的不同之处：
    - **先去掉 HTML 标记再取词。** 现有 `pageReviewPlan` 用 `reviewTokens(leaf.original_text)`，表格叶块的原文是 HTML，`table`、`tr`、`td` 等标记都会成为“解析有、文字层没有”的词，表格几乎都会被判为有差异。只去标记，不改其余归一化（同一文件中的 `words()` 已有去标记的写法）。
    - **不看整页可信度。** 现有函数在页面不可信时返回空的差异列表；初稿逐叶块判定（04 §8.3）。
    - **跨页检查。** 本页找不到的叶块，按 1.2 的条件在其它 `text-layer` 页查找。
  - 按 1.1 把叶块的取值合并成片段的取值。
  - 输出：每个片段的 `basis`，差异记录（解析文字与文字层文字），疑点片段数与差异处数，`image-only` 页数。
- [ ] **2.5 渲染**
  - 保留的叶块按来源顺序排列；解析标为 `title` 的区块作为标题；层级按 1.3。
  - 公式、图片、表格沿用 `source-order-leaves-v4` 的写法：从 `render.ts` 抽出逐叶块的写法函数，v4 的字节不变（`archive-render-v2.test.ts` 不改断言）。
  - 图注、脚注留在来源位置。资源闭包只含实际引用的图片。
  - 正文 8 MiB、结构 16 MiB 上限（`document/limits.ts`），超过时返回 1.4 规定的失败码。
  - 长循环让出事件循环，响应取消。
- [ ] **2.6 初稿内容与重建**
  - 按 1.4 形成一份可保存的初稿内容（来源区块、程序操作、逐叶块核对结果、页面分类与文字层的 hash）。
  - 提供“从初稿内容重建 Markdown 与结构”的函数，供 03 的可读性校验调用。重建不需要 PDF 页面工具。
  - 计算 representation hash 与方法 hash。

## 集成与影响

- 本块不接入生产对象图，不改变任何对外行为。
- 抽出的共用函数被建档与逐页校订调用，二者的输出必须不变。

## 验证

新增 `apps/server/test/draft-builder.test.ts`（合成 PDF 与合成原始解析，造法沿用 `archive-text-fixture.ts` 与 `proofread-fixture.ts`）。必须证明：

- 文字一致的页：片段全为 `text-layer-match`，差异为零。
- 故意改错一个词：只有该片段为 `text-layer-differs`，差异记录写出解析文字与文字层文字。
- 表格：文字与文字层一致的 HTML 表格为 `text-layer-match`。不去标记时会失败，测试要包含这个对照。
- 页面整体不可信（大部分叶块对不上）时，对得上的叶块仍为 `text-layer-match`。
- 扫描页（`image-only`）与空白页：`no-text-layer`；纯图片叶块：`no-text-layer`；图片里的文字（本页与他页都没有）：`no-text-layer`。
- 放错页的片段（词全部出现在另一页）：`text-layer-differs`。
- 多叶块片段与跨页片段按 1.1 取值。
- 页眉页脚被删除并记录规则；明确的跨页断段被合并；需要模型裁决的断段保持分开；书目行与版权句保留。
- 没有章节角色：outline 的 `role` 为 null，标题层级按 1.3。
- 相同输入两次构建，字节、representation hash、方法 hash 都相同；改一个方法组成（如对比规则版本），方法 hash 改变。
- 超过大小上限返回规定的失败码；取消返回取消。
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
- 规格不足以决定时停下，写回执交总设计师补 01，不自行决定。
