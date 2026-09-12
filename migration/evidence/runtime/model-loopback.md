# 配置驱动的模型 loopback 组装

2026-09-10。衔接 [Analysis 执行](analysis-execution.md)、Configuration owner 与共享 NetworkBudget。

## 当前行为

模型 adapter 按每个 provider 的已验证 base URL 组装 Network transport，使用 Application 唯一
NetworkBudgetCoordinator。HTTPS 仅接纳 public 地址并绑定配置端口与精确 origin credential grant；HTTP
只接纳配置的 loopback 地址和端口，localhost 只允许解析到 127.0.0.1/::1。transport 还绑定组装的精确
endpoint，不能换成任意路径。重定向与重试预算均为零，响应上限 4 MiB，并发最多两次。

HTTP loopback 不需要凭据；如果同名 Model Provider 仍保有凭据，则在组装阶段拒绝，避免把旧远端密钥
用于本地端点。adapter 自身也拒绝 credentialed HTTP。Anthropic 的协议版本 Header 保留，三个协议均
不发送 Authorization、x-api-key 或 Cookie。HTTPS 继续要求有效凭据，不放宽现有 secret scope。

TS 配置解析修正 loopback 非默认端口判定：接受明确的 1–65535 端口，并继续拒绝 127.1、整数地址、
前导零端口、private HTTP 和 IP HTTPS。与实际 Python configuration owner 的 projection 共同验证。

AgentRuntime close 取消所有进行中的 adapter 请求；外部取消及关闭取消均返回 `agent-cancelled`，
关闭后的新请求返回 `agent-closed`。Network 仍负责释放 socket 与预算许可。

## 直接证据

`model-loopback.test.ts` 六项测试：

- 使用实际 Python owner 在临时 home 发布配置，分别组装 Chat、Responses、Anthropic；组装阶段零请求。
- 本地 HTTP 服务核对精确模型路径、模型名及三个敏感 Header 均不存在，返回各自原生协议 JSON。
- 使用合成旧 HTTPS credential 模拟配置改址后残留；组装失败且本地服务没有收到请求。
- 第一请求返回另一个 loopback 端口的 307，确认目标服务未收到请求；第二请求悬挂，关闭应用取消它。
- 普通 TS parser 的端口/地址边界，以及 adapter 在 HTTP 发出任何 I/O 前拒绝非空 credential。

`analysis-service.test.ts` 增加实际网络组合测试：实际配置 owner → Application → 正式 PDF/ParserResult →
Python 两阶段 Analysis → TS AgentRuntime → 两次真实 loopback HTTP → canonical Markdown → Literature
内容接纳，最终详情为 CONTENT_READY，provenance 与 Parser hash 一致。模型响应使用合成内容，不连接
真实模型；原有 fake transport 负面测试继续覆盖 metadata/正文拒绝、预算和 stale current input。

## 后续闭环与边界

后续 [Entry 分析接纳](content-analysis-entry.md)、[NoUsableContent 精确清理](no-usable-content-entry.md)和
[Browser→MinerU→Analysis source-checkout 联合旅程](browser-mineru-analysis-journey.md)均复用本 transport。
安装包自含 Cloak runtime 的完整产品旅程仍受 operator bundle 授权和支持矩阵约束。TS 配置 owner 已接管生产
路径；没有新增依赖/schema 或用户数据迁移，真实模型和生产切换仍未授权。

## 本次全量验收

`SCIRETRIEVER_CLOAK_BUNDLE=/home/duanjw/.sciretriever/cloakbrowser-cache/chromium-146.0.7680.177.5 pnpm full`
通过：70 个测试文件、265 项测试。含实际 Cloak 工作台、三种模型 loopback、本次 Analysis 网络组合、
配置 owner、离线包安装及既有业务回归；Quick、strict 类型检查与 build 均通过。
日志 `/tmp/sciretriever-model-loopback-full.log`；`git diff --check` 通过。
未运行 Python Quick/Full/unittest；未提交、推送、创建 PR 或执行生产操作。
