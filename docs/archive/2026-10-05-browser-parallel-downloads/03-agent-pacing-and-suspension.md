# Block 03：可暂停的Agent循环与时间预算

> **状态**：Completed（2026-10-07最终验收；外部访问限制见Block07） · **Owner**：主执行者 · **上级计划**：[README](README.md)
> **前置**：02退出条件、Tasks 1.5/1.6 · **后续**：[04 传输事件集成](04-background-download-and-publication.md)、[05 调度](05-platform-scheduling-and-configuration.md)、[06 恢复](06-workbench-recovery-and-shutdown.md)

## Outcome

现有观察—决策—动作循环能够在一轮后让出执行机会，在下载开始时暂停，在失败后从原页面重新观察并继续。
5秒节奏、300秒活跃时间、50次调用和100次动作只由会话维护；换worker、人工介入或下载恢复不会清零。
本块不要求新增模型动作或改变浏览器访问身份。

## 进入条件

会话归属和短输入临界区已可用；1.5已定义transfer-started/candidate/publication与取消边界。
04可暂以合同fixture提供事件供直接测试，真正传输接线由04/05完成；fixture通过不代表后台下载已经交付。

## 责任边界

`browser/article-flow.ts` 的循环状态归会话持有，`pacing.ts`负责时间规则，decision适配负责输入与动作解析。
Workbench/执行policy从同一时钟读取remaining，不保存第二份截止时间。Network提供模型许可派发状态，
许可排队不是模型推理时间；worker只执行一轮，不通过内部聊天协调任务。

## Tasks

- [x] **3.1 提取可暂停的会话执行状态。** 保存当前page、generation、近期动作、feedback、计数与phase，
      一次step只产生一个Agent动作或明确的等待/结束结果。防止同一会话在一次异步模型调用期间被再次领取。
      **验收**：step让出后换worker恢复，观察目标、反馈与计数保持；页面变化时重新观察而不是重放旧动作。
- [x] **3.2 落实5秒最小决策间隔。** 动作结束记录nextDecisionAt；普通反馈等待上限5秒，验证15秒、下载开始30秒先保留。
      反馈监听与最小间隔重叠，早到变化只更新观察；到期后仍未就绪继续等待变化，不固定整5秒轮询。
      **验收**：4.999秒前无下一次模型派发；1秒变化不会提前动作；5.1秒变化可触发下一轮；取消和文件完成不被冷却延迟。
- [x] **3.3 统一活跃时钟与计数。** 单调时钟累计推理、动作和主动页面等待，重叠时间只计一次；
      worker/Network许可排队、平台冷却和后台下载不计入300秒。只计真实模型派发与Agent提出的动作，内部观察轮询不计100动作。
      取消signal分为operation寿命、本轮决策与transfer，不能以一个300秒墙钟timeout取消所有阶段。
      **验收**：跨下载/排队恢复remaining正确；模型许可等待不耗预算；迟到模型响应不越过截止派发；所有观察/工作台预算一致。
- [x] **3.4 下载开始后暂停并安全恢复。** 接到属于本会话的started事件后原子切换phase，释放worker；
      正在返回的模型决策可取消但不取消transfer，重复started不二次释放。失败时保存脱敏原因并回到待调度状态，
      下一步必须重新观察原页面；有效候选则进入待publication阶段，不继续找第二个PDF。
      **验收**：started与模型返回交错时无额外点击；恢复不重置次数；下载期间零新决策；正常文件就绪不等模型Stop。
- [x] **3.5 让可恢复错误进入会话反馈。** 对导航/DNS暂态提供可分类结果，429交共享调度器停放；
      Agent Stop、实际无权限、模型错误、资源阻断、预算耗尽分别结束或恢复。保持原动作边界，
      如恢复必须用受控重开入口，由程序依既有已准入来源处理，不能假设Agent已有任意URL/刷新工具。
      **验收**：临时网络失败不丢成generic refused；同一错误不会无限刷新；明确拒绝不被无限重试；未成功不写为PDF耗尽。
- [x] **3.6 接回自动与协作模式。** 替换旧flowStartedAt、collaboration deadline和policy墙钟的重复计算，
      recentActions/反馈从会话传入`qiuzk/gpt-6-luna`决策适配。更新计数规则与提示词所述等待方式。
      **验收**：自动和工作台同场景预算相同；原六种动作schema、坐标与stale检查保持；暂停/恢复不产生额外模型实例状态。

## 时间与计数交接表

| 阶段                     | 占worker                   | 计活跃时间           | 计模型/动作                                  |
| ------------------------ | -------------------------- | -------------------- | -------------------------------------------- |
| 等worker或模型网络许可   | 否或仅待派发，不计为已调用 | 否                   | 否                                           |
| 模型已实际发出           | 是                         | 是                   | call一次，返回合法可执行动作后按规则计action |
| 动作与主动页面反馈等待   | 派发后可让出worker         | 是，重叠等待不重复计 | Agent动作计一次，内部观察不计                |
| 5秒节奏剩余等待          | 否                         | 是                   | 否                                           |
| 平台冷却/Retry-After停放 | 否                         | 否                   | 否                                           |
| 后台下载、本地验收/发布  | 否                         | 否                   | 否                                           |

实际是否占用模型许可与worker的释放点需同Network/05一致；不能标注空闲却继续占着不可取消的调用。
总会话寿命和传输保护由04/05负责，不把排除活跃计时理解为无限保留。

## 集成与影响

修改Browser内部step/lifecycle合同、观察中的剩余预算与协作接线；公共模型配置仍选原reference。
动作计数从内部wait也计数改为Agent动作计数，需同步ADR/指南与直接测试，不能保留旧24动作测试含义却改数字。
传输验收和publication继续由原owner完成。

## 验证

```bash
pnpm exec vitest run apps/server/test/browser-article-flow.test.ts apps/server/test/browser-pacing.test.ts apps/server/test/browser-decision.test.ts apps/server/test/browser-readiness.test.ts apps/server/test/workbench-session.test.ts
pnpm exec vitest run apps/server/test/browser-article-session.test.ts apps/server/test/production-parallel-workbench.test.ts
SCIRETRIEVER_CLOAK_BUNDLE="<已校验bundle绝对路径>" pnpm exec vitest run apps/server/test/browser-cloak-pacing.test.ts --maxWorkers=1 --no-file-parallelism --reporter=verbose
```

新增可控时钟场景覆盖时间表全部阶段及边界；失败注入包含started先于/晚于模型结果、取消发生于冷却、
模型许可排队、页面变化、用尽第50次call/第100次action、恢复后剩余不足。
实际Cloak验证页面在5.1秒变化时的观察与派发序列，不能只mock Date.now证明等待有效。

## 当前证据

Tasks 3.1–3.6已实现并完成直接与必要的实际Cloak验证；本块仍保持In progress，最终冻结patch上的Quick/Full由07统一验收。
3.5的429、Stop/预算/资源/reader分类已有直接覆盖，最新正式模型HTTP 503隔离场景稳定返回
`pdf-browser-flow-failed`，不请求A的PDF、不写自动耗尽，B仍正式发布并导出。
Host现已实现已准入同URL暂态导航最多两次尝试与稳定`browser-navigation-failed`，
`browser-document-admission.test.ts`验证旧导航真实结束后才允许同URL重试，拒绝其它URL及旧document后台请求。
实际Cloak Host三个场景3/3通过：平台准入等待31秒时30秒仍非终态、同URL第二次导航恢复、
两次连接拒绝后稳定终止。精确证据依次为
`/tmp/sciretriever-browser-host-evidence-ME9bqJ/events.json`、
`/tmp/sciretriever-browser-host-evidence-fAy2bV/events.json`、
`/tmp/sciretriever-browser-host-evidence-27eZMd/events.json`。
不以浏览器fixture替代Host的实际导航证明，也不把Full未结束写为全部质量验收。

`browser-policy-production.test.ts`正式Application、verified Cloak与普通loopback模型HTTP三场景3/3通过，
未缩短生产政策：A慢下载期间同平台B零访问，真实native终态后29.9秒仍等待、首次访问在30.064秒；
429带`Retry-After: 1`仍遵守默认60秒共享退避，B在60.061秒后先进入，A在B终态后的冷却结束才受控重试一次。
无Retry-After时B同样等待60.047秒，A只访问一次且不派发模型，报告`pdf-browser-rate-limited`。
各场景C在独立平台先正式入库，全部预期发布/导出hash一致，无自动耗尽、临时额度0。
最新完整复跑3/3、无skip，236.21秒；证据依次为 `/tmp/sciretriever-policy-evidence-VryMaA/evidence.json`、
`/tmp/sciretriever-policy-evidence-V0maR3/evidence.json`、
`/tmp/sciretriever-policy-evidence-PqZcNj/evidence.json`。
该轮新增正式Completion结束及Application.close返回后的scheduler四项与文件额度归零断言。
模块加载早于其后“owned close成功覆盖先前stop错误”的Flow修复，普通成功/退避路径的覆盖范围明确保留，
不混写为后续新异常分支也已由该轮验证。
本场景不声称压到滑动窗口阈值，也不代替05独立的两个模型worker重叠生产证据。

最新Entry生命周期、交付lease取消与owned close合同修复后，`browser-article-flow.test.ts`完整66/66通过；
与scheduler13及publication lease3同轮共82/82，证据
`/tmp/sciretriever-browser-parallel-implementation-v9ay8y23/browser-owned-close-lifecycle-final.json`。

2026-10-05前次局部冻结回归为11文件135/135通过，JSON证据：
`/tmp/sciretriever-browser-parallel-implementation-v9ay8y23/browser-contracts-final-tests.json`。
命令的Browser部分为 `pnpm exec vitest run apps/server/test/browser-article-flow.test.ts
apps/server/test/browser-article-session.test.ts apps/server/test/browser-pacing.test.ts
apps/server/test/browser-decision.test.ts`：60+11+2+16项；同次其余HTTP/Web、合同与publication测试见06。
可控单调时钟覆盖模型permit队列600秒不计时、重叠区间并集、平台exclude后硬截止重设、1秒/5.1秒
反馈与4.999秒前无新派发、反馈/节奏间取消、下载撤销迟到模型、失败回原root页、第二429终止、
局部文件系统故障立即结束与可恢复远端失败后Stop仍保留failure。

`production-parallel-workbench.test.ts`另证明生产协作不建立第二模型循环：200ms活跃硬截止到达时，
执行器及工作台都显示0剩余；模型permit队列中新指导只留到下一请求，不将未发送内容标为已消费。
真实派发通知来自Agents/HTTP request.end；scripted invocation只存在于明确的旧standalone测试seam。
Agent JSON只提供actions/model_calls/deadline_ms三项执行预算，Workbench旧bytes字段继续兼容，
不把0或旧16MiB值送给模型作为文件上限，input hash对应实际输入。

实际Cloak `146.0.7680.177.5` / Playwright `1.55.0`本地production测试连续两次1/1通过，
精确命令使用bundle `/tmp/sciretriever-m04-cloak-Iacd3r/bundle`，测试文件 `browser-cloak-pacing.test.ts`。
页面第一次动作不立即改变正文，而在5100ms后出现PDF按钮；真正loopback模型HTTP收到两次观察，
第二次包含新按钮，距首次模型响应超过5秒，按钮出现后不足2秒即派发，没有额外等待另一个完整5秒。
正式DatabaseCompletion完成文件接纳及主PDF入库，678字节hash一致、文章身份标为unverified。
第一次时点证据在 `/tmp/sciretriever-cloak-pacing-evidence-mwBXXb/evidence.json`（按钮事件后184ms
派发），最终代码复跑证据在 `/tmp/sciretriever-cloak-pacing-evidence-WkH5Zk/evidence.json`。
全程使用合成home/Profile/catalog、本地出版社fixture和本地模型响应，没有读取个人配置或访问真实网站。

## 退出条件

会话可单步挂起/恢复，时间和计数只有一个owner；下载/排队不消耗活跃预算，真正操作仍受到300/50/100约束。
迟到决策、控制权改变和文件就绪不会派发多余动作；生产对象图可消费03的step结果。

## 恢复与交接

计时或phase竞争失败时停在对应Task，以精确事件顺序重现，不放宽上限或添加固定sleep掩盖。
04接收started/terminal事件消费边界，05接收就绪时间/remaining/step接口，06接收控制epoch与取消结果。

## 2026-10-07最终收口

本块实现、直接回归与必要生产对象图证据已并入最终验收；Full189文件/1,266项通过、39项条件跳过、build通过。
最后源码清单142项、hash55a59148dcabd9d2a8345d8b4c9b689831b92307bcc6f04e1bab726306fc0c01。
具体版本、影响审查、逐出版社结果和外部未决范围见最终验收记录（本地文件：`sandbox/reports/browser-final-acceptance-2026-10-07.md`，不随仓库分发）。
此前记录保留其发生时的版本与结论；当前块状态以上述最终收口为准，不将历史失败改写为当时通过。
