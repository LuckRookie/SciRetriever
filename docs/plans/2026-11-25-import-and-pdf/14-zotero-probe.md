# 14 · Zotero 接口探测

类型：计划（结果块）
负责：在写 Zotero 适配器之前看清 Zotero 的接口实际返回什么；在写扩展的“从 Zotero 导入”之前确认扩展能否读到 Zotero 的本地接口与文件
状态：In progress（14.1 完成；14.2 的接口结构改由 07 的导入程序取得；14.3 只关系扩展这条路，等 Owner 运行探测扩展，G-probe）

计划 28（2026-11-25）：本块从[计划 25](../../archive/2026-11-16-before-processing/README.md) 搬来，块号与任务号沿用原来的；文中提到的计划 25 的其他块（12、13、18、20 等）已完成，在归档里。

Owner 2026-11-25：Zotero 两条路都做，扩展可以，Agent 也可以。接口返回什么（14.2、14.4）两条路共用，由 [07](07-zotero-import-program.md) 的导入程序在装了 Zotero 的电脑上运行一次得到，不必等探测扩展；扩展能否读到本地接口与文件（14.3）只决定 [16](16-extension.md) 的 16.4–16.6 怎么做。

来源：原计划 20 的 01（任务 1.1–1.4 改为 14.1–14.4）。
ADR 0063 之后：Zotero 的数据改由扩展读取（ADR 0063 第 6 节），不再假定由 Agent 读取。本块的首要结论是扩展能否读到本地接口与文件（ADR 0063“还没有验证的前提”第 1 条）。这个结论决定 16.4–16.6 的做法，以及规格中标为“待探测”的三点（文献与材料 6.4.9）。

## Outcome

- **首要结论**：
  - 扩展能否访问 Zotero 的本地接口；
  - 能否读到附件文件，包括 `/items/<key>/file` 给出的文件和本机路径上的文件；
  - 读不到文件时，请使用者选一次 Zotero 的数据文件夹（`storage/<附件编号>/`）是否可行。
- 一份探测结论，记在本块，覆盖：
  - 网络 API 与本地 API 的条目 JSON、`format=csljson` 或 `include=csljson`、分类、标签类型、版本号与分页；
  - 父条目的 `links.attachment`（首选附件），附件的 `linkMode`、文件名与 md5；
  - 本地 API 的 `/items/<key>/file` 怎样给出本机路径（重定向到 `file://` 还是别的）；
  - 批注能否用 `itemType=annotation` 列出，`annotationPosition` 的结构；
  - 网络 API 的 `Backoff`、`Retry-After` 与限流表现；Zotero 存储附件的下载方式。
- 库编号的形式（本地 API 里个人库的 `library.id` 是不是真实用户编号），以及没开同步时条目版本号的取值。
- 一组合成的假 Zotero 响应样本，供 15、16、17 的测试使用。样本里不含 Owner 文献库的任何内容。

## 进入条件

G1 已通过（2026-11-10）：Owner 说明了 Zotero 所在电脑，并同意探测。14.2、14.3 要 G-probe。

## 责任边界

总设计师。只写 `sandbox/cases/2026-11-09-zotero-probe/` 与本块。不改源码。

G1 的答复是：Zotero 与 4174 不在同一台电脑上。按 ADR 0063 第 6 节，Owner 的真实导入由自己电脑上的扩展读 Zotero 本地接口，再交给文献库。所以本地接口的格式，以及扩展能否读到文件，是 04 适配器与 19 扩展的主要依据。14.2 与 14.3 合并成一个开发者模式扩展，在 Owner 装 Zotero 的电脑上运行：Chrome、Edge 在 Windows 和 macOS 上用法相同，不需要 Node 或 `curl`。它同时探测本地 API 和网络 API；网络 API 用 Owner 当场粘贴的只读 key，key 不离开那台电脑。

## Tasks

- [x] **14.1 网络 API**：2026-11-10 从 4174 所在机器匿名读公开库，共约 60 次请求，未遇到 `Backoff`。可读的公开群组都只对成员开放，改用 Zotero 文档示例中的公开个人库。结论见下文。
- [ ] **14.2 Owner 文献库的结构**（与 14.3 合并为探测扩展）：扩展在 `sandbox/cases/2026-11-09-zotero-probe/extension/`，已打包交给 Owner（0.2.0：本地 API 的请求带 `Zotero-Allowed-Request` 头，并记录不带时的状态）。只发 GET，只输出字段名、类型与计数，不输出标题、作者、笔记、批注文字、文件名或路径。覆盖本地 API 与网络 API 的条目、CSL JSON、附件、文件访问、批注、分类、标签与群组，并统计 PDF 有多少在 Zotero 存储里。
- [ ] **14.3 扩展访问本地 API 与文件**：同一个扩展。结果里的 `local.root` 与各请求的状态，就是能否访问本地接口的结论；文件访问一项的状态，就是能否读到文件的结论。读不到文件时，在本块写明原因（权限、`file://` 跳转、链接附件），作为 19.6 与 12.21 的输入。
- [ ] **14.4 样本与结论**：网络 API 部分已写（`fixtures/web-api.json`，由 `make-fixtures.py` 生成），批注部分按 Zotero 的数据结构写，标为未验证；本地 API 部分等 14.2。按 14.1、14.2 的结构写合成样本（条目、分类、附件、批注、CSL JSON，各含边界情况：无 DOI、Extra 里的 arXiv 号、多 PDF、链接附件、独立 PDF、群组库），放在探测目录，04 开工时由后端实施者移进测试 fixture。

## 探测结论

来源标注：〔公开库〕为 2026-11-10 对公开个人库的匿名响应；〔文档〕为 Zotero 文档，未在真实响应中看到；〔未验证〕等 14.2。

网络 API：

- 4174 所在机器经本机代理能连上 `api.zotero.org` 和 Zotero 存储所在的 `zoterofilestorage.s3.us-east-1.amazonaws.com`。〔公开库〕
- 条目：`include=data,csljson` 在每个条目上附带 `csljson`；`format=csljson` 返回 `{"items": [...]}`，类型为 `application/vnd.citationstyles.csl+json`。CSL JSON 的 `id` 形如 `<库编号>/<条目编号>`。〔公开库〕
- 版本与分页：响应头有 `Total-Results`、`Last-Modified-Version`、`Link`（next、last）；`format=versions` 返回 `{编号: 版本}`；`since=<当前版本>` 返回 0 条；`/deleted?since=0` 返回 `collections`、`items`、`searches`、`tags`、`settings` 五个列表。〔公开库〕
- 分类：`data.parentCollection` 为 `false` 或父分类编号；条目的 `data.collections` 可有多个；`meta` 有 `numCollections`、`numItems`。〔公开库〕
- 标签：条目上手动标签没有 `type` 字段，自动标签 `type: 1`；`/tags` 的 `meta.type` 为 0 或 1。〔公开库〕
- 附件：`data` 有 `linkMode`（见到 `imported_file`、`imported_url`、`linked_url`）、`contentType`、`filename`、`md5`、`mtime`、`parentItem`；独立附件没有 `parentItem`；同一父条目可以有多个 PDF。〔公开库〕
- 首选附件 `links.attachment` 只在有文件读取权限时出现，带 `attachmentType`，文件在 Zotero 存储时还带 `attachmentSize`；附件自身的 `links.enclosure` 同理，文件在存储里时带 `length`。匿名读个人库不出现，读它的“我的出版物”时出现。〔公开库〕
- 文件：`/items/<编号>/file` 对存储里的文件返回 302，跳到 S3 的临时签名地址；文件不在存储里或无权限时返回 404。下载时跟随跳转，但不把 Zotero key 带到 S3。〔公开库〕
- 限流：`Backoff`、`Retry-After` 未出现，429 的表现只来自〔文档〕。
- 群组：结构与个人库相同，只是路径为 `/groups/<编号>`。匿名能列出的公开群组都只对成员开放，群组的真实响应〔未验证〕。
- 批注：公开库里没有批注，`itemType=annotation` 返回 0 条；`annotationPosition` 的结构〔未验证〕。

本地 API：全部〔未验证〕，等 14.2。

## 验证

结论逐项注明来源：公开群组库的实际响应、Owner 运行的脚本输出，或尚未验证。

## 退出条件

首要结论已经明确；其余各项都有结论或明确标为“未验证”。与 ADR 0057、ADR 0063 不符之处，先分清是 bug 还是设计问题；设计问题交总设计师与 Owner 讨论，再派 04 与 19.4。

## 恢复与交接

- 探测失败只影响本块与依赖它的 15、16.4–16.6 与规格中“待探测”的三点。
- 扩展读不到本地接口时，16.4–16.6 标为 Blocked，由总设计师回到 ADR 0063 第 6 节修改。15 先按网络 API 的格式实现，本地接口部分标为待验证，在 G-zotero 的真实导入中补验。
- 扩展能读本地接口、但读不到文件时，按 16.6 请使用者选一次数据文件夹。
