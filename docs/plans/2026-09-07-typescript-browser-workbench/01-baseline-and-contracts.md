# Block 01｜基线、风险与公共合同

## 块身份

- 状态：`In progress`；既有合同实现保留，高风险验证、迁移追踪和长期决策状态尚未通过 R3
- Tasks：`BASE-01`、`INVENTORY-MODULES`、`INVENTORY-ENTRY`、`INVENTORY-METADATA`
  `INVENTORY-ACQUISITION`、`INVENTORY-CLI`、`INVENTORY-CONFIG`、`INVENTORY-TESTS`
  `INVENTORY-TRACEABILITY`、`RUNTIME-SPIKE`、`BROWSER-RUNTIME-SPIKE`
  `PLATFORM-SAFETY-SPIKE`、`PDF-ENGINE-SPIKE`、`THREAT-MODEL`
  `PLATFORM-RELEASE-MATRIX`、`RUNTIME-SELECTION`、`FIXTURE-V1`
  `MIGRATION-DECISIONS`、`TOOLCHAIN-CONTRACT`
  `MODEL-IDENTITY`、`MODEL-RECORDS`、`MODEL-ERRORS`、`CANONICAL-JSON`
  `CANONICAL-INTEGRITY`、`MIGRATION-CONTRACTS`、`BASELINE-ACCEPTANCE`
- 前置块：无
- 下游块：Block 02
- 恢复点：`INVENTORY-MODULES`；先补齐各 inventory Task，再由 `INVENTORY-TRACEABILITY` 汇合逐项迁移追踪，
  随后关闭运行时 spike、长期合同状态和 `BASELINE-ACCEPTANCE`。在该恢复点通过前不开始新的实现切片

## 块结果

建立自包含的迁移边界、版本和平台事实，生成不含用户数据的 v1 fixture，并固定能被后续模块共同消费的
strict contracts、canonical bytes/hash 和查询规则。

## 进入条件

已获得离线计划和本地合成材料修改授权；基线 commit、项目真相源和用户数据保护边界已记录。

## 责任与改动面

Primary 负责 `migration/`、`packages/contracts/`、fixture 和计划证据。Python 源码、既有测试、用户配置、
Catalog、Profile 和凭据保持不变。生产者是当前 Python Model/Entry/Storage，消费者是后续 TS contracts、
Storage、Network、Agents 和业务模块。

## 需要保持的行为

不得重算旧 golden 迁就新实现；不得把领域特定 schema 放入通用合同；不得将 Proposed 选择写成 Accepted；
不得访问真实数据或外部服务。

## Tasks

本节是本块 Task 定义与状态的唯一位置，按列出顺序串行执行。[任务索引](task-ledger.md)仅用于定位。
反引号中的文件路径均相对仓库根目录；未实现任务的路径是拟新增落点，不表示文件或测试已经存在。
每项完成还须满足本块公共退出条件；测试名只描述行为，禁止按计划顺序命名。

### BASE-01

- [x] **BASE-01 — 固定 baseline revision、工作树、Python 版本和既有门禁结果。**
  - 状态：`Completed`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：记录指定 baseline、工作树范围、工具版本和 Python 门禁结果；后续差分只与这份已捕获基线比较。
  - 改动面：`migration/baseline/`。
  - 依赖：无。
  - 验收：基线 revision 可解析，证据区分受保护改动和本任务文件；失败或未运行命令保留原状态，不将缺项当通过。
  - 直接验证：`migration/baseline/README.md`、Python Quick/Full。
  - 证据：[已有记录](../../../migration/baseline/README.md)；沿用已记录的切片结果，不代表下游能力已实现。

### INVENTORY-MODULES

- [ ] **INVENTORY-MODULES — 为 235 个 Python 源模块逐一记录 target、owner、公开符号和 disposition。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：逐模块记录来源、公开符号、目标责任模块及 migrate/retain/retire 处置；数字只描述基线快照。
  - 改动面：`migration/inventory.json`、`python-module-symbols.json`。
  - 依赖：[BASE-01](#base-01)。
  - 验收：清单与基线活动模块逐项对应，无遗漏/重复；每项还记录 consumer、目标 Task、直接测试、证据和
    `unstarted/implemented/verified/retained/retired` 状态；退役项必须有批准依据，不能以目标目录存在代替迁移完成。
  - 直接验证：`tests/test_migration_inventory.py`。
  - 证据：[已有记录](../../../migration/evidence/baseline/inventory.md)；沿用已记录的切片结果，不代表下游能力已实现。

### INVENTORY-ENTRY

- [ ] **INVENTORY-ENTRY — 逐一记录 8 个公开 `api.py` 入口及导出符号。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：列出公开 api.py 的导出和调用方，指定对应 TS 公共入口；识别仅内部使用的接口。
  - 改动面：`migration/inventory.json`。
  - 依赖：[INVENTORY-MODULES](#inventory-modules)。
  - 验收：基线公开导出均有调用方、目标入口、目标 Task、直接测试和处置状态；缺少目标或消费者的项保持
    未闭合，不能标为已实现 API。
  - 直接验证：`tests/test_migration_inventory.py`。
  - 证据：[已有记录](../../../migration/evidence/baseline/inventory.md)；沿用已记录的切片结果，不代表下游能力已实现。

### INVENTORY-METADATA

- [ ] **INVENTORY-METADATA — 逐一记录 11 个 Metadata adapter 及其请求、响应和失败边界。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：按供应商列出支持的 search/lookup/reference/citation 能力、协议边界和目标 adapter。
  - 改动面：`migration/inventory.json`。
  - 依赖：[INVENTORY-MODULES](#inventory-modules)。
  - 验收：基线每个 adapter 都有逐项能力、消费方、目标 Task、fixture、直接测试和证据记录；供应商未支持的
    能力显式标出，不能用统一接口推断支持。
  - 直接验证：`tests/test_migration_inventory.py`。
  - 证据：[已有记录](../../../migration/evidence/baseline/inventory.md)；沿用已记录的切片结果，不代表下游能力已实现。

### INVENTORY-ACQUISITION

- [ ] **INVENTORY-ACQUISITION — 逐一记录 7 个来源和 3 个授权获取 adapter。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：列出七个来源和三个授权 adapter 的 route 输入、凭据 owner、Candidate 输出及失败归属。
  - 改动面：`migration/inventory.json`。
  - 依赖：[INVENTORY-MODULES](#inventory-modules)。
  - 验收：十个入口均有消费方、目标 Task、fixture、直接测试、证据和处置状态；区分 Metadata 与 PDF 获取能力，
    不能以相同供应商名称合并处置。
  - 直接验证：`tests/test_migration_inventory.py`。
  - 证据：[已有记录](../../../migration/evidence/baseline/inventory.md)；沿用已记录的切片结果，不代表下游能力已实现。

### INVENTORY-CLI

- [ ] **INVENTORY-CLI — 逐一记录 23 个 CLI command path、参数和用户可观察错误。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：逐 command path 记录参数、selector、输出格式、退出码和配置 owner，作为 CLI 差分输入。
  - 改动面：`migration/inventory.json`。
  - 依赖：[INVENTORY-ENTRY](#inventory-entry)。
  - 验收：命令及参数与基线一致；每条命令有调用方、目标 Task、直接测试和证据；帮助、错误和未开始操作也有
    落点，不能只盘点成功分支。
  - 直接验证：`tests/test_migration_inventory.py`。
  - 证据：[已有记录](../../../migration/evidence/baseline/inventory.md)；沿用已记录的切片结果，不代表下游能力已实现。

### INVENTORY-CONFIG

- [ ] **INVENTORY-CONFIG — 逐一记录 11 个 configuration section、alias、敏感字段和读写 owner。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：逐 section 记录默认值、引用、敏感字段、读写 owner 和现有交互入口。
  - 改动面：`migration/inventory.json`。
  - 依赖：[INVENTORY-MODULES](#inventory-modules)。
  - 验收：普通配置与 secret 分开；每个字段有消费方、目标 Task、差分测试和证据；未知 section/key、废弃 schema
    和引用错误的处理均可定位。
  - 直接验证：`tests/test_migration_inventory.py`。
  - 证据：[已有记录](../../../migration/evidence/baseline/inventory.md)；沿用已记录的切片结果，不代表下游能力已实现。

### INVENTORY-TESTS

- [ ] **INVENTORY-TESTS — 为 161 个现有 Python 测试文件记录行为 area、被保护能力和迁移测试落点。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：为每个基线测试文件记录所保护的用户结果与目标测试；保留行为测试而非沿用阶段名称。
  - 改动面：`migration/inventory.json`。
  - 依赖：[INVENTORY-MODULES](#inventory-modules)。
  - 验收：活动测试无遗漏；每个测试文件关联被保护行为、消费 Task、目标行为测试和证据；未迁移测试保留未完成
    状态，不能把创建同名空文件视为行为覆盖。
  - 直接验证：`tests/test_migration_inventory.py`。
  - 证据：[已有记录](../../../migration/evidence/baseline/inventory.md)；沿用已记录的切片结果，不代表下游能力已实现。

### INVENTORY-TRACEABILITY

- [ ] **INVENTORY-TRACEABILITY — 关闭活动能力、调用方、Task、直接测试和证据的逐项迁移追踪。**
  - 状态：`Pending`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：汇合模块、公开入口、Provider、Acquisition、CLI、Configuration 和测试清单；为每项填写 consumer、
    target Task、direct test、evidence、disposition、migration status 和批准退役依据。
  - 改动面：`migration/inventory.json`、`migration/evidence/baseline/inventory.md`。
  - 依赖：[INVENTORY-MODULES](#inventory-modules)、[INVENTORY-ENTRY](#inventory-entry)、
    [INVENTORY-METADATA](#inventory-metadata)、[INVENTORY-ACQUISITION](#inventory-acquisition)、
    [INVENTORY-CLI](#inventory-cli)、[INVENTORY-CONFIG](#inventory-config)、[INVENTORY-TESTS](#inventory-tests)。
  - 验收：活动项无未归属、重复 owner 或空处置；`implemented/verified/retired` 都能定位到实际测试和证据；
    `unstarted` 不被计作完成，`retirements` 与 `unresolved` 不允许用空数组掩盖未知项。
  - 直接验证：扩展 `tests/test_migration_inventory.py`，验证字段完整性、Task 链接、测试存在性、状态转换和退役依据。
  - 证据：更新 `migration/evidence/baseline/inventory.md`；当前结构清单仅作为输入，尚未关闭本 Task。

### RUNTIME-SPIKE

- [x] **RUNTIME-SPIKE — 记录本机运行时能力与未验证限制。**
  - 状态：`Completed`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：记录本机 Node/pnpm、Chromium、SQLite、PDF 和文件原语的探测结果；区分已执行、缺失及待选 binding。
  - 改动面：`migration/spikes/`。
  - 依赖：[BASE-01](#base-01)。
  - 验收：版本、平台和探测命令可复现；缺失 Chromium、未选择 TS SQLite binding 明确为限制，不能据此声称 Browser/DB 可运行。
  - 直接验证：`tests/test_runtime_capabilities.py`。
  - 证据：[已有记录](../../../migration/evidence/baseline/runtime-capabilities.md)；沿用已记录的切片结果，不代表下游能力已实现。

### BROWSER-RUNTIME-SPIKE

- [ ] **BROWSER-RUNTIME-SPIKE — 验证并固定 Browser wrapper、Playwright、Chromium、Profile、下载和投屏组合。**
  - 状态：`In progress`；owner：Primary，Browser Host 为运行时 owner。
  - 动作：用真实本地 Chromium 与 loopback fixture 验证 operator-managed wrapper、persistent Profile、native download、
    screencast/ScreenSource、异常关闭和 binary 发现；区分 PATH 缺失、缓存 binary 可用、已选择和正式支持。
  - 改动面：`migration/spikes/browser-runtime/`、`migration/evidence/baseline/browser-runtime.md`。
  - 依赖：[RUNTIME-SPIKE](#runtime-spike)、[INVENTORY-TRACEABILITY](#inventory-traceability)。
  - 验收：组合版本和平台可复现；headless smoke、headed/CloakBrowser、download、screen、Profile reopen 分别给出
    `passed/failed/not-run`；CDP 后备若保留必须有独立结果，未验证组合不得列为支持。
  - 直接验证：`apps/server/test/browser-runtime-compatibility.test.ts`、真实 Chromium loopback smoke；不访问外部站点。
  - 证据：合并现有 `browser-host.md` 的有效 smoke，补齐缺失组合后写入上述证据；当前未闭合。

### PLATFORM-SAFETY-SPIKE

- [ ] **PLATFORM-SAFETY-SPIKE — 验证文件持久原语、跨进程锁和 Browser 原生出口安全可实现性。**
  - 状态：`In progress`；owner：Primary，FileStore 和 Network 分别拥有文件与出口事实。
  - 动作：在支持平台验证 no-follow、no-clobber、目录/文件 fsync、路径替换、锁竞争、持锁进程退出、DNS/IP 绑定、
    CONNECT 与原生 Browser continue 路径；缺失能力形成窄适配或平台限制决定。
  - 改动面：`migration/spikes/platform-safety/`、`migration/evidence/baseline/platform-safety.md`。
  - 依赖：[RUNTIME-SPIKE](#runtime-spike)、[INVENTORY-TRACEABILITY](#inventory-traceability)。
  - 验收：路径替换、symlink/hardlink、崩溃释放、mixed DNS、redirect、非标准端口和旁路通道有可重放结果；
    不能用字符串路径检查、普通 rename 或 mock socket 冒充平台保证。
  - 直接验证：行为命名的文件原语/Browser 出口 spike 测试和独立进程 fixture。
  - 证据：拟写入 `migration/evidence/baseline/platform-safety.md`；当前现有文件测试只是输入。

### PDF-ENGINE-SPIKE

- [ ] **PDF-ENGINE-SPIKE — 选择可受限执行的 PDF 结构检查和文章身份文本提取组合。**
  - 状态：`In progress`；owner：Primary，Acquisition 拥有 PDF 接纳和身份证据。
  - 动作：比较候选工具对页树、加密、无文本、正文、引用、补充材料、大文件和压缩异常的行为；固定时间、内存、
    输入上限、终止和无外部 fetch 边界。
  - 改动面：`migration/spikes/pdf-engine/`、`tests/fixtures/pdf/`、`migration/evidence/baseline/pdf-engine.md`。
  - 依赖：[RUNTIME-SPIKE](#runtime-spike)、[INVENTORY-TRACEABILITY](#inventory-traceability)。
  - 验收：结构检查和身份文本提取能力分别记录；正文含 Supplementary、引用含目标 DOI、无 DOI 相近标题、损坏、
    加密、无文本和资源炸弹均有结果；最终安装不隐式依赖 Python 开发环境。
  - 直接验证：`apps/server/test/pdf-engine-compatibility.test.ts` 与受限 worker fixture。
  - 证据：拟写入 `migration/evidence/baseline/pdf-engine.md`；当前工具版本记录不能关闭本 Task。

### THREAT-MODEL

- [ ] **THREAT-MODEL — 固定单操作者、控制面、凭据、外部页面、PDF 和持久服务威胁模型。**
  - 状态：`Pending`；owner：Primary，安全责任按各事实 owner 路由。
  - 动作：列出信任边界、资产、攻击入口、失败影响和缓解 owner，覆盖本机 API/WS、Origin/Host/CSRF、prompt
    injection、credential grant、截图、Profile、下载、PDF、日志和恢复操作。
  - 改动面：`migration/threat-model.md`。
  - 依赖：[BROWSER-RUNTIME-SPIKE](#browser-runtime-spike)、[PLATFORM-SAFETY-SPIKE](#platform-safety-spike)、
    [PDF-ENGINE-SPIKE](#pdf-engine-spike)。
  - 验收：每个高风险入口有预防控制、直接测试 owner、残余风险和转化信号；网页或 Agent 不能修改策略、扩大能力、
    读取任意服务器文件或把 secret 写入日志/DTO。
  - 直接验证：文档语义审查及 [验收矩阵](verification-matrix.md) 的安全场景链接完整性检查。
  - 证据：拟写入 `migration/threat-model.md`；未完成。

### PLATFORM-RELEASE-MATRIX

- [ ] **PLATFORM-RELEASE-MATRIX — 定义可测试平台、运行依赖、性能观察项和支持声明规则。**
  - 状态：`Pending`；owner：Primary，发行责任由最终验证块消费。
  - 动作：逐平台记录 Node、SQLite、Browser、显示、PDF、native 组件、安装形态和 doctor 规则；定义事件循环、DB、
    frame、transfer、内存、磁盘和背压的测量项，不预填未经测量的数字。
  - 改动面：`migration/release-matrix.json`、`migration/performance-measures.md`。
  - 依赖：[BROWSER-RUNTIME-SPIKE](#browser-runtime-spike)、[PLATFORM-SAFETY-SPIKE](#platform-safety-spike)、
    [PDF-ENGINE-SPIKE](#pdf-engine-spike)、[THREAT-MODEL](#threat-model)。
  - 验收：支持、不支持和 `not-run` 可区分；无 Python/编译器/VNC、headed 显示和缓存 browser 的要求有明确结论；
    性能阈值只有在最终专项验证后才能成为承诺。
  - 直接验证：schema/链接检查和逐平台安装任务对矩阵字段的消费检查。
  - 证据：拟写入 `migration/release-matrix.json` 和 `migration/performance-measures.md`；未完成。

### RUNTIME-SELECTION

- [ ] **RUNTIME-SELECTION — 形成 Browser、SQLite、PDF、文件安全和发行组合的正式运行时选择记录。**
  - 状态：`Pending`；owner：Primary；长期选择必须路由到 requirement/ADR，易变版本留在 migration evidence。
  - 动作：汇总各 spike，记录 adopted/rejected/unsupported 组合、版本约束、许可证、打包影响、回退条件和消费 Task；
    明确 `node:sqlite`、Chromium/CloakBrowser 和 PDF 工具的当前选择状态。
  - 改动面：`migration/runtime-selection.json`、`decision-log.md`。
  - 依赖：[PLATFORM-RELEASE-MATRIX](#platform-release-matrix)、[FIXTURE-V1](#fixture-v1)。
  - 验收：不存在“未安装/已缓存/已选择/已支持”混写；所有未通过 spike 的组合阻断相应下游，不通过降级安全合同继续。
  - 直接验证：`tests/test_runtime_capabilities.py` 扩展为状态和消费链接验证；文档语义审查。
  - 证据：拟写入 `migration/runtime-selection.json`；未完成。

### FIXTURE-V1

- [x] **FIXTURE-V1 — 生成固定的 synthetic metadata、literature、relation、asset、query、canonical bytes 和 hash fixture。**
  - 状态：`Completed`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：固定合成记录、canonical bytes、hash 和 schema fingerprint；为后续 SQLite/query 差分保留输入来源。
  - 改动面：`tests/fixtures/compat-v1/`。
  - 依赖：[INVENTORY-TESTS](#inventory-tests)。
  - 验收：重放生成得到相同 bytes/hash；改动输入或 golden 能被完整性检查识别；不读取用户数据库。
  - 直接验证：`tests/test_fixture_integrity.py`。
  - 证据：[已有记录](../../../migration/evidence/baseline/fixture-integrity.md)；沿用已记录的切片结果，不代表下游能力已实现。

### MIGRATION-DECISIONS

- [ ] **MIGRATION-DECISIONS — 记录迁移 ownership、威胁模型、平台范围、回退和待授权事项。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：记录模块 owner、威胁面、迁移/回退和支持平台候选；将需要改变长期合同的事项路由到 requirement/ADR。
  - 改动面：`migration/`。
  - 依赖：[RUNTIME-SELECTION](#runtime-selection)、[THREAT-MODEL](#threat-model)、[FIXTURE-V1](#fixture-v1)。
  - 验收：每个拟议选择有证据、消费任务和回退条件；执行决定与 Accepted 架构决定明确区分，未决项不隐式成为下游合同。
  - 直接验证：`tests/test_migration_decisions.py`。
  - 证据：[决策记录](decision-log.md)；当前已有离线执行决定，运行时选择、阶段移动和长期合同批准状态仍未闭合。

### TOOLCHAIN-CONTRACT

- [x] **TOOLCHAIN-CONTRACT — 使源码、测试和安装入口共同通过严格工具链。**
  - 状态：`Completed`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：将活动源码和测试纳入 strict typecheck，固定锁文件及 format/lint/test/build 入口，验证各 workspace 的公开包入口。
  - 改动面：根及两个 workspace 的 `package.json` / `tsconfig*.json`、`pnpm-lock.yaml`、`apps/server/src/index.ts`、直接测试与验证文档。
  - 依赖：[RUNTIME-SPIKE](#runtime-spike)、[FIXTURE-V1](#fixture-v1)。
  - 验收：源码和测试中的类型错误均使 typecheck 失败；零测试命令失败；冻结安装后可从产物导入公开包；生成物不混入源码。
  - 直接验证：`packages/contracts/test/toolchain-contract.test.ts`、`packages/contracts/test/package-entrypoints.test.ts`、source/test 类型失败与零测试负例、TS/Python Full。
  - 证据：[2026-09-09 重新验收](../../../migration/evidence/contracts/toolchain.md)；6 files / 25 TS tests、Python 2218 tests（3 个真实 runtime QA 跳过）、wheel 与包入口通过。

### MODEL-IDENTITY

- [x] **MODEL-IDENTITY — 解析固定 UUID、SHA-256、相对 POSIX 路径、枚举、Identifier，并以不同 brand 阻止 ID 互换；拒绝大小写/空白/非法格式。**
  - 状态：`Completed`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：在中性合同边界验证 UUID、SHA-256、相对路径、Identifier 和枚举，并通过 brand 区分 ID 种类。
  - 改动面：`packages/contracts/src/index.ts`。
  - 依赖：[TOOLCHAIN-CONTRACT](#toolchain-contract)、[FIXTURE-V1](#fixture-v1)。
  - 验收：固定合法值往返不变；非法格式、空白/大小写差异按 v1 规则拒绝，不同 ID 类型不能混用。
  - 直接验证：`packages/contracts/test/contract-validation.test.ts`。
  - 证据：[已有记录](../../../migration/evidence/contracts/model-and-canonical.md)；沿用已记录的切片结果，不代表下游能力已实现。

### MODEL-RECORDS

- [x] **MODEL-RECORDS — 解析 Provenance、LiteratureMetadata、Literature、MetaLiterature、Reference、Asset、LibraryQuery；拒绝未知字段、错误 null、反向年份范围和自引用。**
  - 状态：`Completed`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：为 provenance、metadata、literature、relation、asset 和 query 提供 closed parser；字段语义取自 Model 真相源。
  - 改动面：`packages/contracts/src/index.ts`。
  - 依赖：[MODEL-IDENTITY](#model-identity)。
  - 验收：合成 v1 记录可解析；未知字段、错误 null、反向范围、自引用被拒绝，缺失 provenance 不被补造。
  - 直接验证：`packages/contracts/test/contract-validation.test.ts`、compat-v1 fixture。
  - 证据：[已有记录](../../../migration/evidence/contracts/model-and-canonical.md)；沿用已记录的切片结果，不代表下游能力已实现。

### MODEL-ERRORS

- [x] **MODEL-ERRORS — 提供 closed `ContractValidationError`、稳定脱敏 failure 和严格 ReportEnd；错误只返回固定消息、路径和 code，不回显输入。**
  - 状态：`Completed`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：输出固定 code、字段路径和脱敏消息，解析严格 ReportEnd；禁止回显原始输入或 vendor 异常。
  - 改动面：`packages/contracts/src/index.ts`。
  - 依赖：[MODEL-IDENTITY](#model-identity)。
  - 验收：合法报告可往返；坏状态与未知字段拒绝，含合成敏感标记的输入不出现在错误或 JSON 中。
  - 直接验证：`packages/contracts/test/contract-validation.test.ts`。
  - 证据：[已有记录](../../../migration/evidence/contracts/model-and-canonical.md)；沿用已记录的切片结果，不代表下游能力已实现。

### CANONICAL-JSON

- [x] **CANONICAL-JSON — 实现递归 key 排序、Unicode NFC、UTF-8、有限数字和 duplicate-key strict JSON；输出与 v1 fixture 逐字节一致。**
  - 状态：`Completed`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：实现 v1 key 排序、Unicode/UTF-8、有限数值和严格 JSON 解码；重放冻结 golden。
  - 改动面：`packages/contracts/src/index.ts`。
  - 依赖：[MODEL-RECORDS](#model-records)。
  - 验收：先逐字节比较再比较 hash；重复 key、非有限数和非法 JSON 拒绝，不更新旧 golden 消除差异。
  - 直接验证：`packages/contracts/test/canonical-encoding.test.ts`。
  - 证据：[已有记录](../../../migration/evidence/contracts/model-and-canonical.md)；沿用已记录的切片结果，不代表下游能力已实现。

### CANONICAL-INTEGRITY

- [x] **CANONICAL-INTEGRITY — 对 canonical bytes 计算 SHA-256，并实现带 kind/version/checksum 绑定的无填充 base64url cursor 编解码和篡改拒绝。**
  - 状态：`Completed`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：对 canonical bytes 计算 SHA-256；cursor 绑定 kind、version、payload 和 checksum，并使用无填充 base64url。
  - 改动面：`packages/contracts/src/index.ts`。
  - 依赖：[CANONICAL-JSON](#canonical-json)。
  - 验收：v1 摘要一致；篡改 payload/checksum、错误 kind/version 和不规范编码均不能解成有效 cursor。
  - 直接验证：`packages/contracts/test/canonical-encoding.test.ts`。
  - 证据：[已有记录](../../../migration/evidence/contracts/model-and-canonical.md)；沿用已记录的切片结果，不代表下游能力已实现。

### MIGRATION-CONTRACTS

- [ ] **MIGRATION-CONTRACTS — 把已获准的迁移方向落实到权威设计，并分离 Proposed 与 Accepted 决策。**
  - 状态：`In progress`；owner：Primary，业务责任按本块“责任与改动面”。
  - 动作：依据用户获准方向补齐 TS 运行时、人工控制、Candidate 持久生命周期和 v2 execution 的目标合同及 owner；标明旧 Accepted 选择的保留、修订或替代，不从历史研究档案推导授权。
  - 改动面：`docs/architecture/`。
  - 依赖：[MIGRATION-DECISIONS](#migration-decisions)、[CANONICAL-INTEGRITY](#canonical-integrity)。
  - 验收：requirements/ADR/design/technical 相互链接且无第二 owner；生产者/消费者、迁移和回退齐备；现有不持久化
    报告等合同的变化需显式处置；ADR 0024 的长期 `Accepted` 状态有独立批准事实，否则保持 `Proposed`；离线实施
    授权不能替代长期架构接受或生产切换授权。
  - 直接验证：文档语义审查；逐项核对 requirement/ADR/design/technical 与生产者/消费者表。
  - 证据：[合同衔接审查](../../../migration/evidence/baseline/migration-contracts.md)；当前文档已建立，但长期批准依据和
    新增验收场景追踪尚待关闭。

### BASELINE-ACCEPTANCE

- [ ] **BASELINE-ACCEPTANCE — 在实现继续前关闭清单、spike、运行时选择、合同和验收追踪的 R3。**
  - 状态：`Pending`；owner：Primary，作为 Block 02 的唯一进入门。
  - 动作：审查本块所有 Task、[验收矩阵](verification-matrix.md)、运行时选择、决策状态和工作树边界，形成正式
    baseline acceptance；只汇总证据，不补实现旁路。
  - 改动面：`migration/m0-decision-record.md`、本块完成证据、根计划状态。
  - 依赖：[INVENTORY-TRACEABILITY](#inventory-traceability)、[RUNTIME-SELECTION](#runtime-selection)、
    [MIGRATION-CONTRACTS](#migration-contracts)、[CANONICAL-INTEGRITY](#canonical-integrity)。
  - 验收：关键能力有 `passed/failed/not-run` 结果；阻断/不支持组合和首个实施切片明确；未通过项不会因环境版本、
    测试总数或计划 checkbox 被当作已接受基线。
  - 直接验证：文档链接、Task 依赖、验收场景覆盖和证据存在性检查；不运行真实外部操作。
  - 证据：拟写入 `migration/m0-decision-record.md`；未完成。

## 执行方式与集成点

`BASE-01` 完成后关闭 `INVENTORY-*`/`INVENTORY-TRACEABILITY`，再执行 Browser、平台安全、PDF、威胁模型、
发行矩阵和运行时选择；之后执行 `MIGRATION-DECISIONS`、
`TOOLCHAIN-CONTRACT`、`MODEL-IDENTITY`、`MODEL-RECORDS`、`MODEL-ERRORS`、`CANONICAL-JSON`、
`CANONICAL-INTEGRITY`、`MIGRATION-CONTRACTS` 和 `BASELINE-ACCEPTANCE`。每个任务完成后运行其直接检查、审查 diff 和
证据，再更新本节状态；不使用阶段编号推导任务状态。

## 审查门

R0 检查计划自包含；R1 检查基线和授权；R2 检查 fixture 来源、合同 owner、负例和 bytes；R3 检查是否足以
进入 Block 02。任何数据/安全/兼容差异都阻断下游。

## 接口 / 数据 / 依赖影响

新增迁移清单、合成 fixture 和 contracts，不改变 Python 公开行为、用户数据或生产 schema。Node/浏览器/
SQLite/PDF 选择在证据充分前只是 Proposed。

## 验证与证据

证据目录为 `migration/evidence/baseline/` 和 `migration/evidence/contracts/`；直接测试使用
`test_migration_inventory.py`、`tests/test_fixture_integrity.py`、`contract-validation.test.ts`、
`canonical-encoding.test.ts` 等行为名称。

## 退出条件

能力清单逐项关联 consumer/Task/test/evidence；高风险 spike 可复现；v1 fixture 稳定；合同、bytes/hash 和负例
直接测试通过；Python Quick/Full 仍通过；运行时选择、长期合同状态、未支持组合和阻断事实已记录；
`BASELINE-ACCEPTANCE` 通过。

## 完成证据

基线和合同的既有记录分别见 [inventory](../../../migration/evidence/baseline/inventory.md)、
[runtime-capabilities](../../../migration/evidence/baseline/runtime-capabilities.md)、
[model-and-canonical](../../../migration/evidence/contracts/model-and-canonical.md) 和
[toolchain](../../../migration/evidence/contracts/toolchain.md)。基线/合同记录保留当时范围；toolchain 文件增加了本轮重新验收证据。

`TOOLCHAIN-CONTRACT` 已修复测试类型覆盖、server 包入口和冻结锁文件缺口，并经直接验证及 TS/Python Full 重新闭合。
现有合同、工具链和合成 fixture 证据保留。Inventory 尚未形成逐项迁移追踪；Browser/平台/PDF spike、威胁模型、
发行矩阵、运行时选择和长期合同批准状态尚未闭合，因此本块未达到 R3，也不能交接 Block 02。

## 失败与恢复

基线失败停止在 `BASE-01`；fixture 或 canonical 差异停止在 `FIXTURE-V1`、`CANONICAL-JSON` 或
`CANONICAL-INTEGRITY`；不修改既有 golden，保留失败样本并从最近一个通过的任务恢复。Chromium 和 TS
SQLite binding 的未决事实仍由后续块进入门处理，不在本块假装完成。

## 下游交接

交接能力清单、v1 fixture、strict contracts、canonical/hash 算法、平台阻断范围和决策记录；不交接临时
实现、真实数据或未批准的架构承诺。
