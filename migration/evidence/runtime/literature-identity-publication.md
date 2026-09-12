# Literature 身份、元数据与原子发布矩阵

日期：2026-09-11。任务：T038。

## 完成范围

`LiteratureIdentityService` 现在通过 Literature 所有的纯规则和一个 SQLite 原子发布命令接纳
`MetadataObservation`。生产路径不扫描全库，也不把 Storage 查询结果直接当成业务决定。

| 能力 | TypeScript 实现与证据 |
| --- | --- |
| 稳定身份 | DOI、arXiv、PMID、PMCID 使用规范值；同 namespace 冲突、多 Literature 命中和 hash/index 碰撞均在完整对象比较后拒绝 |
| fallback 身份 | 只有双方都没有稳定 ID，且规范化 title、完整 author 顺序、publication year、document type 四项齐全并完全相等时才匹配 |
| Provider record | 只在 `metadata-provider + source_name + source_record_id` 范围内作为 observation owner；不冒充跨 Provider Literature ID |
| Observation replay | Observation ID 必须保持完整语义；user import 另按带 domain tag 的完整语义 hash 查找并在对象比较后去重；不同 Provider observation ID 均保留 |
| metadata projection | user 优先、Provider precedence、标量首个非空值、稳定 ID 冲突、对齐作者补充、仅 user keyword 投影均由纯规则决定 |
| 内容完成保护 | `CONTENT_READY` 后可继续接纳兼容来源 observation，但 current metadata/revision 不被 Provider 回写覆盖 |
| 版本关系 | 只接受 Provider `version_links`；record ID 必须同 Provider，record 与稳定 ID 同时存在时必须由同一目标 observation 全部满足 |
| MetaLiterature | 新版本可加入已有 aggregate；两个既有 aggregate 可原子合并；代表版本按 published、accepted manuscript、preprint、other 与 Literature ID 决定 |
| 原子性 | identity read 使用已有 equality index 扩展完整 Meta/observation/current-facts closure；CAS 同时保护 Literature revision/hash、Meta representative/member；Literature、metadata、索引、observation、membership、耗尽清理和 Discovery cause 迁移同事务提交 |

SQLite v1 已有的 `literature_fallback_identity_indexes`、
`user_observation_semantic_indexes`、`provenance_provider_record_lookup` 和 observation identifier index
均已进入实际读写路径。`putLiterature` 同步维护 fallback index，避免测试、恢复或其它受支持写入口产生不可查的
Literature。Meta 合并会把既有 topic/citation cause 与 result 移到其具体 Literature 当前所属的 aggregate，
无法安全映射的 retired Meta 会令事务失败。

## 直接验证

```bash
pnpm exec vitest run \
  apps/server/test/literature-identity-rules.test.ts \
  apps/server/test/literature-metadata-rules.test.ts \
  apps/server/test/literature-identity.test.ts \
  apps/server/test/literature-identity-publication.test.ts \
  apps/server/test/observation-repository.test.ts \
  apps/server/test/literature-state.test.ts \
  apps/server/test/reference-repository.test.ts \
  apps/server/test/literature-reference-query.test.ts
```

新增生产发布测试覆盖严格 fallback、user replay、Provider scope、稳定 ID ambiguity、两个既有
MetaLiterature 合并、stale CAS 无部分 observation/metadata 写入，以及 CONTENT_READY metadata 保留。
既有 Reference 测试覆盖三种 support、双向关系、稳定分页、当前 content hash、来源 owner/index 与失败保留；
state/content 测试覆盖三级状态、revision/hash、主 PDF、ParserResult 和 Analysis lineage。

阶段性完整验收：

```text
pnpm full
Test Files 107 passed | 3 skipped (110)
Tests      456 passed | 4 skipped (460)
build      tsc -b && node scripts/build-workbench-assets.mjs
exit       0
```

日志：`/tmp/sciretriever-full-t038-identity.log`。未运行 Python Quick、Python Full 或全量 unittest；TS Full
中仓库已注册的配置/Parser 对照会按 Harness 设计调用受限 Python bridge。
