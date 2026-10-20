# Web 交互源码

实现以文献库为中心的浏览、阅读、知识检索、处理、任务、Browser 观看/指导与设置。HTTP 和业务 owner 位于 server，前端只持有展示、草稿和会话阅读位置。

- [app/](app/README.md)：正式 React 入口、公共组件、数据适配、动效和功能页面；主工作台由 `/` 提供。登录、独立查询/维护及合成样本复用同一工程。
- [reading/](reading/README.md)：框架无关的固定 PDF/全文引擎，通过 React ref 接入；保留原文、hash、范围和来源验证。
- [browser-platform.ts](browser-platform.ts)：普通 HTTP 与安全上下文共享的随机 ID、用户主动复制适配。
- [preview-server.ts](preview-server.ts)、[preview.ts](preview.ts)：独立 React 合成样本的固定静态资源服务。

旧 DOM 工作台、旧阅读框架和根入口已经删除。共享协议解析、任务投影及候选状态在 `app/data/`，合成样本状态在 `app/features/sample/`，不通过旧路径兼容导出。
