# 用户级统一配置文件迁移

> 历史实施记录，非当前产品或架构真相源。当前行为以 requirements、Accepted ADR、current
> docs、源码与测试为准。

| 字段 | 值 |
| --- | --- |
| Run ID | `2026-08-26-user-configuration-home` |
| 创建日期 | 2026-08-26 |
| Primary owner | Codex |
| Baseline revision | `b1322d32d9689ebf65b27e65eae13f3c6a855007` |
| 执行模式 | single-session；单一 Primary owner 串行执行 |
| 当前状态 | Completed and archived — 2026-08-26 |
| 计划规范 | [活动实施计划治理规范](../../plans/README.md) |

## 1. 目标观察

完成后，所有正常安装和 CLI 命令只从 `~/.sciretriever/config.toml` 读取普通配置；裸
`sciretriever config` 读取或创建同一个文件，用户也可以直接编辑它。凭据仍单独保存
在 `~/.sciretriever/credentials.toml`，不会混入普通配置。

用户从任意工作目录运行 SciRetriever 都获得相同配置，不再需要知道
`SCIRETRIEVER_CONFIG`、当前目录自动发现或项目根配置文件等选择规则。

## 2. 授权与真相源

用户已经明确要求把 `config.toml` 放入 `~/.sciretriever/`，统一通过产品命令管理并
保留人工编辑能力。适用真相源：

- [产品需求](../../architecture/requirements.md)；
- [架构原则](../../architecture/principles.md)与[设计文档](../../architecture/design.md)；
- [ADR 0014](../../architecture/decisions/0014-capability-scoped-providers-and-local-credentials.md)；
- 本计划 Block 01 接纳的用户级普通配置路径 ADR；
- [Configuration 技术文档](../../architecture/technical/configuration.md)和
  [Entry 技术文档](../../architecture/technical/entry.md)；
- [Configuration 用户指南](../../guides/configuration.md)。

本计划不能改变 secret 与普通配置的职责分离、配置 schema、Provider 凭据格式、
数据库/资产布局或外部访问安全边界。

## 3. 事实、假设与开放问题

### 已核实事实

- baseline 的普通配置按“显式 Python path → `SCIRETRIEVER_CONFIG` → 当前目录已有
  `config.toml`”选择；交互编辑在无文件时写入当前目录；
- 凭据已经固定在 `~/.sciretriever/credentials.toml`；Browser Profile 与运行时状态
  也已由 Configuration 管理用户级目录；
- 普通配置已有 bounded/no-follow 读取、TOML/Pydantic 校验、注释保留和原子发布；
- acceptance fixture 仍通过 `SCIRETRIEVER_CONFIG` 注入临时配置；
- 工作树包含上一轮 Agents/Browser 重构的大量受保护改动，本计划必须在其上增量实施。

### 待验证假设

- 将路径所有权收回 Configuration 后，Entry 和 Bootstrap 不需要维护任何路径选择知识；
- acceptance 可以通过隔离 `HOME`/`USERPROFILE` 与临时
  `.sciretriever/config.toml` 完成，不需要保留产品环境变量兼容层；
- 普通配置与 credentials 共处私有目录时，目录 `0700`、文件 `0600` 能在支持 POSIX
  owner/mode 的平台上保持一致安全行为，不妨碍用户直接编辑。

### 开放问题

无需要用户先行决定的问题。若安装包测试证明跨平台 home 解析需要新公开配置项，必须
停止并回到设计，不以第二套隐式路径规则补丁解决。

## 4. 范围与非目标

### 范围

- 固化唯一生产路径及迁移/错误行为；
- Configuration 路径 owner、CLI/Bootstrap 调用方和隔离测试迁移；
- 用户级目录和普通配置安全、原子编辑与人工编辑合同；
- README、用户指南、示例、架构/技术文档和安装 wheel 验收同步；
- 删除当前行为文档与测试中的旧环境变量/当前目录配置模式。

### 非目标

- 合并 `config.toml` 与 `credentials.toml`；
- 修改普通配置字段、凭据 schema、数据库或资产；
- 自动读取、移动或删除用户现有的真实配置；
- 新增 CLI `--config`、项目级配置层、环境变量兼容 fallback 或自动迁移器；
- 读取真实凭据、连接 Provider/LLM/MinerU、提交 Git 或发布。

## 5. 全局验收条件

- [x] 正常生产对象图只读取 `~/.sciretriever/config.toml`，不读取环境变量指定文件或
  当前目录 `config.toml`。
- [x] 裸 `sciretriever config` 能在固定位置首次创建并后续编辑普通配置；
  `status`/`test` 和所有业务命令读取同一个文件。
- [x] 普通配置和 credentials 保持独立文件、独立 schema 与原子发布；用户可直接编辑
  普通配置且注释 round-trip 不丢失。
- [x] 隔离测试证明固定路径、首次创建、目录/文件模式、符号链接/硬链接/owner/mode
  失败、旧路径不生效及稳定错误结果。
- [x] README、用户指南、示例、Accepted ADR、design/technical 和安装包行为一致，并有
  明确的旧配置人工迁移说明。
- [x] 相关测试、Quick、Full、fresh-wheel 离线验收、最终语义审查和 diff 审查闭环。

## 6. 分块地图与依赖

| Block | 结果 | 主要改动面 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| [01](01-contract-and-baseline.md) | 固化唯一用户级路径、兼容与迁移合同 | ADR、requirements/design、baseline tests | 无 | Completed |
| [02](02-configuration-owner-and-cli.md) | Configuration 拥有固定路径，生产调用方统一 | `configuration/`、Entry/Bootstrap、直接测试 | 01 | Completed |
| [03](03-fixtures-docs-and-installed-behavior.md) | fixture、用户文档和安装后行为迁移 | acceptance helpers、README/guides/example/technical | 02 | Completed |
| [04](04-verification-review-and-handoff.md) | Full、fresh-wheel、语义审查与交接闭环 | Harness、最终 diff、计划证据 | 03 | Completed |

依赖顺序为 `01 -> 02 -> 03 -> 04`，没有获准的并行实施范围。

## 7. 跨块合同

- 唯一正常生产路径为 `$HOME/.sciretriever/config.toml`；`home` 注入只用于确定性内部
  边界和隔离测试，不形成 CLI 选项或第二个用户配置来源。
- `load_configuration(path)` 可继续作为显式文档解析/内部事务能力，但 Entry/Bootstrap
  不得用它绕过唯一用户路径。
- `config.toml` 不存储 secret；`credentials.toml` 的字段、展示屏蔽和写入 owner 不变。
- 不静默迁移或 fallback 到旧文件；错误和文档给出可操作迁移方向，但不打印配置内容。
- 现有 Agents/Browser 工作区改动均受保护；共享文件只做可归因的增量修改。

## 8. 影响矩阵

| 面 | 影响 |
| --- | --- |
| CLI/公开行为 | 变更：固定路径；删除环境变量和当前目录自动发现 |
| Python API | 变更：路径选择 surface 收敛为用户配置路径 owner；保留显式解析能力 |
| 配置 schema | 不变 |
| 凭据 schema | 不变 |
| 数据库/资产 | 不变 |
| 依赖/锁文件 | 预计不变 |
| 安全 | 强化并统一用户目录/文件验证；不读取真实 secret |
| 文档/示例 | 变更：只展示固定路径、CLI 管理和人工迁移 |
| wheel/对象图 | 变更：安装后所有入口通过固定路径加载 |

## 9. 风险与转化信号

- 旧自动化依赖 `SCIRETRIEVER_CONFIG`：通过隔离 HOME fixture 和迁移文档解决；若发现
  用户必须同时维护项目级配置，需回到用户决策，不能自行恢复 fallback。
- HOME 隔离不完整可能读取真实配置：测试 helper 必须显式清理继承环境并在临时 home
  创建文件；发现真实 home/path 泄漏时立即阻断。
- 固定私有目录安全检查可能与直接人工编辑后的 mode 冲突：直接测试定义稳定诊断；不以
  自动放宽 owner/mode 掩盖风险。
- 共享文件已有受保护修改：每个切片先审查文件 diff；出现不可分离冲突时停止并报告。

## 10. 验证与证据策略

先运行 Configuration 路径/编辑直接测试，再运行 CLI 与 acceptance；随后执行 Quick、
Full 和从 fresh wheel 的隔离 HOME 验收。最后对唯一路径、secret 分离、迁移文案、包内容
和任务 diff 做 R5 语义审查。命令与摘要记录在各 Block 的“完成证据”中。

## 11. 授权门

- 并行实施：未授权，保持关闭；
- 真实用户配置迁移或读取：未授权且本计划不需要；
- 外部网络/Provider/LLM/MinerU：未授权且本计划不需要；
- Git commit/push/PR/release：未授权；
- 删除、覆盖用户文件或破坏性清理：未授权。

## 12. 执行方式与集成点

Primary owner 串行完成每个能力切片：预检共享文件 -> 实现及直接测试 -> 低成本验证 ->
切片 diff/合同审查 -> 记录证据并勾选。每个 Block 退出后才进入下一 Block；Block 02 的
固定路径 API 是 Block 03 fixture 和文档迁移的唯一集成合同。

## 13. 执行审查

- R0：目标、公开兼容变化、唯一 owner、测试隔离和授权完整后进入 Block 01；
- R1：每块核实前置证据、共享文件既有 diff 和直接测试入口；
- R2：逐切片检查路径知识是否只在 Configuration、旧 fallback 是否彻底移除、secret
  是否分离、测试是否不接触真实 HOME；
- R3：Tasks、直接测试、文档和下游合同闭环后完成 Block；
- R4：生产 CLI、acceptance helper、wheel 对同一路径的解释必须一致；
- R5：Full 后对用户结果、兼容、安全、文档、安装包和最终 diff 做交付审查。

Blocking finding 停止执行；改变 owner/接口/迁移的 material finding 返回对应 Block；
ordinary finding 在当前切片修复并复验。

## 14. 进度规则

Task 只有实现、直接测试和对应审查均有真实证据时才勾选；Block 只有退出条件满足后标为
Completed；Plan 只有全局验收、Block 04 和最终交接全部闭环后才标为 Completed。计划状态
不代替源码或 Harness 证据。

## 15. 恢复与续作

跨会话首先读取本 README、当前 Block、`git status --short`、共享文件相对 baseline 的
diff 和最近完成证据。最近恢复点是最后一个标为 Completed 的 Block；不得 reset 或覆盖
未提交工作。测试失败停在当前 Task，保留先前通过切片，先定位根因再继续。

## 16. 计划变更记录

| 日期 | 变化 | 原因 |
| --- | --- | --- |
| 2026-08-26 | 建立四块串行计划 | 固定普通配置路径跨公开合同、生产对象图、fixture、文档和 wheel |
| 2026-08-26 | 完成四块并归档 | 直接测试、Full、确切 wheel 安装后验收和 R5 审查全部闭环 |

## 17. 最终交接

- 实际范围：普通配置唯一生产位置收敛为 `~/.sciretriever/config.toml`；裸配置中心在首次
  确认修改时创建并管理该文件，用户可直接编辑；credentials 继续独立保存。
- 兼容变化：旧配置环境变量和 cwd 自动发现退出；不会自动读取、移动、覆盖或删除旧文件，
  用户按配置手册人工复制或合并。
- 证据：220 项 Configuration/CLI 直接测试、22 项受影响 installed acceptance、权威 Quick、
  2130 项 Full unittest、wheel 内容核对，以及 Full 确切 wheel 的 27 项 installed acceptance
  均通过；详细命令和结果见 Block 03/04。
- 安全与范围：未读取真实 HOME 配置、凭据、Cookie 或 Profile，未连接外部服务；固定目录/
  文件权限、链接和原子发布边界有直接回归。未修改 schema、数据库、资产、依赖或 lockfile。
- 残余风险：旧自动化需要人工迁移到固定路径；本次未执行真实用户文件迁移或外部 Provider
  访问，均属于明确非目标。没有独立 reviewer 授权，R5 由 Primary owner 串行完成。
- Git/发布：未 commit、push、创建 PR 或发布；工作树中既有 Agents/Browser 改动保持原样。
- 归档位置：`docs/archive/2026-08-26-user-configuration-home/`。
