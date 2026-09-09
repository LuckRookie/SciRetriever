# Block 02｜运行时、配置、网络、持久基础与组装

## 块身份

- 状态：`In progress`；保留已验证基础切片，受重开 Task、新增 repository 和 Block 01 R3 约束
- Tasks：`CONFIG-PARSER`、`CONFIG-CREDENTIAL`、`NETWORK-URL`、`NETWORK-RESOLUTION`
  `NETWORK-CONNECTION`、`NETWORK-REDIRECT`、`NETWORK-ADMISSION`、`NETWORK-PERMIT`
  `NETWORK-CANCEL`、`NETWORK-BODY-LIMIT`、`NETWORK-RETRY-AFTER`、`NETWORK-BUDGET`
  `NETWORK-BROWSER-PORT`
  `FILE-STAGE-WRITE`、`FILE-STAGE-READ`、`FILE-STAGE-HANDOFF`、`FILE-STAGING`
  `FILE-PUBLICATION`、`FILE-LOCKING`、`CONFIG-PUBLICATION`
  `SQLITE-WORKER`、`SQLITE-SNAPSHOT-CONCURRENCY`、`REPOSITORY-OBSERVATION`、`REPOSITORY-ASSET`
  `REPOSITORY-REFERENCE`、`REPOSITORY-LITERATURE`、`REPOSITORY-DISCOVERY`
  `REPOSITORY-PARSER-CONTENT`、`REPOSITORY-ANALYSIS`、`REPOSITORY-QUERY`
  `REPOSITORY-ATOMIC-PUBLICATION`
  `AGENT-RUNTIME`、`AGENT-RESPONSES`、`AGENT-CHAT`、`AGENT-ANTHROPIC`
  `LOGGING-REDACTION`、`APP-COMPOSITION`、`APP-LIFECYCLE`、`RUNTIME-FOUNDATION-ACCEPTANCE`
- 前置块：Block 01 `BASELINE-ACCEPTANCE`
- 下游块：Block 03、Block 04
- 恢复点：等待 Block 01 `BASELINE-ACCEPTANCE`；之后从 `CONFIG-PARSER`/`CONFIG-CREDENTIAL` 补证开始，
  再关闭 `NETWORK-BUDGET`、FileStore、SQLite/repository 和 Application 集成。不得直接从 Browser 继续

## 块结果

形成一份可安装的 TS 基础对象图：配置和凭据隔离，所有 HTTP 经过 Network，文件不可变，SQLite 由 Worker
持有，Agents 使用中性合同，Application 只组装一份共享资源。

## 进入条件

Block 01 的 `BASELINE-ACCEPTANCE` 已通过，清单、v1 fixture、strict contracts、平台限制和 owner 有 R3 证据；Python 生产入口仍可用；
本块不读取用户 home、Catalog、Profile 或凭据。

## 责任与改动面

Primary 负责 `apps/server/src/configuration/`、`network/`、`storage/`、`agents/`、`bootstrap/` 和本块证据。
配置拥有普通配置和 grant；Network 拥有外部访问；FileStore 拥有文件字节；DB Worker 拥有 SQLite 连接；
repositories 只发布已确认命令；Agents adapter 拥有 vendor 协议；Application 只负责组装和生命周期。

## 需要保持的行为

保持固定 home、exact-origin credential、SSRF/DNS/IP/redirect/预算边界、no-follow/no-clobber/fsync、v1 schema/
FTS/hash/关系和 provider-neutral Agents 语义；本块不引入 v2 execution 表、双写或第二业务 owner。

## Tasks

本节是本块 Task 定义与状态的唯一位置，按列出顺序串行执行。[任务索引](task-ledger.md)仅用于定位。
反引号中的文件路径均相对仓库根目录；未实现任务的路径是拟新增落点，不表示文件或测试已经存在。
每项完成还须满足本块公共退出条件；测试名只描述行为，禁止按计划顺序命名。

### CONFIG-PARSER

- [ ] **CONFIG-PARSER — 保持 TOML/默认值兼容并安全读取普通配置。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：保持 Python TOML 与默认值语义，校验 Source/Provider/Model/任务引用；从固定 home 有界读取绑定目录及文件身份的普通配置。
  - 改动面：`apps/server/src/configuration/index.ts`、`apps/server/tsconfig.json`、根 `tsconfig.json`、根 `package.json`。
  - 依赖：[MODEL-RECORDS](01-baseline-and-contracts.md#model-records)、[MIGRATION-DECISIONS](01-baseline-and-contracts.md#migration-decisions)。
  - 验收：空/部分配置与 Python 一致；quoted/dotted/multiline 等受支持 TOML 输入做差分；重复/未知字段、引用/URL/预算冲突在 I/O 前拒绝；错误 owner、symlink、目录替换和读取期间增长均 fail closed。
  - 直接验证：`apps/server/test/configuration-boundary.test.ts`。
  - 证据：[已有记录](../../../migration/evidence/runtime/configuration-boundary.md)；原完成声明重开，逐项补充本任务验收后更新该记录。

### CONFIG-CREDENTIAL

- [ ] **CONFIG-CREDENTIAL — 按 owner、用途和 origin 隔离凭据消费。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：隔离文献 Provider、Model Provider 和 MinerU 命名空间；secret 保持原始值；由配置 owner 给受信任调用方提供绑定用途、origin 和期限的 grant。
  - 改动面：`apps/server/src/configuration/credentials.ts`。
  - 依赖：[CONFIG-PARSER](#config-parser)、[CANONICAL-INTEGRITY](01-baseline-and-contracts.md#canonical-integrity)。
  - 验收：三个类别的合成凭据均可被对应 adapter 消费；同名 Provider 不串值、Unicode secret 不改变；伪造/过期/错 origin/错用途授权不返回 secret；完整过渡组可切换，预览不可修改私有状态且无敏感值。
  - 直接验证：`apps/server/test/credential-origin.test.ts`。
  - 证据：[已有记录](../../../migration/evidence/runtime/credential-origin.md)；原完成声明重开，逐项补充本任务验收后更新该记录。

### NETWORK-URL

- [x] **NETWORK-URL — 在建立 DNS 或 socket 之前拒绝不具备安全 URL 语义的请求。**
  - 状态：`Completed`；owner：Primary。
  - 动作：实现 scheme、userinfo、fragment、query/path、percent encoding、dot segment、encoded separator 和控制字符的解析结果；输入不得把 credential alias 当 URL 语义的一部分。
  - 改动面：`apps/server/src/network/policy.ts`。
  - 依赖：[CONFIG-CREDENTIAL](#config-credential)。
  - 验收：每个拒绝样例在 fake resolver 和 socket factory 调用次数均为零；规范 HTTPS URL 得到稳定 canonical destination；错误不包含原始 secret 或完整请求串。
  - 直接验证：`apps/server/test/network-url-policy.test.ts`。
  - 证据：`migration/evidence/runtime/network-url-policy.md`

### NETWORK-RESOLUTION

- [x] **NETWORK-RESOLUTION — 对 DNS 全部答案执行地址分类并固定批准地址集合。**
  - 状态：`Completed`；owner：Primary。
  - 动作：覆盖 IPv4/IPv6 canonical 解析、legacy/保留/未指定/loopback/link-local/multicast/private 分类和 mixed-answer fail-closed；产生不可伪造的 verified destination。
  - 改动面：`apps/server/src/network/policy.ts`、`apps/server/src/network/connection.ts`。
  - 依赖：[NETWORK-URL](#network-url)、[RUNTIME-SPIKE](01-baseline-and-contracts.md#runtime-spike)。
  - 验收：public 与 private 混合答案整体拒绝；每类保留地址有正反例；连接层拒绝非 `resolveDestination` 生成的对象；resolver 失败不降级为原始 hostname 连接。
  - 直接验证：`apps/server/test/network-resolution-policy.test.ts`。
  - 证据：`migration/evidence/runtime/network-resolution-policy.md`

### NETWORK-CONNECTION

- [x] **NETWORK-CONNECTION — 让 HTTP/TLS socket 固定到批准 IP，同时保留 hostname 校验。**
  - 状态：`Completed`；owner：Primary。
  - 动作：HTTP 使用批准 IP 建立连接；HTTPS 使用批准 IP 建立 TCP/TLS、SNI 和证书 hostname 使用原始 hostname；连接失败在应用层写入前结束。
  - 改动面：`apps/server/src/network/connection.ts`、`apps/server/src/network/http.ts`。
  - 依赖：[NETWORK-RESOLUTION](#network-resolution)。
  - 验收：loopback HTTP 请求只能到记录的批准地址；证书 hostname 不匹配时应用 server 收不到 request；非批准 destination、malformed options 和不支持 framing 均产生稳定脱敏错误。
  - 直接验证：`apps/server/test/network-connection.test.ts`、`apps/server/test/network-http-framing.test.ts`。
  - 证据：`migration/evidence/runtime/network-connection.md`

### NETWORK-REDIRECT

- [x] **NETWORK-REDIRECT — 每跳重新 admission，并按 origin 决定是否转发凭据。**
  - 状态：`Completed`；owner：Primary。
  - 动作：解析 Location、执行每跳地址 admission、限制跳数；同 origin 才保留允许的 credential header，跨 origin 清除 Network-owned headers 和 private grant。
  - 改动面：`apps/server/src/network/http.ts`、`apps/server/src/network/policy.ts`。
  - 依赖：[NETWORK-CONNECTION](#network-connection)、[CONFIG-CREDENTIAL](#config-credential)。
  - 验收：loopback redirect chain 中，跨 origin 的第二跳收到零 secret；第二跳 public→private 在连接前拒绝；无 Location、坏 Location、循环和超限均不发送下一跳请求。
  - 直接验证：`apps/server/test/network-redirect-credentials.test.ts`。
  - 证据：`migration/evidence/runtime/network-redirect-credentials.md`

### NETWORK-ADMISSION

- [x] **NETWORK-ADMISSION — 将已通过的 URL、解析、连接和 redirect 规则汇合到唯一请求入口。**
  - 状态：`Completed`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：只把下列四个基础切片的结果接入 `requestOnce`/`requestFollowingRedirects`；任何调用方不能绕过该入口自行创建 socket 或发送 redirect 请求。
  - 改动面：`apps/server/src/network/`。
  - 依赖：[NETWORK-URL](#network-url)、[NETWORK-RESOLUTION](#network-resolution)、[NETWORK-CONNECTION](#network-connection)、[NETWORK-REDIRECT](#network-redirect)。
  - 验收：每一个入口都只能消费已验证的 destination；loopback HTTP/TLS 端到端测试同时证明 socket pinning、hostname 校验、逐跳重解析和跨 origin 凭据清理；任一基础切片失败时不产生应用请求。
  - 直接验证：`apps/server/test/network-admission.test.ts`；该文件只验证汇合后的请求行为，基础切片使用各自测试文件。
  - 证据：[network-admission](../../../migration/evidence/runtime/network-admission.md)。

### NETWORK-PERMIT

- [x] **NETWORK-PERMIT — 以 scope 与 host 两级共享状态实施最严格并发限制。**
  - 状态：`Completed`；owner：Primary。
  - 动作：实现 scope permit、跨 scope host permit、排队、公平唤醒和幂等 release；不同调用者对同一 host 共享上限。
  - 改动面：`apps/server/src/network/budget.ts`。
  - 依赖：[NETWORK-ADMISSION](#network-admission)。
  - 验收：并发计数从未超过 scope/host 任一上限；不同限制取更严格值；重复 release 和排队取消都不改变活跃计数。
  - 直接验证：`apps/server/test/network-permit.test.ts`。
  - 证据：`migration/evidence/runtime/network-permit.md`

### NETWORK-CANCEL

- [x] **NETWORK-CANCEL — 让 AbortSignal 贯穿排队、连接和响应读取。**
  - 状态：`Completed`；owner：Primary。
  - 动作：统一 timeout 与 AbortSignal 错误，取消排队项、已取得 permit 的 socket 和 response reader，并保证 close/release 只执行一次。
  - 改动面：`apps/server/src/network/budget.ts`、`apps/server/src/network/connection.ts`、`apps/server/src/network/http.ts`。
  - 依赖：[NETWORK-PERMIT](#network-permit)。
  - 验收：在三处分别取消时 server 观察到连接/读取停止，后继请求可取得同一 permit；超时错误不包含 secret；正常完成、错误和取消均只释放一次。
  - 直接验证：`apps/server/test/network-cancellation.test.ts`。
  - 证据：`migration/evidence/runtime/network-cancellation.md`

### NETWORK-BODY-LIMIT

- [x] **NETWORK-BODY-LIMIT — 只按响应 body 字节实施有界读取和失败释放。**
  - 状态：`Completed`；owner：Primary。
  - 动作：在 parser 解出的 body chunk 上累计预算，区分 headers 与 body；超限停止读取并释放 permit，连接失败不伪造完整响应。
  - 改动面：`apps/server/src/network/http.ts`、`apps/server/src/network/budget.ts`。
  - 依赖：[NETWORK-CONNECTION](#network-connection)、[NETWORK-PERMIT](#network-permit)。
  - 验收：Content-Length、chunked、截断和异常 framing 各有结果；headers 不计入 body budget；超限、截断、解析错误后下一请求仍可运行。
  - 直接验证：`apps/server/test/network-body-limits.test.ts`。
  - 证据：`migration/evidence/runtime/network-body-limits.md`

### NETWORK-RETRY-AFTER

- [x] **NETWORK-RETRY-AFTER — 解析并绑定有界 Retry-After，且只由显式编排消费。**
  - 状态：`Completed`；owner：Primary。
  - 动作：把合法 delta/date 转成上限内冷却，拒绝负数、超大和不合法值；`consumeRetry`/`consumeRedirect` 与真实请求循环绑定。
  - 改动面：`apps/server/src/network/budget.ts`、`apps/server/src/network/http.ts`。
  - 依赖：[NETWORK-CANCEL](#network-cancel)。
  - 验收：fake clock 能观察有界等待；预算为零时不发下一次请求；Provider adapter 不产生隐式重试；冷却期间取消不会遗留 timer 或 permit。
  - 直接验证：`apps/server/test/network-retry-after.test.ts`。
  - 证据：`migration/evidence/runtime/network-retry-after.md`

### NETWORK-BUDGET

- [ ] **NETWORK-BUDGET — 将 permit、取消、体量和 Retry-After 切片汇合到请求编排。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：只在下列四个基础切片均通过后接入 `requestOnce` 和显式 retry/redirect 编排；SDK adapter 不得自行重试或维护第二份 permit。
  - 改动面：`apps/server/src/network/`。
  - 依赖：[NETWORK-ADMISSION](#network-admission)、[NETWORK-PERMIT](#network-permit)、[NETWORK-CANCEL](#network-cancel)、[NETWORK-BODY-LIMIT](#network-body-limit)、[NETWORK-RETRY-AFTER](#network-retry-after)。
  - 验收：真实 loopback 请求证明 permit 获取/释放、下载取消、body 上限、Retry-After 和显式 retry/redirect 计数由同一请求状态驱动；任何断路均不泄漏 permit。
  - 直接验证：`apps/server/test/network-budget.test.ts`；基础切片使用各自测试文件。
  - 证据：[network-budget](../../../migration/evidence/runtime/network-budget.md)；已有测试结果；R2 未通过，未闭合项见证据。

### NETWORK-BROWSER-PORT

- [ ] **NETWORK-BROWSER-PORT — 向 Browser Host 提供逐事件、不可绕过的 Network admission 端口。**
  - 状态：`Pending`；owner：Primary，Network 拥有目标准入，Browser Host 只消费 verified decision。
  - 动作：定义 navigation、popup、response、download、iframe、redirect、Service Worker 和 WebSocket 的准入请求、
    verified destination、凭据清理、预算和拒绝结果；普通导航保留原生 `continue()`，不以全量 fetch/fulfill 重写页面。
  - 改动面：`apps/server/src/network/`、`packages/contracts/src/`。
  - 依赖：[NETWORK-ADMISSION](#network-admission)、[NETWORK-BUDGET](#network-budget)、
    [RUNTIME-SELECTION](01-baseline-and-contracts.md#runtime-selection)。
  - 验收：任何 Browser 事件只有在 Network 返回 verified decision 后才能继续；private/mixed DNS、跨 origin secret、
    非标准端口和旁路通道在 Browser 请求产生前拒绝；接口不暴露 socket、Cookie 或 vendor Page。
  - 直接验证：`apps/server/test/browser-network-port.test.ts`，使用 fake resolver 和 loopback，不启动真实外部请求。
  - 证据：拟写入 `migration/evidence/runtime/browser-network-port.md`；尚未生成。

### FILE-STAGE-WRITE

- [ ] **FILE-STAGE-WRITE — 在 owner-only、O_EXCL、no-follow 的临时对象中执行有界写入。**
  - 状态：`In progress`；owner：Primary。
  - 动作：创建唯一 `.staging` 对象，限制单次与累计字节，写入期间记录 descriptor identity 和 SHA-256；并发写入按同一对象串行化。
  - 改动面：`apps/server/src/storage/files/staging.ts`。
  - 依赖：[RUNTIME-SPIKE](01-baseline-and-contracts.md#runtime-spike)。
  - 验收：symlink、hardlink、超限、写入中断和并发写入均不产生可交接半成品；成功结果逐字节 hash 与期望值一致。
  - 直接验证：拟新增 `apps/server/test/file-staging-write.test.ts`；现有 lifecycle/store 测试只能作为部分输入。
  - 证据：拟写入 `migration/evidence/runtime/file-staging-write.md`；尚未形成独立闭环。

### FILE-STAGE-READ

- [ ] **FILE-STAGE-READ — 通过绑定目录和文件身份提供有界、不可越界的读取。**
  - 状态：`In progress`；owner：Primary。
  - 动作：用已绑定的目录/文件 descriptor 打开 reader，读取时复核 inode/link/size/mtime，并在内容增长或替换时 fail closed。
  - 改动面：`apps/server/src/storage/files/staging.ts`。
  - 依赖：[FILE-STAGE-WRITE](#file-stage-write)、[CANONICAL-INTEGRITY](01-baseline-and-contracts.md#canonical-integrity)。
  - 验收：目录替换、目录项替换、文件替换、读时增长和根目录外引用都被拒绝；reader 失败后 stage 清理不误删替换后的对象。
  - 直接验证：拟新增 `apps/server/test/file-staging-reader.test.ts`；现有 lifecycle/store 测试只能作为部分输入。
  - 证据：拟写入 `migration/evidence/runtime/file-staging-reader.md`；尚未形成独立闭环。

### FILE-STAGE-HANDOFF

- [ ] **FILE-STAGE-HANDOFF — 以明确状态转换封存 stage 并生成可发布引用。**
  - 状态：`In progress`；owner：Primary。
  - 动作：`open → writable → durable-ready → handed-off/discarded` 状态只能前进；flush 完成后返回相对 POSIX reference、size 和 hash。
  - 改动面：`apps/server/src/storage/files/staging.ts`。
  - 依赖：[FILE-STAGE-READ](#file-stage-read)。
  - 验收：handoff 后 write 被拒绝且 bytes/hash 不变；discard 可重复且不触碰已替换对象；异常状态没有有效发布引用。
  - 直接验证：`apps/server/test/file-staging-lifecycle.test.ts`。
  - 证据：`migration/evidence/runtime/file-staging-lifecycle.md`

### FILE-STAGING

- [ ] **FILE-STAGING — 将受控写入、绑定读取和封存交接汇合为不可变文件切片。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：只组合下列三个切片；handoff 后对象只能被读取或发布，不能再写入。
  - 改动面：`apps/server/src/storage/files/`。
  - 依赖：[FILE-STAGE-WRITE](#file-stage-write)、[FILE-STAGE-READ](#file-stage-read)、[FILE-STAGE-HANDOFF](#file-stage-handoff)。
  - 验收：正常流的 bytes/hash/reference 与切片一致；symlink、目录项替换、hardlink、读时增长、超限、中断和 handoff 后写入均在发布前失败并只清理自有 stage。
  - 直接验证：`apps/server/test/immutable-file-store.test.ts`；基础行为使用各自测试文件。
  - 证据：[immutable-file-store](../../../migration/evidence/runtime/immutable-file-store.md)；已有测试结果；R2 未通过，未闭合项见证据。

### FILE-PUBLICATION

- [ ] **FILE-PUBLICATION — 实现 fsync 后 create-if-absent/no-clobber 发布和冲突证据。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：在文件与目录 fsync 后按 create-if-absent 发布；相同字节幂等，不同字节保留冲突证据。
  - 改动面：`apps/server/src/storage/files/`。
  - 依赖：[FILE-STAGING](#file-staging)。
  - 验收：并发发布同路径只产生一个结果；异字节不会覆盖；在写入/fsync/发布处注入失败后无半成品对外可读，已有文件 hash 不变。
  - 直接验证：`apps/server/test/immutable-publication.test.ts`。
  - 证据：`migration/evidence/runtime/immutable-publication.md`

### FILE-LOCKING

- [ ] **FILE-LOCKING — 实现跨进程锁、目录/文件 fsync、故障关闭和持锁进程退出处理。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：提供跨进程锁与确定性释放；锁定范围、持锁状态、目录 fsync 和进程退出处理由 FileStore 管理。
  - 改动面：`apps/server/src/storage/`。
  - 依赖：[FILE-PUBLICATION](#file-publication)。
  - 验收：两个独立进程不能同时持有同一写锁；持锁者正常/异常退出后的恢复可复现；无法确认 owner 退出时拒绝接管，不能删锁猜成功。
  - 直接验证：`apps/server/test/file-locking.test.ts`。
  - 证据：`migration/evidence/runtime/file-locking.md`。

### CONFIG-PUBLICATION

- [ ] **CONFIG-PUBLICATION — 安全保存普通配置和凭据编辑。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：配置 owner 使用同目录 staging、安全权限和 expected fingerprint 保存编辑结果；区分可编辑配置的原子替换与不可变文献资产的 no-clobber。
  - 改动面：`apps/server/src/configuration/`。
  - 依赖：[CONFIG-PARSER](#config-parser)、[CONFIG-CREDENTIAL](#config-credential)、[FILE-LOCKING](#file-locking)。
  - 验收：首次创建、单字段编辑、移除 secret 和过渡组切换均能重读；并发编辑、symlink、目录替换和写入/fsync 失败保留旧文件；预览与日志无 secret，不把配置写入 Catalog。
  - 直接验证：`apps/server/test/configuration-publication.test.ts`。
  - 证据：`migration/evidence/runtime/configuration-publication.md`（已有直接测试，尚未完成并发/失败注入闭环）

### SQLITE-WORKER

- [ ] **SQLITE-WORKER — 让独立 DB Worker 持有连接，只接受 typed v1 read/write command。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：选择并记录 TS SQLite binding，由单独 Worker 持连接，通过 closed typed command 执行 v1 事务、查询和关闭。
  - 改动面：`apps/server/src/storage/sqlite/`。
  - 依赖：[FILE-STAGING](#file-staging)、[FIXTURE-V1](01-baseline-and-contracts.md#fixture-v1)、
    [RUNTIME-SELECTION](01-baseline-and-contracts.md#runtime-selection)。
  - 验收：在合成 v1 库比较 schema、FTS、排序、cursor 和 relations；任意 SQL/未知 command 拒绝；事务失败无部分提交、Worker 异常可见，v1 不被隐式升级。
  - 直接验证：`apps/server/test/sqlite-compatibility.test.ts`。
  - 证据：`migration/evidence/runtime/sqlite-compatibility.md`。

### SQLITE-SNAPSHOT-CONCURRENCY

- [ ] **SQLITE-SNAPSHOT-CONCURRENCY — 证明单 writer、长查询响应性和跨表读取快照一致。**
  - 状态：`Pending`；owner：Primary，DB Worker 拥有连接和事务。
  - 动作：用合成 v1 库验证并发 command 排队、长查询取消、读取快照、WAL/FK/FULL 设置和 Worker 异常传播；
    事件循环不执行同步长事务。
  - 改动面：`apps/server/src/storage/sqlite/`。
  - 依赖：[SQLITE-WORKER](#sqlite-worker)。
  - 验收：任意时刻只有一个 writer；长查询不阻断取消和状态请求；Literature/observation/reference/asset/FTS 在同一
    snapshot 中一致；Worker 崩溃不产生部分提交或静默重连第二 writer。
  - 直接验证：`apps/server/test/sqlite-snapshot-concurrency.test.ts`。
  - 证据：拟写入 `migration/evidence/runtime/sqlite-snapshot-concurrency.md`；尚未生成。

### REPOSITORY-OBSERVATION

- [ ] **REPOSITORY-OBSERVATION — 发布和读取 metadata observation、identity/current facts，保留 provenance 和 CAS。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：持久化业务 owner 确认的 observation、identity/current facts 命令，保留来源与 CAS 前置条件。
  - 改动面：`apps/server/src/storage/sqlite/`。
  - 依赖：[SQLITE-WORKER](#sqlite-worker)、[CANONICAL-INTEGRITY](01-baseline-and-contracts.md#canonical-integrity)。
  - 验收：重复观察幂等，快照可读；stale CAS/冲突事务不改 current facts，不丢已提交 observation；repository 不自行决定身份合并。
  - 直接验证：`apps/server/test/observation-repository.test.ts`。
  - 证据：`migration/evidence/runtime/observation-repository.md`。

### REPOSITORY-ASSET

- [ ] **REPOSITORY-ASSET — 发布和读取 asset、parser/content artifact 及 literature-asset relation。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：持久化已发布 asset、parser/content artifact 及文献关系；只保存规范相对引用、hash、provenance/lineage。
  - 改动面：`apps/server/src/storage/sqlite/`。
  - 依赖：[SQLITE-WORKER](#sqlite-worker)、[FILE-PUBLICATION](#file-publication)。
  - 验收：读取结果与文件 hash 一致；坏引用、缺少上游 lineage 或失败事务不得产生有效关系；不写 BLOB/绝对路径，不撤销之前已发布事实。
  - 直接验证：`apps/server/test/asset-repository.test.ts`（4 tests，含 FileStore 实际字节/hash readback）。
  - 证据：`migration/evidence/runtime/asset-repository.md`。

### REPOSITORY-REFERENCE

- [ ] **REPOSITORY-REFERENCE — 发布和读取 reference/provider relation，提供一致快照和只读边界。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：发布 reference、provider observation 和 support 关系，提供一致快照与只读查询。
  - 改动面：`apps/server/src/storage/sqlite/`。
  - 依赖：[REPOSITORY-OBSERVATION](#repository-observation)。
  - 验收：多来源支持可重放；自引用、缺少本地身份和重复/冲突关系按合同处理；查询不隐式创建目标文献，失败事务无半条边。
  - 直接验证：`apps/server/test/reference-repository.test.ts`。
  - 证据：`migration/evidence/runtime/reference-repository.md`。

### REPOSITORY-LITERATURE

- [ ] **REPOSITORY-LITERATURE — 提供 Literature/MetaLiterature 身份、版本成员和 current-facts 的 typed commands。**
  - 状态：`Pending`；owner：Primary，Literature 决定业务事实，repository 只执行已确认命令。
  - 动作：实现创建、读取、身份收敛、版本成员、current metadata/content/asset 和 stale CAS command，不接受任意 SQL。
  - 改动面：`apps/server/src/storage/sqlite/repositories.ts`、必要的分文件 repository。
  - 依赖：[SQLITE-SNAPSHOT-CONCURRENCY](#sqlite-snapshot-concurrency)、[REPOSITORY-OBSERVATION](#repository-observation)。
  - 验收：来源 observation 保留；一个具体 Literature 只属于一个身份集合；stale command 不改 current facts；
    repository 不根据字段相似度自行合并。
  - 直接验证：`apps/server/test/literature-repository.test.ts`。
  - 证据：拟写入 `migration/evidence/runtime/literature-repository.md`；尚未生成。

### REPOSITORY-DISCOVERY

- [ ] **REPOSITORY-DISCOVERY — 提供 Discovery run、scope、candidate 和逐来源进度的 v1 兼容持久边界。**
  - 状态：`Pending`；owner：Primary，Discovery/Application 决定运行结果。
  - 动作：实现具名 command 和一致读取，保留部分成功、取消、来源进度和已经提交的 observation。
  - 改动面：`apps/server/src/storage/sqlite/`。
  - 依赖：[SQLITE-SNAPSHOT-CONCURRENCY](#sqlite-snapshot-concurrency)、[REPOSITORY-OBSERVATION](#repository-observation)。
  - 验收：部分 Provider 失败不撤销已提交 observation；取消不伪造完成；重复 run/event 幂等且不覆盖其它 scope。
  - 直接验证：`apps/server/test/discovery-repository.test.ts`。
  - 证据：拟写入 `migration/evidence/runtime/discovery-repository.md`；尚未生成。

### REPOSITORY-PARSER-CONTENT

- [ ] **REPOSITORY-PARSER-CONTENT — 提供 ParserResult、ContentArtifact、current 关系和 lineage 的 typed commands。**
  - 状态：`Pending`；owner：Primary，Parsing/Literature 决定结果接纳。
  - 动作：发布 parser/content artifact、输入 hash、上游 asset、current replacement 和 NoUsableContent 结果；文件字节仍由 FileStore 持有。
  - 改动面：`apps/server/src/storage/sqlite/`。
  - 依赖：[REPOSITORY-ASSET](#repository-asset)、[REPOSITORY-LITERATURE](#repository-literature)。
  - 验收：失败不撤销旧 current；lineage 缺失或输入 hash 不符拒绝；替换不删除仍被 current/backup 引用的字节。
  - 直接验证：`apps/server/test/parser-content-repository.test.ts`。
  - 证据：拟写入 `migration/evidence/runtime/parser-content-repository.md`；尚未生成。

### REPOSITORY-ANALYSIS

- [ ] **REPOSITORY-ANALYSIS — 提供 metadata/content/reference analysis 结果、receipt 和 current 投影的 typed commands。**
  - 状态：`Pending`；owner：Primary，Analysis 决定接纳，repository 不解析模型文本。
  - 动作：发布输入 schema/hash、模型 provenance、输出 artifact、reference evidence 和 current replacement。
  - 改动面：`apps/server/src/storage/sqlite/`。
  - 依赖：[REPOSITORY-PARSER-CONTENT](#repository-parser-content)、[REPOSITORY-REFERENCE](#repository-reference)。
  - 验收：同输入幂等；坏 schema、缺 lineage、stale current 拒绝；后续失败保留旧 metadata/content/reference 事实。
  - 直接验证：`apps/server/test/analysis-repository.test.ts`。
  - 证据：拟写入 `migration/evidence/runtime/analysis-repository.md`；尚未生成。

### REPOSITORY-QUERY

- [ ] **REPOSITORY-QUERY — 提供 v1 兼容的 search/detail/reference/cited-by、排序、cursor 和 FTS 读取。**
  - 状态：`Pending`；owner：Primary，Library/Application 形成公开 DTO。
  - 动作：实现稳定 selector、排序、分页、FTS、详情和关系 snapshot；只读路径不创建记录、不发网络请求。
  - 改动面：`apps/server/src/storage/sqlite/`。
  - 依赖：[REPOSITORY-LITERATURE](#repository-literature)、[REPOSITORY-REFERENCE](#repository-reference)、
    [SQLITE-SNAPSHOT-CONCURRENCY](#sqlite-snapshot-concurrency)。
  - 验收：冻结 v1 fixture 的对象集合、排序、cursor、hash 和关系一致；坏 cursor/selector 在零写入时失败；长查询可取消。
  - 直接验证：`apps/server/test/library-query-repository.test.ts`。
  - 证据：拟写入 `migration/evidence/runtime/library-query-repository.md`；尚未生成。

### REPOSITORY-ATOMIC-PUBLICATION

- [ ] **REPOSITORY-ATOMIC-PUBLICATION — 汇合文件先行、短 DB 事务、stale CAS、FTS 和失败对账。**
  - 状态：`Pending`；owner：Primary，业务 owner 先确认命令，FileStore/DB Worker 分别提交自己的事实。
  - 动作：定义 asset、observation、literature、parser/content、analysis 和 reference 的发布顺序、receipt 与崩溃恢复；
    不声称跨文件系统和 SQLite 存在单一原子事务。
  - 改动面：`apps/server/src/storage/`、`apps/server/src/bootstrap/`。
  - 依赖：[REPOSITORY-LITERATURE](#repository-literature)、[REPOSITORY-DISCOVERY](#repository-discovery)、
    [REPOSITORY-PARSER-CONTENT](#repository-parser-content)、[REPOSITORY-ANALYSIS](#repository-analysis)、
    [REPOSITORY-QUERY](#repository-query)、[FILE-PUBLICATION](#file-publication)。
  - 验收：每个提交点异常退出后有效关系不指向缺失文件；孤儿可对账；重复 receipt 不重复发布；不同字节不覆盖。
  - 直接验证：`apps/server/test/repository-publication-recovery.test.ts`。
  - 证据：拟写入 `migration/evidence/runtime/repository-publication-recovery.md`；尚未生成。

### AGENT-RUNTIME

- [ ] **AGENT-RUNTIME — 建立 provider-neutral call、model capability、tool/image/reasoning/stream/usage 和 cancel 合同。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：按调用 role 选择 Model，派生 capability/limits，传递 provider-neutral image/tool/reasoning/usage/cancel，保持单次无状态调用。
  - 改动面：`apps/server/src/agents/`。
  - 依赖：[MODEL-RECORDS](01-baseline-and-contracts.md#model-records)、[CONFIG-CREDENTIAL](#config-credential)。
  - 验收：缺少图片/tool/结构输出能力时 adapter 调用计数为零；default reasoning 省略，显式值不降级；取消清理资源，跨调用不保留 controller 历史。
  - 直接验证：`apps/server/test/agent-runtime.test.ts`。
  - 证据：`migration/evidence/runtime/agents-runtime.md`。

### AGENT-RESPONSES

- [ ] **AGENT-RESPONSES — 实现 OpenAI Responses JSON/SSE adapter，共用 NetworkClient。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：经共享 Network 实现 Responses JSON 与有界 SSE 重建，转换 text、tool、usage 和协议失败。
  - 改动面：`apps/server/src/agents/`。
  - 依赖：[AGENT-RUNTIME](#agent-runtime)、[NETWORK-BUDGET](#network-budget)。
  - 验收：合成 JSON/SSE 得到等价中性结果；分片 UTF-8、截断、超限、错误事件及取消失败可诊断；stream 失败不改 JSON 模式补发，跨 origin 不带 key。
  - 直接验证：`apps/server/test/responses-adapter.test.ts`。
  - 证据：`migration/evidence/runtime/responses-adapter.md`。

### AGENT-CHAT

- [ ] **AGENT-CHAT — 实现 OpenAI Chat adapter，共用 NetworkClient 和 usage/error mapping。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：经共享 Network 实现 Chat Completions JSON/SSE、tool 参数拼接、usage 和 reasoning 字段。
  - 改动面：`apps/server/src/agents/`。
  - 依赖：[AGENT-RUNTIME](#agent-runtime)、[NETWORK-BUDGET](#network-budget)。
  - 验收：合法 JSON 与分片 SSE 输出一致；坏 JSON、缺少终态、无效 tool arguments 和超限拒绝；Model stream/reasoning 原样执行，失败不隐式重试或换模式。
  - 直接验证：`apps/server/test/chat-adapter.test.ts`。
  - 证据：`migration/evidence/runtime/chat-adapter.md`。

### AGENT-ANTHROPIC

- [ ] **AGENT-ANTHROPIC — 实现 Anthropic JSON/SSE adapter，保持 stream mode 显式。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：经共享 Network 实现 Messages JSON/SSE 与 block/tool/usage 转换，保持 stream 显式配置。
  - 改动面：`apps/server/src/agents/`。
  - 依赖：[AGENT-RUNTIME](#agent-runtime)、[NETWORK-BUDGET](#network-budget)。
  - 验收：合成 message 与 block delta 正确合并；乱序/未知 block、截断和错误事件稳定失败，取消释放连接；不把 vendor 对象暴露给 controller。
  - 直接验证：`apps/server/test/anthropic-adapter.test.ts`。
  - 证据：`migration/evidence/runtime/anthropic-adapter.md`。

### LOGGING-REDACTION

- [x] **LOGGING-REDACTION — 提供独立于报告的脱敏日志入口。**
  - 状态：`Completed`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：提供共享 logger 和结构化安全字段，按配置输出进度/诊断；业务报告由操作结果形成。
  - 改动面：`apps/server/src/logging/`。
  - 依赖：[MODEL-ERRORS](01-baseline-and-contracts.md#model-errors)。
  - 验收：合成 secret、URL query、headers 和 vendor message 不进入日志；错误类别仍可诊断；关闭日志不改变业务报告，JSON/stdout 原始输出不混入日志。
  - 直接验证：`apps/server/test/logging-redaction.test.ts`。
  - 证据：`migration/evidence/runtime/logging-redaction.md`。

### APP-COMPOSITION

- [ ] **APP-COMPOSITION — 组装唯一 FileStore、DB Worker、Network、Agents、日志和 repositories。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：在唯一 bootstrap 组装 Configuration、FileStore、DB Worker、Network coordinator、Agents、Logging 和 repositories，并暴露可安装公共入口。
  - 改动面：`apps/server/src/bootstrap/`。
  - 依赖：[CONFIG-PUBLICATION](#config-publication)、[FILE-LOCKING](#file-locking)、
    [NETWORK-BROWSER-PORT](#network-browser-port)、[REPOSITORY-ATOMIC-PUBLICATION](#repository-atomic-publication)、
    [AGENT-RESPONSES](#agent-responses)、[AGENT-CHAT](#agent-chat)、[AGENT-ANTHROPIC](#agent-anthropic)、
    [LOGGING-REDACTION](#logging-redaction)。
  - 验收：从临时 home 通过实际生产构造器加载；消费者共享同一资源实例，所有外部 adapter 走同一 Network；包导出能导入，不以 fake 整个 bootstrap 代替组装验收。
  - 直接验证：`apps/server/test/application-assembly.test.ts`。
  - 证据：拟写入 `migration/evidence/runtime/application-assembly.md`（尚未生成）。

### APP-LIFECYCLE

- [ ] **APP-LIFECYCLE — 实现启动失败清理、幂等 close、错误传播和临时 home 离线加载。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：实现阶段启动、失败逆序清理、幂等 close 和错误传播；关闭时停止新任务并收回资源。
  - 改动面：`apps/server/src/bootstrap/`。
  - 依赖：[APP-COMPOSITION](#app-composition)。
  - 验收：每个启动点注入失败均关闭此前资源；重复 close 安全，取消/Worker 故障不悬挂；实际临时 home 加载/关闭不触碰真实文件或联网。
  - 直接验证：`apps/server/test/application-lifecycle.test.ts`。
  - 证据：`migration/evidence/runtime/application-lifecycle.md`

### RUNTIME-FOUNDATION-ACCEPTANCE

- [ ] **RUNTIME-FOUNDATION-ACCEPTANCE — 关闭 Configuration、Network、FileStore、v1 repositories、Agents 和对象图的 R3。**
  - 状态：`Pending`；owner：Primary，作为 Block 03/04 的运行时进入门。
  - 动作：运行本块直接测试、TS/Python Full、安装 smoke 和语义审查；核对唯一 Network/FileStore/DB Worker、
    Browser admission port、完整 repository 集合、配置发布和启动失败清理。
  - 改动面：本块完成证据、`migration/evidence/runtime/runtime-foundation-acceptance.md`。
  - 依赖：[APP-LIFECYCLE](#app-lifecycle)、[REPOSITORY-ATOMIC-PUBLICATION](#repository-atomic-publication)、
    [SQLITE-SNAPSHOT-CONCURRENCY](#sqlite-snapshot-concurrency)。
  - 验收：所有本块 Task 的实现、行为测试、文档和证据闭环；不存在第二出口、第二 writer、任意 SQL、缺失文件引用、
    未重放配置或未记录的 R2 finding；未闭合项不得交给 Browser/业务块。
  - 直接验证：`pnpm full`、Python Full、实际临时 home/package smoke 和 R3 语义审查；执行时记录真实结果。
  - 证据：拟写入 `migration/evidence/runtime/runtime-foundation-acceptance.md`；未完成。

## 执行方式与集成点

每项先检查前置合同和受保护工作，再实现一个能力切片，运行直接测试，审查 diff/错误路径/owner，写证据后更新
既有实现和直接测试只作为重开后的输入。`APP-COMPOSITION` 是唯一组装汇合点，`RUNTIME-FOUNDATION-ACCEPTANCE`
是本块最终门；不启用并行实施，也不在 Block 01 R3 前继续实现。

## 审查门

R1 检查 Block 01 证据和外部授权；R2 检查 secret 是否越界、Network 是否为唯一出口、Storage/Worker 所有权、
typed command 和事务边界；R3 检查唯一对象图、安装 smoke 和下游接口。第二 owner、隐式重试、任意 SQL 或安全
降级属于 blocking finding。

## 接口 / 数据 / 依赖影响

新增 TS Configuration/Credential、Network、FileStore、DB Worker、repository、Agents 和 Application 端口；v1
schema、查询及业务确认命令的读写语义保持兼容；写入只在合成库验证，v2 不在本块出现。Python 入口、用户数据
和真实外部依赖不变。

## 验证与证据

证据目录为 `migration/evidence/runtime/`。直接测试使用 `configuration-boundary.test.ts`、
`credential-origin.test.ts`、`network-admission.test.ts`、`network-budget.test.ts`、`immutable-file-store.test.ts`、
`immutable-publication.test.ts`、`file-locking.test.ts`、`sqlite-compatibility.test.ts`、repository 行为测试和
`responses-adapter.test.ts`、`chat-adapter.test.ts`、`anthropic-adapter.test.ts`。测试只使用 fake DNS、loopback
HTTP、合成数据库和临时目录。

## 退出条件

全部 Task 的直接测试、必要文档和证据通过；完整 v1 repository、Browser Network port、TypeScript Quick/Test/Full、
Python Full、v1 fixture 兼容、安装 smoke、唯一对象图和 R3 语义审查通过；
`RUNTIME-FOUNDATION-ACCEPTANCE` 完成。

## 完成证据

[configuration-boundary](../../../migration/evidence/runtime/configuration-boundary.md) 与
[credential-origin](../../../migration/evidence/runtime/credential-origin.md) 保留前次配置/凭据验收记录。
[network-admission](../../../migration/evidence/runtime/network-admission.md)、
[network-budget](../../../migration/evidence/runtime/network-budget.md) 和
[immutable-file-store](../../../migration/evidence/runtime/immutable-file-store.md) 记录现有草稿、已运行测试及
R2 未闭合项。三项的先前 Completed 声明已撤回；机械通过不能覆盖缺失的端到端拒绝、取消或引用完整性验证。
这些记录证明部分基础切片已经实现，不足以关闭新增的 Browser admission port、完整 v1 repository、并发快照、
配置/FileStore 补证、运行时选择和 Application 组装。Block 02 当前未达到 R3；执行恢复点返回 Block 01
`BASELINE-ACCEPTANCE`，通过后再处理本块重开项。

## 失败与恢复

配置或安全差异回到 `CONFIG-*`/`NETWORK-*`；文件或数据差异回到 `FILE-*`/`SQLITE-WORKER`/`REPOSITORY-*`；协议
差异回到 `AGENT-*`；组装差异回到 `APP-COMPOSITION`。保留失败材料，不在下游增加兼容旁路。

## 下游交接

交接稳定 contracts、Configuration/Credential、Network、FileStore、v1 DB Worker/repositories、Agents 和唯一
Application graph；不交接 vendor 对象、secret、绝对路径或未验证平台承诺。
