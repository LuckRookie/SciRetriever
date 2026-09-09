# 07｜分阶段执行路线与任务清单

本文件由同包 `tasks.json` 的初始任务定义生成。全部任务状态为 `not-started`，不是实施进度报告。任务编号固定；阶段允许并行，但必须满足逐任务依赖。

## 1. 执行顺序与跨阶段依赖

主线为 M0 → M1 → M2 → M3 → M5 → M6；M4在M1基础上并行推进。特别是T038的Literature业务规则必须先于T033正式发布闭环，因此阶段编号不等同于严格按号执行。T046的v2设计/迁移可提前在副本验证，但在M5整体验收前不能给真实库默认升级。

首个可演示成果是T028：不依赖Agent成功判断的浏览器工作区。首个自动下载里程碑是T036。完整应用迁移以T045为界；持久服务以T054为界；发布以T064为界。

每个角色只代表所需责任，不假定实际团队人数。同一开发者可依次承担多个角色。任务没有工期承诺，先依据M0结果评估实现规模。

## 2. 阶段退出条件

| 阶段 | 主题 | 退出条件 |
|---|---|---|
| M0 | 冻结与高风险验证 | 关键代码/全部接口盘点、ADR状态和spike可重现。未解决的底层能力缺口有明确阻断范围。 |
| M1 | TS基础与v1兼容 | 类型、规范化、配置、Network、模型协议、文件与DB Worker完成；v1库差分通过。 |
| M2 | 纯人工可用的浏览器工作区 | 同一真实页面、单端口、通用输入、投屏、控制lease与Collector的本地fixture通过。 |
| M3 | 自动获取闭环 | Agent按策略操作，候选真实落盘并验收；无人打扰批次可完整结束，不误报成功。 |
| M4 | 其余业务能力全量迁移 | 所有现有来源、身份/引用、发现、导入、解析、分析、查询、导出、CLI有验收证据。 |
| M5 | 持久任务与常驻服务 | 显式v2升级、任务/候选/业务对账、重启与人工现场交接通过；一个受控服务入口。 |
| M6 | 打包、验收与切换 | 支持平台安装后流程、质量门禁、备份恢复与完整迁移清单通过；未验证外部效果如实披露。 |



## 3. 工作并行与变更控制

适合并行：Browser Host/工作台、Metadata/协议适配、存储golden与PDF引擎。应串行确认：公共合同、canonical字节、schema升级、生产对象图与控制权协议。公共合同变更先核对所有生产者和消费者，避免各任务私自扩充同名DTO。

每项任务的验收ID来自 [08](08-tests-release.md)。测试只是最低核对项，不能代替输出与业务语义复核。所有设计和命令尚待实现；执行证据附在tasks.json的evidence字段或指向阶段报告。

## 4. 任务明细


### M0｜冻结与高风险验证


#### T001｜冻结仓库、实际入口与逐文件迁移盘点

**状态：** 未开始　**责任：** 迁移负责人　**依赖：** 无

**现有落点：** `AGENTS.md`；`HARNESS.md`；`src/sciretriever/`；`tests/`；`scripts/`；`.github/workflows/ci.yml`

**目标位置（拟新增/改造）：** `migration/inventory.json`；`migration/baseline/`

**产物：** 当前commit/工作树记录；全部活动文件、公开符号、Provider、CLI、配置与测试映射；旧离线Harness实际结果。

**验收：** 不访问用户数据或真实站点；每个活动文件有明确去向，历史目录单独标识；未运行或失败的基线检查如实记录。

**测试：** C03, C06, E07。**风险：** 高：遗漏能力与基线漂移。

设计依据：[01-codebase-audit.md](01-codebase-audit.md)。


#### T002｜形成新需求和六项ADR草案及变更清单

**状态：** 未开始　**责任：** 架构负责人　**依赖：** T001

**现有落点：** `docs/architecture/requirements.md`；`docs/architecture/decisions/`；`docs/architecture/design.md`

**目标位置（拟新增/改造）：** `docs/architecture/decisions/`；`migration/intentional-changes.json`

**产物：** 全TS/工作区/策略/持久任务/v2/原生访问决策；旧合同保留与修改表。

**验收：** 明确改变六动作和进程内任务限制；运行状态不替代文献事实；未获批准的决策不标Accepted。

**测试：** E07。**风险：** 高：架构合同被隐式覆盖。

设计依据：[09-contracts-adr.md](09-contracts-adr.md)。


#### T003｜验证并固定TS浏览器与投屏依赖组合

**状态：** 未开始　**责任：** 浏览器工程师　**依赖：** T001

**现有落点：** `pyproject.toml`；`src/sciretriever/network/cloakbrowser.py`

**目标位置（拟新增/改造）：** `spikes/browser-compat/`；`migration/runtime-matrix.json`

**产物：** wrapper/Playwright/Chromium/Node/平台版本矩阵；persistent/download/screencast探针；许可与二进制分发检查。

**验收：** 使用真实Chromium本地fixture，不用mock代替；当前1.55限制被显式处理；未验证组合不得标支持。

**测试：** B08, D01。**风险：** 高：wrapper与协议不兼容。

设计依据：[03-browser-workbench.md](03-browser-workbench.md)。


#### T004｜验证文件原语、单写锁与原生出口安全可实现性

**状态：** 未开始　**责任：** 系统与安全工程师　**依赖：** T001

**现有落点：** `src/sciretriever/storage/locking.py`；`src/sciretriever/storage/files/`；`src/sciretriever/network/browser_connect.py`

**目标位置（拟新增/改造）：** `spikes/platform-safety/`；`migration/native-capabilities.json`

**产物：** 平台锁/no-follow/no-clobber/fsync矩阵；CONNECT与DNS绑定POC；窄native模块或平台限制决策。

**验收：** 覆盖路径替换与崩溃释放；说明Node缺失能力而不降低保证；区分隧道预算和逐响应字节预算。

**测试：** N01, N06, S04。**风险：** 阻断：安全原语不等价。

设计依据：[06-storage-upgrade.md](06-storage-upgrade.md)。


#### T005｜验证TS PDF结构检查与身份文本提取引擎

**状态：** 未开始　**责任：** PDF与获取工程师　**依赖：** T001

**现有落点：** `src/sciretriever/acquisition/rules.py`；`src/sciretriever/acquisition/pdf_identity.py`；`tests/test_acquisition_pdf_identity.py`

**目标位置（拟新增/改造）：** `spikes/pdf-inspector/`；`tests/fixtures/pdf/`

**产物：** 候选PDF引擎评估；主文/引用/补充/无文本/加密/大文件fixture。

**验收：** 明确文字提取质量与结构校验差异；独立执行可终止；不要求最终用户另装Python或编译工具。

**测试：** D09, D10, D11, D12。**风险：** 高：PDF引擎差异与资源失控。

设计依据：[04-acquisition-network.md](04-acquisition-network.md)。


#### T006｜导出v1数据库、Model与哈希的离线goldens

**状态：** 未开始　**责任：** 数据迁移工程师　**依赖：** T001

**现有落点：** `src/sciretriever/model/`；`src/sciretriever/storage/sqlite/`；`src/sciretriever/literature/content.py`

**目标位置（拟新增/改造）：** `tests/fixtures/compat-v1/`；`migration/oracle-manifest.json`

**产物：** 合成v1库及DDL字节/指纹；Model正负例；canonical字节、查询、关系与资产manifest。

**验收：** 不使用用户数据库；固定时钟和ID，不掩盖hash差异；包含Unicode/时间/null/数字边界。

**测试：** C01, C02, S01。**风险：** 阻断：数据兼容未定义。

设计依据：[05-ts-migration.md](05-ts-migration.md)。


#### T007｜冻结威胁模型、性能观察项与平台发行目标

**状态：** 未开始　**责任：** 安全与发行负责人　**依赖：** T001, T003, T004, T005

**现有落点：** `AGENTS.md`；`docs/architecture/technical/network.md`；`docs/architecture/technical/storage.md`

**目标位置（拟新增/改造）：** `migration/threat-model.md`；`migration/release-matrix.json`

**产物：** 单操作者、控制面、凭据、外部页面威胁模型；可测试平台矩阵；性能测量项与配额语义。

**验收：** 单端口仍有认证与Origin/CSRF保护；Linux显示依赖如实列出；无浮动binary或隐式外网测试。

**测试：** N03, N04, E04。**风险：** 高：零安装或安全能力过度承诺。

设计依据：[08-tests-release.md](08-tests-release.md)。


#### T008｜关闭关键spike并接受实施基线

**状态：** 未开始　**责任：** 架构负责人　**依赖：** T002, T003, T004, T005, T006, T007

**现有落点：** `docs/architecture/`；`migration/`

**目标位置（拟新增/改造）：** `migration/m0-decision-record.md`；`migration/runtime-selection.json`

**产物：** 正式确认的选型与ADR状态；阻塞/不支持组合表；首个能力切片范围。

**验收：** 关键能力有结果而不是待调查；未通过spike不得进入生产替换；无需审批的文档与需审批的变更分清。

**测试：** B08, S04, E07。**风险：** 阻断：带未知前提全量重写。

设计依据：[07-roadmap.md](07-roadmap.md)。


### M1｜TS基础与v1兼容


#### T009｜建立TS工作区、编译与测试骨架

**状态：** 未开始　**责任：** 应用工程师　**依赖：** T008

**现有落点：** `pyproject.toml`；`scripts/harness.py`；`.github/workflows/ci.yml`

**目标位置（拟新增/改造）：** `apps/server/`；`apps/web/`；`packages/contracts/`；`packages/testkit/`；`pnpm-lock.yaml`

**产物：** 固定Node与package manager；严格TS配置；lint/typecheck/unit/build基础脚本。

**验收：** 空测试不能通过Full；不修改旧Python门禁以掩盖失败；新命令明确为新入口。

**测试：** C01, E04。**风险：** 中：工具链漂移。

设计依据：[02-target-architecture.md](02-target-architecture.md)。


#### T010｜迁移类型合同、名义ID与运行时校验

**状态：** 未开始　**责任：** 领域工程师　**依赖：** T009, T006

**现有落点：** `src/sciretriever/model/`；`src/sciretriever/agents/api.py`

**目标位置（拟新增/改造）：** `packages/contracts/src/`；`apps/server/src/literature/types/`

**产物：** Zod schema与派生类型；ID/enum/报告/Provider-neutral合同。

**验收：** strict/未知字段与跨字段负例通过；错误不回显secret；内部类型不泄露vendor对象。

**测试：** C01。**风险：** 高：类型看似一致而运行行为不同。

设计依据：[05-ts-migration.md](05-ts-migration.md)。


#### T011｜迁移规范化、序列化、hash和时间算法

**状态：** 未开始　**责任：** 领域工程师　**依赖：** T010, T006

**现有落点：** `src/sciretriever/model/primitives.py`；`src/sciretriever/literature/content.py`；`src/sciretriever/literature/`

**目标位置（拟新增/改造）：** `apps/server/src/literature/canonical/`；`packages/contracts/src/primitives/`

**产物：** 明确Unicode/casefold/identifier算法；canonical encoder；golden差分器。

**验收：** 先原字节相等再hash相等；保留微秒和有序字段；不重算旧数据来迁就实现。

**测试：** C02, S01。**风险：** 阻断：文献身份与旧hash漂移。

设计依据：[05-ts-migration.md](05-ts-migration.md)。


#### T012｜迁移Configuration与Credential Broker

**状态：** 未开始　**责任：** 配置与安全工程师　**依赖：** T010, T007

**现有落点：** `src/sciretriever/configuration/`；`example/config.example.toml`

**目标位置（拟新增/改造）：** `apps/server/src/configuration/`；`tests/fixtures/config/`

**产物：** 当前受支持配置parser；固定home与secret存储；exact-origin grant与显式迁移预览。

**验收：** 从实际parser不是旧example取基线；无隐式旧schema兜底；不向模型/日志输出secret。

**测试：** C08, N02, N07。**风险：** 高：配置丢失与凭据外送。

设计依据：[05-ts-migration.md](05-ts-migration.md)。


#### T013｜迁移HTTP访问边界和共享预算

**状态：** 未开始　**责任：** 网络工程师　**依赖：** T010, T012, T004

**现有落点：** `src/sciretriever/network/`

**目标位置（拟新增/改造）：** `apps/server/src/network/http/`；`apps/server/src/network/policy/`

**产物：** URL/DNS/redirect/credential/limit适配；作用域准入与错误合同。

**验收：** 私网、loopback、IPv6与跨域凭据测试通过；模型本地服务权限不授予browser；重试预算单一所有者。

**测试：** N01, N02, N05, N06。**风险：** 高：新SDK绕过网络策略。

设计依据：[04-acquisition-network.md](04-acquisition-network.md)。


#### T014｜实现TS不可变文件Store和平台锁

**状态：** 未开始　**责任：** 存储工程师　**依赖：** T009, T004, T011

**现有落点：** `src/sciretriever/storage/files/`；`src/sciretriever/storage/locking.py`

**目标位置（拟新增/改造）：** `apps/server/src/storage/files/`；`apps/server/src/storage/platform/`

**产物：** 只读reader/staging/no-clobber发布；平台锁与恢复；必要native适配器预编译接口。

**验收：** 用户文件不动、同名不同内容不覆盖；路径竞态与fsync故障测试；原生缺口不静默降级。

**测试：** S03, S04, S07。**风险：** 阻断：文件安全与持久性。

设计依据：[06-storage-upgrade.md](06-storage-upgrade.md)。


#### T015｜实现DB Worker和精确v1 schema引擎

**状态：** 未开始　**责任：** 数据库工程师　**依赖：** T009, T006, T014

**现有落点：** `src/sciretriever/storage/sqlite/schema.py`；`src/sciretriever/storage/sqlite/engine.py`

**目标位置（拟新增/改造）：** `apps/server/workers/database.ts`；`apps/server/src/storage/sqlite/`

**产物：** v1原始manifest；Worker具名命令；WAL/FULL/FK/读取快照。

**验收：** 旧v1可打开、新v1对象集合一致；没有额外表/忽略指纹；长同步查询不阻塞主服务。

**测试：** S01, S02。**风险：** 阻断：旧库被拒绝或错误接受。

设计依据：[06-storage-upgrade.md](06-storage-upgrade.md)。


#### T016｜迁移全部v1 repositories与原子发布端口

**状态：** 未开始　**责任：** 数据库工程师　**依赖：** T015, T010, T011, T014

**现有落点：** `src/sciretriever/storage/sqlite/`；`src/sciretriever/storage/`

**目标位置（拟新增/改造）：** `apps/server/src/storage/repositories/`；`apps/server/src/storage/unit-of-work/`

**产物：** 文献/引用/资产/Parser/Content/Discovery所有repository；stale检查与FTS投影。

**验收：** 多表结果同一快照；所有写事务差分通过；Storage不作业务身份决定。

**测试：** S01, S02, S03, S07。**风险：** 高：关系与current事实破坏。

设计依据：[06-storage-upgrade.md](06-storage-upgrade.md)。


#### T017｜迁移共享模型运行时与三协议适配

**状态：** 未开始　**责任：** Agent工程师　**依赖：** T010, T012, T013

**现有落点：** `src/sciretriever/agents/`；`src/sciretriever/model/`

**目标位置（拟新增/改造）：** `apps/server/src/agents/`；`tests/fixtures/model-protocols/`

**产物：** 中性请求/结果；SSE/JSON adapter；tool/image/reasoning/usage/取消。

**验收：** 三协议fixture完整；SDK重试与fetch受控；不静默变更模型、stream、reasoning。

**测试：** C05, N02, N07。**风险：** 高：协议与额度语义变化。

设计依据：[05-ts-migration.md](05-ts-migration.md)。


#### T018｜建立单一组装入口、安全日志和服务生命周期

**状态：** 未开始　**责任：** 应用工程师　**依赖：** T009, T012, T013, T015, T017

**现有落点：** `src/sciretriever/bootstrap/`；`src/sciretriever/logging/`；`src/sciretriever/entry/`

**目标位置（拟新增/改造）：** `apps/server/src/bootstrap/`；`apps/server/src/logging/`；`apps/server/src/application/`

**产物：** 统一依赖图与取消scope；stderr安全日志、状态事件；worker启动/关闭协议。

**验收：** 无多重client/双写owner；错误边界脱敏；启动关闭不会遗留隐式服务。

**测试：** N07, E05。**风险：** 中：模块组装不一致。

设计依据：[02-target-architecture.md](02-target-architecture.md)。


### M2｜纯人工可用的浏览器工作区


#### T019｜实现Browser Host与持久Workspace/Profile

**状态：** 未开始　**责任：** 浏览器工程师　**依赖：** T018, T003, T004

**现有落点：** `src/sciretriever/network/cloakbrowser.py`；`src/sciretriever/network/browser_sessions.py`

**目标位置（拟新增/改造）：** `apps/server/workers/browser-host.ts`；`apps/server/src/browser/workspace/`

**产物：** 唯一浏览器对象owner；独占Profile与子进程环境；task lease/page registry。

**验收：** 任务间复用但不同进程不共享写Profile；关闭顺序确定；重启不宣称DOM恢复。

**测试：** B07, B08。**风险：** 高：身份与资源生命周期。

设计依据：[03-browser-workbench.md](03-browser-workbench.md)。


#### T020｜接入原生导航和浏览器出口控制

**状态：** 未开始　**责任：** 网络与浏览器工程师　**依赖：** T019, T013

**现有落点：** `src/sciretriever/network/browser_connect.py`；`src/sciretriever/acquisition/sources/browser.py`

**目标位置（拟新增/改造）：** `apps/server/src/browser/network-adapter/`；`apps/server/src/network/browser-egress/`

**产物：** 默认原生continue路径；连接绑定/redirect护栏；SW初始配置与覆盖测试。

**验收：** 不对所有导航fetch/fulfill；原生响应与下载受控；本地fixture覆盖可能旁路通道。

**测试：** N01, N06, D14。**风险：** 阻断：保真和访问边界冲突。

设计依据：[04-acquisition-network.md](04-acquisition-network.md)。


#### T021｜实现Observation与通用元素引用

**状态：** 未开始　**责任：** 浏览器工程师　**依赖：** T019, T010

**现有落点：** `src/sciretriever/network/browser_control.py`；`src/sciretriever/acquisition/browser_control.py`

**目标位置（拟新增/改造）：** `apps/server/src/browser/observation/`

**产物：** page/document/viewport版本；元素+截图+transfer摘要；bounded partial observation。

**验收：** 动画/长连接不死等；导航错位能发现；不因任意DOM更新全局失效。

**测试：** B05, B06。**风险：** 高：截图与动作绑定错误。

设计依据：[03-browser-workbench.md](03-browser-workbench.md)。


#### T022｜实现通用Action Executor与输入协议

**状态：** 未开始　**责任：** 浏览器工程师　**依赖：** T020, T021, T012

**现有落点：** `src/sciretriever/network/browser_control.py`；`src/sciretriever/acquisition/browser_control.py`

**目标位置（拟新增/改造）：** `apps/server/src/browser/actions/`；`packages/contracts/src/browser/`

**产物：** navigate/click/hover/fill/press/select/scroll/tab动作；操作回执与request去重。

**验收：** 只有一个执行入口；目标失效返回而不偷换策略；没有任意JS/CDP/Shell/文件路径接口。

**测试：** B03, B05, B09, N04。**风险：** 高：动作权限与通用性。

设计依据：[09-contracts-adr.md](09-contracts-adr.md)。


#### T023｜实现native/response Collector基础与spool

**状态：** 未开始　**责任：** 获取工程师　**依赖：** T019, T020, T014

**现有落点：** `src/sciretriever/acquisition/sources/browser.py`；`src/sciretriever/network/playwright.py`

**目标位置（拟新增/改造）：** `apps/server/src/browser/collector/`；`apps/server/src/storage/spool/`

**产物：** 先监听后动作；native/response完整落盘；候选ID/hash及事件关联。

**验收：** download-start不算完成；慢文件不随截图/Agent关闭；同名/同hash处理正确。

**测试：** D01, D02, D06, D08, D13。**风险：** 阻断：已下载文件丢失。

设计依据：[04-acquisition-network.md](04-acquisition-network.md)。


#### T024｜实现screencast和有界画面分发

**状态：** 未开始　**责任：** 实时通信工程师　**依赖：** T019, T003, T018

**现有落点：** `src/sciretriever/network/cloakbrowser.py`

**目标位置（拟新增/改造）：** `apps/server/src/browser/screen/`；`apps/server/src/entry/websocket/`

**产物：** JPEG二进制帧协议；page/viewport元信息；有界订阅与背压；最小loopback HTTP/WS认证入口，M5再扩展持久任务API。

**验收：** 慢客户端丢旧帧不阻塞任务；无观看者不持续编码；只有授权连接能看画面。

**测试：** B01, B02, B08, N03。**风险：** 中：实时流影响任务。

设计依据：[03-browser-workbench.md](03-browser-workbench.md)。


#### T025｜实现工作台页面、标签页与坐标/IME输入

**状态：** 未开始　**责任：** 前端工程师　**依赖：** T024, T022, T009

**现有落点：** `docs/architecture/requirements.md`

**目标位置（拟新增/改造）：** `apps/web/src/workspace/`；`packages/contracts/src/browser/`

**产物：** 同一浏览器画面；标签页和地址导航UI；缩放/留白/键盘/IME。

**验收：** 不嵌入远端HTML作为伪浏览器；点击映射CSS坐标正确；前端不持有内部浏览器句柄。

**测试：** B01, B03, B06, B09。**风险：** 中：看得到但无法正确操作。

设计依据：[03-browser-workbench.md](03-browser-workbench.md)。


#### T026｜实现服务端控制lease与AI/人工交接

**状态：** 未开始　**责任：** 浏览器与应用工程师　**依赖：** T022, T025, T018

**现有落点：** `src/sciretriever/acquisition/browser_control.py`

**目标位置（拟新增/改造）：** `apps/server/src/browser/control-lease/`；`apps/web/src/workspace/control/`

**产物：** bootId/controlEpoch与交接状态机；迟到动作fencing；断线释放输入策略。

**验收：** 人工开放前派发通道静默；旧模型输出不执行；下载在交接中继续。

**测试：** B04, B07, D13。**风险：** 阻断：双重输入竞态。

设计依据：[03-browser-workbench.md](03-browser-workbench.md)。


#### T027｜完成blob/frame/popup/viewer/Range捕获适配

**状态：** 未开始　**责任：** 获取工程师　**依赖：** T023, T021

**现有落点：** `src/sciretriever/acquisition/sources/browser.py`；`src/sciretriever/network/`

**目标位置（拟新增/改造）：** `apps/server/src/browser/collector/adapters/`；`tests/fixtures/browser/`

**产物：** 复杂文件交付fixture；归属关联；不支持机制的明确失败。

**验收：** 分片不作为完整PDF；popup首事件不漏；无外部blob请求或全页重写。

**测试：** D03, D04, D05, D07, D14, B06。**风险：** 高：呈现多样性。

设计依据：[04-acquisition-network.md](04-acquisition-network.md)。


#### T028｜通过纯人工工作区端到端基线

**状态：** 未开始　**责任：** 测试工程师　**依赖：** T020, T021, T023, T024, T025, T026, T027

**现有落点：** `tests/test_network_browser.py`；`tests/test_acquisition_pdf_identity.py`

**目标位置（拟新增/改造）：** `tests/integration/workspace/`；`migration/evidence/m2/`

**产物：** 一个端口的人机工作区录验；全部捕获fixture报告；生命周期故障清单。

**验收：** Agent未介入时可稳定下载交接；连接断开不丢文件；剩余机制限制清楚且未伪装成功。

**测试：** B01, B02, B03, B04, D01, D13, E05。**风险：** 阶段门：人控基础不可靠不得优化AI。

设计依据：[08-tests-release.md](08-tests-release.md)。


### M3｜自动获取闭环


#### T029｜实现冻结策略与无人打扰处置

**状态：** 未开始　**责任：** 应用与Agent工程师　**依赖：** T012, T010, T002

**现有落点：** `src/sciretriever/acquisition/browser_control.py`；`src/sciretriever/configuration/`；`src/sciretriever/model/report.py`

**目标位置（拟新增/改造）：** `apps/server/src/application/policy/`；`packages/contracts/src/policy/`

**产物：** 规范策略与hash；never/notify/pause处置器；预算与资源授权接口。

**验收：** 无权限/不购买按设置处置不重复问人；AI不能扩权；跳过不伪造未订阅事实。

**测试：** E01, E02, N04, N05。**风险：** 高：以人工兜底代替自动化。

设计依据：[09-contracts-adr.md](09-contracts-adr.md)。


#### T030｜接入Agent观察—动作循环与预算

**状态：** 未开始　**责任：** Agent工程师　**依赖：** T017, T021, T022, T026, T029

**现有落点：** `src/sciretriever/acquisition/browser_control.py`；`src/sciretriever/agents/`

**目标位置（拟新增/改造）：** `apps/server/src/acquisition/browser-agent/`

**产物：** 通用tool controller；图像披露控制；finish/defer/skip/assistance提案。

**验收：** 读取transfer状态而不盲目重复点击；失效动作重新观察；迟到LLM和无人工模式均通过。

**测试：** C05, B04, B05, E01, N04, N07。**风险：** 高：Agent决定与底层事实混淆。

设计依据：[03-browser-workbench.md](03-browser-workbench.md)。


#### T031｜实现受限PDF结构检查进程

**状态：** 未开始　**责任：** PDF工程师　**依赖：** T005, T014, T018

**现有落点：** `src/sciretriever/acquisition/rules.py`；`src/sciretriever/storage/pdf_validation_staging.py`

**目标位置（拟新增/改造）：** `apps/server/workers/pdf-inspection.ts`；`apps/server/src/acquisition/pdf/`

**产物：** 格式/页树/资源限制检查；可终止执行与安全提取结果。

**验收：** 无Python运行依赖；压缩/损坏/加密错误可控；不执行PDF脚本或外部网络。

**测试：** D12, N06。**风险：** 高：解析器差异及恶意PDF。

设计依据：[04-acquisition-network.md](04-acquisition-network.md)。


#### T032｜实现三态文章身份与独立版本验收

**状态：** 未开始　**责任：** 领域与PDF工程师　**依赖：** T031, T011, T010

**现有落点：** `src/sciretriever/acquisition/pdf_identity.py`；`tests/test_acquisition_pdf_identity.py`

**目标位置（拟新增/改造）：** `apps/server/src/acquisition/identity/`；`tests/fixtures/pdf/`

**产物：** 来源分层证据；MATCH/MISMATCH/UNCERTAIN；主文/引用/补充/版本回归。

**验收：** 修复正文supplement误拒；引用目标DOI不误收；不确定不直接入库或强制叫人。

**测试：** D09, D10, D11。**风险：** 阻断：错误PDF被判成功。

设计依据：[04-acquisition-network.md](04-acquisition-network.md)。


#### T033｜接通候选验收、主资产发布和交接receipt

**状态：** 未开始　**责任：** 获取与存储工程师　**依赖：** T023, T027, T032, T016, T038

**现有落点：** `src/sciretriever/acquisition/publication.py`；`src/sciretriever/acquisition/ports.py`；`src/sciretriever/storage/`

**目标位置（拟新增/改造）：** `apps/server/src/acquisition/publication/`；`apps/server/src/application/receipts/`

**产物：** 文件→验收→primary-pdf原子业务提交；候选去重与清理确认。

**验收：** 只有提交后成功；stale事实拒绝但不丢候选；重复事件不重复发布。

**测试：** D08, D13, S03, S06。**风险：** 阻断：跨模块文件交接。

设计依据：[06-storage-upgrade.md](06-storage-upgrade.md)。


#### T034｜实现分层诊断、冷却与有限恢复

**状态：** 未开始　**责任：** 运行时工程师　**依赖：** T013, T023, T029, T030

**现有落点：** `src/sciretriever/acquisition/outcomes.py`；`src/sciretriever/network/`；`src/sciretriever/logging/`

**目标位置（拟新增/改造）：** `apps/server/src/application/outcomes/`；`apps/server/src/network/cooldown/`

**产物：** 阶段化reason+outcome；站点级冷却和预算；传输/观察/模型取消scope。

**验收：** 403与本地拒绝可区分但不编造根因；页面超时不终止下载；任务失败不取消独立任务。

**测试：** N05, D13, E01。**风险：** 高：错误归因和重复撞站。

设计依据：[04-acquisition-network.md](04-acquisition-network.md)。


#### T035｜实现统一分层Acquisition编排与来源端口

**状态：** 未开始　**责任：** 获取工程师　**依赖：** T029, T033, T034

**现有落点：** `src/sciretriever/acquisition/tiered_service.py`；`src/sciretriever/acquisition/planning.py`；`src/sciretriever/acquisition/routes.py`

**目标位置（拟新增/改造）：** `apps/server/src/acquisition/planning/`；`apps/server/src/acquisition/routes/`

**产物：** public/API/browser通用结果合同；版本偏好与耗尽/失败区分。

**验收：** 不恢复publisher点击脚本；API与浏览器都走相同发布门；policy skip不建立错误永久耗尽事实。

**测试：** C06, D11, E01。**风险：** 高：来源与业务处置耦合。

设计依据：[04-acquisition-network.md](04-acquisition-network.md)。


#### T036｜验证自动浏览器获取完整闭环

**状态：** 未开始　**责任：** 测试工程师　**依赖：** T028, T030, T031, T032, T033, T034, T035

**现有落点：** `tests/test_network_browser.py`；`tests/test_acquisition_pdf_identity.py`

**目标位置（拟新增/改造）：** `tests/integration/acquisition/`；`migration/evidence/m3/`

**产物：** 混合成功/拒绝/慢下载/错文批次fixture；无人打扰与人工接管报告。

**验收：** 技术异常不能全转换成叫用户；成功都有文件与身份提交证据；已知错误行为列入intentional-change ledger。

**测试：** D01, D03, D09, D10, D13, E01, E02。**风险：** 阶段门：完整自动任务而非单次点击。

设计依据：[08-tests-release.md](08-tests-release.md)。


### M4｜其余业务能力全量迁移


#### T037｜迁移全部Metadata Provider与分页引用协议

**状态：** 未开始　**责任：** Metadata工程师　**依赖：** T010, T011, T012, T013, T018

**现有落点：** `src/sciretriever/metadata/`；`docs/development/provider-integration.md`

**目标位置（拟新增/改造）：** `apps/server/src/metadata/`；`tests/fixtures/providers/`

**产物：** 实际盘点中全部adapter；Auto/Custom selection；search/lookup/citations中性转换。

**验收：** 逐source raw limit与分页终止正确；provider record ID不冒充identifier；未支持能力如实标注。

**测试：** C06, N02。**风险：** 高：只迁常用来源却遗漏其余。

设计依据：[05-ts-migration.md](05-ts-migration.md)。


#### T038｜迁移Literature身份、版本、引用与current-facts业务

**状态：** 未开始　**责任：** 领域工程师　**依赖：** T010, T011, T016

**现有落点：** `src/sciretriever/literature/`；`src/sciretriever/model/literature.py`

**目标位置（拟新增/改造）：** `apps/server/src/literature/`

**产物：** 身份接纳/冲突/合并；版本关系；引用support与三级状态规则。

**验收：** 与旧稳定行为差分一致；来源observation不丢；新政策版本选择不破坏具体Literature身份。

**测试：** C02, S01, S07。**风险：** 阻断：数据身份语义漂移。

设计依据：[05-ts-migration.md](05-ts-migration.md)。


#### T039｜迁移公开与授权PDF Source适配器全集

**状态：** 未开始　**责任：** 获取工程师　**依赖：** T010, T012, T013, T016, T031

**现有落点：** `src/sciretriever/acquisition/sources/`；`src/sciretriever/acquisition/providers/`；`src/sciretriever/acquisition/authorized.py`

**目标位置（拟新增/改造）：** `apps/server/src/acquisition/sources/`；`apps/server/src/acquisition/providers/`

**产物：** 所有当前public/direct/API adapter；readiness/凭据/元信息转换fixture。

**验收：** 没有秘密启用非默认来源；来源不自判文章成功；每个旧adapter有对应实现或批准退役。

**测试：** C06, N02, D02。**风险：** 高：来源能力静默丢失。

设计依据：[05-ts-migration.md](05-ts-migration.md)。


#### T040｜迁移Discovery、书目编解码与Import编排

**状态：** 未开始　**责任：** 文献应用工程师　**依赖：** T037, T038, T016, T018

**现有落点：** `src/sciretriever/entry/`；`src/sciretriever/metadata/`；`src/sciretriever/literature/`

**目标位置（拟新增/改造）：** `apps/server/src/application/discovery/`；`apps/server/src/entry/codecs/`；`apps/server/src/application/import/`

**产物：** topic/citation DiscoveryRun；六类selector；BibTeX/BibLaTeX/RIS/CSL-JSON。

**验收：** 多来源部分失败保持已提交事实；导入created/enriched/matched/rejected语义；用户原文件只读。

**测试：** C03, C04, C06。**风险：** 高：导入身份或分页结果变化。

设计依据：[05-ts-migration.md](05-ts-migration.md)。


#### T041｜迁移MinerU客户端与解析产物交接

**状态：** 未开始　**责任：** 解析工程师　**依赖：** T010, T012, T013, T014, T016

**现有落点：** `src/sciretriever/parsing/`；`docs/architecture/technical/parsing.md`

**目标位置（拟新增/改造）：** `apps/server/src/parsing/`

**产物：** 当前协议TS client；上传授权与资源安全；current ParserResult发布。

**验收：** 不捆绑或调用本地Python实现；remote上传授权独立；旧结果在失败时保留。

**测试：** C07, N02, S07。**风险：** 高：把语言迁移误当Parser重写。

设计依据：[05-ts-migration.md](05-ts-migration.md)。


#### T042｜迁移两阶段Analysis和内容接纳

**状态：** 未开始　**责任：** 分析工程师　**依赖：** T017, T038, T041, T016

**现有落点：** `src/sciretriever/analysis/`；`src/sciretriever/literature/content.py`；`src/sciretriever/model/analysis.py`

**目标位置（拟新增/改造）：** `apps/server/src/analysis/`

**产物：** 元数据/正文分析和引用提取；固定渲染与provenance；NoUsableContent路径。

**验收：** 同输入schema/hash/输出格式可比；阶段失败不撤销有效原始数据；不是直接把模型文本当current content。

**测试：** C02, C05, C07, S07。**风险：** 高：分析结果来源与当前关系损坏。

设计依据：[05-ts-migration.md](05-ts-migration.md)。


#### T043｜迁移查询、详情、引用与原子导出

**状态：** 未开始　**责任：** 文献应用工程师　**依赖：** T038, T016, T014, T040

**现有落点：** `src/sciretriever/literature/`；`src/sciretriever/entry/`

**目标位置（拟新增/改造）：** `apps/server/src/application/library/`；`apps/server/src/application/export/`

**产物：** FTS/search/detail/reference读取；metadata/pdf/content导出。

**验收：** 本地查询无网络副作用；快照一致；默认不覆盖、显式覆盖仍原子。

**测试：** C03, C04, S02, S07。**风险：** 中：查询范围或输出兼容变化。

设计依据：[05-ts-migration.md](05-ts-migration.md)。


#### T044｜完成旧CLI、配置中心与单次TS应用入口

**状态：** 未开始　**责任：** 应用工程师　**依赖：** T018, T035, T039, T040, T041, T042, T043, T012

**现有落点：** `src/sciretriever/entry/cli/`；`src/sciretriever/configuration/`；`README.md`

**目标位置（拟新增/改造）：** `apps/server/src/entry/cli/`；`apps/server/src/application/`

**产物：** discover/complete/literature/import/export/config；JSON与退出语义；交互与非TTY配置。

**验收：** 安装包可全TS完成旧流程；无Python RPC或后台双写；local status不会自动联网探测。

**测试：** C03, C08, E03, E05。**风险：** 高：核心模块有了但用户流程不完整。

设计依据：[05-ts-migration.md](05-ts-migration.md)。


#### T045｜关闭业务全集迁移与差分清单

**状态：** 未开始　**责任：** 迁移与测试负责人　**依赖：** T037, T038, T039, T040, T041, T042, T043, T044

**现有落点：** `migration/inventory.json`；`src/sciretriever/`；`tests/`

**目标位置（拟新增/改造）：** `migration/business-parity-report.json`；`migration/evidence/m4/`

**产物：** 全部module/provider/CLI映射已核对；稳定行为与intentional change分开报告。

**验收：** 每个活动文件有明确处置；不能以测试数近似证明功能完整；所有缺口有阻断或批准退役记录。

**测试：** C01, C02, C03, C04, C05, C06, C07, C08, E07。**风险：** 阶段门：完整迁移范围。

设计依据：[08-tests-release.md](08-tests-release.md)。


### M5｜持久任务与常驻服务


#### T046｜确定v2DDL并实现显式inspect/backup/migrate

**状态：** 未开始　**责任：** 数据库与架构工程师　**依赖：** T008, T015, T016, T038

**现有落点：** `src/sciretriever/storage/sqlite/schema.py`；`src/sciretriever/storage/sqlite/engine.py`；`docs/architecture/technical/storage.md`

**目标位置（拟新增/改造）：** `apps/server/src/storage/migrations/`；`apps/server/src/entry/storage-maintenance/`

**产物：** v2完整manifest与迁移记录；schema_identity CHECK重建；一致备份与dry-run。

**验收：** 不在查询时静默升级；v1原业务数据不变；失败点和重复执行有明确恢复。

**测试：** S01, S05, S08。**风险：** 阻断：真实数据升级。

设计依据：[06-storage-upgrade.md](06-storage-upgrade.md)。


#### T047｜实现持久jobs/targets/attempts/policy与关键事件

**状态：** 未开始　**责任：** 运行时与数据库工程师　**依赖：** T046, T029, T010

**现有落点：** `src/sciretriever/entry/`；`src/sciretriever/model/report.py`

**目标位置（拟新增/改造）：** `apps/server/src/application/jobs/`；`apps/server/src/storage/execution/`

**产物：** 任务冻结与幂等创建；具名运行表repositories；有界事件恢复游标。

**验收：** 不建立第二套文献可用状态；policy版本固定；不存secret/无限页面历史。

**测试：** E01, S06, N07。**风险：** 高：运行事实与业务事实混淆。

设计依据：[06-storage-upgrade.md](06-storage-upgrade.md)。


#### T048｜实现可恢复队列、单workspace串行与多任务调度

**状态：** 未开始　**责任：** 运行时工程师　**依赖：** T047, T034, T044, T019

**现有落点：** `src/sciretriever/entry/`；`src/sciretriever/acquisition/cohort.py`；`src/sciretriever/network/`

**目标位置（拟新增/改造）：** `apps/server/src/application/scheduler/`

**产物：** 任务stage推进/暂停/取消；nextEligibleAt恢复；workspace绑定和后台独立任务并发。

**验收：** 同Profile不多写多控；任务跳过不停止整个队列；重启不清零已用预算形成无限重试。

**测试：** E01, E02, N05, S06。**风险：** 高：恢复导致重复动作和访问放大。

设计依据：[02-target-architecture.md](02-target-architecture.md)。


#### T049｜实现durable Candidate spool、ACK与对账

**状态：** 未开始　**责任：** 获取与存储工程师　**依赖：** T047, T023, T033, T014

**现有落点：** `src/sciretriever/acquisition/publication.py`；`src/sciretriever/storage/`

**目标位置（拟新增/改造）：** `apps/server/src/storage/spool/`；`apps/server/src/application/receipts/`

**产物：** CandidateReady持久记录；交接幂等与GC保护；commit后ACK丢失恢复。

**验收：** 文件落盘先于ready；完成副本不依赖context；候选清理与资产提交均可对账。

**测试：** D13, S03, S06, S07。**风险：** 阻断：服务级文件可靠性。

设计依据：[06-storage-upgrade.md](06-storage-upgrade.md)。


#### T050｜实现策略化协助请求和控制现场恢复

**状态：** 未开始　**责任：** 应用与前端工程师　**依赖：** T047, T026, T029, T048

**现有落点：** `src/sciretriever/acquisition/browser_control.py`

**目标位置（拟新增/改造）：** `apps/server/src/application/interventions/`；`apps/web/src/interventions/`

**产物：** never/notify/pause运行行为；请求截止与处置；人工断线与重新观察。

**验收：** never模式不产生阻塞式人工依赖；租约不作为活对象持久恢复；不把故障统一交给用户。

**测试：** E01, E02, B04, B07。**风险：** 高：人工接管变成常态劳动。

设计依据：[03-browser-workbench.md](03-browser-workbench.md)。


#### T051｜实现崩溃恢复与候选/业务/任务协调

**状态：** 未开始　**责任：** 恢复与测试工程师　**依赖：** T048, T049, T050, T046

**现有落点：** `src/sciretriever/storage/`；`src/sciretriever/entry/`

**目标位置（拟新增/改造）：** `apps/server/src/application/recovery/`；`tests/fault-injection/`

**产物：** 新bootId、旧lease作废；current事实优先恢复；outcome-unknown与不重放动作规则。

**验收：** 已提交文件只补状态不重下；未完整transfer不误判成功；所有关键kill点结果可解释。

**测试：** B07, S03, S05, S06, S07。**风险：** 阻断：重启丢失/重复/错绑。

设计依据：[06-storage-upgrade.md](06-storage-upgrade.md)。


#### T052｜实现认证单端口API、WS和CLI/daemon协调

**状态：** 未开始　**责任：** 服务端工程师　**依赖：** T018, T047, T048, T050, T024, T044

**现有落点：** `src/sciretriever/entry/`；`src/sciretriever/bootstrap/`

**目标位置（拟新增/改造）：** `apps/server/src/entry/http/`；`apps/server/src/entry/websocket/`；`apps/server/src/entry/daemon/`

**产物：** 版本化API；身份/Origin/CSRF/Host校验；单catalog服务发现与CLI认证转发。

**验收：** 不暴露Page/CDP/任意SQL或文件路径；网页退出不停止服务；旧游标过期能全量同步。

**测试：** N03, N04, E05。**风险：** 阻断：控制面可被恶意网页操作。

设计依据：[09-contracts-adr.md](09-contracts-adr.md)。


#### T053｜完成任务、策略、文献和结果工作台

**状态：** 未开始　**责任：** 前端工程师　**依赖：** T052, T025, T043, T050

**现有落点：** `README.md`；`docs/architecture/requirements.md`

**目标位置（拟新增/改造）：** `apps/web/src/tasks/`；`apps/web/src/policies/`；`apps/web/src/library/`

**产物：** 导入/队列/观看/接管/结果完整UI；自然语言政策提案确认；原因与处置展示。

**验收：** 同一端口无需构建工具；不把failed/unknown显示成not-entitled；既有CLI与UI同一业务接口。

**测试：** E01, E02, E03, E05。**风险：** 中：内部能力未形成产品流程。

设计依据：[02-target-architecture.md](02-target-architecture.md)。


#### T054｜通过持久服务端到端与升级恢复演练

**状态：** 未开始　**责任：** 测试负责人　**依赖：** T036, T045, T046, T047, T048, T049, T050, T051, T052, T053

**现有落点：** `tests/`；`migration/`

**目标位置（拟新增/改造）：** `migration/evidence/m5/`；`tests/e2e/service/`

**产物：** 完整任务/接管/断线/重启演练；v1备份升级v2fixture；无Python完整流程报告。

**验收：** 所有成功具有已提交事实；无人工模式可结束整批；恢复不损坏既有文献和资产。

**测试：** E01, E02, E03, E05, S05, S06, S08。**风险：** 阶段门：服务可靠性。

设计依据：[08-tests-release.md](08-tests-release.md)。


### M6｜打包、验收与切换


#### T055｜完成TS Quick/Full与CI替代验收链

**状态：** 未开始　**责任：** 测试与构建工程师　**依赖：** T045, T054

**现有落点：** `HARNESS.md`；`scripts/harness.py`；`.github/workflows/ci.yml`；`tests/`

**目标位置（拟新增/改造）：** `scripts/harness.mjs`；`.github/workflows/ci.yml`；`HARNESS.md`

**产物：** lint/format/types/unit/contracts/browser/data/build/install检查；非零测试与包内容检查。

**验收：** 不以弱化旧安全和行为测试换绿色；真实站点不进默认CI；全部输出能追溯到版本和fixture。

**测试：** E07, C01。**风险：** 高：测试迁移缩水。

设计依据：[08-tests-release.md](08-tests-release.md)。


#### T056｜演练数据备份、迁移、恢复与Profile分离回滚

**状态：** 未开始　**责任：** 数据与发行工程师　**依赖：** T046, T051, T054

**现有落点：** `src/sciretriever/storage/`；`docs/guides/`

**目标位置（拟新增/改造）：** `migration/evidence/rollback/`；`docs/guides/upgrade.md`

**产物：** 同平台副本升级/恢复演练；v2新数据增量保留方案；Profile备份/版本边界。

**验收：** 不复制活动WAL主文件冒充备份；不覆盖唯一数据副本；明确不能自动无损降级的边界。

**测试：** S05, S08, E08。**风险：** 阻断：发布回退风险。

设计依据：[06-storage-upgrade.md](06-storage-upgrade.md)。


#### T057｜制作支持平台的免开发工具安装包

**状态：** 未开始　**责任：** 发行工程师　**依赖：** T009, T003, T004, T005, T054

**现有落点：** `pyproject.toml`；`.github/workflows/ci.yml`；`NOTICE`

**目标位置（拟新增/改造）：** `scripts/package/`；`release/manifests/`；`apps/server/src/entry/doctor/`

**产物：** Node/server/web/native资源打包；浏览器校验与缓存；系统依赖doctor/受支持准备流程。

**验收：** 用户不需Python/Node编译工具/Rust/VNC；浏览器显示依赖如实说明；许可与平台矩阵一致。

**测试：** E04, E08, B08。**风险：** 阻断：npm能跑但最终用户装不上。

设计依据：[08-tests-release.md](08-tests-release.md)。


#### T058｜完成性能、背压与安全专项验证

**状态：** 未开始　**责任：** 性能与安全工程师　**依赖：** T054, T055

**现有落点：** `migration/threat-model.md`；`tests/`

**目标位置（拟新增/改造）：** `migration/evidence/performance/`；`migration/evidence/security/`

**产物：** 事件循环/帧/DB/内存/传输统计；SSRF/控制面/prompt注入/secret专项报告。

**验收：** 用户输入不被大PDF/长SQL阻塞；队列与资源有界；未达到指标先解释和修复，不宣称提升。

**测试：** B02, N01, N02, N03, N04, N06, N07, S02。**风险：** 高：长期运行退化与授权泄露。

设计依据：[08-tests-release.md](08-tests-release.md)。


#### T059｜执行获授权真实站点的单变量对照或记录未执行

**状态：** 未开始　**责任：** 集成测试负责人　**依赖：** T036, T054, T058

**现有落点：** `migration/runtime-matrix.json`；`migration/threat-model.md`

**目标位置（拟新增/改造）：** `migration/evidence/live-browser/`

**产物：** 若获授权：固定目标/环境/分母的人工与Agent对照；若未授权：明确not-run与不可声明的结论。

**验收：** 绝不自动访问真实站点或凭据；不把失败移出分母；未执行时不能声称真实成功率验收通过。

**测试：** E06, N05。**风险：** 外部依赖：可交付软件不等于保证网站放行。

设计依据：[08-tests-release.md](08-tests-release.md)。


#### T060｜同步全部真相源、配置示例与用户迁移文档

**状态：** 未开始　**责任：** 文档与架构负责人　**依赖：** T055, T056, T057, T053

**现有落点：** `AGENTS.md`；`HARNESS.md`；`README.md`；`docs/architecture/`；`docs/guides/`；`example/config.example.toml`

**目标位置（拟新增/改造）：** `AGENTS.md`；`HARNESS.md`；`README.md`；`docs/architecture/`；`docs/guides/`；`example/`

**产物：** 当前实现/目标设计区分；新命令与配置说明；弃用Python API和无VNC部署说明。

**验收：** 不再含已撤销rules配置；全部命令用安装包实际验证；计划不冒充Accepted ADR。

**测试：** C08, E05, E07。**风险：** 中：用户入口文档继续漂移。

设计依据：[05-ts-migration.md](05-ts-migration.md)。


#### T061｜逐项清理Python生产入口与过渡代码

**状态：** 未开始　**责任：** 迁移负责人　**依赖：** T055, T056, T060, T045

**现有落点：** `src/sciretriever/`；`pyproject.toml`；`uv.lock`；`scripts/`；`tests/`；`archive/`

**目标位置（拟新增/改造）：** `migration/retirement-report.json`；`package.json`；`apps/server/`

**产物：** 每活动文件退役记录；Python依赖/脚本/旧对象图清除；历史材料明确不参与运行。

**验收：** 不通过Python子进程兜底；不删尚无替代的有效测试；不修改用户数据或无关工作树。

**测试：** E07, C06。**风险：** 阻断：全TS名义成立实际混合。

设计依据：[05-ts-migration.md](05-ts-migration.md)。


#### T062｜在干净支持环境做安装后全流程回归

**状态：** 未开始　**责任：** 发行测试工程师　**依赖：** T057, T058, T061

**现有落点：** `release/manifests/`；`tests/`

**目标位置（拟新增/改造）：** `migration/evidence/installed-package/`

**产物：** 无开发环境安装记录；导入到导出的完整流程；SSH与本地单端口测试。

**验收：** 未安装Python/编译器仍能完成支持流程；安装包不含secret或用户数据；动态资源与native路径可用。

**测试：** E03, E04, E05, E08。**风险：** 阻断：打包后行为缺失。

设计依据：[08-tests-release.md](08-tests-release.md)。


#### T063｜形成切换/回退操作手册并在副本演练

**状态：** 未开始　**责任：** 发行负责人　**依赖：** T056, T062, T060

**现有落点：** `docs/guides/`；`migration/evidence/`

**目标位置（拟新增/改造）：** `docs/guides/cutover.md`；`migration/evidence/cutover-rehearsal/`

**产物：** 停止旧进程/关闭Profile/备份/迁移/启动/核验顺序；失败恢复分支。

**验收：** 维护锁只允许一个写入者；恢复不覆盖新增关系；真实数据操作留给明确授权的发布流程。

**测试：** S08, E08。**风险：** 高：上线时双写与资料丢失。

设计依据：[08-tests-release.md](08-tests-release.md)。


#### T064｜完成发布就绪审查并交付全TS版本

**状态：** 未开始　**责任：** 项目负责人　**依赖：** T055, T056, T057, T058, T059, T060, T061, T062, T063

**现有落点：** `migration/`；`docs/`；`release/`

**目标位置（拟新增/改造）：** `release/readiness-report.json`；`release/artifacts/`

**产物：** 功能/数据/安全/平台证据总表；已知限制和外部验证状态；最终包与校验manifest。

**验收：** 无未归属活动功能或隐藏Python后门；明确已验证与未验证网站效果；仅经授权发布/切换，不将计划自动当授权。

**测试：** E03, E04, E06, E07, E08。**风险：** 最终门：凭证据交付。

设计依据：[07-roadmap.md](07-roadmap.md)。


## 5. 阻断和完成规则

任务无法满足数据/安全合同就标blocked，附证据和影响任务，不以删除检查或调用旧Python替代。授权真实站点测试T059可以形成明确未执行记录，但不得据此声明外部成功率已通过；本地确定性测试不能用同样理由跳过。

全量迁移完成不是源码扩展名全部改变，而是旧有效能力全部有目标、关键数据等价、改造行为有新验收、发布包无需旧运行时。T064审查这些证据，不能从前置任务标记自动推导生产发布授权。
