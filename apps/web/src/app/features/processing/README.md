# 处理与结果

G1 记录/标签表单固定选择范围，校验字段、单位与读取策略，保留会话草稿和幂等提交回执。G2 结果视图查询固定集合/结果，按页筛选、跨页选中、核对来源、按确认记录综合，并导出整份完整结果。

纯结果传输与 hash 校验复用 `app/data/processor-results.ts`。旧 artifact 与 result ID 不互换；false、null 和缺失字段分别展示。证据视图保留上游引用及固定原文跳转，技术标识仅在详情中展示。

`Evidence.tsx` 按来源走现有读取边界：处理结果使用 processors，文档使用 evidence-resolve，知识与综合使用 synthesis-source。综合的来源内容、输入清单和断言 hash 在递归核对时全部保留；原 PDF 不可复核时明示来源降级。旧知识库的证据读取不依赖处理器 schema。

[应用源码](../../README.md) · [加工迁移记录（归档）](../../../../../../docs/archive/2026-10-19-web-experience/08-use-and-processing.md)
