# Autonomous Browser Session 改造计划

## 1. 身份与状态

- Run ID：`browser-autonomy-2026-09-07`
- 创建日期：2026-09-07
- Primary owner：`/root`
- 执行模式：`single-session`
- 当前状态：`Completed; field validation failed (follow-up required)`
- 基线：当前工作树中已经完成的通用 Browser Agent、CloakBrowser、PDF identity 与网络 redirect 修复；本计划不覆盖其它未归属改动。

## 2. 目标观察

完成后，用户应当看到以下行为：

1. SciRetriever 只向 Browser Agent 提供文献目标、合法起始页面和当前页面观察；不再要求 Agent 按预先规定的点击顺序完成下载。
2. Agent 可以在同一 Browser 会话中自主处理验证页、异步加载、原生跳转、弹窗、PDF 入口和失败后重试。
3. 中间的 302、暂时没有页面变化、非关键子资源失败或一次候选文件不合格，不会单独终止 Agent 会话。
4. Browser 捕获的文件先作为候选交给 Acquisition；只有 PDF 字节校验和目标文章归属校验都通过，任务才报告成功并停止。
5. Agent 的 `Stop` 只表示它不再探索，不伪装成“下载成功”；超时、取消和明确的致命 Browser 故障仍有清晰终态。

## 3. 授权与真相源

本计划依据：

- 用户已确认的“少约束 + 明确停止条件 + 终态文件校验”方向；
- [产品需求](../../architecture/requirements.md)；
- [ADR 0023：通用 Browser Agent 执行器](../../architecture/decisions/0023-generic-browser-agent-executor.md)；
- [Acquisition 技术文档](../../architecture/technical/acquisition.md)；
- [Network 技术文档](../../architecture/technical/network.md)；
- [PDF 获取指南](../../guides/pdf-acquisition.md)；
- [项目 Harness](../../../HARNESS.md)。

计划不能改变的边界：Browser 不获得任意 URL、脚本、凭据、文件系统或业务写入能力；Agent 不能自行声明 PDF 成功；Literature、Asset、provenance、不可变发布和 PDF identity 合同保持不变。

## 4. 已核实事实、假设与开放问题

### 已核实事实

- 真实 Cloudflare 页面已经被识别为 `challenge`，Agent 曾返回 `click-point`，日志记录 `dispatch=applied`，截图显示页面进入 `Verifying...`。
- 点击后仍会产生多次原生 302、资源加载和页面重建；当前 Network 在中间跳转或页面 settle 阶段可能产生 `policy`，使 Agent 拿不到下一次观察。
- 当前 `AgentRuntime` 是无状态单次 Provider 调用；Browser loop 由 Acquisition controller 与 Network `BrowserStepSession` 共同拥有；最终 PDF 验收已经属于 Acquisition。
- 工作树包含大量前序用户改动，本计划只能在现状上增量修改，不回滚、不整理无关内容。

### 设计假设

- 不需要持久化 Agent 会话、LangGraph checkpoint 或新的后台任务系统；一次文献获取仍在当前进程和当前 Browser article lease 中完成。
- 现有六种封闭动作足以表达页面探索；本轮不扩大为任意 URL、脚本、表单输入或 Page/DOM 暴露。
- Network 的底层连接、资源预算和最终 capture 证据仍可保留，只需把中间过程从“业务失败”改成“可继续观察的运行事件”。

### 开放问题

- 页面在持续跳转时，如何用现有 Browser observation 表示“尚未稳定”而不增加第二套业务状态机；优先尝试 operation-local transient condition，不新增持久状态。
- 候选 PDF 校验失败后，继续探索的反馈应采用最小的中性 observation/context，不能把解析器内部细节或原始响应泄露给 Agent。
- 真实 Provider、DNS 与机构页面的现场效果仍需按失败阶段分别复测；本轮已获得授权并完成一次现场验证，但没有形成可发布 PDF。

## 5. 范围与非目标

### 本次范围

- 降低 Browser Agent controller 对“预期页面变化”和“固定步骤结果”的依赖。
- 把导航/Challenge/异步资源的中间失败从终止信号改为可恢复观察或局部资源丢弃。
- 保留并强化终态候选 PDF 的字节、结构和文章归属验收。
- 为自主探索、候选失败后继续、超时/取消/致命故障补齐直接测试、日志和当前行为文档。

### 明确非目标

- 不引入新的 Agent 框架、持久化 workflow、跨进程 worker 或第二套状态机。
- 不恢复 Publisher-specific selector、规则目录、固定点击序列或站点专属下载器。
- 不改变配置模型、数据库 schema、Literature/Asset 身份合同、PDF 发布合同或 Provider 协议。
- 不为绕过网站权限而增加 Cookie、登录、MFA、验证码 solver、任意输入或外部下载器。

## 6. 全局验收条件

- [x] Agent 在稳定观察上获得任务后，可以连续自主探索；中间 302、Challenge 验证和短暂 navigation race 不会让会话提前退出（由离线 fixture 验证）。
- [x] fixture 流程中可观察到：Agent action 被应用 → 页面继续变化 → 新 observation 再交给 Agent；不再要求动作结果匹配站点预期。
- [x] 至少一个错误/HTML 候选会被 Acquisition 拒绝并允许继续探索；有效目标 PDF 会通过最终两道验收并进入发布路径。
- [x] Agent `Stop`、超时、取消、Browser 致命故障、最终 PDF 不合格分别产生稳定且可读的结果码。
- [x] 相关 unittest、Ruff、Quick 和 Full Harness 通过。
- [x] 目标文档、ADR/technical 变化与实现一致；本次新增/修改内容未包含凭据、真实 PDF、截图或缓存。工作树中的其它用户改动未被整理或回滚。

## 7. 分块地图

| Block | 结果 | 主要文件/模块 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| 01 | 明确 autonomous session 与终止/继续合同，并锁定回归测试 | `acquisition/browser_control.py`、`network/browser_control.py`、相关 tests | 无 | `Completed` |
| 02 | Browser/Network 对中间导航和 settle 采取可恢复处理 | `network/browser.py`、`network/playwright.py`、`network/browser_connect.py`、相关 tests | 01 | `Completed` |
| 03 | 候选捕获与最终 PDF/文章归属验收形成闭环 | `acquisition/sources/browser.py`、`acquisition/pdf_identity.py`、`acquisition/tiered_service.py`、相关 tests | 01、02 | `Completed` |
| 04 | 文档、Harness、安装/现场验证与交接 | ADR/technical/guides、tests、Harness | 01–03 | `Completed; field validation failed` |

## 8. 跨块合同

- Agent 只消费 `BrowserArticleGoal`、稳定观察、截图和六种封闭动作；不获得 URL、selector、Page、Cookie、文件或业务写入。
- Browser 只把动作执行事实、当前观察、候选 capture 和明确终态交给上层；不解释 Publisher 页面策略。
- Network 继续拥有连接、DNS、资源字节、取消和清理事实，但中间 navigation/subresource 事件不自动升级成文献失败。
- Acquisition 是候选 PDF 与目标文章身份的唯一最终验收者；capture candidate 不是成功事实。
- 所有跨模块结果保持 query-free locator、hash、provenance 和稳定失败；不把原始 URL、响应、Cookie、凭据、页面正文或异常消息写入业务模型或日志。

## 9. 影响矩阵

| 方面 | 预期变化 | 结论 |
| --- | --- | --- |
| 模块边界 | 不新增模块；明确 controller/Network/Acquisition 的过程与结果职责 | 局部行为重构 |
| 公共接口 | 优先保持现有中性 `BrowserStepSession`/`BrowserFlowSession` 形状；若需改变，只改内部 transition 语义并同步测试 | 需专项审查 |
| 配置 | 不变 | 无迁移 |
| 数据/schema | 不变；不持久化 Agent 会话 | 无数据库迁移 |
| 依赖 | 不新增 Agent/Browser SDK | 无依赖变更 |
| 文档/ADR | 需要修订 0023 与 Network/Acquisition 当前行为段落，避免继续描述逐步强判定 | 必须同步 |
| 运行对象图 | 保留现有共享 CloakBrowser process/context、AgentRuntime 和 article lease | 不重写架构 |

## 10. 大架构变更判定门

当前不需要大改架构，原因是目标可以在现有对象图内完成：AgentRuntime 仍然是单次无状态调用，Browser 仍是同一会话执行器，Acquisition 仍拥有最终验收，持久化合同不变。

只有出现以下证据，才暂停实现并重新向用户说明原因、影响和替代方案：

- 必须把 Agent 会话持久化到数据库或引入 LangGraph checkpoint 才能完成目标；
- 必须让 Agent 直接获得 Page、任意 URL、脚本、凭据或文件系统；
- 现有 `BrowserStepSession` 无法在不破坏模块边界的情况下表达继续观察，必须新增跨模块状态总线/后台 worker；
- 最终 PDF/文章归属合同或 Catalog 持久化事实必须改变。

这些情况不在当前授权范围内；未得到新的明确同意前不得实施。

## 11. 风险与转化信号

- Agent 可能无进展循环：用有限动作/时间预算和重复观察指纹收敛，不恢复站点规则。
- 页面可能持续发起资源：保留 Network 的单请求和整篇资源上限；仅把非关键中间失败降级为局部事件。
- 候选 PDF 可能是错误页或错文：始终经过字节门和文章归属门；失败候选不得发布。
- Provider 可能返回不同的工具协议：保留 payload-free protocol diagnosis；协议失败与 Browser 页面失败分开报告。
- DNS/redirect 仍可能是真实外部故障：若同一目标在重试中稳定出现不可达终态，记录为外部/权限问题，不把它解释为 Agent 成功。

⚠️ 需监控：无进展循环、资源预算和真实 Provider 协议差异是否上升为比“逐步强判定”更主要的瓶颈。

## 12. 验证与证据策略

1. 先运行 Block 01 的 controller/transition fixture，证明候选失败可继续且旧动作不会重放。
2. 运行 Block 02 的 Network/Playwright/CONNECT fixture，证明中间 redirect、异步 navigation、子资源和 settle race 不提前终止。
3. 运行 Block 03 的 acquisition/PDF identity fixture，证明错误候选拒绝、有效 PDF 发布和 provenance 不变。
4. 运行 Agents、Browser、Acquisition、Network 相关 unittest、Ruff 与 Quick。
5. 运行 Full Harness；未通过不得声称代码交付完成。
6. 只有离线闭环通过并获得现场测试授权后，使用持久 Browser Profile 做一次真实验证；计划只记录结果摘要和证据路径，不写入截图、PDF、Cookie 或响应正文。本轮已获得授权并完成单篇验证，结果记录在 Block 04；失败不被写成通过。

## 13. 授权门

- 代码和测试修改：本计划已获用户明确授权。
- 真实 Provider/Browser/机构页面访问：需在离线验证通过后由用户明确授权；不把“开始实施”自动解释为新的现场访问授权。
- Git commit/push/release：本计划不授权，仍需用户单独指示。
- 数据迁移或删除：本计划不包含，也不执行。

## 14. 执行与审查

- Primary owner 负责所有块的集成、测试、文档和最终交接；不启用并行 worker。
- 每个 Block 按“预检 → 最小切片 → 直接测试 → diff/合同审查 → 块级测试 → 交接”执行。
- R0：计划就绪后确认无大架构门阻塞；R1：进入每个 Block 前核对前置证据；R2：每个切片审查 diff/错误路径/范围；R3：块退出前核对下游合同；R4：Block 03 集成时复核对象图；R5：Full 后复核文档、真实授权和残余风险。
- 任何 finding 改变模块所有权、持久化、公开接口或全局验收时，立即回到本 README 的事实/影响矩阵并停止下游实现。

## 15. 进度与恢复

- 只有实现、直接测试、必要文档和退出条件同时成立，才能勾选 Task/Block。
- 若中途失败，从最近一个通过 Block 的退出点恢复；首先读取本 README、对应 Block 文件、当前 diff 和失败测试。
- 原始真实日志、截图、PDF 和临时目录只保留在系统临时目录，不复制进计划目录。
- 若计划方向被用户改变，先标记当前 Block/Plan 状态和原因，再创建替代计划；不在下游堆兼容分支。

## 16. 变更记录与交接

| 日期 | 变化 | 原因 |
| --- | --- | --- |
| 2026-09-07 | 创建计划；把“逐步强判定”调整为“自主会话 + 终态验收” | 真实 Challenge 点击已成功，但点击后的中间跳转被过早判为 Browser policy failure |
| 2026-09-07 | 完成一次真实 Browser/Agent 现场验证但未通过 | Browser 捕获到 PDF 候选后在 snapshot settle 阶段 runtime 失败；独立 Browser Model 探针返回 `agent-protocol`，两者需分别处理 |

完成后交接内容：实现范围、直接测试/Quick/Full 结果、现场测试授权与结果、文档/ADR 变化、未运行检查、残余风险和未提交 Git 状态。计划完成或被替代后移入 `docs/archive/`，不作为产品或架构真相源。
