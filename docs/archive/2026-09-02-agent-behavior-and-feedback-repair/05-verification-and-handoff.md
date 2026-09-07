# Block 5：验证、文档与交接

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed（2026-09-03） |
| Task 范围 | `VER01`-`VER07` |
| 前置块 | Block 1-4 Completed |
| 下游块 | 无 |
| 恢复点 | 最后一个通过的集成、Quick、Full 或最终审查层级 |

## 块结果

Agents Runtime、Analysis controller、Network execute-and-settle、Acquisition progress/outcome、Bootstrap 生产对象图、Report/Logging 和文档形成闭环。离线证据足以说明状态机不会提前退出、失败/取消不会丢失、安装产物可用；真实 CloakBrowser/Provider 复测被明确隔离为用户另行授权的后续验收。

## 进入条件

- Block 1-4 的 Tasks、直接测试、退出审查和完成证据全部闭环；
- 根计划没有未解决的 blocking/material finding；
- ADR 0017 amendment 已 Accepted/生效，ADR 0019 边界未被改变；
- 工作树中所有目标/非目标修改已重新分类，用户 baseline 工作仍受保护；
- 没有真实 external test、commit、push 或发布的隐含授权。

## 责任与改动面

Primary owner 负责：

- Bootstrap 生产对象图离线集成测试与全相关回归；
- `docs/architecture/design.md`、`technical.md`、`technical/agents.md`、`technical/analysis.md`、`technical/acquisition.md`、`technical/network.md` 及必要用户指南同步；
- Quick、Full、wheel 内容、diff/secret/真实数据/构建产物和最终语义审查；
- 根计划/各 Block 状态、真实完成证据、残余风险和最终交接。

不得为通过 Full 修改 Harness、排除有效测试、降级类型检查、连接真实服务或顺手清理用户工作。

## 需要保持的行为

- 产品 R1-R8、模块 owner、唯一文献数据库、不可变资产与 provenance/lineage 边界；
- Metadata、Search、Download、Parse、Analyze、Browser、Configuration 和 Logging 的任务外行为；
- Rules/Agent、Public/API/Browser、Publisher lane/permit、Network guard、PDF 验收和 exhaustion 合同；
- Python 3.10+、uv locked dependency、unittest、Pyright strict、wheel 内容和安装入口；
- 测试/Harness 不读取真实 credential、个人 config/Profile、用户 Catalog、PDF 或语料；
- 不提交 Observation、screenshot、prompt、模型响应、真实 URL/response、terminal transcript 或构建产物。

## Tasks

- [x] **VER01 — 建立生产对象图离线 Browser 验收。** 通过 Bootstrap/production factory 组装 BrowserClient、publisher control、Agent controller 和 fake vendor event source，走真实 action executor/settle/capture/terminal 路径。
  - 依赖：Block 2、3。
  - 验收：delayed challenge click、first self edge、cycle、Candidate capture/timeout、specific failure、取消和 safety fuse 至少各有一条 production-shaped 场景；fake 只产生 vendor event，不替 controller 发布最终 Observation。
- [x] **VER02 — 运行跨模块 failure/feedback 回归。** 组合双 role Provider、Analysis metadata/content、Browser multi-action、Entry Report、Logging transcript 和 publication/exhaustion 反证。
  - 依赖：Block 3、4。
  - 验收：typed failure/result 从拥有层到 Report 不丢 code/retryable/interrupted；INFO/Debug 不重复、不泄露；成功数据与失败保留语义不变。
- [x] **VER03 — 同步架构与当前行为文档。** 更新 ADR 索引/last amended（如仓库规范需要）、design/technical/模块技术文档和 PDF/Analysis 用户指南，准确描述 execute -> settle、Candidate、transition graph、safety fuse、failure/cancel 和日志分层。
  - 依赖：VER01、VER02。
  - 验收：目标文档说明应当行为，README/guide 只说明已实现行为；SDK/PydanticAI migration 与外部 Agent/MCP 不被写成已发布能力。
- [x] **VER04 — 运行完整相关测试集。** 执行 Network Browser、Acquisition Browser/tiered/Entry、Agents、Analysis、Bootstrap、Logging 和 configuration readiness 的相关离线 unittest。
  - 依赖：VER01-VER03。
  - 验收：全部通过；测试列表和数量记录在完成证据；没有真实网络/Profile/credential access。
- [x] **VER05 — 运行 Quick。** 执行 Ruff lint、Ruff format check 和 compileall。
  - 依赖：VER04。
  - 验收：`uv run --frozen python scripts/harness.py quick` 通过；失败回到拥有 Block 修复。
- [x] **VER06 — 运行 Full。** 执行 Pyright strict、全部 unittest、wheel 构建与 wheel 内容核对。
  - 依赖：VER03、VER05。
  - 验收：`uv run --frozen python scripts/harness.py full` 通过；无法运行或失败时计划保持未完成并准确记录。
- [x] **VER07 — 最终语义、安全与交接审查。** 对照用户原始问题、全局验收、ADR、最终 diff、安装产物、凭据/真实数据/个人配置/构建产物和 Git 状态审查；提出真实环境复测的最小方案但不擅自执行。
  - 依赖：VER06。
  - 验收：无 blocking/material finding；残余风险、未授权真实验证、SDK 后续计划和 Git/发布状态完整交接。

## 执行方式与集成点

按 VER01 -> VER02 -> VER03 -> VER04 -> VER05 -> VER06 -> VER07 串行。VER01 是关键汇合点：它必须使用与生产相同的 Bootstrap/factory/action executor 边界，只把最外侧真实 vendor/网络替换为受控 event source。

### 生产形状离线对象图

```text
Bootstrap role bindings
  -> shared AgentRuntime + fake Provider adapter
  -> AgentBrowserController
  -> acquisition Browser source / publisher control
  -> Network BrowserClient action executor + settle
  -> fake vendor event source
       delayed DOM/navigation/challenge/capture/failure events
```

测试不得简化为：

```text
AgentBrowserController -> fake execute() -> 直接返回预制最终 Observation
```

### 真实环境复测前置条件

Full 通过后，若用户另行明确授权，可在仓库外个人 Profile/credential 环境做最小只读/受控复测。复测前必须确认：

- 精确目标站点、文章与授权访问范围；
- CloakBrowser wrapper/binary/display/Profile 本地 readiness；
- Browser Model Provider/Model/Key 与 quota；
- 不输出或保存 Cookie、Profile、完整 URL、页面正文、screenshot、Prompt、模型原文或签名下载地址；
- 结果只用于当次诊断，不写 fixture/计划/仓库；
- 用户取消、费用、Publisher policy 和下载写入范围明确。

建议真实场景只验证“挑战页点击后异步变化不会立即 `no-progress`”和“真实 capture 能完成既有 PDF 验收”两项，不借机扩大到全站爬取。

## 审查门

- R4/VER01：对象 identity、生产 factory、action executor、settle/capture 和 fake event owner 与生产一致；
- R4/VER02：Report/Logging/Provenance、failure/cancel、publication/exhaustion 组合语义一致；
- R2/VER03：ADR/target/current docs 不混淆，术语和相对链接正确；
- R3/VER04：相关测试没有真实外部访问或脆弱 wall-clock sleep；
- R5/VER06-07：Full、wheel、最终 diff、安全、用户工作保护和残余风险全部审查。

以下情况阻断完成：只跑 fake controller 而未走生产 executor；Full 未通过；ADR/文档仍把 receipt 当 settle或 Candidate 当 capture；真实凭据/数据进入 diff；safety fuse 可建立 exhaustion；SDK migration 被夹带；任务外用户改动被提交/覆盖。

## 接口 / 数据 / 依赖影响

本块不应再引入新行为，只集成并核实前四块实际影响：

- 公开 CLI/Entry：命令和 Report schema 原则上不变，failure/interrupted 语义更准确；
- 内部 API：execute-and-settle transition、role-aware Runtime identity、typed Browser result；
- 数据/schema：无；
- 配置：无；
- 依赖/lock：无；
- 文档：ADR 0017、architecture technical/current guide 同步；
- 打包：wheel 必须包含所有活动源码/文档要求的包，不包含测试 fixture、个人数据或新 SDK。

若最终 diff 显示与上述不同，先更新根计划影响矩阵并完成相应合同审查，不能在交接中一句带过。

## 验证与证据

相关测试命令在执行时从 Blocks 2-4 合并并去重，至少覆盖：

```bash
uv run --frozen python -m unittest \
  tests.test_network_playwright_control \
  tests.test_network_browser \
  tests.test_network_cloakbrowser \
  tests.test_network_cloakbrowser_local \
  tests.test_browser_agent_control \
  tests.test_browser_agent_integration
uv run --frozen python -m unittest \
  tests.test_acquisition_browser \
  tests.test_acquisition_matrix \
  tests.test_browser_challenge_lifecycle \
  tests.test_browser_challenge_resources \
  tests.test_tiered_acquisition_service \
  tests.test_entry_completion
uv run --frozen python -m unittest \
  tests.test_agents \
  tests.test_agents_contracts \
  tests.test_agents_providers \
  tests.test_analysis_metadata_stage \
  tests.test_analysis_content_proposal \
  tests.test_analysis_reference_lookup
uv run --frozen python scripts/harness.py quick
uv run --frozen python scripts/harness.py full
git diff --check
git status --short
```

最终证据至少记录：

- production-shaped Browser 场景与关键断言；
- 相关测试模块、测试数量和结果；
- Quick/Full 每个阶段结果与 Full 发现的 unittest 数；
- wheel 内容核对；
- 文档链接/术语审查；
- secret、个人 config/Profile、真实数据、构建产物和无关 diff 审查；
- 未执行真实外部测试、commit、push、PR 或发布的事实。

## 退出条件

- VER01-VER07 全部完成；
- 根计划所有全局验收 checkbox 有真实证据；
- 生产对象图离线场景、相关测试、Quick、Full 和文档全部闭环；
- 最终审查无 blocking/material finding；
- residual risks、真实环境复测授权边界和 SDK/PydanticAI 后续工作准确交接；
- 根计划及五个 Block 状态/完成证据更新为真实结果。

## 完成证据

- `test_bootstrap_production_route_runs_the_agent_and_fake_vendor_chain` 通过 `build_production_object_graph` 取得 production RSC route，复用同一 shared `AgentRuntime`、`BrowserClient`、publisher control 与 `AgentBrowserController`；fake 只提供 Provider decision 和 vendor event，真实 executor 完成 action、settle 与 cleanup。
- production-shaped 场景覆盖 delayed challenge clear、first/repeated self edge、cycle、Candidate capture/timeout、specific vendor failure、取消和 32-call safety fuse；均断言实际 vendor dispatch 次数和 page/context/process 清理。
- 相关离线回归 `Ran 581 tests, OK (skipped=1)`；跳过项是未设置 `SCIRETRIEVER_TEST_CLOAK_HOME` 的本地 Cloak runtime 验收。修复最终架构边界后另有 38 项合同回归与 72 项 Network Browser 回归通过。
- `uv run --frozen python scripts/harness.py quick` 通过：Ruff lint、Ruff format check、compileall 全部通过。
- `uv run --frozen python scripts/harness.py full` 最终退出码 0：Pyright strict 0 error；unittest `Ran 2252 tests, OK (skipped=4)`；wheel 构建与 wheel contents verification 通过。
- ADR 0017/0021、ADR 索引、README、architecture design/technical、Agents/Analysis/Acquisition/Network/Logging/Configuration 技术文档和 PDF/Configuration 用户指南已与实现同步；没有把 SDK/PydanticAI migration 写成现有能力。
- `git diff --check` 通过；旧 fingerprint 名称和 `network -> model.report` 越界依赖均不存在。敏感 key/private-key token pattern 与个人绝对路径扫描 clean；`pyproject.toml`、`uv.lock` 无改动；无 PDF、截图、Profile、个人 config、真实数据或构建产物进入 Git diff，`build/`/`dist/` 仅有 Harness ignored 产物。
- 未执行真实 Provider、Publisher、CloakBrowser、MinerU 或个人 Profile/credential 测试；未 commit、push、PR 或发布。残余风险仅为真实 Provider model alias/snapshot 与真实 Publisher 页面变化仍需用户另行授权的最小复测。

## 失败与恢复

集成或 Full 失败时记录首个失败命令、test、拥有层和最近通过层级，回到产生问题的 Block 修复并重跑其直接测试，再从适当 VER Task 继续。不得修改 Harness、删除断言、排除模块或用真实外部服务替代离线证据。保留用户工作，不使用 destructive Git。

## 下游交接

本块无内部下游。完成后可由用户决定：

1. 是否另行授权真实 CloakBrowser/Provider 最小复测；
2. 是否启动 ADR 0019 下独立的 PydanticAI Direct/SDK transport gate 计划；
3. 是否授权 commit/push。

这些决定都不属于本计划自动权限，也不影响已经通过的离线行为修复事实。
