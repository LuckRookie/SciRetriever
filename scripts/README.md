# 项目构建工具

保存反复使用、随项目维护的构建和发布工具。

## 下级目录

| 目录 | 职责 |
| --- | --- |
| [package/](package/README.md) | 便携包构建 |

## 内容入口

- [build-workbench-assets.mjs](build-workbench-assets.mjs)：从 Web 源码构建 bundle，将指定页面/样式放入应用构建目录。

## 放置边界

一次性调试与真实测试脚本进入 sandbox/cases；业务逻辑进入 apps 或 packages，避免藏在构建脚本里。

[项目目录地图](../README.md#项目目录地图)
