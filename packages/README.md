# 共享包

保存可被不同应用消费的 workspace 包；当前为跨模块中性合同包 contracts。

## 下级目录

| 目录 | 职责 |
| --- | --- |
| [contracts/](contracts/README.md) | 中性合同包 |

## 放置边界

业务服务与入口适配属于 apps/server，各应用的界面代码属于 apps/web；新增共享包应有明确消费者与边界。

[项目目录地图](../README.md#项目目录地图)
