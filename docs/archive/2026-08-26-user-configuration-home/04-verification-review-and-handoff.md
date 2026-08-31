# Block 04 — 验证、审查与交接

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | `UCH12`–`UCH15` |
| 前置块 | [03](03-fixtures-docs-and-installed-behavior.md) |
| 下游块 | 无 |
| 恢复点 | Full、fresh-wheel 和最终语义审查均有可复现证据 |

## 块结果

完整源码、测试、wheel、current docs 和最终 diff 共同证明唯一用户配置路径已交付，公开
兼容变化、安全边界和人工迁移方式可准确交接。

## 进入条件

Blocks 01–03 Completed；直接测试和 installed acceptance 通过；没有未解决 material finding。

## 责任与改动面

Primary owner：Codex。验证全仓、wheel 和任务 diff；只修复本计划 finding，不顺手整理
其它受保护工作。无独立 reviewer 或并行执行授权。

## 需要保持的行为

HARNESS 全部既有门禁、wheel 内容、离线测试边界、用户数据/secret 安全和 Git 授权。

## Tasks

- [x] **UCH12 — 通过 Quick 与 Full。** 运行仓库权威 Harness，不弱化或跳过步骤。
  - 依赖：UCH08–UCH11。
  - 验收：Quick、Pyright strict、全部 unittest、wheel 构建和内容核对全部通过。
- [x] **UCH13 — 通过 fresh-wheel 固定路径验收。** 从新建 wheel 环境和临时 home 运行关键
  CLI/R1–R8 相关离线旅程，证明不依赖源码树 cwd 或旧环境变量。
  - 依赖：UCH12。
  - 验收：安装后唯一文件、缺失错误和 CLI 管理路径通过，未读取真实 home。
- [x] **UCH14 — 完成 R5 语义与安全审查。** 对照用户目标、ADR、对象图、旧行为残留、
  credentials 分离、权限/链接、迁移文案、依赖和最终 diff 审查。
  - 依赖：UCH12–UCH13。
  - 验收：blocking/material/ordinary findings 已解决或准确记录残余风险。
- [x] **UCH15 — 更新证据并完成交接。** 回填命令结果、勾选真实完成 Task、更新计划状态
  与最终交接；计划完成后归档，不把计划当 current truth。
  - 依赖：UCH14。
  - 验收：交付说明含范围、验证、兼容/迁移、未运行项、风险、依赖/schema、Git 状态。

## 执行方式与集成点

串行执行 direct regression -> Quick -> Full -> fresh-wheel -> R5 -> 证据/归档。Full 后若只
修改计划 Markdown，不重复 Full，但重新运行 `git diff --check`。

## 审查门

- R1：所有前置 Blocks 与直接证据完整；
- R4：production graph、acceptance、wheel 和文档解释一致；
- R5：用户结果、兼容、安全、范围、证据和交付完整后完成。

## 接口 / 数据 / 依赖影响

本块不计划新增接口、数据或依赖；发现需要时必须路由回对应 Block 并重新验证。

## 验证与证据

`scripts/harness.py quick/full`、安装 wheel 的隔离 home acceptance、`rg`、
`git diff --check`、任务范围 diff、secret/生成物检查。

## 退出条件

UCH12–UCH15 和全局验收全部勾选；计划状态 Completed 并移动到 `docs/archive/`。

## 完成证据

- `uv run --frozen python scripts/harness.py quick`：exit 0；Ruff lint、Ruff format check、
  `compileall` 全部通过。
- `uv run --frozen python scripts/harness.py full`：exit 0；Pyright strict 为 0 errors / 0
  warnings；全量 `Ran 2130 tests in 254.034s`，`OK (skipped=4)`；wheel 构建与源码模块内容
  核对通过，产物为 `sciretriever-0.1.0-py3-none-any.whl`。
- 以 Full 产物设置 acceptance-only `SCIRETRIEVER_ACCEPTANCE_PREBUILT_WHEEL`，运行
  `uv run --frozen python -m unittest discover -s tests/acceptance -p
  'test_installed_*.py'`：`Ran 27 tests in 173.695s`，`OK (skipped=1)`。每个旅程使用临时
  HOME、离线依赖缓存和 fake/fixture 外部边界。
- R5 所有权审查：活动 `src/` 无旧配置环境变量、selector 或 selected-loader；生产 Entry 只
  调用 `load_user_configuration()`，写入函数只从 Configuration 的 `configuration_path(home)`
  解析固定文件；任意路径 `load_configuration(path)` 仅剩显式文档解析定义和直接测试调用。
- R5 安全审查：目录 `0700`、文件 `0600`、owner、普通文件、非符号链接、单硬链接、bounded
  descriptor read、读取期间身份复核、同目录 staging/fsync/原子 replace 及失败恢复都有直接
  测试；普通配置与 credentials 没有合并，测试未读取真实 HOME 或 secret。
- R5 兼容/UX/文档审查：缺失文件给出 `sciretriever config` 初始化动作；旧 env/cwd 明确不
  生效且不会自动迁移；README、配置手册和示例使用 `cp -n` 避免覆盖已有目标。审查中发现并
  修正配置手册残留的“九组”计数和可覆盖迁移命令，复查 current docs 旧行为搜索无结果。
- R5 范围审查：无依赖、lockfile、配置 schema、数据库、资产或外部服务变化；未发现
  blocking/material finding。未启用独立 reviewer，因为计划的并行/独立审查 Human Gate 未获
  授权；Primary owner 完成串行集成审查。
- 最终运行 `git diff --check`、旧行为 `rg`、任务文件/生成物/secret 文件名检查；归档后复验
  结果记录在计划根交接。未执行 Git commit、push、PR 或发布。

## 失败与恢复

Harness 或 fresh-wheel 失败保留原生输出并回到引入 finding 的 Block；不降低门禁或恢复旧
fallback。环境性阻断准确记录已运行检查与残余风险，不虚构通过。

## 下游交接

无。最终用户获得固定配置路径、CLI/人工编辑方式、旧配置人工迁移说明和完整验收证据。
