# 应用实现

类型：代码导航
负责：应用实现
状态：现行

组织可运行的服务端和 Web 应用。server 包含核心业务、CLI/MCP/HTTP 入口及生产组装；web 实现浏览器界面；browser-extension 是在用户自己浏览器里收藏文献的扩展。

## 下级目录

| 目录                                              | 职责                 |
| ------------------------------------------------- | -------------------- |
| [server/](server/README.md)                       | 服务端与核心应用     |
| [web/](web/README.md)                             | Browser 工作台前端   |
| [browser-extension/](browser-extension/README.md) | 网页收藏的浏览器扩展 |

## 放置边界

跨应用共享的中性合同放在 packages/contracts；本目录各应用的 test/ 保存对应回归。

[项目目录地图](../docs/development/repository-map.md)
