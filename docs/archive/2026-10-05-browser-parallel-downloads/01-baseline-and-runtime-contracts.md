# Block 01：基线、关键适配与运行合同

> **状态**：Completed（2026-10-07最终验收；外部访问限制见Block07） · **Owner**：主执行者 · **上级计划**：[README](README.md)
> **前置**：用户确定的方向、当前工作树和可读取的Accepted ADR
> **后续**：[02 会话隔离](02-session-ownership-and-browser-isolation.md)、[03 决策循环](03-agent-pacing-and-suspension.md)、[04 文件链](04-background-download-and-publication.md)、[05 调度](05-platform-scheduling-and-configuration.md)

## Outcome

实施者取得三类可交接输入：当前串行生产路径的基线；实际Cloak在首次导航/弹窗归属和下载进度/取流上的证据；
明确的会话、事件、取消、平台与发布交接合同。后续实现不会依赖“Playwright应该能做到”的未验证假设。

本块允许技术验证发现缺口，但不能以降低归属要求、提前放行出版社首请求或恢复整文件缓冲来消除缺口。
没有形成可靠适配证据的能力保持未完成，后续只能推进已具备前提的Task。

## 进入条件

核对仓库AGENTS/HARNESS、根计划、已有dirty diff及适用ADR。验证使用现有Node/pnpm、已校验Cloak和隔离本地服务；
不读取用户Profile、个人配置原文或真实catalog。本块不修改服务器DNS、不触发新的真实出版社压力测试。

## 责任边界与基线位置

- Entry：`entry/pdf-acquisition.ts` 的scheduler/broker、Browser波次和acceptance调用方。
- Browser：`host.ts`、`production-host.ts`、`article-flow.ts`、`transfers.ts`、`transfer.ts` 的页面和传输责任。
- 组装：`bootstrap/application.ts` 的当前Intake target、candidate、flow和协作回调。
- 文件与政策：Acquisition验收、Storage staging/reader/publication、Network budget及Configuration。
- 本块不默认启用并行，不把探针脚本作为长期生产实现；被证明必要的adapter能力由02/04正式接入。

## Tasks

- [x] **1.1 固定可恢复基线。** 在实施证据目录保存实际HEAD、分支、文件清单和任务相关diff摘要；
      标注已有未提交修改，不复制凭据/资产。运行当前会话、调度和候选关键测试，逐项记录失败是既有问题还是本次前置缺口。
      **输出/验收**：下一执行者能定位同一patch范围、测试命令及限制；未运行或失败的基线不会被写成绿色。
- [x] **1.2 证明首次请求的会话与平台归属。** 使用两个独立本地origin模拟DOI→文章302、同页跨域跳转、
      两页同时开popup、脚本自发popup、首响应即PDF和页面在首次请求后才出现的情况。
      记录route、frame/opener、CDP可用事件和实际服务收到请求的顺序；检测等待归属事件是否形成自锁。
      **输出/验收**：在请求继续前取得唯一归属及平台准入，或在无证据时明确拒绝；前台切换不能改变归属。
      不能仅在commit之后发现已超额，也不能把任意同时出现的URL按时间匹配给当前会话。
- [x] **1.3 证明下载进度与有界取流。** 本地服务分别返回原生attachment、inline PDF、fetch得到的PDF和HTTP跳转，
      提供慢于30秒、先停顿再继续、无Content-Length和中途断开的响应。
      验证native下载可读句柄的取得时点、单transfer进度事件、浏览器临时文件的归属、PDF response流式路径及取消后的真实退出。
      **输出/验收**：说明每条通路如何取得字节和进度，不把`createReadStream()`必定实时返回当作前提；
      若某通路只能整块读，记录安全小文件边界，大文件对应Task继续Pending，不假报整体支持。
- [x] **1.4 固定会话和事件owner。** 定义session与operation/generation、文献、page/opener、transfer、candidate的不可变关联，
      明确started/progress/completed/failed/closed如何传递、去重以及由谁释放资源。复用现有typed边界，不把Page/CDP或路径交给模型。
      **输出/验收**：列出生产者和消费者，以及A取消、B前台、迟到A下载三者交错时每项事件的唯一处理者；
      工作台和自动模式消费同一会话时钟/控制epoch，不建立第二份权威状态。
- [x] **1.5 固定暂停、预算、平台和发布交接语义。** 明确下表事件和计数口径，包含失败恢复是否消耗start窗口、
      网络结束与本地验证的区别、排除hash和错误分类。保持Entry的最终获取结果合同；Browser可先交付候选和内部会话释放责任，
      Entry调用原acceptance/publication后在finally中通知结束。**禁止Browser等待其调用方尚无法开始的publication而不返回候选。**
      **输出/验收**：一条成功、一条传输失败恢复、一条publication失败、一次取消的时序均能走到资源结算，无循环等待。
- [x] **1.6 同步架构与配置合同。** 修订ADR0023全局lane假设和ADR0030共享限流/传输生命周期；检查ADR0012/0015残留的
      “持有到全部临时文件清理”表述，明确网络资格可在传输结束后释放但文件/会话责任仍保留。
      更新决策索引及受影响technical，标明目标/实施状态；配置兼容细节交给5.5，不把未实现行为写进已发布指南。
      **输出/验收**：决策、owner、错误和持久边界无相反定义；不引入新文献状态或隐式迁移。
- [x] **1.7 固定跨块样本与断言。** 整理后续重复使用的A/B/C平台、错误页、slow PDF、重复下载、空白/损坏文件、
      可控时钟、取消和metadata变更场景，注明真实Browser与fake各能证明什么。
      **输出/验收**：每个样本有目标断言与归属块；少量有代表性的fixture即可，不按出版社数量复制页面脚本。

## 需要交接的事件口径

| 事件/资源             | Owner与语义                                                              | 后续消费者 |
| --------------------- | ------------------------------------------------------------------------ | ---------- |
| 一次Agent决策         | 会话被独占领取，真实模型派发才计call；迟到结果需重验代次/phase/控制权    | 03、06     |
| 平台start             | 第一次获准文章网络访问；失败恢复重新取得资格也计数，普通5秒调度不计      | 05         |
| 网络活动结束          | 本次访问/传输实际结束，保留页无资格时不能后台继续访问；启动30秒冷却      | 02、04、05 |
| candidate ready       | Acquisition已确认文件，尚不代表文献publication完成                       | 04、06     |
| publication committed | 原事实owner完成CAS/receipt提交；可以释放文章会话，后续清理失败不撤销资产 | 04、06     |
| 主动/整体取消         | 单会话取消只影响自己的决策/传输；Application关闭才取消所有未完成会话     | 03、06     |

## 集成与影响

本块冻结的是后续实现可依赖的合同和证据，不新增公共job/queue API。配置原值、候选/receipt格式和现有资产仍可读取。
若必须新增PSL等适配依赖，记录所需能力、现有能力为何不足及生产安装影响，再由对应实现块集成。

## 验证

已有基线入口：

```bash
pnpm exec vitest run apps/server/test/pdf-acquisition-scheduler.test.ts apps/server/test/browser-host.test.ts apps/server/test/browser-candidate-journey.test.ts
```

真实Cloak只运行本机合成服务，先确认bundle确实可用，再执行：

```bash
SCIRETRIEVER_CLOAK_BUNDLE="<已校验的bundle绝对路径>" pnpm exec vitest run apps/server/test/browser-production-loopback.test.ts apps/server/test/production-workbench-loopback.test.ts --maxWorkers=1 --no-file-parallelism
```

现有测试未覆盖1.2/1.3的部分由本块新增直接场景；没有设置bundle而被skip不能算通过。
日志需记录实际runtime版本、请求顺序、文件hash、传输结束和清理结果；不保存Cookie、临时签名参数或凭据。

## 当前证据

1.1–1.6已完成；运行时探针与合同证据见下，1.7由主执行者汇总跨块fixture后继续更新。实施起点的源码显示全局归属和整块文件路径确实存在，前轮Opus两轮讨论提供了风险清单，
不等于技术探针通过。讨论采纳会话槽约束下载、2个worker及逐会话settle；未采纳前台锁推测popup、首请求先放行、
用CONNECT活跃代替文件进度、接受但不执行配置以及把小文件兼容路径写成通用大文件支持。
执行时在本节追加Task ID、revision/patch、命令、结果与证据目录。

## 退出条件

关键适配能形成安全归属和字节接管，或准确限定未通过范围；进入对应后续Task的证据已具备。
owner、事件、预算、平台start、candidate/publication交接及架构修订一致；没有未归属的取消或文件责任。

## 恢复与交接

探针失败停在本块，不默认提高并发、延长全部timeout或绕过准入。保存最小复现和原始事件顺序，再修改适配方案。
02接收归属证据与事件身份；03接收单会话phase/计时/取消合同；04接收取流与资源证据；05接收平台和配置口径。
不得以清理工作树恢复基线；恢复先核对1.1记录及现有用户改动。

### 1.1 基线证据（2026-10-05）

HEAD `dd2df24e8a44e9c425f7b703a849ac4d04ac6fc5`，master上的已有dirty工作树。
证据目录 `/tmp/sciretriever-browser-parallel-implementation-v9ay8y23/` 包含 baseline.patch、按路径SHA256及原文件副本、baseline-tests.json。
7个离线文件/80项测试通过，耗时16.19秒；命令与范围在baseline-tests.json。未运行新并行场景或Full，不把此结果作为后续块证据。

### 1.2 首次请求和文档归属证据（2026-10-05）

校验后的 Cloak `146.0.7680.177.5` / Playwright `1.55.0` 在临时合成 Profile、本地 HTTP 服务与
隔离 Network proxy 上取得真实事件证据。逐 target 启用 Fetch 的反例保存在
`/tmp/sciretriever-navigation-ownership-bK9jjw/events.json`：popup 首请求可以先于新 target 的协议域就绪。
Browser-root Fetch 对照在 `/tmp/sciretriever-navigation-ownership-4o9okd/events.json`、
`/tmp/sciretriever-navigation-ownership-CmrgaC/events.json`、
`/tmp/sciretriever-navigation-ownership-Vevj3V/events.json`；正式 Host 不再等待将由首请求本身产生的 page 事件。

`browser-owned-sessions.test.ts` 的 10 项真实 Cloak 场景全部通过，包含三轮 A/B 同 URL popup 不同 hash、
后台 A 继续完成、同时脚本 popup、父文章关闭后 held 首请求零发送、A 关闭不等待 B 的 native 下载、
慢导航不占用 B 输入、旧动作拒绝、共享失联稳定原因和 native 配额真实取消。
三轮最新 hash/归属证据分别为 `/tmp/sciretriever-owned-sessions-fxN8Hl/events.json`、
`/tmp/sciretriever-owned-sessions-RTG8Xe/events.json`、`/tmp/sciretriever-owned-sessions-VL6YXH/events.json`。

`browser-document-host.test.ts` 在同一实际 Host/Scheduler 上证明 DOI 初始 302、OOPIF/iframe/CDN、
跨平台撤销旧文档资格、新平台 commit 后授予资格、显式返回父页/历史页恢复，以及顶层与 nested dedicated Worker
的 creator 文档冻结。旧 Worker 请求在服务端计数为零；活动 Worker fetch 停止后服务端连接关闭，
对应请求得到 ended 且目标实际销毁。最终 Cloak 1/1 证据为
`/tmp/sciretriever-document-host-kOd3Kp/events.json`；显式 stock Chromium 同一场景也 1/1 通过。

终态关联使用 exact Network ID、frame/loader 和实际目标证据：302 下一 hop 保留同 loader 的导航事实；
OOPIF renderer 转移不因 protocol session 改变遗漏终态；nested Worker startup 在祖先 Page 发起、
以该 Worker target token 作为 Network ID 并在 Worker session 结束的形态也有真实反例与直接测试。
不能单凭 protocol detach 清空请求；普通响应等待 Network terminal 或真实 targetDestroyed，native writer 独立等待
downloadProgress。证据反例为 `/tmp/sciretriever-document-host-71fGhu/diagnosis.json`。

实际运行命令：

```bash
SCIRETRIEVER_CLOAK_BUNDLE=<已校验bundle> pnpm exec vitest run apps/server/test/browser-owned-sessions.test.ts apps/server/test/browser-document-host.test.ts --maxWorkers=1 --no-file-parallelism
SCIRETRIEVER_CLOAK_BUNDLE=<已校验bundle> pnpm exec vitest run apps/server/test/browser-document-host.test.ts --maxWorkers=1 --no-file-parallelism
SCIRETRIEVER_BROWSER_EXECUTABLE=<本机已安装Chromium> pnpm exec vitest run apps/server/test/browser-document-host.test.ts --maxWorkers=1 --no-file-parallelism
```

第一条组合命令的 owned 10 项通过，但当时新增的 Worker terminal 收紧使 document 场景超时；
保存反例后按真实 target token 修复，最后两条 document 重跑均通过，未增加 timeout 或绕过准入。
最新直接单测覆盖 15 项 CDP owner（含 OOPIF 父关系早/晚两序）和 7 项文档 admission；
相关静态检查与服务器构建由 Block 02 记录，最终 Full 由 Block 07 汇总。

### 1.3 下载进度与原请求取流证据（2026-10-05）

`browser-streaming-probe.test.ts`在校验后的Cloak `146.0.7680.177.5` / Playwright `1.55.0`上实际运行7/7通过，
使用临时合成Profile、下载目录和本地HTTP服务；没有真实出版社、个人配置或凭据。
命令为 `SCIRETRIEVER_CLOAK_BUNDLE=<已校验bundle> pnpm exec vitest run apps/server/test/browser-streaming-probe.test.ts --maxWorkers=1 --no-file-parallelism --reporter=verbose`。
最终事件与hash证据在 `/tmp/sciretriever-browser-streaming-probe-E7HRni/evidence.json`；初始缓冲代理证据保存在
`/tmp/sciretriever-browser-streaming-probe-QrJub1/evidence.json`，失败后修正事件等待的记录也予以保留。

Browser级公共CDP session的 `Browser.setDownloadBehavior(allowAndName, eventsEnabled)`返回frameId和GUID，
`Browser.downloadProgress`在EOF前约每500ms报告该GUID的实际新增字节。无Content-Length时 `totalBytes=0`；
慢下载含4秒真实停顿，共36秒，`Download.createReadStream()`和`Download.path()`直到完成才返回。
原件通过已确认GUID定位，不能按目录中新出现的文件猜归属。取消、源站中断和错误Content-Length均得到失败终态；
真实取消停止服务端写者。终态可能晚于`download.failure()`，且receivedBytes可能重置为0，owner必须保留最大观测值。

生产PDF外开preference下inline导航及HTTP 302到inline PDF均走native。
fetch响应通过同请求的 `Fetch.takeResponseBodyAsStream` + 顺序 `IO.read(size=65536)`在EOF前取得字节，
合成session header保留，源站只收到一个GET，完整hash一致；EOF或取消后 `IO.close` + `Fetch.failRequest(Aborted)`使原写者结束。
接管后原请求不能继续，页面收到handoff失败是该协议的实际结果。`Network.streamResourceContent`仅作为push事件探针记录，
未用小文件事件宣称其大文件内存有界。

HTTP代理修改前Cloak在源站EOF后才收到download；流式代理修改后，源站首块51882.18ms、Browser download 51889.56ms、
源站EOF 52235.18ms，hash仍一致。此探针证明适配机制和进度，不替代04的真实大文件、进程树内存、磁盘预算及生产owner验收。

### 1.4–1.6 会话与交接合同证据（2026-10-05）

`browser/article-session.ts` 固定 session/operation/generation/Literature/metadata snapshot，
Browser 的 page/opener/transfer 归属不依赖前台选择。Browser dispatcher 产生 started、completed
和 failed；Bootstrap 按 capture.session_id 交给同一执行器与 Intake batch，Workbench 只消费
session identity、执行器时钟、控制 epoch、候选和最终 outcome 的投影。候选 source 与会话
登记均先于导航；Scheduler 的 queued/cancel/removed 回调还覆盖未创建页面的排队项。

Driver 维护单调活跃时钟和一轮决策 signal，started 撤销模型而不取消传输；传输结束先停网络，
再按首次终态 cause 释放平台资格。有效 candidate 随内部 lease 返回，Entry 完成原文件接纳与
publication 后 finally close，close outcome 仅 published(receipt_id)、retained(code)、cancelled，
没有通过 Browser 等待未来 publication 或清理有效字节的循环。局部资源/reader 失败保留稳定
code；可恢复传输失败后的 Stop 也不写正常耗尽。

ADR 0012/0015/0023/0030、决策索引、requirements、principles 和 technical/03 已同步：
worker、保留会话、聚合政策、同平台网络资格和文件责任分别计量，300 秒/50 派发/100 Agent
动作与动作后至少 5 秒、网络结束后 30 秒冷却不再与全局单 lane 或墙钟预算混用。
当前 Workbench 的可选多会话消息保留旧 wire shape，未新增文献字段或持久运行状态。

直接验证覆盖 source 注册先于导航、模型队列不计时、started/迟到模型交错、原页恢复、候选
交接/关闭失败、HTTP 会话选择/单篇取消与 model-permit 队列中的指导归属。具体命令与数量
记在 Block 03/06，正式 Cloak 下载和 5.1 秒页面变化证据分别见 1.3 与 Block 03；Full 由 Block 07
汇总，此处不以局部绿色替代全量验收。

### 1.7 跨块样本交接

样本、关键断言与负责块已整理在[Block07 的跨块样本与证据边界](07-end-to-end-verification-and-handoff.md#跨块样本与证据边界)。
A/B/C不同平台、原生慢下载、17/513MiB真字节、same-URL popup、OOPIF/Worker、旧document、
空白/损坏材料、metadata CAS、可控时钟、取消和共享runtime失联分别由对应测试持有。
实际Cloak、正式Application、真实本地模型HTTP与fake时钟的证明范围分别标注，fixture不包含出版社页面脚本。
新测试验收结果由后续块记录，样本交接不替代各块的真实执行。

## 2026-10-07最终收口

本块实现、直接回归与必要生产对象图证据已并入最终验收；Full189文件/1,266项通过、39项条件跳过、build通过。
最后源码清单142项、hash55a59148dcabd9d2a8345d8b4c9b689831b92307bcc6f04e1bab726306fc0c01。
具体版本、影响审查、逐出版社结果和外部未决范围见最终验收记录（本地文件：`sandbox/reports/browser-final-acceptance-2026-10-07.md`，不随仓库分发）。
此前记录保留其发生时的版本与结论；当前块状态以上述最终收口为准，不将历史失败改写为当时通过。
