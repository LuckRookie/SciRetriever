# 服务端回归测试

类型：代码导航
负责：服务端回归测试
状态：现行

保存 核心业务、适配边界、SQLite/文件持久化、应用组装与安装后旅程 的可重复离线回归。测试以 \*.test.ts 命名，fixture/helper 与测试就近存放。

`dsh-foundation.test.ts` 使用真实 DSH 服务与合成模型响应，验证单次请求确经原生 LlmRuntime、schema/模型设置保留、纯文本和多图会话、证据工具反馈、会话隔离、稳定失败与关闭结算。现有 `dsh-runtime` 和 Browser/Analysis/综合/配置回归继续覆盖各消费者；fake 反馈正确不表示真实模型的科研内容质量已提升。

三端一致性测试 `interface-query-parity.test.ts`、`interface-maintenance-parity.test.ts`、`interface-transfer-parity.test.ts` 和 `interface-browser-parity.test.ts` 使用真实 CLI/MCP 适配、合成 catalog 与 loopback HTTP，验证固定输入、共享任务/配置/提取 owner、有界文件字节，以及 Browser 版本与控制租约。外部 Provider/模型/页面仅用 fake，不读取真实库。

## 放置边界

共享合成输入放 tests/fixtures；本机真实外部测试、一次性脚本和报告放 Git 忽略的 sandbox。运行时临时 home/数据库由用例在系统临时目录创建。

相关说明：[测试目录与本机试验场](../../../tests/README.md)；[测试与验收规则](../../../HARNESS.md)。

[上级目录](../README.md) · [项目 README](../../../README.md)

`workbench-auth-fixture.ts` 只服务隔离回归：使用合成密码、绑定 loopback，并经真实 `/auth/login` 为 HTTP/浏览器旅程取得会话，不绕过统一认证。默认对外监听和自动密钥由 `web-remote-access.test.ts` 验证。

`dsh-document-session.test.ts` 使用合成正文和栅格资源，验证真实 DSH 会话的未读提交拒绝、看图、回查、错误引用修正和完整 usage。`dsh-analysis-fixture.ts` 只提供 fake 模型政策，保留实际 DSH 工具循环；`browser-decision-fixture.ts` 驱动正式 Browser capability，不保留生产单次兼容入口。

`react-workbench-fixture.ts` 将实际 Vite 与阅读资源装入既有独立查询/维护 HTTP 服务。`document-read`、`knowledge-analysis`、`synthesis-service` 和 `knowledge-retrieval-migration` 的浏览器部分通过这个入口继续验证固定版本、来源绑定、证据续读、迟到响应隔离和历史 schema 读取；不另造测试专用业务 API。

`legacy-application-fixture.ts`、`legacy-parser-fixture.ts`、`legacy-parser-publication.ts` 和 `legacy-document-fixture.ts` 只为历史版本 的读取、固定证据和存储保护回归构造旧文档，不进入生产组装。正式解析入口的回归使用请求 profile 对应的 raw fake，明确断言不会发布 ParserResult 或 Document。`raw-parser-fixture.ts` 只将合成测试文字构造成两份 raw，无法访问网络。

- `proofread-document-publication.test.ts`、`proofread-document-migration.test.ts`：校订全文发布/复用/CAS、原始输入变化、页码证据防篡改、补充材料、对照续读、检索与迁移失败恢复；仅使用合成临时库。

`structure-rules.test.ts` 覆盖纯规则、图表、引用切分及结构条件；`structure-annotation.test.ts` 覆盖 DSH fake、不可变发布/复用、人工角色事务、并发和固定分页以及 CLI/MCP；`structure-annotation-migration.test.ts` 覆盖合成 v13→v14 的备份、回滚和重试。

`mineru-http`、`mineru-parser`、`raw-parsing-service` 与 `literature-completion` 使用新的原始解析路径，保留资源闭包、CRC/路径检查、凭据撤销、并发/取消、失败恢复与禁止隐式总结的断言。`parsing-service.test.ts` 仅验证历史 fixture 的不可变发布，不作为新生产解析已验收的独立证据。

`parser-application-fixture.ts` 给旧式合成文字生成器提供匹配的合成可见文字层，隔离占位 PDF 的实际渲染依赖；用于验证固定文档、读取、检索与交付，不证明 OCR 或校订质量。校订专用测试仍独立提供有冲突的文字层/原图 fake，保留错误处置与真实性断言。
