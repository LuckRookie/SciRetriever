# 应用任务控制

承接应用级任务执行与协作，当前具体实现集中在 jobs/。

## 下级目录

| 目录 | 职责 |
| --- | --- |
| [jobs/](jobs/README.md) | 持久任务与加工调度 |

## 放置边界

生产对象图与应用生命周期组装在 bootstrap；用户操作编排在 entry；持久化执行记录在 storage/execution。

[上级目录](../README.md)
