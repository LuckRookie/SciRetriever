# Block 03｜Browser 工作台与候选获取

## 块身份

- 状态：`In progress`；已有局部实现保留，但 Browser 出口、完整工作台、Transfer 生命周期、策略与端到端验收尚未闭环
- Tasks：43 项，以本文件 `Tasks` 为唯一任务定义
- 前置块：Block 02 `RUNTIME-FOUNDATION-ACCEPTANCE`
- 下游块：Block 04
- 恢复点：等待 Block 01、02 退出；进入本块后从 `BROWSER-HOST` 开始，不沿用旧的 Browser 完成声明

## 块结果

用户可通过受认证的本地工作台观看同一 Chromium 页面，人工与 Agent 在服务端控制权合同下操作；Browser
逐事件经过 Network admission，所有 response/download 形态在有界 drain 后形成 durable Candidate；
Acquisition 只生成 PDF、文章身份和版本证据以及可恢复 receipt，正式 Literature 资产发布留给 Block 04。

## 进入条件

Block 01 的运行时选择、威胁模型和迁移合同，以及 Block 02 的 Browser Network port、FileStore、repositories、
Agents 和 Application 对象图均通过 R3。Chromium/CloakBrowser、Profile、headed/headless、投屏和 PDF 引擎组合
必须由对应 spike 给出支持或 `not-run` 结论；真实站点不是进入条件。

## 责任与改动面

Browser Host 唯一持有 Browser/Context/Page/CDP；Network 唯一裁决每个导航、popup、frame 和资源请求；
Screen 只发布有界帧；工作台只消费 typed endpoint；Action Executor 是浏览器动作的唯一入口；Collector 持有
Transfer 与 Candidate 生命周期；Acquisition 裁决 PDF/identity/version 并发布 durable Candidate receipt。

## 需要保持的行为

普通 HTTP 与 Browser 请求不能绕过 Network；旧 epoch、旧 observation 和重复 request 不能执行动作；页面仍在
加载时允许返回 `partial + loading`，不得把 `networkidle` 当稳定性或成功条件；截图、页面、Agent 或工作台失败
不得删除已接收 transfer；Candidate 不是 Literature current fact，补充材料、不确定身份和错误版本不得成为主资产。

## Tasks

本节是本块 Task 定义与状态的唯一位置。[任务索引](task-ledger.md)只提供导航。路径均相对仓库根目录；
“拟新增”不表示文件已经存在。测试名只描述行为，禁止使用里程碑、阶段、步骤、块号或 Task ID 命名。

### BROWSER-HOST

- [ ] **BROWSER-HOST — 建立唯一 Browser Host，管理固定 Profile、页面集合、诊断与关闭。**
  - 状态：`In progress`；改动面：`apps/server/src/browser/`。
  - 依赖：[BROWSER-RUNTIME-SPIKE](01-baseline-and-contracts.md#browser-runtime-spike)、[APP-LIFECYCLE](02-runtime-storage-network.md#app-lifecycle)。
  - 验收：受支持 binary 在临时 Profile 打开 loopback 页面；第二实例不能抢锁；启动失败、崩溃和未知退出状态保留诊断，无法确认退出时不释放 Profile 锁。
  - 直接验证：`apps/server/test/browser-host.test.ts`；证据：`migration/evidence/browser-acquisition/browser-host.md`。

### BROWSER-EGRESS-INTEGRATION

- [ ] **BROWSER-EGRESS-INTEGRATION — 将 Browser 的每个外部事件接入不可绕过的 Network admission。**
  - 状态：`Pending`；改动面：`apps/server/src/browser/egress.ts`。
  - 依赖：[BROWSER-HOST](#browser-host)、[NETWORK-BROWSER-PORT](02-runtime-storage-network.md#network-browser-port)。
  - 验收：初始导航、redirect、popup、iframe、子资源、download URL 与 Service Worker 请求逐事件准入；拒绝事件在 socket/页面动作计数上可见为零，跨 origin 重做 DNS/IP、permit 与 credential 判断。
  - 直接验证：`apps/server/test/browser-event-admission.test.ts`；证据：`migration/evidence/browser-acquisition/browser-event-admission.md`。

### BROWSER-RECOVERY

- [ ] **BROWSER-RECOVERY — 定义 Host、Context、Page 和 Profile 的故障恢复与 fencing。**
  - 状态：`Pending`；改动面：`apps/server/src/browser/recovery.ts`。
  - 依赖：[BROWSER-HOST](#browser-host)。
  - 验收：page/context/browser 崩溃后 boot/page epoch 递增，旧句柄和旧请求全部失效；可恢复故障只重建所属资源，未知进程状态保持 fail closed，已 durable 的 transfer 不回滚。
  - 直接验证：`apps/server/test/browser-recovery.test.ts`；证据：`migration/evidence/browser-acquisition/browser-recovery.md`。

### BROWSER-OBSERVATION

- [ ] **BROWSER-OBSERVATION — 生成有版本、可截断并显式标注加载状态的 Observation。**
  - 状态：`In progress`；改动面：`apps/server/src/browser/observation.ts`。
  - 依赖：[BROWSER-HOST](#browser-host)、[BROWSER-RECOVERY](#browser-recovery)、[MODEL-RECORDS](01-baseline-and-contracts.md#model-records)。
  - 验收：Observation 绑定 boot/workspace/page/document/viewport/version；预算耗尽或慢 viewer 返回 `partial + loading`，不等待 `networkidle`；导航、resize、页面替换令旧观察失效，输出不含 Cookie、secret 或 vendor 对象。
  - 直接验证：`apps/server/test/browser-observation.test.ts`；证据：`migration/evidence/browser-acquisition/browser-observation.md`。

### BROWSER-ACTION-EXECUTOR

- [ ] **BROWSER-ACTION-EXECUTOR — 实现唯一、封闭且穷举校验的 Browser Action Executor。**
  - 状态：`Pending`；改动面：`apps/server/src/browser/action-executor.ts`。
  - 依赖：[BROWSER-OBSERVATION](#browser-observation)、[BROWSER-EGRESS-INTEGRATION](#browser-egress-integration)。
  - 验收：只接受 Accepted ADR 定义的封闭动作集合及有界参数；每个动作在执行前校验 observation/epoch/target，导航类动作重新 admission；任意 URL、selector、脚本、Cookie、文件上传和未知动作在浏览器调用计数为零时拒绝。
  - 直接验证：`apps/server/test/browser-action-executor.test.ts`；证据：`migration/evidence/browser-acquisition/browser-action-executor.md`。

### SCREEN-SOURCE

- [ ] **SCREEN-SOURCE — 从唯一页面生成带 viewport/version 的有界画面帧。**
  - 状态：`Pending`；改动面：`apps/server/src/browser/screen-source.ts`。
  - 依赖：[BROWSER-OBSERVATION](#browser-observation)。
  - 验收：帧绑定当前 page/document/viewport，像素与单帧大小有上限；页面切换后旧帧不成为当前画面；截图失败只产生诊断，不关闭页面或取消 transfer。
  - 直接验证：`apps/server/test/browser-screen-source.test.ts`；证据：`migration/evidence/browser-acquisition/browser-screen-source.md`。

### SCREEN-STREAM

- [ ] **SCREEN-STREAM — 向多个观看者发送有背压、可丢旧帧的单页面画面流。**
  - 状态：`Pending`；改动面：`apps/server/src/browser/screen-stream.ts`。
  - 依赖：[SCREEN-SOURCE](#screen-source)。
  - 验收：两个观看者看到同一 page/version；慢消费者只丢过期帧且收到最新状态，不无界排队；重连从当前 key frame 恢复，断线不改变控制权或 transfer 生命周期。
  - 直接验证：`apps/server/test/browser-screen-stream.test.ts`；证据：`migration/evidence/browser-acquisition/browser-screen-stream.md`。

### WORKBENCH-ENDPOINT

- [ ] **WORKBENCH-ENDPOINT — 提供本地工作台的会话、画面、控制和诊断协议端点。**
  - 状态：`Pending`；改动面：`apps/server/src/browser/workbench-endpoint.ts`。
  - 依赖：[SCREEN-STREAM](#screen-stream)、[APP-LIFECYCLE](02-runtime-storage-network.md#app-lifecycle)。
  - 验收：端点只暴露 typed DTO，绑定认证主体、workspace 和 boot；未知字段、跨 workspace、过期 cursor 与未认证连接在 Browser 调用前拒绝；本块只建立工作台协议，Block 05 再接入常驻服务总入口。
  - 直接验证：`apps/server/test/browser-workbench-endpoint.test.ts`；证据：`migration/evidence/browser-acquisition/browser-workbench-endpoint.md`。

### WORKBENCH-WEB

- [ ] **WORKBENCH-WEB — 实现可观看状态、控制权和错误的真实 Browser 前端。**
  - 状态：`Pending`；改动面：`apps/web/src/`。
  - 依赖：[WORKBENCH-ENDPOINT](#workbench-endpoint)、[SCREEN-STREAM](#screen-stream)。
  - 验收：真实前端展示画面、加载/partial、控制者、连接、transfer 与安全诊断；两个客户端可观看同一页；页面刷新或断线后按服务端状态恢复，不能用空壳页面或 server 测试代替前端闭环。
  - 直接验证：`apps/web/test/browser-workbench.test.ts`；证据：`migration/evidence/browser-acquisition/browser-workbench.md`。

### WORKBENCH-INPUT

- [ ] **WORKBENCH-INPUT — 将鼠标、滚轮、键盘和 IME 输入转换为受控动作。**
  - 状态：`Pending`；改动面：`apps/web/src/`、`apps/server/src/browser/workbench-input.ts`。
  - 依赖：[WORKBENCH-WEB](#workbench-web)、[BROWSER-ACTION-EXECUTOR](#browser-action-executor)。
  - 验收：坐标按帧 viewport/scale 转换；组合键、文本和 IME composition 不重复提交；只有当前控制者、当前 epoch 和当前画面版本可以输入，旁观者或旧版本请求零执行。
  - 直接验证：`apps/web/test/browser-input.test.ts`、`apps/server/test/browser-input-validation.test.ts`；证据：`migration/evidence/browser-acquisition/browser-input.md`。

### BROWSER-UNSUPPORTED-INPUT

- [ ] **BROWSER-UNSUPPORTED-INPUT — 对剪贴板、拖放、文件选择和未知输入显式拒绝或安全降级。**
  - 状态：`Pending`；改动面：`apps/web/src/`、`apps/server/src/browser/workbench-input.ts`。
  - 依赖：[WORKBENCH-INPUT](#workbench-input)。
  - 验收：未授权文件上传、拖放、剪贴板读写和未知 input kind 不触发浏览器 API；UI 显示可理解的 unsupported 结果；拒绝内容不进入日志、模型或持久任务。
  - 直接验证：`apps/web/test/browser-unsupported-input.test.ts`；证据：`migration/evidence/browser-acquisition/browser-unsupported-input.md`。

### BROWSER-CONTROL

- [ ] **BROWSER-CONTROL — 闭合单人工控制者、观看者、takeover/release 与重连。**
  - 状态：`In progress`；改动面：`apps/server/src/browser/control.ts`、`apps/web/src/`。
  - 依赖：[WORKBENCH-INPUT](#workbench-input)、[BROWSER-UNSUPPORTED-INPUT](#browser-unsupported-input)。
  - 验收：两个真实客户端可观看且同一时刻仅一人控制；takeover/release 更新 epoch，旁观者、错 workspace 和旧 epoch 请求零执行；断线策略确定且重连不会复活旧控制权。
  - 直接验证：已有 server 测试 `apps/server/test/browser-control.test.ts`，拟新增 web 测试 `apps/web/test/browser-control-flow.test.ts`；证据：`migration/evidence/browser-acquisition/browser-control.md`。

### TRANSFER-DISPATCH

- [ ] **TRANSFER-DISPATCH — 统一接收 response、download、popup、frame 和 viewer 产生的传输信号。**
  - 状态：`Pending`；改动面：`apps/server/src/browser/transfer-dispatch.ts`。
  - 依赖：[BROWSER-HOST](#browser-host)、[BROWSER-EGRESS-INTEGRATION](#browser-egress-integration)、[FILE-STAGING](02-runtime-storage-network.md#file-staging)。
  - 验收：每个事件映射到稳定 transfer ID 与生命周期；未知、迟到和关闭后的事件被记录后丢弃，不产生第二套下载 owner；事件 listener 在 Host 关闭时确定性释放。
  - 直接验证：`apps/server/test/transfer-dispatch.test.ts`；证据：`migration/evidence/browser-acquisition/transfer-dispatch.md`。

### TRANSFER-RESPONSE-FORMS

- [ ] **TRANSFER-RESPONSE-FORMS — 捕获 GET/POST、inline、attachment、blob/data 和 viewer 响应形态。**
  - 状态：`Pending`；改动面：`apps/server/src/browser/transfer-response.ts`。
  - 依赖：[TRANSFER-DISPATCH](#transfer-dispatch)。
  - 验收：loopback 覆盖 navigation response、POST response、Content-Disposition、内嵌 viewer、blob/data URL 和延迟 download；不可读取、HTML、截断或超限形态返回准确结果且不宣布 PDF 接纳。
  - 直接验证：`apps/server/test/transfer-response-forms.test.ts`；证据：`migration/evidence/browser-acquisition/transfer-response-forms.md`。

### TRANSFER-RANGE-ETAG

- [ ] **TRANSFER-RANGE-ETAG — 正确处理 Range、206、ETag 与重取边界。**
  - 状态：`Pending`；改动面：`apps/server/src/browser/transfer-response.ts`。
  - 依赖：[TRANSFER-RESPONSE-FORMS](#transfer-response-forms)。
  - 验收：同一实体的有序 range 可组装并核对总长/validator；缺段、重叠冲突、ETag 改变、200/206 语义不一致均拒绝 durable-ready；重取仍经过 Network permit 与字节预算。
  - 直接验证：`apps/server/test/transfer-range-etag.test.ts`；证据：`migration/evidence/browser-acquisition/transfer-range-etag.md`。

### TRANSFER-ATTRIBUTION

- [ ] **TRANSFER-ATTRIBUTION — 将 popup、iframe、viewer 和 Service Worker 传输归属到正确文章执行。**
  - 状态：`Pending`；改动面：`apps/server/src/browser/transfer-attribution.ts`。
  - 依赖：[TRANSFER-DISPATCH](#transfer-dispatch)、[TRANSFER-RESPONSE-FORMS](#transfer-response-forms)。
  - 验收：归属证据包含 opener/frame ancestry、page/document、起点和 permit；无祖先关系、跨 workspace、过期 document 或并发文章歧义保持 unowned/rejected，不能靠 URL 或文件名猜测。
  - 直接验证：`apps/server/test/transfer-popup-frame.test.ts`、`apps/server/test/transfer-service-worker.test.ts`；证据：`migration/evidence/browser-acquisition/transfer-attribution.md`。

### TRANSFER-DEDUPLICATION

- [ ] **TRANSFER-DEDUPLICATION — 对重复事件和同字节候选实现稳定幂等。**
  - 状态：`Pending`；改动面：`apps/server/src/browser/transfer-deduplication.ts`。
  - 依赖：[TRANSFER-ATTRIBUTION](#transfer-attribution)、[CANONICAL-INTEGRITY](01-baseline-and-contracts.md#canonical-integrity)。
  - 验收：同一 response/download 重放只形成一个 transfer；不同事件的同 hash 可以合并证据，异 hash 不合并；去重不丢失来源、时序、validator 或拒绝原因。
  - 直接验证：`apps/server/test/transfer-deduplication.test.ts`；证据：`migration/evidence/browser-acquisition/transfer-deduplication.md`。

### TRANSFER-DRAIN

- [ ] **TRANSFER-DRAIN — 在动作、页面或工作台结束后有界排空仍在进行的传输。**
  - 状态：`Pending`；改动面：`apps/server/src/browser/transfer-drain.ts`。
  - 依赖：[TRANSFER-RANGE-ETAG](#transfer-range-etag)、[TRANSFER-DEDUPLICATION](#transfer-deduplication)。
  - 验收：动作完成、页面关闭、Agent 停止和工作台断线后，已开始 transfer 在独立 deadline 内完成或明确超时；drain 不等待 `networkidle`，新无关请求不能无限延长 deadline，关闭结果列出仍未确认的 transfer。
  - 直接验证：`apps/server/test/transfer-lifecycle-drain.test.ts`；证据：`migration/evidence/browser-acquisition/transfer-lifecycle-drain.md`。

### BROWSER-COLLECTOR

- [ ] **BROWSER-COLLECTOR — 将完整 Transfer 生命周期汇合为 durable-ready Candidate。**
  - 状态：`In progress`；改动面：`apps/server/src/browser/collector.ts`、`apps/server/src/storage/files/`。
  - 依赖：[TRANSFER-DRAIN](#transfer-drain)、[FILE-PUBLICATION](02-runtime-storage-network.md#file-publication)。
  - 验收：只有完整、受限、归属明确并已 fsync 的字节形成 Candidate；截图失败、页面关闭、Agent 停止和工作台断线不丢已接收字节；截断、超限、歧义归属和未排空 transfer 不产生 durable-ready。
  - 直接验证：`apps/server/test/browser-transfer.test.ts`；证据：`migration/evidence/browser-acquisition/browser-transfer.md`。

### POLICY-CONTRACT

- [ ] **POLICY-CONTRACT — 定义封闭 policy schema、收紧规则、版本和冻结快照。**
  - 状态：`Pending`；改动面：`packages/contracts/src/browser-policy.ts`、`apps/server/src/acquisition/policy.ts`。
  - 依赖：[CONFIG-PARSER](02-runtime-storage-network.md#config-parser)、[MIGRATION-CONTRACTS](01-baseline-and-contracts.md#migration-contracts)。
  - 验收：source/version、action/time/model/retry/bytes/observation/drain budget 均有边界；operator 只能收紧；执行开始后配置改变不影响已冻结快照；未知字段和宽松覆盖在调用前拒绝。
  - 直接验证：`apps/server/test/policy-frozen-snapshot.test.ts`；证据：`migration/evidence/browser-acquisition/policy-contract.md`。

### POLICY-ASSISTANCE

- [ ] **POLICY-ASSISTANCE — 定义人工协助请求、超时、恢复和控制权转换。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/assistance-policy.ts`。
  - 依赖：[POLICY-CONTRACT](#policy-contract)、[BROWSER-CONTROL](#browser-control)。
  - 验收：Agent 只能请求封闭 assistance reason；请求带 expiry 与剩余预算，人工 takeover 后模型迟到结果零执行；超时、拒绝、release 和重连均得到确定终态，resume 不重置预算。
  - 直接验证：`apps/server/test/policy-assistance-expiry.test.ts`；证据：`migration/evidence/browser-acquisition/policy-assistance.md`。

### POLICY-PRIVACY

- [ ] **POLICY-PRIVACY — 限制 Observation、模型输入、日志和持久事件中的敏感信息。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/policy-privacy.ts`。
  - 依赖：[POLICY-CONTRACT](#policy-contract)、[LOGGING-REDACTION](02-runtime-storage-network.md#logging-redaction)。
  - 验收：Cookie、Authorization、表单 secret、Profile 路径、签名 URL 和任意页面大文本不进入模型、DTO、日志或 receipt；允许字段受大小和来源约束，拒绝错误不回显输入。
  - 直接验证：`apps/server/test/browser-policy-privacy.test.ts`；证据：`migration/evidence/browser-acquisition/policy-privacy.md`。

### EXECUTION-POLICY

- [ ] **EXECUTION-POLICY — 汇合冻结预算、pause/defer、assistance 与 privacy 语义。**
  - 状态：`In progress`；改动面：`apps/server/src/acquisition/execution-policy.ts`。
  - 依赖：[POLICY-CONTRACT](#policy-contract)、[POLICY-ASSISTANCE](#policy-assistance)、[POLICY-PRIVACY](#policy-privacy)。
  - 验收：每次执行持有不可变 policy snapshot；超限在下一动作或外部调用前失败；pause/defer/assistance 不增加 action、time、model、retry 或 bytes 额度，取消与预算耗尽有不同终态。
  - 直接验证：`apps/server/test/execution-policy.test.ts`；证据：`migration/evidence/browser-acquisition/execution-policy.md`。

### EXECUTION-LOOP

- [ ] **EXECUTION-LOOP — 按 Observation、budget 和 epoch 执行至多一个 typed action。**
  - 状态：`In progress`；改动面：`apps/server/src/acquisition/execution-loop.ts`。
  - 依赖：[EXECUTION-POLICY](#execution-policy)、[BROWSER-ACTION-EXECUTOR](#browser-action-executor)、[BROWSER-COLLECTOR](#browser-collector)、[AGENT-RUNTIME](02-runtime-storage-network.md#agent-runtime)。
  - 验收：一次模型结果最多提交一个动作；人工 takeover、页面变化、取消或新 epoch 后迟到结果零执行；request ID 重放幂等；模型不能获得任意 URL/selector/script 或事实写入端口。
  - 直接验证：拟新增 `apps/server/test/execution-loop.test.ts`；证据：拟新增 `migration/evidence/browser-acquisition/execution-loop.md`，当前不得由 policy 测试代替。

### EXECUTION-DIAGNOSTICS

- [ ] **EXECUTION-DIAGNOSTICS — 生成有界、脱敏且可恢复的 Browser 执行诊断。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/execution-diagnostics.ts`。
  - 依赖：[EXECUTION-LOOP](#execution-loop)、[POLICY-PRIVACY](#policy-privacy)。
  - 验收：诊断可区分 resource blocked、page unresolved、ordinary denial、capture、budget、cancel 与 internal failure；不保存完整页面、模型原文或 secret；诊断失败不改变 Candidate 或 Literature 事实。
  - 直接验证：`apps/server/test/browser-execution-diagnostics.test.ts`；证据：`migration/evidence/browser-acquisition/execution-diagnostics.md`。

### PDF-ACCEPTANCE

- [ ] **PDF-ACCEPTANCE — 在受限执行环境验证实际 PDF 字节的基本结构。**
  - 状态：`In progress`；改动面：`apps/server/src/acquisition/pdf-acceptance.ts`。
  - 依赖：[BROWSER-COLLECTOR](#browser-collector)、[PDF-ENGINE-SPIKE](01-baseline-and-contracts.md#pdf-engine-spike)。
  - 验收：非空字节可由标准 reader 打开、至少一页且可解密；扩展名/MIME 冒充、损坏页树、加密不可读和资源耗尽拒绝；一页或少文本 PDF 不因体积/字符阈值被拒绝，不执行嵌入脚本。
  - 直接验证：`apps/server/test/pdf-acceptance.test.ts`；证据：`migration/evidence/browser-acquisition/pdf-acceptance.md`。

### PDF-TEXT-EVIDENCE

- [ ] **PDF-TEXT-EVIDENCE — 有界提取仅供 identity/version 判断的文本和文档属性证据。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/pdf-evidence.ts`。
  - 依赖：[PDF-ACCEPTANCE](#pdf-acceptance)。
  - 验收：提取页数、时间、内存、文本和 metadata 长度受限；无文本 PDF 产生“无证据”而非损坏；异常字体、对象流和恶意输入 fail closed；该证据不承担通用解析或内容总结。
  - 直接验证：`apps/server/test/pdf-text-evidence.test.ts`；证据：`migration/evidence/browser-acquisition/pdf-text-evidence.md`。

### IDENTITY-VERDICT

- [ ] **IDENTITY-VERDICT — 对目标文章身份给出 accepted/rejected/uncertain 与证据。**
  - 状态：`In progress`；改动面：`apps/server/src/acquisition/identity-verdict.ts`。
  - 依赖：[PDF-TEXT-EVIDENCE](#pdf-text-evidence)、[CANONICAL-INTEGRITY](01-baseline-and-contracts.md#canonical-integrity)。
  - 验收：可靠标识一致可接纳，错误文章和仅补充材料拒绝，证据缺失或冲突保持 uncertain；不得靠文件名、MIME、URL 或模型一句成功断言身份，主题相关性和实际内容判断仍属于 Analysis。
  - 直接验证：`apps/server/test/identity-verdict.test.ts`；证据：`migration/evidence/browser-acquisition/identity-verdict.md`。

### VERSION-VERDICT

- [ ] **VERSION-VERDICT — 独立裁决版本归属并保留三态证据。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/version-verdict.ts`。
  - 依赖：[IDENTITY-VERDICT](#identity-verdict)、[MIGRATION-CONTRACTS](01-baseline-and-contracts.md#migration-contracts)。下游消费方为 Block 04 `LIT-IDENTITY`。
  - 验收：明确版本标识或可核实 lineage 得到 accepted；与目标版本冲突得到 rejected；只有文章身份而无版本证据得到 uncertain；版本判断不得创建 Literature 或改写 current facts。
  - 直接验证：`apps/server/test/version-verdict.test.ts`；证据：`migration/evidence/browser-acquisition/version-verdict.md`。

### CANDIDATE-PUBLICATION

- [ ] **CANDIDATE-PUBLICATION — 发布 durable Candidate、候选 evidence 和可重放 receipt。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/candidate-publication.ts`、`apps/server/src/storage/files/`。
  - 依赖：[VERSION-VERDICT](#version-verdict)、[REPOSITORY-ATOMIC-PUBLICATION](02-runtime-storage-network.md#repository-atomic-publication)。
  - 验收：文件先行、receipt 后置且可对账；同 receipt 重放幂等，异 hash、uncertain、DB/进程故障保留证据；本 Task 不创建正式 primary-pdf、不写 Literature current facts，正式发布由 Block 04 `LITERATURE-ASSET-PUBLICATION` 完成。
  - 直接验证：`apps/server/test/candidate-publication.test.ts`；证据：`migration/evidence/browser-acquisition/candidate-publication.md`。

### SOURCE-ARXIV

- [ ] **SOURCE-ARXIV — 按可靠 arXiv 标识和版本生成公开 PDF locator。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/sources/arxiv/`。
  - 依赖：[CANDIDATE-PUBLICATION](#candidate-publication)、[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)。
  - 验收：可靠版本线索得到候选；缺失/冲突标识零请求，失效 locator 不成为成功；adapter 只返回中性结果，不写 current facts，测试只用合成响应/loopback。
  - 直接验证：`apps/server/test/arxiv-pdf-source.test.ts`；证据：`migration/evidence/browser-acquisition/arxiv-pdf-source.md`。

### SOURCE-EUROPE-PMC

- [ ] **SOURCE-EUROPE-PMC — 按 PMID/PMCID 和开放资产线索解析候选。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/sources/europe-pmc/`。
  - 依赖：[CANDIDATE-PUBLICATION](#candidate-publication)、[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)。
  - 验收：公开全文记录得到候选；只有摘要、无全文或错误目标保持缺失/拒绝，来源证据留存；不访问真实站点。
  - 直接验证：`apps/server/test/europe-pmc-pdf-source.test.ts`；证据：`migration/evidence/browser-acquisition/europe-pmc-pdf-source.md`。

### SOURCE-DIRECT

- [ ] **SOURCE-DIRECT — 消费明确 direct PDF locator 并校验实际目标站点。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/sources/direct/`。
  - 依赖：[CANDIDATE-PUBLICATION](#candidate-publication)、[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)。
  - 验收：有效 locator 走 Network/PDF 边界；恶意 redirect、HTML 冒充和不同文章不进入候选成功；协议转换留在 adapter。
  - 直接验证：`apps/server/test/direct-pdf-source.test.ts`；证据：`migration/evidence/browser-acquisition/direct-pdf-source.md`。

### SOURCE-DOI-LANDING

- [ ] **SOURCE-DOI-LANDING — 从 DOI landing 生成受校验的下一步 locator 与站点证据。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/sources/doi-landing/`。
  - 依赖：[CANDIDATE-PUBLICATION](#candidate-publication)、[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)。
  - 验收：DOI 编码和合成跳转可重放；跨 origin 重做 admission；未知站点不盲目调用授权 API，landing 成功不等于 PDF 成功。
  - 直接验证：`apps/server/test/doi-landing-source.test.ts`；证据：`migration/evidence/browser-acquisition/doi-landing-source.md`。

### SOURCE-UNPAYWALL

- [ ] **SOURCE-UNPAYWALL — 转换开放位置、版本和来源并获取候选。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/sources/unpaywall/`。
  - 依赖：[CANDIDATE-PUBLICATION](#candidate-publication)、[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)。
  - 验收：多个 location 按合同选择并保留 provenance；空 location、坏 URL 和冲突版本不补造结果；测试只用合成响应。
  - 直接验证：`apps/server/test/unpaywall-pdf-source.test.ts`；证据：`migration/evidence/browser-acquisition/unpaywall-pdf-source.md`。

### SOURCE-CONFIGURED-MIRRORS

- [ ] **SOURCE-CONFIGURED-MIRRORS — 保持配置镜像默认关闭、顺序精确和普通安全边界。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/sources/configured-mirrors/`。
  - 依赖：[CANDIDATE-PUBLICATION](#candidate-publication)、[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)。
  - 验收：禁用时零请求；Custom 精确有序且不并发；Reset 删除 override；不增加代理、注册、凭据、脚本或访问控制绕过能力。
  - 直接验证：`apps/server/test/configured-mirror-source.test.ts`；证据：`migration/evidence/browser-acquisition/configured-mirror-source.md`。

### SOURCE-CORE

- [ ] **SOURCE-CORE — 按 CORE 内容能力与明确 grant 完成 lookup/download。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/providers/core/`。
  - 依赖：[CANDIDATE-PUBLICATION](#candidate-publication)、[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[CONFIG-CREDENTIAL](02-runtime-storage-network.md#config-credential)。
  - 验收：仅适用 locator 发请求；缺 key、错 origin、无内容授权和坏响应可区分；认证成功不等于 PDF 已接纳，测试不访问真实 API。
  - 直接验证：`apps/server/test/core-pdf-client.test.ts`；证据：`migration/evidence/browser-acquisition/core-pdf-client.md`。

### SOURCE-ELSEVIER

- [ ] **SOURCE-ELSEVIER — 按可靠标识和实际内容站点调用授权内容 API。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/providers/elsevier/`。
  - 依赖：[CANDIDATE-PUBLICATION](#candidate-publication)、[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[CONFIG-CREDENTIAL](02-runtime-storage-network.md#config-credential)。
  - 验收：聚合 metadata 来源不会自动触发内容 API；401/403/429/空内容不成为成功，key 不随 redirect 泄漏；测试只用 fake/loopback。
  - 直接验证：`apps/server/test/elsevier-pdf-client.test.ts`；证据：`migration/evidence/browser-acquisition/elsevier-pdf-client.md`。

### SOURCE-WILEY

- [ ] **SOURCE-WILEY — 按 Wiley 内容定位与授权范围执行 lookup/download。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/providers/wiley/`。
  - 依赖：[CANDIDATE-PUBLICATION](#candidate-publication)、[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)、[CONFIG-CREDENTIAL](02-runtime-storage-network.md#config-credential)。
  - 验收：合成合法候选可接纳；不适用、授权拒绝和损坏 PDF 返回准确结果，一个来源失败不撤销其它来源成功。
  - 直接验证：`apps/server/test/wiley-pdf-client.test.ts`；证据：`migration/evidence/browser-acquisition/wiley-pdf-client.md`。

### SOURCE-BROWSER

- [ ] **SOURCE-BROWSER — 将合法文章起点交给唯一 Browser 执行器并消费 Candidate。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/sources/browser/`。
  - 依赖：[EXECUTION-LOOP](#execution-loop)、[CANDIDATE-PUBLICATION](#candidate-publication)、[NETWORK-BUDGET](02-runtime-storage-network.md#network-budget)。
  - 验收：普通页与 challenge 使用同一合同；缺模型/Profile/合法起点时零动作；模型成功描述不能代替 durable Candidate、identity 和 version verdict。
  - 直接验证：`apps/server/test/browser-pdf-source.test.ts`；证据：`migration/evidence/browser-acquisition/browser-pdf-source.md`。

### ACQUISITION-ROUTE

- [ ] **ACQUISITION-ROUTE — 编排公开、授权与 Browser route 的混合批次。**
  - 状态：`Pending`；改动面：`apps/server/src/acquisition/route.ts`。
  - 依赖：[SOURCE-ARXIV](#source-arxiv)、[SOURCE-EUROPE-PMC](#source-europe-pmc)、[SOURCE-DIRECT](#source-direct)、[SOURCE-DOI-LANDING](#source-doi-landing)、[SOURCE-UNPAYWALL](#source-unpaywall)、[SOURCE-CONFIGURED-MIRRORS](#source-configured-mirrors)、[SOURCE-CORE](#source-core)、[SOURCE-ELSEVIER](#source-elsevier)、[SOURCE-WILEY](#source-wiley)、[SOURCE-BROWSER](#source-browser)。
  - 验收：按实际 locator、站点和配置顺序短路；成功保留，普通缺失继续下一适用路线；认证、网络、存储失败与取消不伪装耗尽；仅全部自动路线正常耗尽才报告需要人工 PDF。
  - 直接验证：`apps/server/test/acquisition-route.test.ts`；证据：`migration/evidence/browser-acquisition/acquisition-route.md`。

### AUTOMATED-ACQUISITION-JOURNEY

- [ ] **AUTOMATED-ACQUISITION-JOURNEY — 在 loopback 完成 Browser 动作、捕获、裁决和 durable Candidate 旅程。**
  - 状态：`Pending`；改动面：`apps/server/test/fixtures/browser/`、`apps/server/test/automated-acquisition-journey.test.ts`。
  - 依赖：[ACQUISITION-ROUTE](#acquisition-route)、[EXECUTION-DIAGNOSTICS](#execution-diagnostics)。
  - 验收：慢 viewer、popup/iframe、POST、Range/ETag、延迟 download、重复事件、Service Worker、人工 takeover 和有界 drain 均通过真实本地 Chromium；fixture 记录零外部请求，失败仍保留 durable Candidate 和准确诊断。
  - 直接验证：`apps/server/test/automated-acquisition-journey.test.ts`；证据：`migration/evidence/browser-acquisition/automated-acquisition-journey.md`。

### BROWSER-ACQUISITION-ACCEPTANCE

- [ ] **BROWSER-ACQUISITION-ACCEPTANCE — 完成工作台与候选获取的块级 R3。**
  - 状态：`Pending`；改动面：本块实现、直接测试和 `migration/evidence/browser-acquisition/`。
  - 依赖：本块全部前置 Task，最后执行。
  - 验收：人工工作台、逐事件 admission、封闭动作、transfer 全形态、策略、Agent loop、PDF/identity/version、所有来源和自动旅程都有当前证据；Browser/Web 真实入口存在；无第二 owner、无 Literature current-facts 写入、无真实站点访问。
  - 直接验证：本块全部行为测试、`pnpm quick`、`pnpm test`、适用语义审查；证据：`migration/evidence/browser-acquisition/acceptance.md`。

## 执行方式与集成点

严格串行：Host/egress/recovery → Observation/Action/Screen/Workbench → Transfer → Policy/Execution →
PDF/identity/version/Candidate → Sources/route → journey/acceptance。每个 Task 完成直接测试、diff/合同审查和证据
后才进入依赖项。工作台端点在 Block 05 汇入常驻服务；Candidate 在 Block 04 汇入 Literature owner。

## 审查门

R1 检查 Block 01/02 退出证据；R2 检查每个动作、输入、网络事件、传输、预算和错误；R3 检查真实 Web 入口、
Browser loopback 旅程、Candidate/Literature 所有权及证据。绕过 Network、迟到动作、丢 transfer、无界等待、
Candidate 写 current facts 或用 server 测试冒充 Web 前端均为 blocking finding。

## 接口 / 数据 / 依赖影响

新增 Browser Host、Observation、Action、Frame/Screen、Workbench、Transfer、Policy、Candidate、IdentityVerdict、
VersionVerdict 和 receipt 合同。Candidate 只含候选字节引用与裁决证据；正式 Asset/LiteratureAsset/current facts
仍由 Block 04 Literature owner 写入。Browser vendor 对象、Cookie、临时路径和模型历史不越过边界。

## 验证与证据

直接测试使用本块逐 Task 指定的行为命名路径；Browser 测试只访问 loopback fixture，并记录 binary、模式、平台、
事件形态和跳过原因。证据写入 `migration/evidence/browser-acquisition/`；旧测试总数或不存在的测试路径不能作证。

## 退出条件

43 项 Task 全部闭环，`BROWSER-ACQUISITION-ACCEPTANCE` 通过，且真实工作台入口、控制权、逐事件 Network、
Transfer drain、PDF/identity/version 三态和 durable Candidate 均有当前证据；真实站点状态保持 `not-run`。

## 完成证据

当前为空。执行后记录 Chromium/CloakBrowser 版本、运行模式、fixture、逐测试命令、外部请求计数、Candidate 生命周期、
不支持输入、未支持平台和 R3 finding；旧局部实现及旧 Full 结果不能替代本块退出证据。

## 失败与恢复

Host/egress 故障回到对应 Browser Task；画面或输入问题回到 Screen/Workbench/Control；捕获丢失回到 Transfer/Collector；
迟到动作或隐私问题回到 Policy/Execution；身份误判回到 PDF/Identity/Version；不在下游增加旁路。

## 下游交接

向 Block 04 交付 durable Candidate、identity/version evidence 和 receipt；向 Block 05 交付工作台 endpoint、事件与画面流
合同。不得交接 Page/CDP/Cookie、模型历史、临时路径，亦不得把 Candidate 描述为正式 Literature 资产。
