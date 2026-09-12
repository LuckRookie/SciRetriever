# Literature 身份索引化容量证据

2026-09-10。`LiteratureIdentityService` 不再扫描全库并截断到固定 10,000 项。它通过 SQLite 的
`literature_metadata_identifiers(namespace, value, literature_id)` 索引查询候选 Literature，再在 owner 内执行
同版本合并、版本链接和矛盾证据拒绝。来源 observation 仍完整保存，索引只负责候选定位，不形成新的业务事实。

`apps/server/test/literature-identity.test.ts` 新增超过 10,000 篇合成 Literature 的容量测试，确认目标 DOI
位于扫描顺序末尾时仍能稳定解析并返回 accepted。完整 fallback、Provider record、user semantic 和版本链接
索引及原子发布见 [`literature-identity-publication.md`](literature-identity-publication.md)。测试使用临时 SQLite
和合成 metadata，不读用户 catalog。

直接验证：

```bash
pnpm exec vitest run apps/server/test/literature-identity.test.ts
```

该索引化只改变查询实现，不改变 v1 Literature、MetaLiterature、MetadataObservation 或 provenance 合同。
