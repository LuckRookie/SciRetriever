# TypeScript Semantic Scholar REST adapter

日期：2026-09-11。

`apps/server/src/metadata/semantic-scholar.ts` 将 Semantic Scholar `paper/search` offset 分页和单篇 lookup 接入 Metadata port。适配器在 provider 边界内解析 external IDs、作者、摘要、venue、citation count 和 OA PDF；可选 API key 只通过受控 header 传给注入的 `MetadataTransport`，不会进入 observation、failure 或日志。

直接证据：

- `apps/server/test/metadata-semantic-scholar.test.ts` 覆盖 offset/next 分页、lookup、externalIds、OA PDF 和 secret 不回显；
- `pnpm exec vitest run apps/server/test/metadata-semantic-scholar.test.ts`：1 test passed；
- `pnpm quick`：Prettier、ESLint、源码和测试 strict 类型检查通过。

当前边界：Semantic Scholar citation/reference-query、配置 credential grant 和 Application 的 provider Network 组装仍待完成。
