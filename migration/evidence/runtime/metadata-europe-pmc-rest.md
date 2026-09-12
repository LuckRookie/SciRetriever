# TypeScript Europe PMC REST adapter

日期：2026-09-11。

`apps/server/src/metadata/europe-pmc.ts` 将 Europe PMC JSON search/lookup 接入 Metadata port。适配器在边界内解析 `resultList.result`、`nextCursorMark`、年份/页大小、author、identifier、abstract、引用计数和 PDF full-text hint，按原始 record 计算输入摘要并生成 provider provenance；请求和 cursor 只留在 session 内。

直接证据：

- `apps/server/test/metadata-europe-pmc.test.ts` 覆盖双页 topic search、cursor、lookup、字段转换和 PDF hint；
- `pnpm exec vitest run apps/server/test/metadata-europe-pmc.test.ts`：1 test passed；
- `pnpm quick`：Prettier、ESLint、源码和测试 strict 类型检查通过。

当前边界：Europe PMC citation/reference-query、Application 中共享 Network/AccessCoordinator 组装和其它 provider 仍待迁移。
