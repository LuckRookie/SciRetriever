# 命令行入口

将人类或自动化调用的命令行参数转换成统一应用操作，并呈现结果、退出码与配置交互。

## 内容入口

- [main.ts](main.ts)：命令树、参数解析和入口分派。
- [browser-session.ts](browser-session.ts)：持续机器连接的有界 NDJSON 适配；按行返回结果，退出时撤销会话。
- [config-center.ts](config-center.ts)：配置中心操作。
- [config-ui.ts](config-ui.ts)：终端配置界面。

新增的文档、知识、综合、上下文、提取、任务观察与非交互配置命令使用 `--request FILE|-` 输入封闭业务请求；结果为 `{protocol_version:1,result}`。`jobs runtime` 操作显式连接的 Web 执行器，`browser session` 可持续观察和控制其 Browser。既有命令保持兼容。具体语法与能力范围见[Agent 指南](../../../../docs/guides/agent-interface.md)。

## 放置边界

业务流程复用 Application/Entry，配置规则归 configuration；不要在命令分支中复制下载或解析实现。

相关说明：[所属技术文档](../../../../docs/architecture/technical/01-product-interface.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)

`processors` 命令族提供 list/submit/run、结果与集合查询、字段证据、导出、rebuild 和 retain；精确参数见[统一知识加工指南](../../../../docs/guides/knowledge-processors.md)。
