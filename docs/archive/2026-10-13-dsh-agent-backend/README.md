# DSH Agent 后端接入计划

上级：[历史归档](../README.md)。状态：**Completed**。日期：2026-10-13。决策 Owner：项目 Owner；计划与集成负责人：当前 Primary agent。

本目录把“采用 DeepSeek Harness（DSH）、放弃 Pi Agents 作为接入路线”的决定组织成可执行计划。Owner 于 2026-10-13 明确批准按本方案执行。运行时、模型协议、Browser 生产接线、离线验收及两轮冻结 50 篇真实对照均已完成；结果和限制见下方交接记录。计划完成不代表所有出版社可访问，也不证明后端提高了下载率或速度。

## 目标、依据与审批内容

首个可交付结果是：工作流通过 SciRetriever 的中性 Agent 能力边界调用 Browser 获取 PDF；DSH 负责通用会话、模型—工具循环和上下文压缩，Browser 继续拥有文章执行、页面与工具意义，Acquisition/Entry 继续证明并提交文件结果。每篇文章的连续尝试、工具结果、人工指导与下载恢复保留在同一会话上下文中。

已确定的选型见 [ADR 0031](../../architecture/decisions/0031-dsh-backed-agent-capabilities.md)。具体方案见 [DSH 接入提案](proposal.md)；此前源码调查见 [已归档的候选比较第 12 节](../2026-10-13-agent-runtime-options/proposal.md#12-deepseek-harness-与-pi-后端比较2026-10-13)。调查基于 DSH 提交 `d743267388641bc76f17c45ce8b4c231aed1d32c`、版本 `0.2.1-alpha.2`；实施已经安装并验证对应发布组件，实际依赖以锁文件和[外部依赖说明](../../notes/deepseek-harness.md)为准。

首版采用一个应用级共享 Cordis runtime、独立的文章 Agent/session scope 和短寿命内存历史；下载挂起、人工介入、重新领取 worker 后恢复同一篇的会话。跨篇连续对话、会话跨进程持久恢复均留待后续评估，本次不开发第二条路线。这些具体接法与依赖范围已随提案一起获批。

适用真相源：

- [HARNESS](../../../HARNESS.md)、[AGENTS](../../../AGENTS.md) 约束授权、工作树、数据、验证与交付。
- [requirements](../../architecture/requirements.md)、[design](../../architecture/design.md)、[technical](../../architecture/technical.md) 定义产品与模块责任；[技术 Browser 合同](../../architecture/technical/08-browser-control.md) 提供当前控制和传输入口。
- [ADR 0017](../../architecture/decisions/0017-shared-agents-and-controlled-browser-agent.md)、[ADR 0019](../../architecture/decisions/0019-agent-operable-application-and-sdk-model-runtime.md)、[ADR 0023](../../architecture/decisions/0023-generic-browser-agent-executor.md) 中适用条款由 ADR 0031 修订；仍有效的工具、安全和业务责任继续遵守。
- [ADR 0026](../../architecture/decisions/0026-agent-knowledge-and-human-collaboration.md)、[ADR 0027](../../architecture/decisions/0027-extraction-capabilities-and-caller-defined-records.md)、[ADR 0029](../../architecture/decisions/0029-unverified-pdf-acquisition.md)、[ADR 0030](../../architecture/decisions/0030-browser-transport-and-progress.md) 约束有限处理、提取含义、文件接纳、会话与下载交接。

## 授权范围

| 动作                                                                   | 当前状态与进入条件                                                                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 编写与审阅 ADR、提案、计划                                             | 本轮已授权；只做文档检查。                                                                                                          |
| 安装 DSH、修改锁文件、实现代码、离线运行验证                           | 已获 Owner 批准；按已授权范围连续推进，不逐 Task 重复询问。                                                                         |
| 真实模型、Provider、Browser 历史样本和 50 篇对照                       | 小批历史样本到冻结 50 篇的正式 Browser 对照已获批准；沿用会话已授权的模型、Profile 与测试条件，仅实际目标或请求范围超出授权时补充。 |
| 修改受支持公共合同、配置、catalog 或用户资产格式                       | 本计划以兼容为约束；若实施发现确需破坏，先明确变更与迁移方案并获得对应授权，不能凭选型决定推导许可。                                |
| Git commit、push、PR、发布、生产切换、用户数据迁移、系统或个人配置修改 | 本计划未授权；实现代码和本机验证也不自动授予这些动作。                                                                              |

当前工作树有大量既有修改。实施开始时记录 HEAD、目标文件初始 diff 和归属；本计划不是回滚、覆盖、整理或提交无关修改的依据。真实报告、PDF、截图、对话与运行日志只进入 Git 忽略的 `sandbox/`；合成自动化材料与临时 home 使用系统临时目录 `sciretriever-*`。

## 范围与共同不变量

1. `agents/dsh/` 是私有 vendor 边界；SciRetriever 中性能力/session 输入、输出、取消与请求归属留在 Agents。Browser、Analysis、Entry、Workbench 不接触 Cordis/DSH 类型，不把整个应用改造成 Cordis 插件。
2. 首切片替换 Browser 自有的逐次重建模型输入与通用循环责任；软件仍拥有文章 session、page/document generation、observation revision、control epoch、准入和实际动作执行。模型自由文本、Agent idle 或 Stop 均不能作为 PDF 发布成功证据。
3. 完整历史应能对应每个模型工具调用及其实际结果，包括未执行、拒绝、失败、取消、人工介入与 transfer 恢复。模型可见投影允许压缩和裁剪旧截图，但不能把丢弃记录、无效附件或新建空会话称为连续历史。
4. 首版保留会话寿命内的原始事件与可读取图片引用；摘要只改变模型投影。会话关闭释放内存与附件。进程重启按既有任务/资产恢复规则处理，不承诺 DSH 对话或 Browser 页面跨进程恢复，不把框架日志写成文献事实。
5. 模型与 reasoning 继续从 Configuration 解析。当前用户选择 `qiuzk/gpt-6-luna`、`max` 是兼容验证目标，不能硬编码为 DSH 默认模型。Analysis 的有限单次结构化处理保持无状态入口，复用现有模型、凭据和 Network，不强制进入自治工具循环。
6. 普通推理、压缩及任何实际发生的模型请求全部经过现有 Network 与逐请求凭据解析，归属到正确文章/operation；队列等待不算派发。首版不额外叠加默认重试、模型代理、遥测、home/settings 发现、CLI、ACP、MCP 或通用 shell/browser 插件。
7. 保留默认 300 秒累计活跃时间、30 次真实模型派发和至少 5 秒动作至下一决策间隔；动作只统计。压缩占用同一文章的实际请求预算。worker、平台/模型排队、人工持有与后台下载的计时依旧由原 owner 决定，恢复不清零。
8. 保留两个决策 worker（仍受有效会话 cap 与共享模型预算限制）、按平台串行与真实网络停止后 30 秒冷却。A 后台下载让出 worker，B 可推进；A 失败按原身份、历史与剩余预算恢复。DSH scope 不成为第二个文章状态机或调度器。
9. `concludeTurn()` 仅是循环交接接点。每轮最多一个有副作用的 Browser 动作、工具执行前的资格/revision/epoch/预算检查及同批后续工具拒绝需要实际测试，不能假定 conclude 自动撤销其它工具。
10. 原候选接纳、不可变发布、hash、provenance、lineage、凭据、Network 与单事实 owner 边界保持。未来数据/图片提取只复用这一执行基础；本次不实现领域 schema、提取算法或候选持久化新合同。

## 结果块与依赖

| 结果块                                                    | 独立可交接的输出                                                                                      | 依赖                                                  | 状态      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------- |
| [01 运行时与模型传输](01-runtime-and-model-transport.md)  | 真实最小 DSH 循环、中性会话边界、完整模型消息/工具结果适配、逐请求 Network 归属；旧 Analysis 合同回归 | Owner 已批准；1.1 固定版本与基线                      | Completed |
| [02 Browser 会话与工具](02-browser-session-and-tools.md)  | 一篇文章跨观察、动作、人工与恢复的完整历史；真实工具执行 guard、节奏与图片生命周期                    | 1.3 中性合同稳定后可准备；生产运行依赖 1.4–1.7        | Completed |
| [03 生产交接与控制](03-production-handoff-and-control.md) | DSH 接入现有 Entry/Browser/Workbench/Acquisition 对象图，后台下载、人工取消与兄弟并行正确             | 2.2–2.5 的工具、历史和交接合同；1.5 的计量            | Completed |
| [04 验收与旧循环退役](04-verification-and-retirement.md)  | 合成生产旅程、资源与兼容验收、获授权的真实对照、旧循环删除与最终 Full/文档交付                        | 03 生产接线稳定；4.3 冻结已授权范围内的现场输入与条件 | Completed |

默认先闭合 01，再完成 02 和 03 的生产切片，最后收口 04。可以在 1.3 合同稳定后并行准备合成 fixture、测试与文档影响分析；没有真实 runtime、工具执行与对象图证据时不勾选对应能力。Primary owner 负责跨块整合，委派者只修改事先明确的文件范围。

## 主要风险与负责位置

| 风险                                                                 | 负责 Task / 判定依据                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| developer preview 包版本、peer 依赖或插件生命周期不匹配              | 1.1、1.2、1.7：实际安装版本、Node 22.19.0 与原插件循环验证；不拿源码测试替代发布包验证。 |
| 单次 `AgentResult` 不能表达多工具与完整结果，误伤已公开 Analysis API | 1.3、1.4、1.6：私有完整模型协议与公开兼容入口分开审阅，三个现有 wire 的双向 fixture。    |
| 压缩绕过 Browser 预算，或一个 turn 多请求仍按一次计数                | 1.5、2.4、3.4：Network 实际派发、用途、会话与累计预算逐项核对。                          |
| DSH 自动推进抢占 worker、人工接管后旧工具仍执行                      | 2.3–2.5、3.2：真实 DSH 同批工具、迟到模型、worker 交接及 A/B 隔离失败注入。              |
| 旧截图增长、压缩丢关键路线或图片引用失效                             | 2.2、2.6、4.2：原历史与模型投影分离，附件读取/释放与压缩恢复断言。                       |
| runtime 关闭、transfer 重复事件破坏已交付文件                        | 3.1、3.3、3.5：独立取消域、候选 lease 与真实 writer 结束证据。                           |
| 真实耗时/成功率受网络、Profile、队列和模型随机性影响                 | 4.3–4.5：冻结输入、分阶段对照、逐篇结果与限制说明；不预设 DSH 更快或保证跨出版社成功率。 |

## 验证口径与完成标准

所有代码检查使用现有 `pnpm exec vitest run <文件>`、`pnpm quick`、`pnpm full`。各块列出现有测试路径和拟新增测试；拟新增路径只在创建后成为可执行入口。自动化必须使用真实 DSH 插件循环，fake 只放在外部模型传输/页面或 loopback 服务，不能 mock 掉本次要证明的 Agent/session/工具组合。

计划完成需形成四类闭环：完整历史与真实 Network 计量；Browser 控制与后台下载的生产交接；原公开 Analysis/配置/持久化行为兼容；最终集成状态下的定向测试、Quick/Full、语义 diff 和文档同步。本次批准范围同时包含按 4.3–4.5 执行小批历史样本与冻结 50 篇的正式 Browser 对照，现场证据单独记录，不预设第二次审批。只有实际操作超出明确授权且该新增范围尚未获准时，才保留受影响 Task 为 Pending 并说明缺口；未完成现场验证不能把整计划标为 Completed。

通过 Full 不能推导真实出版社成功率、缓存节省或普遍提速。约 90% 是既有待检验目标；正常无权限、网站挑战、模型未找到路径和预算耗尽应如实报告，不以全部成功为实施退出条件，也不以提高预算、替换失败文章或混合重跑日志凑出通过率。

## 当前证据、恢复点与下一步

- 实施前基线：公开 `AgentMessage` 没有 tool-result 角色，`AgentResult` 只允许一个工具；Browser 每轮重新构造输入，一个 decision 只计一次派发。现已保留公开单次合同，新增内部完整模型协议与 DSH capability 会话，生产 Browser 使用连续历史和逐次真实请求计量；实现与验证见 01–03。
- 实施基线：HEAD `8da61986c88f18046484c53256a4cd08b6ec968f`；工作树包含既有未提交修改，原源码与 hash 已保存到 `sandbox/runs/dsh-agent-backend-baseline-2026-10-13/`。完整起始副本同时位于本机 `/tmp/sciretriever-dsh-implementation-ii5X9i/`。
- 起始直接检查：`agent-wire`、`agent-network-transport`、`browser-article-flow`、`browser-decision` 共 4 文件、143 测试通过。
- 已安装精确版本 Cordis `4.0.5-alpha.1` 和所需 DSH 组件 `0.2.1-alpha.2`；01–04 已完成。冻结代码的最终 Full 通过：234 文件、1768 项测试，Quick/build 成功，退出码 0。
- 两轮固定 50 篇均自主执行到结束，无未开始、中断或跳过。baseline 主文档成功 34/50、批次 1209.851 秒；DSH 主文档成功 29/50、批次 2461.542 秒。所有 63 份正式发布文件均通过文件回读及人工主文档核对。小批 7 份同样已审核，原始轮次未被重写或拼接。
- DSH 额外失败为 5 篇 ACS 持续挑战页后耗尽 300 秒活跃预算；两轮入口页面状态不同，不能从一次顺序对照推断框架因果。RSC 有 1 篇仅记录为 flow-failed，底层原因未定位；其余登录/购买/限流结果按本次证据说明，未推断永久版权。真实运行未触发压缩；缓存与费用节省未验证。
- 本机完整报告为 `sandbox/reports/dsh-agent-backend-validation-2026-10-13.md`，逐篇流程、失败审查、文件审核和冻结清单位于 `sandbox/runs/dsh-agent-backend-2026-10-13/`。实现、配置和存储格式兼容；没有 Git 写操作、发布或用户数据迁移。
- 恢复时先读本页、当前结果块、HARNESS 和会话授权，核对 HEAD/目标 diff/未完成 Task。检查使用的模型与 Browser 配置只通过正式 owner 的非秘密投影；不读取个人文件或凭据来补足上下文。

## 变更与交接记录

2026-10-13：创建计划后获 Owner 明确批准，开始实施；保留起始工作树，143 项基线测试通过，安装锁定版本组件。后续结果逐块记录。执行后每块记录实际 revision/patch、命令、结果、脱敏证据位置及残余风险，根 README 只维护汇合状态。

若 Owner 调整首版会话或模型协议方案，先同步提案与受影响 Task/依赖，再实施；若取消计划，记录 Cancelled 及已验证材料，不清理无关工作树、用户资料或有效资产。选型被替代时由新的 ADR/提案说明，不在本计划中静默恢复 Pi 路线。

[实施提案](proposal.md) · [ADR 0031](../../architecture/decisions/0031-dsh-backed-agent-capabilities.md) · [上级归档目录](../README.md)
