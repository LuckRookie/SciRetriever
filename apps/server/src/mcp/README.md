# MCP 入口适配

把项目公开能力提供为 MCP stdio 服务和工具。

## 内容入口

- [server.ts](server.ts)：MCP 服务生命周期与协议连接。
- [tools.ts](tools.ts)：工具声明与封闭请求 schema。
- [pdf-upload.ts](pdf-upload.ts)：当前连接的有界 PDF 上传缓冲，校验完整字节后交给既有接纳服务。

查询、任务投影、书目导入、提取交付与配置操作复用 `entry/*-operations.ts`。普通配置状态/预览可只读调用；配置发布、凭据变更、probe 与维护工具要求 `--maintenance`。PDF 输入采用限额分块缓冲，文件读取使用固定 hash 与有界块；`--workbench-url` 显式连接活 Web owner，提供 Browser 协作与服务任务调用。句柄、进程寿命和错误恢复见[Agent 指南](../../../../docs/guides/agent-interface.md)。

## 放置边界

复用已有 Application/Entry 操作，不在工具处理函数中实现平行的检索、下载或加工链。

相关说明：[所属技术文档](../../../../docs/architecture/technical/01-product-interface.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
