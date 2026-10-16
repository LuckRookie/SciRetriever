# 01 · 统一执行与集成验收

状态：Completed（统一底座与离线集成验收）。

## Outcome 与进入条件

所有已有模型任务使用 DSH；纯文本分析和 Browser 会话共用配置、协议与生命周期，Browser 政策不泄漏到其他消费者。Owner 已授权迁移底座；现有 SDK/CLI/MCP 与业务存储合同保留。

## 责任与 Tasks

- [x] 1.1 修订 ADR 0031 及架构摘要：唯一 DSH 底座、兼容接口与独立内容质量验收。
- [x] 1.2 单次模型请求经真实 DSH LlmRuntime 执行，保留 schema、完整消息/图像、模型设置、失败与实际 dispatch；去掉旧独立执行实现。
- [x] 1.3 通用会话支持纯文本、多图、工具和反馈；Browser 明确提供当前截图策略和动作参数。会话在同一底座创建、取消并释放。
- [x] 1.4 Application、Analysis/综合、身份核验、模型 probe 和 Browser 均使用统一入口；保持公开导出、现有适配器和旧结果兼容。
- [x] 1.5 添加真实 DSH + fake 模型直接测试；运行受影响回归、Quick/Full；检查 diff、文档与依赖。

生产者为 `agents/dsh`；`agents/runtime.ts` 只保留 API 兼容入口。Analysis/Parsing/Browser/configuration 消费中性合同，不依赖 DSH 类型；文件和业务发布不进入底座。

## 验证与退出条件

定向运行 `apps/server/test/agent-runtime.test.ts`、`dsh-runtime.test.ts`、`browser-dsh-session.test.ts`、`agent-wire.test.ts`、分析/综合/身份及配置测试，补充通用底座测试。完整验证使用 `pnpm full`，真实服务不参与。现有成功、失败、取消、并发和持久化语义不得弱化；原生 DSH 参与执行须有直接证据。

全部 Tasks 和 Full 通过、当前文档同步后，本块才能 Completed。质量优于旧方案仍属真实科研内容验收，不将工具历史完整或 fake 输出当成模型质量提升。

## 恢复与交接

保留既有业务数据和原有工作树；测试失败在所属 owner 修复。原始日志位于根计划所列临时目录；记录具体命令、结果和未覆盖项。完成后记录实际修改、兼容性与剩余质量验证范围。

[计划入口](README.md)

## 当前验证证据

原生底座新增 8 项直接测试通过；相关 16 文件、197 项通过，涵盖模型 wire/history、DSH、Browser、Analysis、综合、身份核验、名称治理、配置及 Application 生命周期。Quick 通过。最终 `VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 pnpm full` 退出码 0：226 个文件 / 1793 项通过，16 个文件 / 40 项按既有可选环境条件跳过；格式、ESLint、源码与测试 strict 类型检查及构建通过。原生 DSH 与 fake 模型验证，未启动真实 Provider/MinerU/用户库。日志位于 `/tmp/sciretriever-dsh-foundation-UxPNgY/`。

最终复核：已有单次调用全部经 DSH LlmRuntime，会话也由同一底座组装；Browser 的最新截图和动作限制已由 Browser 显式声明。安装包、便携包、安装后 SDK/CLI/HTTP 旅程均在 Full 中通过。结构化结果、原始媒体类型、模型设置、错误与 provenance 保留，取消/关闭等待在途请求与会话释放。114 个所检查文档链接目标存在，scoped whitespace 检查通过；依赖清单和锁文件相对本轮基线未变化。未执行 Git 提交。
