# OpenCitations REST adapter

日期：2026-09-11。

`apps/server/src/metadata/opencitations.ts` 将 OpenCitations Meta v1 的 DOI 元数据和 Index v2 的引用边转换为中性 `MetadataObservation` 与逐边 `ProviderRelationObservation`。请求通过 `MetadataTransport` 进入共享 Network 边界，origin 只接受 HTTPS；响应记录、OCI 关系身份、DOI 端点和输入 hash 在转换时校验，provider record identity 只写入 provenance 或 relation endpoint，不伪装成跨 provider identifier。

OpenCitations 当前明确支持 lookup 和 references 方向的 relation query；cited-by 能力显式返回 unsupported。空响应形成 exhausted 结果，缺少 DOI/OCI/关系端点的记录形成保留原因的 provider failure，不把 vendor 原始值放入失败结果。

直接证据：`apps/server/test/metadata-opencitations.test.ts` 覆盖 Meta lookup 字段和 URL、references relation 与 relation provenance、cited-by unsupported、空响应和坏关系；`pnpm exec vitest run apps/server/test/metadata-opencitations.test.ts` 通过，随后 `pnpm quick` 通过。
