# Web of Science 合成样本

Web of Science 的合成元数据响应，用于回归字段转换、分页/引用和异常处理。

## 内容入口

- [expanded-citing.json](expanded-citing.json)：对应 WoS 产品的查询/关系响应。
- [expanded-lookup.json](expanded-lookup.json)：对应 WoS 产品的查询/关系响应。
- [expanded-malformed.json](expanded-malformed.json)：对应 WoS 产品的查询/关系响应。
- [expanded-references-page-1.json](expanded-references-page-1.json)：参考文献分页响应。
- [expanded-references-page-2.json](expanded-references-page-2.json)：参考文献分页响应。
- [expanded-search-page-1.json](expanded-search-page-1.json)：搜索分页响应。
- [expanded-search-page-2.json](expanded-search-page-2.json)：搜索分页响应。
- [expanded-zero.json](expanded-zero.json)：对应 WoS 产品的查询/关系响应。
- [starter-lookup-search.json](starter-lookup-search.json)：对应 WoS 产品的查询/关系响应。
- [starter-lookup.json](starter-lookup.json)：对应 WoS 产品的查询/关系响应。
- [starter-malformed.json](starter-malformed.json)：对应 WoS 产品的查询/关系响应。
- [starter-search-page-1.json](starter-search-page-1.json)：搜索分页响应。
- [starter-search-page-2.json](starter-search-page-2.json)：搜索分页响应。
- [starter-zero.json](starter-zero.json)：对应 WoS 产品的查询/关系响应。

## 放置边界

本目录不记录真实服务的当次返回或成功率；新增样本应验证重要用户结果，不复制真实凭据与正文。

相关说明：[消费这些输入的回归测试](../../../../apps/server/test/README.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
