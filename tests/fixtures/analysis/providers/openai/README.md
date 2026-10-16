# OpenAI 合成样本

OpenAI 的合成模型响应，用于回归成功、拒绝、截断和未知协议分支。

## 内容入口

- [refusal.json](refusal.json)：模型拒绝响应。
- [success.json](success.json)：协议成功形状。
- [truncated.json](truncated.json)：截断响应。
- [unknown-shape.json](unknown-shape.json)：未知响应形状。

## 放置边界

本目录不记录真实服务的当次返回或成功率；新增样本应验证重要用户结果，不复制真实凭据与正文。

相关说明：[消费这些输入的回归测试](../../../../../apps/server/test/README.md)。

[上级目录](../README.md) · [项目 README](../../../../../README.md)
