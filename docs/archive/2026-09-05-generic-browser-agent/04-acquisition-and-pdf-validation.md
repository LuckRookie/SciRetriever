# Block 04：Acquisition 文章目标与 PDF 验收

## 块身份

| 字段 | 值 |
|---|---|
| 状态 | `Completed`（2026-09-06） |
| Owner | `/root` |
| 前置块 | Block 02 R3、Block 03 R3 |
| 下游块 | Block 05 验证与交接 |
| 恢复点 | 单文章 generic acquisition fixture 从目标到终态通过后 |

## 块结果

Acquisition 把文献事实转换为 `ArticleGoal`，在已有 Public/API 路线不适用或失败后按既有准入进入 generic Browser；它只消费 Agent/Network 的稳定终态和 capture evidence，最终使用统一 PDF/文章身份 validator 决定是否发布主资产。旧 Publisher rule/controller 及 `rules|agent` 配置被直接删除，无兼容路径。

## 进入条件

- Generic Browser 和 Agent controller 已能在 fake/replay 中交接。
- 已明确 Publisher profile 中必须保留的 access/risk/capture/identity 能力与要删除的策略字段。
- Public → API → Browser 顺序、Browser enablement 和 Browser Model 配置的新合同已由 Block 01 文档确认。

## 责任与改动面

- Owner：`src/sciretriever/acquisition/`（`sources/browser.py`、`browser_control.py`、`browser_admission.py`、`profile_catalog.py`、`profile_verification.py`、`registry.py`、`access_profiles.py`）、`bootstrap/browser.py`、`model/configuration.py` 和对应 fixture。
- 受保护：其它 acquisition source、API credentials、公共 route、Storage 不可变发布、用户工作树中的非本计划修改。

## 需要保持的行为

- 已有有效 PDF/元数据事实不会因 Browser Agent 失败被回滚；后续 Parsing/Analysis 失败不撤销 Acquisition 已确认事实。
- 文章身份判定仍是程序责任；模型只能建议动作，不能宣布 PDF 成功。
- Supplement、appendix、错误 DOI、viewer HTML、空字节、partial response、非 PDF 和未关联下载不能成为主 PDF。
- Browser permit、host admission、publisher lane 串行和 cleanup 由 Network/Broker 继续拥有。

## Tasks

- [x] **ACQ01 — 形成 ArticleGoal。** 从当前 Literature/MetaLiterature、DOI、标题、作者、canonical landing 和 AssetHint 生成 article-local 目标，去掉 query/secret/vendor 类型。
  - 依赖：CGA02、GBR02。
  - 验收：相同文章的不同来源 hint 能收敛到一个目标；缺少强身份时保留 unresolved，不让 Agent 猜数据库事实。

- [x] **ACQ02 — 让 generic Browser 成为唯一 Browser 策略入口。** 删除 `RuleBrowserController`、`_PublisherStepPolicy` 作为点击策略的职责和 `browser_controller=rules|agent` 分支；Browser 入口只构造 generic Agent controller（Browser 未启用则不进入）。
  - 依赖：GBR06、AGC03。
  - 验收：无 Publisher rule 的安全 landing 能进入 Agent；Agent 失败不回退规则；源码中没有第二套规则点击 loop。

- [x] **ACQ03 — 拆除/清理旧 Publisher rule catalog。** 删除供应商 selector、capture prefix 之外的规则动作合同、旧 catalog verification 集合、无用 fixture 和旧导出；把仍有价值的 locator/身份/supplement 字段迁入 correctness capability 或 generic hint。
  - 依赖：CGA05、ACQ02。
  - 验收：授权 API profile、risk/session policy 和文章身份验证仍可组装；不存在“rule 文件存在即生产准入”或“缺 rule 即跳过 Agent”。

- [x] **ACQ04 — 接收 candidate feedback 并驱动当前 policy。** 对 `candidate_pending`、`accepted`、`rejected(reason)` 建立 operation-local 处理；landing/下载证据更新时重新调用当前 correctness policy，不复用旧布尔值。
  - 依赖：GBR04、AGC05。
  - 验收：candidate timeout、wrong article、supplement、not entitled、not found、Stop、cancel 和 runtime failure 在报告中可区分；不把早期 403 覆盖为成功。

- [x] **ACQ05 — 统一 PDF 字节和文章身份验收。** 将 native download、response、viewer 导出和 direct locator 统一送入既有 PDF reader/page tree/hash/identity 验证，再执行 candidate dedupe 和 create-if-absent 发布；没有 Publisher correctness capability 时使用 ArticleGoal 的 DOI/标题/作者通用匹配。
  - 依赖：ACQ04、既有 PDF validator/storage 合同。
  - 验收：捕获 PDF 但身份不匹配时明确 reject；身份证据不足时 defer/reject 而不是由模型宣布成功；通过后保留来源、输入 hash、provenance/lineage；发布失败不删除之前的有效事实。

- [x] **ACQ06 — 重构配置与 Bootstrap 对象图。** 删除旧 controller 字段和 rules readiness；把 Browser 总开关、Browser Model、固定 identity/profile、通用 policy overrides 统一放入一级 `[browser]`，让 `[download]` 只保留 PDF route/source 业务项，并更新 TUI/status/test 文档。
  - 依赖：ACQ02、ACQ03、CGA04。
  - 验收：当前 schema 只接受一级 `[browser]` generic Browser 配置；旧 `[download]` Browser 字段、旧 controller/key 和旧 section 直接失败、不迁移、不写文件；Bootstrap 只在一个位置装配 generic Browser controller。

- [x] **ACQ07 — 单文章端到端离线闭环。** 用 fixture 模拟 normal landing、challenge、viewer/popup、延迟 download、错误文章、supplement、not entitled 和 no PDF，验证 Acquisition route outcome。
  - 依赖：ACQ01–ACQ06。
  - 验收：每个 fixture 都有目标、动作、capture evidence、validator 结果和最终 route/report 语义；重复执行不制造重复资产。

## 执行方式与集成点

ACQ01 先完成目标模型和 identity 语义，再 ACQ02/03 删除旧控制路径；ACQ04/05 形成 capture→validation 闭环；ACQ06 更新配置/Bootstrap；ACQ07 汇合全部依赖。删除操作只针对仓库文件清单，不触碰用户目录或真实 catalog。

## 审查门

- R1：逐项确认待删文件/字段不再是其它模块的合法 owner，保留的 API profile 字段有消费者。
- R2：重点审查“捕获到 PDF ≠ 成功”、candidate 清理、文章身份、supplement 和后续阶段不回滚。
- R3：单文章 fixture、配置严格失败、Bootstrap 对象图和旧引用扫描全部通过。

## 接口 / 数据 / 依赖影响

- 接口：Acquisition Browser source/controller、profile rule API 和 `[download]` 配置会破坏性重构。
- 数据：Literature/Asset/provenance schema 语义保持；candidate/Agent history 不持久化。
- 依赖：不新增 Browser 供应商 SDK；复用 Block 03 已验证的 Runtime adapter。
- 配置：只保留 generic Browser 需要的 enablement/model/profile/policy；旧 controller/rule 字段无迁移。

## 验证与证据

- `tests/test_acquisition_browser.py`、`test_acquisition_matrix.py`、`test_browser_admission.py`、`test_browser_agent_integration.py` 和新增 fixture/replay。
- 配置模型、status、Bootstrap readiness 和 wheel 内容检查。
- 断言文章级 accept/reject、主 PDF/supplement、candidate lineage、create-if-absent 和失败不回滚。
- 证据只保存结果摘要和 hash，不保存真实 PDF/URL/token。

## 退出条件

- Generic Browser 是唯一策略入口且无 rule fallback；
- 旧 rule/controller/config 引用已按清单删除；
- 单文章离线闭环可解释每个失败阶段；
- PDF validator 和 Storage 仍是最终成功门；
- Block 04 R3 通过。

## 完成证据

- 生产只注册 `browser:generic` / `browser-generic`，唯一页面策略控制器为
  `AgentBrowserController`；未知 Publisher 只要具有合法文章起点并通过 Network admission，也能进入
  generic Browser。
- 已删除 `RuleBrowserController`、`BrowserSiteRule`、`BrowserRuleCatalog`、整个
  `acquisition/sources/browser_rules/` 以及 Rules/Agent 双路径；不保留旧 API/config 兼容层。
- 新增统一 PDF 归属验证：优先 DOI，其次标题/作者证据，并允许受控 direct-file 起点；supplement、冲突
  DOI、错文和证据不足均拒绝。捕获候选不会直接发布主资产。
- 配置收敛为一级 `[browser]`；`[download]` 只管理 Acquisition Source。旧 `browser_controller` 等字段
  由边界测试明确拒绝；Bootstrap 只有一个 generic Browser 装配点。
- 单文章离线用例覆盖正常 capture、错误文章、supplement、证据不足、页面终态、candidate timeout、取消和
  cleanup。相关 307 项直接回归、Quick 与 Full 均通过。
- 未修改数据库 schema；未接触用户配置、catalog 或真实文献资产。真实 Publisher 成功率仍需单独授权验证。

## 失败与恢复

若删除 rule 后仍依赖其 capture/identity 字段，暂停删除并把字段迁入 correctness capability；不得恢复整个 rule controller。若 PDF 验收误拒真实有效文件，回到 ACQ05 的字节/身份分层；若 candidate 晚到污染下一篇，回到 GBR04/BrowserSession cleanup。

## 下游交接

Block 05 获得完整离线批处理入口、article-level 结果模型、失败原因分类、旧代码删除范围和配置严格失败证据。
