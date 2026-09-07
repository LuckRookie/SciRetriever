# Block 1：合同与失效时序刻画

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed（2026-09-04） |
| Task 范围 | BCH01–BCH05 |
| 前置块 | 无；R0 计划审查通过后开始 |
| 下游块 | Block 2 两阶段 Capture 交接 |
| 恢复点 | ADR/中性接口方向冻结，characterization tests 在旧实现上稳定失败 |

## 块结果

形成一个不依赖真实 Publisher 的最小复现，准确覆盖“PDF 早于首次 Observation”和“当前操作没有
Challenge resource”的时序；随后把两阶段 capture admission 的 owner、状态、错误和安全不变量写入
ADR 0017 与中性接口测试。Block 完成前不修改生产捕获算法。

## 进入条件

- 用户明确批准开始实施本计划；
- 已阅读根计划、ADR 0017、Acquisition/Network technical 和目标实现当前 diff；
- 工作树现有改动已列为受保护输入；
- 不需要真实 Profile、凭据、Publisher 或用户 Catalog。

## 责任与改动面

- Owner：Primary Agent；
- 主要文件：`docs/architecture/decisions/0017-shared-agents-and-controlled-browser-agent.md`、
  `src/sciretriever/network/browser.py` 的公共中性类型位置、`tests/test_network_browser.py`、
  `tests/test_acquisition_browser.py`、`tests/test_network_cloakbrowser_challenge_local.py`；
- 生产者：Network request/response/download correlation；
- 消费者：Acquisition Publisher capture policy、Browser controller settle、Cohort failure selection；
- 受保护：现有 action/settle、destination/DNS/host guard、PDF validation、cleanup 与用户未提交改动。

## 需要保持的行为

- 错误 DOI、supplement、excluded locator、规则外 origin 和 correlation miss 不读取正文；
- `CANDIDATE` 不是成功；超时、取消和 cleanup 后不交付字节；
- Rules/Agent 互斥、六种动作、32-call safety fuse 和 persistent Profile 边界不变；
- 真实 URL/query、Cookie、截图与正文不进入 fixture 名称、断言或日志。

## Tasks

- [x] **BCH01 — 固化早到 PDF characterization。** 使用真实 `_RuleCapturePolicy` 等价对象图构造
  顶层 301 → 200 PDF response + native download 在 controller 首次 observe 前到达，并同时记录
  capture、模型调用、body read 与 cleanup。
  - 验收：归档真实证据已经记录旧实现因冻结布尔值丢失 capture；回归测试在新实现中稳定交付一次。
- [x] **BCH02 — 固化 persistent-clearance characterization。** 在同一 Browser identity 等价 fixture 中
  先完成 Challenge，再以新的 article operation 直接进入 PDF；第二次 operation 的 Challenge resource
  计数为 0，但 request lineage、article identity 和目标规则均有效。
  - 验收：准确复现“同一轮没有 Challenge resource 不能等同于未授权”。
- [x] **BCH03 — 建立安全反例矩阵。** 同一时序分别替换为错误 DOI、错误文章 path、supplement、
  未允许 origin、无 live request correlation、非 PDF media type。
  - 验收：所有反例在 body read 计数为 0 时被拒绝，不能只断言最终无 capture。
- [x] **BCH04 — 冻结中性合同。** 确定 `BrowserCaptureEvidence`、`BrowserCaptureDecision` 与 article-local
  intent 的字段和 owner；明确 ACCEPT/DEFER/REJECT、更新通知、timeout、取消和 cleanup 语义。
  - 验收：合同不含 DOI 业务解释、Publisher 名称、vendor object、完整 URL/query 或持久状态；
    Network 只产生证据，Acquisition 只作文章判定。
- [x] **BCH05 — 修订 ADR 与技术目标。** 在 ADR 0017 中用 amendment 替换“单次 bool guard 即最终决定”
  的不足，记录为何不用固定等待、同源全放行或 ACS 特判。
  - 验收：Accepted 合同与 Block 2/3 的实现方向一致；若需要新 ADR 而非 amendment，先暂停请用户决定。

## 执行方式与集成点

顺序为 BCH01 → BCH02/BCH03 → BCH04 → BCH05。先让 characterization 命中真实时序，再由正反样本
决定合同；不得先写理想接口后调整 fixture 配合。唯一交接产物是冻结的 evidence/decision 合同和失败
测试，不把临时 fake API 交给 Block 2。

## 审查门

- R1：确认旧实现失败原因就是 capture handoff，而非测试绕过 destination/correlation；
- R2：每个反例检查 body-read 计数、candidate state 和 cleanup，不只检查返回类型；
- R3：ADR、类型草图和 characterization 对 ACCEPT/DEFER/REJECT 使用同一术语；
- blocking：任何方案以 origin/media type 代替文章身份，或需要记录完整 locator。

## 接口、数据与依赖影响

- 接口：本块只冻结未来内部合同，不落地双路径实现；
- 数据：无 Catalog、资产或配置变化；
- 依赖：无新依赖或锁文件变化；
- 文档：仅 ADR amendment 与本计划证据。

## 验证与证据

首选命令按实际新增测试名收窄执行：

```bash
uv run --frozen python -m unittest tests.test_network_browser.<early_capture_test>
uv run --frozen python -m unittest tests.test_acquisition_browser.<policy_counterexample_test>
uv run --frozen python -m unittest tests.test_network_cloakbrowser_challenge_local.<reused_clearance_test>
```

记录旧实现的预期失败摘要、body-read/capture/download cleanup 计数和 ADR review 结果；不保存真实网页
日志或截图。本块不要求 Quick/Full，因为算法尚未实施，但修改的测试/文档必须通过 Ruff/语法与链接检查。

## 退出条件

- BCH01–BCH05 全部完成；
- 归档旧缺陷证据与正向回归对应，全部安全反例保持通过；
- 中性合同 owner、状态和 lifecycle 无开放歧义；
- ADR 方向获准，Block 2 不需要自行发明第二套语义。

## 完成证据

- `test_exact_article_pdf_redirect_is_captured_before_first_agent_call` 覆盖首次 Agent 调用前的
  301 → opaque PDF response/native download；结果为一个 capture、模型调用 0、正文读取 1 次、
  download 删除 1 次。
- `test_real_cloudflare_shaped_unified_control` 使用已安装 runtime、临时 Profile 和本地 HTTPS 服务通过：
  第一项 operation 实际加载并清除 Challenge，第二项 operation 在同一 persistent context 中以
  0 项 Challenge resource 从精确 DOI-PDF 起点重定向并取得 PDF。
- `test_exact_start_redirect_rejects_unsafe_resources_before_body_read` 覆盖错误 DOI、supplement 与非 PDF；
  response/download 正文读取均为 0，download 各删除 1 次。
- ADR 0017 已 amendment 为唯一三态 `BrowserCapturePolicy`；中性 evidence 不含 Publisher/DOI 解释、
  query、vendor object 或持久状态。R3 未发现术语或 owner 分歧。
- 没有在受保护脏工作树上另建 baseline checkout；旧行为依据本计划引用的真实调试归档，当前回归
  结果由本块测试和后续 Block 2/3 组合验证证明。

## 失败与恢复

- 若无法离线复现，回到归档 6.6/6.7 对照事件顺序，不重复真实请求；
- 若精确 locator 形状是必要未知项，只增加脱敏分类 reason，不记录完整值；
- 若设计需要放宽 Network transport guard 或持久化 Candidate，停止并返回根计划开放问题；
- 恢复从首个未完成 BCH Task 继续，保留已经证明的反例。

## 下游交接

Block 2 只能依赖：已接受的 ADR amendment、最终中性类型/Protocol、两种早到时序测试、全部安全反例
以及明确的 body-read/cleanup 不变量。Block 2 不得改变 Publisher 业务规则或 Cohort 主失败。
