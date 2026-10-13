# Web 交互源码

实现 Browser 观看/指导、配置、任务、文献与知识阅读等界面交互。

## 内容入口

- [live.ts](live.ts)：实时工作台入口。
- [query.ts](query.ts)：只读查询入口。
- [maintenance.ts](maintenance.ts)：显式维护入口。
- [library.ts](library.ts)：文献浏览。
- [knowledge.ts](knowledge.ts)：知识结果展示。
- [jobs.ts](jobs.ts)：任务状态与操作。
- [overview.ts](overview.ts)、[task-view.ts](task-view.ts)：同一持久任务的首页投影和展示合同。
- [navigation.ts](navigation.ts)：工作空间可见性、历史、主导航与移动导航的统一 owner。
- [workspace-tools.ts](workspace-tools.ts)：启动库绑定、显式元数据发现与书目导入。
- [wire.ts](wire.ts)：界面协议连接。

## 放置边界

页面布局和样式在 ../public，HTTP 服务适配在 apps/server/src/workbench；前端不保存第二套权威文献事实。

[上级目录](../README.md) · [项目 README](../../../README.md)
