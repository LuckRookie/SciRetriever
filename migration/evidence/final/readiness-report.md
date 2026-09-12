# TypeScript 迁移 Readiness report

更新时间：2026-09-12。

当前结论：**not-ready-for-production-cutover**。TypeScript 业务对象图、持久任务、单端口工作台和便携安装包已形成闭环；真实 Provider/站点验证和生产切换仍受授权边界约束。

已形成的直接证据：

- `pnpm quick`、相关 Vitest 和 `pnpm full`：Prettier、ESLint、strict 类型检查、全部 TS 测试和 contracts/server/web build；最新完整结果以本次执行日志为准。
- Metadata 11 个 Provider、Acquisition 7 个 Source 与 CORE/Elsevier/Wiley 授权 adapter；Literature identity/version/current facts、Discovery/Import、MinerU/Parsing、两阶段 Analysis、Query/Export 和 CLI 均有 TS 直接测试及 runtime evidence。
- Browser 人工 loopback 工作台、Candidate spool/receipt、PDF identity、Library 查询和 Browser→MinerU→Analysis→CONTENT_READY 旅程；BrowserHost 现在提供同一 Profile 的多标签页列举/激活、opener 归属和每次启动的 `boot_id`，工作台通过认证的 `/api/tabs` 使用它。
- v1→v2 显式 Catalog migration、backup/restore-check/rollback、durable jobs/targets/attempts/policy/events/leases/interventions、重启恢复和单端口 `/api/v1/jobs/*`。
- 任务工作台支持 content/PDF 目标、策略确认、执行、pause/resume/cancel、预算/targets/events/interventions；`ExecutionScheduler` 在单机固定上限内允许不同 Browser workspace 并发并保持同 workspace 串行；便携包携带 bundled Node 并由 `doctor` 做只读依赖检查。
- `migration/inventory.json` 已为 242 个活动 Python 模块、8 个公开入口、11 个 Metadata Provider、7 个 Acquisition Source、3 个授权 Provider、23 个 CLI 命令和 161 个直接测试记录 TS target/test/evidence。

当前保留的发布前事项：

1. T027 的 blob/data/frame/popup 已有受控归属和 admission，HTTP 206 明确拒绝，不把 partial bytes 当完整 PDF；复杂 viewer 和跨版本 Range 重组保持 Deferred。
2. T031 的加密 trailer 和空文本页已有离线负例；压缩炸弹和非 Linux reader 行为不纳入支持声明。
3. T061 的 Python 生产入口已退役；源码、旧 bridge 和历史测试按 [`migration/retirement-report.json`](../../retirement-report.json) 保留为非运行材料，TS 生产包和运行路径不加载 Python。
4. T059 真实站点、Provider、MinerU/LLM、用户 Catalog/Profile 和凭据均未获授权，保持 `not-authorized/not-run`。

安装、升级、切换和回退说明见 `docs/guides/{installation,upgrade,cutover}.md`；运行依赖和安全/性能边界见 `migration/evidence/baseline/`、`security/`、`performance/`。没有执行 commit、push、发布或真实数据迁移。
