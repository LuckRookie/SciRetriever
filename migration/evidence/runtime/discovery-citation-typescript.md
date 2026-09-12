# Citation Discovery TypeScript slice

日期：2026-09-11。

`CitationDiscoveryService` 在 `apps/server/src/entry/discovery.ts` 中实现有界 breadth-first 引用扩展：按 seed Literature 的稳定 identifier 调用 provider reference capability，逐边保存 `ProviderRelationObservation`；目标优先本地精确命中，未命中时通过同一 provider lookup 和 Identity owner 接纳。成功目标按 source→target 方向发布唯一 `Reference`，并用 relation observation 建立 `ProviderRelationSupport`；重复边和自引用被跳过，`max_depth` 与 `result_limit` 固定本次运行边界。

Discovery 结束时由 `SqliteWorker.putDiscovery` 持久化 citation input、seed、provider outcome、MetaLiterature result 和 direct cause。取消保留已经保存的来源事实并将 run 标记为 `INTERRUPTED`；provider 失败只影响该 source result。

直接证据：`apps/server/test/discovery-citation.test.ts` 使用真实 TS Application、SQLite worker、Identity owner、Reference repository 和 fake relation/lookup provider，验证一跳 references 的目标接纳、Reference/support、cause 与 durable run；测试通过，随后 `pnpm quick` 通过。citation 的多来源完整差分、六类 selector 和服务 CLI 仍待后续 T040/T044。
