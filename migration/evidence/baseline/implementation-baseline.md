# TypeScript 全量实施基线

更新时间：2026-09-12。该基线来自当前工作树和原始 M0 任务包，所有探针使用临时目录、合成数据和 loopback fixture。

| 项目 | 当前选择/结果 |
| --- | --- |
| 运行时 | Node 22.19.0、pnpm 10.32.1、strict TypeScript 5.9；contracts/server/web 由 project references 构建 |
| Browser | Playwright 1.55.0 + operator CloakBrowser 0.5.8 wrapper / 146.0.7680.177.5 binary；Linux x64；不使用 stock Chromium fallback |
| Storage | Node `node:sqlite` Worker、v1 fingerprint 与显式 v2 execution schema；FileStore 使用临时 staging、hash、no-clobber 和单 writer lock |
| Network | URL/DNS/IP/redirect/Origin/credential 均在 Network owner 判定；Browser 使用 DNS-pinned CONNECT；测试只允许 loopback/public fixture |
| PDF/Parser | TS PDF acceptance 调用受限系统 reader；MinerU loopback/remote 协议、ZIP 资源闭包和 ParserResult publication 全由 TS 实现 |
| 任务 | SQLite jobs/targets/attempts/events/policy/budget/intervention/lease；ExecutionTaskService 是唯一 durable target 执行入口 |
| 外部边界 | 真实站点、Provider、MinerU、LLM、用户 Catalog/Profile/凭据没有授权，不进入默认 CI 或证据 |

关键直接验证：`pnpm quick`、`pnpm full`、`apps/server/test/persistent-service-journey.test.ts`、`apps/server/test/portable-package.test.ts` 和 Browser loopback journey。Python Harness 仅保留为历史维护入口，后续不作为 TS 交付门禁。
