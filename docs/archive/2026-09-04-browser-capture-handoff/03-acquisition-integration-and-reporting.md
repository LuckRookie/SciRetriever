# Block 3：Acquisition 集成与结果选择

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed（2026-09-04） |
| Task 范围 | BCH12–BCH17 |
| 前置块 | Block 2 Completed |
| 下游块 | Block 4 验证、文档与真实交接 |
| 恢复点 | Publisher capture policy 与生产 Browser 对象图接入，Full 尚未运行 |

## 块结果

Acquisition 在首次导航前提供当前文章的 capture intent，并用 Publisher rule 对 Network evidence 作
ACCEPT/DEFER/REJECT 决定。fresh Challenge 与 persistent clearance 都不依赖偶然页面时序；Agent 在
Candidate 收敛前不接收空白页。最终 Report 选择实际最深、最具体的 Browser/capture 失败。

## 进入条件

- Block 2 的唯一中性 Protocol、Candidate 和 cleanup 已通过 Network 测试；
- ADR 0017、Acquisition/Network technical 的目标语义一致；
- 所有 wrong-article/supplement/unknown-origin 反例仍在 body read 前拒绝；
- 工作树重查无与目标文件冲突的用户新改动。

## 责任与改动面

- Owner：Primary Agent；
- 主要文件：`src/sciretriever/acquisition/sources/browser.py`、Browser rule model/providers、
  `acquisition/cohort.py`，必要的 Bootstrap 组装和 Acquisition/Entry 测试；
- Acquisition 拥有：article identifiers、landing/start intent、Publisher capture classification、
  page markers、route terminal 和主失败；
- 消费者：Network capture Protocol、PDF validation/publication、Entry completion report；
- 受保护：candidate key、TemporaryPdf、NoPrimaryPdf/exhaustion、Catalog 事务和已有 Provider rules。

## 需要保持的行为

- capture prefix、article identity、supplement/excluded 判定继续由版本化 rule 负责；
- action.landing 与 DOI identifiers 只在 operation 内使用，不记录完整 URL/query；
- capture 仍需二次 Provider rule 检查与现有 PDF 字节验收才能发布；
- normal miss、权限失败、系统失败和取消不能互相伪装；
- Agent prompt/tool schema、动作和 semantic cycle 不因本块变化。

## Tasks

- [x] **BCH12 — 构造导航前 article capture intent。** `_BrowserAction` 在进入 `BrowserClient.run()` 前
  形成 rule revision、identifiers、已知 landing、exact start 和允许 capture 形状的不可序列化 intent。
  - 验收：direct DOI locator、landing hint 与 DOI-resolved origin 三类 action 都有明确证据来源；
    未知/冲突 identity 不产生宽松 intent。
- [x] **BCH13 — 实现 Publisher 三态判定。** rule 对 neutral evidence 返回 ACCEPT/DEFER/REJECT，
  明确 exact reviewed PDF intent、live redirect ancestry、landing-derived identity 和 supplement 规则。
  - 验收：ACS 等价早到 fixture ACCEPT；错误 DOI/文章/supplement/unknown origin REJECT；证据尚不足
    但可由页面绑定补齐时 DEFER。
- [x] **BCH14 — 显式提交 landing/evidence 更新。** Publisher classification 通过唯一 operation-local policy
  更新当前 landing 事实；
  新 landing 或 Challenge-cleared 证据通过唯一 operation-local 更新点唤醒 Network Candidate。
  - 验收：更新前 DEFER、更新后 ACCEPT/REJECT 都能被 settle 观察；跨 article 更新被拒绝。
- [x] **BCH15 — 门控 Agent 与 Rules controller。** 初始/动作后已有 Candidate 时先让 capture lifecycle
  收敛；CAPTURED 立即结束，DEFER 等待，REJECT/cleared 后才把可操作页面交给 controller。
  - 验收：顶层 PDF 下载留下的空白页不会产生模型调用；普通无 Candidate 页面行为不变。
- [x] **BCH16 — 修正 route 与 Cohort 主失败。** 增加或复用准确的 payload-free handoff failure，按
  capture evidence、实际执行深度和现有 deferred/action-required 规则选主失败。
  - 验收：Browser 已观察 PDF 但无法交接时不再最终只显示 public locator `403`；批量其它目标继续。
- [x] **BCH17 — 保持交付二次验收。** Network capture 到 `TemporaryPdf` 时再次执行当前 rule 分类、
  PDF validation、candidate key/dedupe 和 create-if-absent 发布。
  - 验收：不合规 runner、损坏 PDF、重复字节和发布冲突保持原有失败/清理语义。

## 执行方式与集成点

先 intent/policy，再 evidence update，再 controller 门控，最后 terminal/report。每个切片同时修改生产者、
直接消费者和测试，不建立临时 adapter。Block 2 的 Protocol 是唯一集成点；若 Acquisition 需要 vendor
字段，退回 Block 1/2 扩充中性 evidence，而不是导入 Playwright 类型。

## 审查门

- R1：逐 action 来源确认 intent 不扩大当前规则范围；
- R2：每个 ACCEPT 必须能列出文章 identity + request lineage，DEFER 必须有未来收敛证据；
- R3：生产对象图只有一个 capture policy、一个 Candidate lifecycle、一个 terminal resolver；
- blocking：ACS 特判、同源全放行、Agent 直接 capture、Report 从日志反算。

## 接口、数据与依赖影响

- 接口：Acquisition 实现 Block 2 的新 capture policy Protocol；内部一次性切换；
- 数据/schema：无；不持久化 intent/evidence/Candidate/failure history；
- CLI/config：无；
- Provider rule：只有判定合同需要时更新 revision/fingerprint，不为测试随意升级；
- 依赖：无。

## 验证与证据

```bash
uv run --frozen python -m unittest discover -s tests -p 'test_acquisition_browser.py'
uv run --frozen python -m unittest discover -s tests -p 'test_browser_agent_integration.py'
uv run --frozen python -m unittest discover -s tests -p 'test_browser_challenge_lifecycle.py'
uv run --frozen python -m unittest discover -s tests -p 'test_acquisition_cohorts.py'
uv run --frozen python -m unittest discover -s tests -p 'test_entry_completion.py'
uv run --frozen ruff check src/sciretriever/acquisition tests/test_acquisition_browser.py
uv run --frozen pyright src/sciretriever/acquisition
```

测试必须断言模型调用/动作计数、capture decision 序列、body-read、TemporaryPdf、主失败和 cleanup，
不能只断言最终异常类型。

## 退出条件

- BCH12–BCH17 全部完成；
- fresh Challenge、persistent clearance、早到 PDF 和安全反例在生产形状对象图通过；
- Agent 不再看早到下载后的空白页，普通页面循环无回归；
- Report 主失败准确，NoPrimaryPdf/Catalog/schema 不变；
- R3 无 blocking/material finding。

## 完成证据

- `_BrowserAction` 在导航前持有 rule、start、landing 与 identifiers；`_RuleCapturePolicy` 以锁保护当前
  landing，只消费 Network 中性 evidence，二者均不可序列化。
- 精确 DOI-PDF 起点只有在 start 精确匹配、起点正文分类成立、live navigation redirect lineage、
  最终允许 origin/path 且无显式外来 DOI 时才接纳；普通 landing、wrong article、supplement 和非 PDF
  不获得该路径。
- 首导航早到 PDF 回归得到 `BrowserCaptureBatch`，模型调用数为 0；DEFER response/download 在 landing
  绑定后收敛，未收敛 Candidate 不向 Agent 暴露空白 Observation。
- Network 的 `capture-timeout` 映射为 `acquisition-browser-candidate-timeout`，最终失败选择不会被更早
  Public `403` 覆盖；`NoPrimaryPdf`、Catalog、配置与 schema 未改变。
- 包含 `test_acquisition_browser` 的 180 项相关组合全部通过（1 项可选 runtime 当次跳过，后续显式
  runtime 单测通过）；目标 Ruff 与 Pyright 均通过。生产 Registry 与 Configuration probe 已只传入
  新 policy，没有兼容 adapter 或第二套终态解析器。

## 失败与恢复

- 需要新的中性证据时回 Block 1/2，不从 Acquisition 读取 vendor object；
- 某站点需要 selector/固定等待时标成独立 Profile 问题，不污染通用 handoff；
- failure precedence 改变 NoPrimaryPdf 或批量局部成功时停下，回到 Cohort 语义测试；
- 恢复从最后通过的 BCH Task 继续，不重复真实 ACS 请求。

## 下游交接

Block 4 获得：集成后的唯一生产对象图、完整正反测试、准确 Report、未改变的数据/配置边界，以及可供
本地 Cloak 和真实 ACS 验收的固定命令。Block 4 不再修改核心合同，除非验证产生 material finding。
