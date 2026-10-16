# OpenCitations 合成样本

OpenCitations 的合成元数据响应，用于回归字段转换、分页/引用和异常处理。

## 内容入口

- [citations.json](citations.json)：引用关系响应。
- [count-only.json](count-only.json)：只有数量的响应。
- [lookup-year-only.json](lookup-year-only.json)：日期只提供年份的记录。
- [lookup.json](lookup.json)：单条查询响应。
- [malformed.json](malformed.json)：损坏或不符合协议的输入。
- [references.json](references.json)：参考文献关系响应。
- [unknown-prefix.json](unknown-prefix.json)：未知标识符前缀。
- [unsupported-endpoint.json](unsupported-endpoint.json)：不支持的端点响应。
- [zero-results.json](zero-results.json)：零结果响应。

## 放置边界

本目录不记录真实服务的当次返回或成功率；新增样本应验证重要用户结果，不复制真实凭据与正文。

相关说明：[消费这些输入的回归测试](../../../../apps/server/test/README.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
