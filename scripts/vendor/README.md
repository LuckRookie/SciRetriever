# 随包第三方程序

类型：导航与文档规则
负责：随包第三方程序的固定版本源码构建
状态：现行

保存从官方源码构建随包第三方程序的脚本。

## 内容入口

- [build-mupdf.mjs](build-mupdf.mjs)：`pnpm vendor:mupdf`。下载固定版本的 MuPDF 源码包（或用 `--source` 指定本地副本），校验 SHA-256 后只用其自带第三方库静态编译 `mutool`，输出 `bin/mutool`、AGPL 文本 `COPYING` 和记录源码地址、摘要、编译选项与可执行文件指纹的 `manifest.json`。输出目录已存在时拒绝覆盖。

## 放置边界

产物写入被忽略的 `build/vendor/`，不提交进仓库；便携包打包时复制。程序运行时的定位与校验在 `apps/server/src/proofread/mupdf.ts`。

相关说明：[安装指南](../../docs/guides/installation.md)；[第三方声明](../../NOTICE)。

[上级目录](../README.md)
