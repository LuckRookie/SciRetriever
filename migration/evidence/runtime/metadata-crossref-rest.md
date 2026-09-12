# TypeScript Crossref REST adapter

日期：2026-09-11。

`apps/server/src/metadata/crossref.ts` 将 Crossref 的 topic search 和 DOI lookup 接入 Metadata port。适配器在边界内处理 Crossref `work-list`/`work` envelope、cursor、年份 filter、mailto、分页无进展和错误响应；`parseCrossrefRecord` 将 vendor record 转换为 `MetadataObservation`，raw JSON 不离开 adapter session。观察和 provenance ID、观测时间由组装入口提供，网络请求仍由注入的 `MetadataTransport` 承担。

直接证据：

- `apps/server/test/metadata-crossref.test.ts` 覆盖双页 topic search、scan limit 兼容、年份过滤、mailto、DOI lookup、响应 envelope 拒绝和分页 cursor；
- `pnpm exec vitest run apps/server/test/metadata-crossref.test.ts`：2 tests passed；
- `pnpm quick`：Prettier、ESLint、源码和测试 strict 类型检查通过。

当前边界：Crossref reference-query 能力未宣称，真实生产组装仍需在 Application 中注入受控 Network transport；其余十个 provider 仍需逐项迁移。
