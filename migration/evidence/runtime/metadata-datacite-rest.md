# TypeScript DataCite REST adapter

日期：2026-09-11。

`apps/server/src/metadata/datacite.ts` 将 DataCite JSON:API 的 DOI search/lookup、`links.next` 分页、页大小和 creator/title/container/description/subject 字段转换到中性 `MetadataObservation`。适配器校验 HTTPS origin、分页前进和公开 URL，raw JSON 只在 adapter session 内用于输入 hash；请求由注入的 `MetadataTransport` 承担。

直接证据：

- `apps/server/test/metadata-datacite.test.ts` 覆盖双页 JSON:API search、next link、DOI lookup、标题/作者/摘要/页码转换；
- `pnpm exec vitest run apps/server/test/metadata-datacite.test.ts`：1 test passed；
- `pnpm quick`：Prettier、ESLint、源码和测试 strict 类型检查通过。

当前边界：DataCite citation/reference-query、凭据（当前公共端点不需要）、Application 的具体 provider 组装和 Discovery 接入仍待完成。
