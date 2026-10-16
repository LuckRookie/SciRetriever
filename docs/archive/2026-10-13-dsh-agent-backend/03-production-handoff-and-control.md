# 03 生产对象图、后台下载与人工控制

状态：Completed（实现与定向/Quick 已验证；最终集成 Full 和现场对照由 04 收口）。上级：[计划控制面](README.md)。本块建立正式路径的端到端所有权交接。

## Outcome

生产 Bootstrap 将同一 DSH runtime 接到当前 Browser/Entry/Workbench；用户看见和控制的页面就是 Agent 操作的页面。A 开始后台下载后及时让出决策 worker，B 可以继续；A 下载失败时在原身份、剩余预算与完整会话历史上恢复。人工指导、接管、交还、单篇取消和整应用关闭分别作用于正确 scope，文件接纳/发布与平台冷却沿用既有 owner。

## 进入条件

- 1.5 的逐实际请求归属与 1.6 的模型绑定已经验证；2.2–2.5 的历史、工具执行、节奏、暂停恢复合同稳定。
- 已阅读 `bootstrap/application.ts`、`browser/production-host.ts`、`host.ts`、`article-flow.ts`、`transfers.ts`、`workbench/production-session.ts`、Entry PDF scheduler 与 Acquisition intake/acceptance 当前调用方和直接测试。
- 使用合成配置、测试 Profile 与 loopback 网页/PDF；不得把开发测试指向真实 catalog、Provider 或用户浏览器会话。

## 责任边界

Bootstrap 只负责创建并关闭 runtime/能力，不能承接文章业务判断。Browser 仍是唯一文章 session、页面、输入控制、transfer 和 scope 映射 owner；Entry/Broker 继续持有就绪队列、worker、保留会话 cap 和平台资格。Workbench 是选中 session 的控制/观察适配，不能建立自己的 DSH 对话或第二份模型循环。Acquisition/Entry 继续通过原 candidate/lease/receipt 接纳与发布，Storage 不新增判断。

本块在现有生产模块中接线，不新建持久队列、Worker 服务、Agent HTTP broker、进程或模型 endpoint；测试与用户配置隔离继续由现有 owner 保证。

## Tasks

- [x] **3.1 接入共享 runtime 与独立文章 scope。** 依赖 1.2、1.6、2.1–2.2，在 `bootstrap/application.ts` 通过 Configuration/Agent binding 创建一个应用级 DSH runtime；Browser 创建文章 session 时建立对应 scope，正常关闭/启动失败时都由所属 owner 释放。Web 自动与 Completion Browser 路径使用同一 capability 工厂与页面资源，不由选中 tab 决定归属；保留 Analysis 单次 runtime 的公开访问与关闭语义。输出生产 factory 接线、启动/部分失败清理与配置 readiness 测试；验收为同应用多篇复用 runtime、每篇工具与历史隔离、未配置 Browser 模型时仍按原行为报告不可用、关闭 A 不关闭 B 或共享 context。
- [x] **3.2 连接人工指导、接管与交还。** 依赖 2.2、2.3、2.5、3.1，将 Workbench 已接受/消费/过期/取消的指导按原 session、article、control epoch 传给能力；采用框架 steer 时记录排队与实际消费时点，不能把提交就当作已生效。人工接管先由 Browser 撤销模型与工具执行资格，再协作取消该决策；交还后先观察真实页面，再向同一 DSH 会话追加人类操作/新观察继续。输出现有 Workbench API 适配与 Web/server 集成测试；验收为模型推理中接管 A 后迟到动作不执行、B 不被取消，指导不会跨文章或 epoch 泄漏，手动操作结果能进入后续上下文，页面实时显示来自正式 Browser owner。
- [x] **3.3 连接 transfer 与 candidate 交接。** 依赖 2.5、3.1，将真实 `transfer started/completed/failed` 与候选 ready/rejected 事件按原 session/generation/transfer identity 去重消费。逐块 progress 继续由既有 transfer owner 处理并记录 bytes/first-byte/stall；暂停期间 Agent 不决策，不向对话复制逐块进度或新增第二份进度缓存。下载开始立即暂停该 Agent turn 与文章决策、释放 worker，保留 transfer 独立取消域；失败/候选拒绝追加实际反馈并以原 DSH session、剩余时钟和新观察恢复。candidate ready 优先终止探索，由原 Entry acceptance/publication 执行，lease 按 published/retained/cancelled 结清。输出事件桥、失败恢复与候选旅程测试；验收为不等待模型说成功、不等待 publication 才返回 candidate，迟到事件不能归给当前 Web 文章，失败不会重置历史，已交付有效候选和已发布资产不会因 DSH/页面清理失败丢失。
- [x] **3.4 保留 worker、平台与预算调度。** 依赖 1.5、2.4、3.3，将 DSH 模型准入与现有 BrowserArticleExecution/Broker 领取逻辑连接，显式区分决策 worker、model permit、保留会话和平台网络资格。A 下载/等待平台/人工持有时不占决策 worker；恢复重新排平台 start，真实网络停稳且页面不能继续发请求后启动 30 秒冷却，本地文件检查/发布不延长平台资格。保留两个 worker（受会话 cap 和共享模型预算限制）及原配置兼容。输出 A 下载→B 推进→A 失败恢复的生产调度测试；验收为不同平台并发、同平台串行/冷却、持续补位、共享 Retry-After 和聚合串行配置仍成立，每篇普通/压缩实派发分别计入 30 次且不误算队列等待。
- [x] **3.5 完成取消域与确定性收尾。** 依赖 3.1–3.4，分别覆盖文章操作取消、单轮决策撤销、transfer 取消和应用 shutdown；取消 scope 不能直接关闭共享 runtime。应用退出先停止准入和模型派发，逐文章结清工具/transfer/真实写者/页面/附件，再关闭共享 runtime/context/Profile lease；DSH listener、handler 与附件不得残留。输出关闭顺序与故障注入测试；验收为正在写文件时不提前删除路径，late tool/result 只清理原 owner 资源，重复 close 幂等，publication 已提交事实保留，清理失败单独报告而不伪装成未下载。
- [x] **3.6 保持操作结果、日志与诊断一致。** 依赖 3.2–3.5，用现有 Logging 关联 operation/article/session/transfer/request 与用途，区分普通模型、压缩、工具拒绝、Agent 停止、预算、Network 错误、candidate 和 publication；尽可能记录模型 usage、可获得的缓存计数与时长，不输出 prompt、历史正文、URL query、Cookie、Token 或图片。Web 继续消费中性业务事件与稳定错误码，不直接读取 DSH session 日志。输出结果映射、非秘密计量断言与恢复定位说明；验收为自然语言 Stop、框架 idle、download completed 均不会越权生成 published，旧 API 的重要错误/取消语义不被统一吞成 agent-internal。
- [x] **3.7 验证完整生产组装。** 依赖 3.1–3.6，用 `createApplication` 的正式依赖图与真实 DSH 插件执行 loopback 页面和合成 PDF；模型外部响应可脚本化，但不能绕过配置、Network、Browser host、transfer、Intake、candidate acceptance 和 publication。同时运行正式 Workbench 选中/指导/接管路径与后台 Completion，证明独立页面归属和用户共享事实。输出生产回归与必要技术/README 更新；验收为最终 PDF 可通过正式读取路径重开并核对 hash/provenance，A/B 时序与取消断言通过，Analysis 仍可独立单次执行。

## 集成与影响

预期不增加 catalog schema、用户配置字段、资产路径或公共 MCP 能力；已支持的 SDK/Entry PDF 获取行为继续返回原结果，具体进度由已有业务事实驱动。若内部接口因 scope 生命周期变化必须调整，应同步所有生产自动/协作路径，避免只接上 `deliverCandidate` 而留下 Workbench 旧模型循环。

默认首版一篇一会话、同应用复用 runtime；下载失败、人工接管与 release 均保留同篇历史。文章关闭后会话内存释放，应用重启不复原 DSH conversation；已有 durable task/候选恢复语义照常适用，不能把它们宣传为 Agent 上下文持久恢复。

## 验证

现有生产与调度入口：

```bash
pnpm exec vitest run apps/server/test/application-assembly.test.ts apps/server/test/browser-control-production.test.ts apps/server/test/browser-parallel-production.test.ts apps/server/test/browser-transfer-dispatcher.test.ts
pnpm exec vitest run apps/server/test/browser-publication-lease.test.ts apps/server/test/browser-candidate-journey.test.ts apps/server/test/browser-shutdown-production.test.ts apps/server/test/browser-runtime-loss-production.test.ts
pnpm exec vitest run apps/server/test/production-workbench-loopback.test.ts apps/server/test/production-parallel-workbench.test.ts apps/web/test/parallel-live-workbench.test.ts
pnpm quick
```

拟新增 `apps/server/test/browser-dsh-production.test.ts`，3.7 建立后运行：

```bash
pnpm exec vitest run apps/server/test/browser-dsh-production.test.ts
```

至少包含以下组合断言：A 工具触发慢 transfer、B 完成后 A 失败恢复；A/B 不同平台并发与同平台冷却；模型响应中途接管、迟到工具拒绝与指导随后消费；candidate ready 与模型失败竞态；压缩与普通请求争用同一 permit；shutdown 等待真实 writer；后台 Fetch/XHR inline 预览不得冒充主下载。现有 browser production loopback 覆盖应使用测试浏览器与 loopback，不连接真实网站。

## 退出条件

正式 Bootstrap、Completion、Workbench、Browser、Acquisition 与 Network 已经沿同一能力接线，3.1–3.7 有证据且 Quick 通过。生产路径中的 A/B 并发、transfer 恢复、控制版本、计量/预算、候选发布和资源关闭均通过；04 可以评估整条路径，不依赖临时 standalone demo 或外部 broker。

## 恢复与交接

保留生产 fixture、失败时序和脱敏日志；对象图错误回到 3.1，人工控制回到 3.2，下载/候选回到 3.3，调度/计量回到 3.4，资源收尾回到 3.5。尚未通过的路径不得通过启用旧决策 fallback 隐藏；在批准范围内修复，必要时停在具体 Task 并报告。

不对真实 catalog/Profile 做恢复实验，不删除可能仍在写入的文件，不因失败关闭兄弟 session。交接给 04 的是可运行的生产切片、准确测试命令、依赖/导出/配置影响说明和明确未覆盖的真实站点限制。2026-10-13 当前证据：生产 Bootstrap 已持有单个能力 runtime，正式 Flow 与 synthetic Workbench 使用同一 Browser capability 工厂。`application-assembly.test.ts` 30 项通过，`browser-dsh-production.test.ts` 的正式配置→Network loopback→Workbench→真实 Cloak→Intake→publication 综合场景通过；A 人工介入、B 并行完成、A 断流/冷却后同篇恢复及正式 hash 读回有断言。正在以最终 Full 与旧生产矩阵汇总收口，未将本块标 Completed。

实施澄清：逐块传输进度属于既有 transfer owner 的诊断事实，继续使用其进度日志。DSH 只接收会影响下一决策的 started/completed/failed/candidate 事件，避免后台下载期间堆积无用对话，不增加状态。

[上一结果块](02-browser-session-and-tools.md) · [下一结果块](04-verification-and-retirement.md) · [计划控制面](README.md)

最终定向补证：真实 Cloak 下既有 11 文件 23 项均有通过证据；新 `browser-dsh-production.test.ts` 1 项验证正式生产恢复/人工控制/并行与文件读回。旧工作台测试导航按既有界面合同修正，保留无隐式获取、控制权、移动端与已发布文件断言。冻结 Quick 通过。全量 Full 和真实样本统计不混入这些定向结果，见 04。
