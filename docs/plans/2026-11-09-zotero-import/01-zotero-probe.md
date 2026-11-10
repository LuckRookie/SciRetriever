# 01 · Zotero 接口探测

类型：计划（结果块）
负责：在写合同之前，看清两种 Zotero API 实际返回什么
状态：In progress（1.1 完成；1.2、1.3 等 Owner 运行探测扩展）

## Outcome

- 一份探测结论，记在本块，覆盖：
  - 网络 API 与本地 API 的条目 JSON、`format=csljson` 或 `include=csljson`、分类、标签类型、版本号与分页；
  - 父条目的 `links.attachment`（首选附件），附件的 `linkMode`、文件名与 md5；
  - 本地 API 的 `/items/<key>/file` 怎样给出本机路径（重定向到 `file://` 还是别的）；
  - 批注能否用 `itemType=annotation` 列出，`annotationPosition` 的结构；
  - 网络 API 的 `Backoff`、`Retry-After` 与限流表现；Zotero 存储附件的下载方式。
- 浏览器扩展能否访问本地 API 的结论（只记录，不在本计划内实现）。
- 一组合成的假 Zotero 响应样本，供 02、03、07 的测试使用。样本里不含 Owner 文献库的任何内容。

## 进入条件

G1：Owner 说明 Zotero 所在电脑，并同意探测；Owner 授权开始实施。

## 责任边界

Claude。只写 `sandbox/cases/2026-11-09-zotero-probe/` 与本块。不改源码。

G1 答复是 Zotero 与 4174 不在同一台电脑上，所以 Owner 的真实导入走网络 API，本地 API 只服务同机的用户。为此 1.2 与 1.3 合并成一个开发者模式扩展，在 Owner 装 Zotero 的电脑上运行：Chrome、Edge 在 Windows 和 macOS 上用法相同，不需要知道系统、也不需要 Node 或 `curl`；它同时探测本地 API 和网络 API，网络 API 用 Owner 当场粘贴的只读 key，key 不离开那台电脑。

## Tasks

- [x] **1.1 网络 API**：2026-11-10 从 4174 所在机器匿名读公开库，共约 60 次请求，未遇到 `Backoff`。可读的公开群组都只对成员开放，改用 Zotero 文档示例中的公开个人库。结论见下文。
- [ ] **1.2 Owner 文献库的结构**（与 1.3 合并为探测扩展）：扩展在 `sandbox/cases/2026-11-09-zotero-probe/extension/`，已打包交给 Owner。只发 GET，只输出字段名、类型与计数，不输出标题、作者、笔记、批注文字、文件名或路径。覆盖本地 API 与网络 API 的条目、CSL JSON、附件、文件访问、批注、分类、标签与群组，并统计 PDF 有多少在 Zotero 存储里。
- [ ] **1.3 扩展访问本地 API**：同一个扩展，结果里的 `local.root` 与各请求状态即结论。
- [ ] **1.4 样本与结论**：网络 API 部分已写（`fixtures/web-api.json`，由 `make-fixtures.py` 生成），批注部分按 Zotero 的数据结构写，标为未验证；本地 API 部分等 1.2。按 1.1、1.2 的结构写合成样本（条目、分类、附件、批注、CSL JSON，各含边界情况：无 DOI、Extra 里的 arXiv 号、多 PDF、链接附件、独立 PDF、群组库），放在探测目录，02 开工时由 Codex 移进测试 fixture。

## 探测结论

来源标注：〔公开库〕为 2026-11-10 对公开个人库的匿名响应；〔文档〕为 Zotero 文档，未在真实响应中看到；〔未验证〕等 1.2。

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

本地 API：全部〔未验证〕，等 1.2。

## 验证

结论逐项注明来源：公开群组库的实际响应、Owner 运行的脚本输出，或尚未验证。

## 退出条件

上述各项都有结论或明确标为“未验证”。与 ADR 0057 不符之处先分清是 bug 还是设计问题；设计问题拿去和 Owner 讨论，再派 02。

## 恢复与交接

探测失败只影响本块。本地 API 拿不到时，02 先按网络 API 的格式实现，本地 API 部分标为待验证，在 09 的真实导入中补验。
