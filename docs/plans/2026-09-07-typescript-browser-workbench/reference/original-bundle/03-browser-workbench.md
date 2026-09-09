# 03｜新的浏览器工作区：投屏、通用动作与人工接管

本章定义拟实现的行为；现有六动作控制器与 Network-owned settlement 不作为新运行时的内部模板。保留其安全目的与有价值的回归测试。[R07](10-sources.md#r07)[R14](10-sources.md#r14)

## 1. 连接形态

```text
用户浏览器中的 SciRetriever 工作台
    │ 同一个 HTTP 入口：静态页面、业务 API、认证后的 WebSocket
    ▼
Node 主服务（任务、权限、控制权、事件分发）
    │ 私有 IPC
    ▼
Browser Host 子进程（唯一 Playwright 对象所有者）
    ├─ Chromium / Profile / 页面与标签页
    ├─ Action Executor / Observation Builder
    ├─ Screencast Publisher
    └─ Artifact Collector
```

首发仅面向单操作者、自托管环境。多个观看连接可以只读；一个 workspace 同时只能有一个键鼠控制者。多用户权限、多人协同桌面、任意远程 CDP 不是首发需求。

建议新增 `sciretriever serve --host 127.0.0.1 --port 8000`；这是目标命令，不是现有命令。静态资源预构建后随包分发。API、事件、画面可以使用不同路径，但共享一个端口。远程访问使用 SSH 转发或配置了认证/TLS 的反向代理，不开放裸 VNC/CDP 端口。

本地监听仍需认证、Origin/Host 检查和跨站请求保护：被自动浏览的外部网页不能借用户浏览器或 Chromium 去调用本机工作台。访问 Network 对 loopback 的限制不能由“主服务恰好也在 localhost”而失效。

## 2. Workspace、Profile 与页面所有权

`workspaceId` 表示可旁观、可接管的工作现场，不是某篇文献。每个 workspace 在运行时绑定一个 Browser Host 和一个独占 Profile。首发同一 workspace 串行处理文献任务，一个任务可使用多个标签页。

Profile 在任务之间保留；任务结束只释放文章 lease，不关闭整个浏览器。退出服务时先关闭任务调度，等待已接收文件落盘，再关闭 context、浏览器与显示资源。浏览器崩溃后 Profile 可能保留，但 DOM、页面句柄和未完成动作不视为已恢复。

新页面立即分配 `pageId`，记录 opener、创建时的任务/attempt、document generation。页面切换不改变已发生请求或下载的历史归属。人工任意打开的新页若不能确定关联，标为未绑定，不默认为当前文献的 PDF。

Profile 不得由两个进程同时写。迁移/升级前关闭浏览器再备份；跨平台 Cookie 解密、账号登录状态和新版 Chromium Profile 向旧版回退均需要单独验证，不能由 SQLite 兼容性替代。[R09](10-sources.md#r09)

## 3. 页面画面，而不是远程桌面

首选经验证的 Playwright `page.screencast`。官方接口从 1.59 提供 JPEG 帧和视口信息；当前项目的 1.55.0 必须先升级或选择经测试的适配路径。[R05](10-sources.md#r05)[W02](10-sources.md#w02)

实现 `ScreenSource` 小接口，把所选 API 封装在 Browser Host 内。若必须用 Chromium CDP `Page.startScreencast`，按其 ACK 协议实现并固定版本；该接口属于实验性协议，不暴露给前端，也不在生产中无日志地来回切换。[W06](10-sources.md#w06)

每帧附带 `workspaceId/pageId/frameId/capturedAt/viewportWidth/viewportHeight`，另由运行时关联 document generation。JPEG 以二进制发送，不把持续视频转换为 JSON base64 后写日志或数据库。此处的 frameId 是本项目的递增标识，不宣称是浏览器原生事件 ID。

帧分发器要求：每个观看者最多保留最新待发帧，慢客户端丢旧帧而非阻塞浏览器；编码、WS buffered bytes、帧尺寸、连接数都有上限。无人观看时停掉额外投屏，不影响 Agent 按需截图。观看连接断开不停止任务或下载。

界面自行提供标签页列表、地址显示、前进后退、任务摘要和下载进度。网页流不包含 Chrome 原生标签栏和全部系统窗口。文件选择、JavaScript dialog、权限提示等经事件转为受控 UI；不支持的系统交互明确报告能力限制。鼠标高亮尽量画在工作台本地覆盖层，不向出版社页面插入装饰脚本。

## 4. 人工输入

前端发送输入意图，服务端验证 lease 后由同一 Action Executor 调用 Playwright。不能让前端直接访问 CDP、服务器 Shell 或任意文件路径。

画面缩放采用实际图像的内容矩形映射。例如显示宽度为 `renderedWidth`，远程视口宽度为 `viewportWidth`，点击横坐标为：

```text
x_remote = (x_pointer - image_content_left) / renderedWidth * viewportWidth
```

垂直方向同理。必须处理 object-fit 留白、浏览器缩放、设备像素比和窗口 resize；不能把画面编码像素直接当 CSS 坐标。点击留白不发送操作。若 page/document 已切换，拒绝旧画面的坐标输入。

文字与按键分开：普通文本、粘贴和中文 IME 使用 composition 提交后的文本；物理按键处理 keydown/keyup/修饰键；不能同时按逐键和 composition 重复输入。接管、断线、焦点丢失时释放被按下的按键和鼠标按钮。

剪贴板按显式粘贴发送，不自动同步系统剪贴板。文件上传默认禁用；允许时只使用工作台显式选中的输入文件，不能把路径字符串交给 Agent 任意读取服务器文件。

## 5. 通用 Agent 动作

第一版完整动作集：

| 类别 | 拟提供动作 | 边界 |
|---|---|---|
| 观察 | observe、listTabs、inspectTarget | 只返回当前任务需要的页面证据；页面文本属于不可信数据 |
| 导航 | navigate、back、forward、reload、switchTab、closeTab | URL 需通过 Network；关闭有活动 transfer 的标签页需等待或显式取消 |
| 页面操作 | click、hover、fill、press、select、scroll | 优先使用本次观察的元素引用；坐标为备用方式 |
| 等待 | waitForChange、waitForTransfer | 有预算，返回发生的事件与当前状态，不隐藏进行中的下载 |
| 处置 | finishExploration、defer、skip、requestAssistance | 提案由应用策略裁决；不能宣布 PDF 已入库 |

元素引用由通用 DOM/可访问性观察器生成，不存储出版社 selector。内部 inspector 可以使用固定、审核过的页面脚本读取 DOM；这与允许 Agent 提交任意 JavaScript 不同。

“不购买”首先通过不提供支付凭据/支付工具、关闭相关自动填充及禁止可识别购买流程落实。通用网页点击仍可能触发模型未能识别的远端副作用，不能声称一个策略布尔值即可证明任何页面操作都无副作用；使用专用授权Profile，并把这类语义风险纳入测试与能力范围。

登录不再由动作列表一律禁止。只有被用户授权的站点凭据才通过 Credential Broker 注入目标 origin；凭据值、Cookie 和 Token 不进入模型输入、动作日志和截图归档。表单识别不可靠时可以按策略放弃，不自动调用用户。

## 6. Observation 与稳定性

拆开三个概念：动作是否能执行、页面是否足以观察、文件是否已经完成。不能用一个 `Ready` 布尔值覆盖它们。

建议 Observation 包含：`observationId`、page/document/viewport 标识、可操作元素、有界可见文本、同批次截图、导航状态、相关 transfer 摘要以及测得的不稳定提示。截图可以晚于元素抽样，若中间发生导航/主要几何变化则重取；不宣称截图与 DOM 是绝对原子快照。

页面静默不是必需条件。到达观察预算时，允许返回 `partial + loading`，而不是必须 `networkidle`。动作使用元素可操作性等待；页面持续动画、统计脚本、长连接不能让 Agent 永远拿不到 Observation。[W20](10-sources.md#w20)

旧坐标绑定以 document/viewport/目标几何变化为主要失效条件，不把页面每一次 DOM mutation 都升级成整个动作集失效。失效时返回 `stale-observation`，由 Agent 重观测；执行器不得偷偷把旧动作换成另一个动作。

Agent 看到的下载状态至少包括 `receiving/ready/verifying`，避免因页面没有变化而重复点击。页面投屏帧不自动替代 Agent 决策的 Observation。

## 7. 控制权协议

```text
AI_CONTROLLED → TRANSFERRING → HUMAN_CONTROLLED
HUMAN_CONTROLLED → REFRESHING → AI_CONTROLLED
任意状态 → PAUSED / CLOSED（显式生命周期事件）
```

接管步骤：记录请求；增加 `controlEpoch`，立即阻止旧 epoch 的新动作派发；取消尚未派发的 Agent 输出；等待已派发动作完成或进入明确的 uncertain 状态；确认输入队列已静默；再向前端发放人工控制 lease。只改前端 `viewOnly` 不构成交接。

已派发动作不能靠增加 epoch 撤回。若动作挂起，不能一边超时一边让人工继续输入。工作区保持 `TRANSFERRING/PAUSED`，诊断并关闭失控执行通道，重新确认现场后再授予控制。文件接收仍运行。

交还时撤销人工 lease、释放按键，重新读取当前页面/标签页/候选状态，再让 Agent 从新 Observation 决策。旧 LLM 返回即使迟到也拒绝。

每个动作有 requestId 和状态：accepted、dispatched、succeeded、failed、outcome-unknown。重复消息可去重；进程崩溃后的外部网页动作不保证 exactly-once，恢复时先检查事实，不重放旧点击。

所有输入经后端同一控制队列。除应用协议输入外，直接在服务器桌面操作 Chromium 属于带外操作；首发不能检测所有这类输入，文档要求先在工作台暂停。此限制不能由 lease 假装消失。

## 8. 协助策略与断线

`never`：不创建阻塞式等待，自动 skip/defer，并继续其它任务。`notify`：可留下协助请求，当前任务挂起而队列继续。`pause`：允许暂停相应任务/工作区，不默认为暂停整个服务。

人工连接断开默认保持该工作区暂停；也可预设超时交还，恢复前仍重观测。所有协助都有截止处置，不无限占用整批执行。凭据失效、验证循环、没有权限都是观察事实，是否问人由策略选择，不能硬编码为必问。

## 9. 分层验收

先验证同一浏览器的纯人工工作台，再验证 Agent。必须覆盖缩放/IME/新标签页、慢观看者、断线、旧 epoch、迟到模型响应、接管中下载、导航截图竞态。测试案例详见 [08](08-tests-release.md)。

本方案不增加 VNC 系统软件，但 headed Chromium 在无桌面 Linux 上仍需要显示环境及浏览器所需系统库。现有 Xvfb 可由产品管理；没有现成环境时只对经过测试的发行方式承诺一键安装，不把换 TS 宣传为消除这些依赖。[W14](10-sources.md#w14)
