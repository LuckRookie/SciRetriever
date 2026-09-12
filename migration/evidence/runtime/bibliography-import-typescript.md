# TypeScript bibliography import codecs

日期：2026-09-11。

`apps/server/src/entry/bibliography.ts` 已把 BibTeX/BibLaTeX、RIS 和 CSL-JSON 的离线解码迁入 TS。解码器对输入字节设置上限，拒绝无效 UTF-8 和不平衡 BibTeX，按记录返回 `decoded` 或 `rejected`，成功记录统一转换为 `MetadataObservation`，使用 `user/bibliographic-import` provenance，不修改用户原文件。`importBibliography` 逐条调用 Literature identity owner，将 accepted 映射为 `created`/`matched`，并在同一批次保留 malformed、uncertain 或 owner failure 的 `rejected` 结果。

直接证据：

- `apps/server/test/bibliography-import.test.ts` 覆盖四种格式、作者/标识符/年份转换、malformed document 和部分失败 Import 编排；
- `pnpm exec vitest run apps/server/test/bibliography-import.test.ts`：2 tests passed；
- `pnpm typecheck`：源码和测试 strict 类型检查通过。

当前边界：该切片只负责 codec 和中性 observation；DiscoveryRun、identity matching、created/enriched/matched/rejected 持久编排和原子用户输出仍属于 T040 后续工作。
