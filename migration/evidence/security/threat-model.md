# TS 工作台威胁模型与离线验证

更新时间：2026-09-12。默认参与者是单机 operator、同机未授权进程、恶意网页、失控模型和被中断的旧进程。以下边界在代码/API 层执行，测试不使用真实凭据或外网。

| 威胁 | 防护/证据 |
| --- | --- |
| 网页 SSRF、DNS rebinding、私网/loopback 绕过 | Network policy 对 scheme、解析地址、端口、redirect 和连接目标绑定；`network-resolution-policy.test.ts`、`network-admission.test.ts` |
| 远端页面调用控制面 | Workbench 校验 loopback socket、Host、Origin、SameSite/Cookie、per-tab grant 和 CSRF；`workbench-http.test.ts` |
| 模型获得任意浏览器/文件/命令能力 | Agent 只有 navigate/click/fill/press/select/scroll 六种封闭动作；人工输入独立于模型；`browser-control.test.ts`、`agent-runtime.test.ts` |
| 大 body、长响应、慢 SSE 消耗内存 | HTTP body 64 KiB、Network response/Parser/Artifact 上限、SSE `writableNeedDrain` 丢弃旧投影；`network-http-framing.test.ts`、`workbench-http.test.ts` |
| 凭据泄露到日志/事件/前端 | Credential grant 按 provider/origin 绑定；日志和 view 只保留 presence/readiness；`logging-redaction.test.ts`、`credential-origin.test.ts` |
| 旧 lease 或迟到 Agent 写入 | bootId/control epoch、SQLite lease fencing、AbortSignal；`execution-recovery.test.ts`、`workbench-session.test.ts` |
| Partial PDF、重复 Candidate 或覆盖正式资产 | 仅接收完整 HTTP 200 PDF；206 明确失败；Candidate hash、receipt、create-if-absent 和 verified reader；`browser-transfer.test.ts`、`candidate-publication.test.ts` |

未覆盖边界：真实站点反制策略、第三方 Cloak binary 的供应链审查和生产用户数据切换，均保持 `not-authorized/not-run`。
