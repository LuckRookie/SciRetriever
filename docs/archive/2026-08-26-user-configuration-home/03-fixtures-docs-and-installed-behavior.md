# Block 03 — Fixtures、文档与安装后行为

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | `UCH08`–`UCH11` |
| 前置块 | [02](02-configuration-owner-and-cli.md) |
| 下游块 | [04](04-verification-review-and-handoff.md) |
| 恢复点 | acceptance 与 current docs 都只表达固定用户配置路径 |

## 块结果

离线 acceptance/fresh-wheel 通过隔离 home 验证真实安装行为；用户、架构、开发和示例
文档都准确说明唯一配置文件、CLI 管理、人工编辑与旧配置迁移。

## 进入条件

Block 02 Completed；固定路径 API 和生产 CLI 直接测试通过。

## 责任与改动面

Primary owner：Codex。主要改动 acceptance helpers/tests、README、configuration guide、
example、architecture technical/design、documentation map。保护上一轮 Agents/Browser 文案。

## 需要保持的行为

- acceptance 不读取真实 home、credentials 或连接外部服务；
- README/guide 不把未实现行为写成当前行为；
- 示例不含 secret 或个人绝对路径；
- 安装 wheel 仍从 console script 进入真实生产对象图。

## Tasks

- [x] **UCH08 — 迁移隔离 HOME fixture。** installed helpers 清理旧配置环境变量，在临时
  home 的 `.sciretriever/config.toml` 创建配置，并继续隔离 credentials/Profile/runtime。
  - 依赖：UCH04–UCH07。
  - 验收：全仓测试代码不再用 `SCIRETRIEVER_CONFIG` 驱动产品行为，且无真实 home 访问。
- [x] **UCH09 — 验证安装后 CLI/业务旅程。** console surface、discover/complete/import/export
  和 production bootstrap acceptance 从固定路径加载并覆盖缺失/首次配置行为。
  - 依赖：UCH08。
  - 验收：相关 installed acceptance 在 fresh 临时 home 离线通过。
- [x] **UCH10 — 同步用户文档与示例。** README、configuration guide、example 只展示
  `sciretriever config` 和 `~/.sciretriever/config.toml`，提供不自动执行的人工迁移步骤。
  - 依赖：UCH04–UCH09。
  - 验收：无旧 env/cwd 当前行为陈述；直接编辑与 secret 分离清楚。
- [x] **UCH11 — 同步架构与开发映射。** ADR index、requirements/design、technical/entry/
  configuration、documentation map 统一 owner、对象图和兼容性事实。
  - 依赖：UCH01、UCH04–UCH10。
  - 验收：真相源无重复冲突，链接和术语检查通过。

## 执行方式与集成点

串行完成 fixture -> installed acceptance -> 用户文档 -> 技术文档；代码事实先于 current
docs。安装后隔离 home 是 Block 04 fresh-wheel 的恢复点。

## 审查门

- R1：固定 API/CLI 已通过直接测试；
- R2：检查 fixture 环境、真实 home 泄漏、旧行为残留和受保护文案；
- R3/R4：acceptance、current docs 和对象图一致后退出。

## 接口 / 数据 / 依赖影响

仅迁移测试运行环境和公开文档；不新增 schema、依赖或运行数据。

## 验证与证据

运行受影响 acceptance、`rg` 旧行为残留、Markdown/link/命令事实检查、修改文件静态检查。

## 退出条件

UCH08–UCH11 全部勾选；installed behavior、current docs 和 Accepted 合同一致。

## 完成证据

- `rg -n 'SCIRETRIEVER_CONFIG|configuration = .*config\.toml' tests/acceptance` 只剩隔离环境
  清理名单、固定 HOME 路径和“旧环境变量必须被忽略”的负向回归；产品行为 fixture 不再用旧
  环境变量选择配置。
- `uv run --frozen python -m unittest tests.acceptance.test_installed_cli_surface`：11 tests，
  `OK`；覆盖首次交互创建 `0700`/`0600` 固定文件，以及固定 HOME 胜过 cwd/旧环境变量。
- `uv run --frozen python -m unittest tests.acceptance.test_installed_exchange_and_manual_pdf
  tests.acceptance.test_installed_production_bootstrap_journey
  tests.acceptance.test_installed_topic_discovery tests.acceptance.test_installed_database_completion
  tests.acceptance.test_installed_local_database_journey
  tests.acceptance.test_installed_citation_discovery`：11 tests，`OK`；覆盖安装 wheel 的
  discover/complete/import/export、数据库读取和 production bootstrap。
- 修改的 8 个 acceptance Python 文件通过 Ruff lint、Ruff format check 与 Pyright（0 errors,
  0 warnings）；`python -m py_compile` 通过。
- README、配置手册、示例、Configuration/Entry 技术文档和 documentation map 已统一固定路径、
  CLI/人工编辑、secret 分离、安全权限和旧配置人工迁移；current docs 旧行为搜索无结果，
  `git diff --check` 通过。

## 失败与恢复

fixture 失败时核实 environment 清理和 home 注入，不恢复产品 env fallback；文档 finding
回到对应 owner 修复，不能只在示例中建立例外。

## 下游交接

Block 04 可从完整离线 production graph、固定路径文档和隔离 home acceptance 开始全量验收。
