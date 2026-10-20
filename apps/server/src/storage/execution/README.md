# 执行记录存储

保存任务执行记录、租约与运行时所有权，支持恢复和迁移准入。

## 内容入口

- [repository.ts](repository.ts)：执行记录仓库。
- [runtime-owner.ts](runtime-owner.ts)：运行时所有权。
- [migration-gate.ts](migration-gate.ts)：执行格式迁移准入。

## 放置边界

任务步骤和重试决定由 application/jobs 或 entry 作出；这里提供持久化机制。

[上级目录](../README.md)
