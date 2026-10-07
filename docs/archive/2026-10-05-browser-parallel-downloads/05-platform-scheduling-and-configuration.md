# Block 05：跨平台调度与配置兼容

> **状态**：Completed（2026-10-07最终验收；外部访问限制见Block07） · **Owner**：主执行者 · **上级计划**：[README](README.md)
> **前置**：02、03、04事件/资源合同及直接测试；01的政策决策 · **后续**：[06 协作与收尾](06-workbench-recovery-and-shutdown.md)、[07 全链路](07-end-to-end-verification-and-handoff.md)

## Outcome

两个独立worker实际推进不同平台，下载中的会话让出模型执行机会。平台串行、30秒冷却、窗口、Retry-After和资源cap
在全部worker之间共享；某个平台等待时不阻止其它可服务平台。配置声明与真实生效值一致，旧显式串行意图得到保留。

## 进入条件

会话归属、step/active clock和后台传输已稳定，Entry/Browser/Acquisition能交接候选且独立清理。
1.6架构修订允许跨平台并行；默认不再依赖一个global current target。未满足02/04时不先删除全局串行锁。

## 责任边界

沿用Entry的BrowserSessionBroker和scheduler，使用进程内session表、就绪队列、平台资格与可取消计时器。
Network继续执行实际目的地址和模型/连接预算；Browser提供可信平台归属与传输事件。
Configuration是唯一配置解析owner，doctor/工作台只展示实际状态，不另算一套限制。

## Tasks

- [x] **5.1 实现平台键与首次准入。** 由1.2证实的landing/导航证据决定访问平台，先查受核实alias，再用可靠可注册域名，
      未知归属可保守进入unknown组。DOI解析器、共同CDN、SSO和challenge服务不是所有文章的平台；
      不能用publisher自由文本或简单截末两段域名代替归属。确需PSL依赖时仅引入必要库并记录依据。
      **验收**：同平台多域名合组、独立平台分开、co.uk等反例正确，出版社首请求在server计数前已获准；未知站点仍能尝试。
- [x] **5.2 落实资格、冷却和换组。** 同平台最多一个网络活动文章，覆盖页面与下载；download-start只释放worker。
      网络真实结束且后台新请求已受控后，设置30秒冷却。认证/CDN不重复取平台锁；确需换平台时不持A等待B，
      终止旧资格对应网络活动后重新调度，不能借换入口绕过原冷却。
      **验收**：同平台A下载时B零访问，结束后29.9秒仍零、30秒后准入；纯本地验证不延长平台占用；无换组死锁。
- [x] **5.3 建立就绪队列与有界会话。** 一轮step结束后按事件/最近到期时间唤醒，不以全局短周期轮询。
      只为有准入条件的任务创建页面；同平台最多保留一个网络活动和一个等待/恢复会话，其余仅排队。
      平台轮转结合就绪时间，恢复与新任务不设绝对优先；没有可运行项时等待，不让不可服务队首阻塞全队。
      **验收**：大量RSC加一篇Wiley时后者可推进；恢复队列不饿死新任务；会话cap满时不创建额外页面，取消等待者后及时释放。
- [x] **5.4 接入两个独立决策worker。** worker是异步执行槽，不创建额外浏览器进程或互相通讯。
      领取会话必须原子防重，step、下载started及取消都通过同一owner归还执行资格。
      保持现有Entry Browser波次的Promise调用/最终结果语义，真正并发由broker调度；不能只改变最外层Promise.all。
      模型仍受共享`agent-model` scope/host预算，实际可用并发低于2时如实显示，不开新scope绕限制。
      **验收**：两个模型调用在服务端确有重叠、第三篇持续后台下载；同会话不会有两个在途决策，正常空闲不泄漏permit。
- [x] **5.5 接通配置并保留旧含义。** 实施下表默认及兼容策略，在Configuration、组装、doctor/config展示和测试中使用同一有效值。
      旧policy_overrides的窗口/冷却/失败阈值均执行；不能“解析成功但忽略”。新的资源字段若需要公开，只作为可选值并由同一owner校验。
      **验收**：旧config读取/序列化往返、空override默认并发、显式max_concurrency=1全局串行、大旧值读取但实际cap可见；无静默修改文件。
- [x] **5.6 共享限流与失败退避。** Browser有归属的导航/认证/下载响应把429及适用的Retry-After反馈给平台调度，
      HTTPS CONNECT代理不猜状态码。无Retry-After默认至少60秒共享退避，更严格配置优先；普通统计子请求失败不污染整个出版社。
      Host/context/proxy运行故障才计runtime_failure_threshold；无权限、损坏PDF和Agent Stop不算浏览器崩溃。
      **验收**：A限流后B换worker/入口仍不能提前访问，独立平台继续；超会话寿命的等待形成明确结果，不写成exhausted。
- [x] **5.7 保护配置窗口与代次状态。** start按首次获得网络资格及失败恢复的新尝试计，5秒普通step不重复计。
      operation变化、旧代次取消或worker释放不能清空有效的进程内冷却和窗口；不会宣称跨进程恢复限速状态。
      aggregate override与每平台规则共同准入，不能先取得部分资源再等待剩余资源造成占位阻塞。
      **验收**：窗口边界、完成冷却、取消后重新提交、alias换域、重试和进程内多operation均遵守同一计数。
- [x] **5.8 在正式组装中验证无饿死与资源回收。** 集成03/04事件、共享模型预算和候选发布回调，
      检查每篇结果在原Entry索引/回调中仍归属正确，已有成功不因其它篇失败回滚。
      **验收**：混合快慢下载、满槽、恢复、限流和模型失败可终止；全部正常结束后队列、会话、平台资格和worker计数均归零。

## 配置与政策交接表

| 配置/政策                                           | 执行含义                                                  | 兼容要求                                                       |
| --------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| browser.max_concurrency                             | 保留会话cap；默认5，允许1，首版实际支持上限8              | 旧较大值可读取，生效值=min(配置,8)，显示限制原因，不改写原文件 |
| worker数                                            | min(2,有效会话cap)，还服从模型共享预算                    | 第一版不新增worker/download两个独立配置旋钮                    |
| 每会话下载                                          | 一个主transfer，数量自然不超过会话cap                     | 去重/额外下载取消由04拥有，不另维护credit池                    |
| 默认平台政策                                        | 网络活动文章1、结束后30秒冷却                             | 不是每个CSS/JS等待30秒；不按出版社写动作脚本                   |
| browser-generic显式max_concurrency=1                | 聚合层限制整个文章会话生命周期                            | 保留旧全局串行意图；空override使用新的跨平台默认               |
| minimum_start_interval、starts/window               | 聚合层按实际访问尝试计数，与平台限制取更严格效果          | 失败恢复重新取得资格计数，普通step不计；不清零有效窗口         |
| completion/failure/rate cooldown、failure threshold | 按已定义事件启动聚合限制，平台本身也保留基线与Retry-After | 所有已接受字段真实执行，有直接测试和可解释状态                 |

首版上限8是资源保护起点，不是网站能力结论；调整需同一配置/资源owner与实际测量，不增加隐藏的第三套计算。
会话总寿命沿04方案，已超过剩余寿命的Retry-After直接形成限流/延期结果，释放现场而不提前请求。

## 集成与影响

修改Entry broker、Browser平台准入、bootstrap模型预算接线和配置展示；不新增持久调度表。
configuration/types/contracts的已有消费者需同步；用户已有文件继续兼容。上游Public/API的层级顺序不改，
不同访问路径只有在确有共享quota证据时复用其Network限制，不凭出版社名称合并一切网络scope。

## 验证

```bash
pnpm exec vitest run apps/server/test/pdf-acquisition-scheduler.test.ts apps/server/test/network-budget.test.ts apps/server/test/configuration-boundary.test.ts apps/server/test/configuration-owner.test.ts apps/server/test/doctor.test.ts apps/server/test/application-assembly.test.ts
```

新增平台调度直接场景使用假时钟和请求计数证明30秒/窗口/退避；生产Cloak场景证明后台网络不会绕过政策。
把原测试“全局从不并发进入”改成新合同的不同平台可并行/同平台不可并行，保留全局串行override的独立回归。
不能删除原取消、代次和资源安全断言来获得通过。

## 当前证据

5.1–5.8已接入生产对象图，跨平台doc grant与OOPIF收尾正在根据真实站点补充回归；该块仍 In progress。
已新增 `BrowserPlatformScheduler`（精确 PSL 依赖 `tldts@7.4.16`）与 `BrowserArticleScheduler`，Entry 消费有身份的 step，Bootstrap 按 session 注册候选、传输、网络与工作台投影。

- 平台7项直接测试通过：别名/公共后缀、网络活动+30秒、实际start/window、Retry-After、聚合冷却和仅runtime故障阈值。
- 调度直接场景覆盖两个决策+第三下载、同平台积压、公平恢复、清理失败隔离、queued独立取消、取消传给开页signal，以及超保留寿命的Retry-After明确延期。正迁移到新增CDP文档证据合同后集中复跑。
- 配置19项及doctor/config UI9项通过：原配置值保留、允许1、有效cap8、显式serial override；显示configured/effective/workers。
- 模型transport派发钩子17项通过；排队不计dispatch，取消/预算拒绝不发送HTTP。
- **5.4生产证据**：`browser-parallel-production.test.ts`真实Cloak+正式本地模型HTTP，服务端观测模型并发峰值2；第三篇原生下载持续。A/B在C之前入库，最终三篇导出hash正确、身份unverified、临时额度0。证据 `/tmp/sciretriever-parallel-browser-evidence-i9FQ9s/evidence.json`。
- `DatabaseCompletion`现在只在freeze短暂持catalog admission，下载和文件准备不持长锁；scope/chunk42项回归全部通过。
- root审查补充：同平台最多保留两个会话，超出的原始任务只排队；超过会话剩余寿命的限流保留平台冷却并明确报告，不等待一小时后混成耗尽。
- 首轮真实Nature/Springer PDF成功但发生OOPIF终态丢失导致cleanup failure，已定位并交导航owner；修复前不勾5.2/5.8。详见[本轮验证记录](../../notes/browser-parallel-validation-2026-10-05.md)。

## 退出条件

跨平台真实并行、同平台串行+30秒、共享窗口/退避和配置兼容均可复现；worker无通信，等待不导致高频空转。
会话容量和公平限制有效，迟到/取消不泄漏资格；实际有效值可查询，旧显式政策不会被新默认绕过。

## 恢复与交接

发现超限先停用新并行派发并保留平台时间线，不清零窗口/改名平台规避；恢复到负责的归属、计数或传输Task。
06接收统一等待原因、会话ID、控制epoch与局部取消入口；07接收可重放的公平/限流矩阵和生效配置。

### 最终集成补充：平台实钟与导航恢复队列

`browser-policy-production.test.ts` 正式App/Cloak/本地模型HTTP三个场景3/3通过：同平台第二篇在native网络结束29.9秒仍无请求，
30秒后才准入；429带/不带Retry-After均在59.9秒仍禁止同平台后继访问，60秒后放行，独立平台此前已入库。
具体header恢复与无header明确限流结果、hash/账本断言见[验证记录](../../notes/browser-parallel-validation-2026-10-05.md#实际平台冷却与限流)。
证据 `/tmp/sciretriever-policy-evidence-cBqrHh/`、`/tmp/sciretriever-policy-evidence-COOcXM/`、`/tmp/sciretriever-policy-evidence-4u9wmu/`。

真实Wiley另暴露了“导航准入与恢复队列同时处理一篇文章”的死锁；root已修复有在途access时不重复restore、
准入完成唤醒，以及已有平台lease时直接恢复。直接scheduler/document/runtime-loss 19/19通过，
Wiley真实4次模型调用完成2,927,270字节正式发布/导出/正常收尾。修复不改变30秒限制、不加入站点例外。
最终Full与全矩阵由Block07收口；取消/停服集成已在Block06补齐。2026-10-07真实矩阵另暴露native意图残留和初始open预算取消缺口，5.8等待这两项补修后的资源收尾审查；最新证据见[最终验收记录](../../notes/browser-final-acceptance-2026-10-07.md)。

## 2026-10-07最终收口

本块实现、直接回归与必要生产对象图证据已并入最终验收；Full189文件/1,266项通过、39项条件跳过、build通过。
最后源码清单142项、hash55a59148dcabd9d2a8345d8b4c9b689831b92307bcc6f04e1bab726306fc0c01。
具体版本、影响审查、逐出版社结果和外部未决范围见[最终验收记录](../../notes/browser-final-acceptance-2026-10-07.md)。
此前记录保留其发生时的版本与结论；当前块状态以上述最终收口为准，不将历史失败改写为当时通过。
