# 持久化实现

提供不可变文件、单一当前结构的 SQLite catalog、执行记录以及写入准入和锁。

## 下级目录

| 目录                              | 职责                  |
| --------------------------------- | --------------------- |
| [execution/](execution/README.md) | 执行记录存储          |
| [files/](files/README.md)         | 不可变文件存储        |
| [sqlite/](sqlite/README.md)       | SQLite catalog 初始化与结构检查 |

## 内容入口

- [artifact-layout.ts](artifact-layout.ts)：原始文件、解析与知识产物的分类目录、hash 分桶和真实扩展名；已有 catalog 路径优先复用。
- [locking.ts](locking.ts)：文件锁与写入协作。
- [write-admission.ts](write-admission.ts)：写入准入。
- [processor-results.ts](processor-results.ts)：不可变算子结果/集合、固定依赖与可重建查询投影，负责 summary 引用固定范围与真实缺失的发布/回读核验；指定结果重建时同时覆盖其快照 map 依赖，避免逐篇结果缺少投影使检索过期。

## 放置边界

保存业务模块已经确认的事实。源码目录不存真实 catalog、PDF、配置或用户语料，也不替业务模块决定合并与接纳。

[上级目录](../README.md)

- [raw-parsing.ts](raw-parsing.ts)：原始解析不可变字节发布、读取校验、逐 profile 状态与引用保护；大型产物不进入 SQLite。

- [proofread.ts](proofread.ts)：校订产物与人工决定的不可变文件，读取校验与 SQLite worker 发布；与 raw 的引用保护在同一事务登记。

`structure-annotations.ts` 保存与验证固定文档的结构注释，文件保存 JSON 字节，catalog 保存版本关系和人工角色审计；识别规则与业务决定属于 Document，存储不判断章节语义。
