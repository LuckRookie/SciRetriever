# TypeScript / Catalog v8 切换与恢复

当前 operator 入口可以在精确不存在目标初始化 v8，或把完整 v1–v7 显式升级至 v8。命令、锁和每步失败语义见[Catalog 初始化、升级与恢复](upgrade.md)，版本与 reader 支持见[安装兼容矩阵](installation.md#当前-catalog-与-reader-兼容)。本页组织实际切换前需要审查的目标、备份、恢复验证和增量处置；真实用户数据、Profile、外部访问和发布仍需各自明确授权。本轮只完成合成验证与交接准备，没有执行真实切换。

## 先确定精确目标

下面项目尚未指定真实值，应由 operator 在切换授权中填齐。命令示例中的 `/absolute/data/` 只是占位目录。

| 待确认项目 | 必须明确的内容 |
| --- | --- |
| 程序 | 当前与拟切换安装包的版本、路径和 runtime manifest；保留旧包用于独立恢复验证 |
| Catalog | 已保存的 `paths.catalog_path` 所指规范绝对路径、当前 schema version/fingerprint；不能从仓库目录猜测 |
| 原始备份 | 与 Catalog 同目录、名称不同且不存在的 `--backup` 目标 |
| ArtifactStore | 已保存的 `paths.artifact_root`、完整备份位置和恢复副本位置；保留规范相对路径与全部引用字节 |
| 停写范围 | 使用该 Catalog 的 CLI、工作台、Jobs、在途解析/模型操作和 Browser transfer；指定负责关闭的人及确认结果 |
| 恢复核验 | 独立恢复环境、只读程序版本、要复核的 Literature/Asset/Document/Knowledge/Synthesis ID、hash、provenance 与回执 |
| 开放与失败处置 | 开放新 writer 的时点、切换后增量的保存方式、允许恢复到哪个副本；真实外部验证单独列范围 |

固定配置和凭据在 `~/.sciretriever/`；它们不等于 Catalog/ArtifactStore 目录。未配置 `paths` 时，当前 Application 使用用户 home 下的 `catalog.sqlite` 与 `artifacts/`。本流程不要求导出、打印或迁移 secret、Cookie 或 Browser Profile；这些对象不能混入 Catalog 备份。

## 停写与资产保全

1. 使用 `schema-inspect --catalog PATH` 保存当前版本、fingerprint 和检查结果，再运行 `schema-upgrade --catalog PATH --dry-run`。两者只读，不建库、不写备份、不恢复任务。未知 schema、DDL 漂移或损坏先停止处理，不能把它们当作可升级的旧版本。
2. 停止新操作准入，通过现有任务控制入口暂停或取消在途任务，等待已经开始的准备、发布与事务收束，并保存实际报告、Candidate/receipt 和已提交事实。关闭相关 Application、工作台及 Browser process/context，等待 transfer、写准入和 Profile 锁释放。Browser DOM、尚未发布的下载和运行中的模型调用不是可恢复业务事实。
3. 在停写状态下保存完整 ArtifactStore 副本及引用文件的 hash/大小，保留目录结构；只复制主 PDF 不足以恢复已发布的 Markdown、结构、资源和知识产物。Catalog 升级命令会用 SQLite `VACUUM INTO` 发布原始版本的一致性备份，包含已提交 WAL 事实；不要把单独复制活动主库或 WAL 当作此备份。为恢复核验保留对应的 Catalog 与资产备份组合。

整链升级命令会先验证并发布 Catalog 原始备份，再推进 schema；下节执行命令返回后，必须在开放新 writer 前完成下面的独立恢复复核。升级中途失败也先保留并检查该备份。

在**独立恢复目录**复核备份：复制到新的未使用路径，运行 `schema-inspect --catalog RESTORED_COPY`，检查它仍为原始 version/fingerprint。通过已安装 SDK 的只读 `SqliteWorker`，或在隔离环境中将 QueryApplication 的配置路径明确指向恢复副本，核对关键 ID、数量、来源、回执和引用关系；随后用只读材料/文档/知识入口读取对应资产副本并复算 hash。`schema-inspect` 只检查 Catalog，不能证明资产字节已备份。真实数据的副本恢复演练同样需要授权；本轮实际验证使用系统临时目录里的合成材料。

整链 flock 可以拒绝遵守同一 Catalog 写准入的 writer，SQLite 锁与 data-version 检查提供另外的实际检测；它们不能证明所有外部进程、Jobs 或 Browser 已停。停写确认仍由 operator 完成。

## 显式升级与开放新版本

停写并保全资产后，使用已确认的路径执行：

```bash
sciretriever storage schema-inspect --catalog /absolute/data/catalog.sqlite --json
sciretriever storage schema-upgrade --catalog /absolute/data/catalog.sqlite --dry-run --json
sciretriever storage schema-upgrade --catalog /absolute/data/catalog.sqlite --backup /absolute/data/catalog-before-v8.sqlite --json
sciretriever storage schema-inspect --catalog /absolute/data/catalog.sqlite --json
sciretriever storage schema-inspect --catalog /absolute/data/catalog-before-v8.sqlite --json
```

确认成功回执的 `from_version`、`to_version: 8`、`completed_versions` 和 `backup_path`，保存升级后完整 fingerprint，复核备份仍为原始版本。当前程序的冻结版本定义由[版本化存储](../architecture/technical/07-versioned-storage.md#4111-正式-operator-的-catalog-v8-启用)维护；不能只看文件名或数据库存在就认为升级完成。已是完整 v8 时返回 `already-v8`，不会新建备份；CLI 仍要求提供 `--backup` 参数，不能把这个结果当作已备份。

新安装的不存在目标使用 `schema-init --catalog PATH`；它不是恢复旧库的方法。普通启动和查询不升级；旧 `storage migrate --synthetic-copy` 及单步迁移只保留[历史合成演练](document-catalog-migration.md)，不能替代正式 v8 入口。

先以新安装包运行 `doctor --json`、`config status --json` 与 `schema-inspect`，完成上述独立恢复复核，再仅开放只读 Library/QueryApplication。按已记录的 ID 复核元数据和原件、固定 DocumentVersion 与证据、Knowledge/Synthesis 内容与 manifest hash、已接纳候选回执；不同版本可用能力按兼容矩阵判断。Query 缺口不得触发获取、解析、模型或 Job。材料与知识索引的缺失/陈旧需要另外明确启动 `maintenance rebuild-index` / `maintenance rebuild-knowledge-index`，不能把建 schema 当作已建索引。

只读复核通过后再开放一个受控新 writer，观察实际事实提交、任务状态和关闭结果，记录此时起新增的 ID、版本、hash 和资产。Browser 重新打开同一固定 Profile 时仍执行软件与锁校验，不恢复旧 DOM 或自动继续未完成动作。只有另有授权时才验证真实 Provider、Parser、模型、Publisher 或机构站点；本地 readiness 和 loopback 通过不证明真实 entitlement。

## 失败与切换后增量

| 失败时点 | 当前处置 |
| --- | --- |
| 检查或备份发布前 | 保留源库与错误，不覆盖已有备份；修复目标/环境后重新检查 |
| 整链中某一步失败 | 保存 stderr 的 `migration-refused`、`reason`、`progress` 和原始备份；检查实际 `current_version`，不猜测整链回滚 |
| 已提交中间版本 | 例如 v6 步失败而库已是 v5，先只读复核，再用**新的备份路径**从 v5 续迁；不覆盖原始 v1 备份 |
| v8 发布后或开放 writer 后 | 先停止新 writer，保全当前 Catalog、完整资产及切换后增量，保留失败副本和日志，再决定续修或独立恢复 |

当前没有 v8→旧 schema 的自动降级、跨版本增量重放或 Profile 恢复入口。新程序能读 v1–v8 不代表旧二进制能读写 v8；恢复时用已经验证支持该备份版本的程序。不得把旧备份直接覆盖唯一当前库，或在旧程序中强写已有新版本关系。即使选择恢复旧版本，也必须另存当前库及新增材料、文档、知识和回执，并明确增量如何保留；无法安全重放的事实先保留原副本，不能宣称无损回退。
