# 浏览器会话与控制

为 Agent 与人类提供同一套页面观察、动作执行、会话生命周期和下载捕获。

## 内容入口

- [article-flow.ts](article-flow.ts)：单篇文章的页面操作流程；导航失败后恢复观察并反馈 Agent，同一目标连续失败两次时以明确原因结束，不重置预算。
- [observation.ts](observation.ts)：页面观察材料。
- [activity.ts](activity.ts)：有界的进程内动作与停止投影；导航失败记为平台 navigation-failed，撤销尚待反馈的成功输入记录；不保存输入文本、页面图片或数据库事实。
- [decision.ts](decision.ts)：保留单次决策兼容入口，并提供绑定文章身份的 DSH 能力会话；工具语义与动作结果由 Browser 定义。
- [pacing.ts](pacing.ts)：动作节奏与等待。
- [transfers.ts](transfers.ts)：下载传输管理。
- [screencast.ts](screencast.ts)：同一已拥有页面的按需 CDP 投屏、文档身份及直接输入；与 Host 共享输入 FIFO。
- [observation-image.ts](observation-image.ts)：Agent 观察图的像素遮挡；不修改 DOM，检测失败返回无图。
- [host.ts](host.ts)：浏览器宿主边界。
- [cdp-owner.ts](cdp-owner.ts)：原始 target/request/文档与传输归属；新窗口导航恢复使用绑定的 CDP session，仍经网络准入，不依赖 Playwright Page 已登记。
- [cdp.ts](cdp.ts)：所属浏览器的协议连接；普通命令保留 RPC 超时，带文章取消信号的导航等待由文章生命周期约束，避免将准入排队误判为导航失败。
- [page-runtime.ts](page-runtime.ts)：当前页面观察与输入；失效控件以可恢复错误拒绝，由文章流程重新观察，失败输入不记作已执行动作。

## 放置边界

每个文章会话绑定独立 Agent 会话，保存目标、观察、工具结果、人工协作及下载反馈。模型可以一次返回多个工具调用，Browser 对同一稳定观察仍至多接纳一个页面动作，其余调用记录明确拒绝。接管与取消使旧动作资格失效，交还后重新观察；下载暂停不重置会话或文章预算。

导航恢复只使用本会话可用页面及原有文档准入；错误页先等待归属连接确认返回，原页仍健康时保留原页；失败 popup 在新的成功导航前不再自动跟随。页面/浏览器崩溃、runtime 丢失、没有可用页、策略拒绝和取消仍结束；已开始传输与已发布结果继续优先。

模型调用由 agents 执行，网络准入由 network 执行，捕获后的 PDF 验收与发布由 acquisition 负责。出版社专有规则不堆入通用页面控制器。

[上级目录](../README.md)
