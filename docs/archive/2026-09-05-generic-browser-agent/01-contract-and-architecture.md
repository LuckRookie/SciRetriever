# Block 01：通用合同与架构切线

## 块身份

| 字段 | 值 |
|---|---|
| 状态 | `Completed`（2026-09-06） |
| Owner | `/root` |
| 前置块 | 无；调查事实和用户方向已确认 |
| 下游块 | Block 02 Generic Browser runtime、Block 03 Agent controller |
| 恢复点 | 新 ADR 与对象/所有权表通过 R3 后 |

## 块结果

形成一份可以直接指导源码重构的稳定合同：Agent 负责页面策略，Network 负责稳定观察/动作/capture，Acquisition 负责文章目标和 PDF 正确性。Publisher-specific click rule 不再拥有 Agent 准入或动作控制权。requirements、ADR、design 和 technical 文档对这一改变使用同一术语和对象图。

## 进入条件

- 已阅读并核对当前 ADR 0015/0016/0017/0019、requirements、design、technical 文档和当前工作树。
- 用户已明确允许删除旧内部接口和配置兼容层。
- 不把当前实现的规则依赖误写成已接受目标设计。

## 责任与改动面

- 文档 owner：`docs/architecture/requirements.md`、`docs/architecture/decisions/`、`docs/architecture/design.md`、`docs/architecture/technical/{agents,acquisition,network,configuration}.md`。
- 合同 owner：`src/sciretriever/model/` 中的中性类型（实施阶段才修改）。
- 受保护：既有用户对其它模块、日志、配置 UX 和测试的未提交修改；Literature/Asset/provenance 的已接受语义。

## 需要保持的行为

- Public → authorized API → Browser 的风险顺序不变，Browser 不变成无条件 Browser-first。
- Network 的 URL/DNS/redirect/host admission、固定 CloakBrowser identity、限速、取消、清理和资源上限仍有效。
- PDF 字节检查、文章身份、主 PDF/supplement 区分、candidate dedupe、不可变发布和 provenance 不下放给模型。
- Agents 继续是 provider-neutral、无状态、一次调用的窄腰；不引入高层持久 Agent workflow。

## Tasks

- [x] **CGA01 — 画出新的责任与对象图。** 明确 `ArticleGoal → BrowserObservation → BrowserAction → BrowserStepResult → DownloadCandidate → PDF validation` 的生产者、消费者、所有权和错误边界。
  - 依赖：无。
  - 验收：图中没有 Publisher rule 作为 Agent 必经节点，没有第二套 Browser 状态机，Network/Acquisition/Agents 的业务枚举不互相泄漏。

- [x] **CGA02 — 定义跨层中性合同。** 固化 `ArticleGoal`、`BrowserObservation`、六种 `BrowserAction`、`BrowserStepResult`、`DownloadCandidate`、`StrategyHint` 和 `CorrectnessCapability` 的字段、状态、脱敏规则与生命周期。
  - 依赖：CGA01。
  - 验收：每个字段有 owner、序列化边界和失败语义；明确 candidate 不是成功资产，`Ready` 是唯一可继续结果。

- [x] **CGA03 — 拆分 Publisher profile 能力。** 将访问身份、origin/risk/session policy、文章身份和 capture 正确性与可选 strategy hint 分开；删除“缺 rule 即不能进入 Agent”的合同。
  - 依赖：CGA01、CGA02。
  - 验收：授权 API profile 所需字段仍有 owner；静态 hint 不能声明任意脚本/selector；无 profile rule 的安全 canonical landing 可被 generic path 接纳。

- [x] **CGA04 — 修订架构真相源。** 新建或修订 ADR（建议下一个编号为 `0022-generic-browser-agent-executor.md`），并同步 requirements、design、agents/acquisition/network/configuration technical 文档，标明 supersedes/amends 关系。
  - 依赖：CGA02、CGA03。
  - 验收：旧 ADR 中与新方向冲突的规则控制、unknown-site fallback、controller 选择等表述被明确修订；文档没有把未实施能力写成当前行为。

- [x] **CGA05 — 固化破坏性迁移清单。** 列出待删除的 `RuleBrowserController`、Publisher step rule catalog、`browser_controller` 配置、旧测试 fixture 和旧公开导出；列出必须保留的 capture/identity/policy 代码。
  - 依赖：CGA03、CGA04。
  - 验收：清单能逐项指向源码/测试/文档；没有“先保留一段时间”的兼容层、自动迁移器或 fallback。

## 执行方式与集成点

先写合同和文档，再在同一 Block 内做必要的中性 Model 草图；不提前修改 runtime。CGA04 是本 Block 与 Block 02/03 的集成点，后续实现只能消费已经冻结的名称和状态。

## 审查门

- R1：确认用户的破坏性授权只用于仓库源码/文档，不涉及用户资产。
- R2：逐项审查对象所有权、状态正交性、Publisher hint 与 correctness 分离。
- R3：确认四类架构文档、ADR 索引和迁移清单一致；不通过则不得开始代码重构。

## 接口 / 数据 / 依赖影响

- 接口：新增 generic Browser contract，删除 rule/controller 选择接口；不提供旧别名。
- 数据：不迁移已保存 Literature/Asset；candidate 仍为 operation-local。
- 依赖：本 Block 不新增 Python 依赖。
- 文档：本 Block 必须同步长期真相源，计划不替代它们。

## 验证与证据

- Markdown 链接、术语、ADR supersedes/amends 和对象图人工检查。
- `git diff --check` 检查文档格式。
- 用 `rg` 检查旧规则/新合同引用是否有明确归属；不要把当前源码引用误判为迁移完成。
- 证据写入本文件“完成证据”小节，并链接具体 ADR/文档章节。

## 退出条件

- CGA01–CGA05 全部完成；
- 新合同经 R3 审查通过；
- Block 02、03 可以只依据文档构造接口，不需要猜测旧 rule 行为；
- 旧配置和接口删除范围已获用户授权且没有包含用户文件。

## 完成证据

- 新增并接受 [ADR 0023](../../architecture/decisions/0023-generic-browser-agent-executor.md)，并同步
  requirements、principles、design、technical 总览及 Agents、Acquisition、Network、Configuration
  技术文档。
- 对象图确定为 `BrowserArticleGoal → BrowserObservation → BrowserAction → BrowserStep → PDF
  identity validation`。operation-local candidate 由 Network 的 capture/step 合同表达，未另建可持久化
  `DownloadCandidate` 或 Publisher strategy-hint 模型。
- `PublisherAccessProfile` 的 Browser 字段收敛为 `browser_probe_enabled`；它只控制首页可达性探测，
  不再控制页面动作或 generic Browser 准入。
- 破坏性删除范围已落实：旧 rule controller/catalog、Publisher selector 模块、controller 配置分支和旧公开
  导出均不再属于生产对象图；文章身份、PDF 字节、capture lineage、Network admission 与资源边界保留。
- R3 审查未发现第二套页面状态机或兼容 fallback。最终 `git diff --check` 在 Block 05 再次通过。

## 失败与恢复

若发现新合同仍依赖 Publisher selector、无法表达 candidate lineage，或与已接受数据边界冲突，停止在本 Block，回到 CGA01/CGA02；不要在 Block 02 用临时字段补洞。若 ADR 需要改变 Public/API/Browser 顺序，必须回到用户决策门。

## 下游交接

交给 Block 02：稳定 Observation/action/readiness/capture 合同和 generic admission 前提。交给 Block 03：单次 Browser decision 的输入、输出、终态和“每个 Ready 一次调用”规则。交给 Block 04：ArticleGoal、CorrectnessCapability 和旧 rule 删除清单。
