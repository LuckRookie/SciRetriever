# Block 06｜最终验证、发布准备与交接

## 块身份

- 状态：`Pending`
- Tasks：24 项，以本文件 `Tasks` 为唯一任务定义
- 前置块：Block 01–05 的全部退出审查
- 下游块：明确授权后的独立切换/发布动作，或计划归档
- 恢复点：前置块通过后从 `TS-QUALITY-GATES` 开始；每个最终门失败都回到产生缺陷的 owner Task

## 块结果

把实现和证据汇总为可复核的交付判断：TS/Python 门禁、CI、实际包、支持平台安装、干净环境旅程、数据与
Profile 恢复、性能/背压/安全、文档、Python 退役条件和切换演练均有明确结果。最后只生成 readiness 报告和
具体授权包；没有明确授权时不执行生产切换、发布、Git 写入、真实数据迁移或 Python 退役。

## 进入条件

前五块所有 Task、R3/R4、直接测试、对象图和必要真相源均闭环；不存在未处置的 blocking/material finding。
依赖与锁文件已固定，构建入口可复现，支持平台由 `PLATFORM-RELEASE-MATRIX` 定义。未满足时只能整理既有证据，
不能通过缩小范围、跳过测试或用旧测试总数关闭本块。

## 责任与改动面

Primary 负责质量命令、CI、package/release 配置、隔离安装、故障演练、`docs/guides/`、最终报告和 R5 review。
各项失败必须路由回真实 owner；本块不实现缺失业务、不修改架构合同、不访问真实用户材料。

## 需要保持的行为

Python 生产入口在明确切换授权前继续可用；v1/v2、运行事实/文献事实和 Browser/Network/Storage owner 保持分离；
安装测试消费真实构建产物；失败与跳过可见；包、报告和日志不包含凭据、Cookie、用户数据、临时数据库、Profile、
缓存 browser 或构建目录。

## Tasks

本节是本块 Task 定义与状态的唯一位置。[任务索引](task-ledger.md)只提供导航。所有测试按行为命名；
不得使用里程碑、阶段、步骤、块号或 Task ID 命名文件和 suite。

### TS-QUALITY-GATES

- [ ] **TS-QUALITY-GATES — 在当前工作树运行并记录 TypeScript Quick、Test 与 Full。**
  - 状态：`Pending`；改动面：根 `package.json`、workspace 配置、质量证据。
  - 依赖：Block 01–05 全部退出。
  - 验收：`pnpm quick`、`pnpm test`、`pnpm full` 独立成功，strict typecheck 覆盖活动源码与测试，零测试或跳过门禁不能被当成功；记录版本、文件/测试数、退出码和真实 skip。
  - 直接验证：上述固定命令；证据：`migration/evidence/final/typescript-quality-gates.md`。

### PYTHON-QUALITY-GATES

- [ ] **PYTHON-QUALITY-GATES — 在当前工作树运行并记录既有 Python Quick 与 Full 回归。**
  - 状态：`Pending`；改动面：Python 质量证据；只有实际门禁缺陷才修改对应源码、测试或 Harness。
  - 依赖：[TS-QUALITY-GATES](#ts-quality-gates)。
  - 验收：`uv run --frozen python scripts/harness.py quick` 与 `uv run --frozen python scripts/harness.py full` 独立成功；Full 包含 Pyright strict、全部 unittest、wheel 构建/内容核对且拒绝零测试；记录版本、测试数、退出码和真实 skip。
  - 直接验证：上述 Python Quick/Full 命令；证据：`migration/evidence/final/python-quality-gates.md`。

### CI-INTEGRATION

- [ ] **CI-INTEGRATION — 让 CI 在正确触发条件运行 TS 与既有 Python 门禁。**
  - 状态：`Pending`；改动面：`.github/workflows/ci.yml`、`HARNESS.md`、开发入口文档。
  - 依赖：[TS-QUALITY-GATES](#ts-quality-gates)、[PYTHON-QUALITY-GATES](#python-quality-gates)。
  - 验收：普通分支、PR、master、手动触发与仓库规范一致；冻结安装、TS quick/full 和 Python full 的顺序、平台、缓存与失败传播明确；本地配置与 CI 命令不漂移。
  - 直接验证：CI 配置静态校验与本地等价命令；证据：`migration/evidence/final/ci-integration.md`。

### PACKAGE-BUILD

- [ ] **PACKAGE-BUILD — 从清理后的源码构建版本化、可复现的交付产物。**
  - 状态：`Pending`；改动面：`package.json`、workspace package、`release/`。
  - 依赖：[TS-QUALITY-GATES](#ts-quality-gates)、[RUNTIME-SELECTION](01-baseline-and-contracts.md#runtime-selection)。
  - 验收：构建不读取工作区外状态、用户 home 或 Python 源路径；相同源码/锁文件在同平台产物清单稳定；构建失败不留下可误认发布包的半成品。
  - 直接验证：项目正式 pack/build 命令；证据：`migration/evidence/final/package-build.md`。

### PACKAGE-CONTENT

- [ ] **PACKAGE-CONTENT — 核对包内 exports、CLI、Worker、Web、native 组件、许可证和禁入内容。**
  - 状态：`Pending`；改动面：package manifest、内容核对脚本。
  - 依赖：[PACKAGE-BUILD](#package-build)。
  - 验收：运行所需 server/contracts/worker/web/native/迁移资源和许可证完整；测试、源码临时证据、凭据、用户数据、Profile、缓存 browser、绝对路径和未声明二进制不进入包。
  - 直接验证：`apps/server/test/package-content.test.ts`；证据：`migration/evidence/final/package-content.md`。

### PLATFORM-INSTALLATION

- [ ] **PLATFORM-INSTALLATION — 在支持矩阵每个平台安装实际产物并验证原生依赖。**
  - 状态：`Pending`；改动面：CI/release 安装任务、系统临时目录。
  - 依赖：[PACKAGE-CONTENT](#package-content)、[PLATFORM-RELEASE-MATRIX](01-baseline-and-contracts.md#platform-release-matrix)。
  - 验收：每个声明支持的平台从实际 package 安装并启动；Node、SQLite、Browser、PDF 和文件原语版本匹配；未运行平台保持 unsupported/not-run，不能从开发机成功推导支持。
  - 直接验证：`apps/server/test/platform-installation.test.ts` 与平台 CI；证据：`migration/evidence/final/platform-installation.md`。

### PACKAGE-INSTALLATION

- [ ] **PACKAGE-INSTALLATION — 汇合构建、内容和平台安装为可交付安装结论。**
  - 状态：`Pending`；改动面：`release/`、安装指南和证据。
  - 依赖：[PACKAGE-BUILD](#package-build)、[PACKAGE-CONTENT](#package-content)、[PLATFORM-INSTALLATION](#platform-installation)。
  - 验收：用户无需源码路径或 Python 开发环境即可调用公开 CLI/服务；错误平台、缺 native 资源和版本不兼容明确失败；记录每个产物 hash、平台状态和运行依赖。
  - 直接验证：`apps/server/test/package-installation.test.ts`；证据：`migration/evidence/final/package-installation.md`。

### CLEAN-ENVIRONMENT-JOURNEY

- [ ] **CLEAN-ENVIRONMENT-JOURNEY — 在全新临时 home 从实际安装包完成首次启动与基础业务旅程。**
  - 状态：`Pending`；改动面：安装旅程 fixture 与证据。
  - 依赖：[PACKAGE-INSTALLATION](#package-installation)。
  - 验收：无源码、无已有配置/数据库/Profile/cache 的环境完成初始化、配置读取、服务启动、合成导入、查询、导出、重启和关闭；所有外部访问为零，产物只在系统临时目录。
  - 直接验证：`apps/server/test/clean-environment-journey.test.ts`；证据：`migration/evidence/final/clean-environment-journey.md`。

### OFFLINE-JOURNEY

- [ ] **OFFLINE-JOURNEY — 从实际安装包完成 Browser、Candidate、Literature 与持久恢复全旅程。**
  - 状态：`Pending`；改动面：loopback fixtures 与最终证据。
  - 依赖：[CLEAN-ENVIRONMENT-JOURNEY](#clean-environment-journey)、[PERSISTENT-SERVICE-ACCEPTANCE](05-persistent-service-and-recovery.md#persistent-service-acceptance)。
  - 验收：临时 home 中完成配置、人工工作台、Agent、捕获、Candidate、正式 Literature 发布、解析/分析 fake、查询、导出、服务崩溃恢复与关闭；真实 Chromium 只访问 loopback，缺 Browser 不能跳过后仍算通过。
  - 直接验证：`apps/server/test/offline-release-journey.test.ts`；证据：`migration/evidence/final/offline-journey.md`。

### DATA-BACKUP-DRILL

- [ ] **DATA-BACKUP-DRILL — 演练 Catalog、资产引用和 execution 数据的一致备份。**
  - 状态：`Pending`；改动面：最终演练脚本和证据。
  - 依赖：[OFFLINE-JOURNEY](#offline-journey)、[SCHEMA-BACKUP](05-persistent-service-and-recovery.md#schema-backup)。
  - 验收：运行中合成库产生可打开备份，manifest/hash/相对引用一致；备份不复制未声明 Profile/secret，失败不影响源副本，目标 no-clobber。
  - 直接验证：`apps/server/test/data-backup-drill.test.ts`；证据：`migration/evidence/final/data-backup-drill.md`。

### DATA-MIGRATION-DRILL

- [ ] **DATA-MIGRATION-DRILL — 从冻结 v1 副本演练完整 v2 数据升级。**
  - 状态：`Pending`；改动面：最终演练脚本和证据。
  - 依赖：[DATA-BACKUP-DRILL](#data-backup-drill)、[SCHEMA-MIGRATION](05-persistent-service-and-recovery.md#schema-migration)。
  - 验收：升级前后 v1 文献记录、FTS、关系、asset/hash 和查询逐项一致，新增运行表为空或仅含演练事实；中断点可重试，不修改冻结源 fixture。
  - 直接验证：`apps/server/test/data-migration-drill.test.ts`；证据：`migration/evidence/final/data-migration-drill.md`。

### DATA-ROLLBACK-DRILL

- [ ] **DATA-ROLLBACK-DRILL — 从备份演练 v2 到 v1 恢复并核对用户可观察结果。**
  - 状态：`Pending`；改动面：最终演练脚本和证据。
  - 依赖：[DATA-MIGRATION-DRILL](#data-migration-drill)、[SCHEMA-ROLLBACK](05-persistent-service-and-recovery.md#schema-rollback)。
  - 验收：精确副本恢复后 schema/hash/query/export 与迁移前相同；错误目标、坏备份和活动 writer fail closed；回滚不删除不可变资产或源备份。
  - 直接验证：`apps/server/test/data-rollback-drill.test.ts`；证据：`migration/evidence/final/data-rollback-drill.md`。

### PROFILE-ROLLBACK-DRILL

- [ ] **PROFILE-ROLLBACK-DRILL — 演练配置、凭据和 Browser Profile 的备份边界与恢复。**
  - 状态：`Pending`；改动面：最终演练脚本和证据。
  - 依赖：[DATA-ROLLBACK-DRILL](#data-rollback-drill)、[BROWSER-RECOVERY](03-browser-and-acquisition.md#browser-recovery)。
  - 验收：配置可按 no-clobber 流程恢复；凭据/Profile 仅由 owner 管理，报告不复制内容；活动或未知 Browser 进程时拒绝替换 Profile；恢复后固定身份与锁状态可验证。
  - 直接验证：`apps/server/test/profile-rollback-drill.test.ts`；证据：`migration/evidence/final/profile-rollback-drill.md`。

### RECOVERY-DRILL

- [ ] **RECOVERY-DRILL — 汇合数据与 Profile 的备份、迁移、回滚和故障恢复。**
  - 状态：`Pending`；改动面：最终恢复报告。
  - 依赖：[DATA-BACKUP-DRILL](#data-backup-drill)、[DATA-MIGRATION-DRILL](#data-migration-drill)、[DATA-ROLLBACK-DRILL](#data-rollback-drill)、[PROFILE-ROLLBACK-DRILL](#profile-rollback-drill)。
  - 验收：每个注入故障点的已确认事实保留、不可变文件不覆盖、恢复责任明确；无法恢复或未演练路径标为阻断，不能用部分演练关闭总任务。
  - 直接验证：`apps/server/test/recovery-drill.test.ts`；证据：`migration/evidence/final/recovery-drill.md`。

### PERFORMANCE-VALIDATION

- [ ] **PERFORMANCE-VALIDATION — 在声明平台测量关键吞吐、延迟、内存和磁盘边界。**
  - 状态：`Pending`；改动面：受控 benchmark 与证据。
  - 依赖：[OFFLINE-JOURNEY](#offline-journey)、[PLATFORM-RELEASE-MATRIX](01-baseline-and-contracts.md#platform-release-matrix)。
  - 验收：测量 Metadata 批次、DB 查询、事件流、Browser 帧、PDF 限额和关闭时延；记录硬件/fixture/版本/样本量，不把未测试数字写成承诺；超出已定义预算路由回 owner。
  - 直接验证：项目受控性能命令；证据：`migration/evidence/final/performance-validation.md`。

### BACKPRESSURE-VALIDATION

- [ ] **BACKPRESSURE-VALIDATION — 验证 HTTP、事件、画面、队列和文件流的有界背压。**
  - 状态：`Pending`；改动面：负载/故障 fixtures 与证据。
  - 依赖：[PERFORMANCE-VALIDATION](#performance-validation)、[SERVICE-EVENT-STREAM](05-persistent-service-and-recovery.md#service-event-stream)、[SERVICE-SCREEN-STREAM](05-persistent-service-and-recovery.md#service-screen-stream)。
  - 验收：慢消费者、突发 jobs、慢文件、取消和关闭下内存/队列有界；旧帧丢弃、事件恢复 cursor、HTTP 拒绝和 queue 容量各自可观察，不阻塞 Candidate drain 或数据提交。
  - 直接验证：`apps/server/test/backpressure-validation.test.ts`；证据：`migration/evidence/final/backpressure-validation.md`。

### SECURITY-VALIDATION

- [ ] **SECURITY-VALIDATION — 验证 SSRF、认证、凭据、路径、PDF、Browser 与包边界。**
  - 状态：`Pending`；改动面：安全测试与审查证据。
  - 依赖：[BACKPRESSURE-VALIDATION](#backpressure-validation)、[THREAT-MODEL](01-baseline-and-contracts.md#threat-model)。
  - 验收：URL/DNS/rebinding/redirect、exact-origin grant、symlink/no-clobber、恶意 PDF、旧 epoch、跨 workspace、未认证、日志/DTO/package secret 扫描均有正反例；测试只用 fake/loopback/合成文件。
  - 直接验证：`apps/server/test/security-boundaries.test.ts` 与既有安全行为测试；证据：`migration/evidence/final/security-validation.md`。

### LIVE-SITE-STATUS

- [ ] **LIVE-SITE-STATUS — 记录真实站点、Provider、MinerU 与 LLM 验证的授权和实际状态。**
  - 状态：`Pending`；改动面：最终状态报告，不默认执行外部访问。
  - 依赖：[SECURITY-VALIDATION](#security-validation)。
  - 验收：逐类记录 `not-authorized`、`not-run`、`passed` 或 `failed`，包含日期、版本、范围和限制；无明确授权时保持零外部请求，离线 fixture 结果不改写为现场成功。
  - 直接验证：授权记录、脱敏执行记录或零外部访问证明；证据：`migration/evidence/final/live-site-status.md`。

### DOCUMENTATION-SYNC

- [ ] **DOCUMENTATION-SYNC — 同步当前行为、安装、配置、服务、迁移、恢复和限制文档。**
  - 状态：`Pending`；改动面：`README.md`、`docs/guides/`、`docs/development/`、适用 architecture 文档。
  - 依赖：[LIVE-SITE-STATUS](#live-site-status)、[CI-INTEGRATION](#ci-integration)、[RECOVERY-DRILL](#recovery-drill)。
  - 验收：文档区分目标合同、当前已实现、支持平台和未验证现场效果；命令/路径/配置/schema/对象图与实际包一致；不把计划、旧测试数或未授权切换写成发布事实。
  - 直接验证：链接、命令、术语、Markdown 与 documentation map 审查；证据：`migration/evidence/final/documentation-sync.md`。

### PYTHON-RETIREMENT-REPORT

- [ ] **PYTHON-RETIREMENT-REPORT — 逐能力证明 Python 保留、替代或待退役状态。**
  - 状态：`Pending`；改动面：`migration/inventory.json`、最终报告。
  - 依赖：[DOCUMENTATION-SYNC](#documentation-sync)、[INVENTORY-TRACEABILITY](01-baseline-and-contracts.md#inventory-traceability)。
  - 验收：每个 Python 模块/入口/测试有 consumer、TS owner、直接测试、安装证据和 disposition；缺一项即保持 retain/pending；报告本身不删除 Python、不改变入口。
  - 直接验证：`tests/test_migration_inventory.py` 与索引审查；证据：`migration/evidence/final/python-retirement-report.md`。

### CUTOVER-DRILL

- [ ] **CUTOVER-DRILL — 在隔离副本演练入口切换、失败回退和责任交接。**
  - 状态：`Pending`；改动面：隔离脚本、运行手册和证据。
  - 依赖：[PYTHON-RETIREMENT-REPORT](#python-retirement-report)、[RECOVERY-DRILL](#recovery-drill)。
  - 验收：只在临时环境切换到 TS，验证健康、业务旅程和数据，再注入失败并恢复 Python/v1；精确列出生产 preflight、停止条件、owner 和回退时间，不触碰真实部署或用户数据。
  - 直接验证：`apps/server/test/cutover-drill.test.ts`；证据：`migration/evidence/final/cutover-drill.md`。

### READINESS-REPORT

- [ ] **READINESS-REPORT — 汇总全局验收、平台、证据、残余风险和待授权动作。**
  - 状态：`Pending`；改动面：`migration/evidence/final/readiness-report.md`。
  - 依赖：[CUTOVER-DRILL](#cutover-drill)、[LIVE-SITE-STATUS](#live-site-status)、[DOCUMENTATION-SYNC](#documentation-sync)。
  - 验收：逐全局条件链接 Task、直接测试、证据和状态；所有 skip/failure/unsupported/material finding 明示；报告可得出 ready/not-ready，而不把用户授权、发布或退役算作实现完成证据。
  - 直接验证：计划/台账/验收矩阵/证据链接一致性审查；证据：本文件指定路径。

### CUTOVER-REVIEW

- [ ] **CUTOVER-REVIEW — 对实际包、数据、安全、文档和回退材料执行最终 R5。**
  - 状态：`Pending`；改动面：最终 review 与授权包。
  - 依赖：[READINESS-REPORT](#readiness-report)、[TS-QUALITY-GATES](#ts-quality-gates)、[PACKAGE-INSTALLATION](#package-installation)。
  - 验收：R5 finding 全部关闭、路由或列为明确残余风险；缺 Full、平台安装、恢复、文档或核心能力时结论必须为 not-ready；授权包列出精确产物/目标/备份/回退动作。
  - 直接验证：独立或 Primary 最终审查记录；证据：`migration/evidence/final/cutover-review.md`。

### CUTOVER-AUTHORIZATION

- [ ] **CUTOVER-AUTHORIZATION — 记录用户对具体生产切换、发布或 Python 退役动作的决定。**
  - 状态：`Pending`；这是 HUMAN GATE，不是实现完成证明。
  - 依赖：[CUTOVER-REVIEW](#cutover-review)。
  - 验收：请求包含产物 hash、目标、影响、备份、回退和停止条件；只有明确同意的精确动作可进入后续独立执行；拒绝、未答复或范围不清时零 Git/生产/用户数据写入并保持未授权。
  - 直接验证：用户对具体授权包的实际决定；证据：`migration/evidence/final/cutover-authorization.md`。

## 执行方式与集成点

严格串行：TS/Python 质量 → CI → build/content/platform/install → clean/offline journey → data/profile recovery →
performance/backpressure/security → live status/documentation/retirement → cutover drill/readiness/review → authorization。
最终验证发现缺陷时回到产生行为的 Task 修复并重跑受影响门，不在本块添加业务补丁。

## 审查门

R1 核对前五块；R2 检查质量命令、CI、包和安装；R3 检查用户旅程与恢复；R4 检查性能、背压、安全和文档；
R5 检查原始目标、最终 diff、支持矩阵、残余风险、回退与授权包。未通过项不能通过降级为 warning 或改报告关闭。

## 接口 / 数据 / 依赖影响

本块只调整质量、CI、打包、安装、指南和交付材料；不新增业务事实。支持平台、包依赖和 Python 退役状态来自
实际证据。生产切换、发布和退役是后续获准动作，`CUTOVER-AUTHORIZATION` 不自动执行它们。

## 验证与证据

证据写入 `migration/evidence/final/`，链接前五块证据。运行 TS Quick/Test/Full、Python Full、实际 package 安装、
离线旅程、恢复和安全检查；每个命令记录工具/平台/范围/退出码/skip/hash。真实外部验证仅在明确授权后运行。

## 退出条件

除 `CUTOVER-AUTHORIZATION` 的决定状态外，23 项工程与审查 Task 全部闭环，R5 和全局验收通过；随后把具体授权包
交给用户。只有用户明确批准并且获准动作实际执行、验证与交接都完成时，本计划才可标 `Completed`；否则保持
`In progress`、`Blocked` 或明确的未授权状态。

## 完成证据

当前为空。执行后填写质量命令、平台、包 hash、旅程、演练、性能条件、安全 finding、文档 diff、retirement 状态、
readiness 结论和授权决定；本轮计划修复不运行这些验证。

## 失败与恢复

质量/CI/包失败回到对应 Task；业务旅程失败回到原 owner Block；数据/Profile 恢复失败阻断 readiness；性能、背压、
安全或文档问题回到相应边界；授权缺失只阻止外部动作，不允许伪称已切换或已发布。

## 下游交接

交付 readiness 报告、产物与 hash、支持平台、安装和恢复手册、现场验证状态、Python 退役条件、R5 finding 与精确
授权包。不得交付凭据、用户数据、未经验证的成功率或未经授权的生产/Git/退役结果。
