# React 文献工作空间

按 ADR 0036 实现正式人类界面，默认入口为 `/`。静态资源使用 `/assets/`；迁移期 `/next` 入口和旧前端兼容已取消。`data/` 拥有会话、查询和客户端状态，`components/` 与 `motion/` 提供共享控件及动效，`shell/` 组织导航和标签，`features/` 实现围绕文献库的操作。PDF 与正文引擎继续使用框架无关模块。

生产路径只消费真实 API；实验台与测试使用明确的合成材料。不更改 API、CSP 或 catalog。

[源码目录](../README.md) · [实施计划](../../../../docs/plans/2026-10-19-web-experience/README.md)
