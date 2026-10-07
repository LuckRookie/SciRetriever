# Browser 并行下载实施验证（2026-10-05）

本记录属于 `browser-parallel-downloads-20261005` 的实施证据；使用已有工作树增量，不把前轮串行下载结果算作本轮验收。
运行时为固定 Cloak `146.0.7680.177.5`。本机合成服务、真实出版社验证分别记录；所有 catalog/Profile/文件均在独立临时目录。

> **当前阅读入口**：下文按实施过程保留历史结果；最新跨批矩阵见“暂停最终验收前的累计结果”。
> 普通旧文档请求终态修复及针对性验证已完成；按用户要求暂停最终全链路验收，keepalive残余限制见文末。

## 正式生产对象图的本机验证

`browser-parallel-production.test.ts` 通过真实 Cloak、Network proxy、真实本地模型 HTTP transport、Entry DatabaseCompletion、Intake、acceptance/publication 和受验证文件导出。
三个独立合成平台：C 保持原生后台下载，A/B 两个模型请求在服务端重叠；A/B 在 C 完成前发布，三篇最终 hash 正确，文章身份均为 `unverified`，临时额度归零。
A/B 第二次模型派发距上次响应超过 5 秒；没有用提高外层 Promise 并发伪装实际模型并发。

证据：`/tmp/sciretriever-parallel-browser-evidence-i9FQ9s/evidence.json`；1/1，约 17 秒。
另有独立实际 Cloak 的页面在 5.1 秒后变化并完成正式入库测试，见 Block 03。

## 大文件与中断

生产原生下载、HTTP 流、文件检查、候选恢复、不可变发布和导出已使用分块/文件边界。
17 MiB 和 513 MiB 材料均实际逐字节传输，不是 sparse 下载或大 Content-Length 加小内容。

| 样本        |         完整字节 | 行为与结果                                                         | 证据                                                                                |
| ----------- | ---------------: | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 17 MiB      |       17,826,200 | 未知长度，超过 30 秒且中间停顿；正式入库及导出 hash 一致           | `sciretriever-large-browser-evidence-7QD16R`（后续补 reader 计时复跑详见 Block 04） |
| 17 MiB 中断 |       17,826,200 | 同一文章会话恢复后重试，文章 GET 只有一次，成功发布                | `sciretriever-large-browser-evidence-AyxrSV`                                        |
| 原生取消    | 已接收 2,097,374 | 实际源站传输停止，不留下 candidate/asset/receipt/exhaustion        | `sciretriever-large-browser-evidence-w7sgx0`                                        |
| 513 MiB     |      537,919,898 | 未知长度源站约 34.87 秒，全链约 82.95 秒；hash 一致且 `unverified` | `sciretriever-large-browser-evidence-7JBVeH`                                        |

以上证据目录均在 `/tmp/`，详见各目录 `evidence.json`。
513 MiB 的 SHA-256 为 `95fbb4ceb1dde7b3815514a4974f81f64d8a67d7568e799b64ca85696f493088`。
最新采样中 Node RSS 峰值 251,609,088 字节，Node+Cloak 当前完整子进程树峰值 1,289,977,856 字节；两个实际 PDF reader 调用约 51/53 ms。
临时文件逻辑大小与账本峰值为 1,613,759,694 字节（三份），结束后临时账本归零。采样可能漏掉短峰值，native CDP 进度也有延迟；这些数值不等于内核强制内存/磁盘上限。
17 MiB 与 513 MiB 进程树峰值接近，未观察到整文件大小级 RSS 增长。完整矩阵与取流证据由 Block 04 维护。

## 真实出版社首轮发现

使用真实配置的 `qiuzk/gpt-6-luna`，通过 Configuration/Credential owner 授权模型请求，不读取个人配置或凭据原文、不复制用户 Cookie。
元数据为前轮缓存的真实 Crossref observation，重新通过 Identity owner 入独立 catalog。
此验证明确跳过 Public/API locator（测试 seam 返回无候选），其余使用正式 DatabaseCompletion → Browser scheduler → Host/Agent → Intake → acceptance/publication，证明 Browser 自身能力。

| 平台 / DOI                              | 本轮结果                                     | 模型调用 | 发现                                             |
| --------------------------------------- | -------------------------------------------- | -------: | ------------------------------------------------ |
| Nature / `10.1038/nature14539`          | PDF 正式入库，2,964,524 字节，导出 hash 正确 |        2 | PDF 成功后 session 网络 drain 超时，收尾未通过   |
| Springer / `10.1007/s12055-024-01728-3` | PDF 正式入库，1,386,174 字节，导出 hash 正确 |        2 | 同样出现 session cleanup failure                 |
| Wiley / `10.1002/advs.202200547`        | 本轮未取得 PDF，停在 challenge               |        3 | 还发生 cleanup failure；不能据此认定出版社无权限 |

首轮证据：`/tmp/sciretriever-browser-parallel-live-GP0NIH/result.json`。
单独 Nature 复现：`/tmp/sciretriever-browser-parallel-live-hPNeF2/result.json` 与 `network-drain.jsonl`。
精确残留为跨 origin iframe 的 Document 请求：Chromium renderer/OOPIF 迁移后，terminal Network 事件来自新的协议 session；旧请求记录仍只等待原协议 session 的结束事件，120 秒后成为 `browser-platform-handoff-stalled`。
修复应按同一 network request 与可信 frame/target 归属合并终态，保留真实取消/结束证据；不能降低 timeout 或直接清空请求表伪装网络已停止。
该缺陷由导航 owner 修复并需真实站点复测，当前首轮不能标为完整会话验收成功。

## 集成检查（进行中）

- DatabaseCompletion 外层长写锁已缩到冻结 scope，run/runFrozen 下载期间允许其它 catalog 写入，原冻结顺序、取消、阶段提交与 CAS 测试 42/42。
- 首次全量行为回归：173 文件通过、8 文件失败、9 文件跳过；1,116 测试通过、9 失败、26 跳过。
  失败已区分旧串行/HTTPS-only 断言、Workbench guidance 实际派发投影、Browser 请求跟踪/隐私断言以及并发负载下 5 秒测试超时，逐项修复/复核。
- 4 个 Web 文件的 6 项超时用例单 worker 复跑全部通过；不据此修改产品逻辑或放宽隐私/结果断言。
- 首次 `pnpm full` 在格式与 lint 通过后被并发实施中的 CDP 新绑定字段 test strict 缺失阻断；最终 patch 仍需重跑完整 Full。

最终结果、完整真实平台矩阵、Full 数量与未决环境原因将在当前实现稳定后补入。该记录目前不声明整份计划完成。

## 扩大矩阵暴露的通用适配问题

修正 OOPIF 终态后，Nature 单独复测完整通过，两个 network-stop 事件之间约 14 ms，结束时请求表为空；证据 `/tmp/sciretriever-browser-parallel-live-UHTpIw/`。
随后一轮 23 篇样本约 452 秒，8 篇正式入库（Nature、Springer、IOP、PLOS、AMS、Copernicus、Frontiers、MDPI），临时账本归零。
Elsevier 常规样本进入 challenge，20 次模型调用后活跃预算结束；另 14 篇在导航入口失败。这不是可接受的最终矩阵。

导航诊断证明，部分 DOI、HTTP 升级与 HSTS 重定向没有 `Fetch.redirectedRequestId`；当时的准入只识别该字段，错误拒绝了真实重定向。
例如 `/tmp/sciretriever-browser-parallel-live-s6nQTL/admission-failure.jsonl` 中 IEEE/ACS 的绑定保留真实 frame/loader，但 `source_document_id` 与 `redirected_request_id` 为空，内部报 `browser-document-network-inactive`。
这类问题采用 Network 的 exact frame/network redirect 证据和同一导航 loader 解决，不能靠替换为每个出版社的固定 URL 规避。
23 篇过程结果在 `/tmp/sciretriever-browser-parallel-live-EAqRu2/result.json`；其中 moduleHashes 是结束时磁盘快照，不能冒充整个运行的冻结模块 hash，后续 runner 已改为启动时冻结。

修复重定向后，14 篇复测的首组 ACS/RSC/Wiley/Elsevier OA 均已进入真实模型；但又发现独立 Worker 的无 frame 请求没有正确归属，可能卡住验证页。
因此 `/tmp/sciretriever-browser-parallel-live-LGDxPy/` 这一轮被有意中止（先仅关闭该临时 Profile 对应的 Browser；发现旧 Application 未能收敛后，确认只剩对应 runner/Xvfb，精确终止两者并保留证据），不将其未通过验证页的结果归为外部限制。
下一轮须在通用 dedicated-worker 归属修复并经过实际 Browser 证明后执行，保留已有 8 篇的阶段成功记录并复测受影响路径。

主动关闭旧 Browser 后暴露共享runtime故障通知缺口：Host只取消自身页面controller，没有唤醒等待中的上层execution票，旧runner持续挂起。
`harness-stop.json`记录了这次被迫收尾；它不是成功的退出验收。修复需让Host一次性通知Scheduler终止未交付票、唤醒等待并报告稳定runtime-lost，保持已发布事实；随后用正式Application故障注入重新验证。

## 共享运行时失联回归

共享 Cloak 失联现已通知 Scheduler：停止新派发，终止未交付票据，保留已交付候选的发布租约和已发布资产。
真实故障注入包含模型 HTTP 在途、120 秒页面等待和一篇先前已发布文章。精准关闭该临时 Profile 的 Browser 后，
53.79 ms 内 Completion 自行返回；调用方没有主动取消。结果为一篇保留成功、两篇稳定失败：模型等待报告
`pdf-browser-runtime-lost`，页面等待先观察到真实页面关闭，报告 `pdf-browser-page-closed`。
不同协议通道没有事件全序，不为强行统一原因而增加延迟；共享失联通知、无后续模型派发、三个 execution 已关闭和临时额度归零均有断言。

证据：`/tmp/sciretriever-runtime-loss-evidence-JuqdkV/evidence.json`，真实 Cloak 1/1；直接 scheduler/lease 14/14。
此场景没有覆盖大文件写入中的突然失联，不能用空账本的退出场景替代活跃 writer 的停止证明。

## 文档与最终集成审阅

当前指南已说明默认两 worker、五保留会话、5 秒动作间隔、300/50/100 累计预算、后台下载释放 worker、
同平台网络终态后 30 秒冷却和文件身份未验证标签。清除了配置段落中仍称“cap 必须大于 1、始终串行”的旧说明。
最终 Full 与剩余真实平台复测仍在进行；嵌套 Worker 请求终态和 Wiley 停滞诊断尚未全部闭环，不声明计划完成。

中间全量集成回归（最终修复前）使用 `VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1 pnpm full`，
Quick 通过；Vitest 182 文件通过、2 失败、12 跳过，1,170 项通过、3 失败、30 跳过，约 563.62 秒。
失败全部位于正在补充的协议归属场景：迟到 iframe 父关系、嵌套 Worker script 终态，以及对应真实 Host 回归。
这轮运行期间执行者加入了红色复现，因此不作为冻结 patch 的最终验收。日志
`/tmp/sciretriever-browser-parallel-implementation-v9ay8y23/full-final.log`；最终冻结后另存新日志并重跑。
限制 Vitest fork 数仅减少本机并发负载，未改用例 timeout、测试选择或 Full 步骤。

## Wiley 停滞的调度根因

新版Cloak诊断 `/tmp/sciretriever-browser-parallel-live-1aKi6Y/` 证明：两轮challenge后真实页面已跳转，
主document完成commit且后续XHR/script准入全部返回；同一ticket却保持`queued=1 / workers=0 / hasPlatform=true / phase=ready`。
内部调度器在跨平台导航等待期间把文章加入恢复队列，随后导航回调已取得平台资格，队列仍检查“平台必须空闲”，
于是等待自己持有的资格释放。文章时钟处于合法排队暂停状态，活跃300秒也不会解除这个死锁。

修复集中在共享Scheduler：有在途导航准入时恢复队列不发第二次申请；准入完成后明确唤醒队列；
已经持有资格的文章直接恢复决策，而非再次等待同一平台。直接回归同时覆盖另一文章先占目标平台、
原导航取得资格后恢复、最终全部permit归零，相关Scheduler/document/runtime-loss 19/19通过。
诊断run通过自身SIGTERM→AbortController正常结束，保留中断结果；并非站点拒绝或成功样本。
最新真实Wiley复测位于 `/tmp/sciretriever-browser-parallel-live-lWEiNj/result.json`：4次模型调用，正式入库2,927,270字节，导出SHA-256 `563b137e81d68fd7cdfb9a0df31db722246f4850b8de50a90a08fa7f2ca7ef74`，身份unverified，临时额度0，正常关闭。

## 实际平台冷却与限流

`browser-policy-production.test.ts`使用正式Application、Cloak和本地模型HTTP，三个场景全部通过，无skip。
慢下载期间同平台第二篇零访问，网络终态29.9秒仍零访问，至少30秒后才准入。
429有/无Retry-After两场景都在59.9秒前禁止同平台后继访问，至少60秒后放行；独立平台此前已入库。
有header时原文章仅同URL受控重试一次；无header形成明确`pdf-browser-rate-limited`，不写exhaustion。
成功文件正式Library/导出hash一致，资源归零。实测分别约40.87、99.53、97.75秒。
证据：`/tmp/sciretriever-policy-evidence-cBqrHh/evidence.json`、`/tmp/sciretriever-policy-evidence-COOcXM/evidence.json`、
`/tmp/sciretriever-policy-evidence-4u9wmu/evidence.json`。

## 23篇阶段矩阵与尚未结束的导航修复

两批去重23篇中18篇正式入库，资产总计43,317,252字节；18/18在运行内通过受控导出核对hash，身份均unverified。
前6篇取 `pScXOT/result.json` 的Nature、Springer、ACS、RSC、Wiley、AIP；其余17篇取 `xmlxNR/result.json`。
完整逐篇表、hash及版本边界先保存在 `/tmp/sciretriever-browser-parallel-implementation-v9ay8y23/live-matrix-review.md`，待定点复测后更新最终表。
96次决策入口均返回工具动作，没有未完成/error条目；旧runner未记onDispatched时间，不能用入口次数推导原始HTTP次数或派发并发。
后续runner已增加实际dispatch时间。

ACS停在挑战页并达到300秒活跃预算，RSC主导航返回429。Elsevier、Elsevier OA及World Scientific还触发内部跨站导航/收尾问题，
不能将这三个阶段结果归为站点拒绝。World Scientific的无订阅信息来自用户，本次看见登录页；未借此把内部错误改写为已证明无可用公开PDF。

`xmlxNR`使用显式execution cohort23、Browser默认2 workers/5 sessions及30秒平台冷却；作用是让等待中的文章不挡住其余样本进入队列，
没有提高Browser或模型并发。run在约799秒结束，exit0；所有临时账本为0，记录的Node/Chrome/Xvfb PID+start ticks已核实退出，Profile锁/endpoint均移除。
`pScXOT`在发现内部阻塞后由operator停止，后续未开始项不计失败；其有效文件仍完成正式导出核对，旧Application退出曾报error，详细边界见harness-stop.json。

中间Full `full-final-2.log`实际exit0：186文件通过、14文件按环境跳过，1,184项通过、37项跳过，470.17秒；之后仍补充了异常owned-close合同与导航恢复，
它不是最终修改全部冻结后的唯一质量结论。最终Full需在剩余修复后执行。

### 跨站准入环的真实复现

`sciretriever-document-handoff-pkCHch`与`sciretriever-document-handoff-xwilub`的合成Cloak页面证明：
旧第三方script持续传输时，暂停的新主导航在等待旧网络drain；释放旧EOF后才出现drain-exit、新站请求和commit。
另一次真实stop会同时取消旧script和暂停的新导航，不能简单在drain前加stop并继续原Fetch请求。
正在实现仅针对已准入GET、保留同Page/context/预算的一次受控恢复；POST不改为GET，旧请求仍要求真实停止证据。
终态收尾方面，Host已在停止命令失败后继续执行真实writer取消和owned page关闭，并等待实际target/network终态；
Flow只有在完整owned close成功后才能覆盖更早stop错误，真正关闭失败仍保留错误和隔离资格。

## 暂停最终验收前的累计结果（A/B/C/D）

以下是本次旧文档终态 bug 修复**之前**已运行的结果，不是修复后冻结版本的一次完整矩阵。
用户要求当前 bug 修复及针对性回归完成后停在最终全链路验收；后续真实复测与最终 Full 保持待继续。

| 样本             | DOI                                        | 采用批次 | 模型决策记录 | 正式 PDF 字节 | 结果 / 原因                                              |
| ---------------- | ------------------------------------------ | -------- | -----------: | ------------: | -------------------------------------------------------- |
| nature           | `10.1038/nature14539`                      | A        |            2 |       2964524 | 正式入库，导出 hash 一致，身份 unverified                |
| springer         | `10.1007/s12055-024-01728-3`               | A        |            2 |       1386174 | 正式入库，导出 hash 一致，身份 unverified                |
| acs              | `10.1021/acsami.4c13590`                   | A        |           13 |             — | 挑战页 / 403，活跃预算结束                               |
| rsc              | `10.1039/c4cp05552g`                       | A        |            2 |             — | 主导航返回 HTTP 429                                      |
| wiley            | `10.1002/advs.202200547`                   | A        |            4 |       2927270 | 正式入库，导出 hash 一致，身份 unverified                |
| elsevier         | `10.1016/0003-2670(70)80042-3`             | D        |            5 |             — | 内部旧文档请求记录未结清，导航恢复失败；待本次修复后验收 |
| elsevier-oa      | `10.1016/j.apsadv.2021.100072`             | C        |            1 |       2502468 | 正式入库，导出 hash 一致，身份 unverified                |
| aip              | `10.1063/5.0341530`                        | A        |            2 |        153057 | 正式入库，导出 hash 一致，身份 unverified                |
| iop              | `10.1088/1742-6596/2977/1/012017`          | B        |            3 |       5341907 | 正式入库，导出 hash 一致，身份 unverified                |
| oxford           | `10.1093/ced/llae535`                      | B        |            6 |        936785 | 正式入库，导出 hash 一致，身份 unverified                |
| science          | `10.1126/sciadv.ads8033`                   | B        |            4 |       1220404 | 正式入库，导出 hash 一致，身份 unverified                |
| plos             | `10.1371/journal.pmed.0020124`             | B        |            2 |        255629 | 正式入库，导出 hash 一致，身份 unverified                |
| aps              | `10.1103/physrevlett.116.061102`           | B        |            3 |        862757 | 正式入库，导出 hash 一致，身份 unverified                |
| acm              | `10.1145/3065386`                          | B        |            6 |       2570670 | 正式入库，导出 hash 一致，身份 unverified                |
| ieee             | `10.1109/5.726791`                         | B        |            2 |        930388 | 正式入库，导出 hash 一致，身份 unverified                |
| annual-reviews   | `10.1146/annurev-statistics-042720-125902` | B        |            4 |        626258 | 正式入库，导出 hash 一致，身份 unverified                |
| ams              | `10.1090/proc/14032`                       | B        |            3 |        200948 | 正式入库，导出 hash 一致，身份 unverified                |
| copernicus       | `10.5194/gmd-16-4937-2023`                 | B        |            1 |       7667870 | 正式入库，导出 hash 一致，身份 unverified                |
| frontiers        | `10.3389/fnins.2019.00425`                 | B        |            1 |       9134381 | 正式入库，导出 hash 一致，身份 unverified                |
| mdpi             | `10.3390/s19092045`                        | B        |            4 |       4607534 | 正式入库，导出 hash 一致，身份 unverified                |
| pnas             | `10.1073/pnas.1118373109`                  | B        |            2 |       1055855 | 正式入库，导出 hash 一致，身份 unverified                |
| royal-society    | `10.1098/rspa.2012.0459`                   | B        |            4 |        474841 | 正式入库，导出 hash 一致，身份 unverified                |
| world-scientific | `10.1142/s0219024910006066`                | C        |           24 |             — | 最后停在登录要求，活跃预算结束；清理正常                 |

共19/23篇正式交付，45,819,720字节，19/19发布/导出hash一致；跨批结果不能外推所有文章的成功率。
A/B旧runner未记录实际dispatch时间；C/D已记录。表中100条采用的决策记录均有模型工具动作和结束记录，
不将其等同于包含底层重试的全部HTTP次数。

批次：A=`pScXOT`，B=`xmlxNR`，C=`JKCfmB`，D=`4dzQmL`，均位于 `/tmp/sciretriever-browser-parallel-live-<批次>/result.json`。
C/D真实模型为`qiuzk/gpt-6-luna`，Cloak为`146.0.7680.177.5`，九个关键模块hash相同；
两批均自然结束exit0，`closed.json`的sessions/queued/workers/platform_active及文件临时账本全部归零。
完整逐篇hash、批次时间、模块版本和限定审计见 `/tmp/sciretriever-browser-parallel-implementation-v9ay8y23/live-matrix-review.md`。

本次bug修复前的Full：`full-release.log`，exit0；188文件通过、14文件环境跳过，1,202测试通过、37跳过，558.27秒，构建通过。
对应源码/测试/依赖清单`final-source-manifest-v3.json`共139项，hash `bfe094c17857d3b232c4ac6f07f62910556fa77d7da9e8797aa872fbb01baea8`。
该Full不能替代之后旧文档终态修复的最终全量验收。

## 当前旧文档请求终态 bug 的根因与修复

单篇 Elsevier 的精确日志证明：GET 恢复已执行，但来自更早 loader 的普通 Script/XHR 记录仍在，
不是 POST 重放边界，也不是下载守卫阻止了恢复。`4dzQmL` 的两次网络收敛均等到120秒，最后正式关闭页面才结清。
本机真实 Cloak 的 `A → 同平台 A2 → 跨平台 B` 重现同一结构：旧脚本服务端连接已经关闭，
默认 Runtime context 被清除，新 loader 已 commit，但没有对应 Network terminal，B 被旧记录阻塞。
初始反例证据在 `/tmp/sciretriever-old-loader-probe-lNw5Z6/held-headers.json` 和 `held-noheaders.json`；
新增正式用例的修复前失败证据在 `/tmp/sciretriever-document-handoff-GVInTF/events.json`。

修复限定在 Browser/CDP 生命周期适配：

- 只有同一 frame/loader 默认 context 已失效且不同 loader 已提交，才结清精确 target/protocol session 下的普通 Script/XHR。
- 退休资格还要求同一请求的 Network 类型与 root Fetch 类别一致且为 Script/XHR。真实 Cloak 的 keepalive Fetch
  在 Network 中为 `Fetch`，root Fetch 中却为 `XHR`；单凭拦截类别会误退休，保护性回归必须保持 EOF 前请求仍存活。
- Fetch、Other、native 与已接管的 IO PDF 不使用该退休规则；无证据时继续等待，不按 URL、时间或前台页面猜测。
- 明确 `Fetch.responseErrorReason` 是另一种真实失败终态。取消旧文档后，释放失败响应可能得到已注销 interception；
  仅精确 `-32602 / Invalid InterceptionId.` 作为幂等收敛，其它协议错误仍报告，原生/IO writer 保留自己的终态。
- 普通 server reset 的 `continueResponse` 实测可以成功；不能泛称所有失败响应都无法继续。问题是取消文档时的两条终态路径，
  不是出版社脚本、HTTP方法或超时参数问题。

修复后针对性验证与停止状态见下文；历史 Full 与真实出版社结果不自动覆盖新 patch。

### 保留的 keepalive 终态限制

正向分类修正后，真实测试证明 keepalive Fetch 不会因 A2 文档提交而提前退休；EOF前服务端socket仍开，
原记录存在且B未访问。但某些旧文档 keepalive 在服务端EOF后仍没有Network或Fetch失败终态，当前owner继续保守等待。
`/tmp/sciretriever-document-handoff-seAkpN/events.json` 保留了这一未通过后续B导航的现场，不能删除或冒充成功。
新增保护回归只验证本patch不提前释放这类请求，并在明确取消后等待真实target关闭/资源归零；
它不证明keepalive EOF后自动跨站可用。本轮不为这一独立限制扩展通用取流结构。

真实Elsevier旧XHR来自`dpm.demdex.net`，该轮未保存Network.type，不能事后认定它一定属于Script/XHR退休资格。
因此，当前普通Script/XHR及明确failed-response终态修复经本机验证后，也不能直接宣称Elsevier已能取得PDF。
用户要求停在最终验收，此风险连同修复后真实站点复测一起保留；不再新增live或最终Full。

### 局部验证完成与暂停

- 相关直接回归：6文件62/62通过；包括context/commit两种顺序、未知/隔离context拒绝、真实Network Fetch/root XHR组合保护、明确失败响应及非幂等错误保留。
- 实际Cloak：Host GET、JavaScript GET、原POST、同平台commit后的script/XHR及document-host共6项通过。
  GET/JS/POST/旧script/旧XHR证据依次为 `/tmp/sciretriever-document-handoff-PzzqHV/events.json`、`ZPBYcu`、`IyPvOH`、`TPVmS4`、`Acen9T` 同名目录；document-host为 `/tmp/sciretriever-document-host-ITC8ub/events.json`。
- keepalive安全取消独立补跑：1/1通过，5项因定点选择跳过（不是另5项通过）；工具session24199 exit0。
  `/tmp/sciretriever-document-handoff-vE6RyL/events.json` 中EOF前socket开、平台1、B无访问；明确取消后真实owned target销毁，四项Scheduler和文件额度全部0。
- 最新`pnpm quick`：工具session40325 exit0；随后修改仅为文档。未再次运行最终Full或真实出版社。
- 冻结清单`paused-bugfix-source-manifest.json`共139项，hash `f5da200ecfa9dfd18e7471df09de7301ffa6a64736caa903c952c98777b535ba`，位于本轮implementation证据目录。

普通Script/XHR及明确failed-response的局部修复成立；keepalive保守等待限制保留。
整体计划按用户要求Paused，最终全链路验收未完成。当前没有仍运行的publisher live，未提交Git或修改真实数据。
