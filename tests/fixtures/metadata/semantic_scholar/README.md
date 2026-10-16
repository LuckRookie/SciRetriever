# Semantic Scholar 合成样本

Semantic Scholar 的合成元数据响应，用于回归字段转换、分页/引用和异常处理。

## 内容入口

- [citations.json](citations.json)：引用关系响应。
- [lookup.json](lookup.json)：单条查询响应。
- [malformed.json](malformed.json)：损坏或不符合协议的输入。
- [references-page-1.json](references-page-1.json)：参考文献分页响应。
- [references-page-2.json](references-page-2.json)：参考文献分页响应。
- [search-page-1.json](search-page-1.json)：搜索分页响应。
- [search-page-2.json](search-page-2.json)：搜索分页响应。
- [zero-results.json](zero-results.json)：零结果响应。

## 放置边界

本目录不记录真实服务的当次返回或成功率；新增样本应验证重要用户结果，不复制真实凭据与正文。

相关说明：[消费这些输入的回归测试](../../../../apps/server/test/README.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
