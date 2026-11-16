# 04 · 后端：整篇校验的证明缓存

类型：计划（结果块）
负责：verified reader 跨请求复用整篇校验结果
状态：Done

## Outcome

同一文档版本的后续读取不再重算 PDF 与全部图片的 hash，也不再重建结构；闭包里任一文件变化就完整核验。

## 背景

阅读器每个请求都经 `withVerifiedDocument` 把整篇闭包核验一遍，大文档每请求多 0.2–0.6 s，是 02 未达 20 秒目标的主要服务端成本。Owner 2026-11-05 决定加缓存，原“不使用跨请求验证缓存”的规则随之改变。

## 责任边界

Codex：`apps/server/`、对应测试与源码 README。Claude：`docs/architecture/technical/04-document-evidence.md`。

## Tasks

- [x] **4.1 证明缓存**：按版本与 representation hash 缓存，比对闭包文件指纹，有界 LRU。
- [x] **4.2 交付字节**：交给调用方的资源仍逐字节核验。
- [x] **4.3 文档**：源码 README 与技术文档同步。

## 验证

直接测试：命中不读 PDF/图片；改写、回拨 mtime、换 inode 都重新核验；失败不留证明；上限生效。用 02 的合成长文对比改前改后。

## 退出条件

回执 `DONE.md` 给出提交、规则、残余风险与测量。

2026-11-05 已满足：`96b5faf`，回执 `sandbox/reports/2026-11-05-plan19-04/`。正文 HTTP 请求累计：26 MB PDF / 98 图 25.4 s → 8.9 s，无图 7.4 s → 2.2 s；首个请求因多做指纹确认略慢。浏览器整篇加载 37.4 s → 31.3 s，主线程长任务仍约 23 s。
