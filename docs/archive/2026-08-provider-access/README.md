# 2026-08 供应商访问调度归档

本目录保存形成供应商级全局访问调度决策之前的活动提案。材料用于审计历史问题、备选方案和当时的外部事实，不是当前需求、设计、配置或已发布行为的真相源。

当前长期决策见 [ADR 0009](../../architecture/decisions/0009-provider-scoped-global-access-scheduling.md)，PDF 三阶段顺序见[设计文档](../../architecture/design.md#44-acquisition)与 [Acquisition 技术文档](../../architecture/technical/acquisition.md)，全局准入实现边界见 [Network 技术文档](../../architecture/technical/network.md)。易变供应商限速和额度数字由 [Provider Notes](../../notes/providers/README.md)及各厂商文档维护。

归档内容：

- [多下载源可用性与合理访问限制提案](acquisition-source-availability-and-access-limits.md)：旧提案只讨论 acquisition、建议若干当时数值并把共享预算限制为单进程；这些未决内容已由当前 provider/channel/host 同机全局准入、网页独占与至少 30 秒冷却、API 按真实规则执行的设计取代。
