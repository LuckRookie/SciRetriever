# CORE、Springer、Elsevier 与 Web of Science REST adapters

日期：2026-09-11。

本轮在 `apps/server/src/metadata/` 增加四个 provider-neutral 适配器：

- `core.ts` 对应 CORE v3 Works search、Work/Output lookup，并把稳定的 `references` 目标转换为逐边 `ProviderRelationObservation`；CORE record ID 保留在 `work:`/`output:` provenance 和 relation key 中。
- `springer.ts` 对应 Springer Nature Meta API v2 的 `q/s/p` 分页与 DOI lookup，API key 只通过 transport header 传递，provider 返回的带凭据 URL 会被丢弃。
- `elsevier.ts` 对应 Scopus Search 的 cursor envelope 与 Abstract Retrieval DOI/EID/PMID lookup，API key 和 institution token 只进入受控 header。
- `web-of-science.ts` 对应 Web of Science Starter v2 的 page/limit、WOS UID、DOI/PMID lookup 和 citation count；同时保留 Expanded envelope 的显式解析入口，Expanded citation pagination 尚未关闭。

四个 adapter 都通过 `MetadataTransport` 进入共享 Network 边界，将 vendor 记录转换为 `MetadataObservation`，保留输入 hash、provenance 和安全资产线索；原始 vendor payload 不穿过 adapter。

直接证据：`apps/server/test/metadata-commercial.test.ts` 覆盖 CORE references、Springer 安全 URL、Elsevier 凭据 header 和 Web of Science Starter 字段转换；该测试通过，随后 `pnpm quick` 通过。剩余差距是四个 provider 的生产 AccessCoordinator 组装、Web of Science Expanded 完整差分、Elsevier/CORE citation 查询和 DiscoveryRun 接入。
