# TypeScript 分层 Acquisition 混合批次证据

日期：2026-09-12。

`apps/server/src/acquisition/tiered.ts` 将来源 discovery、候选下载、失败分类和策略处置组合成一个有界的
TypeScript batch owner。它按配置顺序逐来源运行，不竞速来源，也不把失败猜测为未订阅：

- source discovery 异常记录 `source-discovery-failed`，并进入有界 cooldown；
- 候选下载或 PDF 接纳异常记录 `candidate-download-failed`，继续尝试同源的下一个候选；
- 没有候选且没有技术错误才返回 `exhausted`；
- `never` 返回技术失败，`notify` 返回 advisory `skipped`，`pause` 返回 `interrupted`，三者都不改变 Literature
  current facts；
- 每个目标和来源都有最大数量，取消会返回 `execution-cancelled`，后续目标不会被偷偷执行；
- 成功只返回来源候选，实际 Candidate 落盘、身份验收和 primary-pdf 发布仍调用既有共享门（见
  `candidate-publication.md`、`candidate-acceptance.md`）。

直接测试：

```text
pnpm exec vitest run apps/server/test/tiered-acquisition.test.ts
```

结果：3 tests passed；另外 `browser-transfer.test.ts` 的慢流取消用例通过，证明在分片尚未结束时取消不会
发布部分 Candidate。测试覆盖混合成功/耗尽/来源错误、never/notify/pause、慢流取消和批次取消边界；未访问
真实 Provider 或站点。该证据关闭 T029、T034、T035 的离线混合批次部分，并为 T036 的完整自动获取旅程提供
分层编排基础。真实站点成功率仍属于 T059，保持 `not-authorized/not-run`。
