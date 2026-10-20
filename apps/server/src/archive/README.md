# 文献建档

本目录编排已解析材料的校订、文档发布、结构、元数据、参考文献和标签步骤，保存执行回执、失败问题和版本变化。建档复用持久任务队列，不执行 PDF 获取或 MinerU 解析，不自动生成总结。

- `orchestrator.ts`：单篇执行、断点复用、失败隔离与批次整理。
- `service.ts`：选择范围、任务提交、问题处理和只读查询。
- 就绪规则由相邻的 `literature/state.ts` 统一定义；持久化适配由 `storage/sqlite/archive-engine.ts` 实现。
