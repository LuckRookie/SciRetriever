# Block 08：验证与交接

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | ABC53–ABC58 |
| 前置块 | Block 01–Block 07 |
| 下游块 | 无；计划关闭 |
| 恢复点 | Block 07 已通过的完整新架构工作树 |

## 1. 块结果

相关直接测试、Quick、Full、fresh-wheel 离线旅程和最终语义/diff 审查形成完整交付证据。计划准确说明完成范围、公开影响、未授权真实测试、残余风险和 Git/发布状态，并只在所有全局验收成立时关闭。

## 2. 进入条件

- Block 01–07 全部 Completed；
- 不存在已知直接测试失败、旧架构残留或未同步 current docs；
- 工作树中的任务文件与用户其它改动边界已经核实；
- 真实 LLM/Publisher/Profile 和 Git 外部动作仍未获授权。

## 3. 责任与改动面

- Owner：Primary Agent；
- 验证入口：`scripts/harness.py`、全部 unittest、wheel build/content、installed acceptance；
- 审查面：requirements/ADR、模块依赖、生产对象图、配置、日志、安全、数据、最终 diff；
- 本块不新增功能；发现问题回到拥有该根因的前置块修复并重新验证。

## 4. 需要保持的行为

- Harness 不连接真实 Provider/LLM/Browser/Profile/凭据；
- Full 任一步失败都不能描述为完整通过；
- 不删除、跳过或弱化有效测试，不修改 Harness 范围虚构绿色；
- 构建产物、cache、PDF、数据库和临时文件不进入最终 diff；
- 未获授权不 commit/push/release。

## 5. Tasks

- [x] **ABC53 — 运行分模块直接测试。** Agents、Analysis、Browser control、Network runtime、Configuration、Bootstrap 和 installed acceptance 全部通过。
  - 验收：记录实际命令、测试数量、skip 和退出码；任何失败回到 owner 块修复后重跑。

- [x] **ABC54 — 运行 Quick。** 执行 `uv run --frozen python scripts/harness.py quick`。
  - 依赖：ABC53。
  - 验收：Ruff lint、Ruff format check 和 compileall 全部退出 0。

- [x] **ABC55 — 运行 Full。** 执行 `uv run --frozen python scripts/harness.py full`。
  - 依赖：ABC54。
  - 验收：Quick、Pyright strict、全部 unittest、wheel build 和 wheel contents 全部退出 0，并记录测试计数。

- [x] **ABC56 — 安装 wheel 离线验收。** 从 fresh wheel 证明配置解析、Analysis object graph、Rules/Agent controller selection 和受控 Browser fixture。
  - 依赖：ABC55。
  - 验收：不通过源码路径偷跑，不读取真实 credentials/Profile，不访问真实服务。

- [x] **ABC57 — 最终语义审查。** 对照 requirements/ADR 检查三级顺序、Publisher 调度、Profile、Network guard、PDF 验收、不可变发布、数据边界、日志脱敏和授权范围。
  - 依赖：ABC55、ABC56。
  - 验收：每项全局 AC 有源码/测试/文档证据；计划未把假设写成发布事实。

- [x] **ABC58 — 最终 diff 与交接审查。** 检查凭据、真实数据、运行资产、构建产物、缓存、个人配置、兼容层、无关改动和 Git 状态。
  - 依赖：ABC57。
  - 验收：根 README“最终交接”填写完整；所有全局 AC 勾选后才将计划和本块标为 Completed。

## 6. 执行方式与集成点

严格按“相关测试 → Quick → Full → fresh-wheel → R5 语义审查 → diff/交接”串行执行。任何阶段失败都回到拥有根因的 Block，修复后从受影响的最低验证层重跑，最终必须重新运行 Full。

本块消费 I4，不产生新功能接口。R5 通过后才可更新根计划 AC、状态和最终交接；真实外部验证与 Git/发布仍由授权门单独控制。

## 7. 审查门

- R1：Block 01–07 Completed，直接 finding 已清零，工作树边界明确；
- R2：每次验证结果审查命令是否覆盖真实集成状态、是否误用源码路径或真实外部资源；
- R3：ABC53–ABC58、Full/fresh wheel、语义与 diff 审查全部闭环；
- R5：从用户结果、计划偏差、架构、数据/兼容性、安全/UX、测试、文档/打包和 release state 七个视角给出交付判断。

## 8. 接口、数据与依赖影响

- 本块不主动改变接口、数据或依赖；
- 若验证要求代码变更，回到对应 Block，更新其完成证据和本块验证结果；
- 最终报告必须明确普通配置与内部 Python API 的破坏性变化、数据库/schema 无变化、依赖/lock 是否变化。

## 9. 验证与证据

建议执行顺序：

```bash
uv run --frozen python -m unittest <相关模块测试>
uv run --frozen python scripts/harness.py quick
uv run --frozen python scripts/harness.py full
```

fresh-wheel 旅程使用 Harness/acceptance 已有隔离机制。证据写入本文件“完成证据”，只保留命令、退出结果、数量与必要摘要，不保存完整原始日志、敏感页面或运行资产。

## 10. 退出条件

- ABC53–ABC58 全部勾选；
- 根 README AC-1–AC-8 全部勾选；
- Full 与 fresh-wheel 离线验收通过；
- 语义/diff/授权审查无未处置 finding；
- 交付说明准确反映 Git 未提交/未发布状态和真实外部测试未运行状态。

## 11. 完成证据

| 检查 | 命令/方法 | 结果 | 日期 |
| --- | --- | --- | --- |
| 分模块直接测试 | 按模块组合执行 `uv run --frozen python -m unittest ...`，覆盖 Agents、Analysis、Browser control/integration、Network Browser/Playwright、Configuration、Bootstrap 和架构切换 | 337 tests，14.788s，全部通过 | 2026-08-26 |
| Installed acceptance | 完整执行 `tests/acceptance` 安装包验收 | 29 tests，197.970s，全部通过，1 个真实 Cloak runtime 用例因未显式 opt-in 而 skip | 2026-08-26 |
| Quick | `uv run --frozen python scripts/harness.py quick` | Ruff lint、Ruff format check、compileall 全部通过，退出 0 | 2026-08-26 |
| Full | `uv run --frozen python scripts/harness.py full` | Pyright 0 errors/0 warnings；2123 tests，244.153s，全部通过，4 个真实 Cloak runtime 边界 skip；wheel build/content 通过，退出 0 | 2026-08-26 |
| Fresh wheel 综合旅程 | 从 Full 产生的预构建 wheel 建立临时 HOME/隔离 venv，清除代理、凭据和 `PYTHONPATH` 后以 `UV_OFFLINE=1` 安装并在仓库外运行 | 21 tests，108.054s，全部通过 | 2026-08-26 |
| Fresh wheel 对象图 | 同一 wheel 上定向验证普通配置、Analysis role、Rules 默认对象图、Agent controller 与共享 Runtime | 4 tests，0.811s，全部通过 | 2026-08-26 |
| Wheel 身份 | `dist/sciretriever-0.1.0-py3-none-any.whl` 内容与 hash 检查 | SHA-256 `d98e024c382e56e9baf388d6259b8703671989ecba451fc44cd78640ba8fdcfd`；包含 `agents/calls.py`、`messages.py`、`runtime.py`、`tools.py`，不包含已删除的 session/request/browser-state 模块 | 2026-08-26 |
| 语义与 diff 审查 | requirements、ADR 0015–0017、生产对象图、直接测试、旧符号搜索、`git status/diff` 和安全清单 | 全部 AC 有实现/测试/current docs 证据；无未处置 finding | 2026-08-26 |

Full 的 4 个 skip 均由未设置 `SCIRETRIEVER_TEST_CLOAK_HOME` 触发，分别对应：九家生产规则的真实 Cloak runtime 类、本地 HTTPS/持久 Profile 的真实 Cloak runtime 类、Cloudflare-shaped 本地页面的真实 Cloak runtime 类，以及 installed-wheel 的真实 Cloak runtime 用例。它们要求显式提供已安装 runtime/Profile，当前授权不允许读取或启动真实 Profile；普通 fake/fixture、统一动作、安装包对象图与打包边界均已通过。

最终 R5 映射：

| 合同 | 生产证据 | 测试/文档证据 | 结论 |
| --- | --- | --- | --- |
| Public → API → Browser | `acquisition/cohort.py` 在前两 tier 完成后才打开 Browser admission；Planner/Registry 固定 tier order | `test_acquisition_matrix.py` 与 ADR 0015 | 通过 |
| Publisher 间并行、同 risk group 串行并服从声明政策 | `BrowserGroupScheduler` 使用全局 permit、逐组 lock 和不可放宽的 `BrowserGroupPolicy`，组内 `max_concurrency` 固定为 1 | scheduler/cohort/integration 直接测试与 ADR 0015/0016 | 通过 |
| 一个固定 Profile/process/context | `BrowserSessionBroker` 只持有一个 `_SharedBrowser`，Publisher lane 复用同一 process/context；Bootstrap 只建立一个 broker/factory | `test_network_browser.py`、`test_bootstrap_readiness.py` 与 ADR 0016 | 通过 |
| Rules/Agent 作业级互斥 | `ControlledBrowserPdfSource` 构造时冻结 controller，并拒绝 Rules 携带 Runtime 或 Agent 缺 Runtime；每次 action 只构造一个 controller | `test_rules_and_agent_modes_never_fallback_into_each_other` 与 ADR 0017 | 通过 |
| Challenge 是统一页面状态 | `BrowserPageState.CHALLENGE` 进入同一 Observation/loop；未解决时只转为文章 route failure | Challenge lifecycle、cohort feedback 和 controller 直接测试 | 通过 |
| 六动作封闭且绑定当前页面事实 | `ClickElement`、`ClickPoint`、`ScrollSurface`、`GoBack`、`WaitForChange`、`Stop` 都校验 article/revision/surface/screenshot；无任意 URL/JS/输入动作 | Browser control/Playwright/architecture cutover 直接测试 | 通过 |
| Network 唯一执行 vendor 动作 | Acquisition 只提交中性 action；`BrowserClient._client_control_execute` 校验当前 ledger 后调用 vendor adapter，并统一 capture | Network action、静态 Rules 共享执行器和 capture pipeline 测试 | 通过 |
| 无 Browser 作业累计预算 | Agent loop 只保留自然终态、语义无进展、取消与单次 action timeout；没有整篇 step/deadline/token/image/repeat budget | 120 秒假时钟仍继续的反向测试、单次 timeout 测试和旧符号搜索 | 通过 |
| Analysis 自己组织两阶段调用 | `AnalysisService`、`MetadataAnalysisStage`、`ReferenceLookupStage` 直接消费无状态 Runtime，阶段顺序与业务验收留在 Analysis | Analysis metadata/reference/content 直接测试与 ADR 0017 | 通过 |
| Configuration/Bootstrap/UX 一致 | `browser_controller`、两个 role readiness、status/test 与一个 adapter/runtime 的生产组装使用同一配置事实 | CLI、configuration、bootstrap 和 installed-wheel 测试 | 通过 |
| PDF 与数据边界未回归 | 所有候选仍经 `validate_pdf`、verified reader、统一 Primary PDF publisher 和 create-if-absent 存储；provenance/owner 不变 | content pipeline/acquisition/storage 现有 Full 测试与 ADR 0015 | 通过 |
| 日志不泄露敏感运行内容 | 日志只记录 role、动作种类、计数、hash/fingerprint 与稳定 failure；全局 redaction 继续过滤 secret/URL query | Agents/Browser/CLI/logging 直接测试和 Logging 技术文档 | 通过 |
| 无兼容双路径 | 旧文件已删除，生产 AST/符号搜索无 Session、Browser state/budget/challenge 专属控制面 | `test_architecture_cutover.py` 与 wheel contents | 通过 |

Block 08 验证期间发现并解决 3 个 ordinary finding：installed CLI status acceptance 补齐新 `missing_fields` 合同；installed Controlled Browser fixture 改走统一 snapshot/action executor；旧假时钟测试改为验证单次 vendor timeout，并保留“整篇无 deadline”的反向证明。三项修复后均重跑直接证据，最终重新完整运行 Full。

## 12. 失败与恢复

- 相关测试失败：回到直接 owner 块；
- Quick 失败：修复格式/lint/compile 根因后重跑相关测试与 Quick；
- Pyright/全量测试/wheel 失败：回到接口、对象图或 packaging owner，不弱化门禁；
- 语义审查失败：回到 Block 01 或对应实现块，不以 Full 绿色替代合同修复；
- 每次修复后从受影响最低层重新验证，最终重跑 Full。

## 13. 下游交接

无下游实现块。完成后更新根 README 状态与最终交接；按 `docs/plans/README.md` 决定该计划是否因长期审计价值进入 `docs/archive/`，并确保有效产品/架构/使用事实已进入各自真相源。
