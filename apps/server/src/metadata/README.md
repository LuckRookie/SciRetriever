# 中性元数据服务

定义元数据能力接口，组装供应商，执行查询与来源 observation 处理。

## 内容入口

- [ports.ts](ports.ts)：搜索、查询和引用能力的端口。
- [service.ts](service.ts)：中性元数据服务。
- [assembly.ts](assembly.ts)：供应商能力组装。
- [registry.ts](registry.ts)：元数据能力注册。

## 放置边界

各厂商响应与 URL 规则在 providers/<provider>/；文献身份与合并由 literature 决定；主题/种子任务编排在 entry。

来源限流的扫描结果可携带响应头声明的 `retry_after_ms`。引用任务在调用范围内接管 429 的重试，所有供应商请求继续使用共享 Network 准入。

[上级目录](../README.md)
