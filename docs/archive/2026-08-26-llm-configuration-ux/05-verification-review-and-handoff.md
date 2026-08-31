# Block 05：验证、最终审查与交接

## 块身份

- 状态：Completed
- Task 范围：UXV01–UXV06
- 前置块：Block 04 Completed
- 下游块：无
- 恢复点：R4 已通过的集成实现

## 块结果与进入条件

全部机械证据与 R5 语义审查证明精简 UX 是实际安装行为，且没有夹带 secret、真实数据、依赖
升级或无关改动。进入前 Block 04 R4 必须通过。

## 责任与改动面

Primary owner 负责全部验证、finding 路由、计划证据和最终交接；不修改 Harness 来迁就失败，
不执行未授权 Git 或真实外部探测。

## 需要保持的行为

Full 门禁、wheel 内容、Python 3.10+、unittest、离线测试、固定 HOME 与脏工作树保护全部适用。

## Tasks

- [x] **UXV01 — 运行聚焦回归集。** 覆盖模型、Agents、provider adapter、Bootstrap、Configuration、
  CLI、status 和 installed acceptance 直接测试。
  - 依赖：Block 04。
  - 验收：全部通过，无真实网络/HOME。
- [x] **UXV02 — 运行 Quick。** 执行 `uv run --frozen python scripts/harness.py quick`。
  - 依赖：UXV01。
  - 验收：lint、format check、compileall 全部通过。
- [x] **UXV03 — 运行 Full。** 执行 `uv run --frozen python scripts/harness.py full`。
  - 依赖：UXV02。
  - 验收：Pyright strict、全量 unittest、wheel 构建和内容核对全部通过。
- [x] **UXV04 — 运行 fresh-wheel installed acceptance。** 在隔离临时环境验证安装后的 CLI/config。
  - 依赖：UXV03。
  - 验收：不从源码树偷跑，不读取真实 HOME，不访问真实服务。
- [x] **UXV05 — 完成 R5 最终审查。** 对原目标、计划差异、UX、错误、兼容、secret、架构、文档、
  打包、依赖和最终 diff 分类 finding 并闭环。
  - 依赖：UXV01–UXV04。
  - 验收：无未解决 blocking/material/ordinary finding。
- [x] **UXV06 — 完成交接与计划处置。** 更新全部证据、全局验收与状态，说明残余风险和未授权动作。
  - 依赖：UXV05。
  - 验收：用户可以只读最终交接理解实际行为和验证范围。

## 执行方式、集成点与审查门

严格串行执行 direct→Quick→Full→installed→R5。任何失败先定位到产生它的 Block，修复后从相关
最低成本检查重新开始，再重跑受影响上游门禁。不能以剩余时间或测试数量替代完成。

## 接口/数据/依赖影响

本块不设计新接口；只验证前四块的组合结果。构建产物与临时 venv 不提交。

## 验证、退出、证据与恢复

所有 Tasks、全局验收和 R5 通过后计划 Completed。若环境阻止某门禁，准确记录命令、原因和
残余风险，不能声称 Full 验收。恢复时读取最新失败、相关 Block 证据和 diff，不重复已通过且
未受影响的低层调查。

### 完成证据

- 聚焦回归命令覆盖 Agent setup/catalog/provider、Configuration editing/boundary/status/probe、
  Bootstrap readiness、CLI 与 Rich UI；最终 `Ran 253 tests in 1.958s`，全部通过。
- `uv run --frozen python scripts/harness.py quick` 最终 exit 0；Ruff lint、Ruff format check 与
  `compileall` 全部通过。首次复验只发现本轮新增条件表达式的一处 Ruff 排版，单文件格式化后
  重跑绿色。
- `uv run --frozen python scripts/harness.py full` 最终 exit 0；Pyright strict 0 errors/0
  warnings；`Ran 2156 tests in 210.834s`，`OK (skipped=4)`；
  `sciretriever-0.1.0-py3-none-any.whl` 构建和源码模块内容核对通过。
- Full 后定向运行
  `InstalledCliSurfaceTests.test_installed_guided_setup_creates_analysis_and_browser_roles_without_network`
  与 `test_installed_core_service_status_and_probes_are_isolated_and_offline`：`Ran 2 tests in
  15.523s`，全部通过。两个旅程使用临时 HOME/隔离安装、fake/fixture 外部边界，不从真实配置
  或真实服务取值。
- R5 ordinary findings：installed status keyset 漏接新增 `reasoning_effort`；跨服务同名模型会
  误继承旧 capability defaults；目录 transport 的本地 `OSError` 未统一回退。三项均在 owning
  slice 修复并新增/更新直接回归，随后重新执行聚焦集、Quick、Full 与 fresh-wheel。
- R5 语义审查：Browser role + Agent controller + Profile/fixed identity + CloakBrowser/Playwright/
  binary/headed display 的三层 readiness 没有被一个模型配置冒充；Rules/Agent 仍作业级互斥且
  无 fallback；status 纯本地；目录 observation 不持久化也不证明能力；ADR 0019 仍只是后续
  PydanticAI/SDK transport gate 与 MCP/Skill 迁移门。
- R5 范围/安全审查：`pyproject.toml`、`uv.lock` 无 diff；数据库/schema、资产和 credential
  格式不变；`git diff --check` 通过；状态中无 credentials、个人 `config.toml`、PDF 或数据库
  文件。Full 产物 `build/`、`dist/` 均为 ignored。未读取真实 HOME/secret/Profile/语料，未连接
  真实 LLM、MinerU、Publisher，未 commit、push、PR 或发布。
- 4 个 skip 是需要显式 opt-in/真实安装 Profile 的 CloakBrowser runtime 边界；当前授权要求离线
  fake/fixture，因此作为已接受残余验证范围准确保留。计划完成后按 `docs/plans/README.md`
  归档，不把本计划作为 current truth。
