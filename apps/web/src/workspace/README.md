# 文献库 Web 工作空间

将[定稿 HTML](../../../../docs/architecture/web/README.md)的布局、视觉与交互接入正式工作台。各页面消费同一认证 transport、应用查询与显式维护接口，不保存第二套文献或任务事实。

页面结构和样式来自 `public/live.html` 与 `public/workspace.css`，公共查询、文档证据与配置能力复用上级模块。app/api 管理导航、页面生命周期与认证；library/actions 管理文献和显式操作；intake/retrieval/synthesis/insights 对接发现与材料使用；tasks/browser 管理任务与活会话；settings 复用配置和高级表单。UI 偏好仅保存视图条件和主题；示例数据不进入正式入口。

`source-navigation.ts` 统一检索命中到文献／综合的固定引用转换和校验，URL 只携带 ID、hash 和片段范围，不携带正文。`RetrievalState` 在工作区实例中保留草稿、结果、续读与上下文篮子；导航取消旧请求，刷新整个页面不恢复该临时状态。`processors.ts` 接入 G1 人类标签/记录表单与共享 HTTP；`processor-results.ts` 提供任务到固定结果/集合摘要，详细结果工作区仍按 G2 继续实现。`ProcessorFormState` 只在工作区内保留草稿和提交回执，不写入 catalog，不能向旧 artifact reader 传递 result ID。

[上级源码目录](../README.md) · [Web 应用](../../README.md)
