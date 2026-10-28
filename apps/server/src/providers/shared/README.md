# 供应商共享协议帮助

保存多家供应商共同使用的元数据传输、字段整理与候选响应帮助。

## 内容入口

- [metadata-transport.ts](metadata-transport.ts)：共享元数据传输。
- [metadata-values.ts](metadata-values.ts)：可选展示字段的通用整理。
- [metadata-record.ts](metadata-record.ts)：中性记录构造帮助。
- [authorized-pdf.ts](authorized-pdf.ts)：授权 PDF 响应合同。
- [acquisition-locators.ts](acquisition-locators.ts)：候选地址通用处理。

## 放置边界

只有跨供应商确实相同的逻辑放这里；专有响应层级、URL 和认证规则仍留在对应供应商目录。

[上级目录](../README.md)

`source-problem.ts` 将已知来源错误投影为三种可处理状态或 error，仅从稳定码和明确的认证/全文权限证据形成技术诊断，不复制供应商消息、URL 或响应。
