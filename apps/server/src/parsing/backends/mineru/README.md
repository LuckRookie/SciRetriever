# MinerU 服务适配

连接 operator 管理的 MinerU 服务，执行健康检查、提交、轮询和归档转换。

## 内容入口

- [profile.ts](profile.ts)：锁定的协议与解析 profile。
- [protocol.ts](protocol.ts)：服务协议字段与响应转换。
- [http.ts](http.ts)：HTTP 请求与任务执行。
- [archive.ts](archive.ts)：输出归档到中性文档材料的转换。
- [health.ts](health.ts)：健康与版本检查。

## 放置边界

MinerU 服务部署和模型文件不在本目录；真实解析输入、服务日志与测试产物放本机 sandbox。

相关说明：[外部 MinerU 兼容说明](../../../../../../docs/notes/mineru.md)。

[上级目录](../README.md) · [项目 README](../../../../../../README.md)
