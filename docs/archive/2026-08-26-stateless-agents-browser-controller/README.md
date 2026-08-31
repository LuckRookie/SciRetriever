# 无状态 Agents 与 Browser Controller 重构

> 历史实施记录，非当前产品或架构真相源。当前行为以 requirements、Accepted ADR、current docs、源码与测试为准。

| 字段 | 值 |
| --- | --- |
| Run ID | `2026-08-26-stateless-agents-browser-controller` |
| 创建日期 | 2026-08-26 |
| Primary owner | Codex |
| Baseline revision | `b1322d32d9689ebf65b27e65eae13f3c6a855007` |
| 执行模式 | 单一 Primary Agent，允许跨会话恢复 |
| 当前状态 | Completed and archived — 2026-08-26 |
| 计划规范 | [活动实施计划治理规范](../../plans/README.md) |

## 1. 目标观察

完成后，SciRetriever 只有一个 Provider-neutral、无状态、一次执行一个模型调用的 Agents 窄腰运行时。Analysis 自己编排两阶段分析；Acquisition 自己编排 Browser Agent 循环；Network 唯一执行 Browser 动作和捕获下载。

受控 Browser 在一项下载作业开始前固定选择 `rules` 或 `agent`：

- `rules` 只执行确定性页面规则，不调用模型；
- `agent` 从第一次统一页面 Observation 起由 Agent 选择封闭动作，不先运行确定性点击规则；
- 两种模式共享 Publisher 知识、CloakBrowser runtime、Profile、Network guard、capture 和 PDF 验收；
- 两种模式不是前后 fallback。

Challenge 只是统一 `BrowserObservation.page_state` 的一种值，和普通页面使用相同 Observation、动作、循环与自然终态，不再拥有专属 target、controller、预算或状态机。

## 2. 授权与真相源

本计划实施用户已经确认的“窄腰 Agents + 消费模块控制器 + Rules/Agent 二选一”设计。适用真相源：

- [产品需求](../../architecture/requirements.md)；
- [架构原则](../../architecture/principles.md)；
- [设计文档](../../architecture/design.md)；
- [ADR 0015](../../architecture/decisions/0015-publisher-aware-tiered-pdf-acquisition.md)；
- [ADR 0016](../../architecture/decisions/0016-cloakbrowser-fixed-identity-runtime.md)；
- [ADR 0017](../../architecture/decisions/0017-shared-agents-and-controlled-browser-agent.md)；
- [技术文档索引](../../architecture/technical.md)及 Agents、Analysis、Acquisition、Network、Configuration、Entry、Logging 子文档。

计划可以组织实现和记录证据，不能自行改变产品边界、数据库事实所有权、外部访问授权或已接受 ADR。

## 3. 事实、假设与开放问题

### 已核实事实

- baseline 上已有共享 `agents/` 与 CloakBrowser 生产 runtime；此前 Full Harness 为 Ruff/format/compileall/Pyright/2103 tests/4 skipped/wheel 全部通过；
- 以下六项是 baseline `b1322d32d9689ebf65b27e65eae13f3c6a855007` 的迁移起点，不是当前实现：Agents 当时仍公开 `AgentSession`/`open_session` 并累计作业预算，Analysis 为每次调用创建 `max_turns=1` session，Browser Agent 具有 8 steps/60 seconds/repeat/token/image 硬预算，普通 Browser 是 Rules miss 后 Agent fallback，Observation 缺少统一 popup/frame/Shadow/viewer surface 与通用坐标点击，配置仍含 Browser Agent `turns`/`deadline_seconds`；
- Block 07 I4 已核实当前实现只保留无状态一次调用 Runtime、Analysis 自有两阶段控制器、作业前冻结的 Rules/Agent controller、统一 Observation/六动作/Challenge 与客观单次 operation limits；
- 任务开始时已有 14 份未提交架构文档改动，属于受保护工作；本计划在其基础上收敛，不回滚。

### 已由实现和离线验收验证的假设

- 三个 Provider adapter 已在不复制协议代码的前提下接收 Runtime 绑定 model 的单次 wire call；
- 统一 surface tree 已覆盖当前生产规则和 fixture 所需的 page/frame/popup/viewer 事实，vendor DOM 对象没有越过 Network；
- 语义 page/action/result fingerprint 已识别无进展循环，并由直接测试证明不需要固定重复次数；
- controller 选择和 role binding 已在不迁移数据库、资产布局或 credential schema 的前提下完成。

### 未授权真实验证留下的开放问题

- 真实 Publisher 页面中的 closed Shadow DOM、canvas、popup/viewer 组合仍需在用户显式授权真实 Profile/runtime 后验证；若无法满足 screenshot revision/viewport 合同，应回到 Browser action 设计，不能放宽为任意 JavaScript；
- 真实 LLM endpoint 的严格 tool decision 与两种 role capability 尚未探测；协议不满足时必须形成稳定 capability failure，不能退化为自由文本解析；
- 旧普通配置中的 `[agents.analysis].deadline_seconds`、`[agents.browser].turns` 和 `[agents.browser].deadline_seconds` 已按“不保留旧架构兼容层”目标移除；包含这些字段的旧配置需要人工删除，不提供兼容解析。

## 4. 范围与非目标

### 本次范围

- 无状态 Agents runtime、角色 binding、readiness、单次结果与稳定失败；
- Analysis 两阶段和 ReferenceLookup 去 Session 迁移；
- 统一 Browser snapshot/observation/surface/action/receipt/capture 合同；
- `RuleBrowserController` 与 `AgentBrowserController` 作业级二选一；
- 自然终态和语义无进展检测；
- 配置、交互式配置、status/test、Bootstrap、日志、示例与用户文档同步；
- 删除旧 session、累计预算、challenge 专属类型和 fallback 架构；
- 直接测试、Quick、Full、fresh-wheel 离线验收和最终语义审查。

### 非目标

- 登录、机构选择、MFA、文本输入、文件上传、任意 URL、任意 JavaScript；
- 外部 challenge solver、token 注入、身份或出口切换；
- 长期 Agent memory、Planner、通用 Workflow、Tool Registry、AgentRun/Turn 持久化；
- Browser-first 或改变 `PUBLIC -> AUTHORIZED_PROVIDER_API -> CONTROLLED_BROWSER`；
- 数据库 schema、资产布局、导入导出格式或凭据存储模式迁移；
- 真实 Publisher/LLM/Profile 测试、Git commit/push/PR 或发布。

## 5. 全局验收条件

- [x] **AC-1**：Accepted ADR、design 与 technical 只描述无状态 Agents、统一 Challenge、Rules/Agent 二选一和客观单次技术限制。
- [x] **AC-2**：`agents` 不拥有业务 workflow、Browser loop、长期状态、工具执行或事实写入；公共面不存在 Session。
- [x] **AC-3**：Analysis 直接执行两次单次调用并保持阶段顺序、业务验收、稳定失败和最终 provenance。
- [x] **AC-4**：Network 提供统一 revision/surface/screenshot/element/receipt/capture，并唯一执行六种封闭动作。
- [x] **AC-5**：Rules 模式不调用 Agent；Agent 模式不先执行 Rules；Challenge 通过同一 Agent loop 处理。
- [x] **AC-6**：不存在 Browser 作业 step/time/token/image/repeat 硬预算；用户取消、单次 timeout、quota、真实错误和语义无进展仍能自然停止。
- [x] **AC-7**：Configuration、Bootstrap、status/test、日志、示例、指南和安装 wheel 只暴露新对象图。
- [x] **AC-8**：全库旧符号与旧概念清除，直接测试、Quick、Full 和最终语义审查全部通过。

## 6. 分块地图

| 顺序 | 大块 | 结果 | 前置 | 状态 |
| --- | --- | --- | --- | --- |
| 01 | [合同与基线收敛](01-contract-and-baseline.md) | 目标文档、范围和恢复门成为单一合同 | 无 | Completed |
| 02 | [无状态 Agents runtime](02-stateless-agents-runtime.md) | 单次 Runtime/Port/Provider 公共面和直接测试 | 01 | Completed |
| 03 | [Analysis 迁移](03-analysis-migration.md) | 两阶段与 ReferenceLookup 直接消费 Runtime | 02 | Completed |
| 04 | [Browser Observation 与动作](04-browser-observation-and-actions.md) | Network 统一 snapshot/surface/action/capture | 01 | Completed |
| 05 | [Browser Controllers](05-browser-controllers.md) | Rules/Agent 二选一、统一 Challenge、自然终态 | 02、04 | Completed |
| 06 | [Configuration、Bootstrap 与 UX](06-configuration-bootstrap-and-ux.md) | controller 选择、角色绑定、status/test 和对象图 | 03、05 | Completed |
| 07 | [旧架构删除与文档同步](07-legacy-removal-and-documentation.md) | 旧符号/兼容层清零，当前文档完整 | 03、06 | Completed |
| 08 | [验证与交接](08-verification-and-handoff.md) | Full/fresh wheel/语义审查和最终交付 | 01–07 | Completed |

真实依赖：

```text
01 -> 02 -> 03 -----------+
 |     |                  |
 +---->04 -> 05 -> 06 -> 07 -> 08
```

02 与 04 在合同稳定后可以独立推进，但 Primary owner 负责统一接口与集成；当前执行不派遣额外 worker。

## 7. 跨块合同

- 三级 PDF 获取顺序、统一逻辑文献数据库、事实写入所有者、provenance/lineage 和不可变资产发布不变；
- 一个 operator-managed 固定身份 Profile、一个 CloakBrowser process/persistent context、服务器原始出口不变；
- Publisher risk group 之间可并行，同组始终 `concurrency=1` 并遵守声明政策；
- Publisher 知识继续拥有 route、allowed origins、risk/rate policy、page-state marker、主 PDF 判别、popup/viewer admission 和 capture validation；
- Network 唯一持有 Browser vendor 对象并执行动作；Acquisition 唯一解释“取得当前主 PDF”的目标与 route outcome；
- Agent 不取得 Page、Context、Profile、Cookie、CDP、selector、文件系统或事实写入能力；
- 日志与计划不保存 prompt、模型原文、screenshot bytes、页面正文、Cookie、Token、签名 URL、真实 PDF 或用户语料；
- 自动测试和 Harness 只使用 fake/fixture，不访问真实 Provider、LLM、Profile 或凭据。

## 8. 影响矩阵

| 面向 | 计划影响 |
| --- | --- |
| 公共 CLI | `config` 展示和交互字段变化；下载命令层级不变 |
| 普通配置 | 新增/固化 `access.browser_controller = rules | agent`；删除 Browser 作业预算字段 |
| 凭据 | 存储位置与 secret schema 不变；两个角色复用一个 Agent service credential |
| Python 内部接口 | `AgentSession/open_session/AgentRequest` 切换为无状态 Runtime/Call；Browser controller/action 合同变化 |
| 数据库/schema | 无变化 |
| 资产/文件格式 | 无变化 |
| 外部依赖 | 预计无新增依赖；若实现证据要求变化必须单独记录并更新 lock |
| 运行对象图 | 一个 Agent adapter/runtime、两个 role binding、一个选定 Browser controller |
| 文档 | ADR、design、technical、配置指南、示例和当前 README 按实际行为同步 |
| 打包 | 删除/新增 Agents 源码模块必须由 wheel 内容门证明一致 |

## 9. 风险与转化信号

| 风险 | 观察信号 | 应对 |
| --- | --- | --- |
| 无状态 Runtime 仍泄漏 Provider/model 选择给消费者 | Analysis/Acquisition 构造 model 或 adapter 类型 | 回到 Block 02 重新收窄 Runtime |
| Observation 为支持 Browser 而暴露 vendor DOM | 公共值出现 Page/Locator/selector/CDP | 回到 Block 04，改为短期 ID 与 Network lookup |
| 删除硬预算导致真实死循环 | 同语义页面和动作反复得到同结果 | 使用语义转换记录；若不足，回到 Block 05 调整 fingerprint，不恢复固定次数 |
| Rules/Agent 仍形成隐式 fallback | 同一作业对象图同时构造/调用两个 controller | 停止 Block 06，修正配置冻结与组装 |
| 文档提前描述未实现行为 | README/指南先于代码切片变化 | 目标文档与当前行为文档分开更新 |
| 大范围测试 churn 掩盖边界错误 | 测试只验证内部字段而非结果 | 把证据移回 owner 边界和生产对象图 |

当任何风险改变模块 owner、公开配置、数据兼容性或安全授权时，停止当前块并回到调查/设计或请求用户决定。不得通过兼容层、静默 fallback 或弱化测试掩盖方向变化。

## 10. 验证与证据策略

| 顺序 | 声明 | 检查 | 层级 | 证据归属 |
| --- | --- | --- | --- | --- |
| 1 | 单个 Task 结果正确 | 最小直接 `unittest` / 静态搜索 | L0 | 对应块“完成证据” |
| 2 | 单块接口与对象图正确 | 模块 integration tests、Ruff/Pyright 相关路径 | L1/L2 | 对应块“完成证据” |
| 3 | 全库机械质量通过 | `uv run --frozen python scripts/harness.py quick` | L1 | Block 08 |
| 4 | 安装包与跨模块旅程正确 | relevant acceptance/fresh-wheel tests | L3 | Block 08 |
| 5 | 全部代码门禁通过 | `uv run --frozen python scripts/harness.py full` | L3 | Block 08 |
| 6 | 产品/架构/安全边界保持 | requirements/ADR/final diff 专项审查 | L4 | Block 08 |

计划只记录命令、退出结果、测试数量和正式文件链接，不保存原始敏感日志或运行资产。

## 11. 授权门

| 动作 | 当前授权 |
| --- | --- |
| 修改仓库内目标文档、源码、测试、示例并运行离线 fixture/Harness | 已授权 |
| 同时推进多个实现/迁移执行单元或启用 worker-assisted 模式 | 未授权；必须由人类明确批准具体并行范围 |
| 读取真实 credentials、Cookie、个人 config/Profile 或用户语料 | 未授权 |
| 使用真实 LLM/Publisher/机构 IP 下载或发起外部 probe | 未授权，需另行明确授权 |
| 数据库/资产迁移或删除 | 未授权且不在范围 |
| Git commit、amend、rebase、push、PR、发布 | 未授权，需另行明确授权 |

## 12. 执行方式与集成点

当前执行模式为 `cross-session`、单一 Primary owner、串行集成。计划级并行执行未获人类授权，默认关闭。虽然依赖图允许 Block 04 在 Block 01 后独立开始，但当前不能据此并行推进共享架构重构；实际顺序固定为：

```text
01 -> 02 -> 03 -> 04 -> 05 -> 06 -> 07 -> 08
```

这样先让 Analysis 成为无状态 Agents Runtime 的真实消费者，再扩展 Browser 消费面，避免两个消费者同时追逐尚未稳定的公共接口。若未来要改为 worker-assisted 或并行执行，必须先取得人类对具体并行范围的明确同意，再更新本节、授权门、分块地图、文件 owner、共享合同、汇合点、停止条件和计划变更记录。普通的“继续执行”或“开始实施”不构成该同意。

每个 Task 使用同一执行循环：

1. **Preflight**：重读当前 Task、适用合同、owner、直接调用方、测试和受保护 diff；
2. **Slice**：完成一个最小但完整的结果切片，不在多个块之间留下长期半迁移状态；
3. **Direct evidence**：运行最小直接测试、静态检查或精确 `rg`；
4. **Slice review**：审查实际 diff、错误路径、边界、范围、测试和必要文档；
5. **Resolve**：普通 finding 当前修复，material/blocking finding 路由回 owner/设计/用户；
6. **Record**：只有 finding 解决且验收成立后，填写块内完成证据并勾选 Task；
7. **Integrate**：Block 完成时运行块级对象图/接口测试，通过退出审查后再进入下游。

计划设置四个显式集成点：

| 集成点 | 上游结果 | 必须证明 |
| --- | --- | --- |
| I1 — Analysis integration | Block 02 + 03 | Runtime 公共面由真实 structured consumer 使用，旧 Session 已不再需要 |
| I2 — Browser integration | Block 04 + 05 | Agent controller 只依赖统一 Observation/action，Rules/Agent 互斥 |
| I3 — Production graph | Block 03 + 05 + 06 | 一个 adapter/runtime、两个 role binding、一个选定 controller |
| I4 — Delivery candidate | Block 01–07 | 旧架构清零、current docs 同步、可进入 Full 与最终审查 |

当前不使用额外 worker 或独立 reviewer，也未获得并行实施授权。若用户明确批准具体并行范围，计划必须先定义相互排斥的 owner/文件范围、共享合同、汇合与停止条件；若用户明确要求独立审查，或实现中出现公共合同、安全/数据边界、Harness 变化等高风险信号，则更新执行模式并定义独立 review packet。Primary owner 始终负责 finding 处理、集成和最终交接。

## 13. 执行审查

本计划的测试、验证与审查分别承担不同责任：

- 测试证明具体行为或不变量；
- Harness 证明配置的机械门禁与安装包一致性；
- 审查判断结果是否符合用户目标、计划、架构、风险和授权边界。

审查门如下：

| Gate | 当前计划时点 | 审查内容 | 通过条件 |
| --- | --- | --- | --- |
| R0 Plan readiness | Block 01 退出、Block 02 开始前 | 目标文档、计划内核、58 Tasks、依赖、风险、授权、并行 Human Gate、验证和恢复是否一致 | ABC01–ABC07 与 Block 01 退出条件闭环；并行保持未授权/关闭 |
| R1 Block entry | 每个 Block 开始前 | 前置证据、工作树漂移、owner、受保护修改、接口、测试入口及并行授权状态 | 进入条件仍成立，无 material 未决问题；未经新批准仍串行 |
| R2 Slice review | 每个 Task 勾选前 | Task 验收、diff、错误路径、测试、文档、范围和 secret/数据边界 | finding 已解决或正确路由，不夹带无关改动 |
| R3 Block exit | 每个 Block 标记 Completed 前 | 全部 Tasks、直接证据、接口一致性、恢复点和下游交接 | 本块退出条件全部成立 |
| R4 Integration review | I1–I4 | 组合对象图、共享状态、配置、数据、错误、文档和测试 | 上游合同组合后仍唯一且无兼容双路径 |
| R5 Final delivery | Block 08 Full 后 | 原始目标、计划偏差、完整 diff、架构/UX/兼容性/安全、证据、打包和发布状态 | finding 解决、路由或明确记录为残余风险 |

每次 R2–R5 至少从以下七个视角审查适用部分：

1. 用户结果与全局 AC；
2. 计划遵从性及偏差依据；
3. owner、依赖方向、公共面和共享状态；
4. 数据、兼容性、错误语义、安全和 UX；
5. 测试是否保护结果/合同/失败，而非偶然实现；
6. 配置、文档、打包、依赖、凭据和任务范围；
7. 实际验证、未覆盖面、残余风险和 Git/发布状态。

finding 处理：

- `blocking`：停止推进，违反 requirement/ADR、数据/安全/授权或适用门禁；
- `material`：回到调查、设计或拥有该问题的 Block，更新计划后再继续；
- `ordinary`：在当前切片修复并重跑直接证据；
- `accepted residual risk`：只能用于未授权真实验证或外部状态等无法在当前范围消除的风险，必须写入最终交接。

审查证据记录在对应 Block 的“完成证据”；不单独制造重复进度台账。Block 08 的 R5 结果必须汇总所有未关闭 finding、计划偏差和 release state。

## 14. 进度规则

- Task 只有源码/文档、直接测试和自身验收同时闭环后才勾选；
- Block 只有全部 Task、退出条件和完成证据闭环后才标为 Completed；
- 根 README 只汇总 Block 状态，不复制块内 Task 计数；
- 目标事实变化时先更新本 README 的事实、风险和依赖，再调整块文件；
- 计划状态不能替代 `git status`、当前源码、测试或 Harness 结果。

## 15. 恢复与续作

- 失败信号：合同与实现冲突、生产对象图出现双路径、旧架构符号残留、直接测试或 Full 任一步失败；
- 恢复点：每个块“完成证据”记录的最后通过切片；不保留产品兼容开关作为回退；
- 恢复方法：只修正当前块触及的文件，在已有用户改动上继续，不使用破坏性 Git 回退；
- 跨会话继续顺序：先读本 README 当前状态，再读 In progress 块的完成证据/未勾选 Task，然后核对 `git status` 和最近测试；
- 若实现证据推翻设计，回到 Block 01 更新权威合同和计划，不在下游堆例外。

## 16. 计划变更记录

| 日期 | 触发 | 变化 | 合同影响 |
| --- | --- | --- | --- |
| 2026-08-26 | 用户批准无状态 Agents 与 Rules/Agent 二选一设计 | 建立首版 Change Plan | 待由 Block 01 收敛 Accepted ADR |
| 2026-08-26 | 用户停止使用 `.omo` 并要求一个计划一个目录、每块独立文件 | 计划迁入 `docs/plans/` 并拆成 README + 8 blocks；增加事实/假设、影响、风险、证据、恢复与交接组件 | 不改变产品设计，只改变计划治理 |
| 2026-08-26 | 用户要求明确计划执行方式和执行审查 | 增加串行 Task 执行循环、I1–I4 集成点和 R0–R5 审查门；计划规范同步更新 | 不改变功能合同；提高执行与验收治理完整性 |
| 2026-08-26 | R0 执行顺序预审发现 Session 删除早于 Analysis 迁移 | ABC15 改为冻结旧调用边界，ABC21 在 Analysis 迁移切片中清除 Analysis 依赖 | 不保留最终兼容层；避免 Block 02 形成不可运行工作树 |
| 2026-08-26 | 用户规定并行执行必须取得人类同意 | 将计划级并行设为默认关闭的 Human Gate；当前计划保持单一 Primary owner 串行执行 | 不改变功能合同；未经具体批准不得启用并行实施 |
| 2026-08-26 | R0 Plan readiness 通过 | Block 01 完成；Accepted ADR、requirements、design、technical、非目标、58 Tasks、串行授权门和验证策略形成一致合同，进入 Block 02 | 固定无状态 Runtime、统一 Browser 页面合同和 Rules/Agent 作业级互斥选择 |
| 2026-08-26 | Block 02 R1 发现 Browser 与 Configuration probe 也直接依赖旧 Session | ABC15 登记 Analysis/Browser/probe 三类既有调用方；ABC21/ABC35/ABC47 分别迁移，ABC51 最终物理删除旧文件和导出 | 不改变最终无兼容层目标；修正原计划在下游调用方迁移前删除共享文件的顺序错误 |
| 2026-08-26 | Block 02 R2/R3 通过 | 无状态 Call/Result/Runtime/Provider Port、纯本地 role readiness 和单次限制由 80 个直接测试、116 个迁移窗口回归及 Ruff/Pyright 证明；进入 Block 03 | 新 `agents.api` 已稳定；旧 Session 仅保留为 ABC21/35/47/51 登记的迁移窗口，不是最终兼容面 |
| 2026-08-26 | Blocks 03–06 串行退出审查通过 | Analysis 两阶段、统一 Browser Observation/动作、两个 controller、Configuration/Bootstrap/status/test 生产对象图依序迁移完成 | I1–I3 闭环；未启用并行或 worker-assisted 模式 |
| 2026-08-26 | Block 07 I4 审查发现 Block 05 的 material omissions | 返回 Block 05 删除旧 Browser 状态机、Challenge group circuit、`BrowserBudget`、整篇 deadline、累计 Browser 作业限制与 `max_actions`，补直接测试后再进入删除收口 | 不改变合同；纠正初次绿色测试未覆盖真实架构残留的问题 |
| 2026-08-26 | Block 07 R3/I4 通过 | 旧源码/fixture/导出/配置分支清零，current docs 与生产对象图同步；198 项组合回归、133 项邻接回归、Ruff/Pyright/diff/精确搜索通过 | 形成 Block 08 delivery candidate；实际 wheel 与 Full 仍待最终验证 |
| 2026-08-26 | Block 08 R5 通过 | 337 项分模块测试、29 项 installed acceptance、Quick、2123 项 Full、fresh-wheel 21+4 项旅程及语义/安全/diff 审查闭环；验证阶段 3 个 ordinary finding 已修复并重新运行 Full | AC-1–AC-8 全部成立；计划完成并进入历史归档，不改变未授权真实测试或 Git/发布边界 |

## 17. 最终交接

### 完成范围

- 建立唯一 Provider-neutral、无状态、一次调用的 Agents Runtime，并让 Analysis 与 Browser 分别拥有自己的业务 controller；
- Analysis 元数据/正文两阶段和 ReferenceLookup 全部迁移到单次 Runtime；
- Browser 建立统一 revision/surface/screenshot/element/receipt/capture 合同和六种封闭动作；
- 作业开始前冻结 `rules` 或 `agent` controller，二者不互相 fallback；Challenge 使用相同 Observation/loop；
- 删除旧 `AgentSession`/request/session 文件、Browser 状态机、专属 Challenge 生命周期和累计作业预算，不保留兼容双路径；
- 同步 Accepted ADR、design/technical、配置与 CLI status/test、Bootstrap、日志、示例、指南、Provider notes 和 wheel 内容。

非目标保持未实施：登录、机构选择、MFA、文本输入、任意 URL/JavaScript、外部 challenge solver、长期 Agent memory/Planner、数据库或资产迁移、真实服务探测和发布操作。

### 验证结果

- 分模块直接测试：337 tests，全部通过；
- 完整 installed acceptance：29 tests，全部通过，1 个真实 Cloak runtime 用例 skip；
- Quick：Ruff lint、Ruff format check、compileall 全部通过；
- Full：Pyright 0 errors/0 warnings，2123 tests 全部通过（4 个需要显式 `SCIRETRIEVER_TEST_CLOAK_HOME` 的真实 runtime 边界 skip），wheel build/content 通过；
- fresh-wheel：同一离线预构建 wheel 的综合旅程 21 tests、定向生产对象图 4 tests，全部通过；wheel SHA-256 为 `d98e024c382e56e9baf388d6259b8703671989ecba451fc44cd78640ba8fdcfd`；
- Block 08 的 requirements/ADR/源码/测试/current docs、旧符号、安全和最终 diff 审查无未处置 finding。

### 公开与兼容性影响

- CLI 命令层级不变；`config status` 现在区分 Agent service、Analysis/Browser role、选定 controller 与 readiness，`config test browser-agent` 提供独立的合成 role probe；
- 普通配置新增带默认值的 `[access].browser_controller = "rules" | "agent"`；旧 `[agents.analysis].deadline_seconds`、`[agents.browser].turns`、`[agents.browser].deadline_seconds` 被删除并拒绝，不提供旧架构兼容解析；
- 内部 Python API 是有意破坏性切换：`AgentSession`、`open_session`、`AgentRequest` 等被无状态 `AgentCall`/`AgentRuntime.execute` 取代，Browser controller/action/state 合同同步替换；
- 数据库 schema、Catalog 事实、凭据 schema、资产布局、导入导出格式均无变化；`pyproject.toml` 和 `uv.lock` 未变化，没有新增或升级依赖。

### 残余风险与外部状态

- 未读取真实 credentials、Cookie、个人 config 或 Profile；未连接真实 LLM、Publisher、机构 IP 或 MinerU；
- 未启动显式 opt-in 的真实 Cloak runtime，因此真实 Publisher 页面、closed Shadow DOM/canvas、实际 challenge 和真实模型 tool decision 仍需另行授权后做现场验证；
- 这些是外部集成证据缺口，不是已知离线流程或合同失败，不能据此声称真实下载成功率已经验收。

### 工作树与发布状态

- 最终任务 diff 已检查凭据、Token/Cookie/Profile 内容、真实 PDF/数据库/日志、个人配置、构建产物、缓存、旧兼容层和任务无关文件，未发现进入变更集的违规内容；
- `pyproject.toml`/`uv.lock` 无变化，忽略的 `build/`/`dist/` 仅为本地 Harness 产物；
- 工作树仍未提交；没有执行 commit、amend、rebase、push、PR、release 或其它 Git/发布写操作。
