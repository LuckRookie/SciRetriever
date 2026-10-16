# 服务端与核心应用

TypeScript 模块化单体的实现位置，包含文献发现、获取、解析、知识加工、读取，以及 CLI/MCP/HTTP 入口。

## 下级目录

| 目录 | 职责 |
| --- | --- |
| [src/](src/README.md) | 服务端源码地图 |
| [test/](test/README.md) | 服务端回归测试 |

## 内容入口

- [package.json](package.json)：@sciretriever/server 的依赖、公开导出与 CLI 声明。
- [tsconfig.json](tsconfig.json)：服务端源码构建配置。

## 放置边界

src/ 保存可维护源码，test/ 保存离线回归，dist/ 为构建产物。目录名 server 不意味着这里仅有 HTTP 服务。

相关说明：[模块责任与数据流](../../docs/architecture/design.md)；[Agent 使用入口](../../docs/guides/agent-interface.md)。

[上级目录](../README.md) · [项目 README](../../README.md)
