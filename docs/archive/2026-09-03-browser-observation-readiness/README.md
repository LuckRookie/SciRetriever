# Browser Observation 就绪与页面交接实施计划

> 历史实施记录，非当前产品或架构真相源。当前行为以 requirements、Accepted ADR、current
> docs、源码与测试为准。

## 身份与状态

| 字段 | 值 |
| --- | --- |
| Run ID | `BROWSER-READY-20260903` |
| 创建日期 | 2026-09-03 |
| Primary owner | Codex `/root` |
| Baseline revision | `4ea15d51a46cf4f6c9c586fd7ad228fda4086a57` |
| 执行方式 | 单一 Primary owner；串行实施；cross-session 可恢复 |
| 当前状态 | Completed and archived — 2026-09-04；实现、文档、离线门禁与两家真实 Publisher 回归闭环 |

Baseline 工作树包含尚未提交的 Agents、Controlled Browser、Configuration、文档和测试改动；它们是本计划的输入，不得回滚、覆盖或混同为本计划新改动。

## 问题与目标观察

真实受控 Browser 回归已经证明 Agent 能完成模型调用、解析封闭工具动作并成功 dispatch 点击，但点击后的页面交接被 settle 误判为运行时失败：页面 revision 已推进，随后得到 `settle=failed` 且没有 capture。故障发生在 Network 对 navigation、Page/frame/context replacement 的接管上，不在 Agent 是否会点击。

计划完成后应能观察到：

- Agent 第一次调用前只接收一个稳定、连贯、可执行的 `BrowserObservation`；
- 模型思考期间页面若已变化，原动作在 dispatch 前作废，Network 先取得新的可执行 Observation，再决定是否重新调用模型；
- 动作 dispatch 后旧 Observation 立即失效；settle 跟随当前 article session，而不是继续依赖点击前保存的旧 Page；
- navigation race、execution context destroyed、frame detach/reattach、Page replacement 和 popup/viewer 切换作为过渡证据被重新观察，不直接压成 generic runtime failure；
- 页面在 action timeout 内没有语义变化时得到 `Settled(changed=false)`，真正的 Browser/process/context 退出、策略越界、取消或 deadline 才得到相应终态；
- Acquisition 最终向用户展示后来实际执行所得的具体 Browser failure；仅当 Browser 是 normal miss 时，才保留更早的 Public route failure；
- 不增加站点专用 selector/等待、固定 sleep、全局 `networkidle`、用户配置或持久化状态。

目标时序：

```text
await observable
  -> freeze Observation
  -> Agent call
  -> exact revalidate
  -> dispatch
  -> invalidate old Observation
  -> settle current article session
  -> next observable / capture / terminal
```

## 授权、真相源与边界

用户于 2026-09-03 同意上述方向并要求写入计划后持续实施。授权覆盖本计划内的源码、直接测试、Accepted ADR amendment、当前行为文档以及离线 Quick/Full 验证；不自动授权读取或记录个人 credential、Profile、Cookie、配置内容，修改真实 Catalog/资产，Git commit/push/PR/发布或破坏性清理。

适用真相源：

- [产品需求](../../architecture/requirements.md)的受控获取、安全、失败和中断边界；
- [ADR 0017](../../architecture/decisions/0017-shared-agents-and-controlled-browser-agent.md)的统一 Observation、封闭动作、execute/settle 和 typed terminal resolver；
- [架构设计](../../architecture/design.md)的 Acquisition、Network、Agents 与 Bootstrap owner；
- [Network 技术文档](../../architecture/technical/network.md)与 [Acquisition 技术文档](../../architecture/technical/acquisition.md)；
- [HARNESS](../../../HARNESS.md)的工程、验证、外部访问和 Git 纪律。

长期合同属于 ADR/架构文档；本 README 只记录活动实施与恢复事实。

## 已核实事实与根因假设

### 已核实事实

- 两个不同 Publisher 的真实文章均达到 `Agent tool call: success`、`dispatch: applied` 和 revision 推进，随后 `settle: failed`；
- `_client_control_execute` 在成功 action 后使 ledger 和旧 Observation 失效，这是正确的安全方向；
- `_client_control_settle` 第一次重新 observe 后，如果语义 fingerprint 未变化，会从新 Observation 的 `page_id` 取一个 Page，但底层等待仍把 navigation/context/frame 交接异常压成通用 runtime failure；
- Playwright adapter 已存在 `navigation-race`、`frame-transition`、`page-closed` 等 payload-free 分类知识，但 `control_wait_for_change` 尚未把可恢复过渡与真正 runtime failure 区分开；
- `_client_control_observe` 总是从当前 article-owned pages 选择最新 Page，具备重新取得 successor Page 的基础；
- Acquisition 将可继续升级的 route failure 按发生顺序积累，最终固定选择第一项；因此后来 Browser 的具体失败可能被更早的 Public failure 覆盖；
- 现有合同要求 Public failure + Browser normal miss 保留 Public failure，这一行为不得破坏。

### 验证结论

- “等待 article session 重新达到可观察状态”统一覆盖了同 Page navigation、frame replacement、successor Page、popup/viewer 与无变化 timeout，不再依赖单个旧 Page；
- 短语义 quiet window 连续得到一致 observation generation 足以判断本次可操作性，无需等待页面或网络绝对静止；
- transient vendor 异常在持有原始异常的 Playwright/CloakBrowser engine thread 内转换为 typed、payload-free `BrowserObservationUnavailable`，Acquisition 不接触 vendor 类型或正文；
- route issue 按“是否实际执行 Browser + failure specificity/outcome”选择主结果，修复了早期 Public failure 覆盖后来具体 Browser failure，同时保持 Browser normal miss 合同；
- Publisher 分类若观察到新的 stable semantic generation，会返回 `Stale` 并重新进入同一 readiness gate；分类后的未稳定 snapshot 不会交给模型。

若实现证据推翻以上假设或要求改变模块 owner、开放动作权限、增加站点规则/配置/schema/依赖，先更新计划与 ADR，再继续实施。

## 可操作 Observation 合同

“稳定”不表示整个网页完全静止，而表示本轮交给 Agent 的事实可以安全执行：

- 当前主 Page 属于同一 article session，仍被 Network 持有；
- 页面、frame/surface、元素与 screenshot 来自同一 observation generation；
- 没有已观察到但尚未完成接管的 document/Page/frame replacement；
- stable semantic fingerprint 在一个内部短 quiet window 内一致；revision、截图像素、动画和无关网络请求不参与稳定性判定；
- pending capture 必须先完成 captured/cleared/timeout 生命周期，不能同时向 Agent 发动作；
- 模型返回动作后仍需对 article token、revision、page/surface/element/screenshot binding 做完整精确复核。

readiness/settle 是 Network 的同一内部生命周期，不新增第二套 Agent 状态机，不持久化 `TRANSITIONING`/`OBSERVABLE`，也不将 quiet window 暴露为普通用户配置。

## 范围与非目标

### 范围

- `network` 的初始 readiness、Observation generation、action 后 session-following settle 与 transient transition 分类；
- Playwright/CloakBrowser adapter 的可恢复页面交接信号和资源清理；
- `acquisition` 对 stale/readiness transition 的消费和 route failure 主因选择；
- ADR 0017、Network/Acquisition 技术文档和必要当前行为说明；
- 离线直接测试、生产形状集成测试、Quick、Full，以及经既有授权边界允许的真实只读回归。

### 非目标

- 不增加站点专用等待、selector、点击策略或 Publisher 分支；
- 不使用固定 `sleep`、页面完全静止、全局 `networkidle` 或无限等待；
- 不扩大 `ClickElement`、`ClickPoint`、`ScrollSurface`、`GoBack`、`WaitForChange`、`Stop` 六种封闭动作；
- 不改变 Network guard、destination policy、Profile/credential、PDF 验收、capture 或 cleanup owner；
- 不新增公开配置、Catalog/schema、持久化 transition/history、依赖或兼容层；
- 不把 Browser workflow 或 vendor Page 对象下沉到 `agents`；
- 不把本问题混入 PydanticAI/SDK transport 迁移；
- 不自动 commit、push、PR 或发布。

## 分块地图

| 顺序 | Block | 结果 | 主要 owner | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 合同与 characterization | ADR amendment 和离线测试准确复现真实 settle/失败选择问题 | ADR 0017、Network/Acquisition tests | Completed |
| 2 | Observation readiness | 初次及 stale 后只向 Agent 提供可操作 Observation | `network/browser.py`、adapter、Browser controller | Completed |
| 3 | Session-following settle | action 后跟随当前 article Page/frame/capture，transient transition 可恢复 | `network/browser.py`、`network/playwright.py`、`network/cloakbrowser.py` | Completed |
| 4 | Acquisition 主失败 | later specific Browser failure 成为主结果，normal miss 合同不变 | `acquisition/cohort.py`、直接测试 | Completed |
| 5 | 验证与交接 | 相关测试、Quick、Full、文档、真实回归和最终 diff 闭环 | 集成测试、docs、Harness | Completed |

主依赖为 `1 -> 2 -> 3 -> 4 -> 5`。Block 2 与 3 共用 Network lifecycle，必须串行形成一个实现，不建立平行 readiness manager。

## Tasks 与验收

### Block 1：合同与 characterization

- [x] 修订 ADR 0017：稳定对象是一次 `Observation`；Network 管理过渡；执行后跟随 article session；transient navigation/frame/context replacement 不等于 failure。
- [x] 增加初始加载、模型调用期间 stale、click 后 context destroyed、frame replacement、successor Page、popup/viewer 和 no-change 的离线行为刻画。
- [x] 增加 Public failure + Browser normal miss 与 Public failure + specific Browser failure 的成对测试。

### Block 2：Observation readiness

- [x] 让第一次模型调用和 stale 后重试都经过统一 readiness gate。
- [x] 用同一 generation/semantic quiet 判断可操作性；不把 revision、截图像素、动画或无关请求当成进展。
- [x] readiness 期间 capture、取消、policy、真实 runtime exit 按既有 typed transition 终止。
- [x] 保持模型返回后的 exact binding 校验；旧 Observation 永不 dispatch。

### Block 3：Session-following settle

- [x] action 后立即废弃旧 Observation 与其 Page binding。
- [x] 每轮从当前 article-owned pages 重新观察并选择 Page/surface，不继续持有点击前 Page 作为等待对象。
- [x] navigation race、context destroyed、frame detach/reattach 和旧 Page closed 触发重新观察；真正 process/context 崩溃仍失败。
- [x] candidate/capture/cancel/policy/deadline 使用现有 typed transition；无语义变化 timeout 返回 settled false。
- [x] popup/PDF viewer successor 与资源 cleanup 有生产形状离线测试。

### Block 4：Acquisition 主失败

- [x] 明确 route issue 的选择规则并集中在 Acquisition owner 内，不依赖简单写入顺序。
- [x] Browser normal miss 时保留已有 Public failure。
- [x] Browser 实际执行后产生 specific failure/action-required/deferred 时，以其为最终主结果；较早证据仍保留在 route debug evidence。
- [x] Report/Completion 只展示最相关主失败，不堆叠低层失败。

### Block 5：验证与交接

- [x] 相关 Network、Browser、Acquisition、Bootstrap/Entry 离线测试通过。
- [x] `scripts/harness.py quick` 通过。
- [x] `scripts/harness.py full` 通过，包括 Pyright strict、全部 unittest、wheel 与内容核对。
- [x] `git diff --check`、文档链接/术语和最终架构语义审查通过。
- [x] 检查 diff 无 secret、个人路径/config/Profile、截图、PDF、真实语料、构建产物或无关改动。
- [x] 在合法授权范围内复跑两个真实 Publisher；旧的 navigation/context transition 不再被压成 generic settle/runtime failure，并检查资产完整性与 Browser 清理。策略越界仍按设计形成 typed policy terminal。

## 关键测试场景

- 初始页面仍在 document replacement 时不调用 Agent；
- 模型调用期间页面变化，动作被判 stale，并在下一次模型调用前重新 settle；
- click 后 `execution context was destroyed`，successor observation 随后可用；
- frame detach 后 reattach；
- 原 Page 关闭并由 article-owned successor Page 接替；
- popup 或 PDF viewer 成为当前观察面；
- candidate 分别进入 captured、cleared、timeout；
- 页面无语义变化到 timeout，返回 settled false 而非 runtime failure；
- Browser/process/context 真正退出仍返回具体 failed transition；
- Public failure + Browser normal miss 保留 Public failure；
- Public failure + specific Browser failure 最终展示 Browser failure。

## 风险与停止条件

| 风险 | 观察信号 | 处理 |
| --- | --- | --- |
| readiness 太弱 | 模型仍收到正在 replacement 的跨代事实 | 回到 generation/quiet 判据，增加反例 fixture |
| readiness 太强 | 普通页面每轮都耗尽 action timeout | 只等语义事实短时一致，不等全网空闲或动画停止 |
| transient 分类过宽 | 真正 Browser crash 被反复吞掉直至 timeout | 仅允许明确 navigation/frame/Page replacement 分类重新观察，进程/context 退出 fail closed |
| successor 选择错误 | popup/广告页抢占 article 主 Page | 继续受 article-owned page 集合、destination policy 与 capture 状态约束 |
| failure 覆盖过度 | Browser normal miss 擦掉更具体 Public failure | 成对回归测试固定 normal miss 与 specific failure 差异 |
| 测试替实现 | fake 在 action 后直接提供稳定页面，未触发真实对象图 | 至少一组 adapter/vendor event fixture 走生产 `BrowserClient` settle |
| 用户工作冲突 | 目标文件出现无法归属的并行修改 | 停止该 slice，重新核对 baseline，不覆盖用户工作 |

以下 finding 一律阻断完成：允许 stale action、绕过 Network guard、Candidate 当成功、transient 无限吞错、specific Browser failure 被早期 generic failure 覆盖、测试访问未授权真实凭据/数据、泄露禁止内容或覆盖用户改动。

## 进度、恢复与完成规则

- Task 只有在实现、直接测试、必要文档和当前 slice diff review 同时通过后勾选；
- Block 只有其 Tasks、块级测试和退出条件闭环后标为 `Completed`；
- Full 未运行或未通过时，本计划不得标为 `Completed`；
- 真实回归若尚无合法外部授权，必须作为明确残余风险，不得伪装为离线失败；
- 恢复时先读本 README 的当前状态和首个未勾选 Task，再核对 `git status --short`、目标文件 diff、ADR 0017 与最近测试证据；
- 发现 owner 或合同变化时先更新本计划和 ADR，再修改实现。

## 计划变更记录

| 日期 | 变化 | 原因 | 影响 |
| --- | --- | --- | --- |
| 2026-09-03 | 创建计划并进入 Block 1 | 两个真实 Publisher 均证明 action dispatch 成功而 session settle 失败；用户同意 Observation readiness 与 session-following settle 设计并授权实施 | 新增活动计划；不改变配置、schema、依赖或 Git 历史 |
| 2026-09-03 | Blocks 1-4 完成并进入验证 | readiness、session-following settle、engine-thread transition 分类、Publisher 重分类 stale 与 route 主失败选择均由直接测试闭环 | 不新增站点专用逻辑、配置、schema、依赖或持久状态 |
| 2026-09-03 | 真实回归发现 settle-policy 文案歧义并修复 | 已 dispatch 动作后的规则外顶层跳转被正确阻止，但中间 Agent 日志曾误写为 action binding rejection | destination policy 与 pre-dispatch action rejection 分离；新增生产形状回归测试 |
| 2026-09-03 | Quick、Full、真实回归与最终 Review 通过，Plan 完成 | Pyright strict 0 errors；unittest 发现 2268 项并通过；wheel 与内容核对通过；两家真实 Publisher 均未复现旧 transition/runtime failure | 真实回归未取得 PDF：一家正常无进展结束，另一家被本地 destination policy 正确阻止；两者均未改变 PDF/附加资产且完成 Browser cleanup |
| 2026-09-04 | 计划移入历史归档 | Observation readiness 与 session-following settle 的既定范围已经闭环 | 后续 capture handoff 缺陷不回填为本计划的未完成 Task |

## 完成交接

- 实现：Agent 第一次调用、模型调用后的 revalidate 和每次 action 后评价都经过同一 readiness/settle gate；settle 跟随 article session，可接管 successor Page；Publisher 分类跨代时重新 settle。
- adapter 边界：Playwright 在 engine thread 内把明确 navigation/frame/Page 交接转换为 payload-free `BrowserObservationUnavailable`；CloakBrowser command queue 只原样透传这一控制信号，其它异常继续脱敏。
- Acquisition：deferred/action-required 优先；否则选择实际执行最深的具体 route failure；Browser normal miss 不覆盖早期 Public/API failure。Report 只呈现主失败。
- 验证：相关 Network/Browser/Acquisition 191 项通过；Quick 通过；Full 通过，含 Pyright strict、2268 项 unittest、wheel 构建和 wheel 内容核对。
- 真实证据：一家 Publisher 完成多轮模型调用和 Browser action 后以已证明的 no-progress 正常结束；另一家完成两次模型调用与一次已 dispatch action，随后规则外顶层跳转被 destination policy 正确阻止。两者均无旧 `browser-control-vendor-failed`/generic settle runtime failure，无 PDF 或附加资产变化，并完成 cleanup。
- 边界：没有新增公开配置、Catalog/资产 schema、依赖、站点 selector/等待或持久化 Agent 状态；真实日志和快照只保留在系统临时目录，未进入工作树。
- 归档：`docs/archive/2026-09-03-browser-observation-readiness/`；本记录不再作为活动执行入口。
