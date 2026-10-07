# Block 06：工作台、恢复、取消与停服

> **状态**：Completed（2026-10-07最终验收；外部访问限制见Block07） · **Owner**：主执行者 · **上级计划**：[README](README.md)
> **前置**：02–05生产接线与直接测试 · **后续**：[07 全链路交付](07-end-to-end-verification-and-handoff.md)

## Outcome

用户能查看明确文章会话的状态并接管该页面，人工操作不会落到另一篇文章；其他会话仍可决策或下载。
下载恢复、单篇取消、代次替换、页面/浏览器故障和Application退出均结清对应责任，保留已经提交的文件和文献事实。
工作台只投影现有运行状态，不引入第二套时钟、候选、队列或控制owner。

## 进入条件

05已实际派发多个会话，03可暂停且有统一预算，04可产生有效候选/终态并独立清理。
ProductionWorkbenchSession当前只有单文章投影的限制必须被显式处理，不能启用工作台就悄悄把全部worker降为1来算完成。
测试使用合成home、隔离catalog和受控本地Browser；不导入用户会话。

## 责任边界

主要位置：`workbench/production-session.ts`、`session.ts`、`http.ts`、bootstrap协作回调、
`packages/contracts`的工作台消息、`apps/web/src/live.ts`及相关页面适配。
Entry/Broker继续拥有session和操作结果，Browser继续拥有页面/输入权，Acquisition/Storage继续拥有候选/文件事实。

## Tasks

- [x] **6.1 按文章选择会话投影。** 工作台提供必要的会话列表/选择，展示当前文献、浏览/下载/等待/验收阶段与原因；
      截图、控件、候选、预算及publication结果均来自所选session。页面显示变化不能改写后台任务归属。
      **验收**：A/B下载交错时选择A只见A文件和剩余预算；单会话原用法仍可用，未选择或身份已失效时不能默认向前台发送操作。
- [x] **6.2 串起原会话恢复与控制权。** 失败恢复从03/05获得当前状态和剩余预算，人工接管仅暂停对应session自动派发，
      再交回Agent时重新观察。human/agent共用短输入互斥与control epoch；切换所选会话不代表取得其控制权。
      **验收**：人工接管A时B继续推理/下载；A旧模型动作被拒绝；指导反馈留在A，释放人工控制不重置文章预算。
- [x] **6.3 覆盖单篇取消与代次替换。** 从等待worker、模型在途、动作等待、后台下载、验收、候选已就绪等阶段取消。
      每阶段确认决策、真实下载/reader写者及页面终止次序；generation更新使旧结果失效但不清空共享平台政策。
      **验收**：A取消后B继续且入库；旧A完成事件不发布到新A；取消的排队项不再建页面，预算permit与暂存文件都有明确归属。
- [x] **6.4 分离局部故障和共享运行时故障。** 页面崩溃、模型服务错误、传输错误只影响对应会话；context/浏览器进程崩溃
      才按共享运行时范围结束依赖它的会话。不同错误保留稳定code、原因和可恢复/终止语义，不能统一写成无PDF。
      **验收**：一页crash不撤销另一篇已提交候选；整个Browser死亡后无继续派发动作，受影响会话有终态，外部没有虚假成功。
- [x] **6.5 明确验收与发布后的异常处置。** 无效文件或excluded hash携带原因回原会话；磁盘/CAS/publication错误进入原事实owner处理，
      不让Agent反复下载解决本地提交问题。已提交publication遇关闭失败保留资产，单独报告清理问题。
      **验收**：本地存储故障期间出版社请求不增加；publication receipt可按原机制继续；metadata变化不会接受过期目标文件。
- [x] **6.6 实现整体退出和受限恢复。** Application关闭时先停止新派发，取消/收敛各决策和传输，等待真实写者结束，
      再关闭各页和共享context/Profile锁。卡住时有界升级清理并报告未结责任，不能永久await全局settle。
      新进程只恢复原有durable候选/receipt事实，不假称恢复活标签页、旧下载socket或进程内限速窗口。
      **验收**：有慢下载、停放会话和pdfinfo子进程时关闭可返回；无孤立受管进程/写者；已提交数据与原Profile保留。
- [x] **6.7 闭合HTTP/Web与生产组装。** 更新所需中性消息和调用方，保留明确的单会话兼容语义；多会话指令必须有可验证目标，
      不用客户端当前选择猜测晚到命令。等待原因和限制值向用户解释，敏感query、Cookie、文件绝对路径不进入前端或模型。
      **验收**：同一场景经过真实HTTP/Web适配也正确，不能只证明服务内部session类；旧revision/重复命令和选择切换竞态均受控。

## 失败和收尾矩阵

| 触发点                    | 必须保留                     | 必须停止/释放             | 不允许发生                  |
| ------------------------- | ---------------------------- | ------------------------- | --------------------------- |
| 等待平台时取消A           | 原有平台冷却/窗口            | A等待项及其保留页         | 清零平台政策，让新A立即访问 |
| 模型在途时下载已开始      | A的下载与原会话              | 本轮多余决策执行权        | 迟到动作再点击或取消文件    |
| 下载失败                  | 页面现场、累计预算、失败摘要 | 已停止的传输与临时资源    | 重置为新任务无限重试        |
| 文件有效但publication失败 | 有效candidate、receipt和来源 | 不必要的网络访问          | 重新下载来掩盖本地提交故障  |
| publication后清理失败     | 已提交资产与文献关系         | 继续结清本篇资源          | 回滚或删除有效文件          |
| context崩溃               | 所有已提交事实               | 依赖该context的未完成会话 | 假报完整恢复浏览器现场      |

## 集成与影响

工作台消息、HTTP适配和Web消费者可能需要扩充session选择字段，必须一起检查解析、序列化、事件流与兼容测试。
不能通过删除现有人工接管或候选视图绕过多会话问题；第一版只需可用的会话选择和准确状态，不重做整站UI。
客户端断开是否取消任务继续遵守原操作合同，不把切换标签页当作自动取消。

## 验证

```bash
pnpm exec vitest run apps/server/test/workbench-session.test.ts apps/server/test/production-collaboration.test.ts apps/server/test/production-session-http.test.ts apps/server/test/workbench-http.test.ts apps/server/test/candidate-abandonment.test.ts apps/web/test/browser-workbench.test.ts apps/web/test/live-workbench.test.ts
pnpm exec vitest run packages/contracts/test/workbench-parallel-view.test.ts apps/server/test/production-parallel-workbench.test.ts apps/server/test/browser-publication-lease.test.ts apps/web/test/parallel-live-workbench.test.ts
```

真实Cloak本地场景覆盖A人工控制/B下载、关闭页面、整体退出和已提交后清理失败；使用精确barrier安排竞争顺序。
reader/下载进程退出需检查实际进程或完成事件，不能只看AbortSignal已设置。每个取消点记录文件和资格的最终状态。

## 当前证据

Tasks 6.1–6.7已有局部源码、HTTP/Web、合同、直接验证与下表所列的必要实际Cloak/子进程证据。
本块保持In progress，最终冻结patch上的Quick/Full由07统一验收；各层证据不冒充所有故障与阶段的笛卡尔组合已实测。
最新live暴露`target-inactive`页面停网未确认cleanup、同平台opening waiter持续等待的问题，
Host terminal fallback与平台quarantine现已修复并冻结，新增实际与直接回归见下文；
此前局部取消/退出绿色不当作这条新路径的证明，真实Elsevier handoff结果仍由07重新采集。
Flow随后修正完整owned close成功后仍保留早期stop错误的假cleanup失败；其后实际shared loss1/1、
正常shutdown2/2均在该修复上复跑通过。中途一次失联回归的模型HTTP尚未真正抵达，
已添加服务端真实inflight屏障后完整再验收，不将该fixture前置失败误报为Browser关闭后的产品结果。
不能以选中会话或AbortSignal已设置代替真实writer/reader结束，也不以局部绿色声称Full通过。

2026-10-05前次局部冻结的11文件135/135通过，其中原workbench-session10、production-collaboration13、
production-session-http7、新production-parallel-workbench8、contracts4、publicationLease3、真实Web1；
其余Browser89见03。JSON完整命令范围和断言在
`/tmp/sciretriever-browser-parallel-implementation-v9ay8y23/browser-contracts-final-tests.json`。
上述第二条命令对应新增切片；第一条原有HTTP、候选恢复与Web测试还由07最终Full统一验收。

`ProductionWorkbenchSession`登记Scheduler的纯身份queued行，再按registered/open绑定同一
execution和page；所有clients各自选择，最多64个运行/结束投影并只淘汰已关闭记录，
与既有completion cohort支持范围一致；第65个活动投影明确拒绝。等待行
无observation时可明确单篇cancel，不可接管或输入；多会话不选中时无默认前台操作目标。
`POST /api/sessions/select`、SSE/view、带session_id的frame和所有明确绑定指令均投影同一篇。
候选捕获按capture.session_id路由，不按currentTarget或页面前台猜测，选择不改变控制epoch或预算。
启动新的Workbench操作只清理已关闭的旧投影，不清除其它queued/opening会话的候选缓存；
直接回归从缓存、启动新操作到真实factory admission后持续验证同一候选仍可见。

真实HTTP测试令A人工接管、B后台传输，验证旧A决策被拒绝、B仍可交付、候选/指导/截图及预算隔离，
A单篇取消不终止B，B最终published receipt_id可见；另覆盖初始queued A的选择和单篇取消，
B下载和预算不变。真正factory的navigation signal只中止该文章，cohort signal不被abort。
可控时钟证明人工操作、重复人工命令及600秒人工等待不计Agent调用/动作/活跃时间，交回控制后预算不重置。
同一指导ledger在真实派发时只消费该请求包含的ID，permit等待期间新增指导不会被错误标为consumed。

`parallel-live-workbench.test.ts`使用真实本地Chromium、正式HTTP适配和打包live.ts，1/1通过：
未选择不能接管；A控制时B下载；选B不取得其控制权；B保留有效候选与publication错误可见；
返回A只显示A的预算/候选及原控制者；最终A的published receipt与后续资源清理稳定失败code并列
可见，独立`session_cleanup_failure`不改写已发布outcome或Library事实。关闭或切换session会清旧帧，迟到decode必须重新核对
session/page/frame才显示；模型、前端及DTO不含Cookie、敏感query或文件绝对路径。
此项证明真实Web适配，不假称验证了实际Cloak的人类A/B控制或writer进程收尾。

`browser-publication-lease.test.ts`正式Application/Storage三场景3/3通过，覆盖成功发布、publication
错误与发布后cleanup错误；后两者不重新下载、不销毁有效candidate/receipt，也不撤销已确认primary PDF。
Browser flow直接错误矩阵另覆盖资源/reader稳定失败及远端传输失败恢复后Stop，正式Completion都
不写自动耗尽。metadata/CAS和实际Cloak文件链继续由04/07的原事实owner验收。

最终源码构建 `pnpm exec tsc -b --pretty false` 和测试严格类型检查
`pnpm exec tsc -p tsconfig.tests.json --pretty false` 均exit0，自有文件ESLint通过。
此前的cdp-owner、scheduler和Host override类型缺口已由原owner修复；最终Quick/Full结果只在07追加。

已打包的正式安装旅程 `installed-public-journey.test.ts` 使用实际tarball离线安装和本地HTTP/UI，
最终1/1通过，证据 `/tmp/sciretriever-browser-parallel-implementation-v9ay8y23/browser-installed-journey-final.json`。
其合成transport按正式生命周期通知真实派发，模型fixture只读取需要的Agent投影字段；
不把保留bytes兼容字段的公开Workbench parser套用到已去除该字段的模型输入。

### 最终计划覆盖审计（最终Full待主执行者）

| Task | 已证明范围                                                                                                                                                                                                                                                                       | 证据边界                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6.3  | queued取消不建页、opening及模型/动作等待撤销有直接/HTTP证据；实际17MiB下载取消使源站停止；正式App+Cloak+Workbench单篇接管/cancel A而B继续发布；candidate-ready取消保留durable候选且不发布；活动generation替换拒绝迟到候选并保留30秒冷却；Application退出取消真实受管reader子进程 | 单篇控制测试未abort cohort；reader场景由Entry/App lifetime触发，不冒充人类单篇按钮与reader的全部组合                                                   |
| 6.4  | 实际Page.crash保留局部`browser-page-crashed`且shared loss=0，B原生捕获及hash正确；正式模型HTTP503只终止A、B发布；共享Browser失联收敛模型/120秒WaitForChange，保留已发布论文；direct scheduler还覆盖queued票和delivered lease                                                     | shared失联生产场景没有在途17/513MiB native writer；实际native整体停止另由6.6的Application退出场景证明                                                  |
| 6.6  | 实际App.close在reader验收中传播寿命signal、等待SIGKILL/close后返回并保留durable候选；实际Cloak慢native、模型HTTP、120秒等待与已发布论文共存时153ms关闭，返回时12个Chrome/Xvfb无活体、writer已终止、目录与额度清理、Profile锁可重取；Playwright persistent close有30秒后kill兜底  | reader可执行入口采用长活Node协议fixture，未声称实际pdfinfo算法进程挂起实测；未注入Browser永久卡住来实测30秒kill兜底，兜底归Playwright现有process owner |

`browser-runtime-loss-production.test.ts`最终实际Cloak场景1/1通过，精确证据：
`/tmp/sciretriever-runtime-loss-evidence-HjVI9G/evidence.json`；前次审阅记录：
`/tmp/sciretriever-browser-parallel-implementation-v9ay8y23/browser-runtime-loss-review.md`。
调用方未abort，真实模型HTTP in-flight屏障后隔离Profile对应Browser.close已ACK并观察到shared loss，
48.42ms后Completion自行返回，report为先前published1、failed2、无interrupted；
model为`pdf-browser-runtime-lost`，waiting保留更早确认的`pdf-browser-page-closed`。
独立通道没有全序，不能把局部page-closed改写成共享失联或用额外sleep统一原因。
先前published receipt/asset/hash保持，三个execution最终closed，各类临时额度0，失联后无新模型派发。
该场景没有运行中17/513MiB native writer，也不是Application.close慢下载/reader验收；二者的实际退出证据见下文。

`browser-control-production.test.ts`通过正式`startProductionWorkbench` HTTP、verified Cloak、普通loopback模型HTTP
以及原Intake/acceptance/publication/Library/导出路径，三场景3/3通过：模型在途时接管撤销A旧响应、
candidate-ready时接管并单篇取消、A模型503而B继续发布。前两者均只取消A，cohort signal不abort；
A不发布、B正式发布并导出hash一致，candidate-ready的有效候选可按原transfer_id恢复。
503稳定报告`pdf-browser-flow-failed`，A无PDF请求。各场景A均不写自动耗尽、临时额度0。
纯转发`BrowserArticleScheduler.prototype.deliver` spy只观察正式owner，正常Completion结束后
`sessions/queued/workers/platform_active`均为0，未增加product公开API。
精确证据为 `/tmp/sciretriever-control-evidence-CDEkLR/evidence.json`、
`/tmp/sciretriever-control-evidence-lEE1qK/evidence.json`、
`/tmp/sciretriever-control-evidence-JIlJaT/evidence.json`。

candidate-ready场景曾直接复现HTTP已显示cancelled但Entry仍发布A的缺陷：Browser单篇signal未越过交付lease进入验收。
修复将lease的文章寿命与caller/Entry lifetime合并传给acceptance，并让Entry.close先取消、等待所有已开始验收收尾。
acceptance中止准确返回cancelled；已有成功publication先确认published，随后lease abort或cleanup错误不撤销事实。
只增加内部生命周期句柄，不新增队列、公开DTO、schema或持久事实owner。
`browser-parallel-scheduler.test.ts`新增活动代次替换的直接回归，旧generation abort与close一次、迟到候选失效，
replacement在29,999ms不建页、30,000ms才获同平台准入；过时代次请求不建页。
包含scheduler、publication lease、Entry/App生命周期与Completion的五文件61/61通过，证据
`/tmp/sciretriever-browser-parallel-implementation-v9ay8y23/browser-acquisition-lifecycle-final.json`。

实际Cloak `Page.crash`局部隔离最终1/1通过，证据
`/tmp/sciretriever-owned-sessions-9ClPjr/crash-evidence.json`；A为`browser-page-crashed`、shared runtime loss为0，
B继续正常snapshot/原生捕获，SHA256一致，各类临时额度0。

最新`target-inactive`收尾修复的实际Cloak场景1/1通过，证据
`/tmp/sciretriever-owned-sessions-2WyJfg/stop-fallback-evidence.json`。
选中A的`Page.stopLoading`协议失效时没有虚假释放请求；Host独立取消A native并关闭其page，
观察到真实`target-destroyed-a`与源站script/native关闭、drain完成后才清表，B继续native下载并捕获正确hash，额度0。
`browser-session-cleanup.test.ts`新增两个离线失败保留回归2/2，失败cause保留、重复close不能假成功；
CDP/runtime-loss scheduler相关三文件18/18。主执行者的platform quarantine/flow错误分类切片五文件91项通过并冻结，
未确认cleanup的会话保留隔离资格、同平台等待项收到稳定失败，不永久等待或越过安全边界。
Host实际成功收尾与失败隔离是两条互补路径；这里不将fallback绿色写成真实Elsevier handoff已成功。

Flow的现有`options.close`/`ArticleFlowPageSource.close`明确为文章owner完整关闭：只有owned page、native writer及
请求真实终止并drain后才能resolve。该owner成功时可覆盖更早的cooperative stop错误，避免已确认结束仍被误报cleanupFailed；
缺少owner或owner close失败时仍保留原stop与close cause、幂等close继续失败并按原scheduler quarantine。
直接回归先红后绿，完整owned close的barrier释放前不确认结束，成功后保留先前acquisition稳定失败；
真正失败的owned close仍保留有效candidate字节和独立cleanup错误。最终flow66/scheduler13/publication3共82/82，
JSON为 `/tmp/sciretriever-browser-parallel-implementation-v9ay8y23/browser-owned-close-lifecycle-final.json`。

`browser-shutdown-production.test.ts`生命周期修复后完整2/2通过。
reader场景不abort caller，由正式Application/Entry lifetime中止真实`readPdfTool`管理的外部子进程，
约17.04ms返回时signal已abort且SIGKILL/close已发生，稳定原因`pdf-reader-cancelled`。
readonly catalog重开后durable候选与原对象相同、文件hash保留，无primary/exhaustion误写、临时额度0。
只将pdfinfo可执行入口替换为长活Node协议fixture，未替换受测reader、Entry或acceptance。
证据 `/tmp/sciretriever-shutdown-reader-evidence-E1mcdB/evidence.json`。
实际Cloak场景同处一个Application：慢native下载、在途模型HTTP、120秒WaitForChange以及先前已发布论文；
App.close约153.34ms返回，源站writer在EOF前停止、模型HTTP断开、全部12个受管Chrome/Xvfb无活体，
native/staging/preparation/temporary额度均0、原Profile保留且锁可重取、只读重开与导出hash确认已发布事实不变。
证据 `/tmp/sciretriever-shutdown-production-evidence-rsnG4N/evidence.json`；审阅记录
`/tmp/sciretriever-browser-parallel-implementation-v9ay8y23/browser-shutdown-production-review.md`。

BrowserHost整体关闭先中止会话并关闭persistent context，以共享process终止确认native writer结束，再settle并清理目录/锁。
既有Playwright1.55.0的persistent `CRBrowserContext.doClose`调用`Browser.close`，其`browserProcess.close`
使用`closeOrKill`：默认30秒graceful close失败或超时后升级为process kill并等待退出。
SciRetriever保留原process owner；退出异常与未结清理由Host/driver稳定code及Application多错误聚合报告。
永久卡住触发30秒兜底未单独注入，不能从正常153ms退出扩大成该路径已实测。

## 退出条件

用户能够选择并控制正确文章，其它会话不受无关操作影响；所有失败/取消矩阵有直接和必要的真实Browser证据。
Application退出完成确定性收尾，保留Profile及已提交事实；现有操作结果、观察和前端投影一致。

## 恢复与交接

错会话操作属于阻断问题，先停止自动派发并保存session/page/control epoch事件序列，回02/6.1定位，不补页面坐标例外。
收尾失败保留确切未结资源及owner，不以整体删除临时目录代替终止写者。
07接收HTTP/Web、故障、退出和原有候选恢复的明确矩阵及未覆盖限制。

## 2026-10-07最终收口

本块实现、直接回归与必要生产对象图证据已并入最终验收；Full189文件/1,266项通过、39项条件跳过、build通过。
最后源码清单142项、hash55a59148dcabd9d2a8345d8b4c9b689831b92307bcc6f04e1bab726306fc0c01。
具体版本、影响审查、逐出版社结果和外部未决范围见[最终验收记录](../../notes/browser-final-acceptance-2026-10-07.md)。
此前记录保留其发生时的版本与结论；当前块状态以上述最终收口为准，不将历史失败改写为当时通过。
