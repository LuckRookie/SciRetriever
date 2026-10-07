# Browser 最终全链路验收（2026-10-07）

状态：本轮验收完成。原23个样本的完整矩阵与定点复验共20篇正式入库，3篇外部条件阻断；最终Full通过。各轮代码版本分别记录，保留IEEE中间一次未分类异常的诊断限制。

## 恢复基线与范围

HEAD `dd2df24e8a44e9c425f7b703a849ac4d04ac6fc5`；工作树包含前轮未提交改动，保留无关 `.agent-teams/`。
与暂停清单逐项比对，139项源码/测试/依赖文件无变化，清单hash
`f5da200ecfa9dfd18e7471df09de7301ffa6a64736caa903c952c98777b535ba`。
运行时继续使用Cloak `146.0.7680.177.5`；Browser模型 `qiuzk/gpt-6-luna`，实现执行者为GPT-6.1-sol / max。
本轮基线、命令与临时runner位于 `/tmp/sciretriever-final-acceptance-20261007-kkvdajch/`。

真实检查使用隔离home/Profile/catalog，通过Configuration/Credential owner授权，不复制个人Cookie或读取凭据原文。
复用缓存的真实Crossref observation，明确跳过Public/API locator，仅验证正式Browser tier：
DatabaseCompletion→Browser调度/模型→Intake→文件验收→publication→Library/受验证导出。
因此不声称重新验证了元数据发现或Public/API端到端能力。

## 恢复后的两篇诊断（最终修复前）

`/tmp/sciretriever-browser-parallel-live-31glfz/result.json`，工具exit0。
Nature模型2次，正式PDF 2,964,524字节，发布/导出hash一致；Elsevier模型5次，`pdf-browser-navigation-failed`。
精确残留为 `interception-job-66.0` / Network `899151.11`，Network与root Fetch类别均为Image，
旧loader `611C91533CC58F0A3775F4AA23FDE9B0`，origin `https://smetrics.elsevier.com`。
本轮Network.type证据同时显示旧demdex请求为XHR，原普通XHR修复有效；新阻塞是同类旧文档Image未退休，
不能按这个origin添加出版社例外或把失败改写为没有访问权。

## 本轮必要增量

1. Browser owner补齐经证实的文档依附资源生命周期，保留独立请求/文件writer的真实终态。
2. 旧document已失效的keepalive原响应若仍在Fetch response pause，验证以原IO EOF结束的通路；不得重发URL或猜测终态。
3. 补正式Application的same-URL popup合法PDF归属/发布/导出，以及显式串行配置跨下载/publication lease的执行证明。
4. 最终冻结后完成Full与受影响真实矩阵，记录每篇结果、版本、失败原因与资源归零；具体出口由计划07维护。

已有并行、17/513MiB文件链、真实30/60秒政策、控制/取消/正常停服证据经只读审计可沿用；
审计映射 `/tmp/sciretriever-final-audit-RdgQEj/audit.md`。没有要求机械重复所有故障/阶段组合。

## 本轮23篇真实矩阵：生命周期补修前

运行证据 `/tmp/sciretriever-browser-parallel-live-321XDj/`；实际 Browser 模型派发86次，最多2路真实派发重叠。
19份PDF正式入库，共46,607,934字节，全部标记文章身份 `unverified`，19/19受验证导出hash与catalog一致。
这不是整轮验收通过：IEEE发布后清理失败，AMS零模型调用并卡在closing；根执行者在无决策worker运行、
AMS超过预算后仍无法收尾时，通过精确PID/start ticks发送SIGTERM。正式取消后runner exit0、报告end=interrupted。
最终临时资源五项归零，但Scheduler仍有1个失败隔离的会话/平台资格；正常app.close后Node、Cloak、Xvfb精确进程均退出。
因此不能把“进程退出”写成所有会话清理成功，已入库的有效事实不撤销。

| 出版社            | DOI                                        | 实际模型派发 |   PDF字节 | 本轮结果与原因                                                                                                                                                          |
| ----------------- | ------------------------------------------ | -----------: | --------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nature            | `10.1038/nature14539`                      |            2 | 2,964,524 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| SpringerLink      | `10.1007/s12055-024-01728-3`               |            2 | 1,386,174 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| ACS               | `10.1021/acsami.4c13590`                   |            3 | 1,003,225 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| RSC               | `10.1039/c4cp05552g`                       |            1 |         — | 未取得；点击验证后进入认证跳转，id.rsc.org 系统 DNS resolver 抛错。此前页面 403 不是本次最终根因。                                                                      |
| Wiley             | `10.1002/advs.202200547`                   |            4 | 2,927,270 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| Elsevier 订阅样本 | `10.1016/0003-2670(70)80042-3`             |            5 |         — | 未取得；文章页已识别Jilin University，并明确显示该校未订阅本篇内容；Agent点机构访问后到校方登录页并stop(user)，按当前合同列入interrupted。仅代表这篇，Elsevier OA成功。 |
| Elsevier OA       | `10.1016/j.apsadv.2021.100072`             |            2 | 2,486,476 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| AIP               | `10.1063/5.0341530`                        |            1 |   153,057 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| IOP               | `10.1088/1742-6596/2977/1/012017`          |            2 | 5,341,907 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| Oxford Academic   | `10.1093/ced/llae535`                      |            6 |   938,404 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| Science / AAAS    | `10.1126/sciadv.ads8033`                   |            4 | 1,220,404 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| PLOS              | `10.1371/journal.pmed.0020124`             |            2 |   255,629 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| APS               | `10.1103/physrevlett.116.061102`           |            3 |   862,757 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| ACM               | `10.1145/3065386`                          |            6 | 2,570,670 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| IEEE              | `10.1109/5.726791`                         |            2 |   930,388 | 正式入库、受验证导出 hash 一致；但 native 意图请求残留导致清理失败，不能计为完整生命周期通过                                                                            |
| Annual Reviews    | `10.1146/annurev-statistics-042720-125902` |            4 |   626,557 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| AMS               | `10.1090/proc/14032`                       |            0 |         — | 未取得；初始开页连接恢复重放原 DOI 被 document grant 拒绝；300 秒预算结束仍卡 closing，属于内部生命周期缺陷。                                                           |
| Copernicus        | `10.5194/gmd-16-4937-2023`                 |            1 | 7,667,870 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| Frontiers         | `10.3389/fnins.2019.00425`                 |            1 | 9,134,381 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| MDPI              | `10.3390/s19092045`                        |            3 | 4,607,534 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| PNAS              | `10.1073/pnas.1118373109`                  |            4 | 1,055,855 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| Royal Society     | `10.1098/rspa.2012.0459`                   |            4 |   474,852 | 正式入库、受验证导出 hash 一致                                                                                                                                          |
| World Scientific  | `10.1142/s0219024910006066`                |           24 |         — | 未取得；页面标明 JILIN UNIVERSITY / No Access，重复尝试后300秒活跃预算耗尽，用户已确认没有版权。                                                                        |

### 版本与证据边界

本轮矩阵使用源码清单 `matrix-source-manifest.json`（141项，hash `e79f1c32023fa73b6b6d3472b4aba1ebcc0b4d9e333ad15804df7b079448ca0c`），
9项运行中加载的JS hash在 `tested-modules.json`。运行开始后的唯一先行源码差异是IO.close失败时保留请求所有权的保护；
矩阵 `protocol-failures.jsonl` 无IO.close失败，不能把本轮描述成后续最终版本的全部23篇重跑。
最终修复后只对受影响路径和样本复验，另行记录版本。

`partial-library-verification.json` 是卡住时由正式只读 QueryApplication 取得的资产/导出证据；
`result.json` 是正式取消后的完整报告、模型派发/动作和文件hash；`closed.json` 保留失败的Scheduler账本；
`operator-stop.json` 与 `processes-after-close.json` 记录停止原因及进程核对。Elsevier的stop(user)是模型动作，
不是本轮用户发送取消；不能将它解释为管理员已判定无权限。

### 验收暴露的通用问题

- IEEE：PDF MIME/attachment只表示原生下载意图；代码将其当成已存在的GUID writer，忽略了原请求明确失败，
  因而即使正式PDF已经发布也无法结清另一条iframe请求。需要区分实际writer与意图。
- AMS：初始open尚未完成时，预算终止无法调用尚未绑定的Host关闭；连接恢复再次访问原DOI也不匹配最后重定向的导航授权。
  修复必须在导航前接通会话取消/网络生命周期，并保守处理不能证明合法的重放。
- 首轮Full在运行中跨过IO.close保护修改，owner一条断言出现版本不一致；另外默认Chromium140在document unload时明确报告
  Network.loadingFailed，而Cloak146保留原响应到EOF/cancel。三个keepalive测试把后一种事件顺序强加给所有runtime。
  测试需依据精确请求的真实终态断言，不能跳过或把取消证据改成超时猜测。

以上问题仍在收口，后续最终门禁和定点结果另记。

### RSC独立环境复核

2026-10-07 04:55 UTC，沿用未修改的系统 `dns.lookup('id.rsc.org', {all:true})`，返回 `EAI_AGAIN`。
证据 `/tmp/sciretriever-final-acceptance-20261007-kkvdajch/rsc-system-dns.json`；这与真实认证跳转中resolver抛错一致。
本轮没有配置替代DNS、修改系统解析器、设置站点IP或绕过Network检查，管理员处理后需单独复验。

### keepalive fixture的跨运行时验证

默认Chromium `140.0.7339.16` 与Cloak `146.0.7680.177.5` 各12/12通过、无skip；
精确patch和trace索引 `/tmp/sciretriever-chromium-handoff-diagnostic-gDXR6E/fixture-verification.json`。
前者在旧document卸载时报告精确Network ERR_ABORTED并结清，允许B的原GET直接通过；后者保留响应，
必须证明原IO的EOF或真实取消后才推进。两种情况均验证B仅一次请求和正确文件hash；取消场景要求B零请求及资源/调度归零。
这证明运行环境存在事件顺序差异，不能仅据这两次运行把原因归于版本、headless或Cloak补丁中的某一项。
测试文件hash `4ec5db8584af834bcc2a69a130fd3c797c20c5311ea32326cb4ea1a489699d7a`；
这两次运行仍早于后续native/open生命周期补修，最终对象图需另行验证。

### Elsevier订阅样本的原页面证据

`321XDj/elsevier/observation-2.json` 已显示 `Brought to you by: Jilin University`，并明确说明
`Jilin University does not subscribe to this content on ScienceDirect.`。Agent随后点击
`Access through another organization`，经机构页面到吉林大学登录页后stop(user)。
所以本次可确认网站已识别机构且声明**这一篇**不在订阅内；不能扩大为整个Elsevier无订阅，
也不能把学校登录页当作浏览器必需输入邮箱的证据。模型没有输入账号、密码或使用Elsevier API代替Browser。

## 最终生命周期补修范围

这轮补修继续使用标准请求、文档、会话与下载事件，不增加出版社域名、选择器或PDF路径规则。

1. 将原生下载意图与已启动的GUID writer分开。明确失败且尚无writer的响应可以结清；
   迟到GUID仍根据原frame/文章绑定归属，活跃文章的popup先关闭不能丢失这条证据。
   整篇会话确认关闭后回收意图记录，关闭后迟到的下载取消并删除临时原件。
2. 初始open在导航之前接通独立取消信号。300秒预算终止能实际关闭这一篇的页面，不取消其它文章，
   保留budget-exhausted而不是误报user-cancelled；晚到的page handle仍归原owner清理。
3. 连接重试只允许具有精确失败证据的同URL已准入GET。已重定向到其它地址的请求失败，不得据旧DOI许可
   重放原始URL。错误文档切换的等待与重试次数分开，第二次连接失败也要完成错误文档切换后正常关闭。
4. 全会话关闭由实际page.close终止页面，不先发送会干扰错误页关闭的冗余Page.stopLoading。
   原生writer、worker、IO流仍各自确认取消与终态；不能用页面关闭替代文件writer终态。
5. 原响应IO由自身EOF/取消结算。TargetDestroyed或renderer Network终态不能提前删除仍在读取/关闭的IO责任；
   接受Fetch request-inactive必须有精确终态证据且IO.close成功。

补修前快照与独立diff保存在 `/tmp/sciretriever-native-open-fix-s3f8dvbj/`。根执行者与导航执行者独立复核了
迟到GUID、跨文章同URL、缓存回收、预算错误优先级、重定向准入等待窗口以及IO账本的关闭顺序。
最终冻结与验证结果将在下方记录，以上实施说明不单独代表Full通过。

## 生命周期冻结版定点复验与真实结果边界

生命周期清单 `1c0e31e6b53d701305a54ff06df160fb687e67551108bcd779266c405f2adbfe` 对应
四个生产文件hash见 `/tmp/sciretriever-native-open-fix-s3f8dvbj/validation.json`；构建成功。

| 运行                       | 原样本与正式结果                                                                                                                            | 清理与限制                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `oZ6G9L`，四篇             | Nature 2次/2,964,524字节；AMS 3次/200,948字节，均正式发布且导出hash一致；Elsevier已识别机构但本篇不在订阅内；IEEE零模型generic flow failure | 正常结束、Scheduler四项与资源五项全0；IEEE失败不是原native残留，原始cause未采集，不能写成外部拒绝 |
| `09g7iw`，IEEE诊断         | IEEE 3次/930,388字节，正式发布与导出hash一致                                                                                                | 正常结束、全部计数0；snapshot transition按通用流程重新观察，未复现generic failure                 |
| `Zo4DCT`，同一四篇并行诊断 | Nature 2次/2,964,524字节；IEEE 3次/930,372字节；AMS 2次/200,948字节，均正式发布/hash一致；Elsevier仍NoSubscription                          | 正常结束，failed为空，Elsevier按manual-pdf-required列入skipped；全部计数0                         |

这些运行均沿用同一生产源码，仅临时runner增加安全错误字段和origin级日志，没有注入网站动作规则。
不同运行取得的IEEE文件各自按实际字节hash验收；不要求站点每次生成同一字节。
截至这三轮，原23个样本中已有20个取得并正式发布有效PDF。这个数是**完整矩阵与定点复验的并集**，
不能写成单次23篇全通过，也不能把前一版的所有站点结果冒充最后补修版本全部重跑。

### 未被成功复测抹去的IEEE失败

`oZ6G9L` 的IEEE在200 document commit后14ms触发本地运行失败；后续资源拒绝发生在closing之后，
不能倒因为果。它缺少当时的raw cause，后两轮成功只能证明同样本能够正常取得PDF并结清资源，不能证明该旧失败根因。
审查随后精确复现了Host snapshot异常路径的另一处通用缺口：成功返回时检查了CDP target/generation/recovery变化，
但未分类RPC异常时漏用了同一事实。新增可控回归修复前4项失败，修复后相关27项通过；
稳定身份的原异常、真实关闭/崩溃和runtime丢失仍保留，只有确证文档变化才重新观察。
该修补的证据 `/tmp/sciretriever-snapshot-rejection-fix-5hrjpM/` 独立成立，**不将它推测为IEEE旧失败的已证实根因**。

最后源码/测试清单已重新冻结为141项，hash
`2eb0fcb9a42f7fe091aadc3cd3b14a6a8d3fa384f9e4f759a385a44cbfec2917`，
Host hash `5b7f4492985d8f2372e55a6d1d089a78a9b9b62dbf8a902fa4ffe31f1764b8ec`。
最后IEEE/AMS复验与Full结果已收集如下。

### 门禁中旧测试的同步

生命周期版Full：187文件/1,255项通过，15文件/39项环境跳过，2文件/3项失败。
失败分别为full-close已不再发送Page.stopLoading导致原故障注入未触发、cleanup fake缺少sessionClosed、
以及独立清理错误的顺序变更。生产行为未因此回退。测试改为先对A执行真实cooperative stop并注入inactive，
再验证full-close取消真实writer且B继续；该实际Cloak定点1项通过（11项仅因名称过滤未选）。
cleanup fake补完整新协议并检查drain前/失败时不得通知sessionClosed，保留所有四类错误而不规定并发完成先后，2项通过。
最终Full必须基于这些同步后的测试与最后Host补修重新执行，前述失败日志不作为通过门禁。

## 最后构建的真实IEEE/AMS复验

证据 `/tmp/sciretriever-browser-parallel-live-hcRaI2/`，工具exit0，report end=finished，无failed、interrupted。
运行时仍为Cloak146.0.7680.177.5，模型qiuzk/gpt-6-luna，源码清单为上述 `2eb0fcb9…`。

| 样本                     | 实际模型派发 | 正式PDF字节 | 入库与导出SHA-256                                                  |
| ------------------------ | -----------: | ----------: | ------------------------------------------------------------------ |
| IEEE / 10.1109/5.726791  |            3 |     930,388 | `5fa9477fa7f294ab14b3e1c934375fc49ad997e93cc91e0f1503f3172b352991` |
| AMS / 10.1090/proc/14032 |            3 |     200,948 | `2708216dd06f4fd90e53be4f4484194461898c0e2eb7b844e35665a095092ba8` |

两份均为文章身份unverified；publication与受验证导出hash相同。关闭后sessions/queued/workers/platform_active全0，
temporary/pending-write/native/staging/preparation全0；Node、Cloak、Xvfb均按PID和启动ticks核对已退出。
综合全部真实运行的机器可读索引为 `/tmp/sciretriever-final-acceptance-20261007-kkvdajch/publisher-summary.json`，
共23个原样本、20个正式成功，未成功为RSC、Elsevier订阅样本、World Scientific。各轮登记的Node、Cloak与Xvfb进程均已退出。

最后Host补修后的文档切换实际Cloak12/12通过，日志 `cloak-document-accepted.log`；
此前生命周期版的正式App popup/serial 2/2、正常停服2/2及其余owned cases没有改变生产分支，按影响审查沿用。
更新后的inactive stop→full close实际Cloak定点通过，保留A原请求/原生writer真实关闭、B继续下载、重复关闭幂等的全部断言。
17MiB原响应取流已在最后生产源码通过，1项通过、3项仅因名称过滤未选；证据 /tmp/sciretriever-large-browser-evidence-pPDpcy，44.34秒完成测试体，正式发布与导出hash一致。最终Full结果见后续门禁记录。

## 逐样本汇总结论

下表使用各样本最近一次已证明的正式成功，跨轮合并；DOI与各轮失败/版本见上表。
模型次数是所列成功轮次的真实派发数，不是调用入口计数，未成功项不合并重复尝试计数。
这个矩阵验证的是给定元数据后的Browser通道；Public/API与新元数据发现没有在本轮重新进行真实外部验收。

| 出版社 / 样本     | 成功轮模型派发 |   PDF字节 | 结论                                                                        |
| ----------------- | -------------: | --------: | --------------------------------------------------------------------------- |
| Nature            |              2 | 2,964,524 | 正式发布 / hash一致 / 身份未验证                                            |
| SpringerLink      |              2 | 1,386,174 | 正式发布 / hash一致 / 身份未验证                                            |
| ACS               |              3 | 1,003,225 | 正式发布 / hash一致 / 身份未验证                                            |
| RSC               |              — |         — | 认证跳转的id.rsc.org系统DNS返回EAI_AGAIN；待管理员修复解析路径后复验        |
| Wiley             |              4 | 2,927,270 | 正式发布 / hash一致 / 身份未验证                                            |
| Elsevier 订阅样本 |              — |         — | 已识别Jilin University，但文章页明确声明未订阅这一内容；Elsevier OA样本成功 |
| Elsevier OA       |              2 | 2,486,476 | 正式发布 / hash一致 / 身份未验证                                            |
| AIP               |              1 |   153,057 | 正式发布 / hash一致 / 身份未验证                                            |
| IOP               |              2 | 5,341,907 | 正式发布 / hash一致 / 身份未验证                                            |
| Oxford Academic   |              6 |   938,404 | 正式发布 / hash一致 / 身份未验证                                            |
| Science / AAAS    |              4 | 1,220,404 | 正式发布 / hash一致 / 身份未验证                                            |
| PLOS              |              2 |   255,629 | 正式发布 / hash一致 / 身份未验证                                            |
| APS               |              3 |   862,757 | 正式发布 / hash一致 / 身份未验证                                            |
| ACM               |              6 | 2,570,670 | 正式发布 / hash一致 / 身份未验证                                            |
| IEEE              |              3 |   930,388 | 正式发布 / hash一致 / 身份未验证；旧未分类失败保留，最后构建复验成功        |
| Annual Reviews    |              4 |   626,557 | 正式发布 / hash一致 / 身份未验证                                            |
| AMS               |              3 |   200,948 | 正式发布 / hash一致 / 身份未验证                                            |
| Copernicus        |              1 | 7,667,870 | 正式发布 / hash一致 / 身份未验证                                            |
| Frontiers         |              1 | 9,134,381 | 正式发布 / hash一致 / 身份未验证                                            |
| MDPI              |              3 | 4,607,534 | 正式发布 / hash一致 / 身份未验证                                            |
| PNAS              |              4 | 1,055,855 | 正式发布 / hash一致 / 身份未验证                                            |
| Royal Society     |              4 |   474,852 | 正式发布 / hash一致 / 身份未验证                                            |
| World Scientific  |              — |         — | 已识别JILIN UNIVERSITY，页面明确No Access；用户已确认没有版权               |

正式成功20/23；RSC的环境条件与两篇具体内容订阅限制单独保留，不描述成“不存在PDF”。
IEEE早期未分类异常的原始cause缺失仍是诊断限制，后续生产诊断应保留安全cause以便若再发生能够定位；
本轮没有为它新增站点规则，也没有依据复测成功删除失败记录。

## 全量门禁发现的离线fixture缺口

最后生产源码的Full中，188文件/1,265项通过，15文件/39项条件跳过；唯一失败是
database-completion-chunks首例5000ms超时，其余17例通过。静态调用链证明：
合成数据库的upgrade-synthetic并不隔离网络；默认合成DOI会形成真实doi.org候选，
Entry默认公共下载transport再执行DNS/Socket请求，单项网络超时30秒。因此不能将它归因于Browser，
也不能把此前偶尔通过当作该测试已经离线。

只修改该共享test fixture，使用既有doiLandingSource空候选端口，并注入拒绝外部解析的resolver；
首例断言5次离线source调用、0次resolver调用，bound=2和完整报告断言全部保留。
resolver本身只覆盖registry适配器，真正切断默认下载的是空候选端口。
整文件18/18通过，原超时首例526ms；没有修改生产源码、测试超时、依赖或schema。
精确delta和hash见 /tmp/sciretriever-completion-chunks-offline-gf94ag17/。

最终源码/测试/依赖清单因此为142项，hash
55a59148dcabd9d2a8345d8b4c9b689831b92307bcc6f04e1bab726306fc0c01；
生产源码与hcRaI2、最终12项Cloak及17MiB取流实测相同，只有这个离线fixture改变。
本轮全量复验日志为 /tmp/sciretriever-final-acceptance-20261007-kkvdajch/full-delivery.log。

## 最终质量门禁与交接

最终命令 VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1 pnpm full，工具exit0：
**189个文件、1,266项测试通过；15个文件、39项条件跳过；TypeScript及工作台资源构建通过**。
Vitest耗时551.71秒。日志 full-delivery.log、最终清单 final-source-manifest.json 均在本轮证据根目录。
跳过项按原有环境条件保留，包含需显式Cloak bundle、工作台或MinerU专项环境的旅程；
关键Browser用例的独立实际Cloak运行及沿用范围见上文和影响审计，不把环境skip计为通过。
本轮没有重新进行真实Public/API、MinerU或解析/分析端到端验收。

最终142项源码/测试/依赖hash与冻结清单一致，HEAD仍为dd2df24e8a44e9c425f7b703a849ac4d04ac6fc5；
index为空，保留原有dirty工作树及无关.agent-teams。本轮补修没有新增依赖、公开配置、schema或迁移；
整份并行计划先前引入的tldts@7.4.16用于可靠可注册域名判断，维持该已记录依赖。
没有提交、推送、PR、发布、系统DNS改动、真实catalog迁移、用户资产清理或个人Cookie复制。

实现与本轮验收完成；外部条件分别交还：
RSC等待服务器系统DNS解析链恢复后复验；Elsevier该1970年样本与World Scientific样本按页面的具体内容权限结束。
不据这些结果断言整个出版社不可访问。IEEE的历史未分类异常保留诊断缺口，最终构建已再次取得PDF且所有计数归零；
后续若再发生，应以安全的原始错误链定位，不能仅凭相邻网络关闭日志归因。

对应计划01–07已收口。成功标准仍是正式资产/关系与受验证导出，所有PDF均标记文章身份未验证，
本轮未新增正文身份判断。后续现场网络修复、真实Library迁移和Git/发布不包含在本次验收完成内。
