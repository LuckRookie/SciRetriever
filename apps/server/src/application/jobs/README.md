# 持久任务与加工调度

处理任务队列、显式运行、加工步骤和人工介入。

## 内容入口

- [service.ts](service.ts)：任务队列和执行调度。
- [processing.ts](processing.ts)：解析/分析等加工任务接线。
- [drafts.ts](drafts.ts)：已有 raw 的初稿补形成；同一个只读选择函数用于预览与固定成员，沿用 execution queue、analysis 阶段、尝试、控制和事件，业务目标为 draft。
- [interventions.ts](interventions.ts)：人工介入与任务恢复协作。

## 放置边界

持久执行数据由 storage/execution 保存，业务操作复用 entry 和相应业务模块。

[上级目录](../README.md)

- `processors.ts`：把处理器请求冻结成现有队列目标，发布不可变结果集合与运行统计；不维护第二套调度器。

`metadata-progress.ts` 将逻辑来源调用的安全增量写进既有 durable events，Network 的无参数派发事实与来源进入阶段分开。

`service.ts` 固定获取 PDF 与显式 parse_only 解析范围：解析只选有主 PDF 且缺当前原始解析的版本，沿用 parser 执行目标；原有数据库补全不因此改为仅解析。scope 保存选择器及各自互斥的跳过计数，默认尝试预算覆盖选中的全部目标。任务创建不执行，后续入库或解析不改变已固定的成员。

补形成的 scope 保存同一选择器和 `FormDraftsCounts`，先跳过不需要处理的文献，再按查询排序应用 limit。部署 profile 没有 raw 时使用已登记的 Markdown raw。旧方法只在显式打开开关时处理；创建时固定每个部分的 raw ID/hash 和既有版本 ID，后到的相同初稿报告 reused，创建前已有的固定版本重新成为当前仍计为形成工作。成功或跳过的部分有可复用的 durable receipt，单部分失败不撤销其它部分；取消后的未领取目标保持 queued/pending。任务详情的 results/partial_results 给出逐部分结果，运行记录同时投影为 items[].draft_parts；没有独立任务表或调度器。
