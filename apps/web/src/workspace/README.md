# 文献库 Web 工作空间

将[定稿 HTML](../../../../docs/architecture/web/README.md)的布局、视觉与交互接入正式工作台。各页面消费同一认证 transport、应用查询与显式维护接口，不保存第二套文献或任务事实。

页面结构和样式来自 `public/live.html` 与 `public/workspace.css`，公共查询、文档证据与配置能力复用上级模块。app/api 管理导航、页面生命周期与认证；library/actions 管理文献和显式操作；intake/retrieval/synthesis/insights 对接发现与材料使用；tasks/browser 管理任务与活会话；settings 复用配置和高级表单。UI 偏好仅保存视图条件和主题；示例数据不进入正式入口。

[上级源码目录](../README.md) · [Web 应用](../../README.md)
