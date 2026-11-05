# 共享网络访问

执行 HTTP 与浏览器访问的统一连接、URL/地址检查、额度、冷却、重试和取消规则。

## 内容入口

- [http.ts](http.ts)：受控 HTTP 传输。
- [request-activity.ts](request-activity.ts)：隔离并发请求的无参数派发通知，不携带 URL、凭据或响应。
- [egress.ts](egress.ts)、[proxy-tunnel.ts](proxy-tunnel.ts)：进程内出口 capability、显式 HTTP CONNECT 与脱敏失败。
- [policy.ts](policy.ts)：网络访问策略。
- [budget.ts](budget.ts)：共享访问额度。
- [browser-admission.ts](browser-admission.ts)：浏览器请求准入。
- [browser-platform.ts](browser-platform.ts)：平台访问调度。

## 放置边界

供应商静态 URL、能力和默认间隔在 providers 的 definition；本目录执行共享政策，不判断文章身份或修改文献事实。

[上级目录](../README.md)
