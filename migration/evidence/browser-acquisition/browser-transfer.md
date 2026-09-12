# Browser Transfer 直接验证

`BrowserTransferCollector` 将事件写入 FileStore staging，只有完整写入并 flush/handoff 后才生成 `durable-ready` Candidate。页面生命周期不参与 Candidate 状态；重复 complete 返回同一 Candidate；空字节和超限输入不会生成 durable-ready。

命令：`pnpm exec vitest run apps/server/test/browser-transfer.test.ts --reporter=verbose`；结果：2 tests passed。

后续[真实工作台会话](workbench-session-api.md)已接入 Playwright download/response dispatcher、页面关闭、
迟到事件处理和跨文章归属检查，[Candidate 回收](../runtime/candidate-abandonment.md)覆盖 durable 放弃；首阶段
collector 边界已经闭环。Range/Service Worker/WebSocket 等未启用通道继续拒绝或保持 Deferred。
