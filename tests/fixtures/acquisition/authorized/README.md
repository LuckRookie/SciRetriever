# 授权 API 合成样本

授权 API 的合成获取输入，用于回归候选定位、响应类型或页面/访问 profile 合同。

## 内容入口

- [ambiguous.json](ambiguous.json)：存在歧义的响应。
- [jats-only.json](jats-only.json)：仅 JATS 内容的响应。
- [no-primary.json](no-primary.json)：缺少主 PDF 的响应。
- [schema-invalid.json](schema-invalid.json)：不符合预期结构的响应。
- [success.json](success.json)：协议成功形状。
- [xml-only.json](xml-only.json)：仅 XML 内容的响应。

## 放置边界

本目录不记录真实服务的当次返回或成功率；新增样本应验证重要用户结果，不复制真实凭据与正文。

相关说明：[消费这些输入的回归测试](../../../../apps/server/test/README.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
