# TypeScript arXiv Metadata adapter

日期：2026-09-11。

`apps/server/src/metadata/arxiv.ts` 将 arXiv Atom API 的 topic search 和 identifier lookup 接入 Metadata port。adapter 使用受限 entry/tag/link 解析，保留 arXiv preprint 版本、DOI、作者、日期、摘要和 PDF hint；`start/max_results` 分页和无结果终止由 session 管理，原始 XML 不越过 provider 边界。

直接证据：

- `apps/server/test/metadata-arxiv.test.ts` 覆盖 Atom entry、实体解码、preprint/DOI/PDF 转换和 start 分页；
- `pnpm exec vitest run apps/server/test/metadata-arxiv.test.ts`：1 test passed；
- `pnpm quick`：Prettier、ESLint、源码和测试 strict 类型检查通过。

当前边界：arXiv citation/reference-query、Application Network 组装和 Discovery 接入仍待完成。
