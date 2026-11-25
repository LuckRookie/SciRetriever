# 持续集成工作流

保存 GitHub Actions 的工作流定义。

## 内容入口

- [ci.yml](ci.yml)：普通非 master 分支 push 执行 TS Quick；PR、master push 和手动运行执行 TS Full。

相关说明：[验证与协作规则](../../HARNESS.md)。

## 放置边界

本地开发命令由根 `package.json` 定义；一次性测试脚本与真实连接记录放在本机 `sandbox/`。

上一级的 `.github/` 不放 `README.md`：GitHub 会优先把它显示成仓库首页，盖住根目录的 README。它的说明在[仓库目录地图](../../docs/development/repository-map.md)。

[仓库目录地图](../../docs/development/repository-map.md) · [项目 README](../../README.md)
