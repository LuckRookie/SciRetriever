# Block 06：Configuration、Bootstrap 与 UX

| 字段 | 值 |
| --- | --- |
| 状态 | Completed |
| Task 范围 | ABC42–ABC50 |
| 前置块 | Block 03、Block 05 |
| 下游块 | Block 07 |
| 恢复点 | Analysis 与两个 Browser controller 的已通过构造合同 |

## 1. 块结果

普通配置以一个 Agent service、Analysis/Browser 两个角色 binding 和一个 `access.browser_controller` 选择表达生产对象图。Bootstrap 每次只构造一个 Provider adapter/runtime 和一个选定 Browser controller。交互式配置、`config status/test`、示例、指南和日志能够清楚说明角色 readiness 与当前 controller，而不读取或展示 secret。

## 2. 进入条件

- Block 03 和 Block 05 Completed；
- Analysis/Browser 消费者只依赖新 Runtime/controller 合同；
- 现有 Configuration package、credential editor、status/probe、Bootstrap assembly/graphs/services 和 CLI UI 已重新核实。

## 3. 责任与改动面

- Owner：`src/sciretriever/configuration/`、`src/sciretriever/bootstrap/`、相关 entry/config UI 与 logging presentation；
- Model：`src/sciretriever/model/configuration.py` 的普通配置值；
- 当前文档：`example/config.example.toml`、`docs/guides/configuration.md`、README 中实际配置面；
- Tests：model/configuration/status/UI/probes/bootstrap/CLI/installed production journey；
- 受保护工作：credentials.toml 唯一 secret 来源、无环境变量模式、owner-only 权限、纯本地 status 与显式 probe。

## 4. 需要保持的行为

- `sciretriever config` 默认进入交互式管理，`status` 与 `test` 为子命令；
- LLM/Browser role secret 不复制，不出现 placeholder 冒充 configured；
- status 不访问网络，test 只发送固定最小 probe；
- Browser 总开关、Profile/Cloak readiness、controller readiness、机构 IP/文章 entitlement 仍是分立事实；
- 配置错误返回可读原因且不泄漏完整路径、secret 或页面内容。

## 5. Tasks

- [x] **ABC42 — 新增 `access.browser_controller`。** 只接受 `rules` 或 `agent`，默认 `rules`，作业开始时冻结。
  - 验收：未知值在 Configuration boundary 拒绝；运行中不切换、不 fallback。

- [x] **ABC43 — 清理 Browser Agent 配置。** 删除 `turns`、`deadline_seconds` 和其它作业预算字段，保留 Browser role model/capability 与单次 max output。
  - 依赖：ABC42。
  - 验收：parser、default、status、example、tests 均无旧字段或 fallback。

- [x] **ABC44 — 完善角色 binding 配置。** Analysis 与 Browser 可绑定相同或不同 model，但共用同一 Agent service/credential/quota 基础。
  - 依赖：ABC43。
  - 验收：消费者不读取 provider/base URL/model；相同 endpoint 不复制 secret 或 AccessScope。

- [x] **ABC45 — 重组 Bootstrap。** 构造唯一 Provider adapter、`AgentRuntime`、两个 role binding 和一个选定 Browser controller。
  - 依赖：ABC44、Block 03、Block 05。
  - 验收：未选模式不进入生产对象图；Browser role 未 ready 在 Agent 模式明确失败但不破坏 Analysis readiness。

- [x] **ABC46 — 更新交互式配置 UI。** 清楚解释 Agent service、两个角色和 Browser controller 选择，不重新引入环境变量或 secret 占位符。
  - 依赖：ABC42–ABC44。
  - 验收：新增/移除配置使用 credentials store；取消操作不写半成品。

- [x] **ABC47 — 更新 `config status/test`。** 结构化展示 Agent service、Analysis/Browser role readiness 和 controller；只有显式 test 才做最小 probe。
  - 依赖：ABC44–ABC46。
  - 验收：status 不发 I/O；test 可分别说明 structured/tool/image capability 缺口和稳定失败。

- [x] **ABC48 — 更新示例与用户指南。** 同步 config example、配置指南和当前使用方式，不把未实现行为提前写入 current docs。
  - 依赖：ABC42–ABC47。
  - 验收：示例无真实 secret/placeholder configured 误导；命令和字段与代码一致。

- [x] **ABC49 — 更新日志事件。** INFO 保留 role/provider/model、动作结果和通俗失败；DEBUG 记录脱敏 observation/action/receipt/fingerprint。
  - 依赖：Block 02、Block 04、Block 05。
  - 验收：不记录 screenshot bytes、页面正文、元素敏感文本、prompt/模型原文、Cookie、Token 或签名 URL。

- [x] **ABC50 — 配置与对象图测试闭环。** 覆盖默认 Rules、显式 Agent、readiness、status、probe 分流、未选 controller 不构造和 fresh config 旅程。
  - 依赖：ABC42–ABC49。
  - 验收：Configuration/Bootstrap/CLI/installed production journey 相关测试通过，Ruff/Pyright 无错误。

## 6. 执行方式与集成点

按“配置 Model/parser → role binding → Bootstrap 生产图 → 交互 UI/status/test → 示例/日志 → installed journey”推进。每次配置切片同时更新 parser、默认值和直接测试；current docs 只在对应行为可从生产对象图观察后更新。

本块完成 I3：Analysis 与 Browser 共用一个 adapter/runtime，两个 role binding 独立 readiness，下载作业只构造配置选中的一个 controller。

## 7. 审查门

- R1：I1/I2 已通过，消费者构造签名和配置影响矩阵仍准确；
- R2：每个配置/组装切片审查默认值、错误 UX、secret 来源、status 无 I/O 和未选对象不构造；
- R3/I3：fresh config、status/test、对象 identity 和 installed production journey 证明唯一生产图；
- 公开配置兼容性若与当前假设冲突，作为 material finding 返回 Block 01/用户决策。

## 8. 接口、数据与依赖影响

- 普通配置新增/固化 `access.browser_controller`，删除旧 Browser 作业预算字段；
- credentials.toml 的 service secret 存储语义不变；
- 不修改数据库或资产 schema；
- 不新增依赖；
- 公开 CLI 子命令结构不变，但 status/UI 展示内容更新。

## 9. 验证与证据

- Configuration model/boundary/editing/UI/status/probe tests；
- Bootstrap readiness/assembly/production graph tests；
- `tests/test_cli.py` 与 installed CLI/production journey；
- fake transport 计数证明 status 无 I/O、test 才 I/O；
- 日志 capture tests 证明脱敏。

## 10. 退出条件

- ABC42–ABC50 全部勾选；
- fresh config 可明确选择 Rules/Agent 并看到正确 readiness；
- 生产对象图只拥有一个 Runtime 和一个 controller；
- 当前配置文档、示例、UI 和源码一致。

## 11. 完成证据

- `access.browser_controller` 默认 `rules`，严格拒绝未知值；交互式 plain/Rich 入口展示互斥
  controller，取消不写入，已有 Browser role 在 Rules 模式保留但不组装；
- Configuration status、Bootstrap 前置检查与 `AgentRuntime.readiness(BROWSER)` 共同要求生产
  Observation 的 `image/png`、至少一张图片和正字节上限；JPEG-only role 在三层均于 I/O 前失败；
- Content Completion 的 Analysis/Browser 与 Asset Completion 的九条 Browser route 复用一个
  `AgentRuntime` identity；Rules 模式不注入 Browser Agent，Agent 缺 role/credential 时以
  `browser-agent-not-ready` 在 Storage 创建前失败；
- `config status` 纯本地展示 service、两个 role、controller/required role/readiness；显式
  `config test browser-agent` 发送固定 synthetic probe，`--all` 只在 Agent controller 被选中时
  包含 Browser role，Rules 模式不调用未选模型；
- INFO/DEBUG 日志测试证明 controller/result/action 与脱敏 Observation/receipt/fingerprint 可见，
  页面标题、元素文字/ID、tool payload 和 screenshot bytes 不进入 LogRecord；
- 相关验证：253 项 Configuration/Bootstrap/CLI/Agents/Browser controller 测试通过；目标 Ruff
  lint/format 通过；目标 Pyright 为 `0 errors, 0 warnings, 0 informations`；公开配置示例成功解析；
  fresh wheel 的离线 `test_installed_asset_completion_uses_the_shared_acquisition_runtime` 通过；
- 所有自动验证只使用 fake/fixture/离线边界，没有读取真实 credential、启动真实 Browser 或发送
  Provider/LLM/MinerU 网络请求；数据库、资产 schema、credential schema 与依赖均未变化。

## 12. 失败与恢复

- 若旧字段属于受支持公开合同，停止破坏性删除并回到用户/ADR 决策；不能偷偷 fallback；
- 若 status 为了 readiness 需要真实 probe，拆分本地声明与显式 test，不让 status 访问网络；
- 若对象图同时构造两个 controller，回到 ABC45，不在调用期做 if/fallback。

## 13. 下游交接

Block 07 可以删除全库旧配置、组装、日志和文档术语；Block 08 可从 fresh wheel 观察完整新配置与对象图，而不依赖源码注入。
