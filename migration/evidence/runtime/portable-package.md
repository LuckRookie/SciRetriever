# Portable package 与安装后 smoke

更新时间：2026-09-12。构建器在 source checkout 运行 `pnpm build`，把 contracts/server/Web 资产、生产依赖和当前 Node runtime 放入独立临时目录；输出不包含 `.py`、`.pyc`、源码、测试、凭据或用户 Catalog。CloakBrowser 只有通过 `--cloak-bundle` 才会显式携带，默认由 operator 安装并由 `doctor` 校验。

本次独立临时目录 smoke：

```text
node scripts/package/build-portable.mjs --output /tmp/sciretriever-portable-final-QirpIq/runtime
sciretriever doctor --json                 # Linux x64/system deps ready; Cloak blocked (not configured)
sciretriever storage migrate --json        # catalog v1 → v2, migrated=true
sciretriever import metadata bibtex ...    # synthetic record created
sciretriever literature search --text Portable --json
sciretriever export metadata csl-json ...  # one record exported
```

运行时只设置临时 `SCIRETRIEVER_HOME`，未安装或调用 Python/编译器，也未访问真实 Provider、站点或用户数据。完整 Browser/Provider 流程仍按 T059 的授权边界保持 `not-authorized/not-run`。
