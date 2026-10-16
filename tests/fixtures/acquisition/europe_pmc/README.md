# Europe PMC 合成样本

Europe PMC 的合成获取输入，用于回归候选定位、响应类型或页面/访问 profile 合同。

## 内容入口

- [flags-only.json](flags-only.json)：仅有可用性标记的响应。
- [malformed.json](malformed.json)：损坏或不符合协议的输入。
- [mismatch.json](mismatch.json)：标识符不一致候选。
- [success.json](success.json)：协议成功形状。
- [unsafe.json](unsafe.json)：不安全候选。
- [zero.json](zero.json)：无候选响应。

## 放置边界

本目录不记录真实服务的当次返回或成功率；新增样本应验证重要用户结果，不复制真实凭据与正文。

相关说明：[消费这些输入的回归测试](../../../../apps/server/test/README.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
