# Discovery 与 Import TypeScript 迁移证据

日期：2026-09-11。任务：T040。

## 完成范围

- Topic Discovery 通过配置组装的 `MetadataService` 逐 Provider 搜索，逐条交给唯一
  `LiteratureIdentityService`，持久保存 run、Provider 顺序/限额、source result、逻辑文献结果和
  observation cause。
- Citation Discovery 以有界广度优先方式处理 `references`、`cited-by` 和 `both`，Provider 的
  `scan_limit` 是整个 run 共享的 raw item 上限；lookup 也消费同一上限。Provider failure 与
  scan-limit/exhausted 分开，Reference 和 Provider relation support 使用现有 repository 发布。
- 一个 Provider 失败不会撤销其它 Provider 已提交的 Literature、MetadataObservation、Reference、
  DiscoveryResult 或 cause；run 以 `PARTIAL` 结束并保存每个 Provider 的唯一 source result。
- `all-pending`、`discovery-run`、`import-report`、`query`、`meta-literatures`、`literatures` 六类
  selector 均进入同一 TypeScript 入口。选择不再固定截断前 100 项，显式 ID 去重后保持用户顺序，
  缺失的显式 Literature/MetaLiterature 会拒绝整个选择，不会静默缩小范围。
- BibTeX、BibLaTeX、RIS 和 CSL-JSON 均有 TypeScript 编解码路径。输入受 8 MiB 默认上限约束，
  支持严格 UTF-8 和带 BOM UTF-16；坏 BibTeX/RIS/CSL 顶层记录只拒绝本记录。CSL 对象的重复字段、
  非对象记录、非法日期/作者和非 Unicode scalar 作为逐记录错误保留。
- 导入只生成 `user/bibliographic-import` MetadataObservation，并逐记录调用 Literature identity owner。
  identity 返回真实逻辑文献 ID 和 `created/enriched/matched` outcome；拒绝仍为 `rejected`，重复记录不在
  Entry 层预先过滤。CLI 用 `readFile` 读取用户原文件，离线测试校验原字节、大小和 mtime 不变。
- 四种格式完成 export → decode → 新 Catalog import 往返，验证两条记录的 DOI 身份和作者顺序。
  更完整的原子导出报告、覆盖策略和所有字段 omission 仍按原始归属在 T043 关闭。

## 直接验证

```bash
pnpm exec vitest run \
  apps/server/test/discovery-topic.test.ts \
  apps/server/test/discovery-citation.test.ts \
  apps/server/test/bibliography-import.test.ts \
  apps/server/test/bibliography-roundtrip.test.ts \
  apps/server/test/bibliography.test.ts \
  apps/server/test/selectors.test.ts \
  apps/server/test/literature-identity.test.ts \
  apps/server/test/literature-identity-publication.test.ts \
  apps/server/test/cli-main.test.ts
```

结果：9 个测试文件、25 个测试通过。

最终 TS Full：

```text
Test Files  109 passed | 3 skipped (112)
Tests       464 passed | 4 skipped (468)
Build       passed
```

完整日志：`/tmp/sciretriever-full-t040-discovery-import.log`。跳过项是需要显式环境开关的 live/集成场景；
T040 的 Provider、codec、selector、identity 和 CLI 文件测试均离线执行。没有访问真实 Provider、凭据、
用户 Catalog 或用户书目文件。
