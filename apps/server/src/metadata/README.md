# 中性元数据服务

定义元数据能力接口，组装供应商，执行查询与来源 observation 处理。

## 内容入口

- [ports.ts](ports.ts)：搜索、查询和引用能力的端口。
- [service.ts](service.ts)：中性元数据服务。
- [assembly.ts](assembly.ts)：供应商能力组装。
- [registry.ts](registry.ts)：元数据能力注册。

## 放置边界

各厂商响应与 URL 规则在 providers/<provider>/；文献身份与合并由 literature 决定；主题/种子任务编排在 entry。

[上级目录](../README.md)
