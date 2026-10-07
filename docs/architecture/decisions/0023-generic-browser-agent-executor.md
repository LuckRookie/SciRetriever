# ADR 0023：通用 Browser Agent 执行器

- Status: Accepted
- Amended by: [ADR 0029](0029-unverified-pdf-acquisition.md)（下载取消文章身份门，保存未验证标签）
- Amended by: [ADR 0030](0030-browser-transport-and-progress.md)（临时传输、文章会话、后台下载、候选交接和平台限流）
- Date: 2026-09-06
- Updated: 2026-10-05（接受独立 worker、可暂停文章会话与活跃预算）
- Supersedes: none
- Amends: [ADR 0015](0015-publisher-aware-tiered-pdf-acquisition.md)、[ADR 0016](0016-cloakbrowser-fixed-identity-runtime.md)、[ADR 0017](0017-shared-agents-and-controlled-browser-agent.md)、[ADR 0021](0021-provider-model-registry-and-direct-task-selection.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[文献与材料：材料获取、路线与候选](../technical/03-literature-materials.md#4-材料获取路线与候选)、[任务与协作控制：共享支撑：受控网络访问](../technical/02-task-coordination.md#7-共享支撑受控网络访问)、[PDF 获取指南](../../guides/pdf-acquisition.md)

> 本次修订定义已接受的目标合同。独立 worker、后台传输和多会话工作台的生产接线与验收由
> [实施计划](../../archive/2026-10-05-browser-parallel-downloads/README.md)记录；决策被接受不等于能力已经交付。

## 背景

受控 Browser 最初同时包含两套页面策略：本地 Publisher-specific rule 和 Browser Agent。规则
拥有 selector、locator、origin、页面状态、capture 发现、限速组与会话组；Agent 虽然能看图并
选择动作，却仍要先通过 Publisher profile/rule 准入。结果是新增或变化的网站仍需为其编写规则，
Browser 的通用性由站点 catalog 决定，且 Rules、Agent、Network settlement 与 Acquisition PDF
验收形成多套重叠状态机。

产品引入 Browser Agent 的核心目的，是让模型在受控动作集合内理解不同页面，而不是让模型调用
一套持续增长的站点脚本。程序仍必须掌握确定性边界：何时页面稳定、动作是否精确绑定、是否真的
捕获文件、文件是不是 PDF、文件是否来自当前文章任务，以及资源何时安全清理。文章内容身份检验已由 ADR 0029 移出下载阶段。

## 决策

### 1. Browser 只有一条通用执行路线

生产对象图只注册 `browser:generic`。它使用全局 `browser-generic` policy group、用户选择的唯一
Browser Profile，以及唯一 `AgentBrowserController`。配置不再包含 `rules | agent` 选择，不存在
规则失败后切换 Agent 或 Agent 失败后回退规则。

Browser 保持在 Public → authorized API → Browser 的最后一层。拥有合法文章起点的目标可以进入
通用 Browser，不要求先解析为 catalog 中的 Publisher，也不要求存在站点规则。合法起点来自已经
接纳的 landing/direct `AssetHint`，或包含 DOI 且已经安全解析的 landing；Publisher 自由文本不能
单独创建起点。

### 1.1 Browser 是元数据驱动的慢速兜底通道

PDF 获取统一分为三条路径：公开 URL/仓储与其它无凭据公开路径、已授权 Provider API，以及通用
Browser Agent。前两条路径承担低成本、低延迟的优先获取；它们未取得当前目标的 PDF 后，仍未解决的
目标才进入 Browser。Sci-Hub 等 operator 明确启用的公开镜像属于第一条路径，不改变 Browser 的合同。

Browser fallback 的输入只有冻结的目标文献身份与元数据、当前版本、已准入的文章起点和 operation
边界。起点优先使用 `AssetHint`；目标只有 DOI 而没有 landing hint 时，可以先通过受控 DOI landing
入口取得文章页面，不能由 Agent 自己构造任意 URL。Browser 不根据 API 是否存在、Publisher 名称、
DOI prefix 或 Sci-Hub 结果选择页面策略，也不要求为当前站点实现 adapter、selector 或规则。

Browser Agent 以人类式观察、动作、等待和页面交接完成一次慢速文章操作。Network/runtime 统一捕获
页面 response、popup/viewer 和 native download 中的 PDF 候选；Acquisition/Intake 再执行 PDF 字节、
任务关联和不可变 publication 验收。Browser 候选、按钮文字、媒体类型或 Agent 的“已下载”判断都
不能直接成为成功结果。三条路径最终都交付同一个 Candidate → Intake → primary-pdf 合同。

该通道的成功标准是“对未知但具有合法起点的文章也能进行一次受控、可审计的尝试”，而不是覆盖某个
Publisher 的页面脚本。Browser 可以更慢、更昂贵并受 operation 寿命、活跃预算和用户配置的
Profile/IP 权限限制，但不能因为低层路线是否存在而改变其页面操作语义。

### 2. Publisher profile 不拥有 Browser 页面程序

`PublisherAccessProfile` 继续服务 Public/API route、访问方识别、稳定 origin/identifier 证据和
可选配置探测。其 Browser 字段只剩 `browser_probe_enabled`，表示该访问方是否有一个显式、只读、
不下载 PDF 的可达性 probe。

Profile 不再拥有 Browser route key、selector/locator、rule revision、allowed origins、risk/rate
group、session key、页面状态或正文点击流程。`production-ready` 是整个访问画像的工程状态，不再
表示该 Publisher 拥有 Browser 下载实现。未知 Publisher 也可走 `browser:generic`；文件统一验收并以文章身份未验证状态入库（ADR 0029）。

### 3. Agent 决定页面策略，Network 决定动作事实

Acquisition 从当前 Literature 事实形成有界 `BrowserArticleGoal`：DOI、版本、标题、作者、摘要片段、
期刊/出版社、年份和文献类型。已经准入的 landing/asset 起点及其 origin 仍由 Network/Browser 请求
边界持有，不进入模型目标。每次模型调用只接收这份目标、当前稳定 `BrowserObservation` 和一张当前
截图，并且必须选择以下一个动作：

```text
ClickElement | ClickPoint | ScrollSurface | GoBack | WaitForChange | Stop
```

Agent 不获得 selector、任意 URL、脚本、文本输入、Page/Context/CDP、Cookie、Profile、文件系统、
下载确认或事实写入能力。它只能提出下一步动作，不能宣布下载成功。

Browser 的文章 session 是操作状态的唯一 owner；Network 负责实际访问准入。底层 `start()` 与
`apply()` 在返回前吸收 loading、
navigation race、stale revision、frame/page/popup 交接、quiet settlement 和 capture candidate，跨层
只返回：

```text
Ready | Captured | Blocked | Failed | Cancelled
```

只有可观察的页面可以触发下一次模型调用。按 [ADR 0030](0030-browser-transport-and-progress.md)，
不要求子资源全部完成；导航期间执行上下文销毁则重新观察。每个动作绑定当前
article/page/surface/revision，最多执行一次 vendor action；绑定已变化时不重放旧动作。
Network 保留 URL/DNS/redirect/host admission、固定 CloakBrowser identity、取消、candidate 生命周期
和确定性清理。临时传输 query 不进入模型或持久来源，连接预算与单项文件大小分别计量。

页面状态描述 Agent 当前看到的页面。Challenge、登录、MFA、无权限、拒绝、未找到可交给 Agent；
短暂不变继续等待，重复输入被抑制而不是立即结束文章。Agent 的非正常页面 Stop、限流、连接失败
和硬预算分别保留失败原因，不冒充已证明无 PDF。

原始 capture 事件不是成功，但 Acquisition 文件验收通过的候选应及时结束生产探索并进入 publication。
`BrowserCaptureBatch` 只暂存同一操作的异步候选，不再要求模型继续尝试其它入口。收敛真实未完成的
capture 后仍无候选时，报告原始停止原因，不在空队列上等待并将其改写为候选超时。

### 3.1 独立 worker 只领取一轮文章执行权

文章 session 持有固定的 operation/generation、Literature、metadata snapshot 与 session identity，
以及当前页面、控制 epoch、近期动作、反馈、phase 和累计预算。一个 session 同时最多有一轮
模型决策；worker 只领取这一轮执行权，不拥有文章事实，不互相通讯或委派。完成一轮后让出执行权，
由就绪事件或下一到期时间重新调度。两个 worker 可以推进不同平台，仍服从共享 `agent-model`
scope/host 并发；不得为 Browser 建立独立模型限流器来绕过其它 Agent 调用。

动作结束到下一轮模型决策至少 5 秒。页面反馈等待与这 5 秒重叠，早到变化仅更新可观察事实，
不能提前派发；到期后页面仍不可观察时继续等待变化。内部观察或等待不是新增 Agent 动作。
Challenge 等页面与普通页面共用这套规则，不增加独立预算或点击脚本。

每篇文章有 300 秒累计活跃时间、50 次真实模型派发和 100 次 Agent 动作。活跃时间使用同一
单调时钟，累计模型实际派发后的推理、动作、主动页面反馈与节奏等待，重叠时间只计一次。
等 worker、共享模型 permit、平台冷却/Retry-After、人工接管、后台下载及本地验收/发布不计入活跃时间。
模型请求实际发送前才计一次 call；经 phase、控制 epoch 与页面绑定复检后才派发并计 Agent 动作。
已合法派发的第 50 次模型调用仍可交付其动作，下一次调用被拒绝；过期或迟到动作不能执行。

下载 started 原子暂停该 session 的模型决策并释放 worker，保留页面与独立 transfer 寿命。
本轮决策可取消，但不能用同一个 signal 切断传输。传输或文件检查失败后，将脱敏反馈带回原页面
重新观察；换 worker、人工交还、下载恢复均不重置预算。文件合法时停止探索并进入候选交接，
本地 publication 失败不回到下载循环。具体事件、取消与发布交接见 ADR 0030。

Workbench 投影同一个 session 的页面、控制 epoch、反馈和 remaining；不维护第二份 Agent 时钟、
候选队列或调度事实。选择前台标签页与选择观看对象均不能改变页面、传输或候选归属。

### 4. Capture 不是 Acquisition 成功

按 [ADR 0029](0029-unverified-pdf-acquisition.md)，Acquisition 只检查非空 PDF 字节、标准 reader
可读取且至少一页，并保留任务归属、当前输入复检及不可变发布；下载阶段不检查 DOI、标题、作者
或版本内容。通过文件门后，候选正常发布为 `primary-pdf`，明确标记“文章身份未验证”。

Agent 使用目标元数据选择文章与正文 PDF，捕获保留本次文章任务和来源。文章身份检验留待后续
解析阶段；当前标签不阻断下载、入库或解析。Agent Stop、HTTP Content-Type、下载事件或按钮文字
仍不能替代实际 PDF 文件检查和 publication。

### 5. 配置与运行政策归一

一级 `[browser]` 只保存：`model`、`enabled`、`profile`、本机并发上限和对 `browser-generic` baseline
的只收紧 policy overrides。Model 自己拥有 reasoning、image 和 stream；Browser 只选择一个
`image = true` 的完整 `provider/model`。

所有文章共享一个 operator-managed Profile、一个 CloakBrowser process/persistent context 和一个
`browser-generic` 聚合政策；该 policy 名称不再表示全局单 lane。平台资格由已核实的实际
landing/导航证据确定，同平台最多一篇文章有网络活动，覆盖页面与主下载；不同平台可以并行。
网络真实结束且保留页后续请求已被阻止后，开始该平台 30 秒冷却。本地文件验收/发布继续保留
session 责任，但不延长网络资格。CDN、DOI resolver、SSO 与 Challenge 服务不能被误当成全部
文章的同一个平台；Publisher 自由文本不能决定平台键。

`browser.max_concurrency` 继续表示保留文章会话 cap，默认 5，允许 1；首版有效资源上限 8。
旧较大配置仍可读取，实际 cap 为 `min(配置, 8)`，展示限制原因且不改写用户文件。worker 数为
`min(2, 有效会话 cap)`，另受共享模型预算限制；每个会话最多一个主下载，不另设下载 credit 池。
空 policy override 使用跨平台默认；旧 `browser-generic.max_concurrency = 1` 显式意图仍在
聚合层约束整个文章会话寿命。已接受的 start interval/window、completion/failure cooldown、
Retry-After 和 runtime failure 阈值均须执行，换 worker、入口、operation 或失败恢复不清零
当前进程已有窗口和冷却。恢复重新取得网络资格计一次 start，普通 5 秒 step 不计。

Publisher 分类不再决定模型是否能操作页面。配置中心的 Publisher site test 仍只测试显式支持的可达性 probe，不代表
通用 Browser 下载准入或文章权限。

### 6. 破坏性切换

删除 `RuleBrowserController`、`BrowserSiteRule`/catalog、Publisher rule modules、selector/locator
controller API、旧 capture kind，以及旧 `browser_controller` 配置。旧字段直接由严格配置边界
拒绝；不提供别名、迁移器、兼容 adapter 或隐藏 fallback。Literature、Asset、primary-pdf、
provenance 与自动获取耗尽的持久合同不变，因此不需要数据库迁移。

## 后果

正面后果：

- 新站点只要具有合法文章起点，就可由同一 Agent/Network 合同尝试，不再以编写 Publisher rule
  作为前置工作；
- 页面策略、页面事实和 PDF 正确性分别归属 Agent、Network、Acquisition，不再有第二套点击循环；
- 页面变化只需增强通用 Observation/action/capture 合同，站点差异不再扩散为 Python 模块；
- Browser 成功可以用同一文件验收和任务关联审计，模型无法用“看起来下载了”绕过 PDF 验收。

代价与限制：

- 成功率更依赖 Browser Model 的视觉理解和动作质量，模型失败不会由确定性规则兜底；
- 通用 origin admission 必须从当前已准入页面关系动态约束，不能依赖预先列出的 Publisher origin；
- 下载阶段不判断内容身份，选错文件的风险通过目标选择和 provenance 追溯；后续解析检验尚待实现；
- 真实站点效果仍需另行授权的现场测试证明，离线 fixture 只证明合同和对象图。

## 不采用的方案

- 保留 Rules 与 Agent 二选一：继续维持两套策略和配置语义，不能解决站点依赖。
- 让 Agent 直接持有 Playwright/Page/CDP：会把稳定化、capture correlation 和资源清理重新交给
  模型，无法形成可验证的程序交接。
- 由 Agent 输出 PDF URL 或“成功”布尔值：任意 URL 与自然语言结论都不能证明下载事实和文章归属。
- 将 LangGraph 引入 Browser 状态机：当前流程是消费模块拥有的有界反应循环，Network 已拥有页面
  状态；增加持久图或第二套状态机不会提升交接正确性。共享 Agents Runtime 继续以 PydanticAI
  Direct/协议 adapter 的无状态单次调用为基础。
