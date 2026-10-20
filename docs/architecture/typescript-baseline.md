# TypeScript 架构锚定基线

- 状态：Owner 已确认的当前架构基线；不替代产品需求或 Accepted ADR
- 适用范围：当前 TypeScript 生产路线、目标架构与文档同步
- 相关索引：[整体架构](README.md)、[产品需求](requirements.md)、[设计文档](design.md)、[技术索引](technical.md)、[ADR 索引](decisions/README.md)

本文把已经确认的 TS 阶段架构决策和当前实现边界放在同一张可核对的地图中。它不是动态进度台账，也不能把“目标合同”写成“已经实现”。产品范围以 `requirements.md` 为准，长期选择以 `decisions/` 下 Accepted ADR 为准，目标模块与所有权以 `design.md` 和 `technical*.md` 为准，当前公开行为以 README、指南、源码和直接测试为准。

## 0. 产品目标修订与当前差距（2026-09-30）

[需求](requirements.md)、[设计](design.md)和 [ADR 0026](decisions/0026-agent-knowledge-and-human-collaboration.md)已确定 Agent 原始材料/知识压缩与人类协作方向，以下区分当前实现与目标：

| 能力 | 当前代码事实 | 剩余边界 |
| --- | --- | --- |
| 原始材料/独立解析 | 明确获取/人工接纳、独立解析与 QueryApplication 阅读已接通 | 真实 Provider/Parser/站点未验收，读取缺口不启动维护 |
| 文档证据 | v3–v9 固定版本、UTF-8 片段、资源与 hash/provenance 可读取和复核 | 表格单元、图注、PDF 页码/bbox 与通用物理回收未开放 |
| 分析 | v6 单篇多用途/长文分层知识，v7 集合综合已接通；保留旧 Analysis 兼容路径 | fake 模型证明流程和证据约束，不证明真实科学质量 |
| 检索 | v4 材料 Context、v8 知识/材料混合 Context；显式建索引、有界读取和固定证据展开 | 无 tokenizer；真实语料召回/排序质量未评估，分数不是科学置信度 |
| 文章身份核验 | v9 显式模型抽取原文证据、Literature 接纳与按 ID 读取；不阻断下载 | 辅助判断，真实语料准确率待独立评估 |
| Agent adapter | 公开 TS、CLI、HTTP 与适用 Web 入口可消费固定 ID/hash/证据 | 正式 MCP stdio 已接通，任务操作复用公开 Application；科学质量不由协议测试推导 |
| 人类协作 | 同一生产 Browser 可观看、指导、接管/交还并接纳 PDF；人类和 Agent 共用资料 | 实际 Cloak loopback 已验证，真实 Publisher/机构身份与 entitlement 未验收 |
| 材料保留 | NoUsableContent 保留已接纳材料；v3 起禁旧物理回收，v5 起有外部候选回执的有限期保护 | 明确失效和跨进程 GC/通用回收仍待设计；旧兼容内容不自动撤销 PDF |
| 通用提取 | 调用方规范、只读准备、v5–v9 原子候选交付、回执与输入 pin 已接通 | 领域含义/最终数据集归调用方；不托管 payload 或自动科学接纳 |

旧章节中的单篇内容、目标枚举和精确 schema 描述当前/兼容实现，不穷尽新产品目标。v3–v9 与当前公开入口已有实现及直接验证，正式初始化/升级和 reader 范围见[安装兼容矩阵](../guides/installation.md#当前-catalog-与-reader-兼容)；后台存续、完整历史回放、通用回收及候选 payload 托管不由这些结果推导。2026-10-08 补充 MCP、加工任务及身份判断实现；没有修改用户数据或执行真实外部探测。

2026-09-27 新目标按 [ADR 0028](decisions/0028-query-and-expansion-separation.md)将查询与显式维护分开：新读取/分析接口不得因缺口调用 completion 扩库。显式 complete pdf/content 仍是维护命令，content 的补 PDF 行为不是查询行为；当日只改设计，后续独立 QueryApplication 和只读隔离已实施并验证。

2026-09-28 只读复核当时确认：Jobs仅使用TargetRunner、Analysis两次全文请求、旧cleanup联动与CLI缺省500的差距。该段保留为实施前记录，不代表当前进度。代码/数据/API变化与兼容设计见[迁移映射](evolution-map.md)，执行证据归[迁移计划](../archive/2026-09-28-typescript-knowledge-architecture-migration/README.md)。当时 Catalog v2 仅有 execution 扩展；当前正式 operator 可显式初始化 v9 或升级 v1–v8，普通读取与启动不自动升级。

## 1. 已确认的架构决策

### 1.1 TypeScript-only

TypeScript workspace、Application、CLI、Browser 运行时和 portable package 是当前生产实现路线。Python 代码、历史测试和旧 Harness 只作为迁移历史、离线 oracle 或明确授权的历史维护材料保留；不支持 Python/TypeScript 双写、双运行时或双真相源。生产切换、真实用户数据迁移、发布和历史材料处置仍需独立授权，详见 [ADR 0024](../archive/decisions/0024-typescript-browser-workbench-migration.md) 与 [ADR 0025](decisions/0025-typescript-entry-and-runtime-contract.md)。

### 1.2 Browser 是当前生产能力

Browser 是 PDF 获取的正式最后一级能力，风险顺序固定为：

```text
Public → Authorized API → Controlled Browser
```

生产 Browser 使用唯一的 `browser:generic` controller、CloakBrowser 固定身份 Profile、共享 process/context、Network admission 和 Acquisition 的 PDF/文章归属验收。Browser 不获得 SQL、Catalog 写入、任意 URL、Cookie、CDP 或事实发布能力。

**当前实现边界：** 生产 Application 已拥有惰性 BrowserHost factory、Network navigation admission 和 Entry 的 Browser escalation 端口；无 verified runtime 或 admission 时会稳定报告不可用，不会构造或启动 host。当前实现覆盖 normal-miss/显式低风险 route declaration 的有界升级、单篇五层顺序、按完成时刻通知的结果、版本化 landing hint、统一 Intake/身份验收，以及同一 Application 内的 `BrowserSessionBroker` 和文章 scheduler（旧 delivery-only seam 保留 FIFO）。broker 使用 operation-local `generation`/`operation_id` 拒绝过期排队 delivery，并在 close 时停止 admission 后 drain；CONTENT_READY 缺 PDF 时会在生产对象图中先完成自动 acquisition，再重新读取 Literature。真实 Cloak source-checkout 与 portable 副本的 loopback 正路径已实际验证；软件来源核实、synthetic 测试和真实 runtime 行为分别记录，具体范围见[安装验收边界](../guides/installation.md#安装验收边界)。真实 Publisher/机构站点仍未运行。

### 1.3 固定配置身份

生产配置身份固定为：

```text
~/.sciretriever/config.toml
~/.sciretriever/credentials.toml
```

普通 CLI 不读取 `SCIRETRIEVER_HOME`、当前目录或第二配置路径，也不提供 `--config`。home 注入只允许用于内部边界和隔离测试。目录与文件继续遵守 owner、权限、单硬链接和非符号链接约束，见 [ADR 0018](decisions/0018-fixed-user-configuration-home.md)。

**当前实现边界：** 生产 CLI 使用 `~/.sciretriever` 作为唯一配置身份；`SCIRETRIEVER_HOME` 不参与生产路径。显式注入的临时 `home` 仅是内部测试/隔离 seam，不改变生产身份。

### 1.4 `config test` 必须执行显式最小只读 probe

`config status` 只读取本地 readiness；用户显式发起 `config test` 时，必须通过统一、无 Storage 副作用的 Probe dispatcher 执行当前 owner 对应的最小只读验证。Provider、Model、Search、Parse、Analyze、Browser Model 和单目标 Browser Site 使用同一套诊断边界；Download 没有安全的通用外部 probe 时返回稳定的 `unavailable`，不得借用 Metadata 请求或下载任意 PDF。

Probe 结果必须脱敏、区分本地字段存在、认证成功和内容 entitlement，并明确 method、受控 endpoint、实际 Model、结果、失败原因和下一步。测试中的 fake/loopback 只证明离线边界，不能替代生产 probe。

**当前实现边界：** `ConfigurationProbeSession` 已通过统一 dispatcher 执行有界、只读 probe：获授权且具备对应 adapter 时会实际访问一次受控 Provider/Model/Search/Parse/Analyze 端点；Download 没有安全的通用 probe，稳定返回 `unavailable`；Browser Site 仅在显式注入/配置的 Browser Site seam 存在时运行，否则返回稳定不可用。Probe 不写入 Storage，结果明确标示 `network_performed`、`browser_launched`、`persisted=false` 和 entitlement 未证明。真实 Provider/模型/Parser 与公网 Browser Site 未验收；已执行的 Cloak loopback 不代替这些外部 probe。

### 1.5 统一 Entry 与 completion report

所有处理型入口（CLI、Web、Job）最终使用同一 Entry/Application 编排，不在适配层复制 Acquisition、fallback、取消、错误分类或报告生成。一次批量操作冻结目标；目标之间隔离，单目标失败不回滚其它已提交事实；取消停止新目标并报告当前中断和尚未开始目标。

数据库补全的目标合同使用五个互斥分区：

```text
completed
failed
skipped
notStarted
interrupted
```

每个目标只能位于一个分区：`completed` 表示达到目标，`failed` 表示稳定失败，`skipped` 表示带稳定 reason 的明确未执行/需人工介入，`notStarted` 表示冻结后从未开始，`interrupted` 表示已开始后受控中断。报告还必须保留阶段、稳定失败、route/provenance、是否需要人工介入和已经提交的事实。Storage 只保存已确认业务事实，不保存批次报告、动态队列或日志现场。

**当前实现边界：** CLI `complete pdf|content` 与 Application 使用 `DatabaseCompletionService`，
返回严格的 `DatabaseCompletionReport` 与 `ReportEnd`。范围在共享写准入内从一致 snapshot 冻结，
普通范围会检查全部 Meta 成员是否已满足目标，并冻结完整版本候选；具体 Literature 仍严格单版本。
已有耗尽事实不会被宽范围自动重试，取消不会掩盖已知 Storage/receipt 失败。
`DatabaseCompletionOperation` 使用 `execution.max_concurrency` 个有界 worker 持续补位，
每篇独立保持五层获取顺序；进度按完成时间反馈，最终 Report 按冻结顺序排列。操作身份/代次稳定，
正常补位不使兄弟 Browser 会话失效，提交仍由操作内单队列执行。Browser 共享文章 scheduler，
同平台串行、跨平台可并行；旧 delivery-only seam 保留串行兼容。
取消会排空已启动工作并释放未提交解析准备，已提交内容保留，结果按冻结顺序汇总。
单目标 Parser/Analysis 失败不会停止后续目标；持久化或发布失败停止调度并保留失败原因。
durable Jobs 的新建任务复用 `DatabaseCompletionService.freezeRequest()` 冻结目标和版本候选；
显式运行时把仍可执行目标交给完整 `runFrozen()` 操作，保留既有逐目标 durable 记录和返回格式。
Browser escalation、版本化 Intake、单篇五层顺序、及时结果通知、稳定不可用结果和 close 时的
broker drain 已接入当前 Application 对象图；durable Jobs 不持久化整个操作级 Report。
真实 verified CloakBrowser 正路径已在 loopback 执行；Publisher 站点现场验证仍未运行，不能据
loopback 或 fake fixture 扩大声明。

## 2. TS 活动模块地图

```text
packages/contracts/
  src/  test/

apps/server/src/
  acquisition/   analysis/      agents/        application/
  bootstrap/     browser/       cli/           configuration/
  entry/         literature/    logging/       metadata/
  providers/     # 外部适配代码按供应商聚合，业务责任仍由原模块拥有
  network/       parsing/        storage/       workbench/

apps/web/src/
```

`packages/contracts` 是跨模块中性合同的当前归属；不要继续把 `apps/server/src/model/` 或 Python `src/sciretriever/model/` 写成当前目录。`bootstrap` 负责生产对象图，`configuration` 负责固定用户配置和凭据，`entry` 负责用户操作边界和流程编排，`application` 负责应用生命周期与 durable jobs，`workbench` 负责当前工作台预览/运行时边界；这些责任需要在对应技术文档中保持一致。

## 3. 文档写作门禁

能力与设计材料区分以下四种状态：

- **已实现**：附源码和直接测试证据；
- **合同目标·未实现**：引用 requirements/ADR，并明确当前缺口；
- **历史**：明确属于 Python/旧迁移路径，不作为当前 TS 目标。
- **设计提案**：满足已接受需求的具体方案尚未冻结，如[统一产品接口：共享合同、结构解析与版本兼容](technical/01-product-interface.md#6-共享合同结构解析与版本兼容)；它不等同于新的 Accepted 决定或实现完成。

README 和用户指南默认只描述已实现的当前行为。目标能力放在 architecture/ADR，并明确“合同目标·未实现”；计划状态不替代源码和测试证据。真实 Provider、MinerU、CloakBrowser、生产 Catalog 和用户数据未授权或未运行时，必须使用 `not-run`、`skipped` 或 `not-authorized`，不得写成 production-ready。

## 4. 已知同步项

本轮已同步 README、Entry/Acquisition/Network/Configuration/Logging 技术文档、配置与 PDF 指南、ADR 0025 以及迁移路线中的当前状态。后续维护仍须持续检查：

1. 目标合同与当前实现必须继续分开标记；三级 cohort、scheduler/session broker 有离线合同证据，真实 Cloak loopback 另有实际运行证据，外部服务/站点验证仍不能从它们推断；
2. `no-entitlement` 当前不属于自动 Browser rescue，必须保持 action-required/fail-closed，只有显式 `not-applicable`/`no-capability` 或允许的正常 locator exhaustion 才可进入 Browser 判断；
3. 迁移计划中的旧测试/模块计数必须明确标为历史盘点快照，不得冒充当前 TS 模块或测试数；当前数量和通过证据以源码、直接测试与本基线为准；
4. 文档链接、代码路径和命令选项随源码变化重新运行结构/链接检查；
5. 真实数据迁移、Browser 生产切换、外部 Provider 调用和现场 entitlement 验证仍需单独授权。

本文不授权真实数据迁移、Browser 生产切换、外部 Provider 调用或清理 `work/`、`build/`、`dist/`、`archive/`。
