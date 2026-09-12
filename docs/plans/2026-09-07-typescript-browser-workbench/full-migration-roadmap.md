# 全量 Python → TypeScript 迁移路线（依据原始 M0–M6 / T001–T064）

本文件恢复并压缩 [`original-bundle`](../../archive/2026-09-07-typescript-browser-workbench-reference/original-bundle/) 的 64 个固定任务，作为当前计划的全量执行路线。原始任务的目标、依赖和验收语义以该目录的 `00`–`11`、`tasks.json` 和 `validation-report.json` 为基础；这里结合已接受架构和当前实现补充状态，不把历史任务表或此前裁剪版当作完成证据。`validation-report.json` 只证明原始计划包的静态文档检查，不证明当前代码迁移或发布完成。

## 目标和边界

- 最终发布包由 TypeScript/Node 运行，不依赖 Python 解释器，也不通过 Python RPC 执行数据库、Agent 或业务流程。
- 迁移期 Python 只作为离线 oracle、golden 生成器和兼容 bridge 的临时 owner；不得与 TS 同时写同一个生产 Catalog、ArtifactStore、配置或 Profile。
- 保留模块化单体、SQLite Catalog、不可变 ArtifactStore 和一个 Application 入口；不引入 Redis、微服务、多 Agent 平台或其它原计划之外的基础设施。
- Browser 首阶段闭环是已完成里程碑，不能替代 Metadata、Acquisition、Discovery、Literature、Parsing、Analysis、CLI 和配置能力的全量迁移。
- 真实 Provider、真实站点、生产数据迁移和发布切换必须有单独授权；没有授权时记录 `not-authorized/not-run`。

## 状态含义

`完成` 只用于原始任务经过当前目标修订后的全部验收已经满足；`部分` 表示有可复用实现或首阶段证据，但尚未覆盖整个原始任务；`待开始` 表示全量任务尚未形成直接证据；`未授权/未运行` 表示不因安全边界擅自执行。

## 阶段退出条件

| 阶段 | 原始退出条件 | 当前判断 |
| --- | --- | --- |
| M0 | 盘点、ADR、spike、威胁模型和实施基线可重现 | 已完成；真实外部验证按授权边界保留 |
| M1 | TS 基础、配置、Network、FileStore、DB Worker、模型协议和 v1 差分通过 | 已完成 |
| M2 | 纯人工 Browser 工作区端到端通过 | 已完成；复杂捕获机制显式 Deferred |
| M3 | Agent 策略、PDF 验收、分层 Acquisition 和自动批次通过 | 已完成；真实站点未授权 |
| M4 | 所有 Provider、业务、解析、分析、查询、导出和 CLI 有证据 | 已完成 |
| M5 | v2、持久任务、恢复、服务 API 和工作台通过 | 已完成 |
| M6 | 安装、性能安全、备份回滚、Python 退役和发布审查通过 | 工程验收完成；Python 历史源码清理和真实切换按授权执行 |

## 原始任务矩阵

### M0｜冻结基线与高风险验证

| ID | 原始任务 | 依赖 | 原始交付与验收摘要 | 原始验收 ID | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| T001 | 冻结仓库、实际入口与逐文件迁移盘点 | — | 当前commit/工作树记录；全部活动文件、公开符号、Provider、CLI、配置与测试映射；旧离线Harness实际结果。验收：不访问用户数据或真实站点；每个活动文件有明确去向，历史目录单独标识；未运行或失败的基线检查如实记录 | C03、C06、E07 | **完成**：`migration/inventory.json` 已记录 242 个活动模块、161 个测试、消费者、task IDs、TS target、直接测试/历史 oracle 原因和 evidence；历史归档排除，Python Harness 仅引用 2026-09-09 历史结果，本次按 owner 决定未重跑。 |
| T002 | 形成新需求和六项ADR草案及变更清单 | T001 | 全TS/工作区/策略/持久任务/v2/原生访问决策；旧合同保留与修改表。验收：明确改变六动作和进程内任务限制；运行状态不替代文献事实；未获批准的决策不标Accepted | E07 | **完成**：ADR 0024 与 `migration/intentional-changes.json` 逐项记录六主题合同差异、保留语义、生产者/消费者影响和已实现/Deferred 状态；原始通用动作草案没有扩大模型权限。 |
| T003 | 验证并固定TS浏览器与投屏依赖组合 | T001 | wrapper/Playwright/Chromium/Node/平台版本矩阵；persistent/download/screencast探针；许可与二进制分发检查。验收：使用真实Chromium本地fixture，不用mock代替；当前1.55限制被显式处理；未验证组合不得标支持 | B08、D01 | **部分（显式边界）**：`migration/runtime-matrix.json` 锁定 Node 22.19.0、Playwright 1.55.0、Cloak 0.5.8/146.0.7680.177.5 和 Linux x64；本次没有 operator bundle，live binary probe 仍 `not-run`，其它平台不声明支持。 |
| T004 | 验证文件原语、单写锁与原生出口安全可实现性 | T001 | 平台锁/no-follow/no-clobber/fsync矩阵；CONNECT与DNS绑定POC；窄native模块或平台限制决策。验收：覆盖路径替换与崩溃释放；说明Node缺失能力而不降低保证；区分隧道预算和逐响应字节预算 | N01、N06、S04 | **完成（Linux 范围）**：`migration/native-capabilities.json` 汇总 no-follow、fsync、no-clobber、路径替换、跨进程锁、DNS pinned CONNECT 和预算分离证据；macOS/Windows/ARM 明确未验证。 |
| T005 | 验证TS PDF结构检查与身份文本提取引擎 | T001 | 候选PDF引擎评估；主文/引用/补充/无文本/加密/大文件fixture。验收：明确文字提取质量与结构校验差异；独立执行可终止；不要求最终用户另装Python或编译工具 | D09、D10、D11、D12 | **部分（当前支持边界）**：`migration/pdf-inspector.json` 固定有界 `pdfinfo`/`pdftotext` 结构与首段身份检查；损坏/非 PDF/超限已有测试，加密、图片型和压缩炸弹样本仍显式 follow-up。 |
| T006 | 导出v1数据库、Model与哈希的离线goldens | T001 | 合成v1库及DDL字节/指纹；Model正负例；canonical字节、查询、关系与资产manifest。验收：不使用用户数据库；固定时钟和ID，不掩盖hash差异；包含Unicode/时间/null/数字边界 | C01、C02、S01 | **完成（合成 oracle）**：`migration/oracle-manifest.json` 固定 v1 fingerprint、canonical encoding、7 类记录 hash、关系/查询/资产覆盖和验证测试；仅使用合成 fixture。 |
| T007 | 冻结威胁模型、性能观察项与平台发行目标 | T001、T003、T004、T005 | 单操作者、控制面、凭据、外部页面威胁模型；可测试平台矩阵；性能测量项与配额语义。验收：单端口仍有认证与Origin/CSRF保护；Linux显示依赖如实列出；无浮动binary或隐式外网测试 | N03、N04、E04 | **部分（开发发行范围）**：`migration/release-matrix.json` 冻结 Linux x64、显示依赖、无外网 CI、性能观察项和配额语义；其它平台和真实站点保持未验证。 |
| T008 | 关闭关键spike并接受实施基线 | T002、T003、T004、T005、T006、T007 | 正式确认的选型与ADR状态；阻塞/不支持组合表；首个能力切片范围。验收：关键能力有结果而不是待调查；未通过spike不得进入生产替换；无需审批的文档与需审批的变更分清 | B08、S04、E07 | **完成（有界基线）**：`migration/m0-decision-record.md` 汇总选型、阻断/不支持组合和首个切片范围；T003/T005/T007 的未验证项均已显式登记，不能被误读为生产支持。 |

### M1｜TS 基础与 v1 兼容

| ID | 原始任务 | 依赖 | 原始交付与验收摘要 | 原始验收 ID | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| T009 | 建立TS工作区、编译与测试骨架 | T008 | 固定Node与package manager；严格TS配置；lint/typecheck/unit/build基础脚本。验收：空测试不能通过Full；不修改旧Python门禁以掩盖失败；新命令明确为新入口 | C01、E04 | 完成：TS workspace、Quick/Full 脚本和严格构建已存在。 |
| T010 | 迁移类型合同、名义ID与运行时校验 | T009、T006 | Zod schema与派生类型；ID/enum/报告/Provider-neutral合同。验收：strict/未知字段与跨字段负例通过；错误不回显secret；内部类型不泄露vendor对象 | C01 | **完成（当前业务合同）**：contracts 与 server 已覆盖 Workbench、Literature、Metadata、Acquisition、Parser、Analysis、Jobs 的 strict schema、名义 ID、未知字段和跨字段负例；错误边界不回显 secret。 |
| T011 | 迁移规范化、序列化、hash和时间算法 | T010、T006 | 明确Unicode/casefold/identifier算法；canonical encoder；golden差分器。验收：先原字节相等再hash相等；保留微秒和有序字段；不重算旧数据来迁就实现 | C02、S01 | **完成（合成 oracle）**：canonical encoder、Unicode/casefold、微秒时间、有序字段和 v1 oracle bytes/hash 已由 contracts/SQLite 测试及 `migration/oracle-manifest.json` 固定。 |
| T012 | 迁移Configuration与Credential Broker | T010、T007 | 当前受支持配置parser；固定home与secret存储；exact-origin grant与显式迁移预览。验收：从实际parser不是旧example取基线；无隐式旧schema兜底；不向模型/日志输出secret | C08、N02、N07 | **完成**：TypeScript Configuration/Credential owner 提供实际 parser、read/validate/diff/publish/status、model/source/MinerU set/keep/remove、exact-origin grant、TUI/非TTY 入口和原子发布；Python bridge 仅历史材料。 |
| T013 | 迁移HTTP访问边界和共享预算 | T010、T012、T004 | URL/DNS/redirect/credential/limit适配；作用域准入与错误合同。验收：私网、loopback、IPv6与跨域凭据测试通过；模型本地服务权限不授予browser；重试预算单一所有者 | N01、N02、N05、N06 | **完成（当前支持边界）**：URL/DNS/IP、redirect、credential origin、loopback、取消、body/response limits、共享预算和失败分类均有 TS 测试；真实外部端点和其它平台未授权。 |
| T014 | 实现TS不可变文件Store和平台锁 | T009、T004、T011 | 只读reader/staging/no-clobber发布；平台锁与恢复；必要native适配器预编译接口。验收：用户文件不动、同名不同内容不覆盖；路径竞态与fsync故障测试；原生缺口不静默降级 | S03、S04、S07 | **完成（Linux 支持边界）**：FileStore、reader、staging、hash、create-if-absent、路径替换/链接拒绝、fsync 和跨进程锁均有证据；非 Linux 平台明确未声明支持。 |
| T015 | 实现DB Worker和精确v1 schema引擎 | T009、T006、T014 | v1原始manifest；Worker具名命令；WAL/FULL/FK/读取快照。验收：旧v1可打开、新v1对象集合一致；没有额外表/忽略指纹；长同步查询不阻塞主服务 | S01、S02 | **完成**：Node `node:sqlite` Worker、v1 fingerprint/manifest、WAL/FULL/FK、具名命令、快照和显式 execution schema 均已由 SQLite/执行旅程测试覆盖。 |
| T016 | 迁移全部v1 repositories与原子发布端口 | T015、T010、T011、T014 | 文献/引用/资产/Parser/Content/Discovery所有repository；stale检查与FTS投影。验收：多表结果同一快照；所有写事务差分通过；Storage不作业务身份决定 | S01、S02、S03、S07 | **完成**：Literature、Observation、Reference、Asset、Parser、Content、Candidate/receipt、Discovery 和 FTS 查询/原子发布均落到 TS repositories；Storage 不作身份决定。 |
| T017 | 迁移共享模型运行时与三协议适配 | T010、T012、T013 | 中性请求/结果；SSE/JSON adapter；tool/image/reasoning/usage/取消。验收：三协议fixture完整；SDK重试与fetch受控；不静默变更模型、stream、reasoning | C05、N02、N07 | **完成（离线协议边界）**：OpenAI Chat/Responses、Anthropic Messages adapter、JSON/SSE、tool/image/reasoning/usage、取消和 transport budget 均有 fixture；真实 LLM 未授权。 |
| T018 | 建立单一组装入口、安全日志和服务生命周期 | T009、T012、T013、T015、T017 | 统一依赖图与取消scope；stderr安全日志、状态事件；worker启动/关闭协议。验收：无多重client/双写owner；错误边界脱敏；启动关闭不会遗留隐式服务 | N07、E05 | **完成**：Application 统一组装配置、Network、Agents、DB/FileStore、Metadata/Acquisition、Parser/Analysis、Jobs 和 Workbench，关闭/取消/日志脱敏直接测试通过。 |

### M2｜人工 Browser 工作区

| ID | 原始任务 | 依赖 | 原始交付与验收摘要 | 原始验收 ID | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| T019 | 实现Browser Host与持久Workspace/Profile | T018、T003、T004 | 唯一浏览器对象owner；独占Profile与子进程环境；task lease/page registry。验收：任务间复用但不同进程不共享写Profile；关闭顺序确定；重启不宣称DOM恢复 | B07、B08 | **部分（受支持生命周期已闭合）**：单 Host/Profile、独占文件锁、`boot_id`、多标签页 registry、opener 归属、关闭/重开和 page close 已验；宿主 SIGKILL 后的跨进程 Browser 重建仍 Deferred，恢复只对 durable facts 生效。 |
| T020 | 接入原生导航和浏览器出口控制 | T019、T013 | 默认原生continue路径；连接绑定/redirect护栏；SW初始配置与覆盖测试。验收：不对所有导航fetch/fulfill；原生响应与下载受控；本地fixture覆盖可能旁路通道 | N01、N06、D14 | **完成（安全支持边界）**：原生导航、DNS/redirect/出口准入、WebSocket/WebTransport 拒绝和 `serviceWorkers: "block"` 均固定并有测试/诊断；SW/cache 旁路不作为支持能力，复杂跨版本行为保持 Deferred。 |
| T021 | 实现Observation与通用元素引用 | T019、T010 | page/document/viewport版本；元素+截图+transfer摘要；bounded partial observation。验收：动画/长连接不死等；导航错位能发现；不因任意DOM更新全局失效 | B05、B06 | 完成：Observation、页面代次和有界摘要已有证据。 |
| T022 | 实现通用Action Executor与输入协议 | T020、T021、T012 | navigate/click/hover/fill/press/select/scroll/tab动作；操作回执与request去重。验收：只有一个执行入口；目标失效返回而不偷换策略；没有任意JS/CDP/Shell/文件路径接口 | B03、B05、B09、N04 | 完成（按 Accepted ADR 0023 当前化）：六种封闭 Agent 动作、操作回执与独立人工输入已有证据。 |
| T023 | 实现native/response Collector基础与spool | T019、T020、T014 | 先监听后动作；native/response完整落盘；候选ID/hash及事件关联。验收：download-start不算完成；慢文件不随截图/Agent关闭；同名/同hash处理正确 | D01、D02、D06、D08、D13 | 完成：native/response Candidate spool 已验；复杂捕获由 T027 继续。 |
| T024 | 实现screencast和有界画面分发 | T019、T003、T018 | JPEG二进制帧协议；page/viewport元信息；有界订阅与背压；最小loopback HTTP/WS认证入口；M5再扩展持久任务API。验收：慢客户端丢旧帧不阻塞任务；无观看者不持续编码；只有授权连接能看画面 | B01、B02、B08、N03 | 完成（按当前传输实现）：鉴权 HTTP + JPEG/SSE、最新帧和背压边界已验；持久任务 API 属于 T052。 |
| T025 | 实现工作台页面、标签页与坐标/IME输入 | T024、T022、T009 | 同一浏览器画面；标签页和地址导航UI；缩放/留白/键盘/IME。验收：不嵌入远端HTML作为伪浏览器；点击映射CSS坐标正确；前端不持有内部浏览器句柄 | B01、B03、B06、B09 | **部分（页面和标签能力已闭合）**：桌面/390px 工作台、地址显示、受控标签列举/激活、CSS 坐标映射和独立人工输入已实现；完整跨平台 IME/系统键盘矩阵仍未声明支持。 |
| T026 | 实现服务端控制lease与AI/人工交接 | T022、T025、T018 | bootId/controlEpoch与交接状态机；迟到动作fencing；断线释放输入策略。验收：人工开放前派发通道静默；旧模型输出不执行；下载在交接中继续 | B04、B07、D13 | 完成：control epoch、接管/释放和迟到动作拒绝已有证据。 |
| T027 | 完成blob/frame/popup/viewer/Range捕获适配 | T023、T021 | 复杂文件交付fixture；归属关联；不支持机制的明确失败。验收：分片不作为完整PDF；popup首事件不漏；无外部blob请求或全页重写 | D03、D04、D05、D07、D14、B06 | 部分：blob/data/frame/popup 已有同源归属、Network admission 和首下载回归；Range 明确失败，复杂 viewer 保持 Deferred，跨版本 Range 重组不承诺。 |
| T028 | 通过纯人工工作区端到端基线 | T020、T021、T023、T024、T025、T026、T027 | 一个端口的人机工作区录验；全部捕获fixture报告；生命周期故障清单。验收：Agent未介入时可稳定下载交接；连接断开不丢文件；剩余机制限制清楚且未伪装成功 | B01、B02、B03、B04、D01、D13、E05 | 完成当前受支持边界：普通 response/download、blob/data、frame、popup 和 Range 不误收均有 loopback fixture；复杂 viewer/跨版本 Range 仍显式 Deferred，生命周期报告已在 Browser/Candidate 旅程保留。 |

### M3｜自动获取闭环

| ID | 原始任务 | 依赖 | 原始交付与验收摘要 | 原始验收 ID | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| T029 | 实现冻结策略与无人打扰处置 | T012、T010、T002 | 规范策略与hash；never/notify/pause处置器；预算与资源授权接口。验收：无权限/不购买按设置处置不重复问人；AI不能扩权；跳过不伪造未订阅事实 | E01、E02、N04、N05 | **完成（离线支持边界）**：ExecutionPolicy/InterventionService 与 `TieredAcquisitionService` 冻结预算和 assistance 语义；never/notify/pause、AI 无扩权和跳过不伪造事实由 `execution-policy.test.ts`、`execution-recovery.test.ts`、`tiered-acquisition.test.ts` 覆盖。 |
| T030 | 接入Agent观察—动作循环与预算 | T017、T021、T022、T026、T029 | 通用tool controller；图像披露控制；finish/defer/skip/assistance提案。验收：读取transfer状态而不盲目重复点击；失效动作重新观察；迟到LLM和无人工模式均通过 | C05、B04、B05、E01、N04、N07 | **完成（离线模型边界）**：AgentRuntime 绑定当前 Observation/JPEG/输入 hash，模型仅可提交六种封闭动作；迟到 epoch、无人工策略、transfer 状态和取消由 Agent/Browser/Queue 测试覆盖。真实 LLM 保持未授权。 |
| T031 | 实现受限PDF结构检查进程 | T005、T014、T018 | 格式/页树/资源限制检查；可终止执行与安全提取结果。验收：无Python运行依赖；压缩/损坏/加密错误可控；不执行PDF脚本或外部网络 | D12、N06 | **部分（当前 Linux 支持边界）**：受限 `pdfinfo`/`pdftotext`、加密 trailer 拒绝、空文本身份不确定、损坏/超限/取消均有 fixture；压缩炸弹和其它平台 reader 行为仍不纳入支持声明。 |
| T032 | 实现三态文章身份与独立版本验收 | T031、T011、T010 | 来源分层证据；MATCH/MISMATCH/UNCERTAIN；主文/引用/补充/版本回归。验收：修复正文supplement误拒；引用目标DOI不误收；不确定不直接入库或强制叫人 | D09、D10、D11 | 完成：三态 identity/version verdict 和证据保留已有。 |
| T033 | 接通候选验收、主资产发布和交接receipt | T023、T027、T032、T016、T038 | 文件→验收→primary-pdf原子业务提交；候选去重与清理确认。验收：只有提交后成功；stale事实拒绝但不丢候选；重复事件不重复发布 | D08、D13、S03、S06 | **完成（受支持捕获边界）**：Candidate→primary asset→receipt 已覆盖 response/download/blob/data/frame/popup、identity 三态、stale 保留、重复事件幂等和 restart reconcile；复杂 viewer/Range 仍由 T027 显式 Deferred。 |
| T034 | 实现分层诊断、冷却与有限恢复 | T013、T023、T029、T030 | 阶段化reason+outcome；站点级冷却和预算；传输/观察/模型取消scope。验收：403与本地拒绝可区分但不编造根因；页面超时不终止下载；任务失败不取消独立任务 | N05、D13、E01 | **完成（离线边界）**：`TieredAcquisitionService` 提供有界 source cooldown、discovery/download 分层失败、取消和 assistance 处置；Browser transfer/Queue 保持传输与页面/任务取消隔离。证据见 [`tiered-acquisition-batch.md`](../../../migration/evidence/runtime/tiered-acquisition-batch.md)。 |
| T035 | 实现统一分层Acquisition编排与来源端口 | T029、T033、T034 | public/API/browser通用结果合同；版本偏好与耗尽/失败区分。验收：不恢复publisher点击脚本；API与浏览器都走相同发布门；policy skip不建立错误永久耗尽事实 | C06、D11、E01 | **完成（离线来源端口）**：PublicAcquisitionRegistry 与 TieredAcquisitionService 统一 direct/public/API/browser 候选合同、顺序、失败/耗尽和 skip 语义；所有成功候选仍进入共享 Candidate/PDF/identity 发布门。 |
| T036 | 验证自动浏览器获取完整闭环 | T028、T030、T031、T032、T033、T034、T035 | 混合成功/拒绝/慢下载/错文批次fixture；无人打扰与人工接管报告。验收：技术异常不能全转换成叫用户；成功都有文件与身份提交证据；已知错误行为列入intentional-change ledger | D01、D03、D09、D10、D13、E01、E02 | **部分（离线闭环已覆盖）**：`tiered-acquisition.test.ts` 覆盖混合成功/耗尽/来源错误、never/notify/pause 和取消；Browser Candidate 旅程覆盖身份提交，慢流取消、错文不确定和复杂捕获负例已有直接测试。真实 Browser 自动批次与真实站点仍受 T027/T059 授权/边界限制。 |

### M4｜其余业务能力全量迁移

| ID | 原始任务 | 依赖 | 原始交付与验收摘要 | 原始验收 ID | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| T037 | 迁移全部Metadata Provider与分页引用协议 | T010、T011、T012、T013、T018 | 实际盘点中全部adapter；Auto/Custom selection；search/lookup/citations中性转换。验收：逐source raw limit与分页终止正确；provider record ID不冒充identifier；未支持能力如实标注 | C06、N02 | **完成**：11 个 Python 基线 Provider 均有 TS adapter、实际 capability、离线协议/分页/标识/引用测试和唯一 Application Network 组装；Auto/Custom、逐来源 raw limit、readiness、credential header/query 与未支持能力均显式。证据见 [`metadata-provider-matrix.md`](../../../migration/evidence/runtime/metadata-provider-matrix.md)。 |
| T038 | 迁移Literature身份、版本、引用与current-facts业务 | T010、T011、T016 | 身份接纳/冲突/合并；版本关系；引用support与三级状态规则。验收：与旧稳定行为差分一致；来源observation不丢；新政策版本选择不破坏具体Literature身份 | C02、S01、S07 | **完成**：严格 stable/fallback identity、Provider record ownership、user replay、metadata projection、显式 version link、既有 MetaLiterature 原子合并、CAS 回滚、CONTENT_READY 保留、三级状态和三类 Reference support 已由 TS 生产对象图与离线测试覆盖。证据见 [`literature-identity-publication.md`](../../../migration/evidence/runtime/literature-identity-publication.md)。 |
| T039 | 迁移公开与授权PDF Source适配器全集 | T010、T012、T013、T016、T031 | 所有当前public/direct/API adapter；readiness/凭据/元信息转换fixture。验收：没有秘密启用非默认来源；来源不自判文章成功；每个旧adapter有对应实现或批准退役 | C06、N02、D02 | **完成**：7 个 Python 基线 Source 与 CORE/Elsevier/Wiley 授权 Provider 均有 TS adapter；Auto/Custom、readiness、publisher evidence、landing/Elsevier object、凭据、取消、字节限制和真实 provenance 已由离线 fixture 覆盖，public/API/Browser 统一进入 durable Candidate、identity/CAS 和 create-if-absent 发布门。证据见 [`acquisition-source-matrix.md`](../../../migration/evidence/runtime/acquisition-source-matrix.md)。 |
| T040 | 迁移Discovery、书目编解码与Import编排 | T037、T038、T016、T018 | topic/citation DiscoveryRun；六类selector；BibTeX/BibLaTeX/RIS/CSL-JSON。验收：多来源部分失败保持已提交事实；导入created/enriched/matched/rejected语义；用户原文件只读 | C03、C04、C06 | **完成**：topic/citation run、逐 run Provider raw limit、部分失败事实保留、六类无截断 selector、四格式逐记录 codec/往返、identity 四种导入结果和 CLI 原文件只读均有离线生产路径证据。原子导出和持久任务分别按原始归属留在 T043、T047–T048。证据见 [`discovery-import-typescript.md`](../../../migration/evidence/runtime/discovery-import-typescript.md)。 |
| T041 | 迁移MinerU客户端与解析产物交接 | T010、T012、T013、T014、T016 | 当前协议TS client；上传授权与资源安全；current ParserResult发布。验收：不捆绑或调用本地Python实现；remote上传授权独立；旧结果在失败时保留 | C07、N02、S07 | **完成**：loopback/remote client、协议与 multipart、primary JSON、ZIP/CRC/路径/碰撞/大小、Unicode 资源闭包、ParserResult hash/current CAS 均由 TS 实现；remote 仅在上传授权与 exact-origin token 同时存在时组装，redirect 禁止，loopback 不发送 token。TS 生产 export 与 Application 已删除 Python parser/rules/runtime seam，失败保留旧 current 结果。证据见 [`mineru-typescript.md`](../../../migration/evidence/runtime/mineru-typescript.md)。 |
| T042 | 迁移两阶段Analysis和内容接纳 | T017、T038、T041、T016 | 元数据/正文分析和引用提取；固定渲染与provenance；NoUsableContent路径。验收：同输入schema/hash/输出格式可比；阶段失败不撤销有效原始数据；不是直接把模型文本当current content | C02、C05、C07、S07 | **完成**：Application 自动组装纯 TS Analysis；AgentRuntime 直接执行 metadata/content schema，元数据事实与文本证据保护、固定 Markdown/引用/事实对齐、canonical hash、provenance/lineage、NoUsableContent、预算/取消/陈旧/失败保留均有离线证据。TS 生产源码已删除 Python executable/module path/bridge 开关和 subprocess 调用；历史 Python 文件最终清理由 T061 执行。证据见 [`analysis-typescript.md`](../../../migration/evidence/runtime/analysis-typescript.md)。 |
| T043 | 迁移查询、详情、引用与原子导出 | T038、T016、T014、T040 | FTS/search/detail/reference读取；metadata/pdf/content导出。验收：本地查询无网络副作用；快照一致；默认不覆盖、显式覆盖仍原子 | C03、C04、S02、S07 | **完成**：Search/Detail/References/Cited-by 均从 SQLite 一致 snapshot 读取且无 Network 依赖；四格式批量书目导出在一个 selector snapshot 上选择确定性代表版本或保持显式 Literature 顺序；metadata/PDF/content 复用 verified reader 与同目录原子 no-clobber/overwrite 发布。证据见 [`library-query-export-typescript.md`](../../../migration/evidence/runtime/library-query-export-typescript.md)。 |
| T044 | 完成旧CLI、配置中心与单次TS应用入口 | T018、T035、T039、T040、T041、T042、T043、T012 | discover/complete/literature/import/export/config；JSON与退出语义；交互与非TTY配置。验收：安装包可全TS完成旧流程；无Python RPC或后台双写；local status不会自动联网探测 | C03、C08、E03、E05 | **完成**：TS CLI 已覆盖旧流程、配置探针、存储迁移、jobs create/run；单一 Application 组装，JSON/退出码和原文件只读由直接测试覆盖。真实 Provider/站点仍按授权边界保持离线。 |
| T045 | 关闭业务全集迁移与差分清单 | T037、T038、T039、T040、T041、T042、T043、T044 | 全部module/provider/CLI映射已核对；稳定行为与intentional change分开报告。验收：每个活动文件有明确处置；不能以测试数近似证明功能完整；所有缺口有阻断或批准退役记录 | C01、C02、C03、C04、C05、C06、C07、C08、E07 | **完成**：`migration/inventory.json` 已为 242 个模块、8 个公开入口、11 个 Provider、7 个 Source、3 个授权 Provider、23 个 CLI 和 161 个测试记录 TS target/test/evidence；未授权真实外部验证单列。 |

### M5｜持久任务与受控服务

| ID | 原始任务 | 依赖 | 原始交付与验收摘要 | 原始验收 ID | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| T046 | 确定v2DDL并实现显式inspect/backup/migrate | T008、T015、T016、T038 | v2完整manifest与迁移记录；schema_identity CHECK重建；一致备份与dry-run。验收：不在查询时静默升级；v1原业务数据不变；失败点和重复执行有明确恢复 | S01、S05、S08 | **完成**：TS Worker 显式 v1/v2 identity、runtime manifest、dry-run/migrate receipt、backup/restore-check/rollback 已由 `execution-runtime.test.ts` 和 CLI 直接覆盖；证据见 [`v2-migration.md`](../../../migration/evidence/runtime/v2-migration.md)。 |
| T047 | 实现持久jobs/targets/attempts/policy与关键事件 | T046、T029、T010 | 任务冻结与幂等创建；具名运行表repositories；有界事件恢复游标。验收：不建立第二套文献可用状态；policy版本固定；不存secret/无限页面历史 | E01、S06、N07 | **完成**：jobs/targets/attempts/policy、budget、events、leases、interventions 的冻结 hash、幂等、连续序列和有界查询已有 repository 与直接测试；执行服务证据见 [`durable-execution-service.md`](../../../migration/evidence/runtime/durable-execution-service.md)。 |
| T048 | 实现可恢复队列、单workspace串行与多任务调度 | T047、T034、T044、T019 | 任务stage推进/暂停/取消；nextEligibleAt恢复；workspace绑定和后台独立任务并发。验收：同Profile不多写多控；任务跳过不停止整个队列；重启不清零已用预算形成无限重试 | E01、E02、N05、S06 | **完成（单机有界范围）**：ExecutionQueue 加 durable lease、retry/nextEligibleAt、pause/resume/cancel、workspace fencing 和 boot recovery；`ExecutionScheduler` 允许不同 workspace 在固定进程上限内并发，同 workspace 串行，重启仍以 durable recovery 为准。未扩展分布式 scheduler。 |
| T049 | 实现durable Candidate spool、ACK与对账 | T047、T023、T033、T014 | CandidateReady持久记录；交接幂等与GC保护；commit后ACK丢失恢复。验收：文件落盘先于ready；完成副本不依赖context；候选清理与资产提交均可对账 | D13、S03、S06、S07 | **完成**：Candidate spool 在文件先落盘后写 durable record，receipt commit/ACK 丢失可由 publisher reconcile 重放，GC 与正式 Asset 关系受保护；`candidate-publication.test.ts`、`candidate-recovery.test.ts` 和持久旅程覆盖。 |
| T050 | 实现策略化协助请求和控制现场恢复 | T047、T026、T029、T048 | never/notify/pause运行行为；请求截止与处置；人工断线与重新观察。验收：never模式不产生阻塞式人工依赖；租约不作为活对象持久恢复；不把故障统一交给用户 | E01、E02、B04、B07 | **完成**：InterventionService 实现 never/notify/pause、过期时间和 continue/skip/cancel；QueuePausedError 将 target 保持 queued、attempt 标记 interrupted 并把 job 置 paused；持久重开与控制 lease 直接测试通过。 |
| T051 | 实现崩溃恢复与候选/业务/任务协调 | T048、T049、T050、T046 | 新bootId、旧lease作废；current事实优先恢复；outcome-unknown与不重放动作规则。验收：已提交文件只补状态不重下；未完整transfer不误判成功；所有关键kill点结果可解释 | B07、S03、S05、S06、S07 | **完成**：新 bootId 回收旧 lease/attempt，current Literature 优先，Candidate/receipt 对账和 durable job/intervention 重开均有直接旅程；Browser DOM 仍按约定要求重新打开。 |
| T052 | 实现认证单端口API、WS和CLI/daemon协调 | T018、T047、T048、T050、T024、T044 | 版本化API；身份/Origin/CSRF/Host校验；单catalog服务发现与CLI认证转发。验收：不暴露Page/CDP/任意SQL或文件路径；网页退出不停止服务；旧游标过期能全量同步 | N03、N04、E05 | **完成**：`/api/v1/jobs/*` 与 Browser/Library 共用同一认证 HTTP 端口，Host/Origin/Cookie/CSRF、查询边界、SSE 背压、job run/pause/resume/cancel 已直接测试；CLI `jobs run` 复用同一 Application。 |
| T053 | 完成任务、策略、文献和结果工作台 | T052、T025、T043、T050 | 导入/队列/观看/接管/结果完整UI；自然语言政策提案确认；原因与处置展示。验收：同一端口无需构建工具；不把failed/unknown显示成not-entitled；既有CLI与UI同一业务接口 | E01、E02、E03、E05 | **完成**：任务工作台支持 content/PDF 目标、策略确认、持久创建、执行、暂停/继续/取消、预算/targets/events/interventions 展示和处置；Browser/Library 同端口 Playwright 测试通过。 |
| T054 | 通过持久服务端到端与升级恢复演练 | T036、T045、T046、T047、T048、T049、T050、T051、T052、T053 | 完整任务/接管/断线/重启演练；v1备份升级v2fixture；无Python完整流程报告。验收：所有成功具有已提交事实；无人工模式可结束整批；恢复不损坏既有文献和资产 | E01、E02、E03、E05、S05、S06、S08 | **完成**：`persistent-service-journey.test.ts` 覆盖 v2 建立、Literature 保留、durable job 创建、pause intervention、关闭/重开、resolve/恢复/最终状态；Workbench HTTP 和 CLI run 作为同一旅程入口。真实站点仍未授权。 |

### M6｜打包、切换与 Python 退役

| ID | 原始任务 | 依赖 | 原始交付与验收摘要 | 原始验收 ID | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| T055 | 完成TS Quick/Full与CI替代验收链 | T045、T054 | lint/format/types/unit/contracts/browser/data/build/install检查；非零测试与包内容检查。验收：不以弱化旧安全和行为测试换绿色；真实站点不进默认CI；全部输出能追溯到版本和fixture | E07、C01 | **完成**：TS Quick/Full、CI、portable package/doctor 和安装后 CLI smoke 均通过；全量产品覆盖继续以最新 Full 日志为准。 |
| T056 | 演练数据备份、迁移、恢复与Profile分离回滚 | T046、T051、T054 | 同平台副本升级/恢复演练；v2新数据增量保留方案；Profile备份/版本边界。验收：不复制活动WAL主文件冒充备份；不覆盖唯一数据副本；明确不能自动无损降级的边界 | S05、S08、E08 | **完成**：合成 v1 Catalog 的 backup、restore-check、dry-run、v2 migrate 和 rollback 已通过 `execution-runtime.test.ts`；真实用户副本仍需授权。 |
| T057 | 制作支持平台的免开发工具安装包 | T009、T003、T004、T005、T054 | Node/server/web/native资源打包；浏览器校验与缓存；系统依赖doctor/受支持准备流程。验收：用户不需Python/Node编译工具/Rust/VNC；浏览器显示依赖如实说明；许可与平台矩阵一致 | E04、E08、B08 | **完成**：portable package 携带 bundled Node、server/contracts、Web assets、runtime manifest 和可选 operator Cloak bundle；`portable-package.test.ts` 检查无 Python/secret/用户数据并执行 doctor/config smoke。 |
| T058 | 完成性能、背压与安全专项验证 | T054、T055 | 事件循环/帧/DB/内存/传输统计；SSRF/控制面/prompt注入/secret专项报告。验收：用户输入不被大PDF/长SQL阻塞；队列与资源有界；未达到指标先解释和修复，不宣称提升 | B02、N01、N02、N03、N04、N06、N07、S02 | **完成**：HTTP body/response、selector/target、队列重试、SSE 慢客户端、SSRF/Origin/CSRF、凭据脱敏和封闭 Browser action 均有离线边界测试与专项报告。 |
| T059 | 执行获授权真实站点的单变量对照或记录未执行 | T036、T054、T058 | 若获授权：固定目标/环境/分母的人工与Agent对照；若未授权：明确not-run与不可声明的结论。验收：绝不自动访问真实站点或凭据；不把失败移出分母；未执行时不能声称真实成功率验收通过 | E06、N05 | 未授权/未运行：不访问真实站点或凭据；待授权后单列验证。 |
| T060 | 同步全部真相源、配置示例与用户迁移文档 | T055、T056、T057、T053 | 当前实现/目标设计区分；新命令与配置说明；弃用Python API和无VNC部署说明。验收：不再含已撤销rules配置；全部命令用安装包实际验证；计划不冒充Accepted ADR | C08、E05、E07 | **完成**：README、HARNESS、架构/技术、TypeScript foundation、配置、安装、升级、切换与证据索引已同步当前 TS 行为和 Python 历史边界。 |
| T061 | 逐项清理Python生产入口与过渡代码 | T055、T056、T060、T045 | 每活动文件退役记录；Python依赖/脚本/旧对象图清除；历史材料明确不参与运行。验收：不通过Python子进程兜底；不删尚无替代的有效测试；不修改用户数据或无关工作树 | E07、C06 | 完成生产退役：`migration/retirement-report.json` 为 242 个 Python 模块、161 个 Python 测试及 Harness/manifest 建立逐项历史处置；移除 Python `sciretriever` CLI entry，TS Application/portable 包无 Python fallback。历史源码和无 TS 替代测试保留为显式非运行材料。 |
| T062 | 在干净支持环境做安装后全流程回归 | T057、T058、T061 | 无开发环境安装记录；导入到导出的完整流程；SSH与本地单端口测试。验收：未安装Python/编译器仍能完成支持流程；安装包不含secret或用户数据；动态资源与native路径可用 | E03、E04、E05、E08 | **完成**：portable package 在独立临时 home 无 Python/编译器运行 doctor、config status、metadata import/search/export smoke；完整 Browser/真实 Provider 流程按授权边界不运行。 |
| T063 | 形成切换/回退操作手册并在副本演练 | T056、T062、T060 | 停止旧进程/关闭Profile/备份/迁移/启动/核验顺序；失败恢复分支。验收：维护锁只允许一个写入者；恢复不覆盖新增关系；真实数据操作留给明确授权的发布流程 | S08、E08 | **完成**：已形成合成副本切换/回退顺序和失败分支手册，覆盖停止 writer、关闭 Profile、备份、显式迁移、启动核验及不覆盖副本；真实数据操作需单独授权。 |
| T064 | 完成发布就绪审查并交付全TS版本 | T055、T056、T057、T058、T059、T060、T061、T062、T063 | 功能/数据/安全/平台证据总表；已知限制和外部验证状态；最终包与校验manifest。验收：无未归属活动功能或隐藏Python后门；明确已验证与未验证网站效果；仅经授权发布/切换，不将计划自动当授权 | E03、E04、E06、E07、E08 | **完成工程审查**：[`release-readiness-manifest.json`](../../migration/evidence/final/release-readiness-manifest.json) 汇总 TS Quick/Full、119 个测试文件/466 个通过用例、模块清单、Python 退役、平台边界和未授权外部验证；结论仍为 `not-ready-for-production-cutover`，真实发布/切换需单独授权。 |

## 执行规则

1. 每项任务先冻结输入/输出和直接测试，再实现 TypeScript，运行离线 golden 差分、负例和 loopback fixture，最后组装到唯一 Application 入口。
2. 稳定领域语义按字节、哈希、ID、排序、错误和持久化结果对照；确需修复旧错误时写入 intentional-change ledger，不修改旧数据来迁就新实现。
3. M4 逐项关闭 `migration/inventory.json` 中的 242 个当前活动模块（原始 235 个 + 7 个迁移 bridge）、8 个公开 `api.py`、11 个 Metadata Provider、7 个 Acquisition source、3 个授权 provider、23 个 CLI 命令和 161 个测试文件映射。
4. M5 只在原始计划要求的后台/恢复承诺下实现最小 jobs、attempts、events、queue、lease 和单端口 API；不扩展多租户、分布式部署或云服务。
5. M6 才执行生产切换、用户数据迁移、Python 入口清理和最终发布。未完成的前置任务不得用首阶段 Browser 证据替代。

## 验收入口

代码修改默认使用 `pnpm install --frozen-lockfile`、相关 Vitest、`pnpm quick` 和 `pnpm full`；Python Quick、Python Full 和全量 unittest 仅在用户明确要求时运行。配置迁移期 bridge 在 TS 测试中只使用锁定 Python 运行依赖和合成 fixture，不改变最终 TS-only 目标；MinerU/Parsing 和 Analysis 的 TS 生产与测试路径已分别在 T041、T042 移除 Python bridge。

首阶段证据保留在 `migration/evidence/browser-acquisition/` 和 `migration/evidence/runtime/`；后续证据继续按任务引用放入现有 `migration/evidence/`，不强制为每个任务或阶段新建文件。T064 只汇总真实产物和验收结果。
