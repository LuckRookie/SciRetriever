# ADR 0030：Browser 临时访问、页面交接与下载完成

- Status: Accepted
- Date: 2026-10-04
- Updated: 2026-10-05（接受独立文章会话、后台下载与发布交接）
- Amends: [ADR 0023](0023-generic-browser-agent-executor.md)、[ADR 0012](0012-process-local-provider-access-scheduling.md)（Browser 网络资格生命周期）、[ADR 0015](0015-publisher-aware-tiered-pdf-acquisition.md)（平台调度与会话 cap）
- Related: [ADR 0029](0029-unverified-pdf-acquisition.md)

> 2026-10-05 修订是已接受的目标合同；后台传输、多会话、资源保护和发布交接仍需
> [实施计划](../../archive/2026-10-05-browser-parallel-downloads/README.md)中的生产接线与验收。
> 本文不以决策状态宣称这些能力已交付。

## 背景

真实跨出版社测试暴露了几项通用责任混淆：用于持久 locator 的无凭据 URL 规则阻断网页临时
下载链接；代理把一个可能承载多项 HTTP 请求的 TLS 长连接当成一次请求，导致空闲连接占满
预算并在固定时长后切断有效流量；等待 DOMContentLoaded 和字体阻止已可读页面交给 Agent；
模型动作的扁平 nullable schema 允许互相矛盾的字段；文件已验收后继续探索又可能掩盖下载成果。
这些不是出版社规则差异，不能靠逐站 selector 或提高 timeout 解决。

## 决策

1. **临时传输与可保存来源分开。** 已访问页面提供的 HTTP/HTTPS 跳转、编码路径和临时 query
   可以在 Browser/Network 内存中使用。每个 origin 仍按端口、DNS 全部地址分类及 IP pinning 准入；
   禁止 URL 用户名/密码、控制字符和私网访问。multipart 只是一种 HTTP 表单编码，允许页面
   提交自身生成的数据；本地文件选择在 file chooser 与受控动作边界阻止，不通过 Content-Type 猜测。
   模型观察、capture provenance、日志和持久 locator
   不获得临时 query/fragment。公开/API locator 的严格语法不放宽；不注入或跨 origin 转移 API 凭据。
2. **连接和请求使用各自生命周期。** CONNECT 的预算覆盖建立连接，建立后释放请求 permit。
   存活隧道有独立进程资源上限和空闲超时，流量刷新空闲计时；不把加密隧道累计字节误当成一份
   PDF 或一次上传。浏览器只在已准入地址集合中选择可连接的 IPv4/IPv6，不重新查系统 DNS。
   HTTP 响应、PDF Intake 的实际资源计量、文章活跃预算和取消/清理继续生效。
3. **可观察就交接。** 初始导航到 commit 即可交给 Browser runtime；正文和可见控件出现时，
   不要求所有子资源或字体完成。WaitForChange 观察文档代次和可见文本/readyState 的变化；
   动作结束至下一轮模型决策至少 5 秒，与页面反馈等待重叠。导航销毁执行上下文或窗口尚无可见尺寸时重新观察，不重放旧动作；
   工作台自动模式同样重试暂未就绪的观察。子标签页无历史记录时，GoBack 关闭该子页并返回原文章标签页。
   正文观察只包含可见文字，不把 hidden/noscript 或输入内容伪装成用户看到的页面；控件名称读取
   aria-label、title、可见文字和图片 alt。坐标点击反馈实际命中元素是否具有链接/按钮语义，
   便于 Agent 在点击无效时改选可见控件。截图失败时保留可用 DOM；存在敏感输入时不得切换到未遮罩截图。
4. **动作合同一致。** 模型工具使用包含六种封闭动作的 discriminated union，每种动作只包含
   自己的字段。运行时继续严格验证，不靠丢弃不合法字段让结果通过。提供有界的近期已执行动作，
   使 Agent 能区分首次进入与已经点击后的等待。坐标按当前 viewport 的 CSS 像素解释；
   越界坐标在派发前拒绝并反馈实际边界，拒绝的动作不记为已执行。页面不变不等于拒绝访问；重复输入被抑制为等待，
   直到新反馈、Agent Stop 或硬预算。模型等待结束后仍需检查截止时间，过期动作不执行。
5. **文件接纳后及时交付。** 原始 capture 事件仍不是成功；一旦 Acquisition Intake 确认文件
   合法并放入所属 session 的候选队列，生产 flow 结束探索并将 candidate 交给 Entry 的原 acceptance/publication。无需再等模型说 Stop。
   已接纳候选优先于随后 viewer/runtime 故障；取消、当前输入复检与不可变发布边界仍保留。
   无候选时只收敛真实进行中的 capture，不在空队列上等待后用 timeout 覆盖原始失败。
6. **外部结果可区分。** HTTP 429 是限流；只在主页面 GET 返回可用 Retry-After、剩余预算允许
   且本页未重试时等待后重试一次，否则保留限流原因，留待后续显式重试。连接失败、模型停止在
   验证/登录页面和预算耗尽分别报告，不能当作正常无 PDF 或自动获取耗尽。

### 文章会话、事件和资源所有权

Entry/Broker 拥有操作结果、就绪队列、worker 领取和平台/会话资格；Browser 拥有唯一文章
session 状态、页面/弹窗归属、输入控制 epoch、传输与会话资源。Acquisition 拥有文件合法性、
候选接纳/排除与 publication 交接，Literature/原 publisher 拥有当前输入复检和事实提交，
Storage 只保存被确认的字节与事实。Bootstrap 只组装这些 owner；Workbench 只投影选中 session。
不新增持久队列、文献状态、Agent 通讯或第二个 candidate/publication owner。

session 与 operation/generation、Literature、metadata snapshot 的关联在创建时固定。页面
及 opener 链必须在首次请求继续前取得唯一所属 session，transfer 在开始前绑定该身份和 page/
document generation；candidate 保留原 capture 关联。前台 page 或当前工作台目标不是归属依据。
无法证明归属时拒绝请求；迟到事件只能结清原 owner 的资源，不能被归给当前活跃文章。

| 事件                           | 唯一生产者                                     | 消费与结算                                                                         |
| ------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| transfer started               | Browser 的真实下载/响应接管                    | session 原子选择一个主 transfer、暂停决策并归还 worker；不释放平台网络资格         |
| transfer progress              | Browser 的该 transfer 字节计量                 | 更新自己的新增字节与无进度时钟；其它 HTTP/2/CONNECT 流量不能刷新                   |
| network completed/failed       | Browser 确认传输与文章网络实际结束             | 阻止保留页继续发请求后通知 Broker 释放网络资格，启动平台 30 秒冷却                 |
| candidate ready                | Acquisition 文件检查通过                       | 对应 session 停止探索，向 Entry 交付 candidate 与内部 lease；尚未表示 publication  |
| candidate rejected             | Acquisition 文件检查或操作内 excluded hash     | 结清被拒候选，原 session 保存失败反馈/剩余预算并重新观察；恢复重新排平台 start     |
| publication committed/retained | 原 acceptance/publication owner，经 Entry 交接 | published 保留已提交事实；本地失败 retained 保留有效 candidate/receipt，不重新下载 |
| session closed                 | Browser 完成该 session 的确定性收尾            | Broker 归还保留会话资格；不等待或取消其它 session                                  |

事件消费按固定 session/generation/transfer identity 去重。重复 started/terminal 不二次占槽或
释放；closed 或过期代次拒绝业务推进，仍由原 transfer owner 等待真实写者结束并收尾。
operation 寿命、本轮决策和 transfer 有独立取消域。下载开始可以撤销本轮模型执行权，不能
取消文件；单篇取消不关闭共享 context。只有 Application 整体关闭才停止派发、逐会话结清，
最后关闭共享 context/process/Profile lease，保留 Profile 与所有已提交事实。

### 候选与 publication 的无循环交接

生产 Browser delivery 返回已文件验收的 candidate 和可选内部 release lease，随后 Entry
调用原 `CandidateAcceptanceService`/publication，并在 `finally` 中通知 lease 关闭。
lease 只接收 `published(receipt_id)`、`retained(code)` 或 `cancelled`；关闭幂等且只结清
该文章的页面、传输、handler 与未交付临时资源。模型与工作台不获得 lease、路径或写入能力。
旧低层 seam 可省略 lease，生产对象图必须使用完整交接。

Browser 必须先返回 candidate，不能等待其调用方尚未开始的 publication；Entry 也不能在
acceptance 前等待 session close。候选交付后不占 worker 或模型 permit，但 session 继续
保留到 publication 结果已确定。publication/CAS/磁盘失败不 abandon 已交付有效候选，
保留原 transfer/intent/receipt 供既有恢复机制使用；publication 后清理失败单独报告，不能
撤销已发布资产或把获取改写为未发生。操作内 `excluded_sha256` 在 Intake 候选完成前检查，
排除不是正常耗尽，也不添加第二个 lease resume API。

平台网络资格与 session/文件责任分别结算：只有实际网络结束且保留页已失去后续请求资格后
才释放平台并开始 30 秒冷却，单纯释放 worker 或收到 EOF 但页面仍可发请求均不够。
本地 hash/reader/acceptance/publication 不继续占平台网络资格。换平台时不持有 A 等待 B；
旧平台网络停稳后重新排队。聚合显式串行配置、窗口和共享 Retry-After 仍照常生效。

### 有界文件与传输保护

字节获取、hash、reader、candidate 恢复、publication 和导出使用受控文件/分块边界，不以旧
16 MiB/512 MiB 常量决定正常大文件能否获得。每 session 最多一个主下载；临时资源仍有
进程总额、空闲磁盘、单 transfer 无字节进度、传输总寿命和保留会话寿命保护。首版实施起点为
临时文件总额 4 GiB（包括 Browser 原文件与复制中间物）、保留空闲磁盘 1 GiB、无新增字节
120 秒、单 transfer 20 分钟、session 总寿命 60 分钟；它们是本机保护值，不是 PDF 业务规则。
实际可用值和现场证据由配置/resource owner 与实施验收记录，不能用 Content-Length 代替实际计量。

原生取消必须终止真实下载并等待写者停止，再清理未发布文件；不能仅取消 Promise 后删除
仍在写入的路径。每条原生/inline/fetch/HTTP 通路分别证明有界取流；只能整块读取的通路保持
已验证小文件边界并报告大文件未完成，不以入口 stream 代替完整发布/导出和内存证据。

## 后果与验证

不增加出版社页面脚本、数据库状态或凭据格式，不迁移用户资料。Browser 仍是高成本兜底通道；
修复保证正常网页机制可以运行，不保证任何网站都接受当前 IP/Profile 或模型都能完成验证。

直接回归覆盖临时签名链接与私网拒绝、长连接不占请求队列、活动流量与空闲超时、延迟页面资源、
DOM 变化、严格动作、过期模型动作、文件接纳后的运行时故障及 429 条件重试。真实站点需另以
已授权的隔离 Profile、真实模型、正式 Intake/publication 和导出 hash 检验；离线测试不替代它。
