# 校订稿算子与快照

针对明确选择的已建档文献执行算子，保留固定输入、结果与证据关系。元数据由 Literature 的字段所有者维护，总结是显式运行的 `summary@2` 算子。

- [processor.ts](processor.ts)、[processor-registry.ts](processor-registry.ts)：可信算子注册、声明读取范围、结果校验与接纳；单篇算子不接收其它算子的结果。
- [processor-archive.ts](processor-archive.ts)：就绪检查、固定校订稿和结构版本、单篇复用键。
- [knowledge-session.ts](knowledge-session.ts)、[summary-response.ts](summary-response.ts)：DSH 持续阅读、正文分页、回查、图片查看和有证据的总结提交。覆盖检查不代表科学结论正确。
- [processor-evidence.ts](processor-evidence.ts)：summary 引用的固定输入范围检查，供执行接纳及结果存储复用；不存在的片段声明保留，由存储核验真实缺失并由逐值核对标记。
- [reading-image.ts](reading-image.ts)：验证已保存栅格图片的头信息与尺寸。
- [processor-synthesis.ts](processor-synthesis.ts)、[snapshots.ts](snapshots.ts)：冻结就绪文献快照、逐篇 map 与集合 reduce、快照比较和结果过时标记；不自动重算。
- [processor-labels.ts](processor-labels.ts)、[processor-records.ts](processor-records.ts)：调用方定义的标签与记录提取。
- [value-check.ts](value-check.ts)：结果发布前逐值比对校订片段中的数字、单位及非空文本；各来源统一文字比对，综合值链接来源结果。返回六种核对状态与片段 basis，不调用模型，不把抄录比对当作科学正确性证明。
- [processor-external.ts](processor-external.ts)：外部候选的独立保留；这些证据容器不作为可执行算子输入。
- [processor-export.ts](processor-export.ts)：完整结果导出封套和固定引用的有界传输。

模型协议由 [agents](../agents/README.md) 实现，固定校订稿由 [document](../document/README.md) 提供，批量生命周期由 [application/jobs](../application/jobs/README.md) 管理。读取缺口不隐式触发发现、下载、解析或模型调用。

[上级目录](../README.md)

`processor-planning.ts` 供执行和只读预估共用规范、读取范围与模型复用键；`processor-usage.ts` 保存结果生成用量摘要；`usage-estimate.ts` 用历史中位数至 P90 预估显式范围，不加载凭据、不调用模型、不写事实。

- [processor-chunking.ts](processor-chunking.ts)：保守估算输入预算，按标题层级与段落分块，保留表格、图注、脚注、续表及公式整体；预算与规则进入方法身份。
- [snapshot-names.ts](snapshot-names.ts)：快照显示名生成；人工名由独立标签表保存，不改变快照内容身份。
