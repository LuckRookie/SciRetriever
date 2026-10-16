# Block 04：后台传输、大文件与正式发布

> **状态**：Completed（2026-10-07最终验收；外部访问限制见Block07） · **Owner**：主执行者 · **上级计划**：[README](README.md)
> **前置**：1.3/1.5、02退出条件；与03对接事件 · **后续**：[05 调度](05-platform-scheduling-and-configuration.md)、[06 恢复](06-workbench-recovery-and-shutdown.md)、[07 验收](07-end-to-end-verification-and-handoff.md)

## Outcome

文件下载能在Agent停止决策后独立完成。字节获取、PDF检查、候选恢复、hash、发布和导出不再因为旧16MiB/512MiB边界
或整文件内存读取而拒绝正常的大型材料；传输无进度、磁盘不足和取消能够结束并释放本任务资源。
最终仍走现有Candidate→acceptance→publication→primary-pdf合同，文件标为文章身份未验证。

## 进入条件

1.3已为对应通路提供实际Cloak取流与单transfer进度证据，1.5明确候选与发布交接，02能隔离传输与局部清理。
原生下载、PDF response和明文HTTP需要分别取得证据；某一路失败不阻止先做独立文件owner工作，但不能勾选通用大文件交付。
测试仅使用生成的有效PDF与临时存储，不改写用户资产或真实catalog。

## 责任边界

Browser拥有下载句柄、进度和临时浏览器文件；Acquisition拥有文件合法性、任务归属及候选接纳；
Storage拥有安全句柄、分块读取、hash和create-if-absent；Literature/原publisher拥有事实提交。

主要位置：`browser/transfers.ts`、`transfer.ts`、`acquisition/browser-intake.ts`、`pdf-acceptance.ts`、
`candidate-acceptance.ts`、`candidate-publication.ts`、`storage/files/{staging,reader,publication,store}.ts`、
`network/browser-proxy.ts`及`packages/contracts/src/index.ts`的实际大小合同。

## Tasks

- [x] **4.1 接通有身份的传输生命周期。** started/progress/completed/failed按session/transfer送给同一owner，
      一个会话原子选择一个主transfer；同一请求的native与response fallback去重，其它额外下载被取消或明确拒绝。
      入队依据真实下载/响应接管事实，不依据模型说已点击；重复/迟到事件不二次占槽或释放。
      **验收**：started立即使03停止后续决策；完成只交给原会话；A取消后B仍正常，重复回调只发生一次有效结算。
- [x] **4.2 实现原生下载的有界落盘和进度。** 使用1.3确认的Browser进度/句柄方案，追踪实际字节和真实结束；
      浏览器生成的临时文件也计入资源预算，完成后通过安全句柄分块接入Storage，不根据目录中新文件猜测文献归属。
      取消必须调用真实下载取消并等待停止写入，不能只取消Promise后删除仍有写者的文件。
      **验收**：持续下载超过30秒可成功；停滞可终止；部分文件、错误长度和取消时的原生文件有确定清理责任。
- [x] **4.3 打通PDF响应与HTTP通路。** 用已验证的同会话流式接管处理inline/fetch PDF；HTTP代理转发也不能先缓冲完整响应。
      保留浏览器原请求的访问身份，不改为另发无会话GET；不因Content-Length缺失或虚假而绕过实际字节计量。
      尚无法取流的通路仅允许已证实实际大小的小文件兼容路径，明确报告其大文件缺口，不借此勾选本Task。
      **验收**：native、inline、response与HTTP跳转都能取得同一合成PDF并核对hash；206片段不能冒充完整文件。
- [x] **4.4 将Intake和reader改为文件边界。** Intake分块写入并计算hash，使用安全句柄/fd调用pdfinfo，读取必要头尾而非完整字节数组。
      acceptance重新复核时复用受验证文件引用；如复用检查结果，必须绑定相同hash与文件身份。
      保持实际PDF可读取、至少一页及当前非加密文件合同；不新增DOI/标题/版本内容匹配。
      **验收**：大文件与无可提取文字PDF可以通过，HTML伪PDF、损坏/截断文件失败；fd替换、符号链接和文件变化不能越过检查。
- [x] **4.5 贯通候选、发布、恢复与导出。** 检查collector的candidateBytes/recover/publish/verify、Storage的describe/sha256File、
      现有artifact导出是否仍整块readFile或受512MiB硬常量阻断；改成受控分块接口并同步消费者。
      contracts中的候选大小范围与资源策略一致，已有asset/candidate/receipt仍可读取，不迁移或覆盖历史对象。
      **验收**：跨512MiB的合成PDF从接收直到正式导出hash一致；Public/API/manual-PDF的共享验收和发布回归保持。
- [x] **4.6 缩小大文件写锁占用。** 文件hash扫描与准备/复制在长时间catalog临界区外完成；最终发布仍做文件身份复检、
      create-if-absent、冲突证据和receipt/CAS提交，保持中断恢复协议。不能把普通rename当成无覆盖保证。
      **验收**：大型文件准备期间其它catalog写入可推进；目标已有不同字节拒绝且保留证据；锁外文件变化、取消和提交中断不会采用错误文件。
- [x] **4.7 完成候选与publication交接。** 文件有效后结束探索，Entry沿现有acceptance提交，再释放文章会话。
      文件损坏/排除hash回03恢复；本地publication失败保留有效候选与回执，不重新访问出版社。
      一旦事实提交，随后页面清理失败单独报告，不能撤销资产；候选就绪与caller publication之间不得互相await死锁。
      **验收**：成功、验收失败、CAS变更、publication中断、提交后关闭失败五条路径均有确定结果和文件责任。
- [x] **4.8 统一实际资源计量。** 用累计真实字节和磁盘余量管理浏览器原文件、staging及临时副本，落实下表保护起点。
      无进度时钟只由本transfer新增字节刷新；其它网页的HTTP/2流量或CONNECT活跃不能延长它。
      资源不足报告可解释的资源原因，不当作无PDF；所有异常释放属于本会话的额度，已发布资产不列为临时垃圾。
      **验收**：小配额fixture触发满额/磁盘保留边界、未知长度、持续涓流、其他连接活跃及取消竞争，均无无界写入。
- [x] **4.9 形成大小、内存和进度证据。** 分别生成小文件、超过16MiB、超过512MiB的有效PDF，不把大BLOB提交到仓库。
      覆盖慢于30秒、错误长度和中断，测量Node及Browser进程树峰值内存/临时磁盘、传输和reader耗时。
      **验收**：记录基线、实际峰值和取样限制；内存不随完整文件重复拷贝增长，不能只凭入口用了stream作结论。

## 资源保护起点

| 资源           | 初始方案                          | 如何验证/调整                                    |
| -------------- | --------------------------------- | ------------------------------------------------ |
| 受管理下载     | 每会话一个；受保留会话cap约束     | 4.1、05容量测试；不另设下载credit池              |
| 临时文件总额   | 4GiB，含Browser原文件与复制中间物 | 用小预算fixture精确验边界，4.9记录大文件实际占用 |
| 保留空闲磁盘   | 1GiB                              | 注入余量变化；不能仅看Content-Length预估         |
| 无字节进度     | 连续120秒                         | 单transfer时钟，假时钟与真实慢服务各有证据       |
| 单项传输总寿命 | 20分钟                            | 超时实际取消写者；仍在接收微量数据也不无限持续   |
| 保留会话总寿命 | 60分钟                            | 05/06统一截止，不因恢复重新计时                  |

这些是本机保护默认建议，不是出版社或PDF业务大小规则；1.6/5.5集中明确配置/展示方式，实施证据可促成调整并记录原因。
原16/512MiB常量的扩展不意味着无上限；PDF reader的CPU/地址空间保护与输入文件大小不是同一个预算。

## 集成与影响

Storage共享接口变化影响其它材料、manual-PDF、恢复和导出，必须核对消费者；不能只让Browser新路径绕过旧保护。
不新增catalog大BLOB、绝对路径、新publication owner或资产覆盖能力。必要依赖须由1.3证据说明用途并验证安装，不能顺手升级。

## 验证

```bash
pnpm exec vitest run apps/server/test/browser-transfer.test.ts apps/server/test/browser-complex-capture.test.ts apps/server/test/pdf-acceptance.test.ts apps/server/test/candidate-acceptance.test.ts apps/server/test/candidate-publication.test.ts apps/server/test/file-staging-lifecycle.test.ts apps/server/test/immutable-file-store.test.ts apps/server/test/manual-pdf-maintenance.test.ts
```

`browser-production-loopback.test.ts`保留小文件正式路径，独立`browser-large-production-sample.test.ts`覆盖真实Cloak慢下载/大文件；
大型合成材料按块生成并只保留在临时目录。默认样本为17MiB，完整513MiB通过显式开关运行：

```bash
SCIRETRIEVER_CLOAK_BUNDLE=<verified-bundle> pnpm exec vitest run apps/server/test/browser-large-production-sample.test.ts
SCIRETRIEVER_CLOAK_BUNDLE=<verified-bundle> SCIRETRIEVER_BROWSER_513_MIB=1 pnpm exec vitest run apps/server/test/browser-large-production-sample.test.ts -t 'slow 513 MiB'
```

低层读取断言、实际进程资源样本、正式入库导出三种证据都要有；RSS单次采样不能单独证明峰值上限。
4.6需包含并发catalog写入与故障窗口，不通过mock掉FileStore或publication owner得到通过。

## 当前证据

1.3运行时探针已实际7/7通过，原生GUID进度、同请求pull IO取流、真实取消和HTTP代理EOF前转发证据见
[01的1.3记录](01-baseline-and-runtime-contracts.md#13-下载进度与原请求取流证据2026-10-05)。文件owner与正式Browser样本证据如下；
4.7/4.8的清理诊断、失败结果与取消记账已另行修正和直接验证，没有用成功大小矩阵代替失败路径验收。

- Intake、正式acceptance、候选恢复、hash验证和导出现在使用作用域内受验证文件、1MiB分块及受控fd。
  `pdfinfo /proc/self/fd/3`继承只读fd，可seek，保留512MiB地址空间、CPU、时间及输出保护；
  该读者进程资源预算不再被当成输入PDF大小限制。HTML伪PDF、损坏/截断、加密、变化或被替换的文件仍失败；
  至少一页但没有可提取文字的PDF通过，不新增文章身份匹配。
- `large-pdf-file-chain.test.ts`实际写入每个字节，17MiB和513MiB未压缩合成PDF在接收、recover、acceptance、
  immutable publication和正式导出后hash一致；不是sparse transport。513MiB实际537,919,898字节，
  hash `95fbb4ceb1dde7b3815514a4974f81f64d8a67d7568e799b64ca85696f493088`，reader最大chunk 1,048,576字节。
  最新证据在 `/tmp/sciretriever-large-pdf-evidence-6uE9VP/evidence.json`、`/tmp/sciretriever-large-pdf-evidence-WrAy8D/evidence.json`。
  同次还复制并安全回收537,919,898字节未注册技术产物，确认旧512MiB descriptor上限不再阻断recovery/reclaimer，
  正式PDF仍保留。包括该回收的513MiB全过程耗时48.04秒；Node初始RSS222,257,152、20ms采样峰值225,402,880字节。
  临时owner账本峰值1,075,839,796字节，即两份完整文件；最终临时额度为0，持久candidate/asset仍保留。
  这些是单Node进程与文件写入确认值，采样可能漏掉短峰值，不含Browser原件和Browser进程树。
- hash扫描、私有副本准备和fsync在catalog admission外完成；短提交复核source及目标目录/inode、
  exclusive link、create-if-absent和receipt/CAS。5项直接准备测试证明真实catalog写入可在准备阻塞时推进、
  锁外源/副本/父目录改变被拒绝、不同目标字节保留冲突证据。18项publication测试包含link后崩溃恢复、
  丢失事务响应、metadata CAS变化、最多3次真实目标竞争、准备后durable candidate替换，以及三个回执返回点的目标/ID绑定。
- `BrowserDownloadResources`提供共享4GiB临时账本和1GiB磁盘保留；Storage只消费中性temporary预算port。
  原生原件、Intake stage及publication preparation分别计量；受控write前预留，确认写入后消除重复磁盘扣减，
  真正清理或转为immutable持久对象后释放。9项小预算测试已通过，覆盖未知长度、其它transfer保留、
  preparation副本超额、磁盘余量变化、同时未落盘预留、native累计字节重置及取消竞争；
  持久文件虽退出临时账本，实际statfs余量仍保护后续写入，预留期间取消不会写入新字节。
  原生CDP计量有约500ms观测滞后；配额拒绝触发真实cancel并等待终态/retire，末笔计量结算后才释放。
  120秒stall只由同transfer新增字节刷新，20分钟总寿命不因持续涓流延长；实际与直接计时器证据见下。
- PDF reader错误保留原`pdf-acceptance`外层code，通过cause区分主动timeout、caller取消、工具不可用、输出上限及资源失败；
  7项读者测试通过。Public/API和manual-PDF当前显式bytes入口原有大小策略保持，回归验证共享acceptance/publication行为。

文件链集成回归6个文件52/52通过；最新资源/读者/不可变文件/publication回归8个文件54/54通过，
大文件及recovery/reclaimer/abandonment回归5个文件41/41通过。源码构建类型检查、测试strict类型检查、
本执行者文件的Prettier/ESLint及diff检查均通过。
本执行者未运行全仓Quick或Full；最终Quick/Full与生产对象图由主执行者统一验收。
保留manifest自身16MiB上限、hash/目录/链接保护及已确认事实保护；没有迁移或覆盖旧资产。

### 正式Cloak大小与资源样本（2026-10-05）

`browser-large-production-sample.test.ts`使用已验证Cloak `146.0.7680.177.5` / Playwright `1.55.0`、
合成临时home/profile/catalog和只读本地fixture。真实Bootstrap→Host→Intake→Completion→acceptance→publication→export未替换；
只将模型transport替换为确定的合成动作。每个PDF字节实际由1MiB未压缩块生成和背压写出，响应不带Content-Length。
资源预算与PDF合法性检查仅包裹观察和计时，仍调用真实owner和`pdfinfo`。

| 样本                   |              实际完整字节 |                                  源站传输 | PDF合法性两次检查 |       Node初始 / 采样峰值 | Node与子进程树采样峰值 | 临时账本写入峰值 / 终态 |
| ---------------------- | ------------------------: | ----------------------------------------: | ----------------: | ------------------------: | ---------------------: | ----------------------: |
| Native 17MiB慢流       |                17,826,200 |                        34.61秒，含4秒停顿 | 49.09 / 38.57毫秒 | 203,202,560 / 227,954,688 |          1,281,310,720 |          53,478,600 / 0 |
| Native 17MiB中断后恢复 |                17,826,200 | 首次3,145,950字节后中断；第二次4.25秒完成 | 42.65 / 58.08毫秒 | 233,369,600 / 251,486,208 |          1,316,073,472 |          53,478,600 / 0 |
| Native 17MiB取消       | 未完成；停在2,097,374字节 |               终态后600毫秒字节数保持不变 |            未启动 | 243,466,240 / 245,039,104 |          1,322,987,520 |           2,097,374 / 0 |
| Native 513MiB慢流      |               537,919,898 |                        34.87秒，含4秒停顿 | 51.01 / 52.83毫秒 | 246,497,280 / 251,609,088 |          1,289,977,856 |       1,613,759,694 / 0 |

以上四样本同次实际4/4通过，161.00秒；完成样本从接收、recover、合法性复核、正式发布到导出hash一致，
文章身份仍为`unverified`。17MiB hash为`214938ebf9ed99ad4994b6072726ebf41e740443d047bd5bb942cf0f10ffe81b`；
513MiB hash与上述文件链相同。慢流各只有一次模型动作，下载期间没有后续决策。
中断后两次动作使用相同session，文章页只GET一次；取消样本无candidate、primary asset、receipt或exhaustion事实。
513MiB完整链耗时82.95秒；实际stat临时逻辑字节峰值1,613,759,694、分配字节峰值1,613,783,040，
与三份临时文件的owner账本相符。完成与取消后的GUID原件和Storage staging均为空。

最终四样本证据分别在`/tmp/sciretriever-large-browser-evidence-7rePsB/evidence.json`、
`/tmp/sciretriever-large-browser-evidence-PywBAr/evidence.json`、`/tmp/sciretriever-large-browser-evidence-lcl9UT/evidence.json`、
`/tmp/sciretriever-large-browser-evidence-7JBVeH/evidence.json`。
先前独立513MiB样本也实际通过，证据`/tmp/sciretriever-large-browser-evidence-1VNR9C/evidence.json`；
该次Node初始208,826,368、采样峰238,587,904，进程树峰1,295,921,152。独立初始值与同次多样本后的Node保留堆差异已保留，
不能把两次运行的基线差当作PDF内存增长。

另一个17MiB fetch attachment正式样本实际1/1通过（44.15秒），证据`/tmp/sciretriever-large-browser-evidence-DWZ9aU/evidence.json`。
原会话合成header保留，源站仅一个PDF GET，Intake在源站EOF前已有真实写入，每块不超过65,536字节；
没有native原件，仍沿相同正式恢复、发布和导出验证相同hash。小文件inline/native、HTTP 302、原请求pull IO与错误长度
已有1.3实际探针，206拒绝、attachment fetch分类、EOF先结束IO网络再开始本地validation由`browser-cdp-owner.test.ts`直接验证。
Host/owned-sessions真实Cloak三轮同URL不同hash、局部关闭、后台持续和1KiB quota取消由Browser归属执行者验证；
dispatcher仅单transfer新增字节刷新stall，重复progress及A绑定压力不会延长或撤销B。

采样目标间隔100毫秒，重叠采样会跳过，四次分别取得204/86/37/366个样本；只读取数字PID关系与RSS，
不读取cmdline或环境。子进程树包含Node、Cloak和短暂PDF reader，共享页可能重复计入；
reparented进程、读取间隙退出和短峰值可能漏采。磁盘stat只计fixture所属native原件、staging和publication临时文件，
持久candidate/asset/export不算临时垃圾；17MiB短复制峰可能漏采，由owner预留及确认写入峰值补充。
reader计时只包含真实`acceptPdfFile`合法性检查，文件作用域hash扫描另计入全链耗时。
实际观测支持有界分块没有按完整PDF重复驻留内存的结果，不将样本RSS当作通用硬上限。

### 单篇与多会话混合负载比较（07.3）

独立`browser-large-mixed-production.test.ts`使用相同17MiB合成PDF，让A持续未知长度native慢流，
B/C各经过两轮正式模型HTTP、页面动作、Intake、验收与发布。模型使用正常OpenAI-compatible transport访问loopback服务，
没有注入`agentTransportFactory`。该综合场景实际1/1通过，无skipped，Vitest耗时48.21秒；
证据在`/tmp/sciretriever-large-mixed-browser-evidence-lNUzmz/evidence.json`。

A源站实际传输34.61秒。A开始4.06秒后，B/C两个模型HTTP请求同时在途，A已写2,097,374字节；
B/C第二轮实际HTTP请求在A开始9.36/9.49秒后派发，两篇正式primary asset在11.06秒时均已可读，
此时A只写6,291,678字节、尚未EOF且没有primary asset。最后三篇candidate恢复、正式asset和导出hash一致，
A大小17,826,200字节，B/C各680字节，最终临时额度0、native原件和staging为空。
A按块持续写出全部17MiB；仅最终trailer/EOF设置等待B/C发布的确定性保护，该次B/C早已发布，未延长源站传输。

| 资源指标                           |           单篇17MiB慢流 | A大文件+B/C页面及模型混合负载 |
| ---------------------------------- | ----------------------: | ----------------------------: |
| Node初始RSS                        |             203,202,560 |                   210,214,912 |
| Node采样峰值RSS                    |             227,954,688 |                   250,822,656 |
| Node及可观测子进程树采样峰值RSS    |           1,281,310,720 |                 1,546,104,832 |
| 最多可观测descendants              |                      10 |                            13 |
| 临时owner账本预留/确认写入峰值     |              53,478,600 |                    53,478,600 |
| 临时logical/allocated stat采样峰值 | 35,652,400 / 35,663,872 |       35,652,400 / 35,663,872 |
| 最终临时额度                       |                       0 |                             0 |

混合样本保留193次进程/账本采样，两个小篇模型推进与A后台下载阶段含35次采样；
该阶段进程树峰值1,546,104,832字节。以上是两个独立进程运行的实际比较，Node初始值不同，
不能把基线差或整个Browser树峰值差解释为PDF字节内存增长或通用上限。
100毫秒目标采样会跳过重叠采样并可能漏短峰值；临时stat漏掉短三副本峰时，由owner账本53,478,600字节补充。
共享页重复、reparented进程、退出间隙和native CDP约500毫秒滞后等限制与上节相同。
这个单一综合样本没有增加513MiB混合、fetch/inline/HTTPS CONNECT组合的实测声明。

```bash
SCIRETRIEVER_CLOAK_BUNDLE=<verified-bundle> pnpm exec vitest run apps/server/test/browser-large-mixed-production.test.ts
```

### 失败路径审视与闭环

- **4.7 清理失败根因**：原先scheduler/Entry只记录`browser-flow-close-failed`，丢失内层稳定原因。
  root已将允许的`browser-platform-handoff-stalled`等原因绑定到独立安全诊断和lease关闭错误，
  失败资源保持quarantine；已发布PDF事实不回滚，不传播原始message/URL。直接cleanup cause测试已通过。
  `browser-publication-lease.test.ts`的成功、publication失败保留候选、提交后关闭失败3项通过；
  CAS/事务中断和回执重放由18项`candidate-publication.test.ts`补充，正式成功路径由上述生产样本证明。
- **4.8 失败结果**：原先`transferFailed`统一恢复，随后Stop可能成为exhausted，资源/reader故障被误报无PDF。
  合同执行者已让本地资源/reader/Storage故障成为稳定失败，普通远端中断仍允许恢复，但未解决的失败不变成exhaustion；
  后续有效candidate才清除旧失败。Entry保留受控`pdf-reader-*`原因。7项本地失败、1项后续恢复及1项cleanup cause实际9/9通过。
- **4.8 取消终态计量**：发现quota拒绝会使后续计量Promise跳过。资源执行者已修为继续记录终态新增字节、
  保留第一次拒绝，并在真实退役且末笔计量结算后释放。直接150→210终态字节、磁盘恢复/退役竞争、stall及总寿命
  等dispatcher6/6通过；最新5文件资源/publication回归40/40通过。修正后真实Cloak 1KiB quota取消和production17MiB取消
  两项实际2/2通过，后者证据`/tmp/sciretriever-large-browser-evidence-J5wDi9/evidence.json`，最终额度0、无新事实。
- **共享runtime丢失收敛**：Host局部controller原本不能唤醒scheduler的模型/changed等待。
  Host/Bootstrap现在一次通知`BrowserArticleScheduler.runtimeLost()`；scheduler通过原finish/close路径结束queued和未交付的active票，
  在abort前固定首次终态原因并停止新派发。已交付候选保留Entry的publication lease，不撤销有效文件或已发布事实。
  真实`browser-runtime-loss-production.test.ts`用一个在途模型HTTP、一个120秒WaitForChange和一篇已发布论文，
  对精准合成Profile发`Browser.close`，实际1/1通过，无skipped或uncaught；请求后53.79毫秒Completion返回，
  已发布PDF事实和hash保持、三个execution均closed、临时各类额度0、caller未abort且失联后无模型派发。
  证据在`/tmp/sciretriever-runtime-loss-evidence-JuqdkV/evidence.json`。
  两条协议通道不保证事件顺序：模型票保留`pdf-browser-runtime-lost`，本次WaitForChange先观察到真实页面关闭，
  通过PageRuntime的`BrowserPageClosedError`保留`pdf-browser-page-closed`，不泛化为共享丢失或降为generic flow failure。
  直接scheduler回归证明queued/model/changed均唤醒、新工作拒绝及delivered lease仍可published；
  与现有scheduler/lease三文件14/14通过，稳定Flow taxonomy四项4/4通过（57项未匹配`-t`而skip）。
  新增源/测试的Prettier、ESLint、源码构建和测试strict通过；未降低生产timeout、强制清队列或运行全仓Quick/Full。
- 120秒无新增字节和20分钟总寿命是生产默认值；计时器使用直接fake时钟与真实持续慢流验证，
  20分钟默认总寿命还用连续19分钟新增字节、截止前1毫秒与截止时真实cancel调用的fake时钟直接证明，未执行真实20分钟等待。
  最新源码构建类型检查、测试strict、所改TS Prettier/ESLint和diff检查通过；全仓Quick/Full和最后对象图验收仍由root执行。

## 退出条件

文件可在Agent暂停期间完成，并沿同一事实owner正常入库；全部受支持capture通路得到必要证据。
跨旧大小边界、持续慢下载、停滞、磁盘不足、取消、发布恢复及共享写锁均闭环，或保持明确未完成而非降格验收。

## 恢复与交接

损坏/中断回会话恢复，发布失败回候选/receipt恢复，存储安全或归属冲突立即停止该路径并保留证据。
取消后先确认写者停止，再处理未发布临时文件；不能删除已接纳资产来获得干净目录。
05接收真实started/terminal事件和资源使用，06接收局部取消/发布后清理合同，07接收可复现的大小与进度矩阵。

## 2026-10-07最终收口

本块实现、直接回归与必要生产对象图证据已并入最终验收；Full189文件/1,266项通过、39项条件跳过、build通过。
最后源码清单142项、hash55a59148dcabd9d2a8345d8b4c9b689831b92307bcc6f04e1bab726306fc0c01。
具体版本、影响审查、逐出版社结果和外部未决范围见最终验收记录（本地文件：`sandbox/reports/browser-final-acceptance-2026-10-07.md`，不随仓库分发）。
此前记录保留其发生时的版本与结论；当前块状态以上述最终收口为准，不将历史失败改写为当时通过。
