# 文献建档

本目录编排已解析材料的整理、逐页校订、确定性渲染、元数据、参考文献和标签步骤，保存执行回执、失败问题和版本变化。建档复用持久任务队列，不执行 PDF 获取或 MinerU 解析，不自动生成总结。

- `orchestrator.ts`：单篇执行、断点复用、失败隔离与批次整理。
- `service.ts`：选择范围、任务提交、问题处理和只读查询。
- `text-source.ts`：直接核验不可变原始解析并构造中性 source block，保留待整理内容及原始定位。
- `arrangement.ts`：整理操作、叶块、断段候选和接纳校验；提供保留文字的审计投影，不发布文档。
- `arrangement-service.ts`：使用 `proofreading` 角色的 DSH 整理会话，有界读块、图像、文字层提示、宿主草案与接纳检查点。
- `text-session.ts`：整理和逐页校订共用的进展保护、用量、工具窗口及 DSH 上下文压缩。
- 就绪规则由相邻的 `literature/state.ts` 统一定义；持久化适配由 `storage/sqlite/archive-engine.ts` 实现。

`input-key.ts` 统一步骤复用键；`reuse.ts` 只读检查当前原稿、人工决定、方法、模型及各步缓存，供启动前预估完整可复用篇数，不把部分复用计作整篇复用。

`text-pipeline.ts` 是生产六步前半段的组装：中性 source、整理、逐页校订、文本清单 CAS、文档/注释发布和索引刷新。`render.ts` 只生成确定性 Markdown、结构、source map 与派生注释；`arrangement-access.ts` 提供固定版本查询、人工恢复/重归属与锁，`markdown-edit.ts` 校验整份 Markdown 的唯一叶块映射。

默认生产编排使用 schema 2；旧请求不作为别名。历史 immutable 校订稿和注释由各自历史解码器读取，旧步骤单列，不自动重建。新清单、人工决定和页缓存由相邻 storage 模块保存，原始解析继续 pin；所有模型工作仍只经受控 DSH。
