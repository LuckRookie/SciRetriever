# 服务端回归测试

保存 核心业务、适配边界、SQLite/文件持久化、应用组装与安装后旅程 的可重复离线回归。测试以 *.test.ts 命名，fixture/helper 与测试就近存放。

`dsh-foundation.test.ts` 使用真实 DSH 服务与合成模型响应，验证单次请求确经原生 LlmRuntime、schema/模型设置保留、纯文本和多图会话、证据工具反馈、会话隔离、稳定失败与关闭结算。现有 `dsh-runtime` 和 Browser/Analysis/综合/配置回归继续覆盖各消费者；fake 反馈正确不表示真实模型的科研内容质量已提升。

三端一致性测试 `interface-query-parity.test.ts`、`interface-maintenance-parity.test.ts`、`interface-transfer-parity.test.ts` 和 `interface-browser-parity.test.ts` 使用真实 CLI/MCP 适配、合成 catalog 与 loopback HTTP，验证固定输入、共享任务/配置/提取 owner、有界文件字节，以及 Browser 版本与控制租约。外部 Provider/模型/页面仅用 fake，不读取真实库。

## 放置边界

共享合成输入放 tests/fixtures；本机真实外部测试、一次性脚本和报告放 Git 忽略的 sandbox。运行时临时 home/数据库由用例在系统临时目录创建。

相关说明：[测试目录与本机试验场](../../../tests/README.md)；[测试与验收规则](../../../HARNESS.md)。

[上级目录](../README.md) · [项目 README](../../../README.md)
