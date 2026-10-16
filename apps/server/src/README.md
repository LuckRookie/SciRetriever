# 服务端源码地图

按业务职责组织源码。CLI、MCP 和 Web 请求通过统一应用组装使用同一套业务服务与文献事实。

## 下级目录

| 目录                                      | 职责                      |
| ----------------------------------------- | ------------------------- |
| [acquisition/](acquisition/README.md)     | PDF 获取与接纳            |
| [agents/](agents/README.md)               | 单次模型与受控 Agent 执行 |
| [analysis/](analysis/README.md)           | 知识分析与综合            |
| [application/](application/README.md)     | 应用任务控制              |
| [bootstrap/](bootstrap/README.md)         | 生产对象图组装            |
| [browser/](browser/README.md)             | 浏览器会话与控制          |
| [cli/](cli/README.md)                     | 命令行入口                |
| [configuration/](configuration/README.md) | 配置与凭据                |
| [document/](document/README.md)           | 可读文档与证据            |
| [entry/](entry/README.md)                 | 统一业务操作入口          |
| [extraction/](extraction/README.md)       | 调用方提取候选交付        |
| [literature/](literature/README.md)       | 文献事实与身份            |
| [logging/](logging/README.md)             | 安全日志                  |
| [mcp/](mcp/README.md)                     | MCP 入口适配              |
| [metadata/](metadata/README.md)           | 中性元数据服务            |
| [network/](network/README.md)             | 共享网络访问              |
| [parsing/](parsing/README.md)             | PDF 解析                  |
| [providers/](providers/README.md)         | 文献供应商适配器          |
| [retrieval/](retrieval/README.md)         | 已有材料与知识检索        |
| [storage/](storage/README.md)             | 持久化实现                |
| [workbench/](workbench/README.md)         | 工作台服务端适配          |

## 内容入口

- [index.ts](index.ts)：服务端包的公开 TypeScript API 汇总。

## 放置边界

新增功能先找到事实的业务所有者；业务判断留在所属模块，跨模块共享数据形状放在 contracts，生产接线放在 bootstrap。

相关说明：[整体架构](../../../docs/architecture/design.md)；[代码与文档映射](../../../docs/development/documentation-map.md)。

[上级目录](../README.md) · [项目 README](../../../README.md)
