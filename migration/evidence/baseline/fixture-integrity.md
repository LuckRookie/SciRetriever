# FIXTURE-V1 证据

日期：2026-09-09

fixture 位于 `tests/fixtures/compat-v1/`，包括一个合成 provenance、metadata、query、asset、literature、reference
和 canonical parameter 样本。`manifest.json` 固定源 SQLite schema version/fingerprint、canonical JSON 规则、
原始 asset bytes 标记及七个 SHA-256 指纹；没有绝对路径、用户数据或外部响应。

可重放命令：

```text
uv run --frozen python tests/test_fixture_integrity.py
```

结果：2 个测试通过。测试先重算 canonical bytes，再比较 SHA-256；随后使用当前 Python Model 验证 Identifier、
LiteratureMetadata、LibraryQuery、MetaLiterature、Reference 和 Asset。非法真实路径和历史档案标记也会被拒绝。

该 fixture 是后续 TypeScript parity 的输入合同，不代表任何用户 Catalog 已迁移，也不改变 v1 生产 schema。
