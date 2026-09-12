# TypeScript 版本安装

支持矩阵当前固定为 Linux x64、Node 22.19.0 runtime、Playwright 1.55.0 和 operator 提供的 CloakBrowser 0.5.8 wrapper/binary。免开发包自带 Node、contracts、server、Web 静态资源和 runtime manifest；CloakBrowser bundle 可在构建包时显式携带，也可以由 operator 通过 `SCIRETRIEVER_CLOAK_BUNDLE` 配置。系统需要 `flock`、`prlimit`、`pdfinfo`、`pdftotext` 和 `Xvfb`，不要求 Python、Rust、VNC 或本地编译器。

从源码安装并验证：

```bash
pnpm install --frozen-lockfile
pnpm full
pnpm package:portable -- --output /tmp/sciretriever-portable
/tmp/sciretriever-portable/bin/sciretriever doctor --json
```

`doctor` 只读检查平台和系统依赖，不启动浏览器、不访问网络、不读取凭据。CloakBrowser 未配置时报告 blocked 是预期结果；只有通过 operator bundle 校验后，Browser 工作台才可声明 ready。包内运行使用自带 Node，配置和 Catalog 默认放在 `SCIRETRIEVER_HOME` 指定目录。
