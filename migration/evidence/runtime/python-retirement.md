# Python 生产入口退役记录

更新时间：2026-09-12。

TypeScript/Node 已成为唯一生产运行时。命令入口是 `apps/server/src/cli/main.ts`，应用组装是 `apps/server/src/bootstrap/application.ts`，便携包由 `scripts/package/build-portable.mjs` 构建。配置、凭据、Catalog、ArtifactStore、Browser、Acquisition、Parser、Analysis、任务和 Web 工作台均从同一个 TypeScript Application 组装；源码中没有 Python RPC、`python` 子进程或 Python fallback。

逐项处置记录见 [`migration/retirement-report.json`](../../retirement-report.json)。2026-09-12 已完成物理归档，快照
目录为 [`archive/2026-09-12-typescript-python-retirement`](../../../archive/2026-09-12-typescript-python-retirement/)，
文件校验见其 [`MANIFEST.json`](../../../archive/2026-09-12-typescript-python-retirement/MANIFEST.json)：

- 242 个 `src/sciretriever/**/*.py` 活动模块均标为 `historical-nonruntime`，并记录对应的 TypeScript target；它们现位于归档快照，不参与 `pnpm build`、便携包或 Node CLI。
- 161 个 `tests/**/*.py` 文件均标为 `historical-oracle`，另有 4 个迁移检查快照；TypeScript/Vitest 是当前交付证据。
- `scripts/harness.py`、`scripts/__init__.py`、`pyproject.toml`、`uv.lock`、`.python-version` 和 `pyrightconfig.json` 均随 Python 工具链快照归档；根目录不再保留 Python 代码或 Python 项目配置。

便携包测试会扫描最终 manifest，拒绝 `.py`、Python 可执行文件、源码、测试、凭据和用户数据；TS CLI 安装后 smoke 在未安装 Python 的临时目录中执行。归档快照只用于追溯，不代表混合生产对象图。真实用户 Catalog/Profile 的迁移和删除仍需要独立授权。

验证：

```text
pnpm exec vitest run apps/server/test/portable-package.test.ts apps/server/test/configuration-typescript-owner.test.ts
pnpm quick
pnpm full
```

本记录不运行 Python Quick、Python Full 或全量 unittest，符合项目 owner 的 TS 验收决定。
