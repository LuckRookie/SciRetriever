# Portable package 与安装后 smoke

更新时间：2026-09-17。构建器在 source checkout 运行 `pnpm build`，把 contracts/server/Web 资产、生产依赖和当前 Node runtime 放入独立临时目录；输出不包含 `.py`、`.pyc`、SciRetriever `src/`/`test/`、凭据或用户 Catalog。CloakBrowser 只有通过 `--cloak-bundle` 才会显式携带，默认由 operator 安装并由 `doctor` 校验。

本次独立临时目录 smoke：

```text
node scripts/package/build-portable.mjs --output /tmp/sciretriever-final-cleanroom-XXXXXX/runtime
sciretriever doctor --json                 # Linux x64/system deps ready; Cloak blocked (not configured)
sciretriever config status --json          # no network and no Browser launch
sciretriever storage inspect --json        # v1 synthetic Catalog
sciretriever storage migrate --dry-run --json # read-only v1/v2 inspection; writes require --synthetic-copy
sciretriever import metadata bibtex ...    # one synthetic record created
sciretriever literature search --text Portable --json # one record found
sciretriever export metadata csl-json ...  # one record exported
```

2026-09-17 clean-room 结果：portable manifest 共 1582 项；无 Python、SciRetriever 项目 `src/`/`test/`、凭据或用户数据，并包含 `storage/sqlite/worker-runtime.js`。安装后测试使用临时 `HOME`/`USERPROFILE` 隔离固定的 `~/.sciretriever` 身份，并显式删除 `SCIRETRIEVER_HOME`；生产 CLI 不读取该变量。doctor、纯本地 config status、Catalog inspect/migrate dry-run、metadata import、Library search 和 CSL-JSON export 均通过。未安装或调用 Python/编译器，也未访问真实 Provider、站点或用户数据。完整 Browser/Provider 流程仍按 T059 的授权边界保持 `not-authorized/not-run`。
