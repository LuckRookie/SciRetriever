# TypeScript 版本安装

支持矩阵当前固定为 Linux x64、Node 22.19.0 runtime、Playwright 1.55.0、CloakBrowser 0.5.8 wrapper 与固定 binary release `146.0.7680.177.5`。免开发包自带 Node、contracts、server、Web 静态资源和 runtime manifest；CloakBrowser bundle 可在构建包时显式携带，也可以由 operator 通过 `SCIRETRIEVER_CLOAK_BUNDLE` 配置。系统需要 `flock`、`prlimit`、`pdfinfo` 和 `Xvfb`，不要求 Python、Rust、VNC 或本地编译器。其它 OS、ARM 和 runtime 版本不属于本轮已验收组合。

从源码安装并验证：

```bash
pnpm install --frozen-lockfile
pnpm full
pnpm package:portable -- --output /tmp/sciretriever-portable
/tmp/sciretriever-portable/bin/sciretriever doctor --json
```

`doctor` 只读检查平台和系统依赖，不启动浏览器、不访问网络、不读取凭据。CloakBrowser 未配置时报告 blocked 是预期结果；只有通过 operator bundle 校验后，Browser 工作台才可声明 ready。包内运行使用自带 Node，生产配置和凭据固定在 `~/.sciretriever/`；Catalog/ArtifactStore 由已保存的 `paths` 选择，未指定时当前 Application 使用用户 home 下的 `catalog.sqlite` 和 `artifacts/`。`SCIRETRIEVER_HOME` 不属于用户可见的配置路径选择，当前 CLI 不读取它；显式临时 home 只作为内部测试/隔离 seam。

新安装用户在确认精确目录后，通过正式入口启用知识、提取与检索所需的 v8：

```bash
sciretriever storage schema-inspect --catalog /absolute/data/catalog.sqlite --json
sciretriever storage schema-init --catalog /absolute/data/catalog.sqlite --json
```

目标父目录必须已存在，目标文件必须不存在；已有 v1–v7 使用 `schema-upgrade --catalog PATH --backup PATH`，先停写并保留资产。命令与失败恢复见[初始化、升级与恢复](upgrade.md)。只读查询不创建 catalog，启用 schema 也不下载、解析、分析或暗中构建索引。

## 当前 Catalog 与 reader 兼容

下表指**当前安装版本**对完整、已知 schema 的能力；新增版本累积保留旧文献事实和 reader。Catalog 版本与 Document/Knowledge/HTTP 等产物协议版本是不同合同。

| Catalog | 当前只读能力 | 此版本增加的存储能力 | 正式 operator 路径 |
| --- | --- | --- | --- |
| v1 | Library、元数据、原始材料及旧兼容内容；文件级材料证据 | 基础文献事实 | `schema-upgrade` → v8，需原始备份 |
| v2 | 同 v1 | execution / durable runtime；不代表新文档或知识能力 | `schema-upgrade` → v8，需原始备份 |
| v3 | 以上及固定 DocumentVersion、片段/资源、文档证据 | 独立解析/文档版本发布与默认关系 CAS | `schema-upgrade` → v8，需原始备份 |
| v4 | 以上及材料 Context | 可重建的材料检索投影 | `schema-upgrade` → v8，需原始备份 |
| v5 | 同 v4；外部提取准备仍按实际材料能力报告缺口 | 候选 operation、原子交付回执与输入保护 pin；不保存领域 payload | `schema-upgrade` → v8，需原始备份 |
| v6 | 以上及单篇 Knowledge 按固定 ID 阅读、证据复核 | 多用途单篇知识及分层压缩产物 | `schema-upgrade` → v8，需原始备份 |
| v7 | 以上及集合 Synthesis 阅读与准备 | 固定范围的版本化集合综合 | `schema-upgrade` → v8，需原始备份 |
| v8 | 以上及知识/材料混合 Context | 独立知识检索投影 | 返回 `already-v8`；不创建备份 |
| 不存在目标 | Query 返回 `not-initialized`，不建库 | 无 | `schema-init` 直接创建 v8 |

`schema-init` 拒绝所有已存在目标。CLI 的实际 `schema-upgrade` 必须给 `--backup`，即使完整 v8 最终返回 `already-v8`。operator inspect/dry-run 检查完整 identity/fingerprint、DDL、integrity/FK 和子 schema；未知版本、漂移和损坏拒绝。普通源 reader 与检索投影的错误边界分别处理，完整检索 DDL 下的损坏投影不会被解释为零命中，也不能据 Library 可读绕过 operator 校验。缺索引、陈旧或不可用源按[阅读指南](library-query.md)反馈；索引需另一次明确重建。

这里的兼容是新程序读取旧事实和继续使用旧兼容 API，不保证旧二进制能打开新库，也不提供自动降级或无损增量回退。切换、Catalog 与资产备份、独立恢复和开放 writer 的步骤见[切换与恢复](cutover.md)。

## 安装验收边界

2026-09-30 已验证实际 portable 包的公开 SDK、CLI、worker 和包内 Web 资源旅程，包含正式 v8 初始化、独立 v1→v8 升级及原始版本备份读取。单独的真实 Cloak portable 旅程把已核实官方归档字节的 bundle 打进包，并从该安装副本运行同会话 Browser、获取、发布和后续阅读。默认离线安装测试使用明确的 synthetic Chromium shim；两类证据分别记录，不能由默认 Full 推导官方 runtime。

真实 runtime 行为只访问 loopback，Parser/模型/Provider 使用 fake 或 fixture，所有 Catalog、资产与 Profile 为合成临时材料。软件来源核实证明签名归档与文件字节，不追认每一条历史测试实际启动了该软件。真实服务、Publisher/机构站点、真实语料质量、用户数据/Profile 切换及发布均未在本轮执行；安装成功不构成这些能力的生产就绪声明。
