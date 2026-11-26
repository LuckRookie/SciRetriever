# 数据库初始化与恢复

类型：指南
负责：catalog 初始化与旧库离线切换（初始化与恢复）
状态：现行

SciRetriever 只维护一份当前数据库结构。正常打开与业务写入只接受当前布局，不自动迁移。专用离线脚本可校验其明确支持的旧布局，不形成运行时兼容分支或自动升级路径。结构指纹用于确认实际布局；仅修改数据库中的版本号不能完成转换。

普通打开只核对布局；需检查全部 SQLite 数据与外键时，显式运行 `sciretriever maintenance verify-catalog --json`。当前库即使没有全文索引也可检查；命令不修复或迁移，返回损坏时先保留证据，再安排恢复或索引维护。完整检查的范围、HTTP/MCP 入口及损坏提示见[存储完整性验证](../architecture/technical/07-versioned-storage.md#5-存储完整性验证)。

## 初始化和检查

```bash
sciretriever storage schema-inspect --catalog /absolute/data/catalog.sqlite --json
sciretriever storage schema-init --catalog /absolute/data/catalog.sqlite --json
```

检查不存在目标返回 `not-initialized`，不会创建文件。初始化要求父目录已存在、目标文件不存在；在临时文件中完整创建并检查后排他发布，不覆盖已有库。正常启动不会修改已有数据库布局。

`storage inspect` 查看已绑定库的运行时状态；`storage backup --path PATH` 生成一致性备份，目标必须不存在；`storage restore-check --path PATH` 检查当前格式的恢复副本。这些命令不获取文献、不运行解析或模型。

## 已有旧库

旧库采用明确的一次性转换：先确认精确 Catalog 与资产位置，保存一致性备份，在副本转换，再核对元数据、来源、稳定 ID、关系和资产引用。原始 PDF、解析原件和不可变产物的字节不被原地改写。旧格式派生结果不能被伪装成新流程的有效结果，应保留原始备份及明确的处置记录。

当前安装包不提供历史逐级升级命令。转换脚本仅针对已经确认的源库布局，不在生产中形成长期兼容分支。本机一次性操作的材料和报告不随安装包分发。

## 切换与恢复

转换副本核对通过后，停止使用旧库的服务和任务，确认没有新提交，再切换文件和程序。SQLite 一致性备份必须包含已提交 WAL 事实，不能仅复制活动主库文件。Catalog 备份不包含资产字节；资产目录和相对路径须另外保全。

切换后需要恢复时，先保存当前库及新增事实，不直接用旧备份覆盖唯一副本。旧格式备份只能在独立环境中读取或再次转换，不能交给当前程序强行写入。具体步骤见[数据库切换](cutover.md)。

历史全文版本的只读解码与 catalog 布局迁移是两件独立的事。

## 状态投影 schema 13

这一步把库迁到 13 布局，之后依次运行 `scripts/migrate-reading-marks-v14.mjs`、`scripts/migrate-intake-v15.mjs` 与下文各节的迁移，到当前的 19；当前程序只打开 19。先停止服务与 queued/running 任务、保存一致性备份，并在独立副本演练；构建服务端后，对绝对路径运行：

```sh
# 仅当输入还是精确匹配的 schema 11，先做固定的建档转换。
node scripts/migrate-archive-v12.mjs /absolute/path/to/offline-copy.sqlite
# 输入须是精确匹配的 schema 12。
node scripts/migrate-library-state-v13.mjs /absolute/path/to/offline-copy.sqlite
```

12 → 13 工具只安装按篇状态失效提示与索引，不读个人配置、不调用模型、不改文献资产。它校验精确旧布局、SQLite 完整性与外键，事务内更新结构，核对所有旧表行数不变、新提示表为空；有运行中任务、未知结构或重复执行时拒绝。核对回执后再按前述步骤安排正式切换，不能只改版本号，也不能让旧程序继续写入新库。布局定义与派生状态规则见[存储技术合同](../architecture/technical/07-versioned-storage.md#41-当前-schema-与显式转换)。

## 统一入库与两级文本 schema 16、17

schema 15 的库先依次运行两个离线迁移到 17，再按下一节迁移到 19；先停止服务与 queued/running 任务、保存一致性备份，并在独立副本演练，构建服务端后对绝对路径运行：

```sh
# 输入须是精确匹配的 schema 15。
node scripts/migrate-import-v16.mjs /absolute/path/to/offline-copy.sqlite
# 输入须是精确匹配的 schema 16。
node scripts/migrate-draft-text-v17.mjs /absolute/path/to/offline-copy.sqlite
```

两个工具都不读个人配置、不调用模型、不改文献资产。它们校验精确旧布局、SQLite 完整性与外键，事务内更新结构，核对全部旧表行数不变；有运行中任务、未知结构或重复执行时拒绝，失败时库保持原布局、可以重跑并保留原始错误。16 → 17 原地重建文档版本表，校订稿、内容版本、加工结果的过时状态与全文索引不变，新表为空，不形成初稿。

迁移后，已有原始解析的文献还没有初稿。用补形成维护操作显式形成，先预览再提交，可以取消，重新发起即续做：

```sh
sciretriever form-drafts preview --request request.json
sciretriever form-drafts start --request request.json
```

请求的范围用文献库筛选写明（[文档与证据 8.11](../architecture/technical/04-document-evidence.md#811-补形成初稿的维护操作)）；它不解析、不调用模型。

## 用户整理与引用上限 schema 18、19

当前程序只打开精确匹配的 19 布局。schema 17 的库依次运行两个离线迁移，准备与核对同上一节：

```sh
# 输入须是精确匹配的 schema 17。
node scripts/migrate-user-organization-v18.mjs /absolute/path/to/offline-copy.sqlite
# 输入须是精确匹配的 schema 18。
node scripts/migrate-citation-limits-v19.mjs /absolute/path/to/offline-copy.sqlite
```

17 → 18 加入保存的筛选、批注的重新定位与设备连接的类型；18 → 19 让引用扩展的结果上限与扫描上限可以不填，已有上限原样保留。布局见[存储技术合同](../architecture/technical/07-versioned-storage.md#41-当前-schema-与显式转换)。

## 结构追加

新版本有时只给当前结构追加索引或表，不改已有数据。这类变化不走整库转换，而是一条显式命令。库里缺少新版本需要的追加时，启动和 `storage schema-inspect` 会以 `catalog-addition-required` 拒绝，并写出缺的那一项的名字。处理办法：停掉 Web 服务和其他写入，然后执行

```bash
sciretriever storage schema-apply --catalog /absolute/data/catalog.sqlite --addition <名字>
```

命令只做追加，在一个事务里完成。已经追加过的一项再执行会以 `catalog-addition-already-applied` 拒绝，库不受影响。追加之后旧版本仍能照常读写这个库，所以换回旧构建不需要撤销；例外是 `document-translations`，它重建了一张表，要先停服再执行，执行之后旧版本不能打开这个库，换回旧构建要先恢复执行前的备份。执行并换上新版本之后，检索结果会标“索引不是最新”，因为中文、日文、韩文改为按字检索：执行一次 `sciretriever maintenance rebuild-index` 重建全文索引，再执行一次 `sciretriever maintenance rebuild-library-search` 重写书目检索的行。两条命令都可以在服务运行时执行，重建完成之前检索照常可用，只是中文的部分词查不到。在一个 35 万篇、绝大多数只有书目的库上，前一条用了约 2 小时，后一条约 5 分钟。每个版本要追加哪一项，见[更新记录](../../CHANGELOG.md)。

缺几项时，按 `catalog-addition-required` 报出的名字逐项执行，每次一项。`library-trash` 加入文献的“最近删除”（一张空表、一个索引和九个触发器，见[存储 7](../architecture/technical/07-versioned-storage.md#7-运行审查存储)）：

```bash
sciretriever storage schema-apply --catalog /absolute/data/catalog.sqlite --addition library-trash
```

旧构建不认识最近删除：换回旧构建时库照常可读写，但已删除的文献会在旧构建里照常显示，它重算过的计数也可能把它们算进去。

## Web 守护的首次切换与程序升级

“应用配置”只重建当前程序的运行时，不构建程序、不替换文件、不迁移数据库。升级程序仍需正常停止旧服务、保全一致性备份、核对副本与资源后再启动；不要运行中覆盖父子程序文件。

首次从旧版直接 `node … web` 切换时：

1. 阻止新的提交，确认 queued/running 均为零，前台工作、probe 和 Browser 传输也已完成；旧直接进程没有新的交接屏障，不能仅凭一次查询为零保证没有外部写入者。
2. 按既有备份和副本流程核对 catalog/资产及 schema；正常停止旧进程，并等 PID 真退出。不要用应用配置按钮执行程序升级或库迁移。
3. 以原来的 `web --port …`、host、密码注入方式和 Cloak 路径启动已核对的新程序。tmux 此后持有的是守护父 PID；父不会转入后台，也不需要增加 systemd。
4. 重新登录，核对生效来源/运行代次。用临时 home 和回环端口验证过的生命周期不能代替真实来源、模型和站点权限验收。

后续升级正常停止父进程并等待子进程清理；启动 schema、端口、资源或 IPC 检查失败会停止，不会自动迁移、换端口或无限拉起。回退前先保存本轮新增事实，不能拿旧格式唯一备份覆盖现有库。
