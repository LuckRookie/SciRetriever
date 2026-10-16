# Catalog 初始化、升级与恢复

正式 CLI 提供显式的 Catalog v9 初始化与 v1–v8 升级入口。它只启用已实现的存储能力，不发现、下载、解析、分析或构建索引；普通 Application、Query 和 Browser 启动仍不会自动升级已有库。新库可以直接初始化 v9，已有库必须先检查并指定可恢复备份。本文描述 operator 工具能力，不授权代理将命令指向真实用户数据；本轮开发与恢复验证全部使用合成临时目录。

当前版本的 reader 与能力范围见[安装兼容矩阵](installation.md#当前-catalog-与-reader-兼容)；真实切换前的精确目标、停 writer/Jobs/Browser、Catalog 与资产备份组合、独立恢复及增量保留见[切换与恢复](cutover.md)。

`--catalog` 是你选择的精确文件目标，必须为规范绝对路径。工具不读取配置来猜测目标。应先确认实际 `paths.catalog_path`；正式 Web 首次启动会将未配置路径保存为 `~/.sciretriever/catalog.sqlite`，并自动创建不存在的目标空库，无需先执行下面的初始化命令。已有自定义路径优先使用。底层 Application 的历史内部缺省位置不是正式 Web 的选库规则。父目录须已存在，整条父链不能含符号链接；既有 catalog 须为单链接普通文件。同目录可以已有配置和资产，工具不会清空它。

## 初始化新库

```bash
sciretriever storage schema-inspect --catalog /absolute/data/catalog.sqlite --json
sciretriever storage schema-init --catalog /absolute/data/catalog.sqlite --json
sciretriever storage schema-inspect --catalog /absolute/data/catalog.sqlite --json
```

不存在的目标在 inspect 中返回 `not-initialized`，不会创建文件。`schema-init` 在同目录私有 staging 中按冻结 v9 manifest 建立完整空库，检查 catalog/execution/runtime identity、两个检索 revision、DDL、完整性和外键后 create-if-absent 发布。目标已有文件或发生竞争创建时拒绝覆盖。初始化不建立文献、知识、Job 或 active index generation；发布后的有效库在后续错误中仍保留，错误 progress 给出实际可识别版本。

## 升级已有库

先停止使用目标的业务 writer、CLI/工作台、在途任务和 Browser 会话，确认已提交的候选及原件已收束。下面命令使用同目录不同且尚不存在的备份目标：

```bash
sciretriever storage schema-inspect --catalog /absolute/data/catalog.sqlite --json
sciretriever storage schema-upgrade --catalog /absolute/data/catalog.sqlite --dry-run --json
sciretriever storage schema-upgrade --catalog /absolute/data/catalog.sqlite --backup /absolute/data/catalog-before-v9.sqlite --json
sciretriever storage schema-inspect --catalog /absolute/data/catalog.sqlite --json
sciretriever storage schema-inspect --catalog /absolute/data/catalog-before-v9.sqlite --json
```

inspect 与 dry-run 使用只读连接；不创建目录、catalog、备份、写锁 sidecar、receipt 或任务。它们只接受完整的 v1–v9 identity/fingerprint、实际 DDL、SQLite integrity/foreign key 与 execution 子 schema；未知、漂移和损坏拒绝。`--dry-run` 不能同时给 `--backup`。

真正升级必须给 `--backup`，且备份不能是 catalog 本身、其他目录或已有文件。工具在整条链中持有与业务 writer 相同的规范 catalog 独占 flock，锁内复查源库；先用 SQLite `VACUUM INTO` 在私有 staging 建包含已提交 WAL 事实的一致性备份，读回验证并 fsync 后 create-if-absent 发布。备份目标发生竞争创建时拒绝覆盖。不要自行复制活动 WAL 作为备份。

v1/v2→v3→v4→v5→v6→v7→v8→v9 复用各版本迁移与其完整检查。每步单独使用 SQLite 事务，整链一直持锁，所有步骤使用同一原始版本备份；这不是整条链或文件系统与 SQL 的绝对原子事务。完整 v9 返回 `already-v9`，不创建备份。源文献 ID、元数据与 provenance、原件、相对引用及 hash 保持；升级不生成新的业务产物或默认索引。

写锁能拒绝遵守同一 catalog 写入准入的业务 writer；工具不能证明所有外部程序和 Browser 已停止。SQLite 锁与每步 data-version 检查只提供实际执行的检测范围，所以 operator 仍应先停止所有访问该目标的写端。

## 失败、续迁与备份恢复

命令成功退出 0，参数错误退出 2，安全/兼容/迁移拒绝退出 3。拒绝时 stderr JSON 的 `code` 为 `migration-refused`，`reason` 表达原因；已经进入迁移链的失败还返回 `progress`，含 `from_version`、实际可识别的 `current_version`、`completed_versions`、`failed_step` 和已确认的 `backup_path`。版本不可识别时 `current_version` 为 null，不猜测成功。

例如 v1→v3→v4→v5 已提交而 v6 事务失败，源库保持完整 v5，备份仍为原始 v1；工具不会自动恢复而丢弃已经确认的变化。停写后先 `schema-inspect` 源库与备份，再从 v5 使用**新的备份路径**续迁。已存在的旧备份始终不覆盖。

需要回到旧版本时，先保全当前 catalog、完整 ArtifactStore、候选/任务收束结果和所有切换后增量，保留原始版本备份。把备份复制到另一个未使用路径，运行 `schema-inspect` 并用对应版本的只读入口复核 ID、hash、来源和引用字节；Catalog 备份本身不包含资产字节。确认恢复可用后再按精确目标执行独立授权的切换。已有增量时不能直接覆盖唯一当前库，否则会遗失新元数据、资产关系、文档、知识或回执。具体切换、停 writer 和增量处置见[切换与回退](cutover.md)。

## 历史单步合成入口

`storage migrate --synthetic-copy` 的 v1→v2 execution 扩展，以及 `document-migrate`、`retrieval-migrate`、`extraction-migrate` 和内部知识单步迁移，继续保留合成目标核实与原有备份门禁。正式 `schema-init/schema-upgrade` 不要求把真实目标伪装成 `/tmp` fixture，也不放宽这些旧入口。单步演练见[文档 Catalog 合成迁移指南](document-catalog-migration.md)。
