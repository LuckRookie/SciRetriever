# Block 2：两阶段 Capture 交接

## 块身份

| 字段 | 值 |
| --- | --- |
| 状态 | Completed（2026-09-04） |
| Task 范围 | BCH06–BCH11 |
| 前置块 | Block 1 Completed；ADR 与中性合同已冻结 |
| 下游块 | Block 3 Acquisition 集成与结果选择 |
| 恢复点 | Network 单独完成 evidence/decision/Candidate/cleanup，Acquisition 业务规则尚未接入 |

## 块结果

Network 能把早到 response/download 表达为一个有界、可重新判定、未发布的 Candidate；旧的
最终布尔决定不再作为 pending resource 的永久事实。ACCEPT 后只读取和交付一次，REJECT、
timeout、取消及 cleanup 都确定性丢弃，并保持既有 transport 安全边界。

## 进入条件

- Block 1 的正向 characterization 仍失败、安全反例仍通过；
- `BrowserCaptureEvidence`/decision/intent 的字段和 owner 已进入 Accepted ADR；
- 已核实 Playwright 与 CloakBrowser response/download owner、临时文件和 callback 生命周期；
- 没有未解决的接口方向 finding。

## 责任与改动面

- Owner：Primary Agent；
- 主要文件：`src/sciretriever/network/browser.py`、`network/browser_control.py`、
  `network/playwright.py`、`network/cloakbrowser.py`（仅确有 vendor 信号缺口时），Network 直接测试；
- Network 拥有：request lineage、neutral evidence、pending resource、condition/timeout、body read、dedupe、cleanup；
- Network 不拥有：DOI/Publisher 解释、entitlement、route outcome、Catalog 发布；
- 受保护：共享 Broker/article token 隔离、host permit、late-event drain、单项字节上限。

## 需要保持的行为

- route/DNS/host admission 必须发生在 transport 前，capture 决定不能反向授权未准入请求；
- body read 仍在最终 ACCEPT 后、PDF 单项上限内发生；
- response/download 同字节只交付一次，late duplicate 删除一次；
- cancellation、cleanup failure 和 broken runtime 继续使未发布结果不可交付；
- `BrowserObservation` 不携带 vendor object 或敏感 locator。

## Tasks

- [x] **BCH06 — 引入中性 evidence 与三态 decision。** 一次性替换 `allows(locator, kind, media)` 的
  不足，Network 向 policy 提交 Block 1 冻结的 evidence，并只接受 ACCEPT/DEFER/REJECT。
  - 验收：非法返回、异常或字段不一致 fail closed；没有旧 bool guard 兼容路径。
- [x] **BCH07 — 重构 pending response/download。** Pending 保存 request lease、destination、kind、
  media 和中性 lineage，不缓存最终布尔决定；download 到达时使用当前证据重新决定。
  - 验收：Block 1 的“false 被永久复用”characterization 转绿，反例仍不读取 body。
- [x] **BCH08 — 实现 DEFER Candidate 生命周期。** DEFER 进入 `CANDIDATE`，等待 evidence update、
  native download、明确 rejection 或 capture timeout；状态变化唤醒 settle/readiness。
  - 验收：Candidate 不向 Agent 暴露空白页，不冒充 Captured，deadline 使用现有单次 capture wait。
- [x] **BCH09 — 完成 body/临时文件 owner。** ACCEPT 才读取 response 或 native download；REJECT、
  timeout、cancel、runtime/cleanup failure 和 callback race 各自只释放一次。
  - 验收：逐路径断言 read/delete/close/callback/permit 次数，并覆盖事件到达顺序反转。
- [x] **BCH10 — 保持 capture dedupe 与 article 隔离。** response + download、late duplicate、下一 article
  late event 和 shared context 并发 lane 不得重复或串线。
  - 验收：同一字节最多一个 capture；旧 article 的事件永远不能被新 article 接纳。
- [x] **BCH11 — 增加安全诊断。** Debug 只记录 decision、reason category、correlation kind、Candidate
  状态、body-read yes/no 和 cleanup outcome，不记录完整 locator、header、正文或 vendor error。
  - 验收：普通 INFO 不刷事件；日志脱敏 transcript 测试通过。

## 执行方式与集成点

顺序为类型/Protocol → pending 数据结构 → Candidate 状态 → body/cleanup → dedupe/diagnostic。每个切片
先跑 Network 直接测试。Block 2 使用最小 fake policy 驱动三态，不实现任何 ACS/DOI 分支；与 Block 3
的集成点只是一套冻结的 Protocol。

## 审查门

- R1：确认所有 vendor resource owner 与 condition wakeup 点；
- R2：每次修改检查“何时读取正文、谁删除临时文件、谁完成 request lease”；
- R3：无冻结布尔 pending、无双 policy、无未绑定 callback、无跨 article state；
- blocking：DEFER 无 deadline、ACCEPT 前读取正文、异常默认允许、cleanup 吞错。

## 接口、数据与依赖影响

- 接口：以唯一 `BrowserCapturePolicy` 替换旧二态调用合同及 pending 类型；
- 数据：只新增 operation-local 内存证据，不序列化；
- 配置/schema：无；
- 依赖：无；若 vendor wrapper 缺能力，先证明最小必要性，不升级依赖掩盖问题。

## 验证与证据

```bash
uv run --frozen python -m unittest discover -s tests -p 'test_network_browser.py'
uv run --frozen python -m unittest discover -s tests -p 'test_network_playwright_control.py'
uv run --frozen python -m unittest discover -s tests -p 'test_network_cloakbrowser.py'
uv run --frozen python -m unittest discover -s tests -p 'test_network_cloakbrowser_local.py'
uv run --frozen ruff check src/sciretriever/network tests/test_network_browser.py
uv run --frozen pyright src/sciretriever/network
```

按实际改动收窄/补充命令。证据记录每种 decision 的 body-read、capture、delete、close、request lease、
callback 和 article drain 计数。

## 退出条件

- BCH06–BCH11 全部完成；
- Network characterization 转绿，安全反例、取消、timeout、cleanup 和 late-event 全通过；
- 代码只有一套 capture decision/pending 路径；
- Network 不含 Publisher/DOI/ACS 业务分支；
- R3 无 blocking/material finding。

## 完成证据

- 内部接口已一次性切换为 `BrowserCaptureEvidence`、`BrowserCaptureDecision` 和
  `BrowserCapturePolicy.decide()`；response/download pending 只保存 lease 与 evidence，没有旧接口兼容层。
- `test_deferred_response_is_rechecked_after_landing_binding` 和
  `test_deferred_native_download_uses_current_policy_not_pending_snapshot` 证明 DEFER 在事实更新后重新
  判定；两条成功路径正文只读取一次。
- `test_unresolved_deferred_response_times_out_unread` 证明未收敛 DEFER 返回 `capture-timeout` 且正文
  读取为 0；安全反例中的 rejected download 各删除一次。
- Network/Acquisition/Cloak adapter/Playwright/Bootstrap 相关组合运行 180 项，全部通过（1 项未带显式
  runtime 的可选测试跳过；同一测试随后带本机已验证 runtime 单独运行 1 项通过）。
- 目标 Ruff check/format 全部通过；目标 Pyright 为 0 errors、0 warnings。Debug 事件只记录 decision、
  correlation、exact-start、redirect depth、body-read 与 cleanup 等安全字段。

## 失败与恢复

- 接口语义不够表达真实事件时回到 Block 1，不在 Network 增加布尔旁路；
- vendor download 无法安全延后时冻结失败 fixture，重新设计 owner，不读取/复制未授权正文；
- cleanup 或 late-event 回归时停在当前切片，保留既有 fail-closed 路径；
- 恢复从最后通过的 BCH Task 和对应 Network 测试继续。

## 下游交接

Block 3 获得：唯一三态 capture Protocol、可重新判定的 Candidate、确定性 wakeup/timeout/cleanup、
中性 correlation evidence 和通过的 Network 反例。Block 3 负责文章语义，不修改 Network vendor owner。
