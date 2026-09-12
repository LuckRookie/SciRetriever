# Browser lifecycle / negative / reconnect 矩阵

2026-09-10。当前第一阶段的生命周期边界由以下直接测试形成矩阵：

| 场景 | 直接证据 | 结果 |
| --- | --- | --- |
| Profile lock / 第二 Host | `browser-host.test.ts` | 第二 Host 在 Browser action 前以 `profile-lock` 失败，首 Host 仍可关闭并重开 |
| 多标签页 / opener / boot | `browser-complex-capture.test.ts`、`browser-host.test.ts` | 同一 Host 保留 popup 与原页，`listPages`/`activatePage` 只切换活动页；每次 Host 启动生成新的 `boot_id` |
| page close / snapshot after close | `browser-host.test.ts` | 页面关闭后 snapshot 被拒绝，Host 可幂等关闭 |
| 非法 URL、凭据、fragment、file scheme | `browser-host.test.ts`、`browser-control.test.ts` | Browser/Network 前置拒绝，执行回调为零 |
| 旧 Observation、旧 document generation、旧 viewport、旧 epoch | `workbench-session.test.ts`、`browser-control.test.ts` | 返回 stale/权限错误，底层 Browser 不执行 |
| takeover、pause、cancel 中的迟到 Agent | `workbench-session.test.ts` | AbortSignal/epoch 失效，迟到结果零执行 |
| HTTP Host/Origin/cookie/CSRF/未知字段/标签 API | `workbench-http.test.ts` | 403/409/400，secret 不进入 view，`/api/tabs` 与激活仍受同一 grant/CSRF 保护 |
| SSE 初次连接、客户端断开、重新连接 | `workbench-http.test.ts` | 两次连接都收到当前 view；断线不销毁 Browser |
| 390px、焦点、Candidate abandon、跨重启 | `apps/web/test/live-workbench.test.ts` | 真实 Cloak 双 viewer 通过；移动详情抽屉无横向溢出 |

WorkBench HTTP 的 SSE 投影只保存当前 view，`writableNeedDrain` 时不排队旧帧；大规模慢客户端压力基准尚未
作为产品支持声明。page crash、宿主进程被 SIGKILL 后的跨进程 Browser 重建也不在首阶段对象图内；持久
Candidate/receipt 和 recovery manifest 可恢复，Browser 本身需要用户重新打开工作台。
