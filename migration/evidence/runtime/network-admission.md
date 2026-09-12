# NETWORK-ADMISSION 执行与审查记录

状态：`Completed`。本文件记录当前工作树的直接测试和汇合验收。

## 已有实现与测试

apps/server/src/network/policy.ts、connection.ts、http.ts；network-admission.test.ts 有 8 项通过。

本轮直接测试：`pnpm exec vitest run apps/server/test/network-admission.test.ts --passWithNoTests=false`，8 tests passed。
本轮还通过了 Network budget 的 11 tests，包含显式 retry loop 与零 redirect budget。

## 验收结果

| 边界 | finding 与关闭条件 |
| --- | --- |
| URL/DNS | 已由独立 policy 测试和入口测试覆盖 userinfo、编码/遍历、混合答案、rebind 与 loopback admission。 |
| TLS | loopback TLS 正例通过；错误 hostname 的证书校验失败且应用层请求计数保持为零。 |
| redirect credential | 真实逐跳 HTTP 测试确认跨 origin 不转发 Authorization；下一跳重新解析并在 socket 前拒绝不允许地址。 |
| 响应 framing | Content-Length 截断、超限和合法 body 均有直接测试，失败后 permit 可再次取得。 |

## 恢复与范围

当前串行恢复点为 `FILE-STAGE-WRITE`，以活动计划根 README 和对应 Task 为准。
测试只使用 fake DNS、合成字节、loopback 和系统临时目录；未读取真实凭据/用户数据或访问真实外部服务。
