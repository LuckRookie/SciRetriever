# Unpaywall 合成样本

Unpaywall 的合成获取输入，用于回归候选定位、响应类型或页面/访问 profile 合同。

## 内容入口

- [malformed.json](malformed.json)：损坏或不符合协议的输入。
- [merged-semantics.json](merged-semantics.json)：候选位置组合场景。
- [mismatch.json](mismatch.json)：标识符不一致候选。
- [no-location.json](no-location.json)：缺少候选位置的响应。
- [no-oa.json](no-oa.json)：未提供 OA 的响应。
- [ordered.json](ordered.json)：候选或记录顺序场景。
- [unsafe.json](unsafe.json)：不安全候选。

## 放置边界

本目录不记录真实服务的当次返回或成功率；新增样本应验证重要用户结果，不复制真实凭据与正文。

相关说明：[消费这些输入的回归测试](../../../../apps/server/test/README.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
