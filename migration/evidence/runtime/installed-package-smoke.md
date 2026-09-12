# 已打包模块的本地安装与启动 smoke

2026-09-10。`package-entrypoints.test.ts` 先构建并打包实际 `@sciretriever/contracts` 与 `@sciretriever/server` tarball，
连同锁定的 runtime 依赖在系统临时目录离线安装。测试不使用源码 alias，确认安装包不含 `src/`、`test/` 或
tsbuildinfo，并拒绝未导出的内部子路径。

安装后的 Node 进程使用公开 API 在新的临时 home 创建真实 Application/SQLite/FileStore，创建 WorkbenchSession，
在随机 loopback 端口启动鉴权 HTTP server，读取打包内公开边界提供的合成 HTML，然后按所有权逆序关闭 HTTP、Session
和 Application。临时 home 最后清理。整个过程不访问 Provider、真实 Browser、用户 home 或凭据。

这证明当前 contracts/server 开发包可以离线安装并完成最小启动、loopback HTTP 和关闭。后续
[安装包 Web 静态资产测试](installed-web-assets.md)已把 HTML/CSS/JS 纳入同一 server tarball smoke，并验证 MIME、
鉴权 HTTP 启停和 package exports。目标 Cloak 二进制与 Python bridge 仍由 operator 环境提供；npm tarball 自含
这些运行依赖以及安装包内 Browser→MinerU→Analysis 全链路明确 Deferred，不影响 source-checkout 首阶段闭环。
