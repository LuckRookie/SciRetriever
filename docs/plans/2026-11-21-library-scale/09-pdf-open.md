# 09 · 打开 PDF

类型：计划（结果块）
负责：阅读页打开 PDF 时第一页尽快出来
状态：Done（待部署）

## 现状

- 前端先整份下载 PDF，再在浏览器里核对大小与 SHA-256，然后才把完整字节交给 pdf.js（`apps/web/src/reading/transport.ts` 的 `readPdfBytes`；`apps/web/src/reading/pdf.ts` 的 `getDocument`）。没有分段或流式加载，也没有浏览器缓存（进程内有一个小的内存缓存）。
- 打开前的材料查询和读字节请求，与其他 Web 读请求排在同一个工作线程上（见 08）。
- 时间到底花在哪一段还没测（02.1）。

性质：排队部分随 03–08 解决；“先校验完整再显示”还是“边下载边显示”是设计问题（B6）。这一块与总篇数无关，但它是 Owner 点名的体验问题。

## Outcome

- 打开 PDF 到第一页出现的耗时达到 B11 的目标，大 PDF 与小 PDF 分别给出；再次打开同一份 PDF 基本立即出现。
- 显示的文件与记录一致；校验失败时的页面行为按 B6 的决定写进[阅读体验](../../architecture/web/reading-experience.md)。

## 进入条件

02.1 的分段测量；B6 的决定（已定，见 [ADR 0065](../../architecture/decisions/0065-scale-rules.md) 第 6 节）。不需要迁移。

## 责任边界

- 前端：阅读页的加载方式与缓存。后端：若需要，读字节接口支持分段请求（HTTP Range）与按内容地址的缓存头。

## Tasks

做法见 [ADR 0065](../../architecture/decisions/0065-scale-rules.md) 第 6 节第 6 条。按 02.1 的分段测量决定先做哪一项。

- [x] **9.1 分段读取（后端）**：PDF 字节接口支持 HTTP Range，并按内容地址给出可长期缓存的响应头。
- [x] **9.2 边下载边显示（前端）**：pdf.js 按段请求，第一页先显示；完整 SHA-256 在后台计算。
- [x] **9.3 校验失败**：校验不通过时页面换成“文件与记录不一致”，停止显示，缓存作废；写进阅读体验的传输一节。
- [x] **9.4 测试**：大、小 PDF 的第一页耗时；再次打开的耗时；校验失败的页面；阅读体验验收表“不重复下载”一行继续成立。

## 进度

- 2026-11-22：9.1 完成（后端实施者，一轮）。新增 `GET /api/v1/query/material-bytes/:literature_id/:asset_id/:asset_sha256`，写进[产品接口](../../architecture/technical/01-product-interface.md)的查询路由表；POST 不变。总设计师复跑 material-bytes-range 8、extraction-delivery 18、artifact-reclamation 17、artifact-recovery 12、device-connections 13、workbench-http 2，`pnpm build` 通过。document-read 的“外部 DDL 后重新核对”用例偶发 `database is locked`，在 9.1 之前的提交上 8 次也失败 1 次，不是 9.1 引入的，记为 14.2 的后续项。报告 `sandbox/reports/2026-11-22-pdf-range/REPORT.md`。
- 02.1 的分段测量仍等 Owner 的 Chrome 与 4174 登录；9.2 先按 ADR 的做法实施，测量后再看是否调整。
- 2026-11-22：9.2–9.4 完成（前端实施者，两轮）。做法写进[阅读体验](../../architecture/web/reading-experience.md) 5.1 与 6.3（失败行为放在 6.3，不另开传输一节）。pdf.js 按 64 KB 块经 GET 读取，第一页先显示；整份 sha256 在后台算一次，校验完成前“下载 PDF”停用并说明原因；校验失败整页换成“文件与记录不一致”，本机记下这份 PDF，之后绕过浏览器缓存重取。负载 9–13 下（只作参考）：20 MB PDF 第一页前只收到 0.34 MB，从首个请求到第一页 806 → 595 ms，40 Mbit/s 慢链路 4,622 → 1,280 ms；请求的总字节等于文件大小；同一页面再次打开 0 个请求，约 0.3 s。总设计师在主工作树复跑 reading-pdf-bytes 12、reader-pdf-progressive 2、next-reader 11、next-reader-boundaries 11、next-query-parity 2、next-retrieval 7，`pnpm build` 与 `pnpm typecheck` 通过。报告 `sandbox/reports/2026-11-22-pdf-progressive/REPORT.md`。
- 2026-11-23：跨页面缓存修好（后端实施者，一轮）。material-bytes GET 的 client_id 改放在请求头 `X-Sciretriever-Client-Id`，URL 不带查询参数，准入不变；阅读页经共享下载器发这个头。Chromium 上两次加载的 PDF 地址相同，约 20 MB 的 PDF 重载 3 次，每次 16 段全部命中缓存；条件请求返回 304。总设计师复跑 6 个文件 49 项通过，`pnpm build` 通过。报告 `sandbox/reports/2026-11-22-pdf-cache/REPORT.md`。
- 残余：
  - （已修，见上）跨页面缓存不命中：`client_id` 在 URL 查询里，每次加载页面都变，重新加载后浏览器缓存命中为 0。要让 GET 的准入不依赖 URL 里每页都变的值（例如改用请求头或 Cookie），归后端。
  - 页字典与内容交错的大 PDF，在快链路上第一页反而变慢（920 → 1,536 ms），原因是 pdf.js 显示第一页前要读全部顶层页字典；慢链路上仍更快。
  - 非安全上下文（经 HTTP 的 IP 访问）里整份 sha256 在主线程同步计算，20 MB 时有一次长任务。

## 退出条件

14.4 的复测中打开 PDF 达到目标。
