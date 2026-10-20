# MinerU 服务适配

连接 operator 管理的 MinerU 服务，执行健康检查、提交、轮询和归档转换。

## 内容入口

- [profile.ts](profile.ts)：锁定的协议与解析 profile。
- [protocol.ts](protocol.ts)：服务协议字段与响应转换。
- [http.ts](http.ts)：双 profile HTTP 请求；只接纳 ZIP 原始解析，无旧 JSON/ParserResult 回退。
- [archive.ts](archive.ts)：输出归档到中性文档材料的转换；使用 Parsing 共用资源规则，支持行内/引用式图片与 HTML 资源，忽略代码和注释中的示例。
- [content-list.ts](content-list.ts)：按固定的 3.4.4 v2 协议映射中性区块，拒绝未知类型；原始 v2 留作追查证据。
- [loopback.ts](loopback.ts)：真实本机网络适配器，复用远端任务协议与 Network 调度；不是 fake 服务。
- [health.ts](health.ts)：健康与版本检查。

## 放置边界

MinerU 服务部署和模型文件不在本目录；真实解析输入、服务日志与测试产物放本机 sandbox。

[上级目录](../README.md)
