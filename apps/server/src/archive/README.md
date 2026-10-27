# 文献建档

本目录编排已解析材料的校订、文档发布、结构、元数据、参考文献和标签步骤，保存执行回执、失败问题和版本变化。建档复用持久任务队列，不执行 PDF 获取或 MinerU 解析，不自动生成总结。

- `orchestrator.ts`：单篇执行、断点复用、失败隔离与批次整理。
- `service.ts`：选择范围、任务提交、问题处理和只读查询。
- `text-source.ts`：直接核验不可变原始解析并构造中性 source block，保留待整理内容及原始定位。
- `arrangement.ts`：整理操作、叶块、断段候选和接纳校验；提供保留文字的审计投影，不发布文档。
- `arrangement-service.ts`：使用 `proofreading` 角色的 DSH 整理会话，有界读块、图像、文字层提示、宿主草案与接纳检查点。
- `text-session.ts`：整理和逐页校订共用的进展保护、用量、工具窗口及 DSH 上下文压缩。
- 就绪规则由相邻的 `literature/state.ts` 统一定义；持久化适配由 `storage/sqlite/archive-engine.ts` 实现。

`input-key.ts` 统一步骤复用键；`reuse.ts` 只读检查当前原稿、人工决定、方法、模型及各步缓存，供启动前预估完整可复用篇数，不把部分复用计作整篇复用。

整理服务可与相邻 `proofread/page-service.ts` 串行调用。默认建档编排仍走既有链路；新服务的六步编排、步骤入库、文档发布和传输入口尚未切换。检查点复用现有校订缓存接口，不写 `archive_steps`。
