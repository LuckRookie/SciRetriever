# TypeScript 版本安装

类型：指南
负责：安装入口和运行支持边界
状态：现行

支持矩阵当前固定为 Linux x64、Node 22.19.0 runtime、Playwright 1.55.0、CloakBrowser 0.5.8 wrapper 与固定 binary release `146.0.7680.177.5`。免开发包自带 Node、contracts、server、Web 静态资源和 runtime manifest；CloakBrowser bundle 可在构建包时显式携带，也可以由 operator 通过 `SCIRETRIEVER_CLOAK_BUNDLE` 配置。系统需要 `flock`、`prlimit`、`pdfinfo` 和 `Xvfb`，不要求 Python、Rust、VNC 或本地编译器。其它 OS、ARM 和 runtime 版本不在当前声明的支持矩阵内。

从源码安装并验证：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm package:portable -- --output /tmp/sciretriever-portable
/tmp/sciretriever-portable/bin/sciretriever doctor --json
```

`doctor` 只读检查平台和系统依赖，不启动浏览器、不访问网络、不读取凭据。CloakBrowser 未配置时报告 blocked 是预期结果；Browser 获取需要已校验的 runtime，普通 Web 工作台仍可启动。包内运行使用自带 Node，生产配置和凭据固定在 `~/.sciretriever/`；Catalog/ArtifactStore 由已保存的 `paths` 选择。正式 `sciretriever web` 首次启动会把缺失的两条路径保存为 `~/.sciretriever/catalog.sqlite` 和 `~/.sciretriever/artifacts/`，目标不存在时创建当前结构的空库，直接进入页面，无需配置向导。之后可在设置中修改位置，重启生效且不自动搬迁数据。CLI/MCP 读取相同配置。`SCIRETRIEVER_HOME` 不属于用户可见的配置路径选择，当前 CLI 不读取它；显式临时 home 只作为内部测试/隔离 seam。

`sciretriever web --port 4174` 自带前台守护：当前进程为父，实际 Web 在一个私有子进程内运行，不依赖 systemd，也不自行转入后台。tmux 或外层终端持有父进程；Ctrl-C/SIGTERM 关闭整树。父使用包内同一 Node 与绝对 worker 入口，工作目录不会改变启动目标。`--port 0` 初次分配的端口在后续应用配置时保持，端口被占用会失败。

配置应用等待已接纳工作与传输结束，随后短暂关服并换代；可在关闭提交前取消等待。旧登录和 Browser 会话不保留，固定密码继续使用，自动 API key 每次换代重新生成并经原启动通道交付。固定密码只从原有启动环境在内存消费，不能写到命令参数或日志。异常退出有界退避不会自动重演任务；失败项需用户显式恢复。来源接口与测试边界见[配置指南](configuration.md#来源目录单源保存与应用)。

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

安装包检查、源码构建与真实 Browser/供应商验收分别记录；安装成功不证明真实站点 entitlement、解析质量或模型科学质量。开发验证方法见[TypeScript 开发入口](../development/typescript-foundation.md)，测试选择见 [HARNESS](../../HARNESS.md#54-typescript-开发验证)。历史版本的安装旅程不定义当前 schema 支持范围。
