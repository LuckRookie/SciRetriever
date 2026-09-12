# Browser 捕获矩阵

更新时间：2026-09-12。矩阵只使用本地 synthetic fixture；没有访问真实站点、Provider 或用户 Profile。

| 机制 | 当前行为 | 证据/限制 |
| --- | --- | --- |
| Playwright download 事件 | 先由 `prepareDownload` 绑定页面、代次和 URL，再把完整 stream 写入 Candidate spool；页面关闭不影响已落盘字节 | `apps/server/test/browser-candidate-journey.test.ts`、`browser-transfer.test.ts` |
| PDF response（HTTP 200） | 仅接受 `application/pdf` 且状态为 200；响应 body 完整读入后进入同一 Candidate intake | `apps/server/test/browser-candidate-journey.test.ts` |
| attachment/octet-stream response | 不从 response body 抢读，等待 Playwright download 事件，避免重复或半截文件 | `apps/server/src/browser/transfers.ts` |
| HTTP 206 Range | 明确拒绝并记录 transfer failure；绝不把 partial body 标记为 Candidate | `apps/server/src/browser/transfers.ts`、`apps/server/test/browser-candidate-journey.test.ts`；Range 重组仍 Deferred |
| blob/data URL | 仅接受由当前页面人工下载动作触发的 blob/data 下载；Candidate source 绑定到所属 HTTP 页面，不向外部 HTTP 客户端重取 blob | `apps/server/src/browser/host.ts`、`transfers.ts`、`apps/server/test/browser-complex-capture.test.ts` |
| iframe/frame | 请求沿用所属主页面的 page/session/document generation 归属；不保存 iframe 壳 HTML | `apps/server/src/browser/host.ts`、`apps/server/test/browser-complex-capture.test.ts` |
| popup/new page | Context 级 page registry 记录 opener；首个无 frame 导航仅允许 active page 同源 URL，后续下载按 popup page 归属并补做 Network admission | `apps/server/src/browser/host.ts`、`apps/server/test/browser-complex-capture.test.ts` |
| viewer 内部重写/分片 | 不执行全页重写或任意 JS 读取；没有完整、可归属的 200 PDF 时保持 Deferred | `apps/server/src/browser/host.ts`、`transfers.ts` |
| 超限/取消/断线 | spool 有 64 MiB 默认上限和 AbortSignal；失败不会产生 durable-ready 记录 | `apps/server/test/browser-transfer.test.ts`、`browser-lifecycle-matrix.md` |

当前 T027 的完成边界是“download/response/blob/data/frame/popup 路径有归属和不误收保证，Range 明确失败，复杂 viewer 保持 Deferred”；复杂 viewer 和跨版本真实 Range 兼容性不能以 skipped 测试冒充支持。`browser-complex-capture.test.ts` 使用同一 loopback fixture 验证三种复杂下载和 popup 首次下载。
