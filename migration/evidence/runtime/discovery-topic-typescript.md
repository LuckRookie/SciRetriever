# Topic Discovery TypeScript slice

日期：2026-09-11。

`apps/server/src/entry/discovery.ts` 提供有界 topic Discovery 编排：每个 provider 独立消费 `MetadataService` 的 scan limit，保留 provider outcome/failure；成功 observation 复用 `LiteratureIdentityService` 形成或命中 Literature，逐条 provider relation 先保存为来源事实；accepted observation 才形成去重的 MetaLiterature result 和 topic cause。

`SqliteWorker.putDiscovery/getDiscovery` 将 run、topic input、provider limits/source results、results 和 causes 写入已有 v1 discovery 表，使用短事务和现有 cause closure trigger，支持重复写入幂等。取消保留已完成 provider 事实并将 run 标记为 `INTERRUPTED`；全失败标记为 `FAILED`，部分 provider 失败标记为 `PARTIAL`。

直接证据：`apps/server/test/discovery-topic.test.ts` 使用真实 TS Application、SQLite worker、Identity owner 与 fake provider，验证 Literature 接纳、持久 run/source/result/cause 和 snapshot count；`apps/server/test/discovery-citation.test.ts` 验证一跳关系解析、Reference/ProviderRelationSupport 和 citation cause；两组测试通过，随后 `pnpm quick` 通过。六类 selector 和完整 CLI 编排仍属于 T040 后续工作。
