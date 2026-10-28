# 持久任务与加工调度

处理任务队列、显式运行、加工步骤和人工介入。

## 内容入口

- [service.ts](service.ts)：任务队列和执行调度。
- [processing.ts](processing.ts)：解析/分析等加工任务接线。
- [interventions.ts](interventions.ts)：人工介入与任务恢复协作。

## 放置边界

持久执行数据由 storage/execution 保存，业务操作复用 entry 和相应业务模块。

[上级目录](../README.md)

- `processors.ts`：把处理器请求冻结成现有队列目标，发布不可变结果集合与运行统计；不维护第二套调度器。

`metadata-progress.ts` 将逻辑来源调用的安全增量写进既有 durable events，Network 的无参数派发事实与来源进入阶段分开。
