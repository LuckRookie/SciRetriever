# 运行依赖与支持矩阵

更新时间：2026-09-12。

发行目标为 Linux x64。便携包携带当前 Node runtime、`@sciretriever/contracts`、`@sciretriever/server`、Web 静态资源和运行 manifest；Browser binary 是否随包携带由 `--cloak-bundle` 显式决定。默认不下载、不缓存、不回退到 stock Chromium。

`sciretriever doctor --json` 检查 `flock`、`prlimit`、`pdfinfo`、`pdftotext`、`Xvfb` 和 operator Cloak bundle 的版本/可执行性。系统图形库、沙箱和显示能力属于发行环境前置条件，缺失时报告 blocked，不被隐藏在运行时错误中。许可信息见 `release/manifests/runtime-support.json`。
