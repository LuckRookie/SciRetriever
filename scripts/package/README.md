# 便携包构建

保存便携分发包的构建、依赖收集和运行清单装配工具。

## 内容入口

- [build-portable.mjs](build-portable.mjs)：由 pnpm package:portable 调用的打包入口。

## 放置边界

读取 workspace 构建结果和 release/manifests；不将个人配置、真实 catalog、文献资产或 sandbox 打进分发包。

相关说明：[发布运行清单](../../release/manifests/README.md)；[安装与分发说明](../../docs/guides/installation.md)。

[上级目录](../README.md) · [项目 README](../../README.md)
