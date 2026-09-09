# Block 05｜持久服务、调度与恢复

## 块身份

- 状态：`Pending`
- Tasks：21 项，以本文件 `Tasks` 为唯一任务定义
- 前置块：Block 03 `BROWSER-ACQUISITION-ACCEPTANCE`、Block 04 全部业务 Task 与 R3
- 下游块：Block 06
- 恢复点：前置块通过后从 `EXECUTION-SCHEMA` 开始；schema、repository、调度、API 和旅程依次闭合

## 块结果

在合成 v1 副本上显式升级 v2 运行事实，持久保存 job/attempt/event/Candidate ACK，提供可恢复队列、workspace
调度、人工协助和认证服务；HTTP、事件流、画面流、CLI 与 daemon 共享同一 Application，崩溃重启后不重复
执行不安全动作，也不让运行事实决定 Literature 业务事实。

## 进入条件

Block 03 已交付工作台 endpoint、事件/画面流、Candidate receipt 与执行诊断；Block 04 已交付完整业务 Application
和 Literature 正式资产发布边界。Block 01 的迁移合同明确 v1/v2 隔离及升级授权；只操作合成数据库或明确副本，
不读取或迁移真实用户 Catalog/Profile。

## 责任与改动面

execution repositories 只拥有运行事实；scheduler 拥有租约、队列和 workspace 串行；Application 拥有业务调用；
Literature 拥有 Candidate 接纳后的正式事实；service entry 拥有认证、HTTP/WS、daemon 生命周期；CLI 只调用服务或
同一 Application，不建立第二调度器。Primary 负责 `apps/server/src/execution/`、`service/`、迁移工具及本块证据。

## 需要保持的行为

v1 数据、canonical bytes/hash、文献身份、不可变资产和 provenance 保持不变；schema 变更显式、可备份、可回滚；
旧 worker/epoch 和重复消息不能写入；Candidate ACK 不等于 Literature 接纳；事件/画面慢消费者有界；认证信息、
Cookie、模型输入和用户资产不进入运行表、DTO 或日志。

## Tasks

本节是本块 Task 定义与状态的唯一位置。[任务索引](task-ledger.md)只提供导航。路径均相对仓库根目录；
拟新增路径不表示已经实现。测试使用行为命名，不使用计划顺序或 Task ID。

### EXECUTION-SCHEMA

- [ ] **EXECUTION-SCHEMA — 定义并检查版本化 v2 execution schema 与不变量。**
  - 状态：`Pending`；改动面：`apps/server/src/storage/execution/schema.ts`、`migration/`。
  - 依赖：[MIGRATION-CONTRACTS](01-baseline-and-contracts.md#migration-contracts)、[REPOSITORY-ATOMIC-PUBLICATION](02-runtime-storage-network.md#repository-atomic-publication)。
  - 验收：schema 显式包含 job/attempt/event/candidate-ack、版本与约束；inspect 能区分 v1、可升级 v2、已升级 v2 和未知版本；新表不复制 Literature current facts 或旧运行报告。
  - 直接验证：`apps/server/test/execution-schema-inspection.test.ts`；证据：`migration/evidence/persistent-service/execution-schema.md`。

### SCHEMA-BACKUP

- [ ] **SCHEMA-BACKUP — 在升级前生成一致、带 hash 且 no-clobber 的数据库备份。**
  - 状态：`Pending`；改动面：`apps/server/src/storage/execution/backup.ts`。
  - 依赖：[EXECUTION-SCHEMA](#execution-schema)、[FILE-PUBLICATION](02-runtime-storage-network.md#file-publication)。
  - 验收：WAL 活动下备份仍是可打开的一致快照；目标存在异字节拒绝覆盖；备份 manifest 记录源 schema/hash 而不含机器绝对路径；失败不修改源库。
  - 直接验证：`apps/server/test/database-backup.test.ts`；证据：`migration/evidence/persistent-service/database-backup.md`。

### SCHEMA-MIGRATION

- [ ] **SCHEMA-MIGRATION — 在合成副本上从 v1 显式迁移到 v2。**
  - 状态：`Pending`；改动面：`apps/server/src/storage/execution/migrate.ts`、`migration/`。
  - 依赖：[SCHEMA-BACKUP](#schema-backup)。
  - 验收：迁移前检查版本与备份，事务失败保持可重试；重复调用识别已升级状态；所有 v1 表、记录、FTS、关系、asset 引用和 canonical hash 在迁移后逐项相同。
  - 直接验证：`apps/server/test/database-migration.test.ts`；证据：`migration/evidence/persistent-service/database-migration.md`。

### SCHEMA-ROLLBACK

- [ ] **SCHEMA-ROLLBACK — 从受验证备份恢复 v1 副本并拒绝错误目标。**
  - 状态：`Pending`；改动面：`apps/server/src/storage/execution/rollback.ts`、`migration/`。
  - 依赖：[SCHEMA-MIGRATION](#schema-migration)。
  - 验收：回滚只作用于精确副本，校验 manifest/source/hash 后替换；错误库、坏备份、目标并发使用和版本不匹配 fail closed；回滚后 v1 schema/query/hash 与迁移前一致。
  - 直接验证：`apps/server/test/database-rollback.test.ts`；证据：`migration/evidence/persistent-service/database-rollback.md`。

### JOB-REPOSITORY

- [ ] **JOB-REPOSITORY — 持久化 job 输入快照、状态、租约和终态 CAS。**
  - 状态：`Pending`；改动面：`apps/server/src/storage/execution/job-repository.ts`。
  - 依赖：[SCHEMA-MIGRATION](#schema-migration)、[REPOSITORY-DISCOVERY](02-runtime-storage-network.md#repository-discovery)。
  - 验收：job 保存严格输入引用、policy/version 和 workspace；状态转换封闭且以 revision/lease CAS；重复 create 幂等，旧租约和非法回退零写入；不保存 secret 或大 payload。
  - 直接验证：`apps/server/test/job-repository.test.ts`；证据：`migration/evidence/persistent-service/job-repository.md`。

### ATTEMPT-REPOSITORY

- [ ] **ATTEMPT-REPOSITORY — 记录 attempt、worker epoch、预算消耗与可解释终态。**
  - 状态：`Pending`；改动面：`apps/server/src/storage/execution/attempt-repository.ts`。
  - 依赖：[JOB-REPOSITORY](#job-repository)、[EXECUTION-POLICY](03-browser-and-acquisition.md#execution-policy)。
  - 验收：每次领取生成唯一 attempt 与 fencing epoch；预算消耗只增不减，pause/resume 不重置；旧 attempt、迟到 heartbeat 和终态后写入被拒绝，取消/耗尽/失败可区分。
  - 直接验证：`apps/server/test/attempt-repository.test.ts`；证据：`migration/evidence/persistent-service/attempt-repository.md`。

### EVENT-REPOSITORY

- [ ] **EVENT-REPOSITORY — 追加有序、脱敏、可游标恢复的运行事件。**
  - 状态：`Pending`；改动面：`apps/server/src/storage/execution/event-repository.ts`。
  - 依赖：[ATTEMPT-REPOSITORY](#attempt-repository)、[EXECUTION-DIAGNOSTICS](03-browser-and-acquisition.md#execution-diagnostics)。
  - 验收：同 job/attempt 事件序列单调且 append-only；event ID 重放幂等，冲突 payload 拒绝；cursor 可恢复不重漏，payload 有界且不含 secret、页面全文或 vendor 对象。
  - 直接验证：`apps/server/test/event-repository.test.ts`；证据：`migration/evidence/persistent-service/event-repository.md`。

### CANDIDATE-ACK

- [ ] **CANDIDATE-ACK — 持久记录 Candidate 交付、接纳或拒绝 ACK。**
  - 状态：`Pending`；改动面：`apps/server/src/storage/execution/candidate-ack.ts`。
  - 依赖：[EVENT-REPOSITORY](#event-repository)、[CANDIDATE-PUBLICATION](03-browser-and-acquisition.md#candidate-publication)、[LITERATURE-ASSET-PUBLICATION](04-business-and-service.md#literature-asset-publication)。
  - 验收：ACK 绑定 Candidate receipt/hash、Literature publication receipt 与 attempt epoch；重复 ACK 幂等、冲突 ACK 拒绝；ACK 只记录交接事实，不自行创建/删除 Asset 或 current facts。
  - 直接验证：`apps/server/test/candidate-acknowledgement.test.ts`；证据：`migration/evidence/persistent-service/candidate-acknowledgement.md`。

### RECOVERABLE-QUEUE

- [ ] **RECOVERABLE-QUEUE — 用租约和 fencing 构建可重启的有界 job 队列。**
  - 状态：`Pending`；改动面：`apps/server/src/execution/queue.ts`。
  - 依赖：[JOB-REPOSITORY](#job-repository)、[ATTEMPT-REPOSITORY](#attempt-repository)。
  - 验收：领取、续租、完成和放弃均为 CAS；进程退出后过期租约可回收；同 job 不会被两个有效 worker 同时执行；队列容量与轮询有界，取消 job 不再启动新外部调用。
  - 直接验证：`apps/server/test/recoverable-queue.test.ts`；证据：`migration/evidence/persistent-service/recoverable-queue.md`。

### WORKSPACE-SCHEDULING

- [ ] **WORKSPACE-SCHEDULING — 实现 workspace 内串行与跨 workspace 有界调度。**
  - 状态：`Pending`；改动面：`apps/server/src/execution/scheduler.ts`。
  - 依赖：[RECOVERABLE-QUEUE](#recoverable-queue)、[NETWORK-PERMIT](02-runtime-storage-network.md#network-permit)。
  - 验收：同 workspace/Browser risk group 保持合同规定的串行；跨 workspace 并发不绕过共享 Network/Browser permit；公平性、取消和关闭有界，不从 job 配置放宽全局安全限制。
  - 直接验证：`apps/server/test/workspace-scheduling.test.ts`；证据：`migration/evidence/persistent-service/workspace-scheduling.md`。

### ASSISTANCE-REQUEST

- [ ] **ASSISTANCE-REQUEST — 持久化并恢复人工协助请求与过期结果。**
  - 状态：`Pending`；改动面：`apps/server/src/execution/assistance.ts`。
  - 依赖：[WORKSPACE-SCHEDULING](#workspace-scheduling)、[POLICY-ASSISTANCE](03-browser-and-acquisition.md#policy-assistance)。
  - 验收：请求绑定 job/attempt/workspace/control epoch、reason 与 expiry；重启后未过期请求可恢复，过期请求自动收敛；人工决定只能作用于当前 attempt，内容不含 secret 或页面全文。
  - 直接验证：`apps/server/test/assistance-request-recovery.test.ts`；证据：`migration/evidence/persistent-service/assistance-request.md`。

### EXECUTION-RECOVERY

- [ ] **EXECUTION-RECOVERY — 在崩溃重启后对账 running attempt、事件、Candidate 与 ACK。**
  - 状态：`Pending`；改动面：`apps/server/src/execution/recovery.ts`。
  - 依赖：[CANDIDATE-ACK](#candidate-ack)、[RECOVERABLE-QUEUE](#recoverable-queue)、[ASSISTANCE-REQUEST](#assistance-request)。
  - 验收：启动扫描以已提交事实、receipt、lease 和 ACK 收敛状态；不会重放点击、POST、模型调用或 Literature 发布；旧 worker/epoch 写入拒绝，已 durable Candidate 独立于 Browser/工作台在线状态。
  - 直接验证：`apps/server/test/execution-restart-recovery.test.ts`；证据：`migration/evidence/persistent-service/execution-recovery.md`。

### SERVICE-AUTHENTICATION

- [ ] **SERVICE-AUTHENTICATION — 为本地服务建立认证主体、会话和 workspace 授权。**
  - 状态：`Pending`；改动面：`apps/server/src/service/authentication.ts`。
  - 依赖：[THREAT-MODEL](01-baseline-and-contracts.md#threat-model)、[CONFIG-CREDENTIAL](02-runtime-storage-network.md#config-credential)。
  - 验收：未认证、过期、伪造、错 workspace 和重放会话在 Application/Browser 调用前拒绝；token 只在 owner-only 存储与传输边界出现，不进 URL、日志、事件或 DTO；loopback 绑定和跨 origin 规则明确。
  - 直接验证：`apps/server/test/service-authentication.test.ts`；证据：`migration/evidence/persistent-service/service-authentication.md`。

### SERVICE-HTTP-API

- [ ] **SERVICE-HTTP-API — 暴露 status、jobs、workspaces、assistance 与业务操作 HTTP API。**
  - 状态：`Pending`；改动面：`apps/server/src/service/http-api.ts`。
  - 依赖：[SERVICE-AUTHENTICATION](#service-authentication)、[ENTRY-APPLICATION](04-business-and-service.md#entry-application)、[EXECUTION-RECOVERY](#execution-recovery)。
  - 验收：strict 请求/响应、稳定错误和幂等 key 覆盖创建、查询、取消、assistance；status 纯本地；跨 workspace、未知字段、超限 body 和终态后 mutation 在业务调用前失败。
  - 直接验证：`apps/server/test/service-http-api.test.ts`；证据：`migration/evidence/persistent-service/service-http-api.md`。

### SERVICE-EVENT-STREAM

- [ ] **SERVICE-EVENT-STREAM — 提供按游标恢复且有背压的事件 WebSocket。**
  - 状态：`Pending`；改动面：`apps/server/src/service/event-stream.ts`。
  - 依赖：[SERVICE-AUTHENTICATION](#service-authentication)、[EVENT-REPOSITORY](#event-repository)。
  - 验收：重连从最后确认 cursor 恢复且不重漏；跨 workspace 和过旧/伪造 cursor 拒绝；慢消费者在有界队列后关闭并给出恢复 cursor，不阻塞执行或无界占用内存。
  - 直接验证：`apps/server/test/service-event-stream.test.ts`；证据：`migration/evidence/persistent-service/service-event-stream.md`。

### SERVICE-SCREEN-STREAM

- [ ] **SERVICE-SCREEN-STREAM — 将 Browser 画面流接入认证服务并保持丢旧帧背压。**
  - 状态：`Pending`；改动面：`apps/server/src/service/screen-stream.ts`。
  - 依赖：[SERVICE-AUTHENTICATION](#service-authentication)、[SCREEN-STREAM](03-browser-and-acquisition.md#screen-stream)、[WORKBENCH-ENDPOINT](03-browser-and-acquisition.md#workbench-endpoint)。
  - 验收：认证观看者只订阅授权 workspace/page；断线重连得到当前 key frame；慢消费者丢旧帧或关闭，不影响 control、transfer 和 event stream；画面不写入 execution 表。
  - 直接验证：`apps/server/test/service-screen-stream.test.ts`；证据：`migration/evidence/persistent-service/service-screen-stream.md`。

### CLI-DAEMON-COORDINATION

- [ ] **CLI-DAEMON-COORDINATION — 协调 CLI 与 daemon 的启动、发现、关闭和失败语义。**
  - 状态：`Pending`；改动面：`apps/server/src/entry/cli/daemon.ts`、`apps/server/src/service/daemon.ts`。
  - 依赖：[SERVICE-HTTP-API](#service-http-api)、[APP-LIFECYCLE](02-runtime-storage-network.md#app-lifecycle)。
  - 验收：CLI 只连接精确本地实例或显式启动一份；重复启动不产生第二 DB/Browser owner；stale pid/socket、启动失败、信号关闭和版本不兼容返回稳定错误，原有 CLI JSON/stdout 不被 daemon 日志污染。
  - 直接验证：`apps/server/test/cli-daemon-coordination.test.ts`；证据：`migration/evidence/persistent-service/cli-daemon-coordination.md`。

### SERVICE-API

- [ ] **SERVICE-API — 汇合认证、HTTP、事件与画面流到唯一服务端口。**
  - 状态：`Pending`；改动面：`apps/server/src/service/index.ts`、`apps/server/src/bootstrap/`。
  - 依赖：[SERVICE-HTTP-API](#service-http-api)、[SERVICE-EVENT-STREAM](#service-event-stream)、[SERVICE-SCREEN-STREAM](#service-screen-stream)、[CLI-DAEMON-COORDINATION](#cli-daemon-coordination)。
  - 验收：同一 Application/DB Worker/Browser Host 被所有入口共享；服务启动失败逆序清理，幂等关闭释放请求、WS、队列和 Browser；没有未认证旁路、第二监听入口或 vendor/secret DTO。
  - 直接验证：`apps/server/test/service-composition.test.ts`；证据：`migration/evidence/persistent-service/service-api.md`。

### PERSISTENT-SERVICE-JOURNEY

- [ ] **PERSISTENT-SERVICE-JOURNEY — 从真实 loopback 服务完成提交、观看、协助、重连和恢复。**
  - 状态：`Pending`；改动面：`apps/server/test/persistent-service-journey.test.ts`、本地 fixtures。
  - 依赖：[SERVICE-API](#service-api)、[EXECUTION-RECOVERY](#execution-recovery)。
  - 验收：两个客户端提交 job、观看同页、接管、协助、断线重连；服务在 transfer、Candidate 和 Literature 发布关键点崩溃后恢复，不重复不安全动作；全部网络限于 loopback。
  - 直接验证：`apps/server/test/persistent-service-journey.test.ts`；证据：`migration/evidence/persistent-service/persistent-service-journey.md`。

### SCHEMA-COPY-RECOVERY

- [ ] **SCHEMA-COPY-RECOVERY — 在 v1/v2 合成副本演练升级、服务运行、失败与恢复。**
  - 状态：`Pending`；改动面：`apps/server/test/schema-copy-recovery.test.ts`、`migration/`。
  - 依赖：[SCHEMA-ROLLBACK](#schema-rollback)、[PERSISTENT-SERVICE-JOURNEY](#persistent-service-journey)。
  - 验收：从冻结 v1 fixture 副本升级、运行 job、异常退出、恢复并回滚；每个故障点的 schema、query、hash、asset 和 Literature facts 与预期一致；源 fixture 与真实用户数据零修改。
  - 直接验证：`apps/server/test/schema-copy-recovery.test.ts`；证据：`migration/evidence/persistent-service/schema-copy-recovery.md`。

### PERSISTENT-SERVICE-ACCEPTANCE

- [ ] **PERSISTENT-SERVICE-ACCEPTANCE — 完成持久服务、调度和恢复的块级 R3/R4。**
  - 状态：`Pending`；改动面：本块实现、测试与 `migration/evidence/persistent-service/`。
  - 依赖：本块全部前置 Task，最后执行。
  - 验收：21 项 Task、schema/backup/migrate/rollback、repositories、queue、assistance、crash recovery、认证、HTTP/WS、CLI/daemon 和两项旅程证据全部闭环；v1/v2 与运行/文献事实隔离通过审查。
  - 直接验证：本块全部行为测试、`pnpm quick`、`pnpm test`、对象图/数据/安全审查；证据：`migration/evidence/persistent-service/acceptance.md`。

## 执行方式与集成点

严格串行：schema inspect → backup/migrate/rollback → repositories → queue/scheduling/assistance/recovery →
authentication/HTTP/WS/daemon → service composition → persistent journey → copy recovery → acceptance。任何 schema、
owner、认证或恢复事实改变，先回到对应 Task 和权威合同，不在 API 层增加兼容旁路。

## 审查门

R1 检查 Block 03/04 交接；R2 检查 schema、CAS、租约、fencing、幂等、认证和背压；R3 检查服务旅程与副本恢复；
R4 检查单一对象图、v1/v2 隔离和运行/文献事实所有权。真实库写入、隐式升级、重复不安全动作、未认证入口、
无界队列或 Candidate ACK 写 Literature 事实均为 blocking finding。

## 接口 / 数据 / 依赖影响

新增显式 v2 execution 表、typed repositories、scheduler、service HTTP/WS 和 daemon 入口；不改变 v1 Literature
表义或资产格式。新增依赖须由 Block 01 运行时选择和锁文件支持；schema 只在合成库/副本上产生。

## 验证与证据

证据写入 `migration/evidence/persistent-service/`。直接测试使用本块逐项行为名称；数据库测试复制冻结 fixture 到
系统临时目录，服务只监听 loopback，Browser 只访问 loopback，故障注入记录精确边界和恢复结果。

## 退出条件

21 项 Task 全部完成，`PERSISTENT-SERVICE-ACCEPTANCE` 通过，v1/v2 副本升级与回滚、崩溃恢复、认证、背压、
CLI/daemon 协调和唯一对象图均有当前证据，且未访问真实数据或外部服务。

## 完成证据

当前为空。执行后填写 schema 指纹、备份/迁移/回滚 hash、故障点、重启状态、API/WS 行为、资源上限、命令、
跳过项和 R3/R4 finding；旧服务测试或单个 repository 通过不能替代块级退出。

## 失败与恢复

schema/备份问题回到对应 `SCHEMA-*`；状态/幂等问题回到 repository/queue；重复动作回到 `EXECUTION-RECOVERY`；
权限问题回到 `SERVICE-AUTHENTICATION`；背压问题回到对应 stream；对象图问题回到 `SERVICE-API`/`APP-COMPOSITION`。
保留失败副本，不修改源 fixture 或真实资料。

## 下游交接

向 Block 06 交付受验证的 v2 schema/迁移/回滚工具、持久队列、恢复语义、认证服务、HTTP/WS 入口、CLI/daemon
协调和已知限制；不交付真实数据迁移、生产部署、外部站点成功率或切换授权。
