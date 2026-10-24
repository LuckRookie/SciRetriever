# 执行记录存储

保存任务执行记录、租约与运行时所有权，支持恢复和运行准入。

## 内容入口

- [repository.ts](repository.ts)：执行记录仓库；列表进度由当前目标处置聚合，不保存第二份进度事实，不按 attempt 重复计数。
- [runtime-owner.ts](runtime-owner.ts)：运行时所有权。

## 放置边界

任务步骤和重试决定由 application/jobs 或 entry 作出；这里提供持久化机制。

[上级目录](../README.md)
