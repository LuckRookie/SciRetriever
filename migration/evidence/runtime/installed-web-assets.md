# 安装包 Web 静态资产边界

2026-09-10。`scripts/build-workbench-assets.mjs` 将 `live.ts` 与 `live.html`、`styles.css`、`live.css` 构建到
`apps/server/dist/web`，`apps/server/src/workbench/assets.ts` 只从安装包旁的 build-owned 目录读取；它不回退
到 checkout 源码，也不扫描任意路径。server tarball 明确包含 HTML/CSS/JS，package exports 仍只公开稳定入口。

`packages/contracts/test/package-entrypoints.test.ts` 在系统临时目录打包并离线安装实际 workspace tarball，检查：

- `/`、`/styles.css`、`/live.css`、`/live.js` 从安装包可读取且 MIME 正确；
- 打包 JS 包含 Candidate abandon endpoint，安装后的鉴权 Workbench HTTP 可以启动和关闭；
- 安装包没有 `src/`、`test/` 或 `tsbuildinfo`，内部子路径导入被 package exports 拒绝；
- 临时 home、catalog、FileStore 和 session 按逆序关闭并清理。

这项证据证明静态 Web 工作台已经进入 server 安装包。目标 Cloak 二进制仍由 operator 环境提供，不随 npm
包发布；Browser→实际 MinerU→Analysis 的 source-checkout 联合旅程见
[Browser→MinerU→Analysis](browser-mineru-analysis-journey.md)。
