# Block 01 — 合同与 Baseline

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | `UCH01`–`UCH03` |
| 前置块 | 无 |
| 下游块 | [02](02-configuration-owner-and-cli.md) |
| 恢复点 | 计划与 Accepted ADR 已说明唯一路径、迁移和非目标 |

## 块结果

固定用户级普通配置路径成为 Accepted 合同；实现起点、调用方、旧行为和测试隔离风险都有
可核实证据，下游不需要自行决定兼容或路径 owner。

## 进入条件

- 用户已授权固定 `~/.sciretriever/config.toml` 并保留 CLI/人工编辑；
- 已读取 HARNESS、Configuration/Entry 真相源、实现和直接测试；
- 已确认不读取真实配置、不启用并行、不执行 Git 写操作。

## 责任与改动面

Primary owner：Codex。改动面为 ADR/index、requirements/design/technical 中的长期合同及
Configuration 路径 baseline 测试。既有 Agents/Browser 文档与测试改动受保护。

## 需要保持的行为

- credentials 与普通配置职责分离；
- 配置 schema、注释保留、原子发布和稳定错误边界；
- CLI status 不连接真实服务；测试不读取真实 HOME。

## Tasks

- [x] **UCH01 — 固化唯一用户配置路径决策。** Accepted ADR 规定
  `~/.sciretriever/config.toml`、CLI/人工编辑、secret 分离、旧 env/cwd 行为退出及
  人工迁移策略。
  - 依赖：无。
  - 验收：ADR index、requirements/design/technical 不产生第二个 owner 或兼容歧义。
- [x] **UCH02 — 建立路径选择回归基线。** 直接测试证明 baseline 仍接受环境变量与当前
  目录，并新增目标失败断言或等价 characterization，覆盖固定 home、缺失、首次创建和
  不读取旧来源。
  - 依赖：UCH01。
  - 验收：测试能在实现修改前暴露至少一个目标差异，且完全隔离真实 HOME。
- [x] **UCH03 — 审查共享改动与调用面。** 枚举 Configuration exports、Entry/Bootstrap
  生产调用、acceptance env 注入和受影响当前文档，标明受保护重叠。
  - 依赖：无。
  - 验收：Block 02/03 文件与测试入口无遗漏，未修改任务无关工作。

## 执行方式与集成点

串行完成 ADR -> baseline tests/call graph -> R3。Block 02 只依赖“固定 home 路径、无旧
fallback、显式底层 parser 可保留”的稳定合同。

## 审查门

- R1：确认这是公开兼容变化且用户决定足够明确；
- R2：核对 ADR 不是计划事实，测试不触碰真实 home；
- R3：合同、baseline 和影响面闭环后退出。

## 接口 / 数据 / 依赖影响

本块决定路径选择 API 的目标，但不改 schema、持久数据或依赖。

## 验证与证据

运行目标配置测试的 baseline/失败用例、Markdown 链接检查和 `git diff --check`；记录真实
命令与结果。

## 退出条件

UCH01–UCH03 全部勾选；唯一路径、旧行为退出、迁移、安全和测试隔离均无未决设计。

## 完成证据

- 2026-08-26：新增 Accepted [ADR 0018](../../architecture/decisions/0018-fixed-user-configuration-home.md)，
  并同步 requirements、design、Configuration technical 与 ADR index；目标固定为
  `~/.sciretriever/config.toml`，旧 env/cwd 不兼容退出，secret 继续分离。
- 目标回归命令：
  `uv run --frozen python -m unittest tests.test_configuration_editing.OrdinaryConfigurationEditingTests.test_user_configuration_path_is_fixed_and_ignores_environment_and_cwd tests.test_configuration_editing.OrdinaryConfigurationEditingTests.test_missing_user_configuration_does_not_fall_back_to_old_sources`。
  baseline 如预期以两个 ImportError 失败：`configuration_path` 尚不存在；证明测试命中了目标
  API 差异，未访问真实 HOME。
- `rg` 核实生产路径选择只存在于 `configuration/documents.py` 与 `entry/cli/main.py`；
  Bootstrap 不拥有路径规则。旧环境变量还存在于 6 组 acceptance helper/test，已分配给 Block 03。
- `git diff --check` 对本块合同、计划与目标测试通过；共享文件中的既有 Agents/Browser diff
  保持原样并已标为受保护。

## 失败与恢复

若发现项目级配置仍是 Accepted requirement，停止实施并请求用户解决合同冲突；否则从
已完成 ADR 或测试切片继续，不回滚工作树。

## 下游交接

Configuration 是路径唯一 owner；生产 CLI/Bootstrap 只消费用户配置加载 API，测试通过
临时 home 注入，旧 `SCIRETRIEVER_CONFIG`/cwd 不能继续生效。
