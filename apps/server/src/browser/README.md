# 浏览器会话与控制

为 Agent 与人类提供同一套页面观察、动作执行、会话生命周期和下载捕获。

## 内容入口

- [article-flow.ts](article-flow.ts)：单篇文章的页面操作流程。
- [observation.ts](observation.ts)：页面观察材料。
- [activity.ts](activity.ts)：有界的进程内动作与停止投影；不保存输入文本、页面图片或数据库事实。
- [decision.ts](decision.ts)：保留单次决策兼容入口，并提供绑定文章身份的 DSH 能力会话；工具语义与动作结果由 Browser 定义。
- [pacing.ts](pacing.ts)：动作节奏与等待。
- [transfers.ts](transfers.ts)：下载传输管理。
- [host.ts](host.ts)：浏览器宿主边界。
- [cdp-owner.ts](cdp-owner.ts)：原始 target/request/文档与传输归属；新窗口导航恢复使用绑定的 CDP session，仍经网络准入，不依赖 Playwright Page 已登记。
- [page-runtime.ts](page-runtime.ts)：当前页面观察与输入；失效控件以可恢复错误拒绝，由文章流程重新观察，失败输入不记作已执行动作。

## 放置边界

每个文章会话绑定独立 Agent 会话，保存目标、观察、工具结果、人工协作及下载反馈。模型可以一次返回多个工具调用，Browser 对同一稳定观察仍至多接纳一个页面动作，其余调用记录明确拒绝。接管与取消使旧动作资格失效，交还后重新观察；下载暂停不重置会话或文章预算。

模型调用由 agents 执行，网络准入由 network 执行，捕获后的 PDF 验收与发布由 acquisition 负责。出版社专有规则不堆入通用页面控制器。

[上级目录](../README.md)
