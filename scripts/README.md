# 项目构建工具

类型：导航与文档规则
负责：构建、打包与独立文档检查入口
状态：现行

保存随项目维护的构建、发布与显式维护工具。

## 下级目录

| 目录                          | 职责               |
| ----------------------------- | ------------------ |
| [package/](package/README.md) | 便携包构建         |
| [vendor/](vendor/README.md)   | 随包第三方程序构建 |

## 内容入口

- [check-docs.mjs](check-docs.mjs)：独立运行 `node scripts/check-docs.mjs`；检查现行文档头部、本地链接、Markdown锚点和明确的归档现行依据引用；状态拒绝泛化套话，负责主题不能逐字复述标题（目录 README 与 Provider Notes 除外）。源码 README 只检查链接和源码树边界。未接入Quick。

- [prune-retired-runtime.mjs](prune-retired-runtime.mjs)：正式 build 在 TypeScript 编译后只移除已退役 `parsing/service` 与 `parsing/publication` 的 JS、声明及 map 文件；拒绝输出目录/目标文件符号链接，保留其它产物。安装包回归验证旧模块不会经 dist glob 再次分发。

- [build-reader-assets.mjs](build-reader-assets.mjs)：与正式构建及测试共用的阅读模块、worker、字体/样式和许可文件打包。
- [build-workbench-assets.mjs](build-workbench-assets.mjs)：从 Web 源码构建 bundle，将指定页面/样式放入应用构建目录。
- [build-react-assets.mjs](build-react-assets.mjs)：调用 Vite 固定以 production 模式构建 React 入口，即使调用方为 NODE_ENV=test；完成后恢复调用方环境。生成静态资源白名单、收集运行时依赖许可，并在阅读器许可基础上发布合并声明。先完整生成到系统临时目录，再逐文件原子发布，HTML 和白名单最后发布；随后移除 `assets/` 中不再被白名单引用的旧 Vite hashed 文件，防止历史构建资源进入安装包。输出根目录与 `assets/` 必须是实际目录，不接受符号链接；清理不处理其它文件或链接。
- [build-sample-assets.mjs](build-sample-assets.mjs)：构建仅内存的 React Browser 合成样例；`@sciretriever/web preview` 使用该入口，保持 `connect-src 'none'`。

- [migrate-archive-v12.mjs](migrate-archive-v12.mjs)：构建服务端后，显式对一个离线 catalog 副本执行 11 → 12；校验精确旧布局，在事务中扩展 archive_steps 的步骤 CHECK，更新版本/指纹并核对全部表行数与外键。只接受绝对路径，不自动迁移或重建文献，正式切换前须先备份并在副本演练。
- [migrate-library-state-v13.mjs](migrate-library-state-v13.mjs)：对精确匹配的离线 12 库安装按篇状态失效提示、反向索引和当前 13 身份，完整校验并保持全部旧表行数；只接受绝对路径，打开库不会调用它。旧建档转换工具仍固定到 12，之后显式使用本工具。

- [migrate-intake-v15.mjs](migrate-intake-v15.mjs)：构建 server 后对绝对路径的离线 14 库执行 14 → 15；在同一事务中回填批次、重解释主题词、重投影作者关键词并更新全文索引。保留文献、观测与来源 hash，核对旧事实行数及外键；正式执行前必须完整备份并先在副本演练。

## 放置边界

一次性调试与真实测试脚本进入 sandbox/cases；业务逻辑进入 apps 或 packages，避免藏在构建脚本里。

[项目目录地图](../README.md#项目目录地图)

阅读器构建先写入系统 `sciretriever-reader-build-*` 临时目录，再通过输出根目录 `.reader-publish-*` 下无扩展名文件逐个 rename 发布并清理临时目录；并发打包不会读到 `fs.cp` 覆盖期间消失的字体／CMap 文件。临时目录不匹配 server 包声明的正式资源路径。
