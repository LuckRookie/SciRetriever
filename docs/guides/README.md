# 用户教程

本目录只索引当前实现能够支持的用户文档。SciRetriever 目前是程序内使用的 Python 包，没有受支持的终端用户 CLI。历史命令不能作为当前运行入口，也不能从旧命令推断现有 Service 能力。

- [项目 README](../../README.md)：说明安装、导入、公开 Service、配置责任和外部服务边界。
- [SciRetriever 配置手册](configuration.md)：说明 `schema_version = 2` 的十个严格配置组、字段约束、路径规则和 secret reference 边界。

本目录不保留旧命令手册或独立配置模板。配置手册中的最小结构只用于解释合同，不能单独证明 provider、parser 或其它外部能力已经接入。

当前公开 Service 以 `src/sciretriever/services/*/__init__.py` 的导出为准。运行配置和具体实现选择由 `src/sciretriever/composition/configuration/` 与 `src/sciretriever/composition/wiring/` 负责。配置 schema、默认值、Composition 入口或 Service 导出变化时，必须同步核对本目录文档和项目 README。
