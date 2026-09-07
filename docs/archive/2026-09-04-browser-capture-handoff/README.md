# Browser Capture 交接修复计划

> 历史实施记录，非当前产品或架构真相源。当前行为以 requirements、Accepted ADR、current
> docs、源码与测试为准。

## 身份与状态

| 字段 | 值 |
| --- | --- |
| Run ID | `BROWSER-CAPTURE-HANDOFF-20260904` |
| 创建日期 | 2026-09-04 |
| Primary owner | Codex `/root` |
| Baseline revision | `4ea15d51a46cf4f6c9c586fd7ad228fda4086a57` |
| 执行模式 | cross-session；单一 Primary owner；串行实施；并行 Human Gate 未批准 |
| 当前状态 | Completed and archived — 2026-09-04；离线实现、文档、Full 与 R5 已闭环 |

本计划是在四项已完成计划归档后补建的活动修复入口。此前归档只写了“capture handoff
转入独立后续计划”，却没有同时创建该计划，这是执行交接遗漏；本计划如实记录为事后补建，
不得表述成归档前已经存在。

## 目标观察

完成后，Controlled Browser 在以下两种真实时序中都能把属于当前 Literature 的主 PDF 安全交给
Acquisition，而不会把错误文章、补充材料或任意同源 PDF 放行：

```text
新会话：Challenge -> Agent 动作 -> PDF response/download -> capture -> PDF 验收与入库
既有会话：首个顶层导航 -> PDF response/download -> capture -> PDF 验收与入库
```

用户能够观察到：

- PDF 在首次 Agent Observation 之前到达时，不因初始化时序永久丢失；
- response 与 native download 之间不会沿用已经过时的 `capture_allowed=false`；
- 尚未取得完整文章归属证据的资源只成为有界、隔离的 Candidate，不读取为可信正文、不发布；
- 证据补齐后 Candidate 只能进入 `CAPTURED` 或明确拒绝/超时，不能让 Agent在下载后的空白页上无意义等待；
- 若仍失败，Report 优先显示最接近交付点的 Browser/capture 原因，而不是被更早的 public `403` 掩盖；
- 最终真实验收必须得到已接纳的 `primary-pdf`，页面显示验证成功或仅出现 download event 均不算通过。

## 授权与真相源

用户先要求补齐“要实施的修复计划”，随后于 2026-09-04 明确要求开始实施。授权覆盖 Blocks 1-4
的源码、测试、ADR/技术文档和离线验证；不自动授权新的真实外部重跑、用户 Catalog 写入、Git
commit/push 或发布。

适用真相源：

- [产品需求](../../architecture/requirements.md) R3、R6、R8 与“受控 Browser”“文献下载”验收；
- [ADR 0017](../../architecture/decisions/0017-shared-agents-and-controlled-browser-agent.md) 的模块 owner、统一 Observation、Candidate 与 capture 终态；
- [架构设计](../../architecture/design.md) 的 Acquisition/Network/Storage 责任与事实所有权；
- [Acquisition 技术文档](../../architecture/technical/acquisition.md)；
- [Network 技术文档](../../architecture/technical/network.md)；
- [HARNESS](../../../HARNESS.md) 的工程、真实访问和 Git 边界；
- [无 PDF 调查与可观测性归档](../../archive/2026-09-03-browser-debug-observability/README.md) 第 6.6、6.7 节的真实 ACS 证据；
- [Agents 行为修复归档](../../archive/2026-09-02-agent-behavior-and-feedback-repair/README.md)与[Observation readiness 归档](../../archive/2026-09-03-browser-observation-readiness/README.md)的既有完成边界。

ADR 0017 已在 2026-09-04 amendment 中把一次性布尔判断修订为唯一三态
`BrowserCapturePolicy`，并冻结 Candidate、重新判定、exact-start redirect lineage 与 cleanup 合同。

## 已核实事实、假设与开放问题

### 已核实事实

- ACS 公开可读样本 DOI `10.1021/acsami.4c13590` 的首次运行中，Agent 成功点击 Challenge，随后
  出现相关联的 200 PDF response 和 native download，但 `capture_allowed=false`，最终 capture 为 0；
- 同一样本复测时，persistent Browser 身份已能直接取得 PDF：301 后的 200 PDF response 和 native
  download 都早于 controller 首次 Publisher Observation；页面随后分类为 `normal`，但资源已被拒绝；
- 两张实际发送给 Agent 的图片均为空白页，说明 PDF 已转为 native download，不存在 Agent 漏看的按钮；
- `_PublisherAgentControl.observe()` 才会根据页面分类绑定 landing；response 可以在此之前到达；
- `_PendingResponseDownload` 保存一次性的 `capture_allowed: bool`，download 路径有 pending 时直接复用
  该值，不重新询问当前 guard；
- Challenge 后的提前 rebind 只在本次 article operation 已准入至少一项 reviewed Challenge resource 时
  发生；persistent Profile 已有 clearance 的新进程可能正常得到零次 Challenge resource；
- 现有 direct-PDF Network 测试使用预先允许目标的 fake guard；真实 Cloak Challenge fixture 断言本轮
  `challenge_admitted > 0`，两者都没有覆盖“真实规则 guard + 零 Challenge resource + 首导航 PDF”；
- 当前最终 Report 可能保留更早 direct public locator 的 `403`，掩盖 Browser 已经取得 PDF、但在
  capture 边界被拒绝的更深事实；
- 现有安全路径没有发布错误 PDF，cleanup 删除了未交付 download；这是必须保留的正确行为。

### 已验证的实施结论

- capture 判断改为 `ACCEPT / DEFER / REJECT` 后，Network 保存中性的 request lineage 与
  Candidate 证据，离线正反测试同时证明初始化竞态消除且边界保持 fail-closed；
- Acquisition 在导航前提供 article-local capture intent，Network 提供 exact-start/live-request/
  redirect-descendant 等中性关联证据，文章归属不再依赖页面 Observation 的偶然先后顺序；
- native download 可以在 Browser 临时目录中保持未打开、未发布状态，直到决定变为 ACCEPT、REJECT
  或 timeout；fake vendor 与本地 Cloak fixture 已分别验证重新判定和实际 runtime 交接；
- Report 按实际执行深度和证据强度选择主失败，可以显示 capture handoff 失败且不改变
  `NoPrimaryPdf`、重试或长期 Catalog 语义。

### 已关闭的设计问题

1. 失效根因是文章 landing 事实尚未形成时，把一次性拒绝冻结到 pending download；不需要记录
   真实 locator 即可由 production-shaped fixture 复现。
2. exact DOI-PDF intent 与完整 live redirect proof 足以接纳 opaque descendant，但只在起点本身按
   本篇 identifiers 判为正文、最终 rule/origin 安全且没有显式外来 DOI 时成立；其它情况仍拒绝。
3. response 与 native download 均可作为 operation-local deferred resource 保持未读取，并在当前
   policy 下重新判定；timeout、取消和 cleanup 会确定性释放。
4. 新合同命名为 `BrowserCapturePolicy`，已一次性替换旧二态接口，没有兼容层或双生产路径。

任一开放问题若要求放宽 destination/DNS/host guard、允许任意同源 PDF、记录完整 URL 或跨文章复用
Candidate，必须停止并返回设计审查。

## 范围与非目标

### 范围

- `network` 的 capture evidence、decision、response/download reservation、Candidate 生命周期与 cleanup；
- `acquisition` 的 article capture intent、Publisher rule 判定、landing/identifier 证据和主失败选择；
- 两者之间不可序列化、operation-local 的中性合同及 Bootstrap 生产对象图；
- fresh Challenge、persistent clearance、首导航 PDF、错误文章、supplement、超时、取消和 cleanup 测试；
- ADR 0017、Acquisition/Network technical、必要的当前用户文档和真实单篇验收记录。

### 非目标

- 不修改 `agents` Runtime、prompt、模型、tool schema、六种 Browser 动作或 cycle fuse；
- 不为 ACS 增加固定等待、坐标、selector 或站点专属绕过；
- 不接受“同一 origin + PDF media type”作为文章归属证明；
- 不让 Agent 取得 Page、download、URL、Cookie、Profile、文件系统、CDP 或直接入库能力；
- 不改变 Public → Authorized API → Controlled Browser 的风险顺序；
- 不新增用户配置、Catalog/schema、持久 Candidate、下载历史或恢复现场；
- 不升级依赖，不读取/导出 Browser Profile 或凭据，不批量运行 `--all-pending`；
- 不在本计划中解决 RSC HTTP DOI 中间跳转、Wiley 外部身份 origin 或其它站点接入问题。

## 全局验收条件

- [x] **AC-1：首导航早到 PDF。** 真实 `_RuleCapturePolicy` 等价合同下，PDF response/download 在
  controller 首次 observe 前到达仍能进入 Candidate，并在文章证据成立后只交付一次；
- [x] **AC-2：Challenge 后早到 PDF。** Agent 动作后的 PDF 即使早于页面分类退出 Challenge，也能
  由同一 article/request lineage 安全收敛为 capture；
- [x] **AC-3：错误资源继续拒绝。** 错误 DOI、错误文章、supplement、排除文件、规则外 origin、
  无 correlation 和非 PDF 均在正文读取/发布前拒绝；
- [x] **AC-4：决定不冻结。** Pending response/download 不保存会过时的最终布尔权限；DEFER 在新证据
  或 timeout 后只能变为 ACCEPT 或 REJECT，重复事件不产生双份 capture；
- [x] **AC-5：Agent 行为正确。** Candidate 等待期间不把下载空白页发送给 Agent；capture 完成后不再
  调用模型，拒绝/清除后才允许继续正常页面控制；
- [x] **AC-6：资源生命周期闭环。** 接受、拒绝、timeout、取消、runtime/cleanup failure 和 late event
  都只释放一次；未发布字节不跨 article，不撤销已发布事实；
- [x] **AC-7：结果可解释。** Browser 已看到 PDF 但 handoff 失败时，Report 保留最深具体失败，public
  `403` 只作为先前尝试；进程结束与单目标业务成功不再在测试断言中混淆；
- [x] **AC-8：架构边界不变。** Acquisition 继续拥有文章/Publisher 判定，Network 继续拥有 vendor
  event、捕获和 cleanup，Storage 只接收验收后的事实，Agents 不获得新权限；
- [x] **AC-9：验证闭环。** 相关测试、Quick、Full、wheel 内容和最终 diff 审查通过；获得单篇真实
  授权后，ACS 样本形成有效 `primary-pdf`，或以与新设计矛盾的证据重新打开调查。

## 分块地图与依赖

| 顺序 | Block | 可验证结果 | 主要 owner/文件 | 前置 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | [合同与失效时序刻画](01-contract-and-characterization.md) | 精确复现两种早到时序和反例；ADR/接口方向冻结 | ADR 0017、Network/Acquisition tests | 计划获准 | Completed |
| 2 | [两阶段 Capture 交接](02-two-phase-capture-handoff.md) | Network 的 evidence/decision/Candidate/cleanup 闭环 | `network/browser.py`、`network/browser_control.py` | Block 1 | Completed |
| 3 | [Acquisition 集成与结果选择](03-acquisition-integration-and-reporting.md) | Publisher policy、Agent 门控和最深失败正确组合 | `acquisition/sources/browser.py`、`acquisition/cohort.py` | Block 2 | Completed |
| 4 | [验证、文档与真实交接](04-verification-and-handoff.md) | 生产对象图、Full、文档和真实授权状态闭环 | tests、architecture/current docs、Harness | Blocks 1-3 | Completed |

依赖主线为 `1 -> 2 -> 3 -> 4`。当前不并行：Block 1 的 evidence/decision 合同同时决定 Blocks 2、3，
在它冻结前拆分实现会制造两套语义。

## 跨块合同

### 两阶段交接

目标形状为：

```text
Acquisition: _BrowserAction (article-local capture intent)
  -> Network transport/destination/request admission
  -> BrowserCaptureEvidence
  -> BrowserCaptureDecision = ACCEPT | DEFER | REJECT
  -> DEFERRED Candidate (operation-local, bounded, unpublished)
  -> evidence update / native download / timeout / cancel
  -> ACCEPT: bounded body -> BrowserCapture -> Acquisition PDF validation
     REJECT: discard without publication
```

- Intent 在第一次导航前冻结当前 rule revision、稳定 identifiers、已知 landing/start 和允许的 capture
  形状；不携带 secret、Cookie、用户身份或任意执行能力；
- Evidence 只表达 Network 已经证明的中性事实，例如 capture kind、规范媒体类型、query-free 目标类别、
  top-frame/popup、exact-start/live-request/redirect ancestry correlation 和 article-local generation；
- Acquisition policy 决定正文/补充材料/错误文章，Network 不解释 DOI、Publisher 或 entitlement；
- `DEFER` 不是准许读取或成功，Candidate 必须有单项 timeout、取消和确定性 cleanup；
- 在 body read 和交付前必须使用当前 evidence 重新决定，不能复用旧布尔快照；
- query、完整 locator、vendor object、页面正文和 Profile 内容不越过边界或进入日志。

### 数据与失败

- 新状态只存在当前 article operation 内存和 Browser 临时目录，不进入 SQLite、Catalog、provenance 或
  跨命令恢复；
- 只有现有 PDF validation 与发布事务完成后才形成 `AcquiredPrimaryPdf`；
- handoff 的普通候选拒绝可继续其它候选；安全/contract/runtime/cleanup failure 不能伪装成 normal miss；
- 最终主失败按 deferred/action-required、实际执行深度和具体证据选择，不依赖“谁先写入”；
- 后续阶段失败不撤销已提交的有效文献、资产或解析事实。

## 影响矩阵

| 面向 | 预期影响 | 保持不变 |
| --- | --- | --- |
| 内部接口 | `BrowserCapturePolicy` 与 pending/deferred candidate 合同已一次性替换 | 不保留双协议兼容层 |
| Network | 新增中性 capture evidence/decision 与可唤醒的 Candidate 收敛 | destination、DNS、host、字节和 cleanup guard 不放宽 |
| Acquisition | 文章 intent、Publisher 判定与主失败选择接入新合同 | route 顺序、PDF validation、事实 owner 不变 |
| Agents | 无代码变化预期 | role、prompt、动作、settle/cycle/safety fuse 不变 |
| 配置/CLI | 无 schema 或新选项 | `complete pdf` 命令形状不变 |
| Catalog/资产 | 无 schema/格式迁移 | create-if-absent 与不可变资产不变 |
| 依赖/打包 | 无新依赖 | `pyproject.toml`、`uv.lock` 与 wheel 面保持 |
| 日志/Report | 增加 payload-free handoff 结果与更准确主失败 | 不记录完整 URL、正文、截图或凭据 |

## 风险与转化信号

| 风险 | 观察信号 | 处理 |
| --- | --- | --- |
| DEFER 变成隐式放行 | body 在 ACCEPT 前被读取或进入 TemporaryPdf | blocking；回到 Block 1 合同 |
| 候选悬挂 | download/callback/response 在 timeout 或取消后仍存活 | blocking；修复 owner/cleanup 后再继续 |
| 文章身份过宽 | 同源错误 DOI 或 supplement 被捕获 | blocking；不得以成功率为由接受 |
| 文章身份过窄 | exact DOI intent + live redirect proof 仍系统性拒绝 | 回到 evidence 充分性，不加站点等待 |
| Network 理解 Publisher | Network 出现 DOI、ACS 或 selector 分支 | material；移回 Acquisition policy |
| Agent 被错误唤醒 | Candidate 尚在收敛却发送空白页模型调用 | 修正 controller/readiness 门控 |
| failure 优先级破坏批量语义 | normal miss 覆盖系统失败或单目标失败终止其它目标 | 回到 Cohort typed evidence 测试 |
| 需要持久化现场 | 方案要求跨命令保留 Candidate/download | 停止；超出当前产品和 ADR 边界 |

## 验证与证据策略

顺序固定为：

1. characterization tests 先在旧实现上稳定失败，证明测试命中真实缺口；
2. Network 单元测试覆盖 decision、Candidate、response/download、timeout/cancel/cleanup；
3. Acquisition 规则与 cohort 测试覆盖文章身份、supplement 和主失败；
4. 生产对象图 fake vendor integration 覆盖 controller 启动前 PDF；
5. 本地 Cloak fixture 覆盖 fresh Challenge 和 reused/persistent-clearance 等价路径；
6. `uv run --frozen python scripts/harness.py quick`；
7. `uv run --frozen python scripts/harness.py full`；
8. 获得明确授权后，只对固定 ACS Literature 运行一次真实 `--debug complete pdf`，核对 JSON、
   capture、PDF validation、Catalog 结果和 Debug 图片，不运行 `--all-pending`。

原始日志、图片、PDF 和测试数据库只进入系统临时目录下的 `sciretriever-*`；计划只记录命令、
payload-free 结果和正式文档链接。Full 未通过或未运行时不能声称代码交付完成；真实外部验收未授权
时必须单独标成残余风险，不能由 fake 代替。

## 授权门

| 触发 | 动作 | 所需授权 | 当前状态 |
| --- | --- | --- | --- |
| 计划文档 | 创建和修订本活动计划 | 用户本轮要求 | 已授权 |
| 源码/测试/ADR 实施 | 执行 Blocks 1-4 的仓库改动 | 用户确认本计划并明确开始 | 已授权（2026-09-04） |
| 真实 ACS 回归 | 访问真实 Publisher/Model，并在成功时写入指定 Literature | 用户明确授权单篇目标 | 未授权；未执行 |
| 其它真实文章或批量 | 新增目标或运行 `--all-pending` | 新的精确授权 | 未授权 |
| Git commit/push/PR/发布 | 改变历史或外部协作状态 | 对应明确授权 | 未授权 |
| Profile/凭据内容 | 读取、导出、显示或修改 | 本计划不申请 | 禁止 |

## 执行方式与集成点

Primary owner 串行执行。每个 Task 遵循：预检 owner/调用方和受保护 diff → 先写失败测试 → 完成一个
最小合同切片 → 相关测试 → diff/安全审查 → 记录证据。Block 2 与 Block 3 的唯一集成点是 Block 1
冻结的中性 evidence/decision 合同；不得通过临时 duck typing、双 guard 或兼容 adapter 汇合。

当前工作树包含大量用户和前序任务改动。实施必须在现状上精确修改目标文件，不 reset、checkout、
批量格式化或顺手提交无关变化。并行默认关闭；若未来启用，需要用户明确批准 Blocks、文件 owner、
共享合同和汇合点。

## 执行审查

| Gate | 时点 | 必查内容 | 未通过处理 |
| --- | --- | --- | --- |
| R0 | 开始 Block 1 前 | 用户是否批准计划；事实、未知项、安全边界与测试入口是否完整 | 保持 Ready，不改源码 |
| R1 | 每块进入 | 前置证据、owner、受保护改动、接口与直接测试 | 保持 Pending |
| R2 | 每个切片 | 失败测试是否先命中；body read、cleanup、wrong-article 反例是否闭环 | 当块修复或退回合同 |
| R3 | 每块退出 | Tasks、相关测试、接口一致性、恢复点与下游交接 | 不标 Completed |
| R4 | Blocks 2-3 汇合 | Network/Acquisition 对 decision、Candidate、失败和 cleanup 是否只有一套语义 | 回到产生分歧的 Block |
| R5 | 最终交付 | AC-1–AC-9、Full、文档、真实授权状态、diff 与 secret/数据检查 | finding 关闭或明确残余风险 |

## 进度规则

- Task 只有实现、直接测试和错误路径证据同时成立时才勾选；
- Block 只有全部 Tasks、块级集成和退出条件闭环时才标 `Completed`；
- 真实 ACS 回归是产品级最终证据，但在未授权时不阻止离线代码审查；它会阻止宣称真实 PDF 获取已验收；
- 新证据改变 owner、安全模型或长期合同，先更新本 README 和 ADR，再继续实现；
- Plan 只有 AC-1–AC-8、Full 和必要文档闭环，且 AC-9 的真实状态被准确处置后才能完成并归档。

## 恢复与续作协议

最近恢复点是最后一个通过 R2/R3 的 Task。跨上下文继续时依次读取：

1. 本 README 的状态、开放问题、分块地图和变更记录；
2. 当前 Block 的首个未勾选 Task及完成证据；
3. ADR 0017、Acquisition/Network technical 与目标文件当前 diff；
4. `git status --short`，确认用户改动仍受保护；
5. 最近失败测试或 Harness 输出，而不是重新发起真实 Provider 请求。

失败时保留最小复现和已通过证据，不用 reset/checkout；接口方向变化回到 Block 1，cleanup/资源 owner
问题回到 Block 2，Publisher/结果选择问题回到 Block 3，门禁或文档问题回到 Block 4。

## 计划变更记录

| 日期 | 变化 | 原因 | 影响 |
| --- | --- | --- | --- |
| 2026-09-04 | 在已完成计划归档后补建本活动计划 | 归档时只留下“独立后续计划”文字，却没有创建可执行入口；用户指出遗漏 | 如实标记为事后补建；本次只新增计划，不宣称源码已开始 |
| 2026-09-04 | 计划进入 In progress，开始 Block 1 | 用户明确要求开始实施计划 | 授权源码、测试、ADR/技术文档和离线验证；真实外部与 Git 写操作仍受独立授权门约束 |
| 2026-09-04 | Blocks 1–3 完成，进入 Block 4 | 三态合同、Network Candidate lifecycle、Acquisition policy 与主失败已经通过相关测试 | 保留 Full、最终 diff/文档审查和真实授权状态交接 |
| 2026-09-04 | Block 4 与计划完成并归档 | 本地真实 Cloak、生产等价矩阵、Quick、Full、文档和 R5 全部闭环 | 真实 ACS 未授权，作为明确残余风险；未执行 commit/push/发布 |

## 最终交接

正文交接现在只有一套 `BrowserCapturePolicy` 三态合同。Acquisition 在首次导航前提供文章意图并拥有
Publisher/文章归属；Network 拥有中性 evidence、response/download 仲裁、Candidate、字节读取和 cleanup。
非导航 fetch 可以直接接纳 response；external-PDF 顶层导航等待 native download；同级决定优先原生
download；拒绝 reservation 只用于 correlation/删除，不冒充 Candidate。已经开始的 download callback
在资源回收和结果返回前完成，response/download duplicate 只交付一次。

本地真实 Cloak 四项、Challenge 一项和安装后 JavaScript/blob 一项通过；Network 三组直接回归 121 项、
跨模块矩阵 212 项通过；Quick 与 Full 通过，Full 发现 2287 项测试并完成 strict typecheck、全部 unittest、
wheel 构建和内容核对。长期行为已进入 ADR 0017、Network technical 与 PDF 获取指南。

本计划没有改变配置、Catalog/schema、公开文件格式或依赖，也没有给 Agents 增加 Page、URL、Cookie、
Profile、文件系统或入库权限。最终 diff 检查未发现凭据、个人配置、Profile、PDF、数据库、截图或构建
产物。真实 ACS 单篇因未获 Publisher/Model/用户 Catalog 授权而没有运行，不能宣称真实站点已经形成
`primary-pdf`；这是唯一接受的残余风险。Git commit、push、PR 和发布均未执行。
