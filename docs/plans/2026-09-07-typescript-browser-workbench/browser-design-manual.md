# SciRetriever Browser 工作台设计手册

## 1. 目标与边界

Browser 工作台服务于一个本地单用户：用户输入文章线索，查看真实页面，必要时人工接管，系统在受控边界内获取 PDF 候选，确认身份和版本后交给文献库。工作台是“可观察、可接管、可解释”的获取界面，不是通用远程浏览器，也不是让模型自由执行脚本的自动化平台。

M2 基线使用一个 Browser Host、一个 Profile、一个活动页面和一个控制者。其他客户端可以观看；控制权一次只能属于一个操作者。所有外部页面请求必须经过 Network admission。工作台只显示脱敏状态、页面画面和允许显示的观察证据。M5 若增加 workspace，只能为每个 workspace 使用独立 Profile，并继续复用同一 Host/控制权合同。

## 2. 信息架构

```text
顶部：任务标题 / 文章标识 / 会话状态 / 关闭
左侧：页面画面（主区域）
右侧：Observation、候选文件、控制权和事件时间线
底部：人工接管、继续、暂停、取消、重试（按状态显示）
```

窄屏布局将右侧面板改为底部抽屉：画面优先，状态栏固定在底部，点击“详情”打开 Observation/候选/事件。桌面端不隐藏错误和控制权状态；手机端减少文字但保留状态、下一步和取消操作。

## 3. 核心状态

| 状态 | 含义 | 用户操作 |
| --- | --- | --- |
| `starting` | Browser、Profile 或页面正在准备 | 等待、取消 |
| `watching` | 页面可观看，Agent 或人工可能持有控制权 | 接管、暂停、取消 |
| `agent-running` | Agent 只能消费稳定 Observation，并执行一个封闭动作 | 暂停、接管、取消 |
| `needs-assistance` | 页面需要登录、选择或确认，系统不能自动决定 | 接管、完成后继续、拒绝 |
| `capturing` | 已发现候选传输，正在受限接收/封存 | 等待、取消 |
| `verifying` | 正在做 PDF 结构、身份和版本判断 | 等待、取消 |
| `candidate-ready` | 候选已持久化，可发布或查看证据 | 发布、放弃、查看 |
| `finished` | 正式 Asset/Literature 已更新 | 查看文献、开始解析 |
| `paused` | 执行暂停，预算不重置 | 继续、取消 |
| `failed` | 任务结束但未形成可用结果 | 查看原因、重试、关闭 |

状态必须有明确的下一步。`uncertain` 不是失败：它应显示缺少哪类证据，并允许人工选择继续保留 Candidate 或放弃。

## 4. Browser 会话合同

每个 Observation 至少包含：`session_id`、`page_id`、`document_generation`、`viewport_revision`、`frame_seq`、截断后的页面结构/文本摘要、loading 状态、时间和预算剩余。页面发生导航或文档替换时递增 `document_generation`；视口变化时递增 `viewport_revision`；控制者变化时递增 `control_epoch`。

Agent 动作遵守 [ADR 0023](../../architecture/decisions/0023-generic-browser-agent-executor.md) 的封闭集合：`ClickElement`、`ClickPoint`、`ScrollSurface`、`GoBack`、`WaitForChange`、`Stop`。现有 TS 对应 `click-element`、`click-point`、`scroll-surface`、`go-back`、`wait-for-change`、`stop`。它不包含文本输入、按键、任意 URL、selector、脚本、文件路径或事实写入。

人工鼠标、滚轮、文本和键盘输入使用独立的 operator command 合同，不注册为模型工具。服务端确认发起者是当前人工控制者后，再验证页面和目标绑定；viewer、agent 或旧 controller 提交人工输入均在 Browser dispatch 前拒绝。`needs-assistance` 是用户状态；正式发布是业务命令，不增加 Agent 动作种类。

命令带对应 Observation 版本、控制 epoch 和 request id，并按动作携带目标引用。服务端执行前校验文档代次、适用的视口版本、目标仍存在和预算；过期或重复动作必须在调用 Browser 前返回。现有 TS 的 `revision`、`viewport_version` 与计划字段的映射由 01-04 明确，不能直接改名破坏消费者。

Agent 每轮最多执行一个 Action。它不能直接提供任意 URL、CSS selector、JavaScript、文件路径或事实写入命令。需要网页变化时重新 Observation，再决定下一步。

## 5. 画面与输入

画面流传递有界帧：新帧到达时丢弃慢观看者的旧帧，不阻塞 Browser。每帧带 `page_id`、`viewport_revision` 和 `frame_seq`。客户端发现序列跳跃时请求当前帧，不把丢帧误报为页面失败。

人工鼠标、滚轮和键盘输入先转换为 operator command，再由服务端校验；复用底层执行器不意味着共享模型权限。输入正文不进入命令日志或事件，密码输入不回显，页面观察继续遵守凭据脱敏边界。坐标按客户端显示区域映射到当前 viewport；客户端缩放显示不改变共享页面 viewport，只有 Host 实际调整页面视口才递增 viewport revision。剪贴板、拖放、文件选择和未知输入在第一阶段明确显示“暂不支持”，不静默降级为不可预测行为。

## 6. 传输与 Candidate

传输生命周期为：

```text
admitted → receiving → staged → durable-ready → verified → published
                                      ↘ rejected / expired / cancelled
```

只凭 URL、文件名或 download 事件不能形成 Candidate。至少需要响应/下载经过 admission、属于当前页面和文章执行、有界字节数、完成写入并取得 hash。PDF acceptance 只负责结构和资源边界；identity/version verdict 负责文章身份和版本证据；两者都通过后才允许正式 Literature owner 发布 Asset。

页面关闭或工作台断线时，已经开始的传输在独立 deadline 内完成或标记明确超时。无关的新请求不能延长 deadline。已写入的安全 stage 不因截图失败或页面关闭而删除。

上图描述传输与发布流程，不替代 [技术文档](../../architecture/technical/typescript-workbench.md#2-数据与生命周期) 的 Candidate 状态合同；阶段 01 必须明确二者映射。`durable-ready` 不代表身份已通过。Candidate/receipt 按 [02-06](02-runtime-storage-network.md) 的最小 execution schema 持久化；新进程能读取并对账后才满足重启验收，内存对象和回执缓存不构成恢复证据。

## 7. 用户反馈

每个错误使用“发生了什么 / 为什么 / 现在可以做什么”三段式。例如：

- “页面请求被本地网络策略拒绝。目标地址不在允许范围内。请返回、修改来源配置或请求人工协助。”
- “已收到 PDF，但无法确认文章身份。候选已保存。请查看证据后发布或放弃。”
- “模型动作已过期，页面已经变化。系统没有执行旧动作。正在获取新的页面观察。”

日志、事件和 UI 只显示 code、阶段、时间和脱敏摘要，不显示 Cookie、Authorization、签名 URL、Profile 绝对路径或页面大段文本。

## 8. 可访问性与响应式

- 所有控制有键盘焦点、可读名称和可见焦点环；状态通过 `aria-live` 提示变化。
- 颜色不能作为唯一状态标识，状态同时显示文字和图标。
- 桌面推荐最小 1100×720；窄屏采用单列，画面保持至少 16:9 的可视区域。
- 触控目标至少 44×44 CSS px；“取消”和“关闭”固定可达。
- 画面暂停时显示最后一帧及时间；降低动画时保留操作反馈和状态变化。

## 9. 第一阶段验收

1. 目标 CloakBrowser runtime 只访问 loopback fixture；普通 Chromium smoke 单列为适配证据；
2. 两个观看者可看同一页面，只有一个控制者；
3. 过期 Observation、旧控制者和迟到 Agent 结果不会调用 Browser，Agent 无法提交人工文本/键盘命令；
4. navigation、redirect、response/download 经 admission；
5. 合法 fixture PDF 能形成 durable Candidate，损坏/超限输入有明确拒绝；
6. Candidate 在页面关闭后仍可查询并能幂等发布；
7. 390px 窄屏和桌面宽屏均能完成观看、接管、取消和查看结果；
8. 未配置模型、人工协助、网络拒绝、身份不确定和取消均有可操作的用户反馈。

## 10. 后续扩展

T027 必须为页面 Service Worker、WebSocket、blob/frame/popup/viewer 和复杂 Range/ETag 形成受支持适配或明确能力失败；未支持通道必须禁用或拒绝，不得绕过 Network admission。T048–T053 再加入未完成任务续跑和最小 workspace/service 能力。所有扩展复用本手册的 session、admission、Candidate 和错误合同，不能建立第二条 Browser 路径。
