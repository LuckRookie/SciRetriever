# 性能、背压与资源基线

更新时间：2026-09-12。当前目标是有界和可取消，不对未测量的吞吐作提升声明。所有数字来自实现合同和离线测试上限。

| 路径 | 上限/策略 | 直接验证 |
| --- | --- | --- |
| Workbench JSON body | 64 KiB，超限返回 command-rejected | `workbench-http.test.ts` |
| Network response | 每请求显式 `maxResponseBytes`，超过即释放 permit 并失败 | `network-http-framing.test.ts`、`network-body-limits.test.ts` |
| Browser Candidate | 默认 64 MiB，staging 写入和 hash 校验；取消会销毁 stream | `browser-transfer.test.ts`、`browser-candidate-journey.test.ts` |
| Parser archive/PDF | archive 64 MiB、单项资源/页数/输入受限，AbortSignal 可终止 | `mineru-parser.test.ts`、`parsing-service.test.ts` |
| Selector/targets | selector JSON 64 KiB；单 job targets 不超过 10,000；runUntilIdle 同样有界 | `execution-queue.test.ts`、`persistent-service-journey.test.ts` |
| SSE/画面 | 最多 16 个 stream；客户端背压时不排队旧 view/frame | `workbench-http.test.ts`、`browser-lifecycle-matrix.md` |
| SQLite/队列 | Worker 单写、lease 单 workspace、每次只 claim 一个 target；重试和预算持久化 | `execution-queue.test.ts`、`execution-recovery.test.ts` |

后续若要发布吞吐、延迟或并发数字，应在同一 Linux x64 支持环境加入固定 fixture 和采样脚本；当前不把 synthetic loopback 时间外推到真实 Provider 或浏览器站点。
