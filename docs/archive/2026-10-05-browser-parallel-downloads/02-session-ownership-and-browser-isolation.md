# Block 02：按文章隔离的浏览器会话

> **状态**：Completed（2026-10-07最终验收；外部访问限制见Block07） · **Owner**：主执行者 · **上级计划**：[README](README.md)
> **前置**：Tasks 1.2、1.4–1.6 · **后续**：[03 决策循环](03-agent-pacing-and-suspension.md)、[04 文件链](04-background-download-and-publication.md)、[05 调度](05-platform-scheduling-and-configuration.md)、[06 收尾](06-workbench-recovery-and-shutdown.md)

## Outcome

多个文章页面可以在同一个持久context中安全存在。每个请求、popup、下载、候选和关闭动作都有明确的会话归属；
A成为后台页面后仍可完成自己的下载，关闭A不等待B，也不会把A的迟到结果交给B。
本块先保留生产决策并发1，以直接交错场景证明归属，再由05开放worker并行。

## 进入条件

01已证明关键浏览器事件的可用性，并冻结归属和候选交接合同。工作树中的旧单会话测试仍可运行；
新会话只使用合成home/目标和本地服务，不直接验证用户Profile。

## 责任边界

BrowserHost拥有页面、runtime、popup关系和短输入互斥；Entry/Broker拥有文章会话的生命周期与调度引用。
Bootstrap只组装按session查找的Intake/候选回调，不保留另一份当前任务。
Acquisition保留文件与任务检查权，Storage/Library不接收Browser vendor对象。

主要改动面：`browser/host.ts`、`production-host.ts`、`boundary.ts`、`capture-batch.ts`、`transfers.ts`、
`bootstrap/application.ts`；涉及工作台的控制身份通过明确边界交给06。

## Tasks

- [x] **2.1 建立会话注册与唯一所有权。** 用按session定位的记录替代`articleActive`和单个mutable Intake/candidate/flow。
      会话创建时冻结文献、operation/generation和目标元数据；page ID只能属于一个存活session，记录关闭后拒绝新绑定。
      **验收**：两会话交替打开/关闭时目标和候选互不改变；重复注册、过时代次和已关闭会话在外部动作前拒绝。
- [x] **2.2 分离前台选择与网络授权。** `activePageId`只用于显示/输入选择；route admission、prepareDownload和capture查所属session。
      保留原URL/DNS、公网地址、临时query脱敏和文件选择边界，不把“页面在后台”当作未授权。
      **验收**：B前台时A的已获准请求和下载继续；无归属、已取消或缺访问资格的页面请求被拒绝，而不是借B的资格通过。
- [x] **2.3 接通popup和重定向归属。** 将1.2证实的opener/frame/request证据落入正式adapter，处理首次请求早于page创建及同时popup。
      同一文章的子页继承会话，不继承其它会话的“当前标签”；无法唯一绑定时有界拒绝并保留可解释原因。
      **验收**：A/B同URL popup、脚本自发窗口、首响应PDF、关闭父页后的迟到popup均不串线，无等待自身事件死锁。
- [x] **2.4 隔离传输绑定和settle。** dispatcher按session筛选pending、bindings和取消对象；`settleCaptures`只等待所属会话。
      请求绑定容量按会话和进程有界，避免原全局256条记录被多页资源耗尽；子页总量也必须有资源边界。
      **验收**：B长下载时关闭A及时返回；A绑定压力不删除B的合法绑定；清理A后B仍能接收完成事件。
- [x] **2.5 建立短输入临界区。** 激活、截图和鼠标派发使用同一协调入口；模型推理、goto提交、页面反馈与下载等待不在锁内。
      每次执行前复核session、page generation、观察revision、viewport及人工控制epoch；过期结果只重新观察。
      **验收**：A等待模型期间B可截图/操作；B切到前台后A返回旧动作，不会点击B；慢导航不占据全局输入锁。
- [x] **2.6 保留Profile与局部关闭责任。** session.close只关闭本篇根页/子页并收敛其传输；共享context、Profile锁和进程由Application管理。
      未获平台资格的保留页不得后台发起新访问，下载中仍保留被绑定传输需要的请求；实际停止后才允许释放平台资格。
      **验收**：暂停决策不会切断有效下载；传输结束后的后台JS不能绕过冷却；单页关闭不导致其它会话断网。
- [x] **2.7 接回生产对象图并做单会话回归。** 生产factory、bootstrap、Intake及现有协作回调消费同一session注册；
      移除已无消费者的全局“当前目标”回退，保持verified Cloak/runtime和受控网络组装要求。
      **验收**：原单篇正式下载/验收路径仍通过；多页fixture使用正式对象图，不靠在测试里手工纠正目标ID。

## 集成与影响

内部Host/session接口会变化，调用方、transfer回调、workbench页面句柄与直接测试同步修改。
模型动作集合、PDF身份未验证标签、candidate持久格式和public获取结果不因本块改变。
新增内部session表只在进程内保存，不能成为另一个catalog或永久任务记录。

## 验证

```bash
pnpm exec vitest run apps/server/test/browser-host.test.ts apps/server/test/browser-complex-capture.test.ts apps/server/test/browser-capture-batch.test.ts apps/server/test/browser-candidate-journey.test.ts apps/server/test/application-assembly.test.ts
```

在真实Cloak本地测试中至少执行：A/B各下载不同hash；B前台时A完成；A取消时B继续；两页同时popup；
A局部settle不等待B；无归属请求在本地server侧计数为零。需要新增测试文件时明确其用途，创建后记录实际命令。
精确时间相关判断使用事件/barrier，不以增加任意sleep让竞争消失。

## 当前证据

Tasks 2.1–2.7 已接入当前 TypeScript 生产对象图，并形成以下局部验收闭环。最终 Full 由 Block 07
统一执行；本节不把此前 Worker terminal 反例导致的 Full 失败写成绿色。

- **2.1–2.3**：Host 注册 session/operation/generation，page/opener/请求只查原 owner；生产 factory 和 Bootstrap
  透传同一 identity。Browser-root Fetch 在请求放行前建立 frame、loader、redirect 和 creator 事实，
  Scheduler 按已准入主导航的 exact commit 授予文档资格。跨平台先撤旧 grant，再 drain 真实网络；
  新平台 lease 不会重新授权旧文档。子 iframe/CDN 依附主文档，dedicated/nested Worker 冻结 creator 文档。
  同 URL popup hash 的三轮、实际 Worker/redirect/OOPIF 证据见 Block 01 的 1.2。
  后续持久 script 本地反例证明，新主导航暂停于 Fetch 时，旧 script 不会仅因导航开始而结束；
  单纯 drain 会等待旧响应，直接 stop 又会同时取消暂停导航。现在只对已通过 Network 校验的主 GET，
  先取消原暂停导航并等待其 exact terminal，再停止普通旧网络并 drain，最后通过同 Page/context、
  原 session/operation/generation 和原预算重新申请目标平台一次资格。原 Fetch 不重复放行，POST 保留原方法。
  预准入请求提前登记但不被本次 drain 当作已发网络，exact terminal 在等待 admission 时也不会丢失。
  无平台间隙的明确 retry marker 阻止 Broker 恢复旧平台；失败进入普通终态，不靠超时或 URL 特例绕过。
- **2.4**：dispatcher 按 session 定位 active/pending/request/native writer，逐会话 settle/cancel 不等待其它会话。
  每会话 256 条 request binding、每篇至多 16 个 page 和进程请求上界保留；A 的绑定压力不删除 B 的合法响应。
  配额撤销后迟到真实字节继续计量，writer 真正终止、原件退休及预算结束后才释放 native ledger。
  `browser-transfer-dispatcher.test.ts` 6/6 与实际 native quota cancel 均通过；A 关闭不等 B 的真实场景也通过。
- **2.5**：激活、截图与输入共用短临界区，goto commit、模型、反馈及文件等待在区外。实际慢 A 导航不阻塞 B
  截图/输入，迟到 A 旧动作拒绝；Host 显式 capacity 6/7/8 三项通过。新模型/网络预算与 5 秒反馈证据见 Block 03。
- **2.6**：局部关闭只收敛原 session；stop 对 top Page 发 Page.stopLoading 覆盖 iframe，对 Worker 的自身 runtime
  执行关闭并等待 targetDestroyed。protocol detach 不制造响应终态；native writer 继续由真实 progress 终结。
  Application 共享失联由 Host/factory/bootstrap 的一次 onRuntimeLost 回调进入 Scheduler 普通 finish/close 路径，
  不撤销 delivered lease 或已发布事实。正式三 execution 失联回归在最终 owned-close 修复后实际 1/1 通过；
  模型 HTTP 真正在途后关闭共享 Browser，48.42ms 内报告结束、caller 未 abort、ledger 0，证据
  `/tmp/sciretriever-runtime-loss-evidence-HjVI9G/evidence.json`。Published 一篇、failed 两篇，三个 session 全部关闭，
  已发布 PDF 仍通过完整 hash 验证。
  精准 Page.crash A 后 B 的 snapshot 与 native PDF 完整 hash 仍成立，A 稳定 `browser-page-crashed`、共享失联次数 0、
  native ledger 0；最新完整 owned-session 回归中的证据 `/tmp/sciretriever-owned-sessions-TAQ0I1/crash-evidence.json`。
  后续真实 Elsevier 反例暴露 stop 命令失败会跳过 native cancel 和所属 page.close；Host 现在独立执行这些收尾，
  以真实 target/network/native 终态和 drain 证明完成，再清除会话。协议 `target-inactive` 不算关闭证据，
  首次失败后的重复 close 共享同一 Promise，保留未确认失败的 cause。新增离线故障回归 2/2；
  Cloak 中实际 detach 已选中的 stop 协议 session，旧 script 请求在错误处仍保留，随后真实 targetDestroyed 和 native
  cancel 完成 A 收尾，B 继续传输并获得正确 hash，1/1 通过。证据
  `/tmp/sciretriever-owned-sessions-BVthuN/stop-fallback-evidence.json`。
  terminal fallback 本身不证明原导航成功；通用 GET 恢复另由最终 Cloak Host GET、JavaScript GET、原 POST 三项证明，
  旧 script 真实终态早于 B HTTP，GET 原暂停导航的 loadingFailed 早于 Page.stopLoading，B 只收到一次正确方法的请求。
  到达 B 后原生 PDF capture 的完整 hash 和 ledger 0 均成立；这里使用合成 PDF 字节，仅证明传输与 capture，
  合法 PDF 的 Intake/publication 及真实 Elsevier 定点结果由 Block 07 单独记录。最终证据分别为
  `/tmp/sciretriever-document-handoff-EVGodU/events.json`、`/tmp/sciretriever-document-handoff-CVOIrV/events.json`、
  `/tmp/sciretriever-document-handoff-Z6Q66x/events.json`；含 Worker/redirect/OOPIF/返回的 document-host 1/1 证据
  `/tmp/sciretriever-document-host-Zxvilm/events.json`。
  已在途 native/IO writer 不因新导航而取消；取消原 GET 等终态期间才升级为 PDF 的响应也在 stop 前再次复检。
  若候选优先使导航被 supersede，只保留同 page/platform/document/history 已证实的 source 为 resumable，
  不授予后台资格；候选被拒后，原 Broker 重新取得 lease/start 才恢复原页，模型和动作计数不重置。
  已完成或失败的恢复不反复阻断后续观察，原 goto 仍保留精确失败因果。Host snapshot 返回前比较恢复 request marker，
  同文档代次内恢复开始并已结束也会丢弃中途旧观察，沿用已有 Transition 重新观察。
- **2.7**：最新 assembly/Intake/candidate/dispatcher/capture 5 文件 39/39 通过，包含 29 项 application assembly、
  popup/data/blob capture、候选在页面关闭与重启后仍保留原文章、publication 前交付及 binding 压力。
  共享失联和独立并行 production fixture 使用正式 Application 组装；真实出版商结果由主执行者统一记录，
  不把出版商限制写成平台准入失败。

最新相关命令与结果：

```bash
pnpm exec vitest run apps/server/test/browser-cdp-owner.test.ts apps/server/test/browser-page-runtime.test.ts apps/server/test/browser-document-admission.test.ts apps/server/test/browser-parallel-scheduler.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run apps/server/test/browser-complex-capture.test.ts apps/server/test/browser-capture-batch.test.ts apps/server/test/browser-candidate-journey.test.ts apps/server/test/application-assembly.test.ts apps/server/test/browser-transfer-dispatcher.test.ts --maxWorkers=1 --no-file-parallelism
SCIRETRIEVER_CLOAK_BUNDLE=<已校验bundle> pnpm exec vitest run apps/server/test/browser-owned-sessions.test.ts -t 'renderer crashes' --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run apps/server/test/browser-session-cleanup.test.ts apps/server/test/browser-cdp-owner.test.ts apps/server/test/browser-runtime-loss-scheduler.test.ts --maxWorkers=1 --no-file-parallelism
SCIRETRIEVER_CLOAK_BUNDLE=<已校验bundle> pnpm exec vitest run apps/server/test/browser-owned-sessions.test.ts -t 'inactive stop protocol' --maxWorkers=1 --no-file-parallelism
SCIRETRIEVER_CLOAK_BUNDLE=<已校验bundle> pnpm exec vitest run apps/server/test/browser-runtime-loss-production.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run apps/server/test/browser-cdp-owner.test.ts apps/server/test/browser-navigation-recovery.test.ts apps/server/test/browser-document-admission.test.ts apps/server/test/browser-parallel-scheduler.test.ts apps/server/test/browser-transfer-dispatcher.test.ts apps/server/test/browser-session-cleanup.test.ts --maxWorkers=1 --no-file-parallelism
SCIRETRIEVER_CLOAK_BUNDLE=<已校验bundle> pnpm exec vitest run apps/server/test/browser-document-handoff-production.test.ts apps/server/test/browser-document-host.test.ts --maxWorkers=1 --no-file-parallelism
```

第一条 4 文件的直接检查涵盖 CDP 的 15 项、PageRuntime 的 10 项、文档 admission 的 7 项与当前 Scheduler
生命周期测试；第二条为 5 文件 39/39。Cloak 版本 `146.0.7680.177.5` / Playwright `1.55.0`。
新增 terminal cleanup 直接检查为 3 文件 18/18；其中两项验证 drain 前保留 owner，cancel/page/drain 失败仍尝试其它所属页，
重复 close 不把失败写成成功。新实际 Cloak inactive-stop 单项为 1/1，其余未匹配的测试不计为该命令通过。
随后完整 owned-session 12/12 与 document-host 1/1 通过；runtime-loss fixture 曾在发出 Browser.close 前
因模型 HTTP 尚未抵达而失败，补真实 HTTP 到达屏障后 focused 1/1 通过，最终证据如上。
相关 Prettier、ESLint、strict 测试类型检查及服务器 TS build 在最终 source 冻结前执行并由主执行者汇总到 Block 07。
最终通用恢复补丁的六文件直接检查为 55/55：CDP 20、Host recovery 6、document admission 8、parallel scheduler 13、
transfer dispatcher 6、terminal cleanup 2；最后 Cloak 两文件 4/4。最终 source/tests 冻结后，source build、strict 与 ESLint 均通过。
新增 owned/document Host 测试默认从 `chromium.executablePath()` 或显式环境变量取得 Browser，不提交开发者的绝对缓存路径。

## 退出条件

页面显示与任务授权分开；按会话定位的传输与清理实际生效；popup首次请求有可靠证据；短输入锁不覆盖模型/网络等待。
单会话原有下载链和多会话交错反例均通过，没有依赖“当前前台目标”的残留回退。

## 恢复与交接

归属不明或出现错文候选时立即停止启用并行，保留最小事件序列和各session身份；不向正式Library发布待查候选。
回到2.2/2.3修复，不靠延迟回调或出版社selector掩盖。03/04接收可靠页面、capture和局部关闭句柄；
05接收可独立存在的会话，06接收控制epoch及局部取消边界。

## 2026-10-07最终收口

本块实现、直接回归与必要生产对象图证据已并入最终验收；Full189文件/1,266项通过、39项条件跳过、build通过。
最后源码清单142项、hash55a59148dcabd9d2a8345d8b4c9b689831b92307bcc6f04e1bab726306fc0c01。
具体版本、影响审查、逐出版社结果和外部未决范围见[最终验收记录](../../notes/browser-final-acceptance-2026-10-07.md)。
此前记录保留其发生时的版本与结论；当前块状态以上述最终收口为准，不将历史失败改写为当时通过。
