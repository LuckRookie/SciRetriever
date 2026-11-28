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

建档步骤为 `arrange → proofread → render → translate → layers → metadata → references → tags`。`translate`（ADR 0068，实现在 `translation/document.ts`）只在主 PDF 上执行，输入键为“主 PDF、校订稿内容版本、译文语言”，相同且上次完成时跳过；只有 `from_step: translate` 强制重译全部单元。它与 `references` 一样失败不中断后面的步骤，问题的 `affects_readiness` 为 false；原因只有 `translation-incomplete` 与 `translation-unavailable`，后者的原始失败码记在 `output.failure_code`。运行时没有接上 `translate` 时（只测其他步骤的测试）这一步不出现。已有全文、没有译文的文献再次建档时，前三步靠各自的复用不调用模型，后三步按输入键跳过，只有这一步调用模型。

`layers`（ADR 0069，实现在 `layers/document.ts`）同样只在主 PDF 上执行，输入键为“主 PDF、校订稿内容版本、译文语言、当前内容版本的译文文件 sha256”；只有 `from_step: layers` 强制全部重做（它不强制后面的 `metadata`、`references`、`tags`：它们不依赖译文与阅读层，规则在 `input-key.ts` 的 `archiveStepForced`），只有译文文件变了时这一步只重做译文部分。失败不中断后面的步骤、不影响就绪；原因为 `layers-incomplete`、`layers-translation-incomplete` 与 `layers-unavailable`（原始失败码记在 `output.failure_code`）。运行时没有接上 `layers` 时这一步不出现。`reuse.ts` 的 `layersPending` 判断主 PDF 是否还要这一步，供整篇复用与用量估算。

`text-pipeline.ts` 是生产六步前半段的组装：中性 source、整理、逐页校订、文本清单 CAS、文档/注释发布和索引刷新。`render.ts` 只生成确定性 Markdown、结构、source map 与派生注释；`arrangement-access.ts` 提供固定版本查询、人工恢复/重归属与锁，`markdown-edit.ts` 校验整份 Markdown 的唯一叶块映射。

新长文档在组装校订内容时，用 source 内已有的页分类与文字层对比未逐页校订的保留叶块，复用相邻 document/draft-builder 的比较规则；人工文字锁保持 manual。普通校订页的依据不变。长文档新渲染用 source-order-leaves-v5，普通文献继续 v4；两者排版相同，v5 多接受未校订页的三种依据。整理里有表注时用 source-order-leaves-v6（普通与长文档共用，表注排在表与图注之后并记进该表的分组，不再按脚注移动），没有表注时 v6 与 v4/v5 字节相同，所以仍用 v4/v5。历史固定版本按记录的 builder 重建，v4 及更早版本拒绝新依据，不重写历史产物。

`format-normalize.ts` 是整理的写法统一（`format-normalize-v1`）：正文类区块里的 `<sup>`/`<sub>` 写成 `$^{…}$`/`$_{…}$`，行内公式末尾的句点移到 `$` 之外（`\right.` 这类 LaTeX 记号不算），内容含 `$`、`%`、`#`、`&` 或括号不配对的标签不动。整理请求与断段请求送出统一后的文字，模型的拆分位置换算回原文；接纳的整理记下 `format_rule`。改动不写进整理，而在校订时按叶块坐标记为每页的程序改字（`source: program` 与 `rule`），人工文字锁优先。`text-source.ts` 从原始区块算出表注（类型 `footnote`、来源 `table`，同页上方最近的表），整理后由程序挂到表上（`caption` 操作加 `relation: table-note`）；这份对应不进入 source 的输入 hash。已有整理没有 `format_rule`，照旧复用；只有 `from_step: arrange` 时 `text-pipeline.ts` 不复用这样的整理而重新整理。

默认生产编排使用 schema 2；旧请求不作为别名。历史 immutable 校订稿和注释由各自历史解码器读取，旧步骤单列，不自动重建。新清单、人工决定和页缓存由相邻 storage 模块保存，原始解析继续 pin；所有模型工作仍只经受控 DSH。
\n`preprocess.ts`、`pdf-geometry.ts` 与 `paragraph-breaks.ts` 实现程序页眉页脚删除、可见文字层度量和断段三类判定；`source-layout.ts` 与 `render.ts` 实现普通 Markdown 的原文顺序排版，`render-legacy.ts` 仅重现历史 builder 字节。`reading-order.ts` 的纠正开关默认关闭。\n
