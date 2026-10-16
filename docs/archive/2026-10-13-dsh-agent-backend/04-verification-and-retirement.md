# 04 集成验收、真实对照与旧循环退役

状态：Completed。上级：[计划控制面](README.md)。小批、冻结 50 篇两轮真实对照、文件审核、最终 Full 和交付审查均已完成；实测限制如实保留。

## Outcome

最终生产路径通过真实 DSH 插件、现有 Network/Browser/Acquisition 与合成 PDF 的离线集成验收；在计划获批且既有真实测试授权覆盖的范围内，完成小批历史样本与同一 50 篇的正式 Browser 对照并如实报告。旧的自有通用模型循环和历史重建路径已经删除或收束到确有必要的软件控制责任，公开文档准确区分已交付能力与未实现范围，最终集成 diff 通过 Full。

## 进入条件

- 01–03 的退出证据可复核，生产对象图、逐请求计量、工具执行 guard、下载/人工恢复可运行。
- 1.1 已在实现前记录原实现基线；当前集成版本可构建并可标识精确 source/patch。不得把不同工程重跑拼成同一个“基线轮次”。
- Owner 批准本提案/计划后，沿用本会话已明确的真实测试授权。4.3 只核对目标、模型、Profile、隔离目录与花费/请求范围是否在授权内；已有授权不重复询问，确有超出才在产生该外部请求前补足。

## 责任边界

Primary owner 对源码、依赖、测试、对象图、文档和报告整体验收负责。自动化使用系统临时合成 home/库，外部网络为 fake/loopback；真实用例、运行材料与报告进入 Git 忽略的 `sandbox/cases/`、`sandbox/runs/`、`sandbox/reports/`。真实测试通过正式 Configuration/Credential owner 调用，不读取或复制个人凭据文件，不修改生产 catalog、用户配置、DNS 或 Profile 设置。

真实 PDF 成功由文件检查、publication、正式重读/hash 和必要的主文档人工检查证明；对话文字、已点击下载、transfer completed 或单独“有效 PDF”都不足以证明完成目标。文章内容身份继续遵守既有 unverified 合同，不新增 DOI/标题硬匹配门槛。

## Tasks

- [x] **4.1 运行最终能力与生产矩阵。** 依赖 01–03，在真实 DSH runtime/session/tool/compaction 上组织集成矩阵，外部模型用脚本化 fake/loopback。至少覆盖：多轮工具结果与图像；压缩前后历史；A/B 独立取消；同批多工具；人工指导/接管/交还；下载开始让出 worker、失败恢复；candidate 与模型错误竞态；计时/30 次派发末次反馈；平台 30 秒冷却；shutdown 与 writer；当前 Analysis 单次处理。输出精确 patch、命令、文件/用例数和失败处理记录；验收为正式对象图和外部边界均被覆盖，不能用 mock DSH、直接 fake candidate 或测试专用调度器取代生产路径。
- [x] **4.2 验证长历史、图片与资源释放。** 依赖 2.6、3.5，构建合成的多文章连续创建/关闭、单篇多轮与强制压缩场景，记录保留 session/event/attachment、待结束工具和 listener 数，以及进程内存的运行趋势。验证旧截图退出模型投影后其生命周期仍可解释，当前引用可读、关闭后不可访问；压缩失败、scope 初始化失败与用户取消也能释放。输出可复跑的合成测试与资源结果；验收为业务 cap 生效、已关闭 scope 无持续持有资源，未因跨篇共享历史泄漏或无限截图再发送导致增长。内存/速度先记录实际证据，不新增无依据的 CI 固定性能阈值，也不承诺框架自动降低资源占用。
- [x] **4.3 冻结真实样本、基线与执行方法。** 依赖 3.7、4.1，核对会话既有真实测试授权与 1.1 基线；在 `sandbox/cases/dsh-agent-backend/` 复用或建立正式 Browser 入口的对照 runner、README 与非秘密 manifest，在 `sandbox/runs/` 创建独立运行目录。优先沿用 2026-10-13 Browser throughput 的固定 50 篇，冻结稳定文献 ID/元数据 snapshot hash、目标顺序与来源，不替换失败文章；从已有真实历史中选择 4.4 小批，并说明取样理由。基线与 DSH 使用隔离无 PDF 库、相同输入、模型/reasoning、工具、预算、worker/platform 配置、Browser bundle 与可比初始 Profile 条件，逐轮运行且不中途改代码；记录模型有效身份、源码/构建 hash、启动命令和起止时间。检查 Browser runtime/bundle 可用、正式路径确实进入 Browser，不混入已有 PDF 命中或其它层成功；五层全任务结果若同时记录，单列 Browser 分母。输出可核验 manifest、runner 的实际命令与 dry-run 结果；验收为缺必需条件时在任何真实请求前退出，所有数据与凭据访问落在已授权范围。历史累计 36 分钟或修复中多轮日志不能作为干净基线。
- [x] **4.4 先完成小批历史样本对照。** 依赖 4.3，从冻结样本或已有被授权历史里选择约 6–10 篇，覆盖已人工确认的主文档成功、需要多步/返回的路线、ACS 等复杂页面/预览背景、Bentham 等反复失败、Thieme 等停止判断，以及至少一个明显不可达/权限受限样本；具体目标在运行前写入 manifest。若“历史成功需较多调用”无法按文章归因，标为待核实，不把批次 25/27 次模型事件写成单篇事实。每篇比较完整 action/tool result history、普通/压缩请求、文件结果、过早停止/重复路线和人工可解释性；同时检查下载挂起恢复与控制版本，真实站点未触发的竞态沿用 4.1 证据。输出逐篇结果与问题分类；退出为本地接线/安全/归属/资源缺陷已修复并完成相关回归，真实限制清楚，运行方法可用于 50 篇。没有观察到所有文章成功不阻断后续测量，不能临时加预算或换样本提高分数。
- [x] **4.5 完成冻结 50 篇的正式 Browser 对照。** 依赖 4.4、4.6 的旧循环清理及受影响直接回归；使用 4.3 固定的输入和基线，并为清理后的 DSH 构建补记准确 hash，各完成一次完整轮次。顺序、Profile 使用和两轮环境差异显式记录，避免并跑导致同平台/账号/网络相互干扰。每篇记录正式获取状态、主 PDF/补充材料/未完成分类、文件 hash/大小/可读性、publication/重开证据、墙钟/活跃/等待/transfer/接收检查/发布耗时、普通与压缩请求数、token 与可取得的缓存/费用信息、停止原因与重复路线。保留全体失败与原始轮次，定点修复重跑另列，不拼接为一次通过率。输出 `sandbox/reports/dsh-agent-backend-validation-<日期>.md` 和关联运行目录；验收为 50 篇分母与逐篇归属完整，差异有证据或明确限制，不能声称 100% 跨出版社成功、所有缓存已命中、普遍提速或达到未测得的 90% 目标。若 DSH 暴露本地正确性/安全缺陷，回到责任 Task 修复后重新记录适用验证；不以现场失败反推永久无权限或全渠道耗尽。
- [x] **4.6 删除被替代的通用循环并核对调用方。** 依赖 3.7、4.1 的生产证据及 4.4 的现场接线确认，逐项检查 `browser/decision.ts`、`article-flow.ts`、`workbench/production-session.ts` 和 `bootstrap/application.ts` 的旧调用关系：删除无消费者的逐次 messages 重建、单工具模型桥、自有通用 history/compaction/循环代码与测试 seam；保留 Browser 的文章/页面状态、准入、控制版本、计时和下载业务控制。旧 Analysis 单次入口和有效模型 wire 校验继续复用，不能为了“全部都走 DSH”删除。输出旧/新责任对照、删除/保留理由和调用方回归；验收为生产 Browser 只走获批的 DSH 后端，无隐藏 Pi 或旧 loop fallback、无双份提示词/工具定义、无为验证阶段永久保留的后端选择开关。用于历史对照的构建留在 sandbox，不进入产品代码。
- [x] **4.7 同步当前文档与维护边界。** 依赖 4.6，按 `docs/development/documentation-map.md` 更新 `agents/README.md`、新 `agents/dsh/README.md`、Browser/Bootstrap/Workbench 导航、设计/技术文档中受 ADR 0031 修订的职责、用户指南中的实际行为和开发依赖/安装说明；外部依赖事实放 notes，真实报告只给本机定位。写清完整历史/压缩的当前能力、一篇一会话与短寿命图片策略、Analysis 仍为有限单次处理、模型选择不变，以及跨进程恢复/跨篇对话/数据图片算法尚未实现。输出文档 diff、链接与术语检查；验收为旧无状态“一切由消费模块维护历史”条款按适用范围修正，ADR 记录决定而当前指南只描述已验证行为，未新增未获批准的长期架构结论。
- [x] **4.8 执行最终 Full 与整体验收。** 依赖所有影响源码/依赖/合同的修复、4.6–4.7，先跑受最后修改影响的直接测试，再运行 `pnpm full`，审查 exact diff、包内容/依赖、配置/公开 API 兼容、敏感信息与数据边界。输出当前集成 revision/patch、命令、退出码与计数、现场报告定位、已知残余风险和授权范围说明；验收为 Full 通过且每项失败/跳过原因可说明，未提交凭据、真实 PDF/截图/历史、build/dist 或无关用户改动。若 Full 后再改源码，补跑受影响检查及最终 Full；不得用历史通过记录替代最终状态。更新所有块与根控制面，满足全部退出条件才标记 Completed，不执行未经授权的 Git 写操作或发布。

## 集成与真实评价口径

本块实际执行顺序为 4.1/4.2 → 4.3 → 4.4 → 4.6 及相关回归 → 4.5 → 4.7/4.8。先由小批证明接线，再退役旧循环，最后用将交付的 DSH 构建跑冻结 50 篇；编号用于稳定引用，不要求按数字机械执行。若 50 篇后修复影响真实生产行为，先评估并明确是否需要新的完整轮次或定点复验，不把改动前结果默认为最终代码证据。

真实验证是对生产能力的现场检查，不能替代离线可重复断言。DSH 接入是否合格先看所有权、历史、控制、网络与资源正确；成功率、耗时、缓存和维护成本是实测结果。比较必须固定模型与合法工具，不能把换模型、增加权限或放宽预算的影响归功于框架。

以“正式发布并可重开、人工检查为目标主文档”统计下载效果，同时保留文件合法但补充材料、模型停止、预算耗尽、页面/网络错误等分类。已有历史报告可帮助选择样本，但报告对单篇调用数归因不完整时必须写明，不能从总次数或最近少量样本推断更小预算足够。默认预算与动作统计合同不因测试结果自行改变。

真实单篇/总耗时与成功率分开报告；独立时钟不可机械相加为墙钟。额外重跑、修复轮、模型异常与发布后清理失败均保留；若无法取得缓存 token 或费用，写“服务未返回/未验证”，不据前缀相同推定缓存收益。计划不要求为每个外部失败找到站点规则，也不要求全部出版社都可访问。

## 验证命令

以下为仓库现有入口，直接测试列表按最终修改适当补齐：

```bash
pnpm exec vitest run apps/server/test/browser-production-loopback.test.ts apps/server/test/browser-final-integration.test.ts apps/server/test/browser-large-mixed-production.test.ts apps/server/test/browser-shutdown-production.test.ts
pnpm exec vitest run apps/server/test/installed-public-journey.test.ts apps/server/test/product-loopback-journey.test.ts apps/server/test/analysis-service.test.ts apps/server/test/agent-network-transport.test.ts
pnpm full
git diff --check
```

01–03 新增的 DSH 测试随默认 Vitest 一起进入 Full，不能被 `sandbox/**` 排除或单独作为不运行的 demo。合成多轮资源测试可新增到 `dsh-runtime.test.ts` / `browser-dsh-production.test.ts`，由真实 DSH 执行。必要测试浏览器按当前离线/loopback 规则使用，若运行环境缺少它，应先恢复项目支持的测试环境，准确记录不能运行的情况。

真实 runner 已在 `sandbox/cases/dsh-agent-backend/` 实现并通过 dry-run；`run.mjs` 使用正式配置 owner、隔离库和现有生产补全入口，小批结果见下方执行记录。最终 Full 通过后由 `final-runs.mjs` 顺序运行两轮固定 50 篇；命令与参数以该本机目录 README 为准，不包含凭据或个人配置内容。沿用已授权范围执行 4.4→4.5，不因进入下一小批而自动新增确认步骤。

## 退出条件

所有 01–04 Tasks 有实现/验证证据；最终 Full 通过；真实小批与冻结 50 篇报告完成且限制如实披露；旧通用循环与隐藏 fallback 已清理，必要当前文档已同步。Primary owner 的最终审阅确认公共合同/配置/catalog/资产兼容、无真实内容与凭据混入、无无关改动被覆盖或提交。

若确因真实授权范围或环境条件缺失而不能完成相应任务，标记具体 Pending/Blocked 或 Partial、原因及下一恢复动作；可以交付已完成的离线部分，但不能把本计划标为 Completed，也不能声称真实成功率/耗时已经验收。正常网站拒绝或有限预算未完成不是代码质量门禁失败，只需按实际结果记录。

## 恢复与交接

4.1/4.2 失败按历史协议、动作、传输/取消、资源 owner 回到 01–03 对应 Task；修复后重跑受影响直接检查。4.3 preflight 失败在任何外部请求前停止；4.4/4.5 中途故障保留完整运行记录、独立库与已发布事实，下一轮使用新的 run identity，明确续跑还是新基线，不重写历史结果。

清理仅针对当前用例自身且确认 writer 结束的临时资源；不清理用户资产、旧 sandbox 报告或工作树。最终交接列出实际完成范围、依赖版本/影响、公开行为/兼容结果、真实限制、未完成事项与证据定位，并说明尚未获得的 Git/发布授权。当前进度以本块 Tasks 和下方实际执行记录为准，未完成的最终 Full 与 50 篇对照不能用小批结果代替。

[上一结果块](03-production-handoff-and-control.md) · [计划控制面](README.md) · [上级计划目录](../../plans/README.md)

## 2026-10-13 执行记录

以下记录保留各轮执行时的状态与失败，最终结论以末尾收口记录为准。

- 资源观察：真实 DSH 下 20 篇连续创建/关闭，每篇 30 轮，共 600 次工具循环；无外部请求，关闭后 history 拒绝、同一身份可重新创建。GC 后 heapUsed 首末约 12.89/13.62 MB，范围 12.39–13.62 MB；仅记录趋势，不以固定内存阈值作为门禁。原始压缩/附件生命周期另有直接测试。
- 冻结 50 篇原样本 hash `e9a12a3470a0d8ff43dc26acd3cfecfb87cefdc27c90e9bc28cab9d87bce9e3e`；冻结来源 observations hash `2b0eb9b935cf586c1f9d508eafb25933fa1ca750012fae35b0bcd6092c913b02`。本机 runner 位于 `sandbox/cases/dsh-agent-backend/`，dry-run 已验证无外部请求。
- 小批固定编号 2/13/21/27/29/33/39/48；旧实现 4/8 入库、465.950 秒，DSH 3/8 入库、353.161 秒。模型调用51/36、输入token300377/512756；真实缓存计数当前适配器未暴露，未验证缓存节省。小批期间有离线回归并行，仅用于接线与路径核查，不作为严格速度因果证明。
- 首轮 Full 在末尾修复尚有并行编辑时启动，234 文件/1768 项中 10 项失败；9 项涉及新测试与旧 transform 混用，冻结新进程相关回归已通过，另1项旧手机导航测试已按当前公开界面改正并通过。原轮次日志保留；重新在冻结树执行完整 Full，不能将首轮标为通过。
- 实施日志与现场轮次集中在 `sandbox/runs/dsh-agent-backend-2026-10-13/`。真实 50 篇和最终 Full 尚在后续执行，不宣称整计划完成。

小批审核与旧路径收束：7份已入库文件均经本机前两页标题/DOI/正文人工复核；旧4份、新3份，没有补充材料误入。#27 两轮均显示 Full text access，旧路线进入 PDF 域验证并下载，新路线停在原文章页后主动 no-viable-path；不是预算耗尽，不能判定永久无权限，现有证据不足以确定站点弹窗/时序的因果。没有据单例加出版社规则。当前生产源码仅 `src/index.ts` 继续公开导出 `createBrowserDecision`，无生产调用方；兼容入口和显式低层 scripted seam 因已支持合同保留，生产路径没有旧决策 fallback。通用提示词/动作 schema 单份共享。

Agents/Browser/Bootstrap/Workbench README、设计与技术文档、用户指南、DSH 外部依赖说明及离线安装文档已同步；相应文档本地链接检查通过。首版一篇一会话、原图片内存保留、仅最新图片投影和关闭释放已写明；Analysis 单次入口不变，不宣称跨进程会话恢复或缓存节省。最终完成仍需 4.1/4.5/4.8 的冻结 Full 与50篇结果。

冻结轮补证：第二次 Full 的 DSH/模型/Browser 全过，234 文件/1768 项中3项既有 Analysis/Synthesis 集成测试默认5秒超时。使用实施前完整源码与当前源码、同一单worker和临时30秒测量上限对照，两个综合在基线即为5279/5076ms，当前4266/5090ms；12证据引用为4498/4761ms。没有观察到整体 DSH 退化。仅这3个有限集成用例显式设置15秒（同文件既有惯例），未改产品预算或断言；正常测试入口3项通过。比较证据位于 `verification/analysis-timing-comparison.json`。最终以2个Vitest worker重新完整执行 `pnpm full`，日志 `verification/full-final.log`。

第三轮 Full 已结束：233/234 文件、1767/1768 项通过，唯一失败为新增 DSH 生产测试在人工接管后的动作请求收到 HTTP 409。诊断确认 `stale-command`：请求 observation revision 为 2，人工侧刷新后为 1，其余页面/文档/视口/控制版本一致。接管只返回控制绑定，测试改为通过公开会话选择接口等待人工侧刷新，再构造唯一动作；未修改生产 guard 或增加动作重试。修正后真实 Cloak 单文件及三文件组合两轮通过（1 项、38 项）。第三轮日志与退出码 1 原样保留；重新冻结后的第四轮 Full 使用 `verification/full-final-rerun.log` 与对应退出文件，真实 50 篇仍等待完整 Full 通过。

第四轮冻结 Full 已通过：`pnpm full`，Vitest 3 worker，234 文件/1768 项全部通过，Quick 与 build 成功，退出码 0；Vitest 耗时 853.83 秒。日志为 `verification/full-final-rerun.log`，最终实现清单为 `verification/implementation-final-synchronized-files.json`。固定 50 篇 baseline → DSH 顺序对照现已启动，未完成现场结果与 PDF 审核前仍保持 4.5/4.8 待完成。

## 最终收口

- 固定小批与正式 50 篇均已完成；两轮正式任务各 50 项唯一终态，未开始/中断/跳过均为 0，子进程与调度脚本退出码均为 0。baseline 发布并人工确认 34 篇，DSH 29 篇；全部 63 个正式轮次文件 hash/bytes/PDF 及主文档审核通过，未改变 catalog 的 unverified 身份。
- 正式批次墙钟为 1209.851 / 2461.542 秒，模型派发为 139 / 164 次，报告 input tokens 为 863933 / 1658190。DSH 少成功的 5 篇 ACS 持续处于挑战页，每篇耗尽 300 秒活跃预算；同平台串行等待随后影响其他文章的 Entry 墙钟。两轮网站状态、共享 Profile 与顺序运行不同，不能归因框架，也不能宣称缓存或费用下降。
- 共同成功的 29 篇，Entry 墙钟均值为 50.948 / 98.355 秒，活跃均值为 22.570 / 18.530 秒，配对墙钟差中位数为 −0.247 秒；各时钟不可机械相加或将墙钟等同模型推理。RSC #17 的 flow-failed 以及部分购买控件后继不一致仍缺少底层因果证据，已在失败审查中标明。真实各轮未触发压缩，压缩能力仍由合成测试证明。
- 最终 Full 的 Quick、234 文件/1768 测试和 build 全部通过；实现冻结清单与 221 路径后续 hash 核验一致，17 份相关文档的 153 个本地链接与 diff 检查通过。新增依赖已锁定并通过离线打包安装，原公开单次 Agent/Analysis、配置/catalog/资产格式兼容。
- 本机报告：`sandbox/reports/dsh-agent-backend-validation-2026-10-13.md`；运行根：`sandbox/runs/dsh-agent-backend-2026-10-13/`；每轮 `metrics.json`、`flows.md`、`post-run-review.json`、`failure-review.json` 保存逐篇证据。原失败 Full、小批、真实样本和用户既有改动均保留，没有 Git commit、push、发布、系统配置修改或用户数据迁移。
