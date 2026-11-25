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
- [migrate-import-v16.mjs](migrate-import-v16.mjs)：构建 server 后，对显式绝对路径的离线 schema 15 库执行 15→16；单事务追加设备认证、通用导入会话/外部对应及收藏按日批次/请求表，核对旧表行数和外键，不伪造历史来源对应。16 输出已冻结，运行入口不自动迁移；正式执行前须另行授权、停服和备份。
- [migrate-draft-text-v17.mjs](migrate-draft-text-v17.mjs)：构建 server 后，对显式绝对路径的离线 schema 16 库执行 16→17；重建文档版本父表，增加初稿当前指针、版本事实和“找不到”引用投影。保持全部旧表行数、校订稿字段、内容版本事件、加工结果过时状态和索引不变；完整布局/完整性/外键核验后提交。不读取个人配置、不访问 artifact、不形成初稿；失败保留原始异常并回滚，可重跑。正式执行须另行授权。
- [migrate-user-organization-v18.mjs](migrate-user-organization-v18.mjs)：构建 server 后对显式绝对路径的离线精确 schema 17 库执行 17→18，增加保存筛选与批注定位缓存两表；核对旧表行数、布局、完整性和外键，不访问资产或个人配置，失败保留原始异常并回滚。正式执行须另行授权。
- [cleanup-openalex-top-concepts.mjs](cleanup-openalex-top-concepts.mjs)：构建 server 后对绝对路径的离线当前 schema 库清理旧 OpenAlex 顶层大类，单事务重排观测 ordinal、按篇重投影并同步 Library FTS；可重复运行，无 schema 变更。正式执行须先停服和完整备份，先在独立副本演练；全量检索索引由既有增量刷新追赶，不在此脚本重建。
- [recover-suzuki-citation-checkpoint.mjs](recover-suzuki-citation-checkpoint.mjs) 在停写且 WAL 已清空的 catalog 核对并恢复 `processing-2b51707b3af941d8f870ac66dcef06f6` 的引用检查点，默认只读试算，`--apply` 分段写入后复核回放。

## 放置边界

一次性调试与真实测试脚本进入 sandbox/cases；业务逻辑进入 apps 或 packages，避免藏在构建脚本里。

[项目目录地图](../docs/development/repository-map.md)

阅读器构建先写入系统 `sciretriever-reader-build-*` 临时目录，再通过输出根目录 `.reader-publish-*` 下无扩展名文件逐个 rename 发布并清理临时目录；并发打包不会读到 `fs.cp` 覆盖期间消失的字体／CMap 文件。临时目录不匹配 server 包声明的正式资源路径。
