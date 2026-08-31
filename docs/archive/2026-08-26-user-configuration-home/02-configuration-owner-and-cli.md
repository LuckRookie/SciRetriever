# Block 02 — Configuration Owner 与 CLI

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | `UCH04`–`UCH07` |
| 前置块 | [01](01-contract-and-baseline.md) |
| 下游块 | [03](03-fixtures-docs-and-installed-behavior.md) |
| 恢复点 | 固定路径 API、生产调用方和直接测试全部通过 |

## 块结果

Configuration 唯一解析并验证用户级普通配置路径；所有生产命令和交互编辑使用该路径，
首次配置可安全创建文件，旧隐式来源不再影响运行。

## 进入条件

Block 01 Completed；Accepted 合同和隔离测试入口稳定；共享源码 diff 已审查。

## 责任与改动面

Primary owner：Codex。主要文件为 `src/sciretriever/configuration/`、
`src/sciretriever/entry/cli/main.py`、必要 Bootstrap 调用方及直接测试。保护既有 Browser
Controller、Agents status/config UX 改动。

## 需要保持的行为

- 普通配置 TOML/Pydantic 校验、注释与未知非配置 section 处理合同；
- credentials 独立 owner 与屏蔽；
- config status/test 的离线/显式探测边界；
- 业务命令现有组装和错误 exit code。

## Tasks

- [x] **UCH04 — 建立固定用户配置路径 API。** Configuration 从显式/注入的 home 解析
  `.sciretriever/config.toml`，删除 env/cwd selector 的生产语义并收敛 public export。
  - 依赖：UCH01–UCH03。
  - 验收：不同 cwd、存在旧 env 文件时仍只选择隔离 home 文件。
- [x] **UCH05 — 统一安全读写与首次创建。** 用户配置目录/文件按合同验证并原子发布，
  缺失编辑目标视为空配置，缺失生产读取形成稳定可操作错误。
  - 依赖：UCH04。
  - 验收：目录/文件 mode、owner、symlink、hardlink、原子失败恢复和注释 round-trip 通过。
- [x] **UCH06 — 迁移生产调用方。** Entry/Bootstrap、config 首页、LLM/Browser/MinerU/Provider
  编辑、status/test 与业务命令全部消费同一 Configuration API，不接收 test-only path。
  - 依赖：UCH04–UCH05。
  - 验收：调用图中无生产 `SCIRETRIEVER_CONFIG`/cwd path selection，CLI 直接测试通过。
- [x] **UCH07 — 完成切片级错误与 UX 审查。** 缺配置、错误 mode/owner/link 的用户结果
  可操作但不泄露配置内容或 secret；首页明确显示固定文件位置和人工编辑能力。
  - 依赖：UCH06。
  - 验收：plain/rich 与 `NO_COLOR` 相关直接测试无回归，稳定 stderr/exit code 通过。

## 执行方式与集成点

串行按路径 API -> 安全事务 -> 生产调用方 -> UX/错误审查实施。每个切片同步直接测试并
审查共享文件 diff；固定 API 是 Block 03 唯一集成点。

## 审查门

- R1：Block 01 证据和共享文件保护有效；
- R2：检查 owner、错误、安全、test-only 注入是否越过公开边界；
- R3：Configuration/CLI 相关测试和静态检查通过后退出。

## 接口 / 数据 / 依赖影响

路径选择 public surface 收敛；普通/凭据 schema、数据库、资产与依赖不变。

## 验证与证据

运行 `test_configuration_editing.py`、`test_configuration_boundary.py`、`test_cli.py`、
`test_config_ui.py` 的相关/完整测试，以及修改文件 Ruff/Pyright。

## 退出条件

UCH04–UCH07 全部勾选；直接测试证明唯一路径、安全编辑、错误与调用图闭环。

## 完成证据

- `configuration_path(home=...)`、`load_user_configuration()` 与
  `load_editable_user_configuration()` 已替代三套 selector；正常写入和跨普通配置/凭据更新
  只接收同一个 `home`，Entry 不再传入任意配置路径。
- 普通用户配置复用私有目录校验并修正了 file-store 对普通配置 unsafe file 的稳定错误；首次
  确认编辑创建 `0700` 目录与 `0600` 单硬链接文件，读/写前拒绝不安全目录、mode、symlink 与
  hardlink，原子 staging、注释 round-trip 和跨文件恢复测试继续通过。
- CLI 全部生产读取改为 `load_user_configuration()`；裸配置首页和各编辑区使用同一 editable
  API。缺失配置稳定返回 code 4，并提示运行 `sciretriever config` 创建
  `~/.sciretriever/config.toml`；其它 ConfigurationError 仍保持脱敏通用错误。
- 直接验证：
  `uv run --frozen python -m unittest tests.test_configuration_editing tests.test_configuration_boundary tests.test_configuration_probes tests.test_core_configuration_probes tests.test_config_ui tests.test_bootstrap_readiness tests.test_cli tests.test_browser_profiles`
  —— 220 tests，全部通过。
- 修改文件 Ruff lint/format 与 Pyright strict 定向检查通过：0 errors、0 warnings。
- `rg` 核实活动 `src/` 已无 `SCIRETRIEVER_CONFIG`、旧 selector 或 selected-loader；Bootstrap
  没有新增路径知识。受保护 Agents/Browser 改动未被回滚。

## 失败与恢复

测试失败停在最近通过的切片；若安全合同与人工编辑产生不可调和跨平台冲突，返回
Block 01 设计，不添加 cwd/env fallback。

## 下游交接

Block 03 可假设所有生产进程以隔离 home 解析同一个普通配置文件，并只需迁移 fixture、
current docs 和安装后验收。
