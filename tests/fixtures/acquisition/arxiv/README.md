# arXiv 合成样本

arXiv 的合成获取输入，用于回归候选定位、响应类型或页面/访问 profile 合同。

## 内容入口

- [doctype.xml](doctype.xml)：含 DOCTYPE 的 XML 输入。
- [malformed.xml](malformed.xml)：损坏或不符合协议的输入。
- [mismatch.xml](mismatch.xml)：标识符不一致候选。
- [success.xml](success.xml)：协议成功形状。
- [unsafe-link.xml](unsafe-link.xml)：不安全链接候选。
- [zero.xml](zero.xml)：无候选响应。

## 放置边界

本目录不记录真实服务的当次返回或成功率；新增样本应验证重要用户结果，不复制真实凭据与正文。

相关说明：[消费这些输入的回归测试](../../../../apps/server/test/README.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
