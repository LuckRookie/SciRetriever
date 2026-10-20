# 校订稿算子与快照

针对明确选择的已建档文献执行算子，保留固定输入、结果与证据关系。元数据由 Literature 的字段所有者维护，总结是显式运行的 `summary@2` 算子。

- [processor.ts](processor.ts)、[processor-registry.ts](processor-registry.ts)：可信算子注册、声明读取范围、结果校验与接纳；单篇算子不接收其它算子的结果。
- [processor-archive.ts](processor-archive.ts)：就绪检查、固定校订稿和结构版本、单篇复用键。
- [knowledge-session.ts](knowledge-session.ts)、[summary-response.ts](summary-response.ts)：DSH 持续阅读、正文分页、回查、图片查看和有证据的总结提交。覆盖检查不代表科学结论正确。
- [reading-image.ts](reading-image.ts)：验证已保存栅格图片的头信息与尺寸。
- [processor-synthesis.ts](processor-synthesis.ts)、[snapshots.ts](snapshots.ts)：冻结就绪文献快照、逐篇 map 与集合 reduce、快照比较和结果过时标记；不自动重算。
- [processor-labels.ts](processor-labels.ts)、[processor-records.ts](processor-records.ts)：调用方定义的标签与记录提取。
- [value-check.ts](value-check.ts)：结果发布前逐值核对证据；文字/人工片段核对数字，扫描或存疑片段由 DSH 看固定区域。核对标注与用量进入结果，未完成核对不丢弃候选值。
- [processor-external.ts](processor-external.ts)：外部候选的独立保留；这些证据容器不作为可执行算子输入。
- [processor-export.ts](processor-export.ts)：完整结果导出封套和固定引用的有界传输。

模型协议由 [agents](../agents/README.md) 实现，固定校订稿由 [document](../document/README.md) 提供，批量生命周期由 [application/jobs](../application/jobs/README.md) 管理。读取缺口不隐式触发发现、下载、解析或模型调用。

[上级目录](../README.md)
