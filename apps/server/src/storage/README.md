# 持久化实现

提供不可变文件、版本化 SQLite catalog、执行记录以及写入准入和锁。

## 下级目录

| 目录                              | 职责                  |
| --------------------------------- | --------------------- |
| [execution/](execution/README.md) | 执行记录存储          |
| [files/](files/README.md)         | 不可变文件存储        |
| [sqlite/](sqlite/README.md)       | SQLite catalog 与迁移 |

## 内容入口

- [artifact-layout.ts](artifact-layout.ts)：原始文件、解析与知识产物的分类目录、hash 分桶和真实扩展名；已有 catalog 路径优先复用。
- [locking.ts](locking.ts)：文件锁与写入协作。
- [write-admission.ts](write-admission.ts)：写入准入。
- [knowledge.ts](knowledge.ts)：知识产物持久化。
- [synthesis.ts](synthesis.ts)：综合产物持久化。

## 放置边界

保存业务模块已经确认的事实。源码目录不存真实 catalog、PDF、配置或用户语料，也不替业务模块决定合并与接纳。

相关说明：[所属技术文档](../../../../docs/architecture/technical/07-versioned-storage.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)

- `processor-results.ts`：通用不可变结果/集合文件、精确依赖及可重建查询投影；原知识正文仍由原 owner 保管。
