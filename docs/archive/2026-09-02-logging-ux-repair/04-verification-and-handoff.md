# Block 4：验证、文档与交接

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | `VER01`-`VER05` |
| 前置块 | Block 1-3 Completed |
| 下游块 | 无 |
| 恢复点 | 最后一个通过的验证层级 |

## 块结果

集成工作树中的日志 UX、业务生产者、外部诊断、文档与安装产物形成闭环，具备开始后续真实整体测试的离线质量基础。

## 进入条件

- 前三块全部 Tasks 和直接测试完成；
- 根计划没有未解决的 material/blocking finding；
- 工作树中的其它用户改动仍受保护且已知。

## 责任与改动面

Primary owner 负责集成测试、README/Logging technical 当前行为同步、Quick/Full、最终 diff 与安全审查、计划状态和交接。不得执行真实外部测试、commit、push 或发布。

## 需要保持的行为

- 已接受产品、Report、模块与安全边界；
- 当前 Config、Model、Provider stream、Search/Download/Parse/Analyze/Browser 行为；
- Python 3.10+、uv、unittest、wheel 内容和现有依赖基线。

## Tasks

- [x] **VER01 — 运行日志集成测试。** 执行全部日志、相关业务、Probe、Browser/Network 离线测试并解决普通 finding。
  - 验收：目标测试全部通过，无真实网络调用。
- [x] **VER02 — 同步当前行为文档。** 更新 README 与 Logging technical，准确描述新 INFO/DEBUG、布局、失败和 Probe 边界，不把未实现能力写成当前行为。
  - 依赖：VER01。
  - 验收：文档、源码、测试一致，链接和示例有效。
- [x] **VER03 — 运行 Quick。** 对全库活动 Python 执行 lint、format check 与 compileall。
  - 依赖：VER01。
  - 验收：`scripts/harness.py quick` 通过。
- [x] **VER04 — 运行 Full。** 执行 Pyright strict、全部 unittest、wheel 构建与内容核对。
  - 依赖：VER02、VER03。
  - 验收：`scripts/harness.py full` 通过；环境阻断则准确记录且计划保持未完成。
- [x] **VER05 — 最终语义与安全审查。** 对照用户目标、计划、架构、最终 diff、凭据/真实数据/构建产物和 Git 状态审查。
  - 依赖：VER04。
  - 验收：无 blocking/material finding，残余风险和真实测试授权边界明确。

## 执行方式与集成点

按 VER01-05 串行。Full 失败时回到产生失败的拥有块修复并重新运行相关测试，再从适当验证层级继续；不降低门禁或排除文件。

## 审查门

- R4：组合状态的 INFO/DEBUG、Probe、安全、对象图和文档一致；
- R5：Full 后检查原始目标、最终 diff、证据、残余风险、Git/发布状态。

## 接口 / 数据 / 依赖影响

预期无公开 API、配置 schema、Catalog schema、依赖或对象图变化。若实际出现，停止并返回根计划/用户决定。

## 验证与证据

```bash
uv run --frozen python scripts/harness.py quick
uv run --frozen python scripts/harness.py full
git diff --check
git status --short
```

另外按前序块记录的模块测试执行集成回归。

## 退出条件

- VER01-05 全部完成；
- Full、文档检查、最终语义与安全审查通过；
- 根计划全局验收全部成立；
- 交接准确说明实际行为、证据、影响、残余风险和未授权动作。

## 完成证据

完成于 2026-09-02：

- VER01：19 个日志相关测试模块共 468 项离线测试通过，覆盖 Presenter、Metadata、Agents、Discovery/Completion、Acquisition、Browser、Network 与 Config probe；
- VER02：README 和 Logging technical 已同步静态 `context/reason/action/details/source` 布局、INFO owner、DEBUG 下钻、action-required WARNING、Agent/Browser 分层及 Probe wire request 展示；
- VER03：`uv run --frozen python scripts/harness.py quick` 通过，Ruff lint、411 个活动 Python 文件 format check 与 compileall 均通过；
- VER04：`uv run --frozen python scripts/harness.py full` 通过，Pyright strict 为 0 errors/0 warnings，Full 发现 2226 项 unittest 并通过，wheel 构建与源码内容核对通过；
- VER05：`git diff --check` 通过；新增行未发现常见凭据 token；diff 不包含 `pyproject.toml`、`uv.lock`、个人 config/credentials、数据库、PDF 或构建产物。Logging 改动未增加公开 API、配置/Catalog schema、依赖或生产对象图。

工作树仍包含 baseline 已有的 Configuration、Agents、Provider stream 与配置测试改动，保持未提交且未被回滚。本块没有连接真实外部服务、读取个人凭据、执行 commit/push/PR 或发布。

## 失败与恢复

记录失败命令和首个拥有层，回到对应 Block 的最后通过 Task；保留用户工作，不使用破坏性 Git，不把未通过描述为已验收。

## 下游交接

完成后可以在新的明确授权下执行真实 Model、Search、Download、Parse 和 Analyze 整体测试。本计划通过只证明离线对象图、日志 UX 和安装产物就绪，不证明真实外部服务或凭据可用。
