# arXiv 合成样本

arXiv 的合成元数据响应，用于回归字段转换、分页/引用和异常处理。

## 内容入口

- [lookup.xml](lookup.xml)：单条查询响应。
- [search-page-1.xml](search-page-1.xml)：搜索分页响应。
- [search-page-2.xml](search-page-2.xml)：搜索分页响应。
- [truncated.xml](truncated.xml)：截断响应。
- [zero-results.xml](zero-results.xml)：零结果响应。

## 放置边界

本目录不记录真实服务的当次返回或成功率；新增样本应验证重要用户结果，不复制真实凭据与正文。

相关说明：[消费这些输入的回归测试](../../../../apps/server/test/README.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
