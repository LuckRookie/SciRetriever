# TypeScript Library Query 与原子导出证据

2026-09-11，T043 已由 TypeScript 生产路径关闭。`LiteratureQueryService`、SQLite worker、Bibliography export 与 artifact export 均不调用 Network、Provider 或 Python：

- Search 使用同一 SQLite 只读事务取得 FTS、current metadata/status、缺失步骤、Discovery cause 与排序位置；五种排序、Unicode/AND 筛选、稳定 cursor 和空查询均有直接测试。
- Detail 在一个只读 snapshot 内聚合 MetaLiterature、observations、主 PDF、附加资产、ParserResult、结构化 Content、其它版本和本地引用计数，并从 ArtifactStore 校验结构化 Content 的 canonical bytes/hash 与 lineage。
- references/cited-by 从同一权威 Reference 正反向读取；列表只返回 related Literature 与 support count，ReferenceDetail 才返回三类 support locator。不存在、无 support、损坏 owner/index 和 cursor 篡改均 fail closed。
- Bibliography export 只读取一次 selector snapshot。显式 Literature scope 保持调用者顺序；query、DiscoveryRun 和 MetaLiterature scope 按 `published → accepted-manuscript → preprint → other → LiteratureId` 为每个 MetaLiterature 选择一个代表版本。编码阶段不再逐项重读 catalog。
- BibTeX、BibLaTeX、RIS、CSL-JSON 的批量编码复用 T040 codec，并完成多记录导出→解码→重新导入，保留 DOI、有序个人作者和机构作者。
- metadata 文件、当前主 PDF 和 current content Markdown 均通过 Entry 发布。外部目标默认 no-clobber，`overwrite=true` 才原子替换；同目录 staging、owner-only 权限、fsync、取消、并发冲突、符号链接父目录、损坏源和失败清理已有离线测试。

主要实现：

- `apps/server/src/literature/query.ts`
- `apps/server/src/entry/selectors.ts`
- `apps/server/src/entry/bibliography-export.ts`
- `apps/server/src/literature/bibliography.ts`
- `apps/server/src/entry/artifact-export.ts`
- `apps/server/src/cli/main.ts`

直接验证：

```text
pnpm exec vitest run apps/server/test/selectors.test.ts apps/server/test/bibliography.test.ts apps/server/test/bibliography-export.test.ts apps/server/test/bibliography-roundtrip.test.ts apps/server/test/literature-query.test.ts apps/server/test/literature-query-integrity.test.ts apps/server/test/literature-reference-query.test.ts apps/server/test/literature-detail.test.ts apps/server/test/literature-artifact.test.ts apps/server/test/cli-main.test.ts
pnpm quick
pnpm full
```

相关测试共 10 个文件、19 项通过。TS Full 日志写入 `/tmp/sciretriever-full-t043-library-export.log`。未运行 Python Quick、Python Full 或全量 unittest；测试中的既有 Python cursor/matcher oracle 仍按 T045/T061 转为冻结 golden 后退役，不属于生产运行路径。
