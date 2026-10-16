# 08 · 浏览器会话与控制技术设计

[设计总览](../design.md) · [八模块技术导航](../technical.md)

本模块对应设计中的 **⑧ 浏览器会话与控制**，管理同一生产浏览器的会话、页面、观察、受控动作和下载捕获，支持人类观看、指导、接管与交还。

内部区分 Host/Page 生命周期、文章流程、观察与动作、控制权交接。③决定何时需要浏览器并验收下载候选；②负责操作级范围、队列和介入协调；①提供人类界面；共享 Network 与 Agents 分别按②和⑤中的技术合同使用。[ADR 0031](../decisions/0031-dsh-backed-agent-capabilities.md)的 DSH/Cordis 执行基础通过中性能力接口支撑同篇多轮工具交互；文章、控制、下载和发布 owner 不变。

当前已有 Browser 组件、生产 factory、文章流程和工作台控制基础；真实 runtime 旅程、连续生产协作与自然语言指导的完成程度在本篇区分。捕获文件不等于资产已接纳，过期控制动作不能派发。

本篇目录：

- [1. 模块边界与连接](#1-模块边界与连接)
- [2. 生产 Browser 与文章会话](#2-生产-browser-与文章会话)
- [3. 获取准入、调度与进展判断](#3-获取准入调度与进展判断)
- [4. 观察、指导与控制权交接](#4-观察指导与控制权交接)
- [5. 人工协作与运行边界验证](#5-人工协作与运行边界验证)

## 1. 模块边界与连接

材料获取③提出文章交付，任务②协调范围和介入，接口①提供工作台；候选返回③验收。

本篇按职责归并已有详细合同；示例中的现有类型与目标类型保持各自状态。文档归属不改变源码目录、事实所有权或当前公开 API。

## 2. 生产 Browser 与文章会话

### 2.1 人类协作与共享 Browser 边界

按 [ADR 0026](../decisions/0026-agent-knowledge-and-human-collaboration.md)，[统一产品接口：人类工作台与知识阅读](01-product-interface.md#4-人类工作台与知识阅读)需要观察并介入同一个生产 Browser 会话。Network/Browser Host 继续唯一提供真实页面观察、受控动作、捕获与清理；控制权和指导生命周期由应用运行时管理，UI 不另建浏览器或绕过访问政策。

新动作派发必须同时验证当前文章、页面 revision 与控制权；接管使旧决定失效，已在途请求按实际结果处理，交还重新观察。自然语言指导交由 controller 消费，不进入通用 Network 的业务判断。实时画面使用受控会话读取，不进入普通日志或文献数据库；长期录像/历史策略未定。自动登录/MFA 等权限不因人类接口而扩大。当前生产工作台已接通同页观看、指导、控制、操作反馈和 Library 阅读衔接；真实站点仍需独立验证。

[ADR 0032](../decisions/0032-library-centered-web-workspace.md)确定新的交互方向：画面默认观看，用户在画面上直接操作可以触发控制权交接；无人介入时自动获取仍按实际结果结束，不以等待人工为默认阶段。该方向尚需前端和服务端联合适配，不表示当前已支持任意直接输入。服务端必须先确认控制权和当前文章/页面绑定，才派发输入；首次点击期间页面变化、多窗口竞争不能通过盲目重放事件处理。已存在的显式接管、交还和自然语言指导能力保留。

### 2.2 浏览器实现

#### 2.2.1 当前 TypeScript surface 与接线状态

Network 当前活动实现是 `apps/server/src/network/`：`policy.ts`（URL 规范化、DNS/地址分类、
redirect 与 credential forwarding 决定、脱敏）、`budget.ts`（`NetworkBudgetCoordinator` 的
进程内预算与并发准入）、`connection.ts`（`VerifiedConnection` 目标绑定与重绑定校验）、
`http.ts`（`createAgentTransport` 与普通 HTTP 执行）、`browser-proxy.ts`
（`BrowserNetworkProxy` 的 loopback CONNECT proxy）。Browser runtime 位于
`apps/server/src/browser/`：`BrowserHost`、`BrowserControlCoordinator`、`BrowserObservationStore`、
`BrowserPageRuntime`、`BrowserTransferDispatcher`/`BrowserTransferCollector`、`BrowserDisplay`、
`HumanizedBrowserInput` 与 `createBrowserCapability()`；`createBrowserDecision()` 保留单次兼容入口。

**当前接线状态**：生产 `createApplication()`（`bootstrap/application.ts`）在 Browser 显式启用且
固定 bundle 验证通过后，自动组装 Network-owned loopback CONNECT proxy 与公网地址准入，
惰性构造唯一 Cloak persistent context/Profile。无 verified runtime 时公开 `browserHost()` 稳定返回不可用。
Entry 的 Public/API/Browser 分层获取、按文章的调度、Intake、PDF 文件检查与不可变 publication 已接通；
只有资产与关系提交得到 receipt 才算正式入库，文章身份统一标记 `unverified`，不以 DOI/标题匹配阻止下载。

Browser 按 session/page/operation/generation 归属请求、popup 与文件；同篇关联资源与合法重定向可跨 origin，
每次仍执行 Network 的协议、DNS、公网地址与端口检查。它不再限定起点的单一 origin，也不按出版社配置点击脚本。
默认2个决策worker与5个保留会话；下载让出决策worker但保留原会话，同平台网络活动串行且真实结束后冷却30秒。
动作结束到下次实际模型派发至少5秒；单篇累计300秒活跃时间、30次派发，先到上限停止进一步探索，动作保留统计而默认不独立设限。排队/传输/本地验证不计活跃时间。
最后一次合法调用可完成动作与既有有界页面反馈、下载交接；时间及控制版本检查继续生效，已启动传输使用独立寿命，恢复不重置预算。
文件流按块落盘、检查与发布；资源保护和显式串行兼容见[PDF获取指南](../../guides/pdf-acquisition.md)。

动作执行继续绑定当前 revision 与短期 element ID；重复点击检测比较可见页面内容、viewport 和当前控件位置，
不把 DOM 重绘后同一控件的新 ID 当成新动作。模型通过独立文章会话收到连贯的工具调用/真实结果、当前观察与人工/下载反馈，最近动作摘要只作为补充；
重复动作改为观察等待，不因页面不变或登录状态提示自动认定无权限或结束。页面内容变化、不同控件与人工控制边界仍按原合同处理。

`BrowserPageRuntime` 对主文档与可见 frame 的文本/控件语义作有界内容采样，跨 origin 与嵌套 iframe 同样参与反馈；不比较动画像素或连续变化的坐标。等待结果区分 `changed` 与 `timeout`，并报告实际等待时长；frame 读取的过渡失败不冒称变化。Driver 向同篇 Agent 工具结果及下一观察提供连续未检测到变化的等待次数/累计等待毫秒，变化、执行其它动作或控制权失效后重置。`success` 仅表示动作执行结束，不能暗示页面已取得进展；旧低层 seam 未报告结果时保留未知含义。既有停止理由、活跃预算、worker 释放、平台租约与动作后 5 秒节奏保持。该采样不覆盖纯 canvas/图片像素变化，仍须重新观察截图。

普通文档资源的生命周期由精确 CDP session/frame/loader/request 关联。只有默认上下文消失与新loader提交相互印证，
且 Network/Fetch 类型一致，才将旧文档的 Script/XHR/Image/Stylesheet/Font 判定为文档依附资源；
Fetch、Other、keepalive、原生下载及PDF流不能仅凭文档替换推断终止。未接管的渲染响应在旧document失效后仍停在
Fetch response pause时，可读取它自己的IO流至EOF来结清，不能另发GET。明确取消必须确认原IO关闭与原Fetch取消，
之后才撤销其待响应IO.read RPC；IO.close失败继续保留所有权和错误，不以本地Promise结束冒充网络终态。
Renderer的Network终态与target销毁只作为原请求的精确终态证据，不能提前删除尚未结束的managed IO。
普通Fetch/XHR的inline PDF继续交给renderer，不作为主下载；后台预览可以来自主frame，
请求发生在点击之后也不能证明其为Agent选中的正文。明确attachment的Fetch/XHR仍取原响应IO流；
顶层PDF导航、原生下载及页面后续发起的blob下载保留。这里区分网页渲染与文件交付，不进行文章身份解析。
可下载响应头保留原生下载意图，实际GUID表示writer已启动；活跃文章的popup关闭后仍保留迟到GUID的归属，
整篇会话确认关闭才回收意图，关闭后迟到writer执行取消/退役。初始open在导航前接通单文章取消信号，
预算终止不会误标为用户取消，也不会取消其它文章。完整关闭由实际page.close结束页面，同时独立结算writer/IO/worker；
连接失败重试只允许精确已准入且有失败证据的同URL GET，重定向到其它地址失败不能授权重放原始DOI。

实际本机Cloak测试覆盖正式Application、popup归属、并发、资源/取消和文件发布；真实出版社测试独立记录于
2026-10-07最终验收（本地文件：`sandbox/reports/browser-final-acceptance-2026-10-07.md`，不随仓库分发）。单次成功不代表所有文章都有订阅权限，
也不代表验证码、DNS与限流不会再次发生。生产Network仍拒绝loopback；本地测试仅通过显式fixture adapter准入。

当前生产 `createApplication()` 注入唯一 `DshAgentRuntime`，`createBrowserCapability()` 通过其 `createSession()` 按文章 session/Literature 身份打开 DSH scope，并显式提供最新图片投影、必须选择工具及动作输出限制。工具只暴露 `browser_action`，封闭动作仍由 `article-flow.ts` 执行并复核页面、控制 epoch 与观察版本；一批多个调用对同一观察至多接纳一个动作，其余记录拒绝。工具批次结算后让出本轮，取得新观察才继续。人工指导、接管/交还、人工动作及传输/验收反馈追加至原文章历史，前台选择不改变归属。下载暂停保留会话；取消/关闭释放 scope、模型路由与图片。

每个普通推理或压缩请求具有独立 request identity 和文章准入生命周期，通过同一配置/Credential/Network 派发。排队取消或预算拒绝不发送请求，真实发送后失败仍计一次；文章累计预算不因 worker 调度、人工交还或恢复而重置。模型输入只发送最新图片，旧图片用引用说明替代，原事件与图片仍保留至会话关闭。压缩改变模型可见投影，不接纳文献事实，也不等于释放全部历史内存。真实模型/站点效果与这些离线边界测试分开验收。

本节为当前TypeScript运行事实。下文保留的Python式 `BrowserFlowSession`、capture-policy及旧预算示例属于历史设计材料；
如与上述当前行为或Accepted ADR 0023/0029/0030冲突，以Accepted合同与当前TypeScript接口为准，不能据此恢复身份门槛或站点规则。

#### 2.2.2 Session、文章调度与资源所有权

当前 `BrowserSessionBroker` 位于 `entry/pdf-acquisition.ts`，持有 `BrowserDeliveryScheduler` 和 host accessor。它不直接创建 Chromium，也不是历史 Python broker 的逐方法移植：

```ts
// 当前 broker 的调用语义；完整类型位于 entry/pdf-acquisition.ts。
deliver(request: PdfAcquisitionRequest,
  action: (host: BrowserSessionHost) => Promise<BrowserDeliveryResult>
): Promise<BrowserDeliveryResult | null>;
close(): Promise<void>;
```

scheduler 按 Application 串行文章交付，绑定 `operation_id`、`generation` 和取消信号；排队期间取消或 generation 落后时拒绝执行。一次队列项失败不阻塞队尾；close 禁止新项并等待已排入工作的结算。host 不可用返回空能力结果，再由 Acquisition 判断缺能力，不能把任意 Browser 错误包装成正常耗尽。

Bootstrap 拥有惰性 `BrowserSessionHost`。生产 factory 要求已验证 Cloak runtime 和 Network navigation admission；构造 factory 不创建 Profile、不启动 Chromium 或访问外站。Network-owned proxy 在 Application 组装时打开本机监听，Application 关闭时释放。实际 `BrowserHost.start()` 才取得 Profile 锁、创建 persistent context；`close()` 释放 page/context/display/锁。关闭时 broker 取消在途并拒绝排队项，host 同时关闭以解除未返回的页面操作；两者结算后再关闭 proxy，独立关闭错误均保留。

Broker 排队、Browser 控制权与文档版本是三个独立域：前者决定轮到哪篇，控制 epoch 决定谁可以动作，EvidenceRef 决定引用哪些不可变材料。不能用同一个 generation 代替三种身份。

#### 2.2.3 文章隔离与安全生命周期

以下是文章流程必须满足的隔离语义；具体能力由 `article-flow.ts`、`host.ts` 和 transfer adapter 协作提供，未由真实 Cloak 旅程验证的部分仍属于待验证合同。

共享 persistent context 保留 Profile，但每篇文章必须有独立的目标身份、page/observation、临时下载和交付绑定。事件分派校验当前文章和页面，结束后的晚到 response/download 不能交给下一篇。失效 route 应终止，未交付临时文件只清理自身所有的文件；事件清理失败形成明确 Browser failure。

正常关闭需要等待在途动作和 transfer 结算；取消停止新动作，不虚称已经派发的点击从未发生。运行时损坏后禁止复用该 context，先排空当前资源再关闭；不能创建一个平行浏览器来掩盖原资源未释放。关闭失败保留首次失败和资源释放结果，重复关闭不重复触发 vendor 操作。

Profile 的跨进程锁保护同一持久身份，原始 Profile 路径仅在 Configuration/Bootstrap/Host 内部流转。当前 `BrowserHostOptions.profile` 是内部路径参数，不是可接受任意远程路径的公开协议。Cookie/local storage 由 Chromium 管理，不导入/导出给 Agent，也不作为文献事实保存。关闭 Browser 保留 Profile；删除 Profile 属于明确配置动作。

历史 Python 文档中 `begin_article/end_article`、`CLONE_FS` 线程、sterile wrapper cache 和 `cloakbrowser==0.5.8` banner 补丁都不是当前 TS API 或实现。当前运行时来自 Configuration 校验过的 bundle/manifest，由 Playwright 直接驱动；安装、锁、hash 校验和环境隔离依实际 TS 路径验证，不能沿用 Python wrapper 版本号声称满足。

当前 `page-runtime.ts` 生成 quality 65 JPEG 观察。截图格式必须与 Browser model capability 一致；截图是临时决策/观看材料，不能作为已接纳 PDF 或长久科学证据。Debug 仅记录安全的操作/状态摘要，不显示 Profile、Cookie、完整 URL query 或原始页面秘密。

Browser adapter 对每个文章流程负责：

- 在 canonical landing 第一次导航前取得 provider `web` scope permit；当前文章第一次使用每个
  已批准 hostname 时取得一项实际 host permit，同篇文章对该 hostname 的 navigation、CSS、JS、
  图片和 PDF 请求复用它，并在文章资源完整清理后统一释放；整篇文章的 `browser-generic` 串行、文章启动间隔和 cooldown 由调度与 Network 访问政策分别拥有。host permit 继续在共享
  Coordinator 中阻止其它 API/Browser 流程并发抢占同一 host，但不会在 Playwright 的单一事件
  线程中让同页第二个子请求等待第一个 response 事件而自锁，也不会把文章间隔错误套到每个
  CSS/JS/PDF 子请求上；
- 复用当前对象图的共享 persistent context，并只管理当前 article token 下的 page、popup/viewer、
  response/download 与临时资源；
- 对 Playwright 在请求继续前暴露的 navigation、页面 request、popup、viewer 与 download，先执行 Acquisition Profile 提供的封闭 Provider guard，再执行 Network 通用 URL、DNS、地址类别、origin、credential forwarding、host admission 和单次资源上限检查；未再次暴露 request 的 native redirect 只能按下文同页 live-proof 规则关联，并在读取 terminal body 前完成最终目标复检与 host admission；
- 在 Profile 允许的范围内捕获 download event、PDF response、合法 popup/viewer 或已核实 locator，并只交付统一 `TemporaryPdf`；
- 对每次 request/navigation/action、screenshot、response/download body 和 cleanup 分别执行客观 timeout/字节上限，不累计文章 step、总时长、popup、download 或 capture 作业预算；
- 在成功、正常未命中、失败、取消、timeout 或清理异常后关闭全部文章资源，释放 permit，并保留仍有效的 `next_allowed_at`、`blocked_until` 与 circuit。

每个文章 `_FlowState` 的资源生命周期固定为 `active -> cleaning -> cleaned | cleanup-failed`。
page、popup、download、可关闭 response stream、文章临时目录、host/scope permit 和 runtime task
在进入文章清理时先转移一次所有权；共享 context/process/Profile lease 由 Broker/Playwright
runtime 独立拥有，文章清理不能关闭仍被其它 lane 使用的共享资源。每项文章资源释放最多调用
一次，第一次失败作为粘性结果保留，同时继续尝试其它资源。普通 Playwright
`response.body()` 返回完整 bytes 时不存在越过读取调用的
独立 stream；私有 runtime 若返回 closable stream，Network 只做带上限的单次 `read(size)`，并在
`finally` 中关闭，stream 不进入中性结果或 Provider 合同。

Browser factory、process enter、context/page 创建、导航、页面动作和 body 读取都在可取消 runtime
task 中运行。取消或单次 Browser 操作 timeout 后先发送非占有式 `abort/cancel/stop`；task 必须在显式的
本机 cleanup timeout 内确认停止。这个 timeout 只保护本机 thread/process/file descriptor 回收，
不是 Provider 请求间隔、quota 或可配置的提速值。未及时确认时调用立即失效全部 late result，
升级到 page/context/process close，继续清理其余资源并返回稳定 cleanup failure；daemon worker
不能把晚到 response/download 重新变成候选。被拒绝的 route 只有在 runtime 确认 abort 后才能
立即释放其 host permit；abort 未确认时必须把 permit 保留到 context/process teardown 完成，避免
仍可能存活的 transport 脱离准入边界。

文章目标、通用页面分类和正文/补充材料判别位于 Acquisition，不进入 Network。Network 不解释
Publisher 页面语义，不执行任意 JavaScript、selector guessing、自动登录、机构选择、MFA 或运行时
指纹脚本；它只执行当前 article
control handle 上的六种中性动作：

```text
ClickElement
ClickPoint
ScrollSurface
GoBack
WaitForChange
Stop
```

`ClickElement` 解析当前 revision 的短期 element ID；`ClickPoint` 必须同时匹配当前 article/page/
surface/viewport/screenshot/revision 并在 vendor I/O 前验证坐标范围；`ScrollSurface` 不能越过当前
surface；`GoBack` 不接受任意 URL；`WaitForChange` 只有单次 action timeout；`Stop` 不调用 vendor。
所有实际 click/scroll/wait 使用同一 CloakBrowser humanized executor。Network 不提供 Page、Locator、
selector、CDP、任意 URL/JavaScript、跨 revision/raw coordinate、token 注入、外部 solver、文件系统、
新 Browser/context 或出口/身份切换。文章级 dynamic destination guard 从 exact start、已准入页面
关系和有限 redirect ancestry 收紧通用 Network policy；未知 Provider 只要已有合法文章起点，就使用
同一合同。Agent 每次只提交一个动作，Network 对一次 `apply` 实施合计的单次 timeout；不通过固定
sleep、全局 `networkidle` 或 action 返回的第一帧作结论。

Agent 的 `BrowserStepSession.start()`、模型调用期间页面变化后的 `apply()` 复检和 action 后评价都经过
同一 Observation readiness/settlement gate。可操作 Observation 表示当前主 Page 仍属于该 article session，
Page/frame/surface/screenshot 来自同一 observation generation，且 stable semantic facts 在内部短
quiet window 内一致；它不要求动画、截图像素或无关网络请求停止。明确的 navigation race、
execution context destroyed、frame detach/reattach、旧 Page closed 和 popup/viewer 交接只使当前
snapshot 暂不可用，Network 在 action deadline 内从 article-owned Page 集合重新观察。deadline 到达、
process/context 真正退出、policy、取消或其它非过渡异常才形成 typed failure。

跨出 Network 的 step 结果只有五种。这里的 `Captured` 只会在 Agent 尚未开始作出动作时作为
初始文章结果暴露；一旦 Agent 已经开始探索，后续捕获物不会把 step 变成终态，而是留在本次
`BrowserCaptureBatch` 中，等 controller 以 `Stop`、预算或硬故障结束后由外层 `BrowserClient`
一次性交给 Acquisition。

```text
Ready      stable actionable Observation; the only result that may continue. Pending capture progress is hidden from the Agent
Captured   an initial bounded capture completed before Agent exploration began
Blocked    Agent Stop with a reason
Failed     a stable Network/policy/runtime/controller failure
Cancelled  cancellation won before another stable result crossed the boundary
```

`page_state`（包括 `CHALLENGE`、登录、MFA、拒绝、未授权、未找到和页面失败）只是当前稳定页面
的描述，不会自动映射为 `Blocked`。一次没有语义变化、重复动作或页面短暂不变都是正常的 settled
step；它们不再生成 `no-progress` 终态。Candidate timeout 是 Network 内部的有界等待结果：它会
隐藏候选进度、恢复一个可执行的 `Ready`，并继续保留 pending correlation，等待迟到的 native download
或 Agent 发现其它入口。Agent 只有选择 `Stop`，或遇到预算、取消和真正的 Network/runtime failure
时才离开继续循环；若最终没有 capture，外层 Browser operation 才以 `capture-timeout` 结束。

`BrowserFlowSession.browser_steps(policy, timeout_seconds=...)` 是创建该 session 的唯一跨模块入口；
Acquisition 只能调用 `start/apply`。内部 transition driver、stale、settled、Candidate、quiet fingerprint
和 page successor 不在 `browser_control.__all__`，也不由 Acquisition 编排。每个携带 receipt 的稳定结果
都验证 article 与 revision 顺序。receipt 的 `page_id` 表示实际 dispatch Page；下一 `Ready` 或终态
Observation 可以来自同一 article 中接替它的 popup/viewer/successor Page，因此不强制使用相同
`page_id`。`execution_binding_fingerprint` 与 request-local ledger 在 vendor I/O 前复检；过期动作不会
dispatch，也不会在新页面上自动重放，而是返回新的 `Ready`。

failure 文案必须服从实际发生阶段。vendor dispatch 前的 Observation/action 绑定不匹配才是
`acquisition-browser-agent-action-rejected`；动作已经 dispatch 后或 readiness/settle 期间发生的
规则外顶层跳转仍是 destination-policy failure，返回
`acquisition-browser-policy-failed` 并保留已有 receipt，不能再描述成“Agent 选择了页面外动作”。

正文归属规则同样是本地封闭合同。每条有捕获能力的规则必须声明至少一种文章身份检查：捕获
locator 与 canonical landing 完全一致、捕获 path 含 landing 的精确文件 stem，或捕获 path
包含指定 namespace 的稳定 `Identifier`（例如 DOI、PII、article ID）。规则另外声明已知
supplement URL prefix、supplement selector、supplement filename marker，以及 issue front
matter、广告等 excluded prefix/filename marker；这些字段和正文捕获优先级都进入 fingerprint。
Known supplement selector 不能同时成为 click action。Acquisition 的 capture policy 在读取 body
前只准入满足正文 locator、媒体线索和当前文章身份的资源，或满足下述精确 DOI-PDF 起点 redirect
lineage 例外的 opaque locator；supplement、excluded 和 wrong-article locator 不读取正文。Source 在
形成候选前用当前 article-local policy 重复验收，防止不合规 runner 把补充材料、错文或无 accepted
lineage 的 opaque capture 注入主候选。只有 supplement 或排除项时形成正常 `no-download`，不会误发布。

Browser adapter 提供中性的 `BrowserDestinationGuard`：Controlled Browser
Source 对每篇文章注入一项只含当前规则 origin 与精确 resolver 起点的 guard。Network 在初始
导航、显式导航、redirect/页面请求、popup、response capture 和 download capture 分别标记
用途，并在 DNS、route continuation 或读取响应/下载字节前调用该 guard；传给 guard 的 locator
已经去除 query，规则外异常统一转换为 `policy` 失败。Response 的实际 transport 已由更早的
request guard、DNS binding 和 live host lease 准入，response hook 再在读取 body 前复核同一
lease。通用 URL/DNS/地址类别/host permit/单次资源上限仍独立执行，guard 只能收紧不能放宽。
正文捕获另有不可序列化的 `BrowserCapturePolicy`。Network 把 query-free locator、封闭
`BrowserCaptureKind`、规范媒体类型、direct/redirect-descendant correlation、是否为 request
navigation、是否精确来自本次 start、redirect depth 和 native-download 标志组成中性的
`BrowserCaptureEvidence`；其中不含 DOI/Publisher 解释、vendor object 或持久状态。Acquisition
policy 只返回 `ACCEPT / DEFER / REJECT`：`ACCEPT` 后 Network 才读取 body；`DEFER` 把 response
或 download 保持为 operation-local、未读取、未发布的 Candidate，并在 landing 事实更新或 native
download 到达后用当前 policy 重新判定；`REJECT`、非法返回或 policy 异常均 fail closed。Pending
resource 保存 lease 与 evidence，不保存可过时的最终布尔判断。

部分 Chromium/Playwright response event 只能稳定提供响应元数据，稍后直接调用 `response.body()`
可能已经失去可读正文。为此 Network 支持一个可选、只读的
`BrowserCapturePrefetchPolicy`：request 已通过 Provider guard、URL/DNS/地址、host admission 与
connection binding 后，Acquisition 才能把一项已审核的主文 `GET document|fetch|xhr` 请求标记为可
预取。Network 随即执行同一 route 的 `fetch(max_redirects=0)` 并用该精确 response `fulfill` 原请求，
把未暴露给 Acquisition 的 `APIResponse` 仅作为后续 response event 的私有 body source。未选择或
runtime 不支持该能力时仍使用普通 `continue`；预取不能跳过 response destination guard、媒体类型、
capture policy、字节上限或最终 Acquisition 验收。任何 `206 Partial Content` 都不读取 body、也不
作为完整 PDF 单独捕获，只有完整响应或 native download 才能形成候选。

response 声明 `download_expected=true` 时，Network 分别计算 `RESPONSE` 与 `DOWNLOAD` evidence 的
当前决定，以 `REJECT < DEFER < ACCEPT` 仲裁，同级优先 `DOWNLOAD`。非导航 `fetch` 的 response 决定
更强时直接走 response body；顶层 PDF navigation 即使由 `RESPONSE` 获准也等待 native download，避免
在 external-PDF 模式下对只能观察 metadata、不能读取正文的 response 取 body。两种决定都拒绝时只保留
一次性 pending correlation，以便迟到的 native download 在不读正文的情况下删除；`has_capture_candidate`
会重新询问 policy 并排除该 reservation，因此它不形成 `CANDIDATE`。

成功结果是非空 `BrowserCaptureBatch`，其中
每项只含 `DOWNLOAD`、`RESPONSE`、`POPUP`、`VIEWER` 或 `VERIFIED_LOCATOR`、一个
`BoundedByteStream` 和安全 locator，不含 response/download/page 等 vendor object。同一文章中
相同实际字节即使同时触发 response 与 download 也只交付一次；每项 body 在读取前独立执行单项
字节上限，不累计 capture 数量或整篇总字节预算。通过 exact-start redirect 例外的 accepted evidence
由注入的同一个 Acquisition policy 保持为不可序列化、operation-local 状态；Acquisition 对返回 capture
再次核对精确 locator/kind/media 绑定并重新验证当前 lineage，普通 capture 则重复 Provider
locator/media/identity 分类，然后分别转换为 `TemporaryPdf`。

完成主导航后，`control.ts` / `page-runtime.ts` 为唯一通用 Agent controller 生成不可序列化的
`BrowserObservation`：

```text
BrowserObservation
  article_id / page_id / revision
  surfaces: page | popup | frame | shadow | viewer tree
  query-free origin/path/title
  viewport / scroll / surface bounds
  screenshot: bytes + identity/size metadata
  elements: short element_id + surface_id + role/name/state + bounding box
  page_state
  capture_state
  previous_action_receipt
```

每个 surface、element 和 screenshot 都绑定当前 article/page/revision；上一 action receipt 绑定同一
article 和不晚于当前 Observation 的 revision，但可指向已经被 successor 接替的 dispatch Page。完整
URL query、response/header/body、Page、Locator、selector、context、Cookie 或 vendor object 不跨越边界。截图与 element 文本
分别使用单次 Observation 技术上限，超限形成稳定 snapshot failure，不成为跨 Observation 累计图像
预算。可见元素由通用 snapshot 一次性枚举并绑定短期 ID，不解析 Publisher selector catalog。

三个运行维度正交：

```text
page_state:
  NORMAL | CHALLENGE | LOGIN_REQUIRED | MFA_REQUIRED |
  NOT_ENTITLED | ACCESS_DENIED | NOT_FOUND | FAILED

agent_status:
  RUNNING | STOPPED | FAILED

capture_state:
  NONE | CANDIDATE | CAPTURED
```

`CANDIDATE` 由当前 policy 仍判为 `ACCEPT/DEFER` 的 pending correlation、未决 response/download
或正在执行的 download callback 产生，不是成功 capture。每次观察 Candidate 都重新询问当前
policy，已经成为 `REJECT` 的资源不会继续冒充进展。settle 在首次观察到 Candidate 后使用独立的
单次 capture wait deadline：完整字节在 `ACCEPT` 后返回 `Captured`，关联被明确清除/拒绝后回到
`NONE` 并返回 `Settled`，一直未完成或未收敛则返回仅供 Network 使用的 `CandidateTimeout`。Step
Session 将该 transition 转换为隐藏候选进度的 `Ready`，controller 可以继续探索；controller
最终停止且外层仍无 capture 时才以 `capture-timeout` 报告，Acquisition 再转换为稳定 route failure。
`active_download_callbacks` 只用于表示 capture progress；
page/download/stream 的资源 ownership 由独立集合维护，callback 计数不能代替资源 close。文章清理
先原子阻止新的 callback，等待已经取得 download ownership 的 callback 全部退出，再分别 drain/close
所有 owner，并粘性保留第一次 cleanup failure；不能在 callback 仍运行时清零计数或提前返回业务结果。

Network 不从通用文本猜页面含义；Acquisition 只从中性 Observation 形成通用 `page_state`。裸 403
不能自动成为 Challenge。

受限页面 dependency 只能由已准入顶层页面和当前 frame ancestry 发起，并继续执行 HTTPS、
DNS/地址、CONNECT prebind、host admission、单次 request/frame timeout
和单项字节上限。它不能成为顶层初始导航、popup、PDF locator 或 capture source。Challenge 只由
`page_state=CHALLENGE` 表达，不建立 resource-loading/settling/interaction 状态族、专属 Observation、
interaction target、动作或预算。资源 admitted/blocked 作为 Network receipt/failure 报告；页面脚本
自动清除 Challenge 时，下一 revision 自然回到普通页面。

Agent controller 只消费 `BrowserStepSession` 的稳定 `Ready` Observation。Network 不决定模型策略，
但在 `start/apply` 返回前必须收敛 readiness、页面替换
和 capture。Agent 动作必须绑定当前 revision/surface/screenshot/element，过期、未知、hidden/disabled、
坐标或 scroll 越界在 vendor I/O 前拒绝。实际动作始终复用同一 CloakBrowser humanized article handle，
不创建第二 context、CDP client 或脚本入口。
Entry 文章 scheduler 把 `browser-generic` policy 固定为 `max_concurrency = 1`，并执行文章启动
间隔、可选滑动窗口、完成冷却和失败冷却。Scheduler callback 的边界是一篇完整文章流程，只有 callback
返回（或抛错）后才记录完成/失败冷却并释放组锁；等待取消不会取得或误释放另一流程的 permit。
同一进程同一 group 只能注册一份完全一致的 policy revision，避免通过别名或新 operation
重建限速状态。

同一个 scheduler 也是通用 Browser 动态状态的唯一进程内所有者。基线 policy 显式声明正数
`rate_limit_cooldown` 与 `runtime_failure_threshold`；
operator 收紧时前者只能取更长值，后者只能取更小值。文章 callback 完整返回后，封闭的
`BrowserGroupFeedback` 原子更新对应 group：rate-limit 把 `blocked_until` 至少推进到声明的
cooldown，登录、MFA、IP block 和账号警告打开带封闭原因的 action-required circuit；Agent 明确
Stop 或候选等待超时后保留文章级具体终态，不产生专属 interaction circuit。候选等待超时本身
不会结束 Agent，只有最终无 capture 时外层才形成 `capture-timeout`。重复 self/cycle
不再由当前自主 session 自动制造终态；若模型最终触发 32 次 safety fuse，则报告 controller safety
failure，而不是伪装成页面或 Challenge 失败。
Challenge dependency 被本地策略阻断形成 Network/配置 failure。资源清理未确认或失败
会立即打开 cleanup circuit，不能等待普通 runtime failure 阈值后
让下一篇文章与未确认停止的旧流程重叠；连续 Browser runtime failure 达到声明阈值后打开
runtime circuit。正常成功只清除
连续 runtime failure 计数，不缩短 `next_allowed_at`、`blocked_until`，也不关闭 circuit。

每篇文章在取得本机全局 Browser permit 和调用 callback 之前都重新读取通用 group 状态。仍在
`blocked_until` 内的任务返回 `deferred`，open circuit 返回 `action-required`；这条路径不调用
Browser adapter，因此同批排队任务、新 Literature、不同 route key 或备用入口都不能再次触网。
rate-limit 到期后按 monotonic clock 自动恢复；action-required
circuit 只能由持有精确 group 与 policy revision 的显式 `acknowledge_circuit()` 关闭，且该操作
不清除仍有效的 cooldown。动态 snapshot 仅含稳定 group、revision、时钟截止、连续计数和封闭
原因，并与 scheduler 一起拒绝序列化；不含 URL、selector、Cookie、Token 或文献标识。

生产 Controlled Browser 仍保持 fail closed：Bootstrap 把共享 session broker、scheduler、
admission controller 和 cohort executor 接入完整及 capability-scoped Completion 对象图，并只组装
Agent controller。统一 Observation、六种封闭动作、多路正文
捕获、supplement/错文排除、Provider cooldown/circuit 和确定性取消/资源清理都必须在同一对象图验收。
目标 Browser adapter 应在 TypeScript `apps/server/src/browser/` 与 `network/` 边界内，通过 Playwright API 驱动有头 CloakBrowser patched Chromium persistent context，固定使用 `headless = false` 和 Profile identity manifest 中的 seed/persona。无 GUI Linux 使用受控 Xvfb。CloakBrowser wrapper/binary 的安装包归属、版本和校验以当前 TypeScript package/portable manifest 为准；历史 Python wheel 记法不代表当前产物，也不存在系统 Google Chrome/Playwright Chromium 的生产 fallback。
Profile 的独占 runtime lease 与 Cloak process/context 同生命周期，关闭后释放但不删除 Profile。

Playwright 的 navigation/context/frame/Page replacement 异常必须在 engine thread 内分类，因为原始
vendor exception 不得跨越 CloakBrowser 私有命令队列。明确的可恢复分类转换为不含 payload 的
`BrowserObservationUnavailable`；该类型是 engine command boundary 唯一原样透传的控制信号，供
`BrowserClient` 在当前 article deadline 内重新观察。其它异常正文、vendor 类型和私有状态全部在
该边界内丢弃并转换为通用 payload-free runtime failure。这样既保留页面交接语义，也不把 URL、
selector、页面正文或 vendor 诊断泄漏给 Acquisition、日志或 Report。

第一版使用 native Linux persona，并把 locale、languages、timezone、screen/window、WebGL、字体和
Browser version 作为同一身份快照验收。CloakBrowser `humanize=True` 是所有生产 click、scroll、
wait 和允许输入的唯一执行路径；Agent 和其它调用方都不能用 ElementHandle、直接 DOM click、另一个
CDP client 或任意页面脚本绕过。候选明确使用 `service_workers="block"`：Playwright route 无法保证
观察 Service Worker 接管的请求，而 CONNECT 透传 TLS，不能补证加密流量内的 path、resource type、
frame ancestry 或 capture source。launch flag 与 Profile preference 必须逐项有证据，不能无条件
复制 stock launcher 的历史参数。

每个 CloakBrowser Chromium HTTP(S) request 先被 Playwright route 暂停。`BrowserClient` 在 route 继续前依次执行
Provider destination guard、通用 URL/地址类别检查、DNS 解析、host admission 与单次请求上限，并形成
hostname/port 到精确已批准 IP 的一次连接 binding。`_Route.bind_connection()` 只把该 binding
登记到 loopback proxy，随后 `route.continue_()` 让请求回到 Chromium 原生网络栈。Proxy 对 HTTPS
只接受已登记 authority 的 `CONNECT`，连接指定 IP 后透传加密字节；它不终止 TLS、不读取 HTTPS
header/body、不生成证书，Host authority、TLS SNI、HTTP 协议、Cookie 与连接行为仍由 Chromium
完成。HTTP 也只转发已登记的精确目标。未登记、过期或与当前 article generation 不符的连接
fail closed。

这两个边界提供不同证据：Playwright route 在 transport 前检查 query-free URL、reviewed path、
resource/frame 上下文、文章归属和 capture 用途；CONNECT 只把已经批准的 authority 绑定到已解析
IP/port，并在整个文章生命周期维持 host permit 和字节上限。不能用后一层的 origin 许可替代前一层
的请求语义检查，也不能允许 route 不可见的 Service Worker 流量仅凭 CONNECT 放行。

Chromium 原生处理服务器 redirect、页面脚本导航、popup、Cookie 和点击，因此不需要宿主合成
`3xx`、替换页面或实现另一套 HTTP 客户端。显式导航和 Playwright 暴露的 request 仍逐项进入
route 审查。Chromium 对 native redirect 的后续成员有时不再次触发 route；这时 response 只能复用
仍存活的同页祖先 request proof，且最终 origin 必须已经由当前文章关系准入、完成
DNS prebind，并在读取 terminal body 前取得或复用最终 host permit。跨 page、祖先已结束、redirect
链循环/超过 32 层或未预绑定 origin 一律 correlation failure，且不得读取 body。最终 response
locator 仍重新通过 article destination guard、URL/DNS 与当前 capture policy；未批准的第三方普通子资源可以按
规则丢弃，顶层导航与 PDF capture 仍 fail closed。
Network 只把“本次初始导航精确命中 start”及其 live redirect depth 表达为中性 evidence，不因
同源、媒体类型或 redirect 本身授权正文。最终 opaque locator 是否仍属于当前文章，由 Acquisition
结合本次 article intent、正文/补充材料分类和显式外来标识符检查决定。

Network 的 `ClickElement` 将当前 revision 的短期 element ID 解析到已缓存 Locator，并通过真实
Playwright/CloakBrowser humanized click 执行。`ClickPoint` 只在绑定当前 screenshot/
viewport/surface/revision 后执行。所有点击都设置明确的单次 action timeout，不把后续整段页面导航
隐式塞进 click 调用。Agent 不能填写表单、注入脚本或绕过目标审查；页面 title 与 element
name/state 使用单次受限 snapshot，不把截图字节或页面正文交付日志或业务结果。运行时 URL 可以
保留经过严格 wire-shape 校验的短期签名 query 并交给 Chromium，guard、DNS key、日志、capture
locator、中性结果与 provenance 始终只使用去除 query 的 URL。

Response handler 只在对应 intercepted request correlation 仍存活，且当前文章仍持有 route host
permit；native redirect 到另一批准 host 时还必须先取得该 terminal host permit，之后才读取已准入
PDF body。普通 HTML response 完成分类后可以立即结束单项 request correlation；host permit 不逐
请求释放，而是由整篇文章持有到 page/article context、未决 event、download 和临时资源清理全部确认完成。
这样 Playwright 的单一 engine thread 即使尚未派发第一个 response 事件，也能放行同页第二个已
批准同源子请求；原生 download 则通过 response reservation 保持 request correlation 到 download
event。
Cloak runtime 在取得独占 Profile lease 后原子合并 `always_open_pdf_externally=true` 与
`open_pdf_in_system_reader=false`；只拥有这两个字段，保留其它 Preferences，遇到矛盾值时 fail closed。
该选择会让 v146 把顶层 PDF 交给原生 Browser download/response 事件，而不是内置 viewer；固定身份
验收因此以整套受控 Profile policy 为基线，不把 plugin 数量单独冒充身份结论。普通顶层 inline PDF、
明确 attachment 和页面基于已准入 response 创建的本地 blob download 都只从 Chromium 原生事件有界
读取。各路径复用 transport 前的 request proof，重新执行 query-free capture policy、单项字节上限、
正文归属与确定性清理；SciRetriever 不用宿主 HTTP 客户端重新请求 PDF，也不存在第二个 stock
runtime 合同。

目标策略中，显式 Configuration Browser probe 使用 `navigation_only=False` 与生产 Network/runtime contract：顶层文档、
普通页面资源、redirect，以及由当前页面/frame ancestry 证明用途的受限 dependency 都经过相同
guard。Probe 另装配 deny-all capture policy，任何 PDF/body
候选在读取前拒绝；它可以报告 Challenge dependency admission、统一 page state 和动作 readiness，但只证明 Cloak
runtime、固定身份与目标流程可以运行，不下载文章 PDF，也不证明 Profile 已登录、机构 IP、
challenge 已普遍通过或文章 entitlement。合法最终跳转到已准入 origin 不能被误报为
reachability failure。当前 T01 的正式 Site probe 更窄：只准入所选固定首页的精确顶层
document URL，禁用 JavaScript 与下载，阻断 iframe、页面资源、其它请求及跳转；因此只能
证明该首页文档在选中 Profile 与已验证 runtime 中可达，不能报告 challenge dependency
或脚本驱动的页面 readiness。扩展到目标策略前须有不读取文章 PDF body 的请求级拒绝机制。

普通文章流则使用 `navigation_only=False` 和 `discard_unapproved_subresources=True`。当前已准入
页面的同源 CSS/JavaScript 等资源，以及满足发起页/frame/用途约束的受限 challenge
dependency 可以执行；未批准的第三方 tracker 等非关键子资源在
DNS 前 abort，且不会把整篇文章改写为 policy failure。顶层 navigation、popup、PDF
capture 和 redirect 仍 fail closed。这样既支持需要页面 JavaScript 或点击后异步导航的官方
交付链，又不允许未知第三方扩张网络访问面。

当前 production Browser 只有 `browser:generic`。Acquisition 从已接纳 AssetHint 或 DOI safe resolve
形成精确起点；Network 不导航来源不明的 opaque path。只有总开关、Browser Model、选中的固定
身份 Profile 安全存在、CloakBrowser wrapper/经验证 binary、Playwright API 和 headed display 同时
就绪时，Bootstrap
才创建 Browser client 并将 runtime readiness 设为 true；否则 route 仍可在 Registry/status 中
观测，但 fail closed。生产对象图传入 Configuration 解析出的 Profile handle；status 只评估
selection/presence，不读取内容或判断登录。这个 ready 状态只证明
generic adapter/policy 的离线工程准入，不证明 Browser Profile 已认证、当前 IP、
机构协议或具体文章 entitlement。

Browser Observation 的 `page_state` 只区分 `NORMAL`、`CHALLENGE`、`LOGIN_REQUIRED`、`MFA_REQUIRED`、
`NOT_ENTITLED`、`ACCESS_DENIED`、`NOT_FOUND` 和 `FAILED`；`capture_state` 与 Agent controller 的
`agent_status` 正交。rate limit、IP block、账号警告、Challenge dependency resource blocked 和
runtime/cleanup failure 作为对应 Network/scheduler failure 单独表达。所有状态只驱动本次通用
Browser 的继续、暂停或 circuit，不形成 Literature 状态，也不写入 Catalog、ArtifactStore 或配置文件。

Browser 捕获只产生一个或多个有界 `TemporaryPdf`，不能直接发布当前主 PDF。每项捕获使用
包含文章 flow identity、捕获机制、安全 locator 和实际字节 hash 的稳定 candidate key；同一
flow 的多个不同字节可以依次进入统一验证。下载事件、`.pdf` 后缀和 `Content-Type` 不能替代
Acquisition 的统一字节/reader/页面树与归属检查；supplementary material 也不能成为主 PDF。
Cookie、Profile 路径/内容、登录细节、header、短期签名 URL、selector、页面对象和 Browser vendor
exception 不进入 `PdfCandidate`、Report、SQLite、provenance、status 或日志。

### 2.3 Browser 运行值边界

ADR 0015/0016 的静态 `PublisherAccessProfile` catalog、Cloak identity manifest，以及当前操作的 `PublisherAccessResolution`、`AcquisitionPlan`、`AccessRouteHint`、Browser queue/session health/circuit、内部 Browser 运行对象和单次 Agent call/result 由对应模块拥有。当前中性 WorkbenchObservation/Action、控制绑定和 durable candidate/receipt 已有正式交换合同；它们不能被解释为文献权威事实，也不允许序列化原始页面、Cookie 或截图持久历史。运行对象可以使用模块私有不可变类型在 Entry/Acquisition 边界内协作，但不能被序列化为 Literature、Report 自由 details、Catalog 或 Artifact。Cookie、identity seed、持久 Browser Profile 的路径/内容、签名 locator、页面对象、Agent screenshot/response 始终留在适配边界；runtime process/context、article page、临时下载目录、queue/health/circuit/session 关闭后不得跨操作保留，但 Chromium 管理的 Profile 状态会在 owner-only 目录中跨命令保留，只有用户显式删除才移除。

### 2.4 外部访问与 Browser

所有 HTTP、Provider、MinerU、Agent SDK 和 Browser 的外部访问都由同一个进程内 Network coordinator
执行。每次 DNS、连接、navigation、redirect、popup、response 和 download 都重新做 URL、地址类别、
host、origin、预算和取消检查；TLS 保留原 hostname/SNI。跨 origin 不转发凭据，错误与日志不回显 URL、
query、header、secret、响应正文或底层异常。

Browser Host 使用一个 operator-managed CloakBrowser process/persistent context 和固定 Profile；
同一 Profile 的并发由 lease 防止。`browser:generic` controller 只从稳定、绑定当前文章的 Observation
选择六种封闭动作，迟到 epoch 动作在 vendor dispatch 前拒绝。Browser capture 交给 Acquisition 的
统一 PDF/文章归属门，不能由下载按钮、扩展名、HTTP Content-Type 或 Agent 文本代替。

## 3. 获取准入、调度与进展判断

2026-10-13：Entry 采用有界持续补位，单篇保持五层顺序，完成即时通知；普通补位不改变整次操作代次。Browser 的 worker、保留会话和平台网络资格仍分别结算。传输、Intake、发布与关闭各自记录单调时钟计时及字节，不记录页面 URL 或凭据；分段定义见 [ADR 0030](../decisions/0030-browser-transport-and-progress.md#有界文件与传输保护)。计时不参与成功/失败决定。

### 3.1 Browser admission、会话与调度（目标合同；当前仅部分接线）

Browser admission 在启动任何 Browser runtime 前检查：

- 当前 Literature 的公开/API routes 是否已正常结束，是否仍有 deferred、quota 或系统失败；
- 是否存在已准入的 landing/direct 起点，或唯一 DOI 已经安全解析为 landing；不要求命中已知
  `PublisherAccessProfile`；
- `browser:generic`、`browser-generic` policy、显式总开关、选中的本地 Browser Profile identity
  manifest、CloakBrowser wrapper/binary、Playwright API 与 headed display 是否 ready；
- Browser role 的 image/tool capability 和所选 Model 是否 ready；
- Browser 是否由用户显式启用，以及支持但未配置的 API route 是否按当前 policy 允许继续；
- `browser-generic` 是否处于 cooldown、blocked 或 open circuit。

Admission 汇总剩余论文数、Agent/readiness、runtime 状态、通用政策、最早开始时间和保守最低时长。
它只形成当前操作的允许、延期、action-required 或拒绝结果，不读取 Cookie，也不把完整 URL 或
临时 runtime 信息写入 Report。

相同安全诊断在 Debug 中报告 eligible、admitted、attempted、delivered，以及 `browser-generic` 的
queue wait、pacing、Profile session reuse、Observation/step、capture 分类和 cleanup outcome。完整
URL、DOI、页面文本、截图内容、Profile 路径/内容和 PDF 字节不进入 LogRecord。

所有文章进入同一 `browser-generic` 串行队列，按项目审慎 baseline 执行文章启动间隔、窗口、
完成/失败冷却和 circuit。Operator 只能通过 `[browser].policy_overrides` 收紧这一组，不能按
Publisher 拆组、改名或放宽。`max_concurrency` 是本机资源 cap，不会创建额外 process/context，
也不会绕过通用队列的逐文章串行。

一次 `BrowserArticleAttempt` 的 permit 从第一次文章起点导航前开始，覆盖 Observation、页面动作、
popup、response/download 捕获、TemporaryPdf 转换以及页面、下载和临时文件清理。下一篇和失败重试
都必须等待 `browser-generic` policy；redirect、多个标签页或备用起点不能绕过 permit。页面子资源
不逐个使用“文章间隔”，但继续受 Network host admission、单次请求/导航/动作 timeout 和单项
响应/捕获字节上限约束。

作业进入 Controlled Browser 时只构造 `AgentBrowserController`。它从第一份经过 Network readiness
gate 的可操作 Observation 起构造 Browser role `AgentCall`；每次 Runtime 调用只返回当前 revision
的一个动作。Controller 只取得当前 article 的 `BrowserFlowSession`，不取得 process、persistent
context、Profile、Cookie、selector/locator 或 download vendor object。Agent 的公共动作精确为：

```text
ClickElement
ClickPoint
ScrollSurface
GoBack
WaitForChange
Stop
```

`ClickElement` 绑定当前 revision 的短期 element ID。`ClickPoint` 绑定当前 article/page/surface/viewport/screenshot/revision，用于 closed Shadow DOM、canvas、图片控件或 Challenge 等只能从当前截图定位的可见目标；Network 在执行前验证 revision、surface、viewport 与坐标范围。`GoBack` 不接受 URL，`WaitForChange` 只使用单次 action timeout，`Stop` 不调用 Browser vendor API。Agent 不获得任意 URL、JavaScript、selector、跨 revision/raw coordinate、键盘文本、文件上传、Cookie、Profile、CDP、文件系统或创建额外 Browser/context 的能力。

以下保留接入 DSH 前单次动作决定的历史示意；旧 controller 不保存完整模型 Session。当前文章预算、
worker、节奏与下载暂停以本篇当前文章流程及 ADR 0023/0030 为准，不由该简化循环穷尽。
当前 DSH 对话与工具执行的接线见 §2.2.1，下面只用于理解原 article-local `BrowserStepSession` 的执行边界：

```text
step = steps.start()
while step is Ready:
    action = decide(step.observation)
    step = steps.apply(action)
```

历史示意中每次 `Ready` 都重建独立 `AgentCall`；当前会话复用工具历史，但仍对每份观察至多接纳一次 `apply`。安全绑定与机械无进展判断
使用两类不可互换的 fingerprint：

```text
execution_binding_fingerprint(observation)              # exact stale safety
stable_semantic_page_fingerprint(observation)            # article-local state
stable_action_intent_fingerprint(action, observation)    # article-local intent
```

exact fingerprint 包含当前 revision/短期对象绑定；模型调用期间页面变化时，`apply` 在 vendor I/O 前
重新收敛当前页面并返回新的 `Ready`，不会把旧动作重放到新页面。stable fingerprint 排除 revision、
screenshot/element/surface 短期 ID 与无意义 geometry 抖动，只用于判断观察是否已经稳定和记录
`semantic_changed`，不再用于把重复动作或 self edge 自动升级为 `Blocked`。页面没有变化时仍可继续
让 Agent 决定下一步；candidate timeout 只是 Network 的内部等待结果，会隐藏 pending 状态并恢复
可继续的 `Ready`。只有显式 `Stop`、取消、controller safety fuse 或硬故障结束会话。

`_GenericStepPolicy` 由 Acquisition 拥有，只把中性 Observation 分类为通用 page state，并绑定
当前 article capture policy；`_GenericStepSessionFactory` 把它交给 `session.browser_steps(...)`。
Acquisition 不取得 transition driver，也不调用 `observe / settle / execute`。Network 在 `start/apply`
内部完成页面 readiness、分类后的 ledger 同步、page/frame/popup/viewer replacement、Candidate/capture、
timeout 和 cancellation；相同 stale 状态有界失败，不能忙循环。Agent 因此只会看到满足 Network
稳定性和通用页面分类的 Observation。

跨层结果只有 `Ready / Captured / Blocked / Failed / Cancelled`。`Ready` 是唯一可继续结果；
`CANDIDATE`、stale、quiet fingerprint 和 vendor transition 都只存在于 Network。`Captured` 仅表示
Agent 尚未开始探索时已有一项有界捕获；Agent 已开始探索后，materialized capture 从 Observation
中隐藏，但保留在 Browser 的外层 `BrowserCaptureBatch`。`Blocked` 的 payload-free reason 由 Agent
`Stop` 提供；candidate timeout 不跨越 StepSession 边界，系统、policy、runtime 和 controller safety 是 `Failed`，
用户取消是 `Cancelled`。`BrowserAgentResult` 只保存这一项终态以及 action/model count 和 last
action，不重复保存业务验收结论。不可配置的 32 次 model-decision safety fuse 防止实现缺陷无限运行；
触发时形成 non-retryable `controller-safety-limit`，不能写成正常未命中或自动获取耗尽。

2026-10-12 的模型工具仅提供两类主动 Stop：`access-unavailable`、`no-viable-path`，均要求
`explanation` 简述尝试与障碍。中性 `BrowserAction` 兼容已有 operator 的 `user/budget/cancel`，
生产模型 schema 不提供这三个运行控制选项。Driver 保留新原因，经 `browser-agent-*` 失败码与脱敏
说明交付 Entry；若已有较早来源错误，最终报告仍显示这项明确的 Agent 判断，不写全渠道耗尽事实。
此变化不增加模型请求、停止评审器或出版社页面规则，具体停止与继续条件见 ADR 0023 §3。

route 只把这一项稳定终态映射为 Acquisition evidence，而不重建第二套状态机：完整 capture batch 先
进入既有 PDF candidate 验收；没有可接纳 capture 时保留取消与具体 Network/Agent failure；只有没有
更强证据时才形成普通 `no-download`。Challenge、登录、MFA、拒绝和未找到只是交给 Agent 的页面
描述，Agent 明确 Stop 后才按 stop reason 形成对应稳定结果。Network 已有关联但未收敛的 capture
会在控制层返回隐藏候选进度的 `Ready`，让 Agent 继续寻找入口；只有 Agent 最终停止且外层仍无
capture 时才返回 `capture-timeout`，Source 再转换为
`acquisition-browser-candidate-timeout`；该失败比更早 Public/API route failure 更接近实际交付点。
如果动作已经 dispatch、Network 只因 successor Page 的统一 snapshot 暂时失败，Network 会在 action
deadline 内重新观察；只有真正超时或不可恢复故障才返回 generic `acquisition-browser-agent-action-failed`。
该处理不适用于 destination policy、取消、timeout、Candidate/capture、Stop、cleanup 或其它具体
Network 终态。

当前 Browser 事件形成非空、按实际字节 hash 去重的中性候选批次；每项分别服从单项字节上限，
不设置整篇累计候选数量或总字节预算。
捕获机制封闭为 download event、普通 PDF response 和 popup response。每项 Browser action 在导航前
构造不可序列化的 article-local capture intent；
Network 只提供 query-free locator、kind/media、direct 或 redirect-descendant correlation、exact
start、navigation、redirect depth 和 native-download 等中性 `BrowserCaptureEvidence`，Acquisition
的 `_GenericCapturePolicy` 才解释当前 article goal、identifiers 与 landing 事实。

Policy 返回 `ACCEPT / DEFER / REJECT`。`ACCEPT` 后 Network 才读取 response/download body；
`DEFER` 只保留 operation-local、未读取、未发布的 Candidate，并在 landing 绑定或 native download
到达后按当前事实重新判定；`REJECT` 立即丢弃。Pending resource 不缓存最终布尔许可。只有受控
direct start 或当前文章关联证据充分的候选才 `ACCEPT`；supplement、显式冲突 DOI 和 wrong article
直接 `REJECT`，身份事实尚可能补齐时才 `DEFER`。

同一个 article-local policy 还实现可选 prefetch 判定，但它只为 `GET` 且资源类型为
`document|fetch|xhr`、并已按当前 goal/start/identifiers 明确分类为 `PRIMARY` 的 response 请求返回
true。这只允许 Network 在正常 response event 前保留稳定的 Playwright body source，不等于
`ACCEPT`：实际 status/media/evidence 仍必须再次通过 capture policy，`206` partial response 不形成
主文候选。

精确 direct-PDF 起点的 opaque redirect 只在以下条件同时成立时接纳：起点来自本篇已接纳的
AssetHint，最终 response/download 是该 navigation 的 live redirect descendant，Network
destination/origin/DNS/host 已准入，且最终 locator 没有显式携带另一 DOI。普通 landing、同源
PDF 或单独的媒体类型不能借此
放宽文章归属。通过该例外的 evidence 只保存在同一个 article-local policy 中，不进入可序列化的
`BrowserCaptureBatch`；Source 在形成候选前要求返回 capture 的 locator、kind 与 media type 精确匹配
一项 accepted evidence，并按当前 article goal 重新验证原 lineage。普通 capture 仍再次执行
locator/media/identity 分类；没有 accepted evidence 的同源 opaque locator 或与 evidence 不一致的
capture 继续拒绝。只有 `application/pdf` 或受控 locator 返回的 `application/octet-stream` 可以通过；`.pdf` 后缀、
媒体声明和 Browser 事件本身都不证明字节有效。每项不同捕获分别形成 `TemporaryPdf` 和稳定 candidate
key，随后仍依次经过统一 PDF reader、页面树、hash 和不可变发布；任何捕获都不能从 Browser 直接写成
主资产。

每项 capture 在形成 `TemporaryPdf` 时必须附带 `BrowserPdfAssociationEvidence`。统一
`pdf_identity` validator 从 PDF 可提取文本、安全 locator 和起点 lineage 比较目标 DOI、标题与
作者；受控 direct-PDF 起点可作为强关联证据，冲突 DOI、supplement/appendix、错文和总证据不足
直接拒绝。多个候选保持事件顺序并逐项进入字节门和文章归属门；媒体类型、文件名和 Agent 判断
都不能越过最终验收。

当前 `TieredCohortExecutor` 只把 Browser admission 明确允许的最小剩余 item 转为
`BrowserArticleAttempt`，并从 `browser-generic` snapshot 取得 policy 与所选 Profile session key。
Scheduler callback 覆盖整个 route adapter 调用，因此 Network Browser 的 page/download/临时
目录清理已经完成后才会释放组内文章 permit；route 的 deferred、action-required、失败、取消
或异常均按失败完成处理并保留适用冷却。所有 Browser item 保持冻结输入顺序；缺少 scheduler 的
admitted route 会稳定失败。

`max_concurrency` 默认 `5`，必须是严格整数且大于 `1`，不设上限；它只保护本机执行资源。所有
文章共享一个 CloakBrowser Chromium process/persistent context，较大的 cap 不会启动多个 Browser，
也不改变 `browser-generic` 固定 `concurrency = 1` 的政策。

Scheduler 同时拥有 `browser-generic` 的进程内 `blocked_until`、连续 runtime failure 计数和封闭 circuit
reason。Cohort 把 Browser route 的稳定终态转换成封闭 `BrowserGroupFeedback`，只有完整 route
callback 和资源清理结束后才原子更新 group。rate-limit 推进声明的 cooldown；登录、MFA、
IP block、账号警告或达到阈值的 runtime failure 打开相应 circuit；Agent 明确 Stop 或 Candidate
timeout 时保留当前文章的具体结果，不制造 interaction 状态族。重复 self/cycle 不再自动形成
failure；若达到 32 次 safety fuse，则形成 controller safety failure。Challenge resource 被本地策略阻断形成独立的 resource-blocked failure，不能
冒充页面拒绝或 Agent 已经尝试 Challenge；cleanup failure
不等待 runtime 阈值，立即打开通用 cleanup circuit。每个排队任务在
Browser callback 前再次检查该状态，所以同一批中的后续 Literature、下一次 cohort、不同
route key 和备用入口均不能绕过。被动态状态拦截的 item 分别形成稳定
`deferred` 或 `action-required`，不会被写成 exhaustion。

Browser route 的 article context/page/popup/download/response stream、文章临时目录、Network
permit 和 scheduler task 使用一次性所有权与粘性 cleanup 结果；共享 process/context/Profile
lease 由 Browser broker/runtime 独立拥有，单篇文章不能关闭仍服务其它 lane 的共享资源。取消或
timeout 后未在本机 cleanup timeout 内确认停止的 runtime 不交付晚到候选；即使此前已经捕获 PDF，也转换
为 cleanup 系统失败，请求在其它活动 lane 排空后淘汰共享 runtime，并阻断同组后续任务。这个
本机单次 cleanup timeout 不属于 Provider policy，不能用来缩短文章间隔。
共享 runtime 意外退出时，关闭命令可能与实际 context 关闭竞争。只有已经观察到
context 的关闭事件，才可以用这个终态结算竞态中失败的关闭命令；单独的 CDP
断线或错误文本不证明 native writer 已经停止。尚未确认关闭的错误保留异常链并继续
作为 cleanup failure；已确认的关闭不会覆盖原始 runtime-lost 原因。
如果不可变资产与 catalog 关系已经成功提交，之后 receipt/staging cleanup 失败仍必须传播稳定
系统失败，但不得删除、覆盖或回滚已经发布的资产和关系，也不得转而提交自动获取耗尽。

当前 TypeScript 的 Acquisition failure classifier 与 Entry PDF adapter 在取消竞争中保留
已经识别的 Storage/receipt 错误：停止信号不会把这些失败改写为普通 `cancelled`。
这条优先级贯穿 locator、Browser delivery 与 completion Report；原始取消异常和普通被取消的
I/O 仍进入中断分区，已经提交的事实保留。

Admission 在下一次评估时把同一 scheduler 的动态 snapshot 与通用 Browser route、本地 Browser
Profile presence/runtime readiness 合并，摘要显示 `rate-limited` 或具体 action-required reason
以及剩余最早开始时间。rate-limit
只在 monotonic `blocked_until` 到期后自动恢复；circuit 不因连续成功自动关闭，只能以精确
group 和 policy revision 显式确认。确认不会清空仍有效的 cooldown。动态 snapshot、scheduler
和有序执行结果均不可序列化，且不携带 URL、selector、Cookie、Token、Literature 或 route
locator。

Network 已提供使用所选 Profile identity 的 process-local session broker：一个 operator-managed
固定身份 Profile 只启动一个有头 CloakBrowser Chromium process/persistent context；每篇文章仍拥有
独立 article token、page、下载临时
目录、单项字节上限、连接绑定和结果。runtime/清理失败只在其它活动 lane 排空后淘汰共享 runtime。
Broker 关闭或进程退出后删除临时下载目录、释放 Profile lease，但保留 Profile 中 Chromium 管理的
Cookie/认证状态。Bootstrap 已把同一个 broker 与 scheduler、admission、cohort executor 注入
Acquisition 运行对象图。总开关关闭、Browser Model/Profile 缺失或 runtime 未就绪时不构造可执行
client。自动流程只使用当前
机器正常网络出口和所选固定身份 Profile，固定以 `headless = false` 启动 CloakBrowser patched Chromium；无 GUI Linux
由 Xvfb 提供完整窗口栈，但不开放用户可见 Browser 认证流程。自动流程不填写登录表单、
不选择机构、不读取 Cookie/登录结果，也不处理 MFA；这些身份页面形成 action-required 并暂停对应
group。Challenge 页面不是身份登录流程；Agent controller 通过统一页面合同处理，Agent
可以使用当前 revision 的 element 或 screenshot-bound point，不取得专属 Challenge target。

Browser 运行事实使用三个正交维度，不再建立 `BrowserRunStateMachine` 或 Challenge 子生命周期：

```text
page_state:
  NORMAL | CHALLENGE | LOGIN_REQUIRED | MFA_REQUIRED |
  NOT_ENTITLED | ACCESS_DENIED | NOT_FOUND | FAILED

agent_status:
  RUNNING | STOPPED | FAILED

capture_state:
  NONE | CANDIDATE | CAPTURED
```

`page_state=CHALLENGE` 本身不是默认终态；页面脚本自动清除或 controller 动作清除后，下一 Observation
自然返回普通页面。`LOGIN_REQUIRED`、`MFA_REQUIRED`、`NOT_ENTITLED`、`ACCESS_DENIED`、`NOT_FOUND`
和 `FAILED` 都只是给 Agent 的稳定页面描述，不能由 Network 或 Publisher policy 自动升级为终态；
只有 Agent 明确 Stop，或之后发生独立的 timeout、cancel、controller safety、runtime/cleanup failure
时才形成对应 route 结果。rate limit、IP block、账号警告、Network resource blocked 和
runtime/cleanup failure 仍由相应 route/scheduler failure 表达，不挤进 page state。
文章资源清理或 runtime failure 可以让已经捕获的候选失效，因为完整文章事务关闭前不能把字节视为
安全交付。

Observation、动作 receipt、语义转换记录和 controller status 只存在于当前进程内存，可以转换为
安全日志和本次操作的稳定 `normal-miss`、`deferred`、`action-required` 或 failure；它们不进入
Literature Model、Catalog、数据库表、Artifact、provenance 或跨运行失败历史。risk-group 信号由当前
进程 scheduler 更新 `blocked_until` 与 circuit；独立 API/Metadata scope 仍按各自政策继续。自动策略只能减速或暂停，
不能根据连续成功自动提速或自动关闭 action-required circuit。

页面分类只消费 Network 提供的统一 `BrowserObservation`。Observation 包含 article/page identity、
单调 revision、page/popup/frame/Shadow/viewer surface tree、query-free origin/path/title、viewport/scroll/
surface bounds、当前 screenshot、安全可见 element、page state、capture state 与上一动作 receipt；
不含 response、HTML、header、Cookie、selector 或 vendor object。通用分类只使用这些中性状态；
不会加载 Publisher marker 或 selector catalog。登录、MFA、无 entitlement、拒绝、404 与 Challenge
通过 Observation 的封闭 `page_state` 表达；裸 HTTP `403` 仍只表示 `ACCESS_DENIED`。

当前文章的动态 destination guard 必须在每次 navigation、popup、response 和 download 实际访问前
执行，并叠加 Network 的通用 URL、DNS、redirect、origin、credential forwarding 和 host admission。
它从 exact start、当前已准入 page/request 关联和有限 redirect ancestry 扩展，不从 Publisher catalog
取得任意 origin。supplement/appendix/supporting information 在 Acquisition PDF 文章归属门排除。
签名 query 只保留在当前 Browser operation 并交给 Chrome，日志、结果、provenance 和持久事实只
接收 query-free locator。未知 Provider 只要有合法文章起点，也可使用同一通用 Browser 路线。

## 4. 观察、指导与控制权交接

### 4.1 观察协议

观察视图需要把文章执行、Browser 页面与材料交付分开：

| 视图信息  | 绑定与含义                                                      |
| --------- | --------------------------------------------------------------- |
| 当前目标  | operation/目标 Literature/文章执行标识                          |
| 页面      | session/page、document generation、脱敏 URL/标题                |
| 观察      | revision、截图/元素、产生时间或序号                             |
| 控制      | controller、control epoch、暂停/等待状态                        |
| 动作      | 受理/执行/结果、绑定观察、取消与过期原因                        |
| 候选      | captured/staged/validated/durable-ready/accepted 等真实交付阶段 |
| 失败/帮助 | 当前阻碍、可做的动作、是否仍有在途工作                          |

页面存在、下载已开始、候选已捕获与资产已接纳是不同事实。下载事件后还需复制/验收/发布；UI 不能立刻显示“论文已获得”。图片/帧由受控接口读取，不暴露 Page/CDP 或内部 Profile。

观察可有多个消费者，动作控制者同时只有一个。慢消费者可丢弃旧帧并取得最新完整观察，但关键状态变化需有序号及断档反馈；不能在错过目标切换后仍把上一篇画面标成当前文章。

实时观察不等于永久录像。默认保留有界会话内时间线；长期截图、完整指导记录、回放与容量政策是另行决定的能力。日志不能代替面向用户的执行反馈。

### 4.2 控制身份与动作前置条件

当前 `BrowserControlCoordinator` 持有 workspace、已连接 client、controller 和 epoch。attach/detach、takeover/release 在服务端更新状态；控制者断开或交还使旧 epoch 失效。带当前 epoch 的显式人类接管可以转移旧控制权；同一旧 epoch 的后到请求拒绝。`WorkbenchSession` 绑定目标和页面观察；生产 bridge 在文章开页时把同一 Host page 挂到会话，新操作使用新的 session ID，旧观察和指导不跨文章复用。

目标设计的中性绑定如下，具体字段名按实际控制协议定稿：

```ts
interface ControlBinding {
  readonly workspace_id: string;
  readonly session_id: string;
  readonly operation_id: string;
  readonly article_id: string;
  readonly controller_id: string;
  readonly control_epoch: number;
  readonly page_id: string;
  readonly document_generation: number;
  readonly observation_revision: number;
}
```

动作在接收与实际 vendor dispatch 前都复核必要绑定。某些只读观察请求无需控制租约，但点击、输入或导航不能借只读连接执行。页面 revision、文章 generation 和 control epoch 分别防止旧画面、跨文章与旧控制者的动作，不互相代用。

### 4.3 暂停、接管与交还

| 请求     | 服务端要做的事                         | 返回条件                    |
| -------- | -------------------------------------- | --------------------------- |
| 暂停     | 停止派发新的 AI 决定，结算在途动作     | 明确 paused 或仍在 draining |
| 接管     | 更新控制者/epoch，使旧 AI 决定失效     | 返回新的控制绑定            |
| 人工动作 | 按当前绑定执行封闭 OperatorInput       | 实际成功/失败及新观察       |
| 交还     | 释放人类租约，AI 重新观察页面          | 不复用接管前缓存决定        |
| 取消     | 停止该操作新增工作，结算 transfer/提交 | 实际已接纳事实和未完成项    |

在途点击可能已触发下载，暂停不能虚称该动作从未发生。下载交付仍按原文章绑定验收；如果控制切换使目标不再可信，保留稳定冲突/拒绝结果，不自动接纳到下一篇。

交还后 controller 从最新页面、当前文章和最新指导重新决定。旧模型响应即使随后返回也不能执行。关闭 session 禁止新动作，再结束观察流、排空/终止页面工作，最后由 owner 关闭资源；关闭失败必须反馈，不以 UI 消失当作释放成功。

### 4.4 自然语言指导

自然语言指导是业务协作消息，如“补充材料在页面下方”；它不同于向网页输入框发送 `type-text`。指导不直接变成脚本或任意浏览器动作。

建议请求包含 guidance_id、文章/流程绑定、期望控制状态、文字与适用范围；结果至少区分：

| 结果      | 含义                                    |
| --------- | --------------------------------------- |
| accepted  | 已接受等待安全决策点，不表示已执行      |
| consumed  | 已在明确观察/决定处消费，可显示结果关联 |
| rejected  | 内容/权限/当前模式不支持                |
| expired   | 文章、流程或控制状态已变化，未使用      |
| cancelled | 调用方撤回尚未消费指导                  |

当前指导队列限 16 条待消费、会话内最多 64 条状态记录，每条至多 2048 个 UTF-16 码元（与 Web `maxlength` 和 JavaScript `string.length` 一致，不是 UTF-8 字节），绑定 session、文章与期望 control epoch。下一次生产模型观察时将 accepted 改成 consumed 并作为不可信建议加入输入；控制接管、目标切换或关闭把尚未消费的指导改成 expired；提交者可撤回为 cancelled。重复 guidance_id 同内容幂等，异内容冲突；不持久化、不跨重启恢复。现有页面低层 `type-text` 不充当自然语言指导。

指导可以影响下一次模型决定，但不能取消 Network 地址政策、PDF 文章归属检查或凭据隔离。人类看到的页面文字和指导输入同样是不可信内容，controller 只能输出封闭动作。

### 4.5 断线、多观察者与介入等待

当前生产政策：观察者断开不改变操作；控制者断开撤销租约并暂停新模型动作，等待新连接显式接管并交还，或操作截止/取消。没有后台 daemon 或跨重启回放。生产文章的 120 秒硬截止从准入页面打开后、协作挂接前起算；页面步骤和人工等待共用该截止，一次等待最多取 `min(5 分钟, 文章剩余时间)`。先行的 Public/API 阶段不计入这只文章时钟，但同属可取消的显式补全操作。取消/关闭立即唤醒。模型请求若在接管后才返回，其决定不派发；已经派发的动作与捕获仍按真实结果结算。

ADR 0032 的 10-15 定稿原型将用户主动关闭观看界面时交还 Agent 作为目标体验，服务端交还确认及失败处理仍待落实。主动交还、正常关闭、切换文章与意外断线须分别设计和验证，不从关闭回调推导交还成功或断线自动恢复；在此之前继续使用上述生产政策。可选人工介入不允许把等待超时、Browser 失败或取消记录成自动获取正常耗尽。

多个人同时接管时以服务端版本化结果为准，失败客户端重新读取控制状态；不能靠最后渲染页面的按钮决定赢家。过期命令返回 conflict/stale 而不是静默忽略，让用户知道动作没有生效。

帮助请求和介入等待只用于明确启用的协作策略或用户主动介入，不是普通自动获取失败后的默认阶段。需要显示目标、阻碍和可行人工动作时，具体等待时限、持久化和恢复仍遵循 Application/Jobs 合同，不从现有 intervention 表推导所有行为已实现，也不因界面调整静默删除这些能力。

登录、机构选择、MFA、验证码等允许的人类操作范围仍需独立确认。它们不自动授权 AI 获取凭据、读取 Profile 或绕过访问控制。

### 4.6 查询隔离与人类控制衔接

独立 QueryApplication 不组装 Network Provider、Browser host 或 AgentRuntime。库内读取可访问 Storage 与本地索引；缺 PDF、缺表示或索引失效返回缺口，不隐式启动网络。配置状态的读取也不是 probe，只有明确配置测试操作才使用本节的外部 transport。

Human Interaction 观看的是生产 Browser 的同一观察源。`BrowserControlCoordinator` 维护 workspace、client、controller 和递增 epoch；接管/交还/断开控制者改变 epoch，陈旧输入在执行前拒绝。页面导航还改变 document generation 与 observation revision，坐标/元素动作必须绑定对应观察，不能复用旧截图的点击位置。

当前已有控制租约、动作派发、自然语言指导队列与文章级安全消费点，同一生产工作台经 `Application` 的文章 flow 接入。自然语言“试试右侧下载按钮”不等于授予任意导航或脚本权限，人工动作仍走 Network 和 Acquisition 验收。生产 `WorkbenchView.operation_feedback` 只投影本次内存操作的阶段、冻结后的目标计数与当前目标、最终 `DatabaseCompletionReport`、稳定失败和操作结束后通过 Library 校验文件字节的主 PDF hash/大小；旧合成视图不带该字段。文件缺失或损坏时标记 `unreadable`，不生成阅读引用；原始异常只在进程内保留，公开反馈使用稳定分类。Browser Intake 的候选评估结果进入同一会话候选列表，但已捕获或身份检查通过均不代表主 PDF 已提交；失败、取消和结束后，未提交候选不再显示“等待提交”。页面以完整报告分区显示已完成、失败、跳过、未开始和中断；无法观测 Public/API 等候时只说明执行中，不猜操作总耗时。Library 阅读按钮指向已确认的当前 Literature ID，阅读和刷新不启动维护操作。

凭据的普通参数与授权时效也须分开：Application 固定本次 provider/model/访问政策，每次新的外部请求重新向 Configuration 授权当前密钥。撤销后的新请求失败，不凭内存旧 key 继续访问；已经派发的 HTTP 或浏览器动作只能如实结算。Browser Profile 的现存登录态不等同于普通 Provider API key，其授权与人类可做的登录操作范围需独立定义。

## 5. 人工协作与运行边界验证

### 5.1 一次人工协作示例

用户明确启动某篇 PDF 获取。公开/API 路线未交付后，符合准入条件的 Browser 打开真实文章页面。用户观看同一会话，发现下载入口特殊，提交指导；界面先显示 accepted，controller 在下一安全点消费并记录 consumed。

若仍失败，用户接管。旧 AI 响应因为 epoch 变化失效，人工点击触发候选下载。Acquisition 检查 PDF 字节、目标归属和版本；候选显示真实捕获及身份状态，操作完成后由 Library 回读确认当前主 PDF 已提交。即使人类已经交还，候选仍按原文章绑定处理；若后续失败或取消，已提交 PDF 仍可从 Library 阅读。

用户随后进入阅读页打开该 PDF。此时不自动解析或总结；用户明确发起加工后，新的 Document/Knowledge 版本可供 Agent 和人类共同读取。

### 5.2 验证设计

离线验证覆盖实际 HTTP/Web 边界、配置 revision 冲突、保存成功但状态失败、来源排序/scan limit、只读页面无维护入口、control epoch 争抢、过期观察、在途动作、跨文章候选、断线和重复关闭。

完整目标旅程必须接同一个生产 Browser owner，证明“获取 → 观看 → 指导/接管 → 交还 → 验收 → 共同读取”。固定 Cloak bundle + loopback 测试已覆盖 HTTP 明确获取、两个观看者、指导受理与过期、旧模型返回失效、人工点击、同一 Acquisition 验收、最终报告和 Web/Agent 对同一 PDF hash 的读取；真实 Publisher 站点未运行。一次合成页面上的 runAgent 成功不能代替该旅程。

阅读验证使用固定版本的合成文档和知识产物，检查证据指向、截断/缺口、Markdown 安全渲染与损坏反馈。当前指导和断线政策只适用于进程内操作；跨重启指导历史、允许人工认证动作和最终界面形态仍需独立决定，不能从 T02 实现推断已授权。
