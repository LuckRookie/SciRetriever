# 共享网络访问

执行 HTTP 与浏览器访问的统一连接、URL/地址检查、额度、冷却、重试和取消规则。

## 内容入口

- [http.ts](http.ts)：受控 HTTP 传输。
- [policy.ts](policy.ts)：网络访问策略。
- [budget.ts](budget.ts)：共享访问额度。
- [browser-admission.ts](browser-admission.ts)：浏览器请求准入。
- [browser-platform.ts](browser-platform.ts)：平台访问调度。

## 放置边界

供应商静态 URL、能力和默认间隔在 providers 的 definition；本目录执行共享政策，不判断文章身份或修改文献事实。

相关说明：[所属技术文档](../../../../docs/architecture/technical/02-task-coordination.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
