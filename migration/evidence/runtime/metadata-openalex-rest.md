# TypeScript OpenAlex REST adapter

日期：2026-09-11。

`apps/server/src/metadata/openalex.ts` 将 OpenAlex works search/lookup、`meta.next_cursor` 分页、作者/DOI/venue/bibliography/OA PDF 字段转换到中性 Metadata 合同。OpenAlex cursor 作为 adapter 内部状态继续请求，`open_access` URL 经过公开 URL 校验；raw provider record 只用于 adapter 内部输入 hash。

直接证据：

- `apps/server/test/metadata-openalex.test.ts` 覆盖双页 works、cursor token、DOI lookup、字段和 PDF hint 转换；
- `pnpm exec vitest run apps/server/test/metadata-openalex.test.ts`：1 test passed；
- `pnpm quick`：Prettier、ESLint、源码和测试 strict 类型检查通过。

当前边界：OpenAlex citation/reference-query、配置凭据和 Application 具体 Network 组装仍待完成。
