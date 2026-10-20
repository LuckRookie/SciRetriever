# TypeScript 版本安装

支持矩阵当前固定为 Linux x64、Node 22.19.0 runtime、Playwright 1.55.0、CloakBrowser 0.5.8 wrapper 与固定 binary release `146.0.7680.177.5`。免开发包自带 Node、contracts、server、Web 静态资源和 runtime manifest；CloakBrowser bundle 可在构建包时显式携带，也可以由 operator 通过 `SCIRETRIEVER_CLOAK_BUNDLE` 配置。系统需要 `flock`、`prlimit`、`pdfinfo` 和 `Xvfb`，不要求 Python、Rust、VNC 或本地编译器。其它 OS、ARM 和 runtime 版本不属于本轮已验收组合。

从源码安装并验证：

```bash
pnpm install --frozen-lockfile
pnpm full
pnpm package:portable -- --output /tmp/sciretriever-portable
/tmp/sciretriever-portable/bin/sciretriever doctor --json
```

`doctor` 只读检查平台和系统依赖，不启动浏览器、不访问网络、不读取凭据。CloakBrowser 未配置时报告 blocked 是预期结果；Browser 获取需要已校验的 runtime，普通 Web 工作台仍可启动。包内运行使用自带 Node，生产配置和凭据固定在 `~/.sciretriever/`；Catalog/ArtifactStore 由已保存的 `paths` 选择。正式 `sciretriever web` 首次启动会把缺失的两条路径保存为 `~/.sciretriever/catalog.sqlite` 和 `~/.sciretriever/artifacts/`，目标不存在时创建当前结构的空库，直接进入页面，无需配置向导。之后可在设置中修改位置，重启生效且不自动搬迁数据。CLI/MCP 读取相同配置。`SCIRETRIEVER_HOME` 不属于用户可见的配置路径选择，当前 CLI 不读取它；显式临时 home 只作为内部测试/隔离 seam。

需要单独准备新库时，可在确认精确目录后使用显式初始化工具；Web 的首次自动建库使用同一份当前结构：

```bash
sciretriever storage schema-inspect --catalog /absolute/data/catalog.sqlite --json
sciretriever storage schema-init --catalog /absolute/data/catalog.sqlite --json
```

目标父目录必须已存在，目标文件必须不存在。`schema-init` 不覆盖已有文件，读取入口不创建数据库，初始化也不获取、解析或分析文献。已有旧库不由普通启动自动转换。

## 当前 Catalog

生产代码只维护 `schema.ts` 中的一份当前结构及其指纹。结构不匹配时明确拒绝，不依据历史版本号选择旧逻辑，也不提供逐级迁移命令。旧库需要经过备份、副本转换和核对后再切换；见[数据库初始化与恢复](upgrade.md)。数据库布局标识与 Document、HTTP 等数据合同的协议标识相互独立。

源数据和检索投影分别校验。检索投影损坏时不能伪装成零命中；只读查询不自动修复，索引需要显式重建。

## 安装验收边界

2026-09-30 已验证实际 portable 包的公开 SDK、CLI、worker 和包内 Web 资源旅程，包含正式 v8 初始化、独立 v1→v8 升级及原始版本备份读取。单独的真实 Cloak portable 旅程把已核实官方归档字节的 bundle 打进包，并从该安装副本运行同会话 Browser、获取、发布和后续阅读。默认离线安装测试使用明确的 synthetic Chromium shim；两类证据分别记录，不能由默认 Full 推导官方 runtime。

真实 runtime 行为只访问 loopback，Parser/模型/Provider 使用 fake 或 fixture，所有 Catalog、资产与 Profile 为合成临时材料。软件来源核实证明签名归档与文件字节，不追认每一条历史测试实际启动了该软件。真实服务、Publisher/机构站点、真实语料质量、用户数据/Profile 切换及发布均未在本轮执行；安装成功不构成这些能力的生产就绪声明。
