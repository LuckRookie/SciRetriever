# 用户教程

本目录只放面向 SciRetriever 使用者的教程。

- [SciRetriever 用户手册](user-manual.md)：从安装和配置开始，完成 metadata 建库、全文获取、PDF 分析、引用扩展、整理、导出和排障。
- [SciRetriever 配置手册](configuration.md)：解释配置选择与覆盖规则，为全部字段提供示例值，并说明 Provider 凭据、安全边界和启用条件。
- [完整配置模板](config.toml)：覆盖 strict parser 全部字段的逐项注释模板。
- [最小配置模板](config.minimal.toml)：保留全部凭据入口的 metadata 启动模板。

命令参数发生变化时，先以 `sciretriever <command> --help` 为准，再同步更新用户手册；配置 schema 或默认值变化时同步更新配置手册和本目录两份 TOML 模板。
