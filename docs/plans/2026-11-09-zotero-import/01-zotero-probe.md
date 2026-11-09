# 01 · Zotero 接口探测

类型：计划（结果块）
负责：在写合同之前，看清两种 Zotero API 实际返回什么
状态：Pending（等 G1）

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

## Tasks

- [ ] **1.1 网络 API**：对一个公开的 Zotero 群组库做匿名只读请求（不需要 key），记录上面列出的网络 API 各项。请求次数控制在几十次以内，遵守 `Backoff`。
- [ ] **1.2 本地 API**：写一个探测脚本，Owner 在装有 Zotero 7 的电脑上运行。脚本只依赖 Node 或 `curl` 其一，只输出结构与计数（字段名、类型、条目数、附件与批注数），不输出标题、作者、笔记、批注文字或文件名。Owner 把输出交给 Claude。
- [ ] **1.3 扩展访问本地 API**：一个只有十几行的开发者模式扩展，在后台请求 `localhost:23119/api/users/0/items?limit=1`，Owner 加载后点一下，报告状态码。
- [ ] **1.4 样本与结论**：按 1.1、1.2 的结构写合成样本（条目、分类、附件、批注、CSL JSON，各含边界情况：无 DOI、Extra 里的 arXiv 号、多 PDF、链接附件、独立 PDF、群组库），放在探测目录，02 开工时由 Codex 移进测试 fixture。

## 验证

结论逐项注明来源：公开群组库的实际响应、Owner 运行的脚本输出，或尚未验证。

## 退出条件

上述各项都有结论或明确标为“未验证”。与 ADR 0057 不符之处先分清是 bug 还是设计问题；设计问题拿去和 Owner 讨论，再派 02。

## 恢复与交接

探测失败只影响本块。本地 API 拿不到时，02 先按网络 API 的格式实现，本地 API 部分标为待验证，在 09 的真实导入中补验。
