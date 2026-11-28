# 文献建档

本目录编排材料的整理、逐页校订、确定性渲染、元数据、参考文献和标签步骤，保存执行回执、失败问题和版本变化。建档复用持久任务队列；缺部署 profile 原始解析时先委托 document 服务解析并独立形成初稿，本模块不实现 parser 协议、不获取 PDF、不自动生成总结。

- `orchestrator.ts`：单篇执行、断点复用、失败隔离与批次整理。首步的完整解析回执（含 draft）与步骤进度同事务写入 archive-progress 事件；初稿失败不阻止后续建档。任务步骤读取从事件投影 receipt，reason 仍只保存原始解析失败码。
- `service.ts`：选择范围、任务提交、问题处理和只读查询。`archive` 的 `issue-count` 接受空请求，返回当前 PDF 材料上未解决的问题条数。`issues` 提供同一范围的问题列表、分组和分页。
- `text-source.ts`：直接核验不可变原始解析并构造中性 source block，保留待整理内容及原始定位。
- `arrangement.ts`：整理操作、叶块、断段候选和接纳校验；提供保留文字的审计投影，不发布文档。
- `arrangement-service.ts`：使用 `proofreading` 角色的整理（ADR 0048）：一次请求提交全部去向、一次请求决定全部断段，程序预拆版权句、按文字层纠正页归属，接纳检查点。
- `text-session.ts`：整理和逐页校订共用的单工具请求、进展保护、用量及 DSH 上下文压缩。
- 就绪规则由相邻的 `literature/state.ts` 统一定义；持久化适配由 `storage/sqlite/archive-engine.ts` 实现。

`input-key.ts` 统一步骤复用键；`reuse.ts` 只读检查当前原稿、人工决定、方法、模型及各步缓存，供启动前预估完整可复用篇数，不把部分复用计作整篇复用。

建档步骤为 `arrange → proofread → render → layers → metadata → references → tags → translate`（ADR 0074 第 5 节）：翻译之前的各步只用原文。`translate` 之外的步骤停下时（被排除的文章性质，或元数据、标签没有完成），后面的步骤不再执行，`translate` 仍执行：它只依赖全文与阅读层。整理、校订或渲染没有完成时整篇停下。

`layers`（ADR 0069，实现在 `layers/document.ts`）只在主 PDF 上执行，只写原文语言的版本，输入键为“主 PDF、校订稿内容版本、阅读层文件版本”；只有 `from_step: layers` 强制重做。失败不中断后面的步骤、不影响就绪；原因为 `layers-incomplete` 与 `layers-unavailable`（原始失败码记在 `output.failure_code`）。运行时没有接上 `layers` 时这一步不出现。

`translate`（ADR 0068，实现在 `translation/document.ts`）只在主 PDF 上执行：先译全文，再写阅读层的译文部分（`DocumentLayersService.translate`，只在库的默认语言里写；当场翻译成别的语言时只译全文）。输入键为“主 PDF、校订稿内容版本、译文语言、当前原文语言阅读层的标识（`DocumentLayersStore.originalSha256`，阅读层文件去掉译文部分后的 sha256；没有时不写进键）”，相同且上次完成时跳过。只有阅读层变了时，这一内容版本完整的全文译文原样保留、不请求模型，只重做阅读层的译文部分。它与 `references` 一样失败不中断后面的步骤，问题的 `affects_readiness` 为 false；原因为 `translation-incomplete`、`translation-unavailable`（原始失败码记在 `output.failure_code`）与 `layers-translation-incomplete`（阅读层的译文部分什么也没写成）。回执的 `output.translation` 是全文，`output.layers` 是阅读层的译文部分。运行时没有接上 `translate` 时（只测其他步骤的测试）这一步不出现。

`from_step` 的含义都在 `input-key.ts`：`archiveStepForced` 说一步是否强制执行，`archiveTranslationForced` 说 `translate` 里强制哪一部分。`from_step: layers` 强制 `layers` 与 `translate` 的阅读层部分（全文的译文复用）；`from_step: translate` 强制全文与阅读层部分；两者都不强制 `metadata`、`references`、`tags`。

本决定之前记下的输入键照常有效：`layers` 的旧键另含译文语言与译文文件的 sha256（`archiveLayersKeyBeforeTranslateLast`），与当前内容版本、文件版本、语言和译文文件算出的相同时，这一步跳过并改记新键；`translate` 的旧键不含阅读层，阅读层的译文部分已按当前译文文件写成（`layersTranslationCurrent`）时同样跳过并改记新键。已完成的文献因此恢复建档时不调用模型、不重写文件。`reuse.ts` 的 `layersPending`、`translationPending` 按同样的规则判断主 PDF 是否还要这两步，供整篇复用与用量估算。

`text-pipeline.ts` 是生产六步前半段的组装：中性 source、整理、逐页校订、文本清单 CAS、文档/注释发布和索引刷新。`render.ts` 只生成确定性 Markdown、结构、source map 与派生注释；`arrangement-access.ts` 提供固定版本查询、人工恢复/重归属与锁，`markdown-edit.ts` 校验整份 Markdown 的唯一叶块映射。

新长文档在组装校订内容时，用 source 内已有的页分类与文字层对比未逐页校订的保留叶块，复用相邻 document/draft-builder 的比较规则；人工文字锁保持 manual。普通校订页的依据不变。长文档新渲染用 source-order-leaves-v5，普通文献继续 v4；两者排版相同，v5 多接受未校订页的三种依据。整理里有表注时用 source-order-leaves-v6（普通与长文档共用，表注排在表与图注之后并记进该表的分组，不再按脚注移动），没有表注时 v6 与 v4/v5 字节相同，所以仍用 v4/v5。历史固定版本按记录的 builder 重建，v4 及更早版本拒绝新依据，不重写历史产物。

`format-normalize.ts` 是整理的写法统一（`format-normalize-v1`）：正文类区块里的 `<sup>`/`<sub>` 写成 `$^{…}$`/`$_{…}$`，行内公式末尾的句点移到 `$` 之外（`\right.` 这类 LaTeX 记号不算），内容含 `$`、`%`、`#`、`&` 或括号不配对的标签不动。整理请求与断段请求送出统一后的文字，模型的拆分位置换算回原文；接纳的整理记下 `format_rule`。改动不写进整理，而在校订时按叶块坐标记为每页的程序改字（`source: program` 与 `rule`），人工文字锁优先。`text-source.ts` 从原始区块算出表注（类型 `footnote`、来源 `table`，同页上方最近的表），整理后由程序挂到表上（`caption` 操作加 `relation: table-note`）；这份对应不进入 source 的输入 hash。已有整理没有 `format_rule`，照旧复用；只有 `from_step: arrange` 时 `text-pipeline.ts` 不复用这样的整理而重新整理。

默认生产编排使用 schema 2；旧请求不作为别名。历史 immutable 校订稿和注释由各自历史解码器读取，旧步骤单列，不自动重建。新清单、人工决定和页缓存由相邻 storage 模块保存，原始解析继续 pin；所有模型工作仍只经受控 DSH。
\n`preprocess.ts`、`pdf-geometry.ts` 与 `paragraph-breaks.ts` 实现程序页眉页脚删除、可见文字层度量和断段三类判定；`source-layout.ts` 与 `render.ts` 实现普通 Markdown 的原文顺序排版，`render-legacy.ts` 仅重现历史 builder 字节。`reading-order.ts` 的纠正开关默认关闭。\n
